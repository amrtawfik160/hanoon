import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  PROTECTED_CONNECTOR_OPERATIONS,
  parseProtectedConnectorResponse,
  protectedConnectorRequestDigest,
  protectedConnectorResponseDigest,
  type ProtectedConnectorFailureClass,
  type ProtectedConnectorOperation,
  type ProtectedConnectorRequestEnvelope,
  type ProtectedConnectorResponseEnvelope,
} from "../../src/credentials/connector-protocol.js";
import {
  parseProtectedConnectorBindingProjection,
  parseProtectedConnectorTarget,
  protectedConnectorTargetDigest,
  type ProtectedConnectorBindingProjection,
  type ProtectedConnectorTarget,
} from "../../src/credentials/connector-policy.js";
import { canonicalBrokerJson, SHA256_PATTERN } from "../../src/credentials/protocol.js";
import { decryptBrokerReference, encryptBrokerReference } from "./crypto.js";
import { applyBrokerMigrations } from "./migrations.js";

type ConnectorPolicyRow = {
  installation_id: string;
  project_id: string;
  policy_digest: string;
  enabled_operations_json: string;
  created_at: number;
  updated_at: number;
};

type ConnectorBindingRow = {
  installation_id: string;
  binding_id: string;
  operation: ProtectedConnectorOperation;
  generation: number;
  state: ProtectedConnectorBindingProjection["state"];
  projection_json: string;
  target_ciphertext: string;
  target_digest: string;
  credential_reference_ciphertext: string | null;
  created_at: number;
  updated_at: number;
};

type ConnectorRequestRow = {
  installation_id: string;
  idempotency_key: string;
  request_id: string;
  nonce: string;
  request_digest: string;
  operation: ProtectedConnectorOperation;
  binding_id: string;
  binding_generation: number;
  task_id: string;
  project_id: string;
  capability_id: ProtectedConnectorRequestEnvelope["capabilityId"];
  policy_digest: string;
  fence_owner: string;
  fence_generation: number;
  certificate_fingerprint: string;
  issued_at: number;
  deadline_at: number;
  state: "claimed" | "completed" | "ambiguous";
  response_json: string | null;
  completed_receipt_id: string | null;
  started_at: number;
  completed_at: number | null;
};

export type BrokerConnectorPolicy = Readonly<{
  installationId: string;
  projectId: string;
  policyDigest: string;
  enabledOperations: readonly ProtectedConnectorOperation[];
  createdAt: number;
  updatedAt: number;
}>;

export type BrokerConnectorBinding = Readonly<{
  projection: ProtectedConnectorBindingProjection;
  targetDigest: string;
  hasCredentialReference: boolean;
  createdAt: number;
  updatedAt: number;
}>;

export type BrokerConnectorRequestClaimInput = Readonly<{
  request: ProtectedConnectorRequestEnvelope;
  certificateFingerprint: string;
  now: number;
}>;

export type BrokerConnectorRequestClaim =
  | { outcome: "claimed" }
  | { outcome: "completed"; response: ProtectedConnectorResponseEnvelope }
  | { outcome: "ambiguous" }
  | { outcome: "digest_mismatch" };

export type BrokerConnectorStoreOptions = Readonly<{
  dataKey: Uint8Array;
  clock?: () => number;
}>;

function stableError(code: string): Error {
  return new Error(code);
}

function parseOperations(value: string): readonly ProtectedConnectorOperation[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length > PROTECTED_CONNECTOR_OPERATIONS.length ||
      !parsed.every((operation) => PROTECTED_CONNECTOR_OPERATIONS.includes(operation as ProtectedConnectorOperation)) ||
      new Set(parsed).size !== parsed.length
    ) throw new Error();
    return Object.freeze([...parsed]) as readonly ProtectedConnectorOperation[];
  } catch {
    throw stableError("connector_policy_corrupt");
  }
}

