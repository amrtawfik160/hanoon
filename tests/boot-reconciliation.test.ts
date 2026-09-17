import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { buildWorkerThreadTitle } from "../src/agent-skills/role-resolver";
import {
  BOOT_ORPHAN_RETIRE_REASON,
  decideBootReconciliation,
  type BootJobSnapshot,
} from "../src/domain/boot-reconciliation";
import {
  persistJobTransition,
  readJobById,
} from "../src/storage/job-persistence";
import { readJobLedger } from "../src/storage/job-ledger";
import { reconcileJobsOnBoot } from "../src/storage/boot-reconciliation";
import { reconcileBootFromGitAndBb } from "../src/services/boot-reconciliation-service";
import { openStore } from "../src/storage/store";
import { policyFixture, sha } from "./helpers";

const HEAD = sha("c");
const OTHER_HEAD = sha("d");

function storeFixture(pluginId: string) {
  const { bb } = createFakePluginHost({ pluginId });
  return { bb, db: bb.storage.database(), store: openStore(bb.storage) };
}

function implementingSnapshot(overrides: Partial<BootJobSnapshot> = {}): BootJobSnapshot {
  return {
    ledger: {
      id: "job_live",
      stage: "implementing",
      branch: "feat/intake",
      head: HEAD,
    },
    implementationThreadId: "thr_impl",
    reviewThreadId: null,
    documentationThreadId: null,
    ...overrides,
  };
}

function sourceUpdateId(id: string): number {
  let value = 900;
  for (const char of id) value = (value * 33 + char.charCodeAt(0)) >>> 0;
  return value;
}

function insertImplementingJob(
  db: ReturnType<typeof storeFixture>["db"],
  row: {
    id: string;
    threadId: string | null;
    branch: string;
    head: string;
    state?: string;
  },
): void {
  db.prepare(
    `INSERT INTO jobs (
       id, source_update_id, request_text, state, adopted_branch, adopted_head_sha, pr_head_sha,
       implementation_thread_id, review_cycle, review_block_at, version, created_at, updated_at
     ) VALUES (?, ?, 'work', ?, ?, ?, ?, ?, 0, 3, 1, 1, 1)`,
  ).run(
    row.id,
    sourceUpdateId(row.id),
    row.state ?? "implementing",
    row.branch,
    row.head,
    row.head,
    row.threadId,
  );
  db.prepare(
    `INSERT INTO job_ledger (id, stage, branch, head, updated_at) VALUES (?, ?, ?, ?, 1)`,
  ).run(row.id, row.state ?? "implementing", row.branch, row.head);
}

it("resumes a killed mid-job at the same ledger stage, branch, and head", () => {
  const snapshot = implementingSnapshot();
  expect(decideBootReconciliation({
    jobs: [snapshot],
    git: [{ jobId: snapshot.ledger.id, branch: snapshot.ledger.branch, head: snapshot.ledger.head }],
    threads: [{
      threadId: "thr_impl",
      jobId: snapshot.ledger.id,
      role: "implementation",
    }],
  })).toEqual({
    jobs: [{ action: "resume", row: snapshot.ledger }],
    threads: [{
      action: "adopt",
      threadId: "thr_impl",
      jobId: snapshot.ledger.id,
      slot: "implementation",
    }],
  });
});

it("does not advance the ledger when git moved ahead of the recorded head", () => {
  const snapshot = implementingSnapshot();
  const plan = decideBootReconciliation({
    jobs: [snapshot],
    git: [{ jobId: snapshot.ledger.id, branch: snapshot.ledger.branch, head: OTHER_HEAD }],
    threads: [],
  });
  expect(plan.jobs).toEqual([{ action: "resume", row: snapshot.ledger }]);
  expect(plan.jobs[0]?.row.head).toBe(HEAD);
  expect(plan.jobs[0]?.row.stage).toBe("implementing");
});

it("adopts an unbound worker thread that still belongs to the live stage", () => {
  expect(decideBootReconciliation({
    jobs: [implementingSnapshot({ implementationThreadId: null })],
    git: [],
    threads: [{ threadId: "thr_spawned", jobId: "job_live", role: "implementation" }],
  }).threads).toEqual([{
    action: "adopt",
    threadId: "thr_spawned",
    jobId: "job_live",
    slot: "implementation",
  }]);
});

