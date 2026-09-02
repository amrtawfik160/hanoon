import {
  classifyThreadStall,
  threadStallNotice,
  type DelegatedThreadObservation,
} from "../autonomy/thread-stall";
import { redactError } from "../errors";
import { nextCronOccurrence } from "./cron";

// Re-exported so existing callers keep one import site for scheduling.
export { nextCronOccurrence };
import type {
  DelegationRecord,
  DelegationThreadRecord,
  DelegationThreadState,
  MonitorRecord,
  TelegramAgentStore,
} from "../storage/store";

export type MonitorThreadStatus = "idle" | "active" | "pending" | "starting" | "stopping" | "error" | "missing";

export type MonitorThreads = {
  status(threadId: string): Promise<MonitorThreadStatus>;
  /** The thread's final output, used to summarise a settled delegation member. */
  output(threadId: string): Promise<string>;
  /**
   * Enough of a running thread to tell working from wedged. Optional: a host
   * that cannot answer it simply gets no stall detection, rather than a sweep
   * that fails.
   */
  observe?(threadId: string): Promise<DelegatedThreadObservation | null>;
};

export type MonitorServiceDependencies = {
  store: Pick<
    TelegramAgentStore,
    | "listArmedMonitors"
    | "recordMonitorFired"
    | "failMonitor"
    | "getOwner"
    | "enqueueControllerTurn"
    | "listOpenDelegations"
    | "getDelegation"
    | "settleDelegationThread"
    | "claimDelegationThreadStall"
    | "claimMonitorStall"
    | "recordDelegationFired"
    | "failDelegation"
  >;
  threads: MonitorThreads;
  clock: { now(): number };
  warn?: (message: string) => void;
};

const MONITOR_BATCH = 20;
const DELEGATION_BATCH = 10;
// A fan-out the owner is waiting on cannot hang forever on one wedged thread.
// Six hours is long enough for real work and short enough that a stuck member
// still produces an answer the same day.
export const DELEGATION_JOIN_TIMEOUT_MS = 6 * 60 * 60_000;
const MAX_JOINED_PROMPT = 3_500;
export const DELEGATION_SWEEP_MS = 15_000;
/**
 * How often a watched thread is checked for a stall. Observing costs two BB
 * round-trips per armed watch, and `processDue` runs on every executor tick, so
 * an unpaced check would spend far more on watching than on working. Two
 * minutes against a 45-minute stall threshold detects the same stalls.
 */
export const WATCH_STALL_SWEEP_MS = 2 * 60_000;
// Firing enqueues an ordinary controller turn, which is keyed by Telegram update
// id. Ids are derived from the clock so they stay above real Telegram ids
// (~2.2e8) and keep climbing across restarts, and a counter breaks same-
// millisecond ties within one process.
const MONITOR_UPDATE_ID_BASE = 2_000_000_000;
const MONITOR_CLOCK_EPOCH_MS = 1_700_000_000_000;
const CAPABILITY_NOTICE_POLICY =
  "For capability routing, notify only for a denial, material escalation, substitute use, exhausted recovery, missing mandatory evidence, or an owner decision.";

/**
 * `stopped` marks a schedule's final firing. The wake-up still carries the
 * instruction, but the agent is told the schedule is over, so it reports that
 * rather than leaving the owner waiting on a run that will never come.
 */
function firedPrompt(monitor: MonitorRecord, reason: string, stopped: boolean): string {
  const cleanup = monitor.kind !== "schedule"
    ? ""
    : stopped
      ? `\nThis is this schedule's last firing. Its next run time could not be worked out from \`${monitor.cron}\`, so it is now marked failed and will not fire again. Do the work below, then tell the owner the schedule stopped, and arm a fresh one if it still matters.\n`
      : "\nThis schedule repeats. Cancel it now if its purpose is complete, obsolete, or polling live work; use a thread_idle monitor for live work instead.\n";
  return `A monitor you set has fired.\n\nMonitor id: ${monitor.id}\nMonitor kind: ${monitor.kind}\n` +
    `Why: ${reason}\nWhat you said to do: ${monitor.instruction}\n${cleanup}\n` +
    `Do it now. ${CAPABILITY_NOTICE_POLICY} Message the owner only if something needs their decision or a job finished or failed. If nothing meaningful changed, stay silent.`;
}

