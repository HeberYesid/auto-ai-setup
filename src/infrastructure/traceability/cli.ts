import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatTraceabilityReport, validateTraceability } from "./validator.js";
import type { TraceabilityDocument, TraceabilityFileOptions } from "./models.js";

const readDocument = async (path: string): Promise<TraceabilityDocument> => ({ path, content: await readFile(path, "utf8") });

const collectTestPaths = async (directory: string): Promise<string[]> => {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await collectTestPaths(path)));
    else if (entry.isFile() && extname(entry.name) === ".ts" && entry.name.endsWith(".test.ts")) paths.push(path);
  }
  return paths.sort((left, right) => left.localeCompare(right));
};

export const loadTraceabilityInput = async (options: TraceabilityFileOptions) => {
  const testPaths = await collectTestPaths(options.testsDirectory);
  const [requirements, tasks, tests] = await Promise.all([
    readDocument(options.requirementsPath),
    readDocument(options.tasksPath),
    Promise.all(testPaths.map((path) => readDocument(path))),
  ]);
  const coverage = options.coveragePath === undefined ? undefined : await readDocument(options.coveragePath);
  return coverage === undefined ? { requirements, tasks, tests } : { requirements, tasks, tests, coverage };
};

export const runTraceabilityCli = async (root = process.cwd()): Promise<number> => {
  const options: TraceabilityFileOptions = {
    requirementsPath: resolve(root, ".kiro/specs/auto-ai-setup/requirements.md"),
    tasksPath: resolve(root, ".kiro/specs/auto-ai-setup/tasks.md"),
    testsDirectory: resolve(root, "tests"),
    coveragePath: resolve(root, ".kiro/specs/auto-ai-setup/traceability.md"),
  };
  const report = validateTraceability(await loadTraceabilityInput(options));
  console.log(formatTraceabilityReport(report));
  return report.ok ? 0 : 1;
};

const currentModule = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === currentModule) {
  void runTraceabilityCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
