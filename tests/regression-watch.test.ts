import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { RegressionWatchService } from "../src/services/regression-watch-service";
import { policyFixture } from "./helpers";

let fixtureNumber = 0;
const CONTROLLER_KEY = "owner-7-controller";
const NOW = 1_800_000_000_000;
const INTERVAL = 24 * 60 * 60_000;

function regressionPolicy() {
  return policyFixture({
    projectId: "proj_a",
    alias: "cyndra",
    regression: {
      commands: [
        { name: "unit", command: "npm test", timeoutMs: 600_000 },
        { name: "lint", command: "npm run lint", timeoutMs: 60_000 },
      ],
      intervalMs: INTERVAL,
    },
  });
}

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-regression-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  store.createPairingCode(hashSecret("pair"), NOW - 10_000, NOW + 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", NOW - 5_000)).toEqual({ ok: true });
  store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY, telegramUserId: "7", telegramChatId: "7",
    updateId: 1, inputText: "hello", now: NOW - 4_000,
  });
  store.upsertProjectPolicy(regressionPolicy(), NOW - 3_000);
  return store;
}

/** `outcomes` maps a command name to the sequence of results it returns. */
function service(store: TelegramAgentStore, outcomes: Record<string, boolean[]>, now: () => number) {
  const calls: string[] = [];
  const run = vi.fn(async ({ command }: { command: { name: string } }) => {
    calls.push(command.name);
    const queue = outcomes[command.name] ?? [true];
    const ok = queue.length > 1 ? queue.shift()! : queue[0];
    return { ok, summary: ok ? "0 failed" : "3 failed" };
  });
  let id = 5_000;
  return {
    calls,
    run,
    service: new RegressionWatchService({
      store,
      commands: { run },
      clock: { now },
      issueUpdateId: () => (id += 1),
      warn: () => undefined,
    }),
  };
}

function notices(store: TelegramAgentStore) {
  return store.listControllerTurns(CONTROLLER_KEY, 20)
    .filter((turn) => turn.origin === "system");
}

it("says nothing when the scheduled checks pass", async () => {
  const store = fixture();
  const { service: watcher } = service(store, { unit: [true], lint: [true] }, () => NOW);

  await watcher.processDue();

  expect(notices(store)).toHaveLength(0);
  expect(store.getRegressionWatch("proj_a")?.confirmedFailures).toEqual([]);
});

it("tells the owner the first time something newly breaks", async () => {
  const store = fixture();
  const { service: watcher } = service(store, { unit: [false], lint: [true] }, () => NOW);

  await watcher.processDue();

  const messages = notices(store);
  expect(messages).toHaveLength(1);
  expect(messages[0].inputText).toContain("unit");
  expect(store.getRegressionWatch("proj_a")?.confirmedFailures).toEqual(["unit"]);
});

it("re-runs a failing check and ignores it when it passes the second time", async () => {
  const store = fixture();
  // Fails once, passes on the immediate re-run: flaky, not a regression.
  const { service: watcher, calls } = service(store, { unit: [false, true], lint: [true] }, () => NOW);

  await watcher.processDue();

  expect(calls.filter((name) => name === "unit")).toHaveLength(2);
  expect(notices(store)).toHaveLength(0);
  expect(store.getRegressionWatch("proj_a")).toMatchObject({
    confirmedFailures: [],
    flakyFailures: ["unit"],
  });
});

it("stays quiet on later runs while the same check keeps failing", async () => {
  const store = fixture();
  let now = NOW;
  const { service: watcher } = service(store, { unit: [false], lint: [true] }, () => now);

  await watcher.processDue();
  expect(notices(store)).toHaveLength(1);

  now = NOW + INTERVAL + 1;
  await watcher.processDue();

  expect(notices(store)).toHaveLength(1);
});

it("speaks again when a second check breaks on top of a known failure", async () => {
  const store = fixture();
  let now = NOW;
  const outcomes: Record<string, boolean[]> = { unit: [false], lint: [true] };
  const { service: watcher } = service(store, outcomes, () => now);

  await watcher.processDue();
  outcomes.lint = [false];
  now = NOW + INTERVAL + 1;
  await watcher.processDue();

  const messages = notices(store);
  expect(messages).toHaveLength(2);
  expect(messages.at(-1)?.inputText).toContain("lint");
});

it("reports recovery once the checks pass again", async () => {
  const store = fixture();
  let now = NOW;
  const outcomes: Record<string, boolean[]> = { unit: [false], lint: [true] };
  const { service: watcher } = service(store, outcomes, () => now);

  await watcher.processDue();
  outcomes.unit = [true];
  now = NOW + INTERVAL + 1;
  await watcher.processDue();

  const messages = notices(store);
  expect(messages).toHaveLength(2);
  expect(messages.at(-1)?.inputText).toContain("passes again");
});

it("does not run again before the configured interval has passed", async () => {
  const store = fixture();
  const { service: watcher, run } = service(store, { unit: [true], lint: [true] }, () => NOW);

  await watcher.processDue();
  const afterFirst = run.mock.calls.length;
  await watcher.processDue();

  expect(run.mock.calls.length).toBe(afterFirst);
});

it("treats a check that cannot run as no evidence rather than a regression", async () => {
  const store = fixture();
  let id = 5_000;
  const watcher = new RegressionWatchService({
    store,
    commands: { run: async () => { throw new Error("no host available"); } },
    clock: { now: () => NOW },
    issueUpdateId: () => (id += 1),
    warn: () => undefined,
  });

  await watcher.processDue();

  expect(notices(store)).toHaveLength(0);
  expect(store.getRegressionWatch("proj_a")?.confirmedFailures).toEqual([]);
});

it("ignores projects that configured no scheduled checks", async () => {
  const { bb } = createFakePluginHost({ pluginId: `telegram-regression-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  store.createPairingCode(hashSecret("pair"), NOW - 10_000, NOW + 10_000);
  store.pairOwnerWithCode(hashSecret("pair"), "7", "7", NOW - 5_000);
  store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY, telegramUserId: "7", telegramChatId: "7",
    updateId: 1, inputText: "hello", now: NOW - 4_000,
  });
  store.upsertProjectPolicy(policyFixture({ projectId: "proj_a", alias: "cyndra" }), NOW - 3_000);
  const { service: watcher, run } = service(store, {}, () => NOW);

  await watcher.processDue();

  expect(run).not.toHaveBeenCalled();
});
