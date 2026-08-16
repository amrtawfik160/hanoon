import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/storage/migrations";

const LEGACY_MIGRATION_COUNT = 16;
const LEGACY_PROJECT_ID = "proj_legacy";
const LEGACY_POLICY_JSON = JSON.stringify({
  projectId: LEGACY_PROJECT_ID,
  alias: "legacy",
  enabled: true,
  githubRepository: "acme/legacy",
  baseBranch: "main",
  implementation: {},
  review: {},
  validationCommands: [],
  requiredChecks: [],
  outputRedactionPatterns: [],
  workerLivenessWatchdogMs: 60_000,
  maxReviewCycles: 3,
  mergeMethod: "squash",
});
const LEGACY_MIGRATION_MARKERS = [
  [0, "CREATE TABLE owners"],
  [1, "claim_owner"],
  [2, "approval_nonce_hash"],
  [3, "CREATE TABLE controller_threads"],
  [4, "dispatch_after_seq"],
  [5, "CREATE TABLE thread_operations"],
  [6, "CREATE TABLE pipeline_stage_attempts"],
  [7, "documentation_thread_id"],
  [8, "merge_commit_sha"],
  [9, "CREATE TABLE memories"],
  [10, "CREATE TABLE monitors"],
  [11, "CREATE TABLE tool_receipts"],
  [12, "awaiting_interaction_id"],
  [13, "CREATE TABLE observed_threads"],
  [14, "'unsupported'"],
  [15, "notified_at"],
] as const;

function legacyDatabase(pluginId: string) {
  const { bb } = createFakePluginHost({ pluginId });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, LEGACY_MIGRATION_COUNT));
  return { bb, db };
}

function insertLegacyJob(
  db: ReturnType<typeof legacyDatabase>["db"],
  input: {
    id: string;
    sourceUpdateId: number;
    state: string;
    updatedAt: number;
    projectId?: string | null;
    policyJson?: string | null;
    statusMessageId?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO jobs (
       id, source_update_id, request_text, state, project_id, policy_version, policy_json,
       status_message_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sourceUpdateId,
    "legacy request",
    input.state,
    input.projectId ?? null,
    input.projectId === null || input.projectId === undefined ? null : 4,
    input.policyJson ?? null,
    input.statusMessageId ?? null,
    input.updatedAt - 100,
    input.updatedAt,
  );
}

function applyCurrentMigrations(bb: ReturnType<typeof legacyDatabase>["bb"]): void {
  bb.storage.migrate(bb.storage.database(), [...ALL_MIGRATIONS]);
}

it("keeps the autonomy migration after the frozen legacy positions and appends later migrations", () => {
  expect(ALL_MIGRATIONS).toHaveLength(LEGACY_MIGRATION_COUNT + 45);
  for (const [index, marker] of LEGACY_MIGRATION_MARKERS) {
    expect(ALL_MIGRATIONS[index]).toContain(marker);
  }
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT]).toContain("CREATE TABLE autonomy_sequence");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 1]).toContain("image_file_id");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 2]).toContain("supervisor_reasons");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 3]).toContain("CREATE TABLE delegations");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 4]).toContain("CREATE TABLE job_memory_extractions");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 5]).toContain("CREATE TABLE memory_recalls");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 6]).toContain("ADD COLUMN system_key");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 7]).toContain("CREATE TABLE controller_overlay");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 8]).toContain("token_baseline");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 9]).toContain("sealed_at");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 10]).toContain("ADD COLUMN origin");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 11]).toContain("CREATE TABLE production_health");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 12]).toContain("'CONTINUE_REVIEW', 'RETRY'");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 13]).toContain("image_kind");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 14]).toContain("delivery_mode");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 15]).toContain("CREATE TABLE worker_recoveries");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 16]).toContain("adopted_branch");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 17]).toContain("review_lens");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 18]).toContain("PRIMARY KEY(job_id, resource_id)");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 19]).toContain("CREATE TABLE capability_profiles");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 20]).toContain("ADD COLUMN task_recipe");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 21]).toContain("capability_continuation_count");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 22]).toContain("ADD COLUMN settled_at");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 23]).toContain("model_fallback_index");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 24]).toContain("CREATE TABLE controller_evidence");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 25]).toContain("CREATE TABLE controller_interactions");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 28]).toContain("CREATE TABLE credential_bindings");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 29]).toContain("steer_reservation_turn_id");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 30]).toContain("controller_supervisor_steer_attempts");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 31]).toContain("controller_interaction_quarantine");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 32]).toContain("envelope_version");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 33]).toContain("consumed_at");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 34]).toContain("input_accepted");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 35]).toContain("thread_follow_up_json");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 36]).toContain("controller_generation_quarantine");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 37]).toContain("one_open_controller_generation");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 38]).toContain("delivery_state");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 40]).toContain("CREATE TABLE stage_executions");
});

