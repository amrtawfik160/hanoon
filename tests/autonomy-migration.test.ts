import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import {
  ALL_MIGRATIONS,
  OWNER_BOUNDARY_SOURCE_MIGRATIONS,
  OWNER_BOUNDARY_MIGRATIONS,
  POLICY_APPROVAL_INTENT_MIGRATIONS,
  RELEASE_AUTHORITY_MIGRATIONS,
  TASK_AUTHORITY_MIGRATIONS,
  TASK_AUTHORITY_CLOSURE_MIGRATIONS,
  TASK_AUTHORITY_PUBLISH_MIGRATIONS,
  TASK_AUTHORITY_REVISION_MIGRATIONS,
  NAVIGATOR_RELEASE_MIGRATIONS,
  NAVIGATOR_PROMOTION_MIGRATIONS,
  NAVIGATOR_REVIEW_LEDGER_MIGRATIONS,
  MANAGED_AUTOMATION_MIGRATIONS,
  NAVIGATOR_RELEASE_REVIEW_LEDGER_UPGRADE_MIGRATIONS,
  MANAGED_AUTOMATION_STATE_UPGRADE_MIGRATIONS,
  NAVIGATOR_EFFECT_PROTOCOL_MIGRATIONS,
  NAVIGATOR_FINDING_LEDGER_UPGRADE_MIGRATIONS,
} from "../src/storage/migrations";
import {
  WorkArtifactRepository,
  registerWorkArtifactRelationshipValidation,
} from "../src/work-artifacts/repository";
import { NavigatorEffectProtocol } from "../src/navigator/effect-protocol";
import { runJobExecutorService } from "../src/services/job-executor-service";
import { openStore } from "../src/storage/store";

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
const TICKET_41_MIGRATION_COUNT = TASK_AUTHORITY_MIGRATIONS.length +
  RELEASE_AUTHORITY_MIGRATIONS.length + OWNER_BOUNDARY_MIGRATIONS.length +
  TASK_AUTHORITY_REVISION_MIGRATIONS.length + TASK_AUTHORITY_CLOSURE_MIGRATIONS.length +
  TASK_AUTHORITY_PUBLISH_MIGRATIONS.length + OWNER_BOUNDARY_SOURCE_MIGRATIONS.length +
  POLICY_APPROVAL_INTENT_MIGRATIONS.length;
const TICKET_42_MIGRATION_COUNT = NAVIGATOR_RELEASE_MIGRATIONS.length;
const TICKET_43_MIGRATION_COUNT = NAVIGATOR_PROMOTION_MIGRATIONS.length;
const TICKET_44_MIGRATION_COUNT = NAVIGATOR_REVIEW_LEDGER_MIGRATIONS.length;
const TICKET_45_MIGRATION_COUNT = MANAGED_AUTOMATION_MIGRATIONS.length;
const NATIVE_SDLC_UPGRADE_MIGRATION_COUNT = NAVIGATOR_RELEASE_REVIEW_LEDGER_UPGRADE_MIGRATIONS.length +
  MANAGED_AUTOMATION_STATE_UPGRADE_MIGRATIONS.length;
const NAVIGATOR_EFFECT_PROTOCOL_MIGRATION_COUNT = NAVIGATOR_EFFECT_PROTOCOL_MIGRATIONS.length;
const FINDING_LEDGER_UPGRADE_MIGRATION_COUNT = NAVIGATOR_FINDING_LEDGER_UPGRADE_MIGRATIONS.length;

const PRE_TICKET_41_MIGRATION_COUNT = ALL_MIGRATIONS.length
  - TICKET_41_MIGRATION_COUNT - TICKET_42_MIGRATION_COUNT - TICKET_43_MIGRATION_COUNT -
  TICKET_44_MIGRATION_COUNT - TICKET_45_MIGRATION_COUNT - NATIVE_SDLC_UPGRADE_MIGRATION_COUNT -
  NAVIGATOR_EFFECT_PROTOCOL_MIGRATION_COUNT - FINDING_LEDGER_UPGRADE_MIGRATION_COUNT;

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
  const db = bb.storage.database();
  registerWorkArtifactRelationshipValidation(db);
  bb.storage.migrate(db, [...ALL_MIGRATIONS]);
}

function admissionUpgradeDatabase(pluginId: string, revisionJobId = "job_1") {
  const { bb } = createFakePluginHost({ pluginId });
  const db = bb.storage.database();
  registerWorkArtifactRelationshipValidation(db);
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(
    0,
    -(
      TASK_AUTHORITY_PUBLISH_MIGRATIONS.length + OWNER_BOUNDARY_SOURCE_MIGRATIONS.length +
      POLICY_APPROVAL_INTENT_MIGRATIONS.length + NAVIGATOR_RELEASE_MIGRATIONS.length +
      NAVIGATOR_PROMOTION_MIGRATIONS.length + NAVIGATOR_REVIEW_LEDGER_MIGRATIONS.length +
      MANAGED_AUTOMATION_MIGRATIONS.length + NATIVE_SDLC_UPGRADE_MIGRATION_COUNT +
      NAVIGATOR_EFFECT_PROTOCOL_MIGRATION_COUNT + FINDING_LEDGER_UPGRADE_MIGRATION_COUNT
    ),
  ));
  db.prepare(
    `INSERT INTO controller_threads (
       controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at
     ) VALUES ('controller_1', '7', '7', 'active', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO jobs (id, source_update_id, request_text, state, created_at, updated_at)
     VALUES
       ('job_1', 1, 'First task', 'cancelled', 1000, 1000),
       ('job_2', 2, 'Second task', 'cancelled', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES ('job_1:publish', 'job_1', 'inspect_implementation', '{}', 'pending', 0, 1000, 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO task_authority_revisions (
       authority_id, revision, job_id, owner_user_id, owner_chat_id, controller_key,
       source_update_id, request_digest, project_id, task_outcome, scope_digest,
       constraints_json, policy_version, policy_digest, artifact_graph_digest,
       status, created_at, updated_at
     ) VALUES (
       'authority_1', 1, ?, '7', '7', 'controller_1', 1, ?, 'proj_1',
       'reviewed_change', ?, '[]', 1, ?, ?, 'active', 1000, 1000
     )`,
  ).run(revisionJobId, "a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64));
  db.prepare(
    `INSERT INTO task_authority_effect_admissions (
       effect_idempotency_key, job_id, authority_id, authority_revision, effect, admitted_at
     ) VALUES ('job_1:publish', 'job_1', 'authority_1', 1, 'commit', 1000)`,
  ).run();
  return { bb, db };
}

