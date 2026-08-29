import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { hashSecret } from "../src/crypto";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import {
  ExecutorLeaseLostError,
  WorkArtifactMutationIndeterminateError,
  WorkArtifactCoordinator,
  createConfiguredWorkTracker,
} from "../src/work-artifacts/coordinator";
import { stableWorkArtifactId } from "../src/work-artifacts/repository";
import {
  claimPayloadDigest,
  TrackerConflictError,
  TrackerIdentityConflictError,
  type WorkTracker,
} from "../src/work-artifacts/tracker";

const temporaryDirectories: string[] = [];
let fixtureNumber = 0;
let evidenceNumber = 0;

function createClaimJob(
  store: TelegramAgentStore,
  db: Database.Database,
  id = "job_work_artifact",
  projectId = "proj_1",
  state = "implementing",
): void {
  store.createJob({
    id,
    sourceUpdateId: 70_000 + fixtureNumber,
    requestText: "Execute the claimed workflow step.",
    now: 900,
  });
  db.prepare("UPDATE jobs SET project_id = ?, state = ? WHERE id = ?")
    .run(projectId, state, id);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function recordEvidence(
  store: TelegramAgentStore,
  input: Readonly<{
    artifactId: string;
    snapshotId: string;
    ownerId: string;
    generation: number;
    now: number;
  }>,
): `evidence:${number}` {
  evidenceNumber += 1;
  const controllerKey = `coordinator-controller-${evidenceNumber}`;
  const turn = store.enqueueControllerTurn({
    controllerKey,
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 95_000 + evidenceNumber,
    inputText: "Record accepted work artifact evidence.",
    now: input.now,
  });
  const fence = { ownerId: input.ownerId, generation: input.generation, now: input.now };
  if (store.claimNextControllerTurn(fence)?.id !== turn.id) throw new Error("turn was not claimed");
  if (!store.reserveControllerSpawn({
    controllerKey,
    turnId: turn.id,
    projectId: "proj_1",
    hostId: "host_1",
    now: input.now,
  })) throw new Error("spawn was not reserved");
  if (!store.markControllerSpawned({
    ...fence,
    turnId: turn.id,
    projectId: "proj_1",
    hostId: "host_1",
    threadId: `thr_coordinator_${evidenceNumber}`,
    spawnToken: turn.id,
  })) throw new Error("turn was not spawned");
  if (!store.markControllerTurnSubmitted({ ...fence, turnId: turn.id })) {
    throw new Error("turn was not submitted");
  }
  const result = store.recordControllerEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey,
    sourceKind: "hanoon_tool",
    sourceName: "work_artifact_acceptance",
    sourceItemId: null,
    outcome: "succeeded",
    argsSha256: "c".repeat(64),
    resultSha256: "d".repeat(64),
    proofKinds: ["obligation"],
    subjectRefs: [
      `work-artifact:${input.artifactId}`,
      `work-artifact-snapshot:${input.snapshotId}`,
    ],
  });
  if (result.outcome !== "recorded" && result.outcome !== "duplicate") {
    throw new Error(`evidence was ${result.outcome}`);
  }
  return result.evidence.ref;
}

