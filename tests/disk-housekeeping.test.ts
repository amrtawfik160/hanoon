import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import {
  assessDiskSpace,
  DISK_CRITICAL_FREE_BYTES,
  DISK_LOW_FREE_BYTES,
  DISPOSABLE_TEMP_MIN_AGE_MS,
  isDisposableTempName,
  planDiskReclaim,
  type TempEntryObservation,
} from "../src/autonomy/disk-space";
import { hashSecret } from "../src/crypto";
import {
  DISK_RECLAIM_BATCH,
  DISK_SCAN_INTERVAL_MS,
  DISK_STARTUP_DELAY_MS,
  DiskHousekeepingService,
  type TempDirectoryAccess,
} from "../src/services/disk-housekeeping-service";
import { openStore } from "../src/storage/store";

const GIB = 1024 ** 3;
const NOW = 1_800_000_000_000;

function entry(overrides: Partial<TempEntryObservation> & { name: string }): TempEntryObservation {
  return {
    isDirectory: true,
    isSymbolicLink: false,
    modifiedAt: NOW - DISPOSABLE_TEMP_MIN_AGE_MS - 1,
    ...overrides,
  };
}

function plan(entries: readonly TempEntryObservation[]) {
  return planDiskReclaim({ entries, now: NOW });
}

it("reads a comfortable volume as fine", () => {
  expect(assessDiskSpace({ freeBytes: 200 * GIB, totalBytes: 450 * GIB }))
    .toMatchObject({ level: "ok" });
});

it("warns before the volume fills, and louder once it nearly has", () => {
  expect(assessDiskSpace({ freeBytes: DISK_LOW_FREE_BYTES - 1, totalBytes: 450 * GIB }))
    .toMatchObject({ level: "low" });
  expect(assessDiskSpace({ freeBytes: DISK_CRITICAL_FREE_BYTES - 1, totalBytes: 450 * GIB }))
    .toMatchObject({ level: "critical" });
});

it("checks the warning boundaries from both sides", () => {
  expect(assessDiskSpace({ freeBytes: DISK_LOW_FREE_BYTES, totalBytes: 450 * GIB }))
    .toMatchObject({ level: "ok" });
  expect(assessDiskSpace({ freeBytes: DISK_CRITICAL_FREE_BYTES, totalBytes: 450 * GIB }))
    .toMatchObject({ level: "low" });
});

it("says it could not tell rather than saying there is plenty", () => {
  // Blind and fine are different facts. Collapsing them is how a check goes
  // quiet during exactly the conditions it exists to catch.
  for (const usage of [
    { freeBytes: Number.NaN, totalBytes: 450 * GIB },
    { freeBytes: 10 * GIB, totalBytes: 0 },
    { freeBytes: -1, totalBytes: 450 * GIB },
  ]) {
    expect(assessDiskSpace(usage)).toMatchObject({ level: "unknown", freeBytes: null });
  }
});

it("reclaims the temp directories this project leaks", () => {
  expect(plan([
    entry({ name: "bb-fake-plugin-host-abc123" }),
    entry({ name: "telegram-agent-frames-xyz" }),
    entry({ name: "hanoon-eval-1" }),
    entry({ name: "eval-integrity-2" }),
  ]).reclaim).toEqual([
    "bb-fake-plugin-host-abc123",
    "telegram-agent-frames-xyz",
    "hanoon-eval-1",
    "eval-integrity-2",
  ]);
});

it("leaves everything it does not recognise alone", () => {
  // The temp directory belongs to the whole machine. Anything unrecognised is
  // somebody else's, and a sweep that reaped by exclusion would take whatever
  // another program starts writing tomorrow.
  const result = plan([
    entry({ name: "systemd-private-9f2" }),
    entry({ name: "postgresql" }),
    entry({ name: ".X11-unix" }),
  ]);

  expect(result.reclaim).toEqual([]);
  expect(result.kept.map((kept) => kept.reason)).toEqual(["not_ours", "not_ours", "not_ours"]);
});

it("keeps a candidate that is too young to be dead", () => {
  const result = plan([
    entry({ name: "bb-fake-plugin-host-live", modifiedAt: NOW - 60_000 }),
  ]);

  expect(result.reclaim).toEqual([]);
  expect(result.kept).toEqual([{ name: "bb-fake-plugin-host-live", reason: "too_young" }]);
});

it("checks the age boundary from both sides", () => {
  expect(plan([entry({ name: "hanoon-a", modifiedAt: NOW - DISPOSABLE_TEMP_MIN_AGE_MS })]).reclaim)
    .toEqual(["hanoon-a"]);
  expect(plan([entry({ name: "hanoon-b", modifiedAt: NOW - DISPOSABLE_TEMP_MIN_AGE_MS + 1 })]).reclaim)
    .toEqual([]);
});

