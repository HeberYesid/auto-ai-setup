import type {
  CatalogSnapshot,
  CompatibilityDecision,
  ComponentAdapter,
  ComponentDefinition,
  ComponentProjection,
  ComponentProjectionResult,
  ConfirmedStack,
  ExternalOperation,
  FileChange,
  FileSystemPort,
  ProposedOperation,
  Result,
  RunId,
  SafeProjectPath,
  Sha256,
} from "../../domain/index.js";
import { asSafeProjectPath, err, evaluateCompatibility, ok } from "../../domain/index.js";
import type { CompatibilityInput } from "../../domain/catalog/models.js";
import type { SkillCatalogEntry } from "../../domain/catalog/models.js";
import { createHash } from "node:crypto";

export interface SelectedComponent {
  readonly definition: ComponentDefinition;
  readonly compatibility?: CompatibilityDecision;
  /** Required to project an incompatible component. */
  readonly incompatibleOverride?: boolean;
}

export interface ComponentInspectionInput {
  readonly root: import("../../domain/index.js").CanonicalPath;
  readonly stack: ConfirmedStack;
  readonly cliRecommendations?: readonly import("../../domain/index.js").CliRecommendation[];
  readonly runId: RunId;
  readonly selected: readonly SelectedComponent[];
  readonly catalog?: CatalogSnapshot;
}

export interface ComponentInspectionProjectionOptions {
  readonly adapters: readonly ComponentAdapter[];
  readonly fileSystem: FileSystemPort;
}

export interface ProjectionError {
  readonly code: "INVALID_PLAN" | "UNSUPPORTED_COMPONENT" | "CATALOG_SOURCE_MISMATCH";
  readonly message: string;
  readonly recoverability: "none";
  readonly componentId?: import("../../domain/index.js").ComponentId;
}

const sha256 = (value: string): Sha256 => createHash("sha256").update(value, "utf8").digest("hex") as Sha256;
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, child: unknown) => {
  if (child === null || typeof child !== "object" || Array.isArray(child)) return child;
  return Object.fromEntries(Object.entries(child as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
});
const originFor = (component: ComponentDefinition): string => component.source.kind === "catalog"
  ? `${component.source.origin}@${component.source.revision}`
  : component.source.origin;
const sensitiveKey = /(secret|token|password|credential|private.?key|authorization|api.?key)/i;
const sanitize = (value: unknown, key = ""): unknown => {
  if (typeof value === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) return value;
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
      .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, "$1[REDACTED]@");
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, sanitize(child, childKey)]));
  return value;
};
const safeOperation = (operation: ProposedOperation, component: ComponentDefinition, decision: CompatibilityDecision, override: boolean): FileChange => ({
  ...operation,
  origin: operation.origin ?? originFor(component),
  preview: sanitize(operation.preview) as FileChange["preview"],
  ...(override ? { incompatibleOverride: decision } : {}),
});
const canonicalComponent = (component: ComponentDefinition): string => stableJson({
  id: component.id,
  type: component.type,
  name: component.name,
  description: component.description,
  compatibility: component.compatibility,
  origin: originFor(component),
});
const skillTarget = (entry: SkillCatalogEntry): Result<SafeProjectPath, ProjectionError> => {
  const destination = asSafeProjectPath(`.kiro/skills/${entry.id}`);
  return destination.ok ? ok(destination.value) : err({ code: "INVALID_PLAN", message: destination.error.message, recoverability: "none" });
};
const skillOrigin = (entry: SkillCatalogEntry): string => `${entry.origin.repository}#${entry.origin.commit}/${entry.origin.relativePath}`;
const skillOperation = (component: ComponentDefinition, entry: SkillCatalogEntry, destination: SafeProjectPath): ExternalOperation => ({
  id: `skill-install:${component.id}` as ExternalOperation["id"],
  componentId: component.id,
  kind: "skill-install",
  command: ["npx", "autoskills", "install", entry.id],
  origin: skillOrigin(entry),
  destination,
  purpose: `Install the catalog Skill ${entry.name} through the official autoskills command.`,
  usesNetwork: true,
  expectedFiles: entry.files.map((file) => ({ path: `${destination}/${file.relativePath}`, size: file.size, sha256: file.sha256 })),
});

/**
 * Shared adapter coordinator. It performs inspection before projection and
 * treats managed state as metadata only; adapters remain the authority for
 * observed filesystem/configuration state.
 */
