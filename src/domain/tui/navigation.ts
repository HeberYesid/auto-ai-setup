import type { RegisteredAction } from "./events.js";
import type { Control, FocusState, SessionState, ValidationError } from "./session.js";
import type { NonNegativeInteger } from "./values.js";

/** Actions that move the workflow forward and are gated by validation. */
export const ADVANCE_ACTIONS: ReadonlySet<RegisteredAction> = new Set(["advance", "confirm", "approve-plan", "confirm-cancel", "finish"]);

/** A deterministic validation rule for one editable control. */
export interface ValidationRule {
  readonly rule: string;
  readonly message: string;
  readonly validate: (value: string) => boolean;
}

export type ValidationRules = ReadonlyMap<string, readonly ValidationRule[]>;

/** Return controls in documented top-to-bottom order, excluding hidden/disabled controls. */
export const navigableControls = (controls: readonly Control[]): readonly Control[] =>
  controls
    .map((control, index) => ({ control, index }))
    .filter(({ control }) => control.visible && control.enabled)
    .sort(
      (left, right) =>
        left.control.bounds.top - right.control.bounds.top ||
        left.control.bounds.bottom - right.control.bounds.bottom ||
        left.control.id.localeCompare(right.control.id) ||
        left.index - right.index,
    )
    .map(({ control }) => control);

/** Resolve a stored focus only when it still points at a visible enabled control. */
export const focusedControl = (state: SessionState, viewId: string, controls: readonly Control[]): Control | undefined => {
  const controlId = state.focusByView.get(viewId)?.controlId;
  if (controlId === undefined) return undefined;
  return navigableControls(controls).find((control) => control.id === controlId);
};

const setFocus = (state: SessionState, viewId: string, controlId: string | undefined): SessionState => {
  const current = state.focusByView.get(viewId)?.controlId;
  if (current === controlId && state.focusByView.has(viewId)) return state;
  const focusByView = new Map(state.focusByView);
  const focus: FocusState = { viewId, controlId };
  focusByView.set(viewId, focus);
  return { ...state, focusByView };
};

/** Restore stored focus, falling back to the first enabled control or no focus. */
export const restoreFocus = (state: SessionState, viewId: string, controls: readonly Control[]): SessionState => {
  const ordered = navigableControls(controls);
  const current = focusedControl(state, viewId, ordered);
  const controlId = current?.id ?? ordered[0]?.id;
  return setFocus(state, viewId, controlId);
};

/** Move focus one circular position, preserving the state when no control is available. */
export const moveFocus = (
  state: SessionState,
  viewId: string,
  controls: readonly Control[],
  direction: "forward" | "backward",
): SessionState => {
  const ordered = navigableControls(controls);
  if (ordered.length === 0) return restoreFocus(state, viewId, ordered);
  const current = focusedControl(state, viewId, ordered);
  if (current === undefined) return setFocus(state, viewId, ordered[0]?.id);
  const index = ordered.findIndex((control) => control.id === current.id);
  const nextIndex = direction === "forward" ? (index + 1) % ordered.length : (index - 1 + ordered.length) % ordered.length;
  return setFocus(state, viewId, ordered[nextIndex]?.id);
};

/**
 * Compute the smallest non-negative scroll offset that fully exposes focus.
 * Bounds are inclusive rows. A viewport that can contain all content always returns zero.
 */
export const computeScrollTop = (
  controls: readonly Control[],
  focusedControlId: string | undefined,
  viewportRows: number,
  currentScrollTop = 0,
): NonNegativeInteger => {
  if (!Number.isInteger(viewportRows) || viewportRows <= 0) return Math.max(0, Math.floor(currentScrollTop)) as NonNegativeInteger;
  const ordered = navigableControls(controls);
  const contentBottom = ordered.reduce((maximum, control) => Math.max(maximum, control.bounds.bottom), -1);
  const contentRows = contentBottom + 1;
  if (contentRows <= viewportRows) return 0 as NonNegativeInteger;

  const maxScroll = contentRows - viewportRows;
  let next = Math.min(Math.max(0, Math.floor(currentScrollTop)), maxScroll);
  const focused = focusedControlId === undefined ? undefined : ordered.find((control) => control.id === focusedControlId);
  if (focused !== undefined) {
    if (focused.bounds.top < next) next = focused.bounds.top;
    if (focused.bounds.bottom >= next + viewportRows) next = focused.bounds.bottom - viewportRows + 1;
  }
  return Math.min(Math.max(0, next), maxScroll) as NonNegativeInteger;
};

/** Apply validation to one value while retaining the value and all other control errors. */
export const validationErrors = (controlId: string, value: string, rules: readonly ValidationRule[]): readonly ValidationError[] => {
  const seen = new Set<string>();
  const errors: ValidationError[] = [];
  for (const rule of rules) {
    if (seen.has(rule.rule)) continue;
    seen.add(rule.rule);
    if (!rule.validate(value)) errors.push({ controlId, rule: rule.rule, message: rule.message });
  }
  return errors;
};

/** Update an unconfirmed input and replace only that input's validation errors. */
export const updateInputValidation = (
  state: SessionState,
  controlId: string,
  value: string,
  rules: readonly ValidationRule[] = [],
  pending = false,
): SessionState => {
  const unconfirmedInputs = new Map(state.unconfirmedInputs);
  unconfirmedInputs.set(controlId, value);
  const retained = state.validation.errors.filter((error) => error.controlId !== controlId);
  const errors = [...retained, ...validationErrors(controlId, value, rules)];
  const unique = new Map<string, ValidationError>();
  for (const error of errors) unique.set(`${error.controlId}\u0000${error.rule}`, error);
  return {
    ...state,
    unconfirmedInputs,
    validation: { pending, errors: [...unique.values()] },
  };
};

/** Change pending validation without changing editable values or existing violations. */
export const setValidationPending = (state: SessionState, pending: boolean): SessionState =>
  state.validation.pending === pending ? state : { ...state, validation: { ...state.validation, pending } };

/** Revalidate every restored input using the supplied rules, preserving every input value. */
export const revalidateInputs = (state: SessionState, rules: ValidationRules, pending = false): SessionState => {
  let next = { ...state, validation: { pending, errors: [] as readonly ValidationError[] } };
  for (const [controlId, value] of state.unconfirmedInputs) {
    next = updateInputValidation(next, controlId, value, rules.get(controlId) ?? [], pending);
  }
  return next;
};

/** Disable only workflow-advance controls while validation is invalid or pending. */
export const gateAdvanceControls = (controls: readonly Control[], validation: SessionState["validation"]): readonly Control[] => {
  if (!validation.pending && validation.errors.length === 0) return controls;
  return controls.map((control) => (ADVANCE_ACTIONS.has(control.action) ? { ...control, enabled: false } : control));
};

/** Whether an action is currently blocked by validation state. */
export const isAdvanceBlocked = (action: RegisteredAction, validation: SessionState["validation"]): boolean =>
  ADVANCE_ACTIONS.has(action) && (validation.pending || validation.errors.length > 0);
