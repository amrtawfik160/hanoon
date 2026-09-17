import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { JobEffect } from "../src/domain/models";
import { productionResourceKey, projectResourceKey } from "../src/autonomy/models";
import { DEFAULT_MODEL_POOL_REGISTRY } from "../src/capabilities/models";
import { navigatorTicketWorkerProfile } from "../src/navigator/implementation-contracts";
import { NavigatorImplementationExecutor } from "../src/navigator/implementation-executor";
import { selectNavigatorPlanningRoute } from "../src/navigator/planning-contracts";
import { attachedWorkflowTaskEvidence, scheduleWorkflowSkills } from "../src/navigator/workflow-skills";
import { EffectRunner } from "../src/services/effect-runner";
import { openStore } from "../src/storage/store";
import { stableWorkArtifactId } from "../src/work-artifacts/repository";
import { policyFixture } from "./helpers";

const PLANNING_SIGNALS = {
  trackerConfigured: true,
  specificationReady: false,
  hugeMultiSessionEffort: false,
  routeToDestinationVisible: true,
  needsPrimarySourceFacts: false,
  runnableDesignQuestion: false,
  workingDirectoryAvailable: true,
  requirementsUnclear: false,
} as const;

const SHA = { base: "1".repeat(40), head: "a".repeat(40) } as const;

function ticketFixture(title: string) {
  const { bb } = createFakePluginHost({ pluginId: `navigator-workflow-skills-${title}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 1_000);
  let currentTime = 1_100;
  const now = () => currentTime++;
  const specificationId = stableWorkArtifactId("proj_40", "specification-109");
  const ticketId = stableWorkArtifactId("proj_40", "ticket-109");
  const specification = store.captureWorkArtifact({
    artifactId: specificationId,
    projectId: "proj_40",
    effortId: "job_109",
    operationId: "109-spec",
    kind: "specification",
    status: "ready",
    trackerKind: "github",
    trackerNamespace: "github:acme/widgets",
    externalId: "109-spec",
    externalUrl: "https://github.com/acme/widgets/issues/109-spec",
    externalRevision: "109-spec:1",
    externalStatus: "open",
    assignees: [],
    title: "Agent-owned engineering workflow",
    trackerOrder: 0,
    content: "# Spec\n",
    acceptanceCriteria: ["spec is accepted"],
    relationships: [],
    capturedAt: 1_000,
  });
  const ticket = store.captureWorkArtifact({
    artifactId: ticketId,
    projectId: "proj_40",
    effortId: "job_109",
    operationId: "109-1",
    kind: "implementation_ticket",
    status: "ready",
    trackerKind: "github",
    trackerNamespace: "github:acme/widgets",
    externalId: "109-1",
    externalUrl: "https://github.com/acme/widgets/issues/109-1",
    externalRevision: "109-1:1",
    externalStatus: "open",
    assignees: [],
    title,
    trackerOrder: 1,
    content: `# ${title}\n`,
    acceptanceCriteria: [`${title} is accepted`],
    relationships: [{
      kind: "parent",
      sourceArtifactId: ticketId,
      sourceRef: `artifact:${ticketId}`,
      targetArtifactId: specificationId,
      targetRef: `artifact:${specificationId}`,
    }],
    capturedAt: 1_001,
  });
  const draft = store.createJob({
    id: "job_109",
    sourceUpdateId: 109,
    requestText: title,
    workflow: { engine: "navigator-v1", mode: "deterministic" },
    now: now(),
  });
  const selected = store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_40",
    policyVersion: 1,
    policy: policyFixture({ projectId: "proj_40" }),
  }, now());
  store.bindNavigatorJobArtifacts({
    jobId: selected.id,
    expectedVersion: selected.version,
    artifactBindings: [specification, ticket].map(({ artifact, snapshot }) => ({
      artifactId: artifact.id,
      snapshotId: snapshot.id,
      snapshotDigest: snapshot.snapshotDigest,
    })),
    now: now(),
  });
  bb.storage.database().prepare("UPDATE jobs SET state = 'implementing' WHERE id = ?").run(draft.id);
  const lease = store.acquireExecutorLease("executor-109", now(), 100_000);
  if (!lease.acquired) throw new Error("executor fixture lease was unavailable");
  const executor = new NavigatorImplementationExecutor({
    store,
    gitObserver: { observe: vi.fn() },
    pullRequests: { createOrRefresh: vi.fn() },
    modelRoute: (kind) => ({
      pool: kind === "review" ? "strong" : "standard",
      ...DEFAULT_MODEL_POOL_REGISTRY.worker[kind === "review" ? "strong" : "standard"],
    }),
    clock: { now },
  });
  executor.startIntegration({
    jobId: draft.id,
    specificationArtifactId: specificationId,
    implementationTicketIds: [ticketId],
    baseBranch: "main",
    integrationBranch: "hanoon/job-109",
    worktreeId: "env_job_109",
    baseHeadSha: SHA.base,
    evidenceRefs: ["ticket:109"],
  });
  const artifact = store.getWorkArtifact(ticketId)!;
  const snapshot = store.getCurrentWorkArtifactSnapshot(ticketId)!;
  store.observeWorkArtifact({
    artifactId: ticketId,
    expectedExternalRevision: artifact.externalRevision,
    externalRevision: `${artifact.externalRevision}:claimed`,
    externalStatus: "open",
    assignees: ["owner"],
    title: snapshot.title,
    content: snapshot.content,
    acceptanceCriteria: snapshot.acceptanceCriteria,
    relationships: snapshot.relationships,
    observedAt: now(),
  });
  const claimed = store.claimWorkArtifact({
    artifactId: ticketId,
    workflowStepId: `implement:${ticketId}`,
    jobId: draft.id,
    snapshotId: snapshot.id,
    externalAssignee: "owner",
    ownerId: "executor-109",
    generation: lease.generation,
    now: now(),
    leaseMs: 100_000,
  });
  if (!claimed) throw new Error("ticket was not claimed");
  bb.storage.database().prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at, released_at, release_reason
     ) VALUES (?, 'project:proj_40:pipeline', 'project', 'held', ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(draft.id, "executor-109", lease.generation, now() + 100_000, now(), now());
  return { store, executor, jobId: draft.id, ticketId, claimId: claimed.id };
}

