import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  brokerRequestDigest,
  canonicalBrokerJson,
  BROKER_MAX_BINDINGS,
  type BrokerAdapterState,
  type BrokerBindingState,
  type BrokerFailureClass,
  type BrokerHealthSnapshot,
  type BrokerOperation,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
  type CredentialBindingMetadata,
} from "../credentials/protocol";
import type { ControllerLeaseFence } from "../controller/models";

type SqliteDatabase = Database.Database;

export type CredentialOperationState = "prepared" | "completed" | "ambiguous";

export type CredentialOperationRecord = Readonly<{
  installationId: string;
  requestId: string;
  idempotencyKey: string;
  envelope: BrokerRequestEnvelope;
  state: CredentialOperationState;
  receiptId: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export type CredentialReceiptRecord = Readonly<{
  receiptId: string;
  installationId: string;
  requestId: string;
  idempotencyKey: string;
  operation: BrokerOperation;
  turnId: string | null;
  bindingId: string | null;
  bindingGeneration: number | null;
  outcome: "succeeded" | "failed";
  result: "ready" | "valid" | "invalid" | null;
  failureClass: BrokerFailureClass | null;
  retryable: boolean;
  retryAfterMs: number | null;
  responseSha256: string;
  completedAt: number;
  createdAt: number;
}>;

export type CredentialHealthRecord = Readonly<{
  installationId: string;
  brokerVersion: string;
  adapter: "onepassword";
  adapterState: BrokerAdapterState;
  auditWritable: boolean;
  bindingCount: number;
  topologyReceiptDigest: string;
  topologyReceiptExpiresAt: number;
  responseSha256: string;
  lastAttemptAt: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureClass: BrokerFailureClass | null;
  updatedAt: number;
}>;

export type CredentialOperationClaim =
  | { outcome: "prepared"; operation: CredentialOperationRecord }
  | { outcome: "completed"; operation: CredentialOperationRecord }
  | { outcome: "ambiguous"; operation: CredentialOperationRecord }
  | { outcome: "digest_mismatch" };

export type CredentialDiagnosticPrepareResult =
  | CredentialOperationClaim
  | { outcome: "reconcile_required"; operation: CredentialOperationRecord };

export type CredentialVerificationPrepareInput = ControllerLeaseFence & Readonly<{
  installationId: string;
  turnId: string;
  envelope: BrokerRequestEnvelope;
}>;

export type CredentialVerificationPrepareResult = CredentialOperationClaim | { outcome: "stale" } | {
  outcome: "reconcile_required";
  operation: CredentialOperationRecord;
};

export type CredentialOperationCompleteInput = Readonly<{
  installationId: string;
  requestId: string;
  response: BrokerResponseEnvelope;
  now: number;
}>;

export type CredentialOperationCompleteResult =
  | { outcome: "completed"; operation: CredentialOperationRecord; receipt: CredentialReceiptRecord | null }
  | { outcome: "replay"; operation: CredentialOperationRecord; receipt: CredentialReceiptRecord | null }
  | { outcome: "identity_mismatch" }
  | { outcome: "not_found" };

export type CredentialVerificationCompleteInput = ControllerLeaseFence & CredentialOperationCompleteInput & Readonly<{
  turnId: string;
}>;

export type CredentialVerificationCompleteResult = CredentialOperationCompleteResult | { outcome: "stale" };

export type CredentialHealthReconcileInput = Readonly<{
  installationId: string;
  health: BrokerHealthSnapshot;
  bindings: readonly CredentialBindingMetadata[];
  responseSha256: string;
  now: number;
}>;

export type CredentialHealthReconcileResult =
  | { outcome: "reconciled"; health: CredentialHealthRecord }
  | { outcome: "generation_downgrade" }
  | { outcome: "limit_exceeded" };

type BindingRow = {
  installation_id: string;
  binding_id: string;
  label: string;
  provider: string;
  state: string;
  generation: number;
  capability_ids_json: string;
  risk: string;
  mfa_mode: string;
  approval_mode: string;
  last_verified_at: number | null;
  created_at: number;
  updated_at: number;
};

type OperationRow = {
  id: number;
  installation_id: string;
  request_id: string;
  idempotency_key: string;
  nonce: string;
  operation: string;
  binding_id: string | null;
  binding_generation: number | null;
  turn_id: string | null;
  capability_id: string;
  policy_digest: string;
  fence_owner: string | null;
  fence_generation: number | null;
  issued_at: number;
  deadline_at: number;
  envelope_digest: string;
  state: string;
  response_receipt_id: string | null;
  created_at: number;
  updated_at: number;
};

type ReceiptRow = {
  receipt_id: string;
  installation_id: string;
  request_id: string;
  idempotency_key: string;
  operation: string;
  turn_id: string | null;
  binding_id: string | null;
  binding_generation: number | null;
  outcome: string;
  result: string | null;
  failure_class: string | null;
  retryable: number;
  retry_after_ms: number | null;
  response_sha256: string;
  completed_at: number;
  created_at: number;
};

type HealthRow = {
  installation_id: string;
  broker_version: string;
  adapter: string;
  adapter_state: string;
  audit_writable: number;
  binding_count: number;
  topology_receipt_digest: string;
  topology_receipt_expires_at: number;
  response_sha256: string;
  last_attempt_at: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_failure_class: string | null;
  updated_at: number;
};

/**
 * Hanoon's secret-free projection of the credential broker foundation: binding
 * metadata, the outbound operation envelopes that back replay/idempotency, the
 * receipts a completed operation produces, and one current health snapshot per
 * installation. Every row is built from `src/credentials/protocol.ts` types, so
 * this store and the wire contract cannot drift into disagreement.
 */
export class CredentialAccessRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  // --- bindings -----------------------------------------------------------

  public reconcileCredentialHealth(input: CredentialHealthReconcileInput): CredentialHealthReconcileResult {
    if (input.bindings.length > BROKER_MAX_BINDINGS) return { outcome: "limit_exceeded" };
    const seen = new Set<string>();
    for (const binding of input.bindings) {
      if (seen.has(binding.bindingId)) {
        throw new Error("Credential health reconciliation carried a duplicate binding id");
      }
      seen.add(binding.bindingId);
    }

    return this.db.transaction((): CredentialHealthReconcileResult => {
      for (const binding of input.bindings) {
        const existing = this.bindingRow(input.installationId, binding.bindingId);
        if (existing && binding.generation < existing.generation) {
          return { outcome: "generation_downgrade" };
        }
      }
      for (const binding of input.bindings) {
        this.upsertBindingRow(input.installationId, binding, input.now);
      }
      this.upsertHealthRow(input);
      const health = this.healthRow(input.installationId);
      if (!health) throw new Error("Credential health row disappeared after reconciliation");
      return { outcome: "reconciled", health: toHealthRecord(health) };
    }).immediate();
  }

  /**
   * A failed current health observation invalidates the prior readiness
   * snapshot. The last successful attempt remains useful history, but it can
   * never make the installation ready after this write.
   */
  public markCredentialHealthUnavailable(input: Readonly<{
    installationId: string;
    failureClass: BrokerFailureClass;
    now: number;
  }>): CredentialHealthRecord | null {
    const row = this.healthRow(input.installationId);
    if (!row) return null;
    this.db.prepare(`
      UPDATE credential_health
         SET adapter_state = 'unavailable', audit_writable = 0,
             last_attempt_at = ?, last_failure_at = ?, last_failure_class = ?,
             updated_at = ?
       WHERE installation_id = ?
    `).run(input.now, input.now, input.failureClass, input.now, input.installationId);
    const updated = this.healthRow(input.installationId);
    return updated ? toHealthRecord(updated) : null;
  }

  public listCredentialBindings(input: Readonly<{
    installationId: string;
    state?: BrokerBindingState;
    afterBindingId?: string;
    limit: number;
  }>): readonly CredentialBindingMetadata[] {
    const state = input.state ?? null;
    const afterBindingId = input.afterBindingId ?? null;
    const rows = this.db.prepare(
      `SELECT * FROM credential_bindings
        WHERE installation_id = ?
          AND (? IS NULL OR state = ?)
          AND (? IS NULL OR binding_id > ?)
        ORDER BY binding_id ASC
        LIMIT ?`,
    ).all(
      input.installationId,
      state, state,
      afterBindingId, afterBindingId,
      input.limit,
    ) as BindingRow[];
    return Object.freeze(rows.map(toBindingMetadata));
  }

  public getCredentialBinding(installationId: string, bindingId: string): CredentialBindingMetadata | null {
    const row = this.bindingRow(installationId, bindingId);
    return row ? toBindingMetadata(row) : null;
  }

  // --- diagnostic (broker.health) operations -------------------------------

  public prepareCredentialDiagnosticOperation(input: Readonly<{
    installationId: string;
    envelope: BrokerRequestEnvelope;
    now: number;
  }>): CredentialDiagnosticPrepareResult {
    assertHealthEnvelope(input.installationId, input.envelope);
    return this.db.transaction((): CredentialDiagnosticPrepareResult => {
      const outstanding = this.outstandingDiagnostic(input.installationId, input.envelope.idempotencyKey);
      if (outstanding) return { outcome: "reconcile_required", operation: toOperationRecord(outstanding) };
      return this.claimOperation(input.installationId, input.envelope, input.now);
    }).immediate();
  }

  public completeCredentialDiagnosticOperation(
    input: CredentialOperationCompleteInput,
  ): CredentialOperationCompleteResult {
    return this.db.transaction((): CredentialOperationCompleteResult => this.completeOperation(input)).immediate();
  }

  // --- verification (vault.binding.verify) operations, fenced -------------

  public prepareCredentialVerificationOperation(
    input: CredentialVerificationPrepareInput,
  ): CredentialVerificationPrepareResult {
    assertVerifyEnvelope(input.installationId, input.turnId, input.envelope);
    return this.db.transaction((): CredentialVerificationPrepareResult => {
      if (!this.submittedTurnFenceIsCurrent(input)) return { outcome: "stale" };
      const outstanding = this.outstandingVerification(
        input.installationId,
        input.turnId,
        input.envelope.bindingId,
        input.envelope.bindingGeneration,
        input.envelope.idempotencyKey,
      );
      if (outstanding) return { outcome: "reconcile_required", operation: toOperationRecord(outstanding) };
      return this.claimOperation(input.installationId, input.envelope, input.now);
    }).immediate();
  }

  public completeCredentialVerificationOperation(
    input: CredentialVerificationCompleteInput,
  ): CredentialVerificationCompleteResult {
    return this.db.transaction((): CredentialVerificationCompleteResult => {
      if (!this.submittedTurnFenceIsCurrent(input)) return { outcome: "stale" };
      const result = this.completeOperation(input);
      if (result.outcome === "completed") {
        const bindingId = result.operation.envelope.bindingId;
        const generation = result.operation.envelope.bindingGeneration;
        if (bindingId !== null && generation !== null) {
          if (input.response.outcome === "succeeded" && input.response.result === "valid") {
            this.advanceBindingAfterVerification(input.installationId, bindingId, generation, input.now);
          } else if (input.response.result === "invalid") {
            this.demoteBindingAfterInvalidVerification(input.installationId, bindingId, generation, input.now);
          }
        }
      }
      return result;
    }).immediate();
  }

  // --- ambiguity ------------------------------------------------------------

  public markCredentialOperationAmbiguous(input: Readonly<{
    installationId: string;
    requestId: string;
    now: number;
  }>): CredentialOperationRecord | null {
    return this.db.transaction((): CredentialOperationRecord | null => {
      const row = this.operationByRequestId(input.installationId, input.requestId);
      if (!row) return null;
      if (row.state !== "prepared") return toOperationRecord(row);
      this.db.prepare(
        `UPDATE credential_operations SET state = 'ambiguous', updated_at = ? WHERE id = ?`,
      ).run(input.now, row.id);
      return toOperationRecord({ ...row, state: "ambiguous", updated_at: input.now });
    }).immediate();
  }

  // --- receipts / health reads -----------------------------------------------

  public getCredentialReceipt(installationId: string, receiptId: string): CredentialReceiptRecord | null {
    const row = this.receiptRow(installationId, receiptId);
    return row ? toReceiptRecord(row) : null;
  }

  public getCredentialHealth(installationId: string): CredentialHealthRecord | null {
    const row = this.healthRow(installationId);
    return row ? toHealthRecord(row) : null;
  }

  // --- private: bindings ------------------------------------------------------

  private bindingRow(installationId: string, bindingId: string): BindingRow | undefined {
    return this.db.prepare(
      `SELECT * FROM credential_bindings WHERE installation_id = ? AND binding_id = ?`,
    ).get(installationId, bindingId) as BindingRow | undefined;
  }

  private upsertBindingRow(installationId: string, binding: CredentialBindingMetadata, now: number): void {
    this.db.prepare(
      `INSERT INTO credential_bindings (
         installation_id, binding_id, label, provider, state, generation,
         capability_ids_json, risk, mfa_mode, approval_mode, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (installation_id, binding_id) DO UPDATE SET
         label = excluded.label,
         state = excluded.state,
         generation = excluded.generation,
         capability_ids_json = excluded.capability_ids_json,
         risk = excluded.risk,
         mfa_mode = excluded.mfa_mode,
         approval_mode = excluded.approval_mode,
         last_verified_at = excluded.last_verified_at,
         updated_at = excluded.updated_at`,
    ).run(
      installationId,
      binding.bindingId,
      binding.label,
      binding.provider,
      binding.state,
      binding.generation,
      JSON.stringify(binding.capabilityIds),
      binding.risk,
      binding.mfaMode,
      binding.approvalMode,
      binding.lastVerifiedAt,
      now,
      now,
    );
  }

  private advanceBindingAfterVerification(
    installationId: string,
    bindingId: string,
    generation: number,
    now: number,
  ): void {
    this.db.prepare(
      `UPDATE credential_bindings
          SET state = 'vault_verified', last_verified_at = ?, updated_at = ?
        WHERE installation_id = ? AND binding_id = ? AND generation = ?
          AND state IN ('pending', 'vault_verified', 'degraded')`,
    ).run(now, now, installationId, bindingId, generation);
  }

  /**
   * A deterministic invalid resolve leaves a `pending` binding where it is —
   * it was never proven — but demotes an already-`vault_verified` one to
   * `degraded`, so "never proven" stays distinguishable from "proven, then
   * broken". `active`, `revoked`, and `compromised` bindings are untouched by
   * a mere vault-resolution result.
   */
  private demoteBindingAfterInvalidVerification(
    installationId: string,
    bindingId: string,
    generation: number,
    now: number,
  ): void {
    this.db.prepare(
      `UPDATE credential_bindings
          SET state = 'degraded', updated_at = ?
        WHERE installation_id = ? AND binding_id = ? AND generation = ?
          AND state = 'vault_verified'`,
    ).run(now, installationId, bindingId, generation);
  }

  private upsertHealthRow(input: CredentialHealthReconcileInput): void {
    this.db.prepare(
      `INSERT INTO credential_health (
         installation_id, broker_version, adapter, adapter_state, audit_writable,
         binding_count, topology_receipt_digest, topology_receipt_expires_at,
         response_sha256, last_attempt_at, last_success_at, last_failure_at, last_failure_class, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT (installation_id) DO UPDATE SET
         broker_version = excluded.broker_version,
         adapter = excluded.adapter,
         adapter_state = excluded.adapter_state,
         audit_writable = excluded.audit_writable,
         binding_count = excluded.binding_count,
         topology_receipt_digest = excluded.topology_receipt_digest,
         topology_receipt_expires_at = excluded.topology_receipt_expires_at,
         response_sha256 = excluded.response_sha256,
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = excluded.last_success_at,
         updated_at = excluded.updated_at`,
    ).run(
      input.installationId,
      input.health.brokerVersion,
      input.health.adapter,
      input.health.adapterState,
      input.health.auditWritable ? 1 : 0,
      input.health.bindingCount,
      input.health.topologyReceiptDigest,
      input.health.topologyReceiptExpiresAt,
      input.responseSha256,
      input.now,
      input.now,
      input.now,
    );
  }

  private healthRow(installationId: string): HealthRow | undefined {
    return this.db.prepare(
      `SELECT * FROM credential_health WHERE installation_id = ?`,
    ).get(installationId) as HealthRow | undefined;
  }

  // --- private: operations ----------------------------------------------------

  private operationByRequestId(installationId: string, requestId: string): OperationRow | undefined {
    return this.db.prepare(
      `SELECT * FROM credential_operations WHERE installation_id = ? AND request_id = ?`,
    ).get(installationId, requestId) as OperationRow | undefined;
  }

  private operationByIdempotencyKey(installationId: string, idempotencyKey: string): OperationRow | undefined {
    return this.db.prepare(
      `SELECT * FROM credential_operations WHERE installation_id = ? AND idempotency_key = ?`,
    ).get(installationId, idempotencyKey) as OperationRow | undefined;
  }

  private outstandingDiagnostic(installationId: string, excludeIdempotencyKey: string): OperationRow | undefined {
    return this.db.prepare(
      `SELECT * FROM credential_operations
        WHERE installation_id = ? AND operation = 'broker.health' AND state IN ('prepared', 'ambiguous')
          AND idempotency_key != ?
        ORDER BY id ASC LIMIT 1`,
    ).get(installationId, excludeIdempotencyKey) as OperationRow | undefined;
  }

  private outstandingVerification(
    installationId: string,
    turnId: string,
    bindingId: string | null,
    bindingGeneration: number | null,
    excludeIdempotencyKey: string,
  ): OperationRow | undefined {
    return this.db.prepare(
      `SELECT * FROM credential_operations
        WHERE installation_id = ? AND operation = 'vault.binding.verify'
          AND turn_id = ? AND binding_id = ? AND binding_generation = ?
          AND state IN ('prepared', 'ambiguous') AND idempotency_key != ?
        ORDER BY id ASC LIMIT 1`,
    ).get(installationId, turnId, bindingId, bindingGeneration, excludeIdempotencyKey) as OperationRow | undefined;
  }

  private claimOperation(
    installationId: string,
    envelope: BrokerRequestEnvelope,
    now: number,
  ): CredentialOperationClaim {
    const digest = brokerRequestDigest(envelope);
    const existing = this.operationByIdempotencyKey(installationId, envelope.idempotencyKey);
    if (existing) {
      if (existing.envelope_digest !== digest) return { outcome: "digest_mismatch" };
      return {
        outcome: existing.state as CredentialOperationState,
        operation: toOperationRecord(existing),
      } as CredentialOperationClaim;
    }
    this.db.prepare(
      `INSERT INTO credential_operations (
         installation_id, request_id, idempotency_key, nonce, operation,
         binding_id, binding_generation, turn_id, capability_id, policy_digest,
         fence_owner, fence_generation, issued_at, deadline_at, envelope_digest,
         state, response_receipt_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)`,
    ).run(
      installationId,
      envelope.requestId,
      envelope.idempotencyKey,
      envelope.nonce,
      envelope.operation,
      envelope.bindingId,
      envelope.bindingGeneration,
      envelope.turnId,
      envelope.capabilityId,
      envelope.policyDigest,
      envelope.fenceOwner,
      envelope.fenceGeneration,
      envelope.issuedAt,
      envelope.deadlineAt,
      digest,
      now,
      now,
    );
    const inserted = this.operationByIdempotencyKey(installationId, envelope.idempotencyKey);
    if (!inserted) throw new Error("Credential operation disappeared after insert");
    return { outcome: "prepared", operation: toOperationRecord(inserted) };
  }

  private completeOperation(input: CredentialOperationCompleteInput): CredentialOperationCompleteResult {
    const row = this.operationByRequestId(input.installationId, input.requestId);
    if (!row) return { outcome: "not_found" };
    if (
      row.installation_id !== input.response.installationId ||
      row.request_id !== input.response.requestId ||
      row.operation !== input.response.operation
    ) {
      return { outcome: "identity_mismatch" };
    }
    if (row.state === "completed") {
      const receipt = row.response_receipt_id
        ? this.receiptRow(input.installationId, row.response_receipt_id)
        : undefined;
      return {
        outcome: "replay",
        operation: toOperationRecord(row),
        receipt: receipt ? toReceiptRecord(receipt) : null,
      };
    }

    const receiptRow = input.response.receiptId
      ? this.insertReceiptRow(input.installationId, row, input.response, input.now)
      : undefined;
    this.db.prepare(
      `UPDATE credential_operations SET state = 'completed', response_receipt_id = ?, updated_at = ? WHERE id = ?`,
    ).run(receiptRow?.receipt_id ?? null, input.now, row.id);

    if (input.response.health) {
      this.reconcileCredentialHealth({
        installationId: input.installationId,
        health: input.response.health,
        bindings: input.response.bindings,
        responseSha256: hashResponse(input.response),
        now: input.now,
      });
    }

    return {
      outcome: "completed",
      operation: toOperationRecord({
        ...row,
        state: "completed",
        response_receipt_id: receiptRow?.receipt_id ?? null,
      }),
      receipt: receiptRow ? toReceiptRecord(receiptRow) : null,
    };
  }

  private submittedTurnFenceIsCurrent(input: ControllerLeaseFence & Readonly<{ turnId: string }>): boolean {
    const leaseCurrent = this.db.prepare(
      `SELECT 1 FROM executor_lease
        WHERE singleton = 1 AND owner_id = ? AND generation = ?
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
    ).get(input.ownerId, input.generation, input.now) !== undefined;
    if (!leaseCurrent) return false;
    return this.db.prepare(
      `SELECT 1 FROM controller_turns
        WHERE id = ? AND state = 'submitted' AND lease_owner = ? AND lease_generation = ?`,
    ).get(input.turnId, input.ownerId, input.generation) !== undefined;
  }

  // --- private: receipts -------------------------------------------------------

  private insertReceiptRow(
    installationId: string,
    operationRow: OperationRow,
    response: BrokerResponseEnvelope,
    now: number,
  ): ReceiptRow {
    const receiptId = response.receiptId;
    if (!receiptId) throw new Error("Cannot insert a credential receipt without a receipt id");
    this.db.prepare(
      `INSERT INTO credential_receipts (
         receipt_id, installation_id, request_id, idempotency_key, operation,
         turn_id, binding_id, binding_generation, outcome, result, failure_class,
         retryable, retry_after_ms, response_sha256, completed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receiptId,
      installationId,
      operationRow.request_id,
      operationRow.idempotency_key,
      response.operation,
      operationRow.turn_id,
      operationRow.binding_id,
      operationRow.binding_generation,
      response.outcome,
      response.result,
      response.failureClass,
      response.retryable ? 1 : 0,
      response.retryAfterMs,
      hashResponse(response),
      response.completedAt,
      now,
    );
    const inserted = this.receiptRow(installationId, receiptId);
    if (!inserted) throw new Error("Credential receipt disappeared after insert");
    return inserted;
  }

  private receiptRow(installationId: string, receiptId: string): ReceiptRow | undefined {
    return this.db.prepare(
      `SELECT * FROM credential_receipts WHERE installation_id = ? AND receipt_id = ?`,
    ).get(installationId, receiptId) as ReceiptRow | undefined;
  }
}

function assertHealthEnvelope(installationId: string, envelope: BrokerRequestEnvelope): void {
  if (envelope.installationId !== installationId) {
    throw new Error("Credential diagnostic envelope installation mismatch");
  }
  if (envelope.operation !== "broker.health") {
    throw new Error("Credential diagnostic envelope must be broker.health");
  }
  if (
    envelope.bindingId !== null || envelope.bindingGeneration !== null || envelope.turnId !== null ||
    envelope.fenceOwner !== null || envelope.fenceGeneration !== null
  ) {
    throw new Error("Credential diagnostic envelope must not bind a turn, binding, or fence");
  }
}

function assertVerifyEnvelope(installationId: string, turnId: string, envelope: BrokerRequestEnvelope): void {
  if (envelope.installationId !== installationId) {
    throw new Error("Credential verification envelope installation mismatch");
  }
  if (envelope.operation !== "vault.binding.verify") {
    throw new Error("Credential verification envelope must be vault.binding.verify");
  }
  if (envelope.turnId !== turnId) {
    throw new Error("Credential verification envelope turn mismatch");
  }
  if (
    envelope.bindingId === null || envelope.bindingGeneration === null ||
    envelope.fenceOwner === null || envelope.fenceGeneration === null
  ) {
    throw new Error("Credential verification envelope must bind a turn, binding, and fence");
  }
}

function hashResponse(response: BrokerResponseEnvelope): string {
  return createHash("sha256").update(canonicalBrokerJson(response), "utf8").digest("hex");
}

function toBindingMetadata(row: BindingRow): CredentialBindingMetadata {
  return Object.freeze({
    bindingId: row.binding_id,
    label: row.label,
    provider: "onepassword",
    state: row.state as BrokerBindingState,
    generation: row.generation,
    capabilityIds: Object.freeze(JSON.parse(row.capability_ids_json) as string[]),
    risk: row.risk as CredentialBindingMetadata["risk"],
    mfaMode: row.mfa_mode as CredentialBindingMetadata["mfaMode"],
    approvalMode: row.approval_mode as CredentialBindingMetadata["approvalMode"],
    lastVerifiedAt: row.last_verified_at,
  }) as CredentialBindingMetadata;
}

function toEnvelope(row: OperationRow): BrokerRequestEnvelope {
  return Object.freeze({
    schemaVersion: 1,
    installationId: row.installation_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    operation: row.operation as BrokerOperation,
    bindingId: row.binding_id,
    bindingGeneration: row.binding_generation,
    turnId: row.turn_id,
    capabilityId: row.capability_id as BrokerRequestEnvelope["capabilityId"],
    policyDigest: row.policy_digest,
    fenceOwner: row.fence_owner,
    fenceGeneration: row.fence_generation,
    issuedAt: row.issued_at,
    deadlineAt: row.deadline_at,
    nonce: row.nonce,
  }) as BrokerRequestEnvelope;
}

function toOperationRecord(row: OperationRow): CredentialOperationRecord {
  return Object.freeze({
    installationId: row.installation_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    envelope: toEnvelope(row),
    state: row.state as CredentialOperationState,
    receiptId: row.response_receipt_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toReceiptRecord(row: ReceiptRow): CredentialReceiptRecord {
  return Object.freeze({
    receiptId: row.receipt_id,
    installationId: row.installation_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    operation: row.operation as BrokerOperation,
    turnId: row.turn_id,
    bindingId: row.binding_id,
    bindingGeneration: row.binding_generation,
    outcome: row.outcome as "succeeded" | "failed",
    result: row.result as "ready" | "valid" | "invalid" | null,
    failureClass: row.failure_class as BrokerFailureClass | null,
    retryable: row.retryable === 1,
    retryAfterMs: row.retry_after_ms,
    responseSha256: row.response_sha256,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  });
}

function toHealthRecord(row: HealthRow): CredentialHealthRecord {
  return Object.freeze({
    installationId: row.installation_id,
    brokerVersion: row.broker_version,
    adapter: "onepassword",
    adapterState: row.adapter_state as BrokerAdapterState,
    auditWritable: row.audit_writable === 1,
    bindingCount: row.binding_count,
    topologyReceiptDigest: row.topology_receipt_digest,
    topologyReceiptExpiresAt: row.topology_receipt_expires_at,
    responseSha256: row.response_sha256,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastFailureClass: row.last_failure_class as BrokerFailureClass | null,
    updatedAt: row.updated_at,
  }) as CredentialHealthRecord;
}
