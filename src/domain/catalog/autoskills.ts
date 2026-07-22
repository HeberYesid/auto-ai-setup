import type { CatalogSnapshot, SkillCatalogEntry } from "./models.js";
import type { CanonicalPath, CatalogError, Result, Sha256 } from "../shared/types.js";
import { asComponentId, asSha256, err, ok } from "../shared/types.js";
import type { CompatibilityExpression } from "../planning/models.js";

export const AUTOSKILLS_SOURCE_REPOSITORY = "https://github.com/midudev/autoskills" as const;
export const AUTOSKILLS_MAX_OUTPUT_BYTES = 1024 * 1024;
export const AUTOSKILLS_LIST_TIMEOUT_MS = 30_000;
export const AUTOSKILLS_INSTALL_TIMEOUT_MS = 120_000;

export interface AutoSkillsInteractiveProcessRequest {
  readonly command: "npx-autoskills";
  readonly operation: "interactive";
  readonly args: readonly [];
  readonly cwd: CanonicalPath;
  readonly authorized: true;
}

export interface AutoSkillsListProcessRequest {
  readonly command: "npx-autoskills";
  readonly operation: "list";
  readonly args: readonly ["list", "--json"];
  readonly cwd: CanonicalPath;
  readonly authorized: true;
}

export interface AutoSkillsInstallProcessRequest {
  readonly command: "npx-autoskills";
  readonly operation: "install";
  readonly args: readonly ["install", string];
  readonly cwd: CanonicalPath;
  readonly authorized: true;
}

export type RegisteredAutoSkillsRequest =
  | AutoSkillsInteractiveProcessRequest
  | AutoSkillsListProcessRequest
  | AutoSkillsInstallProcessRequest;

export const catalogError = (code: CatalogError["code"], message: string, cause?: string): CatalogError => ({
  code,
  message,
  ...(cause === undefined ? {} : { cause }),
  recoverability: code === "CATALOG_EXECUTION_FAILED" ? "retry" : "none",
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const revisionPattern = /^[0-9a-f]{7,64}$/i;
const safeRelative = (value: unknown): value is string =>
  nonEmptyString(value) &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !value.startsWith("/") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !/^[A-Za-z]:$/.test(part));
const validRevision = (value: unknown): value is string => typeof value === "string" && revisionPattern.test(value);
const validSha = (value: unknown): value is Sha256 => typeof value === "string" && asSha256(value).ok;

const validCompatibility = (value: unknown): value is CompatibilityExpression => {
  if (!isRecord(value) || typeof value.op !== "string") return false;
  switch (value.op) {
    case "always":
      return Object.keys(value).length === 1;
    case "stack":
      return nonEmptyString(value.category) && Array.isArray(value.oneOf) && value.oneOf.length > 0 && value.oneOf.every(nonEmptyString);
    case "cli":
      return (
        Array.isArray(value.oneOf) &&
        value.oneOf.length > 0 &&
        value.oneOf.every((item) => ["gh", "supabase", "vercel", "playwright"].includes(String(item)))
      );
    case "all":
    case "any":
    case "noneOf":
      return Array.isArray(value.clauses) && value.clauses.every(validCompatibility);
    case "not":
      return validCompatibility(value.clause);
    default:
      return false;
  }
};

export const validateSkillCatalogEntry = (value: unknown): value is SkillCatalogEntry => {
  if (
    !isRecord(value) ||
    value.type !== "skill" ||
    !nonEmptyString(value.id) ||
    !asComponentId(value.id).ok ||
    !nonEmptyString(value.name) ||
    !nonEmptyString(value.description)
  )
    return false;
  if (
    !isRecord(value.origin) ||
    value.origin.repository !== AUTOSKILLS_SOURCE_REPOSITORY ||
    !validRevision(value.origin.commit) ||
    !safeRelative(value.origin.relativePath)
  )
    return false;
  if (
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    !validCompatibility(value.compatibility) ||
    value.destinationTemplate !== ".kiro/skills/{id}"
  )
    return false;
  const paths = new Set<string>();
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      !safeRelative(file.relativePath) ||
      paths.has(file.relativePath) ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !validSha(file.sha256)
    )
      return false;
    paths.add(file.relativePath);
  }
  return true;
};

