import type { BbPluginApi } from "@bb/plugin-sdk";
import { parseGlobalConfig } from "./config";
import { BbRunner } from "./bb/runner";
import { resolvePrHead, runValidation } from "./bb/validation";
import { TerminalCommandRunner } from "./bb/terminal-command";
import { TelegramClient } from "./telegram/client";
import { TelegramIngress } from "./telegram/ingress";
import { openStore } from "./storage/store";
import { EffectRunner } from "./services/effect-runner";
import type { EffectFence } from "./services/effect-runner";
import { runJobExecutorService } from "./services/job-executor-service";
import { createTask9FreshGateCollector, MergeHandler } from "./services/merge-handler";
import type { GateInput } from "./domain/gates";
import { ReviewHandler, type ReviewHandlerEvent } from "./services/review-handler";
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
import { LunaControllerService } from "./controller/service";
import { TelegramPresenceCoordinator } from "./services/telegram-presence";

function clock(): number {
  return Date.now();
}

export async function createPlugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    botToken: { type: "string", label: "Telegram bot token", secret: true },
    bbAppBaseUrl: { type: "string", label: "BB app base URL", default: "" },
    pollTimeoutSeconds: {
      type: "string",
      label: "Telegram poll timeout in seconds",
      default: "30",
    },
  });
  const store = openStore(bb.storage);
  const executorNudge = new ExecutorNudge();
  registerControllerTools(bb, { store, sdk: bb.sdk, notify: () => executorNudge.notify(), now: clock });
  let config = parseGlobalConfig(await settings.get());
  if (!config.ok) bb.status.needsConfiguration(config.message);

  settings.onChange((next) => {
    const parsed = parseGlobalConfig(next);
    config = parsed;
    if (!parsed.ok) bb.status.needsConfiguration(parsed.message);
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

  const terminal = new TerminalCommandRunner(bb.sdk);
  bb.cli.register({
    name: "telegram-agent",
    summary: "Pair Telegram and manage reviewed BB implementation jobs",
    commands: [
      { name: "pair", summary: "Create a one-use Telegram pairing link", usage: "bb telegram-agent pair [--json]" },
      { name: "unpair", summary: "Revoke the Telegram owner and approvals", usage: "bb telegram-agent unpair [--json]" },
      { name: "project", summary: "Manage enabled BB project policies", usage: "bb telegram-agent project <list|enable|disable> ..." },
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
  let reviewStatusJob: NonNullable<ReturnType<typeof store.getJob>> | null = null;
  let reviewEvent: ReviewHandlerEvent | null = null;
  const reviewHandler = new ReviewHandler({
    threads: {
      output: (threadId) => bb.sdk.threads.output({ threadId }),
      send: (threadId, prompt) => bbRunner.sendSteering(threadId, prompt),
      create: async () => {
        throw new Error("review cycle creation belongs to the leased review effect");
      },
    },
    environment: {
      status: async () => {
        const job = reviewStatusJob;
        if (!job?.environmentId || !job.policy) return { available: false, clean: false, headSha: null };
        const value = await bb.sdk.environments.status({
          environmentId: job.environmentId,
          mergeBaseBranch: job.policy.baseBranch,
        });
        const raw = value as unknown as Record<string, unknown>;
        const workspace = (raw.workspace ?? {}) as Record<string, unknown>;
        const workingTree = (raw.workingTree ?? workspace.workingTree ?? {}) as Record<string, unknown>;
        const checkout = (raw.checkout ?? workspace.checkout ?? {}) as Record<string, unknown>;
        const clean = raw.clean === true || (workingTree.state === "clean" && workingTree.hasUncommittedChanges === false);
        const available = raw.available !== false && raw.outcome !== "unavailable" && raw.outcome !== "not_applicable";
        return {
          available,
          clean,
          headSha: typeof checkout.headSha === "string" ? checkout.headSha : null,
        };
      },
    },
    attempts: {
      get: (attemptId) => {
        const attempt = store.getAttempt(attemptId);
        if (!attempt) return {};
        let result: Record<string, unknown> | null = null;
        if (attempt.resultJson !== null) {
          try {
            const parsed = JSON.parse(attempt.resultJson);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed as Record<string, unknown>;
          } catch {
            result = null;
          }
        }
        return {
          threadId: attempt.threadId,
          headSha: attempt.headSha ?? undefined,
          formatCorrectionSent: result?.formatCorrectionSent === true,
          requiresNewHead: result?.requiresNewHead === true,
          result: result as never,
        };
      },
      update: (attemptId, patch) => {
        const existing = store.getAttempt(attemptId);
        let result = patch.result === undefined
          ? existing?.resultJson
            ? JSON.parse(existing.resultJson) as Record<string, unknown>
            : null
          : patch.result;
        if (result !== null && result !== undefined) {
          result = {
            ...result,
            ...(patch.formatCorrectionSent === undefined ? {} : { formatCorrectionSent: patch.formatCorrectionSent }),
            ...(patch.requiresNewHead === undefined ? {} : { requiresNewHead: patch.requiresNewHead }),
          };
        }
        store.updateAttempt(attemptId, {
          threadId: patch.threadId,
          headSha: patch.headSha,
          result: result as Record<string, unknown> | null,
        });
      },
      claimFormatCorrection: (attemptId, threadId, headSha) => store.claimReviewFormatCorrection(attemptId, threadId, headSha),
    },
    emit: (event) => {
      reviewEvent = event;
    },
  });
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
        if (current) projectTerminalLiveness(store, current, observation, "validation", clock());
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
  const ingress = new TelegramIngress({
    store,
    telegram: telegramTransport,
    mergeHandler,
    onWorkAvailable: () => executorNudge.notify(),
  });
  const controller = new LunaControllerService({
    store,
    adapter: new BbControllerAdapter({ sdk: bb.sdk, pluginId: bb.pluginId }),
    clock: { now: clock },
  });
  const presence = new TelegramPresenceCoordinator({
    store,
    telegram: {
      sendChatAction: (chatId, action, signal) => {
        if (!config.ok) throw new Error(config.message);
        return telegramForToken(config.value.botToken).sendChatAction(chatId, action, signal);
      },
    },
    warn: (message) => bb.log.warn(message),
  });

  const bbEffectAdapter = {
    spawnImplementation: (job: Parameters<BbRunner["spawnImplementation"]>[0], attempt: Parameters<BbRunner["spawnImplementation"]>[1]) => bbRunner.spawnImplementation(job, attempt),
    spawnReview: (job: Parameters<BbRunner["spawnReview"]>[0], attempt: Parameters<BbRunner["spawnReview"]>[1]) => bbRunner.spawnReview(job, attempt),
    sendRemediation: (job: Parameters<BbRunner["sendRemediation"]>[0], findings: Parameters<BbRunner["sendRemediation"]>[1]) => bbRunner.sendRemediation(job, findings),
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
    if (!fenceCurrent()) return;

    const reviewStage = job.state === "reviewing";
    const implementationStage = ["creating_implementation", "implementing", "locating_pr", "resolving_pr_head", "remediating"].includes(job.state);
    const resourceId = reviewStage ? job.reviewThreadId : implementationStage ? job.implementationThreadId : null;
    if (!resourceId) return;
    const workerKind = reviewStage ? "review" as const : "implementation" as const;
    const generation = workerRegistrationGeneration(job, workerKind);
    let thread: Awaited<ReturnType<BbRunner["getThread"]>>;
    try {
      thread = await bbRunner.getThread(resourceId);
    } catch {
      if (!fenceCurrent()) return;
      const current = store.getJob(job.id);
      if (current) projectUnknownWorker(store, current, resourceId, clock(), workerKind, generation);
      return;
    }
    if (!fenceCurrent()) return;
    const current = store.getJob(job.id);
    if (!current || current.state !== job.state || (reviewStage ? current.reviewThreadId : current.implementationThreadId) !== resourceId) return;
    if (!fenceCurrent()) return;
    const projected = projectWorkerLiveness(store, current, thread, clock(), workerKind, generation);
    const failed = thread.status === "error" || thread.runtime.displayStatus === "error";
    if (failed) {
      if (!fenceCurrent()) return;
      const latest = store.getJob(job.id);
      if (latest && latest.cancelRequestedAt === null) {
        store.applyJobEvent(job.id, latest.version, { type: "THREAD_FAILED", workerKind, error: `${workerKind} worker thread failed` }, clock());
      }
      return;
    }
    if (projected.state !== "idle") return;

    if (!reviewStage) {
      if (!fenceCurrent()) return;
      const latest = store.getJob(job.id);
      if (latest && (latest.state === "implementing" || latest.state === "remediating")) {
        store.applyJobEvent(job.id, latest.version, { type: "IMPLEMENTATION_IDLE" }, clock());
      }
      return;
    }

    const attempt = store.getAttemptByThreadId(resourceId);
    if (!attempt || !current.implementationThreadId || !current.prHeadSha) {
      if (!fenceCurrent()) return;
      const latest = store.getJob(job.id);
      if (latest) store.applyJobEvent(job.id, latest.version, { type: "REVIEW_BLOCKED", reason: "configuration" }, clock());
      return;
    }
    reviewStatusJob = current;
    reviewEvent = null;
    await reviewHandler.handleThreadIdle({
      attemptId: attempt.id,
      reviewThreadId: resourceId,
      implementationThreadId: current.implementationThreadId,
      expectedSha: current.prHeadSha,
    });
    const event = (reviewEvent as unknown) as ReviewHandlerEvent | null;
    reviewStatusJob = null;
    if (!event || !fenceCurrent()) return;
    const latest = store.getJob(job.id);
    if (!latest || latest.state !== "reviewing" || !fenceCurrent()) return;
    if (event.type === "REVIEW_PASSED") {
      store.applyJobEvent(job.id, latest.version, { type: "REVIEW_PASSED", headSha: String(event.payload.headSha) }, clock());
    } else if (event.type === "REVIEW_CHANGES_REQUESTED") {
      store.applyJobEvent(job.id, latest.version, {
        type: "REVIEW_CHANGES_REQUESTED",
        headSha: typeof event.payload.headSha === "string" ? event.payload.headSha : undefined,
        summary: typeof event.payload.summary === "string" ? event.payload.summary : undefined,
      }, clock());
    } else {
      store.applyJobEvent(job.id, latest.version, { type: "REVIEW_BLOCKED", reason: "configuration" }, clock());
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
          if (current) projectTerminalLiveness(store, current, observation, "validation", clock());
        },
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
    }, signal),
  });
  bb.background.service("job-executor", {
    start: (signal) => runJobExecutorService({
      store,
      effectRunnerFactory,
      clock: { now: clock },
      reconcileJob,
      telegramToken: () => config.ok ? config.value.botToken : undefined,
      getTelegramClient: () => {
        if (!config.ok) throw new Error(config.message);
        const client = telegramForToken(config.value.botToken);
        return {
          sendMessage: (chatId: string, payload: Record<string, unknown>) => client.sendMessage(chatId, payload as Parameters<TelegramClient["sendMessage"]>[1]),
          editMessage: (chatId: string, messageId: number, payload: Record<string, unknown>) => client.editMessage(chatId, messageId, payload as Parameters<TelegramClient["editMessage"]>[2]),
          answerCallback: (callbackQueryId: string, text: string) => client.answerCallback(callbackQueryId, text),
        };
      },
      releaseOnShutdown: true,
      controller,
      presence,
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
