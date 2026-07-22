# Implementation Plan: auto-ai-setup

## Overview

Implement the local, interactive TypeScript/ESM CLI described by `requirements.md` and `design.md`. Each task is an incremental prompt for a code-generation agent: it creates or modifies concrete code, tests the behavior it introduces, and leaves the result wired for the next task. The final tasks connect the pure domain, adapters, transaction engine, CLI, packaging, and quality gates without adding AWS Bedrock, a serverless backend, security hooks, telemetry, arbitrary shell execution, or automatic execution of recommended CLIs.

Implementation language: **TypeScript**, strict mode, Node.js 20+ runtime, Vitest, and fast-check.

## Tasks

- [x] 1. Establish the TypeScript package boundary and shared contracts
  - [x] 1.1 Create the ESM package entrypoint, portable CLI bin/shebang, `src/` layer boundaries, strict TypeScript configuration, and Vitest/fast-check configuration.
    - Configure `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `useUnknownInCatchVariables`; keep the CLI executable through `npx auto-ai-setup`.
    - Keep `cli` dependent on application ports, not directly on filesystem or process APIs.
    - _Requirements: 1.1, 13.1, 15.1, 15.2_
  - [x] 1.2 Define shared branded types, `Result`/typed error unions, session inputs, exit codes, domain models, and port interfaces from the design.
    - Include `ValidatedProject`, stack/evidence/conflict types, component/catalog types, `ChangePlan`, approvals, journals, local events, and execution summaries.
    - Encode the invariants for safe paths, approval subsets, unique IDs, and terminal exit states at the domain boundary.
    - _Requirements: 1.7–1.9, 2.5–2.6, 7.1–7.21, 8.1–8.17, 11.1–11.11, 15.3–15.9_
  - [x] 1.3 Add deterministic test infrastructure and fakes for clocks, UUIDs, filesystem, process execution, network, and `UserInteraction`.
    - Provide `ScriptedUserInteraction`, virtual project fixtures, failure injection, and seeded fast-check helpers without implementing a custom property-test generator.
    - _Requirements: 13.5–13.16, 13.20_

- [x] 2. Implement project validation, bounded scanning, and stack evidence analysis
  - [x] 2.1 Implement the safe `ProjectGateway` for path existence/type/realpath checks, enumeration/read checks, temporary probe cleanup, canonical-root selection, and new/existing classification.
    - Return named, redactable directory errors and exit-code-ready results without persistent mutation on validation failure.
    - _Requirements: 1.2–1.14_
  - [x] 2.2 Implement the bounded asynchronous scan policy and detector registry for supported languages, package managers, frameworks, tools, recognized formats, syntax/schema validation, provenance, exclusions, byte/file limits, and monotonic timing.
    - Exclude dependency, VCS, build, coverage, cache, and virtual-environment directories; do not follow symlinks or infer stack values from folder names.
    - _Requirements: 2.1–2.11, 12.4–12.11_
  - [x] 2.3 Implement stack aggregation, explicit/derived confidence, conflict detection, conflict resolution, and stack view models with all evidence references.
    - Suspend only recommendations dependent on unresolved categories and provide the manual fallback when no compatible stack is confirmed.
    - _Requirements: 2.7–2.16_
  - [x] 2.4 Write the fast-check property test for **Property 1: Validar un directorio no deja efectos y canoniza el root**.
    - Use virtual/real temporary directories and injected failures to assert probe cleanup, snapshot preservation, exit code 2 on failure, and canonical `realpath` on success.
    - **Validates: Requirements 1.6, 1.8, 1.9**
  - [x] 2.5 Write the fast-check property test for **Property 2: Clasificación total por cantidad de archivos de proyecto**.
    - Generate every non-negative project-file count and assert the exact `new`/`existing` partition.
    - **Validates: Requirements 1.11, 1.12**
  - [x] 2.6 Write the fast-check property test for **Property 3: Toda detección válida tiene provenance completa**.
    - Generate valid, invalid, unreadable, and absent evidence and assert claims contain path/location/value only for syntactically valid evidence.
    - **Validates: Requirements 2.1–2.6, 2.9–2.10**
  - [x] 2.7 Write the fast-check property test for **Property 4: Los conflictos suspenden únicamente recomendaciones dependientes**.
    - Generate stack categories, conflicts, and recommendation dependencies; assert unrelated recommendations survive and explicit resolution re-evaluates the blocked category.
    - **Validates: Requirements 2.14–2.15**
  - [x] 2.8 Write the fast-check property test for **Property 24: Recorrido excluido y clasificación del perfil**.
    - Generate trees containing excluded directories and over-limit file/byte counts; assert excluded files never reach detectors/counts and summaries classify profile applicability correctly.
    - **Validates: Requirements 12.4–12.11**
  - [x] 2.9 Add unit and integration tests for valid/invalid/missing/conflicting fixtures, permissions, symlinks, new/existing projects, evidence display, and bounded scan reporting.
    - **Requirements: 1.2–1.16, 2.1–2.16, 12.4–12.11**

- [x] 3. Implement CLI recommendations, compatibility, and mode selection
  - [x] 3.1 Implement the pure recommendation engine for `gh`, `supabase`, `vercel`, and `playwright`, evidence aggregation, explanations, stable ordering, and explicit non-execution/non-installation of recommended CLIs.
    - Include CLI recommendation entries in the plan as documented instructions only; never probe, install, or run the recommended CLI while generating a recommendation.
    - _Requirements: 3.1–3.13_
  - [x] 3.2 Implement compatibility expressions, component recommendation ordering, automatic removal, manual grouping by component type, incompatible-component explanations, and explicit override decisions.
    - _Requirements: 4.4–4.7, 6.1–6.12_
  - [x] 3.3 Add the isolated allowlisted-process contract represented by the design’s CLI-probe property without invoking recommended CLIs from the recommendation path; reject any unregistered process, nonzero/invalid/timeout result, or incompatible capability.
    - Keep this adapter unused by Requirement 3 recommendation generation until the probe-vs-no-probe design discrepancy is resolved.
    - _Requirements: 3.10–3.11, 15.1–15.2_
  - [ ]* 3.4 Write the fast-check property test for **Property 5: Clasificación de probes aislada y determinista**.
    - Test the isolated allowlist adapter with success, nonzero, invalid version, overflow, and timeout outcomes; assert failures are isolated and no recommended CLI process is invoked by the recommendation engine.
    - **Validates: design Property 5; Requirements 3.10–3.11**
  - [ ]* 3.5 Write the fast-check property test for **Property 6: Solo existen dos modos válidos**.
    - Generate arbitrary mode values and assert only `auto`/`manual` are accepted; invalid values re-prompt with both valid choices and make no project changes.
    - **Validates: Requirements 4.1–4.3**
  - [ ]* 3.6 Write the fast-check property test for **Property 7: Selección automática compatible y gate de selección**.
    - Generate stacks, CLI recommendations, catalogs, and selections; assert automatic results are compatible, empty selection skips plan/approval and returns zero changes/code 0, and non-empty selection cannot apply without `ApprovedPlan`.
    - **Validates: Requirements 4.4–4.12**
  - [ ]* 3.7 Write the fast-check property test for **Property 9: Las vistas de componentes son completas**.
    - Assert every Skill/MCP view preserves identity, name, description/purpose, origin where applicable, compatibility, and every unsatisfied condition.
    - **Validates: Requirements 5.2–5.5, 6.1–6.2, 6.8–6.9**
  - [ ]* 3.8 Add unit tests for recommendation deduplication, evidence explanations, no-recommendation output, automatic removal, manual zero-selection, incompatible accept/reject, and invalid mode handling.
    - **Requirements: 3.1–3.13, 4.1–4.12, 6.1–6.12**

- [x] 4. Integrate the trusted autoskills catalog and Skill installation adapter
  - [x] 4.1 Implement the registered process adapter for authorized `npx autoskills` listing and official installation, with bounded output, cancellation, origin restrictions, destination containment, and no arbitrary shell execution.
    - Build `CatalogSnapshot` only from validated midudev output and attach catalog digest/source revision to the planning input.
    - _Requirements: 5.1–5.7, 15.4–15.9_
  - [x] 4.2 Implement catalog snapshot validation, identity/origin membership checks, file/hash verification, partial-artifact cleanup, and Skill ownership state.
    - Reject altered or external entries before installation and remove partial artifacts before recovery when official installation fails.
    - _Requirements: 5.2–5.15_
  - [ ]* 4.3 Write the fast-check property test for **Property 8: Membresía e integridad de Skills gestionadas por autoskills**.
    - Generate catalog mutations in identity, origin, commit, path, digest, and response schema; assert invalid entries produce an empty Skill inventory or are rejected before install.
    - **Validates: Requirements 5.1, 5.7–5.12**
  - [ ]* 4.4 Add unit and controlled-process integration tests for successful/failed listing, invalid output, membership mismatch, approved installation, partial cleanup, and continuation without Skills.
    - Use fake local adapters/ports; do not depend on the public network in tests.
    - **Requirements: 5.1–5.15**

- [x] 5. Implement structured configuration and component adapters
  - [x] 5.1 Implement the JSON `StructuredConfigCodec` with syntax/schema diagnostics, JSON Pointer and line/column locations, dangerous-key rejection, duplicate-key handling, copy-on-write merge, style-preserving serialization, deep equivalence, and field diffs.
    - Preserve unknown fields, values, indentation, EOL style, and unrelated array order while adding only approved managed changes.
    - _Requirements: 6.7, 7.9–7.10, 9.2, 10.1–10.12_
  - [x] 5.2 Implement Kiro MCP workspace configuration adaptation at `.kiro/settings/mcp.json`.
    - Merge by server ID, preserve unknown entries/fields, expose environment variable names only, never write secret values, and never start an MCP server.
    - _Requirements: 6.1–6.5, 9.6, 10.9–10.12, 15.3_
  - [x] 5.3 Implement `AGENTS.md` rule blocks and Kiro command adapters.
    - Use the required rule markers, detect corrupt markers as conflicts, normalize only permitted whitespace/EOL differences, write prompts to `.kiro/prompts/<id>.md`, and merge `.auto-ai-setup/commands.json` while preserving unrelated fields.
    - _Requirements: 6.6–6.7, 9.5, 9.7, 10.9–10.12_
  - [x] 5.4 Implement the component inspection/projection layer and managed-state ownership model.
    - Project selected Skills, MCP servers, rules, and commands into complete file/external operations with compatibility decisions, origins, destinations, and no secrets.
    - _Requirements: 5.6, 6.3–6.12, 9.4–9.7_
  - [ ]* 5.5 Write the fast-check property test for **Property 10: La proyección de componentes al plan es completa y no filtra secretos**.
    - Generate mixed component selections and assert exact identity/origin/destination/file/external-operation projection, name-only environment variables, identifiable rule blocks, structured commands, and correct incompatible overrides.
    - **Validates: Requirements 5.6, 6.3–6.7, 6.11–6.12**
  - [ ]* 5.6 Write the fast-check property test for **Property 20: Round-trip de configuración estructurada**.
    - Generate at least 100 valid bounded JSON models per supported format run and assert parse/serialize/parse preserves semantic fields and values and emits valid syntax/schema.
    - **Validates: Requirements 10.1–10.2, 10.5–10.8, 13.9**
  - [ ]* 5.7 Write the fast-check property test for **Property 21: El merge solo altera el frame aprobado**.
    - Generate valid models with unknown fields and disjoint managed patches; assert every path outside the patch retains its exact field and value after merge/serialize/reparse.
    - **Validates: Requirements 10.9–10.12, 13.10**
  - [ ]* 5.8 Write the fast-check property test for **Property 22: Errores estructurados localizan entradas inválidas**.
    - Generate syntax- and schema-invalid documents and assert no partial model is returned and every error includes path, analyzable location, and non-empty cause.
    - **Validates: Requirements 10.3–10.4**
  - [ ]* 5.9 Write the fast-check property test for **Property 19: Los componentes gestionados son únicos**.
    - Generate duplicate/equivalent Skills, rules, MCP servers, and commands; assert normalization retains one effective instance per specified identity key.
    - **Validates: Requirements 9.4–9.7, 13.8**
  - [ ]* 5.10 Add unit and integration tests for codecs, unknown-field preservation, MCP merge, rule conflicts, command index merge, component views, and second-run equivalence.
    - **Requirements: 6.1–6.12, 9.2, 9.4–9.7, 10.1–10.12**

- [x] 6. Implement deterministic planning, consent, path security, events, and redaction
  - [x] 6.1 Implement `PathPolicy` for normalized project-relative destinations, lexical/real containment, ancestor symlink checks, device/NUL/traversal rejection, and safe handling of new destinations.
    - Return exit-code-2 planning errors before any external operation or filesystem mutation.
    - _Requirements: 7.18–7.19, 15.3_
  - [x] 6.2 Implement `ChangePlanner` with deterministic sorting, semantic diffing, previews/field diffs, conflict classification, precondition digests, external-operation metadata, canonical plan serialization, and SHA-256 `planHash`.
    - Treat equivalent state as `preserve`, never as a write or process operation.
    - _Requirements: 3.6–3.8, 7.1–7.10, 9.1–9.3_
  - [x] 6.3 Implement `ApprovalPolicy` and immutable `ApprovedPlan` creation.
    - Bind all decisions to the exact `planHash`; require global approval without conflicts, per-file preserve/replace decisions for conflicts, incompatible-component confirmations, and exact network-operation approvals.
    - _Requirements: 4.8–4.12, 7.11–7.17, 15.4–15.9_
  - [x] 6.4 Implement the recursive secret redactor for strings, nested objects, sensitive keys, token/PEM/credential URL patterns, known secret values, previews, and event context.
    - Apply redaction before any terminal/file sink and omit downloaded bodies, complete environment contents, and potentially sensitive normal stdout.
    - _Requirements: 7.20–7.21, 11.8–11.10_
  - [x] 6.5 Implement local `EventSink`, verbose-mode context policy, and summary event mapping with injected timestamps and run IDs.
    - Write only to terminal or project-local files; provide safe error causes and preserve base event fields in detailed mode.
    - _Requirements: 11.1–11.11_
  - [x]* 6.6 Write the fast-check property test for **Property 11: El diff de plan es determinista y completo**.
    - Generate equivalent current/desired states and assert one correct action per destination, complete component/reason/conflict metadata, complete external-operation metadata, and exact semantic previews/diffs.
    - **Validates: Requirements 7.3–7.10**
  - [x]* 6.7 Write the fast-check property test for **Property 12: Las decisiones de aprobación se vinculan al plan exacto**.
    - Generate plans with and without conflicts and approval mutations; assert exact required decisions, preserve omission, replace approval, and stale-hash rejection.
    - **Validates: Requirements 7.11–7.17**
  - [x]* 6.8 Write the fast-check property test for **Property 13: Confinamiento físico y lógico de destinos**.
    - Generate hostile relative/absolute/device/NUL/traversal paths and symlink ancestor chains; assert only physically and lexically contained destinations are accepted.
    - **Validates: Requirements 7.18–7.19, 15.3**
  - [x]* 6.9 Write the fast-check property test for **Property 14: La redacción es no filtrante e idempotente**.
    - Generate synthetic secrets, URLs with credentials, PEM values, nested events/previews, and false-positive controls; assert no original secret remains and repeated redaction is equivalent.
    - **Validates: Requirements 7.20–7.21, 11.10**
  - [x]* 6.10 Write the fast-check property test for **Property 23: Eventos locales completos según nivel y modo**.
    - Generate decisions, warnings, changes, and errors with verbose on/off; assert required base fields, optional evidence/compatibility context, unique run IDs, and no semantic loss.
    - **Validates: Requirements 11.1–11.7, 11.11**
  - [x]* 6.11 Write the fast-check property test for **Property 25: Operaciones de red completas y deny-by-default**.
    - Generate candidate operations and approval mutations; assert missing metadata, foreign IDs, stale hashes, or absent approval reject before opening a connection or process.
    - **Validates: Requirements 15.4–15.9**
  - [x]* 6.12 Add unit and integration tests for zero/create/modify/external/conflict plans, global and per-conflict approval, stale plans, path attacks, redaction, local-only sinks, and network denial.
    - **Requirements: 7.1–7.21, 11.1–11.11, 15.3–15.9**

- [x] 7. Implement the recoverable transaction engine and idempotent state
  - [x] 7.1 Implement transaction lock acquisition, persistent write-fsync-rename journals, staging, prepare/verify/commit phases, deterministic operation order, backups, atomic sibling writes, and managed-state persistence.
    - Execute only approved file and external operation IDs; revalidate plan hash, paths, preconditions, schemas, and expected digests before commit.
    - _Requirements: 8.1–8.7, 9.1–9.3, 15.6–15.9_
  - [x] 7.2 Implement inverse rollback, partial-artifact cleanup, journal recovery, terminal-journal handling, active-lock handling, cancellation, and manual-review path tracking.
    - Restore bytes/existence for every affected destination, remove created artifacts, preserve useful evidence on failed recovery, and block new work on non-terminal journals.
    - _Requirements: 5.14–5.15, 8.8–8.16_
  - [x] 7.3 Implement idempotent semantic ownership checks and `ExecutionSummary` construction.
    - Compare real state rather than trusting managed state alone; omit equivalent files, duplicate components, and already-present external operations while reporting applied/skipped/warnings/errors/recovery accurately.
    - _Requirements: 8.7, 8.11–8.17, 9.1–9.8_
  - [ ]* 7.4 Write the fast-check property test for **Property 15: Aplicación con autorización exacta**.
    - Generate valid approved plans and attempts to inject unplanned, unapproved, duplicate, or foreign operations; assert execution is exactly bounded by approved IDs.
    - **Validates: Requirements 8.1–8.3, 15.6, 15.9**
  - [ ]* 7.5 Write the fast-check property test for **Property 16: Rollback restaura el modelo anterior**.
    - Generate finite create/modify sequences and failures at prepare/backup/write/rename/verify/cleanup; assert inverse rollback restores bytes/existence, removes partials, preserves unrelated paths, and maps codes 1/3 correctly.
    - **Validates: Requirements 8.8–8.10, 8.13–8.16**
  - [ ]* 7.6 Write the fast-check property test for **Property 17: El resumen conserva todos los resultados**.
    - Generate receipts, omissions, warnings, and errors and assert exact category preservation, session run ID inclusion, and no fabricated entries.
    - **Validates: Requirements 8.17, 11.11**
  - [ ]* 7.7 Write the fast-check property test for **Property 18: Reaplicar el estado deseado es un punto fijo**.
    - Generate at least 100 projects per run, apply once, re-plan on equivalent state, and assert zero create/modify/install operations, unchanged state, and zero-change summary.
    - **Validates: Requirements 9.1–9.3, 9.8, 13.7**
  - [ ]* 7.8 Add fault-injection integration tests for every transaction phase, successful/failed recovery, Ctrl+C before and during application, stale concurrent changes, non-terminal journals, and exit-code summaries.
    - **Requirements: 8.1–8.17, 13.15**

- [x] 8. Wire the interactive CLI and session orchestrator
  - [x] 8.1 Implement flag parsing for `--path`, `--mode auto|manual`, `--verbose`, and `--recover`, TTY checks, prompts, plan previews, approval prompts, cancellation handling, and human-readable summaries.
    - Render canonical paths, actions, reasons, conflicts, external command/origin/destination/purpose/network, redacted previews, and all exit states without direct I/O outside adapters.
    - _Requirements: 1.1, 3.6–3.9, 4.1–4.12, 7.3–7.21, 8.11–8.17, 11.1–11.11_
  - [x] 8.2 Implement `SessionOrchestrator` as the designed state machine: recovery gate, project validation, analysis, authorized catalog query, stack resolution, mode selection, component selection, plan/approval, application, rollback, and summary.
    - Ensure empty selections never create a plan or request approval, cancellation before prepare returns code 0, and invalid input returns code 2 without mutation.
    - _Requirements: 1.7–1.16, 2.7–2.16, 4.1–4.12, 5.1–5.15, 7.1–7.19, 8.1–8.17_
  - [x] 8.3 Wire every adapter through dependency injection and connect the package bin to the orchestrator while preserving the domain/application/infrastructure dependency direction.
    - Verify no AWS, backend, hooks, telemetry, arbitrary shell, recommended-CLI execution, or MCP startup path is reachable from the MVP runtime.
    - _Requirements: 13.1, 14.17–14.19, 15.1–15.16_
  - [ ]* 8.4 Add scripted integration tests for automatic and manual flows, recommendation removal, zero selection, invalid mode, stack conflict/no-stack fallback, new/existing projects, approval, cancellation, and incompatible overrides.
    - **Requirements: 1.10–1.16, 2.12–2.16, 4.1–4.12, 13.11–13.13**
  - [ ]* 8.5 Add integration tests for global/conflict approvals, preserve/replace, concurrent change rejection, approved/unapproved network operations, local-only scope, and absence of AWS/backend/hooks calls.
    - **Requirements: 7.11–7.21, 13.14–13.16, 15.1–15.16**
  - [ ]* 8.6 Add packaging smoke tests that run `npm pack`, install the tarball in a sandbox, and execute the bin through `npx --no-install`, checking ESM, shebang, TTY behavior, and exit-code mapping.
    - **Requirements: 1.1, 13.17–13.19**

- [ ] 9. Add performance, quality gates, traceability checks, and executable release validation
  - [ ] 9.1 Implement the versioned benchmark harness and fixture generator/loader for up to 10,000 files and 500 MB outside exclusions.
    - Record CPU/memory/storage profile, Node/OS, commit, cold/warm cache, command, 10 runs, p50/p90/max, monotonic scan-to-stack time, and RSS; keep the controlled performance gate out of unstable PR runs.
    - _Requirements: 12.1–12.3, 12.8–12.11_
  - [ ] 9.2 Add package scripts and continuous-integration configuration for format, lint/static analysis, strict typecheck, unit/integration/property tests, coverage thresholds (lines/functions/branches ≥80%), build, pack, and smoke validation.
    - Fail the job on any nonzero command or unmet threshold; configure deterministic seeds and preserve fast-check counterexample paths.
    - _Requirements: 13.1–13.4, 13.7–13.19_
  - [ ] 9.3 Implement an SDD traceability validator that checks requirement IDs referenced by tasks, properties, and tests exist and that every requirement has a designated property, unit, integration, smoke, or executable-validation check.
    - Emit actionable failures while keeping the validator itself local and deterministic.
    - _Requirements: 13.20, 14.3, 14.6_
  - [ ]* 9.4 Add final end-to-end executable validation for the public-flow fixture: path selection, stack view, mode selection, plan preview, approval, summary, no network except an approved Skill operation, and no future-scope dependency.
    - **Requirements: 14.4–14.19, 15.10–15.16**

## Checkpoints

- [ ] 10. Checkpoint - Ensure the foundation, project scan, recommendation, catalog, component, planning, and transaction tests pass before final CLI wiring.
  - Ensure all tests pass, type checking is clean, and ask the user if questions arise.
- [ ] 11. Final checkpoint - Ensure all tests, coverage thresholds, build, package smoke test, traceability validation, and executable-flow validation pass.
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and may be skipped for a faster MVP; core implementation and wiring tasks are not optional.
- Every property task uses one fast-check test with `numRuns: 100` and the exact design comment format `// Feature: auto-ai-setup, Property N: ...`. Properties 18–21 must explicitly satisfy the 100-project/model generation requirements.
- Property 5 in the design describes isolated CLI availability probes, while Requirements 3.10–3.11 explicitly prohibit checking or executing recommended CLIs. The plan keeps recommendation generation probe-free and isolates Property 5 behind an unused allowlisted adapter; reconcile the design before enabling that adapter.
- Documentation-only activities such as writing public README prose, recording/publishing videos, and publishing links are intentionally not task items because this workflow permits only writing, modifying, or testing code. The executable validation and package/CI tasks provide the code-side checks for those deliverables.
- AWS Bedrock, the serverless backend, security hooks, remote telemetry, arbitrary shell commands, direct Skill downloads, lifecycle scripts, automatic recommended-CLI installation, and MCP server execution must remain absent from the implementation.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "2.2", "3.1", "4.1", "5.1", "6.1", "6.4", "6.5", "9.1"] },
    { "id": 2, "tasks": ["2.3", "3.2", "3.3", "4.2", "5.2", "5.3", "5.4", "6.2", "6.3", "9.2", "9.3"] },
    { "id": 3, "tasks": ["2.4", "2.5", "2.6", "2.7", "2.8", "3.4", "3.5", "3.6", "3.7", "4.3", "5.5", "5.6", "5.7", "5.8", "5.9", "6.6", "6.7", "6.8", "6.9", "6.10", "6.11", "7.1"] },
    { "id": 4, "tasks": ["2.9", "3.8", "4.4", "5.10", "6.12", "7.2", "7.3"] },
    { "id": 5, "tasks": ["7.4", "7.5", "7.6", "7.7", "8.1"] },
    { "id": 6, "tasks": ["7.8", "8.2"] },
    { "id": 7, "tasks": ["8.3"] },
    { "id": 8, "tasks": ["8.4", "8.5", "8.6"] },
    { "id": 9, "tasks": ["9.4"] }
  ]
}
```
