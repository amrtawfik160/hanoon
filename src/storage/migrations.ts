import { WORK_ARTIFACT_RELATIONSHIP_VALIDATOR_FUNCTION } from "../work-artifacts/models";

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

export const UPDATE_CLAIM_MIGRATIONS = [String.raw`
ALTER TABLE telegram_updates ADD COLUMN claim_owner TEXT;
ALTER TABLE telegram_updates ADD COLUMN claim_generation INTEGER;
ALTER TABLE telegram_updates ADD COLUMN claim_expires_at INTEGER;
`] as const;

export const APPROVAL_BINDING_MIGRATIONS = [String.raw`
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

export const CONTROLLER_TRUST_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN evidence_event_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE controller_turns ADD COLUMN completion_continuations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE controller_turns ADD COLUMN accepted_finalization_id INTEGER;
ALTER TABLE controller_turns ADD COLUMN evidence_limit_exceeded_at INTEGER;

CREATE TABLE controller_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL REFERENCES controller_turns(id),
  controller_key TEXT NOT NULL REFERENCES controller_threads(controller_key),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('hanoon_tool', 'bb_item')),
  source_name TEXT NOT NULL,
  source_item_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('observed', 'succeeded', 'failed', 'interrupted', 'denied')),
  args_sha256 TEXT NOT NULL,
  result_sha256 TEXT NOT NULL,
  proof_kinds_json TEXT NOT NULL,
  subject_refs_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX controller_evidence_native_item
  ON controller_evidence(turn_id, source_kind, source_item_id)
  WHERE source_kind = 'bb_item' AND source_item_id IS NOT NULL;
CREATE INDEX controller_evidence_turn_id ON controller_evidence(turn_id, id);

CREATE TABLE controller_finalizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL REFERENCES controller_turns(id),
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  rendered_message TEXT NOT NULL,
  evidence_high_water_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'rejected')),
  rejection_code TEXT,
  created_at INTEGER NOT NULL,
  validated_at INTEGER NOT NULL,
  consumed_at INTEGER,
  UNIQUE(turn_id, revision),
  CHECK (
    (state = 'accepted' AND rejection_code IS NULL) OR
    (state = 'rejected' AND rejection_code IS NOT NULL)
  )
);
CREATE UNIQUE INDEX one_accepted_controller_finalization
  ON controller_finalizations(turn_id) WHERE state = 'accepted';
CREATE INDEX controller_finalizations_turn
  ON controller_finalizations(turn_id, revision);
`] as const;

export const CONTROLLER_INTERACTION_MIGRATIONS = [String.raw`
CREATE TABLE controller_interactions (
  interaction_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES controller_turns(id),
  controller_key TEXT NOT NULL REFERENCES controller_threads(controller_key),
  bb_thread_id TEXT,
  controller_generation_id TEXT REFERENCES controller_generations(id),
  kind TEXT NOT NULL CHECK (kind IN ('user_question', 'approval', 'unsupported')),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'delivered')),
  answer_json TEXT,
  asked_at INTEGER NOT NULL,
  answered_at INTEGER,
  delivered_at INTEGER,
  CHECK (state = 'delivered' OR
    (bb_thread_id IS NOT NULL AND controller_generation_id IS NOT NULL))
);
CREATE INDEX controller_interactions_state
  ON controller_interactions(controller_key, state, asked_at, interaction_id);

CREATE TEMP TABLE controller_interaction_migration_guard (
  invariant TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO controller_interaction_migration_guard (invariant, valid)
SELECT 'legacy_active_source_identity', CASE WHEN NOT EXISTS (
  SELECT 1
    FROM controller_questions AS question
    JOIN controller_turns AS turn ON turn.id = question.turn_id
   WHERE question.state IN ('pending', 'answered')
     AND (
       turn.controller_key <> question.controller_key
       OR
       turn.state <> 'submitted'
       OR (
         SELECT COUNT(*)
           FROM controller_threads AS current_thread
          WHERE current_thread.controller_key = question.controller_key
            AND current_thread.state = 'active'
            AND current_thread.bb_thread_id IS NOT NULL
       ) <> 1
       OR (
         SELECT COUNT(*)
           FROM controller_generations AS open_generation
          WHERE open_generation.controller_key = question.controller_key
            AND open_generation.ended_at IS NULL
       ) <> 1
       OR NOT EXISTS (
         SELECT 1
           FROM controller_threads AS current_thread
           JOIN controller_generations AS open_generation
             ON open_generation.controller_key = current_thread.controller_key
            AND open_generation.thread_id = current_thread.bb_thread_id
            AND open_generation.ended_at IS NULL
          WHERE current_thread.controller_key = question.controller_key
            AND current_thread.state = 'active'
            AND current_thread.bb_thread_id IS NOT NULL
       )
     )
) THEN 1 ELSE 0 END;

INSERT INTO controller_interaction_migration_guard (invariant, valid)
SELECT 'legacy_projection_schema', CASE WHEN NOT EXISTS (
  SELECT 1
    FROM controller_questions AS question
   WHERE question.state IN ('pending', 'answered')
     AND (
       json_valid(question.questions_json) <> 1
       OR json_type(question.questions_json) <> 'array'
       OR json_array_length(question.questions_json) NOT BETWEEN 1 AND 4
       OR typeof(question.asked_at) <> 'integer'
       OR (question.state = 'answered' AND (question.answered_at IS NULL OR typeof(question.answered_at) <> 'integer'))
       OR EXISTS (
         SELECT 1 FROM json_each(question.questions_json) AS question_item
          WHERE json_type(question_item.value) <> 'object'
             OR COALESCE(json_type(question_item.value, '$.id'), '') <> 'text'
             OR COALESCE(json_type(question_item.value, '$.prompt'), '') <> 'text'
             OR COALESCE(json_type(question_item.value, '$.options'), '') <> 'array'
             OR json_array_length(json_extract(question_item.value, '$.options')) > 6
             OR (
               json_type(question_item.value, '$.shortLabel') IS NOT NULL
               AND json_type(question_item.value, '$.shortLabel') NOT IN ('null', 'text')
             )
             OR (
               json_type(question_item.value, '$.multiSelect') IS NOT NULL
               AND json_type(question_item.value, '$.multiSelect') NOT IN ('true', 'false')
             )
             OR (
               json_type(question_item.value, '$.allowFreeText') IS NOT NULL
               AND json_type(question_item.value, '$.allowFreeText') NOT IN ('true', 'false')
             )
             OR EXISTS (
               SELECT 1
                 FROM json_each(question_item.value) AS question_field
                GROUP BY question_field.key
               HAVING COUNT(*) > 1
             )
             OR EXISTS (
               SELECT 1
                 FROM json_each(json(json_extract(question_item.value, '$.options'))) AS option
                WHERE json_type(option.value) <> 'object'
                   OR COALESCE(json_type(option.value, '$.value'), '') <> 'text'
                   OR COALESCE(json_type(option.value, '$.label'), '') <> 'text'
                   OR (
                     json_type(option.value, '$.description') IS NOT NULL
                     AND json_type(option.value, '$.description') NOT IN ('null', 'text')
                   )
                   OR EXISTS (
                     SELECT 1
                       FROM json_each(option.value) AS option_field
                      GROUP BY option_field.key
                     HAVING COUNT(*) > 1
                   )
             )
             OR EXISTS (
               SELECT 1
                 FROM json_each(json(json_extract(question_item.value, '$.options'))) AS option
                GROUP BY json_extract(option.value, '$.value')
               HAVING COUNT(*) > 1
             )
       )
       OR (
         SELECT COUNT(*) FROM json_each(question.questions_json)
       ) <> (
         SELECT COUNT(DISTINCT json_extract(question_item.value, '$.id'))
           FROM json_each(question.questions_json) AS question_item
       )
       OR question.state = 'answered' AND question.answers_json IS NULL
       OR (
         question.answers_json IS NOT NULL
         AND (
           json_valid(question.answers_json) <> 1
           OR json_type(question.answers_json) <> 'object'
           OR EXISTS (
             SELECT 1
               FROM json_each(question.answers_json) AS answer_key
              GROUP BY answer_key.key
             HAVING COUNT(*) > 1
           )
           OR EXISTS (
             SELECT 1
               FROM json_each(question.answers_json) AS answer
              WHERE json_type(answer.value) <> 'object'
                 OR COALESCE(json_type(answer.value, '$.selected'), '') <> 'array'
                 OR EXISTS (
                   SELECT 1 FROM json_each(answer.value) AS answer_field
                    WHERE answer_field.key NOT IN ('selected', 'freeText')
                 )
                 OR EXISTS (
                   SELECT 1
                     FROM json_each(answer.value) AS answer_field
                    GROUP BY answer_field.key
                   HAVING COUNT(*) > 1
                 )
                 OR EXISTS (
                   SELECT 1
                     FROM json_each(json(json_extract(answer.value, '$.selected'))) AS selected
                    WHERE selected.type <> 'text'
                 )
                 OR EXISTS (
                   SELECT selected.value
                     FROM json_each(json(json_extract(answer.value, '$.selected'))) AS selected
                    GROUP BY selected.value
                   HAVING COUNT(*) > 1
                 )
                 OR (
                   EXISTS (
                     SELECT 1 FROM json_each(answer.value) AS answer_field
                      WHERE answer_field.key = 'freeText'
                   )
                   AND COALESCE(json_type(answer.value, '$.freeText'), '') <> 'text'
                 )
           )
         )
       )
     )
) THEN 1 ELSE 0 END;

INSERT INTO controller_interactions (
  interaction_id, turn_id, controller_key, bb_thread_id, controller_generation_id,
  kind, payload_json, state, answer_json, asked_at, answered_at, delivered_at
)
SELECT
  question.interaction_id,
  question.turn_id,
  question.controller_key,
  CASE WHEN question.state = 'delivered' THEN NULL ELSE current_thread.bb_thread_id END,
  CASE WHEN question.state = 'delivered' THEN NULL ELSE open_generation.id END,
  'user_question',
  json_object(
    'kind', 'user_question',
    'interactionId', question.interaction_id,
    'questions', json(question.questions_json)
  ),
  question.state,
  CASE WHEN question.state IN ('pending', 'answered') THEN question.answers_json ELSE NULL END,
  question.asked_at,
  question.answered_at,
  CASE WHEN question.state = 'delivered' THEN COALESCE(question.answered_at, question.asked_at) ELSE NULL END
FROM controller_questions AS question
LEFT JOIN controller_threads AS current_thread
  ON question.state <> 'delivered'
 AND current_thread.controller_key = question.controller_key
 AND current_thread.state = 'active'
 AND current_thread.bb_thread_id IS NOT NULL
LEFT JOIN controller_generations AS open_generation
  ON question.state <> 'delivered'
 AND open_generation.controller_key = question.controller_key
 AND open_generation.thread_id = current_thread.bb_thread_id
 AND open_generation.ended_at IS NULL;

UPDATE controller_turns AS turn
   SET awaiting_interaction_id = (
     SELECT interaction.interaction_id
       FROM controller_interactions AS interaction
      WHERE interaction.turn_id = turn.id
        AND interaction.state IN ('pending', 'answered')
      ORDER BY interaction.asked_at ASC, interaction.interaction_id ASC
      LIMIT 1
   )
 WHERE EXISTS (
   SELECT 1
     FROM controller_interactions AS interaction
    WHERE interaction.turn_id = turn.id
      AND interaction.state IN ('pending', 'answered')
 );
DROP TABLE controller_interaction_migration_guard;
`] as const;

/**
 * A standing merge grant lets one project merge and deploy without asking the
 * owner each time. Current state lives in one row per project; every grant and
 * revocation is also appended to the log, because after a bad deploy the first
 * question is who authorised unattended merging and when.
 */
export const MERGE_AUTHORITY_MIGRATIONS = [String.raw`
CREATE TABLE merge_authority (
  project_id TEXT PRIMARY KEY,
  granted_at INTEGER NOT NULL,
  granted_by_user_id TEXT NOT NULL,
  granted_by_chat_id TEXT NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 1 AND 200)
);

CREATE TABLE merge_authority_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('granted', 'revoked', 'used')),
  job_id TEXT,
  actor_user_id TEXT,
  actor_chat_id TEXT,
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  occurred_at INTEGER NOT NULL
);

CREATE INDEX merge_authority_events_project
  ON merge_authority_events (project_id, occurred_at);
`] as const;

/**
 * `regression_watch` holds the confirmed-failing command set per project, not a
 * count: a count cannot tell a new regression from a different test failing in
 * place of a fixed one. `reported_failures` is what the owner has already been
 * told, so a standing failure stays quiet until it changes.
 */
export const REGRESSION_WATCH_MIGRATIONS = [String.raw`
CREATE TABLE regression_watch (
  project_id TEXT PRIMARY KEY,
  confirmed_failures TEXT NOT NULL DEFAULT '[]',
  reported_failures TEXT NOT NULL DEFAULT '[]',
  flaky_failures TEXT NOT NULL DEFAULT '[]',
  last_summary TEXT,
  last_checked_at INTEGER,
  reported_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE failure_escalations (
  fingerprint TEXT PRIMARY KEY,
  project_id TEXT,
  cluster_size INTEGER NOT NULL,
  reason TEXT NOT NULL,
  escalated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX failure_escalations_expiry ON failure_escalations (expires_at);

CREATE TABLE project_admission_pauses (
  project_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  fingerprint TEXT,
  paused_at INTEGER NOT NULL,
  cleared_at INTEGER
);
`] as const;

/**
 * The Hanoon-side projection of the credential broker foundation. Every row
 * here is secret-free by construction: bindings carry only the metadata the
 * broker already agreed to disclose, operations carry the outbound envelope
 * (ids, digests, timestamps) rather than a resolved value, and receipts carry
 * the broker's own outcome fields instead of its raw response body. Reconciled
 * bindings are a projection, not a cache: a later health snapshot that omits a
 * binding never deletes its local row, because the broker only stops listing
 * a revoked binding once its retention window lapses, and the tombstone is
 * what proves that binding once existed.
 */
export const CREDENTIAL_ACCESS_MIGRATIONS = [String.raw`
CREATE TABLE credential_bindings (
  installation_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  label TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'onepassword'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'vault_verified', 'degraded', 'active', 'revoked', 'compromised')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  capability_ids_json TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  mfa_mode TEXT NOT NULL CHECK (mfa_mode IN ('none', 'totp', 'webauthn', 'push')),
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('none', 'owner_confirmation')),
  last_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, binding_id)
);

CREATE INDEX credential_bindings_state
  ON credential_bindings (installation_id, state, generation);

CREATE TABLE credential_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  nonce TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('broker.health', 'vault.binding.verify')),
  binding_id TEXT,
  binding_generation INTEGER,
  turn_id TEXT,
  capability_id TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  fence_owner TEXT,
  fence_generation INTEGER,
  issued_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  envelope_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'completed', 'ambiguous')),
  response_receipt_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (installation_id, request_id),
  UNIQUE (installation_id, nonce),
  UNIQUE (installation_id, idempotency_key),
  FOREIGN KEY (installation_id, binding_id) REFERENCES credential_bindings (installation_id, binding_id)
);

CREATE INDEX credential_operations_state
  ON credential_operations (installation_id, operation, state);

CREATE INDEX credential_operations_turn
  ON credential_operations (installation_id, turn_id);

CREATE TABLE credential_receipts (
  receipt_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('broker.health', 'vault.binding.verify')),
  turn_id TEXT,
  binding_id TEXT,
  binding_generation INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  result TEXT CHECK (result IN ('ready', 'valid', 'invalid')),
  failure_class TEXT,
  retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  retry_after_ms INTEGER,
  response_sha256 TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (installation_id, binding_id) REFERENCES credential_bindings (installation_id, binding_id)
);

CREATE INDEX credential_receipts_installation
  ON credential_receipts (installation_id, completed_at);

CREATE TABLE credential_health (
  installation_id TEXT PRIMARY KEY,
  broker_version TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter = 'onepassword'),
  adapter_state TEXT NOT NULL CHECK (adapter_state IN ('ready', 'degraded', 'unavailable')),
  audit_writable INTEGER NOT NULL CHECK (audit_writable IN (0, 1)),
  binding_count INTEGER NOT NULL,
  topology_receipt_digest TEXT NOT NULL,
  topology_receipt_expires_at INTEGER NOT NULL,
  response_sha256 TEXT NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_failure_class TEXT,
  updated_at INTEGER NOT NULL
);
`] as const;

export const CONTROLLER_STEER_RESERVATION_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN steer_reservation_turn_id TEXT;
`] as const;

export const CONTROLLER_SUPERVISOR_ATTEMPT_MIGRATIONS = [String.raw`
CREATE TABLE controller_supervisor_steer_attempts (
  turn_id TEXT NOT NULL REFERENCES controller_turns(id),
  controller_key TEXT NOT NULL REFERENCES controller_threads(controller_key),
  reason TEXT NOT NULL CHECK (reason IN ('tool_budget', 'token_budget', 'command_failures')),
  thread_id TEXT NOT NULL,
  input_text TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'unknown')),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  PRIMARY KEY (turn_id, reason),
  CHECK ((state = 'pending' AND settled_at IS NULL) OR
         (state IN ('applied', 'unknown') AND settled_at IS NOT NULL))
);
CREATE INDEX controller_supervisor_steer_attempts_pending
  ON controller_supervisor_steer_attempts(turn_id, state);
`] as const;

export const CONTROLLER_INTERACTION_REPAIR_MIGRATIONS = [String.raw`
CREATE TABLE controller_interaction_quarantine (
  source TEXT NOT NULL CHECK (source IN ('controller', 'thread', 'controller_questions')),
  interaction_id TEXT NOT NULL,
  turn_id TEXT,
  controller_key TEXT,
  bb_thread_id TEXT,
  controller_generation_id TEXT,
  thread_id TEXT,
  title TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  answer_json TEXT,
  prior_state TEXT NOT NULL CHECK (prior_state IN ('pending', 'answered')),
  asked_at INTEGER NOT NULL,
  answered_at INTEGER,
  quarantined_at INTEGER NOT NULL,
  PRIMARY KEY (source, interaction_id)
);

INSERT INTO controller_interaction_quarantine (
  source, interaction_id, turn_id, controller_key, bb_thread_id,
  controller_generation_id, thread_id, title, kind, payload_json, answer_json,
  prior_state, asked_at, answered_at, quarantined_at
)
SELECT
  'controller', interaction.interaction_id, interaction.turn_id, interaction.controller_key,
  interaction.bb_thread_id, interaction.controller_generation_id, NULL, NULL,
  interaction.kind, interaction.payload_json, interaction.answer_json,
  interaction.state, interaction.asked_at, interaction.answered_at, interaction.asked_at
FROM controller_interactions AS interaction
WHERE interaction.state IN ('pending', 'answered')
  AND interaction.interaction_id IS NOT NULL;

INSERT INTO controller_interaction_quarantine (
  source, interaction_id, turn_id, controller_key, bb_thread_id,
  controller_generation_id, thread_id, title, kind, payload_json, answer_json,
  prior_state, asked_at, answered_at, quarantined_at
)
SELECT
  'thread', interaction.interaction_id, NULL, NULL, NULL, NULL,
  interaction.thread_id, interaction.title, interaction.kind,
  interaction.payload_json, interaction.answer_json, interaction.state,
  interaction.asked_at, interaction.answered_at, interaction.asked_at
FROM thread_interactions AS interaction
WHERE interaction.state IN ('pending', 'answered');

UPDATE controller_interactions
   SET state = 'delivered', answer_json = NULL,
       bb_thread_id = NULL, controller_generation_id = NULL,
       delivered_at = COALESCE(answered_at, asked_at)
 WHERE state IN ('pending', 'answered');

UPDATE thread_interactions
   SET state = 'delivered', answer_json = NULL
 WHERE state IN ('pending', 'answered');

UPDATE controller_turns
   SET awaiting_interaction_id = NULL
 WHERE awaiting_interaction_id IS NOT NULL;

UPDATE controller_questions
   SET state = 'delivered', answers_json = NULL,
       answered_at = COALESCE(answered_at, asked_at)
 WHERE state IN ('pending', 'answered');

UPDATE outbox
   SET payload_json = CASE
         WHEN json_valid(payload_json) = 1 THEN json_set(
           payload_json,
           '$.reply_markup', json_object('inline_keyboard', json_array())
         )
         ELSE json_object('reply_markup', json_object('inline_keyboard', json_array()))
       END,
       status = 'pending', lease_owner = NULL, lease_generation = NULL,
       lease_expires_at = NULL, next_attempt_at = updated_at, last_error = NULL
 WHERE EXISTS (
   SELECT 1 FROM controller_interaction_quarantine AS quarantine
    WHERE (
      quarantine.source IN ('controller', 'controller_questions')
      AND substr(outbox.logical_key, 1, length('controller-interaction:' || quarantine.interaction_id || ':')) =
          'controller-interaction:' || quarantine.interaction_id || ':'
    ) OR (
      quarantine.source = 'thread'
      AND outbox.logical_key = 'thread-interaction:' || quarantine.interaction_id
    )
 );
`] as const;

export const CONTROLLER_FINALIZATION_ENVELOPE_MIGRATIONS = [String.raw`
ALTER TABLE controller_finalizations
  ADD COLUMN envelope_version INTEGER NOT NULL DEFAULT 1
  CHECK (envelope_version >= 1);
`] as const;

export const CONTROLLER_INTERACTION_FINAL_REPAIR_MIGRATIONS = [String.raw`
ALTER TABLE controller_interaction_quarantine ADD COLUMN consumed_at INTEGER;

