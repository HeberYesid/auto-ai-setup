import { describe, expect, it } from "vitest";
import {
  ApprovedNetworkGateway,
  DeterministicChangePlanner,
  asCanonicalPath,
  isAllowedAutoSkillsOperation,
  isOfficialAutoSkillsCommand,
  type ExternalOperation,
  type NetworkGateway,
  type PlanningInput,
  type Sha256,
} from "../src/domain/index.js";
import { RegisteredAutoSkillsProcessAdapter } from "../src/infrastructure/process/autoskills-process.js";

const digest = "a".repeat(64) as Sha256;
const root = asCanonicalPath("C:/workspace/project");
if (!root.ok) throw new Error(root.error.message);
const operation = (command: readonly string[] = ["npx", "--yes", "autoskills"]): ExternalOperation => ({
  id: "skill-install:demo" as ExternalOperation["id"],
  componentId: "demo" as ExternalOperation["componentId"],
  kind: "skill-install",
  command,
  origin: "https://github.com/midudev/autoskills",
  destination: ".kiro/skills/demo" as ExternalOperation["destination"],
  purpose: "Open the official Skill-management TUI",
  usesNetwork: true,
  expectedFiles: [{ path: ".kiro/skills/demo/SKILL.md", size: 1, sha256: digest }],
});

describe("product operation boundary", () => {
  it("accepts only the official autoskills command shape", () => {
    expect(isOfficialAutoSkillsCommand(["npx", "--yes", "autoskills"])).toBe(true);
    expect(isAllowedAutoSkillsOperation(operation())).toBe(true);
    expect(isAllowedAutoSkillsOperation(operation(["node", "script.mjs"]))).toBe(false);
    expect(isAllowedAutoSkillsOperation(operation(["npx", "--yes", "autoskills", "install", "demo"]))).toBe(false);
    expect(isAllowedAutoSkillsOperation(operation(["npx", "--yes", "autoskills", "--unsafe;curl"]))).toBe(false);
  });

  it("rejects prohibited operations before they enter a plan", async () => {
    const input: PlanningInput = {
      runId: "run-boundary" as PlanningInput["runId"],
      root: root.value,
      mode: "manual",
      stack: { items: [], resolvedConflicts: [], digest },
      components: [],
      fileChanges: [],
      externalOperations: [operation(["node", "arbitrary.mjs"])],
      now: "2025-01-01T00:00:00.000Z",
    };
    const result = await new DeterministicChangePlanner().build(input);
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_PLAN" } });
  });

  it("keeps network deny-by-default and binds access to the current plan hash", async () => {
    let calls = 0;
    const delegate: NetworkGateway = {
      request: async () => {
        calls += 1;
        return { ok: true, value: new Uint8Array() };
      },
    };
    const gateway = new ApprovedNetworkGateway(delegate, digest);
    const allowed = await gateway.request(operation(), { planHash: digest, operationId: operation().id, approved: true });
    expect(allowed.ok).toBe(true);
    expect(calls).toBe(1);
    const stale = await gateway.request(operation(), {
      planHash: "b".repeat(64) as Sha256,
      operationId: operation().id,
      approved: true,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "NETWORK_DENIED" } });
    expect(calls).toBe(1);
    const prohibited = await gateway.request(operation(["node", "mcp-server"]), {
      planHash: digest,
      operationId: operation().id,
      approved: true,
    });
    expect(prohibited).toMatchObject({ ok: false, error: { code: "NETWORK_DENIED" } });
    expect(calls).toBe(1);
  });

  it("rejects process approval before any spawn when the hash or request is not allowlisted", async () => {
    const adapter = new RegisteredAutoSkillsProcessAdapter({ expectedPlanHash: digest });
    const denied = await adapter.runApproved(
      { command: "npx-autoskills", args: [], cwd: root.value },
      { planHash: "b".repeat(64) as Sha256, operationId: "skill-install:demo", approved: true },
    );
    expect(denied).toMatchObject({ ok: false, error: { code: "PROCESS_NOT_ALLOWED" } });

    const prohibited = await adapter.runApproved(
      { command: "npx-autoskills", args: ["install"], cwd: root.value },
      { planHash: digest, operationId: "skill-install:demo", approved: true },
    );
    expect(prohibited).toMatchObject({ ok: false, error: { code: "PROCESS_NOT_ALLOWED" } });
  });
});
