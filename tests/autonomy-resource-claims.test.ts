import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { JobEvent } from "../src/domain/models";
import {
  productionResourceKey,
  projectResourceKey,
  repositoryMergeResourceKey,
} from "../src/autonomy/models";
import { projectResourceWait } from "../src/storage/autonomy-repository";
import { openStore } from "../src/storage/store";
import { policyFixture, productionPolicyFixture, sha } from "./helpers";

const NOW = 1_000;
const LEASE_OWNER = "task-8-executor";
const LEASE_GENERATION = 1;
const HEAD = sha();

type ResourcePolicy = ReturnType<typeof policyFixture>;

function seedAdmittedMergeJob(
  db: ReturnType<typeof openFixture>["db"],
  store: ReturnType<typeof openFixture>["store"],
  input: {
    id: string;
    sourceUpdateId: number;
    queueSeq: number;
    policy: ResourcePolicy;
  },
): void {
  const approvalNonceHash = input.id === "job_a" ? "a".repeat(64) : "b".repeat(64);
  const effectKey = `${input.id}:2:merge_pr`;
  const approvalExpiresAt = NOW + 60_000;

  store.createJob({
    id: input.id,
    sourceUpdateId: input.sourceUpdateId,
    requestText: `private request for ${input.id}`,
    now: NOW,
  });
  db.prepare(
    `UPDATE jobs SET state = 'merging', project_id = ?, policy_version = 1,
       policy_json = ?, environment_id = ?, pr_number = ?, pr_url = ?,
       pr_head_sha = ?, version = 2, updated_at = ? WHERE id = ?`,
  ).run(
    input.policy.projectId,
    JSON.stringify(input.policy),
    `env-${input.id}`,
    input.queueSeq,
    `https://github.com/${input.policy.githubRepository}/pull/${input.queueSeq}`,
    HEAD,
    NOW,
    input.id,
  );
  db.prepare(
    `INSERT INTO attempts (id, job_id, kind, ordinal, head_sha, result_json, created_at, completed_at)
       VALUES (?, ?, 'review', 1, ?, ?, ?, ?)`,
  ).run(`review-${input.id}`, input.id, HEAD, JSON.stringify({ outcome: "pass" }), NOW, NOW + 1);
  db.prepare(
    `INSERT INTO approvals (
       nonce_hash, job_id, head_sha, expires_at, consumed_at, outcome,
       owner_user_id, owner_chat_id, job_version
     ) VALUES (?, ?, ?, ?, ?, 'accepted', '7', '70', 1)`,
  ).run(approvalNonceHash, input.id, HEAD, approvalExpiresAt, NOW + 2);
  db.prepare(
    `INSERT INTO job_admissions (
       job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at
     ) VALUES (?, ?, ?, 'admitted', 'CONFIRMED', ?, ?)`,
  ).run(input.id, input.policy.projectId, input.queueSeq, NOW, NOW + 1);
  db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at
     ) VALUES (?, ?, 'project', 'held', ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    projectResourceKey(input.policy.projectId),
    LEASE_OWNER,
    LEASE_GENERATION,
    NOW + 60_000,
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, 'merge_pr', ?, 'pending', 0, ?, ?, ?)`,
  ).run(
    effectKey,
    input.id,
    JSON.stringify({
      headSha: HEAD,
      reviewAttemptId: `review-${input.id}`,
      approvalNonceHash,
      approvalOwnerUserId: "7",
      approvalOwnerChatId: "70",
      approvalJobVersion: 1,
      approvalExpiresAt,
    }),
    NOW,
    NOW,
    NOW,
  );
}

function insertMergeClaim(
  db: ReturnType<typeof openFixture>["db"],
  input: {
    jobId: string;
    resourceKey: string;
    resourceKind: "repository_merge" | "production_target";
    ownerId?: string;
    generation?: number;
    leaseExpiresAt?: number;
  },
): void {
  db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at
     ) VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?)`,
  ).run(
    input.jobId,
    input.resourceKey,
    input.resourceKind,
    input.ownerId ?? LEASE_OWNER,
    input.generation ?? LEASE_GENERATION,
    input.leaseExpiresAt ?? NOW + 60_000,
    NOW,
    NOW,
  );
}

