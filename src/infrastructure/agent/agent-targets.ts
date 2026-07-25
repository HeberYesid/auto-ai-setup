import type { AgentId, ComponentType, FileSystemPort } from "../../domain/index.js";
import { AGENT_IDS, agentFootprints, agentSupports, asSafeProjectPath } from "../../domain/index.js";

/**
 * Decides which agents a run configures.
 *
 * An agent is targeted when the project already carries one of its documented footprints, so a run
 * never invents configuration for an agent the team does not use. When the project carries no
 * footprint at all — the new-project case — every supported agent is targeted, because there is no
 * evidence to narrow the set and the change plan still lists every destination for approval.
 *
 * The resolution is computed once per projection and memoized: adapters ask for it repeatedly and
 * the answer must be identical for every adapter in the same run, otherwise the plan would not be
 * deterministic.
 */
export interface AgentTargetResolver {
  targets(): Promise<ReadonlySet<AgentId>>;
  isTargeted(agent: AgentId): Promise<boolean>;
  /** True when the agent is targeted and owns that component type natively. */
  handles(agent: AgentId, type: ComponentType): Promise<boolean>;
}

export class DetectedAgentTargetResolver implements AgentTargetResolver {
  private resolved: Promise<ReadonlySet<AgentId>> | undefined;

  public constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly fallback: readonly AgentId[] = AGENT_IDS,
  ) {}

  public targets(): Promise<ReadonlySet<AgentId>> {
    this.resolved ??= this.detect();
    return this.resolved;
  }

  public async isTargeted(agent: AgentId): Promise<boolean> {
    return (await this.targets()).has(agent);
  }

  public async handles(agent: AgentId, type: ComponentType): Promise<boolean> {
    return agentSupports(agent, type) && (await this.isTargeted(agent));
  }

  private async detect(): Promise<ReadonlySet<AgentId>> {
    const detected = new Set<AgentId>();
    for (const agent of AGENT_IDS) {
      for (const footprint of agentFootprints(agent)) {
        const path = asSafeProjectPath(footprint);
        if (!path.ok) continue;
        let present = false;
        try {
          present = await this.fileSystem.exists(path.value);
        } catch {
          present = false;
        }
        if (present) {
          detected.add(agent);
          break;
        }
      }
    }
    if (detected.size > 0) return detected;
    return new Set(this.fallback);
  }
}

/** Resolver used by tests and by callers that already know the target set. */
export class FixedAgentTargetResolver implements AgentTargetResolver {
  private readonly selected: ReadonlySet<AgentId>;

  public constructor(agents: readonly AgentId[]) {
    this.selected = new Set(agents);
  }

  public async targets(): Promise<ReadonlySet<AgentId>> {
    return this.selected;
  }

  public async isTargeted(agent: AgentId): Promise<boolean> {
    return this.selected.has(agent);
  }

  public async handles(agent: AgentId, type: ComponentType): Promise<boolean> {
    return agentSupports(agent, type) && this.selected.has(agent);
  }
}

export const createAgentTargetResolver = (fileSystem: FileSystemPort, fallback?: readonly AgentId[]): AgentTargetResolver =>
  new DetectedAgentTargetResolver(fileSystem, fallback);
export const createFixedAgentTargetResolver = (agents: readonly AgentId[]): AgentTargetResolver => new FixedAgentTargetResolver(agents);
