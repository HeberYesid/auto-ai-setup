/**
 * Interactive session coordinator.
 *
 * This is the only place where a {@link UiCommand} produced by the pure reducer becomes an effect.
 * It runs commands through injected {@link EffectPorts}, normalizes their typed results back into
 * {@link UiEvent}s, and serializes pending work so two effects can never overlap. Rendering is not
 * performed here: the coordinator returns events, and the terminal loop is responsible for
 * projection and output. Consequently a keystroke can never mutate the project directly and a
 * renderer can never dispatch a command.
 *
 * The coordinator adds no domain capability: it maps the existing inspect/select/review/approve/
 * apply/recover/summary stages onto the stage runner supplied by composition, and applies changes
 * exclusively through the approval gate, which recomputes the canonical plan hash immediately before
 * any filesystem, process, or network call.
 */

import type { ExecutionSummary, RedactedEvent } from "../../domain/observability/models.js";
import type { RecoveryJournal } from "../../domain/planning/models.js";
import type { OperationId, Result, RunId } from "../../domain/shared/types.js";
import { tuiError, type TuiError } from "../../domain/tui/errors.js";
import type { ExitReason, Stage, UiCommand, UiEvent } from "../../domain/tui/index.js";
import { ApprovedEffectGate, type ApprovedEffectRequest } from "./approved-effects.js";
import type { EffectPorts, UiCommandExecutor, UiCommandOutcome } from "./effect-ports.js";

/** The observable outcome of a stage or effect, normalized for the reducer. */
export interface StageOutcome {
  /** Present when the effect finished the run and produced a summary. */
  readonly summary?: ExecutionSummary;
  /** Present when the effect discovered an interrupted transaction to recover. */
  readonly journal?: RecoveryJournal;
}

/** Runs the application work for one stage. Supplied by composition, never by the reducer. */
export type StageRunner = (stage: Stage, signal: AbortSignal) => Promise<Result<StageOutcome, TuiError>>;

/** Runs one registered recovery control. */
export type RecoveryRunner = (controlId: string, signal: AbortSignal) => Promise<Result<StageOutcome, TuiError>>;

/** Everything the coordinator needs from composition. */
export interface InteractiveSessionDependencies {
  readonly ports: EffectPorts;
  readonly runStage: StageRunner;
  readonly runRecovery?: RecoveryRunner;
  /** Supplies the current plan, displayed hash, approval, and review decisions on demand. */
  readonly approvalRequest?: () => ApprovedEffectRequest;
  /** Run id used for local events; local events are never transmitted remotely. */
  readonly runId?: RunId;
}

const operationId = (value: string): OperationId => value as OperationId;

const single = (event: UiEvent): UiCommandOutcome => ({ events: [event] });

const externalResult = (id: string, result: Result<void, TuiError>): UiEvent => ({
  kind: "external-result",
  operationId: operationId(id),
  result: result.ok ? { ok: true, value: { operationId: operationId(id), status: "completed" } } : result,
});

const unsupported = (kind: UiCommand["kind"]): TuiError =>
  tuiError("UNKNOWN_ACTION", `El comando ${kind} no está registrado en esta sesión`, {
    suggestedAction: "Registrar el comando en la composición de la sesión interactiva",
  });

/**
 * Serializes asynchronous work so pending effects never interleave. Requirement 8.7 locks task
 * inputs and results while work is pending; this queue is the application-side counterpart that
 * guarantees only one effect runs at a time even if several commands arrive.
 */
class WorkQueue {
  private tail: Promise<unknown> = Promise.resolve();

  public run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** The coordinator. Implements {@link UiCommandExecutor} so the loop depends only on the port. */
export class InteractiveSessionCoordinator implements UiCommandExecutor {
  private readonly queue = new WorkQueue();
  private readonly gate: ApprovedEffectGate;
  private lastOutcome: StageOutcome | undefined;
  private lastExit: ExitReason | undefined;

  public constructor(private readonly dependencies: InteractiveSessionDependencies) {
    this.gate = new ApprovedEffectGate(dependencies.ports.filesystem, dependencies.ports.process, dependencies.ports.network);
  }

