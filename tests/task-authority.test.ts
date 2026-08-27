import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { projectResourceKey } from "../src/autonomy/models";
import { deriveTaskOutcome, taskAuthorityEffectForOperation } from "../src/domain/task-authority";
import { ownerBoundaryDigest } from "../src/domain/owner-boundary";
import { transition } from "../src/domain/state-machine";
import { EffectRunner, type EffectRunnerDependencies } from "../src/services/effect-runner";
import { resolveMergeGrant } from "../src/services/merge-authority";
import { openStore } from "../src/storage/store";
import { jobFixture, policyFixture, sha } from "./helpers";

let fixtureIndex = 0;
function ownerJobFixture(task: string, policy = policyFixture()) {
  fixtureIndex += 1;
  const { bb } = createFakePluginHost({ pluginId: `task-authority-${fixtureIndex}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 10_000);
  store.createPairingCode(hashSecret("pair"), 1_000, 20_000);
  if (!store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001).ok) throw new Error("owner pairing failed");
  store.upsertProjectPolicy(policy, 1_002);
  store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 701,
    inputText: task,
    now: 2_000,
  });
  const lease = store.acquireExecutorLease("executor", 10_000, 30_000);
  if (!lease.acquired) throw new Error("missing executor lease");
  const turn = store.claimNextControllerTurn({ ownerId: "executor", generation: lease.generation, now: 10_000 });
  if (!turn) throw new Error("missing controller turn");
  if (!store.markControllerSpawned({
    turnId: turn.id, ownerId: "executor", generation: lease.generation, now: 10_000,
    projectId: "proj_1", hostId: "host_1", threadId: "thr_controller",
  })) throw new Error("controller spawn was not recorded");
  if (!store.markControllerTurnSubmitted({ turnId: turn.id, ownerId: "executor", generation: lease.generation, now: 10_000 })) {
    throw new Error("controller submission was not recorded");
  }
  const job = store.createConfirmedControllerJob({ controllerThreadId: "thr_controller", projectId: "proj_1", task, now: 10_001 });
  return { bb, store, job, leaseGeneration: lease.generation };
}

function addOwnerJob(
  fixture: ReturnType<typeof ownerJobFixture>,
  task: string,
  updateId: number,
) {
  fixture.store.enqueueControllerTurn({
    controllerKey: "owner-7-controller-2",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId,
    inputText: task,
    now: 10_010,
  });
  const turn = fixture.store.claimNextControllerTurn({
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now: 10_010,
  });
  if (!turn) throw new Error("second controller turn was not claimed");
  if (!fixture.store.markControllerSpawned({
    turnId: turn.id,
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now: 10_010,
    projectId: "proj_1",
    hostId: "host_1",
    threadId: "thr_controller_2",
  })) throw new Error("second controller was not spawned");
  if (!fixture.store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now: 10_010,
  })) throw new Error("second controller turn was not submitted");
  return fixture.store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller_2",
    projectId: "proj_1",
    task,
    now: 10_011,
  });
}

function prepareApprovalEffect(
  fixture: ReturnType<typeof ownerJobFixture>,
  policy: ReturnType<typeof policyFixture>,
  headSha: string,
): string {
  const db = fixture.bb.storage.database();
  db.prepare(
    `UPDATE jobs SET state = 'awaiting_merge_approval', project_id = ?, policy_version = 1,
       policy_json = ?, environment_id = 'env_1', pr_number = 4,
       pr_url = 'https://github.com/acme/cyndra/pull/4', pr_head_sha = ?, version = 2
     WHERE id = ?`,
  ).run(policy.projectId, JSON.stringify(policy), headSha, fixture.job.id);
  db.prepare(
    `UPDATE job_admissions SET project_id = ?, state = 'admitted', admitted_at = 10003
       WHERE job_id = ?`,
  ).run(policy.projectId, fixture.job.id);
  db.prepare("UPDATE effects SET status = 'done' WHERE job_id = ?").run(fixture.job.id);
  db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at
     ) VALUES (?, ?, 'project', 'held', 'executor', ?, 40003, 10003, 10003)`,
  ).run(fixture.job.id, projectResourceKey(policy.projectId), fixture.leaseGeneration);
  const key = `${fixture.job.id}:2:issue_approval`;
  db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, 'issue_approval', ?, 'pending', 0, 10003, 10003, 10003)`,
  ).run(key, fixture.job.id, JSON.stringify({ headSha }));
  return key;
}

function policyApprovalPayload(
  fixture: ReturnType<typeof ownerJobFixture>,
  policy: ReturnType<typeof policyFixture>,
  headSha: string,
) {
  const authority = fixture.store.getTaskAuthority(fixture.job.id);
  if (!authority) throw new Error("approval task authority is missing");
  return {
    intentVersion: 1,
    jobId: fixture.job.id,
    projectId: policy.projectId,
    controllerKey: authority.controllerKey,
    policyDigest: authority.policyDigest,
    artifactGraphDigest: authority.artifactGraphDigest,
    affectedEffectIdempotencyKey: `${fixture.job.id}:3:merge_pr`,
    affectedEffectKind: "merge_pr",
    headSha,
    operation: "merge",
  };
}

async function runApprovalEffect(
  fixture: ReturnType<typeof ownerJobFixture>,
  key: string,
  now = 10_004,
): Promise<void> {
  const claimed = fixture.store.leaseNextJobEffect({
    jobId: fixture.job.id,
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now,
    leaseMs: 30_000,
  });
  if (!claimed || claimed.idempotencyKey !== key) throw new Error("approval effect was not leased");
  await new EffectRunner({
    store: fixture.store,
    fence: { ownerId: "executor", generation: fixture.leaseGeneration, signal: new AbortController().signal },
    now: () => now,
  }).run(claimed);
}

function boundaryInput(jobId: string, authorityRevision = 1) {
  return {
    jobId,
    authorityRevision,
    now: 10_002,
    code: "policy_change_required" as const,
    goal: "Ship the reviewed retry fix through the configured release path",
    blocker: "This project has no production policy or merge-without-production permission",
    priorChecks: ["The exact pull-request head passed validation", "The review evidence covers the same head"],
    options: [
      { label: "Configure production", consequence: "The task can continue through deploy and canary under policy" },
      { label: "Allow merge without production", consequence: "The task can merge and rely on required checks and regression monitoring" },
    ],
    recommendation: "Configure production because it preserves the task's requested shipped outcome",
    pausedEffect: "The exact-head merge remains paused until this policy decision is recorded",
    evidenceFacts: ["policy:change-required"],
    affectedEffectIdempotencyKey: `${jobId}:merge_pr`,
  };
}

function preparePolicyBoundaryObservation(fixture: ReturnType<typeof ownerJobFixture>) {
  const policy = fixture.store.getJob(fixture.job.id)?.policy;
  if (!policy) throw new Error("policy boundary policy is missing");
  const sourceEffectIdempotencyKey = prepareApprovalEffect(fixture, policy, sha("d"));
  const sourceEffect = fixture.store.leaseNextJobEffect({
    jobId: fixture.job.id,
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now: 10_004,
    leaseMs: 30_000,
  });
  if (!sourceEffect || sourceEffect.idempotencyKey !== sourceEffectIdempotencyKey) {
    throw new Error("policy boundary source was not leased");
  }
  const current = fixture.store.getJob(fixture.job.id);
  if (!current) throw new Error("policy boundary job is missing");
  const affectedEffectIdempotencyKey = `${current.id}:${current.version + 1}:merge_pr`;
  expect(fixture.store.recordExecutorPolicyBoundaryObservation({
    jobId: current.id,
    authorityRevision: 1,
    sourceEffectIdempotencyKey,
    affectedEffectIdempotencyKey,
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now: 10_005,
  })).toBe(true);
  return { sourceEffectIdempotencyKey, affectedEffectIdempotencyKey };
}

function recordPolicyBoundary(fixture: ReturnType<typeof ownerJobFixture>) {
  const { affectedEffectIdempotencyKey } = preparePolicyBoundaryObservation(fixture);
  return fixture.store.recordOwnerBoundary({
    ...boundaryInput(fixture.job.id),
    affectedEffectIdempotencyKey,
  });
}

function insertBoundaryEffect(
  fixture: ReturnType<typeof ownerJobFixture>,
  key: string,
  kind: string,
  payload: Record<string, unknown> = {},
  status = "pending",
  attempts = 0,
): void {
  fixture.bb.storage.database().prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 10002, 10002, 10002)`,
  ).run(key, fixture.job.id, kind, JSON.stringify(payload), status, attempts);
}

