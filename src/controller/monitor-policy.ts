import type { MonitorRecord, TelegramAgentStore } from "../storage/store";

const LIVE_WORK_RESOURCE = /\b(?:job|thread|worker|pull request|pr|queue|claim|lock)\b/i;
const LIVE_WORK_STATE = /\b(?:active|blocked|cancelled|completed|draining|failed|finish(?:ed|es|ing)?|holding|idle|locked|queued|running|stale|stopped|stuck|waiting)\b/i;
const POLLING_ACTION = /\b(?:check(?:ing)?|poll(?:ing)?|recheck(?:ing)?|retr(?:y|ying)|resum(?:e|ing)|watch(?:ing)?|wait(?:ing)?)\b/i;

export function isLiveWorkPollingSchedule(instruction: string): boolean {
  return LIVE_WORK_RESOURCE.test(instruction) &&
    LIVE_WORK_STATE.test(instruction) &&
    POLLING_ACTION.test(instruction);
}

type MonitorPolicyStore = Pick<TelegramAgentStore, "listArmedMonitors" | "cancelMonitor">;

export function retireLiveWorkPollingSchedules(store: MonitorPolicyStore, now: number): number {
  let retired = 0;
  for (const monitor of store.listArmedMonitors(100)) {
    if (!isRetirablePoller(monitor)) continue;
    if (store.cancelMonitor(monitor.id, now)) retired += 1;
  }
  return retired;
}

function isRetirablePoller(monitor: MonitorRecord): boolean {
  return monitor.systemKey === null && monitor.kind === "schedule" &&
    isLiveWorkPollingSchedule(monitor.instruction);
}
