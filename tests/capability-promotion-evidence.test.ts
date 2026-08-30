import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  type DurableRecipePromotionEvidenceSnapshot,
  DurableRecipePromotionEvidenceReader,
  promotionDeterministicRecordDigest,
  promotionLiveReceiptDigest,
  promotionLiveRunDigest,
  resolveDurableRecipePromotionEvidence,
} from "../src/capabilities/promotion-evidence";
import {
  RecipePromotionService,
  emptyRecipePromotionEvidence,
} from "../src/capabilities/promotion";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { registerWorkArtifactRelationshipValidation } from "../src/work-artifacts/repository";
import { openStore } from "../src/storage/store";
import { insertResolvedPromotionLedgerFixture } from "./promotion-evidence-fixture";

type ManifestRow = Readonly<{
  recipe: string;
  deterministic_ids_json: string;
  classifier_id: string | null;
  live_run_ids_json: string;
  candidate_model_ref_ids_json: string;
  baseline_model_ref_ids_json: string;
  safety_ids_json: string;
  created_at: number;
}>;

let manifestTamperSequence = 0;

function latestManifest(db: Database.Database): ManifestRow {
  const row = db.prepare(
    `SELECT recipe, deterministic_ids_json, classifier_id, live_run_ids_json,
            candidate_model_ref_ids_json, baseline_model_ref_ids_json, safety_ids_json, created_at
       FROM recipe_promotion_evidence_manifests
      ORDER BY sequence DESC LIMIT 1`,
  ).get() as ManifestRow | undefined;
  if (!row) throw new Error("promotion manifest missing");
  return row;
}

