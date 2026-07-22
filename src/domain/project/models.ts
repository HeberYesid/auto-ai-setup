import type {
  ByteCount,
  CanonicalPath,
  ComponentId,
  Result,
  SafeProjectPath,
  Sha256,
} from "../shared/types.js";

export type ProjectKind = "new" | "existing";
export type StackCategory = "language" | "package-manager" | "framework" | "tool";
export type EvidenceFormat = "json" | "toml" | "yaml" | "lockfile" | "source-extension";
export type Confidence = "explicit" | "derived";

export interface ValidatedProject {
  readonly root: CanonicalPath;
  readonly kind: ProjectKind;
  readonly projectFileCount: number;
  readonly recognizedAiConfig: readonly SafeProjectPath[];
}

export interface ScanPolicy {
  readonly maxFiles: number;
  readonly maxBytes: ByteCount;
  readonly maxFileBytes: ByteCount;
  readonly concurrency: number;
  readonly excludedDirectories: readonly string[];
}

export interface FileDescriptor {
  readonly path: SafeProjectPath;
  readonly extension: string;
  readonly bytes: ByteCount;
  readonly isSymlink: false;
}

export interface ParsedEvidence {
  readonly path: SafeProjectPath;
  readonly format: EvidenceFormat;
  readonly source: Uint8Array;
  readonly location: string;
  readonly validSyntax: boolean;
  readonly validSchema: boolean;
}

export interface StackEvidence {
  readonly path: SafeProjectPath;
  readonly format: EvidenceFormat;
  readonly location: string;
  readonly recognizedValue: string;
  readonly detectorId: string;
}

export interface DetectionClaim {
  readonly category: StackCategory;
  readonly id: string;
  readonly displayName: string;
  readonly confidence: Confidence;
  readonly evidence: StackEvidence;
}

export interface StackItem {
  readonly category: StackCategory;
  readonly id: string;
  readonly displayName: string;
  readonly confidence: Confidence;
  readonly evidence: readonly StackEvidence[];
}

export interface StackConflict {
  readonly category: StackCategory;
  readonly candidates: readonly StackItem[];
  readonly blocksCapabilities: readonly ComponentId[];
}

export interface StackAnalysis {
  readonly items: readonly StackItem[];
  readonly conflicts: readonly StackConflict[];
  readonly analyzedFileCount: number;
  readonly analyzedBytes: number;
  readonly elapsedMs: number;
  readonly withinPerformanceProfile: boolean;
}

export interface ConfirmedStack {
  readonly items: readonly StackItem[];
  readonly resolvedConflicts: readonly StackConflict[];
  readonly digest: Sha256;
}

export interface FilePattern {
  readonly pattern: string;
  readonly format: EvidenceFormat;
}

export interface StackDetector {
  readonly id: string;
  readonly acceptedFiles: readonly FilePattern[];
  detect(file: ParsedEvidence): readonly DetectionClaim[];
}

export interface StackAnalyzer {
  analyze(files: AsyncIterable<FileDescriptor>): Promise<Result<StackAnalysis, import("../shared/types.js").EvidenceError>>;
}

export interface CliRecommendation {
  readonly cli: InitialCli;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly pending?: boolean;
}

export type InitialCli = "gh" | "supabase" | "vercel" | "playwright";

export interface ScanSummary {
  readonly files: number;
  readonly bytes: number;
  readonly skippedFiles: number;
  readonly skippedBytes: number;
  readonly skippedDirectories: readonly string[];
  readonly elapsedMs: number;
  readonly withinLimits: boolean;
}

export interface ScanResult {
  readonly descriptors: readonly FileDescriptor[];
  readonly summary: ScanSummary;
}

export interface EvidenceParseOptions {
  readonly format?: EvidenceFormat;
  readonly maxBytes?: ByteCount;
}