function seedProductionEffect(
  db: ReturnType<typeof openFixture>["db"],
  store: ReturnType<typeof openFixture>["store"],
  input: {
    id: string;
    sourceUpdateId: number;
    queueSeq: number;
    policy: ResourcePolicy;
    kind?: "deploy_production" | "verify_production";
    state?: "deploying" | "verifying_production";
  },
): string {
  seedAdmittedMergeJob(db, store, input);
  const kind = input.kind ?? "deploy_production";
  const state = input.state ?? (kind === "deploy_production" ? "deploying" : "verifying_production");
  const version = state === "deploying" ? 3 : 4;
  const effectKey = `${input.id}:${version}:${kind}`;
  db.prepare("DELETE FROM effects WHERE job_id = ? AND kind = 'merge_pr'").run(input.id);
  db.prepare(
    `UPDATE jobs SET state = ?, version = ?, environment_id = ?, merge_message = ?,
       merge_commit_sha = ?, merged_at = ?, updated_at = ? WHERE id = ?`,
  ).run(state, version, `env-${input.id}`, "Merged for production", HEAD, new Date(NOW).toISOString(), NOW, input.id);
  insertMergeClaim(db, {
    jobId: input.id,
    resourceKey: productionResourceKey(input.policy),
    resourceKind: "production_target",
  });
  db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, '{}', 'pending', 0, ?, ?, ?)`,
  ).run(effectKey, input.id, kind, NOW, NOW, NOW);
  return effectKey;
}

function durableSnapshot(db: ReturnType<typeof openFixture>["db"], jobId: string): Record<string, unknown> {
  return {
    job: db.prepare("SELECT state, version, last_error, merge_commit_sha FROM jobs WHERE id = ?").get(jobId),
    effects: db.prepare(
      "SELECT idempotency_key, kind, status, attempts, lease_owner, lease_generation, lease_expires_at FROM effects WHERE job_id = ? ORDER BY idempotency_key",
    ).all(jobId),
    admission: db.prepare(
      "SELECT project_id, state, admitted_at, released_at FROM job_admissions WHERE job_id = ?",
    ).get(jobId),
    claims: db.prepare(
      "SELECT resource_key, resource_kind, state, owner_id, generation, lease_expires_at, release_reason FROM job_resource_claims WHERE job_id = ? ORDER BY resource_kind, resource_key",
    ).all(jobId),
  };
}

function openFixture() {
  const { bb } = createFakePluginHost({ pluginId: `task-8-resource-${Math.random()}` });
  const db = bb.storage.database();
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  expect(store.acquireExecutorLease(LEASE_OWNER, NOW, 60_000)).toEqual({
    acquired: true,
    generation: LEASE_GENERATION,
  });
  return { db, store };
}

describe("Task 8 merge resource claims", () => {
  it.each([
    {
      name: "repository casing",
      first: { repository: "Acme/Cyndra", target: "prod-a" },
      second: { repository: "acme/cyndra", target: "prod-b" },
      blocked: ["repository_merge", repositoryMergeResourceKey("acme/cyndra")],
    },
    {
      name: "same explicit production target",
      first: { repository: "acme/one", target: "shared-prod" },
      second: { repository: "acme/one", target: "shared-prod" },
      blocked: [
        "production_target",
        productionResourceKey(policyFixture({
          projectId: "proj_b",
          production: productionPolicyFixture({ targetKey: "shared-prod" }),
        })),
      ],
    },
    {
      name: "different repositories sharing one production target",
      first: { repository: "acme/one", target: "shared-prod" },
      second: { repository: "acme/two", target: "shared-prod" },
      blocked: [
        "production_target",
        productionResourceKey(policyFixture({
          projectId: "proj_b",
          production: productionPolicyFixture({ targetKey: "shared-prod" }),
        })),
      ],
    },
    {
      name: "one repository with different production targets",
      first: { repository: "acme/one", target: "prod-a" },
      second: { repository: "acme/one", target: "prod-b" },
      blocked: ["repository_merge", repositoryMergeResourceKey("acme/one")],
    },
  ] as const)("atomically serializes $name", ({ first, second, blocked }) => {
    const { db, store } = openFixture();
    const firstPolicy = policyFixture({
      projectId: "proj_a",
      githubRepository: first.repository,
      production: productionPolicyFixture({ targetKey: first.target }),
    });
    const secondPolicy = policyFixture({
      projectId: "proj_b",
      githubRepository: second.repository,
      production: productionPolicyFixture({ targetKey: second.target }),
    });
    seedAdmittedMergeJob(db, store, { id: "job_a", sourceUpdateId: 1, queueSeq: 1, policy: firstPolicy });
    seedAdmittedMergeJob(db, store, { id: "job_b", sourceUpdateId: 2, queueSeq: 2, policy: secondPolicy });

    const firstEffect = store.leaseNextJobEffect({
      jobId: "job_a",
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW,
      leaseMs: 30_000,
    });
    expect(firstEffect).toMatchObject({
      idempotencyKey: "job_a:2:merge_pr",
      kind: "merge_pr",
      status: "leased",
    });
    const firstClaimKeys = store
      .listHeldResourceClaims("job_a", 100)
      .filter((claim) => claim.resourceKind !== "project")
      .map((claim) => claim.resourceKey);
    expect(firstClaimKeys).toEqual([
      repositoryMergeResourceKey(first.repository),
      productionResourceKey(firstPolicy),
    ].sort());

    const beforeBlockedClaims = db.prepare(
      `SELECT job_id, resource_key, resource_kind, state, owner_id, generation,
              lease_expires_at, acquired_at, renewed_at
         FROM job_resource_claims ORDER BY claim_id`,
    ).all();
    const beforeBlockedEffect = store.getEffect("job_b", "job_b:2:merge_pr");
    expect(beforeBlockedEffect?.attempts).toBe(0);

    expect(store.leaseNextJobEffect({
      jobId: "job_b",
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW,
      leaseMs: 30_000,
    })).toBeNull();
    expect(store.getEffect("job_b", "job_b:2:merge_pr")?.attempts).toBe(0);
    expect(db.prepare(
      `SELECT job_id, resource_key, resource_kind, state, owner_id, generation,
              lease_expires_at, acquired_at, renewed_at
         FROM job_resource_claims ORDER BY claim_id`,
    ).all()).toEqual(beforeBlockedClaims);
    expect(projectResourceWait({
      jobId: "job_b",
      policy: secondPolicy,
      claims: store.listHeldResourceClaims(null, 100),
    })).toContainEqual({
      kind: blocked[0],
      key: blocked[1],
    });
    expect(projectResourceWait({
      jobId: "job_b",
      policy: secondPolicy,
      claims: store.listHeldResourceClaims(null, 100),
    }).every((entry) =>
      Object.keys(entry).sort().join(",") === "key,kind",
    )).toBe(true);
    expect(JSON.stringify(projectResourceWait({
      jobId: "job_b",
      policy: secondPolicy,
      claims: store.listHeldResourceClaims(null, 100),
    }))).not.toMatch(
      /job_a|private request|deploy-test|canary-test|path/i,
    );
  });

  it("does not report the current job's own merge claims as a wait", () => {
    const { db, store } = openFixture();
    const policy = policyFixture({
      projectId: "proj_own",
      githubRepository: "acme/own",
      production: productionPolicyFixture({ targetKey: "own-prod" }),
    });
    seedAdmittedMergeJob(db, store, { id: "job_own", sourceUpdateId: 4, queueSeq: 1, policy });
    expect(store.leaseNextJobEffect({
      jobId: "job_own",
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW,
      leaseMs: 30_000,
    })).not.toBeNull();

    expect(projectResourceWait({
      jobId: "job_own",
      policy,
      claims: store.listHeldResourceClaims("job_own", 100),
    })).toEqual([]);
  });

  it("finds a live merge blocker after more than 100 released claim rows", () => {
    const { db, store } = openFixture();
    const blockingPolicy = policyFixture({
      projectId: "proj_history",
      githubRepository: "acme/live",
      production: undefined,
    });
    seedAdmittedMergeJob(db, store, {
      id: "job_blocker",
      sourceUpdateId: 7,
      queueSeq: 1,
      policy: blockingPolicy,
    });
    const insertReleasedClaim = db.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at, released_at, release_reason
       ) VALUES (?, ?, 'repository_merge', 'released', ?, 1, 0, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 101; index += 1) {
      insertReleasedClaim.run(
        "job_blocker",
        `repository:history-${index}:merge`,
        "history-owner",
        NOW,
        NOW,
        NOW + 1,
        "history",
      );
    }
    insertMergeClaim(db, {
      jobId: "job_blocker",
      resourceKey: repositoryMergeResourceKey(blockingPolicy.githubRepository),
      resourceKind: "repository_merge",
    });

    const currentHeldClaims = store.listCurrentHeldMergeResourceClaims({
      jobId: "job_waiting",
      policy: blockingPolicy,
      limit: 100,
    });
    expect(currentHeldClaims).toEqual([
      expect.objectContaining({
        jobId: "job_blocker",
        resourceKey: repositoryMergeResourceKey(blockingPolicy.githubRepository),
        state: "held",
      }),
    ]);
    expect(projectResourceWait({
      jobId: "job_waiting",
      policy: blockingPolicy,
      claims: currentHeldClaims,
    })).toEqual([{
      kind: "repository_merge",
      key: repositoryMergeResourceKey(blockingPolicy.githubRepository),
    }]);
  });

  it("finds an exact live merge blocker after more than 100 unrelated live claims", () => {
    const { db, store } = openFixture();
    const blockingPolicy = policyFixture({
      projectId: "proj_live_pressure",
      githubRepository: "zzz/blocker",
      production: undefined,
    });
    seedAdmittedMergeJob(db, store, {
      id: "job_blocker",
      sourceUpdateId: 11,
      queueSeq: 1,
      policy: blockingPolicy,
    });
    for (let index = 0; index < 101; index += 1) {
      insertMergeClaim(db, {
        jobId: "job_blocker",
        resourceKey: `repository:aaa-${String(index).padStart(3, "0")}:merge`,
        resourceKind: "repository_merge",
      });
    }
    insertMergeClaim(db, {
      jobId: "job_blocker",
      resourceKey: repositoryMergeResourceKey(blockingPolicy.githubRepository),
      resourceKind: "repository_merge",
    });

    const currentHeldClaims = store.listCurrentHeldMergeResourceClaims({
      jobId: "job_waiting",
      policy: blockingPolicy,
      limit: 100,
    });
    expect(projectResourceWait({
      jobId: "job_waiting",
      policy: blockingPolicy,
      claims: currentHeldClaims,
    })).toEqual([{
      kind: "repository_merge",
      key: repositoryMergeResourceKey(blockingPolicy.githubRepository),
    }]);
  });

  it("requires the exact held production target before leasing or incrementing production attempts", () => {
    const { db, store } = openFixture();
    const policy = policyFixture({
      projectId: "proj_production_lease",
      githubRepository: "acme/production-lease",
      production: productionPolicyFixture({ targetKey: "production-lease" }),
    });
    const effectKey = seedProductionEffect(db, store, {
      id: "job_production_lease",
      sourceUpdateId: 8,
      queueSeq: 1,
      policy,
    });
    db.prepare(
      `UPDATE job_resource_claims SET state = 'released', lease_expires_at = 0,
         released_at = ?, release_reason = 'test_missing_production_claim'
       WHERE job_id = ? AND resource_kind = 'production_target'`,
    ).run(NOW + 1, "job_production_lease");
    const before = db.prepare(
      "SELECT status, attempts, lease_owner, lease_generation, lease_expires_at FROM effects WHERE idempotency_key = ?",
    ).get(effectKey);

    expect(store.leaseNextJobEffect({
      jobId: "job_production_lease",
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW + 2,
      leaseMs: 30_000,
    })).toBeNull();
    expect(db.prepare(
      "SELECT status, attempts, lease_owner, lease_generation, lease_expires_at FROM effects WHERE idempotency_key = ?",
    ).get(effectKey)).toEqual(before);
  });

  it("renews a production effect only while its exact production claim remains current", () => {
    const { db, store } = openFixture();
    const policy = policyFixture({
      projectId: "proj_production_renew",
      githubRepository: "acme/production-renew",
      production: productionPolicyFixture({ targetKey: "production-renew" }),
    });
    const effectKey = seedProductionEffect(db, store, {
      id: "job_production_renew",
      sourceUpdateId: 9,
      queueSeq: 1,
      policy,
    });
    const leased = store.leaseNextJobEffect({
      jobId: "job_production_renew",
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW,
      leaseMs: 30_000,
    });
    if (!leased) throw new Error("production effect was not leased");
    db.prepare(
      `UPDATE job_resource_claims SET state = 'released', lease_expires_at = 0,
         released_at = ?, release_reason = 'test_lost_production_claim'
       WHERE job_id = ? AND resource_kind = 'production_target'`,
    ).run(NOW + 1, "job_production_renew");
    const before = db.prepare(
      "SELECT status, attempts, lease_expires_at, updated_at FROM effects WHERE idempotency_key = ?",
    ).get(effectKey);

    expect(store.renewJobOperationFences({
      jobId: leased.jobId,
      effectIdempotencyKey: leased.idempotencyKey,
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW + 2,
      leaseMs: 60_000,
    })).toBe(false);
    expect(db.prepare(
      "SELECT status, attempts, lease_expires_at, updated_at FROM effects WHERE idempotency_key = ?",
    ).get(effectKey)).toEqual(before);
  });

  it("rolls back a terminal production event when the exact claim is absent", () => {
    const { db, store } = openFixture();
    const policy = policyFixture({
      projectId: "proj_production_terminal",
      githubRepository: "acme/production-terminal",
      production: productionPolicyFixture({ targetKey: "production-terminal" }),
    });
    seedProductionEffect(db, store, {
      id: "job_production_terminal",
      sourceUpdateId: 10,
      queueSeq: 1,
      policy,
    });
    db.prepare(
      `UPDATE job_resource_claims SET state = 'released', lease_expires_at = 0,
         released_at = ?, release_reason = 'test_missing_terminal_claim'
       WHERE job_id = ? AND resource_kind = 'production_target'`,
    ).run(NOW + 1, "job_production_terminal");
    const before = durableSnapshot(db, "job_production_terminal");

    expect(store.applyExecutorJobEvent({
      jobId: "job_production_terminal",
      expectedVersion: 3,
      event: { type: "DEPLOY_FAILED", reason: "production failed" },
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW + 2,
    })).toBeNull();
    expect(durableSnapshot(db, "job_production_terminal")).toEqual(before);
  });

  it("preserves a non-production terminal path without requiring a production claim", () => {
    const { db, store } = openFixture();
    const policy = policyFixture({
      projectId: "proj_no_production",
      githubRepository: "acme/no-production",
      production: undefined,
    });
    seedAdmittedMergeJob(db, store, { id: "job_no_production", sourceUpdateId: 12, queueSeq: 1, policy });

    const failed = store.applyExecutorJobEvent({
      jobId: "job_no_production",
      expectedVersion: 2,
      event: { type: "MERGE_FAILED", reason: "merge failed before production" },
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW + 1,
    });
    expect(failed).toMatchObject({ state: "failed", version: 3 });
    expect(store.listHeldResourceClaims("job_no_production", 100).filter((claim) => claim.resourceKind === "production_target")).toEqual([]);
  });

  it("rejects all merge and production lifecycle events on public job mutation", () => {
    const cases: Array<{ event: JobEvent; state: "merging" | "deploying" | "verifying_production"; version: number }> = [
      {
        event: { type: "MERGE_SUCCEEDED", message: "merged", mergeCommitSha: HEAD, mergedAt: new Date(NOW).toISOString(), baseContentVerified: true },
        state: "merging",
        version: 2,
      },
      { event: { type: "MERGE_FAILED", reason: "merge failed" }, state: "merging", version: 2 },
      { event: { type: "DEPLOY_SUCCEEDED", summary: "deploy passed" }, state: "deploying", version: 3 },
      { event: { type: "DEPLOY_FAILED", reason: "deploy failed" }, state: "deploying", version: 3 },
      { event: { type: "CANARY_SUCCEEDED", summary: "canary passed" }, state: "verifying_production", version: 4 },
      { event: { type: "CANARY_FAILED", reason: "canary failed" }, state: "verifying_production", version: 4 },
    ];

    for (const [index, testCase] of cases.entries()) {
      const { db, store } = openFixture();
      const jobId = `job_public_lifecycle_${index}`;
      const policy = policyFixture({
        projectId: `proj_public_lifecycle_${index}`,
        githubRepository: `acme/public-lifecycle-${index}`,
        production: productionPolicyFixture({ targetKey: `public-lifecycle-${index}` }),
      });
      seedAdmittedMergeJob(db, store, { id: jobId, sourceUpdateId: 20 + index, queueSeq: index + 1, policy });
      db.prepare(
        `UPDATE jobs SET state = ?, version = ?, environment_id = ?, merge_message = ?,
           merge_commit_sha = ?, merged_at = ?, updated_at = ? WHERE id = ?`,
      ).run(testCase.state, testCase.version, `env-${jobId}`, "Merged", HEAD, new Date(NOW).toISOString(), NOW, jobId);
      const before = durableSnapshot(db, jobId);

      expect(() => store.applyJobEvent(jobId, testCase.version, testCase.event, NOW + 1)).toThrow();
      expect(durableSnapshot(db, jobId)).toEqual(before);
    }
  });

  it("does not lease a malformed admitted merge job when durable project identity disagrees", () => {
    const { db, store } = openFixture();
    const policy = policyFixture({
      projectId: "proj_identity",
      githubRepository: "acme/identity",
      production: productionPolicyFixture({ targetKey: "identity" }),
    });
    seedAdmittedMergeJob(db, store, { id: "job_identity", sourceUpdateId: 30, queueSeq: 1, policy });
    db.prepare("UPDATE job_admissions SET project_id = 'proj_malformed' WHERE job_id = ?").run("job_identity");
    db.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at
       ) VALUES (?, ?, 'project', 'held', ?, ?, ?, ?, ?)`,
    ).run("job_identity", projectResourceKey("proj_malformed"), LEASE_OWNER, LEASE_GENERATION, NOW + 60_000, NOW, NOW);
    const before = durableSnapshot(db, "job_identity");

    expect(store.leaseNextJobEffect({
      jobId: "job_identity",
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW,
      leaseMs: 30_000,
    })).toBeNull();
    expect(durableSnapshot(db, "job_identity")).toEqual(before);
  });

  it("does not expose the legacy merge lease and cannot bypass claims through leaseEffects", () => {
    const { db, store } = openFixture();
    const policy = policyFixture({ githubRepository: "acme/legacy-bypass" });
    seedAdmittedMergeJob(db, store, { id: "job_legacy_bypass", sourceUpdateId: 31, queueSeq: 1, policy });
    const legacy = store as unknown as {
      leaseEffects?: (ownerId: string, generation: number, now: number, limit: number, leaseMs: number) => unknown[];
      leaseMergeEffect?: unknown;
    };
    expect(legacy.leaseMergeEffect).toBeUndefined();
    db.prepare("DELETE FROM job_resource_claims WHERE job_id = ? AND resource_kind = 'project'").run("job_legacy_bypass");
    expect(legacy.leaseEffects?.(LEASE_OWNER, LEASE_GENERATION, NOW, 10, 30_000)).toEqual([]);
    expect(store.getEffect("job_legacy_bypass", "job_legacy_bypass:2:merge_pr")?.attempts).toBe(0);
  });

  it("renews the merge effect and every acquired resource fence together", () => {
    const { db, store } = openFixture();
    const policy = policyFixture({
      projectId: "proj_renew",
      githubRepository: "Acme/Renew",
      production: productionPolicyFixture({ targetKey: "renew-prod" }),
    });
    seedAdmittedMergeJob(db, store, { id: "job_renew", sourceUpdateId: 3, queueSeq: 1, policy });
    const leased = store.leaseNextJobEffect({
      jobId: "job_renew",
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW,
      leaseMs: 30_000,
    });
    if (!leased) throw new Error("merge effect was not leased");

    expect(store.renewJobOperationFences({
      jobId: leased.jobId,
      effectIdempotencyKey: leased.idempotencyKey,
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW + 100,
      leaseMs: 60_000,
    })).toBe(true);
    expect(store.listHeldResourceClaims("job_renew", 100)
      .filter((claim) => claim.state === "held")
      .every((claim) => claim.leaseExpiresAt === NOW + 100 + 60_000)).toBe(true);
  });

  it("lets a successor adopt every claim for the same job without transferring ownership", () => {
    const { db, store } = openFixture();
    const policy = policyFixture({
      projectId: "proj_adopt",
      githubRepository: "acme/adopt",
      production: productionPolicyFixture({ targetKey: "adopt-prod" }),
    });
    seedAdmittedMergeJob(db, store, { id: "job_adopt", sourceUpdateId: 6, queueSeq: 1, policy });
    const leased = store.leaseNextJobEffect({
      jobId: "job_adopt",
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW,
      leaseMs: 30_000,
    });
    if (!leased) throw new Error("merge effect was not leased");

    const successor = store.acquireExecutorLease("task-8-successor", NOW + 60_001, 60_000);
    expect(successor).toEqual({ acquired: true, generation: 2 });
    if (!successor.acquired) throw new Error("successor executor lease was not acquired");
    expect(store.adoptHeldClaims({
      jobId: "job_adopt",
      ownerId: "task-8-successor",
      generation: successor.generation,
      now: NOW + 60_002,
      leaseMs: 60_000,
    })).toBe(true);
    expect(store.renewJobOperationFences({
      jobId: leased.jobId,
      effectIdempotencyKey: leased.idempotencyKey,
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW + 60_002,
      leaseMs: 60_000,
    })).toBe(false);
    expect(store.listHeldResourceClaims("job_adopt", 100)
      .filter((claim) => claim.state === "held")
      .every((claim) => claim.ownerId === "task-8-successor" && claim.generation === 2)).toBe(true);
  });

  it.each([
    { state: "complete" as const, firstEvent: { type: "DEPLOY_SUCCEEDED" as const, summary: "deploy passed" }, secondEvent: { type: "CANARY_SUCCEEDED" as const, summary: "canary passed" } },
    { state: "production_failed" as const, firstEvent: { type: "DEPLOY_FAILED" as const, reason: "deploy failed" }, secondEvent: null },
  ])("settles the production target at $state while preserving merge-time ordering", ({ state, firstEvent, secondEvent }) => {
    const { db, store } = openFixture();
    const policy = policyFixture({
      projectId: `proj_${state}`,
      githubRepository: `acme/${state}`,
      production: productionPolicyFixture({ targetKey: `target-${state}` }),
    });
    seedAdmittedMergeJob(db, store, { id: `job_${state}`, sourceUpdateId: state === "complete" ? 4 : 5, queueSeq: 1, policy });
    const jobId = `job_${state}`;
    expect(store.leaseNextJobEffect({
      jobId,
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW,
      leaseMs: 30_000,
    })).not.toBeNull();
    db.prepare(
      `UPDATE jobs SET state = 'deploying', version = 3, merge_commit_sha = ?,
       merged_at = ?, updated_at = ? WHERE id = ?`,
    ).run(HEAD, new Date(NOW).toISOString(), NOW, jobId);
    db.prepare(
      `UPDATE job_resource_claims SET state = 'released', lease_expires_at = 0,
       released_at = ?, release_reason = ?
       WHERE job_id = ? AND resource_kind = 'repository_merge'`,
    ).run(NOW + 1, "merge_succeeded", jobId);

    const deployed = store.applyExecutorJobEvent({
      jobId,
      expectedVersion: 3,
      event: firstEvent,
      ownerId: LEASE_OWNER,
      generation: LEASE_GENERATION,
      now: NOW + 2,
    });
    expect(deployed?.state).toBe(state === "complete" ? "verifying_production" : "production_failed");
    if (state === "complete") {
      expect(store.listHeldResourceClaims(jobId, 100)).toContainEqual(expect.objectContaining({
        resourceKind: "production_target",
        state: "held",
      }));
      const completed = store.applyExecutorJobEvent({
        jobId,
        expectedVersion: deployed!.version,
        event: secondEvent!,
        ownerId: LEASE_OWNER,
        generation: LEASE_GENERATION,
        now: NOW + 3,
      });
      expect(completed?.state).toBe("complete");
    }
    expect(store.listHeldResourceClaims(jobId, 100).filter((claim) =>
      claim.resourceKind === "production_target" && claim.state === "held",
    )).toHaveLength(0);
  });
});
