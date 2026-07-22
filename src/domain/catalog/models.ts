import type { ComponentDefinition, CompatibilityDecision, CompatibilityExpression } from "../planning/models.js";
import type { ComponentId, Sha256 } from "../shared/types.js";
import type { InitialCli } from "../project/models.js";

export interface CatalogSnapshot {
  readonly schemaVersion: 1;
  readonly catalogId: string;
  readonly sourceRepository: "https://github.com/midudev/autoskills";
  readonly sourceCommit: string;
  readonly generatedAt: string;
  readonly entries: readonly SkillCatalogEntry[];
  readonly manifestDigest: Sha256;
}

export interface SkillCatalogEntry {
  readonly type: "skill";
  readonly id: ComponentId;
  readonly name: string;
  readonly description: string;
  readonly origin: {
    readonly repository: "https://github.com/midudev/autoskills";
    readonly commit: string;
    readonly relativePath: string;
  };
  readonly files: readonly { readonly relativePath: string; readonly size: number; readonly sha256: Sha256 }[];
  readonly compatibility: CompatibilityExpression;
  readonly destinationTemplate: ".kiro/skills/{id}";
}

export interface ComponentSelectionView {
  readonly components: readonly ComponentView[];
  /** Groups are ordered by the stable component type order. */
  readonly groups?: readonly ComponentGroup[];
}

export interface ComponentGroup {
  readonly type: ComponentDefinition["type"];
  readonly components: readonly ComponentView[];
}

export interface ComponentView {
  readonly definition: ComponentDefinition;
  readonly compatibility: CompatibilityDecision;
  readonly origin?: string;
  readonly incompatibleOverride?: "approved" | "rejected";
}

export interface RecommendationInput {
  readonly stack: import("../project/models.js").ConfirmedStack;
  readonly cliRecommendations: readonly import("../project/models.js").CliRecommendation[];
  readonly catalog?: CatalogSnapshot;
}

export interface CompatibilityInput {
  readonly stack: import("../project/models.js").ConfirmedStack;
  readonly cliRecommendations: readonly import("../project/models.js").CliRecommendation[];
}

export interface CliProbeResult {
  readonly cli: InitialCli;
  readonly status: "available" | "nonzero" | "invalid-version" | "timeout" | "overflow";
  readonly version?: string;
  readonly durationMs: number;
}
