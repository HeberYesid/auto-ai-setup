# Project Structure

The repository is currently spec-first: implementation files have not been created yet. The source layout below is the planned boundary and should be preserved as implementation is added.

```text
.
├── .kiro/
│   ├── specs/auto-ai-setup/   # Requirements, design, tasks, and spec metadata
│   └── steering/              # Always-loaded project guidance
├── src/
│   ├── cli/                   # Flag parsing, TTY prompts, rendering, exit codes
│   ├── application/session/   # Session state machine and use-case orchestration
│   ├── domain/
│   │   ├── project/           # Directory validation, evidence, stack, conflicts
│   │   ├── catalog/           # autoskills catalog validation and recommendations
│   │   ├── config/            # Structured JSON parsing, merge, diff, equivalence
│   │   ├── planning/          # Deterministic plans, approvals, plan hashes
│   │   └── security/          # Path policy, allowlists, network policy, redaction
│   └── infrastructure/
│       ├── fs/                # Safe scanning, staging, atomic writes, backups
│       ├── process/           # Registered autoskills process adapter only
│       ├── catalog/            # autoskills integration and Skill verification
│       ├── agent/              # Kiro, MCP, AGENTS.md, Skills, command adapters
│       ├── transaction/        # Journal, commit, rollback, recovery
│       └── observability/      # Local events and human/JSON rendering
├── tests/                     # Unit, integration, property, packaging/smoke tests
├── package.json               # npm metadata, bin, scripts, dependencies
├── tsconfig.json              # Strict TypeScript configuration
└── vitest.config.ts           # Vitest and fast-check test configuration
```

Keep dependency direction inward: infrastructure depends on domain contracts, application composes ports, and the CLI does not access filesystem or process APIs directly. Add new agent integrations as adapters rather than changing domain rules.
