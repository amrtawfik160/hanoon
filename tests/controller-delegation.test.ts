import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { openStore } from "../src/storage/store";

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
