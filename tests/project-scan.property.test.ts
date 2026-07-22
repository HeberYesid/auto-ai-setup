import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  DefaultStackDetectorRegistry,
  aggregateDetections,
  asCanonicalPath,
  isRecognizedEvidencePath,
  parseRecognizedEvidence,
} from "../src/domain/index.js";
import { BoundedAsyncScanner, DEFAULT_EXCLUDED_DIRECTORIES, defaultScanPolicy } from "../src/infrastructure/fs/scanner.js";
import type { ScanClock } from "../src/infrastructure/fs/scanner.js";
import { deterministicFastCheckParameters } from "./support/fast-check.js";

const PERFORMANCE_FILE_LIMIT = 10_000;
const PERFORMANCE_BYTE_LIMIT = 500_000_000;

const includedPathArbitrary = fc.uniqueArray(
  fc.constantFrom("src/index.ts", "src/main.js", "README.md", "config.toml", ".github/workflows/ci.yml"),
  { minLength: 0, maxLength: 5 },
);

const profileMeasurementArbitrary = fc.oneof(
  fc.record({
    files: fc.integer({ min: 0, max: PERFORMANCE_FILE_LIMIT }),
    bytes: fc.integer({ min: 0, max: PERFORMANCE_BYTE_LIMIT }),
  }),
  fc.record({
    files: fc.integer({ min: PERFORMANCE_FILE_LIMIT + 1, max: PERFORMANCE_FILE_LIMIT + 20 }),
    bytes: fc.integer({ min: 0, max: PERFORMANCE_BYTE_LIMIT }),
  }),
  fc.record({
    files: fc.integer({ min: 0, max: PERFORMANCE_FILE_LIMIT }),
    bytes: fc.integer({ min: PERFORMANCE_BYTE_LIMIT + 1, max: PERFORMANCE_BYTE_LIMIT + 20_000 }),
  }),
);

const fixtureArbitrary = fc.record({
  includedPaths: includedPathArbitrary,
  profile: profileMeasurementArbitrary,
});

class FixedScanClock implements ScanClock {
  private calls = 0;

  monotonicMs(): number {
    this.calls += 1;
    return this.calls === 1 ? 100 : 117;
  }
}

const contentFor = (path: string): string => {
  if (path === "package.json") return JSON.stringify({ name: "fixture", dependencies: { react: "18", vitest: "1" } });
  if (path.endsWith(".ts") || path.endsWith(".js")) return "export {};\n";
  if (path.endsWith(".toml")) return 'name = "fixture"\n';
  if (path.endsWith(".yml")) return "name: fixture\n";
  return "fixture\n";
};

const writeFixture = async (root: string, includedPaths: readonly string[]): Promise<readonly string[]> => {
  const paths = ["package.json", ...includedPaths.filter((path) => path !== "package.json")];
  await Promise.all(
    paths.map(async (path) => {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, contentFor(path));
    }),
  );
  await Promise.all(
    DEFAULT_EXCLUDED_DIRECTORIES.map(async (directory) => {
      const absolute = join(root, directory, "package.json");
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, contentFor("package.json"));
    }),
  );
  return paths;
};

const isExcludedPath = (path: string): boolean => {
  const firstSegment = path.split("/")[0]?.toLowerCase();
  return firstSegment !== undefined && DEFAULT_EXCLUDED_DIRECTORIES.some((directory) => directory.toLowerCase() === firstSegment);
};

// Feature: auto-ai-setup, Property 24: Recorrido excluido y clasificación del perfil
// **Validates: Requirements 12.4–12.11**
describe("Property 24: recorrido excluido y clasificación del perfil", () => {
  it("excludes generated dependency/VCS/build/coverage trees and classifies generated profile measurements", async () => {
    await fc.assert(
      fc.asyncProperty(fixtureArbitrary, async ({ includedPaths, profile }) => {
        const root = await mkdtemp(join(tmpdir(), "auto-ai-setup-property-24-"));
        try {
          const expectedPaths = await writeFixture(root, includedPaths);
          const canonical = asCanonicalPath(root);
          expect(canonical.ok).toBe(true);
          if (!canonical.ok) return;

          const scanner = new BoundedAsyncScanner(new FixedScanClock());
          const expectedBytes = (
            await Promise.all(expectedPaths.map(async (path) => (await readFile(join(root, path))).byteLength))
          ).reduce((total, bytes) => total + bytes, 0);
          const result = await scanner.scan(
            canonical.value,
            defaultScanPolicy({
              maxFiles: expectedPaths.length + 1,
              maxBytes: expectedBytes + 1,
              maxFileBytes:
                Math.max(...(await Promise.all(expectedPaths.map(async (path) => (await readFile(join(root, path))).byteLength)))) + 1,
            }),
          );
          const emittedPaths = result.descriptors.map((descriptor) => String(descriptor.path));

          expect(new Set(emittedPaths)).toEqual(new Set(expectedPaths));
          expect(emittedPaths.some(isExcludedPath)).toBe(false);
          expect(result.summary.files).toBe(emittedPaths.length);
          expect(result.summary.bytes).toBe(expectedBytes);
          expect(result.summary.skippedFiles).toBe(0);
          expect(result.summary.skippedBytes).toBe(0);
          expect(result.summary.elapsedMs).toBe(17);
          expect(result.summary.withinLimits).toBe(true);
          expect(new Set(result.summary.skippedDirectories)).toEqual(new Set(DEFAULT_EXCLUDED_DIRECTORIES));

          const registry = new DefaultStackDetectorRegistry();
          const detectorInputs: string[] = [];
          const claims = [];
          for (const descriptor of result.descriptors) {
            const path = String(descriptor.path);
            if (!isRecognizedEvidencePath(path)) continue;
            const parsed = parseRecognizedEvidence(descriptor.path, await readFile(join(root, path)));
            if (!parsed.ok) continue;
            for (const detector of registry.find(descriptor.path)) {
              detectorInputs.push(path);
              claims.push(...detector.detect(parsed.value));
            }
          }
          expect(detectorInputs.every((path) => expectedPaths.includes(path))).toBe(true);
          expect(detectorInputs.some(isExcludedPath)).toBe(false);
          expect(claims.every((claim) => !isExcludedPath(String(claim.evidence.path)))).toBe(true);

          const analysis = aggregateDetections(claims, {
            analyzedFileCount: profile.files,
            analyzedBytes: profile.bytes,
            elapsedMs: result.summary.elapsedMs,
          });
          expect(analysis.analyzedFileCount).toBe(profile.files);
          expect(analysis.analyzedBytes).toBe(profile.bytes);
          expect(analysis.elapsedMs).toBe(17);
          expect(analysis.withinPerformanceProfile).toBe(
            profile.files <= PERFORMANCE_FILE_LIMIT && profile.bytes <= PERFORMANCE_BYTE_LIMIT,
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      deterministicFastCheckParameters(24028, 100),
    );
  });
});
