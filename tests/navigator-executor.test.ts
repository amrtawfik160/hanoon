import { createFakePluginHost } from "@bb/plugin-sdk/testing";
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
import { runJobExecutorService } from "../src/services/job-executor-service";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
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

describe("navigator-v1 durable executor slice", () => {
  it("locks the ticket 39 planning contracts and pinned routing signals", () => {
    expect(Object.keys(NAVIGATOR_PLANNING_STEP_CONTRACTS)).toEqual([
      "setup-matt-pocock-skills",
      "wayfinder",
      "to-spec",
      "to-tickets",
      "research",
      "prototype",
      "handoff",
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
    const abort = new AbortController();
    await runJobExecutorService({
      store: value.store,
      clock: { now: () => 1_100 },
      navigator: workflow,
      sleep: vi.fn(async () => abort.abort()),
      releaseOnShutdown: true,
    }, abort.signal);

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
