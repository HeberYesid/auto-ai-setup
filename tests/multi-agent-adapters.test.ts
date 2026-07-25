import { describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  AGENT_DESCRIPTORS,
  DEFERRED_AGENTS,
  agentCapability,
  agentsSupporting,
  asCanonicalPath,
  asSafeProjectPath,
} from "../src/domain/index.js";
import type { AgentId, SourceDocument } from "../src/domain/index.js";
import {
  CLAUDE_MCP_PATH,
  CLAUDE_RULES_PATH,
  CLAUDE_SETTINGS_PATH,
  CODEX_CONFIG_PATH,
  CODEX_HOOKS_PATH,
  KIRO_STEERING_PATH,
  OPENCODE_CONFIG_PATH,
  adaptCodexMcpDocument,
  adaptHooksJsonDocument,
  adaptMcpJsonDocument,
  claudeCodeHooksProfile,
  claudeCodeMcpDialect,
  codexHooksProfile,
  codexServerTable,
  createClaudeCodeCommandAdapter,
  createClaudeCodeHookAdapter,
  createClaudeCodeMcpAdapter,
  createClaudeRulesAdapter,
  createCodexHookAdapter,
  createCodexMcpAdapter,
  createFixedAgentTargetResolver,
  createKiroCommandAdapter,
  createKiroHookAdapter,
  createKiroMcpWorkspaceAdapter,
  createKiroSteeringAdapter,
  createOpenCodeCommandAdapter,
  createOpenCodeMcpAdapter,
  createAgentTargetResolver,
  createComponentInspectionProjection,
  openCodeMcpDialect,
  renderMarkdownCommand,
} from "../src/infrastructure/agent/index.js";
import type {
  AgentHookComponentDefinition,
  KiroCommandComponentDefinition,
  KiroMcpComponentDefinition,
  AgentRuleComponentDefinition,
} from "../src/infrastructure/agent/index.js";
import { FakeFileSystem } from "./support/fakes.js";

const rootResult = asCanonicalPath("/virtual/project");
if (!rootResult.ok) throw new Error(rootResult.error.message);
const root = rootResult.value;
const stack = { items: [], resolvedConflicts: [], digest: "a".repeat(64) as never };
const ctx = { root, stack, runId: "run-0001" as never };
const source = (path: string, text: string): SourceDocument => {
  const safe = asSafeProjectPath(path);
  return { path: safe.ok ? safe.value : (path as never), text, format: "json" };
};
const all = createFixedAgentTargetResolver(AGENT_IDS);
const only = (...agents: AgentId[]) => createFixedAgentTargetResolver(agents);

const stdioServer: KiroMcpComponentDefinition = {
  id: "mcp.files" as never,
  type: "mcp-server",
  name: "Files",
  description: "Filesystem MCP",
  compatibility: { op: "always" },
  source: { kind: "builtin", origin: "test" },
  mcp: { id: "files", command: "npx", args: ["-y", "server-filesystem", "."], env: ["FILES_TOKEN"] },
};
const remoteServer: KiroMcpComponentDefinition = {
  ...stdioServer,
  id: "mcp.docs" as never,
  mcp: { id: "docs", transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "${DOCS_TOKEN}" } },
};
const command: KiroCommandComponentDefinition = {
  id: "command.review" as never,
  type: "agent-command",
  name: "Review",
  description: "Review command",
  compatibility: { op: "always" },
  source: { kind: "builtin", origin: "test" },
  command: { id: "review", name: "Review", description: 'Revisa el "diff"', prompt: "Review the diff." },
};
const rule: AgentRuleComponentDefinition = {
  id: "rule.base" as never,
  type: "agent-rule",
  name: "Base",
  description: "Base rule",
  compatibility: { op: "always" },
  source: { kind: "builtin", origin: "test" },
  rule: { id: "base", content: "## Base\n\n- Lee el código antes de cambiarlo." },
};
const commandHook: AgentHookComponentDefinition = {
  id: "hook.guard" as never,
  type: "agent-hook",
  name: "Guard",
  description: "Guard hook",
  compatibility: { op: "always" },
  source: { kind: "builtin", origin: "test" },
  hook: {
    id: "guard",
    name: "Guard writes",
    trigger: "PreToolUse",
    matcher: "Write|Edit",
    action: { type: "command", command: "node ./guard.mjs", timeout: 15 },
  },
};
const savedHook: AgentHookComponentDefinition = {
  ...commandHook,
  id: "hook.format" as never,
  hook: {
    id: "format",
    name: "Format on save",
    trigger: "PostFileSave",
    matcher: "\\.ts$",
    action: { type: "agent", prompt: "Format it." },
  },
};

const commandComponent = command;

