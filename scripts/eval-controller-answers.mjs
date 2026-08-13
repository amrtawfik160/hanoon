#!/usr/bin/env node
/**
 * Opt-in hybrid answer-quality evaluation.
 *
 * Deterministic checks can reject only explicit high-confidence violations.
 * Every clause without such a violation is graded in its own hidden BB thread,
 * so a model's opinion about one rule cannot contaminate another rule.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ANSWER_CLAUSES,
  ANSWER_LIVE_GATE_SCHEMA_VERSION,
  ANSWER_LIVE_GATE_RELEASE_CORPUS,
  ANSWER_JUDGE_PROFILE,
  ANSWER_RUBRIC_VERSION,
  auditJudgeEventLog,
  buildAnswerJudgeSpawnArgs,
  buildClauseAssessment,
  buildClauseJudgePrompt,
  detectExplicitClauseViolation,
  isExactAnswerReleaseCorpus,
  parseAnswerExpectations,
  parseClauseVerdict,
  parseLiveGateArtifact,
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
const RECONCILIATION_ATTEMPTS = 3;
const RECONCILIATION_DELAY_MS = 100;

function fail(message) {
  throw new Error(message);
}

function readArguments(argv) {
  const options = { project: null, only: null, artifact: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--project" && value) { options.project = value; index += 1; continue; }
    if (flag === "--case" && value) { options.only = value; index += 1; continue; }
    if (flag === "--artifact" && value) { options.artifact = value; index += 1; continue; }
    fail(`unknown argument ${flag}`);
  }
  if (!options.project) fail("--project <project-id> is required");
  if (!options.artifact) fail("--artifact <external-output-path> is required");
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

function assertExternalArtifactPath(artifactPath) {
  const resolvedPath = resolve(artifactPath);
  const pathFromRoot = relative(pluginRoot, resolvedPath);
  if (!isAbsolute(artifactPath) || pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))) {
    throw new Error("live gate artifact path must be absolute and outside the plugin worktree");
  }
  return resolvedPath;
}

function buildJudgeCorrelation(testCase, clause) {
  const originThreadId = typeof process.env.BB_THREAD_ID === "string" && process.env.BB_THREAD_ID.length > 0
    ? process.env.BB_THREAD_ID
    : null;
  const correlationToken = randomUUID();
  return {
    originThreadId,
    title: `answer-eval ${testCase.id} ${clause.id} origin=${originThreadId ?? "standalone"} correlation=${correlationToken}`,
  };
}

function parseThreadList(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("bb thread list returned invalid JSON during spawn reconciliation");
  }
  if (!Array.isArray(parsed)) throw new Error("bb thread list returned an invalid shape during spawn reconciliation");
  return parsed;
}

function isExactCorrelatedThread(candidate, correlation, project) {
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    && typeof candidate.id === "string"
    && candidate.projectId === project
    && candidate.title === correlation.title
    && (candidate.parentThreadId ?? null) === correlation.originThreadId
    && (candidate.archivedAt === undefined || candidate.archivedAt === null)
    && (candidate.deletedAt === undefined || candidate.deletedAt === null);
}

async function waitForReconciliationRetry() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, RECONCILIATION_DELAY_MS));
}

async function reconcileJudgeThread(correlation, project) {
  let lastFailure = null;
  for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
    try {
      const output = await bb(["thread", "list", "--project", project, "--include-hidden", "--json"]);
      const candidates = parseThreadList(output).filter((candidate) => isExactCorrelatedThread(candidate, correlation, project));
      const threadIds = [...new Set(candidates.map((candidate) => candidate.id))];
      if (threadIds.length === 1) return threadIds[0];
      if (threadIds.length > 1) throw new Error("ambiguous judge spawn reconciliation; refusing broad cleanup");
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : "thread list failed";
    }
    if (attempt + 1 < RECONCILIATION_ATTEMPTS) await waitForReconciliationRetry();
  }
  throw new Error(lastFailure ?? "judge spawn remained ambiguous; no exact thread was reconciled");
}

async function spawnJudgeThread(spawnArgs, correlation, project) {
  let failure = null;
  let spawnOutput = null;
  try {
    spawnOutput = await bb(spawnArgs);
  } catch (error) {
    failure = new Error(`bb thread spawn failed: ${capturedDetail(error)}`);
  }
  if (!failure) {
    try {
      return { threadId: parseSpawnedThreadId(spawnOutput), failure: null };
    } catch (error) {
      failure = error instanceof Error ? error : new Error("bb thread spawn returned invalid JSON");
    }
  }
  let reconciledThreadId;
  try {
    reconciledThreadId = await reconcileJudgeThread(correlation, project);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "spawn reconciliation failed";
    throw new Error(`${failure.message}; ${detail}`);
  }
  return { threadId: reconciledThreadId, failure };
}

async function cleanupJudgeThread(threadId) {
  if (!threadId) return;
  const failures = [];
  let mustStop = true;
  try {
    const shown = JSON.parse(await bb(["thread", "show", threadId, "--json"]));
    const status = shown?.thread?.status ?? shown?.status;
    if (["idle", "stopped", "error", "archived"].includes(status)) mustStop = false;
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

async function cleanupJudgeResources(threadId, workspacePath, runtimeAudit) {
  let failure = null;
  if (!threadId) runtimeAudit.judgeThreadsCleaned = false;
  try {
    await cleanupJudgeThread(threadId);
  } catch (error) {
    runtimeAudit.judgeThreadsCleaned = false;
    failure = error instanceof Error ? error.message : "judge thread cleanup failed";
  }
  try {
    cleanupJudgeWorkspace(workspacePath);
  } catch (error) {
    runtimeAudit.workspacesCleaned = false;
    failure = failure ?? (error instanceof Error ? error.message : "judge workspace cleanup failed");
  }
  if (failure) throw new Error(failure);
}

async function judgeClause(options, testCase, clause, runtimeAudit) {
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
    const correlation = buildJudgeCorrelation(testCase, clause);
    const spawnArgs = buildAnswerJudgeSpawnArgs({
      project: options.project,
      title: correlation.title,
      prompt,
      workspace: workspacePath,
      parentThreadId: correlation.originThreadId,
    });
    const spawned = await spawnJudgeThread(spawnArgs, correlation, options.project);
    threadId = spawned.threadId;
    if (spawned.failure) throw spawned.failure;

    try {
      await bb(["thread", "wait", threadId, "--status", "idle", "--timeout", String(WAIT_SECONDS), "--json"], BB_WAIT_TIMEOUT_MS);
    } catch (error) {
      throw new Error(`judge thread ${threadId} did not finish within ${WAIT_SECONDS}s: ${capturedDetail(error)}`);
    }

    let eventLog;
    try {
      eventLog = await bb(["thread", "log", threadId, "--json", "--limit", String(BB_EVENT_LOG_LIMIT)]);
    } catch (error) {
      runtimeAudit.eventLogsAudited = false;
      runtimeAudit.noToolActivity = false;
      throw new Error(`judge thread ${threadId} event log failed: ${capturedDetail(error)}`);
    }
    isolation = auditJudgeEventLog(eventLog);
    if (!isolation) {
      runtimeAudit.eventLogsAudited = false;
      runtimeAudit.noToolActivity = false;
      throw new Error(`judge thread ${threadId} event log did not prove completed no-tool execution`);
    }

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
    await cleanupJudgeResources(threadId, workspacePath, runtimeAudit);
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

async function gradeCase(options, testCase, runtimeAudit) {
  const outcomes = await mapWithConcurrency(ANSWER_CLAUSES, CLAUSE_CONCURRENCY, async (clause) => {
    try {
      return { assessment: await judgeClause(options, testCase, clause, runtimeAudit) };
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

function createRuntimeAudit() {
  return {
    eventLogsAudited: true,
    noToolActivity: true,
    judgeThreadsCleaned: true,
    workspacesCleaned: true,
  };
}

function hasCompleteRuntimeAudit(runtimeAudit) {
  return runtimeAudit.eventLogsAudited
    && runtimeAudit.noToolActivity
    && runtimeAudit.workspacesCleaned
    && runtimeAudit.judgeThreadsCleaned;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildLiveGateCaseResult(testCase, expectation, result) {
  if (!result) {
    return {
      id: testCase.id,
      expected: expectation.aggregate,
      result: "infrastructure-error",
      matchesGolden: false,
      clauses: ANSWER_CLAUSES.map((clause) => ({
        id: clause.id,
        expected: expectation.clauses[clause.id],
        result: null,
        source: "infrastructure",
        judgeThreadId: null,
        isolation: null,
      })),
    };
  }
  const clauses = ANSWER_CLAUSES.map((clause) => {
    const assessment = result.assessments.find((candidate) => candidate.id === clause.id);
    return {
      id: clause.id,
      expected: expectation.clauses[clause.id],
      result: assessment?.holds ?? null,
      source: assessment?.source ?? "infrastructure",
      judgeThreadId: assessment?.judgeThreadId ?? null,
      isolation: assessment?.judgeIsolation ?? null,
    };
  });
  const actual = result.passed ? "pass" : "fail";
  const matchesGolden = actual === testCase.expect
    && actual === expectation.aggregate
    && clauses.every((clause) => clause.result === clause.expected);
  return {
    id: testCase.id,
    expected: expectation.aggregate,
    result: actual,
    matchesGolden,
    clauses,
  };
}

function buildLiveGateArtifact({ selected, caseResults, infrastructureErrors, runtimeAudit, goldenSha256, expectationsSha256 }) {
  const selectedClauseCount = selected.length * ANSWER_CLAUSES.length;
  const clauseAgreed = caseResults.reduce((total, caseResult) => total + caseResult.clauses.filter((clause) => clause.result !== null && clause.result === clause.expected).length, 0);
  const caseAgreed = caseResults.filter((caseResult) => caseResult.matchesGolden).length;
  return {
    schemaVersion: ANSWER_LIVE_GATE_SCHEMA_VERSION,
    rubricVersion: ANSWER_RUBRIC_VERSION,
    judgeProfile: ANSWER_JUDGE_PROFILE,
    goldenSha256,
    expectationsSha256,
    selectedCaseCount: selected.length,
    selectedClauseCount,
    cases: caseResults,
    infrastructureErrors,
    audit: {
      clauseConcurrency: CLAUSE_CONCURRENCY,
      eventLogsAudited: runtimeAudit.eventLogsAudited,
      noToolActivity: runtimeAudit.noToolActivity,
      workspacesCleaned: runtimeAudit.workspacesCleaned,
      cleanup: {
        judgeThreads: runtimeAudit.judgeThreadsCleaned ? "complete" : "incomplete",
        workspaces: runtimeAudit.workspacesCleaned ? "complete" : "incomplete",
      },
    },
    aggregate: {
      cases: { agreed: caseAgreed, total: selected.length },
      clauses: { agreed: clauseAgreed, total: selectedClauseCount },
    },
    status: selected.length === ANSWER_LIVE_GATE_RELEASE_CORPUS.caseCount
      && infrastructureErrors.length === 0
      && caseAgreed === selected.length
      && clauseAgreed === selectedClauseCount
      && hasCompleteRuntimeAudit(runtimeAudit)
      ? "passed"
      : "failed",
  };
}

function writeLiveGateArtifact(artifactPath, artifact, forbiddenValues) {
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  if (!parseLiveGateArtifact(serialized, forbiddenValues)) throw new Error("live gate artifact failed schema or secret validation");
  const temporaryPath = `${artifactPath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, artifactPath);
    chmodSync(artifactPath, 0o600);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try { unlinkSync(temporaryPath); } catch { /* best effort for an incomplete atomic write */ }
    throw new Error(`live gate artifact write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const options = readArguments(process.argv.slice(2));
  const artifactPath = assertExternalArtifactPath(options.artifact);
  const { cases } = JSON.parse(readFileSync(CASES_PATH, "utf8"));
  const expectations = parseAnswerExpectations(JSON.parse(readFileSync(EXPECTATIONS_PATH, "utf8")));
  const expectationsById = new Map(expectations.cases.map((each) => [each.id, each]));
  const goldenSha256 = sha256File(CASES_PATH);
  const expectationsSha256 = sha256File(EXPECTATIONS_PATH);
  if (
    !isExactAnswerReleaseCorpus({
      caseIds: cases.map((testCase) => testCase.id),
      goldenSha256,
      expectationsSha256,
    })
    || !isExactAnswerReleaseCorpus({
      caseIds: expectations.cases.map((testCase) => testCase.id),
      goldenSha256,
      expectationsSha256,
    })
  ) {
    fail("checked-in answer corpus does not match the pinned release corpus");
  }
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
  const runtimeAudit = createRuntimeAudit();
  const caseResults = [];
  const infrastructureErrors = [];
  const misses = [];
  for (const testCase of selected) {
    const expectation = expectationsById.get(testCase.id);
    let result;
    try {
      result = await gradeCase(options, testCase, runtimeAudit);
    } catch (error) {
      const detail = sanitizeInfrastructureDetail(error instanceof Error ? error.message : "judge failed", [testCase.ownerMessage, testCase.answer]);
      infrastructureErrors.push({ id: testCase.id, detail });
      caseResults.push(buildLiveGateCaseResult(testCase, expectation, null));
      process.stdout.write(`  ERROR  ${testCase.id}: ${detail}\n`);
      break;
    }
    const actual = result.passed ? "pass" : "fail";
    const broken = result.assessments.filter((clause) => !clause.holds).map((clause) => clause.id);
    const clauseMismatches = result.assessments
      .filter((clause) => clause.holds !== expectation.clauses[clause.id])
      .map((clause) => clause.id);
    const caseResult = buildLiveGateCaseResult(testCase, expectation, result, null);
    caseResults.push(caseResult);
    if (actual === testCase.expect && actual === expectation.aggregate && clauseMismatches.length === 0) {
      process.stdout.write(`  ok     ${testCase.id} (${actual})${broken.length ? ` [${broken.join(", ")}]` : ""}\n`);
    } else {
      const detail = clauseMismatches.length > 0
        ? `clause mismatch: ${clauseMismatches.join(", ")}`
        : `expected ${testCase.expect}, judged ${actual}`;
      misses.push({ id: testCase.id, detail });
      process.stdout.write(`  MISS   ${testCase.id}: ${detail}\n`);
    }
    printAssessments(result.assessments, expectation);
    if (clauseMismatches.length > 0 || actual !== testCase.expect || actual !== expectation.aggregate) break;
  }

  if (caseResults.length < selected.length) {
    const stopDetail = "evaluation stopped after an earlier semantic mismatch or infrastructure error";
    for (const testCase of selected.slice(caseResults.length)) {
      const expectation = expectationsById.get(testCase.id);
      infrastructureErrors.push({ id: testCase.id, detail: stopDetail });
      caseResults.push(buildLiveGateCaseResult(testCase, expectation, null, stopDetail));
    }
  }

  const artifact = buildLiveGateArtifact({
    selected,
    caseResults,
    infrastructureErrors,
    runtimeAudit,
    goldenSha256,
    expectationsSha256,
  });
  const forbiddenValues = selected.flatMap((testCase) => [testCase.ownerMessage, testCase.answer]);
  writeLiveGateArtifact(artifactPath, artifact, forbiddenValues);

  if (options.only) {
    process.stdout.write("diagnostic --case selection: artifact is incomplete and cannot be release-passed\n");
  }
  process.stdout.write(`\naggregate agreement ${artifact.aggregate.cases.agreed}/${selected.length}\n`);
  process.stdout.write(`clause agreement ${artifact.aggregate.clauses.agreed}/${selected.length * ANSWER_CLAUSES.length}\n`);
  if (infrastructureErrors.length > 0) {
    process.stdout.write(`infrastructure errors ${infrastructureErrors.length}/${selected.length}; rubric was not invoked for those cases\n`);
    process.stdout.write("answer evaluation could not judge every selected case; fix infrastructure before trusting the rubric\n");
  }
  if (misses.length > 0) {
    process.stdout.write("the rubric disagreed with its golden cases; recalibrate before trusting it\n");
  }
  return infrastructureErrors.length > 0 || misses.length > 0 ? 1 : 0;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  process.stderr.write(`answer eval: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
