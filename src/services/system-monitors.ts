import { redactError } from "../errors";
import type { TelegramAgentStore } from "../storage/store";
import {
  BbAutomationProjectUnavailableError,
  DEFAULT_BB_AGENT_AUTOMATION_RESULT_CONTRACT,
  DEFAULT_BB_AGENT_AUTOMATION_TIMEOUT_MS,
} from "../bb/automation";
import { nextCronOccurrence } from "./monitor-service";
import {
  ManagedAutomationService,
  migrateLegacyClockMonitor,
} from "./managed-automation-service";

/**
 * Monitors the plugin sets for itself. The agent already knows how to act on a
 * fired monitor, so self-maintenance needs no new machinery — only durable
 * obligations that exist without the owner having to remember to ask.
 *
 * Each instruction ends by telling the agent to stay silent when nothing needs
 * a person. A report that arrives every day whether or not anything happened is
 * a report the owner stops reading.
 */
export type SystemMonitorDefinition = Readonly<{
  systemKey: string;
  cron: string;
  instruction: string;
}>;

export const SYSTEM_MONITORS: readonly SystemMonitorDefinition[] = Object.freeze([
  Object.freeze({
    systemKey: "system-stale-jobs",
    // Early morning, before the owner starts, so a blocked job is known by then.
    cron: "0 7 * * *",
    instruction:
      "Sweep for work that has stopped needing you and started needing them. Read your scorecard and your health, then list jobs. Check `projectsHeldByFailedJobs` first: a failed job keeps its project locked until it is retried or cancelled, so every one of those is a project that can start no new work until the owner decides. Then look for anything blocked or sitting unchanged for a long time. Message the owner only about items that need a decision, one line each, worst first. If everything is moving or idle by choice, say nothing at all.",
  }),
  Object.freeze({
    systemKey: "system-memory-audit",
    cron: "0 8 * * 1",
    instruction:
      "Audit what you remember. Read your scorecard and look at the memory figures: how many are live, how many were aged out, how many are barely trusted, and how many you learned from finished jobs. Recall a few of the weakest and judge whether they are still true. Forget the ones that are wrong or useless. Message the owner only if you changed something worth knowing about or found a belief you cannot resolve on your own.",
  }),
  Object.freeze({
    systemKey: "system-autonomy-scorecard",
    cron: "0 17 * * 5",
    instruction:
      "Write the weekly scorecard. Read it from durable state and report: work completed, blocked, and cancelled; decisions you needed from the owner; remediation cycles; delivery retries and anything undeliverable. Give the numbers you have and the window they cover, never a rate you cannot support. Keep it to a short message; end with the one thing most worth their attention this week.",
  }),
]);

export function systemAutomationInstallationComplete(installed: number): boolean {
  return installed === SYSTEM_MONITORS.length;
}

export type SystemAutomationInstaller = Readonly<{
  store: Pick<
    TelegramAgentStore,
    "getOwner" | "getControllerForOwner" | "listSystemMonitors" | "cancelMonitor" | "ensureSystemMonitor"
  >;
  service: ManagedAutomationService;
  providerId: string;
  execution: Readonly<{
    model: string;
    reasoningLevel?: string;
    serviceTier?: "default" | "fast";
    permissionMode: "accept-edits" | "auto" | "full";
  }>;
  clock: { now(): number };
  signal?: AbortSignal;
  warn?: (message: string) => void;
}>;

/**
 * Installs reasoning-based upkeep in BB's scheduler. Existing plugin-local
 * schedules are handed over only after BB reads back an active next run.
 *
 * BB refuses to host automations for some projects, notably its personal
 * project, which is where the controller runs on a single-owner installation.
 * There the upkeep stays a plugin-local clock schedule, which the monitor
 * service already fires, and the installer says so instead of retrying BB.
 */
export async function installSystemAutomations(dependencies: SystemAutomationInstaller): Promise<number> {
  const owner = dependencies.store.getOwner();
  if (!owner) return 0;
  const controller = dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
  if (!controller?.projectId || !controller.hostId) return 0;
  const now = dependencies.clock.now();
  const legacy = new Map(
    dependencies.store.listSystemMonitors().map((monitor) => [monitor.systemKey, monitor] as const),
  );
  let installed = 0;
  for (const definition of SYSTEM_MONITORS) {
    try {
      const old = legacy.get(definition.systemKey);
      if (old?.state === "armed") {
        await migrateLegacyClockMonitor({
          monitor: old,
          store: dependencies.store,
          service: dependencies.service,
          scope: { kind: "host", hostId: controller.hostId, cwd: null },
          projectId: controller.projectId,
          controllerKey: controller.controllerKey,
          providerId: dependencies.providerId,
          model: dependencies.execution.model,
          reasoningLevel: dependencies.execution.reasoningLevel,
          serviceTier: dependencies.execution.serviceTier,
          permissionMode: dependencies.execution.permissionMode,
          hostId: controller.hostId,
          now,
          signal: dependencies.signal,
        });
      } else {
        await dependencies.service.create({
          scope: { kind: "host", hostId: controller.hostId, cwd: null },
          controllerKey: controller.controllerKey,
          sourceKey: definition.systemKey,
          definition: {
            mode: "agent",
            projectId: controller.projectId,
            name: `Hanoon ${definition.systemKey}`,
            trigger: { kind: "cron", cron: definition.cron, timezone: "Etc/UTC" },
            prompt: definition.instruction,
            providerId: dependencies.providerId,
            model: dependencies.execution.model,
            ...(dependencies.execution.reasoningLevel
              ? { reasoningLevel: dependencies.execution.reasoningLevel }
              : {}),
            ...(dependencies.execution.serviceTier
              ? { serviceTier: dependencies.execution.serviceTier }
              : {}),
            permissionMode: dependencies.execution.permissionMode,
            target: { kind: "project-default" },
            timeoutMs: DEFAULT_BB_AGENT_AUTOMATION_TIMEOUT_MS,
            resultContract: DEFAULT_BB_AGENT_AUTOMATION_RESULT_CONTRACT,
          },
          authority: {
            source: "system",
            controllerKey: controller.controllerKey,
            projectId: controller.projectId,
            hostId: controller.hostId,
            mayWidenAutomation: false,
          },
          notificationPolicy: "material",
          now,
          signal: dependencies.signal,
        });
      }
      installed += 1;
    } catch (error) {
      if (error instanceof BbAutomationProjectUnavailableError) {
        const dueAt = nextCronOccurrence(definition.cron, now);
        if (dueAt !== null) {
          dependencies.store.ensureSystemMonitor({
            systemKey: definition.systemKey,
            controllerKey: controller.controllerKey,
            cron: definition.cron,
            instruction: definition.instruction,
            dueAt,
            now,
          });
          installed += 1;
          dependencies.warn?.(
            `BB automations are not available for project ${error.projectId}; ${definition.systemKey} stays a plugin-local schedule`,
          );
          continue;
        }
      }
      dependencies.warn?.(
        `System automation ${definition.systemKey} could not be installed: ${redactError(error).slice(0, 200)}`,
      );
    }
  }
  return installed;
}
