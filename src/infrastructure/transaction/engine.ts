import { createHash } from "node:crypto";
import type {
  ApprovedPlan,
  CommitReceipt,
  ComponentDefinition,
  FileChange,
  JournalEntry,
  ManagedState,
  PreparedOperation,
  RecoveryJournal,
  RecoveryResult,
  Result,
  SafeProjectPath,
  Sha256,
  SkillOwnershipStore,
  TransactionEngine,
  TransactionOperation,
  TransactionResult,
  TxContext,
} from "../../domain/index.js";
import { asSafeProjectPath, autoSkillsPolicyFailure, calculatePlanHash, err, isAllowedAutoSkillsOperation, isSafeRelativePath, mergeManagedState, ok } from "../../domain/index.js";
import type { FileSystemPort } from "../../domain/shared/ports.js";
import type { AppError, CanonicalPath, RunId } from "../../domain/shared/types.js";
import type { ExternalOperation } from "../../domain/planning/models.js";

const TRANSACTION_ROOT = ".auto-ai-setup/transactions";
const ACTIVE_LOCK = `${TRANSACTION_ROOT}/active`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface AtomicFileSystemPort extends FileSystemPort {
  /** Validates lexical and real project containment without performing a mutation. */
  validateContained?(path: SafeProjectPath): Promise<Result<void>>;
  writeAtomic?(path: SafeProjectPath, content: Uint8Array): Promise<Result<void>>;
  createExclusive?(path: SafeProjectPath, content: Uint8Array): Promise<Result<void>>;
  fsync?(path: SafeProjectPath): Promise<Result<void>>;
}

export interface TransactionEngineOptions {
  readonly fileSystem: AtomicFileSystemPort;
  readonly stateStore?: SkillOwnershipStore;
  readonly operations?: ReadonlyMap<string, TransactionOperation>;
  readonly fileContents?: ReadonlyMap<string, Uint8Array>;
  readonly componentDefinitions?: readonly ComponentDefinition[];
  readonly now?: () => string;
}

interface Snapshot {
  readonly entry: JournalEntry;
  readonly bytes?: Uint8Array;
}

const terminal = (phase: RecoveryJournal["phase"]): boolean => phase === "committed" || phase === "rolled-back";
const digest = (bytes: Uint8Array): Sha256 => createHash("sha256").update(bytes).digest("hex") as Sha256;
const textError = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const failure = (message: string, code: "UNEXPECTED_ERROR" | "VERIFY_FAILED" | "WRITE_FAILED" = "UNEXPECTED_ERROR"): AppError => ({
  code,
  message,
  recoverability: "rollback",
});
const journalPath = (runId: RunId): SafeProjectPath => `${TRANSACTION_ROOT}/${runId}/journal.json` as SafeProjectPath;
const backupPath = (runId: RunId, index: number): SafeProjectPath =>
  `${TRANSACTION_ROOT}/${runId}/backups/${String(index).padStart(6, "0")}.bak` as SafeProjectPath;

const unsignedPlan = (
  plan: ApprovedPlan,
): Omit<ApprovedPlan, "planHash" | "approval" | "approvedFileChangeIds" | "approvedExternalOperationIds"> =>
  Object.fromEntries(
    Object.entries(plan).filter(
      ([key]) => !["planHash", "approval", "approvedFileChangeIds", "approvedExternalOperationIds"].includes(key),
    ),
  ) as Omit<ApprovedPlan, "planHash" | "approval" | "approvedFileChangeIds" | "approvedExternalOperationIds">;

const validateJournal = (journal: RecoveryJournal): string | undefined => {
  if (journal.schemaVersion !== 1 || journal.runId.length === 0 || journal.root.length === 0 || journal.planHash.length !== 64)
    return "Transaction journal has an invalid identity or schema";
  for (const entry of journal.entries) {
    if (entry.operationId.length === 0 || !isSafeRelativePath(String(entry.destination)))
      return `Transaction journal has an unsafe destination: ${entry.destination}`;
    if (entry.prior.existed && !isSafeRelativePath(String(entry.prior.backupPath)))
      return `Transaction journal has an unsafe backup path: ${entry.prior.backupPath}`;
  }
  return undefined;
};

