import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // speller.d unittest#1 runs ~3.5s against the 5s default; under CPU contention from a
    // growing suite it fails as a bare STACK_TRACE_ERROR that reads like a crash, not a timeout.
    testTimeout: 30000,
  },
});
