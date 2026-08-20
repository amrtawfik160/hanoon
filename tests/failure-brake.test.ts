import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { FailureLoopService } from "../src/services/failure-loop-service";
import { selectOldestEligibleAdmissions } from "../src/autonomy/scheduler";
import { ESCALATION_DEDUP_MS, failureFingerprint } from "../src/autonomy/failure-loop";
import { policyFixture } from "./helpers";

let fixtureNumber = 0;
const CONTROLLER_KEY = "owner-7-controller";
const NOW = 1_800_000_000_000;
const REASON = "npm install failed: ETIMEDOUT registry.npmjs.org";

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-failure-brake-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  store.createPairingCode(hashSecret("pair"), NOW - 10_000, NOW + 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", NOW - 5_000)).toEqual({ ok: true });
  store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY, telegramUserId: "7", telegramChatId: "7",
    updateId: 1, inputText: "hello", now: NOW - 4_000,
  });
  store.upsertProjectPolicy(policyFixture({ projectId: "proj_a", alias: "cyndra" }), NOW - 3_000);
  return Object.assign(store, { __db: bb.storage.database() });
}

function service(store: TelegramAgentStore, now: () => number) {
  let id = 6_000;
  return new FailureLoopService({
    store,
    clock: { now },
    issueUpdateId: () => (id += 1),
    warn: () => undefined,
  });
}

function notices(store: TelegramAgentStore) {
  return store.listControllerTurns(CONTROLLER_KEY, 20).filter((turn) => turn.origin === "system");
}

function submitControllerTurn(store: TelegramAgentStore) {
  const lease = store.acquireExecutorLease("failure-brake-controller", NOW, 30_000);
  if (!lease.acquired) throw new Error("controller lease was not acquired");
  const turn = store.claimNextControllerTurn({
    ownerId: "failure-brake-controller",
    generation: lease.generation,
    now: NOW,
  });
  if (!turn) throw new Error("controller turn was not claimed");
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: "failure-brake-controller",
    generation: lease.generation,
    now: NOW,
    projectId: "proj_a",
    hostId: "host_a",
    threadId: "thr_controller",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: "failure-brake-controller",
    generation: lease.generation,
    now: NOW,
  })).toBe(true);
  return {
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    ownerId: "failure-brake-controller",
    generation: lease.generation,
    now: NOW,
    expectedThreadId: "thr_controller",
  };
}

it("does nothing when no failure is repeating", () => {
  const store = fixture();
  expect(service(store, () => NOW).processDue()).toBe(false);
  expect(notices(store)).toHaveLength(0);
  expect(store.listPausedProjectAdmissions()).toEqual([]);
});

/**
 * Arranges a job that already failed. Written straight to storage on purpose:
 * the detector's contract is with the failed rows, and driving a job through
 * the whole pipeline to reach them would test the pipeline, not the detector.
 */
function failJob(
  store: ReturnType<typeof fixture>,
  id: string,
  reason: string,
  now: number,
): void {
  store.createJob({ id, sourceUpdateId: Number(id.replace(/\D/g, "")), requestText: `task ${id}`, now });
  store.__db.prepare(
    "UPDATE jobs SET state = 'failed', project_id = 'proj_a', last_error = ?, updated_at = ? WHERE id = ?",
  ).run(reason, now, id);
}

it("stops the project and tells the owner once when one failure keeps repeating", () => {
  const store = fixture();
  failJob(store, "job_1", REASON, NOW - 3_000);
  failJob(store, "job_2", REASON, NOW - 2_000);
  failJob(store, "job_3", REASON, NOW - 1_000);

  expect(service(store, () => NOW).processDue()).toBe(true);

  const messages = notices(store);
  expect(messages).toHaveLength(1);
  expect(messages[0].inputText).toContain("stopped starting new work");
  expect(messages[0].inputText).toContain("cyndra");
  expect(store.listPausedProjectAdmissions()).toHaveLength(1);
});

it("leaves the project alone when the failures have different causes", () => {
  const store = fixture();
  failJob(store, "job_1", "the test suite failed", NOW - 3_000);
  failJob(store, "job_2", "the deploy token expired", NOW - 2_000);
  failJob(store, "job_3", "the reviewer blocked it", NOW - 1_000);

  expect(service(store, () => NOW).processDue()).toBe(false);
  expect(store.listPausedProjectAdmissions()).toEqual([]);
});

