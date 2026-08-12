import { execFile } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

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
