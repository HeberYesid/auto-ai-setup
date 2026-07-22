export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type CanonicalPath = Brand<string, "CanonicalPath">;
export type SafeProjectPath = Brand<string, "SafeProjectPath">;
export type ProjectRelativePath = Brand<string, "ProjectRelativePath">;
export type ComponentId = Brand<string, "ComponentId">;
export type Sha256 = Brand<string, "Sha256">;
export type ByteCount = Brand<number, "ByteCount">;
export type RunId = Brand<string, "RunId">;
export type OperationId = Brand<string, "OperationId">;

export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type Recoverability = "none" | "retry" | "rollback" | "manual-review";

export interface AppErrorBase<Code extends string> {
  readonly code: Code;
  readonly message: string;
  readonly cause?: string;
  readonly path?: string;
  readonly location?: string;
  readonly recoverability: Recoverability;
  readonly suggestedAction?: string;
}

export interface DirectoryError extends AppErrorBase<
  | "DIRECTORY_NOT_FOUND"
  | "NOT_DIRECTORY"
  | "REALPATH_FAILED"
  | "ENUMERATE_FAILED"
  | "READ_PROBE_FAILED"
  | "WRITE_PROBE_FAILED"
  | "DELETE_PROBE_FAILED"
> {
  readonly check: "exists" | "directory" | "realpath" | "enumerate" | "read" | "write" | "delete";
  readonly exitCode: 2;
  readonly code:
    | "DIRECTORY_NOT_FOUND"
    | "NOT_DIRECTORY"
    | "REALPATH_FAILED"
    | "ENUMERATE_FAILED"
    | "READ_PROBE_FAILED"
    | "WRITE_PROBE_FAILED"
    | "DELETE_PROBE_FAILED";
}

export interface EvidenceError extends AppErrorBase<"INVALID_SYNTAX" | "UNREADABLE_EVIDENCE" | "INVALID_SCHEMA"> {
  readonly code: "INVALID_SYNTAX" | "UNREADABLE_EVIDENCE" | "INVALID_SCHEMA";
  readonly path: string;
  readonly location: string;
}

export interface ConfigError extends AppErrorBase<"CONFIG_SYNTAX" | "CONFIG_SCHEMA" | "DANGEROUS_KEY" | "DUPLICATE_KEY" | "UNREPRESENTABLE_VALUE"> {
  readonly code: "CONFIG_SYNTAX" | "CONFIG_SCHEMA" | "DANGEROUS_KEY" | "DUPLICATE_KEY" | "UNREPRESENTABLE_VALUE";
  /** JSON Pointer to the invalid value or object member. */
  readonly path: string;
  /** Human-readable one-based `line:column` location. */
  readonly location: string;
  readonly line?: number;
  readonly column?: number;
  readonly recoverability: "none";
}

export interface StackConflictError extends AppErrorBase<"STACK_CONFLICT"> {
  readonly code: "STACK_CONFLICT";
  readonly category: string;
  readonly candidates: readonly string[];
}

export interface CliRecommendationError extends AppErrorBase<"CLI_RECOMMENDATION_UNAVAILABLE"> {
  readonly code: "CLI_RECOMMENDATION_UNAVAILABLE";
  readonly cli: string;
}

export interface CatalogError extends AppErrorBase<"CATALOG_EXECUTION_FAILED" | "CATALOG_INVALID_RESPONSE" | "CATALOG_SOURCE_MISMATCH"> {
  readonly code: "CATALOG_EXECUTION_FAILED" | "CATALOG_INVALID_RESPONSE" | "CATALOG_SOURCE_MISMATCH";
}

export interface InstallationError extends AppErrorBase<"INSTALLATION_FAILED" | "INSTALLATION_IDENTITY_MISMATCH" | "PARTIAL_ARTIFACTS"> {
  readonly code: "INSTALLATION_FAILED" | "INSTALLATION_IDENTITY_MISMATCH" | "PARTIAL_ARTIFACTS";
}

export interface CompatibilityError extends AppErrorBase<"INCOMPATIBLE_COMPONENT"> {
  readonly code: "INCOMPATIBLE_COMPONENT";
  readonly componentId: ComponentId;
  readonly unsatisfied: readonly string[];
}

export interface PlanningError extends AppErrorBase<"UNSAFE_DESTINATION" | "INVALID_PLAN" | "STALE_PLAN" | "INVALID_CONFIGURATION"> {
  readonly code: "UNSAFE_DESTINATION" | "INVALID_PLAN" | "STALE_PLAN" | "INVALID_CONFIGURATION";
}

