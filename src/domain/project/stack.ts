import { createHash } from "node:crypto";
import type {
  CliRecommendation,
  ConfirmedStack,
  DetectionClaim,
  StackAnalysis,
  StackCategory,
  StackConflict,
  StackEvidence,
  StackItem,
} from "./models.js";
import type { ComponentId, Result, Sha256, StackConflictError } from "../shared/types.js";
import { ok } from "../shared/types.js";

const categoryOrder: readonly StackCategory[] = ["language", "package-manager", "framework", "tool"];
const defaultExclusiveCategories: readonly StackCategory[] = ["package-manager"];
const performanceFileLimit = 10_000;
const performanceByteLimit = 500_000_000;

export interface StackAggregationOptions {
  readonly analyzedFileCount?: number;
  readonly analyzedBytes?: number;
  readonly elapsedMs?: number;
  readonly withinPerformanceProfile?: boolean;
  readonly exclusiveCategories?: readonly StackCategory[];
  readonly blocksCapabilities?: Partial<Record<StackCategory, readonly ComponentId[]>>;
}

export interface StackEvidenceView extends StackEvidence {
  readonly reference: string;
}

export interface StackItemView {
  readonly category: StackCategory;
  readonly id: string;
  readonly displayName: string;
  readonly confidence: "explicit" | "derived";
  readonly evidence: readonly StackEvidenceView[];
  readonly evidenceRefs: readonly string[];
}

export interface StackConflictView {
  readonly category: StackCategory;
  readonly candidates: readonly StackItemView[];
  readonly blocksCapabilities: readonly ComponentId[];
}

export interface StackViewModel {
  readonly items: readonly StackItemView[];
  readonly conflicts: readonly StackConflictView[];
  readonly unresolvedCategories: readonly StackCategory[];
  readonly manualFallback: boolean;
  readonly recommendationsSuspended: boolean;
}

export interface StackCapability {
  readonly id: string;
  readonly dependsOnCategories: readonly StackCategory[];
}

export interface CapabilityAvailability extends StackCapability {
  readonly available: boolean;
  readonly blockedBy: readonly StackCategory[];
}

export interface StackResolutionSelection {
  readonly category: StackCategory;
  readonly value: string;
}

const compareCategory = (left: StackCategory, right: StackCategory): number => categoryOrder.indexOf(left) - categoryOrder.indexOf(right);
const compareEvidence = (left: StackEvidence, right: StackEvidence): number =>
  left.path.localeCompare(right.path) ||
  left.location.localeCompare(right.location) ||
  left.recognizedValue.localeCompare(right.recognizedValue) ||
  left.detectorId.localeCompare(right.detectorId) ||
  left.format.localeCompare(right.format);
const compareItems = (left: StackItem, right: StackItem): number =>
  compareCategory(left.category, right.category) || left.id.localeCompare(right.id);

const evidenceKey = (evidence: StackEvidence): string =>
  [evidence.path, evidence.format, evidence.location, evidence.recognizedValue, evidence.detectorId].join("\u0000");
const itemKey = (claim: DetectionClaim): string => `${claim.category}\u0000${claim.id}`;

const copyEvidence = (evidence: StackEvidence): StackEvidence => ({ ...evidence });

export const evidenceReference = (evidence: StackEvidence): string =>
  `${evidence.path}#${evidence.location}:${evidence.detectorId}:${evidence.recognizedValue}`;

