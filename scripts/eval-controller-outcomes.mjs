#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
  const argumentValue = argv[index + 1];
  if (!argumentValue || argumentValue.startsWith("--")) fail(`${flag} requires a value`);
  return argumentValue;
}

function parseArguments(argv) {
  const options = { checkpoint: null, trials: null, seed: 8122026, baseline: null, output: null, replace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--replace") { options.replace = true; continue; }
    if (flag === "--checkpoint") { options.checkpoint = valueAfter(argv, index, flag); index += 1; continue; }
    if (flag === "--trials") { options.trials = Number(valueAfter(argv, index, flag)); index += 1; continue; }
    if (flag === "--seed") { options.seed = Number(valueAfter(argv, index, flag)); index += 1; continue; }
    if (flag === "--baseline") { options.baseline = valueAfter(argv, index, flag); index += 1; continue; }
    if (flag === "--output") { options.output = valueAfter(argv, index, flag); index += 1; continue; }
    fail(`unknown argument ${flag}`);
  }
  if (!options.checkpoint || !["baseline", "kernel", "cutover"].includes(options.checkpoint)) fail("--checkpoint must be baseline, kernel, or cutover");
  if (!Number.isInteger(options.trials) || options.trials < 1 || options.trials > 512) fail("--trials must be an integer between 1 and 512");
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 2147483647) fail("--seed must be a non-negative 32-bit integer");
  if (options.baseline !== null && !isAbsolute(options.baseline)) fail("--baseline must be an absolute path");
  if (!options.output || !isAbsolute(options.output)) fail("--output must be an absolute path");
  const output = resolve(options.output);
  const baseline = options.baseline === null ? null : resolve(options.baseline);
  if (baseline !== null && baseline === output) fail("--baseline and --output must be different paths");
  return { ...options, baseline, output };
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

