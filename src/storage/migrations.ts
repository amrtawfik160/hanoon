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

export const AUTONOMY_MIGRATIONS = [String.raw`
CREATE TABLE autonomy_sequence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_queue_seq INTEGER NOT NULL CHECK (next_queue_seq >= 1)
);

CREATE TABLE job_admissions (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  project_id TEXT NOT NULL,
  queue_seq INTEGER NOT NULL UNIQUE CHECK (queue_seq >= 1),
  state TEXT NOT NULL CHECK (state IN ('queued', 'admitted', 'draining', 'released')),
  resume_event TEXT NOT NULL CHECK (resume_event IN ('CONFIRMED', 'CONTINUE_REVIEW')),
  queued_at INTEGER NOT NULL,
  admitted_at INTEGER,
  draining_at INTEGER,
  released_at INTEGER,
  release_reason TEXT CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 160)
);

CREATE TABLE job_resource_claims (
  claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  resource_key TEXT NOT NULL CHECK (length(resource_key) BETWEEN 1 AND 384),
  resource_kind TEXT NOT NULL CHECK (
    resource_kind IN ('project', 'repository_merge', 'production_target')
  ),
  state TEXT NOT NULL CHECK (state IN ('held', 'released')),
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  lease_expires_at INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  released_at INTEGER,
  release_reason TEXT CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 160)
);

CREATE INDEX job_admissions_state_queue
  ON job_admissions(state, queue_seq, job_id);
CREATE INDEX job_admissions_project_queue
  ON job_admissions(project_id, state, queue_seq, job_id);
CREATE INDEX job_resource_claims_job
  ON job_resource_claims(job_id, claim_id);

CREATE TEMP TABLE autonomy_migration_guard (
  invariant TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO autonomy_migration_guard (invariant, valid)
SELECT 'legacy_active_job_count', CASE WHEN (
  SELECT COUNT(*) FROM jobs
   WHERE state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed')
) <= 1 THEN 1 ELSE 0 END;
INSERT INTO autonomy_migration_guard (invariant, valid)
SELECT 'selected_job_identity', CASE WHEN NOT EXISTS (
  SELECT 1 FROM jobs
   WHERE state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed')
     AND state <> 'awaiting_project'
     AND CASE
       WHEN project_id IS NULL OR policy_version IS NULL OR policy_version < 1 OR policy_json IS NULL THEN 1
       WHEN json_valid(policy_json) <> 1 THEN 1
       WHEN json_extract(policy_json, '$.projectId') IS NULL THEN 1
       WHEN json_extract(policy_json, '$.projectId') <> project_id THEN 1
       ELSE 0
     END = 1
) THEN 1 ELSE 0 END;
INSERT INTO autonomy_migration_guard (invariant, valid)
SELECT 'status_message_identity', CASE WHEN NOT EXISTS (
  SELECT status_message_id FROM jobs
   WHERE status_message_id IS NOT NULL
   GROUP BY status_message_id
  HAVING COUNT(*) > 1
) THEN 1 ELSE 0 END;

CREATE UNIQUE INDEX job_resource_claims_held_resource
  ON job_resource_claims(resource_key) WHERE state = 'held';
CREATE UNIQUE INDEX jobs_status_message_identity
  ON jobs(status_message_id) WHERE status_message_id IS NOT NULL;

INSERT INTO autonomy_sequence(singleton, next_queue_seq) VALUES (1, 1);
INSERT INTO job_admissions (
  job_id, project_id, queue_seq, state, resume_event, queued_at,
  admitted_at, draining_at, released_at, release_reason
) SELECT
  id,
  project_id,
  1,
  CASE WHEN state = 'awaiting_confirmation' THEN 'queued' ELSE 'admitted' END,
  'CONFIRMED',
  updated_at,
  CASE WHEN state = 'awaiting_confirmation' THEN NULL ELSE updated_at END,
  NULL,
  NULL,
  NULL
FROM jobs
WHERE state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed')
  AND state <> 'awaiting_project'
ORDER BY updated_at DESC, id DESC
LIMIT 1;
INSERT INTO job_resource_claims (
  job_id, resource_key, resource_kind, state, owner_id, generation,
  lease_expires_at, acquired_at, renewed_at, released_at, release_reason
) SELECT
  job_id,
  'project:' || project_id || ':pipeline',
  'project',
  'held',
  'migration-unadopted',
  0,
  0,
  admitted_at,
  admitted_at,
  NULL,
  NULL
FROM job_admissions
WHERE state = 'admitted';
UPDATE autonomy_sequence
   SET next_queue_seq = COALESCE((SELECT MAX(queue_seq) + 1 FROM job_admissions), 1)
 WHERE singleton = 1;

DROP TABLE autonomy_migration_guard;
DROP INDEX one_active_job;
`] as const;

