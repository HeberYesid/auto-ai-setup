# Implementation Plan: Modern TUI Interface

## Overview

Implement the modern terminal presentation as a strict TypeScript, Node.js 22+, ESM extension of the existing hexagonal CLI. Build deterministic pure domain policies and reducers first, then adapters and orchestration, and finally wire the feature into the unchanged CLI contracts. Use typed `Result` errors, injected ports, redaction-before-sink, containment checks, canonical plan hashes, and transactional/recoverable effects throughout. Repository validation uses only the existing pnpm scripts, Vitest, and fast-check.

## Tasks

- [x] 1. Establish TUI domain contracts and injectable boundaries
  - [x] 1.1 Create immutable TUI models and typed results
    - Add strict discriminated unions and branded value types for terminal capabilities, invocation/presentation modes, render profiles, controls, focus, session state, events, commands, progress, failures, recovery, summaries, plan views, frames, and downgrade reasons under `src/domain/tui/`.
    - Represent unknown capabilities and invalid values explicitly; keep all domain models independent of Node, terminal, filesystem, process, network, environment, and clock APIs.
    - Return classified typed `Result` failures at domain/application boundaries instead of throwing unclassified exceptions.
    - _Requirements: 1.1, 1.3, 2.2, 5.2, 5.8, 9.9_

  - [x] 1.2 Define inward-facing application and effect ports
    - Extend application contracts for terminal input/output, clock, filesystem, allowlisted process, approved network, and local event effects, plus typed capability probing and terminal restoration.
    - Keep dependency direction `cli -> application -> domain`; infrastructure implements ports and no domain module imports adapters.
    - Model command execution separately from reducers and rendering so key handling can never mutate projects directly.
    - _Requirements: 6.13, 9.9, 9.10, 10.7, 10.9_

  - [ ]* 1.3 Add deterministic fake resources and contract tests
    - Add typed fakes under `tests/support/` for all six external effects and the local event sink, with explicit available/unavailable modes and captured calls.
    - Verify an unavailable fake returns a controlled typed error and never falls through to a real terminal, filesystem, process, network, environment, or clock.
    - _Requirements: 9.9, 9.10_

- [x] 2. Implement capability detection and conservative presentation selection
  - [x] 2.1 Implement the pure compatibility policy
    - Map invocation context and capability snapshots to `non-interactive`, `full-visual`, `degraded`, or `linear-text` profiles using deterministic pure functions.
    - Treat unknown/invalid values conservatively, honor non-empty `NO_COLOR`, qualify exactly 80x24 as full mode, and expose only supported ANSI, color, Unicode, animation, mouse, and symbol resources.
    - Preserve essential content requirements as profile invariants and include typed downgrade reasons.
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.11, 3.8, 4.3_
  - [x] 2.2 Implement the Node terminal capability and input adapter
    - Extend `src/cli/terminal.ts` and add focused `src/cli/tui/` adapters to probe both TTY streams, ANSI cursor support, color, Unicode, dimensions, mouse support, animation preference, and `NO_COLOR` before first output.
    - Normalize platform input into closed `UiEvent` variants, subscribe to resize, enter raw mode only for eligible interactive profiles, and make cleanup idempotent on completion, cancellation, interruption, and controlled failure.
    - Never expose raw escape sequences to reducers or emit unsupported controls.
    - _Requirements: 1.1, 1.4, 1.8, 1.9, 2.14, 2.15, 7.5, 8.10_

  - [ ]* 2.3 Write the property test for conservative capability selection
    - **Property 1: Capability policy is conservative and complete**
    - Generate the compatibility matrix, unknowns, invalid dimensions, `NO_COLOR`, and 80x24 boundaries in a dedicated fast-check file with at least 100 deterministic cases.
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.11, 9.3**

  - [ ]* 2.4 Write capability adapter and compatibility integration tests
    - Verify exact 80x24 selection, ASCII/color fallbacks, redirected streams, no unsupported ANSI, normalized keyboard/mouse events, and idempotent terminal restoration across completion, cancellation, and errors.
    - Exercise Windows Terminal/PowerShell, macOS Terminal, and Linux/xterm capability families with injected streams only.
    - _Requirements: 1.8, 1.10, 2.15, 4.3, 7.5, 9.3_

