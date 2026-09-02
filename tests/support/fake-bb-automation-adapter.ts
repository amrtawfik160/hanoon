import { vi } from "vitest";
import {
  BbAutomationNotFoundError,
  type BbAutomation,
  type BbAutomationDefinition,
  type BbAutomationRun,
} from "../../src/bb/automation";
import type { ManagedAutomationAdapter } from "../../src/services/managed-automation-service";

/**
 * What BB would read back for a definition it accepted exactly. Tests that
 * need drift override the relevant field.
 */
export function observedBbAutomation(
  value: BbAutomationDefinition,
  now: number,
  overrides: Partial<BbAutomation> = {},
): BbAutomation {
  return {
    id: "auto_1",
    projectId: value.projectId,
    name: value.name,
    enabled: true,
    trigger: value.trigger.kind === "cron"
      ? { triggerType: "schedule", cron: value.trigger.cron, timezone: value.trigger.timezone }
      : { triggerType: "once", runAt: Date.parse(value.trigger.at) },
    execution: value.mode === "agent"
      ? {
          mode: "agent",
          prompt: value.prompt,
          providerId: value.providerId,
          model: value.model,
          ...(value.reasoningLevel ? { reasoningLevel: value.reasoningLevel } : {}),
          ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}),
          permissionMode: value.permissionMode,
          environment: { type: "project-default" },
        }
      : {
          mode: "script",
          interpreter: value.interpreter,
          timeoutMs: value.timeoutMs,
          script: value.source.kind === "inline" ? value.source.script : "",
          env: value.env,
          storedScriptPath: "/managed/script.sh",
        },
    origin: "agent",
    createdByThreadId: "thr_controller",
    nextRunAt: now + 60_000,
    lastRunAt: null,
    runCount: 0,
    lastRunStatus: null,
    lastRunThreadId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * An in-memory BB automation host at the terminal boundary. It behaves like
 * the real CLI where the service depends on it: create acknowledges, list and
 * show read back what is stored, delete of an absent id is BB's exact
 * not-found result.
 */
export function createFakeBbAutomationAdapter(now: number) {
  const automations = new Map<string, BbAutomation>();
  const runs = new Map<string, BbAutomationRun[]>();
  const create = vi.fn(async ({ definition: value }: { definition: BbAutomationDefinition }) => {
    const created = observedBbAutomation(value, now, { id: `auto_${automations.size + 1}` });
    automations.set(created.id, created);
    return created;
  });
  const adapter: ManagedAutomationAdapter = {
    create,
    list: vi.fn(async ({ projectId }) =>
      [...automations.values()].filter((automation) => automation.projectId === projectId)),
    update: vi.fn(async ({ automationId, definition: value }) => {
      const found = automations.get(automationId);
      if (!found) throw new Error("missing automation");
      const updated = observedBbAutomation(value, now, {
        id: automationId,
        enabled: found.enabled,
        createdAt: found.createdAt,
        updatedAt: now + 1,
      });
      automations.set(automationId, updated);
      return updated;
    }),
    show: vi.fn(async ({ automationId }) => {
      const found = automations.get(automationId);
      if (!found) throw new Error("missing automation");
      return found;
    }),
    setEnabled: vi.fn(async ({ automationId, enabled }) => {
      const found = automations.get(automationId);
      if (!found) throw new Error("missing automation");
      const updated = { ...found, enabled, nextRunAt: enabled ? now + 60_000 : null };
      automations.set(automationId, updated);
      return updated;
    }),
    runNow: vi.fn(async ({ automationId }): Promise<BbAutomationRun> => ({
      id: "run_manual",
      automationId,
      runMode: "agent",
      threadId: "thr_run_manual",
      status: "succeeded",
      trigger: "manual",
      skipReason: null,
      error: null,
      output: "Done.",
      exitCode: null,
      scheduledFor: now,
      startedAt: now + 1,
      finishedAt: now + 2,
    })),
    runs: vi.fn(async ({ automationId }) => runs.get(automationId) ?? []),
    delete: vi.fn(async ({ automationId }) => {
      if (!automations.delete(automationId)) throw new BbAutomationNotFoundError();
    }),
  };
  return { adapter, automations, runs, create };
}
