import type { ApprovalPolicy as ApprovalPolicyPort } from "../shared/ports.js";
import { err, ok } from "../shared/types.js";
import type { ApprovalError, Result } from "../shared/types.js";
import type { ApprovalDecisions, ApprovedPlan, ChangePlan, FileChange } from "./models.js";
import { calculatePlanHash } from "./planner.js";

const approvalError = (code: ApprovalError["code"], message: string): Result<ApprovedPlan, ApprovalError> =>
  err({ code, message, recoverability: "none" });
const actionable = (change: FileChange): boolean => change.action === "create" || change.action === "modify";
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
};

const cloneDecisions = (decisions: ApprovalDecisions): ApprovalDecisions => ({
  planHash: decisions.planHash,
  globalApproved: decisions.globalApproved,
  conflicts: Object.fromEntries(Object.entries(decisions.conflicts).sort(([left], [right]) => left.localeCompare(right))),
  incompatibleComponents: [...new Set(decisions.incompatibleComponents)].sort((left, right) => left.localeCompare(right)),
  networkOperations: [...new Set(decisions.networkOperations)].sort((left, right) => left.localeCompare(right)),
});

/** Validates consent and returns a frozen plan containing only approved work. */
export class ImmutableApprovalPolicy implements ApprovalPolicyPort {
  public evaluate(plan: ChangePlan, decisions: ApprovalDecisions): Result<ApprovedPlan, ApprovalError> {
    if (decisions.planHash !== plan.planHash || calculatePlanHash(plan) !== plan.planHash)
      return approvalError("PLAN_HASH_MISMATCH", "Approval is not bound to the exact current plan hash");
    if (!unique(decisions.incompatibleComponents) || !unique(decisions.networkOperations))
      return approvalError("APPROVAL_SUBSET_INVALID", "Approval lists must not contain duplicates");

    const conflictChanges = plan.fileChanges.filter((change) => change.conflict !== "none" && actionable(change));
    const conflictIds = new Set(conflictChanges.map((change) => change.id));
    const conflictDestinations = new Set<string>(conflictChanges.map((change) => change.destination));
    for (const key of Object.keys(decisions.conflicts)) {
      if (!conflictIds.has(key) && !conflictDestinations.has(key))
        return approvalError("APPROVAL_SUBSET_INVALID", `Approval references an unknown conflict: ${key}`);
    }
    for (const change of conflictChanges) {
      const decision = decisions.conflicts[change.id] ?? decisions.conflicts[change.destination];
      if (decision === undefined) return approvalError("MISSING_APPROVAL", `Missing preserve/replace decision for ${change.destination}`);
    }

    const incompatibleIds = new Set(
      plan.fileChanges.filter((change) => change.incompatibleOverride !== undefined).map((change) => change.componentId),
    );
    for (const componentId of decisions.incompatibleComponents) {
      if (!incompatibleIds.has(componentId))
        return approvalError("APPROVAL_SUBSET_INVALID", `Approval references an incompatible component not in the plan: ${componentId}`);
    }
    for (const componentId of incompatibleIds) {
      if (!decisions.incompatibleComponents.includes(componentId))
        return approvalError("MISSING_APPROVAL", `Missing incompatible-component confirmation for ${componentId}`);
    }

    const operationIds = plan.externalOperations.map((operation) => operation.id);
    if (decisions.networkOperations.some((id) => !operationIds.includes(id)))
      return approvalError("APPROVAL_SUBSET_INVALID", "Network approval references an unknown operation");
    if (decisions.networkOperations.length !== operationIds.length || operationIds.some((id) => !decisions.networkOperations.includes(id)))
      return approvalError("UNAPPROVED_NETWORK_OPERATION", "Every network operation requires exact explicit approval");

    const hasNonConflictWork = plan.fileChanges.some((change) => change.conflict === "none" && actionable(change));
    if (
      (conflictChanges.length === 0 && (hasNonConflictWork || plan.externalOperations.length > 0) && !decisions.globalApproved) ||
      (conflictChanges.length > 0 && hasNonConflictWork && !decisions.globalApproved)
    ) {
      return approvalError("MISSING_APPROVAL", "Global approval is required for non-conflicting changes");
    }

    const approvedFileChangeIds: string[] = [];
    const omittedFileChangeIds: string[] = [];
    for (const change of plan.fileChanges) {
      const decision = decisions.conflicts[change.id] ?? decisions.conflicts[change.destination];
      const include = actionable(change) && (change.conflict === "none" ? decisions.globalApproved : decision === "replace");
      if (include) approvedFileChangeIds.push(change.id);
      else omittedFileChangeIds.push(change.id);
    }
    const approvedExternalOperationIds = [...plan.externalOperations].map((operation) => operation.id);
    const approved = {
      ...plan,
      fileChanges: plan.fileChanges.filter((change) => approvedFileChangeIds.includes(change.id)),
      externalOperations: plan.externalOperations.filter((operation) => approvedExternalOperationIds.includes(operation.id)),
      approval: cloneDecisions(decisions),
      approvedFileChangeIds: [...approvedFileChangeIds],
      approvedExternalOperationIds,
    } satisfies ApprovedPlan;
    return ok(deepFreeze(approved));
  }
}

export const ApprovalPolicyImplementation = ImmutableApprovalPolicy;
export const createApprovedPlan = (plan: ChangePlan, decisions: ApprovalDecisions): Result<ApprovedPlan, ApprovalError> =>
  new ImmutableApprovalPolicy().evaluate(plan, decisions);
