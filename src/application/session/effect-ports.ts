/**
 * Inward-facing application and effect ports for the modern TUI interface.
 *
 * Dependency direction is strictly `cli -> application -> domain`: this module lives in the
 * application layer, imports only domain contracts, and is implemented by infrastructure
 * adapters. No domain module imports these ports and no adapter type leaks inward.
 *
 * The interactive session depends on exactly the six external effect classes described by the
 * design — terminal input/output, time, filesystem, process, and network — plus a distinct
 * redacted local-event sink. Every operation that can fail returns a typed {@link Result} so an
 * unavailable resource fails closed with a classified error instead of falling through to a real
 * terminal, filesystem, process, network, or clock.
 *
 * Command execution is modelled separately from reducers and rendering (see
 * {@link UiCommandExecutor}). Pure reducers produce {@link UiCommand} values but never touch an
 * effect; the executor is the only boundary that runs commands through {@link EffectPorts} and
 * normalizes their typed results back into {@link UiEvent}s. This guarantees that key handling can
 * never mutate the project directly and that rendering can never dispatch a command.
 */

import type { ExternalOperation, ApprovedPlan, RecoveryJournal } from "../../domain/planning/models.js";
import type {
  EventSink,
  ExternalOperationApproval,
  ProcessResult,
  RecoveryResult,
  RegisteredProcessRequest,
  TransactionResult,
} from "../../domain/shared/ports.js";
import type { AppErrorBase, DirectoryError, Result, SafeProjectPath, SecurityError } from "../../domain/shared/types.js";
// Domain TUI models are authored by subtask 1.1 under `src/domain/tui/`. They are referenced by
// type only so the two subtasks compose cleanly through the domain barrel.
import type { TerminalCapabilities, UiCommand, UiEvent } from "../../domain/tui/index.js";

/** Cancels a scheduled callback previously registered on {@link ClockPort.schedule}. */
export type CancelTimer = () => void;

/** Removes a listener previously registered on {@link TerminalPort.subscribe}. */
export type Unsubscribe = () => void;

/** Receives platform input already normalized into closed {@link UiEvent} variants. */
export type TerminalEventListener = (event: UiEvent) => void;

/** Classified failures raised at the terminal effect boundary. */
export type TerminalErrorCode = "TERMINAL_UNAVAILABLE" | "CAPABILITY_PROBE_FAILED" | "WRITE_FAILED" | "RAW_MODE_FAILED" | "RESTORE_FAILED";

export interface TerminalError extends AppErrorBase<TerminalErrorCode> {
  readonly code: TerminalErrorCode;
}

/**
 * Terminal input/output effect. Owns capability probing before first output, normalized input and
 * resize events, raw-mode entry, output writes, and idempotent restoration of terminal input mode.
 *
 * Capability probing returns an explicit snapshot with `unknown` variants rather than guessing, and
 * the port never exposes raw escape sequences to domain reducers.
 */
export interface TerminalPort {
  /** Probes both TTY streams, ANSI cursor support, color, Unicode, dimensions, mouse, and `NO_COLOR` before any output. */
  probeCapabilities(): Result<TerminalCapabilities, TerminalError>;
  /** Subscribes to normalized key/mouse/resize events. Fails closed when the terminal is unavailable. */
  subscribe(listener: TerminalEventListener): Result<Unsubscribe, TerminalError>;
  /** Writes an already-rendered output chunk. ANSI emission and profile permissions are enforced by the output adapter. */
  write(output: string): Result<void, TerminalError>;
  /** Enters raw input mode; only invoked for eligible interactive profiles. */
  enterRawMode(): Result<void, TerminalError>;
  /** Restores terminal input mode. Restoration is idempotent across completion, cancellation, interruption, and failure. */
  restore(): Result<void, TerminalError>;
}

/**
 * Time effect. Exposes wall-clock timestamps and a monotonic clock for performance instrumentation,
 * plus deterministic scheduling that drives the one-second activity threshold and timer events
 * without wall-clock sleeps. A virtual clock implements this port in tests.
 */
