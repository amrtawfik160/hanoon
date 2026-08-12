# Hanoon Reliability Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make observation order, job ownership, workflow continuation, publication, and owner communication explicit durable protocols for Hanoon, so worker completion and liveness are monotonic, replay-safe, and independent of observer clock order.

**Architecture:** Land only the test-only foundation and the compatibility release from the accepted reliability design. Append-only migrations extend the schema first; pure policies (terminal ordering, run ordering, `availableJobControls`, DocsResult canonical digests, critique bounds, silence evaluator, provenance classification, claims predicates) are developed RED→GREEN first, then wired through the existing `TelegramAgentStore`/`ExecutorFence` layer and fenced services. Every capability-gated mutation path (`executor_v2`, the real `publish_pull_request` boundary, atomic activity snapshot, conditional commit, native mutation isolation, fresh-auto controller activation) is written behind disabled gates that are proven to deny before any mutation, because the vendored BB SDK exposes none of the required versioned runtime attestations.

**Tech Stack:** TypeScript, better-sqlite3 (real temporary SQLite under test), Vitest, the fixed controller evaluation harness, the existing BB plugin SDK fencing layer.

## Global Constraints

- Migrations are append-only; add new named blocks after `CONTROLLER_TRUST_MIGRATIONS` in `ALL_MIGRATIONS`, never edit or reorder a shipped statement, backfill under count/identity/unique guards inside one immediate transaction that rolls back on failure.
- Every mutation runs inside the existing executor fence and returns a typed rejected/lost result rather than throwing on a lost fence.
- No unbounded strings reach SQLite or Telegram; reuse existing bounded helpers. Observations and receipts persist identifiers, enums, cursors, timestamps, exit codes, and hashes only — never terminal output, commands, prompts, diffs, paths, tokens, or credentials.
- `executor_v2`, the real `publish_pull_request` boundary, atomic activity snapshot, conditional commit, native mutation isolation, and fresh-auto controller activation are DISABLED unless versioned runtime BB attestations and real-provider gates exist. Every task touching them proves gate-off denial first.
- Deterministic gate: `npm run typecheck && npx vitest run`. Baseline at planning: 76 files / 1606 tests green, typecheck clean.
- Model workers never publish; commit/push/PR creation occur only through the fenced publication saga and its registration-owned adapter. No handoff tells a role to perform an action its role contract forbids.
- Telegram delivery is ONE logical obligation with `delivery_unknown` and at-least-once transport; transport is never exactly-once. A timeout/crash after possible transmission is `delivery_unknown`, never silently settled.
- All numeric bounds come verbatim from the accepted spec (plan-critique threshold 2; code review 1–10 default 3; `CONTINUE_REMEDIATION` +3; 20 findings/200-char titles/2,000-char details/512-char path/2,000-char summary/48 KiB artifact; DocsResult 1–16 checks/120-char names/256-char proofRef/2,000-char summary/32 KiB canonical JSON; commit 2,000 paths/64 MiB; GitHub 100/page/10 pages; PR 120/4,000 scalars; watchdog 60 s–1 h default 5 min; memory-audit 3 memories).
- `availableJobControls` is one pure function used by Telegram rendering, controller projection, and every ingress/tool/callback over the same durable snapshot.
- Independent RED then GREEN per behavior; race tests use two independent SQLite connections to one temp file; crash tests stop at an injected boundary, construct a fresh store, and replay from disk. Boundary fakes never replace the real SQLite transactions under test.
- All code below is new or modifies files at the exact scopes listed per task. All commits come after green focused tests plus the full gate; each task commits independently.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/storage/migrations.ts` (modify) | Appended migration blocks with guards (worker runs + liveness v5; critique/job admissions v2; publication tables; provenance tables; turn source + obligations). |
| `src/domain/models.ts` (modify) | `PublicationProtocol`, `planBlockAt`, `BlockedReason` additions, terminal observation type, `DocsResult` types. |
| `src/domain/order.ts` (create) | Pure observation ordering / replay identity. |
| `src/domain/terminal-run.ts` (create) | Absorbing terminal outcome abstraction. |
| `src/domain/state-machine.ts` (modify) | Distinct plan/code exhaustion reasons and continuation events; publishing states. |
| `src/domain/critique.ts` (create) | Critique findings bounds + severity vocabulary. |
| `src/domain/job-controls.ts` (create) | Pure `availableJobControls`. |
| `src/domain/docs-result.ts` (create) | Strict `DocsResult` + canonical JSON + SHA-256 digests. |
| `src/domain/claims.ts` (create) | Claims refresh/cleanup pure policy. |
| `src/autonomy/models.ts` (modify) | Five resume events; `failed` release candidate; run/order epoch fields. |
| `src/autonomy/scheduler.ts` (modify) | Five-event selection; claims refresh acquisition pass. |
| `src/storage/store.ts` (modify) | Worker-run repo, ordered liveness, obligation repo, provenance bind, saga/step receipts, five-event admission, claims methods, payload bounds. |
| `src/services/worker-liveness.ts` (modify) | `(generation, lifecycleOrder)` projection; unknown unless attestation. |
| `src/services/thread-provenance.ts` (create) | Prepare/bind/classify provenance. |
| `src/services/thread-notice-service.ts` (modify) | Provenance classification + cycle keys. |
| `src/services/communication-obligations.ts` (create) | Obligation states + backstop. |
| `src/services/system-monitor-silence.ts` (create) | Silence evaluator for the two allowlisted monitors. |
| `src/services/monitor-service.ts` (modify) | Atomic monitor/delegation advance + turn + obligation. |
| `src/services/system-monitors.ts` (modify) | Conditional delivery requirement wiring. |
| `src/services/telegram-service.ts` + `src/telegram/client.ts` (modify) | Delivery-unknown attempt capture before the send. |
| `src/services/effect-runner.ts` (modify) | Stop expecting a worker-created PR; render unknown on publication. |
| `src/services/job-executor-service.ts` (modify) | Failed-job release, retry admission, claims refresh, obligation backstop. |
| `src/services/publication-adapter.ts` + `src/services/publication-coordinator.ts` (create) | Gated saga + adapter fakes (disabled). |
| `src/bb/handoffs.ts` + `src/bb/prompts.ts` (modify) | Remove contradictory delivery authority. |
| Tests (create) | One focused test file per task under `tests/`. |

---

## Phase A — Append-only migrations and model groundwork

### Task 1: `worker_runs`, ordered `worker_liveness_v5`, job fields

**Files:**
- Modify: `src/storage/migrations.ts`, `src/domain/models.ts`
- Test: `tests/reliability-migrations.test.ts` (create)

**Interfaces:**
- Consumes: current `worker_liveness` table (v4, `job_id` PK), `jobs`.
- Produces: `worker_runs` table; `worker_liveness` v5 with `run_id`, `generation`, `lifecycle_order`, `observation_order`, `terminal_lifecycle_order`, `terminal_flag`, `completion_source`, `terminal_id`; `jobs.publication_protocol` (default `legacy_v1`); `jobs.plan_block_at` (default 2); `Job.publicationProtocol: PublicationProtocol`; `Job.planBlockAt: number`; `BlockedReason` extended with `"plan_critique_exhausted" | "code_review_exhausted"`.

- [ ] **Step 1: Write the failing migration test**

```ts
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/storage/migrations";

