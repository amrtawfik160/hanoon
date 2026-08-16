import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { ReferenceRepository } from "../src/storage/reference-repository";
import { openStore } from "../src/storage/store";

let fixtureNumber = 0;

const SPEC = `# Billing

Invoices are immutable once issued and a refund is always a new document.

# Access

Only an account owner may delete an account, and deletion is irreversible.

# Search

Results are ranked by relevance and capped at twenty per page.`;

function repository(): { repo: ReferenceRepository; db: Database.Database } {
  const { bb } = createFakePluginHost({ pluginId: `telegram-reference-${fixtureNumber++}` });
  const db: Database.Database = bb.storage.database();
  openStore(bb.storage, bb.storage.kv, () => 2_000);
  return { repo: new ReferenceRepository(db), db };
}

function save(repo: ReferenceRepository, markdown: string, overrides: Record<string, unknown> = {}) {
  return repo.saveReferenceDocument({
    scope: "project",
    projectId: "proj_1",
    title: "Product spec",
    source: "telegram:doc_1",
    markdown,
    now: 2_000,
    ...overrides,
  });
}

it("ships exact section digests as the newest append-only migration", () => {
  expect(ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1]).toContain("CREATE TABLE reference_section_digests");
});

it("stores a document as a map plus retrievable passages", () => {
  const { repo } = repository();

  const saved = save(repo, SPEC);

  expect(saved.document.version).toBe(1);
  expect(saved.document.scope).toBe("project");
  expect(saved.document.projectId).toBe("proj_1");
  expect(saved.passageCount).toBe(3);
  expect(saved.changes).toEqual([]);
  expect(saved.document.map.map((entry) => entry.path.join(" > ")))
    .toEqual(["Billing", "Access", "Search"]);
});

it("refuses a project reference with no project and a document with no text", () => {
  const { repo } = repository();

  expect(() => save(repo, SPEC, { projectId: null })).toThrow(/project id/);
  expect(() => save(repo, "   ")).toThrow(/no readable text/);
  expect(() => save(repo, SPEC, { title: "  " })).toThrow(/between 1 and 256/);
});

it("finds a passage by the words it contains, within one project", () => {
  const { repo } = repository();
  save(repo, SPEC);

  const hits = repo.searchReferencePassages({ query: "refund", projectId: "proj_1" });

  expect(hits).toHaveLength(1);
  expect(hits[0].sectionPath).toBe("Billing");
  expect(hits[0].body).toContain("a refund is always a new document");
  expect(hits[0].documentTitle).toBe("Product spec");
});

it("never returns another project's specification", () => {
  const { repo } = repository();
  save(repo, SPEC);

  expect(repo.searchReferencePassages({ query: "refund", projectId: "proj_2" })).toEqual([]);
  expect(repo.searchReferencePassages({ query: "refund", projectId: null })).toEqual([]);
});

it("puts the project's own document ahead of a global one", () => {
  const { repo } = repository();
  save(repo, "# Billing\n\nInvoices are immutable and refunds are new documents.");
  save(repo, "# Billing\n\nRefunds follow the company finance policy.", {
    scope: "global",
    projectId: null,
    title: "Company guide",
  });

  const hits = repo.searchReferencePassages({ query: "refunds", projectId: "proj_1" });

  expect(hits).toHaveLength(2);
  expect(hits[0].documentTitle).toBe("Product spec");
  expect(hits[1].documentTitle).toBe("Company guide");
  expect(repo.listReferenceDocuments("proj_1").map((document) => document.title))
    .toEqual(["Product spec", "Company guide"]);
});

it("replaces a newer version instead of keeping both, and says what moved", () => {
  const { repo } = repository();
  save(repo, SPEC);

  const updated = save(repo, `# Billing

Invoices are immutable once issued and a refund is always a new document.

# Access

Any administrator may delete an account, and deletion is reversible for a day.

# Retention

Records are kept for seven years.`, { now: 3_000 });

  expect(updated.document.version).toBe(2);
  expect(updated.changes).toEqual([
    { sectionPath: "Access", change: "changed" },
    { sectionPath: "Retention", change: "added" },
    { sectionPath: "Search", change: "removed" },
  ]);
  // The old wording is gone rather than searchable beside the new one.
  expect(repo.searchReferencePassages({ query: "twenty", projectId: "proj_1" })).toEqual([]);
  expect(repo.searchReferencePassages({ query: "administrator", projectId: "proj_1" })).toHaveLength(1);
  expect(repo.listReferenceDocuments("proj_1")).toHaveLength(1);
  expect(repo.listReferenceChanges(updated.document.id, 2)).toEqual(updated.changes);
});

it("reports no change when only the formatting moved", () => {
  const { repo } = repository();
  save(repo, SPEC);

  const rewrapped = save(repo, SPEC.replace(/\n\n/g, "\n\n\n"), { now: 3_000 });

  expect(rewrapped.document.version).toBe(2);
  expect(rewrapped.changes).toEqual([]);
});

it("reports no phantom changes when nested short sections are ingested identically", () => {
  const { repo } = repository();
  const nested = [
    "# Billing",
    "",
    "A sufficiently long parent section keeps its own passage while child sections remain exact.",
    "",
    "## Refunds",
    "",
    "Short refund rule.",
    "",
    "### Window",
    "",
    "Thirty days.",
  ].join("\n");
  save(repo, nested);

  const repeated = save(repo, nested, { now: 3_000 });

  expect(repeated.document.version).toBe(2);
  expect(repeated.changes).toEqual([]);
});

it("treats title casing as display text, not a second document identity", () => {
  const { repo } = repository();
  const first = save(repo, SPEC, { title: "Product Spec" });

  const second = save(repo, SPEC, { title: "product spec", now: 3_000 });

  expect(second.document.id).toBe(first.document.id);
  expect(second.document.version).toBe(2);
  expect(second.document.title).toBe("product spec");
  expect(repo.listReferenceDocuments("proj_1")).toHaveLength(1);
});

it("fetches one passage by id and explicitly forgets every indexed artifact", () => {
  const { repo, db } = repository();
  const saved = save(repo, SPEC);
  save(repo, SPEC.replace("immutable", "permanent"), { now: 3_000 });
  const hit = repo.searchReferencePassages({ query: "refund", projectId: "proj_1" })[0];

  expect(repo.getReferencePassage(hit.id, "proj_1")?.body).toBe(hit.body);
  expect(repo.getReferencePassage(hit.id, "proj_2")).toBeNull();
  expect(repo.getReferencePassage(hit.id, null)).toBeNull();
  expect(repo.getReferencePassage("nope", "proj_1")).toBeNull();

  expect(repo.deleteReferenceDocument(saved.document.id)).toBe(true);
  expect(repo.deleteReferenceDocument(saved.document.id)).toBe(false);
  expect(repo.searchReferencePassages({ query: "refund", projectId: "proj_1" })).toEqual([]);
  expect(db.prepare("SELECT count(*) AS n FROM reference_passages").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT count(*) AS n FROM reference_passages_fts").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT count(*) AS n FROM reference_section_digests").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT count(*) AS n FROM reference_document_changes").get()).toEqual({ n: 0 });
});

it("returns nothing for a query with no searchable words", () => {
  const { repo } = repository();
  save(repo, SPEC);

  expect(repo.searchReferencePassages({ query: "!!! ?", projectId: "proj_1" })).toEqual([]);
});
