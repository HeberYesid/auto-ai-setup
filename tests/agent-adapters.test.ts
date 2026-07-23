import { describe, expect, it } from "vitest";
import {
  AGENTS_RULES_PATH,
  KIRO_COMMANDS_INDEX_PATH,
  KIRO_PROMPTS_PATH,
  adaptAgentsDocument,
  adaptKiroCommandDocuments,
  adaptKiroCommandIndex,
  AgentsRuleAdapter,
  KiroCommandAdapter,
  ruleBeginMarker,
  ruleEndMarker,
} from "../src/infrastructure/agent/index.js";
import { asCanonicalPath, asSafeProjectPath } from "../src/domain/index.js";
import type { SourceDocument } from "../src/domain/index.js";
import { FakeFileSystem } from "./support/fakes.js";

const source = (path: string, text: string): SourceDocument => ({
  path: asSafeProjectPath(path).ok ? asSafeProjectPath(path).value : (path as never),
  text,
  format: "json",
});
const root = asCanonicalPath("/virtual/project");
if (!root.ok) throw new Error(root.error.message);
const stack = { items: [], resolvedConflicts: [], digest: "a".repeat(64) as never };

describe("AGENTS.md rule adapter", () => {
  it("appends an identifiable managed block without changing existing text", () => {
    const result = adaptAgentsDocument(source(AGENTS_RULES_PATH, "# Project\r\n"), {
      id: "testing.rule",
      content: "Use strict mode.\nDo not mutate user text.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toContain(ruleBeginMarker("testing.rule"));
      expect(result.value.text).toContain("Use strict mode.\r\nDo not mutate user text.");
      expect(result.value.text.startsWith("# Project\r\n")).toBe(true);
      expect(result.value.conflict).toBe("none");
    }
  });

  it("treats only EOL and trailing spaces as equivalent", () => {
    const text = `${ruleBeginMarker("same")}\r\nKeep leading  spaces.   \r\n${ruleEndMarker("same")}\r\n`;
    const result = adaptAgentsDocument(source(AGENTS_RULES_PATH, text), { id: "same", content: "Keep leading  spaces." });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.changed).toBe(false);
      expect(result.value.text).toBe(text);
      expect(result.value.conflict).toBe("none");
    }
  });

  it("reports content differences and corrupt marker structure as conflicts", () => {
    const different = adaptAgentsDocument(source(AGENTS_RULES_PATH, `${ruleBeginMarker("rule")}\nold\n${ruleEndMarker("rule")}\n`), {
      id: "rule",
      content: "new",
    });
    const corrupt = adaptAgentsDocument(source(AGENTS_RULES_PATH, "<!-- auto-ai-setup:rule:rule:begin -->\nold\n"), {
      id: "rule",
      content: "new",
    });
    expect(different.ok && different.value.conflict).toBe("content-differs");
    expect(corrupt.ok && corrupt.value.conflict).toBe("invalid-managed-markers");
    expect(corrupt.ok && corrupt.value.corruptMarkers.length).toBeGreaterThan(0);
  });

  it("proposes one identifiable file operation and never executes I/O beyond the injected filesystem", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(AGENTS_RULES_PATH, "# Existing\n");
    const adapter = new AgentsRuleAdapter(fileSystem);
    const component = {
      id: "rule.testing",
      type: "agent-rule" as const,
      name: "Testing rule",
      description: "Rule",
      compatibility: { op: "always" as const },
      source: { kind: "builtin" as const, origin: "test" },
      rule: { id: "testing", content: "Be deterministic." },
    };
    const operations = await adapter.propose({ root: root.value, stack, runId: "run-1" as never }, component);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.destination).toBe(AGENTS_RULES_PATH);
    expect(operations[0]?.conflict).toBe("none");
  });
});

