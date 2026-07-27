import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { stdin, stdout, stderr, env } from "node:process";
import type { CanonicalPath } from "../../domain/index.js";
import {
  createAgentTargetResolver,
  createFixedAgentTargetResolver,
  createClaudeCodeCommandAdapter,
  createClaudeCodeHookAdapter,
  createClaudeCodeMcpAdapter,
  createClaudeRulesAdapter,
  createCodexHookAdapter,
  createCodexMcpAdapter,
  createKiroSteeringAdapter,
  createOpenCodeCommandAdapter,
  createOpenCodeMcpAdapter,
  createSharedAgentsRuleAdapter,
  createBuiltinAgentComponents,
  createKiroCommandAdapter,
  createKiroHookAdapter,
  createKiroMcpWorkspaceAdapter,
} from "../agent/index.js";
import { createMidudevAutoSkillsGateway, createFileSystemSkillOwnershipStore } from "../catalog/index.js";
import { NodeProjectGateway, NodeTransactionalFileSystem } from "../fs/index.js";
import { createDefaultDetectorRegistry } from "../../domain/project/detectors.js";
import { createRegisteredAutoSkillsProcessAdapter } from "./autoskills-process.js";
import { PersistentTransactionEngine } from "../transaction/engine.js";
import { ComponentInspectionProjection } from "../../application/session/component-inspection.js";
import {
  FileSystemRecoveryJournalReader,
  ProjectEvidenceStackAnalyzer,
  createSessionOrchestrator,
} from "../../application/session/orchestrator.js";
import { createChangePlanner, ImmutableApprovalPolicy } from "../../domain/index.js";
import { createInteractiveUserInteraction, runCli, type CliDependencies, type CliInteractionPreferences } from "../../cli/index.js";
import type { CliTerminal } from "../../cli/terminal.js";
import type { UserInteraction } from "../../application/session/contracts.js";

export class NodeCliTerminal implements CliTerminal {
  public readonly inputIsTTY = Boolean(stdin.isTTY);
  public readonly outputIsTTY = Boolean(stdout.isTTY);
  public get columns(): number | undefined {
    return typeof stdout.columns === "number" ? stdout.columns : undefined;
  }
  private readonly reader = createInterface({ input: stdin, output: stdout });
  public async question(prompt: string): Promise<string> {
    return this.reader.question(prompt);
  }
  public write(line: string): void {
    stdout.write(`${line}\n`);
  }
  public pauseInput(): void {
    this.reader.pause();
  }
  public resumeInput(): void {
    this.reader.resume();
  }
  public close(): void {
    this.reader.close();
  }
}

const createRootFileSystem = (root: CanonicalPath): NodeTransactionalFileSystem => new NodeTransactionalFileSystem(root);

/** Reads the published version from the package manifest that ships next to `dist/`. */
const packageVersion = (): string | undefined => {
  try {
    const manifest = createRequire(import.meta.url)("../../../package.json") as { readonly version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
};

export const createDefaultCliDependencies = (): { readonly terminal: NodeCliTerminal; readonly dependencies: CliDependencies } => {
  const terminal = new NodeCliTerminal();
  // Styling is a presentation preference resolved once, here at the composition root: a live output
  // TTY that has not opted out through NO_COLOR / TERM=dumb. Everything downstream stays plain text.
  const noColor = (env.NO_COLOR ?? "").length > 0 || env.TERM === "dumb";
  const presentation = {
    color: terminal.outputIsTTY && !noColor,
    unicode: /utf-?8/iu.test(env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "") || (env.WT_SESSION ?? "").length > 0,
  };
  // The interaction is built after the invocation is parsed, so `--verbose` reaches the renderer
  // instead of being fixed at composition time.
  const createUi = (preferences: CliInteractionPreferences): UserInteraction =>
    createInteractiveUserInteraction(terminal, preferences.verbose, presentation);
  const projectGateway = new NodeProjectGateway();
  const registry = createDefaultDetectorRegistry();
  const processExecutor = createRegisteredAutoSkillsProcessAdapter();
  const stackAnalyzer = new ProjectEvidenceStackAnalyzer(projectGateway, registry);
  const session = createSessionOrchestrator({
    projectGateway,
    stackAnalyzer,
    componentDefinitions: createBuiltinAgentComponents(),
    planner: createChangePlanner(),
    approvalPolicy: new ImmutableApprovalPolicy(),
    projectionFactory: (root, agents) => {
      const fileSystem = createRootFileSystem(root);
      // One resolver per projection: the target agents must be identical for every adapter in a run,
      // otherwise the plan would not be deterministic. An explicit user selection is honoured as-is;
      // only without one does the run fall back to detecting footprints.
      const targets = agents === undefined ? createAgentTargetResolver(fileSystem) : createFixedAgentTargetResolver(agents);
      return new ComponentInspectionProjection({
        fileSystem,
        adapters: [
          createKiroMcpWorkspaceAdapter(fileSystem, undefined, targets),
          createClaudeCodeMcpAdapter(fileSystem, targets),
          createCodexMcpAdapter(fileSystem, targets),
          createOpenCodeMcpAdapter(fileSystem, targets),
          createSharedAgentsRuleAdapter(fileSystem, targets),
          createClaudeRulesAdapter(fileSystem, targets),
          createKiroSteeringAdapter(fileSystem, targets),
          createKiroCommandAdapter(fileSystem, undefined, targets),
          createClaudeCodeCommandAdapter(fileSystem, targets),
          createOpenCodeCommandAdapter(fileSystem, targets),
          createKiroHookAdapter(fileSystem, undefined, targets),
          createClaudeCodeHookAdapter(fileSystem, targets),
          createCodexHookAdapter(fileSystem, targets),
        ],
      });
    },
    transactionFactory: (root, context) => {
      const fileSystem = createRootFileSystem(root);
      return new PersistentTransactionEngine({
        fileSystem,
        stateStore: createFileSystemSkillOwnershipStore(fileSystem),
        componentDefinitions: createBuiltinAgentComponents(),
        // Without the resolved contents the engine has no implementation for an approved file
        // operation and the whole transaction fails closed.
        ...(context?.fileContents === undefined ? {} : { fileContents: context.fileContents }),
      });
    },
    catalogFactory: (root) => {
      const fileSystem = createRootFileSystem(root);
      return createMidudevAutoSkillsGateway(processExecutor, {
        root,
        authorizeListing: () => true,
        fileSystem,
        ownershipStore: createFileSystemSkillOwnershipStore(fileSystem),
      });
    },
    recoveryFactory: (root) => new FileSystemRecoveryJournalReader(createRootFileSystem(root)),
    // Detection only preselects the interactive answer, so the fallback is empty: "nothing detected"
    // must be reported as such instead of as "every agent".
    agentDetector: async (root) => [...(await createAgentTargetResolver(createRootFileSystem(root), []).targets())],
  });
  return {
    terminal,
    dependencies: {
      session,
      createUi,
      terminal,
      // Machine-readable mode writes exactly one fully prepared, redacted JSON value; usage and
      // version answers also belong to stdout because the user asked for them.
      stdout: (text: string) => {
        stdout.write(text);
      },
      // Diagnostics never contaminate the data stream.
      stderr: (text: string) => {
        stderr.write(text);
      },
      version: packageVersion() ?? "desconocida",
    },
  };
};

export const runNodeCli = async (args: readonly string[] = process.argv.slice(2)): Promise<void> => {
  const { terminal, dependencies } = createDefaultCliDependencies();
  try {
    process.exitCode = await runCli(args, dependencies);
  } finally {
    terminal.close();
  }
};