export const CONTROLLER_IMAGE_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN image_file_id TEXT;
ALTER TABLE controller_turns ADD COLUMN image_file_name TEXT;
ALTER TABLE controller_turns ADD COLUMN image_mime_type TEXT;
ALTER TABLE controller_turns ADD COLUMN image_size_bytes INTEGER;
`] as const;

export const CONTROLLER_MOTION_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN image_kind TEXT;
ALTER TABLE controller_turns ADD COLUMN image_duration_seconds INTEGER;
ALTER TABLE controller_turns ADD COLUMN thumbnail_file_id TEXT;
ALTER TABLE controller_turns ADD COLUMN thumbnail_file_name TEXT;
ALTER TABLE controller_turns ADD COLUMN thumbnail_size_bytes INTEGER;
`] as const;

export const CONTROLLER_SUPERVISOR_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE controller_turns ADD COLUMN command_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE controller_turns ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE controller_turns ADD COLUMN supervisor_steers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE controller_turns ADD COLUMN supervisor_reasons TEXT NOT NULL DEFAULT '';
`] as const;

export const DELEGATION_MIGRATIONS = [String.raw`
CREATE TABLE delegations (
  id TEXT PRIMARY KEY,
  controller_key TEXT NOT NULL,
  instruction TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'fired', 'cancelled', 'failed')),
  fired_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX delegations_open ON delegations (state, created_at);
CREATE TABLE delegation_threads (
  delegation_id TEXT NOT NULL REFERENCES delegations(id),
  thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'finished', 'failed', 'missing')),
  summary TEXT,
  settled_at INTEGER,
  PRIMARY KEY (delegation_id, thread_id)
);
`] as const;

export const JOB_MEMORY_MIGRATIONS = [String.raw`
CREATE TABLE job_memory_extractions (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  project_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
  thread_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  saved_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX job_memory_extractions_due ON job_memory_extractions (state, created_at);
ALTER TABLE memories ADD COLUMN origin TEXT;
`] as const;

export const MEMORY_CURATION_MIGRATIONS = [String.raw`
CREATE TABLE memory_recalls (
  turn_id TEXT NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  recalled_at INTEGER NOT NULL,
  scored_at INTEGER,
  outcome TEXT CHECK (outcome IN ('reinforced', 'demoted')),
  PRIMARY KEY (turn_id, memory_id)
);
CREATE INDEX memory_recalls_unscored ON memory_recalls (scored_at, recalled_at);
ALTER TABLE memories ADD COLUMN curated_at INTEGER;
`] as const;

export const SYSTEM_MONITOR_MIGRATIONS = [String.raw`
ALTER TABLE monitors ADD COLUMN system_key TEXT;
CREATE UNIQUE INDEX monitors_system_key ON monitors (system_key) WHERE system_key IS NOT NULL;
`] as const;

export const CONTROLLER_OVERLAY_MIGRATIONS = [String.raw`
CREATE TABLE controller_overlay (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`] as const;

export const TURN_TOKEN_BASELINE_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN token_baseline INTEGER;
`] as const;

export const DELEGATION_SEAL_MIGRATIONS = [String.raw`
ALTER TABLE delegations ADD COLUMN sealed_at INTEGER;
`] as const;

export const TURN_ORIGIN_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN origin TEXT NOT NULL DEFAULT 'owner';
`] as const;

export const PRODUCTION_HEALTH_MIGRATIONS = [String.raw`
CREATE TABLE production_health (
  project_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('unknown', 'ok', 'failing')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_summary TEXT,
  last_checked_at INTEGER,
  reported_state TEXT,
  reported_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`] as const;

export const DELIVERY_MODE_MIGRATIONS = [String.raw`
ALTER TABLE jobs ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'full';
`] as const;

export const RETRY_ADMISSION_MIGRATIONS = [String.raw`
CREATE TABLE job_admissions_with_retry (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  project_id TEXT NOT NULL,
  queue_seq INTEGER NOT NULL UNIQUE CHECK (queue_seq >= 1),
  state TEXT NOT NULL CHECK (state IN ('queued', 'admitted', 'draining', 'released')),
  resume_event TEXT NOT NULL CHECK (resume_event IN ('CONFIRMED', 'CONTINUE_REVIEW', 'RETRY')),
  queued_at INTEGER NOT NULL,
  admitted_at INTEGER,
  draining_at INTEGER,
  released_at INTEGER,
  release_reason TEXT CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 160)
);
INSERT INTO job_admissions_with_retry SELECT * FROM job_admissions;
DROP TABLE job_admissions;
ALTER TABLE job_admissions_with_retry RENAME TO job_admissions;
CREATE INDEX job_admissions_state_queue
  ON job_admissions(state, queue_seq, job_id);
CREATE INDEX job_admissions_project_queue
  ON job_admissions(project_id, state, queue_seq, job_id);
`] as const;

export const WORKER_RECOVERY_MIGRATIONS = [String.raw`
CREATE TABLE worker_recoveries (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  project_id TEXT NOT NULL,
  job_state TEXT NOT NULL,
  worker_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  worker_generation INTEGER NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('never_started', 'no_progress', 'missing', 'crash')),
  signature TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('auto_retry', 'owner_required')),
  state TEXT NOT NULL CHECK (state IN ('detected', 'retiring', 'owner_required', 'requeued', 'recovered')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE(job_id, resource_id, worker_generation, signature)
);
CREATE INDEX worker_recoveries_signature
  ON worker_recoveries(project_id, worker_kind, signature, state);
