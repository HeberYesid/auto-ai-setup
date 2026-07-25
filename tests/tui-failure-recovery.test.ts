import { describe, expect, it } from "vitest";
import {
  createInitialSession,
  projectSessionState,
  canonicalizeRecoveryPaths,
  type RenderProfile,
  type SessionState,
} from "../src/domain/tui/index.js";
import type { ExecutionSummary, SafeProjectPath } from "../src/domain/index.js";
import { ASCII_SYMBOLS } from "../src/domain/tui/capabilities.js";

const profile: RenderProfile = {
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

const summary = (overrides: Partial<ExecutionSummary> = {}): ExecutionSummary => ({
  runId: "run-tui" as ExecutionSummary["runId"],
  status: "incomplete",
  exitCode: 3,
  applied: ["file:one"],
  skipped: ["file:two"],
  warnings: ["transaction warning"],
  errors: ["transaction error"],
  manualReviewPaths: [],
  ...overrides,
});

const stateWith = (overrides: Partial<SessionState>): SessionState => ({ ...createInitialSession(profile), ...overrides });

const path = (value: string): SafeProjectPath => value as SafeProjectPath;

describe("typed failure, recovery, and summary projections", () => {
  it("preserves the failure details and withholds the final summary until recovery is visible", () => {
    const state = stateWith({
      stage: "summary",
      result: summary(),
      errors: [{ stage: "apply", operation: "atomic write", cause: "disk-secret-full" }],
      recovery: undefined,
    });

    const projected = projectSessionState(state, { knownSecrets: ["disk-secret"] });

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.status).toContainEqual(expect.objectContaining({ label: "ERROR" }));
    expect(projected.value.status.some((item) => item.text.includes("APLICACIÓN") && item.text.includes("atomic write"))).toBe(true);
    expect(projected.value.recovery).toMatchObject({ result: "not-required", controls: [] });
    expect(projected.value.summary).toBeUndefined();
    expect(JSON.stringify(projected.value)).not.toContain("disk-secret");
  });

  it("includes all result fields and canonical unresolved paths exactly once after recovery", () => {
    const state = stateWith({
      stage: "summary",
      result: summary({ status: "failed-recovered", exitCode: 1 }),
      errors: [{ stage: "apply", operation: "write", cause: "write failed" }],
      warnings: ["session warning"],
      recovery: {
        result: "partial",
        controls: [
          { id: "retry", label: "Reintentar", action: "retry", enabled: true },
          { id: "finish", label: "Finalizar", action: "finish", enabled: false },
        ],
        unresolvedPaths: [path("./pending/file"), path("pending/file"), path("pending//other"), path("pending/other")],
      },
    });

    const projected = projectSessionState(state);

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.summary).toMatchObject({
      status: "partial",
      exitCode: 1,
      changes: [{ operationId: "file:one" }],
      omissions: ["file:two"],
      recovery: {
        result: "partial",
        controls: [
          { id: "retry", enabled: true },
          { id: "finish", enabled: false },
        ],
      },
      warnings: ["session warning", "transaction warning"],
    });
    expect(projected.value.summary?.errors).toHaveLength(2);
    expect(projected.value.summary?.recovery.unresolvedPaths).toEqual(["pending/file", "pending/other"]);
  });

  it("rejects unsafe recovery paths with a typed error", () => {
    const result = canonicalizeRecoveryPaths(["../outside"]);
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_RECOVERY_PATH" } });
  });
});
