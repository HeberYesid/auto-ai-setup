import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ApprovedPlan, FileChange, TransactionOperation } from "../src/domain/index.js";
import { asCanonicalPath, asComponentId, asSafeProjectPath, calculatePlanHash, err, ok } from "../src/domain/index.js";
import { ContentFileOperation, createExecutionSummary, PersistentTransactionEngine } from "../src/infrastructure/transaction/index.js";
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
    const engine = new PersistentTransactionEngine({
      fileSystem,
      fileContents: new Map([["file:demo", new TextEncoder().encode("hello")]]),
    });
    const first = await engine.apply(planFor("hello", "create"), new AbortController().signal);
    expect(first.status).toBe("committed");
    expect(new TextDecoder().decode(await fileSystem.read(safe(".kiro/prompts/demo.md")))).toBe("hello");

    const secondPlan = { ...planFor("hello", "create"), runId: "run-0002" as never };
    const withoutHash = Object.fromEntries(
      Object.entries(secondPlan).filter(
        ([key]) => !["planHash", "approval", "approvedFileChangeIds", "approvedExternalOperationIds"].includes(key),
      ),
    );
    const hash = calculatePlanHash(withoutHash as never);
    const second = await engine.apply(
      { ...secondPlan, planHash: hash, approval: { ...secondPlan.approval, planHash: hash } },
      new AbortController().signal,
    );
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
      async prepare() {
        return ok({ operationId: "file:demo", destination: safe(".kiro/prompts/demo.md"), desiredDigest: sha("new") });
      },
      async verify() {
        return ok(undefined);
      },
      async commit() {
        return err({ code: "WRITE_FAILED", message: "injected write failure", recoverability: "rollback" });
      },
      async rollback() {
        return ok(undefined);
      },
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
    const engine = new PersistentTransactionEngine({
      fileSystem,
      fileContents: new Map([["file:demo", new TextEncoder().encode("hello")]]),
    });
    const result = await engine.apply(planFor("hello", "create"), controller.signal);
    expect(result).toMatchObject({ status: "rolled-back", exitCode: 0, applied: [] });
    expect(await fileSystem.exists(safe(".auto-ai-setup/transactions/active"))).toBe(false);
  });

  it("rejects malformed plans and terminal journals without mutating the project", async () => {
    const fileSystem = new FakeFileSystem();
    const engine = new PersistentTransactionEngine({ fileSystem });
    const valid = planFor("hello", "create");
    const invalid = await engine.apply({ ...valid, planHash: sha("invalid") }, new AbortController().signal);
    expect(invalid.status).toBe("incomplete");

    const journal = {
      schemaVersion: 1 as const,
      runId: "run-0001" as never,
      root: root.value,
      planHash: sha("journal"),
      phase: "committed" as const,
      entries: [],
      manualReviewPaths: [],
    };
    expect(await engine.recover(journal)).toMatchObject({ status: "restored", exitCode: 1 });
    expect(await engine.recover({ ...journal, schemaVersion: 2 as never })).toMatchObject({ status: "incomplete", exitCode: 3 });
  });

  it("maps prepare, verify, journal, and rollback failures to recoverable results", async () => {
    const prepareFailure: TransactionOperation = {
      async prepare() {
        return err({ code: "WRITE_FAILED", message: "prepare failed", recoverability: "rollback" });
      },
      async verify() {
        return ok(undefined);
      },
      async commit() {
        return ok({ operationId: "file:demo", destination: safe(".kiro/prompts/demo.md"), desiredDigest: sha("new") });
      },
      async rollback() {
        return ok(undefined);
      },
    };
    const prepared = await new PersistentTransactionEngine({
      fileSystem: new FakeFileSystem(),
      operations: new Map([["file:demo", prepareFailure]]),
    }).apply(planFor("new", "create"), new AbortController().signal);
    expect(prepared.status).toBe("rolled-back");

    const journalFailureFs = new FakeFileSystem();
    journalFailureFs.failures.failAt("write");
    const journalFailure = await new PersistentTransactionEngine({ fileSystem: journalFailureFs }).apply(
      planFor("new", "create"),
      new AbortController().signal,
    );
    expect(journalFailure.status).toBe("incomplete");

    const verifyFailure: TransactionOperation = {
      async prepare() {
        return ok({ operationId: "file:demo", destination: safe(".kiro/prompts/demo.md"), desiredDigest: sha("new") });
      },
      async verify() {
        return err({ code: "VERIFY_FAILED", message: "verify failed", recoverability: "rollback" });
      },
      async commit() {
        return ok({ operationId: "file:demo", destination: safe(".kiro/prompts/demo.md"), desiredDigest: sha("new") });
      },
      async rollback() {
        return ok(undefined);
      },
    };
    const verified = await new PersistentTransactionEngine({
      fileSystem: new FakeFileSystem(),
      operations: new Map([["file:demo", verifyFailure]]),
    }).apply(planFor("new", "create"), new AbortController().signal);
    expect(verified.status).toBe("rolled-back");
  });

  it("recovers a journal entry and reports manual review when restoration fails", async () => {
    const fileSystem = new FakeFileSystem();
    const engine = new PersistentTransactionEngine({ fileSystem });
    const journal = {
      schemaVersion: 1 as const,
      runId: "run-recovery" as never,
      root: root.value,
      planHash: sha("journal"),
      phase: "committing" as const,
      entries: [
        {
          operationId: "file:demo",
          destination: safe(".kiro/prompts/demo.md"),
          prior: { existed: false as const },
          desiredDigest: sha("new"),
          status: "committed" as const,
        },
      ],
      manualReviewPaths: [],
    };
    const result = await engine.recover(journal);
    expect(result.status).toBe("restored");
    expect(result.restored).toContain("file:demo");
  });
});

