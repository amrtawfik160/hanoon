import { vi } from "vitest";
import type { BbAutomationDefinition } from "../../src/bb/automation";
import type { ManagedAutomationObservation } from "../../src/domain/managed-automation";
import type {
  CreateManagedAutomationInput,
  ManagedAutomationService,
} from "../../src/services/managed-automation-service";
import type { ManagedAutomationBinding } from "../../src/storage/managed-automation-repository";
import { isCurrentManagedAutomationAuthority } from "../../src/domain/managed-automation";

function observed(definition: BbAutomationDefinition, id: string, now: number): ManagedAutomationObservation {
  return {
    providerAutomationId: id,
    projectId: definition.projectId,
    name: definition.name,
    enabled: true,
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
      definitionRevision: input.operation.definitionRevision,
      authorityVersion: isCurrentManagedAutomationAuthority(input.authority) ? 1 : 0,
      capabilityEvidence: isCurrentManagedAutomationAuthority(input.authority)
        ? input.authority.capabilityEvidence
        : null,
      notificationPolicy: input.notificationPolicy,
      desiredState: "enabled",
      state: "active",
      legacyMonitorId: input.legacyMonitorId ?? null,
      observed: automation,
      observedSha256: "e".repeat(64),
      lastReconciledAt: input.now,
      lastRunId: null,
      lastRunStatus: null,
      lastError: null,
      lastOperationId: "managed-automation-operation-test",
      lastOperationOutcome: "pending",
      lastReconciledOperationId: null,
      lastReconciledOperationOutcome: null,
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
  const submitLifecycleOperation = vi.fn(
    (input: Parameters<ManagedAutomationService["submitLifecycleOperation"]>[0]): ManagedAutomationBinding => {
      const binding = bindings.get(input.id);
      if (!binding) throw new Error("missing test automation");
      const updated: ManagedAutomationBinding = {
        ...binding,
        name: input.definition?.name ?? binding.name,
        mode: input.definition?.mode ?? binding.mode,
        definition: input.definition ?? binding.definition,
        desiredState: input.desiredState,
        state: input.operationClass === "retire"
          ? "retiring"
          : ["update", "enable", "disable"].includes(input.operationClass)
            ? "updating"
            : binding.state,
        lastOperationId: `managed-automation-operation-test-${input.operationClass}`,
        lastOperationOutcome: "pending",
        updatedAt: input.now,
      };
      if (!input.mutate) throw new Error("test managed automation mutation requires an execution fence");
      return input.mutate(() => {
        bindings.set(input.id, updated);
        return updated;
      });
    },
  );
  return { bindings, create, get, list, submitLifecycleOperation };
}