CREATE INDEX worker_recoveries_job
  ON worker_recoveries(job_id, job_state, worker_kind, action, created_at);
`] as const;

export const PR_ADOPTION_MIGRATIONS = [String.raw`
ALTER TABLE jobs ADD COLUMN job_origin TEXT NOT NULL DEFAULT 'requested'
  CHECK (job_origin IN ('requested', 'adopted_pr'));
ALTER TABLE jobs ADD COLUMN adopted_branch TEXT;
ALTER TABLE jobs ADD COLUMN adopted_head_sha TEXT;
ALTER TABLE pipeline_stage_attempts RENAME TO pipeline_stage_attempts_before_adoption;
DROP INDEX pipeline_stage_attempts_job_role;
CREATE TABLE pipeline_stage_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  role TEXT NOT NULL CHECK (role IN (
    'PLAN', 'CRITIQUE', 'BUILD', 'TEST', 'REVIEW', 'PATCH', 'DOCS',
    'FINAL_TEST', 'FINAL_REVIEW', 'DEPLOY', 'CANARY'
  )),
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('spawning', 'running', 'completed', 'failed', 'skipped')),
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
INSERT INTO pipeline_stage_attempts SELECT * FROM pipeline_stage_attempts_before_adoption;
DROP TABLE pipeline_stage_attempts_before_adoption;
CREATE INDEX pipeline_stage_attempts_job_role
  ON pipeline_stage_attempts(job_id, role, ordinal DESC);
`] as const;

export const REVIEW_LENS_MIGRATIONS = [String.raw`
ALTER TABLE attempts RENAME TO attempts_before_review_lenses;
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('implementation', 'review', 'validation')),
  review_lens TEXT CHECK (review_lens IS NULL OR review_lens IN ('quality', 'risk')),
  review_stage TEXT CHECK (review_stage IS NULL OR review_stage IN ('review', 'final_review')),
  ordinal INTEGER NOT NULL,
  thread_id TEXT,
  head_sha TEXT,
  handoff_path TEXT,
  handoff_sha256 TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
INSERT INTO attempts (
  id, job_id, kind, ordinal, thread_id, head_sha, handoff_path, handoff_sha256,
  result_json, created_at, completed_at
) SELECT
  id, job_id, kind, ordinal, thread_id, head_sha, handoff_path, handoff_sha256,
  result_json, created_at, completed_at
FROM attempts_before_review_lenses;
DROP TABLE attempts_before_review_lenses;
CREATE UNIQUE INDEX attempts_non_review_ordinal
  ON attempts(job_id, kind, ordinal) WHERE kind <> 'review';
CREATE UNIQUE INDEX attempts_review_lens
  ON attempts(job_id, review_stage, ordinal, review_lens)
  WHERE kind = 'review' AND review_lens IS NOT NULL AND review_stage IS NOT NULL;
`] as const;

export const MULTI_WORKER_LIVENESS_MIGRATIONS = [String.raw`
ALTER TABLE worker_liveness RENAME TO worker_liveness_single_resource;
CREATE TABLE worker_liveness (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  worker_kind TEXT NOT NULL CHECK (worker_kind IN (
    'plan', 'critique', 'implementation', 'review', 'validation', 'docs', 'merge', 'deploy', 'canary'
  )),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('bb_thread', 'bb_terminal')),
  resource_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'stopping', 'idle', 'failed', 'unknown', 'stale')),
  source_updated_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  stale_notified_at INTEGER,
  PRIMARY KEY(job_id, resource_id)
);
INSERT INTO worker_liveness SELECT * FROM worker_liveness_single_resource;
DROP TABLE worker_liveness_single_resource;
CREATE INDEX worker_liveness_job_observed
  ON worker_liveness(job_id, observed_at DESC, resource_id);
