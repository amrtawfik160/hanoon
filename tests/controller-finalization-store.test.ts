import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { ControllerEvidenceRepository } from "../src/storage/controller-evidence-repository";
import { openStore } from "../src/storage/store";
import {
  disposeControllerTrustFixtures,
  insertControllerTestJob,
  submittedControllerFixture,
  validEvidenceInput,
} from "./support/controller-trust-fixtures";

afterEach(async () => {
  await disposeControllerTrustFixtures();
});

type RaceWorker = Readonly<{
  child: ChildProcessWithoutNullStreams;
  result: Promise<RaceWorkerResult>;
}>;

type RaceWorkerResult = Readonly<{
  outcome: string;
  code?: string;
  revision?: number;
}>;

type SeededRaceDatabase = Readonly<{
  db: Database.Database;
  databasePath: string;
  disposeHost: () => Promise<void>;
}>;

function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (existsSync(path)) return resolveWait();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error(`race barrier timed out: ${path}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function raceWorkerSource(): string {
  const evidenceRepositoryModule = JSON.stringify(resolve("src/storage/controller-evidence-repository.ts"));
  const storeModule = JSON.stringify(resolve("src/storage/store.ts"));
  return String.raw`
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ControllerEvidenceRepository } from ${evidenceRepositoryModule};
import { openStore } from ${storeModule};