const validatePlan = (plan: ApprovedPlan): string | undefined => {
  if (calculatePlanHash(unsignedPlan(plan)) !== plan.planHash || plan.approval.planHash !== plan.planHash)
    return "The approved plan hash is stale or inconsistent";
  const fileIds = new Set(plan.fileChanges.map((change) => change.id));
  const externalIds = new Set(plan.externalOperations.map((operation) => operation.id));
  if (
    new Set(plan.approvedFileChangeIds).size !== plan.approvedFileChangeIds.length ||
    plan.approvedFileChangeIds.some((id) => !fileIds.has(id))
  )
    return "Approved file operation IDs are not a subset of the plan";
  if (
    new Set(plan.approvedExternalOperationIds).size !== plan.approvedExternalOperationIds.length ||
    plan.approvedExternalOperationIds.some((id) => !externalIds.has(id))
  )
    return "Approved external operation IDs are not a subset of the plan";
  if (plan.approvedExternalOperationIds.some((id) => !plan.approval.networkOperations.includes(id)))
    return "An external operation is not explicitly network-approved";
  for (const change of plan.fileChanges)
    if (!isSafeRelativePath(String(change.destination))) return `Unsafe destination: ${change.destination}`;
  for (const operation of plan.externalOperations) {
    if (!isAllowedAutoSkillsOperation(operation)) return autoSkillsPolicyFailure(operation);
    if (!isSafeRelativePath(String(operation.destination)) || operation.origin.length === 0 || operation.purpose.length === 0)
      return `Invalid external operation: ${operation.id}`;
    for (const expected of operation.expectedFiles) if (!isSafeRelativePath(expected.path)) return `Unsafe expected file: ${expected.path}`;
  }
  return undefined;
};

export class PersistentTransactionEngine implements TransactionEngine {
  private static readonly heldLocks = new Set<string>();
  private readonly fileSystem: AtomicFileSystemPort;
  private readonly now: () => string;
  private readonly operations: ReadonlyMap<string, TransactionOperation>;
  private readonly contents: ReadonlyMap<string, Uint8Array>;

  public constructor(private readonly options: TransactionEngineOptions) {
    this.fileSystem = options.fileSystem;
    this.now = options.now ?? (() => new Date().toISOString());
    this.operations = options.operations ?? new Map();
    this.contents = options.fileContents ?? new Map();
  }

