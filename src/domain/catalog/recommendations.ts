import type { CliRecommendation, ConfirmedStack, InitialCli, StackItem } from "../project/models.js";
import { evidenceReference } from "../project/stack.js";
import type { ComponentDefinition, CompatibilityDecision, CompatibilityExpression } from "../planning/models.js";
import type { CompatibilityInput, ComponentGroup, ComponentSelectionView, ComponentView } from "./models.js";

/** The only external CLIs that can be mentioned by the MVP recommendation engine. */
export const INITIAL_CLI_ORDER: readonly InitialCli[] = ["gh", "supabase", "vercel", "playwright"];

const COMPONENT_TYPE_ORDER: readonly ComponentDefinition["type"][] = ["skill", "mcp-server", "agent-rule", "agent-command"];

interface CliRule {
  readonly cli: InitialCli;
  readonly ids: readonly string[];
  readonly names: readonly string[];
  readonly explanation: string;
  readonly instructions: readonly string[];
}

const CLI_RULES: readonly CliRule[] = [
  {
    cli: "gh",
    ids: ["github", "github-actions", "githubactions"],
    names: ["github", "github actions"],
    explanation: "Use gh to inspect repositories, pull requests, issues, and GitHub Actions from the project workflow.",
    instructions: ["Consult the official gh installation and authentication documentation.", "Install or authenticate gh separately only when you explicitly choose to; auto-ai-setup does not execute it."],
  },
  {
    cli: "supabase",
    ids: ["supabase"],
    names: ["supabase"],
    explanation: "Use the Supabase CLI to manage the project's local Supabase configuration and linked database workflow.",
    instructions: ["Consult the official Supabase CLI installation and project documentation.", "Run Supabase commands separately after reviewing this plan; auto-ai-setup does not execute them."],
  },
  {
    cli: "vercel",
    ids: ["vercel"],
    names: ["vercel"],
    explanation: "Use the Vercel CLI to inspect, configure, and deploy the project's Vercel application when desired.",
    instructions: ["Consult the official Vercel CLI installation and deployment documentation.", "Install or run Vercel separately after explicit user action; auto-ai-setup does not execute it."],
  },
  {
    cli: "playwright",
    ids: ["playwright"],
    names: ["playwright"],
    explanation: "Use Playwright's CLI to manage browser binaries and run the project's browser-test workflow.",
    instructions: ["Consult the official Playwright CLI and browser-installation documentation.", "Install browsers or run Playwright separately; auto-ai-setup does not execute the recommended CLI."],
  },
];

const normalize = (value: string): string => value.trim().toLocaleLowerCase().replace(/[_\s]+/g, "-");
const displayNormalize = (value: string): string => value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
const isMatchingItem = (item: StackItem, rule: CliRule): boolean => {
  const id = normalize(item.id);
  const idLeaf = id.includes(".") ? id.slice(id.lastIndexOf(".") + 1) : id;
  const name = displayNormalize(item.displayName);
  const idMatches = rule.ids.some((candidate) => id === candidate || idLeaf === candidate || id.startsWith(`${candidate}.`) || id.includes(`.${candidate}.`));
  return idMatches || rule.names.includes(name);
};

const uniqueSorted = (values: readonly string[]): readonly string[] => [...new Set(values)].sort((left, right) => left.localeCompare(right));

/**
 * Purely maps confirmed stack evidence to one recommendation per initial CLI.
 * It has no process, filesystem, network, installation, or environment dependencies.
 */
export const recommendClis = (stack: ConfirmedStack): readonly CliRecommendation[] => {
  if (stack.items.length === 0) return [];
  return CLI_RULES.flatMap((rule): readonly CliRecommendation[] => {
    const matches = stack.items.filter((item) => isMatchingItem(item, rule));
    if (matches.length === 0) return [];
    const technologies = uniqueSorted(matches.map((item) => item.displayName));
    const evidenceRefs = uniqueSorted(matches.flatMap((item) => item.evidence.map(evidenceReference)));
    return [{
      cli: rule.cli,
      reason: `Detected ${technologies.join(" and ")} in the confirmed stack.`,
      evidenceRefs,
      technologies,
      explanation: rule.explanation,
      documentedInstructions: rule.instructions,
    }];
  });
};

