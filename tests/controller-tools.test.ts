import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { BUNDLED_SKILL_IDS, buildWorkerThreadTitle, type WorkerSkillRole } from "../src/agent-skills/role-resolver";
import { hashSecret } from "../src/crypto";
import { admitConfirmedJob, policyFixture, sha } from "./helpers";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { CONTROLLER_TOOL_NAMES, registerControllerTools } from "../src/controller/tools";

type ThreadListEntry = Awaited<ReturnType<ReturnType<typeof createFakePluginHost>["bb"]["sdk"]["threads"]["list"]>>[number];

function visibleThread(overrides: Partial<ThreadListEntry> = {}): ThreadListEntry {
  return {
    id: "thr_active",
    projectId: "proj_1",
    environmentId: "env_cyndra",
    providerId: "codex",
    title: "Fix Cyndra billing",
    titleFallback: null,
    sectionId: null,
    status: "active",
    parentThreadId: null,
    sourceThreadId: null,
    originKind: null,
    childOrigin: null,
    originPluginId: null,
    visibility: "visible",
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 9_500,
    createdAt: 1_000,
    updatedAt: 9_500,
    runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
    activity: {
      activeWorkflowCount: 1,
      activeBackgroundAgentCount: 2,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 1,
    },
    pinSortKey: null,
    hasPendingInteraction: false,
    environmentHostId: "host_cyndra",
    environmentName: "Cyndra worktree",
    environmentBranchName: "feature/billing",
    environmentWorkspaceDisplayKind: "managed-worktree",
    ...overrides,
  };
}

function backgroundCommand() {
  return {
    id: "cmd_1",
    threadId: "thr_active",
    turnId: null,
    sourceSeqStart: 1,
    sourceSeqEnd: 2,
    startedAt: 7_000,
    createdAt: 7_000,
    kind: "work" as const,
    status: "pending" as const,
    workKind: "workflow" as const,
    itemId: "item_1",
    taskType: "command",
    workflowName: null,
    description: "npm test",
    taskStatus: "running" as const,
    workflow: null,
  };
}

function parseToolJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("controller tool did not return JSON text");
  return JSON.parse(value);
}

function queueControllerCandidate(
  store: TelegramAgentStore,
  id: string,
  projectId: string,
  state: "awaiting_confirmation" | "failed" = "awaiting_confirmation",
): void {
  const candidatePolicy = policyFixture({
    projectId,
    alias: projectId.replace(/^proj_/, "candidate-").slice(0, 24),
    githubRepository: `acme/${projectId}`,
    production: undefined,
  });
  store.upsertProjectPolicy(candidatePolicy, 10_000);
  const job = store.createJob({
    id,
    sourceUpdateId: 900 + id.charCodeAt(id.length - 1),
    requestText: id,
    now: 10_001,
  });
  const selected = store.applyJobEvent(job.id, job.version, {
    type: "PROJECT_SELECTED",
    projectId,
    policyVersion: 1,
    policy: candidatePolicy,
  }, 10_002);
  if (state === "failed") {
    const admitted = admitConfirmedJob(store, selected, 10_003);
    store.applyJobEvent(admitted.id, admitted.version, { type: "FAILED", error: `${id} failed` }, 10_004);
  } else {
    store.queueAdmission({
      jobId: selected.id,
      expectedVersion: selected.version,
      projectId,
      resumeEvent: "CONFIRMED",
      now: 10_003,
    });
  }
}

const controllerToolContext = { threadId: "thr_controller", projectId: "proj_personal" };

