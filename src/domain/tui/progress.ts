import { err, ok, type Result } from "../shared/types.js";
import { tuiError, type TuiError, type TuiResult } from "./errors.js";
import type { Stage } from "./session.js";
import { asNonNegativeInteger, type NonNegativeInteger } from "./values.js";

/** A single invariant violated by a determined progress update. */
export type ProgressViolationRule =
  | "completed-integer"
  | "completed-non-negative"
  | "total-integer"
  | "total-non-negative"
  | "completed-monotonic"
  | "completed-not-over-total";

/** A visible, classified explanation for one rejected progress invariant. */
export interface ProgressViolation {
  readonly rule: ProgressViolationRule;
  readonly message: string;
}

/** A validated progress representation. */
export type ProgressModel =
  | {
      readonly kind: "determined";
      readonly description: string;
      readonly completed: NonNegativeInteger;
      readonly total: NonNegativeInteger;
      readonly percent: NonNegativeInteger;
    }
  | {
      readonly kind: "indeterminate";
      readonly description: string;
    };

/** A raw, not-yet-validated progress update received from an activity source. */
export type ProgressInput =
  | { readonly kind: "determined"; readonly description: string; readonly completed: number; readonly total: number }
  | { readonly kind: "indeterminate"; readonly description: string };

/** A typed invalid-progress error carrying every violated rule, not just the first one. */
export interface ProgressValidationError extends TuiError {
  readonly code: "INVALID_PROGRESS";
  readonly violations: readonly ProgressViolation[];
}

/** Result of applying one update while retaining the last accepted representation on failure. */
export interface ProgressUpdate {
  readonly accepted: boolean;
  readonly model: ProgressModel | undefined;
  readonly lastValid: ProgressModel | undefined;
  readonly violations: readonly ProgressViolation[];
}

/** A pure activity state used by the reducer and by deterministic presenter tests. */
export interface ActivityProgressState {
  readonly stage: Stage;
  readonly description: string;
  readonly progress: ProgressModel | undefined;
  readonly lastValidProgress: ProgressModel | undefined;
  readonly violations: readonly ProgressViolation[];
  /** Monotonic timestamp at which the activity began. */
  readonly startedAtMs: number;
  /** Set by a timer observation once the one-second threshold is reached. */
  readonly persistent: boolean;
}

const violation = (rule: ProgressViolationRule, message: string): ProgressViolation => ({ rule, message });

const validateCount = (name: "completed" | "total", value: number, violations: ProgressViolation[]): void => {
  if (!Number.isInteger(value)) {
    violations.push(violation(`${name}-integer`, `${name} must be an integer`));
  }
  if (value < 0) {
    violations.push(violation(`${name}-non-negative`, `${name} must be non-negative`));
  }
};

/** Calculate the required integer percentage, including the explicit 0/0 rule. */
export const progressPercent = (completed: number, total: number): NonNegativeInteger => {
  const percent = total === 0 ? 0 : Math.floor((completed * 100) / total);
  return percent as NonNegativeInteger;
};

/**
 * Validate and build a progress model. `previous` is used only to enforce monotonic
 * completion for consecutive determined updates; indeterminate progress has no counts.
 */
export const validateProgress = (
  input: ProgressInput,
  previous: ProgressModel | undefined = undefined,
): TuiResult<ProgressModel> => {
  if (input.kind === "indeterminate") {
    return ok({ kind: "indeterminate", description: input.description });
  }

  const violations: ProgressViolation[] = [];
  validateCount("completed", input.completed, violations);
  validateCount("total", input.total, violations);

  if (Number.isInteger(input.completed) && Number.isInteger(previous?.kind === "determined" ? previous.completed : undefined)) {
    if (input.completed < (previous as Extract<ProgressModel, { kind: "determined" }>).completed) {
      violations.push(violation("completed-monotonic", "completed must not decrease"));
    }
  }
  if (Number.isInteger(input.completed) && Number.isInteger(input.total) && input.completed > input.total) {
    violations.push(violation("completed-not-over-total", "completed must not exceed total"));
  }

  if (violations.length > 0) {
    const details = violations.map((item) => item.message).join("; ");
    return err({
      ...tuiError("INVALID_PROGRESS", `Invalid determined progress: ${details}`),
      violations,
    } satisfies ProgressValidationError);
  }

  const completed = asNonNegativeInteger(input.completed);
  const total = asNonNegativeInteger(input.total);
  if (!completed.ok || !total.ok) {
    // This is defensive: the rules above guarantee these conversions succeed.
    return err({
      ...tuiError("INVALID_PROGRESS", "Determined progress counts must be non-negative integers"),
      violations: [violation("completed-non-negative", "determined progress counts must be non-negative integers")],
    } satisfies ProgressValidationError);
  }

  return ok({
    kind: "determined",
    description: input.description,
    completed: completed.value,
    total: total.value,
    percent: progressPercent(input.completed, input.total),
  });
};

/** Apply an update without ever replacing the last valid model after a rejection. */
export const applyProgressUpdate = (
  lastValid: ProgressModel | undefined,
  input: ProgressInput,
): ProgressUpdate => {
  const result = validateProgress(input, lastValid);
  if (result.ok) {
    return { accepted: true, model: result.value, lastValid: result.value, violations: [] };
  }
  const error = result.error as ProgressValidationError;
  return { accepted: false, model: lastValid, lastValid, violations: error.violations };
};

/** Start activity with an injected monotonic timestamp; no timer or sleep is used. */
export const startActivity = (stage: Stage, description: string, startedAtMs = 0): ActivityProgressState => ({
  stage,
  description,
  progress: undefined,
  lastValidProgress: undefined,
  violations: [],
  startedAtMs,
  persistent: false,
});

/** Return whether the activity has reached the inclusive one-second threshold. */
export const activityIsPersistent = (activity: Pick<ActivityProgressState, "startedAtMs">, nowMs: number): boolean =>
  Number.isFinite(nowMs) && nowMs >= activity.startedAtMs + 1000;

/** Mark the activity persistent only when an injected time observation reaches one second. */
export const observeActivity = <T extends ActivityProgressState>(activity: T, nowMs: number): T =>
  activity.persistent || !activityIsPersistent(activity, nowMs) ? activity : { ...activity, persistent: true };

/** Apply progress to activity while preserving the previous valid model after invalid input. */
export const updateActivityProgress = <T extends ActivityProgressState>(activity: T, input: ProgressInput): T => {
  const update = applyProgressUpdate(activity.lastValidProgress, input);
  return {
    ...activity,
    progress: update.model,
    lastValidProgress: update.lastValid,
    violations: update.violations,
  };
};

/** Human-readable persistent activity text for a view model; absent before one second. */
export const persistentActivityText = (activity: ActivityProgressState, nowMs: number): string | undefined =>
  activityIsPersistent(activity, nowMs) ? activity.description : undefined;
