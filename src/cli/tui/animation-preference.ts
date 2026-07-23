/**
 * No-animation preference resolution for the modern TUI.
 *
 * The preference is resolved once at the CLI boundary before first output using a fixed precedence:
 *   1. the `--no-animation` flag,
 *   2. the `AUTO_AI_SETUP_NO_ANIMATION` environment variable (any non-empty value),
 *   3. the documented in-session toggle key.
 *
 * A higher-precedence source that requests no animation cannot be overridden by a lower one. The
 * preference is additionally forced whenever the active profile is linear text / non-interactive or
 * `NO_COLOR` is active, so animation is never enabled in a mode that cannot represent it.
 */

import type { PresentationMode } from "../../domain/tui/index.js";

/** All inputs required to resolve the no-animation preference. */
export interface AnimationPreferenceInput {
  /** Whether `--no-animation` was passed on the command line. */
  readonly noAnimationFlag: boolean;
  /** Raw value of `AUTO_AI_SETUP_NO_ANIMATION`; any non-empty value requests no animation. */
  readonly envValue: string | undefined;
  /** Current state of the documented in-session toggle key. */
  readonly sessionToggle: boolean;
  /** The active presentation mode. */
  readonly mode: PresentationMode;
  /** Whether `NO_COLOR` is active. */
  readonly noColor: boolean;
}

/** Extract the `--no-animation` flag from raw command-line arguments. */
export const noAnimationFlagFromArgs = (argv: readonly string[]): boolean => argv.includes("--no-animation");

/**
 * Resolve whether animation must be suppressed. Linear-text/non-interactive modes and active
 * `NO_COLOR` force suppression; otherwise the flag, then the environment variable, then the in-session
 * toggle decide, in that order of precedence.
 */
export const resolveNoAnimation = (input: AnimationPreferenceInput): boolean => {
  if (input.mode === "linear-text" || input.mode === "non-interactive") return true;
  if (input.noColor) return true;
  if (input.noAnimationFlag) return true;
  if (input.envValue !== undefined && input.envValue.trim() !== "") return true;
  return input.sessionToggle;
};
