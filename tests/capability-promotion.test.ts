import { completeTurnThroughFinalization } from "./support/controller-trust-fixtures";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import {
  DETERMINISTIC_PROMOTION_CATEGORIES,
  RECIPE_PROMOTION_ORDER,
  SAFETY_PROMOTION_COUNTERS,
  RecipePromotionService,
  assessRecipePromotion,
  routingModeForNewAttempt,
  type RecipePromotionEvidence,
} from "../src/capabilities/promotion";
import {
  backgroundCapabilityModelRoute,
  capabilityRoutingSettings,
  controllerCapabilityModelRoute,
  controllerExecutionProfile,
  parseGlobalConfig,
} from "../src/config";
import { openStore } from "../src/storage/store";
import { hashSecret } from "../src/crypto";
import { controllerBundleIdsFromProfile } from "../src/capabilities/controller-bundles";
import { policyFixture } from "./helpers";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

function completeEvidence(recipe: RecipePromotionEvidence["recipe"] = "direct"): RecipePromotionEvidence {
  const candidateModelTrials = Array.from({ length: 5 }, (_, index) => ({
    trialId: `candidate-${recipe}-${index}`,
    harnessDigest: SHA_A,
    budgetDigest: SHA_B,
    outcome: "passed" as const,
  }));
  const baselineModelTrials = Array.from({ length: 5 }, (_, index) => ({
    trialId: `baseline-${recipe}-${index}`,
    harnessDigest: SHA_A,
    budgetDigest: SHA_B,
    outcome: index === 4 ? "failed" as const : "passed" as const,
  }));
  return {
    recipe,
    deterministic: DETERMINISTIC_PROMOTION_CATEGORIES.map((category, index) => ({
      category,
      suiteId: `suite-${category}`,
      runId: `deterministic-${recipe}-${index}`,
      artifactDigest: SHA_C,
      outcome: "passed" as const,
    })),
    classifier: {
      corpusDigest: SHA_A,
      runId: `classifier-${recipe}`,
      resultDigest: SHA_B,
      total: 48,
      correct: 48,
      unsafeDowngrades: 0,
    },
    liveRuns: [{
      runId: `live-${recipe}`,
      jobId: `disposable-${recipe}`,
      recipe,
      terminalState: "merged",
      inducedFailureReceiptId: `cap_receipt:failure-${recipe}`,
      recoveryReceiptId: `cap_receipt:recovery-${recipe}`,
      evidenceDigest: SHA_D,
    }],
    candidateModelTrials,
    baselineModelTrials,
    safetyCounters: SAFETY_PROMOTION_COUNTERS.map((counter) => ({
      counter,
      count: 0,
      snapshotId: `safety-${recipe}-${counter}`,
      evidenceDigest: SHA_C,
    })),
  };
}