describe("agent support matrix", () => {
  it("declares a documented destination for every supported capability", () => {
    for (const agent of AGENT_IDS)
      for (const [type, capability] of Object.entries(AGENT_DESCRIPTORS[agent].capabilities)) {
        if (capability.status === "supported") expect(capability.destination, `${agent}/${type}`).toBeTruthy();
        else expect(capability.note, `${agent}/${type}`).toBeTruthy();
      }
  });

  it("keeps Skills external for every agent and records the deferred surfaces", () => {
    for (const agent of AGENT_IDS) expect(agentCapability(agent, "skill").status).toBe("external");
    expect(agentsSupporting("mcp-server")).toEqual(["kiro", "claude-code", "codex", "opencode"]);
    expect(agentCapability("codex", "agent-command").status).toBe("deferred");
    expect(agentCapability("opencode", "agent-hook").status).toBe("deferred");
    expect(DEFERRED_AGENTS.map((agent) => agent.id)).toContain("cursor");
  });
});

describe("agent target detection", () => {
  it("targets only the agents whose footprint the project already has", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(CLAUDE_RULES_PATH, "# rules\n");
    const targets = await createAgentTargetResolver(fileSystem).targets();
    expect([...targets]).toEqual(["claude-code"]);
  });

  it("targets every supported agent when the project has no agent footprint", async () => {
    const targets = await createAgentTargetResolver(new FakeFileSystem()).targets();
    expect([...targets].sort()).toEqual([...AGENT_IDS].sort());
  });
});

describe("mcp json dialects", () => {
  it("writes an explicit transport type for a remote Claude Code server", () => {
    const adapted = adaptMcpJsonDocument(source(CLAUDE_MCP_PATH, "{}\n"), [remoteServer.mcp, stdioServer.mcp], claudeCodeMcpDialect);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    const servers = adapted.value.model.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.docs).toMatchObject({ type: "http", url: "https://mcp.example.com/mcp" });
    expect(servers.files).toMatchObject({ command: "npx", env: { FILES_TOKEN: "${FILES_TOKEN}" } });
  });

  it("uses the OpenCode local/remote shape, its command array, and its env interpolation", () => {
    const adapted = adaptMcpJsonDocument(source(OPENCODE_CONFIG_PATH, "{}\n"), [remoteServer.mcp, stdioServer.mcp], openCodeMcpDialect);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.value.model.$schema).toBe("https://opencode.ai/config.json");
    const servers = adapted.value.model.mcp as Record<string, Record<string, unknown>>;
    expect(servers.files).toMatchObject({
      type: "local",
      command: ["npx", "-y", "server-filesystem", "."],
      enabled: true,
      environment: { FILES_TOKEN: "{env:FILES_TOKEN}" },
    });
    expect(servers.docs).toMatchObject({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "{env:DOCS_TOKEN}" },
    });
  });

  it("preserves unknown fields and is idempotent on a second pass", () => {
    const first = adaptMcpJsonDocument(
      source(CLAUDE_MCP_PATH, '{"custom":1,"mcpServers":{"mine":{"command":"x"}}}'),
      [stdioServer.mcp],
      claudeCodeMcpDialect,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.model.custom).toBe(1);
    expect((first.value.model.mcpServers as Record<string, unknown>).mine).toBeDefined();
    const second = adaptMcpJsonDocument(source(CLAUDE_MCP_PATH, first.value.text), [stdioServer.mcp], claudeCodeMcpDialect);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.changed).toBe(false);
  });

  it("proposes one action per agent destination and nothing for an untargeted agent", async () => {
    const fileSystem = new FakeFileSystem();
    const claude = await createClaudeCodeMcpAdapter(fileSystem, all).proposeAll(ctx, [stdioServer]);
    const openCode = await createOpenCodeMcpAdapter(fileSystem, all).proposeAll(ctx, [stdioServer]);
    expect(claude.map((operation) => operation.destination)).toEqual([CLAUDE_MCP_PATH]);
    expect(openCode.map((operation) => operation.destination)).toEqual([OPENCODE_CONFIG_PATH]);
    expect(await createOpenCodeMcpAdapter(fileSystem, only("kiro")).proposeAll(ctx, [stdioServer])).toEqual([]);
  });

  it("never writes a secret value into the preview", async () => {
    const [operation] = await createClaudeCodeMcpAdapter(new FakeFileSystem(), all).proposeAll(ctx, [remoteServer]);
    expect(JSON.stringify(operation?.preview)).not.toContain("DOCS_TOKEN_VALUE");
    expect(JSON.stringify(operation?.preview)).toContain("${DOCS_TOKEN}");
  });
});