- [x] 3. Build the deterministic interactive session reducer
  - [x] 3.1 Implement session state, event, and command reduction
    - Add the pure `InteractiveSession` reducer with all named state fields, one-event/one-action semantics, closed registered actions, cancellation/finalization states, and exact prior-state return for invalid events.
    - Separate returned application commands from state transitions; reject arbitrary command strings and emit no mutation/process/network command from invalid UI actions.
    - Lock task inputs and results while application work is pending while permitting only explicitly registered status, help, or cancellation actions.
    - _Requirements: 2.5, 2.6, 2.9, 2.14, 8.7, 9.2, 9.6_

  - [x] 3.2 Implement focus, navigation, scrolling, and validation reducers
    - Derive visible enabled controls in documented top-to-bottom/left-to-right order; implement circular Tab/Shift+Tab, focus restoration/fallback, exactly one valid focus, and absent focus when no control is enabled.
    - Compute minimal bounded scrolling and reset it to zero when content fits.
    - Preserve invalid/restored input, enumerate all violated rules without duplication, and disable only advance actions while validation is invalid or pending.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.7, 2.8, 2.10, 2.11, 2.12, 2.13, 4.8, 4.10_

  - [x] 3.3 Implement safe resize and presentation transitions
    - Recompute compatible profiles without rebuilding session state and preserve every named field, including approvals, results, scroll, unconfirmed inputs, and validation.
    - If representation is impossible, retain the current mode, identify the non-preservable element, expose registered recovery controls, and suppress newly unsupported control sequences.
    - _Requirements: 1.9, 8.8, 8.9, 8.10, 9.4_
  - [ ]* 3.4 Write the property test for presentation-state preservation
    - **Property 2: Presentation transitions preserve session state**
    - **Validates: Requirements 1.9, 8.8, 9.4**

  - [ ]* 3.5 Write the property test for circular navigation and focus
    - **Property 3: Navigation is circular and focus remains valid**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.7, 2.8, 9.5**

  - [ ]* 3.6 Write the property test for exactly-once activation
    - **Property 4: Focused activation and toggling are exactly once**
    - **Validates: Requirements 2.5, 2.6**

  - [ ]* 3.7 Write the property test for invalid-action immutability
    - **Property 5: Invalid actions are immutable**
    - **Validates: Requirements 2.9, 9.6**

  - [ ]* 3.8 Write the property test for validation gating
    - **Property 6: Validation preserves input and gates advancement**
    - **Validates: Requirements 2.12, 2.13, 4.8, 4.10**

  - [ ]* 3.9 Write the property test for viewport scrolling
    - **Property 7: Viewport scrolling is minimal and bounded**
    - **Validates: Requirements 2.10, 2.11**

  - [ ]* 3.10 Write the property test for pending-work locking
    - **Property 20: Pending work locks unsafe session edits**
    - **Validates: Requirements 8.7**

  - [ ]* 3.11 Write the property test for replay determinism
    - **Property 21: Reducers and view models are replay-deterministic**
    - Generate sequences of 1 to 100 normalized events and compare deep-equal state and command replays.
    - **Validates: Requirements 9.1, 9.2**

  - [ ]* 3.12 Write reducer example tests for keyboard, mouse, help, and cancellation
    - Verify Enter and Space examples, optional mouse equivalence, `?` behavior, invalid keys, focus fallback, no-control views, and pre-mutation cancellation defaulting to continuation.
    - Confirm accepted cancellation returns the existing cancellation exit code and preserves equivalent project state.
    - _Requirements: 2.5, 2.6, 2.14, 2.15, 2.16, 2.17, 4.9_