  public async apply(plan: ApprovedPlan, signal: AbortSignal): Promise<TransactionResult> {
    const invalid = validatePlan(plan);
    if (invalid !== undefined) return this.incomplete(invalid);
    const containment = await this.validatePlanContainment(plan);
    if (containment !== undefined) return this.incomplete(containment);
    if (signal.aborted) return this.cancelled();
    const gate = await this.recoveryGate(plan.root);
    if (gate !== undefined) return this.incomplete(gate);
    const lock = await this.acquireLock(plan.root, plan.runId);
    if (!lock.ok) return this.incomplete(lock.error.message);

    const entries: JournalEntry[] = this.approvedEntries(plan);
    let journal: RecoveryJournal = {
      schemaVersion: 1,
      runId: plan.runId,
      root: plan.root,
      planHash: plan.planHash,
      phase: "preparing",
      entries,
      manualReviewPaths: [],
    };
    try {
      await this.saveJournal(journal);
    } catch (cause) {
      await this.releaseLock(plan.runId);
      return this.incomplete(`Unable to persist transaction journal: ${textError(cause)}`);
    }
    const receipts: CommitReceipt[] = [];
    const snapshots: Snapshot[] = [];
    try {
      const prepared = await this.prepare(plan, entries, signal, snapshots);
      if (!prepared.ok) {
        journal = {
          ...journal,
          entries: journal.entries.map(
            (entry) => snapshots.find((snapshot) => snapshot.entry.operationId === entry.operationId)?.entry ?? entry,
          ),
        };
        return await this.failAndRollback(journal, receipts, prepared.error.message);
      }
      journal = {
        ...journal,
        phase: "prepared",
        entries: journal.entries.map(
          (entry) => snapshots.find((snapshot) => snapshot.entry.operationId === entry.operationId)?.entry ?? entry,
        ),
      };
      await this.saveJournal(journal);
      if (signal.aborted) return await this.failAndRollback(journal, receipts, "Execution cancelled during prepare", true);
      journal = { ...journal, phase: "committing" };
      await this.saveJournal(journal);
      for (let index = 0; index < prepared.value.length; index += 1) {
        if (signal.aborted) return await this.failAndRollback(journal, receipts, "Execution cancelled during commit", true);
        const item = prepared.value[index];
        if (item === undefined) continue;
        const receipt = await item.operation.commit(item.prepared);
        if (!receipt.ok) return await this.failAndRollback(journal, receipts, receipt.error.message);
        receipts.push(receipt.value);
        journal = this.markEntry(journal, item.prepared.operationId, "committed");
        await this.saveJournal(journal);
        const verified = await this.verifyCommitted(item.prepared);
        if (!verified.ok) return await this.failAndRollback(journal, receipts, verified.error.message);
      }
      const state = await this.persistManagedState(plan);
      if (!state.ok) return await this.failAndRollback(journal, receipts, state.error.message);
      journal = { ...journal, phase: "committed" };
      await this.saveJournal(journal);
      await this.cleanupArtifacts(journal);
      await this.releaseLock(plan.runId);
      return {
        status: "committed",
        exitCode: 0,
        applied: receipts.map((receipt) => receipt.operationId),
        skipped: await this.computeSkipped(plan, receipts, snapshots),
        warnings: [],
        errors: [],
        manualReviewPaths: [],
      };
    } catch (cause) {
      return this.failAndRollback(journal, receipts, textError(cause));
    }
  }

  public async recover(journal: RecoveryJournal): Promise<RecoveryResult> {
    const invalid = validateJournal(journal);
    if (invalid !== undefined)
      return { status: "incomplete", exitCode: 3, restored: [], manualReviewPaths: journal.manualReviewPaths, errors: [invalid] };
    if (terminal(journal.phase))
      return {
        status: "restored",
        exitCode: 1,
        restored: [],
        manualReviewPaths: journal.manualReviewPaths,
        errors: [`Journal is already terminal: ${journal.phase}`],
      };
    const lock = await this.acquireLock(journal.root, journal.runId);
    if (!lock.ok) return { status: "incomplete", exitCode: 3, restored: [], manualReviewPaths: [], errors: [lock.error.message] };
    let current: RecoveryJournal = { ...journal, phase: "rolling-back" };
    try {
      await this.saveJournal(current);
    } catch (cause) {
      return { status: "incomplete", exitCode: 3, restored: [], manualReviewPaths: current.manualReviewPaths, errors: [textError(cause)] };
    }
    const result = await this.restoreEntries(current);
    if (result.manualReviewPaths.length > 0) {
      current = { ...current, manualReviewPaths: result.manualReviewPaths };
      await this.saveJournal(current);
      return {
        status: "incomplete",
        exitCode: 3,
        restored: result.restored,
        manualReviewPaths: result.manualReviewPaths,
        errors: result.errors,
      };
    }
    current = { ...current, phase: "rolled-back", manualReviewPaths: [] };
    await this.saveJournal(current);
    await this.cleanupArtifacts(current);
    await this.releaseLock(journal.runId);
    return { status: "restored", exitCode: 1, restored: result.restored, manualReviewPaths: [], errors: result.errors };
  }
  private approvedEntries(plan: ApprovedPlan): JournalEntry[] {
    const changes = plan.fileChanges
      .filter((change) => plan.approvedFileChangeIds.includes(change.id) && change.action !== "preserve" && change.action !== "skip")
      .sort((left, right) => left.destination.localeCompare(right.destination) || left.id.localeCompare(right.id));
    return changes.map(
      (change) =>
        ({
          operationId: change.id,
          destination: change.destination,
          prior: { existed: false },
          desiredDigest:
            change.afterDigest ?? (this.contents.has(change.id) ? digest(this.contents.get(change.id) as Uint8Array) : ("" as Sha256)),
          status: "pending",
        }) satisfies JournalEntry,
    );
  }