export const aggregateDetections = (claims: readonly DetectionClaim[], options: StackAggregationOptions = {}): StackAnalysis => {
  const groups = new Map<
    string,
    { category: StackCategory; id: string; displayName: string; confidence: "explicit" | "derived"; evidences: Map<string, StackEvidence> }
  >();
  for (const claim of claims) {
    const key = itemKey(claim);
    const current = groups.get(key);
    if (current === undefined) {
      groups.set(key, {
        category: claim.category,
        id: claim.id,
        displayName: claim.displayName,
        confidence: claim.confidence,
        evidences: new Map([[evidenceKey(claim.evidence), copyEvidence(claim.evidence)]]),
      });
      continue;
    }
    if (claim.displayName.localeCompare(current.displayName) < 0) current.displayName = claim.displayName;
    if (claim.confidence === "explicit") current.confidence = "explicit";
    current.evidences.set(evidenceKey(claim.evidence), copyEvidence(claim.evidence));
  }
  const items = [...groups.values()]
    .map(
      (group): StackItem => ({
        category: group.category,
        id: group.id,
        displayName: group.displayName,
        confidence: group.confidence,
        evidence: [...group.evidences.values()].sort(compareEvidence),
      }),
    )
    .sort(compareItems);
  const exclusive = new Set(options.exclusiveCategories ?? defaultExclusiveCategories);
  const conflicts: StackConflict[] = [];
  for (const category of categoryOrder) {
    if (!exclusive.has(category)) continue;
    const candidates = items.filter((item) => item.category === category);
    if (candidates.length < 2) continue;
    conflicts.push({
      category,
      candidates,
      blocksCapabilities: [...(options.blocksCapabilities?.[category] ?? [])].sort((left, right) => left.localeCompare(right)),
    });
  }
  const analyzedFileCount = nonNegativeInteger(options.analyzedFileCount ?? countEvidenceFiles(items));
  const analyzedBytes = nonNegativeInteger(options.analyzedBytes ?? 0);
  const withinPerformanceProfile =
    options.withinPerformanceProfile ?? (analyzedFileCount <= performanceFileLimit && analyzedBytes <= performanceByteLimit);
  return {
    items,
    conflicts: conflicts.sort((left, right) => compareCategory(left.category, right.category)),
    analyzedFileCount,
    analyzedBytes,
    elapsedMs: nonNegativeNumber(options.elapsedMs ?? 0),
    withinPerformanceProfile,
  };
};

const countEvidenceFiles = (items: readonly StackItem[]): number =>
  new Set(items.flatMap((item) => item.evidence.map((evidence) => evidence.path))).size;
const nonNegativeInteger = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
const nonNegativeNumber = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

export const createStackViewModel = (analysis: StackAnalysis): StackViewModel => {
  const viewItems = analysis.items.map(toItemView);
  const itemViews = new Map(viewItems.map((item) => [`${item.category}\u0000${item.id}`, item]));
  const conflicts = analysis.conflicts.map(
    (conflict): StackConflictView => ({
      category: conflict.category,
      candidates: conflict.candidates.map(
        (candidate) => itemViews.get(`${candidate.category}\u0000${candidate.id}`) ?? toItemView(candidate),
      ),
      blocksCapabilities: [...conflict.blocksCapabilities],
    }),
  );
  const unresolvedCategories = conflicts.map((conflict) => conflict.category).sort(compareCategory);
  return {
    items: viewItems,
    conflicts,
    unresolvedCategories,
    manualFallback: analysis.items.length === 0,
    recommendationsSuspended: analysis.items.length === 0 || unresolvedCategories.length > 0,
  };
};

const toItemView = (item: StackItem): StackItemView => {
  const evidence = item.evidence.map((entry): StackEvidenceView => ({ ...entry, reference: evidenceReference(entry) }));
  return { ...item, evidence, evidenceRefs: evidence.map((entry) => entry.reference) };
};

export const stackViewModel = createStackViewModel;
export const buildStackView = createStackViewModel;

export const hasConfirmedStack = (analysis: StackAnalysis): boolean => analysis.items.length > 0 && analysis.conflicts.length === 0;
export const shouldOfferManualFallback = (analysis: StackAnalysis): boolean => analysis.items.length === 0;

