import { describe, expect, it } from "vitest";
import {
  aggregateControllerEvaluation,
  compareControllerEvaluations,
  controllerCheckpointCases,
  parseControllerScenarioCorpus,
  parseControllerScenarioTrial,
  type ControllerScenarioTrial,
} from "../src/eval/controller-scenario-contract";

function baselineCorpus() {
  const scenarioCase = (id: string, checkpoint: "baseline" | "kernel" | "cutover") => ({
    id,
    scenarioVersion: 1,
    checkpoint,
    criticalSafety: false,
    ownerMessage: "hello",
    budget: { maxTurns: 2, maxToolCalls: 8, maxTokens: 20_000, maxWallMs: 30_000, maxCostUsd: null },
    requiredOutcomeAssertions: ["controller_turn_completed"],
    forbiddenOutcomeAssertions: [],
    requiredTraceAssertions: [],
    answerGrader: "required",
  });
  return {
    schemaVersion: 1,
    cases: [
      scenarioCase("plain-conversation", "baseline"),
      scenarioCase("kernel-case", "kernel"),
      scenarioCase("cutover-case", "cutover"),
    ],
  };
}

const baseTrial: ControllerScenarioTrial = {
  schemaVersion: 1 as const,
  scenarioVersion: 1,
  scenarioId: "plain-conversation",
  trial: 1,
  seed: 8122026,
  harness: {
    hanoonCommit: "a".repeat(40),
    dirty: false,
    provider: "fake-bb",
    model: "scripted-controller",
    reasoningLevel: "not_applicable",
    serviceTier: "not_applicable",
    permissionMode: "auto" as const,
    instructionSha256: "b".repeat(64),
    overlaySha256: "c".repeat(64),
    capabilityManifestSha256: "d".repeat(64),
    policySha256: "e".repeat(64),
    contextSha256: "f".repeat(64),
    advertisedTools: [],
    parameterSchemaSha256: {},
  },
  budget: { maxTurns: 2, maxToolCalls: 8, maxTokens: 20_000, maxWallMs: 30_000, maxCostUsd: null },
  outcome: { status: "passed" as const, graderId: "durable-outcome", graderVersion: 1, proofRefs: [] },
  trace: { status: "passed" as const, graderId: "typed-trace", graderVersion: 1, proofRefs: [] },
  answer: { status: "not_applicable" as const, graderId: "answer-form", graderVersion: 1, proofRefs: [] },
  metrics: { wallMs: 1, tokens: 0, costUsd: null, terminalFailureClass: null },
};

function trial(overrides: Partial<ControllerScenarioTrial> = {}): ControllerScenarioTrial {
  return { ...baseTrial, ...overrides };
}

describe("controller scenario contract", () => {
  it("fails closed on an unknown corpus version", () => {
    expect(() => parseControllerScenarioCorpus({ schemaVersion: 2, cases: [] }))
      .toThrow(/schemaVersion/);
  });

  it("requires all harness identity and budget fields", () => {
    expect(() => parseControllerScenarioTrial({ schemaVersion: 1, scenarioId: "plain-answer" }))
      .toThrow();
  });

  it("does not let trace or answer grades override an outcome failure", () => {
    const report = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [trial({
        outcome: { status: "failed", graderId: "durable-outcome", graderVersion: 1, proofRefs: [] },
        trace: { status: "passed", graderId: "typed-trace", graderVersion: 1, proofRefs: [] },
        answer: { status: "passed", graderId: "answer-form", graderVersion: 1, proofRefs: [] },
      })],
    });
    expect(report.status).toBe("failed");
  });

  it("rejects unknown corpus keys instead of ignoring them", () => {
    expect(() => parseControllerScenarioCorpus({ schemaVersion: 1, cases: [], unexpected: true }))
      .toThrow(/unrecognized key/i);
  });

  it("rejects a layer missing its grader identity", () => {
    const candidate = { ...baseTrial, outcome: { status: "passed", proofRefs: [] } };
    expect(() => parseControllerScenarioTrial(candidate)).toThrow(/graderId|graderVersion/);
  });

  it("rejects an unparseable layer grade", () => {
    const candidate = { ...baseTrial, outcome: { ...baseTrial.outcome, status: "unknown" } };
    expect(() => parseControllerScenarioTrial(candidate)).toThrow(/status/);
  });

  it("rejects repeated scenario trial pairs", () => {
    expect(() => aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [baseTrial, baseTrial],
    })).toThrow(/duplicate/i);
  });

  it("rejects a leap day that does not exist in the generatedAt calendar", () => {
    expect(() => aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-02-29T00:00:00Z",
      trials: [baseTrial],
    })).toThrow(/generatedAt/);
  });

  it("reports hand-derived scenario summaries and keeps diagnostic failures non-authoritative", () => {
    const report = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [
        trial({
          trace: { status: "failed", graderId: "typed-trace", graderVersion: 1, proofRefs: [] },
        }),
        trial({
          trial: 2,
          answer: { status: "incomplete", graderId: "answer-form", graderVersion: 1, proofRefs: [] },
        }),
        trial({
          scenarioId: "critical-safety-case",
          outcome: { status: "failed", graderId: "durable-outcome", graderVersion: 1, proofRefs: [] },
        }),
      ],
    });

    expect(report).toMatchObject({
      status: "failed",
      trialCount: 3,
      scenarios: [
        { scenarioId: "critical-safety-case", denominator: 1, passed: 0, failed: 1, incomplete: 0 },
        { scenarioId: "plain-conversation", denominator: 2, passed: 1, failed: 0, incomplete: 1 },
      ],
    });
  });
});

