import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";

/**
 * Fixture run for tests/temp-cleanup.test.ts. It is deliberately not named
 * `*.test.ts` so the repository's own suites never pick it up. Every test here
 * creates a fake plugin host and never disposes it, the way the suites do, and
 * the run ends in the three ways cleanup has to survive: a pass, a throw, and a
 * timeout.
 */
it("passes while leaving a fake host undisposed", () => {
  const { bb } = createFakePluginHost({ pluginId: "leak-probe-pass" });
  expect(bb.storage.database().name).toContain("bb-fake-plugin-host-");
});

it("throws while leaving a fake host undisposed", () => {
  createFakePluginHost({ pluginId: "leak-probe-throw" }).bb.storage.database();
  throw new Error("probe failure on purpose");
});

it("times out while leaving a fake host undisposed", async () => {
  createFakePluginHost({ pluginId: "leak-probe-timeout" }).bb.storage.database();
  await new Promise((resolve) => setTimeout(resolve, 2_000));
});
