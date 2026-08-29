import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import { HISTORICAL_ROLE_SKILLS, ROLE_SKILLS } from "../src/agent-skills/role-resolver";
import { CONTROLLER_DEFAULT_SKILLS } from "../src/capabilities/controller-bundles";
import {
  HISTORICAL_RECIPE_GRAPH_DIGEST,
  HISTORICAL_RECIPE_REGISTRY_DIGEST,
} from "../src/capabilities/catalog";
import { nativeAdapterRequirementForEvent } from "../src/capabilities/native-adapters";
import { hashSecret } from "../src/crypto";
import { DualEngineCoordinator, DualEngineContractionError } from "../src/navigator/coordinator";
import { workflowIdentityForNewAdmission } from "../src/navigator/promotion";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { jobFixture, policyFixture } from "./helpers";
import { completeTurnThroughFinalization } from "./support/controller-trust-fixtures";

const REPOSITORY_ROOT = new URL("..", import.meta.url).pathname;
const DUAL_ENGINE_HEAD = "0fa9d232eef21ff33d34de86011ea3c8cddf6192";
const HISTORICAL_RECEIPT_DIGEST = "a".repeat(64);

let fixtureSequence = 0;

function openFixture(settings?: Parameters<typeof openStore>[4]) {
  fixtureSequence += 1;
  const { bb } = createFakePluginHost({ pluginId: `navigator-contraction-${fixtureSequence}` });
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
  if (!store.getControllerByThreadId("thr_controller_contract")) {
    if (!store.markControllerSpawned({
      turnId: turn.id,
      ownerId: "executor",
      generation: leaseGeneration,
      now: input.now,
      projectId: "proj_1",
      hostId: "host_1",
      threadId: "thr_controller_contract",
    })) throw new Error("controller spawn was not recorded");
  }
  if (!store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: "executor",
    generation: leaseGeneration,
    now: input.now,
  })) throw new Error("controller submission was not recorded");
  const job = store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller_contract",
    projectId: "proj_1",
    task: input.task,
    now: input.now + 1,
  });
  return { job, turnId: turn.id, leaseGeneration };
}

describe("contracted new-work admission", () => {
  it("admits every new controller job as navigator-v1 after contraction", () => {
    const { store, now } = openFixture();
    const { job } = confirmControllerJob(store, { task: "Navigate the effort", updateId: 44_001, now: now() });
    expect(job).toMatchObject({ workflowEngine: "navigator-v1", workflowMode: "deterministic" });
  });

  it("ignores the retired recipe kill switch and promotion rollback for later admissions", () => {
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
    killed.store.appendWorkflowEngineRolloutDecision({
      action: "rollback",
      reasonCode: "operator_requested",
      evidenceDigest: null,
      now: killed.now(),
    });
    const admitted = confirmControllerJob(killed.store, {
      task: "Stay on the workflow navigator",
      updateId: 44_002,
      now: killed.now(),
    });
    expect(admitted.job).toMatchObject({ workflowEngine: "navigator-v1", workflowMode: "deterministic" });
    expect(workflowIdentityForNewAdmission("recipe", {
      action: "rollback",
      reasonCode: "operator_requested",
    })).toEqual({ engine: "navigator-v1", mode: "deterministic" });
  });
});

describe("final recipe contraction", () => {
  it("refuses contraction while a nonterminal recipe job still needs a legacy skill or state handler", () => {
    const { store, database, now } = openFixture();
    const deploying = store.createJob({
      id: "job_recipe_deploying",
      sourceUpdateId: 44_100,
      requestText: "Do not cancel a live deploy",
      now: 2_000,
    });
    database.prepare("UPDATE jobs SET state = 'deploying' WHERE id = ?").run(deploying.id);
    const coordinator = new DualEngineCoordinator({ store, database, now });
    expect(() => coordinator.assertContractionAllowed()).toThrow(DualEngineContractionError);
    expect(() => coordinator.contractRecipeEngine()).toThrow(/legacy skill or state handler/u);
  });

  it("refuses plugin start while a remaining recipe job still needs a legacy handler", async () => {
    const { bb } = createFakePluginHost({
      pluginId: `navigator-contraction-startup-${fixtureSequence++}`,
      sdk: { subscribe: () => () => undefined },
    });
    const store = openStore(bb.storage);
    const deploying = store.createJob({
      id: "job_recipe_startup",
      sourceUpdateId: 44_101,
      requestText: "Block contracted startup",
      now: 2_000,
    });
    bb.storage.database().prepare("UPDATE jobs SET state = 'deploying' WHERE id = ?").run(deploying.id);

    await expect(plugin(bb)).rejects.toThrow(DualEngineContractionError);
  });

  it("records contraction once the recipe engine is empty and keeps navigator jobs untouched", () => {
    const { store, database, now } = openFixture();
    store.appendWorkflowEngineRolloutDecision({
      action: "promote",
      reasonCode: "promotion_gates_passed",
      evidenceDigest: "a".repeat(64),
      now: now(),
    });
    const first = confirmControllerJob(store, {
      task: "Keep this navigator job",
      updateId: 44_200,
      now: now(),
    });
    completeTurnThroughFinalization(store, {
      ownerId: "executor",
      generation: first.leaseGeneration,
      now: now(),
    }, {
      turnId: first.turnId,
      controllerKey: "owner-7-controller",
      responseText: "Queued the navigator effort.",
    });
    const idle = store.createJob({
      id: "job_recipe_idle",
      sourceUpdateId: 44_201,
      requestText: "Cancel this idle recipe job",
      now: 2_000,
    });
    const coordinator = new DualEngineCoordinator({ store, database, now });
    expect(coordinator.drainRecipeJobs()).toEqual({ cancelled: [idle.id], remaining: [] });
    const contraction = coordinator.contractRecipeEngine();
    expect(contraction).toMatchObject({ engine: "recipe-v1", remainingJobIds: [] });
    expect(coordinator.contractRecipeEngine()).toEqual(contraction);
    expect(store.getJob(first.job.id)).toMatchObject({
      workflowEngine: "navigator-v1",
      workflowMode: "deterministic",
    });
  });
});

