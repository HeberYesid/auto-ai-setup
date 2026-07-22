import type {
  ComponentAdapter,
  ComponentDefinition,
  CurrentComponentState,
  FileSystemPort,
  InspectionContext,
  PlanningContext,
  ProposedOperation,
  Result,
  VerificationContext,
  JsonObject,
  JsonValue,
  ManagedPatch,
  ParsedConfig,
  SourceDocument,
  StructuredConfigCodec,
  ConfigError,
  SafeProjectPath,
} from "../../domain/index.js";
import { asSafeProjectPath, err, ok } from "../../domain/index.js";
import { JsonStructuredConfigCodec, diffFields } from "../../domain/index.js";

export const KIRO_MCP_SETTINGS_PATH = ".kiro/settings/mcp.json";
export const MCP_SETTINGS_PATH = KIRO_MCP_SETTINGS_PATH;

export type EnvironmentVariableInput = readonly string[] | Readonly<Record<string, string>>;

/** A catalog-provided MCP definition. `env` values are deliberately ignored. */
export interface McpServerDefinition {
  readonly id: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: EnvironmentVariableInput;
  readonly configuration?: JsonObject;
  readonly options?: JsonObject;
}

export interface KiroMcpComponentDefinition extends ComponentDefinition {
  readonly type: "mcp-server";
  readonly mcp: McpServerDefinition;
}

export interface McpWorkspaceAdaptation {
  readonly model: JsonObject;
  readonly text: string;
  readonly style: ParsedConfig<JsonObject>["style"];
  readonly serverIds: readonly string[];
  readonly environmentVariableNames: readonly string[];
  readonly changed: boolean;
}

const isRecord = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmpty = (value: string): boolean => value.trim().length > 0;
const configError = (message: string, path = ""): ConfigError => ({
  code: "CONFIG_SCHEMA",
  message,
  path,
  location: "1:1",
  line: 1,
  column: 1,
  recoverability: "none",
});

const clone = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map((entry) => clone(entry));
  if (isRecord(value)) {
    const object: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) object[key] = clone(entry);
    return object;
  }
  return value;
};

const mergeObjects = (base: JsonObject, patch: JsonObject): JsonObject => {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(base)) result[key] = clone(value);
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value) ? mergeObjects(current, value) : clone(value);
  }
  return result;
};

const environmentNames = (env: EnvironmentVariableInput | undefined): readonly string[] => {
  if (env === undefined) return [];
  return (Array.isArray(env) ? env : Object.keys(env)).filter(
    (name, index, names) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && names.indexOf(name) === index,
  );
};

const environmentObject = (value: JsonValue | undefined, path: string): Result<JsonObject, ConfigError> => {
  if (value === undefined) return ok({});
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string")) return err(configError("MCP env must contain variable names", path));
    const names = environmentNames(value as readonly string[]);
    if (names.length !== value.length) return err(configError("MCP env contains an invalid variable name", path));
    return ok(Object.fromEntries(names.map((name) => [name, `\${${name}}`])) as JsonObject);
  }
  if (!isRecord(value)) return err(configError("MCP env must be an object or a list of names", path));
  const names = Object.keys(value);
  if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
    return err(configError("MCP env contains an invalid variable name", path));
  return ok(Object.fromEntries(names.map((name) => [name, `\${${name}}`])) as JsonObject);
};

const desiredServer = (definition: McpServerDefinition): Result<JsonObject, ConfigError> => {
  if (!isNonEmpty(definition.id)) return err(configError("MCP server id must not be empty", "/mcpServers"));
  if (definition.command !== undefined && !isNonEmpty(definition.command))
    return err(configError("MCP command must not be empty", "/mcpServers"));
  if (definition.args !== undefined && !definition.args.every((arg) => typeof arg === "string"))
    return err(configError("MCP args must contain strings", "/mcpServers"));
  let result: JsonObject = definition.configuration === undefined ? {} : (clone(definition.configuration) as JsonObject);
  if (definition.options !== undefined) result = mergeObjects(result, definition.options);
  if (definition.command !== undefined) result = mergeObjects(result, { command: definition.command });
  if (definition.args !== undefined) result = mergeObjects(result, { args: [...definition.args] });
  const envResult = environmentObject(result.env, `/mcpServers/${definition.id}/env`);
  if (!envResult.ok) return envResult;
  if (definition.env !== undefined) {
    const names = environmentNames(definition.env);
    if (names.length !== (Array.isArray(definition.env) ? definition.env.length : Object.keys(definition.env).length))
      return err(configError("MCP env contains an invalid variable name", `/mcpServers/${definition.id}/env`));
    result = mergeObjects(result, {
      env: mergeObjects(envResult.value, Object.fromEntries(names.map((name) => [name, `\${${name}}`])) as JsonObject),
    });
  } else if (result.env !== undefined) {
    result = mergeObjects(result, { env: envResult.value });
  }
  return ok(result);
};

const serversFromModel = (model: JsonObject): Result<JsonObject, ConfigError> => {
  const servers = model.mcpServers;
  if (servers === undefined) return ok({});
  if (!isRecord(servers)) return err(configError("mcpServers must be an object", "/mcpServers"));
  for (const [id, value] of Object.entries(servers))
    if (!isRecord(value)) return err(configError(`MCP server ${id} must be an object`, `/mcpServers/${id}`));
  return ok(servers);
};

