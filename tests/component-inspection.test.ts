import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ComponentInspectionProjection, componentContentDigest } from "../src/application/session/component-inspection.js";
import { AgentsRuleAdapter } from "../src/infrastructure/agent/agents-rules-adapter.js";
import { KiroCommandAdapter } from "../src/infrastructure/agent/kiro-command-adapter.js";
import { KiroMcpWorkspaceAdapter } from "../src/infrastructure/agent/kiro-mcp-adapter.js";
import { FileSystemSkillOwnershipStore } from "../src/infrastructure/catalog/skill-ownership.js";
import { ManagedStateOwnership } from "../src/infrastructure/catalog/managed-state-ownership.js";
import { asCanonicalPath } from "../src/domain/index.js";
import type { CatalogSnapshot, ComponentDefinition, Sha256 } from "../src/domain/index.js";
import { FakeFileSystem } from "./support/fakes.js";

const root = asCanonicalPath("/virtual/project");
if (!root.ok) throw new Error(root.error.message);
const stack = { items: [], resolvedConflicts: [], digest: "a".repeat(64) as Sha256 };
const sha = (text: string): Sha256 => createHash("sha256").update(text).digest("hex") as Sha256;

const skillText = "# Review skill\n";
const catalog: CatalogSnapshot = {
  schemaVersion: 1,
  catalogId: "catalog",
  sourceRepository: "https://github.com/midudev/autoskills",
  sourceCommit: "abcdef1",
  generatedAt: "2025-01-01T00:00:00.000Z",
  entries: [{
    type: "skill",
    id: "review",
    name: "Review",
    description: "Review project changes",
    origin: { repository: "https://github.com/midudev/autoskills", commit: "abcdef1", relativePath: "skills/review" },
    files: [{ relativePath: "SKILL.md", size: Buffer.byteLength(skillText), sha256: sha(skillText) }],
    compatibility: { op: "always" },
    destinationTemplate: ".kiro/skills/{id}",
  }],
  manifestDigest: "b".repeat(64) as Sha256,
};

const component = (id: string, type: ComponentDefinition["type"], source: ComponentDefinition["source"] = { kind: "builtin", origin: "test-suite" }): ComponentDefinition => ({
  id: id as ComponentDefinition["id"],
  type,
  name: id,
  description: id,
  compatibility: { op: "always" },
  source,
});

const adapters = (fileSystem: FakeFileSystem) => [
  new KiroMcpWorkspaceAdapter(fileSystem),
  new AgentsRuleAdapter(fileSystem),
  new KiroCommandAdapter(fileSystem),
];

const project = (fileSystem: FakeFileSystem, selected: readonly { definition: ComponentDefinition; incompatibleOverride?: boolean }[]) => new ComponentInspectionProjection({ adapters: adapters(fileSystem), fileSystem }).project({
  root: root.value,
  stack,
  runId: "run-0001" as never,
  selected,
  catalog,
});

describe("component inspection and projection", () => {
  it("projects all selected component types with complete provenance and destinations", async () => {
    const fileSystem = new FakeFileSystem();
    const skill = component("review", "skill", { kind: "catalog", origin: catalog.sourceRepository, revision: catalog.sourceCommit, digest: catalog.manifestDigest });
    const mcp = { ...component("mcp.testing", "mcp-server"), mcp: { id: "testing", command: "node", env: { API_TOKEN: "super-secret" } } } as ComponentDefinition & { mcp: unknown };
    const rule = { ...component("rule.testing", "agent-rule"), rule: { id: "testing", content: "Use deterministic tests." } } as ComponentDefinition & { rule: unknown };
    const command = { ...component("command.testing", "agent-command"), command: { id: "testing", name: "Testing", prompt: "Run the tests" } } as ComponentDefinition & { command: unknown };
    const result = await project(fileSystem, [{ definition: skill }, { definition: mcp as never }, { definition: rule as never }, { definition: command as never }]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.components.map((item) => item.component.type)).toEqual(["skill", "mcp-server", "agent-rule", "agent-command"]);
      expect(result.value.fileChanges).toHaveLength(4);
      expect(result.value.externalOperations).toHaveLength(1);
      expect(result.value.externalOperations[0]).toMatchObject({ componentId: "review", origin: "https://github.com/midudev/autoskills#abcdef1/skills/review", destination: ".kiro/skills/review", usesNetwork: true });
      expect(result.value.fileChanges.every((change) => change.origin !== undefined && change.destination.length > 0)).toBe(true);
      expect(JSON.stringify(result.value)).not.toContain("super-secret");
      expect(JSON.stringify(result.value)).toContain("${API_TOKEN}");
    }
  });

  it("omits an external Skill operation when every catalog file is already equivalent", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(".kiro/skills/review/SKILL.md", skillText);
    const skill = component("review", "skill", { kind: "catalog", origin: catalog.sourceRepository, revision: catalog.sourceCommit, digest: catalog.manifestDigest });
    const result = await project(fileSystem, [{ definition: skill }]);
    expect(result.ok && result.value.externalOperations).toHaveLength(0);
    expect(result.ok && result.value.components[0]?.present).toBe(true);
  });

  it("requires an explicit override before projecting an incompatible component", async () => {
    const fileSystem = new FakeFileSystem();
    const incompatible = { ...component("rule.incompatible", "agent-rule"), compatibility: { op: "stack" as const, category: "framework" as const, oneOf: ["react"] }, rule: { id: "incompatible", content: "Only for React" } } as ComponentDefinition & { rule: unknown };
    const omitted = await project(fileSystem, [{ definition: incompatible as never }]);
    expect(omitted.ok && omitted.value.fileChanges).toHaveLength(0);
    expect(omitted.ok && omitted.value.warnings[0]?.code).toBe("INCOMPATIBLE_COMPONENT");
    const approved = await project(fileSystem, [{ definition: incompatible as never, incompatibleOverride: true }]);
    expect(approved.ok && approved.value.fileChanges[0]?.incompatibleOverride?.compatible).toBe(false);
  });
});

describe("managed state ownership", () => {
  it("records only selected component ownership after a successful projection", async () => {
    const fileSystem = new FakeFileSystem();
    const store = new FileSystemSkillOwnershipStore(fileSystem);
    const ownership = new ManagedStateOwnership(store, { digest: (definition) => componentContentDigest(definition) });
    const rule = { ...component("rule.testing", "agent-rule"), rule: { id: "testing", content: "Be deterministic." } } as ComponentDefinition & { rule: unknown };
    const projection = await project(fileSystem, [{ definition: rule as never }]);
    expect(projection.ok).toBe(true);
    if (projection.ok) {
      const saved = await ownership.recordSuccessfulProjection(projection.value, "run-0001" as never);
      expect(saved.ok).toBe(true);
      if (saved.ok) {
        expect(saved.value.lastSuccessfulRunId).toBe("run-0001");
        expect(saved.value.components["agent-rule:rule.testing"]?.destinations).toEqual(["AGENTS.md"]);
        expect(saved.value.components["agent-rule:rule.testing"]?.origin).toBe("test-suite");
      }
    }
  });
});
