import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  decryptBrokerReference,
  encryptBrokerReference,
  fingerprintResolvedVersion,
} from "../broker/src/crypto";
import { applyBrokerMigrations } from "../broker/src/migrations";
import {
  BrokerStore,
  type BrokerRequestCompletion,
} from "../broker/src/store";
import {
  FOUNDATION_BROKER_POLICY_DIGEST,
  type BrokerResponseEnvelope,
} from "../src/credentials/protocol";
import { temporaryBrokerDatabase, testClock } from "./support/credential-broker-fixtures";

const DATA_KEY = new Uint8Array(32).fill(0x11);
const AUDIT_KEY = new Uint8Array(32).fill(0x22);
const REFERENCE = "op://vault-canary/item-canary/field-canary";
const SECRET = "resolved-secret-canary-value";

function response(overrides: Partial<BrokerResponseEnvelope> = {}): BrokerResponseEnvelope {
  return {
    schemaVersion: 1,
    installationId: "installation-1",
    requestId: "request-1",
    operation: "vault.binding.verify",
    outcome: "succeeded",
    result: "valid",
    failureClass: null,
    retryable: false,
    retryAfterMs: null,
    receiptId: "receipt-1",
    health: null,
    bindings: [],
    completedAt: 1_800_000_000_500,
    ...overrides,
  };
}

function storeFixture() {
  const database = temporaryBrokerDatabase();
  const clock = testClock();
  const store = new BrokerStore(database.db, {
    dataKey: DATA_KEY,
    auditKey: AUDIT_KEY,
    clock: clock.now,
    retentionDays: 30,
  });
  return { ...database, clock, store };
}

function enrollInstallation(store: BrokerStore) {
  return store.addInstallation({
    installationId: "installation-1",
    clientCertificateFingerprint: "a".repeat(64),
    policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
    topologyReceiptDigest: "b".repeat(64),
    topologyReceiptExpiresAt: 1_900_000_000_000,
    expectedVaultId: "vault-canary",
  });
}

describe("broker cryptography", () => {
  it("encrypts references with fresh nonces and round-trips with matching AAD", () => {
    const aad = { installationId: "installation-1", bindingId: "binding-1", generation: 1 } as const;
    const first = encryptBrokerReference({ reference: REFERENCE, key: DATA_KEY, aad });
    const second = encryptBrokerReference({ reference: REFERENCE, key: DATA_KEY, aad });
    expect(first).not.toBe(second);
    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(first).not.toContain(REFERENCE);
    expect(decryptBrokerReference({ ciphertext: first, key: DATA_KEY, aad })).toBe(REFERENCE);
  });

  it.each([
    ["wrong generation", { installationId: "installation-1", bindingId: "binding-1", generation: 2 }],
    ["wrong binding", { installationId: "installation-1", bindingId: "binding-2", generation: 1 }],
    ["wrong installation", { installationId: "installation-2", bindingId: "binding-1", generation: 1 }],
  ])("rejects %s AAD", (_label, aad) => {
    const ciphertext = encryptBrokerReference({
      reference: REFERENCE,
      key: DATA_KEY,
      aad: { installationId: "installation-1", bindingId: "binding-1", generation: 1 },
    });
    expect(() => decryptBrokerReference({ ciphertext, key: DATA_KEY, aad })).toThrow();
  });

  it("rejects tampering and a wrong key", () => {
    const aad = { installationId: "installation-1", bindingId: "binding-1", generation: 1 } as const;
    const ciphertext = encryptBrokerReference({ reference: REFERENCE, key: DATA_KEY, aad });
    const parts = ciphertext.split(".");
    parts[3] = `${parts[3]}A`;
    expect(() => decryptBrokerReference({ ciphertext: parts.join("."), key: DATA_KEY, aad })).toThrow();
    expect(() => decryptBrokerReference({ ciphertext, key: AUDIT_KEY, aad })).toThrow();
  });

  it("fingerprints resolved bytes with stable keyed HMAC and rejects wrong key sizes", () => {
    expect(fingerprintResolvedVersion(SECRET, AUDIT_KEY)).toBe(
      fingerprintResolvedVersion(SECRET, AUDIT_KEY),
    );
    expect(fingerprintResolvedVersion(SECRET, AUDIT_KEY)).not.toBe(
      fingerprintResolvedVersion(`${SECRET}!`, AUDIT_KEY),
    );
    expect(fingerprintResolvedVersion(SECRET, AUDIT_KEY)).not.toBe(
      fingerprintResolvedVersion(SECRET, DATA_KEY),
    );
    expect(() => fingerprintResolvedVersion(SECRET, new Uint8Array(31))).toThrow();
  });
});

