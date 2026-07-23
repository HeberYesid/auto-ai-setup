import { describe, expect, it } from "vitest";
import {
  ASCII_SYMBOLS,
  calculateViewportWindow,
  computeViewportScroll,
  dimensionFromNumber,
  knownCapability,
  layoutViewModel,
  projectRenderMode,
  selectRenderProfile,
  truncatePath,
  wrapText,
  type Control,
  type ViewModel,
} from "../src/domain/tui/index.js";

const profile = selectRenderProfile(
  { kind: "interactive" },
  {
    inputTty: knownCapability(true),
    outputTty: knownCapability(true),
    ansiCursor: knownCapability(true),
    color: knownCapability(false),
    unicode: knownCapability(false),
    columns: dimensionFromNumber(32),
    rows: dimensionFromNumber(8),
    mouse: knownCapability(false),
    noColor: false,
  },
);

const control = (id: string, label: string, enabled = true): Control => ({
  id,
  kind: "button",
  label,
  enabled,
  visible: true,
  action: "advance",
  bounds: { top: 0 as never, bottom: 1 as never },
});

const view: ViewModel = {
  viewId: "select",
  brandLabel: "auto-ai-setup",
  stageLabel: "select",
  primaryAction: control("next", "Continuar"),
  controls: [control("next", "Continuar"), control("cancel", "Cancelar")],
  focusControlId: "cancel",
  sections: [
    { id: "first", token: "heading", label: "Primero", value: "valor uno" },
    { id: "second", token: "plain", label: "Segundo", value: "valor dos" },
  ],
  help: undefined,
  status: [],
  activity: undefined,
  progress: undefined,
  plan: undefined,
  recovery: undefined,
  summary: undefined,
};

describe("deterministic TUI layout", () => {
  it("wraps text within the requested width and preserves line order", () => {
    expect(wrapText("alpha beta gamma", 6)).toEqual(["alpha", "beta", "gamma"]);
    expect(wrapText("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(wrapText("uno\ndos", 20)).toEqual(["uno", "dos"]);
  });

  it("truncates paths with a visible indicator and preserves both ends", () => {
    expect(truncatePath("project/src/deep/file.ts", 14)).toEqual({ text: "projec...le.ts", truncated: true });
    expect(truncatePath("short.ts", 20)).toEqual({ text: "short.ts", truncated: false });
    expect(truncatePath("long-path", 1, "...").text).toBe(".");
  });

  it("projects compact and linear modes without removing semantic fields", () => {
    const projected = projectRenderMode(view, profile);
    expect(projected.mode).toBe("degraded");
    expect(projected.sections.map((section) => section.label)).toEqual(["Primero", "Segundo"]);
    expect(projected.primaryAction?.label).toBe("Continuar");
    expect(projected.ansiAllowed).toBe(true);
    expect(projected.useBorders).toBe(false);

    const linear = projectRenderMode(view, { ...profile, mode: "linear-text", ansi: false, symbols: ASCII_SYMBOLS });
    expect(linear.sequential).toBe(true);
    expect(linear.ansiAllowed).toBe(false);
    expect(linear.symbols).toBe(ASCII_SYMBOLS);
  });

  it("keeps all layout lines bounded, ordered, and deterministically windowed", () => {
    const first = layoutViewModel(view, profile, { width: 32, height: 4 });
    const second = layoutViewModel(view, profile, { width: 32, height: 4 });
    expect(second).toEqual(first);
    expect(first.lines.every((item) => item.spans.every((itemSpan) => itemSpan.text.length <= 32))).toBe(true);
    const text = first.lines.flatMap((item) => item.spans.map((itemSpan) => itemSpan.text)).join("\n");
    expect(text.indexOf("Primero: valor uno")).toBeLessThan(text.indexOf("Segundo: valor dos"));
    expect(first.visibleLines.length).toBeLessThanOrEqual(4);
    expect(first.controlBounds.get("cancel")).toBeDefined();
  });

  it("uses the minimum bounded offset to reveal focused controls", () => {
    expect(computeViewportScroll(20, 5, { top: 9, bottom: 10 }, 0)).toBe(5);
    expect(computeViewportScroll(20, 5, { top: 1, bottom: 2 }, 8)).toBe(1);
    expect(computeViewportScroll(4, 5, { top: 3, bottom: 4 }, 0)).toBe(0);
    expect(calculateViewportWindow(20, 5, 99)).toEqual({ scrollTop: 15, start: 15, end: 20, totalLines: 20, viewportHeight: 5 });
  });
});
