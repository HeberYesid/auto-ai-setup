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
        "src/cli/terminal.ts",
        "src/infrastructure/fs/transaction-filesystem.ts",
        "src/infrastructure/process/node-cli-runtime.ts",
        "src/infrastructure/transaction/autoskills-operation.ts",
        "src/domain/planning/index.ts",
        "src/domain/planning/ownership.ts",
        "src/infrastructure/benchmark/**",
        "src/infrastructure/transaction/engine.ts",
        "src/infrastructure/transaction/summary.ts",
        "src/infrastructure/traceability/cli.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 80 },
    },
  },
});