describe("cumulative checkpoint inclusion", () => {
  it("runs every earlier checkpoint's cases at each later checkpoint", () => {
    expect(controllerCheckpointCases("baseline")).toEqual(["baseline"]);
    expect(controllerCheckpointCases("kernel")).toEqual(["baseline", "kernel"]);
    expect(controllerCheckpointCases("cutover")).toEqual(["baseline", "kernel", "cutover"]);
  });

  it("keeps the baseline subset identical at every checkpoint", () => {
    const corpus = parseControllerScenarioCorpus(baselineCorpus());
    const included = (checkpoint: "baseline" | "kernel" | "cutover") => corpus.cases
      .filter((scenarioCase) => controllerCheckpointCases(checkpoint).includes(scenarioCase.checkpoint))
      .map((scenarioCase) => scenarioCase.id);

    // `--baseline` can only compare like for like if the baseline cases run
    // unchanged inside the later checkpoints.
    expect(included("baseline")).toEqual(["plain-conversation"]);
    expect(included("kernel")).toEqual(["plain-conversation", "kernel-case"]);
    expect(included("cutover")).toEqual(["plain-conversation", "kernel-case", "cutover-case"]);
  });
});

describe("like-for-like comparison", () => {
  it("compares only matching scenario id and version pairs and reports rates as passed/denominator", () => {
    const baseline = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00Z",
      trials: [trial(), trial({ trial: 2 })],
    });
    const current = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-14T00:00:00Z",
      trials: [
        trial({ harness: { ...baseTrial.harness, capabilityManifestSha256: "1".repeat(64) } }),
        trial({ trial: 2, harness: { ...baseTrial.harness, capabilityManifestSha256: "1".repeat(64) } }),
        trial({
          scenarioId: "cutover-case",
          harness: { ...baseTrial.harness, capabilityManifestSha256: "1".repeat(64) },
        }),
      ],
    });

    const comparison = compareControllerEvaluations({ current, baseline });

    expect(comparison.status).toBe("comparable");
    expect(comparison.scenarios).toEqual([{
      scenarioId: "plain-conversation",
      scenarioVersion: 1,
      baseline: { passed: 2, denominator: 2 },
      current: { passed: 2, denominator: 2 },
      regressed: false,
    }]);
    // Kernel and cutover cases are listed apart and never counted as lift.
    expect(comparison.currentOnly).toEqual(["cutover-case"]);
    expect(comparison.intervention.current.capabilityManifestSha256).toEqual(["1".repeat(64)]);
    expect(comparison.intervention.baseline.capabilityManifestSha256).toEqual(["d".repeat(64)]);
  });

  it("treats a grown Hanoon capability surface as the intervention, not as drift", () => {
    const baseline = aggregateControllerEvaluation({ label: "fixed", trials: [trial()] });
    const current = aggregateControllerEvaluation({
      label: "fixed",
      trials: [trial({
        harness: {
          ...baseTrial.harness,
          advertisedTools: ["telegram_agent_respond", "telegram_agent_turn_evidence"],
          parameterSchemaSha256: {
            telegram_agent_respond: "8".repeat(64),
            telegram_agent_turn_evidence: "9".repeat(64),
          },
          capabilityManifestSha256: "a".repeat(64),
        },
      })],
    });

    const comparison = compareControllerEvaluations({ current, baseline });

    // The kernel exists to add capabilities; treating that as incomparable
    // would make it impossible to measure against its own baseline.
    expect(comparison.status).toBe("comparable");
    expect(comparison.intervention.current.parameterSchemaSha256).toEqual(["8".repeat(64), "9".repeat(64)]);
  });

  it("treats an intervention digest difference as comparable, not as a reason to refuse", () => {
    const baseline = aggregateControllerEvaluation({ label: "fixed", trials: [trial()] });
    const current = aggregateControllerEvaluation({
      label: "fixed",
      trials: [trial({
        harness: {
          ...baseTrial.harness,
          hanoonCommit: "9".repeat(40),
          instructionSha256: "2".repeat(64),
          overlaySha256: "3".repeat(64),
          policySha256: "4".repeat(64),
          contextSha256: "5".repeat(64),
          capabilityManifestSha256: "6".repeat(64),
        },
      })],
    });

    expect(compareControllerEvaluations({ current, baseline }).status).toBe("comparable");
  });

  it.each([
    ["a different provider", { provider: "live-provider" }],
    ["a different model", { model: "other-model" }],
    ["a different reasoning level", { reasoningLevel: "high" }],
    ["a different service tier", { serviceTier: "fast" }],
    ["a different permission mode", { permissionMode: "full" as const }],
  ])("downgrades to strong for %s", (_name, harnessOverride) => {
    const baseline = aggregateControllerEvaluation({ label: "fixed", trials: [trial()] });
    const current = aggregateControllerEvaluation({
      label: "fixed",
      trials: [trial({ harness: { ...baseTrial.harness, ...harnessOverride } })],
    });

    const comparison = compareControllerEvaluations({ current, baseline });

    expect(comparison.status).toBe("strong");
    expect(comparison.incomparableReasons.length).toBeGreaterThan(0);
  });

  it("downgrades to strong when a budget or grader version differs", () => {
    const baseline = aggregateControllerEvaluation({ label: "fixed", trials: [trial()] });
    const budgetChanged = aggregateControllerEvaluation({
      label: "fixed",
      trials: [trial({ budget: { ...baseTrial.budget, maxTokens: 30_000 } })],
    });
    const graderChanged = aggregateControllerEvaluation({
      label: "fixed",
      trials: [trial({ outcome: { ...baseTrial.outcome, graderVersion: 2 } })],
    });

    expect(compareControllerEvaluations({ current: budgetChanged, baseline }).status).toBe("strong");
    expect(compareControllerEvaluations({ current: graderChanged, baseline }).status).toBe("strong");
  });

  it("reports a regression that trace and answer success cannot average away", () => {
    const baseline = aggregateControllerEvaluation({
      label: "fixed",
      trials: [trial(), trial({ trial: 2 })],
    });
    const current = aggregateControllerEvaluation({
      label: "fixed",
      trials: [
        trial(),
        trial({
          trial: 2,
          outcome: { ...baseTrial.outcome, status: "failed" as const },
          trace: { ...baseTrial.trace, status: "passed" as const },
          answer: { ...baseTrial.answer, status: "passed" as const },
        }),
      ],
    });

    const comparison = compareControllerEvaluations({ current, baseline });

    expect(comparison.scenarios[0]).toMatchObject({
      baseline: { passed: 2, denominator: 2 },
      current: { passed: 1, denominator: 2 },
      regressed: true,
    });
    expect(comparison.regressions).toEqual(["plain-conversation"]);
    expect(current.status).toBe("failed");
  });

  it("refuses a comparison with no matching scenario at all", () => {
    const baseline = aggregateControllerEvaluation({ label: "fixed", trials: [trial()] });
    const current = aggregateControllerEvaluation({
      label: "fixed",
      trials: [trial({ scenarioId: "cutover-case" })],
    });

    expect(compareControllerEvaluations({ current, baseline })).toMatchObject({
      status: "incomparable",
      scenarios: [],
    });
  });

  it("refuses a comparison when a matching scenario changed version", () => {
    const baseline = aggregateControllerEvaluation({ label: "fixed", trials: [trial()] });
    const current = aggregateControllerEvaluation({
      label: "fixed",
      trials: [trial({ scenarioVersion: 2 })],
    });

    expect(compareControllerEvaluations({ current, baseline }).status).toBe("incomparable");
  });
});
