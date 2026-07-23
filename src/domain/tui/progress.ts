import type { NonNegativeInteger } from "./values.js";

/**
 * A validated progress representation. Determined progress carries non-negative
 * integer counts and a computed integer percentage; indeterminate progress carries
 * only an activity description.
 */
export type ProgressModel =
  | {
      readonly kind: "determined";
      readonly description: string;
      readonly completed: NonNegativeInteger;
      readonly total: NonNegativeInteger;
      readonly percent: NonNegativeInteger;
    }
  | {
      readonly kind: "indeterminate";
      readonly description: string;
    };

/**
 * A raw, not-yet-validated progress update as received from an activity source.
 * Validation (task 5.1) converts this into a {@link ProgressModel} or a classified
 * error while retaining the last valid representation.
 */
export type ProgressInput =
  | { readonly kind: "determined"; readonly description: string; readonly completed: number; readonly total: number }
  | { readonly kind: "indeterminate"; readonly description: string };
