import { randomUUID } from "node:crypto";
import type {
  ApprovalPolicy,
  AutoSkillsGateway,
  ChangePlanner,
  Clock,
  ComponentDefinition,
  ComponentId,
  ConfirmedStack,
  FileSystemPort,
  ProjectGateway,
  RecoveryJournal,
  RecoveryResult,
  Result,
  RunId,
  RunMode,
  ScanPolicy,
  SessionInput,
  StackAnalysis,
  StackDetectorRegistry,
  TransactionEngine,
  TransactionResult,
  UserInteraction,
  UuidGenerator,
  SessionOrchestratorPort,
  ApprovedPlan,
  CatalogSnapshot,
} from "../../domain/index.js";
import {
  createComponentSelectionView,
  digestConfirmedItems,
  err,
  evaluateCompatibility,
  isRunMode,
  ok,
  parseRecognizedEvidence,
  resolveStackConflicts,
  SecretRedactor,
} from "../../domain/index.js";
import type { EvidenceError, ExitCode, Redactor } from "../../domain/index.js";
import type { ExecutionSummary, RedactedEvent } from "../../domain/observability/models.js";
import type { SelectedComponent } from "./component-inspection.js";
import { ComponentInspectionProjection } from "./component-inspection.js";
import { aggregateDetections } from "../../domain/project/stack.js";
import { formatForPath } from "../../domain/project/evidence.js";

export interface SessionStackAnalyzer {
  analyze(root: import("../../domain/index.js").CanonicalPath, policy: ScanPolicy): Promise<Result<StackAnalysis, EvidenceError>>;
}

export type RecoveryLookup =
  | { readonly kind: "none" }
  | { readonly kind: "recoverable"; readonly journal: RecoveryJournal }
  | { readonly kind: "corrupt"; readonly path: string; readonly detail: string };

export interface RecoveryJournalReader {
  find(root: import("../../domain/index.js").CanonicalPath): Promise<RecoveryLookup>;
}

export interface SessionTransactionContext {
  readonly plan?: ApprovedPlan;
  readonly catalog?: CatalogSnapshot;
  readonly catalogGateway?: AutoSkillsGateway;
}

export interface SessionDependencies {
  readonly projectGateway: ProjectGateway;
  readonly stackAnalyzer: SessionStackAnalyzer;
  readonly detectorRegistry?: StackDetectorRegistry;
  readonly catalogFactory?: (root: import("../../domain/index.js").CanonicalPath) => AutoSkillsGateway;
  readonly componentDefinitions?: readonly ComponentDefinition[];
  readonly projectionFactory: (root: import("../../domain/index.js").CanonicalPath) => ComponentInspectionProjection;
  readonly planner: ChangePlanner;
  readonly approvalPolicy: ApprovalPolicy;
  readonly transactionFactory: (
    root: import("../../domain/index.js").CanonicalPath,
    context?: SessionTransactionContext,
  ) => TransactionEngine;
  readonly recoveryFactory?: (root: import("../../domain/index.js").CanonicalPath) => RecoveryJournalReader;
  readonly uuid?: UuidGenerator;
  readonly clock?: Clock;
  readonly scanPolicy?: ScanPolicy;
  readonly redactor?: Redactor;
}

const defaultUuid: UuidGenerator = { next: () => randomUUID() as RunId };
const defaultClock: Clock = { now: () => new Date().toISOString(), monotonicMs: () => Date.now() };
const defaultPolicy: ScanPolicy = {
  maxFiles: 10_000,
  maxBytes: 500_000_000 as never,
  maxFileBytes: 2_000_000 as never,
  concurrency: 8,
  excludedDirectories: [],
};
export const AUTOSKILLS_HANDOFF_NOTICE = [
  "La TUI oficial de autoskills se ejecuta como un proceso externo independiente.",
  "Puede usar Internet para descargar contenido y puede crear o modificar archivos seleccionados dentro de su propia interfaz.",
  "Sus acciones no aparecen en el plan de auto-ai-setup y no están cubiertas por su journal, rollback, recuperación ni garantía de idempotencia.",
  "Su salida se muestra directamente en la terminal y no puede ser redactada por auto-ai-setup.",
  "Si se cancela o falla, podrás continuar configurando MCP, reglas y comandos.",
].join("\n");
const isCancellation = (cause: unknown): boolean =>
  cause instanceof Error && (cause.name === "AbortError" || /cancel|abort|cancelaci[oó]n/i.test(cause.message));
