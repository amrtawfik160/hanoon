export const INITIAL_MIGRATIONS = [String.raw`
CREATE TABLE owners (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  telegram_user_id TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE telegram_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  bot_id TEXT NOT NULL,
  username TEXT NOT NULL,
  verified_at INTEGER NOT NULL
);
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TABLE project_policies (
  project_id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  policy_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  source_update_id INTEGER NOT NULL UNIQUE,
  request_text TEXT NOT NULL,
  state TEXT NOT NULL,
  resume_state TEXT,
  project_id TEXT,
  policy_version INTEGER,
  policy_json TEXT,
  environment_id TEXT,
  implementation_thread_id TEXT,
  review_thread_id TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_head_sha TEXT,
  status_message_id INTEGER,
  review_cycle INTEGER NOT NULL DEFAULT 0,
  review_block_at INTEGER NOT NULL DEFAULT 3,
  cancel_requested_at INTEGER,
  blocked_reason TEXT,
  last_error TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_active_job
  ON jobs ((1))
  WHERE state NOT IN ('merged', 'cancelled', 'blocked');
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('implementation', 'review', 'validation')),
  ordinal INTEGER NOT NULL,
  thread_id TEXT,
  head_sha TEXT,
  handoff_path TEXT,
  handoff_sha256 TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(job_id, kind, ordinal)
);
CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
  outcome TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  processed_at INTEGER
);
CREATE TABLE telegram_cursor (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_offset INTEGER NOT NULL
);
INSERT INTO telegram_cursor(singleton, next_offset) VALUES (1, 0);
CREATE TABLE callbacks (
  callback_query_id TEXT PRIMARY KEY,
  job_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
CREATE TABLE approvals (
  nonce_hash TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  head_sha TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  outcome TEXT
);
CREATE TABLE effects (
  idempotency_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'done', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_generation INTEGER,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE executor_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  heartbeat_at INTEGER,
  lease_expires_at INTEGER
);
INSERT INTO executor_lease(singleton, generation) VALUES (1, 0);
CREATE TABLE worker_liveness (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  worker_kind TEXT NOT NULL CHECK (worker_kind IN ('implementation', 'review', 'validation', 'merge')),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('bb_thread', 'bb_terminal')),
  resource_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'stopping', 'idle', 'failed', 'unknown', 'stale')),
  source_updated_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  stale_notified_at INTEGER
);
CREATE TABLE outbox (
  logical_key TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id INTEGER,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'sent', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_generation INTEGER,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`] as const;

export const TASK_3_MIGRATIONS = [String.raw`
ALTER TABLE telegram_updates ADD COLUMN claim_owner TEXT;
ALTER TABLE telegram_updates ADD COLUMN claim_generation INTEGER;
ALTER TABLE telegram_updates ADD COLUMN claim_expires_at INTEGER;
`] as const;

export const TASK_9_MIGRATIONS = [String.raw`
ALTER TABLE callbacks ADD COLUMN approval_nonce_hash TEXT;
ALTER TABLE callbacks ADD COLUMN head_sha TEXT;
ALTER TABLE callbacks ADD COLUMN effect_idempotency_key TEXT;
`] as const;

export const CONTROLLER_MIGRATIONS = [String.raw`
CREATE TABLE controller_threads (
  controller_key TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  project_id TEXT,
  host_id TEXT,
  bb_thread_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending_spawn', 'active', 'failed')),
  pending_spawn_token TEXT UNIQUE,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE controller_turns (
  id TEXT PRIMARY KEY,
  telegram_update_id INTEGER NOT NULL UNIQUE,
  controller_key TEXT NOT NULL REFERENCES controller_threads(controller_key),
  ordinal INTEGER NOT NULL,
  input_text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'dispatching', 'submitted', 'completed', 'failed')),
  lease_owner TEXT,
  lease_generation INTEGER,
  response_text TEXT,
  last_error TEXT,
  submitted_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(controller_key, ordinal)
);
CREATE UNIQUE INDEX one_controller_turn_in_flight
  ON controller_turns(controller_key)
  WHERE state IN ('dispatching', 'submitted');
`] as const;

export const ALL_MIGRATIONS = [
  ...INITIAL_MIGRATIONS,
  ...TASK_3_MIGRATIONS,
  ...TASK_9_MIGRATIONS,
  ...CONTROLLER_MIGRATIONS,
] as const;
