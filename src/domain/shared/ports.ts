import type { CatalogSnapshot, SkillCatalogEntry } from "../catalog/models.js";
import type { DocumentStyle, JsonObject, ManagedPatch, ParsedConfig, SourceDocument, StructuredConfigCodec } from "../config/models.js";
import type { ApprovalDecisions, ApprovedPlan, ChangePlan, ComponentDefinition, ProposedOperation, RecoveryJournal } from "../planning/models.js";
import type { FileDescriptor, ScanPolicy, StackDetector, ConfirmedStack } from "../project/models.js";
import type { RedactedEvent, LocalEvent } from "../observability/models.js";
import type {
  AppError,
  CanonicalPath,
  ComponentId,
  ExitCode,
  Result,
  SafeProjectPath,
  RunId,
  RunMode,
} from "./types.js";

export interface SessionOrchestrator {
  run(input: SessionInput, ui: UserInteraction): Promise<import("../observability/models.js").ExecutionSummary>;
}

export interface SessionInput {
  readonly targetPath?: string;
  readonly mode?: string;
  readonly verbose: boolean;
  readonly recover: boolean;
}

export interface UserInteraction {
  chooseTarget(initial?: string): Promise<string>;
  resolveStack(conflicts: readonly import("../project/models.js").StackConflict[]): Promise<ConfirmedStack>;
  chooseMode(initial?: string): Promise<RunMode>;
  selectComponents(view: import("../catalog/models.js").ComponentSelectionView): Promise<readonly ComponentId[]>;
  reviewPlan(plan: ChangePlan): Promise<ApprovalDecisions>;
  render(event: RedactedEvent): void;
}

export interface ProjectGateway {
  validateDirectory(path: string): Promise<Result<import("../project/models.js").ValidatedProject, import("./types.js").DirectoryError>>;
  inventory(root: CanonicalPath, policy: ScanPolicy): AsyncIterable<FileDescriptor>;
  readRecognized(path: SafeProjectPath, limit: import("./types.js").ByteCount): Promise<Result<Uint8Array, import("./types.js").DirectoryError>>;
}

export interface StackDetectorRegistry {
  readonly detectors: readonly StackDetector[];
  find(path: SafeProjectPath): readonly StackDetector[];
}

export interface AutoSkillsGateway {
  list(): Promise<Result<CatalogSnapshot, import("./types.js").CatalogError>>;
  install(entry: SkillCatalogEntry, approval: ExternalOperationApproval, target: SafeProjectPath): Promise<Result<InstalledArtifact, import("./types.js").InstallationError>>;
}

export interface InstalledArtifact {
  readonly componentId: ComponentId;
  readonly destination: SafeProjectPath;
  readonly files: readonly string[];
  readonly digest: import("./types.js").Sha256;
}

export interface ExternalOperationApproval {
  readonly planHash: import("./types.js").Sha256;
  readonly operationId: string;
  readonly approved: true;
}

export interface ComponentAdapter<D extends ComponentDefinition = ComponentDefinition> {
  supports(component: D): boolean;
  inspect(ctx: InspectionContext, component: D): Promise<CurrentComponentState>;
  propose(ctx: PlanningContext, component: D): Promise<readonly ProposedOperation[]>;
  verify(ctx: VerificationContext, operation: ProposedOperation): Promise<Result<void>>;
}

export interface InspectionContext {
  readonly root: CanonicalPath;
  readonly stack: ConfirmedStack;
}
export interface PlanningContext extends InspectionContext {
  readonly runId: RunId;
}
export interface VerificationContext extends PlanningContext {
  readonly planHash: import("./types.js").Sha256;
}
export interface CurrentComponentState {
  readonly present: boolean;
  readonly digest?: import("./types.js").Sha256;
  readonly destinations: readonly SafeProjectPath[];
}

