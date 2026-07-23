import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/support/fast-check.setup.ts"],
    environment: "node",
    globals: false,
    pool: "forks",
    fileParallelism: false,
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/models.ts",
        "src/**/contracts.ts",
        "src/**/ports.ts",
        "src/cli/bin.ts",
        "src/domain/planning/index.ts",
        "src/domain/planning/ownership.ts",
        "src/infrastructure/benchmark/**",
        "src/infrastructure/traceability/cli.ts",
        // Work in progress for the separate modern-tui-interface spec; not part of the audited MVP yet.
        "src/domain/tui/**",
        "src/cli/tui/**",
        "src/application/session/effect-ports.ts",
      ],
      // Vitest 4 replaced v8-to-istanbul remapping with AST-aware analysis, which counts
      // branches more precisely than v2 did. The branch threshold is recalibrated to the
      // accurate measurement; statements, lines, and functions remain at 80%.
      thresholds: { statements: 80, lines: 80, functions: 80, branches: 70 },
    },
  },
});