const [dbPath, barrierDir, label, operation] = process.argv.slice(2);
if (!dbPath || !barrierDir || !label || !operation) throw new Error("race worker arguments are incomplete");
const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
const kv = {
  get: async () => undefined,
  set: async () => undefined,
  delete: async () => undefined,
  list: async () => [],
};
const storage = {
  database: () => db,
  kv,
  migrate: () => undefined,
};
db.function("task8_race_pause", () => {
  writeFileSync(join(barrierDir, "entered-" + label), "entered");
  while (!existsSync(join(barrierDir, "release"))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
});
const repository = new ControllerEvidenceRepository(db);
const store = openStore(storage as Parameters<typeof openStore>[0], kv as Parameters<typeof openStore>[1]);
writeFileSync(join(barrierDir, "ready-" + label), "ready");
while (!existsSync(join(barrierDir, "go"))) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
writeFileSync(join(barrierDir, "attempting-" + label), "attempting");
try {
  const fence = { ownerId: "executor", generation: 1, now: 2_000 };
  let raceResult;
  if (operation === "proposal") {
    const proposal = repository.proposeFinalization({
      ...fence,
      turnId: "turn_race",
      controllerKey: "controller_race",
      candidate: {
        disposition: "answered",
        segments: [{ type: "text", text: "The answer is complete." }],
        obligationRefs: [],
      },
    });
    raceResult = proposal.outcome === "rejected"
      ? {
          outcome: proposal.outcome,
          code: proposal.code,
          ...("revision" in proposal ? { revision: proposal.revision } : {}),
        }
      : { outcome: proposal.outcome };
  } else if (operation === "continuation") {
    const outcome = store.claimControllerCompletionContinuation({
      ...fence,
      turnId: "turn_race",
      controllerKey: "controller_race",
      bbHighWaterSeq: 0,
    });
    if (outcome === "claimed") {
      writeFileSync(join(barrierDir, "sent-" + label),
        "Your previous turn ended without an accepted telegram_agent_respond call. Inspect telegram_agent_turn_evidence, correct any rejected finalization, and make telegram_agent_respond your final action now. Do not repeat a side effect.");
    }
    raceResult = { outcome };
  } else if (operation === "crash") {
    const outcome = store.claimControllerCompletionContinuation({
      ...fence,
      turnId: "turn_race",
      controllerKey: "controller_race",
      bbHighWaterSeq: 0,
    });
    if (outcome === "claimed") {
      writeFileSync(join(barrierDir, "crashed-after-claim-" + label), "claimed");
      process.exit(42);
    }
    raceResult = { outcome };
  } else {
    raceResult = {
      outcome: store.completeControllerTurnFromFinalization({
        ...fence,
        turnId: "turn_race",
        controllerKey: "controller_race",
        bbHighWaterSeq: 0,
      }),
    };
  }
  process.stdout.write(JSON.stringify(raceResult) + "\n");
} finally {
  db.close();
}
`;
}

let raceHostNumber = 0;

function seededRaceDatabase(): SeededRaceDatabase {
  const { bb, harness } = createFakePluginHost({ pluginId: `telegram-controller-race-${raceHostNumber++}` });
  openStore(bb.storage, bb.storage.kv, () => 2_000);
  const db = bb.storage.database();
  const databasePath = db.name;
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at) VALUES (1, '7', '7', 1)",
  ).run();
  db.prepare(
    `INSERT INTO controller_threads (
       controller_key, telegram_user_id, telegram_chat_id, project_id, host_id,
       bb_thread_id, state, created_at, updated_at
     ) VALUES ('controller_race', '7', '7', 'project_race', 'host_race',
       'thread_race', 'active', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO controller_turns (
       id, telegram_update_id, controller_key, ordinal, input_text, state,
       lease_owner, lease_generation, submitted_at, created_at, updated_at
     ) VALUES ('turn_race', 1, 'controller_race', 1, 'Question?', 'submitted',
       'executor', 1, 1, 1, 1)`,
  ).run();
  db.prepare(
    `UPDATE executor_lease SET owner_id = 'executor', generation = 1,
       heartbeat_at = 1, lease_expires_at = 10000 WHERE singleton = 1`,
  ).run();
  return {
    db,
    databasePath,
    disposeHost: async () => { await harness.lifecycle.dispose(); },
  };
}

function startRaceWorker(
  scriptPath: string,
  databasePath: string,
  barrierDir: string,
  label: string,
  operation: "proposal" | "completion" | "continuation" | "crash",
): RaceWorker {
  const child = spawn(resolve("node_modules/.bin/vite-node"), [
    "--script",
    scriptPath,
    databasePath,
    barrierDir,
    label,
    operation,
  ], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const result = new Promise<RaceWorkerResult>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`race worker exited ${code}: ${stderr || stdout}`));
      const line = stdout.trim().split("\n").at(-1);
      if (!line) return reject(new Error(`race worker returned no result: ${stderr}`));
      resolveResult(JSON.parse(line) as RaceWorkerResult);
    });
  });
  return { child, result };
}

async function releaseRace(
  barrierDir: string,
  workers: readonly RaceWorker[],
): Promise<RaceWorkerResult[]> {
  await Promise.all(workers.map((_, index) => waitForFile(resolve(barrierDir, `ready-${index}`))));
  writeFileSync(resolve(barrierDir, "go"), "go");
  await Promise.all(workers.map((_, index) => waitForFile(resolve(barrierDir, `attempting-${index}`))));
  await Promise.race(workers.map((_, index) => waitForFile(resolve(barrierDir, `entered-${index}`))));
  writeFileSync(resolve(barrierDir, "release"), "release");
  return await Promise.all(workers.map((worker) => worker.result));
}

function stopRaceWorkers(workers: readonly RaceWorker[]): void {
  for (const worker of workers) {
    if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
  }
}

function processOnlyFinalization() {
  return {
    disposition: "answered" as const,
    segments: [{ type: "text" as const, text: "I'll investigate." }],
    obligationRefs: [],
  };
}

function plainFinalization(text = "The answer is complete.") {
  return {
    disposition: "answered" as const,
    segments: [{ type: "text" as const, text }],
    obligationRefs: [],
  };
}

function needsOwnerFinalization() {
  return {
    disposition: "needs_owner" as const,
    segments: [{ type: "text" as const, text: "Please choose one option." }],
    obligationRefs: [],
  };
}

function deferredFinalization(ref: string) {
  return {
    disposition: "deferred" as const,
    segments: [{ type: "text" as const, text: "I'll follow up when the work finishes." }],
    obligationRefs: [ref],
  };
}

function acceptPlainFinalization(
  fixture: ReturnType<typeof submittedControllerFixture>,
  text = "The answer is complete.",
) {
  const accepted = fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: plainFinalization(text),
  });
  if (accepted.outcome !== "accepted") throw new Error("finalization fixture was not accepted");
  return accepted.finalization;
}

function nativeEvidenceCandidate(sourceItemId: string) {
  return {
    sourceName: "commandExecution",
    sourceItemId,
    outcome: "succeeded" as const,
    argsSha256: "c".repeat(64),
    resultSha256: "d".repeat(64),
    proofKinds: ["command_result"] as const,
    subjectRefs: [`bb-item:${sourceItemId}`] as const,
  };
}

it("accepts one evidence-bound candidate and makes it immutable", () => {
  const { store, turn, fence, db } = submittedControllerFixture();
  const evidence = store.recordControllerEvidence({
    ...validEvidenceInput(turn),
    ...fence,
  });
  if (evidence.outcome !== "recorded") throw new Error("evidence fixture was not recorded");
  const candidate = {
    disposition: "answered" as const,
    segments: [{
      type: "claim" as const,
      text: "The project is available.",
      kind: "observed_state" as const,
      outcome: "observed" as const,
      subjectRef: "project:proj_1",
      evidenceRefs: [evidence.evidence.ref],
    }],
    obligationRefs: [],
  };

  const accepted = store.proposeControllerFinalization({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    candidate,
  });

  expect(accepted).toMatchObject({
    outcome: "accepted",
    finalization: {
      ref: "finalization:1",
      renderedMessage: "The project is available.",
      evidenceHighWaterId: evidence.evidence.id,
    },
  });
  expect(store.proposeControllerFinalization({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    candidate: processOnlyFinalization(),
  })).toMatchObject({ outcome: "rejected", code: "accepted_already" });
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_finalizations WHERE turn_id = ?",
  ).get(turn.id)).toEqual({ count: 1 });
});

it("rejects finalization while a mutating invocation remains started", () => {
  const fixture = submittedControllerFixture();
  const argsSha256 = "a".repeat(64);
  expect(fixture.store.claimToolReceipt({
    turnId: fixture.turn.id,
    toolName: "telegram_agent_remember",
    argsSha256,
    controllerKey: fixture.turn.controllerKey,
    now: fixture.fence.now,
  })).toEqual({ outcome: "fresh" });

  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: plainFinalization(),
  })).toMatchObject({ outcome: "rejected", code: "invocation_in_flight" });
  expect(fixture.store.getAcceptedControllerFinalization(fixture.turn.id)).toBeNull();
  expect(fixture.store.listToolReceipts(fixture.turn.id)).toMatchObject([
    { toolName: "telegram_agent_remember", state: "started" },
  ]);
});

it("allows eight rejected revisions and inserts no ninth row", () => {
  const { store, turn, fence, db } = submittedControllerFixture();
  for (let revision = 1; revision <= 8; revision += 1) {
    expect(store.proposeControllerFinalization({
      ...fence,
      turnId: turn.id,
      controllerKey: turn.controllerKey,
      candidate: processOnlyFinalization(),
    })).toMatchObject({ outcome: "rejected", revision, code: "process_only" });
  }

  expect(store.proposeControllerFinalization({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    candidate: processOnlyFinalization(),
  })).toMatchObject({ outcome: "rejected", code: "revision_limit" });
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_finalizations WHERE turn_id = ?",
  ).get(turn.id)).toEqual({ count: 8 });
});

it("claims one completion continuation only at the observed native cursor", () => {
  const { store, turn, fence } = submittedControllerFixture();
  expect(store.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 7,
    items: [],
  })).toBe("recorded");

  expect(store.claimControllerCompletionContinuation({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    bbHighWaterSeq: 8,
  })).toBe("stale");
  expect(store.claimControllerCompletionContinuation({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    bbHighWaterSeq: 7,
  })).toBe("claimed");
  expect(store.claimControllerCompletionContinuation({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    bbHighWaterSeq: 7,
  })).toBe("already_claimed");
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    completionContinuations: 1,
    dispatchAfterSeq: 7,
    bbEventSeq: 7,
    evidenceEventSeq: 7,
    streamText: "Hanoon is thinking…",
    streamPhase: "thinking",
  });
});

it("leaves continuation state untouched when the native cursor advanced", () => {
  const fixture = submittedControllerFixture();
  const outboxBefore = fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`);
  expect(fixture.store.claimControllerCompletionContinuation({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbHighWaterSeq: 1,
  })).toBe("stale");
  expect(fixture.store.getControllerTurn(fixture.turn.id)).toMatchObject({
    completionContinuations: 0,
    dispatchAfterSeq: 0,
    bbEventSeq: 0,
    evidenceEventSeq: 0,
  });
  expect(fixture.store.readControllerDigest(fixture.turn.controllerKey, 10)).toEqual([]);
  expect(fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`)).toEqual(outboxBefore);
});

it("does not claim a completion continuation after acceptance", () => {
  const fixture = submittedControllerFixture();
  acceptPlainFinalization(fixture);
  expect(fixture.store.claimControllerCompletionContinuation({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbHighWaterSeq: 0,
  })).toBe("stale");
  expect(fixture.store.getControllerTurn(fixture.turn.id)?.completionContinuations).toBe(0);
});

it("completes from accepted rendered text exactly once", () => {
  const fixture = submittedControllerFixture();
  const accepted = acceptPlainFinalization(fixture);

  expect(fixture.store.completeControllerTurnFromFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbHighWaterSeq: 0,
  })).toBe("completed");
  expect(fixture.store.completeControllerTurnFromFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbHighWaterSeq: 0,
  })).toBe("stale");
  expect(fixture.store.getControllerTurn(fixture.turn.id)).toMatchObject({
    state: "completed",
    responseText: accepted.renderedMessage,
    streamText: "Hanoon completed.",
    streamPhase: "complete",
  });
  expect(fixture.store.readControllerDigest(fixture.turn.controllerKey, 10)).toEqual([{
    ownerText: fixture.turn.inputText,
    agentText: accepted.renderedMessage,
  }]);
  expect(fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`)).toMatchObject({
    status: "pending",
    payload: expect.objectContaining({ text: accepted.renderedMessage }),
  });
  expect(fixture.store.getAcceptedControllerFinalization(fixture.turn.id)).toMatchObject({
    consumedAt: fixture.fence.now,
  });
});

