import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
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

it("fails closed for checkpoints without a Task 2 scenario harness", async () => {
  const output = evaluationOutput();
  await expect(execFileAsync(process.execPath, [
    "scripts/eval-controller-outcomes.mjs",
    "--checkpoint", "kernel",
    "--trials", "1",
    "--output", output,
  ])).rejects.toMatchObject({ code: 1 });
});

it("records the current job status through the registered controller tool", async () => {
  const trials = await runControllerScenarioTrials({ checkpoint: "baseline", trials: 1, seed: 8122026 });
  const statusTrial = trials.find((trial) => trial.scenarioId === "current-job-status");

  expect(statusTrial?.trace).toMatchObject({
    status: "passed",
    proofRefs: [expect.stringMatching(/^tool-call:telegram_agent_job_status:1:sha256:[0-9a-f]{64}$/)],
  });
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
