import { describe, expect, it } from "vitest";
import {
  asCanonicalPath,
  asSafeProjectPath,
  type ProcessExecutor,
  type ProcessResult,
  type RegisteredProcessRequest,
} from "../src/domain/index.js";
import { MidudevAutoSkillsGateway } from "../src/infrastructure/catalog/autoskills-gateway.js";
import { RegisteredAutoSkillsProcessAdapter } from "../src/infrastructure/process/autoskills-process.js";

const root = asCanonicalPath("C:/workspace/project");
if (!root.ok) throw new Error(root.error.message);
const successful = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 2,
  timedOut: false,
  truncated: false,
  ...overrides,
});

class FakeExecutor implements ProcessExecutor {
  readonly requests: RegisteredProcessRequest[] = [];
  constructor(private readonly result: ProcessResult) {}
  async execute(request: RegisteredProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return this.result;
  }
}

describe("registered autoskills adapter", () => {
  it("requires authorization and executes only the official interactive TUI", async () => {
    const deniedExecutor = new FakeExecutor(successful());
    const denied = new MidudevAutoSkillsGateway(deniedExecutor, { root: root.value });
    expect((await denied.runInteractive()).ok).toBe(false);
    expect(deniedExecutor.requests).toHaveLength(0);

    const executor = new FakeExecutor(successful());
    const gateway = new MidudevAutoSkillsGateway(executor, { root: root.value, authorizeListing: () => true });
    expect((await gateway.runInteractive()).ok).toBe(true);
    expect(executor.requests[0]?.args).toEqual([]);
  });

  it("reports the real CLI limitation without spawning fake catalog commands", async () => {
    const executor = new FakeExecutor(successful());
    const gateway = new MidudevAutoSkillsGateway(executor, { root: root.value, authorizeListing: () => true });
    expect(await gateway.list()).toMatchObject({ ok: false, error: { code: "CATALOG_EXECUTION_FAILED" } });
    expect(await gateway.install({} as never, {} as never, asSafeProjectPath(".kiro/skills/test").value as never)).toMatchObject({
      ok: false,
      error: { code: "INSTALLATION_FAILED" },
    });
    expect(executor.requests).toHaveLength(0);
  });

  it("rejects non-interactive registered requests and supports cancellation before spawn", async () => {
    const adapter = new RegisteredAutoSkillsProcessAdapter();
    const invalid = {
      command: "npx-autoskills",
      operation: "list",
      args: ["list", "--json"],
      cwd: root.value,
      authorized: true,
    } as never;
    await expect(adapter.execute(invalid)).rejects.toThrow("PROCESS_NOT_ALLOWED");
    const controller = new AbortController();
    controller.abort();
    const request = { command: "npx-autoskills", operation: "interactive", args: [], cwd: root.value, authorized: true } as const;
    await expect(adapter.execute(request, controller.signal)).resolves.toMatchObject({ exitCode: 130, timedOut: true });
  });

  it("reports failures from the official interactive process", async () => {
    const executor = new FakeExecutor(successful({ exitCode: 1, stderr: "failed" }));
    const gateway = new MidudevAutoSkillsGateway(executor, { root: root.value, authorizeListing: () => true });
    expect(await gateway.runInteractive()).toMatchObject({ ok: false, error: { code: "CATALOG_EXECUTION_FAILED" } });
  });
});
