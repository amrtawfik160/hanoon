import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import {
  BROKER_MAX_BINDINGS,
  FOUNDATION_BROKER_POLICY_DIGEST,
  type BrokerHealthSnapshot,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
  type CredentialBindingMetadata,
} from "../src/credentials/protocol";
import { CredentialAccessRepository } from "../src/storage/credential-access-repository";
import { openStore } from "../src/storage/store";

let fixtureNumber = 0;

function credentialFixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-credential-repository-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair-credential"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-credential"), "7", "7", 1_001)).toEqual({ ok: true });

  const queued = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 20_000 + fixtureNumber,
    inputText: "Check credential access.",
    now: 2_000,
  });
  const lease = store.acquireExecutorLease("executor", 2_000, 30_000);
  if (!lease.acquired) throw new Error("executor lease was not acquired");
  const fence = { ownerId: "executor", generation: lease.generation, now: 2_000 };
  expect(store.claimNextControllerTurn(fence)?.id).toBe(queued.id);
  expect(store.markControllerSpawned({
    ...fence,
    turnId: queued.id,
    projectId: "proj_1",
    hostId: "host_1",
    threadId: `thr_credential_${fixtureNumber}`,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, turnId: queued.id })).toBe(true);

  const db = bb.storage.database();
  const repository = new CredentialAccessRepository(db);
  return { bb, store, db, repository, turnId: queued.id, fence };
}

function healthEnvelope(overrides: Partial<BrokerRequestEnvelope> = {}): BrokerRequestEnvelope {
  return Object.freeze({
    schemaVersion: 1,
    installationId: "install_1",
    requestId: `req_${overrides.requestId ?? "health-1"}`,
    idempotencyKey: `idem_${overrides.idempotencyKey ?? "health-1"}`,
    operation: "broker.health",
    bindingId: null,
    bindingGeneration: null,
    turnId: null,
    capabilityId: "system.broker.health",
    policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
    fenceOwner: null,
    fenceGeneration: null,
    issuedAt: 2_000,
    deadlineAt: 12_000,
    nonce: `nonce_${overrides.nonce ?? "health-1"}`,
    ...overrides,
  }) as BrokerRequestEnvelope;
}

function verifyEnvelope(
  fence: { ownerId: string; generation: number },
  turnId: string,
  overrides: Partial<BrokerRequestEnvelope> = {},
): BrokerRequestEnvelope {
  return Object.freeze({
    schemaVersion: 1,
    installationId: "install_1",
    requestId: `req_${overrides.requestId ?? "verify-1"}`,
    idempotencyKey: `idem_${overrides.idempotencyKey ?? "verify-1"}`,
    operation: "vault.binding.verify",
    bindingId: "binding_1",
    bindingGeneration: 1,
    turnId,
    capabilityId: "telegram_agent_access_verify",
    policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
    fenceOwner: fence.ownerId,
    fenceGeneration: fence.generation,
    issuedAt: 2_000,
    deadlineAt: 12_000,
    nonce: `nonce_${overrides.nonce ?? "verify-1"}`,
    ...overrides,
  }) as BrokerRequestEnvelope;
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

function healthSnapshot(overrides: Partial<BrokerHealthSnapshot> = {}): BrokerHealthSnapshot {
  return Object.freeze({
    protocolVersion: 1,
    brokerVersion: "0.1.0",
    adapter: "onepassword",
    adapterState: "ready",
    auditWritable: true,
    bindingCount: 1,
    topologyReceiptDigest: "a".repeat(64),
    topologyReceiptExpiresAt: 999_999_999,
    ...overrides,
  }) as BrokerHealthSnapshot;
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

function responseSha256(response: BrokerResponseEnvelope): string {
  return createHash("sha256").update(JSON.stringify(response)).digest("hex");
}

// --- health reconciliation ---------------------------------------------

it("reconciles a complete health snapshot into local binding and health projections", () => {
  const { repository } = credentialFixture();

  const result = repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot(),
    bindings: [bindingMetadata()],
    responseSha256: "f".repeat(64),
    now: 3_000,
  });

  expect(result.outcome).toBe("reconciled");
  expect(repository.getCredentialHealth("install_1")).toMatchObject({
    installationId: "install_1",
    adapterState: "ready",
    bindingCount: 1,
  });
  expect(repository.getCredentialBinding("install_1", "binding_1")).toMatchObject({
    bindingId: "binding_1",
    state: "pending",
    generation: 1,
  });
});

