import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { asCanonicalPath, asSafeProjectPath, err, ok } from "../../domain/shared/types.js";
import type { ByteCount, Result } from "../../domain/shared/types.js";
import { BoundedAsyncScanner, defaultScanPolicy } from "../fs/scanner.js";
import type { FixtureError, FixtureManifest, FixtureResult, FixtureSpec, LoadedFixture } from "./models.js";
import { FIXTURE_SCHEMA_VERSION, PROFILE_MAX_BYTES, PROFILE_MAX_FILES } from "./models.js";

const manifestName = "fixture.json";
const packageJson = '{"name":"benchmark-fixture","dependencies":{"react":"18.0.0"}}';

export const defaultFixtureSpec = (id = "default"): FixtureSpec => ({
  schemaVersion: FIXTURE_SCHEMA_VERSION,
  id,
  fileCount: 100,
  totalBytes: 100 * 1024,
  seed: 42,
  excludedFileCount: 1,
});

export const validateFixtureSpec = (spec: FixtureSpec): FixtureResult<FixtureSpec> => {
  if (spec.schemaVersion !== FIXTURE_SCHEMA_VERSION || !/^[a-z0-9][a-z0-9._-]*$/u.test(spec.id))
    return fixtureError("INVALID_SPEC", "Fixture schema version or id is invalid");
  if (!Number.isInteger(spec.fileCount) || spec.fileCount < 0 || spec.fileCount > PROFILE_MAX_FILES)
    return fixtureError("INVALID_SPEC", `fileCount must be between 0 and ${PROFILE_MAX_FILES}`);
  if (!Number.isInteger(spec.totalBytes) || spec.totalBytes < 0 || spec.totalBytes > PROFILE_MAX_BYTES)
    return fixtureError("INVALID_SPEC", `totalBytes must be between 0 and ${PROFILE_MAX_BYTES}`);
  if (spec.fileCount === 0 && spec.totalBytes !== 0) return fixtureError("INVALID_SPEC", "An empty fixture must have zero bytes");
  if (spec.fileCount > 0 && spec.totalBytes < spec.fileCount)
    return fixtureError("INVALID_SPEC", "totalBytes must provide at least one byte per file");
  if (!Number.isInteger(spec.seed) || spec.seed < 0) return fixtureError("INVALID_SPEC", "seed must be a non-negative integer");
  if (!Number.isInteger(spec.excludedFileCount) || spec.excludedFileCount < 0)
    return fixtureError("INVALID_SPEC", "excludedFileCount must be non-negative");
  return ok(spec);
};

export const generateFixture = async (
  fixtureDirectory: string,
  input: Omit<FixtureSpec, "schemaVersion"> | FixtureSpec,
): Promise<FixtureResult<FixtureManifest>> => {
  const spec: FixtureSpec = { schemaVersion: FIXTURE_SCHEMA_VERSION, ...input };
  const valid = validateFixtureSpec(spec);
  if (!valid.ok) return valid;
  const root = resolve(fixtureDirectory);
  const dataRoot = join(root, "data");
  try {
    await mkdir(dataRoot, { recursive: true });
    const files = distributePaths(spec);
    const sizes = distributeSizes(spec.fileCount, spec.totalBytes);
    await Promise.all(
      files.map(async (relative, index) => {
        const absolute = join(dataRoot, relative);
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, contentFor(relative, sizes[index] ?? 0, spec.seed));
      }),
    );
    await Promise.all(
      Array.from({ length: spec.excludedFileCount }, async (_, index) => {
        const relative = join("node_modules", "excluded", `file-${index.toString().padStart(5, "0")}.ts`);
        const absolute = join(dataRoot, relative);
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, `excluded-${spec.seed}-${index}\n`);
      }),
    );
    const manifest: FixtureManifest = { ...spec, dataDirectory: "data", files, expectedBytes: spec.totalBytes };
    await writeFile(join(root, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return ok(manifest);
  } catch (cause) {
    return fixtureError("FIXTURE_IO", `Unable to generate fixture: ${causeMessage(cause)}`, root);
  }
};

