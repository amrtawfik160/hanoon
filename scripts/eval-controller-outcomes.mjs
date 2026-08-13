#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const contract = await jiti.import("../src/eval/controller-scenario-contract.ts");
const harness = await jiti.import("../tests/support/controller-scenario-harness.ts");

function fail(message) {
  process.stderr.write(`controller outcome eval: ${message}\n`);
  process.exit(1);
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
  return value;
}

function parseArguments(argv) {
  const options = { checkpoint: null, trials: null, seed: 8122026, output: null, replace: false, baseline: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--replace") { options.replace = true; continue; }
    if (flag === "--checkpoint") { options.checkpoint = valueAfter(argv, index, flag); index += 1; continue; }
    if (flag === "--trials") { options.trials = Number(valueAfter(argv, index, flag)); index += 1; continue; }
    if (flag === "--seed") { options.seed = Number(valueAfter(argv, index, flag)); index += 1; continue; }
    if (flag === "--output") { options.output = valueAfter(argv, index, flag); index += 1; continue; }
    if (flag === "--baseline") { options.baseline = valueAfter(argv, index, flag); index += 1; continue; }
    fail(`unknown argument ${flag}`);
  }
  if (!options.checkpoint || !["baseline", "kernel", "cutover"].includes(options.checkpoint)) fail("--checkpoint must be baseline, kernel, or cutover");
  if (!Number.isInteger(options.trials) || options.trials < 1 || options.trials > 512) fail("--trials must be an integer between 1 and 512");
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 2147483647) fail("--seed must be a non-negative 32-bit integer");
  if (!options.output || !isAbsolute(options.output)) fail("--output must be an absolute path");
  if (options.baseline !== null && !isAbsolute(options.baseline)) fail("--baseline must be an absolute path");
  return {
    ...options,
    output: resolve(options.output),
    baseline: options.baseline === null ? null : resolve(options.baseline),
  };
}

function isInsideRoot(path) {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function allowedOutput(path) {
  if (!isInsideRoot(path)) return true;
  const relation = relative(root, path);
  return relation === ".superpowers" || relation.startsWith(`.superpowers${sep}`);
}

function readBaselineReport(path) {
  return readFileSync(path, "utf8");
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function readGitIdentity() {
  return {
    commit: git(["rev-parse", "HEAD"]),
    dirty: git(["status", "--porcelain"]) !== "",
  };
}

function writeReport(path, content, replace) {
  const mode = 0o600;
  if (!replace) {
    let descriptor;
    try {
      descriptor = openSync(path, "wx", mode);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") {
        throw new Error(`refusing to overwrite existing report ${path}; pass --replace`);
      }
      throw error;
    }
    try {
      writeFileSync(descriptor, content, { encoding: "utf8" });
    } finally {
      closeSync(descriptor);
    }
    chmodSync(path, mode);
    return;
  }
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { encoding: "utf8", mode, flag: "w" });
  renameSync(temporary, path);
  chmodSync(path, mode);
}

export function classifyControllerEvidence(trials) {
  const nonFixedTrials = trials.filter((trial) => (
    trial.harness.provider !== "fake-bb" || trial.harness.model !== "scripted-controller"
  )).length;
  if (nonFixedTrials === 0) return "fixed";
  return nonFixedTrials === 1 ? "smoke" : "strong";
}

export async function evaluateControllerOutcomes(options, dependencies = {}) {
  if (!allowedOutput(options.output)) {
    throw new Error("--output must be outside the repository or under .superpowers/");
  }
  const identity = (dependencies.readGitIdentity ?? readGitIdentity)();
  const priorCommit = process.env.HANOON_EVAL_COMMIT;
  const priorDirty = process.env.HANOON_EVAL_DIRTY;
  process.env.HANOON_EVAL_COMMIT = identity.commit;
  process.env.HANOON_EVAL_DIRTY = String(identity.dirty);
  let trials;
  try {
    trials = await (dependencies.runTrials ?? harness.runControllerScenarioTrials)({
      checkpoint: options.checkpoint,
      trials: options.trials,
      seed: options.seed,
    });
  } finally {
    if (priorCommit === undefined) delete process.env.HANOON_EVAL_COMMIT;
    else process.env.HANOON_EVAL_COMMIT = priorCommit;
    if (priorDirty === undefined) delete process.env.HANOON_EVAL_DIRTY;
    else process.env.HANOON_EVAL_DIRTY = priorDirty;
  }
  const validatedTrials = trials.map(contract.parseControllerScenarioTrial);
  const report = contract.aggregateControllerEvaluation({
    label: classifyControllerEvidence(validatedTrials),
    trials: validatedTrials,
  });
  contract.controllerEvaluationReportSchema.parse(report);
  // Both reports are validated before anything is compared: an unvalidated
  // baseline could otherwise make a regression look like a schema difference.
  const comparison = options.baseline === null || options.baseline === undefined
    ? null
    : contract.compareControllerEvaluations({
      current: report,
      baseline: contract.controllerEvaluationReportSchema.parse(
        JSON.parse((dependencies.readBaseline ?? readBaselineReport)(options.baseline)),
      ),
    });
  writeReport(options.output, `${JSON.stringify({ ...report, comparison }, null, 2)}\n`, options.replace);
  if (comparison !== null) {
    process.stdout.write(`comparison ${comparison.status}\n`);
    for (const scenario of comparison.scenarios) {
      process.stdout.write(
        `${scenario.scenarioId} baseline ${contract.formatControllerRate(scenario.baseline)}` +
        ` current ${contract.formatControllerRate(scenario.current)}` +
        `${scenario.regressed ? " REGRESSED" : ""}\n`,
      );
    }
    if (comparison.currentOnly.length > 0) {
      process.stdout.write(`current-only ${comparison.currentOnly.join(",")}\n`);
    }
  }
  const scenarios = new Map(harness.loadControllerScenarioCorpus().cases.map((scenarioCase) => [
    scenarioCase.id,
    scenarioCase,
  ]));
  const criticalSafetyFailed = validatedTrials.some((trial) => {
    const scenarioCase = scenarios.get(trial.scenarioId);
    if (!scenarioCase) throw new Error(`trial references an unknown scenario ${trial.scenarioId}`);
    return scenarioCase.criticalSafety && trial.outcome.status === "failed";
  });
  const regressed = comparison !== null && comparison.regressions.length > 0;
  // Every gate the brief names is machine-enforced for a release report, which
  // is the run that supplies a --baseline: it must be passed, comparable, and
  // generated from a clean tree. A plain generation run stays usable while the
  // tree is dirty, and discloses `dirty` in the report either way.
  const dirtyHarness = validatedTrials.some((trial) => trial.harness.dirty);
  const notComparable = comparison !== null && comparison.status !== "comparable";
  const releaseGateFailed = comparison !== null && (dirtyHarness || notComparable);
  const failed = criticalSafetyFailed || regressed || releaseGateFailed ||
    report.status === "failed";
  return {
    report,
    comparison,
    criticalSafetyFailed,
    regressed,
    dirtyHarness,
    exitCode: failed ? 1 : 0,
  };
}

async function main() {
  const evaluation = await evaluateControllerOutcomes(parseArguments(process.argv.slice(2)));
  process.exitCode = evaluation.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
