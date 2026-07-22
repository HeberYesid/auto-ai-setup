export const COVERAGE_KINDS = ["property", "unit", "integration", "smoke", "executable-validation"] as const;

export type CoverageKind = (typeof COVERAGE_KINDS)[number];

export interface TraceabilityDocument {
  readonly path: string;
  readonly content: string;
}

export interface RequirementId {
  readonly id: string;
  readonly requirement: number;
  readonly criterion: number;
}

export interface RequirementReference {
  readonly id: string;
  readonly source: "tasks" | "property" | "test" | "coverage";
  readonly path: string;
  readonly line: number;
}

export interface CoverageDesignation {
  readonly id: string;
  readonly kind: CoverageKind;
  readonly path: string;
  readonly line: number;
}

export type TraceabilityIssueCode = "UNKNOWN_REQUIREMENT_REFERENCE" | "UNKNOWN_COVERAGE_REQUIREMENT" | "MISSING_COVERAGE";

export interface TraceabilityIssue {
  readonly code: TraceabilityIssueCode;
  readonly message: string;
  readonly path: string;
  readonly line: number;
  readonly requirementId: string;
}

export interface TraceabilityReport {
  readonly ok: boolean;
  readonly requirements: readonly RequirementId[];
  readonly references: readonly RequirementReference[];
  readonly coverage: readonly CoverageDesignation[];
  readonly issues: readonly TraceabilityIssue[];
}

export interface TraceabilityInput {
  readonly requirements: TraceabilityDocument;
  readonly tasks: TraceabilityDocument;
  readonly tests: readonly TraceabilityDocument[];
  readonly coverage?: TraceabilityDocument;
}

export interface TraceabilityFileOptions {
  readonly requirementsPath: string;
  readonly tasksPath: string;
  readonly testsDirectory: string;
  readonly coveragePath?: string;
}
