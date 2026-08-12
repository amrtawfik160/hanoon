import type { Job, WorkerLiveness, WorkerLivenessState } from "../domain/models";
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
  if (thread.status === "starting" || thread.runtime.displayStatus === "starting" || thread.runtime.displayStatus === "provisioning") {
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

function withStaleness(job: Job, state: WorkerLivenessState, sourceUpdatedAt: number, observedAt: number): WorkerLivenessState {
  if ((state === "starting" || state === "active") && observedAt - sourceUpdatedAt > watchdogMs(job)) return "stale";
  return state;
}

export function observeThreadWorker(
  job: Job,
  thread: ThreadLike,
  now: number,
  generation = job.version,
): WorkerLiveness {
  const state = stateForThread(thread);
  return {
    jobId: job.id,
    workerKind: thread.id === job.reviewThreadId ? "review" : "implementation",
    resourceKind: "bb_thread",
    resourceId: thread.id,
    generation,
    state: withStaleness(job, state, thread.updatedAt, now),
    sourceUpdatedAt: thread.updatedAt,
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
    sourceUpdatedAt: 0,
    observedAt: now,
    staleNotifiedAt: null,
  };
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

type LivenessStore = Pick<TelegramAgentStore, "getWorkerLiveness" | "upsertWorkerLiveness" | "markWorkerLivenessNotified"> &
  Partial<Pick<TelegramAgentStore, "getOwner" | "enqueueOutbox" | "upsertExecutorWorkerLiveness" | "markExecutorWorkerLivenessNotified" | "enqueueExecutorStatus">>;

function projectObservation(store: LivenessStore, job: Job, observed: WorkerLiveness, now: number, fence?: ExecutorFence): WorkerLiveness {
  const current = store.getWorkerLiveness(job.id);
  const accepted =
    current === null ||
    observed.generation > current.generation ||
    (observed.generation === current.generation && observed.resourceId === current.resourceId && observed.observedAt >= current.observedAt);
  const persistedObservation = accepted && current !== null &&
      current.generation === observed.generation && current.resourceId === observed.resourceId &&
      (observed.state === "stale" || observed.state === "unknown")
    ? { ...observed, staleNotifiedAt: current.staleNotifiedAt }
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
  const stored = store.getWorkerLiveness(job.id) ?? observed;
  if ((stored.state === "stale" || stored.state === "unknown") && stored.staleNotifiedAt === null) {
    const marked = fence
      ? store.markExecutorWorkerLivenessNotified?.({
        jobId: job.id,
        workerGeneration: stored.generation,
        ...fence,
      }) ?? false
      : store.markWorkerLivenessNotified(job.id, stored.generation, now);
    if (!marked) {
      if (fence) throw new Error("executor lease was lost before worker-liveness notification");
      return store.getWorkerLiveness(job.id) ?? stored;
    }
    const notified = store.getWorkerLiveness(job.id) ?? { ...stored, staleNotifiedAt: now };
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
  store: Pick<TelegramAgentStore, "getWorkerLiveness" | "upsertWorkerLiveness" | "markWorkerLivenessNotified"> &
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
  store: Pick<TelegramAgentStore, "getWorkerLiveness" | "upsertWorkerLiveness" | "markWorkerLivenessNotified"> &
    Partial<Pick<TelegramAgentStore, "getOwner" | "enqueueOutbox">>,
  job: Job,
  thread: ThreadLike,
  now: number,
  workerKind?: WorkerLiveness["workerKind"],
  generation = job.version,
  fence?: ExecutorFence,
): WorkerLiveness {
  const observed = observeThreadWorker(
    job,
    workerKind ? { ...thread, id: thread.id } : thread,
    now,
    generation,
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
