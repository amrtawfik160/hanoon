import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ALL_MIGRATIONS } from "../storage/migrations";

type SqliteDatabase = Database.Database;

const IDENTITY_FILES = ["package.json", "server.ts", "dist/server.js", "dist/server.meta.json"] as const;
const IDENTITY_DIRECTORIES = ["src"] as const;

export const EXPECTED_MIGRATION_ID = Math.max(0, ALL_MIGRATIONS.length - 1);

export type RuntimeIdentity = Readonly<{
  sourceRoot: string;
  loadedAt: number;
  loadedFingerprint: string | null;
  expectedMigrationId: number;
  currentFingerprint: () => string | null;
}>;

export type ActivationHealth = Readonly<{
  sourceRoot: string;
  loadedAt: number;
  loadedFingerprint: string | null;
  currentFingerprint: string | null;
  sourceChanged: boolean;
  expectedMigrationId: number;
  appliedMigrationId: number | null;
  migrationMismatch: boolean;
  ok: boolean;
  problems: readonly string[];
}>;

function fileSystemErrorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

function collectFiles(root: string, relativePath: string, identityFiles: string[]): void {
  const absolutePath = join(root, relativePath);
  let fileStats: ReturnType<typeof lstatSync>;
  try {
    fileStats = lstatSync(absolutePath);
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return;
    throw error;
  }
  if (fileStats.isSymbolicLink()) throw new Error(`symbolic link in runtime identity: ${relativePath}`);
  if (fileStats.isDirectory()) {
    for (const entry of readdirSync(absolutePath).sort()) {
      collectFiles(root, join(relativePath, entry), identityFiles);
    }
    return;
  }
  if (fileStats.isFile()) identityFiles.push(relativePath.split(sep).join("/"));
}

function fingerprintPluginSource(sourceRoot: string): string | null {
  try {
    const identityFiles: string[] = [];
    for (const relativePath of IDENTITY_FILES) collectFiles(sourceRoot, relativePath, identityFiles);
    for (const relativePath of IDENTITY_DIRECTORIES) collectFiles(sourceRoot, relativePath, identityFiles);
    if (identityFiles.length === 0) return null;

    const hash = createHash("sha256");
    for (const relativePath of identityFiles.sort()) {
      hash.update(relativePath, "utf8");
      hash.update("\0", "utf8");
      hash.update(readFileSync(join(sourceRoot, relativePath)));
      hash.update("\0", "utf8");
    }
    return hash.digest("hex");
  } catch (error) {
    if (fileSystemErrorCode(error) !== null) return null;
    throw error;
  }
}

export function captureRuntimeIdentity(pluginRoot: string, loadedAt: number): RuntimeIdentity {
  const sourceRoot = resolve(pluginRoot);
  return Object.freeze({
    sourceRoot,
    loadedAt,
    loadedFingerprint: fingerprintPluginSource(sourceRoot),
    expectedMigrationId: EXPECTED_MIGRATION_ID,
    currentFingerprint: () => fingerprintPluginSource(sourceRoot),
  });
}

export function appliedMigrationId(db: SqliteDatabase): number | null {
  try {
    const migrationRow = db.prepare("SELECT MAX(id) AS id FROM _bb_migrations").get() as { id: number | null } | undefined;
    return typeof migrationRow?.id === "number" ? migrationRow.id : 0;
  } catch (error) {
    if (error instanceof Error && error.name === "SqliteError") return null;
    throw error;
  }
}

function sourceActivationProblem(
  identity: RuntimeIdentity,
  currentFingerprint: string | null,
  sourceChanged: boolean,
): string | null {
  if (identity.loadedFingerprint === null || currentFingerprint === null) return "source fingerprint unavailable";
  return sourceChanged ? "source changed since activation; reload required" : null;
}

function migrationActivationProblem(expectedMigrationId: number, appliedMigrationId: number | null): string | null {
  if (appliedMigrationId === null) return "database migration identity unavailable";
  if (appliedMigrationId < expectedMigrationId) {
    return `database is missing migrations through ${expectedMigrationId} (applied through ${appliedMigrationId})`;
  }
  if (appliedMigrationId > expectedMigrationId) {
    return `database is ahead of loaded code at migration ${appliedMigrationId} (loaded code expects ${expectedMigrationId})`;
  }
  return null;
}

export function inspectRuntimeIdentity(
  db: SqliteDatabase,
  identity: RuntimeIdentity,
): ActivationHealth {
  const currentFingerprint = identity.currentFingerprint();
  const sourceChanged = identity.loadedFingerprint !== null && currentFingerprint !== null &&
    identity.loadedFingerprint !== currentFingerprint;
  const appliedMigration = appliedMigrationId(db);
  const problems = [
    sourceActivationProblem(identity, currentFingerprint, sourceChanged),
    migrationActivationProblem(identity.expectedMigrationId, appliedMigration),
  ].filter((problem): problem is string => problem !== null);

  return {
    sourceRoot: identity.sourceRoot,
    loadedAt: identity.loadedAt,
    loadedFingerprint: identity.loadedFingerprint,
    currentFingerprint,
    sourceChanged,
    expectedMigrationId: identity.expectedMigrationId,
    appliedMigrationId: appliedMigration,
    migrationMismatch: appliedMigration === null || appliedMigration !== identity.expectedMigrationId,
    ok: problems.length === 0,
    problems,
  };
}

export function activationSummary(activation: ActivationHealth): string {
  const fingerprint = activation.loadedFingerprint?.slice(0, 12) ?? "unavailable";
  const applied = activation.appliedMigrationId === null ? "unknown" : String(activation.appliedMigrationId);
  return `source=${activation.sourceRoot} build=${fingerprint} loaded=${new Date(activation.loadedAt).toISOString()} schema=${applied}/${activation.expectedMigrationId}`;
}
