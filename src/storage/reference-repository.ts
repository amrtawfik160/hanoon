import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  buildReferenceMap,
  buildReferencePassages,
  parseReferenceSections,
  type ReferenceMapEntry,
} from "../reference/document";
import { ftsQuery } from "./memory-ranking";

type SqliteDatabase = Database.Database;

export const REFERENCE_SCOPES = ["global", "project"] as const;
export type ReferenceScope = (typeof REFERENCE_SCOPES)[number];

/** How many passages one search returns; more than this is not read, only paid for. */
export const MAX_REFERENCE_SEARCH_RESULTS = 8;

const PATH_SEPARATOR = " > ";

export type ReferenceDocumentRecord = {
  id: string;
  scope: ReferenceScope;
  projectId: string | null;
  title: string;
  source: string;
  version: number;
  map: readonly ReferenceMapEntry[];
  ingestedAt: number;
};

export type ReferencePassageRecord = {
  id: string;
  documentId: string;
  documentTitle: string;
  ordinal: string;
  sectionPath: string;
  body: string;
};

export type ReferenceSectionChange = {
  sectionPath: string;
  change: "added" | "removed" | "changed";
};

export type SaveReferenceDocumentInput = {
  scope: ReferenceScope;
  projectId?: string | null;
  title: string;
  source: string;
  markdown: string;
  now: number;
};

export type SaveReferenceDocumentResult = {
  document: ReferenceDocumentRecord;
  passageCount: number;
  /** Empty on a first ingest; the sections that moved on every one after. */
  changes: readonly ReferenceSectionChange[];
};

type DocumentRow = {
  id: string;
  scope: string;
  project_id: string | null;
  title: string;
  source: string;
  version: number;
  map_json: string;
  ingested_at: number;
};

type PassageRow = {
  id: string;
  document_id: string;
  title: string;
  ordinal: string;
  section_path: string;
  body: string;
};

function identityTitle(title: string): string {
  return title.normalize("NFKC").toLocaleLowerCase("en-US");
}

function documentId(scope: ReferenceScope, projectId: string | null, title: string): string {
  return createHash("sha256")
    .update(`reference:${scope}:${projectId ?? ""}:${identityTitle(title)}`, "utf8")
    .digest("base64url")
    .slice(0, 24);
}

function passageId(document: string, ordinal: string): string {
  return `${document}:${ordinal}`;
}

function toRecord(row: DocumentRow): ReferenceDocumentRecord {
  return {
    id: row.id,
    scope: row.scope as ReferenceScope,
    projectId: row.project_id,
    title: row.title,
    source: row.source,
    version: row.version,
    map: JSON.parse(row.map_json) as ReferenceMapEntry[],
    ingestedAt: row.ingested_at,
  };
}

function toPassage(row: PassageRow): ReferencePassageRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    documentTitle: row.title,
    ordinal: row.ordinal,
    sectionPath: row.section_path,
    body: row.body,
  };
}

/**
 * A digest per section, so a new version can say which parts moved without
 * keeping the old text. Keeping the old text would mean two live copies of one
 * specification, and retrieval would happily quote the dead one.
 */
function sectionDigests(markdown: string): Map<string, string> {
  const bodies = new Map<string, string[]>();
  for (const section of parseReferenceSections(markdown)) {
    const path = section.path.length === 0 ? "(document preface)" : section.path.join(PATH_SEPARATOR);
    const existing = bodies.get(path);
    if (existing) existing.push(section.body);
    else bodies.set(path, [section.body]);
  }
  const digests = new Map<string, string>();
  for (const [path, sectionBodies] of bodies) {
    digests.set(
      path,
      createHash("sha256").update(sectionBodies.join("\n\n"), "utf8").digest("hex").slice(0, 16),
    );
  }
  return digests;
}

