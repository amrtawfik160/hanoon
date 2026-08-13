#!/usr/bin/env node
/**
 * Opt-in hybrid answer-quality evaluation.
 *
 * Deterministic checks can reject only explicit high-confidence violations.
 * Every clause without such a violation is graded in its own hidden BB thread,
 * so a model's opinion about one rule cannot contaminate another rule.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ANSWER_CLAUSES,
  ANSWER_JUDGE_PROFILE,
  ANSWER_RUBRIC_VERSION,
  auditJudgeEventLog,
  buildAnswerJudgeSpawnArgs,
  buildClauseAssessment,
  buildClauseJudgePrompt,
  detectExplicitClauseViolation,
  parseAnswerExpectations,
  parseClauseVerdict,
  sanitizeInfrastructureDetail,
} from "../src/eval/answer-contract.ts";

const run = promisify(execFile);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASES_PATH = join(pluginRoot, "evals/answers.json");
const EXPECTATIONS_PATH = join(pluginRoot, "evals/answer-expectations.json");
const WAIT_SECONDS = 180;
const CLAUSE_CONCURRENCY = 1;
const BB_COMMAND_TIMEOUT_MS = 30_000;
const BB_WAIT_TIMEOUT_MS = (WAIT_SECONDS + 30) * 1_000;
const BB_EVENT_LOG_LIMIT = 1_024;

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

async function bb(args, timeoutMs = BB_COMMAND_TIMEOUT_MS) {
  const { stdout } = await run("bb", args, {
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  return stdout;
}

function capturedDetail(error) {
  const errorRecord = error && typeof error === "object" ? error : {};
  const exitCode = errorRecord.code === undefined ? "unknown exit" : `exit ${String(errorRecord.code)}`;
  const signal = typeof errorRecord.signal === "string" ? `, ${errorRecord.signal}` : "";
  return sanitizeInfrastructureDetail(`bb command failed (${exitCode}${signal})`);
}

function parseSpawnedThreadId(output) {
  let spawned;
  try {
    spawned = JSON.parse(output);
  } catch {
    throw new Error("bb thread spawn returned invalid JSON");
  }
  const threadId = spawned?.id ?? spawned?.thread?.id;
  if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 128) {
    throw new Error("bb thread spawn returned no valid thread id");
  }
  return threadId;
}

async function cleanupJudgeThread(threadId) {
  if (!threadId) return;
  const failures = [];
  let mustStop = true;
  try {
    const shown = JSON.parse(await bb(["thread", "show", threadId, "--json"]));
    if (shown?.status === "idle" || shown?.status === "error" || shown?.status === "archived") mustStop = false;
  } catch {
    failures.push("status inspection failed");
  }
  if (mustStop) {
    try {
      await bb(["thread", "stop", threadId, "--json"]);
    } catch {
      failures.push("stop failed");
    }
  }
  try {
    await bb(["thread", "archive", threadId, "--json"]);
  } catch {
    failures.push("archive failed");
  }
  if (failures.length > 0) throw new Error(`judge thread ${threadId} cleanup failed`);
}

function cleanupJudgeWorkspace(workspacePath) {
  try {
    rmSync(workspacePath, { recursive: true, force: true });
  } catch {
    throw new Error("judge temporary workspace cleanup failed");
  }
}

async function cleanupJudgeResources(threadId, workspacePath) {
  let failure = null;
  try {
    await cleanupJudgeThread(threadId);
  } catch (error) {
    failure = error instanceof Error ? error.message : "judge thread cleanup failed";
  }
  try {
    cleanupJudgeWorkspace(workspacePath);
  } catch (error) {
    failure = failure ?? (error instanceof Error ? error.message : "judge workspace cleanup failed");
  }
  if (failure) throw new Error(failure);
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

  const workspacePath = mkdtempSync(join(tmpdir(), "telegram-answer-judge-"));
  let threadId = null;
  let verdict = null;
  let isolation = null;
  try {
  const prompt = buildClauseJudgePrompt({
    clauseId: clause.id,
    ownerMessage: testCase.ownerMessage,
    answer: testCase.answer,
  });
  const spawnArgs = buildAnswerJudgeSpawnArgs({
    project: options.project,
    title: `answer-eval ${testCase.id} ${clause.id}`,
    prompt,
    workspace: workspacePath,
  });

  let spawnOutput;
  try {
    spawnOutput = await bb(spawnArgs);
  } catch (error) {
    throw new Error(`bb thread spawn failed: ${capturedDetail(error)}`);
  }
  threadId = parseSpawnedThreadId(spawnOutput);

  try {
    await bb(["thread", "wait", threadId, "--status", "idle", "--timeout", String(WAIT_SECONDS), "--json"], BB_WAIT_TIMEOUT_MS);
  } catch (error) {
    throw new Error(`judge thread ${threadId} did not finish within ${WAIT_SECONDS}s: ${capturedDetail(error)}`);
  }

  let eventLog;
  try {
    eventLog = await bb(["thread", "log", threadId, "--json", "--limit", String(BB_EVENT_LOG_LIMIT)]);
  } catch (error) {
    throw new Error(`judge thread ${threadId} event log failed: ${capturedDetail(error)}`);
  }
  isolation = auditJudgeEventLog(eventLog);
  if (!isolation) throw new Error(`judge thread ${threadId} event log did not prove completed no-tool execution`);

  let output;
  try {
    output = await bb(["thread", "output", threadId]);
  } catch (error) {
    throw new Error(`judge thread ${threadId} output failed: ${capturedDetail(error)}`);
  }
  verdict = parseClauseVerdict(output, clause.id);
  if (!verdict) {
    throw new Error(`judge thread ${threadId} returned a malformed single-clause verdict (captured output length ${output.length})`);
  }
  } finally {
    await cleanupJudgeResources(threadId, workspacePath);
  }
  return buildClauseAssessment({
    clauseId: verdict.id,
    holds: verdict.holds,
    source: "model",
    reason: verdict.holds ? "Model verdict recorded: clause holds." : "Model verdict recorded: clause fails.",
    judgeThreadId: threadId,
    judgeIsolation: isolation,
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

function printAssessments(assessments, expectation) {
  const judgedClauses = assessments.filter((clause) => clause.judgeIsolation !== null);
  process.stdout.write(`    ${JSON.stringify({
    rubricVersion: ANSWER_RUBRIC_VERSION,
    judgeProfile: ANSWER_JUDGE_PROFILE,
    expected: expectation,
    isolation: {
      eventLogsAudited: judgedClauses.every((clause) => clause.judgeIsolation.eventLog === "completed-audited"),
      noToolActivity: judgedClauses.every((clause) => clause.judgeIsolation.toolActivity === "none-observed"),
      workspacesCleaned: judgedClauses.every((clause) => clause.judgeIsolation.workspaceCleanup === "complete"),
    },
    clauses: assessments,
  })}\n`);
}

async function main() {
  const options = readArguments(process.argv.slice(2));
  const { cases } = JSON.parse(readFileSync(CASES_PATH, "utf8"));
  const expectations = parseAnswerExpectations(JSON.parse(readFileSync(EXPECTATIONS_PATH, "utf8")));
  const expectationsById = new Map(expectations.cases.map((each) => [each.id, each]));
  const selected = options.only ? cases.filter((each) => each.id === options.only) : cases;
  if (selected.length === 0) fail(`no case matched ${options.only}`);
  if (expectations.cases.length !== cases.length || cases.some((testCase) => !expectationsById.has(testCase.id))) {
    fail("expectation artifact does not cover exactly the golden cases");
  }
  for (const testCase of selected) {
    const expectation = expectationsById.get(testCase.id);
    if (!expectation || expectation.aggregate !== testCase.expect) fail(`expectation artifact mismatch for case ${testCase.id}`);
  }

  process.stdout.write(`answer judge rubric ${ANSWER_RUBRIC_VERSION}; profile ${JSON.stringify(ANSWER_JUDGE_PROFILE)}; clause concurrency ${CLAUSE_CONCURRENCY}\n`);
  let agreed = 0;
  let clauseAgreed = 0;
  let clauseTotal = 0;
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
    const expectation = expectationsById.get(testCase.id);
    const actual = result.passed ? "pass" : "fail";
    const broken = result.assessments.filter((clause) => !clause.holds).map((clause) => clause.id);
    const clauseMismatches = result.assessments
      .filter((clause) => clause.holds !== expectation.clauses[clause.id])
      .map((clause) => clause.id);
    clauseAgreed += result.assessments.length - clauseMismatches.length;
    clauseTotal += result.assessments.length;
    if (actual === testCase.expect && actual === expectation.aggregate && clauseMismatches.length === 0) {
      agreed += 1;
      process.stdout.write(`  ok     ${testCase.id} (${actual})${broken.length ? ` [${broken.join(", ")}]` : ""}\n`);
    } else {
      const detail = clauseMismatches.length > 0
        ? `clause mismatch: ${clauseMismatches.join(", ")}`
        : `expected ${testCase.expect}, judged ${actual}`;
      misses.push({ id: testCase.id, detail });
      process.stdout.write(`  MISS   ${testCase.id}: ${detail}\n`);
    }
    printAssessments(result.assessments, expectation);
  }

  process.stdout.write(`\naggregate agreement ${agreed}/${selected.length - infrastructureErrors.length}\n`);
  process.stdout.write(`clause agreement ${clauseAgreed}/${clauseTotal}\n`);
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
