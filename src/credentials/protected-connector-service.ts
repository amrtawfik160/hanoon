import { randomUUID } from "node:crypto";

import type { CredentialBrokerConfigResult } from "./config.js";
import { BROKER_MAX_DEADLINE_MS } from "./protocol.js";
import {
  PROTECTED_CONNECTOR_OPERATIONS,
  PROTECTED_CONNECTOR_SCHEMA_VERSION,
  protectedConnectorCapabilityFor,
  type ProtectedConnectorIdentity,
  type ProtectedConnectorOperation,
  type ProtectedConnectorRequestEnvelope,
  type ProtectedConnectorResponseEnvelope,
} from "./connector-protocol.js";
import {
  finalizeProtectedConnectorEvidence,
  PROTECTED_CONNECTOR_POLICY_DIGEST,
  resolveProtectedConnectorRegistration,
  type ProtectedConnectorAuthoritySnapshot,
  type ProtectedConnectorBindingProjection,
  type ProtectedConnectorDurableReceipt,
  type ProtectedConnectorFinalization,
} from "./connector-policy.js";
import type { ProtectedConnectorCallOutcome } from "./broker-client.js";
import type { AuthorizedControllerCapability } from "../controller/capability-executor.js";
import type {
  ProtectedConnectorCompleteResult,
  ProtectedConnectorOperationRecord,
  ProtectedConnectorReceiptRecord,
} from "../storage/protected-connector-repository.js";
import type { ControllerMutationFence, TelegramAgentStore } from "../storage/store.js";

export type ProtectedConnectorAccessStore = Pick<
  TelegramAgentStore,
  | "getProtectedConnectorBinding"
  | "listProtectedConnectorBindings"
  | "prepareProtectedConnectorOperation"
  | "completeProtectedConnectorOperation"
  | "markProtectedConnectorOperationAmbiguous"
  | "getProtectedConnectorReceipt"
  | "runControllerMutation"
> & Partial<Pick<TelegramAgentStore, "getProtectedConnectorOperation">>;

