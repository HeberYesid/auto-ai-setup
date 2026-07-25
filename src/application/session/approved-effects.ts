/**
 * Effect-boundary approval enforcement for the interactive session.
 *
 * The reducer already binds an approval decision to the displayed plan hash, but a
 * decision alone must never be sufficient to start an effect. This module re-derives
 * the canonical SHA-256 of the plan immediately before any filesystem, process, or
 * network call and refuses to proceed unless the recomputed hash matches both the plan
 * and the approval. A refusal returns a typed stale/conflicted/rejected error and starts
 * no effect at all, so the project is left in an equivalent state.
 */

import { calculatePlanHash } from "../../domain/planning/planner.js";
import { createApprovedPlan } from "../../domain/planning/approval-policy.js";
import type { ApprovalDecisions, ApprovedPlan, ChangePlan, ExternalOperation } from "../../domain/planning/models.js";
import { isAllowedAutoSkillsOperation, autoSkillsPolicyFailure } from "../../domain/security/product-policy.js";
import type { ExternalOperationApproval, ProcessResult, RegisteredProcessRequest } from "../../domain/shared/ports.js";
import { err, ok, type Result, type Sha256 } from "../../domain/shared/types.js";
import { authorizeApproval } from "../../domain/tui/approval.js";
import { tuiError, type TuiError } from "../../domain/tui/errors.js";
import type { ApprovalState } from "../../domain/tui/session.js";
import type { AllowlistedProcessPort, ApprovedNetworkPort, FilesystemPort } from "./effect-ports.js";
import type { RecoveryResult, TransactionResult } from "../../domain/shared/ports.js";

/** Everything needed to re-verify consent for the plan currently displayed. */
export interface ApprovedEffectRequest {
  readonly plan: ChangePlan | undefined;
  readonly displayedHash: Sha256 | undefined;
  readonly approval: ApprovalState;
  /** The per-operation decisions captured during review. */
  readonly decisions: ApprovalDecisions;
}

/** A verified request: the canonical hash was recomputed and matched at this instant. */
export interface VerifiedApproval {
  readonly hash: Sha256;
  readonly approved: ApprovedPlan;
}

const rejected = (message: string): Result<never, TuiError> =>
  err(
    tuiError("APPROVAL_REQUIRED", message, {
      suggestedAction: "Aprobar explícitamente el plan mostrado antes de aplicar cambios",
    }),
  );

const stale = (message: string): Result<never, TuiError> =>
  err(
    tuiError("APPROVAL_STALE", message, {
      suggestedAction: "Revisar el plan actual y solicitar la aprobación de nuevo",
    }),
  );

/**
 * Recompute the canonical hash and verify it against the plan, the displayed hash, and
 * the recorded approval. No effect is started when verification fails.
 */
export const verifyApprovalAtEffectBoundary = (request: ApprovedEffectRequest): Result<VerifiedApproval, TuiError> => {
  const guard = authorizeApproval(request.plan, request.displayedHash, request.approval);
  if (guard.status !== "approved" || request.plan === undefined) {
    const message = guard.error?.message ?? "La aprobación actual no autoriza ningún efecto";
    return guard.status === "stale" ? stale(message) : rejected(message);
  }

  // Recompute independently of the reducer so a mutated plan object cannot slip through.
  const canonicalHash = calculatePlanHash(request.plan);
  if (canonicalHash !== guard.state.hash || canonicalHash !== request.decisions.planHash) {
    return stale("El hash canónico recalculado no coincide con la aprobación registrada");
  }
  if (request.approval.decision === "conflicted") {
    return err(
      tuiError("APPROVAL_CONFLICTED", "Las decisiones de aprobación son ambiguas; no se inicia ningún efecto", {
        suggestedAction: "Enviar una única decisión de aprobación inequívoca",
      }),
    );
  }

  const approved = createApprovedPlan(request.plan, request.decisions);
  if (!approved.ok) return rejected(approved.error.message);
  return ok({ hash: canonicalHash, approved: approved.value });
};

/**
 * Apply exactly the approved canonical operations. The hash is recomputed here, not
 * carried over from the reducer, so a stale or conflicted approval fails before the
 * filesystem port is touched.
 */
