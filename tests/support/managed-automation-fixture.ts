import { vi } from "vitest";
import type { BbAutomation, BbAutomationDefinition } from "../../src/bb/automation";
import type { CreateManagedAutomationInput } from "../../src/services/managed-automation-service";
import type { ManagedAutomationBinding } from "../../src/storage/managed-automation-repository";

function observed(definition: BbAutomationDefinition, id: string, now: number): BbAutomation {
  return {
    id,
    projectId: definition.projectId,
    name: definition.name,
    enabled: true,
    trigger: definition.trigger.kind === "cron"
      ? { triggerType: "schedule", cron: definition.trigger.cron, timezone: definition.trigger.timezone }
      : { triggerType: "once", runAt: Date.parse(definition.trigger.at) },
    execution: definition.mode === "agent"
      ? {
          mode: "agent",
          prompt: definition.prompt,
          providerId: definition.providerId,
          model: definition.model,
          ...(definition.reasoningLevel ? { reasoningLevel: definition.reasoningLevel } : {}),
          ...(definition.serviceTier ? { serviceTier: definition.serviceTier } : {}),
          permissionMode: definition.permissionMode,
          environment: { type: "project-default" },
        }
      : {
          mode: "script",
          interpreter: definition.interpreter,
          timeoutMs: definition.timeoutMs,
          script: definition.source.kind === "inline" ? definition.source.script : "",
          env: definition.env,
          storedScriptPath: "/test/automation.sh",
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
  };
}

export function createTestManagedAutomations() {
  const bindings = new Map<string, ManagedAutomationBinding>();
  const create = vi.fn(async (input: CreateManagedAutomationInput): Promise<ManagedAutomationBinding> => {
    const id = `automation-binding-test-${bindings.size + 1}`;
    const automation = observed(input.definition, `auto_test_${bindings.size + 1}`, input.now);
    const binding: ManagedAutomationBinding = {
      id,
      controllerKey: input.controllerKey,
      sourceKey: input.sourceKey,
      projectId: input.definition.projectId,
      bbAutomationId: automation.id,
      name: input.definition.name,
      mode: input.definition.mode,
      definition: input.definition,
      definitionSha256: "d".repeat(64),
      authority: input.authority,
      notificationPolicy: input.notificationPolicy,
      state: "active",
      legacyMonitorId: input.legacyMonitorId ?? null,
      observed: automation,
      observedSha256: "e".repeat(64),
      lastReconciledAt: input.now,
      lastRunId: null,
      lastRunStatus: null,
      lastError: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    bindings.set(id, binding);
    return binding;
  });
  const get = vi.fn((id: string) => bindings.get(id) ?? null);
  const list = vi.fn((controllerKey: string, includeRetired = false) =>
    [...bindings.values()].filter((binding) =>
      binding.controllerKey === controllerKey && (includeRetired || binding.state !== "retired")));
  const retire = vi.fn(async (input: { id: string; now: number }) => {
    const binding = bindings.get(input.id);
    if (!binding) throw new Error("missing test automation");
    const retired = { ...binding, state: "retired" as const, updatedAt: input.now };
    bindings.set(input.id, retired);
    return retired;
  });
  return { bindings, create, get, list, retire };
}
