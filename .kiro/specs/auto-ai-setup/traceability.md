# SDD traceability coverage

This file is the deterministic coverage registry consumed by `pnpm traceability`. Each line designates at least one check for every acceptance criterion. Ranges are inclusive and use the same `Requirement.Criterion` IDs as `requirements.md`.

- integration: Requirements 1.1–1.14 (tests/project-gateway.test.ts, tests/cli-session.test.ts)
- property: Requirements 2.1–2.16 (tests/project-scan.property.test.ts, tests/stack-evidence.property.test.ts, tests/stack-conflicts.property.test.ts)
- unit: Requirements 3.1–3.13 (tests/recommendations.test.ts, tests/cli-probes.test.ts)
- integration: Requirements 4.1–4.12 (tests/cli-session.test.ts)
- integration: Requirements 5.1–5.15 (tests/autoskills-adapter.test.ts, tests/autoskills-validation.test.ts)
- unit: Requirements 6.1–6.12 (tests/component-inspection.test.ts, tests/json-codec.test.ts, tests/kiro-mcp-adapter.test.ts, tests/agent-adapters.test.ts)
- unit: Requirements 7.1–7.21 (tests/planning-security.test.ts, tests/transaction-engine.test.ts)
- integration: Requirements 8.1–8.17 (tests/transaction-engine.test.ts, tests/cli-session.test.ts)
- unit: Requirements 9.1–9.8 (tests/transaction-engine.test.ts, tests/benchmark-harness.test.ts)
- unit: Requirements 10.1–10.12 (tests/json-codec.test.ts)
- unit: Requirements 11.1–11.11 (tests/contracts.test.ts)
- integration: Requirements 12.1–12.11 (tests/project-scan.test.ts, tests/benchmark-harness.test.ts)
- unit: Requirements 13.1–13.20 (tests/contracts.test.ts, tests/planning-security.property.test.ts)
- smoke: Requirements 14.1–14.19 (tests/cli-session.test.ts)
- executable-validation: Requirements 15.1–15.16 (tests/planning-security.test.ts, tests/transaction-engine.test.ts)
