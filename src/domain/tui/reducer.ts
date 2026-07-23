import type { RenderProfile } from "./capabilities.js";
import { coordinateApproval } from "./approval.js";
import {
  noCommand,
  type ExternalResultEvent,
  type KeyStroke,
  type MouseEvent,
  type RegisteredAction,
  type UiCommand,
  type UiEvent,
} from "./events.js";
import { startActivity } from "./progress.js";
import {
  computeScrollTop,
  focusedControl as resolveFocusedControl,
  gateAdvanceControls,
  isAdvanceBlocked,
  moveFocus,
  revalidateInputs,
  restoreFocus,
  updateInputValidation,
  type ValidationRules,
} from "./navigation.js";
import type { Control, SelectionValue, SessionError, SessionState, Stage } from "./session.js";
import type { NonNegativeInteger } from "./values.js";

/**
 * The immutable result of reducing a single {@link UiEvent}. State transitions are
 * kept strictly separate from the returned application {@link UiCommand}: a reducer
 * never writes output or mutates the project, and it emits at most one command per
 * event. Invalid events return the exact prior state and {@link noCommand}.
 */
export interface ReductionResult {
  readonly state: SessionState;
  readonly command: UiCommand;
}

/**
 * Read-only context supplied to the reducer for the current view. Controls are the
 * visible/enabled controls derived for the active stage. Deriving this ordered list
 * (documented order, focus restoration/fallback) is owned by subtask 3.2; the core
 * reducer only resolves the focused/target control to activate it exactly once.
 */
export interface SessionReducerContext {
  readonly controls: readonly Control[];
  /** Number of visible rows used to keep the focused control fully in view. */
  readonly viewportRows?: number;
  /** Rules for the currently editable controls, keyed by control id. */
  readonly validationRules?: ValidationRules;
  /** Current monotonic time supplied by the application clock when an action starts work. */
  readonly nowMs?: number;
}

/**
 * The canonical linear stage flow used to compute forward/backward navigation. The
 * terminal stages `recover`, `cancelled`, and `failed` are reached through explicit
 * commands and events rather than linear navigation, so they are excluded here.
 */
const MAIN_FLOW: readonly Stage[] = ["inspect", "select", "review", "approve", "apply", "summary"];

/**
 * Actions that remain permitted while application work is pending. Requirement 8.7:
 * background work locks task inputs and results, permitting only registered status
 * (activity/timer events), help, and cancellation actions.
 */
const PENDING_PERMITTED_ACTIONS: ReadonlySet<RegisteredAction> = new Set<RegisteredAction>([
  "toggle-help",
  "cancel",
  "confirm-cancel",
  "resume",
]);

/** The frozen no-op command result, reused so invalid events return a stable value. */
const withCommand = (state: SessionState, command: UiCommand): ReductionResult => ({ state, command });

/** Return the exact prior state with no command, for invalid or deferred events. */
const unchanged = (state: SessionState): ReductionResult => ({ state, command: noCommand });

/** Update only the state, emitting no command (a pure, command-free transition). */
const stateOnly = (state: SessionState): ReductionResult => ({ state, command: noCommand });

/** Map the active stage to its view identifier used to key {@link SessionState.focusByView}. */
export const currentViewId = (state: SessionState): string => state.stage;

/** Application work is pending exactly when an in-progress activity is present. */
export const isPendingWork = (state: SessionState): boolean => state.activity !== undefined;

/** Resolve the stage that follows the given stage in the linear flow, if any. */
export const nextStage = (stage: Stage): Stage | undefined => {
  const index = MAIN_FLOW.indexOf(stage);
  return index >= 0 && index < MAIN_FLOW.length - 1 ? MAIN_FLOW[index + 1] : undefined;
};

/** Resolve the stage that precedes the given stage in the linear flow, if any. */
export const previousStage = (stage: Stage): Stage | undefined => {
  const index = MAIN_FLOW.indexOf(stage);
  return index > 0 ? MAIN_FLOW[index - 1] : undefined;
};