`] as const;

export const CAPABILITY_MIGRATIONS = [String.raw`
CREATE TABLE capability_profiles (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('controller_turn', 'worker_attempt')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 256),
  thread_id TEXT CHECK (thread_id IS NULL OR length(thread_id) BETWEEN 1 AND 256),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  recipe_id TEXT NOT NULL CHECK (length(recipe_id) BETWEEN 1 AND 128),
  recipe_version INTEGER NOT NULL CHECK (recipe_version >= 1),
  registry_digest TEXT NOT NULL CHECK (length(registry_digest) = 64),
  graph_digest TEXT NOT NULL CHECK (length(graph_digest) = 64),
  mode TEXT NOT NULL CHECK (mode IN ('active', 'shadow')),
  model_pool TEXT NOT NULL CHECK (model_pool IN ('fast', 'standard', 'strong')),
  model_provider_id TEXT NOT NULL CHECK (length(model_provider_id) BETWEEN 1 AND 128),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 256),
  model_reasoning TEXT NOT NULL CHECK (length(model_reasoning) BETWEEN 1 AND 64),
  model_service_tier TEXT NOT NULL CHECK (model_service_tier IN ('default', 'fast')),
  reason_codes_json TEXT NOT NULL CHECK (length(reason_codes_json) BETWEEN 2 AND 8192),
  traits_json TEXT NOT NULL CHECK (length(traits_json) BETWEEN 2 AND 8192),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE(subject_kind, subject_id, revision)
);
CREATE INDEX capability_profiles_subject
  ON capability_profiles(subject_kind, subject_id, mode, revision DESC);
CREATE INDEX capability_profiles_thread
  ON capability_profiles(thread_id, revision DESC) WHERE thread_id IS NOT NULL;

CREATE TABLE capability_profile_assignments (
  profile_id TEXT NOT NULL REFERENCES capability_profiles(id),
  capability_id TEXT NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 128),
  capability_kind TEXT NOT NULL CHECK (capability_kind IN (
    'skill', 'tool', 'bundle', 'native-adapter', 'model', 'connector', 'recipe'
  )),
  descriptor_digest TEXT NOT NULL CHECK (length(descriptor_digest) = 64),
  mandatory INTEGER NOT NULL CHECK (mandatory IN (0, 1)),
  PRIMARY KEY(profile_id, capability_id)
);

CREATE TABLE capability_receipts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL REFERENCES capability_profiles(id),
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('controller_turn', 'worker_attempt')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 256),
  capability_id TEXT NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 128),
  capability_kind TEXT NOT NULL CHECK (capability_kind IN (
    'skill', 'tool', 'bundle', 'native-adapter', 'model', 'connector', 'recipe'
  )),
  descriptor_digest TEXT NOT NULL CHECK (length(descriptor_digest) = 64),
  event_type TEXT NOT NULL CHECK (event_type IN ('requested', 'selected', 'denied', 'outcome')),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
  mandatory INTEGER NOT NULL CHECK (mandatory IN (0, 1)),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('passed', 'findings', 'blocked', 'failed')),
  evidence_refs_json TEXT NOT NULL CHECK (length(evidence_refs_json) BETWEEN 2 AND 16384),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (
    (event_type = 'outcome' AND outcome IS NOT NULL)
    OR (event_type <> 'outcome' AND outcome IS NULL)
  )
);
CREATE UNIQUE INDEX capability_receipts_selection
  ON capability_receipts(profile_id, capability_id) WHERE event_type = 'selected';
CREATE UNIQUE INDEX capability_receipts_terminal
  ON capability_receipts(profile_id, capability_id) WHERE event_type = 'outcome';
CREATE INDEX capability_receipts_profile_sequence
  ON capability_receipts(profile_id, sequence);

CREATE TABLE capability_inventory (
  inventory_key TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 128),
  capability_kind TEXT NOT NULL CHECK (capability_kind IN (
    'skill', 'tool', 'bundle', 'native-adapter', 'model', 'connector', 'recipe'
  )),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 512),
  version TEXT CHECK (version IS NULL OR length(version) BETWEEN 1 AND 128),
  digest TEXT CHECK (digest IS NULL OR length(digest) = 64),
  host_scope TEXT NOT NULL CHECK (length(host_scope) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN ('inventory-only', 'admitted', 'disabled', 'retired')),
  metadata_json TEXT NOT NULL CHECK (length(metadata_json) BETWEEN 2 AND 16384),
  discovered_at INTEGER NOT NULL CHECK (discovered_at >= 0),
  UNIQUE(capability_id, source, host_scope)
);

