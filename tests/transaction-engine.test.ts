import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApprovedPlan, FileChange, TransactionOperation } from "../src/domain/index.js";
import { asCanonicalPath, asComponentId, asSafeProjectPath, calculatePlanHash, err, ok } from "../src/domain/index.js";
import { createExecutionSummary, PersistentTransactionEngine } from "../src/infrastructure/transaction/index.js";
import { FakeFileSystem } from "./support/fakes.js";

const root = asCanonicalPath("/virtual/project");
if (!root.ok) throw new Error(root.error.message);
const safe = (path: string) => {
  const result = asSafeProjectPath(path);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const component = asComponentId("demo");
if (!component.ok) throw new Error(component.error.message);
const sha = (content: string) => createHash("sha256").update(content).digest("hex") as FileChange["afterDigest"];

const planFor = (content: string, action: FileChange["action"], beforeDigest?: FileChange["beforeDigest"]): ApprovedPlan => {
  const change: FileChange = {
    id: "file:demo",
    componentId: component.value,
    destination: safe(".kiro/prompts/demo.md"),
    action,
    reason: "test change",
    conflict: "none",
    ...(beforeDigest === undefined ? {} : { beforeDigest }),
    afterDigest: sha(content),
    preview: { kind: "text", content, truncated: false },
  };
  const unsigned = {
    schemaVersion: 1 as const,
    runId: "run-0001" as never,
    root: root.value,
    mode: "manual" as const,
    confirmedStackDigest: "0".repeat(64) as never,
    createdAt: "2025-01-01T00:00:00.000Z",
    fileChanges: [change],
    externalOperations: [],
    warnings: [],
  };
  const planHash = calculatePlanHash(unsigned);
  return {
    ...unsigned,
    planHash,
    approval: { planHash, globalApproved: true, conflicts: {}, incompatibleComponents: [], networkOperations: [] },
    approvedFileChangeIds: [change.id],
    approvedExternalOperationIds: [],
  };
};

describe("PersistentTransactionEngine", () => {
  it("commits approved content and makes a second equivalent run a no-op", async () => {
    const fileSystem = new FakeFileSystem();
    const engine = new PersistentTransactionEngine({ fileSystem, fileContents: new Map([["file:demo", new TextEncoder().encode("hello")]]) });
    const first = await engine.apply(planFor("hello", "create"), new AbortController().signal);
    expect(first.status).toBe("committed");
    expect(new TextDecoder().decode(await fileSystem.read(safe(".kiro/prompts/demo.md")))).toBe("hello");

    const secondPlan = { ...planFor("hello", "create"), runId: "run-0002" as never };
    const withoutHash = Object.fromEntries(Object.entries(secondPlan).filter(([key]) => !["planHash", "approval", "approvedFileChangeIds", "approvedExternalOperationIds"].includes(key)));
    const hash = calculatePlanHash(withoutHash as never);
    const second = await engine.apply({ ...secondPlan, planHash: hash, approval: { ...secondPlan.approval, planHash: hash } }, new AbortController().signal);
    expect(second.status).toBe("committed");
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain("file:demo");
    expect(createExecutionSummary(secondPlan.runId, second).status).toBe("success");
  });

  it("restores a modified destination when the approved commit fails", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(".kiro/prompts/demo.md", "old");
    const plan = planFor("new", "modify", sha("old"));
    const failing: TransactionOperation = {
      async prepare() { return ok({ operationId: "file:demo", destination: safe(".kiro/prompts/demo.md"), desiredDigest: sha("new") }); },
      async verify() { return ok(undefined); },
      async commit() { return err({ code: "WRITE_FAILED", message: "injected write failure", recoverability: "rollback" }); },
      async rollback() { return ok(undefined); },
    };
    const engine = new PersistentTransactionEngine({ fileSystem, operations: new Map([["file:demo", failing]]) });
    const result = await engine.apply(plan, new AbortController().signal);
    expect(result.status).toBe("rolled-back");
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(await fileSystem.read(safe(".kiro/prompts/demo.md")))).toBe("old");
  });

  it("does not create a journal or acquire a lock when cancelled before prepare", async () => {
    const fileSystem = new FakeFileSystem();
    const controller = new AbortController();
    controller.abort();
    const engine = new PersistentTransactionEngine({ fileSystem, fileContents: new Map([["file:demo", new TextEncoder().encode("hello")]]) });
    const result = await engine.apply(planFor("hello", "create"), controller.signal);
    expect(result).toMatchObject({ status: "rolled-back", exitCode: 0, applied: [] });
    expect(await fileSystem.exists(safe(".auto-ai-setup/transactions/active"))).toBe(false);
  });
});
