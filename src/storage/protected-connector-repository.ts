import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  parseProtectedConnectorRequest,
  parseProtectedConnectorResponse,
  protectedConnectorRequestDigest,
  protectedConnectorResponseDigest,
  type ProtectedConnectorFailureClass,
  type ProtectedConnectorIdentity,
  type ProtectedConnectorOperation,
  type ProtectedConnectorRequestEnvelope,
  type ProtectedConnectorResponseEnvelope,
} from "../credentials/connector-protocol";
import {
  parseProtectedConnectorBindingProjection,
  type ConnectorBindingState,
  type ProtectedConnectorBindingProjection,
} from "../credentials/connector-policy";
import { canonicalBrokerJson } from "../credentials/protocol";

type BindingRow = {
  installation_id: string;
  binding_id: string;
  operation: ProtectedConnectorOperation;
  generation: number;
  state: ConnectorBindingState;
  projection_json: string;
  projection_sha256: string;
  verified_at: number | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

type BindingHistoryRow = {
  sequence: number;
  installation_id: string;
  binding_id: string;
  operation: ProtectedConnectorOperation;
  generation: number;
  projection_json: string;
  projection_sha256: string;
  observed_at: number;
};

type OperationRow = {
  installation_id: string;
  request_id: string;
  idempotency_key: string;
  nonce: string;
  operation: ProtectedConnectorOperation;
  binding_id: string;
  binding_generation: number;
  task_id: string;
  project_id: string;
  capability_id: ProtectedConnectorRequestEnvelope["capabilityId"];
  policy_digest: string;
  fence_owner: string;
  fence_generation: number;
  issued_at: number;
  deadline_at: number;
  request_digest: string;
  state: "prepared" | "completed" | "ambiguous";
  response_receipt_id: string | null;
  created_at: number;
  updated_at: number;
};

type ReceiptRow = {
  receipt_id: string;
  installation_id: string;
  request_id: string;
  idempotency_key: string;
  operation: ProtectedConnectorOperation;
  binding_id: string;
  binding_generation: number;
  task_id: string;
  project_id: string;
  capability_id: ProtectedConnectorRequestEnvelope["capabilityId"];
  policy_digest: string;
  fence_owner: string;
  fence_generation: number;
  outcome: "succeeded" | "failed";
  failure_class: ProtectedConnectorFailureClass | null;
  retryable: number;
  retry_after_ms: number | null;
  identity_json: string | null;
  response_sha256: string;
  completed_at: number;
  created_at: number;
};

export type ProtectedConnectorBindingHistoryRecord = Readonly<{
  sequence: number;
  projection: ProtectedConnectorBindingProjection;
  projectionSha256: string;
  observedAt: number;
}>;

export type ProtectedConnectorOperationRecord = Readonly<{
  request: ProtectedConnectorRequestEnvelope;
  state: "prepared" | "completed" | "ambiguous";
  receiptId: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export type ProtectedConnectorReceiptRecord = Readonly<{
  receiptId: string;
  installationId: string;
  requestId: string;
  idempotencyKey: string;
  operation: ProtectedConnectorOperation;
  bindingId: string;
  bindingGeneration: number;
  taskId: string;
  projectId: string;
  capabilityId: ProtectedConnectorRequestEnvelope["capabilityId"];
  policyDigest: string;
  fenceOwner: string;
  fenceGeneration: number;
  outcome: "succeeded" | "failed";
  failureClass: ProtectedConnectorFailureClass | null;
  retryable: boolean;
  retryAfterMs: number | null;
  identity: ProtectedConnectorIdentity | null;
  responseSha256: string;
  completedAt: number;
  createdAt: number;
}>;

export type ProtectedConnectorProjectionResult =
  | { outcome: "reconciled"; binding: ProtectedConnectorBindingProjection }
  | { outcome: "generation_downgrade" }
  | { outcome: "identity_mismatch" };

export type ProtectedConnectorPrepareResult =
  | { outcome: "prepared" | "completed" | "ambiguous"; operation: ProtectedConnectorOperationRecord }
  | { outcome: "digest_mismatch" | "binding_missing" | "binding_generation_stale" | "binding_inactive" };

export type ProtectedConnectorCompleteResult =
  | { outcome: "completed" | "replay"; operation: ProtectedConnectorOperationRecord; receipt: ProtectedConnectorReceiptRecord | null }
  | { outcome: "not_found" | "identity_mismatch" | "evidence_incomplete" };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseProjectionJson(value: string): ProtectedConnectorBindingProjection {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value);
  } catch {
    throw new Error("credential_connector_projection_corrupt");
  }
  const parsed = parseProtectedConnectorBindingProjection(parsedJson);
  if (!parsed.ok) throw new Error("credential_connector_projection_corrupt");
  return parsed.value;
}

