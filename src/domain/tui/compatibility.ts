import {
  isKnown,
  isValidDimension,
  type CapabilityValue,
  type DimensionValue,
  type DowngradeReason,
  type InvocationMode,
  type PresentationMode,
  type RenderProfile,
  type SymbolSet,
  type TerminalCapabilities,
} from "./capabilities.js";
import { tuiError, type TuiResult } from "./errors.js";
import { ok, err } from "../shared/types.js";
import type { PositiveInteger } from "./values.js";

/**
 * Minimum terminal geometry that qualifies a terminal as "complete". Exactly
 * 80×24 satisfies the requirement, so the comparison is inclusive.
 */
const MIN_FULL_COLUMNS = 80;
const MIN_FULL_ROWS = 24;

/**
 * Unicode symbol set used when the active profile supports Unicode. Every symbol
 * has a distinguishable ASCII counterpart in {@link ASCII_SYMBOLS} so no meaning
 * is lost when Unicode is unavailable.
 */
export const UNICODE_SYMBOLS: SymbolSet = {
  focusMarker: "\u276F", // ❯
  selectedMarker: "\u25C9", // ◉
  unselectedMarker: "\u25CB", // ○
  bulletMarker: "\u2022", // •
  truncationIndicator: "\u2026", // …
  horizontalBorder: "\u2500", // ─
  verticalBorder: "\u2502", // │
  successIcon: "\u2714", // ✔
  warningIcon: "\u26A0", // ⚠
  errorIcon: "\u2716", // ✖
};

/** ASCII-only symbol set used whenever Unicode is unsupported or unknown. */
export const ASCII_SYMBOLS: SymbolSet = {
  focusMarker: ">",
  selectedMarker: "[x]",
  unselectedMarker: "[ ]",
  bulletMarker: "*",
  truncationIndicator: "...",
  horizontalBorder: "-",
  verticalBorder: "|",
  successIcon: "[OK]",
  warningIcon: "[!]",
  errorIcon: "[X]",
};

/** A capability is "supported" only when it is known to be `true`. Unknown never counts as supported. */
const isSupported = (capability: CapabilityValue<boolean>): boolean => isKnown(capability) && capability.value === true;

/** A capability is definitively unsupported only when it is known to be `false`. */
const isUnsupported = (capability: CapabilityValue<boolean>): boolean => isKnown(capability) && capability.value === false;

/** Resolve a dimension to its positive-integer value, or `undefined` when unknown/invalid. */
const dimensionValue = (dimension: DimensionValue): PositiveInteger | undefined =>
  isValidDimension(dimension) ? dimension.value : undefined;

/**
 * Deterministic, insertion-ordered collector for {@link DowngradeReason} values.
 * Reasons are deduplicated so each documented downgrade appears exactly once.
 */
class ReasonSet {
  private readonly seen = new Set<DowngradeReason>();
  private readonly ordered: DowngradeReason[] = [];

  add(reason: DowngradeReason): void {
    if (!this.seen.has(reason)) {
      this.seen.add(reason);
      this.ordered.push(reason);
    }
  }

  toArray(): readonly DowngradeReason[] {
    return [...this.ordered];
  }
}

/** Build the non-interactive profile: no controls, no ANSI, no color, no Unicode, no animation. */
const nonInteractiveProfile = (reasons: readonly DowngradeReason[]): RenderProfile => ({
  mode: "non-interactive",
  width: undefined,
  height: undefined,
  ansi: false,
  color: false,
  unicode: false,
  animation: false,
  mouse: false,
  symbols: ASCII_SYMBOLS,
  downgradeReasons: reasons,
});

/**
 * Map an invocation context and a detected capability snapshot to a conservative
 * {@link RenderProfile} using a deterministic, side-effect-free decision.
 *
 * The policy is conservative: an unknown capability is never treated as supported,
 * a non-empty `NO_COLOR` disables color, exactly 80×24 qualifies as full visual, and
 * a selected profile never enables ANSI, color, Unicode, animation, mouse, or symbol
 * resources that the terminal does not support. Every downgrade from full visual mode
 * is recorded as a typed {@link DowngradeReason}.
 */