  /** The most recent normalized effect outcome, used by the loop to build progress/summary views. */
  public get outcome(): StageOutcome | undefined {
    return this.lastOutcome;
  }

  /** The exit reason requested by the reducer, if any. */
  public get exitReason(): ExitReason | undefined {
    return this.lastExit;
  }

  public async execute(command: UiCommand, signal?: AbortSignal): Promise<UiCommandOutcome> {
    switch (command.kind) {
      case "none":
        return { events: [] };

      case "exit":
        this.lastExit = command.reason;
        return { events: [] };

      case "run-stage":
        return this.queue.run(() => this.runStage(command.stage, signal));

      case "apply-approved-plan":
        return this.queue.run(() => this.applyPlan(signal));

      case "recover":
        return this.queue.run(() => this.recover(command.controlId, signal));
    }
  }

  private abortSignal(signal: AbortSignal | undefined): AbortSignal {
    return signal ?? new AbortController().signal;
  }

  private async runStage(stage: Stage, signal: AbortSignal | undefined): Promise<UiCommandOutcome> {
    const result = await this.dependencies.runStage(stage, this.abortSignal(signal));
    if (result.ok) this.lastOutcome = result.value;
    this.emit(result.ok ? "info" : "error", `stage:${stage}`, result.ok ? "Etapa completada" : result.error.message);
    return single(externalResult(`stage:${stage}`, result.ok ? { ok: true, value: undefined } : result));
  }

  /**
   * Applies changes only through the approval gate. The gate recomputes the canonical SHA-256 and
   * refuses stale, conflicted, or unapproved plans before the filesystem port is reached, so a
   * rejected approval starts no effect and leaves the project in an equivalent state.
   */
  private async applyPlan(signal: AbortSignal | undefined): Promise<UiCommandOutcome> {
    const request = this.dependencies.approvalRequest?.();
    if (request === undefined) {
      return single(externalResult("apply", { ok: false, error: unsupported("apply-approved-plan") }));
    }
    const applied = await this.gate.apply(request, this.abortSignal(signal));
    if (!applied.ok) {
      this.emit("error", "plan:apply", applied.error.message);
      return single(externalResult("apply", applied));
    }
    const transaction = applied.value;
    this.lastOutcome = transaction.journal === undefined ? {} : { journal: transaction.journal };
    this.emit("info", "plan:apply", `Transacción ${transaction.status}`);
    if (transaction.status === "committed") return single(externalResult("apply", { ok: true, value: undefined }));
    return single(
      externalResult("apply", {
        ok: false,
        error: tuiError("INVALID_SESSION_STATE", transaction.errors[0] ?? `La transacción terminó en estado ${transaction.status}`, {
          recoverability: transaction.status === "incomplete" ? "manual-review" : "rollback",
        }),
      }),
    );
  }

  private async recover(controlId: string, signal: AbortSignal | undefined): Promise<UiCommandOutcome> {
    const runner = this.dependencies.runRecovery;
    if (runner === undefined) {
      return single(externalResult(`recover:${controlId}`, { ok: false, error: unsupported("recover") }));
    }
    const result = await runner(controlId, this.abortSignal(signal));
    if (result.ok) this.lastOutcome = result.value;
    this.emit(result.ok ? "info" : "error", `recover:${controlId}`, result.ok ? "Recuperación completada" : result.error.message);
    return single(externalResult(`recover:${controlId}`, result.ok ? { ok: true, value: undefined } : result));
  }

  /**
   * Emits an already-redacted local event. Messages here are policy-level statements about the
   * lifecycle, never project values, so nothing sensitive can reach the sink.
   */
  private emit(level: RedactedEvent["level"], operation: string, message: string): void {
    const runId = this.dependencies.runId;
    if (runId === undefined) return;
    const event: RedactedEvent = {
      runId,
      timestamp: this.dependencies.ports.clock.now(),
      level,
      category: "session",
      message,
      context: { operation },
      redacted: true,
    };
    this.dependencies.ports.events.emit(event);
  }
}

/** Factory used by composition roots. */
export const createInteractiveSessionCoordinator = (dependencies: InteractiveSessionDependencies): InteractiveSessionCoordinator =>
  new InteractiveSessionCoordinator(dependencies);