export interface ChangePlanner {
  build(input: PlanningInput): Promise<Result<ChangePlan, import("./types.js").PlanningError>>;
}
export interface PlanningInput {
  readonly runId: RunId;
  readonly root: CanonicalPath;
  readonly mode: RunMode;
  readonly stack: ConfirmedStack;
  readonly components: readonly ComponentDefinition[];
  readonly fileChanges: readonly import("../planning/models.js").FileChange[];
  readonly externalOperations: readonly import("../planning/models.js").ExternalOperation[];
  readonly catalogDigest?: import("./types.js").Sha256;
  readonly now: string;
}

export interface ApprovalPolicy {
  evaluate(plan: ChangePlan, decisions: ApprovalDecisions): Result<ApprovedPlan, import("./types.js").ApprovalError>;
}

export interface PathPolicy {
  resolveDestination(root: CanonicalPath, requested: import("./types.js").ProjectRelativePath): Promise<Result<SafeProjectPath, import("./types.js").PlanningError>>;
}

export interface TransactionEngine {
  apply(plan: ApprovedPlan, signal: AbortSignal): Promise<TransactionResult>;
  recover(journal: RecoveryJournal): Promise<RecoveryResult>;
}

export interface TransactionResult {
  readonly status: "committed" | "rolled-back" | "incomplete";
  readonly exitCode: ExitCode;
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly manualReviewPaths: readonly SafeProjectPath[];
  readonly journal?: RecoveryJournal;
}

export interface RecoveryResult {
  readonly status: "restored" | "incomplete";
  readonly exitCode: 1 | 3;
  readonly restored: readonly string[];
  readonly manualReviewPaths: readonly SafeProjectPath[];
  readonly errors: readonly string[];
}

export interface TransactionOperation {
  prepare(ctx: TxContext): Promise<Result<PreparedOperation>>;
  verify(prepared: PreparedOperation): Promise<Result<void>>;
  commit(prepared: PreparedOperation): Promise<Result<CommitReceipt>>;
  rollback(receipt: CommitReceipt): Promise<Result<void>>;
}
export interface TxContext {
  readonly plan: ApprovedPlan;
  readonly signal: AbortSignal;
}
export interface PreparedOperation {
  readonly operationId: string;
  readonly destination: SafeProjectPath;
  readonly desiredDigest?: import("./types.js").Sha256;
}
export interface CommitReceipt {
  readonly operationId: string;
  readonly destination: SafeProjectPath;
  readonly created: boolean;
  readonly previousDigest?: import("./types.js").Sha256;
}

export interface EventSink {
  emit(event: RedactedEvent): void;
}
export interface EventFactory {
  create(input: Omit<LocalEvent, "timestamp">): RedactedEvent;
}

export interface Clock {
  now(): string;
  monotonicMs(): number;
}
export interface UuidGenerator {
  next(): RunId;
}

export interface FileSystemPort {
  exists(path: SafeProjectPath): Promise<boolean>;
  read(path: SafeProjectPath): Promise<Uint8Array>;
  write(path: SafeProjectPath, content: Uint8Array): Promise<Result<void>>;
  remove(path: SafeProjectPath): Promise<Result<void>>;
  list(root: CanonicalPath): AsyncIterable<FileDescriptor>;
}

export interface ProcessExecutor {
  execute(request: RegisteredProcessRequest, signal?: AbortSignal): Promise<ProcessResult>;
}
export interface RegisteredProcessRequest {
  readonly command: "npx-autoskills";
  readonly args: readonly ("list" | "install")[] | readonly string[];
  readonly cwd: CanonicalPath;
}
export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export interface NetworkGateway {
  request(operation: import("../planning/models.js").ExternalOperation, approval: ExternalOperationApproval, signal?: AbortSignal): Promise<Result<Uint8Array, AppError>>;
}

export interface Redactor {
  redact(value: unknown, knownSecrets?: readonly string[]): unknown;
}

export interface JsonCodecPort<T extends JsonObject> extends StructuredConfigCodec<T> {
  parse(source: SourceDocument): Result<ParsedConfig<T>, import("../config/models.js").ConfigError>;
  merge(model: T, patch: ManagedPatch): Result<T, import("../config/models.js").ConfigError>;
  serialize(model: T, style: DocumentStyle): Result<string, import("../config/models.js").ConfigError>;
}

export type PortError = AppError;