const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const event = (
  runId: RunId,
  clock: Clock,
  redactor: Redactor,
  level: RedactedEvent["level"],
  category: RedactedEvent["category"],
  message: string,
  context?: Record<string, unknown>,
): RedactedEvent => {
  const safeContext = context === undefined ? undefined : (redactor.redact(context) as Record<string, unknown>);
  return {
    runId,
    timestamp: clock.now(),
    level,
    category,
    message: String(redactor.redact(message)),
    ...(safeContext === undefined ? {} : { context: safeContext }),
    redacted: true,
  };
};

const baseSummary = (
  runId: RunId,
  status: ExecutionSummary["status"],
  exitCode: ExitCode,
  errors: readonly string[] = [],
): ExecutionSummary => ({
  runId,
  status,
  exitCode,
  applied: [],
  skipped: [],
  warnings: [],
  errors: [...errors],
  manualReviewPaths: [],
});

const withAnalysis = (summary: ExecutionSummary, analysis: StackAnalysis): ExecutionSummary => ({
  ...summary,
  analysis: {
    analyzedFileCount: analysis.analyzedFileCount,
    elapsedMs: analysis.elapsedMs,
    peakRssBytes: 0,
    withinProfile: analysis.withinPerformanceProfile,
  },
});

export class ProjectEvidenceStackAnalyzer implements SessionStackAnalyzer {
  public constructor(
    private readonly project: ProjectGateway,
    private readonly registry: StackDetectorRegistry,
  ) {}

  public async analyze(
    root: import("../../domain/index.js").CanonicalPath,
    policy: ScanPolicy,
  ): Promise<Result<StackAnalysis, EvidenceError>> {
    const claims = [] as import("../../domain/index.js").DetectionClaim[];
    let files = 0;
    let bytes = 0;
    const started = Date.now();
    for await (const descriptor of this.project.inventory(root, policy)) {
      files += 1;
      bytes += Number(descriptor.bytes);
      const format = formatForPath(String(descriptor.path));
      if (format === undefined) continue;
      const detectors = this.registry.find(descriptor.path);
      if (detectors.length === 0) continue;
      const source = await this.project.readRecognized(descriptor.path, policy.maxFileBytes);
      if (!source.ok)
        return err({
          code: "UNREADABLE_EVIDENCE",
          message: source.error.message,
          path: String(descriptor.path),
          location: "1:1",
          recoverability: "none",
        });
      const parsed = parseRecognizedEvidence(descriptor.path, source.value, { format, maxBytes: policy.maxFileBytes });
      if (!parsed.ok) return parsed;
      for (const detector of detectors) claims.push(...detector.detect(parsed.value));
    }
    return ok(aggregateDetections(claims, { analyzedFileCount: files, analyzedBytes: bytes, elapsedMs: Date.now() - started }));
  }
}

export class FileSystemRecoveryJournalReader implements RecoveryJournalReader {
  public constructor(private readonly fileSystem: FileSystemPort) {}
  public async find(root: import("../../domain/index.js").CanonicalPath): Promise<RecoveryLookup> {
    for await (const descriptor of this.fileSystem.list(root)) {
      const path = String(descriptor.path);
      if (!path.startsWith(".auto-ai-setup/transactions/") || !path.endsWith("/journal.json")) continue;
      let value: RecoveryJournal;
      try {
        value = JSON.parse(new TextDecoder().decode(await this.fileSystem.read(descriptor.path))) as RecoveryJournal;
      } catch (cause) {
        // A journal that cannot be read or parsed is evidence of an interrupted
        // transaction whose outcome is unknown; it must not be treated as absent.
        return { kind: "corrupt", path, detail: cause instanceof Error ? cause.message : String(cause) };
      }
      if (value.root === root && value.phase !== "committed" && value.phase !== "rolled-back")
        return { kind: "recoverable", journal: value };
    }
    return { kind: "none" };
  }
}

