import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const SUBPROCESS_SUITES = [
  "tests/answer-contract.test.ts",
  "tests/controller-outcome-eval.test.ts",
];

/** Points `os.tmpdir()` at this run's temp root; see tests/setup/temp-root.ts. */
const TEMP_ROOT_SETUP = ["./tests/setup/worker-temp-root.ts"];

// Each fake plugin host holds a temp directory that only `harness.dispose()`
// removes. Routing the bare specifier through the wrapper tracks every host so
// the shared teardown can release them; without it a full run left one
// directory per host in /tmp and eventually filled the disk. The wrapper
// imports the SDK by its concrete path, so this alias does not recurse.
const FAKE_PLUGIN_HOST_ALIAS = [
  {
    find: "@bb/plugin-sdk/testing",
    replacement: fileURLToPath(new URL("./tests/support/fake-plugin-host.ts", import.meta.url)),
  },
  // The wrapper's own way back to the real module. The package's export map
  // exposes only "./testing", which now points at the wrapper, so reaching the
  // SDK needs a specifier of its own rather than a deep import.
  {
    find: "@bb/plugin-sdk-testing-actual",
    replacement: fileURLToPath(
      new URL("./node_modules/@bb/plugin-sdk/dist/testing/index.js", import.meta.url),
    ),
  },
];
// Both leak fixes are needed: the temp-root setup redirects `os.tmpdir()` for
// the run, and the dispose setup releases every fake plugin host at teardown.
const SETUP_FILES = [...TEMP_ROOT_SETUP, "./tests/support/dispose-fake-hosts.ts"];

export default defineConfig({
  test: {
    globalSetup: ["./tests/setup/temp-root.ts"],
    projects: [
      {
        resolve: { alias: FAKE_PLUGIN_HOST_ALIAS },
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: SUBPROCESS_SUITES,
          setupFiles: SETUP_FILES,
          sequence: { groupOrder: 0 },
        },
      },
      {
        resolve: { alias: FAKE_PLUGIN_HOST_ALIAS },
        test: {
          name: "subprocess",
          include: SUBPROCESS_SUITES,
          pool: "threads",
          poolOptions: { threads: { singleThread: true } },
          setupFiles: SETUP_FILES,
          sequence: { groupOrder: 1 },
          testTimeout: 130_000,
        },
      },
    ],
  },
});