CREATE TABLE capability_inventory_health (
  host_scope TEXT PRIMARY KEY CHECK (length(host_scope) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN ('ok', 'degraded')),
  error_class TEXT CHECK (error_class IS NULL OR length(error_class) BETWEEN 1 AND 128),
  refreshed_at INTEGER NOT NULL CHECK (refreshed_at >= 0),
  CHECK ((status = 'ok' AND error_class IS NULL) OR (status = 'degraded' AND error_class IS NOT NULL))
);

CREATE TABLE recipe_promotions (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('controller_turn', 'worker_attempt')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 256),
  from_recipe TEXT NOT NULL CHECK (length(from_recipe) BETWEEN 1 AND 128),
  to_recipe TEXT NOT NULL CHECK (length(to_recipe) BETWEEN 1 AND 128),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE(subject_kind, subject_id)
);

CREATE TABLE model_route_trials (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('controller_turn', 'worker_attempt')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 256),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  pool TEXT NOT NULL CHECK (pool IN ('fast', 'standard', 'strong')),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 256),
  reasoning TEXT NOT NULL CHECK (length(reasoning) BETWEEN 1 AND 64),
  service_tier TEXT NOT NULL CHECK (service_tier IN ('default', 'fast')),
  stage TEXT NOT NULL CHECK (length(stage) BETWEEN 1 AND 128),
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 128),
  failure_signature TEXT CHECK (failure_signature IS NULL OR length(failure_signature) BETWEEN 1 AND 256),
  outcome TEXT NOT NULL CHECK (outcome IN ('selected', 'passed', 'failed', 'blocked')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE(subject_kind, subject_id, attempt)
);

CREATE TABLE guard_fingerprints (
  profile_id TEXT NOT NULL REFERENCES capability_profiles(id),
  scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 256),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  capability_id TEXT NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 128),
  rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 128),
  subject_identity TEXT NOT NULL CHECK (length(subject_identity) BETWEEN 1 AND 512),
  requirement_class TEXT NOT NULL CHECK (length(requirement_class) BETWEEN 1 AND 128),
  occurrences INTEGER NOT NULL CHECK (occurrences BETWEEN 1 AND 3),
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= first_seen_at),
  PRIMARY KEY(scope_id, fingerprint)
);

CREATE VIEW skill_receipts AS
SELECT
  profile.id AS profile_id,
  profile.subject_kind,
  profile.subject_id,
  profile.revision AS profile_revision,
  assignment.capability_id,
  assignment.descriptor_digest,
  assignment.mandatory,
  outcome.outcome,
  outcome.evidence_refs_json,
  outcome.created_at AS outcome_at
FROM capability_profiles AS profile
JOIN capability_profile_assignments AS assignment
  ON assignment.profile_id = profile.id AND assignment.capability_kind = 'skill'
LEFT JOIN capability_receipts AS outcome
  ON outcome.profile_id = assignment.profile_id
 AND outcome.capability_id = assignment.capability_id
 AND outcome.event_type = 'outcome';

CREATE TRIGGER capability_profiles_append_only_update
BEFORE UPDATE ON capability_profiles
BEGIN SELECT RAISE(ABORT, 'capability_profiles are append-only'); END;
CREATE TRIGGER capability_profiles_append_only_delete
BEFORE DELETE ON capability_profiles
BEGIN SELECT RAISE(ABORT, 'capability_profiles are append-only'); END;
CREATE TRIGGER capability_assignments_append_only_update
BEFORE UPDATE ON capability_profile_assignments
BEGIN SELECT RAISE(ABORT, 'capability_profile_assignments are append-only'); END;
CREATE TRIGGER capability_assignments_append_only_delete
BEFORE DELETE ON capability_profile_assignments
BEGIN SELECT RAISE(ABORT, 'capability_profile_assignments are append-only'); END;
CREATE TRIGGER capability_receipts_append_only_update
BEFORE UPDATE ON capability_receipts
BEGIN SELECT RAISE(ABORT, 'capability_receipts are append-only'); END;
CREATE TRIGGER capability_receipts_append_only_delete
BEFORE DELETE ON capability_receipts
BEGIN SELECT RAISE(ABORT, 'capability_receipts are append-only'); END;
CREATE TRIGGER recipe_promotions_append_only_update
BEFORE UPDATE ON recipe_promotions
BEGIN SELECT RAISE(ABORT, 'recipe_promotions are append-only'); END;
CREATE TRIGGER recipe_promotions_append_only_delete
BEFORE DELETE ON recipe_promotions
BEGIN SELECT RAISE(ABORT, 'recipe_promotions are append-only'); END;
`] as const;

export const JOB_ROUTING_MIGRATIONS = [String.raw`
ALTER TABLE jobs ADD COLUMN task_recipe TEXT NOT NULL DEFAULT 'architectural'
  CHECK (task_recipe IN ('direct', 'bounded', 'bug', 'architectural', 'skill-authoring', 'adopted-pr'));