it("ignores failures that are older than the window", () => {
  const store = fixture();
  const old = NOW - 5 * 60 * 60_000;
  failJob(store, "job_1", REASON, old);
  failJob(store, "job_2", REASON, old);
  failJob(store, "job_3", REASON, old);

  expect(service(store, () => NOW).processDue()).toBe(false);
});

it("does not repeat the message or re-pause while the owner is deciding", () => {
  const store = fixture();
  failJob(store, "job_1", REASON, NOW - 3_000);
  failJob(store, "job_2", REASON, NOW - 2_000);
  failJob(store, "job_3", REASON, NOW - 1_000);
  const detector = service(store, () => NOW);
  detector.processDue();

  failJob(store, "job_4", REASON, NOW - 500);
  // A fresh detector, so the hourly scan gate cannot be what keeps it quiet.
  expect(service(store, () => NOW + 60 * 60_000 + 1).processDue()).toBe(false);
  expect(notices(store)).toHaveLength(1);
});

it("does not escalate a repeated failure twice inside the dedup window", () => {
  const store = fixture();
  const fingerprint = failureFingerprint("proj_a", REASON);
  expect(store.claimFailureEscalation({
    fingerprint, projectId: "proj_a", clusterSize: 3, reason: REASON, now: NOW, dedupMs: ESCALATION_DEDUP_MS,
  })).toBe(true);

  expect(store.claimFailureEscalation({
    fingerprint,
    projectId: "proj_a",
    clusterSize: 4,
    reason: REASON,
    now: NOW + 60_000,
    dedupMs: ESCALATION_DEDUP_MS,
  })).toBe(false);
});

it("escalates the same cause again once the dedup window has expired", () => {
  const store = fixture();
  const fingerprint = failureFingerprint("proj_a", REASON);
  store.claimFailureEscalation({
    fingerprint, projectId: "proj_a", clusterSize: 3, reason: REASON, now: NOW, dedupMs: ESCALATION_DEDUP_MS,
  });

  expect(store.claimFailureEscalation({
    fingerprint,
    projectId: "proj_a",
    clusterSize: 3,
    reason: REASON,
    now: NOW + ESCALATION_DEDUP_MS + 1,
    dedupMs: ESCALATION_DEDUP_MS,
  })).toBe(true);
});

it("pauses and resumes a project's admission", () => {
  const store = fixture();

  expect(store.pauseProjectAdmission({
    projectId: "proj_a", reason: "the same failure repeated 3 times", fingerprint: null, now: NOW,
  })).toBe(true);
  expect(store.listPausedProjectAdmissions()).toEqual([
    { projectId: "proj_a", reason: "the same failure repeated 3 times", pausedAt: NOW },
  ]);

  expect(store.clearProjectAdmissionPause({ projectId: "proj_a", now: NOW + 1_000 })).toBe(1);
  expect(store.listPausedProjectAdmissions()).toEqual([]);
});

it("does not re-stamp a pause that is already in force", () => {
  const store = fixture();
  store.pauseProjectAdmission({ projectId: "proj_a", reason: "first", fingerprint: null, now: NOW });

  expect(store.pauseProjectAdmission({
    projectId: "proj_a", reason: "second", fingerprint: null, now: NOW + 5_000,
  })).toBe(false);
  expect(store.listPausedProjectAdmissions()[0]).toMatchObject({ reason: "first", pausedAt: NOW });
});

