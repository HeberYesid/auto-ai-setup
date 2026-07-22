import { randomUUID } from "node:crypto";
import { extname, join, relative, resolve, sep } from "node:path";
import { readdir, lstat, realpath, readFile, stat as statPath, unlink, writeFile } from "node:fs/promises";
import type { ProjectEntry, ProjectEntryKind, ProjectGateway, ProjectValidationPort } from "../../domain/shared/ports.js";
import type { ByteCount, CanonicalPath, DirectoryError, Result, SafeProjectPath } from "../../domain/shared/types.js";
import type { FileDescriptor, ScanPolicy, ValidatedProject } from "../../domain/project/models.js";
import { asCanonicalPath, asSafeProjectPath, err, ok } from "../../domain/shared/types.js";

const DEFAULT_PROBE_CONTENT = new TextEncoder().encode("auto-ai-setup-validation");
const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  "node_modules", ".pnpm", ".yarn", "vendor", ".venv", "venv", ".git", ".hg", ".svn",
  "dist", "build", "out", ".next", "coverage", ".nyc_output",
]);
const RECOGNIZED_SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".py", ".rb", ".php"]);

/** Node adapter for the small filesystem port used by project validation. */
export class NodeProjectValidationPort implements ProjectValidationPort {
  async stat(path: string): Promise<ProjectEntryKind> {
    const entry = await statPath(path);
    if (entry.isDirectory()) return "directory";
    if (entry.isFile()) return "file";
    if (entry.isSymbolicLink()) return "symlink";
    return "other";
  }

  async realpath(path: string): Promise<string> {
    return realpath(path);
  }

  async enumerate(root: string): Promise<readonly ProjectEntry[]> {
    const entries: ProjectEntry[] = [];
    await this.walk(root, root, entries);
    return entries;
  }

  async readFile(path: string): Promise<Uint8Array> {
    return readFile(path);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  }

  async removeFile(path: string): Promise<void> {
    await unlink(path);
  }

  private async walk(root: string, current: string, output: ProjectEntry[]): Promise<void> {
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children) {
      const absolutePath = join(current, child.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (child.isDirectory()) {
        output.push({ absolutePath, relativePath, kind: "directory" });
        await this.walk(root, absolutePath, output);
      } else if (child.isSymbolicLink()) {
        output.push({ absolutePath, relativePath, kind: "symlink" });
      } else if (child.isFile()) {
        const metadata = await lstat(absolutePath);
        output.push({ absolutePath, relativePath, kind: "file", bytes: metadata.size });
      } else {
        output.push({ absolutePath, relativePath, kind: "other" });
      }
    }
  }
}

export interface ProjectGatewayOptions {
  readonly probeContent?: Uint8Array;
  readonly probeName?: () => string;
}

/** Safe, effect-bounded implementation of ProjectGateway's project boundary. */
export class NodeProjectGateway implements ProjectGateway {
  private validatedRoot: CanonicalPath | undefined;
  private readonly probeContent: Uint8Array;
  private readonly probeName: () => string;

  constructor(
    private readonly filesystem: ProjectValidationPort = new NodeProjectValidationPort(),
    options: ProjectGatewayOptions = {},
  ) {
    this.probeContent = options.probeContent?.slice() ?? DEFAULT_PROBE_CONTENT.slice();
    this.probeName = options.probeName ?? (() => randomUUID());
  }

  async validateDirectory(path: string): Promise<Result<ValidatedProject, DirectoryError>> {
    let kind: ProjectEntryKind;
    try {
      kind = await this.filesystem.stat(path);
    } catch (cause) {
      return err(this.directoryError("exists", path, cause));
    }
    if (kind !== "directory") return err(this.directoryError("directory", path, "The selected path is not a directory"));

    let canonical: CanonicalPath;
    try {
      const resolved = await this.filesystem.realpath(path);
      const result = asCanonicalPath(resolved);
      if (!result.ok) return err(this.directoryError("realpath", path, result.error.message));
      canonical = result.value;
    } catch (cause) {
      return err(this.directoryError("realpath", path, cause));
    }

    let entries: readonly ProjectEntry[];
    try {
      entries = await this.filesystem.enumerate(canonical);
    } catch (cause) {
      return err(this.directoryError("enumerate", canonical, cause));
    }

    for (const entry of entries) {
      if (entry.kind !== "file" || !isRecognizedEvidence(entry.relativePath)) continue;
      try {
        await this.filesystem.readFile(entry.absolutePath);
      } catch (cause) {
        return err(this.directoryError("read", entry.relativePath, cause));
      }
    }

    const probeResult = await this.runProbe(canonical);
    if (!probeResult.ok) return probeResult;

    this.validatedRoot = canonical;
    const projectFileCount = entries.filter((entry) => entry.kind === "file" && !isToolOwned(entry.relativePath)).length;
    const recognizedAiConfig = entries
      .filter((entry) => entry.kind === "file" && isRecognizedAiConfig(entry.relativePath))
      .map((entry) => asSafeProjectPath(entry.relativePath))
      .filter((entry): entry is { readonly ok: true; readonly value: SafeProjectPath } => entry.ok)
      .map((entry) => entry.value);

    return ok({
      root: canonical,
      kind: projectFileCount === 0 ? "new" : "existing",
      projectFileCount,
      recognizedAiConfig,
    });
  }

