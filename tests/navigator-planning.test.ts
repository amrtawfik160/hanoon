import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { DEFAULT_MODEL_POOL_REGISTRY } from "../src/capabilities/models";
import {
  NavigatorWorkflowExecutor,
  type NavigatorSkillRunner,
} from "../src/navigator/executor";
import type { NavigatorProposal, NavigatorSkillAttempt, NavigatorSnapshot } from "../src/navigator/models";
import { NavigatorPlanningPublisher } from "../src/navigator/planning-publisher";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { WorkArtifactCoordinator } from "../src/work-artifacts/coordinator";
import {
  GitHubWorkTracker,
  type GitHubIssueGateway,
  type GitHubIssueRecord,
} from "../src/work-artifacts/github-tracker";
import { LocalMarkdownWorkTracker } from "../src/work-artifacts/local-markdown-tracker";
import type { WorkArtifact, WorkArtifactKind } from "../src/work-artifacts/models";
import { TrackerConflictError, type WorkTracker } from "../src/work-artifacts/tracker";
import { policyFixture } from "./helpers";

const temporaryDirectories: string[] = [];
let fixtureNumber = 0;

class PlanningGitHubGateway implements GitHubIssueGateway {
  public readonly namespace = "github:acme/navigator-planning";
  private nextNumber = 1;
  private revision = 1;
  private readonly issues = new Map<string, GitHubIssueRecord>();
  private createPause: Readonly<{ started(): void; wait: Promise<void> }> | null = null;

  public async createIssue(input: Readonly<{ title: string; body: string }>): Promise<GitHubIssueRecord> {
    if (this.createPause) {
      const pause = this.createPause;
      this.createPause = null;
      pause.started();
      await pause.wait;
    }
    const externalId = String(this.nextNumber++);
    const issue: GitHubIssueRecord = {
      externalId,
      url: `https://github.com/acme/navigator-planning/issues/${externalId}`,
      title: input.title,
      body: input.body,
      state: "open",
      stateReason: null,
      assignees: [],
      comments: [],
      parentExternalId: null,
      blockerExternalIds: [],
      childExternalIds: [],
      revision: String(this.revision++),
    };
    this.issues.set(externalId, issue);
    return structuredClone(issue);
  }

  public async readIssue(externalId: string): Promise<GitHubIssueRecord> {
    const issue = this.issues.get(externalId);
    if (!issue) throw new Error(`Issue ${externalId} does not exist`);
    return structuredClone(issue);
  }

  public async findIssuesByOperationMarker(marker: string): Promise<readonly GitHubIssueRecord[]> {
    return [...this.issues.values()]
      .filter((issue) => issue.body.includes(marker) || issue.comments.some((comment) => comment.includes(marker)))
      .map((issue) => structuredClone(issue));
  }

  public async addComment(
    externalId: string,
    expectedRevision: string,
    body: string,
  ): Promise<GitHubIssueRecord> {
    const current = await this.readIssue(externalId);
    return this.update(externalId, expectedRevision, { comments: [...current.comments, body] });
  }

  public addSubIssue(
    parentExternalId: string,
    childExternalId: string,
    expectedChildRevision: string,
  ): Promise<GitHubIssueRecord> {
    return this.update(childExternalId, expectedChildRevision, { parentExternalId });
  }

  public async addBlockedBy(
    externalId: string,
    expectedRevision: string,
    blockerExternalId: string,
  ): Promise<GitHubIssueRecord> {
    const current = await this.readIssue(externalId);
    return this.update(externalId, expectedRevision, {
      blockerExternalIds: [...new Set([...current.blockerExternalIds, blockerExternalId])],
    });
  }

  public async removeBlockedBy(
    externalId: string,
    expectedRevision: string,
    blockerExternalId: string,
  ): Promise<GitHubIssueRecord> {
    const current = await this.readIssue(externalId);
    return this.update(externalId, expectedRevision, {
      blockerExternalIds: current.blockerExternalIds.filter((id) => id !== blockerExternalId),
    });
  }

  public async addAssignee(
    externalId: string,
    expectedRevision: string,
    assignee: string,
  ): Promise<GitHubIssueRecord> {
    const current = await this.readIssue(externalId);
    return this.update(externalId, expectedRevision, {
      assignees: [...new Set([...current.assignees, assignee])],
    });
  }

