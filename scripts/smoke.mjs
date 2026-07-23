import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// A single command string with no args array keeps shell execution portable on
// Windows (.cmd shims) without triggering DEP0190 (passing args with shell:true).
const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
const runShell = (commandLine, cwd) => {
  const result = spawnSync(commandLine, { cwd, encoding: "utf8", stdio: "inherit", shell: true });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
};

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), "auto-ai-setup-smoke-"));
const packDestination = join(temporaryRoot, "pack");
const installDestination = join(temporaryRoot, "sandbox");
await mkdir(packDestination, { recursive: true });
await mkdir(installDestination, { recursive: true });
await writeFile(join(installDestination, "package.json"), '{"name":"auto-ai-setup-smoke-sandbox","private":true}\n');

try {
  const packStatus = runShell(`pnpm pack --pack-destination ${quote(packDestination)}`, repositoryRoot);
  if (packStatus !== 0) throw new Error(`pnpm pack failed with exit code ${packStatus}`);

  const tarball = (await readdir(packDestination)).find((entry) => entry.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("pnpm pack did not create a tarball");

  const installStatus = runShell(`pnpm install --ignore-scripts --offline ${quote(join(packDestination, tarball))}`, installDestination);
  if (installStatus !== 0) throw new Error(`sandbox installation failed with exit code ${installStatus}`);

  const installedPackage = JSON.parse(await readFile(join(installDestination, "node_modules", "auto-ai-setup", "package.json"), "utf8"));
  if (installedPackage.type !== "module" || installedPackage.bin?.["auto-ai-setup"] !== "dist/cli/bin.js") {
    throw new Error("packed package is not an ESM package with the expected CLI bin");
  }

  const binSource = await readFile(
    join(installDestination, "node_modules", "auto-ai-setup", installedPackage.bin["auto-ai-setup"]),
    "utf8",
  );
  if (!binSource.startsWith("#!/usr/bin/env node")) throw new Error("CLI bin does not have a portable shebang");

  // Execute the published bin exactly as consumers do, through npx against the
  // already-installed package (no network fetch thanks to --no-install).
  const cliStatus = runShell("npx --no-install auto-ai-setup --unknown", installDestination);
  if (cliStatus !== 2) throw new Error(`CLI smoke validation expected exit code 2, received ${cliStatus}`);

  process.stdout.write("Smoke validation passed: packed ESM bin, shebang, sandbox install, and npx --no-install exit-code mapping.\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