export interface ClockPort {
  /** Current wall-clock time as an ISO-8601 string, used for local event timestamps. */
  now(): string;
  /** Monotonic milliseconds for first-view, navigation, resize, and activity milestones. */
  monotonicMs(): number;
  /** Schedules a callback after the given monotonic delay; the returned function cancels it. */
  schedule(afterMs: number, callback: () => void): CancelTimer;
}

/**
 * Filesystem effect. Provides contained reads for inspection and the transactional application and
 * recovery lifecycle (staging, backups, persistent journal, verification, atomic rename/fsync,
 * rollback, and local recovery). Applies exactly the approved canonical operations and never a
 * broader set.
 */
export interface FilesystemPort {
  /** Reads a contained project file; used to inspect current state before planning. */
  read(path: SafeProjectPath): Promise<Result<Uint8Array, DirectoryError>>;
  /** Reports whether a contained project path currently exists. */
  exists(path: SafeProjectPath): Promise<boolean>;
  /** Applies exactly the approved canonical operations transactionally and recoverably. */
  apply(plan: ApprovedPlan, signal: AbortSignal): Promise<TransactionResult>;
  /** Recovers an incomplete transaction from its persistent journal. */
  recover(journal: RecoveryJournal): Promise<RecoveryResult>;
}

/**
 * Process effect. Admits only explicitly approved official `npx autoskills` operations bound to the
 * current plan hash; every request carries the approval so unapproved or hash-mismatched execution
 * fails closed with a typed security error.
 */
export interface AllowlistedProcessPort {
  runApproved(
    request: RegisteredProcessRequest,
    approval: ExternalOperationApproval,
    signal?: AbortSignal,
  ): Promise<Result<ProcessResult, SecurityError>>;
}

/**
 * Network effect. Deny-by-default; network is opened only for an approved autoskills operation bound
 * to the current plan hash and closed afterward. Any other request fails closed with a typed
 * security error.
 */
export interface ApprovedNetworkPort {
  request(
    operation: ExternalOperation,
    approval: ExternalOperationApproval,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, SecurityError>>;
}

/**
 * The injectable port set consumed by the interactive session. Terminal covers the input and output
 * effect classes; clock, filesystem, process, and network cover the remaining four; the local event
 * sink is a distinct injectable boundary. Fakes implement the same set and may be marked unavailable.
 *
 * The `events` slot is the design's `LocalEventSink`: it is the existing domain {@link EventSink}
 * port, which already accepts only already-redacted events and never transmits them remotely. It is
 * reused here (rather than duplicated under a colliding name — infrastructure already ships a
 * concrete `LocalEventSink` class implementing this port) so the interactive session shares one
 * canonical local event sink with the rest of the application.
 */
export interface EffectPorts {
  readonly terminal: TerminalPort;
  readonly clock: ClockPort;
  readonly filesystem: FilesystemPort;
  readonly process: AllowlistedProcessPort;
  readonly network: ApprovedNetworkPort;
  readonly events: EventSink;
}

/**
 * Result of executing a single {@link UiCommand}. The executor normalizes the typed outcome of the
 * effect into events that are fed back into the pure reducer; it returns events rather than mutating
 * session state so command execution stays isolated from reduction and rendering.
 */
export interface UiCommandOutcome {
  /** Normalized events produced by the command (for example an external-result or exit event). */
  readonly events: readonly UiEvent[];
}

/**
 * Command execution boundary. This is the only place a {@link UiCommand} is turned into effects: it
 * runs the command through {@link EffectPorts}, serializes pending work, and returns normalized
 * {@link UiEvent}s. Reducers emit commands but never call this port, and renderers never dispatch
 * commands, so key handling can never mutate the project directly.
 */
export interface UiCommandExecutor {
  execute(command: UiCommand, signal?: AbortSignal): Promise<UiCommandOutcome>;
}