UPDATE outbox
   SET payload_json = json_object(
         'text', 'This interaction is no longer available. Open BB to review it.',
         'reply_markup', json_object('inline_keyboard', json_array()),
         'disable_web_page_preview', json('true')
       ),
       status = 'pending', lease_owner = NULL, lease_generation = NULL,
       lease_expires_at = NULL, next_attempt_at = updated_at, last_error = NULL
 WHERE EXISTS (
   SELECT 1 FROM controller_interaction_quarantine AS quarantine
    WHERE (
      quarantine.source IN ('controller', 'controller_questions')
      AND substr(outbox.logical_key, 1, length('controller-interaction:' || quarantine.interaction_id || ':')) =
          'controller-interaction:' || quarantine.interaction_id || ':'
    ) OR (
      quarantine.source = 'thread'
      AND outbox.logical_key = 'thread-interaction:' || quarantine.interaction_id
    )
 );
`] as const;

export const CONTROLLER_RECOVERY_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN input_accepted INTEGER NOT NULL DEFAULT 0
  CHECK (input_accepted IN (0, 1));
ALTER TABLE controller_turns ADD COLUMN private_draft_item_id TEXT;
ALTER TABLE controller_turns ADD COLUMN private_draft_text TEXT NOT NULL DEFAULT '';
ALTER TABLE controller_turns ADD COLUMN recovery_source_turn_id TEXT REFERENCES controller_turns(id);
`] as const;

export const THREAD_FOLLOW_UP_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN thread_follow_up_json TEXT;
`] as const;

export const CONTROLLER_GENERATION_QUARANTINE_MIGRATIONS = [String.raw`
CREATE TABLE controller_generation_quarantine (
  generation_id TEXT PRIMARY KEY,
  controller_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  original_ended_at INTEGER,
  original_end_reason TEXT,
  quarantined_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'ambiguous_open_generations', 'generation_mapping_mismatch'
  ))
);
CREATE INDEX controller_generation_quarantine_controller
  ON controller_generation_quarantine(controller_key, quarantined_at);
`] as const;

export const CONTROLLER_GENERATION_INVARIANT_MIGRATIONS = [String.raw`
CREATE UNIQUE INDEX one_open_controller_generation
  ON controller_generations(controller_key)
  WHERE ended_at IS NULL;
`] as const;

export const CONTROLLER_DELIVERY_STATE_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'none'
  CHECK (delivery_state IN ('none', 'intent', 'delivery_unknown'));
ALTER TABLE controller_turns ADD COLUMN dispatch_kind TEXT
  CHECK (dispatch_kind IS NULL OR dispatch_kind IN ('send', 'spawn'));
ALTER TABLE controller_turns ADD COLUMN dispatch_correlation_id TEXT;
ALTER TABLE controller_turns ADD COLUMN dispatch_retry_count INTEGER NOT NULL DEFAULT 0
  CHECK (dispatch_retry_count >= 0);
ALTER TABLE controller_turns ADD COLUMN delivery_reconcile_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (delivery_reconcile_attempts >= 0);
ALTER TABLE controller_turns ADD COLUMN busy_wait_notified_at INTEGER
  CHECK (busy_wait_notified_at IS NULL OR busy_wait_notified_at >= 0);
ALTER TABLE controller_turns ADD COLUMN next_dispatch_at INTEGER NOT NULL DEFAULT 0
  CHECK (next_dispatch_at >= 0);

UPDATE controller_turns
   SET delivery_state = 'delivery_unknown',
       dispatch_kind = CASE
         WHEN EXISTS (
           SELECT 1 FROM controller_threads AS controller
            WHERE controller.controller_key = controller_turns.controller_key
              AND controller.bb_thread_id IS NOT NULL
         ) THEN 'send'
         ELSE 'spawn'
       END
 WHERE state = 'dispatching';
`] as const;

export const THREAD_INTERACTION_AUDIENCE_MIGRATIONS = [String.raw`
ALTER TABLE thread_interactions ADD COLUMN audience TEXT NOT NULL DEFAULT 'owner';
`] as const;

// What the controller asked a worker thread to do, recorded when it sends so
// the owner can be told afterwards. Keyed to the controller rather than the
// turn: an ask stays unreported until it actually reaches the owner, so a turn
// that dies after sending still surfaces it on the next reply.
export const CONTROLLER_THREAD_ASK_MIGRATIONS = [String.raw`
CREATE TABLE controller_thread_asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  controller_key TEXT NOT NULL REFERENCES controller_threads(controller_key),
  turn_id TEXT NOT NULL REFERENCES controller_turns(id),
  thread_id TEXT NOT NULL,
  thread_name TEXT,
  ask TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  reported_at INTEGER
);
CREATE INDEX controller_thread_asks_unreported
  ON controller_thread_asks(controller_key, id)
  WHERE reported_at IS NULL;
`] as const;

// Two more reasons a turn can be steered, both about the evidence budget: one
// as it nears the cap, one once the cap has refused a write. The reason column
// carries a CHECK, which SQLite cannot widen in place, so the table is rebuilt
// with its rows carried over.
export const CONTROLLER_EVIDENCE_STEER_MIGRATIONS = [String.raw`
CREATE TABLE controller_supervisor_steer_attempts_v2 (
  turn_id TEXT NOT NULL REFERENCES controller_turns(id),
  controller_key TEXT NOT NULL REFERENCES controller_threads(controller_key),
  reason TEXT NOT NULL CHECK (reason IN (
    'tool_budget', 'token_budget', 'command_failures', 'evidence_budget', 'evidence_spent')),
  thread_id TEXT NOT NULL,
  input_text TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'unknown')),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  PRIMARY KEY (turn_id, reason),
  CHECK ((state = 'pending' AND settled_at IS NULL) OR
         (state IN ('applied', 'unknown') AND settled_at IS NOT NULL))
);
INSERT INTO controller_supervisor_steer_attempts_v2
  SELECT * FROM controller_supervisor_steer_attempts;
DROP TABLE controller_supervisor_steer_attempts;
ALTER TABLE controller_supervisor_steer_attempts_v2
  RENAME TO controller_supervisor_steer_attempts;
CREATE INDEX controller_supervisor_steer_attempts_pending
  ON controller_supervisor_steer_attempts(turn_id, state);
`] as const;

// Upkeep the agent does for itself has to be able to say something once and
// then stay quiet. A notice claimed here is a notice already given, until its
// window expires.
export const HOUSEKEEPING_NOTICE_MIGRATIONS = [String.raw`
CREATE TABLE housekeeping_notices (
  notice_key TEXT PRIMARY KEY,
  detail TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`] as const;

// A stalled member is escalated once, not on every sweep. Durable, because the
// alternative is an in-memory flag that a restart turns back into a fresh
// alarm about a thread that was already reported.
export const DELEGATION_STALL_MIGRATIONS = [String.raw`
ALTER TABLE delegation_threads ADD COLUMN stall_notified_at INTEGER;
`] as const;

/**
 * What every stage attempt actually ran on, and what it cost. Tiering can only
 * be tuned from real numbers, so the numbers are recorded per attempt rather
 * than inferred later from the policy that happened to be current.
 */
export const STAGE_EXECUTION_MIGRATIONS = [String.raw`
CREATE TABLE stage_executions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 256),
  stage TEXT NOT NULL CHECK (stage IN (
    'plan', 'critique', 'implementation', 'review',
    'validation', 'docs', 'merge', 'deploy', 'canary'
  )),
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 1),
  thread_id TEXT,
  base_tier TEXT NOT NULL CHECK (base_tier IN ('fast', 'standard', 'strong')),
  tier TEXT NOT NULL CHECK (tier IN ('fast', 'standard', 'strong')),
  escalation_steps INTEGER NOT NULL CHECK (escalation_steps BETWEEN 0 AND 2),
  source TEXT NOT NULL CHECK (source IN ('stage-policy', 'legacy-policy', 'default', 'capability-route')),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 256),
  reasoning_level TEXT NOT NULL CHECK (length(reasoning_level) BETWEEN 1 AND 64),
  service_tier TEXT NOT NULL CHECK (service_tier IN ('default', 'fast')),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_output_tokens INTEGER CHECK (reasoning_output_tokens IS NULL OR reasoning_output_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  cost_micro_usd INTEGER CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'cancelled')),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  settled_at INTEGER CHECK (settled_at IS NULL OR settled_at >= 0),
  UNIQUE(job_id, stage, attempt_id)
);
CREATE INDEX stage_executions_by_job ON stage_executions(job_id, started_at, id);
`] as const;

/**
 * The ladder that lets a blocked job resume itself. `auto_continue_key` names
 * which block the count belongs to, so a job that clears one wall and stops at
 * a later one arrives with a full allowance rather than an exhausted one.
 */
export const JOB_CONTINUATION_MIGRATIONS = [String.raw`
ALTER TABLE jobs ADD COLUMN auto_continue_count INTEGER NOT NULL DEFAULT 0
  CHECK (auto_continue_count >= 0);
ALTER TABLE jobs ADD COLUMN auto_continue_key TEXT;
ALTER TABLE jobs ADD COLUMN auto_continue_escalated_at INTEGER
  CHECK (auto_continue_escalated_at IS NULL OR auto_continue_escalated_at >= 0);
`] as const;

/**
 * Reported-once marker for a watched thread that wedged. A stalled thread stays
 * stalled on every sweep, so without it one stuck thread becomes an alarm every
 * fifteen seconds.
 */
export const MONITOR_STALL_MIGRATIONS = [String.raw`
ALTER TABLE monitors ADD COLUMN stall_notified_at INTEGER
  CHECK (stall_notified_at IS NULL OR stall_notified_at >= 0);
`] as const;

/**
 * Jobs already blocked when the continuation sweep arrived are excluded from
 * it. They stopped under the old rules, days or weeks ago, and their branches,
 * pull requests, and environments have moved on since; resuming them would be
 * the sweep's first act rather than its steady state, against work nobody is
 * waiting on any more. Marking them handed-over reuses the exclusion the sweep
 * already honours, so only jobs that block from here on climb the ladder.
 */
export const JOB_CONTINUATION_BACKFILL_MIGRATIONS = [String.raw`
UPDATE jobs SET auto_continue_escalated_at = updated_at
 WHERE state = 'blocked' AND auto_continue_escalated_at IS NULL;
`] as const;

/**
 * One vector per memory, tagged with the model and dimension that produced it.
 *
 * The tag is the point. A corpus embedded by one model and queried by another
 * yields a similarity that looks like a score and means nothing, and the
 * reference system this follows lost its vector recall exactly that way. Recall
 * compares only vectors whose model matches the one asking, so switching models
 * degrades to words rather than to nonsense, and the old rows stay for a
 * backfill instead of being silently trusted.
 */
export const MEMORY_EMBEDDING_MIGRATIONS = [String.raw`
CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 8192),
  vector BLOB NOT NULL,
  embedded_at INTEGER NOT NULL CHECK (embedded_at >= 0)
);
CREATE INDEX memory_embeddings_model ON memory_embeddings (model, memory_id);
`] as const;

export const REFERENCE_DOCUMENT_MIGRATIONS = [String.raw`
CREATE TABLE reference_documents (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  project_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 1024),
  version INTEGER NOT NULL CHECK (version >= 1),
  map_json TEXT NOT NULL,
  ingested_at INTEGER NOT NULL CHECK (ingested_at >= 0),
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
);
CREATE UNIQUE INDEX reference_documents_identity
  ON reference_documents (scope, ifnull(project_id, ''), title);
CREATE INDEX reference_documents_scope ON reference_documents (scope, project_id);
CREATE TABLE reference_passages (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES reference_documents(id) ON DELETE CASCADE,
  ordinal TEXT NOT NULL,
  section_path TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8192)
);
CREATE INDEX reference_passages_document ON reference_passages (document_id, ordinal);
CREATE VIRTUAL TABLE reference_passages_fts USING fts5(
  section_path, body, content='reference_passages', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER reference_passages_fts_insert AFTER INSERT ON reference_passages BEGIN
  INSERT INTO reference_passages_fts (rowid, section_path, body)
    VALUES (new.rowid, new.section_path, new.body);
END;
CREATE TRIGGER reference_passages_fts_delete AFTER DELETE ON reference_passages BEGIN
  INSERT INTO reference_passages_fts (reference_passages_fts, rowid, section_path, body)
    VALUES ('delete', old.rowid, old.section_path, old.body);
END;
CREATE TRIGGER reference_passages_fts_update AFTER UPDATE ON reference_passages BEGIN
  INSERT INTO reference_passages_fts (reference_passages_fts, rowid, section_path, body)
    VALUES ('delete', old.rowid, old.section_path, old.body);
  INSERT INTO reference_passages_fts (rowid, section_path, body)
    VALUES (new.rowid, new.section_path, new.body);
END;
CREATE TABLE reference_document_changes (
  document_id TEXT NOT NULL REFERENCES reference_documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 2),
  section_path TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('added', 'removed', 'changed')),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
  PRIMARY KEY (document_id, version, section_path)
);
`] as const;

/**
 * Exact per-section baselines for change reporting. Passages may combine short
 * descendants for retrieval, so reconstructing section history from them can
 * invent changes even when the source document is byte-for-byte identical.
 */
export const REFERENCE_DOCUMENT_REPAIR_MIGRATIONS = [String.raw`
CREATE TABLE reference_section_digests (
  document_id TEXT NOT NULL REFERENCES reference_documents(id) ON DELETE CASCADE,
  section_path TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 16),
  PRIMARY KEY (document_id, section_path)
);
`] as const;

/** Exact controller provenance and retry linkage for worker-thread questions. */
export const CONTROLLER_THREAD_ROUTING_REPAIR_MIGRATIONS = [String.raw`
ALTER TABLE thread_interactions ADD COLUMN controller_key TEXT
  REFERENCES controller_threads(controller_key);
ALTER TABLE thread_interactions ADD COLUMN controller_turn_id TEXT
  REFERENCES controller_turns(id);
CREATE INDEX thread_interactions_controller_retry
  ON thread_interactions(audience, state, controller_key);
`] as const;

/** Immutable record of each failure cause that has already been cleared. */
export const PROJECT_ADMISSION_CLEAR_HISTORY_MIGRATIONS = [String.raw`
CREATE TABLE project_admission_pause_clear_history (
  project_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  cleared_at INTEGER NOT NULL CHECK (cleared_at >= 0),
  cleared_by TEXT NOT NULL CHECK (cleared_by IN ('agent', 'owner', 'legacy')),
  PRIMARY KEY (project_id, fingerprint)
);
INSERT OR IGNORE INTO project_admission_pause_clear_history (
  project_id, fingerprint, cleared_at, cleared_by
)
  SELECT project_id, fingerprint, cleared_at, 'legacy'
    FROM project_admission_pauses
   WHERE fingerprint IS NOT NULL AND cleared_at IS NOT NULL;
`] as const;

/** Durable handoff between serial Telegram intake and bounded voice work. */
export const CONTROLLER_VOICE_INBOX_MIGRATIONS = [String.raw`
CREATE TABLE controller_voice_inbox (
  update_id INTEGER PRIMARY KEY REFERENCES telegram_updates(update_id),
  controller_key TEXT NOT NULL CHECK (length(controller_key) BETWEEN 1 AND 128),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  telegram_user_id TEXT NOT NULL CHECK (length(telegram_user_id) BETWEEN 1 AND 32),
  telegram_chat_id TEXT NOT NULL CHECK (length(telegram_chat_id) BETWEEN 1 AND 32),
  file_id TEXT NOT NULL CHECK (length(file_id) BETWEEN 1 AND 512),
  mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 255),
  file_size_bytes INTEGER CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
  caption TEXT CHECK (caption IS NULL OR length(caption) <= 4000),
  state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_owner TEXT,
  claim_generation INTEGER NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  claim_expires_at INTEGER,
  outcome TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  completed_at INTEGER,
  CHECK (
    (state = 'processing' AND claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL) OR
    (state <> 'processing' AND claim_owner IS NULL AND claim_expires_at IS NULL)
  )
);
CREATE INDEX controller_voice_inbox_due
  ON controller_voice_inbox(state, claim_expires_at, update_id);
CREATE UNIQUE INDEX controller_voice_inbox_ordinal
  ON controller_voice_inbox(controller_key, ordinal);
`] as const;

/**
 * A consensus pass is an ordinary review attempt with its own lens and its own
 * stage, so it is bound to an exact head and survives restart on the same
 * durable evidence as every other lens. It is a separate stage rather than a
 * third lens inside `final_review` precisely so it can never be mistaken for a
 * member of a required review group.
 */
export const CONSENSUS_REVIEW_MIGRATIONS = [String.raw`
ALTER TABLE attempts RENAME TO attempts_before_consensus_lens;
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('implementation', 'review', 'validation')),
  review_lens TEXT CHECK (review_lens IS NULL OR review_lens IN ('quality', 'risk', 'consensus')),
  review_stage TEXT CHECK (review_stage IS NULL OR review_stage IN ('review', 'final_review', 'consensus')),
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
  id, job_id, kind, review_lens, review_stage, ordinal, thread_id, head_sha,
  handoff_path, handoff_sha256, result_json, created_at, completed_at
) SELECT
  id, job_id, kind, review_lens, review_stage, ordinal, thread_id, head_sha,
  handoff_path, handoff_sha256, result_json, created_at, completed_at
FROM attempts_before_consensus_lens;
DROP TABLE attempts_before_consensus_lens;
CREATE UNIQUE INDEX attempts_non_review_ordinal
  ON attempts(job_id, kind, ordinal) WHERE kind <> 'review';
CREATE UNIQUE INDEX attempts_review_lens
  ON attempts(job_id, review_stage, ordinal, review_lens)
  WHERE kind = 'review' AND review_lens IS NOT NULL AND review_stage IS NOT NULL;
`] as const;

/**
 * Work the agent starts on its own needs three durable answers before it may
 * start anything: what began this job, whether this finding has already had one,
 * and whether this merge has already been reverted once.
 *
 * `autonomous_origin` sits beside `job_origin` rather than extending it. Origin
 * decides how the pipeline treats the work; this decides only who is answerable
 * for it existing, and a job a person asked for leaves it null forever.
 *
 * The two ledgers are keyed on the thing that must not repeat, not on the job
 * that repeated it: a finding per project, and a merge commit for all time. That
 * is what makes "once, ever" a property of the schema rather than of the code
 * that happened to write the row.
 */
export const AUTONOMOUS_INTAKE_MIGRATIONS = [String.raw`
ALTER TABLE jobs ADD COLUMN autonomous_origin TEXT
  CHECK (autonomous_origin IS NULL
         OR autonomous_origin IN ('audit_intake', 'self_diagnosis', 'crash_revert'));

CREATE TABLE audit_intake_findings (
  project_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  utc_day TEXT NOT NULL CHECK (length(utc_day) = 10),
  started_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, fingerprint)
);

CREATE INDEX audit_intake_findings_day
  ON audit_intake_findings (project_id, utc_day);

CREATE TABLE crash_revert_jobs (
  merge_commit_sha TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  merged_job_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  started_at INTEGER NOT NULL
);

CREATE INDEX crash_revert_jobs_project
  ON crash_revert_jobs (project_id, started_at);
`] as const;

export const MERGE_PRE_APPROVAL_MIGRATIONS = [String.raw`
ALTER TABLE jobs ADD COLUMN merge_pre_approved_at INTEGER;
`] as const;

/**
 * Editable tracker artifacts are mirrored separately from immutable execution
 * snapshots. A remote close is only an observation on the artifact row;
 * evidenced internal resolution is an append-only record of its own.
 */
