/**
 * Invocation-mode routing, resolved before any TUI object is constructed.
 *
 * The modern presentation is an addition, not a replacement: an explicit non-interactive or JSON
 * invocation, a redirected standard stream, or missing automation input selects the existing
 * pipeline and never instantiates an interactive control, a frame, or a terminal adapter. The
 * existing syntax, options, stages, decisions, outputs, and exit codes are unchanged in those modes.
 */

import type { InvocationMode } from "../domain/tui/index.js";

/** The recognized non-interactive switches. Both are additive and optional. */
export const JSON_FLAG = "--json" as const;
export const NON_INTERACTIVE_FLAG = "--non-interactive" as const;
/**
 * Presentation switch for the static, animation-free presentation. It selects no invocation mode, so
 * it is recognized by the parser and resolved at the presentation boundary together with
 * `AUTO_AI_SETUP_NO_ANIMATION`; see `./tui/animation-preference.ts` for the documented precedence.
 */
export const NO_ANIMATION_FLAG = "--no-animation" as const;

/** Why a mode was selected; used for diagnostics and tests, never for control flow elsewhere. */
export type InvocationReason = "json-flag" | "non-interactive-flag" | "redirected-stdin" | "redirected-stdout" | "interactive-tty";

/** Everything needed to decide the invocation mode without touching a terminal. */
export interface InvocationContext {
  readonly args: readonly string[];
  readonly inputIsTTY: boolean;
  readonly outputIsTTY: boolean;
}

/** The resolved routing decision. */
export interface ResolvedInvocation {
  readonly mode: InvocationMode;
  readonly reason: InvocationReason;
  /** True only when the modern interactive presentation may be constructed at all. */
  readonly interactiveAllowed: boolean;
}

const has = (args: readonly string[], flag: string): boolean => args.includes(flag);

/**
 * Resolve the invocation mode. Precedence is explicit flags first, then stream redirection, so an
 * automated caller can force the machine-readable contract even on a TTY.
 */
export const resolveInvocation = (context: InvocationContext): ResolvedInvocation => {
  if (has(context.args, JSON_FLAG)) return { mode: { kind: "json" }, reason: "json-flag", interactiveAllowed: false };
  if (has(context.args, NON_INTERACTIVE_FLAG)) {
    return { mode: { kind: "non-interactive" }, reason: "non-interactive-flag", interactiveAllowed: false };
  }
  if (!context.inputIsTTY) return { mode: { kind: "non-interactive" }, reason: "redirected-stdin", interactiveAllowed: false };
  if (!context.outputIsTTY) return { mode: { kind: "non-interactive" }, reason: "redirected-stdout", interactiveAllowed: false };
  return { mode: { kind: "interactive" }, reason: "interactive-tty", interactiveAllowed: true };
};

/** Convenience predicate for composition roots. */
export const isInteractiveInvocation = (context: InvocationContext): boolean => resolveInvocation(context).interactiveAllowed;

/**
 * A non-interactive run needs every required decision up front. This CLI's automated decisions are
 * `--path` and `--mode`; without them the run must finish immediately instead of waiting for input,
 * leaving the project in an equivalent state.
 */
export interface AutomationInput {
  readonly targetPath?: string | undefined;
  readonly mode?: string | undefined;
  readonly recover: boolean;
}

/** The names of the inputs a non-interactive run requires but did not receive. */
export const missingAutomationInput = (input: AutomationInput): readonly string[] => {
  const missing: string[] = [];
  // Every automated run needs a target: the session resolves the journal and the plan against a
  // canonical root, so a recovery without `--path` would fail later with no usable diagnosis.
  if (input.targetPath === undefined || input.targetPath.length === 0) missing.push("--path");
  // A recovery needs no selection decisions: it replays a persisted journal.
  if (!input.recover && input.mode !== "auto" && input.mode !== "manual") missing.push("--mode");
  return missing;
};