describe("recipe promotion evidence", () => {
  it("passes only a complete, identity-bound deterministic and live evidence envelope", () => {
    const result = assessRecipePromotion({
      evidence: completeEvidence(),
      activeRecipes: [],
    });

    expect(result).toMatchObject({
      recipe: "direct",
      status: "passed",
      ready: true,
      reasonCodes: [],
      candidateSuccesses: 5,
      baselineSuccesses: 4,
    });
    expect(result.evidenceDigest).toMatch(/^[0-9a-f]{64}$/u);

    const evidence = completeEvidence();
    expect(assessRecipePromotion({
      evidence: {
        ...evidence,
        deterministic: [...evidence.deterministic].reverse(),
        liveRuns: [...evidence.liveRuns].reverse(),
        candidateModelTrials: [...evidence.candidateModelTrials].reverse(),
        baselineModelTrials: [...evidence.baselineModelTrials].reverse(),
        safetyCounters: [...evidence.safetyCounters].reverse(),
      },
      activeRecipes: [],
    }).evidenceDigest).toBe(result.evidenceDigest);
  });

  it.each(DETERMINISTIC_PROMOTION_CATEGORIES)(
    "keeps %s evidence incomplete when the durable category result is absent",
    (category) => {
      const evidence = completeEvidence();
      const result = assessRecipePromotion({
        evidence: {
          ...evidence,
          deterministic: evidence.deterministic.filter((entry) => entry.category !== category),
        },
        activeRecipes: [],
      });

      expect(result).toMatchObject({ status: "incomplete", ready: false });
      expect(result.reasonCodes).toContain(`deterministic_missing:${category}`);
    },
  );

  it("distinguishes missing proof from explicit failed or unsafe proof", () => {
    const evidence = completeEvidence();
    if (!evidence.classifier) throw new Error("complete evidence omitted classifier proof");
    expect(assessRecipePromotion({
      evidence: { ...evidence, liveRuns: [] },
      activeRecipes: [],
    })).toMatchObject({ status: "incomplete", reasonCodes: expect.arrayContaining(["live_run_missing"]) });

    expect(assessRecipePromotion({
      evidence: {
        ...evidence,
        classifier: { ...evidence.classifier, correct: 47, unsafeDowngrades: 1 },
      },
      activeRecipes: [],
    })).toMatchObject({
      status: "failed",
      reasonCodes: expect.arrayContaining(["classifier_not_perfect", "classifier_unsafe_downgrade"]),
    });

    expect(assessRecipePromotion({
      evidence: {
        ...evidence,
        safetyCounters: evidence.safetyCounters.map((entry) =>
          entry.counter === "stale_approvals" ? { ...entry, count: 1 } : entry),
      },
      activeRecipes: [],
    })).toMatchObject({
      status: "failed",
      reasonCodes: expect.arrayContaining(["safety_counter_nonzero:stale_approvals"]),
    });
  });

  it("requires matched five-trial model evidence whose candidate succeeds at least as often", () => {
    const evidence = completeEvidence();
    expect(assessRecipePromotion({
      evidence: { ...evidence, candidateModelTrials: evidence.candidateModelTrials.slice(0, 4) },
      activeRecipes: [],
    })).toMatchObject({
      status: "incomplete",
      reasonCodes: expect.arrayContaining(["model:insufficient_candidate_trials"]),
    });

    expect(assessRecipePromotion({
      evidence: {
        ...evidence,
        candidateModelTrials: evidence.candidateModelTrials.map((trial, index) => ({
          ...trial,
          outcome: index > 2 ? "failed" as const : trial.outcome,
        })),
      },
      activeRecipes: [],
    })).toMatchObject({
      status: "failed",
      reasonCodes: expect.arrayContaining(["model:candidate_below_baseline"]),
    });
  });

  it("enforces the independent per-recipe rollout order", () => {
    expect(RECIPE_PROMOTION_ORDER).toEqual([
      "direct",
      "bounded",
      "bug",
      "skill-authoring",
      "adopted-pr",
      "architectural",
    ]);
    const blocked = assessRecipePromotion({
      evidence: completeEvidence("bug"),
      activeRecipes: ["direct"],
    });
    expect(blocked).toMatchObject({ status: "incomplete", ready: false });
    expect(blocked.reasonCodes).toContain("prior_recipe_not_promoted:bounded");

    expect(assessRecipePromotion({
      evidence: completeEvidence("bug"),
      activeRecipes: ["direct", "bounded"],
    })).toMatchObject({ status: "passed", ready: true });
  });

  it("rejects duplicate identities and a live run without distinct failure and recovery receipts", () => {
    const evidence = completeEvidence();
    expect(() => assessRecipePromotion({
      evidence: {
        ...evidence,
        deterministic: evidence.deterministic.map((entry) => ({ ...entry, runId: "same-run" })),
      },
      activeRecipes: [],
    })).toThrow(/duplicate.*run/i);
    expect(() => assessRecipePromotion({
      evidence: {
        ...evidence,
        liveRuns: evidence.liveRuns.map((run) => ({
          ...run,
          recoveryReceiptId: run.inducedFailureReceiptId,
        })),
      },
      activeRecipes: [],
    })).toThrow(/failure.*recovery|distinct/i);
  });
});