  public async removeAssignee(
    externalId: string,
    expectedRevision: string,
    assignee: string,
  ): Promise<GitHubIssueRecord> {
    const current = await this.readIssue(externalId);
    return this.update(externalId, expectedRevision, {
      assignees: current.assignees.filter((login) => login !== assignee),
    });
  }

  public closeIssue(
    externalId: string,
    expectedRevision: string,
    reason: "completed" | "not_planned",
  ): Promise<GitHubIssueRecord> {
    return this.update(externalId, expectedRevision, {
      state: reason === "completed" ? "closed" : "cancelled",
      stateReason: reason,
    });
  }

  public count(): number {
    return this.issues.size;
  }

  public pauseNextCreate(): Readonly<{ started: Promise<void>; release(): void }> {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.createPause = { started: markStarted, wait };
    return { started, release };
  }

  private async update(
    externalId: string,
    expectedRevision: string,
    patch: Readonly<Partial<GitHubIssueRecord>>,
  ): Promise<GitHubIssueRecord> {
    const current = await this.readIssue(externalId);
    if (current.revision !== expectedRevision) throw new TrackerConflictError(externalId);
    const next = { ...current, ...patch, revision: String(this.revision++) };
    this.issues.set(externalId, next);
    if (patch.parentExternalId !== undefined) {
      for (const [id, issue] of this.issues) {
        const childExternalIds = issue.childExternalIds.filter((child) => child !== externalId);
        if (id === patch.parentExternalId) childExternalIds.push(externalId);
        this.issues.set(id, { ...issue, childExternalIds });
      }
    }
    return structuredClone(next);
  }
}

type PlanningFixture = Readonly<{
  store: TelegramAgentStore;
  tracker: WorkTracker;
  coordinator: WorkArtifactCoordinator;
  publisher: NavigatorPlanningPublisher;
  jobId: string;
  rootArtifactId: string;
  fence: Readonly<{ ownerId: string; generation: number }>;
  gateway: PlanningGitHubGateway | null;
  now(): number;
  advance(): number;
}>;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function planningFixture(kind: "github" | "local_markdown"): Promise<PlanningFixture> {
  const fixtureId = fixtureNumber++;
  const { bb } = createFakePluginHost({ pluginId: `navigator-planning-${kind}-${fixtureId}` });
  let clock = 10_000;
  const store = openStore(bb.storage, bb.storage.kv, () => clock);
  const gateway = kind === "github" ? new PlanningGitHubGateway() : null;
  const repositoryRoot = await mkdtemp(join(tmpdir(), "navigator-planning-"));
  temporaryDirectories.push(repositoryRoot);
  const tracker: WorkTracker = gateway
    ? new GitHubWorkTracker(gateway)
    : new LocalMarkdownWorkTracker({ repositoryRoot, effortSlug: `effort-${fixtureId}` });
  const coordinator = new WorkArtifactCoordinator(store, tracker, () => clock);
  const lease = store.acquireExecutorLease(`executor-${kind}-${fixtureId}`, clock, 1_000_000);
  if (!lease.acquired) throw new Error("planning executor lease was unavailable");
  const fence = { ownerId: `executor-${kind}-${fixtureId}`, generation: lease.generation };
  const draft = store.createJob({
    id: `job_planning_${kind}_${fixtureId}`,
    sourceUpdateId: 390_000 + fixtureId,
    requestText: "Turn this foggy multi-context task into a specification and ticket frontier.",
    workflow: { engine: "navigator-v1", mode: "deterministic" },
    now: clock,
  });
  const selected = store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_39",
    policyVersion: 1,
    policy: policyFixture({ projectId: "proj_39" }),
  }, ++clock);
  const root = await coordinator.create({
    projectId: "proj_39",
    effortId: draft.id,
    operationId: "ticket-39-owner-request",
    kind: "implementation_ticket",
    status: "ready",
    title: "Navigate ticket 39",
    body: "## Goal\n\nCreate one canonical plan from the owner request.",
    acceptanceCriteria: ["A canonical specification exists"],
    relationships: [],
    trackerOrder: 0,
    ...fence,
    now: ++clock,
  });
  store.bindNavigatorJobArtifacts({
    jobId: selected.id,
    expectedVersion: selected.version,
    artifactBindings: [{
      artifactId: root.artifact.id,
      snapshotId: root.snapshot.id,
      snapshotDigest: root.snapshot.snapshotDigest,
    }],
    now: ++clock,
  });
  bb.storage.database().prepare("UPDATE jobs SET state = 'implementing' WHERE id = ?").run(draft.id);
  return {
    store,
    tracker,
    coordinator,
    publisher: new NavigatorPlanningPublisher(store, coordinator),
    jobId: draft.id,
    rootArtifactId: root.artifact.id,
    fence,
    gateway,
    now: () => clock,
    advance: () => ++clock,
  };
}

