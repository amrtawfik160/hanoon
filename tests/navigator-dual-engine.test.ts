import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { DualEngineCoordinator, DualEngineContractionError } from "../src/navigator/coordinator";
import { DEFAULT_MODEL_POOL_REGISTRY } from "../src/capabilities/models";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { completeTurnThroughFinalization } from "./support/controller-trust-fixtures";
import { policyFixture } from "./helpers";

const EXTERNAL_DIGEST = "e".repeat(64);
let fixtureSequence = 0;

function modelRoute() {
  return { pool: "strong" as const, ...DEFAULT_MODEL_POOL_REGISTRY.worker.strong };
}

function openFixture(settings?: Parameters<typeof openStore>[4]) {
  fixtureSequence += 1;
  const { bb } = createFakePluginHost({ pluginId: `navigator-dual-engine-${fixtureSequence}` });
  let currentTime = 10_000;
  const now = () => currentTime++;
  const store = openStore(bb.storage, bb.storage.kv, now, undefined, settings);
  store.createPairingCode(hashSecret("pair"), 1_000, 20_000);
  if (!store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001).ok) throw new Error("owner pairing failed");
  store.upsertProjectPolicy(policyFixture(), 1_002);
  return { bb, store, database: bb.storage.database(), now };
}

function confirmControllerJob(
  store: TelegramAgentStore,
  input: Readonly<{
    task: string;
    updateId: number;
    now: number;
    leaseGeneration?: number;
  }>,
) {
  store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: input.updateId,
    inputText: input.task,
    now: input.now,
  });
  let leaseGeneration = input.leaseGeneration;
  if (leaseGeneration === undefined) {
    const lease = store.acquireExecutorLease("executor", input.now, 120_000);
    if (!lease.acquired) throw new Error("missing executor lease");
    leaseGeneration = lease.generation;
  }
  const turn = store.claimNextControllerTurn({
    ownerId: "executor",
    generation: leaseGeneration,
    now: input.now,
  });
  if (!turn) throw new Error("missing controller turn");
  if (!store.getControllerByThreadId("thr_controller_dual")) {
    if (!store.markControllerSpawned({
      turnId: turn.id,
      ownerId: "executor",
      generation: leaseGeneration,
      now: input.now,
      projectId: "proj_1",
      hostId: "host_1",
      threadId: "thr_controller_dual",
    })) throw new Error("controller spawn was not recorded");
  }
  if (!store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: "executor",
    generation: leaseGeneration,
    now: input.now,
  })) throw new Error("controller submission was not recorded");
  const job = store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller_dual",
    projectId: "proj_1",
    task: input.task,
    now: input.now + 1,
  });
  return { job, turnId: turn.id, leaseGeneration };
}

