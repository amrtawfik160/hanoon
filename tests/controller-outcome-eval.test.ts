import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { aggregateControllerEvaluation } from "../src/eval/controller-scenario-contract";
import {
  CONTROLLER_ASSERTION_REGISTRY,
  controllerScenarioResourceStats,
  loadControllerScenarioCorpus,
  runControllerScenarioTrials,
  validateControllerAssertionRegistry,
} from "./support/controller-scenario-harness";
import {
  seedCompletedControllerTurn,
  submittedControllerFixture,
} from "./support/controller-trust-fixtures";

type RunnerModule = {
  classifyControllerEvidence(trials: Awaited<ReturnType<typeof runControllerScenarioTrials>>): "fixed" | "smoke" | "strong";
  evaluateControllerOutcomes(
    options: {
      checkpoint: "baseline" | "kernel" | "cutover";
      trials: number;
      seed: number;
      baseline?: string;
      output: string;
      replace: boolean;
    },
    dependencies: {
      readGitIdentity(): { commit: string; dirty: boolean };
      runTrials(): Promise<Awaited<ReturnType<typeof runControllerScenarioTrials>>>;
    },
  ): Promise<{ exitCode: number; criticalSafetyFailed: boolean; report: { status: string } }>;
};

async function runnerModule(): Promise<RunnerModule> {
  const executableModule = ["..", "scripts", "eval-controller-outcomes.mjs"].join("/");
  return await import(executableModule) as RunnerModule;
}

const execFileAsync = promisify(execFile);

function evaluationOutput(): string {
  return join(mkdtempSync(join(tmpdir(), "hanoon-eval-")), "baseline.json");
}

it("writes a bounded fixed-harness report with disclosed denominators", async () => {
  const output = evaluationOutput();

  await execFileAsync(process.execPath, [
    "scripts/eval-controller-outcomes.mjs",
    "--checkpoint", "baseline",
    "--trials", "2",
    "--output", output,
  ]);

  const report = JSON.parse(readFileSync(output, "utf8"));
  expect(report).toMatchObject({ schemaVersion: 1, label: "fixed", trialCount: 4 });
  expect(report.scenarios).toEqual(expect.arrayContaining([
    expect.objectContaining({ scenarioId: "plain-conversation", denominator: 2 }),
    expect.objectContaining({ scenarioId: "current-job-status", denominator: 2 }),
  ]));
});

