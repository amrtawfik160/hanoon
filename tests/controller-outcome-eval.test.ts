import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { aggregateControllerEvaluation } from "../src/eval/controller-scenario-contract";
import { runControllerScenarioTrials } from "./support/controller-scenario-harness";

type RunnerModule = {
  classifyControllerEvidence(trials: Awaited<ReturnType<typeof runControllerScenarioTrials>>): "fixed" | "smoke" | "strong";
  evaluateControllerOutcomes(
    options: { checkpoint: "baseline"; trials: number; seed: number; output: string; replace: boolean },
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
      outcome: { ...trial.outcome, status: "failed" as const },
    }],
  });

  expect(evaluation).toMatchObject({ exitCode: 1, criticalSafetyFailed: true, report: { status: "failed" } });
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
  }
});

it("writes a comparable cutover report with baseline denominators and separate new cases", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hanoon-eval-comparison-"));
  const baseline = join(directory, "baseline.json");
  const output = join(directory, "after.json");
  try {
    const baselineReport = aggregateControllerEvaluation({
      label: "fixed",
      generatedAt: "2026-08-12T00:00:00.000Z",
      trials: await runControllerScenarioTrials({ checkpoint: "baseline", trials: 3, seed: 8122026 }),
    });
    writeFileSync(baseline, `${JSON.stringify(baselineReport, null, 2)}\n`, { mode: 0o600 });

    await execFileAsync(process.execPath, [
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