function insertRelationshipUpgradeArtifact(
  db: ReturnType<typeof legacyDatabase>["db"],
  id: string,
  operationId: string,
  externalId: string,
): void {
  db.prepare(
    `INSERT INTO work_artifacts (
       id, project_id, effort_id, operation_id, kind, initial_status, status,
       tracker_kind, tracker_namespace, external_id, external_url, external_revision,
       external_status, assignees_json, title, tracker_order, current_revision,
       current_snapshot_id, remote_closed_at, created_at, updated_at
     ) VALUES (?, 'proj_1', 'effort_1', ?, 'implementation_ticket', 'ready', 'ready',
       'github', 'github:acme/widgets', ?, NULL, 'etag-1', 'open', '[]', ?, 0, 0,
       NULL, NULL, 1000, 1000)`,
  ).run(id, operationId, externalId, operationId);
}

function insertLegacyNavigatorEffect(
  db: ReturnType<typeof legacyDatabase>["db"],
  input: { jobId: string; effectKey: string; kind: string; status: "pending" | "leased" },
): void {
  db.prepare(
    `INSERT INTO jobs (
       id, source_update_id, request_text, state, workflow_engine, workflow_mode,
       workflow_revision, artifact_bindings_json, created_at, updated_at
     ) VALUES (?, ?, 'legacy request', 'planning', 'navigator-v1', 'deterministic', 1, '[]', 900, 1000)`,
  ).run(input.jobId, Number(input.jobId.replace("job_legacy_", "")));
  db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       lease_owner, lease_generation, lease_expires_at,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1000, 1000, 1000)`,
  ).run(
    input.effectKey,
    input.jobId,
    input.kind,
    "{}",
    input.status,
    input.status === "leased" ? "legacy-worker" : null,
    input.status === "leased" ? 1 : null,
    input.status === "leased" ? 2_000 : null,
  );
}

function insertLegacySkillAttempt(
  db: ReturnType<typeof legacyDatabase>["db"],
  effectKey: string,
): void {
  db.prepare(
    `INSERT INTO navigator_skill_attempts (
       id, job_id, workflow_step_id, effect_idempotency_key, skill_id, skill_revision,
       skill_source_digest, descriptor_digest, step_contract_id, step_contract_revision,
       step_contract_digest, catalog_digest, step_input_json, step_input_digest,
       model_route_json, artifact_bindings_json, snapshot_digest, job_version,
       workflow_revision, resource_kind, resource_id, created_at, updated_at
     ) VALUES ('skill_legacy', 'job_legacy_1', 'legacy_step_1', ?, 'skill', '1',
       'source', 'descriptor', 'contract', 1, 'contract-digest', 'catalog', '{}',
       'input', '{}', '{}', 'snapshot', 1, 1, NULL, NULL, 1000, 1000)`,
  ).run(effectKey);
}

function insertLegacyTicketAttempt(
  db: ReturnType<typeof legacyDatabase>["db"],
  effectKey: string,
): void {
  db.prepare(
    `INSERT INTO navigator_ticket_worker_attempts (
       id, job_id, slice_id, kind, ordinal, effect_idempotency_key, work_order_json,
       work_order_digest, step_contract_id, step_contract_revision, step_contract_digest,
       profile_json, profile_digest, model_route_json, resource_kind, resource_id,
       created_at, updated_at
     ) VALUES ('ticket_legacy', 'job_legacy_2', 'legacy_slice_2', 'implementation', 1, ?,
       '{}', 'work-order', 'contract', 1, 'contract-digest', '{}', 'profile', '{}',
       NULL, NULL, 1000, 1000)`,
  ).run(effectKey);
}

function insertLegacyReleaseAttempt(
  db: ReturnType<typeof legacyDatabase>["db"],
  effectKey: string,
): void {
  db.prepare(
    `INSERT INTO navigator_release_attempts (
       id, job_id, workflow_step_id, effect_idempotency_key, implementation_ticket_ids_json,
       snapshot_digest, job_version, workflow_revision, created_at, updated_at
     ) VALUES ('release_legacy', 'job_legacy_3', 'legacy_step_3', ?, '[]', ?, 1, 1, 1000, 1000)`,
  ).run(effectKey, "a".repeat(64));
}

it("keeps the autonomy migration after the frozen legacy positions and appends later migrations", () => {
  expect(PRE_TICKET_41_MIGRATION_COUNT).toBe(LEGACY_MIGRATION_COUNT + 64);
  expect(ALL_MIGRATIONS).toHaveLength(
    PRE_TICKET_41_MIGRATION_COUNT + TICKET_41_MIGRATION_COUNT + TICKET_42_MIGRATION_COUNT +
      TICKET_43_MIGRATION_COUNT + TICKET_44_MIGRATION_COUNT + TICKET_45_MIGRATION_COUNT +
      NATIVE_SDLC_UPGRADE_MIGRATION_COUNT + NAVIGATOR_EFFECT_PROTOCOL_MIGRATION_COUNT +
      FINDING_LEDGER_UPGRADE_MIGRATION_COUNT,
  );
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
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 44]).toContain("CREATE TABLE stage_executions");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 49]).toContain("CREATE TABLE reference_documents");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 50]).toContain("ADD COLUMN controller_key");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 51]).toContain("CREATE TABLE reference_section_digests");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 52]).toContain("CREATE TABLE project_admission_pause_clear_history");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 53]).toContain("CREATE TABLE controller_voice_inbox");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 55]).toContain("CREATE TABLE audit_intake_findings");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 56]).toContain("merge_pre_approved_at");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 57]).toContain("CREATE TABLE work_artifacts");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 57])
    .toContain("CREATE TABLE work_artifact_create_intents");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 57])
    .toContain("CREATE TABLE work_artifact_tracker_mutations");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 57])
    .toContain("workflow_step_id TEXT NOT NULL");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 57])
    .toContain("job_id TEXT NOT NULL REFERENCES jobs(id)");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 58])
    .toContain("work_artifact_relationships_internal_refs");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 59])
    .toContain("work_artifact_relationships_canonical_insert");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 60])
    .toContain("CREATE TABLE navigator_snapshots");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 61])
    .toContain("CREATE TABLE navigator_planning_results");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 62])
    .toContain("CREATE TABLE navigator_integrations");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 62])
    .toContain("CREATE TABLE navigator_ticket_worker_outcomes");
  expect(ALL_MIGRATIONS[LEGACY_MIGRATION_COUNT + 62])
    .toContain("CREATE TABLE navigator_pull_requests");
});

it("upgrades publisher admissions without losing grants and enforces exact durable identities", () => {
  const { bb, db } = admissionUpgradeDatabase("task-authority-publish-upgrade");

  bb.storage.migrate(db, [...ALL_MIGRATIONS]);

  expect(db.prepare(
    "SELECT effect FROM task_authority_effect_admissions ORDER BY effect",
  ).all()).toEqual([{ effect: "commit" }]);
  db.prepare(
    `INSERT INTO task_authority_effect_admissions (
       effect_idempotency_key, job_id, authority_id, authority_revision, effect,
       effect_payload_json, admitted_at
     ) VALUES ('job_1:publish', 'job_1', 'authority_1', 1, 'push', '{}', 1001)`,
  ).run();
  expect(() => db.prepare(
    `INSERT INTO task_authority_effect_admissions (
       effect_idempotency_key, job_id, authority_id, authority_revision, effect,
       effect_payload_json, admitted_at
     ) VALUES ('job_1:publish', 'job_2', 'authority_1', 1, 'pull_request', '{}', 1002)`,
  ).run()).toThrow(/source identity mismatch/u);
  expect(() => db.prepare(
    `INSERT INTO task_authority_narrowings (
       source_update_id, controller_key, owner_user_id, owner_chat_id, job_id,
       authority_id, source_revision, target_revision, task_outcome, constraints_json, recorded_at
     ) VALUES (3, 'controller_1', '7', '7', 'job_1', 'authority_1', 1, 2,
       'artifact', '[]', 1003)`,
  ).run()).toThrow(/payload identity is required/u);
});

it("rolls back the boundary-source upgrade when active legacy evidence cannot be proven", () => {
  const { bb, db } = admissionUpgradeDatabase("owner-boundary-source-upgrade");
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(
    0,
    -(OWNER_BOUNDARY_SOURCE_MIGRATIONS.length + POLICY_APPROVAL_INTENT_MIGRATIONS.length +
      NAVIGATOR_RELEASE_MIGRATIONS.length + NAVIGATOR_PROMOTION_MIGRATIONS.length +
      NAVIGATOR_REVIEW_LEDGER_MIGRATIONS.length + MANAGED_AUTOMATION_MIGRATIONS.length +
      NATIVE_SDLC_UPGRADE_MIGRATION_COUNT + NAVIGATOR_EFFECT_PROTOCOL_MIGRATION_COUNT +
      FINDING_LEDGER_UPGRADE_MIGRATION_COUNT),
  ));
  db.prepare(
    `INSERT INTO task_authorities (
       authority_id, job_id, revision, owner_user_id, owner_chat_id, controller_key,
       source_update_id, request_digest, project_id, task_outcome, scope_digest,
       constraints_json, policy_version, policy_digest, artifact_graph_digest,
       status, created_at, updated_at
     ) VALUES (
       'authority_1', 'job_1', 1, '7', '7', 'controller_1', 1, ?, 'proj_1',
       'reviewed_change', ?, '[]', 1, ?, ?, 'active', 1000, 1000
     )`,
  ).run("a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64));
  db.prepare(
    `INSERT INTO owner_boundaries (
       boundary_id, job_id, digest, authority_id, authority_revision, code,
       goal, blocker, prior_checks_json, options_json, recommendation, paused_effect,
       evidence_facts_json, affected_artifact_id, affected_effect_idempotency_key,
       owner_user_id, owner_chat_id, status, created_at, updated_at
     ) VALUES (
       'boundary_legacy', 'job_1', ?, 'authority_1', 1, 'policy_change_required',
       'Ship safely', 'Policy is unresolved', '["Checked policy"]',
       '[{"label":"Configure","consequence":"Continue safely"}]',
       'Configure policy', 'Merge is paused', '["policy:change-required"]',
       NULL, 'job_1:publish', '7', '7', 'pending', 1000, 1000
     )`,
  ).run("e".repeat(64));
  const ledgerBefore = db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all();

  expect(() => bb.storage.migrate(db, [...ALL_MIGRATIONS])).toThrow();
  expect(db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all()).toEqual(ledgerBefore);
  expect(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policy_boundary_observations'",
  ).get()).toBeUndefined();
});

it("rolls back the publisher migration when a legacy admission crosses job identity", () => {
  const { bb, db } = admissionUpgradeDatabase("task-authority-publish-rollback", "job_2");

  expect(() => bb.storage.migrate(db, [...ALL_MIGRATIONS])).toThrow();
  expect(db.prepare("SELECT effect FROM task_authority_effect_admissions").all())
    .toEqual([{ effect: "commit" }]);
  expect(() => db.prepare(
    `INSERT INTO task_authority_effect_admissions (
       effect_idempotency_key, job_id, authority_id, authority_revision, effect, admitted_at
     ) VALUES ('job_1:publish', 'job_1', 'authority_1', 1, 'push', 1001)`,
  ).run()).toThrow();
  const narrowingColumns = db.prepare("PRAGMA table_info(task_authority_narrowings)").all() as Array<{ name: string }>;
  expect(narrowingColumns.map((column) => column.name)).not.toContain("source_message_id");
});

it("backfills the mutable ticket-41 authority row into immutable revision history", () => {
  const { bb } = createFakePluginHost({ pluginId: "task-authority-revision-backfill" });
  const db = bb.storage.database();
  registerWorkArtifactRelationshipValidation(db);
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(
    0,
    -(
      TASK_AUTHORITY_REVISION_MIGRATIONS.length + TASK_AUTHORITY_CLOSURE_MIGRATIONS.length +
      TASK_AUTHORITY_PUBLISH_MIGRATIONS.length + OWNER_BOUNDARY_SOURCE_MIGRATIONS.length +
      POLICY_APPROVAL_INTENT_MIGRATIONS.length + NAVIGATOR_RELEASE_MIGRATIONS.length +
      NAVIGATOR_PROMOTION_MIGRATIONS.length + NAVIGATOR_REVIEW_LEDGER_MIGRATIONS.length +
      MANAGED_AUTOMATION_MIGRATIONS.length + NATIVE_SDLC_UPGRADE_MIGRATION_COUNT +
      NAVIGATOR_EFFECT_PROTOCOL_MIGRATION_COUNT + FINDING_LEDGER_UPGRADE_MIGRATION_COUNT
    ),
  ));
  db.prepare(
    `INSERT INTO controller_threads (
       controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at
     ) VALUES ('controller_1', '7', '7', 'active', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO jobs (id, source_update_id, request_text, state, created_at, updated_at)
     VALUES ('job_1', 1, 'Fix the retry loop', 'cancelled', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO task_authorities (
       authority_id, job_id, revision, owner_user_id, owner_chat_id, controller_key,
       source_update_id, request_digest, project_id, task_outcome, scope_digest,
       constraints_json, policy_version, policy_digest, artifact_graph_digest,
       status, created_at, updated_at
     ) VALUES (
       'authority_1', 'job_1', 3, '7', '7', 'controller_1', 1, ?, 'proj_1',
       'reviewed_change', ?, '["no_merge"]', 1, ?, ?, 'active', 1000, 3000
     )`,
  ).run("a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64));

  bb.storage.migrate(db, [...ALL_MIGRATIONS]);

  expect(db.prepare(
    "SELECT authority_id, revision, task_outcome, constraints_json FROM task_authority_revisions",
  ).all()).toEqual([{
    authority_id: "authority_1",
    revision: 3,
    task_outcome: "reviewed_change",
    constraints_json: '["no_merge"]',
  }]);
  expect(db.prepare("SELECT * FROM task_authority_current").all()).toEqual([{
    job_id: "job_1",
    authority_id: "authority_1",
    revision: 3,
  }]);
  expect(() => db.prepare(
    "UPDATE task_authority_revisions SET task_outcome = 'shipped_change' WHERE authority_id = 'authority_1'",
  ).run()).toThrow(/append-only/u);
});

it("fails the authority upgrade when an older bound revision cannot be reconstructed", () => {
  const { bb } = createFakePluginHost({ pluginId: "task-authority-history-guard" });
  const db = bb.storage.database();
  registerWorkArtifactRelationshipValidation(db);
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(
    0,
    -(
      TASK_AUTHORITY_REVISION_MIGRATIONS.length + TASK_AUTHORITY_CLOSURE_MIGRATIONS.length +
      TASK_AUTHORITY_PUBLISH_MIGRATIONS.length + OWNER_BOUNDARY_SOURCE_MIGRATIONS.length +
      POLICY_APPROVAL_INTENT_MIGRATIONS.length + NAVIGATOR_RELEASE_MIGRATIONS.length +
      NAVIGATOR_PROMOTION_MIGRATIONS.length + NAVIGATOR_REVIEW_LEDGER_MIGRATIONS.length +
      MANAGED_AUTOMATION_MIGRATIONS.length + NATIVE_SDLC_UPGRADE_MIGRATION_COUNT +
      NAVIGATOR_EFFECT_PROTOCOL_MIGRATION_COUNT + FINDING_LEDGER_UPGRADE_MIGRATION_COUNT
    ),
  ));
  db.prepare(
    `INSERT INTO controller_threads (
       controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at
     ) VALUES ('controller_1', '7', '7', 'active', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO jobs (id, source_update_id, request_text, state, created_at, updated_at)
     VALUES ('job_1', 1, 'Fix the retry loop', 'cancelled', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO task_authorities (
       authority_id, job_id, revision, owner_user_id, owner_chat_id, controller_key,
       source_update_id, request_digest, project_id, task_outcome, scope_digest,
       constraints_json, policy_version, policy_digest, artifact_graph_digest,
       status, created_at, updated_at
     ) VALUES (
       'authority_1', 'job_1', 3, '7', '7', 'controller_1', 1, ?, 'proj_1',
       'reviewed_change', ?, '["no_merge"]', 1, ?, ?, 'active', 1000, 3000
     )`,
  ).run("a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64));
  db.prepare(
    `INSERT INTO task_authority_events (
       authority_id, job_id, revision, action, reason, occurred_at
     ) VALUES
       ('authority_1', 'job_1', 2, 'revised', 'artifact_graph_advanced', 2000),
       ('authority_1', 'job_1', 3, 'revised', 'artifact_graph_advanced', 3000)`,
  ).run();
  db.prepare(
    `INSERT INTO owner_boundaries (
       boundary_id, job_id, digest, authority_id, authority_revision, code,
       goal, blocker, prior_checks_json, options_json, recommendation,
       paused_effect, affected_artifact_id, affected_effect_idempotency_key,
       owner_user_id, owner_chat_id, status, created_at, updated_at
     ) VALUES (
       'boundary_1', 'job_1', ?, 'authority_1', 1, 'policy_change_required',
       'Ship the fix', 'Policy is missing', '["Checked policy"]',
       '[{"label":"Configure","consequence":"Continue"},{"label":"Stop","consequence":"Remain paused"}]',
       'Configure policy', 'Merge remains paused', 'artifact_1', NULL,
       '7', '7', 'pending', 1000, 1000
     )`,
  ).run("e".repeat(64));

  expect(() => bb.storage.migrate(db, [...ALL_MIGRATIONS])).toThrow();
  expect(db.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('task_authority_revisions', 'task_authority_narrowings')`,
  ).get()).toBeUndefined();
});

