# Project Structure

The repository now contains the MVP implementation. Preserve the boundaries below as the code evolves; `autoskills` is an independent TUI handoff, while transaction and recovery cover only changes owned by `auto-ai-setup`.

```text
.
├── .kiro/
│   ├── specs/auto-ai-setup/   # Requirements, design, tasks, and spec metadata
│   └── steering/              # Always-loaded project guidance
├── src/
│   ├── cli/                   # Flag parsing, TTY prompts, rendering, exit codes
│   ├── application/session/   # Session state machine and use-case orchestration
│   ├── domain/
│   │   ├── agent/             # Agent registry: ids, capability matrix, deferred agents
│   │   ├── project/           # Directory validation, evidence, stack, conflicts
│   │   ├── catalog/           # autoskills catalog validation and recommendations
│   │   ├── config/            # Structured JSON parsing, merge, diff, equivalence
│   │   ├── planning/          # Deterministic plans, approvals, plan hashes
│   │   └── security/          # Path policy, allowlists, network policy, redaction
│   └── infrastructure/
│       ├── fs/                # Safe scanning, staging, atomic writes, backups
│       ├── process/           # Registered autoskills process adapter only
│       ├── catalog/            # autoskills integration and Skill verification
│       ├── agent/              # Per-agent adapters: target detection, MCP dialects,
│       │                       # markdown rules and commands, hook documents
│       ├── transaction/        # Journal, commit, rollback, recovery
│       └── observability/      # Local events and human/JSON rendering
├── tests/                     # Unit, integration, property, packaging/smoke tests
├── package.json               # npm metadata, bin, scripts, dependencies
├── tsconfig.json              # Strict TypeScript configuration
└── vitest.config.ts           # Vitest and fast-check test configuration
```

Keep dependency direction inward: infrastructure depends on domain contracts, application composes ports, and the CLI does not access filesystem or process APIs directly. Add new agent integrations as adapters rather than changing domain rules.

Supported agents are Kiro, Claude Code, OpenAI Codex, and OpenCode. `.kiro/specs/auto-ai-setup/agents.md` holds the normative support matrix, the official destination of every capability, and the surfaces deferred to later phases; keep it in sync with `src/domain/agent/models.ts`. Adapters are registered in one place, `src/infrastructure/process/node-cli-runtime.ts`, and share a single agent-target resolver per run so the plan stays deterministic.