export const WORK_ARTIFACT_MIGRATIONS = [String.raw`
CREATE TABLE work_artifact_create_intents (
  artifact_id TEXT PRIMARY KEY CHECK (length(artifact_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
  effort_id TEXT NOT NULL CHECK (length(effort_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  tracker_kind TEXT NOT NULL CHECK (tracker_kind IN ('github', 'local_markdown')),
  tracker_namespace TEXT NOT NULL CHECK (length(tracker_namespace) BETWEEN 1 AND 1024),
  tracker_operation_id TEXT NOT NULL CHECK (length(tracker_operation_id) BETWEEN 1 AND 256),
  create_digest TEXT NOT NULL CHECK (length(create_digest) = 64),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE(project_id, operation_id),
  UNIQUE(tracker_namespace, tracker_operation_id)
);
CREATE TRIGGER work_artifact_create_intents_append_only_update
BEFORE UPDATE ON work_artifact_create_intents
BEGIN SELECT RAISE(ABORT, 'work_artifact_create_intents are append-only'); END;
CREATE TRIGGER work_artifact_create_intents_append_only_delete
BEFORE DELETE ON work_artifact_create_intents
BEGIN SELECT RAISE(ABORT, 'work_artifact_create_intents are append-only'); END;

CREATE TABLE work_artifacts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
  effort_id TEXT NOT NULL CHECK (length(effort_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  kind TEXT NOT NULL CHECK (kind IN (
    'map', 'specification', 'decision_ticket', 'implementation_ticket'
  )),
  initial_status TEXT NOT NULL CHECK (initial_status IN ('open', 'ready')),
  status TEXT NOT NULL CHECK (status IN ('open', 'ready', 'claimed', 'resolved', 'cancelled')),
  tracker_kind TEXT NOT NULL CHECK (tracker_kind IN ('github', 'local_markdown')),
  tracker_namespace TEXT NOT NULL CHECK (length(tracker_namespace) BETWEEN 1 AND 1024),
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 1024),
  external_url TEXT CHECK (external_url IS NULL OR length(external_url) BETWEEN 1 AND 2048),
  external_revision TEXT NOT NULL CHECK (length(external_revision) BETWEEN 1 AND 512),
  external_status TEXT NOT NULL CHECK (external_status IN ('open', 'closed', 'cancelled')),
  assignees_json TEXT NOT NULL CHECK (json_valid(assignees_json)),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
  tracker_order INTEGER NOT NULL CHECK (tracker_order >= 0),
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  current_snapshot_id TEXT,
  remote_closed_at INTEGER CHECK (remote_closed_at IS NULL OR remote_closed_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE(project_id, operation_id),
  UNIQUE(project_id, tracker_namespace, external_id),
  CHECK ((current_revision = 0) = (current_snapshot_id IS NULL))
);
CREATE INDEX work_artifacts_effort
  ON work_artifacts(project_id, effort_id, tracker_order, created_at, id);
CREATE INDEX work_artifacts_status
  ON work_artifacts(project_id, effort_id, status, tracker_order, id);

CREATE TABLE work_artifact_tracker_mutations (
  tracker_namespace TEXT NOT NULL CHECK (length(tracker_namespace) BETWEEN 1 AND 1024),
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 1024),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  artifact_id TEXT NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 256),
  kind TEXT NOT NULL CHECK (kind IN ('parent', 'owned_section', 'resolve', 'cancel')),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  requested_parent_external_id TEXT
    CHECK (requested_parent_external_id IS NULL OR length(requested_parent_external_id) BETWEEN 1 AND 1024),
  original_parent_external_id TEXT
    CHECK (original_parent_external_id IS NULL OR length(original_parent_external_id) BETWEEN 1 AND 1024),
  original_revision TEXT NOT NULL CHECK (length(original_revision) BETWEEN 1 AND 512),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  phase TEXT NOT NULL CHECK (phase IN ('prepared', 'applying', 'completed', 'indeterminate')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'indeterminate')),
  last_observed_parent_external_id TEXT
    CHECK (last_observed_parent_external_id IS NULL OR length(last_observed_parent_external_id) BETWEEN 1 AND 1024),
  last_observed_revision TEXT
    CHECK (last_observed_revision IS NULL OR length(last_observed_revision) BETWEEN 1 AND 512),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2048),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  settled_at INTEGER CHECK (settled_at IS NULL OR settled_at >= 0),
  PRIMARY KEY (tracker_namespace, external_id, operation_id),
  CHECK ((kind = 'parent') = (requested_parent_external_id IS NOT NULL)),
  CHECK (
    (phase IN ('prepared', 'applying') AND status = 'pending' AND settled_at IS NULL) OR
    (phase = 'completed' AND status = 'completed' AND settled_at IS NOT NULL) OR
    (phase = 'indeterminate' AND status = 'indeterminate' AND settled_at IS NOT NULL)
  )
);
CREATE INDEX work_artifact_tracker_mutations_artifact
  ON work_artifact_tracker_mutations(artifact_id, status, updated_at);

CREATE TABLE work_artifact_snapshots (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  artifact_id TEXT NOT NULL REFERENCES work_artifacts(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 1048576),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(acceptance_criteria_json)),
  relationships_json TEXT NOT NULL CHECK (json_valid(relationships_json)),
  external_revision TEXT NOT NULL CHECK (length(external_revision) BETWEEN 1 AND 512),
  captured_at INTEGER NOT NULL CHECK (captured_at >= 0),
  UNIQUE(artifact_id, revision)
);
CREATE INDEX work_artifact_snapshots_artifact
  ON work_artifact_snapshots(artifact_id, revision DESC);
CREATE TRIGGER work_artifact_snapshots_append_only_update
BEFORE UPDATE ON work_artifact_snapshots
BEGIN SELECT RAISE(ABORT, 'work_artifact_snapshots are append-only'); END;
CREATE TRIGGER work_artifact_snapshots_append_only_delete
BEFORE DELETE ON work_artifact_snapshots
BEGIN SELECT RAISE(ABORT, 'work_artifact_snapshots are append-only'); END;

CREATE TABLE work_artifact_snapshot_invalidations (
  snapshot_id TEXT PRIMARY KEY REFERENCES work_artifact_snapshots(id),
  replacement_snapshot_id TEXT NOT NULL REFERENCES work_artifact_snapshots(id),
  reason TEXT NOT NULL CHECK (reason IN ('remote_edit', 'relationship_change')),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  CHECK (snapshot_id <> replacement_snapshot_id)
);
CREATE TRIGGER work_artifact_invalidations_append_only_update
BEFORE UPDATE ON work_artifact_snapshot_invalidations
BEGIN SELECT RAISE(ABORT, 'work_artifact_snapshot_invalidations are append-only'); END;
CREATE TRIGGER work_artifact_invalidations_append_only_delete
BEFORE DELETE ON work_artifact_snapshot_invalidations
BEGIN SELECT RAISE(ABORT, 'work_artifact_snapshot_invalidations are append-only'); END;

CREATE TABLE work_artifact_relationships (
  owner_artifact_id TEXT NOT NULL REFERENCES work_artifacts(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'parent', 'blocks', 'derived_from', 'executed_by', 'delivered_by'
  )),
  source_artifact_id TEXT REFERENCES work_artifacts(id),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 1024),
  target_artifact_id TEXT REFERENCES work_artifacts(id),
  target_ref TEXT NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 1024),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (owner_artifact_id, kind, source_ref, target_ref),
  UNIQUE(owner_artifact_id, ordinal)
);
CREATE INDEX work_artifact_relationships_source
  ON work_artifact_relationships(kind, source_artifact_id, target_artifact_id);
CREATE INDEX work_artifact_relationships_target
  ON work_artifact_relationships(kind, target_artifact_id, source_artifact_id);
CREATE TRIGGER work_artifact_relationships_same_effort
BEFORE INSERT ON work_artifact_relationships
WHEN EXISTS (
  SELECT 1
    FROM work_artifacts AS owner
    JOIN work_artifacts AS related
      ON related.id IN (NEW.source_artifact_id, NEW.target_artifact_id)
   WHERE owner.id = NEW.owner_artifact_id
     AND (related.project_id <> owner.project_id OR related.effort_id <> owner.effort_id)
)
BEGIN SELECT RAISE(ABORT, 'work artifact relationships must stay in one effort'); END;
CREATE TRIGGER work_artifact_relationships_touch_owner
BEFORE INSERT ON work_artifact_relationships
WHEN NEW.source_artifact_id IS NOT NEW.owner_artifact_id
 AND NEW.target_artifact_id IS NOT NEW.owner_artifact_id
BEGIN SELECT RAISE(ABORT, 'work artifact relationships must touch their owner'); END;
CREATE TRIGGER work_artifact_relationships_no_self_edge
BEFORE INSERT ON work_artifact_relationships
WHEN NEW.source_artifact_id IS NOT NULL
 AND NEW.source_artifact_id IS NEW.target_artifact_id
BEGIN SELECT RAISE(ABORT, 'work artifact relationships cannot be self edges'); END;

CREATE TABLE work_artifact_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL REFERENCES work_artifacts(id),
  workflow_step_id TEXT NOT NULL CHECK (length(workflow_step_id) BETWEEN 1 AND 256),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  snapshot_id TEXT NOT NULL REFERENCES work_artifact_snapshots(id),
  external_assignee TEXT NOT NULL CHECK (length(external_assignee) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK (state IN ('held', 'released', 'invalidated')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at >= 0),
  acquired_at INTEGER NOT NULL CHECK (acquired_at >= 0),
  renewed_at INTEGER NOT NULL CHECK (renewed_at >= 0),
  released_at INTEGER CHECK (released_at IS NULL OR released_at >= 0),
  release_reason TEXT CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 256)
);
CREATE UNIQUE INDEX one_held_work_artifact_claim
  ON work_artifact_claims(artifact_id) WHERE state = 'held';
CREATE INDEX work_artifact_claims_workflow
  ON work_artifact_claims(workflow_step_id, state, artifact_id);

CREATE TABLE work_artifact_resolution_intents (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  artifact_id TEXT NOT NULL REFERENCES work_artifacts(id),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  outcome TEXT NOT NULL CHECK (outcome IN ('resolved', 'cancelled')),
  snapshot_id TEXT NOT NULL REFERENCES work_artifact_snapshots(id),
  expected_external_revision TEXT NOT NULL CHECK (length(expected_external_revision) BETWEEN 1 AND 512),
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
  UNIQUE(artifact_id, operation_id)
);
CREATE TRIGGER work_artifact_resolution_intents_append_only_update
BEFORE UPDATE ON work_artifact_resolution_intents
BEGIN SELECT RAISE(ABORT, 'work_artifact_resolution_intents are append-only'); END;
CREATE TRIGGER work_artifact_resolution_intents_append_only_delete
BEFORE DELETE ON work_artifact_resolution_intents
BEGIN SELECT RAISE(ABORT, 'work_artifact_resolution_intents are append-only'); END;

CREATE TABLE work_artifact_resolutions (
  artifact_id TEXT PRIMARY KEY REFERENCES work_artifacts(id),
  intent_id TEXT NOT NULL UNIQUE REFERENCES work_artifact_resolution_intents(id),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  outcome TEXT NOT NULL CHECK (outcome IN ('resolved', 'cancelled')),
  snapshot_id TEXT NOT NULL REFERENCES work_artifact_snapshots(id),
  external_revision TEXT NOT NULL CHECK (length(external_revision) BETWEEN 1 AND 512),
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0)
);
CREATE TRIGGER work_artifact_resolutions_append_only_update
BEFORE UPDATE ON work_artifact_resolutions
BEGIN SELECT RAISE(ABORT, 'work_artifact_resolutions are append-only'); END;
CREATE TRIGGER work_artifact_resolutions_append_only_delete
BEFORE DELETE ON work_artifact_resolutions
BEGIN SELECT RAISE(ABORT, 'work_artifact_resolutions are append-only'); END;
`] as const;

export const WORK_ARTIFACT_RELATIONSHIP_IDENTITY_MIGRATIONS = [String.raw`
CREATE TEMP TABLE work_artifact_relationship_identity_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO work_artifact_relationship_identity_guard (valid)
SELECT CASE WHEN EXISTS (
  SELECT 1
    FROM work_artifact_relationships
   WHERE (
     source_artifact_id IS NOT NULL AND source_ref <> ('artifact:' || source_artifact_id)
   ) OR (
     source_artifact_id IS NULL AND substr(source_ref, 1, 9) = 'artifact:'
   ) OR (
     target_artifact_id IS NOT NULL AND target_ref <> ('artifact:' || target_artifact_id)
   ) OR (
     target_artifact_id IS NULL AND substr(target_ref, 1, 9) = 'artifact:'
   ) OR (
     source_artifact_id IS NOT NULL AND source_artifact_id IS target_artifact_id
   ) OR source_ref = target_ref
) THEN 0 ELSE 1 END;

DROP TRIGGER IF EXISTS work_artifact_relationships_no_self_edge;
DROP TRIGGER IF EXISTS work_artifact_relationships_internal_refs;
CREATE TRIGGER work_artifact_relationships_internal_refs
BEFORE INSERT ON work_artifact_relationships
WHEN (
  NEW.source_artifact_id IS NOT NULL AND NEW.source_ref <> ('artifact:' || NEW.source_artifact_id)
) OR (
  NEW.source_artifact_id IS NULL AND substr(NEW.source_ref, 1, 9) = 'artifact:'
) OR (
  NEW.target_artifact_id IS NOT NULL AND NEW.target_ref <> ('artifact:' || NEW.target_artifact_id)
) OR (
  NEW.target_artifact_id IS NULL AND substr(NEW.target_ref, 1, 9) = 'artifact:'
)
BEGIN SELECT RAISE(ABORT, 'work artifact relationship internal refs must match artifact ids'); END;
CREATE TRIGGER work_artifact_relationships_no_self_edge
BEFORE INSERT ON work_artifact_relationships
WHEN (
  NEW.source_artifact_id IS NOT NULL AND
  NEW.source_artifact_id IS NEW.target_artifact_id
) OR NEW.source_ref = NEW.target_ref
BEGIN SELECT RAISE(ABORT, 'work artifact relationships cannot be self edges'); END;

CREATE TRIGGER work_artifact_relationships_internal_refs_update
BEFORE UPDATE ON work_artifact_relationships
WHEN (
  NEW.source_artifact_id IS NOT NULL AND NEW.source_ref <> ('artifact:' || NEW.source_artifact_id)
) OR (
  NEW.source_artifact_id IS NULL AND substr(NEW.source_ref, 1, 9) = 'artifact:'
) OR (
  NEW.target_artifact_id IS NOT NULL AND NEW.target_ref <> ('artifact:' || NEW.target_artifact_id)
) OR (
  NEW.target_artifact_id IS NULL AND substr(NEW.target_ref, 1, 9) = 'artifact:'
)
BEGIN SELECT RAISE(ABORT, 'work artifact relationship internal refs must match artifact ids'); END;
CREATE TRIGGER work_artifact_relationships_no_self_edge_update
BEFORE UPDATE ON work_artifact_relationships
WHEN (
  NEW.source_artifact_id IS NOT NULL AND
  NEW.source_artifact_id IS NEW.target_artifact_id
) OR NEW.source_ref = NEW.target_ref
BEGIN SELECT RAISE(ABORT, 'work artifact relationships cannot be self edges'); END;
CREATE TRIGGER work_artifact_relationships_same_effort_update
BEFORE UPDATE ON work_artifact_relationships
WHEN EXISTS (
  SELECT 1
    FROM work_artifacts AS owner
    JOIN work_artifacts AS related
      ON related.id IN (NEW.source_artifact_id, NEW.target_artifact_id)
   WHERE owner.id = NEW.owner_artifact_id
     AND (related.project_id <> owner.project_id OR related.effort_id <> owner.effort_id)
)
BEGIN SELECT RAISE(ABORT, 'work artifact relationships must stay in one effort'); END;
CREATE TRIGGER work_artifact_relationships_touch_owner_update
BEFORE UPDATE ON work_artifact_relationships
WHEN NEW.source_artifact_id IS NOT NEW.owner_artifact_id
 AND NEW.target_artifact_id IS NOT NEW.owner_artifact_id
BEGIN SELECT RAISE(ABORT, 'work artifact relationships must touch their owner'); END;

DROP TABLE work_artifact_relationship_identity_guard;
`] as const;

export const WORK_ARTIFACT_RELATIONSHIP_CANONICAL_MIGRATIONS = [String.raw`
CREATE TEMP TABLE work_artifact_relationship_canonical_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO work_artifact_relationship_canonical_guard (valid)
SELECT CASE WHEN EXISTS (
  SELECT 1
    FROM (
      SELECT owner_artifact_id,
             json_group_array(json(relationship_json)) AS relationships_json
        FROM (
          SELECT owner_artifact_id,
                 json_object(
                   'kind', kind,
                   'sourceArtifactId', source_artifact_id,
                   'sourceRef', source_ref,
                   'targetArtifactId', target_artifact_id,
                   'targetRef', target_ref
                 ) AS relationship_json
            FROM work_artifact_relationships
           ORDER BY owner_artifact_id, ordinal
        )
       GROUP BY owner_artifact_id
    ) AS current_relationships
   WHERE ${WORK_ARTIFACT_RELATIONSHIP_VALIDATOR_FUNCTION}(
     owner_artifact_id,
     relationships_json
   ) <> 1
) OR EXISTS (
  SELECT 1
    FROM work_artifact_snapshots
   WHERE ${WORK_ARTIFACT_RELATIONSHIP_VALIDATOR_FUNCTION}(
     artifact_id,
     relationships_json
   ) <> 1
) THEN 0 ELSE 1 END;

CREATE TRIGGER work_artifact_relationships_canonical_insert
BEFORE INSERT ON work_artifact_relationships
WHEN ${WORK_ARTIFACT_RELATIONSHIP_VALIDATOR_FUNCTION}(
  NEW.owner_artifact_id,
  (
    SELECT json_group_array(json(relationship_json))
      FROM (
        SELECT json_object(
                 'kind', kind,
                 'sourceArtifactId', source_artifact_id,
                 'sourceRef', source_ref,
                 'targetArtifactId', target_artifact_id,
                 'targetRef', target_ref
               ) AS relationship_json
          FROM work_artifact_relationships
         WHERE owner_artifact_id = NEW.owner_artifact_id
        UNION ALL
        SELECT json_object(
                 'kind', NEW.kind,
                 'sourceArtifactId', NEW.source_artifact_id,
                 'sourceRef', NEW.source_ref,
                 'targetArtifactId', NEW.target_artifact_id,
                 'targetRef', NEW.target_ref
               )
      )
  )
) <> 1
BEGIN SELECT RAISE(ABORT, 'work artifact relationship violates the canonical model'); END;

CREATE TRIGGER work_artifact_relationships_canonical_update
BEFORE UPDATE ON work_artifact_relationships
WHEN ${WORK_ARTIFACT_RELATIONSHIP_VALIDATOR_FUNCTION}(
  NEW.owner_artifact_id,
  (
    SELECT json_group_array(json(relationship_json))
      FROM (
        SELECT json_object(
                 'kind', kind,
                 'sourceArtifactId', source_artifact_id,
                 'sourceRef', source_ref,
                 'targetArtifactId', target_artifact_id,
                 'targetRef', target_ref
               ) AS relationship_json
          FROM work_artifact_relationships
         WHERE owner_artifact_id = NEW.owner_artifact_id
           AND rowid <> OLD.rowid
        UNION ALL
        SELECT json_object(
                 'kind', NEW.kind,
                 'sourceArtifactId', NEW.source_artifact_id,
                 'sourceRef', NEW.source_ref,
                 'targetArtifactId', NEW.target_artifact_id,
                 'targetRef', NEW.target_ref
               )
      )
  )
) <> 1
BEGIN SELECT RAISE(ABORT, 'work artifact relationship violates the canonical model'); END;

CREATE TRIGGER work_artifact_snapshots_relationships_canonical_insert
BEFORE INSERT ON work_artifact_snapshots
WHEN ${WORK_ARTIFACT_RELATIONSHIP_VALIDATOR_FUNCTION}(
  NEW.artifact_id,
  NEW.relationships_json
) <> 1
BEGIN SELECT RAISE(ABORT, 'work artifact snapshot relationships violate the canonical model'); END;

DROP TABLE work_artifact_relationship_canonical_guard;
`] as const;

