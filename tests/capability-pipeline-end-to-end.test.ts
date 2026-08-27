import { completeTurnThroughFinalization } from "./support/controller-trust-fixtures";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityWorkOrderEnvelope } from "../src/bb/handoffs";
import { CAPABILITY_BY_ID, CAPABILITY_GRAPH_DIGEST, CAPABILITY_REGISTRY_DIGEST } from "../src/capabilities/catalog";
import { controllerBundleIdsFromProfile } from "../src/capabilities/controller-bundles";
import {
  assessGuardEnvelope,
  persistGuardEnvelopeSettlement,
  type GuardAssessmentPolicy,
  type GuardResultEnvelope,
} from "../src/capabilities/guards";
import { admitInventoryItem, type CapabilityInventoryItem } from "../src/capabilities/inventory";
import {
  RecipePromotionService,
  emptyRecipePromotionEvidence,
} from "../src/capabilities/promotion";
import { hashSecret } from "../src/crypto";
import { assessReviewGroup } from "../src/domain/review-lenses";
import type { Job, JobEffect, JobEvent, StoredEffect } from "../src/domain/models";
import { TASK_RECIPES, type TaskRecipe } from "../src/domain/recipes";
import { ApprovalService, APPROVAL_TTL_MS } from "../src/services/approval-service";
import {
  EffectRunner,
  PermanentEffectError,
  type EffectRunnerDependencies,
} from "../src/services/effect-runner";
import { settleEffectFailure } from "../src/services/job-executor-service";
import { MergeHandler } from "../src/services/merge-handler";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

type ActiveProviderFixture = Readonly<{
  bb: ReturnType<typeof createFakePluginHost>["bb"];
  db: Database.Database;
  store: TelegramAgentStore;
  effect: JobEffect;
  ownerId: string;
  generation: number;
  attemptId: string;
  controllerTurnId: string;
  controllerProfileId: string;
}>;

type CapabilityProvider = (
  job: Job,
  attempt: { capabilityProfile?: CapabilityWorkOrderEnvelope },
) => Promise<{ id: string; environmentId?: string | null }>;

const RECIPE_TASK: Readonly<Record<TaskRecipe, string>> = {
  direct: "Change README wording",
  bounded: "Add a filter to the existing list",
  bug: "Reproduce the crash when saving",
  architectural: "Migrate the public billing schema",
  "skill-authoring": "Update the deployment skill",
  "adopted-pr": "Fix and finish the existing pull request",
};

let fixtureId = 0;

function leaseProviderEffect(
  store: TelegramAgentStore,
  fixture: Pick<ActiveProviderFixture, "effect" | "ownerId" | "generation">,
  now: number,
): StoredEffect {
  for (let index = 0; index < 16; index += 1) {
    const effect = store.leaseNextJobEffect({
      jobId: fixture.effect.jobId,
      ownerId: fixture.ownerId,
      generation: fixture.generation,
      now,
      leaseMs: 60_000,
    });
    if (!effect) break;
    if (effect.idempotencyKey === fixture.effect.idempotencyKey) return effect;
    if (!store.completeEffect(effect.idempotencyKey, fixture.ownerId, fixture.generation, now)) {
      throw new Error(`setup effect ${effect.kind} could not be completed`);
    }
  }
  throw new Error(`${fixture.effect.kind} effect was not leased`);
}

function providerAdapter(
  fixture: Pick<ActiveProviderFixture, "effect">,
  provider: CapabilityProvider,
): NonNullable<EffectRunnerDependencies["bb"]> {
  return fixture.effect.kind === "spawn_plan"
    ? { spawnPlanner: provider }
    : { spawnImplementation: provider };
}

