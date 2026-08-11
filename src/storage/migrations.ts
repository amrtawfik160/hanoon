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
  state TEXT NOT NULL CHECK (state IN ('pending_spawn', 'active', 'failed', 'revoked')),
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

export const CONTROLLER_STREAM_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN dispatch_after_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE controller_turns ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE controller_turns ADD COLUMN bb_event_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE controller_turns ADD COLUMN stream_text TEXT NOT NULL DEFAULT '';
ALTER TABLE controller_turns ADD COLUMN telegram_message_id INTEGER;
ALTER TABLE controller_turns ADD COLUMN stream_phase TEXT NOT NULL DEFAULT 'queued';
`] as const;

export const THREAD_OPERATION_MIGRATIONS = [String.raw`
CREATE TABLE thread_operations (
  id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  owner_chat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('steer_thread', 'stop_thread', 'retry_thread')),
  thread_id TEXT NOT NULL,
  operation_text TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'confirmation_sending', 'awaiting_confirmation', 'confirmed', 'executing',
    'completed', 'failed', 'expired'
  )),
  confirmation_message_id INTEGER,
  expires_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  lease_owner TEXT,
  lease_generation INTEGER,
  lease_expires_at INTEGER,
  result TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX thread_operations_pending
  ON thread_operations(state, created_at);
`] as const;

export const PIPELINE_MIGRATIONS = [String.raw`
ALTER TABLE jobs ADD COLUMN plan_cycle INTEGER NOT NULL DEFAULT 0;
CREATE TABLE pipeline_stage_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  role TEXT NOT NULL CHECK (role IN ('PLAN', 'CRITIQUE')),
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('spawning', 'running', 'completed', 'failed')),
  thread_id TEXT UNIQUE,
  environment_id TEXT,
  input_sha256 TEXT NOT NULL,
  output_text TEXT,
  output_sha256 TEXT,
  outcome_json TEXT,
  start_sha TEXT,
  end_sha TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id, role, ordinal)
);
CREATE INDEX pipeline_stage_attempts_job_role
  ON pipeline_stage_attempts(job_id, role, ordinal DESC);
CREATE TABLE worker_liveness_v2 (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  worker_kind TEXT NOT NULL CHECK (worker_kind IN ('plan', 'critique', 'implementation', 'review', 'validation', 'merge')),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('bb_thread', 'bb_terminal')),
  resource_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'stopping', 'idle', 'failed', 'unknown', 'stale')),
  source_updated_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  stale_notified_at INTEGER
);
INSERT INTO worker_liveness_v2 (
  job_id, worker_kind, resource_kind, resource_id, generation, state,
  source_updated_at, observed_at, stale_notified_at
) SELECT
  job_id, worker_kind, resource_kind, resource_id, generation, state,
  source_updated_at, observed_at, stale_notified_at
FROM worker_liveness;
DROP TABLE worker_liveness;
ALTER TABLE worker_liveness_v2 RENAME TO worker_liveness;
`] as const;

export const PIPELINE_FINAL_REVIEW_MIGRATIONS = [String.raw`
ALTER TABLE jobs ADD COLUMN documentation_thread_id TEXT;
ALTER TABLE pipeline_stage_attempts RENAME TO pipeline_stage_attempts_v1;
DROP INDEX pipeline_stage_attempts_job_role;
CREATE TABLE pipeline_stage_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  role TEXT NOT NULL CHECK (role IN (
    'PLAN', 'CRITIQUE', 'BUILD', 'TEST', 'REVIEW', 'PATCH', 'DOCS',
    'FINAL_TEST', 'FINAL_REVIEW', 'DEPLOY', 'CANARY'
  )),
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('spawning', 'running', 'completed', 'failed')),
  thread_id TEXT UNIQUE,
  environment_id TEXT,
  resource_kind TEXT CHECK (resource_kind IN ('bb_thread', 'bb_terminal')),
  resource_id TEXT,
  input_sha256 TEXT NOT NULL,
  output_text TEXT,
  output_sha256 TEXT,
  outcome_json TEXT,
  start_sha TEXT,
  end_sha TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id, role, ordinal)
);
INSERT INTO pipeline_stage_attempts (
  id, job_id, role, ordinal, state, thread_id, environment_id,
  resource_kind, resource_id,
  input_sha256, output_text, output_sha256, outcome_json, start_sha, end_sha,
  last_error, created_at, completed_at, updated_at
) SELECT
  id, job_id, role, ordinal, state, thread_id, environment_id,
  CASE WHEN thread_id IS NULL THEN NULL ELSE 'bb_thread' END, thread_id,
  input_sha256, output_text, output_sha256, outcome_json, start_sha, end_sha,
  last_error, created_at, completed_at, updated_at
