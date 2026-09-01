import {
  BbAutomationNotFoundError,
  DEFAULT_BB_AGENT_AUTOMATION_RESULT_CONTRACT,
  DEFAULT_BB_AGENT_AUTOMATION_TIMEOUT_MS,
} from "../bb/automation";
import type { MonitorRecord, TelegramAgentStore } from "../storage/store";
import type {
  ManagedAutomationOperation,
  ManagedAutomationControllerFence,
  ManagedAutomationBinding,
  ManagedAutomationDesiredState,
} from "../storage/managed-automation-repository";
import {
  ManagedAutomationRepository,
  managedAutomationDigest,
} from "../storage/managed-automation-repository";
import {
  ManagedAutomationProvenanceRepository,
  managedAutomationCapabilityEvidenceFromAdmission,
  type ManagedAutomationCapabilityAdmission,
  type ManagedAutomationProvenanceOrigin,
} from "../storage/managed-automation-provenance-repository";
import { capabilityDescriptorById } from "../capabilities/catalog";
import type {
  ManagedAutomationCapabilities,
  ManagedAutomationCreateReceipt,
  ManagedAutomationDefinition,
  ManagedAutomationObservation,
  ManagedAutomationAuthority,
  ManagedAutomationOperationClass,
  ManagedAutomationOperationRequest,
  ManagedAutomationProviderIdentity,
  ManagedAutomationRun,
  ManagedAutomationScope,
  ManagedAutomationTarget,
  StoredManagedAutomationAuthority,
} from "../domain/managed-automation";
import {
  isCurrentManagedAutomationAuthority,
  managedAutomationAuthorityCoversOperation,
  managedAutomationAuthoritySchema,
  managedAutomationOutcomeReceiptSchema,
  parseManagedAutomationAuthority,
} from "../domain/managed-automation";
import type { ManagedAutomationRunReceipt } from "../domain/managed-automation";
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
  mutate?: ManagedAutomationMutation;
  signal?: AbortSignal;
  operation: ManagedAutomationOperationRequest;
  controllerFence?: ManagedAutomationControllerFence;
}>;

export type ManagedAutomationMutation = <T>(mutation: () => T) => T;

export type ManagedAutomationCapabilityOperation = Readonly<Pick<
  ManagedAutomationOperation,
  "operationClass" | "targetProjectId" | "definitionRevision" | "capabilityEvidence"
> & {
  targetHostId?: string | null;
}>;

export type SubmitManagedAutomationLifecycleInput = Readonly<{
  id: string;
  operationClass: Exclude<ManagedAutomationOperationClass, "create">;
  desiredState: ManagedAutomationDesiredState;
  authority: ManagedAutomationAuthority;
  controllerFence?: ManagedAutomationControllerFence;
  definition?: ManagedAutomationDefinition;
  intentKey?: string;
  now: number;
  mutate?: ManagedAutomationMutation;
}>;

type ManagedAutomationLifecycleIntentInput = Omit<SubmitManagedAutomationLifecycleInput, "authority"> & Readonly<{
  authority?: ManagedAutomationAuthority;
}>;

export type ManagedAutomationCreateIntentInput = Readonly<Omit<
  CreateManagedAutomationInput,
  "authority" | "operation" | "controllerFence"
> & {
  hostId: string;
  operation?: ManagedAutomationOperationRequest;
}>;

export type ManagedAutomationIntentMutationInput = Readonly<Omit<
  SubmitManagedAutomationLifecycleInput,
  "authority" | "controllerFence"
>>;

export type RecursiveIntentInput = ManagedAutomationIntentMutationInput & Readonly<{
  parentOperationId: string;
  rootAutomationId?: string;
  maxDepth?: number;
}>;

type SystemMaintenanceRetirementInput = Readonly<{
  id: string;
  systemKey: string;
  now: number;
  mutate: ManagedAutomationMutation;
}>;

function isSystemMaintenanceBinding(binding: ManagedAutomationBinding, systemKey: string): boolean {
  if (binding.sourceKey !== systemKey) return false;
  return isCurrentManagedAutomationAuthority(binding.authority)
    ? binding.authority.origin === "system-maintenance" &&
        binding.authority.standingAuthority.systemKey === systemKey
    : binding.authority.source === "system";
}

function lifecycleIntentKey(authority: ManagedAutomationAuthority): string {
  switch (authority.origin) {
    case "owner": return authority.taskAuthority.turnId;
    case "automation-triggered": return authority.taskAuthority.operationId;
    case "standing-policy": return `policy:${authority.standingAuthority.policyId}:${authority.standingAuthority.revision}`;
    case "system-maintenance": return `system:${authority.standingAuthority.systemKey}:${authority.standingAuthority.revision}`;
  }
}

export type ManagedAutomationExecutionResult = Readonly<{
  automation: ManagedAutomationObservation | null;
  run: ManagedAutomationRun | null;
  runs: readonly ManagedAutomationRun[];
}>;

function applyMutation<T>(mutate: ManagedAutomationMutation | undefined, mutation: () => T): T {
  if (!mutate) throw new Error("managed automation durable mutation requires an execution fence");
  return mutate(mutation);
}

function ownershipMarkerFor(identity: string): string {
  return `hanoon:${managedAutomationDigest(identity).slice(0, 40)}`;
}

