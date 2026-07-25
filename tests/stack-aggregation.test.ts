import { describe, expect, it } from "vitest";
import {
  DefaultStackDetectorRegistry,
  aggregateDetections,
  asSafeProjectPath,
  createStackViewModel,
  evaluateCapabilities,
  parseRecognizedEvidence,
  resolveStackConflicts,
  shouldOfferManualFallback,
  suspendDependentRecommendations,
} from "../src/domain/index.js";
import type { CliRecommendation, DetectionClaim, StackCapability, StackEvidence } from "../src/domain/index.js";

const evidence = (overrides: Partial<StackEvidence> = {}): StackEvidence => ({
  path: "package.json" as never,
  format: "json",
  location: "1:1",
  recognizedValue: "react=present",
  detectorId: "framework.react",
  ...overrides,
});

const claim = (overrides: Partial<DetectionClaim> = {}): DetectionClaim => ({
  category: "framework",
  id: "react",
  displayName: "React",
  confidence: "explicit",
  evidence: evidence(),
  ...overrides,
});

describe("stack aggregation and views", () => {
  it("consolida claims, deduplica evidencia exacta y conserva todas las referencias", () => {
    const analysis = aggregateDetections([
      claim({ confidence: "derived", evidence: evidence({ detectorId: "language.extension", recognizedValue: "package.json" }) }),
      claim(),
      claim({
        evidence: evidence({
          path: "src/main.ts" as never,
          format: "source-extension",
          recognizedValue: "src/main.ts",
          detectorId: "language.typescript",
        }),
      }),
    ]);
    expect(analysis.items).toHaveLength(1);
    expect(analysis.items[0]?.confidence).toBe("explicit");
    expect(analysis.items[0]?.evidence).toHaveLength(3);
    const view = createStackViewModel(analysis);
    expect(view.items[0]?.evidenceRefs).toEqual([
      "package.json#1:1:language.extension:package.json",
      "package.json#1:1:framework.react:react=present",
      "src/main.ts#1:1:language.typescript:src/main.ts",
    ]);
    expect(view.manualFallback).toBe(false);
  });

  it("agrega detecciones reales del registro de detectores de forma estable", () => {
    const path = asSafeProjectPath("package.json");
    expect(path.ok).toBe(true);
    if (!path.ok) return;
    const parsed = parseRecognizedEvidence(
      path.value,
      new TextEncoder().encode(JSON.stringify({ dependencies: { react: "18", vitest: "1" } })),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const registry = new DefaultStackDetectorRegistry();
    const claims = registry.find(path.value).flatMap((detector) => detector.detect(parsed.value));
    const analysis = aggregateDetections(claims, { analyzedFileCount: 1, analyzedBytes: 64, elapsedMs: 3 });
    expect(analysis.items.map((item) => item.id)).toEqual(["javascript", "typescript", "npm", "framework.react", "tool.vitest"]);
    expect(analysis.items.every((item) => item.evidence.length > 0)).toBe(true);
    expect(analysis.withinPerformanceProfile).toBe(true);
  });

  it("detecta valores incompatibles por categoría y no confunde categorías coexistentes con conflictos", () => {
    const analysis = aggregateDetections(
      [
        claim({ category: "package-manager", id: "npm", displayName: "npm", evidence: evidence({ recognizedValue: "package-lock.json" }) }),
        claim({
          category: "package-manager",
          id: "pnpm",
          displayName: "pnpm",
          evidence: evidence({
            path: "pnpm-lock.yaml" as never,
            format: "yaml",
            recognizedValue: "pnpm-lock.yaml",
            detectorId: "package-manager.pnpm",
          }),
        }),
        claim({
          category: "language",
          id: "typescript",
          displayName: "TypeScript",
          evidence: evidence({
            path: "src/main.ts" as never,
            format: "source-extension",
            recognizedValue: "src/main.ts",
            detectorId: "language.typescript",
          }),
        }),
        claim({
          category: "language",
          id: "javascript",
          displayName: "JavaScript",
          evidence: evidence({
            path: "src/index.js" as never,
            format: "source-extension",
            recognizedValue: "src/index.js",
            detectorId: "language.javascript",
          }),
        }),
      ],
      { blocksCapabilities: { "package-manager": ["skill.node" as never] } },
    );
    expect(analysis.conflicts).toHaveLength(1);
    expect(analysis.conflicts[0]?.category).toBe("package-manager");
    expect(analysis.conflicts[0]?.candidates.map((candidate) => candidate.id)).toEqual(["npm", "pnpm"]);
    expect(analysis.conflicts[0]?.blocksCapabilities).toEqual(["skill.node"]);
    expect(analysis.items.filter((item) => item.category === "language")).toHaveLength(2);
  });

  it("descarta el gestor de paquetes derivado cuando un lockfile aporta evidencia explícita", () => {
    const analysis = aggregateDetections([
      claim({
        category: "package-manager",
        id: "npm",
        displayName: "npm",
        confidence: "derived",
        evidence: evidence({ recognizedValue: "package.json", detectorId: "package-manager.npm" }),
      }),
      claim({
        category: "package-manager",
        id: "pnpm",
        displayName: "pnpm",
        evidence: evidence({
          path: "pnpm-lock.yaml" as never,
          format: "yaml",
          recognizedValue: "pnpm-lock.yaml",
          detectorId: "package-manager.pnpm",
        }),
      }),
    ]);
    expect(analysis.conflicts).toHaveLength(0);
    expect(analysis.items.map((item) => item.id)).toEqual(["pnpm"]);
  });

  it("conserva el gestor derivado cuando es la única evidencia disponible", () => {
    const analysis = aggregateDetections([
      claim({
        category: "package-manager",
        id: "npm",
        displayName: "npm",
        confidence: "derived",
        evidence: evidence({ recognizedValue: "package.json", detectorId: "package-manager.npm" }),
      }),
    ]);
    expect(analysis.conflicts).toHaveLength(0);
    expect(analysis.items.map((item) => item.id)).toEqual(["npm"]);
  });

  it("mantiene el conflicto cuando dos lockfiles reales coexisten", () => {
    const registry = new DefaultStackDetectorRegistry();
    const detect = (path: string, text: string) => {
      const safe = asSafeProjectPath(path);
      if (!safe.ok) throw new Error(safe.error.message);
      const format = path.endsWith(".yaml") ? "yaml" : path.endsWith(".json") ? "json" : "lockfile";
      const parsed = parseRecognizedEvidence(safe.value, new TextEncoder().encode(text), { format });
      if (!parsed.ok) throw new Error(parsed.error.message);
      return registry.find(safe.value).flatMap((detector) => detector.detect(parsed.value));
    };
    const manifestOnly = aggregateDetections(detect("package.json", '{"name":"demo"}'));
    const withPnpmLock = aggregateDetections([
      ...detect("package.json", '{"name":"demo"}'),
      ...detect("pnpm-lock.yaml", "lockfileVersion: 9.0\n"),
    ]);
    const twoLockfiles = aggregateDetections([
      ...detect("package-lock.json", '{"lockfileVersion":3}'),
      ...detect("pnpm-lock.yaml", "lockfileVersion: 9.0\n"),
    ]);
    expect(manifestOnly.items.filter((item) => item.category === "package-manager").map((item) => item.id)).toEqual(["npm"]);
    expect(manifestOnly.conflicts).toHaveLength(0);
    expect(withPnpmLock.items.filter((item) => item.category === "package-manager").map((item) => item.id)).toEqual(["pnpm"]);
    expect(withPnpmLock.conflicts).toHaveLength(0);
    expect(twoLockfiles.conflicts).toHaveLength(1);
    expect(twoLockfiles.conflicts[0]?.candidates.map((candidate) => candidate.id)).toEqual(["npm", "pnpm"]);
  });
});

describe("stack conflict resolution and selective suspension", () => {
  const conflictingAnalysis = () =>
    aggregateDetections([
      claim({ category: "package-manager", id: "npm", displayName: "npm", evidence: evidence({ recognizedValue: "package-lock.json" }) }),
      claim({
        category: "package-manager",
        id: "pnpm",
        displayName: "pnpm",
        evidence: evidence({
          path: "pnpm-lock.yaml" as never,
          format: "yaml",
          recognizedValue: "pnpm-lock.yaml",
          detectorId: "package-manager.pnpm",
        }),
      }),
      claim({ category: "framework", id: "react", displayName: "React" }),
    ]);

  it("requires an explicit value and returns a deterministic confirmed stack", () => {
    const analysis = conflictingAnalysis();
    const missing = resolveStackConflicts(analysis, {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.candidates).toEqual(["npm", "pnpm"]);
    const resolved = resolveStackConflicts(analysis, { "package-manager": "pnpm" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.items.map((item) => item.id)).toEqual(["pnpm", "react"]);
    expect(resolved.value.resolvedConflicts).toHaveLength(1);
    expect(resolved.value.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(resolveStackConflicts(analysis, { "package-manager": "bun" }).ok).toBe(false);
  });

  it("blocks only capabilities depending on unresolved categories", () => {
    const analysis = conflictingAnalysis();
    const capabilities: readonly StackCapability[] = [
      { id: "node-skill", dependsOnCategories: ["package-manager"] },
      { id: "react-rule", dependsOnCategories: ["framework"] },
      { id: "generic-rule", dependsOnCategories: [] },
    ];
    expect(evaluateCapabilities(capabilities, analysis.conflicts).map((entry) => [entry.id, entry.available])).toEqual([
      ["node-skill", false],
      ["react-rule", true],
      ["generic-rule", true],
    ]);
    const recommendations: readonly CliRecommendation[] = [
      { cli: "gh", reason: "GitHub", evidenceRefs: [".github/workflows/ci.yml"] },
      { cli: "supabase", reason: "Supabase", evidenceRefs: ["package.json"] },
    ];
    const suspended = suspendDependentRecommendations(
      recommendations,
      {
        gh: ["tool"],
        supabase: ["package-manager"],
      },
      analysis.conflicts,
    );
    expect(suspended.map((recommendation) => recommendation.pending)).toEqual([undefined, true]);
  });

  it("exposes manual fallback and does not mutate the input when no stack is detected", () => {
    const analysis = aggregateDetections([], { analyzedFileCount: 2, analyzedBytes: 10 });
    const before = JSON.stringify(analysis);
    const view = createStackViewModel(analysis);
    expect(shouldOfferManualFallback(analysis)).toBe(true);
    expect(view.manualFallback).toBe(true);
    expect(view.recommendationsSuspended).toBe(true);
    expect(view.items).toEqual([]);
    expect(JSON.stringify(analysis)).toBe(before);
  });
});