FROM pipeline_stage_attempts_v1;
DROP TABLE pipeline_stage_attempts_v1;
CREATE INDEX pipeline_stage_attempts_job_role
  ON pipeline_stage_attempts(job_id, role, ordinal DESC);
CREATE TABLE worker_liveness_v3 (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  worker_kind TEXT NOT NULL CHECK (worker_kind IN ('plan', 'critique', 'implementation', 'review', 'validation', 'docs', 'merge')),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('bb_thread', 'bb_terminal')),
  resource_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'stopping', 'idle', 'failed', 'unknown', 'stale')),
  source_updated_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  stale_notified_at INTEGER
);
INSERT INTO worker_liveness_v3 SELECT * FROM worker_liveness;
DROP TABLE worker_liveness;
ALTER TABLE worker_liveness_v3 RENAME TO worker_liveness;
`] as const;

export const PRODUCTION_PIPELINE_MIGRATIONS = [String.raw`
ALTER TABLE jobs ADD COLUMN merge_message TEXT;
ALTER TABLE jobs ADD COLUMN merge_commit_sha TEXT;
ALTER TABLE jobs ADD COLUMN merged_at TEXT;
ALTER TABLE jobs ADD COLUMN deployment_summary TEXT;
ALTER TABLE jobs ADD COLUMN canary_summary TEXT;
DROP INDEX one_active_job;
CREATE UNIQUE INDEX one_active_job
  ON jobs ((1))
  WHERE state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed');
CREATE TABLE worker_liveness_v4 (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  worker_kind TEXT NOT NULL CHECK (worker_kind IN (
    'plan', 'critique', 'implementation', 'review', 'validation', 'docs', 'merge', 'deploy', 'canary'
  )),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('bb_thread', 'bb_terminal')),
  resource_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'stopping', 'idle', 'failed', 'unknown', 'stale')),
  source_updated_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  stale_notified_at INTEGER
);
INSERT INTO worker_liveness_v4 SELECT * FROM worker_liveness;
DROP TABLE worker_liveness;
ALTER TABLE worker_liveness_v4 RENAME TO worker_liveness;
`] as const;

export const MEMORY_MIGRATIONS = [String.raw`
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'decision', 'correction')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL CHECK (source IN ('owner', 'agent')),
  source_turn_id TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  superseded_by TEXT REFERENCES memories(id) DEFERRABLE INITIALLY DEFERRED,
  forgotten_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX memories_live ON memories (scope, forgotten_at, superseded_by);
CREATE UNIQUE INDEX memories_live_subject
  ON memories (scope, subject)
  WHERE forgotten_at IS NULL AND superseded_by IS NULL;
CREATE VIRTUAL TABLE memories_fts USING fts5(
  subject, body, content='memories', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, subject, body) VALUES (new.rowid, new.subject, new.body);
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, subject, body)
    VALUES ('delete', old.rowid, old.subject, old.body);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, subject, body)
    VALUES ('delete', old.rowid, old.subject, old.body);
  INSERT INTO memories_fts (rowid, subject, body) VALUES (new.rowid, new.subject, new.body);