export class SessionOrchestrator implements SessionOrchestratorPort {
  private readonly uuid: UuidGenerator;
  private readonly clock: Clock;
  private readonly policy: ScanPolicy;
  private readonly redactor: Redactor;
  public constructor(private readonly dependencies: SessionDependencies) {
    this.uuid = dependencies.uuid ?? defaultUuid;
    this.clock = dependencies.clock ?? defaultClock;
    this.policy = dependencies.scanPolicy ?? defaultPolicy;
    this.redactor = dependencies.redactor ?? new SecretRedactor();
  }

  public async run(input: SessionInput, ui: UserInteraction): Promise<ExecutionSummary> {
    const runId = this.uuid.next();
    const render = (
      level: RedactedEvent["level"],
      category: RedactedEvent["category"],
      message: string,
      context?: Record<string, unknown>,
    ): void => ui.render(event(runId, this.clock, this.redactor, level, category, message, context));
    if (input.mode !== undefined && !isRunMode(input.mode))
      return this.finish(baseSummary(runId, "invalid-input", 2, ["Modo inválido. Los únicos modos válidos son auto y manual"]), ui, render);
    let requestedPath: string;
    try {
      requestedPath = input.targetPath ?? (await ui.chooseTarget());
    } catch (cause) {
      return this.finish(
        baseSummary(
          runId,
          isCancellation(cause) ? "cancelled" : "invalid-input",
          isCancellation(cause) ? 0 : 2,
          isCancellation(cause) ? [] : [messageOf(cause)],
        ),
        ui,
        render,
      );
    }
    const validated = await this.dependencies.projectGateway.validateDirectory(requestedPath);
    if (!validated.ok)
      return this.finish(baseSummary(runId, "invalid-input", 2, [`${validated.error.check}: ${validated.error.message}`]), ui, render);
    const root = validated.value.root;
    render("info", "project", `Proyecto ${validated.value.kind}: ${root}`, { projectFileCount: validated.value.projectFileCount });

    const recoveryReader = this.dependencies.recoveryFactory?.(root);
    if (input.recover || recoveryReader !== undefined) {
      const lookup = (await recoveryReader?.find(root)) ?? { kind: "none" };
      if (lookup.kind === "corrupt") {
        render("error", "transaction", "Journal de transacción ilegible; se requiere revisión manual", { path: lookup.path });
        return this.finish(
          {
            ...baseSummary(runId, "incomplete", 3, [
              `El journal de transacción no pudo leerse (${lookup.detail}); revisa el estado del proyecto manualmente`,
            ]),
            manualReviewPaths: [lookup.path as never],
          },
          ui,
          render,
        );
      }
      if (input.recover && lookup.kind === "none")
        return this.finish(
          baseSummary(runId, "invalid-input", 2, ["No hay una transacción recuperable para la ruta seleccionada"]),
          ui,
          render,
        );
      if (lookup.kind === "recoverable") {
        if (input.recover || (await this.confirmRecovery(ui, lookup.journal))) {
          const recovery = await this.dependencies.transactionFactory(root).recover(lookup.journal);
          const summary = this.recoverySummary(runId, recovery);
          return this.finish(summary, ui, render);
        }
        return this.finish(baseSummary(runId, "cancelled", 0), ui, render);
      }
    }

    let analysis: StackAnalysis;
    try {
      const result = await this.dependencies.stackAnalyzer.analyze(root, this.policy);
      if (!result.ok) return this.finish(baseSummary(runId, "invalid-input", 2, [result.error.message]), ui, render);
      analysis = result.value;
    } catch (cause) {
      return this.finish(baseSummary(runId, "invalid-input", 2, [messageOf(cause)]), ui, render);
    }
    render("info", "stack", analysis.items.length === 0 ? "No se detectó un Stack compatible" : "Stack detectado", {
      items: analysis.items,
      conflicts: analysis.conflicts,
    });

    let stack: ConfirmedStack;
    try {
      stack = await this.confirmStack(analysis, ui);
    } catch (cause) {
      return this.finish(
        withAnalysis(
          baseSummary(
            runId,
            isCancellation(cause) ? "cancelled" : "invalid-input",
            isCancellation(cause) ? 0 : 2,
            isCancellation(cause) ? [] : [messageOf(cause)],
          ),
          analysis,
        ),
        ui,
        render,
      );
    }
    let catalog: CatalogSnapshot | undefined;
    let catalogGateway: AutoSkillsGateway | undefined;
    const catalogWarnings: string[] = [];
    if (this.dependencies.catalogFactory !== undefined) {
      catalogGateway = this.dependencies.catalogFactory(root);
      const command = ["npx", "--yes", "autoskills"] as const;
      const authorized = ui.confirmExternal !== undefined && (await ui.confirmExternal(command, AUTOSKILLS_HANDOFF_NOTICE));
      if (authorized) {
        const interactive = catalogGateway.runInteractive;
        if (interactive !== undefined) {
          ui.pauseForExternalProcess?.();
          try {
            const completed = await interactive.call(catalogGateway);
            if (!completed.ok)
              catalogWarnings.push(
                completed.error.cause === undefined ? completed.error.message : `${completed.error.message}: ${completed.error.cause}`,
              );
            else render("info", "catalog", "Autoskills finalizó; continuando con la configuración del proyecto");
          } finally {
            ui.resumeAfterExternalProcess?.();
          }
        } else {
          const listed = await catalogGateway.list();
          if (listed.ok) catalog = listed.value;
          else catalogWarnings.push(listed.error.message);
        }
      } else catalogWarnings.push("Ejecución de autoskills cancelada");
    }
    const definitions = [
      ...(this.dependencies.componentDefinitions ?? []),
      ...(catalog?.entries ?? []).map((entry): ComponentDefinition => ({
        id: entry.id,
        type: "skill",
        name: entry.name,
        description: entry.description,
        compatibility: entry.compatibility,
        source: { kind: "catalog", origin: entry.origin.repository, revision: entry.origin.commit, digest: catalog!.manifestDigest },
      })),
    ];
    const modeResult = await this.chooseMode(input.mode, ui);
    if (!modeResult.ok)
      return this.finish(withAnalysis(baseSummary(runId, "invalid-input", 2, [modeResult.message]), analysis), ui, render);
    const recommendations = (await import("../../domain/catalog/recommendations.js")).recommendClis(stack);
    const view = createComponentSelectionView(
      definitions,
      { stack, cliRecommendations: recommendations, ...(catalog === undefined ? {} : { catalog }) },
      modeResult.value === "manual",
    );
    let selectedIds: readonly ComponentId[] = [];
    if (definitions.length > 0)
      try {
        selectedIds = await ui.selectComponents(view);
      } catch (cause) {
        return this.finish(
          withAnalysis(
            baseSummary(
              runId,
              isCancellation(cause) ? "cancelled" : "invalid-input",
              isCancellation(cause) ? 0 : 2,
              isCancellation(cause) ? [] : [messageOf(cause)],
            ),
            analysis,
          ),
          ui,
          render,
        );
      }
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    if (selectedIds.some((id) => !byId.has(id)))
      return this.finish(
        withAnalysis(baseSummary(runId, "invalid-input", 2, ["La selección contiene un componente desconocido"]), analysis),
        ui,
        render,
      );
    if (selectedIds.length === 0)
      return this.finish(withAnalysis({ ...baseSummary(runId, "success", 0), warnings: catalogWarnings }, analysis), ui, render);

    const selections: SelectedComponent[] = [];
    for (const id of selectedIds) {
      const definition = byId.get(id)!;
      const decision = evaluateCompatibility(definition.compatibility, { stack, cliRecommendations: recommendations });
      let override = false;
      if (!decision.compatible && ui.confirmIncompatible !== undefined) override = await ui.confirmIncompatible(definition, decision);
      if (decision.compatible || override) selections.push({ definition, compatibility: decision, incompatibleOverride: override });
      else catalogWarnings.push(`Componente incompatible omitido: ${definition.name}`);
    }
    if (selections.length === 0)
      return this.finish(withAnalysis({ ...baseSummary(runId, "success", 0), warnings: catalogWarnings }, analysis), ui, render);

    const projection = await this.dependencies.projectionFactory(root).project({
      root,
      stack,
      cliRecommendations: recommendations,
      runId,
      selected: selections,
      ...(catalog === undefined ? {} : { catalog }),
    });
    if (!projection.ok)
      return this.finish(withAnalysis(baseSummary(runId, "invalid-input", 2, [projection.error.message]), analysis), ui, render);
    if (projection.value.components.length === 0)
      return this.finish(
        withAnalysis(
          {
            ...baseSummary(runId, "success", 0),
            warnings: [...catalogWarnings, ...projection.value.warnings.map((warning) => warning.message)],
          },
          analysis,
        ),
        ui,
        render,
      );
    const built = await this.dependencies.planner.build({
      runId,
      root,
      mode: modeResult.value,
      stack,
      components: projection.value.components.map((component) => component.component),
      fileChanges: projection.value.fileChanges,
      externalOperations: projection.value.externalOperations,
      ...(catalog === undefined ? {} : { catalogDigest: catalog.manifestDigest, catalogSourceRevision: catalog.sourceCommit }),
      cliRecommendations: recommendations,
      now: this.clock.now(),
    });
    if (!built.ok) return this.finish(withAnalysis(baseSummary(runId, "invalid-input", 2, [built.error.message]), analysis), ui, render);
    render("info", "plan", "Plan de cambios preparado", {
      planHash: built.value.planHash,
      fileChanges: built.value.fileChanges,
      externalOperations: built.value.externalOperations,
    });
    let decisions;
    try {
      decisions = await ui.reviewPlan(built.value);
    } catch (cause) {
      return this.finish(
        withAnalysis(
          baseSummary(
            runId,
            isCancellation(cause) ? "cancelled" : "invalid-input",
            isCancellation(cause) ? 0 : 2,
            isCancellation(cause) ? [] : [messageOf(cause)],
          ),
          analysis,
        ),
        ui,
        render,
      );
    }
    if (
      !decisions.globalApproved &&
      built.value.fileChanges.some((change) => change.conflict === "none" && (change.action === "create" || change.action === "modify")) &&
      built.value.externalOperations.length === 0
    )
      return this.finish(
        withAnalysis(
          { ...baseSummary(runId, "cancelled", 0), warnings: [...catalogWarnings, "Aplicación cancelada por el usuario"] },
          analysis,
        ),
        ui,
        render,
      );
    const approved = this.dependencies.approvalPolicy.evaluate(built.value, decisions);
    if (!approved.ok) {
      if (approved.error.code === "MISSING_APPROVAL" && !decisions.globalApproved)
        return this.finish(
          withAnalysis(
            { ...baseSummary(runId, "cancelled", 0), warnings: [...catalogWarnings, "Aplicación cancelada por el usuario"] },
            analysis,
          ),
          ui,
          render,
        );
      return this.finish(withAnalysis(baseSummary(runId, "invalid-input", 2, [approved.error.message]), analysis), ui, render);
    }
    const transaction = this.dependencies.transactionFactory(root, {
      plan: approved.value,
      ...(catalog === undefined ? {} : { catalog }),
      ...(catalogGateway === undefined ? {} : { catalogGateway }),
    });
    const result = await transaction.apply(approved.value, new AbortController().signal);
    const summary = this.transactionSummary(runId, result, analysis, catalogWarnings);
    return this.finish(summary, ui, render);
  }

