import { createHash } from "node:crypto";
import type {
  AutoSkillsGateway,
  ExternalOperationApproval,
  FileSystemPort,
  InstalledArtifact,
  ProcessExecutor,
  ProcessResult,
  SkillOwnershipStore,
} from "../../domain/index.js";
import type { CatalogSnapshot, SkillCatalogEntry } from "../../domain/catalog/models.js";
import {
  AUTOSKILLS_MAX_OUTPUT_BYTES,
  AUTOSKILLS_SOURCE_REPOSITORY,
  catalogError,
  catalogSnapshotDigestInput,
  findCatalogEntry,
  registerAutoSkillsInstall,
  registerAutoSkillsList,
  upsertSkillOwnership,
  validateCatalogPayload,
  validateInstallTarget,
  validateSkillCatalogEntry,
} from "../../domain/catalog/autoskills.js";
import type { CanonicalPath, InstallationError, Result, RunId, SafeProjectPath, Sha256 } from "../../domain/shared/types.js";
import { asSafeProjectPath, err, ok } from "../../domain/shared/types.js";

export interface AutoSkillsGatewayOptions {
  readonly root: CanonicalPath;
  readonly authorizeListing?: () => boolean | Promise<boolean>;
  readonly maxOutputBytes?: number;
  /** Required for post-install file verification and partial-artifact cleanup. */
  readonly fileSystem?: FileSystemPort;
  /** Optional transactional ownership persistence, normally supplied by application composition. */
  readonly ownershipStore?: SkillOwnershipStore;
  readonly ownershipRunId?: RunId;
}

type ExpectedFileState = { readonly path: SafeProjectPath; readonly bytes?: Uint8Array };

const sha256 = (bytes: Uint8Array | string): Sha256 => createHash("sha256").update(bytes).digest("hex") as Sha256;
const manifestDigest = (entry: SkillCatalogEntry): Sha256 =>
  sha256(JSON.stringify({ componentId: entry.id, origin: entry.origin, files: entry.files }));
const outputWithinLimit = (result: ProcessResult, max: number): boolean =>
  !result.truncated && Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") <= max;
const failed = (message: string, cause?: string): Result<never, import("../../domain/shared/types.js").CatalogError> =>
  err(catalogError("CATALOG_EXECUTION_FAILED", message, cause));
const installationError = (
  code: InstallationError["code"],
  message: string,
  recoverability: InstallationError["recoverability"],
  cause?: string,
): Result<never, InstallationError> => ({
  ok: false,
  error: { code, message, recoverability, ...(cause === undefined ? {} : { cause }) },
});

/** Adapts the official midudev CLI without accepting alternate sources or shell text. */
export class MidudevAutoSkillsGateway implements AutoSkillsGateway {
  private readonly maxOutputBytes: number;
  private readonly authorizeListing: () => boolean | Promise<boolean>;
  private presentedSnapshot: CatalogSnapshot | undefined;

  public constructor(
    private readonly executor: ProcessExecutor,
    options: AutoSkillsGatewayOptions,
  ) {
    this.maxOutputBytes = options.maxOutputBytes ?? AUTOSKILLS_MAX_OUTPUT_BYTES;
    this.authorizeListing = options.authorizeListing ?? (() => false);
    this.root = options.root;
    this.fileSystem = options.fileSystem;
    this.ownershipStore = options.ownershipStore;
    this.ownershipRunId = options.ownershipRunId;
  }

  public readonly root: CanonicalPath;
  private readonly fileSystem: FileSystemPort | undefined;
  private readonly ownershipStore: SkillOwnershipStore | undefined;
  private readonly ownershipRunId: RunId | undefined;