/** Resolve the currently focused control for a view, only when it is visible and enabled. */
const focusedControl = (state: SessionState, viewId: string, controls: readonly Control[]): Control | undefined =>
  resolveFocusedControl(state, viewId, controls);

/** Set a single-choice selection for a control, replacing any prior value for the same control. */
const setChoice = (state: SessionState, viewId: string, control: Control): SessionState => {
  const value: SelectionValue = { kind: "choice", optionId: control.id };
  const others = state.selections.filter((selection) => !(selection.viewId === viewId && selection.controlId === control.id));
  return { ...state, selections: [...others, { viewId, controlId: control.id, value }] };
};

/** Toggle a multiselect option's membership exactly once for the focused control. */
const toggleOption = (state: SessionState, viewId: string, control: Control): SessionState => {
  const existing = state.selections.findIndex((selection) => selection.viewId === viewId && selection.controlId === control.id);
  if (existing >= 0) {
    return { ...state, selections: state.selections.filter((_, index) => index !== existing) };
  }
  const value: SelectionValue = { kind: "multiselect", optionIds: [control.id] };
  return { ...state, selections: [...state.selections, { viewId, controlId: control.id, value }] };
};

/** Build a pending activity marker with an injected monotonic start time. */
const pendingActivity = (stage: Stage, description: string, startedAtMs = 0): SessionState["activity"] =>
  startActivity(stage, description, startedAtMs);

/**
 * Apply a single registered action to the session state. Command execution is
 * modelled separately from rendering, so an action either produces a pure state
 * transition or a single application command. While work is pending, only the
 * registered status, help, and cancellation actions are honored (Requirement 8.7);
 * every other action returns the exact prior state.
 */
const dispatchAction = (
  state: SessionState,
  action: RegisteredAction,
  control: Control | undefined,
  viewId: string,
  pending: boolean,
  startedAtMs = 0,
): ReductionResult => {
  if (pending && !PENDING_PERMITTED_ACTIONS.has(action)) {
    return unchanged(state);
  }
  if (isAdvanceBlocked(action, state.validation)) {
    return unchanged(state);
  }

  switch (action) {
    case "toggle-help":
      return stateOnly({ ...state, helpVisible: !state.helpVisible });

    case "cancel":
      return stateOnly({ ...state, cancellationPending: true });

    case "resume":
      return stateOnly({ ...state, cancellationPending: false });

    case "confirm-cancel":
      return withCommand({ ...state, cancelled: true, finalized: true, cancellationPending: false }, { kind: "exit", reason: "cancelled" });

    case "finish":
      return withCommand({ ...state, finalized: true }, { kind: "exit", reason: state.errors.length > 0 ? "failed" : "completed" });

    case "select-choice":
      return control === undefined ? unchanged(state) : stateOnly(setChoice(state, viewId, control));

    case "toggle-option":
      return control === undefined ? unchanged(state) : stateOnly(toggleOption(state, viewId, control));

    case "advance":
    case "confirm": {
      const next = nextStage(state.stage);
      if (next === undefined || control === undefined) return unchanged(state);
      return withCommand({ ...state, activity: pendingActivity(next, control.label, startedAtMs) }, { kind: "run-stage", stage: next });
    }

    case "back": {
      const previous = previousStage(state.stage);
      return previous === undefined ? unchanged(state) : stateOnly({ ...state, stage: previous });
    }

    case "approve-plan": {
      const hash = state.displayedPlanHash;
      if (hash === undefined || control === undefined) return unchanged(state);
      const outcome = coordinateApproval(state.plan, { displayedHash: hash, decisions: ["approve"] });
      const nextState: SessionState = {
        ...state,
        approval: outcome.state,
        errors:
          outcome.error === undefined
            ? state.errors
            : [...state.errors, { stage: state.stage, operation: "approval", cause: outcome.error.message }],
      };
      if (outcome.status !== "approved") return stateOnly(nextState);
      return withCommand(
        { ...nextState, activity: pendingActivity("apply", control.label, startedAtMs) },
        outcome.command,
      );
    }

    case "reject-plan": {
      const hash = state.displayedPlanHash;
      if (hash === undefined) return unchanged(state);
      const outcome = coordinateApproval(state.plan, { displayedHash: hash, decisions: ["reject"] });
      return stateOnly({
        ...state,
        approval: outcome.state,
        errors:
          outcome.error === undefined
            ? state.errors
            : [...state.errors, { stage: state.stage, operation: "approval", cause: outcome.error.message }],
      });
    }

    case "retry":
    case "correct":
    case "rollback": {
      if (control === undefined) return unchanged(state);
      return withCommand({ ...state, activity: pendingActivity("recover", control.label) }, { kind: "recover", controlId: control.id });
    }

    case "edit-input":
      // Text editing and validation transitions are owned by subtask 3.2; the action
      // is recognized here but produces no state change or command in the core reducer.
      return unchanged(state);
  }
};

