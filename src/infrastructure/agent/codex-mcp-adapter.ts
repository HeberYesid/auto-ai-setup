import type {
  ComponentAdapter,
  ConfigError,
  CurrentComponentState,
  FileSystemPort,
  InspectionContext,
  PlanningContext,
  ProposedOperation,
  RedactedPreview,
  Result,
  SafeProjectPath,
  SourceDocument,
  VerificationContext,
} from "../../domain/index.js";
import { asSafeProjectPath, err, ok } from "../../domain/index.js";
import type { AgentTargetResolver } from "./agent-targets.js";
import type { KiroMcpComponentDefinition, McpServerDefinition, McpTransport } from "./kiro-mcp-adapter.js";
import { resolveMcpTransport } from "./kiro-mcp-adapter.js";
import { mcpEnvironmentNames } from "./mcp-json-adapter.js";

export const CODEX_CONFIG_PATH = ".codex/config.toml";

/**
 * Codex reads MCP servers only from `config.toml`, so this adapter is the single place in the MVP
 * that writes a non-JSON file. It deliberately does not parse TOML: each server is emitted as a
 * marker-delimited block, exactly like the managed blocks in AGENTS.md. Everything outside the
 * markers is preserved byte for byte, which keeps user comments, ordering, and unknown tables intact
 * without needing a TOML codec with round-trip guarantees.
 */
const beginMarker = (id: string): string => `# auto-ai-setup:mcp:${id}:begin`;
const endMarker = (id: string): string => `# auto-ai-setup:mcp:${id}:end`;

const isValidId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
const isBareKey = (id: string): boolean => /^[A-Za-z0-9_-]+$/.test(id);
const configError = (message: string, path = CODEX_CONFIG_PATH): ConfigError => ({
  code: "CONFIG_SCHEMA",
  message,
  path,
  location: "1:1",
  line: 1,
  column: 1,
  recoverability: "none",
});