/** Settled states report an outcome; a member still running at the join timeout says so. */
function memberLine(member: DelegationThreadRecord): string {
  const where = `${member.title} (${member.threadId})`;
  if (member.state === "running") return `- ${where}: still running when the deadline passed`;
  if (member.state === "failed") return `- ${where}: failed`;
  if (member.state === "missing") return `- ${where}: gone before it reported`;
  return `- ${where}: finished — ${member.summary ?? "no output"}`;
}

function joinedPrompt(delegation: DelegationRecord): string {
  const head = `Work you delegated has finished.\n\nWhat you said to do: ${delegation.instruction}\n\nResults:\n`;
  const tail = `\n\nDo it now. ${CAPABILITY_NOTICE_POLICY} Then tell the owner what happened in one or two sentences. They did not just ask you anything — this is you following up.`;
  // Clip the results, never the instruction or the trailer. Trimming the whole
  // string from its end drops the directive first, leaving the agent a wall of
  // output with no idea what to do or that this is an unprompted follow-up.
  const budget = Math.max(0, MAX_JOINED_PROMPT - head.length - tail.length);
  let lines = "";
  for (const member of delegation.threads) {
    const line = `${lines.length === 0 ? "" : "\n"}${memberLine(member)}`;
    if (lines.length + line.length > budget) {
      const room = budget - lines.length;
      if (room > 1) lines += `${line.slice(0, room - 1)}…`;
      break;
    }
    lines += line;
  }
  return `${head}${lines}${tail}`;
}

function settledState(status: MonitorThreadStatus): Exclude<DelegationThreadState, "running"> | null {
  if (status === "idle") return "finished";
  if (status === "error") return "failed";
  if (status === "missing") return "missing";
  return null;
}

/**
 * Monitors are durable obligations rather than reminders: firing hands the
 * agent its own instruction back as a turn, so it acts and reports without the
 * owner having to ask.
 */
export class MonitorService {
  private lastUpdateId = 0;
  /** Negative infinity, not 0: the first sweep must never be gated by how
   *  close the clock happens to be to the epoch. */
  private lastDelegationSweep = Number.NEGATIVE_INFINITY;
  private lastWatchStallSweep = Number.NEGATIVE_INFINITY;

  public constructor(private readonly dependencies: MonitorServiceDependencies) {}

  private issueUpdateId(now: number): number {
    const fromClock = MONITOR_UPDATE_ID_BASE + Math.max(0, now - MONITOR_CLOCK_EPOCH_MS);
    this.lastUpdateId = Math.max(this.lastUpdateId + 1, fromClock);
    return this.lastUpdateId;
  }

  public async processDue(): Promise<boolean> {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    const monitors = this.dependencies.store.listArmedMonitors(MONITOR_BATCH);
    const sweepAt = this.dependencies.clock.now();
    const stallSweepDue = sweepAt - this.lastWatchStallSweep >= WATCH_STALL_SWEEP_MS;
    if (stallSweepDue) this.lastWatchStallSweep = sweepAt;
    let fired = false;
    for (const monitor of monitors) {
      const now = this.dependencies.clock.now();
      let reason: string | null;
      try {
        reason = await this.dueReason(monitor, now);
      } catch (error) {
        this.dependencies.warn?.(`Monitor ${monitor.id} could not be checked: ${redactError(error).slice(0, 200)}`);
        continue;
      }
      if (reason === null) {
        // Not settled — but a thread that wedges never will be, and the watch
        // would stay armed and silent over it forever.
        if (stallSweepDue) fired = await this.escalateStalledWatch(monitor, owner, now) || fired;
        continue;
      }
      if (!this.fire(monitor, reason, owner, now)) continue;
      fired = true;
    }
    return fired;
  }

  /**
   * Reports a watched thread that has stopped making progress without reaching
   * a status its watch could fire on. The watch is deliberately left armed: the
   * thread may still land, and this is a nudge to go and look, not a verdict
   * that the work is over.
   */
  private async escalateStalledWatch(
    monitor: MonitorRecord,
    owner: { userId: string; chatId: string },
    now: number,
  ): Promise<boolean> {
    if (monitor.kind !== "thread_idle" || !monitor.threadId) return false;
    if (monitor.stallNotifiedAt !== null) return false;
    if (!this.dependencies.threads.observe) return false;
    let observation: DelegatedThreadObservation | null = null;
    try {
      observation = await this.dependencies.threads.observe(monitor.threadId);
    } catch (error) {
      // Unreadable is not evidence of a stall, and one unobservable thread must
      // not cost the rest of the sweep.
      this.dependencies.warn?.(
        `Watched thread ${monitor.threadId} could not be observed: ${redactError(error).slice(0, 200)}`,
      );
      return false;
    }
    const verdict = classifyThreadStall({ observation, now });
    if (verdict.level !== "stalled") return false;
    // Claim first: a crash between the message and the mark would replay it.
    if (!this.dependencies.store.claimMonitorStall({ id: monitor.id, now })) return false;
    this.dependencies.store.enqueueControllerTurn({
      controllerKey: monitor.controllerKey,
      telegramUserId: owner.userId,
      telegramChatId: owner.chatId,
      updateId: this.issueUpdateId(now),
      inputText: threadStallNotice({
        threadId: monitor.threadId,
        // A watch stores no title, and the agent can read one from the thread.
        title: null,
        instruction: monitor.instruction,
        verdict,
        quietForMs: observation === null ? 0 : Math.max(0, now - observation.updatedAt),
      }),
      origin: "system",
      now,
    });
    return true;
  }

