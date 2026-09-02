import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import {
  SYSTEM_MONITORS,
  installSystemAutomations,
  systemAutomationInstallationComplete,
} from "../src/services/system-monitors";
import { ManagedAutomationService } from "../src/services/managed-automation-service";
import { ManagedAutomationRepository } from "../src/storage/managed-automation-repository";
import { nextCronOccurrence, MonitorService } from "../src/services/monitor-service";
import { admitConfirmedJob, policyFixture } from "./helpers";
import { createFakeBbAutomationAdapter } from "./support/fake-bb-automation-adapter";

let fixtureNumber = 0;
const CONTROLLER_KEY = "owner-7-controller";
const NOW = 1_800_000_000_000;
const EXECUTION = { model: "gpt-5.6-sol", permissionMode: "auto" as const };

function fixture(options: { paired?: boolean; spawned?: boolean } = {}) {
  const paired = options.paired ?? true;
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
    if (options.spawned ?? true) {
      // Upkeep runs as BB automations, which need the controller's verified
      // BB host and project: both are recorded when its thread is spawned.
      const lease = store.acquireExecutorLease("executor", NOW - 3_000, 30_000);
      if (!lease.acquired) throw new Error("missing executor lease");
      const turn = store.claimNextControllerTurn({ ownerId: "executor", generation: lease.generation, now: NOW - 3_000 });
      if (!turn) throw new Error("missing controller turn");
      expect(store.markControllerSpawned({
        turnId: turn.id,
        ownerId: "executor",
        generation: lease.generation,
        now: NOW - 3_000,
        projectId: "proj_a",
        hostId: "host_a",
        threadId: "thr_controller",
      })).toBe(true);
      // The controller keeps its host and project; the lease itself must not
      // linger, or a test that admits a job cannot take its own lease.
      expect(store.releaseExecutorLease("executor", lease.generation, NOW - 3_000)).toBe(true);
    }
  }
  const repository = new ManagedAutomationRepository(bb.storage.database());
  const fake = createFakeBbAutomationAdapter(NOW);
  const service = new ManagedAutomationService(repository, fake.adapter, () => true);
  return { bb, store, repository, fake, service };
}

function install(value: ReturnType<typeof fixture>, now = NOW) {
  return installSystemAutomations({
    store: value.store,
    service: value.service,
    providerId: "codex",
    execution: EXECUTION,
    clock: { now: () => now },
    warn: () => undefined,
  });
}

/** The plugin-local rows an installation carried before upkeep moved to BB. */
function installLegacyRows(store: TelegramAgentStore, now = NOW) {
  for (const definition of SYSTEM_MONITORS) {
    store.ensureSystemMonitor({
      systemKey: definition.systemKey,
      controllerKey: CONTROLLER_KEY,
      cron: definition.cron,
      instruction: definition.instruction,
      dueAt: nextCronOccurrence(definition.cron, now)!,
      now,
    });
  }
}

it("appends the system monitor migration after every shipped one", () => {
  expect(ALL_MIGRATIONS[22]).toContain("ALTER TABLE monitors ADD COLUMN system_key");
});

it("installs every upkeep schedule as a BB agent automation once and stays idempotent across restarts", async () => {
  const value = fixture();

  await expect(install(value)).resolves.toBe(SYSTEM_MONITORS.length);
  const first = value.service.list(CONTROLLER_KEY);
  expect(first).toHaveLength(SYSTEM_MONITORS.length);
  expect(first.every((binding) => binding.state === "active" && binding.authority.source === "system")).toBe(true);
  expect(first.map((binding) => binding.definition.mode)).toEqual(["agent", "agent", "agent"]);

  await expect(install(value, NOW + 60_000)).resolves.toBe(SYSTEM_MONITORS.length);

  expect(value.fake.create).toHaveBeenCalledTimes(SYSTEM_MONITORS.length);
  expect(value.service.list(CONTROLLER_KEY).map((binding) => binding.id).sort())
    .toEqual(first.map((binding) => binding.id).sort());
  expect(value.store.listSystemMonitors()).toEqual([]);
});

it("hands an armed legacy schedule to BB and cancels the local row only after BB reads it back", async () => {
  const value = fixture();
  installLegacyRows(value.store);
  expect(value.store.listSystemMonitors().every((monitor) => monitor.state === "armed")).toBe(true);

  await expect(install(value)).resolves.toBe(SYSTEM_MONITORS.length);

  expect(value.store.listSystemMonitors().every((monitor) => monitor.state === "cancelled")).toBe(true);
  const bindings = value.service.list(CONTROLLER_KEY);
  expect(bindings).toHaveLength(SYSTEM_MONITORS.length);
  expect(bindings.every((binding) => binding.state === "active" && binding.legacyMonitorId !== null)).toBe(true);
});

