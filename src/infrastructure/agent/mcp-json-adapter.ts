import type {
  AgentId,
  ComponentAdapter,
  ConfigError,
  CurrentComponentState,
  FileSystemPort,
  InspectionContext,
  JsonObject,
  JsonValue,
  PlanningContext,
  ProposedOperation,
  Result,
  SafeProjectPath,
  SourceDocument,
  StructuredConfigCodec,
  VerificationContext,
} from "../../domain/index.js";
import { agentLabel, asSafeProjectPath, diffFields, err, JsonStructuredConfigCodec, ok } from "../../domain/index.js";
import type { AgentTargetResolver } from "./agent-targets.js";
import type { KiroMcpComponentDefinition, McpServerDefinition, McpTransport } from "./kiro-mcp-adapter.js";
import { resolveMcpTransport } from "./kiro-mcp-adapter.js";

export const CLAUDE_MCP_PATH = ".mcp.json";
export const OPENCODE_CONFIG_PATH = "opencode.json";
export const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

/**
 * A dialect describes how one agent spells an MCP server in its own JSON configuration. The neutral
 * transport is resolved first and only then projected, because the shapes genuinely differ: Claude
 * Code needs an explicit `type` for remote servers, while OpenCode discriminates every entry with
 * `type: "local" | "remote"` and passes the command as a single array.
 */
export interface McpJsonDialect {
  readonly agent: AgentId;
  readonly destination: string;
  /** Object holding the servers keyed by id, for example `mcpServers` or `mcp`. */
  readonly containerKey: string;
  /** Root fields added when the document is created from scratch. */
  readonly documentDefaults?: JsonObject;
  server(transport: McpTransport, definition: McpServerDefinition): JsonObject;
}

const isRecord = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const clone = (value: JsonValue): JsonValue =>
  Array.isArray(value)
    ? value.map(clone)
    : isRecord(value)
      ? (Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) as JsonObject)
      : value;
const mergeObjects = (base: JsonObject, patch: JsonObject): JsonObject => {
  const result: Record<string, JsonValue> = Object.fromEntries(Object.entries(base).map(([key, value]) => [key, clone(value)]));
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value) ? mergeObjects(current, value) : clone(value);
  }
  return result;
};
const configErrorFor = (message: string, path: string): ConfigError => ({
  code: "CONFIG_SCHEMA",
  message,
  path,
  location: "1:1",
  line: 1,
  column: 1,
  recoverability: "none",
});

const isValidName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

/** Environment variable names declared by a component, without any value. */
export const mcpEnvironmentNames = (definition: McpServerDefinition): readonly string[] => {
  const env = definition.env;
  if (env === undefined) return [];
  const names = Array.isArray(env) ? env : Object.keys(env);
  return names.filter((name, index) => isValidName(name) && names.indexOf(name) === index);
};

const placeholderPattern = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
/** Rewrites a `${NAME}` placeholder into the dialect's own interpolation syntax. */
const openCodePlaceholder = (value: string): string => {
  const match = placeholderPattern.exec(value);
  return match === null ? value : `{env:${match[1] as string}}`;
};

export const claudeCodeMcpDialect: McpJsonDialect = {
  agent: "claude-code",
  destination: CLAUDE_MCP_PATH,
  containerKey: "mcpServers",
  server: (transport, definition) => {
    const env = mcpEnvironmentNames(definition);
    const environment = env.length === 0 ? {} : { env: Object.fromEntries(env.map((name) => [name, `\${${name}}`])) as JsonObject };
    // A `.mcp.json` entry without `type` is read as stdio, so a remote server must declare it.
    return transport.kind === "stdio"
      ? ({
          command: transport.command,
          ...(transport.args.length === 0 ? {} : { args: [...transport.args] }),
          ...environment,
        } as JsonObject)
      : ({
          type: transport.kind,
          url: transport.url,
          ...(transport.headers === undefined ? {} : { headers: { ...transport.headers } }),
          ...environment,
        } as JsonObject);
  },
};