it("seeds downstream completed state without invoking production completion methods", async () => {
  const fixture = submittedControllerFixture();
  try {
    // These throws are the mutation guard: a downstream seed must remain
    // usable even if the production completion path is unavailable.
    vi.spyOn(fixture.store, "adoptSubmittedControllerTurnFence").mockImplementation(() => {
      throw new Error("production adoption must not seed this downstream fixture");
    });
    vi.spyOn(fixture.store, "proposeControllerFinalization").mockImplementation(() => {
      throw new Error("production proposal must not seed this downstream fixture");
    });
    vi.spyOn(fixture.store, "completeControllerTurnFromFinalization").mockImplementation(() => {
      throw new Error("production completion must not seed this downstream fixture");
    });

    seedCompletedControllerTurn(fixture.db, fixture.turn, "independently seeded answer");

    expect(fixture.store.getControllerTurn(fixture.turn.id)).toMatchObject({
      state: "completed",
      responseText: "independently seeded answer",
    });
    expect(fixture.store.readControllerDigest(fixture.turn.controllerKey, 5)).toEqual([
      { ownerText: fixture.turn.inputText, agentText: "independently seeded answer" },
    ]);
    expect(fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`)).toMatchObject({
      status: "pending",
      payload: { text: "independently seeded answer" },
    });
  } finally {
    await fixture.harness.lifecycle.dispose();
  }
});

it("refuses to overwrite an existing outcome report without --replace", async () => {
  const output = evaluationOutput();
  const args = [
    "scripts/eval-controller-outcomes.mjs",
    "--checkpoint", "baseline",
    "--trials", "1",
    "--output", output,
  ];

  await execFileAsync(process.execPath, args);
  await expect(execFileAsync(process.execPath, args)).rejects.toMatchObject({ code: 1 });
});

it("replaces an existing report with owner-only permissions when --replace is supplied", async () => {
  const output = evaluationOutput();
  const args = [
    "scripts/eval-controller-outcomes.mjs",
    "--checkpoint", "baseline",
    "--trials", "1",
    "--output", output,
  ];

  await execFileAsync(process.execPath, args);
  chmodSync(output, 0o644);
  await execFileAsync(process.execPath, [...args, "--replace"]);

  expect(statSync(output).mode & 0o777).toBe(0o600);
});

it("requires an absolute output path even when a relative path resolves outside the repository", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hanoon-eval-"));
  const output = join(directory, "baseline.json");
  try {
    await expect(execFileAsync(process.execPath, [
      "scripts/eval-controller-outcomes.mjs",
      "--checkpoint", "baseline",
      "--trials", "1",
      "--output", relative(process.cwd(), output),
    ])).rejects.toMatchObject({ code: 1 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects an in-repository output whose first segment begins with two dots", async () => {
  const directory = join(process.cwd(), "..reports");
  mkdirSync(directory, { recursive: true });
  try {
    await expect(execFileAsync(process.execPath, [
      "scripts/eval-controller-outcomes.mjs",
      "--checkpoint", "baseline",
      "--trials", "1",
      "--output", join(directory, "out.json"),
    ])).rejects.toMatchObject({ code: 1 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("runs the cumulative kernel checkpoint with its fixed safety cases", async () => {
  const output = evaluationOutput();
  await execFileAsync(process.execPath, [
    "scripts/eval-controller-outcomes.mjs",
    "--checkpoint", "kernel",
    "--trials", "1",
    "--output", output,
  ]);
  const report = JSON.parse(readFileSync(output, "utf8")) as {
    status: string;
    scenarios: Array<{ scenarioId: string; denominator: number; passed: number }>;
  };
  expect(report.status).toBe("passed");
  expect(report.scenarios).toEqual(expect.arrayContaining([
    expect.objectContaining({ scenarioId: "duplicate-mutation-replay", denominator: 1, passed: 1 }),
    expect.objectContaining({ scenarioId: "stale-capability-fence", denominator: 1, passed: 1 }),
  ]));
});

it("records the current job status through the registered controller tool", async () => {
  const trials = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const statusTrial = trials.find((trial) => trial.scenarioId === "current-job-status");

  expect(statusTrial?.trace).toMatchObject({
    status: "passed",
    proofRefs: [
      expect.stringMatching(/^proof:current-job-status:/),
      expect.stringMatching(/assertion:job_status_capability_observed:true:sha256:[0-9a-f]{64}$/),
    ],
  });

});

it("classifies missing fixed identity as strong evidence rather than fixed", async () => {
  const runner = await runnerModule();
  const [fixedTrial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  expect(runner.classifyControllerEvidence([
    { ...fixedTrial, scenarioDefinitionSha256: undefined },
  ])).toBe("strong");
  expect(runner.classifyControllerEvidence([
    { ...fixedTrial, harness: { ...fixedTrial.harness, outerTaskTools: undefined } },
  ])).toBe("strong");
});

it("fails closed when the corpus adds an unknown or decorative assertion", () => {
  const corpus = loadControllerScenarioCorpus();
  expect(() => validateControllerAssertionRegistry({
    ...corpus,
    cases: corpus.cases.map((scenarioCase, index) => index === 0
      ? { ...scenarioCase, requiredOutcomeAssertions: [...scenarioCase.requiredOutcomeAssertions, "decorative_assertion"] }
      : scenarioCase),
  })).toThrow(/unknown controller assertion/i);
});

it("fails before writing when the current identity or trial is dirty", async () => {
  const runner = await runnerModule();
  const [trial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const output = evaluationOutput();
  await expect(runner.evaluateControllerOutcomes({
    checkpoint: "baseline",
    trials: 1,
    seed: 8122026,
    output,
    replace: false,
  }, {
    readGitIdentity: () => ({ commit: "a".repeat(40), dirty: false }),
    runTrials: async () => [{ ...trial, harness: { ...trial.harness, dirty: true, hanoonCommit: "a".repeat(40) } }],
  })).rejects.toThrow(/dirty/i);
  expect(() => readFileSync(output, "utf8")).toThrow();
});

it("records measured wall time and explicit unavailable token usage", async () => {
  const [trial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  expect(trial.metrics.wallMs).toBeGreaterThan(0);
  expect(trial.metrics.tokens).toBeNull();
});

it("preserves the process-only recovery send in durable assertion evidence", async () => {
  const trials = await runControllerScenarioTrials({ checkpoint: "cutover", trials: 1, seed: 8122026 });
  const processOnlyTrial = trials.find((trial) => trial.scenarioId === "process-only-finalization");

  expect(processOnlyTrial?.trace.status).toBe("passed");
  expect(processOnlyTrial?.trace.proofRefs).toContainEqual(
    expect.stringMatching(/assertion:recovery_prompt_sent:true:sha256:[0-9a-f]{64}$/),
  );
});

it("disposes every repeated scenario resource, including restart scenarios", async () => {
  const before = controllerScenarioResourceStats();
  await runControllerScenarioTrials({ checkpoint: "cutover", trials: 2, seed: 8122026 });
  const after = controllerScenarioResourceStats();
  expect(after.created - before.created).toBe(18);
  expect(after.disposed - before.disposed).toBe(18);
  expect(after.active).toBe(0);
});

it("disposes the current resource when trial construction throws", async () => {
  const before = controllerScenarioResourceStats();
  const priorCommit = process.env.HANOON_EVAL_COMMIT;
  process.env.HANOON_EVAL_COMMIT = "f".repeat(40);
  try {
    await expect(runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 }))
      .rejects.toThrow(/configured Hanoon commit/i);
  } finally {
    if (priorCommit === undefined) delete process.env.HANOON_EVAL_COMMIT;
    else process.env.HANOON_EVAL_COMMIT = priorCommit;
  }
  const after = controllerScenarioResourceStats();
  expect(after.created - before.created).toBe(1);
  expect(after.disposed - before.disposed).toBe(1);
  expect(after.active).toBe(0);
});

it("discloses the registered controller tool surface deterministically", async () => {
  const [firstRun, secondRun] = await Promise.all([
    runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 }),
    runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 }),
  ]);
  const firstStatusTrial = firstRun.find((trial) => trial.scenarioId === "current-job-status");
  const firstSurface = firstRun[0]?.harness;

  expect(firstStatusTrial?.harness.advertisedTools).toContain("telegram_agent_job_status");
  expect(firstStatusTrial?.harness.parameterSchemaSha256.telegram_agent_job_status)
    .toMatch(/^[0-9a-f]{64}$/);
  expect(firstStatusTrial?.harness.capabilityManifestSha256)
    .not.toBe("874faf4af042371a613c564f29eb2e390559fb3151f2feb193249c68d1f789f1");
  expect(firstStatusTrial?.harness.parameterSchemaSha256).not.toEqual({});
  expect(firstRun.every((trial) => (
    JSON.stringify(trial.harness.advertisedTools) === JSON.stringify(firstSurface?.advertisedTools)
    && JSON.stringify(trial.harness.parameterSchemaSha256) === JSON.stringify(firstSurface?.parameterSchemaSha256)
    && trial.harness.capabilityManifestSha256 === firstSurface?.capabilityManifestSha256
  ))).toBe(true);
  expect(secondRun.map((trial) => trial.harness)).toEqual(firstRun.map((trial) => trial.harness));
});

it("can import the runner without executing its CLI entrypoint", async () => {
  await expect(execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    'await import("./scripts/eval-controller-outcomes.mjs")',
  ])).resolves.toMatchObject({ stderr: "" });
});

it("labels exactly one non-fixed provider trial as smoke evidence", async () => {
  const runner = await runnerModule();

  const [fixedTrial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  expect(runner.classifyControllerEvidence([
    { ...fixedTrial, harness: { ...fixedTrial.harness, provider: "one-off-provider", model: "one-off-model" } },
  ])).toBe("smoke");
});

it("labels fixed-scenario identity variation as strong evidence", async () => {
  const runner = await runnerModule();
  const [fixedTrial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });

  expect(runner.classifyControllerEvidence([
    fixedTrial,
    {
      ...fixedTrial,
      trial: 2,
      budget: { ...fixedTrial.budget, maxTokens: fixedTrial.budget.maxTokens + 1 },
    },
  ])).toBe("strong");
});

it("returns a nonzero evaluation result for an injected critical-safety outcome failure", async () => {
  const runner = await runnerModule();

  const [trial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const output = evaluationOutput();
  const evaluation = await runner.evaluateControllerOutcomes({
    checkpoint: "baseline",
    trials: 1,
    seed: 8122026,
    output,
    replace: false,
  }, {
    readGitIdentity: () => ({ commit: "a".repeat(40), dirty: false }),
    runTrials: async () => [{
      ...trial,
      scenarioId: "process-only-finalization",
      harness: { ...trial.harness, dirty: false, hanoonCommit: "a".repeat(40) },
      outcome: { ...trial.outcome, status: "failed" as const },
      trace: {
        ...trial.trace,
        proofRefs: trial.trace.proofRefs.map((_, index) =>
          `proof:process-only-finalization:injected-trace-${index}`),
      },
      answer: {
        ...trial.answer,
        proofRefs: trial.answer.proofRefs.map((_, index) =>
          `proof:process-only-finalization:injected-answer-${index}`),
      },
    }],
  });

  expect(evaluation).toMatchObject({ exitCode: 1, criticalSafetyFailed: true, report: { status: "failed" } });
});

it.each(["outcome", "trace", "answer"] as const)(
  "returns a nonzero evaluation result for an incomplete %s layer",
  async (layer) => {
    const runner = await runnerModule();
    const [sourceTrial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
    const trial = {
      ...sourceTrial,
      harness: { ...sourceTrial.harness, dirty: false },
      [layer]: { ...sourceTrial[layer], status: "incomplete" as const, proofRefs: [] },
    } as typeof sourceTrial;
    const output = evaluationOutput();

    const evaluation = await runner.evaluateControllerOutcomes({
      checkpoint: "baseline",
      trials: 1,
      seed: 8122026,
      output,
      replace: false,
    }, {
      readGitIdentity: () => ({ commit: trial.harness.hanoonCommit, dirty: false }),
      runTrials: async () => [trial],
    });

    expect(evaluation).toMatchObject({ exitCode: 1, criticalSafetyFailed: false, report: { status: "incomplete" } });
  },
);

it("requires the exact recovery prompt markers rather than merely one send", () => {
  const assertion = CONTROLLER_ASSERTION_REGISTRY.recovery_prompt_sent;
  const baseFacts = { sentTexts: [], recoveryPromptTexts: [] } as unknown as Parameters<typeof assertion>[0];

  expect(assertion({ ...baseFacts, sentTexts: ["an unrelated provider continuation"] })).toBe(false);
  expect(assertion({
    ...baseFacts,
    recoveryPromptTexts: ["Inspect telegram_agent_turn_evidence and call telegram_agent_respond with the evidence already available."],
  })).toBe(true);
});

it("uses an effective project policy digest and changes identity when policy content changes", async () => {
  const harnessModule = await import("./support/controller-scenario-harness");
  const baseline = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const kernel = await runControllerScenarioTrials({ checkpoint: "kernel", trials: 1, seed: 8122026 });

  expect(baseline[0]?.harness.policySha256).not.toBe(kernel.find((trial) => trial.scenarioId === "duplicate-mutation-replay")?.harness.policySha256);
  expect(harnessModule.controllerScenarioPolicySha256({ policy: "one" }))
    .not.toBe(harnessModule.controllerScenarioPolicySha256({ policy: "two" }));
});

it("rejects a baseline whose passed proof is not scenario-bound before running comparison trials", async () => {
  const runner = await runnerModule();
  const [sourceTrial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const directory = mkdtempSync(join(tmpdir(), "hanoon-invalid-baseline-"));
  const baselinePath = join(directory, "baseline.json");
  const output = join(directory, "after.json");
  try {
    const baseline = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: [{
        ...sourceTrial,
        harness: { ...sourceTrial.harness, dirty: false },
        outcome: {
          ...sourceTrial.outcome,
          proofRefs: ["proof:other-scenario:outcome:sha256:" + "8".repeat(64)],
        },
      }],
    });
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });

    await expect(runner.evaluateControllerOutcomes({
      checkpoint: "baseline",
      trials: 1,
      seed: 8122026,
      baseline: baselinePath,
      output,
      replace: false,
    }, {
      readGitIdentity: () => ({ commit: sourceTrial.harness.hanoonCommit, dirty: false }),
      runTrials: async () => [sourceTrial],
    })).rejects.toThrow(/subject-bound|proof/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("requires stale approval settlement denial and zero-effect proof in the fixed stale scenario", async () => {
  const scenarioCase = loadControllerScenarioCorpus().cases.find((candidate) => candidate.id === "stale-capability-fence");
  expect(scenarioCase?.requiredOutcomeAssertions).toContain("stale_approval_denied");
  expect(scenarioCase?.requiredOutcomeAssertions).toContain("stale_approval_no_effect");
  expect(scenarioCase?.requiredTraceAssertions).toContain("stale_approval_denied_before_effect");

  const staleTrial = (await runControllerScenarioTrials({ checkpoint: "kernel", trials: 1, seed: 8122026 }))
    .find((candidate) => candidate.scenarioId === "stale-capability-fence");
  if (!staleTrial) throw new Error("stale-capability-fence trial was not produced");
  expect(staleTrial.outcome.status).toBe("passed");
  expect(staleTrial.trace.status).toBe("passed");
  expect(staleTrial.outcome.proofRefs).toEqual(expect.arrayContaining([
    expect.stringMatching(/assertion:stale_approval_denied:true:/),
    expect.stringMatching(/assertion:stale_approval_no_effect:true:/),
  ]));
});

it("runs every kernel and cutover case as a durable fixed scenario", async () => {
  const kernelTrials = await runControllerScenarioTrials({ checkpoint: "kernel", trials: 1, seed: 8122026 });
  const cutoverTrials = await runControllerScenarioTrials({ checkpoint: "cutover", trials: 1, seed: 8122026 });

  expect(kernelTrials.map((currentTrial) => currentTrial.scenarioId)).toEqual([
    "plain-conversation",
    "current-job-status",
    "duplicate-mutation-replay",
    "stale-capability-fence",
  ]);
  expect(cutoverTrials.map((currentTrial) => currentTrial.scenarioId)).toEqual([
    "plain-conversation",
    "current-job-status",
    "process-only-finalization",
    "unsupported-success-claim",
    "duplicate-mutation-replay",
    "stale-capability-fence",
    "telegram-allow-once",
    "restart-after-owner-tap",
    "durable-deferred-monitor",
  ]);
  for (const currentTrial of [...kernelTrials, ...cutoverTrials]) {
    expect(currentTrial.outcome.status, currentTrial.scenarioId).toBe("passed");
    expect(currentTrial.outcome.proofRefs.length, currentTrial.scenarioId).toBeGreaterThan(0);
    if (currentTrial.answer.status === "passed") {
      expect(currentTrial.answer.proofRefs.length, currentTrial.scenarioId).toBeGreaterThan(0);
    }
  }
});

it("fails closed when fixed comparison token evidence is unavailable", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "hanoon-eval-comparison-"));
  const baseline = join(directory, "baseline.json");
  const output = join(directory, "after.json");
  try {
    const baselineReport = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: (await runControllerScenarioTrials({ checkpoint: "baseline", trials: 3, seed: 8122026 })).map((currentTrial) => ({
        ...currentTrial,
        harness: { ...currentTrial.harness, dirty: false },
      })),
    });
    writeFileSync(baseline, `${JSON.stringify(baselineReport, null, 2)}\n`, { mode: 0o600 });

    await expect(execFileAsync(process.execPath, [
      "scripts/eval-controller-outcomes.mjs",
      "--checkpoint", "cutover",
      "--trials", "3",
      "--seed", "8122026",
      "--baseline", baseline,
      "--output", output,
      "--replace",
    ])).rejects.toMatchObject({ stderr: expect.stringMatching(/unavailable token budget evidence/) });
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("requires an absolute validated baseline report path", async () => {
  const output = evaluationOutput();
  await expect(execFileAsync(process.execPath, [
    "scripts/eval-controller-outcomes.mjs",
    "--checkpoint", "cutover",
    "--trials", "1",
    "--baseline", "relative-baseline.json",
    "--output", output,
  ])).rejects.toMatchObject({ code: 1 });
});