describe("codex config.toml mcp blocks", () => {
  it("emits marker-delimited tables and forwards env vars by name", () => {
    const adapted = adaptCodexMcpDocument(source(CODEX_CONFIG_PATH, ""), [stdioServer.mcp, remoteServer.mcp]);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.value.text).toContain("# auto-ai-setup:mcp:files:begin");
    expect(adapted.value.text).toContain("[mcp_servers.files]");
    expect(adapted.value.text).toContain('args = ["-y", "server-filesystem", "."]');
    expect(adapted.value.text).toContain('env_vars = ["FILES_TOKEN"]');
    expect(adapted.value.text).toContain('env_http_headers = { Authorization = "DOCS_TOKEN" }');
    expect(adapted.value.text).not.toContain("${DOCS_TOKEN}");
  });

  it("preserves user content byte for byte and is idempotent", () => {
    const original = '# my notes\nmodel = "gpt-5.5"\n';
    const first = adaptCodexMcpDocument(source(CODEX_CONFIG_PATH, original), [stdioServer.mcp]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.text.startsWith(original)).toBe(true);
    const second = adaptCodexMcpDocument(source(CODEX_CONFIG_PATH, first.value.text), [stdioServer.mcp]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.changed).toBe(false);
    expect(second.value.text).toBe(first.value.text);
  });

  it("leaves a hand-written server table untouched and reports unknown ownership", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(CODEX_CONFIG_PATH, '[mcp_servers.files]\ncommand = "mine"\n');
    const [operation] = await createCodexMcpAdapter(fileSystem, all).proposeAll(ctx, [stdioServer]);
    expect(operation?.conflict).toBe("ownership-unknown");
    expect(operation?.action).toBe("preserve");
    expect(operation?.content).toBeUndefined();
  });
});

describe("markdown slash commands", () => {
  it("renders quoted frontmatter and the prompt body", () => {
    const rendered = renderMarkdownCommand(command.command);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).toBe('---\ndescription: "Revisa el \\"diff\\""\n---\n\nReview the diff.\n');
  });

  it("writes one file per agent directory", async () => {
    const fileSystem = new FakeFileSystem();
    const claude = await createClaudeCodeCommandAdapter(fileSystem, all).proposeAll(ctx, [command]);
    const openCode = await createOpenCodeCommandAdapter(fileSystem, all).proposeAll(ctx, [command]);
    expect(claude[0]?.destination).toBe(".claude/commands/review.md");
    expect(openCode[0]?.destination).toBe(".opencode/commands/review.md");
    expect(claude[0]?.action).toBe("create");
  });

  it("preserves an identical file instead of rewriting it", async () => {
    const rendered = renderMarkdownCommand(command.command);
    if (!rendered.ok) throw new Error("unexpected");
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(".claude/commands/review.md", rendered.value);
    const [operation] = await createClaudeCodeCommandAdapter(fileSystem, all).proposeAll(ctx, [command]);
    expect(operation?.action).toBe("preserve");
  });
});

describe("markdown rules destinations", () => {
  it("writes CLAUDE.md for Claude Code and a steering file for Kiro", async () => {
    const fileSystem = new FakeFileSystem();
    const claude = await createClaudeRulesAdapter(fileSystem, all).proposeAll(ctx, [rule]);
    const kiro = await createKiroSteeringAdapter(fileSystem, all).proposeAll(ctx, [rule]);
    expect(claude[0]?.destination).toBe(CLAUDE_RULES_PATH);
    expect(kiro[0]?.destination).toBe(KIRO_STEERING_PATH);
    expect(String((claude[0]?.preview as { content: string }).content)).toContain("auto-ai-setup:rule:base:begin");
  });

  it("proposes nothing when its agent is not targeted", async () => {
    expect(await createClaudeRulesAdapter(new FakeFileSystem(), only("codex")).proposeAll(ctx, [rule])).toEqual([]);
  });
});

describe("hook configuration per agent", () => {
  it("maps the trigger and keeps an ownership marker", () => {
    const adapted = adaptHooksJsonDocument(source(CLAUDE_SETTINGS_PATH, "{}\n"), [commandHook.hook], claudeCodeHooksProfile);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    const groups = (adapted.value.model.hooks as Record<string, unknown[]>).PreToolUse as Record<string, unknown>[];
    expect(groups[0]).toMatchObject({ matcher: "Write|Edit" });
    expect((groups[0]?.hooks as Record<string, unknown>[])[0]).toMatchObject({
      type: "command",
      command: "node ./guard.mjs",
      timeout: 15,
      statusMessage: "auto-ai-setup:guard",
    });
  });

  it("skips a trigger the agent cannot express instead of writing a dead hook", () => {
    const claude = adaptHooksJsonDocument(source(CLAUDE_SETTINGS_PATH, "{}\n"), [savedHook.hook], claudeCodeHooksProfile);
    expect(claude.ok).toBe(true);
    if (!claude.ok) return;
    expect(claude.value.skipped).toEqual(["format"]);
    expect(claude.value.changed).toBe(false);
    const codex = adaptHooksJsonDocument(source(CODEX_HOOKS_PATH, "{}\n"), [savedHook.hook], codexHooksProfile);
    expect(codex.ok && codex.value.skipped).toEqual(["format"]);
  });

  it("preserves hook groups the user wrote and rewrites only the managed one", () => {
    const existing = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine.sh" }] }] },
      permissions: { allow: ["Bash(git *)"] },
    });
    const adapted = adaptHooksJsonDocument(source(CLAUDE_SETTINGS_PATH, existing), [commandHook.hook], claudeCodeHooksProfile);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    const groups = (adapted.value.model.hooks as Record<string, unknown[]>).PreToolUse;
    expect(groups).toHaveLength(2);
    expect(adapted.value.model.permissions).toBeDefined();
    const second = adaptHooksJsonDocument(source(CLAUDE_SETTINGS_PATH, adapted.value.text), [commandHook.hook], claudeCodeHooksProfile);
    expect(second.ok && second.value.changed).toBe(false);
  });

  it("writes the Codex hook file and refuses a prompt handler Codex would ignore", async () => {
    const fileSystem = new FakeFileSystem();
    const operations = await createCodexHookAdapter(fileSystem, all).proposeAll(ctx, [commandHook, savedHook]);
    expect(operations[0]?.destination).toBe(CODEX_HOOKS_PATH);
    expect(operations[0]?.componentIds).toEqual(["hook.guard"]);
    expect(await createClaudeCodeHookAdapter(fileSystem, only("codex")).proposeAll(ctx, [commandHook])).toEqual([]);
  });
});

