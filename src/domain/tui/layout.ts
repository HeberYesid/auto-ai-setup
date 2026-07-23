import { ASCII_SYMBOLS } from "./compatibility.js";
import type { RenderProfile, PresentationMode } from "./capabilities.js";
import type { Control, ControlBounds } from "./session.js";
import type { FrameLine, FrameSpan, SemanticToken, ViewModel, ViewSection } from "./view.js";

/** A path/string result that records whether information was omitted. */
export interface TruncatedText {
  readonly text: string;
  readonly truncated: boolean;
}

/** A bounded window over a deterministic sequence of layout lines. */
export interface ViewportWindow {
  readonly scrollTop: number;
  readonly start: number;
  readonly end: number;
  readonly totalLines: number;
  readonly viewportHeight: number;
}

/** Options accepted by the pure layout pipeline. */
export interface LayoutOptions {
  readonly width: number;
  readonly height?: number;
  readonly scrollTop?: number;
  readonly pathIndicator?: string;
}

/** Render-mode semantics kept separate from terminal output/ANSI handling. */
export interface RenderModeProjection {
  readonly mode: PresentationMode;
  readonly view: ViewModel;
  readonly brandLabel: ViewModel["brandLabel"];
  readonly stageLabel: string;
  readonly primaryAction: ViewModel["primaryAction"];
  readonly controls: readonly Control[];
  readonly focusControlId: string | undefined;
  readonly sections: readonly ViewSection[];
  readonly useBorders: boolean;
  readonly compact: boolean;
  readonly sequential: boolean;
  readonly ansiAllowed: boolean;
  readonly colorAllowed: boolean;
  readonly animationAllowed: boolean;
  readonly symbols: RenderProfile["symbols"];
}

/** Result of projecting semantic content into deterministic bounded lines. */
export interface LayoutDocument {
  readonly mode: PresentationMode;
  readonly width: number;
  readonly height: number | undefined;
  readonly lines: readonly FrameLine[];
  readonly visibleLines: readonly FrameLine[];
  readonly viewport: ViewportWindow;
  readonly controlBounds: ReadonlyMap<string, ControlBounds>;
  readonly focusControlId: string | undefined;
}

const safeDimension = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;

const safeWidth = (width: number): number => safeDimension(width, 1);

const safeHeight = (height: number | undefined, fallback: number): number | undefined =>
  height === undefined ? undefined : safeDimension(height, fallback);

const safeOffset = (offset: number | undefined): number => (offset !== undefined && Number.isInteger(offset) && offset >= 0 ? offset : 0);

const span = (token: SemanticToken, text: string): FrameSpan => ({ token, text });

const line = (regionId: string, token: SemanticToken, text: string): FrameLine => ({
  regionId,
  spans: [span(token, text)],
});

/**
 * Wrap text deterministically to a positive width. Newlines are preserved as
 * line boundaries, whitespace at a wrap boundary is not emitted twice, and long
 * unbroken words are split rather than exceeding the terminal width.
 */
export const wrapText = (value: string, width: number): readonly string[] => {
  const boundedWidth = safeWidth(width);
  const result: string[] = [];

  for (const sourceLine of value.split("\n")) {
    if (sourceLine.length === 0) {
      result.push("");
      continue;
    }

    let remaining = sourceLine;
    while (remaining.length > boundedWidth) {
      const candidate = remaining.slice(0, boundedWidth + 1);
      const breakAt = candidate.lastIndexOf(" ");
      if (breakAt > 0) {
        result.push(remaining.slice(0, breakAt));
        remaining = remaining.slice(breakAt + 1);
      } else {
        result.push(remaining.slice(0, boundedWidth));
        remaining = remaining.slice(boundedWidth);
      }
    }
    result.push(remaining);
  }

  return result;
};

/**
 * Truncate a path while retaining both its beginning and its most specific tail.
 * The indicator is always visible when truncation occurs, even at one-column
 * widths. No filesystem or platform path APIs are used by this pure function.
 */