export const noCliRecommendationsMessage = "No CLI recommendations are available from the confirmed stack.";
export const getCliRecommendations = recommendClis;

/** A plan-safe representation: documentation only, never an executable operation. */
export interface CliRecommendationPlanEntry {
  readonly cli: InitialCli;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly instructions: readonly string[];
  readonly action: "document";
  readonly executes: false;
  readonly installs: false;
  readonly probes: false;
}

export const toCliRecommendationPlanEntry = (recommendation: CliRecommendation): CliRecommendationPlanEntry => ({
  cli: recommendation.cli,
  reason: recommendation.reason,
  evidenceRefs: [...recommendation.evidenceRefs],
  instructions: [...(recommendation.documentedInstructions ?? [])],
  action: "document",
  executes: false,
  installs: false,
  probes: false,
});

export interface RecommendationEngine {
  recommendClis(stack: ConfirmedStack): readonly CliRecommendation[];
}

export class PureRecommendationEngine implements RecommendationEngine {
  recommendClis(stack: ConfirmedStack): readonly CliRecommendation[] {
    return recommendClis(stack);
  }
}

export const recommendationEngine = new PureRecommendationEngine();

export const evaluateCompatibility = (expression: CompatibilityExpression, input: CompatibilityInput): CompatibilityDecision => {
  const result = evaluateExpression(expression, input);
  return {
    compatible: result.compatible,
    satisfied: uniqueSorted(result.satisfied),
    unsatisfied: uniqueSorted(result.unsatisfied),
    evidenceRefs: uniqueSorted(result.evidenceRefs),
  };
};

interface ExpressionResult {
  readonly compatible: boolean;
  readonly satisfied: readonly string[];
  readonly unsatisfied: readonly string[];
  readonly evidenceRefs: readonly string[];
}

const expressionLabel = (expression: CompatibilityExpression): string => {
  switch (expression.op) {
    case "always": return "always";
    case "stack": return `stack:${expression.category} in [${expression.oneOf.join(", ")}]`;
    case "cli": return `cli in [${expression.oneOf.join(", ")}]`;
    case "not": return `not (${expressionLabel(expression.clause)})`;
    case "noneOf": return `none of [${expression.clauses.map(expressionLabel).join(", ")}]`;
    case "all": return expression.clauses.map(expressionLabel).join(" and ");
    case "any": return expression.clauses.map(expressionLabel).join(" or ");
  }
};

