import { SecretRedactor } from "../security/redaction.js";
import type { Redactor } from "../shared/ports.js";
import { err, ok } from "../shared/types.js";
import type { ChangePlan } from "../planning/models.js";
import { tuiError, type TuiResult } from "./errors.js";
import type { ActivityState, Control, SessionState, Stage } from "./session.js";
import type { ProgressModel } from "./progress.js";
import {
  canonicalizeRecoveryPaths,
  hasVisibleRecoveryResult,
  type RecoveryActionKind,
  type RecoveryState,
  type SummaryViewModel,
} from "./recovery.js";
import type {
  ActivityViewModel,
  HelpEntry,
  HelpModel,
  PresentationState,
  SemanticToken,
  StatusMessage,
  ViewModel,
  ViewSection,
} from "./view.js";
import type { PlanViewModel } from "./plan-view.js";
import { NOT_APPLICABLE, projectCanonicalPlan } from "./plan-view.js";
import type { RegisteredAction } from "./events.js";
import { gateAdvanceControls } from "./navigation.js";
import { ACTION_LABELS as VISUAL_ACTION_LABELS, BRAND_LABEL, DEFAULT_HELP_ENTRIES, STATUS_LABELS } from "./visual.js";

/** Inputs supplied by the application when it has stage-specific controls. */
export interface PresentationProjectionOptions {
  readonly controls?: readonly Control[];
  readonly helpEntries?: readonly HelpEntry[];
  readonly knownSecrets?: readonly string[];
  readonly redactor?: Redactor;
  readonly primaryActionId?: string;
}

const STAGE_LABELS: Readonly<Record<Stage, string>> = {
  inspect: "INSPECCIÓN",
  select: "SELECCIÓN",
  review: "REVISIÓN",
  approve: "APROBACIÓN",
  apply: "APLICACIÓN",
  recover: "RECUPERACIÓN",
  summary: "RESUMEN",
  cancelled: "CANCELADO",
  failed: "FALLIDO",
};

const ADVANCE_ACTIONS: ReadonlySet<RegisteredAction> = new Set(["advance", "confirm", "approve-plan", "confirm-cancel", "finish"]);

const DEFAULT_HELP: readonly HelpEntry[] = DEFAULT_HELP_ENTRIES;

const ACTION_LABELS: Readonly<Record<RegisteredAction, string>> = VISUAL_ACTION_LABELS;

const DEFAULT_ACTIONS: Readonly<Record<Stage, readonly { id: string; action: RegisteredAction; label: string }[]>> = {
  inspect: [{ id: "continue", action: "advance", label: ACTION_LABELS.advance }],
  select: [
    { id: "back", action: "back", label: ACTION_LABELS.back },
    { id: "continue", action: "advance", label: ACTION_LABELS.advance },
  ],
  review: [
    { id: "back", action: "back", label: ACTION_LABELS.back },
    { id: "continue", action: "advance", label: ACTION_LABELS.advance },
  ],
  approve: [
    { id: "reject", action: "reject-plan", label: ACTION_LABELS["reject-plan"] },
    { id: "approve", action: "approve-plan", label: ACTION_LABELS["approve-plan"] },
  ],
  apply: [],
  recover: [],
  summary: [{ id: "finish", action: "finish", label: ACTION_LABELS.finish }],
  cancelled: [{ id: "finish", action: "finish", label: ACTION_LABELS.finish }],
  failed: [{ id: "finish", action: "finish", label: ACTION_LABELS.finish }],
};

const zero = 0 as Control["bounds"]["top"];

const defaultControls = (stage: Stage): readonly Control[] =>
  DEFAULT_ACTIONS[stage].map((entry, index) => ({
    id: entry.id,
    kind: "button",
    label: entry.label,
    enabled: true,
    visible: true,
    action: entry.action,
    bounds: { top: (zero + index) as Control["bounds"]["top"], bottom: (zero + index) as Control["bounds"]["bottom"] },
  }));

const freezeDeep = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen);
    Object.freeze(value);
  }
  return value;
};

const comparableControl = (control: Control): string =>
  `${control.bounds.top}:${control.bounds.bottom}:${control.id}:${control.action}:${control.label}`;

const sortControls = (controls: readonly Control[]): readonly Control[] =>
  [...controls]
    .map((control) => ({ ...control, bounds: { ...control.bounds } }))
    .sort(
      (left, right) =>
        left.bounds.top - right.bounds.top ||
        left.bounds.bottom - right.bounds.bottom ||
        comparableControl(left).localeCompare(comparableControl(right)),
    );

