import { describe, expect, it } from "vitest";
import { parseArgsResult, runCli } from "../src/cli/main.js";
import { SessionOrchestrator } from "../src/application/session/orchestrator.js";
import { createChangePlanner, ImmutableApprovalPolicy, ok } from "../src/domain/index.js";
import type {
  ComponentDefinition,
  FileChange,
  ProjectGateway,
  SessionStackAnalyzer,
  TransactionEngine,
  TransactionResult,
  UserInteraction,
} from "../src/domain/index.js";
import type { CanonicalPath, ComponentId, SafeProjectPath, Sha256 } from "../src/domain/shared/types.js";

const root = "/virtual/project" as CanonicalPath;
const digest = "0".repeat(64) as Sha256;
const project: ProjectGateway = {
  validateDirectory: async () => ok({ root, kind: "existing", projectFileCount: 1, recognizedAiConfig: [] }),
  inventory: async function* () {
    /* deterministic empty fixture */
  },
  readRecognized: async () => ok(new Uint8Array()),
};
const emptyAnalysis: SessionStackAnalyzer = {
  analyze: async () =>
    ok({ items: [], conflicts: [], analyzedFileCount: 0, analyzedBytes: 0, elapsedMs: 0, withinPerformanceProfile: true }),
};
const noOpTransaction = (): TransactionEngine => ({
  apply: async (): Promise<TransactionResult> => ({
    status: "committed",
    exitCode: 0,
    applied: [],
    skipped: [],
    warnings: [],
    errors: [],
    manualReviewPaths: [],
  }),
  recover: async () => ({ status: "restored", exitCode: 1, restored: [], manualReviewPaths: [], errors: [] }),
});
const baseUi = (
  selection: readonly ComponentId[] = [],
  review?: (plan: import("../src/domain/index.js").ChangePlan) => import("../src/domain/index.js").ApprovalDecisions,
): UserInteraction => ({
  chooseTarget: async () => String(root),
  resolveStack: async () => ({ items: [], resolvedConflicts: [], digest }),
  chooseMode: async () => "manual",
  selectComponents: async () => selection,
  reviewPlan: async (plan) =>
    review?.(plan) ?? { planHash: plan.planHash, globalApproved: true, conflicts: {}, incompatibleComponents: [], networkOperations: [] },
  render: () => {
    /* assertion uses returned summary */
  },
});
const component: ComponentDefinition = {
  id: "rule" as ComponentId,
  type: "agent-rule",
  name: "Rule",
  description: "Rule",
  compatibility: { op: "always" },
  source: { kind: "builtin", origin: "test" },
};
const change: FileChange = {
  id: "rule:rule",
  componentId: component.id,
  destination: ".kiro/rule.md" as SafeProjectPath,
  action: "create",
  reason: "test",
  conflict: "none",
  preview: { kind: "text", content: "rule", truncated: false },
};

const makeOrchestrator = (overrides: Partial<ConstructorParameters<typeof SessionOrchestrator>[0]> = {}): SessionOrchestrator =>
  new SessionOrchestrator({
    projectGateway: project,
    stackAnalyzer: emptyAnalysis,
    componentDefinitions: [component],
    projectionFactory: () =>
      ({
        project: async () =>
          ok({
            components: [
              {
                component,
                compatibility: { compatible: true, satisfied: ["always"], unsatisfied: [], evidenceRefs: [] },
                incompatibleOverride: false,
                present: false,
                destinations: [change.destination],
                fileChanges: [change],
                externalOperations: [],
              },
            ],
            fileChanges: [change],
            externalOperations: [],
            warnings: [],
          }),
      }) as never,
    planner: createChangePlanner(),
    approvalPolicy: new ImmutableApprovalPolicy(),
    transactionFactory: noOpTransaction,
    ...overrides,
  });

