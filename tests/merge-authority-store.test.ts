import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";

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
