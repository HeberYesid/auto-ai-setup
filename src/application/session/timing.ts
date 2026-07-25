/**
 * Local rendering-responsiveness instrumentation.
 *
 * Milestones are measured with the injected monotonic clock only. Nothing is transmitted, persisted,
 * or aggregated: measurements exist so the loop can assert its own budgets and so deterministic tests
 * can observe a threshold one millisecond before, exactly at, and one millisecond after the limit.
 * This is not telemetry and has no remote sink.
 */

import type { ClockPort } from "./effect-ports.js";

/** The instrumented interaction milestones. */
export type RenderMilestone = "first-view" | "navigation" | "resize" | "activity";

/** The response budget, in milliseconds, for each milestone. Observations are inclusive. */
export const MILESTONE_BUDGET_MS: Readonly<Record<RenderMilestone, number>> = {
  "first-view": 300,
  navigation: 100,
  resize: 250,
  activity: 1000,
};

/** One completed measurement. */
export interface RenderMeasurement {
  readonly milestone: RenderMilestone;
  readonly elapsedMs: number;
  readonly budgetMs: number;
  readonly withinBudget: boolean;
}

/** A measurement is within budget when it is at or below the limit (inclusive boundary). */
export const isWithinBudget = (milestone: RenderMilestone, elapsedMs: number): boolean =>
  Number.isFinite(elapsedMs) && elapsedMs <= MILESTONE_BUDGET_MS[milestone];

/**
 * Records milestone durations against an injected monotonic clock. Starting a milestone twice
 * restarts it; completing one that was never started yields a zero-length measurement rather than an
 * exception, so instrumentation can never break a render.
 */
export class RenderTimings {
  private readonly started = new Map<RenderMilestone, number>();
  private readonly completed: RenderMeasurement[] = [];

  public constructor(private readonly clock: Pick<ClockPort, "monotonicMs">) {}

  public start(milestone: RenderMilestone): void {
    this.started.set(milestone, this.clock.monotonicMs());
  }

  public complete(milestone: RenderMilestone): RenderMeasurement {
    const startedAt = this.started.get(milestone) ?? this.clock.monotonicMs();
    this.started.delete(milestone);
    const elapsedMs = Math.max(0, this.clock.monotonicMs() - startedAt);
    const measurement: RenderMeasurement = {
      milestone,
      elapsedMs,
      budgetMs: MILESTONE_BUDGET_MS[milestone],
      withinBudget: isWithinBudget(milestone, elapsedMs),
    };
    this.completed.push(measurement);
    return measurement;
  }

  /** Measure a synchronous section without needing an explicit start/complete pair. */
  public measure<T>(milestone: RenderMilestone, work: () => T): { readonly value: T; readonly measurement: RenderMeasurement } {
    this.start(milestone);
    const value = work();
    return { value, measurement: this.complete(milestone) };
  }

  /** All measurements in completion order. */
  public get measurements(): readonly RenderMeasurement[] {
    return [...this.completed];
  }

  /** Whether the activity budget has elapsed since the last activity confirmation. */
  public activityDue(lastConfirmationMs: number): boolean {
    return this.clock.monotonicMs() - lastConfirmationMs >= MILESTONE_BUDGET_MS.activity;
  }
}

export const createRenderTimings = (clock: Pick<ClockPort, "monotonicMs">): RenderTimings => new RenderTimings(clock);
