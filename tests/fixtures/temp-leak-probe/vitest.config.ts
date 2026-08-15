import { defineConfig } from "vitest/config";

/**
 * Config for the probe run spawned by tests/temp-cleanup.test.ts. It uses the
 * same temp-root setup as the real suites, so the probe proves the shipped
 * cleanup path rather than a copy of it.
 */
export default defineConfig({
  test: {
    globalSetup: ["./tests/setup/temp-root.ts"],
    include: ["tests/fixtures/temp-leak-probe/*.probe.ts"],
    setupFiles: ["./tests/setup/worker-temp-root.ts"],
    testTimeout: 500,
  },
});
