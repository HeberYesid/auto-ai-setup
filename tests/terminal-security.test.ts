import { describe, expect, it } from "vitest";
import { AUTOSKILLS_HANDOFF_NOTICE } from "../src/application/session/orchestrator.js";
import { InteractiveUserInteraction, type CliTerminal } from "../src/cli/terminal.js";
import type { ChangePlan, RedactedEvent } from "../src/domain/index.js";

class FakeTerminal implements CliTerminal {
  readonly inputIsTTY = true;
  readonly outputIsTTY = true;
  readonly lines: string[] = [];
  readonly prompts: string[] = [];

  public constructor(private readonly answers: string[] = []) {}

  async question(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.answers.shift() ?? "";
  }

  write(line: string): void {
    this.lines.push(line);
  }
}

const encodedOutput = (terminal: FakeTerminal): string => [...terminal.lines, ...terminal.prompts].join("\n");

const planWithSecret = (): ChangePlan =>
  ({
    schemaVersion: 1,
    runId: "run-terminal",
    root: "/virtual/project",
    mode: "manual",
    confirmedStackDigest: "0".repeat(64),
    createdAt: "2025-01-01T00:00:00.000Z",
    planHash: "a".repeat(64),
    fileChanges: [
      {
        id: "file:secret",
        componentId: "rule",
        destination: ".kiro/rule.md",
        action: "create",
        reason: "password=hunter2",
        conflict: "none",
        preview: { kind: "text", content: "token=terminal-secret", truncated: false },
      },
    ],
    externalOperations: [],
    warnings: [],
  }) as ChangePlan;

describe("terminal security boundary", () => {
  it("shows the complete independent autoskills disclosure before confirmation", async () => {
    const terminal = new FakeTerminal(["n"]);
    const ui = new InteractiveUserInteraction(terminal);

    await expect(ui.confirmExternal(["npx", "--yes", "autoskills"], AUTOSKILLS_HANDOFF_NOTICE)).resolves.toBe(false);

    const output = encodedOutput(terminal);
    expect(output).toContain("npx --yes autoskills");
    expect(output).toContain("Internet");
    expect(output).toContain("no aparecen en el plan");
    expect(output).toContain("rollback");
    expect(output).toContain("no puede ser redactada");
    expect(output.indexOf("Proceso externo independiente")).toBeLessThan(output.indexOf("¿Abrir ahora"));
  });
  it("redacts messages, verbose context, summaries, and plan previews before terminal output", async () => {
    const terminal = new FakeTerminal(["n"]);
    const ui = new InteractiveUserInteraction(terminal, true);
    const event = {
      runId: "run-terminal",
      timestamp: "2025-01-01T00:00:00.000Z",
      level: "error",
      category: "session",
      message: "token=message-secret",
      context: {
        status: "incomplete",
        exitCode: 3,
        token: "context-secret",
        warnings: ["Bearer warning-secret"],
        errors: ["password=error-secret"],
        manualReviewPaths: ["safe/path"],
      },
      redacted: true,
    } as RedactedEvent;

    ui.render(event);
    await ui.reviewPlan(planWithSecret());

    const output = encodedOutput(terminal);
    for (const secret of ["message-secret", "context-secret", "warning-secret", "error-secret", "hunter2", "terminal-secret"])
      expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("safe/path");
  });

  it("re-prompts invalid mode and invalid yes/no answers without accepting them", async () => {
    const terminal = new FakeTerminal(["unsupported", "auto", "maybe", "sí"]);
    const ui = new InteractiveUserInteraction(terminal);

    await expect(ui.chooseMode()).resolves.toBe("auto");
    await expect(ui.confirmExternal(["npx", "--yes", "autoskills"], AUTOSKILLS_HANDOFF_NOTICE)).resolves.toBe(true);

    expect(encodedOutput(terminal)).toContain("Modo inválido");
    expect(terminal.prompts.filter((prompt) => prompt.includes("¿Abrir ahora"))).toHaveLength(2);
  });
});