const navigationControls = (state: SessionState, context: SessionReducerContext): readonly Control[] =>
  gateAdvanceControls(context.controls, state.validation);

const applyNavigation = (
  state: SessionState,
  context: SessionReducerContext,
  direction: "forward" | "backward",
): ReductionResult => {
  const viewId = currentViewId(state);
  const controls = navigationControls(state, context);
  const moved = moveFocus(state, viewId, controls, direction);
  const focusId = moved.focusByView.get(viewId)?.controlId;
  const scrollTop =
    context.viewportRows === undefined
      ? moved.scrollTop
      : computeScrollTop(controls, focusId, context.viewportRows, moved.scrollTop);
  const next = scrollTop === moved.scrollTop ? moved : { ...moved, scrollTop };
  return next === state ? unchanged(state) : stateOnly(next);
};

/** Reduce a normalized keystroke into a state transition and optional command. */
const handleKey = (state: SessionState, key: KeyStroke, context: SessionReducerContext, pending: boolean): ReductionResult => {
  const viewId = currentViewId(state);
  const controls = navigationControls(state, context);
  if (key.kind === "printable") {
    const control = focusedControl(state, viewId, controls);
    if (control === undefined || control.kind !== "text-input") return unchanged(state);
    const current = state.unconfirmedInputs.get(control.id) ?? "";
    const rules = context.validationRules?.get(control.id) ?? [];
    return stateOnly(updateInputValidation(state, control.id, current + key.text, rules, false));
  }
  switch (key.name) {
    case "Question":
      return dispatchAction(state, "toggle-help", undefined, viewId, pending);

    case "Escape":
      return dispatchAction(state, "cancel", undefined, viewId, pending);

    case "Enter": {
      const control = focusedControl(state, viewId, controls);
      return control === undefined ? unchanged(state) : dispatchAction(state, control.action, control, viewId, pending);
    }

    case "Space": {
      const control = focusedControl(state, viewId, controls);
      if (control === undefined || control.kind !== "multiselect") return unchanged(state);
      return dispatchAction(state, "toggle-option", control, viewId, pending);
    }

    case "Tab":
    case "ArrowDown":
    case "ArrowRight":
      return applyNavigation(state, context, "forward");

    case "ShiftTab":
    case "ArrowUp":
    case "ArrowLeft":
      return applyNavigation(state, context, "backward");
  }
};

/** Reduce an optional mouse activation: focus and activate a control in one event. */
const handleMouse = (state: SessionState, event: MouseEvent, context: SessionReducerContext, pending: boolean): ReductionResult => {
  const controls = navigationControls(state, context);
  const control = controls.find((candidate) => candidate.id === event.controlId && candidate.visible && candidate.enabled);
  if (control === undefined) {
    // Clicking empty space or a disabled/invisible control is ignored, identical to an invalid action.
    return unchanged(state);
  }
  const viewId = currentViewId(state);
  const focusByView = new Map(state.focusByView);
  focusByView.set(viewId, { viewId, controlId: control.id });
  const focusedState = restoreFocus({ ...state, focusByView }, viewId, controls);
  return dispatchAction(focusedState, control.action, control, viewId, pending);
};

