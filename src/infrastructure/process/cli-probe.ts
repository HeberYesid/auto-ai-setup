/**
 * Process-layer entry point for the isolated probe contract.
 *
 * The adapter deliberately accepts an injected executor. The recommendation
 * engine imports only the pure domain module and never reaches this boundary.
 */
export {
  AllowlistedCliProbeAdapter,
  CLI_PROBE_ALLOWLIST,
  CLI_PROBE_MAX_DURATION_MS,
  CLI_PROBE_MAX_OUTPUT_BYTES,
  classifyCliProbe,
  createAllowlistedCliProbeAdapter,
  registerCliProbe,
} from "../../domain/catalog/cli-probes.js";
export type {
  ClassifiedCliProbe,
  CliProbeError,
  CliProbeErrorCode,
  CliProbeExecution,
  CliProbeExecutor,
  CliProbeRequest,
  RegisteredCliProbeRequest,
} from "../../domain/catalog/cli-probes.js";
