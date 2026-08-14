import { chmodSync } from "node:fs";
import type Database from "better-sqlite3";

const MIGRATION_VERSION = 1;

const BROKER_SCHEMA = String.raw`
CREATE TABLE IF NOT EXISTS broker_schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS broker_installations (
  installation_id TEXT PRIMARY KEY,
  client_certificate_fingerprint TEXT NOT NULL CHECK (length(client_certificate_fingerprint) = 64),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  topology_receipt_digest TEXT NOT NULL CHECK (length(topology_receipt_digest) = 64),
  topology_receipt_expires_at INTEGER NOT NULL CHECK (topology_receipt_expires_at >= 0),
  expected_vault_ciphertext TEXT NOT NULL CHECK (expected_vault_ciphertext LIKE 'v1.%'),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'compromised')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE TABLE IF NOT EXISTS broker_bindings (
  installation_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  external_reference_ciphertext TEXT CHECK (external_reference_ciphertext IS NULL OR external_reference_ciphertext LIKE 'v1.%'),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  provider TEXT NOT NULL CHECK (provider = 'onepassword'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'vault_verified', 'degraded', 'active', 'revoked', 'compromised')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  capability_ids_json TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  mfa_mode TEXT NOT NULL CHECK (mfa_mode IN ('none', 'totp', 'webauthn', 'push')),
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('none', 'owner_confirmation')),
  last_verified_at INTEGER CHECK (last_verified_at IS NULL OR last_verified_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  tombstone_at INTEGER CHECK (tombstone_at IS NULL OR tombstone_at >= 0),
  PRIMARY KEY (installation_id, binding_id),
  FOREIGN KEY (installation_id) REFERENCES broker_installations(installation_id)
);

CREATE TABLE IF NOT EXISTS broker_requests (
  installation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  operation TEXT NOT NULL CHECK (operation IN ('broker.health', 'vault.binding.verify')),
  binding_id TEXT,
  binding_generation INTEGER CHECK (binding_generation IS NULL OR binding_generation >= 0),
  turn_id TEXT,
  capability_id TEXT NOT NULL,
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  fence_owner TEXT,
  fence_generation INTEGER CHECK (fence_generation IS NULL OR fence_generation >= 0),
  certificate_fingerprint TEXT NOT NULL CHECK (length(certificate_fingerprint) = 64),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  deadline_at INTEGER NOT NULL CHECK (deadline_at >= 0),
  state TEXT NOT NULL CHECK (state IN ('claimed', 'completed', 'ambiguous')),
  response_json TEXT,
  completed_receipt_id TEXT,
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
  PRIMARY KEY (installation_id, idempotency_key),
  FOREIGN KEY (installation_id, binding_id) REFERENCES broker_bindings(installation_id, binding_id)
);

CREATE TABLE IF NOT EXISTS broker_receipts (
  receipt_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('broker.health', 'vault.binding.verify')),
  binding_id TEXT,
  binding_generation INTEGER CHECK (binding_generation IS NULL OR binding_generation >= 0),
  capability_id TEXT NOT NULL,
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  fence_owner TEXT,
  fence_generation INTEGER CHECK (fence_generation IS NULL OR fence_generation >= 0),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  client_certificate_fingerprint TEXT NOT NULL CHECK (length(client_certificate_fingerprint) = 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  result TEXT CHECK (result IS NULL OR result IN ('ready', 'valid', 'invalid')),
  failure_class TEXT,
  retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  retry_after_ms INTEGER CHECK (retry_after_ms IS NULL OR retry_after_ms >= 0),
  adapter_version TEXT NOT NULL,
  protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
  version_hmac TEXT,
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
  UNIQUE (installation_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS broker_admin_events (
  event_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('installation.add', 'installation.attest', 'installation.revoke', 'binding.add', 'binding.revoke')),
  installation_id TEXT NOT NULL,
  binding_id TEXT,
  before_topology_digest TEXT,
  after_topology_digest TEXT,
  before_topology_expires_at INTEGER,
  after_topology_expires_at INTEGER,
  before_generation INTEGER,
  after_generation INTEGER,
  before_state TEXT,
  after_state TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
);

CREATE INDEX IF NOT EXISTS broker_bindings_installation_state
  ON broker_bindings (installation_id, state);
CREATE INDEX IF NOT EXISTS broker_bindings_installation_binding_generation
  ON broker_bindings (installation_id, binding_id, generation);
CREATE UNIQUE INDEX IF NOT EXISTS broker_requests_installation_request
  ON broker_requests (installation_id, request_id);
CREATE UNIQUE INDEX IF NOT EXISTS broker_requests_installation_nonce
  ON broker_requests (installation_id, nonce);
CREATE INDEX IF NOT EXISTS broker_receipts_installation_completed
  ON broker_receipts (installation_id, completed_at);
`;

export function applyBrokerMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(BROKER_SCHEMA);
  const applied = db.prepare("SELECT 1 FROM broker_schema_migrations WHERE version = ?").get(MIGRATION_VERSION);
  if (!applied) {
    db.prepare("INSERT INTO broker_schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(MIGRATION_VERSION, Date.now());
  }
  if (db.name !== ":memory:") {
    try {
      chmodSync(db.name, 0o600);
    } catch {
      throw new Error("broker_database_permissions");
    }
  }
}

export const migrateBrokerDatabase = applyBrokerMigrations;
export const runBrokerMigrations = applyBrokerMigrations;
