# Versioned stack-scan benchmark

The benchmark is deliberately separate from normal PR checks. Build first, then generate/load a fixture and run ten measurements:

```powershell
pnpm run build
node benchmarks/run-benchmark.mjs --fixture .benchmark/fixture --generate --files 10000 --bytes 500000000 --cache warm --output .benchmark/report.json
```

Use `--cache cold` to label a run whose filesystem cache was prepared cold by the controlled environment. The harness records the label; cache eviction is intentionally not attempted because it is OS-specific and can affect unrelated processes. Use `--gate` only on a stable, dedicated performance runner; normal invocations leave the gate disabled so unstable pull requests are not blocked.

Each report has schema version `1` and records the fixture limits, CPU/memory/storage profile, Node/OS, commit, command, cache state, ten per-run monotonic scan-to-stack measurements, sampled peak RSS, p50/p90/max statistics, and the controlled gate result. Fixtures contain a `fixture.json` manifest outside the scanned `data/` root, so the manifest itself is not counted. Excluded dependency files are generated under `node_modules` and are not counted toward the 10,000-file/500 MB profile.
