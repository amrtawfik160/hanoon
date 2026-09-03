import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { openStore } from "../src/storage/store";

let fixtureNumber = 0;
const NOW = 1_800_000_000_000;
// The store applies this many statements before its first data repair step.
const FIRST_PREFIX_LENGTH = 29;

function hashOf(statement: string): string {
  return createHash("sha256").update(statement).digest("hex");
}

function ledger(db: ReturnType<ReturnType<typeof createFakePluginHost>["bb"]["storage"]["database"]>) {
  return db.prepare("SELECT id, statement_hash FROM _bb_migrations ORDER BY id").all() as Array<{
    id: number;
    statement_hash: string | null;
  }>;
}

function installedDatabase(label: string) {
  const { bb } = createFakePluginHost({ pluginId: `migration-ledger-${label}-${fixtureNumber++}` });
  openStore(bb.storage, bb.storage.kv, () => NOW);
  const db = bb.storage.database();
  expect(ledger(db)).toHaveLength(ALL_MIGRATIONS.length);
  return { bb, db };
}

// A BB host older than hash tracking left every applied row without a hash.
function forgetRecordedHashes(db: ReturnType<typeof installedDatabase>["db"]) {
  db.prepare("UPDATE _bb_migrations SET statement_hash = NULL").run();
}

it("reopens a database migrated before BB recorded statement hashes", () => {
  const { bb, db } = installedDatabase("unhashed");
  forgetRecordedHashes(db);

  expect(() => openStore(bb.storage, bb.storage.kv, () => NOW)).not.toThrow();

  expect(ledger(db)).toEqual(ALL_MIGRATIONS.map((statement, id) => ({ id, statement_hash: hashOf(statement) })));
});

// 2026-09-02 production incident: the host adopted the rows past the first
// prefix as "legacy-unknown", after which the full list could never match.
it("repairs a ledger whose later rows were adopted as legacy-unknown by a prefix migration", () => {
  const { bb, db } = installedDatabase("legacy-unknown");
  forgetRecordedHashes(db);
  bb.storage.migrate(db, ALL_MIGRATIONS.slice(0, FIRST_PREFIX_LENGTH));
  expect(ledger(db).filter((row) => row.statement_hash === "legacy-unknown"))
    .toHaveLength(ALL_MIGRATIONS.length - FIRST_PREFIX_LENGTH);
  expect(() => bb.storage.migrate(db, [...ALL_MIGRATIONS])).toThrow(/migration 29 does not match/);

  expect(() => openStore(bb.storage, bb.storage.kv, () => NOW)).not.toThrow();

  expect(ledger(db)).toEqual(ALL_MIGRATIONS.map((statement, id) => ({ id, statement_hash: hashOf(statement) })));
});

it("never rewrites a recorded hash that already disagrees with the code", () => {
  const { bb, db } = installedDatabase("tampered");
  db.prepare("UPDATE _bb_migrations SET statement_hash = ? WHERE id = ?").run("f".repeat(64), FIRST_PREFIX_LENGTH);

  expect(() => openStore(bb.storage, bb.storage.kv, () => NOW)).toThrow(/migration 29 does not match/);

  expect(ledger(db)[FIRST_PREFIX_LENGTH]).toEqual({ id: FIRST_PREFIX_LENGTH, statement_hash: "f".repeat(64) });
});