describe("transaction summary states", () => {
  const result = (status: "committed" | "rolled-back" | "incomplete", exitCode: 0 | 1 | 3) =>
    ({
      status,
      exitCode,
      applied: ["applied"],
      skipped: ["skipped"],
      warnings: ["warning"],
      errors: ["error"],
      manualReviewPaths: [],
    }) as never;

  it("maps committed, cancelled, recovered, incomplete, and recovery details", () => {
    expect(createExecutionSummary("run-success" as never, result("committed", 0))).toMatchObject({ status: "success" });
    expect(createExecutionSummary("run-cancelled" as never, result("rolled-back", 0))).toMatchObject({ status: "cancelled" });
    expect(createExecutionSummary("run-recovered" as never, result("rolled-back", 1))).toMatchObject({ status: "failed-recovered" });
    expect(
      createExecutionSummary("run-incomplete" as never, result("incomplete", 3), {
        status: "incomplete",
        exitCode: 3,
        restored: [],
        manualReviewPaths: [],
        errors: ["manual review"],
      }),
    ).toMatchObject({ status: "incomplete", recovery: { status: "incomplete" } });
  });
});

describe("ContentFileOperation hard branches", () => {
  it("handles cancellation and verifies the exact prepared digest", async () => {
    const fileSystem = new FakeFileSystem();
    const change = planFor("content", "create").fileChanges[0];
    if (change === undefined) throw new Error("missing fixture change");
    const operation = new ContentFileOperation(fileSystem, change, new TextEncoder().encode("content"));
    const cancelled = new AbortController();
    cancelled.abort();

    expect((await operation.prepare({ plan: planFor("content", "create"), signal: cancelled.signal })).ok).toBe(false);
    const prepared = await operation.prepare({ plan: planFor("content", "create"), signal: new AbortController().signal });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect((await operation.verify(prepared.value)).ok).toBe(true);
    expect((await operation.verify({ ...prepared.value, desiredDigest: sha("different") })).ok).toBe(false);
    expect((await operation.rollback({ operationId: change.id, destination: change.destination })).ok).toBe(true);
  });

  it("uses fallback writes and reports atomic write or fsync failures", async () => {
    const change = planFor("content", "create").fileChanges[0];
    if (change === undefined) throw new Error("missing fixture change");
    const content = new TextEncoder().encode("content");
    const prepared = { operationId: change.id, destination: change.destination, desiredDigest: sha("content") };

    const fallback = new FakeFileSystem();
    expect((await new ContentFileOperation(fallback, change, content).commit(prepared)).ok).toBe(true);
    expect(new TextDecoder().decode(await fallback.read(change.destination))).toBe("content");

    let writeSucceeds = false;
    let syncSucceeds = true;
    const atomic = {
      writeAtomic: async () =>
        writeSucceeds ? ok(undefined) : err({ code: "WRITE_FAILED", message: "atomic failed", recoverability: "rollback" }),
      write: async () => ok(undefined),
      fsync: async () =>
        syncSucceeds ? ok(undefined) : err({ code: "WRITE_FAILED", message: "fsync failed", recoverability: "rollback" }),
    } as never;
    const operation = new ContentFileOperation(atomic, change, content);

    expect((await operation.commit(prepared)).ok).toBe(false);
    writeSucceeds = true;
    syncSucceeds = false;
    expect((await operation.commit(prepared)).ok).toBe(false);
    syncSucceeds = true;
    expect(await operation.commit(prepared)).toMatchObject({ ok: true, value: { created: true } });
  });
});

