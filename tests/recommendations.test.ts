import { describe, expect, it } from "vitest";
import {
  applyIncompatibleOverrides,
  chooseRunMode,
  createComponentSelectionView,
  evaluateCompatibility,
  groupComponentsByType,
  noCliRecommendationsMessage,
  parseRunMode,
  recommendClis,
  removeRecommendations,
  toCliRecommendationPlanEntry,
} from "../src/domain/index.js";
import type { ComponentDefinition, ConfirmedStack, StackItem } from "../src/domain/index.js";

const componentId = (value: string) => value as never;
const evidence = (path: string, value: string, detectorId: string) => ({
  path: path as never,
  format: "json" as const,
  location: "1:1",
  recognizedValue: value,
  detectorId,
});
const item = (category: StackItem["category"], id: string, displayName: string, path: string): StackItem => ({
  category,
  id,
  displayName,
  confidence: "explicit",
  evidence: [evidence(path, id, `detector.${id}`)],
});
const stack = (items: readonly StackItem[]): ConfirmedStack => ({ items, resolvedConflicts: [], digest: "a".repeat(64) as never });
const inputFor = (items: readonly StackItem[]) => ({ stack: stack(items), cliRecommendations: recommendClis(stack(items)) });
const builtin = (
  id: string,
  type: ComponentDefinition["type"],
  compatibility: ComponentDefinition["compatibility"],
  priority?: number,
): ComponentDefinition => ({
  id: componentId(id),
  type,
  name: id,
  description: `${id} description`,
  compatibility,
  source: { kind: "builtin", origin: "auto-ai-setup" },
  ...(priority === undefined ? {} : { priority }),
});

describe("pure CLI recommendations", () => {
  it("deduplicates related evidence and uses stable initial CLI ordering", () => {
    const confirmed = stack([
      item("tool", "tool.github-actions", "GitHub Actions", ".github/workflows/ci.yml"),
      item("tool", "tool.github", "GitHub", ".github/workflows/ci.yml"),
      item("tool", "tool.supabase", "Supabase", "supabase/config.toml"),
      item("tool", "tool.vercel", "Vercel", "vercel.json"),
      item("tool", "tool.playwright", "Playwright", "playwright.config.ts"),
    ]);
    const recommendations = recommendClis(confirmed);
    expect(recommendations.map((recommendation) => recommendation.cli)).toEqual(["gh", "supabase", "vercel", "playwright"]);
    expect(recommendations[0]?.evidenceRefs).toHaveLength(2);
    expect(recommendations[0]?.technologies).toEqual(["GitHub", "GitHub Actions"]);
    expect(recommendations.every((recommendation) => recommendation.explanation && recommendation.documentedInstructions)).toBe(true);
  });

  it("returns no recommendation for an unrelated stack and emits documentation-only plan entries", () => {
    const recommendations = recommendClis(stack([item("framework", "framework.react", "React", "package.json")]));
    expect(recommendations).toEqual([]);
    expect(noCliRecommendationsMessage).toContain("No CLI recommendations");
    const withCli = recommendClis(stack([item("tool", "tool.vercel", "Vercel", "vercel.json")]));
    const entry = toCliRecommendationPlanEntry(withCli[0]!);
    expect(entry).toMatchObject({ action: "document", executes: false, installs: false, probes: false });
  });
});

describe("compatibility and component selection", () => {
  const items = [item("framework", "next", "Next.js", "package.json"), item("tool", "tool.vercel", "Vercel", "vercel.json")];
  const input = inputFor(items);

  it("evaluates stack, CLI, all, any, not, and noneOf expressions with explanations", () => {
    const decision = evaluateCompatibility(
      {
        op: "all",
        clauses: [
          { op: "stack", category: "framework", oneOf: ["next"] },
          { op: "cli", oneOf: ["vercel"] },
        ],
      },
      input,
    );
    expect(decision.compatible).toBe(true);
    expect(decision.evidenceRefs).toContain("package.json#1:1:detector.next:next");
    const incompatible = evaluateCompatibility({ op: "noneOf", clauses: [{ op: "stack", category: "framework", oneOf: ["next"] }] }, input);
    expect(incompatible.compatible).toBe(false);
    expect(incompatible.unsatisfied[0]).toContain("none of");
  });

  it("orders automatic results, groups the manual inventory, and removes individual recommendations", () => {
    const components = [
      builtin("rule.next", "agent-rule", { op: "always" }),
      builtin("skill.vercel", "skill", { op: "cli", oneOf: ["vercel"] }, 1),
      builtin("mcp.next", "mcp-server", { op: "stack", category: "framework", oneOf: ["next"] }, 2),
      builtin("command.never", "agent-command", { op: "stack", category: "framework", oneOf: ["vue"] }),
    ];
    const automatic = createComponentSelectionView(components, input);
    expect(automatic.components.map((view) => view.definition.id)).toEqual([
      componentId("skill.vercel"),
      componentId("mcp.next"),
      componentId("rule.next"),
    ]);
    const manual = groupComponentsByType(components, input);
    expect(manual.groups.map((group) => group.type)).toEqual(["skill", "mcp-server", "agent-rule", "agent-command"]);
    expect(manual.components).toHaveLength(4);
    expect(removeRecommendations(automatic.components, [componentId("mcp.next")])).toHaveLength(2);
  });

  it("requires explicit decisions for incompatible components and records approve/reject", () => {
    const component = builtin("skill.vue", "skill", { op: "stack", category: "framework", oneOf: ["vue"] });
    const pending = applyIncompatibleOverrides([component], input, [component.id]);
    expect(pending.selected).toHaveLength(0);
    expect(pending.requiresConfirmation[0]?.compatibility.unsatisfied[0]).toContain("framework");
    const approved = applyIncompatibleOverrides([component], input, [component.id], [{ componentId: component.id, decision: "approve" }]);
    expect(approved.selected[0]?.incompatibleOverride).toBe("approved");
    const rejected = applyIncompatibleOverrides([component], input, [component.id], [{ componentId: component.id, decision: "reject" }]);
    expect(rejected.excluded[0]?.incompatibleOverride).toBe("rejected");
  });
});

describe("mode selection", () => {
  it("accepts only auto/manual and re-prompts with both options", async () => {
    expect(parseRunMode("auto")).toEqual({ ok: true, value: "auto" });
    const invalid = parseRunMode("headless");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.validModes).toEqual(["auto", "manual"]);
    const prompts: unknown[] = [];
    const mode = await chooseRunMode("invalid", async (options, error) => {
      prompts.push({ options, error });
      return prompts.length === 1 ? "also-invalid" : "manual";
    });
    expect(mode).toBe("manual");
    expect(prompts).toHaveLength(2);
    expect((prompts[0] as { options: readonly { value: string }[] }).options.map((option) => option.value)).toEqual(["auto", "manual"]);
  });
});
