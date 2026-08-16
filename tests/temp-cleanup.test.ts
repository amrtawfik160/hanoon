import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { STALE_AFTER_MS, sweepStaleTempDirectories } from "./setup/temp-root";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VITEST_BIN = join(REPOSITORY_ROOT, "node_modules", "vitest", "vitest.mjs");
const PROBE_CONFIG = join(
  REPOSITORY_ROOT,
  "tests",
  "fixtures",
  "temp-leak-probe",
  "vitest.config.ts",
);

function makeDirectory(root: string, name: string, ageMs: number): string {
  const path = join(root, name);
  mkdirSync(path);
  const seconds = (Date.now() - ageMs) / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

/** Vitest's own variables would leak into the probe run's environment. */
function environmentWithoutVitest(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("VITEST")) delete environment[key];
  }
  return environment;
}

it("leaves no temp directory behind when a run passes, throws and times out", () => {
  const runTemp = mkdtempSync(join(tmpdir(), "temp-leak-probe-run-"));
  try {
    const probe = spawnSync(
      process.execPath,
      [VITEST_BIN, "run", "--config", PROBE_CONFIG],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        env: environmentWithoutVitest({ TMPDIR: runTemp, TMP: runTemp, TEMP: runTemp }),
      },
    );

    // The reporter colours its summary, so drop the escape sequences first.
    const output = `${probe.stdout}${probe.stderr}`.replace(/\[[0-9;]*m/g, "");
    // Proves the probe suite really ran, so an empty directory below cannot be
    // a config error that ran nothing.
    expect(output).toMatch(/Tests\s+2 failed \| 1 passed/);
    expect(probe.status).toBe(1);
    expect(readdirSync(runTemp)).toEqual([]);
  } finally {
    rmSync(runTemp, { recursive: true, force: true });
  }
}, 120_000);

it("sweeps stale harness directories and leaves everything else alone", () => {
  const root = mkdtempSync(join(tmpdir(), "temp-sweep-fixture-"));
  try {
    makeDirectory(root, "bb-fake-plugin-host-AAAAAA", STALE_AFTER_MS * 2);
    makeDirectory(root, "bb-plugin-test-BBBBBB", STALE_AFTER_MS * 2);
    makeDirectory(root, "bb-fake-plugin-host-CCCCCC", 0);
    makeDirectory(root, "someone-elses-data", STALE_AFTER_MS * 2);

    const result = sweepStaleTempDirectories({ directory: root, now: Date.now() });

    expect(result).toEqual({ removed: 2, remaining: 0 });
    expect(readdirSync(root).sort()).toEqual([
      "bb-fake-plugin-host-CCCCCC",
      "someone-elses-data",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("stops sweeping at its time budget and reports what is left", () => {
  const root = mkdtempSync(join(tmpdir(), "temp-sweep-budget-"));
  try {
    for (const name of ["bb-fake-plugin-host-DDDDDD", "bb-fake-plugin-host-EEEEEE", "bb-fake-plugin-host-FFFFFF"]) {
      makeDirectory(root, name, STALE_AFTER_MS * 2);
    }
    // Budget starts at 0 and the first removal is still inside it; every later
    // check sees a clock past the deadline.
    const readings = [0, 0, 10_000, 10_000, 10_000];
    const clock = (): number => readings.shift() ?? 10_000;

    const result = sweepStaleTempDirectories({
      directory: root,
      now: Date.now(),
      budgetMs: 2_000,
      clock,
    });

    expect(result).toEqual({ removed: 1, remaining: 2 });
    expect(readdirSync(root)).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
