import { describe, expect, it } from "vitest";
import {
  NAVIGATOR_DETERMINISTIC_CATEGORIES,
  NAVIGATOR_LIVE_SCENARIOS,
  NAVIGATOR_SAFETY_COUNTERS,
  NavigatorPromotionService,
  assessNavigatorPromotion,
  emptyNavigatorPromotionEvidence,
  workflowIdentityForNewAdmission,
  type NavigatorPromotionEvidence,
} from "../src/navigator/promotion";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function completeEvidence(): NavigatorPromotionEvidence {
  return {
    engine: "navigator-v1",
    deterministic: NAVIGATOR_DETERMINISTIC_CATEGORIES.map((category, index) => ({
      category,
      suiteId: `suite-${category}`,
      runId: `deterministic-navigator-${index}`,
      artifactDigest: SHA_C,
      outcome: "passed",
    })),
    corpus: {
      corpusDigest: SHA_A,
      runId: "corpus-navigator",
      resultDigest: SHA_B,
      total: 48,
      correct: 48,
      unauthorizedEffects: 0,
    },
    liveRuns: NAVIGATOR_LIVE_SCENARIOS.map((scenario, index) => ({
      runId: `live-${scenario}`,
      jobId: `disposable-${scenario}`,
      scenario,
      terminalState: index === 1 ? "cancelled" : "complete",
      evidenceDigest: SHA_C,
    })),
    candidateModelTrials: Array.from({ length: 5 }, (_, index) => ({
      trialId: `candidate-navigator-${index}`,
      harnessDigest: SHA_A,
      budgetDigest: SHA_B,
      outcome: "passed" as const,
    })),
    baselineModelTrials: Array.from({ length: 5 }, (_, index) => ({
      trialId: `baseline-navigator-${index}`,
      harnessDigest: SHA_A,
      budgetDigest: SHA_B,
      outcome: index === 4 ? "failed" as const : "passed" as const,
    })),
    safetyCounters: NAVIGATOR_SAFETY_COUNTERS.map((counter) => ({
      counter,
      count: 0,
      snapshotId: `safety-navigator-${counter}`,
      evidenceDigest: SHA_C,
    })),
    reviewed: true,
  };
}

describe("navigator promotion evidence", () => {
  it("passes only a complete reviewed dual-engine evidence envelope", () => {
    const result = assessNavigatorPromotion(completeEvidence());

    expect(result).toMatchObject({
      engine: "navigator-v1",
      status: "passed",
      ready: true,
      reasonCodes: [],
      candidateSuccesses: 5,
      baselineSuccesses: 4,
    });
    expect(result.evidenceDigest).toMatch(/^[0-9a-f]{64}$/u);

    const evidence = completeEvidence();
    expect(assessNavigatorPromotion({
      ...evidence,
      deterministic: [...evidence.deterministic].reverse(),
      liveRuns: [...evidence.liveRuns].reverse(),
      candidateModelTrials: [...evidence.candidateModelTrials].reverse(),
      baselineModelTrials: [...evidence.baselineModelTrials].reverse(),
      safetyCounters: [...evidence.safetyCounters].reverse(),
    }).evidenceDigest).toBe(result.evidenceDigest);
  });

  it.each(NAVIGATOR_DETERMINISTIC_CATEGORIES)(
    "keeps %s evidence incomplete when the durable category result is absent",
    (category) => {
      const evidence = completeEvidence();
      const result = assessNavigatorPromotion({
        ...evidence,
        deterministic: evidence.deterministic.filter((entry) => entry.category !== category),
      });

      expect(result).toMatchObject({ status: "incomplete", ready: false });
      expect(result.reasonCodes).toContain(`deterministic_missing:${category}`);
    },
  );

  it.each(NAVIGATOR_LIVE_SCENARIOS)(
    "keeps promotion incomplete without the %s disposable live run",
    (scenario) => {
      const evidence = completeEvidence();
      const result = assessNavigatorPromotion({
        ...evidence,
        liveRuns: evidence.liveRuns.filter((entry) => entry.scenario !== scenario),
      });

      expect(result).toMatchObject({ status: "incomplete", ready: false });
      expect(result.reasonCodes).toContain(`live_run_missing:${scenario}`);
    },
  );

  it("distinguishes missing proof from unauthorized or unreviewed proof", () => {
    expect(assessNavigatorPromotion(emptyNavigatorPromotionEvidence())).toMatchObject({
      status: "incomplete",
      ready: false,
      reasonCodes: expect.arrayContaining(["corpus_missing", "evidence_not_reviewed"]),
    });

    const evidence = completeEvidence();
    if (!evidence.corpus) throw new Error("complete evidence omitted corpus proof");
    expect(assessNavigatorPromotion({
      ...evidence,
      corpus: { ...evidence.corpus, correct: 47, unauthorizedEffects: 1 },
    })).toMatchObject({
      status: "failed",
      reasonCodes: expect.arrayContaining(["corpus_not_perfect", "corpus_unauthorized_effects"]),
    });

    expect(assessNavigatorPromotion({
      ...evidence,
      reviewed: false,
    })).toMatchObject({
      status: "incomplete",
      reasonCodes: expect.arrayContaining(["evidence_not_reviewed"]),
    });

    expect(assessNavigatorPromotion({
      ...evidence,
      safetyCounters: evidence.safetyCounters.map((entry) =>
        entry.counter === "unauthorized_effects" ? { ...entry, count: 1 } : entry),
    })).toMatchObject({
      status: "failed",
      reasonCodes: expect.arrayContaining(["safety_counter_nonzero:unauthorized_effects"]),
    });
  });
});

