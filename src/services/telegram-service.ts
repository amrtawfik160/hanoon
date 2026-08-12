import { abortableSleep } from "../async";
import type { GlobalConfig } from "../config";
import { needsConfiguration, redactError } from "../errors";
import { MAX_TELEGRAM_UPDATE_ATTEMPTS, type TelegramAgentStore } from "../storage/store";
import { TelegramConflictError } from "../telegram/client";
import { classifyTelegramError } from "../telegram/errors";
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
  ingress: { handleClaimed(update: TelegramUpdate, now: number): Promise<void> };
  getConfig: () =>
    | { ok: true; value: Pick<GlobalConfig, "botToken"> }
    | { ok: false; message: string };
  clock: { now(): number };
  warn?: (message: string) => void;
};

const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_MAX_MS = 30_000;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 30;

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
  let token: string | null = null;
  let client: TelegramServiceClient | null = null;
  let identityBound = false;
  let consecutivePollFailures = 0;
  deps.store.reconcileTelegramCursor();

  while (!signal.aborted) {
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
        identity = await client.getMe(signal);
      } catch (error) {
        if (signal.aborted) return;
        if (isConflict(error)) throw configurationError("Another process is polling this Telegram bot token.");
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
    }

    let updates: TelegramUpdate[];
    try {
      updates = await client.getUpdates(deps.store.getNextTelegramOffset(), TELEGRAM_POLL_TIMEOUT_SECONDS, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (isConflict(error)) throw configurationError("Another process is polling this Telegram bot token.");
      if (isRejectedToken(error)) throw configurationError("The Telegram bot token was rejected.");
      // A stalled long poll or a transient Telegram failure must not take the
      // whole ingress down: crashing it drops every message until it restarts.
      if (!await backOff(error, "Telegram polling failed")) return;
      continue;
    }
    consecutivePollFailures = 0;

    for (const update of [...updates].sort((left, right) => left.update_id - right.update_id)) {
      if (signal.aborted) return;
      const claim = deps.store.beginTelegramUpdate(update.update_id, deps.clock.now());
      if (claim === "processed") continue;
      try {
        await deps.ingress.handleClaimed(update, deps.clock.now());
        deps.store.completeTelegramUpdate(update.update_id, "processed", deps.clock.now());
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
      await abortableSleep(pollRetryDelay(consecutivePollFailures), signal);
    } catch {
      return false;
    }
    return !signal.aborted;
  }
}