describe("target resolver behaviour", () => {
  it("answers isTargeted and handles per capability", async () => {
    const fixed = createFixedAgentTargetResolver(["opencode"]);
    expect(await fixed.isTargeted("opencode")).toBe(true);
    expect(await fixed.isTargeted("kiro")).toBe(false);
    expect(await fixed.handles("opencode", "mcp-server")).toBe(true);
    // OpenCode expresses hooks only as executable plugins, so the capability is not handled.
    expect(await fixed.handles("opencode", "agent-hook")).toBe(false);
    expect(await fixed.handles("opencode", "skill")).toBe(false);
  });

  it("treats an unreadable footprint as absent and memoizes the answer", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.failures.failAt("exists");
    const resolver = createAgentTargetResolver(fileSystem, ["codex"]);
    expect([...(await resolver.targets())]).toEqual(["codex"]);
    expect(await resolver.targets()).toBe(await resolver.targets());
  });
});

describe("adapter inspection and verification", () => {
  const badDestination = asSafeProjectPath("somewhere/else.json");
  if (!badDestination.ok) throw new Error(badDestination.error.message);

  it("reports an MCP server as present only once the agent file already declares it", async () => {
    const fileSystem = new FakeFileSystem();
    const adapter = createClaudeCodeMcpAdapter(fileSystem, all);
    expect(await adapter.inspect({ root, stack }, stdioServer)).toMatchObject({ present: false });
    const [operation] = await adapter.propose(ctx, stdioServer);
    fileSystem.seed(CLAUDE_MCP_PATH, operation?.content ?? "");
    expect(await adapter.inspect({ root, stack }, stdioServer)).toMatchObject({ present: true });
    expect((await createClaudeCodeMcpAdapter(fileSystem, only("kiro")).inspect({ root, stack }, stdioServer)).destinations).toEqual([]);
  });

  it("reports the other component types as present after their own file is written", async () => {
    const fileSystem = new FakeFileSystem();
    const codex = createCodexMcpAdapter(fileSystem, all);
    const command = createOpenCodeCommandAdapter(fileSystem, all);
    const rules = createClaudeRulesAdapter(fileSystem, all);
    const hooks = createCodexHookAdapter(fileSystem, all);
    for (const [adapter, component] of [
      [codex, stdioServer],
      [command, commandComponent],
      [rules, rule],
      [hooks, commandHook],
    ] as const) {
      const before = await adapter.inspect({ root, stack }, component as never);
      expect(before.present).toBe(false);
      const operations = await adapter.propose(ctx, component as never);
      for (const operation of operations) fileSystem.seed(String(operation.destination), operation.content ?? "");
      expect((await adapter.inspect({ root, stack }, component as never)).present).toBe(true);
    }
  });

  it("skips inspection for a capability the agent does not handle", async () => {
    const fileSystem = new FakeFileSystem();
    expect(await createCodexHookAdapter(fileSystem, all).inspect({ root, stack }, savedHook)).toEqual({ present: false, destinations: [] });
    expect(await createKiroSteeringAdapter(fileSystem, only("codex")).inspect({ root, stack }, rule)).toEqual({
      present: false,
      destinations: [],
    });
    expect(await createClaudeCodeCommandAdapter(fileSystem, only("kiro")).inspect({ root, stack }, commandComponent)).toEqual({
      present: false,
      destinations: [],
    });
  });

  it("rejects an operation whose destination the adapter does not own", async () => {
    const fileSystem = new FakeFileSystem();
    const verification = { root, stack, runId: "run-0001" as never, planHash: "b".repeat(64) as never };
    const foreign = {
      id: "x",
      componentId: "y" as never,
      destination: badDestination.value,
      action: "create" as const,
      reason: "",
      conflict: "none" as const,
      preview: { kind: "text" as const, content: "", truncated: false },
    };
    for (const adapter of [
      createClaudeCodeMcpAdapter(fileSystem, all),
      createOpenCodeMcpAdapter(fileSystem, all),
      createCodexMcpAdapter(fileSystem, all),
      createClaudeCodeCommandAdapter(fileSystem, all),
      createClaudeRulesAdapter(fileSystem, all),
      createCodexHookAdapter(fileSystem, all),
    ]) {
      expect((await adapter.verify(verification, foreign as never)).ok).toBe(false);
    }
    const [own] = await createCodexMcpAdapter(fileSystem, all).propose(ctx, stdioServer);
    expect((await createCodexMcpAdapter(fileSystem, all).verify(verification, own as never)).ok).toBe(true);
  });

  it("refuses to interpret a configuration document it cannot parse", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(CLAUDE_MCP_PATH, "{ not json");
    expect(await createClaudeCodeMcpAdapter(fileSystem, all).proposeAll(ctx, [stdioServer])).toEqual([]);
    expect(await createClaudeCodeMcpAdapter(fileSystem, all).inspect({ root, stack }, stdioServer)).toMatchObject({ present: false });
    const broken = new FakeFileSystem();
    broken.seed(CLAUDE_SETTINGS_PATH, '{"hooks":[]}');
    expect(await createClaudeCodeHookAdapter(broken, all).proposeAll(ctx, [commandHook])).toEqual([]);
  });

  it("reports a read failure instead of proposing a change", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(CLAUDE_MCP_PATH, "{}\n");
    fileSystem.seed(CODEX_CONFIG_PATH, "");
    fileSystem.seed(".claude/commands/review.md", "");
    fileSystem.failures.failAt("read");
    expect(await createClaudeCodeMcpAdapter(fileSystem, all).proposeAll(ctx, [stdioServer])).toEqual([]);
    expect(await createCodexMcpAdapter(fileSystem, all).proposeAll(ctx, [stdioServer])).toEqual([]);
    expect(await createClaudeCodeCommandAdapter(fileSystem, all).proposeAll(ctx, [commandComponent])).toEqual([]);
  });
});

