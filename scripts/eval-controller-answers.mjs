#!/usr/bin/env node
/**
 * Opt-in hybrid answer-quality evaluation.
 *
 * Deterministic checks can reject only explicit high-confidence violations.
 * Every clause without such a violation is graded in its own hidden BB thread,
 * so a model's opinion about one rule cannot contaminate another rule.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ANSWER_CLAUSES,
  ANSWER_JUDGE_PROFILE,
  ANSWER_RUBRIC_VERSION,
  buildAnswerJudgeSpawnArgs,
  buildClauseAssessment,
  buildClauseJudgePrompt,
  detectExplicitClauseViolation,
  parseClauseVerdict,
  sanitizeInfrastructureDetail,
} from "../src/eval/answer-contract.ts";

const run = promisify(execFile);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASES_PATH = join(pluginRoot, "evals/answers.json");
const WAIT_SECONDS = 180;
const CLAUSE_CONCURRENCY = 1;

function fail(message) {
  process.stderr.write(`answer eval: ${message}\n`);
  process.exit(1);
}

function readArguments(argv) {
  const options = { project: null, only: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--project" && value) { options.project = value; index += 1; continue; }
    if (flag === "--case" && value) { options.only = value; index += 1; continue; }
    fail(`unknown argument ${flag}`);
  }
  if (!options.project) fail("--project <project-id> is required");
  return options;
}

async function bb(args) {
  const { stdout } = await run("bb", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

function capturedDetail(error, sensitiveValues) {
  const errorRecord = error && typeof error === "object" ? error : {};
  const capturedStderr = typeof errorRecord.stderr === "string" ? errorRecord.stderr.trim() : "";
  const capturedStdout = typeof errorRecord.stdout === "string" ? errorRecord.stdout.trim() : "";
  const exitCode = errorRecord.code === undefined ? "unknown exit" : `exit ${String(errorRecord.code)}`;
  return sanitizeInfrastructureDetail(
    capturedStderr || capturedStdout || `bb command failed (${exitCode})`,
    sensitiveValues,
  );
}

async function judgeClause(options, testCase, clause) {
  const deterministicReason = detectExplicitClauseViolation(clause.id, testCase.answer);
  if (deterministicReason) {
    return buildClauseAssessment({
      clauseId: clause.id,
      holds: false,
      source: "deterministic",
      reason: deterministicReason,
      judgeThreadId: null,
    });
  }

  const prompt = buildClauseJudgePrompt({
    clauseId: clause.id,
    ownerMessage: testCase.ownerMessage,
    answer: testCase.answer,
  });
  const spawnArgs = buildAnswerJudgeSpawnArgs({
    project: options.project,
    title: `answer-eval ${testCase.id} ${clause.id}`,
    prompt,
  });
  const sensitiveValues = [prompt, testCase.ownerMessage, testCase.answer];

  let spawnOutput;
  try {
    spawnOutput = await bb(spawnArgs);
  } catch (error) {
    throw new Error(`bb thread spawn failed: ${capturedDetail(error, sensitiveValues)}`);
  }

  let spawned;
  try {
    spawned = JSON.parse(spawnOutput);
  } catch {
    throw new Error(`bb thread spawn returned invalid JSON: ${capturedDetail({ stdout: spawnOutput }, sensitiveValues)}`);
  }
  const threadId = spawned?.id ?? spawned?.thread?.id;
  if (!threadId) throw new Error("bb thread spawn returned no thread id");

  try {
    await bb(["thread", "wait", threadId, "--status", "idle", "--timeout", String(WAIT_SECONDS), "--json"]);
  } catch (error) {
    throw new Error(`judge thread ${threadId} did not finish within ${WAIT_SECONDS}s: ${capturedDetail(error, sensitiveValues)}`);
  }

  let output;
  try {
    output = await bb(["thread", "output", threadId]);
  } catch (error) {
    throw new Error(`judge thread ${threadId} output failed: ${capturedDetail(error, sensitiveValues)}`);
  }
  const verdict = parseClauseVerdict(output, clause.id);
  if (!verdict) {
    throw new Error(`judge thread ${threadId} returned a malformed single-clause verdict (captured output length ${output.length})`);
  }
  return buildClauseAssessment({
    clauseId: verdict.id,
    holds: verdict.holds,
    source: "model",
    reason: sanitizeInfrastructureDetail(verdict.why, sensitiveValues),
    judgeThreadId: threadId,
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function consume() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => consume()),
  );
  return results;
}

async function gradeCase(options, testCase) {
  const outcomes = await mapWithConcurrency(ANSWER_CLAUSES, CLAUSE_CONCURRENCY, async (clause) => {
    try {
      return { assessment: await judgeClause(options, testCase, clause) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "judge failed";
      return {
        error: {
          clauseId: clause.id,
          detail: sanitizeInfrastructureDetail(detail, [testCase.ownerMessage, testCase.answer]),
        },
      };
    }
  });
  const errors = outcomes.filter((outcome) => outcome.error).map((outcome) => outcome.error);
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `clause ${error.clauseId}: ${error.detail}`).join("; "));
  }
  const assessments = outcomes.map((outcome) => outcome.assessment);
  return { assessments, passed: assessments.every((assessment) => assessment.holds) };
}

function printAssessments(assessments) {
  process.stdout.write(`    ${JSON.stringify({
    rubricVersion: ANSWER_RUBRIC_VERSION,
    judgeProfile: ANSWER_JUDGE_PROFILE,
    clauses: assessments,
  })}\n`);
}

async function main() {
  const options = readArguments(process.argv.slice(2));
  const { cases } = JSON.parse(readFileSync(CASES_PATH, "utf8"));
  const selected = options.only ? cases.filter((each) => each.id === options.only) : cases;
  if (selected.length === 0) fail(`no case matched ${options.only}`);

  process.stdout.write(`answer judge rubric ${ANSWER_RUBRIC_VERSION}; profile ${JSON.stringify(ANSWER_JUDGE_PROFILE)}; clause concurrency ${CLAUSE_CONCURRENCY}\n`);
  let agreed = 0;
  const misses = [];
  const infrastructureErrors = [];
  for (const testCase of selected) {
    let result;
    try {
      result = await gradeCase(options, testCase);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "judge failed";
      infrastructureErrors.push({ id: testCase.id, detail });
      process.stdout.write(`  ERROR  ${testCase.id}: ${detail}\n`);
      continue;
    }
    const actual = result.passed ? "pass" : "fail";
    const broken = result.assessments.filter((clause) => !clause.holds).map((clause) => clause.id);
    if (actual === testCase.expect) {
      agreed += 1;
      process.stdout.write(`  ok     ${testCase.id} (${actual})${broken.length ? ` [${broken.join(", ")}]` : ""}\n`);
    } else {
      misses.push({ id: testCase.id, detail: `expected ${testCase.expect}, judged ${actual}` });
      process.stdout.write(`  MISS   ${testCase.id}: expected ${testCase.expect}, judged ${actual}\n`);
    }
    printAssessments(result.assessments);
  }

  process.stdout.write(`\nrubric agreement ${agreed}/${selected.length - infrastructureErrors.length}\n`);
  if (infrastructureErrors.length > 0) {
    process.stdout.write(`infrastructure errors ${infrastructureErrors.length}/${selected.length}; rubric was not invoked for those cases\n`);
    process.stdout.write("answer evaluation could not judge every selected case; fix infrastructure before trusting the rubric\n");
  }
  if (misses.length > 0) {
    process.stdout.write("the rubric disagreed with its golden cases; recalibrate before trusting it\n");
  }
  if (infrastructureErrors.length > 0 || misses.length > 0) process.exit(1);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
