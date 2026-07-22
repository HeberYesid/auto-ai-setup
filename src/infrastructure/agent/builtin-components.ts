import type { ComponentDefinition, ComponentId } from "../../domain/index.js";
import type { AgentRuleComponentDefinition } from "./agents-rules-adapter.js";
import type { KiroCommandComponentDefinition } from "./kiro-command-adapter.js";
import type { KiroMcpComponentDefinition, McpServerDefinition } from "./kiro-mcp-adapter.js";

const builtinSource = { kind: "builtin" as const, origin: "auto-ai-setup" };
const always = { op: "always" as const };
const stack = (category: "framework" | "tool", ...ids: string[]) => ({ op: "stack" as const, category, oneOf: ids });
const anyOf = (...clauses: ReturnType<typeof stack>[]) => ({ op: "any" as const, clauses });

const mcpComponent = (
  id: string,
  name: string,
  description: string,
  compatibility: ComponentDefinition["compatibility"],
  priority: number,
  mcp: McpServerDefinition,
): KiroMcpComponentDefinition => ({
  id: id as ComponentId,
  type: "mcp-server",
  name,
  description,
  compatibility,
  source: builtinSource,
  priority,
  mcp,
});

/**
 * Components owned by auto-ai-setup rather than discovered from autoskills.
 * They only produce local configuration; no MCP process or recommended CLI is executed.
 */
export const builtinAgentComponents: readonly ComponentDefinition[] = [
  mcpComponent(
    "mcp.workspace-filesystem",
    "Workspace Filesystem MCP",
    "Configura un servidor MCP de filesystem para el workspace actual; Kiro lo iniciará solo cuando el usuario lo use.",
    always,
    50,
    {
      id: "workspace-filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    },
  ),
  mcpComponent(
    "mcp.context7",
    "Context7 MCP",
    "Servidor remoto oficial para consultar documentación versionada y ejemplos de las librerías del proyecto.",
    always,
    40,
    {
      id: "context7",
      configuration: { url: "https://mcp.context7.com/mcp" },
    },
  ),
  mcpComponent(
    "mcp.github",
    "GitHub MCP",
    "Servidor remoto oficial de GitHub para consultar repositorios, issues, pull requests y workflows.",
    stack("tool", "tool.github-actions"),
    35,
    {
      id: "github",
      configuration: { url: "https://api.githubcopilot.com/mcp/" },
    },
  ),
  mcpComponent(
    "mcp.sentry",
    "Sentry MCP",
    "Servidor remoto oficial de Sentry para analizar errores y rendimiento mediante OAuth.",
    stack("tool", "tool.sentry"),
    34,
    {
      id: "sentry",
      configuration: { url: "https://mcp.sentry.dev/mcp" },
    },
  ),
  mcpComponent(
    "mcp.cloudflare",
    "Cloudflare MCP",
    "Servidor remoto oficial de Cloudflare para consultar recursos y configuraciones de Workers, Pages y otros servicios.",
    stack("tool", "tool.cloudflare"),
    33,
    {
      id: "cloudflare",
      configuration: { url: "https://mcp.cloudflare.com/mcp" },
    },
  ),
  mcpComponent(
    "mcp.playwright",
    "Playwright MCP",
    "Servidor oficial de Microsoft para automatización y pruebas de navegador con Playwright.",
    stack("tool", "tool.playwright"),
    32,
    {
      id: "playwright",
      command: "npx",
      args: ["--yes", "@playwright/mcp@0.0.78"],
    },
  ),
  mcpComponent(
    "mcp.chrome-devtools",
    "Chrome DevTools MCP",
    "Servidor oficial de Chrome DevTools para depuración, red y rendimiento de aplicaciones web en Chrome.",
    anyOf(stack("tool", "tool.playwright"), stack("framework", "framework.react", "framework.next", "framework.vue", "framework.svelte")),
    31,
    {
      id: "chrome-devtools",
      command: "npx",
      args: ["--yes", "chrome-devtools-mcp@1.6.0"],
    },
  ),
  mcpComponent(
    "mcp.supabase",
    "Supabase MCP",
    "Servidor oficial de Supabase para consultar y administrar recursos del proyecto; las mutaciones requieren aprobación.",
    stack("tool", "tool.supabase"),
    30,
    {
      id: "supabase",
      configuration: { url: "https://mcp.supabase.com/mcp" },
    },
  ),
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
