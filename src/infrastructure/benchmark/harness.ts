import { readFile, statfs } from "node:fs/promises";
import * as operatingSystem from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  aggregateDetections,
  createStackViewModel,
  DefaultStackDetectorRegistry,
  isRecognizedEvidencePath,
  parseRecognizedEvidence,
} from "../../domain/index.js";
import type { CanonicalPath } from "../../domain/shared/types.js";
import type { DetectionClaim } from "../../domain/project/models.js";
import { BoundedAsyncScanner, defaultScanPolicy } from "../fs/scanner.js";
import type {
  BenchmarkGate,
  BenchmarkOptions,
  BenchmarkReport,
  BenchmarkRun,
  BenchmarkStatistics,
  CacheState,
  LoadedFixture,
  MachineProfile,
} from "./models.js";
import {
  BENCHMARK_SCHEMA_VERSION,
  DEFAULT_BENCHMARK_RUNS,
  PROFILE_MAX_BYTES,
  PROFILE_MAX_FILES,
  RSS_LIMIT_BYTES,
  TIME_LIMIT_MS,
} from "./models.js";

export interface BenchmarkEnvironment {
  readonly command?: string;
  readonly commit?: string;
  readonly profile?: MachineProfile;
  readonly sampleRss?: () => number;
}

export const runBenchmark = async (
  fixture: LoadedFixture,
  options: BenchmarkOptions = {},
  environment: BenchmarkEnvironment = {},
): Promise<BenchmarkReport> => {
  const runs = normalizeRuns(options.runs);
  const cache: CacheState = options.cache ?? "warm";
  const command = options.command ?? process.argv.join(" ");
  const benchmarkId = options.benchmarkId ?? `stack-scan-${fixture.manifest.id}`;
  const profile = environment.profile ?? (await collectMachineProfile(fixture.root));
  const sampleRss = environment.sampleRss ?? (() => process.memoryUsage().rss);
  const measurements: BenchmarkRun[] = [];
  for (let index = 0; index < runs; index += 1) {
    measurements.push(await measureRun(fixture.root, index + 1, cache, sampleRss));
  }
  const statistics = summarize(measurements);
  const gate = evaluateGate(measurements, statistics, options.gate === true);
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmarkId,
    fixture: { id: fixture.manifest.id, fileCount: fixture.manifest.fileCount, bytes: fixture.manifest.expectedBytes, root: fixture.root },
    profile,
    runtime: {
      node: process.version,
      commit: environment.commit ?? options.commit ?? process.env.GIT_COMMIT ?? process.env.GITHUB_SHA ?? "unknown",
    },
    cache,
    command,
    runs: measurements,
    statistics,
    gate,
  };
};

export const assertControlledGate = (report: BenchmarkReport): void => {
  if (report.gate.mode === "controlled" && report.gate.passed !== true) throw new Error(`Benchmark gate failed: ${report.gate.reason}`);
};

const measureRun = async (root: CanonicalPath, run: number, cache: CacheState, sampleRss: () => number): Promise<BenchmarkRun> => {
  let peakRssBytes = sampleRss();
  const timer = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, sampleRss());
  }, 10);
  const started = performance.now();
  try {
    const scan = await new BoundedAsyncScanner().scan(
      root,
      defaultScanPolicy({
        maxFiles: PROFILE_MAX_FILES,
        maxBytes: PROFILE_MAX_BYTES as import("../../domain/shared/types.js").ByteCount,
        maxFileBytes: PROFILE_MAX_BYTES as import("../../domain/shared/types.js").ByteCount,
        concurrency: 8,
      }),
    );
    const registry = new DefaultStackDetectorRegistry();
    const claims: DetectionClaim[] = [];
    for (const descriptor of scan.descriptors) {
      if (!isRecognizedEvidencePath(descriptor.path)) continue;
      try {
        const evidence = parseRecognizedEvidence(descriptor.path, await readFile(join(root, descriptor.path)));
        if (!evidence.ok) continue;
        for (const detector of registry.find(descriptor.path)) claims.push(...detector.detect(evidence.value));
      } catch {
        // An unreadable optional evidence file does not stop the local benchmark.
      }
    }
    const analysis = aggregateDetections(claims, {
      analyzedFileCount: scan.summary.files,
      analyzedBytes: scan.summary.bytes,
      elapsedMs: scan.summary.elapsedMs,
    });
    createStackViewModel(analysis);
    peakRssBytes = Math.max(peakRssBytes, sampleRss());
    return {
      run,
      cache,
      scanToStackMs: Math.max(0, performance.now() - started),
      peakRssBytes,
      analyzedFileCount: scan.summary.files,
      analyzedBytes: scan.summary.bytes,
      withinProfile: scan.summary.files <= PROFILE_MAX_FILES && scan.summary.bytes <= PROFILE_MAX_BYTES,
    };
  } finally {
    clearInterval(timer);
  }
};

