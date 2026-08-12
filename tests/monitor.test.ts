import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import { MonitorService, nextCronOccurrence } from "../src/services/monitor-service";

const NOW = 1_800_000_000_000;
const CONTROLLER_KEY = "owner-7-controller";

let fixtureNumber = 0;
function fixture(now = NOW) {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-monitor-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => now);
  store.createPairingCode(hashSecret("pair-monitor"), now - 1_000, now + 10_000);
  expect(store.pairOwnerWithPrivateChatCode(hashSecret("pair-monitor"), "7", "70", now - 500)).toEqual({ ok: true });
  return { store };
}

function service(
  store: ReturnType<typeof openStore>,
  status: () => Promise<"idle" | "active" | "error" | "missing">,
  now = () => NOW,
) {
  return new MonitorService({ store, threads: { status, output: async () => "" }, clock: { now } });
}

it("waits while the watched thread is still working", async () => {
  const { store } = fixture();
  store.createMonitor({
    controllerKey: CONTROLLER_KEY,
    kind: "thread_idle",
    threadId: "thr_work",
    instruction: "Summarise what it changed.",
    dueAt: null,
    now: NOW,
  });

  await expect(service(store, async () => "active").processDue()).resolves.toBe(false);

  expect(store.listControllerTurns(CONTROLLER_KEY, 10)).toHaveLength(0);
  expect(store.listArmedMonitors(10)).toHaveLength(1);
});

it("wakes the agent with its own instruction once the watched thread finishes", async () => {
  const { store } = fixture();
  store.createMonitor({
    controllerKey: CONTROLLER_KEY,
    kind: "thread_idle",
    threadId: "thr_work",
    instruction: "Summarise what it changed and open a PR.",
    dueAt: null,
    now: NOW,
  });

  await expect(service(store, async () => "idle").processDue()).resolves.toBe(true);

  const turns = store.listControllerTurns(CONTROLLER_KEY, 10);
  expect(turns).toHaveLength(1);
  expect(turns[0]?.inputText).toContain("Summarise what it changed and open a PR.");
  expect(turns[0]?.inputText).toContain("thr_work");
  expect(store.listMonitors(CONTROLLER_KEY, true)).toMatchObject([{ state: "done", fireCount: 1 }]);
});

it("fires once and then stops, even if the loop runs again", async () => {
  const { store } = fixture();
  store.createMonitor({
    controllerKey: CONTROLLER_KEY,
    kind: "thread_idle",
    threadId: "thr_work",
    instruction: "Tell the owner it finished.",
    dueAt: null,
    now: NOW,
  });
  const monitors = service(store, async () => "idle");

  await monitors.processDue();
  await monitors.processDue();

  expect(store.listControllerTurns(CONTROLLER_KEY, 10)).toHaveLength(1);
  expect(store.listArmedMonitors(10)).toHaveLength(0);
});

it("reports a failed thread as a reason to act rather than staying silent", async () => {
  const { store } = fixture();
  store.createMonitor({
    controllerKey: CONTROLLER_KEY,
    kind: "thread_idle",
    threadId: "thr_broken",
    instruction: "Retry it once.",
    dueAt: null,
    now: NOW,
  });

  await expect(service(store, async () => "error").processDue()).resolves.toBe(true);

  expect(store.listControllerTurns(CONTROLLER_KEY, 10)[0]?.inputText).toContain("failed");
});

it("re-arms a schedule for its next occurrence instead of retiring", async () => {
  const { store } = fixture();
  const dueAt = nextCronOccurrence("0 9 * * *", NOW);
  if (dueAt === null) throw new Error("cron did not parse");
  store.createMonitor({
    controllerKey: CONTROLLER_KEY,
    kind: "schedule",
    cron: "0 9 * * *",
    instruction: "Send the morning digest.",
    dueAt,
    now: NOW,
  });

  await expect(service(store, async () => "idle", () => dueAt).processDue()).resolves.toBe(true);

  const armed = store.listArmedMonitors(10);
  expect(armed).toHaveLength(1);
  expect(armed[0]).toMatchObject({ state: "armed", fireCount: 1 });
  expect(armed[0]?.dueAt).toBeGreaterThan(dueAt);
});

it("holds a schedule until its time arrives", async () => {
  const { store } = fixture();
  const dueAt = nextCronOccurrence("0 9 * * *", NOW);
  if (dueAt === null) throw new Error("cron did not parse");
  store.createMonitor({
    controllerKey: CONTROLLER_KEY,
    kind: "schedule",
    cron: "0 9 * * *",
    instruction: "Send the morning digest.",
    dueAt,
    now: NOW,
  });

  await expect(service(store, async () => "idle", () => dueAt - 1).processDue()).resolves.toBe(false);
  expect(store.listControllerTurns(CONTROLLER_KEY, 10)).toHaveLength(0);
});

it("keeps checking other monitors when one thread cannot be read", async () => {
  const { store } = fixture();
  const warnings: string[] = [];
  store.createMonitor({
    controllerKey: CONTROLLER_KEY,
    kind: "thread_idle",
    threadId: "thr_unreadable",
    instruction: "First.",
    dueAt: null,
    now: NOW,
  });
  store.createMonitor({
    controllerKey: CONTROLLER_KEY,
    kind: "thread_idle",
    threadId: "thr_fine",
    instruction: "Second.",
    dueAt: null,
    now: NOW + 1,
  });
  const monitors = new MonitorService({
    store,
    threads: {
      status: vi.fn(async (threadId: string) => {
        if (threadId === "thr_unreadable") throw new Error("BB unreachable");
        return "idle" as const;
      }),
      output: async () => "",
    },
    clock: { now: () => NOW },
    warn: (message) => warnings.push(message),
  });

  await expect(monitors.processDue()).resolves.toBe(true);

  expect(store.listControllerTurns(CONTROLLER_KEY, 10)[0]?.inputText).toContain("Second.");
  expect(warnings[0]).toContain("could not be checked");
});

it("gives each firing a fresh update id that stays clear of real Telegram updates", async () => {
  const { store } = fixture();
  for (const [index, instruction] of ["First.", "Second."].entries()) {
    store.createMonitor({
      controllerKey: CONTROLLER_KEY,
      kind: "thread_idle",
      threadId: `thr_${index}`,
      instruction,
      dueAt: null,
      now: NOW + index,
    });
  }

  await service(store, async () => "idle").processDue();

  const updateIds = store.listControllerTurns(CONTROLLER_KEY, 10).map((turn) => turn.updateId);
  expect(new Set(updateIds).size).toBe(2);
  expect(Math.min(...updateIds)).toBeGreaterThan(2_000_000_000);
});

it("refuses a cron expression it cannot schedule", () => {
  expect(nextCronOccurrence("not a cron", NOW)).toBeNull();
  expect(nextCronOccurrence("0 9 * * *", NOW)).toBeGreaterThan(NOW);
});
