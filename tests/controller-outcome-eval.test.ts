import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { aggregateControllerEvaluation } from "../src/eval/controller-scenario-contract";
import { CONTROLLER_TOOL_NAMES } from "../src/controller/capability-policy";
import { composeControllerInstructions } from "../src/controller/instructions";
import {
  CONTROLLER_ASSERTION_REGISTRY,
  controllerScenarioResourceStats,
  loadControllerScenarioCorpus,
  runControllerScenarioTrials,
  type ControllerScenarioRunOptions,
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
      runTrials(options: ControllerScenarioRunOptions): Promise<Awaited<ReturnType<typeof runControllerScenarioTrials>>>;
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

async function execCleanOutcomeEvaluator(args: readonly string[]) {
  const gitDirectory = mkdtempSync(join(tmpdir(), "hanoon-clean-git-"));
  const gitPath = join(gitDirectory, "git");
  writeFileSync(gitPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "rev-parse" && args[1] === "HEAD") {
  process.stdout.write("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n");
} else if (args[0] === "status" && args.includes("--porcelain")) {
  process.stdout.write("");
} else {
  process.exit(2);
}
`, { mode: 0o755 });
  chmodSync(gitPath, 0o755);
  try {
    return await execFileAsync(process.execPath, args, {
      env: { ...process.env, PATH: `${gitDirectory}:${process.env.PATH ?? ""}` },
    });
  } finally {
    rmSync(gitDirectory, { recursive: true, force: true });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function rebindTrialSubject(
  trial: Awaited<ReturnType<typeof runControllerScenarioTrials>>[number],
  scenarioId: string,
) {
  const rebind = (proofRefs: readonly string[]) => proofRefs.map((proofRef) => proofRef.replaceAll(trial.scenarioId, scenarioId));
  return {
    ...trial,
    scenarioId,
    scenarioDefinitionSha256: "0".repeat(64),
    outcome: { ...trial.outcome, proofRefs: rebind(trial.outcome.proofRefs) },
    trace: { ...trial.trace, proofRefs: rebind(trial.trace.proofRefs) },
    answer: { ...trial.answer, proofRefs: rebind(trial.answer.proofRefs) },
    evidenceRecords: trial.evidenceRecords?.map((record) => ({
      ...record,
      subject: scenarioId,
      ref: record.ref.replaceAll(trial.scenarioId, scenarioId),
    })),
  };
}

async function cleanScenarioTrials(
  checkpoint: "baseline" | "kernel" | "cutover",
  trials = 1,
  seed = 8122026,
) {
  return (await runControllerScenarioTrials({ checkpoint, trials, seed })).map((trial) => ({
    ...trial,
    harness: { ...trial.harness, dirty: false },
  }));
}

it("writes a bounded fixed-harness report with disclosed denominators", async () => {
  const output = evaluationOutput();

  await execCleanOutcomeEvaluator([
    "scripts/eval-controller-outcomes.mjs",
    "--checkpoint", "baseline",
    "--trials", "2",
    "--output", output,
  ]);

  const report = JSON.parse(readFileSync(output, "utf8"));
  expect(report).toMatchObject({
    schemaVersion: 1,
    label: "fixed",
    run: { checkpoint: "baseline", trialsPerScenario: 2, seed: 8122026 },
    trialCount: 4,
  });
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
    await fixture.dispose();
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

  await execCleanOutcomeEvaluator(args);
  await expect(execCleanOutcomeEvaluator(args)).rejects.toMatchObject({ code: 1 });
});

it("replaces an existing report with owner-only permissions when --replace is supplied", async () => {
  const output = evaluationOutput();
  const args = [
    "scripts/eval-controller-outcomes.mjs",
    "--checkpoint", "baseline",
    "--trials", "1",
    "--output", output,
  ];

  await execCleanOutcomeEvaluator(args);
  chmodSync(output, 0o644);
  await execCleanOutcomeEvaluator([...args, "--replace"]);

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
  await expect(execFileAsync(process.execPath, [
    "scripts/eval-controller-outcomes.mjs",
    "--checkpoint", "baseline",
    "--trials", "1",
    "--output", join(process.cwd(), "..reports", "out.json"),
  ])).rejects.toMatchObject({ code: 1 });
});

it("runs the cumulative kernel checkpoint with its fixed safety cases", async () => {
  const output = evaluationOutput();
  await execCleanOutcomeEvaluator([
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
      "fact:current-job-status:trace:job_status_capability_observed",
    ],
  });

});

it("binds provenance to composed instructions and redacted fact records", async () => {
  const trials = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const plainTrial = trials.find((trial) => trial.scenarioId === "plain-conversation");
  if (!plainTrial) throw new Error("plain-conversation trial was not produced");
  const evidenceRecords = plainTrial.evidenceRecords ?? [];

  expect(plainTrial.harness.instructionSha256).toBe(sha256(composeControllerInstructions(null)));
  expect(plainTrial.harness.instructionSha256).not.toBe(sha256("fixed-controller-scenario-instruction-v1"));
  expect(plainTrial.harness.contextSha256).not.toBe(sha256(`${plainTrial.scenarioId}:${plainTrial.trial}:8122026`));
  expect(evidenceRecords.length).toBeGreaterThan(0);
  expect(evidenceRecords.every((record) => record.subject === plainTrial.scenarioId)).toBe(true);
  expect(evidenceRecords.every((record) => Object.keys(record.facts).length > 0)).toBe(true);
  expect(JSON.stringify(evidenceRecords)).not.toContain("Hello from Hanoon.");
  expect(plainTrial.outcome.proofRefs.some((proofRef) => /assertion:.*:(?:true|false):/.test(proofRef))).toBe(false);
  const recordsByRef = new Map(evidenceRecords.map((record) => [record.ref, record]));
  expect(plainTrial.outcome.proofRefs.filter((proofRef) => proofRef.startsWith("fact:")).every((proofRef) => recordsByRef.has(proofRef))).toBe(true);
});

it("rejects missing fixed identity rather than labeling it strong", async () => {
  const runner = await runnerModule();
  const [fixedTrial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  expect(() => runner.classifyControllerEvidence([
    { ...fixedTrial, scenarioDefinitionSha256: undefined },
  ])).toThrow(/identity|incomplete/i);
  expect(() => runner.classifyControllerEvidence([
    { ...fixedTrial, harness: { ...fixedTrial.harness, outerTaskTools: undefined } },
  ])).toThrow(/identity|incomplete/i);
});

it("rejects an initially dirty evaluator before running any trials", async () => {
  const runner = await runnerModule();
  const output = evaluationOutput();
  let trialsStarted = false;
  await expect(runner.evaluateControllerOutcomes({
    checkpoint: "baseline",
    trials: 1,
    seed: 8122026,
    output,
    replace: false,
  }, {
    readGitIdentity: () => ({ commit: "a".repeat(40), dirty: true }),
    runTrials: async () => {
      trialsStarted = true;
      throw new Error("trials must not start from a dirty evaluator");
    },
  })).rejects.toThrow(/dirty/i);
  expect(trialsStarted).toBe(false);
  expect(() => readFileSync(output)).toThrow();
});

it.each([
  ["unknown scenario id", (trial: Awaited<ReturnType<typeof runControllerScenarioTrials>>[number]) => rebindTrialSubject(trial, "unknown-scenario")],
  ["unknown scenario version", (trial: Awaited<ReturnType<typeof runControllerScenarioTrials>>[number]) => ({
    ...trial,
    scenarioVersion: 2,
    scenarioDefinitionSha256: "0".repeat(64),
  })],
  ["wrong scenario definition", (trial: Awaited<ReturnType<typeof runControllerScenarioTrials>>[number]) => ({
    ...trial,
    scenarioDefinitionSha256: "0".repeat(64),
  })],
] as const)("rejects %s without replacing the output", async (_label, mutate) => {
  const runner = await runnerModule();
  const [sourceTrial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const output = evaluationOutput();
  writeFileSync(output, "keep this report\n", { mode: 0o600 });
  const cleanTrial = { ...sourceTrial, harness: { ...sourceTrial.harness, dirty: false } };

  await expect(runner.evaluateControllerOutcomes({
    checkpoint: "baseline",
    trials: 1,
    seed: 8122026,
    output,
    replace: true,
  }, {
    readGitIdentity: () => ({ commit: sourceTrial.harness.hanoonCommit, dirty: false }),
    runTrials: async () => [mutate(cleanTrial)],
  })).rejects.toThrow(/scenario|definition|version/i);

  expect(readFileSync(output, "utf8")).toBe("keep this report\n");
});

it("rejects a required answer grader relabeled not_applicable before writing", async () => {
  const runner = await runnerModule();
  const [sourceTrial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const output = evaluationOutput();
  const invalidTrial = {
    ...sourceTrial,
    harness: { ...sourceTrial.harness, dirty: false },
    answer: { ...sourceTrial.answer, status: "not_applicable" as const, proofRefs: [] },
  };

  await expect(runner.evaluateControllerOutcomes({
    checkpoint: "baseline",
    trials: 1,
    seed: 8122026,
    output,
    replace: true,
  }, {
    readGitIdentity: () => ({ commit: sourceTrial.harness.hanoonCommit, dirty: false }),
    runTrials: async () => [invalidTrial],
  })).rejects.toThrow(/answer|not_applicable|required/i);

  expect(existsSync(output)).toBe(false);
});

it.each([
  ["a required fact is false", (sourceTrial: Awaited<ReturnType<typeof runControllerScenarioTrials>>[number]) => ({
    ...sourceTrial,
    evidenceRecords: sourceTrial.evidenceRecords?.map((record, index) => index === 0
      ? { ...record, observed: false }
      : record),
  })],
  ["a passed layer omits required proof", (sourceTrial: Awaited<ReturnType<typeof runControllerScenarioTrials>>[number]) => ({
    ...sourceTrial,
    outcome: { ...sourceTrial.outcome, proofRefs: sourceTrial.outcome.proofRefs.slice(0, 1) },
  })],
] as const)("rejects a current trial when %s", async (_label, mutate) => {
  const runner = await runnerModule();
  const [sourceTrial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const output = evaluationOutput();
  const invalidTrial = mutate({ ...sourceTrial, harness: { ...sourceTrial.harness, dirty: false } });

  await expect(runner.evaluateControllerOutcomes({
    checkpoint: "baseline",
    trials: 1,
    seed: 8122026,
    output,
    replace: true,
  }, {
    readGitIdentity: () => ({ commit: sourceTrial.harness.hanoonCommit, dirty: false }),
    runTrials: async () => [invalidTrial],
  })).rejects.toThrow(/evidence|observed|proof|complete/i);

  expect(existsSync(output)).toBe(false);
});

it("validates a fixed baseline against current scenario applicability before comparison", async () => {
  const runner = await runnerModule();
  const [sourceTrial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const cleanTrial = { ...sourceTrial, harness: { ...sourceTrial.harness, dirty: false } };
  const directory = mkdtempSync(join(tmpdir(), "hanoon-invalid-applicability-baseline-"));
  const baselinePath = join(directory, "baseline.json");
  const output = join(directory, "after.json");
  try {
    const invalidBaseline = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      run: { checkpoint: "baseline", trialsPerScenario: 1, seed: 8122026 },
      trials: [{
        ...cleanTrial,
        answer: { ...cleanTrial.answer, status: "not_applicable" as const, proofRefs: [] },
      }],
    });
    writeFileSync(baselinePath, `${JSON.stringify(invalidBaseline, null, 2)}\n`, { mode: 0o600 });

    await expect(runner.evaluateControllerOutcomes({
      checkpoint: "baseline",
      trials: 1,
      seed: 8122026,
      baseline: baselinePath,
      output,
      replace: true,
    }, {
      readGitIdentity: () => ({ commit: sourceTrial.harness.hanoonCommit, dirty: false }),
      runTrials: async () => [cleanTrial],
    })).rejects.toThrow(/applicability|answer|not_applicable|required/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  ["scenario definition identity", (trial: Awaited<ReturnType<typeof runControllerScenarioTrials>>[number]) => ({
    ...trial,
    scenarioDefinitionSha256: undefined,
  })],
  ["outer task tool identity", (trial: Awaited<ReturnType<typeof runControllerScenarioTrials>>[number]) => ({
    ...trial,
    harness: { ...trial.harness, outerTaskTools: undefined },
  })],
] as const)("rejects a current trial missing %s instead of writing strong evidence", async (_label, mutate) => {
  const runner = await runnerModule();
  const [sourceTrial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const output = evaluationOutput();
  const cleanTrial = { ...sourceTrial, harness: { ...sourceTrial.harness, dirty: false } };

  await expect(runner.evaluateControllerOutcomes({
    checkpoint: "baseline",
    trials: 1,
    seed: 8122026,
    output,
    replace: true,
  }, {
    readGitIdentity: () => ({ commit: sourceTrial.harness.hanoonCommit, dirty: false }),
    runTrials: async () => [mutate(cleanTrial)],
  })).rejects.toThrow(/identity|incomplete/i);

  expect(existsSync(output)).toBe(false);
});

it("rejects self-attesting current proof strings in favor of resolvable facts", async () => {
  const runner = await runnerModule();
  const [sourceTrial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const output = evaluationOutput();
  const invalidTrial = {
    ...sourceTrial,
    harness: { ...sourceTrial.harness, dirty: false },
    outcome: {
      ...sourceTrial.outcome,
      proofRefs: [`proof:${sourceTrial.scenarioId}:assertion:controller_turn_completed:false`],
    },
  };

  await expect(runner.evaluateControllerOutcomes({
    checkpoint: "baseline",
    trials: 1,
    seed: 8122026,
    output,
    replace: true,
  }, {
    readGitIdentity: () => ({ commit: sourceTrial.harness.hanoonCommit, dirty: false }),
    runTrials: async () => [invalidTrial],
  })).rejects.toThrow(/fact|evidence|proof/i);

  expect(existsSync(output)).toBe(false);
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
  const trials = await cleanScenarioTrials("baseline");
  const trial = trials[0];
  if (!trial) throw new Error("baseline trial was not produced");
  const output = evaluationOutput();
  await expect(runner.evaluateControllerOutcomes({
    checkpoint: "baseline",
    trials: 1,
    seed: 8122026,
    output,
    replace: false,
  }, {
    readGitIdentity: () => ({ commit: "a".repeat(40), dirty: false }),
    runTrials: async () => trials.map((candidate, index) => ({
      ...candidate,
      harness: {
        ...candidate.harness,
        dirty: index === 0,
        hanoonCommit: "a".repeat(40),
      },
    })),
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
    "fact:process-only-finalization:trace:recovery_prompt_sent",
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

it("initializes each scenario through the production plugin entrypoint", async () => {
  const before = controllerScenarioResourceStats();
  await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const after = controllerScenarioResourceStats();
  expect(after.productionPluginInitializations - before.productionPluginInitializations).toBe(2);
});

it("uses a real fake-host lifecycle reload for restart-after-owner-tap", async () => {
  const before = controllerScenarioResourceStats() as Readonly<{ lifecycleReloads?: number }>;
  const trials = await runControllerScenarioTrials({ checkpoint: "cutover", trials: 1, seed: 8122026 });
  const after = controllerScenarioResourceStats() as Readonly<{ lifecycleReloads?: number }>;
  const restartTrial = trials.find((trial) => trial.scenarioId === "restart-after-owner-tap");
  const restartEvidenceRecords = restartTrial?.evidenceRecords ?? [];

  expect(after.lifecycleReloads).toBe((before.lifecycleReloads ?? 0) + 1);
  expect(restartTrial?.outcome.status).toBe("passed");
  expect(restartTrial?.trace.status).toBe("passed");
  expect(restartEvidenceRecords.some((record) => (
    record.assertion === "service_reopened_before_resolution" && record.facts.lifecycleHostsChanged === true
  ))).toBe(true);
});

it("requires an explicit cleanup contract on shared controller trust fixtures", async () => {
  const fixture = submittedControllerFixture();
  try {
    expect(typeof (fixture as unknown as { dispose?: unknown }).dispose).toBe("function");
  } finally {
    await fixture.dispose();
  }
});

it("disposes the current resource when trial construction throws", async () => {
  const before = controllerScenarioResourceStats();
  await expect(runControllerScenarioTrials({
    checkpoint: "baseline",
    trials: 1,
    seed: 8122026,
    runIdentity: { commit: "not-a-commit", dirty: false },
  })).rejects.toThrow(/invalid commit/i);
  const after = controllerScenarioResourceStats();
  expect(after.created - before.created).toBe(1);
  expect(after.disposed - before.disposed).toBe(1);
  expect(after.active).toBe(0);
});

it("disposes the fake host when production plugin initialization throws", async () => {
  const before = controllerScenarioResourceStats();
  await expect(runControllerScenarioTrials(
    { checkpoint: "baseline", trials: 1, seed: 8122026 },
    { initializePlugin: async () => { throw new Error("production initialization failed"); } },
  )).rejects.toThrow(/production initialization failed/i);
  const after = controllerScenarioResourceStats();
  expect(after.created - before.created).toBe(1);
  expect(after.disposed - before.disposed).toBe(1);
  expect(after.active).toBe(0);
});

it("keeps overlapping programmatic evaluations bound to their explicit run identity", async () => {
  const runner = await runnerModule();
  const trials = await cleanScenarioTrials("baseline");
  const outputOne = evaluationOutput();
  const outputTwo = evaluationOutput();
  const identityOne = { commit: "a".repeat(40), dirty: false };
  const identityTwo = { commit: "b".repeat(40), dirty: false };
  let started = 0;
  let markStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    markStarted = () => {
      started += 1;
      if (started === 2) resolve();
    };
  });
  let releaseRuns!: () => void;
  const runsReleased = new Promise<void>((resolve) => { releaseRuns = resolve; });
  const runTrials = async (options: ControllerScenarioRunOptions) => {
    markStarted();
    await runsReleased;
    const commit = options.runIdentity?.commit;
    if (!commit) throw new Error("run identity was not passed to scenario evaluation");
    return trials.map((trial) => ({ ...trial, harness: { ...trial.harness, hanoonCommit: commit } }));
  };

  const evaluate = (identity: { commit: string; dirty: boolean }, output: string) => runner.evaluateControllerOutcomes({
    checkpoint: "baseline",
    trials: 1,
    seed: 8122026,
    output,
    replace: false,
  }, {
    readGitIdentity: () => identity,
    runTrials,
  });
  const first = evaluate(identityOne, outputOne);
  const second = evaluate(identityTwo, outputTwo);
  await bothStarted;
  releaseRuns();
  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  expect(JSON.parse(readFileSync(outputOne, "utf8")).trials[0].harness.hanoonCommit).toBe(identityOne.commit);
  expect(JSON.parse(readFileSync(outputTwo, "utf8")).trials[0].harness.hanoonCommit).toBe(identityTwo.commit);
});

it("discloses the registered controller tool surface deterministically", async () => {
  const [firstRun, secondRun] = await Promise.all([
    runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 }),
    runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 }),
  ]);
  const firstStatusTrial = firstRun.find((trial) => trial.scenarioId === "current-job-status");
  const firstSurface = firstRun[0]?.harness;

  expect(firstStatusTrial?.harness.advertisedTools).toContain("telegram_agent_job_status");
  expect(firstStatusTrial?.harness.advertisedTools).toEqual([...CONTROLLER_TOOL_NAMES].sort());
  expect(Object.keys(firstStatusTrial?.harness.parameterSchemaSha256 ?? {}).sort())
    .toEqual([...CONTROLLER_TOOL_NAMES].sort());
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
  const trials = await cleanScenarioTrials("kernel");
  const trial = trials.find((candidate) => candidate.scenarioId === "duplicate-mutation-replay");
  if (!trial) throw new Error("duplicate-mutation-replay trial was not produced");
  const output = evaluationOutput();
  const evaluation = await runner.evaluateControllerOutcomes({
    checkpoint: "kernel",
    trials: 1,
    seed: 8122026,
    output,
    replace: false,
  }, {
    readGitIdentity: () => ({ commit: "a".repeat(40), dirty: false }),
    runTrials: async () => trials.map((candidate) => ({
      ...candidate,
      harness: { ...candidate.harness, hanoonCommit: "a".repeat(40) },
      outcome: candidate.scenarioId === trial.scenarioId
        ? { ...candidate.outcome, status: "failed" as const }
        : candidate.outcome,
    })),
  });

  expect(evaluation).toMatchObject({ exitCode: 1, criticalSafetyFailed: true, report: { status: "failed" } });
});

it.each(["outcome", "trace", "answer"] as const)(
  "returns a nonzero evaluation result for an incomplete %s layer",
  async (layer) => {
    const runner = await runnerModule();
    const trials = await cleanScenarioTrials("baseline");
    const sourceTrial = trials[0];
    if (!sourceTrial) throw new Error("baseline trial was not produced");
    const trial = {
      ...sourceTrial,
      harness: { ...sourceTrial.harness, dirty: false },
      [layer]: { ...sourceTrial[layer], status: "incomplete" as const, proofRefs: [] },
    } as typeof sourceTrial;
    if (layer === "answer") {
      trial.evidenceRecords = trial.evidenceRecords?.map((record) => record.layer === "answer"
        ? { ...record, observed: false }
        : record);
    }
    const output = evaluationOutput();

    const evaluation = await runner.evaluateControllerOutcomes({
      checkpoint: "baseline",
      trials: 1,
      seed: 8122026,
      output,
      replace: false,
    }, {
      readGitIdentity: () => ({ commit: trial.harness.hanoonCommit, dirty: false }),
      runTrials: async () => trials.map((candidate, index) => index === 0 ? trial : candidate),
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
      run: { checkpoint: "baseline", trialsPerScenario: 1, seed: 8122026 },
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
    "fact:stale-capability-fence:outcome:stale_approval_denied",
    "fact:stale-capability-fence:outcome:stale_approval_no_effect",
  ]));
  const noEffectRecord = staleTrial.evidenceRecords?.find(
    (record) => record.assertion === "stale_approval_no_effect",
  );
  expect(noEffectRecord?.facts).toMatchObject({
    staleApprovalStateBefore: "confirmed",
    staleApprovalStateAfter: "confirmed",
    staleApprovalExternalCalls: 0,
  });
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

it("writes a comparable cutover report when fake metric availability matches", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "hanoon-eval-comparison-"));
  const baseline = join(directory, "baseline.json");
  const output = join(directory, "after.json");
  try {
    const baselineReport = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      run: { checkpoint: "baseline", trialsPerScenario: 3, seed: 8122026 },
      trials: (await runControllerScenarioTrials({ checkpoint: "baseline", trials: 3, seed: 8122026 })).map((currentTrial) => ({
        ...currentTrial,
        harness: { ...currentTrial.harness, dirty: false },
      })),
    });
    writeFileSync(baseline, `${JSON.stringify(baselineReport, null, 2)}\n`, { mode: 0o600 });

    await execCleanOutcomeEvaluator([
      "scripts/eval-controller-outcomes.mjs",
      "--checkpoint", "cutover",
      "--trials", "3",
      "--seed", "8122026",
      "--baseline", baseline,
      "--output", output,
      "--replace",
    ]);

    const report = JSON.parse(readFileSync(output, "utf8")) as {
      status: string;
      comparison: {
        status: string;
        common: Array<{ scenarioId: string; baseline: { passed: number; denominator: number }; after: { passed: number; denominator: number } }>;
        newScenarios: Array<{ scenarioId: string }>;
      };
    };
    expect(report.status).toBe("passed");
    expect(report.comparison.status).toBe("comparable");
    expect(report.comparison.common).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scenarioId: "plain-conversation",
        baseline: expect.objectContaining({ passed: 3, denominator: 3 }),
        after: expect.objectContaining({ passed: 3, denominator: 3 }),
      }),
      expect.objectContaining({
        scenarioId: "current-job-status",
        baseline: expect.objectContaining({ passed: 3, denominator: 3 }),
        after: expect.objectContaining({ passed: 3, denominator: 3 }),
      }),
    ]));
    expect(report.comparison.newScenarios.map((scenario) => scenario.scenarioId)).toEqual([
      "duplicate-mutation-replay",
      "durable-deferred-monitor",
      "process-only-finalization",
      "restart-after-owner-tap",
      "stale-capability-fence",
      "telegram-allow-once",
      "unsupported-success-claim",
    ]);
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