const sortObject = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (Array.isArray(value)) return value.map((entry) => sortObject(entry, seen));
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return NOT_APPLICABLE;
    seen.add(value);
    const sorted = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortObject(entry, seen)]),
    );
    seen.delete(value);
    return sorted;
  }
  return value;
};

const deterministicText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return NOT_APPLICABLE;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  const serialized = JSON.stringify(sortObject(value));
  if (serialized === undefined) throw new Error("Value cannot be serialized for presentation");
  return serialized;
};

const redactionFailure = (location: string, cause: unknown): TuiResult<never> =>
  err(
    tuiError("REDACTION_INCOMPLETE", `Unable to redact presentation value at ${location}`, {
      location,
      cause: cause instanceof Error ? cause.message : String(cause),
      suggestedAction: "Do not emit presentation output; inspect the redaction configuration",
    }),
  );

const containsKnownSecret = (value: string, knownSecrets: readonly string[]): string | undefined =>
  knownSecrets.find((secret) => secret.length > 0 && value.includes(secret));

interface RedactionContext {
  readonly redactor: Redactor;
  readonly knownSecrets: readonly string[];
}

const redactText = (value: unknown, location: string, context: RedactionContext): TuiResult<string> => {
  try {
    const redacted = context.redactor.redact(value, context.knownSecrets);
    const text = deterministicText(redacted);
    const leaked = containsKnownSecret(text, context.knownSecrets);
    return leaked === undefined ? ok(text) : redactionFailure(location, `Known sensitive literal was returned unredacted: ${leaked}`);
  } catch (cause: unknown) {
    return redactionFailure(location, cause);
  }
};

const requiredText = (value: unknown, location: string, context: RedactionContext): TuiResult<string> => {
  const result = redactText(value, location, context);
  if (!result.ok) return result;
  return result.value === NOT_APPLICABLE || result.value.length === 0
    ? redactionFailure(location, "Required presentation text is absent")
    : result;
};

const projectControl = (control: Control, index: number, context: RedactionContext): TuiResult<Control> => {
  const id = requiredText(control.id, `controls[${index}].id`, context);
  if (!id.ok) return id;
  const label = requiredText(control.label, `controls[${index}].label`, context);
  if (!label.ok) return label;
  return ok({
    ...control,
    id: id.value,
    label: label.value,
    bounds: { ...control.bounds },
  });
};

const projectControls = (controls: readonly Control[], context: RedactionContext): TuiResult<readonly Control[]> => {
  const projected: Control[] = [];
  for (const [index, control] of controls.entries()) {
    const result = projectControl(control, index, context);
    if (!result.ok) return result;
    projected.push(result.value);
  }
  return ok(sortControls(projected));
};

const section = (id: string, token: SemanticToken, label: string, value: string | undefined): ViewSection => ({ id, token, label, value });

const projectHelp = (state: SessionState, options: PresentationProjectionOptions, context: RedactionContext): TuiResult<HelpModel> => {
  const entries = options.helpEntries ?? DEFAULT_HELP;
  const projected: HelpEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const keys = requiredText(entry.keys, `help[${index}].keys`, context);
    if (!keys.ok) return keys;
    const description = requiredText(entry.description, `help[${index}].description`, context);
    if (!description.ok) return description;
    projected.push({ keys: keys.value, description: description.value });
  }
  return ok({ visible: state.helpVisible, entries: projected });
};

const projectProgress = (
  progress: ProgressModel | undefined,
  location: string,
  context: RedactionContext,
): TuiResult<ProgressModel | undefined> => {
  if (progress === undefined) return ok(undefined);
  const description = requiredText(progress.description, `${location}.description`, context);
  if (!description.ok) return description;
  return progress.kind === "determined"
    ? ok({ ...progress, description: description.value })
    : ok({ ...progress, description: description.value });
};

const projectActivity = (activity: ActivityState | undefined, context: RedactionContext): TuiResult<ActivityViewModel | undefined> => {
  if (activity === undefined) return ok(undefined);
  const description = requiredText(activity.description, "activity.description", context);
  if (!description.ok) return description;
  const progress = projectProgress(activity.progress ?? activity.lastValidProgress, "activity.progress", context);
  if (!progress.ok) return progress;
  return ok({ stage: activity.stage, description: description.value, progress: progress.value });
};