it("reconstructs an older shipped revision from its authoritative release binding", () => {
  const { bb } = createFakePluginHost({ pluginId: "task-authority-release-reconstruction" });
  const db = bb.storage.database();
  registerWorkArtifactRelationshipValidation(db);
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(
    0,
    -(
      TASK_AUTHORITY_REVISION_MIGRATIONS.length + TASK_AUTHORITY_CLOSURE_MIGRATIONS.length +
      TASK_AUTHORITY_PUBLISH_MIGRATIONS.length + OWNER_BOUNDARY_SOURCE_MIGRATIONS.length +
      POLICY_APPROVAL_INTENT_MIGRATIONS.length + NAVIGATOR_RELEASE_MIGRATIONS.length +
      NAVIGATOR_PROMOTION_MIGRATIONS.length + NAVIGATOR_REVIEW_LEDGER_MIGRATIONS.length +
      MANAGED_AUTOMATION_MIGRATIONS.length + NATIVE_SDLC_UPGRADE_MIGRATION_COUNT +
      NAVIGATOR_EFFECT_PROTOCOL_MIGRATION_COUNT + FINDING_LEDGER_UPGRADE_MIGRATION_COUNT
    ),
  ));
  db.prepare(
    `INSERT INTO controller_threads (
       controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at
     ) VALUES ('controller_1', '7', '7', 'active', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO jobs (id, source_update_id, request_text, state, created_at, updated_at)
     VALUES ('job_1', 1, 'Ship the retry fix', 'merged', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES ('job_1:merge', 'job_1', 'merge_pr', '{}', 'done', 1, 1000, 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO task_authorities (
       authority_id, job_id, revision, owner_user_id, owner_chat_id, controller_key,
       source_update_id, request_digest, project_id, task_outcome, scope_digest,
       constraints_json, policy_version, policy_digest, artifact_graph_digest,
       status, created_at, updated_at
     ) VALUES (
       'authority_1', 'job_1', 3, '7', '7', 'controller_1', 1, ?, 'proj_1',
       'shipped_change', ?, '[]', 1, ?, ?, 'active', 1000, 3000
     )`,
  ).run("a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64));
  db.prepare(
    `INSERT INTO task_authority_events (
       authority_id, job_id, revision, action, reason, occurred_at
     ) VALUES
       ('authority_1', 'job_1', 2, 'revised', 'artifact_graph_advanced', 2000),
       ('authority_1', 'job_1', 3, 'revised', 'artifact_graph_advanced', 3000)`,
  ).run();
  db.prepare(
    `INSERT INTO release_authority_receipts (
       receipt_id, job_id, effect_idempotency_key, authority_id, authority_revision,
       authority_source, project_id, repository, base_branch, environment_id,
       pr_number, head_sha, artifact_graph_digest, review_attempt_id,
       validation_completed_at, required_check_names_json, merge_method,
       production_policy_digest, gate_receipt_digest, status, created_at, updated_at
     ) VALUES (
       'receipt_1', 'job_1', 'job_1:merge', 'authority_1', 1, 'task', 'proj_1',
       'acme/repo', 'main', 'env_1', 1, ?, ?, 'review_1', 1000, '[]', 'squash',
       ?, ?, 'active', 1000, 1000
     )`,
  ).run("1".repeat(40), "e".repeat(64), "f".repeat(64), "0".repeat(64));

  bb.storage.migrate(db, [...ALL_MIGRATIONS]);

  expect(db.prepare(
    `SELECT revision, task_outcome, constraints_json, artifact_graph_digest
       FROM task_authority_revisions WHERE authority_id = 'authority_1' ORDER BY revision`,
  ).all()).toEqual([
    { revision: 1, task_outcome: "shipped_change", constraints_json: "[]", artifact_graph_digest: "e".repeat(64) },
    { revision: 3, task_outcome: "shipped_change", constraints_json: "[]", artifact_graph_digest: "d".repeat(64) },
  ]);
});

