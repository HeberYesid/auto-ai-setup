import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { CanonicalPath, SafeProjectPath } from "../../domain/shared/types.js";
import { asSafeProjectPath } from "../../domain/shared/types.js";
import { formatForPath, isRecognizedEvidencePath } from "../../domain/project/evidence.js";
import type { FileDescriptor, ScanPolicy, ScanResult } from "../../domain/project/models.js";
import type { ByteCount } from "../../domain/shared/types.js";

export const DEFAULT_EXCLUDED_DIRECTORIES: readonly string[] = [
  "node_modules", ".pnpm", ".yarn", "vendor", ".venv", "venv", ".git", ".hg", ".svn", "dist", "build", "out", ".next", "coverage", ".nyc_output",
];

export interface ScanClock {
  monotonicMs(): number;
}

export class SystemScanClock implements ScanClock {
  monotonicMs(): number { return performance.now(); }
}

export class BoundedAsyncScanner {
  private readonly clock: ScanClock;
  private readonly excluded: ReadonlySet<string>;

  constructor(clock: ScanClock = new SystemScanClock(), excludedDirectories: readonly string[] = DEFAULT_EXCLUDED_DIRECTORIES) {
    this.clock = clock;
    this.excluded = new Set(excludedDirectories.map((directory) => directory.toLowerCase()));
  }

  async scan(root: CanonicalPath, policy: ScanPolicy): Promise<ScanResult> {
    const started = this.clock.monotonicMs();
    const descriptors: FileDescriptor[] = [];
    const skippedDirectories: string[] = [];
    let skippedFiles = 0;
    let skippedBytes = 0;
    let totalBytes = 0;
    let limitsReached = false;
    const excluded = new Set([...this.excluded, ...policy.excludedDirectories.map((directory) => directory.toLowerCase())]);
    const directories: string[] = [""];
    const concurrency = Math.max(1, Math.floor(policy.concurrency));
    const maxFiles = Math.max(0, Math.floor(policy.maxFiles));
    const maxBytes = Math.max(0, policy.maxBytes as number);
    const maxFileBytes = Math.max(0, policy.maxFileBytes as number);

    while (directories.length > 0 && !limitsReached) {
      const batch = directories.splice(0, concurrency);
      const results = await Promise.all(batch.map((relative) => this.readDirectory(root, relative, excluded)));
      const discoveredDirectories: string[] = [];
      const files: string[] = [];
      for (const result of results) {
        skippedDirectories.push(...result.skippedDirectories);
        discoveredDirectories.push(...result.directories);
        files.push(...result.files);
      }
      files.sort((left, right) => {
        const recognizedDifference = Number(isRecognizedEvidencePath(right)) - Number(isRecognizedEvidencePath(left));
        return recognizedDifference || left.localeCompare(right);
      });
      discoveredDirectories.sort((left, right) => left.localeCompare(right));
      directories.push(...discoveredDirectories);

      for (const relative of files) {
        if (descriptors.length >= maxFiles) { skippedFiles += 1; limitsReached = true; break; }
        const absolute = join(root, relative);
        let stats;
        try { stats = await lstat(absolute); }
        catch { skippedFiles += 1; continue; }
        if (stats.isSymbolicLink() || !stats.isFile()) continue;
        const bytes = stats.size;
        if (bytes > maxFileBytes || totalBytes + bytes > maxBytes) {
          skippedFiles += 1;
          skippedBytes += bytes;
          limitsReached = true;
          break;
        }
        const safe = asSafeProjectPath(relative.replaceAll("\\", "/"));
        if (!safe.ok) { skippedFiles += 1; continue; }
        descriptors.push({ path: safe.value, extension: extensionOf(relative), bytes: bytes as ByteCount, isSymlink: false });
        totalBytes += bytes;
        if (descriptors.length >= maxFiles || totalBytes >= maxBytes) limitsReached = true;
      }
    }

    const elapsedMs = Math.max(0, this.clock.monotonicMs() - started);
    return { descriptors, summary: { files: descriptors.length, bytes: totalBytes, skippedFiles, skippedBytes, skippedDirectories, elapsedMs, withinLimits: !limitsReached } };
  }

  async *inventory(root: CanonicalPath, policy: ScanPolicy): AsyncIterable<FileDescriptor> {
    const result = await this.scan(root, policy);
    for (const descriptor of result.descriptors) yield descriptor;
  }

  private async readDirectory(root: CanonicalPath, relative: string, excluded: ReadonlySet<string>): Promise<DirectoryListing> {
    const absolute = join(root, relative);
    const directories: string[] = [];
    const files: string[] = [];
    const skippedDirectories: string[] = [];
    let entries;
    try { entries = await readdir(absolute, { withFileTypes: true }); }
    catch { return { directories, files, skippedDirectories }; }
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (excluded.has(entry.name.toLowerCase())) { skippedDirectories.push(child); continue; }
        directories.push(child);
      } else if (entry.isFile()) files.push(child);
    }
    return { directories, files, skippedDirectories };
  }
}

interface DirectoryListing {
  readonly directories: string[];
  readonly files: string[];
  readonly skippedDirectories: string[];
}

const extensionOf = (path: string): string => {
  const name = path.split(/[\\/]/u).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};

export const defaultScanPolicy = (overrides: Partial<ScanPolicy> = {}): ScanPolicy => ({
  maxFiles: 10_000,
  maxBytes: 25_000_000 as ByteCount,
  maxFileBytes: 1_000_000 as ByteCount,
  concurrency: 4,
  excludedDirectories: DEFAULT_EXCLUDED_DIRECTORIES,
  ...overrides,
});

export const isRecognizedPath = (path: SafeProjectPath): boolean => formatForPath(path) !== undefined;