- [x] 4. Implement redacted view models, layout, and rendering
  - [x] 4.1 Build the redaction-first presentation projection
    - Project `SessionState` into an immutable redacted `PresentationState` and semantic `ViewModel` before terminal or local-event sinks can observe values.
    - Include brand, current stage, applicable enabled primary action, controls, labels, values, help, activity, plan, recovery, and summary in deterministic flow order.
    - Fail closed with typed errors when redaction cannot complete; do not provide an unredacted fallback.
    - _Requirements: 3.2, 4.1, 4.7, 5.7, 6.7, 9.7, 10.11_

  - [x] 4.2 Implement deterministic layout and render-mode projections
    - Add pure wrapping, path truncation indicators, semantic ordering, ASCII substitutions, degraded compaction, linear sequential output, and bounded viewport/window calculations.
    - Ensure full, degraded, and linear projections retain essential hierarchy, labels, values, and actions while removing only unsupported adornments.
    - _Requirements: 3.4, 3.5, 3.8, 3.10, 4.6, 9.1, 9.3_
  - [x] 4.3 Implement frame generation and safe delta rendering
    - Generate semantic frames and minimal safe deltas whose completed terminal content contains only the current model; regenerate complete changed regions and preserve unchanged region characters/positions.
    - Keep ANSI emission in the output adapter, enforce profile permissions, and make linear output append-only with no clear/reposition/animation sequences.
    - _Requirements: 1.4, 3.6, 8.6, 8.10_

  - [x] 4.4 Implement the original visual system and accessibility semantics
    - Define original `auto-ai-setup` text/symbol identity, stable labels for equivalent actions, and non-color markers for title, primary/secondary text, selection, focus, warning, error, and success.
    - Emit exact `ÉXITO`, `ADVERTENCIA`, and `ERROR` labels; keep activity and input labels visible; implement non-disruptive contextual help and static no-animation status.
    - Do not reproduce external names, logos, wording, palettes, layouts, or recognizable identity.
    - _Requirements: 3.1, 3.2, 3.3, 3.7, 3.9, 4.1, 4.2, 4.4, 4.5, 4.7, 4.9_

  - [ ]* 4.5 Write the property test for deterministic bounded layout
    - **Property 8: Layout is deterministic and preserves semantic order**
    - **Validates: Requirements 3.4, 3.5, 9.1**

  - [ ]* 4.6 Write the property test for fallback meaning preservation
    - **Property 9: Fallback projection preserves essential meaning**
    - **Validates: Requirements 3.2, 3.8, 3.10, 4.6, 9.3**

  - [ ]* 4.7 Write the property test for color-independent semantics
    - **Property 10: Semantic states remain distinguishable without color**
    - **Validates: Requirements 3.1, 4.1, 4.2, 4.3**

  - [ ]* 4.8 Write the property test for accessible activity and help
    - **Property 11: Activity and help are accessible and non-disruptive**
    - **Validates: Requirements 4.4, 4.5, 4.7, 4.9**

  - [ ]* 4.9 Write the property test for pre-presentation redaction
    - **Property 14: Redaction is complete before presentation**
    - Generate secrets in keys, values, paths, errors, progress, plans, and results; assert absence from view models and captured terminal/event writes.
    - **Validates: Requirements 5.7, 6.7, 9.7**

  - [ ]* 4.10 Write the property test for stale-region elimination
    - **Property 19: Deterministic rendering has no stale regions**
    - **Validates: Requirements 3.6, 8.6**

  - [ ]* 4.11 Write semantic snapshot and visual-contract tests
    - Snapshot semantic view models and linear output for color/Unicode/animation variants, keeping ANSI fixtures separate.
    - Assert exact state labels, stable equivalent action labels, distinct markers, essential content, and absence of external product branding.
    - _Requirements: 3.3, 3.7, 3.9, 4.3, 4.6_

- [x] 5. Implement progress, failure, recovery, and final-summary presentation
  - [x] 5.1 Implement pure progress and activity state handling
    - Validate non-negative integer determined progress, monotonic completion, `completed <= total`, floor percentage, and the `0/0 -> 0%` rule.
    - Retain the last valid model and report violated rules for invalid updates; omit counts/percentages for indeterminate progress.
    - Use injected time to expose persistent textual activity after one second without wall-clock sleeps.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 8.4_
  - [x] 5.2 Implement typed failure, recovery, and summary projections
    - Preserve named session fields on operation failure and show stage, operation, redacted readable cause, and exactly registered recovery controls with enabled state.
    - Gate final summary after mutation failure until a visible recovery result exists; include status, changes, omissions, recovery, exit code, errors, and warnings.
    - Canonicalize and deduplicate unresolved project-relative paths so each appears exactly once.
    - _Requirements: 5.8, 5.9, 5.10, 5.11, 5.12_

  - [ ]* 5.3 Write the property test for valid determined progress
    - **Property 12: Determined progress is valid, monotonic, and correctly calculated**
    - **Validates: Requirements 5.2, 5.3, 5.4**

  - [ ]* 5.4 Write the property test for invalid and indeterminate progress
    - **Property 13: Invalid progress does not corrupt the last valid state**
    - **Validates: Requirements 5.5, 5.6**

  - [ ]* 5.5 Write the property test for actionable failure projection
    - **Property 15: Failure projection is registered and actionable**
    - **Validates: Requirements 5.8, 5.9**

  - [ ]* 5.6 Write the property test for complete exact-once summaries
    - **Property 16: Recovery summary is complete and exact-once**
    - **Validates: Requirements 5.11, 5.12**

  - [ ]* 5.7 Write progress and recovery boundary example tests
    - Test `0/0`, invalid regressions, indeterminate output, the one-second activity threshold, and observations one millisecond before/at/after 100, 250, 300, and 1000ms boundaries using a virtual clock.
    - Verify mutation failures render recovery state before summary and never claim success for an unverified result.
    - _Requirements: 5.1, 5.4, 5.10, 8.1, 8.2, 8.3, 8.4, 9.8_

