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
