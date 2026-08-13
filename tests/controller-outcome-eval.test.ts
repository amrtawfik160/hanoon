import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  loadControllerScenarioCorpus,
  runControllerScenarioTrials,
} from "./support/controller-scenario-harness";
import {
  aggregateControllerEvaluation,
  compareControllerEvaluations,
} from "../src/eval/controller-scenario-contract";

type RunnerModule = {
  classifyControllerEvidence(trials: Awaited<ReturnType<typeof runControllerScenarioTrials>>): "fixed" | "smoke" | "strong";
  evaluateControllerOutcomes(
    options: {
      checkpoint: "baseline";
      trials: number;
      seed: number;
      output: string;
      replace: boolean;
      baseline?: string;
    },
    dependencies: {
      readGitIdentity(): { commit: string; dirty: boolean };
      runTrials(): Promise<Awaited<ReturnType<typeof runControllerScenarioTrials>>>;
      readBaseline?(path: string): string;
    },
  ): Promise<{
    exitCode: number;
    criticalSafetyFailed: boolean;
    regressed: boolean;
    report: { status: string };
    comparison: { regressions: string[] } | null;
  }>;
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

it("runs every earlier checkpoint's cases at a later checkpoint", async () => {
  const output = evaluationOutput();

  await execFileAsync(process.execPath, [
    "scripts/eval-controller-outcomes.mjs",
    "--checkpoint", "kernel",
    "--trials", "1",
    "--output", output,
  ]);

  const report = JSON.parse(readFileSync(output, "utf8"));
  expect(report.scenarios.map((scenario: { scenarioId: string }) => scenario.scenarioId).sort()).toEqual([
    "current-job-status",
    "duplicate-mutation-replay",
    "plain-conversation",
    "stale-capability-fence",
  ]);
});

it("keeps the baseline subset identical inside the cutover report", async () => {
  const baseline = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const cutover = await runControllerScenarioTrials({ checkpoint: "cutover", trials: 1, seed: 8122026 });
  const baselineSubset = cutover.filter((trial) => baseline.some((entry) => entry.scenarioId === trial.scenarioId));

  expect(baselineSubset.map((trial) => trial.scenarioId).sort())
    .toEqual(baseline.map((trial) => trial.scenarioId).sort());
  for (const trial of baselineSubset) {
    const original = baseline.find((entry) => entry.scenarioId === trial.scenarioId)!;
    // Same scenario version, budget, outer tool surface, and graders: the only
    // difference a report may show is the intervention itself.
    expect(trial.scenarioVersion).toBe(original.scenarioVersion);
    expect(trial.budget).toEqual(original.budget);
    expect(trial.harness.advertisedTools).toEqual(original.harness.advertisedTools);
    expect(trial.harness.parameterSchemaSha256).toEqual(original.harness.parameterSchemaSha256);
    expect([trial.outcome.graderId, trial.outcome.graderVersion])
      .toEqual([original.outcome.graderId, original.outcome.graderVersion]);
  }
});

it("proves every deterministic trust scenario passes on the fixed harness", async () => {
  const cutover = await runControllerScenarioTrials({ checkpoint: "cutover", trials: 1, seed: 8122026 });
  const criticalIds = loadControllerScenarioCorpus().cases
    .filter((scenarioCase) => scenarioCase.criticalSafety)
    .map((scenarioCase) => scenarioCase.id);

  expect(criticalIds.length).toBeGreaterThanOrEqual(5);
  for (const trial of cutover) {
    expect([trial.scenarioId, trial.outcome.status]).toEqual([trial.scenarioId, "passed"]);
  }
  expect(cutover.map((trial) => trial.scenarioId)).toEqual(expect.arrayContaining(criticalIds));
});

it("loses its like-for-like intersection if checkpoint selection stops being cumulative", async () => {
  const baselineTrials = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const cutoverTrials = await runControllerScenarioTrials({ checkpoint: "cutover", trials: 1, seed: 8122026 });
  const baseline = aggregateControllerEvaluation({ label: "fixed", trials: baselineTrials });
  const cumulative = aggregateControllerEvaluation({ label: "fixed", trials: cutoverTrials });
  // The mutation: selecting the checkpoint exactly instead of cumulatively.
  const exactOnly = aggregateControllerEvaluation({
    label: "fixed",
    trials: cutoverTrials.filter((trial) => !baselineTrials.some((entry) => entry.scenarioId === trial.scenarioId)),
  });

  expect(compareControllerEvaluations({ current: cumulative, baseline }).status).toBe("comparable");
  expect(compareControllerEvaluations({ current: exactOnly, baseline }).status).toBe("incomparable");
});

it("keeps an outcome failure failing however well trace and answer scored", async () => {
  const runner = await runnerModule();
  const [trial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const evaluation = await runner.evaluateControllerOutcomes({
    checkpoint: "baseline",
    trials: 1,
    seed: 8122026,
    output: evaluationOutput(),
    replace: false,
  }, {
    readGitIdentity: () => ({ commit: "a".repeat(40), dirty: false }),
    runTrials: async () => [{
      ...trial,
      outcome: { ...trial.outcome, status: "failed" as const },
      trace: { ...trial.trace, status: "passed" as const },
      answer: { ...trial.answer, status: "passed" as const },
    }],
  });

  expect(evaluation.report.status).toBe("failed");
  expect(evaluation.exitCode).toBe(1);
});

it("compares a cutover report against its baseline and lists the new cases apart", async () => {
  const baselineOutput = evaluationOutput();
  const cutoverOutput = evaluationOutput();
  await execFileAsync(process.execPath, [
    "scripts/eval-controller-outcomes.mjs",
    "--checkpoint", "baseline", "--trials", "1", "--output", baselineOutput,
  ]);

  const run = await execFileAsync(process.execPath, [
    "scripts/eval-controller-outcomes.mjs",
    "--checkpoint", "cutover", "--trials", "1",
    "--output", cutoverOutput, "--baseline", baselineOutput,
  ]);

  const report = JSON.parse(readFileSync(cutoverOutput, "utf8"));
  expect(report.comparison.status).toBe("comparable");
  expect(report.comparison.scenarios.map((scenario: { scenarioId: string }) => scenario.scenarioId).sort())
    .toEqual(["current-job-status", "plain-conversation"]);
  expect(report.comparison.regressions).toEqual([]);
  expect(report.comparison.currentOnly).toContain("telegram-allow-once");
  // Rates are displayed as passed/denominator, never as a bare percentage.
  expect(run.stdout).toContain("plain-conversation baseline 1/1 current 1/1");
  expect(run.stdout).not.toMatch(/\d+(?:\.\d+)?%/);
  // The intervention is disclosed side by side rather than treated as drift.
  expect(report.comparison.intervention.current.capabilityManifestSha256).toHaveLength(1);
});

it("exits nonzero when a matched scenario regresses against its baseline", async () => {
  const runner = await runnerModule();
  const [trial] = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const baseline = aggregateControllerEvaluation({ label: "fixed", trials: [trial] });
  const evaluation = await runner.evaluateControllerOutcomes({
    checkpoint: "baseline",
    trials: 1,
    seed: 8122026,
    output: evaluationOutput(),
    replace: false,
    baseline: "/tmp/does-not-matter.json",
  }, {
    readGitIdentity: () => ({ commit: "a".repeat(40), dirty: false }),
    runTrials: async () => [{ ...trial, outcome: { ...trial.outcome, status: "failed" as const } }],
    readBaseline: () => JSON.stringify(baseline),
  });

  expect(evaluation.comparison?.regressions).toEqual([trial.scenarioId]);
  expect(evaluation.regressed).toBe(true);
  expect(evaluation.exitCode).toBe(1);
});

it("records the current job status through the registered controller tool", async () => {
  const trials = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const statusTrial = trials.find((trial) => trial.scenarioId === "current-job-status");

  expect(statusTrial?.trace).toMatchObject({
    status: "passed",
    proofRefs: [expect.stringMatching(/^tool-call:telegram_agent_job_status:1:sha256:[0-9a-f]{64}$/)],
  });
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
      outcome: { ...trial.outcome, status: "failed" as const },
    }],
  });

  expect(evaluation).toMatchObject({ exitCode: 1, criticalSafetyFailed: true, report: { status: "failed" } });
});
