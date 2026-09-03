import { randomUUID } from "node:crypto";
import {
  BROKER_MAX_CLOCK_SKEW_MS,
  canonicalBrokerJson,
} from "../../src/credentials/protocol.js";
import {
  parseProtectedConnectorRequest,
  parseProtectedConnectorResponse,
  protectedConnectorCapabilityFor,
  type BrowserVercelProjectIdentity,
  type ConvexProjectIdentity,
  type ProtectedConnectorFailureClass,
  type ProtectedConnectorIdentity,
  type ProtectedConnectorRequestEnvelope,
  type ProtectedConnectorResponseEnvelope,
  type VercelProjectIdentity,
} from "../../src/credentials/connector-protocol.js";
import {
  protectedConnectorIdentityMatchesTarget,
  protectedConnectorBindingCanRun,
  type BrowserVercelProjectTarget,
  type ConvexProjectTarget,
  type ProtectedConnectorTarget,
  type VercelProjectTarget,
} from "../../src/credentials/connector-policy.js";
import type { BrokerStore } from "./store.js";
import {
  BrokerProtectedConnectorStore,
  connectorFailureResponse,
  type BrokerConnectorBinding,
} from "./connector-store.js";

export type ProtectedConnectorExecutionFailure = Readonly<{
  outcome: "failed";
  failureClass: Extract<
    ProtectedConnectorFailureClass,
    | "scope_insufficient"
    | "destination_denied"
    | "human_presence_required"
    | "credential_invalid"
    | "credential_expired"
    | "credential_revoked"
    | "provider_rate_limited"
    | "provider_unavailable"
    | "result_ambiguous"
    | "reconciliation_required"
  >;
  retryable: boolean;
  retryAfterMs: number | null;
  connectorVersion: string;
}>;

export type ProtectedConnectorExecutionSuccess<Identity extends ProtectedConnectorIdentity> = Readonly<{
  outcome: "succeeded";
  identity: Identity;
  connectorVersion: string;
}>;

/**
 * The only adapter seam admitted by ticket 67. Implementations receive one
 * already-enrolled typed target; there is no URL, command, JavaScript, or
 * generic request method.
 */
export type ProtectedConnectorExecutor = Readonly<{
  inspectConvex(input: Readonly<{
    target: ConvexProjectTarget;
    credentialReference: string;
    signal?: AbortSignal;
  }>): Promise<ProtectedConnectorExecutionSuccess<ConvexProjectIdentity> | ProtectedConnectorExecutionFailure>;
  inspectVercel(input: Readonly<{
    target: VercelProjectTarget;
    credentialReference: string;
    signal?: AbortSignal;
  }>): Promise<ProtectedConnectorExecutionSuccess<VercelProjectIdentity> | ProtectedConnectorExecutionFailure>;
  inspectBrowserVercel(input: Readonly<{
    target: BrowserVercelProjectTarget;
    signal?: AbortSignal;
  }>): Promise<ProtectedConnectorExecutionSuccess<BrowserVercelProjectIdentity> | ProtectedConnectorExecutionFailure>;
}>;

export type ProtectedConnectorAuthorityPort = Readonly<{
  topologyReady(operation: ProtectedConnectorRequestEnvelope["operation"]): boolean;
  auditWritable(): boolean;
  fenceCurrent(input: Readonly<{
    installationId: string;
    taskId: string;
    projectId: string;
    fenceOwner: string;
    fenceGeneration: number;
  }>): boolean;
}>;

export type ProtectedConnectorAuthorityServiceDependencies = Readonly<{
  foundationStore: BrokerStore;
  connectorStore: BrokerProtectedConnectorStore;
  executor: ProtectedConnectorExecutor;
  authority: ProtectedConnectorAuthorityPort;
  clock: () => number;
}>;

type ConnectorExecution =
  | ProtectedConnectorExecutionSuccess<ProtectedConnectorIdentity>
  | ProtectedConnectorExecutionFailure;

