import type { ApprovalDecisions, ApprovedPlan, ChangePlan, FileChange } from "./planning/models.js";
import type { ApprovalError, PlanningError, Result } from "./shared/types.js";
import { err, ok, unique } from "./shared/types.js";

export const validateApprovedPlan = (plan: ChangePlan, decisions: ApprovalDecisions): Result<ApprovedPlan, ApprovalError> => {
  if (decisions.planHash !== plan.planHash) {
    return err({
      code: "PLAN_HASH_MISMATCH",
      message: "Approval belongs to a different plan",
      recoverability: "none",
      suggestedAction: "Rebuild and review the current plan",
    });
  }

  const externalIds = new Set(plan.externalOperations.map((operation) => operation.id));
  const conflictIds = new Set(plan.fileChanges.filter((change) => change.conflict !== "none").map((change) => change.id));
  const approvedConflicts = new Set(Object.keys(decisions.conflicts));
  const approvedNetworks = decisions.networkOperations;

  if (![...approvedConflicts].every((id) => conflictIds.has(id))) {
    return err({
      code: "APPROVAL_SUBSET_INVALID",
      message: "Conflict approvals must reference plan conflicts only",
      recoverability: "none",
    });
  }
  if (!approvedNetworks.every((id) => externalIds.has(id))) {
    return err({
      code: "UNAPPROVED_NETWORK_OPERATION",
      message: "Network approvals must reference planned operations only",
      recoverability: "none",
    });
  }
  if (!unique(decisions.incompatibleComponents, (id) => id)) {
    return err({ code: "APPROVAL_SUBSET_INVALID", message: "Incompatible component approvals must be unique", recoverability: "none" });
  }
  if (plan.externalOperations.some((operation) => operation.usesNetwork && !approvedNetworks.includes(operation.id))) {
    return err({
      code: "UNAPPROVED_NETWORK_OPERATION",
      message: "Every network operation must be explicitly approved",
      recoverability: "none",
    });
  }
  if (plan.fileChanges.some((change) => change.conflict !== "none" && !approvedConflicts.has(change.id))) {
    return err({
      code: "MISSING_APPROVAL",
      message: "Every conflicting file requires a preserve or replace decision",
      recoverability: "none",
    });
  }
  if (
    plan.fileChanges.some(
      (change) => change.conflict !== "none" && decisions.conflicts[change.id] === "replace" && !decisions.globalApproved,
    )
  ) {
    return err({ code: "MISSING_APPROVAL", message: "Replacing a conflict requires global approval as well", recoverability: "none" });
  }

  if ((plan.fileChanges.length > 0 || plan.externalOperations.length > 0) && conflictIds.size === 0 && !decisions.globalApproved) {
    return err({ code: "MISSING_APPROVAL", message: "A conflict-free plan requires global approval", recoverability: "none" });
  }

  const approvedFileChangeIds = plan.fileChanges
    .filter((change) => change.action !== "preserve" && change.action !== "skip")
    .filter((change) => change.conflict === "none" || decisions.conflicts[change.id] === "replace")
    .map((change) => change.id);
  const approvedExternalOperationIds = plan.externalOperations
    .filter((operation) => decisions.networkOperations.includes(operation.id))
    .map((operation) => operation.id);

  return ok({
    ...plan,
    approval: decisions,
    approvedFileChangeIds,
    approvedExternalOperationIds,
  });
};

export const validatePlanInvariants = (plan: ChangePlan): Result<void, PlanningError> => {
  if (!unique(plan.fileChanges, (change) => change.destination)) {
    return err({ code: "INVALID_PLAN", message: "Managed destinations must be unique", recoverability: "none" });
  }
  if (!unique(plan.externalOperations, (operation) => operation.id)) {
    return err({ code: "INVALID_PLAN", message: "External operation IDs must be unique", recoverability: "none" });
  }
  if (plan.fileChanges.some((change) => change.action === "preserve" && change.afterDigest !== undefined)) {
    return err({ code: "INVALID_PLAN", message: "Preserved files cannot declare a desired replacement digest", recoverability: "none" });
  }
  return ok(undefined);
};

export const isTerminalJournalPhase = (phase: import("./planning/models.js").RecoveryJournal["phase"]): boolean =>
  phase === "committed" || phase === "rolled-back";

export const terminalPlanChanges = (plan: ChangePlan): readonly FileChange[] =>
  plan.fileChanges.filter((change) => change.action !== "preserve" && change.action !== "skip");
