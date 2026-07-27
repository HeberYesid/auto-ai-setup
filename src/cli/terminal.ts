import type {
  AgentId,
  ApprovalDecisions,
  ChangePlan,
  ComponentDefinition,
  ComponentSelectionView,
  CompatibilityDecision,
  ConfirmedStack,
  RedactedEvent,
  Redactor,
  RunMode,
  StackConflict,
  UserInteraction,
} from "../domain/index.js";
import { agentDescriptor, asSha256, SecretRedactor } from "../domain/index.js";
import {
  createStyle,
  defaultPresentationOptions,
  formatComponentCatalog,
  formatPlanReport,
  resolveSelectionAnswer,
  type PresentationOptions,
} from "./presentation.js";

// Modern TUI capability/input adapters extend this terminal boundary. They live in focused
// `./tui/` modules and are surfaced here so the CLI terminal entry point exposes both the existing
// line-oriented interaction and the new capability-probing, event-normalizing terminal port.
export * from "./tui/index.js";
export * from "./presentation.js";

export interface CliTerminal {
  readonly inputIsTTY: boolean;
  readonly outputIsTTY: boolean;
  /** Usable output width, when the platform reports one. Only affects wrapping and truncation. */
  readonly columns?: number | undefined;
  question(prompt: string): Promise<string>;
  write(line: string): void;
  pauseInput?(): void;
  resumeInput?(): void;
  close?(): void;
}

/**
 * Presentation preferences for the interactive interaction. Styling is off unless the composition
 * root enables it, so piped output and tests stay byte-stable.
 */
export interface InteractionPresentationOptions {
  readonly color?: boolean;
  readonly unicode?: boolean;
}

const answerIsYes = (value: string): boolean => /^(y|yes|s|si|sí)$/iu.test(value.trim());
const answerIsNo = (value: string): boolean => /^(n|no)$/iu.test(value.trim());

/** Short capability names shown next to each agent in the selection prompt. */
const COMPONENT_TYPE_SHORT: Readonly<Partial<Record<ComponentDefinition["type"], string>>> = {
  "mcp-server": "MCP",
  "agent-rule": "reglas",
  "agent-command": "comandos",
  "agent-hook": "hooks",
};

export class InteractiveUserInteraction implements UserInteraction {
  private readonly presentation: PresentationOptions;
  private readonly style: ReturnType<typeof createStyle>;

  public constructor(
    private readonly terminal: CliTerminal,
    private readonly verbose = false,
    private readonly redactor: Redactor = new SecretRedactor(),
    options: InteractionPresentationOptions = {},
  ) {
    this.presentation = {
      ...defaultPresentationOptions,
      color: options.color ?? false,
      unicode: options.unicode ?? defaultPresentationOptions.unicode,
      width: terminal.columns ?? defaultPresentationOptions.width,
      verbose,
    };
    this.style = createStyle(this.presentation.color);
  }

  async chooseTarget(initial?: string): Promise<string> {
    this.terminal.write("");
    this.terminal.write(this.style.bold("Paso 1. Proyecto a preparar"));
    this.terminal.write(this.style.dim("  Ruta del proyecto que se va a analizar. Enter usa el valor entre corchetes."));
    const answer = await this.terminal.question(`  Ruta${initial === undefined ? " [.]" : ` [${initial}]`}: `);
    return answer.trim() || initial || ".";
  }

