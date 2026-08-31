import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_BY_ID,
  CAPABILITY_GRAPH_DIGEST,
  CAPABILITY_REGISTRY_DIGEST,
} from "../src/capabilities/catalog";
import {
  PROTECTED_CONNECTOR_POLICY_DIGEST,
  type ProtectedConnectorBindingProjection,
} from "../src/credentials/connector-policy";
import {
  type ProtectedConnectorRequestEnvelope,
  type ProtectedConnectorResponseEnvelope,
} from "../src/credentials/connector-protocol";
import {
  ALL_MIGRATIONS,
  PROTECTED_CONNECTOR_MIGRATIONS,
} from "../src/storage/migrations";
import { ProtectedConnectorRepository } from "../src/storage/protected-connector-repository";
import { openStore } from "../src/storage/store";
import { registerWorkArtifactRelationshipValidation } from "../src/work-artifacts/repository";
import {
  BROKER_FOUNDATION_SCHEMA,
  applyBrokerMigrations,
} from "../broker/src/migrations";
import { temporaryBrokerDatabase } from "./support/credential-broker-fixtures";

const NOW = 1_800_000_000_000;

function projection(overrides: Partial<ProtectedConnectorBindingProjection> = {}): ProtectedConnectorBindingProjection {
  return {
    schemaVersion: 2,
    installationId: "installation-1",
    bindingId: "binding-convex",
    operation: "convex.project.inspect.v1",
    bindingKind: "workload_identity",
    authorityProvider: "convex",
    secretProvider: "provider_native",
    principalLabel: "Hanoon employee",
    capabilityIds: ["telegram_agent_convex_project_inspect"],
    audiences: ["api.convex.dev"],
    origins: [],
    scopes: ["project:read"],
    riskClass: "low",
    mfaMode: "workload_identity",
    approvalMode: "standing_policy",
    state: "vault_verified",
    generation: 1,
    verifiedAt: null,
    expiresAt: null,
    ...overrides,
  } as ProtectedConnectorBindingProjection;
}

function request(overrides: Partial<ProtectedConnectorRequestEnvelope> = {}): ProtectedConnectorRequestEnvelope {
  return {
    schemaVersion: 2,
    installationId: "installation-1",
    requestId: "request-1",
    idempotencyKey: "idempotency-1",
    nonce: "nonce-1",
    operation: "convex.project.inspect.v1",
    bindingId: "binding-convex",
    bindingGeneration: 1,
    taskId: "task-1",
    projectId: "project-1",
    capabilityId: "telegram_agent_convex_project_inspect",
    policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
    fenceOwner: "executor-1",
    fenceGeneration: 1,
    issuedAt: NOW,
    deadlineAt: NOW + 30_000,
    ...overrides,
  } as ProtectedConnectorRequestEnvelope;
}

function response(overrides: Partial<ProtectedConnectorResponseEnvelope> = {}): ProtectedConnectorResponseEnvelope {
  return {
    schemaVersion: 2,
    installationId: "installation-1",
    requestId: "request-1",
    operation: "convex.project.inspect.v1",
    outcome: "succeeded",
    result: {
      projectId: "convex-project-id",
      projectSlug: "hanoon",
      teamId: "convex-team-id",
      teamSlug: "convex-team",
      status: "active",
      connectorVersion: "convex-1",
      observedAt: NOW + 1_000,
    },
    failureClass: null,
    retryable: false,
    retryAfterMs: null,
    receiptId: "receipt-1",
    completedAt: NOW + 2_000,
    ...overrides,
  } as ProtectedConnectorResponseEnvelope;
}