describe("transaction authorization edge cases", () => {
  const rehash = (plan: ApprovedPlan): ApprovedPlan => {
    const unsigned = Object.fromEntries(
      Object.entries(plan).filter(
        ([key]) => !["planHash", "approval", "approvedFileChangeIds", "approvedExternalOperationIds"].includes(key),
      ),
    );
    const planHash = calculatePlanHash(unsigned as never);
    return { ...plan, planHash, approval: { ...plan.approval, planHash } };
  };

  it("rejects duplicate, foreign, unapproved, and malformed operation identities", async () => {
    const base = planFor("content", "create");
    const external = {
      id: "external:demo",
      componentId: component.value,
      command: ["registered", "demo"],
      origin: "official",
      destination: safe(".staging/demo"),
      purpose: "prepare",
      usesNetwork: true,
      expectedFiles: [],
    } as const;
    const externalPlan = rehash({
      ...base,
      externalOperations: [external],
      approvedExternalOperationIds: [external.id] as never,
      approval: { ...base.approval, networkOperations: [] },
    });
    const malformedOrigin = rehash({
      ...externalPlan,
      externalOperations: [{ ...external, origin: "" }],
      approval: { ...externalPlan.approval, networkOperations: [external.id] as never },
    });
    const unsafeExpected = rehash({
      ...externalPlan,
      externalOperations: [{ ...external, expectedFiles: [{ path: "../escape", sha256: sha("x") }] }],
      approval: { ...externalPlan.approval, networkOperations: [external.id] as never },
    });
    const cases: ApprovedPlan[] = [
      { ...base, approvedFileChangeIds: ["file:demo", "file:demo"] },
      { ...base, approvedFileChangeIds: ["foreign"] },
      { ...base, approvedExternalOperationIds: ["foreign"] as never },
      externalPlan,
      malformedOrigin,
      unsafeExpected,
    ] as ApprovedPlan[];

    for (const plan of cases) {
      const result = await new PersistentTransactionEngine({ fileSystem: new FakeFileSystem() }).apply(plan, new AbortController().signal);
      expect(result).toMatchObject({ status: "incomplete", exitCode: 3 });
    }
  });

  it("rejects journals with unsafe destinations and backup paths", async () => {
    const engine = new PersistentTransactionEngine({ fileSystem: new FakeFileSystem() });
    const journal = {
      schemaVersion: 1,
      runId: "run-unsafe",
      root: root.value,
      planHash: sha("journal"),
      phase: "committing",
      entries: [
        {
          operationId: "file:demo",
          destination: "../escape",
          prior: { existed: false },
          desiredDigest: sha("new"),
          status: "pending",
        },
      ],
      manualReviewPaths: [],
    } as never;
    expect(await engine.recover(journal)).toMatchObject({ status: "incomplete", exitCode: 3 });
    expect(
      await engine.recover({
        ...journal,
        entries: [{ ...journal.entries[0], destination: safe("file"), prior: { existed: true, digest: sha("old"), backupPath: "../bad" } }],
      }),
    ).toMatchObject({ status: "incomplete", exitCode: 3 });
  });
});
