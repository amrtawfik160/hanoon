import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  DEFAULT_INGESTION_SOURCE_STATUS,
  INGESTION_SOURCE_STATUSES,
  MAX_INGESTION_EXCERPT_CHARACTERS,
  type IngestionSource,
  type IngestionSourceStatus,
  type RecordIngestionSourceInput,
} from "../domain/ingestion-source";
import { readIngestionRoute, type IngestionReading } from "../reference/ingestion";

type SqliteDatabase = Database.Database;

type IngestionSourceRow = {
  id: string;
  chat_ref: string;
  project_id: string;
  captured_at: number;
  excerpt: string;
  status: string;
};

function boundedIdentity(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new TypeError(`${label} must be between 1 and 256 characters`);
  }
  return trimmed;
}

function boundedExcerpt(value: string): string {
  if (typeof value !== "string") throw new TypeError("ingestion excerpt must be text");
  const excerpt = value.trim();
  if (excerpt.length === 0 || excerpt.length > MAX_INGESTION_EXCERPT_CHARACTERS) {
    throw new TypeError(
      `ingestion excerpt must be between 1 and ${MAX_INGESTION_EXCERPT_CHARACTERS} characters`,
    );
  }
  return excerpt;
}

function sourceId(chatRef: string, projectId: string): string {
  return createHash("sha256")
    .update(`ingestion:${chatRef}:${projectId}`, "utf8")
    .digest("base64url")
    .slice(0, 24);
}

function toRecord(row: IngestionSourceRow): IngestionSource {
  if (!INGESTION_SOURCE_STATUSES.includes(row.status as IngestionSourceStatus)) {
    throw new TypeError("ingestion source status is not recognized");
  }
  return {
    id: row.id,
    chatRef: row.chat_ref,
    projectId: row.project_id,
    capturedAt: row.captured_at,
    excerpt: row.excerpt,
    status: row.status as IngestionSourceStatus,
  };
}

export class IngestionSourceRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public recordIngestionSource(input: RecordIngestionSourceInput): IngestionSource {
    if (!Number.isInteger(input.now) || input.now < 0) {
      throw new TypeError("captured_at must be a non-negative integer");
    }
    const chatRef = boundedIdentity(input.chatRef, "chat_ref");
    const projectId = boundedIdentity(input.projectId, "project_id");
    const excerpt = boundedExcerpt(input.excerpt);
    const id = sourceId(chatRef, projectId);
    this.db.prepare(
      `INSERT INTO ingestion_source (id, chat_ref, project_id, captured_at, excerpt, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_ref, project_id) DO UPDATE SET
         captured_at = excluded.captured_at,
         excerpt = excluded.excerpt,
         status = excluded.status`,
    ).run(id, chatRef, projectId, input.now, excerpt, DEFAULT_INGESTION_SOURCE_STATUS);
    const row = this.db.prepare("SELECT * FROM ingestion_source WHERE id = ?").get(id) as IngestionSourceRow;
    return toRecord(row);
  }

  public listIngestionSources(projectId: string): readonly IngestionSource[] {
    const id = boundedIdentity(projectId, "project_id");
    const rows = this.db.prepare(
      "SELECT * FROM ingestion_source WHERE project_id = ? ORDER BY captured_at ASC, id ASC",
    ).all(id) as IngestionSourceRow[];
    return rows.map(toRecord);
  }

  public readIngestionRoute(projectId: string): readonly IngestionReading[] {
    return readIngestionRoute(this.listIngestionSources(projectId));
  }
}
