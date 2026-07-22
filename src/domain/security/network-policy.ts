import type { ExternalOperation } from "../planning/models.js";
import type { NetworkGateway, ExternalOperationApproval } from "../shared/ports.js";
import { err } from "../shared/types.js";
import type { AppError, Result, Sha256 } from "../shared/types.js";

const denied = (message: string): Result<Uint8Array, AppError> =>
  err({
    code: "NETWORK_DENIED",
    message,
    recoverability: "none",
    suggestedAction: "Rebuild and approve the exact current plan.",
  });

/**
 * Network remains deny-by-default. This decorator checks the exact plan and
 * operation identity before delegating, so a rejected request cannot open a
 * connection in the wrapped gateway.
 */
export class ApprovedNetworkGateway implements NetworkGateway {
  public constructor(private readonly delegate: NetworkGateway) {}

  public request(
    operation: ExternalOperation,
    approval: ExternalOperationApproval,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, AppError>> {
    if (operation.usesNetwork !== true) return Promise.resolve(denied("The requested operation is not an approved network operation"));
    if (
      approval.approved !== true ||
      approval.operationId !== operation.id ||
      approval.planHash.length !== 64 ||
      !/^[a-f0-9]+$/i.test(approval.planHash)
    ) {
      return Promise.resolve(denied("Network approval does not match the exact operation and plan"));
    }
    return this.delegate.request(operation, approval, signal);
  }
}

export class DenyByDefaultNetworkGateway extends ApprovedNetworkGateway {}
export const isExactNetworkApproval = (operation: ExternalOperation, approval: ExternalOperationApproval, planHash?: Sha256): boolean =>
  approval.approved === true && approval.operationId === operation.id && (planHash === undefined || approval.planHash === planHash);