  private async prepare(
    plan: ApprovedPlan,
    entries: readonly JournalEntry[],
    signal: AbortSignal,
    snapshots: Snapshot[],
  ): Promise<Result<readonly { operation: TransactionOperation; prepared: PreparedOperation }[]>> {
    const prepared: { operation: TransactionOperation; prepared: PreparedOperation }[] = [];
    const changes = new Map(plan.fileChanges.map((change) => [change.id, change]));
    for (const entry of entries) {
      if (signal.aborted) return err(failure("Execution cancelled during prepare"));
      const change = changes.get(entry.operationId);
      if (change === undefined) return err(failure(`Approved operation is not present in the plan`));
      const current = await this.snapshot(plan, change, entry, entries.indexOf(entry));
      if (!current.ok) return current;
      snapshots.push(current.value);
      if (current.value.entry.prior.existed && change.afterDigest !== undefined && current.value.entry.prior.digest === change.afterDigest)
        continue;
      const operation = this.operations.get(entry.operationId) ?? this.defaultFileOperation(change);
      if (operation === undefined) return err(failure(`No approved operation implementation exists for ${entry.operationId}`));
      const context: TxContext = { plan, signal };
      const result = await operation.prepare(context);
      if (!result.ok) return result;
      const verify = await operation.verify(result.value);
      if (!verify.ok) return verify;
      if (change.afterDigest !== undefined && result.value.desiredDigest !== undefined && change.afterDigest !== result.value.desiredDigest)
        return err(failure(`Prepared digest does not match the approved digest for ${entry.operationId}`));
      prepared.push({ operation, prepared: result.value });
    }
    const external = plan.externalOperations
      .filter((operation) => plan.approvedExternalOperationIds.includes(operation.id))
      .sort((left, right) => left.destination.localeCompare(right.destination) || left.id.localeCompare(right.id));
    for (const operationDefinition of external) {
      if (signal.aborted) return err(failure("Execution cancelled during prepare"));
      if (await this.externalEquivalent(operationDefinition)) continue;
      const operation = this.operations.get(operationDefinition.id);
      if (operation === undefined)
        return err(failure(`No approved external operation implementation exists for ${operationDefinition.id}`));
      const result = await operation.prepare({ plan, signal });
      if (!result.ok) return result;
      const verified = await operation.verify(result.value);
      if (!verified.ok) return verified;
      prepared.push({ operation, prepared: result.value });
    }
    return ok(prepared);
  }

  private async externalEquivalent(operation: ExternalOperation): Promise<boolean> {
    if (operation.expectedFiles.length === 0) return false;
    for (const expected of operation.expectedFiles) {
      const path = asSafeProjectPath(expected.path);
      if (!path.ok || !(await this.fileSystem.exists(path.value))) return false;
      const actual = digest(await this.fileSystem.read(path.value));
      if (actual !== expected.sha256) return false;
    }
    return true;
  }

  private defaultFileOperation(change: FileChange): TransactionOperation | undefined {
    const content = this.contents.get(change.id);
    if (content === undefined) return undefined;
    const bytes = content.slice();
    return new ContentFileOperation(this.fileSystem, change, bytes);
  }