it("rejects a health reconciliation carrying more than the bounded binding count", () => {
  const { repository } = credentialFixture();
  const bindings = Array.from({ length: BROKER_MAX_BINDINGS + 1 }, (_, index) =>
    bindingMetadata({ bindingId: `binding_${index}` }));

  const result = repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot({ bindingCount: bindings.length }),
    bindings,
    responseSha256: "f".repeat(64),
    now: 3_000,
  });

  expect(result.outcome).toBe("limit_exceeded");
  expect(repository.getCredentialHealth("install_1")).toBeNull();
});

it("rejects a reconciliation that downgrades a binding's generation and leaves prior state untouched", () => {
  const { repository } = credentialFixture();
  repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot(),
    bindings: [bindingMetadata({ generation: 3 })],
    responseSha256: "1".repeat(64),
    now: 3_000,
  });

  const result = repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot(),
    bindings: [bindingMetadata({ generation: 2 })],
    responseSha256: "2".repeat(64),
    now: 4_000,
  });

  expect(result.outcome).toBe("generation_downgrade");
  expect(repository.getCredentialBinding("install_1", "binding_1")).toMatchObject({ generation: 3 });
});

it("preserves a local tombstone when a later reconciliation omits it", () => {
  const { repository } = credentialFixture();
  repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot({ bindingCount: 2 }),
    bindings: [
      bindingMetadata({ bindingId: "binding_1" }),
      bindingMetadata({ bindingId: "binding_2", state: "revoked", generation: 2 }),
    ],
    responseSha256: "1".repeat(64),
    now: 3_000,
  });

  const result = repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot({ bindingCount: 1 }),
    bindings: [bindingMetadata({ bindingId: "binding_1" })],
    responseSha256: "2".repeat(64),
    now: 4_000,
  });

  expect(result.outcome).toBe("reconciled");
  expect(repository.getCredentialBinding("install_1", "binding_2")).toMatchObject({
    bindingId: "binding_2",
    state: "revoked",
    generation: 2,
  });
});

it("keeps health reconciliation scoped to its own installation", () => {
  const { repository } = credentialFixture();
  repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot(),
    bindings: [bindingMetadata()],
    responseSha256: "1".repeat(64),
    now: 3_000,
  });

  expect(repository.getCredentialHealth("install_2")).toBeNull();
  expect(repository.getCredentialBinding("install_2", "binding_1")).toBeNull();
  expect(repository.listCredentialBindings({ installationId: "install_2", limit: 10 })).toEqual([]);
});

// --- listing / pagination -----------------------------------------------

it("paginates bindings stably in bindingId order", () => {
  const { repository } = credentialFixture();
  const bindings = Array.from({ length: 5 }, (_, index) =>
    bindingMetadata({ bindingId: `binding_${index}` }));
  repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot({ bindingCount: bindings.length }),
    bindings,
    responseSha256: "1".repeat(64),
    now: 3_000,
  });

  const firstPage = repository.listCredentialBindings({ installationId: "install_1", limit: 2 });
  expect(firstPage.map((binding) => binding.bindingId)).toEqual(["binding_0", "binding_1"]);

  const secondPage = repository.listCredentialBindings({
    installationId: "install_1",
    limit: 2,
    afterBindingId: firstPage[1]!.bindingId,
  });
  expect(secondPage.map((binding) => binding.bindingId)).toEqual(["binding_2", "binding_3"]);
});

it("filters listed bindings by state", () => {
  const { repository } = credentialFixture();
  repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot({ bindingCount: 2 }),
    bindings: [
      bindingMetadata({ bindingId: "binding_1", state: "pending" }),
      bindingMetadata({ bindingId: "binding_2", state: "revoked", generation: 2 }),
    ],
    responseSha256: "1".repeat(64),
    now: 3_000,
  });

  const revoked = repository.listCredentialBindings({ installationId: "install_1", state: "revoked", limit: 10 });
  expect(revoked.map((binding) => binding.bindingId)).toEqual(["binding_2"]);
});

// --- diagnostic (broker.health) operation lifecycle ----------------------