const projectStatus = (state: SessionState, context: RedactionContext): TuiResult<readonly StatusMessage[]> => {
  const statuses: StatusMessage[] = [];
  for (const [index, warning] of [...state.warnings].entries()) {
    const text = requiredText(warning, `warnings[${index}]`, context);
    if (!text.ok) return text;
    statuses.push({ severity: "warning", label: STATUS_LABELS.warning, text: text.value });
  }
  for (const [index, failure] of [...state.errors].entries()) {
    const cause = requiredText(failure.cause, `errors[${index}].cause`, context);
    if (!cause.ok) return cause;
    const operation = requiredText(failure.operation, `errors[${index}].operation`, context);
    if (!operation.ok) return operation;
    statuses.push({
      severity: "error",
      label: STATUS_LABELS.error,
      text: `${STAGE_LABELS[failure.stage]} · ${operation.value}: ${cause.value}`,
    });
  }
  if (state.result !== undefined) {
    const resultText = requiredText(state.result.status, "result.status", context);
    if (!resultText.ok) return resultText;
    const severity = state.result.status === "success" ? "success" : state.result.status === "cancelled" ? "info" : "error";
    statuses.push({
      severity,
      label:
        state.result.status === "success" ? STATUS_LABELS.success : state.result.status === "cancelled" ? "CANCELADO" : STATUS_LABELS.error,
      text: resultText.value,
    });
    for (const [index, warning] of state.result.warnings.entries()) {
      const text = requiredText(warning, `result.warnings[${index}]`, context);
      if (!text.ok) return text;
      statuses.push({ severity: "warning", label: STATUS_LABELS.warning, text: text.value });
    }
    for (const [index, error] of state.result.errors.entries()) {
      const text = requiredText(error, `result.errors[${index}]`, context);
      if (!text.ok) return text;
      statuses.push({ severity: "error", label: STATUS_LABELS.error, text: text.value });
    }
  }
  return ok(statuses);
};

const projectPlan = (
  plan: ChangePlan | undefined,
  displayedPlanHash: SessionState["displayedPlanHash"],
  context: RedactionContext,
): TuiResult<PlanViewModel | undefined> => {
  if (plan === undefined) return ok(undefined);
  const projected = projectCanonicalPlan(plan, { redactor: context.redactor, knownSecrets: context.knownSecrets });
  if (!projected.ok) return projected;
  return ok(displayedPlanHash === undefined ? projected.value : { ...projected.value, planHash: displayedPlanHash });
};

const recoveryAction = (action: RecoveryActionKind): RecoveryActionKind => action;
const registeredRecoveryAction = (action: RecoveryActionKind): RegisteredAction => action;

const projectRecovery = (state: SessionState, context: RedactionContext): TuiResult<RecoveryState | undefined> => {
  const source = state.recovery;
  const resultStatus = source?.result ?? (state.result?.manualReviewPaths.length ? "partial" : "not-required");
  const sourceControls = source?.controls ?? [];
  const controls: RecoveryState["controls"][number][] = [];
  for (const [index, control] of sourceControls.entries()) {
    const id = requiredText(control.id, `recovery.controls[${index}].id`, context);
    if (!id.ok) return id;
    const label = requiredText(control.label, `recovery.controls[${index}].label`, context);
    if (!label.ok) return label;
    controls.push({ id: id.value, label: label.value, action: recoveryAction(control.action), enabled: control.enabled });
  }

  // Canonicalize before redaction so distinct paths containing secrets are not
  // collapsed into the same redacted placeholder. The resulting values are then
  // redacted before they can reach the view model or any output sink.
  const sourcePaths = source?.unresolvedPaths ?? state.result?.manualReviewPaths ?? [];
  const canonicalPaths = canonicalizeRecoveryPaths(sourcePaths);
  if (!canonicalPaths.ok) return canonicalPaths;
  const unresolvedPaths: Array<RecoveryState["unresolvedPaths"][number]> = [];
  for (const [index, path] of canonicalPaths.value.entries()) {
    const projected = requiredText(path, `recovery.unresolvedPaths[${index}]`, context);
    if (!projected.ok) return projected;
    unresolvedPaths.push(projected.value as RecoveryState["unresolvedPaths"][number]);
  }

  // An operation failure still needs a visible recovery region even when the
  // application registered no controls. This makes the absence of controls
  // explicit instead of silently skipping the failure's recovery state.
  if (
    source === undefined &&
    controls.length === 0 &&
    unresolvedPaths.length === 0 &&
    state.errors.length === 0 &&
    state.result === undefined
  )
    return ok(undefined);
  return ok({ result: resultStatus, controls, unresolvedPaths });
};

