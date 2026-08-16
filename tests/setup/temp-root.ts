import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The part of Vitest's global setup context this file uses. Declared here
 * rather than imported from `vitest/node`, whose type entry pulls in
 * dependencies this repository does not carry types for.
 */
type GlobalSetupContext = {
  provide: (key: "pluginTestTempRoot", value: string) => void;
};

/** Prefix of the single temp root this run owns. */
export const RUN_ROOT_PREFIX = "bb-plugin-test-";

/**
 * Temp-directory families this repository's tests created directly in the
 * system temp directory before the run root existed, plus abandoned run roots.
 * A current run creates nothing outside its run root, so these only ever match
 * leftovers from a run that was killed before teardown.
 */
const SWEEPABLE_PREFIXES = [
  RUN_ROOT_PREFIX,
  "bb-fake-plugin-host-",
  "answer-corpus-test-",
  "answer-eval-test-",
  "capability-repository-",
  "controller-interaction-race-",
  "credential-",
  "eval-integrity-",
  "hanoon-",
  "telegram-",
] as const;

/** A directory this old cannot belong to a run that is still going. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/** Bounds how long a sweep may delay the start of a run. */
const SWEEP_BUDGET_MS = 2_000;

export type SweepResult = { removed: number; remaining: number };

/** `mkdtemp` appends exactly six random characters; require that shape so the
 * sweep only claims directories a test run could have created. */
function looksLikeTempFixture(name: string): boolean {
  return (
    SWEEPABLE_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
    /[A-Za-z0-9]{6}$/.test(name)
  );
}

/**
 * Remove temp directories left behind by runs that died before teardown. Only
 * directories older than {@link STALE_AFTER_MS} are touched, so a concurrent
 * run's live directories are never removed, and the sweep stops at its time
 * budget so an accumulated backlog is cleared over several runs instead of
 * stalling one.
 */
export function sweepStaleTempDirectories(options: {
  directory: string;
  now: number;
  budgetMs?: number;
  clock?: () => number;
}): SweepResult {
  const budgetMs = options.budgetMs ?? SWEEP_BUDGET_MS;
  const clock = options.clock ?? Date.now;
  const deadline = clock() + budgetMs;

  let entries: string[];
  try {
    entries = readdirSync(options.directory);
  } catch {
    return { removed: 0, remaining: 0 };
  }

  let removed = 0;
  let remaining = 0;
  for (const entry of entries) {
    if (!looksLikeTempFixture(entry)) continue;
    const path = join(options.directory, entry);
    let modifiedAt: number;
    try {
      modifiedAt = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (options.now - modifiedAt < STALE_AFTER_MS) continue;
    if (clock() >= deadline) {
      remaining += 1;
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      remaining += 1;
    }
  }
  return { removed, remaining };
}

/**
 * Vitest global setup. The run gets one temp root, every fixture that asks for
 * `os.tmpdir()` lands inside it, and that root is removed once when the run
 * ends — after a pass, after a failure, and after an interrupt. A run killed
 * outright leaves the root behind; the next run's sweep collects it.
 */
export default function setup({ provide }: GlobalSetupContext): () => void {
  const systemTemp = tmpdir();
  const sweep = sweepStaleTempDirectories({ directory: systemTemp, now: Date.now() });
  if (sweep.removed > 0 || sweep.remaining > 0) {
    console.log(
      `[temp-root] swept ${sweep.removed} stale temp director${sweep.removed === 1 ? "y" : "ies"}` +
        (sweep.remaining > 0 ? `, ${sweep.remaining} left for the next run` : ""),
    );
  }

  const runRoot = mkdtempSync(join(systemTemp, RUN_ROOT_PREFIX));
  applyTempRoot(runRoot);
  provide("pluginTestTempRoot", runRoot);

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    rmSync(runRoot, { recursive: true, force: true });
  };
  // Teardown covers pass and failure; "exit" covers an interrupt that skips it.
  process.once("exit", cleanup);

  return cleanup;
}

/** Point every temp-directory lookup in this process at `root`. */
export function applyTempRoot(root: string): void {
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
}

declare module "vitest" {
  interface ProvidedContext {
    pluginTestTempRoot: string;
  }
}