it("prepares a fresh diagnostic operation and replays it identically on a repeat prepare", () => {
  const { repository } = credentialFixture();
  const envelope = healthEnvelope();

  const first = repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope, now: 2_000 });
  expect(first.outcome).toBe("prepared");

  const replay = repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope, now: 2_100 });
  expect(replay.outcome).toBe("prepared");
  if (replay.outcome !== "prepared" && replay.outcome !== "completed" && replay.outcome !== "ambiguous") {
    throw new Error("unexpected replay outcome");
  }
  expect(replay.operation.requestId).toBe(envelope.requestId);
});

it("rejects a diagnostic prepare that reuses an idempotency key with a different envelope", () => {
  const { repository } = credentialFixture();
  const envelope = healthEnvelope();
  repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope, now: 2_000 });

  const changed = repository.prepareCredentialDiagnosticOperation({
    installationId: "install_1",
    envelope: healthEnvelope({ issuedAt: 2_500, deadlineAt: 12_500 }),
    now: 2_100,
  });

  expect(changed).toEqual({ outcome: "digest_mismatch" });
});

it("requires an outstanding diagnostic to be reconciled before a new key can be prepared", () => {
  const { repository } = credentialFixture();
  const first = healthEnvelope({ requestId: "health-a", idempotencyKey: "health-a", nonce: "health-a" });
  repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope: first, now: 2_000 });

  const second = healthEnvelope({ requestId: "health-b", idempotencyKey: "health-b", nonce: "health-b" });
  const result = repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope: second, now: 2_100 });

  expect(result.outcome).toBe("reconcile_required");
  if (result.outcome !== "reconcile_required") throw new Error("expected reconcile_required");
  expect(result.operation.requestId).toBe(first.requestId);
});

it("allows a new diagnostic key once the outstanding one is completed", () => {
  const { repository } = credentialFixture();
  const first = healthEnvelope({ requestId: "health-a", idempotencyKey: "health-a", nonce: "health-a" });
  repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope: first, now: 2_000 });
  repository.completeCredentialDiagnosticOperation({
    installationId: "install_1",
    requestId: first.requestId,
    response: healthResponse(first),
    now: 3_000,
  });

  const second = healthEnvelope({ requestId: "health-b", idempotencyKey: "health-b", nonce: "health-b" });
  const result = repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope: second, now: 3_100 });

  expect(result.outcome).toBe("prepared");
});

it("completes a diagnostic operation and reconciles the carried health snapshot transactionally", () => {
  const { repository } = credentialFixture();
  const envelope = healthEnvelope();
  repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope, now: 2_000 });

  const response = healthResponse(envelope);
  const result = repository.completeCredentialDiagnosticOperation({
    installationId: "install_1",
    requestId: envelope.requestId,
    response,
    now: 5_000,
  });

  expect(result.outcome).toBe("completed");
  if (result.outcome !== "completed") throw new Error("expected completed");
  expect(result.receipt).toMatchObject({ receiptId: response.receiptId, outcome: "succeeded", result: "ready" });
  expect(repository.getCredentialBinding("install_1", "binding_1")).toMatchObject({ state: "pending" });
  expect(repository.getCredentialReceipt("install_1", response.receiptId!)).toMatchObject({
    receiptId: response.receiptId,
  });
});

it("replays the same completed receipt instead of re-inserting on a repeat completion", () => {
  const { repository } = credentialFixture();
  const envelope = healthEnvelope();
  repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope, now: 2_000 });
  const response = healthResponse(envelope);
  repository.completeCredentialDiagnosticOperation({
    installationId: "install_1",
    requestId: envelope.requestId,
    response,
    now: 5_000,
  });

  const replay = repository.completeCredentialDiagnosticOperation({
    installationId: "install_1",
    requestId: envelope.requestId,
    response,
    now: 5_500,
  });

  expect(replay.outcome).toBe("replay");
  if (replay.outcome !== "replay") throw new Error("expected replay");
  expect(replay.receipt?.receiptId).toBe(response.receiptId);
});

it("rejects completing a diagnostic operation with a response whose identity does not match the prepared envelope", () => {
  const { repository } = credentialFixture();
  const envelope = healthEnvelope();
  repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope, now: 2_000 });

  const mismatched = repository.completeCredentialDiagnosticOperation({
    installationId: "install_1",
    requestId: envelope.requestId,
    response: healthResponse(envelope, { requestId: "req_other-request" }),
    now: 5_000,
  });

  expect(mismatched).toEqual({ outcome: "identity_mismatch" });
});

