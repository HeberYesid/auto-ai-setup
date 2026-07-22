import type {
  CoverageDesignation,
  CoverageKind,
  RequirementId,
  RequirementReference,
  TraceabilityDocument,
  TraceabilityInput,
  TraceabilityIssue,
  TraceabilityReport,
} from "./models.js";
import { COVERAGE_KINDS } from "./models.js";

const requirementHeading = /^###\s+Requirement\s+(\d+)\b/;
const criterionLine = /^\s*(\d+)\.\s+/;
const referenceMarker = /(?:requirements?|validates?)\s*:?/gi;
const requirementRange = /(\d+)\.(\d+)\s*(?:[-–—]\s*(?:(\d+)\.)?(\d+))?/g;
const coverageMarker = /\b(property|unit|integration|smoke|executable-validation)\s*:\s*requirements?\s+/i;

const sortStrings = (left: string, right: string): number => left.localeCompare(right);

const expandReferences = (text: string): string[] => {
  const ids = new Set<string>();
  for (const match of text.matchAll(requirementRange)) {
    const requirement = Number(match[1]);
    const firstCriterion = Number(match[2]);
    const endRequirement = match[3] === undefined ? requirement : Number(match[3]);
    const endCriterion = match[4] === undefined ? firstCriterion : Number(match[4]);
    if (endRequirement !== requirement || endCriterion < firstCriterion) {
      ids.add(`${requirement}.${firstCriterion}`);
      continue;
    }
    for (let criterion = firstCriterion; criterion <= endCriterion; criterion += 1) {
      ids.add(`${requirement}.${criterion}`);
    }
  }
  return [...ids].sort(sortStrings);
};

const referencesOnLine = (line: string): string[] => {
  const markers = [...line.matchAll(referenceMarker)];
  if (markers.length === 0) return [];
  const start = markers[markers.length - 1]?.index ?? 0;
  return expandReferences(line.slice(start));
};

const collectReferences = (document: TraceabilityDocument, source: RequirementReference["source"]): RequirementReference[] => {
  const references: RequirementReference[] = [];
  document.content.split(/\r?\n/).forEach((line, index) => {
    for (const id of referencesOnLine(line)) {
      references.push({ id, source, path: document.path, line: index + 1 });
    }
  });
  return references;
};

export const parseRequirementIds = (document: TraceabilityDocument): RequirementId[] => {
  const requirements: RequirementId[] = [];
  let currentRequirement: number | undefined;
  let inAcceptanceCriteria = false;
  document.content.split(/\r?\n/).forEach((line) => {
    const heading = line.match(requirementHeading);
    if (heading?.[1] !== undefined) {
      currentRequirement = Number(heading[1]);
      inAcceptanceCriteria = false;
      return;
    }
    if (currentRequirement === undefined) return;
    if (/^####\s+Acceptance Criteria\s*$/i.test(line)) {
      inAcceptanceCriteria = true;
      return;
    }
    if (/^###\s+Requirement\s+\d+\b/.test(line) || /^##\s+/.test(line)) {
      inAcceptanceCriteria = false;
      return;
    }
    const criterion = inAcceptanceCriteria ? line.match(criterionLine) : undefined;
    if (criterion?.[1] !== undefined) {
      const criterionNumber = Number(criterion[1]);
      requirements.push({ id: `${currentRequirement}.${criterionNumber}`, requirement: currentRequirement, criterion: criterionNumber });
    }
  });
  return requirements.sort((left, right) => left.requirement - right.requirement || left.criterion - right.criterion);
};

const parseCoverage = (document: TraceabilityDocument | undefined): CoverageDesignation[] => {
  if (document === undefined) return [];
  const coverage: CoverageDesignation[] = [];
  document.content.split(/\r?\n/).forEach((line, index) => {
    const marker = line.match(coverageMarker);
    if (marker?.[1] === undefined) return;
    const kind = marker[1].toLowerCase() as CoverageKind;
    for (const id of expandReferences(line.slice((marker.index ?? 0) + marker[0].length))) {
      coverage.push({ id, kind, path: document.path, line: index + 1 });
    }
  });
  return coverage;
};

const issueSort = (left: TraceabilityIssue, right: TraceabilityIssue): number =>
  left.path.localeCompare(right.path) ||
  left.line - right.line ||
  left.requirementId.localeCompare(right.requirementId) ||
  left.code.localeCompare(right.code);

const referenceSource = (document: TraceabilityDocument, isTasks: boolean): RequirementReference["source"] => {
  if (isTasks) return "tasks";
  return document.path.endsWith(".property.test.ts") ? "property" : "test";
};

export const validateTraceability = (input: TraceabilityInput): TraceabilityReport => {
  const requirements = parseRequirementIds(input.requirements);
  const knownIds = new Set(requirements.map((requirement) => requirement.id));
  const documents = [input.tasks, ...[...input.tests].sort((left, right) => left.path.localeCompare(right.path))];
  const references = documents.flatMap((document) => collectReferences(document, referenceSource(document, document === input.tasks)));
  const declaredCoverage = parseCoverage(input.coverage);
  const propertyCoverage: CoverageDesignation[] = references
    .filter((reference) => reference.source === "property" && knownIds.has(reference.id))
    .map((reference) => ({ id: reference.id, kind: "property", path: reference.path, line: reference.line }));
  const coverage = [...declaredCoverage, ...propertyCoverage];
  const issues: TraceabilityIssue[] = [];

  for (const reference of [...references, ...coverage.map((entry) => ({ ...entry, source: "coverage" as const }))]) {
    if (knownIds.has(reference.id)) continue;
    issues.push({
      code: reference.source === "coverage" ? "UNKNOWN_COVERAGE_REQUIREMENT" : "UNKNOWN_REQUIREMENT_REFERENCE",
      message: `Requirement ${reference.id} is referenced by ${reference.path}, but it is not declared in requirements.md`,
      path: reference.path,
      line: reference.line,
      requirementId: reference.id,
    });
  }

  const coveredIds = new Set(coverage.filter((entry) => knownIds.has(entry.id)).map((entry) => entry.id));
  for (const requirement of requirements) {
    if (coveredIds.has(requirement.id)) continue;
    issues.push({
      code: "MISSING_COVERAGE",
      message: `Requirement ${requirement.id} has no designated property, unit, integration, smoke, or executable-validation check`,
      path: input.coverage?.path ?? "traceability.md",
      line: input.coverage === undefined ? 0 : 1,
      requirementId: requirement.id,
    });
  }

  issues.sort(issueSort);
  return { ok: issues.length === 0, requirements, references, coverage, issues };
};

export const formatTraceabilityReport = (report: TraceabilityReport): string => {
  if (report.ok) {
    return `SDD traceability validation passed: ${report.requirements.length} requirements, ${report.references.length} references, ${report.coverage.length} coverage designations.`;
  }
  const header = `SDD traceability validation failed with ${report.issues.length} issue(s):`;
  const details = report.issues.map((issue) => `- [${issue.code}] ${issue.path}:${issue.line} — ${issue.message}`);
  return [header, ...details].join("\n");
};

export { COVERAGE_KINDS };
