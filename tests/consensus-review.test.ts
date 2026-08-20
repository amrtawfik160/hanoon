import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { ProjectPolicy } from "../src/domain/models";
import { projectResourceKey } from "../src/autonomy/models";
import { resolveConsensusExecution } from "../src/domain/stage-execution";
import { EffectRunner } from "../src/services/effect-runner";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

/**
 * A change that needed two rounds of review fixes, on a project that merges
 * without asking. Instead of asking the owner straight away, one extra review
 * of the exact approved head runs on a provider the job's reviewer did not use.
 * Only a clean pass merges it; anything else is the owner's call after all.
 */

const HEAD = "a".repeat(40);
/** The status card only renders a real 22-character job id. */
const JOB_ID = "consensusreviewjob1234";
const OWNER = "owner-consensus";
let fixtureNumber = 0;

function unattendedPolicy(overrides: Partial<ProjectPolicy> = {}): ProjectPolicy {
  const base = policyFixture();
  return policyFixture({
    production: {
      ...base.production!,
      rollbackCommand: { name: "rollback", command: "./rollback.sh", timeoutMs: 60_000 },
    },
    autonomy: { unattendedMerge: true, mergeWithoutProduction: false },
    ...overrides,
  });
}

function awaitingApproval(policy: ProjectPolicy): {
  bb: ReturnType<typeof createFakePluginHost>["bb"];
  store: TelegramAgentStore;
  db: Database.Database;
  jobId: string;
  generation: number;
} {
  const { bb } = createFakePluginHost({ pluginId: `telegram-consensus-${fixtureNumber++}` });
  const db = bb.storage.database();
  const store = openStore(bb.storage);
  store.createPairingCode("a".repeat(64), 1_000, 3_000);
  expect(store.pairOwnerWithCode("a".repeat(64), "7", "7", 1_001)).toEqual({ ok: true });
  const job = store.createJob({
    id: JOB_ID,
    sourceUpdateId: 1,
    requestText: "fix the retry loop",
    now: 1_000,
  });
  db.prepare(
    `UPDATE jobs SET state = 'awaiting_merge_approval', project_id = ?, policy_version = 1, policy_json = ?,
       environment_id = 'env_1', implementation_thread_id = 'thr_impl', pr_number = 19,
       pr_url = 'https://github.com/acme/cyndra/pull/19', pr_head_sha = ?, review_cycle = 2, version = 2
     WHERE id = ?`,
  ).run(policy.projectId, JSON.stringify(policy), HEAD, job.id);
  store.upsertProjectPolicy(policy, 1_000);
  const lease = store.acquireExecutorLease(OWNER, 1_002, 60_000);
  if (!lease.acquired) throw new Error("executor lease was not acquired");
  db.prepare(
    `INSERT INTO job_admissions (job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at)
     VALUES (?, ?, 1, 'admitted', 'CONFIRMED', 1000, 1001)`,
  ).run(job.id, policy.projectId);
  db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at
     ) VALUES (?, ?, 'project', 'held', ?, ?, ?, 1002, 1002)`,
  ).run(job.id, projectResourceKey(policy.projectId), OWNER, lease.generation, 10_000_000);
  return { bb, store, db, jobId: job.id, generation: lease.generation };
}

function enqueue(db: Database.Database, jobId: string, kind: string, key: string, payload: unknown): void {
  db.prepare(
    `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, 1000, 1000, 1000)`,
  ).run(key, jobId, kind, JSON.stringify(payload));
}

async function runEffect(
  fixture: ReturnType<typeof awaitingApproval>,
  key: string,
  now: number,
  bb: Record<string, unknown> = {},
): Promise<void> {
  const claimed = fixture.store.leaseNextJobEffect({
    jobId: fixture.jobId,
    ownerId: OWNER,
    generation: fixture.generation,
    now,
    leaseMs: 60_000,
  });
  if (!claimed || claimed.idempotencyKey !== key) {
    throw new Error(`expected to lease ${key}, got ${claimed?.idempotencyKey ?? "nothing"}`);
  }
  await new EffectRunner({
    store: fixture.store,
    fence: { ownerId: OWNER, generation: fixture.generation, signal: new AbortController().signal },
    bb,
    now: () => now,
  }).run(claimed);
  // The executor settles its own lease; without that the next effect cannot be
  // claimed and the job would look stuck.
  fixture.store.completeEffect(key, OWNER, fixture.generation, now);
}

function settleConsensus(
  fixture: ReturnType<typeof awaitingApproval>,
  outcome: "pass" | "changes_requested",
  findings: unknown[] = [],
): void {
  const attempt = fixture.store.getConsensusReviewAttempt(fixture.jobId, HEAD);
  if (!attempt) throw new Error("consensus attempt was never created");
  fixture.db.prepare("UPDATE attempts SET result_json = ?, completed_at = 2000 WHERE id = ?").run(
    JSON.stringify({
      outcome,
      reasons: outcome === "pass" ? [] : ["changes_requested reason"],
      findings,
      reviewedHeadSha: HEAD,
      verdict: {
        verdict: outcome,
        reviewedHeadSha: HEAD,
        summary: `${outcome} summary`,
        findings,
        checks: [],
      },
    }),
    attempt.id,
  );
}

describe("a second opinion before an unattended merge", () => {
  it("asks for one instead of approving a change that needed two rounds of fixes", async () => {
    const fixture = awaitingApproval(unattendedPolicy());
    enqueue(fixture.db, fixture.jobId, "issue_approval", "job:2:issue_approval", { headSha: HEAD });

    await runEffect(fixture, "job:2:issue_approval", 2_000);

    // Nothing approved, nothing asked: the job waits exactly where it was.
    expect(fixture.store.getJob(fixture.jobId)?.state).toBe("awaiting_merge_approval");
    const kinds = fixture.store.listEffectsForJob(fixture.jobId).map((effect) => effect.kind);
    expect(kinds).toContain("spawn_consensus_review");
    expect(kinds).not.toContain("merge_pr");
  });

  it("spawns it on a provider the job's own review stage did not use", async () => {
    const fixture = awaitingApproval(unattendedPolicy());
    enqueue(fixture.db, fixture.jobId, "issue_approval", "job:2:issue_approval", { headSha: HEAD });
    await runEffect(fixture, "job:2:issue_approval", 2_000);
    const spawnConsensusReview = vi.fn(async () => ({ id: "thr_consensus", environmentId: "env_1" }));
    const spawnKey = fixture.store.listEffectsForJob(fixture.jobId)
      .find((effect) => effect.kind === "spawn_consensus_review")?.idempotencyKey;
    if (!spawnKey) throw new Error("consensus spawn effect missing");

    await runEffect(fixture, spawnKey, 2_100, { spawnConsensusReview });

    expect(spawnConsensusReview).toHaveBeenCalledTimes(1);
    const attempt = fixture.store.getConsensusReviewAttempt(fixture.jobId, HEAD);
    expect(attempt).toMatchObject({
      jobId: fixture.jobId,
      kind: "review",
      reviewLens: "consensus",
      reviewStage: "consensus",
      headSha: HEAD,
      threadId: "thr_consensus",
    });
    // Still no approval and no merge: the pass has not said anything yet.
    expect(fixture.store.getJob(fixture.jobId)?.state).toBe("awaiting_merge_approval");
  });

  it("asks for at most one pass per head, whatever re-fires the approval effect", async () => {
    const fixture = awaitingApproval(unattendedPolicy());
    enqueue(fixture.db, fixture.jobId, "issue_approval", "job:2:issue_approval", { headSha: HEAD });
    await runEffect(fixture, "job:2:issue_approval", 2_000);
    const first = fixture.store.listEffectsForJob(fixture.jobId)
      .filter((effect) => effect.kind === "spawn_consensus_review");

    // The executor restarts and re-fires the stage's own effect, as a resume does.
    const job = fixture.store.getJob(fixture.jobId)!;
    enqueue(fixture.db, fixture.jobId, "issue_approval", `job:${job.version}:issue_approval:again`, { headSha: HEAD });
    const claimed = fixture.store.leaseNextJobEffect({
      jobId: fixture.jobId,
      ownerId: OWNER,
      generation: fixture.generation,
      now: 2_200,
      leaseMs: 60_000,
    });
    if (!claimed) throw new Error("no effect to lease");
    await new EffectRunner({
      store: fixture.store,
      fence: { ownerId: OWNER, generation: fixture.generation, signal: new AbortController().signal },
      bb: { spawnConsensusReview: async () => ({ id: "thr_consensus", environmentId: "env_1" }) },
      now: () => 2_200,
    }).run(claimed);

    expect(fixture.store.listEffectsForJob(fixture.jobId)
      .filter((effect) => effect.kind === "spawn_consensus_review")).toHaveLength(first.length);
  });

  it("merges on a clean pass of the exact head", async () => {
    const fixture = awaitingApproval(unattendedPolicy());
    enqueue(fixture.db, fixture.jobId, "issue_approval", "job:2:issue_approval", { headSha: HEAD });
    await runEffect(fixture, "job:2:issue_approval", 2_000);
    const spawnKey = fixture.store.listEffectsForJob(fixture.jobId)
      .find((effect) => effect.kind === "spawn_consensus_review")!.idempotencyKey;
    await runEffect(fixture, spawnKey, 2_100, {
      spawnConsensusReview: async () => ({ id: "thr_consensus", environmentId: "env_1" }),
    });
    settleConsensus(fixture, "pass");

    // What the settled pass triggers: the approval decision, made again.
    const job = fixture.store.getJob(fixture.jobId)!;
    const settled = fixture.store.applyJobEvent(fixture.jobId, job.version, {
      type: "CONSENSUS_SETTLED",
      headSha: HEAD,
    }, 2_200);
    const approvalKey = fixture.store.listEffectsForJob(fixture.jobId)
      .filter((effect) => effect.kind === "issue_approval" && effect.status === "pending")
      .at(-1)!.idempotencyKey;
    expect(settled.state).toBe("awaiting_merge_approval");
    await runEffect(fixture, approvalKey, 2_300);

    expect(fixture.store.getJob(fixture.jobId)?.state).toBe("merging");
    expect(fixture.store.listMergeAuthorityEvents(unattendedPolicy().projectId)
      .map((event) => event.action)).toContain("used");
  });

  it("asks the owner when the second opinion found anything", async () => {
    const fixture = awaitingApproval(unattendedPolicy());
    enqueue(fixture.db, fixture.jobId, "issue_approval", "job:2:issue_approval", { headSha: HEAD });
    await runEffect(fixture, "job:2:issue_approval", 2_000);
    const spawnKey = fixture.store.listEffectsForJob(fixture.jobId)
      .find((effect) => effect.kind === "spawn_consensus_review")!.idempotencyKey;
    await runEffect(fixture, spawnKey, 2_100, {
      spawnConsensusReview: async () => ({ id: "thr_consensus", environmentId: "env_1" }),
    });
    settleConsensus(fixture, "changes_requested", [{
      severity: "high",
      file: "src/auth.ts",
      line: 9,
      title: "Missing authorization",
      details: "The operation does not verify the owner.",
    }]);

    const job = fixture.store.getJob(fixture.jobId)!;
    fixture.store.applyJobEvent(fixture.jobId, job.version, { type: "CONSENSUS_SETTLED", headSha: HEAD }, 2_200);
    const approvalKey = fixture.store.listEffectsForJob(fixture.jobId)
      .filter((effect) => effect.kind === "issue_approval" && effect.status === "pending")
      .at(-1)!.idempotencyKey;
    await runEffect(fixture, approvalKey, 2_300);

    // Back to the owner: an approval to tap, and no merge on this project's grant.
    expect(fixture.store.getJob(fixture.jobId)?.state).toBe("awaiting_merge_approval");
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE job_id = ?").get(fixture.jobId))
      .toEqual({ count: 1 });
    expect(fixture.store.listMergeAuthorityEvents(unattendedPolicy().projectId)
      .map((event) => event.action)).not.toContain("used");
  });

  it("asks the owner outright when the capability router owns the model tuple", async () => {
    // The only cause under test is `active` routing: this project has a
    // perfectly good independent route, and the pass still cannot be promised
    // to run anywhere the review did not.
    const policy = unattendedPolicy({
      stageExecution: { review: { providerId: "claude-code", model: "claude-opus-5[1m]" } },
    });
    expect(resolveConsensusExecution({
      stageExecution: policy.stageExecution!,
      legacy: { implementation: policy.implementation, review: policy.review },
    })).toMatchObject({ providerId: "codex" });
    const fixture = awaitingApproval(policy);
    fixture.db.prepare("UPDATE jobs SET routing_mode = 'active' WHERE id = ?").run(fixture.jobId);
    enqueue(fixture.db, fixture.jobId, "issue_approval", "job:2:issue_approval", { headSha: HEAD });

    await runEffect(fixture, "job:2:issue_approval", 2_000);

    expect(fixture.store.listEffectsForJob(fixture.jobId).map((effect) => effect.kind))
      .not.toContain("spawn_consensus_review");
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE job_id = ?").get(fixture.jobId))
      .toEqual({ count: 1 });
  });

  it("has no route when the pinned one lands back on the reviewer's own provider", () => {
    // The other cause, on its own and with no routing mode in sight. A policy
    // like this is refused where it is parsed; this is the second lock, so a
    // route that reaches here anyway still resolves to "ask the owner".
    expect(resolveConsensusExecution({
      stageExecution: { review: { providerId: "claude-code", model: "claude-opus-5[1m]" } },
      legacy: { implementation: { model: "implementation-model" }, review: { model: "review-model" } },
      consensusReview: { providerId: "claude-code", model: "claude-opus-5[1m]" },
    })).toBeNull();
    // The same pin against a review stage that runs somewhere else is fine.
    expect(resolveConsensusExecution({
      legacy: { implementation: { model: "implementation-model" }, review: { model: "review-model" } },
      consensusReview: { providerId: "claude-code", model: "claude-opus-5[1m]" },
    })).toMatchObject({ providerId: "claude-code", model: "claude-opus-5[1m]" });
  });

  it("resumes the pass it already started when the executor restarts mid-review", async () => {
    const fixture = awaitingApproval(unattendedPolicy());
    enqueue(fixture.db, fixture.jobId, "issue_approval", "job:2:issue_approval", { headSha: HEAD });
    await runEffect(fixture, "job:2:issue_approval", 2_000);
    const spawnKey = fixture.store.listEffectsForJob(fixture.jobId)
      .find((effect) => effect.kind === "spawn_consensus_review")!.idempotencyKey;
    await runEffect(fixture, spawnKey, 2_100, {
      spawnConsensusReview: async () => ({ id: "thr_consensus", environmentId: "env_1" }),
    });
    const started = fixture.store.getConsensusReviewAttempt(fixture.jobId, HEAD);
    expect(started?.completedAt).toBeNull();

    // The executor dies with the pass still running and comes back as a fresh
    // store over the same database file, holding nothing in memory.
    const restarted = openStore(fixture.bb.storage, fixture.bb.storage.kv);
    expect(restarted.getConsensusReviewAttempt(fixture.jobId, HEAD)).toMatchObject({
      id: started!.id,
      threadId: "thr_consensus",
      reviewLens: "consensus",
      completedAt: null,
    });

    // And the approval decision, made again after the restart, waits for that
    // pass rather than starting a second one.
    const job = restarted.getJob(fixture.jobId)!;
    enqueue(fixture.db, fixture.jobId, "issue_approval", `job:${job.version}:issue_approval:restart`, { headSha: HEAD });
    const claimed = restarted.leaseNextJobEffect({
      jobId: fixture.jobId,
      ownerId: OWNER,
      generation: fixture.generation,
      now: 2_200,
      leaseMs: 60_000,
    });
    if (!claimed) throw new Error("no effect to lease after the restart");
    const spawnAgain = vi.fn(async () => ({ id: "thr_consensus_2", environmentId: "env_1" }));
    await new EffectRunner({
      store: restarted,
      fence: { ownerId: OWNER, generation: fixture.generation, signal: new AbortController().signal },
      bb: { spawnConsensusReview: spawnAgain },
      now: () => 2_200,
    }).run(claimed);

    expect(spawnAgain).not.toHaveBeenCalled();
    expect(restarted.listEffectsForJob(fixture.jobId)
      .filter((effect) => effect.kind === "spawn_consensus_review")).toHaveLength(1);
    expect(restarted.getConsensusReviewAttempt(fixture.jobId, HEAD)?.id).toBe(started!.id);
  });
});
