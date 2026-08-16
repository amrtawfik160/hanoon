import Database from "better-sqlite3";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  captureRuntimeIdentity,
  inspectRuntimeIdentity,
  type RuntimeIdentity,
} from "../src/services/runtime-identity";

function identity(overrides: Partial<RuntimeIdentity> = {}): RuntimeIdentity {
  return {
    sourceRoot: "/registered/plugin",
    loadedAt: 1_800_000_000_000,
    loadedFingerprint: "old-build",
    expectedMigrationId: 4,
    currentFingerprint: () => "new-build",
    ...overrides,
  };
}

function migrationDatabase(appliedMigrationId: number): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY)");
  for (let id = 0; id <= appliedMigrationId; id += 1) {
    db.prepare("INSERT INTO _bb_migrations (id) VALUES (?)").run(id);
  }
  return db;
}

it("surfaces a changed activation source and a schema identity mismatch", () => {
  const db = migrationDatabase(2);

  const report = inspectRuntimeIdentity(db, identity());

  expect(report).toMatchObject({
    ok: false,
    sourceRoot: "/registered/plugin",
    loadedFingerprint: "old-build",
    currentFingerprint: "new-build",
    expectedMigrationId: 4,
    appliedMigrationId: 2,
  });
  expect(report.problems).toEqual(expect.arrayContaining([
    "source changed since activation; reload required",
    "database is missing migrations through 4 (applied through 2)",
  ]));
  db.close();
});

it("accepts a matching source and migration identity", () => {
  const db = migrationDatabase(4);

  const report = inspectRuntimeIdentity(db, identity({ currentFingerprint: () => "old-build" }));

  expect(report).toMatchObject({
    ok: true,
    currentFingerprint: "old-build",
    appliedMigrationId: 4,
    problems: [],
  });
  db.close();
});

it("fails closed when the migration identity table is unavailable", () => {
  const db = new Database(":memory:");

  const report = inspectRuntimeIdentity(db, identity({ currentFingerprint: () => "old-build" }));

  expect(report).toMatchObject({
    ok: false,
    appliedMigrationId: null,
    migrationMismatch: true,
  });
  expect(report.problems).toContain("database migration identity unavailable");
  db.close();
});

it("treats a symlinked source tree as an unavailable fingerprint instead of crashing activation", () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-runtime-identity-"));
  const source = join(root, "real-src");
  try {
    writeFileSync(join(root, "package.json"), "{}", "utf8");
    symlinkSync(root, source, "dir");
    symlinkSync(source, join(root, "src"), "dir");

    expect(() => captureRuntimeIdentity(root, 1_000)).not.toThrow();
    const captured = captureRuntimeIdentity(root, 1_000);
    expect(captured.loadedFingerprint).toBeNull();
    expect(captured.currentFingerprint()).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
