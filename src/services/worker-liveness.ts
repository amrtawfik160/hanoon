import type {
  Job,
  WorkerLiveness,
  WorkerLivenessState,
  WorkerRecoveryClassification,
} from "../domain/models";
import type { ExecutorFence, TelegramAgentStore } from "../storage/store";
import { persistableJobStatusPayload, renderJobStatus } from "../telegram/view";

export type BbThreadObservation = {
  id: string;
  status: string;
  updatedAt: number;
  runtime: { displayStatus: string; hostReconnectGraceExpiresAt: number | null };
};

export type BbTerminalObservation = {
  id: string;
  status: string;
  updatedAt: number;
  exitCode?: number | null;
};

type ThreadLike = BbThreadObservation;

export function workerRegistrationGeneration(job: Job, workerKind: WorkerLiveness["workerKind"]): number {
  const role: Record<WorkerLiveness["workerKind"], number> = {
    plan: 1,
    critique: 2,
    implementation: 3,
    review: 4,
    validation: 5,
    docs: 6,
    merge: 7,
    deploy: 8,
    canary: 9,
  };
  return job.version * 100 + role[workerKind];
}

function unknownThreadObservation(resourceId: string): ThreadLike {
  return {
    id: resourceId,
    status: "active",
    updatedAt: 0,
    runtime: { displayStatus: "host-reconnecting", hostReconnectGraceExpiresAt: null },
  };
}

function stateForThread(thread: ThreadLike): WorkerLivenessState {
  if (thread.runtime.displayStatus === "host-reconnecting" || thread.runtime.displayStatus === "waiting-for-host") {
    return "unknown";
  }
  if (thread.status === "pending" || thread.status === "starting" ||
    thread.runtime.displayStatus === "starting" || thread.runtime.displayStatus === "provisioning") {
    return "starting";
  }
  if (thread.status === "stopping" || thread.runtime.displayStatus === "stopping") return "stopping";
  if (thread.status === "idle" || thread.runtime.displayStatus === "idle") return "idle";
  if (thread.status === "error" || thread.runtime.displayStatus === "error") return "failed";
  return "active";
}

function watchdogMs(job: Job): number {
  return job.policy?.workerLivenessWatchdogMs ?? 300_000;
}

function startGraceMs(job: Job): number {
  return job.policy?.workerStartGraceMs ?? 120_000;
}

function withStaleness(job: Job, state: WorkerLivenessState, sourceUpdatedAt: number, observedAt: number): WorkerLivenessState {
  if ((state === "starting" || state === "active") && observedAt - sourceUpdatedAt > watchdogMs(job)) return "stale";
  return state;
}

function threadActivityAt(thread: ThreadLike, commandActivityAt?: number): number {
  return Math.max(thread.updatedAt, commandActivityAt ?? 0);
}

export function observeThreadWorker(
  job: Job,
  thread: ThreadLike,
  now: number,
  generation = job.version,
  commandActivityAt?: number,
): WorkerLiveness {
  const state = stateForThread(thread);
  const sourceUpdatedAt = threadActivityAt(thread, commandActivityAt);
  return {
    jobId: job.id,
    workerKind: thread.id === job.reviewThreadId ? "review" : "implementation",
    resourceKind: "bb_thread",
    resourceId: thread.id,
    generation,
    state: withStaleness(job, state, sourceUpdatedAt, now),
    sourceUpdatedAt,
    observedAt: now,
    staleNotifiedAt: null,
  };
}

export function observeUnknownWorker(
  job: Job,
  resourceId: string,
  now: number,
  workerKind?: WorkerLiveness["workerKind"],
  generation = job.version,
): WorkerLiveness {
  return {
    jobId: job.id,
    workerKind: workerKind ?? (resourceId === job.reviewThreadId ? "review" : "implementation"),
    resourceKind: "bb_thread",
    resourceId,
    generation,
    state: "unknown",
    sourceUpdatedAt: now,
    observedAt: now,
    staleNotifiedAt: null,
  };
}

export type ThreadRecoverySignal = Readonly<{
  classification: WorkerRecoveryClassification;
  signature: string;
}>;

function recoverySignal(
  workerKind: WorkerLiveness["workerKind"],
  classification: WorkerRecoveryClassification,
  status: string,
): ThreadRecoverySignal {
  const normalized = status.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 80) || "unknown";
  return {
    classification,
    signature: `${classification}:${workerKind}:${normalized}`,
  };
}

