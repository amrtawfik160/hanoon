import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { resolveMergeGrant } from "../src/services/merge-authority";
import { openStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

let fixtureNumber = 0;
const NOW = 1_800_000_000_000;
const PROJECT = "proj_alpha";

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-merge-authority-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  store.createPairingCode(hashSecret("pair"), NOW - 10_000, NOW + 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", NOW - 5_000)).toEqual({ ok: true });
  return store;
}

it("has no standing approval until the owner grants one", () => {
  expect(fixture().getMergeAuthority(PROJECT)).toBeNull();
});

it("records who granted the standing approval and when", () => {
  const store = fixture();
  const grant = store.grantMergeAuthority({ projectId: PROJECT, userId: "7", chatId: "9", now: NOW });

  expect(grant).toMatchObject({
    projectId: PROJECT,
    grantedAt: NOW,
    grantedByUserId: "7",
    grantedByChatId: "9",
    revokedAt: null,
  });
  expect(store.getMergeAuthority(PROJECT)).toEqual(grant);
});

it("withdraws the standing approval with a reason", () => {
  const store = fixture();
  store.grantMergeAuthority({ projectId: PROJECT, userId: "7", chatId: "9", now: NOW });

  expect(store.revokeMergeAuthority({
    projectId: PROJECT,
    reason: "rollback failed after a bad deploy",
    now: NOW + 1_000,
  })).toBe(true);
  expect(store.getMergeAuthority(PROJECT)).toMatchObject({
    revokedAt: NOW + 1_000,
    revokedReason: "rollback failed after a bad deploy",
  });
});

it("reports nothing withdrawn when there was no live approval to withdraw", () => {
  const store = fixture();
  expect(store.revokeMergeAuthority({ projectId: PROJECT, reason: "nothing here", now: NOW })).toBe(false);

  store.grantMergeAuthority({ projectId: PROJECT, userId: "7", chatId: "9", now: NOW });
  expect(store.revokeMergeAuthority({ projectId: PROJECT, reason: "first", now: NOW + 1 })).toBe(true);
  expect(store.revokeMergeAuthority({ projectId: PROJECT, reason: "again", now: NOW + 2 })).toBe(false);
});

it("re-opens a withdrawn approval when the owner grants it again", () => {
  const store = fixture();
  store.grantMergeAuthority({ projectId: PROJECT, userId: "7", chatId: "9", now: NOW });
  store.revokeMergeAuthority({ projectId: PROJECT, reason: "changed my mind", now: NOW + 1_000 });

  const regranted = store.grantMergeAuthority({ projectId: PROJECT, userId: "7", chatId: "9", now: NOW + 2_000 });
  expect(regranted).toMatchObject({ grantedAt: NOW + 2_000, revokedAt: null, revokedReason: null });
});

it("keeps an audit trail of every grant, withdrawal, and unattended merge", () => {
  const store = fixture();
  store.grantMergeAuthority({ projectId: PROJECT, userId: "7", chatId: "9", now: NOW });
  store.recordMergeAuthorityUse({ projectId: PROJECT, jobId: "job_1", now: NOW + 100 });
  store.revokeMergeAuthority({
    projectId: PROJECT,
    reason: "production broke",
    now: NOW + 200,
    userId: "7",
    chatId: "9",
  });

  const events = store.listMergeAuthorityEvents(PROJECT);
  expect(events.map((event) => event.action)).toEqual(["revoked", "used", "granted"]);
  expect(events[1]).toMatchObject({ action: "used", jobId: "job_1" });
  expect(events[0]).toMatchObject({ action: "revoked", reason: "production broke", actorUserId: "7" });
});

it("keeps each project's standing approval separate", () => {
  const store = fixture();
  store.grantMergeAuthority({ projectId: PROJECT, userId: "7", chatId: "9", now: NOW });

  expect(store.getMergeAuthority("proj_beta")).toBeNull();
  expect(store.getMergeAuthority(PROJECT)?.revokedAt).toBeNull();
});

function policyGrantFixture(store: ReturnType<typeof fixture>, storedAt: number) {
  return store.upsertProjectPolicy(policyFixture({
    projectId: PROJECT,
    production: {
      deployCommands: [{ name: "deploy", command: "./deploy.sh", timeoutMs: 60_000 }],
      canaryCommands: [{ name: "canary", command: "./canary.sh", timeoutMs: 60_000 }],
      rollbackCommand: { name: "rollback", command: "./rollback.sh", timeoutMs: 60_000 },
      convexDeployRequired: false,
    },
    autonomy: { unattendedMerge: true, mergeWithoutProduction: false },
  }), storedAt);
}

function liveGrant(store: ReturnType<typeof fixture>) {
  return resolveMergeGrant({
    projectId: PROJECT,
    policy: store.getProjectPolicy(PROJECT)?.policy ?? null,
    evidence: store.getMergeGrantEvidence(PROJECT),
  });
}

it("reads the grant, the last withdrawal, and when the policy was stored together", () => {
  const store = fixture();
  policyGrantFixture(store, NOW);

  expect(store.getMergeGrantEvidence(PROJECT)).toEqual({
    grant: null,
    revokedAt: null,
    policyStoredAt: NOW,
  });
  expect(liveGrant(store)).toEqual({ source: "policy" });
});

it("withdraws a grant the project policy declares, which has no row to clear", () => {
  const store = fixture();
  policyGrantFixture(store, NOW);

  expect(store.revokeMergeAuthority({
    projectId: PROJECT,
    reason: "the owner withdrew it",
    now: NOW + 1_000,
  })).toBe(true);
  expect(store.getMergeGrantEvidence(PROJECT).revokedAt).toBe(NOW + 1_000);
  expect(liveGrant(store)).toBeNull();
  expect(store.listMergeAuthorityEvents(PROJECT).map((event) => event.action)).toEqual(["revoked"]);
});

it("restores a withdrawn policy grant when the owner enables the project again", () => {
  const store = fixture();
  policyGrantFixture(store, NOW);
  store.revokeMergeAuthority({ projectId: PROJECT, reason: "the owner withdrew it", now: NOW + 1_000 });

  policyGrantFixture(store, NOW + 2_000);

  expect(liveGrant(store)).toEqual({ source: "policy" });
});

it("stays withdrawn when the project is enabled again without the grant", () => {
  const store = fixture();
  policyGrantFixture(store, NOW);
  store.revokeMergeAuthority({ projectId: PROJECT, reason: "the owner withdrew it", now: NOW + 1_000 });
  store.upsertProjectPolicy(policyFixture({ projectId: PROJECT }), NOW + 2_000);

  expect(liveGrant(store)).toBeNull();
});

it("records nothing when a project has no authority of either kind to withdraw", () => {
  const store = fixture();
  store.upsertProjectPolicy(policyFixture({ projectId: PROJECT }), NOW);

  expect(store.revokeMergeAuthority({ projectId: PROJECT, reason: "nothing here", now: NOW + 1 })).toBe(false);
  expect(store.listMergeAuthorityEvents(PROJECT)).toEqual([]);
});
