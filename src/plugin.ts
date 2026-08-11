import type { BbPluginApi } from "@bb/plugin-sdk";
import { controllerExecutionProfile, parseGlobalConfig } from "./config";
import { BbRunner } from "./bb/runner";
import { resolvePrHead, runValidation } from "./bb/validation";
import { TerminalCommandRunner } from "./bb/terminal-command";
import { TelegramClient } from "./telegram/client";
import { TelegramIngress } from "./telegram/ingress";
import { openStore, type TelegramAgentStore } from "./storage/store";
import { AutonomyRepository } from "./storage/autonomy-repository";
import { DEFAULT_MAX_CONCURRENT_JOBS } from "./autonomy/models";
import { AutonomyScheduler } from "./autonomy/scheduler";
import { EffectRunner } from "./services/effect-runner";
import type { EffectFence } from "./services/effect-runner";
import { runJobExecutorService } from "./services/job-executor-service";
import { createTask9FreshGateCollector, MergeHandler } from "./services/merge-handler";
import type { GateInput } from "./domain/gates";
import type { ReviewFinding } from "./domain/models";
import {
  ReviewHandler,
  ReviewInvocationStaleError,
  type ReviewAttemptLookup,
  type ReviewAttemptUpdate,
  type ReviewFormatCorrectionClaim,
  type ReviewEnvironmentStatusInput,
  type ReviewInvocation,
  type ReviewHandlerCompletion,
} from "./services/review-handler";
import { runTelegramService } from "./services/telegram-service";
import {
  projectUnknownWorker,
  projectTerminalLiveness,
  projectWorkerLiveness,
  workerRegistrationGeneration,
} from "./services/worker-liveness";
import { runTelegramAgentCli } from "./cli";
import { ExecutorNudge } from "./services/executor-nudge";
import { registerControllerTools } from "./controller/tools";
import { BbControllerAdapter } from "./controller/bb-controller";
import {
  CONTROLLER_MODELS,
  CONTROLLER_PERMISSION_MODES,
  CONTROLLER_REASONING_LEVELS,
  CONTROLLER_SERVICE_TIERS,
  DEFAULT_CONTROLLER_EXECUTION_PROFILE,
} from "./controller/execution-profile";
import { LunaControllerService } from "./controller/service";
import { TelegramPresenceCoordinator } from "./services/telegram-presence";
import { JobLaneSnapshotProvider } from "./services/job-lane-runner";
import { MonitorService } from "./services/monitor-service";
import { ThreadNoticeService } from "./services/thread-notice-service";
import { buildHealthReport } from "./services/health-report";
import { ThreadOperationService } from "./controller/operations";
import { settlePipelineStageOutput } from "./services/pipeline-stage-runner";
import { runProductionStage } from "./services/production-runner";

function clock(): number {
  return Date.now();
}