function policyFromRow(row: ConnectorPolicyRow): BrokerConnectorPolicy {
  return Object.freeze({
    installationId: row.installation_id,
    projectId: row.project_id,
    policyDigest: row.policy_digest,
    enabledOperations: parseOperations(row.enabled_operations_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function projectionFromRow(row: ConnectorBindingRow): ProtectedConnectorBindingProjection {
  let value: unknown;
  try {
    value = JSON.parse(row.projection_json);
  } catch {
    throw stableError("connector_binding_corrupt");
  }
  const parsed = parseProtectedConnectorBindingProjection(value);
  if (!parsed.ok) throw stableError("connector_binding_corrupt");
  return parsed.value;
}

function bindingFromRow(row: ConnectorBindingRow): BrokerConnectorBinding {
  return Object.freeze({
    projection: projectionFromRow(row),
    targetDigest: row.target_digest,
    hasCredentialReference: row.credential_reference_ciphertext !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function targetAad(bindingId: string): string {
  return `${bindingId}:target`;
}

function credentialAad(bindingId: string): string {
  return `${bindingId}:credential`;
}

function responseForInterrupted(row: ConnectorRequestRow, receiptId: string, completedAt: number): ProtectedConnectorResponseEnvelope {
  return {
    schemaVersion: 2,
    installationId: row.installation_id,
    requestId: row.request_id,
    operation: row.operation,
    outcome: "failed",
    result: null,
    failureClass: "result_ambiguous",
    retryable: false,
    retryAfterMs: null,
    receiptId,
    completedAt,
  };
}

export class BrokerProtectedConnectorStore {
  private readonly dataKey: Uint8Array;
  private readonly clock: () => number;

  public constructor(
    private readonly db: Database.Database,
    options: BrokerConnectorStoreOptions,
  ) {
    if (options.dataKey.byteLength !== 32) throw stableError("connector_data_key_invalid");
    this.dataKey = Uint8Array.from(options.dataKey);
    this.clock = options.clock ?? Date.now;
    applyBrokerMigrations(db);
  }

  public setPolicy(input: Readonly<{
    installationId: string;
    projectId: string;
    policyDigest: string;
    enabledOperations: readonly ProtectedConnectorOperation[];
    now?: number;
  }>): BrokerConnectorPolicy {
    if (
      !SHA256_PATTERN.test(input.policyDigest) ||
      input.enabledOperations.length === 0 ||
      input.enabledOperations.length > PROTECTED_CONNECTOR_OPERATIONS.length ||
      new Set(input.enabledOperations).size !== input.enabledOperations.length ||
      !input.enabledOperations.every((operation) => PROTECTED_CONNECTOR_OPERATIONS.includes(operation))
    ) throw stableError("connector_policy_invalid");
    this.assertActiveInstallation(input.installationId);
    const now = input.now ?? this.clock();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO broker_connector_policies (
          installation_id, project_id, policy_digest, enabled_operations_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (installation_id, project_id) DO UPDATE SET
          policy_digest = excluded.policy_digest,
          enabled_operations_json = excluded.enabled_operations_json,
          updated_at = excluded.updated_at
      `).run(
        input.installationId,
        input.projectId,
        input.policyDigest,
        JSON.stringify(input.enabledOperations),
        now,
        now,
      );
      this.insertAdminEvent({
        operation: "policy.set",
        installationId: input.installationId,
        projectId: input.projectId,
        occurredAt: now,
      });
    }).immediate();
    return this.getPolicy(input.installationId, input.projectId)!;
  }

  public getPolicy(installationId: string, projectId: string): BrokerConnectorPolicy | null {
    const row = this.db.prepare(
      "SELECT * FROM broker_connector_policies WHERE installation_id = ? AND project_id = ?",
    ).get(installationId, projectId) as ConnectorPolicyRow | undefined;
    return row ? policyFromRow(row) : null;
  }

  public enrollBinding(input: Readonly<{
    projection: ProtectedConnectorBindingProjection;
    target: ProtectedConnectorTarget;
    credentialReference?: string | null;
    now?: number;
  }>): BrokerConnectorBinding {
    if (input.projection.state === "active") {
      throw stableError("connector_binding_active_requires_receipt");
    }
    const projection = parseProtectedConnectorBindingProjection(input.projection);
    const target = parseProtectedConnectorTarget(input.target);
    if (!projection.ok || !target.ok || projection.value.operation !== target.value.operation) {
      throw stableError("connector_binding_invalid");
    }
    const requiresCredential = target.value.operation !== "browser.vercel_project.inspect.v1";
    if (requiresCredential !== (typeof input.credentialReference === "string" && input.credentialReference.length > 0)) {
      throw stableError("connector_binding_invalid");
    }
    this.assertActiveInstallation(projection.value.installationId);
    const now = input.now ?? this.clock();
    const targetJson = canonicalBrokerJson(target.value);
    const targetCiphertext = encryptBrokerReference({
      reference: targetJson,
      key: this.dataKey,
      aad: {
        installationId: projection.value.installationId,
        bindingId: targetAad(projection.value.bindingId),
        generation: projection.value.generation,
      },
    });
    const credentialCiphertext = requiresCredential
      ? encryptBrokerReference({
          reference: input.credentialReference!,
          key: this.dataKey,
          aad: {
            installationId: projection.value.installationId,
            bindingId: credentialAad(projection.value.bindingId),
            generation: projection.value.generation,
          },
        })
      : null;
    const projectionJson = canonicalBrokerJson(projection.value);
    const targetDigest = protectedConnectorTargetDigest(target.value);
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO broker_connector_bindings (
          installation_id, binding_id, operation, generation, state, projection_json,
          target_ciphertext, target_digest, credential_reference_ciphertext, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projection.value.installationId,
        projection.value.bindingId,
        projection.value.operation,
        projection.value.generation,
        projection.value.state,
        projectionJson,
        targetCiphertext,
        targetDigest,
        credentialCiphertext,
        now,
        now,
      );
      this.insertAdminEvent({
        operation: "binding.enroll",
        installationId: projection.value.installationId,
        bindingId: projection.value.bindingId,
        targetDigest,
        projectionSha256: createHash("sha256").update(projectionJson, "utf8").digest("hex"),
        occurredAt: now,
      });
    }).immediate();
    return this.getBinding(projection.value.installationId, projection.value.bindingId)!;
  }

  public enrollProtectedBinding(input: Readonly<{
    projectId: string;
    policyDigest: string;
    enabledOperations: readonly ProtectedConnectorOperation[];
    projection: ProtectedConnectorBindingProjection;
    target: ProtectedConnectorTarget;
    credentialReference?: string | null;
    now?: number;
  }>): BrokerConnectorBinding {
    const policy = input;
    if (
      !SHA256_PATTERN.test(policy.policyDigest) ||
      policy.enabledOperations.length === 0 ||
      policy.enabledOperations.length > PROTECTED_CONNECTOR_OPERATIONS.length ||
      new Set(policy.enabledOperations).size !== policy.enabledOperations.length ||
      !policy.enabledOperations.every((operation) => PROTECTED_CONNECTOR_OPERATIONS.includes(operation))
    ) throw stableError("connector_policy_invalid");
    const projection = parseProtectedConnectorBindingProjection(input.projection);
    const target = parseProtectedConnectorTarget(input.target);
    if (!projection.ok || !target.ok || projection.value.operation !== target.value.operation ||
        projection.value.state === "active") {
      throw stableError("connector_binding_invalid");
    }
    const requiresCredential = target.value.operation !== "browser.vercel_project.inspect.v1";
    if (requiresCredential !== (typeof input.credentialReference === "string" && input.credentialReference.length > 0)) {
      throw stableError("connector_binding_invalid");
    }
    this.assertActiveInstallation(projection.value.installationId);
    if (!policy.enabledOperations.includes(projection.value.operation)) throw stableError("connector_policy_invalid");
    const now = input.now ?? this.clock();
    const targetJson = canonicalBrokerJson(target.value);
    const targetCiphertext = encryptBrokerReference({
      reference: targetJson,
      key: this.dataKey,
      aad: { installationId: projection.value.installationId, bindingId: targetAad(projection.value.bindingId), generation: projection.value.generation },
    });
    const credentialCiphertext = requiresCredential ? encryptBrokerReference({
      reference: input.credentialReference!,
      key: this.dataKey,
      aad: { installationId: projection.value.installationId, bindingId: credentialAad(projection.value.bindingId), generation: projection.value.generation },
    }) : null;
    const projectionJson = canonicalBrokerJson(projection.value);
    const targetDigest = protectedConnectorTargetDigest(target.value);
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO broker_connector_policies (
          installation_id, project_id, policy_digest, enabled_operations_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (installation_id, project_id) DO UPDATE SET
          policy_digest = excluded.policy_digest,
          enabled_operations_json = excluded.enabled_operations_json,
          updated_at = excluded.updated_at
      `).run(projection.value.installationId, input.projectId, policy.policyDigest, JSON.stringify(policy.enabledOperations), now, now);
      this.db.prepare(`
        INSERT INTO broker_connector_bindings (
          installation_id, binding_id, operation, generation, state, projection_json,
          target_ciphertext, target_digest, credential_reference_ciphertext, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projection.value.installationId, projection.value.bindingId, projection.value.operation,
        projection.value.generation, projection.value.state, projectionJson, targetCiphertext,
        targetDigest, credentialCiphertext, now, now,
      );
      this.insertAdminEvent({ operation: "policy.set", installationId: projection.value.installationId, projectId: input.projectId, occurredAt: now });
      this.insertAdminEvent({
        operation: "binding.enroll", installationId: projection.value.installationId,
        bindingId: projection.value.bindingId, targetDigest,
        projectionSha256: createHash("sha256").update(projectionJson, "utf8").digest("hex"), occurredAt: now,
      });
    }).immediate();
    return this.getBinding(projection.value.installationId, projection.value.bindingId)!;
  }

  public getBinding(installationId: string, bindingId: string): BrokerConnectorBinding | null {
    const row = this.bindingRow(installationId, bindingId);
    return row ? bindingFromRow(row) : null;
  }

  public resolveTarget(binding: BrokerConnectorBinding): ProtectedConnectorTarget {
    const projection = binding.projection;
    const row = this.bindingRow(projection.installationId, projection.bindingId);
    if (!row || row.generation !== projection.generation) throw stableError("connector_binding_missing");
    const json = decryptBrokerReference({
      ciphertext: row.target_ciphertext,
      key: this.dataKey,
      aad: {
        installationId: projection.installationId,
        bindingId: targetAad(projection.bindingId),
        generation: projection.generation,
      },
    });
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      throw stableError("connector_target_corrupt");
    }
    const parsed = parseProtectedConnectorTarget(value);
    if (!parsed.ok || protectedConnectorTargetDigest(parsed.value) !== row.target_digest) {
      throw stableError("connector_target_corrupt");
    }
    return parsed.value;
  }

  public resolveCredentialReference(binding: BrokerConnectorBinding): string | null {
    const projection = binding.projection;
    const row = this.bindingRow(projection.installationId, projection.bindingId);
    if (!row || row.generation !== projection.generation) throw stableError("connector_binding_missing");
    if (!row.credential_reference_ciphertext) return null;
    return decryptBrokerReference({
      ciphertext: row.credential_reference_ciphertext,
      key: this.dataKey,
      aad: {
        installationId: projection.installationId,
        bindingId: credentialAad(projection.bindingId),
        generation: projection.generation,
      },
    });
  }

  public claimRequest(input: BrokerConnectorRequestClaimInput): BrokerConnectorRequestClaim {
    const request = input.request;
    const digest = protectedConnectorRequestDigest(request);
    const existing = this.requestRow(request.installationId, request.idempotencyKey);
    if (existing) {
      if (existing.request_digest !== digest) return { outcome: "digest_mismatch" };
      if (existing.response_json) {
        const response = parseProtectedConnectorResponse(JSON.parse(existing.response_json));
        if (!response.ok) throw stableError("connector_response_corrupt");
        return { outcome: "completed", response: response.value };
      }
      return { outcome: "ambiguous" };
    }
    try {
      this.db.prepare(`
        INSERT INTO broker_connector_requests (
          installation_id, idempotency_key, request_id, nonce, request_digest,
          operation, binding_id, binding_generation, task_id, project_id,
          capability_id, policy_digest, fence_owner, fence_generation,
          certificate_fingerprint, issued_at, deadline_at, state, response_json,
          completed_receipt_id, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', NULL, NULL, ?, NULL)
      `).run(
        request.installationId,
        request.idempotencyKey,
        request.requestId,
        request.nonce,
        digest,
        request.operation,
        request.bindingId,
        request.bindingGeneration,
        request.taskId,
        request.projectId,
        request.capabilityId,
        request.policyDigest,
        request.fenceOwner,
        request.fenceGeneration,
        input.certificateFingerprint,
        request.issuedAt,
        request.deadlineAt,
        input.now,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT")) {
        return { outcome: "digest_mismatch" };
      }
      throw error;
    }
    return { outcome: "claimed" };
  }

  public fenceCurrent(input: Readonly<{
    installationId: string;
    taskId: string;
    projectId: string;
    fenceOwner: string;
    fenceGeneration: number;
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
      row.expires_at > this.clock();
  }

  public completeRequest(input: Readonly<{
    request: ProtectedConnectorRequestEnvelope;
    response: ProtectedConnectorResponseEnvelope;
    targetDigest: string | null;
    connectorVersion: string;
    now: number;
  }>): ProtectedConnectorResponseEnvelope {
    const parsed = parseProtectedConnectorResponse(input.response);
    if (
      !parsed.ok ||
      (input.targetDigest !== null && !SHA256_PATTERN.test(input.targetDigest)) ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(input.connectorVersion)
    ) {
      throw stableError("connector_response_invalid");
    }
    return this.db.transaction(() => {
      const row = this.requestRow(input.request.installationId, input.request.idempotencyKey);
      if (!row) throw stableError("connector_claim_missing");
      if (row.request_digest !== protectedConnectorRequestDigest(input.request)) {
        throw stableError("connector_request_digest_mismatch");
      }
      if (
        parsed.value.installationId !== row.installation_id ||
        parsed.value.requestId !== row.request_id ||
        parsed.value.operation !== row.operation ||
        (parsed.value.outcome === "succeeded" &&
          (input.targetDigest === null || parsed.value.completedAt > row.deadline_at))
      ) throw stableError("connector_response_identity_mismatch");
      if (row.response_json) {
        const replay = parseProtectedConnectorResponse(JSON.parse(row.response_json));
        if (!replay.ok) throw stableError("connector_response_corrupt");
        return replay.value;
      }
      const receiptId = parsed.value.receiptId;
      if (!receiptId) throw stableError("connector_receipt_missing");
      this.db.prepare(`
        INSERT INTO broker_connector_receipts (
          receipt_id, installation_id, request_id, idempotency_key, operation,
          binding_id, binding_generation, task_id, project_id, capability_id,
          policy_digest, fence_owner, fence_generation, request_digest,
          client_certificate_fingerprint, target_digest, outcome, failure_class,
          retryable, retry_after_ms, identity_json, response_sha256,
          connector_version, protocol_version, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?)
      `).run(
        receiptId,
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
        row.request_digest,
        row.certificate_fingerprint,
        input.targetDigest,
        parsed.value.outcome,
        parsed.value.failureClass,
        parsed.value.retryable ? 1 : 0,
        parsed.value.retryAfterMs,
        parsed.value.result === null ? null : canonicalBrokerJson(parsed.value.result),
        protectedConnectorResponseDigest(parsed.value),
        input.connectorVersion,
        row.started_at,
        input.now,
      );
      if (parsed.value.outcome === "succeeded") this.projectBindingActive(row, input.now);
      this.db.prepare(`
        UPDATE broker_connector_requests
           SET state = ?, response_json = ?, completed_receipt_id = ?, completed_at = ?
         WHERE installation_id = ? AND idempotency_key = ? AND response_json IS NULL
      `).run(
        parsed.value.failureClass === "result_ambiguous" ? "ambiguous" : "completed",
        JSON.stringify(parsed.value),
        receiptId,
        input.now,
        row.installation_id,
        row.idempotency_key,
      );
      return parsed.value;
    }).immediate();
  }

  /** Converts pre-restart in-flight claims into one durable ambiguous receipt. */
  public reconcileInterruptedRequests(now = this.clock()): number {
    const rows = this.db.prepare(
      "SELECT * FROM broker_connector_requests WHERE state = 'claimed' ORDER BY started_at",
    ).all() as ConnectorRequestRow[];
    let reconciled = 0;
    for (const row of rows) {
      const binding = this.getBinding(row.installation_id, row.binding_id);
      if (!binding) continue;
      const request = requestFromRow(row);
      const receiptId = `receipt_${randomUUID()}`;
      const response = responseForInterrupted(row, receiptId, now);
      this.completeRequest({
        request,
        response,
        targetDigest: binding.targetDigest,
        connectorVersion: "reconciler-1",
        now,
      });
      reconciled += 1;
    }
    return reconciled;
  }

  private assertActiveInstallation(installationId: string): void {
    const row = this.db.prepare(
      "SELECT state FROM broker_installations WHERE installation_id = ?",
    ).get(installationId) as { state: string } | undefined;
    if (!row || row.state !== "active") throw stableError("broker_installation_unavailable");
  }

  private bindingRow(installationId: string, bindingId: string): ConnectorBindingRow | undefined {
    return this.db.prepare(
      "SELECT * FROM broker_connector_bindings WHERE installation_id = ? AND binding_id = ?",
    ).get(installationId, bindingId) as ConnectorBindingRow | undefined;
  }

  private requestRow(installationId: string, idempotencyKey: string): ConnectorRequestRow | undefined {
    return this.db.prepare(
      "SELECT * FROM broker_connector_requests WHERE installation_id = ? AND idempotency_key = ?",
    ).get(installationId, idempotencyKey) as ConnectorRequestRow | undefined;
  }

  private projectBindingActive(row: ConnectorRequestRow, now: number): void {
    const bindingRow = this.bindingRow(row.installation_id, row.binding_id);
    if (!bindingRow || bindingRow.generation !== row.binding_generation) return;
    const current = projectionFromRow(bindingRow);
    if (["revoked", "compromised", "expired"].includes(current.state)) return;
    const next = parseProtectedConnectorBindingProjection({
      ...current,
      state: "active",
      verifiedAt: now,
    });
    if (!next.ok) throw stableError("connector_binding_projection_invalid");
    const projectionJson = canonicalBrokerJson(next.value);
    this.db.prepare(`
      UPDATE broker_connector_bindings
         SET state = 'active', projection_json = ?, updated_at = ?
       WHERE installation_id = ? AND binding_id = ? AND generation = ?
    `).run(projectionJson, now, row.installation_id, row.binding_id, row.binding_generation);
    this.insertAdminEvent({
      operation: "binding.project",
      installationId: row.installation_id,
      bindingId: row.binding_id,
      targetDigest: bindingRow.target_digest,
      projectionSha256: createHash("sha256").update(projectionJson, "utf8").digest("hex"),
      occurredAt: now,
    });
  }

  private insertAdminEvent(input: Readonly<{
    operation: "policy.set" | "binding.enroll" | "binding.project";
    installationId: string;
    projectId?: string;
    bindingId?: string;
    targetDigest?: string;
    projectionSha256?: string;
    occurredAt: number;
  }>): void {
    this.db.prepare(`
      INSERT INTO broker_connector_admin_events (
        event_id, operation, installation_id, project_id, binding_id,
        target_digest, projection_sha256, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.operation,
      input.installationId,
      input.projectId ?? null,
      input.bindingId ?? null,
      input.targetDigest ?? null,
      input.projectionSha256 ?? null,
      input.occurredAt,
    );
  }
}

function requestFromRow(row: ConnectorRequestRow): ProtectedConnectorRequestEnvelope {
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

export function connectorFailureResponse(input: Readonly<{
  request: ProtectedConnectorRequestEnvelope;
  failureClass: ProtectedConnectorFailureClass;
  retryable?: boolean;
  retryAfterMs?: number | null;
  receiptId: string | null;
  completedAt: number;
}>): ProtectedConnectorResponseEnvelope {
  return {
    schemaVersion: 2,
    installationId: input.request.installationId,
    requestId: input.request.requestId,
    operation: input.request.operation,
    outcome: "failed",
    result: null,
    failureClass: input.failureClass,
    retryable: input.retryable ?? false,
    retryAfterMs: input.retryAfterMs ?? null,
    receiptId: input.receiptId,
    completedAt: input.completedAt,
  };
}
