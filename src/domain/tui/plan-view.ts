import type { Redactor } from "../shared/ports.js";
import { SecretRedactor } from "../security/redaction.js";
import type { ChangePlan, ExternalOperation, FileChange } from "../planning/models.js";
import { calculatePlanHash } from "../planning/planner.js";
import { isAllowedAutoSkillsOperation } from "../security/product-policy.js";
import { err, ok } from "../shared/types.js";
import { tuiError, type TuiResult } from "./errors.js";
import type { Sha256 } from "../shared/types.js";

/** Placeholder text used for any plan field without an applicable value. */
export const NOT_APPLICABLE = "no aplicable";

/** A redacted, semantic before/after description of a content modification. */
export interface SemanticChangeView {
  readonly before: string;
  readonly after: string;
}

/** A policy-allowed external operation, with its command, arguments, and network use. */
export interface ExternalOperationView {
  readonly command: string;
  readonly args: readonly string[];
  readonly purpose: string;
  readonly networkUse: string;
}

/**
 * A single plan operation projected for review. String fields are redacted and use
 * {@link NOT_APPLICABLE} for absent values.
 */
export interface PlanOperationView {
  readonly operationId: string;
  readonly action: string;
  readonly destination: string;
  readonly source: string;
  readonly reason: string;
  readonly conflict: string;
  readonly semanticChange: SemanticChangeView | undefined;
  readonly external: ExternalOperationView | undefined;
}

/**
 * The redacted plan projection presented for review. Operations remain in canonical
 * order, the displayed hash is included, and approval defaults to rejection.
 */
export interface PlanViewModel {
  readonly operations: readonly PlanOperationView[];
  readonly planHash: Sha256;
  readonly approvalDefault: "reject";
}

export interface PlanViewProjectionOptions {
  readonly knownSecrets?: readonly string[];
  readonly redactor?: Redactor;
}

const actionOrder: Readonly<Record<FileChange["action"], number>> = { create: 0, modify: 1, preserve: 2, skip: 3 };
const conflictOrder: Readonly<Record<FileChange["conflict"], number>> = {
  none: 0,
  "content-differs": 1,
  "invalid-managed-markers": 2,
  "ownership-unknown": 3,
};

const fileChangeOrder = (left: FileChange, right: FileChange): number =>
  left.destination.localeCompare(right.destination) ||
  actionOrder[left.action] - actionOrder[right.action] ||
  conflictOrder[left.conflict] - conflictOrder[right.conflict] ||
  left.id.localeCompare(right.id);

const externalOperationOrder = (left: ExternalOperation, right: ExternalOperation): number =>
  left.destination.localeCompare(right.destination) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);

