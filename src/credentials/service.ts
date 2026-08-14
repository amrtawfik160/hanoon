/**
 * Orchestrates the three read-only Hanoon-side credential access capabilities
 * (list, status, verify) against a secret-free store and an injectable
 * broker-call port. The isolated settings it reads for routing (installation
 * id, topology receipt digest/expiry) pass through the same config object
 * that also carries the client certificate/key for the broker client's own
 * use; this module never reads or forwards those PEM fields, and no result
 * type it defines has a field for one. It does not itself enforce the
 * trust-kernel manifest's per-tool byte bounds — its result shapes are simply
 * small enough to fit them; the capability executor is what enforces the
 * bound at the tool boundary.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  BROKER_MAX_DEADLINE_MS,
  BROKER_SCHEMA_VERSION,
  FOUNDATION_BROKER_POLICY_DIGEST,
  type BrokerAdapterState,
  type BrokerBindingState,
  type BrokerFailureClass,
  type BrokerHealthSnapshot,
  type BrokerRequestEnvelope,
  type CredentialBindingMetadata,
} from "./protocol";
import type { CredentialBrokerConfigResult } from "./config";
import type { CredentialBrokerCallOutcome } from "./broker-client";
import {
  evaluateCredentialFullReadiness,
  evaluateCredentialStaticReadiness,
  type CredentialReadinessSnapshot,
} from "./topology";
import type {
  CredentialHealthRecord,
  CredentialReceiptRecord,
} from "../storage/credential-access-repository";
import type { TelegramAgentStore } from "../storage/store";
import type { AuthorizedControllerCapability } from "../controller/capability-executor";

export type CredentialAccessStore = Pick<
  TelegramAgentStore,
  | "reconcileCredentialHealth"
  | "listCredentialBindings"
  | "getCredentialBinding"
  | "prepareCredentialDiagnosticOperation"
  | "completeCredentialDiagnosticOperation"
  | "prepareCredentialVerificationOperation"
  | "completeCredentialVerificationOperation"
  | "markCredentialOperationAmbiguous"
  | "getCredentialReceipt"
  | "getCredentialHealth"
>;

/** The narrow slice of `CredentialBrokerClient` this service actually calls. */
export type CredentialBrokerCaller = Readonly<{
  call(
    envelope: BrokerRequestEnvelope,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<CredentialBrokerCallOutcome>;
}>;

export type CredentialAccessServiceDependencies = Readonly<{
  store: CredentialAccessStore;
  /** The caller must pass null whenever credential mode is not isolated; this service never dispatches to it in that state. */
  client: CredentialBrokerCaller | null;
  config(): CredentialBrokerConfigResult;
  trustKernelReady(): boolean;
  controllerPermissionMode(): string;
  now(): number;
}>;

export type CredentialAccessListInput = Readonly<{
  state?: BrokerBindingState;
  afterBindingId?: string;
  limit: number;
}>;

export type CredentialAccessListResult = Readonly<{
  available: boolean;
  bindings: readonly CredentialBindingMetadata[];
  truncated: boolean;
}>;

export type CredentialAccessHealthProjection = Readonly<{
  brokerVersion: string;
  adapterState: BrokerAdapterState;
  auditWritable: boolean;
  bindingCount: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureClass: BrokerFailureClass | null;
}>;

export type CredentialAccessStatusResult = Readonly<{
  readiness: CredentialReadinessSnapshot;
  health: CredentialAccessHealthProjection | null;
  binding: CredentialBindingMetadata | null;
}>;

export type CredentialAccessDenialReason =
  | "not_owner_origin"
  | "disabled"
  | "unsafe_topology"
  | "unavailable"
  | "unknown_binding"
  | "stale_fence";

export type CredentialAccessVerifyResult =
  | Readonly<{ outcome: "denied"; reason: CredentialAccessDenialReason }>
  | Readonly<{ outcome: "ambiguous" }>
  | Readonly<{ outcome: "failed"; failureClass: BrokerFailureClass | "local_error" }>
  | Readonly<{
      outcome: "verified";
      bindingId: string;
      generation: number;
      state: BrokerBindingState;
      result: "valid" | "invalid";
      failureClass: "credential_invalid" | null;
      receiptId: string;
      completedAt: number;
    }>;

type VerifyOutcomeFacts = Readonly<{
  result: "valid" | "invalid" | null;
  failureClass: BrokerFailureClass | null;
  receiptId: string | null;
  completedAt: number;
}>;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A verification envelope is reconstructed from stable turn/binding identity
 * rather than minted fresh per call, so a second attempt for the exact same
 * logical operation reproduces the same request id, idempotency key, and
 * nonce byte-for-byte. That is what lets the repository's digest comparison
 * recognize a replay instead of rejecting it as a conflicting key reuse.
 */
function deterministicId(prefix: string, parts: readonly (string | number)[]): string {
  return `${prefix}${sha256Hex(parts.map(String).join("\u0000"))}`;
}

/** A verification receipt's `result` is never `"ready"` — that value belongs only to health receipts. */
function verifyReceiptResult(result: "ready" | "valid" | "invalid" | null): "valid" | "invalid" | null {
  return result === "valid" || result === "invalid" ? result : null;
}

function toHealthSnapshot(record: CredentialHealthRecord): BrokerHealthSnapshot {
  return Object.freeze({
    protocolVersion: BROKER_SCHEMA_VERSION,
    brokerVersion: record.brokerVersion,
    adapter: record.adapter,
    adapterState: record.adapterState,
    auditWritable: record.auditWritable,
    bindingCount: record.bindingCount,
    topologyReceiptDigest: record.topologyReceiptDigest,
    topologyReceiptExpiresAt: record.topologyReceiptExpiresAt,
  });
}

function boundedHealthProjection(record: CredentialHealthRecord): CredentialAccessHealthProjection {
  return Object.freeze({
    brokerVersion: record.brokerVersion,
    adapterState: record.adapterState,
    auditWritable: record.auditWritable,
    bindingCount: record.bindingCount,
    lastSuccessAt: record.lastSuccessAt,
    lastFailureAt: record.lastFailureAt,
    lastFailureClass: record.lastFailureClass,
  });
}

export class CredentialAccessService {
  public constructor(private readonly deps: CredentialAccessServiceDependencies) {}

  /** Local projections only: never dispatches to the broker. */
  public list(input: CredentialAccessListInput): CredentialAccessListResult {
    const config = this.deps.config();
    if (config.state !== "isolated") return { available: false, bindings: [], truncated: false };
    const page = this.deps.store.listCredentialBindings({
      installationId: config.value.installationId,
      state: input.state,
      afterBindingId: input.afterBindingId,
      limit: input.limit + 1,
    });
    const truncated = page.length > input.limit;
    return { available: true, bindings: Object.freeze(page.slice(0, input.limit)), truncated };
  }

  /**
   * Runs an allowed diagnostic `broker.health` (when isolated configuration
   * is present, even before topology evidence matches), reconciles the
   * complete secret-free snapshot, and reports bounded readiness plus at
   * most one selected binding. Never resolves a credential.
   */
  public async status(input: Readonly<{ bindingId?: string }>): Promise<CredentialAccessStatusResult> {
    const config = this.deps.config();
    const trustKernelReady = this.deps.trustKernelReady();
    const controllerPermissionMode = this.deps.controllerPermissionMode();
    const now = this.deps.now();

    if (config.state !== "isolated") {
      return {
        readiness: evaluateCredentialStaticReadiness({ trustKernelReady, controllerPermissionMode, config, now }),
        health: null,
        binding: null,
      };
    }

    const installationId = config.value.installationId;
    await this.refreshDiagnosticHealth(installationId);
    const healthRecord = this.deps.store.getCredentialHealth(installationId);
    const readiness = evaluateCredentialFullReadiness({
      trustKernelReady,
      controllerPermissionMode,
      config,
      now,
      health: healthRecord ? toHealthSnapshot(healthRecord) : null,
      healthResponseInstallationId: healthRecord?.installationId ?? null,
    });
    const binding = input.bindingId ? this.deps.store.getCredentialBinding(installationId, input.bindingId) : null;
    return { readiness, health: healthRecord ? boundedHealthProjection(healthRecord) : null, binding };
  }

  /**
   * Requests one live `vault.binding.verify`. Denies before any broker
   * dispatch unless the turn is an explicit owner request, the binding is
   * known locally, and full readiness (including `controllerPermissionMode
   * === "auto"`) holds. A pass can only move the binding to `vault_verified`
   * or `degraded`; it never sets `active`.
   */
  public async verify(
    input: Readonly<{ bindingId: string; authorized: AuthorizedControllerCapability }>,
  ): Promise<CredentialAccessVerifyResult> {
    if (input.authorized.turn.origin !== "owner") return { outcome: "denied", reason: "not_owner_origin" };

    const config = this.deps.config();
    const trustKernelReady = this.deps.trustKernelReady();
    const controllerPermissionMode = this.deps.controllerPermissionMode();
    const now = this.deps.now();
    const installationId = config.state === "isolated" ? config.value.installationId : null;
    const lastHealth = installationId ? this.deps.store.getCredentialHealth(installationId) : null;
    const preReadiness = evaluateCredentialFullReadiness({
      trustKernelReady,
      controllerPermissionMode,
      config,
      now,
      health: lastHealth ? toHealthSnapshot(lastHealth) : null,
      healthResponseInstallationId: lastHealth?.installationId ?? null,
    });
    if (preReadiness.state !== "ready" || !installationId || !this.deps.client) {
      return { outcome: "denied", reason: preReadiness.state === "ready" ? "unavailable" : preReadiness.state };
    }

    const binding = this.deps.store.getCredentialBinding(installationId, input.bindingId);
    if (!binding) return { outcome: "denied", reason: "unknown_binding" };

    const envelope = this.buildVerifyEnvelope(installationId, binding, input.authorized);
    const prepared = this.deps.store.prepareCredentialVerificationOperation({
      ownerId: input.authorized.fence.ownerId,
      generation: input.authorized.fence.generation,
      now,
      installationId,
      turnId: input.authorized.turn.id,
      envelope,
    });
    if (prepared.outcome === "stale") return { outcome: "denied", reason: "stale_fence" };
    if (prepared.outcome === "digest_mismatch") return { outcome: "failed", failureClass: "local_error" };
    if (prepared.outcome === "completed") {
      const receipt = prepared.operation.receiptId
        ? this.deps.store.getCredentialReceipt(installationId, prepared.operation.receiptId)
        : null;
      return this.finalizeVerifyResult(installationId, binding, receipt
        ? {
            result: verifyReceiptResult(receipt.result),
            failureClass: receipt.failureClass,
            receiptId: receipt.receiptId,
            completedAt: receipt.completedAt,
          }
        : { result: null, failureClass: null, receiptId: null, completedAt: prepared.operation.updatedAt });
    }

    // "prepared" (first attempt) or "ambiguous" (recovering an unresolved
    // earlier attempt) both dispatch the same reconstructed envelope once.
    const callOutcome = await this.deps.client.call(envelope);
    if (callOutcome.outcome === "ambiguous") {
      this.deps.store.markCredentialOperationAmbiguous({ installationId, requestId: envelope.requestId, now: this.deps.now() });
      return { outcome: "ambiguous" };
    }
    if (callOutcome.outcome === "failed") {
      this.deps.store.markCredentialOperationAmbiguous({ installationId, requestId: envelope.requestId, now: this.deps.now() });
      return { outcome: "failed", failureClass: "local_error" };
    }

    // Reject a response that arrives after the world turned unsafe while we
    // were waiting on the network, even though the broker already answered.
    const staticRecheck = evaluateCredentialStaticReadiness({
      trustKernelReady: this.deps.trustKernelReady(),
      controllerPermissionMode: this.deps.controllerPermissionMode(),
      config,
      now: this.deps.now(),
    });
    if (staticRecheck.state !== "ready") {
      this.deps.store.markCredentialOperationAmbiguous({ installationId, requestId: envelope.requestId, now: this.deps.now() });
      return { outcome: "denied", reason: staticRecheck.state };
    }

    const completed = this.deps.store.completeCredentialVerificationOperation({
      ownerId: input.authorized.fence.ownerId,
      generation: input.authorized.fence.generation,
      now: this.deps.now(),
      installationId,
      turnId: input.authorized.turn.id,
      requestId: envelope.requestId,
      response: callOutcome.response,
    });
    if (completed.outcome === "stale") return { outcome: "denied", reason: "stale_fence" };
    if (completed.outcome === "identity_mismatch" || completed.outcome === "not_found") {
      return { outcome: "failed", failureClass: "local_error" };
    }
    const response = callOutcome.response;
    const facts: VerifyOutcomeFacts = completed.receipt
      ? {
          result: verifyReceiptResult(completed.receipt.result),
          failureClass: completed.receipt.failureClass,
          receiptId: completed.receipt.receiptId,
          completedAt: completed.receipt.completedAt,
        }
      : {
          result: response.result === "valid" || response.result === "invalid" ? response.result : null,
          failureClass: response.failureClass,
          receiptId: null,
          completedAt: response.completedAt,
        };
    return this.finalizeVerifyResult(installationId, binding, facts);
  }

  private async refreshDiagnosticHealth(installationId: string): Promise<void> {
    if (!this.deps.client) return;
    const now = this.deps.now();
    const fresh = this.buildHealthEnvelope(installationId, now);
    const prepared = this.deps.store.prepareCredentialDiagnosticOperation({ installationId, envelope: fresh, now });
    if (prepared.outcome === "digest_mismatch" || prepared.outcome === "completed") return;
    // A still-outstanding earlier attempt must be reconciled by resending its
    // exact stored envelope; only a genuinely fresh state creates a new one.
    const toSend = prepared.outcome === "reconcile_required" ? prepared.operation.envelope : fresh;
    const callOutcome = await this.deps.client.call(toSend);
    if (callOutcome.outcome === "succeeded") {
      this.deps.store.completeCredentialDiagnosticOperation({
        installationId, requestId: toSend.requestId, response: callOutcome.response, now: this.deps.now(),
      });
      return;
    }
    this.deps.store.markCredentialOperationAmbiguous({ installationId, requestId: toSend.requestId, now: this.deps.now() });
  }

  private buildHealthEnvelope(installationId: string, now: number): BrokerRequestEnvelope {
    return Object.freeze({
      schemaVersion: BROKER_SCHEMA_VERSION,
      installationId,
      requestId: `req_${randomUUID()}`,
      idempotencyKey: `idem_${randomUUID()}`,
      operation: "broker.health",
      bindingId: null,
      bindingGeneration: null,
      turnId: null,
      capabilityId: "system.broker.health",
      policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
      fenceOwner: null,
      fenceGeneration: null,
      issuedAt: now,
      deadlineAt: now + BROKER_MAX_DEADLINE_MS,
      nonce: `nonce_${randomUUID()}`,
    }) as BrokerRequestEnvelope;
  }

  private buildVerifyEnvelope(
    installationId: string,
    binding: CredentialBindingMetadata,
    authorized: AuthorizedControllerCapability,
  ): BrokerRequestEnvelope {
    const keyParts = [
      installationId,
      authorized.turn.id,
      binding.bindingId,
      binding.generation,
      authorized.fence.ownerId,
      authorized.fence.generation,
    ];
    const issuedAt = authorized.turn.submittedAt ?? authorized.fence.now;
    return Object.freeze({
      schemaVersion: BROKER_SCHEMA_VERSION,
      installationId,
      requestId: deterministicId("vreq_", keyParts),
      idempotencyKey: deterministicId("videm_", keyParts),
      operation: "vault.binding.verify",
      bindingId: binding.bindingId,
      bindingGeneration: binding.generation,
      turnId: authorized.turn.id,
      capabilityId: "telegram_agent_access_verify",
      policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
      fenceOwner: authorized.fence.ownerId,
      fenceGeneration: authorized.fence.generation,
      issuedAt,
      deadlineAt: issuedAt + BROKER_MAX_DEADLINE_MS,
      nonce: deterministicId("vnonce_", keyParts),
    }) as BrokerRequestEnvelope;
  }

  private finalizeVerifyResult(
    installationId: string,
    binding: CredentialBindingMetadata,
    facts: VerifyOutcomeFacts,
  ): CredentialAccessVerifyResult {
    if (facts.failureClass === "result_ambiguous") return { outcome: "ambiguous" };
    if (!facts.receiptId) return { outcome: "failed", failureClass: facts.failureClass ?? "local_error" };
    if (facts.result === "valid" || facts.result === "invalid") {
      const current = this.deps.store.getCredentialBinding(installationId, binding.bindingId) ?? binding;
      return {
        outcome: "verified",
        bindingId: current.bindingId,
        generation: current.generation,
        state: current.state,
        result: facts.result,
        failureClass: facts.result === "invalid" ? "credential_invalid" : null,
        receiptId: facts.receiptId,
        completedAt: facts.completedAt,
      };
    }
    return { outcome: "failed", failureClass: facts.failureClass ?? "local_error" };
  }
}