it("strengthens relationship triggers after the original artifact migration was applied", () => {
  const { bb } = createFakePluginHost({ pluginId: "work-artifact-relationship-trigger-upgrade" });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, PRE_TICKET_41_MIGRATION_COUNT - 5));
  expect(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_artifact_relationships'",
  ).get()).toEqual({ name: "work_artifact_relationships" });
  const insertArtifact = db.prepare(
    `INSERT INTO work_artifacts (
       id, project_id, effort_id, operation_id, kind, initial_status, status,
       tracker_kind, tracker_namespace, external_id, external_url, external_revision,
       external_status, assignees_json, title, tracker_order, current_revision,
       current_snapshot_id, remote_closed_at, created_at, updated_at
     ) VALUES (?, 'proj_1', 'effort_1', ?, 'implementation_ticket', 'ready', 'ready',
       'github', 'github:acme/widgets', ?, NULL, 'etag-1', 'open', '[]', ?, 0, 0,
       NULL, NULL, 1000, 1000)`,
  );
  insertArtifact.run("artifact_upgrade_owner", "upgrade-owner", "501", "Upgrade owner");
  insertArtifact.run("artifact_upgrade_parent", "upgrade-parent", "502", "Upgrade parent");
  db.prepare(
    `INSERT INTO work_artifact_relationships (
       owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
       target_artifact_id, target_ref, created_at
     ) VALUES (?, 0, 'parent', ?, ?, ?, ?, 1000)`,
  ).run(
    "artifact_upgrade_owner",
    "artifact_upgrade_owner",
    "artifact:artifact_upgrade_owner",
    "artifact_upgrade_parent",
    "artifact:artifact_upgrade_parent",
  );

  registerWorkArtifactRelationshipValidation(db);
  bb.storage.migrate(db, [...ALL_MIGRATIONS]);

  expect(db.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'work_artifact_relationships_internal_refs',
        'work_artifact_relationships_internal_refs_update',
        'work_artifact_relationships_no_self_edge',
        'work_artifact_relationships_no_self_edge_update',
        'work_artifact_relationships_same_effort',
        'work_artifact_relationships_same_effort_update',
        'work_artifact_relationships_touch_owner',
        'work_artifact_relationships_touch_owner_update'
      ) ORDER BY name`,
  ).all()).toEqual([
    { name: "work_artifact_relationships_internal_refs" },
    { name: "work_artifact_relationships_internal_refs_update" },
    { name: "work_artifact_relationships_no_self_edge" },
    { name: "work_artifact_relationships_no_self_edge_update" },
    { name: "work_artifact_relationships_same_effort" },
    { name: "work_artifact_relationships_same_effort_update" },
    { name: "work_artifact_relationships_touch_owner" },
    { name: "work_artifact_relationships_touch_owner_update" },
  ]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM work_artifact_relationships").get())
    .toEqual({ count: 1 });
});

it("SPEC-39-002: backfills preexisting snapshot dependencies for recursive invalidation", () => {
  const { bb } = createFakePluginHost({ pluginId: "navigator-dependency-backfill-upgrade" });
  const db = bb.storage.database();
  registerWorkArtifactRelationshipValidation(db);
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, PRE_TICKET_41_MIGRATION_COUNT - 3));
  const insertArtifact = db.prepare(
    `INSERT INTO work_artifacts (
       id, project_id, effort_id, operation_id, kind, initial_status, status,
       tracker_kind, tracker_namespace, external_id, external_url, external_revision,
       external_status, assignees_json, title, tracker_order, current_revision,
       current_snapshot_id, remote_closed_at, created_at, updated_at
     ) VALUES (?, 'proj_1', 'effort_1', ?, ?, 'ready', 'ready',
       'github', 'github:acme/widgets', ?, NULL, 'etag-1', 'open', '[]', ?, ?, 1,
       ?, NULL, ?, ?)`,
  );
  const insertSnapshot = db.prepare(
    `INSERT INTO work_artifact_snapshots (
       id, artifact_id, revision, title, content, content_digest, snapshot_digest,
       acceptance_criteria_json, relationships_json, external_revision, captured_at
     ) VALUES (?, ?, 1, ?, ?, ?, ?, '[]', ?, 'etag-1', ?)`,
  );
  const artifacts = [
    {
      id: "artifact_upgrade_map",
      operationId: "upgrade-map",
      kind: "map",
      externalId: "701",
      title: "Upgrade map",
      order: 0,
      snapshotId: "snapshot_upgrade_map",
      capturedAt: 1_000,
      relationships: [],
    },
    {
      id: "artifact_upgrade_specification",
      operationId: "upgrade-specification",
      kind: "specification",
      externalId: "702",
      title: "Upgrade specification",
      order: 1,
      snapshotId: "snapshot_upgrade_specification",
      capturedAt: 1_010,
      relationships: [{
        kind: "derived_from",
        sourceArtifactId: "artifact_upgrade_specification",
        sourceRef: "artifact:artifact_upgrade_specification",
        targetArtifactId: "artifact_upgrade_map",
        targetRef: "artifact:artifact_upgrade_map",
      }],
    },
    {
      id: "artifact_upgrade_ticket",
      operationId: "upgrade-ticket",
      kind: "implementation_ticket",
      externalId: "703",
      title: "Upgrade ticket",
      order: 2,
      snapshotId: "snapshot_upgrade_ticket",
      capturedAt: 1_020,
      relationships: [{
        kind: "derived_from",
        sourceArtifactId: "artifact_upgrade_ticket",
        sourceRef: "artifact:artifact_upgrade_ticket",
        targetArtifactId: "artifact_upgrade_specification",
        targetRef: "artifact:artifact_upgrade_specification",
      }],
    },
  ] as const;
  for (const artifact of artifacts) {
    insertArtifact.run(
      artifact.id,
      artifact.operationId,
      artifact.kind,
      artifact.externalId,
      artifact.title,
      artifact.order,
      artifact.snapshotId,
      artifact.capturedAt,
      artifact.capturedAt,
    );
    insertSnapshot.run(
      artifact.snapshotId,
      artifact.id,
      artifact.title,
      `# ${artifact.title}`,
      artifact.id === "artifact_upgrade_map" ? "a".repeat(64) :
        artifact.id === "artifact_upgrade_specification" ? "b".repeat(64) : "c".repeat(64),
      artifact.id === "artifact_upgrade_map" ? "d".repeat(64) :
        artifact.id === "artifact_upgrade_specification" ? "e".repeat(64) : "f".repeat(64),
      JSON.stringify(artifact.relationships),
      artifact.capturedAt,
    );
  }

  bb.storage.migrate(db, [...ALL_MIGRATIONS]);

  expect(db.prepare(
    `SELECT snapshot_id, upstream_snapshot_id
       FROM work_artifact_snapshot_dependencies
      ORDER BY snapshot_id, upstream_snapshot_id`,
  ).all()).toEqual([
    {
      snapshot_id: "snapshot_upgrade_specification",
      upstream_snapshot_id: "snapshot_upgrade_map",
    },
    {
      snapshot_id: "snapshot_upgrade_ticket",
      upstream_snapshot_id: "snapshot_upgrade_specification",
    },
  ]);
  db.prepare(
    `INSERT INTO work_artifact_snapshots (
       id, artifact_id, revision, title, content, content_digest, snapshot_digest,
       acceptance_criteria_json, relationships_json, external_revision, captured_at
     ) VALUES ('snapshot_upgrade_map_2', 'artifact_upgrade_map', 2, 'Upgrade map',
       '# Upgrade map revised', ?, ?, '[]', '[]', 'etag-2', 1100)`,
  ).run("1".repeat(64), "2".repeat(64));
  db.prepare(
    `INSERT INTO work_artifact_snapshot_invalidations (
       snapshot_id, replacement_snapshot_id, reason, observed_at
     ) VALUES ('snapshot_upgrade_map', 'snapshot_upgrade_map_2', 'remote_edit', 1100)`,
  ).run();
  db.prepare(
    `UPDATE work_artifacts
        SET current_revision = 2, current_snapshot_id = 'snapshot_upgrade_map_2',
            external_revision = 'etag-2', updated_at = 1100
      WHERE id = 'artifact_upgrade_map'`,
  ).run();
  const repository = new WorkArtifactRepository(db);
  expect(repository.isSnapshotValid("snapshot_upgrade_specification")).toBe(false);
  expect(repository.isSnapshotValid("snapshot_upgrade_ticket")).toBe(false);
});

