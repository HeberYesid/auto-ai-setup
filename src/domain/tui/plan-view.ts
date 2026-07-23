import type { Sha256 } from "../shared/types.js";

/** Placeholder text used for any plan field without an applicable value. */
export const NOT_APPLICABLE = "no aplicable";

/** A redacted, semantic before/after description of a content modification. */
export interface SemanticChangeView {
  readonly before: string;
  readonly after: string;
}

/** A policy-allowed external operation, with its command, arguments, and network use. */
export interface ExternalOperationView {
  readonly command: string;
  readonly args: readonly string[];
  readonly purpose: string;
  readonly networkUse: string;
}

/**
 * A single plan operation projected for review. String fields are redacted and use
 * {@link NOT_APPLICABLE} for absent values.
 */
export interface PlanOperationView {
  readonly operationId: string;
  readonly action: string;
  readonly destination: string;
  readonly source: string;
  readonly reason: string;
  readonly conflict: string;
  readonly semanticChange: SemanticChangeView | undefined;
  readonly external: ExternalOperationView | undefined;
}

/**
 * The redacted plan projection presented for review. Operations remain in canonical
 * order, the displayed hash is included, and approval defaults to rejection.
 */
export interface PlanViewModel {
  readonly operations: readonly PlanOperationView[];
  readonly planHash: Sha256;
  readonly approvalDefault: "reject";
}
