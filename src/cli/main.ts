import type { SessionInput, UserInteraction } from "../application/session/contracts.js";
import type { ExecutionSummary } from "../domain/observability/models.js";
import type { ExitCode } from "../domain/shared/types.js";
import { InteractiveUserInteraction, type CliTerminal } from "./terminal.js";
import { JSON_FLAG, NON_INTERACTIVE_FLAG, missingAutomationInput, resolveInvocation, type ResolvedInvocation } from "./invocation.js";
import { writeJsonSummary } from "./json-output.js";

export interface CliParseError {
  readonly code: "CLI_INVALID_ARGUMENT";
  readonly message: string;
  readonly argument?: string;
}

export type CliParseResult = { readonly ok: true; readonly value: SessionInput } | { readonly ok: false; readonly error: CliParseError };

export interface CliDependencies {
  readonly session?: { run(input: SessionInput, ui: UserInteraction): Promise<ExecutionSummary> };
  readonly ui?: UserInteraction;
  readonly terminal?: Pick<CliTerminal, "inputIsTTY" | "outputIsTTY">;
  /**
   * Sink for the machine-readable mode. It receives exactly one fully prepared, redacted, and
   * validated JSON value, or nothing at all when preparation fails.
   */
  readonly stdout?: (text: string) => void;
}

export const parseArgsResult = (args: readonly string[]): CliParseResult => {
  let targetPath: string | undefined;
  let mode: string | undefined;
  let verbose = false;
  let recover = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--path" || argument === "--mode") {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--"))
        return { ok: false, error: { code: "CLI_INVALID_ARGUMENT", message: `${argument} requiere un valor`, argument } };
      if (argument === "--path") targetPath = next;
      else mode = next;
      index += 1;
    } else if (argument === "--verbose") verbose = true;
    else if (argument === "--recover") recover = true;
    else if (argument === JSON_FLAG || argument === NON_INTERACTIVE_FLAG) {
      // Routing switches: recognized here so the existing parser does not reject them, and
      // consumed by resolveInvocation rather than by the session input contract.
      continue;
    } else
      return {
        ok: false,
        error: {
          code: "CLI_INVALID_ARGUMENT",
          message: `Argumento desconocido: ${argument}`,
          ...(argument === undefined ? {} : { argument }),
        },
      };
  }
  if (mode !== undefined && mode !== "auto" && mode !== "manual")
    return { ok: false, error: { code: "CLI_INVALID_ARGUMENT", message: "--mode solo acepta auto o manual", argument: mode } };
  return {
    ok: true,
    value: { ...(targetPath === undefined ? {} : { targetPath }), ...(mode === undefined ? {} : { mode }), verbose, recover },
  };
};

/** Backwards-compatible parser for consumers that already use parseArgs. */
export const parseArgs = (args: readonly string[] = []): SessionInput => {
  const parsed = parseArgsResult(args);
  if (!parsed.ok) return { verbose: false, recover: false, mode: parsed.error.message };
  return parsed.value;
};

/**
 * Runs the CLI. The invocation mode is resolved before anything interactive is constructed: an
 * explicit `--json`/`--non-interactive` switch, a redirected standard stream, or missing automation
 * input routes to the existing pipeline with its existing stages, outputs, and exit codes, and never
 * instantiates a TUI adapter or control.
 */
export const runCli = async (args: readonly string[] = [], dependencies: CliDependencies = {}): Promise<ExitCode> => {
  const parsed = parseArgsResult(args);
  if (!parsed.ok) return 2;

  const invocation: ResolvedInvocation = resolveInvocation({
    args,
    inputIsTTY: dependencies.terminal?.inputIsTTY ?? true,
    outputIsTTY: dependencies.terminal?.outputIsTTY ?? true,
  });

  // A non-interactive run must never wait for input it did not receive; it finishes immediately with
  // the existing invalid-input code and leaves the project untouched.
  if (!invocation.interactiveAllowed && missingAutomationInput(parsed.value).length > 0) return 2;

  if (dependencies.terminal !== undefined && (!dependencies.terminal.inputIsTTY || !dependencies.terminal.outputIsTTY)) return 2;
  if (dependencies.session === undefined || dependencies.ui === undefined) return 2;
  try {
    const summary = await dependencies.session.run(parsed.value, dependencies.ui);
    if (invocation.mode.kind === "json" && dependencies.stdout !== undefined) {
      const written = writeJsonSummary(summary, dependencies.stdout);
      // A preparation or redaction failure writes zero bytes and returns the controlled error code.
      if (!written.ok) return 3;
    }
    return summary.exitCode;
  } catch (cause) {
    return cause instanceof Error && /cancel|abort/i.test(cause.message) ? 0 : 3;
  }
};

export const createInteractiveUserInteraction = (terminal: CliTerminal, verbose = false): UserInteraction =>
  new InteractiveUserInteraction(terminal, verbose);
