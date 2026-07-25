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
import type { AgentHookAction, AgentHookComponentDefinition, AgentHookDefinition, AgentHookTrigger } from "./kiro-hook-adapter.js";
import { validateAgentHook } from "./kiro-hook-adapter.js";

export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
export const CODEX_HOOKS_PATH = ".codex/hooks.json";

/**
 * Claude Code and Codex share the same three-level hook schema — event, matcher group, handlers — but
 * they disagree on the event names and on which handler types actually run. The profile records those
 * two differences so a hook whose trigger or action the agent cannot honour is skipped instead of
 * being written in a shape the agent would silently ignore.
 */
export interface HooksJsonProfile {
  readonly agent: AgentId;
  readonly destination: string;
  /** Maps the neutral trigger onto the agent's event name; `undefined` means unsupported. */
  readonly event: (trigger: AgentHookTrigger) => string | undefined;
  /** Handler kinds the agent executes today. */
  readonly supportsAction: (action: AgentHookAction) => boolean;
}

export const claudeCodeHooksProfile: HooksJsonProfile = {
  agent: "claude-code",
  destination: CLAUDE_SETTINGS_PATH,
  event: (trigger) =>
    ({
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      SessionStart: "SessionStart",
      Stop: "Stop",
      UserPromptSubmit: "UserPromptSubmit",
      PreTaskExec: "TaskCreated",
      PostTaskExec: "TaskCompleted",
      // Claude Code has no filesystem-level event: it only observes tool calls, and its tool matcher
      // filters tool names rather than file paths, so a path-matched hook cannot be reproduced.
      PostFileCreate: undefined,
      PostFileSave: undefined,
      PostFileDelete: undefined,
    })[trigger],
  supportsAction: () => true,
};

export const codexHooksProfile: HooksJsonProfile = {
  agent: "codex",
  destination: CODEX_HOOKS_PATH,
  event: (trigger) =>
    ({
      PreToolUse: "PreToolUse",
      PostToolUse: "PostToolUse",
      SessionStart: "SessionStart",
      Stop: "Stop",
      UserPromptSubmit: "UserPromptSubmit",
      PreTaskExec: undefined,
      PostTaskExec: undefined,
      PostFileCreate: undefined,
      PostFileSave: undefined,
      PostFileDelete: undefined,
    })[trigger],
  // Codex parses `prompt` and `agent` handlers but skips them, so only command handlers are written.
  supportsAction: (action) => action.type === "command",
};

const isRecord = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const configError = (message: string, path: string): ConfigError => ({
  code: "CONFIG_SCHEMA",
  message,
  path,
  location: "1:1",
  line: 1,
  column: 1,
  recoverability: "none",
});

/** Ownership marker carried in `statusMessage`, the only free-text field both agents accept. */
export const hookOwnershipMarker = (id: string): string => `auto-ai-setup:${id}`;

const handlerModel = (definition: AgentHookDefinition): JsonObject =>
  definition.action.type === "command"
    ? ({
        type: "command",
        command: definition.action.command,
        ...(definition.action.timeout === undefined ? {} : { timeout: definition.action.timeout }),
        statusMessage: hookOwnershipMarker(definition.id),
      } as JsonObject)
    : ({ type: "prompt", prompt: definition.action.prompt, statusMessage: hookOwnershipMarker(definition.id) } as JsonObject);

export const hookGroupModel = (definition: AgentHookDefinition): JsonObject =>
  ({
    ...(definition.matcher === undefined ? {} : { matcher: definition.matcher }),
    hooks: [handlerModel(definition)],
  }) as JsonObject;

const ownsGroup = (group: JsonValue, id: string): boolean => {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((handler) => isRecord(handler) && handler.statusMessage === hookOwnershipMarker(id));
};

export interface HooksJsonAdaptation {
  readonly model: JsonObject;
  readonly text: string;
  readonly changed: boolean;
  readonly conflict: "none" | "content-differs";
  readonly hookIds: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Adds or refreshes the managed matcher groups. Groups the user wrote, and every unrelated setting in
 * the document, are preserved: only groups carrying this CLI's ownership marker are rewritten.
 */
export const adaptHooksJsonDocument = (
  source: SourceDocument,
  definitions: readonly AgentHookDefinition[],
  profile: HooksJsonProfile,
  codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
): Result<HooksJsonAdaptation, ConfigError> => {
  const parsed = codec.parse(source);
  if (!parsed.ok) return parsed;
  const root = parsed.value.model;
  const existingHooks = root.hooks;
  if (existingHooks !== undefined && !isRecord(existingHooks)) return err(configError("hooks must be an object", "/hooks"));
  const hooks: Record<string, JsonValue> = { ...(existingHooks ?? {}) };
  const written: string[] = [];
  const skipped: string[] = [];
  let conflict: HooksJsonAdaptation["conflict"] = "none";

  for (const definition of [...definitions].sort((left, right) => left.id.localeCompare(right.id))) {
    const validated = validateAgentHook(definition);
    if (!validated.ok) return validated;
    const event = profile.event(definition.trigger);
    if (event === undefined || !profile.supportsAction(definition.action)) {
      skipped.push(definition.id);
      continue;
    }
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) return err(configError(`hooks.${event} must be an array`, `/hooks/${event}`));
    const groups = current === undefined ? [] : [...current];
    const desired = hookGroupModel(definition);
    const index = groups.findIndex((group) => ownsGroup(group, definition.id));
    if (index === -1) groups.push(desired);
    else {
      if (!codec.equivalent(groups[index] as JsonObject, desired)) conflict = "content-differs";
      groups[index] = desired;
    }
    hooks[event] = groups;
    written.push(definition.id);
  }

