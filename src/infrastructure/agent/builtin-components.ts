import type { ComponentDefinition, ComponentId } from "../../domain/index.js";
import type { AgentRuleComponentDefinition } from "./agents-rules-adapter.js";
import type { KiroCommandComponentDefinition } from "./kiro-command-adapter.js";
import type { KiroMcpComponentDefinition } from "./kiro-mcp-adapter.js";

const builtinSource = { kind: "builtin" as const, origin: "auto-ai-setup" };
const always = { op: "always" as const };

/**
 * Components owned by auto-ai-setup rather than discovered from autoskills.
 * They only produce local configuration; no MCP process or recommended CLI is executed.
 */
export const builtinAgentComponents: readonly ComponentDefinition[] = [
  {
    id: "mcp.workspace-filesystem" as ComponentId,
    type: "mcp-server",
    name: "Workspace Filesystem MCP",
    description: "Configura un servidor MCP de filesystem para el workspace actual; Kiro lo iniciará solo cuando el usuario lo use.",
    compatibility: always,
    source: builtinSource,
    priority: 30,
    mcp: {
      id: "workspace-filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    },
  } as KiroMcpComponentDefinition,
  {
    id: "rule.project-safety" as ComponentId,
    type: "agent-rule",
    name: "Project Safety Rules",
    description: "Añade reglas gestionadas para conservar cambios del usuario y evitar ejecutar herramientas no aprobadas.",
    compatibility: always,
    source: builtinSource,
    priority: 20,
    rule: {
      id: "project-safety",
      content:
        "Preserva el contenido existente del proyecto. No ejecutes servidores MCP ni CLIs recomendadas sin una aprobación explícita del usuario.",
    },
  } as AgentRuleComponentDefinition,
  {
    id: "command.review-project" as ComponentId,
    type: "agent-command",
    name: "Review Project",
    description: "Registra un comando reutilizable para revisar el estado y los cambios del proyecto.",
    compatibility: always,
    source: builtinSource,
    priority: 10,
    command: {
      id: "review-project",
      name: "Review Project",
      description: "Review the project structure and current changes.",
      prompt: "Review this project, summarize its structure, and identify uncommitted changes without modifying files.",
    },
  } as KiroCommandComponentDefinition,
];

export const createBuiltinAgentComponents = (): readonly ComponentDefinition[] => [...builtinAgentComponents];
