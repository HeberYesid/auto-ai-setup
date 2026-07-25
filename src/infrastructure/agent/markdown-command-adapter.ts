import type {
  AgentId,
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
import { agentLabel, asSafeProjectPath, err, ok } from "../../domain/index.js";
import type { AgentTargetResolver } from "./agent-targets.js";
import type { KiroCommandComponentDefinition, KiroCommandDefinition } from "./kiro-command-adapter.js";

export const CLAUDE_COMMANDS_PATH = ".claude/commands";
export const OPENCODE_COMMANDS_PATH = ".opencode/commands";

/**
 * Claude Code and OpenCode both discover slash commands as one markdown file per command, named after
 * the file and configured through YAML frontmatter. The directory is the only difference, so a single
 * adapter serves both with a directory profile.
 */
export interface MarkdownCommandProfile {
  readonly agent: AgentId;
  readonly directory: string;
}

export const claudeCodeCommandProfile: MarkdownCommandProfile = { agent: "claude-code", directory: CLAUDE_COMMANDS_PATH };
export const openCodeCommandProfile: MarkdownCommandProfile = { agent: "opencode", directory: OPENCODE_COMMANDS_PATH };

const isValidId = (id: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
const configError = (message: string, path: string): ConfigError => ({
  code: "CONFIG_SCHEMA",
  message,
  path,
  location: "1:1",
  line: 1,
  column: 1,
  recoverability: "none",
});
const redactedText = (content: string): RedactedPreview => ({ kind: "text", content, truncated: false });

/** A frontmatter scalar is emitted as a double-quoted YAML string so punctuation is never ambiguous. */
const yamlString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export const renderMarkdownCommand = (definition: KiroCommandDefinition): Result<string, ConfigError> => {
  const prompt = definition.prompt ?? definition.content;
  if (prompt === undefined) return err(configError("An agent command must provide prompt content", "/commands"));
  const description = definition.description ?? definition.name ?? definition.id;
  const body = prompt.replace(/\r\n|\r/g, "\n").replace(/\n+$/u, "");
  return ok(["---", `description: ${yamlString(description)}`, "---", "", body, ""].join("\n"));
};

/** Writes one markdown slash command per component for a single agent. */
export class MarkdownCommandAdapter implements ComponentAdapter<KiroCommandComponentDefinition> {
  public constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly profile: MarkdownCommandProfile,
    private readonly targets: AgentTargetResolver,
  ) {}

  public supports(component: KiroCommandComponentDefinition): boolean {
    return component.type === "agent-command" && component.command !== undefined && isValidId(component.command.id);
  }

  public async inspect(_ctx: InspectionContext, component: KiroCommandComponentDefinition): Promise<CurrentComponentState> {
    if (!(await this.targets.handles(this.profile.agent, "agent-command"))) return { present: false, destinations: [] };
    const destination = this.destinationFor(component.command.id);
    const rendered = renderMarkdownCommand(component.command);
    if (!rendered.ok) return { present: false, destinations: [destination] };
    const source = await this.readSource(destination);
    return { present: source.ok && source.value.text === rendered.value, destinations: [destination] };
  }

  public async propose(ctx: PlanningContext, component: KiroCommandComponentDefinition): Promise<readonly ProposedOperation[]> {
    return this.proposeAll(ctx, [component]);
  }

  /** Each command owns its own file, so one operation per component is emitted. */
  public async proposeAll(
    _ctx: PlanningContext,
    components: readonly KiroCommandComponentDefinition[],
  ): Promise<readonly ProposedOperation[]> {
    if (!(await this.targets.handles(this.profile.agent, "agent-command"))) return [];
    const selected = [...components].filter((component) => this.supports(component)).sort((left, right) => left.id.localeCompare(right.id));
    const operations: ProposedOperation[] = [];
    for (const component of selected) {
      const destination = this.destinationFor(component.command.id);
      const rendered = renderMarkdownCommand(component.command);
      if (!rendered.ok) return [];
      const source = await this.readSource(destination);
      if (!source.ok) return [];
      const existed = source.value.text.length > 0;
      const changed = source.value.text !== rendered.value;
      const action = changed ? (existed ? "modify" : "create") : "preserve";
      operations.push({
        id: `command:${this.profile.agent}:${component.id}`,
        componentId: component.id,
        destination,
        action,
        reason: `Register the /${component.command.id} command for ${agentLabel(this.profile.agent)} in ${destination}.`,
        conflict: existed && changed ? "content-differs" : "none",
        preview: redactedText(rendered.value),
        ...(action === "preserve" ? {} : { content: rendered.value }),
      });
    }
    return operations;
  }

  public async verify(_ctx: VerificationContext, operation: ProposedOperation): Promise<Result<void>> {
    return operation.destination.startsWith(`${this.profile.directory}/`)
      ? ok(undefined)
      : err({
          code: "INVALID_PLAN",
          message: `Agent command operation for ${this.profile.agent} has an unexpected destination`,
          recoverability: "none",
          path: operation.destination,
        });
  }

  private destinationFor(id: string): SafeProjectPath {
    const destination = asSafeProjectPath(`${this.profile.directory}/${id}.md`);
    if (!destination.ok) throw new Error(destination.error.message);
    return destination.value;
  }

  private async readSource(destination: SafeProjectPath): Promise<Result<SourceDocument, ConfigError>> {
    try {
      const exists = await this.fileSystem.exists(destination);
      const text = exists ? new TextDecoder().decode(await this.fileSystem.read(destination)) : "";
      return ok({ path: destination, text, format: "json" });
    } catch (cause: unknown) {
      return err(configError(cause instanceof Error ? cause.message : "Unable to read the command file", destination));
    }
  }
}

export const createClaudeCodeCommandAdapter = (fileSystem: FileSystemPort, targets: AgentTargetResolver): MarkdownCommandAdapter =>
  new MarkdownCommandAdapter(fileSystem, claudeCodeCommandProfile, targets);
export const createOpenCodeCommandAdapter = (fileSystem: FileSystemPort, targets: AgentTargetResolver): MarkdownCommandAdapter =>
  new MarkdownCommandAdapter(fileSystem, openCodeCommandProfile, targets);
