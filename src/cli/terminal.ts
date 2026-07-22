import type {
  ApprovalDecisions,
  ChangePlan,
  ComponentDefinition,
  ComponentSelectionView,
  CompatibilityDecision,
  ConfirmedStack,
  RedactedEvent,
  RunMode,
  StackConflict,
  UserInteraction,
} from "../domain/index.js";
import { asSha256 } from "../domain/index.js";

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
      const selected = await this.terminal.question("Selecciona el valor: ");
      const index = Number.parseInt(selected, 10) - 1;
      const candidate = Number.isInteger(index)
        ? conflict.candidates[index]
        : conflict.candidates.find((entry) => entry.id === selected.trim());
      if (candidate === undefined) throw new Error(`Valor de Stack inválido para ${conflict.category}`);
      result[conflict.category] = candidate.id;
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

  async selectComponents(view: ComponentSelectionView): Promise<readonly import("../domain/index.js").ComponentId[]> {
    this.terminal.write("Componentes disponibles:");
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
    const selected = listInput(await this.terminal.question("IDs a incluir (separados por coma; vacío cancela): "));
    return selected as readonly import("../domain/index.js").ComponentId[];
  }

  async confirmIncompatible(component: ComponentDefinition, decision: CompatibilityDecision): Promise<boolean> {
    return this.ask(`El componente ${component.name} es incompatible (${decision.unsatisfied.join("; ")}). ¿Incluirlo?`);
  }

  async confirmExternal(command: readonly string[], purpose: string): Promise<boolean> {
    return this.ask(`Se ejecutará ${command.join(" ")} (${purpose}). ¿Autorizar?`);
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
    const prefix = event.level === "error" ? "ERROR" : event.level === "warn" ? "WARN" : "INFO";
    this.terminal.write(`${prefix}: ${event.message}`);
    if (this.verbose && event.context !== undefined) this.terminal.write(JSON.stringify(event.context));
    if (event.category === "session" && event.context !== undefined) this.renderSummary(event.context);
  }

  private renderPlan(plan: ChangePlan): void {
    this.terminal.write(`\nPlan ${plan.planHash}`);
    for (const recommendation of plan.cliRecommendations ?? []) {
      this.terminal.write(`- CLI RECOMENDADA ${recommendation.cli} | razón=${recommendation.reason}`);
      this.terminal.write(
        `  tecnologías=${(recommendation.technologies ?? []).join(", ")} | evidencia=${recommendation.evidenceRefs.join(", ") || "no disponible"}`,
      );
      for (const instruction of recommendation.documentedInstructions ?? []) this.terminal.write(`  instrucción: ${instruction}`);
      this.terminal.write("  acción=documentar | ejecuta=no | instala=no | comprueba=no");
    }
    for (const change of plan.fileChanges) {
      this.terminal.write(
        `- ${change.action.toUpperCase()} ${canonical(plan.root, change.destination)} | componente=${change.componentId} | motivo=${change.reason} | conflicto=${change.conflict}`,
      );
      if (change.preview.kind === "text") this.terminal.write(`  preview: ${change.preview.content}`);
      else
        for (const field of change.preview.changes)
          this.terminal.write(`  ${field.action} ${field.path}: ${JSON.stringify(field.before)} -> ${JSON.stringify(field.after)}`);
    }
    for (const operation of plan.externalOperations)
      this.terminal.write(
        `- EXTERNAL ${operation.id} | comando=${operation.command.join(" ")} | origen=${operation.origin} | destino=${canonical(plan.root, operation.destination)} | propósito=${operation.purpose} | red=${operation.usesNetwork ? "sí" : "no"}`,
      );
    if (plan.fileChanges.length === 0 && plan.externalOperations.length === 0) this.terminal.write("(sin cambios)");
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