export const summarize = (runs: readonly BenchmarkRun[]): BenchmarkStatistics => {
  const times = runs.map((run) => run.scanToStackMs).sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    times.length === 0 ? 0 : (times[Math.min(times.length - 1, Math.max(0, Math.ceil(times.length * fraction) - 1))] ?? 0);
  return {
    p50Ms: percentile(0.5),
    p90Ms: percentile(0.9),
    maxMs: times.at(-1) ?? 0,
    maxRssBytes: Math.max(0, ...runs.map((run) => run.peakRssBytes)),
    runsUnderTimeLimit: runs.filter((run) => run.scanToStackMs <= TIME_LIMIT_MS).length,
  };
};

export const evaluateGate = (runs: readonly BenchmarkRun[], statistics: BenchmarkStatistics, enabled: boolean): BenchmarkGate => {
  if (!enabled)
    return {
      mode: "disabled",
      passed: null,
      reason: "Controlled performance gates are disabled by default; enable them only on a stable benchmark environment.",
    };
  const nineOfTen = runs.length >= DEFAULT_BENCHMARK_RUNS && statistics.runsUnderTimeLimit >= runs.length - 1;
  const profile = runs.every((run) => run.withinProfile);
  const rss = statistics.maxRssBytes <= RSS_LIMIT_BYTES;
  const passed = nineOfTen && profile && rss;
  const reason = passed
    ? "At least 9/10 runs met the time limit and peak RSS stayed within the profile."
    : `Gate conditions: ${statistics.runsUnderTimeLimit}/${runs.length} runs <= ${TIME_LIMIT_MS}ms, profile=${profile}, maxRss=${statistics.maxRssBytes} bytes (limit ${RSS_LIMIT_BYTES}).`;
  return { mode: "controlled", passed, reason };
};

export const collectMachineProfile = async (path: CanonicalPath): Promise<MachineProfile> => {
  const cpus = operatingSystem.cpus();
  let storage = { filesystemType: "unknown", blockSize: 0, totalBytes: 0, availableBytes: 0 };
  try {
    const stats = await statfs(path);
    storage = {
      filesystemType: `0x${stats.type.toString(16)}`,
      blockSize: stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
      availableBytes: stats.bavail * stats.bsize,
    };
  } catch {
    // Storage metadata is best effort on filesystems that do not expose statfs.
  }
  return {
    cpu: { count: cpus.length, model: cpus[0]?.model ?? "unknown", speedMHz: cpus[0]?.speed ?? 0 },
    memory: { totalBytes: operatingSystem.totalmem() },
    storage: { path, ...storage },
    os: { platform: operatingSystem.platform(), release: operatingSystem.release(), arch: operatingSystem.arch() },
  };
};

const normalizeRuns = (runs: number | undefined): number => {
  const value = runs ?? DEFAULT_BENCHMARK_RUNS;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("Benchmark runs must be an integer between 1 and 100");
  return value;
};
