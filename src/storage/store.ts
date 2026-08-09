import type { BbPluginApi } from "@bb/plugin-sdk";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  projectPolicySchema,
  type Job,
  type JobEffect,
  type JobEvent,
  type JobState,
  type ProjectPolicy,
  type StoredEffect,
} from "../domain/models";
import { assertSafeFailureSummary, transition } from "../domain/state-machine";
import { ALL_MIGRATIONS } from "./migrations";

type PluginStorage = BbPluginApi["storage"];
type SqliteDatabase = Database.Database;
type PluginKv = PluginStorage["kv"];

export type PairingResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing" | "expired" | "consumed" | "already_paired";
    };

export type Owner = { userId: string; chatId: string; pairedAt: number };
type TelegramIdentity = {
  botId: string;
  username: string;
  verifiedAt: number;
};
export type ProjectPolicyRecord = { policy: ProjectPolicy; version: number };

export type OutboxInput = {
  logicalKey: string;
  chatId: string;
  messageId?: number | null;
  payload: Record<string, unknown>;
};

type PairingCodeRow = {
  consumed_at: number | null;
  expires_at: number;
};
type OwnerRow = {
  telegram_user_id: string;
  telegram_chat_id: string;
  paired_at: number;
};
type ProjectPolicyRow = {
  policy_json: string;
  version: number;
};
type TelegramIdentityRow = {
  bot_id: string;
  username: string;
  verified_at: number;
};

type JobRow = {
  id: string;
  source_update_id: number;
  request_text: string;
  state: string;
  resume_state: string | null;
  project_id: string | null;
  policy_version: number | null;
  policy_json: string | null;
  environment_id: string | null;
  implementation_thread_id: string | null;
  review_thread_id: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_head_sha: string | null;
  status_message_id: number | null;
  review_cycle: number;
  review_block_at: number;
  cancel_requested_at: number | null;
  blocked_reason: Job["blockedReason"];
  last_error: string | null;
  version: number;
  created_at: number;
  updated_at: number;
};

type EffectRow = {
  idempotency_key: string;
  job_id: string;
  kind: StoredEffect["kind"];
  payload_json: string;
  status: StoredEffect["status"];
  attempts: number;
  lease_owner: string | null;
  lease_generation: number | null;
  lease_expires_at: number | null;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};
type TelegramUpdateRow = {
  status: "processing" | "processed" | "failed";
  claim_owner: string | null;
  claim_generation: number | null;
  claim_expires_at: number | null;
};

const JOB_STATES: ReadonlySet<JobState> = new Set([
  "awaiting_project",
  "awaiting_confirmation",
  "creating_implementation",
  "implementing",
  "locating_pr",
  "resolving_pr_head",
  "reviewing",
  "remediating",
  "validating",
  "awaiting_merge_approval",
  "merging",
  "failed",
  "blocked",
  "cancelled",
  "merged",
]);
const BLOCKED_REASONS: ReadonlySet<NonNullable<Job["blockedReason"]>> = new Set([
  "review_limit",
  "configuration",
  "cancellation_unconfirmed",
  "permanent_effect_failure",
]);

export class VersionConflictError extends Error {
  public constructor(jobId: string, expectedVersion: number) {
    super(`Job ${jobId} changed since version ${expectedVersion}`);
    this.name = "VersionConflictError";
  }
}

export class IdempotencyConflictError extends Error {
  public constructor(sourceUpdateId: number) {
    super(`Telegram update ${sourceUpdateId} was replayed with different job input`);
    this.name = "IdempotencyConflictError";
  }
}

export class ActiveJobConflictError extends Error {
  public constructor(jobId: string) {
    super(`Job ${jobId} cannot continue while another job is active`);
    this.name = "ActiveJobConflictError";
  }
}

export class UpdateClaimConflictError extends Error {
  public constructor(updateId: number) {
    super(`Telegram update ${updateId} is not owned by this store claim`);
    this.name = "UpdateClaimConflictError";
  }
}

const LAST_PROJECT_KEY = "telegram-agent:last-project";

const CANONICAL_POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TELEGRAM_UPDATE_LEASE_MS = 300_000;