const snapshotFieldsValid = (value: Record<string, unknown>): value is Omit<CatalogSnapshot, "manifestDigest"> =>
  value.schemaVersion === 1 &&
  nonEmptyString(value.catalogId) &&
  value.sourceRepository === AUTOSKILLS_SOURCE_REPOSITORY &&
  validRevision(value.sourceCommit) &&
  nonEmptyString(value.generatedAt) &&
  !Number.isNaN(Date.parse(value.generatedAt)) &&
  Array.isArray(value.entries) &&
  value.entries.length <= 10_000 &&
  value.entries.every(validateSkillCatalogEntry);

export const validateCatalogPayload = (value: unknown): Result<Omit<CatalogSnapshot, "manifestDigest">, CatalogError> => {
  if (!isRecord(value) || !snapshotFieldsValid(value))
    return err(catalogError("CATALOG_INVALID_RESPONSE", "autoskills returned an invalid catalog schema"));
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (ids.has(entry.id))
      return err(catalogError("CATALOG_INVALID_RESPONSE", `autoskills returned duplicate Skill identity: ${entry.id}`));
    ids.add(entry.id);
    if (entry.origin.commit !== value.sourceCommit)
      return err(catalogError("CATALOG_SOURCE_MISMATCH", `Skill ${entry.id} is from a different source revision`));
  }
  return ok({
    schemaVersion: 1,
    catalogId: value.catalogId,
    sourceRepository: AUTOSKILLS_SOURCE_REPOSITORY,
    sourceCommit: value.sourceCommit,
    generatedAt: new Date(value.generatedAt).toISOString(),
    entries: [...value.entries],
  });
};

export const validateCatalogSnapshot = (value: unknown): Result<CatalogSnapshot, CatalogError> => {
  if (!isRecord(value) || !validSha(value.manifestDigest))
    return err(catalogError("CATALOG_INVALID_RESPONSE", "autoskills catalog snapshot has an invalid manifest digest"));
  const payload = validateCatalogPayload(value);
  if (!payload.ok) return payload;
  return ok({ ...payload.value, manifestDigest: value.manifestDigest });
};

/** The exact payload whose digest binds a catalog to the listing response. */
export const catalogSnapshotDigestInput = (
  snapshot: Pick<CatalogSnapshot, "schemaVersion" | "catalogId" | "sourceRepository" | "sourceCommit" | "generatedAt" | "entries">,
): string =>
  JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    catalogId: snapshot.catalogId,
    sourceRepository: snapshot.sourceRepository,
    sourceCommit: snapshot.sourceCommit,
    generatedAt: snapshot.generatedAt,
    entries: snapshot.entries,
  });

const entryIdentity = (entry: SkillCatalogEntry): string =>
  JSON.stringify({
    type: entry.type,
    id: entry.id,
    name: entry.name,
    description: entry.description,
    origin: {
      repository: entry.origin.repository,
      commit: entry.origin.commit,
      relativePath: entry.origin.relativePath,
    },
    files: entry.files.map((file) => ({ relativePath: file.relativePath, size: file.size, sha256: file.sha256.toLowerCase() })),
    compatibility: entry.compatibility,
    destinationTemplate: entry.destinationTemplate,
  });

export const catalogEntriesEquivalent = (left: SkillCatalogEntry, right: SkillCatalogEntry): boolean =>
  entryIdentity(left) === entryIdentity(right);

/** Requires the complete entry (not just its ID) to be present in the presented snapshot. */
export const findCatalogEntry = (snapshot: CatalogSnapshot, entry: SkillCatalogEntry): Result<SkillCatalogEntry, CatalogError> => {
  const matchingId = snapshot.entries.find((candidate) => candidate.id === entry.id);
  if (matchingId === undefined || !catalogEntriesEquivalent(matchingId, entry)) {
    return err(catalogError("CATALOG_SOURCE_MISMATCH", `Skill ${entry.id} is not the same entry presented by autoskills`));
  }
  return ok(matchingId);
};