it("marks a prepared diagnostic operation ambiguous after a local timeout and leaves it completable later", () => {
  const { repository } = credentialFixture();
  const envelope = healthEnvelope();
  repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope, now: 2_000 });

  const marked = repository.markCredentialOperationAmbiguous({
    installationId: "install_1",
    requestId: envelope.requestId,
    now: 12_000,
  });
  expect(marked?.state).toBe("ambiguous");

  const response = healthResponse(envelope);
  const completed = repository.completeCredentialDiagnosticOperation({
    installationId: "install_1",
    requestId: envelope.requestId,
    response,
    now: 15_000,
  });
  expect(completed.outcome).toBe("completed");
});

// --- verification (vault.binding.verify) operation lifecycle, fenced ----

it("prepares a verification operation under the current executor lease and rejects a stale one", () => {
  const { repository, turnId, fence } = credentialFixture();
  repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot(),
    bindings: [bindingMetadata()],
    responseSha256: "1".repeat(64),
    now: 1_500,
  });
  const envelope = verifyEnvelope(fence, turnId);

  const prepared = repository.prepareCredentialVerificationOperation({ ...fence, installationId: "install_1", turnId, envelope });
  expect(prepared.outcome).toBe("prepared");

  const stale = repository.prepareCredentialVerificationOperation({
    ...fence,
    generation: fence.generation + 1,
    installationId: "install_1",
    turnId,
    envelope: verifyEnvelope(fence, turnId, { requestId: "verify-2", idempotencyKey: "verify-2", nonce: "verify-2" }),
  });
  expect(stale).toEqual({ outcome: "stale" });
});

it("replays an identical verification prepare and rejects a changed envelope under the same key", () => {
  const { repository, turnId, fence } = credentialFixture();
  repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot(),
    bindings: [bindingMetadata()],
    responseSha256: "1".repeat(64),
    now: 1_500,
  });
  const envelope = verifyEnvelope(fence, turnId);
  repository.prepareCredentialVerificationOperation({ ...fence, installationId: "install_1", turnId, envelope });

  const replay = repository.prepareCredentialVerificationOperation({ ...fence, installationId: "install_1", turnId, envelope });
  expect(replay.outcome).toBe("prepared");

  const changed = repository.prepareCredentialVerificationOperation({
    ...fence,
    installationId: "install_1",
    turnId,
    envelope: verifyEnvelope(fence, turnId, { bindingGeneration: 2 }),
  });
  expect(changed).toEqual({ outcome: "digest_mismatch" });
});

it("reconciles an outstanding verification before claiming a fresh idempotency key", () => {
  const { repository, turnId, fence } = credentialFixture();
  repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot(),
    bindings: [bindingMetadata()],
    responseSha256: "1".repeat(64),
    now: 1_500,
  });
  const firstEnvelope = verifyEnvelope(fence, turnId, {
    requestId: "verify-a",
    idempotencyKey: "verify-a",
    nonce: "verify-a",
  });
  const first = repository.prepareCredentialVerificationOperation({
    ...fence,
    installationId: "install_1",
    turnId,
    envelope: firstEnvelope,
  });
  expect(first.outcome).toBe("prepared");
  repository.markCredentialOperationAmbiguous({
    installationId: "install_1",
    requestId: firstEnvelope.requestId,
    now: 2_100,
  });

  const second = repository.prepareCredentialVerificationOperation({
    ...fence,
    installationId: "install_1",
    turnId,
    envelope: verifyEnvelope(fence, turnId, {
      requestId: "verify-b",
      idempotencyKey: "verify-b",
      nonce: "verify-b",
    }),
  });

  expect(second.outcome).toBe("reconcile_required");
  if (second.outcome !== "reconcile_required") throw new Error("expected reconcile_required");
  expect(second.operation.envelope).toEqual(firstEnvelope);
});

it("completes a verification operation, inserts its receipt, and advances the binding to vault_verified", () => {
  const { repository, turnId, fence } = credentialFixture();
  repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot(),
    bindings: [bindingMetadata()],
    responseSha256: "1".repeat(64),
    now: 1_500,
  });
  const envelope = verifyEnvelope(fence, turnId);
  repository.prepareCredentialVerificationOperation({ ...fence, installationId: "install_1", turnId, envelope });

  const response = verifyResponse(envelope);
  const result = repository.completeCredentialVerificationOperation({
    ...fence,
    turnId,
    installationId: "install_1",
    requestId: envelope.requestId,
    response,
    now: 5_000,
  });

  expect(result.outcome).toBe("completed");
  expect(repository.getCredentialBinding("install_1", "binding_1")).toMatchObject({
    state: "vault_verified",
    lastVerifiedAt: 5_000,
  });
});