export interface ApprovalError extends AppErrorBase<"PLAN_HASH_MISMATCH" | "MISSING_APPROVAL" | "UNAPPROVED_NETWORK_OPERATION" | "APPROVAL_SUBSET_INVALID"> {
  readonly code: "PLAN_HASH_MISMATCH" | "MISSING_APPROVAL" | "UNAPPROVED_NETWORK_OPERATION" | "APPROVAL_SUBSET_INVALID";
}

export interface CommitError extends AppErrorBase<"BACKUP_FAILED" | "WRITE_FAILED" | "VERIFY_FAILED" | "RENAME_FAILED"> {
  readonly code: "BACKUP_FAILED" | "WRITE_FAILED" | "VERIFY_FAILED" | "RENAME_FAILED";
}

export interface RecoveryError extends AppErrorBase<"BACKUP_MISSING" | "RESTORE_FAILED" | "RECOVERY_INCOMPLETE"> {
  readonly code: "BACKUP_MISSING" | "RESTORE_FAILED" | "RECOVERY_INCOMPLETE";
}

export interface SecurityError extends AppErrorBase<"NETWORK_DENIED" | "PROCESS_NOT_ALLOWED" | "SECRET_REDACTION_FAILED"> {
  readonly code: "NETWORK_DENIED" | "PROCESS_NOT_ALLOWED" | "SECRET_REDACTION_FAILED";
}

export interface UnexpectedError extends AppErrorBase<"UNEXPECTED_ERROR"> {
  readonly code: "UNEXPECTED_ERROR";
}

export type AppError =
  | DirectoryError
  | EvidenceError
  | StackConflictError
  | CliRecommendationError
  | CatalogError
  | ConfigError
  | InstallationError
  | CompatibilityError
  | PlanningError
  | ApprovalError
  | CommitError
  | RecoveryError
  | SecurityError
  | UnexpectedError;

export type RunMode = "auto" | "manual";
export type ExitCode = 0 | 1 | 2 | 3;
export type TerminalExecutionStatus = "success" | "cancelled" | "failed-recovered" | "incomplete" | "invalid-input";

export const exitCodeForStatus = (status: TerminalExecutionStatus): ExitCode => {
  switch (status) {
    case "success":
    case "cancelled":
      return 0;
    case "failed-recovered":
      return 1;
    case "invalid-input":
      return 2;
    case "incomplete":
      return 3;
  }
};

const absolutePathPattern = /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/;

export const asCanonicalPath = (value: string): Result<CanonicalPath, PlanningError> => {
  if (value.length === 0 || !absolutePathPattern.test(value) || value.includes("\0")) {
    return err({ code: "INVALID_PLAN", message: "Canonical path must be an absolute, non-empty path", recoverability: "none", path: value });
  }
  return ok(value as CanonicalPath);
};

export const asProjectRelativePath = (value: string): Result<ProjectRelativePath, PlanningError> => {
  if (!isSafeRelativePath(value)) {
    return err({ code: "UNSAFE_DESTINATION", message: "Destination must be a safe project-relative path", recoverability: "none", path: value });
  }
  return ok(value as ProjectRelativePath);
};

export const asSafeProjectPath = (value: string): Result<SafeProjectPath, PlanningError> => {
  const relative = asProjectRelativePath(value);
  return relative.ok ? ok(relative.value as unknown as SafeProjectPath) : { ok: false, error: relative.error };
};

export const asComponentId = (value: string): Result<ComponentId, PlanningError> => {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
    return err({ code: "INVALID_PLAN", message: "Component id is empty or contains unsafe characters", recoverability: "none", path: value });
  }
  return ok(value as ComponentId);
};

export const asSha256 = (value: string): Result<Sha256, PlanningError> => {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    return err({ code: "INVALID_PLAN", message: "Expected a SHA-256 hexadecimal digest", recoverability: "none", path: value });
  }
  return ok(value.toLowerCase() as Sha256);
};

export const isSafeRelativePath = (value: string): boolean => {
  if (value.length === 0 || value.includes("\0") || value.includes("\\") || absolutePathPattern.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && !/^[A-Za-z]:$/.test(part));
};

export const isLexicallyContained = (root: CanonicalPath, destination: SafeProjectPath): boolean => {
  const normalizedRoot = root.replace(/[\\/]+$/, "").replaceAll("\\", "/");
  const normalizedDestination = destination.replaceAll("\\", "/");
  return normalizedDestination === normalizedRoot || normalizedDestination.startsWith(`${normalizedRoot}/`);
};

export const unique = <T>(values: readonly T[], key: (value: T) => string): boolean => {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
  }
  return true;
};
