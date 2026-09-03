import { vi } from "vitest";
import {
  BbAutomationNotFoundError,
  assertAutomationMatches,
  type BbAutomation,
  type BbAutomationDefinition,
  type BbAutomationRun,
} from "../../src/bb/automation";
import type { ManagedAutomationAdapter } from "../../src/services/managed-automation-service";
import type {
  ManagedAutomationObservation,
  ManagedAutomationProviderIdentity,
} from "../../src/domain/managed-automation";

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

/** BB's stored name for an automation Hanoon owns, carrying its ownership marker. */
function providerName(name: string, identity?: ManagedAutomationProviderIdentity): string {
  return identity ? `${name} [${identity.ownershipMarker}]` : name;
}

/** The provider-neutral projection the adapter hands the service. */
export function bbAutomationObservation(
  value: BbAutomation,
  expectedDefinition?: BbAutomationDefinition,
): ManagedAutomationObservation {
  return {
    providerAutomationId: value.id,
    projectId: value.projectId,
    name: expectedDefinition?.name ?? value.name,
    enabled: value.enabled,
    trigger: value.trigger.triggerType === "schedule"
      ? { kind: "cron", cron: value.trigger.cron, timezone: value.trigger.timezone }
      : { kind: "once", at: new Date(value.trigger.runAt).toISOString() },
    mode: value.execution.mode,
    target: value.execution.mode === "script"
      ? null
      : value.execution.targetThreadId
        ? { kind: "target-thread", threadId: value.execution.targetThreadId }
        : value.execution.environment.type === "project-default"
          ? { kind: "project-default" }
          : value.execution.environment.type === "reuse"
            ? { kind: "environment", environmentId: value.execution.environment.environmentId }
            : { kind: "new-worktree", baseBranch: value.execution.environment.workspace.baseBranch.name },
    nextRunAt: value.nextRunAt,
    lastRunAt: value.lastRunAt,
    runCount: value.runCount,
    lastRunStatus: value.lastRunStatus,
    lastRunThreadId: value.lastRunThreadId,
    lastError: value.lastError,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/**
 * An in-memory BB automation host at the terminal boundary. It behaves like
 * the real CLI where the service depends on it: create acknowledges with a
 * receipt carrying the operation's ownership marker, show reads back what is
 * stored, `findByDefinition` matches only an exact definition, and delete of an
 * absent id is BB's exact not-found result.
 */
export function createFakeBbAutomationAdapter(now: number) {
  const automations = new Map<string, BbAutomation>();
  const runs = new Map<string, BbAutomationRun[]>();
  const create = vi.fn(async ({ definition: value, identity }: {
    definition: BbAutomationDefinition;
    identity: ManagedAutomationProviderIdentity;
  }) => {
    const created = observedBbAutomation(value, now, {
      id: `auto_${automations.size + 1}`,
      name: providerName(value.name, identity),
    });
    automations.set(created.id, created);
    return {
      version: 1 as const,
      operationId: identity.operationId,
      ownershipMarker: identity.ownershipMarker,
      providerAutomationId: created.id,
    };
  });
  const adapter: ManagedAutomationAdapter = {
    agentAutomationCapabilities: {
      executionTimeout: true,
      resultContract: true,
      preRunAuthority: true,
    },
    create,
    update: vi.fn(async ({ automationId, definition: value, identity }) => {
      const found = automations.get(automationId);
      if (!found) throw new Error("missing automation");
      const updated = observedBbAutomation(value, now, {
        id: automationId,
        name: providerName(value.name, identity),
        enabled: found.enabled,
        createdAt: found.createdAt,
        updatedAt: now + 1,
      });
      automations.set(automationId, updated);
      return bbAutomationObservation(updated, value);
    }),
    show: vi.fn(async ({ automationId, expectedDefinition, expectedEnabled, identity }) => {
      const found = automations.get(automationId);
      if (!found) throw new Error("missing automation");
      if (expectedDefinition) {
        assertAutomationMatches(
          { ...expectedDefinition, name: providerName(expectedDefinition.name, identity) },
          found,
          expectedEnabled ?? true,
        );
      }
      return bbAutomationObservation(found, expectedDefinition);
    }),
    setEnabled: vi.fn(async ({ automationId, enabled, expectedDefinition }) => {
      const found = automations.get(automationId);
      if (!found) throw new Error("missing automation");
      const updated = { ...found, enabled, nextRunAt: enabled ? now + 60_000 : null };
      automations.set(automationId, updated);
      return bbAutomationObservation(updated, expectedDefinition);
    }),
    findByDefinition: vi.fn(async ({ definition: requested, identity }) => {
      const found = [...automations.values()].find((candidate) => {
        try {
          assertAutomationMatches(
            { ...requested, name: providerName(requested.name, identity) },
            candidate,
          );
          return true;
        } catch {
          return false;
        }
      });
      return found ? bbAutomationObservation(found, requested) : null;
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