function activeProviderFixture(recipe: TaskRecipe): ActiveProviderFixture {
  const { bb } = createFakePluginHost({ pluginId: `capability-pipeline-e2e-${recipe}-${fixtureId++}` });
  const db = bb.storage.database();
  const store = openStore(bb.storage);
  const policy = policyFixture({ production: undefined });
  store.createPairingCode(hashSecret(`pair-${recipe}`), 500, 10_000);
  expect(store.pairOwnerWithPrivateChatCode(hashSecret(`pair-${recipe}`), "7", "70", 501)).toEqual({ ok: true });
  store.upsertProjectPolicy(policy, 502);
  store.appendRecipeRolloutDecision({
    recipe,
    action: "promote",
    reasonCode: "promotion_gates_passed",
    evidenceDigest: "e".repeat(64),
    now: 503,
  });
  const ownerId = "capability-e2e";
  const lease = store.acquireExecutorLease(ownerId, 600, 120_000);
  if (!lease.acquired) throw new Error("executor lease missing");
  const turn = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "70",
    updateId: 10_000 + fixtureId,
    inputText: RECIPE_TASK[recipe],
    now: 601,
  });
  expect(store.claimNextControllerTurn({ ownerId, generation: lease.generation, now: 602 })?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId,
    generation: lease.generation,
    now: 603,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId,
    generation: lease.generation,
    now: 604,
  })).toBe(true);
  const submitted = store.getControllerTurn(turn.id);
  if (!submitted?.capabilityProfileId) throw new Error("controller profile was not persisted before job creation");
  const selected = recipe === "adopted-pr"
    ? store.createAdoptedControllerJob({
        controllerThreadId: "thr_controller",
        projectId: policy.projectId,
        task: RECIPE_TASK[recipe],
        prNumber: 17,
        prUrl: `https://github.com/${policy.githubRepository}/pull/17`,
        headSha: "a".repeat(40),
        branchName: "telegram-agent/adopt-pr-17-aaaaaaaaaaaa",
        now: 605,
      })
    : store.createConfirmedControllerJob({
        controllerThreadId: "thr_controller",
        projectId: policy.projectId,
        task: RECIPE_TASK[recipe],
        now: 605,
      });
  expect(selected).toMatchObject({ taskRecipe: recipe, routingMode: "active" });
  const admitted = store.tryAdmit({
    jobId: selected.id,
    maxConcurrentJobs: 8,
    ownerId,
    generation: lease.generation,
    now: 606,
    leaseMs: 120_000,
  });
  if (admitted.outcome !== "admitted") throw new Error(`job admission failed: ${admitted.reason}`);
  const effectKind = recipe === "architectural" ? "spawn_plan" : "spawn_implementation";
  const effect = store.listEffectsForJob(selected.id).find((candidate) => candidate.kind === effectKind);
  if (!effect) throw new Error(`${effectKind} effect was not created by controller job routing`);
  return {
    bb,
    db,
    store,
    effect,
    ownerId,
    generation: lease.generation,
    attemptId: `${effect.kind === "spawn_plan" ? "stage" : "attempt"}:${effect.idempotencyKey}`,
    controllerTurnId: turn.id,
    controllerProfileId: submitted.capabilityProfileId,
  };
}

