import { describe, expect, it } from "vitest";
import {
  ASCII_SYMBOLS,
  createInitialSession,
  projectSessionState,
  type Control,
  type RenderProfile,
  type SessionState,
} from "../src/domain/tui/index.js";
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

const control = (id: string, action: Control["action"], top: number, label = id): Control => ({
  id,
  kind: "button",
  label,
  enabled: true,
  visible: true,
  action,
  bounds: { top: top as NonNegativeInteger, bottom: top as NonNegativeInteger },
});

const stateAtSelect = (overrides: Partial<SessionState> = {}): SessionState => {
  const initial = createInitialSession(PROFILE);
  return { ...initial, stage: "select", ...overrides };
};

describe("redaction-first presentation projection", () => {
  it("projects deterministic semantic regions and freezes the complete view", () => {
    const next = control("next", "advance", 2);
    const back = control("back", "back", 1);
    const state = stateAtSelect({
      focusByView: new Map([["select", { viewId: "select", controlId: "next" }]]),
      unconfirmedInputs: new Map([["directory", "./project"]]),
    });

    const projected = projectSessionState(state, { controls: [next, back] });

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.brandLabel).toBe("auto-ai-setup");
    expect(projected.value.stageLabel).toBe("SELECCIÓN");
    expect(projected.value.primaryAction?.id).toBe("next");
    expect(projected.value.controls.map((item) => item.id)).toEqual(["back", "next"]);
    expect(projected.value.focusControlId).toBe("next");
    expect(projected.value.sections.map((item) => item.id)).toEqual(["stage", "input:directory", "control:back", "control:next"]);
    expect(Object.isFrozen(projected.value)).toBe(true);
    expect(Object.isFrozen(projected.value.controls)).toBe(true);
    expect(Object.isFrozen(projected.value.sections)).toBe(true);
  });

  it("redacts known literals across controls, values, status, and activity before returning", () => {
    const secret = "secret-value-42";
    const state = stateAtSelect({
      selections: [{ viewId: "select", controlId: "choice", value: { kind: "text", value: secret } }],
      unconfirmedInputs: new Map([["token-input", secret]]),
      warnings: [`warning: ${secret}`],
      errors: [{ stage: "select", operation: "validate", cause: secret }],
      activity: { stage: "select", description: `working with ${secret}`, progress: undefined, lastValidProgress: undefined },
    });

    const projected = projectSessionState(state, {
      knownSecrets: [secret],
      controls: [control("continue", "advance", 0, `Continue ${secret}`)],
    });

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(JSON.stringify(projected.value)).not.toContain(secret);
    expect(projected.value.activity?.description).toContain("[REDACTED]");
    expect(projected.value.status.some((status) => status.label === "ERROR")).toBe(true);
  });

  it("redacts identifiers used by focus, controls, and semantic regions", () => {
    const secret = "secret-control-id";
    const state = stateAtSelect({
      focusByView: new Map([["select", { viewId: "select", controlId: secret }]]),
      unconfirmedInputs: new Map([[secret, "safe-value"]]),
      selections: [{ viewId: secret, controlId: "choice", value: { kind: "text", value: "safe-choice" } }],
    });

    const projected = projectSessionState(state, {
      knownSecrets: [secret],
      controls: [control(secret, "advance", 0)],
    });

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(JSON.stringify(projected.value)).not.toContain(secret);
    expect(projected.value.controls[0]?.id).toBe("[REDACTED]");
    expect(projected.value.focusControlId).toBe("[REDACTED]");
    expect(projected.value.sections.map((item) => item.id)).not.toContain(expect.stringContaining(secret));
  });

  it("fails closed with a typed error when the redactor throws", () => {
    const projected = projectSessionState(stateAtSelect(), {
      redactor: {
        redact: () => {
          throw new Error("redactor unavailable");
        },
      },
    });

    expect(projected).toMatchObject({ ok: false, error: { code: "REDACTION_INCOMPLETE" } });
  });
});
