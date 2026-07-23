import { describe, expect, it } from "vitest";
import {
  authorizeApproval,
  calculatePlanHash,
  coordinateApproval,
  defaultApprovalForPlan,
  createInitialSession,
  reduceSession,
  type ChangePlan,
  type Control,
  type RenderProfile,
  type Sha256,
} from "../src/domain/index.js";

const profile: RenderProfile = {
  mode: "linear-text",
  width: 80,
  height: 24,
  ansi: false,
  color: false,
  unicode: false,
  animation: false,
  mouse: false,
  symbols: {
    focusMarker: ">",
    selectedMarker: "[x]",
    unselectedMarker: "[ ]",
    bulletMarker: "*",
    truncationIndicator: "...",
    horizontalBorder: "-",
    verticalBorder: "|",
    successIcon: "+",
    warningIcon: "!",
    errorIcon: "x",
  },
  downgradeReasons: [],
};

const plan = (): ChangePlan => {
  const unsigned: Omit<ChangePlan, "planHash"> = {
    schemaVersion: 1,
    runId: "run-approval" as never,
    root: "/virtual/project" as never,
    mode: "manual",
    confirmedStackDigest: "a".repeat(64) as Sha256,
    createdAt: "2025-01-01T00:00:00.000Z",
    fileChanges: [],
    externalOperations: [],
    warnings: [],
  };
  return { ...unsigned, planHash: calculatePlanHash(unsigned) };
};

const approvalControl: Control = {
  id: "approve",
  kind: "button",
  label: "Aprobar plan",
  enabled: true,
  visible: true,
  action: "approve-plan",
  bounds: { top: 0 as never, bottom: 0 as never },
};

describe("Feature: modern-tui-interface, explicit hash-bound approval", () => {
  it("defaults a displayed plan to explicit rejection and keeps it immutable", () => {
    const current = plan();
    const state = defaultApprovalForPlan(current.planHash);

    expect(state).toEqual({ decision: "rejected", hash: current.planHash });
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("emits an apply command only for one approval of the canonical displayed hash", () => {
    const current = plan();
    const result = coordinateApproval(current, { displayedHash: current.planHash, decisions: ["approve"] });

    expect(result.status).toBe("approved");
    expect(result.state).toEqual({ decision: "approved", hash: current.planHash });
    expect(result.command).toEqual({ kind: "apply-approved-plan", hash: current.planHash });
    expect(result.error).toBeUndefined();
  });

  it("blocks stale and conflicting decisions without an effect command", () => {
    const current = plan();
    const stale = coordinateApproval(current, { displayedHash: "b".repeat(64) as Sha256, decisions: ["approve"] });
    const conflicted = coordinateApproval(current, {
      displayedHash: current.planHash,
      decisions: ["approve", "reject"],
    });

    expect(stale.status).toBe("stale");
    expect(stale.state).toEqual({ decision: "none", hash: undefined });
    expect(stale.command).toEqual({ kind: "none" });
    expect(stale.error?.code).toBe("APPROVAL_STALE");
    expect(conflicted.status).toBe("conflicted");
    expect(conflicted.state).toEqual({ decision: "conflicted", hash: current.planHash });
    expect(conflicted.command).toEqual({ kind: "none" });
    expect(conflicted.error?.code).toBe("APPROVAL_CONFLICTED");
  });

  it("allows a new approval after rejection and revalidates recorded approval", () => {
    const current = plan();
    const rejected = coordinateApproval(current, { displayedHash: current.planHash, decisions: ["reject"] });
    const approved = coordinateApproval(current, { displayedHash: current.planHash, decisions: ["approve"] });
    const authorized = authorizeApproval(current, current.planHash, approved.state);
    const blocked = authorizeApproval(current, current.planHash, rejected.state);

    expect(rejected.status).toBe("rejected");
    expect(rejected.command).toEqual({ kind: "none" });
    expect(approved.status).toBe("approved");
    expect(authorized.command).toEqual({ kind: "apply-approved-plan", hash: current.planHash });
    expect(blocked.status).toBe("blocked");
    expect(blocked.command).toEqual({ kind: "none" });
    expect(blocked.error?.code).toBe("APPROVAL_REQUIRED");
  });

  it("prevents the reducer from dispatching apply when the displayed hash is stale", () => {
    const current = plan();
    const initial = createInitialSession(profile);
    const state = {
      ...initial,
      stage: "approve" as const,
      plan: current,
      displayedPlanHash: "b".repeat(64) as Sha256,
      focusByView: new Map([["approve", { viewId: "approve", controlId: "approve" }]]),
    };

    const reduced = reduceSession(state, { kind: "key", key: { kind: "named", name: "Enter" } }, { controls: [approvalControl] });

    expect(reduced.command).toEqual({ kind: "none" });
    expect(reduced.state.approval).toEqual({ decision: "none", hash: undefined });
    expect(reduced.state.errors.at(-1)?.operation).toBe("approval");
  });
});