describe("Hanoon protected connector persistence", () => {
  it("stores only the secret-free projection, preserves history, and restores receipts after restart", () => {
    const { bb } = createFakePluginHost({ pluginId: "protected-connector-persistence" });
    const store = openStore(bb.storage, bb.storage.kv, () => NOW);
    const capability = CAPABILITY_BY_ID.get("telegram_agent_convex_project_inspect");
    if (!capability) throw new Error("connector capability missing");
    const profile = store.createCapabilityProfile({
      subjectKind: "worker_attempt",
      subjectId: "attempt:connector",
      threadId: null,
      recipeId: "direct",
      recipeVersion: 1,
      registryDigest: CAPABILITY_REGISTRY_DIGEST,
      graphDigest: CAPABILITY_GRAPH_DIGEST,
      mode: "active",
      model: { pool: "standard", providerId: "codex", modelId: "model", reasoning: "high", serviceTier: "fast" },
      assignments: [{
        capabilityId: capability.id,
        descriptorDigest: capability.digest,
        capabilityKind: "connector",
        mandatory: true,
      }],
      reasonCodes: [],
      traits: [],
      now: NOW,
    });
    expect(store.reconcileProtectedConnectorBinding({ projection: projection(), now: NOW }))
      .toMatchObject({ outcome: "reconciled" });
    expect(store.prepareProtectedConnectorOperation({ request: request(), capabilityProfileId: profile.id, now: NOW }))
      .toMatchObject({ outcome: "prepared" });
    expect(store.completeProtectedConnectorOperation({
      installationId: "installation-1",
      requestId: "request-1",
      response: response(),
      currentAuthority: {
        installationId: "installation-1",
        taskId: "task-1",
        projectId: "project-1",
        capabilityId: "telegram_agent_convex_project_inspect",
        bindingId: "binding-convex",
        bindingGeneration: 1,
        policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
        fenceOwner: "executor-1",
        fenceGeneration: 1,
      },
      now: NOW + 2_000,
    })).toMatchObject({ outcome: "completed", receipt: { receiptId: "receipt-1" } });
    expect(store.listCapabilityReceipts(profile.id, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capabilityId: "telegram_agent_convex_project_inspect",
        capabilityKind: "connector",
        eventType: "outcome",
        outcome: "passed",
        evidenceRefs: ["credential_connector_receipt:receipt-1"],
      }),
    ]));

    expect(store.getProtectedConnectorBinding("installation-1", "binding-convex"))
      .toMatchObject({ state: "active", verifiedAt: NOW + 2_000 });
    expect(store.listProtectedConnectorBindingHistory("installation-1", "binding-convex"))
      .toHaveLength(2);

    const restarted = new ProtectedConnectorRepository(bb.storage.database());
    expect(restarted.getReceipt("installation-1", "receipt-1")).toMatchObject({
      operation: "convex.project.inspect.v1",
      bindingId: "binding-convex",
      identity: { projectSlug: "hanoon", teamSlug: "convex-team" },
    });
    expect(restarted.getBinding("installation-1", "binding-convex"))
      .toMatchObject({ state: "active" });
  });

  it("rejects projection generation downgrade and duplicate-digest mismatch", () => {
    const { bb } = createFakePluginHost({ pluginId: "protected-connector-generation" });
    const store = openStore(bb.storage, bb.storage.kv, () => NOW);
    store.reconcileProtectedConnectorBinding({ projection: projection({ generation: 2 }), now: NOW });
    expect(store.reconcileProtectedConnectorBinding({ projection: projection({ generation: 1 }), now: NOW + 1 }))
      .toEqual({ outcome: "generation_downgrade" });
    expect(store.reconcileProtectedConnectorBinding({
      projection: projection({ generation: 2, principalLabel: "Changed without rotation" }),
      now: NOW + 1,
    })).toEqual({ outcome: "identity_mismatch" });
    const current = projection({ generation: 2 });
    store.reconcileProtectedConnectorBinding({ projection: current, now: NOW + 2 });
    const original = request({ bindingGeneration: 2 });
    expect(store.prepareProtectedConnectorOperation({ request: original, now: NOW + 2 }))
      .toMatchObject({ outcome: "prepared" });
    expect(store.prepareProtectedConnectorOperation({
      request: request({ bindingGeneration: 2, requestId: "changed-request" }),
      now: NOW + 3,
    })).toEqual({ outcome: "digest_mismatch" });
  });

  it("keeps an unreceipted ambiguity open and settles it with the later exact receipt", () => {
    const { bb } = createFakePluginHost({ pluginId: "protected-connector-ambiguity" });
    const store = openStore(bb.storage, bb.storage.kv, () => NOW);
    const capability = CAPABILITY_BY_ID.get("telegram_agent_convex_project_inspect");
    if (!capability) throw new Error("connector capability missing");
    const profile = store.createCapabilityProfile({
      subjectKind: "worker_attempt", subjectId: "attempt:ambiguity", threadId: null,
      recipeId: "direct", recipeVersion: 1, registryDigest: CAPABILITY_REGISTRY_DIGEST,
      graphDigest: CAPABILITY_GRAPH_DIGEST, mode: "active",
      model: { pool: "standard", providerId: "codex", modelId: "model", reasoning: "high", serviceTier: "fast" },
      assignments: [{ capabilityId: capability.id, descriptorDigest: capability.digest, capabilityKind: "connector", mandatory: true }],
      reasonCodes: [], traits: [], now: NOW,
    });
    expect(store.reconcileProtectedConnectorBinding({ projection: projection(), now: NOW }))
      .toMatchObject({ outcome: "reconciled" });
    expect(store.prepareProtectedConnectorOperation({ request: request(), capabilityProfileId: profile.id, now: NOW }))
      .toMatchObject({ outcome: "prepared" });
    expect(store.completeProtectedConnectorOperation({
      installationId: "installation-1",
      requestId: "request-1",
      response: response({
        outcome: "failed",
        result: null,
        failureClass: "result_ambiguous",
        retryable: false,
        retryAfterMs: null,
        receiptId: null,
      }),
      currentAuthority: null,
      now: NOW + 2_000,
    })).toMatchObject({ outcome: "completed", operation: { state: "ambiguous" }, receipt: null });
    expect(store.completeProtectedConnectorOperation({
      installationId: "installation-1",
      requestId: "request-1",
      response: response(),
      currentAuthority: {
        installationId: "installation-1", taskId: "task-1", projectId: "project-1",
        capabilityId: "telegram_agent_convex_project_inspect", bindingId: "binding-convex",
        bindingGeneration: 1, policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
        fenceOwner: "executor-1", fenceGeneration: 1,
      },
      now: NOW + 3_000,
    })).toMatchObject({ outcome: "completed", operation: { state: "completed" }, receipt: { receiptId: "receipt-1" } });
    expect(store.completeProtectedConnectorOperation({
      installationId: "installation-1",
      requestId: "request-1",
      response: response(),
      currentAuthority: {
        installationId: "installation-1", taskId: "task-1", projectId: "project-1",
        capabilityId: "telegram_agent_convex_project_inspect", bindingId: "binding-convex",
        bindingGeneration: 1, policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
        fenceOwner: "executor-1", fenceGeneration: 1,
      },
      now: NOW + 4_000,
    })).toMatchObject({ outcome: "replay", receipt: { receiptId: "receipt-1" } });
  });

  it("makes historical projections append-only", () => {
    const { bb } = createFakePluginHost({ pluginId: "protected-connector-history" });
    const store = openStore(bb.storage, bb.storage.kv, () => NOW);
    store.reconcileProtectedConnectorBinding({ projection: projection(), now: NOW });
    const db = bb.storage.database();
    expect(() => db.prepare("UPDATE credential_connector_binding_history SET observed_at = observed_at + 1").run())
      .toThrow();
    expect(() => db.prepare("DELETE FROM credential_connector_binding_history").run()).toThrow();
  });
});

