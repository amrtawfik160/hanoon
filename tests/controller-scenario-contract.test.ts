import { describe, expect, it } from "vitest";
import * as controllerScenarioContract from "../src/eval/controller-scenario-contract";
import {
  aggregateControllerEvaluation,
  parseControllerScenarioCorpus,
  parseControllerScenarioTrial,
  validateControllerScenarioTrialEvidence,
  type ControllerScenarioTrial,
} from "../src/eval/controller-scenario-contract";

const baseTrial: ControllerScenarioTrial = {
  schemaVersion: 1 as const,
  scenarioVersion: 1,
  scenarioDefinitionSha256: "1".repeat(64),
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
    outerTaskTools: [],
    advertisedTools: [],
    parameterSchemaSha256: {},
  },
  budget: { maxTurns: 2, maxToolCalls: 8, maxTokens: 20_000, maxWallMs: 30_000, maxCostUsd: null },
  outcome: { status: "passed" as const, graderId: "durable-outcome", graderVersion: 1, proofRefs: ["proof:plain-conversation:outcome:sha256:" + "2".repeat(64)] },
  trace: { status: "passed" as const, graderId: "typed-trace", graderVersion: 1, proofRefs: ["proof:plain-conversation:trace:sha256:" + "3".repeat(64)] },
  answer: { status: "not_applicable" as const, graderId: "answer-form", graderVersion: 1, proofRefs: [] },
  metrics: { wallMs: 2, turns: 1, toolCalls: 0, tokens: 0, costUsd: null, terminalFailureClass: null },
};

function trial(overrides: Partial<ControllerScenarioTrial> = {}): ControllerScenarioTrial {
  return { ...baseTrial, ...overrides };
}

function trialForScenario(scenarioId: string, overrides: Partial<ControllerScenarioTrial> = {}): ControllerScenarioTrial {
  const candidate = trial({ scenarioId, ...overrides });
  return {
    ...candidate,
    outcome: candidate.outcome.status === "passed"
      ? { ...candidate.outcome, proofRefs: [`proof:${scenarioId}:outcome:sha256:${"2".repeat(64)}`] }
      : candidate.outcome,
    trace: candidate.trace.status === "passed"
      ? { ...candidate.trace, proofRefs: [`proof:${scenarioId}:trace:sha256:${"3".repeat(64)}`] }
      : candidate.trace,
  };
}

