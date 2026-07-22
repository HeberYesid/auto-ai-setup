import type { ExecutionSummary, RecoveryResult, TransactionResult } from "../../domain/index.js";
import type { RunId } from "../../domain/shared/types.js";

/** Maps the complete transactional result to the public, stable execution summary. */
export const createExecutionSummary = (runId: RunId, result: TransactionResult, recovery?: RecoveryResult): ExecutionSummary => {
  const status: ExecutionSummary["status"] =
    result.status === "committed"
      ? "success"
      : result.status === "rolled-back"
        ? result.exitCode === 0
          ? "cancelled"
          : "failed-recovered"
        : "incomplete";
  return {
    runId,
    status,
    exitCode: result.exitCode,
    applied: [...result.applied],
    skipped: [...result.skipped],
    warnings: [...result.warnings],
    errors: [...result.errors],
    ...(recovery === undefined ? {} : { recovery }),
    manualReviewPaths: [...result.manualReviewPaths],
  };
};

export const executionSummaryFromTransaction = createExecutionSummary;
