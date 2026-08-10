import { randomUUID } from "node:crypto";
import type { StoredOutbox, TelegramAgentStore } from "../storage/store";
import { redactError } from "../errors";
import { EffectRunner, PermanentEffectError, retryDelay, type EffectFence } from "./effect-runner";

type JobRecord = NonNullable<ReturnType<TelegramAgentStore["getJob"]>>;

export type JobExecutorTelegram = {
  sendMessage(chatId: string, payload: Record<string, unknown>): Promise<{ message_id: number }>;
  editMessage(chatId: string, messageId: number, payload: Record<string, unknown>): Promise<void>;
  answerCallback?(callbackQueryId: string, text: string): Promise<void>;
};

export type JobExecutorDependencies = {
  store: TelegramAgentStore;
  effectRunner?: Pick<EffectRunner, "run">;
  effectRunnerFactory?: (fence: EffectFence) => Pick<EffectRunner, "run">;
  clock: { now(): number };
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  telegram?: (token?: string) => JobExecutorTelegram;
  getTelegramClient?: (token?: string) => JobExecutorTelegram;
  telegramToken?: () => string | undefined;
  reconcileJob?: (job: JobRecord, signal: AbortSignal) => Promise<void>;
  jitter?: () => number;
  leaseMs?: number;
  releaseOnShutdown?: boolean;
};

const LEASE_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 60_000;

