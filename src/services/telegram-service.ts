import { abortableSleep } from "../async";
import type { GlobalConfig } from "../config";
import { needsConfiguration, redactError } from "../errors";
import { MAX_TELEGRAM_UPDATE_ATTEMPTS, type TelegramAgentStore } from "../storage/store";
import { TelegramConflictError } from "../telegram/client";
import { classifyTelegramError } from "../telegram/errors";
import type { TelegramIngressOutcome } from "../telegram/ingress";
import type { TelegramUpdate } from "../telegram/types";

export type TelegramServiceClient = {
  getUpdates(offset: number, timeoutSeconds: number, signal: AbortSignal): Promise<TelegramUpdate[]>;
  getMe(signal?: AbortSignal): Promise<{ id: number; username: string }>;
};

export type TelegramServiceDeps = {
  store: Pick<
    TelegramAgentStore,
    | "getNextTelegramOffset"
    | "beginTelegramUpdate"
    | "completeTelegramUpdate"
    | "failTelegramUpdate"
    | "abandonTelegramUpdate"
    | "getTelegramUpdateAttempts"
    | "reconcileTelegramCursor"
    | "bindTelegramIdentity"
    | "hasUnreleasedAdmissions"
  >;
  client: (token: string) => TelegramServiceClient;
  ingress: { handleClaimed(update: TelegramUpdate, now: number): Promise<TelegramIngressOutcome> };
  getConfig: () =>
    | { ok: true; value: Pick<GlobalConfig, "botToken"> }
    | { ok: false; message: string };
  clock: { now(): number };
  onTokenVerified?: (token: string) => void;
  warn?: (message: string) => void;
};

type TelegramPollingActivation = {
  controller: AbortController;
  pollSettled: Promise<void>;
};

// Path-plugin reloads evaluate a fresh module, so the polling generation must
// live on the process rather than in module-local state.
const TELEGRAM_POLLING_ACTIVATION = Symbol.for("telegram-agent.polling-activation");
const telegramPollingProcess = globalThis as typeof globalThis & {
  [key: symbol]: TelegramPollingActivation | undefined;
};

const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_MAX_MS = 30_000;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 30;
// A 409 is usually transient: another poller's long poll is still draining, or
// a test run briefly borrowed the token. Treating the first one as terminal
// latches the plugin into needs-configuration and silently drops every message
// until a human notices. Only a sustained conflict is a real configuration
// fault, so retry the same way as any other transient failure until then.
const MAX_CONSECUTIVE_CONFLICTS = 10;

function isConflict(error: unknown): boolean {
  return error instanceof TelegramConflictError ||
    (error !== null && typeof error === "object" && (error as { name?: unknown }).name === "TelegramConflictError");
}

function isRejectedToken(error: unknown): boolean {
  return classifyTelegramError(error) === "authentication";
}

function configurationError(message: string): Error {
  return needsConfiguration(message);
}

function pollRetryDelay(consecutiveFailures: number): number {
  return Math.min(POLL_RETRY_MAX_MS, POLL_RETRY_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1));
}

