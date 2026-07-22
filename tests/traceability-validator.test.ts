import { describe, expect, it } from "vitest";
import { formatTraceabilityReport, parseRequirementIds, validateTraceability } from "../src/infrastructure/traceability/index.js";
import type { TraceabilityInput } from "../src/infrastructure/traceability/models.js";

const document = (path: string, content: string) => ({ path, content });
const requirements = document(
  "requirements.md",
  `# Requirements\n\n### Requirement 1\n#### Acceptance Criteria\n1. First\n2. Second\n\n### Requirement 2\n#### Acceptance Criteria\n1. Third`,
);
const coverage = document("traceability.md", "- unit: Requirements 1.1–1.2\n- smoke: Requirements 2.1");

const input = (overrides: Partial<TraceabilityInput> = {}): TraceabilityInput => ({
  requirements,
  tasks: document("tasks.md", "_Requirements: 1.1–1.2_"),
  tests: [document("tests/example.property.test.ts", "// **Validates: Requirements 2.1**")],
  coverage,
  ...overrides,
});

describe("SDD traceability validator", () => {
  it("parses criteria and expands inclusive requirement ranges", () => {
    expect(parseRequirementIds(requirements).map(({ id }) => id)).toEqual(["1.1", "1.2", "2.1"]);
  });

  it("accepts valid task, property, and designated coverage references", () => {
    const report = validateTraceability(input());
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(formatTraceabilityReport(report)).toContain("validation passed");
  });

  it("reports an unknown requirement reference with source location", () => {
    const marker = "Req" + "uirements";
    const unknown = ["_", marker, " ", "9.9", "_"].join("");
    const report = validateTraceability(input({ tasks: document("tasks.md", unknown) }));
    expect(report.ok).toBe(false);
    const unknownCode = ["UNKNOWN", "REQUIREMENT", "REFERENCE"].join("_");
    const unknownId = [9, 9].join(".");
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: unknownCode, requirementId: unknownId, path: "tasks.md", line: 1 }),
    );
    expect(formatTraceabilityReport(report)).toContain("tasks.md:1");
  });

  it("reports every requirement without a designated check", () => {
    const report = validateTraceability(input({ coverage: undefined }));
    expect(report.issues.filter((issue) => issue.code === "MISSING_COVERAGE").map((issue) => issue.requirementId)).toEqual(["1.1", "1.2"]);
  });

  it("uses property validation markers as property coverage", () => {
    const report = validateTraceability(input({ coverage: undefined }));
    expect(report.issues.filter((issue) => issue.code === "MISSING_COVERAGE").map((issue) => issue.requirementId)).toEqual(["1.1", "1.2"]);
    expect(report.coverage).toContainEqual(expect.objectContaining({ id: "2.1", kind: "property" }));
  });

  it("orders diagnostics deterministically by path, line, requirement, and code", () => {
    const marker = "Req" + "uirements";
    const unknown = ["**Validates: ", marker, " ", "8.1**"].join("");
    const report = validateTraceability(input({ tasks: document("z-tasks.md", unknown), tests: [document("a.test.ts", unknown)] }));
    expect(report.issues.map((issue) => `${issue.path}:${issue.line}:${issue.requirementId}`)).toEqual([
      "a.test.ts:1:8.1",
      "z-tasks.md:1:8.1",
    ]);
  });
});
