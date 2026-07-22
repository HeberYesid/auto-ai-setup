import type { ComponentDefinition, ManagedComponent, ManagedState } from "./models.js";
import type { RunId, SafeProjectPath, Sha256 } from "../shared/types.js";

export interface ManagedOwnershipInput {
  readonly component: Pick<ComponentDefinition, "id" | "type" | "source">;
  readonly destinations: readonly SafeProjectPath[];
  readonly contentDigest: Sha256;
}

/** Stable key shared by state, plans, and adapters. */
export const managedComponentKey = (component: Pick<ComponentDefinition, "id" | "type">): string => `${component.type}:${component.id}`;

export const managedComponentFrom = (input: ManagedOwnershipInput): ManagedComponent => ({
  type: input.component.type,
  origin: input.component.source.origin,
  ...(input.component.source.kind === "catalog" ? { sourceRevision: input.component.source.revision } : {}),
  destinations: [...new Set(input.destinations)],
  contentDigest: input.contentDigest,
});

/**
 * Merges only tool-owned component records. It never infers ownership from
 * paths and therefore cannot claim user-owned files as managed content.
 */
export const mergeManagedState = (
  previous: ManagedState | undefined,
  records: readonly ManagedOwnershipInput[],
  successfulRunId: RunId,
): ManagedState => {
  const components: Record<string, ManagedComponent> = { ...(previous?.components ?? {}) };
  for (const record of records) components[managedComponentKey(record.component)] = managedComponentFrom(record);
  return { schemaVersion: 1, components, lastSuccessfulRunId: successfulRunId };
};

export const managedStateOwns = (
  state: ManagedState | undefined,
  component: Pick<ComponentDefinition, "id" | "type" | "source">,
  destinations: readonly SafeProjectPath[],
  contentDigest: Sha256,
): boolean => {
  const owned = state?.components[managedComponentKey(component)];
  if (owned === undefined || owned.type !== component.type || owned.origin !== component.source.origin || owned.contentDigest !== contentDigest) return false;
  if (component.source.kind === "catalog" && owned.sourceRevision !== component.source.revision) return false;
  return owned.destinations.length === destinations.length && owned.destinations.every((destination) => destinations.includes(destination));
};