const evaluateExpression = (expression: CompatibilityExpression, input: CompatibilityInput): ExpressionResult => {
  switch (expression.op) {
    case "always":
      return { compatible: true, satisfied: ["always"], unsatisfied: [], evidenceRefs: [] };
    case "stack": {
      const candidates = input.stack.items.filter((item) => item.category === expression.category && expression.oneOf.includes(item.id));
      if (candidates.length > 0) {
        return {
          compatible: true,
          satisfied: candidates.map((item) => `stack:${item.category}=${item.id}`),
          unsatisfied: [],
          evidenceRefs: candidates.flatMap((item) => item.evidence.map(evidenceReference)),
        };
      }
      return {
        compatible: false,
        satisfied: [],
        unsatisfied: [`Requires ${expressionLabel(expression)}`],
        evidenceRefs: [],
      };
    }
    case "cli": {
      const candidates = input.cliRecommendations.filter((recommendation) => !recommendation.pending && expression.oneOf.includes(recommendation.cli));
      if (candidates.length > 0) {
        return {
          compatible: true,
          satisfied: candidates.map((recommendation) => `cli=${recommendation.cli}`),
          unsatisfied: [],
          evidenceRefs: candidates.flatMap((recommendation) => recommendation.evidenceRefs),
        };
      }
      return {
        compatible: false,
        satisfied: [],
        unsatisfied: [`Requires ${expressionLabel(expression)}`],
        evidenceRefs: [],
      };
    }
    case "all": {
      const clauses = expression.clauses.map((clause) => evaluateExpression(clause, input));
      return {
        compatible: clauses.every((clause) => clause.compatible),
        satisfied: clauses.flatMap((clause) => clause.satisfied),
        unsatisfied: clauses.flatMap((clause) => clause.unsatisfied),
        evidenceRefs: clauses.flatMap((clause) => clause.evidenceRefs),
      };
    }
    case "any": {
      const clauses = expression.clauses.map((clause) => evaluateExpression(clause, input));
      const compatible = clauses.some((clause) => clause.compatible);
      return {
        compatible,
        satisfied: clauses.filter((clause) => clause.compatible).flatMap((clause) => clause.satisfied),
        unsatisfied: compatible ? [] : clauses.flatMap((clause) => clause.unsatisfied),
        evidenceRefs: clauses.filter((clause) => clause.compatible).flatMap((clause) => clause.evidenceRefs),
      };
    }
    case "not": {
      const clause = evaluateExpression(expression.clause, input);
      return clause.compatible
        ? { compatible: false, satisfied: [], unsatisfied: [`Requires ${expressionLabel(expression)}`], evidenceRefs: [] }
        : { compatible: true, satisfied: [`not (${expressionLabel(expression.clause)})`], unsatisfied: [], evidenceRefs: [] };
    }
    case "noneOf": {
      const clauses = expression.clauses.map((clause) => evaluateExpression(clause, input));
      const compatible = clauses.every((clause) => !clause.compatible);
      return {
        compatible,
        satisfied: compatible ? [`${expressionLabel(expression)}`] : [],
        unsatisfied: compatible ? [] : [`Requires ${expressionLabel(expression)}`],
        evidenceRefs: compatible ? [] : clauses.filter((clause) => clause.compatible).flatMap((clause) => clause.evidenceRefs),
      };
    }
  }
};

const componentOrigin = (component: ComponentDefinition): string => component.source.origin;
const numericPriority = (component: ComponentDefinition): number => Number.isFinite(component.priority ?? 0) ? component.priority ?? 0 : 0;
const compareComponents = (left: ComponentDefinition, right: ComponentDefinition): number =>
  (COMPONENT_TYPE_ORDER.indexOf(left.type) - COMPONENT_TYPE_ORDER.indexOf(right.type)) ||
  (numericPriority(right) - numericPriority(left)) ||
  left.id.localeCompare(right.id);

const viewFor = (definition: ComponentDefinition, input: CompatibilityInput, incompatibleOverride?: "approved" | "rejected"): ComponentView => ({
  definition,
  compatibility: evaluateCompatibility(definition.compatibility, input),
  origin: componentOrigin(definition),
  ...(incompatibleOverride === undefined ? {} : { incompatibleOverride }),
});

export const compareComponentDefinitions = compareComponents;

/** Returns only compatible components in deterministic type/priority/id order. */
export const recommendComponents = (components: readonly ComponentDefinition[], input: CompatibilityInput): readonly ComponentView[] =>
  [...components].sort(compareComponents).map((component) => viewFor(component, input)).filter((view) => view.compatibility.compatible);

export interface ManualComponentGroups {
  readonly groups: readonly ComponentGroup[];
  readonly components: readonly ComponentView[];
}

/** Returns the complete manual inventory, grouped without dropping incompatible entries. */
export const groupComponentsByType = (components: readonly ComponentDefinition[], input: CompatibilityInput): ManualComponentGroups => {
  const views = [...components].sort(compareComponents).map((component) => viewFor(component, input));
  const groups = COMPONENT_TYPE_ORDER.map((type) => ({
    type,
    components: views.filter((view) => view.definition.type === type),
  })).filter((group) => group.components.length > 0);
  return { groups, components: views };
};

export const createComponentSelectionView = (components: readonly ComponentDefinition[], input: CompatibilityInput, manual = false): ComponentSelectionView => {
  if (manual) {
    const grouped = groupComponentsByType(components, input);
    return { components: grouped.components, groups: grouped.groups };
  }
  return { components: recommendComponents(components, input) };
};

export const removeComponentRecommendations = <T extends { readonly definition: ComponentDefinition }>(
  recommendations: readonly T[],
  removedIds: readonly string[],
): readonly T[] => {
  const removed = new Set(removedIds);
  return recommendations.filter((recommendation) => !removed.has(recommendation.definition.id));
};