it("does not advance binding state on a deterministic invalid verification", () => {
  const { repository, turnId, fence } = credentialFixture();
  repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot(),
    bindings: [bindingMetadata()],
    responseSha256: "1".repeat(64),
    now: 1_500,
  });
  const envelope = verifyEnvelope(fence, turnId);
  repository.prepareCredentialVerificationOperation({ ...fence, installationId: "install_1", turnId, envelope });

  const response = verifyResponse(envelope, {
    outcome: "failed",
    result: "invalid",
    failureClass: "credential_invalid",
    receiptId: `receipt_${envelope.requestId}`,
  });
  repository.completeCredentialVerificationOperation({
    ...fence,
    turnId,
    installationId: "install_1",
    requestId: envelope.requestId,
    response,
    now: 5_000,
  });

  expect(repository.getCredentialBinding("install_1", "binding_1")).toMatchObject({ state: "pending" });
});

it("round-trips a binding through vault_verified, degraded, and back to vault_verified across successive verifications", () => {
  const { repository, turnId, fence } = credentialFixture();
  repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot(),
    bindings: [bindingMetadata()],
    responseSha256: "1".repeat(64),
    now: 1_500,
  });

  const firstVerify = verifyEnvelope(fence, turnId, { requestId: "verify-a", idempotencyKey: "verify-a", nonce: "verify-a" });
  repository.prepareCredentialVerificationOperation({ ...fence, installationId: "install_1", turnId, envelope: firstVerify });
  repository.completeCredentialVerificationOperation({
    ...fence,
    turnId,
    installationId: "install_1",
    requestId: firstVerify.requestId,
    response: verifyResponse(firstVerify),
    now: 3_000,
  });
  expect(repository.getCredentialBinding("install_1", "binding_1")).toMatchObject({ state: "vault_verified" });

  const secondVerify = verifyEnvelope(fence, turnId, { requestId: "verify-b", idempotencyKey: "verify-b", nonce: "verify-b" });
  repository.prepareCredentialVerificationOperation({ ...fence, installationId: "install_1", turnId, envelope: secondVerify });
  repository.completeCredentialVerificationOperation({
    ...fence,
    turnId,
    installationId: "install_1",
    requestId: secondVerify.requestId,
    response: verifyResponse(secondVerify, {
      outcome: "failed",
      result: "invalid",
      failureClass: "credential_invalid",
      receiptId: `receipt_${secondVerify.requestId}`,
    }),
    now: 6_000,
  });
  expect(repository.getCredentialBinding("install_1", "binding_1")).toMatchObject({ state: "degraded" });

  const thirdVerify = verifyEnvelope(fence, turnId, { requestId: "verify-c", idempotencyKey: "verify-c", nonce: "verify-c" });
  repository.prepareCredentialVerificationOperation({ ...fence, installationId: "install_1", turnId, envelope: thirdVerify });
  repository.completeCredentialVerificationOperation({
    ...fence,
    turnId,
    installationId: "install_1",
    requestId: thirdVerify.requestId,
    response: verifyResponse(thirdVerify),
    now: 9_000,
  });
  expect(repository.getCredentialBinding("install_1", "binding_1")).toMatchObject({
    state: "vault_verified",
    lastVerifiedAt: 9_000,
  });
});

it("round-trips a compromised binding through health reconciliation", () => {
  const { repository } = credentialFixture();

  repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot(),
    bindings: [bindingMetadata({ state: "compromised", generation: 4 })],
    responseSha256: "1".repeat(64),
    now: 4_000,
  });

  expect(repository.getCredentialBinding("install_1", "binding_1")).toMatchObject({
    state: "compromised",
    generation: 4,
  });
  expect(repository.listCredentialBindings({ installationId: "install_1", state: "compromised", limit: 10 }))
    .toHaveLength(1);
});