function existingProviderIdentity(
  binding: ManagedAutomationBinding,
  operation?: ManagedAutomationOperation,
): ManagedAutomationProviderIdentity | undefined {
  const ownershipMarker = binding.providerOwnershipMarker ?? operation?.providerOwnershipMarker;
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

function agentExecutionContractIsSupported(adapter: ManagedAutomationAdapter): boolean {
  const support = adapter.agentAutomationCapabilities;
  return support.executionTimeout && support.resultContract && support.preRunAuthority;
}

function assertAgentExecutionContractSupported(adapter: ManagedAutomationAdapter): void {
  if (!agentExecutionContractIsSupported(adapter)) throw new ManagedAgentExecutionContractUnsupportedError();
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

function observationMatchesDefinition(
  binding: ManagedAutomationBinding,
  observation: ManagedAutomationObservation,
  expectedEnabled?: boolean,
  identity?: ManagedAutomationProviderIdentity,
): boolean {
  const marker = binding.providerOwnershipMarker ?? identity?.ownershipMarker;
  const providerName = marker ? `${binding.definition.name} [${marker}]` : null;
  return observation.projectId === binding.projectId &&
    (observation.name === binding.definition.name || observation.name === providerName) &&
    (expectedEnabled === undefined || observation.enabled === expectedEnabled) &&
    observation.mode === binding.definition.mode &&
    managedAutomationDigest(observation.trigger) === managedAutomationDigest(binding.definition.trigger) &&
    managedAutomationDigest(observation.target) === managedAutomationDigest(
      binding.definition.mode === "agent" ? binding.definition.target : null,
    );
}

function normalizeObservedName(
  binding: ManagedAutomationBinding,
  observation: ManagedAutomationObservation,
  identity?: ManagedAutomationProviderIdentity,
): ManagedAutomationObservation {
  const marker = binding.providerOwnershipMarker ?? identity?.ownershipMarker;
  const providerName = marker
    ? `${binding.definition.name} [${marker}]`
    : binding.definition.name;
  if (observation.projectId !== binding.projectId ||
    (observation.name !== binding.definition.name && observation.name !== providerName)) {
    throw new TypeError("provider automation does not match its managed binding");
  }
  return observation.name === binding.definition.name
    ? observation
    : { ...observation, name: binding.definition.name };
}

function assertProviderObservationOwnership(
  binding: ManagedAutomationBinding,
  observation: ManagedAutomationObservation,
  identity?: ManagedAutomationProviderIdentity,
): void {
  const marker = binding.providerOwnershipMarker ?? identity?.ownershipMarker;
  const expectedName = marker ? `${binding.definition.name} [${marker}]` : binding.definition.name;
  if (observation.projectId !== binding.projectId || observation.name !== expectedName) {
    throw new TypeError("provider automation does not match its managed binding");
  }
}

function normalizeAndValidateObservation(
  binding: ManagedAutomationBinding,
  observation: ManagedAutomationObservation,
  expectedEnabled: boolean,
  identity?: ManagedAutomationProviderIdentity,
): ManagedAutomationObservation {
  const normalized = normalizeObservedName(binding, observation, identity);
  if (!observationMatchesDefinition(binding, normalized, expectedEnabled, identity)) {
    throw new TypeError("provider automation definition does not match its managed binding");
  }
  return normalized;
}

function desiredEnabled(binding: ManagedAutomationBinding): boolean {
  return binding.desiredState === "enabled";
}

function requireProviderAutomationId(input: {
  binding: ManagedAutomationBinding;
  operation: ManagedAutomationOperation;
}): string {
  const automationId = input.operation.providerAutomationId ?? input.binding.bbAutomationId;
  if (automationId === null) throw new Error("managed_automation_provider_identity_missing");
  return automationId;
}

function projectPolicyAuthorityId(projectId: string): string {
  return `project-policy:${projectId}`;
}

function creationOperation(input: Readonly<{
  targetProjectId: string;
  targetHostId: string;
  intentKey: string;
}>): ManagedAutomationOperationRequest {
  return {
    version: 1,
    operationClass: "create",
    targetProjectId: input.targetProjectId,
    targetHostId: input.targetHostId,
    definitionRevision: 1,
    intentKey: input.intentKey,
  };
}

export class ManagedAutomationService {
  private readonly provenanceRepository: ManagedAutomationProvenanceRepository;

  public constructor(
    private readonly repository: ManagedAutomationRepository,
    private readonly adapter: ManagedAutomationAdapter,
    private readonly authorityIsCurrent: (binding: ManagedAutomationBinding) => boolean,
    private readonly capabilityIsCurrent: (
      binding: ManagedAutomationBinding,
      operation: ManagedAutomationCapabilityOperation,
    ) => boolean = () => true,
  ) {
    this.provenanceRepository = repository.getProvenanceRepository();
  }

  public get(id: string): ManagedAutomationBinding | null {
    return this.repository.get(id);
  }

  public list(controllerKey: string, includeRetired = false): ManagedAutomationBinding[] {
    return this.repository.list(controllerKey, includeRetired);
  }

  public async createStandingPolicyIntent(
    input: ManagedAutomationCreateIntentInput,
  ): Promise<ManagedAutomationBinding> {
    const policy = this.currentProjectPolicy(input.definition.projectId);
    const admission = applyMutation(input.mutate, () => this.ensureCapabilityProfile({
      origin: "standing-policy",
      subjectKey: `project:${input.definition.projectId}`,
      projectId: input.definition.projectId,
      hostId: input.hostId,
      revision: policy.version,
      policyId: projectPolicyAuthorityId(input.definition.projectId),
      policyRevision: policy.version,
      now: input.now,
    }));
    const authority = managedAutomationAuthoritySchema.parse({
      version: 1,
      origin: "standing-policy",
      controllerKey: input.controllerKey,
      projectId: input.definition.projectId,
      hostId: input.hostId,
      taskAuthority: null,
      standingAuthority: {
        version: 1,
        kind: "project-policy",
        policyId: projectPolicyAuthorityId(input.definition.projectId),
        revision: policy.version,
      },
      capabilityEvidence: managedAutomationCapabilityEvidenceFromAdmission(admission),
      mayWidenAutomation: false,
    });
    return this.createWithAuthority({
      ...input,
      authority,
      operation: input.operation ?? creationOperation({
        targetProjectId: input.definition.projectId,
        targetHostId: input.hostId,
        intentKey: `standing-policy:${input.definition.projectId}`,
      }),
    }, authority);
  }

  public async createSystemMaintenanceIntent(
    input: ManagedAutomationCreateIntentInput & Readonly<{ systemKey: string }>,
  ): Promise<ManagedAutomationBinding> {
    const admission = applyMutation(input.mutate, () => this.ensureCapabilityProfile({
      origin: "system-maintenance",
      subjectKey: `system:${input.systemKey}:${input.definition.projectId}:${input.hostId}`,
      projectId: input.definition.projectId,
      hostId: input.hostId,
      revision: 1,
      now: input.now,
    }));
    const authority = managedAutomationAuthoritySchema.parse({
      version: 1,
      origin: "system-maintenance",
      controllerKey: input.controllerKey,
      projectId: input.definition.projectId,
      hostId: input.hostId,
      taskAuthority: null,
      standingAuthority: {
        version: 1,
        kind: "system-maintenance",
        systemKey: input.systemKey,
        revision: 1,
      },
      capabilityEvidence: managedAutomationCapabilityEvidenceFromAdmission(admission),
      mayWidenAutomation: false,
    });
    const existing = this.repository.getBySource(input.controllerKey, input.sourceKey);
    if (existing && existing.definitionSha256 !== managedAutomationDigest(input.definition)) {
      return this.submitLifecycleWithAuthority({
        id: existing.id,
        operationClass: "update",
        desiredState: "enabled",
        definition: input.definition,
        now: input.now,
        mutate: input.mutate,
      }, authority);
    }
    if (existing) {
      return applyMutation(input.mutate, () => this.repository.refreshAuthority({
        id: existing.id,
        authority,
        now: input.now,
      }));
    }
    return this.createWithAuthority({
      ...input,
      authority,
      operation: input.operation ?? creationOperation({
        targetProjectId: input.definition.projectId,
        targetHostId: input.hostId,
        intentKey: `system-maintenance:${input.systemKey}`,
      }),
    }, authority);
  }

  public submitStandingPolicyOperation(
    input: ManagedAutomationIntentMutationInput,
  ): ManagedAutomationBinding {
    const binding = this.repository.get(input.id);
    if (!binding) throw new Error("managed automation is unavailable");
    const hostId = managedAutomationHostId(binding);
    if (!hostId) throw new Error("managed automation host authority is unavailable");
    const policy = this.currentProjectPolicy(binding.projectId);
    const admission = applyMutation(input.mutate, () => this.ensureCapabilityProfile({
      origin: "standing-policy",
      subjectKey: `project:${binding.projectId}`,
      projectId: binding.projectId,
      hostId,
      revision: policy.version,
      policyId: projectPolicyAuthorityId(binding.projectId),
      policyRevision: policy.version,
      now: input.now,
    }));
    const authority = managedAutomationAuthoritySchema.parse({
      version: 1,
      origin: "standing-policy",
      controllerKey: binding.controllerKey,
      projectId: binding.projectId,
      hostId,
      taskAuthority: null,
      standingAuthority: {
        version: 1,
        kind: "project-policy",
        policyId: projectPolicyAuthorityId(binding.projectId),
        revision: policy.version,
      },
      capabilityEvidence: managedAutomationCapabilityEvidenceFromAdmission(admission),
      mayWidenAutomation: false,
    });
    return this.submitLifecycleWithAuthority({ ...input, authority }, authority);
  }

  public submitAutomationTriggeredOperation(
    input: RecursiveIntentInput,
  ): ManagedAutomationBinding {
    const binding = this.repository.get(input.id);
    if (!binding) throw new Error("managed automation is unavailable");
    const parent = this.requireAuthoritativeParent(input.parentOperationId);
    if (parent.binding.projectId !== binding.projectId) {
      throw new Error("managed automation recursive parent project does not match its target");
    }
    const hostId = managedAutomationHostId(binding);
    if (!hostId || managedAutomationHostId(parent.binding) !== hostId) {
      throw new Error("managed automation recursive parent host does not match its target");
    }
    const policy = this.currentProjectPolicy(binding.projectId);
    const parentAuthority = parent.operation.authority;
    const parentRecursion = isCurrentManagedAutomationAuthority(parentAuthority) &&
      parentAuthority.origin === "automation-triggered"
      ? parentAuthority.recursion
      : null;
    const rootAutomationId = input.rootAutomationId ?? parentRecursion?.rootAutomationId ?? parent.binding.id;
    const depth = parentRecursion
      ? parentRecursion.depth + 1
      : input.rootAutomationId
        ? 1
        : 0;
    const maxDepth = input.maxDepth ?? parentRecursion?.maxDepth ?? 3;
    const lineage = parentRecursion
      ? [...parentRecursion.lineage, parent.binding.id]
      : input.rootAutomationId
        ? [rootAutomationId, parent.binding.id]
        : [parent.binding.id];
    const admission = applyMutation(input.mutate, () => this.ensureCapabilityProfile({
      origin: "automation-triggered",
      subjectKey: `parent:${parent.operation.id}`,
      projectId: binding.projectId,
      hostId,
      revision: 1,
      policyId: projectPolicyAuthorityId(binding.projectId),
      policyRevision: policy.version,
      parentOperationId: parent.operation.id,
      parentRunReceiptDigest: managedAutomationDigest(parent.receipt),
      now: input.now,
    }));
    const authority = managedAutomationAuthoritySchema.parse({
      version: 1,
      origin: "automation-triggered",
      controllerKey: binding.controllerKey,
      projectId: binding.projectId,
      hostId,
      taskAuthority: {
        version: 1,
        kind: "automation",
        automationId: parent.binding.id,
        operationId: parent.operation.id,
        revision: parent.operation.definitionRevision,
      },
      standingAuthority: {
        version: 1,
        kind: "project-policy",
        policyId: projectPolicyAuthorityId(binding.projectId),
        revision: policy.version,
      },
      recursion: {
        version: 1,
        rootAutomationId,
        parentAutomationId: parent.binding.id,
        depth,
        maxDepth,
        lineage,
      },
      operationScope: {
        version: 1,
        operationClass: input.operationClass,
        targetProjectId: binding.projectId,
        targetHostId: binding.authority.hostId,
      },
      capabilityEvidence: managedAutomationCapabilityEvidenceFromAdmission(admission),
      mayWidenAutomation: false,
    });
    return this.submitLifecycleWithAuthority({ ...input, authority }, authority);
  }

  public submitLifecycleOperation(input: SubmitManagedAutomationLifecycleInput): ManagedAutomationBinding {
    const authority = managedAutomationAuthoritySchema.parse(input.authority);
    if (authority.origin !== "owner") {
      throw new Error("non-owner lifecycle requires its origin intent adapter");
    }
    return this.submitLifecycleWithAuthority(input, authority);
  }

  private submitLifecycleWithAuthority(
    input: ManagedAutomationLifecycleIntentInput,
    authority: ManagedAutomationAuthority,
  ): ManagedAutomationBinding {
    const binding = this.repository.get(input.id);
    if (!binding) throw new Error("managed automation is unavailable");
    if (authority.controllerKey !== binding.controllerKey || authority.projectId !== binding.projectId ||
      authority.hostId.length === 0) {
      throw new Error("managed automation authority does not match its binding");
    }
    if (authority.origin === "owner") {
      if (!input.controllerFence || authority.taskAuthority.turnId !== input.controllerFence.turnId) {
        throw new Error("managed automation owner authority does not match its controller fence");
      }
    } else if (input.controllerFence) {
      throw new Error("non-owner managed automation authority cannot carry a controller fence");
    }
    const candidate: ManagedAutomationBinding = {
      ...binding,
      authority,
      capabilityEvidence: authority.capabilityEvidence,
    };
    if (!this.authorityIsCurrent(candidate)) {
      throw new Error("managed automation authority is not current");
    }
    const intentKey = input.intentKey ?? lifecycleIntentKey(authority);
    const prior = this.repository.findOperation(input.id, input.operationClass, intentKey);
    const definitionRevision = prior?.definitionRevision ??
      (input.operationClass === "update" ? binding.definitionRevision + 1 : binding.definitionRevision);
    const operation = {
      version: 1 as const,
      operationClass: input.operationClass,
      targetProjectId: binding.projectId,
      targetHostId: authority.hostId,
      definitionRevision,
      intentKey,
    };
    if (!managedAutomationAuthorityCoversOperation(authority, operation)) {
      throw new Error("managed automation authority does not admit this operation target");
    }
    const capabilityCandidate: ManagedAutomationBinding = {
      ...candidate,
      definition: input.definition ?? binding.definition,
      definitionRevision,
    };
    const capabilityCurrent = authority.origin === "owner"
      ? this.capabilityIsCurrent(capabilityCandidate, {
          ...operation,
          capabilityEvidence: authority.capabilityEvidence,
        })
      : this.nonOwnerProvenanceIsCurrent({
          binding: capabilityCandidate,
          authority,
          capabilityEvidence: authority.capabilityEvidence,
        }) && this.capabilityIsCurrent(capabilityCandidate, {
          ...operation,
          capabilityEvidence: authority.capabilityEvidence,
        });
    if (!capabilityCurrent) {
      throw new Error("managed automation capability evidence is not current");
    }
    return applyMutation(input.mutate, () => this.repository.reserveLifecycle({
      id: input.id,
      definition: input.definition,
      desiredState: input.desiredState,
      authority,
      operation,
      controllerFence: input.controllerFence,
      now: input.now,
    }));
  }

  private currentProjectPolicy(projectId: string) {
    const policy = this.provenanceRepository.getProjectPolicy(projectId);
    if (!policy || policy.policy.projectId !== projectId || !policy.policy.enabled) {
      throw new Error("managed automation project policy is unavailable or disabled");
    }
    return policy;
  }

  private ensureCapabilityProfile(input: Readonly<{
    origin: ManagedAutomationProvenanceOrigin;
    subjectKey: string;
    projectId: string;
    hostId: string;
    revision: number;
    policyId?: string;
    policyRevision?: number;
    parentOperationId?: string;
    parentRunReceiptDigest?: string;
    now: number;
  }>): ManagedAutomationCapabilityAdmission {
    const descriptor = capabilityDescriptorById("telegram_agent_watch");
    if (!descriptor || descriptor.status !== "admitted") {
      throw new Error("managed automation capability is not admitted");
    }
    return this.provenanceRepository.ensureProfile({
      ...input,
      capabilityId: descriptor.id,
      descriptorVersion: descriptor.version,
      descriptorDigest: descriptor.digest,
    });
  }

  private requireAuthoritativeParent(parentOperationId: string): Readonly<{
    operation: ManagedAutomationOperation;
    binding: ManagedAutomationBinding;
    receipt: ManagedAutomationRunReceipt;
  }> {
    const operation = this.repository.getOperation(parentOperationId);
    const binding = operation ? this.repository.get(operation.bindingId) : null;
    const settledOutcome = operation?.outcome
      ? managedAutomationOutcomeReceiptSchema.safeParse(operation.outcome)
      : null;
    const receipt = settledOutcome?.success && settledOutcome.data.outcome === "succeeded"
      ? settledOutcome.data.runReceipt ?? null
      : null;
    if (!operation || !binding || operation.operationClass !== "run_now" || operation.state !== "succeeded" ||
      !receipt || receipt.initiatingOperationId !== operation.id ||
      receipt.automationBindingId !== binding.id || receipt.definitionRevision !== operation.definitionRevision ||
      receipt.providerAutomationId !== operation.providerAutomationId || receipt.outcomeClass !== "succeeded") {
      throw new Error("managed automation recursive authority requires an authoritative parent run receipt");
    }
    if (isCurrentManagedAutomationAuthority(operation.authority) && operation.authority.origin !== "owner" &&
      !this.nonOwnerProvenanceIsCurrent({
        binding,
        authority: operation.authority,
        capabilityEvidence: operation.capabilityEvidence,
      })) {
      throw new Error("managed automation recursive parent provenance is not current");
    }
    return { operation, binding, receipt };
  }

  public submitSystemMaintenanceRetirementOperation(input: SystemMaintenanceRetirementInput): ManagedAutomationBinding {
    const binding = this.repository.get(input.id);
    if (!binding) {
      throw new Error("managed automation is not a system-maintenance binding");
    }
    if (!isSystemMaintenanceBinding(binding, input.systemKey)) {
      throw new Error("managed automation is not a system-maintenance binding");
    }
    const hostId = managedAutomationHostId(binding);
    if (!hostId) throw new Error("managed automation host authority is unavailable");
    const admission = applyMutation(input.mutate, () => this.ensureCapabilityProfile({
      origin: "system-maintenance",
      subjectKey: `system:${input.systemKey}:${binding.projectId}:${hostId}`,
      projectId: binding.projectId,
      hostId,
      revision: 1,
      now: input.now,
    }));
    const authority = managedAutomationAuthoritySchema.parse({
      version: 1,
      origin: "system-maintenance",
      controllerKey: binding.controllerKey,
      projectId: binding.projectId,
      hostId,
      taskAuthority: null,
      standingAuthority: {
        version: 1,
        kind: "system-maintenance",
        systemKey: input.systemKey,
        revision: 1,
      },
      capabilityEvidence: managedAutomationCapabilityEvidenceFromAdmission(admission),
      mayWidenAutomation: false,
    });
    return this.submitLifecycleWithAuthority({
      id: input.id,
      operationClass: "retire",
      desiredState: "retired",
      now: input.now,
      mutate: input.mutate,
    }, authority);
  }

  public submitReconciliationOperation(input: {
    binding: ManagedAutomationBinding;
    now: number;
    mutate?: ManagedAutomationMutation;
  }): ManagedAutomationBinding | null {
    const binding = this.repository.get(input.binding.id);
    const authority = binding?.authority;
    if (!binding || !authority || !isCurrentManagedAutomationAuthority(authority) ||
      !binding.capabilityEvidence || !this.authorityIsCurrent(binding)) return null;
    const previous = binding.lastOperationId ? this.repository.getOperation(binding.lastOperationId) : null;
    const retrying = previous?.operationClass === "reconcile" &&
      ["pending", "leased", "failed", "ambiguous"].includes(previous.state);
    const intentKey = retrying && previous.intentKey
      ? previous.intentKey
      : `reconcile:${previous?.operationClass === "reconcile" ? previous.id : "initial"}`;
    const operationRequest = {
      version: 1 as const,
      operationClass: "reconcile" as const,
      targetProjectId: binding.projectId,
      targetHostId: authority.hostId,
      definitionRevision: binding.definitionRevision,
      intentKey,
    };
    const capabilityCurrent = authority.origin === "owner"
      ? this.capabilityIsCurrent(binding, {
          ...operationRequest,
          capabilityEvidence: binding.capabilityEvidence,
        })
      : this.nonOwnerProvenanceIsCurrent({
          binding,
          authority,
          capabilityEvidence: binding.capabilityEvidence,
        }) && this.capabilityIsCurrent(binding, {
          ...operationRequest,
          capabilityEvidence: binding.capabilityEvidence,
        });
    if (!capabilityCurrent) return null;
    const reserve = () => this.repository.reserveLifecycle({
      id: binding.id,
      desiredState: binding.desiredState,
      authority,
      operation: operationRequest,
      now: input.now,
    });
    return applyMutation(input.mutate, reserve);
  }

  public async create(input: CreateManagedAutomationInput): Promise<ManagedAutomationBinding> {
    const authority = parseManagedAutomationAuthority(input.authority);
    if (!isCurrentManagedAutomationAuthority(authority)) {
      throw new Error("legacy managed automation authority must be revalidated before mutation");
    }
    if (authority.origin !== "owner") {
      throw new Error("non-owner creation requires its origin intent adapter");
    }
    return this.createWithAuthority(input, authority);
  }

  private async createWithAuthority(
    input: CreateManagedAutomationInput,
    authority: ManagedAutomationAuthority,
  ): Promise<ManagedAutomationBinding> {
    const operation = {
      ...input.operation,
      targetHostId: input.operation.targetHostId ?? authority.hostId,
    };
    if (operation.operationClass !== "create" ||
      !managedAutomationAuthorityCoversOperation(authority, operation)) {
      throw new Error("managed automation authority does not admit this creation operation");
    }
    if (authority.origin === "owner" &&
      (!input.controllerFence || input.controllerFence.turnId !== authority.taskAuthority.turnId)) {
      throw new Error("managed automation owner creation requires its controller fence");
    }
    if (authority.origin !== "owner" && input.controllerFence) {
      throw new Error("non-owner managed automation creation cannot carry a controller fence");
    }
    if (input.definition.mode === "agent") assertAgentExecutionContractSupported(this.adapter);
    const reserved = applyMutation(input.mutate, () => this.repository.reserve({
      controllerKey: input.controllerKey,
      sourceKey: input.sourceKey,
      projectId: input.definition.projectId,
      name: input.definition.name,
      definition: input.definition,
      authority,
      notificationPolicy: input.notificationPolicy,
      legacyMonitorId: input.legacyMonitorId ?? null,
      now: input.now,
      definitionRevision: operation.definitionRevision,
      operation,
      controllerFence: input.controllerFence,
    }));
    const authorityCurrent = this.authorityIsCurrent(reserved);
    const capabilityCurrent = authority.origin === "owner"
      ? this.capabilityIsCurrent(reserved, {
          operationClass: "create",
          targetProjectId: reserved.projectId,
          targetHostId: authority.hostId,
          definitionRevision: reserved.definitionRevision,
          capabilityEvidence: authority.capabilityEvidence,
        })
      : this.nonOwnerProvenanceIsCurrent({
          binding: reserved,
          authority,
          capabilityEvidence: authority.capabilityEvidence,
        }) && this.capabilityIsCurrent(reserved, {
          operationClass: "create",
          targetProjectId: reserved.projectId,
          targetHostId: authority.hostId,
          definitionRevision: reserved.definitionRevision,
          capabilityEvidence: authority.capabilityEvidence,
        });
    if (!authorityCurrent || !capabilityCurrent) {
      applyMutation(input.mutate, () => this.repository.fail(
        reserved.id,
        authorityCurrent
          ? "managed_automation_capability_evidence_stale"
          : "managed_automation_authority_stale",
        input.now,
      ));
      throw new Error(authorityCurrent
        ? "managed automation capability evidence is not current"
        : "managed automation authority is not current");
    }
    return reserved;
  }

  private nonOwnerProvenanceIsCurrent(input: Readonly<{
    binding: ManagedAutomationBinding;
    authority: ManagedAutomationAuthority;
    capabilityEvidence: ManagedAutomationCapabilityOperation["capabilityEvidence"];
  }>): boolean {
    const evidence = input.capabilityEvidence;
    if (!evidence) return false;
    const admission = this.provenanceRepository.resolveEvidence(evidence);
    if (!admission || admission.profile.origin !== input.authority.origin ||
      admission.profile.projectId !== input.binding.projectId ||
      admission.profile.hostId !== input.authority.hostId) return false;

    switch (input.authority.origin) {
      case "standing-policy": {
        const policy = this.provenanceRepository.getProjectPolicy(input.binding.projectId);
        return policy !== null && policy.policy.enabled &&
          input.authority.standingAuthority.policyId === projectPolicyAuthorityId(input.binding.projectId) &&
          input.authority.standingAuthority.revision === policy.version &&
          admission.profile.policyId === projectPolicyAuthorityId(input.binding.projectId) &&
          admission.profile.policyRevision === policy.version &&
          admission.profile.subjectKey === `project:${input.binding.projectId}`;
      }
      case "system-maintenance":
        return input.authority.standingAuthority.revision === 1 &&
          admission.profile.policyId === null && admission.profile.policyRevision === null &&
          admission.profile.subjectKey ===
            `system:${input.authority.standingAuthority.systemKey}:${input.binding.projectId}:${input.authority.hostId}`;
      case "automation-triggered": {
        const parent = this.requireAuthoritativeParent(input.authority.taskAuthority.operationId);
        const policy = this.provenanceRepository.getProjectPolicy(input.binding.projectId);
        return policy !== null && policy.policy.enabled &&
          input.authority.standingAuthority.policyId === projectPolicyAuthorityId(input.binding.projectId) &&
          input.authority.standingAuthority.revision === policy.version &&
          input.authority.taskAuthority.automationId === parent.binding.id &&
          input.authority.taskAuthority.revision === parent.operation.definitionRevision &&
          admission.profile.subjectKey === `parent:${parent.operation.id}` &&
          admission.profile.policyId === projectPolicyAuthorityId(input.binding.projectId) &&
          admission.profile.policyRevision === policy.version &&
          admission.profile.parentOperationId === parent.operation.id &&
          admission.profile.parentRunReceiptDigest === managedAutomationDigest(parent.receipt);
      }
    }
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
    if (!isCurrentManagedAutomationAuthority(binding.authority) ||
      !isCurrentManagedAutomationAuthority(operation.authority)) {
      return { allowed: false, errorClass: "managed_automation_authority_stale" };
    }
    if (!managedAutomationAuthorityCoversOperation(operation.authority, operation)) {
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
    if (operation.operationClass !== "reconcile" && operation.authority.origin === "owner" &&
      (!operation.controllerFence || operation.authority.taskAuthority.turnId !== operation.controllerFence.turnId)) {
      return { allowed: false, errorClass: "managed_automation_operation_stale" };
    }
    if (operation.authority.origin !== "owner" && operation.controllerFence !== null) {
      return { allowed: false, errorClass: "managed_automation_operation_stale" };
    }
    if (binding.state === "retired" && operation.operationClass !== "retire") {
      return { allowed: false, errorClass: "managed_automation_binding_retired" };
    }
    if (["create", "update", "enable", "run_now"].includes(operation.operationClass) &&
      binding.mode === "agent" && !agentExecutionContractIsSupported(this.adapter)) {
      return { allowed: false, errorClass: "bb_agent_execution_contract_unsupported" };
    }
    if (!this.authorityIsCurrent(binding)) {
      return { allowed: false, errorClass: "managed_automation_authority_stale" };
    }
    const capabilityCurrent = operation.authority.origin === "owner"
      ? this.capabilityIsCurrent(binding, operation)
      : this.nonOwnerProvenanceIsCurrent({
          binding,
          authority: operation.authority,
          capabilityEvidence: operation.capabilityEvidence,
        });
    if (!capabilityCurrent) {
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
  }): Promise<ManagedAutomationExecutionResult> {
    const admission = this.admitOperation(input.binding, input.operation);
    if (!admission.allowed) throw new Error(admission.errorClass);
    const providerIdentity = existingProviderIdentity(input.binding, input.operation);
    if (!providerIdentity) throw new Error("managed_automation_provider_identity_missing");
    switch (input.operation.operationClass) {
      case "create":
        return this.executeCreateOperation(input, providerIdentity);
      case "update":
        return this.executeUpdateOperation(input, providerIdentity);
      case "enable":
      case "disable":
        return this.executeEnableOperation(input, providerIdentity);
      case "run_now":
        return this.executeRunNowOperation(input, providerIdentity);
      case "retire":
        return this.executeRetireOperation(input, providerIdentity);
      case "reconcile":
        return this.executeReconcileOperation(input, providerIdentity);
    }
  }

  private async executeCreateOperation(
    input: Parameters<ManagedAutomationService["executeClaimedOperation"]>[0],
    providerIdentity: ManagedAutomationProviderIdentity,
  ): Promise<ManagedAutomationExecutionResult> {
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
      return {
        automation: normalizeAndValidateObservation(input.binding, automation, true, providerIdentity),
        run: null,
        runs: [],
      };
    }
    if (input.operation.attempts > 1 && !this.adapter.findByDefinition) {
      throw new Error("managed_automation_reconciliation_unsupported");
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
      this.acknowledgeCreatedAutomation(input, providerIdentity, existing.providerAutomationId);
      return {
        automation: normalizeAndValidateObservation(input.binding, existing, true, providerIdentity),
        run: null,
        runs: [],
      };
    }
    const receipt = await this.adapter.create({
      scope: input.scope,
      definition: input.binding.definition,
      identity: providerIdentity,
      signal: input.signal,
    });
    this.acknowledgeCreatedAutomation(input, providerIdentity, receipt.providerAutomationId, receipt);
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
    return {
      automation: normalizeAndValidateObservation(input.binding, automation, true, providerIdentity),
      run: null,
      runs: [],
    };
  }

  private acknowledgeCreatedAutomation(
    input: Parameters<ManagedAutomationService["executeClaimedOperation"]>[0],
    providerIdentity: ManagedAutomationProviderIdentity,
    providerAutomationId: string,
    receipt?: ManagedAutomationCreateReceipt,
  ): void {
    if (receipt && (receipt.operationId !== providerIdentity.operationId ||
      receipt.ownershipMarker !== providerIdentity.ownershipMarker)) {
      throw new TypeError("managed automation provider acknowledgement identity does not match its binding");
    }
    const acknowledged = this.repository.acknowledgeOperation({
      operationId: input.operation.id,
      ownerId: input.operation.leaseOwner!,
      generation: input.operation.leaseGeneration!,
      now: input.now ?? input.binding.updatedAt,
      receipt: {
        version: 1,
        operationId: providerIdentity.operationId,
        ownershipMarker: providerIdentity.ownershipMarker,
        providerAutomationId,
      },
    });
    if (!acknowledged) throw new ManagedAutomationExecutorFenceLostError();
  }

  private async executeUpdateOperation(
    input: Parameters<ManagedAutomationService["executeClaimedOperation"]>[0],
    providerIdentity: ManagedAutomationProviderIdentity,
  ): Promise<ManagedAutomationExecutionResult> {
    const automationId = requireProviderAutomationId(input);
    if (input.operation.attempts > 1) {
      const observed = normalizeAndValidateObservation(
        input.binding,
        await this.adapter.show({
          scope: input.scope,
          projectId: input.binding.projectId,
          automationId,
          expectedDefinition: input.binding.definition,
          expectedEnabled: desiredEnabled(input.binding),
          identity: providerIdentity,
          signal: input.signal,
        }),
        desiredEnabled(input.binding),
        providerIdentity,
      );
      return { automation: observed, run: null, runs: [] };
    }
    const automation = await this.adapter.update({
      scope: input.scope,
      definition: input.binding.definition,
      automationId,
      expectedEnabled: desiredEnabled(input.binding),
      identity: providerIdentity,
      signal: input.signal,
    });
    return {
      automation: normalizeAndValidateObservation(
        input.binding,
        automation,
        desiredEnabled(input.binding),
        providerIdentity,
      ),
      run: null,
      runs: [],
    };
  }

  private async executeEnableOperation(
    input: Parameters<ManagedAutomationService["executeClaimedOperation"]>[0],
    providerIdentity: ManagedAutomationProviderIdentity,
  ): Promise<ManagedAutomationExecutionResult> {
    const automationId = requireProviderAutomationId(input);
    const enabled = input.operation.operationClass === "enable";
    if (input.operation.attempts > 1) {
      const observed = normalizeAndValidateObservation(
        input.binding,
        await this.adapter.show({
          scope: input.scope,
          projectId: input.binding.projectId,
          automationId,
          expectedDefinition: input.binding.definition,
          expectedEnabled: enabled,
          identity: providerIdentity,
          signal: input.signal,
        }),
        enabled,
        providerIdentity,
      );
      return { automation: observed, run: null, runs: [] };
    }
    const automation = await this.adapter.setEnabled({
      scope: input.scope,
      projectId: input.binding.projectId,
      automationId,
      enabled,
      expectedDefinition: input.binding.definition,
      identity: providerIdentity,
      signal: input.signal,
    });
    return {
      automation: normalizeAndValidateObservation(input.binding, automation, enabled, providerIdentity),
      run: null,
      runs: [],
    };
  }

  private async executeRunNowOperation(
    input: Parameters<ManagedAutomationService["executeClaimedOperation"]>[0],
    providerIdentity: ManagedAutomationProviderIdentity,
  ): Promise<ManagedAutomationExecutionResult> {
    const automationId = requireProviderAutomationId(input);
    let run: ManagedAutomationRun | undefined;
    if (input.operation.attempts > 1) {
      const runs = await this.adapter.runs({
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId,
        limit: 50,
        signal: input.signal,
      });
      run = runs.find((candidate) => candidate.idempotencyKey === input.operation.id);
    }
    if (!run) {
      run = await this.adapter.runNow({
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId,
        idempotencyKey: input.operation.id,
        signal: input.signal,
      });
    }
    if (run.idempotencyKey !== undefined && run.idempotencyKey !== null &&
      run.idempotencyKey !== input.operation.id) {
      throw new TypeError("managed automation provider run identity does not match its operation");
    }
    const identifiedRun = run.idempotencyKey === input.operation.id
      ? run
      : { ...run, idempotencyKey: input.operation.id };
    const automation = await this.adapter.show({
      scope: input.scope,
      projectId: input.binding.projectId,
      automationId,
      expectedDefinition: input.binding.definition,
      expectedEnabled: true,
      identity: providerIdentity,
      signal: input.signal,
    });
    return {
      automation: normalizeAndValidateObservation(input.binding, automation, true, providerIdentity),
      run: identifiedRun,
      runs: [],
    };
  }

  private async executeRetireOperation(
    input: Parameters<ManagedAutomationService["executeClaimedOperation"]>[0],
    providerIdentity: ManagedAutomationProviderIdentity,
  ): Promise<ManagedAutomationExecutionResult> {
    const automationId = input.operation.providerAutomationId ?? input.binding.bbAutomationId;
    if (automationId === null) return { automation: null, run: null, runs: [] };
    if (input.operation.attempts > 1) {
      try {
        const observed = await this.adapter.show({
          scope: input.scope,
          projectId: input.binding.projectId,
          automationId,
          identity: providerIdentity,
          signal: input.signal,
        });
        assertProviderObservationOwnership(input.binding, observed, providerIdentity);
      } catch (error) {
        if (error instanceof BbAutomationNotFoundError) return { automation: null, run: null, runs: [] };
        throw error;
      }
    }
    await deleteAutomationForRetirement(this.adapter, {
      scope: input.scope,
      projectId: input.binding.projectId,
      automationId,
      signal: input.signal,
    });
    return { automation: null, run: null, runs: [] };
  }

  private async executeReconcileOperation(
    input: Parameters<ManagedAutomationService["executeClaimedOperation"]>[0],
    providerIdentity: ManagedAutomationProviderIdentity,
  ): Promise<ManagedAutomationExecutionResult> {
    const automationId = requireProviderAutomationId(input);
    if (input.binding.state === "retiring") {
      if (input.operation.attempts > 1) {
        try {
          const observed = await this.adapter.show({
            scope: input.scope,
            projectId: input.binding.projectId,
            automationId,
            identity: providerIdentity,
            signal: input.signal,
          });
          assertProviderObservationOwnership(input.binding, observed, providerIdentity);
        } catch (error) {
          if (error instanceof BbAutomationNotFoundError) return { automation: null, run: null, runs: [] };
          throw error;
        }
      }
      await deleteAutomationForRetirement(this.adapter, {
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId,
        signal: input.signal,
      });
      return { automation: null, run: null, runs: [] };
    }
    const observed = await this.adapter.show({
      scope: input.scope,
      projectId: input.binding.projectId,
      automationId,
      identity: providerIdentity,
      signal: input.signal,
    });
    assertProviderObservationOwnership(input.binding, observed, providerIdentity);
    let automation = normalizeObservedName(input.binding, observed, providerIdentity);
    if (!observationMatchesDefinition(input.binding, automation, desiredEnabled(input.binding), providerIdentity)) {
      automation = await this.adapter.update({
        scope: input.scope,
        definition: input.binding.definition,
        automationId,
        expectedEnabled: automation.enabled,
        identity: providerIdentity,
        signal: input.signal,
      });
    }
    if (automation.enabled !== desiredEnabled(input.binding)) {
      automation = await this.adapter.setEnabled({
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId,
        enabled: desiredEnabled(input.binding),
        expectedDefinition: input.binding.definition,
        identity: providerIdentity,
        signal: input.signal,
      });
    }
    const runs = await this.adapter.runs({
      scope: input.scope,
      projectId: input.binding.projectId,
      automationId,
      limit: 20,
      signal: input.signal,
    });
    return {
      automation: normalizeAndValidateObservation(input.binding, automation, desiredEnabled(input.binding), providerIdentity),
      run: null,
      runs,
    };
  }

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
  authority?: ManagedAutomationAuthority;
  operation?: ManagedAutomationOperationRequest;
  controllerFence?: ManagedAutomationControllerFence;
  mutate?: ManagedAutomationMutation;
  now: number;
  signal?: AbortSignal;
}): Promise<ManagedAutomationBinding> {
  if (input.monitor.kind !== "schedule" || input.monitor.state !== "armed" || !input.monitor.cron) {
    throw new TypeError("only an armed Hanoon clock schedule can migrate");
  }
  if (!input.authority || !isCurrentManagedAutomationAuthority(input.authority)) {
    throw new Error("legacy Hanoon schedule requires current authority revalidation");
  }
  const operation = input.operation ?? {
    version: 1 as const,
    operationClass: "create" as const,
    targetProjectId: input.projectId,
    ...(input.hostId ? { targetHostId: input.hostId } : {}),
    definitionRevision: 1,
    intentKey: `legacy-monitor:${input.monitor.id}`,
  };
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
    authority: input.authority,
    notificationPolicy: "material",
    legacyMonitorId: input.monitor.id,
    now: input.now,
    mutate: input.mutate,
    operation,
    controllerFence: input.controllerFence,
    signal: input.signal,
  });
  const cancel = () => input.store.cancelMonitor(input.monitor.id, input.now);
  if (!input.mutate) throw new Error("legacy Hanoon schedule migration requires an execution fence");
  if (!input.mutate(cancel)) {
    throw new Error("legacy Hanoon schedule could not be disabled after durable handoff");
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
    store: Pick<TelegramAgentStore, "getOwner" | "getControllerForOwner" | "getProjectPolicy" | "enqueueControllerTurn" | "runExecutorMutation">;
    notify(): void;
    warn?(message: string): void;
    clock?: { now(): number };
  }>) {}

  public async processDue(now: number, signal: AbortSignal | undefined, fence: EffectFence): Promise<boolean> {
    if (!fence) throw new Error("managed automation due processing requires an EffectFence");
    if (fence.signal.aborted || signal?.aborted) return false;
    let didWork = await this.processDurableOperations(now, fence, signal);
    if (!fence.signal.aborted && !signal?.aborted &&
      now - this.lastSweepAt >= AUTOMATION_RECONCILIATION_INTERVAL_MS) {
      this.lastSweepAt = now;
      const operationSignal = AbortSignal.any([fence.signal, ...(signal ? [signal] : [])]);
      didWork = await this.processExistingBindings(
        now,
        operationSignal,
        executorMutation(this.dependencies.store, fence),
      ) || didWork;
      if (!fence.signal.aborted && !signal?.aborted && didWork) {
        didWork = await this.processDurableOperations(now, fence, signal) || didWork;
      }
    }
    return this.enqueuePendingNotifications(
      now,
      didWork,
      executorMutation(this.dependencies.store, fence),
    );
  }

  private async processExistingBindings(
    now: number,
    signal: AbortSignal,
    mutate: ManagedAutomationMutation,
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
          applyMutation(mutate, () => this.dependencies.repository.markPolicyBlocked(binding.id, now));
          didWork = true;
          continue;
        }
        const previousOperation = binding.lastOperationId
          ? this.dependencies.repository.getOperation(binding.lastOperationId)
          : null;
        if (previousOperation && ["pending", "leased"].includes(previousOperation.state)) continue;
        if (binding.state === "retiring" && previousOperation?.operationClass === "retire") continue;
        const submitted = this.dependencies.service.submitReconciliationOperation({
          binding,
          now,
          mutate,
        });
        if (submitted) {
          didWork = true;
        }
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
      if (!this.dependencies.repository.renewOperationLease({
        operationId: operation.id,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: this.dependencies.clock?.now() ?? now,
        leaseMs: AUTOMATION_OPERATION_LEASE_MS,
      })) return;
      const executionResult = await this.dependencies.service.executeClaimedOperation({
        binding,
        operation,
        scope: { kind: "host", hostId, cwd: null },
        now: this.dependencies.clock?.now() ?? now,
        signal: operationSignal,
      });
      if (operationSignal.aborted) return;
      const currentBinding = this.dependencies.repository.get(operation.bindingId);
      const currentOperation = this.dependencies.repository.getOperation(operation.id);
      if (!currentBinding || !currentOperation) return;
      const settlementAdmission = this.dependencies.service.admitOperation(currentBinding, currentOperation);
      if (!settlementAdmission.allowed) {
        this.dependencies.repository.settleOperation({
          operationId: operation.id,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: this.dependencies.clock?.now() ?? now,
          outcome: "ambiguous",
          errorClass: settlementAdmission.errorClass,
        });
        return;
      }
      this.dependencies.repository.settleOperation({
        operationId: operation.id,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: this.dependencies.clock?.now() ?? now,
        outcome: "succeeded",
        automation: executionResult.automation,
        run: executionResult.run,
        runs: executionResult.runs,
      });
    } catch (error) {
      if (operationSignal.aborted) return;
      const currentBinding = this.dependencies.repository.get(operation.bindingId);
      const currentOperation = this.dependencies.repository.getOperation(operation.id);
      if (!currentBinding || !currentOperation) return;
      const settlementAdmission = this.dependencies.service.admitOperation(currentBinding, currentOperation);
      this.dependencies.repository.settleOperation({
        operationId: operation.id,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: this.dependencies.clock?.now() ?? now,
        outcome: "ambiguous",
        errorClass: settlementAdmission.allowed ? automationErrorClass(error) : settlementAdmission.errorClass,
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
  currentControllerKey: string | null,
  projectEnabled: boolean,
): boolean {
  if (!projectEnabled || currentControllerKey !== binding.controllerKey) return false;
  if (!isCurrentManagedAutomationAuthority(binding.authority)) return false;
  return binding.authority.controllerKey === binding.controllerKey &&
    binding.authority.projectId === binding.projectId &&
    binding.authority.hostId.length > 0 &&
    binding.authority.mayWidenAutomation === false;
}
