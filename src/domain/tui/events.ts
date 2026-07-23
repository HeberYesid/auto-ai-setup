import type { OperationId, Sha256 } from "../shared/types.js";
import type { TerminalCapabilities } from "./capabilities.js";
import type { TuiResult } from "./errors.js";
import type { ProgressInput } from "./progress.js";
import type { Stage } from "./session.js";
import type { NonNegativeInteger } from "./values.js";

/**
 * Closed set of application actions a control may trigger. Modeling actions as a
 * literal union prevents arbitrary command strings from reaching the reducer.
 */
export type RegisteredAction =
  | "advance"
  | "back"
  | "select-choice"
  | "toggle-option"
  | "edit-input"
  | "confirm"
  | "cancel"
  | "confirm-cancel"
  | "resume"
  | "approve-plan"
  | "reject-plan"
  | "toggle-help"
  | "retry"
  | "correct"
  | "rollback"
  | "finish";

/** A control action identifier, closed over {@link RegisteredAction}. */
export type ActionId = RegisteredAction;

/** Normalized non-printable keys. Raw escape sequences never reach the domain. */
export type NormalizedKey =
  "Tab" | "ShiftTab" | "Enter" | "Space" | "Question" | "Escape" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/** A normalized keystroke: either a named control key or printable text. */
export type KeyStroke = { readonly kind: "named"; readonly name: NormalizedKey } | { readonly kind: "printable"; readonly text: string };

/** Outcome of an allowlisted external (autoskills) operation. */
export interface ExternalOutcome {
  readonly operationId: OperationId;
  readonly status: "completed" | "failed";
}

/** A normalized keyboard event. */
export interface KeyEvent {
  readonly kind: "key";
  readonly key: KeyStroke;
}

/** An optional mouse activation event, available only when the terminal supports mouse input. */
export interface MouseEvent {
  readonly kind: "mouse";
  readonly action: "activate";
  readonly controlId: string;
}

/** A resize event carrying a freshly detected capability snapshot. */
export interface ResizeEvent {
  readonly kind: "resize";
  readonly capabilities: TerminalCapabilities;
}

/** An activity update event carrying a raw progress input to be validated. */
export interface ActivityEvent {
  readonly kind: "activity";
  readonly progress: ProgressInput;
}

/** The typed result of a completed external operation, normalized back into the loop. */
export interface ExternalResultEvent {
  readonly kind: "external-result";
  readonly operationId: OperationId;
  readonly result: TuiResult<ExternalOutcome>;
}

/** A virtual-clock tick used for the one-second activity threshold and timing observations. */
export interface TimerEvent {
  readonly kind: "timer";
  readonly tick: NonNegativeInteger;
}

/** All normalized inputs the interactive session reducer can consume. */
export type UiEvent = KeyEvent | MouseEvent | ResizeEvent | ActivityEvent | ExternalResultEvent | TimerEvent;

/** Why the interactive session is exiting; maps to existing CLI exit semantics. */
export type ExitReason = "completed" | "cancelled" | "failed" | "invalid-input";

/**
 * A command returned by the reducer for the coordinator to execute through injected
 * ports. Commands are separate from rendering so key handling can never mutate the
 * project directly.
 */
export type UiCommand =
  | { readonly kind: "none" }
  | { readonly kind: "run-stage"; readonly stage: Stage }
  | { readonly kind: "apply-approved-plan"; readonly hash: Sha256 }
  | { readonly kind: "recover"; readonly controlId: string }
  | { readonly kind: "exit"; readonly reason: ExitReason };

/** The no-op command, exposed as a constant for reuse by reducers. */
export const noCommand: UiCommand = { kind: "none" };