  private async chooseMode(
    initial: string | undefined,
    ui: UserInteraction,
  ): Promise<{ ok: true; value: RunMode } | { ok: false; message: string }> {
    if (initial !== undefined && !isRunMode(initial))
      return { ok: false, message: "Modo inválido. Los únicos modos válidos son auto y manual" };
    try {
      return { ok: true, value: await ui.chooseMode(initial) };
    } catch (cause) {
      return { ok: false, message: messageOf(cause) };
    }
  }

  private async confirmStack(analysis: StackAnalysis, ui: UserInteraction): Promise<ConfirmedStack> {
    if (analysis.conflicts.length === 0)
      return { items: analysis.items, resolvedConflicts: [], digest: digestConfirmedItems(analysis.items) };
    if (ui.resolveStackSelection !== undefined) {
      const selected = await ui.resolveStackSelection(analysis.conflicts);
      const result = resolveStackConflicts(analysis, selected);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }
    return ui.resolveStack(analysis.conflicts);
  }

  private async confirmRecovery(ui: UserInteraction, journal: RecoveryJournal): Promise<boolean> {
    return ui.confirmRecovery === undefined ? true : ui.confirmRecovery(journal);
  }

  private recoverySummary(runId: RunId, recovery: RecoveryResult): ExecutionSummary {
    return {
      runId,
      status: recovery.status === "restored" ? "failed-recovered" : "incomplete",
      exitCode: recovery.exitCode,
      applied: [],
      skipped: [],
      warnings: [],
      errors: [...recovery.errors],
      recovery,
      manualReviewPaths: [...recovery.manualReviewPaths],
    };
  }

