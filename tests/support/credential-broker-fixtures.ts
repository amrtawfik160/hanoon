import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
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
  db: Database.Database;
  close(): void;
}>;

export function temporaryBrokerDatabase(): TemporaryBrokerDatabase {
  const directory = mkdtempSync(join(tmpdir(), "hanoon-broker-test-"));
  const databasePath = join(directory, "broker.sqlite");
  const db = new Database(databasePath);
  let closed = false;
  return {
    directory,
    databasePath,
    walPath: `${databasePath}-wal`,
    db,
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
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
