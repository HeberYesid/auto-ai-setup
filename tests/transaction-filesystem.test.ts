import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asCanonicalPath, asSafeProjectPath } from "../src/domain/index.js";
import { NodeTransactionalFileSystem } from "../src/infrastructure/fs/transaction-filesystem.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const createFileSystem = async (): Promise<NodeTransactionalFileSystem> => {
  const directory = await mkdtemp(join(tmpdir(), "auto-ai-setup-fs-"));
  temporaryDirectories.push(directory);
  const root = asCanonicalPath(directory);
  if (!root.ok) throw new Error(root.error.message);
  return new NodeTransactionalFileSystem(root.value);
};

const safe = (value: string) => {
  const result = asSafeProjectPath(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("NodeTransactionalFileSystem", () => {
  it("writes, atomically replaces, fsyncs, lists, exclusively locks, and removes rooted files", async () => {
    const fileSystem = await createFileSystem();
    const path = safe("nested/config.json");
    const lock = safe(".auto-ai-setup/transactions/active");

    expect(await fileSystem.exists(path)).toBe(false);
    expect((await fileSystem.write(path, new TextEncoder().encode("first"))).ok).toBe(true);
    expect(new TextDecoder().decode(await fileSystem.read(path))).toBe("first");
    expect((await fileSystem.fsync(path)).ok).toBe(true);
    expect((await fileSystem.writeAtomic(path, new TextEncoder().encode("second"))).ok).toBe(true);
    expect(new TextDecoder().decode(await fileSystem.read(path))).toBe("second");

    expect((await fileSystem.createExclusive(lock, new TextEncoder().encode("owner"))).ok).toBe(true);
    expect((await fileSystem.createExclusive(lock, new TextEncoder().encode("other"))).ok).toBe(false);

    const listed: string[] = [];
    for await (const descriptor of fileSystem.list("ignored" as never)) listed.push(String(descriptor.path));
    expect(listed).toEqual(expect.arrayContaining(["nested/config.json", ".auto-ai-setup/transactions/active"]));

    expect((await fileSystem.remove(path)).ok).toBe(true);
    expect(await fileSystem.exists(path)).toBe(false);
  });
  it("returns safe failures for missing files and refuses paths outside its root", async () => {
    const fileSystem = await createFileSystem();
    const missing = safe("missing.txt");

    expect(await fileSystem.exists(missing)).toBe(false);
    expect((await fileSystem.fsync(missing)).ok).toBe(false);
    expect((await fileSystem.remove(missing)).ok).toBe(true);

    const escape = "../outside.txt" as never;
    expect(await fileSystem.exists(escape)).toBe(false);
    await expect(fileSystem.read(escape)).rejects.toThrow("Path escapes transaction root");
    expect((await fileSystem.write(escape, new Uint8Array())).ok).toBe(false);
    expect((await fileSystem.createExclusive(escape, new Uint8Array())).ok).toBe(false);
    await expect(fileSystem.writeAtomic(escape, new Uint8Array())).rejects.toThrow("Path escapes transaction root");
  });
});