describe("dialect validation", () => {
  it("rejects a malformed server container", () => {
    const claude = adaptMcpJsonDocument(source(CLAUDE_MCP_PATH, '{"mcpServers":[]}'), [stdioServer.mcp], claudeCodeMcpDialect);
    expect(claude.ok).toBe(false);
    const openCode = adaptMcpJsonDocument(source(OPENCODE_CONFIG_PATH, '{"mcp":3}'), [stdioServer.mcp], openCodeMcpDialect);
    expect(openCode.ok).toBe(false);
  });

  it("rejects a duplicated server id and a definition with no transport", () => {
    expect(adaptMcpJsonDocument(source(CLAUDE_MCP_PATH, "{}\n"), [stdioServer.mcp, stdioServer.mcp], claudeCodeMcpDialect).ok).toBe(false);
    expect(adaptMcpJsonDocument(source(CLAUDE_MCP_PATH, "{}\n"), [{ id: "bare" }], claudeCodeMcpDialect).ok).toBe(false);
    expect(adaptCodexMcpDocument(source(CODEX_CONFIG_PATH, ""), [{ id: "bare" }]).ok).toBe(false);
  });

  it("rejects a Codex table name that is not a safe identifier", () => {
    expect(adaptCodexMcpDocument(source(CODEX_CONFIG_PATH, ""), [{ ...stdioServer.mcp, id: "../escape" }]).ok).toBe(false);
  });

  it("rejects a hook document whose event list is not an array", () => {
    const adapted = adaptHooksJsonDocument(
      source(CLAUDE_SETTINGS_PATH, '{"hooks":{"PreToolUse":{}}}'),
      [commandHook.hook],
      claudeCodeHooksProfile,
    );
    expect(adapted.ok).toBe(false);
  });

  it("rejects an invalid hook definition and an unrenderable command", () => {
    expect(adaptHooksJsonDocument(source(CODEX_HOOKS_PATH, "{}\n"), [{ ...commandHook.hook, id: "../escape" }], codexHooksProfile).ok).toBe(
      false,
    );
    expect(renderMarkdownCommand({ id: "empty" }).ok).toBe(false);
  });
});

