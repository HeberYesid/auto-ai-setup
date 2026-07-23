import type { ExitCode, ProjectRelativePath } from "../shared/types.js";
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
