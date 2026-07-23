import { asPositiveInteger, type PositiveInteger } from "./values.js";

/**
 * A detected terminal capability whose value may not be knowable. Unknown values
 * are represented explicitly and are never treated as supported by policy.
 */
export type CapabilityValue<T> = { readonly kind: "known"; readonly value: T } | { readonly kind: "unknown" };

/**
 * A detected terminal dimension. A dimension is only valid when it is a positive
 * integer; non-positive or non-integer values are represented as `invalid`, and
 * undetectable values as `unknown`.
 */
export type DimensionValue =
  | { readonly kind: "valid"; readonly value: PositiveInteger }
  | { readonly kind: "invalid"; readonly raw: number }
  | { readonly kind: "unknown" };

/** Immutable snapshot of detected terminal capabilities before any output is emitted. */
export interface TerminalCapabilities {
  readonly inputTty: CapabilityValue<boolean>;
  readonly outputTty: CapabilityValue<boolean>;
  readonly ansiCursor: CapabilityValue<boolean>;
  readonly color: CapabilityValue<boolean>;
  readonly unicode: CapabilityValue<boolean>;
  readonly columns: DimensionValue;
  readonly rows: DimensionValue;
  readonly mouse: CapabilityValue<boolean>;
  /** `NO_COLOR` convention: present with a non-empty value requests colorless output. */
  readonly noColor: boolean;
}

/** How the CLI was invoked, which gates whether interactive presentation is eligible. */
export type InvocationMode = { readonly kind: "interactive" } | { readonly kind: "non-interactive" } | { readonly kind: "json" };

/** The selected presentation mode. `non-interactive` never renders interactive controls. */
export type PresentationMode = "full-visual" | "degraded" | "linear-text" | "non-interactive";

/** Closed set of reasons explaining why a profile downgraded from full visual mode. */
export type DowngradeReason =
  | "unknown-capability"
  | "invalid-dimensions"
  | "missing-ansi-cursor"
  | "missing-color"
  | "no-color-requested"
  | "missing-unicode"
  | "undersized-dimensions"
  | "redirected-output"
  | "non-interactive-invocation";

/**
 * Distinguishable text/symbol tokens for a profile. Every symbol has an ASCII-safe
 * fallback so meaning survives when Unicode is unavailable.
 */
export interface SymbolSet {
  readonly focusMarker: string;
  readonly selectedMarker: string;
  readonly unselectedMarker: string;
  readonly bulletMarker: string;
  readonly truncationIndicator: string;
  readonly horizontalBorder: string;
  readonly verticalBorder: string;
  readonly successIcon: string;
  readonly warningIcon: string;
  readonly errorIcon: string;
}

/**
 * A selected render profile. A profile never enables a capability that is not
 * supported by the detected terminal; unsupported color, Unicode, ANSI, animation,
 * and mouse resources are disabled and recorded in {@link RenderProfile.downgradeReasons}.
 */
export interface RenderProfile {
  readonly mode: PresentationMode;
  readonly width: PositiveInteger | undefined;
  readonly height: PositiveInteger | undefined;
  readonly ansi: boolean;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly animation: boolean;
  readonly mouse: boolean;
  readonly symbols: SymbolSet;
  readonly downgradeReasons: readonly DowngradeReason[];
}

/** Wrap a known capability value. */
export const knownCapability = <T>(value: T): CapabilityValue<T> => ({ kind: "known", value });

/** The unknown capability variant. */
export const unknownCapability = <T = never>(): CapabilityValue<T> => ({ kind: "unknown" });

/** Type guard narrowing a capability to its known variant. */
export const isKnown = <T>(capability: CapabilityValue<T>): capability is { readonly kind: "known"; readonly value: T } =>
  capability.kind === "known";

/** Construct a validated dimension from an already-branded positive integer. */
export const validDimension = (value: PositiveInteger): DimensionValue => ({ kind: "valid", value });

/** Construct an explicitly invalid dimension, preserving the raw detected value. */
export const invalidDimension = (raw: number): DimensionValue => ({ kind: "invalid", raw });

/** The unknown dimension variant. */
export const unknownDimension = (): DimensionValue => ({ kind: "unknown" });

/** Classify a raw detected number into a valid or invalid {@link DimensionValue}. */
export const dimensionFromNumber = (raw: number): DimensionValue => {
  const positive = asPositiveInteger(raw);
  return positive.ok ? { kind: "valid", value: positive.value } : { kind: "invalid", raw };
};

/** Type guard narrowing a dimension to its valid variant. */
export const isValidDimension = (dimension: DimensionValue): dimension is { readonly kind: "valid"; readonly value: PositiveInteger } =>
  dimension.kind === "valid";
