import {
  BROKER_MAX_CLOCK_SKEW_MS,
  BROKER_MAX_DEADLINE_MS,
  BROKER_MAX_REQUEST_BYTES,
  FOUNDATION_BROKER_POLICY_DIGEST,
  OPAQUE_ID_PATTERN,
  brokerRequestDigest,
  canonicalBrokerJson,
  parseBrokerRequest,
  parseBrokerResponse,
  type BrokerFailureClass,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
} from "../../src/credentials/protocol.js";
import { type BrokerInstallation, type BrokerStore, type BrokerRequestClaimInput } from "./store.js";
import { type VaultAdapter, type VaultVerification } from "./onepassword-adapter.js";

type BrokerOperationServiceDependencies = Readonly<{
  store: BrokerStore;
  adapter: VaultAdapter;
  dataKey: Uint8Array;
  auditKey: Uint8Array;
  clock: () => number;
  brokerVersion: string;
}>;

type CompletionValues = Readonly<{
  result: BrokerResponseEnvelope["result"];
  failureClass: BrokerFailureClass | null;
  retryable: boolean;
  retryAfterMs: number | null;
  versionHmac?: string | null;
}>;

function responseFor(
  request: Partial<BrokerRequestEnvelope> | null | undefined,
  values: Readonly<{
    outcome: BrokerResponseEnvelope["outcome"];
    result: BrokerResponseEnvelope["result"];
    failureClass: BrokerFailureClass | null;
    retryable: boolean;
    retryAfterMs: number | null;
    receiptId: string | null;
    health?: BrokerResponseEnvelope["health"];
    bindings?: BrokerResponseEnvelope["bindings"];
    completedAt: number;
  }>,
): BrokerResponseEnvelope {
  const requestObject = request && typeof request === "object" ? request : {};
  const installationId = typeof requestObject.installationId === "string" && OPAQUE_ID_PATTERN.test(requestObject.installationId)
    ? requestObject.installationId
    : "unknown-installation";
  const requestId = typeof requestObject.requestId === "string" && OPAQUE_ID_PATTERN.test(requestObject.requestId)
    ? requestObject.requestId
    : "unknown-request";
  return {
    schemaVersion: 1,
    installationId,
    requestId,
    operation: requestObject.operation === "vault.binding.verify" ? "vault.binding.verify" : "broker.health",
    outcome: values.outcome,
    result: values.result,
    failureClass: values.failureClass,
    retryable: values.retryable,
    retryAfterMs: values.retryAfterMs,
    receiptId: values.receiptId,
    health: values.health ?? null,
    bindings: values.bindings ?? [],
    completedAt: values.completedAt,
  };
}

function bareFailure(
  request: Partial<BrokerRequestEnvelope>,
  failureClass: BrokerFailureClass,
  completedAt: number,
): BrokerResponseEnvelope {
  return responseFor(request, {
    outcome: "failed",
    result: null,
    failureClass,
    retryable: false,
    retryAfterMs: null,
    receiptId: null,
    completedAt,
  });
}

function providerFailure(
  request: BrokerRequestEnvelope,
  verification: Exclude<VaultVerification, { outcome: "valid" | "invalid" }>,
  completedAt: number,
): BrokerResponseEnvelope {
  return responseFor(request, {
    outcome: "failed",
    result: null,
    failureClass: verification.failureClass,
    retryable: verification.retryable,
    retryAfterMs: verification.retryAfterMs,
    receiptId: null,
    completedAt,
  });
}

function requestClaimInput(
  request: BrokerRequestEnvelope,
  certificateFingerprint: string,
  now: number,
): BrokerRequestClaimInput {
  return {
    installationId: request.installationId,
    certificateFingerprint,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    nonce: request.nonce,
    requestDigest: brokerRequestDigest(request),
    operation: request.operation,
    bindingId: request.bindingId,
    bindingGeneration: request.bindingGeneration,
    turnId: request.turnId,
    capabilityId: request.capabilityId,
    policyDigest: request.policyDigest,
    fenceOwner: request.fenceOwner,
    fenceGeneration: request.fenceGeneration,
    issuedAt: request.issuedAt,
    deadlineAt: request.deadlineAt,
    now,
  };
}

