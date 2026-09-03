import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import {
  BROKER_MAX_BINDINGS,
  parseBrokerResponse,
  type BrokerCapabilityId,
  type BrokerFailureClass,
  type BrokerOperation,
  type BrokerResponseEnvelope,
  type CredentialBindingMetadata,
} from "../../src/credentials/protocol.js";
import {
  decryptBrokerReference,
  encryptBrokerReference,
} from "./crypto.js";
import { applyBrokerMigrations } from "./migrations.js";

const EXPECTED_VAULT_BINDING_ID = "__expected_vault__";
const BINDING_GENERATION_START = 1;

type InstallationState = "active" | "revoked" | "compromised";

export type BrokerInstallation = Readonly<{
  installationId: string;
  clientCertificateFingerprint: string;
  policyDigest: string;
  topologyReceiptDigest: string;
  topologyReceiptExpiresAt: number;
  expectedVaultCiphertext: string;
  state: InstallationState;
  createdAt: number;
  updatedAt: number;
}>;

export type BrokerBinding = Readonly<CredentialBindingMetadata & {
  installationId: string;
  externalReferenceCiphertext: string | null;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
  tombstoneAt: number | null;
}>;

export type BrokerStoreOptions = Readonly<{
  dataKey?: Uint8Array;
  auditKey?: Uint8Array;
  clock?: () => number;
  retentionDays?: number;
  adapterVersion?: string;
}>;

export type BrokerInstallationEnrollment = Readonly<{
  installationId: string;
  clientCertificateFingerprint: string;
  policyDigest: string;
  topologyReceiptDigest: string;
  topologyReceiptExpiresAt: number;
  expectedVaultId: string;
  now?: number;
}>;

export type BrokerInstallationAttestation = Readonly<{
  installationId: string;
  topologyReceiptDigest: string;
  topologyReceiptExpiresAt: number;
  now?: number;
}>;

export type BrokerInstallationRevocation = Readonly<{
  installationId: string;
  now?: number;
}>;

export type BrokerAdminOperation =
  | "installation.add"
  | "installation.attest"
  | "installation.revoke"
  | "binding.add"
  | "binding.revoke"
  | "connector.binding.enroll";

export type BrokerRejectedAdminMutation = Readonly<{
  operation: BrokerAdminOperation;
  installationId: string;
  bindingId?: string;
  now?: number;
}>;

export type BrokerBindingEnrollment = Readonly<{
  installationId: string;
  bindingId?: string;
  reference: string;
  label: string;
  capabilityIds: readonly string[];
  risk: CredentialBindingMetadata["risk"];
  mfaMode: CredentialBindingMetadata["mfaMode"];
  approvalMode: CredentialBindingMetadata["approvalMode"];
  now?: number;
}>;

export type BrokerBindingRevocation = Readonly<{
  installationId: string;
  bindingId: string;
  now?: number;
}>;

export type BrokerRequestClaimInput = Readonly<{
  installationId: string;
  certificateFingerprint: string;
  requestId: string;
  idempotencyKey: string;
  nonce: string;
  requestDigest: string;
  operation: BrokerOperation;
  bindingId: string | null;
  bindingGeneration: number | null;
  turnId: string | null;
  capabilityId: BrokerCapabilityId;
  policyDigest: string;
  fenceOwner: string | null;
  fenceGeneration: number | null;
  issuedAt: number;
  deadlineAt: number;
  now?: number;
}>;

export type BrokerRequestClaim =
  | { outcome: "claimed" }
  | { outcome: "completed"; response: BrokerResponseEnvelope }
  | { outcome: "ambiguous" }
  | { outcome: "digest_mismatch" };

export type BrokerRequestRejection = BrokerRequestClaimInput;

export type BrokerRequestCompletion = Readonly<BrokerRequestClaimInput & {
  response: BrokerResponseEnvelope;
  result: BrokerResponseEnvelope["result"];
  failureClass: BrokerFailureClass | null;
  retryable: boolean;
  retryAfterMs: number | null;
  versionHmac?: string | null;
  adapterVersion?: string;
}>;