/** Normalize a completed external operation back into a state transition. */
const handleExternalResult = (state: SessionState, event: ExternalResultEvent): ReductionResult => {
  const cleared: SessionState = { ...state, activity: undefined };
  if (event.result.ok) {
    return stateOnly(cleared);
  }
  const error: SessionError = { stage: state.stage, operation: String(event.operationId), cause: event.result.error.message };
  return stateOnly({ ...cleared, errors: [...state.errors, error] });
};

const synchronizedValidation = (state: SessionState, rules: ValidationRules | undefined): SessionState => {
  if (rules === undefined) return state;
  const candidate = revalidateInputs(state, rules, state.validation.pending);
  const same =
    candidate.validation.pending === state.validation.pending &&
    candidate.validation.errors.length === state.validation.errors.length &&
    candidate.validation.errors.every(
      (error, index) =>
        error.controlId === state.validation.errors[index]?.controlId &&
        error.rule === state.validation.errors[index]?.rule &&
        error.message === state.validation.errors[index]?.message,
    );
  return same ? state : candidate;
};

/**
 * The pure `InteractiveSession` reducer. It consumes one normalized {@link UiEvent}
 * and returns the next {@link SessionState} plus at most one application command.
 *
 * Guarantees:
 * - One event maps to at most one action: Enter activates the focused control once,
 *   Space toggles one multiselect option once (Requirements 2.5, 2.6).
 * - Invalid or non-applicable events return the exact prior state and no command
 *   (Requirements 2.9, 9.6).
 * - Commands are closed over {@link UiCommand}; arbitrary command strings can never be
 *   produced, and no mutation/process/network command is emitted from an invalid action.
 * - Pending application work locks inputs and results, permitting only registered
 *   status, help, and cancellation actions (Requirement 8.7).
 * - A finalized session is frozen; further events return the prior state.
 * - The function is total and side-effect free, so replaying a sequence of events is
 *   deterministic (Requirement 9.2).
 */
export const reduceSession = (state: SessionState, event: UiEvent, context: SessionReducerContext): ReductionResult => {
  if (state.finalized) {
    return unchanged(state);
  }
  const validatedState = synchronizedValidation(state, context.validationRules);
  const pending = isPendingWork(validatedState);
  switch (event.kind) {
    case "key":
      return handleKey(validatedState, event.key, context, pending);

    case "mouse":
      return handleMouse(validatedState, event, context, pending);

    case "external-result":
      return handleExternalResult(validatedState, event);

    case "activity":
    case "timer":
      // Progress validation and activity retention are owned by subtask 5.1. These
      // events are permitted status updates that the core reducer leaves unchanged.
      return unchanged(validatedState);

    case "resize":
      // Resize and presentation transitions are owned by subtask 3.3.
      return unchanged(validatedState);
  }
};

/**
 * Construct the initial session state for a freshly detected presentation profile.
 * All collections are empty, no plan or approval exists yet, and the session begins
 * at the `inspect` stage with no pending activity, cancellation, or finalization.
 */
export const createInitialSession = (presentation: RenderProfile): SessionState => ({
  stage: "inspect",
  selections: [],
  focusByView: new Map(),
  plan: undefined,
  displayedPlanHash: undefined,
  approval: { decision: "none", hash: undefined },
  result: undefined,
  scrollTop: 0 as NonNegativeInteger,
  unconfirmedInputs: new Map(),
  validation: { pending: false, errors: [] },
  presentation,
  activity: undefined,
  errors: [],
  warnings: [],
  recovery: undefined,
  helpVisible: false,
  cancellationPending: false,
  cancelled: false,
  finalized: false,
});