  private async snapshot(plan: ApprovedPlan, change: FileChange, entry: JournalEntry, index: number): Promise<Result<Snapshot>> {
    const exists = await this.fileSystem.exists(change.destination);
    if (!exists) {
      if (change.action === "modify" || change.beforeDigest !== undefined)
        return err(failure(`Modify precondition failed for ${change.destination}`, "VERIFY_FAILED"));
      return ok({ entry: { ...entry, prior: { existed: false } } });
    }
    const bytes = await this.fileSystem.read(change.destination);
    const before = digest(bytes);
    if (change.afterDigest !== undefined && before === change.afterDigest)
      return ok({ entry: { ...entry, prior: { existed: true, digest: before, backupPath: backupPath(plan.runId, index) } } });
    if (change.action === "create") return err(failure(`Create precondition failed for ${change.destination}`, "VERIFY_FAILED"));
    if (change.beforeDigest !== undefined && before !== change.beforeDigest)
      return err(failure(`Concurrent change detected at ${change.destination}`, "VERIFY_FAILED"));
    const savedEntry: JournalEntry = { ...entry, prior: { existed: true, digest: before, backupPath: backupPath(plan.runId, index) } };
    const backup = await this.writeDurable(savedEntry.prior.existed ? savedEntry.prior.backupPath : backupPath(plan.runId, index), bytes);
    if (!backup.ok) return err(backup.error);
    const backedUp: JournalEntry = { ...savedEntry, status: "backed-up" };
    return ok({ entry: backedUp, bytes });
  }

  private async verifyCommitted(prepared: PreparedOperation): Promise<Result<void>> {
    if (prepared.desiredDigest === undefined) return ok(undefined);
    const exists = await this.fileSystem.exists(prepared.destination);
    if (!exists) return err(failure(`Committed destination is missing: ${prepared.destination}`, "VERIFY_FAILED"));
    const actual = digest(await this.fileSystem.read(prepared.destination));
    return actual === prepared.desiredDigest
      ? ok(undefined)
      : err(failure(`Committed digest mismatch at ${prepared.destination}`, "VERIFY_FAILED"));
  }

  private async persistManagedState(plan: ApprovedPlan): Promise<Result<ManagedState | undefined>> {
    if (this.options.stateStore === undefined) return ok(undefined);
    const loaded = await this.options.stateStore.load();
    if (!loaded.ok) return loaded;
    const definitions = new Map(
      (this.options.componentDefinitions ?? []).map((component) => [`${component.type}:${component.id}`, component]),
    );
    const records = new Map<
      string,
      { component: Pick<ComponentDefinition, "id" | "type" | "source">; destinations: SafeProjectPath[]; contentDigest: Sha256 }
    >();
    for (const change of plan.fileChanges.filter(
      (item) => plan.approvedFileChangeIds.includes(item.id) && item.action !== "preserve" && item.action !== "skip",
    )) {
      const previous =
        loaded.value === undefined
          ? undefined
          : Object.entries(loaded.value.components).find(([key]) => key.endsWith(`:${change.componentId}`))?.[1];
      const definition = definitions.get(`${previous?.type ?? "agent-command"}:${change.componentId}`);
      const type = definition?.type ?? previous?.type ?? "agent-command";
      const source = definition?.source ?? { kind: "builtin" as const, origin: change.origin ?? "plan" };
      const component = { id: change.componentId, type, source };
      const key = `${type}:${change.componentId}`;
      const existing = records.get(key);
      records.set(key, {
        component,
        destinations: [...(existing?.destinations ?? []), change.destination],
        contentDigest: change.afterDigest ?? existing?.contentDigest ?? ("0".repeat(64) as Sha256),
      });
    }
    const state = mergeManagedState(loaded.value, [...records.values()], plan.runId);
    const saved = await this.options.stateStore.save(state);
    return saved.ok ? ok(state) : saved;
  }

  private markEntry(journal: RecoveryJournal, operationId: string, status: JournalEntry["status"]): RecoveryJournal {
    return { ...journal, entries: journal.entries.map((entry) => (entry.operationId === operationId ? { ...entry, status } : entry)) };
  }