function recordExhaustedRecovery(fixture: ReturnType<typeof ownerJobFixture>): void {
  const job = fixture.store.getJob(fixture.job.id);
  if (!job || !job.projectId) throw new Error("recovery job source is missing");
  const recovery = fixture.store.registerExecutorWorkerRecovery({
    id: `recovery_${fixture.job.id}`,
    jobId: job.id,
    expectedVersion: job.version,
    projectId: job.projectId,
    jobState: job.state,
    workerKind: "implementation",
    resourceId: `thr_${job.id}`,
    workerGeneration: 1,
    classification: "crash",
    signature: `signature_${job.id}`,
    retryLimit: job.policy?.workerRecoveryLimit ?? 2,
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now: 10_002,
  });
  if (recovery?.record.state !== "owner_required") throw new Error("recovery exhaustion was not recorded");
}

function authoritativeBoundarySource(
  fixture: ReturnType<typeof ownerJobFixture>,
  code: ReturnType<typeof boundaryInput>["code"] | "product_decision_required" | "scope_expansion_required" |
    "credential_or_access_required" | "spend_authority_required" | "irreversible_effect_required" |
    "technical_tradeoff_required" | "production_recovery_required",
): Readonly<{ affectedArtifactId?: string; affectedEffectIdempotencyKey?: string }> {
  const { store, job, bb } = fixture;
  const db = bb.storage.database();
  if (code === "product_decision_required" || code === "scope_expansion_required") {
    const artifactId = `artifact_${code}_${job.id}`;
    store.captureWorkArtifact({
      artifactId,
      projectId: "proj_1",
      effortId: job.id,
      operationId: `operation_${code}_${job.id}`,
      kind: code === "product_decision_required" ? "decision_ticket" : "implementation_ticket",
      status: "ready",
      trackerKind: "github",
      trackerNamespace: "github:acme/cyndra",
      externalId: `${code}_${job.id}`,
      externalUrl: `https://github.com/acme/cyndra/issues/${code}_${job.id}`,
      externalRevision: "revision-1",
      externalStatus: "open",
      assignees: [],
      title: code,
      content: `# ${code}`,
      acceptanceCriteria: ["The owner decision is recorded"],
      relationships: [],
      capturedAt: 10_002,
    });
    return { affectedArtifactId: artifactId };
  }
  const effectKey = `${job.id}:boundary:${code}`;
  if (code === "credential_or_access_required") {
    store.reconcileCredentialHealth({
      installationId: "install_1",
      health: {
        protocolVersion: 1,
        brokerVersion: "0.1.0",
        adapter: "onepassword",
        adapterState: "ready",
        auditWritable: true,
        bindingCount: 1,
        topologyReceiptDigest: "a".repeat(64),
        topologyReceiptExpiresAt: 99_999,
      },
      bindings: [{
        bindingId: "binding_1",
        label: "Required deployment credential",
        provider: "onepassword",
        state: "pending",
        generation: 1,
        capabilityIds: ["deploy"],
        risk: "high",
        mfaMode: "none",
        approvalMode: "owner_confirmation",
        lastVerifiedAt: null,
      }],
      responseSha256: "b".repeat(64),
      now: 10_002,
    });
    insertBoundaryEffect(fixture, effectKey, "deploy_production", {
      credentialInstallationId: "install_1",
      credentialBindingId: "binding_1",
    });
  } else if (code === "spend_authority_required") {
    const attemptId = `attempt_${job.id}`;
    store.recordStageExecution({
      jobId: job.id,
      attemptId,
      stage: "implementation",
      attemptOrdinal: 1,
      baseTier: "standard",
      tier: "standard",
      escalationSteps: 0,
      source: "default",
      providerId: "codex",
      modelId: "gpt-5.6-terra",
      reasoningLevel: "medium",
      serviceTier: "default",
      now: 10_000,
    });
    store.settleStageExecution({
      jobId: job.id,
      attemptId,
      stage: "implementation",
      outcome: "failed",
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 115 },
      now: 10_001,
    });
    insertBoundaryEffect(fixture, effectKey, "run_navigator_ticket_worker", { attemptId }, "dead", 20);
  } else if (code === "irreversible_effect_required") {
    insertBoundaryEffect(fixture, effectKey, "merge_pr");
  } else if (code === "policy_change_required") {
    db.prepare("UPDATE jobs SET state = 'awaiting_merge_approval', policy_json = ? WHERE id = ?")
      .run(JSON.stringify(policyFixture({ production: undefined })), job.id);
  } else if (code === "technical_tradeoff_required") {
    insertBoundaryEffect(fixture, effectKey, "send_remediation", {}, "dead", 20);
    recordExhaustedRecovery(fixture);
    db.prepare(
      `INSERT INTO attempts (
         id, job_id, kind, review_lens, review_stage, ordinal, thread_id, head_sha,
         result_json, created_at, completed_at
       ) VALUES (?, ?, 'review', 'quality', 'review', 1, 'thr_review', ?, ?, 10001, 10002)`,
    ).run(
      `review_${job.id}`,
      job.id,
      sha("a"),
      JSON.stringify({ findings: [{ severity: "high", ruleId: "tradeoff", summary: "Two safe designs conflict" }] }),
    );
  } else if (code === "production_recovery_required") {
    db.prepare("UPDATE jobs SET state = 'production_failed' WHERE id = ?").run(job.id);
    insertBoundaryEffect(fixture, effectKey, "verify_production", {}, "dead", 20);
    recordExhaustedRecovery(fixture);
    db.prepare(
      `INSERT INTO pipeline_stage_attempts (
         id, job_id, role, ordinal, state, input_sha256, last_error,
         created_at, completed_at, updated_at
       ) VALUES (?, ?, 'CANARY', 1, 'failed', ?, 'canary failed', 10000, 10001, 10001)`,
    ).run(`canary_${job.id}`, job.id, "c".repeat(64));
    const releaseEffectKey = `${job.id}:production-release`;
    insertActiveTaskReleaseReceipt(fixture, releaseEffectKey);
    db.prepare(
      "UPDATE release_authority_receipts SET status = 'consumed', consumed_at = 10001 WHERE effect_idempotency_key = ?",
    ).run(releaseEffectKey);
  }
  return { affectedEffectIdempotencyKey: effectKey };
}

function staleAuthoritativeBoundarySource(
  fixture: ReturnType<typeof ownerJobFixture>,
  code: Parameters<typeof authoritativeBoundarySource>[1],
  affected: ReturnType<typeof authoritativeBoundarySource>,
): void {
  const db = fixture.bb.storage.database();
  if (code === "product_decision_required") {
    db.prepare("UPDATE work_artifacts SET status = 'resolved' WHERE id = ?").run(affected.affectedArtifactId);
  } else if (code === "scope_expansion_required") {
    db.prepare("UPDATE jobs SET artifact_bindings_json = ? WHERE id = ?").run(
      JSON.stringify([{ artifactId: affected.affectedArtifactId, snapshotId: "snapshot", snapshotDigest: "a".repeat(64) }]),
      fixture.job.id,
    );
  } else if (code === "credential_or_access_required") {
    db.prepare("UPDATE credential_bindings SET state = 'active' WHERE installation_id = 'install_1' AND binding_id = 'binding_1'").run();
  } else if (code === "spend_authority_required") {
    db.prepare("UPDATE stage_executions SET total_tokens = 0 WHERE job_id = ?").run(fixture.job.id);
  } else if (code === "irreversible_effect_required") {
    const effect = fixture.store.getEffect(fixture.job.id, affected.affectedEffectIdempotencyKey!);
    if (!effect) throw new Error("irreversible effect source is missing");
    expect(fixture.store.admitTaskAuthorityOperation(effect, "merge", 10_003)).toBe(true);
  } else if (code === "policy_change_required") {
    db.prepare("UPDATE jobs SET policy_json = ? WHERE id = ?")
      .run(JSON.stringify(policyFixture()), fixture.job.id);
  } else if (code === "technical_tradeoff_required") {
    db.prepare("UPDATE effects SET attempts = 19 WHERE idempotency_key = ?")
      .run(affected.affectedEffectIdempotencyKey);
  } else {
    db.prepare("UPDATE jobs SET state = 'complete' WHERE id = ?").run(fixture.job.id);
  }
}