describe("WorkArtifactCoordinator", () => {
  it("creates, mirrors, claims, resolves, and reopens one configured local artifact graph", async () => {
    fixtureNumber += 1;
    const directory = await mkdtemp(join(tmpdir(), "work-artifact-coordinator-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: `work-artifact-coordinator-${fixtureNumber}` });
    const store = openStore(bb.storage, bb.storage.kv, () => 1_000);
    createClaimJob(store, bb.storage.database());
    const pairingHash = hashSecret("pair-work-artifact-coordinator");
    store.createPairingCode(pairingHash, 900, 10_000);
    expect(store.pairOwnerWithCode(pairingHash, "7", "7", 901)).toEqual({ ok: true });
    const tracker = createConfiguredWorkTracker({
      kind: "local_markdown",
      repositoryRoot: directory,
      effortSlug: "coordinated-effort",
    });
    const lease = store.acquireExecutorLease("coordinator-executor", 990, 5_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 1_060);
    const effectFence = {
      ownerId: "coordinator-executor",
      generation: lease.generation,
    };

    const parent = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "coordinator-parent",
      kind: "specification",
      status: "ready",
      title: "Coordinated specification",
      body: "# Scope\n\nDrive one artifact through both ledgers.",
      acceptanceCriteria: ["The child is resolved from durable evidence"],
      relationships: [],
      trackerOrder: 0,
      ...effectFence,
      now: 1_000,
    });
    expect(parent.artifact.createdAt).toBe(1_000);
    expect(parent.snapshot.capturedAt).toBe(1_000);
    const childId = stableWorkArtifactId("proj_1", "coordinator-child");
    let child = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "coordinator-child",
      kind: "implementation_ticket",
      status: "ready",
      title: "Coordinated ticket",
      body: "# Goal\n\nShip the coordinated slice.",
      acceptanceCriteria: ["Focused verification passes"],
      relationships: [{
        kind: "parent",
        sourceArtifactId: childId,
        sourceRef: `artifact:${childId}`,
        targetArtifactId: parent.artifact.id,
        targetRef: `artifact:${parent.artifact.id}`,
      }],
      trackerOrder: 1,
      ...effectFence,
      now: 1_010,
    });
    expect((await tracker.read(child.artifact.externalId)).parentExternalId)
      .toBe(parent.artifact.externalId);
    expect(store.getWorkArtifact(child.artifact.id)?.currentSnapshotId).toBe(child.snapshot.id);
    await expect(coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "coordinator-child",
      kind: "implementation_ticket",
      status: "ready",
      title: "Coordinated ticket",
      body: "# Goal\n\nShip the coordinated slice.",
      acceptanceCriteria: ["Focused verification passes"],
      relationships: [],
      trackerOrder: 1,
      ...effectFence,
      now: 1_011,
    })).rejects.toThrow(TrackerIdentityConflictError);
    expect((await tracker.read(child.artifact.externalId)).parentExternalId)
      .toBe(parent.artifact.externalId);

    const edited = await tracker.updateOwnedSection({
      externalId: child.artifact.externalId,
      sectionId: "collaboration-note",
      content: "A reviewer clarified the acceptance boundary.",
      operationId: "coordinator-human-edit",
      expectedRevision: child.artifact.externalRevision,
    });
    child = await coordinator.observe({
      artifactId: child.artifact.id,
      ...effectFence,
      now: 1_020,
    });
    expect(child.artifact.externalRevision).toBe(edited.revision);
    expect(child.snapshot.revision).toBe(2);

    expect(await coordinator.claim({
      artifactId: child.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_work_artifact",
      assignee: "hanoon-bot",
      ownerId: "stale-executor",
      generation: lease.generation,
      operationId: "stale-coordinator-claim",
      now: 1_025,
      leaseMs: 500,
    })).toBeNull();
    expect((await tracker.read(child.artifact.externalId)).assignees).toEqual([]);
    const claimed = await coordinator.claim({
      artifactId: child.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_work_artifact",
      assignee: "hanoon-bot",
      ownerId: "coordinator-executor",
      generation: lease.generation,
      operationId: "coordinator-claim",
      now: 1_030,
      leaseMs: 500,
    });
    expect(claimed?.claim.state).toBe("held");
    if (!claimed) throw new Error("artifact was not claimed");
    expect(claimed.claim.acquiredAt).toBe(1_030);
    expect(claimed.capture.snapshot.capturedAt).toBe(1_020);
    const replayedClaim = await coordinator.claim({
      artifactId: child.artifact.id,
      workflowStepId: "workflow_1",
      jobId: "job_work_artifact",
      assignee: "hanoon-bot",
      ownerId: "coordinator-executor",
      generation: lease.generation,
      operationId: "coordinator-claim",
      now: 1_035,
      leaseMs: 500,
    });
    expect(replayedClaim?.claim.id).toBe(claimed.claim.id);
    expect((await tracker.read(child.artifact.externalId)).assignees).toEqual(["hanoon-bot"]);
    expect((await coordinator.observe({
      artifactId: child.artifact.id,
      ...effectFence,
      now: 1_036,
    })).snapshot.id)
      .toBe(claimed.capture.snapshot.id);
    expect(store.getWorkArtifactClaim(claimed.claim.id)?.state).toBe("held");
    expect(await coordinator.release({
      claimId: claimed.claim.id,
      ownerId: "stale-executor",
      generation: lease.generation,
      operationId: "stale-coordinator-release",
      reason: "stale_release",
      now: 1_037,
    })).toBe(false);
    expect(store.getWorkArtifactClaim(claimed.claim.id)?.state).toBe("held");
    expect((await tracker.read(child.artifact.externalId)).assignees).toEqual(["hanoon-bot"]);
    expect(await coordinator.release({
      claimId: claimed.claim.id,
      ownerId: "coordinator-executor",
      generation: lease.generation,
      operationId: "coordinator-release",
      reason: "acceptance_complete",
      now: 1_040,
    })).toBe(true);
    expect(await coordinator.release({
      claimId: claimed.claim.id,
      ownerId: "coordinator-executor",
      generation: lease.generation,
      operationId: "coordinator-release",
      reason: "acceptance_complete",
      now: 1_045,
    })).toBe(true);

    const current = store.getCurrentWorkArtifactSnapshot(child.artifact.id);
    if (!current) throw new Error("current snapshot disappeared");
    const evidenceRef = recordEvidence(store, {
      artifactId: child.artifact.id,
      snapshotId: current.id,
      ownerId: "coordinator-executor",
      generation: lease.generation,
      now: 1_050,
    });
    const resolved = await coordinator.resolve({
      artifactId: child.artifact.id,
      evidenceRefs: [evidenceRef],
      resolution: "Focused verification passed for the accepted snapshot.",
      operationId: "coordinator-resolve",
      ...effectFence,
      now: 1_060,
    });
    expect(resolved.artifact.status).toBe("resolved");
    expect((await tracker.read(child.artifact.externalId)).state).toBe("closed");
    expect((await coordinator.resolve({
      artifactId: child.artifact.id,
      evidenceRefs: [evidenceRef],
      resolution: "Focused verification passed for the accepted snapshot.",
      operationId: "coordinator-resolve",
      ...effectFence,
      now: 1_065,
    })).artifact.status).toBe("resolved");

    const restarted = openStore(bb.storage, bb.storage.kv, () => 2_000);
    expect(restarted.getWorkArtifact(child.artifact.id)?.status).toBe("resolved");
    expect(restarted.getWorkArtifactResolution(child.artifact.id)?.evidenceRefs)
      .toEqual([evidenceRef]);
    expect(await coordinator.release({
      claimId: claimed.claim.id,
      ownerId: "coordinator-executor",
      generation: lease.generation,
      operationId: "coordinator-release",
      reason: "acceptance_complete",
      now: 3_000,
    })).toBe(true);
  });

  it("renews a coordinated claim and adopts it under a successor executor generation", async () => {
    fixtureNumber += 1;
    const directory = await mkdtemp(join(tmpdir(), "work-artifact-adopt-renew-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: `work-artifact-adopt-renew-${fixtureNumber}` });
    let clock = 6_000;
    const store = openStore(bb.storage, bb.storage.kv, () => clock);
    createClaimJob(store, bb.storage.database());
    const tracker = createConfiguredWorkTracker({
      kind: "local_markdown",
      repositoryRoot: directory,
      effortSlug: "adopt-renew",
    });
    const firstLease = store.acquireExecutorLease("adopt-renew-a", 6_000, 100);
    if (!firstLease.acquired) throw new Error("first executor lease was not acquired");
    const firstFence = { ownerId: "adopt-renew-a", generation: firstLease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => clock);
    const created = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "adopt-renew-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "Adopt and renew",
      body: "# Goal\n\nKeep visible and internal ownership paired across restart.",
      acceptanceCriteria: [],
      relationships: [],
      ...firstFence,
      now: 6_000,
    });
    clock = 6_010;
    const claimed = await coordinator.claim({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_adopt_renew",
      jobId: "job_work_artifact",
      assignee: "hanoon-bot",
      operationId: "adopt-renew-claim",
      leaseMs: 50,
      ...firstFence,
      now: clock,
    });
    if (!claimed) throw new Error("artifact was not claimed");
    clock = 6_020;
    const renewed = await coordinator.renew({
      claimId: claimed.claim.id,
      operationId: "adopt-renew-first-renewal",
      leaseMs: 100,
      ...firstFence,
      now: clock,
    });
    expect(renewed?.claim).toMatchObject({
      ownerId: "adopt-renew-a",
      generation: firstLease.generation,
      leaseExpiresAt: 6_120,
    });
    expect((await tracker.operationStatus({
      externalId: created.artifact.externalId,
      operationId: "adopt-renew-first-renewal",
      payloadDigest: claimPayloadDigest("renew", "hanoon-bot"),
    })).status).toBe("completed");

    expect(store.releaseExecutorLease("adopt-renew-a", firstLease.generation, 6_030)).toBe(true);
    clock = 6_200;
    const secondLease = store.acquireExecutorLease("adopt-renew-b", clock, 1_000);
    if (!secondLease.acquired) throw new Error("successor executor lease was not acquired");
    const secondFence = { ownerId: "adopt-renew-b", generation: secondLease.generation };
    const adopted = await coordinator.adopt({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_adopt_renew",
      jobId: "job_work_artifact",
      assignee: "hanoon-bot",
      operationId: "adopt-renew-successor-adoption",
      leaseMs: 200,
      ...secondFence,
      now: clock,
    });
    expect(adopted?.claim).toMatchObject({
      id: claimed.claim.id,
      ownerId: "adopt-renew-b",
      generation: secondLease.generation,
      leaseExpiresAt: 6_400,
    });
    clock = 6_210;
    const successorRenewal = await coordinator.renew({
      claimId: claimed.claim.id,
      operationId: "adopt-renew-successor-renewal",
      leaseMs: 300,
      ...secondFence,
      now: clock,
    });
    expect(successorRenewal?.claim.leaseExpiresAt).toBe(6_510);
    expect((await tracker.read(created.artifact.externalId)).assignees).toEqual(["hanoon-bot"]);
  });

  it("releases visible ownership when restart adoption or renewal finds edited requirements", async () => {
    fixtureNumber += 1;
    const directory = await mkdtemp(join(tmpdir(), "work-artifact-claim-edit-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: `work-artifact-claim-edit-${fixtureNumber}` });
    let clock = 7_000;
    const store = openStore(bb.storage, bb.storage.kv, () => clock);
    createClaimJob(store, bb.storage.database());
    const tracker = createConfiguredWorkTracker({
      kind: "local_markdown",
      repositoryRoot: directory,
      effortSlug: "claim-edit",
    });
    const firstLease = store.acquireExecutorLease("claim-edit-a", clock, 100);
    if (!firstLease.acquired) throw new Error("first executor lease was not acquired");
    const firstFence = { ownerId: "claim-edit-a", generation: firstLease.generation };
    const firstCoordinator = new WorkArtifactCoordinator(store, tracker, () => clock);
    const adoptionArtifact = await firstCoordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "claim-edit-adoption-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "Edited before adoption",
      body: "# Goal\n\nAdopt the original requirement.",
      acceptanceCriteria: [],
      relationships: [],
      ...firstFence,
      now: clock,
    });
    clock = 7_010;
    const adoptionClaim = await firstCoordinator.claim({
      artifactId: adoptionArtifact.artifact.id,
      workflowStepId: "workflow_claim_edit_adopt",
      jobId: "job_work_artifact",
      assignee: "hanoon-bot",
      operationId: "claim-edit-adoption-claim",
      leaseMs: 50,
      ...firstFence,
      now: clock,
    });
    if (!adoptionClaim) throw new Error("adoption artifact was not claimed");
    expect(store.releaseExecutorLease("claim-edit-a", firstLease.generation, 7_020)).toBe(true);
    clock = 7_200;
    const secondLease = store.acquireExecutorLease("claim-edit-b", clock, 1_000);
    if (!secondLease.acquired) throw new Error("successor executor lease was not acquired");
    const secondFence = { ownerId: "claim-edit-b", generation: secondLease.generation };
    const adoptionPath = join(directory, adoptionArtifact.artifact.externalId);
    await writeFile(
      adoptionPath,
      (await readFile(adoptionPath, "utf8"))
        .replace("Adopt the original requirement.", "Adopt the revised requirement."),
      "utf8",
    );
    const adoptionVisible = await tracker.read(adoptionArtifact.artifact.externalId);
    await tracker.claim({
      externalId: adoptionVisible.externalId,
      assignee: "human-adopter",
      operationId: "claim-edit-human-adopter",
      expectedRevision: adoptionVisible.revision,
    });
    const secondCoordinator = new WorkArtifactCoordinator(store, tracker, () => clock);
    expect(await secondCoordinator.adopt({
      artifactId: adoptionArtifact.artifact.id,
      workflowStepId: "workflow_claim_edit_adopt",
      jobId: "job_work_artifact",
      assignee: "hanoon-bot",
      operationId: "claim-edit-adoption-attempt",
      leaseMs: 200,
      ...secondFence,
      now: clock,
    })).toBeNull();
    expect(store.getWorkArtifactClaim(adoptionClaim.claim.id)?.state).toBe("invalidated");
    expect((await tracker.read(adoptionArtifact.artifact.externalId)).assignees)
      .toEqual(["human-adopter"]);

    clock = 7_210;
    const renewalArtifact = await secondCoordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "claim-edit-renewal-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "Edited during renewal",
      body: "# Goal\n\nRenew the original requirement.",
      acceptanceCriteria: [],
      relationships: [],
      ...secondFence,
      now: clock,
    });
    clock = 7_220;
    const renewalClaim = await secondCoordinator.claim({
      artifactId: renewalArtifact.artifact.id,
      workflowStepId: "workflow_claim_edit_renew",
      jobId: "job_work_artifact",
      assignee: "hanoon-bot",
      operationId: "claim-edit-renewal-claim",
      leaseMs: 300,
      ...secondFence,
      now: clock,
    });
    if (!renewalClaim) throw new Error("renewal artifact was not claimed");
    const renewalPath = join(directory, renewalArtifact.artifact.externalId);
    const editingRenewalTracker = new Proxy(tracker, {
      get(target, property, receiver) {
        if (property === "renew") {
          return async (input: Parameters<WorkTracker["renew"]>[0]) => {
            await target.renew(input);
            await writeFile(
              renewalPath,
              (await readFile(renewalPath, "utf8"))
                .replace("Renew the original requirement.", "Renew the revised requirement."),
              "utf8",
            );
            const edited = await target.read(input.externalId);
            await target.claim({
              ...input,
              assignee: "human-renewer",
              operationId: "claim-edit-human-renewer",
              expectedRevision: edited.revision,
            });
            return target.read(input.externalId);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    clock = 7_230;
    expect(await new WorkArtifactCoordinator(store, editingRenewalTracker, () => clock).renew({
      claimId: renewalClaim.claim.id,
      operationId: "claim-edit-renewal-attempt",
      leaseMs: 300,
      ...secondFence,
      now: clock,
    })).toBeNull();
    expect(store.getWorkArtifactClaim(renewalClaim.claim.id)?.state).toBe("invalidated");
    expect((await tracker.read(renewalArtifact.artifact.externalId)).assignees)
      .toEqual(["human-renewer"]);
  });

  it("leaves only a stale authorization when requirements change before tracker closure", async () => {
    fixtureNumber += 1;
    const directory = await mkdtemp(join(tmpdir(), "work-artifact-resolution-race-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: `work-artifact-resolution-race-${fixtureNumber}` });
    const store = openStore(bb.storage, bb.storage.kv, () => 1_000);
    const pairingHash = hashSecret("pair-work-artifact-resolution-race");
    store.createPairingCode(pairingHash, 900, 10_000);
    expect(store.pairOwnerWithCode(pairingHash, "7", "7", 901)).toEqual({ ok: true });
    const tracker = createConfiguredWorkTracker({
      kind: "local_markdown",
      repositoryRoot: directory,
      effortSlug: "resolution-race",
    });
    const lease = store.acquireExecutorLease("resolution-race-executor", 990, 5_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 1_020);
    const effectFence = {
      ownerId: "resolution-race-executor",
      generation: lease.generation,
    };
    const created = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "coordinator-resolution-race",
      kind: "implementation_ticket",
      status: "ready",
      title: "Resolution race",
      body: "# Goal\n\nClose only the accepted requirements.",
      acceptanceCriteria: ["The original requirement passes"],
      relationships: [],
      ...effectFence,
      now: 1_000,
    });
    const evidenceRef = recordEvidence(store, {
      artifactId: created.artifact.id,
      snapshotId: created.snapshot.id,
      ownerId: "resolution-race-executor",
      generation: lease.generation,
      now: 1_010,
    });
    let injected = false;
    const racingTracker = new Proxy(tracker, {
      get(target, property, receiver) {
        if (property === "resolve") {
          return async (input: Parameters<WorkTracker["resolve"]>[0]) => {
            if (!injected) {
              injected = true;
              const path = join(directory, created.artifact.externalId);
              const body = (await readFile(path, "utf8"))
                .replace("The original requirement passes", "A changed requirement passes");
              await writeFile(path, body, "utf8");
            }
            return target.resolve(input);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    const racingCoordinator = new WorkArtifactCoordinator(store, racingTracker, () => 1_020);

    await expect(racingCoordinator.resolve({
      artifactId: created.artifact.id,
      evidenceRefs: [evidenceRef],
      resolution: "The original requirement passed.",
      operationId: "coordinator-resolution-race-close",
      ...effectFence,
      now: 1_020,
    })).rejects.toThrow(TrackerConflictError);
    expect(store.getWorkArtifact(created.artifact.id)?.status).toBe("ready");
    expect(store.getWorkArtifactResolution(created.artifact.id)).toBeNull();
    expect((bb.storage.database().prepare(
      "SELECT count(*) AS count FROM work_artifact_resolution_intents",
    ).get() as { count: number }).count).toBe(1);
  });

  it("does not finalize a child when a blocker reopens during tracker closure", async () => {
    fixtureNumber += 1;
    const directory = await mkdtemp(join(tmpdir(), "work-artifact-blocker-reopen-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: `work-artifact-blocker-reopen-${fixtureNumber}` });
    const store = openStore(bb.storage, bb.storage.kv, () => 8_000);
    const pairingHash = hashSecret("pair-work-artifact-blocker-reopen");
    store.createPairingCode(pairingHash, 7_900, 10_000);
    expect(store.pairOwnerWithCode(pairingHash, "7", "7", 7_901)).toEqual({ ok: true });
    const tracker = createConfiguredWorkTracker({
      kind: "local_markdown",
      repositoryRoot: directory,
      effortSlug: "blocker-reopen",
    });
    const lease = store.acquireExecutorLease("blocker-reopen-executor", 7_990, 5_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = { ownerId: "blocker-reopen-executor", generation: lease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 8_050);
    const blocker = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "blocker-reopen-blocker-create",
      kind: "decision_ticket",
      status: "ready",
      title: "Resolved blocker",
      body: "# Decision\n\nSettle the prerequisite.",
      acceptanceCriteria: [],
      relationships: [],
      ...fence,
      now: 8_000,
    });
    const childId = stableWorkArtifactId("proj_1", "blocker-reopen-child-create");
    const child = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "blocker-reopen-child-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "Blocked child",
      body: "# Goal\n\nResolve only while the prerequisite stays settled.",
      acceptanceCriteria: [],
      relationships: [{
        kind: "blocks",
        sourceArtifactId: blocker.artifact.id,
        sourceRef: `artifact:${blocker.artifact.id}`,
        targetArtifactId: childId,
        targetRef: `artifact:${childId}`,
      }],
      ...fence,
      now: 8_010,
    });
    const blockerEvidence = recordEvidence(store, {
      artifactId: blocker.artifact.id,
      snapshotId: blocker.snapshot.id,
      ...fence,
      now: 8_020,
    });
    await coordinator.resolve({
      artifactId: blocker.artifact.id,
      evidenceRefs: [blockerEvidence],
      resolution: "The prerequisite passed.",
      operationId: "blocker-reopen-blocker-resolve",
      ...fence,
      now: 8_030,
    });
    const childEvidence = recordEvidence(store, {
      artifactId: child.artifact.id,
      snapshotId: child.snapshot.id,
      ...fence,
      now: 8_040,
    });
    const blockerPath = join(directory, blocker.artifact.externalId);
    const reopeningTracker = new Proxy(tracker, {
      get(target, property, receiver) {
        if (property === "resolve") {
          return async (input: Parameters<WorkTracker["resolve"]>[0]) => {
            await writeFile(
              blockerPath,
              (await readFile(blockerPath, "utf8")).replace("Status: resolved", "Status: ready"),
              "utf8",
            );
            return target.resolve(input);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;

    await expect(new WorkArtifactCoordinator(store, reopeningTracker, () => 8_050).resolve({
      artifactId: child.artifact.id,
      evidenceRefs: [childEvidence],
      resolution: "The child passed.",
      operationId: "blocker-reopen-child-resolve",
      ...fence,
      now: 8_050,
    })).rejects.toThrow(TrackerConflictError);
    expect(store.getWorkArtifact(child.artifact.id)?.status).toBe("ready");
    expect(store.getWorkArtifactResolution(child.artifact.id)).toBeNull();
    expect((await tracker.read(blocker.artifact.externalId)).state).toBe("open");
  });

  it("settles a completed local resolution after a restart between tracker closure and capture", async () => {
    fixtureNumber += 1;
    const directory = await mkdtemp(join(tmpdir(), "work-artifact-resolution-restart-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: `work-artifact-resolution-restart-${fixtureNumber}` });
    const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
    const pairingHash = hashSecret("pair-work-artifact-resolution-restart");
    store.createPairingCode(pairingHash, 1_900, 10_000);
    expect(store.pairOwnerWithCode(pairingHash, "7", "7", 1_901)).toEqual({ ok: true });
    const tracker = createConfiguredWorkTracker({
      kind: "local_markdown",
      repositoryRoot: directory,
      effortSlug: "resolution-restart",
    });
    const lease = store.acquireExecutorLease("resolution-restart-executor", 1_990, 5_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = {
      ownerId: "resolution-restart-executor",
      generation: lease.generation,
    };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 2_030);
    const created = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "resolution-restart-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "Restart-safe resolution",
      body: "# Goal\n\nResume the accepted closure.",
      acceptanceCriteria: ["The accepted snapshot stays current"],
      relationships: [],
      ...fence,
      now: 2_000,
    });
    const evidenceRef = recordEvidence(store, {
      artifactId: created.artifact.id,
      snapshotId: created.snapshot.id,
      ...fence,
      now: 2_010,
    });
    let interrupt = true;
    const interruptingTracker = new Proxy(tracker, {
      get(target, property, receiver) {
        if (property === "resolve") {
          return async (input: Parameters<WorkTracker["resolve"]>[0]) => {
            const closed = await target.resolve(input);
            if (interrupt) {
              interrupt = false;
              throw new Error("process stopped after tracker closure");
            }
            return closed;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    const interrupted = new WorkArtifactCoordinator(store, interruptingTracker, () => 2_030);
    const resolution = {
      artifactId: created.artifact.id,
      evidenceRefs: [evidenceRef],
      resolution: "The accepted snapshot passed.",
      operationId: "resolution-restart-close",
      ...fence,
      now: 2_020,
    };

    await expect(interrupted.resolve(resolution)).rejects.toThrow(/stopped after tracker closure/iu);
    expect(store.getWorkArtifact(created.artifact.id)?.status).toBe("ready");
    expect((await tracker.read(created.artifact.externalId)).state).toBe("closed");
    const recovered = await coordinator.resolve({ ...resolution, now: 2_030 });
    const mutationKey = {
      trackerNamespace: tracker.namespace,
      externalId: created.artifact.externalId,
      operationId: resolution.operationId,
    };
    expect(store.getWorkArtifactTrackerMutation(mutationKey)).toMatchObject({
      phase: "completed",
      status: "completed",
      originalRevision: created.artifact.externalRevision,
    });
    expect(recovered.artifact.status).toBe("resolved");
    expect(store.getWorkArtifactResolution(created.artifact.id)).not.toBeNull();
    expect((await coordinator.resolve({ ...resolution, now: 2_040 })).artifact.status).toBe("resolved");
    expect(store.getWorkArtifactTrackerMutation(mutationKey)?.updatedAt).toBe(2_030);
  });

  it("invalidates resolution evidence when requirements change after tracker closure", async () => {
    fixtureNumber += 1;
    const directory = await mkdtemp(join(tmpdir(), "work-artifact-post-close-edit-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: `work-artifact-post-close-edit-${fixtureNumber}` });
    const store = openStore(bb.storage, bb.storage.kv, () => 3_000);
    const pairingHash = hashSecret("pair-work-artifact-post-close-edit");
    store.createPairingCode(pairingHash, 2_900, 10_000);
    expect(store.pairOwnerWithCode(pairingHash, "7", "7", 2_901)).toEqual({ ok: true });
    const tracker = createConfiguredWorkTracker({
      kind: "local_markdown",
      repositoryRoot: directory,
      effortSlug: "post-close-edit",
    });
    const lease = store.acquireExecutorLease("post-close-edit-executor", 2_990, 5_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = { ownerId: "post-close-edit-executor", generation: lease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 3_020);
    const created = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "post-close-edit-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "Post-close edit",
      body: "# Goal\n\nReject evidence for changed requirements.",
      acceptanceCriteria: ["The original requirement passes"],
      relationships: [],
      ...fence,
      now: 3_000,
    });
    const evidenceRef = recordEvidence(store, {
      artifactId: created.artifact.id,
      snapshotId: created.snapshot.id,
      ...fence,
      now: 3_010,
    });
    const editingTracker = new Proxy(tracker, {
      get(target, property, receiver) {
        if (property === "resolve") {
          return async (input: Parameters<WorkTracker["resolve"]>[0]) => {
            await target.resolve(input);
            const path = join(directory, created.artifact.externalId);
            const raw = (await readFile(path, "utf8"))
              .replace("The original requirement passes", "A changed requirement passes");
            await writeFile(path, raw, "utf8");
            return target.read(input.externalId);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    const editingCoordinator = new WorkArtifactCoordinator(store, editingTracker, () => 3_020);

    await expect(editingCoordinator.resolve({
      artifactId: created.artifact.id,
      evidenceRefs: [evidenceRef],
      resolution: "The original requirement passed.",
      operationId: "post-close-edit-resolve",
      ...fence,
      now: 3_020,
    })).rejects.toThrow(/changed before resolution finalized/iu);
    const current = store.getWorkArtifact(created.artifact.id);
    expect(current?.status).toBe("ready");
    expect(current?.currentSnapshotId).not.toBe(created.snapshot.id);
    expect(store.getWorkArtifactResolution(created.artifact.id)).toBeNull();
  });

  it("refuses claims for unresolved blockers and existing human assignees", async () => {
    fixtureNumber += 1;
    const directory = await mkdtemp(join(tmpdir(), "work-artifact-claim-eligibility-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: `work-artifact-claim-eligibility-${fixtureNumber}` });
    const store = openStore(bb.storage, bb.storage.kv, () => 4_000);
    createClaimJob(store, bb.storage.database());
    const tracker = createConfiguredWorkTracker({
      kind: "local_markdown",
      repositoryRoot: directory,
      effortSlug: "claim-eligibility",
    });
    const lease = store.acquireExecutorLease("claim-eligibility-executor", 3_990, 5_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = { ownerId: "claim-eligibility-executor", generation: lease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 4_030);
    const blocker = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "claim-eligibility-blocker",
      kind: "decision_ticket",
      status: "ready",
      title: "Unresolved blocker",
      body: "# Decision\n\nChoose the dependency behavior.",
      acceptanceCriteria: [],
      relationships: [],
      ...fence,
      now: 4_000,
    });
    const blockedId = stableWorkArtifactId("proj_1", "claim-eligibility-blocked");
    const blocked = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "claim-eligibility-blocked",
      kind: "implementation_ticket",
      status: "ready",
      title: "Blocked ticket",
      body: "# Goal\n\nWait for the decision.",
      acceptanceCriteria: [],
      relationships: [{
        kind: "blocks",
        sourceArtifactId: blocker.artifact.id,
        sourceRef: `artifact:${blocker.artifact.id}`,
        targetArtifactId: blockedId,
        targetRef: `artifact:${blockedId}`,
      }],
      ...fence,
      now: 4_010,
    });
    const claimInput = {
      artifactId: blocked.artifact.id,
      workflowStepId: "workflow_claim_eligibility",
      jobId: "job_work_artifact",
      assignee: "hanoon-bot",
      operationId: "claim-eligibility-attempt",
      leaseMs: 500,
      ...fence,
      now: 4_020,
    };
    expect(await coordinator.claim(claimInput)).toBeNull();
    expect((await tracker.read(blocked.artifact.externalId)).assignees).toEqual([]);

    const unblocked = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "claim-eligibility-human",
      kind: "implementation_ticket",
      status: "ready",
      title: "Human-owned ticket",
      body: "# Goal\n\nPreserve a collaborator assignment.",
      acceptanceCriteria: [],
      relationships: [],
      ...fence,
      now: 4_020,
    });
    await tracker.claim({
      externalId: unblocked.artifact.externalId,
      assignee: "human-owner",
      operationId: "human-owner-claim",
      expectedRevision: unblocked.artifact.externalRevision,
    });
    expect(await coordinator.claim({
      ...claimInput,
      artifactId: unblocked.artifact.id,
      operationId: "claim-eligibility-human-attempt",
      now: 4_030,
    })).toBeNull();
    expect((await tracker.read(unblocked.artifact.externalId)).assignees).toEqual(["human-owner"]);
  });

  it("preflights claim job project and lifecycle before visible assignment", async () => {
    fixtureNumber += 1;
    const directory = await mkdtemp(join(tmpdir(), "work-artifact-claim-job-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: `work-artifact-claim-job-${fixtureNumber}` });
    const clock = 4_200;
    const store = openStore(bb.storage, bb.storage.kv, () => clock);
    createClaimJob(store, bb.storage.database(), "job_claim_identity", "proj_other");
    const baseTracker = createConfiguredWorkTracker({
      kind: "local_markdown",
      repositoryRoot: directory,
      effortSlug: "claim-job",
    });
    let assignmentCalls = 0;
    const tracker = new Proxy(baseTracker, {
      get(target, property, receiver) {
        if (property === "claim") {
          return async (input: Parameters<WorkTracker["claim"]>[0]) => {
            assignmentCalls += 1;
            return target.claim(input);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    const lease = store.acquireExecutorLease("claim-job-executor", clock, 1_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = { ownerId: "claim-job-executor", generation: lease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => clock);
    const created = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "claim-job-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "Claim job identity",
      body: "# Goal\n\nBind claims to active project jobs.",
      acceptanceCriteria: [],
      relationships: [],
      ...fence,
      now: 4_100,
    });
    expect(created.artifact.createdAt).toBe(clock);
    expect(created.snapshot.capturedAt).toBe(clock);
    const claimInput = {
      artifactId: created.artifact.id,
      workflowStepId: "workflow_claim_job",
      jobId: "job_claim_identity",
      assignee: "hanoon-bot",
      operationId: "claim-job-claim",
      leaseMs: 500,
      ...fence,
      now: clock,
    };
    await expect(coordinator.claim(claimInput)).rejects.toThrow(/another project/iu);
    expect(assignmentCalls).toBe(0);
    bb.storage.database().prepare(
      "UPDATE jobs SET project_id = 'proj_1', state = 'completed' WHERE id = 'job_claim_identity'",
    ).run();
    await expect(coordinator.claim(claimInput)).rejects.toThrow(/claim-eligible state/iu);
    expect(assignmentCalls).toBe(0);
    bb.storage.database().prepare(
      "UPDATE jobs SET state = 'implementing' WHERE id = 'job_claim_identity'",
    ).run();
    const claimed = await coordinator.claim(claimInput);
    if (!claimed) throw new Error("active project job did not claim the artifact");
    expect(assignmentCalls).toBe(1);
    const releaseInput = {
      claimId: claimed.claim.id,
      operationId: "claim-job-release",
      reason: "workflow step completed",
      ...fence,
      now: clock,
    };
    expect(await coordinator.release(releaseInput)).toBe(true);
    let visible = await baseTracker.read(created.artifact.externalId);
    visible = await baseTracker.claim({
      externalId: visible.externalId,
      assignee: "human-owner",
      operationId: "claim-job-human-reassignment",
      expectedRevision: visible.revision,
    });
    visible = await baseTracker.claim({
      externalId: visible.externalId,
      assignee: "hanoon-bot",
      operationId: "claim-job-bot-reassignment",
      expectedRevision: visible.revision,
    });
    await expect(coordinator.release({ ...releaseInput, now: clock + 1 }))
      .rejects.toThrow(TrackerConflictError);
    expect((await baseTracker.read(created.artifact.externalId)).assignees)
      .toEqual(["hanoon-bot", "human-owner"]);
  });

  it("STD-40-001: fails closed before releasing an expired artifact claim", async () => {
    fixtureNumber += 1;
    const directory = await mkdtemp(join(tmpdir(), "work-artifact-release-expiry-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: `work-artifact-release-expiry-${fixtureNumber}` });
    let clock = 4_700;
    const store = openStore(bb.storage, bb.storage.kv, () => clock);
    createClaimJob(store, bb.storage.database());
    const baseTracker = createConfiguredWorkTracker({
      kind: "local_markdown",
      repositoryRoot: directory,
      effortSlug: "release-expiry",
    });
    let releaseCalls = 0;
    const tracker = new Proxy(baseTracker, {
      get(target, property, receiver) {
        if (property === "release") {
          return async (input: Parameters<WorkTracker["release"]>[0]) => {
            releaseCalls += 1;
            return target.release(input);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    const lease = store.acquireExecutorLease("release-expiry-executor", clock, 1_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = { ownerId: "release-expiry-executor", generation: lease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => clock);
    const created = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "release-expiry-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "Expired release claim",
      body: "# Goal\n\nKeep expired releases from changing tracker ownership.",
      acceptanceCriteria: [],
      relationships: [],
      ...fence,
      now: clock,
    });
    const claimed = await coordinator.claim({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_release_expiry",
      jobId: "job_work_artifact",
      assignee: "hanoon-bot",
      operationId: "release-expiry-claim",
      leaseMs: 50,
      ...fence,
      now: 4_710,
    });
    if (!claimed) throw new Error("artifact was not claimed");

    clock = 4_761;
    expect(await coordinator.release({
      claimId: claimed.claim.id,
      operationId: "release-expiry-release",
      reason: "expired claim",
      ...fence,
      now: clock,
    })).toBe(false);
    expect(releaseCalls).toBe(0);
    expect(store.getWorkArtifactClaim(claimed.claim.id)).toMatchObject({
      state: "held",
      leaseExpiresAt: 4_760,
    });
    expect((await baseTracker.read(created.artifact.externalId)).assignees)
      .toEqual(["hanoon-bot"]);
  });

  it("settles an interrupted local release before observation can invalidate the claim", async () => {
    fixtureNumber += 1;
    const directory = await mkdtemp(join(tmpdir(), "work-artifact-release-restart-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: `work-artifact-release-restart-${fixtureNumber}` });
    const store = openStore(bb.storage, bb.storage.kv, () => 4_400);
    createClaimJob(store, bb.storage.database());
    const tracker = createConfiguredWorkTracker({
      kind: "local_markdown",
      repositoryRoot: directory,
      effortSlug: "release-restart",
    });
    const lease = store.acquireExecutorLease("release-restart-executor", 4_390, 1_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = { ownerId: "release-restart-executor", generation: lease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 4_400);
    const created = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "release-restart-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "Restart-safe release",
      body: "# Goal\n\nSettle a visible release after restart.",
      acceptanceCriteria: [],
      relationships: [],
      ...fence,
      now: 4_400,
    });
    const claimed = await coordinator.claim({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_release_restart",
      jobId: "job_work_artifact",
      assignee: "hanoon-bot",
      operationId: "release-restart-claim",
      leaseMs: 500,
      ...fence,
      now: 4_400,
    });
    if (!claimed) throw new Error("artifact was not claimed");
    let interrupt = true;
    const interruptingTracker = new Proxy(tracker, {
      get(target, property, receiver) {
        if (property === "release") {
          return async (input: Parameters<WorkTracker["release"]>[0]) => {
            const released = await target.release(input);
            if (interrupt) {
              interrupt = false;
              throw new Error("process stopped after visible release");
            }
            return released;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    const release = {
      claimId: claimed.claim.id,
      operationId: "release-restart-operation",
      reason: "workflow step completed",
      ...fence,
      now: 4_400,
    };

    await expect(new WorkArtifactCoordinator(store, interruptingTracker, () => 4_400)
      .release(release)).rejects.toThrow(/stopped after visible release/iu);
    expect(store.getWorkArtifactClaim(claimed.claim.id)?.state).toBe("held");
    expect((await tracker.read(created.artifact.externalId)).assignees).toEqual([]);

    expect(await coordinator.release(release)).toBe(true);
    expect(store.getWorkArtifactClaim(claimed.claim.id)).toMatchObject({
      state: "released",
      releaseReason: release.reason,
    });
  });

  it("recovers an interrupted claim and relinquishes it when a human also takes ownership", async () => {
    fixtureNumber += 1;
    const directory = await mkdtemp(join(tmpdir(), "work-artifact-claim-restart-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: `work-artifact-claim-restart-${fixtureNumber}` });
    const store = openStore(bb.storage, bb.storage.kv, () => 4_500);
    createClaimJob(store, bb.storage.database());
    const tracker = createConfiguredWorkTracker({
      kind: "local_markdown",
      repositoryRoot: directory,
      effortSlug: "claim-restart",
    });
    const lease = store.acquireExecutorLease("claim-restart-executor", 4_490, 1_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = { ownerId: "claim-restart-executor", generation: lease.generation };
    const created = await new WorkArtifactCoordinator(store, tracker, () => 4_520).create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "claim-restart-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "Restart-safe claim",
      body: "# Goal\n\nRecover visible ownership after an interrupted response.",
      acceptanceCriteria: [],
      relationships: [],
      ...fence,
      now: 4_500,
    });
    let interrupt = true;
    const interruptingTracker = new Proxy(tracker, {
      get(target, property, receiver) {
        if (property === "claim") {
          return async (input: Parameters<WorkTracker["claim"]>[0]) => {
            const claimed = await target.claim(input);
            if (interrupt) {
              interrupt = false;
              throw new Error("process stopped after tracker claim");
            }
            return claimed;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    const claimInput = {
      artifactId: created.artifact.id,
      workflowStepId: "workflow_claim_restart",
      jobId: "job_work_artifact",
      assignee: "hanoon-bot",
      operationId: "claim-restart-operation",
      leaseMs: 500,
      ...fence,
      now: 4_510,
    };

    await expect(new WorkArtifactCoordinator(store, interruptingTracker, () => 4_520)
      .claim(claimInput)).rejects.toThrow(/stopped after tracker claim/iu);
    expect(store.getHeldWorkArtifactClaim(created.artifact.id)).toBeNull();
    expect((await tracker.read(created.artifact.externalId)).assignees).toEqual(["hanoon-bot"]);

    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 4_520);
    const recovered = await coordinator.claim({ ...claimInput, now: 4_520 });
    expect(recovered?.claim.state).toBe("held");
    if (!recovered) throw new Error("interrupted claim was not recovered");
    const claimPath = join(directory, created.artifact.externalId);
    await writeFile(
      claimPath,
      (await readFile(claimPath, "utf8")).replace("Status: claimed", "Status: resolved"),
      "utf8",
    );
    expect(await coordinator.claim({ ...claimInput, now: 4_525 })).toBeNull();
    expect((await tracker.read(created.artifact.externalId)).state).toBe("closed");
    expect(store.getWorkArtifactClaim(recovered.claim.id)).toMatchObject({
      state: "invalidated",
      releaseReason: "external_closed",
    });
    await writeFile(
      claimPath,
      (await readFile(claimPath, "utf8")).replace("Status: resolved", "Status: claimed"),
      "utf8",
    );
    const visible = await tracker.read(created.artifact.externalId);
    await tracker.claim({
      externalId: visible.externalId,
      assignee: "human-owner",
      operationId: "human-owner-after-bot",
      expectedRevision: visible.revision,
    });

    expect(await coordinator.claim({ ...claimInput, now: 4_530 })).toBeNull();
    expect(store.getWorkArtifactClaim(recovered.claim.id)?.state).toBe("invalidated");
    expect((await tracker.read(created.artifact.externalId)).assignees).toEqual(["human-owner"]);

    const raced = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "claim-human-race-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "Concurrent human claim",
      body: "# Goal\n\nKeep a concurrent collaborator assignment authoritative.",
      acceptanceCriteria: [],
      relationships: [],
      ...fence,
      now: 4_540,
    });
    const racingTracker = new Proxy(tracker, {
      get(target, property, receiver) {
        if (property === "claim") {
          return async (input: Parameters<WorkTracker["claim"]>[0]) => {
            const botClaim = await target.claim(input);
            await target.claim({
              ...input,
              assignee: "human-racer",
              operationId: "human-racer-operation",
              expectedRevision: botClaim.revision,
            });
            return target.read(input.externalId);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    expect(await new WorkArtifactCoordinator(store, racingTracker, () => 4_550).claim({
      ...claimInput,
      artifactId: raced.artifact.id,
      operationId: "claim-human-race-operation",
      now: 4_550,
    })).toBeNull();
    expect(store.getHeldWorkArtifactClaim(raced.artifact.id)).toBeNull();
    expect((await tracker.read(raced.artifact.externalId)).assignees).toEqual(["human-racer"]);

    const completedBeforeCapture = await coordinator.create({
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "completed-mixed-claim-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "Completed mixed claim",
      body: "# Goal\n\nRelinquish unowned bot assignment after a completed effect.",
      acceptanceCriteria: [],
      relationships: [],
      ...fence,
      now: 4_560,
    });
    const completedClaimOperation = "completed-mixed-claim-operation";
    const botOnly = await tracker.claim({
      externalId: completedBeforeCapture.artifact.externalId,
      assignee: "hanoon-bot",
      operationId: completedClaimOperation,
      expectedRevision: completedBeforeCapture.artifact.externalRevision,
    });
    await tracker.claim({
      externalId: botOnly.externalId,
      assignee: "human-after-completion",
      operationId: "human-after-completed-bot-claim",
      expectedRevision: botOnly.revision,
    });
    expect(await coordinator.claim({
      ...claimInput,
      artifactId: completedBeforeCapture.artifact.id,
      operationId: completedClaimOperation,
      now: 4_570,
    })).toBeNull();
    expect(store.getHeldWorkArtifactClaim(completedBeforeCapture.artifact.id)).toBeNull();
    expect((await tracker.read(completedBeforeCapture.artifact.externalId)).assignees)
      .toEqual(["human-after-completion"]);
  });

  it("does not commit a tracker effect after its executor lease expires", async () => {
    fixtureNumber += 1;
    const directory = await mkdtemp(join(tmpdir(), "work-artifact-effect-fence-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: `work-artifact-effect-fence-${fixtureNumber}` });
    let clock = 5_000;
    const store = openStore(bb.storage, bb.storage.kv, () => clock);
    createClaimJob(store, bb.storage.database());
    const tracker = createConfiguredWorkTracker({
      kind: "local_markdown",
      repositoryRoot: directory,
      effortSlug: "effect-fence",
    });
    const lease = store.acquireExecutorLease("effect-fence-old", 5_000, 10);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    clock = 5_005;
    let fenceReads = 0;
    const expiringCoordinator = new WorkArtifactCoordinator(store, tracker, () => {
      fenceReads += 1;
      const observed = clock;
      if (fenceReads === 2) clock = 5_011;
      return observed;
    });
    const baseInput = {
      projectId: "proj_1",
      effortId: "effort_1",
      operationId: "effect-fence-create",
      kind: "implementation_ticket" as const,
      status: "ready" as const,
      title: "Fenced tracker effect",
      body: "# Goal\n\nReconcile an effect from an expired executor.",
      acceptanceCriteria: [] as readonly string[],
      relationships: [] as const,
      now: 5_005,
    };

    await expect(expiringCoordinator.create({
      ...baseInput,
      ownerId: "effect-fence-old",
      generation: lease.generation,
    })).rejects.toThrow(ExecutorLeaseLostError);
    expect(store.getWorkArtifact(stableWorkArtifactId("proj_1", baseInput.operationId))).toBeNull();

    const replacement = store.acquireExecutorLease("effect-fence-new", 5_011, 1_000);
    if (!replacement.acquired) throw new Error("replacement executor lease was not acquired");
    clock = 5_012;
    const resumed = await new WorkArtifactCoordinator(store, tracker, () => clock).create({
      ...baseInput,
      ownerId: "effect-fence-new",
      generation: replacement.generation,
      now: 5_012,
    });
    expect(await readdir(join(directory, ".scratch", "effect-fence", "issues")))
      .toHaveLength(1);

    clock = 5_020;
    const slowClaimTracker = new Proxy(tracker, {
      get(target, property, receiver) {
        if (property === "claim") {
          return async (input: Parameters<WorkTracker["claim"]>[0]) => {
            const claimed = await target.claim(input);
            clock = 5_200;
            return claimed;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    const delayedClaim = await new WorkArtifactCoordinator(store, slowClaimTracker, () => clock).claim({
      artifactId: resumed.artifact.id,
      workflowStepId: "workflow_slow_claim",
      jobId: "job_work_artifact",
      assignee: "hanoon-bot",
      operationId: "slow-claim-operation",
      ownerId: "effect-fence-new",
      generation: replacement.generation,
      now: 5_020,
      leaseMs: 50,
    });
    expect(delayedClaim?.claim.leaseExpiresAt).toBe(5_250);
  });
});