export async function runTelegramService(deps: TelegramServiceDeps, signal: AbortSignal): Promise<void> {
  const warn = deps.warn ?? (() => undefined);
  const activationController = new AbortController();
  const serviceSignal = AbortSignal.any([signal, activationController.signal]);
  const previousActivation = telegramPollingProcess[TELEGRAM_POLLING_ACTIVATION];
  const activation: TelegramPollingActivation = {
    controller: activationController,
    pollSettled: Promise.resolve(),
  };
  telegramPollingProcess[TELEGRAM_POLLING_ACTIVATION] = activation;
  previousActivation?.controller.abort();
  await previousActivation?.pollSettled;
  let token: string | null = null;
  let client: TelegramServiceClient | null = null;
  let identityBound = false;
  let consecutivePollFailures = 0;
  let consecutiveConflicts = 0;
  deps.store.reconcileTelegramCursor();

  while (!serviceSignal.aborted) {
    const config = deps.getConfig();
    if (!config.ok) throw configurationError(config.message);
    if (config.value.botToken !== token) {
      token = config.value.botToken;
      client = deps.client(token);
      identityBound = false;
    }
    if (!client) throw configurationError("Telegram client is unavailable.");

    if (!identityBound) {
      let identity: { id: number; username: string };
      try {
        identity = await client.getMe(serviceSignal);
      } catch (error) {
        if (serviceSignal.aborted) return;
        if (isConflict(error) && ++consecutiveConflicts > MAX_CONSECUTIVE_CONFLICTS) {
          throw configurationError("Another process is polling this Telegram bot token.");
        }
        if (isRejectedToken(error)) throw configurationError("The Telegram bot token was rejected.");
        if (!await backOff(error, "Telegram identity check failed")) return;
        continue;
      }
      const binding = deps.store.bindTelegramIdentity({
        botId: String(identity.id),
        username: identity.username,
        now: deps.clock.now(),
        hasActiveJob: deps.store.hasUnreleasedAdmissions(),
      });
      if (binding === "active_job_conflict") {
        throw configurationError("Telegram bot identity changed while an active job exists (active_job_conflict).");
      }
      identityBound = true;
      deps.onTokenVerified?.(token);
    }

    let updates: TelegramUpdate[];
    try {
      const pendingUpdates = client.getUpdates(
        deps.store.getNextTelegramOffset(),
        TELEGRAM_POLL_TIMEOUT_SECONDS,
        serviceSignal,
      );
      activation.pollSettled = pendingUpdates.then(() => undefined, () => undefined);
      updates = await pendingUpdates;
    } catch (error) {
      if (serviceSignal.aborted) return;
      if (isConflict(error) && ++consecutiveConflicts > MAX_CONSECUTIVE_CONFLICTS) {
        throw configurationError("Another process is polling this Telegram bot token.");
      }
      if (isRejectedToken(error)) throw configurationError("The Telegram bot token was rejected.");
      // A stalled long poll or a transient Telegram failure must not take the
      // whole ingress down: crashing it drops every message until it restarts.
      if (!await backOff(error, "Telegram polling failed")) return;
      continue;
    }
    consecutivePollFailures = 0;
    consecutiveConflicts = 0;

    for (const update of [...updates].sort((left, right) => left.update_id - right.update_id)) {
      if (serviceSignal.aborted) return;
      const claim = deps.store.beginTelegramUpdate(update.update_id, deps.clock.now());
      if (claim === "processed") continue;
      try {
        const outcome = await deps.ingress.handleClaimed(update, deps.clock.now());
        // An answer already settled this claim in the same commit as the answer
        // itself; completing it again would only fail on a claim it no longer holds.
        if (!outcome.updateSettled) {
          deps.store.completeTelegramUpdate(update.update_id, "processed", deps.clock.now());
        }
      } catch (error) {
        recordUpdateFailure(update.update_id, error);
      }
    }
  }

  function recordUpdateFailure(updateId: number, error: unknown): void {
    const safeError = redactError(error).slice(0, 500);
    const exhausted = deps.store.getTelegramUpdateAttempts(updateId) >= MAX_TELEGRAM_UPDATE_ATTEMPTS;
    warn(`Telegram update ${updateId} failed${exhausted ? " and was abandoned" : ""}: ${safeError}`);
    try {
      if (exhausted) deps.store.abandonTelegramUpdate(updateId, safeError, deps.clock.now());
      else deps.store.failTelegramUpdate(updateId, safeError, deps.clock.now());
    } catch {
      // Preserve the original ingress failure; the durable claim remains retryable.
    }
  }

  async function backOff(error: unknown, context: string): Promise<boolean> {
    consecutivePollFailures += 1;
    warn(`${context}: ${redactError(error).slice(0, 500)}`);
    try {
      await abortableSleep(pollRetryDelay(consecutivePollFailures), serviceSignal);
    } catch {
      return false;
    }
    return !serviceSignal.aborted;
  }
}
