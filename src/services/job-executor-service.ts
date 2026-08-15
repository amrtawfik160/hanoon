import { randomUUID } from "node:crypto";
import type { StoredOutbox, TelegramAgentStore } from "../storage/store";
import type { StoredEffect } from "../domain/models";
import { AutonomyScheduler } from "../autonomy/scheduler";
import { MAX_CONCURRENT_JOBS, type MaxConcurrentJobs } from "../autonomy/models";
import { redactError } from "../errors";
import { EffectRunner, PermanentEffectError, retryDelay, type EffectFence } from "./effect-runner";
import { classifyTelegramError, TelegramApiError } from "../telegram/errors";
import { JobLaneRunner, type JobLaneKind, type JobLaneSnapshotProvider } from "./job-lane-runner";
import {
  projectUnknownWorker,
  projectWorkerLiveness,
  type BbThreadObservation,
} from "./worker-liveness";
import { CONTROLLER_PHASE_TEXT } from "../controller/models";

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
  reconcileJob?: (job: JobRecord, signal: AbortSignal, fence: EffectFence, resourceId?: string) => Promise<void>;
  getWorkerThread?: (threadId: string, signal: AbortSignal) => Promise<BbThreadObservation>;
  scheduler?: Pick<AutonomyScheduler, "run">;
  maxConcurrentJobs?: () => number | null;
  onWorkAvailable?: () => void;
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
    processDueDelegations(): Promise<boolean>;
  };
  threadNotices?: {
    processDue(): Promise<boolean>;
  };
  jobMemory?: {
    processDue(): Promise<boolean>;
  };
  memoryCuration?: {
    processDue(): boolean;
  };
  productionHealth?: {
    processDue(): Promise<boolean>;
  };
  regressionWatch?: {
    processDue(): Promise<boolean>;
  };
  failureLoop?: {
    processDue(): boolean;
  };
  systemMonitors?: {
    install(): void;
  };
  presence?: {
    pulse(now: number, signal: AbortSignal): Promise<number | null>;
    reset(): void;
  };
  laneSnapshots?: Pick<JobLaneSnapshotProvider, "attach" | "detach">;
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
export const WORKER_RECONCILE_INTERVAL_MS = 10_000;
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

function statusJobId(logicalKey: string): string | null {
  const match = /^job:([^:]+):status$/.exec(logicalKey);
  return match?.[1] ?? null;
}

function callbackId(logicalKey: string): string | null {
  const match = /^callback:(.+)$/.exec(logicalKey);
  return match?.[1] ?? null;
}

function isTerminal(job: JobRecord): boolean {
  return ["merged", "cancelled", "blocked", "complete", "production_failed"].includes(job.state);
}

function hasReconcileableWorker(job: JobRecord): boolean {
  return ["planning", "critiquing", "implementing", "remediating", "reviewing", "documenting", "final_reviewing"]
    .includes(job.state);
}

function controllerTurnId(logicalKey: string): string | null {
  const match = /^controller:(controller-turn-[^:]+):reply$/.exec(logicalKey);
  return match?.[1] ?? null;
}

type ReleasePassResult = Readonly<{
  didWork: boolean;
  leaseLost: boolean;
}>;

type ReleasePassInput = Readonly<{
  store: TelegramAgentStore;
  ownerId: string;
  generation: number;
  clock: { now(): number };
  busyJobIds: ReadonlySet<string>;
  getWorkerThread: JobExecutorDependencies["getWorkerThread"];
  signal: AbortSignal;
}>;

type ReleaseWorkerInput = Readonly<{
  store: TelegramAgentStore;
  job: JobRecord;
  worker: NonNullable<ReturnType<TelegramAgentStore["getWorkerLiveness"]>>;
  ownerId: string;
  generation: number;
  clock: { now(): number };
  getWorkerThread: NonNullable<JobExecutorDependencies["getWorkerThread"]>;
  signal: AbortSignal;
}>;

type ReleaseStep = "worked" | "skipped" | "aborted" | "lease_lost";

type LaneOperationRecord = Readonly<{
  jobId: string;
  operationKey: string;
  kind: JobLaneKind;
  effect: StoredEffect | null;
}>;

type PipelineDispatchState = {
  cursorJobId: string | null;
  laneLimit: number;
};

type ControllerStreamDelivery = Readonly<{
  outbox: StoredOutbox;
  telegram: JobExecutorTelegram;
  text: string;
  payload: Record<string, unknown>;
  messageId: number | null;
}>;

function validConfiguredCap(rawCap: number | null | undefined): MaxConcurrentJobs | null {
  if (typeof rawCap !== "number" || !Number.isSafeInteger(rawCap) || rawCap < 1 || rawCap > MAX_CONCURRENT_JOBS) return null;
  return rawCap as MaxConcurrentJobs;
}