export class ReferenceRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  /**
   * Replace whatever was under this title with what was just sent. A newer
   * version supersedes rather than joins: two live versions of one
   * specification is the failure mode where nothing looks wrong and the agent
   * quotes a requirement that was deleted a month ago.
   */
  public saveReferenceDocument(input: SaveReferenceDocumentInput): SaveReferenceDocumentResult {
    const scope = input.scope;
    const projectId = scope === "project" ? input.projectId ?? null : null;
    if (scope === "project" && projectId === null) {
      throw new TypeError("a project reference needs a project id");
    }
    const title = input.title.replace(/\s+/g, " ").trim();
    if (title.length === 0 || title.length > 256) {
      throw new TypeError("reference title must be between 1 and 256 characters");
    }
    const sections = parseReferenceSections(input.markdown);
    const passages = buildReferencePassages(sections);
    if (passages.length === 0) throw new TypeError("reference document has no readable text");

    const candidateId = documentId(scope, projectId, title);
    const map = buildReferenceMap(sections);
    const nextDigests = sectionDigests(input.markdown);

    return this.db.transaction((): SaveReferenceDocumentResult => {
      const identity = identityTitle(title);
      const identityRows = (projectId === null
        ? this.db.prepare("SELECT * FROM reference_documents WHERE scope = ? AND project_id IS NULL").all(scope)
        : this.db.prepare("SELECT * FROM reference_documents WHERE scope = ? AND project_id = ?").all(scope, projectId)
      ) as DocumentRow[];
      const matches = identityRows.filter((row) => identityTitle(row.title) === identity);
      if (matches.length > 1) throw new TypeError("reference document identity is ambiguous");
      const existing = matches[0];
      const id = existing?.id ?? candidateId;
      const version = existing ? existing.version + 1 : 1;
      const changes = existing ? this.changesAgainst(id, nextDigests) : [];

      if (existing) {
        this.db.prepare("DELETE FROM reference_passages WHERE document_id = ?").run(id);
        this.db.prepare(
          "UPDATE reference_documents SET title = ?, source = ?, version = ?, map_json = ?, ingested_at = ? WHERE id = ?",
        ).run(title, input.source, version, JSON.stringify(map), input.now, id);
      } else {
        this.db.prepare(
          `INSERT INTO reference_documents (id, scope, project_id, title, source, version, map_json, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, scope, projectId, title, input.source, version, JSON.stringify(map), input.now);
      }

      const insert = this.db.prepare(
        "INSERT INTO reference_passages (id, document_id, ordinal, section_path, body) VALUES (?, ?, ?, ?, ?)",
      );
      for (const passage of passages) {
        insert.run(
          passageId(id, passage.ordinal),
          id,
          passage.ordinal,
          passage.path.join(PATH_SEPARATOR),
          passage.body,
        );
      }

      this.db.prepare("DELETE FROM reference_section_digests WHERE document_id = ?").run(id);
      const insertDigest = this.db.prepare(
        "INSERT INTO reference_section_digests (document_id, section_path, digest) VALUES (?, ?, ?)",
      );
      for (const [path, digest] of nextDigests) insertDigest.run(id, path, digest);

      const recordChange = this.db.prepare(
        `INSERT INTO reference_document_changes (document_id, version, section_path, change, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const change of changes) {
        recordChange.run(id, version, change.sectionPath, change.change, input.now);
      }

      const row = this.db.prepare("SELECT * FROM reference_documents WHERE id = ?").get(id) as DocumentRow;
      return { document: toRecord(row), passageCount: passages.length, changes };
    })();
  }

  /**
   * Which exact source sections moved. An installation upgraded from the first
   * reference schema has no baseline, so its first replacement seeds one and
   * makes no historical claim it cannot prove.
   */
  private changesAgainst(id: string, next: Map<string, string>): readonly ReferenceSectionChange[] {
    const rows = this.db.prepare(
      "SELECT section_path, digest FROM reference_section_digests WHERE document_id = ?",
    ).all(id) as Array<{ section_path: string; digest: string }>;
    if (rows.length === 0) return [];
    const previous = new Map(rows.map((row) => [row.section_path, row.digest]));
    const changes: ReferenceSectionChange[] = [];
    for (const path of previous.keys()) {
      if (!next.has(path)) changes.push({ sectionPath: path, change: "removed" });
    }
    for (const path of next.keys()) {
      if (!previous.has(path)) changes.push({ sectionPath: path, change: "added" });
    }
    for (const [path, digest] of previous) {
      if (!next.has(path)) continue;
      if (digest !== next.get(path)) changes.push({ sectionPath: path, change: "changed" });
    }
    return changes.sort((left, right) => left.sectionPath.localeCompare(right.sectionPath));
  }

  /**
   * Everything in scope for this project: its own references plus the global
   * ones. Ordered project-first so a caller taking the first hit takes the more
   * specific document, which is the rule a specification differing from a
   * general guide should follow.
   */
  public listReferenceDocuments(projectId: string | null): readonly ReferenceDocumentRecord[] {
    const rows = projectId === null
      ? this.db.prepare("SELECT * FROM reference_documents WHERE scope = 'global' ORDER BY title")
        .all() as DocumentRow[]
      : this.db.prepare(
        `SELECT * FROM reference_documents
          WHERE (scope = 'project' AND project_id = ?) OR scope = 'global'
          ORDER BY scope = 'global', title`,
      ).all(projectId) as DocumentRow[];
    return rows.map(toRecord);
  }

  public getReferencePassage(id: string, projectId: string | null): ReferencePassageRecord | null {
    const scoped = projectId === null
      ? "d.scope = 'global'"
      : "((d.scope = 'project' AND d.project_id = ?) OR d.scope = 'global')";
    const parameters: unknown[] = [id];
    if (projectId !== null) parameters.push(projectId);
    const row = this.db.prepare(
      `SELECT p.*, d.title AS title FROM reference_passages p
         JOIN reference_documents d ON d.id = p.document_id
        WHERE p.id = ? AND ${scoped}`,
    ).get(...parameters) as PassageRow | undefined;
    return row ? toPassage(row) : null;
  }

  /**
   * Ranked passages from everything in scope. Lexical only: a specification is
   * searched with its own vocabulary far more often than with a paraphrase of
   * it, and an embedding pass over 300 pages costs real time on every ingest
   * for a gain this has not yet had to prove.
   */
  public searchReferencePassages(input: {
    query: string;
    projectId: string | null;
    limit?: number;
  }): readonly ReferencePassageRecord[] {
    const match = ftsQuery(input.query);
    if (match === null) return [];
    const limit = Math.min(Math.max(1, input.limit ?? MAX_REFERENCE_SEARCH_RESULTS), MAX_REFERENCE_SEARCH_RESULTS);
    const scoped = input.projectId === null
      ? "d.scope = 'global'"
      : "((d.scope = 'project' AND d.project_id = ?) OR d.scope = 'global')";
    const parameters: unknown[] = [match];
    if (input.projectId !== null) parameters.push(input.projectId);
    parameters.push(limit);
    const rows = this.db.prepare(
      `SELECT p.*, d.title AS title FROM reference_passages_fts
         JOIN reference_passages p ON p.rowid = reference_passages_fts.rowid
         JOIN reference_documents d ON d.id = p.document_id
        WHERE reference_passages_fts MATCH ?
          AND ${scoped}
        ORDER BY d.scope = 'global', bm25(reference_passages_fts, 2.0, 1.0)
        LIMIT ?`,
    ).all(...parameters) as PassageRow[];
    return rows.map(toPassage);
  }

  public listReferenceChanges(documentId: string, version: number): readonly ReferenceSectionChange[] {
    const rows = this.db.prepare(
      "SELECT section_path, change FROM reference_document_changes WHERE document_id = ? AND version = ? ORDER BY section_path",
    ).all(documentId, version) as Array<{ section_path: string; change: string }>;
    return rows.map((row) => ({
      sectionPath: row.section_path,
      change: row.change as ReferenceSectionChange["change"],
    }));
  }

  public deleteReferenceDocument(id: string): boolean {
    return this.db.transaction((): boolean => {
      const exists = this.db.prepare("SELECT 1 FROM reference_documents WHERE id = ?").get(id);
      if (!exists) return false;
      this.db.prepare("DELETE FROM reference_document_changes WHERE document_id = ?").run(id);
      this.db.prepare("DELETE FROM reference_section_digests WHERE document_id = ?").run(id);
      this.db.prepare("DELETE FROM reference_passages WHERE document_id = ?").run(id);
      return this.db.prepare("DELETE FROM reference_documents WHERE id = ?").run(id).changes > 0;
    })();
  }
}
