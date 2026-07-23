import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { JsonStructuredConfigCodec, asCanonicalPath, asComponentId, calculatePlanHash, mergeManagedState } from "../src/domain/index.js";
import type { ApprovedPlan, DocumentStyle, FileChange, JsonObject, ManagedOwnershipInput, RunId, Sha256 } from "../src/domain/index.js";
import { PersistentTransactionEngine } from "../src/infrastructure/transaction/index.js";
import { FakeFileSystem } from "./support/fakes.js";
import { runSeeded } from "./support/fast-check.js";

const SEED = 20250213;
const style: DocumentStyle = { indentation: "  ", eol: "\n", finalNewline: true };

const safeKey = fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,7}$/).filter((key) => !["__proto__", "prototype", "constructor"].includes(key));
const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small", maxDepth: 3 },
    fc.string({ maxLength: 12 }),
    fc.integer({ min: -1000, max: 1000 }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie("value"), { maxLength: 4 }),
    tie("object"),
  ),
  object: fc.dictionary(safeKey, tie("value"), { maxKeys: 5 }),
})).object as fc.Arbitrary<JsonObject>;

describe("Feature: auto-ai-setup, structured configuration properties", () => {
  it("Property 20: Round-trip de configuración estructurada preserva campos y valores", () => {
    const codec = new JsonStructuredConfigCodec();
    runSeeded(
      fc.property(jsonValue, (model) => {
        const serialized = codec.serialize(model, style);
        expect(serialized.ok).toBe(true);
        if (!serialized.ok) return;
        const reparsed = codec.parse({ path: "C:/project/config.json" as never, text: serialized.value, format: "json" });
        expect(reparsed.ok).toBe(true);
        if (!reparsed.ok) return;
        expect(codec.equivalent(model, reparsed.value.model)).toBe(true);
        expect(reparsed.value.model).toEqual(model);
      }),
      SEED,
      100,
    );
  });

  it("Property 21: El merge solo altera el frame aprobado y conserva campos desconocidos", () => {
    const codec = new JsonStructuredConfigCodec();
    runSeeded(
      fc.property(jsonValue, safeKey, fc.string({ maxLength: 10 }), (model, managedKey, managedValue) => {
        const original = structuredClone(model);
        const merged = codec.merge(model, { paths: { [`/auto_ai_setup_managed/${managedKey}`]: managedValue } });
        expect(merged.ok).toBe(true);
        if (!merged.ok) return;
        // Every pre-existing top-level field keeps its exact value.
        for (const key of Object.keys(original)) expect(merged.value[key]).toEqual(original[key]);
        // The input model is never mutated in place.
        expect(model).toEqual(original);
        // Only the managed frame was added.
        expect((merged.value.auto_ai_setup_managed as JsonObject)[managedKey]).toEqual(managedValue);
      }),
      SEED,
      100,
    );
  });

  it("Property 19: Los componentes gestionados conservan una única instancia por identidad", () => {
    const digest = "a".repeat(64) as Sha256;
    const recordArb = fc.record({
      type: fc.constantFrom("skill", "mcp-server", "agent-rule", "agent-command"),
      id: fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/),
    });
    runSeeded(
      fc.property(fc.array(recordArb, { minLength: 1, maxLength: 12 }), (rawRecords) => {
        const records: ManagedOwnershipInput[] = rawRecords.map((record) => ({
          component: { id: record.id as never, type: record.type as never, source: { kind: "builtin", origin: "prop" } },
          destinations: [`.kiro/${record.type}/${record.id}.md` as never],
          contentDigest: digest,
        }));
        const state = mergeManagedState(undefined, records, "run-prop" as RunId);
        const uniqueKeys = new Set(rawRecords.map((record) => `${record.type}:${record.id}`));
        expect(Object.keys(state.components)).toHaveLength(uniqueKeys.size);
        // Re-merging the same records is a fixed point.
        const again = mergeManagedState(state, records, "run-prop-2" as RunId);
        expect(Object.keys(again.components).sort()).toEqual(Object.keys(state.components).sort());
      }),
      SEED,
      100,
    );
  });
});

const root = asCanonicalPath("/virtual/project");
if (!root.ok) throw new Error(root.error.message);
const componentId = asComponentId("demo");
if (!componentId.ok) throw new Error(componentId.error.message);
const sha = (content: string) => createHash("sha256").update(content).digest("hex") as Sha256;
const safeDestination = ".kiro/prompts/demo.md" as FileChange["destination"];

const planFor = (content: string, runId: string): ApprovedPlan => {
  const change: FileChange = {
    id: "file:demo",
    componentId: componentId.value,
    destination: safeDestination,
    action: "create",
    reason: "idempotency property",
    conflict: "none",
    afterDigest: sha(content),
    preview: { kind: "text", content, truncated: false },
  };
  const unsigned = {
    schemaVersion: 1 as const,
    runId: runId as RunId,
    root: root.value,
    mode: "manual" as const,
    confirmedStackDigest: "0".repeat(64) as Sha256,
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

describe("Feature: auto-ai-setup, Property 18: Reaplicar el estado deseado es un punto fijo", () => {
  it("applies once and re-plans to zero changes on equivalent state across generated projects", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), async (content) => {
        const fileSystem = new FakeFileSystem();
        const contents = new Map([["file:demo", new TextEncoder().encode(content)]]);
        const first = await new PersistentTransactionEngine({ fileSystem, fileContents: contents }).apply(
          planFor(content, "run-0001"),
          new AbortController().signal,
        );
        expect(first.status).toBe("committed");
        const before = new TextDecoder().decode(await fileSystem.read(safeDestination));

        const second = await new PersistentTransactionEngine({ fileSystem, fileContents: contents }).apply(
          planFor(content, "run-0002"),
          new AbortController().signal,
        );
        expect(second.status).toBe("committed");
        expect(second.applied).toEqual([]);
        expect(second.skipped).toContain("file:demo");
        expect(new TextDecoder().decode(await fileSystem.read(safeDestination))).toBe(before);
      }),
      { seed: SEED, numRuns: 100, endOnFailure: true },
    );
  });
});