type ConnectorAuthorization =
  | Readonly<{
      outcome: "authorized";
      binding: BrokerConnectorBinding;
      target: ProtectedConnectorTarget;
      credentialReference: string | null;
    }>
  | Readonly<{ outcome: "denied"; response: ProtectedConnectorResponseEnvelope }>;

type ConnectorBindingAuthorization =
  | Readonly<{ outcome: "authorized"; binding: BrokerConnectorBinding }>
  | Extract<ConnectorAuthorization, { outcome: "denied" }>;

function retryableFailure(failureClass: ProtectedConnectorFailureClass): boolean {
  return ["broker_unavailable", "provider_rate_limited", "provider_unavailable"].includes(failureClass);
}

function temporalFailure(request: ProtectedConnectorRequestEnvelope, now: number): boolean {
  return now < request.issuedAt - BROKER_MAX_CLOCK_SKEW_MS || now > request.deadlineAt;
}

function connectorVersionFor(identity: ProtectedConnectorIdentity, fallback: string): string {
  if ("connectorVersion" in identity) return identity.connectorVersion;
  return fallback;
}

function successResponse(
  request: ProtectedConnectorRequestEnvelope,
  identity: ProtectedConnectorIdentity,
  completedAt: number,
): ProtectedConnectorResponseEnvelope {
  return {
    schemaVersion: 2,
    installationId: request.installationId,
    requestId: request.requestId,
    operation: request.operation,
    outcome: "succeeded",
    result: identity,
    failureClass: null,
    retryable: false,
    retryAfterMs: null,
    receiptId: `receipt_${randomUUID()}`,
    completedAt,
  } as ProtectedConnectorResponseEnvelope;
}

function unreceiptedFailure(
  request: ProtectedConnectorRequestEnvelope,
  failureClass: ProtectedConnectorFailureClass,
  completedAt: number,
): ProtectedConnectorResponseEnvelope {
  return connectorFailureResponse({ request, failureClass, receiptId: null, completedAt });
}

export class ProtectedConnectorAuthorityService {
  private readonly foundationStore: BrokerStore;
  private readonly connectorStore: BrokerProtectedConnectorStore;
  private readonly executor: ProtectedConnectorExecutor;
  private readonly authority: ProtectedConnectorAuthorityPort;
  private readonly clock: () => number;

  public constructor(dependencies: ProtectedConnectorAuthorityServiceDependencies) {
    this.foundationStore = dependencies.foundationStore;
    this.connectorStore = dependencies.connectorStore;
    this.executor = dependencies.executor;
    this.authority = dependencies.authority;
    this.clock = dependencies.clock;
    this.connectorStore.reconcileInterruptedRequests(this.clock());
  }

  public async execute(input: Readonly<{
    certificateFingerprint: string;
    request: ProtectedConnectorRequestEnvelope;
    now?: number;
    signal?: AbortSignal;
  }>): Promise<ProtectedConnectorResponseEnvelope> {
    const now = input.now ?? this.clock();
    const parsed = this.parseRequest(input.request);
    if (!parsed.ok) return unreceiptedFailure(input.request, "request_rejected", now);
    const request = parsed.value;
    const initialDenial = this.initialDenial(input.certificateFingerprint, request, now);
    if (initialDenial) return initialDenial;
    const claimedResponse = this.claimedResponse(input.certificateFingerprint, request, now);
    if (claimedResponse) return claimedResponse;
    const authorization = this.authorizeClaimedRequest(request, now);
    if (authorization.outcome === "denied") return authorization.response;
    const execution = await this.executeTarget(authorization, input.signal);
    return this.completeExecution({
      certificateFingerprint: input.certificateFingerprint,
      request,
      authorization,
      execution,
    });
  }

  private initialDenial(
    certificateFingerprint: string,
    request: ProtectedConnectorRequestEnvelope,
    now: number,
  ): ProtectedConnectorResponseEnvelope | null {
    const installation = this.foundationStore.getInstallationByCertificate(certificateFingerprint);
    if (!installation || installation.state !== "active") {
      return unreceiptedFailure(request, "broker_auth_failed", now);
    }
    if (installation.installationId !== request.installationId) {
      return unreceiptedFailure(request, "request_rejected", now);
    }
    const policy = this.connectorStore.getPolicy(request.installationId, request.projectId);
    return !policy || policy.policyDigest !== request.policyDigest || !policy.enabledOperations.includes(request.operation)
      ? unreceiptedFailure(request, "request_rejected", now)
      : null;
  }

