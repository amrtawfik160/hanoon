import {
  BbAutomationNotFoundError,
  DEFAULT_BB_AGENT_AUTOMATION_RESULT_CONTRACT,
  DEFAULT_BB_AGENT_AUTOMATION_TIMEOUT_MS,
} from "../bb/automation";
import type { MonitorRecord } from "../storage/store";
import type {
  ManagedAutomationOperation,
  ManagedAutomationBinding,
  ManagedAutomationPersistence,
  ManagedAutomationExecutorFence,
  ManagedAutomationMutationFence,
  ManagedAutomationNotificationHandoff,
} from "../storage/managed-automation-repository";
import {
  managedAutomationDigest,
} from "../storage/managed-automation-repository";
import type {
  ManagedAutomationCapabilities,
  ManagedAutomationCreateReceipt,
  ManagedAutomationDefinition,
  ManagedAutomationObservation,
  ManagedAutomationOperationRequest,
  ManagedAutomationProviderIdentity,
  ManagedAutomationRun,
  ManagedAutomationScope,
  ManagedAutomationTarget,
  StoredManagedAutomationAuthority,
} from "../domain/managed-automation";
import {
  isCurrentManagedAutomationAuthority,
  managedAutomationRunSchema,
} from "../domain/managed-automation";
import type { EffectFence } from "./effect-runner";
import { capabilityDescriptorById } from "../capabilities/catalog";

