import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUTOSKILLS_SOURCE_REPOSITORY,
  asCanonicalPath,
  isRegisteredAutoSkillsRequest,
  registerAutoSkillsInstall,
  registerAutoSkillsInteractive,
  registerAutoSkillsList,
  validateCatalogPayload,
  validateCatalogSnapshot,
  validateSkillCatalogEntry,
} from "../src/domain/index.js";

const root = asCanonicalPath("C:/workspace/project");
if (!root.ok) throw new Error(root.error.message);
const bytes = new TextEncoder().encode("verified skill");
const digest = createHash("sha256").update(bytes).digest("hex");
const commit = "0123456789abcdef0123456789abcdef01234567";
const entry = {
  type: "skill" as const,
  id: "verified-skill" as const,
  name: "Verified Skill",
  description: "A deterministic test skill",
  origin: { repository: AUTOSKILLS_SOURCE_REPOSITORY, commit, relativePath: "skills/verified-skill" },
  files: [{ relativePath: "SKILL.md", size: bytes.byteLength, sha256: digest }],
  compatibility: { op: "always" as const },
  destinationTemplate: ".kiro/skills/{id}" as const,
};
const payload = {
  schemaVersion: 1 as const,
  catalogId: "midudev-main",
  sourceRepository: AUTOSKILLS_SOURCE_REPOSITORY,
  sourceCommit: commit,
  generatedAt: "2025-01-01T00:00:00.000Z",
  entries: [entry],
};

describe("autoskills contract validation", () => {
  it("keeps pure catalog validation available for trusted adapters", () => {
    expect(validateSkillCatalogEntry(entry)).toBe(true);
    expect(validateCatalogPayload(payload)).toMatchObject({ ok: true, value: { entries: [entry] } });
    expect(validateCatalogPayload({ ...payload, entries: [entry, entry] })).toMatchObject({
      ok: false,
      error: { code: "CATALOG_INVALID_RESPONSE" },
    });
    expect(validateCatalogSnapshot({ ...payload, manifestDigest: digest })).toMatchObject({ ok: true });
  });

  it("registers only the command that the published CLI actually supports", () => {
    const interactive = registerAutoSkillsInteractive(root.value, true);
    expect(interactive.ok).toBe(true);
    if (interactive.ok) expect(interactive.value.args).toEqual([]);
    expect(isRegisteredAutoSkillsRequest({ command: "npx-autoskills", operation: "interactive", args: [], authorized: true })).toBe(true);
    expect(
      isRegisteredAutoSkillsRequest({ command: "npx-autoskills", operation: "list", args: ["list", "--json"], authorized: true }),
    ).toBe(false);
    expect(registerAutoSkillsList(root.value, true)).toMatchObject({ ok: false, error: { code: "CATALOG_EXECUTION_FAILED" } });
    expect(registerAutoSkillsInstall(root.value, entry, ".kiro/skills/verified-skill", true)).toMatchObject({
      ok: false,
      error: { code: "CATALOG_EXECUTION_FAILED" },
    });
  });
});

describe("autoskills catalog membership and ownership", () => {
  const snapshot = { ...payload, manifestDigest: digest, sourceCommit: commit } as never;

  it("accepts an identical presented entry and rejects mismatched identity or absence", async () => {
    const { findCatalogEntry, catalogEntriesEquivalent } = await import("../src/domain/index.js");
    expect(findCatalogEntry(snapshot, entry as never)).toMatchObject({ ok: true });
    expect(catalogEntriesEquivalent(entry as never, entry as never)).toBe(true);
    expect(findCatalogEntry(snapshot, { ...entry, id: "other" } as never)).toMatchObject({
      ok: false,
      error: { code: "CATALOG_SOURCE_MISMATCH" },
    });
    expect(findCatalogEntry(snapshot, { ...entry, origin: { ...entry.origin, commit: "f".repeat(40) } } as never)).toMatchObject({
      ok: false,
      error: { code: "CATALOG_SOURCE_MISMATCH" },
    });
  });

  it("validates the exact install target and derives planning metadata", async () => {
    const { validateInstallTarget, catalogPlanningMetadata, skillOwnershipKey } = await import("../src/domain/index.js");
    expect(validateInstallTarget(entry as never, ".kiro/skills/verified-skill")).toBe(true);
    expect(validateInstallTarget(entry as never, ".kiro/skills/other")).toBe(false);
    expect(validateInstallTarget(entry as never, "../escape")).toBe(false);
    expect(skillOwnershipKey(entry as never)).toBe("skill:verified-skill");
    expect(catalogPlanningMetadata(snapshot)).toEqual({ catalogDigest: digest, catalogSourceRevision: commit });
  });

  it("upserts skill ownership while preserving previously managed components", async () => {
    const { upsertSkillOwnership } = await import("../src/domain/index.js");
    const previous = {
      schemaVersion: 1 as const,
      components: { "rule:existing": { type: "agent-rule", origin: "builtin", destinations: [], contentDigest: digest } },
      lastSuccessfulRunId: "run-0001",
    } as never;
    const updated = upsertSkillOwnership(
      previous,
      entry as never,
      digest as never,
      [".kiro/skills/verified-skill"] as never,
      "run-0002" as never,
    );
    expect(updated.components["rule:existing"]).toBeDefined();
    expect(updated.components["skill:verified-skill"]).toMatchObject({ type: "skill", sourceRevision: commit });
    expect(updated.lastSuccessfulRunId).toBe("run-0002");

    const fromEmpty = upsertSkillOwnership(undefined, entry as never, digest as never, [] as never, "run-0003" as never);
    expect(Object.keys(fromEmpty.components)).toEqual(["skill:verified-skill"]);
  });
});
