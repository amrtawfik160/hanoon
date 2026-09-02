import { redactError } from "../errors";
import {
  BbAutomationNotFoundError,
  BbAutomationProjectUnavailableError,
  DEFAULT_BB_AGENT_AUTOMATION_RESULT_CONTRACT,
  DEFAULT_BB_AGENT_AUTOMATION_TIMEOUT_MS,
} from "../bb/automation";
import type { MonitorRecord, TelegramAgentStore } from "../storage/store";
import type {
  ManagedAutomationOperation,
  ManagedAutomationControllerFence,
  ManagedAutomationBinding,
} from "../storage/managed-automation-repository";
import {
  ManagedAutomationRepository,
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
import { isCurrentManagedAutomationAuthority } from "../domain/managed-automation";
import type { EffectFence } from "./effect-runner";

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

export type CreateManagedAutomationInput = Readonly<{
  scope: ManagedAutomationScope;
  controllerKey: string;
  sourceKey: string;
  definition: ManagedAutomationDefinition;
  authority: StoredManagedAutomationAuthority;
  notificationPolicy: "material" | "always" | "silent";
  legacyMonitorId?: string | null;
  now: number;
  mutate?: ManagedAutomationMutation;
  signal?: AbortSignal;
  deferProvider?: boolean;
  operation?: ManagedAutomationOperationRequest;
  controllerFence?: ManagedAutomationControllerFence;
}>;

export type ManagedAutomationMutation = <T>(mutation: () => T) => T;

function applyMutation<T>(mutate: ManagedAutomationMutation | undefined, mutation: () => T): T {
  return mutate ? mutate(mutation) : mutation();
}

function ownershipMarkerFor(identity: string): string {
  return `hanoon:${managedAutomationDigest(identity).slice(0, 40)}`;
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

function executorMutation(
  store: Pick<TelegramAgentStore, "runExecutorMutation">,
  fence: EffectFence,
): ManagedAutomationMutation {
  return <T>(mutation: () => T): T => {
    const result = store.runExecutorMutation({ ownerId: fence.ownerId, generation: fence.generation }, mutation);
    if (result.outcome === "stale") throw new ManagedAutomationExecutorFenceLostError();
    return result.mutationValue;
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
    private readonly repository: ManagedAutomationRepository,
    private readonly adapter: ManagedAutomationAdapter,
    private readonly authorityIsCurrent: (binding: ManagedAutomationBinding) => boolean,
    private readonly capabilityIsCurrent: (binding: ManagedAutomationBinding, operation: ManagedAutomationOperation) => boolean = () => true,
  ) {}

  public get(id: string): ManagedAutomationBinding | null {
    return this.repository.get(id);
  }

  public list(controllerKey: string, includeRetired = false): ManagedAutomationBinding[] {
    return this.repository.list(controllerKey, includeRetired);
  }

  public async create(input: CreateManagedAutomationInput): Promise<ManagedAutomationBinding> {
    const deferred = input.deferProvider === true || input.operation !== undefined;
    if (deferred && (!input.operation || !input.controllerFence || !input.mutate)) {
      throw new TypeError("deferred managed automation creation requires an operation fence");
    }
    const reserved = applyMutation(input.mutate, () => this.repository.reserve({
      controllerKey: input.controllerKey,
      sourceKey: input.sourceKey,
      projectId: input.definition.projectId,
      name: input.definition.name,
      definition: input.definition,
      authority: input.authority,
      notificationPolicy: input.notificationPolicy,
      legacyMonitorId: input.legacyMonitorId ?? null,
      now: input.now,
      definitionRevision: input.operation?.definitionRevision ?? 1,
      operation: input.operation,
      controllerFence: input.controllerFence,
    }));
    if (deferred) {
      return reserved;
    }
    if (reserved.mode === "agent" && !this.authorityIsCurrent(reserved)) {
      if (reserved.bbAutomationId === null) {
        applyMutation(input.mutate, () => this.repository.fail(
          reserved.id,
          "managed_automation_authority_stale",
          input.now,
        ));
      } else {
        await this.pauseForStaleAuthority({
          binding: reserved,
          scope: input.scope,
          now: input.now,
          mutate: input.mutate,
          signal: input.signal,
        });
      }
      throw new Error("managed automation authority is not current");
    }
    if (reserved.bbAutomationId !== null) {
      return this.reconcile({
        binding: reserved,
        scope: input.scope,
        now: input.now,
        mutate: input.mutate,
        signal: input.signal,
      });
    }
    // BB's create has no idempotency key, so the durable order is: stamp a
    // deterministic ownership marker, ask BB once, verify the receipt carries
    // that exact marker, persist the provider id, read it back exactly, and
    // only then activate. A crash anywhere in between is finished by
    // reconciliation — which finds the marked automation rather than creating
    // a second schedule.
    const providerIdentity: ManagedAutomationProviderIdentity = {
      operationId: reserved.id,
      ownershipMarker: ownershipMarkerFor(reserved.id),
    };
    applyMutation(input.mutate, () => this.repository.setProviderOwnershipMarker({
      id: reserved.id,
      ownershipMarker: providerIdentity.ownershipMarker,
      now: input.now,
    }));
    let receipt: ManagedAutomationCreateReceipt | null = null;
    try {
      receipt = await this.adapter.create({
        scope: input.scope,
        definition: input.definition,
        identity: providerIdentity,
        signal: input.signal,
      });
      if (receipt.operationId !== providerIdentity.operationId ||
        receipt.ownershipMarker !== providerIdentity.ownershipMarker) {
        throw new TypeError("managed automation provider acknowledgement identity does not match its binding");
      }
      const acknowledged = applyMutation(input.mutate, () => this.repository.attachProviderAutomation({
        id: reserved.id,
        providerAutomationId: receipt!.providerAutomationId,
        ownershipMarker: receipt!.ownershipMarker,
        now: input.now,
      }));
      const automation = await this.adapter.show({
        scope: input.scope,
        projectId: input.definition.projectId,
        automationId: acknowledged.bbAutomationId!,
        expectedDefinition: input.definition,
        identity: providerIdentity,
        signal: input.signal,
      });
      return applyMutation(input.mutate, () => this.repository.activate({
        id: reserved.id,
        automation,
        now: input.now,
      }));
    } catch (error) {
      try {
        // A create BB acknowledged is never deleted to tidy up: the binding
        // keeps BB's id and the ownership marker, so reconciliation retries the
        // exact read-back and can still recognise the schedule as Hanoon's.
        applyMutation(input.mutate, () => this.repository.fail(
          reserved.id,
          receipt === null ? automationErrorClass(error) : "bb_automation_provider_readback_failed",
          input.now,
        ));
      } catch {
        // A stale controller fence is the primary failure and must not be
        // bypassed merely to persist an error marker.
      }
      throw error;
    }
  }

  public admitOperation(
    binding: ManagedAutomationBinding,
    operation: ManagedAutomationOperation,
  ): Readonly<{ allowed: true } | { allowed: false; errorClass: string }> {
    if (operation.operationClass !== "create") return { allowed: false, errorClass: "managed_automation_operation_unsupported" };
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
    if (isCurrentManagedAutomationAuthority(operation.authority) && (!operation.controllerFence ||
      (operation.authority.origin === "owner" && operation.authority.taskAuthority.turnId !== operation.controllerFence.turnId))) {
      return { allowed: false, errorClass: "managed_automation_operation_stale" };
    }
    if (binding.state === "retired") return { allowed: false, errorClass: "managed_automation_binding_retired" };
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
  }): Promise<ManagedAutomationObservation> {
    const admission = this.admitOperation(input.binding, input.operation);
    if (!admission.allowed) throw new Error(admission.errorClass);
    const providerIdentity = existingProviderIdentity(input.binding, input.operation);
    if (!providerIdentity) throw new Error("managed_automation_provider_identity_missing");
    if (input.operation.attempts > 1 && !this.adapter.findByDefinition &&
      input.operation.providerAutomationId === null && input.binding.bbAutomationId === null) {
      throw new Error("managed_automation_reconciliation_unsupported");
    }
    const knownProviderAutomationId = input.operation.providerAutomationId ?? input.binding.bbAutomationId;
    if (knownProviderAutomationId !== null) {
      return this.adapter.show({
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId: knownProviderAutomationId,
        expectedDefinition: input.binding.definition,
        expectedEnabled: true,
        identity: providerIdentity,
        signal: input.signal,
      });
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
      return existing;
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
    return this.adapter.show({
      scope: input.scope,
      projectId: input.binding.projectId,
      automationId: receipt.providerAutomationId,
      expectedDefinition: input.binding.definition,
      expectedEnabled: true,
      identity: providerIdentity,
      signal: input.signal,
    });
  }

  public async reconcile(input: {
    binding: ManagedAutomationBinding;
    scope: ManagedAutomationScope;
    now: number;
    mutate?: ManagedAutomationMutation;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    if (input.binding.bbAutomationId === null) throw new Error("managed automation has no BB automation id");
    if (input.binding.state === "retiring") {
      await deleteAutomationForRetirement(this.adapter, {
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId: input.binding.bbAutomationId,
        signal: input.signal,
      });
      return applyMutation(input.mutate, () => this.repository.retire(input.binding.id, input.now));
    }
    if (input.binding.mode === "agent" && !this.authorityIsCurrent(input.binding)) {
      return this.pauseForStaleAuthority({
        binding: input.binding,
        scope: input.scope,
        now: input.now,
        mutate: input.mutate,
        signal: input.signal,
      });
    }
    if (input.binding.state === "updating") {
      const automation = await this.adapter.update({
        scope: input.scope,
        definition: input.binding.definition,
        automationId: input.binding.bbAutomationId,
        expectedEnabled: input.binding.observed?.enabled ?? true,
        identity: existingProviderIdentity(input.binding),
        signal: input.signal,
      });
      return applyMutation(input.mutate, () => this.repository.activate({
        id: input.binding.id,
        automation,
        now: input.now,
      }));
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
      const active = applyMutation(input.mutate, () => this.repository.activate({
        id: input.binding.id,
        automation,
        now: input.now,
      }));
      const runs = await this.adapter.runs({
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId: input.binding.bbAutomationId,
        limit: 20,
        signal: input.signal,
      });
      applyMutation(input.mutate, () => {
        for (const run of [...runs].reverse()) this.repository.recordRun(active.id, run, input.now);
      });
      return this.repository.get(active.id)!;
    } catch (error) {
      try {
        applyMutation(input.mutate, () => this.repository.fail(
          input.binding.id,
          automationErrorClass(error),
          input.now,
        ));
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
    mutate?: ManagedAutomationMutation;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    const binding = requireActiveBinding(this.repository, input.id);
    if (input.enabled && binding.mode === "agent" && !this.authorityIsCurrent(binding)) {
      throw new Error("managed automation authority is not current");
    }
    const automation = await this.adapter.setEnabled({
      scope: input.scope,
      projectId: binding.projectId,
      automationId: binding.bbAutomationId!,
      enabled: input.enabled,
      expectedDefinition: binding.definition,
      identity: existingProviderIdentity(binding),
      signal: input.signal,
    });
    return applyMutation(input.mutate, () => this.repository.activate({ id: binding.id, automation, now: input.now }));
  }

  public async update(input: {
    id: string;
    scope: ManagedAutomationScope;
    definition: ManagedAutomationDefinition;
    now: number;
    mutate?: ManagedAutomationMutation;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    const updating = applyMutation(input.mutate, () => this.repository.beginUpdate({
      id: input.id,
      definition: input.definition,
      now: input.now,
    }));
    if (updating.mode === "agent" && !this.authorityIsCurrent(updating)) {
      await this.pauseForStaleAuthority({
        binding: updating,
        scope: input.scope,
        now: input.now,
        mutate: input.mutate,
        signal: input.signal,
      });
      throw new Error("managed automation authority is not current");
    }
    const automation = await this.adapter.update({
      scope: input.scope,
      definition: updating.definition,
      automationId: updating.bbAutomationId!,
      expectedEnabled: updating.observed?.enabled ?? true,
      identity: existingProviderIdentity(updating),
      signal: input.signal,
    });
    return applyMutation(input.mutate, () => this.repository.activate({
      id: updating.id,
      automation,
      now: input.now,
    }));
  }

  public async pauseForStaleAuthority(input: {
    binding: ManagedAutomationBinding;
    scope: ManagedAutomationScope;
    now: number;
    mutate?: ManagedAutomationMutation;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    let binding = input.binding;
    if (binding.state === "updating") {
      const updated = await this.adapter.update({
        scope: input.scope,
        definition: binding.definition,
        automationId: binding.bbAutomationId!,
        expectedEnabled: binding.observed?.enabled ?? true,
        identity: existingProviderIdentity(binding),
        signal: input.signal,
      });
      binding = applyMutation(input.mutate, () => this.repository.activate({ id: binding.id, automation: updated, now: input.now }));
    }
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
      binding = applyMutation(input.mutate, () => this.repository.activate({ id: binding.id, automation: paused, now: input.now }));
    }
    return applyMutation(input.mutate, () => this.repository.markPolicyBlocked(binding.id, input.now));
  }

  public async runNow(input: {
    id: string;
    scope: ManagedAutomationScope;
    idempotencyKey: string;
    now: number;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationRun> {
    const binding = requireActiveBinding(this.repository, input.id);
    if (binding.mode === "agent" && !this.authorityIsCurrent(binding)) {
      throw new Error("managed automation authority is not current");
    }
    const run = await this.adapter.runNow({
      scope: input.scope,
      projectId: binding.projectId,
      automationId: binding.bbAutomationId!,
      idempotencyKey: input.idempotencyKey,
      signal: input.signal,
    });
    this.repository.recordRun(binding.id, run, input.now);
    return run;
  }

  public async retire(input: {
    id: string;
    scope: ManagedAutomationScope;
    now: number;
    mutate?: ManagedAutomationMutation;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    const binding = applyMutation(input.mutate, () => {
      const current = this.repository.get(input.id);
      if (current?.state === "retiring" && current.bbAutomationId !== null) return current;
      const active = requireActiveBinding(this.repository, input.id);
      return this.repository.beginRetirement(active.id, input.now);
    });
    await deleteAutomationForRetirement(this.adapter, {
      scope: input.scope,
      projectId: binding.projectId,
      automationId: binding.bbAutomationId!,
      signal: input.signal,
    });
    return applyMutation(input.mutate, () => this.repository.retire(binding.id, input.now));
  }
}

function requireActiveBinding(
  repository: ManagedAutomationRepository,
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
  if (error instanceof BbAutomationProjectUnavailableError) return "bb_automation_project_unavailable";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timed out")) return "bb_automation_timeout";
  if (message.includes("aborted")) return "bb_automation_aborted";
  if (message.includes("reconcile")) return "bb_automation_reconciliation_failed";
  return "bb_automation_operation_failed";
}

export async function migrateLegacyClockMonitor(input: {
  monitor: MonitorRecord;
  store: Pick<TelegramAgentStore, "cancelMonitor">;
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
      // Same name as a fresh install of the same upkeep, so a later pass that
      // no longer sees the legacy row reserves the identical durable definition.
      name: input.monitor.systemKey
        ? `Hanoon ${input.monitor.systemKey}`
        : `Hanoon schedule ${input.monitor.id.slice(0, 24)}`,
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
      source: input.monitor.systemKey ? "system" : "owner",
      controllerKey: input.controllerKey,
      projectId: input.projectId,
      ...(input.hostId ? { hostId: input.hostId } : {}),
      mayWidenAutomation: false,
    },
    notificationPolicy: "material",
    legacyMonitorId: input.monitor.id,
    now: input.now,
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
      signal: input.signal,
    });
    throw new Error("legacy Hanoon schedule could not be disabled after BB verification");
  }
  return binding;
}

const AUTOMATION_RECONCILIATION_INTERVAL_MS = 60_000;
const AUTOMATION_OPERATION_LEASE_MS = 120_000;
const AUTOMATION_OPERATION_RENEWAL_MS = 30_000;

export class ManagedAutomationReconciler {
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  public constructor(private readonly dependencies: Readonly<{
    repository: ManagedAutomationRepository;
    service: ManagedAutomationService;
    store: Pick<
      TelegramAgentStore,
      "getOwner" | "getControllerForOwner" | "getProjectPolicy" | "enqueueControllerTurn" |
      "cancelMonitor" | "runExecutorMutation"
    >;
    notify(): void;
    warn?(message: string): void;
    clock?: { now(): number };
  }>) {}

  public async processDue(now: number, signal?: AbortSignal, fence?: EffectFence): Promise<boolean> {
    if (now - this.lastSweepAt < AUTOMATION_RECONCILIATION_INTERVAL_MS) return false;
    this.lastSweepAt = now;
    if (fence) {
      if (fence.signal.aborted || signal?.aborted) return false;
      let didWork = await this.processDurableOperations(now, fence, signal);
      if (!fence.signal.aborted && !signal?.aborted) {
        const operationSignal = AbortSignal.any([fence.signal, ...(signal ? [signal] : [])]);
        didWork = await this.processExistingBindings(
          now,
          operationSignal,
          executorMutation(this.dependencies.store, fence),
        ) || didWork;
      }
      return this.enqueuePendingNotifications(
        now,
        didWork,
        executorMutation(this.dependencies.store, fence),
      );
    }
    const didWork = await this.processExistingBindings(now, signal);
    return this.enqueuePendingNotifications(now, didWork);
  }

  private async processExistingBindings(
    now: number,
    signal?: AbortSignal,
    mutate?: ManagedAutomationMutation,
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
          controller,
          this.dependencies.store.getProjectPolicy(binding.projectId)?.policy.enabled === true,
        )) {
          await this.dependencies.service.pauseForStaleAuthority({
            binding,
            scope: { kind: "host", hostId, cwd: null },
            now,
            mutate,
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
              mutate,
              signal,
            })
          : binding;
        const reconciled = await this.dependencies.service.reconcile({
          binding: current,
          scope: { kind: "host", hostId, cwd: null },
          now,
          mutate,
          signal,
        });
        if (reconciled.legacyMonitorId !== null &&
          this.dependencies.store.cancelMonitor(reconciled.legacyMonitorId, now)) {
          // The handover to BB was interrupted after BB had read the schedule
          // back. Finishing it here keeps one task out of two schedulers.
          this.dependencies.warn?.(`Managed automation ${binding.id} cancelled its leftover legacy schedule`);
        }
        didWork = true;
      } catch (error) {
        if (error instanceof ManagedAutomationExecutorFenceLostError) break;
        this.dependencies.warn?.(
          `Managed automation ${binding.id} could not be reconciled: ${redactError(error).slice(0, 200)}`,
        );
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
      const automation = await this.dependencies.service.executeClaimedOperation({
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
        automation,
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
    mutate?: ManagedAutomationMutation,
  ): boolean {
    const owner = this.dependencies.store.getOwner();
    const controller = owner
      ? this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId)
      : null;
    if (!owner || !controller) return didWork;
    for (const notification of this.dependencies.repository.listPendingNotifications(20)) {
      if (notification.controllerKey !== controller.controllerKey) continue;
      try {
        const marked = applyMutation(mutate, () => {
          this.dependencies.store.enqueueControllerTurn({
            controllerKey: notification.controllerKey,
            telegramUserId: owner.userId,
            telegramChatId: owner.chatId,
            updateId: notification.updateId,
            inputText: notification.inputText,
            origin: "system",
            now,
          });
          return this.dependencies.repository.markNotificationEnqueued(notification.sequence, now);
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
  controller: Readonly<{ controllerKey: string; projectId: string | null }> | null,
  projectPolicyEnabled: boolean,
): boolean {
  if (controller === null || controller.controllerKey !== binding.controllerKey) return false;
  // The controller's own project needs no repository policy: upkeep and the
  // owner's follow-up schedules run where the controller itself already runs.
  // Any other project must still be an enabled Hanoon project.
  const projectAuthorized = projectPolicyEnabled ||
    (controller.projectId !== null && controller.projectId === binding.projectId);
  if (!projectAuthorized) return false;
  if (isCurrentManagedAutomationAuthority(binding.authority)) {
    return binding.authority.controllerKey === binding.controllerKey &&
      binding.authority.projectId === binding.projectId &&
      binding.authority.hostId.length > 0 &&
      binding.authority.mayWidenAutomation === false;
  }
  const authority = binding.authority;
  return authority.controllerKey === binding.controllerKey && authority.projectId === binding.projectId &&
    typeof authority.hostId === "string" && authority.mayWidenAutomation === false;
}