export const mergeMcpServers = (
  model: JsonObject,
  definitions: readonly McpServerDefinition[],
  codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
): Result<JsonObject, ConfigError> => {
  const validated = codec.validate(model);
  if (!validated.ok) return validated;
  const existingResult = serversFromModel(validated.value);
  if (!existingResult.ok) return existingResult;
  const selected = new Set<string>();
  let servers: JsonObject = clone(existingResult.value) as JsonObject;
  for (const definition of definitions) {
    if (selected.has(definition.id)) return err(configError(`Duplicate MCP server id: ${definition.id}`, `/mcpServers/${definition.id}`));
    selected.add(definition.id);
    const desired = desiredServer(definition);
    if (!desired.ok) return desired;
    const previous = servers[definition.id];
    servers = mergeObjects(servers, { [definition.id]: isRecord(previous) ? mergeObjects(previous, desired.value) : desired.value });
  }
  const merged = mergeObjects(validated.value, { mcpServers: servers });
  return codec.validate(merged);
};

export const adaptKiroMcpDocument = (
  source: SourceDocument,
  definitions: readonly McpServerDefinition[],
  codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
): Result<McpWorkspaceAdaptation, ConfigError> => {
  const parsed = codec.parse(source);
  if (!parsed.ok) return parsed;
  const merged = mergeMcpServers(parsed.value.model, definitions, codec);
  if (!merged.ok) return merged;
  const serialized = codec.serialize(merged.value, parsed.value.style);
  if (!serialized.ok) return serialized;
  const names = definitions.flatMap((definition) => environmentNames(definition.env));
  return ok({
    model: merged.value,
    text: serialized.value,
    style: parsed.value.style,
    serverIds: Object.keys(merged.value.mcpServers as JsonObject),
    environmentVariableNames: [...new Set(names)].sort(),
    changed: !codec.equivalent(parsed.value.model, merged.value),
  });
};

const safePreview = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map((entry) => safePreview(entry));
  if (!isRecord(value)) return value;
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] =
      key === "env" && isRecord(entry)
        ? (Object.fromEntries(Object.keys(entry).map((name) => [name, `\${${name}}`])) as JsonObject)
        : safePreview(entry);
  }
  return result;
};

export class KiroMcpWorkspaceAdapter implements ComponentAdapter<KiroMcpComponentDefinition> {
  private readonly codec: StructuredConfigCodec<JsonObject>;
  private readonly destination: SafeProjectPath;

  public constructor(
    private readonly fileSystem: FileSystemPort,
    codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
  ) {
    this.codec = codec;
    const destination = asSafeProjectPath(KIRO_MCP_SETTINGS_PATH);
    if (!destination.ok) throw new Error(destination.error.message);
    this.destination = destination.value;
  }

  public supports(component: KiroMcpComponentDefinition): boolean {
    return component.type === "mcp-server" && component.mcp !== undefined;
  }

  public async inspect(_ctx: InspectionContext, component: KiroMcpComponentDefinition): Promise<CurrentComponentState> {
    const source = await this.readSource();
    if (!source.ok) return { present: false, destinations: [] };
    const parsed = this.codec.parse(source.value);
    if (!parsed.ok) return { present: false, destinations: [this.destination] };
    const current = isRecord(parsed.value.model.mcpServers) ? parsed.value.model.mcpServers[component.mcp.id] : undefined;
    const desired = desiredServer(component.mcp);
    return {
      present: desired.ok && isRecord(current) && this.codec.equivalent(current, mergeObjects(current, desired.value)),
      destinations: [this.destination],
    };
  }

  public async propose(_ctx: PlanningContext, component: KiroMcpComponentDefinition): Promise<readonly ProposedOperation[]> {
    const source = await this.readSource();
    if (!source.ok) return [];
    const parsed = this.codec.parse(source.value);
    if (!parsed.ok) return [];
    const adapted = adaptKiroMcpDocument(source.value, [component.mcp], this.codec);
    if (!adapted.ok) return [];
    const action = adapted.value.changed ? (parsed.value.model.mcpServers === undefined ? "create" : "modify") : "preserve";
    const preview = diffFields(safePreview(parsed.value.model), safePreview(adapted.value.model));
    return [
      {
        id: `mcp:${component.id}`,
        componentId: component.id,
        destination: this.destination,
        action,
        reason: `Configure MCP server ${component.mcp.id} in the Kiro workspace settings.`,
        conflict: action === "modify" ? "content-differs" : "none",
        preview,
      },
    ];
  }

  public async verify(_ctx: VerificationContext, operation: ProposedOperation): Promise<Result<void>> {
    return operation.destination === this.destination
      ? ok(undefined)
      : err({
          code: "INVALID_PLAN",
          message: "MCP operation has an unexpected destination",
          recoverability: "none",
          path: operation.destination,
        });
  }

  private async readSource(): Promise<Result<SourceDocument, ConfigError>> {
    try {
      const exists = await this.fileSystem.exists(this.destination);
      if (!exists) return ok({ path: this.destination, text: "{}\n", format: "json" });
      return ok({ path: this.destination, text: new TextDecoder().decode(await this.fileSystem.read(this.destination)), format: "json" });
    } catch (cause: unknown) {
      return err(configError(cause instanceof Error ? cause.message : "Unable to read MCP settings", KIRO_MCP_SETTINGS_PATH));
    }
  }
}

export const createKiroMcpWorkspaceAdapter = (
  fileSystem: FileSystemPort,
  codec?: StructuredConfigCodec<JsonObject>,
): KiroMcpWorkspaceAdapter => new KiroMcpWorkspaceAdapter(fileSystem, codec);
export const kiroMcpWorkspaceAdapter = KiroMcpWorkspaceAdapter;
export type { ManagedPatch };