- [x] 6. Implement deterministic plan review and hash-bound approval
  - [x] 6.1 Build the canonical redacted plan projection
    - Reuse the existing planning domain as source of canonical bytes and SHA-256; project operations in canonical order with plan hash, action, destination, source, reason, conflict, semantic before/after descriptions, and `no aplicable` placeholders.
    - Include only policy-allowed external operations with exact command, all arguments, purpose, and network-use metadata; redact project values before projection.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x] 6.2 Implement explicit approval state and coordinator
    - Default to rejection and bind every decision to the displayed hash; discard conflicting decisions and invalidate approval on stale/current hash mismatch.
    - Emit an apply command only for a fresh, unambiguous approval of the current canonical hash, including a new request after rejection.
    - _Requirements: 6.8, 6.9, 6.10, 6.11, 6.12, 6.13, 6.17, 7.7, 7.10_

  - [x] 6.3 Enforce approval again at the effect boundary
    - Recalculate/verify the canonical hash immediately before filesystem, process, or network effects and apply exactly the approved canonical operations.
    - Return typed stale/conflicted/rejected errors without starting any effect and preserve equivalent project state.
    - _Requirements: 6.9, 6.10, 6.11, 6.13, 7.7, 7.10_
  - [ ]* 6.4 Write the property test for canonical plan stability
    - **Property 17: Canonical plans and projections are stable**
    - **Validates: Requirements 6.1, 6.3, 6.4, 6.5, 6.6**

  - [ ]* 6.5 Write the property test for hash-bound approval
    - **Property 18: Approval is bound to the current plan hash**
    - **Validates: Requirements 6.9, 6.12, 6.13, 6.17**

  - [ ]* 6.6 Write approval and hashing contract examples
    - Verify known canonical SHA-256 vectors, default rejection, conflicting decisions, stale hashes, rejection with no changes, re-approval binding, and exact canonical-operation dispatch.
    - _Requirements: 6.2, 6.8, 6.9, 6.10, 6.11, 6.12, 6.17_

- [x] 7. Preserve configuration and enforce product security boundaries
  - [x] 7.1 Implement managed JSON update preservation
    - Extend pure configuration merging only as needed so managed updates preserve unknown fields, unrelated array order, duplicate multiplicity, formatting where practical, and user-owned content while changing only owned values.
    - Keep JSON as the only structured configuration format written by the feature.
    - _Requirements: 10.6_

  - [x] 7.2 Enforce lexical and real containment before effects
    - Reuse/extend path policy to reject traversal, absolute/device paths, NUL, and symlink escapes with typed security errors before process or mutation calls.
    - Require both lexical and real containment within the target project for every planned target and recoverable write.
    - _Requirements: 10.7, 10.8, 10.10_

  - [x] 7.3 Enforce allowlisted autoskills, network, and prohibited-operation policy
    - Admit only explicitly approved official `npx autoskills` operations for the current hash; open network only for that operation and close it afterward.
    - Reject recommended CLI execution, MCP server execution, arbitrary shell commands, lifecycle scripts, telemetry, remote event transmission, direct Skill downloads, and alternate installation fallbacks before plan insertion and before effects.
    - Keep recommended CLIs and MCP servers descriptive/configurational only and return registered safe recovery controls on autoskills failure.
    - _Requirements: 6.14, 6.15, 10.5, 10.9, 10.10, 10.11, 10.12, 10.13_

  - [ ]* 7.4 Write the property test for preserving managed configuration
    - **Property 22: Managed configuration updates preserve user data**
    - **Validates: Requirements 10.6**

  - [ ]* 7.5 Write the property test for hostile lexical paths
    - **Property 23: Hostile lexical paths are rejected before effects**
    - **Validates: Requirements 10.8, 10.10**

  - [ ]* 7.6 Write containment and product-boundary integration tests
    - Verify lexical and real/symlink containment fails before captured process/mutation calls, and all prohibited operations produce controlled typed errors.
    - Verify autoskills is the sole process/network path, network scope is hash-bound, failures trigger no direct download/fallback, and local events are redacted with no remote transmission.
    - _Requirements: 6.14, 6.15, 10.5, 10.7, 10.8, 10.9, 10.10, 10.11, 10.12, 10.13_

