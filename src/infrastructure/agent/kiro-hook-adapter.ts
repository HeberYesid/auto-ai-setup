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
  SafeProjectPath,
  ConfigError,
  JsonObject,
  SourceDocument,
  StructuredConfigCodec,
} from "../../domain/index.js";
import { asSafeProjectPath, err, ok } from "../../domain/index.js";
import { JsonStructuredConfigCodec, diffFields } from "../../domain/index.js";

export const KIRO_HOOKS_PATH = ".kiro/hooks";

/**
 * Triggers accepted by the agent hook runtime. The set is closed on purpose: an unknown trigger
 * would be written to disk and silently ignored by the agent.
 */
export type AgentHookTrigger =
  | "PreToolUse"
  | "PostToolUse"
  | "SessionStart"
  | "Stop"
  | "UserPromptSubmit"
  | "PreTaskExec"
  | "PostTaskExec"
  | "PostFileCreate"
  | "PostFileSave"
  | "PostFileDelete";

export const AGENT_HOOK_TRIGGERS: readonly AgentHookTrigger[] = [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "Stop",
  "UserPromptSubmit",
  "PreTaskExec",
  "PostTaskExec",
  "PostFileCreate",
  "PostFileSave",
  "PostFileDelete",
];

/**
 * A hook action is configuration only. auto-ai-setup writes it and never runs it: a `command`
 * action is executed later by the agent runtime after its own confirmation.
 */
export type AgentHookAction =
  { readonly type: "command"; readonly command: string; readonly timeout?: number } | { readonly type: "agent"; readonly prompt: string };

export interface AgentHookDefinition {
  readonly id: string;
  readonly name: string;
  readonly trigger: AgentHookTrigger;
  /** Regex filtering which events fire the hook; semantics depend on the trigger. */
  readonly matcher?: string;
  readonly action: AgentHookAction;
}

export interface AgentHookComponentDefinition extends ComponentDefinition {
  readonly type: "agent-hook";
  readonly hook: AgentHookDefinition;
}

export interface AgentHookAdaptation {
  readonly model: JsonObject;
  readonly text: string;
  readonly changed: boolean;
  readonly conflict: "none" | "content-differs";
}