export const NAVIGATOR_WORKFLOW_MIGRATIONS = [String.raw`
ALTER TABLE jobs ADD COLUMN workflow_engine TEXT NOT NULL DEFAULT 'recipe-v1'
  CHECK (workflow_engine IN ('recipe-v1', 'navigator-v1'));
ALTER TABLE jobs ADD COLUMN workflow_mode TEXT NOT NULL DEFAULT 'live'
  CHECK (workflow_mode IN ('live', 'shadow', 'deterministic'));
ALTER TABLE jobs ADD COLUMN workflow_revision INTEGER NOT NULL DEFAULT 1
  CHECK (workflow_revision >= 1);
ALTER TABLE jobs ADD COLUMN current_workflow_step_id TEXT;
ALTER TABLE jobs ADD COLUMN artifact_bindings_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE navigator_snapshots (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  job_version INTEGER NOT NULL,
  workflow_revision INTEGER NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  external_state_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(job_id, job_version, workflow_revision, digest)
);
CREATE TRIGGER navigator_snapshots_append_only_update
BEFORE UPDATE ON navigator_snapshots
BEGIN SELECT RAISE(ABORT, 'navigator snapshots are append-only'); END;
CREATE TRIGGER navigator_snapshots_append_only_delete
BEFORE DELETE ON navigator_snapshots
BEGIN SELECT RAISE(ABORT, 'navigator snapshots are append-only'); END;

CREATE TABLE navigator_proposals (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  snapshot_id TEXT NOT NULL REFERENCES navigator_snapshots(id),
  digest TEXT NOT NULL,
  kind TEXT,
  raw_json TEXT NOT NULL,
  proposal_json TEXT,
  observation_json TEXT NOT NULL,
  observation_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(snapshot_id, digest)
);
CREATE TRIGGER navigator_proposals_append_only_update
BEFORE UPDATE ON navigator_proposals
BEGIN SELECT RAISE(ABORT, 'navigator proposals are append-only'); END;
CREATE TRIGGER navigator_proposals_append_only_delete
BEFORE DELETE ON navigator_proposals
BEGIN SELECT RAISE(ABORT, 'navigator proposals are append-only'); END;

CREATE TABLE navigator_decisions (
  proposal_id TEXT PRIMARY KEY REFERENCES navigator_proposals(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  snapshot_id TEXT NOT NULL REFERENCES navigator_snapshots(id),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'shadowed')),
  reason_code TEXT NOT NULL,
  decided_at INTEGER NOT NULL
);
CREATE TRIGGER navigator_decisions_append_only_update
BEFORE UPDATE ON navigator_decisions
BEGIN SELECT RAISE(ABORT, 'navigator decisions are append-only'); END;
CREATE TRIGGER navigator_decisions_append_only_delete
BEFORE DELETE ON navigator_decisions
BEGIN SELECT RAISE(ABORT, 'navigator decisions are append-only'); END;

CREATE TABLE workflow_step_contracts (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  skill_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(id, revision)
);
CREATE TRIGGER workflow_step_contracts_append_only_update
BEFORE UPDATE ON workflow_step_contracts
BEGIN SELECT RAISE(ABORT, 'workflow step contracts are append-only'); END;
CREATE TRIGGER workflow_step_contracts_append_only_delete
BEFORE DELETE ON workflow_step_contracts
BEGIN SELECT RAISE(ABORT, 'workflow step contracts are append-only'); END;

CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES navigator_proposals(id),
  snapshot_id TEXT NOT NULL REFERENCES navigator_snapshots(id),
  skill_id TEXT NOT NULL,
  job_version INTEGER NOT NULL,
  workflow_revision INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL
);
CREATE TRIGGER workflow_steps_append_only_update
BEFORE UPDATE ON workflow_steps
BEGIN SELECT RAISE(ABORT, 'workflow steps are append-only'); END;
CREATE TRIGGER workflow_steps_append_only_delete
BEFORE DELETE ON workflow_steps
BEGIN SELECT RAISE(ABORT, 'workflow steps are append-only'); END;

CREATE TABLE navigator_skill_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  workflow_step_id TEXT NOT NULL UNIQUE REFERENCES workflow_steps(id),
  effect_idempotency_key TEXT NOT NULL UNIQUE REFERENCES effects(idempotency_key),
  skill_id TEXT NOT NULL,
  skill_revision TEXT NOT NULL,
  skill_source_digest TEXT NOT NULL,
  descriptor_digest TEXT NOT NULL,
  step_contract_id TEXT NOT NULL,
  step_contract_revision INTEGER NOT NULL,
  step_contract_digest TEXT NOT NULL,
  catalog_digest TEXT NOT NULL,
  step_input_json TEXT NOT NULL,
  step_input_digest TEXT NOT NULL,
  model_route_json TEXT NOT NULL,
  artifact_bindings_json TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  job_version INTEGER NOT NULL,
  workflow_revision INTEGER NOT NULL,
  resource_kind TEXT CHECK (resource_kind IS NULL OR resource_kind = 'bb_thread'),
  resource_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((resource_kind IS NULL) = (resource_id IS NULL)),
  FOREIGN KEY (step_contract_id, step_contract_revision)
    REFERENCES workflow_step_contracts(id, revision)
);
CREATE TRIGGER navigator_skill_attempts_immutable_identity
BEFORE UPDATE ON navigator_skill_attempts
WHEN NEW.id <> OLD.id
  OR NEW.job_id <> OLD.job_id
  OR NEW.workflow_step_id <> OLD.workflow_step_id
  OR NEW.effect_idempotency_key <> OLD.effect_idempotency_key
  OR NEW.skill_id <> OLD.skill_id
  OR NEW.skill_revision <> OLD.skill_revision
  OR NEW.skill_source_digest <> OLD.skill_source_digest
  OR NEW.descriptor_digest <> OLD.descriptor_digest
  OR NEW.step_contract_id <> OLD.step_contract_id
  OR NEW.step_contract_revision <> OLD.step_contract_revision
  OR NEW.step_contract_digest <> OLD.step_contract_digest
  OR NEW.catalog_digest <> OLD.catalog_digest
  OR NEW.step_input_json <> OLD.step_input_json
  OR NEW.step_input_digest <> OLD.step_input_digest
  OR NEW.model_route_json <> OLD.model_route_json
  OR NEW.artifact_bindings_json <> OLD.artifact_bindings_json
  OR NEW.snapshot_digest <> OLD.snapshot_digest
  OR NEW.job_version <> OLD.job_version
  OR NEW.workflow_revision <> OLD.workflow_revision
  OR NEW.created_at <> OLD.created_at
  OR (OLD.resource_kind IS NOT NULL AND (
    NEW.resource_kind IS NOT OLD.resource_kind OR NEW.resource_id IS NOT OLD.resource_id
  ))
BEGIN SELECT RAISE(ABORT, 'navigator skill attempt identity is immutable'); END;
CREATE TRIGGER navigator_skill_attempts_no_delete
BEFORE DELETE ON navigator_skill_attempts
BEGIN SELECT RAISE(ABORT, 'navigator skill attempts cannot be deleted'); END;

CREATE TABLE workflow_step_outcomes (
  workflow_step_id TEXT PRIMARY KEY REFERENCES workflow_steps(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES navigator_skill_attempts(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'policy_failure')),
  reason_code TEXT NOT NULL,
  summary TEXT NOT NULL,
  artifact_evidence_json TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE TRIGGER workflow_step_outcomes_append_only_update
BEFORE UPDATE ON workflow_step_outcomes
BEGIN SELECT RAISE(ABORT, 'workflow step outcomes are append-only'); END;
CREATE TRIGGER workflow_step_outcomes_append_only_delete
BEFORE DELETE ON workflow_step_outcomes
BEGIN SELECT RAISE(ABORT, 'workflow step outcomes are append-only'); END;

CREATE TABLE workflow_step_supersessions (
  workflow_step_id TEXT PRIMARY KEY REFERENCES workflow_steps(id),
  superseded_by_step_id TEXT REFERENCES workflow_steps(id),
  reason TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  CHECK (superseded_by_step_id IS NULL OR superseded_by_step_id <> workflow_step_id)
);
CREATE TRIGGER workflow_step_supersessions_append_only_update
BEFORE UPDATE ON workflow_step_supersessions
BEGIN SELECT RAISE(ABORT, 'workflow step supersessions are append-only'); END;
CREATE TRIGGER workflow_step_supersessions_append_only_delete
BEFORE DELETE ON workflow_step_supersessions
BEGIN SELECT RAISE(ABORT, 'workflow step supersessions are append-only'); END;
`] as const;

export const NAVIGATOR_PLANNING_MIGRATIONS = [String.raw`
CREATE TABLE work_artifact_snapshot_dependencies (
  snapshot_id TEXT NOT NULL REFERENCES work_artifact_snapshots(id),
  upstream_snapshot_id TEXT NOT NULL REFERENCES work_artifact_snapshots(id),
  PRIMARY KEY(snapshot_id, upstream_snapshot_id),
  CHECK(snapshot_id <> upstream_snapshot_id)
);
CREATE TRIGGER work_artifact_snapshot_dependencies_append_only_update
BEFORE UPDATE ON work_artifact_snapshot_dependencies
BEGIN SELECT RAISE(ABORT, 'work artifact snapshot dependencies are append-only'); END;
CREATE TRIGGER work_artifact_snapshot_dependencies_append_only_delete
BEFORE DELETE ON work_artifact_snapshot_dependencies
BEGIN SELECT RAISE(ABORT, 'work artifact snapshot dependencies are append-only'); END;

INSERT INTO work_artifact_snapshot_dependencies (snapshot_id, upstream_snapshot_id)
SELECT downstream.id, upstream.id
  FROM work_artifact_snapshots AS downstream
  JOIN json_each(downstream.relationships_json) AS relationship
  JOIN work_artifact_snapshots AS upstream
    ON upstream.id = (
      SELECT candidate.id
        FROM work_artifact_snapshots AS candidate
       WHERE candidate.artifact_id = json_extract(relationship.value, '$.targetArtifactId')
         AND candidate.captured_at <= downstream.captured_at
       ORDER BY candidate.captured_at DESC, candidate.revision DESC
       LIMIT 1
    )
 WHERE json_extract(relationship.value, '$.kind') = 'derived_from'
   AND json_type(relationship.value, '$.targetArtifactId') = 'text'
GROUP BY downstream.id, upstream.id;

CREATE TABLE navigator_planning_results (
  attempt_id TEXT PRIMARY KEY REFERENCES navigator_skill_attempts(id),
  workflow_step_id TEXT NOT NULL UNIQUE REFERENCES workflow_steps(id),
  skill_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  observed_external_state_digest TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE TRIGGER navigator_planning_results_append_only_update
BEFORE UPDATE ON navigator_planning_results
BEGIN SELECT RAISE(ABORT, 'navigator planning results are append-only'); END;
CREATE TRIGGER navigator_planning_results_append_only_delete
BEFORE DELETE ON navigator_planning_results
BEGIN SELECT RAISE(ABORT, 'navigator planning results are append-only'); END;

CREATE TABLE navigator_routing_decisions (
  decision_digest TEXT PRIMARY KEY,
  scope_digest TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  question TEXT NOT NULL,
  candidate_skill_ids_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  consultation_step_id TEXT NOT NULL UNIQUE REFERENCES workflow_steps(id),
  recorded_at INTEGER NOT NULL
);
CREATE TRIGGER navigator_routing_decisions_append_only_update
BEFORE UPDATE ON navigator_routing_decisions
BEGIN SELECT RAISE(ABORT, 'navigator routing decisions are append-only'); END;
CREATE TRIGGER navigator_routing_decisions_append_only_delete
BEFORE DELETE ON navigator_routing_decisions
BEGIN SELECT RAISE(ABORT, 'navigator routing decisions are append-only'); END;

CREATE TABLE navigator_routing_advice (
  decision_digest TEXT PRIMARY KEY REFERENCES navigator_routing_decisions(decision_digest),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES navigator_skill_attempts(id),
  advice_json TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE TRIGGER navigator_routing_advice_append_only_update
BEFORE UPDATE ON navigator_routing_advice
BEGIN SELECT RAISE(ABORT, 'navigator routing advice is append-only'); END;
CREATE TRIGGER navigator_routing_advice_append_only_delete
BEFORE DELETE ON navigator_routing_advice
BEGIN SELECT RAISE(ABORT, 'navigator routing advice is append-only'); END;

CREATE TABLE navigator_routing_blocks (
  decision_digest TEXT PRIMARY KEY REFERENCES navigator_routing_decisions(decision_digest),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES navigator_proposals(id),
  reason TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE TRIGGER navigator_routing_blocks_append_only_update
BEFORE UPDATE ON navigator_routing_blocks
BEGIN SELECT RAISE(ABORT, 'navigator routing blocks are append-only'); END;
CREATE TRIGGER navigator_routing_blocks_append_only_delete
BEFORE DELETE ON navigator_routing_blocks
BEGIN SELECT RAISE(ABORT, 'navigator routing blocks are append-only'); END;
`] as const;

export const NAVIGATOR_IMPLEMENTATION_MIGRATIONS = [String.raw`
CREATE TABLE navigator_integrations (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  specification_artifact_id TEXT NOT NULL REFERENCES work_artifacts(id),
  specification_snapshot_id TEXT NOT NULL REFERENCES work_artifact_snapshots(id),
  specification_snapshot_digest TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  integration_branch TEXT NOT NULL UNIQUE,
  worktree_id TEXT NOT NULL UNIQUE,
  project_policy_version INTEGER NOT NULL CHECK (project_policy_version >= 1),
  project_policy_json TEXT NOT NULL,
  project_policy_digest TEXT NOT NULL,
  base_head_sha TEXT NOT NULL,
  current_head_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'implementing', 'invalidated', 'ready_for_pull_request', 'publishing_pull_request', 'ready_for_release'
  )),
  active_slice_id TEXT,
  pull_request_number INTEGER,
  pull_request_url TEXT,
  evidence_refs_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((pull_request_number IS NULL) = (pull_request_url IS NULL))
);

CREATE TABLE navigator_integration_tickets (
  job_id TEXT NOT NULL REFERENCES navigator_integrations(job_id),
  artifact_id TEXT NOT NULL REFERENCES work_artifacts(id),
  snapshot_id TEXT NOT NULL REFERENCES work_artifact_snapshots(id),
  snapshot_digest TEXT NOT NULL,
  ticket_order INTEGER NOT NULL CHECK (ticket_order >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'accepted', 'resolved', 'invalidated')),
  accepted_head_sha TEXT,
  resolved_at INTEGER,
  PRIMARY KEY(job_id, artifact_id),
  UNIQUE(job_id, ticket_order),
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE TABLE navigator_ticket_slices (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES navigator_integrations(job_id),
  ticket_artifact_id TEXT NOT NULL REFERENCES work_artifacts(id),
  ticket_snapshot_id TEXT NOT NULL REFERENCES work_artifact_snapshots(id),
  ticket_snapshot_digest TEXT NOT NULL,
  claim_id INTEGER NOT NULL REFERENCES work_artifact_claims(id),
  integration_base_head_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'implementation_pending', 'implementation_running', 'review_pending', 'review_running',
    'repair_pending', 'accepted', 'resolved', 'invalidated'
  )),
  accepted_head_sha TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id, ticket_artifact_id)
);

CREATE UNIQUE INDEX navigator_ticket_slices_one_active_writer
  ON navigator_ticket_slices(job_id)
  WHERE state IN ('implementation_pending', 'implementation_running', 'review_pending', 'review_running', 'repair_pending');

CREATE TABLE navigator_ticket_worker_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES navigator_integrations(job_id),
  slice_id TEXT NOT NULL REFERENCES navigator_ticket_slices(id),
  kind TEXT NOT NULL CHECK (kind IN ('implementation', 'review')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  effect_idempotency_key TEXT NOT NULL UNIQUE REFERENCES effects(idempotency_key),
  work_order_json TEXT NOT NULL,
  work_order_digest TEXT NOT NULL,
  step_contract_id TEXT NOT NULL,
  step_contract_revision INTEGER NOT NULL CHECK (step_contract_revision >= 1),
  step_contract_digest TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  profile_digest TEXT NOT NULL,
  model_route_json TEXT NOT NULL,
  resource_kind TEXT CHECK (resource_kind IS NULL OR resource_kind = 'bb_thread'),
  resource_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(slice_id, kind, ordinal),
  CHECK ((resource_kind IS NULL) = (resource_id IS NULL))
);

CREATE TRIGGER navigator_ticket_worker_attempts_immutable_identity
BEFORE UPDATE ON navigator_ticket_worker_attempts
WHEN NEW.id <> OLD.id
  OR NEW.job_id <> OLD.job_id
  OR NEW.slice_id <> OLD.slice_id
  OR NEW.kind <> OLD.kind
  OR NEW.ordinal <> OLD.ordinal
  OR NEW.effect_idempotency_key <> OLD.effect_idempotency_key
  OR NEW.work_order_json <> OLD.work_order_json
  OR NEW.work_order_digest <> OLD.work_order_digest
  OR NEW.step_contract_id <> OLD.step_contract_id
  OR NEW.step_contract_revision <> OLD.step_contract_revision
  OR NEW.step_contract_digest <> OLD.step_contract_digest
  OR NEW.profile_json <> OLD.profile_json
  OR NEW.profile_digest <> OLD.profile_digest
  OR NEW.model_route_json <> OLD.model_route_json
  OR NEW.created_at <> OLD.created_at
  OR (OLD.resource_kind IS NOT NULL AND (
    NEW.resource_kind IS NOT OLD.resource_kind OR NEW.resource_id IS NOT OLD.resource_id
  ))
BEGIN SELECT RAISE(ABORT, 'navigator ticket worker attempt identity is immutable'); END;

CREATE TRIGGER navigator_ticket_worker_attempts_no_delete
BEFORE DELETE ON navigator_ticket_worker_attempts
BEGIN SELECT RAISE(ABORT, 'navigator ticket worker attempts cannot be deleted'); END;

CREATE TABLE navigator_ticket_worker_outcomes (
  attempt_id TEXT PRIMARY KEY REFERENCES navigator_ticket_worker_attempts(id),
  slice_id TEXT NOT NULL REFERENCES navigator_ticket_slices(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'findings', 'worker_unavailable', 'policy_failure')),
  reason_code TEXT NOT NULL,
  exact_head_sha TEXT NOT NULL,
  result_json TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE TRIGGER navigator_ticket_worker_outcomes_append_only_update
BEFORE UPDATE ON navigator_ticket_worker_outcomes
BEGIN SELECT RAISE(ABORT, 'navigator ticket worker outcomes are append-only'); END;
CREATE TRIGGER navigator_ticket_worker_outcomes_append_only_delete
BEFORE DELETE ON navigator_ticket_worker_outcomes
BEGIN SELECT RAISE(ABORT, 'navigator ticket worker outcomes are append-only'); END;

CREATE TABLE navigator_pull_requests (
  job_id TEXT PRIMARY KEY REFERENCES navigator_integrations(job_id),
  operation_id TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'published')),
  number INTEGER,
  url TEXT,
  head_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  CHECK ((status = 'published') = (number IS NOT NULL AND url IS NOT NULL AND settled_at IS NOT NULL))
);

CREATE TRIGGER navigator_pull_requests_immutable_request
BEFORE UPDATE ON navigator_pull_requests
WHEN NEW.job_id <> OLD.job_id
  OR NEW.operation_id <> OLD.operation_id
  OR NEW.request_json <> OLD.request_json
  OR NEW.request_digest <> OLD.request_digest
  OR NEW.head_sha <> OLD.head_sha
  OR NEW.created_at <> OLD.created_at
  OR OLD.status = 'published'
BEGIN SELECT RAISE(ABORT, 'navigator pull request identity is immutable'); END;
CREATE TRIGGER navigator_pull_requests_no_delete
BEFORE DELETE ON navigator_pull_requests
BEGIN SELECT RAISE(ABORT, 'navigator pull requests cannot be deleted'); END;
`] as const;

export const NAVIGATOR_IMPLEMENTATION_UPGRADE_MIGRATIONS = [String.raw`
ALTER TABLE navigator_ticket_worker_attempts
  ADD COLUMN step_contract_json TEXT NOT NULL DEFAULT '';

UPDATE navigator_ticket_worker_attempts
   SET step_contract_json = CASE
     WHEN step_contract_id = 'navigator-ticket-implementation' AND step_contract_revision = 1 THEN
       '{"id":"navigator-ticket-implementation","revision":1,"skillId":"implement","freshContext":true,"codeWriting":true,"resourceClass":"managed_integration_worktree","resultSchema":"navigator-implementation-result-v1","mandatoryEvidence":["ticket_snapshot","specification_snapshot","focused_verification","full_verification"],"modelPools":["standard","strong"],"timeoutMs":14400000,"maximumResultBytes":256000,"digest":"c3d183d0b7c961ad1cbc223aa38a025f6ec8b52496e40137ce5e7bd6ae77f851"}'
     WHEN step_contract_id = 'navigator-ticket-code-review' AND step_contract_revision = 1 THEN
       '{"id":"navigator-ticket-code-review","revision":1,"skillId":"code-review","freshContext":true,"codeWriting":false,"resourceClass":"managed_integration_worktree","resultSchema":"navigator-code-review-result-v1","mandatoryEvidence":["ticket_snapshot","specification_snapshot","exact_head_review"],"modelPools":["strong"],"timeoutMs":3600000,"maximumResultBytes":256000,"digest":"cd460fc7ac1f32321ff9a9072332fbadec39b235e02f5a4e0894367b74199329"}'
     WHEN step_contract_id = 'navigator-ticket-implementation' AND step_contract_revision = 2 THEN
       '{"id":"navigator-ticket-implementation","revision":2,"skillId":"implement","freshContext":true,"codeWriting":true,"resourceClass":"managed_integration_worktree","resultSchema":"navigator-implementation-result-v1","mandatoryEvidence":["ticket_snapshot","specification_snapshot","focused_verification","full_verification"],"modelPools":["standard","strong"],"timeoutMs":14400000,"maximumResultBytes":256000,"retryClass":"bounded_exponential","maximumAttempts":5,"backoffBaseMs":500,"backoffMaximumMs":30000,"digest":"265975681ea5dbd57a9bf428532400ea72fd9f5a96110cf47fcb4da2de19987b"}'
     WHEN step_contract_id = 'navigator-ticket-code-review' AND step_contract_revision = 2 THEN
       '{"id":"navigator-ticket-code-review","revision":2,"skillId":"code-review","freshContext":true,"codeWriting":false,"resourceClass":"managed_integration_worktree","resultSchema":"navigator-code-review-result-v1","mandatoryEvidence":["ticket_snapshot","specification_snapshot","exact_head_review"],"modelPools":["strong"],"timeoutMs":3600000,"maximumResultBytes":256000,"retryClass":"bounded_exponential","maximumAttempts":5,"backoffBaseMs":500,"backoffMaximumMs":30000,"digest":"b32624e6c687619ad840747a023b9f918108b8a409308f935723eb99de5f2f3c"}'
     ELSE NULL
   END;

DROP TRIGGER navigator_ticket_worker_attempts_immutable_identity;
CREATE TRIGGER navigator_ticket_worker_attempts_immutable_identity
BEFORE UPDATE ON navigator_ticket_worker_attempts
WHEN NEW.id <> OLD.id
  OR NEW.job_id <> OLD.job_id
  OR NEW.slice_id <> OLD.slice_id
  OR NEW.kind <> OLD.kind
  OR NEW.ordinal <> OLD.ordinal
  OR NEW.effect_idempotency_key <> OLD.effect_idempotency_key
  OR NEW.work_order_json <> OLD.work_order_json
  OR NEW.work_order_digest <> OLD.work_order_digest
  OR NEW.step_contract_id <> OLD.step_contract_id
  OR NEW.step_contract_revision <> OLD.step_contract_revision
  OR NEW.step_contract_digest <> OLD.step_contract_digest
  OR NEW.step_contract_json <> OLD.step_contract_json
  OR NEW.profile_json <> OLD.profile_json
  OR NEW.profile_digest <> OLD.profile_digest
  OR NEW.model_route_json <> OLD.model_route_json
  OR NEW.created_at <> OLD.created_at
  OR (OLD.resource_kind IS NOT NULL AND (
    NEW.resource_kind IS NOT OLD.resource_kind OR NEW.resource_id IS NOT OLD.resource_id
  ))
BEGIN SELECT RAISE(ABORT, 'navigator ticket worker attempt identity is immutable'); END;

DROP TRIGGER navigator_ticket_worker_outcomes_append_only_update;
DROP TRIGGER navigator_ticket_worker_outcomes_append_only_delete;
ALTER TABLE navigator_ticket_worker_outcomes RENAME TO navigator_ticket_worker_outcomes_before_upgrade;
CREATE TABLE navigator_ticket_worker_outcomes (
  attempt_id TEXT PRIMARY KEY REFERENCES navigator_ticket_worker_attempts(id),
  slice_id TEXT NOT NULL REFERENCES navigator_ticket_slices(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'findings', 'worker_unavailable', 'policy_failure', 'dead_letter')),
  reason_code TEXT NOT NULL,
  exact_head_sha TEXT NOT NULL,
  result_json TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  git_observation_json TEXT,
  git_observation_digest TEXT,
  recorded_at INTEGER NOT NULL,
  CHECK ((git_observation_json IS NULL) = (git_observation_digest IS NULL))
);
INSERT INTO navigator_ticket_worker_outcomes (
  attempt_id, slice_id, outcome, reason_code, exact_head_sha,
  result_json, result_digest, git_observation_json, git_observation_digest, recorded_at
)
SELECT attempt_id, slice_id, outcome, reason_code, exact_head_sha,
       result_json, result_digest, NULL, NULL, recorded_at
  FROM navigator_ticket_worker_outcomes_before_upgrade;
DROP TABLE navigator_ticket_worker_outcomes_before_upgrade;

CREATE TRIGGER navigator_ticket_worker_outcomes_append_only_update
BEFORE UPDATE ON navigator_ticket_worker_outcomes
BEGIN SELECT RAISE(ABORT, 'navigator ticket worker outcomes are append-only'); END;
CREATE TRIGGER navigator_ticket_worker_outcomes_append_only_delete
BEFORE DELETE ON navigator_ticket_worker_outcomes
BEGIN SELECT RAISE(ABORT, 'navigator ticket worker outcomes are append-only'); END;

CREATE TABLE navigator_ticket_repair_snapshots (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES navigator_integrations(job_id),
  slice_id TEXT NOT NULL REFERENCES navigator_ticket_slices(id),
  review_attempt_id TEXT NOT NULL UNIQUE REFERENCES navigator_ticket_worker_attempts(id),
  snapshot_json TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER navigator_ticket_repair_snapshots_append_only_update
BEFORE UPDATE ON navigator_ticket_repair_snapshots
BEGIN SELECT RAISE(ABORT, 'navigator ticket repair snapshots are append-only'); END;
CREATE TRIGGER navigator_ticket_repair_snapshots_append_only_delete
BEFORE DELETE ON navigator_ticket_repair_snapshots
BEGIN SELECT RAISE(ABORT, 'navigator ticket repair snapshots are append-only'); END;

CREATE TABLE navigator_ticket_repair_proposals (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES navigator_ticket_repair_snapshots(id),
  route TEXT NOT NULL CHECK (route IN ('implementation', 'diagnosis', 'research', 'owner_boundary')),
  proposal_json TEXT NOT NULL,
  proposal_digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision = 'accepted'),
  accepted_at INTEGER NOT NULL
);

CREATE TRIGGER navigator_ticket_repair_proposals_append_only_update
BEFORE UPDATE ON navigator_ticket_repair_proposals
BEGIN SELECT RAISE(ABORT, 'navigator ticket repair proposals are append-only'); END;
CREATE TRIGGER navigator_ticket_repair_proposals_append_only_delete
BEFORE DELETE ON navigator_ticket_repair_proposals
BEGIN SELECT RAISE(ABORT, 'navigator ticket repair proposals are append-only'); END;

CREATE TABLE navigator_ticket_repair_dispatches (
  proposal_id TEXT PRIMARY KEY REFERENCES navigator_ticket_repair_proposals(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES navigator_ticket_worker_attempts(id),
  dispatched_at INTEGER NOT NULL
);

CREATE TRIGGER navigator_ticket_repair_dispatches_append_only_update
BEFORE UPDATE ON navigator_ticket_repair_dispatches
BEGIN SELECT RAISE(ABORT, 'navigator ticket repair dispatches are append-only'); END;
CREATE TRIGGER navigator_ticket_repair_dispatches_append_only_delete
BEFORE DELETE ON navigator_ticket_repair_dispatches
BEGIN SELECT RAISE(ABORT, 'navigator ticket repair dispatches are append-only'); END;
`] as const;

