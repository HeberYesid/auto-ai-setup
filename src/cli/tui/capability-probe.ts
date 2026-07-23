/**
 * Terminal capability probing for the modern TUI.
 *
 * This module lives at the CLI boundary and turns already-collected platform values (TTY status,
 * dimensions, environment) into an immutable {@link TerminalCapabilities} snapshot from the pure
 * domain. It performs no I/O itself: the Node terminal adapter reads `process` streams/env once, at
 * the construction boundary, and hands the values here so the logic stays deterministic and
 * testable with injected values.
 *
 * Detection is conservative: whenever a capability cannot be determined, an explicit `unknown`
 * variant is returned rather than guessing, and the pure compatibility policy treats unknown as
 * unsupported.
 */

import {
  dimensionFromNumber,
  knownCapability,
  unknownCapability,
  unknownDimension,
  type CapabilityValue,
  type DimensionValue,
  type TerminalCapabilities,
} from "../../domain/tui/index.js";

/** Reads an environment variable by name, returning `undefined` when unset. */
export type EnvLookup = (name: string) => string | undefined;

/** Optional explicit capability overrides, primarily for tests and future direct capability queries. */
export interface CapabilityOverrides {
  readonly ansiCursor?: CapabilityValue<boolean>;
  readonly color?: CapabilityValue<boolean>;
  readonly unicode?: CapabilityValue<boolean>;
  readonly mouse?: CapabilityValue<boolean>;
}

/** All platform values required to build a {@link TerminalCapabilities} snapshot. */
export interface CapabilityProbeInput {
  readonly inputIsTty: boolean;
  readonly outputIsTty: boolean;
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  readonly env: EnvLookup;
  readonly platform: string;
  readonly overrides?: CapabilityOverrides;
}

const isNonEmpty = (value: string | undefined): boolean => value !== undefined && value.trim() !== "";

/** A conventional truthy environment flag: present, non-empty, and not `0`/`false`. */
const isEnabledFlag = (value: string | undefined): boolean => isNonEmpty(value) && value !== "0" && value?.trim().toLowerCase() !== "false";

const isWindows = (platform: string, env: EnvLookup): boolean =>
  platform === "win32" || (env("OS") ?? "").toLowerCase().includes("windows");

/**
 * `NO_COLOR` convention: the variable is honored when present with any non-empty value. This is a
 * presentation preference, tracked separately from whether the terminal can render color at all.
 */
const detectNoColor = (env: EnvLookup): boolean => {
  const raw = env("NO_COLOR");
  return raw !== undefined && raw.length > 0;
};

/** ANSI cursor repositioning: supported on a live output TTY unless `TERM=dumb`; otherwise unknown. */
const detectAnsiCursor = (env: EnvLookup, outputIsTty: boolean): CapabilityValue<boolean> => {
  if (env("TERM") === "dumb") return knownCapability(false);
  if (!outputIsTty) return unknownCapability<boolean>();
  return knownCapability(true);
};

/** Color capability from `FORCE_COLOR`/`TERM`/TTY signals; unknown when output is not a live TTY. */
const detectColor = (env: EnvLookup, outputIsTty: boolean): CapabilityValue<boolean> => {
  if (env("TERM") === "dumb") return knownCapability(false);
  if (isEnabledFlag(env("FORCE_COLOR"))) return knownCapability(true);
  if (!outputIsTty) return unknownCapability<boolean>();
  return knownCapability(true);
};

/** Unicode capability from the active locale, plus Windows Terminal detection; unknown when uncertain. */
const detectUnicode = (env: EnvLookup, platform: string): CapabilityValue<boolean> => {
  const locale = env("LC_ALL") ?? env("LC_CTYPE") ?? env("LANG");
  if (locale !== undefined && /utf-?8/iu.test(locale)) return knownCapability(true);
  if (isWindows(platform, env)) {
    return isNonEmpty(env("WT_SESSION")) ? knownCapability(true) : unknownCapability<boolean>();
  }
  if (isNonEmpty(locale)) return knownCapability(false);
  return unknownCapability<boolean>();
};

/** Optional mouse capability. Claimed only for a live TTY with a known mouse-capable terminal. */
const detectMouse = (env: EnvLookup, outputIsTty: boolean): CapabilityValue<boolean> => {
  if (!outputIsTty) return knownCapability(false);
  if (isNonEmpty(env("WT_SESSION"))) return knownCapability(true);
  const term = env("TERM");
  if (term !== undefined && /xterm|screen|tmux|rxvt/iu.test(term)) return knownCapability(true);
  return unknownCapability<boolean>();
};

/** Classify a raw detected dimension into valid/invalid/unknown without guessing. */
const detectDimension = (value: number | undefined): DimensionValue =>
  value === undefined ? unknownDimension() : dimensionFromNumber(value);

/**
 * Build an immutable {@link TerminalCapabilities} snapshot from collected platform values. TTY
 * status is definitive on Node (a stream is a TTY or it is not), while ANSI/color/Unicode/mouse are
 * detected conservatively and may be `unknown`. Overrides, when provided, take precedence.
 */
export const probeCapabilities = (input: CapabilityProbeInput): TerminalCapabilities => {
  const overrides = input.overrides ?? {};
  return {
    inputTty: knownCapability(input.inputIsTty),
    outputTty: knownCapability(input.outputIsTty),
    ansiCursor: overrides.ansiCursor ?? detectAnsiCursor(input.env, input.outputIsTty),
    color: overrides.color ?? detectColor(input.env, input.outputIsTty),
    unicode: overrides.unicode ?? detectUnicode(input.env, input.platform),
    columns: detectDimension(input.columns),
    rows: detectDimension(input.rows),
    mouse: overrides.mouse ?? detectMouse(input.env, input.outputIsTty),
    noColor: detectNoColor(input.env),
  };
};
