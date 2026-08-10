import { randomUUID } from "node:crypto";
import type { StoredOutbox, TelegramAgentStore } from "../storage/store";
import { redactError } from "../errors";
import { EffectRunner, PermanentEffectError, retryDelay, type EffectFence } from "./effect-runner";
import { classifyTelegramError } from "../telegram/errors";

type JobRecord = NonNullable<ReturnType<TelegramAgentStore["getJob"]>>;

export type JobExecutorTelegram = {
  sendMessage(chatId: string, payload: Record<string, unknown>): Promise<{ message_id: number }>;
  sendMessageDraft?(chatId: string, draftId: number, text: string): Promise<void>;
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
  reconcileJob?: (job: JobRecord, signal: AbortSignal, fence: EffectFence) => Promise<void>;
  jitter?: () => number;
  leaseMs?: number;
  releaseOnShutdown?: boolean;
  controller?: {
    processOne(fence: EffectFence, signal: AbortSignal): Promise<boolean>;
    reconcile(fence: EffectFence, signal: AbortSignal): Promise<boolean>;
    isStreaming?(): boolean;
  };
  operations?: {
    processOne(fence: EffectFence, signal: AbortSignal): Promise<boolean>;
  };
  monitors?: {
    processDue(): Promise<boolean>;
  };
  presence?: {
    pulse(now: number, signal: AbortSignal): Promise<number | null>;
    reset(): void;
  };
  waitForWork?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

const LEASE_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const ACTIVE_POLL_MS = 1_000;
const IDLE_POLL_MS = 60_000;
// A streaming reply reaches Telegram once per loop pass, so the ordinary active
// wait is also the draft's frame rate: a whole second of output lands in one
// jump. While an answer is arriving the loop runs at roughly draft speed.
const STREAM_POLL_MS = 250;
const PERMANENT_EFFECT_ERROR_NAMES = new Set([
  "TypeError",
  "SyntaxError",
  "ZodError",
  "ValidationError",
  "AuthorizationError",
  "UnauthorizedError",
  "SchemaValidationError",
  "IdempotencyConflictError",
  "VersionConflictError",
  "ActiveJobConflictError",
  "IllegalTransitionError",
]);

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

function isPermanentEffectFailure(error: unknown): boolean {
  return error instanceof PermanentEffectError ||
    (error instanceof Error && PERMANENT_EFFECT_ERROR_NAMES.has(error.name));
}

function isTerminal(job: JobRecord): boolean {
  return ["merged", "cancelled", "blocked", "complete", "production_failed"].includes(job.state);
}

function statusJobId(logicalKey: string): string | null {
  const match = /^job:([^:]+):status$/.exec(logicalKey);
  return match?.[1] ?? null;
}

function callbackId(logicalKey: string): string | null {
  const match = /^callback:(.+)$/.exec(logicalKey);
  return match?.[1] ?? null;
}

function controllerTurnId(logicalKey: string): string | null {
  const match = /^controller:(controller-turn-[^:]+):reply$/.exec(logicalKey);
  return match?.[1] ?? null;
}

// Telegram keys an ephemeral draft by (chat, draft_id) and offers no way to
// clear one, so one id per turn leaves the previous turn's 30-second preview
// standing beside its own persisted answer. One id per chat means every new
// turn overwrites that preview instead of stacking a second copy of the reply.
function stableChatDraftId(chatId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < chatId.length; index += 1) {
    hash = Math.imul(hash ^ chatId.charCodeAt(index), 16_777_619);
  }
  return ((hash >>> 0) & 0x7fff_ffff) || 1;
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
    deps.presence?.reset();
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
        const effectFence = { ownerId, generation: lease.generation, signal: workAbort.signal };
        if (deps.controller) {
          didWork = await deps.controller.reconcile(effectFence, workAbort.signal) || didWork;
          didWork = await deps.controller.processOne(effectFence, workAbort.signal) || didWork;
        }
        if (deps.operations) {
          didWork = await deps.operations.processOne(effectFence, workAbort.signal) || didWork;
        }
        if (deps.monitors) {
          didWork = await deps.monitors.processDue() || didWork;
        }
        const jobs = deps.store.listJobs(1_000);
        for (const job of jobs) {
          if (isTerminal(job)) continue;
          if (deps.reconcileJob) {
            await deps.reconcileJob(job, workAbort.signal, {
              ownerId,
              generation: lease.generation,
              signal: workAbort.signal,
            });
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
            if (isPermanentEffectFailure(error)) {
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
            const turnId = controllerTurnId(item.logicalKey);
            const controllerTurn = turnId ? deps.store.getControllerTurn(turnId) : null;
            if (callback && telegram.answerCallback) {
              await telegram.answerCallback(callback, payloadText(item));
            } else if (
              turnId !== null &&
              controllerTurn?.state === "submitted" &&
              knownMessageId === null &&
              telegram.sendMessageDraft
            ) {
              await telegram.sendMessageDraft(
                item.chatId,
                stableChatDraftId(item.chatId),
                controllerTurn.streamText,
              );
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
            let deliveryError = error;
            let classification = classifyTelegramError(deliveryError);
            const token = deps.telegramToken?.();
            const telegram = deps.getTelegramClient?.(token) ?? deps.telegram?.(token);
            const jobId = statusJobId(item.logicalKey);
            const job = jobId ? deps.store.getJob(jobId) : null;
            const knownMessageId = item.messageId ?? job?.statusMessageId ?? null;

            if (classification === "not_modified" || classification === "expired_callback") {
              deps.store.completeOutbox(item.logicalKey, ownerId, lease.generation, knownMessageId, deps.clock.now());
              continue;
            }

            if (classification === "edit_unavailable" && telegram && jobId && job) {
              try {
                const replacement = await telegram.sendMessage(item.chatId, item.payload);
                const replaced = deps.store.replaceStatusOutboxMessage(
                  item.logicalKey,
                  ownerId,
                  lease.generation,
                  jobId,
                  job.version,
                  replacement.message_id,
                  deps.clock.now(),
                );
                if (!replaced) throw new Error("Status message changed before replacement was recorded");
                continue;
              } catch (recoveryError) {
                deliveryError = recoveryError;
                classification = classifyTelegramError(recoveryError);
              }
            }

            if (classification === "bad_entities" && telegram && Object.hasOwn(item.payload, "parse_mode")) {
              const { parse_mode: _parseMode, ...plainPayload } = item.payload;
              try {
                let deliveredMessageId = knownMessageId;
                const callback = callbackId(item.logicalKey);
                if (callback && telegram.answerCallback) {
                  await telegram.answerCallback(callback, payloadText({ ...item, payload: plainPayload }));
                } else if (knownMessageId !== null) {
                  await telegram.editMessage(item.chatId, knownMessageId, plainPayload);
                } else {
                  deliveredMessageId = (await telegram.sendMessage(item.chatId, plainPayload)).message_id;
                }
                if (jobId && job && deliveredMessageId !== null && job.statusMessageId === null) {
                  const completed = deps.store.completeStatusOutbox(
                    item.logicalKey,
                    ownerId,
                    lease.generation,
                    jobId,
                    job.version,
                    deliveredMessageId,
                    deps.clock.now(),
                  );
                  if (!completed) throw new Error("Status message changed before plain-text delivery was recorded");
                } else {
                  deps.store.completeOutbox(item.logicalKey, ownerId, lease.generation, deliveredMessageId, deps.clock.now());
                }
                continue;
              } catch (recoveryError) {
                deliveryError = recoveryError;
                classification = classifyTelegramError(recoveryError);
              }
            }

            const failure = safeFailure(deliveryError);
            if (classification === "authentication" || classification === "permanent" || item.attempts >= 20) {
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
        if (!deps.store.isExecutorLeaseCurrent(ownerId, lease.generation, deps.clock.now())) {
          continueAcquiring = true;
          break;
        }
        let presenceWaitMs: number | null;
        try {
          presenceWaitMs = deps.presence
            ? await deps.presence.pulse(deps.clock.now(), workAbort.signal)
            : null;
        } catch (error) {
          if (!workAbort.signal.aborted) throw error;
          if (leaseLost) continueAcquiring = true;
          break;
        }
        const ordinaryWaitMs = deps.controller?.isStreaming?.()
          ? STREAM_POLL_MS
          : didWork ? ACTIVE_POLL_MS : IDLE_POLL_MS;
        const waitMs = presenceWaitMs === null
          ? ordinaryWaitMs
          : Math.min(ordinaryWaitMs, Math.max(1, presenceWaitMs));
        try {
          await (deps.waitForWork ?? sleep)(waitMs, workAbort.signal);
        } catch {
          if (leaseLost) continueAcquiring = true;
          break;
        }
      }
    } finally {
      signal.removeEventListener("abort", onStop);
      workAbort.abort();
      await heartbeat;
      deps.presence?.reset();
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