/**
 * Classifies only provider facts that are safe to act on. Merely polling a
 * thread is not progress, and a host reconnect remains exempt until its grace
 * window expires. A missing lookup needs a previous missing observation so a
 * transient API failure cannot kill useful work.
 *
 * `commandActivityAt` carries the newest provider-event time the caller has
 * seen. The thread row's own timestamp does not move while a provider works a
 * turn, so without this a reviewer deep in a long diff reads as dead at the
 * watchdog and is retired mid-review.
 */
export function classifyThreadRecovery(
  job: Job,
  thread: ThreadLike | null,
  previous: WorkerLiveness | null,
  now: number,
  workerKind: WorkerLiveness["workerKind"] = previous?.workerKind ?? "implementation",
  commandActivityAt?: number,
): ThreadRecoverySignal | null {
  if (!Number.isInteger(now) || now < 0) throw new TypeError("now must be a non-negative integer");
  if (thread === null) {
    if (!previous || previous.state !== "unknown" || previous.resourceId.length === 0) return null;
    if (now - previous.sourceUpdatedAt <= watchdogMs(job)) return null;
    return recoverySignal(workerKind, "missing", "lookup-missing");
  }

  const displayStatus = thread.runtime.displayStatus;
  const reconnecting = displayStatus === "host-reconnecting" || displayStatus === "waiting-for-host";
  if (reconnecting) {
    const graceExpiresAt = thread.runtime.hostReconnectGraceExpiresAt;
    if (graceExpiresAt !== null && graceExpiresAt > now) return null;
    const firstUnknownAt = previous?.state === "unknown" && previous.resourceId === thread.id
      ? previous.sourceUpdatedAt
      : Math.max(0, thread.updatedAt);
    if (now - firstUnknownAt <= watchdogMs(job)) return null;
    return recoverySignal(workerKind, "missing", displayStatus);
  }

  const state = stateForThread(thread);
  if (state === "failed") return recoverySignal(workerKind, "crash", `${thread.status}:${displayStatus}`);
  const activityAt = threadActivityAt(thread, commandActivityAt);
  if (state === "starting" && now - activityAt > startGraceMs(job)) {
    return recoverySignal(workerKind, "never_started", `${thread.status}:${displayStatus}`);
  }
  if (state === "active" && now - activityAt > watchdogMs(job)) {
    return recoverySignal(workerKind, "no_progress", `${thread.status}:${displayStatus}`);
  }
  return null;
}

function stateForTerminal(terminal: BbTerminalObservation): WorkerLivenessState {
  if (terminal.status === "starting" || terminal.status === "created" || terminal.status === "running") return "active";
  if (terminal.status === "stopping" || terminal.status === "closing") return "stopping";
  if (terminal.status === "exited") return terminal.exitCode === 0 ? "idle" : "failed";
  if (terminal.status === "timed_out" || terminal.status === "aborted" || terminal.status === "failed" || terminal.status === "error") {
    return "failed";
  }
  return "unknown";
}

export function observeTerminalWorker(
  job: Job,
  terminal: BbTerminalObservation,
  workerKind: Extract<WorkerLiveness["workerKind"], "validation" | "merge" | "deploy" | "canary">,
  now: number,
  generation = workerRegistrationGeneration(job, workerKind),
): WorkerLiveness {
  return {
    jobId: job.id,
    workerKind,
    resourceKind: "bb_terminal",
    resourceId: terminal.id,
    generation,
    state: stateForTerminal(terminal),
    sourceUpdatedAt: terminal.updatedAt,
    observedAt: now,
    staleNotifiedAt: null,
  };
}

type LivenessStore = Pick<TelegramAgentStore, "getWorkerLiveness" | "getWorkerLivenessForResource" | "upsertWorkerLiveness" | "markWorkerLivenessNotified"> &
  Partial<Pick<TelegramAgentStore, "getOwner" | "enqueueOutbox" | "upsertExecutorWorkerLiveness" | "markExecutorWorkerLivenessNotified" | "enqueueExecutorStatus">>;

