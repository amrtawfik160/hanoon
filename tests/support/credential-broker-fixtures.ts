import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export const TEST_CLOCK_START = 1_800_000_000_000;

export type TestClock = Readonly<{
  now(): number;
  advance(milliseconds: number): void;
}>;

export function testClock(start = TEST_CLOCK_START): TestClock {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

export type TemporaryBrokerDatabase = Readonly<{
  directory: string;
  databasePath: string;
  walPath: string;
  shmPath: string;
  readonly db: Database.Database;
  reopen(): Database.Database;
  close(): void;
}>;

export function temporaryBrokerDatabase(): TemporaryBrokerDatabase {
  const directory = mkdtempSync(join(tmpdir(), "hanoon-broker-test-"));
  const databasePath = join(directory, "broker.sqlite");
  let db = new Database(databasePath);
  let closed = false;
  return {
    directory,
    databasePath,
    walPath: `${databasePath}-wal`,
    shmPath: `${databasePath}-shm`,
    get db() { return db; },
    reopen: () => {
      if (closed) throw new Error("temporary_broker_database_closed");
      if (db.open) db.close();
      db = new Database(databasePath);
      return db;
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Distinct values for each credential-bearing boundary under test. */
export type CredentialSecretCanaries = Readonly<{
  resolvedSecret: string;
  serviceAccountToken: string;
  externalVaultReference: string;
  clientPrivateKey: string;
  rawSdkError: string;
}>;

export const CREDENTIAL_SECRET_CANARIES: CredentialSecretCanaries = Object.freeze({
  resolvedSecret: "RSV11!7f31a2+/=resolved-secret-Zq9#Lm2@",
  serviceAccountToken: "TOK11$4d82f1+/=service-account-Vt6&Kp8!",
  externalVaultReference: "op://vault-canary-reference-v11/item-canary-reference-v11/field-Ex9@Q2!L7",
  clientPrivateKey: "-----BEGIN PRIVATE KEY-----\nK11^c7/private-key-canary+/\n-----END PRIVATE KEY-----",
  rawSdkError: "ERR11%raw-sdk-error-canary:onepassword?detail=Bad",
});

export type SecretCanarySurface =
  | string
  | Uint8Array
  | Readonly<{ name?: string; value: string | Uint8Array }>
  | Readonly<{ name?: string; path: string }>;

type NamedCanary = Readonly<{ name: string; value: string }>;

/**
 * Returns every representation a logger, serializer, or transport could
 * persist for one canary, including encoded eight-character boundary pieces.
 */
export function canaryVariants(canary: string): readonly string[] {
  const variants = new Set<string>();
  const pieces: readonly string[] = [canary, canary.slice(0, 8), canary.slice(-8)];
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    variants.add(piece);
    variants.add(Buffer.from(piece, "utf8").toString("base64"));
    variants.add(Buffer.from(piece, "utf8").toString("base64url"));
    variants.add(encodeURIComponent(piece));
    const escaped = JSON.stringify(piece);
    variants.add(escaped);
    variants.add(escaped.slice(1, -1));
  }
  return Object.freeze([...variants]);
}

function namedCanaries(input: readonly string[] | Readonly<Record<string, string>>): readonly NamedCanary[] {
  return Array.isArray(input)
    ? input.map((value, index) => ({ name: `canary_${index}`, value }))
    : Object.entries(input).map(([name, value]) => ({ name, value }));
}

function readSurface(surface: SecretCanarySurface, index: number): Readonly<{ name: string; bytes: Buffer }> {
  if (typeof surface === "string") return { name: `surface_${index}`, bytes: Buffer.from(surface, "utf8") };
  if (surface instanceof Uint8Array) return { name: `surface_${index}`, bytes: Buffer.from(surface) };
  if ("path" in surface) {
    return { name: surface.name ?? surface.path, bytes: readFileSync(surface.path) };
  }
  return { name: surface.name ?? `surface_${index}`, bytes: Buffer.from(surface.value) };
}

/**
 * Fails when any canary or its common serialized form appears in a surface.
 * File surfaces are read as bytes so SQLite database, WAL, and SHM checks do
 * not depend on text decoding.
 */
export function assertCanaryAbsent(
  surfaces: SecretCanarySurface | readonly SecretCanarySurface[],
  canaries: readonly string[] | Readonly<Record<string, string>> = CREDENTIAL_SECRET_CANARIES,
): void {
  const surfaceList = Array.isArray(surfaces) ? surfaces : [surfaces];
  const named = namedCanaries(canaries);
  for (let index = 0; index < surfaceList.length; index += 1) {
    const surface = readSurface(surfaceList[index]!, index);
    for (const canary of named) {
      for (const variant of canaryVariants(canary.value)) {
        if (surface.bytes.includes(Buffer.from(variant, "utf8"))) {
          throw new Error(`secret_canary_found:${canary.name}:${surface.name}`);
        }
      }
    }
  }
}

export function sqliteCanarySurfaces(
  databasePath: string,
  name: string,
): readonly SecretCanarySurface[] {
  return [
    { name: `${name}:db`, path: databasePath },
    ...(existsSync(`${databasePath}-wal`) ? [{ name: `${name}:wal`, path: `${databasePath}-wal` }] : []),
    ...(existsSync(`${databasePath}-shm`) ? [{ name: `${name}:shm`, path: `${databasePath}-shm` }] : []),
  ];
}

export function writePrivateFile(path: string, contents: string | Uint8Array): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o600);
}

export type FakeVault = Readonly<{
  id: string;
}>;

export type FakeResolveResult =
  | { outcome: "resolved"; secret: string; vaultId: string; itemId: string }
  | { outcome: "invalid" };

export type FakeOnePasswordPort = {
  listVaults(): Promise<readonly FakeVault[]>;
  resolveOne(reference: string): Promise<FakeResolveResult>;
};

export function fakeOnePasswordPort(
  vaults: readonly FakeVault[],
  resolve: (reference: string) => Promise<FakeResolveResult>,
): FakeOnePasswordPort {
  return {
    listVaults: async () => vaults,
    resolveOne: resolve,
  };
}
