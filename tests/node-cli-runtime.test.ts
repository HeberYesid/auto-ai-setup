import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultCliDependencies, NodeCliTerminal, runNodeCli } from "../src/infrastructure/process/node-cli-runtime.js";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("Node CLI runtime composition", () => {
  it("composes the real adapters and exposes a closable terminal", () => {
    const { terminal, dependencies } = createDefaultCliDependencies();
    try {
      expect(dependencies.session).toBeDefined();
      expect(dependencies.ui).toBeDefined();
      expect(dependencies.terminal).toBe(terminal);
      expect(typeof terminal.inputIsTTY).toBe("boolean");
      expect(typeof terminal.outputIsTTY).toBe("boolean");
      terminal.pauseInput();
      terminal.resumeInput();
    } finally {
      terminal.close();
    }
  });

  it("writes terminal lines and closes cleanly", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const terminal = new NodeCliTerminal();
    try {
      terminal.write("safe line");
      expect(write).toHaveBeenCalledWith("safe line\n");
    } finally {
      terminal.close();
    }
  });

  it("maps invalid CLI arguments without starting an interactive journey", async () => {
    await runNodeCli(["--unknown"]);
    expect(process.exitCode).toBe(2);
  });
});
