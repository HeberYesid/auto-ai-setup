import { createHash } from "node:crypto";
import type { ComponentProjectionResult, ManagedState, Result, RunId, Sha256, SkillOwnershipStore } from "../../domain/index.js";
import { mergeManagedState } from "../../domain/index.js";
import type { ManagedOwnershipInput } from "../../domain/planning/ownership.js";
import type { ComponentDefinition } from "../../domain/index.js";

export interface ManagedStateOwnershipOptions {
  readonly digest?: (component: ComponentDefinition, projection: ComponentProjectionResult["components"][number]) => Sha256;
}

const sensitiveKey = /(secret|token|password|credential|private.?key|authorization|api.?key)/i;
const digestValue = (value: unknown, key = ""): unknown => {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => digestValue(item));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, child]) => [childKey, digestValue(child, childKey)]),
    );
  return value;
};
const defaultDigest = (component: ComponentDefinition): Sha256 =>
  createHash("sha256")
    .update(JSON.stringify(digestValue(component)), "utf8")
    .digest("hex") as Sha256;

/**
 * Coordinates tool-owned state persistence. The store is injected so this
 * service remains usable with a filesystem, transaction, or test adapter.
 * Call `recordSuccessfulProjection` only after the transaction commits.
 */
export class ManagedStateOwnership {
  private readonly digest: (component: ComponentDefinition, projection: ComponentProjectionResult["components"][number]) => Sha256;

  public constructor(
    private readonly store: SkillOwnershipStore,
    options: ManagedStateOwnershipOptions = {},
  ) {
    this.digest = options.digest ?? ((component) => defaultDigest(component));
  }

  public load(): Promise<Result<ManagedState | undefined>> {
    return this.store.load();
  }

  public async recordSuccessfulProjection(
    projection: ComponentProjectionResult,
    runId: RunId,
    previous?: ManagedState,
  ): Promise<Result<ManagedState>> {
    const loaded = previous === undefined ? await this.store.load() : { ok: true as const, value: previous };
    if (!loaded.ok) return loaded;
    const records: ManagedOwnershipInput[] = projection.components.map((item) => ({
      component: item.component,
      destinations: item.destinations,
      contentDigest: this.digest(item.component, item),
    }));
    const state = mergeManagedState(loaded.value, records, runId);
    const saved = await this.store.save(state);
    return saved.ok ? { ok: true, value: state } : saved;
  }
}

export const createManagedStateOwnership = (store: SkillOwnershipStore, options?: ManagedStateOwnershipOptions): ManagedStateOwnership =>
  new ManagedStateOwnership(store, options);
