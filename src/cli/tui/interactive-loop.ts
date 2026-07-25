/**
 * Interactive terminal loop.
 *
 * The loop wires normalized key/mouse/resize/activity/external-result/timer events to: pure
 * reduction, command coordination through the application executor, redacted projection, frame
 * generation, and a single write per frame. Cleanup is guaranteed on completion, cancellation,
 * interruption, and controlled failure.
 *
 * Ordering is explicit and deterministic: reduce -> project -> render -> execute command -> feed
 * normalized result events back in. Because projection happens before command execution, no view can
 * observe a half-applied effect, and because commands are executed through the coordinator, a
 * keystroke can never touch the filesystem, a process, or the network directly.
 */

import type { RenderTimings } from "../../application/session/timing.js";
import type { TerminalError, TerminalPort, UiCommandExecutor } from "../../application/session/effect-ports.js";
import {
  applyPresentationTransition,
  createInitialSession,
  generateFrame,
  layoutViewModel,
  projectSessionState,
  reduceSession,
  selectRenderProfile,
  windowPlanView,
  type Frame,
  type InvocationMode,
  type PresentationProjectionOptions,
  type RenderProfile,
  type SessionReducerContext,
  type SessionState,
  type TerminalCapabilities,
  type UiEvent,
  type ViewModel,
} from "../../domain/tui/index.js";
import { tuiError, type TuiError } from "../../domain/tui/errors.js";
import { err, ok, type Result } from "../../domain/shared/types.js";
import { TerminalOutputSink } from "./output-sink.js";

/** Per-stage view inputs supplied by composition (controls, help, known secrets, primary action). */
export type ViewOptionsProvider = (state: SessionState) => PresentationProjectionOptions;

/** Reducer inputs that depend on the current view (controls, validation rules, viewport). */
export type ReducerContextProvider = (state: SessionState, profile: RenderProfile) => SessionReducerContext;

export interface InteractiveLoopDependencies {
  readonly terminal: TerminalPort;
  readonly executor: UiCommandExecutor;
  readonly invocation?: InvocationMode;
  readonly viewOptions?: ViewOptionsProvider;
  readonly reducerContext?: ReducerContextProvider;
  readonly timings?: RenderTimings;
}

/** The outcome of a completed loop: the final state plus the reason the loop stopped. */
export interface InteractiveLoopResult {
  readonly state: SessionState;
  readonly frames: number;
}

const renderFailure = (error: TerminalError): TuiError =>
  tuiError("UNAVAILABLE_EFFECT", error.message, {
    cause: error.code,
    suggestedAction: "Revisar la disponibilidad del terminal antes de reintentar",
  });

/**
 * Drives one interactive session to completion.
 *
 * The loop owns no domain rules: it reduces events, projects redacted view models, renders frames,
 * and forwards commands. Terminal restoration runs exactly once in the finalizer, so an interruption
 * or a controlled failure still leaves the terminal usable.
 */
export class InteractiveTerminalLoop {
  private readonly sink: TerminalOutputSink;
  private readonly pending: UiEvent[] = [];
  private state: SessionState;
  private profile: RenderProfile;
  private frames = 0;
  private lastFrame: Frame | undefined;

  public constructor(
    private readonly dependencies: InteractiveLoopDependencies,
    capabilities: TerminalCapabilities,
  ) {
    this.profile = selectRenderProfile(dependencies.invocation ?? { kind: "interactive" }, capabilities);
    this.state = createInitialSession(this.profile);
    this.sink = new TerminalOutputSink(dependencies.terminal);
  }

  /** The current session state, exposed for composition and assertions. */
  public get session(): SessionState {
    return this.state;
  }

  /** The active render profile after any resize transition. */
  public get renderProfile(): RenderProfile {
    return this.profile;
  }

  /** The most recently rendered frame. */
  public get frame(): Frame | undefined {
    return this.lastFrame;
  }

  /** Enqueue a normalized event; the loop drains the queue in arrival order. */
  public enqueue(event: UiEvent): void {
    this.pending.push(event);
  }