let fixtureNumber = 0;
function fixture() {
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-controller-tools-${fixtureNumber++}`,
    agentSkillIds: [...BUNDLED_SKILL_IDS],
  });
  const store = openStore(bb.storage, bb.storage.kv, () => 10_000);
  store.createPairingCode(hashSecret("pair-tools"), 1_000, 20_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-tools"), "7", "7", 1_001)).toEqual({ ok: true });
  store.upsertProjectPolicy(policyFixture(), 1_002);
  store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 701,
    inputText: "Fix the redirect and add a regression test",
    now: 2_000,
  });
  const lease = store.acquireExecutorLease("executor", 10_000, 30_000);
  if (!lease.acquired) throw new Error("missing executor lease");
  const turn = store.claimNextControllerTurn({ ownerId: "executor", generation: lease.generation, now: 10_000 });
  if (!turn) throw new Error("missing controller turn");
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: "executor",
    generation: lease.generation,
    now: 10_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: "executor",
    generation: lease.generation,
    now: 10_000,
  })).toBe(true);
  expect(store.releaseExecutorLease("executor", lease.generation, 10_000)).toBe(true);
  return { bb, harness, store, turn };
}

function workerContext(
  pluginId: string,
  identity: { jobId: string; attemptId: string; role: WorkerSkillRole },
  overrides: Partial<PluginAgentConfigurationContext> = {},
): PluginAgentConfigurationContext {
  return {
    thread: {
      id: "thr_worker",
      title: buildWorkerThreadTitle(identity),
      parentThreadId: null,
      sourceThreadId: null,
    },
    project: { id: "proj_worker", kind: "standard", name: "Worker", gitRemoteUrl: "https://github.com/acme/worker.git" },
    environment: {
      id: "env_worker",
      name: "worker",
      path: "/workspace/worker",
      workspaceProvisionType: "managed-worktree",
      branchName: "agent/worker",
    },
    host: { id: "host_worker", name: "Worker host" },
    provider: { id: "codex", model: "gpt-5.6" },
    origin: { kind: null, pluginId },
    ...overrides,
  };
}

function workerJob(store: TelegramAgentStore, id: string) {
  const policy = policyFixture({ projectId: "proj_worker", alias: "worker" });
  store.upsertProjectPolicy(policy, 1_000);
  const job = store.createJob({ id, sourceUpdateId: 800 + id.length, requestText: "worker task", now: 1_001 });
  return store.applyJobEvent(job.id, job.version, {
    type: "PROJECT_SELECTED",
    projectId: policy.projectId,
    policyVersion: 1,
    policy,
  }, 1_002);
}

function effect(store: TelegramAgentStore, jobId: string, kind: string) {
  const found = store.listEffectsForJob(jobId).find((candidate) => candidate.kind === kind);
  if (!found) throw new Error(`${kind} effect was not created`);
  return found;
}

function advanceToImplementation(store: TelegramAgentStore, id: string) {
  let job = workerJob(store, id);
  job = admitConfirmedJob(store, job, 1_003);
  job = store.applyJobEvent(job.id, job.version, { type: "PLAN_READY", attemptId: "stage_plan" }, 1_004);
  job = store.applyJobEvent(job.id, job.version, { type: "CRITIQUE_PASSED", attemptId: "stage_critique" }, 1_005);
  return { job, effect: effect(store, job.id, "spawn_implementation") };
}

function advanceImplementationToReview(store: TelegramAgentStore, job: ReturnType<typeof advanceToImplementation>["job"]) {
  job = store.applyJobEvent(job.id, job.version, {
    type: "IMPLEMENTATION_CREATED", threadId: "thr_implementation", environmentId: "env_worker",
  }, 1_006);
  job = store.applyJobEvent(job.id, job.version, { type: "IMPLEMENTATION_IDLE" }, 1_007);
  job = store.applyJobEvent(job.id, job.version, { type: "PR_LOCATED", number: 12, url: "https://github.com/acme/worker/pull/12" }, 1_008);
  job = store.applyJobEvent(job.id, job.version, { type: "PR_HEAD_RESOLVED", headSha: sha() }, 1_009);
  job = store.applyJobEvent(job.id, job.version, { type: "VALIDATION_PASSED", headSha: sha() }, 1_010);
  return { job, effect: effect(store, job.id, "spawn_review") };
}

function advanceReviewToDocs(store: TelegramAgentStore, job: ReturnType<typeof advanceImplementationToReview>["job"]) {
  job = store.applyJobEvent(job.id, job.version, { type: "REVIEW_PASSED", headSha: sha() }, 1_011);
  return { job, effect: effect(store, job.id, "spawn_docs") };
}

function advanceDocsToFinalReview(store: TelegramAgentStore, job: ReturnType<typeof advanceReviewToDocs>["job"]) {
  job = store.applyJobEvent(job.id, job.version, { type: "DOCS_IDLE" }, 1_012);
  job = store.applyJobEvent(job.id, job.version, { type: "PR_HEAD_RESOLVED", headSha: sha() }, 1_013);
  job = store.applyJobEvent(job.id, job.version, { type: "VALIDATION_PASSED", headSha: sha() }, 1_014);
  return { job, effect: effect(store, job.id, "spawn_final_review") };
}

function registerWorkerConfiguration() {
  const value = fixture();
  registerControllerTools(value.bb, {
    store: value.store,
    sdk: value.bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_000,
  });
  return value;
}

function createStage(
  store: TelegramAgentStore,
  input: { jobId: string; effectKey: string; role: "PLAN" | "CRITIQUE" | "DOCS"; threadId?: string },
) {
  const lease = store.acquireExecutorLease("stage-writer", 2_000, 30_000);
  if (!lease.acquired) throw new Error("stage writer lease was not acquired");
  const attempt = store.createPipelineStageAttempt({
    id: `stage:${input.effectKey}`,
    jobId: input.jobId,
    role: input.role,
    ordinal: 1,
    inputSha256: "a".repeat(64),
    ownerId: "stage-writer",
    generation: lease.generation,
    now: 2_001,
  });
  if (input.threadId) {
    expect(store.bindPipelineStageThread({
      id: attempt.id,
      threadId: input.threadId,
      environmentId: "env_worker",
      ownerId: "stage-writer",
      generation: lease.generation,
      now: 2_002,
    })).toBe(true);
  }
  expect(store.releaseExecutorLease("stage-writer", lease.generation, 2_003)).toBe(true);
  return attempt;
}

it("atomically creates one queued controller job with one confirmed admission", () => {
  const { store } = fixture();

  const job = store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller",
    projectId: "proj_1",
    task: "Fix the redirect and add a regression test",
    now: 10_000,
  });

  expect(job).toMatchObject({ state: "awaiting_confirmation", projectId: "proj_1", policyVersion: 1 });
  expect(store.getAdmission(job.id)).toMatchObject({
    projectId: "proj_1",
    state: "queued",
    resumeEvent: "CONFIRMED",
  });
  expect(store.listEffectsForJob(job.id).map((effect) => effect.kind)).toEqual([
    "render_status",
  ]);
  expect(store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller",
    projectId: "proj_1",
    task: "Fix the redirect and add a regression test",
    now: 10_001,
  })).toEqual(job);
});

it("rejects unmapped controllers and disabled projects while allowing another queued job", () => {
  const { bb, store } = fixture();
  expect(() => store.createConfirmedControllerJob({
    controllerThreadId: "thr_unrelated",
    projectId: "proj_1",
    task: "unsafe",
    now: 10_000,
  })).toThrow(/controller/i);

  store.upsertProjectPolicy(policyFixture({ projectId: "proj_disabled", alias: "disabled", enabled: false }), 10_000);
  expect(() => store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller",
    projectId: "proj_disabled",
    task: "disabled",
    now: 10_000,
  })).toThrow(/enabled|project/i);
  expect(bb.storage.database().prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 0 });

  const existing = store.createJob({ id: "existing", sourceUpdateId: 900, requestText: "existing", now: 10_000 });
  const created = store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller",
    projectId: "proj_1",
    task: "new work",
    now: 10_000,
  });
  expect(created.id).not.toBe(existing.id);
  expect(created.state).toBe("awaiting_confirmation");
  expect(store.getAdmission(created.id)).toMatchObject({ state: "queued" });
  expect(bb.storage.database().prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 2 });
  expect(bb.storage.database().prepare("SELECT COUNT(*) AS count FROM effects").get()).toEqual({ count: 1 });
});

it("registers the exact controller tools and keeps them off unrelated sessions", async () => {
  const { bb, harness, store } = fixture();
  const notify = vi.fn();
  const requestThreadOperation = vi.fn(async () => ({
    id: "operation_1",
    kind: "stop_thread" as const,
    threadId: "thr_active",
    state: "awaiting_confirmation" as const,
    expiresAt: 20_000,
  }));
  harness.sdk.stub("projects.list", async () => [{
    id: "proj_1",
    kind: "software",
    name: "cyndra-saas",
    gitRemoteUrl: "git@github.com:acme/cyndra.git",
    createdAt: 1,
    updatedAt: 1,
    sources: [],
  }]);
  harness.sdk.stub("threads.list", async () => [
    visibleThread(),
    visibleThread({ id: "thr_idle", title: "Old task", status: "idle", runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null } }),
    visibleThread({ id: "thr_hidden", title: "Private controller", visibility: "hidden" }),
  ]);
  harness.sdk.stub("threads.get", async ({ threadId }) => ({
    ...visibleThread(threadId === "thr_hidden"
      ? { id: "thr_hidden", title: "Private controller", visibility: "hidden" }
      : {}),
    canSpawnChild: true,
  }));
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: requestThreadOperation },
    health: () => ({ ok: true }),
    notify,
    now: () => 10_000,
  });

  expect(harness.registrations.agentTools.map((tool) => tool.name)).toEqual(CONTROLLER_TOOL_NAMES);
  const context = {
    thread: { id: "thr_controller", title: "Telegram Luna controller owner-7-controller", parentThreadId: null, sourceThreadId: null },
    project: { id: "proj_personal", kind: "personal" as const, name: "Personal", gitRemoteUrl: null },
    environment: { id: "env_personal", name: null, path: "/private/path", workspaceProvisionType: "personal" as const, branchName: null },
    host: { id: "host_personal", name: "Host" },
    provider: { id: "codex", model: "gpt-5.6-luna" },
    origin: { kind: null, pluginId: bb.pluginId },
  };
  const selected = await harness.behavior.resolveAgentConfiguration(context);
  expect(selected.tools.map((tool) => tool.name)).toEqual(CONTROLLER_TOOL_NAMES);
  expect(selected.skills).toEqual([]);
  expect(selected.instructions).toContain("You are the owner's teammate");
  expect((await harness.behavior.resolveAgentConfiguration({
    ...context,
    thread: { ...context.thread, title: "Telegram Codex controller owner-7-controller" },
  })).tools.map((tool) => tool.name)).toEqual(CONTROLLER_TOOL_NAMES);
  expect((await harness.behavior.resolveAgentConfiguration({
    ...context,
    thread: { ...context.thread, id: "thr_unrelated" },
  })).tools).toEqual([]);
  // Either controller provider may host the conversation; anything else may not.
  expect((await harness.behavior.resolveAgentConfiguration({
    ...context,
    provider: { id: "claude-code", model: "claude-opus-5[1m]" },
  })).tools.map((tool) => tool.name)).toEqual(CONTROLLER_TOOL_NAMES);
  expect((await harness.behavior.resolveAgentConfiguration({
    ...context,
    provider: { id: "acp-grok", model: "grok" },
  })).tools).toEqual([]);

  await expect(harness.behavior.callAgentTool(
    "telegram_agent_list_projects",
    {},
    { threadId: "thr_unrelated", projectId: "proj_personal" },
  )).rejects.toThrow(/controller|authorized/i);
  const projects = await harness.behavior.callAgentTool(
    "telegram_agent_list_projects",
    {},
    { threadId: "thr_controller", projectId: "proj_personal" },
  );
  expect(projects).toContain("cyndra");
  expect(projects).not.toContain("/private/path");

  const activeThreads = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_list_threads",
    {},
    { threadId: "thr_controller", projectId: "proj_personal" },
  ));
  expect(activeThreads).toMatchObject({
    truncated: false,
    threads: [{
      id: "thr_active",
      project: { id: "proj_1", name: "cyndra-saas" },
      status: "active",
      runtimeStatus: "active",
      environment: { id: "env_cyndra", branch: "feature/billing", workspace: "managed-worktree" },
      progress: { threadAgeMs: 9_000, lastActivityAgoMs: 500, etaMs: null },
    }],
  });
  expect(JSON.stringify(activeThreads)).not.toContain("thr_hidden");

  const threadStatus = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_thread_status",
    { threadId: "thr_active" },
    { threadId: "thr_controller", projectId: "proj_personal" },
  ));
  expect(threadStatus).toMatchObject({ thread: {
    id: "thr_active",
    title: "Fix Cyndra billing",
    parentThreadId: null,
    hasPendingInteraction: false,
    progress: {
      etaMs: null,
      etaReason: "BB does not expose a reliable completion estimate for provider turns",
    },
  } });
  await expect(harness.behavior.callAgentTool(
    "telegram_agent_thread_status",
    { threadId: "thr_hidden" },
    { threadId: "thr_controller", projectId: "proj_personal" },
  )).rejects.toThrow(/not visible/i);

  const operation = await harness.behavior.callAgentTool(
    "telegram_agent_request_thread_operation",
    { kind: "stop_thread", threadId: "thr_active" },
    { threadId: "thr_controller", projectId: "proj_personal" },
  );
  expect(operation).toContain("awaiting_confirmation");

  const started = await harness.behavior.callAgentTool(
    "telegram_agent_start_job",
    { projectId: "proj_1", task: "Fix the redirect and add a regression test" },
    { threadId: "thr_controller", projectId: "proj_personal" },
  );
  expect(started).toContain("awaiting_confirmation");
  const startedJob = store.listJobs(10).find((job) => job.requestText === "Fix the redirect and add a regression test");
  expect(startedJob).toBeDefined();
  expect(store.getAdmission(startedJob!.id)).toMatchObject({ state: "queued" });
  expect(notify).toHaveBeenCalledOnce();
});

it("routes verified implementation attempts through their exact durable effect before and after thread persistence", async () => {
  const { bb, harness, store } = registerWorkerConfiguration();
  const { job, effect: implementationEffect } = advanceToImplementation(store, "job_implementation");
  const attemptId = `attempt:${implementationEffect.idempotencyKey}`;
  store.createAttempt({ id: attemptId, jobId: job.id, kind: "implementation", ordinal: 1, now: 1_006 });
  const identity = { jobId: job.id, attemptId, role: "implementation" as const };

  const firstStart = await harness.behavior.resolveAgentConfiguration(workerContext(bb.pluginId, identity));
  expect(firstStart).toMatchObject({
    tools: [],
    skills: [
      "systematic-debugging",
      "test-driven-development",
      "verification-before-completion",
      "clean-code-guard",
      "test-guard",
    ],
  });
  expect(firstStart.instructions).toContain("Verified worker role: implementation");

  const implementationCreated = store.applyJobEvent(job.id, job.version, {
    type: "IMPLEMENTATION_CREATED", threadId: "thr_implementation", environmentId: "env_worker",
  }, 1_007);
  const lease = store.acquireExecutorLease("attempt-writer", 1_008, 30_000);
  if (!lease.acquired) throw new Error("attempt writer lease was not acquired");
  expect(store.updateExecutorAttempt({
    attemptId,
    jobId: implementationCreated.id,
    patch: { threadId: "thr_implementation" },
    ownerId: "attempt-writer",
    generation: lease.generation,
    now: 1_009,
  })).toMatchObject({ threadId: "thr_implementation" });
  expect(store.releaseExecutorLease("attempt-writer", lease.generation, 1_010)).toBe(true);

  const resumed = await harness.behavior.resolveAgentConfiguration(workerContext(bb.pluginId, identity, {
    thread: { id: "thr_implementation", title: buildWorkerThreadTitle(identity), parentThreadId: null, sourceThreadId: null },
  }));
  expect(resumed).toMatchObject({ tools: [], skills: firstStart.skills, instructions: firstStart.instructions });

  const wrongEnvironment = await harness.behavior.resolveAgentConfiguration(workerContext(bb.pluginId, identity, {
    thread: { id: "thr_implementation", title: buildWorkerThreadTitle(identity), parentThreadId: null, sourceThreadId: null },
    environment: {
      id: "env_other",
      name: "other worker",
      path: "/workspace/other",
      workspaceProvisionType: "managed-worktree",
      branchName: "agent/other",
    },
  }));
  expect(wrongEnvironment).toMatchObject({ tools: [], skills: [] });
  expect(wrongEnvironment.instructions).toBeNull();
});

it("routes review variants and pipeline stages only when their stored role and effect kind exactly agree", async () => {
  const { bb, harness, store } = registerWorkerConfiguration();
  const implementation = advanceToImplementation(store, "job_roles");
  const planEffect = effect(store, implementation.job.id, "spawn_plan");
  const critiqueEffect = effect(store, implementation.job.id, "spawn_critique");
  createStage(store, { jobId: implementation.job.id, effectKey: planEffect.idempotencyKey, role: "PLAN", threadId: "thr_plan" });
  createStage(store, { jobId: implementation.job.id, effectKey: critiqueEffect.idempotencyKey, role: "CRITIQUE" });
  const review = advanceImplementationToReview(store, implementation.job);
  const reviewId = `attempt:${review.effect.idempotencyKey}`;
  store.createAttempt({ id: reviewId, jobId: review.job.id, kind: "review", ordinal: 1, headSha: sha(), now: 2_100 });
  const docs = advanceReviewToDocs(store, review.job);
  createStage(store, { jobId: docs.job.id, effectKey: docs.effect.idempotencyKey, role: "DOCS" });
  const finalReview = advanceDocsToFinalReview(store, docs.job);
  const finalReviewId = `attempt:${finalReview.effect.idempotencyKey}`;
  store.createAttempt({ id: finalReviewId, jobId: finalReview.job.id, kind: "review", ordinal: 2, headSha: sha(), now: 2_101 });

  const cases = [
    [{ jobId: review.job.id, attemptId: reviewId, role: "review" as const }, undefined, ["clean-code-guard", "test-guard"]],
    [{ jobId: finalReview.job.id, attemptId: finalReviewId, role: "final-review" as const }, undefined, ["clean-code-guard", "test-guard", "docs-guard"]],
    [{ jobId: implementation.job.id, attemptId: `stage:${planEffect.idempotencyKey}`, role: "planner" as const }, "thr_plan", []],
    [{ jobId: implementation.job.id, attemptId: `stage:${critiqueEffect.idempotencyKey}`, role: "critic" as const }, undefined, []],
    [{ jobId: docs.job.id, attemptId: `stage:${docs.effect.idempotencyKey}`, role: "documentation" as const }, undefined, ["docs-guard", "verification-before-completion"]],
  ] as const;
  for (const [identity, threadId, skills] of cases) {
    const configuration = await harness.behavior.resolveAgentConfiguration(workerContext(bb.pluginId, identity, threadId === undefined ? {} : {
      thread: { id: threadId, title: buildWorkerThreadTitle(identity), parentThreadId: null, sourceThreadId: null },
    }));
    expect(configuration).toMatchObject({ tools: [], skills });
    expect(configuration.instructions).toContain(`Verified worker role: ${identity.role}`);
  }

  const swappedReviewTitles = [
    { jobId: review.job.id, attemptId: reviewId, role: "final-review" as const },
    { jobId: finalReview.job.id, attemptId: finalReviewId, role: "review" as const },
  ];
  for (const identity of swappedReviewTitles) {
    const configuration = await harness.behavior.resolveAgentConfiguration(workerContext(bb.pluginId, identity));
    expect(configuration).toMatchObject({ tools: [], skills: [] });
    expect(configuration.instructions).toBeNull();
  }
});

it("fails closed for forged durable worker and controller identities", async () => {
  const { bb, harness, store } = registerWorkerConfiguration();
  const implementation = advanceToImplementation(store, "job_guard");
  const implementationId = `attempt:${implementation.effect.idempotencyKey}`;
  store.createAttempt({ id: implementationId, jobId: implementation.job.id, kind: "implementation", ordinal: 1, now: 3_000 });
  const identity = { jobId: implementation.job.id, attemptId: implementationId, role: "implementation" as const };
  const review = advanceImplementationToReview(store, implementation.job);
  const wrongEffectId = `attempt:${review.effect.idempotencyKey}`;
  store.createAttempt({ id: wrongEffectId, jobId: review.job.id, kind: "implementation", ordinal: 2, now: 3_001 });
  const wrongStage = createStage(store, { jobId: implementation.job.id, effectKey: implementation.effect.idempotencyKey, role: "CRITIQUE" });
  const lease = store.acquireExecutorLease("guard-writer", 3_002, 30_000);
  if (!lease.acquired) throw new Error("guard writer lease was not acquired");
  expect(store.updateExecutorAttempt({
    attemptId: implementationId,
    jobId: implementation.job.id,
    patch: { threadId: "thr_bound" },
    ownerId: "guard-writer",
    generation: lease.generation,
    now: 3_003,
  })).not.toBeNull();
  expect(store.releaseExecutorLease("guard-writer", lease.generation, 3_004)).toBe(true);

  const forged = [
    workerContext(bb.pluginId, { ...identity, role: "review" }),
    workerContext(bb.pluginId, { jobId: review.job.id, attemptId: wrongEffectId, role: "implementation" }),
    workerContext(bb.pluginId, { jobId: implementation.job.id, attemptId: wrongStage.id, role: "planner" }),
    workerContext(bb.pluginId, { ...identity, attemptId: "attempt:missing:1:spawn_implementation" }),
    workerContext(bb.pluginId, { ...identity, jobId: "job_other" }),
    workerContext(bb.pluginId, identity, {
      thread: { id: "thr_other", title: buildWorkerThreadTitle(identity), parentThreadId: null, sourceThreadId: null },
    }),
    workerContext(bb.pluginId, identity, { project: { id: "proj_other", kind: "standard", name: "Other", gitRemoteUrl: null } }),
    workerContext(bb.pluginId, identity, { environment: { id: "env_worker", name: "worker", path: "/workspace/worker", workspaceProvisionType: "unmanaged", branchName: null } }),
    workerContext("other-plugin", identity),
    workerContext(bb.pluginId, identity, { origin: { kind: "fork", pluginId: bb.pluginId } }),
  ];
  for (const context of forged) {
    const configuration = await harness.behavior.resolveAgentConfiguration(context);
    expect(configuration).toMatchObject({ tools: [], skills: [] });
    expect(configuration.instructions).toBeNull();
  }

  const spoofedController = workerContext(bb.pluginId, identity, {
    thread: { id: "thr_controller", title: buildWorkerThreadTitle(identity), parentThreadId: null, sourceThreadId: null },
    project: { id: "proj_personal", kind: "personal", name: "Personal", gitRemoteUrl: null },
    environment: { id: "env_personal", name: null, path: "/private/path", workspaceProvisionType: "personal", branchName: null },
    host: { id: "host_personal", name: "Host" },
  });
  const configuration = await harness.behavior.resolveAgentConfiguration(spoofedController);
  expect(configuration).toMatchObject({ tools: [], skills: [] });
  expect(configuration.instructions).toBeNull();
});

it("returns bounded choices for ambiguous status, retry, and cancel without mutation", async () => {
  const { bb, harness, store, turn } = fixture();
  const notify = vi.fn();
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify,
    now: () => 10_100,
  });
  expect(parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_job_status",
    {},
    controllerToolContext,
  ))).toEqual({ outcome: "none", candidates: [] });
  queueControllerCandidate(store, "controller_job_a", "proj_a", "failed");
  expect(parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_job_status",
    {},
    controllerToolContext,
  ))).toMatchObject({ job: { id: "controller_job_a", projectId: "proj_a", state: "failed" } });
  queueControllerCandidate(store, "controller_job_b", "proj_b", "failed");

  const expected = {
    outcome: "choose_job",
    candidates: [
      { id: "controller_job_a", projectId: "proj_a", state: "failed" },
      { id: "controller_job_b", projectId: "proj_b", state: "failed" },
    ],
  };
  const before = store.listJobs(10).map(({ id, state, version, cancelRequestedAt }) => ({
    id,
    state,
    version,
    cancelRequestedAt,
  }));

  expect(parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_job_status",
    {},
    controllerToolContext,
  ))).toEqual(expected);
  expect(parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_retry_job",
    {},
    controllerToolContext,
  ))).toEqual(expected);
  expect(parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_cancel_job",
    {},
    controllerToolContext,
  ))).toEqual(expected);
  expect(store.listJobs(10).map(({ id, state, version, cancelRequestedAt }) => ({
    id,
    state,
    version,
    cancelRequestedAt,
  }))).toEqual(before);
  expect(notify).not.toHaveBeenCalled();

  expect(store.listToolReceipts(turn.id)).toEqual([
    expect.objectContaining({ toolName: "telegram_agent_cancel_job", state: "completed" }),
    expect.objectContaining({ toolName: "telegram_agent_retry_job", state: "completed" }),
  ]);

  expect(parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_retry_job",
    { jobId: "controller_job_a" },
    controllerToolContext,
  ))).toMatchObject({ job: { id: "controller_job_a", state: "planning" } });
  expect(store.getJob("controller_job_b")?.state).toBe("failed");
  expect(notify).toHaveBeenCalledOnce();
});

it("reads what a thread is doing so slowness can be explained rather than deflected", async () => {
  const { bb, harness, store } = fixture();
  harness.sdk.stub("threads.get", async () => ({ ...visibleThread(), canSpawnChild: true }));
  harness.sdk.stub("threads.timeline", async () => ({
    rows: [],
    activePromptMode: null,
    activeThinking: { id: "think_1", text: "Rewriting the invoice mapper", startedAt: 8_000, updatedAt: 9_800 },
    activeWorkflows: [],
    activeBackgroundCommands: [{
      ...backgroundCommand(),
      description: "npm test -- --runInBand",
      taskStatus: "running" as const,
      startedAt: 7_000,
    }],
    pendingTodos: {
      sourceSeq: 4,
      updatedAt: 9_000,
      items: [
        { id: "todo_1", text: "Map legacy invoices", status: "completed" as const },
        { id: "todo_2", text: "Backfill the report", status: "in_progress" as const },
      ],
    },
    goal: {
      sourceSeq: 1,
      updatedAt: 9_000,
      objective: "Ship the billing fix",
      status: "active" as const,
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 30,
    },
    modelFallback: null,
    timelinePage: { hasMore: false, oldestSeq: 1, newestSeq: 9 },
    maxSeq: 9,
  }));
  harness.sdk.stub("threads.output", async () => ({ output: "Running the suite now." }));
  harness.sdk.stub("threads.interactions.list", async () => []);
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_000,
  });

  const activity = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_read_thread",
    { threadId: "thr_active" },
    { threadId: "thr_controller", projectId: "proj_personal" },
  ));

  expect(activity).toMatchObject({
    thread: { id: "thr_active", lastActivityAgoMs: 500, waitingOnOwner: false },
    currentStep: { text: "Rewriting the invoice mapper", runningForMs: 2_000, idleForMs: 200 },
    goal: { objective: "Ship the billing fix", status: "active" },
    todos: [
      { text: "Map legacy invoices", status: "completed" },
      { text: "Backfill the report", status: "in_progress" },
    ],
    runningCommands: [{ description: "npm test -- --runInBand", taskStatus: "running", runningForMs: 3_000 }],
    latestMessage: "Running the suite now.",
  });
});

it("opens and messages visible threads, and refuses hidden ones", async () => {
  const { bb, harness, store } = fixture();
  const spawn = vi.fn(async () => ({ id: "thr_new", environmentId: "env_new" }));
  const send = vi.fn(async () => ({ ok: true }));
  harness.sdk.stub("projects.list", async () => [{
    id: "proj_1",
    kind: "software",
    name: "cyndra-saas",
    gitRemoteUrl: "git@github.com:acme/cyndra.git",
    createdAt: 1,
    updatedAt: 1,
    sources: [{
      id: "src_1",
      projectId: "proj_1",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
      type: "local_path",
      hostId: "host_cyndra",
      path: "/repo",
    }],
  }]);
  harness.sdk.stub("threads.spawn", spawn);
  harness.sdk.stub("threads.send", send);
  harness.sdk.stub("threads.get", async ({ threadId }) => ({
    ...visibleThread(threadId === "thr_hidden" ? { id: "thr_hidden", visibility: "hidden" } : {}),
    canSpawnChild: true,
  }));
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_000,
  });

  const created = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_create_thread",
    { projectId: "proj_1", title: "Look into the billing spike", prompt: "Investigate the invoice spike" },
    { threadId: "thr_controller", projectId: "proj_personal" },
  ));
  expect(created).toMatchObject({ thread: { id: "thr_new", projectId: "proj_1" } });
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
    projectId: "proj_1",
    visibility: "visible",
    environment: expect.objectContaining({ type: "host", hostId: "host_cyndra" }),
  }));

  const sent = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_send_to_thread",
    { threadId: "thr_active", text: "Use the staging database" },
    { threadId: "thr_controller", projectId: "proj_personal" },
  ));
  expect(sent).toMatchObject({ sent: { threadId: "thr_active" } });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    threadId: "thr_active",
    input: [{ type: "text", text: "Use the staging database", mentions: [] }],
  }));

  await expect(harness.behavior.callAgentTool(
    "telegram_agent_send_to_thread",
    { threadId: "thr_hidden", text: "leak" },
    { threadId: "thr_controller", projectId: "proj_personal" },
  )).rejects.toThrow(/not visible/i);
});

function delegationProjects() {
  return ["proj_a", "proj_b"].map((id) => ({
    id,
    kind: "standard" as const,
    name: id,
    gitRemoteUrl: `https://github.com/acme/${id}.git`,
    createdAt: 1,
    updatedAt: 1,
    sources: [{
      id: `src_${id}`,
      projectId: id,
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
      type: "local_path" as const,
      hostId: `host_${id}`,
      path: `/work/${id}`,
    }],
  }));
}