it("retires a leftover worker thread that is not the live job's current worker", () => {
  expect(decideBootReconciliation({
    jobs: [implementingSnapshot()],
    git: [],
    threads: [
      { threadId: "thr_impl", jobId: "job_live", role: "implementation" },
      { threadId: "thr_plan", jobId: "job_live", role: "plan" },
    ],
  }).threads).toEqual([
    {
      action: "adopt",
      threadId: "thr_impl",
      jobId: "job_live",
      slot: "implementation",
    },
    {
      action: "retire",
      threadId: "thr_plan",
      jobId: "job_live",
      reason: BOOT_ORPHAN_RETIRE_REASON,
    },
  ]);
});

it("retires a worker thread whose job is no longer live", () => {
  expect(decideBootReconciliation({
    jobs: [{
      ledger: { id: "job_dead", stage: "cancelled", branch: "feat/intake", head: HEAD },
      implementationThreadId: "thr_impl",
      reviewThreadId: null,
      documentationThreadId: null,
    }],
    git: [],
    threads: [{ threadId: "thr_impl", jobId: "job_dead", role: "implementation" }],
  }).threads).toEqual([{
    action: "retire",
    threadId: "thr_impl",
    jobId: "job_dead",
    reason: BOOT_ORPHAN_RETIRE_REASON,
  }]);
});

it("retires a worker thread whose job row is gone", () => {
  expect(decideBootReconciliation({
    jobs: [],
    git: [],
    threads: [{ threadId: "thr_lost", jobId: "job_gone", role: "review" }],
  }).threads).toEqual([{
    action: "retire",
    threadId: "thr_lost",
    jobId: "job_gone",
    reason: BOOT_ORPHAN_RETIRE_REASON,
  }]);
});

it("ignores controller threads that are not pipeline workers", () => {
  expect(decideBootReconciliation({
    jobs: [implementingSnapshot()],
    git: [],
    threads: [
      { threadId: "thr_impl", jobId: "job_live", role: "implementation" },
      { threadId: "thr_controller", jobId: null, role: null },
    ],
  }).threads).toEqual([{
    action: "adopt",
    threadId: "thr_impl",
    jobId: "job_live",
    slot: "implementation",
  }]);
});

it("kill-restart-resume returns the same stage, branch, and head", () => {
  const { store, db } = storeFixture("boot-kill-restart");
  insertImplementingJob(db, {
    id: "job_live",
    threadId: "thr_impl",
    branch: "feat/intake",
    head: HEAD,
  });

  const before = readJobLedger(db, "job_live");
  const plan = reconcileJobsOnBoot(db, {
    git: [{ jobId: "job_live", branch: "feat/intake", head: HEAD }],
    threads: [{
      threadId: "thr_impl",
      title: buildWorkerThreadTitle({
        jobId: "job_live",
        attemptId: "attempt_1",
        role: "implementation",
      }),
    }],
  }, 9_000);

  expect(plan.jobs).toEqual([{
    action: "resume",
    row: { id: "job_live", stage: "implementing", branch: "feat/intake", head: HEAD },
  }]);
  expect(readJobLedger(db, "job_live")).toEqual(before);
  expect(readJobById(db, "job_live")).toMatchObject({
    state: "implementing",
    implementationThreadId: "thr_impl",
    version: 1,
  });
  expect(store.getJob("job_live")?.state).toBe("implementing");
});

it("adopts an unbound live worker onto the job without moving the ledger", () => {
  const { db } = storeFixture("boot-adopt");
  insertImplementingJob(db, {
    id: "job_live",
    threadId: null,
    branch: "feat/intake",
    head: HEAD,
  });

  reconcileJobsOnBoot(db, {
    git: [{ jobId: "job_live", branch: "feat/intake", head: HEAD }],
    threads: [{
      threadId: "thr_spawned",
      title: buildWorkerThreadTitle({
        jobId: "job_live",
        attemptId: "attempt_1",
        role: "implementation",
      }),
    }],
  }, 9_100);

  expect(readJobLedger(db, "job_live")).toEqual({
    id: "job_live",
    stage: "implementing",
    branch: "feat/intake",
    head: HEAD,
  });
  expect(readJobById(db, "job_live")?.implementationThreadId).toBe("thr_spawned");
  expect(readJobById(db, "job_live")?.version).toBe(1);
});

