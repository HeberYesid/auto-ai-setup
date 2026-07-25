import type { ComponentDefinition, ComponentId, StackCategory } from "../../domain/index.js";
import type { AgentRuleComponentDefinition, AgentRuleDefinition } from "./agents-rules-adapter.js";
import type { AgentHookComponentDefinition, AgentHookDefinition } from "./kiro-hook-adapter.js";
import type { KiroCommandComponentDefinition, KiroCommandDefinition } from "./kiro-command-adapter.js";
import type { KiroMcpComponentDefinition, McpServerDefinition } from "./kiro-mcp-adapter.js";

const builtinSource = { kind: "builtin" as const, origin: "auto-ai-setup" };
const always = { op: "always" as const };
const stack = (category: StackCategory, ...ids: string[]) => ({ op: "stack" as const, category, oneOf: ids });
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

const ruleComponent = (
  id: string,
  name: string,
  description: string,
  compatibility: ComponentDefinition["compatibility"],
  priority: number,
  rule: AgentRuleDefinition,
): AgentRuleComponentDefinition => ({
  id: id as ComponentId,
  type: "agent-rule",
  name,
  description,
  compatibility,
  source: builtinSource,
  priority,
  rule,
});

const commandComponent = (
  id: string,
  name: string,
  description: string,
  compatibility: ComponentDefinition["compatibility"],
  priority: number,
  command: KiroCommandDefinition,
): KiroCommandComponentDefinition => ({
  id: id as ComponentId,
  type: "agent-command",
  name,
  description,
  compatibility,
  source: builtinSource,
  priority,
  command,
});

const hookComponent = (
  id: string,
  name: string,
  description: string,
  compatibility: ComponentDefinition["compatibility"],
  priority: number,
  hook: AgentHookDefinition,
): AgentHookComponentDefinition => ({
  id: id as ComponentId,
  type: "agent-hook",
  name,
  description,
  compatibility,
  source: builtinSource,
  priority,
  hook,
});

/**
 * A package-manager rule is one component per manager instead of a single generic rule: the
 * `package-manager` stack category is exclusive, so at most one variant is ever compatible and the
 * emitted text can name the real command without guessing.
 */
const packageManagerRule = (
  managerId: string,
  displayName: string,
  installCommand: string,
  runCommand: string,
  priority: number,
): AgentRuleComponentDefinition =>
  ruleComponent(
    `rule.package-manager.${managerId}`,
    `Gestor de paquetes: ${displayName}`,
    `Fija ${displayName} como único gestor de paquetes para que el agente no mezcle lockfiles ni comandos de otro gestor.`,
    stack("package-manager", managerId),
    priority,
    {
      id: `package-manager-${managerId}`,
      content: [
        `## Gestor de paquetes`,
        "",
        `Este proyecto usa **${displayName}**. Detectado por su lockfile.`,
        "",
        `- Instala dependencias con \`${installCommand}\`.`,
        `- Ejecuta scripts con \`${runCommand} <script>\`.`,
        `- No uses otro gestor de paquetes ni generes lockfiles adicionales.`,
        `- No edites el lockfile a mano; deja que ${displayName} lo actualice.`,
      ].join("\n"),
    },
  );

/** A test-runner rule is gated per runner for the same reason: the command must be exact. */
const testRunnerRule = (
  runnerId: string,
  displayName: string,
  stackId: string,
  runCommand: string,
  priority: number,
): AgentRuleComponentDefinition =>
  ruleComponent(
    `rule.testing.${runnerId}`,
    `Convenciones de tests: ${displayName}`,
    `Documenta cómo se ejecutan y dónde viven los tests de ${displayName} para que el agente no invente otro runner.`,
    stack("tool", stackId),
    priority,
    {
      id: `testing-${runnerId}`,
      content: [
        `## Tests`,
        "",
        `El runner de este proyecto es **${displayName}**.`,
        "",
        `- Ejecuta la suite completa una sola vez con \`${runCommand}\`; no dejes el modo watch activo.`,
        `- Añade tests junto al código o en el directorio de tests que ya exista; no crees una estructura nueva.`,
        `- No introduzcas otro framework de tests ni mezcles runners.`,
        `- Un test debe ser determinista: sin red real, sin relojes reales y sin estado compartido entre tests.`,
      ].join("\n"),
    },
  );

/**
 * A guard hook only asks for confirmation: it prints an `ask` decision and never blocks outright,
 * and the script is a single `node -e` body with no double quotes so the same string works under
 * both `cmd.exe` and POSIX shells. auto-ai-setup writes it; the agent runtime is what runs it.
 */
