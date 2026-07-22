import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApprovedNetworkGateway,
  DeterministicChangePlanner,
  ImmutableApprovalPolicy,
  SecretRedactor,
  asCanonicalPath,
  asProjectRelativePath,
  ok,
} from "../src/index.js";
import { LocalEventFactory, LocalEventSink } from "../src/infrastructure/observability/event-sink.js";
import { NodePathPolicy } from "../src/infrastructure/fs/path-policy.js";
import type {
  CanonicalPath,
  ComponentDefinition,
  ExternalOperation,
  FileChange,
  NetworkGateway,
  PlanningInput,
  Sha256,
  RunId,
  StackItem,
  ConfirmedStack,
  Clock,
} from "../src/domain/index.js";

const digest = "a".repeat(64) as Sha256;
const root = asCanonicalPath(process.cwd());
if (!root.ok) throw new Error(root.error.message);
const projectRoot: CanonicalPath = root.value;
const componentId = "component.example" as ComponentDefinition["id"];
const stackItem: StackItem = { category: "language", id: "typescript", displayName: "TypeScript", confidence: "explicit", evidence: [] };
const stack: ConfirmedStack = { items: [stackItem], resolvedConflicts: [], digest };
const component: ComponentDefinition = { id: componentId, type: "agent-rule", name: "Example", description: "Example", compatibility: { op: "always" }, source: { kind: "builtin", origin: "test" } };
const input = (changes: readonly FileChange[], externalOperations: readonly ExternalOperation[] = []): PlanningInput => ({
  runId: "run-1" as RunId,
  root: projectRoot,
  mode: "manual",
  stack,
  components: [component],
  fileChanges: changes,
  externalOperations,
  now: "2025-01-01T00:00:00.000Z",
});
const file = (destination: string, action: FileChange["action"] = "create", conflict: FileChange["conflict"] = "none"): FileChange => ({
  id: `change:${destination}`,
  componentId,
  destination: destination as FileChange["destination"],
  action,
  reason: "Configure the selected component",
  conflict,
  preview: { kind: "text", content: "safe content", truncated: false },
});
const external = (): ExternalOperation => ({
  id: "skill-install:component.example" as ExternalOperation["id"],
  componentId,
  kind: "skill-install",
  command: ["npx", "autoskills", "install", "example"],
  origin: "https://github.com/midudev/autoskills#revision/skills/example",
  destination: ".kiro/skills/example" as ExternalOperation["destination"],
  purpose: "Install the selected Skill",
  usesNetwork: true,
  expectedFiles: [{ path: ".kiro/skills/example/SKILL.md", size: 4, sha256: digest }],
});

describe("Task 6 planning, consent, security, events, and redaction", () => {
  it("builds deterministic plans and turns semantically equivalent state into preserve", async () => {
    const planner = new DeterministicChangePlanner();
    const result = await planner.build(input([
      { ...file(".kiro/z.md", "modify"), beforeDigest: digest, afterDigest: digest },
      file(".kiro/a.md"),
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileChanges.map((change) => [change.destination, change.action])).toEqual([[".kiro/a.md", "create"], [".kiro/z.md", "preserve"]]);
    expect(result.value.planHash).toMatch(/^[a-f0-9]{64}$/);
    const repeat = await planner.build(input([file(".kiro/a.md"), { ...file(".kiro/z.md", "modify"), beforeDigest: digest, afterDigest: digest }]));
    expect(repeat.ok && repeat.value.planHash).toBe(result.value.planHash);
  });

  it("requires exact global/conflict/network approval and freezes the approved plan", async () => {
    const planner = new DeterministicChangePlanner();
    const built = await planner.build(input([file("AGENTS.md", "modify", "content-differs")], [external()]));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const policy = new ImmutableApprovalPolicy();
    const denied = policy.evaluate(built.value, { planHash: digest, globalApproved: true, conflicts: {}, incompatibleComponents: [], networkOperations: [] });
    expect(denied.ok).toBe(false);
    const approved = policy.evaluate(built.value, { planHash: built.value.planHash, globalApproved: false, conflicts: { "change:AGENTS.md": "replace" }, incompatibleComponents: [], networkOperations: ["skill-install:component.example"] });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(Object.isFrozen(approved.value)).toBe(true);
    expect(approved.value.approvedFileChangeIds).toEqual(["change:AGENTS.md"]);
    expect(() => (approved.value.approvedFileChangeIds as string[]).push("bad")).toThrow();
  });

  it("redacts recursive secret material and omits sensitive payload fields", () => {
    const redactor = new SecretRedactor();
    const value = redactor.redact({ token: "known-token", nested: { url: "https://user:password@example.test/a", pem: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----" }, body: "downloaded body", stdout: "Bearer abc.def.ghi" }, ["known-token"]);
    const encoded = JSON.stringify(value);
    expect(encoded).not.toContain("known-token");
    expect(encoded).not.toContain("password");
    expect(encoded).not.toContain("PRIVATE KEY");
    expect(encoded).not.toContain("downloaded body");
    expect(JSON.stringify(redactor.redact(value))).toBe(encoded);
  });

  it("writes only project-local events and preserves detailed base fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auto-ai-setup-events-"));
    try {
      const canonical = asCanonicalPath(directory);
      if (!canonical.ok) throw new Error(canonical.error.message);
      const lines: string[] = [];
      const clock: Clock = { now: () => "2025-01-01T00:00:00.000Z", monotonicMs: () => 0 };
      const factory = new LocalEventFactory({ clock, verbose: true });
      const event = factory.create({ runId: "run-1" as RunId, level: "info", category: "plan", message: "preview", context: { evidence: "package.json", token: "secret" } });
      new LocalEventSink({ root: canonical.value, filePath: ".auto-ai-setup/events.jsonl", terminal: (line) => lines.push(line) }).emit(event);
      const content = await readFile(join(directory, ".auto-ai-setup/events.jsonl"), "utf8");
      expect(content).toContain("run-1");
      expect(content).not.toContain("secret");
      expect(lines).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not delegate network requests without an exact approval", async () => {
    let calls = 0;
    const delegate: NetworkGateway = { request: async () => { calls += 1; return ok(new Uint8Array()); } };
    const gateway = new ApprovedNetworkGateway(delegate);
    const operation = external();
    const denied = await gateway.request(operation, { planHash: digest, operationId: "foreign", approved: true });
    expect(denied.ok).toBe(false);
    expect(calls).toBe(0);
    const allowed = await gateway.request(operation, { planHash: digest, operationId: operation.id, approved: true });
    expect(allowed.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("rejects traversal before resolving or mutating through the path policy", async () => {
    const relative = asProjectRelativePath("../outside");
    expect(relative.ok).toBe(false);
    const policy = new NodePathPolicy();
    const safeRequested = "new-directory/config.json" as unknown as import("../src/domain/index.js").ProjectRelativePath;
    const safe = await policy.resolveDestination(projectRoot, safeRequested);
    expect(safe.ok).toBe(true);
    const hostile = await policy.resolveDestination(projectRoot, "../outside" as unknown as import("../src/domain/index.js").ProjectRelativePath);
    expect(hostile.ok).toBe(false);
    if (!hostile.ok) expect(hostile.error.exitCode).toBe(2);
  });
});
