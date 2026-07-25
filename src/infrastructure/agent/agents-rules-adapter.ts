import type {
  AgentId,
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
  SourceDocument,
} from "../../domain/index.js";
import { asSafeProjectPath, err, ok } from "../../domain/index.js";
import type { AgentTargetResolver } from "./agent-targets.js";

export const AGENTS_RULES_PATH = "AGENTS.md";
export const AGENT_RULES_PATH = AGENTS_RULES_PATH;
export const CLAUDE_RULES_PATH = "CLAUDE.md";
export const KIRO_STEERING_PATH = ".kiro/steering/auto-ai-setup.md";

export interface AgentRuleDefinition {
  readonly id: string;
  readonly content: string;
}

export interface AgentRuleComponentDefinition extends ComponentDefinition {
  readonly type: "agent-rule";
  readonly rule: AgentRuleDefinition;
}

export type RuleConflict = "none" | "content-differs" | "invalid-managed-markers";

export interface AgentsRuleAdaptation {
  readonly text: string;
  readonly eol: "\n" | "\r\n";
  readonly blockIds: readonly string[];
  readonly changed: boolean;
  readonly action: "create" | "modify" | "preserve";
  readonly conflict: RuleConflict;
  readonly corruptMarkers: readonly string[];
}

interface RuleBlock {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

const markerPrefix = "<!-- auto-ai-setup:rule:";
const markerPattern = /^<!-- auto-ai-setup:rule:([a-zA-Z0-9][a-zA-Z0-9._-]*):(begin|end) -->$/;
const markerLikePattern = /<!--[^>]*auto-ai-setup:rule:[^>]*-->/g;
const isValidId = (id: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
const eolOf = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n");

export const ruleBeginMarker = (id: string): string => `${markerPrefix}${id}:begin -->`;
export const ruleEndMarker = (id: string): string => `${markerPrefix}${id}:end -->`;
export const normalizeRuleContent = (content: string): string => content.replace(/\r\n|\r/g, "\n").replace(/[ \t]+$/gm, "");

const configError = (message: string, path = AGENTS_RULES_PATH): ConfigError => ({
  code: "CONFIG_SCHEMA",
  message,
  path,
  location: "1:1",
  line: 1,
  column: 1,
  recoverability: "none",
});

const redactedText = (content: string): RedactedPreview => ({ kind: "text", content, truncated: false });

const parseBlocks = (text: string): { readonly blocks: readonly RuleBlock[]; readonly corruptMarkers: readonly string[] } => {
  const lines = text.split(/\r\n|\n|\r/);
  const blocks: RuleBlock[] = [];
  const corrupt = new Set<string>();
  const open: { id: string; start: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const marker = markerPattern.exec(trimmed);
    const markerLike = markerLikePattern.exec(line);
    markerLikePattern.lastIndex = 0;
    if (marker === null) {
      if (line.includes(markerPrefix) || markerLike !== null) corrupt.add(line);
      continue;
    }
    const id = marker[1] ?? "";
    const kind = marker[2];
    if (!isValidId(id)) {
      corrupt.add(line);
      continue;
    }
    if (kind === "begin") {
      if (open.length > 0 || blocks.some((block) => block.id === id)) corrupt.add(line);
      open.push({ id, start: index });
      continue;
    }
    const current = open.pop();
    if (current === undefined || current.id !== id) {
      corrupt.add(line);
      continue;
    }
    if (blocks.some((block) => block.id === id)) corrupt.add(line);
    blocks.push({ id, start: current.start, end: index, content: lines.slice(current.start + 1, index).join("\n") });
  }
  for (const unmatched of open) corrupt.add(ruleBeginMarker(unmatched.id));
  return { blocks, corruptMarkers: [...corrupt] };
};

const renderBlock = (definition: AgentRuleDefinition, eol: "\n" | "\r\n"): string[] => {
  const content = definition.content.replace(/\r\n|\r|\n/g, eol);
  return [ruleBeginMarker(definition.id), ...content.split(eol), ruleEndMarker(definition.id)];
};

const appendBlock = (text: string, block: readonly string[], eol: "\n" | "\r\n"): string => {
  if (text.length === 0) return block.join(eol) + eol;
  return text.endsWith("\n") || text.endsWith("\r") ? `${text}${block.join(eol)}${eol}` : `${text}${eol}${block.join(eol)}${eol}`;
};

export const adaptAgentsDocument = (source: SourceDocument, definition: AgentRuleDefinition): Result<AgentsRuleAdaptation, ConfigError> => {
  if (!isValidId(definition.id)) return err(configError("Agent rule id contains unsafe characters"));
  const eol = eolOf(source.text);
  const parsed = parseBlocks(source.text);
  const matching = parsed.blocks.filter((block) => block.id === definition.id);
  const normalizedDesired = normalizeRuleContent(definition.content);
  let text = source.text;
  let changed = false;
  let action: AgentsRuleAdaptation["action"] = "preserve";
  let conflict: RuleConflict = parsed.corruptMarkers.length > 0 ? "invalid-managed-markers" : "none";
  if (matching.length === 1 && parsed.corruptMarkers.length === 0) {
    const block = matching[0];
    if (block !== undefined && normalizeRuleContent(block.content) !== normalizedDesired) {
      const lines = source.text.split(/\r\n|\n|\r/);
      lines.splice(block.start, block.end - block.start + 1, ...renderBlock(definition, eol));
      text = lines.join(eol);
      changed = true;
      action = "modify";
      conflict = "content-differs";
    }
  } else if (matching.length === 0) {
    text = appendBlock(source.text, renderBlock(definition, eol), eol);
    changed = true;
    action = source.text.length === 0 ? "create" : "modify";
  } else if (matching.length > 1) {
    conflict = "invalid-managed-markers";
  }
  return ok({
    text,
    eol,
    blockIds: parsed.blocks.map((block) => block.id),
    changed,
    action,
    conflict,
    corruptMarkers: parsed.corruptMarkers,
  });
};

/**
 * Where the managed rule blocks are written and which agents justify writing them. The same
 * marker-based document works for every markdown rules surface, so the destination is configuration
 * instead of a new adapter: `AGENTS.md` for the agents that read it natively, `CLAUDE.md` for Claude
 * Code, and a steering file for Kiro.
 */
export interface AgentRulesAdapterOptions {
  readonly destination?: string;
  /** Agents that read this destination. The adapter proposes nothing when none of them is targeted. */
  readonly agents?: readonly AgentId[];
  readonly targets?: AgentTargetResolver;
}

export class AgentsRuleAdapter implements ComponentAdapter<AgentRuleComponentDefinition> {
  private readonly destination: SafeProjectPath;
  private readonly destinationPath: string;
  private readonly agents: readonly AgentId[];
  private readonly targets: AgentTargetResolver | undefined;

  public constructor(
    private readonly fileSystem: FileSystemPort,
    options: AgentRulesAdapterOptions = {},
  ) {
    this.destinationPath = options.destination ?? AGENTS_RULES_PATH;
    const destination = asSafeProjectPath(this.destinationPath);
    if (!destination.ok) throw new Error(destination.error.message);
    this.destination = destination.value;
    this.agents = options.agents ?? [];
    this.targets = options.targets;
  }

  public supports(component: AgentRuleComponentDefinition): boolean {
    return component.type === "agent-rule" && component.rule !== undefined;
  }

  /** Without a resolver the adapter is unconditional, which keeps a single-destination setup simple. */
  private async applies(): Promise<boolean> {
    if (this.targets === undefined) return true;
    for (const agent of this.agents) if (await this.targets.handles(agent, "agent-rule")) return true;
    return false;
  }

  public async inspect(_ctx: InspectionContext, component: AgentRuleComponentDefinition): Promise<CurrentComponentState> {
    if (!(await this.applies())) return { present: false, destinations: [] };
    const source = await this.readSource();
    if (!source.ok) return { present: false, destinations: [this.destination] };
    const adapted = adaptAgentsDocument(source.value, component.rule);
    return { present: adapted.ok && !adapted.value.changed && adapted.value.conflict === "none", destinations: [this.destination] };
  }

  public async propose(ctx: PlanningContext, component: AgentRuleComponentDefinition): Promise<readonly ProposedOperation[]> {
    return this.proposeAll(ctx, [component]);
  }

  /**
   * Every managed rule lives in the same AGENTS.md, so the selected rules are folded into a single
   * operation: a change plan admits at most one action per destination.
   */
  public async proposeAll(
    _ctx: PlanningContext,
    components: readonly AgentRuleComponentDefinition[],
  ): Promise<readonly ProposedOperation[]> {
    if (!(await this.applies())) return [];
    const selected = [...components].sort((left, right) => left.id.localeCompare(right.id));
    const primary = selected[0];
    if (primary === undefined) return [];
    const source = await this.readSource();
    if (!source.ok) return [];
    const original = source.value.text;
    let text = original;
    let changed = false;
    let conflict: RuleConflict = "none";
    for (const component of selected) {
      const adapted = adaptAgentsDocument({ ...source.value, text }, component.rule);
      if (!adapted.ok) return [];
      text = adapted.value.text;
      changed = changed || adapted.value.changed;
      if (conflict === "none") conflict = adapted.value.conflict;
    }
    const action = changed ? (original.length === 0 ? "create" : "modify") : "preserve";
    const ruleIds = selected.map((component) => component.rule.id).join(", ");
    return [
      {
        id: `rule:${this.destinationPath}:${selected.map((component) => component.id).join("+")}`,
        componentId: primary.id,
        componentIds: selected.map((component) => component.id),
        destination: this.destination,
        action,
        reason:
          selected.length === 1
            ? `Add or update the managed agent rule ${ruleIds} in ${this.destinationPath}.`
            : `Add or update the managed agent rules ${ruleIds} in ${this.destinationPath}.`,
        conflict,
        preview: redactedText(text),
        ...(action === "preserve" ? {} : { content: text }),
      },
    ];
  }

  public async verify(_ctx: VerificationContext, operation: ProposedOperation): Promise<Result<void>> {
    return operation.destination === this.destination
      ? ok(undefined)
      : err({
          code: "INVALID_PLAN",
          message: "Agent rule operation has an unexpected destination",
          recoverability: "none",
          path: operation.destination,
        });
  }

  private async readSource(): Promise<Result<SourceDocument, ConfigError>> {
    try {
      if (!(await this.fileSystem.exists(this.destination))) return ok({ path: this.destination, text: "", format: "json" });
      return ok({ path: this.destination, text: new TextDecoder().decode(await this.fileSystem.read(this.destination)), format: "json" });
    } catch (cause: unknown) {
      return err(configError(cause instanceof Error ? cause.message : `Unable to read ${this.destinationPath}`, this.destinationPath));
    }
  }
}

export const createAgentsRuleAdapter = (fileSystem: FileSystemPort, options?: AgentRulesAdapterOptions): AgentsRuleAdapter =>
  new AgentsRuleAdapter(fileSystem, options);

/** `AGENTS.md`: the portable contract read natively by Codex and OpenCode. */
export const createSharedAgentsRuleAdapter = (fileSystem: FileSystemPort, targets: AgentTargetResolver): AgentsRuleAdapter =>
  new AgentsRuleAdapter(fileSystem, { destination: AGENTS_RULES_PATH, agents: ["codex", "opencode"], targets });

/** `CLAUDE.md`: Claude Code loads this file, not `AGENTS.md`. */
export const createClaudeRulesAdapter = (fileSystem: FileSystemPort, targets: AgentTargetResolver): AgentsRuleAdapter =>
  new AgentsRuleAdapter(fileSystem, { destination: CLAUDE_RULES_PATH, agents: ["claude-code"], targets });

/** Kiro reads project rules from steering files rather than from `AGENTS.md`. */
export const createKiroSteeringAdapter = (fileSystem: FileSystemPort, targets: AgentTargetResolver): AgentsRuleAdapter =>
  new AgentsRuleAdapter(fileSystem, { destination: KIRO_STEERING_PATH, agents: ["kiro"], targets });

export const AgentRulesAdapter = AgentsRuleAdapter;
export const agentRuleAdapter = AgentsRuleAdapter;