- [x] 8. Coordinate interactive effects and recoverable application flow
  - [x] 8.1 Implement the interactive application coordinator
    - Add `src/application/session/interactive-session.ts` to run reducer commands through injected ports, normalize typed results back into events, serialize pending work, and keep rendering separate from effects.
    - Preserve existing inspect/select/review/approve/apply/recover/summary stages and decisions without adding domain capabilities.
    - _Requirements: 2.9, 5.8, 8.7, 9.9, 10.1, 10.2_
  - [x] 8.2 Implement the interactive terminal loop and output sink
    - Wire normalized key/mouse/resize/activity/external-result/timer events to reduction, command coordination, redacted projection, frame rendering, writes, and guaranteed cleanup.
    - Handle write failures and interruption through the existing controlled error contract without retries that can mutate state or leak secrets.
    - _Requirements: 1.10, 2.14, 5.7, 8.4, 8.6, 9.7, 10.11_

  - [x] 8.3 Integrate transactional application and recovery lifecycle
    - Connect approved apply commands to existing staging, backups, persistent journal, verification, atomic rename/fsync, rollback, and local recovery ports.
    - Convert transaction lifecycle events into progress/recovery views; prevent summary until recovery is visible and preserve existing exit semantics.
    - _Requirements: 5.10, 5.11, 6.16, 10.7_

  - [ ]* 8.4 Write interactive journey and event-ordering integration tests
    - Exercise keyboard-only inspect, select, edit, review, reject/approve, apply, cancel, recover, and summarize journeys with injected terminal and clock fakes.
    - Cover resize/progress ordering during asynchronous work, compatibility-family completion/cancellation/controlled-error outcomes, and terminal restoration.
    - _Requirements: 1.10, 2.14, 2.16, 2.17, 8.7, 8.8, 8.9, 9.10_

  - [ ]* 8.5 Write transaction failure and recovery integration tests
    - Assert transaction traces include stage/copy, journal, verify, atomic application, rollback, and recovery; recovery appears before summary and unresolved paths are exact-once.
    - Verify failures preserve session state and never apply operations outside the approved canonical plan.
    - _Requirements: 5.8, 5.10, 5.11, 5.12, 6.10, 6.16, 10.7_

- [x] 9. Preserve non-interactive, JSON, and existing CLI contracts
  - [x] 9.1 Route invocation modes before TUI construction
    - Update CLI composition so explicit non-interactive/JSON modes, redirected stdin/stdout, or missing automation input bypass all interactive controls and preserve existing syntax, options, stages, semantics, outputs, and exit codes.
    - Missing non-interactive input must fail without waiting and without changing project state.
    - _Requirements: 1.8, 7.1, 7.4, 7.5, 7.6, 10.1, 10.2_

  - [x] 9.2 Implement atomic redacted JSON output preparation
    - Build, redact, schema-validate, and serialize exactly one existing-contract JSON value in memory before writing its first stdout byte.
    - Emit no ANSI, frames, animation, or prompts; on redaction/preparation failure write zero stdout bytes and return the existing controlled error code.
    - _Requirements: 7.2, 7.3, 7.8, 7.9_

  - [ ]* 9.3 Write non-interactive and JSON compatibility integration tests
    - Use existing CLI fixtures to assert exact parsing, output/schema semantics, exit codes, redirected-stream behavior, missing-input nonblocking failure, and hash-matched approval gating.
    - Assert JSON success is one redacted value and JSON preparation failure writes zero stdout bytes; confirm no TUI adapter/control is instantiated.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 10.1_