ALTER TABLE jobs ADD COLUMN recipe_version INTEGER NOT NULL DEFAULT 1 CHECK (recipe_version >= 1);
ALTER TABLE jobs ADD COLUMN recipe_promotion_count INTEGER NOT NULL DEFAULT 0
  CHECK (recipe_promotion_count BETWEEN 0 AND 2);
ALTER TABLE jobs ADD COLUMN routing_mode TEXT NOT NULL DEFAULT 'legacy'
  CHECK (routing_mode IN ('legacy', 'shadow', 'active'));
ALTER TABLE jobs ADD COLUMN task_traits_json TEXT NOT NULL DEFAULT '[]'
  CHECK (length(task_traits_json) BETWEEN 2 AND 8192);
ALTER TABLE jobs ADD COLUMN task_reason_codes_json TEXT NOT NULL DEFAULT '[]'
  CHECK (length(task_reason_codes_json) BETWEEN 2 AND 8192);
UPDATE jobs
   SET task_recipe = CASE
     WHEN job_origin = 'adopted_pr' THEN 'adopted-pr'
     WHEN delivery_mode = 'small_fix' THEN 'direct'
     ELSE 'architectural'
   END,
       task_reason_codes_json = '["legacy_projection"]';
`] as const;

export const CONTROLLER_CAPABILITY_MIGRATIONS = [String.raw`
ALTER TABLE controller_threads ADD COLUMN capability_subject_id TEXT;
ALTER TABLE controller_threads ADD COLUMN capability_profile_id TEXT
  REFERENCES capability_profiles(id);
ALTER TABLE controller_threads ADD COLUMN capability_profile_revision INTEGER NOT NULL DEFAULT 0
  CHECK (capability_profile_revision >= 0);
ALTER TABLE controller_turns ADD COLUMN capability_profile_id TEXT
  REFERENCES capability_profiles(id);
ALTER TABLE controller_turns ADD COLUMN capability_profile_revision INTEGER NOT NULL DEFAULT 0
  CHECK (capability_profile_revision >= 0);
ALTER TABLE controller_turns ADD COLUMN capability_configured_revision INTEGER NOT NULL DEFAULT 0
  CHECK (capability_configured_revision >= 0);
ALTER TABLE controller_turns ADD COLUMN capability_continuation_count INTEGER NOT NULL DEFAULT 0
  CHECK (capability_continuation_count BETWEEN 0 AND 1);
ALTER TABLE controller_turns ADD COLUMN capability_continuation_state TEXT
  CHECK (capability_continuation_state IS NULL OR capability_continuation_state IN (
    'requested', 'relaunching', 'resolved', 'blocked'
  ));
`] as const;

export const PROMOTION_EVIDENCE_MIGRATIONS = [String.raw`
ALTER TABLE model_route_trials ADD COLUMN settled_at INTEGER
  CHECK (settled_at IS NULL OR settled_at >= created_at);

CREATE TRIGGER model_route_trials_settlement_insert
BEFORE INSERT ON model_route_trials
WHEN (NEW.outcome = 'selected' AND NEW.settled_at IS NOT NULL)
  OR (NEW.outcome <> 'selected' AND NEW.settled_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'model route trial outcome requires a matching settlement timestamp'); END;
CREATE TRIGGER model_route_trials_settlement_update
BEFORE UPDATE ON model_route_trials
WHEN (NEW.outcome = 'selected' AND NEW.settled_at IS NOT NULL)
  OR (NEW.outcome <> 'selected' AND NEW.settled_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'model route trial outcome requires a matching settlement timestamp'); END;

CREATE TABLE recipe_deterministic_evidence (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  recipe TEXT NOT NULL CHECK (recipe IN (
    'direct', 'bounded', 'bug', 'architectural', 'skill-authoring', 'adopted-pr'
  )),
  category TEXT NOT NULL CHECK (category IN (
    'descriptor', 'identity', 'compatibility', 'migration',
    'receipt', 'recipe', 'approval', 'restart'
  )),
  suite_id TEXT NOT NULL CHECK (length(suite_id) BETWEEN 1 AND 256),
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 256),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed')),
  record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE(recipe, run_id)
);