function assertNow(now: number): void {
  if (!Number.isInteger(now) || now < 0) throw new TypeError("executor clock must be a non-negative integer");
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("executor stopped"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("executor stopped"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function safeFailure(error: unknown): string {
  const message = redactError(error).replace(/\s+/g, " ").trim();
  return message.length > 500 ? message.slice(0, 499) + "…" : message || "Executor operation failed";
}

function isTerminal(job: JobRecord): boolean {
  return ["merged", "cancelled", "blocked"].includes(job.state);
}

function statusJobId(logicalKey: string): string | null {
  const match = /^job:([^:]+):status$/.exec(logicalKey);
  return match?.[1] ?? null;
}

function callbackId(logicalKey: string): string | null {
  const match = /^callback:(.+)$/.exec(logicalKey);
  return match?.[1] ?? null;
}

function payloadText(item: StoredOutbox): string {
  const text = item.payload.text;
  return typeof text === "string" ? text : "";
}

async function abortableHeartbeat(
  store: TelegramAgentStore,
  ownerId: string,
  generation: number,
  clock: { now(): number },
  signal: AbortSignal,
  leaseMs: number,
  onLeaseLost: () => void,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await defaultSleep(HEARTBEAT_MS, signal);
    } catch {
      return;
    }
    if (signal.aborted) return;
    const now = clock.now();
    assertNow(now);
    if (!store.renewExecutorLease(ownerId, generation, now, leaseMs)) {
      onLeaseLost();
      return;
    }
  }
}

export async function runJobExecutorService(deps: JobExecutorDependencies, signal: AbortSignal): Promise<void> {
  const ownerId = randomUUID();
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const jitter = deps.jitter ?? (() => Math.floor(Math.random() * 251));
  let acquiredGeneration: number | null = null;

  while (!signal.aborted) {
    const now = deps.clock.now();
    assertNow(now);
    const lease = deps.store.acquireExecutorLease(ownerId, now, leaseMs);
    if (!lease.acquired) {
      try {
        await sleep(1_000, signal);
      } catch {
        return;
      }
      continue;
    }
    acquiredGeneration = lease.generation;
    const workAbort = new AbortController();
    let leaseLost = false;
    const onStop = () => workAbort.abort(signal.reason ?? new Error("executor stopped"));
    signal.addEventListener("abort", onStop, { once: true });
    const heartbeat = abortableHeartbeat(
      deps.store,
      ownerId,
      lease.generation,
      deps.clock,
      workAbort.signal,
      leaseMs,
      () => {
        leaseLost = true;
        workAbort.abort(new Error("executor lease was lost"));
      },
    );
    const runner = deps.effectRunnerFactory
      ? deps.effectRunnerFactory({ ownerId, generation: lease.generation, signal: workAbort.signal })
      : deps.effectRunner;
    if (!runner) throw new TypeError("job executor requires an effect runner");

    let continueAcquiring = false;
    try {
      while (!signal.aborted && !workAbort.signal.aborted) {
        const currentNow = deps.clock.now();
        assertNow(currentNow);
        if (!deps.store.isExecutorLeaseCurrent(ownerId, lease.generation, currentNow)) {
          workAbort.abort(new Error("executor lease was lost"));
          continueAcquiring = true;
          break;
        }

        let didWork = false;
        const jobs = deps.store.listJobs(1_000);
        for (const job of jobs) {
          if (isTerminal(job)) continue;
          if (deps.reconcileJob) {
            await deps.reconcileJob(job, workAbort.signal);
            didWork = true;
          }
        }

        const effects = deps.store.leaseEffects(ownerId, lease.generation, deps.clock.now(), 5, leaseMs);
        for (const effect of effects) {
          if (workAbort.signal.aborted || !deps.store.isExecutorLeaseCurrent(ownerId, lease.generation, deps.clock.now())) {
            continueAcquiring = true;
            break;
          }
          didWork = true;
          try {
            await runner.run(effect);
            deps.store.completeEffect(effect.idempotencyKey, ownerId, lease.generation, deps.clock.now());
          } catch (error) {
            if (workAbort.signal.aborted || !deps.store.isExecutorLeaseCurrent(ownerId, lease.generation, deps.clock.now())) {
              continueAcquiring = true;
              break;
            }
            const failure = safeFailure(error);
            if (error instanceof PermanentEffectError) {
              deps.store.deadLetterEffect(effect.idempotencyKey, ownerId, lease.generation, failure, deps.clock.now());
            } else if (effect.attempts >= 20) {
              deps.store.deadLetterEffect(effect.idempotencyKey, ownerId, lease.generation, failure, deps.clock.now());
            } else {
              deps.store.failEffect(
                effect.idempotencyKey,
                ownerId,
                lease.generation,
                failure,
                deps.clock.now() + retryDelay(effect.attempts, jitter),
                deps.clock.now(),
              );
            }
          }
        }

        if (continueAcquiring || workAbort.signal.aborted) {
          if (leaseLost) continueAcquiring = true;
          break;
        }

        const outbox = deps.store.leaseOutbox(ownerId, lease.generation, deps.clock.now(), 10, leaseMs);
        for (const item of outbox) {
          if (workAbort.signal.aborted || !deps.store.isExecutorLeaseCurrent(ownerId, lease.generation, deps.clock.now())) {
            continueAcquiring = true;
            break;
          }
          didWork = true;
          try {
            const token = deps.telegramToken?.();
            const telegram = deps.getTelegramClient?.(token) ?? deps.telegram?.(token);
            if (!telegram) throw new Error("Telegram client is not configured");
            const jobId = statusJobId(item.logicalKey);
            const job = jobId ? deps.store.getJob(jobId) : null;
            const knownMessageId = item.messageId ?? job?.statusMessageId ?? null;
            let deliveredMessageId = knownMessageId;
            const callback = callbackId(item.logicalKey);
            if (callback && telegram.answerCallback) {
              await telegram.answerCallback(callback, payloadText(item));
            } else if (knownMessageId !== null) {
              await telegram.editMessage(item.chatId, knownMessageId, item.payload);
            } else {
              deliveredMessageId = (await telegram.sendMessage(item.chatId, item.payload)).message_id;
            }
            if (jobId && deliveredMessageId !== null && job?.statusMessageId === null && typeof deps.store.completeStatusOutbox === "function") {
              const atomicallyCompleted = deps.store.completeStatusOutbox(
                item.logicalKey,
                ownerId,
                lease.generation,
                jobId,
                job.version,
                deliveredMessageId,
                deps.clock.now(),
              );
              if (!atomicallyCompleted) continue;
            } else {
              deps.store.completeOutbox(item.logicalKey, ownerId, lease.generation, deliveredMessageId, deps.clock.now());
            }
          } catch (error) {
            if (workAbort.signal.aborted || !deps.store.isExecutorLeaseCurrent(ownerId, lease.generation, deps.clock.now())) {
              continueAcquiring = true;
              break;
            }
            const failure = safeFailure(error);
            if (item.attempts >= 20) {
              deps.store.deadLetterOutbox(item.logicalKey, ownerId, lease.generation, failure, deps.clock.now());
            } else {
              deps.store.failOutbox(
                item.logicalKey,
                ownerId,
                lease.generation,
                failure,
                deps.clock.now() + retryDelay(item.attempts, jitter),
                deps.clock.now(),
              );
            }
          }
        }

        if (continueAcquiring || workAbort.signal.aborted) {
          if (leaseLost) continueAcquiring = true;
          break;
        }
        try {
          await sleep(didWork ? ACTIVE_POLL_MS : IDLE_POLL_MS, workAbort.signal);
        } catch {
          if (leaseLost) continueAcquiring = true;
          break;
        }
      }
    } finally {
      signal.removeEventListener("abort", onStop);
      workAbort.abort();
      await heartbeat;
      if (deps.releaseOnShutdown && !continueAcquiring && signal.aborted) {
        deps.store.releaseExecutorLease(ownerId, lease.generation, deps.clock.now());
      }
    }
    acquiredGeneration = null;
    if (!continueAcquiring) return;
  }

  if (acquiredGeneration !== null && deps.releaseOnShutdown) {
    deps.store.releaseExecutorLease(ownerId, acquiredGeneration, deps.clock.now());
  }
}
