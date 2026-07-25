import type {
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
import { asSha256, SecretRedactor } from "../domain/index.js";

// Modern TUI capability/input adapters extend this terminal boundary. They live in focused
// `./tui/` modules and are surfaced here so the CLI terminal entry point exposes both the existing
// line-oriented interaction and the new capability-probing, event-normalizing terminal port.
export * from "./tui/index.js";

export interface CliTerminal {
  readonly inputIsTTY: boolean;
  readonly outputIsTTY: boolean;
  question(prompt: string): Promise<string>;
  write(line: string): void;
  pauseInput?(): void;
  resumeInput?(): void;
  close?(): void;
}

const answerIsYes = (value: string): boolean => /^(y|yes|s|si|sí)$/iu.test(value.trim());
const answerIsNo = (value: string): boolean => /^(n|no)$/iu.test(value.trim());
const listInput = (value: string): readonly string[] => [
  ...new Set(
    value
      .split(/[\s,]+/u)
      .map((entry) => entry.trim())
      .filter(Boolean),
  ),
];
const canonical = (root: string, destination: string): string => `${root.replace(/[\\/]+$/u, "")}/${destination.replace(/^[/\\]+/u, "")}`;
const componentTypeLabel = (type: ComponentDefinition["type"]): string =>
  ({
    skill: "Skills",
    "mcp-server": "Servidores MCP",
    "agent-rule": "Reglas de agente",
    "agent-command": "Comandos de agente",
  })[type];

export class InteractiveUserInteraction implements UserInteraction {
  public constructor(
    private readonly terminal: CliTerminal,
    private readonly verbose = false,
    private readonly redactor: Redactor = new SecretRedactor(),
  ) {}

  async chooseTarget(initial?: string): Promise<string> {
    const answer = await this.terminal.question(`Proyecto${initial === undefined ? "" : ` [${initial}]`}: `);
    return answer.trim() || initial || ".";
  }

  async resolveStackSelection(conflicts: readonly StackConflict[]): Promise<Readonly<Partial<Record<StackConflict["category"], string>>>> {
    const result: Partial<Record<StackConflict["category"], string>> = {};
    for (const conflict of conflicts) {
      this.terminal.write(`Conflicto de Stack (${conflict.category}):`);
      conflict.candidates.forEach((candidate, index) => this.terminal.write(`  ${index + 1}. ${candidate.displayName} (${candidate.id})`));
      // An unusable answer must not end the session: the prompt is repeated until one of the listed
      // candidates is chosen, mirroring how the mode prompt recovers from a typo.
      let selected: (typeof conflict.candidates)[number] | undefined;
      while (selected === undefined) {
        const answer = (await this.terminal.question("Selecciona el valor (número o id): ")).trim();
        const index = Number.parseInt(answer, 10) - 1;
        selected = Number.isInteger(index) ? conflict.candidates[index] : undefined;
        selected ??= conflict.candidates.find((candidate) => candidate.id === answer);
        if (selected === undefined) this.terminal.write(`Valor inválido para ${conflict.category}. Elige uno de los mostrados arriba.`);
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

  async chooseMode(initial?: string): Promise<RunMode> {
    while (true) {
      const answer = await this.terminal.question(`Modo [auto/manual]${initial === undefined ? "" : ` [${initial}]`}: `);
      const value = (answer.trim() || initial || "").toLowerCase();
      if (value === "auto" || value === "manual") return value;
      this.terminal.write("Modo inválido. Los únicos modos válidos son auto y manual.");
      initial = undefined;
    }
  }

  async selectComponents(
    view: ComponentSelectionView,
    mode: RunMode = "manual",
  ): Promise<readonly import("../domain/index.js").ComponentId[]> {
    this.terminal.write(mode === "auto" ? "Componentes detectados para el modo automático:" : "Componentes disponibles:");
    if (view.cliRecommendations === undefined || view.cliRecommendations.length === 0)
      this.terminal.write("Recomendaciones de CLI: ninguna basada en el Stack confirmado.");
    else {
      this.terminal.write("Recomendaciones de CLI (solo documentación; no se ejecutan):");
      for (const recommendation of view.cliRecommendations) {
        this.terminal.write(`  ${recommendation.cli} — ${recommendation.reason}`);
        this.terminal.write(`    tecnologías: ${(recommendation.technologies ?? []).join(", ")}`);
        this.terminal.write(`    evidencia: ${recommendation.evidenceRefs.join(", ") || "no disponible"}`);
        this.terminal.write(`    ${recommendation.explanation}`);
      }
    }
    const groups = view.groups ?? [{ type: undefined, components: view.components }];
    for (const group of groups) {
      if (group.type !== undefined) this.terminal.write(`\n${componentTypeLabel(group.type)}:`);
      for (const component of group.components) {
        const compatibility = component.compatibility.compatible
          ? "compatible"
          : `incompatible: ${component.compatibility.unsatisfied.join("; ")}`;
        this.terminal.write(`  ${component.definition.id} — ${component.definition.name} [${compatibility}]`);
        this.terminal.write(`    ${component.definition.description}`);
        if (component.origin !== undefined) this.terminal.write(`    origen: ${component.origin}`);
        if (component.compatibility.evidenceRefs.length > 0)
          this.terminal.write(`    evidencia: ${component.compatibility.evidenceRefs.join(", ")}`);
      }
    }
    if (mode === "auto") {
      this.terminal.write("Modo automático: se incluirán todos los componentes compatibles mostrados arriba.");
      return view.components.map((component) => component.definition.id);
    }

    this.terminal.write("Escribe el ID que aparece al inicio de cada línea; no escribas el nombre interno del servidor MCP.");
    const mcpExample = view.components.find((component) => component.definition.type === "mcp-server");
    if (mcpExample !== undefined)
      this.terminal.write(`Ejemplo MCP: ${mcpExample.definition.id} (ese ID configura el servidor mostrado en la lista).`);
    const selected = listInput(await this.terminal.question("IDs de componentes a incluir (separados por coma; Enter cancela): "));
    return selected as readonly import("../domain/index.js").ComponentId[];
  }

  async confirmIncompatible(component: ComponentDefinition, decision: CompatibilityDecision): Promise<boolean> {
    return this.ask(`El componente ${component.name} es incompatible (${decision.unsatisfied.join("; ")}). ¿Incluirlo?`);
  }

  async confirmExternal(command: readonly string[], purpose: string): Promise<boolean> {
    const safeCommand = String(this.redactor.redact(command.join(" ")));
    const safePurpose = String(this.redactor.redact(purpose));
    this.terminal.write("\nProceso externo independiente");
    this.terminal.write(`Comando: ${safeCommand}`);
    for (const line of safePurpose.split("\n")) this.terminal.write(`- ${line}`);
    return this.ask("¿Abrir ahora la TUI oficial de autoskills?");
  }

  pauseForExternalProcess(): void {
    this.terminal.pauseInput?.();
  }

  resumeAfterExternalProcess(): void {
    this.terminal.resumeInput?.();
  }

  async confirmRecovery(journal: import("../domain/index.js").RecoveryJournal): Promise<boolean> {
    return this.ask(`Existe una transacción incompleta (${journal.runId}). ¿Intentar recuperación?`);
  }

  async reviewPlan(plan: ChangePlan): Promise<ApprovalDecisions> {
    this.renderPlan(plan);
    const conflicts: Record<string, "preserve" | "replace"> = {};
    for (const change of plan.fileChanges.filter(
      (entry) => entry.conflict !== "none" && (entry.action === "create" || entry.action === "modify"),
    )) {
      conflicts[change.id] = (await this.ask(`Conflicto en ${canonical(plan.root, change.destination)}: ¿reemplazar?`))
        ? "replace"
        : "preserve";
    }
    const needsGlobal =
      plan.fileChanges.some((change) => change.conflict === "none" && (change.action === "create" || change.action === "modify")) ||
      plan.externalOperations.length > 0;
    const globalApproved = needsGlobal && (await this.ask("¿Aprobar el plan completo?"));
    const networkOperations: string[] = [];
    for (const operation of plan.externalOperations)
      if (await this.ask(`¿Autorizar operación de red ${operation.id}?`)) networkOperations.push(operation.id);
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
    const prefix = event.level === "error" ? "ERROR" : event.level === "warn" ? "WARN" : "INFO";
    this.terminal.write(`${prefix}: ${safeMessage}`);
    if (this.verbose && safeContext !== undefined) this.terminal.write(JSON.stringify(safeContext));
    if (event.category === "session" && safeContext !== undefined) this.renderSummary(safeContext);
  }

  private renderPlan(plan: ChangePlan): void {
    const displayPlan = this.redactor.redact(plan) as ChangePlan;
    this.terminal.write(`\nPlan ${displayPlan.planHash}`);
    for (const recommendation of displayPlan.cliRecommendations ?? []) {
      this.terminal.write(`- CLI RECOMENDADA ${recommendation.cli} | razón=${recommendation.reason}`);
      this.terminal.write(
        `  tecnologías=${(recommendation.technologies ?? []).join(", ")} | evidencia=${recommendation.evidenceRefs.join(", ") || "no disponible"}`,
      );
      for (const instruction of recommendation.documentedInstructions ?? []) this.terminal.write(`  instrucción: ${instruction}`);
      this.terminal.write("  acción=documentar | ejecuta=no | instala=no | comprueba=no");
    }
    for (const change of displayPlan.fileChanges) {
      this.terminal.write(
        `- ${change.action.toUpperCase()} ${canonical(displayPlan.root, change.destination)} | componente=${change.componentId} | motivo=${change.reason} | conflicto=${change.conflict}`,
      );
      if (change.preview.kind === "text") this.terminal.write(`  preview: ${change.preview.content}`);
      else
        for (const field of change.preview.changes)
          this.terminal.write(`  ${field.action} ${field.path}: ${JSON.stringify(field.before)} -> ${JSON.stringify(field.after)}`);
    }
    for (const operation of displayPlan.externalOperations)
      this.terminal.write(
        `- EXTERNAL ${operation.id} | comando=${operation.command.join(" ")} | origen=${operation.origin} | destino=${canonical(displayPlan.root, operation.destination)} | propósito=${operation.purpose} | red=${operation.usesNetwork ? "sí" : "no"}`,
      );
    if (displayPlan.fileChanges.length === 0 && displayPlan.externalOperations.length === 0) this.terminal.write("(sin cambios)");
  }

  private async ask(prompt: string): Promise<boolean> {
    while (true) {
      const answer = await this.terminal.question(`${prompt} [s/n] `);
      if (answerIsYes(answer)) return true;
      if (answerIsNo(answer) || answer.trim() === "") return false;
    }
  }

  private renderSummary(context: Record<string, unknown>): void {
    const status = String(context.status ?? "");
    if (status.length > 0) this.terminal.write(`Resumen: ${status} (código ${String(context.exitCode ?? "")})`);
    for (const key of ["applied", "skipped", "warnings", "errors", "manualReviewPaths"]) {
      const value = context[key];
      if (Array.isArray(value) && value.length > 0) this.terminal.write(`${key}: ${value.join(", ")}`);
    }
  }
}