export const TASK_AUTHORITY_MIGRATIONS = [String.raw`
ALTER TABLE jobs ADD COLUMN task_outcome TEXT CHECK (task_outcome IN ('artifact', 'reviewed_change', 'shipped_change'));
ALTER TABLE jobs ADD COLUMN task_constraints_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE task_authorities (
  authority_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  owner_user_id TEXT NOT NULL,
  owner_chat_id TEXT NOT NULL,
  controller_key TEXT NOT NULL REFERENCES controller_threads(controller_key),
  source_update_id INTEGER NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest GLOB '[0-9a-f]*' AND length(request_digest) = 64),
  project_id TEXT NOT NULL,
  task_outcome TEXT NOT NULL CHECK (task_outcome IN ('artifact', 'reviewed_change', 'shipped_change')),
  scope_digest TEXT NOT NULL CHECK (scope_digest GLOB '[0-9a-f]*' AND length(scope_digest) = 64),
  constraints_json TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  policy_digest TEXT NOT NULL CHECK (policy_digest GLOB '[0-9a-f]*' AND length(policy_digest) = 64),
  artifact_graph_digest TEXT NOT NULL CHECK (artifact_graph_digest GLOB '[0-9a-f]*' AND length(artifact_graph_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'suspended', 'superseded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT,
  superseded_at INTEGER,
  superseded_reason TEXT,
  CHECK ((status IN ('revoked', 'suspended') AND revoked_at IS NOT NULL) OR
         (status IN ('active', 'superseded') AND revoked_at IS NULL)),
  CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))
);
CREATE INDEX task_authorities_job_status ON task_authorities(job_id, status, revision);

CREATE TABLE task_authority_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  authority_id TEXT NOT NULL REFERENCES task_authorities(authority_id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  action TEXT NOT NULL CHECK (action IN ('granted', 'revised', 'revoked', 'suspended', 'superseded')),
  reason TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX task_authority_events_job ON task_authority_events(job_id, occurred_at, id);
`] as const;

export const RELEASE_AUTHORITY_MIGRATIONS = [String.raw`
CREATE TABLE release_authority_receipts (
  receipt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  effect_idempotency_key TEXT NOT NULL UNIQUE,
  authority_id TEXT REFERENCES task_authorities(authority_id),
  authority_revision INTEGER,
  authority_source TEXT NOT NULL CHECK (authority_source IN ('task', 'explicit', 'button', 'policy')),
  project_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  pr_number INTEGER NOT NULL CHECK (pr_number >= 1),
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
  artifact_graph_digest TEXT,
  review_attempt_id TEXT NOT NULL,
  validation_completed_at INTEGER NOT NULL,
  required_check_names_json TEXT NOT NULL,
  merge_method TEXT NOT NULL CHECK (merge_method IN ('merge', 'rebase', 'squash')),
  production_policy_digest TEXT,
  gate_receipt_digest TEXT NOT NULL CHECK (length(gate_receipt_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT,
  CHECK ((authority_source = 'task') = (
    authority_id IS NOT NULL AND authority_revision IS NOT NULL AND artifact_graph_digest IS NOT NULL
  )),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX release_authority_receipts_job ON release_authority_receipts(job_id, status, created_at);
`] as const;

export const OWNER_BOUNDARY_MIGRATIONS = [String.raw`
CREATE TABLE owner_boundaries (
  boundary_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  digest TEXT NOT NULL,
  authority_id TEXT NOT NULL REFERENCES task_authorities(authority_id),
  authority_revision INTEGER NOT NULL CHECK (authority_revision >= 1),
  code TEXT NOT NULL CHECK (code IN (
    'product_decision_required', 'scope_expansion_required',
    'credential_or_access_required', 'spend_authority_required',
    'irreversible_effect_required', 'policy_change_required',
    'technical_tradeoff_required', 'production_recovery_required'
  )),
  goal TEXT NOT NULL,
  blocker TEXT NOT NULL,
  prior_checks_json TEXT NOT NULL,
  options_json TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  paused_effect TEXT NOT NULL,
  affected_artifact_id TEXT,
  affected_effect_idempotency_key TEXT,
  owner_user_id TEXT NOT NULL,
  owner_chat_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  answered_at INTEGER,
  answer_text TEXT,
  answer_digest TEXT,
  revoked_at INTEGER,
  revoked_reason TEXT,
  UNIQUE(job_id, digest),
  CHECK (affected_artifact_id IS NOT NULL OR affected_effect_idempotency_key IS NOT NULL),
  CHECK ((status = 'pending' AND answered_at IS NULL AND answer_text IS NULL AND answer_digest IS NULL AND revoked_at IS NULL) OR
         (status = 'answered' AND answered_at IS NOT NULL AND answer_text IS NOT NULL AND answer_digest IS NOT NULL AND revoked_at IS NULL) OR
         (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_reason IS NOT NULL AND answered_at IS NULL AND answer_text IS NULL AND answer_digest IS NULL))
);
CREATE INDEX owner_boundaries_reply ON owner_boundaries(owner_chat_id, status, created_at);
CREATE INDEX owner_boundaries_job ON owner_boundaries(job_id, status, created_at);

CREATE TABLE owner_boundary_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  boundary_id TEXT NOT NULL REFERENCES owner_boundaries(boundary_id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  action TEXT NOT NULL CHECK (action IN ('created', 'answered', 'revoked')),
  reason TEXT,
  answer_digest TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX owner_boundary_events_job ON owner_boundary_events(job_id, occurred_at, id);
`] as const;

export const TASK_AUTHORITY_REVISION_MIGRATIONS = [String.raw`
ALTER TABLE owner_boundaries ADD COLUMN evidence_facts_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE task_authority_revisions (
  authority_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  owner_user_id TEXT NOT NULL,
  owner_chat_id TEXT NOT NULL,
  controller_key TEXT NOT NULL REFERENCES controller_threads(controller_key),
  source_update_id INTEGER NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest GLOB '[0-9a-f]*' AND length(request_digest) = 64),
  project_id TEXT NOT NULL,
  task_outcome TEXT NOT NULL CHECK (task_outcome IN ('artifact', 'reviewed_change', 'shipped_change')),
  scope_digest TEXT NOT NULL CHECK (scope_digest GLOB '[0-9a-f]*' AND length(scope_digest) = 64),
  constraints_json TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  policy_digest TEXT NOT NULL CHECK (policy_digest GLOB '[0-9a-f]*' AND length(policy_digest) = 64),
  artifact_graph_digest TEXT NOT NULL CHECK (artifact_graph_digest GLOB '[0-9a-f]*' AND length(artifact_graph_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'suspended', 'superseded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT,
  superseded_at INTEGER,
  superseded_reason TEXT,
  PRIMARY KEY (authority_id, revision),
  UNIQUE (job_id, revision),
  CHECK ((status IN ('revoked', 'suspended') AND revoked_at IS NOT NULL) OR
         (status IN ('active', 'superseded') AND revoked_at IS NULL)),
  CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))
);

INSERT INTO task_authority_revisions (
  authority_id, revision, job_id, owner_user_id, owner_chat_id, controller_key,
  source_update_id, request_digest, project_id, task_outcome, scope_digest,
  constraints_json, policy_version, policy_digest, artifact_graph_digest,
  status, created_at, updated_at, revoked_at, revoked_reason, superseded_at, superseded_reason
)
SELECT authority_id, revision, job_id, owner_user_id, owner_chat_id, controller_key,
       source_update_id, request_digest, project_id, task_outcome, scope_digest,
       constraints_json, policy_version, policy_digest, artifact_graph_digest,
       status, created_at, updated_at, revoked_at, revoked_reason, superseded_at, superseded_reason
FROM task_authorities;

CREATE TABLE task_authority_current (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  authority_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  FOREIGN KEY (authority_id, revision) REFERENCES task_authority_revisions(authority_id, revision)
);

INSERT INTO task_authority_current(job_id, authority_id, revision)
SELECT job_id, authority_id, revision FROM task_authorities;

CREATE TRIGGER task_authority_revisions_append_only_update
BEFORE UPDATE ON task_authority_revisions
BEGIN SELECT RAISE(ABORT, 'task authority revisions are append-only'); END;
CREATE TRIGGER task_authority_revisions_append_only_delete
BEFORE DELETE ON task_authority_revisions
BEGIN SELECT RAISE(ABORT, 'task authority revisions are append-only'); END;

CREATE TABLE task_authority_effect_admissions (
  effect_idempotency_key TEXT NOT NULL REFERENCES effects(idempotency_key),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  authority_id TEXT NOT NULL,
  authority_revision INTEGER NOT NULL CHECK (authority_revision >= 1),
  effect TEXT NOT NULL CHECK (effect IN (
    'read', 'artifact_write', 'prototype_write', 'worktree_write', 'commit',
    'pull_request', 'merge', 'deploy', 'rollback'
  )),
  admitted_at INTEGER NOT NULL,
  PRIMARY KEY (effect_idempotency_key, effect),
  FOREIGN KEY (authority_id, authority_revision)
    REFERENCES task_authority_revisions(authority_id, revision)
);
`] as const;

export const TASK_AUTHORITY_CLOSURE_MIGRATIONS = [String.raw`
CREATE TABLE owner_boundary_fact_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  code TEXT NOT NULL CHECK (code IN (
    'product_decision_required', 'scope_expansion_required',
    'credential_or_access_required', 'spend_authority_required',
    'irreversible_effect_required', 'policy_change_required',
    'technical_tradeoff_required', 'production_recovery_required'
  )),
  fact TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'artifact', 'access', 'budget', 'policy', 'production', 'retry', 'effect'
  )),
  source_id TEXT NOT NULL,
  affected_artifact_id TEXT,
  affected_effect_idempotency_key TEXT,
  recorded_at INTEGER NOT NULL,
  UNIQUE (job_id, code, fact, source_kind, source_id),
  CHECK (affected_artifact_id IS NOT NULL OR affected_effect_idempotency_key IS NOT NULL)
);
CREATE TRIGGER owner_boundary_fact_records_append_only_update
BEFORE UPDATE ON owner_boundary_fact_records
BEGIN SELECT RAISE(ABORT, 'owner boundary fact records are append-only'); END;
CREATE TRIGGER owner_boundary_fact_records_append_only_delete
BEFORE DELETE ON owner_boundary_fact_records
BEGIN SELECT RAISE(ABORT, 'owner boundary fact records are append-only'); END;

CREATE TABLE task_authority_narrowings (
  source_update_id INTEGER PRIMARY KEY,
  controller_key TEXT NOT NULL REFERENCES controller_threads(controller_key),
  owner_user_id TEXT NOT NULL,
  owner_chat_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  authority_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  target_revision INTEGER NOT NULL CHECK (target_revision = source_revision + 1),
  task_outcome TEXT NOT NULL CHECK (task_outcome IN ('artifact', 'reviewed_change', 'shipped_change')),
  constraints_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE (authority_id, target_revision),
  FOREIGN KEY (authority_id, source_revision)
    REFERENCES task_authority_revisions(authority_id, revision),
  FOREIGN KEY (authority_id, target_revision)
    REFERENCES task_authority_revisions(authority_id, revision)
);

INSERT INTO task_authority_revisions (
  authority_id, revision, job_id, owner_user_id, owner_chat_id, controller_key,
  source_update_id, request_digest, project_id, task_outcome, scope_digest,
  constraints_json, policy_version, policy_digest, artifact_graph_digest,
  status, created_at, updated_at, revoked_at, revoked_reason, superseded_at, superseded_reason
)
SELECT authority.authority_id, receipt.authority_revision, authority.job_id,
       authority.owner_user_id, authority.owner_chat_id, authority.controller_key,
       authority.source_update_id, authority.request_digest, authority.project_id,
       authority.task_outcome, authority.scope_digest, authority.constraints_json,
       authority.policy_version, authority.policy_digest, receipt.artifact_graph_digest,
       'active', authority.created_at, receipt.created_at, NULL, NULL, NULL, NULL
  FROM task_authorities AS authority
  JOIN release_authority_receipts AS receipt
    ON receipt.authority_id = authority.authority_id
   AND receipt.job_id = authority.job_id
   AND receipt.authority_source = 'task'
  LEFT JOIN task_authority_revisions AS revision
    ON revision.authority_id = receipt.authority_id
   AND revision.revision = receipt.authority_revision
 WHERE revision.authority_id IS NULL
   AND receipt.authority_revision < authority.revision
   AND authority.task_outcome = 'shipped_change'
   AND (
     SELECT COUNT(*) FROM task_authority_events AS event
      WHERE event.authority_id = authority.authority_id
        AND event.revision > receipt.authority_revision
        AND event.revision <= authority.revision
        AND event.action = 'revised'
        AND event.reason = 'artifact_graph_advanced'
   ) = authority.revision - receipt.authority_revision
 GROUP BY authority.authority_id, receipt.authority_revision
HAVING COUNT(DISTINCT receipt.artifact_graph_digest) = 1;

CREATE TEMP TABLE task_authority_history_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO task_authority_history_guard(valid)
SELECT CASE WHEN NOT EXISTS (
  SELECT referenced.authority_id, referenced.authority_revision
    FROM (
      SELECT authority_id, authority_revision FROM release_authority_receipts
       WHERE authority_id IS NOT NULL AND authority_revision IS NOT NULL
      UNION
      SELECT authority_id, authority_revision FROM owner_boundaries
    ) AS referenced
    LEFT JOIN task_authority_revisions AS revision
      ON revision.authority_id = referenced.authority_id
     AND revision.revision = referenced.authority_revision
   WHERE revision.authority_id IS NULL
) THEN 1 ELSE 0 END;
DROP TABLE task_authority_history_guard;
`] as const;

export const TASK_AUTHORITY_PUBLISH_MIGRATIONS = [String.raw`
CREATE TEMP TABLE task_authority_admission_identity_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO task_authority_admission_identity_guard(valid)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1
    FROM task_authority_effect_admissions AS admission
    JOIN effects AS effect ON effect.idempotency_key = admission.effect_idempotency_key
    JOIN task_authority_revisions AS revision
      ON revision.authority_id = admission.authority_id
     AND revision.revision = admission.authority_revision
   WHERE admission.job_id <> effect.job_id OR admission.job_id <> revision.job_id
) THEN 1 ELSE 0 END;
DROP TABLE task_authority_admission_identity_guard;

ALTER TABLE task_authority_effect_admissions RENAME TO task_authority_effect_admissions_without_push;

CREATE TABLE task_authority_effect_admissions (
  effect_idempotency_key TEXT NOT NULL REFERENCES effects(idempotency_key),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  authority_id TEXT NOT NULL,
  authority_revision INTEGER NOT NULL CHECK (authority_revision >= 1),
  effect TEXT NOT NULL CHECK (effect IN (
    'read', 'artifact_write', 'prototype_write', 'worktree_write', 'commit',
    'push', 'pull_request', 'merge', 'deploy', 'rollback'
  )),
  admitted_at INTEGER NOT NULL,
  PRIMARY KEY (effect_idempotency_key, effect),
  FOREIGN KEY (authority_id, authority_revision)
    REFERENCES task_authority_revisions(authority_id, revision)
);

INSERT INTO task_authority_effect_admissions (
  effect_idempotency_key, job_id, authority_id, authority_revision, effect, admitted_at
)
SELECT effect_idempotency_key, job_id, authority_id, authority_revision, effect, admitted_at
FROM task_authority_effect_admissions_without_push;

DROP TABLE task_authority_effect_admissions_without_push;

CREATE TRIGGER task_authority_effect_admissions_exact_job_insert
BEFORE INSERT ON task_authority_effect_admissions
WHEN NOT EXISTS (
  SELECT 1
    FROM effects AS effect
    JOIN task_authority_revisions AS revision
      ON revision.authority_id = NEW.authority_id
     AND revision.revision = NEW.authority_revision
   WHERE effect.idempotency_key = NEW.effect_idempotency_key
     AND effect.job_id = NEW.job_id
     AND revision.job_id = NEW.job_id
)
BEGIN SELECT RAISE(ABORT, 'task authority admission job identity mismatch'); END;

CREATE TRIGGER task_authority_effect_admissions_exact_job_update
BEFORE UPDATE ON task_authority_effect_admissions
BEGIN SELECT RAISE(ABORT, 'task authority admissions are immutable'); END;

ALTER TABLE task_authority_narrowings ADD COLUMN source_message_id INTEGER;
ALTER TABLE task_authority_narrowings ADD COLUMN reply_to_message_id INTEGER;
ALTER TABLE task_authority_narrowings ADD COLUMN instruction_digest TEXT;

CREATE TRIGGER task_authority_narrowings_require_payload_identity
BEFORE INSERT ON task_authority_narrowings
WHEN NEW.source_message_id IS NULL OR NEW.source_message_id < 1
  OR NEW.reply_to_message_id IS NULL OR NEW.reply_to_message_id < 1
  OR NEW.instruction_digest IS NULL OR length(NEW.instruction_digest) <> 64
  OR NEW.instruction_digest NOT GLOB '[0-9a-f]*'
BEGIN SELECT RAISE(ABORT, 'task authority narrowing payload identity is required'); END;

CREATE TRIGGER owner_boundary_fact_records_no_insert
BEFORE INSERT ON owner_boundary_fact_records
BEGIN SELECT RAISE(ABORT, 'owner boundary facts are derived from authoritative records'); END;
`] as const;

