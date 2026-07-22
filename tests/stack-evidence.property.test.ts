import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { DefaultStackDetectorRegistry, asSafeProjectPath, parseRecognizedEvidence } from "../src/domain/index.js";
import type { DetectionClaim, ParsedEvidence, SafeProjectPath } from "../src/domain/index.js";
import { deterministicFastCheckParameters } from "./support/fast-check.js";

type EvidenceCase =
  | { readonly kind: "valid"; readonly path: SafeProjectPath; readonly source: Uint8Array }
  | { readonly kind: "invalid"; readonly path: SafeProjectPath; readonly source: Uint8Array }
  | { readonly kind: "unreadable"; readonly path: SafeProjectPath }
  | { readonly kind: "absent"; readonly path: SafeProjectPath };

const safePath = (value: string): SafeProjectPath => {
  const result = asSafeProjectPath(value);
  if (!result.ok) throw new Error(`Invalid test path: ${value}`);
  return result.value;
};

const packagePath = safePath("package.json");
const sourcePath = safePath("src/index.ts");
const pythonManifestPath = safePath("pyproject.toml");
const registry = new DefaultStackDetectorRegistry();

const validEvidenceArbitrary: fc.Arbitrary<EvidenceCase> = fc.oneof(
  fc
    .record({
      dependency: fc.constantFrom("react", "vitest", "playwright", "express", "vercel"),
      version: fc.constantFrom("1.0.0", "^18.0.0", "workspace:*"),
    })
    .map(({ dependency, version }) => ({
      kind: "valid" as const,
      path: packagePath,
      source: new TextEncoder().encode(JSON.stringify({ dependencies: { [dependency]: version } })),
    })),
  fc.constant({
    kind: "valid" as const,
    path: sourcePath,
    source: new TextEncoder().encode("export const detected = true;\n"),
  }),
  fc
    .record({
      framework: fc.constantFrom("django", "fastapi"),
      version: fc.constantFrom("4.2", "0.115"),
    })
    .map(({ framework, version }) => ({
      kind: "valid" as const,
      path: pythonManifestPath,
      source: new TextEncoder().encode(`${framework} = "${version}"\n`),
    })),
);

const invalidEvidenceArbitrary: fc.Arbitrary<EvidenceCase> = fc.constantFrom(
  {
    kind: "invalid" as const,
    path: packagePath,
    source: new TextEncoder().encode('{"dependencies":'),
  },
  {
    kind: "invalid" as const,
    path: packagePath,
    source: new TextEncoder().encode('{"dependencies":[]}'),
  },
  {
    kind: "invalid" as const,
    path: pythonManifestPath,
    source: new TextEncoder().encode("django ="),
  },
);

const unavailableEvidenceArbitrary: fc.Arbitrary<EvidenceCase> = fc.oneof(
  fc.constant({ kind: "unreadable" as const, path: packagePath }),
  fc.constant({ kind: "absent" as const, path: packagePath }),
);

const evidenceArbitrary: fc.Arbitrary<EvidenceCase> = fc.oneof(
  validEvidenceArbitrary,
  invalidEvidenceArbitrary,
  unavailableEvidenceArbitrary,
);

const detect = (evidence: EvidenceCase): readonly DetectionClaim[] => {
  if (evidence.kind !== "valid") return [];
  const parsed = parseRecognizedEvidence(evidence.path, evidence.source);
  if (!parsed.ok) return [];
  return claimsFor(parsed.value);
};

const claimsFor = (evidence: ParsedEvidence): readonly DetectionClaim[] =>
  registry.find(evidence.path).flatMap((detector) => detector.detect(evidence));

// Feature: auto-ai-setup, Property 3: Toda detección válida tiene provenance completa
// **Validates: Requirements 2.1–2.6, 2.9–2.10**
describe("Property 3: toda detección válida tiene provenance completa", () => {
  it("emits complete provenance only for syntactically valid evidence", () => {
    fc.assert(
      fc.property(evidenceArbitrary, (evidence) => {
        if (evidence.kind === "invalid") {
          const parsed = parseRecognizedEvidence(evidence.path, evidence.source);
          expect(parsed.ok).toBe(false);
        }

        const claims = detect(evidence);
        if (evidence.kind !== "valid") {
          expect(claims).toHaveLength(0);
          return;
        }

        expect(claims.length).toBeGreaterThan(0);
        for (const claim of claims) {
          expect(claim.evidence.path).toBe(String(evidence.path));
          expect(claim.evidence.location).toMatch(/^\d+:\d+$/u);
          expect(claim.evidence.recognizedValue).toBeTruthy();
        }
      }),
      deterministicFastCheckParameters(24027, 100),
    );
  });
});
