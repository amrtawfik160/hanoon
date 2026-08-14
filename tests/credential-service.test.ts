import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import {
  FOUNDATION_BROKER_POLICY_DIGEST,
  type BrokerHealthSnapshot,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
  type CredentialBindingMetadata,
} from "../src/credentials/protocol";
import type { CredentialBrokerConfigResult } from "../src/credentials/config";
import type { CredentialBrokerCallOutcome } from "../src/credentials/broker-client";
import {
  CredentialAccessService,
  type CredentialAccessServiceDependencies,
  type CredentialBrokerCaller,
} from "../src/credentials/service";
import { openStore } from "../src/storage/store";
import type { AuthorizedControllerCapability } from "../src/controller/capability-executor";

const INSTALLATION_ID = "install_1";
const TOPOLOGY_DIGEST = "a".repeat(64);
const TOPOLOGY_EXPIRES_AT = 999_999_999;

let fixtureNumber = 0;

function disabledConfig(): CredentialBrokerConfigResult {
  return { state: "disabled" };
}

function isolatedConfig(): CredentialBrokerConfigResult {
  return {
    state: "isolated",
    value: {
      mode: "isolated",
      endpointOrigin: "https://broker.example",
      installationId: INSTALLATION_ID,
      topologyReceiptDigest: TOPOLOGY_DIGEST,
      topologyReceiptExpiresAt: TOPOLOGY_EXPIRES_AT,
      clientCertificatePem: "cert",
      clientKeyPem: "key",
      caCertificatePem: "ca",
    },
  };
}

function healthSnapshot(overrides: Partial<BrokerHealthSnapshot> = {}): BrokerHealthSnapshot {
  return Object.freeze({
    protocolVersion: 1,
    brokerVersion: "0.1.0",
    adapter: "onepassword",
    adapterState: "ready",
    auditWritable: true,
    bindingCount: 1,
    topologyReceiptDigest: TOPOLOGY_DIGEST,
    topologyReceiptExpiresAt: TOPOLOGY_EXPIRES_AT,
    ...overrides,
  }) as BrokerHealthSnapshot;
}

function bindingMetadata(overrides: Partial<CredentialBindingMetadata> = {}): CredentialBindingMetadata {
  return Object.freeze({
    bindingId: "binding_1",
    label: "Primary vault item",
    provider: "onepassword",
    state: "pending",
    generation: 1,
    capabilityIds: [],
    risk: "low",
    mfaMode: "none",
    approvalMode: "none",
    lastVerifiedAt: null,
    ...overrides,
  }) as CredentialBindingMetadata;
}

function healthResponse(
  envelope: BrokerRequestEnvelope,
  overrides: Partial<BrokerResponseEnvelope> = {},
  bindings: readonly CredentialBindingMetadata[] = [bindingMetadata()],
): BrokerResponseEnvelope {
  return Object.freeze({
    schemaVersion: 1,
    installationId: envelope.installationId,
    requestId: envelope.requestId,
    operation: "broker.health",
    outcome: "succeeded",
    result: "ready",
    failureClass: null,
    retryable: false,
    retryAfterMs: null,
    receiptId: `receipt_${envelope.requestId}`,
    health: healthSnapshot({ bindingCount: bindings.length }),
    bindings,
    completedAt: 5_000,
    ...overrides,
  }) as BrokerResponseEnvelope;
}

function verifyResponse(
  envelope: BrokerRequestEnvelope,
  overrides: Partial<BrokerResponseEnvelope> = {},
): BrokerResponseEnvelope {
  return Object.freeze({
    schemaVersion: 1,
    installationId: envelope.installationId,
    requestId: envelope.requestId,
    operation: "vault.binding.verify",
    outcome: "succeeded",
    result: "valid",
    failureClass: null,
    retryable: false,
    retryAfterMs: null,
    receiptId: `receipt_${envelope.requestId}`,
    health: null,
    bindings: [],
    completedAt: 5_000,
    ...overrides,
  }) as BrokerResponseEnvelope;
}

/** A controllable fake of the mTLS broker client's `.call` surface. */
function fakeClient(): CredentialBrokerCaller & { call: ReturnType<typeof vi.fn> } {
  return { call: vi.fn() };
}

