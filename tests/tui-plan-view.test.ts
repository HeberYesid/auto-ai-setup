import { describe, expect, it } from "vitest";
import { calculatePlanHash, type ChangePlan, type ExternalOperation, type FileChange, type Sha256 } from "../src/index.js";
import { projectCanonicalPlan } from "../src/domain/tui/plan-view.js";

const digest = "a".repeat(64) as Sha256;

const makePlan = (fileChanges: readonly FileChange[], externalOperations: readonly ExternalOperation[] = []): ChangePlan => {
  const unsigned = {
    schemaVersion: 1 as const,
    runId: "run-plan-view" as ChangePlan["runId"],
    root: "C:/project" as ChangePlan["root"],
    mode: "manual" as const,
    confirmedStackDigest: digest,
    createdAt: "2025-01-01T00:00:00.000Z",
    fileChanges,
    externalOperations,
    warnings: [],
  };
  return { ...unsigned, planHash: calculatePlanHash(unsigned) };
};

const fileChange = (destination: string, overrides: Partial<FileChange> = {}): FileChange => ({
  id: `file:${destination}`,
  componentId: "component" as FileChange["componentId"],
  destination: destination as FileChange["destination"],
  action: "create",
  reason: "Configure component",
  conflict: "none",
  preview: { kind: "text", content: "safe content", truncated: false },
  ...overrides,
});

const allowedExternal = (): ExternalOperation => ({
  id: "skill-install:component" as ExternalOperation["id"],
  componentId: "component" as ExternalOperation["componentId"],
  kind: "skill-install",
  command: ["npx", "--yes", "autoskills", "token=network-secret"],
  origin: "https://github.com/midudev/autoskills",
  destination: ".kiro/skills/component" as ExternalOperation["destination"],
  purpose: "Install the selected Skill",
  usesNetwork: true,
  expectedFiles: [],
});

describe("canonical redacted plan projection", () => {
  it("uses the planner hash, canonical operation order, placeholders, and semantic before/after values", () => {
    const plan = makePlan([
      fileChange("z.md", {
        action: "modify",
        preview: {
          kind: "fields",
          changes: [{ path: "/z", action: "change", before: { password: "before-secret" }, after: { token: "after-secret" } }],
        },
      }),
      fileChange("a.md"),
    ]);

    const projected = projectCanonicalPlan(plan, { knownSecrets: ["before-secret", "after-secret"] });

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.planHash).toBe(calculatePlanHash(plan));
    expect(projected.value.approvalDefault).toBe("reject");
    expect(projected.value.operations.map((operation) => operation.destination)).toEqual(["a.md", "z.md"]);
    expect(projected.value.operations[0]?.source).toBe("no aplicable");
    expect(projected.value.operations[1]?.semanticChange).toEqual({
      before: '/z: {"password":[REDACTED]}',
      after: '/z: {"token":[REDACTED]}',
    });
    expect(JSON.stringify(projected.value)).not.toContain("before-secret");
    expect(JSON.stringify(projected.value)).not.toContain("after-secret");
    expect(Object.isFrozen(projected.value)).toBe(true);
    expect(Object.isFrozen(projected.value.operations)).toBe(true);
  });

  it("includes only registered autoskills operations and preserves command arguments as metadata", () => {
    const rejected = { ...allowedExternal(), command: ["node", "arbitrary-script"] } as ExternalOperation;
    const projected = projectCanonicalPlan(makePlan([], [allowedExternal(), rejected]), { knownSecrets: ["network-secret"] });

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.operations).toHaveLength(1);
    const external = projected.value.operations[0];
    expect(external?.action).toBe("external");
    expect(external?.reason).toBe("Install the selected Skill");
    expect(external?.external).toEqual({
      command: "npx",
      args: ["--yes", "autoskills", "[REDACTED]"],
      purpose: "Install the selected Skill",
      networkUse: "red aprobada",
    });
    expect(JSON.stringify(projected.value)).not.toContain("network-secret");
  });

  it("fails closed when a redactor throws", () => {
    const projected = projectCanonicalPlan(makePlan([fileChange("safe.md")]), {
      redactor: {
        redact: () => {
          throw new Error("redaction unavailable");
        },
      },
    });

    expect(projected.ok).toBe(false);
    if (projected.ok) return;
    expect(projected.error.code).toBe("REDACTION_INCOMPLETE");
  });
});
