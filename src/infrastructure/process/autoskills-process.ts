import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { ProcessExecutor, ProcessResult, ExternalOperationApproval, RegisteredProcessRequest } from "../../domain/shared/ports.js";
import { err, ok } from "../../domain/shared/types.js";
import type { CanonicalPath, Result, SecurityError, Sha256 } from "../../domain/shared/types.js";
import {
  AUTOSKILLS_INSTALL_TIMEOUT_MS,
  AUTOSKILLS_LIST_TIMEOUT_MS,
  AUTOSKILLS_MAX_OUTPUT_BYTES,
  type RegisteredAutoSkillsRequest,
} from "../../domain/catalog/autoskills.js";
import { isApprovedAutoSkillsInteractiveRequest, isOfficialAutoSkillsCommand } from "../../domain/security/product-policy.js";

export interface AutoSkillsProcessOptions {
  readonly maxOutputBytes?: number;
  readonly listTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  /** Optional current plan hash used by the application approval boundary. */
  readonly expectedPlanHash?: Sha256;
}

export interface AutoSkillsSpawnSpec {
  readonly executable: string;
  readonly args: readonly string[];
}

export const getAutoSkillsSpawnSpec = (platform: NodeJS.Platform, args: readonly string[]): AutoSkillsSpawnSpec => {
  const executable = platform === "win32" ? "npx.cmd" : "npx";
  return platform === "win32" ? { executable: "cmd.exe", args: ["/d", "/s", "/c", [executable, ...args].join(" ")] } : { executable, args };
};

/** Executes only the fixed npx autoskills invocations registered by the domain. */
export class RegisteredAutoSkillsProcessAdapter implements ProcessExecutor {
  private readonly maxOutputBytes: number;
  private readonly listTimeoutMs: number;
  private readonly installTimeoutMs: number;
  private readonly expectedPlanHash: Sha256 | undefined;

  public constructor(options: AutoSkillsProcessOptions = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? AUTOSKILLS_MAX_OUTPUT_BYTES;
    this.listTimeoutMs = options.listTimeoutMs ?? AUTOSKILLS_LIST_TIMEOUT_MS;
    this.installTimeoutMs = options.installTimeoutMs ?? AUTOSKILLS_INSTALL_TIMEOUT_MS;
    this.expectedPlanHash = options.expectedPlanHash;
  }

  public async execute(request: RegisteredAutoSkillsRequest, signal?: AbortSignal): Promise<ProcessResult> {
    const interactive = request.operation === "interactive";
    const args = ["--yes", "autoskills", ...request.args];
    if (signal?.aborted && this.validRequest(request)) return this.run(request.cwd, args, 0, interactive, signal);
    const validation = await this.validateRequest(request);
    if (!validation.ok) throw securityException(validation.error);
    if (signal?.aborted) return this.run(request.cwd, args, 0, interactive, signal);
    return this.run(request.cwd, args, 0, interactive, signal);
  }

  /**
   * Application-facing effect boundary. The approval is checked before any
   * process call; a configured expected hash prevents reuse across plans.
   */
  public async runApproved(
    request: RegisteredProcessRequest,
    approval: ExternalOperationApproval,
    signal?: AbortSignal,
  ): Promise<Result<ProcessResult, SecurityError>> {
    const path = request.cwd;
    if (
      approval.approved !== true ||
      approval.planHash.length !== 64 ||
      !/^[a-f0-9]{64}$/i.test(approval.planHash) ||
      (this.expectedPlanHash !== undefined && approval.planHash !== this.expectedPlanHash) ||
      request.command !== "npx-autoskills" ||
      request.args.length !== 0
    )
      return err(processDenied("PROCESS_NOT_ALLOWED: approval is not bound to the current official autoskills operation", path));
    const registered = {
      command: "npx-autoskills" as const,
      operation: "interactive" as const,
      args: [] as const,
      cwd: request.cwd,
      authorized: true as const,
    };
    if (!isApprovedAutoSkillsInteractiveRequest(registered))
      return err(processDenied("PROCESS_NOT_ALLOWED: only the official interactive autoskills TUI is registered", path));
    try {
      return ok(await this.execute(registered, signal));
    } catch (cause) {
      return err(
        processDenied(
          `PROCESS_NOT_ALLOWED: autoskills execution failed safely (${cause instanceof Error ? cause.message : String(cause)})`,
          path,
        ),
      );
    }
  }

