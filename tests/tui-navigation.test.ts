import { describe, expect, it } from "vitest";
import {
  ASCII_SYMBOLS,
  computeScrollTop,
  createInitialSession,
  gateAdvanceControls,
  type Control,
  type RenderProfile,
  type SessionState,
  type ValidationRule,
  updateInputValidation,
} from "../src/domain/tui/index.js";
import { reduceSession, type SessionReducerContext } from "../src/domain/tui/reducer.js";
import type { NonNegativeInteger } from "../src/domain/tui/values.js";

const PROFILE: RenderProfile = {
  mode: "linear-text",
  width: undefined,
  height: undefined,
  ansi: false,
  color: false,
  unicode: false,
  animation: false,
  mouse: false,
  symbols: ASCII_SYMBOLS,
  downgradeReasons: [],
};

const control = (id: string, action: Control["action"], kind: Control["kind"], top: number, bottom = top): Control => ({
  id,
  kind,
  label: id,
  enabled: true,
  visible: true,
  action,
  bounds: { top: top as NonNegativeInteger, bottom: bottom as NonNegativeInteger },
});

const state = (focus: string | undefined, overrides: Partial<SessionState> = {}): SessionState => {
  const initial = createInitialSession(PROFILE);
  return {
    ...initial,
    stage: "select",
    focusByView: focus === undefined ? initial.focusByView : new Map([["select", { viewId: "select", controlId: focus }]]),
    ...overrides,
  };
};

const key = (name: "Tab" | "ShiftTab" | "Enter"): Parameters<typeof reduceSession>[1] => ({ kind: "key", key: { kind: "named", name } });

const required: ValidationRule = {
  rule: "required",
  message: "value is required",
  validate: (value) => value.length > 0,
};

const context = (controls: readonly Control[], rules?: ReadonlyMap<string, readonly ValidationRule[]>): SessionReducerContext => ({
  controls,
  validationRules: rules,
  viewportRows: 3,
});

describe("TUI focus, scrolling, and validation reducers", () => {
  it("scrolls the minimum distance to expose the complete focused control", () => {
    const controls = [control("first", "back", "button", 0), control("last", "advance", "button", 5, 6)];
    expect(computeScrollTop(controls, "last", 3, 0)).toBe(4);
    expect(computeScrollTop(controls, "first", 3, 4)).toBe(0);
    expect(computeScrollTop(controls, "last", 10, 4)).toBe(0);
  });

  it("preserves input and deduplicates violated validation rules", () => {
    const initial = state(undefined, { unconfirmedInputs: new Map([["name", ""]]) });
    const duplicate = [required, required];
    const updated = updateInputValidation(initial, "name", "", duplicate);
    expect(updated.unconfirmedInputs.get("name")).toBe("");
    expect(updated.validation.errors).toEqual([{ controlId: "name", rule: "required", message: "value is required" }]);
  });

  it("blocks only advance controls while validation is invalid", () => {
    const controls = [
      control("back", "back", "button", 0),
      control("continue", "advance", "button", 1),
      control("help", "toggle-help", "button", 2),
    ];
    const gated = gateAdvanceControls(controls, {
      pending: false,
      errors: [{ controlId: "name", rule: "required", message: "value is required" }],
    });
    expect(gated.map((item) => [item.id, item.enabled])).toEqual([
      ["back", true],
      ["continue", false],
      ["help", true],
    ]);
  });

  it("edits a text input, preserves its value, and prevents an invalid advance", () => {
    const input = control("name", "edit-input", "text-input", 0);
    const advance = control("continue", "advance", "button", 1);
    const rules = new Map([["name", [required] as readonly ValidationRule[]]]);
    const start = state("name");
    const typed = reduceSession(start, { kind: "key", key: { kind: "printable", text: "" } }, context([input, advance], rules));
    expect(typed.state.unconfirmedInputs.get("name")).toBe("");
    expect(typed.state.validation.errors).toHaveLength(1);

    const blocked = reduceSession(typed.state, key("Enter"), context([input, advance], rules));
    expect(blocked.state).toBe(typed.state);
    expect(blocked.command).toEqual({ kind: "none" });
  });

  it("restores focus to the first enabled control and wraps backward", () => {
    const first = control("first", "back", "button", 0);
    const second = control("second", "advance", "button", 1);
    const start = state("missing");
    const restored = reduceSession(start, key("Tab"), context([first, second]));
    expect(restored.state.focusByView.get("select")?.controlId).toBe("first");
    const wrapped = reduceSession(restored.state, key("ShiftTab"), context([first, second]));
    expect(wrapped.state.focusByView.get("select")?.controlId).toBe("second");
  });
});