describe("append-only schema compatibility", () => {
  it("migrates a shipped Hanoon credential foundation without changing version-1 rows", () => {
    const { bb } = createFakePluginHost({ pluginId: "protected-connector-hanoon-migration" });
    const db = bb.storage.database();
    registerWorkArtifactRelationshipValidation(db);
    const foundationMigrations = ALL_MIGRATIONS.slice(0, -PROTECTED_CONNECTOR_MIGRATIONS.length);
    bb.storage.migrate(db, foundationMigrations);
    db.prepare(`
      INSERT INTO credential_bindings (
        installation_id, binding_id, label, provider, state, generation,
        capability_ids_json, risk, mfa_mode, approval_mode, last_verified_at,
        created_at, updated_at
      ) VALUES ('installation-v1', 'binding-v1', 'Legacy', 'onepassword', 'vault_verified', 1,
        '[]', 'low', 'none', 'none', ?, ?, ?)
    `).run(NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO credential_operations (
        installation_id, request_id, idempotency_key, nonce, operation,
        binding_id, binding_generation, turn_id, capability_id, policy_digest,
        fence_owner, fence_generation, issued_at, deadline_at, envelope_digest,
        state, response_receipt_id, created_at, updated_at
      ) VALUES ('installation-v1', 'request-v1', 'idempotency-v1', 'nonce-v1',
        'vault.binding.verify', 'binding-v1', 1, 'turn-v1', 'telegram_agent_access_verify',
        ?, 'executor-v1', 1, ?, ?, ?, 'completed', 'receipt-v1', ?, ?)
    `).run("a".repeat(64), NOW, NOW + 1_000, "b".repeat(64), NOW, NOW);
    db.prepare(`
      INSERT INTO credential_receipts (
        receipt_id, installation_id, request_id, idempotency_key, operation,
        turn_id, binding_id, binding_generation, outcome, result, failure_class,
        retryable, retry_after_ms, response_sha256, completed_at, created_at
      ) VALUES ('receipt-v1', 'installation-v1', 'request-v1', 'idempotency-v1',
        'vault.binding.verify', 'turn-v1', 'binding-v1', 1, 'succeeded', 'valid', NULL,
        0, NULL, ?, ?, ?)
    `).run("c".repeat(64), NOW, NOW);

    bb.storage.migrate(db, [...ALL_MIGRATIONS]);
    expect(db.prepare("SELECT state, generation FROM credential_bindings WHERE binding_id = 'binding-v1'").get())
      .toEqual({ state: "vault_verified", generation: 1 });
    expect(db.prepare("SELECT state, response_receipt_id FROM credential_operations WHERE request_id = 'request-v1'").get())
      .toEqual({ state: "completed", response_receipt_id: "receipt-v1" });
    expect(db.prepare("SELECT result FROM credential_receipts WHERE receipt_id = 'receipt-v1'").get())
      .toEqual({ result: "valid" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential_connector_bindings'").get())
      .toEqual({ name: "credential_connector_bindings" });
  });

  it("migrates and restarts a shipped broker foundation without changing version-1 rows", () => {
    const fixture = temporaryBrokerDatabase();
    try {
      fixture.db.exec(BROKER_FOUNDATION_SCHEMA);
      fixture.db.prepare("INSERT INTO broker_schema_migrations(version, applied_at) VALUES (1, ?)").run(NOW);
      fixture.db.prepare(`
        INSERT INTO broker_installations (
          installation_id, client_certificate_fingerprint, policy_digest,
          topology_receipt_digest, topology_receipt_expires_at,
          expected_vault_ciphertext, state, created_at, updated_at
        ) VALUES ('installation-v1', ?, ?, ?, ?, 'v1.a.b.c', 'active', ?, ?)
      `).run("a".repeat(64), "b".repeat(64), "c".repeat(64), NOW + 100_000, NOW, NOW);
      fixture.db.prepare(`
        INSERT INTO broker_bindings (
          installation_id, binding_id, external_reference_ciphertext, label,
          provider, state, generation, capability_ids_json, risk, mfa_mode,
          approval_mode, last_verified_at, created_at, updated_at,
          revoked_at, tombstone_at
        ) VALUES ('installation-v1', 'binding-v1', 'v1.a.b.c', 'Legacy',
          'onepassword', 'vault_verified', 1, '[]', 'low', 'none', 'none', ?, ?, ?, NULL, NULL)
      `).run(NOW, NOW, NOW);
      fixture.db.prepare(`
        INSERT INTO broker_requests (
          installation_id, idempotency_key, request_id, nonce, request_digest,
          operation, binding_id, binding_generation, turn_id, capability_id,
          policy_digest, fence_owner, fence_generation, certificate_fingerprint,
          issued_at, deadline_at, state, response_json, completed_receipt_id,
          started_at, completed_at
        ) VALUES ('installation-v1', 'idempotency-v1', 'request-v1', 'nonce-v1', ?,
          'vault.binding.verify', 'binding-v1', 1, 'turn-v1', 'telegram_agent_access_verify',
          ?, 'executor-v1', 1, ?, ?, ?, 'completed', '{}', 'receipt-v1', ?, ?)
      `).run("d".repeat(64), "b".repeat(64), "a".repeat(64), NOW, NOW + 1_000, NOW, NOW);
      fixture.db.prepare(`
        INSERT INTO broker_receipts (
          receipt_id, installation_id, request_id, idempotency_key, operation,
          binding_id, binding_generation, capability_id, policy_digest, fence_owner,
          fence_generation, request_digest, client_certificate_fingerprint,
          outcome, result, failure_class, retryable, retry_after_ms, adapter_version,
          protocol_version, version_hmac, started_at, completed_at
        ) VALUES ('receipt-v1', 'installation-v1', 'request-v1', 'idempotency-v1',
          'vault.binding.verify', 'binding-v1', 1, 'telegram_agent_access_verify', ?,
          'executor-v1', 1, ?, ?, 'succeeded', 'valid', NULL, 0, NULL, '0.1.0', 1,
          NULL, ?, ?)
      `).run("b".repeat(64), "d".repeat(64), "a".repeat(64), NOW, NOW);

      applyBrokerMigrations(fixture.db);
      applyBrokerMigrations(fixture.db);
      expect(fixture.db.prepare("SELECT state, generation FROM broker_bindings WHERE binding_id = 'binding-v1'").get())
        .toEqual({ state: "vault_verified", generation: 1 });
      expect(fixture.db.prepare("SELECT completed_receipt_id FROM broker_requests WHERE request_id = 'request-v1'").get())
        .toEqual({ completed_receipt_id: "receipt-v1" });
      expect(fixture.db.prepare("SELECT result, protocol_version FROM broker_receipts WHERE receipt_id = 'receipt-v1'").get())
        .toEqual({ result: "valid", protocol_version: 1 });
      expect(fixture.db.prepare("SELECT version FROM broker_schema_migrations ORDER BY version").all())
        .toEqual([{ version: 1 }, { version: 2 }]);

      const reopened = new Database(fixture.databasePath);
      applyBrokerMigrations(reopened);
      expect(reopened.prepare("SELECT count(*) AS count FROM broker_receipts").get()).toEqual({ count: 1 });
      reopened.close();
    } finally {
      fixture.close();
    }
  });
});