export type ManagedAutomationAdapter = Readonly<{
  agentAutomationCapabilities: ManagedAutomationCapabilities;
  create(input: {
    scope: ManagedAutomationScope;
    definition: ManagedAutomationDefinition;
    identity: ManagedAutomationProviderIdentity;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationCreateReceipt>;
  update(input: {
    scope: ManagedAutomationScope;
    definition: ManagedAutomationDefinition;
    automationId: string;
    expectedEnabled: boolean;
    identity?: ManagedAutomationProviderIdentity;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationObservation>;
  show(input: {
    scope: ManagedAutomationScope;
    projectId: string;
    automationId: string;
    expectedDefinition?: ManagedAutomationDefinition;
    expectedEnabled?: boolean;
    identity?: ManagedAutomationProviderIdentity;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationObservation>;
  setEnabled(input: {
    scope: ManagedAutomationScope;
    projectId: string;
    automationId: string;
    enabled: boolean;
    expectedDefinition?: ManagedAutomationDefinition;
    identity?: ManagedAutomationProviderIdentity;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationObservation>;
  runNow(input: {
    scope: ManagedAutomationScope;
    projectId: string;
    automationId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationRun>;
  runs(input: {
    scope: ManagedAutomationScope;
    projectId: string;
    automationId: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<readonly ManagedAutomationRun[]>;
  delete(input: {
    scope: ManagedAutomationScope;
    projectId: string;
    automationId: string;
    signal?: AbortSignal;
  }): Promise<void>;
  findByDefinition?(input: {
    scope: ManagedAutomationScope;
    definition: ManagedAutomationDefinition;
    identity: ManagedAutomationProviderIdentity;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationObservation | null>;
}>;

export class ManagedAgentExecutionContractUnsupportedError extends Error {
  public readonly code = "BB_AGENT_EXECUTION_CONTRACT_UNSUPPORTED";

  public constructor() {
    super("BB cannot enforce this agent automation's execution contract");
    this.name = "ManagedAgentExecutionContractUnsupportedError";
  }
}

export type CreateManagedAutomationInput = Readonly<{
  scope: ManagedAutomationScope;
  controllerKey: string;
  sourceKey: string;
  definition: ManagedAutomationDefinition;
  authority: StoredManagedAutomationAuthority;
  notificationPolicy: "material" | "always" | "silent";
  legacyMonitorId?: string | null;
  now: number;
  signal?: AbortSignal;
  deferProvider?: boolean;
  operation?: ManagedAutomationOperationRequest;
  fence: ManagedAutomationMutationFence;
}>;

function executorMutationFence(fence: EffectFence): ManagedAutomationMutationFence {
  return {
    kind: "executor",
    value: { ownerId: fence.ownerId, generation: fence.generation },
  };
}

function systemCapabilityEvidence(systemKey: string) {
  const descriptor = capabilityDescriptorById("telegram_agent_watch");
  if (!descriptor) throw new Error("BB schedule capability is not registered");
  return {
    version: 1 as const,
    profileId: `system-maintenance:${systemKey}`,
    profileRevision: 1,
    capabilityId: descriptor.id,
    descriptorVersion: descriptor.version,
    descriptorDigest: descriptor.digest,
    evidenceRefs: [`system-maintenance:${systemKey}`],
  };
}

function existingProviderIdentity(
  binding: ManagedAutomationBinding,
  operation?: ManagedAutomationOperation,
): ManagedAutomationProviderIdentity | undefined {
  const ownershipMarker = operation?.providerOwnershipMarker ?? binding.providerOwnershipMarker;
  if (!ownershipMarker) return undefined;
  return {
    operationId: operation?.id ?? binding.lastOperationId ?? binding.id,
    ownershipMarker,
  };
}

class ManagedAutomationExecutorFenceLostError extends Error {
  public constructor() {
    super("managed automation executor fence was lost");
    this.name = "ManagedAutomationExecutorFenceLostError";
  }
}

export type ManagedAutomationOperationExecution = Readonly<{
  automation: ManagedAutomationObservation | null;
  run: ManagedAutomationRun | null;
}>;

const MANAGED_AUTOMATION_OPERATION_LEASE_MS = 120_000;
const MANAGED_AUTOMATION_OPERATION_RENEWAL_MS = 30_000;

function agentExecutionContractIsSupported(adapter: ManagedAutomationAdapter): boolean {
  const support = adapter.agentAutomationCapabilities;
  return support.executionTimeout && support.resultContract && support.preRunAuthority;
}

function assertAgentExecutionContractSupported(adapter: ManagedAutomationAdapter): void {
  if (!agentExecutionContractIsSupported(adapter)) throw new ManagedAgentExecutionContractUnsupportedError();
}

function runFromSettledOperation(operation: ManagedAutomationOperation): ManagedAutomationRun | null {
  if (!operation.outcome || !("kind" in operation.outcome) || operation.outcome.kind !== "settled") return null;
  const evidence = operation.outcome.evidence;
  if (evidence === null || typeof evidence !== "object" || !("run" in evidence)) return null;
  try {
    return managedAutomationRunSchema.parse(evidence.run);
  } catch {
    return null;
  }
}

function operationRunEvidence(run: ManagedAutomationRun): Readonly<Record<string, unknown>> {
  // Run output and provider errors are deliberately not copied into the
  // operation receipt. The append-only run evidence stores only their bounded
  // digests, while this projection keeps idempotent callers able to recover a
  // typed result after restart.
  return {
    run: {
      ...run,
      error: null,
      output: null,
    },
  };
}

async function deleteAutomationForRetirement(
  adapter: ManagedAutomationAdapter,
  input: Parameters<ManagedAutomationAdapter["delete"]>[0],
): Promise<void> {
  try {
    await adapter.delete(input);
  } catch (error) {
    if (!(error instanceof BbAutomationNotFoundError)) throw error;
  }
}

export class ManagedAutomationService {
  public constructor(
    private readonly repository: ManagedAutomationPersistence,
    private readonly adapter: ManagedAutomationAdapter,
    private readonly authorityIsCurrent: (binding: ManagedAutomationBinding) => boolean,
    private readonly capabilityIsCurrent: (binding: ManagedAutomationBinding, operation: ManagedAutomationOperation) => boolean = () => true,
    private readonly clock: { now(): number } | undefined = undefined,
  ) {}

  public get(id: string): ManagedAutomationBinding | null {
    return this.repository.get(id);
  }

  public list(controllerKey: string, includeRetired = false): ManagedAutomationBinding[] {
    return this.repository.list(controllerKey, includeRetired);
  }

  public async create(input: CreateManagedAutomationInput): Promise<ManagedAutomationBinding> {
    const operation = input.operation ?? (
      isCurrentManagedAutomationAuthority(input.authority)
        ? {
            version: 1 as const,
            operationClass: "create" as const,
            targetProjectId: input.definition.projectId,
            definitionRevision: 1,
          }
        : undefined
    );
    const deferred = input.deferProvider === true || input.operation !== undefined;
    if (input.deferProvider === true && !operation) {
      throw new TypeError("deferred managed automation creation requires an operation fence");
    }
    if (!operation) {
      throw new Error("managed automation authority is not current");
    }
    if (!deferred && input.definition.mode === "agent") assertAgentExecutionContractSupported(this.adapter);
    const reserved = this.repository.reserve({
      controllerKey: input.controllerKey,
      sourceKey: input.sourceKey,
      projectId: input.definition.projectId,
      name: input.definition.name,
      definition: input.definition,
      authority: input.authority,
      notificationPolicy: input.notificationPolicy,
      legacyMonitorId: input.legacyMonitorId ?? null,
      now: input.now,
      definitionRevision: operation.definitionRevision,
      operation,
      fence: input.fence,
    });
    if (deferred) {
      return reserved;
    }
    if (input.fence.kind === "controller") return reserved;
    const reservedOperation = reserved.lastOperationId
      ? this.repository.getOperation(reserved.lastOperationId)
      : null;
    if (reservedOperation?.state === "succeeded" && reservedOperation.operationClass === "create") {
      return this.reconcile({
        binding: reserved,
        scope: input.scope,
        now: input.now,
        fence: input.fence,
        signal: input.signal,
      });
    }
    await this.executeReservedOperation({
      binding: reserved,
      scope: input.scope,
      now: input.now,
      fence: input.fence,
      signal: input.signal,
    });
    return this.repository.get(reserved.id) ?? reserved;
  }

  public admitOperation(
    binding: ManagedAutomationBinding,
    operation: ManagedAutomationOperation,
  ): Readonly<{ allowed: true } | { allowed: false; errorClass: string }> {
    if (operation.state !== "leased") return { allowed: false, errorClass: "managed_automation_operation_not_leased" };
    if (operation.bindingId !== binding.id) return { allowed: false, errorClass: "managed_automation_operation_stale" };
    if (operation.targetProjectId !== binding.projectId || operation.definitionRevision !== binding.definitionRevision) {
      return { allowed: false, errorClass: "managed_automation_operation_stale" };
    }
    if (managedAutomationDigest(operation.authority) !== managedAutomationDigest(binding.authority) ||
      managedAutomationDigest(operation.capabilityEvidence) !== managedAutomationDigest(binding.capabilityEvidence)) {
      return { allowed: false, errorClass: "managed_automation_operation_stale" };
    }
    if (isCurrentManagedAutomationAuthority(binding.authority) &&
      (!operation.capabilityEvidence || !binding.capabilityEvidence ||
        managedAutomationDigest(operation.capabilityEvidence) !== managedAutomationDigest(binding.capabilityEvidence))) {
      return { allowed: false, errorClass: "managed_automation_capability_evidence_stale" };
    }
    if (isCurrentManagedAutomationAuthority(operation.authority) && operation.authority.origin === "owner" &&
      (!operation.controllerFence || operation.authority.taskAuthority.turnId !== operation.controllerFence.turnId)) {
      return { allowed: false, errorClass: "managed_automation_operation_stale" };
    }
    if (binding.state === "retired") {
      return { allowed: false, errorClass: "managed_automation_binding_retired" };
    }
    if (operation.operationClass === "retire" && binding.state !== "retiring") {
      return { allowed: false, errorClass: "managed_automation_operation_stale" };
    }
    if (operation.operationClass !== "retire" && binding.state === "retiring") {
      return { allowed: false, errorClass: "managed_automation_binding_retired" };
    }
    if (operation.operationClass === "create" && binding.state !== "pending") {
      return { allowed: false, errorClass: "managed_automation_operation_stale" };
    }
    if (["update", "enable", "disable"].includes(operation.operationClass) && binding.state !== "updating") {
      return { allowed: false, errorClass: "managed_automation_operation_stale" };
    }
    if (operation.operationClass === "run_now" && !["active", "paused", "failed"].includes(binding.state)) {
      return { allowed: false, errorClass: "managed_automation_operation_stale" };
    }
    if (binding.mode === "agent" && ["create", "update", "enable", "run_now"].includes(operation.operationClass) &&
      !agentExecutionContractIsSupported(this.adapter)) {
      return { allowed: false, errorClass: "bb_agent_execution_contract_unsupported" };
    }
    if (!this.authorityIsCurrent(binding)) {
      return { allowed: false, errorClass: "managed_automation_authority_stale" };
    }
    if (!this.capabilityIsCurrent(binding, operation)) {
      return { allowed: false, errorClass: "managed_automation_capability_evidence_stale" };
    }
    return { allowed: true };
  }

  public async executeClaimedOperation(input: {
    binding: ManagedAutomationBinding;
    operation: ManagedAutomationOperation;
    scope: ManagedAutomationScope;
    signal?: AbortSignal;
    now?: number;
  }): Promise<ManagedAutomationOperationExecution> {
    const admission = this.admitOperation(input.binding, input.operation);
    if (!admission.allowed) throw new Error(admission.errorClass);
    const providerIdentity = existingProviderIdentity(input.binding, input.operation);
    if (!providerIdentity) throw new Error("managed_automation_provider_identity_missing");
    if (input.operation.operationClass === "retire") {
      if (input.binding.bbAutomationId !== null) {
        await deleteAutomationForRetirement(this.adapter, {
          scope: input.scope,
          projectId: input.binding.projectId,
          automationId: input.binding.bbAutomationId,
          signal: input.signal,
        });
      }
      return { automation: null, run: null };
    }
    if (input.operation.operationClass === "update") {
      const automation = await this.adapter.update({
        scope: input.scope,
        definition: input.binding.definition,
        automationId: input.binding.bbAutomationId!,
        expectedEnabled: input.binding.observed?.enabled ?? true,
        identity: providerIdentity,
        signal: input.signal,
      });
      return { automation, run: null };
    }
    if (input.operation.operationClass === "enable" || input.operation.operationClass === "disable") {
      const automation = await this.adapter.setEnabled({
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId: input.binding.bbAutomationId!,
        enabled: input.operation.operationClass === "enable",
        expectedDefinition: input.binding.definition,
        identity: providerIdentity,
        signal: input.signal,
      });
      return { automation, run: null };
    }
    if (input.operation.operationClass === "run_now") {
      const run = await this.adapter.runNow({
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId: input.binding.bbAutomationId!,
        idempotencyKey: input.operation.operationKey,
        signal: input.signal,
      });
      if (input.signal?.aborted) throw new Error("managed_automation_operation_aborted");
      const automation = await this.adapter.show({
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId: input.binding.bbAutomationId!,
        expectedDefinition: input.binding.definition,
        expectedEnabled: input.binding.observed?.enabled ?? true,
        identity: providerIdentity,
        signal: input.signal,
      });
      return { automation, run };
    }
    if (input.operation.attempts > 1 && !this.adapter.findByDefinition &&
      input.operation.providerAutomationId === null && input.binding.bbAutomationId === null) {
      throw new Error("managed_automation_reconciliation_unsupported");
    }
    const knownProviderAutomationId = input.operation.providerAutomationId ?? input.binding.bbAutomationId;
    if (knownProviderAutomationId !== null) {
      const automation = await this.adapter.show({
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId: knownProviderAutomationId,
        expectedDefinition: input.binding.definition,
        expectedEnabled: true,
        identity: providerIdentity,
        signal: input.signal,
      });
      return { automation, run: null };
    }
    const existing = input.operation.attempts > 1 && this.adapter.findByDefinition
      ? await this.adapter.findByDefinition({
          scope: input.scope,
          definition: input.binding.definition,
          identity: providerIdentity,
          signal: input.signal,
        })
      : null;
    if (input.signal?.aborted) throw new Error("managed_automation_operation_aborted");
    if (existing) {
      const acknowledged = this.repository.acknowledgeOperation({
        operationId: input.operation.id,
        ownerId: input.operation.leaseOwner!,
        generation: input.operation.leaseGeneration!,
        now: input.now ?? input.binding.updatedAt,
        receipt: {
          version: 1,
          operationId: providerIdentity.operationId,
          ownershipMarker: providerIdentity.ownershipMarker,
          providerAutomationId: existing.providerAutomationId,
        },
      });
      if (!acknowledged) throw new ManagedAutomationExecutorFenceLostError();
      return { automation: existing, run: null };
    }
    const receipt = await this.adapter.create({
      scope: input.scope,
      definition: input.binding.definition,
      identity: providerIdentity,
      signal: input.signal,
    });
    const acknowledged = this.repository.acknowledgeOperation({
      operationId: input.operation.id,
      ownerId: input.operation.leaseOwner!,
      generation: input.operation.leaseGeneration!,
      now: input.now ?? input.binding.updatedAt,
      receipt,
    });
    if (!acknowledged) throw new ManagedAutomationExecutorFenceLostError();
    if (input.signal?.aborted) throw new Error("managed_automation_operation_aborted");
    const automation = await this.adapter.show({
      scope: input.scope,
      projectId: input.binding.projectId,
      automationId: receipt.providerAutomationId,
      expectedDefinition: input.binding.definition,
      expectedEnabled: true,
      identity: providerIdentity,
      signal: input.signal,
    });
    return { automation, run: null };
  }

  private async executeReservedOperation(input: {
    binding: ManagedAutomationBinding;
    scope: ManagedAutomationScope;
    now: number;
    fence: ManagedAutomationMutationFence;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationOperationExecution> {
    if (input.fence.kind !== "executor") {
      throw new Error("managed automation operation is pending executor work");
    }
    const operationId = input.binding.lastOperationId;
    if (!operationId) throw new Error("managed automation operation identity is missing");
    const existing = this.repository.getOperation(operationId);
    if (!existing) throw new Error("managed automation operation is missing");
    if (existing.state === "succeeded") {
      return {
        automation: input.binding.observed,
        run: runFromSettledOperation(existing),
      };
    }
    const operation = this.repository.claimOperation({
      operationId,
      ownerId: input.fence.value.ownerId,
      generation: input.fence.value.generation,
      now: input.now,
      leaseMs: MANAGED_AUTOMATION_OPERATION_LEASE_MS,
    });
    if (!operation) {
      throw new Error("managed automation operation is not due for this executor");
    }
    const operationAbort = new AbortController();
    const operationSignal = AbortSignal.any([operationAbort.signal, ...(input.signal ? [input.signal] : [])]);
    const renewal = setInterval(() => {
      const renewed = this.repository.renewOperationLease({
        operationId: operation.id,
        ownerId: input.fence.value.ownerId,
        generation: input.fence.value.generation,
        now: this.clock?.now() ?? input.now,
        leaseMs: MANAGED_AUTOMATION_OPERATION_LEASE_MS,
      });
      if (!renewed) operationAbort.abort(new ManagedAutomationExecutorFenceLostError());
    }, MANAGED_AUTOMATION_OPERATION_RENEWAL_MS);
    const currentBinding = this.repository.get(input.binding.id) ?? input.binding;
    const admission = this.admitOperation(currentBinding, operation);
    if (!admission.allowed) {
      clearInterval(renewal);
      const settled = this.repository.settleOperation({
        operationId: operation.id,
        ownerId: input.fence.value.ownerId,
        generation: input.fence.value.generation,
        now: input.now,
        outcome: "failed",
        errorClass: admission.errorClass,
      });
      if (!settled) throw new ManagedAutomationExecutorFenceLostError();
      throw new Error(admission.errorClass === "managed_automation_authority_stale"
        ? "managed automation authority is not current"
        : admission.errorClass);
    }
    try {
      const execution = await this.executeClaimedOperation({
        binding: currentBinding,
        operation,
        scope: input.scope,
        signal: operationSignal,
        now: this.clock?.now() ?? input.now,
      });
      if (operationSignal.aborted) throw new ManagedAutomationExecutorFenceLostError();
      const settled = this.repository.settleOperation({
        operationId: operation.id,
        ownerId: input.fence.value.ownerId,
        generation: input.fence.value.generation,
        now: this.clock?.now() ?? input.now,
        outcome: "succeeded",
        automation: execution.automation,
        run: execution.run,
        outcomeEvidence: execution.run === null ? null : operationRunEvidence(execution.run),
      });
      if (!settled) throw new ManagedAutomationExecutorFenceLostError();
      return execution;
    } catch (error) {
      if (!operationSignal.aborted) {
        const settled = this.repository.settleOperation({
          operationId: operation.id,
          ownerId: input.fence.value.ownerId,
          generation: input.fence.value.generation,
          now: this.clock?.now() ?? input.now,
          outcome: "ambiguous",
          errorClass: automationErrorClass(error),
        });
        if (!settled) throw new ManagedAutomationExecutorFenceLostError();
      }
      throw error;
    } finally {
      clearInterval(renewal);
    }
  }

  public async reconcile(input: {
    binding: ManagedAutomationBinding;
    scope: ManagedAutomationScope;
    now: number;
    fence: ManagedAutomationMutationFence;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    const durableOperation = input.binding.lastOperationId
      ? this.repository.getOperation(input.binding.lastOperationId)
      : null;
    if (input.fence.kind === "executor" && durableOperation &&
      ["pending", "leased", "failed", "ambiguous"].includes(durableOperation.state) &&
      durableOperation.operationClass !== "reconcile") {
      await this.executeReservedOperation({
        binding: input.binding,
        scope: input.scope,
        now: input.now,
        fence: input.fence,
        signal: input.signal,
      });
      return this.repository.get(input.binding.id)!;
    }
    if (input.binding.bbAutomationId === null) throw new Error("managed automation has no BB automation id");
    if (input.binding.state === "retiring") {
      await deleteAutomationForRetirement(this.adapter, {
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId: input.binding.bbAutomationId,
        signal: input.signal,
      });
      return this.repository.retire(input.binding.id, input.now, input.fence);
    }
    if (input.binding.mode === "agent" && !agentExecutionContractIsSupported(this.adapter)) {
      return this.pauseForUnsupportedAgentExecution({
        binding: input.binding,
        scope: input.scope,
        now: input.now,
        fence: input.fence,
        signal: input.signal,
      });
    }
    if (input.binding.mode === "agent" && !this.authorityIsCurrent(input.binding)) {
      return this.pauseForStaleAuthority({
        binding: input.binding,
        scope: input.scope,
        now: input.now,
        fence: input.fence,
        signal: input.signal,
      });
    }
    if (input.binding.state === "updating") {
      throw new Error("managed automation update is pending durable operation");
    }
    try {
      const automation = await this.adapter.show({
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId: input.binding.bbAutomationId,
        expectedDefinition: input.binding.definition,
        expectedEnabled: input.binding.state !== "paused",
        identity: existingProviderIdentity(input.binding),
        signal: input.signal,
      });
      const active = this.repository.activate({
        id: input.binding.id,
        automation,
        now: input.now,
        fence: input.fence,
      });
      const runs = await this.adapter.runs({
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId: input.binding.bbAutomationId,
        limit: 20,
        signal: input.signal,
      });
      for (const run of [...runs].reverse()) this.repository.recordRun(active.id, run, input.now, input.fence);
      return this.repository.get(active.id)!;
    } catch (error) {
      try {
        this.repository.fail(
          input.binding.id,
          automationErrorClass(error),
          input.now,
          input.fence,
        );
      } catch {
        // Preserve a stale authorization fence over a secondary error marker.
      }
      throw error;
    }
  }

  public async setEnabled(input: {
    id: string;
    scope: ManagedAutomationScope;
    enabled: boolean;
    now: number;
    fence: ManagedAutomationMutationFence;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    const binding = requireActiveBinding(this.repository, input.id);
    if (input.enabled && binding.mode === "agent") assertAgentExecutionContractSupported(this.adapter);
    if (input.enabled && binding.mode === "agent" && !this.authorityIsCurrent(binding)) {
      throw new Error("managed automation authority is not current");
    }
    const updating = this.repository.beginEnabledChange({
      id: binding.id,
      enabled: input.enabled,
      now: input.now,
      fence: input.fence,
    });
    if (input.fence.kind === "controller") return updating;
    await this.executeReservedOperation({
      binding: updating,
      scope: input.scope,
      now: input.now,
      fence: input.fence,
      signal: input.signal,
    });
    return this.repository.get(binding.id)!;
  }

  public async update(input: {
    id: string;
    scope: ManagedAutomationScope;
    definition: ManagedAutomationDefinition;
    now: number;
    fence: ManagedAutomationMutationFence;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    if (input.definition.mode === "agent") assertAgentExecutionContractSupported(this.adapter);
    const updating = this.repository.beginUpdate({
      id: input.id,
      definition: input.definition,
      now: input.now,
      fence: input.fence,
    });
    if (input.fence.kind === "controller") return updating;
    await this.executeReservedOperation({
      binding: updating,
      scope: input.scope,
      now: input.now,
      fence: input.fence,
      signal: input.signal,
    });
    return this.repository.get(updating.id)!;
  }

  public async pauseForStaleAuthority(input: {
    binding: ManagedAutomationBinding;
    scope: ManagedAutomationScope;
    now: number;
    fence: ManagedAutomationMutationFence;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    let binding = input.binding;
    if (binding.observed?.enabled !== false) {
      const paused = await this.adapter.setEnabled({
        scope: input.scope,
        projectId: binding.projectId,
        automationId: binding.bbAutomationId!,
        enabled: false,
        expectedDefinition: binding.definition,
        identity: existingProviderIdentity(binding),
        signal: input.signal,
      });
      binding = this.repository.activate({ id: binding.id, automation: paused, now: input.now, fence: input.fence });
    }
    return this.repository.markPolicyBlocked(binding.id, input.now, input.fence);
  }

  public async pauseForUnsupportedAgentExecution(input: {
    binding: ManagedAutomationBinding;
    scope: ManagedAutomationScope;
    now: number;
    fence: ManagedAutomationMutationFence;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    let binding = input.binding;
    if (binding.observed?.enabled !== false) {
      const paused = await this.adapter.setEnabled({
        scope: input.scope,
        projectId: binding.projectId,
        automationId: binding.bbAutomationId!,
        enabled: false,
        expectedDefinition: binding.definition,
        identity: existingProviderIdentity(binding),
        signal: input.signal,
      });
      binding = this.repository.activate({ id: binding.id, automation: paused, now: input.now, fence: input.fence });
    }
    return this.repository.markExecutionContractBlocked(binding.id, input.now, input.fence);
  }

  public async runNow(input: {
    id: string;
    scope: ManagedAutomationScope;
    idempotencyKey: string;
    now: number;
    fence: ManagedAutomationMutationFence;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationRun | null> {
    const binding = requireActiveBinding(this.repository, input.id);
    if (binding.mode === "agent") assertAgentExecutionContractSupported(this.adapter);
    if (binding.mode === "agent" && !this.authorityIsCurrent(binding)) {
      throw new Error("managed automation authority is not current");
    }
    const pending = this.repository.beginRunNow({
      id: binding.id,
      idempotencyKey: input.idempotencyKey,
      now: input.now,
      fence: input.fence,
    });
    if (input.fence.kind === "controller") return null;
    const execution = await this.executeReservedOperation({
      binding: pending,
      scope: input.scope,
      now: input.now,
      fence: input.fence,
      signal: input.signal,
    });
    if (!execution.run) throw new Error("managed automation run-now result is unavailable");
    return execution.run;
  }

  public async retire(input: {
    id: string;
    scope: ManagedAutomationScope;
    now: number;
    fence: ManagedAutomationMutationFence;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    const binding = (() => {
      const current = this.repository.get(input.id);
      if (current?.state === "retired") return current;
      if (current?.state === "retiring") return current;
      if (current) return this.repository.beginRetirement(current.id, input.now, input.fence);
      throw new Error("managed automation is unavailable");
    })();
    if (binding.state === "retired") return binding;
    if (input.fence.kind === "controller") return binding;
    await this.executeReservedOperation({
      binding,
      scope: input.scope,
      now: input.now,
      fence: input.fence,
      signal: input.signal,
    });
    return this.repository.get(binding.id)!;
  }
}

function requireActiveBinding(
  repository: ManagedAutomationPersistence,
  id: string,
): ManagedAutomationBinding {
  const binding = repository.get(id);
  if (!binding || binding.bbAutomationId === null ||
    !["active", "paused", "failed"].includes(binding.state)) {
    throw new Error("managed automation is unavailable");
  }
  return binding;
}

function automationErrorClass(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timed out")) return "bb_automation_timeout";
  if (message.includes("aborted")) return "bb_automation_aborted";
  if (message.includes("reconcile")) return "bb_automation_reconciliation_failed";
  return "bb_automation_operation_failed";
}

export async function migrateLegacyClockMonitor(input: {
  monitor: MonitorRecord;
  store: Readonly<{ cancelMonitor(id: string, now: number): boolean }>;
  service: ManagedAutomationService;
  scope: ManagedAutomationScope;
  projectId: string;
  controllerKey: string;
  providerId: string;
  model: string;
  reasoningLevel?: string;
  serviceTier?: "default" | "fast";
  permissionMode: "accept-edits" | "auto" | "full";
  target?: ManagedAutomationTarget;
  hostId?: string;
  now: number;
  fence: ManagedAutomationMutationFence;
  signal?: AbortSignal;
}): Promise<ManagedAutomationBinding> {
  if (input.monitor.kind !== "schedule" || input.monitor.state !== "armed" || !input.monitor.cron) {
    throw new TypeError("only an armed Hanoon clock schedule can migrate");
  }
  const binding = await input.service.create({
    scope: input.scope,
    controllerKey: input.controllerKey,
    sourceKey: input.monitor.systemKey ?? `legacy-monitor:${input.monitor.id}`,
    definition: {
      mode: "agent",
      projectId: input.projectId,
      name: input.monitor.systemKey ?? `Hanoon schedule ${input.monitor.id.slice(0, 24)}`,
      trigger: { kind: "cron", cron: input.monitor.cron, timezone: "Etc/UTC" },
      prompt: input.monitor.instruction,
      providerId: input.providerId,
      model: input.model,
      ...(input.reasoningLevel ? { reasoningLevel: input.reasoningLevel } : {}),
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
      permissionMode: input.permissionMode,
      target: input.target ?? { kind: "project-default" },
      timeoutMs: DEFAULT_BB_AGENT_AUTOMATION_TIMEOUT_MS,
      resultContract: DEFAULT_BB_AGENT_AUTOMATION_RESULT_CONTRACT,
    },
    authority: {
      version: 1,
      origin: "system-maintenance",
      controllerKey: input.controllerKey,
      projectId: input.projectId,
      hostId: input.hostId ?? "legacy-host",
      taskAuthority: null,
      standingAuthority: {
        version: 1,
        kind: "system-maintenance",
        systemKey: input.monitor.systemKey ?? `legacy-monitor:${input.monitor.id}`,
        revision: 1,
      },
      capabilityEvidence: systemCapabilityEvidence(input.monitor.systemKey ?? `legacy-monitor:${input.monitor.id}`),
      mayWidenAutomation: false,
    },
    notificationPolicy: "material",
    legacyMonitorId: input.monitor.id,
    now: input.now,
    fence: input.fence,
    signal: input.signal,
  });
  if (binding.state !== "active" || binding.bbAutomationId === null || binding.observed?.nextRunAt === null) {
    throw new Error("BB automation was not active with a verified next run");
  }
  if (!input.store.cancelMonitor(input.monitor.id, input.now)) {
    // Do not leave two schedulers active when the local handoff fence is lost.
    await input.service.setEnabled({
      id: binding.id,
      scope: input.scope,
      enabled: false,
      now: input.now,
      fence: input.fence,
      signal: input.signal,
    });
    throw new Error("legacy Hanoon schedule could not be disabled after BB verification");
  }
  return binding;
}

const AUTOMATION_RECONCILIATION_INTERVAL_MS = 60_000;
const AUTOMATION_OPERATION_LEASE_MS = 120_000;
const AUTOMATION_OPERATION_RENEWAL_MS = 30_000;

type ManagedAutomationReconcilerStore = Readonly<{
  getOwner(): Readonly<{ userId: string; chatId: string }> | null;
  getControllerForOwner(userId: string, chatId: string): Readonly<{
    controllerKey: string;
    hostId: string | null;
  }> | null;
  getProjectPolicy(projectId: string): Readonly<{ policy: Readonly<{ enabled: boolean }> }> | null;
  enqueueManagedAutomationNotification(input: ManagedAutomationNotificationHandoff): boolean;
}>;

export class ManagedAutomationReconciler {
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  public constructor(private readonly dependencies: Readonly<{
    repository: ManagedAutomationPersistence;
    service: ManagedAutomationService;
    store: ManagedAutomationReconcilerStore;
    notify(): void;
    warn?(message: string): void;
    clock?: { now(): number };
  }>) {}

  public async processDue(now: number, signal: AbortSignal | undefined, fence: EffectFence): Promise<boolean> {
    if (now - this.lastSweepAt < AUTOMATION_RECONCILIATION_INTERVAL_MS) return false;
    this.lastSweepAt = now;
    if (fence.signal.aborted || signal?.aborted) return false;
    let didWork = await this.processDurableOperations(now, fence, signal);
    if (!fence.signal.aborted && !signal?.aborted) {
      const operationSignal = AbortSignal.any([fence.signal, ...(signal ? [signal] : [])]);
      didWork = await this.processExistingBindings(
        now,
        operationSignal,
        fence,
      ) || didWork;
    }
    return this.enqueuePendingNotifications(now, didWork, fence);
  }

  private async processExistingBindings(
    now: number,
    signal: AbortSignal,
    fence: EffectFence,
  ): Promise<boolean> {
    let didWork = false;
    const owner = this.dependencies.store.getOwner();
    const controller = owner
      ? this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId)
      : null;
    const candidates = this.dependencies.repository.listReconciliationCandidates(
      Math.max(0, now - AUTOMATION_RECONCILIATION_INTERVAL_MS),
      20,
    );
    for (const binding of candidates) {
      if (signal?.aborted) break;
      const hostId = managedAutomationHostId(binding);
      if (!hostId) {
        this.dependencies.warn?.(`Managed automation ${binding.id} has no verified BB host`);
        continue;
      }
      try {
        if (binding.mode === "agent" && !managedAutomationAuthorityIsCurrent(
          binding,
          controller?.controllerKey ?? null,
          this.dependencies.store.getProjectPolicy(binding.projectId)?.policy.enabled === true,
        )) {
          await this.dependencies.service.pauseForStaleAuthority({
            binding,
            scope: { kind: "host", hostId, cwd: null },
            now,
            fence: executorMutationFence(fence),
            signal,
          });
          didWork = true;
          continue;
        }
        const current = binding.state === "paused" &&
          binding.lastError === "managed_automation_authority_stale"
          ? await this.dependencies.service.setEnabled({
              id: binding.id,
              scope: { kind: "host", hostId, cwd: null },
              enabled: true,
              now,
              fence: executorMutationFence(fence),
              signal,
            })
          : binding;
        await this.dependencies.service.reconcile({
          binding: current,
          scope: { kind: "host", hostId, cwd: null },
          now,
          fence: executorMutationFence(fence),
          signal,
        });
        didWork = true;
      } catch (error) {
        if (error instanceof ManagedAutomationExecutorFenceLostError) break;
        this.dependencies.warn?.(`Managed automation ${binding.id} could not be reconciled`);
      }
    }

    return didWork;
  }

  private async processDurableOperations(
    now: number,
    fence: EffectFence,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let didWork = false;
    for (const pending of this.dependencies.repository.listDueOperations(now, 20)) {
      if (fence.signal.aborted || signal?.aborted) break;
      const operation = this.dependencies.repository.claimOperation({
        operationId: pending.id,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now,
        leaseMs: AUTOMATION_OPERATION_LEASE_MS,
      });
      if (!operation) continue;
      didWork = true;
      const binding = this.dependencies.repository.get(operation.bindingId);
      if (!binding) continue;
      const admission = this.dependencies.service.admitOperation(binding, operation);
      if (!admission.allowed) {
        this.dependencies.repository.settleOperation({
          operationId: operation.id,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now,
          outcome: "failed",
          errorClass: admission.errorClass,
        });
        continue;
      }
      const hostId = managedAutomationHostId(binding);
      if (!hostId) {
        this.dependencies.repository.settleOperation({
          operationId: operation.id,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now,
          outcome: "failed",
          errorClass: "managed_automation_host_unverified",
        });
        continue;
      }
      await this.executeDurableOperation(binding, operation, hostId, now, fence, signal);
    }
    return didWork;
  }

  private async executeDurableOperation(
    binding: ManagedAutomationBinding,
    operation: ManagedAutomationOperation,
    hostId: string,
    now: number,
    fence: EffectFence,
    signal?: AbortSignal,
  ): Promise<void> {
    const operationAbort = new AbortController();
    const operationSignal = AbortSignal.any([fence.signal, operationAbort.signal, ...(signal ? [signal] : [])]);
    const renewal = setInterval(() => {
      const leaseNow = this.dependencies.clock?.now() ?? now;
      if (!this.dependencies.repository.renewOperationLease({
        operationId: operation.id,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: leaseNow,
        leaseMs: AUTOMATION_OPERATION_LEASE_MS,
      })) operationAbort.abort();
    }, AUTOMATION_OPERATION_RENEWAL_MS);
    try {
      if (operationSignal.aborted) return;
      const execution = await this.dependencies.service.executeClaimedOperation({
        binding,
        operation,
        scope: { kind: "host", hostId, cwd: null },
        now: this.dependencies.clock?.now() ?? now,
        signal: operationSignal,
      });
      if (operationSignal.aborted) return;
      this.dependencies.repository.settleOperation({
        operationId: operation.id,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: this.dependencies.clock?.now() ?? now,
        outcome: "succeeded",
        automation: execution.automation,
        run: execution.run,
        outcomeEvidence: execution.run === null ? null : operationRunEvidence(execution.run),
      });
    } catch (error) {
      if (operationSignal.aborted) return;
      this.dependencies.repository.settleOperation({
        operationId: operation.id,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: this.dependencies.clock?.now() ?? now,
        outcome: "ambiguous",
        errorClass: automationErrorClass(error),
      });
      this.dependencies.warn?.(`Managed automation ${binding.id} provider outcome is ambiguous`);
    } finally {
      clearInterval(renewal);
    }
  }

  private enqueuePendingNotifications(
    now: number,
    didWork: boolean,
    fence: EffectFence,
  ): boolean {
    const owner = this.dependencies.store.getOwner();
    const controller = owner
      ? this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId)
      : null;
    if (!owner || !controller) return didWork;
    for (const notification of this.dependencies.repository.listPendingNotifications(20)) {
      if (notification.controllerKey !== controller.controllerKey) continue;
      try {
        const marked = this.dependencies.store.enqueueManagedAutomationNotification({
          sequence: notification.sequence,
          controllerKey: notification.controllerKey,
          telegramUserId: owner.userId,
          telegramChatId: owner.chatId,
          updateId: notification.updateId,
          inputText: notification.inputText,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now,
        });
        if (marked) {
          didWork = true;
          this.dependencies.notify();
        }
      } catch (error) {
        if (!(error instanceof ManagedAutomationExecutorFenceLostError)) throw error;
        return didWork;
      }
    }
    return didWork;
  }
}

function managedAutomationHostId(binding: ManagedAutomationBinding): string | null {
  if (isCurrentManagedAutomationAuthority(binding.authority)) return binding.authority.hostId;
  return typeof binding.authority.hostId === "string" ? binding.authority.hostId : null;
}

export function managedAutomationAuthorityIsCurrent(
  binding: ManagedAutomationBinding,
  currentControllerKey: string | null,
  projectEnabled: boolean,
): boolean {
  if (!projectEnabled || currentControllerKey !== binding.controllerKey) return false;
  if (isCurrentManagedAutomationAuthority(binding.authority)) {
    return binding.authority.controllerKey === binding.controllerKey &&
      binding.authority.projectId === binding.projectId &&
      binding.authority.hostId.length > 0 &&
      binding.authority.mayWidenAutomation === false;
  }
  // The predecessor authority shape remains readable for migration and
  // rollback, but it has no authority to admit a new provider mutation.
  return false;
}