export const openCodeMcpDialect: McpJsonDialect = {
  agent: "opencode",
  destination: OPENCODE_CONFIG_PATH,
  containerKey: "mcp",
  documentDefaults: { $schema: OPENCODE_CONFIG_SCHEMA },
  server: (transport, definition) => {
    if (transport.kind === "stdio") {
      const env = mcpEnvironmentNames(definition);
      return {
        type: "local",
        command: [transport.command, ...transport.args],
        enabled: true,
        ...(env.length === 0 ? {} : { environment: Object.fromEntries(env.map((name) => [name, `{env:${name}}`])) as JsonObject }),
      } as JsonObject;
    }
    // OpenCode only models `local` and `remote`; sse and ws are reached through the remote type.
    return {
      type: "remote",
      url: transport.url,
      enabled: true,
      ...(transport.headers === undefined
        ? {}
        : { headers: Object.fromEntries(Object.entries(transport.headers).map(([name, value]) => [name, openCodePlaceholder(value)])) }),
    } as JsonObject;
  },
};

export interface McpJsonAdaptation {
  readonly model: JsonObject;
  readonly text: string;
  readonly serverIds: readonly string[];
  readonly changed: boolean;
}

export const mergeMcpJsonServers = (
  model: JsonObject,
  definitions: readonly McpServerDefinition[],
  dialect: McpJsonDialect,
  codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
): Result<JsonObject, ConfigError> => {
  const validated = codec.validate(model);
  if (!validated.ok) return validated;
  const container = validated.value[dialect.containerKey];
  if (container !== undefined && !isRecord(container))
    return err(configErrorFor(`${dialect.containerKey} must be an object`, `/${dialect.containerKey}`));
  let servers: JsonObject = container === undefined ? {} : (clone(container) as JsonObject);
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.id))
      return err(configErrorFor(`Duplicate MCP server id: ${definition.id}`, `/${dialect.containerKey}/${definition.id}`));
    seen.add(definition.id);
    const transport = resolveMcpTransport(definition);
    if (!transport.ok) return transport;
    const desired = dialect.server(transport.value, definition);
    const previous = servers[definition.id];
    servers = mergeObjects(servers, { [definition.id]: isRecord(previous) ? mergeObjects(previous, desired) : desired });
  }
  const defaults = dialect.documentDefaults ?? {};
  // Root defaults such as `$schema` are only added when absent; a user value is never overwritten.
  const missingDefaults = Object.fromEntries(Object.entries(defaults).filter(([key]) => validated.value[key] === undefined)) as JsonObject;
  return codec.validate(mergeObjects(validated.value, { ...missingDefaults, [dialect.containerKey]: servers }));
};

export const adaptMcpJsonDocument = (
  source: SourceDocument,
  definitions: readonly McpServerDefinition[],
  dialect: McpJsonDialect,
  codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
): Result<McpJsonAdaptation, ConfigError> => {
  const parsed = codec.parse(source);
  if (!parsed.ok) return parsed;
  const merged = mergeMcpJsonServers(parsed.value.model, definitions, dialect, codec);
  if (!merged.ok) return merged;
  const changed = !codec.equivalent(parsed.value.model, merged.value);
  const serialized = changed ? codec.serialize(merged.value, parsed.value.style) : ok(source.text);
  if (!serialized.ok) return serialized;
  const container = merged.value[dialect.containerKey];
  return ok({
    model: merged.value,
    text: serialized.value,
    serverIds: isRecord(container) ? Object.keys(container) : [],
    changed,
  });
};

const safePreview = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(safePreview);
  if (!isRecord(value)) return value;
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "env" || key === "environment") && isRecord(entry)) {
      result[key] = Object.fromEntries(Object.keys(entry).map((name) => [name, `\${${name}}`])) as JsonObject;
      continue;
    }
    if (key === "headers" && isRecord(entry)) {
      result[key] = Object.fromEntries(
        Object.entries(entry).map(([name, header]) => [
          name,
          typeof header === "string" && (placeholderPattern.test(header) || /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(header))
            ? header
            : "***",
        ]),
      ) as JsonObject;
      continue;
    }
    result[key] = safePreview(entry);
  }
  return result;
};

/** Writes the MCP section of one agent's JSON configuration. It never starts an MCP server. */
export class McpJsonWorkspaceAdapter implements ComponentAdapter<KiroMcpComponentDefinition> {
  private readonly destination: SafeProjectPath;
  private readonly codec: StructuredConfigCodec<JsonObject>;