function effectivePipelineLaneLimit(configuredCap: MaxConcurrentJobs | null, occupiedCount: number): number {
  const occupiedLaneCount = Math.max(0, Math.min(MAX_CONCURRENT_JOBS, occupiedCount));
  if (configuredCap === null) return occupiedLaneCount;
  return Math.min(MAX_CONCURRENT_JOBS, Math.max(configuredCap, occupiedLaneCount));
}

function rotateAdmissions(
  admissions: readonly ReturnType<TelegramAgentStore["getAdmission"]>[],
  cursorJobId: string | null,
): NonNullable<ReturnType<TelegramAgentStore["getAdmission"]>>[] {
  const present = admissions.filter(
    (admission): admission is NonNullable<ReturnType<TelegramAgentStore["getAdmission"]>> => admission !== null,
  );
  if (present.length === 0 || cursorJobId === null) return present;
  const cursorIndex = present.findIndex((admission) => admission.jobId === cursorJobId);
  if (cursorIndex < 0) return present;
  return [...present.slice(cursorIndex + 1), ...present.slice(0, cursorIndex + 1)];
}

class LaneLeaseLostError extends Error {
  public constructor() {
    super("executor lease was lost during a job lane");
    this.name = "LaneLeaseLostError";
  }
}

function laneRenewalInterval(leaseMs: number): number {
  return Math.max(1, Math.min(10_000, Math.floor(leaseMs / 3)));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("executor stopped");
}

async function runWithLaneLease(input: Readonly<{
  laneSignal: AbortSignal;
  workSignal: AbortSignal;
  store: TelegramAgentStore;
  ownerId: string;
  generation: number;
  clock: { now(): number };
  leaseMs: number;
  onLeaseLost: () => void;
  run: (signal: AbortSignal) => Promise<void>;
  renewOperation: (now: number) => boolean;
}>): Promise<void> {
  const linkedAbort = new AbortController();
  const forwardAbort = (source: AbortSignal): void => {
    if (source.aborted && !linkedAbort.signal.aborted) linkedAbort.abort(abortReason(source));
  };
  const onLaneAbort = (): void => forwardAbort(input.laneSignal);
  const onWorkAbort = (): void => forwardAbort(input.workSignal);
  input.laneSignal.addEventListener("abort", onLaneAbort, { once: true });
  input.workSignal.addEventListener("abort", onWorkAbort, { once: true });
  onLaneAbort();
  onWorkAbort();

  const renew = async (): Promise<void> => {
    while (!linkedAbort.signal.aborted) {
      try {
        await defaultSleep(laneRenewalInterval(input.leaseMs), linkedAbort.signal);
      } catch {
        return;
      }
      if (linkedAbort.signal.aborted) return;
      try {
        const now = input.clock.now();
        assertNow(now);
        const renewed = input.store.renewExecutorLease(input.ownerId, input.generation, now, input.leaseMs) &&
          input.renewOperation(now);
        if (!renewed) {
          input.onLeaseLost();
          linkedAbort.abort(new LaneLeaseLostError());
          return;
        }
      } catch {
        input.onLeaseLost();
        linkedAbort.abort(new LaneLeaseLostError());
        return;
      }
    }
  };
  const renewal = renew();
  try {
    await input.run(linkedAbort.signal);
    if (input.workSignal.aborted || input.laneSignal.aborted) throw new LaneLeaseLostError();
  } finally {
    linkedAbort.abort(abortReason(input.workSignal));
    input.laneSignal.removeEventListener("abort", onLaneAbort);
    input.workSignal.removeEventListener("abort", onWorkAbort);
    await renewal;
  }
}

// Exported so tests can settle a failed effect the way the executor does. A
// bare EffectRunner.run() rejection leaves the effect 'leased'; only this
// decides retry-with-backoff versus dead letter.
export function settleEffectFailure(
  store: TelegramAgentStore,
  effect: StoredEffect,
  ownerId: string,
  generation: number,
  now: number,
  error: unknown,
  jitter: () => number,
): boolean {
  const failure = safeFailure(error);
  if (isPermanentEffectFailure(error) || effect.attempts >= 20) {
    return store.deadLetterEffect(effect.idempotencyKey, ownerId, generation, failure, now);
  }
  return store.failEffect(
    effect.idempotencyKey,
    ownerId,
    generation,
    failure,
    now + retryDelay(effect.attempts, jitter),
    now,
  );
}