export const applyApprovedPlan = async (
  filesystem: FilesystemPort,
  request: ApprovedEffectRequest,
  signal: AbortSignal,
): Promise<Result<TransactionResult, TuiError>> => {
  const verified = verifyApprovalAtEffectBoundary(request);
  if (!verified.ok) return verified;
  return ok(await filesystem.apply(verified.value.approved, signal));
};

/** Recover an interrupted transaction; recovery needs no new approval but keeps typing. */
export const recoverTransaction = async (
  filesystem: FilesystemPort,
  journal: Parameters<FilesystemPort["recover"]>[0],
): Promise<Result<RecoveryResult, TuiError>> => ok(await filesystem.recover(journal));

const operationApproval = (hash: Sha256, operation: ExternalOperation): ExternalOperationApproval => ({
  planHash: hash,
  operationId: String(operation.id),
  approved: true,
});

/**
 * Run an allowlisted autoskills operation. The operation must be part of the approved
 * canonical plan, must satisfy the product policy, and must be listed in the approved
 * external operation ids; anything else fails closed before the process port is called.
 */
export const runApprovedExternalOperation = async (
  process: AllowlistedProcessPort,
  request: ApprovedEffectRequest,
  operation: ExternalOperation,
  processRequest: RegisteredProcessRequest,
  signal?: AbortSignal,
): Promise<Result<ProcessResult, TuiError>> => {
  const verified = verifyApprovalAtEffectBoundary(request);
  if (!verified.ok) return verified;
  if (!isAllowedAutoSkillsOperation(operation)) return rejected(autoSkillsPolicyFailure(operation));
  if (!verified.value.approved.approvedExternalOperationIds.includes(operation.id)) {
    return rejected(`La operación ${String(operation.id)} no está en el plan canónico aprobado`);
  }
  const result = await process.runApproved(processRequest, operationApproval(verified.value.hash, operation), signal);
  return result.ok ? ok(result.value) : rejected(result.error.message);
};

/**
 * Open the approved network scope for a single autoskills operation. Network stays
 * deny-by-default: the request is bound to the recomputed hash and the caller closes the
 * scope as soon as the promise settles.
 */
export const requestApprovedNetwork = async (
  network: ApprovedNetworkPort,
  request: ApprovedEffectRequest,
  operation: ExternalOperation,
  signal?: AbortSignal,
): Promise<Result<Uint8Array, TuiError>> => {
  const verified = verifyApprovalAtEffectBoundary(request);
  if (!verified.ok) return verified;
  if (!isAllowedAutoSkillsOperation(operation)) return rejected(autoSkillsPolicyFailure(operation));
  if (!verified.value.approved.approvedExternalOperationIds.includes(operation.id)) {
    return rejected(`La operación ${String(operation.id)} no está aprobada para usar la red`);
  }
  const result = await network.request(operation, operationApproval(verified.value.hash, operation), signal);
  return result.ok ? ok(result.value) : rejected(result.error.message);
};

/** Class facade for composition roots that prefer injected collaborators. */
export class ApprovedEffectGate {
  public constructor(
    private readonly filesystem: FilesystemPort,
    private readonly process: AllowlistedProcessPort,
    private readonly network: ApprovedNetworkPort,
  ) {}

  public verify(request: ApprovedEffectRequest): Result<VerifiedApproval, TuiError> {
    return verifyApprovalAtEffectBoundary(request);
  }

  public apply(request: ApprovedEffectRequest, signal: AbortSignal): Promise<Result<TransactionResult, TuiError>> {
    return applyApprovedPlan(this.filesystem, request, signal);
  }

  public runExternal(
    request: ApprovedEffectRequest,
    operation: ExternalOperation,
    processRequest: RegisteredProcessRequest,
    signal?: AbortSignal,
  ): Promise<Result<ProcessResult, TuiError>> {
    return runApprovedExternalOperation(this.process, request, operation, processRequest, signal);
  }

  public requestNetwork(
    request: ApprovedEffectRequest,
    operation: ExternalOperation,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, TuiError>> {
    return requestApprovedNetwork(this.network, request, operation, signal);
  }
}