  async resolveStackSelection(conflicts: readonly StackConflict[]): Promise<Readonly<Partial<Record<StackConflict["category"], string>>>> {
    const result: Partial<Record<StackConflict["category"], string>> = {};
    for (const conflict of conflicts) {
      this.terminal.write("");
      this.terminal.write(this.style.bold(`Conflicto de Stack (${conflict.category})`));
      this.terminal.write(this.style.dim("  Se detectó más de un candidato. Elige el que describe realmente al proyecto."));
      conflict.candidates.forEach((candidate, index) =>
        this.terminal.write(
          `  ${this.style.dim(`[${String(index + 1)}]`)} ${candidate.displayName} ${this.style.dim(`(${candidate.id})`)}`,
        ),
      );
      // An unusable answer must not end the session: the prompt is repeated until one of the listed
      // candidates is chosen, mirroring how the mode prompt recovers from a typo.
      let selected: (typeof conflict.candidates)[number] | undefined;
      while (selected === undefined) {
        const answer = (await this.terminal.question("  Elige un número o un id: ")).trim();
        const index = Number.parseInt(answer, 10) - 1;
        selected = Number.isInteger(index) ? conflict.candidates[index] : undefined;
        selected ??= conflict.candidates.find((candidate) => candidate.id === answer);
        if (selected === undefined)
          this.terminal.write(this.style.yellow(`  Valor inválido para ${conflict.category}. Escribe uno de los números o ids de arriba.`));
      }
      result[conflict.category] = selected.id;
    }
    return result;
  }

  async resolveStack(conflicts: readonly StackConflict[]): Promise<ConfirmedStack> {
    const selections = await this.resolveStackSelection(conflicts);
    const items = conflicts.flatMap((conflict) =>
      conflict.candidates.filter((candidate) => selections[conflict.category] === candidate.id),
    );
    return { items, resolvedConflicts: conflicts, digest: "" as ConfirmedStack["digest"] };
  }

  async chooseAgents(view: import("../domain/index.js").AgentSelectionView): Promise<readonly AgentId[]> {
    const detected = new Set(view.detected);
    this.terminal.write("");
    this.terminal.write(this.style.bold("Paso 2. Agentes de IA a configurar"));
    this.terminal.write(this.style.dim("  Solo se preparará configuración para los agentes que elijas aquí."));
    const numbered = view.candidates.map((agent, index) => ({ index: index + 1, id: String(agent) }));
    view.candidates.forEach((agent, index) => {
      const descriptor = agentDescriptor(agent);
      const supported = (Object.entries(descriptor.capabilities) as [ComponentDefinition["type"], { status: string }][])
        .filter(([type, capability]) => capability.status === "supported" && type !== "skill")
        .map(([type]) => COMPONENT_TYPE_SHORT[type] ?? type);
      const mark = detected.has(agent) ? this.style.green("ya presente en el proyecto") : this.style.dim("no detectado");
      this.terminal.write(
        `  ${this.style.dim(`[${String(index + 1)}]`)} ${this.style.bold(descriptor.label)} ${this.style.dim(`(${agent})`)} ${mark}`,
      );
      this.terminal.write(`      ${this.style.dim(`configura: ${supported.join(", ") || "nada en esta fase"}`)}`);
    });
    const defaults = view.detected.length > 0 ? view.detected : view.candidates;
    this.terminal.write(this.style.dim("  Escribe los números o los ids, separados por comas. `todos` o `*` selecciona todos."));
    this.terminal.write(
      this.style.dim(
        `  Enter usa ${view.detected.length > 0 ? "los agentes detectados" : "todos los agentes"}: ${defaults.join(", ")}. Escribe \`ninguno\` para no configurar nada.`,
      ),
    );
    while (true) {
      const answer = await this.terminal.question("  Agentes a configurar: ");
      const trimmed = answer.trim();
      if (trimmed === "") return defaults;
      if (/^(ninguno|none|0)$/iu.test(trimmed)) return [];
      const resolved = resolveSelectionAnswer(trimmed, numbered);
      if (resolved.unknown.length > 0) {
        this.terminal.write(
          this.style.yellow(`  No reconozco: ${resolved.unknown.join(", ")}. Usa los números o los ids mostrados arriba.`),
        );
        continue;
      }
      if (resolved.ids.length === 0) {
        this.terminal.write(this.style.yellow("  Selecciona al menos un agente o escribe `ninguno`."));
        continue;
      }
      return resolved.ids as readonly AgentId[];
    }
  }