it("takes a live brake over for a cause the agent may not lift", () => {
  // A fingerprint is the agent's own way out of a brake. A production that
  // could not be rolled back must not leave the project easier to restart than
  // it already was, so the incident replaces the cause rather than being
  // dropped because something smaller got there first.
  const store = fixture();
  const fence = submitControllerTurn(store);
  const fingerprint = failureFingerprint("proj_a", REASON);
  store.pauseProjectAdmission({ projectId: "proj_a", reason: REASON, fingerprint, now: NOW });

  expect(store.escalateProjectAdmissionPause({
    projectId: "proj_a",
    reason: "rollback failed after a bad deploy",
    now: NOW + 1_000,
  })).toBe(true);

  // What the operator reads is the incident; the brake has been on since the
  // first pause rather than being re-stamped as new.
  expect(store.listPausedProjectAdmissions()).toEqual([
    { projectId: "proj_a", reason: "rollback failed after a bad deploy", pausedAt: NOW },
  ]);
  expect(store.clearProjectAdmissionPauseAsAgent({ projectId: "proj_a", ...fence, now: NOW + 2_000 }))
    .toMatchObject({ outcome: "refused", reason: expect.stringMatching(/owner's call/i) });
  expect(store.listPausedProjectAdmissions()).toHaveLength(1);
});

it("brakes a project the incident found running, and dates that brake from the incident", () => {
  const store = fixture();

  expect(store.escalateProjectAdmissionPause({
    projectId: "proj_a",
    reason: "production deploy failed with no rollback configured",
    now: NOW + 1_000,
  })).toBe(true);

  expect(store.listPausedProjectAdmissions()).toEqual([
    {
      projectId: "proj_a",
      reason: "production deploy failed with no rollback configured",
      pausedAt: NOW + 1_000,
    },
  ]);
});

it("retains an agent clear so the same failure cannot be cleared twice", () => {
  const store = fixture();
  const fence = submitControllerTurn(store);
  const fingerprint = failureFingerprint("proj_a", REASON);
  store.pauseProjectAdmission({ projectId: "proj_a", reason: REASON, fingerprint, now: NOW });

  expect(store.clearProjectAdmissionPauseAsAgent({ projectId: "proj_a", ...fence })).toEqual({
    outcome: "cleared",
  });
  expect(store.pauseProjectAdmission({
    projectId: "proj_a",
    reason: REASON,
    fingerprint,
    now: NOW + 1,
  })).toBe(true);
  expect(store.clearProjectAdmissionPauseAsAgent({
    projectId: "proj_a",
    ...fence,
    now: NOW + 2,
  })).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/already been cleared/i) });
  expect(store.listPausedProjectAdmissions()).toHaveLength(1);
});

it("retains an owner clear so the same failure cannot later be cleared by the agent", () => {
  const store = fixture();
  const fence = submitControllerTurn(store);
  const fingerprint = failureFingerprint("proj_a", REASON);
  store.pauseProjectAdmission({ projectId: "proj_a", reason: REASON, fingerprint, now: NOW });

  expect(store.clearProjectAdmissionPause({ projectId: "proj_a", now: NOW + 1 })).toBe(1);
  expect(store.pauseProjectAdmission({
    projectId: "proj_a",
    reason: REASON,
    fingerprint,
    now: NOW + 2,
  })).toBe(true);

  expect(store.clearProjectAdmissionPauseAsAgent({
    projectId: "proj_a",
    ...fence,
    now: NOW + 3,
  })).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/already been cleared/i) });
  expect(store.listPausedProjectAdmissions()).toHaveLength(1);
});

it("does not clear a brake after the controller fence is lost", () => {
  const store = fixture();
  const fence = submitControllerTurn(store);
  store.pauseProjectAdmission({
    projectId: "proj_a",
    reason: REASON,
    fingerprint: failureFingerprint("proj_a", `${REASON}:new`),
    now: NOW,
  });
  expect(store.releaseExecutorLease(fence.ownerId, fence.generation, NOW)).toBe(true);

  expect(store.clearProjectAdmissionPauseAsAgent({ ...fence, projectId: "proj_a" }))
    .toMatchObject({ outcome: "refused", reason: expect.stringMatching(/controller.*current|fence/i) });
  expect(store.listPausedProjectAdmissions()).toHaveLength(1);
});

it("refuses to start new work on a paused project but not on the others", () => {
  const selected = selectOldestEligibleAdmissions({
    candidates: [
      { jobId: "job_1", projectId: "proj_a", queueSeq: 1 },
      { jobId: "job_2", projectId: "proj_b", queueSeq: 2 },
    ],
    heldProjectKeys: new Set(),
    availableSlots: 5,
    pausedProjectIds: new Set(["proj_a"]),
  });

  expect(selected.map((candidate) => candidate.projectId)).toEqual(["proj_b"]);
});

it("admits normally when nothing is paused", () => {
  const selected = selectOldestEligibleAdmissions({
    candidates: [{ jobId: "job_1", projectId: "proj_a", queueSeq: 1 }],
    heldProjectKeys: new Set(),
    availableSlots: 5,
    pausedProjectIds: new Set(),
  });

  expect(selected).toHaveLength(1);
});

it("never crashes the executor when the scan cannot complete", () => {
  const store = fixture();
  const broken = new FailureLoopService({
    store: {
      ...store,
      listRecentJobFailures: () => { throw new Error("database is gone"); },
      getOwner: () => store.getOwner(),
      getControllerForOwner: (userId: string, chatId: string) => store.getControllerForOwner(userId, chatId),
    } as unknown as TelegramAgentStore,
    clock: { now: () => NOW },
    issueUpdateId: () => 1,
    warn: () => undefined,
  });

  expect(() => broken.processDue()).not.toThrow();
  expect(broken.processDue()).toBe(false);
});