- [x] 10. Meet bounded rendering and responsiveness requirements
  - [x] 10.1 Add bounded layout, windowed plan rendering, and timing instrumentation
    - Window plans up to 1,000 visible operations and avoid rebuilding unchanged semantic regions while preserving canonical order and focus/scroll behavior.
    - Instrument first-view, navigation, resize, and activity-update milestones through injected monotonic time without adding telemetry or remote sinks.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 10.11_
  - [ ]* 10.2 Write deterministic performance and boundary tests
    - With fixed local fixtures and injected/virtual time where applicable, verify first view <=300ms, navigation <=100ms, resize <=250ms, activity confirmation every <=1000ms, and 1,000-operation navigation <=100ms.
    - Observe each threshold one millisecond before, exactly at, and one millisecond after; keep functional and host-sensitive performance reporting distinct.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 9.8_

- [x] 11. Wire the feature and validate repository-level contracts
  - [x] 11.1 Compose exports and the existing CLI entry point
    - Wire domain, application, CLI, and infrastructure adapters through composition roots and barrel exports only after component contracts are stable.
    - Preserve strict TypeScript, Node.js 22+, ESM, the portable shebang, `package.json#bin`, zero runtime dependencies unless separately justified/pinned, and existing `npx auto-ai-setup`/`npx autoskills` public contracts.
    - _Requirements: 10.1, 10.2, 10.3, 10.5_

  - [ ]* 11.2 Write full fake-port and product-boundary integration tests
    - Wire all six effects and the local event sink entirely with fakes; verify unavailable resources fail closed without real fallthrough.
    - Verify matching approval applies exactly canonical operations, mismatched approval applies none, autoskills network scope closes after use, recommended CLIs/MCP remain descriptive, and no prohibited execution path exists.
    - _Requirements: 6.10, 6.13, 6.14, 9.9, 9.10, 10.5, 10.9, 10.10, 10.12, 10.13_

  - [ ]* 11.3 Extend automated smoke, package, and traceability checks
    - Use the actual package scripts and pnpm-only commands to validate formatting, lint, strict typecheck, unit/integration/property suites, coverage, build to `dist/`, package contents, portable CLI startup, and requirements traceability.
    - Add an automated repository check that contributor workflow commands use pnpm only; do not invoke public services or watch mode.
    - _Requirements: 9.8, 10.1, 10.3, 10.4_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP; all unstarred implementation tasks are required.
- Every property task uses Vitest plus the pinned fast-check setup, at least 100 deterministic cases, and the comment `Feature: modern-tui-interface, Property N: <property text>`.
- Property tests use a dedicated file per numbered property to avoid execution-wave write conflicts; shared barrel/export edits are deferred to task 11.1.
- Use only the existing pnpm scripts as repository command sources of truth; do not add npm/yarn repository commands or watch-mode commands.
- Tests use injected fakes and no real TTY, public network, arbitrary process, wall-clock sleep, or real project mutation.
- No task broadens the product: recommended CLIs/MCP servers remain descriptive, autoskills is the only approved process/network route, secrets are redacted before sinks, and writes remain contained, transactional, and recoverable.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1", "5.1", "6.1", "7.1", "7.2"] },
    { "id": 2, "tasks": ["1.3", "2.2", "3.2", "4.2", "5.2", "6.2", "7.3", "7.4", "7.5"] },
    { "id": 3, "tasks": ["2.3", "2.4", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8", "3.9", "4.3", "4.4", "4.5", "4.6", "4.7", "4.8", "4.9", "5.3", "5.4", "5.5", "5.6", "6.3", "6.4", "6.5", "6.6", "7.6"] },
    { "id": 4, "tasks": ["3.10", "3.11", "3.12", "4.10", "4.11", "5.7", "8.1", "9.1"] },
    { "id": 5, "tasks": ["8.2", "8.3", "9.2", "10.1"] },
    { "id": 6, "tasks": ["11.1"] },
    { "id": 7, "tasks": ["8.4", "8.5", "9.3", "10.2", "11.2"] },
    { "id": 8, "tasks": ["11.3"] }
  ]
}
```
