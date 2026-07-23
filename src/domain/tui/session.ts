import type { ExecutionSummary } from "../observability/models.js";
import type { ChangePlan } from "../planning/models.js";
import type { Sha256 } from "../shared/types.js";
import type { RenderProfile } from "./capabilities.js";
import type { ActionId } from "./events.js";
import type { ProgressModel } from "./progress.js";
import type { RecoveryState } from "./recovery.js";
import type { NonNegativeInteger } from "./values.js";

/** The named stages of an interactive session. */
export type Stage = "inspect" | "select" | "review" | "approve" | "apply" | "recover" | "summary" | "cancelled" | "failed";

/** The kinds of interactive controls a view may present. */
export type ControlKind = "button" | "choice" | "multiselect" | "text-input" | "link-like";

/** Vertical bounds of a control within the ordered layout, used for scroll computation. */
export interface ControlBounds {
  readonly top: NonNegativeInteger;
  readonly bottom: NonNegativeInteger;
}

/** A single interactive control. `action` is closed over {@link ActionId}. */
export interface Control {
  readonly id: string;
  readonly kind: ControlKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly action: ActionId;
  readonly bounds: ControlBounds;
}

/** The stored focus for a view. `controlId` is absent when no control is focused. */
export interface FocusState {
  readonly viewId: string;
  readonly controlId: string | undefined;
}

/** A confirmed user selection for a control, discriminated by control kind. */
export type SelectionValue =
  | { readonly kind: "choice"; readonly optionId: string }
  | { readonly kind: "multiselect"; readonly optionIds: readonly string[] }
  | { readonly kind: "text"; readonly value: string };

/** A confirmed selection scoped to a view and control. */
export interface Selection {
  readonly viewId: string;
  readonly controlId: string;
  readonly value: SelectionValue;
}

/** A single violated validation rule for an editable control. */
export interface ValidationError {
  readonly controlId: string;
  readonly rule: string;
  readonly message: string;
}

/** Aggregate validation status: pending gating and the current violated rules. */
export interface ValidationState {
  readonly pending: boolean;
  readonly errors: readonly ValidationError[];
}

/**
 * A classified failure surfaced within a session. Carries the stage, operation,
 * and an already-redacted human-readable cause required by failure presentation.
 */
export interface SessionError {
  readonly stage: Stage;
  readonly operation: string;
  readonly cause: string;
}

/** The current in-progress activity, retaining the last valid progress representation. */
export interface ActivityState {
  readonly stage: Stage;
  readonly description: string;
  readonly progress: ProgressModel | undefined;
  readonly lastValidProgress: ProgressModel | undefined;
}

/** The user's approval decision, bound to the plan hash it was made against. */
export type ApprovalDecision = "none" | "approved" | "rejected" | "conflicted";

/** Approval state; the bound `hash` is absent until a decision references a plan. */
export interface ApprovalState {
  readonly decision: ApprovalDecision;
  readonly hash: Sha256 | undefined;
}

/**
 * The complete, immutable interactive session state. The reducer treats transitions
 * as values, stores the last valid state for invalid events, and never mutates the
 * project from within a state transition.
 */
export interface SessionState {
  readonly stage: Stage;
  readonly selections: readonly Selection[];
  readonly focusByView: ReadonlyMap<string, FocusState>;
  readonly plan: ChangePlan | undefined;
  readonly displayedPlanHash: Sha256 | undefined;
  readonly approval: ApprovalState;
  readonly result: ExecutionSummary | undefined;
  readonly scrollTop: NonNegativeInteger;
  readonly unconfirmedInputs: ReadonlyMap<string, string>;
  readonly validation: ValidationState;
  readonly presentation: RenderProfile;
  readonly activity: ActivityState | undefined;
  readonly errors: readonly SessionError[];
  readonly warnings: readonly string[];
  readonly recovery: RecoveryState | undefined;
  readonly cancelled: boolean;
  readonly finalized: boolean;
}