function responseFromAdapter(
  request: BrokerRequestEnvelope,
  verification: VaultVerification,
  completedAt: number,
): { response: BrokerResponseEnvelope; completion: CompletionValues } {
  if (verification.outcome === "valid") {
    const completion = { result: "valid", failureClass: null, retryable: false, retryAfterMs: null, versionHmac: verification.versionHmac } as const;
    return {
      completion,
      response: responseFor(request, { ...completion, outcome: "succeeded", receiptId: null, completedAt }),
    };
  }
  if (verification.outcome === "invalid") {
    const completion = { result: "invalid", failureClass: "credential_invalid", retryable: false, retryAfterMs: null, versionHmac: null } as const;
    return {
      completion,
      response: responseFor(request, { ...completion, outcome: "failed", receiptId: null, completedAt }),
    };
  }
  const completion = {
    result: null,
    failureClass: verification.failureClass,
    retryable: verification.retryable,
    retryAfterMs: verification.retryAfterMs,
    versionHmac: null,
  } as const;
  return {
    completion,
    response: responseFor(request, { ...completion, outcome: "failed", receiptId: null, completedAt }),
  };
}

function temporalFailure(request: BrokerRequestEnvelope, now: number): boolean {
  return now < request.issuedAt - BROKER_MAX_CLOCK_SKEW_MS || now > request.deadlineAt ||
    request.deadlineAt <= request.issuedAt || request.deadlineAt - request.issuedAt > BROKER_MAX_DEADLINE_MS;
}

function hasValidOperationPair(request: BrokerRequestEnvelope): boolean {
  return (request.operation === "broker.health" && request.capabilityId === "system.broker.health") ||
    (request.operation === "vault.binding.verify" && request.capabilityId === "telegram_agent_access_verify");
}

export class BrokerOperationService {
  private readonly store: BrokerStore;
  private readonly adapter: VaultAdapter;
  private readonly dataKey: Uint8Array;
  private readonly auditKey: Uint8Array;
  private readonly clock: () => number;
  private readonly brokerVersion: string;

  constructor(dependencies: BrokerOperationServiceDependencies) {
    this.store = dependencies.store;
    this.adapter = dependencies.adapter;
    this.dataKey = Uint8Array.from(dependencies.dataKey);
    this.auditKey = Uint8Array.from(dependencies.auditKey);
    this.clock = dependencies.clock;
    this.brokerVersion = dependencies.brokerVersion;
    this.store.reconcileInterruptedRequests(this.clock());
  }

  async execute(input: {
    certificateFingerprint: string;
    now: number;
    request: BrokerRequestEnvelope;
  }): Promise<BrokerResponseEnvelope> {
    const parsed = this.parseRequest(input.request);
    if (!parsed.ok) return this.validated(bareFailure(input.request, "request_rejected", input.now));
    const request = parsed.value;

    const installation = this.store.getInstallationByCertificate(input.certificateFingerprint);
    if (!installation || installation.state !== "active") {
      return this.validated(bareFailure(request, "broker_auth_failed", input.now));
    }
    if (request.installationId !== installation.installationId) {
      return this.validated(bareFailure(request, "request_rejected", input.now));
    }
    if (request.policyDigest !== FOUNDATION_BROKER_POLICY_DIGEST || request.policyDigest !== installation.policyDigest) {
      return this.validated(bareFailure(request, "request_rejected", input.now));
    }

    const claim = requestClaimInput(request, input.certificateFingerprint, input.now);
    const claimed = this.store.claimRequest(claim);
    if (claimed.outcome === "completed") return this.validated(claimed.response);
    if (claimed.outcome === "ambiguous") return this.validated(bareFailure(request, "result_ambiguous", input.now));
    if (claimed.outcome === "digest_mismatch") return this.validated(bareFailure(request, "request_rejected", input.now));
    if (temporalFailure(request, input.now) || !hasValidOperationPair(request)) {
      return this.completeRejection(claim, request, input.now);
    }

    if (request.operation === "broker.health") return this.executeHealth(claim, request, installation, input.now);
    return this.executeVerification(claim, request, input.now);
  }

  private parseRequest(request: unknown): ReturnType<typeof parseBrokerRequest> {
    try {
      if (Buffer.byteLength(canonicalBrokerJson(request), "utf8") > BROKER_MAX_REQUEST_BYTES) {
        return { ok: false, code: "limit_exceeded" };
      }
      return parseBrokerRequest(request);
    } catch {
      return { ok: false, code: "invalid_json_value" };
    }
  }

