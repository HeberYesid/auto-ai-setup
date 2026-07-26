import type { SessionInput, UserInteraction } from "../application/session/contracts.js";
import type { ExecutionSummary } from "../domain/observability/models.js";
import type { ExitCode } from "../domain/shared/types.js";
import { InteractiveUserInteraction, type CliTerminal, type InteractionPresentationOptions } from "./terminal.js";
import {
  JSON_FLAG,
  NON_INTERACTIVE_FLAG,
  NO_ANIMATION_FLAG,
  missingAutomationInput,
  resolveInvocation,
  type ResolvedInvocation,
} from "./invocation.js";
import { writeJsonSummary } from "./json-output.js";
import { createAutomationUserInteraction } from "./automation.js";

export interface CliParseError {
  readonly code: "CLI_INVALID_ARGUMENT";
  readonly message: string;
  readonly argument?: string;
}

export type CliParseResult = { readonly ok: true; readonly value: SessionInput } | { readonly ok: false; readonly error: CliParseError };

export interface CliDependencies {
  readonly session?: { run(input: SessionInput, ui: UserInteraction): Promise<ExecutionSummary> };
  readonly ui?: UserInteraction;
  /**
   * Builds the interactive interaction once the invocation is parsed, so presentation preferences
   * that live outside the session contract — such as `--verbose` — actually reach the renderer. It
   * takes precedence over the pre-built {@link CliDependencies.ui}, which cannot observe them.
   */
  readonly createUi?: (preferences: CliInteractionPreferences) => UserInteraction;
  readonly terminal?: Pick<CliTerminal, "inputIsTTY" | "outputIsTTY">;
  /**
   * Sink for the machine-readable mode. It receives exactly one fully prepared, redacted, and
   * validated JSON value, or nothing at all when preparation fails. Usage and version answers are
   * also written here, because they are requested output rather than diagnostics.
   */
  readonly stdout?: (text: string) => void;
  /** Diagnostic sink. Invocation errors are never mixed into stdout data. */
  readonly stderr?: (text: string) => void;
  /** Reported by `--version`; supplied by the composition root that owns the package metadata. */
  readonly version?: string;
}

/** Presentation preferences parsed from the invocation but owned by the CLI, not by the session. */
export interface CliInteractionPreferences {
  /** Adds stack evidence and decision context to every rendered event. */
  readonly verbose: boolean;
}

export const HELP_FLAGS = ["--help", "-h"] as const;
export const VERSION_FLAGS = ["--version", "-V"] as const;