it.each([
  ["source artifact ID with an external ref", [
    "artifact_upgrade_owner", "external:owner", null, "external:source",
  ]],
  ["target artifact ID with an external ref", [
    null, "external:source", "artifact_upgrade_owner", "external:owner",
  ]],
  ["reserved source ref without an artifact ID", [
    null, "artifact:artifact_upgrade_owner", "artifact_upgrade_owner",
    "artifact:artifact_upgrade_owner",
  ]],
  ["ref self edge", [
    "artifact_upgrade_owner", "external:same", null, "external:same",
  ]],
] as const)("atomically rejects a relationship migration with a preexisting %s", (
  _scenario,
  relationship,
) => {
  const { bb } = createFakePluginHost({
    pluginId: `work-artifact-invalid-relationship-upgrade-${String(relationship[1])}`,
  });
  const db = bb.storage.database();
  const migrationsBeforeUpgrade = PRE_TICKET_41_MIGRATION_COUNT - 6;
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, migrationsBeforeUpgrade));
  const insertArtifact = db.prepare(
    `INSERT INTO work_artifacts (
       id, project_id, effort_id, operation_id, kind, initial_status, status,
       tracker_kind, tracker_namespace, external_id, external_url, external_revision,
       external_status, assignees_json, title, tracker_order, current_revision,
       current_snapshot_id, remote_closed_at, created_at, updated_at
     ) VALUES (?, 'proj_1', 'effort_1', ?, 'implementation_ticket', 'ready', 'ready',
       'github', 'github:acme/widgets', ?, NULL, 'etag-1', 'open', '[]', ?, 0, 0,
       NULL, NULL, 1000, 1000)`,
  );
  insertArtifact.run("artifact_upgrade_owner", "upgrade-owner", "501", "Upgrade owner");
  db.prepare(
    `INSERT INTO work_artifact_relationships (
       owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
       target_artifact_id, target_ref, created_at
     ) VALUES ('artifact_upgrade_owner', 0, 'derived_from', ?, ?, ?, ?, 1000)`,
  ).run(...relationship);
  const ledgerBefore = db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all();
  const triggersBefore = db.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = 'work_artifact_relationships'
      ORDER BY name`,
  ).all();
  const rowsBefore = db.prepare(
    "SELECT * FROM work_artifact_relationships ORDER BY owner_artifact_id, ordinal",
  ).all();

  registerWorkArtifactRelationshipValidation(db);
  expect(() => bb.storage.migrate(db, [...ALL_MIGRATIONS])).toThrow();
  expect(db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all()).toEqual(ledgerBefore);
  expect(ledgerBefore).toHaveLength(migrationsBeforeUpgrade);
  expect(db.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = 'work_artifact_relationships'
      ORDER BY name`,
  ).all()).toEqual(triggersBefore);
  expect(db.prepare(
    "SELECT * FROM work_artifact_relationships ORDER BY owner_artifact_id, ordinal",
  ).all()).toEqual(rowsBefore);
  expect(db.prepare(
    "SELECT name FROM sqlite_temp_master WHERE name = 'work_artifact_relationship_identity_guard'",
  ).get()).toBeUndefined();
});