const summaryStatus = (
  status: NonNullable<SessionState["result"]>["status"],
  recovery: RecoveryState | undefined,
): SummaryViewModel["status"] => {
  switch (status) {
    case "success":
      return "success";
    case "cancelled":
      return "cancelled";
    case "failed-recovered":
      return "partial";
    case "incomplete":
      return recovery?.result === "partial" ? "partial" : "failed";
    case "invalid-input":
      return "failed";
  }
};

const isMutationFailure = (result: NonNullable<SessionState["result"]>): boolean =>
  result.status === "failed-recovered" || result.status === "incomplete";

const projectSummary = (
  state: SessionState,
  recovery: RecoveryState | undefined,
  context: RedactionContext,
): TuiResult<SummaryViewModel | undefined> => {
  const result = state.result;
  if (result === undefined) return ok(undefined);

  // A failed mutation must expose its recovery outcome before a final summary
  // can be shown. Returning no summary is deliberate: the renderer can still
  // present the failure and registered recovery controls from the same state.
  if (isMutationFailure(result) && !hasVisibleRecoveryResult(recovery)) return ok(undefined);

  const changes: SummaryViewModel["changes"][number][] = [];
  for (const [index, operationId] of result.applied.entries()) {
    const id = requiredText(operationId, `summary.changes[${index}].operationId`, context);
    if (!id.ok) return id;
    const description = requiredText(operationId, `summary.changes[${index}].description`, context);
    if (!description.ok) return description;
    changes.push({ operationId: id.value, description: description.value });
  }
  const omissions: string[] = [];
  for (const [index, omission] of result.skipped.entries()) {
    const projected = requiredText(omission, `summary.omissions[${index}]`, context);
    if (!projected.ok) return projected;
    omissions.push(projected.value);
  }

  const errors: SummaryViewModel["errors"][number][] = [];
  for (const [index, failure] of state.errors.entries()) {
    const operation = requiredText(failure.operation, `summary.sessionErrors[${index}].operation`, context);
    if (!operation.ok) return operation;
    const message = requiredText(failure.cause, `summary.sessionErrors[${index}].cause`, context);
    if (!message.ok) return message;
    errors.push({ stage: failure.stage, operation: operation.value, message: message.value });
  }
  for (const [index, message] of result.errors.entries()) {
    const projected = requiredText(message, `summary.errors[${index}]`, context);
    if (!projected.ok) return projected;
    errors.push({ stage: state.stage, operation: "ejecución", message: projected.value });
  }

  const warnings: string[] = [];
  for (const [index, message] of [...state.warnings, ...result.warnings].entries()) {
    const projected = requiredText(message, `summary.warnings[${index}]`, context);
    if (!projected.ok) return projected;
    warnings.push(projected.value);
  }
  return ok({
    status: summaryStatus(result.status, recovery),
    changes,
    omissions,
    recovery: recovery ?? { result: "not-required", controls: [], unresolvedPaths: [] },
    errors,
    warnings,
    exitCode: result.exitCode,
  });
};

const projectSections = (
  state: SessionState,
  controls: readonly Control[],
  context: RedactionContext,
): TuiResult<readonly ViewSection[]> => {
  const sections: ViewSection[] = [section("stage", "heading", "Etapa", STAGE_LABELS[state.stage])];
  const selectionEntries = [...state.selections].sort((left, right) =>
    `${left.viewId}:${left.controlId}`.localeCompare(`${right.viewId}:${right.controlId}`),
  );
  for (const [index, selection] of selectionEntries.entries()) {
    const viewId = requiredText(selection.viewId, `selections[${index}].viewId`, context);
    if (!viewId.ok) return viewId;
    const controlId = requiredText(selection.controlId, `selections[${index}].controlId`, context);
    if (!controlId.ok) return controlId;
    const label = requiredText(`Selección ${viewId.value}/${controlId.value}`, `selections[${index}].label`, context);
    if (!label.ok) return label;
    const value = requiredText(selection.value, `selections[${index}].value`, context);
    if (!value.ok) return value;
    sections.push(section(`selection:${viewId.value}:${controlId.value}`, "selected", label.value, value.value));
  }
  const inputEntries = [...state.unconfirmedInputs.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [index, [key, value]] of inputEntries.entries()) {
    const label = requiredText(key, `unconfirmedInputs[${index}].label`, context);
    if (!label.ok) return label;
    const projected = requiredText(value, `unconfirmedInputs[${index}].value`, context);
    if (!projected.ok) return projected;
    sections.push(section(`input:${label.value}`, "plain", label.value, projected.value));
  }
  for (const [index, control] of controls.entries()) {
    const label = requiredText(control.label, `controls[${index}].label`, context);
    if (!label.ok) return label;
    sections.push(section(`control:${control.id}`, control.enabled ? "plain" : "muted", "Acción", label.value));
  }
  return ok(sections);
};

