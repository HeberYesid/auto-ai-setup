import type { ExitCode, ProjectRelativePath } from "../shared/types.js";
import { err, ok } from "../shared/types.js";
import { tuiError, type TuiResult } from "./errors.js";
import type { Stage } from "./session.js";

/** The recovery actions a failed stage may register. */
export type RecoveryActionKind = "retry" | "correct" | "rollback" | "finish";

/** A registered recovery control with its enabled/disabled state. */
export interface RecoveryControl {
  readonly id: string;
  readonly label: string;
  readonly action: RecoveryActionKind;
  readonly enabled: boolean;
}

/** The visible outcome of a recovery attempt after a failure. */
export type RecoveryResultStatus = "not-required" | "completed" | "partial" | "failed";

/**
 * Recovery state after a failure. `unresolvedPaths` are canonical project-relative
 * paths deduplicated so each appears exactly once.
 */
export interface RecoveryState {
  readonly result: RecoveryResultStatus;
  readonly controls: readonly RecoveryControl[];
  readonly unresolvedPaths: readonly ProjectRelativePath[];
}

/** Final execution status presented in the summary. */
export type SummaryStatus = "success" | "cancelled" | "partial" | "failed";

/** A single applied change, described with already-redacted text. */
export interface ChangeSummary {
  readonly operationId: string;
  readonly description: string;
}

/** A human-readable, already-redacted error entry for the summary. */
export interface ReadableError {
  readonly stage: Stage;
  readonly operation: string;
  readonly message: string;
}

/**
 * The final summary view model. All descriptions and messages are already redacted
 * and the model includes the resolved exit code.
 */
export interface SummaryViewModel {
  readonly status: SummaryStatus;
  readonly changes: readonly ChangeSummary[];
  readonly omissions: readonly string[];
  readonly recovery: RecoveryState;
  readonly errors: readonly ReadableError[];
  readonly warnings: readonly string[];
  readonly exitCode: ExitCode;
}
/**
 * Normalize a project-relative recovery path without consulting the filesystem.
 * Recovery paths are expected to come from the transaction boundary, but this
 * runtime validation keeps presentation fail-closed when a malformed value is
 * supplied by an adapter or persisted journal.
 */
export const canonicalizeRecoveryPath = (value: string): TuiResult<ProjectRelativePath> => {
  if (value.length === 0 || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    return err(
      tuiError("INVALID_RECOVERY_PATH", `Recovery path is not project-relative: ${value}`, {
        path: value,
        suggestedAction: "Keep recovery paths canonical and relative to the project root",
      }),
    );
  }

  const parts = value.split("/");
  if (parts.some((part) => part === ".." || /^[A-Za-z]:$/.test(part))) {
    return err(
      tuiError("INVALID_RECOVERY_PATH", `Recovery path contains traversal: ${value}`, {
        path: value,
        suggestedAction: "Resolve the recovery path within the project before presenting it",
      }),
    );
  }

  const canonical = parts.filter((part) => part.length > 0 && part !== ".").join("/");
  if (canonical.length === 0) {
    return err(
      tuiError("INVALID_RECOVERY_PATH", `Recovery path is empty after canonicalization: ${value}`, {
        path: value,
      }),
    );
  }
  return ok(canonical as ProjectRelativePath);
};

/** Canonicalize and deduplicate recovery paths while preserving lexical order. */
export const canonicalizeRecoveryPaths = (paths: readonly string[]): TuiResult<readonly ProjectRelativePath[]> => {
  const canonical = new Set<string>();
  for (const path of paths) {
    const result = canonicalizeRecoveryPath(path);
    if (!result.ok) return result;
    canonical.add(result.value);
  }
  return ok([...canonical].sort((left, right) => left.localeCompare(right)) as ProjectRelativePath[]);
};

/** A recovery result is visible only after an actual recovery attempt completed. */
export const hasVisibleRecoveryResult = (recovery: RecoveryState | undefined): boolean =>
  recovery !== undefined && recovery.result !== "not-required";