export const OWNER_BOUNDARY_SOURCE_MIGRATIONS = [String.raw`
CREATE TEMP TABLE owner_boundary_source_upgrade_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO owner_boundary_source_upgrade_guard(valid)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM owner_boundaries WHERE status <> 'revoked'
) THEN 1 ELSE 0 END;
DROP TABLE owner_boundary_source_upgrade_guard;

CREATE TABLE policy_boundary_observations (
  observation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  authority_id TEXT NOT NULL,
  authority_revision INTEGER NOT NULL CHECK (authority_revision >= 1),
  artifact_graph_digest TEXT NOT NULL CHECK (length(artifact_graph_digest) = 64),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  source_effect_idempotency_key TEXT NOT NULL REFERENCES effects(idempotency_key),
  affected_effect_idempotency_key TEXT NOT NULL,
  observed_job_version INTEGER NOT NULL CHECK (observed_job_version >= 0),
  observed_at INTEGER NOT NULL,
  UNIQUE(job_id, authority_revision, affected_effect_idempotency_key),
  FOREIGN KEY (authority_id, authority_revision)
    REFERENCES task_authority_revisions(authority_id, revision)
);

CREATE TRIGGER policy_boundary_observations_append_only_update
BEFORE UPDATE ON policy_boundary_observations
BEGIN SELECT RAISE(ABORT, 'policy boundary observations are append-only'); END;
CREATE TRIGGER policy_boundary_observations_append_only_delete
BEFORE DELETE ON policy_boundary_observations
BEGIN SELECT RAISE(ABORT, 'policy boundary observations are append-only'); END;

CREATE TRIGGER owner_boundaries_require_authoritative_source
BEFORE INSERT ON owner_boundaries
WHEN NEW.code <> 'policy_change_required' OR NOT EXISTS (
  SELECT 1
    FROM policy_boundary_observations AS observation
    JOIN task_authority_current AS current
      ON current.job_id = observation.job_id
     AND current.authority_id = observation.authority_id
     AND current.revision = observation.authority_revision
    JOIN task_authority_revisions AS revision
      ON revision.authority_id = observation.authority_id
     AND revision.revision = observation.authority_revision
    JOIN jobs AS job ON job.id = observation.job_id
    JOIN effects AS source_effect
      ON source_effect.idempotency_key = observation.source_effect_idempotency_key
     AND source_effect.job_id = observation.job_id
   WHERE observation.job_id = NEW.job_id
     AND observation.authority_id = NEW.authority_id
     AND observation.authority_revision = NEW.authority_revision
     AND observation.affected_effect_idempotency_key = NEW.affected_effect_idempotency_key
     AND NEW.affected_artifact_id IS NULL
     AND revision.status = 'active'
     AND revision.task_outcome = 'shipped_change'
     AND revision.artifact_graph_digest = observation.artifact_graph_digest
     AND revision.policy_digest = observation.policy_digest
     AND job.version = observation.observed_job_version
     AND job.state = 'awaiting_merge_approval'
     AND json_extract(job.policy_json, '$.production') IS NULL
     AND COALESCE(json_extract(job.policy_json, '$.autonomy.mergeWithoutProduction'), 0) <> 1
     AND source_effect.kind = 'issue_approval'
)
BEGIN SELECT RAISE(ABORT, 'owner boundary lacks an exact authoritative source'); END;
`] as const;

export const POLICY_APPROVAL_INTENT_MIGRATIONS = [String.raw`
UPDATE effects
   SET payload_json = (
     SELECT json_object(
       'intentVersion', 1,
       'jobId', job.id,
       'projectId', revision.project_id,
       'controllerKey', revision.controller_key,
       'policyDigest', revision.policy_digest,
       'artifactGraphDigest', revision.artifact_graph_digest,
       'affectedEffectIdempotencyKey', job.id || ':' || (job.version + 1) || ':merge_pr',
       'affectedEffectKind', 'merge_pr',
       'headSha', job.pr_head_sha,
       'operation', 'merge'
     )
       FROM jobs AS job
       JOIN task_authority_current AS current ON current.job_id = job.id
       JOIN task_authority_revisions AS revision
         ON revision.authority_id = current.authority_id
        AND revision.revision = current.revision
      WHERE job.id = effects.job_id
   )
 WHERE effects.kind = 'issue_approval'
   AND json_valid(effects.payload_json)
   AND json_type(effects.payload_json) = 'object'
   AND (SELECT COUNT(*) FROM json_each(effects.payload_json)) = 1
   AND json_type(effects.payload_json, '$.headSha') = 'text'
   AND EXISTS (
     SELECT 1
       FROM jobs AS job
       JOIN task_authority_current AS current ON current.job_id = job.id
       JOIN task_authority_revisions AS revision
         ON revision.authority_id = current.authority_id
        AND revision.revision = current.revision
      WHERE job.id = effects.job_id
        AND job.state = 'awaiting_merge_approval'
        AND job.pr_head_sha = json_extract(effects.payload_json, '$.headSha')
        AND revision.status = 'active'
        AND revision.task_outcome = 'shipped_change'
        AND json_extract(job.policy_json, '$.production') IS NULL
        AND COALESCE(json_extract(job.policy_json, '$.autonomy.mergeWithoutProduction'), 0) <> 1
   );

ALTER TABLE task_authority_effect_admissions RENAME TO task_authority_effect_admissions_without_payload;

CREATE TABLE task_authority_effect_admissions (
  effect_idempotency_key TEXT NOT NULL REFERENCES effects(idempotency_key),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  authority_id TEXT NOT NULL,
  authority_revision INTEGER NOT NULL CHECK (authority_revision >= 1),
  effect TEXT NOT NULL CHECK (effect IN (
    'read', 'artifact_write', 'prototype_write', 'worktree_write', 'commit',
    'push', 'pull_request', 'merge', 'deploy', 'rollback'
  )),
  effect_payload_json TEXT NOT NULL,
  admitted_at INTEGER NOT NULL,
  PRIMARY KEY (effect_idempotency_key, effect),
  FOREIGN KEY (authority_id, authority_revision)
    REFERENCES task_authority_revisions(authority_id, revision)
);

INSERT INTO task_authority_effect_admissions (
  effect_idempotency_key, job_id, authority_id, authority_revision, effect,
  effect_payload_json, admitted_at
)
SELECT admission.effect_idempotency_key, admission.job_id, admission.authority_id,
       admission.authority_revision, admission.effect, effect.payload_json, admission.admitted_at
  FROM task_authority_effect_admissions_without_payload AS admission
  JOIN effects AS effect ON effect.idempotency_key = admission.effect_idempotency_key;

DROP TABLE task_authority_effect_admissions_without_payload;

CREATE TRIGGER task_authority_effect_admissions_exact_source_insert
BEFORE INSERT ON task_authority_effect_admissions
WHEN NOT EXISTS (
  SELECT 1
    FROM effects AS effect
    JOIN task_authority_revisions AS revision
      ON revision.authority_id = NEW.authority_id
     AND revision.revision = NEW.authority_revision
   WHERE effect.idempotency_key = NEW.effect_idempotency_key
     AND effect.job_id = NEW.job_id
     AND effect.payload_json = NEW.effect_payload_json
     AND revision.job_id = NEW.job_id
)
BEGIN SELECT RAISE(ABORT, 'task authority admission source identity mismatch'); END;

CREATE TRIGGER task_authority_effect_admissions_immutable_update
BEFORE UPDATE ON task_authority_effect_admissions
BEGIN SELECT RAISE(ABORT, 'task authority admissions are immutable'); END;
CREATE TRIGGER task_authority_effect_admissions_immutable_delete
BEFORE DELETE ON task_authority_effect_admissions
BEGIN SELECT RAISE(ABORT, 'task authority admissions are immutable'); END;

CREATE TRIGGER policy_boundary_observations_require_admitted_source
BEFORE INSERT ON policy_boundary_observations
WHEN NOT EXISTS (
  SELECT 1
    FROM effects AS source_effect
    JOIN task_authority_effect_admissions AS admission
      ON admission.effect_idempotency_key = source_effect.idempotency_key
     AND admission.job_id = source_effect.job_id
     AND admission.effect = 'read'
     AND admission.effect_payload_json = source_effect.payload_json
    JOIN task_authority_current AS current
      ON current.job_id = admission.job_id
     AND current.authority_id = admission.authority_id
     AND current.revision = admission.authority_revision
    JOIN task_authority_revisions AS revision
      ON revision.authority_id = admission.authority_id
     AND revision.revision = admission.authority_revision
    JOIN jobs AS job ON job.id = source_effect.job_id
   WHERE source_effect.idempotency_key = NEW.source_effect_idempotency_key
     AND source_effect.job_id = NEW.job_id
     AND source_effect.kind = 'issue_approval'
     AND admission.authority_id = NEW.authority_id
     AND admission.authority_revision = NEW.authority_revision
     AND revision.status = 'active'
     AND revision.task_outcome = 'shipped_change'
     AND revision.artifact_graph_digest = NEW.artifact_graph_digest
     AND revision.policy_digest = NEW.policy_digest
     AND job.version = NEW.observed_job_version
     AND json_valid(source_effect.payload_json)
     AND json_type(source_effect.payload_json) = 'object'
     AND (SELECT COUNT(*) FROM json_each(source_effect.payload_json)) = 10
     AND json_extract(source_effect.payload_json, '$.intentVersion') = 1
     AND json_extract(source_effect.payload_json, '$.jobId') = NEW.job_id
     AND json_extract(source_effect.payload_json, '$.projectId') = revision.project_id
     AND json_extract(source_effect.payload_json, '$.controllerKey') = revision.controller_key
     AND json_extract(source_effect.payload_json, '$.policyDigest') = NEW.policy_digest
     AND json_extract(source_effect.payload_json, '$.artifactGraphDigest') = NEW.artifact_graph_digest
     AND json_extract(source_effect.payload_json, '$.affectedEffectIdempotencyKey') = NEW.affected_effect_idempotency_key
     AND json_extract(source_effect.payload_json, '$.affectedEffectKind') = 'merge_pr'
     AND json_extract(source_effect.payload_json, '$.headSha') = job.pr_head_sha
     AND json_extract(source_effect.payload_json, '$.operation') = 'merge'
)
BEGIN SELECT RAISE(ABORT, 'policy observation lacks an admitted policy approval source'); END;

INSERT OR IGNORE INTO policy_boundary_observations (
  observation_id, job_id, authority_id, authority_revision, artifact_graph_digest,
  policy_digest, source_effect_idempotency_key, affected_effect_idempotency_key,
  observed_job_version, observed_at
)
SELECT observation.observation_id, observation.job_id, observation.authority_id,
       observation.authority_revision, observation.artifact_graph_digest,
       observation.policy_digest, observation.source_effect_idempotency_key,
       observation.affected_effect_idempotency_key, observation.observed_job_version,
       observation.observed_at
  FROM policy_boundary_observations AS observation
  JOIN owner_boundaries AS boundary
    ON boundary.job_id = observation.job_id
   AND boundary.authority_id = observation.authority_id
   AND boundary.authority_revision = observation.authority_revision
   AND boundary.affected_effect_idempotency_key = observation.affected_effect_idempotency_key
 WHERE boundary.status <> 'revoked';
CREATE TRIGGER policy_boundary_observations_require_live_executor_fence
BEFORE INSERT ON policy_boundary_observations
WHEN EXISTS (
  SELECT 1
    FROM effects AS source_effect
    JOIN task_authority_effect_admissions AS admission
      ON admission.effect_idempotency_key = source_effect.idempotency_key
     AND admission.job_id = source_effect.job_id
     AND admission.effect = 'read'
     AND admission.effect_payload_json = source_effect.payload_json
     AND admission.authority_id = NEW.authority_id
     AND admission.authority_revision = NEW.authority_revision
   WHERE source_effect.idempotency_key = NEW.source_effect_idempotency_key
     AND source_effect.job_id = NEW.job_id
) AND NOT EXISTS (
  SELECT 1
    FROM effects AS source_effect
    JOIN executor_lease AS lease
      ON lease.singleton = 1
     AND lease.owner_id = source_effect.lease_owner
     AND lease.generation = source_effect.lease_generation
   WHERE source_effect.idempotency_key = NEW.source_effect_idempotency_key
     AND source_effect.job_id = NEW.job_id
     AND source_effect.status = 'leased'
     AND source_effect.lease_expires_at > NEW.observed_at
     AND lease.lease_expires_at > NEW.observed_at
)
BEGIN SELECT RAISE(ABORT, 'policy observation lacks a live executor fence'); END;
`] as const;

export const NAVIGATOR_RELEASE_MIGRATIONS = [String.raw`
CREATE TABLE navigator_release_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  workflow_step_id TEXT NOT NULL UNIQUE REFERENCES workflow_steps(id),
  effect_idempotency_key TEXT NOT NULL UNIQUE REFERENCES effects(idempotency_key),
  implementation_ticket_ids_json TEXT NOT NULL CHECK (json_valid(implementation_ticket_ids_json)),
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  job_version INTEGER NOT NULL CHECK (job_version >= 0),
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TRIGGER navigator_release_attempts_append_only_delete
BEFORE DELETE ON navigator_release_attempts
BEGIN SELECT RAISE(ABORT, 'navigator release attempts cannot be deleted'); END;

CREATE TABLE navigator_release_outcomes (
  attempt_id TEXT PRIMARY KEY REFERENCES navigator_release_attempts(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('entered_release', 'returned_to_navigation', 'completed', 'recovery_required')),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
  recorded_at INTEGER NOT NULL
);
CREATE TRIGGER navigator_release_outcomes_append_only_update
BEFORE UPDATE ON navigator_release_outcomes
BEGIN SELECT RAISE(ABORT, 'navigator release outcomes are append-only'); END;
CREATE TRIGGER navigator_release_outcomes_append_only_delete
BEFORE DELETE ON navigator_release_outcomes
BEGIN SELECT RAISE(ABORT, 'navigator release outcomes are append-only'); END;

CREATE TABLE navigator_release_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  workflow_step_id TEXT REFERENCES workflow_steps(id),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
  previous_state TEXT NOT NULL CHECK (length(previous_state) BETWEEN 1 AND 64),
  recorded_at INTEGER NOT NULL
);
CREATE TRIGGER navigator_release_findings_append_only_update
BEFORE UPDATE ON navigator_release_findings
BEGIN SELECT RAISE(ABORT, 'navigator release findings are append-only'); END;
CREATE TRIGGER navigator_release_findings_append_only_delete
BEFORE DELETE ON navigator_release_findings
BEGIN SELECT RAISE(ABORT, 'navigator release findings are append-only'); END;

CREATE TABLE navigator_release_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  workflow_step_id TEXT REFERENCES workflow_steps(id),
  phase TEXT NOT NULL CHECK (phase IN ('deploy', 'canary')),
  failure_signature TEXT NOT NULL CHECK (length(failure_signature) BETWEEN 1 AND 500),
  rollback_outcome TEXT NOT NULL CHECK (rollback_outcome IN ('pass', 'fail', 'missing', 'indeterminate')),
  recorded_at INTEGER NOT NULL
);
CREATE TRIGGER navigator_release_incidents_append_only_update
BEFORE UPDATE ON navigator_release_incidents
BEGIN SELECT RAISE(ABORT, 'navigator release incidents are append-only'); END;
CREATE TRIGGER navigator_release_incidents_append_only_delete
BEFORE DELETE ON navigator_release_incidents
BEGIN SELECT RAISE(ABORT, 'navigator release incidents are append-only'); END;

CREATE TABLE production_recovery_observations (
  observation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  authority_id TEXT NOT NULL,
  authority_revision INTEGER NOT NULL CHECK (authority_revision >= 1),
  artifact_graph_digest TEXT NOT NULL CHECK (length(artifact_graph_digest) = 64),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  source_effect_idempotency_key TEXT NOT NULL REFERENCES effects(idempotency_key),
  affected_effect_idempotency_key TEXT NOT NULL,
  observed_job_version INTEGER NOT NULL CHECK (observed_job_version >= 0),
  observed_at INTEGER NOT NULL,
  UNIQUE(job_id, authority_revision, affected_effect_idempotency_key),
  FOREIGN KEY (authority_id, authority_revision)
    REFERENCES task_authority_revisions(authority_id, revision)
);
CREATE TRIGGER production_recovery_observations_append_only_update
BEFORE UPDATE ON production_recovery_observations
BEGIN SELECT RAISE(ABORT, 'production recovery observations are append-only'); END;
CREATE TRIGGER production_recovery_observations_append_only_delete
BEFORE DELETE ON production_recovery_observations
BEGIN SELECT RAISE(ABORT, 'production recovery observations are append-only'); END;

DROP TRIGGER IF EXISTS owner_boundaries_require_authoritative_source;
CREATE TRIGGER owner_boundaries_require_authoritative_source
BEFORE INSERT ON owner_boundaries
WHEN NOT (
  (
    NEW.code = 'policy_change_required' AND EXISTS (
      SELECT 1
        FROM policy_boundary_observations AS observation
        JOIN task_authority_current AS current
          ON current.job_id = observation.job_id
         AND current.authority_id = observation.authority_id
         AND current.revision = observation.authority_revision
        JOIN task_authority_revisions AS revision
          ON revision.authority_id = observation.authority_id
         AND revision.revision = observation.authority_revision
        JOIN jobs AS job ON job.id = observation.job_id
        JOIN effects AS source_effect
          ON source_effect.idempotency_key = observation.source_effect_idempotency_key
         AND source_effect.job_id = observation.job_id
       WHERE observation.job_id = NEW.job_id
         AND observation.authority_id = NEW.authority_id
         AND observation.authority_revision = NEW.authority_revision
         AND observation.affected_effect_idempotency_key = NEW.affected_effect_idempotency_key
         AND NEW.affected_artifact_id IS NULL
         AND revision.status = 'active'
         AND revision.task_outcome = 'shipped_change'
         AND revision.artifact_graph_digest = observation.artifact_graph_digest
         AND revision.policy_digest = observation.policy_digest
         AND job.version = observation.observed_job_version
         AND job.state = 'awaiting_merge_approval'
         AND json_extract(job.policy_json, '$.production') IS NULL
         AND COALESCE(json_extract(job.policy_json, '$.autonomy.mergeWithoutProduction'), 0) <> 1
         AND source_effect.kind = 'issue_approval'
    )
  ) OR (
    NEW.code = 'production_recovery_required' AND EXISTS (
      SELECT 1
        FROM production_recovery_observations AS observation
        JOIN task_authority_current AS current
          ON current.job_id = observation.job_id
         AND current.authority_id = observation.authority_id
         AND current.revision = observation.authority_revision
        JOIN task_authority_revisions AS revision
          ON revision.authority_id = observation.authority_id
         AND revision.revision = observation.authority_revision
        JOIN jobs AS job ON job.id = observation.job_id
        JOIN effects AS source_effect
          ON source_effect.idempotency_key = observation.source_effect_idempotency_key
         AND source_effect.job_id = observation.job_id
       WHERE observation.job_id = NEW.job_id
         AND observation.authority_id = NEW.authority_id
         AND observation.authority_revision = NEW.authority_revision
         AND observation.affected_effect_idempotency_key = NEW.affected_effect_idempotency_key
         AND NEW.affected_artifact_id IS NULL
         AND revision.status = 'suspended'
         AND revision.task_outcome = 'shipped_change'
         AND revision.artifact_graph_digest = observation.artifact_graph_digest
         AND revision.policy_digest = observation.policy_digest
         AND job.version = observation.observed_job_version
         AND job.state = 'production_failed'
         AND source_effect.kind IN ('deploy_production', 'verify_production')
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'owner boundary lacks an exact authoritative source'); END;
`, String.raw`
DROP TRIGGER IF EXISTS owner_boundaries_require_authoritative_source;
CREATE TRIGGER owner_boundaries_require_authoritative_source
BEFORE INSERT ON owner_boundaries
WHEN NOT (
  (
    NEW.code = 'policy_change_required' AND EXISTS (
      SELECT 1
        FROM policy_boundary_observations AS observation
        JOIN task_authority_current AS current
          ON current.job_id = observation.job_id
         AND current.authority_id = observation.authority_id
         AND current.revision = observation.authority_revision
        JOIN task_authority_revisions AS revision
          ON revision.authority_id = observation.authority_id
         AND revision.revision = observation.authority_revision
        JOIN jobs AS job ON job.id = observation.job_id
        JOIN effects AS source_effect
          ON source_effect.idempotency_key = observation.source_effect_idempotency_key
         AND source_effect.job_id = observation.job_id
       WHERE observation.job_id = NEW.job_id
         AND observation.authority_id = NEW.authority_id
         AND observation.authority_revision = NEW.authority_revision
         AND observation.affected_effect_idempotency_key = NEW.affected_effect_idempotency_key
         AND NEW.affected_artifact_id IS NULL
         AND revision.status = 'active'
         AND revision.task_outcome = 'shipped_change'
         AND revision.artifact_graph_digest = observation.artifact_graph_digest
         AND revision.policy_digest = observation.policy_digest
         AND job.version = observation.observed_job_version
         AND job.state = 'awaiting_merge_approval'
         AND (
           (
             json_extract(job.policy_json, '$.production') IS NULL
             AND COALESCE(json_extract(job.policy_json, '$.autonomy.mergeWithoutProduction'), 0) <> 1
           ) OR (
             json_extract(job.policy_json, '$.production') IS NOT NULL
             AND json_extract(job.policy_json, '$.production.rollbackCommand') IS NULL
           )
         )
         AND source_effect.kind = 'issue_approval'
    )
  ) OR (
    NEW.code = 'production_recovery_required' AND EXISTS (
      SELECT 1
        FROM production_recovery_observations AS observation
        JOIN task_authority_current AS current
          ON current.job_id = observation.job_id
         AND current.authority_id = observation.authority_id
         AND current.revision = observation.authority_revision
        JOIN task_authority_revisions AS revision
          ON revision.authority_id = observation.authority_id
         AND revision.revision = observation.authority_revision
        JOIN jobs AS job ON job.id = observation.job_id
        JOIN effects AS source_effect
          ON source_effect.idempotency_key = observation.source_effect_idempotency_key
         AND source_effect.job_id = observation.job_id
       WHERE observation.job_id = NEW.job_id
         AND observation.authority_id = NEW.authority_id
         AND observation.authority_revision = NEW.authority_revision
         AND observation.affected_effect_idempotency_key = NEW.affected_effect_idempotency_key
         AND NEW.affected_artifact_id IS NULL
         AND revision.status = 'suspended'
         AND revision.task_outcome = 'shipped_change'
         AND revision.artifact_graph_digest = observation.artifact_graph_digest
         AND revision.policy_digest = observation.policy_digest
         AND job.version = observation.observed_job_version
         AND job.state = 'production_failed'
         AND source_effect.kind IN ('deploy_production', 'verify_production')
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'owner boundary lacks an exact authoritative source'); END;
`] as const;

