import { createInterface } from "node:readline/promises";
import { createRequire } from "node:module";
import { stdin, stdout, stderr } from "node:process";
import type { CanonicalPath } from "../../domain/index.js";
import {
  createAgentsRuleAdapter,
  createBuiltinAgentComponents,
  createKiroCommandAdapter,
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
import { createInteractiveUserInteraction, runCli, type CliDependencies } from "../../cli/index.js";
import type { CliTerminal } from "../../cli/terminal.js";

export class NodeCliTerminal implements CliTerminal {
  public readonly inputIsTTY = Boolean(stdin.isTTY);
  public readonly outputIsTTY = Boolean(stdout.isTTY);
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
  const ui = createInteractiveUserInteraction(terminal);
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
    projectionFactory: (root) => {
      const fileSystem = createRootFileSystem(root);
      return new ComponentInspectionProjection({
        fileSystem,
        adapters: [createKiroMcpWorkspaceAdapter(fileSystem), createAgentsRuleAdapter(fileSystem), createKiroCommandAdapter(fileSystem)],
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
  });
  return {
    terminal,
    dependencies: {
      session,
      ui,
      terminal,
      // Machine-readable mode writes exactly one fully prepared, redacted JSON value.
      stdout: (text: string) => {
        stdout.write(text);
      },
      // Diagnostics, usage, and version never contaminate the data stream.
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
