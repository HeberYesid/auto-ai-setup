import { describe, expect, it } from "vitest";
import {
  ASCII_SYMBOLS,
  UNICODE_SYMBOLS,
  assertConservativeProfile,
  dimensionFromNumber,
  knownCapability,
  renderProfileIsConservative,
  selectRenderProfile,
  unknownCapability,
  unknownDimension,
} from "../src/domain/tui/index.js";
import type { InvocationMode, TerminalCapabilities } from "../src/domain/tui/index.js";

const INTERACTIVE: InvocationMode = { kind: "interactive" };

/** A fully capable, complete terminal (80×24 or larger) with color, Unicode, and mouse. */
const completeCapabilities = (overrides: Partial<TerminalCapabilities> = {}): TerminalCapabilities => ({
  inputTty: knownCapability(true),
  outputTty: knownCapability(true),
  ansiCursor: knownCapability(true),
  color: knownCapability(true),
  unicode: knownCapability(true),
  columns: dimensionFromNumber(120),
  rows: dimensionFromNumber(40),
  mouse: knownCapability(true),
  noColor: false,
  ...overrides,
});

describe("compatibility policy — full visual selection", () => {
  it("selects full-visual for a complete terminal with no downgrades", () => {
    const profile = selectRenderProfile(INTERACTIVE, completeCapabilities());
    expect(profile.mode).toBe("full-visual");
    expect(profile.ansi).toBe(true);
    expect(profile.color).toBe(true);
    expect(profile.unicode).toBe(true);
    expect(profile.animation).toBe(true);
    expect(profile.mouse).toBe(true);
    expect(profile.symbols).toBe(UNICODE_SYMBOLS);
    expect(profile.downgradeReasons).toEqual([]);
  });

  it("qualifies exactly 80x24 as full-visual", () => {
    const profile = selectRenderProfile(
      INTERACTIVE,
      completeCapabilities({ columns: dimensionFromNumber(80), rows: dimensionFromNumber(24) }),
    );
    expect(profile.mode).toBe("full-visual");
    expect(profile.width).toBe(80);
    expect(profile.height).toBe(24);
  });

  it("keeps full-visual but disables mouse when mouse capability is unknown", () => {
    const profile = selectRenderProfile(INTERACTIVE, completeCapabilities({ mouse: unknownCapability() }));
    expect(profile.mode).toBe("full-visual");
    expect(profile.mouse).toBe(false);
    expect(profile.downgradeReasons).toEqual([]);
  });
});

describe("compatibility policy — degraded selection", () => {
  it("selects degraded for valid dimensions below 80x24 with ANSI support", () => {
    const profile = selectRenderProfile(
      INTERACTIVE,
      completeCapabilities({ columns: dimensionFromNumber(79), rows: dimensionFromNumber(24) }),
    );
    expect(profile.mode).toBe("degraded");
    expect(profile.ansi).toBe(true);
    expect(profile.downgradeReasons).toContain("undersized-dimensions");
  });

  it("treats too-few rows as undersized as well", () => {
    const profile = selectRenderProfile(INTERACTIVE, completeCapabilities({ rows: dimensionFromNumber(23) }));
    expect(profile.mode).toBe("degraded");
  });
});

describe("compatibility policy — linear text selection", () => {
  it("selects linear-text when ANSI cursor is missing", () => {
    const profile = selectRenderProfile(INTERACTIVE, completeCapabilities({ ansiCursor: knownCapability(false) }));
    expect(profile.mode).toBe("linear-text");
    expect(profile.ansi).toBe(false);
    expect(profile.color).toBe(false);
    expect(profile.unicode).toBe(false);
    expect(profile.animation).toBe(false);
    expect(profile.symbols).toBe(ASCII_SYMBOLS);
    expect(profile.downgradeReasons).toContain("missing-ansi-cursor");
  });

  it("selects linear-text conservatively when a core capability is unknown", () => {
    const profile = selectRenderProfile(INTERACTIVE, completeCapabilities({ color: unknownCapability() }));
    expect(profile.mode).toBe("linear-text");
    expect(profile.downgradeReasons).toContain("unknown-capability");
  });

  it("selects linear-text when dimensions are invalid", () => {
    const profile = selectRenderProfile(INTERACTIVE, completeCapabilities({ columns: dimensionFromNumber(0) }));
    expect(profile.mode).toBe("linear-text");
    expect(profile.width).toBeUndefined();
    expect(profile.downgradeReasons).toContain("invalid-dimensions");
  });

  it("selects linear-text when dimensions are unknown", () => {
    const profile = selectRenderProfile(INTERACTIVE, completeCapabilities({ rows: unknownDimension() }));
    expect(profile.mode).toBe("linear-text");
    expect(profile.downgradeReasons).toContain("unknown-capability");
  });
});