describe("terminal interaction branches", () => {
  it("covers target, stack conflict, selection, incompatibility, and recovery prompts", async () => {
    const terminal = new FakeTerminal(["", "1", "typescript", "rule, rule mcp", "sí", "n"]);
    const ui = new InteractiveUserInteraction(terminal, true);
    const conflicts = [
      {
        category: "language",
        candidates: [
          { category: "language", id: "typescript", displayName: "TypeScript", evidence: [] },
          { category: "language", id: "python", displayName: "Python", evidence: [] },
        ],
      },
    ] as never;

    await expect(ui.chooseTarget("C:/project")).resolves.toBe("C:/project");
    await expect(ui.resolveStackSelection(conflicts)).resolves.toEqual({ language: "typescript" });
    await expect(ui.resolveStack(conflicts)).resolves.toMatchObject({ items: [{ id: "typescript" }] });
    await expect(
      ui.selectComponents({
        components: [
          {
            definition: { id: "rule", type: "agent-rule", name: "Rule", description: "Safe rule" },
            compatibility: { compatible: false, satisfied: [], unsatisfied: ["missing tool"], evidenceRefs: ["package.json"] },
            origin: "builtin",
          },
        ],
        groups: [
          {
            type: "agent-rule",
            components: [
              {
                definition: { id: "rule", type: "agent-rule", name: "Rule", description: "Safe rule" },
                compatibility: { compatible: false, satisfied: [], unsatisfied: ["missing tool"], evidenceRefs: ["package.json"] },
                origin: "builtin",
              },
            ],
          },
        ],
        cliRecommendations: [],
      } as never),
    ).resolves.toEqual(["rule", "mcp"]);
    await expect(ui.confirmIncompatible({ name: "Rule" } as never, { unsatisfied: ["missing tool"] } as never)).resolves.toBe(true);
    await expect(ui.confirmRecovery({ runId: "run-recovery" } as never)).resolves.toBe(false);

    const output = encodedOutput(terminal);
    expect(output).toContain("Conflicto de Stack");
    expect(output).toContain("Reglas de agente");
    expect(output).toContain("incompatible: missing tool");
    expect(output).toContain("origen: builtin");
  });
  it("renders structured conflicts, CLI recommendations, external operations, and their approvals", async () => {
    const terminal = new FakeTerminal(["s", "s", "s"]);
    const ui = new InteractiveUserInteraction(terminal);
    const plan = {
      ...planWithSecret(),
      cliRecommendations: [
        {
          cli: "gh",
          reason: "GitHub Actions",
          technologies: ["github-actions"],
          evidenceRefs: [".github/workflows/ci.yml"],
          documentedInstructions: ["Consultar la documentación oficial"],
        },
      ],
      fileChanges: [
        {
          id: "file:conflict",
          componentId: "mcp",
          destination: ".kiro/settings/mcp.json",
          action: "modify",
          reason: "merge",
          conflict: "content",
          preview: {
            kind: "structured",
            changes: [{ path: "/mcpServers/demo", action: "add", before: undefined, after: { command: "demo" } }],
          },
        },
      ],
      externalOperations: [
        {
          id: "external:demo",
          componentId: "mcp",
          command: ["registered", "demo"],
          origin: "official",
          destination: ".staging/demo",
          purpose: "prepare",
          usesNetwork: true,
          expectedFiles: [],
        },
      ],
    } as unknown as ChangePlan;

    await expect(ui.reviewPlan(plan)).resolves.toMatchObject({
      globalApproved: true,
      conflicts: { "file:conflict": "replace" },
      networkOperations: ["external:demo"],
    });

    const output = encodedOutput(terminal);
    expect(output).toContain("CLI RECOMENDADA gh");
    expect(output).toContain("instrucción: Consultar");
    expect(output).toContain("add /mcpServers/demo");
    expect(output).toContain("EXTERNAL external:demo");
  });

  it("renders an empty plan without asking for global approval", async () => {
    const terminal = new FakeTerminal();
    const ui = new InteractiveUserInteraction(terminal);
    const empty = { ...planWithSecret(), fileChanges: [], externalOperations: [] } as ChangePlan;

    await expect(ui.reviewPlan(empty)).resolves.toMatchObject({ globalApproved: false, conflicts: {}, networkOperations: [] });
    expect(encodedOutput(terminal)).toContain("(sin cambios)");
    expect(terminal.prompts).toHaveLength(0);
  });
});
