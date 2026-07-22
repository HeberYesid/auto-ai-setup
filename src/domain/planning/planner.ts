import { createHash } from "node:crypto";
import { asProjectRelativePath, err, isSafeRelativePath, ok } from "../shared/types.js";
import type { PlanningInput } from "../shared/ports.js";
import type { PlanningError, Result, Sha256 } from "../shared/types.js";
import type { ChangePlan, FieldChange, FileChange, ExternalOperation, RedactedPreview } from "./models.js";
import { SecretRedactor } from "../security/redaction.js";

const actionOrder: Record<FileChange["action"], number> = { create: 0, modify: 1, preserve: 2, skip: 3 };
const conflictOrder: Record<FileChange["conflict"], number> = {
  none: 0,
  "content-differs": 1,
  "invalid-managed-markers": 2,
  "ownership-unknown": 3,
};
const text = (value: unknown): string => (typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)));

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};

export const canonicalPlanSerialization = (plan: Omit<ChangePlan, "planHash"> | ChangePlan): string => {
  const withoutHash = Object.fromEntries(Object.entries(plan as Record<string, unknown>).filter(([key]) => key !== "planHash"));
  return JSON.stringify(canonicalize(withoutHash));
};

export const calculatePlanHash = (plan: Omit<ChangePlan, "planHash"> | ChangePlan): Sha256 =>
  createHash("sha256").update(canonicalPlanSerialization(plan), "utf8").digest("hex") as Sha256;

const invalid = (message: string, path?: string): Result<ChangePlan, PlanningError> =>
  err({
    code: "INVALID_PLAN",
    message,
    ...(path === undefined ? {} : { path }),
    recoverability: "none",
  });

const destinationError = (destination: string): Result<ChangePlan, PlanningError> =>
  err({
    code: "UNSAFE_DESTINATION",
    message: "Every plan destination must be a normalized project-relative path",
    path: destination,
    recoverability: "none",
    exitCode: 2,
  });

const sortFieldChanges = (changes: readonly FieldChange[]): readonly FieldChange[] =>
  [...changes]
    .map((change) => ({ ...change }))
    .sort((left, right) => `${left.path}:${left.action}`.localeCompare(`${right.path}:${right.action}`));

const normalizePreview = (preview: FileChange["preview"], redactor: SecretRedactor): FileChange["preview"] => {
  if (preview.kind === "text")
    return { kind: "text", content: text(redactor.redact(preview.content)), truncated: preview.truncated } satisfies RedactedPreview;
  return {
    kind: "fields",
    changes: sortFieldChanges(preview.changes).map((change) => ({
      ...change,
      ...(change.before === undefined ? {} : { before: redactor.redact(change.before) }),
      ...(change.after === undefined ? {} : { after: redactor.redact(change.after) }),
    })),
  };
};

const semanticallyEquivalent = (change: FileChange): boolean => {
  if (change.action === "preserve" || change.action === "skip") return true;
  if (change.beforeDigest !== undefined && change.afterDigest !== undefined && change.beforeDigest === change.afterDigest) return true;
  return change.preview.kind === "fields" && change.preview.changes.length === 0;
};

const normalizeFileChange = (change: FileChange, redactor: SecretRedactor): FileChange => {
  const action = semanticallyEquivalent(change) ? "preserve" : change.action;
  return {
    id: change.id,
    componentId: change.componentId,
    ...(change.origin === undefined ? {} : { origin: text(redactor.redact(change.origin)) }),
    destination: change.destination,
    action,
    reason: text(redactor.redact(change.reason)),
    conflict: change.conflict,
    ...(change.beforeDigest === undefined ? {} : { beforeDigest: change.beforeDigest }),
    ...(change.afterDigest === undefined ? {} : { afterDigest: change.afterDigest }),
    preview: normalizePreview(change.preview, redactor),
    ...(change.incompatibleOverride === undefined ? {} : { incompatibleOverride: change.incompatibleOverride }),
  };
};

