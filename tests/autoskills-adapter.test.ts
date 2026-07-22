import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUTOSKILLS_SOURCE_REPOSITORY,
  asCanonicalPath,
  asSafeProjectPath,
  type ProcessResult,
  type RegisteredProcessRequest,
  type SkillCatalogEntry,
} from "../src/domain/index.js";
import { MidudevAutoSkillsGateway } from "../src/infrastructure/catalog/autoskills-gateway.js";
import { RegisteredAutoSkillsProcessAdapter } from "../src/infrastructure/process/autoskills-process.js";
import { FakeFileSystem } from "./support/fakes.js";
import type { ProcessExecutor } from "../src/domain/index.js";

const root = asCanonicalPath("C:/workspace/project");
if (!root.ok) throw new Error(root.error.message);
const target = asSafeProjectPath(".kiro/skills/testing");
if (!target.ok) throw new Error(target.error.message);
const fileContent = new TextEncoder().encode("testing skill");
const sha = createHash("sha256").update(fileContent).digest("hex");
const commit = "0123456789abcdef0123456789abcdef01234567";
const payload = {
  schemaVersion: 1,
  catalogId: "midudev-main",
  sourceRepository: AUTOSKILLS_SOURCE_REPOSITORY,
  sourceCommit: commit,
  generatedAt: "2025-01-01T00:00:00.000Z",
  entries: [
    {
      type: "skill",
      id: "testing",
      name: "Testing",
      description: "Testing guidance",
      origin: { repository: AUTOSKILLS_SOURCE_REPOSITORY, commit, relativePath: "skills/testing" },
      files: [{ relativePath: "SKILL.md", size: fileContent.byteLength, sha256: sha }],
      compatibility: { op: "always" },
      destinationTemplate: ".kiro/skills/{id}",
    },
  ],
};

class FakeExecutor implements ProcessExecutor {
  readonly requests: RegisteredProcessRequest[] = [];
  constructor(private result: ProcessResult) {}
  setResult(result: ProcessResult): void {
    this.result = result;
  }
  async execute(request: RegisteredProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return this.result;
  }
}
const successful = (stdout: string): ProcessResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  durationMs: 2,
  timedOut: false,
  truncated: false,
});

describe("registered autoskills adapter", () => {
  it("requires listing authorization before invoking the process", async () => {
    const executor = new FakeExecutor(successful(JSON.stringify(payload)));
    const gateway = new MidudevAutoSkillsGateway(executor, { root: root.value });
    const denied = await gateway.list();
    expect(denied.ok).toBe(false);
    expect(executor.requests).toHaveLength(0);

    const allowed = new MidudevAutoSkillsGateway(executor, { root: root.value, authorizeListing: () => true });
    const result = await allowed.list();
    expect(result.ok).toBe(true);
    expect(executor.requests[0]?.args).toEqual(["list", "--json"]);
    if (result.ok) {
      expect(result.value.sourceRepository).toBe(AUTOSKILLS_SOURCE_REPOSITORY);
      expect(result.value.sourceCommit).toBe(commit);
      expect(result.value.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("accepts only validated midudev catalog output", async () => {
    const altered = {
      ...payload,
      entries: [{ ...payload.entries[0], origin: { ...payload.entries[0].origin, repository: "https://example.com/skills" } }],
    };
    const executor = new FakeExecutor(successful(JSON.stringify(altered)));
    const gateway = new MidudevAutoSkillsGateway(executor, { root: root.value, authorizeListing: () => true });
    const result = await gateway.list();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CATALOG_INVALID_RESPONSE");
  });

  it("uses the official fixed install invocation and verifies the presented snapshot and files", async () => {
    const executor = new FakeExecutor(successful(JSON.stringify(payload)));
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(".kiro/skills/testing/SKILL.md", fileContent);
    const gateway = new MidudevAutoSkillsGateway(executor, { root: root.value, authorizeListing: () => true, fileSystem });
    const listed = await gateway.list();
    expect(listed.ok).toBe(true);
    const entry = payload.entries[0] as unknown as SkillCatalogEntry;
    const invalidTarget = asSafeProjectPath(".kiro/skills/../escape");
    expect(invalidTarget.ok).toBe(false);
    const denied = await gateway.install(
      entry,
      { planHash: sha as never, operationId: "op-1", approved: true },
      ".kiro/skills/other" as never,
    );
    expect(denied.ok).toBe(false);

    executor.setResult(successful("installed"));
    const installed = await gateway.install(entry, { planHash: sha as never, operationId: "op-1", approved: true }, target.value);
    expect(installed.ok).toBe(true);
    expect(executor.requests[1]?.args).toEqual(["install", "testing"]);
  });

  it("returns bounded process failures and supports cancellation before spawn", async () => {
    const executor = new FakeExecutor({ ...successful(JSON.stringify(payload)), truncated: true });
    const gateway = new MidudevAutoSkillsGateway(executor, { root: root.value, authorizeListing: () => true });
    const result = await gateway.list();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CATALOG_EXECUTION_FAILED");

    const adapter = new RegisteredAutoSkillsProcessAdapter();
    const controller = new AbortController();
    controller.abort();
    const request = { command: "npx-autoskills", operation: "list", args: ["list", "--json"], cwd: root.value, authorized: true } as const;
    const cancelled = await adapter.execute(request, controller.signal);
    expect(cancelled.timedOut).toBe(true);
    expect(cancelled.exitCode).toBe(130);
  });
});