  /**
   * Settles delegated threads as they land and hands the agent one joined turn
   * when the last of them does. A fan-out the owner is waiting on must produce
   * an answer even if a member wedges, so the join is also time-bounded.
   */
  public async processDueDelegations(): Promise<boolean> {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    // Paced, or an open fan-out costs eight BB round-trips per executor tick
    // for six hours. Delegated work takes minutes; polling it every second buys
    // nothing and competes with the owner's own turn for the same event loop.
    const sweepAt = this.dependencies.clock.now();
    if (sweepAt - this.lastDelegationSweep < DELEGATION_SWEEP_MS) return false;
    this.lastDelegationSweep = sweepAt;
    let fired = false;
    for (const delegation of this.dependencies.store.listOpenDelegations(DELEGATION_BATCH)) {
      const now = this.dependencies.clock.now();
      // Deliberately not wrapped in a bail-out: a member whose status call
      // always throws must not be able to hold the whole fan-out past its
      // deadline. settleMembers absorbs each member's failure individually.
      await this.settleMembers(delegation, now);
      const current = this.dependencies.store.getDelegation(delegation.id);
      if (!current || current.state !== "open") continue;
      // After settling, so a member that has just landed is never reported as
      // wedged, and before the join, so a stall is raised long before the
      // deadline that would otherwise be the first anyone hears of it.
      if (await this.escalateStalledMembers(current, owner, now)) fired = true;
      const expired = now - current.createdAt >= DELEGATION_JOIN_TIMEOUT_MS;
      // A delegation the tool never finished publishing — the process died
      // between creating it and recording its first member — would otherwise
      // stay open forever and permanently consume one of the two slots.
      if (current.threads.length === 0) {
        if (expired) {
          this.dependencies.store.failDelegation({
            id: current.id,
            error: "Delegation never recorded any work",
            now,
          });
        }
        continue;
      }
      // Joining before the fan-out is sealed reports a partial result and
      // orphans the members still being spawned.
      if (current.sealedAt === null && !expired) continue;
      const settled = current.threads.every((member) => member.state !== "running");
      if (!settled && !expired) continue;
      // Claiming first means a crash mid-fire cannot replay the joined turn.
      if (!this.dependencies.store.recordDelegationFired({ id: current.id, now })) continue;
      this.dependencies.store.enqueueControllerTurn({
        controllerKey: current.controllerKey,
        telegramUserId: owner.userId,
        telegramChatId: owner.chatId,
        updateId: this.issueUpdateId(now),
        inputText: joinedPrompt(current),
        // Not the owner speaking, so this must never be read as their verdict
        // on the previous answer.
        origin: "system",
        now,
      });
      fired = true;
    }
    return fired;
  }

  private async settleMembers(delegation: DelegationRecord, now: number): Promise<void> {
    for (const member of delegation.threads) {
      if (member.state !== "running") continue;
      let status: MonitorThreadStatus;
      try {
        status = await this.dependencies.threads.status(member.threadId);
      } catch (error) {
        // One unreachable member costs that member, not the whole join.
        this.dependencies.warn?.(
          `Delegated thread ${member.threadId} could not be checked: ${redactError(error).slice(0, 200)}`,
        );
        continue;
      }
      const state = settledState(status);
      if (state === null) continue;
      // Only a thread that finished has output worth quoting; a failed or
      // missing one is reported as such rather than given an invented summary.
      let summary: string | null = null;
      if (state === "finished") {
        try {
          summary = await this.dependencies.threads.output(member.threadId);
        } catch {
          summary = null;
        }
      }
      this.dependencies.store.settleDelegationThread({
        delegationId: delegation.id,
        threadId: member.threadId,
        state,
        summary,
        now,
      });
    }
  }