END;
CREATE TABLE controller_digest (
  controller_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  owner_text TEXT NOT NULL,
  agent_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (controller_key, ordinal)
);
`] as const;

export const MONITOR_MIGRATIONS = [String.raw`
CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  controller_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('thread_idle', 'schedule')),
  thread_id TEXT,
  cron TEXT,
  instruction TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('armed', 'cancelled', 'done', 'failed')),
  due_at INTEGER,
  fire_count INTEGER NOT NULL DEFAULT 0,
  last_fired_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((kind = 'thread_idle' AND thread_id IS NOT NULL) OR (kind = 'schedule' AND cron IS NOT NULL))
);
CREATE INDEX monitors_armed ON monitors (state, due_at);
`] as const;

export const CONTINUITY_MIGRATIONS = [String.raw`
CREATE TABLE tool_receipts (
  turn_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_sha256 TEXT NOT NULL,
  controller_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('started', 'completed', 'failed')),
  result_text TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (turn_id, tool_name, args_sha256)
);
CREATE INDEX tool_receipts_turn ON tool_receipts (controller_key, turn_id);
CREATE TABLE controller_generations (
  id TEXT PRIMARY KEY,
  controller_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT
);
CREATE INDEX controller_generations_key ON controller_generations (controller_key, started_at);
`] as const;

export const CONTROLLER_QUESTION_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN awaiting_interaction_id TEXT;
CREATE TABLE controller_questions (
  interaction_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES controller_turns(id),
  controller_key TEXT NOT NULL REFERENCES controller_threads(controller_key),
  questions_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'delivered')),
  answers_json TEXT,
  asked_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX controller_questions_pending ON controller_questions (controller_key, state, asked_at);
`] as const;

export const THREAD_NOTICE_MIGRATIONS = [String.raw`
CREATE TABLE observed_threads (
  thread_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  last_status TEXT NOT NULL,
  notified_status TEXT,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE thread_interactions (
  interaction_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user_question', 'approval')),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'delivered')),
  answer_json TEXT,
  asked_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX thread_interactions_state ON thread_interactions (state, asked_at);
`] as const;

export const UNSUPPORTED_INTERACTION_MIGRATIONS = [String.raw`
CREATE TABLE thread_interactions_v2 (
  interaction_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user_question', 'approval', 'unsupported')),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'delivered')),
  answer_json TEXT,
  asked_at INTEGER NOT NULL,
  answered_at INTEGER
);
INSERT INTO thread_interactions_v2 SELECT * FROM thread_interactions;
DROP TABLE thread_interactions;
ALTER TABLE thread_interactions_v2 RENAME TO thread_interactions;
CREATE INDEX thread_interactions_state_v2 ON thread_interactions (state, asked_at);
`] as const;

export const NOTICE_COOLDOWN_MIGRATIONS = [String.raw`
ALTER TABLE observed_threads ADD COLUMN notified_at INTEGER;
`] as const;

export const CONTROLLER_IMAGE_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN image_file_id TEXT;
ALTER TABLE controller_turns ADD COLUMN image_file_name TEXT;
ALTER TABLE controller_turns ADD COLUMN image_mime_type TEXT;
ALTER TABLE controller_turns ADD COLUMN image_size_bytes INTEGER;
`] as const;

export const ALL_MIGRATIONS = [
  ...INITIAL_MIGRATIONS,
  ...TASK_3_MIGRATIONS,
  ...TASK_9_MIGRATIONS,
  ...CONTROLLER_MIGRATIONS,
  ...CONTROLLER_STREAM_MIGRATIONS,
  ...THREAD_OPERATION_MIGRATIONS,
  ...PIPELINE_MIGRATIONS,
  ...PIPELINE_FINAL_REVIEW_MIGRATIONS,
  ...PRODUCTION_PIPELINE_MIGRATIONS,
  ...MEMORY_MIGRATIONS,
  ...MONITOR_MIGRATIONS,
  ...CONTINUITY_MIGRATIONS,
  ...CONTROLLER_QUESTION_MIGRATIONS,
  ...THREAD_NOTICE_MIGRATIONS,
  ...UNSUPPORTED_INTERACTION_MIGRATIONS,
  ...NOTICE_COOLDOWN_MIGRATIONS,
  ...CONTROLLER_IMAGE_MIGRATIONS,
] as const;
