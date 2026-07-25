/**
 * Atomic JSON output preparation for the machine-readable mode.
 *
 * The whole value is built, redacted, schema-validated, and serialized in memory before the first
 * byte reaches standard output. No ANSI sequence, frame, animation, or prompt is ever emitted here.
 * If any step fails, stdout receives zero bytes and the caller returns the existing controlled error
 * code, so a partially written or unredacted document can never be observed.
 */

import type { ExecutionSummary } from "../domain/observability/models.js";
import { SecretRedactor } from "../domain/security/redaction.js";
import type { Redactor } from "../domain/shared/ports.js";
import { err, ok, type Result } from "../domain/shared/types.js";
import { tuiError, type TuiError } from "../domain/tui/errors.js";

/** The public JSON shape: the existing execution-summary contract, key-ordered for stability. */
export interface JsonSummaryDocument {
  readonly status: ExecutionSummary["status"];
  readonly exitCode: ExecutionSummary["exitCode"];
  readonly runId: string;
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly manualReviewPaths: readonly string[];
  readonly recovery?: {
    readonly status: string;
    readonly restored: readonly string[];
    readonly manualReviewPaths: readonly string[];
    readonly errors: readonly string[];
  };
}

export interface JsonOutputOptions {
  readonly redactor?: Redactor;
  readonly knownSecrets?: readonly string[];
}

const ANSI_CONTROL_PREFIXES = ["\u001b", "\u009b"] as const;

const containsAnsi = (value: string): boolean => ANSI_CONTROL_PREFIXES.some((prefix) => value.includes(prefix));

const failed = (message: string, cause?: string): Result<never, TuiError> =>
  err(
    tuiError("REDACTION_INCOMPLETE", message, {
      ...(cause === undefined ? {} : { cause }),
      suggestedAction: "No emitir salida JSON; revisar la preparación y la redacción",
    }),
  );

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const VALID_STATUS = new Set<ExecutionSummary["status"]>(["success", "cancelled", "failed-recovered", "incomplete", "invalid-input"]);

/** Validate the redacted document against the existing summary schema. */
const validateDocument = (value: unknown): Result<JsonSummaryDocument, TuiError> => {
  if (value === null || typeof value !== "object") return failed("El documento JSON debe ser un objeto");
  const record = value as Record<string, unknown>;
  if (typeof record.status !== "string" || !VALID_STATUS.has(record.status as ExecutionSummary["status"])) {
    return failed("El estado del resumen no pertenece al contrato existente");
  }
  if (typeof record.exitCode !== "number" || !Number.isInteger(record.exitCode)) return failed("El código de salida debe ser entero");
  if (typeof record.runId !== "string" || record.runId.length === 0) return failed("El identificador de ejecución es obligatorio");
  for (const key of ["applied", "skipped", "warnings", "errors", "manualReviewPaths"] as const) {
    if (!isStringArray(record[key])) return failed(`El campo ${key} debe ser una lista de textos`);
  }
  return ok(record as unknown as JsonSummaryDocument);
};

const document = (summary: ExecutionSummary): JsonSummaryDocument => ({
  status: summary.status,
  exitCode: summary.exitCode,
  runId: String(summary.runId),
  applied: [...summary.applied],
  skipped: [...summary.skipped],
  warnings: [...summary.warnings],
  errors: [...summary.errors],
  manualReviewPaths: [...summary.manualReviewPaths].map(String),
  ...(summary.recovery === undefined
    ? {}
    : {
        recovery: {
          status: summary.recovery.status,
          restored: [...summary.recovery.restored],
          manualReviewPaths: [...summary.recovery.manualReviewPaths].map(String),
          errors: [...summary.recovery.errors],
        },
      }),
});

/**
 * Build the complete serialized JSON value. The returned text is safe to write in one call; any
 * failure returns a typed error and no text at all.
 */
export const prepareJsonSummary = (summary: ExecutionSummary, options: JsonOutputOptions = {}): Result<string, TuiError> => {
  const redactor = options.redactor ?? new SecretRedactor();
  const knownSecrets = options.knownSecrets ?? [];
  let serialized: string;
  try {
    const redacted = redactor.redact(document(summary), knownSecrets);
    const validated = validateDocument(redacted);
    if (!validated.ok) return validated;
    const text = JSON.stringify(validated.value);
    if (text === undefined) return failed("El resumen no se puede serializar como JSON");
    serialized = text;
  } catch (cause: unknown) {
    return failed("No se pudo preparar la salida JSON", cause instanceof Error ? cause.message : String(cause));
  }

  const leaked = knownSecrets.find((secret) => secret.length > 0 && serialized.includes(secret));
  if (leaked !== undefined) return failed("La salida JSON contiene un literal sensible sin redactar");
  if (containsAnsi(serialized)) return failed("La salida JSON no puede contener secuencias ANSI");
  return ok(serialized);
};

/**
 * Prepare and then write the JSON value exactly once. The writer is only invoked after a fully
 * validated, redacted document exists, so a preparation failure writes zero bytes.
 */
export const writeJsonSummary = (
  summary: ExecutionSummary,
  write: (text: string) => void,
  options: JsonOutputOptions = {},
): Result<void, TuiError> => {
  const prepared = prepareJsonSummary(summary, options);
  if (!prepared.ok) return prepared;
  write(`${prepared.value}\n`);
  return ok(undefined);
};
