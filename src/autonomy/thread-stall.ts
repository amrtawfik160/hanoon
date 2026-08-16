/**
 * Whether a thread the agent delegated work to has gone quiet, and why.
 *
 * A fan-out settles when its members reach a terminal status. A member that
 * wedges reaches nothing, so until now it sat unremarked until the six-hour
 * join deadline swept it up — which is to say a stalled thread was noticed
 * only when someone happened to look.
 *
 * Two decisions shape this. The first is the form: a pure, read-only,
 * three-level verdict that names its reason and can never raise or write
 * anything, so the caller decides what a verdict is worth. The second is the
 * harder-won lesson behind it: silence is not evidence of death. Inferring
 * liveness from timestamps kills working sessions, so the only safe rule is to
 * act on evidence and surface everything else to a person.
 *
 * So nothing here kills anything. The worst verdict available is "tell someone
 * about this one", which is what an agent that cannot see inside a thread is
 * actually entitled to conclude.
 */

/**
 * A thread asked to work and still not started. Twenty minutes, sized at four
 * times a normal cold start, because a heavy context can spend a long time
 * before its first visible token, and a BB thread has an environment to
 * provision before it can do anything at all.
 */
export const NEVER_STARTED_GRACE_MS = 20 * 60_000;

/** Quiet long enough to be worth watching, not long enough to be worth saying. */
export const NO_PROGRESS_SUSPECT_MS = 15 * 60_000;

/**
 * Quiet long enough to say so. Well under the six-hour join deadline, which is
 * the point: the deadline is a backstop, not a detector.
 */
export const NO_PROGRESS_STALL_MS = 45 * 60_000;

export type ThreadStallLevel = "healthy" | "suspect" | "stalled";

export type ThreadStallReason =
  | "recent_activity"
  | "waiting_on_owner"
  | "settled"
  | "host_reconnecting"
  | "host_unreachable"
  | "never_started"
  | "no_progress"
  | "unreadable";

export type ThreadStallVerdict = Readonly<{
  level: ThreadStallLevel;
  reason: ThreadStallReason;
  /** Whatever the verdict was drawn from, for the message that reports it. */
  signals: Readonly<Record<string, number | string | boolean | null>>;
}>;

export type DelegatedThreadObservation = Readonly<{
  status: string;
  runtimeStatus: string;
  /** When the work was asked for. */
  startedAt: number;
  /** Last time the thread showed any sign of life. */
  updatedAt: number;
  hasPendingInteraction: boolean;
  hostReconnectGraceExpiresAt: number | null;
}>;

const SETTLED_STATUSES: ReadonlySet<string> = new Set(["idle", "error", "missing", "completed", "failed"]);
const STARTING_STATUSES: ReadonlySet<string> = new Set(["starting", "provisioning", "created"]);
const RECONNECTING_STATUSES: ReadonlySet<string> = new Set(["host-reconnecting", "waiting-for-host"]);

function healthy(reason: ThreadStallReason, signals: ThreadStallVerdict["signals"] = {}): ThreadStallVerdict {
  return { level: "healthy", reason, signals };
}

function usableTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Classify one delegated thread. Pure, read-only, and never throws: anything it
 * cannot make sense of comes back healthy, because an unreadable observation is
 * not evidence of a problem and a detector that cries wolf gets switched off.
 */