  const merged: JsonObject = written.length === 0 ? root : { ...root, hooks: hooks as JsonObject };
  const validatedModel = codec.validate(merged);
  if (!validatedModel.ok) return validatedModel;
  const changed = !codec.equivalent(root, validatedModel.value);
  const serialized = changed ? codec.serialize(validatedModel.value, parsed.value.style) : ok(source.text);
  if (!serialized.ok) return serialized;
  return ok({ model: validatedModel.value, text: serialized.value, changed, conflict, hookIds: written, skipped });
};

/**
 * Writes the hook configuration of one agent. auto-ai-setup never runs a hook or its command; the
 * agent runtime does, after its own trust review.
 */
export class HooksJsonAdapter implements ComponentAdapter<AgentHookComponentDefinition> {
  private readonly destination: SafeProjectPath;
  private readonly codec: StructuredConfigCodec<JsonObject>;

  public constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly profile: HooksJsonProfile,
    private readonly targets: AgentTargetResolver,
    codec: StructuredConfigCodec<JsonObject> = new JsonStructuredConfigCodec<JsonObject>(),
  ) {
    const destination = asSafeProjectPath(profile.destination);
    if (!destination.ok) throw new Error(destination.error.message);
    this.destination = destination.value;
    this.codec = codec;
  }

  public supports(component: AgentHookComponentDefinition): boolean {
    return component.type === "agent-hook" && component.hook !== undefined && validateAgentHook(component.hook).ok;
  }

  private async applies(component: AgentHookComponentDefinition): Promise<boolean> {
    if (!(await this.targets.handles(this.profile.agent, "agent-hook"))) return false;
    return this.profile.event(component.hook.trigger) !== undefined && this.profile.supportsAction(component.hook.action);
  }

  public async inspect(_ctx: InspectionContext, component: AgentHookComponentDefinition): Promise<CurrentComponentState> {
    if (!(await this.applies(component))) return { present: false, destinations: [] };
    const source = await this.readSource();
    if (!source.ok) return { present: false, destinations: [this.destination] };
    const adapted = adaptHooksJsonDocument(source.value, [component.hook], this.profile, this.codec);
    return { present: adapted.ok && !adapted.value.changed, destinations: [this.destination] };
  }

  public async propose(ctx: PlanningContext, component: AgentHookComponentDefinition): Promise<readonly ProposedOperation[]> {
    return this.proposeAll(ctx, [component]);
  }

  /** Every hook of one agent lives in a single document, so they collapse into one action. */
  public async proposeAll(
    _ctx: PlanningContext,
    components: readonly AgentHookComponentDefinition[],
  ): Promise<readonly ProposedOperation[]> {
    if (!(await this.targets.handles(this.profile.agent, "agent-hook"))) return [];
    const selected: AgentHookComponentDefinition[] = [];
    for (const component of components) if (this.supports(component) && (await this.applies(component))) selected.push(component);
    selected.sort((left, right) => left.id.localeCompare(right.id));
    const primary = selected[0];
    if (primary === undefined) return [];
    const source = await this.readSource();
    if (!source.ok) return [];
    const parsed = this.codec.parse(source.value);
    if (!parsed.ok) return [];
    const adapted = adaptHooksJsonDocument(
      source.value,
      selected.map((component) => component.hook),
      this.profile,
      this.codec,
    );
    if (!adapted.ok) return [];
    const existed = source.value.text.trim().length > 0 && source.value.text.trim() !== "{}";
    const action = adapted.value.changed ? (existed ? "modify" : "create") : "preserve";
    const hookIds = selected.map((component) => component.hook.id).join(", ");
    return [
      {
        id: `hook:${this.profile.agent}:${selected.map((component) => component.id).join("+")}`,
        componentId: primary.id,
        componentIds: selected.map((component) => component.id),
        destination: this.destination,
        action,
        reason: `Register the managed ${selected.length === 1 ? "hook" : "hooks"} ${hookIds} for ${agentLabel(this.profile.agent)} in ${this.profile.destination}; auto-ai-setup writes the configuration and never runs it.`,
        conflict: adapted.value.conflict,
        preview: diffFields(parsed.value.model, adapted.value.model),
        ...(action === "preserve" ? {} : { content: adapted.value.text }),
      },
    ];
  }

  public async verify(_ctx: VerificationContext, operation: ProposedOperation): Promise<Result<void>> {
    return operation.destination === this.destination
      ? ok(undefined)
      : err({
          code: "INVALID_PLAN",
          message: `Agent hook operation for ${this.profile.agent} has an unexpected destination`,
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
      return err(configError(cause instanceof Error ? cause.message : "Unable to read the hook configuration", this.profile.destination));
    }
  }
}

export const createClaudeCodeHookAdapter = (
  fileSystem: FileSystemPort,
  targets: AgentTargetResolver,
  codec?: StructuredConfigCodec<JsonObject>,
): HooksJsonAdapter => new HooksJsonAdapter(fileSystem, claudeCodeHooksProfile, targets, codec);

export const createCodexHookAdapter = (
  fileSystem: FileSystemPort,
  targets: AgentTargetResolver,
  codec?: StructuredConfigCodec<JsonObject>,
): HooksJsonAdapter => new HooksJsonAdapter(fileSystem, codexHooksProfile, targets, codec);
