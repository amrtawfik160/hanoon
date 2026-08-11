import { CronExpressionParser } from "cron-parser";
import { redactError } from "../errors";
import type {
  DelegationRecord,
  DelegationThreadRecord,
  DelegationThreadState,
  MonitorRecord,
  TelegramAgentStore,
} from "../storage/store";

export type MonitorThreadStatus = "idle" | "active" | "starting" | "stopping" | "error" | "missing";

export type MonitorThreads = {
  status(threadId: string): Promise<MonitorThreadStatus>;
  /** The thread's final output, used to summarise a settled delegation member. */
  output(threadId: string): Promise<string>;
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
    | "recordDelegationFired"
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
// Firing enqueues an ordinary controller turn, which is keyed by Telegram update
// id. Ids are derived from the clock so they stay above real Telegram ids
// (~2.2e8) and keep climbing across restarts, and a counter breaks same-
// millisecond ties within one process.
const MONITOR_UPDATE_ID_BASE = 2_000_000_000;
const MONITOR_CLOCK_EPOCH_MS = 1_700_000_000_000;

export function nextCronOccurrence(cron: string, after: number): number | null {
  try {
    return CronExpressionParser.parse(cron, { currentDate: new Date(after) }).next().getTime();
  } catch {
    return null;
  }
}

function firedPrompt(monitor: MonitorRecord, reason: string): string {
  return `A monitor you set has fired.\n\nWhy: ${reason}\nWhat you said to do: ${monitor.instruction}\n\n` +
    "Do it now, then tell the owner what happened in one or two sentences. They did not just ask you anything — this is you following up.";
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
  const lines = delegation.threads.map(memberLine).join("\n");
  const prompt = `Work you delegated has finished.\n\n` +
    `What you said to do: ${delegation.instruction}\n\nResults:\n${lines}\n\n` +
    "Do it now, then tell the owner what happened in one or two sentences. They did not just ask you anything — this is you following up.";
  return prompt.length <= MAX_JOINED_PROMPT ? prompt : `${prompt.slice(0, MAX_JOINED_PROMPT - 1)}…`;
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
      if (reason === null) continue;
      if (!this.fire(monitor, reason, owner, now)) continue;
      fired = true;
    }
    return fired;
  }

  /**
   * Settles delegated threads as they land and hands the agent one joined turn
   * when the last of them does. A fan-out the owner is waiting on must produce
   * an answer even if a member wedges, so the join is also time-bounded.
   */
  public async processDueDelegations(): Promise<boolean> {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    let fired = false;
    for (const delegation of this.dependencies.store.listOpenDelegations(DELEGATION_BATCH)) {
      const now = this.dependencies.clock.now();
      try {
        await this.settleMembers(delegation, now);
      } catch (error) {
        this.dependencies.warn?.(
          `Delegation ${delegation.id} could not be checked: ${redactError(error).slice(0, 200)}`,
        );
        continue;
      }
      const current = this.dependencies.store.getDelegation(delegation.id);
      if (!current || current.state !== "open" || current.threads.length === 0) continue;
      const settled = current.threads.every((member) => member.state !== "running");
      const expired = now - current.createdAt >= DELEGATION_JOIN_TIMEOUT_MS;
      if (!settled && !expired) continue;
      // Claiming first means a crash mid-fire cannot replay the joined turn.
      if (!this.dependencies.store.recordDelegationFired({ id: current.id, now })) continue;
      this.dependencies.store.enqueueControllerTurn({
        controllerKey: current.controllerKey,
        telegramUserId: owner.userId,
        telegramChatId: owner.chatId,
        updateId: this.issueUpdateId(now),
        inputText: joinedPrompt(current),
        now,
      });
      fired = true;
    }
    return fired;
  }

  private async settleMembers(delegation: DelegationRecord, now: number): Promise<void> {
    for (const member of delegation.threads) {
      if (member.state !== "running") continue;
      const state = settledState(await this.dependencies.threads.status(member.threadId));
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

  private async dueReason(monitor: MonitorRecord, now: number): Promise<string | null> {
    if (monitor.kind === "schedule") {
      return monitor.dueAt !== null && monitor.dueAt <= now ? "its scheduled time arrived" : null;
    }
    if (!monitor.threadId) return null;
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
    if (monitor.kind === "schedule" && nextDueAt === null) {
      this.dependencies.store.failMonitor({ id: monitor.id, error: "Schedule could not be advanced", now });
      return false;
    }
    // Claiming the monitor first means a crash mid-fire cannot replay it.
    if (!this.dependencies.store.recordMonitorFired({ id: monitor.id, nextDueAt, now })) return false;
    this.dependencies.store.enqueueControllerTurn({
      controllerKey: monitor.controllerKey,
      telegramUserId: owner.userId,
      telegramChatId: owner.chatId,
      updateId: this.issueUpdateId(now),
      inputText: firedPrompt(monitor, reason),
      now,
    });
    return true;
  }
}
