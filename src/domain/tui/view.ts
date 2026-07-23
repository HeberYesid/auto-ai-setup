import type { PlanViewModel } from "./plan-view.js";
import type { ProgressModel } from "./progress.js";
import type { SummaryViewModel } from "./recovery.js";
import type { Control } from "./session.js";
import type { PositiveInteger } from "./values.js";

/**
 * Semantic emphasis tokens. Renderers map tokens to color and/or non-color markers
 * so every state remains distinguishable when color is unavailable.
 */
export type SemanticToken = "heading" | "secondary" | "selected" | "warning" | "error" | "success" | "focus" | "muted" | "plain";

/** A labeled content region in flow order, renderable sequentially in linear mode. */
export interface ViewSection {
  readonly id: string;
  readonly token: SemanticToken;
  readonly label: string;
  readonly value: string | undefined;
}

/** A single contextual-help entry pairing a key or keys with a description. */
export interface HelpEntry {
  readonly keys: string;
  readonly description: string;
}

/** Toggleable contextual help; toggling visibility never changes focus or selections. */
export interface HelpModel {
  readonly visible: boolean;
  readonly entries: readonly HelpEntry[];
}

/** Severity of a status message; each maps to a distinct textual label and marker. */
export type StatusSeverity = "success" | "warning" | "error" | "info";

/** A status message carrying an explicit textual label (e.g. `ÉXITO`, `ADVERTENCIA`, `ERROR`). */
export interface StatusMessage {
  readonly severity: StatusSeverity;
  readonly label: string;
  readonly text: string;
}

/**
 * A deterministic, redacted projection of the current view. Contains no ANSI codes,
 * stream writes, clocks, or secrets. Exposes the brand, current stage, and an
 * applicable enabled primary action.
 */
export interface ViewModel {
  readonly viewId: string;
  readonly brandLabel: "auto-ai-setup";
  readonly stageLabel: string;
  readonly primaryAction: Control | undefined;
  readonly controls: readonly Control[];
  readonly focusControlId: string | undefined;
  readonly sections: readonly ViewSection[];
  readonly help: HelpModel | undefined;
  readonly status: readonly StatusMessage[];
  readonly progress: ProgressModel | undefined;
  readonly plan: PlanViewModel | undefined;
  readonly summary: SummaryViewModel | undefined;
}

/** A styled text span tagged with a semantic token; ANSI is applied only by the output adapter. */
export interface FrameSpan {
  readonly token: SemanticToken;
  readonly text: string;
}

/** A single rendered line tagged with the semantic region it belongs to. */
export interface FrameLine {
  readonly regionId: string;
  readonly spans: readonly FrameSpan[];
}

/**
 * A rendered frame. `changedRegions` identifies semantic regions that changed since
 * the previous frame so the output adapter can emit a minimal safe delta.
 */
export interface Frame {
  readonly width: PositiveInteger;
  readonly lines: readonly FrameLine[];
  readonly ansiAllowed: boolean;
  readonly changedRegions: readonly string[];
}