it("keeps anything whose age it cannot read", () => {
  // Fail closed: a check that cannot answer keeps the candidate.
  const result = plan([entry({ name: "hanoon-unreadable", modifiedAt: null })]);

  expect(result.reclaim).toEqual([]);
  expect(result.kept).toEqual([{ name: "hanoon-unreadable", reason: "age_unknown" }]);
});

it("never follows a symlink and never touches a file", () => {
  const result = plan([
    entry({ name: "hanoon-link", isSymbolicLink: true }),
    entry({ name: "hanoon-file", isDirectory: false }),
  ]);

  expect(result.reclaim).toEqual([]);
  expect(result.kept.map((kept) => kept.reason)).toEqual(["symlink", "not_a_directory"]);
});

it("never treats a bare prefix as one of its own instances", () => {
  expect(plan([entry({ name: "hanoon-" })]).reclaim).toEqual([]);
});

function fixture(name: string) {
  const { bb } = createFakePluginHost({ pluginId: `telegram-disk-${name}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  store.createPairingCode(hashSecret("pair"), NOW - 2_000, NOW + 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", NOW - 1_000)).toEqual({ ok: true });
  // The controller exists once the owner has said something to it, which is
  // the only state in which a system notice has anywhere to go.
  store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 1,
    inputText: "hello",
    now: NOW - 500,
  });
  return { store };
}

/** What the agent has been told to do unprompted, oldest first. */
function systemTurns(store: ReturnType<typeof fixture>["store"]): string[] {
  return store.listControllerTurns("owner-7-controller", 20)
    .filter((turn) => turn.origin === "system")
    .map((turn) => turn.inputText);
}

function temp(overrides: Partial<TempDirectoryAccess> = {}): TempDirectoryAccess {
  return {
    list: vi.fn(async () => []),
    remove: vi.fn(async () => undefined),
    usage: vi.fn(async () => ({ freeBytes: 200 * GIB, totalBytes: 450 * GIB })),
    ...overrides,
  };
}

function service(
  store: ReturnType<typeof fixture>["store"],
  access: TempDirectoryAccess,
  options: { armed?: boolean; now?: () => number } = {},
) {
  let updateId = 3_000_000_000;
  return new DiskHousekeepingService({
    store,
    temp: access,
    clock: { now: options.now ?? (() => NOW) },
    issueUpdateId: () => (updateId += 1),
    reclaimArmed: () => options.armed ?? true,
    warn: () => undefined,
  });
}

it("removes what it planned when removal is armed", async () => {
  const { store } = fixture("armed");
  const access = temp({ list: vi.fn(async () => [entry({ name: "bb-fake-plugin-host-old" })]) });

  const outcome = await service(store, access).sweep(NOW);

  expect(outcome.removed).toEqual(["bb-fake-plugin-host-old"]);
  expect(access.remove).toHaveBeenCalledWith("bb-fake-plugin-host-old");
});

it("plans but removes nothing when removal is not armed", async () => {
  const { store } = fixture("unarmed");
  const access = temp({ list: vi.fn(async () => [entry({ name: "bb-fake-plugin-host-old" })]) });

  const outcome = await service(store, access, { armed: false }).sweep(NOW);

  expect(outcome.plan.reclaim).toEqual(["bb-fake-plugin-host-old"]);
  expect(outcome.removed).toEqual([]);
  expect(access.remove).not.toHaveBeenCalled();
});

it("bounds how much one pass will remove", async () => {
  const { store } = fixture("bounded");
  const names = Array.from({ length: DISK_RECLAIM_BATCH + 10 }, (_, index) => `hanoon-${index}`);
  const access = temp({ list: vi.fn(async () => names.map((name) => entry({ name }))) });

  const outcome = await service(store, access).sweep(NOW);

  expect(outcome.removed).toHaveLength(DISK_RECLAIM_BATCH);
});

it("keeps sweeping past a directory that will not go", async () => {
  const { store } = fixture("stubborn");
  const access = temp({
    list: vi.fn(async () => [entry({ name: "hanoon-stuck" }), entry({ name: "hanoon-fine" })]),
    remove: vi.fn(async (name: string) => {
      if (name === "hanoon-stuck") throw new Error("device or resource busy");
    }),
  });

  const outcome = await service(store, access).sweep(NOW);

  expect(outcome.removed).toEqual(["hanoon-fine"]);
});

it("stays quiet while there is room", async () => {
  const { store } = fixture("quiet");

  const outcome = await service(store, temp()).sweep(NOW);

  expect(outcome.notified).toBe(false);
  expect(systemTurns(store)).toEqual([]);
});

it("tells the owner when space runs low, whether or not it reclaimed anything", async () => {
  const { store } = fixture("warns");
  const access = temp({ usage: vi.fn(async () => ({ freeBytes: 3 * GIB, totalBytes: 450 * GIB })) });

  const outcome = await service(store, access).sweep(NOW);

  expect(outcome.notified).toBe(true);
  expect(systemTurns(store)).toHaveLength(1);
  expect(systemTurns(store)[0]).toContain("Disk space is getting low");
});

it("says it once, not on every sweep", async () => {
  const { store } = fixture("dedup");
  const access = temp({ usage: vi.fn(async () => ({ freeBytes: 3 * GIB, totalBytes: 450 * GIB })) });
  const subject = service(store, access);

  expect((await subject.sweep(NOW)).notified).toBe(true);
  expect((await subject.sweep(NOW + 60_000)).notified).toBe(false);
});

it("says it again when low becomes critical", async () => {
  const { store } = fixture("escalates");
  let free = 3 * GIB;
  const access = temp({ usage: vi.fn(async () => ({ freeBytes: free, totalBytes: 450 * GIB })) });
  const subject = service(store, access);

  expect((await subject.sweep(NOW)).notified).toBe(true);
  free = 1 * GIB;
  expect((await subject.sweep(NOW + 60_000)).notified).toBe(true);
});

it("stays silent rather than crying wolf when the volume cannot be read", async () => {
  const { store } = fixture("blind");
  const access = temp({ usage: vi.fn(async () => { throw new Error("statfs failed"); }) });

  const outcome = await service(store, access).sweep(NOW);

  expect(outcome.verdict.level).toBe("unknown");
  expect(outcome.notified).toBe(false);
});

it("still warns when the temp directory itself cannot be read", async () => {
  // The two jobs are independent on purpose: the space is usually being taken
  // by something that is not ours.
  const { store } = fixture("split");
  const access = temp({
    list: vi.fn(async () => { throw new Error("permission denied"); }),
    usage: vi.fn(async () => ({ freeBytes: 1 * GIB, totalBytes: 450 * GIB })),
  });

  const outcome = await service(store, access).sweep(NOW);

  expect(outcome.removed).toEqual([]);
  expect(outcome.notified).toBe(true);
});

it("never walks the temp directory on the executor's first ticks", async () => {
  // The walk is the slowest thing here and a leak makes it slower. On the
  // first tick it would land on top of whatever the owner asked for while the
  // plugin was down, and nothing about it is urgent to the minute.
  const { store } = fixture("startup");
  let now = NOW;
  const access = temp({ list: vi.fn(async () => [entry({ name: "hanoon-old" })]) });
  const subject = service(store, access, { now: () => now });

  await subject.processDue();
  now = NOW + DISK_STARTUP_DELAY_MS - 1;
  await subject.processDue();
  expect(access.list).not.toHaveBeenCalled();

  now = NOW + DISK_STARTUP_DELAY_MS;
  await subject.processDue();
  expect(access.list).toHaveBeenCalledTimes(1);
});

it("sweeps daily, not on every executor tick", async () => {
  const { store } = fixture("paced");
  let now = NOW;
  const access = temp({ list: vi.fn(async () => [entry({ name: "hanoon-old" })]) });
  const subject = service(store, access, { now: () => now });

  await subject.processDue();
  now = NOW + DISK_STARTUP_DELAY_MS;
  await subject.processDue();
  await subject.processDue();
  expect(access.list).toHaveBeenCalledTimes(1);

  now += DISK_SCAN_INTERVAL_MS;
  await subject.processDue();
  expect(access.list).toHaveBeenCalledTimes(2);
});

it("only asks the age of names it could act on", () => {
  // The planner rejects a foreign name before it ever looks at its age, so a
  // caller may skip the syscall — and cannot widen the list by doing so.
  expect(isDisposableTempName("bb-fake-plugin-host-abc")).toBe(true);
  expect(isDisposableTempName("systemd-private-9f2")).toBe(false);
  expect(isDisposableTempName("hanoon-")).toBe(false);
});

it("never lets a broken sweep fail the executor tick", async () => {
  const { store } = fixture("resilient");
  const access = temp({ usage: vi.fn(async () => { throw new Error("statfs exploded"); }) });
  vi.spyOn(store, "getOwner").mockImplementation(() => { throw new Error("store exploded"); });

  await expect(service(store, access).processDue()).resolves.toBe(false);
});
