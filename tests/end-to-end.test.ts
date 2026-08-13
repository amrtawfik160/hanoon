import { createHash } from "node:crypto";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { GateInput } from "../src/domain/gates";
import type { Job } from "../src/domain/models";
import { resolvePrHead, runValidation, type ValidationSnapshot } from "../src/bb/validation";
import { BbRunner } from "../src/bb/runner";
import { buildCritiqueArtifact, buildDocsReportArtifact, buildPlanArtifact } from "../src/bb/pipeline-handoffs";
import { TerminalCommandRunner } from "../src/bb/terminal-command";
import { encodeCallbackData } from "../src/telegram/view";
import type { TelegramUpdate } from "../src/telegram/types";
import { TelegramIngress } from "../src/telegram/ingress";
import { ReviewHandler, type ReviewHandlerEvent } from "../src/services/review-handler";
import { ApprovalService } from "../src/services/approval-service";
import { EffectRunner, type EffectFence } from "../src/services/effect-runner";
import { MergeHandler } from "../src/services/merge-handler";
import { runJobExecutorService, type JobExecutorTelegram } from "../src/services/job-executor-service";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { hashSecret } from "../src/crypto";
import { privateMessage, policyFixture } from "./helpers";
import { runProductionStage } from "../src/services/production-runner";

const HEAD_ONE = "a".repeat(40);
const HEAD_TWO = "b".repeat(40);
const HEAD_THREE = "c".repeat(40);
const MERGE_COMMIT = "d".repeat(40);
const PR_NUMBER = 17;
const PR_URL = "https://github.com/acme/cyndra/pull/17";

type SpawnCall = {
  projectId: string;
  title: string;
  parentThreadId?: string;
  visibility: string;
  environment: Record<string, unknown>;
  input: Array<Record<string, unknown>>;
};

type AttachmentCall = {
  projectId: string;
  filename: string;
  clientFile: Uint8Array;
  mimeType: string;
};

type ExecutorSession = Readonly<{
  ownerId: string;
  generation: number;
  fence: EffectFence;
}>;

type DeprecatedLeaseProbe = {
  leaseEffects(ownerId: string, generation: number, now: number, limit: number, leaseMs: number): unknown[];
};

function callbackUpdate(
  updateId: number,
  messageId: number,
  data: string,
  callbackId = `callback-${updateId}`,
): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: { id: 7, is_bot: false },
      message: { message_id: messageId, chat: { id: 70, type: "private" } },
      data,
    },
  };
}

function reviewOutput(
  verdict: "pass" | "changes_requested",
  reviewedHeadSha: string,
): string {
  return JSON.stringify({
    verdict,
    reviewedHeadSha,
    summary: verdict === "pass" ? "No actionable findings" : "Fix the bounded finding",
    findings: verdict === "pass" ? [] : [{
      severity: "high",
      file: "src/task.ts",
      line: 7,
      title: "Handle the task boundary",
      details: "The implementation must preserve the exact task boundary.",
    }],
    checks: [],
  });
}

function requireReviewEvent(event: ReviewHandlerEvent | null): ReviewHandlerEvent {
  if (!event) throw new Error("review handler did not emit an event");
  return event;
}

function validationPr(headSha: string, merged: boolean): string {
  return JSON.stringify({
    number: PR_NUMBER,
    url: PR_URL,
    state: merged ? "MERGED" : "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature/telegram",
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    changedFiles: 1,
    additions: 3,
    deletions: 1,
    mergeCommit: merged ? { oid: MERGE_COMMIT } : null,
    mergedAt: merged ? "2026-08-10T00:00:00.000Z" : null,
  });
}

function gateInput(
  job: Job,
  validation: ValidationSnapshot,
  observedRemoteHead: string,
  githubHead: string,
  receipt: GateInput["receipt"],
): GateInput {
  if (!job.policy || !job.projectId || !job.environmentId || job.prNumber === null) {
    throw new Error("gate fixture requires a fully configured job");
  }
  const attempt = job.reviewThreadId;
  if (!attempt) throw new Error("gate fixture requires a review attempt");
  const reviewAttempt = receipt.reviewAttemptId;
  return {
    now: job.updatedAt,
    projectId: job.projectId,
    environmentId: job.environmentId,
    job: {
      id: job.id,
      version: job.version,
      projectId: job.projectId,
      environmentId: job.environmentId,
      prNumber: job.prNumber,
      policy: job.policy,
    },
    environment: {
      id: job.environmentId,
      projectId: job.projectId,
      status: "available",
      worktree: { clean: true, untrackedFiles: [] },
      checkout: {
        kind: "branch",
        branchName: "feature/telegram",
        headSha: observedRemoteHead,
      },
    },
    originRepository: job.policy.githubRepository,
    remoteHead: {
      first: { rows: [`${observedRemoteHead}\trefs/pull/${PR_NUMBER}/head`] },
      second: { rows: [`${observedRemoteHead}\trefs/pull/${PR_NUMBER}/head`] },
    },
    pullRequest: {
      available: true,
      number: job.prNumber,
      state: "OPEN",
      isDraft: false,
      baseRefName: job.policy.baseBranch,
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
    },
    githubPr: {
      number: job.prNumber,
      headRefOid: githubHead,
    },
    review: {
      attemptId: reviewAttempt,
      headSha: job.prHeadSha,
      verdict: "pass",
      findings: [],
      reviewerMutated: false,
    },
    validation: {
      outcome: validation.validationOutcome,
      headSha: validation.headSha,
      completedAt: validation.completedAt,
      requiredChecks: validation.requiredChecks,
    },
    receipt,
  };
}