describe("dialect edge cases", () => {
  it("keeps an existing $schema and any unknown per-server field", () => {
    const existing = JSON.stringify({ $schema: "./local.json", mcp: { files: { type: "local", command: ["old"], note: "keep" } } });
    const adapted = adaptMcpJsonDocument(source(OPENCODE_CONFIG_PATH, existing), [stdioServer.mcp], openCodeMcpDialect);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.value.model.$schema).toBe("./local.json");
    const files = (adapted.value.model.mcp as Record<string, Record<string, unknown>>).files;
    expect(files).toMatchObject({ note: "keep", command: ["npx", "-y", "server-filesystem", "."] });
    expect(adapted.value.serverIds).toEqual(["files"]);
  });

  it("rewrites a managed Codex block in place and preserves CRLF", () => {
    const first = adaptCodexMcpDocument(source(CODEX_CONFIG_PATH, 'model = "gpt"\r\n'), [stdioServer.mcp]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.text).toContain("\r\n");
    const second = adaptCodexMcpDocument(source(CODEX_CONFIG_PATH, first.value.text), [
      { ...stdioServer.mcp, args: ["-y", "server-filesystem", "src"] },
    ]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.conflict).toBe("content-differs");
    expect(second.value.text).toContain('args = ["-y", "server-filesystem", "src"]');
    expect(second.value.text.match(/auto-ai-setup:mcp:files:begin/gu)).toHaveLength(1);
  });

  it("proposes nothing when no component is selected", async () => {
    const fileSystem = new FakeFileSystem();
    expect(await createCodexMcpAdapter(fileSystem, all).proposeAll(ctx, [])).toEqual([]);
    expect(await createClaudeCodeMcpAdapter(fileSystem, all).proposeAll(ctx, [])).toEqual([]);
    expect(await createClaudeRulesAdapter(fileSystem, all).proposeAll(ctx, [])).toEqual([]);
    expect(await createClaudeCodeCommandAdapter(fileSystem, all).proposeAll(ctx, [])).toEqual([]);
    expect(await createCodexHookAdapter(fileSystem, all).proposeAll(ctx, [])).toEqual([]);
  });

  it("accepts the content alias for a command body", () => {
    const rendered = renderMarkdownCommand({ id: "alias", content: "Body." });
    expect(rendered.ok && rendered.value.endsWith("Body.\n")).toBe(true);
  });

  it("writes a prompt handler for Claude Code and omits an absent matcher", () => {
    const promptHook = { ...savedHook.hook, id: "notes", trigger: "Stop" as const, matcher: undefined };
    const adapted = adaptHooksJsonDocument(source(CLAUDE_SETTINGS_PATH, "{}\n"), [promptHook], claudeCodeHooksProfile);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    const groups = (adapted.value.model.hooks as Record<string, Record<string, unknown>[]>).Stop;
    expect(groups[0]?.matcher).toBeUndefined();
    expect((groups[0]?.hooks as Record<string, unknown>[])[0]).toMatchObject({ type: "prompt", prompt: "Format it." });
  });

  it("flags a rules document whose managed markers were broken by hand", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(CLAUDE_RULES_PATH, "<!-- auto-ai-setup:rule:base:begin -->\nstranded\n");
    const [operation] = await createClaudeRulesAdapter(fileSystem, all).proposeAll(ctx, [rule]);
    expect(operation?.conflict).toBe("invalid-managed-markers");
  });
});

