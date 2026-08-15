import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import {
  disposeTrackedFakePluginHosts,
  trackedFakePluginHostCount,
} from "./support/fake-plugin-host";

const HOST_DIR_PREFIX = "bb-fake-plugin-host-";

function hostDirectories(): Set<string> {
  return new Set(
    readdirSync(tmpdir()).filter((entry) => entry.startsWith(HOST_DIR_PREFIX)),
  );
}

// A full run used to leave one ~900KB directory per host in /tmp. 533,000 of
// them had piled up and filled the machine's disk to 100%.
it("removes the temp directory a fake plugin host allocated", async () => {
  const before = hostDirectories();

  const { bb } = createFakePluginHost({ pluginId: "fake-host-cleanup" });
  bb.storage.database().prepare("CREATE TABLE probe (id INTEGER PRIMARY KEY)").run();

  const created = [...hostDirectories()].filter((entry) => !before.has(entry));
  expect(created).toHaveLength(1);
  const createdPath = `${tmpdir()}/${created[0]}`;
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