it("fans work out to one thread per task and records them against one delegation", async () => {
  const { bb, harness, store } = fixture();
  const spawned: string[] = [];
  harness.sdk.stub("projects.list", async () => delegationProjects());
  harness.sdk.stub("threads.spawn", async ({ title }: { title: string }) => {
    spawned.push(title);
    return { id: `thr_${spawned.length}`, environmentId: "env_worker" };
  });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  const result = parseToolJson(await harness.behavior.callAgentTool("telegram_agent_delegate", {
    instruction: "tell me which of the two is worse",
    tasks: [
      { projectId: "proj_a", title: "invoice spike", prompt: "look into the invoice spike" },
      { projectId: "proj_b", title: "billing latency", prompt: "look into billing latency" },
    ],
  }, controllerToolContext)) as { outcome: string; delegation: { id: string; threads: unknown[] } };

  expect(result.outcome).toBe("delegated");
  expect(spawned).toEqual(["invoice spike", "billing latency"]);
  expect(store.getDelegation(result.delegation.id)).toMatchObject({
    state: "open",
    instruction: "tell me which of the two is worse",
    threads: [
      { threadId: "thr_1", projectId: "proj_a", title: "invoice spike", state: "running" },
      { threadId: "thr_2", projectId: "proj_b", title: "billing latency", state: "running" },
    ],
  });
});