  private async failAndRollback(
    journal: RecoveryJournal,
    receipts: readonly CommitReceipt[],
    message: string,
    cancelled = false,
  ): Promise<TransactionResult> {
    const result = await this.rollback(journal, receipts);
    const errors = [message, ...result.errors];
    if (result.manualReviewPaths.length > 0)
      return {
        status: "incomplete",
        exitCode: 3,
        applied: receipts.map((receipt) => receipt.operationId),
        skipped: [],
        warnings: cancelled ? ["Execution cancelled"] : [],
        errors,
        manualReviewPaths: result.manualReviewPaths,
        journal: result.journal,
      };
    await this.cleanupArtifacts(result.journal);
    await this.releaseLock(journal.runId);
    return {
      status: "rolled-back",
      exitCode: cancelled ? 0 : 1,
      applied: [],
      skipped: [],
      warnings: cancelled ? ["Execution cancelled"] : [],
      errors,
      manualReviewPaths: [],
      journal: result.journal,
    };
  }

  private async rollback(
    journal: RecoveryJournal,
    receipts: readonly CommitReceipt[],
  ): Promise<{ journal: RecoveryJournal; errors: string[]; manualReviewPaths: SafeProjectPath[] }> {
    let current: RecoveryJournal = { ...journal, phase: "rolling-back" };
    const errors: string[] = [];
    const paths: SafeProjectPath[] = [];
    try {
      await this.saveJournal(current);
    } catch (cause) {
      errors.push(textError(cause));
    }
    for (const receipt of [...receipts].reverse()) {
      const operation = this.operations.get(receipt.operationId);
      if (operation !== undefined) {
        try {
          const undone = await operation.rollback(receipt);
          if (!undone.ok) {
            errors.push(undone.error.message);
            paths.push(receipt.destination);
          }
        } catch (cause) {
          errors.push(textError(cause));
          paths.push(receipt.destination);
        }
      }
    }
    const restored = await this.restoreEntries(current);
    errors.push(...restored.errors);
    paths.push(...restored.manualReviewPaths);
    current = {
      ...current,
      entries: current.entries.map((entry) =>
        restored.restored.includes(entry.operationId) ? { ...entry, status: "restored" as const } : entry,
      ),
      manualReviewPaths: [...new Set(paths)],
    };
    if (paths.length === 0) current = { ...current, phase: "rolled-back" };
    try {
      await this.saveJournal(current);
    } catch (cause) {
      errors.push(textError(cause));
    }
    return { journal: current, errors, manualReviewPaths: [...new Set(paths)] };
  }

  private async restoreEntries(
    journal: RecoveryJournal,
  ): Promise<{ restored: string[]; errors: string[]; manualReviewPaths: SafeProjectPath[] }> {
    const restored: string[] = [];
    const errors: string[] = [];
    const manualReviewPaths: SafeProjectPath[] = [];
    for (const entry of [...journal.entries].reverse()) {
      if (entry.status === "pending" && !entry.prior.existed) {
        if (!(await this.fileSystem.exists(entry.destination))) continue;
        const current = digest(await this.fileSystem.read(entry.destination));
        if (entry.desiredDigest.length === 0 || current !== entry.desiredDigest) {
          errors.push(`Unclassified artifact requires review at ${entry.destination}`);
          manualReviewPaths.push(entry.destination);
          continue;
        }
      }
      try {
        if (entry.prior.existed) {
          const backupExists = await this.fileSystem.exists(entry.prior.backupPath);
          if (!backupExists) throw new Error(`Backup is missing for ${entry.destination}`);
          const bytes = await this.fileSystem.read(entry.prior.backupPath);
          if (digest(bytes) !== entry.prior.digest) throw new Error(`Backup digest mismatch for ${entry.destination}`);
          const write = await this.writeDurable(entry.destination, bytes);
          if (!write.ok) throw new Error(write.error.message);
        } else {
          const remove = await this.fileSystem.remove(entry.destination);
          if (!remove.ok) throw new Error(remove.error.message);
        }
        const exists = await this.fileSystem.exists(entry.destination);
        if (
          exists !== entry.prior.existed ||
          (exists && digest(await this.fileSystem.read(entry.destination)) !== (entry.prior.existed ? entry.prior.digest : ""))
        )
          throw new Error(`Restored state mismatch for ${entry.destination}`);
        restored.push(entry.operationId);
      } catch (cause) {
        errors.push(textError(cause));
        manualReviewPaths.push(entry.destination);
      }
    }
    return { restored, errors, manualReviewPaths };
  }
  private async cleanupArtifacts(journal: RecoveryJournal): Promise<void> {
    for (const entry of journal.entries) {
      if (!entry.prior.existed) continue;
      try {
        if (await this.fileSystem.exists(entry.prior.backupPath)) await this.fileSystem.remove(entry.prior.backupPath);
      } catch {
        /* preserve the terminal journal */
      }
    }
  }

