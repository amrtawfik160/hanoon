import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_POOL_REGISTRY, type ModelRoute } from "../src/capabilities/models";
import type { Job } from "../src/domain/models";
import {
  NavigatorWorkflowExecutor,
  type NavigatorSkillRunner,
  type WorkflowNavigator,
} from "../src/navigator/executor";
import type {
  NavigatorInferenceObservation,
  NavigatorProposal,
  NavigatorSnapshot,
} from "../src/navigator/models";
import { NAVIGATOR_RESEARCH_STEP_CONTRACT, NAVIGATOR_SKILL_CATALOG } from "../src/navigator/models";
import {
  NAVIGATOR_PLANNING_STEP_CONTRACTS,
  selectNavigatorPlanningRoute,
} from "../src/navigator/planning-contracts";
import {
  NavigatorEffectProtocol,
  type NavigatorEffectAdapter,
  type NavigatorEffectContext,
  type NavigatorEffectOutcome,
} from "../src/navigator/effect-protocol";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { runJobExecutorService } from "../src/services/job-executor-service";
import { stableWorkArtifactId, type CaptureWorkArtifactInput } from "../src/work-artifacts/repository";
import { policyFixture } from "./helpers";

let fixtureNumber = 0;

type Fixture = Readonly<{
  db: Database.Database;
  store: TelegramAgentStore;
  job: Job;
  artifactId: string;
  snapshotId: string;
  snapshotDigest: string;
}>;

function artifactInput(artifactId: string): CaptureWorkArtifactInput {
  return {
    artifactId,
    projectId: "proj_1",
    effortId: "effort_1",
    operationId: "ticket-38",
    kind: "implementation_ticket",
    status: "ready",
    trackerKind: "github",
    trackerNamespace: "github:acme/widgets",
    externalId: "38",
    externalUrl: "https://github.com/acme/widgets/issues/38",
    externalRevision: "ticket-38-etag-1",
    externalStatus: "open",
    assignees: ["owner"],
    title: "Run one restart-safe navigator skill step",
    content: "# Goal\n\nRun one admitted read-only skill against this immutable ticket.",
    acceptanceCriteria: ["The step resumes after restart", "Recipe jobs remain unchanged"],
    relationships: [],
    capturedAt: 1_010,
  };
}

