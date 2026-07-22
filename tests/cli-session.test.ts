import { describe, expect, it } from "vitest";
import { parseArgsResult, runCli } from "../src/cli/main.js";
import { SessionOrchestrator } from "../src/application/session/orchestrator.js";
import { createChangePlanner, ImmutableApprovalPolicy, ok } from "../src/domain/index.js";
import type { ComponentDefinition, FileChange, ProjectGateway, SessionStackAnalyzer, TransactionEngine, TransactionResult, UserInteraction } from "../src/domain/index.js";
import type { CanonicalPath, ComponentId, SafeProjectPath, Sha256 } from "../src/domain/shared/types.js";

const root = "/virtual/project" as CanonicalPath;
const digest = "0".repeat(64) as Sha256;
const project: ProjectGateway = {
  validateDirectory: async () => ok({ root, kind: "existing", projectFileCount: 1, recognizedAiConfig: [] }),
  inventory: async function* () { /* deterministic empty fixture */ },
  readRecognized: async () => ok(new Uint8Array()),
};
const emptyAnalysis: SessionStackAnalyzer = { analyze: async () => ok({ items: [], conflicts: [], analyzedFileCount: 0, analyzedBytes: 0, elapsedMs: 0, withinPerformanceProfile: true }) };
const noOpTransaction = (): TransactionEngine => ({
  apply: async (): Promise<TransactionResult> => ({ status: "committed", exitCode: 0, applied: [], skipped: [], warnings: [], errors: [], manualReviewPaths: [] }),
  recover: async () => ({ status: "restored", exitCode: 1, restored: [], manualReviewPaths: [], errors: [] }),
});
const baseUi = (selection: readonly ComponentId[] = [], review?: (plan: import("../src/domain/index.js").ChangePlan) => import("../src/domain/index.js").ApprovalDecisions): UserInteraction => ({
  chooseTarget: async () => String(root),
  resolveStack: async () => ({ items: [], resolvedConflicts: [], digest }),
  chooseMode: async () => "manual",
  selectComponents: async () => selection,
  reviewPlan: async (plan) => review?.(plan) ?? { planHash: plan.planHash, globalApproved: true, conflicts: {}, incompatibleComponents: [], networkOperations: [] },
  render: () => { /* assertion uses returned summary */ },
});
const component: ComponentDefinition = { id: "rule" as ComponentId, type: "agent-rule", name: "Rule", description: "Rule", compatibility: { op: "always" }, source: { kind: "builtin", origin: "test" } };
const change: FileChange = { id: "rule:rule", componentId: component.id, destination: ".kiro/rule.md" as SafeProjectPath, action: "create", reason: "test", conflict: "none", preview: { kind: "text", content: "rule", truncated: false } };

const makeOrchestrator = (overrides: Partial<ConstructorParameters<typeof SessionOrchestrator>[0]> = {}): SessionOrchestrator => new SessionOrchestrator({
  projectGateway: project,
  stackAnalyzer: emptyAnalysis,
  componentDefinitions: [component],
  projectionFactory: () => ({ project: async () => ok({ components: [{ component, compatibility: { compatible: true, satisfied: ["always"], unsatisfied: [], evidenceRefs: [] }, incompatibleOverride: false, present: false, destinations: [change.destination], fileChanges: [change], externalOperations: [] }], fileChanges: [change], externalOperations: [], warnings: [] }) }) as never,
  planner: createChangePlanner(),
  approvalPolicy: new ImmutableApprovalPolicy(),
  transactionFactory: noOpTransaction,
  ...overrides,
});

describe("CLI task 8", () => {
  it("parses the supported flags and rejects unknown or invalid arguments", () => {
    expect(parseArgsResult(["--path", "/tmp/project", "--mode", "manual", "--verbose", "--recover"])).toEqual({ ok: true, value: { targetPath: "/tmp/project", mode: "manual", verbose: true, recover: true } });
    expect(parseArgsResult(["--mode", "invalid"])).toMatchObject({ ok: false });
    expect(parseArgsResult(["--unknown"])).toMatchObject({ ok: false });
  });

  it("maps non-interactive execution to input error without starting the session", async () => {
    let called = false;
    const code = await runCli([], { terminal: { inputIsTTY: false, outputIsTTY: true }, session: { run: async () => { called = true; throw new Error("must not run"); } }, ui: baseUi() });
    expect(code).toBe(2);
    expect(called).toBe(false);
  });

  it("returns success with no plan or approval for an empty selection", async () => {
    const ui = baseUi([]);
    const summary = await makeOrchestrator().run({ targetPath: String(root), verbose: false, recover: false }, ui);
    expect(summary).toMatchObject({ status: "success", exitCode: 0, applied: [], skipped: [] });
  });

  it("returns code 2 for an invalid mode before analysis or mutation", async () => {
    let analyzed = false;
    let applied = false;
    const summary = await makeOrchestrator({ stackAnalyzer: { analyze: async () => { analyzed = true; return emptyAnalysis.analyze(root, {} as never); } }, transactionFactory: () => { applied = true; return noOpTransaction(); } }).run({ targetPath: String(root), mode: "broken", verbose: false, recover: false }, baseUi());
    expect(summary.exitCode).toBe(2);
    expect(analyzed).toBe(false);
    expect(applied).toBe(false);
  });

  it("cancels before prepare without invoking the transaction engine", async () => {
    let applied = false;
    const summary = await makeOrchestrator({ transactionFactory: () => { applied = true; return noOpTransaction(); } }).run({ targetPath: String(root), verbose: false, recover: false }, baseUi([component.id], (plan) => ({ planHash: plan.planHash, globalApproved: false, conflicts: {}, incompatibleComponents: [], networkOperations: [] })));
    expect(summary.status).toBe("cancelled");
    expect(summary.exitCode).toBe(0);
    expect(applied).toBe(false);
  });
});
