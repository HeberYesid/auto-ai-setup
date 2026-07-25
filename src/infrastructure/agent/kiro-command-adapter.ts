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
  RedactedPreview,
  SafeProjectPath,
  ConfigError,
  JsonObject,
  JsonValue,
  ParsedConfig,
  SourceDocument,
  StructuredConfigCodec,
} from "../../domain/index.js";
import { asSafeProjectPath, err, ok } from "../../domain/index.js";
import { JsonStructuredConfigCodec, diffFields } from "../../domain/index.js";

export const KIRO_COMMANDS_INDEX_PATH = ".auto-ai-setup/commands.json";
export const KIRO_PROMPTS_PATH = ".kiro/prompts";

export interface KiroCommandDefinition {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly prompt?: string;
  /** `content` is accepted as an ergonomic alias for prompt bodies. */
  readonly content?: string;
  readonly metadata?: JsonObject;
  readonly index?: JsonObject;
}

export interface KiroCommandComponentDefinition extends ComponentDefinition {
  readonly type: "agent-command";
  readonly command: KiroCommandDefinition;
}

export interface KiroCommandIndexEntry extends JsonObject {
  readonly id: JsonValue;
  readonly name: JsonValue;
  readonly description: JsonValue;
  readonly promptPath: JsonValue;
}

export interface KiroCommandIndexAdaptation {
  readonly model: JsonObject;
  readonly text: string;
  readonly style: ParsedConfig<JsonObject>["style"];
  readonly commandIds: readonly string[];
  readonly changed: boolean;
  readonly conflict: "none" | "content-differs";
}