function assertCanonicalPositiveDecimal(value: string, field: string): void {
  if (typeof value !== "string" || !CANONICAL_POSITIVE_DECIMAL.test(value)) {
    throw new TypeError(`${field} must be a canonical positive decimal string`);
  }
}

function assertSha256Hex(value: string): void {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError("Pairing code must be a lowercase 64-character SHA-256 hex string");
  }
}

export interface TelegramAgentStore {
  createPairingCode(codeHash: string, createdAt: number, expiresAt: number): void;
  pairOwnerWithCode(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
  ): PairingResult;
  pairOwnerWithPrivateChatCode(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
  ): PairingResult;
  getOwner(): Owner | null;
  revokeOwner(now: number): boolean;
  bindTelegramIdentity(input: {
    botId: string;
    username: string;
    now: number;
    hasActiveJob: boolean;
  }): "created" | "same" | "changed" | "active_job_conflict";
  getTelegramIdentity(): TelegramIdentity | null;
  upsertProjectPolicy(policy: ProjectPolicy, now: number): ProjectPolicyRecord;
  getProjectPolicy(projectId: string): ProjectPolicyRecord | null;
  getProjectPolicyByAlias(alias: string): ProjectPolicyRecord | null;
  listEnabledProjectPolicies(): ProjectPolicyRecord[];
  createJob(input: {
    id: string;
    sourceUpdateId: number;
    requestText: string;
    now: number;
  }): Job;
  setJobStatusMessage(jobId: string, messageId: number, expectedVersion: number, now: number): Job;
  enqueueSteeringEffect(
    jobId: string,
    updateId: number,
    threadId: string,
    text: string,
    now: number,
  ): boolean;
  enqueueOutbox(item: OutboxInput, now: number): void;
  setLastProject(projectId: string): Promise<void>;
  getLastProject(): Promise<string | null>;
  getJob(jobId: string): Job | null;
  getActiveJob(): Job | null;
  findJobByThreadId(threadId: string): Job | null;
  listJobs(limit: number): Job[];
  applyJobEvent(jobId: string, expectedVersion: number, event: JobEvent, now: number): Job;
  listEffectsForJob(jobId: string): StoredEffect[];
  beginTelegramUpdate(updateId: number, now: number): "process" | "processed";
  completeTelegramUpdate(updateId: number, outcome: string, now: number): void;
  failTelegramUpdate(updateId: number, error: string, now: number): void;
  getNextTelegramOffset(): number;
  recordCallback(callbackId: string, jobId: string | null, action: string, outcome: string, now: number): boolean;
  enqueueReconcileForThread(threadId: string, now: number): boolean;
}

function parsePolicy(row: ProjectPolicyRow): ProjectPolicyRecord {
  return {
    policy: projectPolicySchema.parse(JSON.parse(row.policy_json)),
    version: row.version,
  };
}