const tomlString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const tomlKey = (id: string): string => (isBareKey(id) ? id : tomlString(id));
const tomlArray = (values: readonly string[]): string => `[${values.map(tomlString).join(", ")}]`;
const placeholderPattern = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Renders the `[mcp_servers.<id>]` table for one server in the Codex dialect. */
export const codexServerTable = (transport: McpTransport, definition: McpServerDefinition): readonly string[] => {
  const lines = [`[mcp_servers.${tomlKey(definition.id)}]`];
  if (transport.kind === "stdio") {
    lines.push(`command = ${tomlString(transport.command)}`);
    if (transport.args.length > 0) lines.push(`args = ${tomlArray(transport.args)}`);
    // Codex has no `${VAR}` expansion: `env_vars` forwards the variable from the local environment,
    // so no secret value is ever written to the file.
    const env = mcpEnvironmentNames(definition);
    if (env.length > 0) lines.push(`env_vars = ${tomlArray(env)}`);
    return lines;
  }
  lines.push(`url = ${tomlString(transport.url)}`);
  const headers = Object.entries(transport.headers ?? {});
  const fromEnvironment = headers
    .map(([name, value]) => [name, placeholderPattern.exec(value)?.[1]] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
  if (fromEnvironment.length > 0)
    lines.push(
      `env_http_headers = { ${fromEnvironment.map(([name, variable]) => `${tomlKey(name)} = ${tomlString(variable)}`).join(", ")} }`,
    );
  return lines;
};

interface ManagedBlock {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

const findBlocks = (lines: readonly string[]): readonly ManagedBlock[] => {
  const blocks: ManagedBlock[] = [];
  let open: { id: string; start: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    const marker = /^# auto-ai-setup:mcp:([A-Za-z0-9][A-Za-z0-9._-]*):(begin|end)$/.exec(trimmed);
    if (marker === null) continue;
    const id = marker[1] as string;
    if (marker[2] === "begin") {
      open = { id, start: index };
      continue;
    }
    if (open !== undefined && open.id === id) blocks.push({ id, start: open.start, end: index });
    open = undefined;
  }
  return blocks;
};

/** True when the document declares the server outside any managed block. */
const hasUnmanagedTable = (lines: readonly string[], blocks: readonly ManagedBlock[], id: string): boolean => {
  const header = new RegExp(
    `^\\[mcp_servers\\.(?:${id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}|"${id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}")(?:\\.|\\])`,
  );
  return lines.some((line, index) => header.test(line.trim()) && !blocks.some((block) => index > block.start && index < block.end));
};

export interface CodexMcpAdaptation {
  readonly text: string;
  readonly changed: boolean;
  readonly conflict: "none" | "content-differs" | "ownership-unknown";
  readonly serverIds: readonly string[];
  readonly skipped: readonly string[];
}

export const adaptCodexMcpDocument = (
  source: SourceDocument,
  definitions: readonly McpServerDefinition[],
): Result<CodexMcpAdaptation, ConfigError> => {
  const eol = source.text.includes("\r\n") ? "\r\n" : "\n";
  let lines = source.text.length === 0 ? [] : source.text.split(/\r\n|\n/);
  let changed = false;
  let conflict: CodexMcpAdaptation["conflict"] = "none";
  const written: string[] = [];
  const skipped: string[] = [];

  for (const definition of [...definitions].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!isValidId(definition.id)) return err(configError(`MCP server id ${definition.id} is not a safe Codex table name`));
    const transport = resolveMcpTransport(definition);
    if (!transport.ok) return transport;
    const block = [beginMarker(definition.id), ...codexServerTable(transport.value, definition), endMarker(definition.id)];
    const blocks = findBlocks(lines);
    const existing = blocks.find((candidate) => candidate.id === definition.id);
    if (existing === undefined && hasUnmanagedTable(lines, blocks, definition.id)) {
      // The user already declares this server by hand. Their table stays untouched.
      conflict = "ownership-unknown";
      skipped.push(definition.id);
      continue;
    }
    written.push(definition.id);
    if (existing === undefined) {
      // Trailing blank lines are collapsed so an appended block is always separated by exactly one.
      const trimmed = [...lines];
      while (trimmed.length > 0 && (trimmed[trimmed.length - 1] ?? "").trim().length === 0) trimmed.pop();
      lines = trimmed.length === 0 ? [...block] : [...trimmed, "", ...block];
      changed = true;
      continue;
    }
    const current = lines.slice(existing.start, existing.end + 1);
    if (current.length === block.length && current.every((line, index) => line === block[index])) continue;
    lines = [...lines.slice(0, existing.start), ...block, ...lines.slice(existing.end + 1)];
    changed = true;
    if (conflict === "none") conflict = "content-differs";
  }

  const text = lines.length === 0 ? "" : `${lines.join(eol).replace(/(\r?\n)+$/u, "")}${eol}`;
  return ok({ text, changed: changed || text !== source.text, conflict, serverIds: written, skipped });
};

const redactedText = (content: string): RedactedPreview => ({ kind: "text", content, truncated: false });

/** Writes managed `[mcp_servers.*]` blocks in `.codex/config.toml`. It never starts an MCP server. */
export class CodexMcpAdapter implements ComponentAdapter<KiroMcpComponentDefinition> {
  private readonly destination: SafeProjectPath;

  public constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly targets: AgentTargetResolver,
  ) {
    const destination = asSafeProjectPath(CODEX_CONFIG_PATH);
    if (!destination.ok) throw new Error(destination.error.message);
    this.destination = destination.value;
  }

  public supports(component: KiroMcpComponentDefinition): boolean {
    return component.type === "mcp-server" && component.mcp !== undefined;
  }

  public async inspect(_ctx: InspectionContext, component: KiroMcpComponentDefinition): Promise<CurrentComponentState> {
    if (!(await this.targets.handles("codex", "mcp-server"))) return { present: false, destinations: [] };
    const source = await this.readSource();
    if (!source.ok) return { present: false, destinations: [this.destination] };
    const adapted = adaptCodexMcpDocument(source.value, [component.mcp]);
    return { present: adapted.ok && !adapted.value.changed, destinations: [this.destination] };
  }

  public async propose(ctx: PlanningContext, component: KiroMcpComponentDefinition): Promise<readonly ProposedOperation[]> {
    return this.proposeAll(ctx, [component]);
  }

  public async proposeAll(_ctx: PlanningContext, components: readonly KiroMcpComponentDefinition[]): Promise<readonly ProposedOperation[]> {
    if (!(await this.targets.handles("codex", "mcp-server"))) return [];
    const selected = [...components].sort((left, right) => left.id.localeCompare(right.id));
    const primary = selected[0];
    if (primary === undefined) return [];
    const source = await this.readSource();
    if (!source.ok) return [];
    const adapted = adaptCodexMcpDocument(
      source.value,
      selected.map((component) => component.mcp),
    );
    if (!adapted.ok) return [];
    const action = adapted.value.changed ? (source.value.text.trim().length === 0 ? "create" : "modify") : "preserve";
    const serverIds = selected.map((component) => component.mcp.id).join(", ");
    const skipped =
      adapted.value.skipped.length === 0
        ? ""
        : ` Se conservan sin cambios los servidores ya declarados a mano: ${adapted.value.skipped.join(", ")}.`;
    return [
      {
        id: `mcp:codex:${selected.map((component) => component.id).join("+")}`,
        componentId: primary.id,
        componentIds: selected.map((component) => component.id),
        destination: this.destination,
        action,
        reason: `Configure MCP ${selected.length === 1 ? "server" : "servers"} ${serverIds} for OpenAI Codex in ${CODEX_CONFIG_PATH}.${skipped}`,
        conflict: adapted.value.conflict,
        preview: redactedText(adapted.value.text),
        ...(action === "preserve" ? {} : { content: adapted.value.text }),
      },
    ];
  }

  public async verify(_ctx: VerificationContext, operation: ProposedOperation): Promise<Result<void>> {
    return operation.destination === this.destination
      ? ok(undefined)
      : err({
          code: "INVALID_PLAN",
          message: "Codex MCP operation has an unexpected destination",
          recoverability: "none",
          path: operation.destination,
        });
  }

  private async readSource(): Promise<Result<SourceDocument, ConfigError>> {
    try {
      const exists = await this.fileSystem.exists(this.destination);
      const text = exists ? new TextDecoder().decode(await this.fileSystem.read(this.destination)) : "";
      return ok({ path: this.destination, text, format: "json" });
    } catch (cause: unknown) {
      return err(configError(cause instanceof Error ? cause.message : "Unable to read the Codex configuration"));
    }
  }
}

export const createCodexMcpAdapter = (fileSystem: FileSystemPort, targets: AgentTargetResolver): CodexMcpAdapter =>
  new CodexMcpAdapter(fileSystem, targets);