describe("CLI task 8", () => {
  it("parses the supported flags and rejects unknown or invalid arguments", () => {
    expect(parseArgsResult(["--path", "/tmp/project", "--mode", "manual", "--verbose", "--recover"])).toEqual({
      ok: true,
      value: { targetPath: "/tmp/project", mode: "manual", verbose: true, recover: true },
    });
    expect(parseArgsResult(["--mode", "invalid"])).toMatchObject({ ok: false });
    expect(parseArgsResult(["--unknown"])).toMatchObject({ ok: false });
  });

  it("maps non-interactive execution to input error without starting the session", async () => {
    let called = false;
    const code = await runCli([], {
      terminal: { inputIsTTY: false, outputIsTTY: true },
      session: {
        run: async () => {
          called = true;
          throw new Error("must not run");
        },
      },
      ui: baseUi(),
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
  });

  it("returns success with no plan or approval for an empty selection", async () => {
    const ui = baseUi([]);
    const summary = await makeOrchestrator().run({ targetPath: String(root), verbose: false, recover: false }, ui);
    expect(summary).toMatchObject({ status: "success", exitCode: 0, applied: [], skipped: [] });
  });

  it("executes the approved path, stack, mode, plan, and summary flow", async () => {
    const rendered: string[] = [];
    const ui = baseUi([component.id]);
    ui.render = (event) => rendered.push(event.category);
    let applied = false;
    const summary = await makeOrchestrator({
      transactionFactory: () => ({
        apply: async () => {
          applied = true;
          return {
            status: "committed",
            exitCode: 0,
            applied: ["rule:rule"] as never,
            skipped: [],
            warnings: [],
            errors: [],
            manualReviewPaths: [],
          };
        },
        recover: async () => ({ status: "restored", exitCode: 1, restored: [], manualReviewPaths: [], errors: [] }),
      }),
    }).run({ targetPath: String(root), mode: "manual", verbose: false, recover: false }, ui);

    expect(summary).toMatchObject({ status: "success", exitCode: 0, applied: ["rule:rule"] });
    expect(applied).toBe(true);
    expect(rendered).toEqual(["project", "stack", "plan", "session"]);
  });

  it("handles unknown and incompatible selections without applying changes", async () => {
    const unknown = await makeOrchestrator().run(
      { targetPath: String(root), mode: "manual", verbose: false, recover: false },
      baseUi(["unknown" as ComponentId]),
    );
    expect(unknown.status).toBe("invalid-input");

    const incompatible = {
      ...component,
      compatibility: { op: "stack", category: "language", oneOf: ["typescript"] } as const,
    };
    const ui = baseUi([component.id]);
    ui.confirmIncompatible = async () => false;
    const omitted = await makeOrchestrator({ componentDefinitions: [incompatible] }).run(
      { targetPath: String(root), mode: "manual", verbose: false, recover: false },
      ui,
    );
    expect(omitted.status).toBe("success");
    expect(omitted.applied).toEqual([]);
  });

  it("handles catalog authorization/listing failures and invalid project analysis", async () => {
    const ui = baseUi([]);
    ui.confirmExternal = async () => false;
    const deniedCatalog = await makeOrchestrator({ catalogFactory: () => ({}) as never }).run(
      { targetPath: String(root), mode: "manual", verbose: false, recover: false },
      ui,
    );
    expect(deniedCatalog.status).toBe("success");

    const invalidProject = await makeOrchestrator({
      projectGateway: { validateDirectory: async () => ({ ok: false, error: { message: "missing", check: "existence" } }) as never },
    }).run({ targetPath: String(root), verbose: false, recover: false }, baseUi());
    expect(invalidProject.status).toBe("invalid-input");

    const failedAnalysis = await makeOrchestrator({
      stackAnalyzer: {
        analyze: async () => {
          throw new Error("analysis failed");
        },
      },
    }).run({ targetPath: String(root), verbose: false, recover: false }, baseUi());
    expect(failedAnalysis.status).toBe("invalid-input");
  });

  it("returns code 2 for an invalid mode before analysis or mutation", async () => {
    let analyzed = false;
    let applied = false;
    const summary = await makeOrchestrator({
      stackAnalyzer: {
        analyze: async () => {
          analyzed = true;
          return emptyAnalysis.analyze(root, {} as never);
        },
      },
      transactionFactory: () => {
        applied = true;
        return noOpTransaction();
      },
    }).run({ targetPath: String(root), mode: "broken", verbose: false, recover: false }, baseUi());
    expect(summary.exitCode).toBe(2);
    expect(analyzed).toBe(false);
    expect(applied).toBe(false);
  });

  it("cancels before prepare without invoking the transaction engine", async () => {
    let applied = false;
    const summary = await makeOrchestrator({
      transactionFactory: () => {
        applied = true;
        return noOpTransaction();
      },
    }).run(
      { targetPath: String(root), verbose: false, recover: false },
      baseUi([component.id], (plan) => ({
        planHash: plan.planHash,
        globalApproved: false,
        conflicts: {},
        incompatibleComponents: [],
        networkOperations: [],
      })),
    );
    expect(summary.status).toBe("cancelled");
    expect(summary.exitCode).toBe(0);
    expect(applied).toBe(false);
  });
});

describe("complete CLI journeys", () => {
  it("runs the automatic selection, approval, application, and summary path", async () => {
    const phases: string[] = [];
    const ui = baseUi([component.id]);
    ui.chooseMode = async () => {
      phases.push("mode:auto");
      return "auto";
    };
    ui.selectComponents = async () => {
      phases.push("selection");
      return [component.id];
    };
    ui.reviewPlan = async (plan) => {
      phases.push("approval");
      return { planHash: plan.planHash, globalApproved: true, conflicts: {}, incompatibleComponents: [], networkOperations: [] };
    };

    const summary = await makeOrchestrator({
      transactionFactory: () => ({
        apply: async () => {
          phases.push("apply");
          return {
            status: "committed",
            exitCode: 0,
            applied: ["rule:rule"] as never,
            skipped: [],
            warnings: [],
            errors: [],
            manualReviewPaths: [],
          };
        },
        recover: async () => ({ status: "restored", exitCode: 1, restored: [], manualReviewPaths: [], errors: [] }),
      }),
    }).run({ targetPath: String(root), verbose: false, recover: false }, ui);

    expect(summary).toMatchObject({ status: "success", exitCode: 0, applied: ["rule:rule"] });
    expect(phases).toEqual(["mode:auto", "selection", "approval", "apply"]);
  });

  it("discloses and runs autoskills before continuing the approved local flow", async () => {
    const phases: string[] = [];
    const ui = baseUi([component.id]);
    ui.confirmExternal = async (command, purpose) => {
      phases.push("disclosure");
      expect(command).toEqual(["npx", "--yes", "autoskills"]);
      expect(purpose).toContain("no aparecen en el plan");
      expect(purpose).toContain("rollback");
      return true;
    };
    ui.pauseForExternalProcess = () => phases.push("pause");
    ui.resumeAfterExternalProcess = () => phases.push("resume");

    const summary = await makeOrchestrator({
      catalogFactory: () =>
        ({
          runInteractive: async () => {
            phases.push("autoskills");
            return ok(undefined);
          },
        }) as never,
      transactionFactory: () => ({
        apply: async () => {
          phases.push("apply-local");
          return {
            status: "committed",
            exitCode: 0,
            applied: ["rule:rule"] as never,
            skipped: [],
            warnings: [],
            errors: [],
            manualReviewPaths: [],
          };
        },
        recover: async () => ({ status: "restored", exitCode: 1, restored: [], manualReviewPaths: [], errors: [] }),
      }),
    }).run({ targetPath: String(root), mode: "manual", verbose: false, recover: false }, ui);

    expect(summary.status).toBe("success");
    expect(phases).toEqual(["disclosure", "pause", "autoskills", "resume", "apply-local"]);
  });
  it("continues after autoskills failure and redacts its error from the returned summary and event", async () => {
    const secret = "autoskills-private-token";
    const events: string[] = [];
    const ui = baseUi([]);
    ui.confirmExternal = async () => true;
    ui.pauseForExternalProcess = () => undefined;
    ui.resumeAfterExternalProcess = () => undefined;
    ui.render = (event) => events.push(JSON.stringify(event));

    const summary = await makeOrchestrator({
      catalogFactory: () =>
        ({
          runInteractive: async () => ({
            ok: false,
            error: { code: "CATALOG_EXECUTION_FAILED", message: `token=${secret}`, recoverability: "retry" },
          }),
        }) as never,
    }).run({ targetPath: String(root), mode: "manual", verbose: true, recover: false }, ui);

    const encoded = JSON.stringify(summary) + events.join("\n");
    expect(summary.status).toBe("success");
    expect(encoded).not.toContain(secret);
    expect(encoded).toContain("[REDACTED]");
  });

  it("does not launch autoskills when no explicit confirmation capability exists", async () => {
    let launched = false;
    const summary = await makeOrchestrator({
      catalogFactory: () =>
        ({
          runInteractive: async () => {
            launched = true;
            return ok(undefined);
          },
        }) as never,
    }).run({ targetPath: String(root), mode: "manual", verbose: false, recover: false }, baseUi([]));

    expect(summary.status).toBe("success");
    expect(launched).toBe(false);
    expect(summary.warnings).toContain("Ejecución de autoskills cancelada");
  });
});

describe("recovery and failed-application journeys", () => {
  const journal = {
    schemaVersion: 1,
    runId: "run-prev",
    root,
    planHash: "b".repeat(64),
    phase: "committing",
    entries: [],
    manualReviewPaths: [],
  } as never;

  it("recovers an incomplete transaction when --recover is requested", async () => {
    const summary = await makeOrchestrator({
      recoveryFactory: () => ({ find: async () => ({ kind: "recoverable", journal }) }),
      transactionFactory: () => ({
        apply: noOpTransaction().apply,
        recover: async () => ({ status: "restored", exitCode: 1, restored: ["file:demo"], manualReviewPaths: [], errors: [] }),
      }),
    }).run({ targetPath: String(root), verbose: false, recover: true }, baseUi());

    expect(summary).toMatchObject({ status: "failed-recovered", exitCode: 1 });
  });

  it("returns code 2 when --recover finds no recoverable transaction", async () => {
    const summary = await makeOrchestrator({
      recoveryFactory: () => ({ find: async () => ({ kind: "none" }) }),
    }).run({ targetPath: String(root), verbose: false, recover: true }, baseUi());

    expect(summary).toMatchObject({ status: "invalid-input", exitCode: 2 });
  });

  it("treats a corrupt journal as code 3 requiring manual review", async () => {
    const summary = await makeOrchestrator({
      recoveryFactory: () => ({
        find: async () => ({ kind: "corrupt", path: ".auto-ai-setup/transactions/run-x/journal.json", detail: "Unexpected token" }),
      }),
      transactionFactory: () => {
        throw new Error("must not attempt recovery on a corrupt journal");
      },
    }).run({ targetPath: String(root), verbose: false, recover: true }, baseUi());

    expect(summary).toMatchObject({ status: "incomplete", exitCode: 3 });
    expect(summary.manualReviewPaths).toContain(".auto-ai-setup/transactions/run-x/journal.json");
  });

  it("offers recovery on start and cancels when the user declines", async () => {
    const ui = baseUi();
    ui.confirmRecovery = async () => false;
    const summary = await makeOrchestrator({
      recoveryFactory: () => ({ find: async () => ({ kind: "recoverable", journal }) }),
    }).run({ targetPath: String(root), verbose: false, recover: false }, ui);

    expect(summary).toMatchObject({ status: "cancelled", exitCode: 0 });
  });

  it("maps an incomplete transaction result to code 3 with manual review paths", async () => {
    const summary = await makeOrchestrator({
      transactionFactory: () => ({
        apply: async () => ({
          status: "incomplete",
          exitCode: 3,
          applied: [],
          skipped: [],
          warnings: [],
          errors: ["commit failed"],
          manualReviewPaths: [".kiro/rule.md"] as never,
        }),
        recover: noOpTransaction().recover,
      }),
    }).run({ targetPath: String(root), mode: "manual", verbose: false, recover: false }, baseUi([component.id]));

    expect(summary).toMatchObject({ status: "incomplete", exitCode: 3 });
    expect(summary.manualReviewPaths).toContain(".kiro/rule.md");
  });

  it("maps a rolled-back failure to failed-recovered with code 1", async () => {
    const summary = await makeOrchestrator({
      transactionFactory: () => ({
        apply: async () => ({
          status: "rolled-back",
          exitCode: 1,
          applied: [],
          skipped: [],
          warnings: [],
          errors: ["write failed"],
          manualReviewPaths: [],
        }),
        recover: noOpTransaction().recover,
      }),
    }).run({ targetPath: String(root), mode: "manual", verbose: false, recover: false }, baseUi([component.id]));

    expect(summary).toMatchObject({ status: "failed-recovered", exitCode: 1 });
  });
});

describe("catalog listing and stack conflict resolution", () => {
  it("uses the catalog list fallback when no interactive TUI is offered", async () => {
    const ui = baseUi([]);
    ui.confirmExternal = async () => true;
    const summary = await makeOrchestrator({
      catalogFactory: () =>
        ({
          list: async () => ({ ok: false, error: { code: "CATALOG_EXECUTION_FAILED", message: "no catalog", recoverability: "retry" } }),
        }) as never,
    }).run({ targetPath: String(root), mode: "manual", verbose: false, recover: false }, ui);

    expect(summary.status).toBe("success");
    expect(summary.warnings).toContain("no catalog");
  });

  it("resolves a stack conflict through the selection resolver before planning", async () => {
    const conflictAnalysis: SessionStackAnalyzer = {
      analyze: async () =>
        ok({
          items: [],
          conflicts: [
            {
              category: "package-manager",
              candidates: [
                { category: "package-manager", id: "npm", displayName: "npm", evidence: [] },
                { category: "package-manager", id: "pnpm", displayName: "pnpm", evidence: [] },
              ],
            },
          ] as never,
          analyzedFileCount: 2,
          analyzedBytes: 10,
          elapsedMs: 1,
          withinPerformanceProfile: true,
        }),
    };
    const ui = baseUi([]);
    let asked = false;
    ui.resolveStack = async (conflicts) => {
      asked = true;
      expect(conflicts).toHaveLength(1);
      return { items: [], resolvedConflicts: conflicts, digest };
    };

    const summary = await makeOrchestrator({ stackAnalyzer: conflictAnalysis }).run(
      { targetPath: String(root), mode: "manual", verbose: false, recover: false },
      ui,
    );

    expect(asked).toBe(true);
    expect(summary.status).toBe("success");
  });
});
