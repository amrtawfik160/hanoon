import { defineConfig } from "vitest/config";

const SUBPROCESS_SUITES = [
  "tests/answer-contract.test.ts",
  "tests/controller-outcome-eval.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: SUBPROCESS_SUITES,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "subprocess",
          include: SUBPROCESS_SUITES,
          pool: "threads",
          poolOptions: { threads: { singleThread: true } },
          sequence: { groupOrder: 1 },
          testTimeout: 130_000,
        },
      },
    ],
  },
});