  async *inventory(root: CanonicalPath, policy: ScanPolicy): AsyncIterable<FileDescriptor> {
    let entries: readonly ProjectEntry[];
    try {
      entries = await this.filesystem.enumerate(root);
    } catch {
      return;
    }
    const excluded = new Set([...DEFAULT_EXCLUDED_DIRECTORIES, ...policy.excludedDirectories]);
    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (entry.kind !== "file" || isExcluded(entry.relativePath, excluded)) continue;
      const size = entry.bytes ?? 0;
      if (size > Number(policy.maxFileBytes) || count >= policy.maxFiles || bytes + size > Number(policy.maxBytes)) continue;
      const safe = asSafeProjectPath(entry.relativePath);
      if (!safe.ok) continue;
      count += 1;
      bytes += size;
      yield { path: safe.value, extension: extname(entry.relativePath).toLowerCase(), bytes: size as ByteCount, isSymlink: false };
    }
  }

  async readRecognized(path: SafeProjectPath, limit: ByteCount): Promise<Result<Uint8Array, DirectoryError>> {
    const root = this.validatedRoot;
    if (root === undefined) return err(this.directoryError("read", String(path), "No directory has been validated"));
    const safe = asSafeProjectPath(String(path));
    if (!safe.ok) return err(this.directoryError("read", String(path), "The path is not project-relative"));
    const target = resolve(root, safe.value);
    if (!isContained(root, target)) return err(this.directoryError("read", String(path), "The path escapes the canonical project root"));
    try {
      const targetRealpath = await this.filesystem.realpath(target);
      if (!isContained(root, targetRealpath)) return err(this.directoryError("read", String(path), "The path resolves outside the canonical project root"));
      const bytes = await this.filesystem.readFile(target);
      if (bytes.byteLength > Number(limit)) return err(this.directoryError("read", String(path), "The recognized file exceeds the configured byte limit"));
      return ok(bytes);
    } catch (cause) {
      return err(this.directoryError("read", String(path), cause));
    }
  }
  private async runProbe(root: CanonicalPath): Promise<Result<void, DirectoryError>> {
    const probePath = join(root, `.auto-ai-setup.validation-${this.probeName()}.tmp`);
    let created = false;
    let stage: "write" | "read" | "delete" = "write";
    try {
      await this.filesystem.writeFile(probePath, this.probeContent);
      created = true;
      stage = "read";
      const content = await this.filesystem.readFile(probePath);
      if (!equalBytes(content, this.probeContent)) {
        throw new Error("temporary probe read-back mismatch");
      }
      stage = "delete";
      await this.filesystem.removeFile(probePath);
      created = false;
      return ok(undefined);
    } catch (cause) {
      if (created) {
        try {
          await this.filesystem.removeFile(probePath);
          created = false;
        } catch (cleanupCause) {
          return err(this.directoryError("delete", probePath, cleanupCause));
        }
      }
      if (!created && stage === "delete") return err(this.directoryError("delete", probePath, cause));
      return err(this.directoryError(stage, probePath, cause));
    }
  }

  private directoryError(
    check: DirectoryError["check"],
    path: string,
    cause: unknown,
  ): DirectoryError {
    const codeByCheck: Record<DirectoryError["check"], DirectoryError["code"]> = {
      exists: "DIRECTORY_NOT_FOUND",
      directory: "NOT_DIRECTORY",
      realpath: "REALPATH_FAILED",
      enumerate: "ENUMERATE_FAILED",
      read: "READ_PROBE_FAILED",
      write: "WRITE_PROBE_FAILED",
      delete: "DELETE_PROBE_FAILED",
    };
    const causeText = safeCause(cause);
    return {
      code: codeByCheck[check],
      check,
      exitCode: 2,
      message: `${check} check failed: ${causeText}`,
      cause: causeText,
      path,
      recoverability: "none",
      suggestedAction: "Choose a readable and writable local directory and try again",
    };
  }
}

const safeCause = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/[\r\n]+/g, " ").slice(0, 240) || "unknown filesystem error";
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const isContained = (root: string, candidate: string): boolean => {
  const rest = relative(root, candidate);
  return rest === "" || (!rest.startsWith(`..${sep}`) && rest !== ".." && !rest.includes(`..${sep}`) && !/^[A-Za-z]:/.test(rest));
};

const isExcluded = (relativePath: string, excluded: ReadonlySet<string>): boolean => {
  const segments = relativePath.split("/");
  return segments.some((segment) => excluded.has(segment));
};

const isToolOwned = (relativePath: string): boolean => {
  return relativePath === ".auto-ai-setup" || relativePath.startsWith(".auto-ai-setup/");
};

const isRecognizedAiConfig = (relativePath: string): boolean => {
  return relativePath === "AGENTS.md"
    || relativePath === ".kiro/settings/mcp.json"
    || /^\.kiro\/prompts\/[^/]+\.md$/i.test(relativePath)
    || relativePath === ".auto-ai-setup/commands.json";
};

const isRecognizedEvidence = (relativePath: string): boolean => {
  const name = relativePath.split("/").pop()?.toLowerCase() ?? "";
  const extension = extname(name);
  return RECOGNIZED_SOURCE_EXTENSIONS.has(extension)
    || name === "package.json"
    || name === "package-lock.json"
    || name === "pnpm-lock.yaml"
    || name === "yarn.lock"
    || name === "bun.lock"
    || name === "bun.lockb"
    || name === "pyproject.toml"
    || name === "poetry.lock"
    || name === "uv.lock"
    || name === "requirements.txt"
    || name === "gemfile"
    || name === "gemfile.lock"
    || name === "composer.json"
    || name === "composer.lock"
    || /^(tsconfig|jsconfig)(\..+)?\.json$/.test(name)
    || /^(vite|next|nuxt|webpack|rollup|astro|svelte|playwright|vitest|jest|eslint|prettier|tailwind|vercel)\.config\./.test(name)
    || /^\.github\/workflows\/.*\.ya?ml$/.test(relativePath.toLowerCase());
};
