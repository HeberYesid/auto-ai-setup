# Soporte multi-agente

> **Enmienda normativa de alcance.** Este documento sustituye la línea «Agente soportado» de `design.md`. Los agentes soportados son Kiro, Claude Code, OpenAI Codex y OpenCode. Cada destino se derivó de la documentación oficial del agente, no de convenciones de terceros. El resto de agentes queda documentado como fase posterior.

## Cómo se eligen los agentes de una ejecución

Un agente se configura cuando el proyecto ya contiene una de sus huellas (`footprints`). Si el proyecto no contiene ninguna huella de ningún agente — el caso de proyecto nuevo — se configuran los cuatro, porque no hay evidencia para acotar el conjunto. En ambos casos el plan de cambios enumera cada destino y no se escribe nada sin aprobación explícita.

La resolución se calcula una sola vez por ejecución y se comparte con todos los adaptadores: un plan cuyo conjunto de agentes variara entre adaptadores no sería determinista.

| Agente        | Huellas detectadas                                    |
| ------------- | ----------------------------------------------------- |
| Kiro          | `.kiro/`                                              |
| Claude Code   | `.claude/`, `CLAUDE.md`, `.mcp.json`                  |
| OpenAI Codex  | `.codex/`, `AGENTS.md`                                |
| OpenCode      | `.opencode/`, `opencode.json`, `opencode.jsonc`, `AGENTS.md` |

## Matriz de soporte

`—` significa que la superficie existe pero queda fuera de esta fase; la razón se registra en `AGENT_DESCRIPTORS` (`src/domain/agent/models.ts`) y se muestra en el plan.

| Componente        | Kiro                             | Claude Code             | OpenAI Codex               | OpenCode                        |
| ----------------- | -------------------------------- | ----------------------- | -------------------------- | ------------------------------- |
| Servidores MCP    | `.kiro/settings/mcp.json`        | `.mcp.json`             | `.codex/config.toml`       | `opencode.json`                 |
| Reglas de agente  | `.kiro/steering/auto-ai-setup.md`| `CLAUDE.md`             | `AGENTS.md`                | `AGENTS.md`                     |
| Comandos (slash)  | `.kiro/prompts/<id>.md`          | `.claude/commands/<id>.md` | — (prompts deprecados y solo en `~/.codex/prompts`) | `.opencode/commands/<id>.md` |
| Hooks             | `.kiro/hooks/<id>.json`          | `.claude/settings.json` | `.codex/hooks.json`        | — (solo plugins JS/TS ejecutables) |
| Skills            | Externo: TUI `npx autoskills`    | Externo                 | Externo                    | Externo                         |

Referencias oficiales: [Kiro](https://kiro.dev/docs/), [Claude Code](https://docs.claude.com/en/docs/claude-code/), [Codex](https://developers.openai.com/codex/), [OpenCode](https://opencode.ai/docs/).

## Decisiones por dialecto

**MCP.** El transporte se resuelve una vez de forma neutral y después se proyecta al dialecto del agente, porque las formas difieren de verdad:

- Kiro deduce el transporte de `command` o `url`, sin discriminador.
- Claude Code lee una entrada sin `type` como stdio, así que un servidor remoto **debe** declarar `type: "http" | "sse" | "ws"`.
- OpenCode discrimina cada entrada con `type: "local" | "remote"`, recibe el comando como un único array y interpola variables con `{env:NOMBRE}`.
- Codex solo lee MCP desde `config.toml`. No admite expansión `${VAR}`, por lo que las variables se reenvían por nombre con `env_vars` y las cabeceras autenticadas se declaran con `env_http_headers`. Ningún valor secreto se escribe nunca en el fichero.

**TOML de Codex.** Es el único fichero no JSON que escribe el MVP. El adaptador **no parsea TOML**: emite cada servidor como un bloque delimitado por marcadores `# auto-ai-setup:mcp:<id>:begin|end`, igual que los bloques gestionados de `AGENTS.md`. Todo lo que está fuera de los marcadores se preserva byte a byte, así que comentarios, orden y tablas desconocidas del usuario quedan intactos sin necesitar un códec TOML con garantías de ida y vuelta. Si el usuario ya declaró un servidor a mano, su tabla no se toca y la operación se marca con conflicto `ownership-unknown`.

**Reglas.** El mismo documento con marcadores sirve para las tres superficies Markdown; solo cambia el destino. Claude Code carga `CLAUDE.md`, no `AGENTS.md`; Kiro usa steering; Codex y OpenCode leen `AGENTS.md` de forma nativa.

**Hooks.** Claude Code y Codex comparten el esquema de tres niveles (evento → grupo con `matcher` → manejadores), pero discrepan en los nombres de evento y en qué manejadores ejecutan realmente. El perfil de cada agente registra ambas diferencias:

- La propiedad de cada grupo gestionado se marca en `statusMessage` con `auto-ai-setup:<id>`, el único campo de texto libre que ambos aceptan. Los grupos escritos por el usuario se preservan.
- `PreTaskExec` y `PostTaskExec` se traducen a `TaskCreated` y `TaskCompleted` en Claude Code.
- `PostFileCreate`, `PostFileSave` y `PostFileDelete` no tienen equivalente: ni Claude Code ni Codex observan el filesystem, solo llamadas a herramientas, y su `matcher` filtra nombres de herramienta y no rutas. Esos hooks se omiten para esos agentes en lugar de escribir un hook muerto.
- Codex analiza los manejadores `prompt` y `agent` pero no los ejecuta, así que solo se le escriben manejadores `command`.

`auto-ai-setup` escribe la configuración de un hook y nunca lo ejecuta; el runtime del agente lo ejecuta después de su propia revisión de confianza.

## Fases posteriores

| Agente          | Superficie conocida                                                    |
| --------------- | ---------------------------------------------------------------------- |
| Cursor          | `.cursor/rules/*.mdc` y `.cursor/mcp.json`                             |
| GitHub Copilot  | `.github/copilot-instructions.md` y MCP gestionado por el editor       |
| Gemini CLI      | `.gemini/settings.json` y `GEMINI.md`                                  |
| Windsurf        | `.windsurf/rules` y su propia configuración MCP                        |
| Amp             | Configuración de MCP y hooks aún no estabilizada                       |

También quedan para fases posteriores los comandos slash de Codex (sus custom prompts están deprecados y viven fuera del proyecto; su reemplazo son Skills) y los hooks de OpenCode (requieren generar plugins JavaScript/TypeScript ejecutables, algo que este CLI no hace).

Las Skills siguen siendo externas para todos los agentes: se seleccionan e instalan en la TUI oficial `npx autoskills`, fuera del plan, la transacción, el rollback y las garantías de idempotencia de `auto-ai-setup`.