  private async executeHealth(
    claim: BrokerRequestClaimInput,
    request: BrokerRequestEnvelope,
    installation: BrokerInstallation,
    completedAt: number,
  ): Promise<BrokerResponseEnvelope> {
    try {
      const expectedVaultId = this.store.decryptExpectedVaultId(installation.installationId, this.dataKey);
      const health = await this.adapter.health(expectedVaultId);
      if (health.outcome === "ready") {
        const bindings = this.store.listBindingMetadata(installation.installationId);
        const response = responseFor(request, {
          outcome: "succeeded",
          result: "ready",
          failureClass: null,
          retryable: false,
          retryAfterMs: null,
          receiptId: null,
          health: {
            protocolVersion: 1,
            brokerVersion: this.brokerVersion,
            adapter: "onepassword",
            adapterState: "ready",
            auditWritable: true,
            bindingCount: bindings.length,
            topologyReceiptDigest: installation.topologyReceiptDigest,
            topologyReceiptExpiresAt: installation.topologyReceiptExpiresAt,
          },
          bindings,
          completedAt,
        });
        return this.complete(claim, response, { result: "ready", failureClass: null, retryable: false, retryAfterMs: null }, completedAt);
      }
      const response = providerFailure(request, health, completedAt);
      return this.complete(claim, response, {
        result: null,
        failureClass: health.failureClass,
        retryable: health.retryable,
        retryAfterMs: health.retryAfterMs,
      }, completedAt);
    } catch {
      const response = bareFailure(request, "provider_unavailable", completedAt);
      return this.complete(claim, response, { result: null, failureClass: "provider_unavailable", retryable: true, retryAfterMs: 30_000 }, completedAt);
    }
  }

  private async executeVerification(
    claim: BrokerRequestClaimInput,
    request: BrokerRequestEnvelope,
    completedAt: number,
  ): Promise<BrokerResponseEnvelope> {
    const binding = request.bindingId ? this.store.getBinding(request.installationId, request.bindingId) : null;
    if (!binding) return this.completeRejection(claim, request, completedAt, "binding_missing");
    if (["revoked", "compromised"].includes(binding.state)) {
      return this.completeRejection(claim, request, completedAt, "binding_inactive");
    }
    if (binding.generation !== request.bindingGeneration) {
      return this.completeRejection(claim, request, completedAt, "binding_generation_stale");
    }

    try {
      const expectedVaultId = this.store.decryptExpectedVaultId(request.installationId, this.dataKey);
      const reference = this.store.decryptBindingReference(binding, this.dataKey);
      const verification = await this.adapter.verify({ reference, expectedVaultId, auditHmacKey: this.auditKey });
      const mapped = responseFromAdapter(request, verification, completedAt);
      return this.complete(claim, mapped.response, mapped.completion, completedAt);
    } catch {
      const response = bareFailure(request, "provider_unavailable", completedAt);
      return this.complete(claim, response, { result: null, failureClass: "provider_unavailable", retryable: true, retryAfterMs: 30_000 }, completedAt);
    }
  }

  private completeRejection(
    claim: BrokerRequestClaimInput,
    request: BrokerRequestEnvelope,
    completedAt: number,
    failureClass: BrokerFailureClass = "request_rejected",
  ): BrokerResponseEnvelope {
    const response = bareFailure(request, failureClass, completedAt);
    return this.complete(claim, response, { result: null, failureClass, retryable: false, retryAfterMs: null }, completedAt);
  }

  private complete(
    claim: BrokerRequestClaimInput,
    response: BrokerResponseEnvelope,
    completion: CompletionValues,
    completedAt: number,
  ): BrokerResponseEnvelope {
    try {
      return this.validated(this.store.completeRequest({
        ...claim,
        response,
        result: completion.result,
        failureClass: completion.failureClass,
        retryable: completion.retryable,
        retryAfterMs: completion.retryAfterMs,
        versionHmac: completion.versionHmac ?? null,
        adapterVersion: this.brokerVersion,
        now: completedAt,
      }));
    } catch {
      return this.validated(bareFailure(response, "receipt_persistence_failed", completedAt));
    }
  }

  private validated(response: BrokerResponseEnvelope): BrokerResponseEnvelope {
    const parsed = parseBrokerResponse(response);
    if (!parsed.ok) throw new Error("broker_response_invalid");
    return parsed.value;
  }
}

export type { BrokerOperationServiceDependencies };