function bindingCanRun(binding: ProtectedConnectorBindingProjection, now: number): boolean {
  if (binding.expiresAt !== null && now >= binding.expiresAt) return false;
  if (binding.operation === "browser.vercel_project.inspect.v1") return binding.state === "active";
  return binding.state === "vault_verified" || binding.state === "active";
}

function bindingPolicyIdentity(binding: ProtectedConnectorBindingProjection): string {
  const { state: _state, verifiedAt: _verifiedAt, expiresAt: _expiresAt, ...identity } = binding;
  return canonicalBrokerJson(identity);
}

/** Hanoon's secret-free schema-v2 projection and receipt repository. */
export class ProtectedConnectorRepository {
  public constructor(private readonly db: Database.Database) {}

  public reconcileBindingProjection(input: Readonly<{
    projection: ProtectedConnectorBindingProjection;
    now: number;
  }>): ProtectedConnectorProjectionResult {
    const parsed = parseProtectedConnectorBindingProjection(input.projection);
    if (!parsed.ok) throw new TypeError("invalid protected connector binding projection");
    const projection = parsed.value;
    const projectionJson = canonicalBrokerJson(projection);
    const projectionSha256 = sha256(projectionJson);
    return this.db.transaction((): ProtectedConnectorProjectionResult => {
      const existing = this.bindingRow(projection.installationId, projection.bindingId);
      if (existing && projection.generation < existing.generation) return { outcome: "generation_downgrade" };
      if (existing && existing.operation !== projection.operation) return { outcome: "identity_mismatch" };
      if (
        existing &&
        existing.generation === projection.generation &&
        bindingPolicyIdentity(parseProjectionJson(existing.projection_json)) !== bindingPolicyIdentity(projection)
      ) return { outcome: "identity_mismatch" };
      this.db.prepare(`
        INSERT OR IGNORE INTO credential_connector_binding_history (
          installation_id, binding_id, operation, generation,
          projection_json, projection_sha256, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        projection.installationId,
        projection.bindingId,
        projection.operation,
        projection.generation,
        projectionJson,
        projectionSha256,
        input.now,
      );
      this.db.prepare(`
        INSERT INTO credential_connector_bindings (
          installation_id, binding_id, operation, generation, state,
          projection_json, projection_sha256, verified_at, expires_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (installation_id, binding_id) DO UPDATE SET
          generation = excluded.generation,
          state = excluded.state,
          projection_json = excluded.projection_json,
          projection_sha256 = excluded.projection_sha256,
          verified_at = excluded.verified_at,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `).run(
        projection.installationId,
        projection.bindingId,
        projection.operation,
        projection.generation,
        projection.state,
        projectionJson,
        projectionSha256,
        projection.verifiedAt,
        projection.expiresAt,
        input.now,
        input.now,
      );
      return { outcome: "reconciled", binding: projection };
    }).immediate();
  }

  public getBinding(installationId: string, bindingId: string): ProtectedConnectorBindingProjection | null {
    const row = this.bindingRow(installationId, bindingId);
    return row ? parseProjectionJson(row.projection_json) : null;
  }

  public listBindings(input: Readonly<{
    installationId: string;
    operation?: ProtectedConnectorOperation;
    limit: number;
  }>): readonly ProtectedConnectorBindingProjection[] {
    const rows = this.db.prepare(`
      SELECT * FROM credential_connector_bindings
       WHERE installation_id = ? AND (? IS NULL OR operation = ?)
       ORDER BY binding_id ASC LIMIT ?
    `).all(
      input.installationId,
      input.operation ?? null,
      input.operation ?? null,
      input.limit,
    ) as BindingRow[];
    return Object.freeze(rows.map((row) => parseProjectionJson(row.projection_json)));
  }

  public listBindingHistory(installationId: string, bindingId: string): readonly ProtectedConnectorBindingHistoryRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM credential_connector_binding_history
       WHERE installation_id = ? AND binding_id = ? ORDER BY sequence ASC
    `).all(installationId, bindingId) as BindingHistoryRow[];
    return Object.freeze(rows.map((row) => Object.freeze({
      sequence: row.sequence,
      projection: parseProjectionJson(row.projection_json),
      projectionSha256: row.projection_sha256,
      observedAt: row.observed_at,
    })));
  }

  public prepareOperation(input: Readonly<{
    request: ProtectedConnectorRequestEnvelope;
    now: number;
  }>): ProtectedConnectorPrepareResult {
    const parsed = parseProtectedConnectorRequest(input.request);
    if (!parsed.ok) throw new TypeError("invalid protected connector request");
    const request = parsed.value;
    return this.db.transaction((): ProtectedConnectorPrepareResult => {
      const binding = this.getBinding(request.installationId, request.bindingId);
      if (!binding) return { outcome: "binding_missing" };
      if (binding.generation !== request.bindingGeneration) return { outcome: "binding_generation_stale" };
      if (binding.operation !== request.operation || !bindingCanRun(binding, input.now)) {
        return { outcome: "binding_inactive" };
      }
      const digest = protectedConnectorRequestDigest(request);
      const existing = this.operationByIdempotency(request.installationId, request.idempotencyKey);
      if (existing) {
        if (existing.request_digest !== digest) return { outcome: "digest_mismatch" };
        return {
          outcome: existing.state,
          operation: operationFromRow(existing),
        };
      }
      try {
        this.db.prepare(`
          INSERT INTO credential_connector_operations (
            installation_id, request_id, idempotency_key, nonce, operation,
            binding_id, binding_generation, task_id, project_id, capability_id,
            policy_digest, fence_owner, fence_generation, issued_at, deadline_at,
            request_digest, state, response_receipt_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)
        `).run(
          request.installationId,
          request.requestId,
          request.idempotencyKey,
          request.nonce,
          request.operation,
          request.bindingId,
          request.bindingGeneration,
          request.taskId,
          request.projectId,
          request.capabilityId,
          request.policyDigest,
          request.fenceOwner,
          request.fenceGeneration,
          request.issuedAt,
          request.deadlineAt,
          digest,
          input.now,
          input.now,
        );
      } catch (error) {
        if (error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT")) {
          return { outcome: "digest_mismatch" };
        }
        throw error;
      }
      const inserted = this.operationByIdempotency(request.installationId, request.idempotencyKey);
      if (!inserted) throw new Error("credential connector operation disappeared after insert");
      return { outcome: "prepared", operation: operationFromRow(inserted) };
    }).immediate();
  }

  public completeOperation(input: Readonly<{
    installationId: string;
    requestId: string;
    response: ProtectedConnectorResponseEnvelope;
    now: number;
  }>): ProtectedConnectorCompleteResult {
    const parsed = parseProtectedConnectorResponse(input.response);
    if (!parsed.ok) return { outcome: "evidence_incomplete" };
    return this.db.transaction((): ProtectedConnectorCompleteResult => {
      const row = this.operationByRequestId(input.installationId, input.requestId);
      if (!row) return { outcome: "not_found" };
      const response = parsed.value;
      if (
        row.installation_id !== response.installationId ||
        row.request_id !== response.requestId ||
        row.operation !== response.operation
      ) return { outcome: "identity_mismatch" };
      if (response.outcome === "succeeded" && response.completedAt > row.deadline_at) {
        return { outcome: "evidence_incomplete" };
      }
      if (row.state === "completed") {
        return {
          outcome: "replay",
          operation: operationFromRow(row),
          receipt: row.response_receipt_id ? this.getReceipt(input.installationId, row.response_receipt_id) : null,
        };
      }

      let receipt: ProtectedConnectorReceiptRecord | null = null;
      if (response.receiptId) {
        this.insertReceipt(row, response, input.now);
        receipt = this.getReceipt(input.installationId, response.receiptId);
        if (!receipt) throw new Error("credential connector receipt disappeared after insert");
      }
      this.db.prepare(`
        UPDATE credential_connector_operations
           SET state = 'completed', response_receipt_id = ?, updated_at = ?
         WHERE installation_id = ? AND request_id = ?
      `).run(response.receiptId, input.now, input.installationId, input.requestId);
      if (response.outcome === "succeeded") this.projectBindingActive(row, response.completedAt);
      const updated = this.operationByRequestId(input.installationId, input.requestId)!;
      return { outcome: "completed", operation: operationFromRow(updated), receipt };
    }).immediate();
  }

  public markOperationAmbiguous(input: Readonly<{
    installationId: string;
    requestId: string;
    now: number;
  }>): ProtectedConnectorOperationRecord | null {
    const row = this.operationByRequestId(input.installationId, input.requestId);
    if (!row) return null;
    if (row.state === "prepared") {
      this.db.prepare(`
        UPDATE credential_connector_operations SET state = 'ambiguous', updated_at = ?
         WHERE installation_id = ? AND request_id = ? AND state = 'prepared'
      `).run(input.now, input.installationId, input.requestId);
    }
    return operationFromRow(this.operationByRequestId(input.installationId, input.requestId)!);
  }

  public getReceipt(installationId: string, receiptId: string): ProtectedConnectorReceiptRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM credential_connector_receipts
       WHERE installation_id = ? AND receipt_id = ?
    `).get(installationId, receiptId) as ReceiptRow | undefined;
    return row ? receiptFromRow(row) : null;
  }

  private bindingRow(installationId: string, bindingId: string): BindingRow | undefined {
    return this.db.prepare(`
      SELECT * FROM credential_connector_bindings WHERE installation_id = ? AND binding_id = ?
    `).get(installationId, bindingId) as BindingRow | undefined;
  }

  private operationByIdempotency(installationId: string, idempotencyKey: string): OperationRow | undefined {
    return this.db.prepare(`
      SELECT * FROM credential_connector_operations WHERE installation_id = ? AND idempotency_key = ?
    `).get(installationId, idempotencyKey) as OperationRow | undefined;
  }

  private operationByRequestId(installationId: string, requestId: string): OperationRow | undefined {
    return this.db.prepare(`
      SELECT * FROM credential_connector_operations WHERE installation_id = ? AND request_id = ?
    `).get(installationId, requestId) as OperationRow | undefined;
  }

  private insertReceipt(row: OperationRow, response: ProtectedConnectorResponseEnvelope, now: number): void {
    this.db.prepare(`
      INSERT INTO credential_connector_receipts (
        receipt_id, installation_id, request_id, idempotency_key, operation,
        binding_id, binding_generation, task_id, project_id, capability_id,
        policy_digest, fence_owner, fence_generation, outcome, failure_class,
        retryable, retry_after_ms, identity_json, response_sha256, completed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      response.receiptId,
      row.installation_id,
      row.request_id,
      row.idempotency_key,
      row.operation,
      row.binding_id,
      row.binding_generation,
      row.task_id,
      row.project_id,
      row.capability_id,
      row.policy_digest,
      row.fence_owner,
      row.fence_generation,
      response.outcome,
      response.failureClass,
      response.retryable ? 1 : 0,
      response.retryAfterMs,
      response.result === null ? null : canonicalBrokerJson(response.result),
      protectedConnectorResponseDigest(response),
      response.completedAt,
      now,
    );
  }

  private projectBindingActive(row: OperationRow, now: number): void {
    const current = this.getBinding(row.installation_id, row.binding_id);
    if (!current || current.generation !== row.binding_generation) return;
    const next = parseProtectedConnectorBindingProjection({ ...current, state: "active", verifiedAt: now });
    if (!next.ok) throw new Error("credential connector active projection invalid");
    this.reconcileBindingProjection({ projection: next.value, now });
  }
}

function requestFromOperationRow(row: OperationRow): ProtectedConnectorRequestEnvelope {
  return Object.freeze({
    schemaVersion: 2,
    installationId: row.installation_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    nonce: row.nonce,
    operation: row.operation,
    bindingId: row.binding_id,
    bindingGeneration: row.binding_generation,
    taskId: row.task_id,
    projectId: row.project_id,
    capabilityId: row.capability_id,
    policyDigest: row.policy_digest,
    fenceOwner: row.fence_owner,
    fenceGeneration: row.fence_generation,
    issuedAt: row.issued_at,
    deadlineAt: row.deadline_at,
  }) as ProtectedConnectorRequestEnvelope;
}

function operationFromRow(row: OperationRow): ProtectedConnectorOperationRecord {
  return Object.freeze({
    request: requestFromOperationRow(row),
    state: row.state,
    receiptId: row.response_receipt_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function receiptFromRow(row: ReceiptRow): ProtectedConnectorReceiptRecord {
  let identity: ProtectedConnectorIdentity | null = null;
  if (row.identity_json !== null) {
    const response = parseProtectedConnectorResponse({
      schemaVersion: 2,
      installationId: row.installation_id,
      requestId: row.request_id,
      operation: row.operation,
      outcome: "succeeded",
      result: JSON.parse(row.identity_json),
      failureClass: null,
      retryable: false,
      retryAfterMs: null,
      receiptId: row.receipt_id,
      completedAt: row.completed_at,
    });
    if (!response.ok || response.value.outcome !== "succeeded") {
      throw new Error("credential connector receipt corrupt");
    }
    identity = response.value.result;
  }
  return Object.freeze({
    receiptId: row.receipt_id,
    installationId: row.installation_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    operation: row.operation,
    bindingId: row.binding_id,
    bindingGeneration: row.binding_generation,
    taskId: row.task_id,
    projectId: row.project_id,
    capabilityId: row.capability_id,
    policyDigest: row.policy_digest,
    fenceOwner: row.fence_owner,
    fenceGeneration: row.fence_generation,
    outcome: row.outcome,
    failureClass: row.failure_class,
    retryable: row.retryable === 1,
    retryAfterMs: row.retry_after_ms,
    identity,
    responseSha256: row.response_sha256,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  });
}
