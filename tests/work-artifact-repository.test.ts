import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { parseReferenceSections } from "../src/reference/document";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import {
  WorkArtifactRepository,
  WorkArtifactObservationConflictError,
  stableWorkArtifactId,
  workArtifactReferenceDocument,
  type CaptureWorkArtifactInput,
} from "../src/work-artifacts/repository";

let fixtureNumber = 0;
let evidenceNumber = 0;

type Fixture = Readonly<{
  db: Database.Database;
  store: TelegramAgentStore;
  repository: WorkArtifactRepository;
}>;

function fixture(): Fixture {
  const fixtureId = fixtureNumber++;
  const { bb } = createFakePluginHost({ pluginId: `work-artifacts-${fixtureId}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 1_000);
  const pairingHash = hashSecret("pair-work-artifacts");
  store.createPairingCode(pairingHash, 900, 10_000);
  if (!store.pairOwnerWithCode(pairingHash, "7", "7", 901).ok) {
    throw new Error("work artifact fixture owner was not paired");
  }
  const db = bb.storage.database();
  store.createJob({
    id: "job_1",
    sourceUpdateId: 80_000 + fixtureId,
    requestText: "Execute the claimed workflow step.",
    now: 900,
  });
  db.prepare("UPDATE jobs SET project_id = 'proj_1', state = 'implementing' WHERE id = 'job_1'")
    .run();
  return { db, store, repository: new WorkArtifactRepository(db) };
}

function artifactInput(
  operationId: string,
  externalId: string,
  overrides: Partial<CaptureWorkArtifactInput> = {},
): CaptureWorkArtifactInput {
  return {
    artifactId: stableWorkArtifactId("proj_1", operationId),
    projectId: "proj_1",
    effortId: "effort_1",
    operationId,
    kind: "implementation_ticket",
    status: "ready",
    trackerKind: "github",
    trackerNamespace: "github:acme/widgets",
    externalId,
    externalUrl: `https://github.com/acme/widgets/issues/${externalId}`,
    externalRevision: "etag-1",
    externalStatus: "open",
    assignees: [],
    title: `Ticket ${externalId}`,
    content: "# Goal\r\n\r\n  Ship the smallest useful slice.  \r\n",
    acceptanceCriteria: ["Tests pass", "The slice is deployed"],
    relationships: [],
    capturedAt: 1_000,
    ...overrides,
  };
}

function recordArtifactEvidence(
  store: TelegramAgentStore,
  input: Readonly<{
    artifactId: string;
    snapshotId: string;
    ownerId: string;
    generation: number;
    now: number;
    outcome?: "observed" | "succeeded" | "denied";
  }>,
): `evidence:${number}` {
  const ordinal = evidenceNumber++;
  const controllerKey = `work-artifact-controller-${ordinal}`;
  const turn = store.enqueueControllerTurn({
    controllerKey,
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 90_000 + ordinal,
    inputText: "Record work artifact acceptance evidence.",
    now: input.now,
  });
  const fence = {
    ownerId: input.ownerId,
    generation: input.generation,
    now: input.now,
  };
  // The executor leases here are shorter than the burst quiet gap, so the
  // claim waits past the gap under a renewed lease.
  store.renewExecutorLease(input.ownerId, input.generation, input.now, 10_000);
  if (store.claimNextControllerTurn({ ...fence, now: input.now + 3_000 })?.id !== turn.id) {
    throw new Error("controller evidence turn was not claimed");
  }
  if (!store.reserveControllerSpawn({
    controllerKey,
    turnId: turn.id,
    projectId: "proj_1",
    hostId: "host_1",
    now: input.now,
  })) throw new Error("controller evidence spawn was not reserved");
  if (!store.markControllerSpawned({
    ...fence,
    turnId: turn.id,
    projectId: "proj_1",
    hostId: "host_1",
    threadId: `thr_work_artifact_${ordinal}`,
    spawnToken: turn.id,
  })) throw new Error("controller evidence turn was not spawned");
  if (!store.markControllerTurnSubmitted({ ...fence, turnId: turn.id })) {
    throw new Error("controller evidence turn was not submitted");
  }
  const recorded = store.recordControllerEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey,
    sourceKind: "hanoon_tool",
    sourceName: "work_artifact_acceptance",
    sourceItemId: null,
    outcome: input.outcome ?? "succeeded",
    argsSha256: "a".repeat(64),
    resultSha256: "b".repeat(64),
    proofKinds: ["obligation"],
    subjectRefs: [
      `work-artifact:${input.artifactId}`,
      `work-artifact-snapshot:${input.snapshotId}`,
    ],
  });
  if (recorded.outcome !== "recorded" && recorded.outcome !== "duplicate") {
    throw new Error(`controller evidence was ${recorded.outcome}`);
  }
  return recorded.evidence.ref;
}

function authorizeAndFinalize(
  repository: WorkArtifactRepository,
  input: Readonly<{
    artifactId: string;
    evidenceRef: string;
    operationId: string;
    now: number;
    outcome?: "resolved" | "cancelled";
  }>,
) {
  const artifact = repository.getArtifact(input.artifactId);
  const snapshot = repository.getCurrentSnapshot(input.artifactId);
  if (!artifact || !snapshot) throw new Error("artifact resolution fixture disappeared");
  const outcome = input.outcome ?? "resolved";
  const intent = repository.authorizeArtifactResolution({
    artifactId: artifact.id,
    operationId: input.operationId,
    outcome,
    snapshotId: snapshot.id,
    expectedExternalRevision: artifact.externalRevision,
    evidenceRefs: [input.evidenceRef],
    now: input.now,
  });
  if (!intent) throw new Error("artifact resolution was not authorized");
  const externalRevision = `${artifact.externalRevision}:${outcome}:${input.operationId}`;
  repository.observeArtifact({
    artifactId: artifact.id,
    expectedExternalRevision: artifact.externalRevision,
    externalRevision,
    externalStatus: outcome === "resolved" ? "closed" : "cancelled",
    assignees: [],
    title: snapshot.title,
    content: snapshot.content,
    acceptanceCriteria: snapshot.acceptanceCriteria,
    relationships: snapshot.relationships,
    observedAt: input.now + 1,
  });
  return repository.finalizeArtifactResolution({
    intentId: intent.id,
    externalRevision,
    now: input.now + 2,
  });
}