export const skillOwnershipKey = (entry: SkillCatalogEntry): string => `skill:${entry.id}`;

export const upsertSkillOwnership = (
  state: import("../planning/models.js").ManagedState | undefined,
  entry: SkillCatalogEntry,
  artifactDigest: Sha256,
  destinations: readonly import("../shared/types.js").SafeProjectPath[],
  runId: import("../shared/types.js").RunId,
): import("../planning/models.js").ManagedState => ({
  schemaVersion: 1,
  components: {
    ...(state?.components ?? {}),
    [skillOwnershipKey(entry)]: {
      type: "skill",
      origin: `${entry.origin.repository}#${entry.origin.relativePath}`,
      sourceRevision: entry.origin.commit,
      destinations: [...destinations],
      contentDigest: artifactDigest,
    },
  },
  lastSuccessfulRunId: runId,
});

export const validateInstallTarget = (entry: SkillCatalogEntry, target: string): boolean => {
  const expected = `.kiro/skills/${entry.id}`;
  return target === expected && safeRelative(target);
};

export const catalogPlanningMetadata = (
  snapshot: CatalogSnapshot,
): { readonly catalogDigest: Sha256; readonly catalogSourceRevision: string } => ({
  catalogDigest: snapshot.manifestDigest,
  catalogSourceRevision: snapshot.sourceCommit,
});

export const isRegisteredAutoSkillsRequest = (value: unknown): value is RegisteredAutoSkillsRequest => {
  if (!isRecord(value) || value.command !== "npx-autoskills" || value.authorized !== true || !isRecord(value)) return false;
  if (value.operation === "interactive") return Array.isArray(value.args) && value.args.length === 0;
  if (value.operation === "list")
    return Array.isArray(value.args) && value.args.length === 2 && value.args[0] === "list" && value.args[1] === "--json";
  return (
    value.operation === "install" &&
    Array.isArray(value.args) &&
    value.args.length === 2 &&
    value.args[0] === "install" &&
    typeof value.args[1] === "string" &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(value.args[1])
  );
};

export const registerAutoSkillsInteractive = (
  cwd: CanonicalPath,
  authorized: boolean,
): Result<AutoSkillsInteractiveProcessRequest, CatalogError> => {
  if (!authorized)
    return err(catalogError("CATALOG_EXECUTION_FAILED", "autoskills requires explicit authorization", "authorization denied"));
  return ok({ command: "npx-autoskills", operation: "interactive", args: [], cwd, authorized: true });
};

export const registerAutoSkillsList = (cwd: CanonicalPath, authorized: boolean): Result<AutoSkillsListProcessRequest, CatalogError> => {
  if (!authorized)
    return err(catalogError("CATALOG_EXECUTION_FAILED", "autoskills listing requires explicit authorization", "authorization denied"));
  return ok({ command: "npx-autoskills", operation: "list", args: ["list", "--json"], cwd, authorized: true });
};

export const registerAutoSkillsInstall = (
  cwd: CanonicalPath,
  entry: SkillCatalogEntry,
  target: string,
  authorized: boolean,
): Result<AutoSkillsInstallProcessRequest, CatalogError> => {
  if (!authorized)
    return err(catalogError("CATALOG_EXECUTION_FAILED", "autoskills installation requires explicit approval", "approval denied"));
  if (
    !validateSkillCatalogEntry(entry) ||
    entry.origin.repository !== AUTOSKILLS_SOURCE_REPOSITORY ||
    !validateInstallTarget(entry, target)
  )
    return err(catalogError("CATALOG_SOURCE_MISMATCH", "Skill origin or destination is not authorized"));
  return ok({ command: "npx-autoskills", operation: "install", args: ["install", entry.id], cwd, authorized: true });
};
