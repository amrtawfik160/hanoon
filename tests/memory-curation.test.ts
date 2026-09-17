import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { openStore } from "../src/storage/store";
import { subjectsContradict } from "../src/storage/memory-ranking";

let fixtureNumber = 0;

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-curation-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001)).toEqual({ ok: true });
  return { bb, store };
}

it("keeps the historical memory_recalls migration and drops the table on a fresh store", () => {
  expect(ALL_MIGRATIONS[21]).toContain("CREATE TABLE memory_recalls");
  const { bb } = fixture();
  expect(
    bb.storage.database().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_recalls'",
    ).get(),
  ).toBeUndefined();
});

it.each([
  ["a strict superset", "deploy on fridays", "never deploy on fridays", true],
  ["identical wording", "deploy on fridays", "deploy on fridays", true],
  ["one shared word", "deploy the api", "restart the database", false],
  ["a single-token subject", "deploy", "never deploy anything ever", false],
  ["unrelated subjects", "invoice retries", "canary timing", false],
])("treats %s as contradiction=%s", (_label, left, right, expected) => {
  expect(subjectsContradict(left, right)).toBe(expected);
});

it("retires a contradicted belief when the owner corrects it", () => {
  const { store } = fixture();
  const original = store.rememberMemory({
    scope: "owner", kind: "preference", subject: "deploy on fridays",
    body: "always deploy on fridays", source: "owner", now: 2_000,
  });
  const unrelated = store.rememberMemory({
    scope: "owner", kind: "fact", subject: "canary timing",
    body: "the canary needs two minutes", source: "owner", now: 2_001,
  });

  store.rememberMemory({
    scope: "owner", kind: "correction", subject: "never deploy on fridays",
    body: "never deploy on fridays", source: "owner", now: 2_002,
  });

  expect(store.getMemory(original.id)?.supersededBy).not.toBeNull();
  expect(store.getMemory(unrelated.id)?.supersededBy).toBeNull();
});

it("does not let an ordinary restatement retire a neighbouring belief", () => {
  const { store } = fixture();
  const original = store.rememberMemory({
    scope: "owner", kind: "preference", subject: "deploy on fridays",
    body: "always deploy on fridays", source: "owner", now: 2_000,
  });

  store.rememberMemory({
    scope: "owner", kind: "fact", subject: "we deploy on fridays and mondays",
    body: "both days are used", source: "owner", now: 2_001,
  });

  expect(store.getMemory(original.id)?.supersededBy).toBeNull();
});
