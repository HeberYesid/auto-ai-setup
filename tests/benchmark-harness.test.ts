import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateFixture, loadFixture, runBenchmark, summarize, validateFixtureSpec } from "../src/infrastructure/benchmark/index.js";
import { FIXTURE_SCHEMA_VERSION } from "../src/infrastructure/benchmark/models.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("versioned benchmark fixtures", () => {
  it("generates and loads exact in-profile files while excluding dependency trees", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-ai-setup-benchmark-"));
    roots.push(root);
    const generated = await generateFixture(join(root, "fixture"), {
      id: "small",
      fileCount: 4,
      totalBytes: 400,
      seed: 7,
      excludedFileCount: 2,
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.schemaVersion).toBe(FIXTURE_SCHEMA_VERSION);
    const loaded = await loadFixture(join(root, "fixture"));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.manifest.fileCount).toBe(4);
    expect(loaded.value.manifest.expectedBytes).toBe(400);
    const manifest = JSON.parse(await readFile(join(root, "fixture", "fixture.json"), "utf8")) as { dataDirectory: string };
    expect(manifest.dataDirectory).toBe("data");
  });

  it("rejects fixtures beyond the verifiable profile before writing", () => {
    const tooMany = validateFixtureSpec({
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      id: "too-many",
      fileCount: 10_001,
      totalBytes: 10_001,
      seed: 1,
      excludedFileCount: 0,
    });
    const tooLarge = validateFixtureSpec({
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      id: "too-large",
      fileCount: 1,
      totalBytes: 500_000_001,
      seed: 1,
      excludedFileCount: 0,
    });
    expect(tooMany.ok).toBe(false);
    expect(tooLarge.ok).toBe(false);
  });
});

describe("versioned benchmark harness", () => {
  it("records ten runs, machine metadata, cache state and disabled gate by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-ai-setup-benchmark-run-"));
    roots.push(root);
    const generated = await generateFixture(join(root, "fixture"), {
      id: "run",
      fileCount: 3,
      totalBytes: 300,
      seed: 9,
      excludedFileCount: 1,
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const loaded = await loadFixture(join(root, "fixture"));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const report = await runBenchmark(
      loaded.value,
      { cache: "cold", command: "controlled command", commit: "abc123" },
      { sampleRss: () => 100 },
    );
    expect(report.schemaVersion).toBe(1);
    expect(report.cache).toBe("cold");
    expect(report.runtime.commit).toBe("abc123");
    expect(report.command).toBe("controlled command");
    expect(report.runs).toHaveLength(10);
    expect(report.runs.every((run) => run.cache === "cold" && run.analyzedFileCount === 3 && run.analyzedBytes === 300)).toBe(true);
    expect(report.statistics.p50Ms).toBeGreaterThanOrEqual(0);
    expect(report.statistics.p90Ms).toBeGreaterThanOrEqual(report.statistics.p50Ms);
    expect(report.statistics.maxMs).toBeGreaterThanOrEqual(report.statistics.p90Ms);
    expect(report.gate).toMatchObject({ mode: "disabled", passed: null });
  });

  it("uses nearest-rank p50/p90 and max statistics", () => {
    const runs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((scanToStackMs, index) => ({
      run: index + 1,
      cache: "warm" as const,
      scanToStackMs,
      peakRssBytes: index,
      analyzedFileCount: 1,
      analyzedBytes: 1,
      withinProfile: true,
    }));
    expect(summarize(runs)).toEqual({ p50Ms: 5, p90Ms: 9, maxMs: 10, maxRssBytes: 9, runsUnderTimeLimit: 10 });
  });
});