function serviceFixture(options: Readonly<{ origin?: "owner" | "system" }> = {}) {
  fixtureNumber += 1;
  const { bb } = createFakePluginHost({ pluginId: `telegram-credential-service-${fixtureNumber}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret(`pair-credential-service-${fixtureNumber}`), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret(`pair-credential-service-${fixtureNumber}`), "7", "7", 1_001))
    .toEqual({ ok: true });

  const threadId = `thr_credential_service_${fixtureNumber}`;
  const queued = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 30_000 + fixtureNumber,
    inputText: "Verify my credential binding.",
    now: 2_000,
    origin: options.origin,
  });
  const lease = store.acquireExecutorLease("executor", 2_000, 30_000);
  if (!lease.acquired) throw new Error("executor lease was not acquired");
  let fence = { ownerId: "executor", generation: lease.generation, now: 2_000 };
  expect(store.claimNextControllerTurn(fence)?.id).toBe(queued.id);
  expect(store.markControllerSpawned({
    ...fence, turnId: queued.id, projectId: "proj_1", hostId: "host_1", threadId,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, turnId: queued.id })).toBe(true);

  function authorized(): AuthorizedControllerCapability {
    const controller = store.getControllerByThreadId(threadId);
    const turn = store.getPendingControllerTurn("owner-7-controller");
    if (!controller || !turn) throw new Error("fixture controller/turn missing");
    return { controller, turn, fence };
  }

  /**
   * Bumps the executor lease generation so the fixture's captured fence goes
   * stale. `acquireExecutorLease` only reassigns an unexpired lease once its
   * `lease_expires_at` has passed, so this steals it well after the original
   * 30-second lease (acquired at now=2_000) has expired.
   */
  function invalidateFence(): void {
    const stolen = store.acquireExecutorLease("executor-2", 40_000, 30_000);
    if (!stolen.acquired) throw new Error("could not steal the executor lease");
  }

  const client = fakeClient();
  let trustKernelReady = true;
  let controllerPermissionMode = "auto";
  let now = 2_000;

  const deps: CredentialAccessServiceDependencies = {
    store,
    client,
    config: () => config,
    trustKernelReady: () => trustKernelReady,
    controllerPermissionMode: () => controllerPermissionMode,
    now: () => now,
  };
  let config: CredentialBrokerConfigResult = disabledConfig();
  const service = new CredentialAccessService(deps);

  return {
    store, client, service, authorized, invalidateFence,
    setConfig: (next: CredentialBrokerConfigResult) => { config = next; },
    setTrustKernelReady: (value: boolean) => { trustKernelReady = value; },
    setControllerPermissionMode: (value: string) => { controllerPermissionMode = value; },
    setNow: (value: number) => { now = value; },
  };
}

function seedReconciledBinding(
  store: ReturnType<typeof serviceFixture>["store"],
  overrides: Partial<CredentialBindingMetadata> = {},
): void {
  const binding = bindingMetadata(overrides);
  const result = store.reconcileCredentialHealth({
    installationId: INSTALLATION_ID,
    health: healthSnapshot({ bindingCount: 1 }),
    bindings: [binding],
    responseSha256: "e".repeat(64),
    now: 2_000,
  });
  expect(result.outcome).toBe("reconciled");
}

describe("CredentialAccessService.list", () => {
  it("reports unavailable without touching the store when credential mode is disabled", () => {
    const fixture = serviceFixture();
    fixture.setConfig(disabledConfig());
    const result = fixture.service.list({ limit: 10 });
    expect(result).toEqual({ available: false, bindings: [], truncated: false });
    expect(fixture.client.call).not.toHaveBeenCalled();
  });

  it("lists local bounded, filtered, and paginated bindings without dispatching to the broker", () => {
    const fixture = serviceFixture();
    fixture.setConfig(isolatedConfig());
    seedReconciledBinding(fixture.store, { bindingId: "binding_1", state: "pending" });
    seedReconciledBinding(fixture.store, { bindingId: "binding_2", state: "vault_verified" });

    const result = fixture.service.list({ limit: 10 });
    expect(result.available).toBe(true);
    expect(result.bindings.map((binding) => binding.bindingId)).toEqual(["binding_1", "binding_2"]);
    expect(result.truncated).toBe(false);
    expect(fixture.client.call).not.toHaveBeenCalled();

    const filtered = fixture.service.list({ state: "vault_verified", limit: 10 });
    expect(filtered.bindings.map((binding) => binding.bindingId)).toEqual(["binding_2"]);

    const firstPage = fixture.service.list({ limit: 1 });
    expect(firstPage.bindings.map((binding) => binding.bindingId)).toEqual(["binding_1"]);
    expect(firstPage.truncated).toBe(true);

    const secondPage = fixture.service.list({ afterBindingId: "binding_1", limit: 1 });
    expect(secondPage.bindings.map((binding) => binding.bindingId)).toEqual(["binding_2"]);
    expect(secondPage.truncated).toBe(false);
  });
});

describe("CredentialAccessService.status", () => {
  it("reports disabled readiness without dispatching when credential mode is off", async () => {
    const fixture = serviceFixture();
    fixture.setConfig(disabledConfig());
    const result = await fixture.service.status({});
    expect(result).toEqual({ readiness: { state: "disabled", checks: [] }, health: null, binding: null });
    expect(fixture.client.call).not.toHaveBeenCalled();
  });

  it("runs a diagnostic health check, reconciles it, and reports ready readiness", async () => {
    const fixture = serviceFixture();
    fixture.setConfig(isolatedConfig());
    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: healthResponse(envelope),
    } satisfies CredentialBrokerCallOutcome));

    const result = await fixture.service.status({});

    expect(fixture.client.call).toHaveBeenCalledTimes(1);
    const [sentEnvelope] = fixture.client.call.mock.calls[0] as [BrokerRequestEnvelope];
    expect(sentEnvelope.operation).toBe("broker.health");
    expect(sentEnvelope.capabilityId).toBe("system.broker.health");
    expect(sentEnvelope.policyDigest).toBe(FOUNDATION_BROKER_POLICY_DIGEST);
    expect(result.readiness.state).toBe("ready");
    expect(result.health).toMatchObject({ adapterState: "ready", auditWritable: true, bindingCount: 1 });
    expect(fixture.store.getCredentialHealth(INSTALLATION_ID)).not.toBeNull();
  });

  it("reconciles an outstanding diagnostic request by resending its exact envelope before creating a new one", async () => {
    const fixture = serviceFixture();
    fixture.setConfig(isolatedConfig());
    const staleEnvelope: BrokerRequestEnvelope = Object.freeze({
      schemaVersion: 1,
      installationId: INSTALLATION_ID,
      requestId: "req_stale",
      idempotencyKey: "idem_stale",
      operation: "broker.health",
      bindingId: null,
      bindingGeneration: null,
      turnId: null,
      capabilityId: "system.broker.health",
      policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
      fenceOwner: null,
      fenceGeneration: null,
      issuedAt: 1_000,
      deadlineAt: 11_000,
      nonce: "nonce_stale",
    }) as BrokerRequestEnvelope;
    const prepared = fixture.store.prepareCredentialDiagnosticOperation({
      installationId: INSTALLATION_ID, envelope: staleEnvelope, now: 1_000,
    });
    expect(prepared.outcome).toBe("prepared");

    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: healthResponse(envelope),
    } satisfies CredentialBrokerCallOutcome));

    await fixture.service.status({});

    expect(fixture.client.call).toHaveBeenCalledTimes(1);
    const [sentEnvelope] = fixture.client.call.mock.calls[0] as [BrokerRequestEnvelope];
    expect(sentEnvelope.requestId).toBe("req_stale");
    expect(sentEnvelope.idempotencyKey).toBe("idem_stale");
  });

  it("reports one exact selected binding by id", async () => {
    const fixture = serviceFixture();
    fixture.setConfig(isolatedConfig());
    // The live health reconciliation is the authoritative source for
    // binding metadata, so the fake broker — not a local pre-seed — is what
    // determines the label a fresh status() call reports.
    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: healthResponse(envelope, {}, [bindingMetadata({ bindingId: "binding_1", label: "Ops vault item" })]),
    } satisfies CredentialBrokerCallOutcome));

    const result = await fixture.service.status({ bindingId: "binding_1" });
    expect(result.binding).toMatchObject({ bindingId: "binding_1", label: "Ops vault item" });
  });

  it("reports no binding for an unknown binding id rather than throwing", async () => {
    const fixture = serviceFixture();
    fixture.setConfig(isolatedConfig());
    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: healthResponse(envelope, {}, []),
    } satisfies CredentialBrokerCallOutcome));

    const result = await fixture.service.status({ bindingId: "does_not_exist" });
    expect(result.binding).toBeNull();
  });

  it("marks the operation ambiguous and keeps prior health on a client failure", async () => {
    const fixture = serviceFixture();
    fixture.setConfig(isolatedConfig());
    fixture.client.call.mockResolvedValue({ outcome: "ambiguous" } satisfies CredentialBrokerCallOutcome);

    const result = await fixture.service.status({});
    expect(result.readiness.state).toBe("unavailable");
    expect(fixture.store.getCredentialHealth(INSTALLATION_ID)).toBeNull();
  });
});

describe("CredentialAccessService.verify", () => {
  function readyFixture() {
    const fixture = serviceFixture();
    fixture.setConfig(isolatedConfig());
    seedReconciledBinding(fixture.store, { bindingId: "binding_1", state: "pending", generation: 1 });
    return fixture;
  }

  it("denies before any broker dispatch for a non-owner-originated turn", async () => {
    const fixture = serviceFixture({ origin: "system" });
    fixture.setConfig(isolatedConfig());
    seedReconciledBinding(fixture.store, { bindingId: "binding_1" });

    const result = await fixture.service.verify({ bindingId: "binding_1", authorized: fixture.authorized() });

    expect(result).toEqual({ outcome: "denied", reason: "not_owner_origin" });
    expect(fixture.client.call).not.toHaveBeenCalled();
  });

  it("denies before any broker dispatch under unsafe topology", async () => {
    const fixture = readyFixture();
    fixture.setTrustKernelReady(false);

    const result = await fixture.service.verify({ bindingId: "binding_1", authorized: fixture.authorized() });

    expect(result).toEqual({ outcome: "denied", reason: "unsafe_topology" });
    expect(fixture.client.call).not.toHaveBeenCalled();
  });

  it("denies before any broker dispatch when the controller permission mode is not auto", async () => {
    const fixture = readyFixture();
    fixture.setControllerPermissionMode("full");

    const result = await fixture.service.verify({ bindingId: "binding_1", authorized: fixture.authorized() });

    expect(result).toEqual({ outcome: "denied", reason: "unsafe_topology" });
    expect(fixture.client.call).not.toHaveBeenCalled();
  });

  it("denies an unknown binding id without dispatching to the broker", async () => {
    const fixture = readyFixture();

    const result = await fixture.service.verify({ bindingId: "does_not_exist", authorized: fixture.authorized() });

    expect(result).toEqual({ outcome: "denied", reason: "unknown_binding" });
    expect(fixture.client.call).not.toHaveBeenCalled();
  });

  it("denies a stale fence before dispatching to the broker", async () => {
    const fixture = readyFixture();
    const authorized = fixture.authorized();
    fixture.invalidateFence();

    const result = await fixture.service.verify({ bindingId: "binding_1", authorized });

    expect(result).toEqual({ outcome: "denied", reason: "stale_fence" });
    expect(fixture.client.call).not.toHaveBeenCalled();
  });

  it("moves a pending binding to vault_verified on a valid resolve", async () => {
    const fixture = readyFixture();
    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: verifyResponse(envelope, { result: "valid" }),
    } satisfies CredentialBrokerCallOutcome));

    const result = await fixture.service.verify({ bindingId: "binding_1", authorized: fixture.authorized() });

    expect(result).toMatchObject({ outcome: "verified", result: "valid", state: "vault_verified", generation: 1 });
    expect(fixture.store.getCredentialBinding(INSTALLATION_ID, "binding_1")).toMatchObject({ state: "vault_verified" });
  });

  it("demotes an already vault_verified binding to degraded on a deterministic invalid resolve", async () => {
    const fixture = serviceFixture();
    fixture.setConfig(isolatedConfig());
    seedReconciledBinding(fixture.store, { bindingId: "binding_1", state: "vault_verified", generation: 1 });
    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: verifyResponse(envelope, {
        outcome: "failed", result: "invalid", failureClass: "credential_invalid",
      }),
    } satisfies CredentialBrokerCallOutcome));

    const result = await fixture.service.verify({ bindingId: "binding_1", authorized: fixture.authorized() });

    expect(result).toMatchObject({ outcome: "verified", result: "invalid", failureClass: "credential_invalid", state: "degraded" });
    expect(fixture.store.getCredentialBinding(INSTALLATION_ID, "binding_1")).toMatchObject({ state: "degraded" });
  });

  it("reports a receipt-less local failure as a typed reason, never a fabricated success", async () => {
    const fixture = readyFixture();
    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: verifyResponse(envelope, {
        outcome: "failed", result: null, failureClass: "receipt_persistence_failed", receiptId: null,
      }),
    } satisfies CredentialBrokerCallOutcome));

    const result = await fixture.service.verify({ bindingId: "binding_1", authorized: fixture.authorized() });

    expect(result).toEqual({ outcome: "failed", failureClass: "receipt_persistence_failed" });
    expect(fixture.store.getCredentialBinding(INSTALLATION_ID, "binding_1")).toMatchObject({ state: "pending" });
  });

  it("treats a response identity mismatch as a local failure without accepting the result", async () => {
    const fixture = readyFixture();
    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: verifyResponse({ ...envelope, requestId: "req_someone_else" } as BrokerRequestEnvelope),
    } satisfies CredentialBrokerCallOutcome));

    const result = await fixture.service.verify({ bindingId: "binding_1", authorized: fixture.authorized() });

    expect(result).toEqual({ outcome: "failed", failureClass: "local_error" });
  });

  it("marks a timeout ambiguous locally without claiming success", async () => {
    const fixture = readyFixture();
    fixture.client.call.mockResolvedValue({ outcome: "ambiguous" } satisfies CredentialBrokerCallOutcome);

    const result = await fixture.service.verify({ bindingId: "binding_1", authorized: fixture.authorized() });

    expect(result).toEqual({ outcome: "ambiguous" });
    expect(fixture.store.getCredentialBinding(INSTALLATION_ID, "binding_1")).toMatchObject({ state: "pending" });
  });

  it("replays the identical prepared envelope after a local timeout and completes it on retry", async () => {
    const fixture = readyFixture();
    const authorized = fixture.authorized();
    fixture.client.call.mockResolvedValueOnce({ outcome: "ambiguous" } satisfies CredentialBrokerCallOutcome);

    const first = await fixture.service.verify({ bindingId: "binding_1", authorized });
    expect(first).toEqual({ outcome: "ambiguous" });

    fixture.client.call.mockImplementationOnce(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: verifyResponse(envelope, { result: "valid" }),
    } satisfies CredentialBrokerCallOutcome));

    const second = await fixture.service.verify({ bindingId: "binding_1", authorized });

    expect(second).toMatchObject({ outcome: "verified", result: "valid" });
    expect(fixture.client.call).toHaveBeenCalledTimes(2);
    const [firstEnvelope] = fixture.client.call.mock.calls[0] as [BrokerRequestEnvelope];
    const [secondEnvelope] = fixture.client.call.mock.calls[1] as [BrokerRequestEnvelope];
    expect(secondEnvelope).toEqual(firstEnvelope);
  });

  it("replays a completed verification without dispatching to the broker again", async () => {
    const fixture = readyFixture();
    const authorized = fixture.authorized();
    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: verifyResponse(envelope, { result: "valid" }),
    } satisfies CredentialBrokerCallOutcome));

    const first = await fixture.service.verify({ bindingId: "binding_1", authorized });
    const second = await fixture.service.verify({ bindingId: "binding_1", authorized });

    expect(first).toMatchObject({ outcome: "verified", result: "valid" });
    expect(second).toEqual(first);
    expect(fixture.client.call).toHaveBeenCalledTimes(1);
  });

  it("refuses to accept a broker success once the world has gone unsafe while the call was in flight", async () => {
    const fixture = readyFixture();
    const authorized = fixture.authorized();
    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => {
      // Readiness flips mid-flight, after the pre-dispatch check already passed.
      fixture.setTrustKernelReady(false);
      return { outcome: "succeeded", response: verifyResponse(envelope, { result: "valid" }) } satisfies CredentialBrokerCallOutcome;
    });

    const result = await fixture.service.verify({ bindingId: "binding_1", authorized });

    expect(result).toEqual({ outcome: "denied", reason: "unsafe_topology" });
    expect(fixture.store.getCredentialBinding(INSTALLATION_ID, "binding_1")).toMatchObject({ state: "pending" });
  });

  it("changing the target binding generation between attempts is treated as a different logical operation", async () => {
    // Envelope identity is derived from (turn, binding, generation): a
    // regenerated binding must not silently replay the previous generation's
    // outstanding or completed operation.
    const fixture = readyFixture();
    const authorized = fixture.authorized();
    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: verifyResponse(envelope, { result: "valid" }),
    } satisfies CredentialBrokerCallOutcome));

    await fixture.service.verify({ bindingId: "binding_1", authorized });
    expect(fixture.client.call).toHaveBeenCalledTimes(1);

    // Revoke-and-reenroll bumps the generation on the same binding id.
    seedReconciledBinding(fixture.store, { bindingId: "binding_1", state: "pending", generation: 2 });
    await fixture.service.verify({ bindingId: "binding_1", authorized });

    expect(fixture.client.call).toHaveBeenCalledTimes(2);
    const [firstEnvelope] = fixture.client.call.mock.calls[0] as [BrokerRequestEnvelope];
    const [secondEnvelope] = fixture.client.call.mock.calls[1] as [BrokerRequestEnvelope];
    expect(secondEnvelope.requestId).not.toBe(firstEnvelope.requestId);
    expect(secondEnvelope.bindingGeneration).toBe(2);
  });
});
