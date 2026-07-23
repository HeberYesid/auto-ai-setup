import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asCanonicalPath, asProjectRelativePath } from "../src/domain/index.js";
import { NodePathPolicy } from "../src/infrastructure/fs/path-policy.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const projectRoot = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "auto-ai-setup-path-"));
  cleanups.push(directory);
  return realpath(directory);
};

const relative = (value: string) => {
  const result = asProjectRelativePath(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const canonical = (value: string) => {
  const result = asCanonicalPath(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const trySymlink = async (target: string, path: string, type: "dir" | "file"): Promise<boolean> => {
  try {
    await symlink(target, path, type);
    return true;
  } catch {
    return false;
  }
};

describe("NodePathPolicy", () => {
  const policy = new NodePathPolicy();

  it("accepts a new nested destination inside the canonical root", async () => {
    const root = canonical(await projectRoot());
    const result = await policy.resolveDestination(root, relative(".kiro/settings/mcp.json"));
    expect(result).toMatchObject({ ok: true, value: ".kiro/settings/mcp.json" });
  });

  it("rejects traversal, absolute, backslash, and device destinations", async () => {
    const root = canonical(await projectRoot());
    for (const hostile of ["../escape", "/etc/passwd", "a\\b", "nul", "com1", "", "C:/abs", "foo\0bar"]) {
      const result = await policy.resolveDestination(root, hostile as never);
      expect(result.ok).toBe(false);
    }
  });

  it("accepts an existing plain file destination and normalizes redundant separators", async () => {
    const base = await projectRoot();
    await mkdir(join(base, "docs"), { recursive: true });
    await writeFile(join(base, "docs", "notes.md"), "content");
    const result = await policy.resolveDestination(canonical(base), "docs//notes.md" as never);
    expect(result).toMatchObject({ ok: true, value: "docs/notes.md" });
  });

  it("rejects a destination that is itself a symlink", async () => {
    const base = await projectRoot();
    await writeFile(join(base, "real.txt"), "content");
    const created = await trySymlink(join(base, "real.txt"), join(base, "link.txt"), "file");
    if (!created) return;
    const result = await policy.resolveDestination(canonical(base), relative("link.txt"));
    expect(result.ok).toBe(false);
  });

  it("rejects a destination whose ancestor escapes the root through a symlink", async () => {
    const base = await projectRoot();
    const outside = await projectRoot();
    const created = await trySymlink(outside, join(base, "escape"), "dir");
    if (!created) return;
    const result = await policy.resolveDestination(canonical(base), relative("escape/child.json"));
    expect(result.ok).toBe(false);
  });
});
