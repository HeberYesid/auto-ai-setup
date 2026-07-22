import { describe, expect, it } from "vitest";
import { asSafeProjectPath } from "../src/domain/index.js";
import type { ProjectEntry, ProjectEntryKind, ProjectValidationPort } from "../src/domain/index.js";
import { NodeProjectGateway } from "../src/infrastructure/fs/project-gateway.js";

const root = "C:\\virtual\\input";
const canonicalRoot = "C:\\virtual\\canonical";
const canonicalDisplayRoot = "C:/virtual/canonical";

class ValidationFake implements ProjectValidationPort {
  readonly files = new Map<string, Uint8Array>();
  readonly writes: string[] = [];
  readonly removals: string[] = [];
  statKind: ProjectEntryKind = "directory";
  realpathValue = canonicalRoot;
  enumerateEntries: readonly ProjectEntry[] = [];
  failOnStat = false;
  failOnRealpath = false;
  failOnEnumerate = false;
  failOnRead: ((path: string) => boolean) | undefined;
  failOnWrite = false;
  failOnRemove = false;

  async stat(): Promise<ProjectEntryKind> {
    if (this.failOnStat) throw new Error("permission denied while checking path");
    return this.statKind;
  }
  async realpath(path: string): Promise<string> {
    if (this.failOnRealpath) throw new Error("permission denied while resolving path");
    if (path === root) return this.realpathValue;
    return path;
  }
  async enumerate(): Promise<readonly ProjectEntry[]> {
    if (this.failOnEnumerate) throw new Error("permission denied while enumerating path");
    return this.enumerateEntries;
  }
  async readFile(path: string): Promise<Uint8Array> {
    if (this.failOnRead?.(path)) throw new Error("injected read failure");
    const normalized = path.split("\\").join("/");
    const value = [...this.files.entries()].find(([candidate]) => candidate.split("\\").join("/") === normalized)?.[1];
    if (value === undefined) throw new Error(`missing ${path}`);
    return value.slice();
  }
  async writeFile(path: string, content: Uint8Array): Promise<void> {
    if (this.failOnWrite) throw new Error("injected write failure");
    this.files.set(path, content.slice());
    this.writes.push(path);
  }
  async removeFile(path: string): Promise<void> {
    if (this.failOnRemove) throw new Error("injected remove failure");
    this.files.delete(path);
    this.removals.push(path);
  }
}

const file = (relativePath: string, bytes = 1): ProjectEntry => ({
  absolutePath: `${canonicalRoot}/${relativePath}`,
  relativePath,
  kind: "file",
  bytes,
});