it("uses the rendered finalization text verbatim for completion delivery", () => {
  const fixture = submittedControllerFixture();
  const accepted = acceptPlainFinalization(fixture, "**Accepted** answer");

  expect(fixture.store.completeControllerTurnFromFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbHighWaterSeq: 0,
  })).toBe("completed");
  expect(fixture.store.getControllerTurn(fixture.turn.id)).toMatchObject({
    responseText: accepted.renderedMessage,
    streamText: "Hanoon completed.",
  });
  expect(fixture.store.readControllerDigest(fixture.turn.controllerKey, 10)[0]?.agentText)
    .toBe(accepted.renderedMessage);
  expect(fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`)).toMatchObject({
    payload: { text: accepted.renderedMessage },
  });
});

it("keeps direct evidence sealed but admits late native evidence and refuses completion", () => {
  const fixture = submittedControllerFixture();
  const accepted = acceptPlainFinalization(fixture);
  const outboxBefore = fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`);

  expect(fixture.store.recordControllerEvidence({
    ...validEvidenceInput(fixture.turn),
    ...fixture.fence,
  })).toEqual({ outcome: "stale" });
  expect(fixture.store.recordControllerNativeEvidence({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [nativeEvidenceCandidate("late_native")],
  })).toBe("recorded");
  expect(fixture.store.completeControllerTurnFromFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbHighWaterSeq: 1,
  })).toBe("evidence_advanced");
  expect(fixture.store.getAcceptedControllerFinalization(fixture.turn.id)).toMatchObject({
    id: accepted.id,
    consumedAt: null,
  });
  expect(fixture.store.readControllerDigest(fixture.turn.controllerKey, 10)).toEqual([]);
  expect(fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`)).toEqual(outboxBefore);
});

it("treats a late native evidence cap marker as evidence advanced", () => {
  const fixture = submittedControllerFixture();
  for (let index = 0; index < 128; index += 1) {
    expect(fixture.store.recordControllerEvidence({
      ...validEvidenceInput(fixture.turn),
      ...fixture.fence,
      sourceName: `seed_${index}`,
    })).toMatchObject({ outcome: "recorded" });
  }
  acceptPlainFinalization(fixture);

  expect(fixture.store.recordControllerNativeEvidence({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [nativeEvidenceCandidate("over_cap")],
  })).toBe("limit_exceeded");
  expect(fixture.store.completeControllerTurnFromFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbHighWaterSeq: 0,
  })).toBe("evidence_advanced");
});

it("uses the eighth revision for acceptance and inserts nothing on accepted retry", () => {
  const fixture = submittedControllerFixture();
  for (let revision = 1; revision <= 7; revision += 1) {
    expect(fixture.store.proposeControllerFinalization({
      ...fixture.fence,
      turnId: fixture.turn.id,
      controllerKey: fixture.turn.controllerKey,
      candidate: processOnlyFinalization(),
    })).toMatchObject({ outcome: "rejected", revision });
  }
  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: plainFinalization(),
  })).toMatchObject({ outcome: "accepted", finalization: { revision: 8 } });
  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: plainFinalization("Changed"),
  })).toMatchObject({ outcome: "rejected", code: "accepted_already" });
  expect(fixture.db.prepare(
    "SELECT COUNT(*) AS count FROM controller_finalizations WHERE turn_id = ?",
  ).get(fixture.turn.id)).toEqual({ count: 8 });
});

it("inserts no revision after the proposal fence is lost", () => {
  const fixture = submittedControllerFixture();
  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    generation: fixture.fence.generation + 1,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: plainFinalization(),
  })).toEqual({ outcome: "stale" });
  expect(fixture.db.prepare(
    "SELECT COUNT(*) AS count FROM controller_finalizations WHERE turn_id = ?",
  ).get(fixture.turn.id)).toEqual({ count: 0 });
});

it("rejects evidence that belongs to another turn", () => {
  const fixture = submittedControllerFixture();
  fixture.db.prepare(
    `INSERT INTO controller_turns (
       id, telegram_update_id, controller_key, ordinal, input_text, state,
       created_at, updated_at
     ) VALUES ('turn_evidence_other', 987653, ?, 2, 'Other turn', 'queued', 1, 1)`,
  ).run(fixture.turn.controllerKey);
  fixture.db.prepare(
    `INSERT INTO controller_evidence (
       turn_id, controller_key, source_kind, source_name, source_item_id,
       outcome, args_sha256, result_sha256, proof_kinds_json,
       subject_refs_json, observed_at
     ) VALUES ('turn_evidence_other', ?, 'hanoon_tool', 'other', NULL,
       'observed', ?, ?, '["project_state"]', '["project:other"]', 1)`,
  ).run(fixture.turn.controllerKey, "a".repeat(64), "b".repeat(64));
  const otherEvidence = fixture.db.prepare(
    "SELECT id FROM controller_evidence WHERE turn_id = 'turn_evidence_other'",
  ).get() as { id: number };

  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: {
      disposition: "answered",
      segments: [{
        type: "claim",
        text: "The other project exists.",
        kind: "observed_state",
        outcome: "observed",
        subjectRef: "project:other",
        evidenceRefs: [`evidence:${otherEvidence.id}`],
      }],
      obligationRefs: [],
    },
  })).toMatchObject({ outcome: "rejected", revision: 1, code: "evidence_missing" });
});

it("retrieves zero-evidence accepted state across reopen and settles exactly once", () => {
  const fixture = submittedControllerFixture();
  const accepted = acceptPlainFinalization(fixture);
  const restarted = fixture.reopen();
  expect(accepted.evidenceHighWaterId).toBe(0);
  expect(restarted.getAcceptedControllerFinalization(fixture.turn.id)).toEqual(accepted);
  expect(restarted.completeControllerTurnFromFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbHighWaterSeq: 0,
  })).toBe("completed");
  expect(restarted.completeControllerTurnFromFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbHighWaterSeq: 0,
  })).toBe("stale");
  expect(fixture.reopen().getAcceptedControllerFinalization(fixture.turn.id)).toMatchObject({
    id: accepted.id,
    consumedAt: fixture.fence.now,
  });
  expect(fixture.store.readControllerDigest(fixture.turn.controllerKey, 10)).toHaveLength(1);
  expect(fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`)).toMatchObject({
    payload: { text: accepted.renderedMessage },
  });
});