const normalizeExternal = (operation: ExternalOperation, redactor: SecretRedactor): ExternalOperation => ({
  id: operation.id,
  componentId: operation.componentId,
  kind: operation.kind,
  command: [...operation.command].map((argument) => text(redactor.redact(argument))),
  origin: text(redactor.redact(operation.origin)),
  destination: operation.destination,
  purpose: text(redactor.redact(operation.purpose)),
  usesNetwork: true,
  expectedFiles: [...operation.expectedFiles]
    .map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path)),
});

export interface PlannerOptions {
  readonly redactor?: SecretRedactor;
}

/** Builds a stable, approval-ready plan from already inspected operations. */
export class DeterministicChangePlanner {
  private readonly redactor: SecretRedactor;
  public constructor(options: PlannerOptions = {}) {
    this.redactor = options.redactor ?? new SecretRedactor();
  }

  public async build(input: PlanningInput): Promise<Result<ChangePlan, PlanningError>> {
    if (input.root.length === 0 || input.root.includes("\0") || input.runId.length === 0 || input.now.length === 0)
      return invalid("Plan identity and root are required");
    const destinations = new Set<string>();
    const fileChanges: FileChange[] = [];
    for (const original of input.fileChanges) {
      const checked = asProjectRelativePath(original.destination);
      if (!checked.ok || !isSafeRelativePath(original.destination)) return destinationError(original.destination);
      if (destinations.has(checked.value))
        return invalid("A plan cannot contain more than one file action for a destination", checked.value);
      destinations.add(checked.value);
      fileChanges.push(
        normalizeFileChange({ ...original, destination: checked.value as unknown as FileChange["destination"] }, this.redactor),
      );
    }
    const operationIds = new Set<string>();
    const externalOperations: ExternalOperation[] = [];
    for (const original of input.externalOperations) {
      if (
        operationIds.has(original.id) ||
        original.id.length === 0 ||
        original.command.length === 0 ||
        original.command.some((argument) => argument.includes("\0"))
      )
        return invalid("External operation identities and commands must be unique and safe", original.id);
      operationIds.add(original.id);
      const destination = asProjectRelativePath(original.destination);
      if (!destination.ok || !isSafeRelativePath(original.destination)) return destinationError(original.destination);
      for (const expected of original.expectedFiles) {
        if (!isSafeRelativePath(expected.path) || expected.path.includes("\0")) return destinationError(expected.path);
      }
      externalOperations.push(
        normalizeExternal({ ...original, destination: destination.value as unknown as ExternalOperation["destination"] }, this.redactor),
      );
    }
    fileChanges.sort(
      (left, right) =>
        left.destination.localeCompare(right.destination) ||
        actionOrder[left.action] - actionOrder[right.action] ||
        conflictOrder[left.conflict] - conflictOrder[right.conflict] ||
        left.id.localeCompare(right.id),
    );
    externalOperations.sort(
      (left, right) =>
        left.destination.localeCompare(right.destination) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
    );
    const warnings = [...input.fileChanges]
      .filter((change) => change.action === "skip")
      .map((change) => ({ code: "SKIPPED_CHANGE", message: `Change ${change.id} is skipped`, componentId: change.componentId }))
      .sort((left, right) => `${left.code}:${left.message}`.localeCompare(`${right.code}:${right.message}`));
    const unsigned: Omit<ChangePlan, "planHash"> = {
      schemaVersion: 1,
      runId: input.runId,
      root: input.root,
      mode: input.mode,
      ...(input.catalogDigest === undefined ? {} : { catalogDigest: input.catalogDigest }),
      ...(input.catalogSourceRevision === undefined ? {} : { catalogSourceRevision: input.catalogSourceRevision }),
      confirmedStackDigest: input.stack.digest,
      createdAt: input.now,
      fileChanges,
      externalOperations,
      warnings,
    };
    const plan = { ...unsigned, planHash: calculatePlanHash(unsigned) } satisfies ChangePlan;
    return ok(plan);
  }
}

export const ChangePlannerImplementation = DeterministicChangePlanner;
export const createChangePlanner = (options: PlannerOptions = {}): DeterministicChangePlanner => new DeterministicChangePlanner(options);