async function drainEffects(
  store: TelegramAgentStore,
  makeRunner: (fence: EffectFence) => EffectRunner,
  now: () => number,
  session: ExecutorSession,
): Promise<void> {
  for (let pass = 0; pass < 100; pass += 1) {
    if (!store.isExecutorLeaseCurrent(session.ownerId, session.generation, now())) {
      throw new Error("workflow executor lease was lost while draining effects");
    }
    const occupiedAdmissions = store.listAdmissions(["admitted", "draining"], 100);
    const effects = store.leaseControlEffects({
      ownerId: session.ownerId,
      generation: session.generation,
      now: now(),
      limit: 8,
      leaseMs: 1_000_000,
      busyJobIds: occupiedAdmissions.map((admission) => admission.jobId),
    });
    for (const admission of occupiedAdmissions) {
      const next = store.leaseNextJobEffect({
        jobId: admission.jobId,
        ownerId: session.ownerId,
        generation: session.generation,
        now: now(),
        leaseMs: 1_000_000,
      });
      if (next) effects.push(next);
    }
    if (effects.length === 0) return;
    for (const effect of effects) {
      if (!store.renewJobOperationFences({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        ownerId: session.ownerId,
        generation: session.generation,
        now: now(),
        leaseMs: 1_000_000,
      })) throw new Error(`effect fence was lost while draining ${effect.idempotencyKey}`);
      await makeRunner(session.fence).run(effect);
      const settled = store.getEffect(effect.jobId, effect.idempotencyKey);
      if (settled?.status === "leased" && !store.completeEffect(
        effect.idempotencyKey,
        session.ownerId,
        session.generation,
        now(),
      )) {
        throw new Error(`effect did not complete while draining: ${effect.idempotencyKey}`);
      }
    }
  }
  throw new Error("effect drain exceeded its bounded pass count");
}

async function runExecutorOnce(
  store: TelegramAgentStore,
  now: () => number,
  telegram: JobExecutorTelegram,
): Promise<void> {
  const abort = new AbortController();
  let sleepCalls = 0;
  await runJobExecutorService({
    store,
    effectRunner: { run: async () => undefined },
    clock: { now },
    getTelegramClient: () => telegram,
    sleep: async (_milliseconds, signal) => {
      sleepCalls += 1;
      if (sleepCalls === 1) {
        abort.abort();
        return;
      }
      if (signal.aborted) throw signal.reason ?? new Error("executor stopped");
    },
    releaseOnShutdown: true,
  }, abort.signal);
}