it.each([
  ["whitespace-prefixed reserved ref", (db: ReturnType<typeof legacyDatabase>["db"]) => {
    insertRelationshipUpgradeArtifact(db, "artifact_canonical_owner", "canonical-owner", "601");
    db.prepare(
      `INSERT INTO work_artifact_relationships (
         owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
         target_artifact_id, target_ref, created_at
       ) VALUES (?, 0, 'derived_from', ?, ?, NULL, ?, 1000)`,
    ).run(
      "artifact_canonical_owner",
      "artifact_canonical_owner",
      "artifact:artifact_canonical_owner",
      " artifact:external-target",
    );
  }],
  ["NFKC-equivalent reserved ref", (db: ReturnType<typeof legacyDatabase>["db"]) => {
    insertRelationshipUpgradeArtifact(db, "artifact_canonical_owner", "canonical-owner", "602");
    db.prepare(
      `INSERT INTO work_artifact_relationships (
         owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
         target_artifact_id, target_ref, created_at
       ) VALUES (?, 0, 'derived_from', ?, ?, NULL, ?, 1000)`,
    ).run(
      "artifact_canonical_owner",
      "artifact_canonical_owner",
      "artifact:artifact_canonical_owner",
      "ａｒｔｉｆａｃｔ:external-target",
    );
  }],
  ["directionally invalid relationship", (db: ReturnType<typeof legacyDatabase>["db"]) => {
    insertRelationshipUpgradeArtifact(db, "artifact_canonical_owner", "canonical-owner", "603");
    insertRelationshipUpgradeArtifact(db, "artifact_canonical_related", "canonical-related", "604");
    db.prepare(
      `INSERT INTO work_artifact_relationships (
         owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
         target_artifact_id, target_ref, created_at
       ) VALUES (?, 0, 'parent', ?, ?, ?, ?, 1000)`,
    ).run(
      "artifact_canonical_owner",
      "artifact_canonical_related",
      "artifact:artifact_canonical_related",
      "artifact_canonical_owner",
      "artifact:artifact_canonical_owner",
    );
  }],
  ["multiple parent relationships", (db: ReturnType<typeof legacyDatabase>["db"]) => {
    insertRelationshipUpgradeArtifact(db, "artifact_canonical_owner", "canonical-owner", "605");
    insertRelationshipUpgradeArtifact(db, "artifact_canonical_parent_a", "canonical-parent-a", "606");
    insertRelationshipUpgradeArtifact(db, "artifact_canonical_parent_b", "canonical-parent-b", "607");
    const insert = db.prepare(
      `INSERT INTO work_artifact_relationships (
         owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
         target_artifact_id, target_ref, created_at
       ) VALUES (?, ?, 'parent', ?, ?, ?, ?, 1000)`,
    );
    for (const [ordinal, parent] of [
      [0, "artifact_canonical_parent_a"],
      [1, "artifact_canonical_parent_b"],
    ] as const) {
      insert.run(
        "artifact_canonical_owner",
        ordinal,
        "artifact_canonical_owner",
        "artifact:artifact_canonical_owner",
        parent,
        `artifact:${parent}`,
      );
    }
  }],
  ["corrupted immutable snapshot relationships", (db: ReturnType<typeof legacyDatabase>["db"]) => {
    insertRelationshipUpgradeArtifact(db, "artifact_canonical_owner", "canonical-owner", "608");
    db.prepare(
      `INSERT INTO work_artifact_snapshots (
         id, artifact_id, revision, title, content, content_digest, snapshot_digest,
         acceptance_criteria_json, relationships_json, external_revision, captured_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, '[]', ?, 'etag-snapshot', 1000)`,
    ).run(
      "snapshot_canonical_invalid",
      "artifact_canonical_owner",
      "Invalid relationship snapshot",
      "# Goal\n\nReject corrupted immutable relationships.",
      "a".repeat(64),
      "b".repeat(64),
      JSON.stringify([{
        kind: "parent",
        sourceArtifactId: null,
        sourceRef: "external:source",
        targetArtifactId: "artifact_canonical_owner",
        targetRef: "artifact:artifact_canonical_owner",
      }]),
    );
  }],
] as const)("atomically rejects canonical relationship migration with %s", (_scenario, arrange) => {
  const { bb } = createFakePluginHost({
    pluginId: `work-artifact-canonical-relationship-${String(_scenario).replaceAll(" ", "-")}`,
  });
  const db = bb.storage.database();
  const migrationsBeforeUpgrade = PRE_TICKET_41_MIGRATION_COUNT - 5;
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, migrationsBeforeUpgrade));
  arrange(db);
  const ledgerBefore = db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all();
  const triggersBefore = db.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name IN (
        'work_artifact_relationships', 'work_artifact_snapshots'
      ) ORDER BY name`,
  ).all();
  const relationshipsBefore = db.prepare(
    "SELECT * FROM work_artifact_relationships ORDER BY owner_artifact_id, ordinal",
  ).all();
  const snapshotsBefore = db.prepare(
    "SELECT * FROM work_artifact_snapshots ORDER BY id",
  ).all();

  registerWorkArtifactRelationshipValidation(db);
  expect(() => bb.storage.migrate(db, [...ALL_MIGRATIONS])).toThrow();
  expect(db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all()).toEqual(ledgerBefore);
  expect(db.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name IN (
        'work_artifact_relationships', 'work_artifact_snapshots'
      ) ORDER BY name`,
  ).all()).toEqual(triggersBefore);
  expect(db.prepare(
    "SELECT * FROM work_artifact_relationships ORDER BY owner_artifact_id, ordinal",
  ).all()).toEqual(relationshipsBefore);
  expect(db.prepare("SELECT * FROM work_artifact_snapshots ORDER BY id").all())
    .toEqual(snapshotsBefore);
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