export const resolveStackConflicts = (
  analysis: StackAnalysis,
  selections: readonly StackResolutionSelection[] | Readonly<Partial<Record<StackCategory, string>>>,
): Result<ConfirmedStack, StackConflictError> => {
  const selected = normalizeSelections(selections);
  const unresolved = analysis.conflicts.filter((conflict) => selected.get(conflict.category) === undefined);
  if (unresolved.length > 0) return conflictError(unresolved[0]!);
  for (const conflict of analysis.conflicts) {
    const value = selected.get(conflict.category);
    if (value === undefined || !conflict.candidates.some((candidate) => candidate.id === value)) return conflictError(conflict);
  }
  const resolvedCategories = new Map(analysis.conflicts.map((conflict) => [conflict.category, selected.get(conflict.category)!]));
  const items = analysis.items
    .filter((item) => {
      const selectedValue = resolvedCategories.get(item.category);
      return selectedValue === undefined || selectedValue === item.id;
    })
    .sort(compareItems);
  return ok({ items, resolvedConflicts: analysis.conflicts.map(copyConflict), digest: digestConfirmedItems(items) });
};

const normalizeSelections = (
  selections: readonly StackResolutionSelection[] | Readonly<Partial<Record<StackCategory, string>>>,
): Map<StackCategory, string> => {
  if (Array.isArray(selections)) return new Map(selections.map((selection) => [selection.category, selection.value]));
  const record = selections as Readonly<Partial<Record<StackCategory, string>>>;
  const result = new Map<StackCategory, string>();
  for (const category of categoryOrder) {
    const value = record[category];
    if (value !== undefined) result.set(category, value);
  }
  return result;
};

const copyConflict = (conflict: StackConflict): StackConflict => ({
  category: conflict.category,
  candidates: conflict.candidates.map((candidate) => ({ ...candidate, evidence: candidate.evidence.map(copyEvidence) })),
  blocksCapabilities: [...conflict.blocksCapabilities],
});

const conflictError = (conflict: StackConflict): { ok: false; error: StackConflictError } => ({
  ok: false,
  error: {
    code: "STACK_CONFLICT",
    message: `A stack value must be selected for ${conflict.category}`,
    category: conflict.category,
    candidates: conflict.candidates.map((candidate) => candidate.id),
    recoverability: "none",
  },
});

const canonicalItem = (item: StackItem): string =>
  JSON.stringify({
    category: item.category,
    id: item.id,
    displayName: item.displayName,
    confidence: item.confidence,
    evidence: item.evidence.map((evidence) => ({ ...evidence })),
  });

export const digestConfirmedItems = (items: readonly StackItem[]): Sha256 => {
  const canonical = [...items].sort(compareItems).map(canonicalItem).join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex") as Sha256;
};

export const resolveStack = resolveStackConflicts;
export const confirmStack = resolveStackConflicts;

export const evaluateCapabilities = (
  capabilities: readonly StackCapability[],
  unresolvedCategories: readonly StackCategory[] | readonly StackConflict[],
): readonly CapabilityAvailability[] => {
  const categories = new Set(unresolvedCategories.map((entry) => (typeof entry === "string" ? entry : entry.category)));
  return capabilities.map((capability) => {
    const blockedBy = capability.dependsOnCategories.filter((category) => categories.has(category));
    return { ...capability, available: blockedBy.length === 0, blockedBy };
  });
};

export const suspendDependentCapabilities = (
  capabilities: readonly StackCapability[],
  conflicts: readonly StackConflict[],
): readonly CapabilityAvailability[] => evaluateCapabilities(capabilities, conflicts);

export const suspendDependentRecommendations = (
  recommendations: readonly CliRecommendation[],
  dependencies: Readonly<Partial<Record<CliRecommendation["cli"], readonly StackCategory[]>>>,
  conflicts: readonly StackConflict[],
): readonly CliRecommendation[] => {
  const conflicted = new Set(conflicts.map((conflict) => conflict.category));
  return recommendations.map((recommendation) => {
    const blockedCategories = (dependencies[recommendation.cli] ?? []).filter((category) => conflicted.has(category));
    if (blockedCategories.length === 0) return { ...recommendation };
    return { ...recommendation, pending: true };
  });
};