describe("durable rollout decisions", () => {
  it("reads evidence from the trusted source, appends promote/rollback, and survives restart", async () => {
    const { bb } = createFakePluginHost({ pluginId: "capability-promotion-persistence" });
    const store = openStore(bb.storage);
    const readEvidence = vi.fn(async () => completeEvidence("direct"));
    const service = new RecipePromotionService({ store, readEvidence, now: () => 2_000 });

    const promoted = await service.promote("direct");
    expect(readEvidence).toHaveBeenCalledWith("direct");
    expect(promoted).toMatchObject({ recipe: "direct", action: "promote", evidenceDigest: expect.any(String) });
    expect(service.routingStatus("direct")).toMatchObject({ routingMode: "active" });
    expect(() => bb.storage.database().prepare(
      "UPDATE recipe_promotions SET reason_code = 'operator_requested' WHERE id = ?",
    ).run(promoted.id)).toThrow(/append-only/i);

    const rolledBack = service.rollback("direct", "operator_requested");
    expect(rolledBack).toMatchObject({ recipe: "direct", action: "rollback", reasonCode: "operator_requested" });
    expect(service.routingStatus("direct")).toMatchObject({ routingMode: "shadow" });
    const promotedAgain = await service.promote("direct");
    expect(promotedAgain).toMatchObject({ recipe: "direct", action: "promote" });
    expect(promotedAgain.id).not.toBe(promoted.id);
    const rolledBackAgain = service.rollback("direct", "operator_requested");

    const restarted = new RecipePromotionService({
      store: openStore(bb.storage),
      readEvidence,
      now: () => 3_000,
    });
    expect(restarted.listDecisions("direct", 10)).toEqual([
      promoted,
      rolledBack,
      promotedAgain,
      rolledBackAgain,
    ]);
    expect(restarted.routingStatus("direct")).toMatchObject({ routingMode: "shadow" });
  });

  it("never writes a promotion when production evidence is missing", async () => {
    const { bb } = createFakePluginHost({ pluginId: "capability-promotion-incomplete" });
    const store = openStore(bb.storage);
    const evidence = completeEvidence("direct");
    const service = new RecipePromotionService({
      store,
      readEvidence: async () => ({ ...evidence, liveRuns: [] }),
      now: () => 2_000,
    });

    await expect(service.promote("direct")).rejects.toMatchObject({ assessment: { status: "incomplete" } });
    expect(service.listDecisions("direct", 10)).toEqual([]);
    expect(service.routingStatus("direct")).toMatchObject({ routingMode: "shadow" });
  });
});

