import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  FOUNDATION_BROKER_POLICY_DIGEST,
  brokerRequestDigest,
  parseBrokerResponse,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
} from "../src/credentials/protocol";
import { BrokerOperationService } from "../broker/src/operation-service";
import type { VaultAdapter } from "../broker/src/onepassword-adapter";
import { BrokerStore, type BrokerRequestClaimInput } from "../broker/src/store";
import { temporaryBrokerDatabase, testClock } from "./support/credential-broker-fixtures";

const DATA_KEY = new Uint8Array(32).fill(0x11);
const AUDIT_KEY = new Uint8Array(32).fill(0x22);
const REFERENCE = "op://vault-canary-id/item-canary-id/field-canary-id";

const CERTIFICATE_FINGERPRINT = "a".repeat(64);
const OTHER_CERTIFICATE_FINGERPRINT = "c".repeat(64);
const TOPOLOGY_DIGEST = "b".repeat(64);
const NOW = 1_800_000_000_000;

type AdapterCalls = { health: number; verify: number };

type Harness = Readonly<{
  database: ReturnType<typeof temporaryBrokerDatabase>;
  store: BrokerStore;
  clock: ReturnType<typeof testClock>;
  calls: AdapterCalls;
  adapter: VaultAdapter;
  service: BrokerOperationService;
  close(): void;
}>;

function request(overrides: Partial<BrokerRequestEnvelope> = {}): BrokerRequestEnvelope {
  return {
    schemaVersion: 1,
    installationId: "installation-1",
    requestId: "request-1",
    idempotencyKey: "idempotency-1",
    operation: "broker.health",
    bindingId: null,
    bindingGeneration: null,
    turnId: null,
    capabilityId: "system.broker.health",
    policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
    fenceOwner: null,
    fenceGeneration: null,
    issuedAt: NOW - 1_000,
    deadlineAt: NOW + 10_000,
    nonce: "nonce-1",
    ...overrides,
  };
}

function verifyRequest(overrides: Partial<BrokerRequestEnvelope> = {}): BrokerRequestEnvelope {
  return request({
    operation: "vault.binding.verify",
    bindingId: "binding-1",
    bindingGeneration: 1,
    turnId: "turn-1",
    capabilityId: "telegram_agent_access_verify",
    fenceOwner: "executor-1",
    fenceGeneration: 1,
    ...overrides,
  });
}

function createHarness(
  adapterOverrides: Partial<VaultAdapter> = {},
  install = true,
): Harness {
  const database = temporaryBrokerDatabase();
  const clock = testClock(NOW);
  const store = new BrokerStore(database.db, {
    dataKey: DATA_KEY,
    auditKey: AUDIT_KEY,
    clock: clock.now,
  });
  if (install) {
    enrollBrokerInstallation(store, CERTIFICATE_FINGERPRINT, TOPOLOGY_DIGEST);
    enrollBrokerBinding(store);
  }
  const calls: AdapterCalls = { health: 0, verify: 0 };
  const adapter: VaultAdapter = {
    health: async () => {
      calls.health += 1;
      return { outcome: "ready" };
    },
    verify: async () => {
      calls.verify += 1;
      return { outcome: "valid", versionHmac: "d".repeat(64) };
    },
    ...adapterOverrides,
  };
  const service = new BrokerOperationService({
    store,
    adapter,
    dataKey: DATA_KEY,
    auditKey: AUDIT_KEY,
    clock: clock.now,
    brokerVersion: "0.1.0",
  });
  return {
    database,
    store,
    clock,
    calls,
    adapter,
    service,
    close: database.close,
  };
}

function enrollBrokerInstallation(
  store: BrokerStore,
  certificateFingerprint = CERTIFICATE_FINGERPRINT,
  topologyReceiptDigest = TOPOLOGY_DIGEST,
  installationId = "installation-1",
): void {
  store.addInstallation({
    installationId,
    clientCertificateFingerprint: certificateFingerprint,
    policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
    topologyReceiptDigest,
    topologyReceiptExpiresAt: 1_900_000_000_000,
    expectedVaultId: "vault-canary-id",
  });
}

function enrollBrokerBinding(store: BrokerStore, bindingId = "binding-1", installationId = "installation-1"): void {
  store.addBinding({
    installationId,
    bindingId,
    reference: REFERENCE,
    label: `binding ${bindingId}`,
    capabilityIds: ["telegram_agent_access_verify"],
    risk: "high",
    mfaMode: "none",
    approvalMode: "none",
  });
}

