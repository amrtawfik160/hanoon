#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";
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
  const options = { checkpoint: null, trials: null, seed: 8122026, output: null, replace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--replace") { options.replace = true; continue; }
    if (flag === "--checkpoint") { options.checkpoint = valueAfter(argv, index, flag); index += 1; continue; }
    if (flag === "--trials") { options.trials = Number(valueAfter(argv, index, flag)); index += 1; continue; }
    if (flag === "--seed") { options.seed = Number(valueAfter(argv, index, flag)); index += 1; continue; }
    if (flag === "--output") { options.output = valueAfter(argv, index, flag); index += 1; continue; }
    fail(`unknown argument ${flag}`);
  }
  if (!options.checkpoint || !["baseline", "kernel", "cutover"].includes(options.checkpoint)) fail("--checkpoint must be baseline, kernel, or cutover");
  if (!Number.isInteger(options.trials) || options.trials < 1 || options.trials > 512) fail("--trials must be an integer between 1 and 512");
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 2147483647) fail("--seed must be a non-negative 32-bit integer");
  if (!options.output || !isAbsolute(options.output)) fail("--output must be an absolute path");
  return { ...options, output: resolve(options.output) };
}

function isInsideRoot(path) {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !relation.startsWith(".."));
}

function allowedOutput(path) {
  if (!isInsideRoot(path)) return true;
  const relation = relative(root, path);
  return relation === ".superpowers" || relation.startsWith(`.superpowers${sep}`);
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function writeReport(path, content, replace) {
  const mode = 0o600;
  if (!replace) {
    let descriptor;
    try {
      descriptor = openSync(path, "wx", mode);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") fail(`refusing to overwrite existing report ${path}; pass --replace`);
      throw error;
    }
    try {
      writeFileSync(descriptor, content, { encoding: "utf8" });
    } finally {
      closeSync(descriptor);
    }
    return;
  }
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { encoding: "utf8", mode, flag: "w" });
  renameSync(temporary, path);
}

function containsCriticalSafetyFailure(trials, checkpoint) {
  if (checkpoint !== "baseline") return trials.some((trial) => trial.outcome.status === "failed");
  return false;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!allowedOutput(options.output)) fail("--output must be outside the repository or under .superpowers/");
  const commit = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]) !== "";
  process.env.HANOON_EVAL_COMMIT = commit;
  process.env.HANOON_EVAL_DIRTY = String(dirty);
  const trials = await harness.runControllerScenarioTrials(options);
  const validatedTrials = trials.map(contract.parseControllerScenarioTrial);
  const report = contract.aggregateControllerEvaluation({ label: "fixed", trials: validatedTrials });
  contract.controllerEvaluationReportSchema.parse(report);
  writeReport(options.output, `${JSON.stringify(report, null, 2)}\n`, options.replace);
  if (containsCriticalSafetyFailure(validatedTrials, options.checkpoint) || report.status === "failed") {
    process.exitCode = 1;
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
