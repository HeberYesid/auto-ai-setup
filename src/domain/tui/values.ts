import { err, ok, type Brand, type Result } from "../shared/types.js";
import { tuiError, type TuiError } from "./errors.js";

/**
 * Branded numeric value types for the TUI domain. Branding prevents raw numbers
 * from being used where a validated positive/non-negative integer is required.
 */
export type PositiveInteger = Brand<number, "PositiveInteger">;
export type NonNegativeInteger = Brand<number, "NonNegativeInteger">;

/** Validate and brand a positive integer (`> 0`), returning a classified error otherwise. */
export const asPositiveInteger = (value: number): Result<PositiveInteger, TuiError> => {
  if (!Number.isInteger(value) || value <= 0) {
    return err(tuiError("INVALID_INTEGER", `Expected a positive integer, received ${String(value)}`));
  }
  return ok(value as PositiveInteger);
};

/** Validate and brand a non-negative integer (`>= 0`), returning a classified error otherwise. */
export const asNonNegativeInteger = (value: number): Result<NonNegativeInteger, TuiError> => {
  if (!Number.isInteger(value) || value < 0) {
    return err(tuiError("INVALID_INTEGER", `Expected a non-negative integer, received ${String(value)}`));
  }
  return ok(value as NonNegativeInteger);
};

/** Type guard for a validated positive integer without allocating a Result. */
export const isPositiveInteger = (value: number): value is PositiveInteger => Number.isInteger(value) && value > 0;

/** Type guard for a validated non-negative integer without allocating a Result. */
export const isNonNegativeInteger = (value: number): value is NonNegativeInteger => Number.isInteger(value) && value >= 0;