it("keeps the threads that did start when a later spawn fails", async () => {
  const { bb, harness, store } = fixture();
  let spawnCount = 0;
  harness.sdk.stub("projects.list", async () => delegationProjects());
  harness.sdk.stub("threads.spawn", async () => {
    spawnCount += 1;
    if (spawnCount === 2) throw new Error("BB refused the second spawn");
    return { id: `thr_${spawnCount}`, environmentId: "env_worker" };
  });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  const result = parseToolJson(await harness.behavior.callAgentTool("telegram_agent_delegate", {
    instruction: "compare them",
    tasks: [
      { projectId: "proj_a", title: "first", prompt: "first task" },
      { projectId: "proj_b", title: "second", prompt: "second task" },
    ],
  }, controllerToolContext)) as { outcome: string; delegation: { id: string }; failed: { title: string } };

  expect(result.outcome).toBe("partial");
  expect(result.failed.title).toBe("second");
  expect(store.getDelegation(result.delegation.id)).toMatchObject({
    state: "open",
    threads: [{ threadId: "thr_1", title: "first", state: "running" }],
  });
});

it("opens no delegation when the very first spawn fails", async () => {
  const { bb, harness, store } = fixture();
  harness.sdk.stub("threads.spawn", async () => { throw new Error("BB refused the spawn"); });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  await expect(harness.behavior.callAgentTool("telegram_agent_delegate", {
    instruction: "compare them",
    tasks: [{ projectId: "proj_a", title: "only", prompt: "only task" }],
  }, controllerToolContext)).rejects.toThrow();

  expect(store.listOpenDelegations(10)).toEqual([]);
});

it("refuses to delegate for a thread that is not the durable controller", async () => {
  const { bb, harness, store } = fixture();
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  await expect(harness.behavior.callAgentTool("telegram_agent_delegate", {
    instruction: "compare them",
    tasks: [{ projectId: "proj_a", title: "only", prompt: "only task" }],
  }, { threadId: "thr_unrelated", projectId: "proj_personal" })).rejects.toThrow(/not authorized/);
  expect(store.listOpenDelegations(10)).toEqual([]);
});
