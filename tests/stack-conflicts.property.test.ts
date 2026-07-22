import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { aggregateDetections, asSafeProjectPath, resolveStackConflicts, suspendDependentRecommendations } from "../src/domain/index.js";
import type { CliRecommendation, DetectionClaim, InitialCli, StackCategory, StackEvidence } from "../src/domain/index.js";
import { deterministicFastCheckParameters } from "./support/fast-check.js";

const stackCategories: readonly StackCategory[] = ["language", "package-manager", "framework", "tool"];
const initialClis: readonly InitialCli[] = ["gh", "supabase", "vercel", "playwright"];
const candidateLabels = ["alpha", "beta", "gamma", "delta", "epsilon"] as const;

const categoryArbitrary = fc.constantFrom<StackCategory>(...stackCategories);
const labelsArbitrary = fc.uniqueArray(fc.constantFrom(...candidateLabels), { minLength: 2, maxLength: 4 });
const dependenciesArbitrary = fc.subarray(stackCategories, { minLength: 0, maxLength: stackCategories.length });
const selectedClisArbitrary = fc.subarray(initialClis, { minLength: 1, maxLength: initialClis.length });

interface ConflictScenario {
  readonly conflictCategory: StackCategory;
  readonly candidateLabels: readonly string[];
  readonly additionalItems: readonly { readonly category: StackCategory; readonly label: string }[];
  readonly selectedClis: readonly InitialCli[];
  readonly dependencySets: Readonly<Record<InitialCli, readonly StackCategory[]>>;
}

const scenarioArbitrary: fc.Arbitrary<ConflictScenario> = fc.record({
  conflictCategory: categoryArbitrary,
  candidateLabels: labelsArbitrary,
  additionalItems: fc.array(fc.record({ category: categoryArbitrary, label: fc.constantFrom(...candidateLabels) }), {
    minLength: 0,
    maxLength: 6,
  }),
  selectedClis: selectedClisArbitrary,
  dependencySets: fc.record({
    gh: dependenciesArbitrary,
    supabase: dependenciesArbitrary,
    vercel: dependenciesArbitrary,
    playwright: dependenciesArbitrary,
  }),
});

const safeEvidence = (path: string, recognizedValue: string, detectorId: string): StackEvidence => {
  const result = asSafeProjectPath(path);
  if (!result.ok) throw new Error(`Invalid generated evidence path: ${path}`);
  return {
    path: result.value,
    format: "json",
    location: "1:1",
    recognizedValue,
    detectorId,
  };
};

const claimsFor = (scenario: ConflictScenario): readonly DetectionClaim[] => {
  const candidateClaims = scenario.candidateLabels.map(
    (label, index): DetectionClaim => ({
      category: scenario.conflictCategory,
      id: `${scenario.conflictCategory}.${label}`,
      displayName: `${scenario.conflictCategory} ${label}`,
      confidence: "explicit",
      evidence: safeEvidence(
        `evidence/${scenario.conflictCategory}-${index}.json`,
        label,
        `generated.${scenario.conflictCategory}.${label}`,
      ),
    }),
  );
  const additionalClaims = scenario.additionalItems.map(
    (item, index): DetectionClaim => ({
      category: item.category,
      id: `${item.category}.${item.label}`,
      displayName: `${item.category} ${item.label}`,
      confidence: "derived",
      evidence: safeEvidence(
        `evidence/additional-${item.category}-${index}.json`,
        item.label,
        `generated.additional.${item.category}.${item.label}`,
      ),
    }),
  );
  return [...candidateClaims, ...additionalClaims];
};

const recommendationsFor = (clis: readonly InitialCli[]): readonly CliRecommendation[] =>
  clis.map((cli) => ({
    cli,
    reason: `Generated recommendation for ${cli}`,
    evidenceRefs: [`evidence/${cli}`],
  }));

// Feature: auto-ai-setup, Property 4: Los conflictos suspenden únicamente recomendaciones dependientes
// **Validates: Requirements 2.14–2.15**
describe("Property 4: los conflictos suspenden únicamente recomendaciones dependientes", () => {
  it("suspends only dependent recommendations and reevaluates them after explicit resolution", () => {
    fc.assert(
      fc.property(scenarioArbitrary, (scenario) => {
        const analysis = aggregateDetections(claimsFor(scenario), {
          exclusiveCategories: [scenario.conflictCategory],
        });
        const conflict = analysis.conflicts.find((entry) => entry.category === scenario.conflictCategory);
        expect(conflict).toBeDefined();
        if (conflict === undefined) return;

        const recommendations = recommendationsFor(scenario.selectedClis);
        const suspended = suspendDependentRecommendations(recommendations, scenario.dependencySets, analysis.conflicts);

        for (const [index, recommendation] of recommendations.entries()) {
          const dependsOnConflict = scenario.dependencySets[recommendation.cli].includes(scenario.conflictCategory);
          const observed = suspended[index];
          expect(observed).toBeDefined();
          if (observed === undefined) return;
          if (dependsOnConflict) {
            expect(observed).toMatchObject({ ...recommendation, pending: true });
          } else {
            expect(observed).toEqual(recommendation);
          }
        }

        const chosenValue = conflict.candidates[0]?.id;
        expect(chosenValue).toBeDefined();
        if (chosenValue === undefined) return;
        const resolved = resolveStackConflicts(analysis, {
          [scenario.conflictCategory]: chosenValue,
        });
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        expect(resolved.value.items).toContainEqual(expect.objectContaining({ category: scenario.conflictCategory, id: chosenValue }));

        const remainingConflicts = analysis.conflicts.filter(
          (entry) => !resolved.value.items.some((item) => item.category === entry.category),
        );
        expect(remainingConflicts).toEqual([]);
        expect(suspendDependentRecommendations(recommendations, scenario.dependencySets, remainingConflicts)).toEqual(recommendations);
      }),
      deterministicFastCheckParameters(24028, 100),
    );
  });
});