  private claimedResponse(
    certificateFingerprint: string,
    request: ProtectedConnectorRequestEnvelope,
    now: number,
  ): ProtectedConnectorResponseEnvelope | null {
    const claim = this.connectorStore.claimRequest({ request, certificateFingerprint, now });
    if (claim.outcome === "completed") return claim.response;
    if (claim.outcome === "ambiguous") return unreceiptedFailure(request, "result_ambiguous", now);
    if (claim.outcome === "digest_mismatch") return unreceiptedFailure(request, "request_rejected", now);
    return null;
  }

  private authorizeClaimedRequest(
    request: ProtectedConnectorRequestEnvelope,
    now: number,
  ): ConnectorAuthorization {
    const authorityDenial = this.claimedAuthorityDenial(request, now);
    if (authorityDenial) return { outcome: "denied", response: authorityDenial };
    const bindingAuthorization = this.authorizeBinding(request, now);
    if (bindingAuthorization.outcome === "denied") return bindingAuthorization;
    return this.resolveBindingTarget(request, bindingAuthorization.binding, now);
  }

  private claimedAuthorityDenial(
    request: ProtectedConnectorRequestEnvelope,
    now: number,
  ): ProtectedConnectorResponseEnvelope | null {
    if (temporalFailure(request, now)) {
      return this.completeFailure({ request, binding: null, failureClass: "request_rejected", completedAt: now });
    }
    if (!this.authority.topologyReady(request.operation)) {
      return this.completeFailure({ request, binding: null, failureClass: "unsafe_topology", completedAt: now });
    }
    if (!this.authority.auditWritable()) {
      return unreceiptedFailure(request, "receipt_persistence_failed", now);
    }
    return this.fenceCurrent(request)
      ? null
      : this.completeFailure({ request, binding: null, failureClass: "request_rejected", completedAt: now });
  }

  private authorizeBinding(
    request: ProtectedConnectorRequestEnvelope,
    now: number,
  ): ConnectorBindingAuthorization {
    const binding = this.connectorStore.getBinding(request.installationId, request.bindingId);
    if (!binding) return {
      outcome: "denied",
      response: this.completeFailure({ request, binding: null, failureClass: "binding_missing", completedAt: now }),
    };
    if (binding.projection.generation !== request.bindingGeneration) {
      return {
        outcome: "denied",
        response: this.completeFailure({ request, binding, failureClass: "binding_generation_stale", completedAt: now }),
      };
    }
    if (
      binding.projection.operation !== request.operation ||
      !binding.projection.capabilityIds.includes(protectedConnectorCapabilityFor(request.operation))
    ) return {
      outcome: "denied",
      response: this.completeFailure({ request, binding, failureClass: "destination_denied", completedAt: now }),
    };
    if (!protectedConnectorBindingCanRun(binding.projection, now)) {
      return {
        outcome: "denied",
        response: this.completeFailure({ request, binding, failureClass: "binding_inactive", completedAt: now }),
      };
    }
    return { outcome: "authorized", binding };
  }

  private resolveBindingTarget(
    request: ProtectedConnectorRequestEnvelope,
    binding: BrokerConnectorBinding,
    now: number,
  ): ConnectorAuthorization {
    try {
      const target = this.connectorStore.resolveTarget(binding);
      if (target.operation !== request.operation) {
        return {
          outcome: "denied",
          response: this.completeFailure({ request, binding, failureClass: "destination_denied", completedAt: now }),
        };
      }
      return {
        outcome: "authorized",
        binding,
        target,
        credentialReference: this.connectorStore.resolveCredentialReference(binding),
      };
    } catch {
      return {
        outcome: "denied",
        response: this.completeFailure({ request, binding, failureClass: "reconciliation_required", completedAt: now }),
      };
    }
  }