export interface KiroCommandDocumentsAdaptation {
  readonly promptText: string;
  readonly index: KiroCommandIndexAdaptation;
  readonly promptChanged: boolean;
  readonly promptConflict: "none" | "content-differs";
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
  for (const [key, value] of Object.entries(patch))
    result[key] = isRecord(result[key]) && isRecord(value) ? mergeObjects(result[key] as JsonObject, value) : clone(value);
  return result;
};
const isValidId = (id: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
const configError = (message: string, path = KIRO_COMMANDS_INDEX_PATH): ConfigError => ({
  code: "CONFIG_SCHEMA",
  message,
  path,
  location: "1:1",
  line: 1,
  column: 1,
  recoverability: "none",
});
const redactedText = (content: string): RedactedPreview => ({ kind: "text", content, truncated: false });
const promptFor = (definition: KiroCommandDefinition): Result<string, ConfigError> => {
  const prompt = definition.prompt ?? definition.content;
  return prompt === undefined ? err(configError("Kiro command must provide prompt content", "/commands")) : ok(prompt);
};

const promptPathFor = (id: string): Result<SafeProjectPath, ConfigError> => {
  const path = asSafeProjectPath(`${KIRO_PROMPTS_PATH}/${id}.md`);
  return path.ok ? ok(path.value) : err(configError("Kiro command id produces an unsafe prompt path", "/commands"));
};

const commandsFromModel = (model: JsonObject): Result<JsonObject, ConfigError> => {
  if (model.commands === undefined) return ok({});
  return isRecord(model.commands) ? ok(model.commands) : err(configError("commands must be an object", "/commands"));
};

const desiredEntry = (definition: KiroCommandDefinition, promptPath: SafeProjectPath): Result<JsonObject, ConfigError> => {
  if (!isValidId(definition.id)) return err(configError("Kiro command id contains unsafe characters", "/commands"));
  const prompt = promptFor(definition);
  if (!prompt.ok) return prompt;
  const metadata = definition.metadata ?? definition.index ?? {};
  if (!isRecord(metadata)) return err(configError("Kiro command metadata must be an object", `/commands/${definition.id}`));
  const entry: Record<string, JsonValue> = {
    ...metadata,
    id: definition.id,
    name: definition.name ?? definition.id,
    description: definition.description ?? "",
    promptPath,
  };
  void prompt;
  return ok(entry);
};

export const mergeKiroCommandIndex = (
  model: JsonObject,
  definition: KiroCommandDefinition,
  codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
): Result<JsonObject, ConfigError> => {
  const validated = codec.validate(model);
  if (!validated.ok) return validated;
  const promptPath = promptPathFor(definition.id);
  if (!promptPath.ok) return promptPath;
  const desired = desiredEntry(definition, promptPath.value);
  if (!desired.ok) return desired;
  const existing = commandsFromModel(validated.value);
  if (!existing.ok) return existing;
  const previous = existing.value[definition.id];
  const commands = mergeObjects(existing.value, {
    [definition.id]: isRecord(previous) ? mergeObjects(previous, desired.value) : desired.value,
  });
  return codec.validate(mergeObjects(validated.value, { commands }));
};

export const adaptKiroCommandIndex = (
  source: SourceDocument,
  definition: KiroCommandDefinition,
  codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
): Result<KiroCommandIndexAdaptation, ConfigError> => {
  const parsed = codec.parse(source);
  if (!parsed.ok) return parsed;
  const merged = mergeKiroCommandIndex(parsed.value.model, definition, codec);
  if (!merged.ok) return merged;
  const changed = !codec.equivalent(parsed.value.model, merged.value);
  const serialized = changed ? codec.serialize(merged.value, parsed.value.style) : ok(source.text);
  if (!serialized.ok) return serialized;
  const existingCommands = isRecord(parsed.value.model.commands) ? parsed.value.model.commands : {};
  const previous = existingCommands[definition.id];
  const wasPresent = previous !== undefined;
  const conflict =
    wasPresent &&
    (!isRecord(previous) ||
      !codec.equivalent(
        previous,
        merged.value.commands && isRecord(merged.value.commands)
          ? ((merged.value.commands as JsonObject)[definition.id] as JsonObject)
          : {},
      ))
      ? "content-differs"
      : "none";
  return ok({
    model: merged.value,
    text: serialized.value,
    style: parsed.value.style,
    commandIds: Object.keys(merged.value.commands as JsonObject),
    changed,
    conflict,
  });
};

export const adaptKiroCommandDocuments = (
  promptSource: SourceDocument,
  indexSource: SourceDocument,
  definition: KiroCommandDefinition,
  codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
): Result<KiroCommandDocumentsAdaptation, ConfigError> => {
  const prompt = promptFor(definition);
  if (!prompt.ok) return prompt;
  const index = adaptKiroCommandIndex(indexSource, definition, codec);
  if (!index.ok) return index;
  const promptChanged = promptSource.text !== prompt.value;
  return ok({
    promptText: prompt.value,
    index: index.value,
    promptChanged,
    promptConflict: promptSource.text.length > 0 && promptChanged ? "content-differs" : "none",
  });
};

export class KiroCommandAdapter implements ComponentAdapter<KiroCommandComponentDefinition> {
  private readonly indexDestination: SafeProjectPath;
  private readonly codec: StructuredConfigCodec<JsonObject>;

  public constructor(
    private readonly fileSystem: FileSystemPort,
    codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
  ) {
    const indexPath = asSafeProjectPath(KIRO_COMMANDS_INDEX_PATH);
    if (!indexPath.ok) throw new Error("Invalid Kiro command adapter destination");
    this.indexDestination = indexPath.value;
    this.codec = codec;
  }

  public supports(component: KiroCommandComponentDefinition): boolean {
    return component.type === "agent-command" && component.command !== undefined && isValidId(component.command.id);
  }

  public async inspect(_ctx: InspectionContext, component: KiroCommandComponentDefinition): Promise<CurrentComponentState> {
    const sources = await this.readSources(component.command.id);
    if (!sources.ok) return { present: false, destinations: [this.indexDestination] };
    const adapted = adaptKiroCommandDocuments(sources.value.prompt, sources.value.index, component.command, this.codec);
    return {
      present: adapted.ok && !adapted.value.promptChanged && !adapted.value.index.changed,
      destinations: [this.promptDestinationFor(component.command.id), this.indexDestination],
    };
  }

  public async propose(ctx: PlanningContext, component: KiroCommandComponentDefinition): Promise<readonly ProposedOperation[]> {
    return this.proposeAll(ctx, [component]);
  }

  /**
   * Prompt files are per command, but the command index is a single shared document, so the index
   * entries of every selected command are folded into one operation.
   */
  public async proposeAll(
    _ctx: PlanningContext,
    components: readonly KiroCommandComponentDefinition[],
  ): Promise<readonly ProposedOperation[]> {
    const selected = [...components].filter((component) => this.supports(component)).sort((left, right) => left.id.localeCompare(right.id));
    const primary = selected[0];
    if (primary === undefined) return [];
    const operations: ProposedOperation[] = [];
    let indexSource: SourceDocument | undefined;
    let indexParsedModel: JsonObject | undefined;
    let indexText: string | undefined;
    let indexModel: JsonObject | undefined;
    let indexChanged = false;
    let indexConflict: "none" | "content-differs" = "none";

    for (const component of selected) {
      const sources = await this.readSources(component.command.id);
      if (!sources.ok) return [];
      if (indexSource === undefined) {
        indexSource = sources.value.index;
        indexParsedModel = sources.value.indexParsedModel;
        indexText = sources.value.index.text;
      }
      const adapted = adaptKiroCommandDocuments(
        sources.value.prompt,
        { ...(indexSource as SourceDocument), text: indexText as string },
        component.command,
        this.codec,
      );
      if (!adapted.ok) return [];
      indexText = adapted.value.index.text;
      indexModel = adapted.value.index.model;
      indexChanged = indexChanged || adapted.value.index.changed;
      if (indexConflict === "none") indexConflict = adapted.value.index.conflict;
      const promptDestination = this.promptDestinationFor(component.command.id);
      const promptAction = adapted.value.promptChanged ? (sources.value.prompt.text.length === 0 ? "create" : "modify") : "preserve";
      operations.push({
        id: `command-prompt:${component.id}`,
        componentId: component.id,
        destination: promptDestination,
        action: promptAction,
        reason: `Create or update the Kiro prompt for command ${component.command.id}.`,
        conflict: adapted.value.promptConflict,
        preview: redactedText(adapted.value.promptText),
        ...(promptAction === "preserve" ? {} : { content: adapted.value.promptText }),
      });
    }

    if (indexModel === undefined || indexText === undefined || indexParsedModel === undefined) return operations;
    const indexAction = indexChanged ? ((indexSource as SourceDocument).text === "{}\n" ? "create" : "modify") : "preserve";
    const commandIds = selected.map((component) => component.command.id).join(", ");
    operations.push({
      id: `command-index:${selected.map((component) => component.id).join("+")}`,
      componentId: primary.id,
      componentIds: selected.map((component) => component.id),
      destination: this.indexDestination,
      action: indexAction,
      reason:
        selected.length === 1
          ? `Register command ${commandIds} in the managed Kiro command index.`
          : `Register commands ${commandIds} in the managed Kiro command index.`,
      conflict: indexConflict,
      preview: diffFields(indexParsedModel, indexModel),
      ...(indexAction === "preserve" ? {} : { content: indexText }),
    });
    return operations;
  }

  public async verify(_ctx: VerificationContext, operation: ProposedOperation): Promise<Result<void>> {
    const valid = operation.destination === this.indexDestination || operation.destination.startsWith(`${KIRO_PROMPTS_PATH}/`);
    return valid
      ? ok(undefined)
      : err({
          code: "INVALID_PLAN",
          message: "Kiro command operation has an unexpected destination",
          recoverability: "none",
          path: operation.destination,
        });
  }

  private promptDestinationFor(id: string): SafeProjectPath {
    const destination = asSafeProjectPath(`${KIRO_PROMPTS_PATH}/${id}.md`);
    if (!destination.ok) throw new Error(destination.error.message);
    return destination.value;
  }

  private async readSources(
    id: string,
  ): Promise<Result<{ prompt: SourceDocument; index: SourceDocument; indexParsedModel: JsonObject }, ConfigError>> {
    try {
      const promptDestination = this.promptDestinationFor(id);
      const promptExists = await this.fileSystem.exists(promptDestination);
      const indexExists = await this.fileSystem.exists(this.indexDestination);
      const prompt = promptExists ? new TextDecoder().decode(await this.fileSystem.read(promptDestination)) : "";
      const indexText = indexExists ? new TextDecoder().decode(await this.fileSystem.read(this.indexDestination)) : "{}\n";
      const indexSource: SourceDocument = { path: this.indexDestination, text: indexText, format: "json" };
      const parsed = this.codec.parse(indexSource);
      if (!parsed.ok) return parsed;
      return ok({
        prompt: { path: promptDestination, text: prompt, format: "json" },
        index: indexSource,
        indexParsedModel: parsed.value.model,
      });
    } catch (cause: unknown) {
      return err(configError(cause instanceof Error ? cause.message : "Unable to read Kiro command files"));
    }
  }
}

export const createKiroCommandAdapter = (fileSystem: FileSystemPort, codec?: StructuredConfigCodec<JsonObject>): KiroCommandAdapter =>
  new KiroCommandAdapter(fileSystem, codec);
export const KiroCommandWorkspaceAdapter = KiroCommandAdapter;
export const kiroCommandAdapter = KiroCommandAdapter;