export const loadFixture = async (fixtureDirectory: string): Promise<FixtureResult<LoadedFixture>> => {
  const directory = resolve(fixtureDirectory);
  const manifestPath = join(directory, manifestName);
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    const manifest = parseManifest(parsed);
    if (!manifest.ok) return manifest;
    const dataPath = await realpath(join(directory, manifest.value.dataDirectory));
    const canonical = asCanonicalPath(dataPath);
    if (!canonical.ok) return fixtureError("INVALID_MANIFEST", canonical.error.message, dataPath);
    const scan = await new BoundedAsyncScanner().scan(
      canonical.value,
      defaultScanPolicy({
        maxFiles: PROFILE_MAX_FILES,
        maxBytes: PROFILE_MAX_BYTES as ByteCount,
        maxFileBytes: PROFILE_MAX_BYTES as ByteCount,
      }),
    );
    if (scan.summary.files !== manifest.value.fileCount || scan.summary.bytes !== manifest.value.expectedBytes)
      return fixtureError(
        "FIXTURE_MISMATCH",
        `Expected ${manifest.value.fileCount} files/${manifest.value.expectedBytes} bytes, found ${scan.summary.files} files/${scan.summary.bytes} bytes`,
        dataPath,
      );
    const expected = new Set(manifest.value.files);
    const actual = new Set(scan.descriptors.map((descriptor) => String(descriptor.path)));
    if (expected.size !== actual.size || [...expected].some((path) => !actual.has(path)))
      return fixtureError("FIXTURE_MISMATCH", "Fixture file manifest does not match the scanned files", dataPath);
    return ok({ manifestPath, root: canonical.value, manifest: manifest.value });
  } catch (cause) {
    return fixtureError("FIXTURE_IO", `Unable to load fixture: ${causeMessage(cause)}`, manifestPath);
  }
};

const distributePaths = (spec: FixtureSpec): string[] => {
  if (spec.fileCount === 0) return [];
  const usePackage = spec.fileCount > 1 && Math.floor(spec.totalBytes / spec.fileCount) >= packageJson.length;
  return Array.from({ length: spec.fileCount }, (_, index) =>
    usePackage && index === 0 ? "package.json" : `src/file-${index.toString().padStart(5, "0")}.ts`,
  );
};

const distributeSizes = (count: number, total: number): number[] => {
  if (count === 0) return [];
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
};

const contentFor = (path: string, size: number, seed: number): string => {
  if (path === "package.json") return packageJson + " ".repeat(Math.max(0, size - packageJson.length));
  const prefix = `export const fixture_${seed} = ${seed};\n`;
  if (prefix.length >= size) return prefix.slice(0, size);
  return prefix + "x".repeat(size - prefix.length);
};

const parseManifest = (value: unknown): FixtureResult<FixtureManifest> => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== FIXTURE_SCHEMA_VERSION ||
    value.dataDirectory !== "data" ||
    typeof value.id !== "string" ||
    typeof value.fileCount !== "number" ||
    typeof value.expectedBytes !== "number" ||
    !Array.isArray(value.files)
  )
    return fixtureError("INVALID_MANIFEST", "Fixture manifest has an invalid schema");
  const files = value.files.filter((entry): entry is string => typeof entry === "string");
  if (files.length !== value.files.length || files.some((path) => !asSafeProjectPath(path).ok))
    return fixtureError("INVALID_MANIFEST", "Fixture manifest contains an unsafe or invalid file path");
  const candidate: FixtureManifest = {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    id: value.id,
    fileCount: value.fileCount,
    totalBytes: value.expectedBytes,
    seed: typeof value.seed === "number" ? value.seed : 0,
    excludedFileCount: typeof value.excludedFileCount === "number" ? value.excludedFileCount : 0,
    dataDirectory: "data",
    files,
    expectedBytes: value.expectedBytes,
  };
  const checked = validateFixtureSpec(candidate);
  return checked.ok ? ok(candidate) : checked;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const fixtureError = (code: FixtureError["code"], message: string, path?: string): Result<never, FixtureError> =>
  path === undefined ? err({ code, message }) : err({ code, message, path });