CREATE TABLE recipe_classifier_evidence (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  recipe TEXT NOT NULL CHECK (recipe IN (
    'direct', 'bounded', 'bug', 'architectural', 'skill-authoring', 'adopted-pr'
  )),
  corpus_digest TEXT NOT NULL CHECK (length(corpus_digest) = 64),
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 256),
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 64),
  total INTEGER NOT NULL CHECK (total BETWEEN 1 AND 100000),
  correct INTEGER NOT NULL CHECK (correct BETWEEN 0 AND total),
  unsafe_downgrades INTEGER NOT NULL CHECK (unsafe_downgrades BETWEEN 0 AND 100000),
  record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE(recipe, run_id)
);

CREATE TABLE recipe_live_evidence (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  recipe TEXT NOT NULL CHECK (recipe IN (
    'direct', 'bounded', 'bug', 'architectural', 'skill-authoring', 'adopted-pr'
  )),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE recipe_live_evidence_receipts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  run_id TEXT NOT NULL REFERENCES recipe_live_evidence(id),
  recipe TEXT NOT NULL CHECK (recipe IN (
    'direct', 'bounded', 'bug', 'architectural', 'skill-authoring', 'adopted-pr'
  )),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  receipt_kind TEXT NOT NULL CHECK (receipt_kind IN ('induced_failure', 'recovery')),
  model_trial_id TEXT NOT NULL REFERENCES model_route_trials(id),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE(run_id, receipt_kind)
);

CREATE TABLE recipe_model_trial_evidence (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  recipe TEXT NOT NULL CHECK (recipe IN (
    'direct', 'bounded', 'bug', 'architectural', 'skill-authoring', 'adopted-pr'
  )),
  cohort TEXT NOT NULL CHECK (cohort IN ('candidate', 'baseline')),
  model_trial_id TEXT NOT NULL REFERENCES model_route_trials(id),
  harness_digest TEXT NOT NULL CHECK (length(harness_digest) = 64),
  budget_digest TEXT NOT NULL CHECK (length(budget_digest) = 64),
  record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE(recipe, cohort, model_trial_id)
);

CREATE TABLE recipe_safety_evidence (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  recipe TEXT NOT NULL CHECK (recipe IN (
    'direct', 'bounded', 'bug', 'architectural', 'skill-authoring', 'adopted-pr'
  )),
  counter TEXT NOT NULL CHECK (counter IN (
    'policy_bypasses', 'missing_mandatory_receipts', 'unsupported_success_claims',
    'stale_approvals', 'duplicate_irreversible_effects'
  )),
  counter_count INTEGER NOT NULL CHECK (counter_count >= 0),
  snapshot_id TEXT NOT NULL CHECK (length(snapshot_id) BETWEEN 1 AND 256),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE(recipe, snapshot_id)
);

CREATE TABLE recipe_promotion_evidence_manifests (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 256),
  recipe TEXT NOT NULL CHECK (recipe IN (
    'direct', 'bounded', 'bug', 'architectural', 'skill-authoring', 'adopted-pr'
  )),
  deterministic_ids_json TEXT NOT NULL CHECK (length(deterministic_ids_json) BETWEEN 2 AND 16384),
  classifier_id TEXT CHECK (classifier_id IS NULL OR length(classifier_id) BETWEEN 1 AND 256),
  live_run_ids_json TEXT NOT NULL CHECK (length(live_run_ids_json) BETWEEN 2 AND 16384),
  candidate_model_ref_ids_json TEXT NOT NULL
    CHECK (length(candidate_model_ref_ids_json) BETWEEN 2 AND 32768),
  baseline_model_ref_ids_json TEXT NOT NULL
    CHECK (length(baseline_model_ref_ids_json) BETWEEN 2 AND 32768),
  safety_ids_json TEXT NOT NULL CHECK (length(safety_ids_json) BETWEEN 2 AND 16384),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);
CREATE INDEX recipe_promotion_evidence_manifest_recipe
  ON recipe_promotion_evidence_manifests(recipe, sequence DESC);