describe("compatibility policy — non-interactive selection", () => {
  it("selects non-interactive for JSON invocation regardless of capabilities", () => {
    const profile = selectRenderProfile({ kind: "json" }, completeCapabilities());
    expect(profile.mode).toBe("non-interactive");
    expect(profile.ansi).toBe(false);
    expect(profile.downgradeReasons).toEqual(["non-interactive-invocation"]);
  });

  it("selects non-interactive for explicit non-interactive invocation", () => {
    const profile = selectRenderProfile({ kind: "non-interactive" }, completeCapabilities());
    expect(profile.mode).toBe("non-interactive");
    expect(profile.downgradeReasons).toEqual(["non-interactive-invocation"]);
  });

  it("selects non-interactive when output is redirected (non-TTY)", () => {
    const profile = selectRenderProfile(INTERACTIVE, completeCapabilities({ outputTty: knownCapability(false) }));
    expect(profile.mode).toBe("non-interactive");
    expect(profile.downgradeReasons).toEqual(["redirected-output"]);
  });

  it("selects non-interactive when input is redirected (non-TTY)", () => {
    const profile = selectRenderProfile(INTERACTIVE, completeCapabilities({ inputTty: knownCapability(false) }));
    expect(profile.mode).toBe("non-interactive");
    expect(profile.downgradeReasons).toEqual(["redirected-output"]);
  });
});

describe("compatibility policy — color and Unicode resource handling", () => {
  it("honors non-empty NO_COLOR by disabling color and animation while staying full-visual", () => {
    const profile = selectRenderProfile(INTERACTIVE, completeCapabilities({ noColor: true }));
    expect(profile.mode).toBe("full-visual");
    expect(profile.color).toBe(false);
    expect(profile.animation).toBe(false);
    expect(profile.downgradeReasons).toContain("no-color-requested");
  });

  it("disables color but keeps full-visual when the terminal lacks color", () => {
    const profile = selectRenderProfile(INTERACTIVE, completeCapabilities({ color: knownCapability(false) }));
    // Unknown vs known-false differ: known-false color keeps the visual mode but disables the resource.
    expect(profile.color).toBe(false);
    expect(profile.mode).toBe("full-visual");
    expect(profile.downgradeReasons).toContain("missing-color");
  });

  it("substitutes ASCII symbols when the terminal lacks Unicode", () => {
    const profile = selectRenderProfile(INTERACTIVE, completeCapabilities({ unicode: knownCapability(false) }));
    expect(profile.mode).toBe("full-visual");
    expect(profile.unicode).toBe(false);
    expect(profile.symbols).toBe(ASCII_SYMBOLS);
    expect(profile.downgradeReasons).toContain("missing-unicode");
  });
});

describe("compatibility policy — invariants", () => {
  const cases: readonly TerminalCapabilities[] = [
    completeCapabilities(),
    completeCapabilities({ noColor: true }),
    completeCapabilities({ color: knownCapability(false) }),
    completeCapabilities({ unicode: knownCapability(false) }),
    completeCapabilities({ ansiCursor: knownCapability(false) }),
    completeCapabilities({ columns: dimensionFromNumber(40), rows: dimensionFromNumber(10) }),
    completeCapabilities({ columns: unknownDimension() }),
    completeCapabilities({ outputTty: knownCapability(false) }),
  ];

  it("never enables resources unsupported by the terminal", () => {
    for (const capabilities of cases) {
      const profile = selectRenderProfile(INTERACTIVE, capabilities);
      expect(renderProfileIsConservative(profile, capabilities)).toBe(true);
      expect(assertConservativeProfile(profile, capabilities).ok).toBe(true);
    }
  });

  it("is deterministic for identical inputs", () => {
    const first = selectRenderProfile(INTERACTIVE, completeCapabilities());
    const second = selectRenderProfile(INTERACTIVE, completeCapabilities());
    expect(first).toEqual(second);
  });

  it("flags a manually corrupted profile as non-conservative", () => {
    const capabilities = completeCapabilities({ ansiCursor: knownCapability(false) });
    const profile = selectRenderProfile(INTERACTIVE, capabilities);
    const corrupted = { ...profile, ansi: true };
    expect(renderProfileIsConservative(corrupted, capabilities)).toBe(false);
    expect(assertConservativeProfile(corrupted, capabilities).ok).toBe(false);
  });
});