describe("WorkArtifactRepository", () => {
  it("persists an immutable create intent before an external identity exists", () => {
    const { db, repository } = fixture();
    const artifactId = stableWorkArtifactId("proj_1", "create-intent");
    const input = {
      artifactId,
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "create-intent",
      trackerKind: "github" as const,
      trackerNamespace: "github:acme/widgets",
      trackerOperationId: "tracker:create:create-intent",
      createDigest: "c".repeat(64),
      ownerId: "executor-a",
      generation: 1,
      now: 1_000,
    };

    const created = repository.prepareCreateIntent(input);
    expect(created).toMatchObject({
      artifactId,
      trackerKind: "github",
      trackerNamespace: "github:acme/widgets",
      trackerOperationId: "tracker:create:create-intent",
      createDigest: "c".repeat(64),
    });
    expect(repository.getArtifact(artifactId)).toBeNull();
    expect(repository.prepareCreateIntent({
      ...input,
      ownerId: "executor-b",
      generation: 2,
      now: 2_000,
    })).toEqual(created);
    expect(() => repository.prepareCreateIntent({
      ...input,
      trackerNamespace: "github:acme/other",
      ownerId: "executor-b",
      generation: 2,
      now: 2_000,
    })).toThrow(/create intent identity changed/iu);
    expect(() => db.prepare(
      "UPDATE work_artifact_create_intents SET tracker_namespace = 'github:acme/other' WHERE artifact_id = ?",
    ).run(artifactId)).toThrow(/append-only/iu);
  });

  it("persists stable artifacts, immutable normalized snapshots, and typed relationships", () => {
    const { db, repository, store } = fixture();
    const parent = repository.captureArtifact(artifactInput("create-parent", "40", {
      artifactId: stableWorkArtifactId("proj_1", "create-parent"),
      kind: "specification",
      title: "Canonical specification",
      content: "# Scope\n\nBuild the workflow substrate.",
      acceptanceCriteria: ["A tracker artifact exists"],
    }));
    const childId = stableWorkArtifactId("proj_1", "create-child");
    const child = repository.captureArtifact(artifactInput("create-child", "41", {
      artifactId: childId,
      relationships: [
        {
          kind: "parent",
          sourceArtifactId: childId,
          sourceRef: `artifact:${childId}`,
          targetArtifactId: parent.artifact.id,
          targetRef: `artifact:${parent.artifact.id}`,
        },
        {
          kind: "derived_from",
          sourceArtifactId: childId,
          sourceRef: `artifact:${childId}`,
          targetArtifactId: parent.artifact.id,
          targetRef: `artifact:${parent.artifact.id}`,
        },
        {
          kind: "executed_by",
          sourceArtifactId: childId,
          sourceRef: `artifact:${childId}`,
          targetArtifactId: null,
          targetRef: "job:job_1",
        },
        {
          kind: "delivered_by",
          sourceArtifactId: childId,
          sourceRef: `artifact:${childId}`,
          targetArtifactId: null,
          targetRef: "pull-request:44",
        },
      ],
    }));

    expect(child.artifact).toMatchObject({
      id: childId,
      projectId: "proj_1",
      effortId: "effort_1",
      kind: "implementation_ticket",
      status: "ready",
      trackerKind: "github",
      trackerNamespace: "github:acme/widgets",
      externalId: "41",
      currentRevision: 1,
    });
    expect(child.snapshot).toMatchObject({
      artifactId: childId,
      revision: 1,
      title: "Ticket 41",
      content: "# Goal\n\n  Ship the smallest useful slice.",
      acceptanceCriteria: ["Tests pass", "The slice is deployed"],
      externalRevision: "etag-1",
      capturedAt: 1_000,
    });
    expect(child.snapshot.contentDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(child.snapshot.snapshotDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(repository.listRelationships(childId).map((edge) => edge.kind)).toEqual([
      "delivered_by",
      "derived_from",
      "executed_by",
      "parent",
    ]);
    expect(repository.getArtifactByExternalIdentity("proj_1", "github:acme/widgets", "41")?.id)
      .toBe(childId);
    expect(store.getWorkArtifact(childId)?.currentSnapshotId).toBe(child.snapshot.id);
    expect(repository.captureArtifact(artifactInput("create-child", "41", {
      artifactId: childId,
      relationships: child.snapshot.relationships,
    })).snapshot.id).toBe(child.snapshot.id);
    expect(() => repository.preflightArtifactCapture({
      artifactId: childId,
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "create-child",
      kind: "implementation_ticket",
      status: "open",
      trackerKind: "github",
      trackerNamespace: "github:acme/widgets",
      title: child.snapshot.title,
      trackerOrder: 0,
      content: child.snapshot.content,
      acceptanceCriteria: child.snapshot.acceptanceCriteria,
      relationships: child.snapshot.relationships,
      capturedAt: 1_001,
    })).toThrow(/identity changed/iu);
    expect(() => repository.captureArtifact(artifactInput("create-child", "41", {
      artifactId: childId,
      status: "ready",
      trackerOrder: 1,
      relationships: child.snapshot.relationships,
    }))).toThrow(/identity changed/iu);

    expect(() => db.prepare(
      "UPDATE work_artifact_snapshots SET content = 'rewritten' WHERE id = ?",
    ).run(child.snapshot.id)).toThrow(/append-only/i);
    expect(() => repository.captureArtifact(artifactInput("different-operation", "41")))
      .toThrow(/external identity/i);

    const reference = workArtifactReferenceDocument(child.artifact, child.snapshot, 2_000);
    expect(reference).toMatchObject({
      scope: "project",
      projectId: "proj_1",
      title: `Work artifact ${childId}`,
      source: `work-artifact:${childId}`,
      markdown: child.snapshot.content,
    });
    expect(parseReferenceSections(reference.markdown)[0]?.path).toEqual(["Goal"]);
  });

  it("keeps reference projections artifact-scoped across title edits and collisions", () => {
    const { repository, store } = fixture();
    const first = repository.captureArtifact(artifactInput("reference-first", "201", {
      title: "Shared visible title",
      content: "# Goal\n\nFirst artifact body.",
    }));
    const second = repository.captureArtifact(artifactInput("reference-second", "202", {
      title: "Shared visible title",
      content: "# Goal\n\nSecond artifact body.",
    }));
    store.saveReferenceDocument(workArtifactReferenceDocument(first.artifact, first.snapshot, 2_000));
    store.saveReferenceDocument(workArtifactReferenceDocument(second.artifact, second.snapshot, 2_000));
    const revised = repository.observeArtifact({
      artifactId: first.artifact.id,
      expectedExternalRevision: first.artifact.externalRevision,
      externalRevision: "etag-reference-revised",
      externalStatus: "open",
      assignees: [],
      title: "Renamed visible title",
      content: "# Goal\n\nRevised first artifact body.",
      acceptanceCriteria: first.snapshot.acceptanceCriteria,
      relationships: first.snapshot.relationships,
      observedAt: 2_010,
    });
    store.saveReferenceDocument(workArtifactReferenceDocument(revised.artifact, revised.snapshot, 2_020));

    const references = store.listReferenceDocuments("proj_1")
      .filter((document) => document.source.startsWith("work-artifact:"));
    expect(references).toHaveLength(2);
    expect(references.find((document) => document.source === `work-artifact:${first.artifact.id}`))
      .toMatchObject({ version: 2, title: `Work artifact ${first.artifact.id}` });
    expect(store.searchReferencePassages({
      query: "Revised first artifact body",
      projectId: "proj_1",
      limit: 8,
    }).some((passage) => passage.body.includes("Revised first artifact body"))).toBe(true);
    expect(store.searchReferencePassages({
      query: "First artifact body",
      projectId: "proj_1",
      limit: 8,
    }).some((passage) => passage.body === "First artifact body.")).toBe(false);
  });

  it("rejects relationships that escape the owning project or effort", () => {
    const { db, repository } = fixture();
    const foreignProject = repository.captureArtifact(artifactInput("foreign-project", "90", {
      artifactId: stableWorkArtifactId("proj_2", "foreign-project"),
      projectId: "proj_2",
      effortId: "effort_1",
    }));
    const foreignEffort = repository.captureArtifact(artifactInput("foreign-effort", "91", {
      artifactId: stableWorkArtifactId("proj_1", "foreign-effort"),
      effortId: "effort_2",
    }));
    const childId = stableWorkArtifactId("proj_1", "scoped-child");
    const relationship = (targetArtifactId: string) => [{
      kind: "parent" as const,
      sourceArtifactId: childId,
      sourceRef: `artifact:${childId}`,
      targetArtifactId,
      targetRef: `artifact:${targetArtifactId}`,
    }];

    expect(() => repository.captureArtifact(artifactInput("scoped-child", "92", {
      artifactId: childId,
      relationships: relationship(foreignProject.artifact.id),
    }))).toThrow(/same project and effort/iu);
    expect(() => repository.captureArtifact(artifactInput("scoped-child", "92", {
      artifactId: childId,
      relationships: relationship(foreignEffort.artifact.id),
    }))).toThrow(/same project and effort/iu);

    const owner = repository.captureArtifact(artifactInput("scoped-owner", "93"));
    expect(() => db.prepare(
      `INSERT INTO work_artifact_relationships (
         owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
         target_artifact_id, target_ref, created_at
       ) VALUES (?, 0, 'parent', ?, ?, ?, ?, 1000)`,
    ).run(
      owner.artifact.id,
      owner.artifact.id,
      `artifact:${owner.artifact.id}`,
      foreignProject.artifact.id,
      `artifact:${foreignProject.artifact.id}`,
    )).toThrow(/one effort/iu);
    expect(() => db.prepare(
      `INSERT INTO work_artifact_relationships (
         owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
         target_artifact_id, target_ref, created_at
       ) VALUES (?, 0, 'parent', ?, ?, ?, ?, 1000)`,
    ).run(
      owner.artifact.id,
      owner.artifact.id,
      `artifact:${owner.artifact.id}`,
      owner.artifact.id,
      `artifact:${owner.artifact.id}`,
    )).toThrow(/cannot be self edges|canonical model/iu);
  });

  it.each([
    "source ref mismatch",
    "target ref mismatch",
    "source id with external ref",
    "target id with external ref",
    "source ref without id",
    "target ref without id",
    "malformed source reserved ref",
    "malformed target reserved ref",
    "canonical ref self edge",
  ] as const)("rejects %s before snapshot capture", (scenario) => {
    const { repository } = fixture();
    const related = repository.captureArtifact(artifactInput(`relationship-${scenario}-related`, "294"));
    const childId = stableWorkArtifactId("proj_1", `relationship-${scenario}-child`);
    const relationship: CaptureWorkArtifactInput["relationships"][number] = (() => {
      switch (scenario) {
        case "source ref mismatch":
          return {
            kind: "parent",
            sourceArtifactId: childId,
            sourceRef: `artifact:${related.artifact.id}`,
            targetArtifactId: related.artifact.id,
            targetRef: `artifact:${related.artifact.id}`,
          };
        case "target ref mismatch":
          return {
            kind: "parent",
            sourceArtifactId: childId,
            sourceRef: `artifact:${childId}`,
            targetArtifactId: related.artifact.id,
            targetRef: `artifact:${childId}`,
          };
        case "source id with external ref":
          return {
            kind: "derived_from",
            sourceArtifactId: childId,
            sourceRef: "external:not-the-owner",
            targetArtifactId: null,
            targetRef: "external:source",
          };
        case "target id with external ref":
          return {
            kind: "blocks",
            sourceArtifactId: null,
            sourceRef: "external:blocker",
            targetArtifactId: childId,
            targetRef: "external:not-the-owner",
          };
        case "source ref without id":
          return {
            kind: "derived_from",
            sourceArtifactId: null,
            sourceRef: `artifact:${childId}`,
            targetArtifactId: childId,
            targetRef: "external:source",
          };
        case "target ref without id":
          return {
            kind: "derived_from",
            sourceArtifactId: childId,
            sourceRef: `artifact:${childId}`,
            targetArtifactId: null,
            targetRef: `artifact:${related.artifact.id}`,
          };
        case "malformed source reserved ref":
          return {
            kind: "derived_from",
            sourceArtifactId: childId,
            sourceRef: "artifact:",
            targetArtifactId: null,
            targetRef: "external:target",
          };
        case "malformed target reserved ref":
          return {
            kind: "derived_from",
            sourceArtifactId: childId,
            sourceRef: `artifact:${childId}`,
            targetArtifactId: related.artifact.id,
            targetRef: "artifact:",
          };
        case "canonical ref self edge":
          return {
            kind: "derived_from",
            sourceArtifactId: childId,
            sourceRef: "external:same",
            targetArtifactId: null,
            targetRef: "external:same",
          };
      }
    })();

    expect(() => repository.captureArtifact(artifactInput(`relationship-${scenario}-child`, "295", {
      artifactId: childId,
      relationships: [relationship],
    }))).toThrow(/reserved internal ref|relate to itself/iu);
    expect(repository.getArtifact(childId)).toBeNull();
  });

  it.each([
    "source ref mismatch",
    "target ref mismatch",
    "source id with external ref",
    "target id with external ref",
    "source ref without id",
    "target ref without id",
    "malformed source reserved ref",
    "malformed target reserved ref",
    "canonical ref self edge",
  ] as const)("rejects direct database %s", (scenario) => {
    const { db, repository } = fixture();
    const owner = repository.captureArtifact(artifactInput(`database-${scenario}-owner`, "296"));
    const related = repository.captureArtifact(artifactInput(`database-${scenario}-related`, "297"));
    const values = (() => {
      switch (scenario) {
        case "source ref mismatch":
          return [
            owner.artifact.id,
            `artifact:${related.artifact.id}`,
            related.artifact.id,
            `artifact:${related.artifact.id}`,
          ] as const;
        case "target ref mismatch":
          return [
            owner.artifact.id,
            `artifact:${owner.artifact.id}`,
            related.artifact.id,
            `artifact:${owner.artifact.id}`,
          ] as const;
        case "source id with external ref":
          return [
            owner.artifact.id,
            "external:not-the-owner",
            null,
            "external:target",
          ] as const;
        case "target id with external ref":
          return [
            null,
            "external:source",
            owner.artifact.id,
            "external:not-the-owner",
          ] as const;
        case "source ref without id":
          return [null, `artifact:${owner.artifact.id}`, owner.artifact.id, "external:source"] as const;
        case "target ref without id":
          return [owner.artifact.id, `artifact:${owner.artifact.id}`, null, `artifact:${related.artifact.id}`] as const;
        case "malformed source reserved ref":
          return [owner.artifact.id, "artifact:", null, "external:target"] as const;
        case "malformed target reserved ref":
          return [owner.artifact.id, `artifact:${owner.artifact.id}`, related.artifact.id, "artifact:"] as const;
        case "canonical ref self edge":
          return [owner.artifact.id, "external:same", null, "external:same"] as const;
      }
    })();

    expect(() => db.prepare(
      `INSERT INTO work_artifact_relationships (
         owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
         target_artifact_id, target_ref, created_at
       ) VALUES (?, 0, 'derived_from', ?, ?, ?, ?, 1000)`,
    ).run(owner.artifact.id, ...values)).toThrow(/internal refs|self edges|canonical model/iu);
  });

  it.each([
    ["whitespace-prefixed reserved ref", " artifact:external-target"],
    ["NFKC-equivalent reserved ref", "ａｒｔｉｆａｃｔ:external-target"],
  ] as const)("rejects a direct database %s", (_scenario, targetRef) => {
    const { db, repository } = fixture();
    const owner = repository.captureArtifact(artifactInput(`canonical-${_scenario}-owner`, "304"));

    expect(() => db.prepare(
      `INSERT INTO work_artifact_relationships (
         owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
         target_artifact_id, target_ref, created_at
       ) VALUES (?, 0, 'derived_from', ?, ?, NULL, ?, 1000)`,
    ).run(
      owner.artifact.id,
      owner.artifact.id,
      `artifact:${owner.artifact.id}`,
      targetRef,
    )).toThrow(/relationship|reserved|canonical/iu);
  });

  it("rejects direct database relationship direction and parent cardinality violations", () => {
    const { db, repository } = fixture();
    const owner = repository.captureArtifact(artifactInput("raw-model-owner", "305"));
    const first = repository.captureArtifact(artifactInput("raw-model-first", "306"));
    const second = repository.captureArtifact(artifactInput("raw-model-second", "307"));
    const insert = db.prepare(
      `INSERT INTO work_artifact_relationships (
         owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
         target_artifact_id, target_ref, created_at
       ) VALUES (?, ?, 'parent', ?, ?, ?, ?, 1000)`,
    );

    expect(() => insert.run(
      owner.artifact.id,
      0,
      first.artifact.id,
      `artifact:${first.artifact.id}`,
      owner.artifact.id,
      `artifact:${owner.artifact.id}`,
    )).toThrow(/relationship|parent|direction/iu);

    insert.run(
      owner.artifact.id,
      0,
      owner.artifact.id,
      `artifact:${owner.artifact.id}`,
      first.artifact.id,
      `artifact:${first.artifact.id}`,
    );
    expect(() => insert.run(
      owner.artifact.id,
      1,
      owner.artifact.id,
      `artifact:${owner.artifact.id}`,
      second.artifact.id,
      `artifact:${second.artifact.id}`,
    )).toThrow(/relationship|parent|cardinality/iu);
  });

  it.each([
    "internal ref binding",
    "self edge",
    "same effort",
    "owner touch",
  ] as const)("rejects a direct relationship update that violates %s", (scenario) => {
    const { db, repository } = fixture();
    const owner = repository.captureArtifact(artifactInput(`update-${scenario}-owner`, "298"));
    const related = repository.captureArtifact(artifactInput(`update-${scenario}-related`, "299"));
    const other = repository.captureArtifact(artifactInput(`update-${scenario}-other`, "300", {
      effortId: scenario === "same effort" ? "effort_2" : "effort_1",
    }));
    db.prepare(
      `INSERT INTO work_artifact_relationships (
         owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
         target_artifact_id, target_ref, created_at
       ) VALUES (?, 0, 'derived_from', ?, ?, ?, ?, 1000)`,
    ).run(
      owner.artifact.id,
      owner.artifact.id,
      `artifact:${owner.artifact.id}`,
      related.artifact.id,
      `artifact:${related.artifact.id}`,
    );
    const before = db.prepare(
      "SELECT * FROM work_artifact_relationships WHERE owner_artifact_id = ?",
    ).get(owner.artifact.id);
    const update = (() => {
      switch (scenario) {
        case "internal ref binding":
          return ["UPDATE work_artifact_relationships SET source_ref = 'external:owner' WHERE owner_artifact_id = ?"] as const;
        case "self edge":
          return [
            "UPDATE work_artifact_relationships SET target_artifact_id = source_artifact_id, target_ref = source_ref WHERE owner_artifact_id = ?",
          ] as const;
        case "same effort":
          return [
            "UPDATE work_artifact_relationships SET target_artifact_id = ?, target_ref = ? WHERE owner_artifact_id = ?",
            other.artifact.id,
            `artifact:${other.artifact.id}`,
          ] as const;
        case "owner touch":
          return [
            "UPDATE work_artifact_relationships SET source_artifact_id = ?, source_ref = ?, target_artifact_id = ?, target_ref = ? WHERE owner_artifact_id = ?",
            related.artifact.id,
            `artifact:${related.artifact.id}`,
            other.artifact.id,
            `artifact:${other.artifact.id}`,
          ] as const;
      }
    })();
    const [sql, ...parameters] = update;

    expect(() => db.prepare(sql).run(...parameters, owner.artifact.id)).toThrow(
      /internal refs|self edges|one effort|touch their owner|canonical model/iu,
    );
    expect(db.prepare(
      "SELECT * FROM work_artifact_relationships WHERE owner_artifact_id = ?",
    ).get(owner.artifact.id)).toEqual(before);
  });

  it.each([
    ["whitespace-prefixed reserved ref", "UPDATE work_artifact_relationships SET target_artifact_id = NULL, target_ref = ' artifact:external' WHERE owner_artifact_id = ?"],
    ["NFKC-equivalent reserved ref", "UPDATE work_artifact_relationships SET target_artifact_id = NULL, target_ref = 'ａｒｔｉｆａｃｔ:external' WHERE owner_artifact_id = ?"],
    ["invalid direction", "UPDATE work_artifact_relationships SET kind = 'parent', source_artifact_id = target_artifact_id, source_ref = target_ref, target_artifact_id = owner_artifact_id, target_ref = ('artifact:' || owner_artifact_id) WHERE owner_artifact_id = ?"],
  ] as const)("rejects a direct relationship update with %s", (_scenario, sql) => {
    const { db, repository } = fixture();
    const owner = repository.captureArtifact(artifactInput(`canonical-update-${_scenario}-owner`, "308"));
    const related = repository.captureArtifact(artifactInput(`canonical-update-${_scenario}-related`, "309"));
    db.prepare(
      `INSERT INTO work_artifact_relationships (
         owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
         target_artifact_id, target_ref, created_at
       ) VALUES (?, 0, 'derived_from', ?, ?, ?, ?, 1000)`,
    ).run(
      owner.artifact.id,
      owner.artifact.id,
      `artifact:${owner.artifact.id}`,
      related.artifact.id,
      `artifact:${related.artifact.id}`,
    );
    const before = db.prepare(
      "SELECT * FROM work_artifact_relationships WHERE owner_artifact_id = ?",
    ).get(owner.artifact.id);

    expect(() => db.prepare(sql).run(owner.artifact.id))
      .toThrow(/relationship|reserved|canonical|direction|parent/iu);
    expect(db.prepare(
      "SELECT * FROM work_artifact_relationships WHERE owner_artifact_id = ?",
    ).get(owner.artifact.id)).toEqual(before);
  });

  it("validates the complete persisted relationship collection when listing", () => {
    const { db, repository } = fixture();
    const owner = repository.captureArtifact(artifactInput("corrupted-list-owner", "310"));
    const related = repository.captureArtifact(artifactInput("corrupted-list-related", "311"));
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'work_artifact_relationships'",
    ).all() as Array<{ name: string }>;
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
    db.prepare(
      `INSERT INTO work_artifact_relationships (
         owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
         target_artifact_id, target_ref, created_at
       ) VALUES (?, 0, 'parent', ?, ?, ?, ?, 1000)`,
    ).run(
      owner.artifact.id,
      related.artifact.id,
      `artifact:${related.artifact.id}`,
      owner.artifact.id,
      `artifact:${owner.artifact.id}`,
    );

    expect(() => repository.listRelationships(owner.artifact.id))
      .toThrow(/parent relationship|persisted artifact relationship/iu);
  });

  it("rejects a direct immutable snapshot insert with corrupted relationships", () => {
    const { db, repository } = fixture();
    const owner = repository.captureArtifact(artifactInput("raw-snapshot-owner", "312"));
    const relationships = JSON.stringify([{
      kind: "parent",
      sourceArtifactId: null,
      sourceRef: "external:source",
      targetArtifactId: owner.artifact.id,
      targetRef: `artifact:${owner.artifact.id}`,
    }]);

    expect(() => db.prepare(
      `INSERT INTO work_artifact_snapshots (
         id, artifact_id, revision, title, content, content_digest, snapshot_digest,
         acceptance_criteria_json, relationships_json, external_revision, captured_at
       ) VALUES (?, ?, 2, ?, ?, ?, ?, '[]', ?, 'etag-invalid-snapshot', 2000)`,
    ).run(
      "snapshot_raw_relationship_corruption",
      owner.artifact.id,
      "Corrupted raw snapshot",
      "# Goal\n\nReject invalid raw snapshot relationships.",
      "c".repeat(64),
      "d".repeat(64),
      relationships,
    )).toThrow(/snapshot|relationship|canonical/iu);
  });

  it("rejects ambiguous parent and duplicate blocker relationships before capture", () => {
    const { repository } = fixture();
    const firstParent = repository.captureArtifact(artifactInput("cardinality-parent-a", "301"));
    const secondParent = repository.captureArtifact(artifactInput("cardinality-parent-b", "302"));
    const blocker = repository.captureArtifact(artifactInput("cardinality-blocker", "303"));
    const childId = stableWorkArtifactId("proj_1", "cardinality-child");
    expect(() => repository.preflightArtifactCapture({
      artifactId: childId,
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "cardinality-child",
      kind: "implementation_ticket",
      status: "ready",
      trackerKind: "github",
      trackerNamespace: "github:acme/widgets",
      title: "Ambiguous child",
      content: "# Goal\n\nReject two parents.",
      acceptanceCriteria: [],
      relationships: [firstParent, secondParent].map((parent) => ({
        kind: "parent" as const,
        sourceArtifactId: childId,
        sourceRef: `artifact:${childId}`,
        targetArtifactId: parent.artifact.id,
        targetRef: `artifact:${parent.artifact.id}`,
      })),
      capturedAt: 1_000,
    })).toThrow(/at most one parent/iu);
    expect(() => repository.preflightArtifactCapture({
      artifactId: childId,
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "cardinality-child",
      kind: "implementation_ticket",
      status: "ready",
      trackerKind: "github",
      trackerNamespace: "github:acme/widgets",
      title: "Duplicate blocker child",
      content: "# Goal\n\nReject duplicate blocker identities.",
      acceptanceCriteria: [],
      relationships: ["first", "second"].map(() => ({
        kind: "blocks" as const,
        sourceArtifactId: blocker.artifact.id,
        sourceRef: `artifact:${blocker.artifact.id}`,
        targetArtifactId: childId,
        targetRef: `artifact:${childId}`,
      })),
      capturedAt: 1_000,
    })).toThrow(/duplicate|same blocker/iu);
    expect(() => repository.preflightArtifactCapture({
      artifactId: childId,
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "cardinality-child",
      kind: "implementation_ticket",
      status: "ready",
      trackerKind: "github",
      trackerNamespace: "github:acme/widgets",
      title: "Self relationship child",
      content: "# Goal\n\nReject a self relationship.",
      acceptanceCriteria: [],
      relationships: [{
        kind: "parent",
        sourceArtifactId: childId,
        sourceRef: `artifact:${childId}`,
        targetArtifactId: childId,
        targetRef: `artifact:${childId}`,
      }],
      capturedAt: 1_000,
    })).toThrow(/artifact cannot relate to itself/iu);
    expect(repository.getArtifact(childId)).toBeNull();
  });

  it("invalidates claims after terminal observations and snapshots after in-flight remote edits", () => {
    const { repository, store } = fixture();
    const created = repository.captureArtifact(artifactInput("create-ticket", "42", {
      assignees: ["hanoon-bot"],
    }));
    const executor = store.acquireExecutorLease("executor-a", 1_000, 100);
    expect(executor).toEqual({ acquired: true, generation: 1 });
    if (!executor.acquired) throw new Error("executor lease was not acquired");
    const claim = repository.claimArtifact({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_1",
      snapshotId: created.snapshot.id,
      externalAssignee: "hanoon-bot",
      ownerId: "executor-a",
      generation: executor.generation,
      now: 1_010,
      leaseMs: 100,
    });
    expect(claim?.state).toBe("held");

    const remotelyClosed = repository.observeArtifact({
      artifactId: created.artifact.id,
      expectedExternalRevision: "etag-1",
      externalRevision: "etag-2",
      externalStatus: "closed",
      assignees: ["hanoon-bot"],
      title: created.snapshot.title,
      content: created.snapshot.content,
      acceptanceCriteria: created.snapshot.acceptanceCriteria,
      relationships: created.snapshot.relationships,
      observedAt: 1_020,
    });
    expect(remotelyClosed.artifact.externalStatus).toBe("closed");
    expect(remotelyClosed.artifact.status).toBe("ready");
    expect(remotelyClosed.snapshot.id).toBe(created.snapshot.id);
    expect(repository.getHeldClaim(created.artifact.id)).toBeNull();
    expect(repository.getClaim(claim!.id)).toMatchObject({
      state: "invalidated",
      releaseReason: "external_closed",
    });
    expect(repository.getResolution(created.artifact.id)).toBeNull();
    expect(repository.renewArtifactClaim({
      claimId: claim!.id,
      ownerId: "executor-a",
      generation: executor.generation,
      now: 1_025,
      leaseMs: 100,
    })).toBe(false);

    const reopened = repository.observeArtifact({
      artifactId: created.artifact.id,
      expectedExternalRevision: "etag-2",
      externalRevision: "etag-reopened",
      externalStatus: "open",
      assignees: ["hanoon-bot"],
      title: created.snapshot.title,
      content: created.snapshot.content,
      acceptanceCriteria: created.snapshot.acceptanceCriteria,
      relationships: created.snapshot.relationships,
      observedAt: 1_028,
    });
    const editedClaim = repository.claimArtifact({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_1",
      snapshotId: reopened.snapshot.id,
      externalAssignee: "hanoon-bot",
      ownerId: "executor-a",
      generation: executor.generation,
      now: 1_029,
      leaseMs: 50,
    });
    expect(editedClaim?.state).toBe("held");
    const edited = repository.observeArtifact({
      artifactId: created.artifact.id,
      expectedExternalRevision: "etag-reopened",
      externalRevision: "etag-3",
      externalStatus: "open",
      assignees: ["hanoon-bot"],
      title: created.snapshot.title,
      content: "# Goal\n\nShip a materially different slice.",
      acceptanceCriteria: ["The new requirement passes"],
      relationships: created.snapshot.relationships,
      observedAt: 1_030,
    });
    expect(edited.snapshot.revision).toBe(2);
    expect(repository.isSnapshotValid(created.snapshot.id)).toBe(false);
    expect(repository.getSnapshotInvalidation(created.snapshot.id)).toMatchObject({
      replacementSnapshotId: edited.snapshot.id,
      reason: "remote_edit",
    });
    expect(repository.getHeldClaim(created.artifact.id)).toBeNull();
    expect(repository.getClaim(editedClaim!.id)).toMatchObject({
      state: "invalidated",
      releaseReason: "remote_edit",
    });
    expect(edited.artifact.status).toBe("ready");
    expect(() => repository.observeArtifact({
      artifactId: created.artifact.id,
      expectedExternalRevision: "etag-2",
      externalRevision: "etag-stale",
      externalStatus: "open",
      assignees: ["hanoon-bot"],
      title: created.snapshot.title,
      content: created.snapshot.content,
      acceptanceCriteria: created.snapshot.acceptanceCriteria,
      relationships: created.snapshot.relationships,
      observedAt: 1_035,
    })).toThrow(WorkArtifactObservationConflictError);
    expect(repository.getArtifact(created.artifact.id)?.externalRevision).toBe("etag-3");

    expect(() => repository.authorizeArtifactResolution({
      artifactId: created.artifact.id,
      operationId: "invalid-resolution-evidence",
      outcome: "resolved",
      snapshotId: edited.snapshot.id,
      expectedExternalRevision: edited.artifact.externalRevision,
      evidenceRefs: ["evidence:999999"],
      now: 1_040,
    })).toThrow(/authoritative evidence/iu);
    const evidenceRef = recordArtifactEvidence(store, {
      artifactId: created.artifact.id,
      snapshotId: edited.snapshot.id,
      ownerId: "executor-a",
      generation: executor.generation,
      now: 1_040,
    });
    expect(authorizeAndFinalize(repository, {
      artifactId: created.artifact.id,
      evidenceRef,
      operationId: "resolve-edited-ticket",
      now: 1_045,
    })?.status).toBe("resolved");
    expect(repository.getResolution(created.artifact.id)).toMatchObject({
      outcome: "resolved",
      evidenceRefs: [evidenceRef],
    });
  });

  it("fences claims with the current executor and adopts the exact claim after restart", () => {
    const { db, repository, store } = fixture();
    const created = repository.captureArtifact(artifactInput("create-restart-ticket", "43", {
      assignees: ["hanoon-bot"],
    }));

    db.prepare("UPDATE jobs SET project_id = 'proj_other' WHERE id = 'job_1'").run();
    expect(() => repository.preflightClaimIdentity({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_1",
    })).toThrow(/another project/iu);
    db.prepare("UPDATE jobs SET project_id = 'proj_1', state = 'completed' WHERE id = 'job_1'").run();
    expect(() => repository.preflightClaimIdentity({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_1",
    })).toThrow(/claim-eligible state/iu);
    db.prepare("UPDATE jobs SET state = 'implementing' WHERE id = 'job_1'").run();
    expect(() => repository.preflightClaimIdentity({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_1",
    })).not.toThrow();

    expect(repository.claimArtifact({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_1",
      snapshotId: created.snapshot.id,
      externalAssignee: "hanoon-bot",
      ownerId: "not-the-executor",
      generation: 1,
      now: 1_000,
      leaseMs: 100,
    })).toBeNull();

    const first = store.acquireExecutorLease("executor-a", 1_000, 100);
    if (!first.acquired) throw new Error("first executor lease was not acquired");
    const claim = repository.claimArtifact({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_1",
      snapshotId: created.snapshot.id,
      externalAssignee: "hanoon-bot",
      ownerId: "executor-a",
      generation: first.generation,
      now: 1_010,
      leaseMs: 50,
    });
    expect(claim).not.toBeNull();
    expect(repository.claimArtifact({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_1",
      snapshotId: created.snapshot.id,
      externalAssignee: "hanoon-bot",
      ownerId: "executor-a",
      generation: first.generation,
      now: 1_011,
      leaseMs: 50,
    })?.id).toBe(claim?.id);

    expect(store.releaseExecutorLease("executor-a", first.generation, 1_020)).toBe(true);
    const liveTakeover = store.acquireExecutorLease("executor-b", 1_030, 100);
    if (!liveTakeover.acquired) throw new Error("live takeover executor lease was not acquired");
    expect(repository.adoptArtifactClaim({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_1",
      externalAssignee: "hanoon-bot",
      ownerId: "executor-b",
      generation: liveTakeover.generation,
      expectedOwnerId: claim!.ownerId,
      expectedGeneration: claim!.generation,
      expectedLeaseExpiresAt: claim!.leaseExpiresAt,
      now: 1_035,
      leaseMs: 100,
    })).toBe(false);
    expect(repository.getHeldClaim(created.artifact.id)).toMatchObject({
      ownerId: "executor-a",
      generation: first.generation,
      leaseExpiresAt: claim!.leaseExpiresAt,
    });
    expect(store.releaseExecutorLease("executor-b", liveTakeover.generation, 1_040)).toBe(true);
    const second = store.acquireExecutorLease("executor-b", 1_200, 100);
    if (!second.acquired) throw new Error("second executor lease was not acquired");
    expect(repository.adoptArtifactClaim({
      artifactId: created.artifact.id,
      workflowStepId: "another-workflow",
      jobId: "job_1",
      externalAssignee: "hanoon-bot",
      ownerId: "executor-b",
      generation: second.generation,
      expectedOwnerId: claim!.ownerId,
      expectedGeneration: claim!.generation,
      expectedLeaseExpiresAt: claim!.leaseExpiresAt,
      now: 1_210,
      leaseMs: 100,
    })).toBe(false);
    expect(repository.adoptArtifactClaim({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_1",
      externalAssignee: "hanoon-bot",
      ownerId: "executor-b",
      generation: second.generation,
      expectedOwnerId: claim!.ownerId,
      expectedGeneration: claim!.generation,
      expectedLeaseExpiresAt: claim!.leaseExpiresAt,
      now: 1_210,
      leaseMs: 100,
    })).toBe(true);
    expect(repository.getHeldClaim(created.artifact.id)).toMatchObject({
      id: claim!.id,
      ownerId: "executor-b",
      generation: second.generation,
      leaseExpiresAt: 1_310,
    });
    expect(repository.renewArtifactClaim({
      claimId: claim!.id,
      ownerId: "executor-a",
      generation: first.generation,
      now: 1_220,
      leaseMs: 100,
    })).toBe(false);
    expect(repository.renewArtifactClaim({
      claimId: claim!.id,
      ownerId: "executor-b",
      generation: second.generation,
      now: 1_220,
      leaseMs: 100,
    })).toBe(true);
    expect(repository.releaseArtifactClaim({
      claimId: claim!.id,
      ownerId: "executor-b",
      generation: second.generation,
      now: 1_230,
      reason: "ticket_complete",
    })).toBe(true);
    expect(repository.releaseArtifactClaim({
      claimId: claim!.id,
      ownerId: "executor-b",
      generation: second.generation,
      now: 1_240,
      reason: "ticket_complete",
    })).toBe(true);
    expect(repository.releaseArtifactClaim({
      claimId: claim!.id,
      ownerId: "executor-b",
      generation: second.generation,
      now: 1_500,
      reason: "ticket_complete",
    })).toBe(true);
    expect(repository.getArtifact(created.artifact.id)?.status).toBe("ready");
  });

  it("STD-40-001: transactional release refuses an expired claim", () => {
    const { repository, store } = fixture();
    const created = repository.captureArtifact(artifactInput("expired-release", "63", {
      assignees: ["hanoon-bot"],
    }));
    const executor = store.acquireExecutorLease("expired-release-executor", 1_000, 1_000);
    if (!executor.acquired) throw new Error("executor lease was not acquired");
    const claim = repository.claimArtifact({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_expired_release",
      jobId: "job_1",
      snapshotId: created.snapshot.id,
      externalAssignee: "hanoon-bot",
      ownerId: "expired-release-executor",
      generation: executor.generation,
      now: 1_010,
      leaseMs: 50,
    });
    if (!claim) throw new Error("artifact was not claimed");

    expect(repository.releaseArtifactClaim({
      claimId: claim.id,
      ownerId: "expired-release-executor",
      generation: executor.generation,
      now: 1_061,
      reason: "expired claim",
    })).toBe(false);
    expect(repository.getClaim(claim.id)).toMatchObject({
      state: "held",
      leaseExpiresAt: 1_060,
    });
  });

  it("persists immutable tracker mutation identity and a stable indeterminate outcome", () => {
    const { store } = fixture();
    const first = store.acquireExecutorLease("mutation-a", 1_000, 100);
    if (!first.acquired) throw new Error("first executor lease was not acquired");
    const key = {
      trackerNamespace: "github:acme/widgets",
      externalId: "acme/widgets#77",
      operationId: "parent-mutation-ledger",
    };
    const prepared = store.prepareWorkArtifactTrackerMutation({
      ...key,
      artifactId: stableWorkArtifactId("proj_1", "parent-mutation-ledger"),
      kind: "parent",
      payloadDigest: "a".repeat(64),
      requestedParentExternalId: "acme/widgets#70",
      originalParentExternalId: null,
      originalRevision: "revision-1",
      ownerId: "mutation-a",
      generation: first.generation,
      now: 1_001,
    });
    expect(prepared).toMatchObject({
      phase: "prepared",
      status: "pending",
      ownerId: "mutation-a",
      generation: first.generation,
      createdAt: 1_001,
      updatedAt: 1_001,
    });
    expect(() => store.prepareWorkArtifactTrackerMutation({
      ...key,
      artifactId: prepared.artifactId,
      kind: "parent",
      payloadDigest: "b".repeat(64),
      requestedParentExternalId: "acme/widgets#70",
      originalParentExternalId: null,
      originalRevision: "revision-1",
      ownerId: "mutation-a",
      generation: first.generation,
      now: 1_002,
    })).toThrow(/identity changed/iu);
    expect(store.markWorkArtifactTrackerMutationApplying({
      ...key,
      ownerId: "mutation-a",
      generation: first.generation,
      now: 1_002,
    }).phase).toBe("applying");
    expect(store.releaseExecutorLease("mutation-a", first.generation, 1_003)).toBe(true);
    const second = store.acquireExecutorLease("mutation-b", 1_200, 100);
    if (!second.acquired) throw new Error("successor executor lease was not acquired");
    const indeterminate = store.markWorkArtifactTrackerMutationIndeterminate({
      ...key,
      lastObservedParentExternalId: null,
      lastObservedRevision: "revision-2",
      reason: "native effect may have run",
      ownerId: "mutation-b",
      generation: second.generation,
      now: 1_210,
    });
    expect(indeterminate).toMatchObject({
      phase: "indeterminate",
      status: "indeterminate",
      ownerId: "mutation-a",
      generation: first.generation,
      lastObservedRevision: "revision-2",
      reason: "native effect may have run",
      settledAt: 1_210,
      updatedAt: 1_210,
    });
    expect(store.markWorkArtifactTrackerMutationIndeterminate({
      ...key,
      lastObservedParentExternalId: "acme/widgets#99",
      lastObservedRevision: "revision-3",
      reason: "later retry",
      ownerId: "mutation-b",
      generation: second.generation,
      now: 1_220,
    })).toEqual(indeterminate);
  });

  it("rejects controller evidence bound to another artifact and snapshot", () => {
    const { repository, store } = fixture();
    const source = repository.captureArtifact(artifactInput("evidence-source", "60"));
    const target = repository.captureArtifact(artifactInput("evidence-target", "61"));
    const lease = store.acquireExecutorLease("evidence-executor", 1_000, 100);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const evidenceRef = recordArtifactEvidence(store, {
      artifactId: source.artifact.id,
      snapshotId: source.snapshot.id,
      ownerId: "evidence-executor",
      generation: lease.generation,
      now: 1_010,
      outcome: "observed",
    });

    expect(() => repository.authorizeArtifactResolution({
      artifactId: target.artifact.id,
      operationId: "wrong-artifact-evidence",
      outcome: "resolved",
      snapshotId: target.snapshot.id,
      expectedExternalRevision: target.artifact.externalRevision,
      evidenceRefs: [evidenceRef],
      now: 1_020,
    })).toThrow(/current snapshot/iu);
    expect(repository.getResolution(target.artifact.id)).toBeNull();
  });

  it("does not finalize an authorization after requirements change", () => {
    const { db, repository, store } = fixture();
    const created = repository.captureArtifact(artifactInput("resolution-race", "62"));
    const lease = store.acquireExecutorLease("resolution-race-executor", 1_000, 1_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const evidenceRef = recordArtifactEvidence(store, {
      artifactId: created.artifact.id,
      snapshotId: created.snapshot.id,
      ownerId: "resolution-race-executor",
      generation: lease.generation,
      now: 1_010,
    });
    const intent = repository.authorizeArtifactResolution({
      artifactId: created.artifact.id,
      operationId: "resolution-race-close",
      outcome: "resolved",
      snapshotId: created.snapshot.id,
      expectedExternalRevision: created.artifact.externalRevision,
      evidenceRefs: [evidenceRef],
      now: 1_020,
    });
    if (!intent) throw new Error("resolution intent was not recorded");
    expect(() => db.prepare(
      "UPDATE work_artifact_resolution_intents SET outcome = 'cancelled' WHERE id = ?",
    ).run(intent.id)).toThrow(/append-only/iu);

    const edited = repository.observeArtifact({
      artifactId: created.artifact.id,
      expectedExternalRevision: created.artifact.externalRevision,
      externalRevision: "etag-requirements-edited",
      externalStatus: "open",
      assignees: [],
      title: created.snapshot.title,
      content: "# Goal\n\nShip the changed requirement.",
      acceptanceCriteria: ["The changed requirement passes"],
      relationships: created.snapshot.relationships,
      observedAt: 1_030,
    });
    repository.observeArtifact({
      artifactId: created.artifact.id,
      expectedExternalRevision: edited.artifact.externalRevision,
      externalRevision: "etag-requirements-edited-closed",
      externalStatus: "closed",
      assignees: [],
      title: edited.snapshot.title,
      content: edited.snapshot.content,
      acceptanceCriteria: edited.snapshot.acceptanceCriteria,
      relationships: edited.snapshot.relationships,
      observedAt: 1_040,
    });

    expect(repository.finalizeArtifactResolution({
      intentId: intent.id,
      externalRevision: "etag-requirements-edited-closed",
      now: 1_050,
    })).toBeNull();
    expect(repository.getArtifact(created.artifact.id)?.status).toBe("ready");
    expect(repository.getResolution(created.artifact.id)).toBeNull();
    expect(() => repository.authorizeArtifactResolution({
      artifactId: created.artifact.id,
      operationId: "resolution-race-retry",
      outcome: "resolved",
      snapshotId: edited.snapshot.id,
      expectedExternalRevision: "etag-requirements-edited-closed",
      evidenceRefs: [evidenceRef],
      now: 1_060,
    })).toThrow(/current snapshot/iu);
  });

  it("returns only open, unblocked, and unclaimed children in tracker order", () => {
    const { repository, store } = fixture();
    const parent = repository.captureArtifact(artifactInput("frontier-parent", "50", {
      artifactId: stableWorkArtifactId("proj_1", "frontier-parent"),
      kind: "specification",
      title: "Parent",
    }));
    const blocker = repository.captureArtifact(artifactInput("frontier-blocker", "51", {
      artifactId: stableWorkArtifactId("proj_1", "frontier-blocker"),
      title: "Blocker",
    }));
    const blockedId = stableWorkArtifactId("proj_1", "frontier-blocked");
    const blocked = repository.captureArtifact(artifactInput("frontier-blocked", "52", {
      artifactId: blockedId,
      trackerOrder: 1,
      title: "Blocked first",
      relationships: [
        {
          kind: "parent",
          sourceArtifactId: blockedId,
          sourceRef: `artifact:${blockedId}`,
          targetArtifactId: parent.artifact.id,
          targetRef: `artifact:${parent.artifact.id}`,
        },
        {
          kind: "blocks",
          sourceArtifactId: blocker.artifact.id,
          sourceRef: `artifact:${blocker.artifact.id}`,
          targetArtifactId: blockedId,
          targetRef: `artifact:${blockedId}`,
        },
      ],
    }));
    const freeId = stableWorkArtifactId("proj_1", "frontier-free");
    const free = repository.captureArtifact(artifactInput("frontier-free", "53", {
      artifactId: freeId,
      trackerOrder: 2,
      title: "Free second",
      relationships: [{
        kind: "parent",
        sourceArtifactId: freeId,
        sourceRef: `artifact:${freeId}`,
        targetArtifactId: parent.artifact.id,
        targetRef: `artifact:${parent.artifact.id}`,
      }],
    }));

    expect(repository.listFrontier(parent.artifact.id, 10).map((artifact) => artifact.id))
      .toEqual([free.artifact.id]);
    const lease = store.acquireExecutorLease("executor-frontier", 1_000, 100);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    repository.observeArtifact({
      artifactId: free.artifact.id,
      expectedExternalRevision: "etag-1",
      externalRevision: "etag-claimed",
      externalStatus: "open",
      assignees: ["hanoon-bot"],
      title: free.snapshot.title,
      content: free.snapshot.content,
      acceptanceCriteria: free.snapshot.acceptanceCriteria,
      relationships: free.snapshot.relationships,
      observedAt: 1_005,
    });
    repository.claimArtifact({
      artifactId: free.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_1",
      snapshotId: free.snapshot.id,
      externalAssignee: "hanoon-bot",
      ownerId: "executor-frontier",
      generation: lease.generation,
      now: 1_010,
      leaseMs: 50,
    });
    expect(repository.listFrontier(parent.artifact.id, 10)).toEqual([]);

    const blockerEvidence = recordArtifactEvidence(store, {
      artifactId: blocker.artifact.id,
      snapshotId: blocker.snapshot.id,
      ownerId: "executor-frontier",
      generation: lease.generation,
      now: 1_020,
    });
    expect(authorizeAndFinalize(repository, {
      artifactId: blocker.artifact.id,
      evidenceRef: blockerEvidence,
      operationId: "resolve-frontier-blocker",
      now: 1_025,
    })?.status).toBe("resolved");
    expect(repository.listFrontier(parent.artifact.id, 10).map((artifact) => artifact.id))
      .toEqual([blocked.artifact.id]);
    const resolvedBlocker = repository.getArtifact(blocker.artifact.id);
    const resolvedBlockerSnapshot = repository.getCurrentSnapshot(blocker.artifact.id);
    if (!resolvedBlocker || !resolvedBlockerSnapshot) throw new Error("resolved blocker disappeared");
    repository.observeArtifact({
      artifactId: resolvedBlocker.id,
      expectedExternalRevision: resolvedBlocker.externalRevision,
      externalRevision: "etag-reopened",
      externalStatus: "open",
      assignees: [],
      title: resolvedBlockerSnapshot.title,
      content: resolvedBlockerSnapshot.content,
      acceptanceCriteria: resolvedBlockerSnapshot.acceptanceCriteria,
      relationships: resolvedBlockerSnapshot.relationships,
      observedAt: 1_030,
    });
    expect(repository.getArtifact(blocker.artifact.id)?.status).toBe("resolved");
    expect(repository.listFrontier(parent.artifact.id, 10)).toEqual([]);
  });
});
