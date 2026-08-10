import type { GlobalConfigResult } from "../config";
import { needsConfiguration, redactError } from "../errors";
import type { TelegramAgentStore } from "../storage/store";
import { TelegramConflictError } from "../telegram/client";
import type { TelegramUpdate } from "../telegram/types";

export type TelegramServiceClient = {
  getUpdates(offset: number, timeoutSeconds: number, signal: AbortSignal): Promise<TelegramUpdate[]>;
  getMe(signal?: AbortSignal): Promise<{ id: number; username: string }>;
};

export type TelegramServiceDeps = {
  store: Pick<TelegramAgentStore, "getNextTelegramOffset" | "beginTelegramUpdate" | "completeTelegramUpdate" | "failTelegramUpdate" | "bindTelegramIdentity" | "getActiveJob">;
  client: (token: string) => TelegramServiceClient;
  ingress: { handleClaimed(update: TelegramUpdate, now: number): Promise<void> };
  getConfig: () => GlobalConfigResult;
  clock: { now(): number };
};

function isConflict(error: unknown): boolean {
  return error instanceof TelegramConflictError ||
    (error !== null && typeof error === "object" && (error as { name?: unknown }).name === "TelegramConflictError");
}

function configurationError(message: string): Error {
  return needsConfiguration(message);
}

export async function runTelegramService(deps: TelegramServiceDeps, signal: AbortSignal): Promise<void> {
  let token: string | null = null;
  let client: TelegramServiceClient | null = null;
  let identityBound = false;

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
        throw error;
      }
      const binding = deps.store.bindTelegramIdentity({
        botId: String(identity.id),
        username: identity.username,
        now: deps.clock.now(),
        hasActiveJob: deps.store.getActiveJob() !== null,
      });
      if (binding === "active_job_conflict") {
        throw configurationError("Telegram bot identity changed while an active job exists (active_job_conflict).");
      }
      identityBound = true;
    }

    let updates: TelegramUpdate[];
    try {
      updates = await client.getUpdates(deps.store.getNextTelegramOffset(), config.value.pollTimeoutSeconds, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (isConflict(error)) throw configurationError("Another process is polling this Telegram bot token.");
      throw error;
    }

    for (const update of [...updates].sort((left, right) => left.update_id - right.update_id)) {
      if (signal.aborted) return;
      const claim = deps.store.beginTelegramUpdate(update.update_id, deps.clock.now());
      if (claim === "processed") continue;
      try {
        await deps.ingress.handleClaimed(update, deps.clock.now());
        deps.store.completeTelegramUpdate(update.update_id, "processed", deps.clock.now());
      } catch (error) {
        const safeError = redactError(error).slice(0, 500);
        try {
          deps.store.failTelegramUpdate(update.update_id, safeError, deps.clock.now());
        } catch {
          // Preserve the original ingress failure; the durable claim remains retryable.
        }
        throw error;
      }
    }
  }
}
