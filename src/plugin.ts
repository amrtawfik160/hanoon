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
import { MergeHandler } from "./services/merge-handler";
import { runTelegramService } from "./services/telegram-service";
import { projectUnknownWorker, projectWorkerLiveness } from "./services/worker-liveness";

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
  const bbRunner = new BbRunner(bb.sdk);
  const mergeHandler = new MergeHandler({
    store,
    commandRunner: terminal,
    bb: { sdk: bb.sdk },
    collectGateInput: async () => {
      throw new Error("Merge gate collection is supplied by the leased effect runner");
    },
  });
  const ingress = new TelegramIngress({
    store,
    telegram: telegramTransport,
    mergeHandler,
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
  const reconcileJob = async (job: NonNullable<ReturnType<typeof store.getJob>>, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return;
    for (const resourceId of [job.implementationThreadId, job.reviewThreadId].filter((id): id is string => id !== null)) {
      try {
        const thread = await bbRunner.getThread(resourceId);
        projectWorkerLiveness(store, job, thread, clock());
      } catch {
        projectUnknownWorker(store, job, resourceId, clock());
      }
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
    }, signal),
  });

  const queueThreadReconcile = (threadId: string): void => {
    store.enqueueReconcileForThread(threadId, clock());
  };
  bb.events.on("thread.created", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.active", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.idle", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.failed", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.archived", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => queueThreadReconcile(thread.id));
}
