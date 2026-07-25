import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ApprovedNetworkGateway,
  DeterministicChangePlanner,
  ImmutableApprovalPolicy,
  SecretRedactor,
  asCanonicalPath,
  isSafeRelativePath,
  ok,
} from "../src/index.js";
import { LocalEventFactory } from "../src/infrastructure/observability/event-sink.js";
import type {
  ComponentDefinition,
  ExternalOperation,
  FileChange,
  NetworkGateway,
  PlanningInput,
  RunId,
  Sha256,
  ConfirmedStack,
} from "../src/domain/index.js";

const digest = "b".repeat(64) as Sha256;
const canonical = asCanonicalPath(process.cwd());
if (!canonical.ok) throw new Error(canonical.error.message);
const component: ComponentDefinition = {
  id: "property-component" as ComponentDefinition["id"],
  type: "agent-rule",
  name: "Property",
  description: "Property",
  compatibility: { op: "always" },
  source: { kind: "builtin", origin: "test" },
};
const stack: ConfirmedStack = { items: [], resolvedConflicts: [], digest };
const destinationArb = fc
  .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/), { minLength: 1, maxLength: 3 })
  .map((parts) => `managed/${[...new Set(parts)].join("/")}.md`);
const file = (destination: string, action: FileChange["action"] = "create"): FileChange => ({
  id: `id:${destination}`,
  componentId: component.id,
  destination: destination as FileChange["destination"],
  action,
  reason: "property",
  conflict: "none",
  preview: { kind: "text", content: "content", truncated: false },
});
const planInput = (changes: readonly FileChange[]): PlanningInput => ({
  runId: "property-run" as RunId,
  root: canonical.value,
  mode: "manual",
  stack,
  components: [component],
  fileChanges: changes,
  externalOperations: [],
  now: "2025-01-01T00:00:00.000Z",
});
const operation = (id: string): ExternalOperation => ({
  id: id as ExternalOperation["id"],
  componentId: component.id,
  kind: "skill-install",
  command: ["npx", "--yes", "autoskills"],
  origin: "https://github.com/midudev/autoskills",
  destination: ".kiro/skills/property" as ExternalOperation["destination"],
  purpose: "property",
  usesNetwork: true,
  expectedFiles: [],
});

describe("Task 6 correctness properties", () => {
  // Feature: auto-ai-setup, Property 11: El diff de plan es determinista y completo
  it("Property 11: deterministic and complete plan diff", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(destinationArb, { minLength: 0, maxLength: 5 }), async (destinations) => {
        const changes = destinations.map((destination, index) => file(destination, index % 2 === 0 ? "create" : "modify"));
        const planner = new DeterministicChangePlanner();
        const first = await planner.build(planInput(changes));
        const second = await planner.build(planInput([...changes].reverse()));
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(first.value.planHash).toBe(second.value.planHash);
        expect(new Set(first.value.fileChanges.map((change) => change.destination)).size).toBe(changes.length);
        expect(first.value.fileChanges.every((change) => change.reason.length > 0 && change.preview !== undefined)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: auto-ai-setup, Property 12: Las decisiones de aprobación se vinculan al plan exacto
  it("Property 12: approval decisions require the exact plan hash", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (approved) => {
        const planner = new DeterministicChangePlanner();
        const built = await planner.build(planInput([file("managed/config.json", "create")]));
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        const policy = new ImmutableApprovalPolicy();
        const decision = policy.evaluate(built.value, {
          planHash: built.value.planHash,
          globalApproved: approved,
          conflicts: {},
          incompatibleComponents: [],
          networkOperations: [],
        });
        expect(decision.ok).toBe(approved);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: auto-ai-setup, Property 13: Confinamiento físico y lógico de destinos
  it("Property 13: hostile destinations are rejected lexically", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom("../outside", "../../outside", "/tmp/outside", "C:/outside", "a\\..\\outside", "a/\0/b"), fc.string()),
        (candidate) => {
          if (
            candidate.includes("..") ||
            candidate.includes("\\") ||
            candidate.includes("\0") ||
            candidate.startsWith("/") ||
            /^[A-Za-z]:/.test(candidate)
          )
            expect(isSafeRelativePath(candidate)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: auto-ai-setup, Property 14: La redacción es no filtrante e idempotente
  it("Property 14: redaction is non-leaking and idempotent", () => {
    fc.assert(
      fc.property(fc.stringMatching(/[A-Za-z0-9]{1,24}/), (secret) => {
        const redactor = new SecretRedactor();
        const value = { nested: { token: secret }, preview: `Bearer ${secret}`, known: secret };
        const redacted = redactor.redact(value, [secret]);
        const serialized = JSON.stringify(redacted);
        expect(serialized).not.toContain(secret);
        expect(JSON.stringify(redactor.redact(redacted))).toBe(serialized);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: auto-ai-setup, Property 23: Eventos locales completos según nivel y modo
  it("Property 23: events retain base fields and verbose context policy", () => {
    fc.assert(
      fc.property(fc.boolean(), (verbose) => {
        const factory = new LocalEventFactory({ clock: { now: () => "2025-01-01T00:00:00.000Z", monotonicMs: () => 0 }, verbose });
        const event = factory.create({
          runId: "event-run" as RunId,
          level: "info",
          category: "plan",
          message: "plan",
          context: { evidence: "package.json" },
        });
        expect(event.runId).toBe("event-run");
        expect(event.timestamp).toBe("2025-01-01T00:00:00.000Z");
        expect(event.redacted).toBe(true);
        expect(verbose ? event.context?.evidence : event.context).toBe(verbose ? "package.json" : undefined);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: auto-ai-setup, Property 25: Operaciones de red completas y deny-by-default
  it("Property 25: foreign or stale network approvals never reach the delegate", async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/[a-z]{1,8}/), fc.boolean(), async (id, useExactId) => {
        let calls = 0;
        const delegate: NetworkGateway = {
          request: async () => {
            calls += 1;
            return ok(new Uint8Array());
          },
        };
        const gateway = new ApprovedNetworkGateway(delegate);
        const current = operation("operation-current");
        const result = await gateway.request(current, { planHash: digest, operationId: useExactId ? current.id : id, approved: true });
        expect(result.ok).toBe(useExactId);
        expect(calls).toBe(useExactId ? 1 : 0);
      }),
      { numRuns: 100 },
    );
  });
});