  /**
   * Notices a member that has stopped making progress and hands the agent one
   * turn to deal with it. Nothing is killed and nothing is restarted from here:
   * from outside a thread, wedged and thinking hard look identical, and only
   * reading it tells them apart. So the agent is asked to look and choose —
   * unstick the thread, or tell the owner what is blocked.
   *
   * A member is reported once. A wedged thread stays wedged on every sweep, so
   * without the claim one stall would become an alarm every fifteen seconds.
   */
  private async escalateStalledMembers(
    delegation: DelegationRecord,
    owner: { userId: string; chatId: string },
    now: number,
  ): Promise<boolean> {
    if (!this.dependencies.threads.observe) return false;
    let escalated = false;
    for (const member of delegation.threads) {
      if (member.state !== "running" || member.stallNotifiedAt !== null) continue;
      let observation: DelegatedThreadObservation | null = null;
      try {
        observation = await this.dependencies.threads.observe(member.threadId);
      } catch (error) {
        // Unreadable is not evidence of a stall. One member that cannot be
        // observed costs that member's detection, not the sweep.
        this.dependencies.warn?.(
          `Delegated thread ${member.threadId} could not be observed: ${redactError(error).slice(0, 200)}`,
        );
        continue;
      }
      const verdict = classifyThreadStall({ observation, now });
      if (verdict.level !== "stalled") continue;
      // Claim first: a crash between the message and the mark would otherwise
      // replay the alarm.
      if (!this.dependencies.store.claimDelegationThreadStall({
        delegationId: delegation.id,
        threadId: member.threadId,
        now,
      })) continue;
      this.dependencies.store.enqueueControllerTurn({
        controllerKey: delegation.controllerKey,
        telegramUserId: owner.userId,
        telegramChatId: owner.chatId,
        updateId: this.issueUpdateId(now),
        inputText: threadStallNotice({
          threadId: member.threadId,
          title: member.title,
          instruction: delegation.instruction,
          verdict,
          quietForMs: observation === null ? 0 : Math.max(0, now - observation.updatedAt),
        }),
        origin: "system",
        now,
      });
      escalated = true;
    }
    return escalated;
  }

  private async dueReason(monitor: MonitorRecord, now: number): Promise<string | null> {
    if (monitor.kind === "schedule") {
      return monitor.dueAt !== null && monitor.dueAt <= now ? "its scheduled time arrived" : null;
    }
    if (!monitor.threadId) return null;
    // A thread does not go from idle to working the instant it is messaged, so
    // a watch armed alongside that message would otherwise fire at once and
    // report the work finished before it started. The settling window on a
    // thread watch only ever delays the wake-up; a thread that really has
    // landed is still reported the moment the window passes.
    if (monitor.dueAt !== null && monitor.dueAt > now) return null;
    const status = await this.dependencies.threads.status(monitor.threadId);
    if (status === "idle") return `the thread you were watching (${monitor.threadId}) finished`;
    if (status === "error") return `the thread you were watching (${monitor.threadId}) failed`;
    if (status === "missing") return `the thread you were watching (${monitor.threadId}) is gone`;
    return null;
  }

  private fire(
    monitor: MonitorRecord,
    reason: string,
    owner: { userId: string; chatId: string },
    now: number,
  ): boolean {
    const nextDueAt = monitor.kind === "schedule" && monitor.cron
      ? nextCronOccurrence(monitor.cron, now)
      : null;
    // A schedule whose next run cannot be worked out is over — but it is over
    // *now*, at the moment it was due. Failing it without firing swallowed the
    // one wake-up the owner was waiting on: the work never ran, and nothing
    // said so, so from the outside the schedule simply stopped existing. Mark
    // it failed first, because that is what stops the replay, then still
    // deliver its last firing.
    const stopped = monitor.kind === "schedule" && nextDueAt === null;
    // Claiming the monitor first means a crash mid-fire cannot replay it.
    const claimed = stopped
      ? this.dependencies.store.failMonitor({ id: monitor.id, error: "Schedule could not be advanced", now })
      : this.dependencies.store.recordMonitorFired({ id: monitor.id, nextDueAt, now });
    if (!claimed) return false;
    this.dependencies.store.enqueueControllerTurn({
      controllerKey: monitor.controllerKey,
      telegramUserId: owner.userId,
      telegramChatId: owner.chatId,
      updateId: this.issueUpdateId(now),
      inputText: firedPrompt(monitor, reason, stopped),
      origin: "system",
      now,
    });
    return true;
  }
}