export const truncatePath = (path: string, width: number, indicator = "..."): TruncatedText => {
  const boundedWidth = safeWidth(width);
  if (path.length <= boundedWidth) return { text: path, truncated: false };

  const marker = indicator.length > 0 ? indicator : "...";
  if (boundedWidth <= marker.length) return { text: marker.slice(0, boundedWidth), truncated: true };

  const remaining = boundedWidth - marker.length;
  const prefixLength = Math.ceil(remaining / 2);
  const suffixLength = remaining - prefixLength;
  const suffix = suffixLength === 0 ? "" : path.slice(-suffixLength);
  return {
    text: `${path.slice(0, prefixLength)}${marker}${suffix}`,
    truncated: true,
  };
};

/** String-only convenience form for callers that do not need truncation metadata. */
export const truncatePathText = (path: string, width: number, indicator = "..."): string => truncatePath(path, width, indicator).text;

const cloneView = (view: ViewModel): ViewModel => ({
  ...view,
  controls: [...view.controls],
  sections: [...view.sections],
  status: [...view.status],
  help: view.help === undefined ? undefined : { visible: view.help.visible, entries: [...view.help.entries] },
});

/**
 * Project a semantic view according to a selected profile. This operation only
 * changes presentation capabilities: essential semantic fields and their order
 * remain untouched. ANSI/color decisions are metadata for the output adapter;
 * this domain projection never embeds escape sequences.
 */
export const projectRenderMode = (view: ViewModel, profile: RenderProfile): RenderModeProjection => {
  const projectedView = cloneView(view);
  const interactive = profile.mode === "full-visual" || profile.mode === "degraded";
  const symbols = profile.mode === "linear-text" || profile.mode === "non-interactive" ? ASCII_SYMBOLS : profile.symbols;
  return {
    mode: profile.mode,
    view: projectedView,
    brandLabel: projectedView.brandLabel,
    stageLabel: projectedView.stageLabel,
    primaryAction: projectedView.primaryAction,
    controls: projectedView.controls,
    focusControlId: projectedView.focusControlId,
    sections: projectedView.sections,
    useBorders: profile.mode === "full-visual",
    compact: profile.mode !== "full-visual",
    sequential: profile.mode === "linear-text" || profile.mode === "non-interactive",
    ansiAllowed: interactive && profile.ansi,
    colorAllowed: interactive && profile.color,
    animationAllowed: interactive && profile.animation,
    symbols,
  };
};

/** Compatibility aliases for callers that describe this operation as a view projection. */
export const projectViewForRenderMode = projectRenderMode;
export const projectViewModelForMode = projectRenderMode;

const addWrappedLines = (lines: FrameLine[], regionId: string, token: SemanticToken, text: string, width: number, prefix = ""): number => {
  const wrapped = wrapText(`${prefix}${text}`, width);
  for (const [index, value] of wrapped.entries()) lines.push(line(`${regionId}:${index}`, token, value));
  return wrapped.length;
};

const sectionText = (section: ViewSection): string =>
  section.value === undefined || section.value.length === 0 ? section.label : `${section.label}: ${section.value}`;

const addPathField = (lines: FrameLine[], regionId: string, label: string, path: string, width: number, indicator: string): void => {
  const prefix = `${label}: `;
  const available = Math.max(1, width - prefix.length);
  const rendered = truncatePath(path, available, indicator).text;
  addWrappedLines(lines, regionId, "secondary", rendered, width, prefix);
};

const addPlan = (lines: FrameLine[], projection: RenderModeProjection, width: number, indicator: string): void => {
  const plan = projection.view.plan;
  if (plan === undefined) return;
  lines.push(line("plan", "heading", "PLAN"));
  lines.push(line("plan:hash", "secondary", `Hash: ${plan.planHash}`));
  for (const operation of plan.operations) {
    const region = `plan:${operation.operationId}`;
    addWrappedLines(lines, `${region}:operation`, "plain", `Operación ${operation.operationId} (${operation.action})`, width);
    addPathField(lines, `${region}:destination`, "Destino", operation.destination, width, indicator);
    addPathField(lines, `${region}:source`, "Origen", operation.source, width, indicator);
    addWrappedLines(lines, `${region}:reason`, "secondary", operation.reason, width, "Motivo: ");
    addWrappedLines(lines, `${region}:conflict`, "warning", operation.conflict, width, "Conflicto: ");
    if (operation.semanticChange !== undefined) {
      addWrappedLines(lines, `${region}:before`, "secondary", operation.semanticChange.before, width, "Antes: ");
      addWrappedLines(lines, `${region}:after`, "secondary", operation.semanticChange.after, width, "Después: ");
    }
    if (operation.external !== undefined) {
      addWrappedLines(lines, `${region}:command`, "secondary", operation.external.command, width, "Comando: ");
      for (const argument of operation.external.args)
        addWrappedLines(lines, `${region}:arg:${argument}`, "secondary", argument, width, "  Arg: ");
      addWrappedLines(lines, `${region}:purpose`, "secondary", operation.external.purpose, width, "Propósito: ");
      addWrappedLines(lines, `${region}:network`, "secondary", operation.external.networkUse, width, "Red: ");
    }
  }
};