const safe = (path: string) => {
  const result = asSafeProjectPath(path);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("NodeProjectGateway", () => {
  it("uses the canonical root and classifies an empty directory as new", async () => {
    const filesystem = new ValidationFake();
    const gateway = new NodeProjectGateway(filesystem, { probeName: () => "fixed" });

    const result = await gateway.validateDirectory(root);

    expect(result).toEqual({
      ok: true,
      value: { root: canonicalRoot, kind: "new", projectFileCount: 0, recognizedAiConfig: [] },
    });
    expect(filesystem.writes.map(normalize)).toEqual([`${canonicalDisplayRoot}/.auto-ai-setup.validation-fixed.tmp`]);
    expect(filesystem.removals.map(normalize)).toEqual(filesystem.writes.map(normalize));
    expect(filesystem.files.size).toBe(0);
  });

  it("counts project files while excluding tool-owned state and reports recognized AI config", async () => {
    const filesystem = new ValidationFake();
    filesystem.enumerateEntries = [
      file("package.json", 10),
      file("src/index.ts", 20),
      file(".auto-ai-setup/state.json", 30),
      file(".kiro/settings/mcp.json", 40),
      file("AGENTS.md", 50),
    ];
    for (const entry of filesystem.enumerateEntries) filesystem.files.set(entry.absolutePath, new Uint8Array(entry.bytes ?? 0));
    const gateway = new NodeProjectGateway(filesystem, { probeName: () => "fixed" });

    const result = await gateway.validateDirectory(root);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("existing");
      expect(result.value.projectFileCount).toBe(4);
      expect(result.value.recognizedAiConfig).toEqual([safe(".kiro/settings/mcp.json"), safe("AGENTS.md")]);
    }
  });

  it("cleans the temporary probe when probe read fails", async () => {
    const filesystem = new ValidationFake();
    filesystem.failOnRead = (path) => path.includes("validation-fixed");
    const gateway = new NodeProjectGateway(filesystem, { probeName: () => "fixed" });

    const result = await gateway.validateDirectory(root);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("READ_PROBE_FAILED");
      expect(result.error.check).toBe("read");
      expect(result.error.exitCode).toBe(2);
    }
    expect(filesystem.files.size).toBe(0);
    expect(filesystem.removals.map(normalize)).toEqual([`${canonicalDisplayRoot}/.auto-ai-setup.validation-fixed.tmp`]);
  });

  it("returns named exit-code-ready errors without writing for invalid roots", async () => {
    const filesystem = new ValidationFake();
    filesystem.statKind = "file";
    const gateway = new NodeProjectGateway(filesystem, { probeName: () => "fixed" });

    const result = await gateway.validateDirectory(root);

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "NOT_DIRECTORY", check: "directory", exitCode: 2 }),
    });
    expect(filesystem.writes).toEqual([]);
  });

  it("reads only contained recognized files and enforces the byte limit", async () => {
    const filesystem = new ValidationFake();
    filesystem.enumerateEntries = [file("package.json", 3)];
    filesystem.files.set(`${canonicalRoot}/package.json`, new Uint8Array([1, 2, 3]));
    const gateway = new NodeProjectGateway(filesystem, { probeName: () => "fixed" });
    expect((await gateway.validateDirectory(root)).ok).toBe(true);

    const read = await gateway.readRecognized(safe("package.json"), 3 as never);
    expect(read).toEqual({ ok: true, value: new Uint8Array([1, 2, 3]) });
    const tooSmall = await gateway.readRecognized(safe("package.json"), 2 as never);
    expect(tooSmall.ok).toBe(false);
    if (!tooSmall.ok) expect(tooSmall.error.code).toBe("READ_PROBE_FAILED");
    const outside = await gateway.readRecognized("../outside.json" as never, 100 as never);
    expect(outside.ok).toBe(false);
  });
  it("maps missing paths and filesystem permission failures to named exit-code-2 checks", async () => {
    const missing = new ValidationFake();
    missing.failOnStat = true;
    const missingResult = await new NodeProjectGateway(missing, { probeName: () => "fixed" }).validateDirectory(root);
    expect(missingResult).toMatchObject({ ok: false, error: { code: "DIRECTORY_NOT_FOUND", check: "exists", exitCode: 2 } });
    expect(missing.writes).toEqual([]);

    const realpath = new ValidationFake();
    realpath.failOnRealpath = true;
    const realpathResult = await new NodeProjectGateway(realpath, { probeName: () => "fixed" }).validateDirectory(root);
    expect(realpathResult).toMatchObject({ ok: false, error: { code: "REALPATH_FAILED", check: "realpath", exitCode: 2 } });
    expect(realpath.writes).toEqual([]);

    const enumeration = new ValidationFake();
    enumeration.failOnEnumerate = true;
    const enumerationResult = await new NodeProjectGateway(enumeration, { probeName: () => "fixed" }).validateDirectory(root);
    expect(enumerationResult).toMatchObject({ ok: false, error: { code: "ENUMERATE_FAILED", check: "enumerate", exitCode: 2 } });
    expect(enumeration.writes).toEqual([]);
  });

  it("reports probe write and delete permission failures with named checks", async () => {
    const writeDenied = new ValidationFake();
    writeDenied.failOnWrite = true;
    const writeResult = await new NodeProjectGateway(writeDenied, { probeName: () => "fixed" }).validateDirectory(root);
    expect(writeResult).toMatchObject({ ok: false, error: { code: "WRITE_PROBE_FAILED", check: "write", exitCode: 2 } });
    expect(writeDenied.files.size).toBe(0);

    const deleteDenied = new ValidationFake();
    deleteDenied.failOnRemove = true;
    const deleteResult = await new NodeProjectGateway(deleteDenied, { probeName: () => "fixed" }).validateDirectory(root);
    expect(deleteResult).toMatchObject({ ok: false, error: { code: "DELETE_PROBE_FAILED", check: "delete", exitCode: 2 } });
    expect(deleteDenied.writes).toHaveLength(1);
    expect(deleteDenied.removals).toEqual([]);
  });
});

const normalize = (path: string): string => path.split("\\").join("/");