  private async validateRequest(request: RegisteredAutoSkillsRequest): Promise<Result<void, SecurityError>> {
    if (request.command !== "npx-autoskills" || request.authorized !== true || !this.validRequest(request))
      return err(processDenied("PROCESS_NOT_ALLOWED: invalid registered autoskills request", request.cwd));
    if (request.operation !== "interactive")
      return err(processDenied("PROCESS_NOT_ALLOWED: autoskills supports only its interactive TUI", request.cwd));
    try {
      await realpath(request.cwd);
    } catch (cause) {
      return err(
        processDenied(
          `PROCESS_NOT_ALLOWED: unable to verify the project working directory (${cause instanceof Error ? cause.message : String(cause)})`,
          request.cwd,
        ),
      );
    }
    return ok(undefined);
  }

  private validRequest(request: RegisteredAutoSkillsRequest): boolean {
    if (request.cwd.length === 0 || request.cwd.includes("\0") || !/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(request.cwd)) return false;
    return isApprovedAutoSkillsInteractiveRequest(request) && isOfficialAutoSkillsCommand(["npx", "--yes", "autoskills", ...request.args]);
  }

  private run(
    cwd: CanonicalPath,
    args: readonly string[],
    timeoutMs: number,
    interactive: boolean,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    return new Promise((resolve) => {
      const started = performance.now();
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let capturedBytes = 0;
      let timedOut = false;
      let settled = false;
      const timeoutHolder: { value?: ReturnType<typeof setTimeout> } = {};
      let child: ReturnType<typeof spawn>;

      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        if (timeoutHolder.value !== undefined) clearTimeout(timeoutHolder.value);
        signal?.removeEventListener("abort", abort);
        resolve({ exitCode, stdout, stderr, durationMs: Math.max(0, performance.now() - started), timedOut, truncated });
      };
      const stop = (timed: boolean): void => {
        if (settled) return;
        if (timed) timedOut = true;
        child?.kill("SIGTERM");
      };
      const abort = (): void => stop(true);
      const append = (current: string, chunk: Buffer): string => {
        const remaining = Math.max(0, this.maxOutputBytes - capturedBytes);
        if (chunk.byteLength > remaining) {
          truncated = true;
          stop(false);
          capturedBytes += remaining;
          return Buffer.concat([Buffer.from(current), chunk])
            .subarray(0, this.maxOutputBytes)
            .toString("utf8");
        }
        capturedBytes += chunk.byteLength;
        return current + chunk.toString("utf8");
      };

      if (signal?.aborted) {
        timedOut = true;
        finish(130);
        return;
      }
      try {
        const spawnSpec = getAutoSkillsSpawnSpec(process.platform, args);
        child = spawn(spawnSpec.executable, spawnSpec.args, {
          cwd,
          shell: false,
          windowsHide: !interactive,
          stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        stderr = error instanceof Error ? error.message : String(error);
        finish(1);
        return;
      }
      if (timeoutMs > 0) timeoutHolder.value = setTimeout(() => stop(true), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.once("error", (error: Error) => {
        stderr = error.message;
        finish(1);
      });
      child.once("close", (code: number | null) => finish(code ?? (timedOut || truncated ? 1 : 1)));
    });
  }
}

const processDenied = (message: string, path: string): SecurityError => ({
  code: "PROCESS_NOT_ALLOWED",
  message,
  path,
  recoverability: "none",
  suggestedAction: "Use only the approved official autoskills operation from the current project",
});

const securityException = (error: SecurityError): Error => {
  const exception = new Error(error.message);
  const details: Record<string, unknown> = { ...error };
  delete details.message;
  Object.assign(exception, details);
  return exception;
};

export const createRegisteredAutoSkillsProcessAdapter = (options?: AutoSkillsProcessOptions): RegisteredAutoSkillsProcessAdapter =>
  new RegisteredAutoSkillsProcessAdapter(options);