export type BrokerExecutorFenceAttestation = Readonly<{
  installationId: string;
  taskId: string;
  projectId: string;
  fenceOwner: string;
  fenceGeneration: number;
  expiresAt: number;
  now?: number;
}>;

type DbInstallationRow = {
  installation_id: string;
  client_certificate_fingerprint: string;
  policy_digest: string;
  topology_receipt_digest: string;
  topology_receipt_expires_at: number;
  expected_vault_ciphertext: string;
  state: InstallationState;
  created_at: number;
  updated_at: number;
};

type DbBindingRow = {
  installation_id: string;
  binding_id: string;
  external_reference_ciphertext: string | null;
  label: string;
  provider: "onepassword";
  state: CredentialBindingMetadata["state"];
  generation: number;
  capability_ids_json: string;
  risk: CredentialBindingMetadata["risk"];
  mfa_mode: CredentialBindingMetadata["mfaMode"];
  approval_mode: CredentialBindingMetadata["approvalMode"];
  last_verified_at: number | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  tombstone_at: number | null;
};

type DbRequestRow = {
  installation_id: string;
  idempotency_key: string;
  request_id: string;
  nonce: string;
  request_digest: string;
  operation: BrokerOperation;
  binding_id: string | null;
  binding_generation: number | null;
  turn_id: string | null;
  capability_id: BrokerCapabilityId;
  policy_digest: string;
  fence_owner: string | null;
  fence_generation: number | null;
  certificate_fingerprint: string;
  issued_at: number;
  deadline_at: number;
  state: "claimed" | "completed" | "ambiguous";
  response_json: string | null;
  completed_receipt_id: string | null;
  started_at: number;
  completed_at: number | null;
};

function stableError(code: string): Error {
  return new Error(code);
}

function nowOr(clock: () => number, now: number | undefined): number {
  return now ?? clock();
}

function isHexDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function parseCapabilities(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 8 || !parsed.every((item) => typeof item === "string")) throw new Error();
    return Object.freeze([...parsed]);
  } catch {
    throw stableError("broker_metadata_corrupt");
  }
}

function bindingMetadata(row: DbBindingRow): CredentialBindingMetadata {
  return Object.freeze({
    bindingId: row.binding_id,
    label: row.label,
    provider: row.provider,
    state: row.state,
    generation: row.generation,
    capabilityIds: parseCapabilities(row.capability_ids_json),
    risk: row.risk,
    mfaMode: row.mfa_mode,
    approvalMode: row.approval_mode,
    lastVerifiedAt: row.last_verified_at,
  });
}

function bindingFromRow(row: DbBindingRow): BrokerBinding {
  return Object.freeze({
    ...bindingMetadata(row),
    installationId: row.installation_id,
    externalReferenceCiphertext: row.external_reference_ciphertext,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
    tombstoneAt: row.tombstone_at,
  });
}

