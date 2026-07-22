# Product

`auto-ai-setup` is a local, interactive CLI for preparing new or existing projects for AI-agent workflows. It analyzes local project evidence, detects the technology stack, recommends related CLIs, and lets users configure Skills, MCP servers, agent rules, and agent commands.

The MVP runs through `npx auto-ai-setup` and supports automatic or manual selection. It must show a deterministic change plan and obtain explicit approval before modifying the project. Changes are local and recoverable; only explicitly approved `autoskills` operations may use the network.

Product boundaries:
- Do not automatically install or execute recommended CLIs (`gh`, `supabase`, `vercel`, `playwright`).
- Use the official midudev `npx autoskills` flow for Skill inventory and installation; do not download Skills directly.
- Do not execute MCP servers, arbitrary shell commands, package lifecycle scripts, telemetry, AWS Bedrock, serverless backends, or security hooks in the MVP.
- Preserve user-owned configuration and unknown fields; never expose secrets in plans, previews, or local events.
