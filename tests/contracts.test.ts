import { describe, expect, it } from "vitest";
import {
  asProjectRelativePath,
  exitCodeForStatus,
  isSafeRelativePath,
  validateApprovedPlan,
  validatePlanInvariants,
} from "../src/domain/index.js";
import type { ApprovalDecisions, ChangePlan } from "../src/domain/index.js";
import { FakeClock, FakeUuidGenerator, ScriptedUserInteraction } from "./support/fakes.js";
import { virtualProject } from "./support/fixtures.js";

describe("shared domain contracts", () => {
  it("accepts safe relative paths and rejects traversal, absolute and NUL paths", () => {
    expect(isSafeRelativePath(".kiro/prompts/setup.md")).toBe(true);
    expect(isSafeRelativePath("../outside")).toBe(false);
    expect(isSafeRelativePath("/outside")).toBe(false);
    expect(isSafeRelativePath(".kiro\0settings")).toBe(false);
    expect(asProjectRelativePath(".kiro/prompts/setup.md").ok).toBe(true);
  });

  it("maps terminal execution states to the documented exit codes", () => {
    expect(exitCodeForStatus("success")).toBe(0);
    expect(exitCodeForStatus("cancelled")).toBe(0);
    expect(exitCodeForStatus("failed-recovered")).toBe(1);
    expect(exitCodeForStatus("invalid-input")).toBe(2);
    expect(exitCodeForStatus("incomplete")).toBe(3);
  });

  it("provides deterministic clocks, UUIDs, fixtures and scripted interaction", async () => {
    const clock = new FakeClock();
    const ids = new FakeUuidGenerator("test");
    expect(clock.now()).toBe("2025-01-01T00:00:00.000Z");
    expect(ids.next()).toBe("test-0001");
    clock.advance(250);
    expect(clock.monotonicMs()).toBe(250);
    expect(ids.next()).toBe("test-0002");

    const fixture = virtualProject({ "package.json": "{}" });
    expect(await fixture.fs.exists(fixture.files["package.json"]!)).toBe(true);
    const interaction = new ScriptedUserInteraction({ targets: ["/virtual/project"], modes: ["manual"] });
    expect(await interaction.chooseTarget()).toBe("/virtual/project");
    expect(await interaction.chooseMode()).toBe("manual");
  });

  it("rejects duplicate managed destinations at the domain boundary", () => {
    const plan = minimalPlan([
      { id: "a", destination: "a.json" },
      { id: "b", destination: "a.json" },
    ]);
    expect(validatePlanInvariants(plan).ok).toBe(false);
  });

  it("creates an approved plan only from decisions bound to the exact plan hash", () => {
    const plan = minimalPlan([{ id: "a", destination: "a.json" }]);
    const approval: ApprovalDecisions = {
      planHash: plan.planHash,
      globalApproved: true,
      conflicts: {},
      incompatibleComponents: [],
      networkOperations: [],
    };
    const result = validateApprovedPlan(plan, approval);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.approvedFileChangeIds).toEqual(["a"]);
    expect(validateApprovedPlan(plan, { ...approval, planHash: "0".repeat(64) as never }).ok).toBe(false);
  });
});

const minimalPlan = (changes: readonly { id: string; destination: string }[]): ChangePlan => ({
  schemaVersion: 1,
  runId: "run-1" as never,
  root: "/virtual/project" as never,
  mode: "manual",
  confirmedStackDigest: "a".repeat(64) as never,
  createdAt: "2025-01-01T00:00:00.000Z",
  fileChanges: changes.map((change) => ({
    id: change.id,
    componentId: "component" as never,
    destination: change.destination as never,
    action: "create",
    reason: "test",
    conflict: "none",
    preview: { kind: "text", content: "", truncated: false },
  })),
  externalOperations: [],
  warnings: [],
  planHash: "b".repeat(64) as never,
});
