import type { InitialCli } from "../project/models.js";
import type { Result } from "../shared/types.js";

/** Closed process registry for the isolated availability-probe contract. */
export const CLI_PROBE_ALLOWLIST: readonly InitialCli[] = ["gh", "supabase", "vercel", "playwright"];
export const CLI_PROBE_MAX_DURATION_MS = 5_000;
export const CLI_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

export interface CliProbeRequest {
  readonly cli: string;
  readonly requiredCapabilities?: readonly string[];
}

export interface RegisteredCliProbeRequest {
  readonly cli: InitialCli;
  readonly args: readonly ["--version"];
  readonly requiredCapabilities: readonly string[];
}

export interface CliProbeExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly capabilities?: readonly string[];
}

export interface CliProbeExecutor {
  execute(request: RegisteredCliProbeRequest, signal?: AbortSignal): Promise<CliProbeExecution>;
}

export type CliProbeErrorCode =
  | "PROCESS_NOT_ALLOWED"
  | "NONZERO_EXIT"
  | "INVALID_VERSION"
  | "TIMEOUT"
  | "OUTPUT_OVERFLOW"
  | "INCOMPATIBLE_CAPABILITY";

export interface CliProbeError {
  readonly code: CliProbeErrorCode;
  readonly message: string;
  readonly cli: string;
  readonly recoverability: "none" | "retry";
  readonly missingCapabilities?: readonly string[];
}

export interface ClassifiedCliProbe {
  readonly cli: InitialCli;
  readonly status: "available";
  readonly version: string;
  readonly durationMs: number;
  readonly capabilities: readonly string[];
}

const semverPattern = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/;
const isInitialCli = (value: string): value is InitialCli => CLI_PROBE_ALLOWLIST.includes(value as InitialCli);
const outputBytes = (value: string): number => Buffer.byteLength(value, "utf8");

export const registerCliProbe = (request: CliProbeRequest): Result<RegisteredCliProbeRequest, CliProbeError> => {
  if (!isInitialCli(request.cli)) {
    return { ok: false, error: { code: "PROCESS_NOT_ALLOWED", message: `Process is not allowlisted: ${request.cli}`, cli: request.cli, recoverability: "none" } };
  }
  return {
    ok: true,
    value: {
      cli: request.cli,
      args: ["--version"],
      requiredCapabilities: [...(request.requiredCapabilities ?? [])].sort((left, right) => left.localeCompare(right)),
    },
  };
};

const invalid = (code: CliProbeErrorCode, cli: InitialCli, message: string): Result<never, CliProbeError> => ({
  ok: false,
  error: { code, message, cli, recoverability: code === "TIMEOUT" ? "retry" : "none" },
});

/** Deterministically classifies an injected process result without starting a process. */
export const classifyCliProbe = (
  request: RegisteredCliProbeRequest,
  result: CliProbeExecution,
  maxDurationMs = CLI_PROBE_MAX_DURATION_MS,
  maxOutputBytes = CLI_PROBE_MAX_OUTPUT_BYTES,
): Result<ClassifiedCliProbe, CliProbeError> => {
  if (!isInitialCli(request.cli)) {
    return { ok: false, error: { code: "PROCESS_NOT_ALLOWED", message: `Process is not allowlisted: ${String(request.cli)}`, cli: String(request.cli), recoverability: "none" } };
  }
  if (result.timedOut || !Number.isFinite(result.durationMs) || result.durationMs < 0 || result.durationMs >= maxDurationMs) {
    return invalid("TIMEOUT", request.cli, `Probe for ${request.cli} timed out or exceeded its duration limit`);
  }
  if (result.truncated || outputBytes(result.stdout) + outputBytes(result.stderr) > maxOutputBytes) {
    return invalid("OUTPUT_OVERFLOW", request.cli, `Probe output for ${request.cli} exceeded its bounded limit`);
  }
  if (result.exitCode !== 0) return invalid("NONZERO_EXIT", request.cli, `Probe for ${request.cli} exited with code ${result.exitCode}`);
  const versionMatch = `${result.stdout}\n${result.stderr}`.match(semverPattern);
  if (versionMatch?.[1] === undefined) return invalid("INVALID_VERSION", request.cli, `Probe for ${request.cli} did not return a valid SemVer version`);
  const capabilities = [...(result.capabilities ?? [])].sort((left, right) => left.localeCompare(right));
  const missingCapabilities = request.requiredCapabilities?.filter((capability) => !capabilities.includes(capability)) ?? [];
  if (missingCapabilities.length > 0) {
    return {
      ok: false,
      error: {
        code: "INCOMPATIBLE_CAPABILITY",
        message: `Probe for ${request.cli} lacks required capabilities: ${missingCapabilities.join(", ")}`,
        cli: request.cli,
        recoverability: "none",
        missingCapabilities,
      },
    };
  }
  return { ok: true, value: { cli: request.cli, status: "available", version: versionMatch[1], durationMs: result.durationMs, capabilities } };
};

export class AllowlistedCliProbeAdapter {
  public constructor(private readonly executor: CliProbeExecutor) {}

  public async probe(request: CliProbeRequest, signal?: AbortSignal): Promise<Result<ClassifiedCliProbe, CliProbeError>> {
    const registered = registerCliProbe(request);
    if (!registered.ok) return registered;
    const execution = await this.executor.execute(registered.value, signal);
    return classifyCliProbe(registered.value, execution);
  }
}

export const createAllowlistedCliProbeAdapter = (executor: CliProbeExecutor): AllowlistedCliProbeAdapter => new AllowlistedCliProbeAdapter(executor);