export const removeRecommendations = removeComponentRecommendations;

export type IncompatibleOverride = "approve" | "reject";

export interface ComponentOverrideDecision {
  readonly componentId: string;
  readonly decision: IncompatibleOverride;
}

export interface ComponentSelectionResolution {
  readonly selected: readonly ComponentView[];
  readonly excluded: readonly ComponentView[];
  readonly requiresConfirmation: readonly ComponentView[];
  readonly incompatible: readonly ComponentView[];
}

/**
 * Applies explicit user decisions to selected component IDs. An incompatible
 * component without a decision is not selected and remains in requiresConfirmation.
 */
export const resolveComponentSelection = (
  components: readonly ComponentDefinition[],
  input: CompatibilityInput,
  selectedIds: readonly string[],
  overrides: readonly ComponentOverrideDecision[] = [],
): ComponentSelectionResolution => {
  const selected = new Set(selectedIds);
  const decisions = new Map(overrides.map((override) => [override.componentId, override.decision]));
  const selectedViews: ComponentView[] = [];
  const excluded: ComponentView[] = [];
  const requiresConfirmation: ComponentView[] = [];
  const incompatible: ComponentView[] = [];
  for (const definition of [...components].sort(compareComponents)) {
    if (!selected.has(definition.id)) continue;
    const override = decisions.get(definition.id);
    const view = viewFor(definition, input, override === "approve" ? "approved" : override === "reject" ? "rejected" : undefined);
    if (view.compatibility.compatible) {
      selectedViews.push(view);
      continue;
    }
    incompatible.push(view);
    if (override === "approve") selectedViews.push(viewFor(definition, input, "approved"));
    else if (override === "reject") excluded.push(viewFor(definition, input, "rejected"));
    else requiresConfirmation.push(view);
  }
  return { selected: selectedViews, excluded, requiresConfirmation, incompatible };
};

export const applyIncompatibleOverrides = resolveComponentSelection;

export interface ModeOption {
  readonly value: "auto" | "manual";
  readonly label: string;
}

export const VALID_MODE_OPTIONS: readonly ModeOption[] = [
  { value: "auto", label: "Automatic" },
  { value: "manual", label: "Manual" },
];

export interface InvalidModeError {
  readonly code: "INVALID_MODE";
  readonly message: string;
  readonly received: unknown;
  readonly validModes: readonly ("auto" | "manual")[];
}

export const isRunMode = (value: unknown): value is "auto" | "manual" => value === "auto" || value === "manual";

export const parseRunMode = (value: unknown): { readonly ok: true; readonly value: "auto" | "manual" } | { readonly ok: false; readonly error: InvalidModeError } =>
  isRunMode(value)
    ? { ok: true, value }
    : { ok: false, error: { code: "INVALID_MODE", message: "Mode must be auto or manual", received: value, validModes: ["auto", "manual"] } };

export const parseMode = parseRunMode;
export const modeOptions = (): readonly ModeOption[] => VALID_MODE_OPTIONS.map((option) => ({ ...option }));

/** Pure mode-selection helper for an injected prompt. */
export const chooseRunMode = async (
  initial: unknown,
  prompt: (options: readonly ModeOption[], invalid?: InvalidModeError) => Promise<unknown>,
): Promise<"auto" | "manual"> => {
  const parsed = parseRunMode(initial);
  if (parsed.ok) return parsed.value;
  let candidate: unknown = await prompt(modeOptions(), parsed.error);
  while (true) {
    const next = parseRunMode(candidate);
    if (next.ok) return next.value;
    candidate = await prompt(modeOptions(), next.error);
  }
};

export const buildCliRecommendationPlanEntries = (recommendations: readonly CliRecommendation[]): readonly CliRecommendationPlanEntry[] =>
  recommendations.map(toCliRecommendationPlanEntry);
export const evaluateCompatibilityExpression = evaluateCompatibility;
export const recommendComponentSelection = recommendComponents;
export const groupComponents = groupComponentsByType;
