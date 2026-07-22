import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    pool: "forks",
    sequence: { shuffle: false },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      thresholds: { lines: 80, functions: 80, branches: 80 },
    },
  },
});