export function classifyThreadStall(input: Readonly<{
  observation: DelegatedThreadObservation | null;
  now: number;
}>): ThreadStallVerdict {
  const observed = input.observation;
  if (observed === null || !usableTimestamp(input.now)) {
    return healthy("unreadable", {});
  }
  if (!usableTimestamp(observed.startedAt) || !usableTimestamp(observed.updatedAt)) {
    return healthy("unreadable", {});
  }

  // A settled thread is the join's business, not this one's.
  if (SETTLED_STATUSES.has(observed.status) || SETTLED_STATUSES.has(observed.runtimeStatus)) {
    return healthy("settled", { status: observed.status, runtimeStatus: observed.runtimeStatus });
  }

  // A thread waiting on a person is waiting correctly, however long it takes.
  // Firing a stall against someone's thinking time is how a detector teaches
  // people to ignore it.
  if (observed.hasPendingInteraction) {
    return healthy("waiting_on_owner", { waitingForMs: Math.max(0, input.now - observed.updatedAt) });
  }

  const reconnecting = RECONNECTING_STATUSES.has(observed.runtimeStatus);
  if (reconnecting) {
    const grace = observed.hostReconnectGraceExpiresAt;
    if (grace !== null && grace > input.now) {
      return healthy("host_reconnecting", { graceRemainingMs: grace - input.now });
    }
    return {
      level: "stalled",
      reason: "host_unreachable",
      signals: { runtimeStatus: observed.runtimeStatus, quietForMs: Math.max(0, input.now - observed.updatedAt) },
    };
  }

  const quietForMs = Math.max(0, input.now - observed.updatedAt);
  const ageMs = Math.max(0, input.now - observed.startedAt);

  // Never started is judged on the thread's whole life, not its last activity:
  // a thread stuck provisioning keeps touching itself without ever working.
  if (STARTING_STATUSES.has(observed.status) || STARTING_STATUSES.has(observed.runtimeStatus)) {
    if (ageMs > NEVER_STARTED_GRACE_MS) {
      return {
        level: "stalled",
        reason: "never_started",
        signals: { ageMs, graceMs: NEVER_STARTED_GRACE_MS, runtimeStatus: observed.runtimeStatus },
      };
    }
    return healthy("recent_activity", { ageMs, graceMs: NEVER_STARTED_GRACE_MS });
  }

  if (quietForMs >= NO_PROGRESS_STALL_MS) {
    return {
      level: "stalled",
      reason: "no_progress",
      signals: { quietForMs, stallThresholdMs: NO_PROGRESS_STALL_MS, status: observed.status },
    };
  }
  if (quietForMs >= NO_PROGRESS_SUSPECT_MS) {
    return {
      level: "suspect",
      reason: "no_progress",
      signals: { quietForMs, suspectThresholdMs: NO_PROGRESS_SUSPECT_MS, stallThresholdMs: NO_PROGRESS_STALL_MS },
    };
  }
  return healthy("recent_activity", { quietForMs });
}

const REASON_WORDS: Record<ThreadStallReason, string> = {
  recent_activity: "it is working",
  waiting_on_owner: "it is waiting for an answer",
  settled: "it has finished",
  host_reconnecting: "its machine is reconnecting",
  host_unreachable: "its machine has not come back",
  never_started: "it never started working",
  no_progress: "it has shown no sign of life",
  unreadable: "it could not be read",
};

/**
 * What the agent is handed when a delegated thread stalls. It is asked to look
 * and then choose — nudge the thread or tell the owner — rather than being
 * given a fixed remedy, because from out here the two cases are
 * indistinguishable and only reading the thread separates them.
 */
export function threadStallNotice(input: Readonly<{
  threadId: string;
  /** Null for a watch, which stores no title; the agent reads one from the thread. */
  title: string | null;
  instruction: string;
  verdict: ThreadStallVerdict;
  quietForMs: number;
}>): string {
  const minutes = Math.round(input.quietForMs / 60_000);
  const where = input.title === null ? input.threadId : `${input.title} (${input.threadId})`;
  // Neutral about how the thread came to be watched: a watch can follow work
  // the agent started or work the owner did, and claiming it was delegated
  // would be false half the time.
  return "A thread you are following has stopped making progress.\n\n" +
    `Thread: ${where}\n` +
    `What you asked for: ${input.instruction}\n` +
    `What it looks like: ${REASON_WORDS[input.verdict.reason]}, for about ${minutes} minutes.\n\n` +
    "Read the thread before you decide anything: what it is doing now, what it last said, and whether it is " +
    "blocked on something it cannot get past. Then do one of two things. If it can be unstuck, say so to the " +
    "thread and let it carry on. If it cannot, or if the decision is not yours, tell the owner in one or two " +
    "plain sentences what is stuck and what you need from them. If it turns out to be working after all, say " +
    "nothing at all.";
}