/** Usage text for `--help` and for any invocation the parser rejects. */
export const usageText = (): string =>
  [
    "Uso: auto-ai-setup [opciones]",
    "",
    "Prepara un proyecto local para flujos de trabajo con agentes de IA. Muestra un plan de",
    "cambios determinista y no modifica nada sin aprobación explícita.",
    "",
    "Opciones:",
    "  --path <ruta>          Proyecto objetivo. Si se omite, se solicita interactivamente.",
    "                         Obligatorio en --non-interactive, --json y --recover sin TTY.",
    "  --mode auto|manual     Modo de selección. Si se omite, se solicita interactivamente.",
    "                         manual exige una terminal interactiva: en --non-interactive y",
    "                         --json solo es válido auto.",
    "  --verbose              Añade evidencias y decisiones de compatibilidad a los eventos.",
    "  --recover              Busca y recupera una transacción incompleta del proyecto.",
    "  --no-animation         Presentación estática, sin animaciones.",
    "  --non-interactive      No solicita nada; requiere --path y --mode auto. No aplica cambios.",
    "  --json                 Como --non-interactive y escribe un único resumen JSON en stdout.",
    "  -h, --help             Muestra esta ayuda en stdout.",
    "  -V, --version          Muestra la versión en stdout.",
    "",
    "Variables de entorno: NO_COLOR o TERM=dumb desactivan el color; AUTO_AI_SETUP_NO_ANIMATION",
    "con un valor no vacío equivale a --no-animation.",
    "",
    "Códigos de salida: 0 correcto o cancelado, 1 revertido, 2 entrada inválida, 3 incompleto.",
  ].join("\n");

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
    else if (argument === JSON_FLAG || argument === NON_INTERACTIVE_FLAG || argument === NO_ANIMATION_FLAG) {
      // Routing and presentation switches: recognized here so the existing parser does not reject
      // them, and consumed by resolveInvocation or by the presentation boundary rather than by the
      // session input contract.
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

/**
 * Backwards-compatible parser for consumers that already use parseArgs.
 *
 * A rejected invocation no longer fabricates a value: it yields the default input instead of placing
 * the error message in `mode`, where a caller could mistake it for a selection mode. Use
 * `parseArgsResult` when the rejection itself must be observed.
 */
export const parseArgs = (args: readonly string[] = []): SessionInput => {
  const parsed = parseArgsResult(args);
  return parsed.ok ? parsed.value : { verbose: false, recover: false };
};

/**
 * Runs the CLI. The invocation mode is resolved before anything interactive is constructed: an
 * explicit `--json`/`--non-interactive` switch, a redirected standard stream, or missing automation
 * input routes to the existing pipeline with its existing stages, outputs, and exit codes, and never
 * instantiates a TUI adapter or control.
 */
export const runCli = async (args: readonly string[] = [], dependencies: CliDependencies = {}): Promise<ExitCode> => {
  const diagnose = (text: string): void => dependencies.stderr?.(`${text}\n`);
  // Usage and version are requested output, not diagnostics: they go to stdout so `$(cli --version)`
  // and `cli --help | less` work. They are answered first because they need no project, no session,
  // and no terminal.
  const answer = (text: string): void => {
    if (dependencies.stdout === undefined) diagnose(text);
    else dependencies.stdout(`${text}\n`);
  };
  if (args.some((argument) => (HELP_FLAGS as readonly string[]).includes(argument))) {
    answer(usageText());
    return 0;
  }
  if (args.some((argument) => (VERSION_FLAGS as readonly string[]).includes(argument))) {
    answer(dependencies.version ?? "desconocida");
    return 0;
  }

  const parsed = parseArgsResult(args);
  if (!parsed.ok) {
    // An invocation error used to exit silently, leaving no way to tell what was wrong.
    diagnose(`auto-ai-setup: ${parsed.error.message}`);
    diagnose("");
    diagnose(usageText());
    return 2;
  }

  const invocation: ResolvedInvocation = resolveInvocation({
    args,
    inputIsTTY: dependencies.terminal?.inputIsTTY ?? true,
    outputIsTTY: dependencies.terminal?.outputIsTTY ?? true,
  });

  // A non-interactive run must never wait for input it did not receive; it finishes immediately with
  // the existing invalid-input code and leaves the project untouched.
  const missing = invocation.interactiveAllowed ? [] : missingAutomationInput(parsed.value);
  if (missing.length > 0) {
    diagnose(`auto-ai-setup: una ejecución no interactiva requiere ${missing.join(" y ")}`);
    return 2;
  }

  if (dependencies.session === undefined) return 2;
  // The interactive interaction is only usable on a real terminal. Every other invocation is served
  // by the automation interaction, which never prompts and never authorizes a mutation on its own,
  // so `--json` and `--non-interactive` stay usable in a pipe instead of failing closed.
  const interaction = invocation.interactiveAllowed
    ? (dependencies.createUi?.({ verbose: parsed.value.verbose }) ?? dependencies.ui)
    : createAutomationUserInteraction(parsed.value, {
        verbose: parsed.value.verbose,
        ...(invocation.mode.kind === "json" || dependencies.stdout === undefined
          ? {}
          : { write: (line: string) => dependencies.stdout?.(`${line}\n`) }),
      });
  if (interaction === undefined) return 2;
  try {
    const summary = await dependencies.session.run(parsed.value, interaction);
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

export const createInteractiveUserInteraction = (
  terminal: CliTerminal,
  verbose = false,
  presentation: InteractionPresentationOptions = {},
): UserInteraction => new InteractiveUserInteraction(terminal, verbose, undefined, presentation);