async function execute(
  harness: Harness,
  input: Partial<BrokerRequestEnvelope> = {},
  certificateFingerprint = CERTIFICATE_FINGERPRINT,
  now = NOW,
): Promise<BrokerResponseEnvelope> {
  const hasVerifyFields = input.bindingId !== null && input.bindingId !== undefined ||
    input.bindingGeneration !== null && input.bindingGeneration !== undefined;
  const envelope = hasVerifyFields ? verifyRequest(input) : request(input);
  return harness.service.execute({ certificateFingerprint, now, request: envelope });
}

function expectValidated(response: BrokerResponseEnvelope): void {
  expect(parseBrokerResponse(response)).toMatchObject({ ok: true });
}

function claimInput(envelope: BrokerRequestEnvelope, now = NOW): BrokerRequestClaimInput {
  return {
    installationId: envelope.installationId,
    certificateFingerprint: CERTIFICATE_FINGERPRINT,
    requestId: envelope.requestId,
    idempotencyKey: envelope.idempotencyKey,
    nonce: envelope.nonce,
    requestDigest: brokerRequestDigest(envelope),
    operation: envelope.operation,
    bindingId: envelope.bindingId,
    bindingGeneration: envelope.bindingGeneration,
    turnId: envelope.turnId,
    capabilityId: envelope.capabilityId,
    policyDigest: envelope.policyDigest,
    fenceOwner: envelope.fenceOwner,
    fenceGeneration: envelope.fenceGeneration,
    issuedAt: envelope.issuedAt,
    deadlineAt: envelope.deadlineAt,
    now,
  };
}