function projectObservation(store: LivenessStore, job: Job, observed: WorkerLiveness, now: number, fence?: ExecutorFence): WorkerLiveness {
  const latest = store.getWorkerLiveness(job.id);
  const current = store.getWorkerLivenessForResource(job.id, observed.resourceId);
  const accepted =
    (latest === null || observed.generation >= latest.generation) &&
    (current === null || observed.generation > current.generation ||
      (observed.generation === current.generation && observed.observedAt >= current.observedAt));
  const persistedObservation = accepted && current !== null &&
      current.generation === observed.generation && current.resourceId === observed.resourceId &&
      (observed.state === "stale" || observed.state === "unknown")
    ? {
        ...observed,
        sourceUpdatedAt: current.state === observed.state
          ? Math.min(current.sourceUpdatedAt, observed.sourceUpdatedAt)
          : observed.sourceUpdatedAt,
        staleNotifiedAt: current.staleNotifiedAt,
      }
    : observed;
  if (accepted) {
    if (fence) {
      if (!store.upsertExecutorWorkerLiveness || !store.upsertExecutorWorkerLiveness({ value: persistedObservation, ...fence })) {
        throw new Error("executor lease was lost before worker-liveness persistence");
      }
    } else {
      store.upsertWorkerLiveness(persistedObservation);
    }
  }
  if (!accepted) return observed;
  const stored = store.getWorkerLivenessForResource(job.id, observed.resourceId) ?? observed;
  if ((stored.state === "stale" || stored.state === "unknown") && stored.staleNotifiedAt === null) {
    const marked = fence
      ? store.markExecutorWorkerLivenessNotified?.({
        jobId: job.id,
        workerGeneration: stored.generation,
        resourceId: stored.resourceId,
        ...fence,
      }) ?? false
      : store.markWorkerLivenessNotified(job.id, stored.generation, now, stored.resourceId);
    if (!marked) {
      if (fence) throw new Error("executor lease was lost before worker-liveness notification");
      return store.getWorkerLivenessForResource(job.id, stored.resourceId) ?? stored;
    }
    const notified = store.getWorkerLivenessForResource(job.id, stored.resourceId) ?? { ...stored, staleNotifiedAt: now };
    const owner = store.getOwner?.();
    if (owner && (store.enqueueOutbox || store.enqueueExecutorStatus)) {
      const payload = renderJobStatus(job, { workerLiveness: notified, now });
      const outbox = {
        logicalKey: `job:${job.id}:status`,
        chatId: owner.chatId,
        messageId: job.statusMessageId,
        payload: persistableJobStatusPayload(payload),
      };
      if (fence) {
        if (!store.enqueueExecutorStatus || !store.enqueueExecutorStatus({ outbox, ...fence })) {
          throw new Error("executor lease was lost before worker status enqueue");
        }
      } else {
        store.enqueueOutbox?.(outbox, now);
      }
    }
    return notified;
  }
  return stored;
}

export function projectUnknownWorker(
  store: Pick<TelegramAgentStore, "getWorkerLiveness" | "getWorkerLivenessForResource" | "upsertWorkerLiveness" | "markWorkerLivenessNotified"> &
    Partial<Pick<TelegramAgentStore, "getOwner" | "enqueueOutbox">>,
  job: Job,
  resourceId: string,
  now: number,
  workerKind?: WorkerLiveness["workerKind"],
  generation?: number,
  fence?: ExecutorFence,
): WorkerLiveness {
  return projectWorkerLiveness(store, job, unknownThreadObservation(resourceId), now, workerKind, generation, fence);
}

export function projectWorkerLiveness(
  store: Pick<TelegramAgentStore, "getWorkerLiveness" | "getWorkerLivenessForResource" | "upsertWorkerLiveness" | "markWorkerLivenessNotified"> &
    Partial<Pick<TelegramAgentStore, "getOwner" | "enqueueOutbox">>,
  job: Job,
  thread: ThreadLike,
  now: number,
  workerKind?: WorkerLiveness["workerKind"],
  generation = job.version,
  fence?: ExecutorFence,
  commandActivityAt?: number,
): WorkerLiveness {
  const observed = observeThreadWorker(
    job,
    workerKind ? { ...thread, id: thread.id } : thread,
    now,
    generation,
    commandActivityAt,
  );
  if (workerKind) observed.workerKind = workerKind;
  return projectObservation(store, job, observed, now, fence);
}

export function projectTerminalLiveness(
  store: LivenessStore,
  job: Job,
  terminal: BbTerminalObservation,
  workerKind: Extract<WorkerLiveness["workerKind"], "validation" | "merge" | "deploy" | "canary">,
  now: number,
  generation = workerRegistrationGeneration(job, workerKind),
  fence?: ExecutorFence,
): WorkerLiveness {
  return projectObservation(store, job, observeTerminalWorker(job, terminal, workerKind, now, generation), now, fence);
}
