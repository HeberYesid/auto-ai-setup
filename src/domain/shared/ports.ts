import type { CatalogSnapshot, SkillCatalogEntry } from "../catalog/models.js";
import type { DocumentStyle, JsonObject, ManagedPatch, ParsedConfig, SourceDocument, StructuredConfigCodec } from "../config/models.js";
import type {
  ApprovalDecisions,
  ApprovedPlan,
  ChangePlan,
  ComponentDefinition,
  ProposedOperation,
  RecoveryJournal,
} from "../planning/models.js";
import type { FileDescriptor, ScanPolicy, StackDetector, ConfirmedStack } from "../project/models.js";
import type { RedactedEvent, LocalEvent } from "../observability/models.js";
import type { AppError, CanonicalPath, ComponentId, ExitCode, Result, SafeProjectPath, RunId, RunMode } from "./types.js";

export interface SessionOrchestratorPort {
  run(input: SessionInput, ui: UserInteraction): Promise<import("../observability/models.js").ExecutionSummary>;
}

export interface SessionInput {
  readonly targetPath?: string;
  readonly mode?: string;
  readonly verbose: boolean;
  readonly recover: boolean;
  /**
   * Agents this run may configure, supplied non-interactively. When omitted the session asks the
   * user, and only falls back to footprint detection when the interaction cannot ask.
   */
  readonly agents?: readonly import("../agent/models.js").AgentId[];
}

/** Everything the user needs to choose which agents a run configures. */
export interface AgentSelectionView {
  /** Every agent this CLI can configure, in registry order. */
  readonly candidates: readonly import("../agent/models.js").AgentId[];
  /** Agents whose documented footprint already exists in the project. */
  readonly detected: readonly import("../agent/models.js").AgentId[];
}

export interface UserInteraction {
  chooseTarget(initial?: string): Promise<string>;
  resolveStack(conflicts: readonly import("../project/models.js").StackConflict[]): Promise<ConfirmedStack>;
  /** Optional selection-only resolver; the orchestrator confirms the full stack. */
  resolveStackSelection?(
    conflicts: readonly import("../project/models.js").StackConflict[],
  ): Promise<Readonly<Partial<Record<import("../project/models.js").StackCategory, string>>>>;
  chooseMode(initial?: string): Promise<RunMode>;
  /**
   * Chooses which agents the run configures. Optional so automated interactions, which never prompt,
   * keep their current behaviour; when it is absent the session falls back to footprint detection.
   */
  chooseAgents?(view: AgentSelectionView): Promise<readonly import("../agent/models.js").AgentId[]>;
  selectComponents(view: import("../catalog/models.js").ComponentSelectionView, mode?: RunMode): Promise<readonly ComponentId[]>;
  confirmIncompatible?(component: ComponentDefinition, decision: import("../planning/models.js").CompatibilityDecision): Promise<boolean>;
  confirmExternal?(command: readonly string[], purpose: string): Promise<boolean>;
  /** Temporarily releases stdin so an approved interactive child process can own the TTY. */
  pauseForExternalProcess?(): void;
  /** Restores stdin handling after an interactive child process exits. */
  resumeAfterExternalProcess?(): void;
  confirmRecovery?(journal: RecoveryJournal): Promise<boolean>;
  reviewPlan(plan: ChangePlan): Promise<ApprovalDecisions>;
  render(event: RedactedEvent): void;
}

export type ProjectEntryKind = "file" | "directory" | "symlink" | "other";

export interface ProjectEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly kind: ProjectEntryKind;
  readonly bytes?: number;
}

/** Filesystem effects required to validate a project; implementations must not follow child symlinks. */
export interface ProjectValidationPort {
  stat(path: string): Promise<ProjectEntryKind>;
  realpath(path: string): Promise<string>;
  enumerate(root: string): Promise<readonly ProjectEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  removeFile(path: string): Promise<void>;
}

export interface ProjectGateway {
  validateDirectory(path: string): Promise<Result<import("../project/models.js").ValidatedProject, import("./types.js").DirectoryError>>;
  inventory(root: CanonicalPath, policy: ScanPolicy): AsyncIterable<FileDescriptor>;
  readRecognized(
    path: SafeProjectPath,
    limit: import("./types.js").ByteCount,
  ): Promise<Result<Uint8Array, import("./types.js").DirectoryError>>;
}

export interface StackDetectorRegistry {
  readonly detectors: readonly StackDetector[];
  find(path: SafeProjectPath): readonly StackDetector[];
}

export interface SkillOwnershipStore {
  load(): Promise<Result<import("../planning/models.js").ManagedState | undefined>>;
  save(state: import("../planning/models.js").ManagedState): Promise<Result<void>>;
}

export interface AutoSkillsGateway {
  /** Runs the official interactive autoskills TUI in the user's terminal. */
  runInteractive?(): Promise<Result<void, import("./types.js").CatalogError>>;
  list(): Promise<Result<CatalogSnapshot, import("./types.js").CatalogError>>;
  install(
    entry: SkillCatalogEntry,
    approval: ExternalOperationApproval,
    target: SafeProjectPath,
    snapshot?: CatalogSnapshot,
  ): Promise<Result<InstalledArtifact, import("./types.js").InstallationError>>;
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
  /**
   * Optional batch projection for adapters whose components share a destination. Several components
   * writing the same file must collapse into a single operation, because a plan may hold at most one
   * action per destination. Callers fall back to `propose` when this is not implemented.
   */
  proposeAll?(ctx: PlanningContext, components: readonly D[]): Promise<readonly ProposedOperation[]>;
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
  /** Source revision paired with catalogDigest for stale/mismatched catalog detection. */
  readonly catalogSourceRevision?: string;
  /** Documentation-only recommendations; no process or network operation is created. */
  readonly cliRecommendations?: readonly import("../project/models.js").CliRecommendation[];
  readonly now: string;
}

export interface ApprovalPolicy {
  evaluate(plan: ChangePlan, decisions: ApprovalDecisions): Result<ApprovedPlan, import("./types.js").ApprovalError>;
}

export interface PathPolicy {
  resolveDestination(
    root: CanonicalPath,
    requested: import("./types.js").ProjectRelativePath,
  ): Promise<Result<SafeProjectPath, import("./types.js").PlanningError>>;
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
  request(
    operation: import("../planning/models.js").ExternalOperation,
    approval: ExternalOperationApproval,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, AppError>>;
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