function scenarioDefinitionsFor(...reports: ReadonlyArray<{ trials: readonly unknown[] }>) {
  const definitions = new Map<string, { id: string; scenarioVersion: number; criticalSafety: boolean }>();
  for (const report of reports) {
    for (const currentTrial of report.trials as readonly ControllerScenarioTrial[]) {
      definitions.set(`${currentTrial.scenarioId}:${currentTrial.scenarioVersion}`, {
        id: currentTrial.scenarioId,
        scenarioVersion: currentTrial.scenarioVersion,
        criticalSafety: false,
      });
    }
  }
  return [...definitions.values()];
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
        trace: { status: "passed", graderId: "typed-trace", graderVersion: 1, proofRefs: ["proof:plain-conversation:trace:sha256:" + "5".repeat(64)] },
        answer: { status: "passed", graderId: "answer-form", graderVersion: 1, proofRefs: ["proof:plain-conversation:answer:sha256:" + "4".repeat(64)] },
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

  it("rejects passed layers with empty proof references", () => {
    expect(() => parseControllerScenarioTrial({
      ...baseTrial,
      outcome: { ...baseTrial.outcome, proofRefs: [] },
    })).toThrow(/proof/i);
  });

  it("rejects a passed layer whose proof is not bound to the scenario subject", () => {
    expect(() => validateControllerScenarioTrialEvidence({
      ...baseTrial,
      outcome: { ...baseTrial.outcome, proofRefs: ["proof:other-scenario:outcome:sha256:" + "6".repeat(64)] },
    })).toThrow(/subject-bound|plain-conversation/i);
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

  it("classifies every applicable layer failure in report status and scenario summaries", () => {
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
        { scenarioId: "plain-conversation", denominator: 2, passed: 0, failed: 1, incomplete: 1 },
      ],
    });
  });

  it("marks an applicable answer failure as failed", () => {
    const report = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [trial({
        answer: {
          status: "failed",
          graderId: "answer-form",
          graderVersion: 1,
          proofRefs: ["proof:plain-conversation:answer-failed:sha256:" + "4".repeat(64)],
        },
      })],
    });

    expect(report).toMatchObject({
      status: "failed",
      scenarios: [{ scenarioId: "plain-conversation", denominator: 1, passed: 0, failed: 1, incomplete: 0 }],
    });
  });

  it("keeps not-applicable answer grades neutral", () => {
    const report = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [trial()],
    });

    expect(report).toMatchObject({
      status: "passed",
      scenarios: [{ scenarioId: "plain-conversation", denominator: 1, passed: 1, failed: 0, incomplete: 0 }],
    });
  });

  it("retains incomplete when no applicable layer failed", () => {
    const report = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [trial({
        answer: {
          status: "incomplete",
          graderId: "answer-form",
          graderVersion: 1,
          proofRefs: [],
        },
      })],
    });

    expect(report).toMatchObject({
      status: "incomplete",
      scenarios: [{ scenarioId: "plain-conversation", denominator: 1, passed: 0, failed: 0, incomplete: 1 }],
    });
  });

  it("gives a failed applicable layer precedence over incomplete", () => {
    const report = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [trial({
        trace: { status: "failed", graderId: "typed-trace", graderVersion: 1, proofRefs: [] },
        answer: { status: "incomplete", graderId: "answer-form", graderVersion: 1, proofRefs: [] },
      })],
    });

    expect(report).toMatchObject({
      status: "failed",
      scenarios: [{ scenarioId: "plain-conversation", denominator: 1, passed: 0, failed: 1, incomplete: 0 }],
    });
  });

  it.each([
    ["scenario definition hash missing on baseline", (report: ControllerScenarioContractReport) => ({
      ...report,
      trials: report.trials.map(({ scenarioDefinitionSha256: _ignored, ...currentTrial }) => currentTrial),
      scenarios: report.scenarios,
    })],
    ["scenario definition hash missing on after", (report: ControllerScenarioContractReport) => report],
    ["outer task tools missing on baseline", (report: ControllerScenarioContractReport) => ({
      ...report,
      trials: report.trials.map((currentTrial) => ({
        ...currentTrial,
        harness: Object.fromEntries(Object.entries(currentTrial.harness).filter(([key]) => key !== "outerTaskTools")),
      })),
      scenarios: report.scenarios,
    })],
    ["outer task tools missing on after", (report: ControllerScenarioContractReport) => report],
    ["scenario version", (report: ControllerScenarioContractReport) => ({
      ...report,
      trials: report.trials.map((currentTrial) => ({ ...currentTrial, scenarioVersion: currentTrial.scenarioVersion + 1 })),
      scenarios: report.scenarios,
    })],
    ["outer task tools", (report: ControllerScenarioContractReport) => ({
      ...report,
      trials: report.trials.map((currentTrial) => ({
        ...currentTrial,
        harness: { ...currentTrial.harness, outerTaskTools: ["different-task-tool"] },
      })),
      scenarios: report.scenarios,
    })],
    ["overlay digest", (report: ControllerScenarioContractReport) => ({
      ...report,
      trials: report.trials.map((currentTrial) => ({
        ...currentTrial,
        harness: { ...currentTrial.harness, overlaySha256: "1".repeat(64) },
      })),
      scenarios: report.scenarios,
    })],
    ["provider", (report: ControllerScenarioContractReport) => ({
      ...report,
      trials: report.trials.map((currentTrial) => ({
        ...currentTrial,
        harness: { ...currentTrial.harness, provider: "different-provider" },
      })),
      scenarios: report.scenarios,
    })],
    ["context digest", (report: ControllerScenarioContractReport) => ({
      ...report,
      trials: report.trials.map((currentTrial) => ({
        ...currentTrial,
        harness: { ...currentTrial.harness, contextSha256: "1".repeat(64) },
      })),
      scenarios: report.scenarios,
    })],
    ["budget", (report: ControllerScenarioContractReport) => ({
      ...report,
      trials: report.trials.map((currentTrial) => ({
        ...currentTrial,
        budget: { ...currentTrial.budget, maxTokens: currentTrial.budget.maxTokens + 1 },
      })),
      scenarios: report.scenarios,
    })],
    ["grader version", (report: ControllerScenarioContractReport) => ({
      ...report,
      trials: report.trials.map((currentTrial) => ({
        ...currentTrial,
        outcome: { ...currentTrial.outcome, graderVersion: currentTrial.outcome.graderVersion + 1 },
      })),
      scenarios: report.scenarios,
    })],
  ] as const)("rejects a fixed comparison with %s", (_difference, mutate) => {
    const compare = (controllerScenarioContract as Record<string, unknown>).compareControllerEvaluations;
    expect(typeof compare).toBe("function");
    const baseline = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [trial()],
    });
    const after = mutate(baseline) as typeof baseline;
    const input = _difference.endsWith("on after")
      ? { baseline, after: _difference.includes("scenario definition")
        ? { ...baseline, trials: baseline.trials.map(({ scenarioDefinitionSha256: _ignored, ...currentTrial }) => currentTrial) }
        : { ...baseline, trials: baseline.trials.map((currentTrial) => ({
          ...currentTrial,
          harness: Object.fromEntries(Object.entries(currentTrial.harness).filter(([key]) => key !== "outerTaskTools")),
        })) } }
      : { baseline: after, after: baseline };
    expect(() => (compare as (input: unknown) => unknown)({
      ...input,
      scenarioDefinitions: scenarioDefinitionsFor(input.baseline, input.after),
    })).toThrow(/comparable|scenario|budget|grader|tool|provider|identity/i);
  });

  it("rejects a dirty after report as well as a dirty baseline", () => {
    const compare = (controllerScenarioContract as Record<string, unknown>).compareControllerEvaluations as (input: unknown) => unknown;
    const baseline = aggregateControllerEvaluation({ label: "fixed", generatedAt: "2026-08-12T00:00:00.000Z", trials: [baseTrial] });
    const after = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [{ ...baseTrial, harness: { ...baseTrial.harness, dirty: true } }],
    });
    expect(() => compare({ baseline, after, scenarioDefinitions: scenarioDefinitionsFor(baseline, after) })).toThrow(/dirty/i);
  });

  it("reports comparable denominators and new scenarios without averaging safety failures", () => {
    const compare = (controllerScenarioContract as Record<string, unknown>).compareControllerEvaluations;
    expect(typeof compare).toBe("function");
    const baseline = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [trial(), trial({ trial: 2 })],
    });
    const after = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [
        trial(),
        trial({ trial: 2, outcome: { ...baseTrial.outcome, status: "failed" } }),
        trialForScenario("new-safety-case"),
      ],
    });
    const comparison = (compare as (input: unknown) => {
      status: string;
      common: Array<{ baseline: { passed: number; denominator: number }; after: { passed: number; denominator: number } }>;
      newScenarios: Array<{ scenarioId: string; denominator: number }>;
      intervention: { baseline: unknown; after: unknown };
    })({ baseline, after, scenarioDefinitions: scenarioDefinitionsFor(baseline, after) });

    expect(comparison).toMatchObject({
      status: "comparable",
      common: [{ scenarioId: "plain-conversation", baseline: { passed: 2, denominator: 2 }, after: { passed: 1, denominator: 2 } }],
      newScenarios: [{ scenarioId: "new-safety-case", denominator: 1 }],
    });
    expect(comparison.intervention.baseline).toBeDefined();
    expect(comparison.intervention.after).toBeDefined();
    expect(comparison).not.toHaveProperty("percentage");
    expect(comparison).not.toHaveProperty("average");
  });

  it("rejects a common scenario whose trial denominators differ", () => {
    const compare = (controllerScenarioContract as Record<string, unknown>).compareControllerEvaluations;
    const baseline = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [trial(), trial({ trial: 2 })],
    });
    const after = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [trial()],
    });

    expect(() => (compare as (input: unknown) => unknown)({
      baseline,
      after,
      scenarioDefinitions: scenarioDefinitionsFor(baseline, after),
    }))
      .toThrow(/trial|denominator|comparable/i);
  });

  it("keeps summaries distinct when one scenario id has multiple versions", () => {
    const report = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [
        trial(),
        trial({ trial: 2, scenarioVersion: 2 }),
      ],
    });

    expect(report.scenarios).toEqual([
      { scenarioId: "plain-conversation", scenarioVersion: 1, denominator: 1, passed: 1, failed: 0, incomplete: 0 },
      { scenarioId: "plain-conversation", scenarioVersion: 2, denominator: 1, passed: 1, failed: 0, incomplete: 0 },
    ]);
  });

  it("rejects a fixed comparison when a passed baseline proof is scenario-unbound", () => {
    const compare = (controllerScenarioContract as Record<string, unknown>).compareControllerEvaluations as (input: unknown) => unknown;
    const baseline = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [baseTrial],
    });
    const after = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [baseTrial],
    });
    const invalidBaseline = {
      ...baseline,
      trials: baseline.trials.map((currentTrial) => ({
        ...currentTrial,
        outcome: {
          ...currentTrial.outcome,
          proofRefs: ["proof:other-scenario:outcome:sha256:" + "7".repeat(64)],
        },
      })),
    };

    expect(() => compare({
      baseline: invalidBaseline,
      after,
      scenarioDefinitions: [{ id: "plain-conversation", scenarioVersion: 1, criticalSafety: false }],
    })).toThrow(/subject-bound|proof/i);
  });

  it("rejects a fixed comparison when any intersecting scenario lacks a definition", () => {
    const compare = (controllerScenarioContract as Record<string, unknown>).compareControllerEvaluations as (input: unknown) => unknown;
    const baseline = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [baseTrial],
    });
    const after = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [baseTrial, trialForScenario("new-safety-case", { trial: 2 })],
    });

    expect(() => compare({
      baseline,
      after,
      scenarioDefinitions: [{ id: "plain-conversation", scenarioVersion: 1, criticalSafety: false }],
    })).toThrow(/definition|criticalSafety/i);
  });

  it("rejects legacy summaries without a scenario version before fixed comparison", () => {
    const compare = (controllerScenarioContract as Record<string, unknown>).compareControllerEvaluations as (input: unknown) => unknown;
    const baseline = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [baseTrial],
    });
    const after = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [baseTrial],
    });
    const legacyBaseline = {
      ...baseline,
      scenarios: baseline.scenarios.map(({ scenarioVersion: _version, ...summary }) => summary),
    };

    expect(() => compare({
      baseline: legacyBaseline,
      after,
      scenarioDefinitions: [{ id: "plain-conversation", scenarioVersion: 1, criticalSafety: false }],
    })).toThrow(/summary|version/i);
  });

  it.each([
    ["wall time", { metrics: { ...baseTrial.metrics, wallMs: baseTrial.budget.maxWallMs + 1, turns: 1, toolCalls: 0 } }],
    ["turns", { metrics: { ...baseTrial.metrics, turns: baseTrial.budget.maxTurns + 1, toolCalls: 0 } }],
    ["tool calls", { metrics: { ...baseTrial.metrics, turns: 1, toolCalls: baseTrial.budget.maxToolCalls + 1 } }],
    ["tokens", { metrics: { ...baseTrial.metrics, turns: 1, toolCalls: 0, tokens: baseTrial.budget.maxTokens + 1 } }],
    ["cost", {
      budget: { ...baseTrial.budget, maxCostUsd: 1 },
      metrics: { ...baseTrial.metrics, turns: 1, toolCalls: 0, costUsd: 2 },
    }],
  ] as const)("rejects an over-budget %s measurement", (_name, overrides) => {
    const validate = (controllerScenarioContract as Record<string, unknown>).validateControllerScenarioTrialBudget as ((candidate: unknown) => unknown) | undefined;
    expect(typeof validate).toBe("function");
    expect(() => validate?.({ ...baseTrial, ...overrides })).toThrow(/budget|bound|exceed/i);
  });

  it("preserves unavailable token and cost metrics instead of fabricating values", () => {
    const validate = (controllerScenarioContract as Record<string, unknown>).validateControllerScenarioTrialBudget as ((candidate: unknown) => unknown) | undefined;
    expect(typeof validate).toBe("function");
    expect(() => validate?.({
      ...baseTrial,
      metrics: { ...baseTrial.metrics, turns: 1, toolCalls: 0, tokens: null, costUsd: null },
    })).not.toThrow();
  });

  it("allows fake scripted trials when token and cost availability is null on both sides", () => {
    const compare = (controllerScenarioContract as Record<string, unknown>).compareControllerEvaluations as (input: unknown) => unknown;
    const unavailableMetrics = { ...baseTrial.metrics, turns: 1, toolCalls: 0, tokens: null, costUsd: null };
    const baseline = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [{ ...baseTrial, metrics: unavailableMetrics }],
    });
    const after = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [{ ...baseTrial, metrics: unavailableMetrics }],
    });

    expect(compare({
      baseline,
      after,
      scenarioDefinitions: [{ id: "plain-conversation", scenarioVersion: 1, criticalSafety: false }],
    })).toMatchObject({ status: "comparable" });
  });

  it("rejects null-versus-number token availability drift", () => {
    const compare = (controllerScenarioContract as Record<string, unknown>).compareControllerEvaluations as (input: unknown) => unknown;
    const baseline = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [{ ...baseTrial, metrics: { ...baseTrial.metrics, tokens: null } }],
    });
    const after = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [baseTrial],
    });

    expect(() => compare({
      baseline,
      after,
      scenarioDefinitions: [{ id: "plain-conversation", scenarioVersion: 1, criticalSafety: false }],
    })).toThrow(/availability|token.*usage|comparable/i);
  });

  it("rejects unavailable token usage for a real provider even when both sides are null", () => {
    const compare = (controllerScenarioContract as Record<string, unknown>).compareControllerEvaluations as (input: unknown) => unknown;
    const realHarness = { ...baseTrial.harness, provider: "codex", model: "gpt-5.6-sol" };
    const unavailableMetrics = { ...baseTrial.metrics, tokens: null, costUsd: null };
    const baseline = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [{ ...baseTrial, harness: realHarness, metrics: unavailableMetrics }],
    });
    const after = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [{ ...baseTrial, harness: realHarness, metrics: unavailableMetrics }],
    });

    expect(() => compare({
      baseline,
      after,
      scenarioDefinitions: [{ id: "plain-conversation", scenarioVersion: 1, criticalSafety: false }],
    })).toThrow(/real provider|provider usage|unavailable.*real/i);
  });
});

type ControllerScenarioContractReport = ReturnType<typeof aggregateControllerEvaluation>;
