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
  Sha256,
} from "../../domain/index.js";
import { err, evaluateCompatibility, ok } from "../../domain/index.js";
import type { CompatibilityInput } from "../../domain/catalog/models.js";
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

interface AdapterGroupMember {
  readonly component: ComponentDefinition;
  readonly safeDefinition: ComponentDefinition;
  readonly decision: CompatibilityDecision;
  readonly override: boolean;
}

interface AdapterGroup {
  readonly adapter: ComponentAdapter;
  readonly members: AdapterGroupMember[];
}

export interface ProjectionError {
  readonly code: "INVALID_PLAN" | "UNSUPPORTED_COMPONENT" | "CATALOG_SOURCE_MISMATCH";
  readonly message: string;
  readonly recoverability: "none";
  readonly componentId?: import("../../domain/index.js").ComponentId;
}

const sha256 = (value: string): Sha256 => createHash("sha256").update(value, "utf8").digest("hex") as Sha256;
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, child: unknown) => {
    if (child === null || typeof child !== "object" || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
  });
const originFor = (component: ComponentDefinition): string =>
  component.source.kind === "catalog" ? `${component.source.origin}@${component.source.revision}` : component.source.origin;
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
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, sanitize(child, childKey)]),
    );
  return value;
};
const safeOperation = (
  operation: ProposedOperation,
  component: ComponentDefinition,
  decision: CompatibilityDecision,
  override: boolean,
): FileChange => {
  // `content` is resolved destination bytes, not plan metadata: it must never reach the plan.
  const { content, ...rest } = operation;
  void content;
  return {
    ...rest,
    origin: operation.origin ?? originFor(component),
    preview: sanitize(operation.preview) as FileChange["preview"],
    ...(override ? { incompatibleOverride: decision } : {}),
  };
};
const canonicalComponent = (component: ComponentDefinition): string =>
  stableJson({
    id: component.id,
    type: component.type,
    name: component.name,
    description: component.description,
    compatibility: component.compatibility,
    origin: originFor(component),
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
    const fileContents = new Map<string, Uint8Array>();
    const warnings: { code: string; message: string; componentId?: import("../../domain/index.js").ComponentId }[] = [];
    const groups: AdapterGroup[] = [];

    for (const selection of input.selected) {
      const component = selection.definition;
      if (seen.has(component.id))
        return err({
          code: "INVALID_PLAN",
          message: `Duplicate component identity: ${component.id}`,
          recoverability: "none",
          componentId: component.id,
        });
      seen.add(component.id);
      const decision = selection.compatibility ?? evaluateCompatibility(component.compatibility, compatibilityInput);
      const override = selection.incompatibleOverride === true;
      if (!decision.compatible && !override) {
        warnings.push({
          code: "INCOMPATIBLE_COMPONENT",
          message: `Component ${component.id} was not projected because it is incompatible with the confirmed stack.`,
          componentId: component.id,
        });
        continue;
      }

      const safeDefinition = sanitize(component) as ComponentDefinition;
      if (component.type === "skill")
        return err({
          code: "CATALOG_SOURCE_MISMATCH",
          message: "autoskills no expone un catálogo estructurado ni instalación individual; selecciona Skills en su TUI oficial.",
          recoverability: "none",
          componentId: component.id,
        });

      const adapter = this.options.adapters.find((candidate) => candidate.supports(component));
      if (adapter === undefined)
        return err({
          code: "UNSUPPORTED_COMPONENT",
          message: `No adapter supports component ${component.id} (${component.type}).`,
          recoverability: "none",
          componentId: component.id,
        });
      const existing = groups.find((candidate) => candidate.adapter === adapter);
      const member: AdapterGroupMember = { component, safeDefinition, decision, override };
      if (existing === undefined) groups.push({ adapter, members: [member] });
      else existing.members.push(member);
    }

    for (const group of groups) {
      // Components served by one adapter may share a destination, and a plan admits at most one
      // action per destination. They are therefore projected together whenever the adapter supports
      // it; otherwise each component is projected alone, which is safe because its destinations are
      // then component-specific.
      const planningContext = { root: input.root, stack: input.stack, runId: input.runId };
      const projected: ProposedOperation[] = [];
      if (group.adapter.proposeAll === undefined) {
        for (const member of group.members) projected.push(...(await group.adapter.propose(planningContext, member.component)));
      } else {
        projected.push(
          ...(await group.adapter.proposeAll(
            planningContext,
            group.members.map((member) => member.component),
          )),
        );
      }
      const destinationsSeen = new Set<string>();
      for (const operation of projected) {
        if (destinationsSeen.has(String(operation.destination)))
          return err({
            code: "INVALID_PLAN",
            message: `An adapter projected more than one action for ${operation.destination}`,
            recoverability: "none",
          });
        destinationsSeen.add(String(operation.destination));
      }
      if (projected.length === 0)
        // An adapter yields nothing when it cannot interpret the current destination, for example a
        // configuration file the user broke by hand. The file is left untouched, but the omission
        // must be reported instead of finishing as a silent success.
        for (const member of group.members)
          warnings.push({
            code: "COMPONENT_NOT_PROJECTED",
            message: `El componente ${member.component.id} se omitió: su archivo de configuración destino no pudo interpretarse y se conserva sin cambios.`,
            componentId: member.component.id,
          });

      for (const member of group.members) {
        const owned = projected.filter((operation) => operation.componentId === member.component.id);
        const changes = owned.map((operation) => safeOperation(operation, member.component, member.decision, member.override));
        const inspection = await group.adapter.inspect({ root: input.root, stack: input.stack }, member.component);
        const destinations = [...new Set([...inspection.destinations, ...changes.map((change) => change.destination)])];
        components.push({
          component: member.safeDefinition,
          compatibility: member.decision,
          incompatibleOverride: member.override,
          present: inspection.present,
          destinations,
          fileChanges: changes,
          externalOperations: [],
        });
        fileChanges.push(...changes);
        for (const operation of owned)
          if (operation.content !== undefined) fileContents.set(operation.id, new TextEncoder().encode(operation.content));
      }
    }
    return ok({ components, fileChanges, externalOperations, warnings, fileContents });
  }
}

export const createComponentInspectionProjection = (options: ComponentInspectionProjectionOptions): ComponentInspectionProjection =>
  new ComponentInspectionProjection(options);
export const ComponentInspector = ComponentInspectionProjection;
export const ComponentProjectionService = ComponentInspectionProjection;

/** Secret-free content identity used when creating a managed ownership record. */
export const componentContentDigest = (component: ComponentDefinition): Sha256 => sha256(canonicalComponent(component));
