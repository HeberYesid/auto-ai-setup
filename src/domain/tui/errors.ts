import type { AppErrorBase, Result } from "../shared/types.js";

/**
 * Classified failure codes for the modern TUI domain and application boundaries.
 * The presentation layer never throws unclassified exceptions; every fallible
 * operation returns a {@link TuiResult} carrying one of these codes.
 */
export type TuiErrorCode =
  | "INVALID_INTEGER"
  | "INVALID_DIMENSION"
  | "INVALID_PROGRESS"
  | "INVALID_PROFILE"
  | "INVALID_SESSION_STATE"
  | "UNKNOWN_ACTION"
  | "PRESENTATION_TRANSITION_IMPOSSIBLE"
  | "REDACTION_INCOMPLETE"
  | "INVALID_RECOVERY_PATH"
  | "UNAVAILABLE_EFFECT"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_STALE"
  | "APPROVAL_CONFLICTED";

/** A typed, classified TUI error following the shared {@link AppErrorBase} shape. */
export interface TuiError extends AppErrorBase<TuiErrorCode> {
  readonly code: TuiErrorCode;
}

/** Result specialization used across the TUI domain and application boundaries. */
export type TuiResult<T> = Result<T, TuiError>;

/** Optional descriptive fields accepted when constructing a {@link TuiError}. */
export type TuiErrorDetails = Partial<Omit<TuiError, "code" | "message">>;

/** Construct a {@link TuiError}; defaults recoverability to `"none"` when omitted. */
export const tuiError = <Code extends TuiErrorCode>(
  code: Code,
  message: string,
  details: TuiErrorDetails = {},
): TuiError & { readonly code: Code } => {
  const { recoverability, cause, path, location, suggestedAction } = details;
  return {
    code,
    message,
    recoverability: recoverability ?? "none",
    ...(cause !== undefined ? { cause } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(suggestedAction !== undefined ? { suggestedAction } : {}),
  };
};
