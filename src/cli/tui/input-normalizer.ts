/**
 * Platform input normalization for the modern TUI.
 *
 * Raw terminal input arrives as bytes/escape sequences. This module decodes a single input chunk
 * into a closed set of {@link DecodedInput} values so that raw escape sequences never leak toward
 * the domain reducers. Unrecognized escape sequences are consumed and dropped rather than forwarded.
 *
 * The terminal adapter maps {@link DecodedInput} into the domain's closed {@link import("../../domain/tui/index.js").UiEvent}
 * variants (a mouse click still requires layout-aware control resolution, and an interruption is
 * routed to the cancellation-request key).
 */

import type { KeyStroke, NormalizedKey } from "../../domain/tui/index.js";

/** A single decoded input token: a normalized key, an interruption, or a raw mouse activation. */
export type DecodedInput =
  | { readonly kind: "key"; readonly key: KeyStroke }
  | { readonly kind: "interrupt" }
  | { readonly kind: "mouse"; readonly button: number; readonly column: number; readonly row: number; readonly release: boolean };

const named = (name: NormalizedKey): DecodedInput => ({ kind: "key", key: { kind: "named", name } });
const printable = (text: string): DecodedInput => ({ kind: "key", key: { kind: "printable", text } });

const ESC = "\u001b";
const ETX = "\u0003"; // Ctrl+C
const DEL = "\u007f";

/** CSI final-byte range `@`–`~`, used to consume unrecognized control sequences safely. */
const isCsiFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e;

/** Decode an X10 or SGR mouse report into a {@link DecodedInput}, pushing at most one event. */
const decodeMouse = (chunk: string, start: number, out: DecodedInput[]): number => {
  const rest = chunk.length - start;
  const marker = chunk[start + 2];
  if (marker === "M") {
    // X10: ESC [ M <button+32> <col+32> <row+32>
    if (rest < 6) return rest;
    const button = chunk.charCodeAt(start + 3) - 32;
    const column = chunk.charCodeAt(start + 4) - 32;
    const row = chunk.charCodeAt(start + 5) - 32;
    out.push({ kind: "mouse", button: button & 0x3, column, row, release: (button & 0x3) === 3 });
    return 6;
  }
  // SGR: ESC [ < button ; col ; row (M=press, m=release)
  let j = start + 3;
  while (j < chunk.length && chunk[j] !== "M" && chunk[j] !== "m") j += 1;
  if (j >= chunk.length) return rest;
  const [rawButton, rawColumn, rawRow] = chunk.slice(start + 3, j).split(";");
  const button = Number.parseInt(rawButton ?? "", 10);
  const column = Number.parseInt(rawColumn ?? "", 10);
  const row = Number.parseInt(rawRow ?? "", 10);
  if (Number.isInteger(button) && Number.isInteger(column) && Number.isInteger(row)) {
    out.push({ kind: "mouse", button: button & 0x3, column, row, release: chunk[j] === "m" });
  }
  return j - start + 1;
};

const CSI_ARROWS: Readonly<Record<string, NormalizedKey>> = {
  A: "ArrowUp",
  B: "ArrowDown",
  C: "ArrowRight",
  D: "ArrowLeft",
};

/** Decode an escape sequence beginning at `start`, returning how many characters it consumed. */
const decodeEscape = (chunk: string, start: number, out: DecodedInput[]): number => {
  const rest = chunk.length - start;
  if (rest === 1) {
    out.push(named("Escape"));
    return 1;
  }
  const introducer = chunk[start + 1];
  if (introducer === "[") {
    const third = chunk[start + 2];
    if (third === "Z") {
      out.push(named("ShiftTab"));
      return 3;
    }
    if (third !== undefined && third in CSI_ARROWS) {
      out.push(named(CSI_ARROWS[third] as NormalizedKey));
      return 3;
    }
    if (third === "M" || third === "<") {
      return decodeMouse(chunk, start, out);
    }
    // Unrecognized CSI: consume through its final byte and emit nothing.
    let k = start + 2;
    while (k < chunk.length) {
      const consumedFinal = isCsiFinal(chunk.charCodeAt(k));
      k += 1;
      if (consumedFinal) break;
    }
    return k - start;
  }
  if (introducer === "O") {
    const third = chunk[start + 2];
    if (third !== undefined && third in CSI_ARROWS) {
      out.push(named(CSI_ARROWS[third] as NormalizedKey));
    }
    return 3;
  }
  // Lone ESC followed by an unrelated character: treat ESC as Escape and reprocess the rest.
  out.push(named("Escape"));
  return 1;
};

/**
 * Decode a single input chunk into normalized tokens. Consecutive printable characters are grouped
 * into one printable key; named keys, interruption, and mouse reports break the run. Control
 * characters that carry no normalized meaning are dropped so no raw sequence reaches the domain.
 */
export const decodeInputChunk = (chunk: string): readonly DecodedInput[] => {
  const out: DecodedInput[] = [];
  let buffer = "";
  const flush = (): void => {
    if (buffer.length > 0) {
      out.push(printable(buffer));
      buffer = "";
    }
  };

  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i] as string;
    if (ch === ESC) {
      flush();
      i += decodeEscape(chunk, i, out);
      continue;
    }
    if (ch === ETX) {
      flush();
      out.push({ kind: "interrupt" });
      i += 1;
      continue;
    }
    if (ch === "\t") {
      flush();
      out.push(named("Tab"));
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      flush();
      out.push(named("Enter"));
      i += 1;
      continue;
    }
    if (ch === " ") {
      flush();
      out.push(named("Space"));
      i += 1;
      continue;
    }
    if (ch === "?") {
      flush();
      out.push(named("Question"));
      i += 1;
      continue;
    }
    const code = chunk.codePointAt(i) as number;
    if (code < 0x20 || code === 0x7f || ch === DEL) {
      // Unmapped control character (or DEL): drop it without leaking the raw byte.
      flush();
      i += 1;
      continue;
    }
    // Printable character; advance by two units for astral (surrogate-pair) code points.
    if (code > 0xffff) {
      buffer += chunk.slice(i, i + 2);
      i += 2;
    } else {
      buffer += ch;
      i += 1;
    }
  }
  flush();
  return out;
};

/** Normalize a raw chunk that may be a Node `Buffer` or a decoded string into UTF-8 text. */
export const chunkToText = (chunk: Buffer | string): string => (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