function persistReleaseWorkerObservation(
  input: ReleaseWorkerInput,
  thread: BbThreadObservation | null,
): ReleaseStep {
  if (input.signal.aborted) return "aborted";
  const observedAt = input.clock.now();
  assertNow(observedAt);
  try {
    const fence = { ownerId: input.ownerId, generation: input.generation, now: observedAt };
    if (thread) {
      projectWorkerLiveness(
        input.store, input.job, thread, observedAt,
        input.worker.workerKind, input.worker.generation, fence,
      );
    } else {
      projectUnknownWorker(
        input.store, input.job, input.worker.resourceId, observedAt,
        input.worker.workerKind, input.worker.generation, fence,
      );
    }
  } catch (error) {
    if (!input.store.isExecutorLeaseCurrent(input.ownerId, input.generation, observedAt)) return "lease_lost";
    throw error;
  }
  return "worked";
}

async function refreshReleaseWorker(input: ReleaseWorkerInput): Promise<ReleaseStep> {
  let thread: BbThreadObservation;
  try {
    thread = await input.getWorkerThread(input.worker.resourceId, input.signal);
  } catch {
    // BB lookup errors are opaque. Unknown is the fail-closed observation and
    // advances observedAt so a transient outage cannot create a hot poll loop.
    return persistReleaseWorkerObservation(input, null);
  }
  if (input.signal.aborted) return "aborted";
  return persistReleaseWorkerObservation(
    input,
    thread.id === input.worker.resourceId ? thread : null,
  );
}

async function finalizeReleaseCandidate(
  input: ReleasePassInput,
  admission: ReturnType<TelegramAgentStore["listReleaseCandidates"]>[number],
): Promise<ReleaseStep> {
  if (input.busyJobIds.has(admission.jobId)) return "skipped";
  const now = input.clock.now();
  assertNow(now);
  if (!input.store.beginDraining({
    jobId: admission.jobId,
    ownerId: input.ownerId,
    generation: input.generation,
    now,
  })) return "lease_lost";

  const job = input.store.getJob(admission.jobId);
  const worker = input.store.getWorkerLiveness(admission.jobId);
  const refreshDue = job && worker && worker.resourceKind === "bb_thread" &&
    !["idle", "failed"].includes(worker.state) && input.getWorkerThread &&
    now - worker.observedAt >= WORKER_RECONCILE_INTERVAL_MS;
  if (refreshDue) {
    const refresh = await refreshReleaseWorker({ ...input, job, worker, getWorkerThread: input.getWorkerThread });
    if (refresh === "aborted" || refresh === "lease_lost") return refresh;
  }

  const finalizedAt = input.clock.now();
  assertNow(finalizedAt);
  const released = input.store.finalizeRelease({
    jobId: admission.jobId,
    ownerId: input.ownerId,
    generation: input.generation,
    now: finalizedAt,
  });
  return released === null ? "lease_lost" : "worked";
}