const guardScript = (pattern: string, reason: string): string =>
  `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{if(new RegExp(${pattern}).test(d))process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask',permissionDecisionReason:'${reason}'}}))})"`;

/** Tool names differ per agent, so the matcher tolerates both casings of the usual write verbs. */
const writeToolMatcher = "[Ww]rite|[Ee]dit|[Aa]ppend|[Rr]eplace|[Cc]reate";

/**
 * Components owned by auto-ai-setup rather than discovered from autoskills.
 * They only produce local configuration; no MCP process, hook command, or recommended CLI is executed.
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
      transport: "http",
      url: "https://mcp.context7.com/mcp",
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
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
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
      transport: "http",
      url: "https://mcp.sentry.dev/mcp",
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
      transport: "http",
      url: "https://mcp.cloudflare.com/mcp",
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
      transport: "http",
      url: "https://mcp.supabase.com/mcp",
    },
  ),
  mcpComponent(
    "mcp.prisma",
    "Prisma MCP",
    "Servidor oficial de Prisma para inspeccionar el schema, generar migraciones y consultar la base de datos del proyecto.",
    stack("tool", "tool.prisma", "tool.prisma.config"),
    29,
    {
      id: "prisma",
      command: "npx",
      args: ["--yes", "prisma", "mcp"],
    },
  ),
  mcpComponent(
    "mcp.mongodb",
    "MongoDB MCP",
    "Servidor oficial de MongoDB para explorar colecciones, índices y consultas; la conexión se toma de una variable de entorno.",
    stack("tool", "tool.mongodb"),
    28,
    {
      id: "mongodb",
      command: "npx",
      args: ["--yes", "mongodb-mcp-server@latest", "--readOnly"],
      env: ["MDB_MCP_CONNECTION_STRING"],
    },
  ),
  mcpComponent(
    "mcp.stripe",
    "Stripe MCP",
    "Servidor oficial de Stripe para consultar productos, precios, clientes y pagos; la clave se lee de una variable de entorno.",
    stack("tool", "tool.stripe"),
    27,
    {
      id: "stripe",
      command: "npx",
      args: ["--yes", "@stripe/mcp", "--tools=all"],
      env: ["STRIPE_SECRET_KEY"],
    },
  ),
  mcpComponent(
    "mcp.aws-documentation",
    "AWS Documentation MCP",
    "Servidor oficial de AWS Labs para consultar la documentación de AWS sin salir del flujo del agente.",
    anyOf(stack("tool", "tool.aws", "tool.aws.python")),
    26,
    {
      id: "aws-documentation",
      command: "uvx",
      args: ["awslabs.aws-documentation-mcp-server@latest"],
    },
  ),

  ruleComponent(
    "rule.agents-md-base",
    "Base AGENTS.md",
    "Crea la sección base de AGENTS.md: el archivo de reglas que leen de forma nativa Codex, Cursor, Copilot, Gemini CLI y otros agentes.",
    always,
    28,
    {
      id: "agents-md-base",
      content: [
        "## Cómo trabajar en este proyecto",
        "",
        "- Lee el código existente antes de proponer cambios; sigue las convenciones y librerías que ya están en uso.",
        "- Ejecuta la build y los tests del proyecto antes de dar una tarea por terminada.",
        "- No añadas dependencias, abstracciones ni configuración que la tarea no necesite.",
        "- No toques `node_modules/`, artefactos de build ni ficheros generados.",
        "- Si un cambio afecta a autenticación, infraestructura o datos, explica el riesgo antes de aplicarlo.",
      ].join("\n"),
    },
  ),
  packageManagerRule("pnpm", "pnpm", "pnpm install", "pnpm run", 27),
  packageManagerRule("npm", "npm", "npm install", "npm run", 26),
  packageManagerRule("yarn", "Yarn", "yarn install", "yarn", 25),
  packageManagerRule("bun", "Bun", "bun install", "bun run", 24),
  testRunnerRule("vitest", "Vitest", "tool.vitest", "vitest --run", 23),
  testRunnerRule("jest", "Jest", "tool.jest", "jest --ci", 22),
  ruleComponent(
    "rule.commit-conventions",
    "Convenciones de commits",
    "Documenta el formato de commit y las operaciones de git que el agente no debe ejecutar por su cuenta.",
    always,
    21,
    {
      id: "commit-conventions",
      content: [
        "## Git",
        "",
        "- Usa Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.",
        "- Crea un commit solo cuando se te pida explícitamente, y añade ficheros por nombre en vez de `git add .`.",
        "- No uses `--amend`, `push --force`, `reset --hard`, `clean -fd` ni `branch -D` sin autorización explícita.",
        "- No hagas push directo a `main`; trabaja en una rama y abre un pull request.",
        "- No desactives los hooks de git con `--no-verify`.",
      ].join("\n"),
    },
  ),
  ruleComponent(
    "rule.project-safety",
    "Project Safety Rules",
    "Añade reglas gestionadas para conservar cambios del usuario y evitar ejecutar herramientas no aprobadas.",
    always,
    20,
    {
      id: "project-safety",
      content:
        "Preserva el contenido existente del proyecto. No ejecutes servidores MCP ni CLIs recomendadas sin una aprobación explícita del usuario.",
    },
  ),
  ruleComponent(
    "rule.framework.next",
    "Convenciones de Next.js",
    "Documenta las fronteras servidor/cliente de Next.js para evitar errores de App Router y Server Components.",
    stack("framework", "framework.next"),
    19,
    {
      id: "framework-next",
      content: [
        "## Next.js",
        "",
        '- Un componente es Server Component por defecto; añade `"use client"` solo cuando haga falta estado, efectos o APIs del navegador.',
        "- No importes código de servidor (secretos, acceso a base de datos) desde un componente cliente.",
        "- Mantén el patrón de routing que ya usa el proyecto (App Router o Pages Router); no mezcles ambos.",
        "- Los secretos van en variables de entorno de servidor; solo lo prefijado con `NEXT_PUBLIC_` llega al navegador.",
      ].join("\n"),
    },
  ),

  commandComponent(
    "command.review-project",
    "Review Project",
    "Registra un comando reutilizable para revisar el estado y los cambios del proyecto.",
    always,
    18,
    {
      id: "review-project",
      name: "Review Project",
      description: "Review the project structure and current changes.",
      prompt: "Review this project, summarize its structure, and identify uncommitted changes without modifying files.",
    },
  ),
  commandComponent(
    "command.explain-architecture",
    "Explain Architecture",
    "Comando de solo lectura que mapea módulos, capas y dependencias del proyecto.",
    always,
    17,
    {
      id: "explain-architecture",
      name: "Explain Architecture",
      description: "Map the modules, layers, and dependency direction of this project.",
      prompt: [
        "Map the architecture of this project without modifying any file.",
        "",
        "1. List the top-level modules and what each one is responsible for.",
        "2. Describe the dependency direction between them and point out any cycle or layering violation.",
        "3. Name the entry points (bin, server, CLI, exported API).",
        "4. Finish with the three areas where a change is most likely to break something else, and why.",
      ].join("\n"),
    },
  ),
  commandComponent(
    "command.review-diff",
    "Review Diff",
    "Revisa los cambios sin commitear como lo haría un revisor senior, sin modificar ficheros.",
    always,
    16,
    {
      id: "review-diff",
      name: "Review Diff",
      description: "Review the uncommitted changes without modifying files.",
      prompt: [
        "Review the uncommitted changes in this repository. Do not modify any file and do not create a commit.",
        "",
        "1. Read the diff of staged and unstaged changes.",
        "2. Group the findings by concern, not by file.",
        "3. Flag correctness bugs, missing error handling, security issues, and missing tests.",
        "4. Separate blocking problems from optional suggestions.",
      ].join("\n"),
    },
  ),
  commandComponent(
    "command.write-tests",
    "Write Tests",
    "Genera tests con el runner que ya usa el proyecto, sin introducir otro framework.",
    anyOf(stack("tool", "tool.vitest", "tool.jest", "tool.playwright")),
    15,
    {
      id: "write-tests",
      name: "Write Tests",
      description: "Add tests for the requested code using the project's existing test runner.",
      prompt: [
        "Add tests for the code I point you at, using the test runner and conventions this project already uses.",
        "",
        "1. Find the existing test setup and copy its structure, naming, and helpers.",
        "2. Cover the happy path, the boundary cases, and the error paths.",
        "3. Keep tests deterministic: no real network, no real clock, no shared state.",
        "4. Run the suite once and fix what fails before reporting back.",
      ].join("\n"),
    },
  ),
  commandComponent(
    "command.fix-checks",
    "Fix Checks",
    "Resuelve errores de tipos, lint y build usando los scripts reales del proyecto.",
    anyOf(stack("language", "typescript"), stack("tool", "tool.eslint", "tool.eslint.config")),
    14,
    {
      id: "fix-checks",
      name: "Fix Checks",
      description: "Fix type, lint, and build errors using the project's own scripts.",
      prompt: [
        "Fix the failing checks in this project.",
        "",
        "1. Read the scripts declared in the project manifest and run the type, lint, and build checks that exist.",
        "2. Fix the reported errors at their root cause; do not silence them with suppression comments or `any`.",
        "3. Re-run the checks until they pass.",
        "4. Report what you changed and anything you could not fix.",
      ].join("\n"),
    },
  ),
  commandComponent(
    "command.update-agents-md",
    "Update AGENTS.md",
    "Refresca AGENTS.md cuando el stack, los scripts o las convenciones del proyecto cambian.",
    always,
    13,
    {
      id: "update-agents-md",
      name: "Update AGENTS.md",
      description: "Refresh AGENTS.md so it matches the current stack and scripts.",
      prompt: [
        "Update AGENTS.md so it matches the current state of this project.",
        "",
        "1. Read the project manifest, lockfile, and config files to get the real build, test, and lint commands.",
        "2. Correct any command, path, or convention in AGENTS.md that is out of date.",
        "3. Do not remove or rewrite content inside `auto-ai-setup:rule:*` managed markers.",
        "4. Keep it short: only what an agent cannot infer from the code itself.",
      ].join("\n"),
    },
  ),

  hookComponent(
    "hook.guard-secret-files",
    "Proteger ficheros de secretos",
    "Pide confirmación antes de que el agente escriba en `.env`, claves o almacenes de credenciales.",
    always,
    12,
    {
      id: "guard-secret-files",
      name: "Guard secret files",
      trigger: "PreToolUse",
      matcher: writeToolMatcher,
      action: {
        type: "command",
        command: guardScript(
          "/\\.env|\\.pem$|\\.p12$|id_rsa|credentials|secrets?\\.(json|ya?ml)/i",
          "This path looks like a secret store. Confirm before writing.",
        ),
        timeout: 15,
      },
    },
  ),
  hookComponent(
    "hook.guard-lockfile",
    "Proteger el lockfile",
    "Pide confirmación antes de que el agente edite un lockfile a mano en lugar de dejarlo al gestor de paquetes.",
    always,
    11,
    {
      id: "guard-lockfile",
      name: "Guard lockfile",
      trigger: "PreToolUse",
      matcher: writeToolMatcher,
      action: {
        type: "command",
        command: guardScript(
          "/package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock|bun\\.lockb|poetry\\.lock|uv\\.lock|Gemfile\\.lock|composer\\.lock/",
          "Lockfiles should be regenerated by the package manager. Confirm before editing.",
        ),
        timeout: 15,
      },
    },
  ),
  hookComponent(
    "hook.format-on-save",
    "Formatear al guardar",
    "Recuerda al agente aplicar el formateador del proyecto al fichero que acaba de guardar.",
    anyOf(stack("tool", "tool.prettier", "tool.prettier.config", "tool.eslint", "tool.eslint.config")),
    10,
    {
      id: "format-on-save",
      name: "Format on save",
      trigger: "PostFileSave",
      matcher: "\\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|md)$",
      action: {
        type: "agent",
        prompt:
          "Run the project's own formatter and linter scripts on the file that was just saved, then fix what they report. Do not reformat unrelated files.",
      },
    },
  ),
  hookComponent(
    "hook.typecheck-on-save",
    "Comprobar tipos al guardar",
    "Recuerda al agente ejecutar la comprobación de tipos tras editar TypeScript.",
    stack("language", "typescript"),
    9,
    {
      id: "typecheck-on-save",
      name: "Typecheck on save",
      trigger: "PostFileSave",
      matcher: "\\.(ts|tsx|mts|cts)$",
      action: {
        type: "agent",
        prompt:
          "Run the project's type-check script and fix any error introduced by the file that was just saved. Fix the root cause; do not use suppression comments or `any`.",
      },
    },
  ),
  hookComponent(
    "hook.test-on-change",
    "Ejecutar tests al cambiar",
    "Recuerda al agente ejecutar los tests afectados cuando se modifica un fichero de tests.",
    anyOf(stack("tool", "tool.vitest", "tool.jest")),
    8,
    {
      id: "test-on-change",
      name: "Test on change",
      trigger: "PostFileSave",
      matcher: "(\\.(test|spec)\\.[a-z]+$|(^|/)tests?/)",
      action: {
        type: "agent",
        prompt:
          "Run the affected tests once with the project's test runner in single-run mode, then report the result. Do not start a watch process.",
      },
    },
  ),
];

export const createBuiltinAgentComponents = (): readonly ComponentDefinition[] => [...builtinAgentComponents];