  private async executeTarget(
    authorization: Extract<ConnectorAuthorization, { outcome: "authorized" }>,
    signal?: AbortSignal,
  ): Promise<ConnectorExecution> {
    try {
      return await this.dispatch(authorization.target, authorization.credentialReference, signal);
    } catch {
      return {
        outcome: "failed",
        failureClass: "provider_unavailable",
        retryable: true,
        retryAfterMs: 30_000,
        connectorVersion: "connector-1",
      };
    }
  }

  private completeExecution(input: Readonly<{
    certificateFingerprint: string;
    request: ProtectedConnectorRequestEnvelope;
    authorization: Extract<ConnectorAuthorization, { outcome: "authorized" }>;
    execution: ConnectorExecution;
  }>): ProtectedConnectorResponseEnvelope {
    const completedAt = this.clock();
    const { binding, target } = input.authorization;
    if (!this.completionAuthorityCurrent(input.certificateFingerprint, input.request, binding, completedAt)) {
      return this.completeFailure({
        request: input.request,
        binding,
        failureClass: "reconciliation_required",
        completedAt,
      });
    }
    if (!this.authority.auditWritable()) {
      return unreceiptedFailure(input.request, "receipt_persistence_failed", completedAt);
    }
    if (input.execution.outcome === "failed") {
      return this.completeExecutionFailure(input.request, binding, input.execution, completedAt);
    }
    if (!protectedConnectorIdentityMatchesTarget(target, input.execution.identity)) {
      return this.completeFailure({
        request: input.request,
        binding,
        failureClass: "destination_denied",
        completedAt,
        connectorVersion: input.execution.connectorVersion,
      });
    }
    return this.persistSuccess(input.request, binding, input.execution, completedAt);
  }

  private completionAuthorityCurrent(
    certificateFingerprint: string,
    request: ProtectedConnectorRequestEnvelope,
    binding: BrokerConnectorBinding,
    completedAt: number,
  ): boolean {
    return !temporalFailure(request, completedAt) &&
      this.installationStillActive(certificateFingerprint, request.installationId) &&
      this.policyStillCurrent(request) &&
      this.authority.topologyReady(request.operation) &&
      this.fenceCurrent(request) &&
      this.bindingStillCurrent(request, binding, completedAt);
  }

  private completeExecutionFailure(
    request: ProtectedConnectorRequestEnvelope,
    binding: BrokerConnectorBinding,
    execution: ProtectedConnectorExecutionFailure,
    completedAt: number,
  ): ProtectedConnectorResponseEnvelope {
    return this.completeFailure({
      request,
      binding,
      failureClass: execution.failureClass,
      completedAt,
      connectorVersion: execution.connectorVersion,
      retryable: execution.retryable,
      retryAfterMs: execution.retryAfterMs,
    });
  }

  private persistSuccess(
    request: ProtectedConnectorRequestEnvelope,
    binding: BrokerConnectorBinding,
    execution: ProtectedConnectorExecutionSuccess<ProtectedConnectorIdentity>,
    completedAt: number,
  ): ProtectedConnectorResponseEnvelope {
    const response = successResponse(request, execution.identity, completedAt);
    const validated = parseProtectedConnectorResponse(response);
    if (!validated.ok) {
      return this.completeFailure({ request, binding, failureClass: "result_ambiguous", completedAt });
    }
    try {
      return this.connectorStore.completeRequest({
        request,
        response: validated.value,
        targetDigest: binding.targetDigest,
        connectorVersion: connectorVersionFor(execution.identity, execution.connectorVersion),
        now: completedAt,
      });
    } catch {
      return unreceiptedFailure(request, "receipt_persistence_failed", completedAt);
    }
  }

  private parseRequest(request: unknown): ReturnType<typeof parseProtectedConnectorRequest> {
    try {
      return parseProtectedConnectorRequest(request, Buffer.byteLength(canonicalBrokerJson(request), "utf8"));
    } catch {
      return { ok: false, code: "invalid_json_value" };
    }
  }