function installationFromRow(row: DbInstallationRow): BrokerInstallation {
  return Object.freeze({
    installationId: row.installation_id,
    clientCertificateFingerprint: row.client_certificate_fingerprint,
    policyDigest: row.policy_digest,
    topologyReceiptDigest: row.topology_receipt_digest,
    topologyReceiptExpiresAt: row.topology_receipt_expires_at,
    expectedVaultCiphertext: row.expected_vault_ciphertext,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class BrokerStore {
  private readonly dataKey?: Uint8Array;
  private readonly auditKey?: Uint8Array;
  private readonly clock: () => number;
  private readonly adapterVersion: string;

  constructor(private readonly db: Database.Database, options: BrokerStoreOptions = {}) {
    this.dataKey = options.dataKey ? Uint8Array.from(options.dataKey) : undefined;
    this.auditKey = options.auditKey ? Uint8Array.from(options.auditKey) : undefined;
    this.clock = options.clock ?? Date.now;
    this.adapterVersion = options.adapterVersion ?? "0.1.0";
    applyBrokerMigrations(db);
  }

  getInstallation(installationId: string): BrokerInstallation | null {
    const row = this.db.prepare("SELECT * FROM broker_installations WHERE installation_id = ?")
      .get(installationId) as DbInstallationRow | undefined;
    return row ? installationFromRow(row) : null;
  }

  getInstallationByCertificate(fingerprint: string): BrokerInstallation | null {
    const row = this.db.prepare("SELECT * FROM broker_installations WHERE client_certificate_fingerprint = ?")
      .get(fingerprint) as DbInstallationRow | undefined;
    return row?.state === "active" ? installationFromRow(row) : null;
  }

  public auditWritable(): boolean {
    return this.auditKey !== undefined;
  }

  /**
   * Records authority established by the executor/administration boundary.
   * Request claims never call this method, so a claim cannot mint its own
   * fence authority.
   */
  public attestExecutorFence(input: BrokerExecutorFenceAttestation): boolean {
    const now = input.now ?? this.clock();
    if (
      input.fenceGeneration < 1 ||
      input.expiresAt <= now ||
      input.taskId.trim().length === 0 ||
      input.projectId.trim().length === 0 ||
      input.fenceOwner.trim().length === 0
    ) return false;
    const current = this.db.prepare(`
      SELECT fence_owner, fence_generation, expires_at
        FROM broker_connector_executor_fences
       WHERE installation_id = ? AND task_id = ? AND project_id = ?
    `).get(input.installationId, input.taskId, input.projectId) as {
      fence_owner: string;
      fence_generation: number;
      expires_at: number;
    } | undefined;
    if (
      current &&
      (input.fenceGeneration < current.fence_generation ||
        (input.fenceGeneration === current.fence_generation && current.fence_owner !== input.fenceOwner))
    ) return false;
    this.db.prepare(`
      INSERT INTO broker_connector_executor_fences (
        installation_id, task_id, project_id, fence_owner,
        fence_generation, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (installation_id, task_id, project_id) DO UPDATE SET
        fence_owner = excluded.fence_owner,
        fence_generation = excluded.fence_generation,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(
      input.installationId,
      input.taskId,
      input.projectId,
      input.fenceOwner,
      input.fenceGeneration,
      input.expiresAt,
      now,
    );
    return true;
  }

  public isExecutorFenceCurrent(input: Readonly<{
    installationId: string;
    taskId: string;
    projectId: string;
    fenceOwner: string;
    fenceGeneration: number;
    now?: number;
  }>): boolean {
    const row = this.db.prepare(`
      SELECT fence_owner, fence_generation, expires_at
        FROM broker_connector_executor_fences
       WHERE installation_id = ? AND task_id = ? AND project_id = ?
    `).get(input.installationId, input.taskId, input.projectId) as {
      fence_owner: string;
      fence_generation: number;
      expires_at: number;
    } | undefined;
    return row?.fence_owner === input.fenceOwner &&
      row.fence_generation === input.fenceGeneration &&
      row.expires_at > (input.now ?? this.clock());
  }

  getInstallationCount(): number {
    const row = this.db.prepare("SELECT count(*) AS count FROM broker_installations").get() as { count: number };
    return row.count;
  }

  getBindingCount(): number {
    const row = this.db.prepare("SELECT count(*) AS count FROM broker_bindings").get() as { count: number };
    return row.count;
  }

  getBinding(installationId: string, bindingId: string): BrokerBinding | null {
    const row = this.db.prepare(
      "SELECT * FROM broker_bindings WHERE installation_id = ? AND binding_id = ?",
    ).get(installationId, bindingId) as DbBindingRow | undefined;
    return row ? bindingFromRow(row) : null;
  }

  listBindingMetadata(installationId: string): readonly CredentialBindingMetadata[] {
    const rows = this.db.prepare(
      "SELECT * FROM broker_bindings WHERE installation_id = ? ORDER BY binding_id",
    ).all(installationId) as DbBindingRow[];
    return Object.freeze(rows.map(bindingMetadata));
  }

  decryptExpectedVaultId(installationId: string, key = this.dataKey): string {
    const installation = this.getInstallation(installationId);
    if (!installation || !key) throw stableError("broker_installation_missing");
    return decryptBrokerReference({
      ciphertext: installation.expectedVaultCiphertext,
      key,
      aad: { installationId, bindingId: EXPECTED_VAULT_BINDING_ID, generation: 0 },
    });
  }

  decryptBindingReference(binding: BrokerBinding, key = this.dataKey): string {
    if (!binding.externalReferenceCiphertext || !key) throw stableError("broker_reference_missing");
    return decryptBrokerReference({
      ciphertext: binding.externalReferenceCiphertext,
      key,
      aad: { installationId: binding.installationId, bindingId: binding.bindingId, generation: binding.generation },
    });
  }

  claimRequest(input: BrokerRequestClaimInput): BrokerRequestClaim {
    const installation = this.getInstallation(input.installationId);
    if (!installation || installation.clientCertificateFingerprint !== input.certificateFingerprint) {
      return { outcome: "digest_mismatch" };
    }
    const existing = this.db.prepare(
      "SELECT * FROM broker_requests WHERE installation_id = ? AND idempotency_key = ?",
    ).get(input.installationId, input.idempotencyKey) as DbRequestRow | undefined;
    if (existing) {
      if (existing.request_digest !== input.requestDigest) return { outcome: "digest_mismatch" };
      if (existing.response_json) {
        const parsed: unknown = JSON.parse(existing.response_json);
        const response = parseBrokerResponse(parsed);
        if (!response.ok) throw stableError("broker_response_corrupt");
        return { outcome: "completed", response: response.value };
      }
      return { outcome: "ambiguous" };
    }

    const duplicateRequest = this.db.prepare(
      "SELECT idempotency_key, request_digest FROM broker_requests WHERE installation_id = ? AND request_id = ?",
    ).get(input.installationId, input.requestId) as { idempotency_key: string; request_digest: string } | undefined;
    const duplicateNonce = this.db.prepare(
      "SELECT idempotency_key, request_digest FROM broker_requests WHERE installation_id = ? AND nonce = ?",
    ).get(input.installationId, input.nonce) as { idempotency_key: string; request_digest: string } | undefined;
    if (duplicateRequest || duplicateNonce) return { outcome: "digest_mismatch" };

    try {
      this.db.prepare(`
        INSERT INTO broker_requests (
          installation_id, idempotency_key, request_id, nonce, request_digest,
          operation, binding_id, binding_generation, turn_id, capability_id,
          policy_digest, fence_owner, fence_generation, certificate_fingerprint,
          issued_at, deadline_at, state, response_json, completed_receipt_id,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', NULL, NULL, ?, NULL)
      `).run(
        input.installationId, input.idempotencyKey, input.requestId, input.nonce, input.requestDigest,
        input.operation, input.bindingId, input.bindingGeneration, input.turnId, input.capabilityId,
        input.policyDigest, input.fenceOwner, input.fenceGeneration, input.certificateFingerprint,
        input.issuedAt, input.deadlineAt, nowOr(this.clock, input.now),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT")) {
        return { outcome: "digest_mismatch" };
      }
      throw error;
    }
    return { outcome: "claimed" };
  }

  reconcileInterruptedRequests(now: number): number {
    const rows = this.db.prepare(
      "SELECT * FROM broker_requests WHERE state = 'claimed' ORDER BY started_at",
    ).all() as DbRequestRow[];
    let reconciled = 0;
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const receiptId = randomUUID();
        const response = this.responseForRequest(row, {
          outcome: "failed",
          result: null,
          failureClass: "result_ambiguous",
          retryable: false,
          retryAfterMs: null,
          receiptId,
          completedAt: now,
        });
        this.insertReceipt({ row, response, receiptId, completedAt: now, versionHmac: null });
        this.db.prepare(
          "UPDATE broker_requests SET state = 'ambiguous', response_json = ?, completed_receipt_id = ?, completed_at = ? WHERE installation_id = ? AND idempotency_key = ? AND state = 'claimed'",
        ).run(JSON.stringify(response), receiptId, now, row.installation_id, row.idempotency_key);
        reconciled += 1;
      }
    });
    transaction();
    return reconciled;
  }

  rejectRequest(input: BrokerRequestRejection): BrokerResponseEnvelope {
    const now = nowOr(this.clock, input.now);
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT * FROM broker_requests WHERE installation_id = ? AND idempotency_key = ?",
      ).get(input.installationId, input.idempotencyKey) as DbRequestRow | undefined;
      if (row?.response_json) {
        const parsed = parseBrokerResponse(JSON.parse(row.response_json));
        if (!parsed.ok) throw stableError("broker_response_corrupt");
        return parsed.value;
      }
      if (!row) {
        this.db.prepare(`
          INSERT INTO broker_requests (
            installation_id, idempotency_key, request_id, nonce, request_digest,
            operation, binding_id, binding_generation, turn_id, capability_id,
            policy_digest, fence_owner, fence_generation, certificate_fingerprint,
            issued_at, deadline_at, state, response_json, completed_receipt_id,
            started_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', NULL, NULL, ?, NULL)
        `).run(
          input.installationId, input.idempotencyKey, input.requestId, input.nonce, input.requestDigest,
          input.operation, input.bindingId, input.bindingGeneration, input.turnId, input.capabilityId,
          input.policyDigest, input.fenceOwner, input.fenceGeneration, input.certificateFingerprint,
          input.issuedAt, input.deadlineAt, now,
        );
      }
      const current = row ?? this.db.prepare(
        "SELECT * FROM broker_requests WHERE installation_id = ? AND idempotency_key = ?",
      ).get(input.installationId, input.idempotencyKey) as DbRequestRow;
      const receiptId = randomUUID();
      const response = this.responseForRequest(current, {
        outcome: "failed",
        result: null,
        failureClass: "request_rejected",
        retryable: false,
        retryAfterMs: null,
        receiptId,
        completedAt: now,
      });
      this.insertReceipt({ row: current, response, receiptId, completedAt: now, versionHmac: null });
      this.db.prepare(
        "UPDATE broker_requests SET state = 'completed', response_json = ?, completed_receipt_id = ?, completed_at = ? WHERE installation_id = ? AND idempotency_key = ? AND response_json IS NULL",
      ).run(JSON.stringify(response), receiptId, now, current.installation_id, current.idempotency_key);
      return response;
    });
    return transaction();
  }

  completeRequest(input: BrokerRequestCompletion): BrokerResponseEnvelope {
    const now = input.response.completedAt || nowOr(this.clock, input.now);
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT * FROM broker_requests WHERE installation_id = ? AND idempotency_key = ?",
      ).get(input.installationId, input.idempotencyKey) as DbRequestRow | undefined;
      if (!row) throw stableError("broker_claim_missing");
      if (row.response_json) {
        const parsed = parseBrokerResponse(JSON.parse(row.response_json));
        if (!parsed.ok) throw stableError("broker_response_corrupt");
        return parsed.value;
      }
      const receiptId = input.response.receiptId ?? randomUUID();
      const response = this.responseForRequest(row, {
        ...input.response,
        result: input.result,
        failureClass: input.failureClass,
        retryable: input.retryable,
        retryAfterMs: input.retryAfterMs,
        receiptId,
        completedAt: now,
      });
      const parsed = parseBrokerResponse(response);
      if (!parsed.ok) throw stableError("broker_response_invalid");
      this.insertReceipt({ row, response: parsed.value, receiptId, completedAt: now, versionHmac: input.versionHmac ?? null, adapterVersion: input.adapterVersion });
      this.applyBindingTransition(row, parsed.value, now);
      this.db.prepare(
        "UPDATE broker_requests SET state = ?, response_json = ?, completed_receipt_id = ?, completed_at = ? WHERE installation_id = ? AND idempotency_key = ? AND response_json IS NULL",
      ).run(
        parsed.value.failureClass === "result_ambiguous" ? "ambiguous" : "completed",
        JSON.stringify(parsed.value), receiptId, now, row.installation_id, row.idempotency_key,
      );
      return parsed.value;
    });
    return transaction();
  }

  addInstallation(input: BrokerInstallationEnrollment): BrokerInstallation {
    const now = nowOr(this.clock, input.now);
    if (!this.dataKey || !isHexDigest(input.clientCertificateFingerprint) || !isHexDigest(input.policyDigest) ||
        !isHexDigest(input.topologyReceiptDigest) || input.expectedVaultId.length === 0) {
      throw stableError("invalid_installation");
    }
    const expectedVaultCiphertext = encryptBrokerReference({
      reference: input.expectedVaultId,
      key: this.dataKey,
      aad: { installationId: input.installationId, bindingId: EXPECTED_VAULT_BINDING_ID, generation: 0 },
    });
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO broker_installations (
          installation_id, client_certificate_fingerprint, policy_digest,
          topology_receipt_digest, topology_receipt_expires_at,
          expected_vault_ciphertext, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        input.installationId, input.clientCertificateFingerprint, input.policyDigest,
        input.topologyReceiptDigest, input.topologyReceiptExpiresAt, expectedVaultCiphertext, now, now,
      );
      this.insertAdminEvent({
        operation: "installation.add",
        installationId: input.installationId,
        afterTopologyDigest: input.topologyReceiptDigest,
        afterTopologyExpiresAt: input.topologyReceiptExpiresAt,
        afterState: "active",
        occurredAt: now,
      });
    });
    transaction();
    return this.getInstallation(input.installationId)!;
  }

  attestInstallation(input: BrokerInstallationAttestation): BrokerInstallation {
    const now = nowOr(this.clock, input.now);
    const current = this.getInstallation(input.installationId);
    if (!current) throw stableError("broker_installation_missing");
    const transaction = this.db.transaction(() => {
      this.db.prepare(
        "UPDATE broker_installations SET topology_receipt_digest = ?, topology_receipt_expires_at = ?, updated_at = ? WHERE installation_id = ?",
      ).run(input.topologyReceiptDigest, input.topologyReceiptExpiresAt, now, input.installationId);
      this.insertAdminEvent({
        operation: "installation.attest",
        installationId: input.installationId,
        beforeTopologyDigest: current.topologyReceiptDigest,
        afterTopologyDigest: input.topologyReceiptDigest,
        beforeTopologyExpiresAt: current.topologyReceiptExpiresAt,
        afterTopologyExpiresAt: input.topologyReceiptExpiresAt,
        beforeState: current.state,
        afterState: current.state,
        occurredAt: now,
      });
    });
    transaction();
    return this.getInstallation(input.installationId)!;
  }

  revokeInstallation(input: BrokerInstallationRevocation): BrokerInstallation {
    const now = nowOr(this.clock, input.now);
    const current = this.getInstallation(input.installationId);
    if (!current || current.state !== "active") throw stableError("broker_installation_unavailable");
    const transaction = this.db.transaction(() => {
      this.db.prepare(
        "UPDATE broker_installations SET state = 'revoked', updated_at = ? WHERE installation_id = ? AND state = 'active'",
      ).run(now, input.installationId);
      this.db.prepare(
        "UPDATE broker_bindings SET state = 'compromised', generation = generation + 1, updated_at = ? WHERE installation_id = ?",
      ).run(now, input.installationId);
      this.insertAdminEvent({
        operation: "installation.revoke",
        installationId: input.installationId,
        beforeState: current.state,
        afterState: "revoked",
        occurredAt: now,
      });
    });
    transaction();
    return this.getInstallation(input.installationId)!;
  }

  recordRejectedAdminMutation(input: BrokerRejectedAdminMutation): void {
    const now = nowOr(this.clock, input.now);
    const transaction = this.db.transaction(() => {
      this.insertAdminEvent({
        operation: input.operation,
        installationId: input.installationId,
        bindingId: input.bindingId,
        outcome: "failed",
        occurredAt: now,
      });
    });
    transaction();
  }

  addBinding(input: BrokerBindingEnrollment): CredentialBindingMetadata {
    const now = nowOr(this.clock, input.now);
    if (!this.dataKey || input.reference.length === 0 || input.label.trim().length === 0 || input.label.length > 120 ||
        input.capabilityIds.length > 8 || new Set(input.capabilityIds).size !== input.capabilityIds.length) {
      throw stableError("invalid_binding");
    }
    const installation = this.getInstallation(input.installationId);
    if (!installation || installation.state !== "active") throw stableError("broker_installation_unavailable");
    const count = this.db.prepare(
      "SELECT count(*) AS count FROM broker_bindings WHERE installation_id = ?",
    ).get(input.installationId) as { count: number };
    if (count.count >= BROKER_MAX_BINDINGS) throw stableError("binding_limit");
    const bindingId = input.bindingId ?? randomUUID();
    const generation = BINDING_GENERATION_START;
    const ciphertext = encryptBrokerReference({
      reference: input.reference,
      key: this.dataKey,
      aad: { installationId: input.installationId, bindingId, generation },
    });
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO broker_bindings (
          installation_id, binding_id, external_reference_ciphertext, label, provider,
          state, generation, capability_ids_json, risk, mfa_mode, approval_mode,
          last_verified_at, created_at, updated_at, revoked_at, tombstone_at
        ) VALUES (?, ?, ?, ?, 'onepassword', 'pending', ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)
      `).run(
        input.installationId, bindingId, ciphertext, input.label, generation,
        JSON.stringify(input.capabilityIds), input.risk, input.mfaMode, input.approvalMode, now, now,
      );
      this.insertAdminEvent({ operation: "binding.add", installationId: input.installationId, bindingId, afterGeneration: generation, afterState: "pending", occurredAt: now });
    });
    transaction();
    return this.getBinding(input.installationId, bindingId)!;
  }

  revokeBinding(input: BrokerBindingRevocation): CredentialBindingMetadata {
    const now = nowOr(this.clock, input.now);
    const current = this.getBinding(input.installationId, input.bindingId);
    if (!current) throw stableError("broker_binding_missing");
    if (!this.dataKey) throw stableError("broker_data_key_missing");
    const nextGeneration = current.generation + 1;
    const nextCiphertext = current.externalReferenceCiphertext
      ? encryptBrokerReference({ reference: this.decryptBindingReference(current), key: this.dataKey, aad: { installationId: input.installationId, bindingId: input.bindingId, generation: nextGeneration } })
      : null;
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE broker_bindings
        SET external_reference_ciphertext = ?, state = 'revoked', generation = ?, revoked_at = ?, tombstone_at = ?, updated_at = ?
        WHERE installation_id = ? AND binding_id = ?
      `).run(nextCiphertext, nextGeneration, now, now, now, input.installationId, input.bindingId);
      this.insertAdminEvent({
        operation: "binding.revoke",
        installationId: input.installationId,
        bindingId: input.bindingId,
        beforeGeneration: current.generation,
        afterGeneration: nextGeneration,
        beforeState: current.state,
        afterState: "revoked",
        occurredAt: now,
      });
    });
    transaction();
    return this.getBinding(input.installationId, input.bindingId)!;
  }

  private responseForRequest(
    row: Pick<DbRequestRow, "installation_id" | "request_id" | "operation">,
    values: Omit<BrokerResponseEnvelope, "schemaVersion" | "installationId" | "requestId" | "operation" | "health" | "bindings"> & Partial<Pick<BrokerResponseEnvelope, "health" | "bindings">>,
  ): BrokerResponseEnvelope {
    return {
      schemaVersion: 1,
      installationId: row.installation_id,
      requestId: row.request_id,
      operation: row.operation,
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

  private insertReceipt(input: {
    row: DbRequestRow;
    response: BrokerResponseEnvelope;
    receiptId: string;
    completedAt: number;
    versionHmac: string | null;
    adapterVersion?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO broker_receipts (
        receipt_id, installation_id, request_id, idempotency_key, operation,
        binding_id, binding_generation, capability_id, policy_digest, fence_owner,
        fence_generation, request_digest, client_certificate_fingerprint,
        outcome, result, failure_class, retryable, retry_after_ms, adapter_version,
        protocol_version, version_hmac, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      input.receiptId, input.row.installation_id, input.row.request_id, input.row.idempotency_key,
      input.row.operation, input.row.binding_id, input.row.binding_generation, input.row.capability_id,
      input.row.policy_digest, input.row.fence_owner, input.row.fence_generation, input.row.request_digest,
      input.row.certificate_fingerprint, input.response.outcome, input.response.result,
      input.response.failureClass, input.response.retryable ? 1 : 0, input.response.retryAfterMs,
      input.adapterVersion ?? this.adapterVersion, input.versionHmac, input.row.started_at, input.completedAt,
    );
  }

  private applyBindingTransition(row: DbRequestRow, response: BrokerResponseEnvelope, completedAt: number): void {
    if (row.operation !== "vault.binding.verify" || !row.binding_id) return;
    const binding = this.getBinding(row.installation_id, row.binding_id);
    if (!binding || binding.generation !== row.binding_generation) return;
    if (response.result === "valid" && response.failureClass === null) {
      this.db.prepare(
        "UPDATE broker_bindings SET state = 'vault_verified', last_verified_at = ?, updated_at = ? WHERE installation_id = ? AND binding_id = ? AND state IN ('pending', 'degraded')",
      ).run(completedAt, completedAt, row.installation_id, row.binding_id);
    } else if (response.result === "invalid" && response.failureClass === "credential_invalid") {
      this.db.prepare(
        "UPDATE broker_bindings SET state = 'degraded', updated_at = ? WHERE installation_id = ? AND binding_id = ? AND state = 'vault_verified'",
      ).run(completedAt, row.installation_id, row.binding_id);
    }
  }

  private insertAdminEvent(input: {
    operation: BrokerAdminOperation;
    installationId: string;
    bindingId?: string;
    beforeTopologyDigest?: string;
    afterTopologyDigest?: string;
    beforeTopologyExpiresAt?: number;
    afterTopologyExpiresAt?: number;
    beforeGeneration?: number;
    afterGeneration?: number;
    beforeState?: string;
    afterState?: string;
    outcome?: "succeeded" | "failed";
    occurredAt: number;
  }): void {
    this.db.prepare(`
      INSERT INTO broker_admin_events (
        event_id, operation, installation_id, binding_id,
        before_topology_digest, after_topology_digest,
        before_topology_expires_at, after_topology_expires_at,
        before_generation, after_generation, before_state, after_state,
        outcome, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), input.operation, input.installationId, input.bindingId ?? null,
      input.beforeTopologyDigest ?? null, input.afterTopologyDigest ?? null,
      input.beforeTopologyExpiresAt ?? null, input.afterTopologyExpiresAt ?? null,
      input.beforeGeneration ?? null, input.afterGeneration ?? null,
      input.beforeState ?? null, input.afterState ?? null, input.outcome ?? "succeeded", input.occurredAt,
    );
  }
}

export { EXPECTED_VAULT_BINDING_ID };