const stableValue = (value: unknown, seen = new WeakSet<object>()): string => {
  if (value === undefined) return NOT_APPLICABLE;
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  if (typeof value !== "object") return NOT_APPLICABLE;
  if (seen.has(value)) return NOT_APPLICABLE;
  seen.add(value);
  if (Array.isArray(value)) {
    const result = `[${value.map((entry) => stableValue(entry, seen)).join(", ")}]`;
    seen.delete(value);
    return result;
  }
  const result = `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableValue(entry, seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return result;
};

const redactionFailure = (location: string, cause: unknown): TuiResult<never> =>
  err(
    tuiError("REDACTION_INCOMPLETE", `Unable to redact plan value at ${location}`, {
      location,
      cause: cause instanceof Error ? cause.message : String(cause),
      suggestedAction: "Do not emit the plan; inspect the redaction configuration",
    }),
  );

const redact = (value: unknown, location: string, options: Required<PlanViewProjectionOptions>): TuiResult<string> => {
  try {
    const redacted = options.redactor.redact(value, options.knownSecrets);
    const text = stableValue(redacted);
    const leaked = options.knownSecrets.find((secret) => secret.length > 0 && text.includes(secret));
    return leaked === undefined ? ok(text) : redactionFailure(location, `Known sensitive literal returned unredacted: ${leaked}`);
  } catch (cause: unknown) {
    return redactionFailure(location, cause);
  }
};

const redactRequired = (value: unknown, location: string, options: Required<PlanViewProjectionOptions>): TuiResult<string> => {
  const result = redact(value, location, options);
  if (!result.ok) return result;
  return result.value.length === 0 || result.value === NOT_APPLICABLE
    ? redactionFailure(location, "Required plan value is absent")
    : result;
};

const redactOptional = (value: unknown, location: string, options: Required<PlanViewProjectionOptions>): TuiResult<string> =>
  value === undefined ? ok(NOT_APPLICABLE) : redact(value, location, options);

const semanticChange = (
  change: FileChange,
  index: number,
  options: Required<PlanViewProjectionOptions>,
): TuiResult<SemanticChangeView | undefined> => {
  if (change.action !== "modify") return ok(undefined);
  if (change.preview.kind === "text") {
    const after = redactRequired(change.preview.content, `fileChanges[${index}].preview.content`, options);
    if (!after.ok) return after;
    const before =
      change.beforeDigest === undefined ? ok(NOT_APPLICABLE) : redact(change.beforeDigest, `fileChanges[${index}].beforeDigest`, options);
    if (!before.ok) return before;
    return ok({ before: before.value, after: after.value });
  }

  const before: string[] = [];
  const after: string[] = [];
  const changes = [...change.preview.changes].map((field, fieldIndex) => ({ field, fieldIndex }));
  changes.sort(
    (left, right) =>
      `${left.field.path}:${left.field.action}`.localeCompare(`${right.field.path}:${right.field.action}`) ||
      left.fieldIndex - right.fieldIndex,
  );
  for (const { field, fieldIndex } of changes) {
    const path = redactRequired(field.path, `fileChanges[${index}].preview.changes[${fieldIndex}].path`, options);
    if (!path.ok) return path;
    const beforeValue = redactOptional(field.before, `fileChanges[${index}].preview.changes[${fieldIndex}].before`, options);
    if (!beforeValue.ok) return beforeValue;
    const afterValue = redactOptional(field.after, `fileChanges[${index}].preview.changes[${fieldIndex}].after`, options);
    if (!afterValue.ok) return afterValue;
    before.push(`${path.value}: ${beforeValue.value}`);
    after.push(`${path.value}: ${afterValue.value}`);
  }
  return ok({
    before: before.length === 0 ? NOT_APPLICABLE : before.join("; "),
    after: after.length === 0 ? NOT_APPLICABLE : after.join("; "),
  });
};

const projectFileChange = (
  change: FileChange,
  index: number,
  options: Required<PlanViewProjectionOptions>,
): TuiResult<PlanOperationView> => {
  const operationId = redactRequired(change.id, `fileChanges[${index}].id`, options);
  if (!operationId.ok) return operationId;
  const destination = redactRequired(change.destination, `fileChanges[${index}].destination`, options);
  if (!destination.ok) return destination;
  const source = redactOptional(change.origin, `fileChanges[${index}].origin`, options);
  if (!source.ok) return source;
  const reason = redactRequired(change.reason, `fileChanges[${index}].reason`, options);
  if (!reason.ok) return reason;
  const semantic = semanticChange(change, index, options);
  if (!semantic.ok) return semantic;
  return ok({
    operationId: operationId.value,
    action: change.action,
    destination: destination.value,
    source: source.value,
    reason: reason.value,
    conflict: change.conflict,
    semanticChange: semantic.value,
    external: undefined,
  });
};

const isPolicyAllowedExternalOperation = (operation: ExternalOperation): boolean => isAllowedAutoSkillsOperation(operation);

const projectExternalOperation = (
  operation: ExternalOperation,
  index: number,
  options: Required<PlanViewProjectionOptions>,
): TuiResult<PlanOperationView> => {
  const operationId = redactRequired(operation.id, `externalOperations[${index}].id`, options);
  if (!operationId.ok) return operationId;
  const command: string[] = [];
  for (const [argumentIndex, argument] of operation.command.entries()) {
    const projected = redactRequired(argument, `externalOperations[${index}].command[${argumentIndex}]`, options);
    if (!projected.ok) return projected;
    command.push(projected.value);
  }
  const source = redactRequired(operation.origin, `externalOperations[${index}].origin`, options);
  if (!source.ok) return source;
  const destination = redactRequired(operation.destination, `externalOperations[${index}].destination`, options);
  if (!destination.ok) return destination;
  const purpose = redactRequired(operation.purpose, `externalOperations[${index}].purpose`, options);
  if (!purpose.ok) return purpose;
  return ok({
    operationId: operationId.value,
    action: "external",
    destination: destination.value,
    source: source.value,
    reason: purpose.value,
    conflict: NOT_APPLICABLE,
    semanticChange: undefined,
    external: {
      command: command[0] ?? NOT_APPLICABLE,
      args: command.slice(1),
      purpose: purpose.value,
      networkUse: "red aprobada",
    },
  });
};

const defaults = (options: PlanViewProjectionOptions): Required<PlanViewProjectionOptions> => ({
  knownSecrets: options.knownSecrets ?? [],
  redactor: options.redactor ?? new SecretRedactor(),
});

const freezeDeep = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen);
    Object.freeze(value);
  }
  return value;
};

/**
 * Projects a ChangePlan for review using the planner's canonical serialization and
 * SHA-256 implementation. The returned model is redacted and deeply immutable.
 * External operations are admitted only when they match the registered autoskills
 * operation shape; unsupported operations are omitted rather than displayed.
 */
export const projectCanonicalPlan = (plan: ChangePlan, options: PlanViewProjectionOptions = {}): TuiResult<PlanViewModel> => {
  const resolved = defaults(options);
  const operations: PlanOperationView[] = [];
  const fileChanges = [...plan.fileChanges].sort(fileChangeOrder);
  for (const [index, change] of fileChanges.entries()) {
    const projected = projectFileChange(change, index, resolved);
    if (!projected.ok) return projected;
    operations.push(projected.value);
  }
  const externalOperations = [...plan.externalOperations].filter(isPolicyAllowedExternalOperation).sort(externalOperationOrder);
  for (const [index, operation] of externalOperations.entries()) {
    const projected = projectExternalOperation(operation, index, resolved);
    if (!projected.ok) return projected;
    operations.push(projected.value);
  }
  return ok(freezeDeep({ operations, planHash: calculatePlanHash(plan), approvalDefault: "reject" }));
};

/** Compatibility aliases for callers that name the projection after its view model. */
export const projectPlanView = projectCanonicalPlan;
export const buildPlanViewModel = projectCanonicalPlan;