it("creates the autonomy schema and removes one_active_job only after migration backfill", () => {
  const { bb, db } = legacyDatabase("telegram-autonomy-schema");
  applyCurrentMigrations(bb);

  expect(db.prepare(
    `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('autonomy_sequence', 'job_admissions', 'job_resource_claims')
       ORDER BY name`,
  ).all()).toEqual([
    { name: "autonomy_sequence" },
    { name: "job_admissions" },
    { name: "job_resource_claims" },
  ]);
  expect(db.prepare(
    `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name IN (
         'job_admissions_state_queue', 'job_admissions_project_queue',
         'job_resource_claims_job', 'job_resource_claims_held_resource',
         'jobs_status_message_identity'
       )
       ORDER BY name`,
  ).all()).toEqual([
    { name: "job_admissions_project_queue" },
    { name: "job_admissions_state_queue" },
    { name: "job_resource_claims_held_resource" },
    { name: "job_resource_claims_job" },
    { name: "jobs_status_message_identity" },
  ]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'one_active_job'").get()).toBeUndefined();
  expect(db.prepare("SELECT next_queue_seq FROM autonomy_sequence WHERE singleton = 1").get()).toEqual({ next_queue_seq: 1 });
});

it("keeps an awaiting-project legacy job visible without creating an admission", () => {
  const { bb, db } = legacyDatabase("telegram-autonomy-awaiting-project");
  insertLegacyJob(db, {
    id: "job_awaiting_project",
    sourceUpdateId: 101,
    state: "awaiting_project",
    updatedAt: 2_000,
  });

  applyCurrentMigrations(bb);

  expect(db.prepare("SELECT id, state FROM jobs WHERE id = ?").get("job_awaiting_project")).toEqual({
    id: "job_awaiting_project",
    state: "awaiting_project",
  });
  expect(db.prepare("SELECT COUNT(*) AS count FROM job_admissions").get()).toEqual({ count: 0 });
  expect(db.prepare("SELECT next_queue_seq FROM autonomy_sequence WHERE singleton = 1").get()).toEqual({ next_queue_seq: 1 });
});

it("queues an awaiting-confirmation legacy job with a confirmed resume event", () => {
  const { bb, db } = legacyDatabase("telegram-autonomy-awaiting-confirmation");
  insertLegacyJob(db, {
    id: "job_awaiting_confirmation",
    sourceUpdateId: 102,
    state: "awaiting_confirmation",
    updatedAt: 3_000,
    projectId: LEGACY_PROJECT_ID,
    policyJson: LEGACY_POLICY_JSON,
  });

  applyCurrentMigrations(bb);

  expect(db.prepare(
    `SELECT job_id, project_id, queue_seq, state, resume_event, queued_at,
            admitted_at, draining_at, released_at, release_reason
       FROM job_admissions`,
  ).get()).toEqual({
    job_id: "job_awaiting_confirmation",
    project_id: LEGACY_PROJECT_ID,
    queue_seq: 1,
    state: "queued",
    resume_event: "CONFIRMED",
    queued_at: 3_000,
    admitted_at: null,
    draining_at: null,
    released_at: null,
    release_reason: null,
  });
  expect(db.prepare("SELECT next_queue_seq FROM autonomy_sequence WHERE singleton = 1").get()).toEqual({ next_queue_seq: 2 });
});

it.each(["planning", "failed", "reviewing"])(
  "adopts a legacy %s job as admitted with one migration-held project claim",
  (state) => {
    const { bb, db } = legacyDatabase(`telegram-autonomy-${state}`);
    insertLegacyJob(db, {
      id: `job_${state}`,
      sourceUpdateId: 200 + state.length,
      state,
      updatedAt: 4_000,
      projectId: LEGACY_PROJECT_ID,
      policyJson: LEGACY_POLICY_JSON,
    });

    applyCurrentMigrations(bb);

    expect(db.prepare(
      `SELECT job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at
         FROM job_admissions`,
    ).get()).toEqual({
      job_id: `job_${state}`,
      project_id: LEGACY_PROJECT_ID,
      queue_seq: 1,
      state: "admitted",
      resume_event: "CONFIRMED",
      queued_at: 4_000,
      admitted_at: 4_000,
    });
    expect(db.prepare(
      `SELECT job_id, resource_key, resource_kind, state, owner_id, generation,
              lease_expires_at, acquired_at, renewed_at, released_at, release_reason
         FROM job_resource_claims`,
    ).get()).toEqual({
      job_id: `job_${state}`,
      resource_key: `project:${LEGACY_PROJECT_ID}:pipeline`,
      resource_kind: "project",
      state: "held",
      owner_id: "migration-unadopted",
      generation: 0,
      lease_expires_at: 0,
      acquired_at: 4_000,
      renewed_at: 4_000,
      released_at: null,
      release_reason: null,
    });
    expect(db.prepare("SELECT next_queue_seq FROM autonomy_sequence WHERE singleton = 1").get()).toEqual({ next_queue_seq: 2 });
  },
);

it("rolls back instead of repairing a later-state job with missing project identity", () => {
  const { bb, db } = legacyDatabase("telegram-autonomy-invalid-identity");
  insertLegacyJob(db, {
    id: "job_invalid_identity",
    sourceUpdateId: 301,
    state: "planning",
    updatedAt: 5_000,
  });

  expect(() => applyCurrentMigrations(bb)).toThrow();
  expect(db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get()).toEqual({ count: LEGACY_MIGRATION_COUNT });
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_admissions'").get()).toBeUndefined();
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'one_active_job'").get()).toEqual({ name: "one_active_job" });
  expect(db.prepare("SELECT state, project_id, policy_json FROM jobs WHERE id = ?").get("job_invalid_identity")).toEqual({
    state: "planning",
    project_id: null,
    policy_json: null,
  });
});

it("rolls back instead of silently accepting duplicate non-null status identities", () => {
  const { bb, db } = legacyDatabase("telegram-autonomy-duplicate-status");
  insertLegacyJob(db, {
    id: "job_status_one",
    sourceUpdateId: 401,
    state: "merged",
    updatedAt: 6_000,
    statusMessageId: 77,
  });
  insertLegacyJob(db, {
    id: "job_status_two",
    sourceUpdateId: 402,
    state: "cancelled",
    updatedAt: 6_001,
    statusMessageId: 77,
  });

  expect(() => applyCurrentMigrations(bb)).toThrow();
  expect(db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get()).toEqual({ count: LEGACY_MIGRATION_COUNT });
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'jobs_status_message_identity'").get()).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status_message_id = 77").get()).toEqual({ count: 2 });
});