describe("new-attempt kill switches", () => {
  it("defaults to shadow, promotes only a new attempt, and forces legacy independently", () => {
    const promoted = { recipe: "direct", action: "promote", reasonCode: "promotion_gates_passed" } as const;
    expect(routingModeForNewAttempt("direct", "adaptive", null)).toBe("shadow");
    expect(routingModeForNewAttempt("direct", "adaptive", promoted)).toBe("active");
    expect(routingModeForNewAttempt("direct", "legacy", promoted)).toBe("legacy");
  });

  it("parses three independent switches and keeps strong-only permission policy-owned", () => {
    const parsed = parseGlobalConfig({
      botToken: "token",
      bbAppBaseUrl: "",
      capabilityJobGraph: "legacy",
      controllerCapabilityMode: "all-tools",
      capabilityModelRouting: "strong-only",
      controllerPermissionMode: "accept-edits",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    expect(capabilityRoutingSettings(parsed.value)).toEqual({
      jobGraph: "legacy",
      controllerTools: "all-tools",
      modelRouting: "strong-only",
    });
    expect(controllerExecutionProfile(parsed.value)).toEqual({
      model: "gpt-5.6-sol",
      reasoningLevel: "xhigh",
      serviceTier: "fast",
      permissionMode: "accept-edits",
    });
    expect(controllerCapabilityModelRoute(parsed.value)).toMatchObject({ pool: "strong", modelId: "gpt-5.6-sol" });
    expect(backgroundCapabilityModelRoute(parsed.value)).toMatchObject({ pool: "strong", modelId: "gpt-5.6-sol" });
  });

  it("uses adaptive, bundled, and adaptive-model defaults", () => {
    const parsed = parseGlobalConfig({ botToken: "token", bbAppBaseUrl: "" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(capabilityRoutingSettings(parsed.value)).toEqual({
      jobGraph: "adaptive",
      controllerTools: "bundled",
      modelRouting: "adaptive",
    });
  });

  it("snapshots graph, controller bundles, and model routing only on newly created subjects", () => {
    const { bb } = createFakePluginHost({ pluginId: "capability-new-attempt-switches" });
    let parsed = parseGlobalConfig({ botToken: "token", bbAppBaseUrl: "" });
    if (!parsed.ok) throw new Error(parsed.message);
    let config = parsed.value;
    let now = 10_000;
    const store = openStore(
      bb.storage,
      bb.storage.kv,
      () => now,
      () => controllerCapabilityModelRoute(config),
      () => capabilityRoutingSettings(config),
    );
    store.createPairingCode(hashSecret("pair-switches"), 1_000, 20_000);
    expect(store.pairOwnerWithCode(hashSecret("pair-switches"), "7", "7", 1_001)).toEqual({ ok: true });
    store.upsertProjectPolicy(policyFixture(), 1_002);
    const lease = store.acquireExecutorLease("switch-test", now, 60_000);
    if (!lease.acquired) throw new Error("executor lease unavailable");
    const fence = () => ({ ownerId: "switch-test", generation: lease.generation, now });

    const submit = (updateId: number, text: string) => {
      const turn = store.enqueueControllerTurn({
        controllerKey: "owner-7-controller",
        telegramUserId: "7",
        telegramChatId: "7",
        updateId,
        inputText: text,
        now,
      });
      expect(store.claimNextControllerTurn(fence())?.id).toBe(turn.id);
      if (!store.getControllerByThreadId("thr_controller")) {
        expect(store.markControllerSpawned({
          ...fence(),
          turnId: turn.id,
          projectId: "proj_personal",
          hostId: "host_personal",
          threadId: "thr_controller",
        })).toBe(true);
      }
      expect(store.markControllerTurnSubmitted({ ...fence(), turnId: turn.id })).toBe(true);
      const profile = turn.capabilityProfileId
        ? store.getCapabilityProfileById(turn.capabilityProfileId)
        : null;
      if (!profile) throw new Error("turn profile unavailable");
      return { turn, profile };
    };
    const finish = (turnId: string) => {
      completeTurnThroughFinalization(store, fence(), {
        turnId,
        controllerKey: "owner-7-controller",
        responseText: "Done.",
      });
      now += 10;
    };

    const first = submit(101, "Change the README copy");
    const firstReceipts = store.listCapabilityReceipts(first.profile.id, 100);
    expect(controllerBundleIdsFromProfile(first.profile)).toEqual(["core-observation"]);
    expect(first.profile.model.pool).toBe("standard");
    const firstJob = store.createConfirmedControllerJob({
      controllerThreadId: "thr_controller",
      projectId: "proj_1",
      task: "Change the README copy",
      now,
    });
    expect(firstJob).toMatchObject({ taskRecipe: "direct", routingMode: "shadow" });
    finish(first.turn.id);

    store.appendRecipeRolloutDecision({
      recipe: "direct",
      action: "promote",
      reasonCode: "promotion_gates_passed",
      evidenceDigest: SHA_A,
      now,
    });
    parsed = parseGlobalConfig({
      botToken: "token",
      bbAppBaseUrl: "",
      controllerCapabilityMode: "all-tools",
      capabilityModelRouting: "strong-only",
      controllerPermissionMode: "accept-edits",
    });
    if (!parsed.ok) throw new Error(parsed.message);
    config = parsed.value;

    const second = submit(102, "Change the README copy");
    expect(controllerBundleIdsFromProfile(second.profile)).toEqual([
      "core-observation",
      "job-control",
      "thread-control",
      "memory",
      "monitoring",
      "operations",
    ]);
    expect(second.profile.model).toMatchObject({ pool: "strong", modelId: "gpt-5.6-sol" });
    expect(second.profile.assignments.map((assignment) => assignment.capabilityId)).toContain("model-pool-strong");
    expect(second.profile.assignments.map((assignment) => assignment.capabilityId)).not.toContain("model-pool-standard");
    const secondJob = store.createConfirmedControllerJob({
      controllerThreadId: "thr_controller",
      projectId: "proj_1",
      task: "Change the README copy",
      now,
    });
    expect(secondJob.routingMode).toBe("active");
    expect(store.getJob(firstJob.id)?.routingMode).toBe("shadow");
    expect(controllerBundleIdsFromProfile(store.getCapabilityProfileById(first.profile.id)!)).toEqual(["core-observation"]);
    expect(store.getCapabilityProfileById(first.profile.id)?.model.pool).toBe("standard");
    expect(store.listCapabilityReceipts(first.profile.id, 100)).toEqual(firstReceipts);
    finish(second.turn.id);

    store.appendRecipeRolloutDecision({
      recipe: "direct",
      action: "rollback",
      reasonCode: "operator_requested",
      evidenceDigest: null,
      now,
    });
    const third = submit(103, "Change the README copy");
    const thirdJob = store.createConfirmedControllerJob({
      controllerThreadId: "thr_controller",
      projectId: "proj_1",
      task: "Change the README copy",
      now,
    });
    expect(thirdJob.routingMode).toBe("shadow");
    expect(store.getJob(secondJob.id)?.routingMode).toBe("active");
    finish(third.turn.id);

    parsed = parseGlobalConfig({
      botToken: "token",
      bbAppBaseUrl: "",
      capabilityJobGraph: "legacy",
      controllerCapabilityMode: "all-tools",
      capabilityModelRouting: "strong-only",
    });
    if (!parsed.ok) throw new Error(parsed.message);
    config = parsed.value;
    const fourth = submit(104, "Change the README copy");
    const fourthJob = store.createConfirmedControllerJob({
      controllerThreadId: "thr_controller",
      projectId: "proj_1",
      task: "Change the README copy",
      now,
    });
    expect(fourthJob.routingMode).toBe("legacy");
    expect(store.getJob(thirdJob.id)?.routingMode).toBe("shadow");
    finish(fourth.turn.id);
    expect(store.releaseExecutorLease("switch-test", lease.generation, now)).toBe(true);
  });
});
