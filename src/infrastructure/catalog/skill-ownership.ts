import type { FileSystemPort, SkillOwnershipStore } from "../../domain/index.js";
import type { ManagedComponent, ManagedState } from "../../domain/planning/models.js";
import type { Result, SafeProjectPath } from "../../domain/shared/types.js";
import { asSafeProjectPath, asSha256, ok } from "../../domain/shared/types.js";

export const MANAGED_STATE_PATH = ".auto-ai-setup/state.json";

type ManagedStateError = {
  readonly code: "UNEXPECTED_ERROR";
  readonly message: string;
  readonly recoverability: "retry";
  readonly cause?: string;
};

const stateError = (message: string, cause?: string): Result<never, ManagedStateError> => ({
  ok: false,
  error: { code: "UNEXPECTED_ERROR", message, recoverability: "retry", ...(cause === undefined ? {} : { cause }) },
});
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const parseComponent = (value: unknown): value is ManagedComponent => {
  if (
    !isRecord(value) ||
    !["skill", "mcp-server", "agent-rule", "agent-command", "agent-hook"].includes(String(value.type)) ||
    !isNonEmptyString(value.origin) ||
    !Array.isArray(value.destinations) ||
    !isNonEmptyString(value.contentDigest)
  )
    return false;
  if (!asSha256(value.contentDigest).ok) return false;
  return value.destinations.every((destination) => typeof destination === "string" && asSafeProjectPath(destination).ok);
};

export const validateManagedState = (value: unknown): Result<ManagedState, ManagedStateError> => {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.components) || !isNonEmptyString(value.lastSuccessfulRunId))
    return stateError("Managed state has an invalid schema");
  const components: Record<string, ManagedComponent> = {};
  for (const [key, component] of Object.entries(value.components)) {
    if (!parseComponent(component)) return stateError(`Managed state has an invalid component: ${key}`);
    components[key] = component;
  }
  return ok({ schemaVersion: 1, components, lastSuccessfulRunId: value.lastSuccessfulRunId as ManagedState["lastSuccessfulRunId"] });
};

/** Persists only the tool-owned state file; it never enumerates or removes user content. */
export class FileSystemSkillOwnershipStore implements SkillOwnershipStore {
  private readonly statePathValue: SafeProjectPath;

  public constructor(private readonly fileSystem: FileSystemPort) {
    const statePath = asSafeProjectPath(MANAGED_STATE_PATH);
    if (!statePath.ok) throw new Error(statePath.error.message);
    this.statePathValue = statePath.value;
  }

  public async load(): Promise<Result<ManagedState | undefined>> {
    try {
      if (!(await this.fileSystem.exists(this.statePathValue))) return ok(undefined);
      const bytes = await this.fileSystem.read(this.statePathValue);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch (error) {
        return stateError("Managed state is not valid JSON", error instanceof Error ? error.message : String(error));
      }
      return validateManagedState(parsed);
    } catch (error) {
      return stateError("Unable to read managed state", error instanceof Error ? error.message : String(error));
    }
  }

  public async save(state: ManagedState): Promise<Result<void>> {
    const validated = validateManagedState(state);
    if (!validated.ok) return validated;
    const result = await this.fileSystem.write(
      this.statePathValue,
      new TextEncoder().encode(`${JSON.stringify(validated.value, null, 2)}\n`),
    );
    return result.ok ? ok(undefined) : result;
  }
}

export const createFileSystemSkillOwnershipStore = (fileSystem: FileSystemPort): FileSystemSkillOwnershipStore =>
  new FileSystemSkillOwnershipStore(fileSystem);
