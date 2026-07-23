# Scope Amendment: autoskills as an Independent TUI

Status: normative for the MVP. This amendment supersedes every statement in `requirements.md`, `design.md`, and `tasks.md` that places Skill inventory or installation inside the `auto-ai-setup` plan, transaction, rollback, ownership, or idempotency model.

## Decision

`auto-ai-setup` may offer to launch the official `npx autoskills` interactive TUI. The TUI is an optional, independently authorized external process. It owns its own Skill discovery, selection, installation, output, errors, and resulting files.

The local configuration flow of `auto-ai-setup` remains separate. Its deterministic plan, approvals, transaction journal, rollback, recovery, and idempotency guarantees cover only changes proposed and written by `auto-ai-setup` itself.

## User flow

1. Analyze the local project and show the detected Stack.
2. Offer to open the official `npx autoskills` TUI.
3. Before launching it, show the exact command, that it may use the network, that it may modify files, and that its changes are outside the `auto-ai-setup` plan and rollback.
4. Launch it only after explicit confirmation.
5. Pause `auto-ai-setup` terminal input while the TUI runs and resume it when the process exits.
6. Report whether the TUI was cancelled, completed, or failed; do not claim which Skills were installed.
7. Continue with the local automatic/manual selection for MCP configuration, agent rules, and agent commands.
8. Build and approve a deterministic plan only for those local changes.

## Normative boundaries

- The only Skill process allowed is the registered official `npx autoskills` interactive invocation.
- No command, argument, repository, URL, or script supplied by a user or catalog may be executed.
- Refusing authorization must not start a process or open a network connection.
- A TUI failure becomes a clear warning and must not prevent configuration types unrelated to Skills from being offered.
- Skill entries are not parsed, recommended, selected, installed, verified, recorded as owned, or included in a `ChangePlan` by `auto-ai-setup`.
- Skill files are not staged, committed, rolled back, recovered, deduplicated, or declared idempotent by `auto-ai-setup`.
- The execution summary records only the TUI process outcome, not inferred installation results.
- Output rendered directly by the external TUI is outside the local event redactor. The user must be warned before launch.
- The `auto-ai-setup` transaction must never delete or overwrite files merely because they may have been created by the TUI.

## Replacement acceptance criteria for Requirement 5

1. The CLI offers the official `npx autoskills` TUI as an optional independent step.
2. Before launch, it displays the command, purpose, possible network use, possible file changes, and lack of transactional rollback.
3. It requires explicit confirmation immediately before launching the process.
4. Rejection or cancellation launches no process and opens no connection.
5. Only the fixed registered invocation is accepted; arbitrary arguments and commands are rejected.
6. The CLI pauses its own terminal input while the TUI is active.
7. The CLI resumes its terminal input after the TUI exits.
8. The CLI does not parse or present a Skill catalog of its own.
9. Skill selection and installation remain entirely inside the official TUI.
10. Skill effects are excluded from the local `ChangePlan` and its approvals.
11. Skill effects are excluded from journal, rollback, recovery, ownership, and idempotency guarantees.
12. On successful exit, the CLI reports only that the external TUI completed.
13. On failure, the CLI reports a readable warning without claiming recovery of TUI changes.
14. After cancellation, success, or failure, unrelated local component types remain available.
15. The CLI never downloads Skill files directly or invokes package lifecycle scripts on their behalf.

## Consequences for other requirements

- Requirement 7 planning guarantees apply to mutations and external operations owned by `auto-ai-setup`; the separately authorized TUI is explicitly excluded.
- Requirement 8 recovery applies only to the local `auto-ai-setup` transaction.
- Requirement 9 idempotency excludes Skill state managed by the external TUI.
- Requirement 11 redaction covers `auto-ai-setup` events; direct TUI output remains under the external process.
- Requirement 15 network-plan approval is replaced for the TUI by a dedicated pre-launch authorization showing command, purpose, network use, and transactional boundary.

## Updated implementation priorities

1. Add the complete boundary warning before launch and test rejection/no-process behavior.
2. Remove dead catalog/list/install/ownership paths that imply transactional Skill support.
3. Keep one minimal allowlisted interactive process adapter with cancellation and clear exit classification.
4. Ensure the local component inventory and plan exclude Skills.
5. Update summaries, tests, traceability, README, and diagrams to describe the two independent flows.

## Explicitly deferred

A future version may bring Skills into the deterministic plan only if the official external tool exposes a stable, non-interactive, verifiable, staging-safe installation interface. That future capability requires a new design and is not implied by this MVP.