  /** Render the current state without consuming an event (used for the first view). */
  public async renderCurrent(): Promise<Result<void, TuiError>> {
    this.dependencies.timings?.start("first-view");
    const rendered = this.render();
    this.dependencies.timings?.complete("first-view");
    return rendered;
  }

  /**
   * Process every queued event. Each event is reduced once, the resulting state is projected and
   * rendered, and only then is the returned command executed; the command's normalized results are
   * appended to the queue so they are reduced in the same deterministic order.
   */
  public async drain(signal?: AbortSignal): Promise<Result<void, TuiError>> {
    while (this.pending.length > 0) {
      const event = this.pending.shift();
      if (event === undefined) break;
      const milestone = event.kind === "resize" ? "resize" : event.kind === "key" || event.kind === "mouse" ? "navigation" : undefined;
      if (milestone !== undefined) this.dependencies.timings?.start(milestone);

      if (event.kind === "resize") {
        const transition = applyPresentationTransition(this.state, event.capabilities, this.dependencies.invocation);
        this.profile = transition.profile;
        // A presentation change can invalidate cursor positions, so the next frame repaints fully.
        this.sink.invalidate();
      }

      const context = this.dependencies.reducerContext?.(this.state, this.profile) ?? { controls: [] };
      const reduction = reduceSession(this.state, event, context);
      this.state = reduction.state;

      const rendered = this.render();
      if (milestone !== undefined) this.dependencies.timings?.complete(milestone);
      if (!rendered.ok) return rendered;

      if (reduction.command.kind !== "none") {
        const outcome = await this.dependencies.executor.execute(reduction.command, signal);
        for (const produced of outcome.events) this.pending.push(produced);
      }
      if (this.state.finalized) break;
    }
    return ok(undefined);
  }

  /** Restore the terminal exactly once, regardless of how the loop ended. */
  public restore(): Result<void, TuiError> {
    const restored = this.dependencies.terminal.restore();
    return restored.ok ? ok(undefined) : err(renderFailure(restored.error));
  }

  private render(): Result<void, TuiError> {
    const projected: Result<ViewModel, TuiError> = projectSessionState(this.state, this.dependencies.viewOptions?.(this.state) ?? {});
    // Redaction failures fail closed: nothing is written when a value cannot be redacted.
    if (!projected.ok) return projected;
    // Bounded plan rendering: at most MAX_VISIBLE_PLAN_OPERATIONS rows of canonical operations are
    // laid out at once, so a very large plan cannot make layout or navigation unbounded.
    const view: ViewModel =
      projected.value.plan === undefined ? projected.value : { ...projected.value, plan: windowPlanView(projected.value.plan) };
    const layout = layoutViewModel(view, this.profile, {
      width: this.profile.width ?? 80,
      ...(this.profile.height === undefined ? {} : { height: this.profile.height }),
      scrollTop: this.state.scrollTop,
    });
    const frame = generateFrame(layout, this.profile, this.lastFrame);
    const written = this.sink.render(frame);
    if (!written.ok) return err(renderFailure(written.error));
    this.lastFrame = frame;
    this.frames += 1;
    return ok(undefined);
  }
}

/**
 * Run a full interactive session: probe-driven construction, first view, event drain, and guaranteed
 * restoration. Events arrive through the terminal subscription; the caller resolves `stop` when the
 * session finalizes.
 */
export const runInteractiveLoop = async (
  dependencies: InteractiveLoopDependencies,
  capabilities: TerminalCapabilities,
  events: readonly UiEvent[] = [],
  signal?: AbortSignal,
): Promise<Result<InteractiveLoopResult, TuiError>> => {
  const loop = new InteractiveTerminalLoop(dependencies, capabilities);
  try {
    const first = await loop.renderCurrent();
    if (!first.ok) return first;
    for (const event of events) loop.enqueue(event);
    const drained = await loop.drain(signal);
    if (!drained.ok) return drained;
    return ok({ state: loop.session, frames: loop.frame === undefined ? 0 : 1 });
  } finally {
    // Idempotent restoration covers completion, cancellation, interruption, and failure.
    loop.restore();
  }
};
