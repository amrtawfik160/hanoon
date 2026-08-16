import { defineConfig } from "vitest/config";

const SUBPROCESS_SUITES = [
  "tests/answer-contract.test.ts",
  "tests/controller-outcome-eval.test.ts",
];

/** Points `os.tmpdir()` at this run's temp root; see tests/setup/temp-root.ts. */
const TEMP_ROOT_SETUP = ["./tests/setup/worker-temp-root.ts"];

export default defineConfig({
  test: {
    globalSetup: ["./tests/setup/temp-root.ts"],
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: SUBPROCESS_SUITES,
          setupFiles: TEMP_ROOT_SETUP,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "subprocess",
          include: SUBPROCESS_SUITES,
          pool: "threads",
          poolOptions: { threads: { singleThread: true } },
          setupFiles: TEMP_ROOT_SETUP,
          sequence: { groupOrder: 1 },
          testTimeout: 130_000,
        },
      },
    ],
  },
});
