import { CronExpressionParser } from "cron-parser";
import { redactError } from "../errors";
import type { MonitorRecord, TelegramAgentStore } from "../storage/store";

export type MonitorThreads = {
  status(threadId: string): Promise<"idle" | "active" | "starting" | "stopping" | "error" | "missing">;
};

export type MonitorServiceDependencies = {
  store: Pick<
    TelegramAgentStore,
    "listArmedMonitors" | "recordMonitorFired" | "failMonitor" | "getOwner" | "enqueueControllerTurn"
  >;
  threads: MonitorThreads;
  clock: { now(): number };
  warn?: (message: string) => void;
};

const MONITOR_BATCH = 20;
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