export const NAVIGATOR_EFFECT_PROTOCOL_MIGRATIONS = [String.raw`
ALTER TABLE navigator_skill_attempts ADD COLUMN capability_profile_id TEXT REFERENCES capability_profiles(id);
ALTER TABLE navigator_skill_attempts ADD COLUMN capability_profile_revision INTEGER CHECK (
  capability_profile_revision IS NULL OR capability_profile_revision >= 1
);
ALTER TABLE navigator_ticket_worker_attempts ADD COLUMN capability_profile_id TEXT REFERENCES capability_profiles(id);
ALTER TABLE navigator_ticket_worker_attempts ADD COLUMN capability_profile_revision INTEGER CHECK (
  capability_profile_revision IS NULL OR capability_profile_revision >= 1
);
ALTER TABLE navigator_release_attempts ADD COLUMN capability_profile_id TEXT REFERENCES capability_profiles(id);
ALTER TABLE navigator_release_attempts ADD COLUMN capability_profile_revision INTEGER CHECK (
  capability_profile_revision IS NULL OR capability_profile_revision >= 1
);

CREATE TABLE navigator_effect_capability_evidence (
  effect_idempotency_key TEXT NOT NULL REFERENCES effects(idempotency_key),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
  operation TEXT NOT NULL CHECK (operation IN ('artifact_write', 'prototype_write', 'worktree_write', 'release_entry')),
  profile_id TEXT NOT NULL REFERENCES capability_profiles(id),
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  capability_id TEXT NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 128),
  capability_kind TEXT NOT NULL CHECK (capability_kind IN (
    'skill', 'tool', 'bundle', 'native-adapter', 'model', 'connector', 'recipe'
  )),
  descriptor_digest TEXT NOT NULL CHECK (length(descriptor_digest) = 64),
  receipt_id TEXT NOT NULL REFERENCES capability_receipts(id),
  owner_id TEXT,
  generation INTEGER CHECK (generation IS NULL OR generation >= 1),
  admitted_at INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (effect_idempotency_key, operation, capability_id)
);
CREATE INDEX navigator_effect_capability_evidence_profile
  ON navigator_effect_capability_evidence(profile_id, profile_revision);
CREATE TRIGGER navigator_effect_capability_evidence_append_only_delete
BEFORE DELETE ON navigator_effect_capability_evidence
BEGIN SELECT RAISE(ABORT, 'navigator capability evidence cannot be deleted'); END;

CREATE TABLE navigator_effect_receipts (
  effect_idempotency_key TEXT PRIMARY KEY REFERENCES effects(idempotency_key),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('run_navigator_skill', 'run_navigator_ticket_worker', 'run_navigator_release')),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0)
);
CREATE TRIGGER navigator_effect_receipts_append_only_update
BEFORE UPDATE ON navigator_effect_receipts
BEGIN SELECT RAISE(ABORT, 'navigator effect receipts are append-only'); END;
CREATE TRIGGER navigator_effect_receipts_append_only_delete
BEFORE DELETE ON navigator_effect_receipts
BEGIN SELECT RAISE(ABORT, 'navigator effect receipts are append-only'); END;
`, String.raw`
CREATE TABLE navigator_effect_compatibility (
  effect_idempotency_key TEXT PRIMARY KEY REFERENCES effects(idempotency_key),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('run_navigator_skill', 'run_navigator_ticket_worker', 'run_navigator_release')),
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state = 'pending'),
  reason_code TEXT NOT NULL CHECK (reason_code = 'preceding_schema_capability_evidence_missing'),
  decoder_revision INTEGER NOT NULL CHECK (decoder_revision = 1),
  created_at INTEGER NOT NULL,
  UNIQUE (job_id, attempt_id)
);
CREATE TRIGGER navigator_effect_compatibility_append_only_update
BEFORE UPDATE ON navigator_effect_compatibility
BEGIN SELECT RAISE(ABORT, 'navigator effect compatibility records are append-only'); END;
CREATE TRIGGER navigator_effect_compatibility_append_only_delete
BEFORE DELETE ON navigator_effect_compatibility
BEGIN SELECT RAISE(ABORT, 'navigator effect compatibility records are append-only'); END;

INSERT OR IGNORE INTO navigator_effect_compatibility (
  effect_idempotency_key, job_id, kind, attempt_id, state, reason_code,
  decoder_revision, created_at
)
SELECT effect.idempotency_key, effect.job_id, effect.kind, attempt.id,
       'pending', 'preceding_schema_capability_evidence_missing', 1, effect.created_at
  FROM effects AS effect
  JOIN navigator_skill_attempts AS attempt
    ON attempt.effect_idempotency_key = effect.idempotency_key
 WHERE effect.kind = 'run_navigator_skill'
   AND effect.status IN ('pending', 'leased', 'failed')
   AND attempt.capability_profile_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM navigator_effect_capability_evidence AS evidence
      WHERE evidence.effect_idempotency_key = effect.idempotency_key
   )
UNION ALL
SELECT effect.idempotency_key, effect.job_id, effect.kind, attempt.id,
       'pending', 'preceding_schema_capability_evidence_missing', 1, effect.created_at
  FROM effects AS effect
  JOIN navigator_ticket_worker_attempts AS attempt
    ON attempt.effect_idempotency_key = effect.idempotency_key
 WHERE effect.kind = 'run_navigator_ticket_worker'
   AND effect.status IN ('pending', 'leased', 'failed')
   AND attempt.capability_profile_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM navigator_effect_capability_evidence AS evidence
      WHERE evidence.effect_idempotency_key = effect.idempotency_key
   )
UNION ALL
SELECT effect.idempotency_key, effect.job_id, effect.kind, attempt.id,
       'pending', 'preceding_schema_capability_evidence_missing', 1, effect.created_at
  FROM effects AS effect
  JOIN navigator_release_attempts AS attempt
    ON attempt.effect_idempotency_key = effect.idempotency_key
 WHERE effect.kind = 'run_navigator_release'
   AND effect.status IN ('pending', 'leased', 'failed')
   AND attempt.capability_profile_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM navigator_effect_capability_evidence AS evidence
      WHERE evidence.effect_idempotency_key = effect.idempotency_key
   );
`, String.raw`
CREATE TABLE navigator_effect_compatibility_resolutions (
  effect_idempotency_key TEXT PRIMARY KEY REFERENCES navigator_effect_compatibility(effect_idempotency_key),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('run_navigator_skill', 'run_navigator_ticket_worker', 'run_navigator_release')),
  attempt_id TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES capability_profiles(id),
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  resolved_at INTEGER NOT NULL CHECK (resolved_at >= 0),
  UNIQUE (job_id, attempt_id)
);
CREATE TRIGGER navigator_effect_compatibility_resolutions_append_only_update
BEFORE UPDATE ON navigator_effect_compatibility_resolutions
BEGIN SELECT RAISE(ABORT, 'navigator effect compatibility resolutions are append-only'); END;
CREATE TRIGGER navigator_effect_compatibility_resolutions_append_only_delete
BEFORE DELETE ON navigator_effect_compatibility_resolutions
BEGIN SELECT RAISE(ABORT, 'navigator effect compatibility resolutions are append-only'); END;
`] as const;

export const NAVIGATOR_PROMOTION_MIGRATIONS = [String.raw`
CREATE TRIGGER jobs_workflow_engine_immutable
BEFORE UPDATE ON jobs
WHEN OLD.workflow_engine IS NOT NEW.workflow_engine
BEGIN SELECT RAISE(ABORT, 'workflow engine identity is immutable'); END;

CREATE TABLE workflow_engine_promotions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  engine TEXT NOT NULL CHECK (engine = 'navigator-v1'),
  action TEXT NOT NULL CHECK (action IN ('promote', 'rollback')),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
  evidence_digest TEXT CHECK (evidence_digest IS NULL OR length(evidence_digest) = 64),
  subject_id TEXT NOT NULL UNIQUE CHECK (length(subject_id) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (
    (action = 'promote' AND evidence_digest IS NOT NULL AND reason_code = 'promotion_gates_passed')
    OR (action = 'rollback' AND evidence_digest IS NULL)
  )
);
CREATE TRIGGER workflow_engine_promotions_append_only_update
BEFORE UPDATE ON workflow_engine_promotions
BEGIN SELECT RAISE(ABORT, 'workflow_engine_promotions are append-only'); END;
CREATE TRIGGER workflow_engine_promotions_append_only_delete
BEFORE DELETE ON workflow_engine_promotions
BEGIN SELECT RAISE(ABORT, 'workflow_engine_promotions are append-only'); END;

CREATE TABLE navigator_deterministic_evidence (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  category TEXT NOT NULL UNIQUE CHECK (category IN (
    'proposal_validity', 'skill_invocation', 'capability_denials', 'ask_matt',
    'owner_boundaries', 'artifact_frontier', 'task_outcomes', 'release_entry', 'restart'
  )),
  suite_id TEXT NOT NULL CHECK (length(suite_id) BETWEEN 1 AND 256),
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 256),
  artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed')),
  record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);
CREATE TRIGGER navigator_deterministic_evidence_append_only_update
BEFORE UPDATE ON navigator_deterministic_evidence
BEGIN SELECT RAISE(ABORT, 'navigator_deterministic_evidence is append-only'); END;
CREATE TRIGGER navigator_deterministic_evidence_append_only_delete
BEFORE DELETE ON navigator_deterministic_evidence
BEGIN SELECT RAISE(ABORT, 'navigator_deterministic_evidence is append-only'); END;

CREATE TABLE navigator_corpus_evidence (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  corpus_digest TEXT NOT NULL CHECK (length(corpus_digest) = 64),
  run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 1 AND 256),
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 64),
  total INTEGER NOT NULL CHECK (total BETWEEN 1 AND 100000),
  correct INTEGER NOT NULL CHECK (correct >= 0 AND correct <= total),
  unauthorized_effects INTEGER NOT NULL CHECK (unauthorized_effects >= 0),
  record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);
CREATE TRIGGER navigator_corpus_evidence_append_only_update
BEFORE UPDATE ON navigator_corpus_evidence
BEGIN SELECT RAISE(ABORT, 'navigator_corpus_evidence is append-only'); END;
CREATE TRIGGER navigator_corpus_evidence_append_only_delete
BEFORE DELETE ON navigator_corpus_evidence
BEGIN SELECT RAISE(ABORT, 'navigator_corpus_evidence is append-only'); END;

CREATE TABLE navigator_live_evidence (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 1 AND 256),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  scenario TEXT NOT NULL UNIQUE CHECK (scenario IN (
    'happy_path', 'interrupted_tracker_create', 'stale_head', 'ambiguous_merge',
    'canary_failure', 'successful_rollback', 'repair', 're_release'
  )),
  terminal_state TEXT NOT NULL CHECK (terminal_state IN ('complete', 'merged', 'cancelled')),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);
CREATE TRIGGER navigator_live_evidence_append_only_update
BEFORE UPDATE ON navigator_live_evidence
BEGIN SELECT RAISE(ABORT, 'navigator_live_evidence is append-only'); END;
CREATE TRIGGER navigator_live_evidence_append_only_delete
BEFORE DELETE ON navigator_live_evidence
BEGIN SELECT RAISE(ABORT, 'navigator_live_evidence is append-only'); END;

CREATE TABLE navigator_model_trial_evidence (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  cohort TEXT NOT NULL CHECK (cohort IN ('candidate', 'baseline')),
  model_trial_id TEXT NOT NULL REFERENCES model_route_trials(id),
  harness_digest TEXT NOT NULL CHECK (length(harness_digest) = 64),
  budget_digest TEXT NOT NULL CHECK (length(budget_digest) = 64),
  record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE(cohort, model_trial_id)
);
CREATE TRIGGER navigator_model_trial_evidence_append_only_update
BEFORE UPDATE ON navigator_model_trial_evidence
BEGIN SELECT RAISE(ABORT, 'navigator_model_trial_evidence is append-only'); END;
CREATE TRIGGER navigator_model_trial_evidence_append_only_delete
BEFORE DELETE ON navigator_model_trial_evidence
BEGIN SELECT RAISE(ABORT, 'navigator_model_trial_evidence is append-only'); END;

CREATE TABLE navigator_safety_evidence (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  counter TEXT NOT NULL UNIQUE CHECK (counter IN (
    'unauthorized_effects', 'owner_boundary_violations', 'duplicate_mutations',
    'outcome_regressions', 'evidence_binding_failures'
  )),
  counter_count INTEGER NOT NULL CHECK (counter_count >= 0),
  snapshot_id TEXT NOT NULL CHECK (length(snapshot_id) BETWEEN 1 AND 256),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  record_digest TEXT NOT NULL CHECK (length(record_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);
CREATE TRIGGER navigator_safety_evidence_append_only_update
BEFORE UPDATE ON navigator_safety_evidence
BEGIN SELECT RAISE(ABORT, 'navigator_safety_evidence is append-only'); END;
CREATE TRIGGER navigator_safety_evidence_append_only_delete
BEFORE DELETE ON navigator_safety_evidence
BEGIN SELECT RAISE(ABORT, 'navigator_safety_evidence is append-only'); END;

CREATE TABLE navigator_promotion_evidence_manifests (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 256),
  deterministic_ids_json TEXT NOT NULL CHECK (length(deterministic_ids_json) BETWEEN 2 AND 16384),
  corpus_id TEXT CHECK (corpus_id IS NULL OR length(corpus_id) BETWEEN 1 AND 256),
  live_run_ids_json TEXT NOT NULL CHECK (length(live_run_ids_json) BETWEEN 2 AND 16384),
  candidate_model_ref_ids_json TEXT NOT NULL CHECK (length(candidate_model_ref_ids_json) BETWEEN 2 AND 32768),
  baseline_model_ref_ids_json TEXT NOT NULL CHECK (length(baseline_model_ref_ids_json) BETWEEN 2 AND 32768),
  safety_ids_json TEXT NOT NULL CHECK (length(safety_ids_json) BETWEEN 2 AND 16384),
  reviewed INTEGER NOT NULL CHECK (reviewed IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);
CREATE INDEX navigator_promotion_evidence_manifest_sequence
  ON navigator_promotion_evidence_manifests(sequence DESC);
CREATE TRIGGER navigator_promotion_evidence_manifests_append_only_update
BEFORE UPDATE ON navigator_promotion_evidence_manifests
BEGIN SELECT RAISE(ABORT, 'navigator_promotion_evidence_manifests are append-only'); END;
CREATE TRIGGER navigator_promotion_evidence_manifests_append_only_delete
BEFORE DELETE ON navigator_promotion_evidence_manifests
BEGIN SELECT RAISE(ABORT, 'navigator_promotion_evidence_manifests are append-only'); END;

CREATE TABLE workflow_engine_contractions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  engine TEXT NOT NULL CHECK (engine = 'recipe-v1'),
  remaining_job_ids_json TEXT NOT NULL CHECK (remaining_job_ids_json = '[]'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);
CREATE TRIGGER workflow_engine_contractions_append_only_update
BEFORE UPDATE ON workflow_engine_contractions
BEGIN SELECT RAISE(ABORT, 'workflow_engine_contractions are append-only'); END;
CREATE TRIGGER workflow_engine_contractions_append_only_delete
BEFORE DELETE ON workflow_engine_contractions
BEGIN SELECT RAISE(ABORT, 'workflow_engine_contractions are append-only'); END;
`] as const;

export const NAVIGATOR_REVIEW_LEDGER_MIGRATIONS = [String.raw`
CREATE TABLE navigator_review_finding_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (length(id) BETWEEN 1 AND 256),
  job_id TEXT NOT NULL REFERENCES navigator_integrations(job_id),
  slice_id TEXT NOT NULL REFERENCES navigator_ticket_slices(id),
  source_review_attempt_id TEXT NOT NULL REFERENCES navigator_ticket_worker_attempts(id),
  verification_attempt_id TEXT NOT NULL REFERENCES navigator_ticket_worker_attempts(id),
  root_cause_id TEXT NOT NULL CHECK (length(root_cause_id) BETWEEN 1 AND 256),
  capability_id TEXT NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 256),
  rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 256),
  disposition TEXT NOT NULL CHECK (disposition IN ('must_fix', 'advisory')),
  event TEXT NOT NULL CHECK (event IN ('opened', 'reobserved', 'resolved', 'disputed')),
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
  finding_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  occurrence INTEGER NOT NULL CHECK (occurrence >= 0 AND occurrence <= 3),
  blocking_burden INTEGER NOT NULL CHECK (blocking_burden >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE(verification_attempt_id, root_cause_id)
);
CREATE INDEX navigator_review_finding_events_slice
  ON navigator_review_finding_events(slice_id, sequence);
CREATE TRIGGER navigator_review_finding_events_append_only_update
BEFORE UPDATE ON navigator_review_finding_events
BEGIN SELECT RAISE(ABORT, 'navigator review finding events are append-only'); END;
CREATE TRIGGER navigator_review_finding_events_append_only_delete
BEFORE DELETE ON navigator_review_finding_events
BEGIN SELECT RAISE(ABORT, 'navigator review finding events are append-only'); END;

CREATE TABLE navigator_review_convergence (
  slice_id TEXT PRIMARY KEY REFERENCES navigator_ticket_slices(id),
  last_blocking_burden INTEGER NOT NULL CHECK (last_blocking_burden >= 0),
  plateau_recoveries INTEGER NOT NULL CHECK (plateau_recoveries BETWEEN 0 AND 1),
  review_cycles INTEGER NOT NULL CHECK (review_cycles >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);
`] as const;

export const NAVIGATOR_FINDING_LEDGER_UPGRADE_MIGRATIONS = [String.raw`
ALTER TABLE navigator_review_finding_events ADD COLUMN severity TEXT NOT NULL DEFAULT 'low' CHECK (
  severity IN ('critical', 'high', 'medium', 'low')
);
ALTER TABLE navigator_review_finding_events ADD COLUMN requirement_id TEXT;
ALTER TABLE navigator_review_finding_events ADD COLUMN evidence_class TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE navigator_review_finding_events ADD COLUMN normalized_subject TEXT NOT NULL DEFAULT '';
ALTER TABLE navigator_review_finding_events ADD COLUMN fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE navigator_review_finding_events ADD COLUMN descriptor_digest TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' CHECK (length(descriptor_digest) = 64);
ALTER TABLE navigator_review_finding_events ADD COLUMN descriptor_version TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE navigator_review_finding_events ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 0 CHECK (policy_revision >= 0);
ALTER TABLE navigator_review_finding_events ADD COLUMN policy_digest TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' CHECK (length(policy_digest) = 64);
ALTER TABLE navigator_review_finding_events ADD COLUMN requirement_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(requirement_ids_json));
ALTER TABLE navigator_review_finding_events ADD COLUMN artifact_snapshot_id TEXT;
ALTER TABLE navigator_review_finding_events ADD COLUMN artifact_snapshot_digest TEXT CHECK (artifact_snapshot_digest IS NULL OR length(artifact_snapshot_digest) = 64);
ALTER TABLE navigator_review_finding_events ADD COLUMN specification_snapshot_id TEXT;
ALTER TABLE navigator_review_finding_events ADD COLUMN specification_snapshot_digest TEXT CHECK (specification_snapshot_digest IS NULL OR length(specification_snapshot_digest) = 64);
ALTER TABLE navigator_review_finding_events ADD COLUMN source_attempt_digest TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' CHECK (length(source_attempt_digest) = 64);
ALTER TABLE navigator_review_finding_events ADD COLUMN verification_attempt_digest TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' CHECK (length(verification_attempt_digest) = 64);
ALTER TABLE navigator_review_finding_events ADD COLUMN root_cause_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (root_cause_confirmed IN (0, 1));
CREATE INDEX navigator_review_finding_events_fingerprint
  ON navigator_review_finding_events(slice_id, fingerprint, sequence);
ALTER TABLE navigator_review_convergence ADD COLUMN last_verification_attempt_id TEXT;
`] as const;

