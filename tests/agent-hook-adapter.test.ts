import { describe, expect, it } from "vitest";
import {
  AGENT_HOOK_TRIGGERS,
  KIRO_HOOKS_PATH,
  KiroHookAdapter,
  adaptAgentHookDocument,
  agentHookModel,
  builtinAgentComponents,
  validateAgentHook,
} from "../src/infrastructure/agent/index.js";
import type { AgentHookComponentDefinition, AgentHookDefinition } from "../src/infrastructure/agent/index.js";
import { asCanonicalPath, asSafeProjectPath, groupComponentsByType } from "../src/domain/index.js";
import type { ComponentDefinition, SourceDocument } from "../src/domain/index.js";
import { FakeFileSystem } from "./support/fakes.js";

const source = (path: string, text: string): SourceDocument => {
  const safe = asSafeProjectPath(path);
  return { path: safe.ok ? safe.value : (path as never), text, format: "json" };
};
const root = asCanonicalPath("/virtual/project");
if (!root.ok) throw new Error(root.error.message);
const stack = { items: [], resolvedConflicts: [], digest: "a".repeat(64) as never };
const hookPath = `${KIRO_HOOKS_PATH}/lint.json`;

const hook: AgentHookDefinition = {
  id: "lint",
  name: "Lint on save",
  trigger: "PostFileSave",
  matcher: "\\.ts$",
  action: { type: "agent", prompt: "Lint the saved file." },
};
const component = (definition: AgentHookDefinition = hook): AgentHookComponentDefinition => ({
  id: `hook.${definition.id}` as never,
  type: "agent-hook",
  name: definition.name,
  description: "Hook",
  compatibility: { op: "always" },
  source: { kind: "builtin", origin: "test" },
  hook: definition,
});

describe("agent hook definition validation", () => {
  it("rejects an unsafe id, an unsupported trigger, an invalid matcher, and an empty action", () => {
    expect(validateAgentHook({ ...hook, id: "../escape" }).ok).toBe(false);
    expect(validateAgentHook({ ...hook, trigger: "OnEverything" as never }).ok).toBe(false);
    expect(validateAgentHook({ ...hook, matcher: "([unclosed" }).ok).toBe(false);
    expect(validateAgentHook({ ...hook, action: { type: "agent", prompt: "  " } }).ok).toBe(false);
    expect(validateAgentHook({ ...hook, action: { type: "command", command: "node -e 1", timeout: 0 } }).ok).toBe(false);
    expect(validateAgentHook(hook).ok).toBe(true);
  });

  it("emits a canonical document and omits an absent matcher", () => {
    expect(agentHookModel(hook)).toEqual({
      version: "v1",
      hooks: [{ name: "Lint on save", trigger: "PostFileSave", matcher: "\\.ts$", action: { type: "agent", prompt: "Lint the saved file." } }],
    });
    const withoutMatcher = agentHookModel({ ...hook, matcher: undefined });
    expect(JSON.stringify(withoutMatcher)).not.toContain("matcher");
  });
});

describe("Kiro hook adapter", () => {
  it("creates the hook file and is idempotent on a second run", () => {
    const created = adaptAgentHookDocument(source(hookPath, "{}\n"), hook);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.changed).toBe(true);
    expect(created.value.conflict).toBe("none");
    const again = adaptAgentHookDocument(source(hookPath, created.value.text), hook);
    expect(again.ok && again.value.changed).toBe(false);
    expect(again.ok && again.value.text).toBe(created.value.text);
  });

  it("preserves unknown user fields and reports a divergent managed hook as a conflict", () => {
    const result = adaptAgentHookDocument(source(hookPath, '{"note":"mine","version":"v1","hooks":[{"name":"Old"}]}\n'), hook);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model.note).toBe("mine");
    expect(result.value.conflict).toBe("content-differs");
    expect(JSON.stringify(result.value.model.hooks)).toContain("Lint on save");
  });

  it("proposes one create operation per hook, each in its own file", async () => {
    const fileSystem = new FakeFileSystem();
    const adapter = new KiroHookAdapter(fileSystem);
    const operations = await adapter.proposeAll({ root: root.value, stack, runId: "run-1" as never }, [
      component(),
      component({ ...hook, id: "typecheck", name: "Typecheck on save" }),
    ]);
    expect(operations.map((operation) => operation.destination)).toEqual([hookPath, `${KIRO_HOOKS_PATH}/typecheck.json`]);
    expect(operations.every((operation) => operation.action === "create")).toBe(true);
    expect(operations.every((operation) => operation.content !== undefined)).toBe(true);
  });

  it("reports a hook already present on disk as preserved", async () => {
    const fileSystem = new FakeFileSystem();
    const created = adaptAgentHookDocument(source(hookPath, "{}\n"), hook);
    if (!created.ok) throw new Error("fixture is invalid");
    fileSystem.seed(hookPath, created.value.text);
    const adapter = new KiroHookAdapter(fileSystem);
    const state = await adapter.inspect({ root: root.value, stack }, component());
    const operations = await adapter.propose({ root: root.value, stack, runId: "run-1" as never }, component());
    expect(state.present).toBe(true);
    expect(operations[0]?.action).toBe("preserve");
    expect(operations[0]?.content).toBeUndefined();
  });

  it("rejects an operation outside the managed hook directory", async () => {
    const adapter = new KiroHookAdapter(new FakeFileSystem());
    const destination = asSafeProjectPath("AGENTS.md");
    if (!destination.ok) throw new Error(destination.error.message);
    const result = await adapter.verify({ root: root.value } as never, {
      id: "hook:x",
      componentId: "hook.x" as never,
      destination: destination.value,
      action: "create",
      reason: "wrong destination",
      conflict: "none",
      preview: { kind: "text", content: "", truncated: false },
    });
    expect(result.ok).toBe(false);
  });
});

describe("builtin component catalog", () => {
  const grouped = groupComponentsByType(builtinAgentComponents, { stack, cliRecommendations: [] });
  const countOf = (type: ComponentDefinition["type"]): number =>
    grouped.groups.find((group) => group.type === type)?.components.length ?? 0;

  it("offers at least five options for every component type it owns", () => {
    expect(countOf("mcp-server")).toBeGreaterThanOrEqual(5);
    expect(countOf("agent-rule")).toBeGreaterThanOrEqual(5);
    expect(countOf("agent-command")).toBeGreaterThanOrEqual(5);
    expect(countOf("agent-hook")).toBeGreaterThanOrEqual(5);
  });

  it("owns no skill component, since Skills belong to the external autoskills TUI", () => {
    expect(countOf("skill")).toBe(0);
  });

  it("declares unique ids and valid hook definitions", () => {
    const ids = builtinAgentComponents.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of builtinAgentComponents) {
      if (definition.type !== "agent-hook") continue;
      const hookDefinition = (definition as AgentHookComponentDefinition).hook;
      expect(validateAgentHook(hookDefinition).ok).toBe(true);
      expect(AGENT_HOOK_TRIGGERS).toContain(hookDefinition.trigger);
    }
  });

  it("keeps mutually exclusive package-manager and test-runner rules gated by the stack", () => {
    const gated = builtinAgentComponents.filter(
      (definition) => definition.id.startsWith("rule.package-manager.") || definition.id.startsWith("rule.testing."),
    );
    expect(gated.length).toBeGreaterThanOrEqual(6);
    expect(gated.every((definition) => definition.compatibility.op === "stack")).toBe(true);
  });
});