  async chooseMode(initial?: string): Promise<RunMode> {
    this.terminal.write("");
    this.terminal.write(this.style.bold("Paso 3. Modo de selección"));
    this.terminal.write(this.style.dim("  auto   incluye todos los componentes compatibles con el stack detectado."));
    this.terminal.write(this.style.dim("  manual eliges tú, uno por uno, qué se configura."));
    while (true) {
      const answer = await this.terminal.question(`  Modo auto/manual${initial === undefined ? "" : ` [${initial}]`}: `);
      const value = (answer.trim() || initial || "").toLowerCase();
      if (value === "auto" || value === "manual") return value;
      this.terminal.write(this.style.yellow("  Modo inválido. Los únicos modos válidos son auto y manual."));
      initial = undefined;
    }
  }

  async selectComponents(
    view: ComponentSelectionView,
    mode: RunMode = "manual",
  ): Promise<readonly import("../domain/index.js").ComponentId[]> {
    const catalog = formatComponentCatalog(view, mode, this.presentation);
    for (const line of catalog.lines) this.terminal.write(line);

    if (mode === "auto") {
      this.terminal.write(this.style.dim("  Modo automático: se incluirán todos los componentes compatibles mostrados arriba."));
      return view.components.map((component) => component.definition.id);
    }

    this.terminal.write(this.style.dim("  Escribe los números entre corchetes o los ids, separados por comas."));
    this.terminal.write(this.style.dim("  Atajos: `todos` o `*` selecciona todo. Enter sin escribir nada cancela la ejecución."));
    while (true) {
      const answer = await this.terminal.question("  Componentes a incluir: ");
      if (answer.trim() === "") {
        this.terminal.write(this.style.dim("  Sin selección: no se preparará ningún cambio."));
        return [];
      }
      const resolved = resolveSelectionAnswer(answer, catalog.numbered);
      if (resolved.unknown.length > 0) {
        this.terminal.write(
          this.style.yellow(`  No reconozco: ${resolved.unknown.join(", ")}. Usa los números o los ids mostrados arriba.`),
        );
        continue;
      }
      return resolved.ids as readonly import("../domain/index.js").ComponentId[];
    }
  }

  async confirmIncompatible(component: ComponentDefinition, decision: CompatibilityDecision): Promise<boolean> {
    this.terminal.write("");
    this.terminal.write(this.style.yellow(`El componente ${component.name} no cumple sus requisitos:`));
    for (const reason of decision.unsatisfied) this.terminal.write(`  - ${reason}`);
    return this.ask("¿Incluirlo de todas formas?", false);
  }

  async confirmExternal(command: readonly string[], purpose: string): Promise<boolean> {
    const safeCommand = String(this.redactor.redact(command.join(" ")));
    const safePurpose = String(this.redactor.redact(purpose));
    this.terminal.write("");
    this.terminal.write(this.style.bold("Proceso externo independiente"));
    this.terminal.write(`  ${this.style.dim("comando:")} ${this.style.cyan(safeCommand)}`);
    for (const line of safePurpose.split("\n")) this.terminal.write(`  - ${line}`);
    return this.ask("¿Abrir ahora la TUI oficial de autoskills?", false);
  }

  pauseForExternalProcess(): void {
    this.terminal.pauseInput?.();
  }

  resumeAfterExternalProcess(): void {
    this.terminal.resumeInput?.();
  }

  async confirmRecovery(journal: import("../domain/index.js").RecoveryJournal): Promise<boolean> {
    this.terminal.write("");
    this.terminal.write(this.style.yellow(`Se encontró una transacción incompleta (${journal.runId}).`));
    this.terminal.write(this.style.dim("  La recuperación deja el proyecto en el estado previo a esa ejecución."));
    return this.ask("¿Intentar la recuperación ahora?", false);
  }