export const MANAGED_AUTOMATION_MIGRATIONS = [String.raw`
CREATE TABLE managed_automations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  controller_key TEXT NOT NULL,
  source_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  bb_automation_id TEXT UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  mode TEXT NOT NULL CHECK (mode IN ('agent', 'script')),
  definition_json TEXT NOT NULL,
  definition_sha256 TEXT NOT NULL CHECK (length(definition_sha256) = 64),
  authority_json TEXT NOT NULL,
  notification_policy TEXT NOT NULL CHECK (notification_policy IN ('material', 'always', 'silent')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'paused', 'retired', 'failed')),
  legacy_monitor_id TEXT UNIQUE,
  observed_json TEXT,
  observed_sha256 TEXT CHECK (observed_sha256 IS NULL OR length(observed_sha256) = 64),
  last_reconciled_at INTEGER,
  last_run_id TEXT,
  last_run_status TEXT CHECK (last_run_status IS NULL OR last_run_status IN ('running', 'succeeded', 'failed', 'skipped')),
  last_error TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE(controller_key, source_key)
);
CREATE INDEX managed_automations_state ON managed_automations(state, updated_at);

CREATE TABLE managed_automation_run_evidence (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  binding_id TEXT NOT NULL REFERENCES managed_automations(id),
  bb_run_id TEXT NOT NULL,
  bb_automation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  run_mode TEXT NOT NULL CHECK (run_mode IN ('agent', 'script')),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('schedule', 'manual')),
  thread_id TEXT,
  output_sha256 TEXT,
  error_class TEXT,
  scheduled_for INTEGER NOT NULL CHECK (scheduled_for >= 0),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  finished_at INTEGER,
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  evidence_json TEXT NOT NULL,
  UNIQUE(bb_run_id, status)
);
CREATE INDEX managed_automation_run_evidence_binding
  ON managed_automation_run_evidence(binding_id, sequence);
CREATE TRIGGER managed_automation_run_evidence_append_only_update
BEFORE UPDATE ON managed_automation_run_evidence
BEGIN SELECT RAISE(ABORT, 'managed automation run evidence is append-only'); END;
CREATE TRIGGER managed_automation_run_evidence_append_only_delete
BEFORE DELETE ON managed_automation_run_evidence
BEGIN SELECT RAISE(ABORT, 'managed automation run evidence is append-only'); END;

CREATE TABLE managed_automation_notifications (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  bb_run_id TEXT NOT NULL UNIQUE,
  binding_id TEXT NOT NULL REFERENCES managed_automations(id),
  controller_key TEXT NOT NULL,
  update_id INTEGER UNIQUE,
  input_text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'enqueued')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  enqueued_at INTEGER
);
CREATE INDEX managed_automation_notifications_state
  ON managed_automation_notifications(state, sequence);
`] as const;

export const NAVIGATOR_RELEASE_REVIEW_LEDGER_UPGRADE_MIGRATIONS = [String.raw`
CREATE TABLE navigator_release_review_finding_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  workflow_step_id TEXT REFERENCES workflow_steps(id),
  source_review_attempt_id TEXT NOT NULL REFERENCES attempts(id),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  capability_id TEXT NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 256),
  rule_id TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 256),
  disposition TEXT NOT NULL CHECK (disposition IN ('must_fix', 'advisory')),
  event TEXT NOT NULL CHECK (event IN ('opened', 'reobserved', 'resolved')),
  head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
  finding_json TEXT NOT NULL CHECK (json_valid(finding_json)),
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  occurrence INTEGER NOT NULL CHECK (occurrence BETWEEN 0 AND 3),
  blocking_burden INTEGER NOT NULL CHECK (blocking_burden >= 0),
  recorded_at INTEGER NOT NULL,
  UNIQUE(source_review_attempt_id, fingerprint, event)
);
CREATE INDEX navigator_release_review_finding_events_job
  ON navigator_release_review_finding_events(job_id, sequence);
CREATE TRIGGER navigator_release_review_finding_events_append_only_update
BEFORE UPDATE ON navigator_release_review_finding_events
BEGIN SELECT RAISE(ABORT, 'navigator release review finding events are append-only'); END;
CREATE TRIGGER navigator_release_review_finding_events_append_only_delete
BEFORE DELETE ON navigator_release_review_finding_events
BEGIN SELECT RAISE(ABORT, 'navigator release review finding events are append-only'); END;
`] as const;

/**
 * Burst grouping and provenance: per-turn structured source records, document
 * attachments, the durable link from a folded follower to its leader, and the
 * reserved steer text for a combined mid-answer addition. Append-only history.
 */
export const CONTROLLER_BURST_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN source_json TEXT;
ALTER TABLE controller_turns ADD COLUMN doc_file_id TEXT;
ALTER TABLE controller_turns ADD COLUMN doc_file_name TEXT;
ALTER TABLE controller_turns ADD COLUMN doc_mime_type TEXT;
ALTER TABLE controller_turns ADD COLUMN doc_size_bytes INTEGER;
ALTER TABLE controller_turns ADD COLUMN burst_leader_turn_id TEXT;
ALTER TABLE controller_turns ADD COLUMN steer_reservation_text TEXT;
`] as const;

export const MANAGED_AUTOMATION_STATE_UPGRADE_MIGRATIONS = [String.raw`
CREATE TABLE managed_automations_v2 (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  controller_key TEXT NOT NULL,
  source_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  bb_automation_id TEXT UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  mode TEXT NOT NULL CHECK (mode IN ('agent', 'script')),
  definition_json TEXT NOT NULL,
  definition_sha256 TEXT NOT NULL CHECK (length(definition_sha256) = 64),
  authority_json TEXT NOT NULL,
  notification_policy TEXT NOT NULL CHECK (notification_policy IN ('material', 'always', 'silent')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'paused', 'updating', 'retiring', 'retired', 'failed')),
  legacy_monitor_id TEXT UNIQUE,
  observed_json TEXT,
  observed_sha256 TEXT CHECK (observed_sha256 IS NULL OR length(observed_sha256) = 64),
  last_reconciled_at INTEGER,
  last_run_id TEXT,
  last_run_status TEXT CHECK (last_run_status IS NULL OR last_run_status IN ('running', 'succeeded', 'failed', 'skipped')),
  last_error TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE(controller_key, source_key)
);

CREATE TABLE managed_automation_run_evidence_v2 (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  binding_id TEXT NOT NULL REFERENCES managed_automations_v2(id),
  bb_run_id TEXT NOT NULL,
  bb_automation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  run_mode TEXT NOT NULL CHECK (run_mode IN ('agent', 'script')),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('schedule', 'manual')),
  thread_id TEXT,
  output_sha256 TEXT,
  error_class TEXT,
  scheduled_for INTEGER NOT NULL CHECK (scheduled_for >= 0),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  finished_at INTEGER,
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  evidence_json TEXT NOT NULL,
  UNIQUE(bb_run_id, status)
);

CREATE TABLE managed_automation_notifications_v2 (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  bb_run_id TEXT NOT NULL UNIQUE,
  binding_id TEXT NOT NULL REFERENCES managed_automations_v2(id),
  controller_key TEXT NOT NULL,
  update_id INTEGER UNIQUE,
  input_text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'enqueued')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  enqueued_at INTEGER
);

INSERT INTO managed_automations_v2 (
  id, controller_key, source_key, project_id, bb_automation_id, name, mode,
  definition_json, definition_sha256, authority_json, notification_policy, state,
  legacy_monitor_id, observed_json, observed_sha256, last_reconciled_at, last_run_id,
  last_run_status, last_error, created_at, updated_at
)
SELECT id, controller_key, source_key, project_id, bb_automation_id, name, mode,
       definition_json, definition_sha256, authority_json, notification_policy, state,
       legacy_monitor_id, observed_json, observed_sha256, last_reconciled_at, last_run_id,
       last_run_status, last_error, created_at, updated_at
  FROM managed_automations;

INSERT INTO managed_automation_run_evidence_v2 (
  sequence, binding_id, bb_run_id, bb_automation_id, status, run_mode, trigger_kind,
  thread_id, output_sha256, error_class, scheduled_for, started_at, finished_at,
  observed_at, evidence_json
)
SELECT sequence, binding_id, bb_run_id, bb_automation_id, status, run_mode, trigger_kind,
       thread_id, output_sha256, error_class, scheduled_for, started_at, finished_at,
       observed_at, evidence_json
  FROM managed_automation_run_evidence;

INSERT INTO managed_automation_notifications_v2 (
  sequence, bb_run_id, binding_id, controller_key, update_id, input_text, state,
  created_at, enqueued_at
)
SELECT sequence, bb_run_id, binding_id, controller_key, update_id, input_text, state,
       created_at, enqueued_at
  FROM managed_automation_notifications;

DROP TRIGGER managed_automation_run_evidence_append_only_update;
DROP TRIGGER managed_automation_run_evidence_append_only_delete;
DROP TABLE managed_automation_run_evidence;
DROP TABLE managed_automation_notifications;
DROP TABLE managed_automations;

ALTER TABLE managed_automations_v2 RENAME TO managed_automations;
ALTER TABLE managed_automation_run_evidence_v2 RENAME TO managed_automation_run_evidence;
ALTER TABLE managed_automation_notifications_v2 RENAME TO managed_automation_notifications;

CREATE INDEX managed_automations_state ON managed_automations(state, updated_at);
CREATE INDEX managed_automation_run_evidence_binding
  ON managed_automation_run_evidence(binding_id, sequence);
CREATE TRIGGER managed_automation_run_evidence_append_only_update
BEFORE UPDATE ON managed_automation_run_evidence
BEGIN SELECT RAISE(ABORT, 'managed automation run evidence is append-only'); END;
CREATE TRIGGER managed_automation_run_evidence_append_only_delete
BEFORE DELETE ON managed_automation_run_evidence
BEGIN SELECT RAISE(ABORT, 'managed automation run evidence is append-only'); END;
CREATE INDEX managed_automation_notifications_state
  ON managed_automation_notifications(state, sequence);
`,
String.raw`

ALTER TABLE managed_automations ADD COLUMN definition_revision INTEGER NOT NULL DEFAULT 1 CHECK (definition_revision >= 1);
ALTER TABLE managed_automations ADD COLUMN authority_version INTEGER NOT NULL DEFAULT 0 CHECK (authority_version >= 0);
ALTER TABLE managed_automations ADD COLUMN capability_profile_id TEXT;
ALTER TABLE managed_automations ADD COLUMN capability_profile_revision INTEGER CHECK (
  capability_profile_revision IS NULL OR capability_profile_revision >= 1
);
ALTER TABLE managed_automations ADD COLUMN capability_evidence_json TEXT;
ALTER TABLE managed_automations ADD COLUMN last_operation_id TEXT;
ALTER TABLE managed_automations ADD COLUMN last_operation_outcome TEXT CHECK (
  last_operation_outcome IS NULL OR last_operation_outcome IN ('pending', 'leased', 'succeeded', 'failed', 'ambiguous')
);

CREATE TABLE managed_automation_operations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  binding_id TEXT NOT NULL REFERENCES managed_automations(id),
  operation_class TEXT NOT NULL CHECK (
    operation_class IN ('create', 'update', 'enable', 'disable', 'run_now', 'retire', 'reconcile')
  ),
  operation_version INTEGER NOT NULL DEFAULT 1 CHECK (operation_version = 1),
  target_project_id TEXT NOT NULL,
  definition_revision INTEGER NOT NULL CHECK (definition_revision >= 1),
  authority_json TEXT NOT NULL,
  capability_evidence_json TEXT,
  controller_owner_id TEXT,
  controller_generation INTEGER CHECK (controller_generation IS NULL OR controller_generation >= 1),
  controller_turn_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'succeeded', 'failed', 'ambiguous')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner TEXT,
  lease_generation INTEGER CHECK (lease_generation IS NULL OR lease_generation >= 1),
  lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  provider_automation_id TEXT,
  outcome_json TEXT,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  settled_at INTEGER CHECK (settled_at IS NULL OR settled_at >= 0),
  UNIQUE(binding_id, definition_revision, operation_class)
);
CREATE INDEX managed_automation_operations_due
  ON managed_automation_operations(state, next_attempt_at, created_at);
CREATE INDEX managed_automation_operations_binding
  ON managed_automation_operations(binding_id, created_at);
`, String.raw`
ALTER TABLE managed_automations ADD COLUMN provider_ownership_marker TEXT CHECK (
  provider_ownership_marker IS NULL OR length(provider_ownership_marker) BETWEEN 1 AND 256
);
ALTER TABLE managed_automation_operations ADD COLUMN provider_ownership_marker TEXT CHECK (
  provider_ownership_marker IS NULL OR length(provider_ownership_marker) BETWEEN 1 AND 256
);
`] as const;

export const MANAGED_AUTOMATION_LIFECYCLE_MIGRATIONS = [String.raw`
ALTER TABLE managed_automations ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'enabled' CHECK (
  desired_state IN ('enabled', 'paused', 'retired')
);
ALTER TABLE managed_automations ADD COLUMN last_reconciled_operation_id TEXT;
ALTER TABLE managed_automations ADD COLUMN last_reconciled_operation_outcome TEXT CHECK (
  last_reconciled_operation_outcome IS NULL OR
  last_reconciled_operation_outcome IN ('succeeded', 'failed', 'ambiguous')
);
UPDATE managed_automations
   SET desired_state = CASE
     WHEN state IN ('paused') THEN 'paused'
     WHEN state IN ('retiring', 'retired') THEN 'retired'
     ELSE 'enabled'
   END,
       last_reconciled_operation_id = CASE
         WHEN last_operation_outcome IN ('succeeded', 'failed', 'ambiguous') THEN last_operation_id
         ELSE NULL
       END,
       last_reconciled_operation_outcome = CASE
         WHEN last_operation_outcome IN ('succeeded', 'failed', 'ambiguous') THEN last_operation_outcome
         ELSE NULL
       END;

ALTER TABLE managed_automation_run_evidence ADD COLUMN receipt_version INTEGER;
ALTER TABLE managed_automation_run_evidence ADD COLUMN initiating_operation_id TEXT;
ALTER TABLE managed_automation_run_evidence ADD COLUMN definition_revision INTEGER;
ALTER TABLE managed_automation_run_evidence ADD COLUMN authority_json TEXT;
ALTER TABLE managed_automation_run_evidence ADD COLUMN capability_evidence_json TEXT;
ALTER TABLE managed_automation_run_evidence ADD COLUMN idempotency_key TEXT;
ALTER TABLE managed_automation_run_evidence ADD COLUMN outcome_class TEXT CHECK (
  outcome_class IS NULL OR outcome_class IN ('running', 'succeeded', 'failed', 'skipped', 'contract_violated')
);

CREATE TABLE managed_automation_operations_v2 (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  binding_id TEXT NOT NULL REFERENCES managed_automations(id),
  operation_class TEXT NOT NULL CHECK (
    operation_class IN ('create', 'update', 'enable', 'disable', 'run_now', 'retire', 'reconcile')
  ),
  operation_version INTEGER NOT NULL DEFAULT 1 CHECK (operation_version = 1),
  target_project_id TEXT NOT NULL,
  definition_revision INTEGER NOT NULL CHECK (definition_revision >= 1),
  intent_key TEXT CHECK (intent_key IS NULL OR length(intent_key) BETWEEN 1 AND 256),
  authority_json TEXT NOT NULL,
  capability_evidence_json TEXT,
  controller_owner_id TEXT,
  controller_generation INTEGER CHECK (controller_generation IS NULL OR controller_generation >= 1),
  controller_turn_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'succeeded', 'failed', 'ambiguous')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner TEXT,
  lease_generation INTEGER CHECK (lease_generation IS NULL OR lease_generation >= 1),
  lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  provider_automation_id TEXT,
  provider_ownership_marker TEXT CHECK (
    provider_ownership_marker IS NULL OR length(provider_ownership_marker) BETWEEN 1 AND 256
  ),
  outcome_json TEXT,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  settled_at INTEGER CHECK (settled_at IS NULL OR settled_at >= 0)
);
INSERT INTO managed_automation_operations_v2 (
  id, binding_id, operation_class, operation_version, target_project_id, definition_revision,
  intent_key, authority_json, capability_evidence_json, controller_owner_id,
  controller_generation, controller_turn_id, state, attempts,
  lease_owner, lease_generation, lease_expires_at, provider_automation_id,
  provider_ownership_marker, outcome_json, last_error, next_attempt_at,
  created_at, updated_at, settled_at
)
SELECT id, binding_id, operation_class, operation_version, target_project_id, definition_revision,
       NULL, authority_json, capability_evidence_json, controller_owner_id,
       controller_generation, controller_turn_id, state, attempts,
       lease_owner, lease_generation, lease_expires_at, provider_automation_id,
       provider_ownership_marker, outcome_json, last_error, next_attempt_at,
       created_at, updated_at, settled_at
  FROM managed_automation_operations;
DROP TABLE managed_automation_operations;
ALTER TABLE managed_automation_operations_v2 RENAME TO managed_automation_operations;
CREATE INDEX managed_automation_operations_due
  ON managed_automation_operations(state, next_attempt_at, created_at);
CREATE INDEX managed_automation_operations_binding
  ON managed_automation_operations(binding_id, created_at);
`] as const;

export const ALL_MIGRATIONS = [
  ...INITIAL_MIGRATIONS,
  ...UPDATE_CLAIM_MIGRATIONS,
  ...APPROVAL_BINDING_MIGRATIONS,
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
  ...CONTROLLER_TRUST_MIGRATIONS,
  ...CONTROLLER_INTERACTION_MIGRATIONS,
  ...MERGE_AUTHORITY_MIGRATIONS,
  ...REGRESSION_WATCH_MIGRATIONS,
  ...CREDENTIAL_ACCESS_MIGRATIONS,
  ...CONTROLLER_STEER_RESERVATION_MIGRATIONS,
  ...CONTROLLER_SUPERVISOR_ATTEMPT_MIGRATIONS,
  ...CONTROLLER_INTERACTION_REPAIR_MIGRATIONS,
  ...CONTROLLER_FINALIZATION_ENVELOPE_MIGRATIONS,
  ...CONTROLLER_INTERACTION_FINAL_REPAIR_MIGRATIONS,
  ...CONTROLLER_RECOVERY_MIGRATIONS,
  ...THREAD_FOLLOW_UP_MIGRATIONS,
  ...CONTROLLER_GENERATION_QUARANTINE_MIGRATIONS,
  ...CONTROLLER_GENERATION_INVARIANT_MIGRATIONS,
  ...CONTROLLER_DELIVERY_STATE_MIGRATIONS,
  ...THREAD_INTERACTION_AUDIENCE_MIGRATIONS,
  ...CONTROLLER_THREAD_ASK_MIGRATIONS,
  ...CONTROLLER_EVIDENCE_STEER_MIGRATIONS,
  ...HOUSEKEEPING_NOTICE_MIGRATIONS,
  ...DELEGATION_STALL_MIGRATIONS,
  ...STAGE_EXECUTION_MIGRATIONS,
  ...JOB_CONTINUATION_MIGRATIONS,
  ...MONITOR_STALL_MIGRATIONS,
  ...JOB_CONTINUATION_BACKFILL_MIGRATIONS,
  ...MEMORY_EMBEDDING_MIGRATIONS,
  ...REFERENCE_DOCUMENT_MIGRATIONS,
  ...CONTROLLER_THREAD_ROUTING_REPAIR_MIGRATIONS,
  ...REFERENCE_DOCUMENT_REPAIR_MIGRATIONS,
  ...PROJECT_ADMISSION_CLEAR_HISTORY_MIGRATIONS,
  ...CONTROLLER_VOICE_INBOX_MIGRATIONS,
  ...CONSENSUS_REVIEW_MIGRATIONS,
  ...AUTONOMOUS_INTAKE_MIGRATIONS,
  ...MERGE_PRE_APPROVAL_MIGRATIONS,
  ...WORK_ARTIFACT_MIGRATIONS,
  ...WORK_ARTIFACT_RELATIONSHIP_IDENTITY_MIGRATIONS,
  ...WORK_ARTIFACT_RELATIONSHIP_CANONICAL_MIGRATIONS,
  ...NAVIGATOR_WORKFLOW_MIGRATIONS,
  ...NAVIGATOR_PLANNING_MIGRATIONS,
  ...NAVIGATOR_IMPLEMENTATION_MIGRATIONS,
  ...NAVIGATOR_IMPLEMENTATION_UPGRADE_MIGRATIONS,
  ...TASK_AUTHORITY_MIGRATIONS,
  ...RELEASE_AUTHORITY_MIGRATIONS,
  ...OWNER_BOUNDARY_MIGRATIONS,
  ...TASK_AUTHORITY_REVISION_MIGRATIONS,
  ...TASK_AUTHORITY_CLOSURE_MIGRATIONS,
  ...TASK_AUTHORITY_PUBLISH_MIGRATIONS,
  ...OWNER_BOUNDARY_SOURCE_MIGRATIONS,
  ...POLICY_APPROVAL_INTENT_MIGRATIONS,
  ...NAVIGATOR_RELEASE_MIGRATIONS,
  ...NAVIGATOR_PROMOTION_MIGRATIONS,
  ...NAVIGATOR_REVIEW_LEDGER_MIGRATIONS,
  ...MANAGED_AUTOMATION_MIGRATIONS,
  ...NAVIGATOR_RELEASE_REVIEW_LEDGER_UPGRADE_MIGRATIONS,
  ...MANAGED_AUTOMATION_STATE_UPGRADE_MIGRATIONS,
  ...CONTROLLER_BURST_MIGRATIONS,
  ...NAVIGATOR_EFFECT_PROTOCOL_MIGRATIONS,
  ...MANAGED_AUTOMATION_LIFECYCLE_MIGRATIONS,
  ...NAVIGATOR_FINDING_LEDGER_UPGRADE_MIGRATIONS,
] as const;
