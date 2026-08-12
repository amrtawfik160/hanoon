import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AutonomyRepository } from "../src/storage/autonomy-repository";

const [dbPath, barrierDir, jobId, label, ownerId, generationText] = process.argv.slice(2);
if (!dbPath || !barrierDir || !jobId || !label || !ownerId || !generationText) {
  throw new Error("race worker arguments are incomplete");
}

const generation = Number(generationText);
const db = new Database(dbPath);
db.pragma("busy_timeout = 20");
db.function("task4_race_pause", () => {
  writeFileSync(join(barrierDir, "claim-started"), label);
  while (!existsSync(join(barrierDir, "release"))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
});

writeFileSync(join(barrierDir, `ready-${label}`), "ready");
while (!existsSync(join(barrierDir, `go-${label}`))) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
writeFileSync(join(barrierDir, `attempting-${label}`), "attempting");

const repository = new AutonomyRepository(db);
try {
  const result = repository.tryAdmit({
    jobId,
    maxConcurrentJobs: 1,
    ownerId,
    generation,
    now: 2_000,
    leaseMs: 30_000,
  });
  process.stdout.write(`${JSON.stringify({ outcome: result.outcome, ...(result.outcome === "not_admitted" ? { reason: result.reason } : {}) })}\n`);
} finally {
  db.close();
}