it("continues preceding-schema active Navigator attempts without fabricating capability evidence", async () => {
  const { bb } = createFakePluginHost({ pluginId: "navigator-capability-compatibility" });
  const db = bb.storage.database();
  registerWorkArtifactRelationshipValidation(db);
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(
    0,
    -(NAVIGATOR_EFFECT_PROTOCOL_MIGRATION_COUNT + FINDING_LEDGER_UPGRADE_MIGRATION_COUNT),
  ));

  db.pragma("foreign_keys = OFF");
  insertLegacyNavigatorEffect(db, {
    jobId: "job_legacy_1",
    effectKey: "job_legacy_1:skill",
    kind: "run_navigator_skill",
    status: "pending",
  });
  insertLegacySkillAttempt(db, "job_legacy_1:skill");
  insertLegacyNavigatorEffect(db, {
    jobId: "job_legacy_2",
    effectKey: "job_legacy_2:ticket",
    kind: "run_navigator_ticket_worker",
    status: "leased",
  });
  insertLegacyTicketAttempt(db, "job_legacy_2:ticket");
  insertLegacyNavigatorEffect(db, {
    jobId: "job_legacy_3",
    effectKey: "job_legacy_3:release",
    kind: "run_navigator_release",
    status: "pending",
  });
  insertLegacyReleaseAttempt(db, "job_legacy_3:release");
  db.pragma("foreign_keys = ON");

  applyCurrentMigrations(bb);

  expect(db.prepare(
    `SELECT effect_idempotency_key, job_id, kind, attempt_id, state, reason_code, decoder_revision
       FROM navigator_effect_compatibility
      ORDER BY effect_idempotency_key`,
  ).all()).toEqual([
    {
      effect_idempotency_key: "job_legacy_1:skill",
      job_id: "job_legacy_1",
      kind: "run_navigator_skill",
      attempt_id: "skill_legacy",
      state: "pending",
      reason_code: "preceding_schema_capability_evidence_missing",
      decoder_revision: 1,
    },
    {
      effect_idempotency_key: "job_legacy_2:ticket",
      job_id: "job_legacy_2",
      kind: "run_navigator_ticket_worker",
      attempt_id: "ticket_legacy",
      state: "pending",
      reason_code: "preceding_schema_capability_evidence_missing",
      decoder_revision: 1,
    },
    {
      effect_idempotency_key: "job_legacy_3:release",
      job_id: "job_legacy_3",
      kind: "run_navigator_release",
      attempt_id: "release_legacy",
      state: "pending",
      reason_code: "preceding_schema_capability_evidence_missing",
      decoder_revision: 1,
    },
  ]);
  expect(db.prepare(
    `SELECT idempotency_key, status, lease_owner, lease_generation, lease_expires_at
       FROM effects
      WHERE idempotency_key LIKE 'job_legacy_%'
      ORDER BY idempotency_key`,
  ).all()).toEqual([
    {
      idempotency_key: "job_legacy_1:skill",
      status: "pending",
      lease_owner: null,
      lease_generation: null,
      lease_expires_at: null,
    },
    {
      idempotency_key: "job_legacy_2:ticket",
      status: "leased",
      lease_owner: "legacy-worker",
      lease_generation: 1,
      lease_expires_at: 2_000,
    },
    {
      idempotency_key: "job_legacy_3:release",
      status: "pending",
      lease_owner: null,
      lease_generation: null,
      lease_expires_at: null,
    },
  ]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM navigator_effect_capability_evidence").get())
    .toEqual({ count: 0 });

  const adapter = vi.fn(async () => ({ outcome: "permanent" as const, reason: "must remain quarantined" }));
  const protocol = new NavigatorEffectProtocol({
    store: openStore(bb.storage, bb.storage.kv, () => 1_100),
    clock: { now: () => 1_100 },
    adapters: [
      { kind: "run_navigator_skill", execute: adapter },
      { kind: "run_navigator_ticket_worker", execute: adapter },
      { kind: "run_navigator_release", execute: adapter },
    ],
  });
  const abort = new AbortController();
  await runJobExecutorService({
    store: openStore(bb.storage, bb.storage.kv, () => 1_100),
    clock: { now: () => 1_100 },
    navigatorEffects: protocol,
    effectRunnerFactory: () => ({ run: async () => undefined }),
    waitForWork: async () => abort.abort(),
    releaseOnShutdown: true,
  }, abort.signal);
  expect(adapter).not.toHaveBeenCalled();
  expect(db.prepare(
    "SELECT status FROM effects WHERE idempotency_key IN ('job_legacy_1:skill', 'job_legacy_2:ticket', 'job_legacy_3:release') ORDER BY idempotency_key",
  ).all()).toEqual([{ status: "pending" }, { status: "leased" }, { status: "pending" }]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM navigator_effect_compatibility_resolutions").get())
    .toEqual({ count: 0 });

  bb.storage.migrate(db, [...ALL_MIGRATIONS]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM navigator_effect_compatibility").get())
    .toEqual({ count: 3 });
});
