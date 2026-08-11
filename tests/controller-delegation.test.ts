import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { openStore } from "../src/storage/store";
import {
  DELEGATION_JOIN_TIMEOUT_MS,
  MonitorService,
  type MonitorThreadStatus,
} from "../src/services/monitor-service";

let fixtureNumber = 0;

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-delegation-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001)).toEqual({ ok: true });
  return { bb, store };
}

const CONTROLLER_KEY = "owner-7-controller";

function openDelegation(store: ReturnType<typeof fixture>["store"], instruction = "summarise both") {
  return store.createDelegation({ controllerKey: CONTROLLER_KEY, instruction, now: 2_000 });
}

it("appends the delegation migration after every shipped one", () => {
  expect(ALL_MIGRATIONS).toHaveLength(20);
  expect(ALL_MIGRATIONS[19]).toContain("CREATE TABLE delegations");
  expect(ALL_MIGRATIONS[19]).toContain("CREATE TABLE delegation_threads");
});

it("opens a delegation with no members yet", () => {
  const { store } = fixture();

  const delegation = openDelegation(store);

  expect(delegation).toMatchObject({ state: "open", instruction: "summarise both", threads: [] });
});

it("records members in the order they were spawned", () => {
  const { store } = fixture();
  const delegation = openDelegation(store);

  expect(store.addDelegationThread({
    delegationId: delegation.id, threadId: "thr_a", projectId: "proj_a", title: "invoice spike", now: 2_001,
  })).toBe(true);
  expect(store.addDelegationThread({
    delegationId: delegation.id, threadId: "thr_b", projectId: "proj_b", title: "billing latency", now: 2_002,
  })).toBe(true);

  expect(store.getDelegation(delegation.id)?.threads).toEqual([
    { threadId: "thr_a", projectId: "proj_a", title: "invoice spike", state: "running", summary: null, settledAt: null },
    { threadId: "thr_b", projectId: "proj_b", title: "billing latency", state: "running", summary: null, settledAt: null },
  ]);
});

it("refuses to fan out past its member cap", () => {
  const { store } = fixture();
  const delegation = openDelegation(store);
  for (const index of [0, 1, 2, 3]) {
    expect(store.addDelegationThread({
      delegationId: delegation.id, threadId: `thr_${index}`, projectId: "proj_a", title: `task ${index}`, now: 2_001,
    })).toBe(true);
  }

  expect(() => store.addDelegationThread({
    delegationId: delegation.id, threadId: "thr_5", projectId: "proj_a", title: "one too many", now: 2_002,
  })).toThrow(/at most 4 threads/);
});

it("refuses a third open delegation for one controller", () => {
  const { store } = fixture();
  openDelegation(store, "first");
  openDelegation(store, "second");

  expect(() => openDelegation(store, "third")).toThrow(/at most 2 delegations/);
});

it("frees a slot once a delegation stops being open", () => {
  const { store } = fixture();
  const first = openDelegation(store, "first");
  openDelegation(store, "second");

  expect(store.cancelDelegation(first.id, 2_003)).toBe(true);

  expect(openDelegation(store, "third")).toMatchObject({ state: "open" });
});

it("settles a member exactly once", () => {
  const { store } = fixture();
  const delegation = openDelegation(store);
  store.addDelegationThread({
    delegationId: delegation.id, threadId: "thr_a", projectId: "proj_a", title: "invoice spike", now: 2_001,
  });

  expect(store.settleDelegationThread({
    delegationId: delegation.id, threadId: "thr_a", state: "finished", summary: "  found  the  cause ", now: 2_005,
  })).toBe(true);
  expect(store.settleDelegationThread({
    delegationId: delegation.id, threadId: "thr_a", state: "failed", summary: "later poll", now: 2_006,
  })).toBe(false);

  expect(store.getDelegation(delegation.id)?.threads[0]).toMatchObject({
    state: "finished",
    summary: "found the cause",
    settledAt: 2_005,
  });
});