export class ComponentInspectionProjection {
  public constructor(private readonly options: ComponentInspectionProjectionOptions) {}

  public async project(input: ComponentInspectionInput): Promise<Result<ComponentProjectionResult, ProjectionError>> {
    const cliRecommendations = input.cliRecommendations ?? [];
    const compatibilityInput: CompatibilityInput = { stack: input.stack, cliRecommendations };
    const seen = new Set<string>();
    const components: ComponentProjection[] = [];
    const fileChanges: FileChange[] = [];
    const externalOperations: ExternalOperation[] = [];
    const warnings: { code: string; message: string; componentId?: import("../../domain/index.js").ComponentId }[] = [];

    for (const selection of input.selected) {
      const component = selection.definition;
      if (seen.has(component.id)) return err({ code: "INVALID_PLAN", message: `Duplicate component identity: ${component.id}`, recoverability: "none", componentId: component.id });
      seen.add(component.id);
      const decision = selection.compatibility ?? evaluateCompatibility(component.compatibility, compatibilityInput);
      const override = selection.incompatibleOverride === true;
      if (!decision.compatible && !override) {
        warnings.push({ code: "INCOMPATIBLE_COMPONENT", message: `Component ${component.id} was not projected because it is incompatible with the confirmed stack.`, componentId: component.id });
        continue;
      }

      const safeDefinition = sanitize(component) as ComponentDefinition;
      if (component.type === "skill") {
        const entry = input.catalog?.entries.find((candidate) => candidate.id === component.id);
        if (entry === undefined || entry.origin.repository !== "https://github.com/midudev/autoskills" || (component.source.kind === "catalog" && (component.source.origin !== entry.origin.repository || component.source.revision !== entry.origin.commit))) return err({ code: "CATALOG_SOURCE_MISMATCH", message: `Skill ${component.id} is not present in the presented autoskills catalog.`, recoverability: "none", componentId: component.id });
        const target = skillTarget(entry);
        if (!target.ok) return target;
        const present = await this.skillIsPresent(entry, target.value);
        const external = present ? [] : [skillOperation(component, entry, target.value)];
        const projection: ComponentProjection = { component: safeDefinition, compatibility: decision, incompatibleOverride: override, present, destinations: [target.value], fileChanges: [], externalOperations: external };
        components.push(projection);
        externalOperations.push(...external);
        continue;
      }

      const adapter = this.options.adapters.find((candidate) => candidate.supports(component));
      if (adapter === undefined) return err({ code: "UNSUPPORTED_COMPONENT", message: `No adapter supports component ${component.id} (${component.type}).`, recoverability: "none", componentId: component.id });
      const inspection = await adapter.inspect({ root: input.root, stack: input.stack }, component);
      const proposed = await adapter.propose({ root: input.root, stack: input.stack, runId: input.runId }, component);
      const changes = proposed.map((operation) => safeOperation(operation, component, decision, override));
      const destinations = [...new Set([...inspection.destinations, ...changes.map((change) => change.destination)])];
      const projection: ComponentProjection = { component: safeDefinition, compatibility: decision, incompatibleOverride: override, present: inspection.present, destinations, fileChanges: changes, externalOperations: [] };
      components.push(projection);
      fileChanges.push(...changes);
    }
    return ok({ components, fileChanges, externalOperations, warnings });
  }

  private async skillIsPresent(entry: SkillCatalogEntry, destination: SafeProjectPath): Promise<boolean> {
    for (const file of entry.files) {
      const path = asSafeProjectPath(`${destination}/${file.relativePath}`);
      if (!path.ok || !(await this.options.fileSystem.exists(path.value))) return false;
      const digest = createHash("sha256").update(await this.options.fileSystem.read(path.value)).digest("hex");
      if (digest.toLowerCase() !== file.sha256.toLowerCase()) return false;
    }
    return true;
  }
}

export const createComponentInspectionProjection = (options: ComponentInspectionProjectionOptions): ComponentInspectionProjection => new ComponentInspectionProjection(options);
export const ComponentInspector = ComponentInspectionProjection;
export const ComponentProjectionService = ComponentInspectionProjection;

/** Secret-free content identity used when creating a managed ownership record. */
export const componentContentDigest = (component: ComponentDefinition): Sha256 => sha256(canonicalComponent(component));