const isValidId = (id: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
const configError = (message: string, path = KIRO_HOOKS_PATH): ConfigError => ({
  code: "CONFIG_SCHEMA",
  message,
  path,
  location: "1:1",
  line: 1,
  column: 1,
  recoverability: "none",
});

const isValidMatcher = (matcher: string): boolean => {
  try {
    new RegExp(matcher, "u");
    return true;
  } catch {
    return false;
  }
};

export const validateAgentHook = (definition: AgentHookDefinition): Result<AgentHookDefinition, ConfigError> => {
  if (!isValidId(definition.id)) return err(configError("Agent hook id contains unsafe characters"));
  if (definition.name.trim().length === 0) return err(configError(`Agent hook ${definition.id} requires a name`));
  if (!AGENT_HOOK_TRIGGERS.includes(definition.trigger))
    return err(configError(`Agent hook ${definition.id} declares an unsupported trigger`));
  if (definition.matcher !== undefined && !isValidMatcher(definition.matcher))
    return err(configError(`Agent hook ${definition.id} declares an invalid matcher`));
  if (definition.action.type === "command") {
    if (definition.action.command.trim().length === 0) return err(configError(`Agent hook ${definition.id} requires a command`));
    if (definition.action.timeout !== undefined && !(Number.isInteger(definition.action.timeout) && definition.action.timeout > 0))
      return err(configError(`Agent hook ${definition.id} declares an invalid timeout`));
  } else if (definition.action.prompt.trim().length === 0) {
    return err(configError(`Agent hook ${definition.id} requires a prompt`));
  }
  return ok(definition);
};

const actionModel = (action: AgentHookAction): JsonObject =>
  action.type === "command"
    ? ({ type: "command", command: action.command, ...(action.timeout === undefined ? {} : { timeout: action.timeout }) } as JsonObject)
    : ({ type: "agent", prompt: action.prompt } as JsonObject);

/** Deterministic, canonically ordered document for a single managed hook file. */
export const agentHookModel = (definition: AgentHookDefinition): JsonObject =>
  ({
    version: "v1",
    hooks: [
      {
        name: definition.name,
        trigger: definition.trigger,
        ...(definition.matcher === undefined ? {} : { matcher: definition.matcher }),
        action: actionModel(definition.action),
      },
    ],
  }) as JsonObject;

/**
 * A hook file is entirely owned by auto-ai-setup, so the managed `version`/`hooks` fields are
 * replaced while any unknown top-level field a user added is preserved.
 */
export const adaptAgentHookDocument = (
  source: SourceDocument,
  definition: AgentHookDefinition,
  codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
): Result<AgentHookAdaptation, ConfigError> => {
  const validated = validateAgentHook(definition);
  if (!validated.ok) return validated;
  const parsed = codec.parse(source);
  if (!parsed.ok) return parsed;
  const desired = agentHookModel(definition);
  const merged: JsonObject = { ...parsed.value.model, ...desired };
  const validatedModel = codec.validate(merged);
  if (!validatedModel.ok) return validatedModel;
  const changed = !codec.equivalent(parsed.value.model, validatedModel.value);
  const serialized = changed ? codec.serialize(validatedModel.value, parsed.value.style) : ok(source.text);
  if (!serialized.ok) return serialized;
  return ok({
    model: validatedModel.value,
    text: serialized.value,
    changed,
    conflict: changed && source.text.trim().length > 0 && source.text.trim() !== "{}" ? ("content-differs" as const) : ("none" as const),
  });
};

/** Writes `.kiro/hooks/<id>.json` files. It never executes a hook or its command. */
export class KiroHookAdapter implements ComponentAdapter<AgentHookComponentDefinition> {
  private readonly codec: StructuredConfigCodec<JsonObject>;

  public constructor(
    private readonly fileSystem: FileSystemPort,
    codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
    private readonly targets?: import("./agent-targets.js").AgentTargetResolver,
  ) {
    this.codec = codec;
  }

  public supports(component: AgentHookComponentDefinition): boolean {
    return component.type === "agent-hook" && component.hook !== undefined && validateAgentHook(component.hook).ok;
  }

  /** Without a resolver the adapter is unconditional, which keeps a Kiro-only setup simple. */
  private async applies(): Promise<boolean> {
    return this.targets === undefined || (await this.targets.handles("kiro", "agent-hook"));
  }

  public async inspect(_ctx: InspectionContext, component: AgentHookComponentDefinition): Promise<CurrentComponentState> {
    if (!(await this.applies())) return { present: false, destinations: [] };
    const destination = this.destinationFor(component.hook.id);
    const source = await this.readSource(destination);
    if (!source.ok) return { present: false, destinations: [destination] };
    const adapted = adaptAgentHookDocument(source.value, component.hook, this.codec);
    return { present: adapted.ok && !adapted.value.changed, destinations: [destination] };
  }

  public async propose(ctx: PlanningContext, component: AgentHookComponentDefinition): Promise<readonly ProposedOperation[]> {
    return this.proposeAll(ctx, [component]);
  }

  /** Each hook owns its own file, so one operation per component is emitted. */
  public async proposeAll(
    _ctx: PlanningContext,
    components: readonly AgentHookComponentDefinition[],
  ): Promise<readonly ProposedOperation[]> {
    if (!(await this.applies())) return [];
    const selected = [...components].filter((component) => this.supports(component)).sort((left, right) => left.id.localeCompare(right.id));
    const operations: ProposedOperation[] = [];
    for (const component of selected) {
      const destination = this.destinationFor(component.hook.id);
      const source = await this.readSource(destination);
      if (!source.ok) return [];
      const parsed = this.codec.parse(source.value);
      if (!parsed.ok) return [];
      const adapted = adaptAgentHookDocument(source.value, component.hook, this.codec);
      if (!adapted.ok) return [];
      const existed = source.value.text.trim().length > 0 && source.value.text.trim() !== "{}";
      const action = adapted.value.changed ? (existed ? "modify" : "create") : "preserve";
      operations.push({
        id: `hook:kiro:${component.id}`,
        componentId: component.id,
        destination,
        action,
        reason: `Register the managed agent hook ${component.hook.id}; auto-ai-setup writes the configuration and never runs it.`,
        conflict: adapted.value.conflict,
        preview: diffFields(parsed.value.model, adapted.value.model),
        ...(action === "preserve" ? {} : { content: adapted.value.text }),
      });
    }
    return operations;
  }

  public async verify(_ctx: VerificationContext, operation: ProposedOperation): Promise<Result<void>> {
    return operation.destination.startsWith(`${KIRO_HOOKS_PATH}/`)
      ? ok(undefined)
      : err({
          code: "INVALID_PLAN",
          message: "Agent hook operation has an unexpected destination",
          recoverability: "none",
          path: operation.destination,
        });
  }

  private destinationFor(id: string): SafeProjectPath {
    const destination = asSafeProjectPath(`${KIRO_HOOKS_PATH}/${id}.json`);
    if (!destination.ok) throw new Error(destination.error.message);
    return destination.value;
  }

  private async readSource(destination: SafeProjectPath): Promise<Result<SourceDocument, ConfigError>> {
    try {
      if (!(await this.fileSystem.exists(destination))) return ok({ path: destination, text: "{}\n", format: "json" });
      return ok({ path: destination, text: new TextDecoder().decode(await this.fileSystem.read(destination)), format: "json" });
    } catch (cause: unknown) {
      return err(configError(cause instanceof Error ? cause.message : "Unable to read the agent hook file", destination));
    }
  }
}

export const createKiroHookAdapter = (
  fileSystem: FileSystemPort,
  codec?: StructuredConfigCodec<JsonObject>,
  targets?: import("./agent-targets.js").AgentTargetResolver,
): KiroHookAdapter => new KiroHookAdapter(fileSystem, codec, targets);
export const kiroHookAdapter = KiroHookAdapter;
