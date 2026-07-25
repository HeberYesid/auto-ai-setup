import type { DowngradeReason, InvocationMode, RenderProfile, TerminalCapabilities } from "./capabilities.js";
import { selectRenderProfile } from "./compatibility.js";
import { tuiError, type TuiError } from "./errors.js";
import type { RecoveryControl, RecoveryState } from "./recovery.js";
import type { SessionState } from "./session.js";

/**
 * Minimum usable width for the essential content of a view. Below this width the
 * labels, values, and action names required by the presentation contract cannot be
 * represented, so the current mode is retained instead of silently truncating them.
 */
export const MIN_ESSENTIAL_COLUMNS = 20;

/** Minimum usable height for the essential content of a view (brand, stage, one action). */
export const MIN_ESSENTIAL_ROWS = 3;

/** Optional adornments that a transition may have to suppress. */
export type SuppressibleControl = "ansi" | "color" | "unicode" | "animation" | "mouse";

/** Elements that a candidate presentation may fail to represent. */
export type NonPreservableElement = "interactive-controls" | "essential-width" | "essential-height";

/** Human-readable, secret-free identification of the element that cannot be preserved. */
export const NON_PRESERVABLE_LABELS: Readonly<Record<NonPreservableElement, string>> = {
  "interactive-controls": "controles interactivos",
  "essential-width": "ancho mínimo del contenido esencial",
  "essential-height": "altura mínima del contenido esencial",
};

/**
 * The outcome of recomputing the presentation for a new capability snapshot. The
 * session state is never rebuilt: the returned state is the prior state with the
 * presentation profile replaced, so every named field is preserved by construction.
 */
export interface PresentationTransition {
  readonly state: SessionState;
  readonly profile: RenderProfile;
  /** True when the candidate profile can represent the essential content. */
  readonly preserved: boolean;
  /** Present only when {@link preserved} is false. */
  readonly nonPreservable: NonPreservableElement | undefined;
  /** Adornments enabled before the transition that the new capabilities no longer support. */
  readonly suppressed: readonly SuppressibleControl[];
  /** Classified explanation for an impossible transition; absent when preserved. */
  readonly error: TuiError | undefined;
}

const mergeReasons = (current: readonly DowngradeReason[], candidate: readonly DowngradeReason[]): readonly DowngradeReason[] => {
  const ordered: DowngradeReason[] = [];
  const seen = new Set<DowngradeReason>();
  for (const reason of [...current, ...candidate]) {
    if (seen.has(reason)) continue;
    seen.add(reason);
    ordered.push(reason);
  }
  return ordered;
};

/** Adornments that were enabled before and are not supported by the candidate profile. */
export const suppressedControls = (current: RenderProfile, candidate: RenderProfile): readonly SuppressibleControl[] => {
  const suppressed: SuppressibleControl[] = [];
  if (current.ansi && !candidate.ansi) suppressed.push("ansi");
  if (current.color && !candidate.color) suppressed.push("color");
  if (current.unicode && !candidate.unicode) suppressed.push("unicode");
  if (current.animation && !candidate.animation) suppressed.push("animation");
  if (current.mouse && !candidate.mouse) suppressed.push("mouse");
  return suppressed;
};

/**
 * Determine whether a candidate profile can still represent the essential content of
 * an in-progress interactive session. This is a pure structural check: it consults the
 * candidate geometry and mode only, never the terminal.
 */
export const nonPreservableElement = (state: SessionState, candidate: RenderProfile): NonPreservableElement | undefined => {
  const interactiveBefore = state.presentation.mode === "full-visual" || state.presentation.mode === "degraded";
  const interactiveAfter = candidate.mode === "full-visual" || candidate.mode === "degraded";
  if (interactiveBefore && !interactiveAfter && !state.finalized && !state.cancelled && candidate.mode === "non-interactive") {
    return "interactive-controls";
  }
  if (candidate.width !== undefined && candidate.width < MIN_ESSENTIAL_COLUMNS) return "essential-width";
  if (candidate.height !== undefined && candidate.height < MIN_ESSENTIAL_ROWS) return "essential-height";
  return undefined;
};