  public async list(): Promise<Result<CatalogSnapshot, import("../../domain/shared/types.js").CatalogError>> {
    if (!(await this.authorizeListing())) return failed("autoskills listing was not authorized by the user", "authorization denied");
    const request = registerAutoSkillsList(this.root, true);
    if (!request.ok) return request;
    let result: ProcessResult;
    try {
      result = await this.executor.execute(request.value);
    } catch (error) {
      return failed("Unable to execute npx autoskills", error instanceof Error ? error.message : String(error));
    }
    if (!outputWithinLimit(result, this.maxOutputBytes) || result.timedOut || result.exitCode !== 0)
      return failed(
        "npx autoskills did not return a bounded successful catalog",
        result.timedOut ? "process timed out" : result.stderr.slice(0, 512),
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch (error) {
      return err(
        catalogError(
          "CATALOG_INVALID_RESPONSE",
          "autoskills returned invalid JSON",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    const validated = validateCatalogPayload(parsed);
    if (!validated.ok) return validated;
    const digest = sha256(catalogSnapshotDigestInput(validated.value));
    const snapshot: CatalogSnapshot = { ...validated.value, manifestDigest: digest };
    this.presentedSnapshot = snapshot;
    return ok(snapshot);
  }

  public async install(
    entry: SkillCatalogEntry,
    approval: ExternalOperationApproval,
    target: SafeProjectPath,
    presentedSnapshot?: CatalogSnapshot,
  ): Promise<Result<InstalledArtifact, InstallationError>> {
    if (
      !validateSkillCatalogEntry(entry) ||
      entry.origin.repository !== AUTOSKILLS_SOURCE_REPOSITORY ||
      !validateInstallTarget(entry, target)
    ) {
      return installationError("INSTALLATION_IDENTITY_MISMATCH", "Skill origin or destination is not authorized", "none");
    }
    const snapshot = presentedSnapshot ?? this.presentedSnapshot;
    if (snapshot === undefined)
      return installationError(
        "INSTALLATION_IDENTITY_MISMATCH",
        "Skill installation requires the catalog snapshot presented by autoskills",
        "none",
      );
    const snapshotPayload = validateCatalogPayload(snapshot);
    if (!snapshotPayload.ok)
      return installationError(
        "INSTALLATION_IDENTITY_MISMATCH",
        "The presented autoskills catalog snapshot is invalid",
        "none",
        snapshotPayload.error.message,
      );
    if (sha256(catalogSnapshotDigestInput(snapshotPayload.value)) !== snapshot.manifestDigest)
      return installationError("INSTALLATION_IDENTITY_MISMATCH", "The presented autoskills catalog snapshot digest does not match", "none");
    const membership = findCatalogEntry(snapshot, entry);
    if (!membership.ok) return installationError("INSTALLATION_IDENTITY_MISMATCH", membership.error.message, "none");
    if (approval.approved !== true || !/^[a-f0-9]{64}$/i.test(approval.planHash) || approval.operationId.trim().length === 0) {
      return installationError("INSTALLATION_FAILED", "Skill installation requires an exact approved external operation", "none");
    }
    const request = registerAutoSkillsInstall(this.root, membership.value, target, true);
    if (!request.ok) return installationError("INSTALLATION_IDENTITY_MISMATCH", request.error.message, "none");

    if (this.fileSystem === undefined)
      return installationError("INSTALLATION_FAILED", "Skill installation requires a filesystem verifier", "none");
    const expected = await this.captureExpectedFiles(membership.value, target);
    if (!expected.ok) return expected;

    let result: ProcessResult;
    try {
      result = await this.executor.execute(request.value);
    } catch (error) {
      return this.finishFailedInstall(
        expected.value,
        "INSTALLATION_FAILED",
        "Unable to execute the official autoskills installer",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (result.timedOut || result.truncated || result.exitCode !== 0 || !outputWithinLimit(result, this.maxOutputBytes)) {
      return this.finishFailedInstall(
        expected.value,
        "INSTALLATION_FAILED",
        "The official autoskills installation did not complete",
        result.timedOut ? "process timed out" : result.stderr.slice(0, 512),
      );
    }

    const verification = await this.verifyExpectedFiles(membership.value, target);
    if (!verification.ok) {
      return this.finishFailedInstall(
        expected.value,
        "INSTALLATION_IDENTITY_MISMATCH",
        verification.error.message,
        verification.error.cause,
      );
    }
    const artifact: InstalledArtifact = {
      componentId: membership.value.id,
      destination: target,
      files: membership.value.files.map((file) => file.relativePath),
      digest: manifestDigest(membership.value),
    };
    if (this.ownershipStore !== undefined) {
      const loaded = await this.ownershipStore.load();
      if (!loaded.ok)
        return this.finishFailedInstall(
          expected.value,
          "PARTIAL_ARTIFACTS",
          "Installed Skill ownership could not be loaded",
          loaded.error.message,
        );
      const runId = this.ownershipRunId ?? (approval.operationId as RunId);
      const state = upsertSkillOwnership(loaded.value, membership.value, artifact.digest, [target], runId);
      const saved = await this.ownershipStore.save(state);
      if (!saved.ok)
        return this.finishFailedInstall(
          expected.value,
          "PARTIAL_ARTIFACTS",
          "Installed Skill ownership could not be persisted",
          saved.error.message,
        );
    }
    return ok(artifact);
  }

  private async captureExpectedFiles(
    entry: SkillCatalogEntry,
    target: SafeProjectPath,
  ): Promise<Result<readonly ExpectedFileState[], InstallationError>> {
    const states: ExpectedFileState[] = [];
    for (const file of entry.files) {
      const path = asSafeProjectPath(`${target}/${file.relativePath}`);
      if (!path.ok)
        return installationError("INSTALLATION_IDENTITY_MISMATCH", `Skill file destination is unsafe: ${file.relativePath}`, "none");
      try {
        const exists = await this.fileSystem!.exists(path.value);
        states.push(exists ? { path: path.value, bytes: await this.fileSystem!.read(path.value) } : { path: path.value });
      } catch (error) {
        return installationError(
          "INSTALLATION_FAILED",
          "Unable to snapshot Skill destination before installation",
          "retry",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return ok(states);
  }

  private async verifyExpectedFiles(entry: SkillCatalogEntry, target: SafeProjectPath): Promise<Result<void, InstallationError>> {
    for (const file of entry.files) {
      const path = asSafeProjectPath(`${target}/${file.relativePath}`);
      if (!path.ok)
        return installationError("INSTALLATION_IDENTITY_MISMATCH", `Skill file destination is unsafe: ${file.relativePath}`, "none");
      try {
        if (!(await this.fileSystem!.exists(path.value)))
          return installationError("INSTALLATION_IDENTITY_MISMATCH", `Installed Skill file is missing: ${file.relativePath}`, "rollback");
        const bytes = await this.fileSystem!.read(path.value);
        const actual = sha256(bytes);
        if (bytes.byteLength !== file.size || actual.toLowerCase() !== file.sha256.toLowerCase()) {
          return installationError(
            "INSTALLATION_IDENTITY_MISMATCH",
            `Installed Skill file failed size or SHA-256 verification: ${file.relativePath}`,
            "rollback",
            `expected ${file.size}/${file.sha256}, received ${bytes.byteLength}/${actual}`,
          );
        }
      } catch (error) {
        return installationError(
          "INSTALLATION_FAILED",
          "Unable to verify an installed Skill file",
          "rollback",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return ok(undefined);
  }

  private async finishFailedInstall(
    expected: readonly ExpectedFileState[],
    code: InstallationError["code"],
    message: string,
    cause?: string,
  ): Promise<Result<never, InstallationError>> {
    const cleanupErrors: string[] = [];
    for (const state of expected) {
      try {
        const exists = await this.fileSystem!.exists(state.path);
        if (!exists) continue;
        const cleanup =
          state.bytes === undefined ? await this.fileSystem!.remove(state.path) : await this.fileSystem!.write(state.path, state.bytes);
        if (!cleanup.ok) cleanupErrors.push(`${state.path}: ${cleanup.error.message}`);
      } catch (error) {
        cleanupErrors.push(`${state.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (cleanupErrors.length > 0)
      return installationError(
        "PARTIAL_ARTIFACTS",
        "Skill installation failed and partial artifacts could not be fully cleaned",
        "manual-review",
        [...(cause === undefined ? [] : [cause]), ...cleanupErrors].join("; "),
      );
    return installationError(code, message, code === "INSTALLATION_FAILED" ? "rollback" : "none", cause);
  }
}

export const createMidudevAutoSkillsGateway = (executor: ProcessExecutor, options: AutoSkillsGatewayOptions): MidudevAutoSkillsGateway =>
  new MidudevAutoSkillsGateway(executor, options);
