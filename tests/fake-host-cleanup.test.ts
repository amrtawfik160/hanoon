import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  disposeTrackedFakePluginHosts,
  trackedFakePluginHostCount,
} from "./support/fake-plugin-host";

const HOST_DIR_PREFIX = "bb-fake-plugin-host-";

// A full run used to leave one ~900KB directory per host in /tmp. 533,000 of
// them had piled up and filled the machine's disk to 100%.
//
// The host's own directory is read off its database handle rather than by
// diffing /tmp: test files run in parallel workers that share one /tmp, so a
// scan sees directories other workers are creating at the same moment.
it("removes the temp directory a fake plugin host allocated", async () => {
  const { bb } = createFakePluginHost({ pluginId: "fake-host-cleanup" });
  const database = bb.storage.database();
  database.prepare("CREATE TABLE probe (id INTEGER PRIMARY KEY)").run();

  const createdPath = dirname((database as unknown as { name: string }).name);
  expect(basename(createdPath).startsWith(HOST_DIR_PREFIX)).toBe(true);
  expect(existsSync(createdPath)).toBe(true);

  await disposeTrackedFakePluginHosts();

  expect(existsSync(createdPath)).toBe(false);
});

it("tracks every host so the shared teardown can reach it", async () => {
  await disposeTrackedFakePluginHosts();
  expect(trackedFakePluginHostCount()).toBe(0);

  createFakePluginHost({ pluginId: "fake-host-tracking-1" });
  createFakePluginHost({ pluginId: "fake-host-tracking-2" });
  expect(trackedFakePluginHostCount()).toBe(2);

  await disposeTrackedFakePluginHosts();
  expect(trackedFakePluginHostCount()).toBe(0);
});

// A host built once and shared across a file's tests must survive them all;
// the shared teardown only runs when the file ends.
it("keeps a host alive across the tests in a file", () => {
  const { bb } = createFakePluginHost({ pluginId: "fake-host-shared" });
  bb.storage.database().prepare("CREATE TABLE probe (id INTEGER PRIMARY KEY)").run();
  expect(trackedFakePluginHostCount()).toBeGreaterThan(0);
  expect(() => bb.storage.database().prepare("SELECT 1").get()).not.toThrow();
});
