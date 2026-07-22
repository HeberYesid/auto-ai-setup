import type { CanonicalPath, Result } from "../../domain/shared/types.js";

export const BENCHMARK_SCHEMA_VERSION = 1 as const;
export const FIXTURE_SCHEMA_VERSION = 1 as const;
export const PROFILE_MAX_FILES = 10_000;
export const PROFILE_MAX_BYTES = 500_000_000;
export const DEFAULT_BENCHMARK_RUNS = 10;
export const RSS_LIMIT_BYTES = 512 * 1024 * 1024;
export const TIME_LIMIT_MS = 10_000;

export type CacheState = "cold" | "warm";

export interface FixtureSpec {
  readonly schemaVersion: typeof FIXTURE_SCHEMA_VERSION;
  readonly id: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly seed: number;
  readonly excludedFileCount: number;
}

export interface FixtureManifest extends FixtureSpec {
  readonly dataDirectory: "data";
  readonly files: readonly string[];
  readonly expectedBytes: number;
  readonly generatedAt?: string;
}

export interface LoadedFixture {
  readonly manifestPath: string;
  readonly root: CanonicalPath;
  readonly manifest: FixtureManifest;
}

export interface MachineProfile {
  readonly cpu: { readonly count: number; readonly model: string; readonly speedMHz: number };
  readonly memory: { readonly totalBytes: number };
  readonly storage: {
    readonly path: string;
    readonly filesystemType: string;
    readonly blockSize: number;
    readonly totalBytes: number;
    readonly availableBytes: number;
  };
  readonly os: { readonly platform: string; readonly release: string; readonly arch: string };
}

export interface BenchmarkRun {
  readonly run: number;
  readonly cache: CacheState;
  readonly scanToStackMs: number;
  readonly peakRssBytes: number;
  readonly analyzedFileCount: number;
  readonly analyzedBytes: number;
  readonly withinProfile: boolean;
}

export interface BenchmarkStatistics {
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly maxMs: number;
  readonly maxRssBytes: number;
  readonly runsUnderTimeLimit: number;
}

export interface BenchmarkGate {
  readonly mode: "disabled" | "controlled";
  readonly passed: boolean | null;
  readonly reason: string;
}

export interface BenchmarkReport {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly benchmarkId: string;
  readonly fixture: { readonly id: string; readonly fileCount: number; readonly bytes: number; readonly root: string };
  readonly profile: MachineProfile;
  readonly runtime: { readonly node: string; readonly commit: string };
  readonly cache: CacheState;
  readonly command: string;
  readonly runs: readonly BenchmarkRun[];
  readonly statistics: BenchmarkStatistics;
  readonly gate: BenchmarkGate;
}

export interface FixtureError {
  readonly code: "INVALID_SPEC" | "INVALID_MANIFEST" | "FIXTURE_IO" | "FIXTURE_MISMATCH";
  readonly message: string;
  readonly path?: string;
}

export type FixtureResult<T> = Result<T, FixtureError>;

export interface BenchmarkOptions {
  readonly runs?: number;
  readonly cache?: CacheState;
  readonly command?: string;
  readonly commit?: string;
  readonly gate?: boolean;
  readonly benchmarkId?: string;
}
