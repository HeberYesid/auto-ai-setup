import { describe, expect, it } from "vitest";
import {
  AllowlistedCliProbeAdapter,
  classifyCliProbe,
  registerCliProbe,
} from "../src/domain/index.js";
import type { CliProbeExecution, RegisteredCliProbeRequest } from "../src/domain/index.js";

const request = (cli = "gh", requiredCapabilities: readonly string[] = []): RegisteredCliProbeRequest => ({
  cli: cli as never,
  args: ["--version"],
  requiredCapabilities,
});
const success = (overrides: Partial<CliProbeExecution> = {}): CliProbeExecution => ({
  exitCode: 0,
  stdout: "gh version 2.45.0",
  stderr: "",
  durationMs: 10,
  timedOut: false,
  truncated: false,
  capabilities: ["repository-read"],
  ...overrides,
});

describe("isolated allowlisted CLI probe contract", () => {
  it("rejects unregistered processes before the executor is called", async () => {
    let calls = 0;
    const adapter = new AllowlistedCliProbeAdapter({ execute: async () => { calls += 1; return success(); } });
    const result = await adapter.probe({ cli: "npm" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROCESS_NOT_ALLOWED");
    expect(calls).toBe(0);
  });

  it.each([
    ["nonzero", success({ exitCode: 1 }), "NONZERO_EXIT"],
    ["invalid version", success({ stdout: "not a version" }), "INVALID_VERSION"],
    ["timeout", success({ timedOut: true }), "TIMEOUT"],
    ["overflow", success({ truncated: true }), "OUTPUT_OVERFLOW"],
    ["slow", success({ durationMs: 5_000 }), "TIMEOUT"],
  ] as const)("rejects %s results", (_name, execution, code) => {
    const result = classifyCliProbe(request(), execution);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it("rejects missing capabilities and accepts a bounded valid SemVer result", () => {
    const missing = classifyCliProbe(request("gh", ["pull-request-write"]), success());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("INCOMPATIBLE_CAPABILITY");
    const available = classifyCliProbe(request(), success());
    expect(available).toMatchObject({ ok: true, value: { cli: "gh", status: "available", version: "2.45.0" } });
  });

  it("registers only version probes and keeps recommendation code independent", () => {
    const registered = registerCliProbe({ cli: "vercel", requiredCapabilities: ["deploy"] });
    expect(registered).toMatchObject({ ok: true, value: { cli: "vercel", args: ["--version"], requiredCapabilities: ["deploy"] } });
  });
});