function appendManifest(
  db: Database.Database,
  current: ManifestRow,
  patch: Partial<ManifestRow>,
): void {
  const next = { ...current, ...patch };
  db.prepare(
    `INSERT INTO recipe_promotion_evidence_manifests (
       id, recipe, deterministic_ids_json, classifier_id, live_run_ids_json,
       candidate_model_ref_ids_json, baseline_model_ref_ids_json, safety_ids_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `manifest-tamper-${manifestTamperSequence++}`,
    next.recipe,
    next.deterministic_ids_json,
    next.classifier_id,
    next.live_run_ids_json,
    next.candidate_model_ref_ids_json,
    next.baseline_model_ref_ids_json,
    next.safety_ids_json,
    current.created_at + 1_000,
  );
}

function promotionSnapshot(
  store: ReturnType<typeof openStore>,
): DurableRecipePromotionEvidenceSnapshot {
  const snapshot = store.readDurableRecipePromotionEvidenceSnapshot("direct");
  if (snapshot === null) throw new Error("promotion snapshot missing");
  return structuredClone(snapshot) as DurableRecipePromotionEvidenceSnapshot;
}

function liveTimeline(snapshot: DurableRecipePromotionEvidenceSnapshot) {
  const run = snapshot.liveRuns[0];
  const failure = snapshot.liveReceipts.find((receipt) => receipt.receiptKind === "induced_failure");
  const recovery = snapshot.liveReceipts.find((receipt) => receipt.receiptKind === "recovery");
  const job = run ? snapshot.jobs.find((candidate) => candidate.id === run.jobId) : undefined;
  const failedTrial = failure
    ? snapshot.modelTrials.find((trial) => trial.id === failure.modelTrialId)
    : undefined;
  const recoveredTrial = recovery
    ? snapshot.modelTrials.find((trial) => trial.id === recovery.modelTrialId)
    : undefined;
  if (!run || !failure || !recovery || !job || !failedTrial || !recoveredTrial) {
    throw new Error("promotion timeline fixture missing");
  }
  return { run, failure, recovery, job, failedTrial, recoveredTrial };
}

function refreshLiveRunDigest(snapshot: DurableRecipePromotionEvidenceSnapshot): void {
  const { run, failure, recovery, job, failedTrial, recoveredTrial } = liveTimeline(snapshot);
  if (job.mergeCommitSha === null || job.mergedAt === null) {
    throw new Error("promotion merge fixture missing");
  }
  run.evidenceDigest = promotionLiveRunDigest({
    runId: run.id,
    jobId: run.jobId,
    recipe: "direct",
    mergeCommitSha: job.mergeCommitSha,
    mergedAt: job.mergedAt,
    inducedFailureReceiptId: failure.id,
    recoveryReceiptId: recovery.id,
    inducedFailureTrialId: failedTrial.id,
    recoveryTrialId: recoveredTrial.id,
  });
}

function refreshLiveReceiptDigest(
  snapshot: DurableRecipePromotionEvidenceSnapshot,
  receiptKind: "induced_failure" | "recovery",
): void {
  const { failure, recovery, failedTrial, recoveredTrial } = liveTimeline(snapshot);
  const receipt = receiptKind === "induced_failure" ? failure : recovery;
  const trial = receiptKind === "induced_failure" ? failedTrial : recoveredTrial;
  if (trial.outcome === "selected" || trial.settledAt === null) {
    throw new Error("terminal promotion trial fixture missing");
  }
  receipt.evidenceDigest = promotionLiveReceiptDigest({
    receiptKind, runId: receipt.runId, jobId: receipt.jobId, modelTrialId: trial.id,
    trialOutcome: trial.outcome, failureSignature: trial.failureSignature,
    trialSettledAt: trial.settledAt,
  });
}

function fixture(id: string) {
  const { bb } = createFakePluginHost({ pluginId: id });
  const store = openStore(bb.storage);
  const db = bb.storage.database();
  const reader = new DurableRecipePromotionEvidenceReader(store);
  return { bb, db, reader, store };
}

function resolvedFixture(id: string) {
  const current = fixture(`promotion-evidence-${id}`);
  const recorded = insertResolvedPromotionLedgerFixture({ ...current, prefix: id });
  return { ...current, recorded };
}

describe("trusted durable recipe promotion evidence", () => {
  it("adds settlement timestamps only in the append-only tail migration", () => {
    const { bb } = createFakePluginHost({ pluginId: "promotion-evidence-tail-upgrade" });
    const db = bb.storage.database();
    bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, 38));
    expect(db.prepare("PRAGMA table_info(model_route_trials)").all()).not.toContainEqual(
      expect.objectContaining({ name: "settled_at" }),
    );
    db.prepare(
      `INSERT INTO model_route_trials (
         id, subject_kind, subject_id, attempt, pool, provider_id, model_id, reasoning,
         service_tier, stage, operation, failure_signature, outcome, created_at
       ) VALUES (
         'legacy-terminal-trial', 'worker_attempt', 'legacy-attempt', 1, 'standard',
         'codex', 'legacy-model', 'high', 'default', 'implementation', 'legacy',
         NULL, 'passed', 100
       )`,
    ).run();

    registerWorkArtifactRelationshipValidation(db);
    bb.storage.migrate(db, [...ALL_MIGRATIONS]);

    expect(db.prepare("PRAGMA table_info(model_route_trials)").all()).toContainEqual(
      expect.objectContaining({ name: "settled_at" }),
    );
    expect(db.prepare(
      "SELECT outcome, settled_at FROM model_route_trials WHERE id = 'legacy-terminal-trial'",
    ).get()).toEqual({ outcome: "passed", settled_at: null });
    expect(() => db.prepare(
      `INSERT INTO model_route_trials (
         id, subject_kind, subject_id, attempt, pool, provider_id, model_id, reasoning,
         service_tier, stage, operation, failure_signature, outcome, created_at
       ) VALUES (
         'future-unsettled-trial', 'worker_attempt', 'future-attempt', 1, 'standard',
         'codex', 'future-model', 'high', 'default', 'implementation', 'future',
         NULL, 'passed', 200
       )`,
    ).run()).toThrow(/settlement timestamp/u);
  });

  it("stays incomplete when no authoritative manifest exists", async () => {
    const { reader, store } = fixture("promotion-evidence-empty");
    expect(reader.read("direct")).toBeNull();

    const service = new RecipePromotionService({
      store,
      readEvidence: (recipe) => reader.read(recipe),
      now: () => 3_000,
    });
    expect(await service.status("direct")).toMatchObject({ status: "incomplete", ready: false });
    await expect(service.promote("direct")).rejects.toMatchObject({
      assessment: { status: "incomplete", ready: false },
    });
    expect(store.listRecipeRolloutDecisions("direct", 10)).toEqual([]);
  });

  it("reconstructs linked durable evidence across restart", () => {
    const { bb, reader, recorded } = resolvedFixture("complete");

    expect(reader.read("direct")).toEqual(recorded);
    expect(recorded.liveRuns[0]).toMatchObject({
      jobId: "job-complete",
      recipe: "direct",
      terminalState: "merged",
      inducedFailureReceiptId: expect.stringMatching(/^promotion-live-receipt-/u),
      recoveryReceiptId: expect.stringMatching(/^promotion-live-receipt-/u),
    });
    expect(recorded.baselineModelTrials).toContainEqual(expect.objectContaining({ outcome: "failed" }));
    expect(new DurableRecipePromotionEvidenceReader(openStore(bb.storage)).read("direct")).toEqual(recorded);
  });

  it("keeps durable evidence rows append-only", () => {
    const { db } = resolvedFixture("append-only");
    const deterministicId = db.prepare(
      "SELECT id FROM recipe_deterministic_evidence ORDER BY created_at ASC LIMIT 1",
    ).get() as { id: string };
    expect(() => db.prepare(
      "UPDATE recipe_deterministic_evidence SET outcome = 'failed' WHERE id = ?",
    ).run(deterministicId.id)).toThrow(/append-only/u);
  });

  it("allows promotion only from fully linked durable evidence", async () => {
    const { reader, store } = resolvedFixture("promotion-ready");
    const service = new RecipePromotionService({
      store,
      readEvidence: (recipe) => reader.read(recipe),
      now: () => 3_000,
    });
    await expect(service.promote("direct")).resolves.toMatchObject({
      recipe: "direct",
      action: "promote",
    });
  });

  it.each([
    ["missing", (db: Database.Database, manifest: ManifestRow) => {
      appendManifest(db, manifest, { classifier_id: "promotion_classifier:missing" });
    }],
    ["duplicate", (db: Database.Database, manifest: ManifestRow) => {
      const ids = JSON.parse(manifest.deterministic_ids_json) as string[];
      appendManifest(db, manifest, { deterministic_ids_json: JSON.stringify([...ids, ids[0]]) });
    }],
    ["duplicate-category", (db: Database.Database, manifest: ManifestRow) => {
      const createdAt = manifest.created_at - 1;
      const duplicate = {
        recipe: "direct" as const,
        category: "descriptor" as const,
        suiteId: "suite-duplicate-category",
        runId: "run-duplicate-category",
        artifactDigest: "c".repeat(64),
        outcome: "passed" as const,
        createdAt,
      };
      db.prepare(
        `INSERT INTO recipe_deterministic_evidence (
           id, recipe, category, suite_id, run_id, artifact_digest, outcome, record_digest, created_at
         ) VALUES ('promotion_deterministic:duplicate-category', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        duplicate.recipe, duplicate.category, duplicate.suiteId, duplicate.runId,
        duplicate.artifactDigest, duplicate.outcome,
        promotionDeterministicRecordDigest(duplicate), createdAt,
      );
      const ids = JSON.parse(manifest.deterministic_ids_json) as string[];
      appendManifest(db, manifest, {
        deterministic_ids_json: JSON.stringify([...ids, "promotion_deterministic:duplicate-category"]),
      });
    }],
    ["cross-recipe", (db: Database.Database, manifest: ManifestRow) => {
      db.prepare(
        `INSERT INTO recipe_deterministic_evidence (
           id, recipe, category, suite_id, run_id, artifact_digest, outcome, record_digest, created_at
         ) VALUES (?, 'bounded', 'descriptor', ?, ?, ?, 'passed', ?, ?)`,
      ).run(
        "promotion_deterministic:cross",
        "suite-cross",
        "run-cross",
        "c".repeat(64),
        promotionDeterministicRecordDigest({
          recipe: "bounded",
          category: "descriptor",
          suiteId: "suite-cross",
          runId: "run-cross",
          artifactDigest: "c".repeat(64),
          outcome: "passed",
          createdAt: manifest.created_at - 1,
        }),
        manifest.created_at - 1,
      );
      const ids = JSON.parse(manifest.deterministic_ids_json) as string[];
      appendManifest(db, manifest, {
        deterministic_ids_json: JSON.stringify(["promotion_deterministic:cross", ...ids.slice(1)]),
      });
    }],
  ] as const)("fails closed on a %s manifest reference", (_name, corrupt) => {
    const { db, reader, store } = fixture(`promotion-evidence-${_name}`);
    insertResolvedPromotionLedgerFixture({ db, store, prefix: _name });
    corrupt(db, latestManifest(db));

    expect(reader.read("direct")).toBeNull();
    expect(reader.read("bounded")).toBeNull();
  });

  it("rejects live receipt claims whose terminal trial does not prove the claimed outcome", () => {
    const { store } = resolvedFixture("mismatched-receipt");
    const snapshot = promotionSnapshot(store);
    const { failure, recovery, recoveredTrial } = liveTimeline(snapshot);
    failure.modelTrialId = recoveredTrial.id;
    failure.evidenceDigest = promotionLiveReceiptDigest({
      receiptKind: "induced_failure", runId: failure.runId, jobId: failure.jobId,
      modelTrialId: recoveredTrial.id, trialOutcome: "passed", failureSignature: null,
      trialSettledAt: recoveredTrial.settledAt!,
    });
    refreshLiveRunDigest(snapshot);
    expect(recovery.modelTrialId).toBe(recoveredTrial.id);

    expect(resolveDurableRecipePromotionEvidence("direct", snapshot)).toBeNull();
  });

  it("rejects reversed or non-causal failure and recovery trial chronology", () => {
    const { store } = resolvedFixture("reversed-trials");
    const snapshot = promotionSnapshot(store);
    const { failedTrial, recoveredTrial } = liveTimeline(snapshot);
    failedTrial.settledAt = recoveredTrial.settledAt! + 1;
    refreshLiveReceiptDigest(snapshot, "induced_failure");

    expect(resolveDurableRecipePromotionEvidence("direct", snapshot)).toBeNull();
  });

  it("rejects recovery evidence recorded after the job was merged", () => {
    const { db, store } = fixture("promotion-evidence-recovery-after-merge");
    insertResolvedPromotionLedgerFixture({ db, store, prefix: "recovery-after-merge" });
    const snapshot = promotionSnapshot(store);
    const { recovery, job } = liveTimeline(snapshot);
    job.mergedAt = new Date(recovery.createdAt - 1).toISOString();
    refreshLiveRunDigest(snapshot);

    expect(resolveDurableRecipePromotionEvidence("direct", snapshot)).toBeNull();
  });

  it.each([
    ["failure terminal and receipt", (snapshot: DurableRecipePromotionEvidenceSnapshot) => {
      const { failure, failedTrial } = liveTimeline(snapshot);
      failure.createdAt = failedTrial.settledAt!;
    }],
    ["recovery terminal and receipt", (snapshot: DurableRecipePromotionEvidenceSnapshot) => {
      const { recovery, recoveredTrial } = liveTimeline(snapshot);
      recovery.createdAt = recoveredTrial.settledAt!;
    }],
    ["recovery receipt and merge", (snapshot: DurableRecipePromotionEvidenceSnapshot) => {
      const { recovery, job } = liveTimeline(snapshot);
      job.mergedAt = new Date(recovery.createdAt).toISOString();
      refreshLiveRunDigest(snapshot);
    }],
    ["merge and live run", (snapshot: DurableRecipePromotionEvidenceSnapshot) => {
      const { run, job } = liveTimeline(snapshot);
      job.mergedAt = new Date(run.createdAt).toISOString();
      refreshLiveRunDigest(snapshot);
    }],
    ["live run and manifest", (snapshot: DurableRecipePromotionEvidenceSnapshot) => {
      const { run } = liveTimeline(snapshot);
      run.createdAt = snapshot.manifest.createdAt;
    }],
  ] as const)("rejects equality between %s", (_boundary, makeEqual) => {
    const { db, store } = fixture(`promotion-evidence-equal-${manifestTamperSequence++}`);
    insertResolvedPromotionLedgerFixture({ db, store, prefix: `equal-${manifestTamperSequence++}` });
    const snapshot = promotionSnapshot(store);
    makeEqual(snapshot);

    expect(resolveDurableRecipePromotionEvidence("direct", snapshot)).toBeNull();
  });

  it("rejects legacy terminal trials without an authoritative settlement time", () => {
    const { db, store } = fixture("promotion-evidence-legacy-terminal");
    insertResolvedPromotionLedgerFixture({ db, store, prefix: "legacy-terminal" });
    const snapshot = promotionSnapshot(store);
    const { recoveredTrial } = liveTimeline(snapshot);
    recoveredTrial.settledAt = null;

    expect(resolveDurableRecipePromotionEvidence("direct", snapshot)).toBeNull();
  });

  it.each([
    ["zero safety envelope", (snapshot: DurableRecipePromotionEvidenceSnapshot) => {
      const safety = snapshot.safetyCounters.find((record) => record.counter === "policy_bypasses");
      if (!safety) throw new Error("safety fixture missing");
      safety.count = 0;
      safety.evidenceDigest = "0".repeat(64);
    }],
    ["passed deterministic row", (snapshot: DurableRecipePromotionEvidenceSnapshot) => {
      const deterministic = snapshot.deterministic.find((record) => record.category === "descriptor");
      if (!deterministic) throw new Error("deterministic fixture missing");
      deterministic.outcome = "passed";
      deterministic.artifactDigest = "0".repeat(64);
    }],
  ] as const)("rejects a forged %s", (_claim, forge) => {
    const { store } = resolvedFixture(`forged-${manifestTamperSequence++}`);
    const snapshot = promotionSnapshot(store);
    forge(snapshot);

    expect(resolveDurableRecipePromotionEvidence("direct", snapshot)).toBeNull();
  });

  it("does not fall back to an older valid manifest after the newest manifest is invalid", () => {
    const { db, reader, store } = fixture("promotion-evidence-no-fallback");
    const recorded = insertResolvedPromotionLedgerFixture({ db, store, prefix: "no-fallback" });
    expect(reader.read("direct")).toEqual(recorded);
    appendManifest(db, latestManifest(db), { live_run_ids_json: JSON.stringify(["missing-live-run"]) });

    expect(reader.read("direct")).toBeNull();
    expect(emptyRecipePromotionEvidence("direct").liveRuns).toEqual([]);
  });

  it("exposes no production API that can turn a typed passed/safety envelope into evidence", () => {
    const { store } = fixture("promotion-evidence-no-typed-ingestion");
    expect("appendRecipePromotionEvidenceBundle" in store).toBe(false);
  });
});