it("counts only the schedules BB accepted, so the install latch stays open until every one exists", async () => {
  const value = fixture();
  value.fake.create.mockRejectedValueOnce(new Error("BB unavailable"));

  const partial = await install(value);

  expect(partial).toBe(SYSTEM_MONITORS.length - 1);
  expect(systemAutomationInstallationComplete(partial)).toBe(false);

  const completed = await install(value, NOW + 60_000);

  expect(completed).toBe(SYSTEM_MONITORS.length);
  expect(systemAutomationInstallationComplete(completed)).toBe(true);
  expect(value.service.list(CONTROLLER_KEY)).toHaveLength(SYSTEM_MONITORS.length);
});

it("reinstalls upkeep after self-maintenance was switched off and on again", async () => {
  const value = fixture();
  await install(value);
  for (const binding of value.service.list(CONTROLLER_KEY)) {
    await value.service.retire({
      id: binding.id,
      scope: { kind: "host_path", hostId: "host_a", cwd: null },
      now: NOW + 1,
    });
  }
  expect(value.service.list(CONTROLLER_KEY)).toEqual([]);

  await expect(install(value, NOW + 2)).resolves.toBe(SYSTEM_MONITORS.length);

  expect(value.service.list(CONTROLLER_KEY).every((binding) => binding.state === "active")).toBe(true);
});

it("installs nothing until an owner is paired", async () => {
  const value = fixture({ paired: false });

  await expect(install(value)).resolves.toBe(0);

  expect(value.fake.create).not.toHaveBeenCalled();
});

it("installs nothing until the controller has a verified BB host and project", async () => {
  const value = fixture({ spawned: false });

  await expect(install(value)).resolves.toBe(0);

  expect(value.fake.create).not.toHaveBeenCalled();
});

it("does not spend the owner's armed-monitor budget on legacy upkeep rows", () => {
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

  installLegacyRows(store);

  expect(store.listSystemMonitors()).toHaveLength(SYSTEM_MONITORS.length);
});

it("fires a legacy system monitor as an ordinary follow-up turn until it is handed to BB", async () => {
  const { store } = fixture();
  installLegacyRows(store);
  const due = store.listSystemMonitors()
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
  installLegacyRows(store);

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

it("hides legacy upkeep rows from the owner's monitor list", () => {
  const { store } = fixture();
  installLegacyRows(store);
  store.createMonitor({
    controllerKey: CONTROLLER_KEY, kind: "schedule", cron: "0 9 * * *",
    instruction: "my own watch", dueAt: NOW + 86_400_000, now: NOW,
  });

  const owned = store.listMonitors(CONTROLLER_KEY, true);

  expect(owned).toHaveLength(1);
  expect(owned[0]?.instruction).toBe("my own watch");
  expect(store.listSystemMonitors()).toHaveLength(SYSTEM_MONITORS.length);
});

it("retires legacy upkeep rows when self-maintenance is switched off", () => {
  const { store } = fixture();
  installLegacyRows(store);
  expect(store.listSystemMonitors().every((each) => each.state === "armed")).toBe(true);
  const ownWatch = store.createMonitor({
    controllerKey: CONTROLLER_KEY, kind: "schedule", cron: "0 9 * * *",
    instruction: "my own watch", dueAt: NOW + 86_400_000, now: NOW,
  });

  expect(store.cancelSystemMonitors(NOW + 1_000)).toBe(SYSTEM_MONITORS.length);

  expect(store.listSystemMonitors().every((each) => each.state === "cancelled")).toBe(true);
  // Switching off upkeep must not touch a watch the owner set themselves.
  expect(store.listMonitors(CONTROLLER_KEY, true).find((each) => each.id === ownWatch.id)?.state).toBe("armed");
  expect(store.listMonitors(CONTROLLER_KEY, false)).toHaveLength(1);
});

it("surfaces a project that a failed job has locked", () => {
  const { store } = fixture();
  store.upsertProjectPolicy(policyFixture({ projectId: "proj_a", alias: "a" }), NOW);
  const job = store.createJob({ id: "job_dead", sourceUpdateId: 7_777, requestText: "ship it", now: NOW });
  const selected = store.applyJobEvent(job.id, job.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_a",
    policyVersion: 1,
    policy: policyFixture({ projectId: "proj_a", alias: "a" }),
  }, NOW + 1);
  const admitted = admitConfirmedJob(store, selected, NOW + 2);
  store.applyJobEvent(admitted.id, admitted.version, { type: "FAILED", error: "npm run check exited 1" }, NOW + 3);

  const scorecard = store.buildAutonomyScorecard({ now: NOW + 4, windowMs: 7 * 86_400_000 });

  // Nothing expires this claim, so the owner must be told it exists.
  expect(scorecard.projectsHeldByFailedJobs).toMatchObject([{ jobId: "job_dead", projectId: "proj_a" }]);
});

it("reports no locked project when nothing has failed", () => {
  const { store } = fixture();

  expect(store.buildAutonomyScorecard({ now: NOW, windowMs: 7 * 86_400_000 }).projectsHeldByFailedJobs).toEqual([]);
});