  private transactionSummary(
    runId: RunId,
    result: TransactionResult,
    analysis: StackAnalysis,
    warnings: readonly string[],
  ): ExecutionSummary {
    const status: ExecutionSummary["status"] =
      result.status === "committed"
        ? "success"
        : result.status === "rolled-back"
          ? result.exitCode === 0
            ? "cancelled"
            : "failed-recovered"
          : "incomplete";
    return {
      runId,
      status,
      exitCode: result.exitCode,
      applied: [...result.applied],
      skipped: [...result.skipped],
      warnings: [...warnings, ...result.warnings],
      errors: [...result.errors],
      manualReviewPaths: [...result.manualReviewPaths],
      analysis: {
        analyzedFileCount: analysis.analyzedFileCount,
        elapsedMs: analysis.elapsedMs,
        peakRssBytes: 0,
        withinProfile: analysis.withinPerformanceProfile,
      },
    };
  }

  private finish(
    summary: ExecutionSummary,
    ui: UserInteraction,
    render: (
      level: RedactedEvent["level"],
      category: RedactedEvent["category"],
      message: string,
      context?: Record<string, unknown>,
    ) => void,
  ): ExecutionSummary {
    const safeSummary = this.redactor.redact(summary) as ExecutionSummary;
    render(safeSummary.exitCode === 0 ? "info" : "error", "session", `Estado: ${safeSummary.status}`, {
      status: safeSummary.status,
      exitCode: safeSummary.exitCode,
      applied: safeSummary.applied,
      skipped: safeSummary.skipped,
      warnings: safeSummary.warnings,
      errors: safeSummary.errors,
      manualReviewPaths: safeSummary.manualReviewPaths,
    });
    return safeSummary;
  }
}

export const createSessionOrchestrator = (dependencies: SessionDependencies): SessionOrchestrator => new SessionOrchestrator(dependencies);