function insertActiveTaskReleaseReceipt(
  fixture: ReturnType<typeof ownerJobFixture>,
  effectIdempotencyKey: string,
): void {
  const authority = fixture.store.getTaskAuthority(fixture.job.id);
  if (!authority) throw new Error("task authority was not recorded");
  fixture.bb.storage.database().prepare(
    `INSERT INTO release_authority_receipts (
       receipt_id, job_id, effect_idempotency_key, authority_id, authority_revision,
       authority_source, project_id, repository, base_branch, environment_id,
       pr_number, head_sha, artifact_graph_digest, review_attempt_id,
       validation_completed_at, required_check_names_json, merge_method,
       production_policy_digest, gate_receipt_digest, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'task', ?, 'acme/cyndra', 'main', 'env_1',
       4, ?, ?, 'review_1', 10002, '["test"]', 'squash', ?, ?, 'active', 10002, 10002)`,
  ).run(
    `receipt_${fixture.job.id}`,
    fixture.job.id,
    effectIdempotencyKey,
    authority.authorityId,
    authority.revision,
    authority.projectId,
    sha("d"),
    authority.artifactGraphDigest,
    "e".repeat(64),
    "f".repeat(64),
  );
}

function publisherEffectFixture(kind: "inspect_implementation" | "resolve_pr_head") {
  const fixture = ownerJobFixture("Fix and ship the retry loop");
  const { bb, store, job } = fixture;
  const db = bb.storage.database();
  const state = kind === "inspect_implementation" ? "locating_pr" : "resolving_pr_head";
  db.prepare("UPDATE effects SET status = 'done' WHERE job_id = ?").run(job.id);
  db.prepare(
    `UPDATE jobs SET state = ?, environment_id = 'env_1', pr_number = 4,
       pr_url = 'https://github.com/acme/cyndra/pull/4', version = 2
     WHERE id = ?`,
  ).run(state, job.id);
  const idempotencyKey = `${job.id}:2:${kind}`;
  db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       lease_owner, lease_generation, lease_expires_at,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, '{}', 'leased', 0, 'executor', ?, 40002, 10002, 10002, 10002)`,
  ).run(idempotencyKey, job.id, kind, fixture.leaseGeneration);
  const effect = store.getEffect(job.id, idempotencyKey);
  if (!effect) throw new Error("publisher effect was not stored");
  const terminal = {
    run: vi.fn(async () => ({
      outcome: "exited" as const,
      exitCode: 0,
      output: '{"number":4,"url":"https://github.com/acme/cyndra/pull/4"}',
    })),
  };
  const runner = new EffectRunner({
    store,
    fence: {
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      signal: new AbortController().signal,
    },
    now: () => 10_002,
    bb: {
      getEnvironmentSnapshot: async () => ({
        status: {
          outcome: "available",
          checkout: { kind: "branch", branchName: "bb/fix-it" },
          worktree: { clean: false },
        },
      }),
      getPullRequestSnapshot: async () => ({
        outcome: "available",
        pullRequest: { number: 4, url: "https://github.com/acme/cyndra/pull/4" },
      }),
    },
    terminal,
    resolvePrHead: async () => ({
      event: "PR_HEAD_RESOLVED" as const,
      headSha: sha("a"),
      originRepository: "acme/cyndra",
    }),
  } as unknown as EffectRunnerDependencies);
  return { ...fixture, effect, runner, terminal };
}

function claimNarrowingUpdate(store: ReturnType<typeof ownerJobFixture>["store"], sourceUpdateId: number, now: number) {
  expect(store.beginTelegramUpdate(sourceUpdateId, now - 1)).toBe("process");
  return {
    sourceMessageId: sourceUpdateId + 1_000,
    replyToMessageId: 900,
    instructionDigest: createHash("sha256")
      .update(`narrow:${sourceUpdateId}`, "utf8")
      .digest("hex"),
  };
}

describe("task outcome derivation", () => {
  it.each([
    ["artifact", "artifact_write"],
    ["prototype", "prototype_write"],
    ["worktree", "worktree_write"],
    ["commit", "commit"],
    ["push", "push"],
    ["pull_request", "pull_request"],
    ["merge", "merge"],
    ["deploy", "deploy"],
    ["rollback", "rollback"],
  ] as const)("maps the executor %s operation to %s authority", (operation, effect) => {
    expect(taskAuthorityEffectForOperation(operation)).toBe(effect);
  });

  it.each([
    ["Fix the retry loop", "shipped_change", []],
    ["Research why the retry loop is slow", "artifact", ["artifact_only"]],
    ["Diagnose the flaky test", "artifact", ["artifact_only"]],
    ["Design the new webhook flow", "artifact", ["artifact_only"]],
    ["Write a specification for the webhook flow", "artifact", ["artifact_only"]],
    ["Create tickets for the migration", "artifact", ["artifact_only"]],
    ["Prepare and open a pull request for the retry fix", "reviewed_change", ["pull_request_only"]],
    ["Fix the retry loop, but do not merge it", "reviewed_change", ["no_merge"]],
    ["Fix the retry loop, but don't deploy it", "reviewed_change", ["no_deploy"]],
    ["Ship the retry fix", "shipped_change", []],
  ] as const)("derives %s as %s", (requestText, outcome, constraints) => {
    expect(deriveTaskOutcome(requestText)).toMatchObject({ outcome, constraints });
  });

  it.each([
    "Research the bug and fix it",
    "Review the pull request and merge it if ready",
    "Update the documentation",
  ])("does not mistake a release request for an artifact request: %s", (requestText) => {
    expect(deriveTaskOutcome(requestText).outcome).toBe("shipped_change");
  });

  it("returns stable request and scope digests", () => {
    const first = deriveTaskOutcome("Fix the retry loop, but do not merge it");
    const second = deriveTaskOutcome("  Fix   the retry loop, but do not merge it. ");

    expect(second).toEqual(first);
    expect(first.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.scopeDigest).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("owner task authority intake", () => {
  it.each([
    ["inspect_implementation", "commit"],
    ["inspect_implementation", "push"],
    ["inspect_implementation", "pull_request"],
    ["resolve_pr_head", "commit"],
    ["resolve_pr_head", "push"],
    ["resolve_pr_head", "pull_request"],
  ] as const)("rejects %s before publisher invocation without current %s authority", async (kind, missing) => {
    const fixture = publisherEffectFixture(kind);
    for (const operation of ["commit", "push", "pull_request"] as const) {
      if (operation !== missing) {
        expect(fixture.store.admitTaskAuthorityOperation(fixture.effect, operation, 10_002)).toBe(true);
      }
    }

    await expect(fixture.runner.run(fixture.effect)).rejects.toThrow(/authority effect admission/i);
    expect(fixture.terminal.run).not.toHaveBeenCalled();
  });

  it.each(["inspect_implementation", "resolve_pr_head"] as const)(
    "executes %s publisher only with the complete current authority revision",
    async (kind) => {
      const fixture = publisherEffectFixture(kind);
      for (const operation of ["commit", "push", "pull_request"] as const) {
        expect(fixture.store.admitTaskAuthorityOperation(fixture.effect, operation, 10_002)).toBe(true);
      }

      await fixture.runner.run(fixture.effect);
      expect(fixture.terminal.run).toHaveBeenCalledTimes(1);
    },
  );

  it("fails closed when an effect kind has no declared authority requirements", () => {
    const { store, job } = ownerJobFixture("Fix and ship the retry loop");
    expect(store.taskAuthorityEffectIsCurrent({
      idempotencyKey: `${job.id}:unknown`,
      jobId: job.id,
      kind: "unknown_effect",
      payload: {},
    } as never)).toBe(false);
  });

  it.each(["send_remediation", "spawn_docs"] as const)(
    "rejects %s execution when part of its change grant was omitted",
    (kind) => {
      const { bb, store, job } = ownerJobFixture("Fix and ship the retry loop");
      const effectKey = `${job.id}:${kind}`;
      bb.storage.database().prepare(
        `INSERT INTO effects (
           idempotency_key, job_id, kind, payload_json, status, attempts,
           next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, '{}', 'pending', 0, 10002, 10002, 10002)`,
      ).run(effectKey, job.id, kind);
      const effect = store.getEffect(job.id, effectKey);
      if (!effect) throw new Error("mutating worker effect was not stored");

      expect(store.admitTaskAuthorityOperation(effect, "worktree", 10_002)).toBe(true);
      expect(store.taskAuthorityEffectIsCurrent(effect)).toBe(false);
      expect(store.admitTaskAuthorityOperation(effect, "commit", 10_002)).toBe(true);
      expect(store.admitTaskAuthorityOperation(effect, "push", 10_002)).toBe(true);
      expect(store.admitTaskAuthorityOperation(effect, "pull_request", 10_002)).toBe(true);
      expect(store.taskAuthorityEffectIsCurrent(effect)).toBe(true);
    },
  );

  it("binds controlled effects to the admitted authority revision and rejects stale replay", () => {
    const { bb, store, job } = ownerJobFixture("Fix and ship the retry loop");
    const effectKey = `${job.id}:controlled-worktree`;
    bb.storage.database().prepare(
      `INSERT INTO effects (
         idempotency_key, job_id, kind, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'spawn_implementation', '{}', 'pending', 0, 10002, 10002, 10002)`,
    ).run(effectKey, job.id);
    const effect = store.getEffect(job.id, effectKey);
    if (!effect) throw new Error("controlled effect was not stored");

    expect(store.admitTaskAuthorityOperation(effect, "worktree", 10_002)).toBe(true);
    expect(store.taskAuthorityOperationIsCurrent(effect, "worktree")).toBe(true);
    expect(store.narrowTaskAuthority({
      jobId: job.id,
      ownerUserId: "7",
      ownerChatId: "7",
      controllerKey: "owner-7-controller",
      sourceUpdateId: 702,
      ...claimNarrowingUpdate(store, 702, 10_003),
      authorityRevision: 1,
      outcome: "reviewed_change",
      constraints: ["no_merge"],
      now: 10_003,
    }).outcome).toBe("recorded");
    expect(store.taskAuthorityOperationIsCurrent(effect, "worktree")).toBe(false);
    expect(store.admitTaskAuthorityOperation(effect, "worktree", 10_004)).toBe(false);
  });

  it("rejects a controlled effect outside the exact task grant", () => {
    const { bb, store, job } = ownerJobFixture("Research the retry loop only");
    const effectKey = `${job.id}:forbidden-worktree`;
    bb.storage.database().prepare(
      `INSERT INTO effects (
         idempotency_key, job_id, kind, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'spawn_implementation', '{}', 'pending', 0, 10002, 10002, 10002)`,
    ).run(effectKey, job.id);
    const effect = store.getEffect(job.id, effectKey);
    if (!effect) throw new Error("controlled effect was not stored");

    expect(store.admitTaskAuthorityOperation(effect, "worktree", 10_002)).toBe(false);
    expect(store.taskAuthorityOperationIsCurrent(effect, "worktree")).toBe(false);
  });

  it("keeps a shipped task at the merge gate when production is not configured", () => {
    const job = jobFixture({
      state: "reviewing",
      routingMode: "active",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture({ production: undefined }),
      environmentId: "env_1",
      prNumber: 4,
      prHeadSha: sha("a"),
      taskRecipe: "direct",
      taskOutcome: "shipped_change",
    });

    const result = transition(job, {
      type: "REVIEW_PASSED",
      headSha: sha("a"),
      documentation: { required: false, reasons: [], diffDigest: "b".repeat(64) },
    }, 10_002);

    expect(result.job.state).toBe("awaiting_merge_approval");
    expect(result.effects).toEqual([expect.objectContaining({ kind: "issue_approval" })]);
  });

  it("continues routine shipped-task review remediation without owner approval", () => {
    const job = jobFixture({
      state: "awaiting_merge_approval",
      taskOutcome: "shipped_change",
      prHeadSha: sha("a"),
      reviewCycle: 2,
    });

    const continued = transition(job, {
      type: "REMEDIATION_CONTINUED",
      reason: "The independent review did not clear the current head",
    }, 10_002);

    expect(continued.job.state).toBe("remediating");
    expect(continued.effects).toEqual([
      expect.objectContaining({ kind: "send_remediation" }),
    ]);
  });

  it("resolves a live task grant only for its owning job", () => {
    const authority = {
      authorityId: "taskauth_1",
      jobId: "job_owner",
      projectId: "proj_1",
      outcome: "shipped_change" as const,
      status: "active" as const,
      revision: 1,
      constraints: [],
    };
    const evidence = {
      grant: null,
      revokedAt: null,
      policyStoredAt: null,
      taskAuthority: authority,
    };

    expect(resolveMergeGrant({
      projectId: "proj_1",
      jobId: "job_owner",
      policy: null,
      evidence,
    })).toEqual({ source: "task" });
    expect(resolveMergeGrant({
      projectId: "proj_1",
      jobId: "job_sibling",
      policy: null,
      evidence,
    })).toBeNull();
  });

  it("does not grant owner task authority to an autonomous-origin job", () => {
    const { bb, store, job } = ownerJobFixture("Fix and ship the retry loop");
    const db = bb.storage.database();
    db.prepare("UPDATE jobs SET state = 'merged' WHERE id = ?").run(job.id);
    db.prepare("UPDATE job_admissions SET state = 'released', released_at = 10002 WHERE job_id = ?").run(job.id);

    const autonomous = store.createAutonomousJob({
      projectId: "proj_1",
      task: "Diagnose the unattended regression",
      origin: "self_diagnosis",
      minimumRecipe: "bug",
      now: 10_003,
    });
    expect(autonomous.outcome).toBe("created");
    if (autonomous.outcome !== "created") throw new Error("autonomous job was not created");
    expect(autonomous.job.autonomousOrigin).toBe("self_diagnosis");
    expect(autonomous.job.taskOutcome).toBeNull();
    expect(store.getTaskAuthority(autonomous.job.id)).toBeNull();
  });

  it("records the derived outcome and authenticated grant with the job", () => {
    const { store, job } = ownerJobFixture("Fix the retry loop, but do not merge it");

    expect(job.taskOutcome).toBe("reviewed_change");
    expect(job.taskConstraints).toEqual(["no_merge"]);
    expect(store.getTaskAuthority(job.id)).toMatchObject({
      jobId: job.id,
      revision: 1,
      ownerUserId: "7",
      ownerChatId: "7",
      controllerKey: "owner-7-controller",
      sourceUpdateId: 701,
      projectId: "proj_1",
      outcome: "reviewed_change",
      constraints: ["no_merge"],
      policyVersion: 1,
      status: "active",
      revokedAt: null,
    });
  });

  it("revises only the named reviewed job and replays the grant after reopening", () => {
    const { bb, store, job } = ownerJobFixture("Fix the retry loop, but do not merge it");
    const result = store.recordMergePreApproval({
      namedJobId: job.id,
      ownerUserId: "7",
      ownerChatId: "7",
      now: 10_002,
    });

    expect(result).toEqual({ outcome: "recorded", jobId: job.id });
    expect(store.getJob(job.id)).toMatchObject({
      taskOutcome: "shipped_change",
      taskConstraints: [],
      mergePreApprovedAt: 10_002,
    });
    expect(store.getTaskAuthority(job.id)).toMatchObject({ revision: 2, outcome: "shipped_change" });
    const reopened = openStore(bb.storage, bb.storage.kv, () => 10_000);
    expect(reopened.getTaskAuthority(job.id)).toMatchObject({ revision: 2, outcome: "shipped_change" });
    expect(reopened.getTaskAuthority("sibling-job")).toBeNull();
  });

  it("preserves every authority revision across restart", () => {
    const { bb, store, job } = ownerJobFixture("Fix the retry loop, but do not merge it");
    const original = store.getTaskAuthority(job.id);
    if (!original) throw new Error("task authority was not recorded");

    expect(store.recordMergePreApproval({
      namedJobId: job.id,
      ownerUserId: "7",
      ownerChatId: "7",
      now: 10_002,
    })).toEqual({ outcome: "recorded", jobId: job.id });

    const reopened = openStore(bb.storage, bb.storage.kv, () => 10_000);
    expect(reopened.getTaskAuthorityRevision(job.id, 1)).toEqual(original);
    expect(reopened.getTaskAuthorityRevision(job.id, 2)).toMatchObject({
      revision: 2,
      outcome: "shipped_change",
      constraints: [],
      status: "active",
    });
  });

  it("rejects a late instruction from a different owner identity", () => {
    const { store, job } = ownerJobFixture("Fix the retry loop, but do not merge it");

    expect(store.recordMergePreApproval({
      namedJobId: job.id,
      ownerUserId: "8",
      ownerChatId: "8",
      now: 10_002,
    })).toEqual({ outcome: "rejected" });
    expect(store.getTaskAuthority(job.id)).toMatchObject({ revision: 1, outcome: "reviewed_change" });
  });

  it("atomically narrows authority and schedules active work reconciliation", () => {
    const fixture = ownerJobFixture("Fix and ship the retry loop", policyFixture({ production: undefined }));
    const { store, job } = fixture;
    const boundary = recordPolicyBoundary(fixture);
    if (!boundary) throw new Error("owner boundary was not recorded");
    const releaseEffectKey = `${job.id}:release`;
    insertActiveTaskReleaseReceipt(fixture, releaseEffectKey);
    store.upsertWorkerLiveness({
      jobId: job.id,
      workerKind: "implementation",
      resourceKind: "bb_thread",
      resourceId: "thr_active",
      generation: 1,
      state: "active",
      sourceUpdatedAt: 10_001,
      observedAt: 10_001,
      staleNotifiedAt: null,
    });
    store.upsertWorkerLiveness({
      jobId: job.id,
      workerKind: "review",
      resourceKind: "bb_thread",
      resourceId: "thr_review",
      generation: 2,
      state: "starting",
      sourceUpdatedAt: 10_001,
      observedAt: 10_001,
      staleNotifiedAt: null,
    });
    for (const resourceId of ["thr_worker_3", "thr_worker_4", "thr_worker_5"]) {
      store.upsertWorkerLiveness({
        jobId: job.id,
        workerKind: "review",
        resourceKind: "bb_thread",
        resourceId,
        generation: 3,
        state: "active",
        sourceUpdatedAt: 10_001,
        observedAt: 10_001,
        staleNotifiedAt: null,
      });
    }

    expect(store.narrowTaskAuthority({
      jobId: job.id,
      ownerUserId: "7",
      ownerChatId: "7",
      controllerKey: "owner-7-controller",
      sourceUpdateId: 702,
      ...claimNarrowingUpdate(store, 702, 10_003),
      authorityRevision: 1,
      outcome: "reviewed_change",
      constraints: ["no_merge"],
      now: 10_003,
    })).toMatchObject({ outcome: "recorded", authority: { revision: 2 } });

    expect(store.getJob(job.id)).toMatchObject({
      taskOutcome: "reviewed_change",
      taskConstraints: ["no_merge"],
      mergePreApprovedAt: null,
    });
    expect(store.getOwnerBoundary(boundary.digest)).toMatchObject({
      status: "revoked",
      revokedReason: "authority_narrowed",
    });
    expect(store.getReleaseAuthorityReceipt(releaseEffectKey)).toMatchObject({
      status: "revoked",
      revokedReason: "authority_narrowed",
    });
    expect(store.recordOwnerBoundary({
      ...boundaryInput(job.id, 2),
      affectedEffectIdempotencyKey: boundary.affectedEffectIdempotencyKey,
    })).toBeNull();
    expect(store.listEffectsForJob(job.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "stop_thread", payload: expect.objectContaining({
        workers: expect.arrayContaining([
          expect.objectContaining({ resourceId: "thr_active" }),
          expect.objectContaining({ resourceId: "thr_review" }),
        ]),
      }) }),
      expect.objectContaining({ kind: "reconcile_job" }),
    ]));
    const stopEffects = store.listEffectsForJob(job.id).filter((effect) => effect.kind === "stop_thread");
    expect(stopEffects).toHaveLength(2);
    const stoppedResources = stopEffects.flatMap((effect) => {
      const workers = effect.payload.workers;
      if (Array.isArray(workers)) {
        return workers.map((worker) => (worker as { resourceId: string }).resourceId);
      }
      return [effect.payload.resourceId as string];
    });
    expect(new Set(stoppedResources)).toEqual(new Set([
      "thr_active",
      "thr_review",
      "thr_worker_3",
      "thr_worker_4",
      "thr_worker_5",
    ]));
  });

  it("rejects narrowing from a different owner or to broader authority", () => {
    const { store, job } = ownerJobFixture("Fix the retry loop, but do not merge it");
    const request = {
      jobId: job.id,
      controllerKey: "owner-7-controller",
      sourceUpdateId: 702,
      ...claimNarrowingUpdate(store, 702, 10_003),
      authorityRevision: 1,
      outcome: "shipped_change" as const,
      constraints: [] as const,
      now: 10_003,
    };

    expect(store.narrowTaskAuthority({
      ...request,
      ownerUserId: "8",
      ownerChatId: "8",
    })).toEqual({ outcome: "rejected" });
    expect(store.narrowTaskAuthority({
      ...request,
      ownerUserId: "7",
      ownerChatId: "7",
    })).toEqual({ outcome: "rejected" });
    expect(store.getTaskAuthority(job.id)).toMatchObject({ revision: 1, outcome: "reviewed_change" });
  });

  it("binds owner narrowing to the exact controller, source update, job, and revision", () => {
    const { store, job } = ownerJobFixture("Fix and ship the retry loop");
    const instruction = {
      jobId: job.id,
      ownerUserId: "7",
      ownerChatId: "7",
      controllerKey: "owner-7-controller",
      sourceUpdateId: 702,
      ...claimNarrowingUpdate(store, 702, 10_003),
      authorityRevision: 1,
      outcome: "reviewed_change" as const,
      constraints: ["no_merge"] as const,
      now: 10_003,
    };

    expect(store.narrowTaskAuthority(instruction)).toMatchObject({
      outcome: "recorded",
      authority: { revision: 2, outcome: "reviewed_change", constraints: ["no_merge"] },
    });
    expect(store.narrowTaskAuthority({ ...instruction, now: 10_004 })).toMatchObject({
      outcome: "recorded",
      authority: { revision: 2 },
    });
    expect(store.narrowTaskAuthority({
      ...instruction,
      jobId: "other-job",
      now: 10_004,
    })).toEqual({ outcome: "rejected" });
    expect(store.narrowTaskAuthority({
      ...instruction,
      controllerKey: "owner-other-controller",
      now: 10_004,
    })).toEqual({ outcome: "rejected" });
    expect(store.narrowTaskAuthority({
      ...instruction,
      sourceMessageId: instruction.sourceMessageId + 1,
      now: 10_004,
    })).toEqual({ outcome: "rejected" });
    expect(store.narrowTaskAuthority({
      ...instruction,
      replyToMessageId: instruction.replyToMessageId + 1,
      now: 10_004,
    })).toEqual({ outcome: "rejected" });
    expect(store.narrowTaskAuthority({
      ...instruction,
      instructionDigest: "f".repeat(64),
      now: 10_004,
    })).toEqual({ outcome: "rejected" });
    expect(store.narrowTaskAuthority({
      ...instruction,
      authorityRevision: 2,
      now: 10_004,
    })).toEqual({ outcome: "rejected" });
  });

  it("rejects owner narrowing without the exact durable Telegram claim", () => {
    const { store, job } = ownerJobFixture("Fix and ship the retry loop");

    expect(store.narrowTaskAuthority({
      jobId: job.id,
      ownerUserId: "7",
      ownerChatId: "7",
      controllerKey: "owner-7-controller",
      sourceUpdateId: 702,
      sourceMessageId: 1_702,
      replyToMessageId: 900,
      instructionDigest: "e".repeat(64),
      authorityRevision: 1,
      outcome: "reviewed_change",
      constraints: ["no_merge"],
      now: 10_003,
    })).toEqual({ outcome: "rejected" });
    expect(store.getTaskAuthority(job.id)).toMatchObject({ revision: 1 });
  });

  it("persists one evidence-backed owner boundary, anchors the reply, and replays it", () => {
    const { bb, store, job, leaseGeneration } = ownerJobFixture(
      "Fix the retry loop",
      policyFixture({ production: undefined }),
    );
    const recorded = recordPolicyBoundary({ bb, store, job, leaseGeneration });

    expect(recorded).toMatchObject({
      jobId: job.id,
      authorityId: store.getTaskAuthority(job.id)?.authorityId,
      authorityRevision: 1,
      code: "policy_change_required",
      status: "pending",
      answerText: null,
    });
    if (!recorded) throw new Error("owner boundary was not recorded");
    const boundaryOutboxKey = `owner-boundary:${job.id}:${recorded.digest}`;
    expect(store.getOutbox(boundaryOutboxKey)?.payload.text).toContain("Already checked:");
    expect(store.getOutbox(boundaryOutboxKey)?.payload.text).toContain(
      "No reply is not approval; the paused effect remains blocked.",
    );
    expect(() => bb.storage.database().prepare(
      "UPDATE policy_boundary_observations SET observed_at = 10003 WHERE job_id = ?",
    ).run(job.id)).toThrow(/append-only/u);
    expect(store.recordOwnerBoundary({
      ...boundaryInput(job.id),
      affectedEffectIdempotencyKey: recorded.affectedEffectIdempotencyKey,
    })).toEqual(recorded);

    const outbox = store.getOutbox(boundaryOutboxKey);
    if (!outbox) throw new Error("owner boundary outbox was not stored");
    const leased = store.leaseOutbox("executor", leaseGeneration, 10_003, 10, 30_000);
    expect(leased.map((item) => item.logicalKey)).toContain(outbox.logicalKey);
    expect(store.completeOutbox(outbox.logicalKey, "executor", leaseGeneration, 900, 10_004)).toBe(true);
    expect(store.getOwnerBoundaryForReply({ ownerChatId: "7", messageId: 900 })?.digest).toBe(recorded.digest);

    const answered = store.answerOwnerBoundary({
      boundaryDigest: recorded.digest,
      jobId: job.id,
      authorityId: recorded.authorityId,
      authorityRevision: recorded.authorityRevision,
      affectedEffectIdempotencyKey: recorded.affectedEffectIdempotencyKey,
      ownerUserId: "7",
      ownerChatId: "7",
      answerText: "Configure production before continuing",
      now: 10_005,
    });
    expect(answered.outcome).toBe("answered");
    expect(store.getOwnerBoundary(recorded.digest)).toMatchObject({ status: "answered", answerText: "Configure production before continuing" });
    expect(store.answerOwnerBoundary({
      boundaryDigest: recorded.digest,
      jobId: job.id,
      authorityId: recorded.authorityId,
      authorityRevision: recorded.authorityRevision,
      affectedEffectIdempotencyKey: recorded.affectedEffectIdempotencyKey,
      ownerUserId: "7",
      ownerChatId: "7",
      answerText: "Configure production before continuing",
      now: 10_006,
    }).outcome).toBe("replayed");

    const reopened = openStore(bb.storage, bb.storage.kv, () => 10_000);
    expect(reopened.getOwnerBoundary(recorded.digest)).toMatchObject({ status: "answered", answerDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
  });

  it.each([
    "product_decision_required",
    "scope_expansion_required",
    "credential_or_access_required",
    "spend_authority_required",
    "irreversible_effect_required",
    "technical_tradeoff_required",
    "production_recovery_required",
  ] as const)("keeps %s unavailable without a class-specific executor source", (code) => {
    const fixture = ownerJobFixture("Fix and ship the retry loop");
    const { store, job } = fixture;
    const affected = authoritativeBoundarySource(fixture, code);
    expect(store.recordOwnerBoundary({
      ...boundaryInput(job.id),
      ...affected,
      code,
      evidenceFacts: ["caller:self-attested"],
    })).toBeNull();
    expect(store.listOwnerBoundaries(job.id)).toEqual([]);
  });

  it.each([
    ["product_decision_required", ["decision:technical-options-unresolved"]],
    ["scope_expansion_required", ["scope:inside-task-authority"]],
    ["credential_or_access_required", ["access:available"]],
    ["spend_authority_required", ["spend:already-granted"]],
    ["irreversible_effect_required", ["effect:reversible"]],
    ["policy_change_required", ["policy:already-allows"]],
    ["technical_tradeoff_required", ["tradeoff:material", "retry:first-failure"]],
    ["production_recovery_required", ["production:failed", "recovery:available"]],
  ] as const)("rejects the %s durable-fact near miss", (code, evidenceFacts) => {
    const { store, job } = ownerJobFixture("Fix and ship the retry loop");
    expect(store.recordOwnerBoundary({
      ...boundaryInput(job.id),
      code,
      evidenceFacts,
    })).toBeNull();
    expect(store.listOwnerBoundaries(job.id)).toEqual([]);
  });

  it.each([
    ["wrong effect", (fixture: ReturnType<typeof ownerJobFixture>, affectedEffectIdempotencyKey: string) => {
      return { affectedEffectIdempotencyKey: `${affectedEffectIdempotencyKey}:other` };
    }],
    ["resolved policy", (fixture: ReturnType<typeof ownerJobFixture>, affectedEffectIdempotencyKey: string) => {
      fixture.bb.storage.database().prepare("UPDATE jobs SET policy_json = ? WHERE id = ?")
        .run(JSON.stringify(policyFixture()), fixture.job.id);
      return { affectedEffectIdempotencyKey };
    }],
  ] as const)("rejects a policy boundary with %s", (_scenario, arrange) => {
    const fixture = ownerJobFixture("Fix and ship the retry loop", policyFixture({ production: undefined }));
    const { affectedEffectIdempotencyKey } = preparePolicyBoundaryObservation(fixture);
    expect(fixture.store.recordOwnerBoundary({
      ...boundaryInput(fixture.job.id),
      ...arrange(fixture, affectedEffectIdempotencyKey),
    })).toBeNull();
  });

  it("rejects a policy observation for the wrong source effect", () => {
    const fixture = ownerJobFixture("Fix and ship the retry loop", policyFixture({ production: undefined }));
    const db = fixture.bb.storage.database();
    db.prepare("UPDATE jobs SET state = 'awaiting_merge_approval' WHERE id = ?").run(fixture.job.id);
    const current = fixture.store.getJob(fixture.job.id);
    if (!current) throw new Error("policy observation job is missing");
    expect(fixture.store.recordExecutorPolicyBoundaryObservation({
      jobId: current.id,
      authorityRevision: 1,
      sourceEffectIdempotencyKey: `${current.id}:missing:issue_approval`,
      affectedEffectIdempotencyKey: `${current.id}:${current.version + 1}:merge_pr`,
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now: 10_002,
    })).toBe(false);
  });

  it("rejects a leased policy approval source without current task-authority admission", () => {
    const policy = policyFixture({ production: undefined });
    const fixture = ownerJobFixture("Fix and ship the retry loop", policy);
    const db = fixture.bb.storage.database();
    const headSha = sha("e");
    const key = prepareApprovalEffect(fixture, policy, headSha);
    db.prepare(
      `UPDATE effects SET status = 'leased', attempts = 1, lease_owner = 'executor',
         lease_generation = ?, lease_expires_at = 40004, updated_at = 10004
       WHERE idempotency_key = ?`,
    ).run(fixture.leaseGeneration, key);

    expect(fixture.store.recordExecutorPolicyBoundaryObservation({
      jobId: fixture.job.id,
      authorityRevision: 1,
      sourceEffectIdempotencyKey: key,
      affectedEffectIdempotencyKey: `${fixture.job.id}:3:merge_pr`,
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now: 10_005,
    })).toBe(false);
    expect(db.prepare("SELECT * FROM policy_boundary_observations WHERE job_id = ?").all(fixture.job.id)).toEqual([]);
  });

  it.each([
    ["empty", () => ({})],
    ["wrong job", (payload: ReturnType<typeof policyApprovalPayload>) => ({ ...payload, jobId: "job_other" })],
    ["wrong project", (payload: ReturnType<typeof policyApprovalPayload>) => ({ ...payload, projectId: "proj_other" })],
    ["wrong controller", (payload: ReturnType<typeof policyApprovalPayload>) => ({ ...payload, controllerKey: "controller_other" })],
    ["wrong policy digest", (payload: ReturnType<typeof policyApprovalPayload>) => ({ ...payload, policyDigest: "f".repeat(64) })],
    ["wrong artifact graph", (payload: ReturnType<typeof policyApprovalPayload>) => ({ ...payload, artifactGraphDigest: "f".repeat(64) })],
    ["wrong paused effect", (payload: ReturnType<typeof policyApprovalPayload>) => ({ ...payload, affectedEffectIdempotencyKey: "effect_other" })],
    ["wrong paused effect kind", (payload: ReturnType<typeof policyApprovalPayload>) => ({ ...payload, affectedEffectKind: "deploy_production" })],
    ["wrong reviewed head", (payload: ReturnType<typeof policyApprovalPayload>) => ({ ...payload, headSha: sha("f") })],
    ["wrong operation", (payload: ReturnType<typeof policyApprovalPayload>) => ({ ...payload, operation: "deploy" })],
  ] as const)("rejects an admitted policy approval source with %s payload", (_scenario, alterPayload) => {
    const policy = policyFixture({ production: undefined });
    const fixture = ownerJobFixture("Fix and ship the retry loop", policy);
    const key = prepareApprovalEffect(fixture, policy, sha("e"));
    const source = fixture.store.leaseNextJobEffect({
      jobId: fixture.job.id,
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now: 10_004,
      leaseMs: 30_000,
    });
    if (!source || source.idempotencyKey !== key) throw new Error("policy approval source was not leased");
    fixture.bb.storage.database().prepare("UPDATE effects SET payload_json = ? WHERE idempotency_key = ?")
      .run(JSON.stringify(alterPayload(policyApprovalPayload(fixture, policy, sha("e")))), key);

    expect(fixture.store.recordExecutorPolicyBoundaryObservation({
      jobId: fixture.job.id,
      authorityRevision: 1,
      sourceEffectIdempotencyKey: key,
      affectedEffectIdempotencyKey: `${fixture.job.id}:3:merge_pr`,
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now: 10_005,
    })).toBe(false);
    expect(fixture.bb.storage.database().prepare(
      "SELECT * FROM policy_boundary_observations WHERE job_id = ?",
    ).all(fixture.job.id)).toEqual([]);
  });

  it("rejects a malformed admitted policy approval payload before observation insertion", () => {
    const policy = policyFixture({ production: undefined });
    const fixture = ownerJobFixture("Fix and ship the retry loop", policy);
    const key = prepareApprovalEffect(fixture, policy, sha("e"));
    const source = fixture.store.leaseNextJobEffect({
      jobId: fixture.job.id,
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now: 10_004,
      leaseMs: 30_000,
    });
    if (!source || source.idempotencyKey !== key) throw new Error("policy approval source was not leased");
    fixture.bb.storage.database().prepare("UPDATE effects SET payload_json = '[' WHERE idempotency_key = ?").run(key);

    expect(() => fixture.store.recordExecutorPolicyBoundaryObservation({
      jobId: fixture.job.id,
      authorityRevision: 1,
      sourceEffectIdempotencyKey: key,
      affectedEffectIdempotencyKey: `${fixture.job.id}:3:merge_pr`,
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now: 10_005,
    })).toThrow();
    expect(fixture.bb.storage.database().prepare(
      "SELECT * FROM policy_boundary_observations WHERE job_id = ?",
    ).all(fixture.job.id)).toEqual([]);
  });

  it("prevents direct SQL from linking an observation to an unadmitted policy approval", () => {
    const policy = policyFixture({ production: undefined });
    const fixture = ownerJobFixture("Fix and ship the retry loop", policy);
    const key = prepareApprovalEffect(fixture, policy, sha("e"));
    const authority = fixture.store.getTaskAuthority(fixture.job.id);
    if (!authority) throw new Error("policy approval authority is missing");

    expect(() => fixture.bb.storage.database().prepare(
      `INSERT INTO policy_boundary_observations (
         observation_id, job_id, authority_id, authority_revision, artifact_graph_digest, policy_digest,
         source_effect_idempotency_key, affected_effect_idempotency_key, observed_job_version, observed_at
       ) VALUES ('forged_observation', ?, ?, 1, ?, ?, ?, ?, 2, 10005)`,
    ).run(
      fixture.job.id,
      authority.authorityId,
      authority.artifactGraphDigest,
      authority.policyDigest,
      key,
      `${fixture.job.id}:3:merge_pr`,
    )).toThrow(/admitted policy approval source/u);
  });

  it.each([
    ["wrong authority revision", { authorityRevision: 2 }],
    ["wrong executor generation", { generationOffset: 1 }],
  ] as const)("rejects a policy approval observation with %s", (_scenario, mismatch) => {
    const policy = policyFixture({ production: undefined });
    const fixture = ownerJobFixture("Fix and ship the retry loop", policy);
    const key = prepareApprovalEffect(fixture, policy, sha("e"));
    const source = fixture.store.leaseNextJobEffect({
      jobId: fixture.job.id,
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now: 10_004,
      leaseMs: 30_000,
    });
    if (!source || source.idempotencyKey !== key) throw new Error("policy approval source was not leased");

    expect(fixture.store.recordExecutorPolicyBoundaryObservation({
      jobId: fixture.job.id,
      authorityRevision: "authorityRevision" in mismatch ? mismatch.authorityRevision : 1,
      sourceEffectIdempotencyKey: key,
      affectedEffectIdempotencyKey: `${fixture.job.id}:3:merge_pr`,
      ownerId: "executor",
      generation: fixture.leaseGeneration + ("generationOffset" in mismatch ? mismatch.generationOffset : 0),
      now: 10_005,
    })).toBe(false);
  });

  it("rejects a policy approval admitted under a superseded authority revision", () => {
    const policy = policyFixture({ production: undefined });
    const fixture = ownerJobFixture("Fix and ship the retry loop", policy);
    const key = prepareApprovalEffect(fixture, policy, sha("e"));
    const source = fixture.store.leaseNextJobEffect({
      jobId: fixture.job.id,
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now: 10_004,
      leaseMs: 30_000,
    });
    if (!source || source.idempotencyKey !== key) throw new Error("policy approval source was not leased");
    expect(fixture.store.narrowTaskAuthority({
      jobId: fixture.job.id,
      ownerUserId: "7",
      ownerChatId: "7",
      controllerKey: "owner-7-controller",
      sourceUpdateId: 702,
      ...claimNarrowingUpdate(fixture.store, 702, 10_006),
      authorityRevision: 1,
      outcome: "reviewed_change",
      constraints: ["no_merge"],
      now: 10_006,
    })).toMatchObject({ outcome: "recorded", authority: { revision: 2 } });

    expect(fixture.store.recordExecutorPolicyBoundaryObservation({
      jobId: fixture.job.id,
      authorityRevision: 1,
      sourceEffectIdempotencyKey: key,
      affectedEffectIdempotencyKey: `${fixture.job.id}:3:merge_pr`,
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now: 10_007,
    })).toBe(false);
  });

  it.each([
    "product_decision_required",
    "scope_expansion_required",
    "credential_or_access_required",
    "spend_authority_required",
    "irreversible_effect_required",
    "technical_tradeoff_required",
    "production_recovery_required",
  ] as const)("rejects %s after its authoritative source becomes stale", (code) => {
    const fixture = ownerJobFixture("Fix and ship the retry loop");
    const affected = authoritativeBoundarySource(fixture, code);
    staleAuthoritativeBoundarySource(fixture, code, affected);

    expect(fixture.store.recordOwnerBoundary({
      ...boundaryInput(fixture.job.id),
      ...affected,
      code,
      evidenceFacts: ["caller:self-attested"],
    })).toBeNull();
  });

  it("rejects invented and cross-job source identities", () => {
    const sourceFixture = ownerJobFixture(
      "Fix and ship the retry loop",
      policyFixture({ production: undefined }),
    );
    const recorded = recordPolicyBoundary(sourceFixture);
    if (!recorded) throw new Error("source policy boundary was not recorded");
    const otherJob = addOwnerJob(sourceFixture, "Fix and ship a different retry loop", 703);

    expect(sourceFixture.store.recordOwnerBoundary({
      ...boundaryInput(sourceFixture.job.id),
      code: "policy_change_required",
      evidenceFacts: ["caller:self-attested"],
      affectedEffectIdempotencyKey: "effect_invented",
    })).toBeNull();
    expect(sourceFixture.store.recordOwnerBoundary({
      ...boundaryInput(otherJob.id),
      code: "policy_change_required",
      evidenceFacts: ["caller:self-attested"],
      affectedEffectIdempotencyKey: recorded.affectedEffectIdempotencyKey,
    })).toBeNull();
  });

  it("refuses direct caller-authored boundary fact rows", () => {
    const fixture = ownerJobFixture("Fix and ship the retry loop");
    expect(() => fixture.bb.storage.database().prepare(
      `INSERT INTO owner_boundary_fact_records (
         job_id, code, fact, source_kind, source_id,
         affected_artifact_id, affected_effect_idempotency_key, recorded_at
       ) VALUES (?, 'technical_tradeoff_required', 'retry:exhausted', 'retry',
                 'invented', NULL, ?, 10002)`,
    ).run(fixture.job.id, `${fixture.job.id}:invented`)).toThrow(/derived from authoritative records/i);
  });

  it("revokes a pending owner boundary and task authority when the owner cancels", () => {
    const fixture = ownerJobFixture("Fix the retry loop", policyFixture({ production: undefined }));
    const { store, job } = fixture;
    const recorded = recordPolicyBoundary(fixture);
    if (!recorded) throw new Error("owner boundary was not recorded");

    const cancelled = store.applyJobEvent(job.id, job.version, {
      type: "CANCEL_REQUESTED",
      activeWorkers: [],
    }, 10_005);

    expect(cancelled.state).toBe("cancelled");
    expect(store.getTaskAuthority(job.id)).toMatchObject({ status: "revoked", revokedReason: "job_cancelled" });
    expect(store.getOwnerBoundary(recorded.digest)).toMatchObject({ status: "revoked", revokedReason: "job_cancelled" });
    expect(store.answerOwnerBoundary({
      boundaryDigest: recorded.digest,
      jobId: recorded.jobId,
      authorityId: recorded.authorityId,
      authorityRevision: recorded.authorityRevision,
      affectedEffectIdempotencyKey: recorded.affectedEffectIdempotencyKey,
      ownerUserId: recorded.ownerUserId,
      ownerChatId: recorded.ownerChatId,
      answerText: "Continue anyway",
      now: 10_006,
    }).outcome).toBe("rejected");
  });

  it.each([
    ["job", { jobId: "other-job" }],
    ["authority", { authorityId: "taskauth_other" }],
    ["revision", { authorityRevision: 2 }],
    ["affected effect", { affectedEffectIdempotencyKey: "other-effect" }],
    ["owner", { ownerUserId: "8" }],
    ["chat", { ownerChatId: "8" }],
  ] as const)("rejects an owner answer with a mismatched %s binding", (_binding, changes) => {
    const fixture = ownerJobFixture("Fix the retry loop", policyFixture({ production: undefined }));
    const { store } = fixture;
    const recorded = recordPolicyBoundary(fixture);
    if (!recorded) throw new Error("owner boundary was not recorded");
    const answer = {
      boundaryDigest: recorded.digest,
      jobId: recorded.jobId,
      authorityId: recorded.authorityId,
      authorityRevision: recorded.authorityRevision,
      affectedEffectIdempotencyKey: recorded.affectedEffectIdempotencyKey,
      ownerUserId: recorded.ownerUserId,
      ownerChatId: recorded.ownerChatId,
      answerText: "Configure production before continuing",
      now: 10_005,
    };

    expect(store.answerOwnerBoundary({ ...answer, ...changes })).toMatchObject({ outcome: "rejected" });
    expect(store.getOwnerBoundary(recorded.digest)).toMatchObject({ status: "pending", answerText: null });
  });

  it("retires release authority when cancellation follows an earlier task brake", () => {
    const { bb, store, job } = ownerJobFixture("Fix the retry loop");
    const authority = store.getTaskAuthority(job.id);
    if (!authority) throw new Error("task authority was not recorded");
    const effectIdempotencyKey = `${job.id}:release-receipt`;
    const db = bb.storage.database();
    db.prepare(
      `UPDATE task_authorities
          SET status = 'revoked', revoked_at = ?, revoked_reason = ?, updated_at = ?
        WHERE job_id = ?`,
    ).run(10_003, "scope_expanded", 10_003, job.id);
    db.prepare(
      `INSERT INTO release_authority_receipts (
         receipt_id, job_id, effect_idempotency_key, authority_id, authority_revision,
         authority_source, project_id, repository, base_branch, environment_id,
         pr_number, head_sha, artifact_graph_digest, review_attempt_id,
         validation_completed_at, required_check_names_json, merge_method,
         production_policy_digest, gate_receipt_digest, status, created_at,
         updated_at, consumed_at, revoked_at, revoked_reason
       ) VALUES (?, ?, ?, ?, ?, 'task', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'active', ?, ?, NULL, NULL, NULL)`,
    ).run(
      "receipt_1",
      job.id,
      effectIdempotencyKey,
      authority.authorityId,
      authority.revision,
      authority.projectId,
      "acme/cyndra",
      "main",
      "env_1",
      4,
      sha("d"),
      authority.artifactGraphDigest,
      "review_1",
      10_002,
      JSON.stringify(["test"]),
      "squash",
      "e".repeat(64),
      10_003,
      10_003,
    );

    const cancelled = store.applyJobEvent(job.id, job.version, {
      type: "CANCEL_REQUESTED",
      activeWorkers: [],
    }, 10_004);

    expect(cancelled.state).toBe("cancelled");
    expect(store.getReleaseAuthorityReceipt(effectIdempotencyKey)).toMatchObject({
      status: "revoked",
      revokedReason: "job_cancelled",
    });
  });

  it("rejects generic uncertainty and credential-bearing boundary evidence", () => {
    const input = boundaryInput("job_1");
    expect(() => ownerBoundaryDigest({ ...input, blocker: "not sure" })).toThrow(/concrete decision/i);
    expect(() => ownerBoundaryDigest({ ...input, recommendation: "Use token: abcdefghijklmnop" })).toThrow(/credential/i);
  });

  it("auto-authorizes the exact shipped task merge with a durable accepted approval", async () => {
    const fixture = ownerJobFixture("Fix the retry loop");
    const headSha = sha("b");
    const key = prepareApprovalEffect(fixture, policyFixture(), headSha);

    await runApprovalEffect(fixture, key);

    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({ state: "merging", prHeadSha: headSha });
    const mergeEffect = fixture.store.listEffectsForJob(fixture.job.id).find((effect) => effect.kind === "merge_pr");
    expect(mergeEffect).toMatchObject({
      idempotencyKey: `${fixture.job.id}:3:merge_pr`,
      status: "pending",
    });
    const approvals = fixture.bb.storage.database().prepare(
      "SELECT consumed_at, outcome, owner_user_id, owner_chat_id, job_version FROM approvals WHERE job_id = ?",
    ).all(fixture.job.id) as Array<{
      consumed_at: number | null;
      outcome: string | null;
      owner_user_id: string | null;
      owner_chat_id: string | null;
      job_version: number | null;
    }>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      outcome: "accepted",
      owner_user_id: "7",
      owner_chat_id: "7",
      job_version: 2,
    });
    expect(approvals[0]?.consumed_at).not.toBeNull();
  });

  it("does not issue approval while a repeatedly reviewed shipped task seeks independent evidence", async () => {
    const fixture = ownerJobFixture("Fix and ship the retry loop");
    const key = prepareApprovalEffect(fixture, policyFixture(), sha("b"));
    fixture.bb.storage.database().prepare(
      "UPDATE jobs SET review_cycle = 2 WHERE id = ?",
    ).run(fixture.job.id);

    await runApprovalEffect(fixture, key);

    expect(fixture.store.getJob(fixture.job.id)?.state).toBe("awaiting_merge_approval");
    expect(fixture.store.listEffectsForJob(fixture.job.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "spawn_consensus_review", status: "pending" }),
    ]));
    expect(fixture.bb.storage.database().prepare(
      "SELECT COUNT(*) AS count FROM approvals WHERE job_id = ?",
    ).get(fixture.job.id)).toEqual({ count: 0 });
  });

  it("records one policy boundary instead of asking for merge approval without production", async () => {
    const policy = policyFixture({ production: undefined });
    const fixture = ownerJobFixture("Fix the retry loop", policy);
    const key = prepareApprovalEffect(fixture, policy, sha("c"));

    await runApprovalEffect(fixture, key);

    expect(fixture.store.getJob(fixture.job.id)?.state).toBe("awaiting_merge_approval");
    expect(fixture.bb.storage.database().prepare(
      "SELECT COUNT(*) AS count FROM approvals WHERE job_id = ?",
    ).get(fixture.job.id)).toEqual({ count: 0 });
    const boundaries = fixture.store.listOwnerBoundaries(fixture.job.id);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toMatchObject({
      code: "policy_change_required",
      status: "pending",
      affectedEffectIdempotencyKey: `${fixture.job.id}:3:merge_pr`,
    });
    expect(fixture.store.listEffectsForJob(fixture.job.id).some((effect) => effect.kind === "merge_pr")).toBe(false);
    const reopened = openStore(fixture.bb.storage, fixture.bb.storage.kv, () => 10_000);
    expect(reopened.listOwnerBoundaries(fixture.job.id)).toEqual(boundaries);
  });
});