function parseJob(row: JobRow): Job {
  if (!JOB_STATES.has(row.state as JobState)) throw new Error(`Unknown persisted job state: ${row.state}`);
  if (row.resume_state !== null && !JOB_STATES.has(row.resume_state as JobState)) {
    throw new Error(`Unknown persisted resume state: ${row.resume_state}`);
  }
  if (row.blocked_reason !== null && !BLOCKED_REASONS.has(row.blocked_reason)) {
    throw new Error(`Unknown persisted blocked reason: ${row.blocked_reason}`);
  }
  return {
    id: row.id,
    sourceUpdateId: row.source_update_id,
    requestText: row.request_text,
    state: row.state as JobState,
    resumeState: row.resume_state as JobState | null,
    projectId: row.project_id,
    policyVersion: row.policy_version,
    policy: row.policy_json === null
      ? null
      : projectPolicySchema.parse(JSON.parse(row.policy_json)),
    environmentId: row.environment_id,
    implementationThreadId: row.implementation_thread_id,
    reviewThreadId: row.review_thread_id,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    prHeadSha: row.pr_head_sha,
    statusMessageId: row.status_message_id,
    reviewCycle: row.review_cycle,
    reviewBlockAt: row.review_block_at,
    cancelRequestedAt: row.cancel_requested_at,
    blockedReason: row.blocked_reason,
    lastError: row.last_error,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseEffect(row: EffectRow): StoredEffect {
  return {
    idempotencyKey: row.idempotency_key,
    jobId: row.job_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function persistJobTransition(
  db: SqliteDatabase,
  jobId: string,
  expectedVersion: number,
  transitionedJob: Job,
): void {
  const updated = db
    .prepare(
      `UPDATE jobs SET
         request_text = ?, state = ?, resume_state = ?, project_id = ?,
         policy_version = ?, policy_json = ?, environment_id = ?,
         implementation_thread_id = ?, review_thread_id = ?, pr_number = ?,
         pr_url = ?, pr_head_sha = ?, status_message_id = ?, review_cycle = ?,
         review_block_at = ?, cancel_requested_at = ?, blocked_reason = ?,
         last_error = ?, version = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .run(
      transitionedJob.requestText,
      transitionedJob.state,
      transitionedJob.resumeState,
      transitionedJob.projectId,
      transitionedJob.policyVersion,
      transitionedJob.policy ? JSON.stringify(transitionedJob.policy) : null,
      transitionedJob.environmentId,
      transitionedJob.implementationThreadId,
      transitionedJob.reviewThreadId,
      transitionedJob.prNumber,
      transitionedJob.prUrl,
      transitionedJob.prHeadSha,
      transitionedJob.statusMessageId,
      transitionedJob.reviewCycle,
      transitionedJob.reviewBlockAt,
      transitionedJob.cancelRequestedAt,
      transitionedJob.blockedReason,
      transitionedJob.lastError,
      transitionedJob.version,
      transitionedJob.updatedAt,
      jobId,
      expectedVersion,
    );
  if (updated.changes !== 1) throw new VersionConflictError(jobId, expectedVersion);
}

function persistPendingEffects(
  db: SqliteDatabase,
  effects: JobEffect[],
  now: number,
): void {
  const insertEffect = db.prepare(
    `INSERT OR IGNORE INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  );
  for (const effect of effects) {
    insertEffect.run(
      effect.idempotencyKey,
      effect.jobId,
      effect.kind,
      JSON.stringify(effect.payload),
      now,
      now,
      now,
    );
  }
}

const JOB_SELECT = `
  SELECT id, source_update_id, request_text, state, resume_state, project_id,
         policy_version, policy_json, environment_id, implementation_thread_id,
         review_thread_id, pr_number, pr_url, pr_head_sha, status_message_id,
         review_cycle, review_block_at, cancel_requested_at, blocked_reason,
         last_error, version, created_at, updated_at
    FROM jobs`;

function advanceTelegramCursor(db: SqliteDatabase): void {
  const cursor = db
    .prepare("SELECT next_offset FROM telegram_cursor WHERE singleton = 1")
    .get() as { next_offset: number } | undefined;
  if (!cursor) throw new Error("Telegram cursor was not initialized");

  const firstUnprocessed = db
    .prepare(
      "SELECT MIN(update_id) AS update_id FROM telegram_updates WHERE update_id >= ? AND status <> 'processed'",
    )
    .get(cursor.next_offset) as { update_id: number | null };
  const highest = db
    .prepare(
      "SELECT MAX(update_id) AS update_id FROM telegram_updates WHERE update_id >= ? AND status = 'processed'",
    )
    .get(cursor.next_offset) as { update_id: number | null };

  const nextOffset =
    firstUnprocessed.update_id ??
    (highest.update_id === null ? null : highest.update_id + 1);
  if (nextOffset === null || nextOffset <= cursor.next_offset) return;
  db
    .prepare(
      `UPDATE telegram_cursor
          SET next_offset = CASE WHEN next_offset < ? THEN ? ELSE next_offset END
        WHERE singleton = 1`,
    )
    .run(nextOffset, nextOffset);
}

class SqliteTelegramAgentStore implements TelegramAgentStore {
  private readonly claimOwner = randomUUID();
  private readonly claimedUpdates = new Map<number, number>();

  public constructor(
    private readonly db: SqliteDatabase,
    private readonly kv: PluginKv,
  ) {}

  public createPairingCode(
    codeHash: string,
    createdAt: number,
    expiresAt: number,
  ): void {
    assertSha256Hex(codeHash);
    this.db
      .prepare(
        "INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)",
      )
      .run(codeHash, createdAt, expiresAt);
  }

  public pairOwnerWithCode(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
  ): PairingResult {
    return this.pairOwnerWithCodeInternal(codeHash, userId, chatId, now, true);
  }

  public pairOwnerWithPrivateChatCode(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
  ): PairingResult {
    return this.pairOwnerWithCodeInternal(codeHash, userId, chatId, now, false);
  }

  private pairOwnerWithCodeInternal(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
    requireMatchingIdentity: boolean,
  ): PairingResult {
    assertSha256Hex(codeHash);
    assertCanonicalPositiveDecimal(userId, "userId");
    assertCanonicalPositiveDecimal(chatId, "chatId");
    if (requireMatchingIdentity && userId !== chatId) {
      throw new TypeError("V1 owner pairing requires userId to equal chatId for a private chat");
    }

    const pair = this.db.transaction((): PairingResult => {
      const code = this.db
        .prepare(
          "SELECT consumed_at, expires_at FROM pairing_codes WHERE code_hash = ?",
        )
        .get(codeHash) as PairingCodeRow | undefined;

      if (!code) return { ok: false, reason: "missing" };
      if (code.consumed_at !== null) return { ok: false, reason: "consumed" };
      if (now >= code.expires_at) return { ok: false, reason: "expired" };

      const owner = this.db
        .prepare(
          "SELECT telegram_user_id, telegram_chat_id, paired_at FROM owners WHERE singleton = 1 AND revoked_at IS NULL",
        )
        .get() as OwnerRow | undefined;
      if (owner) return { ok: false, reason: "already_paired" };

      const consumed = this.db
        .prepare(
          "UPDATE pairing_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?",
        )
        .run(now, codeHash, now);
      if (consumed.changes !== 1) {
        return { ok: false, reason: "consumed" };
      }

      this.db
        .prepare(
          `INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at)
           VALUES (1, ?, ?, ?, NULL)
           ON CONFLICT(singleton) DO UPDATE SET
             telegram_user_id = excluded.telegram_user_id,
             telegram_chat_id = excluded.telegram_chat_id,
             paired_at = excluded.paired_at,
             revoked_at = NULL`,
        )
        .run(userId, chatId, now);

      return { ok: true };
    });

    return pair();
  }

  public getOwner(): Owner | null {
    const row = this.db
      .prepare(
        "SELECT telegram_user_id, telegram_chat_id, paired_at FROM owners WHERE singleton = 1 AND revoked_at IS NULL",
      )
      .get() as OwnerRow | undefined;
    if (!row) return null;
    return {
      userId: row.telegram_user_id,
      chatId: row.telegram_chat_id,
      pairedAt: row.paired_at,
    };
  }

  public revokeOwner(now: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE owners SET revoked_at = ? WHERE singleton = 1 AND revoked_at IS NULL",
      )
      .run(now);
    return result.changes === 1;
  }

  public bindTelegramIdentity(input: {
    botId: string;
    username: string;
    now: number;
    hasActiveJob: boolean;
  }): "created" | "same" | "changed" | "active_job_conflict" {
    assertCanonicalPositiveDecimal(input.botId, "botId");

    const bind = this.db.transaction((): "created" | "same" | "changed" | "active_job_conflict" => {
      const current = this.db
        .prepare(
          "SELECT bot_id, username, verified_at FROM telegram_identity WHERE singleton = 1",
        )
        .get() as TelegramIdentityRow | undefined;

      if (!current) {
        if (input.hasActiveJob || this.hasActiveJob()) return "active_job_conflict";
        this.db
          .prepare(
            "INSERT INTO telegram_identity (singleton, bot_id, username, verified_at) VALUES (1, ?, ?, ?)",
          )
          .run(input.botId, input.username, input.now);
        return "created";
      }

      if (current.bot_id === input.botId) {
        this.db
          .prepare(
            "UPDATE telegram_identity SET username = ?, verified_at = ? WHERE singleton = 1",
          )
          .run(input.username, input.now);
        return "same";
      }

      if (input.hasActiveJob || this.hasActiveJob()) return "active_job_conflict";

      this.db
        .prepare(
          "UPDATE owners SET revoked_at = ? WHERE singleton = 1 AND revoked_at IS NULL",
        )
        .run(input.now);
      this.db.prepare("DELETE FROM pairing_codes").run();
      this.db.prepare("DELETE FROM approvals").run();
      this.db.prepare("DELETE FROM telegram_updates").run();
      this.db.prepare("DELETE FROM callbacks").run();
      this.db.prepare("DELETE FROM outbox").run();
      this.db
        .prepare("UPDATE telegram_cursor SET next_offset = 0 WHERE singleton = 1")
        .run();
      this.db
        .prepare(
          "UPDATE telegram_identity SET bot_id = ?, username = ?, verified_at = ? WHERE singleton = 1",
        )
        .run(input.botId, input.username, input.now);

      return "changed";
    });
    return bind();
  }

  private hasActiveJob(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM jobs WHERE state NOT IN ('merged', 'cancelled', 'blocked') LIMIT 1",
        )
        .get() !== undefined
    );
  }

  public getTelegramIdentity(): TelegramIdentity | null {
    const row = this.db
      .prepare(
        "SELECT bot_id, username, verified_at FROM telegram_identity WHERE singleton = 1",
      )
      .get() as TelegramIdentityRow | undefined;
    if (!row) return null;
    return {
      botId: row.bot_id,
      username: row.username,
      verifiedAt: row.verified_at,
    };
  }

  public upsertProjectPolicy(
    policy: ProjectPolicy,
    now: number,
  ): ProjectPolicyRecord {
    const validated = projectPolicySchema.parse(policy);
    this.db
      .prepare(
        `INSERT INTO project_policies (
           project_id, alias, enabled, policy_json, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           alias = excluded.alias,
           enabled = excluded.enabled,
           policy_json = excluded.policy_json,
           version = project_policies.version + 1,
           updated_at = excluded.updated_at`,
      )
      .run(
        validated.projectId,
        validated.alias,
        validated.enabled ? 1 : 0,
        JSON.stringify(validated),
        now,
        now,
      );

    const stored = this.getProjectPolicy(validated.projectId);
    if (!stored) throw new Error("Project policy was not stored");
    return stored;
  }

  public getProjectPolicy(projectId: string): ProjectPolicyRecord | null {
    const row = this.db
      .prepare(
        "SELECT policy_json, version FROM project_policies WHERE project_id = ?",
      )
      .get(projectId) as ProjectPolicyRow | undefined;
    return row ? parsePolicy(row) : null;
  }

  public getProjectPolicyByAlias(alias: string): ProjectPolicyRecord | null {
    const row = this.db
      .prepare(
        "SELECT policy_json, version FROM project_policies WHERE alias = ?",
      )
      .get(alias) as ProjectPolicyRow | undefined;
    return row ? parsePolicy(row) : null;
  }

  public listEnabledProjectPolicies(): ProjectPolicyRecord[] {
    const rows = this.db
      .prepare(
        "SELECT policy_json, version FROM project_policies WHERE enabled = 1 ORDER BY alias",
      )
      .all() as ProjectPolicyRow[];
    return rows.map(parsePolicy);
  }

  public createJob(input: {
    id: string;
    sourceUpdateId: number;
    requestText: string;
    now: number;
  }): Job {
    if (!input.id || !input.requestText) throw new TypeError("Job id and request text are required");
    if (!Number.isInteger(input.sourceUpdateId) || input.sourceUpdateId < 0) {
      throw new TypeError("sourceUpdateId must be a non-negative integer");
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (
           id, source_update_id, request_text, state, review_cycle,
           review_block_at, version, created_at, updated_at
         ) VALUES (?, ?, ?, 'awaiting_project', 0, 3, 1, ?, ?)`,
      )
      .run(input.id, input.sourceUpdateId, input.requestText, input.now, input.now);

    const byId = this.readJobById(input.id);
    const existing = byId ?? this.readJobBySourceUpdate(input.sourceUpdateId);
    if (!existing) throw new Error("Job was not stored");
    if (
      existing.sourceUpdateId !== input.sourceUpdateId ||
      existing.requestText !== input.requestText
    ) {
      throw new IdempotencyConflictError(input.sourceUpdateId);
    }
    return existing;
  }

  public setJobStatusMessage(
    jobId: string,
    messageId: number,
    expectedVersion: number,
    now: number,
  ): Job {
    if (!jobId) throw new TypeError("jobId must not be empty");
    if (!Number.isInteger(messageId) || messageId < 1) {
      throw new TypeError("messageId must be a positive integer");
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("expectedVersion must be a positive integer");
    }
    const current = this.readJobById(jobId);
    if (!current) throw new Error(`Job ${jobId} was not found`);
    if (current.version !== expectedVersion) throw new VersionConflictError(jobId, expectedVersion);

    const updated = this.db
      .prepare(
        `UPDATE jobs
            SET status_message_id = ?, version = ?, updated_at = ?
          WHERE id = ? AND version = ?`,
      )
      .run(messageId, expectedVersion + 1, now, jobId, expectedVersion);
    if (updated.changes !== 1) throw new VersionConflictError(jobId, expectedVersion);
    const stored = this.readJobById(jobId);
    if (!stored) throw new Error(`Job ${jobId} was not found after status-message update`);
    return stored;
  }

  public enqueueSteeringEffect(
    jobId: string,
    updateId: number,
    threadId: string,
    text: string,
    now: number,
  ): boolean {
    if (!jobId || !threadId) throw new TypeError("jobId and threadId must not be empty");
    if (!Number.isInteger(updateId) || updateId < 0) {
      throw new TypeError("updateId must be a non-negative integer");
    }
    if (typeof text !== "string" || text.length === 0 || text.length > 4_000) {
      throw new TypeError("steering text must be between 1 and 4000 characters");
    }

    const enqueue = this.db.transaction((): boolean => {
      const job = this.readJobById(jobId);
      if (!job || job.implementationThreadId !== threadId || ["merged", "cancelled", "blocked"].includes(job.state)) {
        return false;
      }
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO effects (
             idempotency_key, job_id, kind, payload_json, status, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, 'steer_implementation', ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(
          `${jobId}:telegram:${updateId}:steer_implementation`,
          jobId,
          JSON.stringify({ text, threadId }),
          now,
          now,
          now,
        );
      return result.changes === 1;
    });
    return enqueue();
  }

  public enqueueOutbox(item: OutboxInput, now: number): void {
    if (!item.logicalKey || !item.chatId) throw new TypeError("outbox identity is required");
    if (!Number.isInteger(now) || now < 0) throw new TypeError("now must be a non-negative integer");
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(item.payload);
    } catch {
      throw new TypeError("outbox payload must be JSON serializable");
    }
    if (payloadJson === undefined) throw new TypeError("outbox payload must be JSON serializable");
    if (item.messageId !== undefined && item.messageId !== null && (!Number.isInteger(item.messageId) || item.messageId < 1)) {
      throw new TypeError("outbox messageId must be a positive integer");
    }

    this.db
      .prepare(
        `INSERT INTO outbox (
           logical_key, chat_id, message_id, payload_json, status, attempts,
           next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
         ON CONFLICT(logical_key) DO UPDATE SET
           chat_id = excluded.chat_id,
           message_id = excluded.message_id,
           payload_json = excluded.payload_json,
           status = 'pending',
           next_attempt_at = excluded.next_attempt_at,
           last_error = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        item.logicalKey,
        item.chatId,
        item.messageId ?? null,
        payloadJson,
        now,
        now,
        now,
      );
  }

  public async setLastProject(projectId: string): Promise<void> {
    if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 200) {
      throw new TypeError("projectId must be a bounded non-empty string");
    }
    await this.kv.set(LAST_PROJECT_KEY, projectId);
  }

  public async getLastProject(): Promise<string | null> {
    const value = await this.kv.get<unknown>(LAST_PROJECT_KEY);
    return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
  }

  public getJob(jobId: string): Job | null {
    return this.readJobById(jobId);
  }

  public getActiveJob(): Job | null {
    const row = this.db
      .prepare(`${JOB_SELECT} WHERE state NOT IN ('merged', 'cancelled', 'blocked') ORDER BY updated_at DESC, id DESC LIMIT 1`)
      .get() as JobRow | undefined;
    return row ? parseJob(row) : null;
  }

  public findJobByThreadId(threadId: string): Job | null {
    const row = this.db
      .prepare(`${JOB_SELECT} WHERE implementation_thread_id = ? OR review_thread_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(threadId, threadId) as JobRow | undefined;
    return row ? parseJob(row) : null;
  }

  public listJobs(limit: number): Job[] {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
    const rows = this.db
      .prepare(`${JOB_SELECT} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(limit) as JobRow[];
    return rows.map(parseJob);
  }

  public applyJobEvent(
    jobId: string,
    expectedVersion: number,
    event: JobEvent,
    now: number,
  ): Job {
    const apply = this.db.transaction((): Job => {
      const current = this.readJobById(jobId);
      if (!current) throw new Error(`Job ${jobId} was not found`);
      if (current.version !== expectedVersion) throw new VersionConflictError(jobId, expectedVersion);
      if (current.state === "blocked" && event.type === "CONTINUE_REVIEW" && this.hasActiveJobExcluding(jobId)) {
        throw new ActiveJobConflictError(jobId);
      }

      const transitioned = transition(current, event, now);
      persistJobTransition(this.db, jobId, expectedVersion, transitioned.job);
      persistPendingEffects(this.db, transitioned.effects, now);
      return transitioned.job;
    });
    return apply();
  }

  public listEffectsForJob(jobId: string): StoredEffect[] {
    const rows = this.db
      .prepare("SELECT * FROM effects WHERE job_id = ? ORDER BY created_at ASC, idempotency_key ASC")
      .all(jobId) as EffectRow[];
    return rows.map(parseEffect);
  }

  public beginTelegramUpdate(updateId: number, now: number): "process" | "processed" {
    if (!Number.isInteger(updateId) || updateId < 0) throw new TypeError("updateId must be a non-negative integer");
    const begin = this.db.transaction((): "process" | "processed" => {
      const existing = this.db
        .prepare(
          "SELECT status, claim_owner, claim_generation, claim_expires_at FROM telegram_updates WHERE update_id = ?",
        )
        .get(updateId) as TelegramUpdateRow | undefined;
      if (existing?.status === "processed") return "processed";

      // Sequential ingress keeps this store's claimed handler in flight; tokenless
      // completion cannot safely distinguish a same-store reclaim from that handler.
      if (this.claimedUpdates.has(updateId)) return "processed";

      if (
        existing?.status === "processing" &&
        existing.claim_expires_at !== null &&
        existing.claim_expires_at > now
      ) {
        return "processed";
      }

      const generation = (existing?.claim_generation ?? 0) + 1;
      const expiresAt = now + TELEGRAM_UPDATE_LEASE_MS;
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO telegram_updates (
               update_id, status, attempts, outcome, last_error, processed_at,
               claim_owner, claim_generation, claim_expires_at
             ) VALUES (?, 'processing', 1, NULL, NULL, NULL, ?, ?, ?)`,
          )
          .run(updateId, this.claimOwner, generation, expiresAt);
      } else {
        this.db
          .prepare(
            `UPDATE telegram_updates
                SET status = 'processing', attempts = attempts + 1,
                    outcome = NULL, last_error = NULL, processed_at = NULL,
                    claim_owner = ?, claim_generation = ?, claim_expires_at = ?
              WHERE update_id = ?`,
          )
          .run(this.claimOwner, generation, expiresAt, updateId);
      }
      this.claimedUpdates.set(updateId, generation);
      return "process";
    });
    return begin();
  }

  public completeTelegramUpdate(updateId: number, outcome: string, now: number): void {
    assertSafeFailureSummary(outcome);
    const claimGeneration = this.claimedUpdates.get(updateId);
    if (claimGeneration === undefined) throw new UpdateClaimConflictError(updateId);

    const complete = this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE telegram_updates
              SET status = 'processed', outcome = ?, last_error = NULL, processed_at = ?,
                  claim_owner = NULL, claim_expires_at = NULL
            WHERE update_id = ?
              AND status = 'processing'
              AND claim_owner = ?
              AND claim_generation = ?
              AND claim_expires_at > ?`,
        )
        .run(outcome, now, updateId, this.claimOwner, claimGeneration, now);
      if (updated.changes !== 1) {
        this.claimedUpdates.delete(updateId);
        throw new UpdateClaimConflictError(updateId);
      }
      advanceTelegramCursor(this.db);
    });
    complete();
    this.claimedUpdates.delete(updateId);
  }

  public failTelegramUpdate(updateId: number, error: string, now: number): void {
    assertSafeFailureSummary(error);
    const claimGeneration = this.claimedUpdates.get(updateId);
    if (claimGeneration === undefined) throw new UpdateClaimConflictError(updateId);

    const fail = this.db.transaction(() => {
      const failed = this.db
        .prepare(
          `UPDATE telegram_updates
              SET status = 'failed', outcome = NULL, last_error = ?, processed_at = ?,
                  claim_owner = NULL, claim_expires_at = NULL
            WHERE update_id = ?
              AND status = 'processing'
              AND claim_owner = ?
              AND claim_generation = ?
              AND claim_expires_at > ?`,
        )
        .run(error, now, updateId, this.claimOwner, claimGeneration, now);
      if (failed.changes !== 1) {
        this.claimedUpdates.delete(updateId);
        throw new UpdateClaimConflictError(updateId);
      }
    });
    fail();
    this.claimedUpdates.delete(updateId);
  }

  public getNextTelegramOffset(): number {
    const row = this.db
      .prepare("SELECT next_offset FROM telegram_cursor WHERE singleton = 1")
      .get() as { next_offset: number } | undefined;
    if (!row) throw new Error("Telegram cursor was not initialized");
    return row.next_offset;
  }

  public recordCallback(
    callbackId: string,
    jobId: string | null,
    action: string,
    outcome: string,
    now: number,
  ): boolean {
    if (!callbackId || !action || !outcome) throw new TypeError("Callback identity and outcome are required");
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO callbacks (
           callback_query_id, job_id, action, outcome, processed_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(callbackId, jobId, action, outcome, now);
    return result.changes === 1;
  }

  public enqueueReconcileForThread(threadId: string, now: number): boolean {
    if (!threadId) throw new TypeError("threadId must not be empty");
    const enqueue = this.db.transaction((): boolean => {
      const job = this.db
        .prepare(`${JOB_SELECT} WHERE implementation_thread_id = ? OR review_thread_id = ? ORDER BY updated_at DESC LIMIT 1`)
        .get(threadId, threadId) as JobRow | undefined;
      if (!job) return false;
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO effects (
             idempotency_key, job_id, kind, payload_json, status, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, 'reconcile_job', ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(`reconcile:${job.id}:${threadId}`, job.id, JSON.stringify({ threadId }), now, now, now);
      return result.changes === 1;
    });
    return enqueue();
  }

  private readJobById(jobId: string): Job | null {
    const row = this.db
      .prepare(`${JOB_SELECT} WHERE id = ?`)
      .get(jobId) as JobRow | undefined;
    return row ? parseJob(row) : null;
  }

  private readJobBySourceUpdate(sourceUpdateId: number): Job | null {
    const row = this.db
      .prepare(`${JOB_SELECT} WHERE source_update_id = ?`)
      .get(sourceUpdateId) as JobRow | undefined;
    return row ? parseJob(row) : null;
  }

  private hasActiveJobExcluding(jobId: string): boolean {
    return this.db
      .prepare(
        "SELECT 1 FROM jobs WHERE id <> ? AND state NOT IN ('merged', 'cancelled', 'blocked') LIMIT 1",
      )
      .get(jobId) !== undefined;
  }
}

export function openStore(storage: PluginStorage, kv: PluginKv = storage.kv): TelegramAgentStore {
  const db = storage.database();
  storage.migrate(db, [...ALL_MIGRATIONS]);
  return new SqliteTelegramAgentStore(db, kv);
}
