import type { SessionInput, UserInteraction } from "../application/session/contracts.js";
import type { ExecutionSummary } from "../domain/observability/models.js";
import type { ExitCode } from "../domain/shared/types.js";
import { InteractiveUserInteraction, type CliTerminal } from "./terminal.js";

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
      if (next === undefined || next.startsWith("--")) return { ok: false, error: { code: "CLI_INVALID_ARGUMENT", message: `${argument} requiere un valor`, argument } };
      if (argument === "--path") targetPath = next;
      else mode = next;
      index += 1;
    } else if (argument === "--verbose") verbose = true;
    else if (argument === "--recover") recover = true;
    else return { ok: false, error: { code: "CLI_INVALID_ARGUMENT", message: `Argumento desconocido: ${argument}`, ...(argument === undefined ? {} : { argument }) } };
  }
  if (mode !== undefined && mode !== "auto" && mode !== "manual") return { ok: false, error: { code: "CLI_INVALID_ARGUMENT", message: "--mode solo acepta auto o manual", argument: mode } };
  return { ok: true, value: { ...(targetPath === undefined ? {} : { targetPath }), ...(mode === undefined ? {} : { mode }), verbose, recover } };
};

/** Backwards-compatible parser for consumers that already use parseArgs. */
export const parseArgs = (args: readonly string[] = []): SessionInput => {
  const parsed = parseArgsResult(args);
  if (!parsed.ok) return { verbose: false, recover: false, mode: parsed.error.message };
  return parsed.value;
};

export const runCli = async (args: readonly string[] = [], dependencies: CliDependencies = {}): Promise<ExitCode> => {
  const parsed = parseArgsResult(args);
  if (!parsed.ok) return 2;
  if (dependencies.terminal !== undefined && (!dependencies.terminal.inputIsTTY || !dependencies.terminal.outputIsTTY)) return 2;
  if (dependencies.session === undefined || dependencies.ui === undefined) return 2;
  try {
    const summary = await dependencies.session.run(parsed.value, dependencies.ui);
    return summary.exitCode;
  } catch (cause) {
    return cause instanceof Error && /cancel|abort/i.test(cause.message) ? 0 : 3;
  }
};

export const createInteractiveUserInteraction = (terminal: CliTerminal, verbose = false): UserInteraction => new InteractiveUserInteraction(terminal, verbose);