function fixture(
  mode: "shadow" | "deterministic" = "deterministic",
  withSpecification = false,
): Fixture {
  const fixtureId = fixtureNumber++;
  const { bb } = createFakePluginHost({ pluginId: `navigator-executor-${fixtureId}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 1_100);
  const artifactId = stableWorkArtifactId("proj_1", "ticket-38");
  const artifact = store.captureWorkArtifact(artifactInput(artifactId));
  const specificationId = stableWorkArtifactId("proj_1", "ticket-39-specification");
  const specification = withSpecification ? store.captureWorkArtifact({
    ...artifactInput(specificationId),
    operationId: "ticket-39-specification",
    kind: "specification",
    externalId: "39-specification",
    externalUrl: "https://github.com/acme/widgets/issues/39",
    externalRevision: "ticket-39-specification-etag-1",
    title: "Ticket 39 canonical specification",
  }) : null;
  const draft = store.createJob({
    id: `job_navigator_${fixtureId}`,
    sourceUpdateId: 38_000 + fixtureId,
    requestText: "Research the exact ticket before implementation.",
    workflow: { engine: "navigator-v1", mode },
    now: 1_000,
  });
  const selected = store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  }, 1_020);
  const job = store.bindNavigatorJobArtifacts({
    jobId: selected.id,
    expectedVersion: selected.version,
    artifactBindings: [{
      artifactId,
      snapshotId: artifact.snapshot.id,
      snapshotDigest: artifact.snapshot.snapshotDigest,
    }, ...(specification ? [{
      artifactId: specificationId,
      snapshotId: specification.snapshot.id,
      snapshotDigest: specification.snapshot.snapshotDigest,
    }] : [])],
    now: 1_030,
  });
  return {
    db: bb.storage.database(),
    store,
    job,
    artifactId,
    snapshotId: artifact.snapshot.id,
    snapshotDigest: artifact.snapshot.snapshotDigest,
  };
}

function addNavigatorJob(value: Fixture, id: string, sourceUpdateId: number): Job {
  const draft = value.store.createJob({
    id,
    sourceUpdateId,
    requestText: "Research the exact ticket before implementation.",
    workflow: { engine: "navigator-v1", mode: "deterministic" },
    now: 1_000,
  });
  const selected = value.store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  }, 1_020);
  return value.store.bindNavigatorJobArtifacts({
    jobId: selected.id,
    expectedVersion: selected.version,
    artifactBindings: [{
      artifactId: value.artifactId,
      snapshotId: value.snapshotId,
      snapshotDigest: value.snapshotDigest,
    }],
    now: 1_030,
  });
}

function observation(overrides: Partial<NavigatorInferenceObservation> = {}): NavigatorInferenceObservation {
  return {
    nativeToolCalls: [],
    claimedCodeWorktreeId: null,
    dynamicEffectToolIds: [],
    externalStateDigest: "e".repeat(64),
    ...overrides,
  };
}

function invokeResearch(snapshot: NavigatorSnapshot, overrides: Partial<NavigatorProposal> = {}): NavigatorProposal {
  return {
    kind: "invoke_skill",
    basedOn: snapshot.identity,
    rationale: "The ticket needs one bounded primary-source check.",
    evidenceRefs: [`work-artifact-snapshot:${snapshot.artifactBindings[0]?.snapshotId}`],
    skillId: "research",
    subjectArtifactIds: [snapshot.artifactBindings[0]!.artifactId],
    objective: "Identify the one exact executor invariant this ticket must preserve.",
    ...overrides,
  } as NavigatorProposal;
}

function navigatorWith(
  proposal: (snapshot: NavigatorSnapshot) => unknown = invokeResearch,
): WorkflowNavigator & { propose: ReturnType<typeof vi.fn> } {
  return { propose: vi.fn(async (snapshot: NavigatorSnapshot) => proposal(snapshot)) };
}

function executor(
  fixtureValue: Fixture,
  input: Readonly<{
    navigator?: WorkflowNavigator;
    observe?: (snapshot: NavigatorSnapshot) => Promise<NavigatorInferenceObservation>;
    skillRunner?: NavigatorSkillRunner;
    modelRoute?: () => ModelRoute;
    now?: () => number;
  }> = {},
): NavigatorWorkflowExecutor {
  return new NavigatorWorkflowExecutor({
    store: fixtureValue.store,
    navigator: input.navigator ?? navigatorWith(),
    observeInference: input.observe ?? (async () => observation()),
    skillRunner: input.skillRunner ?? {
      run: vi.fn(async (attempt, hooks) => {
        const resource = attempt.resource ?? { kind: "bb_thread" as const, id: "thr_research_38" };
        await hooks.bindResource(resource);
        return {
          resource,
          observedExternalStateDigest: "e".repeat(64),
          result: {
            kind: "research_result",
            summary: "The executor must persist acceptance before dispatch.",
            artifactEvidence: [{
              artifactId: fixtureValue.artifactId,
              snapshotId: fixtureValue.snapshotId,
              snapshotDigest: fixtureValue.snapshotDigest,
              finding: "Proposal acceptance and effect creation share one transaction.",
              evidenceRefs: ["source:ticket-38"],
            }],
          },
        };
      }),
    },
    modelRoute: input.modelRoute ?? (() => ({
      pool: "strong",
      ...DEFAULT_MODEL_POOL_REGISTRY.worker.strong,
    })),
    clock: { now: input.now ?? (() => 1_100) },
  });
}

function protocolFor(
  value: Fixture,
  skillExecute: NavigatorEffectAdapter["execute"] = async (context) => skillCompletion(context),
  leaseMs = 30_000,
  skillReconcile?: NavigatorEffectAdapter["reconcile"],
  now: () => number = () => 1_100,
): NavigatorEffectProtocol {
  const skillAdapter: NavigatorEffectAdapter = {
    kind: "run_navigator_skill",
    execute: skillExecute,
    ...(skillReconcile === undefined ? {} : { reconcile: skillReconcile }),
  };
  return new NavigatorEffectProtocol({
    store: value.store,
    clock: { now },
    leaseMs,
    adapters: [
      skillAdapter,
      {
        kind: "run_navigator_ticket_worker",
        execute: async (): Promise<NavigatorEffectOutcome> => ({ outcome: "permanent", reason: "unused" }),
      },
      {
        kind: "run_navigator_release",
        execute: async (): Promise<NavigatorEffectOutcome> => ({ outcome: "permanent", reason: "unused" }),
      },
    ],
  });
}

function skillCompletion(context: NavigatorEffectContext): NavigatorEffectOutcome {
  if (context.kind !== "run_navigator_skill") {
    return { outcome: "permanent", reason: "skill completion received another effect kind" };
  }
  const resource = context.attempt.resource ?? { kind: "bb_thread" as const, id: "thr_research_38" };
  return {
    outcome: "completed",
    receipt: {
      kind: "run_navigator_skill",
      effectIdempotencyKey: context.effect.idempotencyKey,
      attemptId: context.attempt.id,
      resource,
      observedExternalStateDigest: "e".repeat(64),
      result: {
        kind: "research_result",
        summary: "The executor must persist acceptance before dispatch.",
        artifactEvidence: context.artifactBindings.map((binding) => ({
          ...binding,
          finding: "Proposal acceptance and effect creation share one transaction.",
          evidenceRefs: ["source:ticket-38"],
        })),
      },
    },
  };
}

function executorLeaseWithProjectClaim(
  value: Fixture,
  ownerId: string,
  now = 1_100,
  leaseMs = 30_000,
): { generation: number } {
  const lease = value.store.acquireExecutorLease(ownerId, now, leaseMs);
  if (!lease.acquired) throw new Error("navigator test executor lease was unavailable");
  value.db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at, released_at, release_reason
     ) VALUES (?, ?, 'project', 'held', ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    value.job.id,
    "project:proj_1:pipeline",
    ownerId,
    lease.generation,
    now + leaseMs,
    now,
    now,
  );
  return { generation: lease.generation };
}

type CapabilityEvidenceCase =
  | "valid"
  | "missing"
  | "denied"
  | "stale"
  | "wrong descriptor"
  | "wrong profile revision"
  | "wrong project"
  | "wrong operation";

const CAPABILITY_EVIDENCE_CASES: readonly CapabilityEvidenceCase[] = [
  "valid",
  "missing",
  "denied",
  "stale",
  "wrong descriptor",
  "wrong profile revision",
  "wrong project",
  "wrong operation",
];

function prepareCapabilityExecutor(value: Fixture, now: number): void {
  const predecessor = executorLeaseWithProjectClaim(value, "navigator-capability-predecessor", now, 1_000);
  value.db.prepare(
    `UPDATE job_resource_claims SET lease_expires_at = ?
      WHERE job_id = ? AND resource_kind = 'project' AND resource_key = 'project:proj_1:pipeline'`,
  ).run(now, value.job.id);
  value.db.prepare(
    `UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?, lease_expires_at = ?
      WHERE job_id = ? AND kind = 'run_navigator_skill'`,
  ).run("navigator-capability-predecessor", predecessor.generation, now, value.job.id);
  if (!value.store.releaseExecutorLease("navigator-capability-predecessor", predecessor.generation, now)) {
    throw new Error("navigator capability predecessor lease was not released");
  }
}

function corruptCapabilityEvidence(
  value: Fixture,
  accepted: Readonly<{ effectIdempotencyKey: string; attemptId: string }>,
  testCase: Exclude<CapabilityEvidenceCase, "valid">,
): void {
  const attempt = value.store.getNavigatorSkillAttempt(accepted.attemptId);
  if (!attempt) throw new Error("navigator capability matrix attempt was not stored");
  const profile = value.store.getLatestCapabilityProfile("worker_attempt", attempt.id);
  if (!profile) throw new Error("navigator capability matrix profile was not stored");
  const evidence = value.store.getNavigatorCapabilityEvidence(accepted.effectIdempotencyKey)[0];
  if (!evidence && testCase !== "missing") throw new Error("navigator capability matrix evidence was not stored");
  if (testCase === "missing") {
    value.db.exec("DROP TRIGGER navigator_effect_capability_evidence_append_only_delete");
    value.db.prepare("DELETE FROM navigator_effect_capability_evidence WHERE effect_idempotency_key = ?")
      .run(accepted.effectIdempotencyKey);
  } else if (testCase === "denied") {
    value.store.appendCapabilityReceipt({
      profileId: profile.id,
      capabilityId: attempt.skillId,
      capabilityKind: "skill",
      descriptorDigest: attempt.descriptorDigest,
      eventType: "denied",
      reasonCode: "matrix_denied",
      mandatory: true,
      evidenceRefs: ["test:capability-matrix"],
      now: 1_100,
    });
  } else if (testCase === "stale") {
    value.db.prepare(
      "UPDATE navigator_skill_attempts SET capability_profile_revision = ? WHERE id = ?",
    ).run(profile.revision + 1, attempt.id);
  } else if (testCase === "wrong descriptor") {
    value.db.prepare(
      "UPDATE navigator_effect_capability_evidence SET descriptor_digest = ? WHERE effect_idempotency_key = ?",
    ).run("d".repeat(64), accepted.effectIdempotencyKey);
  } else if (testCase === "wrong profile revision") {
    value.db.prepare(
      "UPDATE navigator_effect_capability_evidence SET profile_revision = ? WHERE effect_idempotency_key = ?",
    ).run(profile.revision + 1, accepted.effectIdempotencyKey);
  } else if (testCase === "wrong project") {
    value.db.prepare(
      "UPDATE navigator_effect_capability_evidence SET project_id = ? WHERE effect_idempotency_key = ?",
    ).run("proj_other", accepted.effectIdempotencyKey);
  } else {
    value.db.prepare(
      "UPDATE navigator_effect_capability_evidence SET operation = 'prototype_write' WHERE effect_idempotency_key = ?",
    ).run(accepted.effectIdempotencyKey);
  }
}

async function runCapabilityExecutor(
  value: Fixture,
  protocol: NavigatorEffectProtocol,
  now: number,
): Promise<void> {
  const abort = new AbortController();
  await runJobExecutorService({
    store: value.store,
    clock: { now: () => now },
    leaseMs: 1_000,
    navigatorEffects: protocol,
    effectRunnerFactory: () => ({ run: async () => undefined }),
    waitForWork: async () => abort.abort(),
    releaseOnShutdown: true,
  }, abort.signal);
}

type ClaimCase = "empty" | "unrelated" | "wrong key" | "wrong kind" | "wrong owner" | "wrong generation" | "expired" | "valid exact";
const CLAIM_CASES: readonly ClaimCase[] = [
  "empty", "unrelated", "wrong key", "wrong kind", "wrong owner", "wrong generation", "expired", "valid exact",
];

function insertClaimMatrixCase(
  value: Fixture,
  claimCase: ClaimCase,
  ownerId: string,
  generation: number,
  now: number,
): void {
  if (claimCase === "empty") return;
  const resourceKind = claimCase === "wrong kind" ? "repository_merge" : "project";
  const resourceKey = claimCase === "unrelated"
    ? "project:unrelated:pipeline"
    : claimCase === "wrong key" ? "project:proj_1:other" : "project:proj_1:pipeline";
  const claimOwner = claimCase === "wrong owner" ? `${ownerId}-other` : ownerId;
  const claimGeneration = claimCase === "wrong generation" ? generation + 1 : generation;
  const expiresAt = claimCase === "expired" ? now : now + 30_000;
  value.db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at, released_at, release_reason
     ) VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(value.job.id, resourceKey, resourceKind, claimOwner, claimGeneration, expiresAt, now, now);
}

describe("navigator-v1 durable executor slice", () => {
  it("locks the ticket 39 planning contracts and pinned routing signals", () => {
    expect(Object.keys(NAVIGATOR_PLANNING_STEP_CONTRACTS)).toEqual([
      "wayfinder",
      "to-spec",
      "to-tickets",
      "research",
      "ask-matt",
    ]);
    expect(NAVIGATOR_PLANNING_STEP_CONTRACTS.wayfinder).toMatchObject({
      invocationClass: "user",
      operationClass: "artifact_write",
    });
    expect(NAVIGATOR_PLANNING_STEP_CONTRACTS.research).toMatchObject({
      invocationClass: "model",
      operationClass: "read_only",
    });
    const baseSignals = {
      trackerConfigured: true,
      specificationReady: false,
      hugeMultiSessionEffort: false,
      routeToDestinationVisible: true,
      needsPrimarySourceFacts: false,
      runnableDesignQuestion: false,
      workingDirectoryAvailable: true,
      requirementsUnclear: false,
    };
    expect(selectNavigatorPlanningRoute({ ...baseSignals, trackerConfigured: false }))
      .toBe("setup-matt-pocock-skills");
    expect(selectNavigatorPlanningRoute({ ...baseSignals, specificationReady: true }))
      .toBe("to-tickets");
    expect(selectNavigatorPlanningRoute({ ...baseSignals, needsPrimarySourceFacts: true }))
      .toBe("research");
    expect(selectNavigatorPlanningRoute({
      ...baseSignals,
      hugeMultiSessionEffort: true,
      routeToDestinationVisible: false,
    })).toBe("wayfinder");
    expect(selectNavigatorPlanningRoute({
      ...baseSignals,
      routeToDestinationVisible: false,
      requirementsUnclear: true,
    })).toBe("grill-with-docs");
    expect(selectNavigatorPlanningRoute(baseSignals)).toBe("to-spec");
  });

  it.each([
    "setup-matt-pocock-skills",
    "prototype",
    "handoff",
  ])("STD-39-001: rejects unsupported side-effecting %s steps", async (skillId) => {
    const value = fixture();
    const workflow = executor(value, {
      navigator: navigatorWith((snapshot) => ({
        kind: "invoke_skill",
        basedOn: snapshot.identity,
        rationale: "This skill performs effects outside the executor boundary.",
        evidenceRefs: ["ticket:39:STD-39-001"],
        skillId,
        subjectArtifactIds: skillId === "setup-matt-pocock-skills" ? [] : [value.artifactId],
        objective: `Attempt unsupported ${skillId} work.`,
      })),
    });

    await expect(workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    })).resolves.toMatchObject({
      decision: "rejected",
      reasonCode: "capability_denied",
      workflowStepId: null,
    });
    expect(value.store.listEffectsForJob(value.job.id)
      .filter((effect) => effect.kind === "run_navigator_skill")).toEqual([]);
  });

  it("keeps historical and newly created recipe jobs on recipe-v1", () => {
    const { bb } = createFakePluginHost({ pluginId: `navigator-recipe-${fixtureNumber++}` });
    const db = bb.storage.database();
    const store = openStore(bb.storage, bb.storage.kv, () => 1_000);
    const created = store.createJob({ id: "job_recipe", sourceUpdateId: 1, requestText: "legacy work", now: 1_000 });
    const navigatorCreated = store.createJob({
      id: "job_navigator_from_creation",
      sourceUpdateId: 2,
      requestText: "deterministic navigator work",
      workflow: { engine: "navigator-v1", mode: "deterministic" },
      now: 1_001,
    });

    expect(created).toMatchObject({
      workflowEngine: "recipe-v1",
      workflowMode: "live",
      workflowRevision: 1,
      currentWorkflowStepId: null,
      artifactBindings: [],
    });
    expect(db.prepare("SELECT workflow_engine, workflow_mode FROM jobs WHERE id = ?").get(created.id))
      .toEqual({ workflow_engine: "recipe-v1", workflow_mode: "live" });
    expect(navigatorCreated).toMatchObject({
      workflowEngine: "navigator-v1",
      workflowMode: "deterministic",
      artifactBindings: [],
    });
    expect(NAVIGATOR_SKILL_CATALOG).toHaveLength(35);
  });

  it("accepts one strict admitted read-only proposal and creates its effect atomically", async () => {
    const value = fixture();
    const workflow = executor(value);
    const decision = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: ["owner-request:38"],
    });

    expect(decision).toMatchObject({ decision: "accepted", reasonCode: "accepted" });
    const proposal = value.store.getNavigatorProposal(decision.proposalId);
    const step = value.store.getNavigatorWorkflowStep(decision.workflowStepId!);
    const attempt = value.store.getNavigatorSkillAttempt(decision.attemptId!);
    const effect = value.store.getEffect(value.job.id, decision.effectIdempotencyKey!);
    expect(proposal).toMatchObject({ kind: "invoke_skill", snapshotId: decision.snapshotId });
    expect(proposal?.observation).toEqual(observation());
    expect(proposal?.observationDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(step).toMatchObject({ skillId: "research", jobVersion: value.job.version });
    expect(attempt).toMatchObject({
      skillId: "research",
      skillRevision: "6654f6b60cd9d5be8b54c6fafe44346dabeb3b76",
      artifactBindings: value.job.artifactBindings,
      stepInput: {
        kind: "navigator_research_input",
        objective: "Identify the one exact executor invariant this ticket must preserve.",
        artifactBindings: value.job.artifactBindings,
      },
      jobVersion: value.job.version,
      resource: null,
    });
    expect(attempt?.descriptorDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(attempt?.stepContractDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(attempt?.catalogDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(attempt?.stepInputDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(attempt?.modelRoute).toMatchObject({ pool: "strong", modelId: "gpt-5.6-sol" });
    expect(effect).toMatchObject({ kind: "run_navigator_skill", status: "pending" });
    expect(value.store.getJob(value.job.id)).toMatchObject({
      workflowEngine: "navigator-v1",
      workflowMode: "deterministic",
      currentWorkflowStepId: decision.workflowStepId,
    });
  });

  it("exposes a deeply immutable bounded navigator snapshot", () => {
    const value = fixture();
    const snapshot = value.store.createNavigatorSnapshot({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: ["owner-request:38"],
      now: 1_050,
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.identity)).toBe(true);
    expect(Object.isFrozen(snapshot.artifactBindings)).toBe(true);
    expect(Object.isFrozen(snapshot.artifactBindings[0])).toBe(true);
    expect(Object.isFrozen(snapshot.skillCatalog)).toBe(true);
    expect(Object.isFrozen(snapshot.skillCatalog[0])).toBe(true);
    expect(Object.isFrozen(snapshot.evidenceRefs)).toBe(true);
    expect(() => value.store.createNavigatorSnapshot({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: Array.from({ length: 22 }, () => "界".repeat(1_024)),
      now: 1_051,
    })).toThrow("navigator snapshot must be bounded JSON");
  });

  it("rejects a reused step contract revision whose stored identity has drifted", async () => {
    const value = fixture();
    value.db.prepare(
      `INSERT INTO workflow_step_contracts (
         id, revision, skill_id, digest, contract_json, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      NAVIGATOR_RESEARCH_STEP_CONTRACT.id,
      NAVIGATOR_RESEARCH_STEP_CONTRACT.revision,
      NAVIGATOR_RESEARCH_STEP_CONTRACT.skillId,
      "a".repeat(64),
      "{}",
      1_040,
    );

    await expect(executor(value).proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    })).rejects.toThrow("navigator step contract revision drifted");
    expect(value.store.listEffectsForJob(value.job.id).filter((effect) => effect.kind === "run_navigator_skill"))
      .toEqual([]);
    expect(value.store.getJob(value.job.id)?.currentWorkflowStepId).toBeNull();
  });

  it("records a malformed proposal without selecting an execution model", async () => {
    const value = fixture();
    const decision = await executor(value, {
      navigator: navigatorWith(() => ({ kind: "invoke_skill" })),
      modelRoute: () => {
        throw new Error("a rejected proposal must not resolve an execution model");
      },
    }).proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });

    expect(decision).toMatchObject({ decision: "rejected", reasonCode: "malformed_proposal" });
  });

  it.each<Readonly<{
    name: string;
    proposal?: (snapshot: NavigatorSnapshot) => unknown;
    observe?: (snapshot: NavigatorSnapshot) => Promise<NavigatorInferenceObservation>;
    reason: string;
  }>>([
      { name: "malformed", proposal: () => ({ kind: "invoke_skill" }), reason: "malformed_proposal" },
      {
        name: "oversized",
        proposal: (snapshot) => invokeResearch(snapshot, {
          evidenceRefs: Array.from({ length: 128 }, () => "x".repeat(1_024)),
        }),
        reason: "oversized_proposal",
      },
      {
        name: "stale",
        proposal: (snapshot) => invokeResearch(snapshot, {
          basedOn: { ...snapshot.identity, jobVersion: snapshot.identity.jobVersion - 1 },
        } as Partial<NavigatorProposal>),
        reason: "stale_job_version",
      },
      {
        name: "denied",
        proposal: (snapshot) => invokeResearch(snapshot, { skillId: "implement" } as Partial<NavigatorProposal>),
        reason: "capability_denied",
      },
      {
        name: "unauthorized subject",
        proposal: (snapshot) => invokeResearch(snapshot, { subjectArtifactIds: ["artifact_not_bound"] }),
        reason: "unauthorized_subject",
      },
      {
        name: "native tool",
        observe: async () => observation({ nativeToolCalls: ["shell"] }),
        reason: "policy_native_tool_use",
      },
      {
        name: "worktree",
        observe: async () => observation({ claimedCodeWorktreeId: "env_forbidden" }),
        reason: "policy_claimed_code_worktree",
      },
      {
        name: "dynamic effect tool",
        observe: async () => observation({ dynamicEffectToolIds: ["tracker.write"] }),
        reason: "policy_dynamic_effect_tool",
      },
      {
        name: "external drift",
        observe: async () => observation({ externalStateDigest: "d".repeat(64) }),
        reason: "external_drift",
      },
  ])("records the $name proposal rejection without effects", async (testCase) => {
    const value = fixture();
    const workflow = executor(value, {
      navigator: navigatorWith(testCase.proposal),
      ...(testCase.observe === undefined ? {} : { observe: testCase.observe }),
    });
    const decision = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    expect(decision).toMatchObject({ decision: "rejected", reasonCode: testCase.reason });
    expect(value.store.listEffectsForJob(value.job.id).filter((effect) => effect.kind === "run_navigator_skill"))
      .toEqual([]);
    expect(value.store.getJob(value.job.id)?.currentWorkflowStepId).toBeNull();
  });

  it.each<NavigatorProposal["kind"]>([
    "invoke_skill",
    "start_release",
    "owner_boundary",
    "unresolved_next_step",
    "finish",
  ])("records the %s shadow proposal without dispatch", async (kind) => {
    const value = fixture("shadow");
    const workflow = executor(value, {
      navigator: navigatorWith((snapshot) => {
        const base = {
          basedOn: snapshot.identity,
          rationale: "Shadow comparison only.",
          evidenceRefs: [],
        };
        if (kind === "invoke_skill") return { ...invokeResearch(snapshot), ...base };
        if (kind === "start_release") return { ...base, kind, implementationTicketIds: [value.artifactId] };
        if (kind === "owner_boundary") return {
          ...base,
          kind,
          boundaryCode: "technical_tradeoff_required",
          question: "Which irreversible compatibility tradeoff should govern?",
          recommendedAction: "Preserve compatibility.",
        };
        if (kind === "unresolved_next_step") return {
          ...base,
          kind,
          question: "Which admitted skill should resolve the routing gap?",
          candidateSkillIds: ["research"],
        };
        return { ...base, kind, artifactIds: [value.artifactId] };
      }),
    });
    const decision = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    expect(decision).toMatchObject({ decision: "shadowed", reasonCode: "shadow_only" });
    expect(value.store.getNavigatorProposal(decision.proposalId)?.kind).toBe(kind);
    expect(value.store.listEffectsForJob(value.job.id).filter((effect) => effect.kind === "run_navigator_skill"))
      .toEqual([]);
  });

  it("rejects a proposal when its bound tracker snapshot changes during inference", async () => {
    const value = fixture();
    const current = value.store.getWorkArtifactSnapshot(value.snapshotId);
    if (!current) throw new Error("artifact snapshot fixture disappeared");
    const workflow = executor(value, {
      observe: async () => {
        value.store.observeWorkArtifact({
          artifactId: value.artifactId,
          expectedExternalRevision: "ticket-38-etag-1",
          externalRevision: "ticket-38-etag-2",
          externalStatus: "open",
          assignees: ["owner"],
          title: current.title,
          content: `${current.content}\n\nTracker edit during inference.`,
          acceptanceCriteria: current.acceptanceCriteria,
          relationships: current.relationships,
          observedAt: 1_095,
        });
        return observation();
      },
    });
    const decision = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });

    expect(decision).toMatchObject({ decision: "rejected", reasonCode: "stale_artifact_snapshot" });
    expect(value.store.listEffectsForJob(value.job.id).filter((effect) => effect.kind === "run_navigator_skill"))
      .toEqual([]);
  });

  it("admits user-invoked planning skills only from an explicit navigator proposal", async () => {
    const value = fixture();
    const explicitWayfinder = executor(value, {
      navigator: navigatorWith((snapshot) => ({
        kind: "invoke_skill",
        basedOn: snapshot.identity,
        rationale: "This effort is too large and foggy for one session.",
        evidenceRefs: ["owner-request:39"],
        skillId: "wayfinder",
        subjectArtifactIds: [value.artifactId],
        objective: "Chart one canonical decision map.",
      })),
    });
    const accepted = await explicitWayfinder.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    expect(accepted).toMatchObject({ decision: "accepted", reasonCode: "accepted" });
    expect(value.store.getNavigatorSkillAttempt(accepted.attemptId!)).toMatchObject({
      skillId: "wayfinder",
      stepInput: { kind: "navigator_planning_input", skillId: "wayfinder" },
    });
  });

  it("skips wayfinding once a canonical specification is already bound", async () => {
    const value = fixture("deterministic", true);
    const workflow = executor(value, {
      navigator: navigatorWith((snapshot) => ({
        kind: "invoke_skill",
        basedOn: snapshot.identity,
        rationale: "Try to map work that is already specified.",
        evidenceRefs: ["owner-request:39"],
        skillId: "wayfinder",
        subjectArtifactIds: [value.artifactId],
        objective: "Create a redundant map.",
      })),
    });
    const decision = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    expect(decision).toMatchObject({ decision: "rejected", reasonCode: "unnecessary_wayfinding" });
    expect(value.store.listEffectsForJob(value.job.id)
      .filter((effect) => effect.kind === "run_navigator_skill")).toEqual([]);
  });

  it("stores one ask-matt consultation and blocks a second unchanged unresolved result", async () => {
    const value = fixture();
    const unresolved = (snapshot: NavigatorSnapshot): NavigatorProposal => ({
      kind: "unresolved_next_step",
      basedOn: snapshot.identity,
      rationale: "The evidence admits two different planning routes.",
      evidenceRefs: ["owner-request:39"],
      question: "Should this task use research or wayfinder next?",
      candidateSkillIds: ["research", "wayfinder"],
    });
    const runner: NavigatorSkillRunner = {
      run: vi.fn(async (attempt, hooks) => {
        const resource = { kind: "bb_thread" as const, id: "thr_ask_matt_39" };
        await hooks.bindResource(resource);
        if (attempt.stepInput.kind !== "navigator_planning_input") {
          throw new Error("ask-matt received the wrong input contract");
        }
        return {
          resource,
          observedExternalStateDigest: "e".repeat(64),
          result: {
            kind: "ask_matt_result",
            decisionDigest: attempt.stepInput.routingDecisionDigest,
            advice: "Use research only when primary-source facts block the route.",
            suggestedSkillIds: ["research"],
            evidenceRefs: ["skill:ask-matt"],
          },
        };
      }),
    };
    const workflow = executor(value, {
      navigator: navigatorWith(unresolved),
      skillRunner: runner,
    });
    const first = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    expect(first).toMatchObject({ decision: "accepted", reasonCode: "ask_matt_scheduled" });
    const attempt = value.store.getNavigatorSkillAttempt(first.attemptId!);
    if (attempt?.stepInput.kind !== "navigator_planning_input") {
      throw new Error("ask-matt attempt was not persisted");
    }
    const decisionDigest = attempt.stepInput.routingDecisionDigest!;
    expect(value.store.getNavigatorRoutingDecision(decisionDigest)).toMatchObject({
      question: "Should this task use research or wayfinder next?",
      candidateSkillIds: ["research", "wayfinder"],
      advice: null,
    });
    const lease = value.store.acquireExecutorLease("executor-ask-matt", 1_100, 30_000);
    if (!lease.acquired) throw new Error("ask-matt executor lease was unavailable");
    await workflow.processOne({
      ownerId: "executor-ask-matt",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal);
    expect(value.store.getNavigatorRoutingDecision(decisionDigest)).toMatchObject({
      advice: {
        advice: "Use research only when primary-source facts block the route.",
        suggestedSkillIds: ["research"],
      },
      blocked: false,
    });

    const second = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    expect(second).toMatchObject({
      decision: "accepted",
      reasonCode: "routing_blocked_after_consultation",
      workflowStepId: null,
    });
    expect(value.store.getNavigatorRoutingDecision(decisionDigest)).toMatchObject({ blocked: true });
    expect(value.store.getJob(value.job.id)).toMatchObject({ state: "blocked" });
  });

  it("SPEC-39-001: scopes identical routing decisions to the job", async () => {
    const value = fixture();
    const secondJob = addNavigatorJob(value, "job_navigator_same_words", 39_999);
    const unresolved = (snapshot: NavigatorSnapshot): NavigatorProposal => ({
      kind: "unresolved_next_step",
      basedOn: snapshot.identity,
      rationale: "The evidence admits two different planning routes.",
      evidenceRefs: ["owner-request:39"],
      question: "Should this task use research or wayfinder next?",
      candidateSkillIds: ["research", "wayfinder"],
    });
    const workflow = executor(value, { navigator: navigatorWith(unresolved) });

    const first = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const second = await workflow.proposeNext({
      jobId: secondJob.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });

    expect(first).toMatchObject({ decision: "accepted", reasonCode: "ask_matt_scheduled" });
    expect(second).toMatchObject({ decision: "accepted", reasonCode: "ask_matt_scheduled" });
    const firstAttempt = value.store.getNavigatorSkillAttempt(first.attemptId!);
    const secondAttempt = value.store.getNavigatorSkillAttempt(second.attemptId!);
    if (
      firstAttempt?.stepInput.kind !== "navigator_planning_input" ||
      secondAttempt?.stepInput.kind !== "navigator_planning_input"
    ) throw new Error("routing attempts were not persisted");
    expect(secondAttempt.stepInput.routingDecisionDigest)
      .not.toBe(firstAttempt.stepInput.routingDecisionDigest);
    expect(value.store.getJob(secondJob.id)).not.toMatchObject({ state: "blocked" });
  });

  it("SPEC-39-001: scopes routing advice to the accepted workflow and artifact revision", async () => {
    const value = fixture();
    const unresolved = (snapshot: NavigatorSnapshot): NavigatorProposal => ({
      kind: "unresolved_next_step",
      basedOn: snapshot.identity,
      rationale: "The evidence admits two different planning routes.",
      evidenceRefs: ["owner-request:39"],
      question: "Should this task use research or wayfinder next?",
      candidateSkillIds: ["research", "wayfinder"],
    });
    const workflow = executor(value, {
      navigator: navigatorWith(unresolved),
      skillRunner: {
        run: vi.fn(async (attempt, hooks) => {
          const resource = { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
          await hooks.bindResource(resource);
          if (attempt.stepInput.kind !== "navigator_planning_input") {
            throw new Error("ask-matt received the wrong input contract");
          }
          return {
            resource,
            observedExternalStateDigest: "e".repeat(64),
            result: {
              kind: "ask_matt_result",
              decisionDigest: attempt.stepInput.routingDecisionDigest,
              advice: "Use research for the currently bound ticket revision.",
              suggestedSkillIds: ["research"],
              evidenceRefs: ["skill:ask-matt"],
            },
          };
        }),
      },
    });
    const first = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const lease = value.store.acquireExecutorLease("executor-routing-revision", 1_100, 30_000);
    if (!lease.acquired) throw new Error("routing revision executor lease was unavailable");
    await workflow.processOne({
      ownerId: "executor-routing-revision",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal);
    const artifact = value.store.getWorkArtifact(value.artifactId)!;
    const snapshot = value.store.getCurrentWorkArtifactSnapshot(value.artifactId)!;
    value.store.observeWorkArtifact({
      artifactId: artifact.id,
      expectedExternalRevision: artifact.externalRevision,
      externalRevision: "ticket-38-etag-2",
      externalStatus: artifact.externalStatus,
      assignees: artifact.assignees,
      title: artifact.title,
      content: `${snapshot.content}\n\nRevision-scoped routing evidence.`,
      acceptanceCriteria: snapshot.acceptanceCriteria,
      relationships: snapshot.relationships,
      observedAt: 1_200,
    });

    const second = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    expect(second).toMatchObject({ decision: "accepted", reasonCode: "ask_matt_scheduled" });
    const firstAttempt = value.store.getNavigatorSkillAttempt(first.attemptId!);
    const secondAttempt = value.store.getNavigatorSkillAttempt(second.attemptId!);
    if (
      firstAttempt?.stepInput.kind !== "navigator_planning_input" ||
      secondAttempt?.stepInput.kind !== "navigator_planning_input"
    ) throw new Error("routing revision attempts were not persisted");
    expect(secondAttempt.workflowRevision).toBeGreaterThan(firstAttempt.workflowRevision);
    expect(secondAttempt.stepInput.routingDecisionDigest)
      .not.toBe(firstAttempt.stepInput.routingDecisionDigest);
  });

  it("SPEC-38-001: does not dispatch an accepted navigator step after its job is cancelled", async () => {
    const value = fixture();
    const skillRun = vi.fn();
    const workflow = executor(value, { skillRunner: { run: skillRun } });
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const acceptedJob = value.store.getJob(value.job.id);
    if (!acceptedJob) throw new Error("accepted navigator job disappeared");
    const cancelled = value.store.applyJobEvent(acceptedJob.id, acceptedJob.version, {
      type: "CANCEL_REQUESTED",
      activeWorkers: [],
    }, 1_090);
    expect(cancelled).toMatchObject({ state: "cancelled", cancelRequestedAt: 1_090 });

    const lease = value.store.acquireExecutorLease("executor-cancelled-before-dispatch", 1_100, 30_000);
    if (!lease.acquired) throw new Error("cancelled-before-dispatch executor lease was unavailable");
    await expect(workflow.processOne({
      ownerId: "executor-cancelled-before-dispatch",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal)).resolves.toBe(false);

    expect(skillRun).not.toHaveBeenCalled();
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    expect(value.store.getNavigatorWorkflowStepOutcome(accepted.workflowStepId!)).toBeNull();
  });

  it("SPEC-38-001: supersedes an in-flight navigator step when cancellation interrupts its result", async () => {
    const value = fixture();
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseResult!: () => void;
    const resultReleased = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const skillRun = vi.fn(async (_attempt, hooks) => {
      const resource = { kind: "bb_thread" as const, id: "thr_cancelled_in_flight" };
      await hooks.bindResource(resource);
      signalStarted();
      await resultReleased;
      return {
        resource,
        observedExternalStateDigest: "e".repeat(64),
        result: {
          kind: "research_result",
          summary: "This result arrived after cancellation.",
          artifactEvidence: [{
            artifactId: value.artifactId,
            snapshotId: value.snapshotId,
            snapshotDigest: value.snapshotDigest,
            finding: "A late result must not revive cancelled work.",
            evidenceRefs: ["bb:thr_cancelled_in_flight"],
          }],
        },
      };
    });
    let now = 1_100;
    const workflow = executor(value, { skillRunner: { run: skillRun }, now: () => now });
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const lease = value.store.acquireExecutorLease("executor-cancelled-in-flight", now, 30_000);
    if (!lease.acquired) throw new Error("cancelled-in-flight executor lease was unavailable");
    const processing = workflow.processOne({
      ownerId: "executor-cancelled-in-flight",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal);
    await started;

    now = 1_110;
    const runningJob = value.store.getJob(value.job.id);
    if (!runningJob) throw new Error("running navigator job disappeared");
    const cancellationRequested = value.store.applyJobEvent(runningJob.id, runningJob.version, {
      type: "CANCEL_REQUESTED",
    }, now);
    expect(cancellationRequested.cancelRequestedAt).toBe(now);
    releaseResult();
    await expect(processing).resolves.toBe(true);

    expect(value.store.getNavigatorWorkflowStepOutcome(accepted.workflowStepId!)).toBeNull();
    expect(value.db.prepare(
      `SELECT superseded_by_step_id, reason FROM workflow_step_supersessions
        WHERE workflow_step_id = ?`,
    ).get(accepted.workflowStepId)).toEqual({
      superseded_by_step_id: null,
      reason: "job_cancelled",
    });
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({
      status: "done",
      lastError: "superseded:job_cancelled",
    });
    expect(value.store.getJob(value.job.id)).toMatchObject({
      cancelRequestedAt: now,
      currentWorkflowStepId: null,
      workflowRevision: value.job.workflowRevision,
    });
  });

  it("settles a structured result with exact artifact evidence through the highest executor seam", async () => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const protocol = new NavigatorEffectProtocol({
      store: value.store,
      clock: { now: () => 1_100 },
      adapters: [
        { kind: "run_navigator_skill", execute: async (context) => skillCompletion(context) },
        {
          kind: "run_navigator_ticket_worker",
          execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused in this test" })),
        },
        {
          kind: "run_navigator_release",
          execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused in this test" })),
        },
      ],
    });
    const lease = executorLeaseWithProjectClaim(value, "navigator-highest");
    await protocol.processOne({
      ownerId: "navigator-highest",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal);

    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({ status: "done" });
    expect(value.store.getNavigatorSkillAttempt(accepted.attemptId!)).toMatchObject({
      resource: { kind: "bb_thread", id: "thr_research_38" },
    });
    expect(value.store.getNavigatorWorkflowStepOutcome(accepted.workflowStepId!)).toMatchObject({
      outcome: "succeeded",
      artifactEvidence: [{ artifactId: value.artifactId, snapshotId: value.snapshotId }],
    });
    expect(value.store.getJob(value.job.id)).toMatchObject({
      currentWorkflowStepId: null,
      workflowRevision: value.job.workflowRevision + 1,
    });
  });

  it("does not complete a skill effect when the adapter omits its receipt", async () => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const execute = vi.fn(async (): Promise<NavigatorEffectOutcome> => ({
      outcome: "completed",
      receipt: undefined as never,
    }));
    const protocol = protocolFor(value, execute);
    const lease = executorLeaseWithProjectClaim(value, "navigator-receiptless-skill");

    await expect(protocol.processOne({
      ownerId: "navigator-receiptless-skill",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal)).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).not.toMatchObject({ status: "done" });
    expect(value.store.getNavigatorWorkflowStepOutcome(accepted.workflowStepId!)).toBeNull();
  });

  it("does not call an adapter when the persisted capability receipt is denied", async () => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const attempt = value.store.getNavigatorSkillAttempt(accepted.attemptId!);
    if (!attempt) throw new Error("navigator capability test attempt was not stored");
    const profile = value.store.getLatestCapabilityProfile("worker_attempt", attempt.id);
    if (!profile) throw new Error("navigator capability profile was not stored");
    value.store.appendCapabilityReceipt({
      profileId: profile.id,
      capabilityId: attempt.skillId,
      capabilityKind: "skill",
      descriptorDigest: attempt.descriptorDigest,
      eventType: "denied",
      reasonCode: "test_denied",
      mandatory: true,
      evidenceRefs: ["test:denied"],
      now: 1_100,
    });
    const execute = vi.fn(async (): Promise<NavigatorEffectOutcome> => ({ outcome: "permanent", reason: "not called" }));
    const protocol = protocolFor(value, execute);
    const lease = executorLeaseWithProjectClaim(value, "navigator-capability-denied");

    await expect(protocol.processOne({
      ownerId: "navigator-capability-denied",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal)).resolves.toBe(true);

    expect(execute).not.toHaveBeenCalled();
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({ status: "dead" });
  });

  it("does not call an adapter when the exact project claim is missing", async () => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const execute = vi.fn(async (): Promise<NavigatorEffectOutcome> => ({ outcome: "permanent", reason: "not called" }));
    const protocol = protocolFor(value, execute);
    const lease = value.store.acquireExecutorLease("navigator-claim-missing", 1_100, 30_000);
    if (!lease.acquired) throw new Error("navigator claim test executor lease was unavailable");

    await expect(protocol.processOne({
      ownerId: "navigator-claim-missing",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal)).resolves.toBe(false);

    expect(execute).not.toHaveBeenCalled();
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({ status: "pending" });
  });

  it.each(CAPABILITY_EVIDENCE_CASES)(
    "admits only exact persisted capability evidence (%s)",
    async (testCase) => {
      const value = fixture();
      const accepted = await executor(value).proposeNext({
        jobId: value.job.id,
        externalStateDigest: "e".repeat(64),
        evidenceRefs: [],
      });
      if (!accepted.attemptId || !accepted.effectIdempotencyKey) {
        throw new Error("navigator capability matrix admission was incomplete");
      }
      if (testCase !== "valid") corruptCapabilityEvidence(value, {
        effectIdempotencyKey: accepted.effectIdempotencyKey,
        attemptId: accepted.attemptId,
      }, testCase);
      prepareCapabilityExecutor(value, 1_100);
      const contexts: NavigatorEffectContext[] = [];
      const execute = vi.fn(async (context: NavigatorEffectContext) => {
        contexts.push(context);
        return skillCompletion(context);
      });
      const protocol = protocolFor(value, execute, 30_000, undefined, () => 1_100);

      await runCapabilityExecutor(value, protocol, 1_100);

      expect(execute).toHaveBeenCalledTimes(testCase === "valid" ? 1 : 0);
      if (testCase === "valid") {
        const context = contexts[0];
        expect(context).toBeDefined();
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.effect)).toBe(true);
        expect(Object.isFrozen(context.capabilityEvidence)).toBe(true);
        expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "done" });
      } else {
        expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "dead" });
      }
    },
  );

  it("keeps preceding-schema work pending when compatibility reauthorization is unavailable", async () => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    if (!accepted.attemptId || !accepted.effectIdempotencyKey) {
      throw new Error("navigator compatibility continuation identity was not stored");
    }
    const attempt = value.store.getNavigatorSkillAttempt(accepted.attemptId);
    if (!attempt) throw new Error("navigator compatibility profile was not stored");
    value.db.exec("DROP TRIGGER navigator_effect_capability_evidence_append_only_delete");
    value.db.prepare("DELETE FROM navigator_effect_capability_evidence WHERE effect_idempotency_key = ?")
      .run(accepted.effectIdempotencyKey);
    value.db.prepare(
      "UPDATE navigator_skill_attempts SET capability_profile_id = NULL, capability_profile_revision = NULL WHERE id = ?",
    ).run(attempt.id);
    value.db.prepare(
      `INSERT INTO navigator_effect_compatibility (
         effect_idempotency_key, job_id, kind, attempt_id, state, reason_code, decoder_revision, created_at
       ) VALUES (?, ?, 'run_navigator_skill', ?, 'pending', 'preceding_schema_capability_evidence_missing', 1, ?)`,
    ).run(accepted.effectIdempotencyKey, value.job.id, attempt.id, 1_100);
    const predecessor = executorLeaseWithProjectClaim(value, "navigator-compatibility-predecessor", 1_100, 1_000);
    value.db.prepare(
      "UPDATE job_resource_claims SET lease_expires_at = ? WHERE job_id = ? AND resource_kind = 'project'",
    ).run(1_100, value.job.id);
    if (!value.store.releaseExecutorLease("navigator-compatibility-predecessor", predecessor.generation, 1_100)) {
      throw new Error("navigator compatibility predecessor lease was not released");
    }

    const execute = vi.fn(async (context: NavigatorEffectContext) => skillCompletion(context));
    const predecessorProtocol = protocolFor(value, execute, 1_000, undefined, () => 1_100);
    await runCapabilityExecutor(value, predecessorProtocol, 1_100);
    expect(execute).not.toHaveBeenCalled();
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "pending" });

    const protocol = new NavigatorEffectProtocol({
      store: value.store,
      clock: { now: () => 1_100 },
      leaseMs: 1_000,
      adapters: [
        { kind: "run_navigator_skill", execute },
        { kind: "run_navigator_ticket_worker", execute: async () => ({ outcome: "permanent" as const, reason: "unused" }) },
        { kind: "run_navigator_release", execute: async () => ({ outcome: "permanent" as const, reason: "unused" }) },
      ],
    });
    await runCapabilityExecutor(value, protocol, 1_100);

    expect(execute).not.toHaveBeenCalled();
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "pending" });
    expect(value.db.prepare(
      "SELECT profile_id, profile_revision, owner_id, generation FROM navigator_effect_compatibility_resolutions WHERE effect_idempotency_key = ?",
    ).get(accepted.effectIdempotencyKey)).toBeUndefined();
    expect(value.db.prepare("SELECT COUNT(*) AS count FROM navigator_effect_compatibility_resolutions").get())
      .toEqual({ count: 0 });
  });

  it.each(CLAIM_CASES)("requires the exact skill claim set (%s)", async (claimCase) => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    if (claimCase === "valid exact") {
      prepareCapabilityExecutor(value, 1_100);
    } else {
      insertClaimMatrixCase(value, claimCase, "navigator-claim-matrix-invalid", 1, 1_100);
    }
    const execute = vi.fn(async (context: NavigatorEffectContext) => skillCompletion(context));
    const protocol = protocolFor(value, execute);
    await runCapabilityExecutor(value, protocol, 1_100);

    expect(execute).toHaveBeenCalledTimes(claimCase === "valid exact" ? 1 : 0);
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({
      status: claimCase === "valid exact" ? "done" : "pending",
    });
  });

  it("does not leave a typed completion receipt or workflow state after settlement rollback", async () => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const attemptId = accepted.attemptId;
    if (!attemptId) throw new Error("navigator receipt test attempt was not stored");
    const execute = vi.fn(async (context): Promise<NavigatorEffectOutcome> => ({
      outcome: "completed",
      receipt: {
        kind: "run_navigator_skill",
        effectIdempotencyKey: context.effect.idempotencyKey,
        attemptId,
        observedExternalStateDigest: "e".repeat(64),
        resource: { kind: "bb_thread", id: "thr_typed_receipt" },
        result: {
          kind: "research_result",
          summary: "typed receipt",
          artifactEvidence: [{
            artifactId: value.artifactId,
            snapshotId: value.snapshotId,
            snapshotDigest: value.snapshotDigest,
            finding: "typed receipt",
            evidenceRefs: ["receipt:typed"],
          }],
        },
      },
    }));
    const protocol = protocolFor(value, execute);
    const lease = executorLeaseWithProjectClaim(value, "navigator-settlement-rollback");
    value.db.exec(
      `CREATE TRIGGER navigator_test_fail_workflow_settlement
       BEFORE INSERT ON workflow_step_outcomes
       BEGIN SELECT RAISE(ABORT, 'navigator settlement fault'); END`,
    );

    await expect(protocol.processOne({
      ownerId: "navigator-settlement-rollback",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal)).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(value.store.getNavigatorWorkflowStepOutcome(accepted.workflowStepId!)).toBeNull();
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).not.toMatchObject({ status: "done" });
    expect(value.db.prepare(
      "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(accepted.effectIdempotencyKey)).toEqual({ count: 0 });
  });

  it("leases one navigator effect at a time and transfers an expired lease to the next generation", async () => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const firstLease = value.store.acquireExecutorLease("navigator-first", 1_100, 1_000);
    if (!firstLease.acquired) throw new Error("first navigator executor lease was unavailable");
    value.db.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at
       ) VALUES (?, 'project:proj_1:pipeline', 'project', 'held', ?, ?, ?, ?, ?)`,
    ).run(value.job.id, "navigator-first", firstLease.generation, 2_100, 1_100, 1_100);
    const first = value.store.leaseNavigatorEffect({
      ownerId: "navigator-first",
      generation: firstLease.generation,
      now: 1_100,
      leaseMs: 100,
    });
    expect(first).toMatchObject({
      idempotencyKey: accepted.effectIdempotencyKey,
      status: "leased",
      leaseOwner: "navigator-first",
      leaseGeneration: firstLease.generation,
    });
    expect(value.store.leaseNavigatorEffect({
      ownerId: "navigator-first",
      generation: firstLease.generation,
      now: 1_100,
      leaseMs: 100,
    })).toBeNull();

    value.db.prepare("UPDATE effects SET lease_expires_at = ? WHERE idempotency_key = ?")
      .run(1_200, accepted.effectIdempotencyKey);
    expect(value.store.releaseExecutorLease("navigator-first", firstLease.generation, 1_201)).toBe(true);
    const secondLease = value.store.acquireExecutorLease("navigator-second", 1_201, 10_000);
    if (!secondLease.acquired) throw new Error("second navigator executor lease was unavailable");
    const transferred = value.store.leaseNavigatorEffect({
      ownerId: "navigator-second",
      generation: secondLease.generation,
      now: 1_201,
      leaseMs: 100,
    });
    expect(transferred).toMatchObject({
      idempotencyKey: accepted.effectIdempotencyKey,
      status: "leased",
      leaseOwner: "navigator-second",
      leaseGeneration: secondLease.generation,
      attempts: 2,
    });
  });

  it("settles a lease cancellation without allowing a cancelled job to retry", async () => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const finishPromise = new Promise<void>((resolve) => { finish = resolve; });
    const execute = vi.fn(async (context: NavigatorEffectContext) => {
      started();
      await finishPromise;
      return { outcome: "lease_cancelled" as const, reason: "job cancellation reached the protocol" };
    });
    const protocol = protocolFor(value, execute);
    const lease = executorLeaseWithProjectClaim(value, "navigator-cancel");
    const processing = protocol.processOne({
      ownerId: "navigator-cancel",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal);
    await startedPromise;
    const running = value.store.getJob(value.job.id);
    if (!running) throw new Error("cancelled navigator job disappeared");
    value.store.applyJobEvent(running.id, running.version, { type: "CANCEL_REQUESTED" }, 1_110);
    finish();
    await expect(processing).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({
      status: "dead",
      lastError: "job cancellation reached the protocol",
    });
    expect(value.store.getNavigatorWorkflowStepOutcome(accepted.workflowStepId!)).toBeNull();
  });

  it("aborts an adapter when the owning executor fence is cancelled", async () => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const fenceAbort = new AbortController();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const execute = vi.fn(async (context) => {
      started();
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { outcome: "lease_cancelled" as const, reason: "executor fence was cancelled" };
    });
    const protocol = protocolFor(value, execute);
    const lease = executorLeaseWithProjectClaim(value, "navigator-fence-cancel");
    const processing = protocol.processOne({
      ownerId: "navigator-fence-cancel",
      generation: lease.generation,
      signal: fenceAbort.signal,
    }, new AbortController().signal);
    await startedPromise;
    fenceAbort.abort(new Error("executor fence was cancelled"));
    await expect(processing).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({ status: "failed" });
  });

  it("reconciles an ambiguous navigator outcome under the same SQLite lease", async () => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const execute = vi.fn(async (context) => {
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.effect)).toBe(true);
      expect(Object.isFrozen(context.effect.payload)).toBe(true);
      return { outcome: "ambiguous" as const, reason: "provider receipt was lost" };
    });
    const reconcile = vi.fn(async (context: NavigatorEffectContext) => skillCompletion(context));
    const protocol = protocolFor(value, execute, 30_000, reconcile);
    const lease = executorLeaseWithProjectClaim(value, "navigator-ambiguous");
    await expect(protocol.processOne({
      ownerId: "navigator-ambiguous",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal)).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({ status: "done" });
  });

  it("releases a failed navigator effect after restart and retries it exactly once", async () => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const firstExecute = vi.fn(async () => ({ outcome: "transient" as const, reason: "worker restarted" }));
    const firstProtocol = protocolFor(value, firstExecute);
    const firstLease = executorLeaseWithProjectClaim(value, "navigator-before-restart");
    await firstProtocol.processOne({
      ownerId: "navigator-before-restart",
      generation: firstLease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal);
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({
      status: "failed",
      attempts: 1,
    });
    expect(value.store.releaseExecutorLease("navigator-before-restart", firstLease.generation, 1_101)).toBe(true);

    const secondLease = value.store.acquireExecutorLease("navigator-after-restart", 2_000, 30_000);
    if (!secondLease.acquired) throw new Error("post-restart executor lease was unavailable");
    value.db.prepare(
      `UPDATE job_resource_claims
          SET owner_id = ?, generation = ?, lease_expires_at = ?, renewed_at = ?
        WHERE job_id = ? AND resource_key = ? AND resource_kind = 'project' AND state = 'held'`,
    ).run(
      "navigator-after-restart",
      secondLease.generation,
      32_000,
      2_000,
      value.job.id,
      "project:proj_1:pipeline",
    );
    const secondExecute = vi.fn(async (context: NavigatorEffectContext) => skillCompletion(context));
    const secondProtocol = protocolFor(value, secondExecute, 30_000, undefined, () => 2_000);
    await secondProtocol.processOne({
      ownerId: "navigator-after-restart",
      generation: secondLease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal);

    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(secondExecute).toHaveBeenCalledTimes(1);
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({
      status: "done",
      attempts: 2,
    });
  });

  it("ignores a late protocol settlement after SQLite transfers the effect lease", async () => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const execute = vi.fn(async (context: NavigatorEffectContext) => {
      value.db.prepare(
        "UPDATE effects SET lease_owner = ?, lease_generation = ?, lease_expires_at = ? WHERE idempotency_key = ?",
      ).run("new-owner", 99, 9_999, accepted.effectIdempotencyKey);
      return skillCompletion(context);
    });
    const protocol = protocolFor(value, execute);
    const lease = executorLeaseWithProjectClaim(value, "navigator-stale");
    const before = value.store.getJob(value.job.id);
    await expect(protocol.processOne({
      ownerId: "navigator-stale",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal)).resolves.toBe(true);

    expect(value.store.getJob(value.job.id)).toEqual(before);
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({
      status: "leased",
      leaseOwner: "new-owner",
      leaseGeneration: 99,
    });
  });

  it("resumes the accepted attempt and bound BB resource after a worker crash", async () => {
    const value = fixture();
    let runCount = 0;
    const runner: NavigatorSkillRunner = {
      run: vi.fn(async (attempt, hooks) => {
        runCount += 1;
        const resource = attempt.resource ?? { kind: "bb_thread" as const, id: "thr_restart_safe" };
        await hooks.bindResource(resource);
        if (runCount === 1) throw new Error("worker process stopped after BB resource binding");
        expect(attempt.resource).toEqual(resource);
        return {
          resource,
          observedExternalStateDigest: "e".repeat(64),
          result: {
            kind: "research_result",
            summary: "Recovered the already accepted research step.",
            artifactEvidence: [{
              artifactId: value.artifactId,
              snapshotId: value.snapshotId,
              snapshotDigest: value.snapshotDigest,
              finding: "The same attempt and resource resumed.",
              evidenceRefs: ["bb:thr_restart_safe"],
            }],
          },
        };
      }),
    };
    let now = 1_100;
    const workflow = executor(value, { skillRunner: runner, now: () => now });
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const firstLease = value.store.acquireExecutorLease("executor-first", now, 100);
    if (!firstLease.acquired) throw new Error("first executor lease was unavailable");
    expect(await workflow.processOne({
      ownerId: "executor-first",
      generation: firstLease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal)).toBe(true);
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({ status: "failed" });
    expect(value.store.getNavigatorSkillAttempt(accepted.attemptId!)).toMatchObject({
      resource: { kind: "bb_thread", id: "thr_restart_safe" },
    });

    now = 2_000;
    const secondLease = value.store.acquireExecutorLease("executor-after-restart", now, 30_000);
    if (!secondLease.acquired) throw new Error("restart executor lease was unavailable");
    expect(await workflow.processOne({
      ownerId: "executor-after-restart",
      generation: secondLease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal)).toBe(true);
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({ status: "done" });
    expect(value.store.getNavigatorWorkflowStepOutcome(accepted.workflowStepId!)).toMatchObject({ outcome: "succeeded" });
  });

  it("rejects artifact drift at settlement as a policy failure", async () => {
    const value = fixture();
    const runner: NavigatorSkillRunner = {
      run: vi.fn(async (_attempt, hooks) => {
        const resource = { kind: "bb_thread" as const, id: "thr_drift" };
        await hooks.bindResource(resource);
        return {
          resource,
          observedExternalStateDigest: "d".repeat(64),
          result: {
            kind: "research_result",
            summary: "Stale result.",
            artifactEvidence: [{
              artifactId: value.artifactId,
              snapshotId: value.snapshotId,
              snapshotDigest: value.snapshotDigest,
              finding: "This must not be admitted after drift.",
              evidenceRefs: ["source:stale"],
            }],
          },
        };
      }),
    };
    const workflow = executor(value, { skillRunner: runner });
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const lease = value.store.acquireExecutorLease("executor-drift", 1_100, 30_000);
    if (!lease.acquired) throw new Error("drift executor lease was unavailable");
    await workflow.processOne({
      ownerId: "executor-drift",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal);

    expect(value.store.getNavigatorWorkflowStepOutcome(accepted.workflowStepId!)).toMatchObject({
      outcome: "policy_failure",
      reasonCode: "external_drift",
    });
    expect(value.store.getEffect(value.job.id, accepted.effectIdempotencyKey!)).toMatchObject({ status: "done" });
  });

  it("rejects structured evidence for an artifact outside the accepted bindings", async () => {
    const value = fixture();
    const runner: NavigatorSkillRunner = {
      run: vi.fn(async (_attempt, hooks) => {
        const resource = { kind: "bb_thread" as const, id: "thr_unbound_evidence" };
        await hooks.bindResource(resource);
        return {
          resource,
          observedExternalStateDigest: "e".repeat(64),
          result: {
            kind: "research_result",
            summary: "Result contains evidence outside the accepted artifact set.",
            artifactEvidence: [{
              artifactId: value.artifactId,
              snapshotId: value.snapshotId,
              snapshotDigest: value.snapshotDigest,
              finding: "The accepted ticket remains bound.",
              evidenceRefs: ["source:ticket-38"],
            }, {
              artifactId: "artifact_not_bound",
              snapshotId: "snapshot_not_bound",
              snapshotDigest: "b".repeat(64),
              finding: "This evidence was never authorized by the accepted proposal.",
              evidenceRefs: ["source:outside-scope"],
            }],
          },
        };
      }),
    };
    const workflow = executor(value, { skillRunner: runner });
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const lease = value.store.acquireExecutorLease("executor-unbound-evidence", 1_100, 30_000);
    if (!lease.acquired) throw new Error("unbound evidence executor lease was unavailable");
    await workflow.processOne({
      ownerId: "executor-unbound-evidence",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal);

    expect(value.store.getNavigatorWorkflowStepOutcome(accepted.workflowStepId!)).toMatchObject({
      outcome: "policy_failure",
      reasonCode: "unauthorized_artifact_evidence",
      artifactEvidence: [],
    });
    expect(value.store.getNavigatorPlanningResult(accepted.attemptId!)).toBeNull();
  });

  it("enforces the skill contract result bound as a policy failure", async () => {
    const value = fixture();
    const runner: NavigatorSkillRunner = {
      run: vi.fn(async (_attempt, hooks) => {
        const resource = { kind: "bb_thread" as const, id: "thr_oversized_result" };
        await hooks.bindResource(resource);
        return {
          resource,
          observedExternalStateDigest: "e".repeat(64),
          result: {
            kind: "research_result",
            summary: "The individual fields are valid but the aggregate result exceeds its contract.",
            artifactEvidence: [{
              artifactId: value.artifactId,
              snapshotId: value.snapshotId,
              snapshotDigest: value.snapshotDigest,
              finding: "The result bound must apply to the complete structured payload.",
              evidenceRefs: Array.from({ length: 128 }, () => "x".repeat(1_024)),
            }],
          },
        };
      }),
    };
    const workflow = executor(value, { skillRunner: runner });
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const lease = value.store.acquireExecutorLease("executor-result-bound", 1_100, 30_000);
    if (!lease.acquired) throw new Error("result bound executor lease was unavailable");
    await workflow.processOne({
      ownerId: "executor-result-bound",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal);

    expect(value.store.getNavigatorWorkflowStepOutcome(accepted.workflowStepId!)).toMatchObject({
      outcome: "policy_failure",
      reasonCode: "result_too_large",
      artifactEvidence: [],
    });
  });

  it("keeps navigator history append-only", async () => {
    const value = fixture();
    const workflow = executor(value);
    const accepted = await workflow.proposeNext({
      jobId: value.job.id,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    const lease = value.store.acquireExecutorLease("executor-append-only", 1_100, 30_000);
    if (!lease.acquired) throw new Error("append-only executor lease was unavailable");
    await workflow.processOne({
      ownerId: "executor-append-only",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal);
    value.db.prepare(
      `INSERT INTO workflow_step_supersessions (
         workflow_step_id, superseded_by_step_id, reason, recorded_at
       ) VALUES (?, NULL, 'test supersession fact', ?)`,
    ).run(accepted.workflowStepId, 1_200);

    expect(() => value.db.prepare("UPDATE navigator_snapshots SET digest = ? WHERE id = ?")
      .run("f".repeat(64), accepted.snapshotId)).toThrow(/append-only/iu);
    expect(() => value.db.prepare("DELETE FROM navigator_proposals WHERE id = ?")
      .run(accepted.proposalId)).toThrow(/append-only/iu);
    expect(() => value.db.prepare("UPDATE navigator_decisions SET reason_code = 'changed' WHERE proposal_id = ?")
      .run(accepted.proposalId)).toThrow(/append-only/iu);
    expect(() => value.db.prepare("DELETE FROM workflow_steps WHERE id = ?")
      .run(accepted.workflowStepId)).toThrow(/append-only/iu);
    expect(() => value.db.prepare("UPDATE workflow_step_outcomes SET reason_code = 'changed' WHERE workflow_step_id = ?")
      .run(accepted.workflowStepId)).toThrow(/append-only/iu);
    expect(() => value.db.prepare("DELETE FROM workflow_step_supersessions WHERE workflow_step_id = ?")
      .run(accepted.workflowStepId)).toThrow(/append-only/iu);
    expect(() => value.db.prepare("UPDATE navigator_skill_attempts SET resource_id = 'thr_changed' WHERE id = ?")
      .run(accepted.attemptId)).toThrow(/immutable/iu);
  });
});