it("rejects completing a verification operation once the executor generation has moved on", () => {
  const { repository, store, turnId, fence } = credentialFixture();
  repository.reconcileCredentialHealth({
    installationId: "install_1",
    health: healthSnapshot(),
    bindings: [bindingMetadata()],
    responseSha256: "1".repeat(64),
    now: 1_500,
  });
  const envelope = verifyEnvelope(fence, turnId);
  repository.prepareCredentialVerificationOperation({ ...fence, installationId: "install_1", turnId, envelope });

  expect(store.releaseExecutorLease(fence.ownerId, fence.generation, fence.now)).toBe(true);
  const nextLease = store.acquireExecutorLease("executor-2", 6_000, 30_000);
  if (!nextLease.acquired) throw new Error("replacement lease was not acquired");

  const result = repository.completeCredentialVerificationOperation({
    ownerId: "executor-2",
    generation: nextLease.generation,
    now: 6_000,
    turnId,
    installationId: "install_1",
    requestId: envelope.requestId,
    response: verifyResponse(envelope),
  });

  expect(result).toEqual({ outcome: "stale" });
});

// --- receipts -------------------------------------------------------------

it("keeps receipt ids globally unique and rejects a second receipt row reusing one", () => {
  const { repository } = credentialFixture();
  const envelopeA = healthEnvelope({ requestId: "health-a", idempotencyKey: "health-a", nonce: "health-a" });
  repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope: envelopeA, now: 2_000 });
  repository.completeCredentialDiagnosticOperation({
    installationId: "install_1",
    requestId: envelopeA.requestId,
    response: healthResponse(envelopeA, { receiptId: "receipt_shared" }),
    now: 3_000,
  });

  const envelopeB = healthEnvelope({ requestId: "health-b", idempotencyKey: "health-b", nonce: "health-b" });
  repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope: envelopeB, now: 4_000 });

  expect(() =>
    repository.completeCredentialDiagnosticOperation({
      installationId: "install_1",
      requestId: envelopeB.requestId,
      response: healthResponse(envelopeB, { receiptId: "receipt_shared" }),
      now: 5_000,
    })
  ).toThrow();
});

it("keeps receipt reads scoped to their own installation", () => {
  const { repository } = credentialFixture();
  const envelope = healthEnvelope();
  repository.prepareCredentialDiagnosticOperation({ installationId: "install_1", envelope, now: 2_000 });
  const response = healthResponse(envelope);
  repository.completeCredentialDiagnosticOperation({
    installationId: "install_1",
    requestId: envelope.requestId,
    response,
    now: 3_000,
  });

  expect(repository.getCredentialReceipt("install_2", response.receiptId!)).toBeNull();
});

// --- raw schema: strict enums / checks -------------------------------------

it("rejects an out-of-vocabulary binding state, provider, risk, mfa mode, and approval mode at the schema level", () => {
  const { db } = credentialFixture();
  const insert = (overrides: Record<string, string>) =>
    db.prepare(
      `INSERT INTO credential_bindings (
         installation_id, binding_id, label, provider, state, generation,
         capability_ids_json, risk, mfa_mode, approval_mode, last_verified_at, created_at, updated_at
       ) VALUES (
         'install_1', 'binding_x', 'Label', @provider, @state, 1,
         '[]', @risk, @mfa_mode, @approval_mode, NULL, 1, 1
       )`,
    ).run({
      provider: "onepassword",
      state: "pending",
      risk: "low",
      mfa_mode: "none",
      approval_mode: "none",
      ...overrides,
    });

  expect(() => insert({ state: "deleted" })).toThrow();
  expect(() => insert({ provider: "lastpass" })).toThrow();
  expect(() => insert({ risk: "unratable" })).toThrow();
  expect(() => insert({ mfa_mode: "sms" })).toThrow();
  expect(() => insert({ approval_mode: "always" })).toThrow();
  expect(insert({})).toBeDefined();
});

it("enforces one binding row per installation and binding id", () => {
  const { db } = credentialFixture();
  const insert = () =>
    db.prepare(
      `INSERT INTO credential_bindings (
         installation_id, binding_id, label, provider, state, generation,
         capability_ids_json, risk, mfa_mode, approval_mode, last_verified_at, created_at, updated_at
       ) VALUES ('install_1', 'binding_dupe', 'Label', 'onepassword', 'pending', 1, '[]', 'low', 'none', 'none', NULL, 1, 1)`,
    ).run();

  insert();
  expect(insert).toThrow();
});
