import type { Job, WorkerLiveness, WorkerLivenessState } from "../domain/models";
import type { TelegramAgentStore } from "../storage/store";
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
  const role = workerKind === "implementation" ? 1 : workerKind === "review" ? 2 : workerKind === "validation" ? 3 : 4;
  return job.version * 10 + role;
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
  workerKind: Extract<WorkerLiveness["workerKind"], "validation" | "merge">,
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
  Partial<Pick<TelegramAgentStore, "getOwner" | "enqueueOutbox">>;

function projectObservation(store: LivenessStore, job: Job, observed: WorkerLiveness, now: number): WorkerLiveness {
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
  if (accepted) store.upsertWorkerLiveness(persistedObservation);
  if (!accepted) return observed;
  const stored = store.getWorkerLiveness(job.id) ?? observed;
  if ((stored.state === "stale" || stored.state === "unknown") && stored.staleNotifiedAt === null) {
    if (!store.markWorkerLivenessNotified(job.id, stored.generation, now)) {
      return store.getWorkerLiveness(job.id) ?? stored;
    }
    const notified = store.getWorkerLiveness(job.id) ?? { ...stored, staleNotifiedAt: now };
    const owner = store.getOwner?.();
    if (owner && store.enqueueOutbox) {
      const payload = renderJobStatus(job, { workerLiveness: notified, now });
      store.enqueueOutbox({
        logicalKey: `job:${job.id}:status`,
        chatId: owner.chatId,
        messageId: job.statusMessageId,
        payload: persistableJobStatusPayload(payload),
      }, now);
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
): WorkerLiveness {
  return projectWorkerLiveness(store, job, unknownThreadObservation(resourceId), now, workerKind, generation);
}

export function projectWorkerLiveness(
  store: Pick<TelegramAgentStore, "getWorkerLiveness" | "upsertWorkerLiveness" | "markWorkerLivenessNotified"> &
    Partial<Pick<TelegramAgentStore, "getOwner" | "enqueueOutbox">>,
  job: Job,
  thread: ThreadLike,
  now: number,
  workerKind?: WorkerLiveness["workerKind"],
  generation = job.version,
): WorkerLiveness {
  const observed = observeThreadWorker(
    job,
    workerKind ? { ...thread, id: thread.id } : thread,
    now,
    generation,
  );
  if (workerKind) observed.workerKind = workerKind;
  return projectObservation(store, job, observed, now);
}

export function projectTerminalLiveness(
  store: LivenessStore,
  job: Job,
  terminal: BbTerminalObservation,
  workerKind: Extract<WorkerLiveness["workerKind"], "validation" | "merge">,
  now: number,
  generation = workerRegistrationGeneration(job, workerKind),
): WorkerLiveness {
  return projectObservation(store, job, observeTerminalWorker(job, terminal, workerKind, now, generation), now);
}