  private async validatePlanContainment(plan: ApprovedPlan): Promise<string | undefined> {
    const validate = this.fileSystem.validateContained;
    if (validate === undefined) return undefined;
    const paths = new Set<string>();
    for (const change of plan.fileChanges) paths.add(String(change.destination));
    for (const operation of plan.externalOperations) {
      paths.add(String(operation.destination));
      for (const expected of operation.expectedFiles) paths.add(String(expected.path));
    }
    for (const value of paths) {
      const checked = await validate(value as SafeProjectPath);
      if (!checked.ok) return `Unsafe planned destination ${value}: ${checked.error.message}`;
    }
    return undefined;
  }

  private async recoveryGate(root: CanonicalPath): Promise<string | undefined> {
    const entries = await this.fileSystem.list(root);
    for await (const descriptor of entries) {
      const path = String(descriptor.path);
      if (!path.startsWith(`${TRANSACTION_ROOT}/`) || !path.endsWith("/journal.json")) continue;
      try {
        const parsed = JSON.parse(decoder.decode(await this.fileSystem.read(descriptor.path))) as RecoveryJournal;
        if (!terminal(parsed.phase)) return `Recovery is required for non-terminal journal ${parsed.runId}`;
      } catch (cause) {
        return `Unable to inspect transaction journal ${path}: ${textError(cause)}`;
      }
    }
    const active = await this.fileSystem.exists(ACTIVE_LOCK as SafeProjectPath);
    return active ? "An active transaction lock requires recovery or manual review" : undefined;
  }

  private async acquireLock(root: CanonicalPath, runId: RunId): Promise<Result<void>> {
    void root;
    if (PersistentTransactionEngine.heldLocks.has(String(runId))) return ok(undefined);
    let ownsExistingLock = false;
    if (await this.fileSystem.exists(ACTIVE_LOCK as SafeProjectPath)) {
      let owner = "unknown";
      try {
        owner = decoder.decode(await this.fileSystem.read(ACTIVE_LOCK as SafeProjectPath));
      } catch {
        /* preserve the lock as evidence */
      }
      if (!owner.includes(String(runId))) return err(failure(`Transaction lock is active: ${owner}`, "VERIFY_FAILED"));
      ownsExistingLock = true;
    }
    const lockContent = encoder.encode(JSON.stringify({ runId, acquiredAt: this.now() }));
    const written = ownsExistingLock
      ? ok(undefined)
      : this.fileSystem.createExclusive !== undefined
        ? await this.fileSystem.createExclusive(ACTIVE_LOCK as SafeProjectPath, lockContent)
        : await this.writeDurable(ACTIVE_LOCK as SafeProjectPath, lockContent);
    if (!written.ok) return written;
    PersistentTransactionEngine.heldLocks.add(String(runId));
    return ok(undefined);
  }

  private async releaseLock(runId: RunId): Promise<void> {
    PersistentTransactionEngine.heldLocks.delete(String(runId));
    try {
      if (await this.fileSystem.exists(ACTIVE_LOCK as SafeProjectPath)) await this.fileSystem.remove(ACTIVE_LOCK as SafeProjectPath);
    } catch {
      /* leave evidence for manual recovery */
    }
  }

  private async saveJournal(journal: RecoveryJournal): Promise<void> {
    const target = journalPath(journal.runId);
    const result = await this.writeDurable(target, encoder.encode(`${JSON.stringify(journal)}\n`));
    if (!result.ok) throw new Error(result.error.message);
  }