describe("navigator dual-engine admission", () => {
  it("stamps new controller jobs as recipe-v1 until a durable engine promotion", () => {
    const { store, now } = openFixture();
    const { job } = confirmControllerJob(store, { task: "Fix the copy", updateId: 43_001, now: now() });
    expect(job).toMatchObject({ workflowEngine: "recipe-v1", workflowMode: "live" });
  });

  it("admits new work as navigator-v1 only after promotion, and keeps the recipe kill switch independent", () => {
    const promoted = openFixture();
    promoted.store.appendWorkflowEngineRolloutDecision({
      action: "promote",
      reasonCode: "promotion_gates_passed",
      evidenceDigest: "a".repeat(64),
      now: promoted.now(),
    });
    const admitted = confirmControllerJob(promoted.store, {
      task: "Navigate the effort",
      updateId: 43_002,
      now: promoted.now(),
    });
    expect(admitted.job).toMatchObject({ workflowEngine: "navigator-v1", workflowMode: "deterministic" });

    const killed = openFixture(() => ({
      jobGraph: "adaptive",
      controllerTools: "bundled",
      workflowEngineGraph: "recipe",
    }));
    killed.store.appendWorkflowEngineRolloutDecision({
      action: "promote",
      reasonCode: "promotion_gates_passed",
      evidenceDigest: "a".repeat(64),
      now: killed.now(),
    });
    const blocked = confirmControllerJob(killed.store, {
      task: "Stay on recipe-v1",
      updateId: 43_003,
      now: killed.now(),
    });
    expect(blocked.job).toMatchObject({ workflowEngine: "recipe-v1", workflowMode: "live" });
  });

  it("records shadow navigator proposals on recipe jobs without live effects", () => {
    const { store } = openFixture();
    const draft = store.createJob({
      id: "job_recipe_shadow",
      sourceUpdateId: 43_100,
      requestText: "Shadow this recipe job",
      now: 2_000,
    });
    store.applyJobEvent(draft.id, draft.version, {
      type: "PROJECT_SELECTED",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
    }, 2_001);
    const snapshot = store.createNavigatorSnapshot({
      jobId: draft.id,
      externalStateDigest: EXTERNAL_DIGEST,
      evidenceRefs: ["eval:shadow"],
      now: 2_002,
    });
    expect(snapshot.mode).toBe("shadow");
    const decision = store.recordNavigatorProposal({
      snapshotId: snapshot.snapshotId,
      rawProposal: {
        basedOn: snapshot.identity,
        rationale: "Recipe jobs may only be shadowed.",
        evidenceRefs: ["eval:shadow"],
        kind: "unresolved_next_step",
        question: "Should this task use research or wayfinder next?",
        candidateSkillIds: ["research", "wayfinder"],
      },
      observation: {
        nativeToolCalls: [],
        claimedCodeWorktreeId: null,
        dynamicEffectToolIds: [],
        externalStateDigest: EXTERNAL_DIGEST,
      },
      selectModelRoute: () => {
        throw new Error("recipe shadow must not select a model route");
      },
      now: 2_003,
    });
    expect(decision).toMatchObject({ decision: "shadowed", reasonCode: "recipe_job_shadow" });
    expect(store.listEffectsForJob(draft.id).filter((effect) =>
      effect.kind === "run_navigator_skill" || effect.kind === "run_navigator_release")).toEqual([]);
  });

  it("still rejects a malformed proposal on a recipe job", () => {
    const { store } = openFixture();
    const draft = store.createJob({
      id: "job_recipe_malformed",
      sourceUpdateId: 43_101,
      requestText: "Reject this malformed overlay",
      now: 2_000,
    });
    store.applyJobEvent(draft.id, draft.version, {
      type: "PROJECT_SELECTED",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
    }, 2_001);
    const snapshot = store.createNavigatorSnapshot({
      jobId: draft.id,
      externalStateDigest: EXTERNAL_DIGEST,
      evidenceRefs: ["eval:shadow"],
      now: 2_002,
    });
    const decision = store.recordNavigatorProposal({
      snapshotId: snapshot.snapshotId,
      rawProposal: { kind: "invoke_skill" },
      observation: {
        nativeToolCalls: [],
        claimedCodeWorktreeId: null,
        dynamicEffectToolIds: [],
        externalStateDigest: EXTERNAL_DIGEST,
      },
      selectModelRoute: modelRoute,
      now: 2_003,
    });
    expect(decision).toMatchObject({ decision: "rejected", reasonCode: "malformed_proposal" });
  });

  it("refuses in-place engine conversion", () => {
    const { store, database } = openFixture();
    const job = store.createJob({
      id: "job_immutable_engine",
      sourceUpdateId: 43_102,
      requestText: "Keep this engine",
      now: 2_000,
    });
    expect(() => database.prepare(
      "UPDATE jobs SET workflow_engine = 'navigator-v1' WHERE id = ?",
    ).run(job.id)).toThrow(/workflow engine identity is immutable/u);
    expect(store.getJob(job.id)?.workflowEngine).toBe("recipe-v1");
  });

  it("routes new work back to recipe-v1 after rollback without rewriting navigator history", () => {
    const { store, now } = openFixture();
    store.appendWorkflowEngineRolloutDecision({
      action: "promote",
      reasonCode: "promotion_gates_passed",
      evidenceDigest: "a".repeat(64),
      now: now(),
    });
    const first = confirmControllerJob(store, {
      task: "Navigate the first effort",
      updateId: 43_200,
      now: now(),
    });
    expect(first.job.workflowEngine).toBe("navigator-v1");
    completeTurnThroughFinalization(store, {
      ownerId: "executor",
      generation: first.leaseGeneration,
      now: now(),
    }, {
      turnId: first.turnId,
      controllerKey: "owner-7-controller",
      responseText: "Queued the first effort.",
    });
    store.appendWorkflowEngineRolloutDecision({
      action: "rollback",
      reasonCode: "operator_requested",
      evidenceDigest: null,
      now: now(),
    });
    const second = confirmControllerJob(store, {
      task: "Stay on recipe after rollback",
      updateId: 43_201,
      now: now(),
      leaseGeneration: first.leaseGeneration,
    });
    expect(second.job).toMatchObject({ workflowEngine: "recipe-v1", workflowMode: "live" });
    expect(store.getJob(first.job.id)?.workflowEngine).toBe("navigator-v1");
  });
});

describe("dual-engine drain and contraction", () => {
  it("cancels idle recipe jobs and contracts only after the recipe engine is empty", () => {
    const { store, database, now } = openFixture();
    const idle = store.createJob({
      id: "job_recipe_idle",
      sourceUpdateId: 43_300,
      requestText: "Cancel this idle recipe job",
      now: 2_000,
    });
    const coordinator = new DualEngineCoordinator({ store, database, now });
    expect(coordinator.drainRecipeJobs()).toEqual({
      cancelled: [idle.id],
      remaining: [],
    });
    expect(store.getJob(idle.id)?.state).toBe("cancelled");
    const contraction = coordinator.contractRecipeEngine();
    expect(contraction).toMatchObject({ engine: "recipe-v1", remainingJobIds: [] });
  });

  it("refuses contraction while a deploying recipe job remains", () => {
    const { store, database, now } = openFixture();
    const deploying = store.createJob({
      id: "job_recipe_deploying",
      sourceUpdateId: 43_301,
      requestText: "Do not cancel a live deploy",
      now: 2_000,
    });
    database.prepare("UPDATE jobs SET state = 'deploying' WHERE id = ?").run(deploying.id);
    const coordinator = new DualEngineCoordinator({ store, database, now });
    expect(coordinator.drainRecipeJobs()).toEqual({
      cancelled: [],
      remaining: [deploying.id],
    });
    expect(() => coordinator.contractRecipeEngine()).toThrow(DualEngineContractionError);
  });
});