export type ProtectedConnectorCaller = Readonly<{
  call(
    envelope: ProtectedConnectorRequestEnvelope,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ProtectedConnectorCallOutcome>;
}>;

export type ProtectedConnectorReadiness = Readonly<{
  state: "ready" | "disabled" | "unsafe_topology" | "unavailable";
  operation: ProtectedConnectorOperation;
  projectId: string;
  bindingId: string | null;
  bindingState: ProtectedConnectorBindingProjection["state"] | null;
  reason: string | null;
}>;

export type ProtectedConnectorInspectionResult =
  | Readonly<{ outcome: "denied"; reason: string }>
  | Readonly<{ outcome: "ambiguous"; requestId: string }>
  | Readonly<{ outcome: "failed"; failureClass: string; receiptId: string | null }>
  | Readonly<{
      outcome: "succeeded";
      operation: ProtectedConnectorOperation;
      bindingId: string;
      projectId: string;
      identity: ProtectedConnectorIdentity;
      receiptId: string;
      completedAt: number;
    }>;

export type ProtectedConnectorAccessDependencies = Readonly<{
  store: ProtectedConnectorAccessStore;
  client(): ProtectedConnectorCaller | null;
  config(): CredentialBrokerConfigResult;
  trustKernelReady(): boolean;
  topologyReady(operation: ProtectedConnectorOperation): boolean;
  browserAdministrationIsolated(): boolean;
  auditWritable(): boolean;
  projectPolicyDigest(projectId: string): string | null;
  fullReadiness?(): Promise<Readonly<{ state: "ready" | "disabled" | "unsafe_topology" | "unavailable" }>>;
  now(): number;
}>;

function authorityFor(request: ProtectedConnectorRequestEnvelope): ProtectedConnectorAuthoritySnapshot {
  return {
    installationId: request.installationId,
    taskId: request.taskId,
    projectId: request.projectId,
    capabilityId: request.capabilityId,
    bindingId: request.bindingId,
    bindingGeneration: request.bindingGeneration,
    policyDigest: request.policyDigest,
    fenceOwner: request.fenceOwner,
    fenceGeneration: request.fenceGeneration,
  };
}

function receiptFor(record: ProtectedConnectorReceiptRecord): ProtectedConnectorDurableReceipt {
  return record;
}

function finalResult(
  finalization: ProtectedConnectorFinalization,
  request: ProtectedConnectorRequestEnvelope,
  receipt: ProtectedConnectorReceiptRecord | null,
): ProtectedConnectorInspectionResult {
  if (finalization.outcome !== "succeeded" || !receipt?.identity) {
    return { outcome: "failed", failureClass: finalization.outcome === "incomplete" ? finalization.reason : "result_ambiguous", receiptId: receipt?.receiptId ?? null };
  }
  return {
    outcome: "succeeded",
    operation: request.operation,
    bindingId: request.bindingId,
    projectId: request.projectId,
    identity: receipt.identity,
    receiptId: receipt.receiptId,
    completedAt: receipt.completedAt,
  };
}

function failedResponseResult(
  response: ProtectedConnectorResponseEnvelope,
  completed: ProtectedConnectorCompleteResult,
): ProtectedConnectorInspectionResult {
  if ((completed.outcome === "completed" || completed.outcome === "replay") && completed.receipt) return {
    outcome: "failed",
    failureClass: response.failureClass ?? "provider_unavailable",
    receiptId: completed.receipt.receiptId,
  };
  return { outcome: "failed", failureClass: response.failureClass ?? "receipt_persistence_failed", receiptId: null };
}

export class ProtectedConnectorAccessService {
  public constructor(private readonly deps: ProtectedConnectorAccessDependencies) {}

  public readiness(operation: ProtectedConnectorOperation, projectId: string): ProtectedConnectorReadiness {
    const config = this.deps.config();
    if (config.state !== "isolated") return this.readinessResult(operation, projectId, "disabled", null, "disabled");
    const bindings = this.deps.store.listProtectedConnectorBindings({
      installationId: config.value.installationId,
      operation,
      limit: 2,
    });
    const registration = resolveProtectedConnectorRegistration(operation, {
      installationId: config.value.installationId,
      protocolVersion: PROTECTED_CONNECTOR_SCHEMA_VERSION,
      topologyReady: this.deps.trustKernelReady() && this.deps.topologyReady(operation),
      browserAdministrationIsolated: this.deps.browserAdministrationIsolated(),
      auditWritable: this.deps.auditWritable(),
      projectPolicyDigest: this.deps.projectPolicyDigest(projectId) ?? "",
      currentPolicyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
      bindings,
      now: this.deps.now(),
    });
    if (registration.outcome === "registered") return this.readinessResult(
      operation,
      projectId,
      "ready",
      registration.binding,
      null,
    );
    const state = registration.reason === "unsafe_topology" ? "unsafe_topology" : "unavailable";
    const binding = bindings.length === 1 ? bindings[0] : null;
    return this.readinessResult(operation, projectId, state, binding, registration.reason);
  }

  public async inspect(input: Readonly<{
    operation: ProtectedConnectorOperation;
    projectId: string;
    bindingId: string;
    authorized: AuthorizedControllerCapability;
    signal?: AbortSignal;
  }>): Promise<ProtectedConnectorInspectionResult> {
    const readiness = await this.currentReadiness(input.operation, input.projectId);
    if (readiness.state !== "ready") return { outcome: "denied", reason: readiness.reason ?? readiness.state };
    const config = this.deps.config();
    const client = this.deps.client();
    if (config.state !== "isolated" || !client) return { outcome: "denied", reason: "unavailable" };
    if (input.authorized.turn.origin !== "owner" && input.authorized.controller.projectId !== input.projectId) {
      return { outcome: "denied", reason: "project_scope" };
    }
    const binding = this.deps.store.getProtectedConnectorBinding(config.value.installationId, input.bindingId);
    if (!binding || binding.operation !== input.operation) return { outcome: "denied", reason: "binding_missing" };
    if (readiness.bindingId !== binding.bindingId) return { outcome: "denied", reason: "binding_not_ready" };
    const persisted = this.deps.store.getProtectedConnectorOperation?.({
      installationId: config.value.installationId,
      bindingId: binding.bindingId,
      operation: input.operation,
      bindingGeneration: binding.generation,
      taskId: input.authorized.turn.id,
      projectId: input.projectId,
      fenceOwner: input.authorized.fence.ownerId,
      fenceGeneration: input.authorized.fence.generation,
    });
    const envelope = persisted?.request ?? this.buildRequest(config.value.installationId, input, binding);
    const preparedWrite = this.mutate(input.authorized, (now) => this.deps.store.prepareProtectedConnectorOperation({
      request: envelope,
      capabilityProfileId: input.authorized.turn.capabilityProfileId ?? undefined,
      now,
    }));
    if (preparedWrite.outcome === "stale") return { outcome: "denied", reason: "stale_fence" };
    const prepared = preparedWrite.mutationValue;
    if (prepared.outcome === "binding_missing" || prepared.outcome === "binding_generation_stale" || prepared.outcome === "binding_inactive") {
      return { outcome: "denied", reason: prepared.outcome };
    }
    if (prepared.outcome === "digest_mismatch") return { outcome: "denied", reason: "request_digest_mismatch" };
    if (!("operation" in prepared)) return { outcome: "failed", failureClass: "reconciliation_required", receiptId: null };
    if (prepared.outcome === "completed") return replayInspection(this.deps, config.value.installationId, prepared.operation, input.operation, input.projectId);
    const toSend = prepared.operation.request;
    const callOutcome = await client.call(toSend, { signal: input.signal });
    if (callOutcome.outcome !== "succeeded") {
      this.markAmbiguous(input.authorized, config.value.installationId, toSend.requestId);
      return { outcome: "ambiguous", requestId: toSend.requestId };
    }
    const response = callOutcome.response;
    if (response.schemaVersion !== 2) {
      this.markAmbiguous(input.authorized, config.value.installationId, toSend.requestId);
      return { outcome: "failed", failureClass: "invalid_response", receiptId: null };
    }
    const postReadiness = await this.currentReadiness(input.operation, input.projectId);
    if (postReadiness.state !== "ready" || postReadiness.bindingId !== toSend.bindingId) {
      this.markAmbiguous(input.authorized, config.value.installationId, toSend.requestId);
      return { outcome: "denied", reason: postReadiness.reason ?? "authority_changed" };
    }
    const completedWrite = this.mutate(input.authorized, (now) => this.deps.store.completeProtectedConnectorOperation({
      installationId: config.value.installationId,
      requestId: toSend.requestId,
      response,
      currentAuthority: authorityFor(toSend),
      now,
    }));
    if (completedWrite.outcome === "stale") return { outcome: "denied", reason: "stale_fence" };
    const completed = completedWrite.mutationValue;
    if (completed.outcome === "not_found" || completed.outcome === "identity_mismatch") {
      return { outcome: "failed", failureClass: "reconciliation_required", receiptId: null };
    }
    if (response.outcome === "failed") return failedResponseResult(response, completed);
    if (completed.outcome !== "completed" && completed.outcome !== "replay") {
      return { outcome: "failed", failureClass: "reconciliation_required", receiptId: null };
    }
    const receipt = completed.receipt;
    const finalization = finalizeProtectedConnectorEvidence({
      request: toSend,
      response,
      receipt: receipt ? receiptFor(receipt) : null,
      binding: this.deps.store.getProtectedConnectorBinding(config.value.installationId, toSend.bindingId) ?? binding,
      currentPolicyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
      currentAuthority: authorityFor(toSend),
      now: this.deps.now(),
    });
    return finalResult(finalization, toSend, receipt);
  }

  private async currentReadiness(
    operation: ProtectedConnectorOperation,
    projectId: string,
  ): Promise<ProtectedConnectorReadiness> {
    const local = this.readiness(operation, projectId);
    if (!this.deps.fullReadiness) return local;
    const full = await this.deps.fullReadiness();
    if (full.state === "ready") return local;
    return this.readinessResult(operation, projectId, full.state, null, full.state);
  }

  private readinessResult(
    operation: ProtectedConnectorOperation,
    projectId: string,
    state: ProtectedConnectorReadiness["state"],
    binding: ProtectedConnectorBindingProjection | null,
    reason: string | null,
  ): ProtectedConnectorReadiness {
    return {
      state,
      operation,
      projectId,
      bindingId: binding?.bindingId ?? null,
      bindingState: binding?.state ?? null,
      reason,
    };
  }

  private buildRequest(
    installationId: string,
    input: Readonly<{ operation: ProtectedConnectorOperation; projectId: string; authorized: AuthorizedControllerCapability }>,
    binding: ProtectedConnectorBindingProjection,
  ): ProtectedConnectorRequestEnvelope {
    const issuedAt = input.authorized.turn.submittedAt ?? input.authorized.fence.now;
    return {
      schemaVersion: 2,
      operation: input.operation,
      installationId,
      requestId: `req_${randomUUID()}`,
      idempotencyKey: `idem_${randomUUID()}`,
      nonce: `nonce_${randomUUID()}`,
      bindingId: binding.bindingId,
      bindingGeneration: binding.generation,
      taskId: input.authorized.turn.id,
      projectId: input.projectId,
      capabilityId: protectedConnectorCapabilityFor(input.operation),
      policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
      fenceOwner: input.authorized.fence.ownerId,
      fenceGeneration: input.authorized.fence.generation,
      issuedAt,
      deadlineAt: issuedAt + BROKER_MAX_DEADLINE_MS,
    } as ProtectedConnectorRequestEnvelope;
  }

  private mutate<T>(authorized: AuthorizedControllerCapability, mutation: (now: number) => T) {
    if (authorized.controller.threadId === null) return { outcome: "stale" as const };
    const fence: ControllerMutationFence = {
      ...authorized.fence,
      now: this.deps.now(),
      turnId: authorized.turn.id,
      controllerKey: authorized.controller.controllerKey,
      expectedThreadId: authorized.controller.threadId,
    };
    return this.deps.store.runControllerMutation(fence, mutation);
  }

  private markAmbiguous(authorized: AuthorizedControllerCapability, installationId: string, requestId: string): void {
    this.mutate(authorized, (now) => this.deps.store.markProtectedConnectorOperationAmbiguous({ installationId, requestId, now }));
  }
}

function replayInspection(
  deps: ProtectedConnectorAccessDependencies,
  installationId: string,
  operation: ProtectedConnectorOperationRecord,
  connectorOperation: ProtectedConnectorOperation,
  projectId: string,
): ProtectedConnectorInspectionResult {
  if (!operation.receiptId) return { outcome: "ambiguous", requestId: operation.request.requestId };
  const receipt = deps.store.getProtectedConnectorReceipt(installationId, operation.receiptId);
  if (!receipt) return { outcome: "failed", failureClass: "reconciliation_required", receiptId: null };
  if (receipt.outcome !== "succeeded" || !receipt.identity) {
    return { outcome: "failed", failureClass: receipt.failureClass ?? "provider_unavailable", receiptId: receipt.receiptId };
  }
  return {
    outcome: "succeeded",
    operation: connectorOperation,
    bindingId: operation.request.bindingId,
    projectId,
    identity: receipt.identity,
    receiptId: receipt.receiptId,
    completedAt: receipt.completedAt,
  };
}

export function isProtectedConnectorOperation(value: string): value is ProtectedConnectorOperation {
  return PROTECTED_CONNECTOR_OPERATIONS.includes(value as ProtectedConnectorOperation);
}

export type { ProtectedConnectorCallOutcome };