  public constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly dialect: McpJsonDialect,
    private readonly targets: AgentTargetResolver,
    codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
  ) {
    const destination = asSafeProjectPath(dialect.destination);
    if (!destination.ok) throw new Error(destination.error.message);
    this.destination = destination.value;
    this.codec = codec;
  }

  public supports(component: KiroMcpComponentDefinition): boolean {
    return component.type === "mcp-server" && component.mcp !== undefined;
  }

  public async inspect(_ctx: InspectionContext, component: KiroMcpComponentDefinition): Promise<CurrentComponentState> {
    if (!(await this.targets.handles(this.dialect.agent, "mcp-server"))) return { present: false, destinations: [] };
    const source = await this.readSource();
    if (!source.ok) return { present: false, destinations: [this.destination] };
    const parsed = this.codec.parse(source.value);
    if (!parsed.ok) return { present: false, destinations: [this.destination] };
    const container = parsed.value.model[this.dialect.containerKey];
    const current = isRecord(container) ? container[component.mcp.id] : undefined;
    const transport = resolveMcpTransport(component.mcp);
    if (!transport.ok || !isRecord(current)) return { present: false, destinations: [this.destination] };
    const desired = this.dialect.server(transport.value, component.mcp);
    return { present: this.codec.equivalent(current, mergeObjects(current, desired)), destinations: [this.destination] };
  }

  public async propose(ctx: PlanningContext, component: KiroMcpComponentDefinition): Promise<readonly ProposedOperation[]> {
    return this.proposeAll(ctx, [component]);
  }

  /** Every MCP component of one agent shares a single destination, so they collapse into one action. */
  public async proposeAll(_ctx: PlanningContext, components: readonly KiroMcpComponentDefinition[]): Promise<readonly ProposedOperation[]> {
    if (!(await this.targets.handles(this.dialect.agent, "mcp-server"))) return [];
    const selected = [...components].sort((left, right) => left.id.localeCompare(right.id));
    const primary = selected[0];
    if (primary === undefined) return [];
    const source = await this.readSource();
    if (!source.ok) return [];
    const parsed = this.codec.parse(source.value);
    if (!parsed.ok) return [];
    const adapted = adaptMcpJsonDocument(
      source.value,
      selected.map((component) => component.mcp),
      this.dialect,
      this.codec,
    );
    if (!adapted.ok) return [];
    const existed = parsed.value.model[this.dialect.containerKey] !== undefined;
    const action = adapted.value.changed ? (existed ? "modify" : "create") : "preserve";
    const serverIds = selected.map((component) => component.mcp.id).join(", ");
    return [
      {
        id: `mcp:${this.dialect.agent}:${selected.map((component) => component.id).join("+")}`,
        componentId: primary.id,
        componentIds: selected.map((component) => component.id),
        destination: this.destination,
        action,
        reason: `Configure MCP ${selected.length === 1 ? "server" : "servers"} ${serverIds} for ${agentLabel(this.dialect.agent)} in ${this.dialect.destination}.`,
        conflict: action === "modify" ? "content-differs" : "none",
        preview: diffFields(safePreview(parsed.value.model), safePreview(adapted.value.model)),
        ...(action === "preserve" ? {} : { content: adapted.value.text }),
      },
    ];
  }

  public async verify(_ctx: VerificationContext, operation: ProposedOperation): Promise<Result<void>> {
    return operation.destination === this.destination
      ? ok(undefined)
      : err({
          code: "INVALID_PLAN",
          message: `MCP operation for ${this.dialect.agent} has an unexpected destination`,
          recoverability: "none",
          path: operation.destination,
        });
  }

  private async readSource(): Promise<Result<SourceDocument, ConfigError>> {
    try {
      const exists = await this.fileSystem.exists(this.destination);
      const text = exists ? new TextDecoder().decode(await this.fileSystem.read(this.destination)) : "{}\n";
      return ok({ path: this.destination, text, format: "json" });
    } catch (cause: unknown) {
      return err(configErrorFor(cause instanceof Error ? cause.message : "Unable to read the MCP configuration", this.dialect.destination));
    }
  }
}

export const createClaudeCodeMcpAdapter = (
  fileSystem: FileSystemPort,
  targets: AgentTargetResolver,
  codec?: StructuredConfigCodec<JsonObject>,
): McpJsonWorkspaceAdapter => new McpJsonWorkspaceAdapter(fileSystem, claudeCodeMcpDialect, targets, codec);

export const createOpenCodeMcpAdapter = (
  fileSystem: FileSystemPort,
  targets: AgentTargetResolver,
  codec?: StructuredConfigCodec<JsonObject>,
): McpJsonWorkspaceAdapter => new McpJsonWorkspaceAdapter(fileSystem, openCodeMcpDialect, targets, codec);
