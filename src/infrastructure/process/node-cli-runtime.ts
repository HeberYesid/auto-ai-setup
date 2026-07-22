import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { CanonicalPath } from "../../domain/index.js";
import { createAgentsRuleAdapter, createKiroCommandAdapter, createKiroMcpWorkspaceAdapter } from "../agent/index.js";
import { createMidudevAutoSkillsGateway, createFileSystemSkillOwnershipStore } from "../catalog/index.js";
import { NodeProjectGateway, NodeTransactionalFileSystem } from "../fs/index.js";
import { createDefaultDetectorRegistry } from "../../domain/project/detectors.js";
import { createRegisteredAutoSkillsProcessAdapter } from "./autoskills-process.js";
import { PersistentTransactionEngine } from "../transaction/engine.js";
import { AutoSkillsInstallOperation } from "../transaction/autoskills-operation.js";
import type { TransactionOperation } from "../../domain/index.js";
import { ComponentInspectionProjection } from "../../application/session/component-inspection.js";
import { FileSystemRecoveryJournalReader, ProjectEvidenceStackAnalyzer, createSessionOrchestrator, type SessionTransactionContext } from "../../application/session/orchestrator.js";
import { createChangePlanner, ImmutableApprovalPolicy } from "../../domain/index.js";
import { createInteractiveUserInteraction, runCli, type CliDependencies } from "../../cli/index.js";
import type { CliTerminal } from "../../cli/terminal.js";

export class NodeCliTerminal implements CliTerminal {
  public readonly inputIsTTY = Boolean(stdin.isTTY);
  public readonly outputIsTTY = Boolean(stdout.isTTY);
  private readonly reader = createInterface({ input: stdin, output: stdout });
  public async question(prompt: string): Promise<string> { return this.reader.question(prompt); }
  public write(line: string): void { stdout.write(`${line}\n`); }
  public close(): void { this.reader.close(); }
}

const createRootFileSystem = (root: CanonicalPath): NodeTransactionalFileSystem => new NodeTransactionalFileSystem(root);

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
    componentDefinitions: [],
    planner: createChangePlanner(),
    approvalPolicy: new ImmutableApprovalPolicy(),
    projectionFactory: (root) => {
      const fileSystem = createRootFileSystem(root);
      return new ComponentInspectionProjection({ fileSystem, adapters: [createKiroMcpWorkspaceAdapter(fileSystem), createAgentsRuleAdapter(fileSystem), createKiroCommandAdapter(fileSystem)] });
    },
    transactionFactory: (root, context?: SessionTransactionContext) => {
      const fileSystem = createRootFileSystem(root);
      const operations = new Map<string, TransactionOperation>();
      if (context?.plan !== undefined && context.catalogGateway !== undefined && context.catalog !== undefined) {
        for (const operation of context.plan.externalOperations) {
          const entry = context.catalog.entries.find((candidate) => candidate.id === operation.componentId);
          if (entry !== undefined) operations.set(String(operation.id), new AutoSkillsInstallOperation(context.catalogGateway, fileSystem, operation, entry, context.catalog));
        }
      }
      return new PersistentTransactionEngine({ fileSystem, stateStore: createFileSystemSkillOwnershipStore(fileSystem), operations });
    },
    catalogFactory: (root) => {
      const fileSystem = createRootFileSystem(root);
      return createMidudevAutoSkillsGateway(processExecutor, { root, authorizeListing: () => true, fileSystem, ownershipStore: createFileSystemSkillOwnershipStore(fileSystem) });
    },
    recoveryFactory: (root) => new FileSystemRecoveryJournalReader(createRootFileSystem(root)),
  });
  return { terminal, dependencies: { session, ui, terminal } };
};

export const runNodeCli = async (args: readonly string[] = process.argv.slice(2)): Promise<void> => {
  const { terminal, dependencies } = createDefaultCliDependencies();
  try { process.exitCode = await runCli(args, dependencies); } finally { terminal.close(); }
};