it("rolls back instead of repairing multiple selected legacy nonterminal jobs", () => {
  const { bb, db } = legacyDatabase("telegram-autonomy-too-many-selected");
  db.exec(`
    DROP INDEX one_active_job;
    CREATE INDEX one_active_job
      ON jobs ((1))
      WHERE state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed');
  `);
  insertLegacyJob(db, {
    id: "job_active_one",
    sourceUpdateId: 501,
    state: "planning",
    updatedAt: 7_000,
    projectId: LEGACY_PROJECT_ID,
    policyJson: LEGACY_POLICY_JSON,
  });
  insertLegacyJob(db, {
    id: "job_active_two",
    sourceUpdateId: 502,
    state: "reviewing",
    updatedAt: 7_001,
    projectId: LEGACY_PROJECT_ID,
    policyJson: LEGACY_POLICY_JSON,
  });

  expect(() => applyCurrentMigrations(bb)).toThrow();
  expect(db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get()).toEqual({ count: LEGACY_MIGRATION_COUNT });
  expect(db.prepare(
    `SELECT type, name FROM sqlite_master
       WHERE name IN (
         'autonomy_sequence', 'job_admissions', 'job_resource_claims',
         'job_admissions_state_queue', 'job_admissions_project_queue',
         'job_resource_claims_job', 'job_resource_claims_held_resource',
         'jobs_status_message_identity'
       )
       ORDER BY type, name`,
  ).all()).toEqual([]);
  expect(db.prepare("SELECT type, name FROM sqlite_temp_master WHERE name = 'autonomy_migration_guard'").all()).toEqual([]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'one_active_job'").get()).toEqual({ name: "one_active_job" });
  expect(db.prepare(
    `SELECT id, source_update_id, request_text, state, project_id, policy_version,
            policy_json, status_message_id, created_at, updated_at
       FROM jobs
      WHERE id IN (?, ?)
      ORDER BY id`,
  ).all("job_active_one", "job_active_two")).toEqual([
    {
      id: "job_active_one",
      source_update_id: 501,
      request_text: "legacy request",
      state: "planning",
      project_id: LEGACY_PROJECT_ID,
      policy_version: 4,
      policy_json: LEGACY_POLICY_JSON,
      status_message_id: null,
      created_at: 6_900,
      updated_at: 7_000,
    },
    {
      id: "job_active_two",
      source_update_id: 502,
      request_text: "legacy request",
      state: "reviewing",
      project_id: LEGACY_PROJECT_ID,
      policy_version: 4,
      policy_json: LEGACY_POLICY_JSON,
      status_message_id: null,
      created_at: 6_901,
      updated_at: 7_001,
    },
  ]);
});

it("rolls back instead of repairing a selected job with mismatched policy project identity", () => {
  const { bb, db } = legacyDatabase("telegram-autonomy-mismatched-policy-project");
  const mismatchedPolicyJson = JSON.stringify({
    projectId: "proj_other",
    alias: "legacy",
    enabled: true,
    githubRepository: "acme/legacy",
    baseBranch: "main",
    implementation: {},
    review: {},
    validationCommands: [],
    requiredChecks: [],
    outputRedactionPatterns: [],
    workerLivenessWatchdogMs: 60_000,
    maxReviewCycles: 3,
    mergeMethod: "squash",
  });
  insertLegacyJob(db, {
    id: "job_mismatched_policy_project",
    sourceUpdateId: 503,
    state: "planning",
    updatedAt: 8_000,
    projectId: LEGACY_PROJECT_ID,
    policyJson: mismatchedPolicyJson,
  });

  expect(() => applyCurrentMigrations(bb)).toThrow();
  expect(db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get()).toEqual({ count: LEGACY_MIGRATION_COUNT });
  expect(db.prepare(
    `SELECT type, name FROM sqlite_master
       WHERE name IN (
         'autonomy_sequence', 'job_admissions', 'job_resource_claims',
         'job_admissions_state_queue', 'job_admissions_project_queue',
         'job_resource_claims_job', 'job_resource_claims_held_resource',
         'jobs_status_message_identity'
       )
       ORDER BY type, name`,
  ).all()).toEqual([]);
  expect(db.prepare("SELECT type, name FROM sqlite_temp_master WHERE name = 'autonomy_migration_guard'").all()).toEqual([]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'one_active_job'").get()).toEqual({ name: "one_active_job" });
  expect(db.prepare(
    `SELECT id, source_update_id, request_text, state, project_id, policy_version,
            policy_json, status_message_id, created_at, updated_at
       FROM jobs
      WHERE id = ?`,
  ).get("job_mismatched_policy_project")).toEqual({
    id: "job_mismatched_policy_project",
    source_update_id: 503,
    request_text: "legacy request",
    state: "planning",
    project_id: LEGACY_PROJECT_ID,
    policy_version: 4,
    policy_json: mismatchedPolicyJson,
    status_message_id: null,
    created_at: 7_900,
    updated_at: 8_000,
  });
});
