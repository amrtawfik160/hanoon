import { vi } from "vitest";
import type { BbAutomationDefinition } from "../../src/bb/automation";
import type { ManagedAutomationObservation, ManagedAutomationRun } from "../../src/domain/managed-automation";
import type {
  CreateManagedAutomationInput,
  ManagedAutomationService,
} from "../../src/services/managed-automation-service";
import type { ManagedAutomationBinding } from "../../src/storage/managed-automation-repository";
import { isCurrentManagedAutomationAuthority } from "../../src/domain/managed-automation";

function observed(
  definition: BbAutomationDefinition,
  id: string,
  now: number,
  enabled = true,
): ManagedAutomationObservation {
  return {
    providerAutomationId: id,
    projectId: definition.projectId,
    name: definition.name,
    enabled,
    trigger: definition.trigger,
    mode: definition.mode,
    target: definition.mode === "agent" ? definition.target : null,
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
      bbAutomationId: automation.providerAutomationId,
      providerOwnershipMarker: null,
      name: input.definition.name,
      mode: input.definition.mode,
      definition: input.definition,
      definitionSha256: "d".repeat(64),
      authority: input.authority,
      definitionRevision: input.operation?.definitionRevision ?? 1,
      authorityVersion: isCurrentManagedAutomationAuthority(input.authority) ? 1 : 0,
      capabilityEvidence: isCurrentManagedAutomationAuthority(input.authority)
        ? input.authority.capabilityEvidence
        : null,
      notificationPolicy: input.notificationPolicy,
      state: "active",
      legacyMonitorId: input.legacyMonitorId ?? null,
      observed: automation,
      observedSha256: "e".repeat(64),
      lastReconciledAt: input.now,
      lastRunId: null,
      lastRunStatus: null,
      lastError: null,
      lastOperationId: input.deferProvider ? "managed-automation-operation-test" : null,
      lastOperationOutcome: input.deferProvider ? "pending" : null,
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
  const setEnabled = vi.fn(async (
    input: Parameters<ManagedAutomationService["setEnabled"]>[0],
  ): Promise<ManagedAutomationBinding> => {
    const binding = bindings.get(input.id);
    if (!binding) throw new Error("missing test automation");
    const automation = observed(binding.definition, binding.bbAutomationId!, input.now, input.enabled);
    const updated: ManagedAutomationBinding = {
      ...binding,
      observed: automation,
      state: input.enabled ? "active" : "paused",
      lastReconciledAt: input.now,
      updatedAt: input.now,
    };
    bindings.set(input.id, updated);
    return updated;
  });
  const pause = vi.fn(async (
    input: Parameters<ManagedAutomationService["pause"]>[0],
  ): Promise<ManagedAutomationBinding> => setEnabled({ ...input, enabled: false }));
  const resume = vi.fn(async (
    input: Parameters<ManagedAutomationService["resume"]>[0],
  ): Promise<ManagedAutomationBinding> => setEnabled({ ...input, enabled: true }));
  const runNow = vi.fn(async (
    input: Parameters<ManagedAutomationService["runNow"]>[0],
  ): Promise<ManagedAutomationRun> => {
    const binding = bindings.get(input.id);
    if (!binding) throw new Error("missing test automation");
    return {
      id: `run_test_${runNow.mock.calls.length}`,
      automationId: binding.bbAutomationId!,
      idempotencyKey: input.idempotencyKey,
      runMode: binding.mode,
      threadId: null,
      status: "succeeded",
      trigger: "manual",
      skipReason: null,
      error: null,
      output: null,
      exitCode: null,
      scheduledFor: input.now,
      startedAt: input.now,
      finishedAt: input.now,
    };
  });
  const update = vi.fn(async (
    input: Parameters<ManagedAutomationService["update"]>[0],
  ): Promise<ManagedAutomationBinding> => {
    const binding = bindings.get(input.id);
    if (!binding) throw new Error("missing test automation");
    const automation = observed(input.definition, binding.bbAutomationId!, input.now);
    const updated: ManagedAutomationBinding = {
      ...binding,
      name: input.definition.name,
      mode: input.definition.mode,
      definition: input.definition,
      observed: automation,
      lastReconciledAt: input.now,
      updatedAt: input.now,
    };
    bindings.set(input.id, updated);
    return updated;
  });
  const retire = vi.fn(async (input: { id: string; now: number }) => {
    const binding = bindings.get(input.id);
    if (!binding) throw new Error("missing test automation");
    const retired = { ...binding, state: "retired" as const, updatedAt: input.now };
    bindings.set(input.id, retired);
    return retired;
  });
  return { bindings, create, get, list, update, pause, resume, runNow, retire };
}
