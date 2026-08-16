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
  expect(turns[0]?.inputText).toContain("stay silent");
  expect(turns[0]?.inputText).toMatch(/capability routing.*denial.*material escalation.*missing mandatory evidence/i);
  expect(turns[0]?.inputText).not.toMatch(/tell the owner what happened/i);
  expect(store.listMonitors(CONTROLLER_KEY, true)).toMatchObject([{ state: "done", fireCount: 1 }]);
});

it("holds a freshly armed thread watch until the thread has had a moment to start", async () => {
  const { store } = fixture();
  // A thread does not leave idle the instant it is messaged, so a watch armed
  // alongside that message must not read the idle it has not left yet as the
  // work having finished.
  store.ensureThreadWatch({
    controllerKey: CONTROLLER_KEY,
    threadId: "thr_work",
    instruction: "Pick the work up when it lands.",
    dueAt: NOW + 60_000,
    now: NOW,
    mode: "courtesy",
  });
  const stillIdle = async () => "idle" as const;

  await expect(service(store, stillIdle).processDue()).resolves.toBe(false);
  expect(store.listControllerTurns(CONTROLLER_KEY, 10)).toHaveLength(0);

  await expect(service(store, stillIdle, () => NOW + 60_001).processDue()).resolves.toBe(true);
  expect(store.listControllerTurns(CONTROLLER_KEY, 10)[0]?.inputText)
    .toContain("Pick the work up when it lands.");
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

it("identifies the fired schedule so the controller can cancel an obsolete poller", async () => {
  const { store } = fixture();
  const dueAt = nextCronOccurrence("*/5 * * * *", NOW);
  if (dueAt === null) throw new Error("cron did not parse");
  const monitor = store.createMonitor({
    controllerKey: CONTROLLER_KEY,
    kind: "schedule",
    cron: "*/5 * * * *",
    instruction: "Check whether the guarded job moved.",
    dueAt,
    now: NOW,
  });

  await expect(service(store, async () => "idle", () => dueAt).processDue()).resolves.toBe(true);

  const prompt = store.listControllerTurns(CONTROLLER_KEY, 10)[0]?.inputText ?? "";
  expect(prompt).toContain(monitor.id);
  expect(prompt).toMatch(/cancel.*schedule|schedule.*cancel/i);
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

it("keeps one watch per thread and lets the agent's own wording win", () => {
  const { store } = fixture();
  const courtesy = store.ensureThreadWatch({
    controllerKey: CONTROLLER_KEY,
    threadId: "thr_work",
    instruction: "Carry on with whatever you promised.",
    dueAt: NOW + 60_000,
    now: NOW,
    mode: "courtesy",
  });

  // A second engagement with the same thread must not arm a second watch, and
  // must not overwrite an instruction the agent wrote for itself.
  const repeated = store.ensureThreadWatch({
    controllerKey: CONTROLLER_KEY,
    threadId: "thr_work",
    instruction: "Something blander.",
    dueAt: NOW + 61_000,
    now: NOW + 1_000,
    mode: "courtesy",
  });
  const explicit = store.ensureThreadWatch({
    controllerKey: CONTROLLER_KEY,
    threadId: "thr_work",
    instruction: "Merge it through the pipeline, then tell the owner it is live.",
    dueAt: NOW + 62_000,
    now: NOW + 2_000,
    mode: "explicit",
  });

  expect([courtesy?.id, repeated?.id, explicit?.id]).toEqual([courtesy?.id, courtesy?.id, courtesy?.id]);
  expect(store.listMonitors(CONTROLLER_KEY, true)).toMatchObject([{
    id: courtesy?.id,
    state: "armed",
    instruction: "Merge it through the pipeline, then tell the owner it is live.",
  }]);
});

it("declines a courtesy watch at the armed cap rather than failing the action", () => {
  const { store } = fixture();
  for (let index = 0; index < 20; index += 1) {
    store.createMonitor({
      controllerKey: CONTROLLER_KEY,
      kind: "schedule",
      cron: "0 9 * * 1-5",
      instruction: `Digest ${index}.`,
      dueAt: NOW + 86_400_000,
      now: NOW + index,
    });
  }

  expect(store.ensureThreadWatch({
    controllerKey: CONTROLLER_KEY,
    threadId: "thr_work",
    instruction: "Carry on with whatever you promised.",
    dueAt: NOW + 60_000,
    now: NOW,
    mode: "courtesy",
  })).toBeNull();
});

/** A thread stuck like the real one found wedged at `stopping` for eleven days. */
function wedged(quietForMs: number) {
  return {
    status: "stopping",
    runtimeStatus: "stopping",
    startedAt: NOW - quietForMs,
    updatedAt: NOW - quietForMs,
    hasPendingInteraction: false,
    hostReconnectGraceExpiresAt: null,
  };
}

function watchingService(
  store: ReturnType<typeof openStore>,
  observe: () => Promise<ReturnType<typeof wedged> | null>,
  now = () => NOW,
) {
  return new MonitorService({
    store,
    threads: { status: async () => "active" as const, output: async () => "", observe },
    clock: { now },
  });
}

function armWatch(store: ReturnType<typeof openStore>, instruction: string) {
  store.createMonitor({
    controllerKey: CONTROLLER_KEY,
    kind: "thread_idle",
    threadId: "thr_wedged",
    instruction,
    dueAt: null,
    now: NOW,
  });
}

it("reports a watched thread that wedged instead of ever settling", async () => {
  // A watch fires on idle, error, or missing. A wedged thread reaches none of
  // them, so before this the watch stayed armed and silent forever.
  const { store } = fixture();
  armWatch(store, "Tell me when the deploy lands.");

  await expect(watchingService(store, async () => wedged(3 * 60 * 60_000)).processDue()).resolves.toBe(true);

  const turns = store.listControllerTurns(CONTROLLER_KEY, 10);
  expect(turns).toHaveLength(1);
  expect(turns[0]?.inputText).toContain("stopped making progress");
  expect(turns[0]?.inputText).toContain("thr_wedged");
  expect(turns[0]?.inputText).toContain("Tell me when the deploy lands.");
});

it("leaves the watch armed so a wedged thread that recovers still reports", async () => {
  const { store } = fixture();
  armWatch(store, "Tell me when it lands.");

  await watchingService(store, async () => wedged(3 * 60 * 60_000)).processDue();

  expect(store.listArmedMonitors(10)).toHaveLength(1);
});

it("reports one stall per watch rather than one per sweep", async () => {
  const { store } = fixture();
  armWatch(store, "Tell me when it lands.");
  let at = NOW;
  const monitor = watchingService(store, async () => wedged(3 * 60 * 60_000), () => at);

  for (let sweep = 0; sweep < 4; sweep += 1) {
    await monitor.processDue();
    at += 5 * 60_000;
  }

  expect(store.listControllerTurns(CONTROLLER_KEY, 10)).toHaveLength(1);
});

it("says nothing about a watched thread that is merely working", async () => {
  const { store } = fixture();
  armWatch(store, "Tell me when it lands.");

  await expect(watchingService(store, async () => ({
    ...wedged(60_000),
    status: "active",
    runtimeStatus: "active",
  })).processDue()).resolves.toBe(false);

  expect(store.listControllerTurns(CONTROLLER_KEY, 10)).toHaveLength(0);
});

it("does not spend a BB round-trip per watch on every executor tick", async () => {
  const { store } = fixture();
  armWatch(store, "Tell me when it lands.");
  let at = NOW;
  const observe = vi.fn(async () => wedged(3 * 60 * 60_000));
  const monitor = new MonitorService({
    store,
    threads: { status: async () => "active" as const, output: async () => "", observe },
    clock: { now: () => at },
  });

  await monitor.processDue();
  at += 1_000;
  await monitor.processDue();
  at += 1_000;
  await monitor.processDue();

  expect(observe).toHaveBeenCalledTimes(1);
});

it("treats an unreadable thread as no evidence of a stall", async () => {
  const { store } = fixture();
  armWatch(store, "Tell me when it lands.");

  await expect(watchingService(store, async () => {
    throw new Error("host is unreachable");
  }).processDue()).resolves.toBe(false);

  expect(store.listControllerTurns(CONTROLLER_KEY, 10)).toHaveLength(0);
  expect(store.listArmedMonitors(10)).toHaveLength(1);
});