export const selectRenderProfile = (invocation: InvocationMode, capabilities: TerminalCapabilities): RenderProfile => {
  // 1. Explicit non-interactive or JSON invocation never enters interactive presentation.
  if (invocation.kind !== "interactive") {
    return nonInteractiveProfile(["non-interactive-invocation"]);
  }

  // 2. A redirected (known non-TTY) input or output stream falls back to the existing
  //    non-interactive contract and emits no interactive controls or ANSI sequences.
  if (isUnsupported(capabilities.inputTty) || isUnsupported(capabilities.outputTty)) {
    return nonInteractiveProfile(["redirected-output"]);
  }

  const reasons = new ReasonSet();

  const columns = dimensionValue(capabilities.columns);
  const rows = dimensionValue(capabilities.rows);
  const dimensionsUnknown = capabilities.columns.kind === "unknown" || capabilities.rows.kind === "unknown";
  const dimensionsInvalid = capabilities.columns.kind === "invalid" || capabilities.rows.kind === "invalid";
  const dimensionsValid = columns !== undefined && rows !== undefined;

  // Any unknown core capability (TTY, ANSI, color, Unicode) forces linear text.
  const coreUnknown =
    !isKnown(capabilities.inputTty) ||
    !isKnown(capabilities.outputTty) ||
    !isKnown(capabilities.ansiCursor) ||
    !isKnown(capabilities.color) ||
    !isKnown(capabilities.unicode);

  const mode: PresentationMode = ((): PresentationMode => {
    if (coreUnknown || dimensionsUnknown || dimensionsInvalid) return "linear-text";
    if (isUnsupported(capabilities.ansiCursor)) return "linear-text";
    // ANSI cursor is supported and dimensions are valid at this point.
    if (dimensionsValid && columns >= MIN_FULL_COLUMNS && rows >= MIN_FULL_ROWS) return "full-visual";
    return "degraded";
  })();

  const interactive = mode === "full-visual" || mode === "degraded";

  // Resource flags are always bounded by both the selected mode and the detected capability.
  const color = interactive && isSupported(capabilities.color) && !capabilities.noColor;
  const unicode = interactive && isSupported(capabilities.unicode);
  const animation = interactive && !capabilities.noColor;
  const mouse = interactive && isSupported(capabilities.mouse);

  // Record every downgrade in a deterministic order.
  if (coreUnknown) reasons.add("unknown-capability");
  if (dimensionsUnknown) reasons.add("unknown-capability");
  if (dimensionsInvalid) reasons.add("invalid-dimensions");
  if (isUnsupported(capabilities.ansiCursor)) reasons.add("missing-ansi-cursor");
  if (mode === "degraded") reasons.add("undersized-dimensions");
  if (isUnsupported(capabilities.color)) reasons.add("missing-color");
  if (capabilities.noColor) reasons.add("no-color-requested");
  if (isUnsupported(capabilities.unicode)) reasons.add("missing-unicode");

  return {
    mode,
    width: columns,
    height: rows,
    ansi: interactive,
    color,
    unicode,
    animation,
    mouse,
    symbols: unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS,
    downgradeReasons: reasons.toArray(),
  };
};

/**
 * Profile invariant: a selected profile must never enable a resource the terminal
 * cannot support, and only interactive modes may emit ANSI control sequences. This
 * encodes the "essential content is always representable, unsupported adornments are
 * never enabled" guarantee as a checkable condition rather than a comment.
 */
export const renderProfileIsConservative = (profile: RenderProfile, capabilities: TerminalCapabilities): boolean => {
  const interactive = profile.mode === "full-visual" || profile.mode === "degraded";
  if (profile.ansi && !interactive) return false;
  if (profile.ansi && !isSupported(capabilities.ansiCursor)) return false;
  if (profile.color && (!isSupported(capabilities.color) || capabilities.noColor)) return false;
  if (profile.unicode && !isSupported(capabilities.unicode)) return false;
  if (profile.mouse && !isSupported(capabilities.mouse)) return false;
  if (profile.animation && capabilities.noColor) return false;
  if (profile.animation && !interactive) return false;
  // ASCII symbols must be used whenever Unicode is not enabled so meaning is preserved.
  if (!profile.unicode && profile.symbols !== ASCII_SYMBOLS) return false;
  return true;
};

/**
 * Validate that a profile upholds {@link renderProfileIsConservative}, returning a
 * typed {@link TuiResult} so callers at the domain boundary never rely on unclassified
 * exceptions. Profiles produced by {@link selectRenderProfile} always pass this check.
 */
export const assertConservativeProfile = (profile: RenderProfile, capabilities: TerminalCapabilities): TuiResult<RenderProfile> =>
  renderProfileIsConservative(profile, capabilities)
    ? ok(profile)
    : err(tuiError("INVALID_PROFILE", `Profile mode ${profile.mode} enables resources unsupported by the terminal`));