function docsSpawnFixture() {
  const { bb } = createFakePluginHost({ pluginId: "navigator-workflow-skills-docs" });
  const db = bb.storage.database();
  const store = openStore(bb.storage, bb.storage.kv, () => 1_000);
  const job = store.createJob({
    id: "job_docs_109",
    sourceUpdateId: 209,
    requestText: "Update the docs",
    workflow: { engine: "navigator-v1", mode: "deterministic" },
    now: 1_000,
  });
  const policy = policyFixture();
  db.prepare(
    `UPDATE jobs SET state = 'documenting', project_id = ?, policy_version = 1, policy_json = ?,
       routing_mode = 'active', environment_id = 'env_docs', implementation_thread_id = 'thr_builder',
       pr_number = 42, pr_url = 'https://github.com/acme/cyndra/pull/42', pr_head_sha = ?
     WHERE id = ?`,
  ).run(policy.projectId, JSON.stringify(policy), SHA.head, job.id);
  const effect: JobEffect = {
    idempotencyKey: `${job.id}:2:spawn_docs`,
    jobId: job.id,
    kind: "spawn_docs",
    payload: {},
  };
  db.prepare(
    `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, 1000, 1000, 1000)`,
  ).run(effect.idempotencyKey, effect.jobId, effect.kind, JSON.stringify(effect.payload));
  db.prepare(
    `INSERT INTO job_admissions (
       job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at
     ) VALUES (?, ?, 1, 'admitted', 'CONFIRMED', 1000, 1001)`,
  ).run(job.id, policy.projectId);
  const lease = store.acquireExecutorLease("owner-docs", 1_001, 30_000);
  if (!lease.acquired) throw new Error("docs spawn lease missing");
  const insertClaim = db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at
     ) VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?)`,
  );
  insertClaim.run(
    job.id, projectResourceKey(policy.projectId), "project", "owner-docs", lease.generation, 31_000, 1_001, 1_001,
  );
  insertClaim.run(
    job.id, productionResourceKey(policy), "production_target", "owner-docs", lease.generation, 31_000, 1_001, 1_001,
  );
  const claimed = store.leaseNextJobEffect({
    jobId: job.id,
    ownerId: "owner-docs",
    generation: lease.generation,
    now: 1_001,
    leaseMs: 30_000,
  });
  if (!claimed) throw new Error("spawn_docs effect missing");
  return { store, claimed, lease, expectedSubjectId: `stage:${effect.idempotencyKey}` };
}

describe("navigator workflow skill scheduling", () => {
  it("schedules to-spec, then to-tickets on multi-step planning", () => {
    expect(scheduleWorkflowSkills({
      stage: "planner",
      specificationReady: false,
      multiStep: true,
    })).toEqual({
      skillIds: ["to-spec"],
      reasonCodes: ["planner_to_spec"],
    });
    expect(scheduleWorkflowSkills({
      stage: "planner",
      specificationReady: true,
      multiStep: true,
    })).toEqual({
      skillIds: ["to-tickets"],
      reasonCodes: ["planner_to_tickets"],
    });
    expect(selectNavigatorPlanningRoute(PLANNING_SIGNALS)).toBe("to-spec");
    expect(selectNavigatorPlanningRoute({ ...PLANNING_SIGNALS, specificationReady: true }))
      .toBe("to-tickets");
  });

  it("schedules implement plus tdd and diagnosing-bugs only where they apply", () => {
    expect(scheduleWorkflowSkills({ stage: "implementation" })).toEqual({
      skillIds: ["implement"],
      reasonCodes: ["implementation_implement"],
    });
    expect(scheduleWorkflowSkills({
      stage: "implementation",
      taskEvidence: ["behavioral-change"],
    })).toEqual({
      skillIds: ["implement", "tdd"],
      reasonCodes: ["implementation_implement", "implementation_tdd"],
    });
    expect(scheduleWorkflowSkills({
      stage: "implementation",
      taskEvidence: ["reproducible-bug"],
    })).toEqual({
      skillIds: ["diagnosing-bugs", "implement"],
      reasonCodes: ["implementation_diagnosing_bugs", "implementation_implement"],
    });
    expect(navigatorTicketWorkerProfile({
      kind: "implementation",
      taskEvidence: ["behavioral-change", "reproducible-bug"],
      changedPaths: [],
    }).assignments.map((assignment) => assignment.capabilityId)).toEqual([
      "diagnosing-bugs",
      "implement",
      "tdd",
    ]);
  });

  it("schedules improve-codebase-architecture on architecture work and technical-writing on docs", () => {
    expect(scheduleWorkflowSkills({ stage: "architecture" })).toEqual({
      skillIds: ["improve-codebase-architecture"],
      reasonCodes: ["architecture_improve_codebase_architecture"],
    });
    expect(scheduleWorkflowSkills({
      stage: "implementation",
      taskEvidence: ["architectural-change"],
    }).skillIds).toEqual([
      "implement",
      "improve-codebase-architecture",
    ]);
    expect(navigatorTicketWorkerProfile({
      kind: "implementation",
      taskEvidence: ["architectural-change"],
      changedPaths: [],
    }).assignments.map((assignment) => assignment.capabilityId)).toEqual([
      "implement",
      "improve-codebase-architecture",
    ]);
    expect(scheduleWorkflowSkills({ stage: "documentation" })).toEqual({
      skillIds: ["technical-writing"],
      reasonCodes: ["documentation_technical_writing"],
    });
  });

  it("schedules better-ui and emil-design-eng on UI-surface implementation and review", () => {
    expect(attachedWorkflowTaskEvidence(["behavioral-change"], "Polish the settings page UI")).toEqual([
      "behavioral-change",
      "ui-surface",
    ]);
    expect(attachedWorkflowTaskEvidence([], "Add the integration lane", ["src/Button.tsx"])).toEqual([
      "ui-surface",
    ]);
    expect(attachedWorkflowTaskEvidence(["behavioral-change"], "Add the integration lane")).toEqual([
      "behavioral-change",
    ]);
    expect(scheduleWorkflowSkills({
      stage: "implementation",
      taskEvidence: ["ui-surface"],
    })).toEqual({
      skillIds: ["better-ui", "emil-design-eng", "implement"],
      reasonCodes: [
        "implementation_better_ui",
        "implementation_emil_design_eng",
        "implementation_implement",
      ],
    });
    expect(scheduleWorkflowSkills({
      stage: "review",
      taskEvidence: ["ui-surface"],
    })).toEqual({
      skillIds: ["better-ui", "emil-design-eng"],
      reasonCodes: ["review_better_ui", "review_emil_design_eng"],
    });
    expect(scheduleWorkflowSkills({ stage: "review" })).toEqual({
      skillIds: [],
      reasonCodes: [],
    });
    expect(navigatorTicketWorkerProfile({
      kind: "implementation",
      taskEvidence: ["ui-surface", "behavioral-change"],
      changedPaths: [],
    }).assignments.map((assignment) => assignment.capabilityId)).toEqual([
      "better-ui",
      "emil-design-eng",
      "implement",
      "tdd",
    ]);
    expect(navigatorTicketWorkerProfile({
      kind: "review",
      taskEvidence: ["ui-surface"],
      changedPaths: ["src/Button.tsx"],
    }).assignments.map((assignment) => assignment.capabilityId)).toEqual([
      "better-ui",
      "clean-code-guard",
      "code-review",
      "emil-design-eng",
    ]);
  });

  it("schedules improve-codebase-architecture when claiming an architecture ticket", () => {
    const { store, executor, jobId, ticketId, claimId } = ticketFixture(
      "Split the public billing schema into a new subsystem",
    );
    executor.beginClaimedTicket({
      jobId,
      ticketArtifactId: ticketId,
      claimId,
      taskEvidence: ["behavioral-change"],
      evidenceRefs: ["ticket:109:claim"],
      ownerId: "executor-109",
      generation: 1,
    });
    const attempt = executor.snapshot(jobId).attempts[0];
    if (!attempt) throw new Error("architecture attempt missing");
    expect(attempt.workOrder.taskEvidence).toEqual(["behavioral-change", "architectural-change"]);
    expect(attempt.profile.assignments.map(({ capabilityId }) => capabilityId)).toEqual([
      "implement",
      "improve-codebase-architecture",
      "tdd",
    ]);
    const profile = store.getLatestCapabilityProfile("worker_attempt", attempt.id);
    expect(store.listCapabilityReceipts(profile?.id ?? "missing", 20)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "improve-codebase-architecture",
          eventType: "selected",
          subjectId: attempt.id,
        }),
      ]),
    );
  });

  it("does not treat an ordinary ticket as architecture work", () => {
    const { executor, jobId, ticketId, claimId } = ticketFixture("Add the integration lane");
    executor.beginClaimedTicket({
      jobId,
      ticketArtifactId: ticketId,
      claimId,
      taskEvidence: ["behavioral-change"],
      evidenceRefs: ["ticket:109:ordinary"],
      ownerId: "executor-109",
      generation: 1,
    });
    const attempt = executor.snapshot(jobId).attempts[0];
    expect(attempt?.workOrder.taskEvidence).toEqual(["behavioral-change"]);
    expect(attempt?.profile.assignments.map(({ capabilityId }) => capabilityId)).toEqual([
      "implement",
      "tdd",
    ]);
  });

  it("schedules the UI kit when claiming a UI-surface ticket", () => {
    const { store, executor, jobId, ticketId, claimId } = ticketFixture(
      "Polish the settings page UI",
    );
    executor.beginClaimedTicket({
      jobId,
      ticketArtifactId: ticketId,
      claimId,
      taskEvidence: ["behavioral-change"],
      evidenceRefs: ["ticket:111:claim"],
      ownerId: "executor-109",
      generation: 1,
    });
    const attempt = executor.snapshot(jobId).attempts[0];
    if (!attempt) throw new Error("ui-surface attempt missing");
    expect(attempt.workOrder.taskEvidence).toEqual(["behavioral-change", "ui-surface"]);
    expect(attempt.profile.assignments.map(({ capabilityId }) => capabilityId)).toEqual([
      "better-ui",
      "emil-design-eng",
      "implement",
      "tdd",
    ]);
    const profile = store.getLatestCapabilityProfile("worker_attempt", attempt.id);
    expect(store.listCapabilityReceipts(profile?.id ?? "missing", 20)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "better-ui",
          eventType: "selected",
          subjectId: attempt.id,
        }),
        expect.objectContaining({
          capabilityId: "emil-design-eng",
          eventType: "selected",
          subjectId: attempt.id,
        }),
      ]),
    );
  });

  it("schedules technical-writing through spawnDocs and records a selected receipt", async () => {
    const { store, claimed, lease, expectedSubjectId } = docsSpawnFixture();
    await new EffectRunner({
      store,
      fence: { ownerId: "owner-docs", generation: lease.generation, signal: new AbortController().signal },
      now: () => 1_002,
      minimumModelPool: () => "strong",
      bb: {
        spawnDocs: vi.fn(async () => ({ id: "thr_docs", environmentId: "env_docs" })),
      },
    }).run(claimed);
    const profile = store.getLatestCapabilityProfile("worker_attempt", expectedSubjectId);
    expect(profile?.assignments.map((assignment) => assignment.capabilityId)).toEqual(
      expect.arrayContaining(["technical-writing"]),
    );
    expect(store.listCapabilityReceipts(profile?.id ?? "missing", 20)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "technical-writing",
          eventType: "selected",
          subjectId: expectedSubjectId,
        }),
      ]),
    );
  });
});