  async reviewPlan(plan: ChangePlan): Promise<ApprovalDecisions> {
    const displayPlan = this.redactor.redact(plan) as ChangePlan;
    for (const line of formatPlanReport(displayPlan, this.presentation)) this.terminal.write(line);

    const conflicts: Record<string, "preserve" | "replace"> = {};
    const conflicting = plan.fileChanges.filter(
      (entry) => entry.conflict !== "none" && (entry.action === "create" || entry.action === "modify"),
    );
    if (conflicting.length > 0) {
      this.terminal.write(this.style.bold("Conflictos que necesitan una decisión"));
      this.terminal.write(this.style.dim("  Responder `n` conserva tu archivo tal cual y descarta ese cambio."));
    }
    for (const change of conflicting) {
      const relative = this.relative(plan.root, change.destination);
      conflicts[change.id] = (await this.ask(`  ${relative}: ¿reemplazar el contenido actual?`, false)) ? "replace" : "preserve";
    }

    const needsGlobal =
      plan.fileChanges.some((change) => change.conflict === "none" && (change.action === "create" || change.action === "modify")) ||
      plan.externalOperations.length > 0;
    if (needsGlobal) this.terminal.write("");
    const globalApproved = needsGlobal && (await this.ask("¿Aplicar el plan mostrado arriba?", false));
    const networkOperations: string[] = [];
    for (const operation of plan.externalOperations)
      if (await this.ask(`¿Autorizar la operación externa ${operation.id}?`, false)) networkOperations.push(operation.id);
    const hash = asSha256(plan.planHash);
    if (!hash.ok) throw new Error("El hash del plan no es válido");
    return {
      planHash: hash.value,
      globalApproved,
      conflicts,
      incompatibleComponents: [
        ...new Set(plan.fileChanges.flatMap((change) => (change.incompatibleOverride === undefined ? [] : [change.componentId]))),
      ],
      networkOperations: networkOperations as import("../domain/index.js").OperationId[],
    };
  }

  render(event: RedactedEvent): void {
    const safeMessage = String(this.redactor.redact(event.message));
    const safeContext = event.context === undefined ? undefined : (this.redactor.redact(event.context) as Record<string, unknown>);
    const prefix =
      event.level === "error" ? this.style.red("ERROR") : event.level === "warn" ? this.style.yellow("WARN") : this.style.dim("INFO");
    this.terminal.write(`${prefix}: ${safeMessage}`);
    if (this.verbose && safeContext !== undefined) this.terminal.write(this.style.dim(JSON.stringify(safeContext)));
    if (event.category === "session" && safeContext !== undefined) this.renderSummary(safeContext);
  }

  private relative(root: string, destination: string): string {
    const normalizedRoot = root.replace(/\\/gu, "/").replace(/\/+$/u, "");
    const normalized = destination.replace(/\\/gu, "/").replace(/^\/+/u, "");
    return normalized.startsWith(`${normalizedRoot}/`) ? normalized.slice(normalizedRoot.length + 1) : normalized;
  }

  /**
   * Yes/no prompt. The default is always shown in the hint and applied on an empty answer, so a bare
   * Enter can never authorize a change by accident.
   */
  private async ask(prompt: string, defaultValue = false): Promise<boolean> {
    const hint = defaultValue ? "[S/n]" : "[s/N]";
    while (true) {
      const answer = await this.terminal.question(`${prompt} ${hint} `);
      if (answerIsYes(answer)) return true;
      if (answerIsNo(answer)) return false;
      if (answer.trim() === "") return defaultValue;
      this.terminal.write(this.style.dim("  Responde s (sí) o n (no)."));
    }
  }

  private renderSummary(context: Record<string, unknown>): void {
    const status = String(context.status ?? "");
    this.terminal.write("");
    if (status.length > 0)
      this.terminal.write(`${this.style.bold("Resumen:")} ${status} ${this.style.dim(`(código ${String(context.exitCode ?? "")})`)}`);
    const labels: Record<string, string> = {
      applied: "aplicado",
      skipped: "omitido",
      warnings: "avisos",
      errors: "errores",
      manualReviewPaths: "revisar a mano",
    };
    for (const key of ["applied", "skipped", "warnings", "errors", "manualReviewPaths"]) {
      const value = context[key];
      if (!Array.isArray(value) || value.length === 0) continue;
      const paint = key === "errors" ? this.style.red : key === "warnings" ? this.style.yellow : this.style.dim;
      this.terminal.write(`  ${paint(`${labels[key] ?? key}:`)} ${value.join(", ")}`);
    }
  }
}