async function runPlanningStep(
  fixture: PlanningFixture,
  input: Readonly<{
    skillId: string;
    subjectArtifactIds: readonly string[];
    result(attempt: NavigatorSkillAttempt): unknown;
  }>,
): Promise<Readonly<{ attempt: NavigatorSkillAttempt; rawResult: unknown }>> {
  let rawResult: unknown;
  const runner: NavigatorSkillRunner = {
    run: vi.fn(async (attempt, hooks) => {
      const resource = { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
      await hooks.bindResource(resource);
      rawResult = input.result(attempt);
      return {
        resource,
        observedExternalStateDigest: "e".repeat(64),
        result: rawResult,
      };
    }),
  };
  const navigator = {
    propose: async (snapshot: NavigatorSnapshot): Promise<NavigatorProposal> => ({
      kind: "invoke_skill",
      basedOn: snapshot.identity,
      rationale: `Ticket 39 requires ${input.skillId}.`,
      evidenceRefs: ["ticket:39"],
      skillId: input.skillId,
      subjectArtifactIds: [...input.subjectArtifactIds],
      objective: `Run ${input.skillId} for ticket 39.`,
    }),
  };
  const executor = new NavigatorWorkflowExecutor({
    store: fixture.store,
    navigator,
    observeInference: async () => ({
      nativeToolCalls: [],
      claimedCodeWorktreeId: null,
      dynamicEffectToolIds: [],
      externalStateDigest: "e".repeat(64),
    }),
    skillRunner: runner,
    planningPublisher: fixture.publisher,
    modelRoute: () => ({ pool: "strong", ...DEFAULT_MODEL_POOL_REGISTRY.worker.strong }),
    clock: { now: fixture.advance },
  });
  const decision = await executor.proposeNext({
    jobId: fixture.jobId,
    externalStateDigest: "e".repeat(64),
    evidenceRefs: ["ticket:39"],
  });
  if (decision.decision !== "accepted") {
    const boundIds = fixture.store.getJob(fixture.jobId)?.artifactBindings.map((binding) => binding.artifactId);
    throw new Error(
      `planning proposal was ${decision.decision}: ${decision.reasonCode}; subjects=${input.subjectArtifactIds.join(",")}; bound=${boundIds?.join(",")}`,
    );
  }
  await expect(executor.processOne({
    ...fixture.fence,
    signal: new AbortController().signal,
  }, new AbortController().signal)).resolves.toBe(true);
  const attempt = fixture.store.getNavigatorSkillAttempt(decision.attemptId!);
  if (!attempt || rawResult === undefined) throw new Error("planning attempt did not run");
  const outcome = fixture.store.getNavigatorWorkflowStepOutcome(attempt.workflowStepId);
  if (!outcome) {
    const effect = fixture.store.getEffect(fixture.jobId, attempt.effectIdempotencyKey);
    throw new Error(`planning outcome was not recorded: ${effect?.lastError ?? "no effect error"}`);
  }
  expect(outcome).toMatchObject({ outcome: "succeeded" });
  return { attempt, rawResult };
}

function artifactsOfKind(
  store: TelegramAgentStore,
  jobId: string,
  kind: WorkArtifactKind,
): readonly WorkArtifact[] {
  const job = store.getJob(jobId);
  if (!job) throw new Error("planning job disappeared");
  return job.artifactBindings
    .map((binding) => store.getWorkArtifact(binding.artifactId))
    .filter((artifact): artifact is WorkArtifact => artifact?.kind === kind);
}

describe.each(["github", "local_markdown"] as const)("navigator planning through %s", (trackerKind) => {
  it("publishes a restart-safe map, resolved decisions, canonical spec, and blocker-linked frontier", async () => {
    const fixture = await planningFixture(trackerKind);
    const wayfinderResult = {
      kind: "wayfinder_result",
      summary: "The fog is split into two ordered decisions.",
      map: {
        title: "Ticket 39 decision map",
        body: "## Destination\n\nOne canonical specification.\n\n## Decisions so far\n\n## Not yet specified\n\nRouting and persistence.",
        acceptanceCriteria: ["Every decision ticket is resolved"],
      },
      decisionTickets: [{
        title: "Choose the routing signals",
        body: "## Question\n\nWhich pinned signals select each planning flow?",
        acceptanceCriteria: ["The signal is tied to pinned guidance"],
        blockedBy: [],
      }, {
        title: "Choose the persistence boundary",
        body: "## Question\n\nHow are downstream revisions invalidated?",
        acceptanceCriteria: ["The answer survives restart"],
        blockedBy: [0],
      }],
      evidenceRefs: ["skill:wayfinder"],
    } as const;
    const wayfinder = await runPlanningStep(fixture, {
      skillId: "wayfinder",
      subjectArtifactIds: [fixture.rootArtifactId],
      result: () => wayfinderResult,
    });
    const map = artifactsOfKind(fixture.store, fixture.jobId, "map")[0]!;
    const decisions = artifactsOfKind(fixture.store, fixture.jobId, "decision_ticket");
    expect(decisions).toHaveLength(2);
    expect(fixture.store.listWorkArtifactFrontier(map.id, 10).map((artifact) => artifact.title))
      .toEqual(["Choose the routing signals"]);
    for (const decision of decisions) {
      const snapshot = fixture.store.getCurrentWorkArtifactSnapshot(decision.id)!;
      await runPlanningStep(fixture, {
        skillId: "research",
        subjectArtifactIds: [decision.id],
        result: () => ({
          kind: "research_result",
          summary: `Resolved ${decision.title} from primary sources.`,
          artifactEvidence: [{
            artifactId: decision.id,
            snapshotId: snapshot.id,
            snapshotDigest: snapshot.snapshotDigest,
            finding: `Durable answer for ${decision.title}.`,
            evidenceRefs: ["source:pinned-skill"],
          }],
        }),
      });
    }
    expect(fixture.store.listWorkArtifactFrontier(map.id, 10)).toEqual([]);
    expect(decisions.map((decision) => fixture.store.getWorkArtifact(decision.id)?.status))
      .toEqual(["resolved", "resolved"]);
    for (const decision of decisions) {
      const trackedDecision = await fixture.tracker.read(decision.externalId);
      expect(trackedDecision.comments.join("\n"))
        .toContain(`Durable answer for ${decision.title}.`);
    }
    const indexedMap = await fixture.tracker.read(map.externalId);
    for (const decision of decisions) {
      const link = decision.externalUrl ?? decision.externalId;
      expect(indexedMap.body)
        .toContain(`- [${decision.title}](${link}): Durable answer for ${decision.title}.`);
    }

    await runPlanningStep(fixture, {
      skillId: "to-spec",
      subjectArtifactIds: [map.id, ...decisions.map((decision) => decision.id)],
      result: () => ({
        kind: "to_spec_result",
        summary: "The resolved map is synthesized into one specification.",
        specification: {
          title: "Ticket 39 canonical specification",
          body: "## Problem Statement\n\nPlanning must survive restart.\n\n## Solution\n\nUse executor-owned contracts and tracker artifacts.",
          acceptanceCriteria: ["GitHub and local trackers keep the same frontier"],
        },
        evidenceRefs: ["map:resolved"],
      }),
    });
    const specifications = artifactsOfKind(fixture.store, fixture.jobId, "specification");
    expect(specifications).toHaveLength(1);
    const specification = specifications[0]!;

    await runPlanningStep(fixture, {
      skillId: "to-tickets",
      subjectArtifactIds: [specification.id],
      result: () => ({
        kind: "to_tickets_result",
        summary: "The specification is split into two tracer bullets.",
        tickets: [{
          title: "Publish the planning artifacts",
          body: "## What to build\n\nPublish one complete planning path.",
          acceptanceCriteria: ["The path works through the configured tracker"],
          blockedBy: [],
        }, {
          title: "Verify restart and parity",
          body: "## What to build\n\nVerify replay and both tracker adapters.",
          acceptanceCriteria: ["Replay creates no duplicate artifacts"],
          blockedBy: [0],
        }],
        evidenceRefs: ["specification:canonical"],
      }),
    });
    const implementationTickets = artifactsOfKind(fixture.store, fixture.jobId, "implementation_ticket")
      .filter((artifact) => artifact.id !== fixture.rootArtifactId);
    expect(implementationTickets).toHaveLength(2);
    const firstTicket = implementationTickets.find((ticket) => ticket.title === "Publish the planning artifacts")!;
    const secondTicket = implementationTickets.find((ticket) => ticket.title === "Verify restart and parity")!;
    await expect(fixture.tracker.read(secondTicket.externalId)).resolves.toMatchObject({
      acceptanceCriteria: ["Replay creates no duplicate artifacts"],
      parentExternalId: specification.externalId,
      blockerExternalIds: [firstTicket.externalId],
    });
    expect(fixture.store.listWorkArtifactFrontier(specification.id, 10).map((artifact) => artifact.title))
      .toEqual(["Publish the planning artifacts"]);
    const claim = await fixture.coordinator.claim({
      artifactId: firstTicket.id,
      workflowStepId: "workflow-claim-ticket-39",
      jobId: fixture.jobId,
      assignee: "hanoon-bot",
      operationId: "claim-ticket-39-frontier",
      leaseMs: 10_000,
      ...fixture.fence,
      now: fixture.advance(),
    });
    expect(claim?.claim.state).toBe("held");
    expect(fixture.store.listWorkArtifactFrontier(specification.id, 10)).toEqual([]);
    const artifactCount = fixture.store.getJob(fixture.jobId)!.artifactBindings.length;
    await fixture.publisher.publish(wayfinder.attempt, wayfinder.rawResult, {
      ...fixture.fence,
      now: fixture.advance(),
    });
    expect(fixture.store.getJob(fixture.jobId)!.artifactBindings).toHaveLength(artifactCount);
    if (fixture.gateway) expect(fixture.gateway.count()).toBe(7);

    const mapBeforeEdit = fixture.store.getCurrentWorkArtifactSnapshot(map.id)!;
    const externalMap = await fixture.tracker.read(map.externalId);
    await fixture.tracker.updateOwnedSection({
      externalId: map.externalId,
      sectionId: "revision-note",
      content: "The owner changed the canonical route after tickets were derived.",
      operationId: `revise-ticket-39-map-${trackerKind}`,
      expectedRevision: externalMap.revision,
    });
    await fixture.coordinator.observe({
      artifactId: map.id,
      ...fixture.fence,
      now: fixture.advance(),
    });
    const revisionBeforeReconsideration = fixture.store.getJob(fixture.jobId)!.workflowRevision;
    const reconsidered = fixture.store.createNavigatorSnapshot({
      jobId: fixture.jobId,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: ["tracker-edit:ticket-39-map"],
      now: fixture.advance(),
    });
    expect(fixture.store.getWorkArtifactSnapshotInvalidation(mapBeforeEdit.id)).toMatchObject({
      reason: "remote_edit",
    });
    expect(reconsidered.artifactBindings.map((binding) => binding.artifactId))
      .toEqual([fixture.rootArtifactId, map.id, ...decisions.map((decision) => decision.id), specification.id]);
    expect(fixture.store.getJob(fixture.jobId)!.workflowRevision)
      .toBe(revisionBeforeReconsideration + 1);

    await runPlanningStep(fixture, {
      skillId: "to-spec",
      subjectArtifactIds: [map.id, specification.id],
      result: () => ({
        kind: "to_spec_result",
        summary: "The canonical specification is revised after map drift.",
        specification: {
          title: "Ticket 39 canonical specification",
          body: "## Problem Statement\n\nThe owner revised the map.\n\n## Solution\n\nReconcile the existing specification identity.",
          acceptanceCriteria: ["The original specification artifact is revised"],
        },
        evidenceRefs: ["tracker-edit:ticket-39-map"],
      }),
    });
    const reconsideredSpecifications = artifactsOfKind(fixture.store, fixture.jobId, "specification");
    expect(reconsideredSpecifications).toHaveLength(1);
    expect(reconsideredSpecifications[0]!.id).toBe(specification.id);
    await expect(fixture.tracker.read(specification.externalId)).resolves.toMatchObject({
      body: expect.stringContaining("Reconcile the existing specification identity."),
    });
  });

  it("SPEC-39-004: resolves prototype decisions from the matched verdict", async () => {
    const fixture = await planningFixture(trackerKind);
    await runPlanningStep(fixture, {
      skillId: "wayfinder",
      subjectArtifactIds: [fixture.rootArtifactId],
      result: () => ({
        kind: "wayfinder_result",
        summary: "One prototype decision is required.",
        map: {
          title: "Prototype decision map",
          body: "## Destination\n\nChoose behavior.\n\n## Decisions so far\n\n## Not yet specified\n\nPrototype behavior.",
          acceptanceCriteria: ["The prototype decision is resolved"],
        },
        decisionTickets: [{
          title: "Choose prototype behavior",
          body: "## Question\n\nWhich behavior should the implementation keep?",
          acceptanceCriteria: ["The verdict is durable"],
          blockedBy: [],
        }],
        evidenceRefs: ["skill:wayfinder"],
      }),
    });
    const map = artifactsOfKind(fixture.store, fixture.jobId, "map")[0]!;
    const decision = artifactsOfKind(fixture.store, fixture.jobId, "decision_ticket")[0]!;
    const decisionSnapshot = fixture.store.getCurrentWorkArtifactSnapshot(decision.id)!;
    const navigator = {
      propose: async (snapshot: NavigatorSnapshot): Promise<NavigatorProposal> => ({
        kind: "invoke_skill",
        basedOn: snapshot.identity,
        rationale: "Persist authoritative evidence before prototype publication.",
        evidenceRefs: ["ticket:39:SPEC-39-004"],
        skillId: "research",
        subjectArtifactIds: [decision.id],
        objective: "Bind the decision snapshot.",
      }),
    };
    const executor = new NavigatorWorkflowExecutor({
      store: fixture.store,
      navigator,
      observeInference: async () => ({
        nativeToolCalls: [],
        claimedCodeWorktreeId: null,
        dynamicEffectToolIds: [],
        externalStateDigest: "e".repeat(64),
      }),
      skillRunner: {
        run: vi.fn(async (attempt, hooks) => {
          const resource = { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
          await hooks.bindResource(resource);
          return {
            resource,
            observedExternalStateDigest: "e".repeat(64),
            result: {
              kind: "research_result",
              summary: "The accepted snapshot is bound for publication.",
              artifactEvidence: [{
                artifactId: decision.id,
                snapshotId: decisionSnapshot.id,
                snapshotDigest: decisionSnapshot.snapshotDigest,
                finding: "Research placeholder superseded by the prototype verdict.",
                evidenceRefs: ["source:prototype-session"],
              }],
            },
          };
        }),
      },
      modelRoute: () => ({ pool: "strong", ...DEFAULT_MODEL_POOL_REGISTRY.worker.strong }),
      clock: { now: fixture.advance },
    });
    const accepted = await executor.proposeNext({
      jobId: fixture.jobId,
      externalStateDigest: "e".repeat(64),
      evidenceRefs: [],
    });
    await executor.processOne({
      ...fixture.fence,
      signal: new AbortController().signal,
    }, new AbortController().signal);
    const attempt = fixture.store.getNavigatorSkillAttempt(accepted.attemptId!);
    if (!attempt) throw new Error("prototype publication attempt disappeared");
    await fixture.publisher.publish({
      ...attempt,
      skillId: "prototype",
      workflowStepId: `${attempt.workflowStepId}:prototype-publication`,
    }, {
      kind: "prototype_result",
      summary: "The prototype produced a concrete answer.",
      verdict: "Keep the immediate feedback behavior.",
      assetRef: "prototype:feedback-behavior",
      artifactEvidence: [{
        artifactId: decision.id,
        snapshotId: decisionSnapshot.id,
        snapshotDigest: decisionSnapshot.snapshotDigest,
        finding: "The prototype supports immediate feedback.",
        evidenceRefs: ["prototype:feedback-behavior"],
      }],
    }, { ...fixture.fence, now: fixture.advance() });

    await expect(fixture.tracker.read(decision.externalId)).resolves.toMatchObject({
      comments: expect.arrayContaining([expect.stringContaining("Keep the immediate feedback behavior.")]),
    });
    const link = decision.externalUrl ?? decision.externalId;
    await expect(fixture.tracker.read(map.externalId)).resolves.toMatchObject({
      body: expect.stringContaining(
        `- [${decision.title}](${link}): Keep the immediate feedback behavior.`,
      ),
    });
  });
});

it("STD-39-002: rejects drift that lands during asynchronous planning publication", async () => {
  const fixture = await planningFixture("github");
  const gateway = fixture.gateway!;
  const pause = gateway.pauseNextCreate();
  const navigator = {
    propose: async (snapshot: NavigatorSnapshot): Promise<NavigatorProposal> => ({
      kind: "invoke_skill",
      basedOn: snapshot.identity,
      rationale: "Publish a map from the exact owner ticket snapshot.",
      evidenceRefs: ["ticket:39:STD-39-002"],
      skillId: "wayfinder",
      subjectArtifactIds: [fixture.rootArtifactId],
      objective: "Publish the planning map.",
    }),
  };
  const executor = new NavigatorWorkflowExecutor({
    store: fixture.store,
    navigator,
    observeInference: async () => ({
      nativeToolCalls: [],
      claimedCodeWorktreeId: null,
      dynamicEffectToolIds: [],
      externalStateDigest: "e".repeat(64),
    }),
    skillRunner: {
      run: vi.fn(async (attempt, hooks) => {
        const resource = { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
        await hooks.bindResource(resource);
        return {
          resource,
          observedExternalStateDigest: "e".repeat(64),
          result: {
            kind: "wayfinder_result",
            summary: "The old owner ticket snapshot produced a map.",
            map: {
              title: "Drifted map",
              body: "## Destination\n\nReject stale publication.\n\n## Decisions so far\n\n## Not yet specified\n\nOne decision.",
              acceptanceCriteria: ["Drift fails closed"],
            },
            decisionTickets: [{
              title: "Resolve drift",
              body: "## Question\n\nWhich snapshot is authoritative?",
              acceptanceCriteria: ["Use the current snapshot"],
              blockedBy: [],
            }],
            evidenceRefs: ["ticket:39:STD-39-002"],
          },
        };
      }),
    },
    planningPublisher: fixture.publisher,
    modelRoute: () => ({ pool: "strong", ...DEFAULT_MODEL_POOL_REGISTRY.worker.strong }),
    clock: { now: fixture.advance },
  });
  const accepted = await executor.proposeNext({
    jobId: fixture.jobId,
    externalStateDigest: "e".repeat(64),
    evidenceRefs: [],
  });
  const processing = executor.processOne({
    ...fixture.fence,
    signal: new AbortController().signal,
  }, new AbortController().signal);
  await pause.started;
  const root = fixture.store.getWorkArtifact(fixture.rootArtifactId)!;
  const externalRoot = await fixture.tracker.read(root.externalId);
  await fixture.tracker.updateOwnedSection({
    externalId: root.externalId,
    sectionId: "revision-note",
    content: "The owner changed the ticket while publication was awaiting the tracker.",
    operationId: "ticket-39-drift-during-publication",
    expectedRevision: externalRoot.revision,
  });
  await fixture.coordinator.observe({
    artifactId: root.id,
    ...fixture.fence,
    now: fixture.advance(),
  });
  pause.release();
  await processing;

  expect(fixture.store.getNavigatorWorkflowStepOutcome(accepted.workflowStepId!)).toMatchObject({
    outcome: "policy_failure",
    reasonCode: "stale_artifact_snapshot",
  });
  expect(fixture.store.getEffect(fixture.jobId, accepted.effectIdempotencyKey!)).toMatchObject({
    status: "done",
  });
  expect(fixture.store.getJob(fixture.jobId)).toMatchObject({ currentWorkflowStepId: null });
});