const recoveryControlsAsControls = (state: SessionState): readonly Control[] =>
  (state.recovery?.controls ?? []).map((control, index) => ({
    id: control.id,
    kind: "button",
    label: control.label,
    enabled: control.enabled,
    visible: true,
    action: registeredRecoveryAction(control.action),
    bounds: { top: index as Control["bounds"]["top"], bottom: index as Control["bounds"]["bottom"] },
  }));

/** Build an immutable, redacted intermediate presentation state. */
export const buildPresentationState = (state: SessionState, options: PresentationProjectionOptions = {}): TuiResult<PresentationState> => {
  const context: RedactionContext = {
    redactor: options.redactor ?? new SecretRedactor(),
    knownSecrets: [...(options.knownSecrets ?? [])],
  };
  try {
    const suppliedControls = options.controls ?? defaultControls(state.stage);
    const allControls = [...suppliedControls, ...recoveryControlsAsControls(state)];
    const controls = projectControls(gateAdvanceControls(allControls, state.validation), context);
    if (!controls.ok) return controls;
    const help = projectHelp(state, options, context);
    if (!help.ok) return help;
    const activity = projectActivity(state.activity, context);
    if (!activity.ok) return activity;
    const plan = projectPlan(state.plan, state.displayedPlanHash, context);
    if (!plan.ok) return plan;
    const recovery = projectRecovery(state, context);
    if (!recovery.ok) return recovery;
    const summary = projectSummary(state, recovery.value, context);
    if (!summary.ok) return summary;
    const status = projectStatus(state, context);
    if (!status.ok) return status;
    const projectedControls = controls.value;
    const focusIdResult =
      state.focusByView.get(state.stage)?.controlId === undefined
        ? ok(undefined)
        : redactText(state.focusByView.get(state.stage)?.controlId, "focus.controlId", context);
    if (!focusIdResult.ok) return focusIdResult;
    const focusControlId =
      focusIdResult.value !== undefined &&
      projectedControls.some((control) => control.id === focusIdResult.value && control.visible && control.enabled)
        ? focusIdResult.value
        : projectedControls.find((control) => control.visible && control.enabled)?.id;
    const primaryActionIdResult =
      options.primaryActionId === undefined ? ok(undefined) : requiredText(options.primaryActionId, "primaryActionId", context);
    if (!primaryActionIdResult.ok) return primaryActionIdResult;
    const primaryAction = projectedControls.find(
      (control) =>
        control.visible &&
        control.enabled &&
        (primaryActionIdResult.value === undefined ? ADVANCE_ACTIONS.has(control.action) : control.id === primaryActionIdResult.value),
    );
    const sections = projectSections(state, projectedControls, context);
    if (!sections.ok) return sections;
    const presentation: PresentationState = {
      viewId: state.stage,
      brandLabel: BRAND_LABEL,
      stage: state.stage,
      stageLabel: STAGE_LABELS[state.stage],
      primaryAction,
      controls: projectedControls,
      focusControlId,
      sections: sections.value,
      help: help.value,
      status: status.value,
      activity: activity.value,
      plan: plan.value,
      recovery: recovery.value,
      summary: summary.value,
    };
    return ok(freezeDeep(presentation));
  } catch (cause: unknown) {
    return redactionFailure("presentation", cause);
  }
};

/** Convert only redaction-safe semantic state into the renderer-facing view model. */
export const createViewModel = (presentation: PresentationState): ViewModel => {
  const viewModel: ViewModel = {
    viewId: presentation.viewId,
    brandLabel: presentation.brandLabel,
    stageLabel: presentation.stageLabel,
    primaryAction: presentation.primaryAction,
    controls: presentation.controls,
    focusControlId: presentation.focusControlId,
    sections: presentation.sections,
    help: presentation.help,
    status: presentation.status,
    activity: presentation.activity,
    progress: presentation.activity?.progress,
    plan: presentation.plan,
    recovery: presentation.recovery,
    summary: presentation.summary,
  };
  return freezeDeep(viewModel);
};

/** Project session state directly to the immutable redacted semantic view model. */
export const projectSessionState = (state: SessionState, options: PresentationProjectionOptions = {}): TuiResult<ViewModel> => {
  const presentation = buildPresentationState(state, options);
  return presentation.ok ? ok(createViewModel(presentation.value)) : presentation;
};

/** Explicit alias for callers that name the operation after its output model. */
export const projectPresentation = projectSessionState;