export async function createPlugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    botToken: { type: "string", label: "Telegram bot token", secret: true },
    bbAppBaseUrl: { type: "string", label: "BB app base URL", default: "" },
    maxConcurrentJobs: {
      type: "select",
      label: "Maximum concurrent jobs",
      description: "Independent projects may run together; each project remains serialized.",
      options: ["1", "2", "3", "4", "5", "6", "7", "8"],
      default: String(DEFAULT_MAX_CONCURRENT_JOBS),
    },
    controllerModel: {
      type: "select",
      label: "Controller model",
      description: "Model for Telegram conversation turns. Claude models run on Claude Code, gpt models on Codex. Job workers remain project-controlled.",
      options: [...CONTROLLER_MODELS],
      default: DEFAULT_CONTROLLER_EXECUTION_PROFILE.model,
    },
    controllerReasoningLevel: {
      type: "select",
      label: "Controller reasoning level",
      description: "Reasoning effort for subsequent Telegram conversation turns.",
      options: [...CONTROLLER_REASONING_LEVELS],
      default: DEFAULT_CONTROLLER_EXECUTION_PROFILE.reasoningLevel,
    },
    controllerServiceTier: {
      type: "select",
      label: "Controller service tier",
      description: "Codex only. Fast prioritizes latency; default uses the provider's standard tier. Ignored by Claude models.",
      options: [...CONTROLLER_SERVICE_TIERS],
      default: DEFAULT_CONTROLLER_EXECUTION_PROFILE.serviceTier,
    },
    controllerPermissionMode: {
      type: "select",
      label: "Controller permission mode",
      description: "BB and the execution machine still enforce their permission limits.",
      options: [...CONTROLLER_PERMISSION_MODES],
      default: DEFAULT_CONTROLLER_EXECUTION_PROFILE.permissionMode,
    },
  });
  const store = openStore(bb.storage);
  const scheduler = new AutonomyScheduler(new AutonomyRepository(bb.storage.database()));
  const executorNudge = new ExecutorNudge();
  const laneSnapshots = new JobLaneSnapshotProvider();
  let config = parseGlobalConfig(await settings.get());
  if (!config.ok) bb.status.needsConfiguration(config.message);

  settings.onChange((next) => {
    const parsed = parseGlobalConfig(next);
    config = parsed;
    if (!parsed.ok) bb.status.needsConfiguration(parsed.message);
    executorNudge.notify();
  });

  const telegramForToken = (token: string): TelegramClient => new TelegramClient(token);
  const telegramTransport = {
    sendMessage: (chatId: string, payload: Parameters<TelegramClient["sendMessage"]>[1]) => {
      if (!config.ok) throw new Error(config.message);
      return telegramForToken(config.value.botToken).sendMessage(chatId, payload);
    },
    editMessage: (chatId: string, messageId: number, payload: Parameters<TelegramClient["editMessage"]>[2]) => {
      if (!config.ok) throw new Error(config.message);
      return telegramForToken(config.value.botToken).editMessage(chatId, messageId, payload);
    },
    answerCallback: (callbackQueryId: string, text: string) => {
      if (!config.ok) throw new Error(config.message);
      return telegramForToken(config.value.botToken).answerCallback(callbackQueryId, text);
    },
  };
  const threadOperations = new ThreadOperationService({
    store,
    sdk: bb.sdk,
    telegram: telegramTransport,
    pluginId: bb.pluginId,
    clock: { now: clock },
  });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations,
    health: (now) => buildHealthReport(
      bb.storage.database(),
      now,
      config.ok ? config.value.maxConcurrentJobs : null,
      laneSnapshots.snapshot(),
    ),
    notify: () => executorNudge.notify(),
    now: clock,
  });

  const terminal = new TerminalCommandRunner(bb.sdk);
  bb.cli.register({
    name: "telegram-agent",
    summary: "Pair Telegram and manage reviewed BB implementation jobs",
    commands: [
      { name: "pair", summary: "Create a one-use Telegram pairing link", usage: "bb telegram-agent pair [--json]" },
      { name: "unpair", summary: "Revoke the Telegram owner and approvals", usage: "bb telegram-agent unpair [--json]" },
      { name: "project", summary: "Manage enabled BB project policies", usage: "bb telegram-agent project <list|enable|disable> ... [--production-target-key <key>]" },
      { name: "job", summary: "Inspect, retry, or cancel jobs", usage: "bb telegram-agent job <list|show|retry|cancel> ..." },
      { name: "doctor", summary: "Check Telegram, BB, host, provider, and GitHub readiness", usage: "bb telegram-agent doctor [project-id] [--json]" },
    ],
    run: (argv, context) => runTelegramAgentCli({
      store,
      sdk: bb.sdk,
      terminal,
      now: clock,
      getBotToken: () => config.ok ? config.value.botToken : undefined,
      createTelegramClient: (token) => telegramForToken(token),
      revokeAllApprovals: (now) => {
        const db = bb.storage.database();
        const revoke = db.transaction(() => {
          const result = db
            .prepare(
              `UPDATE approvals
                  SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
                WHERE outcome IS NULL OR outcome = 'accepted'`,
            )
            .run(now);
          db.prepare("DELETE FROM pairing_codes").run();
          return result.changes;
        });
        return revoke();
      },
    }, argv, context),
  });
  const bbRunner = new BbRunner(bb.sdk);
  const createReviewHandler = (
    invocation: ReviewInvocation,
    expectedVersion: number,
    fence: EffectFence,
  ): ReviewHandler => {
    const reviewJobMatches = (): boolean => {
      const current = store.getJob(invocation.jobId);
      return current !== null && current.id === invocation.jobId && current.version === expectedVersion &&
        (current.state === "reviewing" || current.state === "final_reviewing") &&
        current.environmentId === invocation.environmentId && current.prHeadSha === invocation.expectedSha &&
        current.reviewThreadId === invocation.reviewThreadId &&
        current.implementationThreadId === invocation.implementationThreadId;
    };
    const reviewAttemptMatches = (): boolean => {
      const attempt = store.getAttempt(invocation.attemptId);
      return attempt !== null && attempt.jobId === invocation.jobId && attempt.kind === "review" &&
        attempt.threadId === invocation.reviewThreadId && attempt.headSha === invocation.expectedSha;
    };
    const isCurrent = (): boolean => !invocation.signal.aborted && !fence.signal.aborted &&
      store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, clock()) &&
      reviewJobMatches() && reviewAttemptMatches();
    const assertCurrent = (): void => {
      if (!isCurrent()) throw new ReviewInvocationStaleError("review invocation identity or fence changed");
    };
    const readAttemptResult = (resultJson: string | null): Record<string, unknown> | null => {
      if (resultJson === null) return null;
      try {
        const parsed = JSON.parse(resultJson);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      } catch {
        return null;
      }
    };
    return new ReviewHandler({
      threads: {
        output: async (threadId) => {
          assertCurrent();
          if (threadId !== invocation.reviewThreadId) throw new ReviewInvocationStaleError("review thread identity changed");
          const output = await bb.sdk.threads.output({ threadId });
          assertCurrent();
          return output;
        },
        send: async (threadId, prompt) => {
          assertCurrent();
          if (threadId !== invocation.reviewThreadId) throw new ReviewInvocationStaleError("review thread identity changed");
          await bbRunner.sendSteering(threadId, prompt);
          assertCurrent();
        },
        create: async () => {
          throw new Error("review cycle creation belongs to the leased review effect");
        },
      },
      environment: {
        status: async (input: ReviewEnvironmentStatusInput) => {
          assertCurrent();
          if (input.environmentId !== invocation.environmentId || input.mergeBaseBranch !== invocation.mergeBaseBranch) {
            throw new ReviewInvocationStaleError("review environment identity changed");
          }
          const value = await bb.sdk.environments.status({
            environmentId: input.environmentId,
            mergeBaseBranch: input.mergeBaseBranch,
          });
          assertCurrent();
          const raw = value as unknown as Record<string, unknown>;
          const workspace = (raw.workspace ?? {}) as Record<string, unknown>;
          const workingTree = (raw.workingTree ?? workspace.workingTree ?? {}) as Record<string, unknown>;
          const checkout = (raw.checkout ?? workspace.checkout ?? {}) as Record<string, unknown>;
          return {
            available: raw.available !== false && raw.outcome !== "unavailable" && raw.outcome !== "not_applicable",
            clean: raw.clean === true || (workingTree.state === "clean" && workingTree.hasUncommittedChanges === false),
            headSha: typeof checkout.headSha === "string" ? checkout.headSha : null,
          };
        },
      },
      attempts: {
        get: ({ jobId, attemptId }: ReviewAttemptLookup) => {
          assertCurrent();
          if (jobId !== invocation.jobId || attemptId !== invocation.attemptId) {
            throw new ReviewInvocationStaleError("review attempt identity changed");
          }
          const attempt = store.getAttempt(attemptId);
          if (!attempt || attempt.jobId !== jobId) throw new ReviewInvocationStaleError("review attempt owner changed");
          const result = readAttemptResult(attempt.resultJson);
          return {
            threadId: attempt.threadId,
            headSha: attempt.headSha ?? undefined,
            formatCorrectionSent: result?.formatCorrectionSent === true,
            requiresNewHead: result?.requiresNewHead === true,
            result: result as never,
          };
        },
        update: ({ jobId, attemptId, patch }: ReviewAttemptUpdate) => {
          assertCurrent();
          if (jobId !== invocation.jobId || attemptId !== invocation.attemptId) {
            throw new ReviewInvocationStaleError("review attempt identity changed");
          }
          const existing = store.getAttempt(attemptId);
          if (!existing || existing.jobId !== jobId) throw new ReviewInvocationStaleError("review attempt owner changed");
          const existingResult = readAttemptResult(existing.resultJson);
          const result = patch.result === undefined
            ? existingResult
            : patch.result === null
              ? null
              : {
                  ...existingResult,
                  ...patch.result,
                  ...(patch.formatCorrectionSent === undefined ? {} : { formatCorrectionSent: patch.formatCorrectionSent }),
                  ...(patch.requiresNewHead === undefined ? {} : { requiresNewHead: patch.requiresNewHead }),
                };
          const updated = store.updateExecutorAttempt({
            jobId,
            attemptId,
            patch: {
              threadId: patch.threadId,
              headSha: patch.headSha,
              result: result as Record<string, unknown> | null,
            },
            ownerId: fence.ownerId,
            generation: fence.generation,
            now: clock(),
          });
          if (!updated) {
            if (!isCurrent()) throw new ReviewInvocationStaleError("review attempt identity or fence changed before persistence");
            throw new ReviewInvocationStaleError("review attempt changed before persistence");
          }
          if (updated.jobId !== jobId) throw new ReviewInvocationStaleError("review attempt owner changed");
        },
        claimFormatCorrection: ({ jobId, attemptId, threadId, headSha }: ReviewFormatCorrectionClaim) => {
          assertCurrent();
          if (jobId !== invocation.jobId || attemptId !== invocation.attemptId || threadId !== invocation.reviewThreadId || headSha !== invocation.expectedSha) {
            throw new ReviewInvocationStaleError("review correction identity changed");
          }
          const claimed = store.claimExecutorReviewFormatCorrection({
            jobId,
            attemptId,
            threadId,
            headSha,
            ownerId: fence.ownerId,
            generation: fence.generation,
            now: clock(),
          });
          if (!claimed && !isCurrent()) throw new ReviewInvocationStaleError("review correction identity or fence changed before claim");
          return claimed;
        },
      },
    });
  };
  const collectGateInput = createTask9FreshGateCollector({
    validation: { runner: terminal, environments: bb.sdk.environments },
    runValidation: (input) => runValidation({
      runner: terminal,
      environments: bb.sdk.environments,
      environmentId: input.environmentId,
      job: input.job,
      currentReviewAttempt: store.getJob(input.job.id)?.reviewThreadId
        ? (() => {
            const reviewThreadId = store.getJob(input.job.id)?.reviewThreadId;
            const attempt = reviewThreadId ? store.getAttemptByThreadId(reviewThreadId) : null;
            return attempt ? { id: attempt.id } : undefined;
          })()
        : undefined,
      signal: input.signal,
      onTerminalObservation: (observation) => {
        if (input.signal?.aborted) return;
        const current = store.getJob(input.job.id);
        if (current) projectTerminalLiveness(store, current, observation, "validation", clock(), undefined, input.fence);
      },
    }),
    getContext: async ({ job, receipt, validation, approvalExpiresAt }): Promise<{
      environment: GateInput["environment"];
      review: GateInput["review"];
      receipt: GateInput["receipt"];
    }> => {
      if (!job.environmentId || !job.projectId || !job.policy || job.prNumber === null) {
        throw new TypeError("Merge gate collection requires a fully configured job");
      }
      const rawStatus = await bb.sdk.environments.status({
        environmentId: job.environmentId,
        mergeBaseBranch: job.policy.baseBranch,
      }) as unknown as Record<string, unknown>;
      const workspace = (rawStatus.workspace ?? {}) as Record<string, unknown>;
      const workingTree = (rawStatus.workingTree ?? workspace.workingTree ?? {}) as Record<string, unknown>;
      const checkout = (rawStatus.checkout ?? workspace.checkout ?? {}) as Record<string, unknown>;
      const rawPullRequest = await bb.sdk.environments.pullRequest({ environmentId: job.environmentId });
      const pullRequestRecord = rawPullRequest as unknown as Record<string, unknown>;
      const pullRequest = (pullRequestRecord.pullRequest ?? {}) as Record<string, unknown>;
      const attempt = job.reviewThreadId ? store.getAttemptByThreadId(job.reviewThreadId) : null;
      let attemptResult: Record<string, unknown> = {};
      if (attempt?.resultJson) {
        try {
          const parsed = JSON.parse(attempt.resultJson);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) attemptResult = parsed as Record<string, unknown>;
        } catch {
          attemptResult = {};
        }
      }
      const defaultReceipt = {
        jobId: job.id,
        jobVersion: job.version,
        projectId: job.projectId,
        environmentId: job.environmentId,
        prNumber: job.prNumber,
        baseBranch: job.policy.baseBranch,
        headSha: validation.headSha,
        reviewAttemptId: attempt?.id ?? validation.reviewAttemptId ?? `review:${job.id}`,
        validationCompletedAt: validation.completedAt,
        requiredCheckNames: [...job.policy.requiredChecks].sort(),
        mergeMethod: job.policy.mergeMethod,
        expiresAt: new Date(approvalExpiresAt ?? (typeof validation.completedAt === "string" ? Date.parse(validation.completedAt) + 15 * 60_000 : Date.now() + 15 * 60_000)).toISOString(),
      };
      return {
        environment: {
          id: job.environmentId,
          projectId: job.projectId,
          status: rawStatus.outcome === "available" || rawStatus.status === "available" ? "available" : String(rawStatus.status ?? rawStatus.outcome ?? "unavailable"),
          worktree: {
            clean: rawStatus.clean === true || (workingTree.state === "clean" && workingTree.hasUncommittedChanges === false),
            untrackedFiles: Array.isArray(workingTree.untrackedFiles) ? workingTree.untrackedFiles.filter((item): item is string => typeof item === "string") : [],
          },
          checkout: {
            kind: typeof checkout.kind === "string" ? checkout.kind : "unknown",
            branchName: typeof checkout.branchName === "string" ? checkout.branchName : typeof checkout.branch === "string" ? checkout.branch : undefined,
            headSha: typeof checkout.headSha === "string" ? checkout.headSha : null,
          },
        },
        review: {
          attemptId: attempt?.id ?? validation.reviewAttemptId ?? `review:${job.id}`,
          headSha: typeof attemptResult.reviewedHeadSha === "string" ? attemptResult.reviewedHeadSha : attempt?.headSha ?? null,
          verdict: typeof (attemptResult.verdict as Record<string, unknown> | undefined)?.verdict === "string"
            ? String((attemptResult.verdict as Record<string, unknown>).verdict)
            : typeof attemptResult.outcome === "string" ? attemptResult.outcome : "blocked",
          findings: Array.isArray(attemptResult.findings) ? attemptResult.findings : [],
          reviewerMutated: attemptResult.reviewerMutated === true,
        },
        receipt: receipt ?? defaultReceipt,
      };
    },
  });
  const mergeHandler = new MergeHandler({
    store,
    commandRunner: terminal,
    bb: { sdk: bb.sdk },
    collectGateInput,
  });
  const health = (now: number) => buildHealthReport(
    bb.storage.database(),
    now,
    config.ok ? config.value.maxConcurrentJobs : null,
    laneSnapshots.snapshot(),
  );
  const ingress = new TelegramIngress({
    store,
    telegram: telegramTransport,
    mergeHandler,
    onWorkAvailable: () => executorNudge.notify(),
    health,
  });
  const controller = new LunaControllerService({
    store,
    adapter: new BbControllerAdapter({
      sdk: bb.sdk,
      pluginId: bb.pluginId,
      executionProfile: () => {
        if (!config.ok) throw new Error(config.message);
        return controllerExecutionProfile(config.value);
      },
    }),
    clock: { now: clock },
  });
  const monitors = new MonitorService({
    store,
    threads: {
      status: async (threadId) => {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.deletedAt !== null || thread.archivedAt !== null) return "missing";
        return thread.status;
      },
    },
    clock: { now: clock },
    warn: (message) => bb.log.warn(message),
  });
  const threadNotices = new ThreadNoticeService({
    store,
    threads: {
      listWatchable: async () => {
        const threads = await bb.sdk.threads.list({ includeHidden: false, archived: false, limit: 100 });
        return threads
          .filter((thread) => thread.visibility === "visible" && thread.archivedAt === null && thread.deletedAt === null)
          .map((thread) => ({
            id: thread.id,
            title: thread.title ?? thread.titleFallback ?? "Untitled thread",
            status: thread.status,
            parentThreadId: thread.parentThreadId,
          }));
      },
      interactions: async (threadId) => {
        const pending = await bb.sdk.threads.interactions.list({ threadId });
        return pending.map((interaction) => ({
          id: interaction.id,
          status: interaction.status,
          payload: interaction.payload,
        }));
      },
      resolve: async (threadId, interactionId, resolution) => {
        await bb.sdk.threads.interactions.resolve({
          threadId,
          interactionId,
          resolution: resolution as Parameters<typeof bb.sdk.threads.interactions.resolve>[0]["resolution"],
        });
      },
    },
    clock: { now: clock },
    warn: (message) => bb.log.warn(message),
  });
  const presence = new TelegramPresenceCoordinator({
    store,
    jobLanes: laneSnapshots,
    telegram: {
      sendChatAction: (chatId, action, signal) => {
        if (!config.ok) throw new Error(config.message);
        return telegramForToken(config.value.botToken).sendChatAction(chatId, action, signal);
      },
    },
    warn: (message) => bb.log.warn(message),
  });

  const bbEffectAdapter = {
    spawnPlanner: (job: Parameters<BbRunner["spawnPlanner"]>[0], attempt: Parameters<BbRunner["spawnPlanner"]>[1], previousCritique?: string | null) => bbRunner.spawnPlanner(job, attempt, previousCritique),
    spawnCritic: (job: Parameters<BbRunner["spawnCritic"]>[0], attempt: Parameters<BbRunner["spawnCritic"]>[1], plan: Parameters<BbRunner["spawnCritic"]>[2]) => bbRunner.spawnCritic(job, attempt, plan),
    spawnBuilderFromPlan: (job: Parameters<BbRunner["spawnBuilderFromPlan"]>[0], attempt: Parameters<BbRunner["spawnBuilderFromPlan"]>[1], plan: Parameters<BbRunner["spawnBuilderFromPlan"]>[2]) => bbRunner.spawnBuilderFromPlan(job, attempt, plan),
    spawnDocs: (job: Parameters<BbRunner["spawnDocs"]>[0], attempt: Parameters<BbRunner["spawnDocs"]>[1]) => bbRunner.spawnDocs(job, attempt),
    spawnImplementation: (job: Parameters<BbRunner["spawnImplementation"]>[0], attempt: Parameters<BbRunner["spawnImplementation"]>[1]) => bbRunner.spawnImplementation(job, attempt),
    spawnReview: (job: Parameters<BbRunner["spawnReview"]>[0], attempt: Parameters<BbRunner["spawnReview"]>[1]) => bbRunner.spawnReview(job, attempt),
    spawnFinalReview: (job: Parameters<BbRunner["spawnFinalReview"]>[0], attempt: Parameters<BbRunner["spawnFinalReview"]>[1]) => bbRunner.spawnFinalReview(job, attempt),
    sendRemediation: (
      job: Parameters<BbRunner["sendRemediation"]>[0],
      findings: Parameters<BbRunner["sendRemediation"]>[1],
      reasons?: Parameters<BbRunner["sendRemediation"]>[2],
    ) => bbRunner.sendRemediation(job, findings, reasons),
    sendSteering: (threadId: string, text: string) => bbRunner.sendSteering(threadId, text),
    stopWorker: (worker: Parameters<BbRunner["stopWorker"]>[0]) => bbRunner.stopWorker(worker),
    getThread: (threadId: string) => bbRunner.getThread(threadId),
    getEnvironmentSnapshot: (environmentId: string, baseBranch: string) => bbRunner.getEnvironmentSnapshot(environmentId, baseBranch),
    getPullRequestSnapshot: (environmentId: string) => bbRunner.getPullRequestSnapshot(environmentId),
    sdk: { threads: bb.sdk.threads },
  };
  const reconcileJob = async (
    job: NonNullable<ReturnType<typeof store.getJob>>,
    signal: AbortSignal,
    fence: EffectFence,
  ): Promise<void> => {
    const fenceCurrent = (): boolean => !signal.aborted && !fence.signal.aborted &&
      store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, clock());
    const applyExecutorEvent = (jobId: string, expectedVersion: number, event: Parameters<TelegramAgentStore["applyExecutorJobEvent"]>[0]["event"]): void => {
      const updated = store.applyExecutorJobEvent({
        jobId,
        expectedVersion,
        event,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: clock(),
      });
      if (!updated) throw new Error("executor lease was lost before reconciliation transition");
    };
    if (!fenceCurrent()) return;

    const pipelineRole = job.state === "planning" ? "PLAN" as const
      : job.state === "critiquing" ? "CRITIQUE" as const
      : job.state === "documenting" ? "DOCS" as const
      : null;
    const pipelineAttempt = pipelineRole ? store.getLatestPipelineStageAttempt(job.id, pipelineRole) : null;
    const reviewStage = job.state === "reviewing" || job.state === "final_reviewing";
    const implementationStage = ["creating_implementation", "implementing", "locating_pr", "resolving_pr_head", "remediating"].includes(job.state);
    const resourceId = pipelineAttempt?.threadId ?? (reviewStage ? job.reviewThreadId : implementationStage ? job.implementationThreadId : null);
    if (!resourceId) return;
    const workerKind = pipelineRole === "PLAN" ? "plan" as const
      : pipelineRole === "CRITIQUE" ? "critique" as const
      : pipelineRole === "DOCS" ? "docs" as const
      : reviewStage ? "review" as const
      : "implementation" as const;
    const generation = workerRegistrationGeneration(job, workerKind);
    let thread: Awaited<ReturnType<BbRunner["getThread"]>>;
    try {
      thread = await bbRunner.getThread(resourceId);
    } catch {
      if (!fenceCurrent()) return;
      const current = store.getJob(job.id);
      if (current) projectUnknownWorker(store, current, resourceId, clock(), workerKind, generation, {
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: clock(),
      });
      return;
    }
    if (!fenceCurrent()) return;
    const current = store.getJob(job.id);
    const currentPipelineAttempt = pipelineRole ? store.getLatestPipelineStageAttempt(job.id, pipelineRole) : null;
    const currentResourceId = currentPipelineAttempt?.threadId ?? (reviewStage ? current?.reviewThreadId : current?.implementationThreadId);
    if (!current || current.state !== job.state || currentResourceId !== resourceId) return;
    if (!fenceCurrent()) return;
    const projected = projectWorkerLiveness(store, current, thread, clock(), workerKind, generation, {
      ownerId: fence.ownerId,
      generation: fence.generation,
      now: clock(),
    });
    const failed = thread.status === "error" || thread.runtime.displayStatus === "error";
    if (failed) {
      if (!fenceCurrent()) return;
      if (currentPipelineAttempt) {
        if (!store.failPipelineStageAttempt({
          id: currentPipelineAttempt.id,
          error: `${workerKind} worker thread failed`,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: clock(),
        })) throw new Error("executor lease was lost before pipeline failure persistence");
      }
      const latest = store.getJob(job.id);
      if (latest && latest.cancelRequestedAt === null) {
        applyExecutorEvent(job.id, latest.version, { type: "THREAD_FAILED", workerKind, error: `${workerKind} worker thread failed` });
      }
      return;
    }
    if (projected.state !== "idle") return;

    if (pipelineRole && currentPipelineAttempt) {
      let output: string;
      try {
        output = await bbRunner.getThreadOutput(resourceId);
      } catch {
        if (!fenceCurrent()) return;
        if (!store.failPipelineStageAttempt({
          id: currentPipelineAttempt.id,
          error: `${workerKind} output is unavailable`,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: clock(),
        })) throw new Error("executor lease was lost before pipeline failure persistence");
        const latest = store.getJob(job.id);
        if (latest?.state === job.state) {
          applyExecutorEvent(job.id, latest.version, { type: "FAILED", error: `${workerKind} output is unavailable` });
        }
        return;
      }
      if (!fenceCurrent()) return;
      settlePipelineStageOutput({
        store,
        job: current,
        attempt: currentPipelineAttempt,
        output,
        fence: { ownerId: fence.ownerId, generation: fence.generation },
        now: clock(),
      });
      return;
    }

    if (!reviewStage) {
      if (!fenceCurrent()) return;
      const latest = store.getJob(job.id);
      if (latest && (latest.state === "implementing" || latest.state === "remediating")) {
        applyExecutorEvent(job.id, latest.version, { type: "IMPLEMENTATION_IDLE" });
      }
      return;
    }

    const attempt = store.getAttemptByThreadId(resourceId);
    if (!attempt || !current.implementationThreadId || !current.prHeadSha) {
      if (!fenceCurrent()) return;
      const latest = store.getJob(job.id);
      if (latest) applyExecutorEvent(job.id, latest.version, { type: "REVIEW_BLOCKED", reason: "configuration" });
      return;
    }
    if (attempt.jobId !== current.id || attempt.kind !== "review" || attempt.headSha !== current.prHeadSha) return;
    const invocation: ReviewInvocation = {
      jobId: current.id,
      attemptId: attempt.id,
      reviewThreadId: resourceId,
      implementationThreadId: current.implementationThreadId,
      environmentId: current.environmentId ?? "",
      mergeBaseBranch: current.policy?.baseBranch ?? "",
      expectedSha: current.prHeadSha,
      signal,
    };
    if (!invocation.environmentId || !invocation.mergeBaseBranch || !fenceCurrent()) return;
    const reviewHandler = createReviewHandler(invocation, current.version, fence);
    let completion: ReviewHandlerCompletion;
    try {
      completion = await reviewHandler.handleThreadIdle(invocation);
    } catch (error) {
      if (error instanceof ReviewInvocationStaleError || !fenceCurrent()) return;
      throw error;
    }
    if (!completion.event || !fenceCurrent()) return;
    const latest = store.getJob(invocation.jobId);
    const latestAttempt = store.getAttempt(invocation.attemptId);
    if (!latest || !latestAttempt || latestAttempt.jobId !== invocation.jobId ||
      latestAttempt.threadId !== invocation.reviewThreadId || latestAttempt.headSha !== invocation.expectedSha ||
      latest.id !== invocation.jobId || latest.version !== current.version ||
      (latest.state !== "reviewing" && latest.state !== "final_reviewing") ||
      latest.environmentId !== invocation.environmentId || latest.prHeadSha !== invocation.expectedSha ||
      latest.reviewThreadId !== invocation.reviewThreadId ||
      latest.implementationThreadId !== invocation.implementationThreadId || !fenceCurrent()) return;
    const event = completion.event;
    if (event.type === "REVIEW_PASSED") {
      applyExecutorEvent(job.id, latest.version, { type: "REVIEW_PASSED", headSha: String(event.payload.headSha) });
    } else if (event.type === "REVIEW_CHANGES_REQUESTED") {
      applyExecutorEvent(job.id, latest.version, {
        type: "REVIEW_CHANGES_REQUESTED",
        headSha: typeof event.payload.headSha === "string" ? event.payload.headSha : undefined,
        summary: typeof event.payload.summary === "string" ? event.payload.summary : undefined,
        findings: Array.isArray(event.payload.findings) ? event.payload.findings as ReviewFinding[] : undefined,
        reasons: Array.isArray(event.payload.reasons)
          ? event.payload.reasons.filter((reason): reason is string => typeof reason === "string")
          : undefined,
      });
    } else {
      applyExecutorEvent(job.id, latest.version, { type: "REVIEW_BLOCKED", reason: "configuration" });
    }
  };
  const effectRunnerFactory = (fence: EffectFence) => new EffectRunner({
    store,
    fence,
    now: clock,
    bb: bbEffectAdapter,
    terminal,
    mergeHandler,
    reconcileJob,
    resolvePrHead: async (job, _effect, signal) => {
      if (!job.environmentId || !job.prNumber || !job.policy) {
        return { event: "PR_HEAD_RESOLUTION_FAILED", reason: "PR head resolution requires an active environment" };
      }
      return resolvePrHead({
        runner: terminal,
        environments: bb.sdk.environments,
        environmentId: job.environmentId,
        prNumber: job.prNumber,
        githubRepository: job.policy.githubRepository,
        signal,
      });
    },
    runValidation: async (job, _effect, signal) => {
      if (!job.environmentId || job.prNumber === null || !job.policy) {
        throw new Error("Validation requires an active environment and pull request");
      }
      return runValidation({
        runner: terminal,
        environments: bb.sdk.environments,
        environmentId: job.environmentId,
        job: { id: job.id, version: job.version, policy: job.policy, prNumber: job.prNumber },
        signal,
        onTerminalObservation: (observation) => {
          if (signal.aborted || !store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, clock())) return;
          const current = store.getJob(job.id);
          if (current) projectTerminalLiveness(store, current, observation, "validation", clock(), undefined, {
            ownerId: fence.ownerId,
            generation: fence.generation,
            now: clock(),
          });
        },
      });
    },
    runProductionStage: (job, _effect, phase, signal, onTerminalObservation) => {
      if (!job.environmentId || !job.policy || !job.mergeCommitSha) {
        throw new Error("Production stage requires an active environment, immutable policy, and merge commit");
      }
      return runProductionStage({
        runner: terminal,
        environmentId: job.environmentId,
        expectedHeadSha: job.mergeCommitSha,
        policy: job.policy,
        phase,
        signal,
        onTerminalObservation,
      });
    },
  });

  bb.background.service("telegram-ingress", {
    start: (signal) => runTelegramService({
      store,
      client: telegramForToken,
      ingress,
      getConfig: () => config,
      clock: { now: clock },
      warn: (message) => bb.log.warn(message),
    }, signal),
  });
  bb.background.service("job-executor", {
    start: (signal) => runJobExecutorService({
      store,
      effectRunnerFactory,
      scheduler,
      maxConcurrentJobs: () => config.ok ? config.value.maxConcurrentJobs : null,
      onWorkAvailable: () => executorNudge.notify(),
      clock: { now: clock },
      reconcileJob,
      telegramToken: () => config.ok ? config.value.botToken : undefined,
      getTelegramClient: () => {
        if (!config.ok) throw new Error(config.message);
        const client = telegramForToken(config.value.botToken);
        return {
          sendMessage: (chatId: string, payload: Record<string, unknown>) => client.sendMessage(chatId, payload as Parameters<TelegramClient["sendMessage"]>[1]),
          sendMessageDraft: (chatId: string, draftId: number, text: string) => client.sendMessageDraft(chatId, draftId, text),
          editMessage: (chatId: string, messageId: number, payload: Record<string, unknown>) => client.editMessage(chatId, messageId, payload as Parameters<TelegramClient["editMessage"]>[2]),
          answerCallback: (callbackQueryId: string, text: string) => client.answerCallback(callbackQueryId, text),
        };
      },
      releaseOnShutdown: true,
      controller,
      operations: threadOperations,
      monitors,
      threadNotices,
      presence,
      laneSnapshots,
      waitForWork: (milliseconds, signal) => executorNudge.wait(milliseconds, signal),
    }, signal),
  });

  const queueThreadReconcile = (threadId: string): void => {
    const jobQueued = store.enqueueReconcileForThread(threadId, clock());
    if (jobQueued || store.getControllerByThreadId(threadId) !== null) executorNudge.notify();
  };
  bb.events.on("thread.created", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.active", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.idle", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.failed", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.archived", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => queueThreadReconcile(thread.id));
}