  private async writeDurable(path: SafeProjectPath, content: Uint8Array): Promise<Result<void>> {
    try {
      const result =
        this.fileSystem.writeAtomic !== undefined
          ? await this.fileSystem.writeAtomic(path, content.slice())
          : await this.fileSystem.write(path, content.slice());
      if (!result.ok) return result;
      if (this.fileSystem.fsync !== undefined) return this.fileSystem.fsync(path);
      return ok(undefined);
    } catch (cause) {
      return err(failure(`Durable write failed for ${path}: ${textError(cause)}`, "WRITE_FAILED"));
    }
  }

  private async computeSkipped(plan: ApprovedPlan, receipts: readonly CommitReceipt[], snapshots: readonly Snapshot[]): Promise<string[]> {
    const skipped = new Set<string>();
    const applied = new Set(receipts.map((receipt) => receipt.operationId));
    for (const change of plan.fileChanges) {
      if (!plan.approvedFileChangeIds.includes(change.id) || change.action === "preserve" || change.action === "skip")
        skipped.add(change.id);
      else if (
        !applied.has(change.id) &&
        change.afterDigest !== undefined &&
        (await this.fileSystem.exists(change.destination)) &&
        digest(await this.fileSystem.read(change.destination)) === change.afterDigest
      )
        skipped.add(change.id);
    }
    for (const operation of plan.externalOperations) {
      if (
        !plan.approvedExternalOperationIds.includes(operation.id) ||
        (!applied.has(operation.id) && (await this.externalEquivalent(operation)))
      )
        skipped.add(operation.id);
    }
    for (const snapshot of snapshots)
      if (
        !applied.has(snapshot.entry.operationId) &&
        snapshot.entry.prior.existed &&
        snapshot.entry.prior.digest === snapshot.entry.desiredDigest
      )
        skipped.add(snapshot.entry.operationId);
    return [...skipped].sort();
  }

  private incomplete(error: string): TransactionResult {
    return { status: "incomplete", exitCode: 3, applied: [], skipped: [], warnings: [], errors: [error], manualReviewPaths: [] };
  }

  private cancelled(): TransactionResult {
    return {
      status: "rolled-back",
      exitCode: 0,
      applied: [],
      skipped: [],
      warnings: ["Execution cancelled before prepare"],
      errors: [],
      manualReviewPaths: [],
    };
  }
}

export class ContentFileOperation implements TransactionOperation {
  public constructor(
    private readonly fileSystem: AtomicFileSystemPort,
    private readonly change: FileChange,
    private readonly content: Uint8Array,
  ) {}
  public async prepare(signalContext: TxContext): Promise<Result<PreparedOperation>> {
    if (signalContext.signal.aborted) return err(failure("Execution cancelled during prepare"));
    return ok({ operationId: this.change.id, destination: this.change.destination, desiredDigest: digest(this.content) });
  }
  public async verify(prepared: PreparedOperation): Promise<Result<void>> {
    return prepared.desiredDigest === digest(this.content)
      ? ok(undefined)
      : err(failure(`Prepared content digest mismatch for ${this.change.id}`, "VERIFY_FAILED"));
  }
  public async commit(prepared: PreparedOperation): Promise<Result<CommitReceipt>> {
    const written =
      this.fileSystem.writeAtomic !== undefined
        ? await this.fileSystem.writeAtomic(prepared.destination, this.content.slice())
        : await this.fileSystem.write(prepared.destination, this.content.slice());
    if (!written.ok) return written;
    if (this.fileSystem.fsync !== undefined) {
      const synced = await this.fileSystem.fsync(prepared.destination);
      if (!synced.ok) return synced;
    }
    return ok({ operationId: prepared.operationId, destination: prepared.destination, created: this.change.action === "create" });
  }
  public async rollback(receipt: CommitReceipt): Promise<Result<void>> {
    void receipt;
    return ok(undefined);
  }
}

export const createTransactionEngine = (options: TransactionEngineOptions): PersistentTransactionEngine =>
  new PersistentTransactionEngine(options);
export const RecoverableTransactionEngine = PersistentTransactionEngine;