async function finalizeReleaseCandidates(input: ReleasePassInput): Promise<ReleasePassResult> {
  let didWork = false;
  for (const admission of input.store.listReleaseCandidates(100)) {
    const step = await finalizeReleaseCandidate(input, admission);
    if (step === "lease_lost") return { didWork, leaseLost: true };
    if (step === "aborted") return { didWork, leaseLost: false };
    if (step === "worked") didWork = true;
  }
  return { didWork, leaseLost: false };
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

function controllerDeliveryPayload(
  item: StoredOutbox,
  controllerTurn: NonNullable<ReturnType<TelegramAgentStore["getControllerTurn"]>> | null,
): Record<string, unknown> {
  if (!controllerTurn || controllerTurn.state !== "submitted") return item.payload;
  return {
    text: CONTROLLER_PHASE_TEXT[controllerTurn.streamPhase],
    disable_web_page_preview: true,
  };
}

function controllerStreamRetryAt(error: unknown, now: number): number | null {
  if (
    !(error instanceof TelegramApiError) ||
    error.errorCode !== 429 ||
    error.retryAfterSeconds === null ||
    !Number.isFinite(error.retryAfterSeconds) ||
    error.retryAfterSeconds < 0
  ) return null;
  const delay = Math.ceil(error.retryAfterSeconds * 1_000);
  if (!Number.isFinite(delay)) return Number.MAX_SAFE_INTEGER;
  return Math.min(Number.MAX_SAFE_INTEGER, now + delay + 1_000);
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
  deps.presence?.reset();

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
    let continueAcquiring = false;
    const loseLease = (): void => {
      leaseLost = true;
      continueAcquiring = true;
      if (!workAbort.signal.aborted) workAbort.abort(new Error("executor lease was lost"));
    };
    const onStop = (): void => workAbort.abort(abortReason(signal));
    signal.addEventListener("abort", onStop, { once: true });
    const pipelineState: PipelineDispatchState = { cursorJobId: null, laneLimit: 0 };
    let wakeLaneWait: (() => void) | null = null;
    const lanes = new JobLaneRunner({
      maxPipelineLanes: () => pipelineState.laneLimit,
      maxControlLanes: 8,
      onCompletion: () => {
        wakeLaneWait?.();
        deps.onWorkAvailable?.();
      },
    });
    deps.laneSnapshots?.attach(lanes);
    const laneOperations = new Map<string, LaneOperationRecord>();
    const adoptedJobIds = new Set<string>();
    const nextWorkerReconcileAt = new Map<string, number>();
    const controllerStreamInFlight = new Map<string, Promise<void>>();
    const controllerStreamLastText = new Map<string, string>();
    const controllerStreamMessageIds = new Map<string, number>();
    const controllerStreamBackoffUntil = new Map<string, number>();
    const hasCurrentAdoptedClaims = (jobId: string, now: number): boolean => {
      const claims = deps.store.listCurrentHeldResourceClaims(jobId, 100);
      return claims.length > 0 && claims.every((claim) =>
        claim.ownerId === ownerId &&
        claim.generation === lease.generation &&
        claim.leaseExpiresAt > now,
      );
    };
    const onWorkAbort = (): void => {
      lanes.abortAll(abortReason(workAbort.signal));
      laneOperations.clear();
    };
    workAbort.signal.addEventListener("abort", onWorkAbort, { once: true });
    const settleControllerStream = (
      outbox: StoredOutbox,
      text: string,
      messageId: number | null,
      error?: unknown,
    ): void => {
      try {
        const now = deps.clock.now();
        assertNow(now);
        const retryAt = controllerStreamRetryAt(error, now);
        if (retryAt !== null) {
          controllerStreamBackoffUntil.set(
            outbox.logicalKey,
            Math.max(controllerStreamBackoffUntil.get(outbox.logicalKey) ?? 0, retryAt),
          );
        } else if (error === undefined) {
          controllerStreamBackoffUntil.delete(outbox.logicalKey);
        }
        const current = deps.store.getOutbox(outbox.logicalKey);
        if (!current) return;
        if (current.status === "leased" && payloadText(current) !== text) {
          deps.store.failOutbox(
            outbox.logicalKey,
            ownerId,
            lease.generation,
            "controller stream update superseded",
            retryAt ?? now,
            now,
          );
        } else if (current.status === "leased" && retryAt !== null) {
          deps.store.failOutbox(
            outbox.logicalKey,
            ownerId,
            lease.generation,
            safeFailure(error),
            retryAt,
            now,
          );
        } else if (current.status === "leased" && payloadText(current) === text) {
          // A cosmetic failure other than a server-directed rate limit is
          // dropped. The reply path must not inherit preview delivery errors.
          deps.store.completeOutbox(outbox.logicalKey, ownerId, lease.generation, messageId, now);
        }
      } catch {
        // A stream update is cosmetic and must fail open, including when its
        // lease has already moved on to the terminal reply.
      }
      try {
        deps.onWorkAvailable?.();
      } catch {
        // Wake-up hooks are cosmetic from the stream's point of view too.
      }
    };
    const startControllerStream = (delivery: ControllerStreamDelivery): void => {
      const streamRequest = (async (): Promise<void> => {
        let deliveredMessageId = delivery.messageId;
        try {
          if (delivery.messageId === null && delivery.telegram.sendMessageDraft) {
            // The draft is an ephemeral phase indicator, not the durable
            // answer. It must never hold the executor while Telegram is slow.
            await delivery.telegram.sendMessageDraft(
              delivery.outbox.chatId,
              stableChatDraftId(delivery.outbox.chatId),
              delivery.text,
            );
          } else if (delivery.messageId !== null) {
            await delivery.telegram.editMessage(delivery.outbox.chatId, delivery.messageId, delivery.payload);
          } else {
            deliveredMessageId = (await delivery.telegram.sendMessage(
              delivery.outbox.chatId,
              delivery.payload,
            )).message_id;
          }
          if (deliveredMessageId !== null) {
            controllerStreamMessageIds.set(delivery.outbox.logicalKey, deliveredMessageId);
          }
          controllerStreamLastText.set(delivery.outbox.logicalKey, delivery.text);
          settleControllerStream(delivery.outbox, delivery.text, deliveredMessageId);
        } catch (error) {
          settleControllerStream(delivery.outbox, delivery.text, deliveredMessageId, error);
        }
      })();
      controllerStreamInFlight.set(delivery.outbox.logicalKey, streamRequest);
      void streamRequest.then(
        () => {
          if (controllerStreamInFlight.get(delivery.outbox.logicalKey) === streamRequest) {
            controllerStreamInFlight.delete(delivery.outbox.logicalKey);
          }
        },
        () => {
          if (controllerStreamInFlight.get(delivery.outbox.logicalKey) === streamRequest) {
            controllerStreamInFlight.delete(delivery.outbox.logicalKey);
          }
        },
      );
    };
    const heartbeat = abortableHeartbeat(
      deps.store,
      ownerId,
      lease.generation,
      deps.clock,
      workAbort.signal,
      leaseMs,
      loseLease,
    );
    try {
      while (!signal.aborted && !workAbort.signal.aborted) {
        const currentNow = deps.clock.now();
        assertNow(currentNow);
        if (!deps.store.isExecutorLeaseCurrent(ownerId, lease.generation, currentNow)) {
          loseLease();
          break;
        }

        let didWork = false;
        const collectCompletions = (): void => {
          for (const completion of lanes.drainCompletions()) {
            const operation = laneOperations.get(completion.operationKey);
            if (!operation || operation.jobId !== completion.jobId || operation.kind !== completion.kind) continue;
            laneOperations.delete(completion.operationKey);
            didWork = true;
            const now = deps.clock.now();
            assertNow(now);
            if (!deps.store.isExecutorLeaseCurrent(ownerId, lease.generation, now)) {
              loseLease();
              continue;
            }
            if (completion.outcome === "fulfilled") {
              if (operation.effect === null) {
                adoptedJobIds.add(operation.jobId);
                nextWorkerReconcileAt.set(operation.jobId, now + WORKER_RECONCILE_INTERVAL_MS);
              } else if (!deps.store.completeEffect(operation.effect.idempotencyKey, ownerId, lease.generation, now)) {
                loseLease();
              }
              continue;
            }
            if (operation.effect === null) {
              safeFailure(completion.error);
              continue;
            }
            if (!settleEffectFailure(
              deps.store,
              operation.effect,
              ownerId,
              lease.generation,
              now,
              completion.error,
              jitter,
            )) {
              loseLease();
            }
          }
        };
        const settleLaneMicrotasks = async (): Promise<void> => {
          for (let microtask = 0; microtask < 20; microtask += 1) await Promise.resolve();
        };
        collectCompletions();
        if (continueAcquiring || workAbort.signal.aborted) {
          if (leaseLost) continueAcquiring = true;
          break;
        }

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
          didWork = await deps.monitors.processDueDelegations() || didWork;
        }
        if (deps.threadNotices) {
          didWork = await deps.threadNotices.processDue() || didWork;
        }
        if (deps.jobMemory) {
          didWork = await deps.jobMemory.processDue() || didWork;
        }
        if (deps.memoryCuration) {
          didWork = deps.memoryCuration.processDue() || didWork;
        }
        if (deps.productionHealth) {
          didWork = await deps.productionHealth.processDue() || didWork;
        }
        if (deps.regressionWatch) {
          didWork = await deps.regressionWatch.processDue() || didWork;
        }
        // Scanned before the scheduler runs, so a project that just tripped the
        // brake does not get one more job admitted into the same failure.
        if (deps.failureLoop) {
          didWork = deps.failureLoop.processDue() || didWork;
        }
        // Idempotent, and deliberately not a one-shot at activation: pairing
        // can happen long after the executor starts.
        deps.systemMonitors?.install();

        const configuredCap = validConfiguredCap(deps.maxConcurrentJobs?.());
        if (configuredCap !== null && deps.scheduler) {
          const scheduled = deps.scheduler.run({
            maxConcurrentJobs: configuredCap,
            ownerId,
            generation: lease.generation,
            now: deps.clock.now(),
            leaseMs,
          });
          didWork = scheduled.admissions.some((admission) => admission.outcome === "admitted") || didWork;
        }

        const occupiedAdmissions = deps.store.listAdmissions(["admitted", "draining"], 100);
        pipelineState.laneLimit = effectivePipelineLaneLimit(configuredCap, occupiedAdmissions.length);
        const legacyJobs = deps.reconcileJob && (configuredCap === null || occupiedAdmissions.length < configuredCap)
          ? deps.store.listLegacyActiveJobs(100)
          : [];
        if (legacyJobs.length > 0 && pipelineState.laneLimit === 0) pipelineState.laneLimit = 1;

        const startEffectLane = (effect: StoredEffect, kind: JobLaneKind): boolean => {
          const operationKey = `effect:${effect.idempotencyKey}`;
          const started = lanes.tryStart({
            jobId: effect.jobId,
            operationKey,
            kind,
            run: async (laneSignal) => {
              const now = deps.clock.now();
              assertNow(now);
              const renewEffectFence = (renewNow: number): boolean => kind === "control"
                ? deps.store.renewControlEffectFence({
                  jobId: effect.jobId,
                  effectIdempotencyKey: effect.idempotencyKey,
                  ownerId,
                  generation: lease.generation,
                  now: renewNow,
                  leaseMs,
                })
                : deps.store.renewJobOperationFences({
                  jobId: effect.jobId,
                  effectIdempotencyKey: effect.idempotencyKey,
                  ownerId,
                  generation: lease.generation,
                  now: renewNow,
                  leaseMs,
                });
              if (!renewEffectFence(now)) {
                loseLease();
                throw new LaneLeaseLostError();
              }
              await runWithLaneLease({
                laneSignal,
                workSignal: workAbort.signal,
                store: deps.store,
                ownerId,
                generation: lease.generation,
                clock: deps.clock,
                leaseMs,
                onLeaseLost: loseLease,
                renewOperation: renewEffectFence,
                run: async (signalForRunner) => {
                  const effectRunner = deps.effectRunnerFactory
                    ? deps.effectRunnerFactory({ ownerId, generation: lease.generation, signal: signalForRunner })
                    : deps.effectRunner;
                  if (!effectRunner) throw new TypeError("job executor requires an effect runner");
                  await effectRunner.run(effect);
                },
              });
            },
          });
          if (started) laneOperations.set(operationKey, { jobId: effect.jobId, operationKey, kind, effect });
          return started;
        };

        const startReconciliationLane = (job: JobRecord, adoptClaims: boolean): boolean => {
          if (!deps.reconcileJob) return false;
          const operationKey = `${adoptClaims ? "reconcile" : "legacy-reconcile"}:${job.id}`;
          const started = lanes.tryStart({
            jobId: job.id,
            operationKey,
            kind: "pipeline",
            run: (laneSignal) => runWithLaneLease({
              laneSignal,
              workSignal: workAbort.signal,
              store: deps.store,
              ownerId,
              generation: lease.generation,
              clock: deps.clock,
              leaseMs,
              onLeaseLost: loseLease,
              renewOperation: () => true,
              run: async (signalForReconcile) => {
                await deps.reconcileJob?.(job, signalForReconcile, {
                  ownerId,
                  generation: lease.generation,
                  signal: signalForReconcile,
                });
                if (!adoptClaims) return;
                const now = deps.clock.now();
                assertNow(now);
                const reconciledJob = deps.store.getJob(job.id);
                const admission = deps.store.getAdmission(job.id);
                const identityStillMatches = reconciledJob?.projectId === job.projectId &&
                  admission?.jobId === job.id &&
                  admission.projectId === job.projectId &&
                  (admission.state === "admitted" || admission.state === "draining");
                if (signalForReconcile.aborted ||
                  !deps.store.isExecutorLeaseCurrent(ownerId, lease.generation, now) ||
                  !identityStillMatches ||
                  !deps.store.adoptHeldClaims({
                    jobId: job.id,
                    ownerId,
                    generation: lease.generation,
                    now,
                    leaseMs,
                  })) {
                  throw new LaneLeaseLostError();
                }
              },
            }),
          });
          if (started) laneOperations.set(operationKey, {
            jobId: job.id,
            operationKey,
            kind: "pipeline",
            effect: null,
          });
          if (started) nextWorkerReconcileAt.set(job.id, deps.clock.now() + WORKER_RECONCILE_INTERVAL_MS);
          return started;
        };

        const startControlPass = (): number => {
          let startedCount = 0;
          for (let controlPass = 0; controlPass < 8; controlPass += 1) {
            const snapshot = lanes.snapshot();
            if (snapshot.controlActive >= 8 || workAbort.signal.aborted) break;
            const now = deps.clock.now();
            assertNow(now);
            const controlEffects = deps.store.leaseControlEffects({
              ownerId,
              generation: lease.generation,
              now,
              limit: 1,
              leaseMs,
              busyJobIds: [...snapshot.busyJobIds],
            });
            const effect = controlEffects[0];
            if (!effect) break;
            if (!startEffectLane(effect, "control")) {
              if (!workAbort.signal.aborted) loseLease();
              break;
            }
            startedCount += 1;
            didWork = true;
          }
          return startedCount;
        };
        startControlPass();

        for (const admission of rotateAdmissions(occupiedAdmissions, pipelineState.cursorJobId)) {
          if (workAbort.signal.aborted || lanes.snapshot().pipelineActive >= pipelineState.laneLimit) break;
          if (lanes.hasJob(admission.jobId)) continue;
          const job = deps.store.getJob(admission.jobId);
          if (!job) continue;
          const claimNow = deps.clock.now();
          assertNow(claimNow);
          if (adoptedJobIds.has(job.id) && !hasCurrentAdoptedClaims(job.id, claimNow)) {
            adoptedJobIds.delete(job.id);
          }
          if (!adoptedJobIds.has(job.id)) {
            if (deps.reconcileJob) {
              if (startReconciliationLane(job, true)) {
                pipelineState.cursorJobId = job.id;
                didWork = true;
              }
              continue;
            }
            continue;
          }
          if (lanes.snapshot().pipelineActive >= pipelineState.laneLimit) break;
          const effect = deps.store.leaseNextJobEffect({
            jobId: job.id,
            ownerId,
            generation: lease.generation,
            now: deps.clock.now(),
            leaseMs,
          });
          if (!effect) {
            const dueAt = nextWorkerReconcileAt.get(job.id);
            if (deps.reconcileJob && hasReconcileableWorker(job) && dueAt !== undefined && claimNow >= dueAt) {
              if (startReconciliationLane(job, true)) {
                pipelineState.cursorJobId = job.id;
                didWork = true;
              }
            }
            continue;
          }
          if (!startEffectLane(effect, "pipeline")) {
            if (!workAbort.signal.aborted) loseLease();
            break;
          }
          pipelineState.cursorJobId = job.id;
          didWork = true;
        }

        for (const job of legacyJobs) {
          if (workAbort.signal.aborted || lanes.snapshot().pipelineActive >= pipelineState.laneLimit) break;
          if (adoptedJobIds.has(job.id) || lanes.hasJob(job.id)) continue;
          if (startReconciliationLane(job, false)) didWork = true;
        }

        await settleLaneMicrotasks();
        collectCompletions();
        if (continueAcquiring || workAbort.signal.aborted) {
          if (leaseLost) continueAcquiring = true;
          break;
        }
        for (let controlRound = 0; controlRound < 8; controlRound += 1) {
          if (startControlPass() === 0) break;
          await settleLaneMicrotasks();
          collectCompletions();
          if (continueAcquiring || workAbort.signal.aborted) break;
        }
        if (continueAcquiring || workAbort.signal.aborted) {
          if (leaseLost) continueAcquiring = true;
          break;
        }

        const releasePass = await finalizeReleaseCandidates({
          store: deps.store,
          ownerId,
          generation: lease.generation,
          clock: deps.clock,
          busyJobIds: new Set(lanes.snapshot().busyJobIds),
          getWorkerThread: deps.getWorkerThread,
          signal: workAbort.signal,
        });
        didWork = releasePass.didWork || didWork;
        if (releasePass.leaseLost) {
          continueAcquiring = true;
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
            const deliveryPayload = controllerDeliveryPayload(item, controllerTurn);
            const terminalControllerDraft = turnId !== null &&
              controllerTurn?.state === "submitted" &&
              (controllerTurn.streamPhase === "complete" || controllerTurn.streamPhase === "failed");
            const controllerStreamText = turnId !== null &&
              controllerTurn?.state === "submitted" &&
              !terminalControllerDraft
              ? CONTROLLER_PHASE_TEXT[controllerTurn.streamPhase]
              : null;
            if (terminalControllerDraft) {
              // Suppress terminal placeholders before choosing draft, edit, or
              // ordinary-send transport. A pre-cutover row can already carry a
              // message id, and some Telegram clients do not expose drafts;
              // neither case may turn stale stream payload into owner-visible
              // text beside the real terminal writer's message.
              deliveredMessageId = knownMessageId;
            } else if (controllerStreamText !== null) {
              const streamMessageId = knownMessageId ?? controllerStreamMessageIds.get(item.logicalKey) ?? null;
              if (controllerStreamLastText.get(item.logicalKey) === controllerStreamText) {
                settleControllerStream(item, controllerStreamText, streamMessageId);
                continue;
              }
              if (controllerStreamInFlight.has(item.logicalKey)) {
                // Leave the newest durable row leased until the earlier
                // cosmetic request settles; its completion handler will
                // requeue it if the phase changed in the meantime.
                continue;
              }
              const now = deps.clock.now();
              assertNow(now);
              const backoffUntil = controllerStreamBackoffUntil.get(item.logicalKey) ?? 0;
              if (backoffUntil > now) {
                try {
                  deps.store.failOutbox(
                    item.logicalKey,
                    ownerId,
                    lease.generation,
                    "controller stream rate limit",
                    backoffUntil,
                    now,
                  );
                } catch {
                  // A cosmetic backoff must not affect the real reply path.
                }
                continue;
              }
              controllerStreamBackoffUntil.delete(item.logicalKey);
              startControllerStream({
                outbox: item,
                telegram,
                text: controllerStreamText,
                payload: deliveryPayload,
                messageId: streamMessageId,
              });
              continue;
            } else if (callback && telegram.answerCallback) {
              await telegram.answerCallback(callback, payloadText(item));
            } else if (
              turnId !== null &&
              controllerTurn?.state === "submitted" &&
              knownMessageId === null &&
              telegram.sendMessageDraft
            ) {
              // The draft is derived from the durable stream phase, never from
              // a persisted raw stream_text, so provider prose can never reach
              // Telegram as a preview.
              await telegram.sendMessageDraft(
                item.chatId,
                stableChatDraftId(item.chatId),
                CONTROLLER_PHASE_TEXT[controllerTurn.streamPhase],
              );
            } else if (knownMessageId !== null) {
              await telegram.editMessage(item.chatId, knownMessageId, deliveryPayload);
            } else {
              deliveredMessageId = (await telegram.sendMessage(item.chatId, deliveryPayload)).message_id;
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
              if (!atomicallyCompleted) {
                continueAcquiring = true;
                break;
              }
            } else {
              if (!deps.store.completeOutbox(item.logicalKey, ownerId, lease.generation, deliveredMessageId, deps.clock.now())) {
                continueAcquiring = true;
                break;
              }
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
              if (!deps.store.completeOutbox(item.logicalKey, ownerId, lease.generation, knownMessageId, deps.clock.now())) {
                continueAcquiring = true;
                break;
              }
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
                if (!replaced) {
                  continueAcquiring = true;
                  break;
                }
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
                  if (!completed) {
                    continueAcquiring = true;
                    break;
                  }
                } else {
                  if (!deps.store.completeOutbox(item.logicalKey, ownerId, lease.generation, deliveredMessageId, deps.clock.now())) {
                    continueAcquiring = true;
                    break;
                  }
                }
                continue;
              } catch (recoveryError) {
                deliveryError = recoveryError;
                classification = classifyTelegramError(recoveryError);
              }
            }

            const failure = safeFailure(deliveryError);
            let settled = false;
            if (classification === "authentication" || classification === "permanent" || item.attempts >= 20) {
              settled = deps.store.deadLetterOutbox(item.logicalKey, ownerId, lease.generation, failure, deps.clock.now());
            } else {
              settled = deps.store.failOutbox(
                item.logicalKey,
                ownerId,
                lease.generation,
                failure,
                deps.clock.now() + retryDelay(item.attempts, jitter),
                deps.clock.now(),
              );
            }
            if (!settled) {
              continueAcquiring = true;
              break;
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
        let presenceWaitMs: number | null = null;
        try {
          presenceWaitMs = deps.presence
            ? await deps.presence.pulse(deps.clock.now(), workAbort.signal)
            : null;
        } catch {
          if (!workAbort.signal.aborted) {
            // Presence is cosmetic. A coordinator or transport regression
            // must not prevent the executor from delivering real messages.
            presenceWaitMs = null;
          }
          if (leaseLost) continueAcquiring = true;
          if (workAbort.signal.aborted) break;
        }
        const ordinaryWaitMs = deps.controller?.isStreaming?.()
          ? STREAM_POLL_MS
          : didWork ? ACTIVE_POLL_MS : IDLE_POLL_MS;
        const sweepNow = deps.clock.now();
        const workerSweepWaitMs = [...nextWorkerReconcileAt.entries()].reduce((soonest, [jobId, dueAt]) => {
          if (!adoptedJobIds.has(jobId) || lanes.hasJob(jobId)) return soonest;
          const candidate = deps.store.getJob(jobId);
          if (!candidate || !hasReconcileableWorker(candidate)) return soonest;
          return Math.min(soonest, Math.max(1, dueAt - sweepNow));
        }, Number.POSITIVE_INFINITY);
        const ordinaryAndSweepWaitMs = Math.min(ordinaryWaitMs, workerSweepWaitMs);
        const waitMs = presenceWaitMs === null
          ? ordinaryAndSweepWaitMs
          : Math.min(ordinaryAndSweepWaitMs, Math.max(1, presenceWaitMs));
        try {
          const busyLaneJobIds = lanes.snapshot().busyJobIds;
          const busyReleaseCandidate = !deps.waitForWork && busyLaneJobIds.some((jobId) =>
            deps.store.listReleaseCandidates(100).some((candidate) => candidate.jobId === jobId),
          );
          if (!deps.waitForWork && busyReleaseCandidate) {
            await new Promise<void>((resolve) => {
              let finished = false;
              const finish = (): void => {
                if (finished) return;
                finished = true;
                if (wakeLaneWait === finish) wakeLaneWait = null;
                signal.removeEventListener("abort", finish);
                workAbort.signal.removeEventListener("abort", finish);
                resolve();
              };
              wakeLaneWait = finish;
              signal.addEventListener("abort", finish, { once: true });
              workAbort.signal.addEventListener("abort", finish, { once: true });
              if (lanes.snapshot().busyJobIds.length === 0) finish();
            });
          } else {
            await (deps.waitForWork ?? sleep)(waitMs, workAbort.signal);
          }
        } catch {
          if (leaseLost) continueAcquiring = true;
          break;
        }
      }
    } finally {
      signal.removeEventListener("abort", onStop);
      workAbort.abort();
      await heartbeat;
      deps.laneSnapshots?.detach(lanes);
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
