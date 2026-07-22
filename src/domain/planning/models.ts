import type { InitialCli, StackCategory, StackItem } from "../project/models.js";
import type { CanonicalPath, ComponentId, OperationId, RunId, SafeProjectPath, Sha256, RunMode } from "../shared/types.js";

export type CompatibilityExpression =
  | { readonly op: "stack"; readonly category: StackCategory; readonly oneOf: readonly string[] }
  | { readonly op: "cli"; readonly oneOf: readonly InitialCli[] }
  | { readonly op: "all" | "any"; readonly clauses: readonly CompatibilityExpression[] }
  | { readonly op: "not"; readonly clause: CompatibilityExpression }
  /** Alias for a negated conjunction, accepted for catalog compatibility. */
  | { readonly op: "noneOf"; readonly clauses: readonly CompatibilityExpression[] }
  | { readonly op: "always" };

export type ComponentType = "skill" | "mcp-server" | "agent-rule" | "agent-command";

export type ComponentSource =
  | { readonly kind: "catalog"; readonly origin: string; readonly revision: string; readonly digest: Sha256 }
  | { readonly kind: "builtin"; readonly origin: string };

export interface CompatibilityDecision {
  readonly compatible: boolean;
  readonly satisfied: readonly string[];
  readonly unsatisfied: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface ComponentDefinition {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly name: string;
  readonly description: string;
  /** Higher values are presented first within a component type. */
  readonly priority?: number;
  readonly compatibility: CompatibilityExpression;
  readonly source: ComponentSource;
}

export interface ProposedOperation {
  readonly id: string;
  readonly componentId: ComponentId;
  readonly destination: SafeProjectPath;
  readonly action: "create" | "modify" | "preserve" | "skip";
  readonly reason: string;
  readonly conflict: FileChange["conflict"];
  readonly preview: RedactedPreview | FieldDiff;
  readonly beforeDigest?: Sha256;
  readonly afterDigest?: Sha256;
  readonly incompatibleOverride?: CompatibilityDecision;
}

export type RedactedPreview = { readonly kind: "text"; readonly content: string; readonly truncated: boolean };
export type FieldDiff = { readonly kind: "fields"; readonly changes: readonly FieldChange[] };
export interface FieldChange {
  readonly path: string;
  readonly action: "add" | "remove" | "change";
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface ChangePlan {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly root: CanonicalPath;
  readonly mode: RunMode;
  readonly catalogDigest?: Sha256;
  readonly confirmedStackDigest: Sha256;
  readonly createdAt: string;
  readonly fileChanges: readonly FileChange[];
  readonly externalOperations: readonly ExternalOperation[];
  readonly warnings: readonly PlanWarning[];
  readonly planHash: Sha256;
}

export interface FileChange {
  readonly id: string;
  readonly componentId: ComponentId;
  readonly destination: SafeProjectPath;
  readonly action: "create" | "modify" | "preserve" | "skip";
  readonly reason: string;
  readonly conflict: "none" | "content-differs" | "invalid-managed-markers" | "ownership-unknown";
  readonly beforeDigest?: Sha256;
  readonly afterDigest?: Sha256;
  readonly preview: RedactedPreview | FieldDiff;
  readonly incompatibleOverride?: CompatibilityDecision;
}

export interface ExternalOperation {
  readonly id: OperationId;
  readonly componentId: ComponentId;
  readonly kind: "skill-install";
  readonly command: readonly string[];
  readonly origin: string;
  readonly destination: SafeProjectPath;
  readonly purpose: string;
  readonly usesNetwork: true;
  readonly expectedFiles: readonly { readonly path: string; readonly size: number; readonly sha256: Sha256 }[];
}

export interface PlanWarning {
  readonly code: string;
  readonly message: string;
  readonly componentId?: ComponentId;
}

export interface ApprovalDecisions {
  readonly planHash: Sha256;
  readonly globalApproved: boolean;
  readonly conflicts: Readonly<Record<string, "preserve" | "replace">>;
  readonly incompatibleComponents: readonly ComponentId[];
  readonly networkOperations: readonly OperationId[];
}

export interface ApprovedPlan extends ChangePlan {
  readonly approval: ApprovalDecisions;
  readonly approvedFileChangeIds: readonly string[];
  readonly approvedExternalOperationIds: readonly OperationId[];
}

export interface ManagedState {
  readonly schemaVersion: 1;
  readonly components: Readonly<Record<string, ManagedComponent>>;
  readonly lastSuccessfulRunId: RunId;
}

export interface ManagedComponent {
  readonly type: ComponentType;
  readonly origin: string;
  readonly sourceRevision?: string;
  readonly destinations: readonly SafeProjectPath[];
  readonly contentDigest: Sha256;
}

export interface RecoveryJournal {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly root: CanonicalPath;
  readonly planHash: Sha256;
  readonly phase: "preparing" | "prepared" | "committing" | "rolling-back" | "committed" | "rolled-back";
  readonly entries: readonly JournalEntry[];
  readonly manualReviewPaths: readonly SafeProjectPath[];
}

export interface JournalEntry {
  readonly operationId: string;
  readonly destination: SafeProjectPath;
  readonly prior: { readonly existed: false } | { readonly existed: true; readonly digest: Sha256; readonly backupPath: SafeProjectPath };
  readonly desiredDigest: Sha256;
  readonly status: "pending" | "backed-up" | "committed" | "restored" | "failed";
}

export interface ApprovalValidation {
  readonly approved: ApprovedPlan;
  readonly omittedFileChangeIds: readonly string[];
  readonly omittedExternalOperationIds: readonly OperationId[];
}

export const componentIdentity = (component: ComponentDefinition): string => `${component.type}:${component.id}`;
export const fileChangeIdentity = (change: FileChange): string => change.destination;
export const externalOperationIdentity = (operation: ExternalOperation): string => operation.id;

export const stackDigestInput = (items: readonly StackItem[]): string =>
  items.map((item) => `${item.category}:${item.id}:${item.confidence}`).sort().join("|");
