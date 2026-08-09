import type { BbPluginApi } from "@bb/plugin-sdk";
import type Database from "better-sqlite3";
import {
  projectPolicySchema,
  type ProjectPolicy,
} from "../domain/models";
import { INITIAL_MIGRATIONS } from "./migrations";

type PluginStorage = BbPluginApi["storage"];
type SqliteDatabase = Database.Database;

type PairingResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing" | "expired" | "consumed" | "already_paired";
    };

type Owner = { userId: string; chatId: string; pairedAt: number };
type TelegramIdentity = {
  botId: string;
  username: string;
  verifiedAt: number;
};
type ProjectPolicyRecord = { policy: ProjectPolicy; version: number };

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

const CANONICAL_POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

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
}

function parsePolicy(row: ProjectPolicyRow): ProjectPolicyRecord {
  return {
    policy: projectPolicySchema.parse(JSON.parse(row.policy_json)),
    version: row.version,
  };
}

class SqliteTelegramAgentStore implements TelegramAgentStore {
  public constructor(private readonly db: SqliteDatabase) {}

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
    assertSha256Hex(codeHash);
    assertCanonicalPositiveDecimal(userId, "userId");
    assertCanonicalPositiveDecimal(chatId, "chatId");
    if (userId !== chatId) {
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
}

export function openStore(storage: PluginStorage): TelegramAgentStore {
  const db = storage.database();
  storage.migrate(db, [...INITIAL_MIGRATIONS]);
  return new SqliteTelegramAgentStore(db);
}