  private fenceCurrent(request: ProtectedConnectorRequestEnvelope): boolean {
    return this.authority.fenceCurrent({
      installationId: request.installationId,
      taskId: request.taskId,
      projectId: request.projectId,
      fenceOwner: request.fenceOwner,
      fenceGeneration: request.fenceGeneration,
    });
  }

  private policyStillCurrent(request: ProtectedConnectorRequestEnvelope): boolean {
    const policy = this.connectorStore.getPolicy(request.installationId, request.projectId);
    return policy?.policyDigest === request.policyDigest && policy.enabledOperations.includes(request.operation);
  }

  private installationStillActive(certificateFingerprint: string, installationId: string): boolean {
    const installation = this.foundationStore.getInstallationByCertificate(certificateFingerprint);
    return installation?.installationId === installationId && installation.state === "active";
  }

  private bindingStillCurrent(
    request: ProtectedConnectorRequestEnvelope,
    claimed: BrokerConnectorBinding,
    now: number,
  ): boolean {
    const current = this.connectorStore.getBinding(request.installationId, request.bindingId);
    return current !== null &&
      current.projection.generation === request.bindingGeneration &&
      current.projection.operation === request.operation &&
      current.projection.capabilityIds.includes(request.capabilityId) &&
      current.targetDigest === claimed.targetDigest &&
      protectedConnectorBindingCanRun(current.projection, now);
  }

  private async dispatch(
    target: ProtectedConnectorTarget,
    credentialReference: string | null,
    signal?: AbortSignal,
  ): Promise<ProtectedConnectorExecutionSuccess<ProtectedConnectorIdentity> | ProtectedConnectorExecutionFailure> {
    if (target.operation === "convex.project.inspect.v1") {
      if (!credentialReference) return this.missingCredentialFailure();
      return this.executor.inspectConvex({ target, credentialReference, signal });
    }
    if (target.operation === "vercel.project.inspect.v1") {
      if (!credentialReference) return this.missingCredentialFailure();
      return this.executor.inspectVercel({ target, credentialReference, signal });
    }
    if (credentialReference !== null) return this.missingCredentialFailure();
    return this.executor.inspectBrowserVercel({ target, signal });
  }

  private missingCredentialFailure(): ProtectedConnectorExecutionFailure {
    return {
      outcome: "failed",
      failureClass: "reconciliation_required",
      retryable: false,
      retryAfterMs: null,
      connectorVersion: "connector-1",
    };
  }

  private completeFailure(input: Readonly<{
    request: ProtectedConnectorRequestEnvelope;
    binding: BrokerConnectorBinding | null;
    failureClass: ProtectedConnectorFailureClass;
    completedAt: number;
    connectorVersion?: string;
    retryable?: boolean;
    retryAfterMs?: number | null;
  }>): ProtectedConnectorResponseEnvelope {
    const retryable = input.retryable ?? retryableFailure(input.failureClass);
    const retryAfterMs = input.retryAfterMs === undefined ? (retryable ? 30_000 : null) : input.retryAfterMs;
    const response = connectorFailureResponse({
      request: input.request,
      failureClass: input.failureClass,
      retryable,
      retryAfterMs,
      receiptId: `receipt_${randomUUID()}`,
      completedAt: input.completedAt,
    });
    const validated = parseProtectedConnectorResponse(response);
    if (!validated.ok) return unreceiptedFailure(input.request, "result_ambiguous", input.completedAt);
    if (!this.authority.auditWritable()) {
      return unreceiptedFailure(input.request, "receipt_persistence_failed", input.completedAt);
    }
    try {
      return this.connectorStore.completeRequest({
        request: input.request,
        response: validated.value,
        targetDigest: input.binding?.targetDigest ?? null,
        connectorVersion: input.connectorVersion ?? "authority-1",
        now: input.completedAt,
      });
    } catch {
      return unreceiptedFailure(input.request, "receipt_persistence_failed", input.completedAt);
    }
  }
}
