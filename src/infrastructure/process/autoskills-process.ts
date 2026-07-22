import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { ProcessExecutor, ProcessResult } from "../../domain/shared/ports.js";
import type { CanonicalPath } from "../../domain/shared/types.js";
import {
  AUTOSKILLS_INSTALL_TIMEOUT_MS,
  AUTOSKILLS_LIST_TIMEOUT_MS,
  AUTOSKILLS_MAX_OUTPUT_BYTES,
  type RegisteredAutoSkillsRequest,
} from "../../domain/catalog/autoskills.js";

export interface AutoSkillsProcessOptions {
  readonly maxOutputBytes?: number;
  readonly listTimeoutMs?: number;
  readonly installTimeoutMs?: number;
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

  public constructor(options: AutoSkillsProcessOptions = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? AUTOSKILLS_MAX_OUTPUT_BYTES;
    this.listTimeoutMs = options.listTimeoutMs ?? AUTOSKILLS_LIST_TIMEOUT_MS;
    this.installTimeoutMs = options.installTimeoutMs ?? AUTOSKILLS_INSTALL_TIMEOUT_MS;
  }

  public execute(request: RegisteredAutoSkillsRequest, signal?: AbortSignal): Promise<ProcessResult> {
    if (request.command !== "npx-autoskills" || request.authorized !== true || !this.validRequest(request)) {
      return Promise.reject(new Error("PROCESS_NOT_ALLOWED: invalid registered autoskills request"));
    }
    const interactive = request.operation === "interactive";
    if (!interactive) return Promise.reject(new Error("PROCESS_NOT_ALLOWED: autoskills supports only its interactive TUI"));
    const args = ["--yes", "autoskills", ...request.args];
    return this.run(request.cwd, args, 0, true, signal);
  }

  private validRequest(request: RegisteredAutoSkillsRequest): boolean {
    if (request.cwd.length === 0 || request.cwd.includes("\0") || !/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(request.cwd)) return false;
    return request.operation === "interactive" && request.args.length === 0;
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

export const createRegisteredAutoSkillsProcessAdapter = (options?: AutoSkillsProcessOptions): RegisteredAutoSkillsProcessAdapter =>
  new RegisteredAutoSkillsProcessAdapter(options);