describe("broker migrations", () => {
  it("creates the WAL database with fixed tables, checks, indexes, and safe mode", () => {
    const fixture = temporaryBrokerDatabase();
    try {
      applyBrokerMigrations(fixture.db);
      expect(fixture.db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(fixture.db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(fixture.db.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(statSync(fixture.databasePath).mode & 0o777).toBe(0o600);
      const tables = fixture.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
        "broker_installations",
        "broker_bindings",
        "broker_requests",
        "broker_receipts",
        "broker_admin_events",
      ]));
      const indexes = fixture.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
        "broker_bindings_installation_state",
        "broker_bindings_installation_binding_generation",
        "broker_requests_installation_request",
        "broker_requests_installation_nonce",
        "broker_receipts_installation_completed",
      ]));
    } finally {
      fixture.close();
    }
  });

  it("is idempotent and exposes no secret-value columns", () => {
    const fixture = temporaryBrokerDatabase();
    try {
      applyBrokerMigrations(fixture.db);
      applyBrokerMigrations(fixture.db);
      const columns = fixture.db
        .prepare("SELECT name FROM pragma_table_info('broker_bindings')")
        .all() as Array<{ name: string }>;
      expect(columns.map((row) => row.name)).not.toEqual(
        expect.arrayContaining(["secret", "token", "password", "secret_length", "secret_prefix"]),
      );
    } finally {
      fixture.close();
    }
  });
});