it("retires an orphaned thread with an owner-visible outcome", () => {
  const { db } = storeFixture("boot-orphan");
  insertImplementingJob(db, {
    id: "job_dead",
    threadId: "thr_impl",
    branch: "feat/intake",
    head: HEAD,
    state: "cancelled",
  });

  const plan = reconcileJobsOnBoot(db, {
    git: [],
    threads: [{
      threadId: "thr_impl",
      title: buildWorkerThreadTitle({
        jobId: "job_dead",
        attemptId: "attempt_1",
        role: "implementation",
      }),
    }],
  }, 9_200);

  expect(plan.threads).toEqual([{
    action: "retire",
    threadId: "thr_impl",
    jobId: "job_dead",
    reason: BOOT_ORPHAN_RETIRE_REASON,
  }]);
  expect(readJobLedger(db, "job_dead")).toEqual({
    id: "job_dead",
    stage: "cancelled",
    branch: "feat/intake",
    head: HEAD,
  });
  const effects = db.prepare(
    `SELECT kind, payload_json FROM effects WHERE job_id = 'job_dead' ORDER BY kind`,
  ).all() as Array<{ kind: string; payload_json: string }>;
  expect(effects).toEqual([
    { kind: "render_status", payload_json: "{}" },
    {
      kind: "stop_thread",
      payload_json: JSON.stringify({
        resourceId: "thr_impl",
        resourceKind: "bb_thread",
        workerKind: "implementation",
      }),
    },
  ]);
});

it("does not enqueue a second retire when boot runs again", () => {
  const { db } = storeFixture("boot-orphan-idempotent");
  insertImplementingJob(db, {
    id: "job_dead",
    threadId: "thr_impl",
    branch: "feat/intake",
    head: HEAD,
    state: "cancelled",
  });
  const observations = {
    git: [],
    threads: [{
      threadId: "thr_impl",
      title: buildWorkerThreadTitle({
        jobId: "job_dead",
        attemptId: "attempt_1",
        role: "implementation",
      }),
    }],
  };

  reconcileJobsOnBoot(db, observations, 9_300);
  reconcileJobsOnBoot(db, observations, 9_400);

  expect(db.prepare("SELECT COUNT(*) AS count FROM effects WHERE job_id = 'job_dead'").get())
    .toEqual({ count: 2 });
});

it("retires a worker thread whose job row is gone with an owner-visible notice", async () => {
  const { db } = storeFixture("boot-missing-job");
  const retired: string[] = [];
  const notices: string[] = [];

  const plan = await reconcileBootFromGitAndBb(db, {
    listThreads: async () => [{
      threadId: "thr_lost",
      title: buildWorkerThreadTitle({
        jobId: "job_gone",
        attemptId: "attempt_1",
        role: "review",
      }),
    }],
    observeGit: async () => null,
    retireMissingJobThread: async (threadId) => {
      retired.push(threadId);
    },
    notifyOwner: (notice) => {
      notices.push(notice.text);
    },
  }, 10_000);

  expect(plan.threads).toEqual([{
    action: "retire",
    threadId: "thr_lost",
    jobId: "job_gone",
    reason: BOOT_ORPHAN_RETIRE_REASON,
  }]);
  expect(retired).toEqual(["thr_lost"]);
  expect(notices).toEqual([BOOT_ORPHAN_RETIRE_REASON]);
});

it("leaves a job unmoved when a later transition is rejected after boot resume", () => {
  const { store, db } = storeFixture("boot-resume-reject");
  const created = store.createJob({ id: "job_1", sourceUpdateId: 101, requestText: "do it", now: 1_000 });
  store.applyJobEvent(created.id, created.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  }, 1_100);
  reconcileJobsOnBoot(db, { git: [], threads: [] }, 1_200);
  const afterBoot = readJobById(db, created.id)!;
  expect(readJobLedger(db, created.id)?.stage).toBe("awaiting_confirmation");

  expect(() => persistJobTransition(db, afterBoot.id, afterBoot.version, {
    ...afterBoot,
    state: "not-a-stage" as typeof afterBoot.state,
    version: afterBoot.version + 1,
    updatedAt: 1_300,
  })).toThrow(/ledger stage/i);
  expect(readJobLedger(db, created.id)).toEqual({
    id: created.id,
    stage: "awaiting_confirmation",
    branch: "",
    head: "",
  });
});
