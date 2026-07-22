#!/usr/bin/env node
/* global console, process */
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateFixture, loadFixture, runBenchmark, assertControlledGate } from "../dist/infrastructure/benchmark/index.js";

const execFileAsync = promisify(execFile);

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value?.startsWith("--")) continue;
  const next = process.argv[index + 1];
  args.set(value.slice(2), next?.startsWith("--") ? true : next ?? true);
  if (next && !next.startsWith("--")) index += 1;
}

const fixtureDirectory = args.get("fixture");
if (typeof fixtureDirectory !== "string") {
  console.error("Usage: node benchmarks/run-benchmark.mjs --fixture <directory> [--cache cold|warm] [--gate] [--output <file>]");
  process.exitCode = 2;
} else {
  if (args.has("generate")) {
    const generated = await generateFixture(fixtureDirectory, {
      id: String(args.get("id") ?? "generated"),
      fileCount: Number(args.get("files") ?? 100),
      totalBytes: Number(args.get("bytes") ?? 1024 * 1024),
      seed: Number(args.get("seed") ?? 42),
      excludedFileCount: Number(args.get("excluded-files") ?? 1),
    });
    if (!generated.ok) throw new Error(generated.error.message);
  }
  const fixture = await loadFixture(fixtureDirectory);
  if (!fixture.ok) throw new Error(fixture.error.message);
  const commit = typeof args.get("commit") === "string" ? args.get("commit") : await currentCommit();
  const report = await runBenchmark(fixture.value, {
    cache: args.get("cache") === "cold" ? "cold" : "warm",
    gate: args.has("gate"),
    command: process.argv.join(" "),
    commit,
  });
  const output = JSON.stringify(report, null, 2) + "\n";
  const outputPath = args.get("output");
  if (typeof outputPath === "string") await writeFile(outputPath, output, "utf8");
  else process.stdout.write(output);
  assertControlledGate(report);
}

async function currentCommit() {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"]);
    return result.stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}
