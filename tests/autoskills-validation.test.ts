import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ProcessExecutor, ProcessResult, RegisteredProcessRequest } from "../src/domain/index.js";
import { AUTOSKILLS_SOURCE_REPOSITORY, asCanonicalPath, asSafeProjectPath } from "../src/domain/index.js";
import { MidudevAutoSkillsGateway } from "../src/infrastructure/catalog/autoskills-gateway.js";
import { FileSystemSkillOwnershipStore } from "../src/infrastructure/catalog/skill-ownership.js";
import { FakeFileSystem } from "./support/fakes.js";

const root = asCanonicalPath("C:/workspace/project");
if (!root.ok) throw new Error(root.error.message);
const bytes = new TextEncoder().encode("verified skill");
const fileHash = createHash("sha256").update(bytes).digest("hex");
const commit = "0123456789abcdef0123456789abcdef01234567";
const payload = {
  schemaVersion: 1 as const,
  catalogId: "midudev-main",
  sourceRepository: AUTOSKILLS_SOURCE_REPOSITORY,
  sourceCommit: commit,
  generatedAt: "2025-01-01T00:00:00.000Z",
  entries: [
    {
      type: "skill" as const,
      id: "verified-skill",
      name: "Verified Skill",
      description: "A deterministic test skill",
      origin: { repository: AUTOSKILLS_SOURCE_REPOSITORY, commit, relativePath: "skills/verified-skill" },
      files: [{ relativePath: "SKILL.md", size: bytes.byteLength, sha256: fileHash }],
      compatibility: { op: "always" as const },
      destinationTemplate: ".kiro/skills/{id}" as const,
    },
  ],
};
const successful = (stdout: string): ProcessResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  durationMs: 1,
  timedOut: false,
  truncated: false,
});

class InstallingExecutor implements ProcessExecutor {
  readonly requests: RegisteredProcessRequest[] = [];
  private result: ProcessResult;
  constructor(
    private readonly fileSystem: FakeFileSystem,
    result: ProcessResult = successful("installed"),
  ) {
    this.result = result;
  }
  setResult(result: ProcessResult): void {
    this.result = result;
  }
  async execute(request: RegisteredProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    if (request.args[0] === "install") this.fileSystem.seed(".kiro/skills/verified-skill/SKILL.md", bytes);
    return this.result;
  }
}

const approval = { planHash: "a".repeat(64) as never, operationId: "operation-1", approved: true as const };

describe("autoskills catalog membership and artifact integrity", () => {
  it("rejects an entry altered after the presented snapshot without invoking install", async () => {
    const fileSystem = new FakeFileSystem();
    const executor = new InstallingExecutor(fileSystem, successful(JSON.stringify(payload)));
    const gateway = new MidudevAutoSkillsGateway(executor, { root: root.value, authorizeListing: () => true, fileSystem });
    const listed = await gateway.list();
    expect(listed.ok).toBe(true);
    const altered = { ...payload.entries[0], origin: { ...payload.entries[0].origin, relativePath: "skills/other" } };
    const target = asSafeProjectPath(".kiro/skills/verified-skill");
    if (!target.ok) throw new Error(target.error.message);
    const result = await gateway.install(altered, approval, target.value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INSTALLATION_IDENTITY_MISMATCH");
    expect(executor.requests).toHaveLength(1);
  });

  it("removes only partial expected files and preserves unknown user content after installer failure", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.seed(".kiro/skills/verified-skill/user-notes.txt", "keep me");
    const executor = new InstallingExecutor(fileSystem, successful(JSON.stringify(payload)));
    const gateway = new MidudevAutoSkillsGateway(executor, { root: root.value, authorizeListing: () => true, fileSystem });
    expect((await gateway.list()).ok).toBe(true);
    executor.setResult({ ...successful("failed"), exitCode: 1, stderr: "installer failed" });
    const target = asSafeProjectPath(".kiro/skills/verified-skill");
    if (!target.ok) throw new Error(target.error.message);
    const result = await gateway.install(payload.entries[0], approval, target.value);
    expect(result.ok).toBe(false);
    expect(await fileSystem.exists(".kiro/skills/verified-skill/SKILL.md" as never)).toBe(false);
    expect(await fileSystem.exists(".kiro/skills/verified-skill/user-notes.txt" as never)).toBe(true);
  });

  it("verifies hashes and persists ownership only after a successful installation", async () => {
    const fileSystem = new FakeFileSystem();
    const executor = new InstallingExecutor(fileSystem, successful(JSON.stringify(payload)));
    const ownership = new FileSystemSkillOwnershipStore(fileSystem);
    const gateway = new MidudevAutoSkillsGateway(executor, {
      root: root.value,
      authorizeListing: () => true,
      fileSystem,
      ownershipStore: ownership,
      ownershipRunId: "run-0001" as never,
    });
    expect((await gateway.list()).ok).toBe(true);
    executor.setResult(successful("installed"));
    const target = asSafeProjectPath(".kiro/skills/verified-skill");
    if (!target.ok) throw new Error(target.error.message);
    const result = await gateway.install(payload.entries[0], approval, target.value);
    expect(result.ok).toBe(true);
    const state = await ownership.load();
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.value?.components["skill:verified-skill"]?.origin).toBe(`${AUTOSKILLS_SOURCE_REPOSITORY}#skills/verified-skill`);
      expect(state.value?.components["skill:verified-skill"]?.sourceRevision).toBe(commit);
    }
  });
});