const addControls = (lines: FrameLine[], projection: RenderModeProjection, width: number): ReadonlyMap<string, ControlBounds> => {
  const bounds = new Map<string, ControlBounds>();
  if (projection.controls.length === 0) return bounds;
  lines.push(line("controls", "heading", "ACCIONES"));
  for (const control of projection.controls) {
    if (!control.visible) continue;
    const top = lines.length;
    const marker = control.id === projection.focusControlId ? projection.symbols.focusMarker : " ";
    const state = control.enabled ? "" : " (deshabilitado)";
    addWrappedLines(
      lines,
      `control:${control.id}`,
      control.id === projection.focusControlId ? "focus" : "plain",
      `${marker} ${control.label}${state}`,
      width,
    );
    const bottom = lines.length;
    bounds.set(control.id, { top: top as ControlBounds["top"], bottom: bottom as ControlBounds["bottom"] });
  }
  return bounds;
};

const addSemanticContent = (
  lines: FrameLine[],
  projection: RenderModeProjection,
  width: number,
  indicator: string,
): ReadonlyMap<string, ControlBounds> => {
  if (projection.useBorders) lines.push(line("border:top", "muted", projection.symbols.horizontalBorder.repeat(width)));
  lines.push(line("brand", "heading", projection.brandLabel));
  lines.push(line("stage", "heading", `Etapa: ${projection.stageLabel}`));

  for (const section of projection.sections) addWrappedLines(lines, `section:${section.id}`, section.token, sectionText(section), width);

  const { activity, status, progress, help } = projection.view;
  if (activity !== undefined) {
    addWrappedLines(lines, "activity", "secondary", activity.description, width, "Actividad: ");
    if (activity.progress !== undefined && activity.progress.kind === "determined") {
      addWrappedLines(
        lines,
        "activity:progress",
        "secondary",
        `${activity.progress.completed}/${activity.progress.total} (${activity.progress.percent}%)`,
        width,
        "Progreso: ",
      );
    }
  }
  for (const message of status)
    addWrappedLines(
      lines,
      `status:${message.severity}`,
      message.severity === "error"
        ? "error"
        : message.severity === "warning"
          ? "warning"
          : message.severity === "success"
            ? "success"
            : "plain",
      `${message.label}: ${message.text}`,
      width,
    );
  if (progress !== undefined && activity?.progress === undefined && progress.kind === "determined") {
    addWrappedLines(lines, "progress", "secondary", `${progress.completed}/${progress.total} (${progress.percent}%)`, width, "Progreso: ");
  }

  addPlan(lines, projection, width, indicator);
  const controlBounds = addControls(lines, projection, width);

  if (projection.primaryAction !== undefined && projection.primaryAction.enabled && projection.primaryAction.visible) {
    addWrappedLines(lines, "primary-action", "selected", projection.primaryAction.label, width, "Acción principal: ");
  }
  if (projection.view.recovery !== undefined) {
    lines.push(line("recovery", "heading", "RECUPERACIÓN"));
    for (const control of projection.view.recovery.controls)
      addWrappedLines(
        lines,
        `recovery:${control.id}`,
        control.enabled ? "plain" : "muted",
        `${control.label} (${control.enabled ? "habilitado" : "deshabilitado"})`,
        width,
      );
  }
  if (projection.view.summary !== undefined) {
    lines.push(line("summary", "heading", "RESUMEN FINAL"));
    addWrappedLines(lines, "summary:status", "heading", projection.view.summary.status, width, "Estado: ");
    for (const change of projection.view.summary.changes)
      addWrappedLines(lines, `summary:change:${change.operationId}`, "plain", change.operationId, width, "Cambio: ");
    for (const omission of projection.view.summary.omissions)
      addWrappedLines(lines, `summary:omission:${omission}`, "secondary", omission, width, "Omisión: ");
  }
  if (help?.visible === true) {
    lines.push(line("help", "heading", "AYUDA"));
    for (const entry of help.entries)
      addWrappedLines(lines, `help:${entry.keys}`, "secondary", entry.description, width, `${entry.keys}: `);
  }
  if (projection.useBorders) lines.push(line("border:bottom", "muted", projection.symbols.horizontalBorder.repeat(width)));
  return controlBounds;
};

