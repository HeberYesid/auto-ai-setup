# Product

`auto-ai-setup` is a local, interactive CLI for preparing new or existing projects for AI-agent workflows. It analyzes local project evidence, detects the technology stack, recommends related CLIs, and lets users configure MCP servers, agent rules, and agent commands. It may also offer the official `npx autoskills` interactive TUI as a separate Skill-management handoff.

The MVP runs through `npx auto-ai-setup` and supports automatic or manual selection for changes owned by this CLI. It must show a deterministic change plan and obtain explicit approval before modifying the project. Those local changes are recoverable. The `autoskills` TUI is independently authorized before launch and is outside the `auto-ai-setup` plan, transaction, rollback, ownership, and idempotency guarantees.

Product boundaries:
- Do not automatically install or execute recommended CLIs (`gh`, `supabase`, `vercel`, `playwright`).
- Launch only the fixed official midudev `npx autoskills` interactive flow after showing its network/file effects and independent transactional boundary.
- Do not parse, recommend, verify, own, roll back, or directly download Skills; Skill selection and installation belong to the external TUI.
- A TUI cancellation or failure must not prevent unrelated MCP, rule, and command configuration.
- Do not execute MCP servers, arbitrary shell commands, package lifecycle scripts, telemetry, AWS Bedrock, serverless backends, or security hooks in the MVP.
- Preserve user-owned configuration and unknown fields; never expose secrets in plans, previews, or local events.