function readValidatedBaseline(path, scenarioCorpus) {
  if (!isAbsolute(path)) throw new Error("--baseline must be an absolute path");
  let report;
  try {
    if (!statSync(path).isFile()) throw new Error("baseline is not a regular file");
    report = contract.parseControllerEvaluationReport(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`baseline report is not valid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (report.label !== "fixed") throw new Error("baseline report must have fixed label");
  if (!report.run) throw new Error("baseline report lacks checkpoint, trial, and seed identity");
  if (report.trials.some((trial) => trial.harness.dirty)) throw new Error("baseline report contains dirty trials");
  const validation = contract.validateControllerScenarioTrialsAgainstCorpus(report.trials, scenarioCorpus);
  for (const trial of validation.trials) contract.validateControllerScenarioTrialBudget(trial);
  assertExactTrialSet(validation.trials, scenarioCorpus, {
    checkpoint: report.run.checkpoint,
    trials: report.run.trialsPerScenario,
    seed: report.run.seed,
  });
  return report;
}

function fixedScenarioIdentity(trial) {
  return JSON.stringify({
    scenarioDefinitionSha256: trial.scenarioDefinitionSha256,
    outerTaskTools: trial.harness.outerTaskTools,
    answerFixtureSha256: trial.harness.answerFixtureSha256,
    provider: trial.harness.provider,
    model: trial.harness.model,
    reasoningLevel: trial.harness.reasoningLevel,
    serviceTier: trial.harness.serviceTier,
    permissionMode: trial.harness.permissionMode,
    budget: trial.budget,
    graders: {
      outcome: [trial.outcome.graderId, trial.outcome.graderVersion],
      trace: [trial.trace.graderId, trial.trace.graderVersion],
      answer: [trial.answer.graderId, trial.answer.graderVersion],
    },
  });
}

function hasFixedScenarioIdentityVariation(trials) {
  const identitiesByScenario = new Map();
  for (const trial of trials) {
    const key = `${trial.scenarioId}:${trial.scenarioVersion}`;
    const identities = identitiesByScenario.get(key) ?? new Set();
    identities.add(fixedScenarioIdentity(trial));
    identitiesByScenario.set(key, identities);
  }
  return [...identitiesByScenario.values()].some((identities) => identities.size > 1);
}

export function classifyControllerEvidence(trials) {
  const identityIncomplete = trials.some((trial) => (
    trial.scenarioDefinitionSha256 === undefined || trial.harness.outerTaskTools === undefined ||
    trial.harness.answerFixtureSha256 === undefined
  ));
  if (identityIncomplete) throw new Error("current evaluation identity is incomplete; refusing to label it strong");
  const nonFixedTrials = trials.filter((trial) => (
    trial.harness.provider !== "fake-bb" || trial.harness.model !== "scripted-controller"
  )).length;
  if (nonFixedTrials > 0) return nonFixedTrials === 1 ? "smoke" : "strong";
  return hasFixedScenarioIdentityVariation(trials) ? "strong" : "fixed";
}

function assertCurrentEvaluationIdentity(trials, identity) {
  if (identity.dirty) throw new Error("current evaluator identity is dirty; refusing to write a passed artifact");
  for (const trial of trials) {
    if (trial.harness.dirty) throw new Error(`current trial ${trial.scenarioId}:${trial.trial} is dirty`);
    if (trial.harness.hanoonCommit !== identity.commit) {
      throw new Error(`current trial ${trial.scenarioId}:${trial.trial} has an unproven Hanoon commit`);
    }
  }
}

function assertExactTrialSet(trials, scenarioCorpus, options) {
  const checkpointRank = { baseline: 0, kernel: 1, cutover: 2 };
  const expectedCases = scenarioCorpus.cases.filter((scenarioCase) =>
    checkpointRank[scenarioCase.checkpoint] <= checkpointRank[options.checkpoint]);
  const expected = new Set();
  for (const scenarioCase of expectedCases) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      expected.add(`${scenarioCase.id}:${scenarioCase.scenarioVersion}:${trial}`);
    }
  }
  const actual = new Set();
  for (const trial of trials) {
    if (trial.seed !== options.seed) {
      throw new Error(`trial ${trial.scenarioId}:${trial.trial} has an unexpected seed`);
    }
    const key = `${trial.scenarioId}:${trial.scenarioVersion}:${trial.trial}`;
    if (actual.has(key)) throw new Error(`duplicate trial ${key}`);
    actual.add(key);
  }
  const missing = [...expected].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`evaluation trial set is incomplete or unexpected (missing=${missing.length}, extra=${extra.length})`);
  }
}

export async function evaluateControllerOutcomes(options, dependencies = {}) {
  if (!allowedOutput(options.output)) {
    throw new Error("--output must be outside the repository or under .superpowers/");
  }
  if (options.checkpoint === "cutover" && options.baseline === null) {
    throw new Error("cutover evaluation requires a fixed baseline comparison");
  }
  const scenarioCorpus = harness.loadControllerScenarioCorpus();
  const baseline = options.baseline ? readValidatedBaseline(options.baseline, scenarioCorpus) : null;
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
  const currentValidation = contract.validateControllerScenarioTrialsAgainstCorpus(trials, scenarioCorpus);
  const validatedTrials = currentValidation.trials.map(contract.validateControllerScenarioTrialBudget);
  assertCurrentEvaluationIdentity(validatedTrials, identity);
  assertExactTrialSet(validatedTrials, scenarioCorpus, options);
  const baseReport = contract.aggregateControllerEvaluation({
    label: classifyControllerEvidence(validatedTrials),
    run: {
      checkpoint: options.checkpoint,
      trialsPerScenario: options.trials,
      seed: options.seed,
    },
    trials: validatedTrials,
  });
  const comparison = baseline
    ? contract.compareControllerEvaluations({
        baseline,
        after: baseReport,
        scenarioCorpus,
        scenarioDefinitions: scenarioCorpus.cases.map((scenarioCase) => ({
          id: scenarioCase.id,
          scenarioVersion: scenarioCase.scenarioVersion,
          criticalSafety: scenarioCase.criticalSafety,
        })),
      })
    : null;
  const report = comparison
    ? contract.attachControllerComparison(baseReport, comparison)
    : baseReport;
  contract.controllerEvaluationReportSchema.parse(report);
  const finalIdentity = (dependencies.readGitIdentity ?? readGitIdentity)();
  if (finalIdentity.commit !== identity.commit || finalIdentity.dirty || identity.dirty) {
    throw new Error("current evaluator identity changed before report write");
  }
  assertCurrentEvaluationIdentity(validatedTrials, finalIdentity);
  writeReport(options.output, `${JSON.stringify(report, null, 2)}\n`, options.replace);
  const criticalSafetyFailed = currentValidation.criticalSafetyFailed;
  return {
    report,
    criticalSafetyFailed,
    exitCode: criticalSafetyFailed || report.status !== "passed" ? 1 : 0,
  };
}

async function main() {
  const evaluation = await evaluateControllerOutcomes(parseArguments(process.argv.slice(2)));
  process.exitCode = evaluation.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