/** Registered recovery controls offered when a presentation transition is impossible. */
export const presentationRecoveryControls = (): readonly RecoveryControl[] => [
  { id: "adjust-terminal", label: "Ajustar el tamaño del terminal y reintentar", action: "correct", enabled: true },
  { id: "retry-presentation", label: "Reintentar la presentación actual", action: "retry", enabled: true },
];

/**
 * Retain the current mode while still dropping any adornment the new capabilities no
 * longer support (Requirement 8.10). Geometry is updated so bounded layout keeps using
 * real dimensions even though the mode is unchanged.
 */
const retainedProfile = (current: RenderProfile, candidate: RenderProfile): RenderProfile => ({
  mode: current.mode,
  width: candidate.width ?? current.width,
  height: candidate.height ?? current.height,
  ansi: current.ansi && candidate.ansi,
  color: current.color && candidate.color,
  unicode: current.unicode && candidate.unicode,
  animation: current.animation && candidate.animation,
  mouse: current.mouse && candidate.mouse,
  symbols: current.unicode && candidate.unicode ? current.symbols : candidate.symbols,
  downgradeReasons: mergeReasons(current.downgradeReasons, candidate.downgradeReasons),
});

const withRecovery = (state: SessionState): RecoveryState => {
  const existing = state.recovery;
  const controls = existing !== undefined && existing.controls.length > 0 ? existing.controls : presentationRecoveryControls();
  return {
    // No recovery attempt has run, so the result stays `not-required`; this keeps the
    // final-summary gate closed while still rendering a visible recovery region with
    // registered controls for the non-preservable element.
    result: existing?.result ?? "not-required",
    controls,
    unresolvedPaths: existing?.unresolvedPaths ?? [],
  };
};

const warningFor = (element: NonPreservableElement): string =>
  `No es posible representar ${NON_PRESERVABLE_LABELS[element]} con el tamaño actual del terminal`;

/**
 * Recompute the presentation for a freshly detected capability snapshot.
 *
 * The session state is not rebuilt: the prior object is spread so approvals, results,
 * scroll offset, unconfirmed inputs, validation, selections, focus, errors, warnings,
 * recovery, and every other named field are preserved (Requirements 1.9, 8.8, 9.4).
 *
 * When the candidate profile cannot represent the essential content, the current mode
 * is retained, the non-preservable element is identified, registered recovery controls
 * are exposed, and newly unsupported control sequences are suppressed (Requirement 8.9).
 */
export const applyPresentationTransition = (
  state: SessionState,
  capabilities: TerminalCapabilities,
  invocation: InvocationMode = { kind: "interactive" },
): PresentationTransition => {
  const candidate = selectRenderProfile(invocation, capabilities);
  const element = nonPreservableElement(state, candidate);
  const suppressed = suppressedControls(state.presentation, candidate);

  if (element === undefined) {
    return {
      state: { ...state, presentation: candidate },
      profile: candidate,
      preserved: true,
      nonPreservable: undefined,
      suppressed,
      error: undefined,
    };
  }

  const profile = retainedProfile(state.presentation, candidate);
  const warning = warningFor(element);
  const warnings = state.warnings.includes(warning) ? state.warnings : [...state.warnings, warning];
  return {
    state: { ...state, presentation: profile, warnings, recovery: withRecovery(state) },
    profile,
    preserved: false,
    nonPreservable: element,
    suppressed: suppressedControls(state.presentation, profile),
    error: tuiError("PRESENTATION_TRANSITION_IMPOSSIBLE", warning, {
      recoverability: "manual-review",
      suggestedAction: "Aumente el tamaño del terminal o continúe en el modo actual",
    }),
  };
};

/** Alias used by callers that describe the operation as handling a resize event. */
export const applyResize = applyPresentationTransition;