describe("Kiro command adapter", () => {
  it("merges command metadata by ID while preserving unrelated root and entry fields", () => {
    const result = adaptKiroCommandIndex(
      source(KIRO_COMMANDS_INDEX_PATH, '{"unknown": {"keep": true}, "commands": {"build": {"legacy": "keep"}}}\n'),
      { id: "build", name: "Build", description: "Build project", prompt: "run build", metadata: { category: "development" } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model.unknown).toEqual({ keep: true });
      expect(result.value.model.commands).toMatchObject({
        build: { legacy: "keep", category: "development", promptPath: `${KIRO_PROMPTS_PATH}/build.md`, name: "Build" },
      });
      expect(result.value.text).not.toContain("run build");
    }
  });

  it("preserves unrelated arrays, duplicate values, and user-owned command fields", () => {
    const result = adaptKiroCommandIndex(
      source(KIRO_COMMANDS_INDEX_PATH, '{"keep":["first","first","last"],"commands":{"build":{"legacy":{"tags":["x","x"]}}}}'),
      { id: "build", name: "Build", prompt: "run build", metadata: { category: "development" } },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model.keep).toEqual(["first", "first", "last"]);
      expect(((result.value.model.commands as Record<string, unknown>).build as Record<string, unknown>).legacy).toEqual({
        tags: ["x", "x"],
      });
    }
  });

  it("returns the original JSON bytes for an equivalent command index", () => {
    const text =
      '{ "commands" : { "build" : { "id" : "build", "name" : "build", "description" : "", "promptPath" : ".kiro/prompts/build.md" } } }';
    const result = adaptKiroCommandIndex(source(KIRO_COMMANDS_INDEX_PATH, text), {
      id: "build",
      prompt: "run build",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.changed).toBe(false);
      expect(result.value.text).toBe(text);
    }
  });

  it("writes prompt content separately and preserves an equivalent command on the second projection", () => {
    const definition = { id: "review", name: "Review", description: "Review code", prompt: "Review this code." };
    const first = adaptKiroCommandDocuments(
      source(`${KIRO_PROMPTS_PATH}/review.md`, ""),
      source(KIRO_COMMANDS_INDEX_PATH, "{}\n"),
      definition,
    );
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.promptChanged).toBe(true);
      expect(first.value.index.changed).toBe(true);
      const second = adaptKiroCommandDocuments(
        source(`${KIRO_PROMPTS_PATH}/review.md`, first.value.promptText),
        source(KIRO_COMMANDS_INDEX_PATH, first.value.index.text),
        definition,
      );
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.promptChanged).toBe(false);
        expect(second.value.index.changed).toBe(false);
      }
    }
  });

  it("proposes prompt and index operations with safe destinations", async () => {
    const fileSystem = new FakeFileSystem();
    const adapter = new KiroCommandAdapter(fileSystem);
    const component = {
      id: "command.testing",
      type: "agent-command" as const,
      name: "Testing command",
      description: "Command",
      compatibility: { op: "always" as const },
      source: { kind: "builtin" as const, origin: "test" },
      command: { id: "testing", prompt: "Do the thing" },
    };
    const operations = await adapter.propose({ root: root.value, stack, runId: "run-1" as never }, component);
    expect(operations.map((operation) => operation.destination)).toEqual([`${KIRO_PROMPTS_PATH}/testing.md`, KIRO_COMMANDS_INDEX_PATH]);
    expect(operations.every((operation) => operation.action === "create")).toBe(true);
  });

  it("rejects command IDs that could escape the prompt directory", async () => {
    const adapter = new KiroCommandAdapter(new FakeFileSystem());
    const component = {
      id: "command.bad",
      type: "agent-command" as const,
      name: "Bad",
      description: "Bad",
      compatibility: { op: "always" as const },
      source: { kind: "builtin" as const, origin: "test" },
      command: { id: "../bad", prompt: "bad" },
    };
    await expect(adapter.propose({ root: root.value, stack, runId: "run-1" as never }, component)).resolves.toEqual([]);
  });

  it("rejects invalid command definitions and validates operation destinations", async () => {
    expect(adaptKiroCommandIndex(source(KIRO_COMMANDS_INDEX_PATH, "{}\n"), { id: "bad id", prompt: "x" })).toMatchObject({ ok: false });
    expect(
      adaptKiroCommandIndex(source(KIRO_COMMANDS_INDEX_PATH, "{}\n"), { id: "valid", metadata: [] as never, prompt: "x" }),
    ).toMatchObject({
      ok: false,
    });
    expect(adaptKiroCommandIndex(source(KIRO_COMMANDS_INDEX_PATH, '{"commands":[]}\n'), { id: "valid", prompt: "x" })).toMatchObject({
      ok: false,
    });
    expect(
      adaptKiroCommandDocuments(source(`${KIRO_PROMPTS_PATH}/x.md`, ""), source(KIRO_COMMANDS_INDEX_PATH, "{}\n"), { id: "x" }),
    ).toMatchObject({
      ok: false,
    });

    const adapter = new KiroCommandAdapter(new FakeFileSystem());
    expect(
      await adapter.verify(
        {} as never,
        {
          destination: ".outside" as never,
        } as never,
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PLAN" } });
    expect(adapter.supports({ type: "agent-command", command: undefined } as never)).toBe(false);
  });
});