CREATE TRIGGER recipe_deterministic_evidence_append_only_update
BEFORE UPDATE ON recipe_deterministic_evidence
BEGIN SELECT RAISE(ABORT, 'recipe_deterministic_evidence is append-only'); END;
CREATE TRIGGER recipe_deterministic_evidence_append_only_delete
BEFORE DELETE ON recipe_deterministic_evidence
BEGIN SELECT RAISE(ABORT, 'recipe_deterministic_evidence is append-only'); END;
CREATE TRIGGER recipe_classifier_evidence_append_only_update
BEFORE UPDATE ON recipe_classifier_evidence
BEGIN SELECT RAISE(ABORT, 'recipe_classifier_evidence is append-only'); END;
CREATE TRIGGER recipe_classifier_evidence_append_only_delete
BEFORE DELETE ON recipe_classifier_evidence
BEGIN SELECT RAISE(ABORT, 'recipe_classifier_evidence is append-only'); END;
CREATE TRIGGER recipe_live_evidence_append_only_update
BEFORE UPDATE ON recipe_live_evidence
BEGIN SELECT RAISE(ABORT, 'recipe_live_evidence is append-only'); END;
CREATE TRIGGER recipe_live_evidence_append_only_delete
BEFORE DELETE ON recipe_live_evidence
BEGIN SELECT RAISE(ABORT, 'recipe_live_evidence is append-only'); END;
CREATE TRIGGER recipe_live_receipts_append_only_update
BEFORE UPDATE ON recipe_live_evidence_receipts
BEGIN SELECT RAISE(ABORT, 'recipe_live_evidence_receipts are append-only'); END;
CREATE TRIGGER recipe_live_receipts_append_only_delete
BEFORE DELETE ON recipe_live_evidence_receipts
BEGIN SELECT RAISE(ABORT, 'recipe_live_evidence_receipts are append-only'); END;
CREATE TRIGGER recipe_model_trial_evidence_append_only_update
BEFORE UPDATE ON recipe_model_trial_evidence
BEGIN SELECT RAISE(ABORT, 'recipe_model_trial_evidence is append-only'); END;
CREATE TRIGGER recipe_model_trial_evidence_append_only_delete
BEFORE DELETE ON recipe_model_trial_evidence
BEGIN SELECT RAISE(ABORT, 'recipe_model_trial_evidence is append-only'); END;
CREATE TRIGGER recipe_safety_evidence_append_only_update
BEFORE UPDATE ON recipe_safety_evidence
BEGIN SELECT RAISE(ABORT, 'recipe_safety_evidence is append-only'); END;
CREATE TRIGGER recipe_safety_evidence_append_only_delete
BEFORE DELETE ON recipe_safety_evidence
BEGIN SELECT RAISE(ABORT, 'recipe_safety_evidence is append-only'); END;
CREATE TRIGGER recipe_promotion_manifests_append_only_update
BEFORE UPDATE ON recipe_promotion_evidence_manifests
BEGIN SELECT RAISE(ABORT, 'recipe_promotion_evidence_manifests are append-only'); END;
CREATE TRIGGER recipe_promotion_manifests_append_only_delete
BEFORE DELETE ON recipe_promotion_evidence_manifests
BEGIN SELECT RAISE(ABORT, 'recipe_promotion_evidence_manifests are append-only'); END;
`] as const;

export const CONTROLLER_MODEL_FALLBACK_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN model_fallback_index INTEGER NOT NULL DEFAULT 0
  CHECK (model_fallback_index BETWEEN 0 AND 2);
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
  ...AUTONOMY_MIGRATIONS,
  ...CONTROLLER_IMAGE_MIGRATIONS,
  ...CONTROLLER_SUPERVISOR_MIGRATIONS,
  ...DELEGATION_MIGRATIONS,
  ...JOB_MEMORY_MIGRATIONS,
  ...MEMORY_CURATION_MIGRATIONS,
  ...SYSTEM_MONITOR_MIGRATIONS,
  ...CONTROLLER_OVERLAY_MIGRATIONS,
  ...TURN_TOKEN_BASELINE_MIGRATIONS,
  ...DELEGATION_SEAL_MIGRATIONS,
  ...TURN_ORIGIN_MIGRATIONS,
  ...PRODUCTION_HEALTH_MIGRATIONS,
  ...RETRY_ADMISSION_MIGRATIONS,
  ...CONTROLLER_MOTION_MIGRATIONS,
  ...DELIVERY_MODE_MIGRATIONS,
  ...WORKER_RECOVERY_MIGRATIONS,
  ...PR_ADOPTION_MIGRATIONS,
  ...REVIEW_LENS_MIGRATIONS,
  ...MULTI_WORKER_LIVENESS_MIGRATIONS,
  ...CAPABILITY_MIGRATIONS,
  ...JOB_ROUTING_MIGRATIONS,
  ...CONTROLLER_CAPABILITY_MIGRATIONS,
  ...PROMOTION_EVIDENCE_MIGRATIONS,
  ...CONTROLLER_MODEL_FALLBACK_MIGRATIONS,
] as const;