describe("projection across several agents", () => {
  const projectionFor = (fileSystem: FakeFileSystem, resolver: ReturnType<typeof createFixedAgentTargetResolver>) =>
    createComponentInspectionProjection({
      fileSystem,
      adapters: [
        createClaudeCodeMcpAdapter(fileSystem, resolver),
        createOpenCodeMcpAdapter(fileSystem, resolver),
        createCodexMcpAdapter(fileSystem, resolver),
        createClaudeRulesAdapter(fileSystem, resolver),
        createCodexHookAdapter(fileSystem, resolver),
      ],
    });

  it("fans one component out to every targeted agent destination", async () => {
    const fileSystem = new FakeFileSystem();
    const result = await projectionFor(fileSystem, all).project({
      root,
      stack,
      runId: "run-0001" as never,
      selected: [{ definition: stdioServer }, { definition: rule }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileChanges.map((change) => String(change.destination)).sort()).toEqual(
      [CLAUDE_MCP_PATH, CLAUDE_RULES_PATH, CODEX_CONFIG_PATH, OPENCODE_CONFIG_PATH].sort(),
    );
    const projected = result.value.components.find((candidate) => candidate.component.id === stdioServer.id);
    expect(projected?.destinations.map(String).sort()).toEqual([CLAUDE_MCP_PATH, CODEX_CONFIG_PATH, OPENCODE_CONFIG_PATH].sort());
    expect(result.value.warnings).toEqual([]);
  });

  it("restricts the plan to the destinations of the targeted agent", async () => {
    const fileSystem = new FakeFileSystem();
    const result = await projectionFor(fileSystem, only("codex")).project({
      root,
      stack,
      runId: "run-0001" as never,
      selected: [{ definition: stdioServer }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileChanges.map((change) => String(change.destination))).toEqual([CODEX_CONFIG_PATH]);
  });

  it("warns instead of failing silently when no targeted agent can apply a component", async () => {
    const fileSystem = new FakeFileSystem();
    const result = await projectionFor(fileSystem, only("codex")).project({
      root,
      stack,
      runId: "run-0001" as never,
      selected: [{ definition: savedHook }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileChanges).toEqual([]);
    expect(result.value.warnings[0]?.code).toBe("COMPONENT_NOT_PROJECTED");
  });
});

describe("codex table rendering details", () => {
  it("quotes a dotted table key and escapes a command with quotes or backslashes", () => {
    const table = codexServerTable({ kind: "stdio", command: 'C:\\tools\\my "cli".exe', args: [] }, { id: "group.files" });
    expect(table[0]).toBe('[mcp_servers."group.files"]');
    expect(table[1]).toBe('command = "C:\\\\tools\\\\my \\"cli\\".exe"');
    expect(table).toHaveLength(2);
  });

  it("emits a bare url for a remote server without headers and supports sse and ws", () => {
    expect(codexServerTable({ kind: "sse", url: "https://a.example.com/sse" }, { id: "a" })).toEqual([
      "[mcp_servers.a]",
      'url = "https://a.example.com/sse"',
    ]);
    expect(codexServerTable({ kind: "ws", url: "https://b.example.com/ws" }, { id: "b" })).toEqual([
      "[mcp_servers.b]",
      'url = "https://b.example.com/ws"',
    ]);
  });

  it("appends after a document that already ends with a blank line", () => {
    const adapted = adaptCodexMcpDocument(source(CODEX_CONFIG_PATH, 'model = "gpt"\n\n'), [stdioServer.mcp]);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.value.text).not.toContain("\n\n\n");
    expect(adapted.value.text.trimEnd().endsWith("# auto-ai-setup:mcp:files:end")).toBe(true);
  });

  it("also detects a hand-written table written with a quoted key", () => {
    const adapted = adaptCodexMcpDocument(source(CODEX_CONFIG_PATH, '[mcp_servers."files"]\ncommand = "mine"\n'), [stdioServer.mcp]);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.value.skipped).toEqual(["files"]);
    expect(adapted.value.changed).toBe(false);
  });

  it("reports a managed Codex block as present after it is written", async () => {
    const fileSystem = new FakeFileSystem();
    const adapter = createCodexMcpAdapter(fileSystem, all);
    const [operation] = await adapter.propose(ctx, stdioServer);
    fileSystem.seed(CODEX_CONFIG_PATH, operation?.content ?? "");
    const [again] = await adapter.proposeAll(ctx, [stdioServer]);
    expect(again?.action).toBe("preserve");
    expect((await adapter.inspect({ root, stack }, stdioServer)).present).toBe(true);
  });
});

describe("markdown rules document details", () => {
  it("keeps an already correct block untouched", async () => {
    const fileSystem = new FakeFileSystem();
    const [first] = await createClaudeRulesAdapter(fileSystem, all).proposeAll(ctx, [rule]);
    fileSystem.seed(CLAUDE_RULES_PATH, first?.content ?? "");
    const [second] = await createClaudeRulesAdapter(fileSystem, all).proposeAll(ctx, [rule]);
    expect(second?.action).toBe("preserve");
    expect(second?.content).toBeUndefined();
    expect((await createClaudeRulesAdapter(fileSystem, all).inspect({ root, stack }, rule)).present).toBe(true);
  });

  it("rewrites a managed block whose content drifted and honours CRLF", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(
      CLAUDE_RULES_PATH,
      "# Title\r\n<!-- auto-ai-setup:rule:base:begin -->\r\nold\r\n<!-- auto-ai-setup:rule:base:end -->\r\n",
    );
    const [operation] = await createClaudeRulesAdapter(fileSystem, all).proposeAll(ctx, [rule]);
    expect(operation?.action).toBe("modify");
    expect(operation?.conflict).toBe("content-differs");
    expect(String(operation?.content)).toContain("\r\n");
    expect(String(operation?.content)).toContain("Lee el código antes de cambiarlo.");
  });

  it("appends a second managed block after the first one", async () => {
    const fileSystem = new FakeFileSystem();
    const other = { ...rule, id: "rule.git" as never, rule: { id: "git", content: "## Git\n\n- Conventional Commits." } };
    const [operation] = await createKiroSteeringAdapter(fileSystem, all).proposeAll(ctx, [rule, other]);
    expect(String(operation?.content)).toContain("auto-ai-setup:rule:base:end");
    expect(String(operation?.content)).toContain("auto-ai-setup:rule:git:begin");
    expect(operation?.destination).toBe(KIRO_STEERING_PATH);
  });
});

describe("kiro adapters honour the resolved target set", () => {
  it("proposes nothing and inspects nothing when Kiro is not targeted", async () => {
    const fileSystem = new FakeFileSystem();
    const resolver = only("codex");
    const mcp = createKiroMcpWorkspaceAdapter(fileSystem, undefined, resolver);
    const commands = createKiroCommandAdapter(fileSystem, undefined, resolver);
    const hooks = createKiroHookAdapter(fileSystem, undefined, resolver);
    expect(await mcp.proposeAll(ctx, [stdioServer])).toEqual([]);
    expect(await commands.proposeAll(ctx, [commandComponent])).toEqual([]);
    expect(await hooks.proposeAll(ctx, [commandHook])).toEqual([]);
    expect(await mcp.inspect({ root, stack }, stdioServer)).toEqual({ present: false, destinations: [] });
    expect(await commands.inspect({ root, stack }, commandComponent)).toEqual({ present: false, destinations: [] });
    expect(await hooks.inspect({ root, stack }, commandHook)).toEqual({ present: false, destinations: [] });
  });

  it("still writes the Kiro destinations when Kiro is targeted", async () => {
    const fileSystem = new FakeFileSystem();
    const resolver = only("kiro");
    const operations = [
      ...(await createKiroMcpWorkspaceAdapter(fileSystem, undefined, resolver).proposeAll(ctx, [stdioServer])),
      ...(await createKiroCommandAdapter(fileSystem, undefined, resolver).proposeAll(ctx, [commandComponent])),
      ...(await createKiroHookAdapter(fileSystem, undefined, resolver).proposeAll(ctx, [commandHook])),
    ];
    expect(operations.map((operation) => String(operation.destination)).sort()).toEqual(
      [".auto-ai-setup/commands.json", ".kiro/hooks/guard.json", ".kiro/prompts/review.md", ".kiro/settings/mcp.json"].sort(),
    );
  });
});

describe("failure and rejection paths", () => {
  it("treats an unreadable destination as unusable instead of guessing", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.failures.failAt("exists");
    expect(await createCodexMcpAdapter(fileSystem, all).proposeAll(ctx, [stdioServer])).toEqual([]);
    expect(await createClaudeCodeMcpAdapter(fileSystem, all).proposeAll(ctx, [stdioServer])).toEqual([]);
    expect(await createOpenCodeCommandAdapter(fileSystem, all).proposeAll(ctx, [commandComponent])).toEqual([]);
    expect(await createCodexHookAdapter(fileSystem, all).proposeAll(ctx, [commandHook])).toEqual([]);
    expect(await createClaudeRulesAdapter(fileSystem, all).proposeAll(ctx, [rule])).toEqual([]);
    expect((await createCodexMcpAdapter(fileSystem, all).inspect({ root, stack }, stdioServer)).present).toBe(false);
    expect((await createOpenCodeCommandAdapter(fileSystem, all).inspect({ root, stack }, commandComponent)).present).toBe(false);
    expect((await createCodexHookAdapter(fileSystem, all).inspect({ root, stack }, commandHook)).present).toBe(false);
    expect((await createClaudeRulesAdapter(fileSystem, all).inspect({ root, stack }, rule)).present).toBe(false);
  });

  it("refuses an unsafe rule id and an unsupported command id", async () => {
    const fileSystem = new FakeFileSystem();
    const unsafeRule = { ...rule, rule: { id: "../escape", content: "x" } };
    expect(await createClaudeRulesAdapter(fileSystem, all).proposeAll(ctx, [unsafeRule])).toEqual([]);
    expect((await createClaudeRulesAdapter(fileSystem, all).inspect({ root, stack }, unsafeRule)).present).toBe(false);
    const unsafeCommand = { ...commandComponent, command: { ...commandComponent.command, id: "../escape" } };
    expect(createClaudeCodeCommandAdapter(fileSystem, all).supports(unsafeCommand)).toBe(false);
    expect(await createClaudeCodeCommandAdapter(fileSystem, all).proposeAll(ctx, [unsafeCommand])).toEqual([]);
  });

  it("does not support a component of another type", () => {
    const fileSystem = new FakeFileSystem();
    expect(createClaudeCodeMcpAdapter(fileSystem, all).supports(rule as never)).toBe(false);
    expect(createCodexMcpAdapter(fileSystem, all).supports(commandComponent as never)).toBe(false);
    expect(createClaudeCodeCommandAdapter(fileSystem, all).supports(rule as never)).toBe(false);
    expect(createCodexHookAdapter(fileSystem, all).supports(rule as never)).toBe(false);
    expect(createClaudeRulesAdapter(fileSystem, all).supports(commandComponent as never)).toBe(false);
  });
});

describe("environment declarations and detection queries", () => {
  it("accepts env declared as a record and ignores an invalid variable name", () => {
    const withRecord = { ...stdioServer.mcp, env: { GOOD_TOKEN: "", "1bad": "" } };
    const claude = adaptMcpJsonDocument(source(CLAUDE_MCP_PATH, "{}\n"), [withRecord], claudeCodeMcpDialect);
    expect(claude.ok).toBe(true);
    if (!claude.ok) return;
    const files = (claude.value.model.mcpServers as Record<string, Record<string, unknown>>).files;
    expect(files?.env).toEqual({ GOOD_TOKEN: "${GOOD_TOKEN}" });
    const codex = adaptCodexMcpDocument(source(CODEX_CONFIG_PATH, ""), [withRecord]);
    expect(codex.ok && codex.value.text).toContain('env_vars = ["GOOD_TOKEN"]');
  });

  it("rejects a remote header that is not an environment placeholder", async () => {
    const literalHeader = { ...remoteServer, mcp: { ...remoteServer.mcp, headers: { Authorization: "Bearer abc123" } } };
    expect(await createCodexMcpAdapter(new FakeFileSystem(), all).proposeAll(ctx, [literalHeader])).toEqual([]);
    expect(adaptMcpJsonDocument(source(CLAUDE_MCP_PATH, "{}\n"), [literalHeader.mcp], claudeCodeMcpDialect).ok).toBe(false);
  });

  it("answers isTargeted and handles from a detected footprint", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed("opencode.json", "{}\n");
    const resolver = createAgentTargetResolver(fileSystem);
    expect(await resolver.isTargeted("opencode")).toBe(true);
    expect(await resolver.isTargeted("kiro")).toBe(false);
    expect(await resolver.handles("opencode", "agent-command")).toBe(true);
    expect(await resolver.handles("opencode", "agent-hook")).toBe(false);
  });
});
