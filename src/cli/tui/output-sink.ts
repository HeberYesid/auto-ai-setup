/**
 * Terminal output sink.
 *
 * This is the only place ANSI is emitted. It receives semantic frames from the domain, computes a
 * minimal safe delta, and writes it through the injected {@link TerminalPort}. Emission is gated on
 * the frame's ANSI permission: when ANSI is unavailable, output is strictly append-only with no
 * clear, cursor reposition, or animation sequence. A write failure is surfaced as a typed error and
 * never retried in a way that could duplicate content or leak values.
 */

import type { TerminalError, TerminalPort } from "../../application/session/effect-ports.js";
import { computeFrameDelta, frameLineText, type Frame, type FrameDelta } from "../../domain/tui/index.js";
import { ok, type Result } from "../../domain/shared/types.js";

const CSI = "\u001b[";
const clearLine = `${CSI}2K`;
const moveTo = (row: number): string => `${CSI}${row + 1};1H`;

/** Serialize a delta into terminal bytes. Pure, so tests can assert exactly what would be written. */
export const renderDelta = (delta: FrameDelta): string => {
  if (delta.appendOnly) {
    return delta.updates
      .slice()
      .sort((left, right) => left.row - right.row)
      .map((update) => `${frameLineText(update.line)}\n`)
      .join("");
  }
  const parts: string[] = [];
  for (const update of [...delta.updates].sort((left, right) => left.row - right.row)) {
    parts.push(moveTo(update.row), clearLine, frameLineText(update.line));
  }
  for (const row of delta.clearedRows) parts.push(moveTo(row), clearLine);
  return parts.join("");
};

/** Stateful sink that remembers the last frame so it can emit minimal deltas. */
export class TerminalOutputSink {
  private previous: Frame | undefined;

  public constructor(private readonly terminal: Pick<TerminalPort, "write">) {}

  /**
   * Render a frame. The completed terminal content contains only the current model: changed regions
   * are regenerated whole and rows the previous frame no longer needs are cleared.
   */
  public render(frame: Frame): Result<void, TerminalError> {
    const delta = computeFrameDelta(this.previous, frame);
    const text = renderDelta(delta);
    if (text.length === 0) {
      this.previous = frame;
      return ok(undefined);
    }
    const written = this.terminal.write(text);
    // The frame is recorded only after a successful write, so a failed write cannot make the sink
    // believe stale content is already on screen.
    if (written.ok) this.previous = frame;
    return written;
  }

  /** Forget the previous frame so the next render repaints fully (used after external output). */
  public invalidate(): void {
    this.previous = undefined;
  }

  /** The last successfully written frame, exposed for assertions and recovery paths. */
  public get lastFrame(): Frame | undefined {
    return this.previous;
  }
}

export const createTerminalOutputSink = (terminal: Pick<TerminalPort, "write">): TerminalOutputSink => new TerminalOutputSink(terminal);
