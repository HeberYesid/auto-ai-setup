import { describe, expect, it } from "vitest";
import {
  ASCII_SYMBOLS,
  createInitialSession,
  currentViewId,
  isPendingWork,
  nextStage,
  previousStage,
  reduceSession,
} from "../src/domain/tui/index.js";
import type {
  Control,
  ControlKind,
  ExternalResultEvent,
  RegisteredAction,
  RenderProfile,
  SessionReducerContext,
  SessionState,
  Stage,
  UiEvent,
} from "../src/domain/tui/index.js";
import { err, ok, type OperationId, type Sha256 } from "../src/domain/shared/types.js";
import { tuiError } from "../src/domain/tui/errors.js";
import type { NonNegativeInteger } from "../src/domain/tui/values.js";

/** A conservative linear-text profile used to seed session state in tests. */
const LINEAR_PROFILE: RenderProfile = {
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

const control = (id: string, action: RegisteredAction, kind: ControlKind = "button", overrides: Partial<Control> = {}): Control => ({
  id,
  kind,
  label: `label:${id}`,
  enabled: true,
  visible: true,
  action,
  bounds: { top: 0 as NonNegativeInteger, bottom: 0 as NonNegativeInteger },
  ...overrides,
});

/** Seed a session at a given stage with a stored focus on `controlId` for that view. */
const seed = (stage: Stage, controlId: string | undefined, overrides: Partial<SessionState> = {}): SessionState => {
  const base = createInitialSession(LINEAR_PROFILE);
  const focusByView = controlId === undefined ? base.focusByView : new Map([[stage, { viewId: stage, controlId }]]);
  return { ...base, stage, focusByView, ...overrides };
};

const context = (controls: readonly Control[]): SessionReducerContext => ({ controls });
const enter: UiEvent = { kind: "key", key: { kind: "named", name: "Enter" } };
const space: UiEvent = { kind: "key", key: { kind: "named", name: "Space" } };

describe("reduceSession — one-event/one-action activation", () => {
  it("activates the focused control's action exactly once on Enter", () => {
    const advance = control("go", "advance");
    const state = seed("select", "go");
    const result = reduceSession(state, enter, context([advance]));
    expect(result.command).toEqual({ kind: "run-stage", stage: "review" });
    expect(isPendingWork(result.state)).toBe(true);
    expect(result.state.activity?.stage).toBe("review");
  });

  it("toggles a focused multiselect option exactly once on Space and back off on a second Space", () => {
    const option = control("opt-a", "toggle-option", "multiselect");
    const first = reduceSession(seed("select", "opt-a"), space, context([option]));
    expect(first.command).toEqual({ kind: "none" });
    expect(first.state.selections).toHaveLength(1);
    expect(first.state.selections[0]).toMatchObject({ controlId: "opt-a", value: { kind: "multiselect", optionIds: ["opt-a"] } });

    const second = reduceSession(first.state, space, context([option]));
    expect(second.state.selections).toHaveLength(0);
  });

  it("records a single-choice selection on Enter over a choice control", () => {
    const choice = control("choice-x", "select-choice", "choice");
    const result = reduceSession(seed("select", "choice-x"), enter, context([choice]));
    expect(result.command).toEqual({ kind: "none" });
    expect(result.state.selections[0]).toMatchObject({ controlId: "choice-x", value: { kind: "choice", optionId: "choice-x" } });
  });
});

describe("reduceSession — invalid actions are immutable", () => {
  it("returns the exact prior state and no command when no control is focused", () => {
    const state = seed("select", undefined);
    const result = reduceSession(state, enter, context([]));
    expect(result.state).toBe(state);
    expect(result.command).toEqual({ kind: "none" });
  });

  it("ignores Enter on a disabled or invisible focused control", () => {
    const disabled = control("go", "advance", "button", { enabled: false });
    const state = seed("select", "go");
    const result = reduceSession(state, enter, context([disabled]));
    expect(result.state).toBe(state);
    expect(result.command).toEqual({ kind: "none" });
  });

  it("ignores Space on a non-multiselect focused control", () => {
    const button = control("go", "advance", "button");
    const state = seed("select", "go");
    const result = reduceSession(state, space, context([button]));
    expect(result.state).toBe(state);
  });

  it("ignores a mouse activation targeting an unknown control", () => {
    const state = seed("select", "go");
    const result = reduceSession(state, { kind: "mouse", action: "activate", controlId: "missing" }, context([control("go", "advance")]));
    expect(result.state).toBe(state);
    expect(result.command).toEqual({ kind: "none" });
  });
});

describe("reduceSession — command separation and closed commands", () => {
  it("emits an apply command bound to the displayed plan hash on approve-plan", () => {
    const hash = "a".repeat(64) as Sha256;
    const approve = control("approve", "approve-plan");
    const state = seed("approve", "approve", { displayedPlanHash: hash });
    const result = reduceSession(state, enter, context([approve]));
    expect(result.command).toEqual({ kind: "apply-approved-plan", hash });
    expect(result.state.approval).toEqual({ decision: "approved", hash });
  });

  it("does not emit a command when approving without a displayed plan hash", () => {
    const approve = control("approve", "approve-plan");
    const state = seed("approve", "approve");
    const result = reduceSession(state, enter, context([approve]));
    expect(result.state).toBe(state);
    expect(result.command).toEqual({ kind: "none" });
  });

  it("records rejection as a pure state transition without a command", () => {
    const hash = "b".repeat(64) as Sha256;
    const reject = control("reject", "reject-plan");
    const state = seed("approve", "reject", { displayedPlanHash: hash });
    const result = reduceSession(state, enter, context([reject]));
    expect(result.command).toEqual({ kind: "none" });
    expect(result.state.approval).toEqual({ decision: "rejected", hash });
  });

  it("emits a recover command for a registered recovery control", () => {
    const rollback = control("rollback", "rollback");
    const state = seed("recover", "rollback");
    const result = reduceSession(state, enter, context([rollback]));
    expect(result.command).toEqual({ kind: "recover", controlId: "rollback" });
    expect(isPendingWork(result.state)).toBe(true);
  });
});

describe("reduceSession — cancellation and finalization", () => {
  it("requests confirmation on cancel, finalizes on confirm-cancel, and continues on resume", () => {
    const cancelResult = reduceSession(seed("select", undefined), { kind: "key", key: { kind: "named", name: "Escape" } }, context([]));
    expect(cancelResult.state.cancellationPending).toBe(true);
    expect(cancelResult.command).toEqual({ kind: "none" });

    const confirm = control("confirm-cancel", "confirm-cancel");
    const confirmState = { ...cancelResult.state, focusByView: new Map([["select", { viewId: "select", controlId: "confirm-cancel" }]]) };
    const confirmResult = reduceSession(confirmState, enter, context([confirm]));
    expect(confirmResult.command).toEqual({ kind: "exit", reason: "cancelled" });
    expect(confirmResult.state.cancelled).toBe(true);
    expect(confirmResult.state.finalized).toBe(true);

    const resume = control("resume", "resume");
    const resumeState = { ...cancelResult.state, focusByView: new Map([["select", { viewId: "select", controlId: "resume" }]]) };
    const resumeResult = reduceSession(resumeState, enter, context([resume]));
    expect(resumeResult.state.cancellationPending).toBe(false);
  });

  it("freezes a finalized session against further events", () => {
    const finalized = seed("summary", "finish", { finalized: true });
    const result = reduceSession(finalized, enter, context([control("finish", "finish")]));
    expect(result.state).toBe(finalized);
    expect(result.command).toEqual({ kind: "none" });
  });

  it("finishes with a failed reason when errors are present", () => {
    const finish = control("finish", "finish");
    const state = seed("summary", "finish", { errors: [{ stage: "apply", operation: "write", cause: "disk full" }] });
    const result = reduceSession(state, enter, context([finish]));
    expect(result.command).toEqual({ kind: "exit", reason: "failed" });
    expect(result.state.finalized).toBe(true);
  });
});

describe("reduceSession — pending work locks unsafe edits", () => {
  const pendingState = (focusControlId: string): SessionState =>
    seed("apply", focusControlId, {
      activity: { stage: "apply", description: "applying", progress: undefined, lastValidProgress: undefined },
    });

  it("blocks advancing while application work is pending", () => {
    const advance = control("go", "advance");
    const state = pendingState("go");
    const result = reduceSession(state, enter, context([advance]));
    expect(result.state).toBe(state);
    expect(result.command).toEqual({ kind: "none" });
  });

  it("blocks toggling a multiselect option while work is pending", () => {
    const option = control("opt", "toggle-option", "multiselect");
    const state = pendingState("opt");
    const result = reduceSession(state, space, context([option]));
    expect(result.state).toBe(state);
  });

  it("permits help toggling while work is pending", () => {
    const state = pendingState("go");
    const result = reduceSession(state, { kind: "key", key: { kind: "named", name: "Question" } }, context([]));
    expect(result.state.helpVisible).toBe(true);
  });

  it("permits cancellation while work is pending", () => {
    const state = pendingState("go");
    const result = reduceSession(state, { kind: "key", key: { kind: "named", name: "Escape" } }, context([]));
    expect(result.state.cancellationPending).toBe(true);
  });

  it("clears pending activity when the external operation result arrives", () => {
    const state = pendingState("go");
    const done: ExternalResultEvent = {
      kind: "external-result",
      operationId: "op-1" as OperationId,
      result: ok({ operationId: "op-1" as OperationId, status: "completed" }),
    };
    const result = reduceSession(state, done, context([]));
    expect(isPendingWork(result.state)).toBe(false);
    expect(result.state.errors).toHaveLength(0);
  });

  it("records a session error when the external operation fails", () => {
    const state = pendingState("go");
    const failed: ExternalResultEvent = {
      kind: "external-result",
      operationId: "op-2" as OperationId,
      result: err(tuiError("UNAVAILABLE_EFFECT", "process unavailable")),
    };
    const result = reduceSession(state, failed, context([]));
    expect(isPendingWork(result.state)).toBe(false);
    expect(result.state.errors).toHaveLength(1);
    expect(result.state.errors[0]).toMatchObject({ operation: "op-2", cause: "process unavailable" });
  });
});

describe("reduceSession — navigation and deferred events", () => {
  it("leaves state unchanged for focus-navigation keys (owned by subtask 3.2)", () => {
    const state = seed("select", "go");
    for (const name of ["Tab", "ShiftTab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const) {
      const result = reduceSession(state, { kind: "key", key: { kind: "named", name } }, context([control("go", "advance")]));
      expect(result.state).toBe(state);
      expect(result.command).toEqual({ kind: "none" });
    }
  });

  it("leaves state unchanged for activity, timer, and resize events", () => {
    const state = seed("apply", undefined);
    const events: UiEvent[] = [
      { kind: "activity", progress: { kind: "indeterminate", description: "working" } },
      { kind: "timer", tick: 1 as NonNegativeInteger },
    ];
    for (const event of events) {
      expect(reduceSession(state, event, context([])).state).toBe(state);
    }
  });

  it("navigates backward to the previous stage", () => {
    const back = control("back", "back");
    const result = reduceSession(seed("review", "back"), enter, context([back]));
    expect(result.state.stage).toBe("select");
    expect(result.command).toEqual({ kind: "none" });
  });
});

describe("reduceSession — replay determinism", () => {
  it("produces identical state sequences when a keystroke sequence is replayed", () => {
    const controls = [control("opt-a", "toggle-option", "multiselect")];
    const start = seed("select", "opt-a");
    const events: UiEvent[] = [space, space, space, { kind: "key", key: { kind: "named", name: "Question" } }];

    const replay = (): SessionState[] => {
      let state = start;
      const states: SessionState[] = [];
      for (const event of events) {
        state = reduceSession(state, event, context(controls)).state;
        states.push(state);
      }
      return states;
    };

    expect(replay()).toEqual(replay());
  });
});

describe("stage helpers", () => {
  it("computes linear next and previous stages", () => {
    expect(nextStage("inspect")).toBe("select");
    expect(nextStage("summary")).toBeUndefined();
    expect(previousStage("select")).toBe("inspect");
    expect(previousStage("inspect")).toBeUndefined();
  });

  it("maps the current stage to its view id", () => {
    expect(currentViewId(seed("review", undefined))).toBe("review");
  });
});