describe("broker authorization order", () => {
  it.each([
    ["unknown certificate", {}, OTHER_CERTIFICATE_FINGERPRINT],
    ["body installation mismatch", { installationId: "other-installation" }, CERTIFICATE_FINGERPRINT],
    ["stale schema", { schemaVersion: 2 }, CERTIFICATE_FINGERPRINT],
    ["policy mismatch", { policyDigest: "e".repeat(64) }, CERTIFICATE_FINGERPRINT],
    ["expired deadline", { deadlineAt: NOW - 1 }, CERTIFICATE_FINGERPRINT],
    ["future issue beyond skew", { issuedAt: NOW + 60_001 }, CERTIFICATE_FINGERPRINT],
    ["operation capability mismatch", { capabilityId: "telegram_agent_access_verify" }, CERTIFICATE_FINGERPRINT],
  ])("does not invoke the adapter for %s", async (_label, input, certificateFingerprint) => {
    const harness = createHarness();
    try {
      const result = await execute(harness, input as Partial<BrokerRequestEnvelope>, certificateFingerprint);
      expect(harness.calls.health + harness.calls.verify).toBe(0);
      expect(result.outcome).toBe("failed");
      expectValidated(result);
    } finally {
      harness.close();
    }
  });

  it("rejects an oversized request before installation dispatch", async () => {
    const harness = createHarness();
    try {
      const oversized = { ...request(), padding: "x".repeat(20_000) } as unknown as Partial<BrokerRequestEnvelope>;
      const result = await harness.service.execute({
        certificateFingerprint: CERTIFICATE_FINGERPRINT,
        now: NOW,
        request: oversized as BrokerRequestEnvelope,
      });
      expect(result.failureClass).toBe("request_rejected");
      expect(harness.calls.health + harness.calls.verify).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("rejects duplicate request ids and nonces without adapter work", async () => {
    const harness = createHarness();
    try {
      await execute(harness);
      const duplicateRequest = await execute(harness, {
        requestId: "request-2",
        idempotencyKey: "idempotency-2",
      });
      expect(duplicateRequest.failureClass).toBe("request_rejected");
      expect(harness.calls.health).toBe(1);
    } finally {
      harness.close();
    }
  });

  it("denies cross-installation, revoked, compromised, inactive, and stale-generation bindings", async () => {
    const harness = createHarness();
    try {
      harness.store.addInstallation({
        installationId: "installation-2",
        clientCertificateFingerprint: OTHER_CERTIFICATE_FINGERPRINT,
        policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
        topologyReceiptDigest: TOPOLOGY_DIGEST,
        topologyReceiptExpiresAt: NOW + 100_000,
        expectedVaultId: "vault-canary-id",
      });
      enrollBrokerBinding(harness.store, "binding-2", "installation-2");
      const crossInstallation = await execute(harness, {
        bindingId: "binding-2",
        bindingGeneration: 1,
      });
      expect(crossInstallation.failureClass).toBe("binding_missing");
      const stale = await execute(harness, {
        requestId: "request-stale",
        idempotencyKey: "idempotency-stale",
        nonce: "nonce-stale",
        bindingGeneration: 99,
      });
      expect(stale.failureClass).toBe("binding_generation_stale");
      harness.store.revokeBinding({ installationId: "installation-1", bindingId: "binding-1" });
      const revoked = await execute(harness, {
        requestId: "request-revoked",
        idempotencyKey: "idempotency-revoked",
        nonce: "nonce-revoked",
        bindingGeneration: 2,
      });
      expect(revoked.failureClass).toBe("binding_inactive");
      harness.database.db.prepare(
        "UPDATE broker_bindings SET state = 'compromised' WHERE installation_id = ? AND binding_id = ?",
      ).run("installation-1", "binding-1");
      const compromised = await execute(harness, {
        requestId: "request-compromised",
        idempotencyKey: "idempotency-compromised",
        nonce: "nonce-compromised",
        bindingGeneration: 2,
      });
      expect(compromised.failureClass).toBe("binding_inactive");
      expect(harness.calls.verify).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("returns authenticated health with all 100 bindings and never verifies during health", async () => {
    const harness = createHarness();
    try {
      for (let index = 2; index <= 100; index += 1) {
        enrollBrokerBinding(harness.store, `binding-${index}`);
      }
      const result = await execute(harness);
      expect(result.outcome).toBe("succeeded");
      expect(result.result).toBe("ready");
      expect(result.health?.bindingCount).toBe(100);
      expect(result.bindings).toHaveLength(100);
      expect(result.health?.topologyReceiptDigest).toBe(TOPOLOGY_DIGEST);
      expect(harness.calls.health).toBe(1);
      expect(harness.calls.verify).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("keeps diagnostic health authenticated when topology metadata differs", async () => {
    const harness = createHarness();
    try {
      const result = await execute(harness, { policyDigest: FOUNDATION_BROKER_POLICY_DIGEST });
      expect(result.result).toBe("ready");
      expect(result.health?.topologyReceiptDigest).toBe(TOPOLOGY_DIGEST);
      expectValidated(result);
    } finally {
      harness.close();
    }
  });
});

describe("broker idempotency and audit", () => {
  it("invokes one adapter operation for a concurrent identical request", async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const database = temporaryBrokerDatabase();
      const secondaryDb = new Database(database.databasePath);
      const clock = testClock(NOW);
      const primaryStore = new BrokerStore(database.db, { dataKey: DATA_KEY, auditKey: AUDIT_KEY, clock: clock.now });
      const secondaryStore = new BrokerStore(secondaryDb, { dataKey: DATA_KEY, auditKey: AUDIT_KEY, clock: clock.now });
      enrollBrokerInstallation(primaryStore, CERTIFICATE_FINGERPRINT, TOPOLOGY_DIGEST);
      enrollBrokerBinding(primaryStore);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      let adapterCalls = 0;
      const adapter: VaultAdapter = {
        health: async () => {
          adapterCalls += 1;
          await pending;
          return { outcome: "ready" };
        },
        verify: async () => ({ outcome: "valid", versionHmac: "d".repeat(64) }),
      };
      const serviceOne = new BrokerOperationService({ store: primaryStore, adapter, dataKey: DATA_KEY, auditKey: AUDIT_KEY, clock: clock.now, brokerVersion: "0.1.0" });
      const serviceTwo = new BrokerOperationService({ store: secondaryStore, adapter, dataKey: DATA_KEY, auditKey: AUDIT_KEY, clock: clock.now, brokerVersion: "0.1.0" });
      try {
        const first = serviceOne.execute({ certificateFingerprint: CERTIFICATE_FINGERPRINT, now: NOW, request: request() });
        const second = await serviceTwo.execute({ certificateFingerprint: CERTIFICATE_FINGERPRINT, now: NOW, request: request() });
        expect(second.failureClass).toBe("result_ambiguous");
        release();
        const firstResult = await first;
        expect(firstResult.outcome).toBe("succeeded");
        expect(adapterCalls).toBe(1);
        const completed = database.db.prepare("SELECT count(*) AS count FROM broker_requests WHERE state = 'completed'").get() as { count: number };
        expect(completed.count).toBe(1);
      } finally {
        release();
        secondaryDb.close();
        database.close();
      }
    }
  });

  it("replays a completed response byte-for-byte even after its deadline", async () => {
    const harness = createHarness();
    try {
      const first = await execute(harness);
      const replay = await execute(harness, {}, CERTIFICATE_FINGERPRINT, NOW + 100_000);
      expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
      expect(harness.calls.health).toBe(1);
    } finally {
      harness.close();
    }
  });

  it("does not overwrite an original claim when the same idempotency key has a different digest", async () => {
    const harness = createHarness();
    try {
      const first = await execute(harness);
      const changed = await execute(harness, { requestId: "changed-request" });
      expect(changed.failureClass).toBe("request_rejected");
      const replay = await execute(harness);
      expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
      expect(harness.calls.health).toBe(1);
    } finally {
      harness.close();
    }
  });

  it("reconciles an inherited claim to an audited ambiguity without adapter work", async () => {
    const harness = createHarness({}, false);
    try {
      enrollBrokerInstallation(harness.store, CERTIFICATE_FINGERPRINT, TOPOLOGY_DIGEST);
      const inherited = request();
      expect(harness.store.claimRequest(claimInput(inherited))).toEqual({ outcome: "claimed" });
      const service = new BrokerOperationService({
        store: harness.store,
        adapter: harness.adapter,
        dataKey: DATA_KEY,
        auditKey: AUDIT_KEY,
        clock: harness.clock.now,
        brokerVersion: "0.1.0",
      });
      const result = await service.execute({ certificateFingerprint: CERTIFICATE_FINGERPRINT, now: NOW, request: inherited });
      expect(result.failureClass).toBe("result_ambiguous");
      expect(result.receiptId).not.toBeNull();
      expect(harness.calls.health).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("returns receipt persistence failure after adapter success and releases no success", async () => {
    const harness = createHarness();
    try {
      harness.database.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON broker_receipts BEGIN SELECT RAISE(ABORT, 'audit canary'); END");
      const result = await execute(harness);
      expect(result).toMatchObject({ outcome: "failed", result: null, failureClass: "receipt_persistence_failed", receiptId: null });
      expect(harness.calls.health).toBe(1);
    } finally {
      harness.close();
    }
  });

  it("reuses one stored request identity after an active timeout instead of manufacturing a key", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const harness = createHarness({
      health: async () => {
        await pending;
        return { outcome: "ready" };
      },
    });
    try {
      const first = harness.service.execute({ certificateFingerprint: CERTIFICATE_FINGERPRINT, now: NOW, request: request() });
      const retry = await execute(harness, {}, CERTIFICATE_FINGERPRINT, NOW + 100_000);
      expect(retry.failureClass).toBe("result_ambiguous");
      const requests = harness.database.db.prepare("SELECT count(*) AS count FROM broker_requests").get() as { count: number };
      expect(requests.count).toBe(1);
      release();
      const firstResult = await first;
      expect(firstResult.requestId).toBe("request-1");
    } finally {
      release();
      harness.close();
    }
  });

  it("moves pending and degraded bindings to vault_verified, but never changes active", async () => {
    const pendingHarness = createHarness();
    try {
      await execute(pendingHarness, { bindingGeneration: 1 });
      expect(pendingHarness.store.getBinding("installation-1", "binding-1")?.state).toBe("vault_verified");
    } finally {
      pendingHarness.close();
    }

    const degradedHarness = createHarness();
    try {
      degradedHarness.database.db.prepare(
        "UPDATE broker_bindings SET state = 'degraded' WHERE installation_id = ? AND binding_id = ?",
      ).run("installation-1", "binding-1");
      await execute(degradedHarness, { bindingGeneration: 1 });
      expect(degradedHarness.store.getBinding("installation-1", "binding-1")?.state).toBe("vault_verified");
    } finally {
      degradedHarness.close();
    }

    const activeHarness = createHarness();
    try {
      activeHarness.database.db.prepare(
        "UPDATE broker_bindings SET state = 'active' WHERE installation_id = ? AND binding_id = ?",
      ).run("installation-1", "binding-1");
      await execute(activeHarness, { bindingGeneration: 1 });
      expect(activeHarness.store.getBinding("installation-1", "binding-1")?.state).toBe("active");
    } finally {
      activeHarness.close();
    }
  });

  it("keeps pending invalid and demotes vault_verified invalid to degraded", async () => {
    const invalidAdapter: VaultAdapter = {
      health: async () => ({ outcome: "ready" }),
      verify: async () => ({ outcome: "invalid" }),
    };
    const pendingHarness = createHarness(invalidAdapter);
    try {
      const result = await execute(pendingHarness, { bindingGeneration: 1 });
      expect(result.failureClass).toBe("credential_invalid");
      expect(pendingHarness.store.getBinding("installation-1", "binding-1")?.state).toBe("pending");
    } finally {
      pendingHarness.close();
    }

    const degradedHarness = createHarness(invalidAdapter);
    try {
      degradedHarness.database.db.prepare(
        "UPDATE broker_bindings SET state = 'vault_verified' WHERE installation_id = ? AND binding_id = ?",
      ).run("installation-1", "binding-1");
      await execute(degradedHarness, { bindingGeneration: 1 });
      expect(degradedHarness.store.getBinding("installation-1", "binding-1")?.state).toBe("degraded");
    } finally {
      degradedHarness.close();
    }
  });
});
