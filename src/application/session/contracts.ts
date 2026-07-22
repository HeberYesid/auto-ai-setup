import type { ExecutionSummary } from "../../domain/observability/models.js";
import type { SessionInput, UserInteraction } from "../../domain/shared/ports.js";

export interface SessionService {
  run(input: SessionInput, ui: UserInteraction): Promise<ExecutionSummary>;
}

export type { SessionInput, UserInteraction };
