import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { SYSTEM_MONITORS, installSystemMonitors } from "../src/services/system-monitors";
import { MonitorService } from "../src/services/monitor-service";

let fixtureNumber = 0;
const CONTROLLER_KEY = "owner-7-controller";
const NOW = 1_800_000_000_000;

function fixture(paired = true) {
  const { bb } = createFakePluginHost({ pluginId: `telegram-system-monitors-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  if (paired) {
    store.createPairingCode(hashSecret("pair"), NOW - 10_000, NOW + 10_000);
    expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", NOW - 5_000)).toEqual({ ok: true });
    // The controller row is materialised by the owner's first message, so
    // upkeep installs once the agent has actually been used — not at pairing.
    store.enqueueControllerTurn({
      controllerKey: CONTROLLER_KEY,
      telegramUserId: "7",
      telegramChatId: "7",
      updateId: 1,
      inputText: "hello",
      now: NOW - 4_000,
    });
  }
  return { bb, store };
}

function install(store: TelegramAgentStore, now = NOW) {
  return installSystemMonitors({ store, clock: { now: () => now }, warn: () => undefined });
}

it("appends the system monitor migration after every shipped one", () => {
  expect(ALL_MIGRATIONS[22]).toContain("ALTER TABLE monitors ADD COLUMN system_key");
});

it("installs every system monitor once and stays idempotent across restarts", () => {
  const { store } = fixture();

  expect(install(store)).toBe(SYSTEM_MONITORS.length);
  const first = store.listMonitors(CONTROLLER_KEY, true);
  expect(first).toHaveLength(SYSTEM_MONITORS.length);

  expect(install(store, NOW + 60_000)).toBe(SYSTEM_MONITORS.length);

  const second = store.listMonitors(CONTROLLER_KEY, true);
  expect(second).toHaveLength(SYSTEM_MONITORS.length);
  expect(second.map((monitor) => monitor.id).sort()).toEqual(first.map((monitor) => monitor.id).sort());
});

it("installs nothing until an owner is paired", () => {
  const { store } = fixture(false);

  expect(install(store)).toBe(0);

  expect(store.listMonitors(CONTROLLER_KEY, true)).toEqual([]);
});

it("re-arms a system monitor the owner cancelled", () => {
  const { store } = fixture();
  install(store);
  const monitor = store.listMonitors(CONTROLLER_KEY, true)[0];
  if (!monitor) throw new Error("missing monitor");
  expect(store.cancelMonitor(monitor.id, NOW + 1_000)).toBe(true);

  install(store, NOW + 2_000);

  expect(store.listMonitors(CONTROLLER_KEY, false).map((each) => each.id)).toContain(monitor.id);
});

it("does not spend the owner's armed-monitor budget", () => {
  const { store } = fixture();
  // The owner's own cap is 20; filling it must not block the agent's upkeep.
  for (let index = 0; index < 20; index += 1) {
    store.createMonitor({
      controllerKey: CONTROLLER_KEY,
      kind: "schedule",
      cron: "0 9 * * *",
      instruction: `owner watch ${index}`,
      dueAt: NOW + 86_400_000,
      now: NOW,
    });
  }

  expect(install(store)).toBe(SYSTEM_MONITORS.length);
});

it("fires a system monitor as an ordinary follow-up turn", async () => {
  const { store } = fixture();
  install(store);
  const due = store.listMonitors(CONTROLLER_KEY, true)
    .map((monitor) => monitor.dueAt ?? 0)
    .reduce((left, right) => Math.min(left, right));
  const service = new MonitorService({
    store,
    threads: { status: async () => "idle", output: async () => "" },
    clock: { now: () => due },
  });

  await expect(service.processDue()).resolves.toBe(true);

  const fired = store.listControllerTurns(CONTROLLER_KEY, 10)
    .filter((turn) => turn.inputText.includes("A monitor you set has fired"));
  expect(fired).toHaveLength(1);
  // Whichever monitor came due first, the agent receives that monitor's own
  // instruction verbatim — it is acting on its own words, not a generic nudge.
  const text = fired[0]?.inputText ?? "";
  expect(SYSTEM_MONITORS.some((monitor) => text.includes(monitor.instruction))).toBe(true);
});

it("keeps every system instruction bounded and well named", () => {
  for (const monitor of SYSTEM_MONITORS) {
    expect(monitor.instruction.length).toBeLessThanOrEqual(1_000);
    expect(monitor.systemKey).toMatch(/^system-[a-z-]+$/);
  }
});

// Upkeep that reports on quiet days trains the owner to ignore it. The weekly
// scorecard is the deliberate exception: it is a report, not a sweep.
it.each(["system-stale-jobs", "system-memory-audit"])("tells %s when not to speak", (systemKey) => {
  const monitor = SYSTEM_MONITORS.find((each) => each.systemKey === systemKey);
  expect(monitor?.instruction.toLowerCase()).toMatch(/only if|only about|say nothing/);
});

it("reports a scorecard entirely from durable state", () => {
  const { store } = fixture();
  store.rememberMemory({
    scope: "proj_a", kind: "fact", subject: "canary timing",
    body: "two minutes", source: "agent", origin: "job_outcome", now: NOW,
  });
  const forgotten = store.rememberMemory({
    scope: "owner", kind: "fact", subject: "old idea", body: "stale", source: "agent", now: NOW,
  });
  store.forgetMemory({ id: forgotten.id, now: NOW });
  install(store);

  const scorecard = store.buildAutonomyScorecard({ now: NOW, windowMs: 7 * 86_400_000 });

  expect(scorecard).toMatchObject({
    windowMs: 7 * 86_400_000,
    blockedJobs: [],
    undeliverable: 0,
    memory: { live: 1, tombstoned: 1, extracted: 1 },
    monitors: { system: SYSTEM_MONITORS.length, failed: 0 },
  });
});

it("rejects a nonsensical scorecard window", () => {
  const { store } = fixture();

  expect(() => store.buildAutonomyScorecard({ now: NOW, windowMs: 0 })).toThrow(/windowMs/);
});
