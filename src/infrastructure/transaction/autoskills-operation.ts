import type {
  AutoSkillsGateway,
  FileSystemPort,
  PreparedOperation,
  Result,
  TransactionOperation,
  TxContext,
  CommitReceipt,
  CatalogSnapshot,
  ExternalOperation,
  SkillCatalogEntry,
} from "../../domain/index.js";
import { asSafeProjectPath, err, ok } from "../../domain/index.js";

const failure = (message: string): import("../../domain/index.js").AppError => ({
  code: "INSTALLATION_FAILED",
  message,
  recoverability: "rollback",
});

/** Transaction operation for the only network-capable MVP action: approved autoskills install. */
export class AutoSkillsInstallOperation implements TransactionOperation {
  public constructor(
    private readonly gateway: AutoSkillsGateway,
    private readonly fileSystem: FileSystemPort,
    private readonly operation: ExternalOperation,
    private readonly entry: SkillCatalogEntry,
    private readonly snapshot: CatalogSnapshot,
  ) {}

  public async prepare(ctx: TxContext): Promise<Result<PreparedOperation>> {
    if (ctx.signal.aborted) return err(failure("Skill installation cancelled during prepare"));
    if (!ctx.plan.approval.networkOperations.includes(this.operation.id))
      return err(failure(`Network operation ${this.operation.id} was not explicitly approved`));
    const target = asSafeProjectPath(String(this.operation.destination));
    if (!target.ok) return target;
    const installed = await this.gateway.install(
      this.entry,
      { planHash: ctx.plan.planHash, operationId: this.operation.id, approved: true },
      target.value,
      this.snapshot,
    );
    if (!installed.ok) return err(failure(installed.error.message));
    return ok({ operationId: this.operation.id, destination: target.value });
  }

  public async verify(prepared: PreparedOperation): Promise<Result<void>> {
    return prepared.operationId === this.operation.id ? ok(undefined) : err(failure("Installed Skill operation identity mismatch"));
  }

  public async commit(prepared: PreparedOperation): Promise<Result<CommitReceipt>> {
    return ok({ operationId: prepared.operationId, destination: prepared.destination, created: true });
  }

  public async rollback(receipt: CommitReceipt): Promise<Result<void>> {
    const failures: string[] = [];
    for (const expected of this.operation.expectedFiles) {
      const path = asSafeProjectPath(expected.path);
      if (!path.ok) {
        failures.push(path.error.message);
        continue;
      }
      try {
        if (await this.fileSystem.exists(path.value)) {
          const removed = await this.fileSystem.remove(path.value);
          if (!removed.ok) failures.push(removed.error.message);
        }
      } catch (cause) {
        failures.push(cause instanceof Error ? cause.message : String(cause));
      }
    }
    return failures.length === 0 ? ok(undefined) : err(failure(`Rollback failed for ${receipt.operationId}: ${failures.join("; ")}`));
  }
}