it("completes from the accepted finalization and ignores no raw response alternative", () => {
  const fixture = submittedControllerFixture();
  const accepted = acceptPlainFinalization(fixture);

  expect(fixture.store.completeControllerTurnFromFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbHighWaterSeq: 0,
  })).toBe("completed");
  expect(fixture.store.getControllerTurn(fixture.turn.id)).toMatchObject({
    state: "completed",
    responseText: accepted.renderedMessage,
    streamText: "Hanoon completed.",
  });
  expect(fixture.store.readControllerDigest(fixture.turn.controllerKey, 10)[0]?.agentText)
    .toBe(accepted.renderedMessage);
  expect(fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`))
    .toMatchObject({ payload: { text: accepted.renderedMessage } });
});

it("rolls back every completion side effect when the final outbox write aborts", () => {
  const fixture = submittedControllerFixture();
  const accepted = acceptPlainFinalization(fixture);
  const beforeTurn = fixture.store.getControllerTurn(fixture.turn.id);
  const beforeOutbox = fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`);
  fixture.db.exec(`
    CREATE TRIGGER rollback_controller_completion
    BEFORE INSERT ON controller_digest
    BEGIN
      SELECT RAISE(ABORT, 'injected completion rollback');
    END
  `);

  expect(() => fixture.store.completeControllerTurnFromFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbHighWaterSeq: accepted.bbEventHighWaterSeq ?? 0,
  })).toThrow(/injected completion rollback/);

  expect(fixture.store.getControllerTurn(fixture.turn.id)).toEqual(beforeTurn);
  expect(fixture.store.getAcceptedControllerFinalization(fixture.turn.id)).toMatchObject({ consumedAt: null });
  expect(fixture.store.readControllerDigest(fixture.turn.controllerKey, 10)).toEqual([]);
  expect(fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`)).toEqual(beforeOutbox);
  fixture.db.exec("DROP TRIGGER rollback_controller_completion");
  expect(fixture.store.completeControllerTurnFromFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbHighWaterSeq: accepted.bbEventHighWaterSeq ?? 0,
  })).toBe("completed");
});

it("rolls back failure and generation retirement together when its notice write aborts", () => {
  const fixture = submittedControllerFixture();
  const beforeTurn = fixture.store.getControllerTurn(fixture.turn.id);
  const beforeController = fixture.store.getControllerForOwner("7", "7");
  const beforeGeneration = fixture.store.listControllerGenerations(fixture.turn.controllerKey, 10);
  const beforeOutbox = fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`);
  fixture.db.exec(`
    CREATE TRIGGER rollback_controller_failure
    BEFORE INSERT ON outbox
    WHEN NEW.logical_key = 'controller:${fixture.turn.id}:reply'
    BEGIN
      SELECT RAISE(ABORT, 'injected failure rollback');
    END
  `);

  expect(() => fixture.store.failAndRetireControllerTurn({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    expectedThreadId: beforeController?.threadId ?? "missing",
    error: "provider failure",
  })).toThrow(/injected failure rollback/);

  expect(fixture.store.getControllerTurn(fixture.turn.id)).toEqual(beforeTurn);
  expect(fixture.store.getControllerForOwner("7", "7")).toEqual(beforeController);
  expect(fixture.store.listControllerGenerations(fixture.turn.controllerKey, 10)).toEqual(beforeGeneration);
  expect(fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`)).toEqual(beforeOutbox);
  fixture.db.exec("DROP TRIGGER rollback_controller_failure");
  expect(fixture.store.failAndRetireControllerTurn({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    expectedThreadId: beforeController?.threadId ?? "missing",
    error: "provider failure",
  })).toBe(true);
});

it("does not expose an accepted finalization through another turn", () => {
  const fixture = submittedControllerFixture();
  const accepted = acceptPlainFinalization(fixture);
  fixture.db.prepare(
    `INSERT INTO controller_turns (
       id, telegram_update_id, controller_key, ordinal, input_text, state,
       created_at, updated_at
     ) VALUES ('turn_other', 987654, ?, 2, 'Other turn', 'queued', 1, 1)`,
  ).run(fixture.turn.controllerKey);

  expect(fixture.store.getAcceptedControllerFinalization("turn_other")).toBeNull();
  fixture.db.prepare(
    "UPDATE controller_turns SET accepted_finalization_id = ? WHERE id = 'turn_other'",
  ).run(accepted.id);
  expect(() => fixture.store.getAcceptedControllerFinalization("turn_other"))
    .toThrow(/pointer|inconsistent/i);
});

it("fails closed on an invalid accepted pointer", () => {
  const fixture = submittedControllerFixture();
  fixture.db.pragma("ignore_check_constraints = ON");
  fixture.db.prepare(
    "UPDATE controller_turns SET accepted_finalization_id = 0 WHERE id = ?",
  ).run(fixture.turn.id);

  expect(() => fixture.store.getAcceptedControllerFinalization(fixture.turn.id))
    .toThrow(/pointer|positive/i);
});

const acceptedRetryCorruptions = [
  {
    scenario: "a malformed pointer",
    corrupt: (fixture: ReturnType<typeof submittedControllerFixture>) => {
      fixture.db.prepare(
        "UPDATE controller_turns SET accepted_finalization_id = 0 WHERE id = ?",
      ).run(fixture.turn.id);
    },
  },
  {
    scenario: "a malformed payload",
    corrupt: (fixture: ReturnType<typeof submittedControllerFixture>, acceptedId: number) => {
      fixture.db.prepare(
        "UPDATE controller_finalizations SET payload_json = '{' WHERE id = ?",
      ).run(acceptedId);
    },
  },
  {
    scenario: "a rejected pointed row",
    corrupt: (fixture: ReturnType<typeof submittedControllerFixture>, acceptedId: number) => {
      fixture.db.prepare(
        `UPDATE controller_finalizations
            SET state = 'rejected', rejection_code = 'invalid_contract'
          WHERE id = ?`,
      ).run(acceptedId);
    },
  },
  {
    scenario: "mismatched rendered text",
    corrupt: (fixture: ReturnType<typeof submittedControllerFixture>, acceptedId: number) => {
      fixture.db.prepare(
        "UPDATE controller_finalizations SET rendered_message = 'changed' WHERE id = ?",
      ).run(acceptedId);
    },
  },
  {
    scenario: "an inconsistent evidence seal",
    corrupt: (fixture: ReturnType<typeof submittedControllerFixture>, acceptedId: number) => {
      fixture.db.prepare(
        "UPDATE controller_finalizations SET evidence_high_water_id = 999 WHERE id = ?",
      ).run(acceptedId);
    },
  },
] as const;

it.each(acceptedRetryCorruptions)(
  "fails closed when an accepted retry encounters $scenario",
  ({ corrupt }) => {
    const fixture = submittedControllerFixture();
    const accepted = acceptPlainFinalization(fixture);
    corrupt(fixture, accepted.id);

    expect(() => fixture.store.proposeControllerFinalization({
      ...fixture.fence,
      turnId: fixture.turn.id,
      controllerKey: fixture.turn.controllerKey,
      candidate: plainFinalization("Changed"),
    })).toThrow(/finalization|pointer|positive/i);
    expect(fixture.db.prepare(
      "SELECT COUNT(*) AS count FROM controller_finalizations WHERE turn_id = ?",
    ).get(fixture.turn.id)).toEqual({ count: 1 });
  },
);

it.each([
  ["malformed payload", "payload_json", "{"],
  ["rendered mismatch", "rendered_message", "changed"],
  ["negative created timestamp", "created_at", -1],
  ["negative validated timestamp", "validated_at", -1],
  ["negative consumed timestamp", "consumed_at", -1],
  ["negative evidence seal", "evidence_high_water_id", -1],
  ["missing evidence seal", "evidence_high_water_id", 999],
] as const)("fails closed on accepted finalization corruption: %s", (_scenario, column, corrupted) => {
  const fixture = submittedControllerFixture();
  const accepted = acceptPlainFinalization(fixture);
  fixture.db.prepare(
    `UPDATE controller_finalizations SET ${column} = ? WHERE id = ?`,
  ).run(corrupted, accepted.id);

  expect(() => fixture.store.getAcceptedControllerFinalization(fixture.turn.id)).toThrow(/finalization/i);
});

it("accepts needs-owner only for the exact pending or answered generic interaction", () => {
  const fixture = submittedControllerFixture();
  const candidate = needsOwnerFinalization();
  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate,
  })).toMatchObject({ outcome: "rejected", revision: 1, code: "owner_boundary_missing" });
  fixture.db.prepare(
    `INSERT INTO controller_turns (
       id, telegram_update_id, controller_key, ordinal, input_text, state,
       lease_owner, lease_generation, submitted_at, created_at, updated_at
     ) VALUES ('turn_question_other', 987655, ?, 2, 'Other turn', 'completed',
       'executor', 1, ?, ?, ?)`,
  ).run(fixture.turn.controllerKey, fixture.fence.now, fixture.fence.now, fixture.fence.now);
  const generation = fixture.store.listControllerGenerations(fixture.turn.controllerKey, 1)[0];
  const controller = fixture.db.prepare(
    "SELECT bb_thread_id FROM controller_threads WHERE controller_key = ?",
  ).get(fixture.turn.controllerKey) as { bb_thread_id: string };
  if (!generation) throw new Error("missing controller generation");
  fixture.db.prepare(
    `INSERT INTO controller_interactions (
       interaction_id, turn_id, controller_key, bb_thread_id, controller_generation_id,
       kind, payload_json, state, answer_json, asked_at, answered_at, delivered_at
     ) VALUES ('interaction_other', 'turn_question_other', ?, ?, ?, 'unsupported',
       '{"kind":"unsupported","interactionId":"interaction_other"}', 'answered', '{}', ?, ?, NULL)`,
  ).run(fixture.turn.controllerKey, controller.bb_thread_id, generation.id, fixture.fence.now, fixture.fence.now);
  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate,
  })).toMatchObject({ outcome: "rejected", revision: 2, code: "owner_boundary_missing" });
  expect(fixture.store.recordControllerInteraction({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbThreadId: controller.bb_thread_id,
    controllerGenerationId: generation.id,
    interaction: { kind: "unsupported", interactionId: "interaction_exact" },
  })).toBe("recorded");
  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate,
  })).toMatchObject({ outcome: "accepted", finalization: { revision: 3 } });
});

it("does not complete an accepted needs-owner turn while its exact interaction is pending", () => {
  const fixture = submittedControllerFixture();
  const generation = fixture.store.listControllerGenerations(fixture.turn.controllerKey, 1)[0];
  const controller = fixture.db.prepare(
    "SELECT bb_thread_id FROM controller_threads WHERE controller_key = ?",
  ).get(fixture.turn.controllerKey) as { bb_thread_id: string };
  if (!generation) throw new Error("missing controller generation");
  expect(fixture.store.recordControllerInteraction({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbThreadId: controller.bb_thread_id,
    controllerGenerationId: generation.id,
    interaction: { kind: "unsupported", interactionId: "interaction_pending_completion_guard" },
  })).toBe("recorded");
  const accepted = fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbEventHighWaterSeq: 0,
    candidate: needsOwnerFinalization(),
  });
  if (accepted.outcome !== "accepted") throw new Error("needs-owner guard fixture was not accepted");

  expect(fixture.store.completeControllerTurnFromFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbHighWaterSeq: 0,
  })).toBe("stale");
  expect(fixture.store.getControllerTurn(fixture.turn.id)?.state).toBe("submitted");
  expect(fixture.store.getAcceptedControllerFinalization(fixture.turn.id)).toMatchObject({
    id: accepted.finalization.id,
    consumedAt: null,
  });
});

it("accepts needs-owner for an unexpired one-use confirmation bound to the paired owner", () => {
  const fixture = submittedControllerFixture();
  fixture.store.createThreadOperation({
    id: "operation_exact_owner",
    nonceHash: "7".repeat(64),
    ownerUserId: "7",
    ownerChatId: "7",
    kind: "stop_thread",
    threadId: "thread_target",
    text: null,
    expiresAt: fixture.fence.now + 1,
    now: fixture.fence.now,
  });
  fixture.store.markThreadOperationConfirmationSent("operation_exact_owner", 77, fixture.fence.now);

  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: needsOwnerFinalization(),
  })).toMatchObject({ outcome: "accepted" });
});

it("does not treat a queued confirmed job as an owner boundary", () => {
  const fixture = submittedControllerFixture();
  insertControllerTestJob(fixture.db, {
    id: "job_queued",
    state: "awaiting_confirmation",
    admissionState: "queued",
  });
  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: needsOwnerFinalization(),
  })).toMatchObject({ outcome: "rejected", code: "owner_boundary_missing" });

  fixture.db.prepare("DELETE FROM job_admissions WHERE job_id = 'job_queued'").run();
  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: needsOwnerFinalization(),
  })).toMatchObject({ outcome: "accepted" });
});

it("accepts needs-owner for an exact unexpired merge approval", () => {
  const fixture = submittedControllerFixture();
  insertControllerTestJob(fixture.db, {
    id: "job_merge",
    state: "awaiting_merge_approval",
    version: 4,
    prHeadSha: "a".repeat(40),
  });
  fixture.db.prepare(
    `INSERT INTO approvals (
       nonce_hash, job_id, head_sha, expires_at, consumed_at, outcome,
       owner_user_id, owner_chat_id, job_version
     ) VALUES (?, 'job_merge', ?, ?, NULL, NULL, '7', '7', 4)`,
  ).run("8".repeat(64), "a".repeat(40), fixture.fence.now + 1);

  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: needsOwnerFinalization(),
  })).toMatchObject({ outcome: "accepted" });
});

it("accepts a live nonterminal job obligation", () => {
  const fixture = submittedControllerFixture();
  insertControllerTestJob(fixture.db, { id: "job_live", state: "implementing" });

  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: deferredFinalization("job:job_live"),
  })).toMatchObject({ outcome: "accepted" });
});

it("accepts an open sealed delegation with a running member obligation", () => {
  const fixture = submittedControllerFixture();
  const delegation = fixture.store.createDelegation({
    controllerKey: fixture.turn.controllerKey,
    instruction: "Compare the implementations",
    now: fixture.fence.now,
  });
  expect(fixture.store.addDelegationThread({
    delegationId: delegation.id,
    threadId: "thread_delegate",
    projectId: "proj_1",
    title: "Compare",
    now: fixture.fence.now,
  })).toBe(true);
  expect(fixture.store.sealDelegation({ id: delegation.id, now: fixture.fence.now })).toBe(true);

  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: deferredFinalization(`delegation:${delegation.id}`),
  })).toMatchObject({ outcome: "accepted" });
});

it("accepts only live controller-owned non-system obligation refs", () => {
  const fixture = submittedControllerFixture();
  fixture.store.createMonitor({
    controllerKey: fixture.turn.controllerKey,
    kind: "schedule",
    cron: "0 9 * * 1",
    instruction: "Check status",
    dueAt: 10_000,
    now: fixture.fence.now,
  });
  const monitor = fixture.store.listMonitors(fixture.turn.controllerKey, false)[0];
  if (!monitor) throw new Error("monitor fixture was not created");
  const candidate = {
    disposition: "deferred" as const,
    segments: [{ type: "text" as const, text: "I'll follow up when the monitor fires." }],
    obligationRefs: [`monitor:${monitor.id}`],
  };

  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate,
  })).toMatchObject({ outcome: "accepted" });
});

it("persists one accepted row when two SQLite processes race", async () => {
  const directory = mkdtempSync(join(tmpdir(), "telegram-task8-race-proposal-"));
  const barrierDir = resolve(directory, "barriers");
  const scriptPath = resolve(directory, "race-worker.ts");
  let db: Database.Database | undefined;
  let disposeHost: (() => Promise<void>) | undefined;
  const workers: RaceWorker[] = [];
  try {
    const seeded = seededRaceDatabase();
    disposeHost = seeded.disposeHost;
    db = seeded.db;
    db.exec(`
      CREATE TRIGGER pause_finalization_accept
      BEFORE INSERT ON controller_finalizations
      WHEN NEW.state = 'accepted'
      BEGIN
        SELECT task8_race_pause();
      END
    `);
    db.close();
    db = undefined;
    writeFileSync(scriptPath, raceWorkerSource());
    mkdirSync(barrierDir);
    workers.push(
      startRaceWorker(scriptPath, seeded.databasePath, barrierDir, "0", "proposal"),
      startRaceWorker(scriptPath, seeded.databasePath, barrierDir, "1", "proposal"),
    );

    const results = await releaseRace(barrierDir, workers);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["accepted", "rejected"]);
    const loser = results.find(({ outcome }) => outcome === "rejected");
    expect(loser).toMatchObject({ outcome: "rejected", code: "accepted_already" });
    expect(loser).not.toHaveProperty("revision");

    db = new Database(seeded.databasePath);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM controller_finalizations WHERE turn_id = 'turn_race'",
    ).get()).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM controller_finalizations WHERE turn_id = 'turn_race' AND state = 'accepted'",
    ).get()).toEqual({ count: 1 });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM controller_turns AS turn
       JOIN controller_finalizations AS finalization
         ON finalization.id = turn.accepted_finalization_id
        AND finalization.turn_id = turn.id
       WHERE turn.id = 'turn_race'`,
    ).get()).toEqual({ count: 1 });
  } finally {
    stopRaceWorkers(workers);
    db?.close();
    await disposeHost?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("persists one digest, outbox row, and consumption when completion races", async () => {
  const directory = mkdtempSync(join(tmpdir(), "telegram-task8-race-completion-"));
  const barrierDir = resolve(directory, "barriers");
  const scriptPath = resolve(directory, "race-worker.ts");
  let db: Database.Database | undefined;
  let disposeHost: (() => Promise<void>) | undefined;
  const workers: RaceWorker[] = [];
  try {
    const seeded = seededRaceDatabase();
    disposeHost = seeded.disposeHost;
    db = seeded.db;
    const repository = new ControllerEvidenceRepository(db);
    expect(repository.proposeFinalization({
      ownerId: "executor",
      generation: 1,
      now: 2_000,
      turnId: "turn_race",
      controllerKey: "controller_race",
      candidate: plainFinalization(),
    })).toMatchObject({ outcome: "accepted" });
    db.exec(`
      CREATE TRIGGER pause_finalization_completion
      BEFORE INSERT ON controller_digest
      BEGIN
        SELECT task8_race_pause();
      END
    `);
    db.close();
    db = undefined;
    writeFileSync(scriptPath, raceWorkerSource());
    mkdirSync(barrierDir);
    workers.push(
      startRaceWorker(scriptPath, seeded.databasePath, barrierDir, "0", "completion"),
      startRaceWorker(scriptPath, seeded.databasePath, barrierDir, "1", "completion"),
    );

    const results = await releaseRace(barrierDir, workers);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["completed", "stale"]);

    db = new Database(seeded.databasePath);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM controller_digest WHERE controller_key = 'controller_race'",
    ).get()).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM outbox WHERE logical_key = 'controller:turn_race:reply'",
    ).get()).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM controller_finalizations WHERE turn_id = 'turn_race' AND consumed_at IS NOT NULL",
    ).get()).toEqual({ count: 1 });
  } finally {
    stopRaceWorkers(workers);
    db?.close();
    await disposeHost?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("claims one continuation and sends one recovery prompt across SQLite workers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "telegram-task9-race-continuation-"));
  const barrierDir = resolve(directory, "barriers");
  const scriptPath = resolve(directory, "race-worker.ts");
  let db: Database.Database | undefined;
  let disposeHost: (() => Promise<void>) | undefined;
  const workers: RaceWorker[] = [];
  try {
    const seeded = seededRaceDatabase();
    disposeHost = seeded.disposeHost;
    db = seeded.db;
    db.exec(`
      CREATE TRIGGER pause_continuation_claim
      BEFORE UPDATE OF completion_continuations ON controller_turns
      WHEN NEW.id = 'turn_race' AND NEW.completion_continuations = 1
      BEGIN
        SELECT task8_race_pause();
      END
    `);
    db.close();
    db = undefined;
    writeFileSync(scriptPath, raceWorkerSource());
    mkdirSync(barrierDir);
    workers.push(
      startRaceWorker(scriptPath, seeded.databasePath, barrierDir, "0", "continuation"),
      startRaceWorker(scriptPath, seeded.databasePath, barrierDir, "1", "continuation"),
    );

    const results = await releaseRace(barrierDir, workers);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["already_claimed", "claimed"]);
    const sentLabels = ["0", "1"].filter((label) => existsSync(resolve(barrierDir, `sent-${label}`)));
    expect(sentLabels).toHaveLength(1);
    expect(readFileSync(resolve(barrierDir, `sent-${sentLabels[0]}`), "utf8"))
      .toBe("Your previous turn ended without an accepted telegram_agent_respond call. Inspect telegram_agent_turn_evidence, correct any rejected finalization, and make telegram_agent_respond your final action now. Do not repeat a side effect.");

    db = new Database(seeded.databasePath);
    expect(db.prepare(
      "SELECT completion_continuations FROM controller_turns WHERE id = 'turn_race'",
    ).get()).toEqual({ completion_continuations: 1 });
  } finally {
    stopRaceWorkers(workers);
    db?.close();
    await disposeHost?.();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("retains a continuation claim after a worker crashes before send", async () => {
  const directory = mkdtempSync(join(tmpdir(), "telegram-task9-crash-continuation-"));
  const barrierDir = resolve(directory, "barriers");
  const scriptPath = resolve(directory, "race-worker.ts");
  let db: Database.Database | undefined;
  let disposeHost: (() => Promise<void>) | undefined;
  const workers: RaceWorker[] = [];
  try {
    const seeded = seededRaceDatabase();
    disposeHost = seeded.disposeHost;
    db = seeded.db;
    db.close();
    db = undefined;
    writeFileSync(scriptPath, raceWorkerSource());
    mkdirSync(barrierDir);
    const worker = startRaceWorker(scriptPath, seeded.databasePath, barrierDir, "0", "crash");
    workers.push(worker);
    await waitForFile(resolve(barrierDir, "ready-0"));
    writeFileSync(resolve(barrierDir, "go"), "go");
    await waitForFile(resolve(barrierDir, "attempting-0"));
    await expect(worker.result).rejects.toThrow(/race worker exited 42/);
    expect(existsSync(resolve(barrierDir, "crashed-after-claim-0"))).toBe(true);
    expect(existsSync(resolve(barrierDir, "sent-0"))).toBe(false);

    db = new Database(seeded.databasePath);
    expect(db.prepare(
      "SELECT completion_continuations FROM controller_turns WHERE id = 'turn_race'",
    ).get()).toEqual({ completion_continuations: 1 });
  } finally {
    stopRaceWorkers(workers);
    db?.close();
    await disposeHost?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