describe("historical recipe evidence after contraction", () => {
  it("keeps historical recipe columns, descriptors, and receipts readable", () => {
    const { store, database, now } = openFixture();
    const recipeJob = store.createJob({
      id: "job_recipe_history",
      sourceUpdateId: 44_300,
      requestText: "Preserve this recipe history",
      now: 2_000,
    });
    database.prepare("UPDATE jobs SET state = 'complete', task_recipe = 'architectural' WHERE id = ?")
      .run(recipeJob.id);
    const profile = store.createCapabilityProfile({
      subjectKind: "worker_attempt",
      subjectId: "attempt:recipe-history",
      threadId: null,
      recipeId: "architectural",
      recipeVersion: 1,
      registryDigest: HISTORICAL_RECIPE_REGISTRY_DIGEST,
      graphDigest: HISTORICAL_RECIPE_GRAPH_DIGEST,
      mode: "active",
      model: { pool: "strong", providerId: "codex", modelId: "gpt-5.6-sol", reasoning: "xhigh", serviceTier: "default" },
      assignments: [{
        capabilityId: "writing-plans",
        descriptorDigest: HISTORICAL_RECEIPT_DIGEST,
        capabilityKind: "skill",
        mandatory: false,
      }],
      reasonCodes: ["recipe_architectural"],
      traits: ["multi-session"],
      now: 2_001,
    });
    const coordinator = new DualEngineCoordinator({ store, database, now });
    coordinator.contractRecipeEngine();

    expect(store.getJob(recipeJob.id)).toMatchObject({
      id: recipeJob.id,
      taskRecipe: "architectural",
      workflowEngine: "recipe-v1",
      state: "complete",
    });
    expect(store.getCapabilityProfileById(profile.id)).toMatchObject({
      recipeId: "architectural",
      registryDigest: HISTORICAL_RECIPE_REGISTRY_DIGEST,
      graphDigest: HISTORICAL_RECIPE_GRAPH_DIGEST,
    });
    expect(store.listCapabilityReceipts(profile.id, 10)).toEqual([
      expect.objectContaining({
        capabilityId: "writing-plans",
        descriptorDigest: HISTORICAL_RECEIPT_DIGEST,
        eventType: "selected",
        reasonCode: "profile_selected",
      }),
    ]);
    expect(HISTORICAL_RECIPE_REGISTRY_DIGEST)
      .toBe("d14130f744f1ca484beec08d8956a20e16db854b88a304f9576fcc79bdaa0481");
    expect(HISTORICAL_RECIPE_GRAPH_DIGEST)
      .toBe("665deccc825d74de0d814e94a3799ea50aab2d18176ea6aacbc779651eebf64e");
  });

  it("lets the dual-engine release restore the legacy bundle without rewriting navigator jobs", () => {
    const { store, database, now } = openFixture();
    store.appendWorkflowEngineRolloutDecision({
      action: "promote",
      reasonCode: "promotion_gates_passed",
      evidenceDigest: "a".repeat(64),
      now: now(),
    });
    const navigator = confirmControllerJob(store, {
      task: "Do not rewrite this navigator job",
      updateId: 44_400,
      now: now(),
    });
    const coordinator = new DualEngineCoordinator({ store, database, now });
    coordinator.contractRecipeEngine();
    const beforeRestore = store.getJob(navigator.job.id);
    const restored = spawnSync("git", [
      "cat-file", "-e", `${DUAL_ENGINE_HEAD}:skills/workflow-kit/using-superpowers/SKILL.md`,
    ], { cwd: REPOSITORY_ROOT, encoding: "utf8" });

    expect(restored.status).toBe(0);
    expect(existsSync(join(REPOSITORY_ROOT, "skills/workflow-kit"))).toBe(false);
    expect(store.getJob(navigator.job.id)).toEqual(beforeRestore);
    expect(beforeRestore?.workflowEngine).toBe("navigator-v1");
  });
});

describe("contracted new-work vocabulary", () => {
  it("stops Superpowers-shaped native adapter certification from controlling navigator jobs", () => {
    const job = jobFixture({
      workflowEngine: "navigator-v1",
      workflowMode: "deterministic",
      routingMode: "active",
    });
    expect(nativeAdapterRequirementForEvent(job, {
      type: "IMPLEMENTATION_CREATED",
      threadId: "thr_impl",
      environmentId: "env_1",
    })).toBeNull();
  });

  it("selects navigator disciplines for new worker roles instead of Superpowers recipes", () => {
    expect(ROLE_SKILLS.implementation).toEqual([
      "unslop",
      "diagnosing-bugs",
      "tdd",
      "clean-code-guard",
      "test-guard",
      "durable-boundary-audit",
      "pr-writer",
    ]);
    expect(ROLE_SKILLS.planner).toEqual(["unslop", "writing-for-agents", "docs-guard"]);
    expect(HISTORICAL_ROLE_SKILLS.planner).toEqual(["unslop", "writing-plans", "docs-guard"]);
    expect(CONTROLLER_DEFAULT_SKILLS).toEqual(["driving-bb", "unslop"]);
    expect(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8")).not.toContain("skills/workflow-kit");
    expect(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8")).not.toContain("skills/discovery");
  });
});