/** Compute the smallest bounded scroll offset that reveals a focused control. */
export const computeViewportScroll = (
  totalLines: number,
  viewportHeight: number,
  focusedBounds: { readonly top: number; readonly bottom: number } | undefined,
  currentScrollTop = 0,
): number => {
  const total = Math.max(0, Number.isInteger(totalLines) ? totalLines : 0);
  const viewport = safeDimension(viewportHeight, 1);
  if (total <= viewport) return 0;
  const maximum = total - viewport;
  let offset = Math.min(Math.max(0, safeOffset(currentScrollTop)), maximum);
  if (focusedBounds !== undefined) {
    const top = Math.max(0, Math.min(total, focusedBounds.top));
    const bottom = Math.max(top, Math.min(total, focusedBounds.bottom));
    if (top < offset) offset = top;
    if (bottom > offset + viewport) offset = bottom - viewport;
  }
  return Math.min(Math.max(0, offset), maximum);
};

/** Return the visible half-open line interval after clamping an offset. */
export const calculateViewportWindow = (totalLines: number, viewportHeight: number, currentScrollTop = 0): ViewportWindow => {
  const total = Math.max(0, Number.isInteger(totalLines) ? totalLines : 0);
  const height = safeDimension(viewportHeight, Math.max(1, total));
  const scrollTop = computeViewportScroll(total, height, undefined, currentScrollTop);
  return { scrollTop, start: scrollTop, end: Math.min(total, scrollTop + height), totalLines: total, viewportHeight: height };
};

/** Alias used by callers that name the operation as a window calculation. */
export const calculateScrollOffset = computeViewportScroll;

/**
 * Build deterministic semantic lines and a bounded viewport. The output is still
 * a domain model: no ANSI sequences, cursor movement, writes, timers, or effects.
 */
export const layoutViewModel = (view: ViewModel, profile: RenderProfile, options: LayoutOptions): LayoutDocument => {
  const projection = projectRenderMode(view, profile);
  const width = safeWidth(options.width);
  const height = safeHeight(options.height, 1);
  const lines: FrameLine[] = [];
  const controlBounds = addSemanticContent(lines, projection, width, options.pathIndicator ?? projection.symbols.truncationIndicator);
  const focusedBounds = projection.focusControlId === undefined ? undefined : controlBounds.get(projection.focusControlId);
  const scrollTop = computeViewportScroll(lines.length, height ?? lines.length, focusedBounds, options.scrollTop ?? 0);
  const viewport = calculateViewportWindow(lines.length, height ?? lines.length, scrollTop);
  return {
    mode: projection.mode,
    width,
    height,
    lines,
    visibleLines: lines.slice(viewport.start, viewport.end),
    viewport,
    controlBounds,
    focusControlId: projection.focusControlId,
  };
};

/** Compatibility aliases for the layout pipeline entry point. */
export const buildLayout = layoutViewModel;
export const projectLayout = layoutViewModel;

/** Convert a semantic layout to append-only text without ANSI or cursor controls. */
export const linearizeLayout = (layout: LayoutDocument): readonly string[] =>
  layout.lines.map((item) => item.spans.map((itemSpan) => itemSpan.text).join(""));

/** Build the sequential text projection directly for linear/non-interactive sinks. */
export const renderLinearProjection = (view: ViewModel, profile: RenderProfile, options: LayoutOptions): readonly string[] =>
  linearizeLayout(layoutViewModel(view, profile, options));