describe("new-job workflow engine routing", () => {
  it("keeps new admissions on recipe-v1 until a reviewed promote, then rollback restores recipe-v1", () => {
    const promoted = { action: "promote", reasonCode: "promotion_gates_passed" } as const;
    const rolledBack = { action: "rollback", reasonCode: "operator_requested" } as const;

    expect(workflowIdentityForNewAdmission("adaptive", null)).toEqual({
      engine: "recipe-v1",
      mode: "live",
    });
    expect(workflowIdentityForNewAdmission("adaptive", promoted)).toEqual({
      engine: "navigator-v1",
      mode: "deterministic",
    });
    expect(workflowIdentityForNewAdmission("adaptive", rolledBack)).toEqual({
      engine: "recipe-v1",
      mode: "live",
    });
    expect(workflowIdentityForNewAdmission("recipe", promoted)).toEqual({
      engine: "recipe-v1",
      mode: "live",
    });
  });

  it("promotes only after durable reviewed evidence and keeps rollback idempotent", async () => {
    const decisions: ReturnType<NavigatorPromotionService["listDecisions"]> = [];
    const service = new NavigatorPromotionService({
      store: {
        appendWorkflowEngineRolloutDecision: (input) => {
          const decision = {
            id: `engine_rollout:${decisions.length + 1}`,
            engine: "navigator-v1" as const,
            action: input.action,
            reasonCode: input.reasonCode,
            evidenceDigest: input.evidenceDigest,
            createdAt: input.now,
          };
          decisions.push(decision);
          return decision;
        },
        listWorkflowEngineRolloutDecisions: (limit) => decisions.slice(-limit),
        getLatestWorkflowEngineRolloutDecision: () => decisions[decisions.length - 1] ?? null,
      },
      readEvidence: () => completeEvidence(),
      now: () => 2_000,
    });

    const first = await service.promote();
    const replay = await service.promote();
    expect(first).toEqual(replay);
    expect(service.routingStatus()).toMatchObject({
      engine: "navigator-v1",
      mode: "deterministic",
    });

    const rollback = service.rollback();
    expect(service.rollback()).toEqual(rollback);
    expect(service.routingStatus()).toMatchObject({
      engine: "recipe-v1",
      mode: "live",
    });
    expect(service.listDecisions(10)).toHaveLength(2);
  });

  it("refuses promote when the evidence envelope is incomplete", async () => {
    const service = new NavigatorPromotionService({
      store: {
        appendWorkflowEngineRolloutDecision: () => {
          throw new Error("incomplete evidence must not persist a promote");
        },
        listWorkflowEngineRolloutDecisions: () => [],
        getLatestWorkflowEngineRolloutDecision: () => null,
      },
      readEvidence: () => emptyNavigatorPromotionEvidence(),
      now: () => 2_000,
    });

    await expect(service.promote()).rejects.toMatchObject({ assessment: { status: "incomplete" } });
    expect(service.routingStatus()).toMatchObject({ engine: "recipe-v1", mode: "live" });
  });
});