describe("Task 12 complete mocked Telegram-to-merge workflow", () => {
  it("proves the full reviewed workflow and durable completion recovery", async () => {
    let time = 1_000;
    const now = () => time;
    const { bb, harness } = createFakePluginHost({ pluginId: "telegram-agent" });
    const store = openStore(bb.storage, bb.storage.kv, now);
    const deprecatedLease = vi.spyOn(store as unknown as DeprecatedLeaseProbe, "leaseEffects");
    const sdk = bb.sdk as unknown as BbPluginApi["sdk"];
    const attachments: AttachmentCall[] = [];
    const spawns: SpawnCall[] = [];
    const forks: unknown[] = [];
    const steering: Array<{ threadId: string; text: string }> = [];
    const terminalCommands: string[] = [];
    const terminalOutputs = new Map<string, string>();
    const threadOutputs = [
      reviewOutput("changes_requested", HEAD_ONE),
      reviewOutput("pass", HEAD_TWO),
      reviewOutput("pass", HEAD_TWO),
      reviewOutput("pass", HEAD_THREE),
      reviewOutput("pass", HEAD_THREE),
    ];
    const mergeCalls: unknown[] = [];
    const sentMessages: Array<{ chatId: string; payload: Record<string, unknown> }> = [];
    const editedMessages: Array<{ chatId: string; messageId: number; payload: Record<string, unknown> }> = [];
    const callbackAnswers: Array<{ callbackId: string; text: string }> = [];
    const gateObservations: Array<{ phase: string; remote: string; github: string }> = [];
    let remoteHead = HEAD_ONE;
    let terminalNumber = 0;
    let threadNumber = 0;
    let merged = false;

    harness.sdk.stub("projects.attachments.upload", async (input: {
      projectId: string;
      filename: string;
      clientFile: Uint8Array;
      mimeType: string;
    }) => {
      attachments.push(input);
      return {
        type: "localFile",
        path: `attachments/${input.filename}`,
        name: input.filename,
        sizeBytes: input.clientFile.byteLength,
        mimeType: input.mimeType,
      };
    });
    harness.sdk.stub("projects.list", async () => [{
      id: "proj_1",
      kind: "standard",
      name: "Cyndra",
      gitRemoteUrl: "https://github.com/acme/cyndra.git",
      createdAt: 1,
      updatedAt: 1,
      sources: [{
        id: "source_1",
        projectId: "proj_1",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
        type: "local_path",
        hostId: "host_project",
        path: "/projects/cyndra",
      }],
    }]);
    harness.sdk.stub("threads.spawn", async (input: SpawnCall) => {
      spawns.push(input);
      threadNumber += 1;
      const role = input.title.includes("review") ? "review"
        : input.title.includes("critique") ? "critique"
        : input.title.includes(" plan ") ? "plan"
        : "implementation";
      return {
        id: `thr_${role}_${threadNumber}`,
        environmentId: "env_telegram_worktree",
      };
    });
    harness.sdk.stub("threads.fork", async (input: unknown) => {
      forks.push(input);
      return { id: "thr_forked" };
    });
    harness.sdk.stub("threads.send", async (input: { threadId: string; input: Array<{ text: string }> }) => {
      steering.push({ threadId: input.threadId, text: input.input[0]?.text ?? "" });
      return { ok: true };
    });
    harness.sdk.stub("threads.output", async () => threadOutputs.shift() ?? "");
    harness.sdk.stub("threads.get", async (input: { threadId: string }) => ({
      id: input.threadId,
      status: "idle",
      updatedAt: time,
      projectId: "proj_1",
      environmentId: "env_telegram_worktree",
      parentThreadId: null,
      title: input.threadId,
      runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    }));
    harness.sdk.stub("environments.status", async () => ({
      outcome: "available",
      available: true,
      clean: true,
      workingTree: { state: "clean", hasUncommittedChanges: false, untrackedFiles: [] },
      checkout: { kind: "branch", branchName: "feature/telegram", headSha: remoteHead },
    }));
    harness.sdk.stub("environments.diff", async () => ({
      outcome: "available",
      diff: { diff: "diff --git a/src/task.ts b/src/task.ts\n+bounded change", truncated: false },
    }));
    harness.sdk.stub("environments.pullRequest", async () => ({
      outcome: "available",
      pullRequest: { number: PR_NUMBER, url: PR_URL },
    }));
    harness.sdk.stub("environments.mergePullRequest", async (input: unknown) => {
      mergeCalls.push(input);
      merged = true;
      return { ok: true };
    });
    harness.sdk.stub("terminals.create", async (input: { start: { command: string } }) => {
      const id = `terminal-${++terminalNumber}`;
      const command = input.start.command;
      terminalCommands.push(command);
      let output = "";
      if (command.includes("git remote get-url origin")) output = "git@github.com:acme/cyndra.git\n";
      else if (command.includes("git ls-remote")) output = `${remoteHead}\trefs/pull/${PR_NUMBER}/head\n`;
      else if (command.includes("gh pr checks")) output = JSON.stringify([{ name: "test", bucket: "pass", state: "SUCCESS", link: null }]);
      else if (command.includes("gh pr view") && command.includes("headRefName")) output = validationPr(remoteHead, false);
      else if (command.includes("gh pr view")) {
        output = JSON.stringify({
          number: PR_NUMBER,
          url: PR_URL,
          state: merged ? "MERGED" : "OPEN",
          mergedAt: merged ? "2026-08-10T00:00:00.000Z" : null,
          mergeCommit: merged ? { oid: MERGE_COMMIT } : null,
        });
      }
      const marker = command.match(/__BB_TELEGRAM_AGENT_RESULT_[0-9a-f]+__/)?.[0];
      if (!marker) throw new Error("terminal command completion marker is missing");
      terminalOutputs.set(id, `${output}\n${marker}:0\n`);
      return { id };
    });
    harness.sdk.stub("terminals.get", async () => ({ status: "running", exitCode: null }));
    harness.sdk.stub("terminals.output", async (input: { terminalId: string }) => ({
      chunks: [{ seq: 0, dataBase64: Buffer.from(terminalOutputs.get(input.terminalId) ?? "").toString("base64") }],
    }));
    harness.sdk.stub("terminals.close", async () => undefined);

    const terminal = new TerminalCommandRunner(sdk);
    const runner = new BbRunner(sdk);
    const validationSnapshots: ValidationSnapshot[] = [];
    const approvals = new ApprovalService(store, {
      now,
      randomBytes: (() => {
        let byte = 10;
        return () => Buffer.alloc(24, byte++);
      })(),
    });
    const approvalIssue = vi.spyOn(approvals, "issue");

    const collectGateInput = vi.fn(async ({
      job,
      phase,
      receipt,
    }: {
      job: Job;
      phase: "approval" | "pre_merge";
      receipt: GateInput["receipt"] | null;
    }): Promise<GateInput> => {
      const current = store.getJob(job.id);
      if (!current) throw new Error("gate job disappeared");
      const validation = validationSnapshots.at(-1);
      if (!validation) throw new Error("validation evidence is missing");
      const expectedHead = current.prHeadSha;
      if (!expectedHead) throw new Error("gate head is missing");
      const observedRemote = phase === "approval" ? expectedHead : remoteHead;
      const githubHead = remoteHead === HEAD_THREE && phase === "pre_merge" ? HEAD_TWO : observedRemote;
      const approvalReceipt = receipt ?? {
        jobId: current.id,
        jobVersion: current.version,
        projectId: current.projectId!,
        environmentId: current.environmentId!,
        prNumber: current.prNumber!,
        baseBranch: current.policy!.baseBranch,
        headSha: expectedHead,
        reviewAttemptId: current.reviewThreadId ? store.getAttemptByThreadId(current.reviewThreadId)!.id : "missing",
        validationCompletedAt: validation.completedAt,
        requiredCheckNames: [...current.policy!.requiredChecks].sort(),
        mergeMethod: current.policy!.mergeMethod,
        expiresAt: new Date(time + 900_000).toISOString(),
      };
      gateObservations.push({ phase, remote: observedRemote, github: githubHead });
      return gateInput(current, validation, observedRemote, githubHead, approvalReceipt);
    });
    const mergeHandler = new MergeHandler({
      store,
      approvals,
      collectGateInput,
      commandRunner: terminal,
      bb: { sdk: { environments: { mergePullRequest: (input) => sdk.environments.mergePullRequest(input) } } },
      now,
    });
    const telegram = {
      sendMessage: vi.fn(async (chatId: string, payload: Record<string, unknown>) => {
        sentMessages.push({ chatId, payload });
        return { message_id: sentMessages.length };
      }),
      editMessage: vi.fn(async (chatId: string, messageId: number, payload: Record<string, unknown>) => {
        editedMessages.push({ chatId, messageId, payload });
      }),
      answerCallback: vi.fn(async (callbackId: string, text: string) => {
        callbackAnswers.push({ callbackId, text });
      }),
    };
    const ingress = new TelegramIngress({ store, telegram, mergeHandler });

    const reviewHandler = new ReviewHandler({
      threads: {
        output: async (threadId) => {
          const output = threadOutputs.shift() ?? "";
          expect(threadId).toContain("review");
          return output;
        },
        send: async (threadId, text) => { steering.push({ threadId, text }); },
        create: async () => ({ id: "unused" }),
      },
      environment: {
        status: async () => {
          const current = store.getJob("e2e-job-000000000000") ?? store.getActiveJob();
          return { available: true, clean: true, headSha: current?.prHeadSha };
        },
      },
      attempts: {
        get: (attemptId) => {
          const attempt = store.getAttempt(attemptId);
          if (!attempt) return {};
          let result: Record<string, unknown> = {};
          if (attempt.resultJson) result = JSON.parse(attempt.resultJson) as Record<string, unknown>;
          return {
            threadId: attempt.threadId,
            headSha: attempt.headSha ?? undefined,
            formatCorrectionSent: result.formatCorrectionSent === true,
            requiresNewHead: result.requiresNewHead === true,
            result: result as never,
          };
        },
        update: (attemptId, patch) => {
          const existing = store.getAttempt(attemptId);
          let result = existing?.resultJson ? JSON.parse(existing.resultJson) as Record<string, unknown> : {};
          if (patch.result !== undefined) result = (patch.result ?? {}) as Record<string, unknown>;
          if (patch.formatCorrectionSent !== undefined) result.formatCorrectionSent = patch.formatCorrectionSent;
          if (patch.requiresNewHead !== undefined) result.requiresNewHead = patch.requiresNewHead;
          store.updateAttempt(attemptId, {
            threadId: patch.threadId,
            headSha: patch.headSha,
            result,
          });
        },
        claimFormatCorrection: (attemptId, threadId, headSha) => store.claimReviewFormatCorrection(attemptId, threadId, headSha),
      },
      emit: (event) => { reviewEvent = event; },
    });
    let reviewEvent: ReviewHandlerEvent | null = null;

    const makeRunner = (fence: EffectFence): EffectRunner => new EffectRunner({
      store,
      fence,
      now,
      approvals,
      bb: {
        spawnPlanner: (job, attempt, previousCritique) => runner.spawnPlanner(job, attempt, previousCritique),
        spawnCritic: (job, attempt, plan) => runner.spawnCritic(job, attempt, plan),
        spawnBuilderFromPlan: (job, attempt, plan) => runner.spawnBuilderFromPlan(job, attempt, plan),
        spawnDocs: (job, attempt) => runner.spawnDocs(job, attempt),
        spawnImplementation: (job, attempt) => runner.spawnImplementation(job, attempt),
        spawnReview: (job, attempt) => runner.spawnReview(job, attempt),
        spawnFinalReview: (job, attempt) => runner.spawnFinalReview(job, attempt),
        sendRemediation: (job, findings) => runner.sendRemediation(job, findings),
        sendSteering: (threadId, text) => runner.sendSteering(threadId, text),
        getEnvironmentSnapshot: (environmentId, baseBranch) => runner.getEnvironmentSnapshot(environmentId, baseBranch),
        getPullRequestSnapshot: (environmentId) => runner.getPullRequestSnapshot(environmentId),
      },
      mergeHandler,
      resolvePrHead: async (job, _effect, signal) => resolvePrHead({
        runner: terminal,
        environments: sdk.environments,
        environmentId: job.environmentId!,
        prNumber: job.prNumber!,
        githubRepository: job.policy!.githubRepository,
        signal,
      }),
      runValidation: async (job, _effect, signal) => {
        const currentReview = job.reviewThreadId ? store.getAttemptByThreadId(job.reviewThreadId) : null;
        const snapshot = await runValidation({
          runner: terminal,
          environments: sdk.environments,
          environmentId: job.environmentId!,
          job: { id: job.id, version: job.version, policy: job.policy!, prNumber: job.prNumber! },
          currentReviewAttempt: currentReview ? { id: currentReview.id } : undefined,
          signal,
        });
        validationSnapshots.push(snapshot);
        return snapshot;
      },
      runProductionStage: (job, _effect, phase, signal, onTerminalObservation) => runProductionStage({
        runner: terminal,
        environmentId: job.environmentId!,
        expectedHeadSha: job.mergeCommitSha!,
        policy: job.policy!,
        phase,
        signal,
        onTerminalObservation,
        now,
      }),
    });

    const policy = policyFixture({ projectId: "proj_1", alias: "cyndra", githubRepository: "acme/cyndra" });
    let executorSession: ExecutorSession;
    const completeDocs = (jobId: string): void => {
      const current = store.getJob(jobId);
      const docsAttempt = store.getLatestPipelineStageAttempt(jobId, "DOCS");
      if (!current || current.state !== "documenting" || !docsAttempt) throw new Error("docs stage was not ready");
      const report = buildDocsReportArtifact("# Documentation gate\n\nNo documentation change was necessary; existing docs remain accurate. Checks passed.\n");
      expect(store.completePipelineStageAttempt({
        id: docsAttempt.id,
        outputText: new TextDecoder().decode(report.bytes),
        outputSha256: report.sha256,
        outcome: { verdict: "success" },
        ownerId: executorSession.ownerId,
        generation: executorSession.generation,
        now: time,
      })).toBe(true);
      store.applyJobEvent(jobId, current.version, { type: "DOCS_IDLE" }, ++time);
    };
    store.createPairingCode(hashSecret("one-use-pairing-code"), time, time + 600_000);
    await ingress.handleClaimed({ update_id: 1, message: privateMessage("/start one-use-pairing-code") } as TelegramUpdate, ++time);
    expect(store.getOwner()).toMatchObject({ userId: "7", chatId: "70" });

    store.upsertProjectPolicy(policy, ++time);
    await ingress.handleClaimed({ update_id: 2, message: privateMessage("Implement the bounded Telegram task") } as TelegramUpdate, ++time);
    const controller = store.getControllerForOwner("7", "70");
    if (!controller) throw new Error("task did not create a controller mapping");
    const controllerLease = store.acquireExecutorLease("controller-setup", ++time, 1_000_000);
    if (!controllerLease.acquired) throw new Error("controller setup lease was not acquired");
    const controllerTurn = store.claimNextControllerTurn({
      ownerId: "controller-setup",
      generation: controllerLease.generation,
      now: time,
    });
    if (!controllerTurn) throw new Error("controller turn was not claimable");
    expect(store.reserveControllerSpawn({
      controllerKey: controllerTurn.controllerKey,
      turnId: controllerTurn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
      now: time,
    })).toBe(true);
    expect(store.markControllerSpawned({
      turnId: controllerTurn.id,
      ownerId: "controller-setup",
      generation: controllerLease.generation,
      now: time,
      projectId: "proj_personal",
      hostId: "host_personal",
      threadId: "thr_controller",
      spawnToken: controllerTurn.id,
    })).toBe(true);
    expect(store.markControllerTurnSubmitted({
      turnId: controllerTurn.id,
      ownerId: "controller-setup",
      generation: controllerLease.generation,
      now: time,
    })).toBe(true);
    const controllerPlaceholder = store.leaseOutbox(
      "controller-setup",
      controllerLease.generation,
      time,
      10,
      1_000_000,
    ).find((entry) => entry.logicalKey === `controller:${controllerTurn.id}:reply`);
    if (!controllerPlaceholder) throw new Error("controller placeholder was not queued");
    expect(store.completeOutbox(
      controllerPlaceholder.logicalKey,
      "controller-setup",
      controllerLease.generation,
      899,
      time,
    )).toBe(true);
    expect(store.releaseExecutorLease("controller-setup", controllerLease.generation, ++time)).toBe(true);
    let job = store.createConfirmedControllerJob({
      controllerThreadId: "thr_controller",
      projectId: "proj_1",
      task: "Implement the bounded Telegram task",
      now: ++time,
    });
    const status = await telegram.sendMessage("70", { text: "Job started." });
    job = store.setJobStatusMessage(job.id, status.message_id, job.version, ++time);
    const statusMessageId = status.message_id;
    expect(job.state).toBe("awaiting_confirmation");
    const workflowLease = store.acquireExecutorLease("workflow-executor", ++time, 1_000_000);
    if (!workflowLease.acquired) throw new Error("workflow executor lease was not acquired");
    executorSession = {
      ownerId: "workflow-executor",
      generation: workflowLease.generation,
      fence: {
        ownerId: "workflow-executor",
        generation: workflowLease.generation,
        signal: new AbortController().signal,
      },
    };
    const admission = store.tryAdmit({
      jobId: job.id,
      maxConcurrentJobs: 1,
      ownerId: executorSession.ownerId,
      generation: executorSession.generation,
      now: ++time,
      leaseMs: 1_000_000,
    });
    expect(admission.outcome).toBe("admitted");
    job = store.getJob(job.id)!;
    expect(job.state).toBe("planning");
    expect(store.getAdmission(job.id)?.state).toBe("admitted");
    expect(store.listHeldResourceClaims(job.id, 10)).toMatchObject([{
      ownerId: executorSession.ownerId,
      generation: executorSession.generation,
      state: "held",
    }]);

    await drainEffects(store, makeRunner, now, executorSession);
    let stage = store.getLatestPipelineStageAttempt(job.id, "PLAN");
    if (!stage) throw new Error("planner stage was not created");
    const planArtifact = buildPlanArtifact("# Plan\n\n1. Implement the bounded change.\n2. Run the configured checks.\n");
    expect(store.completePipelineStageAttempt({
      id: stage.id,
      outputText: new TextDecoder().decode(planArtifact.bytes),
      outputSha256: planArtifact.sha256,
      outcome: { verdict: "success" },
      ownerId: executorSession.ownerId,
      generation: executorSession.generation,
      now: time,
    })).toBe(true);
    job = store.getJob(job.id)!;
    store.applyJobEvent(job.id, job.version, { type: "PLAN_READY", attemptId: stage.id }, ++time);

    await drainEffects(store, makeRunner, now, executorSession);
    stage = store.getLatestPipelineStageAttempt(job.id, "CRITIQUE");
    if (!stage) throw new Error("critique stage was not created");
    const critiqueArtifact = buildCritiqueArtifact({ verdict: "pass", summary: "The plan is complete and testable" });
    expect(store.completePipelineStageAttempt({
      id: stage.id,
      outputText: new TextDecoder().decode(critiqueArtifact.bytes),
      outputSha256: critiqueArtifact.sha256,
      outcome: { verdict: "pass", summary: "The plan is complete and testable" },
      ownerId: executorSession.ownerId,
      generation: executorSession.generation,
      now: time,
    })).toBe(true);
    job = store.getJob(job.id)!;
    store.applyJobEvent(job.id, job.version, { type: "CRITIQUE_PASSED", attemptId: stage.id }, ++time);

    await drainEffects(store, makeRunner, now, executorSession);
    job = store.getJob(job.id)!;
    expect(job.state).toBe("implementing");
    expect(job.environmentId).toBe("env_telegram_worktree");
    expect(job.implementationThreadId).toContain("implementation");

    store.applyJobEvent(job.id, job.version, { type: "IMPLEMENTATION_IDLE" }, ++time);
    await drainEffects(store, makeRunner, now, executorSession);
    job = store.getJob(job.id)!;
    expect(job.state).toBe("reviewing");
    expect(job.prNumber).toBe(PR_NUMBER);
    expect(job.prHeadSha).toBe(HEAD_ONE);
    const firstReviewThread = job.reviewThreadId;
    if (!firstReviewThread) throw new Error("first review thread was not spawned");

    const firstAttempt = store.getAttemptByThreadId(firstReviewThread);
    if (!firstAttempt) throw new Error("first review attempt was not persisted");
    reviewEvent = null;
    await reviewHandler.handleThreadIdle({
      attemptId: firstAttempt.id,
      reviewThreadId: firstReviewThread,
      implementationThreadId: job.implementationThreadId!,
      expectedSha: HEAD_ONE,
    });
    expect(requireReviewEvent(reviewEvent).type).toBe("REVIEW_CHANGES_REQUESTED");
    store.applyJobEvent(job.id, job.version, {
      type: "REVIEW_CHANGES_REQUESTED",
      headSha: HEAD_ONE,
      summary: "Fix the bounded finding",
    }, ++time);
    await drainEffects(store, makeRunner, now, executorSession);
    expect(store.getJob(job.id)?.state).toBe("implementing");
    const implementationThreadId = job.implementationThreadId;
    if (!implementationThreadId) throw new Error("implementation thread was lost during remediation");
    expect(steering.some((entry) => entry.threadId === implementationThreadId)).toBe(true);

    remoteHead = HEAD_TWO;
    job = store.getJob(job.id)!;
    store.applyJobEvent(job.id, job.version, { type: "IMPLEMENTATION_IDLE" }, ++time);
    await drainEffects(store, makeRunner, now, executorSession);
    job = store.getJob(job.id)!;
    expect(job.state).toBe("reviewing");
    expect(job.prHeadSha).toBe(HEAD_TWO);
    const secondReviewThread = job.reviewThreadId!;
    const secondAttempt = store.getAttemptByThreadId(secondReviewThread)!;
    reviewEvent = null;
    await reviewHandler.handleThreadIdle({
      attemptId: secondAttempt.id,
      reviewThreadId: secondReviewThread,
      implementationThreadId: job.implementationThreadId!,
      expectedSha: HEAD_TWO,
    });
    expect(requireReviewEvent(reviewEvent).type).toBe("REVIEW_PASSED");
    store.applyJobEvent(job.id, job.version, { type: "REVIEW_PASSED", headSha: HEAD_TWO }, ++time);
    await drainEffects(store, makeRunner, now, executorSession);
    completeDocs(job.id);
    await drainEffects(store, makeRunner, now, executorSession);
    job = store.getJob(job.id)!;
    expect(job.state).toBe("final_reviewing");
    const firstFinalReviewThread = job.reviewThreadId!;
    const firstFinalAttempt = store.getAttemptByThreadId(firstFinalReviewThread)!;
    reviewEvent = null;
    await reviewHandler.handleThreadIdle({
      attemptId: firstFinalAttempt.id,
      reviewThreadId: firstFinalReviewThread,
      implementationThreadId: job.implementationThreadId!,
      expectedSha: HEAD_TWO,
    });
    expect(requireReviewEvent(reviewEvent).type).toBe("REVIEW_PASSED");
    store.applyJobEvent(job.id, job.version, { type: "REVIEW_PASSED", headSha: HEAD_TWO }, ++time);
    await drainEffects(store, makeRunner, now, executorSession);
    job = store.getJob(job.id)!;
    expect(job.state).toBe("awaiting_merge_approval");
    expect(approvalIssue).toHaveBeenCalledTimes(1);
    expect(store.listHeldResourceClaims(job.id, 10).filter((claim) =>
      claim.resourceKind === "repository_merge" || claim.resourceKind === "production_target",
    )).toHaveLength(0);
    const firstApproval = approvalIssue.mock.results[0]?.value as { nonce: string };

    remoteHead = HEAD_THREE;
    await ingress.handleClaimed(
      callbackUpdate(5, statusMessageId, encodeCallbackData({ type: "merge", nonce: firstApproval.nonce }), "merge-stale"),
      ++time,
    );
    expect(store.getJob(job.id)?.state).toBe("merging");
    await drainEffects(store, makeRunner, now, executorSession);
    job = store.getJob(job.id)!;
    expect(mergeCalls).toHaveLength(0);
    expect(gateObservations).toContainEqual({ phase: "pre_merge", remote: HEAD_THREE, github: HEAD_TWO });
    expect(job.state).toBe("reviewing");

    await drainEffects(store, makeRunner, now, executorSession);
    job = store.getJob(job.id)!;
    expect(job.state).toBe("reviewing");
    expect(job.prHeadSha).toBe(HEAD_THREE);
    const thirdReviewThread = job.reviewThreadId!;
    const thirdAttempt = store.getAttemptByThreadId(thirdReviewThread)!;
    reviewEvent = null;
    await reviewHandler.handleThreadIdle({
      attemptId: thirdAttempt.id,
      reviewThreadId: thirdReviewThread,
      implementationThreadId: job.implementationThreadId!,
      expectedSha: HEAD_THREE,
    });
    expect(requireReviewEvent(reviewEvent).type).toBe("REVIEW_PASSED");
    store.applyJobEvent(job.id, job.version, { type: "REVIEW_PASSED", headSha: HEAD_THREE }, ++time);
    await drainEffects(store, makeRunner, now, executorSession);
    completeDocs(job.id);
    await drainEffects(store, makeRunner, now, executorSession);
    job = store.getJob(job.id)!;
    expect(job.state).toBe("final_reviewing");
    const secondFinalReviewThread = job.reviewThreadId!;
    const secondFinalAttempt = store.getAttemptByThreadId(secondFinalReviewThread)!;
    reviewEvent = null;
    await reviewHandler.handleThreadIdle({
      attemptId: secondFinalAttempt.id,
      reviewThreadId: secondFinalReviewThread,
      implementationThreadId: job.implementationThreadId!,
      expectedSha: HEAD_THREE,
    });
    expect(requireReviewEvent(reviewEvent).type).toBe("REVIEW_PASSED");
    store.applyJobEvent(job.id, job.version, { type: "REVIEW_PASSED", headSha: HEAD_THREE }, ++time);
    await drainEffects(store, makeRunner, now, executorSession);
    job = store.getJob(job.id)!;
    expect(job.state).toBe("awaiting_merge_approval");
    expect(approvalIssue).toHaveBeenCalledTimes(2);
    const secondApproval = approvalIssue.mock.results[1]?.value as { nonce: string };

    await ingress.handleClaimed(
      callbackUpdate(6, statusMessageId, encodeCallbackData({ type: "merge", nonce: secondApproval.nonce }), "merge-fresh"),
      ++time,
    );
    const mergeEffect = store.listEffectsForJob(job.id).find((effect) => effect.kind === "merge_pr" && effect.status === "pending");
    if (!mergeEffect) throw new Error("fresh merge effect is missing");
    const leased = store.leaseNextJobEffect({
      jobId: job.id,
      ownerId: executorSession.ownerId,
      generation: executorSession.generation,
      now: now(),
      leaseMs: 1_000_000,
    });
    if (!leased) throw new Error("fresh merge effect was not leased by the winning executor");
    expect(leased.idempotencyKey).toBe(mergeEffect.idempotencyKey);
    expect(store.renewJobOperationFences({
      jobId: leased.jobId,
      effectIdempotencyKey: leased.idempotencyKey,
      ownerId: executorSession.ownerId,
      generation: executorSession.generation,
      now: now(),
      leaseMs: 1_000_000,
    })).toBe(true);
    await makeRunner(executorSession.fence).run(leased);
    expect(mergeCalls).toHaveLength(1);
    expect(store.getEffect(leased.jobId, leased.idempotencyKey)?.status).toBe("done");
    await drainEffects(store, makeRunner, now, executorSession);
    expect(store.getJob(job.id)).toMatchObject({
      state: "complete",
      mergeCommitSha: MERGE_COMMIT,
      deploymentSummary: `1/1 production deploy commands passed at ${MERGE_COMMIT.slice(0, 12)}`,
      canarySummary: `1/1 production canary commands passed at ${MERGE_COMMIT.slice(0, 12)}`,
    });
    expect(deprecatedLease).not.toHaveBeenCalled();
    expect(store.getAdmission(job.id)?.state).toBe("draining");
    expect(store.listHeldResourceClaims(job.id, 10).filter((claim) => claim.state === "held")).toMatchObject([{
      ownerId: executorSession.ownerId,
      generation: executorSession.generation,
      state: "held",
    }]);
    const terminalLiveness = store.getWorkerLiveness(job.id);
    if (!terminalLiveness) throw new Error("terminal worker liveness is missing");
    expect(store.upsertExecutorWorkerLiveness({
      value: { ...terminalLiveness, state: "idle", observedAt: ++time },
      ownerId: executorSession.ownerId,
      generation: executorSession.generation,
      now: time,
    })).toBe(true);
    expect(store.beginDraining({
      jobId: job.id,
      ownerId: executorSession.ownerId,
      generation: executorSession.generation,
      now: ++time,
    })).toMatchObject({ id: job.id, state: "complete" });
    const releaseResult = store.finalizeRelease({
      jobId: job.id,
      ownerId: executorSession.ownerId,
      generation: executorSession.generation,
      now: ++time,
    });
    expect(releaseResult).toMatchObject({ outcome: "released" });
    expect(store.getAdmission(job.id)?.state).toBe("released");
    expect(store.listHeldResourceClaims(job.id, 10).filter((claim) => claim.state === "held")).toHaveLength(0);
    expect(store.releaseExecutorLease(executorSession.ownerId, executorSession.generation, ++time)).toBe(true);

    let deliveryFailures = 1;
    const delivered: Array<Record<string, unknown>> = [];
    const failDelivery = (payload: Record<string, unknown>): void => {
      if (deliveryFailures > 0) {
        deliveryFailures -= 1;
        throw new Error("Telegram completion delivery unavailable");
      }
      delivered.push(payload);
    };
    const completionTelegram: JobExecutorTelegram = {
      sendMessage: async (_chatId, payload) => {
        failDelivery(payload);
        return { message_id: 900 };
      },
      editMessage: async (_chatId, _messageId, payload) => failDelivery(payload),
      answerCallback: async () => undefined,
    };
    await runExecutorOnce(store, now, completionTelegram);
    expect(store.getAdmission(job.id)?.state).toBe("released");
    expect(store.listOutbox(20).map((item) => ({ key: item.logicalKey, status: item.status, nextAttemptAt: item.nextAttemptAt }))).toContainEqual(
      expect.objectContaining({ status: "failed" }),
    );
    time += 5_000;
    await runExecutorOnce(store, now, completionTelegram);
    expect(delivered).toHaveLength(1);
    expect(store.getAdmission(job.id)?.state).toBe("released");
    expect(store.listOutbox(20).some((item) => item.status === "sent")).toBe(true);
    expect(mergeCalls).toHaveLength(1);

    const attempts = bb.storage.database().prepare(
      "SELECT id, ordinal, thread_id, head_sha, handoff_sha256 FROM attempts WHERE job_id = ? AND kind = 'review' ORDER BY created_at, id",
    ).all(job.id) as Array<{ id: string; ordinal: number; thread_id: string; head_sha: string; handoff_sha256: string }>;
    expect(attempts).toHaveLength(5);
    expect(attempts.map((attempt) => attempt.head_sha)).toEqual([HEAD_ONE, HEAD_TWO, HEAD_TWO, HEAD_THREE, HEAD_THREE]);
    expect(new Set(attempts.map((attempt) => attempt.thread_id)).size).toBe(5);
    expect(attempts.every((attempt) => /^[0-9a-f]{64}$/.test(attempt.handoff_sha256))).toBe(true);
    expect(attachments).toHaveLength(15);
    expect(attachments.map((item) => item.filename)).toEqual([
      "work-order.md",
      "work-order.md",
      "plan.md",
      "critique-packet.json",
      "work-order.md",
      "plan.md",
      "review-packet.json",
      "review-packet.json",
      "work-order.md",
      "docs-packet.json",
      "review-packet.json",
      "review-packet.json",
      "work-order.md",
      "docs-packet.json",
      "review-packet.json",
    ]);
    expect(attachments.every((item) => item.projectId === "proj_1")).toBe(true);
    expect(attachments.every((item) => createHash("sha256").update(item.clientFile).digest("hex").length === 64)).toBe(true);
    expect(spawns.every((spawn) => spawn.visibility === "visible")).toBe(true);
    expect(spawns.filter((spawn) => spawn.title.includes("review")).every((spawn) => (
      spawn.parentThreadId === job.implementationThreadId &&
      (spawn.environment as { type?: string; environmentId?: string }).type === "reuse" &&
      (spawn.environment as { type?: string; environmentId?: string }).environmentId === "env_telegram_worktree"
    ))).toBe(true);
    expect(forks).toHaveLength(0);
    expect(terminalCommands.filter((command) => command.includes("git ls-remote --exit-code origin refs/pull/17/head")).length).toBeGreaterThanOrEqual(6);
    expect(terminalCommands.some((command) => command.includes("./scripts/deploy-production.sh"))).toBe(true);
    expect(terminalCommands.some((command) => command.includes("./scripts/verify-production.sh"))).toBe(true);
    expect(store.getLatestPipelineStageAttempt(job.id, "DEPLOY")).toMatchObject({ state: "completed" });
    expect(store.getLatestPipelineStageAttempt(job.id, "CANARY")).toMatchObject({ state: "completed" });
    expect(store.getJob(job.id)?.prHeadSha).toBe(HEAD_THREE);
    expect(store.getJob(job.id)?.state).toBe("complete");
  });
});