async function runExpectedProviderFailure(
  fixture: Pick<ActiveProviderFixture, "store" | "ownerId" | "generation">,
  effect: StoredEffect,
  now: number,
  bb: NonNullable<EffectRunnerDependencies["bb"]>,
): Promise<void> {
  let failure: unknown;
  try {
    await new EffectRunner({
      store: fixture.store,
      fence: {
        ownerId: fixture.ownerId,
        generation: fixture.generation,
        signal: new AbortController().signal,
      },
      now: () => now,
      bb,
    }).run(effect);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(settleEffectFailure(
    fixture.store,
    effect,
    fixture.ownerId,
    fixture.generation,
    now,
    failure,
    () => 0,
  )).toBe(true);
}

describe("adaptive capability pipeline fake-host acceptance", () => {
  it.each(TASK_RECIPES)("recovers one provider failure for the %s recipe without changing its tuple", async (recipe) => {
    const fixture = activeProviderFixture(recipe);
    const models: string[] = [];
    const provider = vi.fn<CapabilityProvider>(async (_job, attempt) => {
      const model = attempt.capabilityProfile?.model;
      if (!model) throw new Error("active dispatch omitted its model route");
      expect(fixture.store.getLatestCapabilityProfile("worker_attempt", fixture.attemptId)?.id)
        .toBe(attempt.capabilityProfile?.profileId);
      models.push(`${model.providerId}/${model.modelId}/${model.reasoning}/${model.serviceTier}`);
      if (models.length === 1) throw new Error("HTTP 503 provider temporarily unavailable request=one");
      return { id: `thr_${recipe}`, environmentId: `env_${recipe}` };
    });
    const bb = providerAdapter(fixture, provider);
    const first = leaseProviderEffect(fixture.store, fixture, 1_002);
    await runExpectedProviderFailure(fixture, first, 1_003, bb);
    const second = leaseProviderEffect(fixture.store, fixture, 2_000);
    await new EffectRunner({
      store: fixture.store,
      fence: {
        ownerId: fixture.ownerId,
        generation: fixture.generation,
        signal: new AbortController().signal,
      },
      now: () => 2_001,
      bb,
    }).run(second);

    expect(models).toHaveLength(2);
    expect(models[1]).toBe(models[0]);
    expect(fixture.store.getCapabilityProfileById(fixture.controllerProfileId)).toMatchObject({
      subjectKind: "controller_turn",
      mode: "active",
    });
    expect(fixture.store.listModelRouteTrials("worker_attempt", fixture.attemptId, 10)).toMatchObject([
      { attempt: 1, outcome: "failed", failureSignature: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      { attempt: 2, outcome: "passed", failureSignature: null },
    ]);
    expect(fixture.store.getJob(fixture.effect.jobId)).toMatchObject({
      state: recipe === "architectural" ? "planning" : "implementing",
      taskRecipe: recipe,
      routingMode: "active",
    });
    expect(fixture.store.getLatestCapabilityProfile("worker_attempt", fixture.attemptId)?.revision).toBe(1);
  });

  it("reconstructs failures after restart, escalates a new profile, and never duplicates an effect", async () => {
    const fixture = activeProviderFixture("direct");
    let store = fixture.store;
    let calls = 0;
    const models: string[] = [];
    const provider = vi.fn<CapabilityProvider>(async (_job, attempt) => {
      calls += 1;
      const model = attempt.capabilityProfile?.model;
      if (!model) throw new Error("active dispatch omitted its model route");
      models.push(model.modelId);
      if (calls <= 2) throw new Error("network HTTP 503 provider unavailable request=volatile");
      return { id: "thr_restarted", environmentId: "env_restarted" };
    });
    const bb = providerAdapter(fixture, provider);

    const first = leaseProviderEffect(store, fixture, 1_002);
    await runExpectedProviderFailure({ ...fixture, store }, first, 1_003, bb);
    store = openStore(fixture.bb.storage);
    const second = leaseProviderEffect(store, fixture, 2_000);
    await runExpectedProviderFailure({ ...fixture, store }, second, 2_001, bb);
    store = openStore(fixture.bb.storage);
    const third = leaseProviderEffect(store, fixture, 4_000);
    await new EffectRunner({
      store,
      fence: {
        ownerId: fixture.ownerId,
        generation: fixture.generation,
        signal: new AbortController().signal,
      },
      now: () => 4_001,
      bb,
    }).run(third);
    expect(store.completeEffect(third.idempotencyKey, fixture.ownerId, fixture.generation, 4_002)).toBe(true);

    expect(models).toEqual(["gpt-5.6-luna", "gpt-5.6-luna", "gpt-5.6-terra"]);
    expect(store.listModelRouteTrials("worker_attempt", fixture.attemptId, 10)).toMatchObject([
      { attempt: 1, route: { pool: "fast" }, outcome: "failed" },
      { attempt: 2, route: { pool: "fast" }, outcome: "failed" },
      { attempt: 3, route: { pool: "standard" }, outcome: "passed" },
    ]);
    const profiles = fixture.db.prepare(
      `SELECT id, revision, model_pool FROM capability_profiles
        WHERE subject_kind = 'worker_attempt' AND subject_id = ? ORDER BY revision`,
    ).all(fixture.attemptId) as Array<{ id: string; revision: number; model_pool: string }>;
    expect(profiles.map((profile) => [profile.revision, profile.model_pool])).toEqual([[1, "fast"], [2, "standard"]]);
    expect(store.listMissingMandatoryCapabilityOutcomes(profiles[0]!.id)).toEqual([]);
    const counts = fixture.db.prepare(
      "SELECT COUNT(*) AS total, COUNT(DISTINCT idempotency_key) AS unique_count FROM effects WHERE job_id = ?",
    ).get(fixture.effect.jobId) as { total: number; unique_count: number };
    expect(counts.total).toBe(counts.unique_count);
  });

  it("relaunches one expanded controller profile and denies a second expansion after restart", () => {
    const { bb } = createFakePluginHost({ pluginId: `capability-controller-e2e-${fixtureId++}` });
    let store = openStore(bb.storage, bb.storage.kv, () => 10_000);
    store.createPairingCode(hashSecret("pair-capability-e2e"), 1_000, 20_000);
    expect(store.pairOwnerWithCode(hashSecret("pair-capability-e2e"), "7", "7", 1_001)).toEqual({ ok: true });
    const turn = store.enqueueControllerTurn({
      controllerKey: "owner-7-controller",
      telegramUserId: "7",
      telegramChatId: "7",
      updateId: 700,
      inputText: "Show current status",
      now: 2_000,
    });
    const firstLease = store.acquireExecutorLease("controller-first", 10_000, 30_000);
    if (!firstLease.acquired) throw new Error("controller lease missing");
    expect(store.claimNextControllerTurn({ ownerId: "controller-first", generation: firstLease.generation, now: 10_000 })?.id)
      .toBe(turn.id);
    expect(store.markControllerSpawned({
      turnId: turn.id,
      ownerId: "controller-first",
      generation: firstLease.generation,
      now: 10_001,
      projectId: "proj_personal",
      hostId: "host_personal",
      threadId: "thr_controller_first",
    })).toBe(true);
    expect(store.markControllerTurnSubmitted({
      turnId: turn.id,
      ownerId: "controller-first",
      generation: firstLease.generation,
      now: 10_002,
    })).toBe(true);
    expect(store.releaseExecutorLease("controller-first", firstLease.generation, 10_003)).toBe(true);
    const submitted = store.getControllerTurn(turn.id);
    if (!submitted?.capabilityProfileId) throw new Error("controller profile missing");
    const expanded = store.requestControllerCapabilityExpansion({
      controllerKey: turn.controllerKey,
      turnId: turn.id,
      expectedProfileId: submitted.capabilityProfileId,
      bundleIds: ["job-control"],
      now: 10_004,
    });
    expect(expanded).toMatchObject({ outcome: "resume_required", continuationCount: 1 });
    const continuation = store.acquireExecutorLease("controller-continuation", 10_005, 30_000);
    if (!continuation.acquired) throw new Error("continuation lease missing");
    expect(store.prepareControllerCapabilityContinuation({
      turnId: turn.id,
      controllerKey: turn.controllerKey,
      expectedThreadId: "thr_controller_first",
      ownerId: "controller-continuation",
      generation: continuation.generation,
      now: 10_006,
    })).toBe(true);
    expect(store.claimNextControllerTurn({
      ownerId: "controller-continuation",
      generation: continuation.generation,
      now: 10_007,
    })?.id).toBe(turn.id);
    expect(store.markControllerSpawned({
      turnId: turn.id,
      ownerId: "controller-continuation",
      generation: continuation.generation,
      now: 10_008,
      projectId: "proj_personal",
      hostId: "host_personal",
      threadId: "thr_controller_second",
    })).toBe(true);
    expect(store.markControllerTurnSubmitted({
      turnId: turn.id,
      ownerId: "controller-continuation",
      generation: continuation.generation,
      now: 10_009,
    })).toBe(true);

    store = openStore(bb.storage, bb.storage.kv, () => 10_010);
    const restartedTurn = store.getControllerTurn(turn.id);
    const restartedProfile = restartedTurn?.capabilityProfileId
      ? store.getCapabilityProfileById(restartedTurn.capabilityProfileId)
      : null;
    expect(restartedTurn).toMatchObject({
      capabilityContinuationCount: 1,
      capabilityContinuationState: "resolved",
      capabilityProfileRevision: 2,
    });
    expect(restartedProfile && controllerBundleIdsFromProfile(restartedProfile)).toEqual([
      "core-observation",
      "job-control",
    ]);
    expect(store.requestControllerCapabilityExpansion({
      controllerKey: turn.controllerKey,
      turnId: turn.id,
      expectedProfileId: restartedProfile!.id,
      bundleIds: ["memory"],
      now: 10_011,
    })).toEqual({ outcome: "denied", reasonCode: "expansion_limit" });
  });

  it("pins an in-flight active job while rollback returns only a new controller job to shadow", () => {
    const fixture = activeProviderFixture("direct");
    const activeProfile = fixture.store.getLatestCapabilityProfile("worker_attempt", fixture.attemptId);
    expect(activeProfile).toBeNull();
    completeTurnThroughFinalization(fixture.store, {
      ownerId: fixture.ownerId,
      generation: fixture.generation,
      now: 700,
    }, {
      turnId: fixture.controllerTurnId,
      controllerKey: "owner-7-controller",
      responseText: "The active job is queued.",
    });
    fixture.store.appendRecipeRolloutDecision({
      recipe: "direct",
      action: "rollback",
      reasonCode: "operator_requested",
      evidenceDigest: null,
      now: 701,
    });
    const nextTurn = fixture.store.enqueueControllerTurn({
      controllerKey: "owner-7-controller",
      telegramUserId: "7",
      telegramChatId: "70",
      updateId: 20_000 + fixtureId,
      inputText: RECIPE_TASK.direct,
      now: 702,
    });
    expect(fixture.store.claimNextControllerTurn({
      ownerId: fixture.ownerId,
      generation: fixture.generation,
      now: 703,
    })?.id).toBe(nextTurn.id);
    expect(fixture.store.markControllerTurnSubmitted({
      turnId: nextTurn.id,
      ownerId: fixture.ownerId,
      generation: fixture.generation,
      now: 704,
    })).toBe(true);
    const shadowJob = fixture.store.createConfirmedControllerJob({
      controllerThreadId: "thr_controller",
      projectId: "proj_1",
      task: RECIPE_TASK.direct,
      now: 705,
    });

    expect(fixture.store.getJob(fixture.effect.jobId)).toMatchObject({
      state: "creating_implementation",
      routingMode: "active",
      taskRecipe: "direct",
    });
    expect(shadowJob).toMatchObject({
      state: "awaiting_confirmation",
      routingMode: "shadow",
      taskRecipe: "direct",
    });
    expect(fixture.store.listRecipeRolloutDecisions("direct", 10).map((decision) => decision.action))
      .toEqual(["promote", "rollback"]);
  });

  it("rejects an expired merge approval through the production callback without a merge effect", async () => {
    const { bb } = createFakePluginHost({ pluginId: `capability-approval-e2e-${fixtureId++}` });
    const db = bb.storage.database();
    let now = 1_000;
    const store = openStore(bb.storage, bb.storage.kv, () => now);
    const policy = policyFixture({ production: undefined, requiredChecks: [] });
    store.createPairingCode(hashSecret("pair-stale-approval"), 500, 10_000);
    expect(store.pairOwnerWithPrivateChatCode(hashSecret("pair-stale-approval"), "7", "70", 501))
      .toEqual({ ok: true });
    store.createJob({ id: "job_stale_approval", sourceUpdateId: fixtureId, requestText: "merge", now });
    db.prepare(
      `UPDATE jobs SET state = 'awaiting_merge_approval', project_id = ?, policy_version = 1,
         policy_json = ?, environment_id = 'env_approval', pr_number = 17,
         pr_url = ?, pr_head_sha = ?, version = 7 WHERE id = 'job_stale_approval'`,
    ).run(
      policy.projectId,
      JSON.stringify(policy),
      `https://github.com/${policy.githubRepository}/pull/17`,
      "a".repeat(40),
    );
    const approvals = new ApprovalService(store, {
      now: () => now,
      randomBytes: () => Buffer.alloc(24, 9),
    });
    const issued = approvals.issue("job_stale_approval", "a".repeat(40));
    now = issued.expiresAt;
    expect(issued.expiresAt).toBe(1_000 + APPROVAL_TTL_MS);
    const collectGateInput = vi.fn(async () => {
      throw new Error("stale approval must not collect merge gates");
    });
    const handler = new MergeHandler({
      store,
      approvals,
      collectGateInput,
      commandRunner: { run: vi.fn(async () => ({ outcome: "aborted" as const })) },
      bb: { sdk: { environments: { mergePullRequest: vi.fn(async () => ({})) } } },
      now: () => now,
    });

    await expect(handler.handleApprovalCallback({
      callbackId: "callback_stale_approval",
      nonce: issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
    expect(collectGateInput).not.toHaveBeenCalled();
    expect(store.getCallback("callback_stale_approval")).toMatchObject({ action: "merge", outcome: "rejected" });
    expect(store.getJob("job_stale_approval")).toMatchObject({ state: "awaiting_merge_approval", version: 7 });
    expect(store.listEffectsForJob("job_stale_approval").filter((effect) => effect.kind === "merge_pr"))
      .toEqual([]);
  });

  it("blocks active review remediation until every selected guard has a terminal outcome", () => {
    const { bb } = createFakePluginHost({ pluginId: `capability-guard-transition-e2e-${fixtureId++}` });
    const db = bb.storage.database();
    const store = openStore(bb.storage);
    const headSha = "a".repeat(40);
    const diffDigest = "b".repeat(64);
    const docsGuard = CAPABILITY_BY_ID.get("docs-guard");
    if (!docsGuard) throw new Error("docs guard missing");
    const created = store.createJob({ id: "job_guard_transition", sourceUpdateId: fixtureId, requestText: "docs", now: 1_000 });
    db.prepare(
      `UPDATE jobs SET state = 'reviewing', project_id = 'proj_1', policy_version = 1,
         policy_json = ?, environment_id = 'env_guard', implementation_thread_id = 'thr_impl',
         review_thread_id = 'thr_guard_quality', pr_number = 17, pr_url = ?, pr_head_sha = ?,
         delivery_mode = 'small_fix', routing_mode = 'active', task_recipe = 'direct', version = 2
       WHERE id = ?`,
    ).run(
      JSON.stringify(policyFixture({ production: undefined })),
      "https://github.com/acme/cyndra/pull/17",
      headSha,
      created.id,
    );
    const lease = store.acquireExecutorLease("guard-transition", 1_001, 30_000);
    if (!lease.acquired) throw new Error("guard transition lease missing");
    const fence = { ownerId: "guard-transition", generation: lease.generation, now: 1_002 };
    const attempt = store.createExecutorAttempt({
      id: "attempt_guard_transition",
      jobId: created.id,
      kind: "review",
      reviewLens: "quality",
      reviewStage: "review",
      ordinal: 1,
      headSha,
      ...fence,
    });
    if (!attempt) throw new Error("guard review attempt missing");
    const profile = store.createCapabilityProfile({
      subjectKind: "worker_attempt",
      subjectId: attempt.id,
      threadId: "thr_guard_quality",
      recipeId: "direct",
      recipeVersion: 1,
      registryDigest: CAPABILITY_REGISTRY_DIGEST,
      graphDigest: CAPABILITY_GRAPH_DIGEST,
      mode: "active",
      model: {
        pool: "standard",
        providerId: "codex",
        modelId: "gpt-5.6-terra",
        reasoning: "high",
        serviceTier: "fast",
      },
      assignments: [{
        capabilityId: docsGuard.id,
        descriptorDigest: docsGuard.digest,
        capabilityKind: "skill",
        mandatory: true,
      }],
      reasonCodes: [],
      traits: ["docs-changed"],
      now: 1_002,
    });
    const guardPolicy: GuardAssessmentPolicy = {
      profileId: profile.id,
      profileRevision: profile.revision,
      reviewedHeadSha: headSha,
      diffDigest,
      selectedGuards: [{
        capabilityId: docsGuard.id,
        descriptorDigest: docsGuard.digest,
        mandatory: true,
        substitutes: [],
      }],
      requirementIds: [],
      mustFixRuleIds: ["docs.required"],
      advisoryRuleIds: [],
    };
    const guardEnvelope: GuardResultEnvelope = {
      schemaVersion: 1,
      profileId: profile.id,
      profileRevision: profile.revision,
      reviewedHeadSha: headSha,
      diffDigest,
      guards: [{
        capabilityId: docsGuard.id,
        descriptorDigest: docsGuard.digest,
        outcome: "findings",
        findings: [{
          ruleId: "docs.required",
          severity: "high",
          subject: "docs/usage.md",
          line: 4,
          evidence: "The public behavior is not documented.",
          evidenceClass: "documentation",
          requirementId: null,
        }],
      }],
    };
    const guardAssessment = assessGuardEnvelope(guardEnvelope, guardPolicy);
    expect(guardAssessment.outcome).toBe("changes_requested");
    expect(store.updateExecutorAttempt({
      jobId: created.id,
      attemptId: attempt.id,
      patch: {
        threadId: "thr_guard_quality",
        result: {
          outcome: "changes_requested",
          reviewedHeadSha: headSha,
          reasons: guardAssessment.reasons,
          guardEnvelope,
          guardPolicy,
        },
      },
      ...fence,
    })).not.toBeNull();
    const group = assessReviewGroup(store.listReviewAttempts(created.id, "review", 1), "small_fix", headSha);
    expect(group).toMatchObject({ outcome: "changes_requested" });
    const event: JobEvent = {
      type: "REVIEW_CHANGES_REQUESTED",
      headSha,
      summary: group.summary ?? "",
      findings: group.findings,
      reasons: group.reasons,
    };

    expect(store.applyExecutorJobEvent({
      jobId: created.id,
      expectedVersion: 2,
      event,
      ...fence,
    })).toBeNull();
    expect(store.getJob(created.id)).toMatchObject({ state: "reviewing", version: 2 });
    expect(persistGuardEnvelopeSettlement({
      repository: store,
      scopeId: `review-lineage:${created.id}:review`,
      envelope: guardEnvelope,
      policy: guardPolicy,
      now: 1_003,
    })).toMatchObject({ outcome: "changes_requested" });
    expect(store.applyExecutorJobEvent({
      jobId: created.id,
      expectedVersion: 2,
      event,
      ...fence,
      now: 1_004,
    })).toMatchObject({ state: "remediating", version: 3 });
    expect(store.listCapabilityReceipts(profile.id, 20).filter((receipt) => receipt.eventType === "outcome"))
      .toHaveLength(1);
  });

  it("keeps guards, external inventory, and promotion authority fail-closed", async () => {
    const { bb } = createFakePluginHost({ pluginId: `capability-safety-e2e-${fixtureId++}` });
    const store = openStore(bb.storage);
    const docsGuard = CAPABILITY_BY_ID.get("docs-guard");
    if (!docsGuard) throw new Error("docs guard missing");
    const outcomes: string[] = [];
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const profile = store.createCapabilityProfile({
        subjectKind: "worker_attempt",
        subjectId: `attempt:guard-${cycle}`,
        threadId: null,
        recipeId: "bounded",
        recipeVersion: 1,
        registryDigest: CAPABILITY_REGISTRY_DIGEST,
        graphDigest: CAPABILITY_GRAPH_DIGEST,
        mode: "active",
        model: {
          pool: "standard",
          providerId: "codex",
          modelId: "gpt-5.6-terra",
          reasoning: "high",
          serviceTier: "fast",
        },
        assignments: [{
          capabilityId: docsGuard.id,
          descriptorDigest: docsGuard.digest,
          capabilityKind: "skill",
          mandatory: true,
        }],
        reasonCodes: [],
        traits: ["docs-changed"],
        now: cycle * 1_000,
      });
      const policy: GuardAssessmentPolicy = {
        profileId: profile.id,
        profileRevision: profile.revision,
        reviewedHeadSha: "a".repeat(40),
        diffDigest: "b".repeat(64),
        selectedGuards: [{
          capabilityId: docsGuard.id,
          descriptorDigest: docsGuard.digest,
          mandatory: true,
          substitutes: [],
        }],
        requirementIds: [],
        mustFixRuleIds: ["docs.required"],
        advisoryRuleIds: [],
      };
      const envelope: GuardResultEnvelope = {
        schemaVersion: 1,
        profileId: profile.id,
        profileRevision: profile.revision,
        reviewedHeadSha: "a".repeat(40),
        diffDigest: "b".repeat(64),
        guards: [{
          capabilityId: docsGuard.id,
          descriptorDigest: docsGuard.digest,
          outcome: "findings",
          findings: [{
            ruleId: "docs.required",
            severity: "high",
            subject: "docs/usage.md",
            line: 4,
            evidence: "The public behavior is not documented.",
            evidenceClass: "documentation",
            requirementId: null,
          }],
        }],
      };
      outcomes.push(persistGuardEnvelopeSettlement({
        repository: store,
        scopeId: "review-lineage:job-safety:final",
        envelope,
        policy,
        now: cycle * 1_000 + 1,
      }).outcome);
    }
    expect(outcomes).toEqual(["changes_requested", "changes_requested", "blocked"]);

    const discovered: CapabilityInventoryItem = {
      inventoryKey: "inventory:untrusted-docs",
      capabilityId: "inventory-untrusted-docs",
      capabilityKind: "skill",
      source: "skill:untrusted-docs",
      version: null,
      digest: null,
      hostScope: "primary",
      status: "inventory-only",
      metadata: {},
      discoveredAt: 5_000,
    };
    expect(() => admitInventoryItem(discovered)).toThrow(/descriptor|mapping|shadow/i);

    const promotions = new RecipePromotionService({
      store,
      readEvidence: async (recipe) => emptyRecipePromotionEvidence(recipe),
      now: () => 6_000,
    });
    await expect(promotions.promote("direct")).rejects.toMatchObject({
      assessment: { status: "incomplete", ready: false },
    });
    expect(promotions.listDecisions("direct", 10)).toEqual([]);
    expect(promotions.routingStatus("direct")).toMatchObject({ routingMode: "shadow" });
  });

  it("blocks the second equivalent strong-pool failure before another provider attempt", async () => {
    const fixture = activeProviderFixture("direct");
    const provider = vi.fn<CapabilityProvider>(async () => {
      throw new Error("provider deadline timeout request=volatile");
    });
    const bb = providerAdapter(fixture, provider);
    const run = async (effect: StoredEffect, now: number): Promise<unknown> => {
      try {
        await new EffectRunner({
          store: fixture.store,
          fence: {
            ownerId: fixture.ownerId,
            generation: fixture.generation,
            signal: new AbortController().signal,
          },
          now: () => now,
          minimumModelPool: () => "strong",
          bb,
        }).run(effect);
      } catch (error) {
        return error;
      }
      throw new Error("strong provider unexpectedly succeeded");
    };
    const first = leaseProviderEffect(fixture.store, fixture, 1_002);
    const firstError = await run(first, 1_003);
    expect(firstError).toBeInstanceOf(Error);
    expect(settleEffectFailure(
      fixture.store,
      first,
      fixture.ownerId,
      fixture.generation,
      1_003,
      firstError,
      () => 0,
    )).toBe(true);
    const second = leaseProviderEffect(fixture.store, fixture, 2_000);
    const secondError = await run(second, 2_001);
    expect(secondError).toBeInstanceOf(PermanentEffectError);
    expect(settleEffectFailure(
      fixture.store,
      second,
      fixture.ownerId,
      fixture.generation,
      2_001,
      secondError,
      () => 0,
    )).toBe(true);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(fixture.store.listModelRouteTrials("worker_attempt", fixture.attemptId, 10)).toMatchObject([
      { attempt: 1, route: { pool: "strong" }, outcome: "failed" },
      { attempt: 2, route: { pool: "strong" }, outcome: "blocked" },
    ]);
    expect(fixture.store.getEffect(fixture.effect.jobId, fixture.effect.idempotencyKey)).toMatchObject({ status: "dead" });
    expect(fixture.store.getJob(fixture.effect.jobId)).toMatchObject({ state: "blocked" });
  });
});
