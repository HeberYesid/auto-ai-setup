import type { ComponentType } from "../planning/models.js";

/**
 * Agents that `auto-ai-setup` can configure locally. The union is closed on purpose: every entry
 * needs a documented, verified native configuration surface, so adding an agent is an explicit
 * decision and never an accident.
 */
export type AgentId = "kiro" | "claude-code" | "codex" | "opencode";

export const AGENT_IDS: readonly AgentId[] = ["kiro", "claude-code", "codex", "opencode"];

/**
 * Support state of one component type for one agent.
 * - `supported`: the agent has a documented, file-based project configuration this CLI can own.
 * - `deferred`: the surface exists but is out of scope for this phase, with the reason recorded.
 * - `external`: the surface is owned by another tool (Skills belong to the `npx autoskills` TUI).
 */
export type AgentCapabilityStatus = "supported" | "deferred" | "external";

export interface AgentCapability {
  readonly status: AgentCapabilityStatus;
  /** Project-relative destination written when `status` is `supported`. */
  readonly destination?: string;
  /** Why the capability is not owned yet, for `deferred` and `external`. */
  readonly note?: string;
}

export interface AgentDescriptor {
  readonly id: AgentId;
  readonly label: string;
  /** Official documentation used to derive the destinations below. */
  readonly docs: string;
  /**
   * Project paths whose presence means the agent is already in use here. Detection keeps a run from
   * writing configuration for agents the project does not have.
   */
  readonly footprints: readonly string[];
  readonly capabilities: Readonly<Record<ComponentType, AgentCapability>>;
}

const external: AgentCapability = {
  status: "external",
  note: "Las Skills se seleccionan e instalan en la TUI oficial `npx autoskills`; auto-ai-setup no las posee.",
};

export const AGENT_DESCRIPTORS: Readonly<Record<AgentId, AgentDescriptor>> = {
  kiro: {
    id: "kiro",
    label: "Kiro",
    docs: "https://kiro.dev/docs/",
    footprints: [".kiro"],
    capabilities: {
      skill: external,
      "mcp-server": { status: "supported", destination: ".kiro/settings/mcp.json" },
      "agent-rule": { status: "supported", destination: ".kiro/steering/auto-ai-setup.md" },
      "agent-command": { status: "supported", destination: ".kiro/prompts/<id>.md" },
      "agent-hook": { status: "supported", destination: ".kiro/hooks/<id>.json" },
    },
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    docs: "https://docs.claude.com/en/docs/claude-code/",
    footprints: [".claude", "CLAUDE.md", ".mcp.json"],
    capabilities: {
      skill: external,
      "mcp-server": { status: "supported", destination: ".mcp.json" },
      "agent-rule": { status: "supported", destination: "CLAUDE.md" },
      "agent-command": { status: "supported", destination: ".claude/commands/<id>.md" },
      "agent-hook": { status: "supported", destination: ".claude/settings.json" },
    },
  },
  codex: {
    id: "codex",
    label: "OpenAI Codex",
    docs: "https://developers.openai.com/codex/",
    footprints: [".codex", "AGENTS.md"],
    capabilities: {
      skill: external,
      "mcp-server": { status: "supported", destination: ".codex/config.toml" },
      "agent-rule": { status: "supported", destination: "AGENTS.md" },
      "agent-command": {
        status: "deferred",
        note: "Los custom prompts de Codex están marcados como deprecados y solo se leen desde `~/.codex/prompts`, fuera del proyecto; su reemplazo son Skills, que pertenecen a la TUI de autoskills.",
      },
      "agent-hook": { status: "supported", destination: ".codex/hooks.json" },
    },
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    docs: "https://opencode.ai/docs/",
    footprints: [".opencode", "opencode.json", "opencode.jsonc", "AGENTS.md"],
    capabilities: {
      skill: external,
      "mcp-server": { status: "supported", destination: "opencode.json" },
      "agent-rule": { status: "supported", destination: "AGENTS.md" },
      "agent-command": { status: "supported", destination: ".opencode/commands/<id>.md" },
      "agent-hook": {
        status: "deferred",
        note: "OpenCode solo expone hooks como plugins JavaScript/TypeScript ejecutables en `.opencode/plugins`; generar código ejecutable queda fuera del alcance de esta fase.",
      },
    },
  },
};

/**
 * Agents recognised by name but not configurable yet. They are recorded so the roadmap is explicit
 * instead of implied by the absence of an adapter.
 */
export interface DeferredAgent {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}

export const DEFERRED_AGENTS: readonly DeferredAgent[] = [
  { id: "cursor", label: "Cursor", reason: "Reglas en `.cursor/rules/*.mdc` y MCP en `.cursor/mcp.json`; pendiente de fase posterior." },
  {
    id: "github-copilot",
    label: "GitHub Copilot",
    reason: "Instrucciones en `.github/copilot-instructions.md` y MCP gestionado por el editor; pendiente de fase posterior.",
  },
  { id: "gemini-cli", label: "Gemini CLI", reason: "Configuración en `.gemini/settings.json` y `GEMINI.md`; pendiente de fase posterior." },
  { id: "windsurf", label: "Windsurf", reason: "Reglas en `.windsurf/rules` y MCP propio; pendiente de fase posterior." },
  { id: "amp", label: "Amp", reason: "Configuración de MCP y hooks todavía no estabilizada; pendiente de fase posterior." },
];

export const agentDescriptor = (agent: AgentId): AgentDescriptor => AGENT_DESCRIPTORS[agent];
export const agentLabel = (agent: AgentId): string => AGENT_DESCRIPTORS[agent].label;
export const agentCapability = (agent: AgentId, type: ComponentType): AgentCapability => AGENT_DESCRIPTORS[agent].capabilities[type];
export const agentSupports = (agent: AgentId, type: ComponentType): boolean => agentCapability(agent, type).status === "supported";
export const agentsSupporting = (type: ComponentType): readonly AgentId[] => AGENT_IDS.filter((agent) => agentSupports(agent, type));
export const agentFootprints = (agent: AgentId): readonly string[] => AGENT_DESCRIPTORS[agent].footprints;
