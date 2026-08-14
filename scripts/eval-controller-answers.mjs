#!/usr/bin/env node
/**
 * Opt-in hybrid answer-quality evaluation.
 *
 * Deterministic checks can reject only explicit high-confidence violations.
 * Every clause without such a violation is graded in its own hidden BB thread,
 * so a model's opinion about one rule cannot contaminate another rule.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
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
  answerFinalInputSha256,
  answerJudgeTrialId,
  answerJudgeThreadTitle,
  assertAnswerEvaluationWriteIdentity,
  bindJudgeOutputToEventAudit,
  buildAnswerJudgeSpawnArgs,
  buildAnswerFinalInputBundle,
  buildClauseAssessment,
  buildClauseJudgePrompt,
  detectExplicitClauseViolation,
  isExactAnswerReleaseCorpus,
  parseAnswerExpectations,
  parseClauseVerdict,
  parseLiveGateArtifact,
  sanitizeInfrastructureDetail,
} from "../src/eval/answer-contract.ts";
import {
  closePreparedArtifactTarget,
  prepareArtifactTarget,
  publishValidatedArtifact,
  readJsonFixtureSnapshot,
  verifyFixtureSnapshotUnchanged,
} from "../src/eval/eval-integrity.ts";

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

function readGitIdentity() {
  return {
    hanoonCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: pluginRoot, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { cwd: pluginRoot, encoding: "utf8" }).trim() !== "",
  };
}

function readAnswerCorpusFiles() {
  const goldenSnapshot = readJsonFixtureSnapshot(CASES_PATH, (candidate) => {
    if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.cases)) {
      throw new Error("invalid answer golden fixture");
    }
    return candidate;
  });
  const expectationsSnapshot = readJsonFixtureSnapshot(EXPECTATIONS_PATH, parseAnswerExpectations);
  const { cases } = goldenSnapshot.value;
  const expectations = expectationsSnapshot.value;
  return {
    cases,
    expectationsById: new Map(expectations.cases.map((each) => [each.id, each])),
    expectationsCaseIds: expectations.cases.map((testCase) => testCase.id),
    goldenSha256: goldenSnapshot.sha256,
    expectationsSha256: expectationsSnapshot.sha256,
    goldenSnapshot,
    expectationsSnapshot,
  };
}

function finalInputSha256For(corpus, cases) {
  return answerFinalInputSha256(buildAnswerFinalInputBundle({
    goldenSha256: corpus.goldenSha256,
    expectationsSha256: corpus.expectationsSha256,
    cases: cases.map((testCase) => ({
      id: testCase.id,
      ownerMessage: testCase.ownerMessage,
      answer: testCase.answer,
    })),
  }));
}

function assertPinnedAnswerCorpus(corpus) {
  const caseIds = corpus.cases.map((testCase) => testCase.id);
  const finalInputSha256 = finalInputSha256For(corpus, corpus.cases);
  if (!isExactAnswerReleaseCorpus({
    caseIds,
    goldenSha256: corpus.goldenSha256,
    expectationsSha256: corpus.expectationsSha256,
    finalInputSha256,
  }) || JSON.stringify(corpus.expectationsCaseIds) !== JSON.stringify(caseIds)) {
    fail("checked-in answer corpus does not match the pinned release corpus");
  }
  if (corpus.expectationsById.size !== corpus.cases.length || corpus.cases.some((testCase) => !corpus.expectationsById.has(testCase.id))) {
    fail("expectation artifact does not cover exactly the golden cases");
  }
}

function selectAnswerCorpus(corpus, only) {
  const selected = only ? corpus.cases.filter((each) => each.id === only) : corpus.cases;
  if (selected.length === 0) fail(`no case matched ${only}`);
  for (const testCase of selected) {
    const expectation = corpus.expectationsById.get(testCase.id);
    if (!expectation || expectation.aggregate !== testCase.expect) fail(`expectation artifact mismatch for case ${testCase.id}`);
  }
  return {
    ...corpus,
    selected,
    finalInputSha256: finalInputSha256For(corpus, selected),
  };
}

function readAnswerCorpus(only) {
  const corpus = readAnswerCorpusFiles();
  assertPinnedAnswerCorpus(corpus);
  return selectAnswerCorpus(corpus, only);
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

function assertFreshJudgeWorkspace(workspacePath) {
  let workspaceStat;
  try {
    workspaceStat = statSync(workspacePath);
    if (!workspaceStat.isDirectory() || readdirSync(workspacePath).length !== 0) {
      throw new Error("judge workspace was not a fresh empty temporary directory");
    }
  } catch (error) {
    throw new Error(`judge workspace identity could not be established: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    path: workspacePath,
    device: workspaceStat.dev,
    inode: workspaceStat.ino,
    empty: true,
  };
}

function assertExternalArtifactPath(artifactPath) {
  if (!isAbsolute(artifactPath)) {
    throw new Error("live gate artifact path must be absolute and outside the plugin worktree");
  }
  const preparedTarget = prepareArtifactTarget(artifactPath);
  try {
    const realPluginRoot = realpathSync(pluginRoot);
    const pathFromRoot = relative(realPluginRoot, preparedTarget.targetPath);
    if (pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))) {
      throw new Error("live gate artifact path must be absolute and outside the plugin worktree");
    }
    return preparedTarget;
  } catch (error) {
    closePreparedArtifactTarget(preparedTarget);
    throw error;
  }
}

function buildJudgeCorrelation({ testCase, clause, runId, project, parentThreadId }) {
  const correlationToken = randomUUID();
  const trialId = answerJudgeTrialId(runId, testCase.id, clause.id);
  return {
    runId,
    trialId,
    caseId: testCase.id,
    clauseId: clause.id,
    originThreadId: parentThreadId,
    correlationToken,
    projectId: project,
    parentThreadId,
    title: answerJudgeThreadTitle({
      runId,
      caseId: testCase.id,
      clauseId: clause.id,
      parentThreadId,
      correlationToken,
    }),
  };
}

async function readJudgeThreadShow(threadId) {
  let parsed;
  try {
    parsed = JSON.parse(await bb(["thread", "show", threadId, "--json"]));
  } catch {
    throw new Error(`judge thread ${threadId} membership could not be captured`);
  }
  return { thread: parsed?.thread ?? parsed, environment: parsed?.environment };
}

function assertThreadCorrelation(threadId, thread, correlation) {
  if (!thread || typeof thread !== "object"
    || thread.id !== threadId
    || thread.projectId !== correlation.projectId
    || (thread.parentThreadId ?? null) !== correlation.parentThreadId
    || thread.title !== correlation.title) {
    throw new Error(`judge thread ${threadId} membership does not match its run correlation`);
  }
}

function assertThreadProviderAndEnvironment({ threadId, thread, environment, correlation, workspaceProof }) {
  if (thread.providerId !== ANSWER_JUDGE_PROFILE.provider || thread.visibility !== ANSWER_JUDGE_PROFILE.visibility) {
    throw new Error(`judge thread ${threadId} provider or visibility does not match its run correlation`);
  }
  if (typeof thread.environmentId !== "string"
    || !environment || typeof environment !== "object"
    || environment.id !== thread.environmentId
    || environment.projectId !== correlation.projectId
    || environment.path !== workspaceProof.path
    || workspaceProof.path !== resolve(workspaceProof.path)
    || !Number.isSafeInteger(workspaceProof.device)
    || !Number.isSafeInteger(workspaceProof.inode)) {
    throw new Error(`judge thread ${threadId} environment identity/path does not match its fresh workspace`);
  }
  const approvedMembership = correlation.membership;
  if (approvedMembership
    && (thread.environmentId !== approvedMembership.environmentId
      || environment.path !== approvedMembership.workspace.path
      || workspaceProof.device !== approvedMembership.workspace.device
      || workspaceProof.inode !== approvedMembership.workspace.inode)) {
    throw new Error(`judge thread ${threadId} environment identity changed after audit`);
  }
  assertFreshJudgeWorkspaceIdentity(threadId, workspaceProof);
}

function assertFreshJudgeWorkspaceIdentity(threadId, workspaceProof) {
  const currentWorkspace = assertFreshJudgeWorkspace(workspaceProof.path);
  if (currentWorkspace.device !== workspaceProof.device || currentWorkspace.inode !== workspaceProof.inode) {
    throw new Error(`judge thread ${threadId} environment workspace identity changed`);
  }
}

function assertThreadArchiveFields(threadId, thread) {
  if (!["error", "stopping", "idle", "starting", "active"].includes(thread.status)) {
    throw new Error(`judge thread ${threadId} status is not a recognized identity field`);
  }
  if (thread.archivedAt !== null && !Number.isSafeInteger(thread.archivedAt)) {
    throw new Error(`judge thread ${threadId} archived identity is invalid`);
  }
  if (thread.deletedAt !== null) throw new Error(`judge thread ${threadId} is deleted`);
}

function buildJudgeThreadMembership(thread, workspaceProof) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId ?? null,
    title: thread.title,
    providerId: thread.providerId,
    visibility: thread.visibility,
    environmentId: thread.environmentId,
    workspace: {
      environmentId: thread.environmentId,
      path: workspaceProof.path,
      device: workspaceProof.device,
      inode: workspaceProof.inode,
      empty: true,
    },
    status: thread.status,
    archivedAt: thread.archivedAt,
    deletedAt: thread.deletedAt,
    execution: null,
  };
}

async function captureJudgeThreadMembership(threadId, correlation, workspaceProof) {
  const shown = await readJudgeThreadShow(threadId);
  assertThreadCorrelation(threadId, shown.thread, correlation);
  assertThreadProviderAndEnvironment({
    threadId,
    thread: shown.thread,
    environment: shown.environment,
    correlation,
    workspaceProof,
  });
  assertThreadArchiveFields(threadId, shown.thread);
  return buildJudgeThreadMembership(shown.thread, workspaceProof);
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
    && candidate.providerId === ANSWER_JUDGE_PROFILE.provider
    && candidate.visibility === ANSWER_JUDGE_PROFILE.visibility
    && typeof candidate.environmentId === "string"
    && candidate.title === correlation.title
    && (candidate.parentThreadId ?? null) === correlation.originThreadId
    && (candidate.archivedAt === undefined || candidate.archivedAt === null)
    && (candidate.deletedAt === undefined || candidate.deletedAt === null);
}

async function waitForReconciliationRetry() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, RECONCILIATION_DELAY_MS));
}

async function assertJudgeEventHighWater(threadId, eventAudit) {
  const highWaterSequence = eventAudit.highWaterSequence;
  if (!Number.isSafeInteger(highWaterSequence)) throw new Error(`judge thread ${threadId} event audit had no high-water sequence`);
  let logOutput;
  try {
    logOutput = await bb([
      "thread", "log", threadId, "--json", "--after-seq", String(highWaterSequence), "--limit", "1",
    ]);
  } catch (error) {
    throw new Error(`judge thread ${threadId} event high-water recheck failed: ${capturedDetail(error)}`);
  }
  let newEvents;
  try {
    newEvents = JSON.parse(logOutput);
  } catch {
    throw new Error(`judge thread ${threadId} event high-water recheck returned invalid JSON`);
  }
  if (!Array.isArray(newEvents) || newEvents.length !== 0) {
    throw new Error(`judge thread ${threadId} changed after output proof`);
  }
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

async function spawnJudgeThread(spawnArgs, correlation, project, workspaceProof) {
  let failure = null;
  let spawnOutput = null;
  try {
    spawnOutput = await bb(spawnArgs);
  } catch (error) {
    failure = new Error(`bb thread spawn failed: ${capturedDetail(error)}`);
  }
  if (!failure) {
    try {
      const returnedThreadId = parseSpawnedThreadId(spawnOutput);
      try {
        await captureJudgeThreadMembership(returnedThreadId, correlation, workspaceProof);
        return { threadId: returnedThreadId, failure: null };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "returned thread membership mismatch";
        failure = new Error(`bb thread spawn returned an uncorrelated thread: ${detail}`);
      }
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

async function authorizeJudgeCleanup(threadId, correlation, project, workspaceProof) {
  try {
    await captureJudgeThreadMembership(threadId, correlation, workspaceProof);
    return threadId;
  } catch {
    const reconciledThreadId = await reconcileJudgeThread(correlation, project);
    await captureJudgeThreadMembership(reconciledThreadId, correlation, workspaceProof);
    return reconciledThreadId;
  }
}

function assertArchivedTerminalMembership(threadId, membership) {
  if (!Number.isSafeInteger(membership.archivedAt) || membership.archivedAt <= 0
    || membership.deletedAt !== null || !["idle", "error"].includes(membership.status)) {
    throw new Error(`judge thread ${threadId} did not prove an archived terminal identity`);
  }
}

async function stopAndArchiveJudgeThread(threadId) {
  await stopJudgeThread(threadId);
  let archiveOutput;
  try {
    archiveOutput = JSON.parse(await bb(["thread", "archive", threadId, "--json"]));
  } catch {
    throw new Error(`judge thread ${threadId} archive returned invalid JSON`);
  }
  if (archiveOutput?.ok !== true
    || !Array.isArray(archiveOutput.archivedThreadIds)
    || archiveOutput.archivedThreadIds.length !== 1
    || archiveOutput.archivedThreadIds[0] !== threadId) {
    throw new Error(`judge thread ${threadId} archive response did not identify exactly that thread`);
  }
}

async function stopJudgeThread(threadId) {
  let stopOutput;
  try {
    stopOutput = JSON.parse(await bb(["thread", "stop", threadId, "--json"]));
  } catch {
    throw new Error(`judge thread ${threadId} stop returned invalid JSON`);
  }
  if (stopOutput?.ok !== true) throw new Error(`judge thread ${threadId} stop was not acknowledged`);
}

async function archiveJudgeThread(threadId, correlation, workspaceProof) {
  let current = await captureJudgeThreadMembership(threadId, correlation, workspaceProof);
  if (current.archivedAt !== null) {
    assertArchivedTerminalMembership(threadId, current);
    return current;
  }
  await stopAndArchiveJudgeThread(threadId);
  current = await captureJudgeThreadMembership(threadId, correlation, workspaceProof);
  assertArchivedTerminalMembership(threadId, current);
  return current;
}

async function cleanupJudgeThread(threadId, correlation, project, workspaceProof) {
  if (!threadId || !correlation) throw new Error("judge cleanup correlation was not established");
  const authorizedThreadId = await authorizeJudgeCleanup(threadId, correlation, project, workspaceProof);
  await archiveJudgeThread(authorizedThreadId, correlation, workspaceProof);
}

function cleanupJudgeWorkspace(workspacePath) {
  try {
    rmSync(workspacePath, { recursive: true, force: true });
  } catch {
    throw new Error("judge temporary workspace cleanup failed");
  }
}

async function cleanupJudgeResources({ threadId, workspacePath, runtimeAudit, correlation, project, workspaceProof }) {
  let failure = null;
  if (!threadId) runtimeAudit.judgeThreadsCleaned = false;
  try {
    if (threadId) await cleanupJudgeThread(threadId, correlation, project, workspaceProof);
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

async function readJudgeEventLog(threadId) {
  try {
    return await bb(["thread", "log", threadId, "--json", "--limit", String(BB_EVENT_LOG_LIMIT)]);
  } catch (error) {
    throw new Error(`judge thread ${threadId} event log failed: ${capturedDetail(error)}`);
  }
}

function assertJudgeExecution(execution, threadId) {
  if (!execution
    || execution.model !== ANSWER_JUDGE_PROFILE.model
    || execution.reasoningLevel !== ANSWER_JUDGE_PROFILE.reasoningLevel
    || execution.serviceTier !== ANSWER_JUDGE_PROFILE.serviceTier
    || execution.permissionMode !== ANSWER_JUDGE_PROFILE.permissionMode) {
    throw new Error(`judge thread ${threadId} resolved execution tuple does not match the pinned judge profile`);
  }
}

function parseJudgeOutput(output, threadId) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`judge thread ${threadId} output returned invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.output !== "string") {
    throw new Error(`judge thread ${threadId} output response did not contain a final string output`);
  }
  return parsed.output;
}

async function judgeClause({ options, testCase, clause, runtimeAudit, runId, parentThreadId }) {
  const deterministicReason = detectExplicitClauseViolation(clause.id, testCase.answer);
  const workspacePath = mkdtempSync(join(tmpdir(), "telegram-answer-judge-"));
  const workspaceProof = assertFreshJudgeWorkspace(workspacePath);
  let threadId = null;
  let correlation = null;
  let verdict = null;
  let isolation = null;
  let judgeCorrelation = null;
  let membership = null;
  try {
    const prompt = buildClauseJudgePrompt({
      clauseId: clause.id,
      ownerMessage: testCase.ownerMessage,
      answer: testCase.answer,
    });
    correlation = buildJudgeCorrelation({ testCase, clause, runId, project: options.project, parentThreadId });
    const spawnArgs = buildAnswerJudgeSpawnArgs({
      project: options.project,
      title: correlation.title,
      prompt,
      workspace: workspacePath,
      parentThreadId: correlation.originThreadId,
    });
    const spawned = await spawnJudgeThread(spawnArgs, correlation, options.project, workspaceProof);
    threadId = spawned.threadId;
    if (spawned.failure) throw spawned.failure;

    try {
      await bb(["thread", "wait", threadId, "--status", "idle", "--timeout", String(WAIT_SECONDS), "--json"], BB_WAIT_TIMEOUT_MS);
    } catch (error) {
      throw new Error(`judge thread ${threadId} did not finish within ${WAIT_SECONDS}s: ${capturedDetail(error)}`);
    }

    await captureJudgeThreadMembership(threadId, correlation, workspaceProof);
    const terminalMembership = await archiveJudgeThread(threadId, correlation, workspaceProof);

    const sealedEventLog = await readJudgeEventLog(threadId);
    const sealedEventAudit = auditJudgeEventLog(sealedEventLog, threadId);
    if (!sealedEventAudit) {
      runtimeAudit.eventLogsAudited = false;
      runtimeAudit.noToolActivity = false;
      throw new Error(`judge thread ${threadId} sealed event log did not prove completed no-tool execution`);
    }
    assertJudgeExecution(sealedEventAudit.execution, threadId);

    const eventLog = await readJudgeEventLog(threadId);
    if (createHash("sha256").update(eventLog, "utf8").digest("hex")
      !== createHash("sha256").update(sealedEventLog, "utf8").digest("hex")) {
      runtimeAudit.eventLogsAudited = false;
      runtimeAudit.noToolActivity = false;
      throw new Error(`judge thread ${threadId} changed between seal and final event capture`);
    }
    const eventAudit = auditJudgeEventLog(eventLog, threadId);
    if (!eventAudit) {
      runtimeAudit.eventLogsAudited = false;
      runtimeAudit.noToolActivity = false;
      throw new Error(`judge thread ${threadId} event log did not prove completed no-tool execution`);
    }
    assertJudgeExecution(eventAudit.execution, threadId);
    isolation = {
      workspace: eventAudit.workspace,
      eventLog: eventAudit.eventLog,
      toolActivity: eventAudit.toolActivity,
      workspaceCleanup: eventAudit.workspaceCleanup,
      eventCount: eventAudit.eventCount,
    };

    let outputResponse;
    try {
      outputResponse = await bb(["thread", "output", threadId, "--json"]);
    } catch (error) {
      throw new Error(`judge thread ${threadId} output failed: ${capturedDetail(error)}`);
    }
    const output = parseJudgeOutput(outputResponse, threadId);
    const outputBinding = bindJudgeOutputToEventAudit(output, eventLog, eventAudit, threadId);
    if (!outputBinding) {
      throw new Error(`judge thread ${threadId} output did not match ordered audited assistant deltas`);
    }
    if (outputBinding.highWaterSequence !== sealedEventAudit.highWaterSequence) {
      throw new Error(`judge thread ${threadId} final output high-water differs from the sealed capture`);
    }
    await assertJudgeEventHighWater(threadId, eventAudit);
    const finalMembership = await archiveJudgeThread(threadId, correlation, workspaceProof);
    if (finalMembership.id !== terminalMembership.id
      || finalMembership.environmentId !== terminalMembership.environmentId
      || finalMembership.workspace.path !== terminalMembership.workspace.path
      || finalMembership.archivedAt !== terminalMembership.archivedAt) {
      throw new Error(`judge thread ${threadId} terminal identity changed after final capture`);
    }
    await assertJudgeEventHighWater(threadId, eventAudit);
    membership = { ...finalMembership, execution: eventAudit.execution };
    verdict = parseClauseVerdict(output, clause.id);
    if (!verdict && !deterministicReason) {
      throw new Error(`judge thread ${threadId} returned a malformed single-clause verdict (captured output length ${output.length})`);
    }
    judgeCorrelation = {
      runId: correlation.runId,
      trialId: correlation.trialId,
      caseId: correlation.caseId,
      clauseId: correlation.clauseId,
      correlationToken: correlation.correlationToken,
      threadId,
      projectId: correlation.projectId,
      parentThreadId: correlation.parentThreadId,
      title: correlation.title,
      execution: eventAudit.execution,
      membership,
      eventProjection: eventAudit.eventProjection,
      eventLogSha256: createHash("sha256").update(eventLog, "utf8").digest("hex"),
      eventCount: eventAudit.eventCount,
      targetTurnId: eventAudit.targetTurnId,
      targetTurnStartEventId: eventAudit.targetTurnStartEventId,
      targetTurnCompletionEventId: eventAudit.targetTurnCompletionEventId,
      agentMessageItemId: eventAudit.agentMessageItemId,
      outputItemId: outputBinding.outputItemId,
      outputSha256: outputBinding.outputSha256,
      sealedHighWaterSequence: sealedEventAudit.highWaterSequence,
      highWaterSequence: outputBinding.highWaterSequence,
    };
  } finally {
    await cleanupJudgeResources({
      threadId,
      workspacePath,
      runtimeAudit,
      correlation: judgeCorrelation ?? correlation,
      project: options.project,
      workspaceProof,
    });
  }
  return buildClauseAssessment({
    clauseId: clause.id,
    holds: deterministicReason ? false : verdict.holds,
    source: deterministicReason ? "deterministic" : "model",
    reason: deterministicReason ?? (verdict.holds ? "Model verdict recorded: clause holds." : "Model verdict recorded: clause fails."),
    judgeThreadId: threadId,
    judgeIsolation: isolation,
    judgeCorrelation,
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

async function gradeCase({ options, testCase, runtimeAudit, runId, parentThreadId }) {
  const outcomes = await mapWithConcurrency(ANSWER_CLAUSES, CLAUSE_CONCURRENCY, async (clause) => {
    try {
      return { assessment: await judgeClause({ options, testCase, clause, runtimeAudit, runId, parentThreadId }) };
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

function buildLiveGateCaseResult(runId, testCase, expectation, result) {
  if (!result) {
    return {
      id: testCase.id,
      expected: expectation.aggregate,
      result: "infrastructure-error",
      matchesGolden: false,
      clauses: ANSWER_CLAUSES.map((clause) => ({
        id: clause.id,
        trialId: answerJudgeTrialId(runId, testCase.id, clause.id),
        expected: expectation.clauses[clause.id],
        result: null,
        source: "infrastructure",
        judgeThreadId: null,
        isolation: null,
        correlation: null,
      })),
    };
  }
  const clauses = ANSWER_CLAUSES.map((clause) => {
    const assessment = result.assessments.find((candidate) => candidate.id === clause.id);
    return {
      id: clause.id,
      trialId: answerJudgeTrialId(runId, testCase.id, clause.id),
      expected: expectation.clauses[clause.id],
      result: assessment?.holds ?? null,
      source: assessment?.source ?? "infrastructure",
      judgeThreadId: assessment?.judgeThreadId ?? null,
      isolation: assessment?.judgeIsolation ?? null,
      correlation: assessment?.judgeCorrelation ?? null,
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

function buildLiveGateArtifact({ runId, selected, caseResults, infrastructureErrors, runtimeAudit, hanoonCommit, dirty, goldenSha256, expectationsSha256, finalInputSha256 }) {
  const selectedClauseCount = selected.length * ANSWER_CLAUSES.length;
  const clauseAgreed = caseResults.reduce((total, caseResult) => total + caseResult.clauses.filter((clause) => clause.result !== null && clause.result === clause.expected).length, 0);
  const caseAgreed = caseResults.filter((caseResult) => caseResult.matchesGolden).length;
  return {
    schemaVersion: ANSWER_LIVE_GATE_SCHEMA_VERSION,
    rubricVersion: ANSWER_RUBRIC_VERSION,
    runId,
    judgeProfile: ANSWER_JUDGE_PROFILE,
    hanoonCommit,
    dirty,
    goldenSha256,
    expectationsSha256,
    finalInputSha256,
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

function writeLiveGateArtifact(preparedTarget, artifact, forbiddenValues, assertCurrentInputs) {
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  publishValidatedArtifact({
    artifactPath: preparedTarget.targetPath,
    preparedTarget,
    serialized,
    replace: true,
    validateSerialized: (candidate) => {
      if (!parseLiveGateArtifact(candidate, forbiddenValues)) throw new Error("live gate artifact failed schema or secret validation");
    },
    verifyBeforePublish: assertCurrentInputs,
    verifyIdentity: () => assertCurrentInputs?.(),
  });
}

async function main() {
  const options = readArguments(process.argv.slice(2));
  const preparedArtifactTarget = assertExternalArtifactPath(options.artifact);
  try {
    const corpus = readAnswerCorpus(options.only);
    const runId = randomUUID();
    const initialIdentity = readGitIdentity();
    if (initialIdentity.dirty) fail("answer evaluator repository is dirty; refusing live evaluation");
    const { selected, expectationsById, goldenSha256, expectationsSha256, finalInputSha256 } = corpus;
    const parentThreadId = typeof process.env.BB_THREAD_ID === "string" && process.env.BB_THREAD_ID.length > 0
      ? process.env.BB_THREAD_ID
      : null;

  process.stdout.write(`answer judge rubric ${ANSWER_RUBRIC_VERSION}; profile ${JSON.stringify(ANSWER_JUDGE_PROFILE)}; clause concurrency ${CLAUSE_CONCURRENCY}\n`);
  const runtimeAudit = createRuntimeAudit();
  const caseResults = [];
  const infrastructureErrors = [];
  const misses = [];
  for (const testCase of selected) {
    const expectation = expectationsById.get(testCase.id);
    let result;
    try {
      result = await gradeCase({ options, testCase, runtimeAudit, runId, parentThreadId });
    } catch (error) {
      const detail = sanitizeInfrastructureDetail(error instanceof Error ? error.message : "judge failed", [testCase.ownerMessage, testCase.answer]);
      infrastructureErrors.push({ id: testCase.id, detail });
      caseResults.push(buildLiveGateCaseResult(runId, testCase, expectation, null));
      process.stdout.write(`  ERROR  ${testCase.id}: ${detail}\n`);
      break;
    }
    const actual = result.passed ? "pass" : "fail";
    const broken = result.assessments.filter((clause) => !clause.holds).map((clause) => clause.id);
    const clauseMismatches = result.assessments
      .filter((clause) => clause.holds !== expectation.clauses[clause.id])
      .map((clause) => clause.id);
    const caseResult = buildLiveGateCaseResult(runId, testCase, expectation, result);
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
      caseResults.push(buildLiveGateCaseResult(runId, testCase, expectation, null));
    }
  }

  const artifact = buildLiveGateArtifact({
    runId,
    selected,
    caseResults,
    infrastructureErrors,
    runtimeAudit,
    hanoonCommit: initialIdentity.hanoonCommit,
    dirty: initialIdentity.dirty,
    goldenSha256,
    expectationsSha256,
    finalInputSha256,
  });
  const forbiddenValues = selected.flatMap((testCase) => [testCase.ownerMessage, testCase.answer]);
  writeLiveGateArtifact(preparedArtifactTarget, artifact, forbiddenValues, () => {
    verifyFixtureSnapshotUnchanged(corpus.goldenSnapshot, CASES_PATH);
    verifyFixtureSnapshotUnchanged(corpus.expectationsSnapshot, EXPECTATIONS_PATH);
    const finalIdentity = readGitIdentity();
    assertAnswerEvaluationWriteIdentity(
      {
        ...initialIdentity,
        goldenSha256,
        expectationsSha256,
        finalInputSha256,
      },
      {
        ...finalIdentity,
        goldenSha256,
        expectationsSha256,
        finalInputSha256,
      },
    );
  });

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
  return artifact.status === "passed" ? 0 : 1;
  } finally {
    closePreparedArtifactTarget(preparedArtifactTarget);
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  process.stderr.write(`answer eval: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
