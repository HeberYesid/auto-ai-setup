import type { RecoveryResult } from "../shared/ports.js";
import type { RunId, SafeProjectPath, ExitCode } from "../shared/types.js";

export type EventLevel = "debug" | "info" | "warn" | "error";
export type EventCategory = "session" | "project" | "stack" | "cli" | "catalog" | "plan" | "security" | "transaction";

export interface LocalEvent {
  readonly runId: RunId;
  readonly timestamp: string;
  readonly level: EventLevel;
  readonly category: EventCategory;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface RedactedEvent extends LocalEvent {
  readonly redacted: true;
}

export interface ExecutionSummary {
  readonly runId: RunId;
  readonly status: "success" | "cancelled" | "failed-recovered" | "incomplete" | "invalid-input";
  readonly exitCode: ExitCode;
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly recovery?: RecoveryResult;
  readonly manualReviewPaths: readonly SafeProjectPath[];
  readonly analysis?: {
    readonly analyzedFileCount: number;
    readonly elapsedMs: number;
    readonly peakRssBytes: number;
    readonly withinProfile: boolean;
  };
}
