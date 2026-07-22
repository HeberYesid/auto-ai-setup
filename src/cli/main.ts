import type { SessionInput, UserInteraction } from "../application/session/contracts.js";
import type { ExitCode } from "../domain/shared/types.js";

export interface CliDependencies {
  readonly session?: {
    run(input: SessionInput, ui: UserInteraction): Promise<{ readonly exitCode: ExitCode }>;
  };
  readonly ui?: UserInteraction;
}

export const runCli = async (args: readonly string[] = [], dependencies: CliDependencies = {}): Promise<ExitCode> => {
  const input = parseArgs(args);
  if (!dependencies.session || !dependencies.ui) return 0;
  const summary = await dependencies.session.run(input, dependencies.ui);
  return summary.exitCode;
};

export const parseArgs = (args: readonly string[]): SessionInput => {
  let targetPath: string | undefined;
  let mode: string | undefined;
  let verbose = false;
  let recover = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--path") {
      const next = args[index + 1];
      if (next !== undefined) {
        targetPath = next;
        index += 1;
      }
    } else if (argument === "--mode") {
      const next = args[index + 1];
      if (next !== undefined) {
        mode = next;
        index += 1;
      }
    } else if (argument === "--verbose") {
      verbose = true;
    } else if (argument === "--recover") {
      recover = true;
    }
  }

  const input: SessionInput = { verbose, recover };
  if (targetPath !== undefined) return { ...input, targetPath };
  if (mode !== undefined) return { ...input, mode };
  return input;
};
