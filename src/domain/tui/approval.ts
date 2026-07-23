import { calculatePlanHash } from "../planning/planner.js";
import type { ChangePlan } from "../planning/models.js";
import { noCommand, type UiCommand } from "./events.js";
import { tuiError, type TuiError } from "./errors.js";
import type { ApprovalState } from "./session.js";
import type { Sha256 } from "../shared/types.js";

/** A decision that can be recorded by the explicit approval control. */
export type ApprovalChoice = "approve" | "reject";

/** The complete input captured by one approval prompt. */
export interface ApprovalRequest {
  readonly displayedHash: Sha256;
  /** Multiple values model conflicting automated or repeated inputs. */
  readonly decisions: readonly ApprovalChoice[];
}

export type ApprovalOutcomeStatus = "approved" | "rejected" | "conflicted" | "stale" | "blocked";

/** Result of coordinating approval, including the state to persist and command to run. */
export interface ApprovalOutcome {
  readonly status: ApprovalOutcomeStatus;
  readonly state: ApprovalState;
  readonly command: UiCommand;
  readonly error: TuiError | undefined;
}

const freezeApproval = (state: ApprovalState): ApprovalState => Object.freeze({ ...state });

const noApproval = (): ApprovalState => freezeApproval({ decision: "none", hash: undefined });

const staleOutcome = (message: string): ApprovalOutcome => ({
  status: "stale",
  state: noApproval(),
  command: noCommand,
  error: tuiError("APPROVAL_STALE", message, {
    suggestedAction: "Review the current plan and request approval again",
  }),
});

const conflictedOutcome = (hash: Sha256): ApprovalOutcome => ({
  status: "conflicted",
  state: freezeApproval({ decision: "conflicted", hash }),
  command: noCommand,
  error: tuiError("APPROVAL_CONFLICTED", "Approval and rejection decisions conflict; both were discarded", {
    suggestedAction: "Submit one unambiguous approval decision",
  }),
});

/** Bind the prompt's default rejection to the exact plan currently displayed. */
export const defaultApprovalForPlan = (displayedHash: Sha256): ApprovalState =>
  freezeApproval({ decision: "rejected", hash: displayedHash });

/**
 * Coordinates an explicit approval request without performing any external effect.
 * The canonical plan hash is recomputed before an apply command is returned.
 */
export const coordinateApproval = (plan: ChangePlan | undefined, request: ApprovalRequest): ApprovalOutcome => {
  if (plan === undefined) return staleOutcome("Cannot approve a missing plan");
  const canonicalHash = calculatePlanHash(plan);
  if (canonicalHash !== plan.planHash || canonicalHash !== request.displayedHash) {
    return staleOutcome("The displayed plan hash no longer matches the current canonical plan");
  }

  const choices = [...new Set(request.decisions)];
  if (choices.length > 1) return conflictedOutcome(request.displayedHash);
  if (choices[0] !== "approve") {
    return {
      status: "rejected",
      state: defaultApprovalForPlan(request.displayedHash),
      command: noCommand,
      error: undefined,
    };
  }
  return {
    status: "approved",
    state: freezeApproval({ decision: "approved", hash: request.displayedHash }),
    command: { kind: "apply-approved-plan", hash: request.displayedHash },
    error: undefined,
  };
};

/**
 * Revalidates a previously recorded state before effect coordination. This is a
 * pure guard; filesystem/process/network execution belongs to the effect boundary.
 */
export const authorizeApproval = (
  plan: ChangePlan | undefined,
  displayedHash: Sha256 | undefined,
  approval: ApprovalState,
): ApprovalOutcome => {
  if (plan === undefined || displayedHash === undefined) return staleOutcome("No current plan is available for approval");
  const canonicalHash = calculatePlanHash(plan);
  if (canonicalHash !== plan.planHash || canonicalHash !== displayedHash) {
    return staleOutcome("The current plan hash differs from the displayed plan hash");
  }
  if (approval.decision !== "approved" || approval.hash !== canonicalHash) {
    return {
      status: "blocked",
      state: freezeApproval({ decision: approval.decision, hash: approval.hash }),
      command: noCommand,
      error: tuiError("APPROVAL_REQUIRED", "A fresh explicit approval for the current plan is required", {
        suggestedAction: "Approve the displayed plan before applying changes",
      }),
    };
  }
  return {
    status: "approved",
    state: freezeApproval({ decision: "approved", hash: canonicalHash }),
    command: { kind: "apply-approved-plan", hash: canonicalHash },
    error: undefined,
  };
};

/** Class facade for application composition while retaining a pure implementation. */
export class ExplicitApprovalCoordinator {
  public decide(plan: ChangePlan | undefined, request: ApprovalRequest): ApprovalOutcome {
    return coordinateApproval(plan, request);
  }

  public authorize(plan: ChangePlan | undefined, displayedHash: Sha256 | undefined, approval: ApprovalState): ApprovalOutcome {
    return authorizeApproval(plan, displayedHash, approval);
  }
}

export const createApprovalCoordinator = (): ExplicitApprovalCoordinator => new ExplicitApprovalCoordinator();
