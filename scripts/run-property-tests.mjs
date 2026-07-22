import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const testsRoot = join(root, "tests");

const collectPropertyTests = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectPropertyTests(path)));
    else if (entry.isFile() && entry.name.endsWith(".property.test.ts")) files.push(path);
  }
  return files;
};

const files = (await collectPropertyTests(testsRoot)).sort().map((path) => relative(root, path));
if (files.length === 0) throw new Error("No property tests were found");

const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(executable, ["exec", "vitest", "run", ...files], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
