import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import {
  HEALTH_FAILURE_THRESHOLD,
  ProductionHealthService,
  healthNotice,
  type ProductionHealthDependencies,
} from "../src/services/production-health-service";
import { policyFixture } from "./helpers";

let fixtureNumber = 0;
const CONTROLLER_KEY = "owner-7-controller";
const NOW = 1_800_000_000_000;
const INTERVAL = 900_000;

function healthPolicy(overrides: Record<string, unknown> = {}) {
  return policyFixture({
    projectId: "proj_a",
    alias: "cyndra",
    production: {
      deployCommands: [{ name: "deploy", command: "./deploy", timeoutMs: 60_000 }],
      canaryCommands: [{ name: "canary", command: "./canary", timeoutMs: 60_000 }],
      healthCommands: [{ name: "guardian", command: "./health", timeoutMs: 30_000 }],
      convexDeployRequired: false,
      ...overrides,
    },
  });
}

function fixture(policy = healthPolicy()) {
  const { bb } = createFakePluginHost({ pluginId: `telegram-prod-health-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  store.createPairingCode(hashSecret("pair"), NOW - 10_000, NOW + 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", NOW - 5_000)).toEqual({ ok: true });
  store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY, telegramUserId: "7", telegramChatId: "7",
    updateId: 1, inputText: "hello", now: NOW - 4_000,
  });
  store.upsertProjectPolicy(policy, NOW - 3_000);
  return { store };
}

function service(
  store: TelegramAgentStore,
  ok: () => boolean,
  now: () => number,
  autoRevert?: ProductionHealthDependencies["autoRevert"],
) {
  const run = vi.fn(async () => ({ ok: ok(), summary: ok() ? "200 OK" : "guardian crashed: ReferenceError" }));
  let id = 5_000;
  return {
    run,
    service: new ProductionHealthService({
      store,
      commands: { run },
      ...(autoRevert === undefined ? {} : { autoRevert }),
      clock: { now },
      issueUpdateId: () => (id += 1),
      warn: () => undefined,
    }),
  };
}

/** Drives the probe past the failure threshold so the fault is declared. */
async function breakProduction(probe: ProductionHealthService, from: number): Promise<void> {
  for (let tick = 0; tick < HEALTH_FAILURE_THRESHOLD; tick += 1) {
    await probe.processDue();
    from += INTERVAL;
    clockAt.value = from;
  }
}

const clockAt = { value: NOW };

function notices(store: TelegramAgentStore) {
  return store.listControllerTurns(CONTROLLER_KEY, 20)
    .filter((turn) => turn.origin === "system" && turn.inputText.includes("Production"));
}

it.each([
  ["a new fault", { state: "failing", reported: null }, true],
  ["a fault already reported", { state: "failing", reported: "failing" }, false],
  ["a recovery", { state: "ok", reported: "failing" }, true],
  ["staying healthy", { state: "ok", reported: "ok" }, false],
  ["a first healthy reading", { state: "ok", reported: null }, false],
] as const)("reports %s: %s", (_label, input, expected) => {
  const notice = healthNotice({ alias: "cyndra", summary: "boom", ...input });
  expect(notice !== null).toBe(expected);
});

it("says nothing while production stays healthy", async () => {
  const { store } = fixture();
  let clock = NOW;
  const { service: probe, run } = service(store, () => true, () => clock);

  for (let tick = 0; tick < 4; tick += 1) {
    await probe.processDue();
    clock += INTERVAL;
  }

  expect(run).toHaveBeenCalled();
  expect(notices(store)).toEqual([]);
  expect(store.getProductionHealth("proj_a")).toMatchObject({ state: "ok", consecutiveFailures: 0 });
});

it("waits for a sustained fault rather than reacting to one blip", async () => {
  const { store } = fixture();
  let clock = NOW;
  let healthy = false;
  const { service: probe } = service(store, () => healthy, () => clock);

  // One bad reading, then recovery: a deploy in flight, not an incident.
  await probe.processDue();
  expect(store.getProductionHealth("proj_a")).toMatchObject({ state: "unknown", consecutiveFailures: 1 });
  expect(notices(store)).toEqual([]);

  clock += INTERVAL;
  healthy = true;
  await probe.processDue();

  expect(store.getProductionHealth("proj_a")).toMatchObject({ state: "ok", consecutiveFailures: 0 });
  expect(notices(store)).toEqual([]);
});

it("wakes the agent once when production is genuinely broken, then stays quiet", async () => {
  const { store } = fixture();
  let clock = NOW;
  const { service: probe } = service(store, () => false, () => clock);

  for (let tick = 0; tick < HEALTH_FAILURE_THRESHOLD; tick += 1) {
    await probe.processDue();
    clock += INTERVAL;
  }

  const raised = notices(store);
  expect(raised).toHaveLength(1);
  expect(raised[0]?.inputText).toContain("Production looks broken on cyndra");
  expect(raised[0]?.inputText).toContain("guardian crashed");
  // It is the agent's own follow-up, not the owner reacting to anything.
  expect(raised[0]?.origin).toBe("system");

  // Still broken on later ticks: the owner already has that message.
  for (let tick = 0; tick < 5; tick += 1) {
    await probe.processDue();
    clock += INTERVAL;
  }
  expect(notices(store)).toHaveLength(1);
});

it("reports the recovery exactly once", async () => {
  const { store } = fixture();
  let clock = NOW;
  let healthy = false;
  const { service: probe } = service(store, () => healthy, () => clock);
  for (let tick = 0; tick < HEALTH_FAILURE_THRESHOLD; tick += 1) {
    await probe.processDue();
    clock += INTERVAL;
  }
  expect(notices(store)).toHaveLength(1);

  healthy = true;
  for (let tick = 0; tick < 3; tick += 1) {
    await probe.processDue();
    clock += INTERVAL;
  }

  const raised = notices(store);
  expect(raised).toHaveLength(2);
  expect(raised[1]?.inputText).toContain("healthy again");
});

it("honours the configured interval instead of probing every tick", async () => {
  const { store } = fixture(healthPolicy({ healthIntervalMs: 3_600_000 }));
  let clock = NOW;
  const { service: probe, run } = service(store, () => true, () => clock);

  await probe.processDue();
  clock += 60_000;
  await probe.processDue();
  clock += 60_000;
  await probe.processDue();

  expect(run).toHaveBeenCalledTimes(1);
});

it("does nothing for a project with no health commands", async () => {
  const { store } = fixture(policyFixture({ projectId: "proj_a", alias: "cyndra" }));
  const { service: probe, run } = service(store, () => false, () => NOW);

  await expect(probe.processDue()).resolves.toBe(false);

  expect(run).not.toHaveBeenCalled();
  expect(store.getProductionHealth("proj_a")).toBeNull();
});

it("treats an unrunnable check as no evidence rather than an outage", async () => {
  const { store } = fixture();
  let id = 9_000;
  const probe = new ProductionHealthService({
    store,
    commands: { run: async () => { throw new Error("no connected host"); } },
    clock: { now: () => NOW },
    issueUpdateId: () => (id += 1),
    warn: () => undefined,
  });

  for (let tick = 0; tick < HEALTH_FAILURE_THRESHOLD + 2; tick += 1) await probe.processDue();

  expect(notices(store)).toEqual([]);
  expect(store.getProductionHealth("proj_a")).toMatchObject({ state: "ok" });
});

it("tells the owner a revert is already running when one started", async () => {
  const { store } = fixture();
  clockAt.value = NOW;
  const start = vi.fn((_input: { projectId: string; alias: string; now: number }) => ({
    outcome: "started" as const,
    jobId: "job_revert",
    mergeCommitSha: "a".repeat(40),
  }));
  const { service: probe } = service(store, () => false, () => clockAt.value, { start });

  await breakProduction(probe, NOW);

  expect(start).toHaveBeenCalledOnce();
  expect(start.mock.calls[0]?.[0]).toMatchObject({ projectId: "proj_a", alias: "cyndra" });
  const [notice] = notices(store);
  expect(notice?.inputText).toContain("revert commit aaaaaaaaaaaa");
  expect(notice?.inputText).toContain("normal checks");
  // The revert is already started; there is nothing here for the owner to approve.
  expect(notice?.inputText).not.toMatch(/what you propose/i);
});

it("reports the fault the way it always did when no revert could start", async () => {
  const { store } = fixture();
  clockAt.value = NOW;
  const start = vi.fn(() => ({ outcome: "investigate" as const, reason: "this project already has work running" }));
  const { service: probe } = service(store, () => false, () => clockAt.value, { start });

  await breakProduction(probe, NOW);

  const [notice] = notices(store);
  expect(notice?.inputText).toMatch(/what you propose/i);
  expect(notice?.inputText).not.toContain("revert commit");
});

it("offers the fault to the revert only once, after the transition is claimed", async () => {
  const { store } = fixture();
  clockAt.value = NOW;
  const start = vi.fn(() => ({ outcome: "investigate" as const, reason: "nothing has been merged here" }));
  const { service: probe } = service(store, () => false, () => clockAt.value, { start });

  await breakProduction(probe, NOW);
  // Still failing on every later tick, and already reported.
  for (let tick = 0; tick < 3; tick += 1) {
    clockAt.value += INTERVAL;
    await probe.processDue();
  }

  expect(start).toHaveBeenCalledOnce();
  expect(notices(store)).toHaveLength(1);
});

it("never offers a recovery to the revert", async () => {
  const { store } = fixture();
  clockAt.value = NOW;
  let healthy = false;
  const start = vi.fn(() => ({ outcome: "investigate" as const, reason: "nothing has been merged here" }));
  const { service: probe } = service(store, () => healthy, () => clockAt.value, { start });

  await breakProduction(probe, NOW);
  healthy = true;
  clockAt.value += INTERVAL;
  await probe.processDue();

  expect(notices(store)).toHaveLength(2);
  expect(start).toHaveBeenCalledOnce();
});
