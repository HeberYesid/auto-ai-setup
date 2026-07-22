import { describe, expect, it } from "vitest";
import { asCanonicalPath, asComponentId, asSafeProjectPath } from "../src/domain/index.js";
import {
  KIRO_MCP_SETTINGS_PATH,
  KiroMcpWorkspaceAdapter,
  adaptKiroMcpDocument,
  mergeMcpServers,
} from "../src/infrastructure/agent/kiro-mcp-adapter.js";
import type { JsonObject, SourceDocument } from "../src/domain/index.js";
import { FakeFileSystem } from "./support/fakes.js";

const source = (text: string): SourceDocument => ({
  path: asSafeProjectPath(KIRO_MCP_SETTINGS_PATH).ok ? asSafeProjectPath(KIRO_MCP_SETTINGS_PATH).value : (KIRO_MCP_SETTINGS_PATH as never),
  text,
  format: "json",
});
const componentId = asComponentId("mcp.testing");
if (!componentId.ok) throw new Error(componentId.error.message);
const root = asCanonicalPath("/virtual/project");
if (!root.ok) throw new Error(root.error.message);

const definition = {
  id: "testing",
  command: "node",
  args: ["server.js"],
  env: ["API_TOKEN"],
  options: { disabled: false },
};

describe("Kiro MCP workspace adapter", () => {
  it("merges by server id while preserving unrelated entries and unknown fields", () => {
    const result = mergeMcpServers(
      {
        unrelated: { keep: true },
        mcpServers: {
          testing: { command: "old", metadata: { owner: "user", keep: [1, 2] } },
          other: { command: "other" },
        },
      },
      [definition],
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.unrelated).toEqual({ keep: true });
      expect(result.value.mcpServers).toEqual({
        testing: {
          command: "node",
          args: ["server.js"],
          env: { API_TOKEN: "${API_TOKEN}" },
          disabled: false,
          metadata: { owner: "user", keep: [1, 2] },
        },
        other: { command: "other" },
      });
    }
  });

  it("never copies environment values and exposes only variable names", () => {
    const result = adaptKiroMcpDocument(source("{}\n"), [
      {
        id: "secrets",
        command: "node",
        configuration: { env: { API_TOKEN: "super-secret", OTHER: "also-secret" } as JsonObject },
        env: { API_TOKEN: "super-secret", OTHER: "also-secret" },
      },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).not.toContain("super-secret");
      expect(result.value.text).not.toContain("also-secret");
      expect(result.value.text).toContain("${API_TOKEN}");
      expect(result.value.text).toContain("${OTHER}");
      expect(result.value.environmentVariableNames).toEqual(["API_TOKEN", "OTHER"]);
    }
  });

  it("preserves detected JSON style and reports semantic no-op on equivalent configuration", () => {
    const text = '{\r\n  "mcpServers": {\r\n    "testing": {\r\n      "command": "node"\r\n    }\r\n  }\r\n}\r\n';
    const result = adaptKiroMcpDocument(source(text), [{ id: "testing", command: "node" }]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.changed).toBe(false);
      expect(result.value.style).toEqual({ indentation: "  ", eol: "\r\n", finalNewline: true });
      expect(result.value.text).toBe(text);
    }
  });

  it("rejects duplicate or invalid server environment names before producing a model", () => {
    const duplicate = mergeMcpServers({}, [definition, definition]);
    const invalid = mergeMcpServers({}, [{ id: "invalid", env: ["not-valid-name"] }]);

    expect(duplicate.ok).toBe(false);
    expect(invalid.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.message).toContain("Duplicate");
    if (!invalid.ok) expect(invalid.error.message).toContain("invalid variable");
  });

  it("only proposes the workspace file and never starts an MCP process", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(KIRO_MCP_SETTINGS_PATH, "{}\n");
    const adapter = new KiroMcpWorkspaceAdapter(fileSystem);
    const component = {
      id: componentId.value,
      type: "mcp-server" as const,
      name: "Testing MCP",
      description: "A test server",
      compatibility: { op: "always" as const },
      source: { kind: "builtin" as const, origin: "test" },
      mcp: definition,
    };

    expect(adapter.supports(component)).toBe(true);
    const operations = await adapter.propose(
      { root: root.value, stack: { items: [], resolvedConflicts: [], digest: "a".repeat(64) as never }, runId: "run-1" as never },
      component,
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]?.destination).toBe(KIRO_MCP_SETTINGS_PATH);
    expect(JSON.stringify(operations[0]?.preview)).not.toContain("secret");
  });
});
