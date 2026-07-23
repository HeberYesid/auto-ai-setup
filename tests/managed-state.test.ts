import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ComponentDefinition, ComponentProjectionResult, ManagedState } from "../src/domain/index.js";
import {
  createFileSystemManagedStateStore,
  createFileSystemSkillOwnershipStore,
  createManagedStateOwnership,
  validateManagedState,
} from "../src/infrastructure/catalog/index.js";
import { FakeFileSystem } from "./support/fakes.js";

const digest = createHash("sha256").update("content").digest("hex");
const validState: ManagedState = {
  schemaVersion: 1,
  components: {
    "agent-rule:rule": { type: "agent-rule", origin: "builtin", destinations: [".kiro/rule.md"], contentDigest: digest } as never,
  },
  lastSuccessfulRunId: "run-0001" as never,
};

describe("managed state validation and persistence", () => {
  it("accepts a well-formed state and rejects invalid schema or components", () => {
    expect(validateManagedState(validState)).toMatchObject({ ok: true });
    expect(validateManagedState({ schemaVersion: 2, components: {}, lastSuccessfulRunId: "x" })).toMatchObject({ ok: false });
    expect(
      validateManagedState({
        schemaVersion: 1,
        components: { bad: { type: "unknown", origin: "", destinations: [], contentDigest: "" } },
        lastSuccessfulRunId: "run",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateManagedState({
        schemaVersion: 1,
        components: { bad: { type: "skill", origin: "o", destinations: ["../escape"], contentDigest: digest } },
        lastSuccessfulRunId: "run",
      }),
    ).toMatchObject({ ok: false });
  });

  it("round-trips through the filesystem store and reports missing, corrupt, and invalid state", async () => {
    const fileSystem = new FakeFileSystem();
    const store = createFileSystemSkillOwnershipStore(fileSystem);

    expect(await store.load()).toMatchObject({ ok: true, value: undefined });
    expect((await store.save(validState)).ok).toBe(true);
    expect(await store.load()).toMatchObject({ ok: true, value: { lastSuccessfulRunId: "run-0001" } });

    fileSystem.seed(".auto-ai-setup/state.json", "{not json");
    expect(await store.load()).toMatchObject({ ok: false, error: { code: "UNEXPECTED_ERROR" } });

    fileSystem.seed(".auto-ai-setup/state.json", JSON.stringify({ schemaVersion: 9 }));
    expect(await store.load()).toMatchObject({ ok: false });

    expect((await createFileSystemManagedStateStore(fileSystem).save(validState)).ok).toBe(true);
  });

  it("records a projection, redacts sensitive component fields, and preserves prior state", async () => {
    const fileSystem = new FakeFileSystem();
    const ownership = createManagedStateOwnership(createFileSystemSkillOwnershipStore(fileSystem));
    const component: ComponentDefinition = {
      id: "mcp" as never,
      type: "mcp-server",
      name: "MCP",
      description: "server",
      compatibility: { op: "always" },
      source: { kind: "builtin", origin: "test", token: "super-secret" } as never,
    };
    const projection = {
      components: [{ component, destinations: [".kiro/settings/mcp.json"] }],
    } as unknown as ComponentProjectionResult;

    const recorded = await ownership.recordSuccessfulProjection(projection, "run-0002" as never, validState);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) throw new Error("expected ok");
    expect(recorded.value.components["agent-rule:rule"]).toBeDefined();
    expect(Object.keys(recorded.value.components)).toContain("mcp-server:mcp");
    expect(JSON.stringify(recorded.value)).not.toContain("super-secret");
    expect(await ownership.load()).toMatchObject({ ok: true });
  });
});