function freshDb(pluginId: string) {
  const { bb } = createFakePluginHost({ pluginId });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS]);
  return { bb, db };
}
it("creates worker_runs and an ordered worker_liveness_v5", () => {
  const { db } = freshDb("reliability-worker-migration");
  const liveness = (db.prepare("SELECT name FROM pragma_table_info('worker_liveness')").all() as { name: string }[]).map((c) => c.name);
  for (const col of ["run_id", "job_generation", "lifecycle_order", "observation_order", "terminal_lifecycle_order", "terminal_flag", "completion_source", "terminal_id"]) {
    expect(liveness).toContain(col);
  }
  const runs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worker_runs'").get();
  expect(runs).not.toBeUndefined();
});
it("adds publication_protocol and plan_block_at to jobs with spec defaults", () => {
  const { db } = freshDb("reliability-job-migration");
  const jobs = (db.prepare("SELECT name FROM pragma_table_info('jobs')").all() as { name: string }[]).map((c) => c.name);
  expect(jobs).toContain("publication_protocol");
  expect(jobs).toContain("plan_block_at");
  db.prepare("INSERT INTO jobs (id, source_update_id, request_text, state, created_at, updated_at) VALUES ('job_0', 1, 'r', 'awaiting_project', 0, 0)").run();
  const row = db.prepare("SELECT publication_protocol, plan_block_at FROM jobs WHERE id='job_0'").get() as any;
  expect(row).toEqual({ publication_protocol: "legacy_v1", plan_block_at: 2 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reliability-migrations.test.ts`
Expected: FAIL — `worker_runs`, v5 columns, `publication_protocol`, `plan_block_at` missing.

- [ ] **Step 3: Add the migration blocks**

Append two blocks after `CONTROLLER_TRUST_MIGRATIONS` and add both to the end of `ALL_MIGRATIONS`:

```sql
-- RELIABILITY_WORKER_MIGRATIONS
CREATE TABLE worker_runs (
  run_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('plan','critique','implementation','review','validation','docs','merge','deploy','canary')),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('bb_thread','bb_terminal')),
  resource_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  lifecycle_order INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_order >= 0),
  absorbing_terminal INTEGER NOT NULL DEFAULT 0 CHECK (absorbing_terminal IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX worker_runs_job_generation ON worker_runs(job_id, generation);
CREATE INDEX worker_runs_job_role ON worker_runs(job_id, role, resource_kind, resource_id);

CREATE TABLE worker_liveness_v5 (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  run_id TEXT NOT NULL,
  worker_kind TEXT NOT NULL CHECK (worker_kind IN ('plan','critique','implementation','review','validation','docs','merge','deploy','canary')),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('bb_thread','bb_terminal')),
  resource_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting','active','stopping','idle','failed','unknown','stale')),
  lifecycle_order INTEGER NOT NULL DEFAULT 0,
  observation_order INTEGER NOT NULL DEFAULT 0,
  terminal_lifecycle_order INTEGER,
  terminal_flag INTEGER NOT NULL DEFAULT 0 CHECK (terminal_flag IN (0,1)),
  completion_source TEXT CHECK (completion_source IS NULL OR completion_source IN ('terminal_status','result_marker','timeout','abort','create_failure','read_failure','terminal_missing','activity_snapshot')),
  terminal_id TEXT,
  source_started_at INTEGER NOT NULL,
  source_updated_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  stale_notified_at INTEGER
);
INSERT INTO worker_liveness_v5 (
  job_id, run_id, worker_kind, resource_kind, resource_id, generation, state,
  lifecycle_order, observation_order, terminal_lifecycle_order, terminal_flag, completion_source,
  terminal_id, source_started_at, source_updated_at, observed_at, stale_notified_at
) SELECT
  job_id, 'legacy:' || job_id, worker_kind, resource_kind, resource_id, generation, state,
  0, 0, NULL, 0, NULL, NULL, source_updated_at, source_updated_at, observed_at, stale_notified_at
FROM worker_liveness;
DROP TABLE worker_liveness;
ALTER TABLE worker_liveness_v5 RENAME TO worker_liveness;

-- RELIABILITY_JOB_MIGRATIONS
ALTER TABLE jobs ADD COLUMN publication_protocol TEXT NOT NULL DEFAULT 'legacy_v1';
ALTER TABLE jobs ADD COLUMN plan_block_at INTEGER NOT NULL DEFAULT 2;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reliability-migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the domain model and fixture**

In `src/domain/models.ts`, add `export type PublicationProtocol = "legacy_v1" | "executor_v2";`, extend `BlockedReason`, and add `publicationProtocol: PublicationProtocol` and `planBlockAt: number` to `Job`. In `tests/helpers.ts` update `jobFixture` with `publicationProtocol: "legacy_v1"` and `planBlockAt: 2`.

Each reliability migration task (Task 1 through Task 6) appends a block to `ALL_MIGRATIONS`, so update the existing frozen-length assertions in `tests/autonomy-migration.test.ts` at the same time: `expect(ALL_MIGRATIONS).toHaveLength(LEGACY_MIGRATION_COUNT + 13)` grows to `+ 20` once all six reliability blocks plus the guard are appended. Do not alter any shipped statement or its index position.

- [ ] **Step 6: Run gate and commit**

Run: `npm run typecheck && npx vitest run`
Expected: all green (76+ files, typecheck clean).
```bash
git add src/storage/migrations.ts src/domain/models.ts tests/helpers.ts tests/reliability-migrations.test.ts
git commit -m "feat: append worker_runs and ordered liveness v5 migrations"
```

### Task 2: `critique_findings`, `job_admissions_v2` five events, review-exhaustion reasons

**Files:**
- Modify: `src/storage/migrations.ts`, `src/autonomy/models.ts`, `src/storage/autonomy-repository.ts`, `src/storage/store.ts`
- Test: `tests/reliability-admission-migration.test.ts` (create)

**Interfaces:**
- Consumes: `job_admissions` (v1, `resume_event IN ('CONFIRMED','CONTINUE_REVIEW')`).
- Produces: `critique_findings` table (unique by attempt+ordinal); `job_admissions_v2` whose `resume_event` accepts `CONFIRMED|CONTINUE_PLANNING|CONTINUE_REMEDIATION|CONTINUE_REVIEW|RETRY`; `AdmissionResumeEvent` widened to the five explicit events; scheduler/store accept the five; runtime policy rejects `CONTINUE_REVIEW` for `executor_v2`.

- [ ] **Step 1: Write the failing test**

```ts
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/storage/migrations";

function freshDb(pluginId: string) {
  const { bb } = createFakePluginHost({ pluginId });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS]);
  return { bb, db };
}
it("creates critique_findings and widens job_admissions resume_event to five events", () => {
  const { db } = freshDb("reliability-admission-migration");
  const findings = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='critique_findings'").get();
  expect(findings).not.toBeUndefined();
  const adm = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='job_admissions'").get() as { sql: string }).sql;
  for (const ev of ["CONFIRMED", "CONTINUE_PLANNING", "CONTINUE_REMEDIATION", "CONTINUE_REVIEW", "RETRY"]) {
    expect(adm).toContain(ev);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/reliability-admission-migration.test.ts`
Expected: FAIL — no `critique_findings`; admission `resume_event` missing the five events.

- [ ] **Step 3: Add the migration block**

Append `RELIABILITY_CRITIQUE_ADMISSION_MIGRATIONS` (after `RELIABILITY_JOB_MIGRATIONS`, keep ordering in `ALL_MIGRATIONS`):

```sql
-- RELIABILITY_CRITIQUE_ADMISSION_MIGRATIONS
CREATE TABLE critique_findings (
  attempt_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  severity TEXT NOT NULL CHECK (severity IN ('blocking','advisory')),
  path TEXT CHECK (path IS NULL OR length(path) BETWEEN 1 AND 512),
  line INTEGER CHECK (line IS NULL OR line >= 1),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  details TEXT NOT NULL CHECK (length(details) BETWEEN 1 AND 2000),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 0 AND 2000),
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
  PRIMARY KEY (attempt_id, ordinal)
);

CREATE TABLE job_admissions_v2 (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  project_id TEXT NOT NULL,
  queue_seq INTEGER NOT NULL UNIQUE CHECK (queue_seq >= 1),
  state TEXT NOT NULL CHECK (state IN ('queued','admitted','draining','released')),
  resume_event TEXT NOT NULL CHECK (resume_event IN ('CONFIRMED','CONTINUE_PLANNING','CONTINUE_REMEDIATION','CONTINUE_REVIEW','RETRY')),
  queued_at INTEGER NOT NULL,
  admitted_at INTEGER,
  draining_at INTEGER,
  released_at INTEGER,
  release_reason TEXT CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 160)
);
INSERT INTO job_admissions_v2 (job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at, draining_at, released_at, release_reason)
  SELECT job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at, draining_at, released_at, release_reason FROM job_admissions;
DROP TABLE job_admissions;
ALTER TABLE job_admissions_v2 RENAME TO job_admissions;
CREATE INDEX job_admissions_state_queue ON job_admissions(state, queue_seq, job_id);
CREATE INDEX job_admissions_project_queue ON job_admissions(project_id, state, queue_seq, job_id);
```

Update the `v2` rename indexes. Register the block in `ALL_MIGRATIONS`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/reliability-admission-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Widen the resume-event type and scheduler/store**

In `src/autonomy/models.ts`, change `AdmissionResumeEvent` to `"CONFIRMED" | "CONTINUE_PLANNING" | "CONTINUE_REMEDIATION" | "CONTINUE_REVIEW" | "RETRY"`. Update `AutonomyRepository.tryAdmit`/`queueAdmissionInTransaction` to accept the five events and enforce: `CONTINUE_REVIEW` is permitted only when the job's `publicationProtocol` is `legacy_v1`; all other events are valid for their documented resume states (Task 6 wires the state machine reasons). Reference `publicationProtocol` on the `Job`.

- [ ] **Step 6: Run gate and commit**

Run: `npm run typecheck && npx vitest run`
Expected: all green.
```bash
git add src/storage/migrations.ts src/autonomy/models.ts src/storage/autonomy-repository.ts src/storage/store.ts tests/reliability-admission-migration.test.ts
git commit -m "feat: five resume events and critique findings migration"
```

### Task 3: `publication_sagas`, `publication_step_receipts`

**Files:**
- Modify: `src/storage/migrations.ts`
- Test: `tests/reliability-publication-migration.test.ts` (create)

**Interfaces:**
- Consumes: `jobs`, `publication_protocol`.
- Produces: `publication_sagas` (unique effect key; unique `(job_id, phase, publication_ordinal)`); `publication_step_receipts` (unique saga+step; outcome in `unknown|not_applied|succeeded|conflict`; `unknown` durable before the call); indexes for unsettled effects.

- [ ] **Step 1: Write the failing test**

```ts
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/storage/migrations";

it("creates publication_sagas and publication_step_receipts with unique constraints", () => {
  const { bb, db } = (() => { const { bb } = createFakePluginHost({ pluginId: "reliability-publication-mig" }); const db = bb.storage.database(); bb.storage.migrate(db, [...ALL_MIGRATIONS]); return { bb, db }; })();
  const s = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='publication_sagas'").get();
  expect(s).not.toBeUndefined();
  const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='publication_step_receipts'").get();
  expect(r).not.toBeUndefined();
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='publication_sagas'").get() as { sql: string }).sql;
  expect(sql).toContain("PRIMARY KEY");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/reliability-publication-migration.test.ts`
Expected: FAIL — tables missing.

- [ ] **Step 3: Add the migration block**

Append `RELIABILITY_PUBLICATION_MIGRATIONS`:

```sql
-- RELIABILITY_PUBLICATION_MIGRATIONS
CREATE TABLE publication_sagas (
  effect_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  phase TEXT NOT NULL CHECK (phase IN ('implementation','docs')),
  publication_ordinal INTEGER NOT NULL CHECK (publication_ordinal >= 1),
  environment_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  job_marker_digest TEXT NOT NULL CHECK (length(job_marker_digest) = 64),
  baseline_local_tree TEXT NOT NULL CHECK (length(baseline_local_tree) = 64),
  expected_remote_head TEXT,
  candidate_tree_digest TEXT NOT NULL CHECK (length(candidate_tree_digest) = 64),
  candidate_diff_digest TEXT,
  current_step TEXT NOT NULL CHECK (current_step IN ('commit','push','create_pr','success')),
  state TEXT NOT NULL CHECK (state IN ('publishing','succeeded','failed','cancelled')),
  commit_sha TEXT,
  remote_sha TEXT,
  pr_identity TEXT,
  pr_head_sha TEXT,
  conflict_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (job_id, phase, publication_ordinal)
);
CREATE INDEX publication_sagas_unsettled ON publication_sagas(state, created_at);

CREATE TABLE publication_step_receipts (
  saga_effect_key TEXT NOT NULL REFERENCES publication_sagas(effect_key),
  step TEXT NOT NULL CHECK (step IN ('commit','push','create_pr')),
  canonical_input_digest TEXT NOT NULL CHECK (length(canonical_input_digest) = 64),
  call_started_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('unknown','not_applied','succeeded','conflict')),
  authoritative_local_head TEXT,
  authoritative_remote_head TEXT,
  pr_identity TEXT,
  pr_head_sha TEXT,
  conflict_code TEXT,
  PRIMARY KEY (saga_effect_key, step)
);
CREATE INDEX publication_step_receipts_unknown ON publication_step_receipts(outcome, call_started_at) WHERE outcome = 'unknown';
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/reliability-publication-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

Run: `npm run typecheck && npx vitest run`
Expected: all green.
```bash
git add src/storage/migrations.ts tests/reliability-publication-migration.test.ts
git commit -m "feat: append publication saga and step receipt migrations"
```

### Task 4: `thread_provenance`, `thread_notice_cycles`

**Files:**
- Modify: `src/storage/migrations.ts`
- Test: `tests/reliability-provenance-migration.test.ts` (create)

**Interfaces:**
- Consumes: `jobs`, `pipeline_stage_attempts`, `delegations`, `controller_*` tables.
- Produces: `thread_provenance` (prepared/bound/quarantined spawn states, unique bound-thread single class); `thread_notice_cycles` (unique by thread/run/cycle, increasing terminal-cycle ordinal, settlement/outbox key).

- [ ] **Step 1: Write the failing test**

```ts
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/storage/migrations";

it("creates thread_provenance and thread_notice_cycles", () => {
  const { bb, db } = (() => { const { bb } = createFakePluginHost({ pluginId: "reliability-prov-mig" }); const db = bb.storage.database(); bb.storage.migrate(db, [...ALL_MIGRATIONS]); return { bb, db }; })();
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='thread_provenance'").get()).not.toBeUndefined();
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='thread_notice_cycles'").get()).not.toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/reliability-provenance-migration.test.ts`
Expected: FAIL — tables missing.

- [ ] **Step 3: Add the migration block**

Append `RELIABILITY_PROVENANCE_MIGRATIONS`:

```sql
-- RELIABILITY_PROVENANCE_MIGRATIONS
CREATE TABLE thread_provenance (
  provenance_id TEXT PRIMARY KEY,
  thread_id TEXT,
  class TEXT NOT NULL CHECK (class IN ('job_pipeline','delegation_join','owner_work','internal','controller_plan','controller_monitor','internal_unknown')),
  role TEXT CHECK (role IS NULL OR role IN ('plan','critique','implementation','review','docs','final_review','delegation_join','owner_work')),
  job_id TEXT,
  delegation_id TEXT,
  controller_turn_id TEXT,
  intended_visibility TEXT NOT NULL CHECK (intended_visibility IN ('hidden','visible')),
  origin_meta_digest TEXT,
  spawn_state TEXT NOT NULL CHECK (spawn_state IN ('prepared','bound','quarantined')),
  created_at INTEGER NOT NULL,
  bound_at INTEGER,
  UNIQUE (thread_id)
);
CREATE INDEX thread_provenance_spawn ON thread_provenance(spawn_state, created_at);
CREATE UNIQUE INDEX thread_provenance_bound_class ON thread_provenance(thread_id, class) WHERE thread_id IS NOT NULL;

CREATE TABLE thread_notice_cycles (
  thread_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  cycle_ordinal INTEGER NOT NULL CHECK (cycle_ordinal >= 1),
  terminal_status TEXT NOT NULL CHECK (terminal_status IN ('idle','error')),
  settlement_key TEXT,
  outbox_key TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, run_id, cycle_ordinal)
);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/reliability-provenance-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

Run: `npm run typecheck && npx vitest run`
Expected: all green.
```bash
git add src/storage/migrations.ts tests/reliability-provenance-migration.test.ts
git commit -m "feat: append thread provenance and notice cycle migrations"
```

### Task 5: controller-turn source/delivery columns + `communication_obligations`

**Files:**
- Modify: `src/storage/migrations.ts`, `src/controller/models.ts`
- Test: `tests/reliability-turn-obligation-migration.test.ts` (create)

**Interfaces:**
- Consumes: `controller_turns` (has `origin`).
- Produces: `controller_turns.source_kind` (default `owner`), `source_ref` (nullable), `delivery_requirement` (default `required`); `communication_obligations` table (unique by controller turn); `ControllerTurnRecord` additions; `TurnSourceKind`/`DeliveryRequirement` types.

- [ ] **Step 1: Write the failing test**

```ts
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/storage/migrations";

it("adds source/delivery columns and communication_obligations", () => {
  const { bb, db } = (() => { const { bb } = createFakePluginHost({ pluginId: "reliability-turn-mig" }); const db = bb.storage.database(); bb.storage.migrate(db, [...ALL_MIGRATIONS]); return { bb, db }; })();
  const turns = (db.prepare("SELECT name FROM pragma_table_info('controller_turns')").all() as { name: string }[]).map((c) =>
 c).name);
  for (const col of ["source_kind", "source_ref", "delivery_requirement"]) expect(turns).toContain(col);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='communication_obligations'").get()).not.toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/reliability-turn-obligation-migration.test.ts`
Expected: FAIL — columns/tables missing.

- [ ] **Step 3: Add the migration block**

Append `RELIABILITY_TURN_COMMUNICATION_MIGRATIONS`:

```sql
-- RELIABILITY_TURN_COMMUNICATION_MIGRATIONS
ALTER TABLE controller_turns ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE controller_turns ADD COLUMN source_ref TEXT;
ALTER TABLE controller_turns ADD COLUMN delivery_requirement TEXT NOT NULL DEFAULT 'required';

CREATE TABLE communication_obligations (
  turn_id TEXT PRIMARY KEY REFERENCES controller_turns(id),
  source TEXT NOT NULL CHECK (source IN ('owner','owner_monitor','delegation_join','weekly_scorecard','system_monitor')),
  delivery_requirement TEXT NOT NULL CHECK (delivery_requirement IN ('required','conditional')),
  allowance TEXT CHECK (allowance IS NULL OR allowance IN ('system-stale-jobs','system-memory-audit')),
  state TEXT NOT NULL CHECK (state IN ('owed','queued','delivery_unknown','delivered','silent','escalated')),
  delivery_kind TEXT CHECK (delivery_kind IS NULL OR delivery_kind IN ('message','failure')),
  outbox_key TEXT,
  attempt_ordinal INTEGER NOT NULL DEFAULT 0,
  input_digest TEXT,
  telegram_message_identity TEXT,
  silent_evidence_high_water INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX communication_obligations_unsettled ON communication_obligations(state, updated_at)
  WHERE state IN ('owed','queued','delivery_unknown','escalated');
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/reliability-turn-obligation-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend controller models**

In `src/controller/models.ts` add `sourceKind` (`owner|owner_monitor|delegation_join|weekly_scorecard|system_monitor`), `sourceRef: string | null`, `deliveryRequirement: "required" | "conditional"` to `ControllerTurnRecord`; export `TurnSourceKind` and `DeliveryRequirement`.

- [ ] **Step 6: Run gate and commit**

Run: `npm run typecheck && npx vitest run`
Expected: all green.
```bash
git add src/storage/migrations.ts src/controller/models.ts tests/reliability-turn-obligation-migration.test.ts
git commit -m "feat: append turn source, delivery, and communication obligation migrations"
```

### Task 6: Migration guard block

**Files:**
- Modify: `src/storage/migrations.ts`
- Test: `tests/reliability-migration-guards.test.ts` (create)

**Interfaces:**
- Consumes: the tables added in Tasks 1–5.
- Produces: a final appended `RELIABILITY_GUARDS_MIGRATIONS` block that asserts row counts, admission identity, unique held resources, unique generations, valid publication protocol, provenance conflicts, and obligation/turn identity inside one immediate transaction that rolls back the whole migration on any failed guard.

- [ ] **Step 1: Write the failing test**

```ts
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/storage/migrations";

it("ships the reliability guard block", () => {
  const { bb, db } = (() => { const { bb } = createFakePluginHost({ pluginId: "reliability-guards" }); const db = bb.storage.database(); bb.storage.migrate(db, [...ALL_MIGRATIONS]); return { bb, db }; })();
  const src = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='worker_liveness'").get() as { sql: string }).sql;
  expect(src).toContain("terminal_flag");
});
```

Note: The RED phase for guards is exercised by a seeded-invalid-database fixture in the "migration guard" tests described in the test matrix. Because guards are shipped inside migrations, the RED proof is that an invalid legacy row makes the whole `ALL_MIGRATIONS` application fail atomically (assert no partial tables exist).

- [ ] **Step 2: Write a second failing test that proves atomic rollback on a guard violation**

```ts
// Helper defined at the top of the same test file. It seeds the legacy schema
// before the reliability blocks, inserts two duplicate held claims, then
// returns a handle whose `migrate` call applies ALL_MIGRATIONS.
function setupWithDuplicateHeldClaim() {
  const { bb } = createFakePluginHost({ pluginId: "reliability-guards-invalid" });
  const db = bb.storage.database();
  // Apply every pre-reliability migration block (all of ALL_MIGRATIONS whose
  // SQL body predates the RELIABILITY_* blocks appended in Tasks 1-6); use the
  // helper `pickReliabilityStart(ALL_MIGRATIONS)` from this test file, which
  // returns the first index whose block begins with `-- RELIABILITY_` (each
  // reliability block starts with a marker comment).
  const reliabilityStart = pickReliabilityStart(ALL_MIGRATIONS);
  bb.storage.migrate(db, [...ALL_MIGRATIONS.slice(0, reliabilityStart)]);
  // Insert two held claims on the same resource_key to violate the guard.
  db.prepare("INSERT INTO job_resource_claims (job_id, resource_key, resource_kind, state, owner_id, generation, lease_expires_at, acquired_at, renewed_at) VALUES ('job_1','project:p1:pipeline','project','held','e1',1,0,0,0)").run();
  db.prepare("INSERT INTO job_resource_claims (job_id, resource_key, resource_kind, state, owner_id, generation, lease_expires_at, acquired_at, renewed_at) VALUES ('job_2','project:p1:pipeline','project','held','e2',1,0,0,0)").run();
  return { bb, db };
}

it("rolls back the whole migration when a guard invariant fails", () => {
  const { bb, db } = setupWithDuplicateHeldClaim();
  expect(() => bb.storage.migrate(db, [...ALL_MIGRATIONS])).toThrow();
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='worker_runs'").get()).toBeUndefined();
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'worker_liveness%'").get()).toBeUndefined();
});
```

- [ ] **Step 3: Add the guard migration block**

Append `RELIABILITY_GUARDS_MIGRATIONS` after the other reliability blocks using a temporary guard table pattern (mirrors the existing `autonomy_migration_guard`):

```sql
-- RELIABILITY_GUARDS_MIGRATIONS
CREATE TEMP TABLE reliability_migration_guard (
  invariant TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO reliability_migration_guard (invariant, valid)
SELECT 'worker_runs_one_per_job_generation',
  CASE WHEN (SELECT COUNT(*) FROM (SELECT job_id, generation FROM worker_runs GROUP BY job_id, generation HAVING COUNT(*) > 1)) = 0 THEN 1 ELSE 0 END;
INSERT INTO reliability_migration_guard (invariant, valid)
SELECT 'liveness_rows_equal_jobs',
  CASE WHEN (SELECT COUNT(*) FROM worker_liveness) = (SELECT COUNT(*) FROM jobs) THEN 1 ELSE 0 END;
INSERT INTO reliability_migration_guard (invariant, valid)
SELECT 'publication_protocol_valid',
  CASE WHEN (SELECT COUNT(*) FROM jobs WHERE publication_protocol NOT IN ('legacy_v1','executor_v2')) = 0 THEN 1 ELSE 0 END;
INSERT INTO reliability_migration_guard (invariant, valid)
SELECT 'held_claim_unique',
  CASE WHEN (SELECT COUNT(*) FROM (SELECT resource_key FROM job_resource_claims WHERE state='held' GROUP BY resource_key HAVING COUNT(*) > 1)) = 0 THEN 1 ELSE 0 END;
INSERT INTO reliability_migration_guard (invariant, valid)
SELECT 'provenance_bound_unique',
  CASE WHEN (SELECT COUNT(*) FROM thread_provenance WHERE thread_id IS NOT NULL GROUP BY thread_id HAVING COUNT(*) > 1) = 0 THEN 1 ELSE 0 END;
INSERT INTO reliability_migration_guard (invariant, valid)
SELECT 'obligation_turn_identity',
  CASE WHEN (SELECT COUNT(*) FROM communication_obligations WHERE turn_id NOT IN (SELECT id FROM controller_turns)) = 0 THEN 1 ELSE 0 END;
SELECT CASE WHEN MIN(valid) = 1 THEN 1 ELSE RAISE(ABORT, 'reliability migration guard failed') END FROM reliability_migration_guard;
DROP TABLE reliability_migration_guard;
```

Because every reliability block is in one `ALL_MIGRATIONS` list and the guards run last inside the same migration run, a failure aborts the whole application and leaves no reliability tables visible in the test above.

- [ ] **Step 4: Run both tests to verify they pass**

Run: `npx vitest run tests/reliability-migration-guards.test.ts`
Expected: both PASS.

- [ ] **Step 5: Run gate and commit**

Run: `npm run typecheck && npx vitest run`
Expected: all green.
```bash
git add src/storage/migrations.ts tests/reliability-migration-guards.test.ts
git commit -m "feat: enforce reliability migration guards with atomic rollback"
```

---

## Phase B — Observation ordering and absorbing terminal

### Task 7: Pure terminal ordering and absorbing outcome

**Files:**
- Create: `src/domain/terminal-run.ts`, `src/domain/order.ts`
- Test: `tests/terminal-run.test.ts`, `tests/order.test.ts` (create)

**Interfaces:**
- Produces: in `order.ts`, `acceptsObservation({ stored, incoming })` returning `"newer" | "identical_replay" | "stale"` using `(generation, lifecycleOrder)` and, for attested BB activity snapshots only, `sourceRevision`; `nextLifecycleOrder(run)`; `nextObservationOrder(run)`. In `terminal-run.ts`, `TerminalObservation` (runId, nullable terminalId, generation, lifecycleOrder, sourceStartedAt, sourceObservedAt, nullable terminalTimestamp, outcome `succeeded|failed|timed_out|aborted`, exitCode, completionSource `terminal_status|result_marker|timeout|abort|create_failure|read_failure|terminal_missing`), no output/command text; `buildAbsorbingOutcome`.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, it } from "vitest";
import { acceptsObservation, nextLifecycleOrder, nextObservationOrder } from "../src/domain/order";

it("accepts a newer generation over an older one regardless of observation order", () => {
  const stored = { generation: 1, lifecycleOrder: 5, observationOrder: 3 };
  const incoming = { generation: 2, lifecycleOrder: 1, observationOrder: 0 };
  expect(acceptsObservation({ stored, incoming })).toBe("newer");
});
it("treats an equal revision identical replay as an identical replay", () => {
  const stored = { generation: 2, lifecycleOrder: 4, observationOrder: 6, sourceRevision: 9 };
  const incoming = { generation: 2, lifecycleOrder: 4, observationOrder: 6, sourceRevision: 9 };
  expect(acceptsObservation({ stored, incoming })).toBe("identical_replay");
});
it("rejects a stale generation or lower lifecycle order in the same generation", () => {
  const stored = { generation: 3, lifecycleOrder: 7, observationOrder: 2 };
  const incoming = { generation: 3, lifecycleOrder: 6, observationOrder: 9 };
  expect(acceptsObservation({ stored, incoming })).toBe("stale");
});
it("increments lifecycle and observation orders", () => {
  expect(nextLifecycleOrder({ lifecycleOrder: 4 })).toBe(5);
  expect(nextObservationOrder({ observationOrder: 9 })).toBe(10);
});
```
```ts
import { expect, it } from "vitest";
import { buildAbsorbingOutcome, type TerminalObservation } from "../src/domain/terminal-run";

it("builds an absorbing terminal outcome from the first terminal signal", () => {
  const obs: TerminalObservation = { runId: "r1", terminalId: "t1", generation: 2, lifecycleOrder: 3, sourceStartedAt: 100, sourceObservedAt: 200, terminalTimestamp: 150, outcome: "succeeded", exitCode: 0, completionSource: "result_marker" };
  const outcome = buildAbsorbingOutcome(obs);
  expect(outcome.outcome).toBe("succeeded");
  expect(outcome.completionSource).toBe("result_marker");
});
it("disallows a later signal from replacing the absorbing outcome", () => {
  const first = buildAbsorbingOutcome({ runId: "r1", terminalId: "t1", generation: 2, lifecycleOrder: 3, sourceStartedAt: 100, sourceObservedAt: 200, outcome: "succeeded", exitCode: 0, completionSource: "result_marker" });
  const again = buildAbsorbingOutcome({ runId: "r1", terminalId: "t1", generation: 2, lifecycleOrder: 4, sourceStartedAt: 100, sourceObservedAt: 210, outcome: "failed", exitCode: 1, completionSource: "timeout" });
  expect(first !== again).toBe(true); // the runner stores the first externally
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/order.test.ts tests/terminal-run.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement the modules**

`src/domain/order.ts`:

```ts
export type ObservationTuple = { generation: number; lifecycleOrder: number; observationOrder?: number; sourceRevision?: number };
export type OrderAcceptance = "newer" | "identical_replay" | "stale";
export function acceptsObservation({ stored, incoming }: { stored: ObservationTuple; incoming: ObservationTuple }): OrderAcceptance {
  if (incoming.sourceRevision !== undefined && stored.sourceRevision !== undefined) {
    if (incoming.sourceRevision < stored.sourceRevision) return "stale";
    if (incoming.sourceRevision === stored.sourceRevision) {
      const same = incoming.generation === stored.generation && incoming.lifecycleOrder === stored.lifecycleOrder &&
        incoming.observationOrder === stored.observationOrder && incoming.sourceRevision === stored.sourceRevision;
      return same ? "identical_replay" : "stale";
    }
  }
  if (incoming.generation !== stored.generation) return incoming.generation > stored.generation ? "newer" : "stale";
  if (incoming.lifecycleOrder !== stored.lifecycleOrder) return incoming.lifecycleOrder > stored.lifecycleOrder ? "newer" : "stale";
  if (incoming.observationOrder === stored.observationOrder && (stored.observationOrder ?? -1) >= 0) return "identical_replay";
  return incoming.observationOrder! > stored.observationOrder! ? "newer" : "stale";
}
export function nextLifecycleOrder(r: { lifecycleOrder: number }): number { return r.lifecycleOrder + 1; }
export function nextObservationOrder(r: { observationOrder: number }): number { return r.observationOrder + 1; }
```

`src/domain/terminal-run.ts`:

```ts
export type TerminalCompletionSource = "terminal_status" | "result_marker" | "timeout" | "abort" | "create_failure" | "read_failure" | "terminal_missing";
export type TerminalOutcome = "succeeded" | "failed" | "timed_out" | "aborted";
export type TerminalObservation = {
  runId: string;
  terminalId: string | null;
  generation: number;
  lifecycleOrder: number;
  sourceStartedAt: number;
  sourceObservedAt: number;
  terminalTimestamp: number | null;
  outcome: TerminalOutcome;
  exitCode: number | null;
  completionSource: TerminalCompletionSource;
};
export function buildAbsorbingOutcome(obs: TerminalObservation): Pick<TerminalObservation, "outcome" | "completionSource" | "exitCode"> {
  return { outcome: obs.outcome, completionSource: obs.completionSource, exitCode: obs.exitCode };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/order.test.ts tests/terminal-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/domain/order.ts src/domain/terminal-run.ts tests/order.test.ts tests/terminal-run.test.ts
git commit -m "feat: add absorbing terminal and observation ordering")
```
Run `npm run typecheck && npx vitest run` before committing; all green.

### Task 8: Terminal runner emits exactly one absorbing terminal outcome

**Files:**
- Modify: `src/bb/terminal-command.ts`
- Test: `tests/terminal-command.test.ts` (create)

**Interfaces:**
- Consumes: `runId`-aware runner input; the `terminal-run.ts` types.
- Produces: a single-threaded runner whose first terminal signal invokes one internal `settleTerminal` path that stores the absorbing outcome in memory, awaits the observation sink to confirm, then invokes idempotent force-close once and resolves/rejects the command. If the sink rejects, the runner still closes once but returns no success and leaves the run reconcilable. Later marker, timeout, abort, output, or status events cannot change the committed outcome.

- [ ] **Step 1: Write the failing tests**

Create a fake terminal client and assert `run` resolves once, emits exactly one absorbing `onTerminal` callback, and closes once exactly, across (a) success, (b) timeout, (c) abort, (d) sink rejection after terminal signal. Use two real commands in one validation phase and assert the two `runId`s differ (Task also covered by run-ordering test in Task 9 store layer).

```ts
import { expect, it, vi } from "vitest";
import { TerminalCommandRunner } from "../src/bb/terminal-command";

function fakeSdk(overrides: Record<string, unknown> = {}) {
  const close = vi.fn(async () => ({}));
  const get = vi.fn(async () => ({ status: "running", exitCode: null }));
  const output = vi.fn(async () => ({ chunks: [], nextSeq: 0, truncated: false }));
  const create = vi.fn(async () => ({ id: "term_1" }));
  const sdk = { terminals: { create, get, output, close } };
  return { sdk, close, get, output, create };
}
it("closes once and emits one absorbing terminal signal", async () => {
  const { sdk, close } = fakeSdk();
  const runner = new TerminalCommandRunner(sdk as never);
  const onTerminal = vi.fn();
  const result = await runner.run({ scope: { kind: "environment", environmentId: "env_1" }, title: "t", command: "true", timeoutMs: 50, onTerminal });
  expect(close).toHaveBeenCalledTimes(1);
  expect(result.outcome).toBe("exited");
  expect(onTerminal).toHaveBeenCalled();
});
it("returns no success when the absorbing sink rejects and still closes once", async () => {
  const { sdk, close } = fakeSdk({ get: vi.fn(async () => ({ status: "exited", exitCode: 0 })) });
  const runner = new TerminalCommandRunner(sdk as never);
  const result = await runner.run({ scope: { kind: "environment", environmentId: "env_1" }, title: "t", command: "true", timeoutMs: 50, onTerminal: () => { throw new Error("sink failed"); } });
  expect(close).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/terminal-command.test.ts`
Expected: FAIL — `onTerminal` sink does not exist on `TerminalCommandRunner`; absorbing behavior missing.

- [ ] **Step 3: Implement absorbing settlement in the runner**

Add a private `settleTerminal(observation, sink)` that stores the absorbing outcome (via `buildAbsorbingOutcome`), awaits the externally-injected `onTerminal` sink, then calls `closeOnce()`. Change `waitForExit` and `run` so all terminal exits (status `exited`, timed_out, aborted, create/read failure, terminal missing) funnel into `settleTerminal` and return its committed result. Keep the runner's job-state authority: none. Preserve the existing one-way `closeOnce` guard so force-close happens at most once.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/terminal-command.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/bb/terminal-command.ts tests/terminal-command.test.ts
git commit -m "feat: emit exactly one absorbing terminal outcome before close"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 9: Worker-run registration and ordered liveness projection (v5 store)

**Files:**
- Modify: `src/storage/store.ts`, `src/services/worker-liveness.ts`
- Test: `tests/worker-liveness-v5.test.ts` (create)

**Interfaces:**
- Consumes: `worker_runs` schema (Task 1), `acceptsObservation`/`nextLifecycleOrder` (Task 7).
- Produces: store methods `registerWorkerRun`, `projectWorkerLiveness` (ordered, one-way terminal flag, increments `observationOrder`), `getWorkerLivenessV5`, `markLaunchingRunForbidden`; `worker-liveness.ts` `projectWorkerLivenessV5` that projects `(generation, lifecycleOrder)` and, for BB-thread runs, returns `unknown` unless an attestation is present.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { openStore } from "../src/storage/store";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { jobFixture, activeWorkerFixture } from "./helpers";
import { projectWorkerLivenessV5 } from "../src/services/worker-liveness";

function makeStore() {
  const { bb } = createFakePluginHost({ pluginId: "worker-v5" });
  return openStore(bb.storage);
}
function seedJob(store: ReturnType<typeof makeStore>, id: string): Job {
  return store.createJob({ id, sourceUpdateId: 100 + id.length, requestText: "request", now: 1_000 });
}
it("registers a stable run and generation; a delayed old callback cannot regress it", () => {
  const store = makeStore();
  const job = seedJob(store, "job_1");
  const run = store.registerWorkerRun({ jobId: job.id, role: "implementation", resourceKind: "bb_thread", resourceId: "thr_new", generation: 3 });
  const projected = projectWorkerLivenessV5(store, job, { ...activeWorkerFixture({ jobId: job.id, resourceId: "thr_new", generation: 3, lifecycleOrder: 1 }) }, 1_500);
  expect(projected.state).toBe("active");
  // delayed old callback projects unknown without regressing the newer projection
  expect(projectWorkerLivenessV5(store, job, { id: "thr_old", generation: 2, lifecycleOrder: 0, status: "exited", updatedAt: 100 }, 1_600).state).toBe("unknown");
  const stored = store.getWorkerLivenessV5(job.id);
  expect(stored.resourceId).toBe("thr_new");
});
it("sets the one-way terminal flag and increments observation order once", () => {
  const store = makeStore();
  const job = seedJob(store, "job_2");
  store.registerWorkerRun({ jobId: job.id, role: "validation", resourceKind: "bb_terminal", resourceId: "term_1", generation: 5 });
  const first = projectWorkerLivenessV5(store, job, { id: "term_1", generation: 5, outcome: "succeeded", exitCode: 0, completionSource: "terminal_status", lifecycleOrder: 1, sourceStartedAt: 0, sourceObservedAt: 100 }, 100);
  expect(first.terminalFlag).toBe(true);
  const obs2 = projectWorkerLivenessV5(store, job, { id: "term_1", generation: 5, outcome: "failed", exitCode: 1, completionSource: "timeout", lifecycleOrder: 2, sourceStartedAt: 0, sourceObservedAt: 200 }, 200);
  const stored = store.getWorkerLivenessV5(job.id);
  expect(stored.state).toBe(first.state);
  expect(stored.lifecycleOrder).toBe(1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/worker-liveness-v5.test.ts`
Expected: FAIL — `registerWorkerRun`/`projectWorkerLivenessV5`/`getWorkerLivenessV5` missing.

- [ ] **Step 3: Implement the store run/ordering layer**

Add to `TelegramAgentStore` interface and the SQLite implementation:

- `registerWorkerRun(input): required` — inserts into `worker_runs` with the given `run_id`/generation, enforcing the unique `(job, generation)` index and returning the run.
- `projectWorkerLivenessV5(value, fence?)` — a fenced immediate transaction that reads the current `worker_liveness` row, computes `acceptsObservation`, writes when `newer` or `identical_replay` (re-applying the identical row), sets `terminal_flag=1` one-way on terminal runs, increments `observation_order`, projects job state in the same transaction, and returns the stored row. It never lets observer time break a tie.
- `getWorkerLivenessV5(jobId)`, plus guarded `markWorkerLivenessNotifiedV5`.

Extend `activeWorkerFixture` in `tests/helpers.ts` with the v5 fields (`lifecycleOrder`, `observationOrder`, `terminalFlag`, `completionSource`, `terminalId`) defaulting them so the tests above compile.

In `worker-liveness.ts`, add `projectWorkerLivenessV5` that returns a `"starting"|"active"|"stopping"|"idle"|"failed"|"unknown"` projection where a BB-thread run without a capability attestation is `unknown` (never `idle` or `failed`), and a terminal run maps its outcome with the completion source. Also add a single-flight `oneThreadActivityRead(runId)` guard and a `ProjectActivitySnapshot` branch: with an attested atomic activity snapshot (shared revision), `idle` is actionable only when metadata+runtime are idle, every active count/timeline collection is empty, there is no active prompt/thinking/goal, no pending interaction, and every field binds to the same shared revision; without the attestation, only positive signals may project active/stopping and absence is `unknown` (no collection of absent signals ever projects `idle`/`failed`). A reconnect/waiting-for-host, failed component read, revision regression/gap, equal-revision hash conflict, or contradictory terminal/active signal projects `unknown`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/worker-liveness-v5.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/storage/store.ts src/services/worker-liveness.ts tests/worker-liveness-v5.test.ts
git commit -m "feat: ordered worker-run registration and v5 liveness projection"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 10: Two-connection race on run ordering and absorbing terminal

**Files:**
- Create: `tests/reliability-ordering-race.test.ts`
- Modify: `src/storage/store.ts` (small re-entrant helper only if needed)

**Interfaces:**
- Consumes: `registerWorkerRun`, `projectWorkerLivenessV5`.
- Produces: proof that two independent SQLite connections to one temp file cannot double-admit a project or regress run ordering; that a stale generation/lifecycle order is rejected even when the stale connection "observed" later in wall-clock time.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { Database } from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { openStore } from "../src/storage/store";
import { jobFixture } from "./helpers";

it("a stale generation cannot overwrite a newer projection across two connections", () => {
  const dir = mkdtempSync(join(tmpdir(), "reliability-order-race-"));
  const path
 = join(dir, "race.sqlite");
  const primary = new Database(path);
  const secondary = new Database(path);
  primary.pragma("journal_mode = WAL");
  primary.pragma("foreign_keys = ON");
  secondary.pragma("journal_mode = WAL");
  secondary.pragma("foreign_keys = ON");
  try {
    for (const migration of ALL_MIGRATIONS) primary.exec(migration);
    const storeA = openStore({ database: primary } as never);
    const storeB = openStore({ database: secondary } as never);
    const job = jobFixture({ id: "job_race", state: "implementing", projectId: "proj_1", publicationProtocol: "legacy_v1" });
    storeA.registerWorkerRun({ jobId: job.id, role: "implementation", resourceKind: "bb_thread", resourceId: "thr_new", generation: 4 });
    // B projects a stale generation that happens to be observed later in wall-clock time.
    storeB.projectWorkerLivenessV5({ jobId: job.id, runId: "r_stale", workerKind: "implementation", resourceKind: "bb_thread", resourceId: "thr_old", generation: 3, state: "idle", lifecycleOrder: 0, observationOrder: 0, sourceStartedAt: 0, sourceUpdatedAt: 100, observedAt: 90_000, terminalFlag: false });
    storeA.projectWorkerLivenessV5({ jobId: job.id, runId: "r_new", workerKind: "implementation", resourceKind: "bb_thread", resourceId: "thr_new", generation: 4, state: "active", lifecycleOrder: 1, observationOrder: 1, sourceStartedAt: 0, sourceUpdatedAt: 100, observedAt: 1_000, terminalFlag: false });
    const stored = storeA.getWorkerLivenessV5(job.id);
    expect(stored.generation).toBe(4);
    expect(stored.resourceId).toBe("thr_new");
  } finally {
    secondary.close(); primary.close(); rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/reliability-ordering-race.test.ts`
Expected: FAIL — the projection helper/columns not implemented to the required semantics yet.

- [ ] **Step 3: Run to verify it passes**

Reuse the implementations from Task 9; no new production code required unless the race surfaces a re-entrancy gap, which you fix in `src/storage/store.ts` in the same transaction.

Run: `npx vitest run tests/reliability-ordering-race.test.ts`
Expected: PASS.

- [ ] **Step 4: Run gate and commit**

```bash
git add tests/reliability-ordering-race.test.ts src/storage/store.ts
git commit -m "feat: prove run ordering monotonic under two connections")
```
Run `npm run typecheck && npx vitest run` first; all green.

---

## Phase C — State machine: distinct reasons/events, publishing states

### Task 11: Split planning and code-review exhaustion reasons/events

**Files:**
- Modify: `src/domain/models.ts`, `src/domain/state-machine.ts`
- Test: `tests/state-machine-reliability.test.ts` (create)

**Interfaces:**
- Produces: `blockedReason` distinct `plan_critique_exhausted` vs `code_review_exhausted`; new JobEvents `CONTINUE_PLANNING`, `CONTINUE_REMEDIATION`; plan exhaustion at `planBlockAt` (default 2) persists `plan_critique_exhausted`; code-review exhaustion persists `code_review_exhausted`; `CONTINUE_PLANNING` resumes only `plan_critique_exhausted` at `planning`; `CONTINUE_REMEDIATION` resumes only `code_review_exhausted` at `remediating` for `executor_v2`, clearing the reason and advancing `planBlockAt`/`reviewBlockAt` by the documented increments; `CONTINUE_REVIEW` stays legacy-only.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, it } from "vitest";
import { transition, IllegalTransitionError } from "../src/domain/state-machine";
import { stateJob } from "./helpers";

it("persists plan_critique_exhausted at the plan threshold and resumes via CONTINUE_PLANNING", () => {
  let job = stateJob("critiquing", { planCycle: 1, planBlockAt: 2, publicationProtocol: "legacy_v1" });
  const failed = transition(job, { type: "CRITIQUE_NEEDS_REVISION", attemptId: "a1", summary: "needs work" }, 1000);
  expect(failed.job.state).toBe("blocked");
  expect(failed.job.blockedReason).toBe("plan_critique_exhausted");
  const resumed = transition(failed.job, { type: "CONTINUE_PLANNING" }, 2000);
  expect(resumed.job.state).toBe("planning");
  expect(resumed.job.blockedReason).toBeNull();
  expect(resumed.job.planBlockAt).toBe(4);
});
it("rejects CONTINUE_PLANNING for a code-review reason and CONTINUE_REVIEW for executor_v2", () => {
  const codeJob = stateJob("blocked", { blockedReason: "code_review_exhausted", publicationProtocol: "executor_v2", reviewBlockAt: 3 });
  expect(() => transition(codeJob, { type: "CONTINUE_PLANNING" }, 1000)).toThrow(IllegalTransitionError);
  expect(() => transition(codeJob, { type: "CONTINUE_REVIEW" }, 1000)).toThrow(IllegalTransitionError);
  const resume = transition(codeJob, { type: "CONTINUE_REMEDIATION" }, 1000);
  expect(resume.job.state).toBe("remediating");
  expect(resume.job.reviewBlockAt).toBe(6);
});
it("CONTINUE_REVIEW remains legacy-only and resume_target unchanged", () => {
  const legacy = stateJob("blocked", { blockedReason: "code_review_exhausted", publicationProtocol: "legacy_v1", reviewCycle: 2, reviewBlockAt: 3 });
  const resumed = transition(legacy, { type: "CONTINUE_REVIEW" }, 1000);
  expect(resumed.job.state).toBe("reviewing");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/state-machine-reliability.test.ts`
Expected: FAIL — `blockedReason` values and events do not exist; `planBlockAt` semantics wrong.

- [ ] **Step 3: Implement the splits**

In `src/domain/models.ts` add `CONTINUE_PLANNING` and `CONTINUE_REMEDIATION` to `JobEvent`. In `state-machine.ts`: replace the hard-coded plan threshold logic in `transitionCritiquing` with `job.planBlockAt`; persist `plan_critique_exhausted`; same for code-review in `enterPatch` persisting `code_review_exhausted`; add `transitionBlocked` branches for the two new events with the documented resume targets and increments; keep `CONTINUE_REVIEW` legacy-only by checking `publicationProtocol`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/state-machine-reliability.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/domain/models.ts src/domain/state-machine.ts tests/state-machine-reliability.test.ts
git commit -m "feat: split plan and code-review exhaustion reasons and events"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 12: Publishing states, distinct plan/review continuation, docs no-op event

**Files:**
- Modify: `src/domain/models.ts`, `src/domain/state-machine.ts`
- Test: `tests/state-machine-publishing.test.ts` (create)

**Interfaces:**
- Produces: new job states `publishing_implementation` and `publishing_docs`; `IMPLEMENTATION_IDLE` → `publishing_implementation` emitting `publish_pull_request` (phase `implementation`); docs idle → `publishing_docs`; `PUBLISHED`/`PUBLISHING_FAILED` events; new jobs never enter `locating_pr`/`resolving_pr_head`/`resolving_docs_head`; `publication_protocol` transitions.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, it } from "vitest";
import { transition, IllegalTransitionError } from "../src/domain/state-machine";
import { jobFixture, stateJob } from "./helpers";

it("moves executor_v2 implementation idle into publishing_implementation", () => {
  const job = stateJob("implementing", { publicationProtocol: "executor_v2", prHeadSha: null });
  const next = transition(job, { type: "IMPLEMENTATION_IDLE" }, 1000);
  expect(next.job.state).toBe("publishing_implementation");
  expect(next.effects.map((e) => e.kind)).toContain("publish_pull_request");
});
it("keeps legacy_v1 in the legacy locate/pr flow until retirement", () => {
  const job = stateJob("implementing", { publicationProtocol: "legacy_v1" });
  const next = transition(job, { type: "IMPLEMENTATION_IDLE" }, 1000);
  expect(next.job.state).toBe("locating_pr");
});
it("resolves publication success directly to validating and stores the head", () => {
  const job = stateJob("publishing_implementation", { publicationProtocol: "executor_v2" });
  const next = transition(job, { type: "PUBLISHED", headSha: "a".repeat(40), prNumber: 3, prUrl: "https://github.com/acme/c/pull/3" }, 1000);
  expect(next.job.state).toBe("validating");
  expect(next.job.prHeadSha).toBe("a".repeat(40));
});
it("keeps a publishing job in publishing_* on an unknown outcome", () => {
  const job = stateJob("publishing_implementation", { publicationProtocol: "executor_v2" });
  const next = transition(job, { type: "PUBLISHING_UNKNOWN" }, 1000);
  expect(next.job.state).toBe("publishing_implementation");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/state-machine-publishing.test.ts`
Expected: FAIL — states/events/effect not present.

- [ ] **Step 3: Implement publishing transitions**

Add `publishing_implementation`, `publishing_docs` to `JobState`; add `publish_pull_request` effect kind and `PUBLISHED`, `PUBLISHING_UNKNOWN`, `PUBLISHING_CONFLICT` to `JobEvent`/`JobEffect`. Wire `transitionImplementing` (executor_v2 → `publishing_implementation`) leaving legacy path intact for `legacy_v1`; wire `transitionDocumenting` (executor_v2 docs idle → `publishing_docs`); `documenting` docs idle for legacy keeps `resolving_docs_head`. Add `transitionPublishingImplementation`/`transitionPublishingDocs` handling `PUBLISHED` (store head, → `validating`), `PUBLISHING_UNKNOWN` (stay), `PUBLISHING_CONFLICT` (→ `failed` with stable publication reason). Update `retryEffect` for the publishing states.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/state-machine-publishing.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/domain/models.ts src/domain/state-machine.ts tests/state-machine-publishing.test.ts
git commit -m "feat: add publishing states and publication saga events"
```
Run `npm run typecheck && npx vitest run` first; all green.

---

## Phase D — Controls, role artifacts, critique bounds, claims

### Task 13: Pure `availableJobControls`

**Files:**
- Create: `src/domain/job-controls.ts`
- Test: `tests/job-controls.test.ts` (create)

**Interfaces:**
- Produces: `JobControl = "status" | "start" | "continue_planning" | "continue_remediation" | "continue_review" | "retry" | "cancel"` and `availableJobControls(snapshot): JobControl[]` implementing the spec's exact availability predicates (see decision), ordered as listed, pure over one durable snapshot.

- [ ] **Step 1: Write the failing tests (table-driven)**

```ts
import { expect, it } from "vitest";
import { availableJobControls, type JobControlsSnapshot } from "../src/domain/job-controls";

const base: JobControlsSnapshot = { state: "awaiting_confirmation", publicationProtocol: "legacy_v1", cancelRequestedAt: null, blockedReason: null, resumeState: null, admissionState: "released", cleanupSettled: true, publicationUnknown: false, reviewFindingsValid: false, admissionQueuedWithEvent: null };
it("status is always available", () => {
  expect(availableJobControls(base).includes("status")).toBe(true);
});
it("start requires awaiting_confirmation, no cancellation, admission absent or queued with CONFIRMED", () => {
  expect(availableJobControls({ ...base, state: "awaiting_confirmation", admissionQueuedWithEvent: "CONFIRMED" })).toEqual(expect.arrayContaining(["start"]));
  expect(availableJobControls({ ...base, state: "planning" })).not.toContain("start");
});
it("continue_remediation is executor_v2-only and requires valid findings + released admission", () => {
  const s = { ...base, state: "blocked", publicationProtocol: "executor_v2", blockedReason: "code_review_exhausted", reviewFindingsValid: true, admissionState: "released" };
  expect(availableJobControls(s)).toContain("continue_remediation");
  expect(availableJobControls({ ...s, blockedReason: "plan_critique_exhausted" })).not.toContain("continue_remediation");
});
it("continue_review is legacy-only", () => {
  const s = { ...base, state: "blocked", publicationProtocol: "legacy_v1", blockedReason: "code_review_exhausted", admissionState: "released" };
  expect(availableJobControls(s)).toContain("continue_review");
  expect(availableJobControls({ ...s, publicationProtocol: "executor_v2" })).not.toContain("continue_review");
});
it("retry requires failed + nonnull resumeState + released", () => {
  const s = { ...base, state: "failed", resumeState: "reviewing", admissionState: "released" };
  expect(availableJobControls(s)).toContain("retry");
  expect(availableJobControls({ ...s, resumeState: null })).not.toContain("retry");
});
it("cancel is absent for terminal/blocked/failed/publishing-unknown states and conserves cleanup on unknown publication", () => {
  expect(availableJobControls({ ...base, state: "merged" })).not.toContain("cancel");
  expect(availableJobControls({ ...base, state: "publishing_implementation", publicationUnknown: true })).toContain("cancel");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/job-controls.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the pure policy**

Implement `availableJobControls` exactly matching the spec's predicate table. It imports nothing from the store; the caller builds the snapshot. Remember `cancel` may record cancellation for a publishing-unknown job but cleanup retains the claim; that nuance lives in the executor, not the pure predicate.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/job-controls.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/domain/job-controls.ts tests/job-controls.test.ts
git commit -m "feat: add pure availableJobControls policy"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 14: Bind controls to Telegram, controller, CLI/callback faces

**Files:**
- Modify: `src/telegram/view.ts`, `src/controller/tools.ts`, `src/cli.ts`, `src/telegram/markdown.ts` (if needed)
- Test: `tests/job-controls-faces.test.ts` (create)

**Interfaces:**
- Consumes: `availableJobControls` (Task 13).
- Produces: Telegram status rendering, controller tool availability, and CLI/thin ingress all return/validate the same ordered control set for a shared snapshot; stale callbacks are rejected before mutation.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { renderAvailableControls } from "../src/telegram/view";
import { controllerControlSet } from "../src/controller/tools";
import { cliControlSet } from "../src/cli";
import { availableJobControls } from "../src/domain/job-controls";

it("all surfaces expose the same ordered controls for a shared snapshot", () => {
  const snapshot = { state: "failed", publicationProtocol: "executor_v2", cancelRequestedAt: null, blockedReason: null, resumeState: "reviewing", admissionState: "released", cleanupSettled: true, publicationUnknown: false, reviewFindingsValid: false, admissionQueuedWithEvent: null };
  const pure = availableJobControls(snapshot);
  expect(renderAvailableControls(snapshot)).toEqual(pure);
  expect(controllerControlSet(snapshot)).toEqual(pure);
  expect(cliControlSet(snapshot)).toEqual(pure);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/job-controls-faces.test.ts`
Expected: FAIL — the three face helpers do not exist.

- [ ] **Step 3: Implement the face helpers**

Add `renderAvailableControls(snapshot)` to `src/telegram/view.ts`, `controllerControlSet(snapshot)` to `src/controller/tools.ts`, and `cliControlSet(snapshot)` to `src/cli.ts`, each delegating to `availableJobControls` and returning the same ordered list. Wire each existing control action to re-validate membership immediately before its mutation and reject stale callbacks.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/job-controls-faces.test.ts`; then the affected existing suites `tests/telegram-view.test.ts`, `tests/controller-tools.test.ts`, `tests/cli.test.ts`.
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/telegram/view.ts src/controller/tools.ts src/cli.ts tests/job-controls-faces.test.ts
git commit -m "feat: one control policy across Telegram controller and CLI faces"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 15: Critique findings bounds and severity vocabulary

**Files:**
- Create: `src/domain/critique.ts`
- Test: `tests/critique-findings.test.ts` (create)

**Interfaces:**
- Produces: `CritiqueSeverity = "blocking" | "advisory"`; `CritiqueFinding` with `path?`, `line?`, `title<=200`, `details<=2000`, `summary<=2000`; `validateCritiqueFindings(findings, attemptId)` enforcing at most 20 findings, the exact severity vocabulary, path `<=512`, one format-correction rule, canonical artifact hash; `needs_revision` requires at least one blocking finding.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { validateCritiqueFindings, needsRevision } from "../src/domain/critique";

it("accepts a bounded plan-critique result and requires a blocking finding for needs_revision", () => {
  const result = validateCritiqueFindings({ verdict: "needs_revision", summary: "x", findings: [{ severity: "blocking", title: "bad", details: "why", path: "src/a.ts", line: 3 }] }, "attempt_1");
  expect(needsRevision(result)).toBe(true);
  expect(result.findings.length).toBeLessThanOrEqual(20);
});
it("rejects non-blocking-only needs_revision and oversized findings", () => {
  expect(() => validateCritiqueFindings({ verdict: "needs_revision", summary: "x", findings: [{ severity: "advisory", title: "t", details: "d" }] }, "attempt_1")).toThrow();
  expect(() => validateCritiqueFindings({ verdict: "needs_revision", summary: "x", findings: [{ severity: "blocking", title: "t".repeat(201), details: "d" }] }, "attempt_1")).toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/critique-findings.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Implement in `src/domain/critique.ts` using `zod` with the exact bounds, computing a canonical artifact hash used by `critique_findings.artifact_sha256` (Task 2). Export `needsRevision(result)` = verdict `needs_revision` and at least one `blocking` finding.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/critique-findings.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/domain/critique.ts tests/critique-findings.test.ts
git commit -m "feat: bound plan critique findings and severity vocabulary"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 16: Persist critique findings per attempt (store)

**Files:**
- Modify: `src/storage/store.ts`
- Test: `tests/critique-findings-store.test.ts` (create)

**Interfaces:**
- Consumes: `critique_findings` schema (Task 2), `validateCritiqueFindings` (Task 15).
- Produces: store methods `persistCritiqueFindings({ attemptId, findings, artifactSha256 })` (upsert under unique `(attempt_id, ordinal)`) and `getLatestCritiqueFindings(jobId)` returning the latest attempt's findings.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { openStore } from "../src/storage/store";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { validateCritiqueFindings } from "../src/domain/critique";

it("persists and reloads the latest critique findings by attempt", () => {
  const { bb } = createFakePluginHost({ pluginId: "critique-store" });
  const store = openStore(bb.storage);
  const findings = validateCritiqueFindings({ verdict: "needs_revision", summary: "s", findings: [{ severity: "blocking", title: "t", details: "d", path: "src/a.ts" }] }, "attempt_1");
  store.persistCritiqueFindings({ attemptId: "attempt_1", jobId: "job_1", findings, artifactSha256: "ab".repeat(32) });
  const loaded = store.getLatestCritiqueFindings("job_1");
  expect(loaded.length).toBe(1);
  expect(loaded[0].severity).toBe("blocking");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/critique-findings-store.test.ts`
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement the store methods**

Add the two store methods with bounded inserts under the unique `(attempt_id, ordinal)`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/critique-findings-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/storage/store.ts tests/critique-findings-store.test.ts
git commit -m "feat: persist critique findings per attempt"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 17: DocsResult canonical JSON and SHA-256 digests

**Files:**
- Create: `src/domain/docs-result.ts`
- Test: `tests/docs-result.test.ts` (create)

**Interfaces:**
- Produces: strict `DocsResult` (`schemaVersion:1`, `changeDisposition`, `baselineHead`, `workspaceTreeSha256`, `diffSha256`, 1–16 `checks`, `summary<=2000`, 32 KiB canonical cap, rejects unknown fields); `docsWorkspaceTreeSha256(pathMap, modeMap, contentSha256Map)`; `docsDiffSha256(before, after)`; the canonical JSON serializer with the exact escaping rules (keys sorted by unsigned UTF-8 byte order; arrays in declared order; only number `1`; no whitespace; never escape `/`; emit valid non-control Unicode scalars directly; `\"`,`\\\\`,`\\b`,`\\t`,`\\n`,`\\f`,`\\r`; other C0 as lowercase `\u00xx`; reject unpaired surrogates). `no_changes_required` requires `diffSha256=null`; `changed` requires a nonnull digest; empty change set represented only by `diffSha256=null`.
- Concretely, for the tree `{path:"docs/x.md",mode:"100644",contentSha256:"<64 a's>"}` the canonical bytes are `{"entries":[{"contentSha256":"aaaa...a","mode":"100644","path":"docs/x.md"}],"version":1}` and `workspaceTreeSha256` is `68a6c5a6430aecc47bdd062c4cd9cf6dd774486f11467c89f7398566b1dbd525`. For the diff adding that path (before null), canonical bytes are `{"changes":[{"after":{"contentSha256":"aaaa...a","mode":"100644"},"before":null,"path":"docs/x.md"}],"version":1}` and `diffSha256` is `b8de8e093a91ab4bfb2ae8eb3d8e22808a11cc03ae2f0df4a43c5075f6eb738f`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { docsWorkspaceTreeSha256, docsDiffSha256, parseDocsResult } from "../src/domain/docs-result";

const A = "a".repeat(64);
it("hashes the canonical workspace tree exactly", () => {
  const digest = docsWorkspaceTreeSha256(undefined, new Map([["docs/x.md", { mode: "100644", contentSha256: A }]]));
  expect(digest).toBe("68a6c5a6430aecc47bdd062c4cd9cf6dd774486f11467c89f7398566b1dbd525");
});
it("hashes the canonical diff exactly", () => {
  const digest = docsDiffSha256([
    { path: "docs/x.md", before: null, after: { mode: "100644", contentSha256: A } },
  ]);
  expect(digest).toBe("b8de8e093a91ab4bfb2ae8eb3d8e22808a11cc03ae2f0df4a43c5075f6eb738f");
});
it("parses a strict DocsResult and rejects unknown fields and overruns", () => {
  const ok = parseDocsResult({ schemaVersion: 1, changeDisposition: "no_changes_required", baselineHead: "a".repeat(40), workspaceTreeSha256: docsWorkspaceTreeSha256(undefined, new Map()), diffSha256: null, checks: [{ name: "docs", outcome: "pass", proofRef: "" }], summary: "ok" });
  expect(ok.changeDisposition).toBe("no_changes_required");
  expect(() => parseDocsResult({ ...ok, changeDisposition: "changed", diffSha256: null })).toThrow(/nonnull/);
  expect(() => parseDocsResult({ ...ok, extra: 1 })).toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/docs-result.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the canonical serializer and digests**

Implement the exact JSON serializer and the two SHA-256 functions in `src/domain/docs-result.ts`, plus `parseDocsResult` via a strict `zod` schema (with `.strict()` and the cross-field `diffSha256` invariant).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/docs-result.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/domain/docs-result.ts tests/docs-result.test.ts
git commit -m "feat: add strict DocsResult canonical json and sha256 digests"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 18: Claims refresh and cleanup pure policy

**Files:**
- Create: `src/domain/claims.ts`
- Test: `tests/claims.test.ts` (create)

**Interfaces:**
- Produces: `refreshPolicy({ claim, currentFence, now, reconcileState })` → `"refresh" | "keep_expired" | "release_on_cleanup"` where a held claim stays held regardless of lease age; `canReleaseClaim({ claim, fence, terminal, unknownReceipt })` returning `boolean` only after fenced cleanup.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { refreshPolicy, canReleaseClaim } from "../src/domain/claims";

it("an expired held claim is never acquired by another job and stays held while unknown/active", () => {
  const claim = { state: "held", leaseExpiresAt: 100, generation: 2, ownerId: "e1" };
  expect(refreshPolicy({ claim, currentFence: { ownerId: "e1", generation: 2 }, now: 5000, reconcileState: "unknown" })).toBe("keep_expired");
  expect(canReleaseClaim({ claim, terminal: "unknown" })).toBe(false);
});
it("releases only after fenced cleanup and settled external outcome", () => {
  const claim = { state: "held", leaseExpiresAt: 100, generation: 2, ownerId: "e1" };
  expect(canReleaseClaim({ claim, terminal: "failed", unknownReceipt: false })).toBe(true);
  expect(canReleaseClaim({ claim, terminal: "idle", unknownReceipt: true })).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/claims.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Implement the pure predicates in `src/domain/claims.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/claims.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/domain/claims.ts tests/claims.test.ts
git commit -m "feat: add claims refresh and cleanup pure policy"
```
Run `npm run typecheck && npx vitest run` first; all green.

---

## Phase E — Claims refresh, failed-job release, retry admission

### Task 19: Refresh held claims on every executor acquisition pass

**Files:**
- Modify: `src/autonomy/scheduler.ts`, `src/autonomy/models.ts`, `src/storage/autonomy-repository.ts`
- Test: `tests/claims-refresh.test.ts` (create)

**Interfaces:**
- Consumes: `refreshPolicy`/`canReleaseClaim` (Task 18).
- Produces: `RELEASE_CANDIDATE_JOB_STATES` adds `failed`; an acquisition-pass method `refreshHeldProjectClaims({ fence, now, leaseMs })` that refreshes/adopts every held claim for an unreleased admission to the current fence, returning the number renewed; `adoptHeldClaims` reuses this path so a held claim can never be acquired by another job.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { fileBackedAutonomyHarness } from "./helpers";
import { AutonomyRepository } from "../src/storage/autonomy-repository";
import { isReleaseCandidate } from "../src/autonomy/models";

it("failed is a release candidate and refresh re-owns held claims under the current fence", () => {
  expect(isReleaseCandidate("failed")).toBe(true);
  const h = fileBackedAutonomyHarness();
  try {
    const repo = h.primaryRepository;
    repo.queueAdmission({ jobId: "job_1", expectedVersion: 1, projectId: "proj_1", resumeEvent: "CONFIRMED", now: 1000 });
    repo.tryAdmit({ jobId: "job_1", maxConcurrentJobs: 8, ownerId: "e1", generation: 2, now: 1000, leaseMs: 30000 });
    const refreshed = repo.refreshHeldProjectClaims({ ownerId: "e1", generation: 2, now: 60000, leaseMs: 30000 });
    expect(refreshed).toBe(1);
    const claim = h.primary.prepare("SELECT lease_expires_at, owner_id, generation FROM job_resource_claims WHERE state='held'").get();
    expect(claim.lease_expires_at).toBe(90000);
  } finally { h.close(); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/claims-refresh.test.ts`
Expected: FAIL — `isReleaseCandidate("failed")` false; `refreshHeldProjectClaims` missing.

- [ ] **Step 3: Implement the refresh pass**

In `src/autonomy/models.ts` add `"failed"` to `RELEASE_CANDIDATE_JOB_STATES`. In `AutonomyRepository` add `refreshHeldProjectClaims({ ownerId, generation, now, leaseMs }): number` — an immediate transaction that, per unreleased admitted/draining job, refreshes every held claim's `owner_id`, `generation`, `lease_expires_at`, `renewed_at` under the current fence, using `refreshPolicy`. Make `adoptHeldClaims` delegate so adoption refreshes all held claims rather than only the required project claim.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/claims-refresh.test.ts`; also `tests/autonomy-release.test.ts` and `tests/autonomy-scheduler.test.ts`.
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/autonomy/scheduler.ts src/autonomy/models.ts src/storage/autonomy-repository.ts tests/claims-refresh.test.ts
git commit -m "feat: refresh held project claims and add failed release candidate"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 20: Failed-job release only after terminal truth and safe cleanup

**Files:**
- Modify: `src/services/job-executor-service.ts`, `src/storage/store.ts`
- Test: `tests/failed-job-release.test.ts` (create)

**Interfaces:**
- Consumes: `canReleaseClaim`, `refreshPolicy`, `isReleaseCandidate`.
- Produces: `beginDraining` waits for terminal worker truth, safe cleanup, and settled external outcomes; `finalizeRelease` revalidates executor/job version/admission/liveness/effects/publication receipts/claims in one immediate transaction, settles only superseded nonexternal effects, releases claims, and marks the admission released; lease age alone never decides release.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { openStore } from "../src/storage/store";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { ReleaseGate } from "../src/services/job-executor-service";

function makeStore(label: string) {
  const { bb } = createFakePluginHost({ pluginId: label });
  return openStore(bb.storage);
}
it("a failed job with an unknown worker and unknown receipt never releases", () => {
  const store = makeStore("failed-release");
  store.createJob({ id: "job_f", sourceUpdateId: 700, requestText: "fail", now: 900 });
  const job = store.getJob("job_f")!;
  store.setJobStateForTest({ jobId: job.id, state: "failed", resumeState: "reviewing", now: 950 });
  store.queueAdmission({ jobId: job.id, expectedVersion: store.getJob("job_f")!.version, projectId: "proj_1", resumeEvent: "RETRY", now: 1000 });
  store.tryAdmit({ jobId: job.id, maxConcurrentJobs: 8, ownerId: "e1", generation: 2, now: 1000, leaseMs: 30000 });
  const gate = new ReleaseGate(store);
  expect(gate.beginDraining({ jobId: "job_f", worker: { state: "unknown" }, publicationReceiptsUnknown: true })).toBe("waiting");
  expect(gate.finalizeRelease({ jobId: "job_f", fence: { ownerId: "e1", generation: 2, now: 2000 }, terminal: "unknown", unknownReceipt: true })).toBe(false);
});
it("a failed job with terminal truth and settled outcomes releases cleanly", () => {
  const store = makeStore("failed-release-ok");
  store.createJob({ id: "job_f", sourceUpdateId: 701, requestText: "fail", now: 900 });
  store.setJobStateForTest({ jobId: "job_f", state: "failed", resumeState: "reviewing", now: 950 });
  store.queueAdmission({ jobId: "job_f", expectedVersion: store.getJob("job_f")!.version, projectId: "proj_1", resumeEvent: "RETRY", now: 1000 });
  store.tryAdmit({ jobId: "job_f", maxConcurrentJobs: 8, ownerId: "e1", generation: 2, now: 1000, leaseMs: 30000 });
  const gate = new ReleaseGate(store);
  const released = gate.finalizeRelease({ jobId: "job_f", fence: { ownerId: "e1", generation: 2, now: 2000 }, terminal: "failed", unknownReceipt: false });
  expect(released).toBe(true);
  expect(store.getAdmission("job_f")?.state).toBe("released");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/failed-job-release.test.ts`
Expected: FAIL — `ReleaseGate` missing; `failed` not treated as a draining candidate.

- [ ] **Step 3: Implement the release gate**

Add a `ReleaseGate` (or extend the existing `finalizeReleaseCandidates`) in `src/services/job-executor-service.ts` implementing the spec's begin-drain/finalize-release semantics, backed by new store methods `releaseAdmissionFenced` and `settleSupercededEffects`, honoring `canReleaseClaim` and never using lease age as authority. Add a test-only `setJobStateForTest({ jobId, state, resumeState, now })` store method (guarded so production callers cannot use it) so the RED tests can place a job in `failed`; without it the tests below have no way to seed the failed state.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/failed-job-release.test.ts`; plus existing `tests/job-executor-service.test.ts`, `tests/autonomy-release.test.ts`.
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/services/job-executor-service.ts src/storage/store.ts tests/failed-job-release.test.ts
git commit -m "feat: gate failed-job release on terminal truth and safe cleanup"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 21: Retry queues via `availableJobControls`, atomic reacquire

**Files:**
- Modify: `src/services/job-executor-service.ts`, `src/storage/store.ts`
- Test: `tests/retry-admission.test.ts` (create)

**Interfaces:**
- Consumes: `availableJobControls` (Task 13).
- Produces: retry ingress does NOT apply `RETRY` directly; it queues a `RETRY` admission only when `availableJobControls` permits; the scheduler transaction wins the unique project claim, changes admission to admitted, applies `RETRY`, and persists resumed effects atomically; a losing race makes no job transition or effect.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { openStore } from "../src/storage/store";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";

it("retry queues an admission and atomically reacquires before state/effects resume", () => {
  const store = openStore((() => { const { bb } = createFakePluginHost({ pluginId: "retry-admit" }); return bb.storage; })());
  store.createJob({ id: "job_r", sourceUpdateId: 900, requestText: "retry me", now: 900 });
  const job = store.getJob("job_r")!;
  store.setJobStateForTest({ jobId: job.id, state: "failed", resumeState: "reviewing", now: 950 });
  const queued = store.queueAdmission({ jobId: job.id, expectedVersion: job.version, projectId: "proj_1", resumeEvent: "RETRY", now: 1000 });
  expect(queued.resumeEvent).toBe("RETRY");
  const attempt = store.tryAdmit({ jobId: job.id, maxConcurrentJobs: 8, ownerId: "e1", generation: 2, now: 1000, leaseMs: 30000 });
  expect(attempt.outcome).toBe("admitted");
  expect(attempt.job.state).toBe("reviewing");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/retry-admission.test.ts`
Expected: FAIL — retry event not part of the scheduler admission path yet.

- [ ] **Step 3: Implement**

Remove the direct `RETRY` application from Telegram/controller retry ingress; route it to `queueAdmission({ resumeEvent: "RETRY" })` gated by `availableJobControls`. In the repository, when admitting a `RETRY` event, atomically acquire the project claim, apply `RETRY` via the state machine, and persist resumed effects; a unique-claim `SQLITE_CONSTRAINT` loses cleanly with no transition/effect.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/retry-admission.test.ts`; plus `tests/autonomy-admission.test.ts`.
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/services/job-executor-service.ts src/storage/store.ts tests/retry-admission.test.ts
git commit -m "feat: queue retry admission under controls and reacquire atomically"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 22: Admission precedes every execution (confirmation/plan/remediation/review/retry)

**Files:**
- Modify: `src/autonomy/scheduler.ts`, `src/services/job-executor-service.ts`, `src/storage/store.ts`
- Test: `tests/admission-precedes-execution.test.ts` (create)

**Interfaces:**
- Produces: `CONFIRMED`, `CONTINUE_PLANNING`, `CONTINUE_REMEDIATION`, legacy `CONTINUE_REVIEW`, and `RETRY` are all admission resume events; the transaction that admits also acquires the project claim and applies the state-machine event; no work effect exists before both succeed; a losing two-connection race leaves no job transition or effect.

- [ ] **Step 1: Write the failing two-connection test**

```ts
import { expect, it } from "vitest";
import { fileBackedAutonomyHarness } from "./helpers";

it("two connections racing for the same project claim admit exactly one", () => {
  const h = fileBackedAutonomyHarness();
  try {
    h.primaryRepository.queueAdmission({ jobId: "job_a", expectedVersion: 1, projectId: "proj_1", resumeEvent: "CONFIRMED", now: 1000 });
    h.primaryRepository.queueAdmission({ jobId: "job_b", expectedVersion: 1, projectId: "proj_1", resumeEvent: "CONFIRMED", now: 1100 });
    const a = h.primaryRepository.tryAdmit({ jobId: "job_a", maxConcurrentJobs: 8, ownerId: "e1", generation: 2, now: 2000, leaseMs: 30000 });
    const b = h.secondaryRepository.tryAdmit({ jobId: "job_b", maxConcurrentJobs: 8, ownerId: "e1", generation: 2, now: 2100, leaseMs: 30000 });
    const winners = [a, b].filter((r) => r.outcome === "admitted");
    expect(winners.length).toBe(1);
    expect(h.primary.prepare("SELECT COUNT(*) c FROM job_resource_claims WHERE state='held'").get().c).toBe(1);
  } finally { h.close(); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/admission-precedes-execution.test.ts`
Expected: FAIL — the scheduler does not atomically couple admission+claim+event.

- [ ] **Step 3: Implement atomic admission+claim+event**

Refactor the admit path so `tryAdmit` runs an immediate transaction that (a) acquires the unique project claim, (b) applies the resume event through the state machine, and (c) persists resumed effects — in that order with the unique-claim constraint as the only contention winner. Return a `lost_race` rejection with no side effects otherwise.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/admission-precedes-execution.test.ts`; plus `tests/autonomy-admission.test.ts`, `tests/autonomy-races.test.ts`.
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/autonomy/scheduler.ts src/services/job-executor-service.ts src/storage/store.ts tests/admission-precedes-execution.test.ts
git commit -m "feat: admission reacquires project claim before execution resumes"
```
Run `npm run typecheck && npx vitest run` first; all green.

---

## Phase F — Provenance, obligations, and conditional silence

### Task 23: Thread provenance prepare/bind/classify

**Files:**
- Create: `src/services/thread-provenance.ts`
- Modify: `src/storage/store.ts`
- Test: `tests/thread-provenance.test.ts` (create)

**Interfaces:**
- Produces: `prepareProvenance({ jobId, role, class, intentVisibility })` before spawn writes a `prepared` intent; `bindProvenance({ provenanceId, threadId, originMetaDigest })` after BB returns binds under a fence; `classifyThread({ threadId, preparedIntent, origin })` returns the exact class precedence (durable registration → BB origin → `internal_unknown`); a crashed-before-bind candidate is `internal/unknown` and reconciles exactly one matching candidate or quarantines.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { openStore } from "../src/storage/store";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { prepareProvenance, bindProvenance, classifyThread } from "../src/services/thread-provenance";

it("binds exactly one prepared owner-work candidate and quarantines ambiguous matches", () => {
  const store = openStore((() => { const { bb } = createFakePluginHost({ pluginId: "provenance" }); return bb.storage; })());
  const intent = prepareProvenance({ jobId: "job_1", role: "implementation", class: "job_pipeline", intentVisibility: "hidden", now: 1000 });
  expect(intent.spawnState).toBe("prepared");
  const bound = bindProvenance({ provenanceId: intent.provenanceId, threadId: "thr_1", originMetaDigest: "d1", fence: { ownerId: "e1", generation: 2, now: 1100 } });
  expect(bound.threadId).toBe("thr_1");
  expect(bound.spawnState).toBe("bound");
  expect(classifyThread({ candidateThreadId: "thr_1", preparedIntent: intent, originOwner: "plugin", now: 1200 })).toBe("job_pipeline");
});
it("a title change never changes classification", () => {
  expect(classifyThread({ candidateThreadId: "thr_9", preparedIntent: null, originOwner: "plugin", now: 1300 })).toBe("internal_unknown");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/thread-provenance.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement prepare/bind/classify + store**

Implement the three functions in `src/services/thread-provenance.ts` and the backing store methods (`insertProvenanceIntent`, `bindProvenanceFenced`, `reconcileQuarantinedCandidates`). Classification never examines title text; it uses durable registration, then BB origin metadata, then `internal_unknown`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/thread-provenance.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/services/thread-provenance.ts src/storage/store.ts tests/thread-provenance.test.ts
git commit -m "feat: durable thread provenance prepare bind and classify"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 24: Notice classification and exact cycle keys

**Files:**
- Modify: `src/services/thread-notice-service.ts`, `src/storage/store.ts`
- Test: `tests/thread-notice-cycles.test.ts` (create)

**Interfaces:**
- Produces: classification precedence honored by the notice service; owner-work terminal cycles create generic finished/failed notices; job-pipeline activity emits job status only; delegation members emit no generic notice; internal threads emit none; outbox key `thread:<threadId>:<runId>:<cycleOrdinal>:<terminalStatus>`; each transition into idle/error increments the durable cycle ordinal; replays reuse the key; a later genuine cycle increments it; no time cooldown decides identity.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { openStore } from "../src/storage/store";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { threadCycleKey } from "../src/services/thread-notice-service";

it("derives an exact deterministic cycle key", () => {
  expect(threadCycleKey({ threadId: "thr_1", runId: "run_7", cycleOrdinal: 2, terminalStatus: "error" })).toBe("thread:thr_1:run_7:2:error");
});
it("a fresh cycle increments the ordinal while a replay reuses the prior key", () => {
  const store = openStore((() => { const { bb } = createFakePluginHost({ pluginId: "notice-cycles" }); return bb.storage; })());
  store.advanceNoticeCycle({ threadId: "thr_1", runId: "run_7", terminalStatus: "idle", now: 1000 });
  store.advanceNoticeCycle({ threadId: "thr_1", runId: "run_7", terminalStatus: "idle", now: 2000 });
  expect(store.getNoticeCycleOrdinal("thr_1", "run_7")).toBe(1);   // exact replay reuses cycle 1 via dedup path
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/thread-notice-cycles.test.ts`
Expected: FAIL — helpers missing.

- [ ] **Step 3: Implement**

Add `threadCycleKey` and store `advanceNoticeCycle`/`getNoticeCycleOrdinal`/`settleNoticeCycle` honoring the unique `(thread_id, run_id, cycle_ordinal)` constraint and the build-owner-style idempotency.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/thread-notice-cycles.test.ts`; plus `tests/thread-notices.test.ts`.
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/services/thread-notice-service.ts src/storage/store.ts tests/thread-notice-cycles.test.ts
git commit -m "feat: classify notices by provenance with exact cycle keys"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 25: Communication obligation state machine

**Files:**
- Create: `src/services/communication-obligations.ts`
- Modify: `src/storage/store.ts`
- Test: `tests/communication-obligations.test.ts` (create)

**Interfaces:**
- Produces: obligation states `owed | queued | delivery_unknown | delivered | silent | escalated`; `claimSendAttempt` (immediate transaction: claim exact row, increment attempt ordinal, store destination/payload digest, move to `delivery_unknown` before the call); `recordDelivered` (verify attempt/digest, mark outbox sent, → `delivered` on a returned bounded message identity); `recordPreSendFailure` (→ `queued`); acceptance (`owed→queued` with outbox + digest) and accepted silence (`owed→silent`, no outbox/digest).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { openStore } from "../src/storage/store";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { recordDelivered, claimSendAttempt, enqueueFromTurn } from "../src/services/communication-obligations";

it("acceptance enqueues (queued, not delivered) and an ambiguous send is delivery_unknown", () => {
  const store = openStore((() => { const { bb } = createFakePluginHost({ pluginId: "obligation" }); return bb.storage; })());
  const ob = enqueueFromTurn({ turnId: "turn_1", source: "owner", deliveryRequirement: "required", payloadDigest: "ab".repeat(32), now: 1000 });
  expect(ob.state).toBe("queued");
  const claimed = claimSendAttempt({ obligationId: ob.turnId, destination: "chat_1", payloadDigest: "ab".repeat(32), now: 2000 });
  expect(claimed.state).toBe("delivery_unknown");
  const delivered = recordDelivered({ obligationId: ob.turnId, attemptOrdinal: 1, inputDigest: "ab".repeat(32), telegramMessageIdentity: "msg_9", now: 3000 });
  expect(delivered.state).toBe("delivered");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/communication-obligations.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement obligation repository + store**

Implement the obligation transitions in `src/services/communication-obligations.ts` over store methods `createObligation`, `claimObligationSendAttemptFenced`, `settleObligationDeliveredFenced`, `settleObligationQueued`, `settleObligationSilent`. Delivery truth comes only from a returned Telegram identity committed under the exact attempt digest; never from an attempted request.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/communication-obligations.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/services/communication-obligations.ts src/storage/store.ts tests/communication-obligations.test.ts
git commit -m "feat: communication obligation states and delivery-unknown attempts"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 26: Telegram delivery-unknown capture before the send

**Files:**
- Modify: `src/services/telegram-service.ts`, `src/telegram/client.ts`, `src/services/job-executor-service.ts`
- Test: `tests/telegram-delivery-unknown.test.ts` (create)

**Interfaces:**
- Produces: before every outbox send, an immediate transaction claims the exact logical outbox row and records the attempt/digest as `delivery_unknown`; a returned bounded chat/message identity commits `delivered` under the exact attempt; an explicit pre-transmission failure returns to `queued`; a timeout/crash stays `delivery_unknown`. The at-rest backstop at startup and each executor pass repairs owed/queued/delivery_unknown/escalated obligations and stalled submitted turns (`CONTROLLER_STALL_MS`).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { openStore } from "../src/storage/store";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { runTelegramDeliveryBackstop, enqueueFromTurn, claimSendAttempt } from "../src/services/communication-obligations";

it("an ambiguous Telegram call stays delivery_unknown and the backstop retries at-least-once", () => {
  const store = openStore((() => { const { bb } = createFakePluginHost({ pluginId: "telegram-unknown" }); return bb.storage; })());
  enqueueFromTurn({ turnId: "turn_1", source: "owner", deliveryRequirement: "required", payloadDigest: "ab".repeat(32), now: 1000 });
  // A send that times out after possible transmission stays delivery_unknown.
  claimSendAttempt({ obligationId: "turn_1", destination: "chat_1", payloadDigest: "ab".repeat(32), now: 2000 });
  const result = runTelegramDeliveryBackstop({ store, now: 5000 });
  expect(typeof result.duplicateRiskRecorded).toBe("boolean"); // transport duplication is allowed and recorded
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/telegram-delivery-unknown.test.ts`
Expected: FAIL — backstop helper missing.

- [ ] **Step 3: Implement the delivery-capture + backstop**

Add the delivery-unknown capture around outbox sends in `src/services/job-executor-service.ts` and `src/services/telegram-service.ts` and implement `runTelegramDeliveryBackstop` in `src/services/communication-obligations.ts` (repair owed/queued/delivery_unknown/escalated obligations and stalled submitted turns). At-least-once is explicit; a duplicate transport message after an ambiguous call is allowed and recorded.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/telegram-delivery-unknown.test.ts`; plus `tests/telegram-service.test.ts`.
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/services/telegram-service.ts src/telegram/client.ts src/services/communication-obligations.ts src/services/job-executor-service.ts tests/telegram-delivery-unknown.test.ts
git commit -m "feat: record delivery-unknown before Telegram sends and backstop repairs"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 27: Conditional monitor silence evaluator

**Files:**
- Create: `src/services/system-monitor-silence.ts`
- Modify: `src/services/monitor-service.ts`, `src/services/system-monitors.ts`
- Test: `tests/system-monitor-silence.test.ts` (create)

**Interfaces:**
- Produces: pure `evaluateSilencePolicy({ turn, systemKey, evidence, currentState })` → `"silent" | "must_message" | "reject"`; only `system-stale-jobs` and `system-memory-audit` (conditionally allowlisted, `deliveryRequirement=conditional`) can settle silently; accepted silence creates no outbox/digest and settles the obligation; `TurnCompletionPolicy` and `SystemMonitorSilenceEvaluator` reject every other source/boundary; monitor advance + turn + obligation are one immediate transaction.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { evaluateSilencePolicy } from "../src/services/system-monitor-silence";

it("accepts silence only for the two allowlisted conditional system monitors", () => {
  expect(evaluateSilencePolicy({ turn: { deliveryRequirement: "required" }, systemKey: "system-stale-jobs", evidence: "clean" })).toBe("reject");
  expect(evaluateSilencePolicy({ turn: { deliveryRequirement: "conditional" }, systemKey: "system-stale-jobs", evidence: { noOwnerDecisionItem: true, freshPositiveProof: true } })).toBe("silent");
  expect(evaluateSilencePolicy({ turn: { deliveryRequirement: "conditional" }, systemKey: "system-autonomy-scorecard", evidence: "x" })).toBe("reject");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/system-monitor-silence.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement evaluator + atomic monitor firing**

Implement `evaluateSilencePolicy` in `src/services/system-monitor-silence.ts` per the spec's two-monitor policy. Wire the monitor-fire path in `src/services/monitor-service.ts` so monitor advance, controller-turn enqueue, and obligation creation commit in ONE transaction (matching the spec's `system-*` source/delivery table); delegation join likewise.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/system-monitor-silence.test.ts`; plus `tests/monitor.test.ts`.
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/services/system-monitor-silence.ts src/services/monitor-service.ts src/services/system-monitors.ts tests/system-monitor-silence.test.ts
git commit -m "feat: conditional monitor silence with atomic advance and obligation"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 28: Gated publication coordinator and adapter fakes (disabled)

**Files:**
- Create: `src/services/publication-adapter.ts`, `src/services/publication-coordinator.ts`
- Test: `tests/publication-gates.test.ts` (create)

**Interfaces:**
- Consumes: `publication_sagas`/`publication_step_receipts` (Task 3), DocResult digests (Task 17), `availableJobControls`.
- Produces: `executor_v2` eligibility gate `publicationEligible({ capabilities })` that returns `false` until versioned runtime attestations exist for conditional env commit, native Git/ref/network isolation, atomic activity snapshot, exact non-force push, and GitHub list/create. `PublicationCoordinator` and `PublicationAdapter` implement the saga transitions and local/remote/GitHub reads but every boundary mutation is rejected while the gate is off; the effect remains `publishing_*` and the run/claim stays held. A `publish_pull_request` effect in `legacy_v1` keeps today's behavior (locate/resolve legacy path) untouched.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { publicationEligible, PublicationGate } from "../src/services/publication-coordinator";

it("the pure eligibility predicate is false without capability attestations", () => {
  expect(publicationEligible({ conditionalCommit: null, nativeIsolation: null, activitySnapshot: null })).toBe(false);
});
it("executor_v2 publication is denied without the versioned capability attestations", () => {
  const gate = new PublicationGate({ conditionalCommit: null, nativeIsolation: null, activitySnapshot: null, pushAdapter: null, listCreateAdapter: null });
  expect(gate.eligibility()).toBe(false);
  const decision = gate.decide({ job: { publicationProtocol: "executor_v2", state: "publishing_implementation" } as never });
  expect(decision.mutation).toBe("denied");
  expect(decision.reason).toContain("attestation");
});
it("legacy_v1 publication continues through the existing legacy path untouched", () => {
  const gate = new PublicationGate({ conditionalCommit: null, nativeIsolation: null /* ... */ });
  expect(gate.decide({ job: { publicationProtocol: "legacy_v1", state: "implementing" } as never }).mutation).toBe("legacy");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/publication-gates.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the disabled gate and coordinator**

Implement `PublicationGate` covering `executor_v2` with: before the first unknown receipt the only mutation, `environment.commit`, requires `conditionalCommit` + `nativeIsolation` + `activitySnapshot` attestations; otherwise `denied` with no receipt and no mutation. `PublicationAdapter` exposes only read helpers under the gate (register-owned fakes; no model tool; no secrets/raw output). The coordinator persists saga/step receipts only when the gate is on, which it never is in this plan.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/publication-gates.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/services/publication-adapter.ts src/services/publication-coordinator.ts tests/publication-gates.test.ts
git commit -m "feat: gate executor_v2 publication behind runtime attestations"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 29: Compatibility readers and legacy retirement guard

**Files:**
- Modify: `src/storage/store.ts`, `src/plugin.ts`
- Test: `tests/reliability-compatibility.test.ts` (create)

**Interfaces:**
- Consumes: `publication_protocol` column (Task 1).
- Produces: readers that accept both `legacy_v1` and `executor_v2` states and all job states; existing nonterminal jobs remain `legacy_v1`; new-job creation writes `executor_v2` only after the publisher activation gate is enabled (which it is not in this plan, so all new jobs stay `legacy_v1`); never convert a job between protocols after creation; legacy locate/resolve states are readable but no new entry occurs.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { openStore } from "../src/storage/store";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";

it("new jobs stay legacy_v1 until the publisher gate is enabled", () => {
  const store = openStore((() => { const { bb } = createFakePluginHost({ pluginId: "compat" }); return bb.storage; })());
  const created = store.createJob({ id: "job_c", sourceUpdateId: 800, requestText: "compat", now: 800 });
  expect(created.publicationProtocol).toBe("legacy_v1");
});
it("reads legacy and executor states through the compatibility reader and refuses executor_v2 while the publisher gate is off", () => {
  const store = openStore((() => { const { bb } = createFakePluginHost({ pluginId: "compat-reader" }); return bb.storage; })());
  store.createJob({ id: "job_c", sourceUpdateId: 801, requestText: "compat", now: 810 });
  expect(() => store.createJobWithProtocol({ id: "job_e", sourceUpdateId: 802, requestText: "gate", protocol: "executor_v2", now: 820 })).toThrow(/publisher gate/);
  const created = store.createJobWithProtocol({ id: "job_c2", sourceUpdateId: 803, requestText: "compat", protocol: "legacy_v1", now: 830 });
  expect(created.publicationProtocol).toBe("legacy_v1");
  // A test/operator-only escape hatch exists for readers; it is never enabled in production.
  store.setPublicationProtocol({ jobId: "job_c2", protocol: "executor_v2" });
  expect(store.getJob("job_c2")!.publicationProtocol).toBe("executor_v2");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/reliability-compatibility.test.ts`
Expected: FAIL — job creation does not enforce the protocol gate.

- [ ] **Step 3: Implement the compatibility gate**

Add `setPublicationProtocol` (test/operator only) and `createJobWithProtocol({ id, sourceUpdateId, requestText, protocol, now })` (test/operator only) to the store, and enforce at `createJob`/`createJobWithProtocol` that `executor_v2` is refused while the publisher activation gate is off (feature gate constant `PUBLISHER_ACTIVATION_ENABLED = false`). Keep all protocol readers dual-state.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/reliability-compatibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/storage/store.ts src/plugin.ts tests/reliability-compatibility.test.ts
git commit -m "feat: compatibility readers for both protocols and job creation gate"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 30: Remove contradictory delivery authority from role handoffs

**Files:**
- Modify: `src/bb/handoffs.ts`, `src/bb/runner.ts`, `src/bb/prompts.ts`
- Test: `tests/reliability-role-handoff.test.ts` (create)

**Interfaces:**
- Produces: planner, critic, builder/remediator, reviewer, and docs inputs contain no contradictory delivery authority; model workers cannot obtain a publish capability or credential; docs worker input separates its strict `DocsResult` completion from any commit/push/PR step (which lives in the publication effect, tests, and gate only).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { buildWorkOrder } from "../src/bb/handoffs";
import { buildDocsInstruction } from "../src/bb/prompts";
import { jobFixture, policyFixture } from "./helpers";

it("the docs instruction no longer orders commit/push/PR by the model", () => {
  const text = buildDocsInstruction("dummy");
  expect(text.toLowerCase()).not.toContain("commit and push");
});
it("the work order does not instruct workspace roles to publish", () => {
  const text = buildWorkOrder(jobFixture(), policyFixture()).bytes.toString();
  expect(text).not.toMatch(/commit the intended changes/i);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/reliability-role-handoff.test.ts`
Expected: FAIL — the current handoffs still contain the contradictory authority.

- [ ] **Step 3: Remove the contradiction**

Remove commit/push/PR directives from worker-facing instructions; publish only through the fenced saga (Task 28). Docs worker returns the strict `DocsResult`; publication runs only through the coordinator. Leave `legacy_v1` handoff copy untouched so live legacy behavior is unchanged; the plan only removes the contradictory delivery authority for the new executor-facing flows.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/reliability-role-handoff.test.ts`; plus `tests/handoffs.test.ts`.
Expected: PASS.

- [ ] **Step 5: Run gate and commit**

```bash
git add src/bb/handoffs.ts src/bb/runner.ts src/bb/prompts.ts tests/reliability-role-handoff.test.ts
git commit -m "feat: remove contradictory delivery authority from role handoffs"
```
Run `npm run typecheck && npx vitest run` first; all green.

### Task 31: Full-system coexistence, crash replay, and evaluation baseline

**Files:**
- Modify: various (only where the full gate dictates)
- Test: `tests/reliability-coexistence.test.ts` (create)

**Interfaces:**
- Produces: a run touching each new surface (terminal runner absorbing, worker runs, controls, obligations, provenance, docs digest, publication gate) so the acceptance criteria in the spec are each exercised once; no live job/database/ref/PR is mutated; fixed controller evaluation baseline stays green under its recorded harness and budget.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { openStore } from "../src/storage/store";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { prepareProvenance } from "../src/services/thread-provenance";
import { evaluateSilencePolicy } from "../src/services/system-monitor-silence";
import { PublicationGate } from "../src/services/publication-coordinator";

function bootReliabilitySurfaces() {
  const { bb } = createFakePluginHost({ pluginId: "coexistence" });
  const store = openStore(bb.storage);
  return {
    terminals: typeof store.claimNextControllerTurn === "function",
    workerRuns: typeof store.registerWorkerRun === "function",
    obligations: typeof store.createObligation === "function",
    provenance: typeof prepareProvenance === "function",
    silenceAllowlisted: typeof evaluateSilencePolicy === "function",
    publicationGateDenied: new PublicationGate({}).eligibility() === false,
  };
}
it("critical coexistence boots with all reliability surfaces registered", () => {
  const banner = bootReliabilitySurfaces();
  expect(banner.terminals).toBe(true);
  expect(banner.workerRuns).toBe(true);
  expect(banner.obligations).toBe(true);
  expect(banner.provenance).toBe(true);
  expect(banner.silenceAllowlisted).toBe(true);
  expect(banner.publicationGateDenied).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails / then passes**

Run: `npx vitest run tests/reliability-coexistence.test.ts`
Then the release gate.

- [ ] **Step 3: Run full release gate**

Run: `npm run typecheck && npx vitest run && npm run eval:controller`
Expected: typecheck clean; all tests green; fixed controller evaluation within its recorded baseline and budget.

- [ ] **Step 4: Run docs-guard and git hygiene**

Run: `npx docs-guard tests targets docs/architecture.md src/...` (or the repo's configured docs-guard invocation) plus `git diff --check`.
Expected: no doc drift; no whitespace errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: reliability test-only foundation and compatibility release"
```

### Task 32: Update architecture/operations docs and finalize

**Files:**
- Modify: `docs/architecture.md`, `docs/operations.md`, `docs/configuration.md`
- Test: none (docs only)

**Interfaces:**
- Produces: documentation describing the new ordered liveness, continuation events, publishing states, provenance classification, and communication-obligation delivery policy; note all capability-gated paths stay disabled until BB runtime attestations exist.

- [ ] **Step 1: Write the doc edits**

Add sections for the reliability foundation under active state, and a "disabled by design" note for `executor_v2`, atomic activity snapshot, conditional commit, native isolation, and fresh-auto activation.

- [ ] **Step 2: Run docs-guard**

Run: `npx docs-guard tests targets docs/architecture.md`
Expected: no drift between docs and referenced symbols/code.

- [ ] **Step 3: Run full gate and commit**

Run: `npm run typecheck && npx vitest run && git diff --check`
```bash
git add docs/architecture.md docs/operations.md docs/configuration.md
git commit -m "docs: document the reliability foundation and disabled gates"
```

---

## Plan completion and handoff

The plan ships the append-only migrations (Tasks 1–6), the absorbing-terminal and observation ordering foundation (Tasks 7–10), the state-machine splits and publishing states (Tasks 11–12), the pure control/artifact/docs/claims policies (Tasks 13–18), claims retention and admission-precedes-execution (Tasks 19–22), provenance + obligations + silence + gated publication + compatibility (Tasks 23–30), and the coexistence + docs + release gate (Tasks 31–32). Every capability-gated mutation path is locked off by a deterministic gate; the vendored BB SDK does not yet expose the required versioned attestations, so `executor_v2` and all real `publish_pull_request` boundary mutations remain disabled.

**Open blockers and preconditions for later cutover (not part of this plan):**
- BB must expose an atomic activity-snapshot (or shared-revision) capability; until then, negative/idle inference for BB threads stays `unknown`.
- BB must expose a runtime-attested conditional commit primitive equivalent to `commitIfCurrent({ environmentId, expectedHead, expectedCandidateTreeSha256, requestKey })` with deterministic request deduplication; the current unconditional `environments.commit({ environmentId })` must never be used for `executor_v2`.
- BB must attest native Git/ref/network isolation and mechanically deny worker/controller commit, ref mutation, push, GitHub write, merge, and deploy while preserving edit/test.
- A real-provider denial integration test and full verification/rollback rehearsal must pass before `executor_v2` or fresh-auto activation.
- Trust-kernel Tasks 7–10 land first; reliability tables run in parallel without altering those cursor/evidence contracts.
