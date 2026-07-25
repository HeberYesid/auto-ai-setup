/**
 * Transactional application and recovery lifecycle, projected into presentation state.
 *
 * The transaction engine already owns staging, backups, the persistent journal, verification, atomic
 * rename/fsync, rollback, and local recovery. This module adds no new mutation capability: it maps the
 * engine's lifecycle phases onto determined progress and maps its results onto recovery state and the
 * final summary, preserving the existing exit semantics.
 *
 * The ordering rule enforced here is that a failed mutation never reaches a final summary until a
 * recovery result is visible.
 */

import type { ExecutionSummary } from "../../domain/observability/models.js";
import type { RecoveryResult, TransactionResult } from "../../domain/shared/ports.js";
import type { RunId } from "../../domain/shared/types.js";
import { canonicalizeRecoveryPaths, hasVisibleRecoveryResult, type RecoveryState } from "../../domain/tui/recovery.js";
import type { ProgressInput } from "../../domain/tui/progress.js";
import type { TuiResult } from "../../domain/tui/errors.js";

/** The observable phases of the transactional lifecycle, in execution order. */
export const TRANSACTION_PHASES = ["stage", "journal", "verify", "commit", "rollback", "recover"] as const;

export type TransactionPhase = (typeof TRANSACTION_PHASES)[number];

/** Human-readable, secret-free description of each phase. */
export const PHASE_DESCRIPTIONS: Readonly<Record<TransactionPhase, string>> = {
  stage: "Preparando copias de trabajo",
  journal: "Registrando el diario de recuperación",
  verify: "Verificando el contenido preparado",
  commit: "Aplicando cambios de forma atómica",
  rollback: "Revirtiendo cambios aplicados",
  recover: "Recuperando una transacción interrumpida",
};

/** One lifecycle observation reported by the transaction engine. */
export interface TransactionLifecycleEvent {
  readonly phase: TransactionPhase;
  readonly completed: number;
  readonly total: number;
}

/** Translate a lifecycle observation into a determined progress update for the activity view. */
export const lifecycleProgress = (event: TransactionLifecycleEvent): ProgressInput => ({
  kind: "determined",
  description: PHASE_DESCRIPTIONS[event.phase],
  completed: event.completed,
  total: event.total,
});

/** Registered recovery controls offered after a failed or partially applied transaction. */
export const transactionRecoveryControls = (result: TransactionResult): RecoveryState["controls"] => {
  if (result.status === "committed") return [];
  const controls: RecoveryState["controls"] = [
    { id: "retry-apply", label: "Reintentar la aplicación", action: "retry", enabled: true },
    { id: "finish-run", label: "Finalizar y revisar manualmente", action: "finish", enabled: true },
  ];
  return result.status === "incomplete"
    ? [{ id: "rollback-apply", label: "Revertir los cambios aplicados", action: "rollback", enabled: true }, ...controls]
    : controls;
};

const recoveryStatus = (result: TransactionResult, recovery: RecoveryResult | undefined): RecoveryState["result"] => {
  if (recovery !== undefined) return recovery.status === "restored" ? "completed" : "partial";
  if (result.status === "committed") return "not-required";
  return result.status === "rolled-back" ? "completed" : "partial";
};

/**
 * Project the transaction outcome into recovery state. Unresolved paths are canonicalized and
 * deduplicated so each appears exactly once; a malformed path fails closed with a typed error rather
 * than being displayed raw.
 */
export const projectTransactionRecovery = (result: TransactionResult, recovery?: RecoveryResult): TuiResult<RecoveryState> => {
  const paths = canonicalizeRecoveryPaths([...result.manualReviewPaths.map(String), ...(recovery?.manualReviewPaths ?? []).map(String)]);
  if (!paths.ok) return paths;
  return {
    ok: true,
    value: {
      result: recoveryStatus(result, recovery),
      controls: transactionRecoveryControls(result),
      unresolvedPaths: paths.value,
    },
  };
};

const summaryStatus = (result: TransactionResult, recovery: RecoveryResult | undefined): ExecutionSummary["status"] => {
  if (result.status === "committed") return "success";
  if (result.status === "rolled-back") return "failed-recovered";
  return recovery?.status === "restored" ? "failed-recovered" : "incomplete";
};

/**
 * Build the execution summary for a completed transaction. The existing exit code from the engine is
 * preserved verbatim; this projection never invents or upgrades a status.
 */
export const projectTransactionSummary = (runId: RunId, result: TransactionResult, recovery?: RecoveryResult): ExecutionSummary => ({
  runId,
  status: summaryStatus(result, recovery),
  exitCode: result.exitCode,
  applied: [...result.applied],
  skipped: [...result.skipped],
  warnings: [...result.warnings],
  errors: [...result.errors, ...(recovery?.errors ?? [])],
  ...(recovery === undefined ? {} : { recovery }),
  manualReviewPaths: [...new Set([...result.manualReviewPaths, ...(recovery?.manualReviewPaths ?? [])])].sort((left, right) =>
    String(left).localeCompare(String(right)),
  ),
});

/**
 * Whether a final summary may be presented yet. After a failed mutation the answer is no until a
 * recovery result exists and is visible, which keeps the run from ever claiming an unverified outcome.
 */
export const summaryIsPresentable = (result: TransactionResult, recovery: RecoveryState | undefined): boolean =>
  result.status === "committed" || hasVisibleRecoveryResult(recovery);