describe("broker store", () => {
  it("encrypts enrollment references and returns only secret-free metadata", () => {
    const fixture = storeFixture();
    try {
      enrollInstallation(fixture.store);
      const binding = fixture.store.addBinding({
        installationId: "installation-1",
        bindingId: "binding-1",
        reference: REFERENCE,
        label: "canary binding",
        capabilityIds: ["telegram_agent_access_verify"],
        risk: "high",
        mfaMode: "none",
        approvalMode: "none",
      });
      expect(binding.state).toBe("pending");
      expect(JSON.stringify(binding)).not.toContain(REFERENCE);
      const databaseBytes = readFileSync(fixture.databasePath).toString("utf8");
      const walBytes = existsSync(fixture.walPath) ? readFileSync(fixture.walPath).toString("utf8") : "";
      expect(databaseBytes).not.toContain(REFERENCE);
      expect(databaseBytes).not.toContain(SECRET);
      expect(walBytes).not.toContain(REFERENCE);
      expect(walBytes).not.toContain(SECRET);
    } finally {
      fixture.close();
    }
  });

  it("claims a request once, replays completion, and detects digest mismatch", () => {
    const fixture = storeFixture();
    try {
      enrollInstallation(fixture.store);
      fixture.store.addBinding({
        installationId: "installation-1",
        bindingId: "binding-1",
        reference: REFERENCE,
        label: "canary binding",
        capabilityIds: ["telegram_agent_access_verify"],
        risk: "high",
        mfaMode: "none",
        approvalMode: "none",
      });
      const claim = {
        installationId: "installation-1",
        certificateFingerprint: "a".repeat(64),
        requestId: "request-1",
        idempotencyKey: "idempotency-1",
        nonce: "nonce-1",
        requestDigest: "c".repeat(64),
        operation: "vault.binding.verify" as const,
        bindingId: "binding-1",
        bindingGeneration: 1,
        turnId: "turn-1",
        capabilityId: "telegram_agent_access_verify" as const,
        policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
        fenceOwner: "executor-1",
        fenceGeneration: 1,
        issuedAt: 1_800_000_000_000,
        deadlineAt: 1_800_000_010_000,
      };
      expect(fixture.store.claimRequest(claim)).toEqual({ outcome: "claimed" });
      expect(fixture.store.claimRequest(claim)).toEqual({ outcome: "ambiguous" });
      const completed = fixture.store.completeRequest({
        ...claim,
        response: response({ receiptId: null }),
        result: "valid",
        failureClass: null,
        retryable: false,
        retryAfterMs: null,
        versionHmac: fingerprintResolvedVersion(SECRET, AUDIT_KEY),
      } satisfies BrokerRequestCompletion);
      expect(completed.outcome).toBe("succeeded");
      expect(fixture.store.getBinding("installation-1", "binding-1")?.state).toBe("vault_verified");
      expect(fixture.store.claimRequest(claim)).toMatchObject({ outcome: "completed" });
      expect(fixture.store.claimRequest({ ...claim, requestDigest: "d".repeat(64) })).toEqual({
        outcome: "digest_mismatch",
      });
    } finally {
      fixture.close();
    }
  });

  it("reconciles an interrupted claim to an audited ambiguity without a value", () => {
    const fixture = storeFixture();
    try {
      enrollInstallation(fixture.store);
      const claim = {
        installationId: "installation-1",
        certificateFingerprint: "a".repeat(64),
        requestId: "request-2",
        idempotencyKey: "idempotency-2",
        nonce: "nonce-2",
        requestDigest: "c".repeat(64),
        operation: "broker.health" as const,
        bindingId: null,
        bindingGeneration: null,
        turnId: null,
        capabilityId: "system.broker.health" as const,
        policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
        fenceOwner: null,
        fenceGeneration: null,
        issuedAt: 1_800_000_000_000,
        deadlineAt: 1_800_000_010_000,
      };
      expect(fixture.store.claimRequest(claim)).toEqual({ outcome: "claimed" });
      expect(fixture.store.reconcileInterruptedRequests(1_800_000_000_100)).toBe(1);
      expect(fixture.store.claimRequest(claim)).toMatchObject({ outcome: "completed" });
      const databaseBytes = readFileSync(fixture.databasePath).toString("utf8");
      const walBytes = existsSync(fixture.walPath) ? readFileSync(fixture.walPath).toString("utf8") : "";
      expect(databaseBytes).not.toContain(SECRET);
      expect(databaseBytes).not.toContain(REFERENCE);
      expect(walBytes).not.toContain(SECRET);
      expect(walBytes).not.toContain(REFERENCE);
    } finally {
      fixture.close();
    }
  });

  it("revokes an installation atomically and compromises every binding", () => {
    const fixture = storeFixture();
    try {
      enrollInstallation(fixture.store);
      for (const bindingId of ["binding-1", "binding-2"]) {
        fixture.store.addBinding({
          installationId: "installation-1",
          bindingId,
          reference: `op://vault-canary/item-${bindingId}/field-canary`,
          label: `binding ${bindingId}`,
          capabilityIds: ["telegram_agent_access_verify"],
          risk: "high",
          mfaMode: "none",
          approvalMode: "none",
        });
      }

      const revoked = fixture.store.revokeInstallation({ installationId: "installation-1" });

      expect(revoked.state).toBe("revoked");
      expect(fixture.store.getInstallationByCertificate("a".repeat(64))).toBeNull();
      expect(fixture.store.getBinding("installation-1", "binding-1")).toMatchObject({ state: "compromised", generation: 2 });
      expect(fixture.store.getBinding("installation-1", "binding-2")).toMatchObject({ state: "compromised", generation: 2 });
      expect(fixture.db.prepare("SELECT operation, outcome FROM broker_admin_events WHERE operation = 'installation.revoke'").all())
        .toEqual([{ operation: "installation.revoke", outcome: "succeeded" }]);
    } finally {
      fixture.close();
    }
  });

  it("rolls back installation revocation when the audit event cannot be written", () => {
    const fixture = storeFixture();
    try {
      enrollInstallation(fixture.store);
      fixture.store.addBinding({
        installationId: "installation-1",
        bindingId: "binding-1",
        reference: REFERENCE,
        label: "canary binding",
        capabilityIds: ["telegram_agent_access_verify"],
        risk: "high",
        mfaMode: "none",
        approvalMode: "none",
      });
      fixture.db.exec("CREATE TRIGGER reject_installation_revocation BEFORE INSERT ON broker_admin_events WHEN NEW.operation = 'installation.revoke' BEGIN SELECT RAISE(ABORT, 'audit failure'); END");

      expect(() => fixture.store.revokeInstallation({ installationId: "installation-1" })).toThrow();
      expect(fixture.store.getInstallation("installation-1")?.state).toBe("active");
      expect(fixture.store.getBinding("installation-1", "binding-1")).toMatchObject({ state: "pending", generation: 1 });
      expect(fixture.db.prepare("SELECT count(*) AS count FROM broker_admin_events WHERE operation = 'installation.revoke'").get())
        .toEqual({ count: 0 });
    } finally {
      fixture.close();
    }
  });

  it("records a rejected admin mutation without changing broker state", () => {
    const fixture = storeFixture();
    try {
      enrollInstallation(fixture.store);
      const before = fixture.store.getInstallation("installation-1");

      fixture.store.recordRejectedAdminMutation({
        operation: "installation.revoke",
        installationId: "installation-1",
      });

      expect(fixture.store.getInstallation("installation-1")).toEqual(before);
      expect(fixture.db.prepare("SELECT operation, outcome FROM broker_admin_events WHERE operation = 'installation.revoke'").all())
        .toEqual([{ operation: "installation.revoke", outcome: "failed" }]);
    } finally {
      fixture.close();
    }
  });
});
