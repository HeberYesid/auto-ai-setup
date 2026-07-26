/**
 * Non-interactive and JSON user interaction.
 *
 * An automated run owns no terminal, so it must never wait for input. Every decision is either
 * already present in the parsed invocation or defaults to rejection: consent for a mutation cannot
 * be inferred from the absence of a person, so an automated run previews the plan and applies
 * nothing. A decision that genuinely cannot be taken without a user fails immediately with the
 * existing invalid-input contract instead of blocking.
 */

import type {
  ApprovalDecisions,
  ChangePlan,
  ComponentId,
  ComponentSelectionView,
  ConfirmedStack,
  RedactedEvent,
  Redactor,
  RunMode,
  SessionInput,
  StackConflict,
  UserInteraction,
} from "../domain/index.js";
import { asSha256, SecretRedactor } from "../domain/index.js";

export interface AutomationInteractionOptions {
  /** Optional human-readable sink. The JSON mode leaves it undefined so stdout carries one value. */
  readonly write?: (line: string) => void;
  /** Adds the redacted event context to the human-readable sink, mirroring `--verbose`. */
  readonly verbose?: boolean;
  readonly redactor?: Redactor;
}

export class AutomationUserInteraction implements UserInteraction {
  private readonly redactor: Redactor;

  public constructor(
    private readonly input: SessionInput,
    private readonly options: AutomationInteractionOptions = {},
  ) {
    this.redactor = options.redactor ?? new SecretRedactor();
  }

  async chooseTarget(initial?: string): Promise<string> {
    const target = this.input.targetPath ?? initial;
    if (target === undefined || target.length === 0) throw new Error("Una ejecución no interactiva requiere --path");
    return target;
  }

  async resolveStack(conflicts: readonly StackConflict[]): Promise<ConfirmedStack> {
    // Picking one candidate over another is a user decision and must not be guessed.
    throw new Error(
      `Una ejecución no interactiva no puede resolver conflictos de Stack (${conflicts
        .map((conflict) => conflict.category)
        .join(", ")}); ejecuta la CLI de forma interactiva`,
    );
  }

  async chooseMode(initial?: string): Promise<RunMode> {
    const mode = this.input.mode ?? initial;
    if (mode !== "auto" && mode !== "manual") throw new Error("Una ejecución no interactiva requiere --mode auto o --mode manual");
    return mode;
  }

  async selectComponents(view: ComponentSelectionView, mode: RunMode = "manual"): Promise<readonly ComponentId[]> {
    if (mode === "manual")
      throw new Error("El modo manual requiere una selección interactiva; usa --mode auto para una ejecución automatizada");
    return view.components.filter((component) => component.compatibility.compatible).map((component) => component.definition.id);
  }

  async confirmIncompatible(): Promise<boolean> {
    return false;
  }

  async confirmExternal(): Promise<boolean> {
    return false;
  }

  async confirmRecovery(): Promise<boolean> {
    return false;
  }

  async reviewPlan(plan: ChangePlan): Promise<ApprovalDecisions> {
    const hash = asSha256(plan.planHash);
    if (!hash.ok) throw new Error("El hash del plan no es válido");
    // Default rejection: the plan is reported, and no mutation is authorized.
    return {
      planHash: hash.value,
      globalApproved: false,
      conflicts: Object.fromEntries(
        plan.fileChanges.filter((change) => change.conflict !== "none").map((change) => [change.id, "preserve" as const]),
      ),
      incompatibleComponents: [],
      networkOperations: [],
    };
  }

  render(event: RedactedEvent): void {
    if (this.options.write === undefined) return;
    const prefix = event.level === "error" ? "ERROR" : event.level === "warn" ? "WARN" : "INFO";
    this.options.write(`${prefix}: ${String(this.redactor.redact(event.message))}`);
    if (this.options.verbose === true && event.context !== undefined)
      this.options.write(JSON.stringify(this.redactor.redact(event.context)));
    // The final summary carries the reason for every non-zero exit. Without it a human-readable
    // automated run reported only `Estado: invalid-input`, leaving the cause visible in `--json`
    // alone.
    if (event.category === "session" && event.context !== undefined) this.renderSummary(event.context);
  }

  private renderSummary(context: Readonly<Record<string, unknown>>): void {
    const labels: Readonly<Record<string, string>> = {
      errors: "errores",
      warnings: "avisos",
      manualReviewPaths: "revisar a mano",
      applied: "aplicado",
      skipped: "omitido",
    };
    for (const [key, label] of Object.entries(labels)) {
      const value = context[key];
      if (!Array.isArray(value) || value.length === 0) continue;
      const level = key === "errors" ? "ERROR" : key === "warnings" ? "WARN" : "INFO";
      for (const entry of value) this.options.write?.(`${level}: ${label}: ${String(this.redactor.redact(String(entry)))}`);
    }
  }
}

export const createAutomationUserInteraction = (input: SessionInput, options?: AutomationInteractionOptions): UserInteraction =>
  new AutomationUserInteraction(input, options);
