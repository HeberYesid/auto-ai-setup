import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultStackDetectorRegistry, aggregateDetections, asCanonicalPath, asSafeProjectPath, createStackViewModel, parseRecognizedEvidence, shouldOfferManualFallback } from "../src/domain/index.js";
import type { CanonicalPath, DetectionClaim } from "../src/domain/index.js";
import { BoundedAsyncScanner, defaultScanPolicy } from "../src/infrastructure/fs/scanner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded project scanning", () => {
  it("excludes dependency/build directories and does not follow symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-ai-setup-scan-"));
    roots.push(root);
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), '{"dependencies":{"react":"1"}}');
    await writeFile(join(root, "node_modules", "hidden.js"), "hidden");
    await writeFile(join(root, "src", "main.ts"), "export {};");
    try { await symlink(join(root, "src"), join(root, "linked"), "junction"); } catch { /* symlinks can be unavailable on Windows */ }
    let linkedFileCreated = false;
    try {
      await symlink(join(root, "src", "main.ts"), join(root, "linked-main.ts"), "file");
      linkedFileCreated = true;
    } catch { /* symlinks can be unavailable on Windows */ }
    const canonical = asCanonicalPath(root);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    const result = await new BoundedAsyncScanner().scan(canonical.value, defaultScanPolicy());
    const paths = result.descriptors.map((descriptor) => descriptor.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/main.ts");
    expect(paths.some((path) => path.includes("node_modules") || path.startsWith("linked/"))).toBe(false);
    if (linkedFileCreated) expect(paths).not.toContain("linked-main.ts");
    expect(result.summary.skippedDirectories).toContain("node_modules");
  });

  it("stops at file and byte limits with monotonic elapsed time", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-ai-setup-limit-"));
    roots.push(root);
    await writeFile(join(root, "a.json"), "{}\n");
    await writeFile(join(root, "b.json"), "{}\n");
    const canonical = asCanonicalPath(root);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    const result = await new BoundedAsyncScanner().scan(canonical.value, defaultScanPolicy({ maxFiles: 1, maxBytes: 100, maxFileBytes: 100 }));
    expect(result.descriptors).toHaveLength(1);
    expect(result.summary.withinLimits).toBe(false);
    expect(result.summary.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe("evidence parsing and detector registry", () => {
  it("rejects invalid JSON before a detector can produce evidence", () => {
    const path = asSafeProjectPath("package.json");
    expect(path.ok).toBe(true);
    if (!path.ok) return;
    const parsed = parseRecognizedEvidence(path.value, new TextEncoder().encode('{"dependencies":'));
    expect(parsed.ok).toBe(false);
    const schemaError = parseRecognizedEvidence(path.value, new TextEncoder().encode('{"dependencies":[]}'));
    expect(schemaError.ok).toBe(false);
    if (!schemaError.ok) expect(schemaError.error.code).toBe("INVALID_SCHEMA");
  });

  it("detects supported package/framework/tool values with complete provenance", () => {
    const path = asSafeProjectPath("package.json");
    expect(path.ok).toBe(true);
    if (!path.ok) return;
    const parsed = parseRecognizedEvidence(path.value, new TextEncoder().encode(JSON.stringify({ dependencies: { react: "18", vitest: "1" } })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const registry = new DefaultStackDetectorRegistry();
    const claims = registry.find(path.value).flatMap((detector) => detector.detect(parsed.value));
    expect(claims.map((claim) => claim.id)).toEqual(expect.arrayContaining(["npm", "framework.react", "tool.vitest"]));
    expect(claims.find((claim) => claim.category === "package-manager")?.evidence.detectorId).toBe("package-manager.npm");
    for (const claim of claims) expect(claim.evidence).toMatchObject({ path: "package.json", location: "1:1" });
  });
});


describe("project analysis fixtures and reports", () => {
  it("analyzes a valid fixture and exposes every detected evidence reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-ai-setup-valid-fixture-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "valid-fixture",
      dependencies: { react: "18.3.0", "@playwright/test": "1.0.0" },
      devDependencies: { vitest: "2.0.0" },
    }));
    await writeFile(join(root, "src", "index.ts"), "export const fixture = true;\n");

    const canonical = asCanonicalPath(root);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    const result = await analyzeFixture(canonical.value);
    const analysis = aggregateDetections(result.claims, {
      analyzedFileCount: result.scan.descriptors.length,
      analyzedBytes: result.scan.summary.bytes,
      elapsedMs: result.scan.summary.elapsedMs,
    });
    const view = createStackViewModel(analysis);

    expect(analysis.items.map((item) => item.id)).toEqual([
      "javascript", "typescript", "npm", "framework.react", "tool.playwright", "tool.vitest",
    ]);
    expect(view.items.every((item) => item.evidence.length > 0 && item.evidenceRefs.length === item.evidence.length)).toBe(true);
    expect(view.items.find((item) => item.id === "framework.react")?.evidence).toEqual([
      expect.objectContaining({ path: "package.json", recognizedValue: "react=present", location: "1:1" }),
    ]);
    expect(result.scan.summary.withinLimits).toBe(true);
  });

  it("does not detect invalid or missing evidence and offers the manual fallback", async () => {
    const invalidRoot = await mkdtemp(join(tmpdir(), "auto-ai-setup-invalid-fixture-"));
    roots.push(invalidRoot);
    await writeFile(join(invalidRoot, "package.json"), '{"dependencies":');
    const invalidCanonical = asCanonicalPath(invalidRoot);
    expect(invalidCanonical.ok).toBe(true);
    if (!invalidCanonical.ok) return;
    const invalid = await analyzeFixture(invalidCanonical.value);
    const invalidEvidence = invalid.parsed[0];
    expect(invalidEvidence).toMatchObject({ ok: false, error: { code: "INVALID_SYNTAX", path: "package.json", location: expect.stringMatching(/^\d+:\d+$/u) } });
    expect(invalid.claims).toEqual([]);

    const missingRoot = await mkdtemp(join(tmpdir(), "auto-ai-setup-missing-fixture-"));
    roots.push(missingRoot);
    await writeFile(join(missingRoot, "README.md"), "No stack manifest is present.\n");
    const missingCanonical = asCanonicalPath(missingRoot);
    expect(missingCanonical.ok).toBe(true);
    if (!missingCanonical.ok) return;
    const missing = await analyzeFixture(missingCanonical.value);
    const missingAnalysis = aggregateDetections(missing.claims, { analyzedFileCount: missing.scan.descriptors.length });
    expect(missing.claims).toEqual([]);
    expect(shouldOfferManualFallback(missingAnalysis)).toBe(true);
    expect(createStackViewModel(missingAnalysis)).toMatchObject({ manualFallback: true, recommendationsSuspended: true, items: [] });
  });

  it("shows both values and provenance when valid fixtures conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-ai-setup-conflict-fixture-"));
    roots.push(root);
    await writeFile(join(root, "package-lock.json"), "{}\n");
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const canonical = asCanonicalPath(root);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    const result = await analyzeFixture(canonical.value);
    const analysis = aggregateDetections(result.claims, { blocksCapabilities: { "package-manager": ["skill.node" as never] } });
    const view = createStackViewModel(analysis);
    const conflict = view.conflicts.find((entry) => entry.category === "package-manager");

    expect(conflict?.candidates.map((candidate) => candidate.id)).toEqual(["npm", "pnpm"]);
    expect(conflict?.candidates.flatMap((candidate) => candidate.evidence.map((entry) => [entry.path, entry.recognizedValue]))).toEqual([
      ["package-lock.json", "package-lock.json"],
      ["pnpm-lock.yaml", "pnpm-lock.yaml"],
    ]);
    expect(conflict?.blocksCapabilities).toEqual(["skill.node"]);
  });

  it("reports bounded file and byte skips while preserving deterministic scan accounting", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-ai-setup-bounded-report-"));
    roots.push(root);
    await writeFile(join(root, "a.ts"), "a");
    await writeFile(join(root, "b.ts"), "bb");
    await writeFile(join(root, "too-large.ts"), "large");
    const canonical = asCanonicalPath(root);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;

    const byteLimited = await new BoundedAsyncScanner().scan(canonical.value, defaultScanPolicy({ maxFiles: 10, maxBytes: 2, maxFileBytes: 100 }));
    expect(byteLimited.descriptors.map((descriptor) => descriptor.path)).toEqual(["a.ts"]);
    expect(byteLimited.summary).toMatchObject({ files: 1, bytes: 1, skippedFiles: 1, skippedBytes: 2, withinLimits: false });
    expect(byteLimited.summary.elapsedMs).toBeGreaterThanOrEqual(0);

    const fileLimited = await new BoundedAsyncScanner().scan(canonical.value, defaultScanPolicy({ maxFiles: 10, maxBytes: 100, maxFileBytes: 3 }));
    expect(fileLimited.descriptors.map((descriptor) => descriptor.path)).toEqual(["a.ts", "b.ts"]);
    expect(fileLimited.summary).toMatchObject({ files: 2, bytes: 3, skippedFiles: 1, skippedBytes: 5, withinLimits: false });
  });
});

interface FixtureAnalysis {
  readonly scan: Awaited<ReturnType<BoundedAsyncScanner["scan"]>>;
  readonly claims: DetectionClaim[];
  readonly parsed: readonly ReturnType<typeof parseRecognizedEvidence>[];
}

const analyzeFixture = async (root: CanonicalPath): Promise<FixtureAnalysis> => {
  const scan = await new BoundedAsyncScanner().scan(root, defaultScanPolicy());
  const registry = new DefaultStackDetectorRegistry();
  const parsed: ReturnType<typeof parseRecognizedEvidence>[] = [];
  const claims: DetectionClaim[] = [];
  for (const descriptor of scan.descriptors) {
    const evidence = parseRecognizedEvidence(descriptor.path, await readFile(join(root, descriptor.path)));
    parsed.push(evidence);
    if (!evidence.ok) continue;
    for (const detector of registry.find(descriptor.path)) claims.push(...detector.detect(evidence.value));
  }
  return { scan, claims, parsed };
};