it("clips a long member summary", () => {
  const { store } = fixture();
  const delegation = openDelegation(store);
  store.addDelegationThread({
    delegationId: delegation.id, threadId: "thr_a", projectId: "proj_a", title: "long", now: 2_001,
  });

  store.settleDelegationThread({
    delegationId: delegation.id, threadId: "thr_a", state: "finished", summary: "x".repeat(5_000), now: 2_005,
  });

  const summary = store.getDelegation(delegation.id)?.threads[0]?.summary ?? "";
  expect(summary).toHaveLength(600);
  expect(summary.endsWith("…")).toBe(true);
});

it.each([
  ["an env-var assignment", "exported AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY", "wJalrXUtnFEMIK7MDENGbPxRfiCY"],
  ["an AWS key id", "the run used AKIAIOSFODNN7EXAMPLE to authenticate", "AKIAIOSFODNN7EXAMPLE"],
  ["a GitHub token", "gh auth used ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["a bearer header", "sent Authorization: bearer eyJhbGciOiJIUzI1NiJ9", "eyJhbGciOiJIUzI1NiJ9"],
  ["a private key block", "-----BEGIN RSA PRIVATE KEY----- MIIEpAIBAAKCAQEA", "MIIEpAIBAAKCAQEA"],
])("withholds a member summary carrying %s", (_label, output, leaked) => {
  const { store } = fixture();
  const delegation = openDelegation(store);
  store.addDelegationThread({
    delegationId: delegation.id, threadId: "thr_a", projectId: "proj_a", title: "secrets", now: 2_001,
  });

  store.settleDelegationThread({
    delegationId: delegation.id, threadId: "thr_a", state: "finished", summary: output, now: 2_005,
  });

  const summary = store.getDelegation(delegation.id)?.threads[0]?.summary ?? "";
  expect(summary).toContain("withheld");
  expect(summary).not.toContain(leaked);
});

it("keeps ordinary output that merely mentions a secret", () => {
  const { store } = fixture();
  const delegation = openDelegation(store);
  store.addDelegationThread({
    delegationId: delegation.id, threadId: "thr_a", projectId: "proj_a", title: "ordinary", now: 2_001,
  });

  store.settleDelegationThread({
    delegationId: delegation.id,
    threadId: "thr_a",
    state: "finished",
    summary: "the deploy failed because the secret store was unreachable",
    now: 2_005,
  });

  expect(store.getDelegation(delegation.id)?.threads[0]?.summary)
    .toBe("the deploy failed because the secret store was unreachable");
});

it("fires an open delegation exactly once", () => {
  const { store } = fixture();
  const delegation = openDelegation(store);

  expect(store.recordDelegationFired({ id: delegation.id, now: 2_010 })).toBe(true);
  expect(store.recordDelegationFired({ id: delegation.id, now: 2_011 })).toBe(false);

  expect(store.getDelegation(delegation.id)).toMatchObject({ state: "fired", firedAt: 2_010 });
});

it("lists only open delegations for the due pass", () => {
  const { store } = fixture();
  const open = openDelegation(store, "still going");
  const done = openDelegation(store, "already fired");
  store.recordDelegationFired({ id: done.id, now: 2_010 });

  expect(store.listOpenDelegations(10).map((delegation) => delegation.id)).toEqual([open.id]);
});

function joinService(
  store: ReturnType<typeof fixture>["store"],
  statuses: Record<string, MonitorThreadStatus>,
  outputs: Record<string, string> = {},
  now = () => 3_000,
) {
  const status = vi.fn(async (threadId: string) => statuses[threadId] ?? "active");
  const output = vi.fn(async (threadId: string) => outputs[threadId] ?? "");
  return {
    service: new MonitorService({ store, threads: { status, output }, clock: { now } }),
    status,
    output,
  };
}

function twoMemberDelegation(store: ReturnType<typeof fixture>["store"]) {
  const delegation = store.createDelegation({
    controllerKey: CONTROLLER_KEY,
    instruction: "compare both and tell me which is worse",
    now: 2_000,
  });
  store.addDelegationThread({
    delegationId: delegation.id, threadId: "thr_a", projectId: "proj_a", title: "invoice spike", now: 2_001,
  });
  store.addDelegationThread({
    delegationId: delegation.id, threadId: "thr_b", projectId: "proj_b", title: "billing latency", now: 2_002,
  });
  return delegation;
}

function joinedTurn(store: ReturnType<typeof fixture>["store"]) {
  return store.listControllerTurns(CONTROLLER_KEY, 10)
    .find((turn) => turn.inputText.startsWith("Work you delegated has finished."));
}

it("waits while any delegated thread is still working", async () => {
  const { store } = fixture();
  const delegation = twoMemberDelegation(store);
  const { service } = joinService(store, { thr_a: "idle", thr_b: "active" }, { thr_a: "found it" });

  await expect(service.processDueDelegations()).resolves.toBe(false);

  expect(store.getDelegation(delegation.id)).toMatchObject({ state: "open" });
  expect(store.getDelegation(delegation.id)?.threads.map((member) => member.state))
    .toEqual(["finished", "running"]);
  expect(joinedTurn(store)).toBeUndefined();
});

it("fires one joined turn naming every member once the last lands", async () => {
  const { store } = fixture();
  const delegation = twoMemberDelegation(store);
  const { service } = joinService(
    store,
    { thr_a: "idle", thr_b: "idle" },
    { thr_a: "the retry loop doubled the invoices", thr_b: "p99 is 4s on the billing read" },
  );

  await expect(service.processDueDelegations()).resolves.toBe(true);

  const turn = joinedTurn(store);
  expect(turn?.inputText).toContain("compare both and tell me which is worse");
  expect(turn?.inputText).toContain("invoice spike (thr_a): finished — the retry loop doubled the invoices");
  expect(turn?.inputText).toContain("billing latency (thr_b): finished — p99 is 4s on the billing read");
  expect(store.getDelegation(delegation.id)).toMatchObject({ state: "fired" });

  // A later pass must not enqueue the join a second time.
  await expect(service.processDueDelegations()).resolves.toBe(false);
  expect(store.listControllerTurns(CONTROLLER_KEY, 10)
    .filter((each) => each.inputText.startsWith("Work you delegated has finished."))).toHaveLength(1);
});

it("reports a failed member instead of dropping it", async () => {
  const { store } = fixture();
  twoMemberDelegation(store);
  const { service, output } = joinService(
    store,
    { thr_a: "error", thr_b: "idle" },
    { thr_a: "should never be quoted", thr_b: "clean run" },
  );

  await expect(service.processDueDelegations()).resolves.toBe(true);

  expect(joinedTurn(store)?.inputText).toContain("invoice spike (thr_a): failed");
  expect(joinedTurn(store)?.inputText).not.toContain("should never be quoted");
  expect(output).not.toHaveBeenCalledWith("thr_a");
});

it("fires with an honest note when a member outlives the join deadline", async () => {
  const { store } = fixture();
  twoMemberDelegation(store);
  const { service } = joinService(
    store,
    { thr_a: "idle", thr_b: "active" },
    { thr_a: "done early" },
    () => 2_000 + DELEGATION_JOIN_TIMEOUT_MS,
  );

  await expect(service.processDueDelegations()).resolves.toBe(true);

  expect(joinedTurn(store)?.inputText)
    .toContain("billing latency (thr_b): still running when the deadline passed");
});

it("leaves a delegation open when BB cannot be reached", async () => {
  const { store } = fixture();
  const delegation = twoMemberDelegation(store);
  const status = vi.fn(async () => { throw new Error("BB unreachable"); });
  const service = new MonitorService({
    store,
    threads: { status, output: async () => "" },
    clock: { now: () => 3_000 },
    warn: () => undefined,
  });

  await expect(service.processDueDelegations()).resolves.toBe(false);

  expect(store.getDelegation(delegation.id)).toMatchObject({ state: "open" });
});
