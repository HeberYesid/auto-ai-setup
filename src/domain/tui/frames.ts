import type { RenderProfile } from "./capabilities.js";
import type { LayoutDocument } from "./layout.js";
import { asPositiveInteger, type PositiveInteger } from "./values.js";
import type { Frame, FrameLine } from "./view.js";

/**
 * A single row update in a delta. `row` is the absolute zero-based viewport row and
 * `line` is the complete regenerated line for that row; partial in-line patching is
 * never emitted so a redrawn row can never mix old and new content.
 */
export interface FrameRowUpdate {
  readonly row: number;
  readonly regionId: string;
  readonly line: FrameLine;
}

/**
 * A minimal safe delta between two frames.
 *
 * - `kind: "full"` repaints every row and is used whenever positioning cannot be
 *   trusted (first frame, width change, ANSI unavailable, or append-only output).
 * - `kind: "partial"` regenerates complete changed regions only; rows belonging to
 *   unchanged regions are absent so their characters and positions are preserved.
 * - `clearedRows` lists rows the previous frame occupied beyond the current frame,
 *   guaranteeing the completed terminal content contains only the current model.
 */
export interface FrameDelta {
  readonly kind: "full" | "partial";
  readonly width: PositiveInteger;
  readonly updates: readonly FrameRowUpdate[];
  readonly clearedRows: readonly number[];
  readonly changedRegions: readonly string[];
  readonly ansiAllowed: boolean;
  /** True when the sink must only append text: no clear, reposition, or animation. */
  readonly appendOnly: boolean;
}

const FALLBACK_WIDTH = 1 as PositiveInteger;

const boundedWidth = (width: number): PositiveInteger => {
  const positive = asPositiveInteger(width);
  return positive.ok ? positive.value : FALLBACK_WIDTH;
};

/** Flatten one line to its plain text, without any ANSI or cursor control sequences. */
export const frameLineText = (line: FrameLine): string => line.spans.map((span) => span.text).join("");

/** Compare two lines by region identity and rendered spans, ignoring object identity. */
const sameLine = (left: FrameLine | undefined, right: FrameLine | undefined): boolean => {
  if (left === undefined || right === undefined) return left === right;
  if (left.regionId !== right.regionId) return false;
  if (left.spans.length !== right.spans.length) return false;
  return left.spans.every((span, index) => {
    const other = right.spans[index];
    return other !== undefined && span.token === other.token && span.text === other.text;
  });
};

/**
 * Generate a semantic frame from a bounded layout. Only the visible window is emitted
 * so the frame always represents exactly what the viewport shows. `ansiAllowed` is
 * derived from the profile, and no escape sequence is embedded here: ANSI emission
 * stays in the output adapter.
 */
export const generateFrame = (layout: LayoutDocument, profile: RenderProfile, previous?: Frame): Frame => {
  const width = boundedWidth(layout.width);
  const interactive = profile.mode === "full-visual" || profile.mode === "degraded";
  const ansiAllowed = interactive && profile.ansi;
  const lines = [...layout.visibleLines];
  const changedRegions: string[] = [];
  const seen = new Set<string>();
  const comparable = previous !== undefined && previous.width === width && previous.ansiAllowed === ansiAllowed;
  for (const [row, line] of lines.entries()) {
    const before = comparable ? previous?.lines[row] : undefined;
    if (!comparable || !sameLine(before, line)) {
      if (!seen.has(line.regionId)) {
        seen.add(line.regionId);
        changedRegions.push(line.regionId);
      }
    }
  }
  if (comparable && previous !== undefined) {
    for (const line of previous.lines.slice(lines.length)) {
      if (!seen.has(line.regionId)) {
        seen.add(line.regionId);
        changedRegions.push(line.regionId);
      }
    }
  }
  return { width, lines, ansiAllowed, changedRegions };
};

/**
 * Compute the minimal safe delta between two frames.
 *
 * Changed regions are regenerated in full: every row of a changed region is emitted,
 * never a partial patch. Unchanged regions are omitted so their characters and
 * positions remain exactly as previously written. Rows the previous frame used beyond
 * the current frame are reported in `clearedRows`, so the completed terminal content
 * contains only the current model and never a stale remnant.
 *
 * When ANSI is unavailable the delta is always append-only and full: no clear, cursor
 * reposition, or animation sequence may be emitted for linear output.
 */
export const computeFrameDelta = (previous: Frame | undefined, next: Frame): FrameDelta => {
  const appendOnly = !next.ansiAllowed;
  const repaint = (): FrameDelta => ({
    kind: "full",
    width: next.width,
    updates: next.lines.map((line, row) => ({ row, regionId: line.regionId, line })),
    clearedRows: appendOnly || previous === undefined ? [] : rangeOf(next.lines.length, previous.lines.length),
    changedRegions: [...new Set(next.lines.map((line) => line.regionId))],
    ansiAllowed: next.ansiAllowed,
    appendOnly,
  });

  if (appendOnly || previous === undefined || previous.width !== next.width || previous.ansiAllowed !== next.ansiAllowed) {
    return repaint();
  }

  const changed = new Set<string>();
  for (const [row, line] of next.lines.entries()) {
    if (!sameLine(previous.lines[row], line)) changed.add(line.regionId);
  }
  for (const line of previous.lines.slice(next.lines.length)) changed.add(line.regionId);

  const updates: FrameRowUpdate[] = [];
  for (const [row, line] of next.lines.entries()) {
    // A region is regenerated as a whole: if any of its rows changed, all of its rows
    // are rewritten so a region can never be left half-updated.
    if (changed.has(line.regionId)) updates.push({ row, regionId: line.regionId, line });
  }
  return {
    kind: "partial",
    width: next.width,
    updates,
    clearedRows: rangeOf(next.lines.length, previous.lines.length),
    changedRegions: [...changed],
    ansiAllowed: next.ansiAllowed,
    appendOnly,
  };
};

const rangeOf = (from: number, to: number): readonly number[] => {
  const rows: number[] = [];
  for (let row = from; row < to; row += 1) rows.push(row);
  return rows;
};

/**
 * The plain text of every row of a frame, in order. This is the append-only projection
 * used by linear and non-interactive sinks: no clear, cursor movement, or animation.
 */
export const frameText = (frame: Frame): readonly string[] => frame.lines.map(frameLineText);

/** The append-only text produced by a delta; only defined for full/append-only deltas. */
export const deltaText = (delta: FrameDelta): readonly string[] =>
  [...delta.updates].sort((left, right) => left.row - right.row).map((update) => frameLineText(update.line));

/**
 * Structural invariant used by tests and by the output adapter as a guard: applying a
 * delta to the previous frame must yield exactly the current frame, with no stale rows.
 */
export const applyFrameDelta = (previous: Frame | undefined, delta: FrameDelta): readonly string[] => {
  const rows: string[] = delta.kind === "full" || previous === undefined ? [] : previous.lines.map(frameLineText);
  for (const update of delta.updates) rows[update.row] = frameLineText(update.line);
  const cleared = new Set(delta.clearedRows);
  return rows.filter((_, row) => !cleared.has(row));
};
