import type { RenderProfile, SymbolSet } from "./capabilities.js";
import type { RegisteredAction } from "./events.js";
import type { ProgressModel } from "./progress.js";
import type { HelpEntry, SemanticToken, StatusMessage, StatusSeverity } from "./view.js";

/**
 * The original visual identity of this CLI. The brand is expressed with plain text
 * and generic geometric symbols only: no external product name, logo, wording,
 * palette, layout, or otherwise recognizable third-party identity is reproduced.
 */
export const BRAND_LABEL = "auto-ai-setup" as const;

/** Short, original descriptor shown next to the brand in full visual mode. */
export const BRAND_DESCRIPTOR = "preparación local de proyectos para agentes" as const;

/** The exact textual state labels required by the presentation contract. */
export const STATUS_LABELS: Readonly<Record<StatusSeverity, string>> = {
  success: "ÉXITO",
  warning: "ADVERTENCIA",
  error: "ERROR",
  info: "INFORMACIÓN",
};

/**
 * Stable labels for equivalent actions. The same registered action always renders the
 * same label, in every stage and every render mode, so an action never appears under
 * two different names.
 */
export const ACTION_LABELS: Readonly<Record<RegisteredAction, string>> = {
  advance: "Continuar",
  back: "Atrás",
  "select-choice": "Seleccionar",
  "toggle-option": "Alternar selección",
  "edit-input": "Editar",
  confirm: "Confirmar",
  cancel: "Cancelar",
  "confirm-cancel": "Confirmar cancelación",
  resume: "Continuar sesión",
  "approve-plan": "Aprobar plan",
  "reject-plan": "Rechazar plan",
  "toggle-help": "Ayuda",
  retry: "Reintentar",
  correct: "Corregir",
  rollback: "Revertir",
  finish: "Finalizar",
};

/** Default contextual help. Toggling help never changes focus, selections, or inputs. */
export const DEFAULT_HELP_ENTRIES: readonly HelpEntry[] = [
  { keys: "Tab / Shift+Tab", description: "mover el foco" },
  { keys: "Enter", description: "activar la acción enfocada" },
  { keys: "?", description: "mostrar u ocultar ayuda" },
  { keys: "Esc", description: "solicitar cancelación" },
];

/**
 * Non-color markers for every semantic token. Color is an optional enhancement: each
 * state is already distinguishable through these textual markers alone, so meaning
 * survives on monochrome terminals and with `NO_COLOR` set.
 */
export const semanticMarker = (token: SemanticToken, symbols: SymbolSet): string => {
  switch (token) {
    case "heading":
      return "==";
    case "secondary":
      return "--";
    case "selected":
      return symbols.selectedMarker;
    case "focus":
      return symbols.focusMarker;
    case "warning":
      return symbols.warningIcon;
    case "error":
      return symbols.errorIcon;
    case "success":
      return symbols.successIcon;
    case "muted":
      return symbols.unselectedMarker;
    case "plain":
      return symbols.bulletMarker;
  }
};

/** Whether a token denotes a title, so renderers can emphasize it without color. */
export const isTitleToken = (token: SemanticToken): boolean => token === "heading";

/** Map a status severity to its semantic token so status shares one visual language. */
export const statusToken = (severity: StatusSeverity): SemanticToken => {
  switch (severity) {
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "error":
      return "error";
    case "info":
      return "plain";
  }
};

/** Build a status message with its exact required textual label. */
export const statusMessage = (severity: StatusSeverity, text: string): StatusMessage => ({
  severity,
  label: STATUS_LABELS[severity],
  text,
});

/** The non-color marker for a status message, used when color is unavailable. */
export const statusMarker = (severity: StatusSeverity, symbols: SymbolSet): string => semanticMarker(statusToken(severity), symbols);

/**
 * Static, animation-free activity text. Even when animation is available, the activity
 * indicator remains a stable textual statement so no information depends on motion and
 * screen readers receive a complete, non-flickering description.
 */
export const activityStatusText = (description: string, progress: ProgressModel | undefined): string => {
  if (progress === undefined) return description;
  if (progress.kind === "indeterminate") return `${description} (en curso)`;
  return `${description} (${progress.completed}/${progress.total}, ${progress.percent}%)`;
};

/**
 * A label for an editable input remains visible at all times, independent of focus, so
 * the purpose of the field is never conveyed by focus or color alone.
 */
export const inputLabel = (label: string, value: string | undefined): string =>
  value === undefined || value.length === 0 ? label : `${label}: ${value}`;

/**
 * Contextual help is non-disruptive: it is rendered as an additional labeled region and
 * never replaces the view, so showing or hiding it changes no other visible content.
 */
export const helpRegionLabel = "AYUDA" as const;

/** Region labels used consistently across full, degraded, and linear projections. */
export const REGION_LABELS = {
  actions: "ACCIONES",
  plan: "PLAN",
  recovery: "RECUPERACIÓN",
  summary: "RESUMEN FINAL",
  help: helpRegionLabel,
} as const;

/**
 * Whether the profile may use color as an enhancement. Callers must never rely on this
 * for meaning: the non-color markers above are always emitted regardless of the answer.
 */
export const colorIsEnhancementOnly = (profile: RenderProfile): boolean => profile.color;
