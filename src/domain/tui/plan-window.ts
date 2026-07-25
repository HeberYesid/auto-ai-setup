import type { PlanOperationView, PlanViewModel } from "./plan-view.js";

/**
 * Upper bound on plan operations rendered at once. Larger plans are shown through a moving window so
 * layout, focus, and navigation stay bounded regardless of plan size, while the canonical order and
 * the plan hash remain untouched.
 */
export const MAX_VISIBLE_PLAN_OPERATIONS = 1000;

/** A bounded slice of a plan projection, with the information needed to describe the omission. */
export interface PlanWindow {
  readonly operations: readonly PlanOperationView[];
  readonly offset: number;
  readonly total: number;
  readonly limit: number;
  readonly truncated: boolean;
}

const boundedLimit = (limit: number): number =>
  Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_VISIBLE_PLAN_OPERATIONS) : MAX_VISIBLE_PLAN_OPERATIONS;

const boundedOffset = (offset: number, total: number, limit: number): number => {
  if (!Number.isInteger(offset) || offset <= 0) return 0;
  return Math.min(offset, Math.max(0, total - limit));
};

/**
 * Compute a deterministic window over the canonical operation order. Operations are never reordered
 * or rewritten: this is a pure slice, so two equal projections always window identically.
 */
export const windowPlanOperations = (plan: PlanViewModel, offset = 0, limit: number = MAX_VISIBLE_PLAN_OPERATIONS): PlanWindow => {
  const total = plan.operations.length;
  const boundedSize = boundedLimit(limit);
  const start = boundedOffset(offset, total, boundedSize);
  return {
    operations: plan.operations.slice(start, start + boundedSize),
    offset: start,
    total,
    limit: boundedSize,
    truncated: total > boundedSize,
  };
};

/** Project a windowed plan view. The displayed plan hash is preserved exactly. */
export const windowPlanView = (plan: PlanViewModel, offset = 0, limit: number = MAX_VISIBLE_PLAN_OPERATIONS): PlanViewModel => {
  const window = windowPlanOperations(plan, offset, limit);
  return window.operations.length === plan.operations.length ? plan : { ...plan, operations: window.operations };
};

/** A short, secret-free description of how many operations are omitted from the window. */
export const planWindowNotice = (window: PlanWindow): string | undefined =>
  window.truncated ? `Mostrando ${window.operations.length} de ${window.total} operaciones (desde ${window.offset + 1})` : undefined;
