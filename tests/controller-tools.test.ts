import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@bb/plugin-sdk";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BUNDLED_SKILL_IDS, buildWorkerThreadTitle, type WorkerSkillRole } from "../src/agent-skills/role-resolver";
import { hashSecret } from "../src/crypto";
import { admitConfirmedJob, policyFixture, sha } from "./helpers";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { CONTROLLER_TOOL_NAMES, registerControllerTools } from "../src/controller/tools";
import { controllerSpawnTitle, parseControllerSpawnTitle } from "../src/controller/bb-controller";
import { CONTROLLER_INSTRUCTION_SENTINEL } from "../src/controller/instructions";
import { canonicalControllerJson, sha256ControllerJson } from "../src/controller/capability-executor";
import { CONTROLLER_CAPABILITIES } from "../src/controller/capability-policy";
import { ControllerEvidenceProjector } from "../src/controller/evidence-projector";
import { controllerFinalizationJsonSchema } from "../src/controller/finalization-contract";

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
  const parsed = JSON.parse(value) as Record<string, unknown>;
  delete parsed._hanoonEvidence;
  return parsed;
}

type RuntimeEvidence = Readonly<{
  outcome: "observed" | "succeeded" | "interrupted";
  proofKinds: string[];
  subjectRefs: string[];
}>;

function parseToolWithEvidence(value: unknown): Record<string, unknown> & { _hanoonEvidence: RuntimeEvidence } {
  if (typeof value !== "string") throw new Error("controller tool did not return JSON text");
  return JSON.parse(value) as Record<string, unknown> & { _hanoonEvidence: RuntimeEvidence };
}

function runtimeProjection(evidence: RuntimeEvidence): RuntimeEvidence {
  return {
    outcome: evidence.outcome,
    proofKinds: evidence.proofKinds,
    subjectRefs: evidence.subjectRefs,
  };
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
function fixture(options: { active?: boolean } = {}) {
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
  expect(store.reserveControllerSpawn({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: 10_000,
  })).toBe(true);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: "executor",
    generation: lease.generation,
    now: 10_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: "executor",
    generation: lease.generation,
    now: 10_000,
  })).toBe(true);
  let activeFence = { ownerId: "executor", generation: lease.generation, now: 10_000 };
  const deactivate = () => {
    if (store.isExecutorLeaseCurrent(activeFence.ownerId, activeFence.generation, activeFence.now)) {
      expect(store.releaseExecutorLease(activeFence.ownerId, activeFence.generation, activeFence.now)).toBe(true);
    }
  };
  const activate = () => {
    const acquired = store.acquireExecutorLease("executor", 10_000, 30_000);
    if (!acquired.acquired) throw new Error("missing replacement controller lease");
    activeFence = { ownerId: "executor", generation: acquired.generation, now: 10_000 };
    expect(store.adoptSubmittedControllerTurnFence({ ...activeFence, turnId: turn.id })).toBe(true);
  };
  if (!options.active) deactivate();
  return { bb, harness, store, turn, activate, deactivate };
}

function pendingConfigurationFixture() {
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-controller-pending-${fixtureNumber++}`,
    agentSkillIds: [...BUNDLED_SKILL_IDS],
  });
  const store = openStore(bb.storage, bb.storage.kv, () => 10_000);
  store.createPairingCode(hashSecret("pair-pending"), 1_000, 20_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-pending"), "7", "7", 1_001)).toEqual({ ok: true });
  const turn = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 7_901,
    inputText: "What is running right now?",
    now: 2_000,
  });
  const lease = store.acquireExecutorLease("pending-executor", 10_000, 30_000);
  if (!lease.acquired) throw new Error("missing pending controller lease");
  const fence = { ownerId: "pending-executor", generation: lease.generation, now: 10_000 };
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  const controller = store.getControllerForOwner("7", "7");
  if (!controller?.pendingSpawnToken) throw new Error("missing pending controller token");
  expect(store.reserveControllerSpawn({
    ...fence,
    controllerKey: controller.controllerKey,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
  })).toBe(true);
  return { bb, harness, store, turn, controller, fence };
}

it("preserves the exact Task 6 metadata and adds the bounded evidence-index schema", () => {
  const { bb, harness, store } = fixture({ active: true });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });
  const registrations = harness.registrations.agentTools;
  const metadata = registrations.map((tool) => ({
    name: tool.name,
    description: tool.description,
    statusLabels: tool.experimentalStatusLabels,
    schema: tool.inputSchema,
  }));
  const providerJson = JSON.parse(JSON.stringify(metadata));
  const digest = createHash("sha256")
    .update(canonicalControllerJson(providerJson.slice(0, 21)), "utf8")
    .digest("hex");
  expect(digest).toBe("c6be7f690b30281c7c3279b7e08276371d9c2474f52e407936faa034a56064a8");
  expect(metadata[21]).toEqual({
    name: "telegram_agent_turn_evidence",
    description: "List bounded evidence for the current authorized controller turn after reconciling BB-native work.",
    statusLabels: null,
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        afterEvidenceId: {
          default: 0,
          type: "integer",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
      additionalProperties: false,
    },
  });
  expect(metadata[22]).toEqual({
    name: "telegram_agent_respond",
    description: "Submit one bounded evidence-backed final response for the current controller turn.",
    statusLabels: null,
    schema: controllerFinalizationJsonSchema,
  });
  expect(new Set(registrations.map((tool) => tool.name)).size).toBe(23);

  const byName = new Map(registrations.map((tool) => [tool.name, tool]));
  const parsed = (name: string, params: unknown) => {
    const result = byName.get(name)?.parse(params);
    if (!result?.ok) throw new Error(`provider schema did not parse ${name}`);
    return result.value;
  };
  expect(parsed("telegram_agent_list_threads", {})).toEqual({ status: "active", limit: 10 });
  expect(parsed("telegram_agent_remember", { subject: "s", body: "b" })).toEqual({
    subject: "s",
    body: "b",
    kind: "fact",
  });
  expect(parsed("telegram_agent_recall", { query: "q" })).toEqual({ query: "q", limit: 8 });
  expect(parsed("telegram_agent_list_watches", {})).toEqual({ includeFinished: false });
  expect(parsed("telegram_agent_scorecard", {})).toEqual({ windowDays: 7 });
});

it("matches the exact trusted 21-tool projection permission matrix", () => {
  const expected = [
    ["telegram_agent_list_projects", ["project_state"]],
    ["telegram_agent_start_job", ["job_state", "external_mutation", "obligation"]],
    ["telegram_agent_job_status", ["job_state", "pipeline_outcome", "obligation"]],
    ["telegram_agent_retry_job", ["job_state", "external_mutation", "obligation"]],
    ["telegram_agent_cancel_job", ["job_state", "external_mutation"]],
    ["telegram_agent_list_threads", ["thread_state"]],
    ["telegram_agent_thread_status", ["thread_state"]],
    ["telegram_agent_read_thread", ["thread_state"]],
    ["telegram_agent_create_thread", ["thread_state", "external_mutation"]],
    ["telegram_agent_send_to_thread", ["external_mutation", "thread_state"]],
    ["telegram_agent_request_thread_operation", ["obligation"]],
    ["telegram_agent_remember", ["memory_state"]],
    ["telegram_agent_recall", ["memory_state"]],
    ["telegram_agent_forget", ["memory_state"]],
    ["telegram_agent_watch", ["monitor_state", "obligation"]],
    ["telegram_agent_list_watches", ["monitor_state", "obligation"]],
    ["telegram_agent_cancel_watch", ["monitor_state"]],
    ["telegram_agent_health", ["health_snapshot"]],
    ["telegram_agent_delegate", ["thread_state", "external_mutation", "obligation"]],
    ["telegram_agent_scorecard", ["health_snapshot"]],
    ["telegram_agent_set_working_style", ["memory_state"]],
  ] as const;

  expect(expected.map(([name]) => name)).toEqual(CONTROLLER_TOOL_NAMES.slice(0, 21));
  expect(CONTROLLER_TOOL_NAMES[21]).toBe("telegram_agent_turn_evidence");
  for (const [name, proofKinds] of expected) {
    expect(CONTROLLER_CAPABILITIES[name].proof_kinds).toEqual(proofKinds);
  }
});

it("emits the exact runtime projection for every registered Task 6 tool", async () => {
  const { bb, harness, store, turn, activate, deactivate } = fixture({ active: true });
  deactivate();
  queueControllerCandidate(store, "job_matrix_retry", "proj_a", "failed");
  queueControllerCandidate(store, "job_matrix_cancel", "proj_b", "awaiting_confirmation");
  activate();

  const project = {
    id: "proj_1",
    kind: "software" as const,
    name: "Cyndra",
    gitRemoteUrl: "https://github.com/acme/cyndra.git",
    createdAt: 1,
    updatedAt: 1,
    sources: [{
      id: "source_matrix",
      projectId: "proj_1",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
      type: "local_path" as const,
      hostId: "host_matrix",
      path: "/workspace/cyndra",
    }],
  };
  const spawnedProjects = new Map<string, string>();
  let spawnNumber = 0;
  harness.sdk.stub("projects.list", async () => [project]);
  harness.sdk.stub("threads.list", async () => [visibleThread()]);
  harness.sdk.stub("threads.get", async ({ threadId }) => ({
    ...visibleThread({ id: threadId, projectId: spawnedProjects.get(threadId) ?? "proj_1" }),
    canSpawnChild: true,
  }));
  harness.sdk.stub("threads.spawn", async ({ projectId }) => {
    const id = `thr_matrix_${String(++spawnNumber)}`;
    spawnedProjects.set(id, projectId);
    return { id, environmentId: `env_matrix_${String(spawnNumber)}` };
  });
  harness.sdk.stub("threads.send", async () => ({ ok: true }));
  harness.sdk.stub("threads.timeline", async () => ({
    rows: [],
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    goal: null,
    modelFallback: null,
    timelinePage: { hasMore: false, oldestSeq: null, newestSeq: null },
    maxSeq: 0,
  }));
  harness.sdk.stub("threads.output", async () => ({ output: "Matrix thread output." }));
  harness.sdk.stub("threads.interactions.list", async () => []);
  const requestOperation = vi.fn(async (input: {
    kind: "steer_thread" | "stop_thread" | "retry_thread";
    threadId: string;
    text?: string;
  }) => {
    store.createThreadOperation({
      id: "operation_matrix",
      nonceHash: "e".repeat(64),
      ownerUserId: "7",
      ownerChatId: "7",
      kind: input.kind,
      threadId: input.threadId,
      text: input.kind === "steer_thread" ? input.text ?? "steer" : null,
      expiresAt: 20_000,
      now: 10_050,
    });
    const operation = store.markThreadOperationConfirmationSent("operation_matrix", 88, 10_051);
    return {
      id: operation.id,
      kind: operation.kind,
      threadId: operation.threadId,
      state: operation.state,
      expiresAt: operation.expiresAt,
    };
  });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: requestOperation },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  const state: {
    startedJobId?: string;
    memoryId?: string;
    monitorId?: string;
    delegationId?: string;
  } = {};
  type MatrixRow = Readonly<{
    name: typeof CONTROLLER_TOOL_NAMES[number];
    params(): Record<string, unknown>;
    capture?(): void;
    expected(): RuntimeEvidence;
  }>;
  const rows: MatrixRow[] = [
    {
      name: "telegram_agent_list_projects",
      params: () => ({}),
      expected: () => ({
        outcome: "observed",
        proofKinds: ["project_state"],
        subjectRefs: ["project:proj_a", "project:proj_b", "project:proj_1"],
      }),
    },
    {
      name: "telegram_agent_start_job",
      params: () => ({ projectId: "proj_1", task: "Run the runtime projection matrix." }),
      capture: () => {
        const job = store.getJobBySourceUpdateId(turn.updateId);
        if (!job) throw new Error("matrix start job was not persisted");
        state.startedJobId = job.id;
      },
      expected: () => ({
        outcome: "succeeded",
        proofKinds: ["job_state", "external_mutation", "obligation"],
        subjectRefs: [`job:${state.startedJobId!}`],
      }),
    },
    {
      name: "telegram_agent_job_status",
      params: () => ({ jobId: state.startedJobId }),
      expected: () => ({
        outcome: "observed",
        proofKinds: ["job_state", "obligation"],
        subjectRefs: [`job:${state.startedJobId!}`],
      }),
    },
    {
      name: "telegram_agent_retry_job",
      params: () => ({ jobId: "job_matrix_retry" }),
      expected: () => ({
        outcome: "succeeded",
        proofKinds: ["job_state", "external_mutation", "obligation"],
        subjectRefs: ["job:job_matrix_retry"],
      }),
    },
    {
      name: "telegram_agent_cancel_job",
      params: () => ({ jobId: "job_matrix_cancel" }),
      expected: () => ({ outcome: "succeeded", proofKinds: ["job_state", "external_mutation"], subjectRefs: ["job:job_matrix_cancel"] }),
    },
    {
      name: "telegram_agent_list_threads",
      params: () => ({}),
      expected: () => ({ outcome: "observed", proofKinds: ["thread_state"], subjectRefs: ["thread:thr_active"] }),
    },
    {
      name: "telegram_agent_thread_status",
      params: () => ({ threadId: "thr_active" }),
      expected: () => ({ outcome: "observed", proofKinds: ["thread_state"], subjectRefs: ["thread:thr_active"] }),
    },
    {
      name: "telegram_agent_read_thread",
      params: () => ({ threadId: "thr_active" }),
      expected: () => ({ outcome: "observed", proofKinds: ["thread_state"], subjectRefs: ["thread:thr_active"] }),
    },
    {
      name: "telegram_agent_create_thread",
      params: () => ({ projectId: "proj_1", title: "Matrix exploration", prompt: "Inspect the runtime matrix." }),
      expected: () => ({
        outcome: "succeeded",
        proofKinds: ["thread_state", "external_mutation"],
        subjectRefs: ["thread:thr_matrix_1", "project:proj_1"],
      }),
    },
    {
      name: "telegram_agent_send_to_thread",
      params: () => ({ threadId: "thr_active", text: "Continue the matrix." }),
      expected: () => ({
        outcome: "succeeded",
        proofKinds: ["external_mutation", "thread_state"],
        subjectRefs: ["thread:thr_active"],
      }),
    },
    {
      name: "telegram_agent_request_thread_operation",
      params: () => ({ kind: "stop_thread", threadId: "thr_active" }),
      expected: () => ({ outcome: "succeeded", proofKinds: ["obligation"], subjectRefs: ["thread:thr_active"] }),
    },
    {
      name: "telegram_agent_remember",
      params: () => ({ subject: "runtime matrix", body: "Preserve exact evidence order.", kind: "fact" }),
      capture: () => {
        const row = bb.storage.database().prepare(
          "SELECT id FROM memories WHERE subject = 'runtime matrix' ORDER BY created_at DESC LIMIT 1",
        ).get() as { id: string } | undefined;
        if (!row) throw new Error("matrix memory was not persisted");
        state.memoryId = row.id;
      },
      expected: () => ({ outcome: "succeeded", proofKinds: ["memory_state"], subjectRefs: [`memory:${state.memoryId!}`] }),
    },
    {
      name: "telegram_agent_recall",
      params: () => ({ query: "runtime matrix" }),
      expected: () => ({ outcome: "observed", proofKinds: ["memory_state"], subjectRefs: [`memory:${state.memoryId!}`] }),
    },
    {
      name: "telegram_agent_forget",
      params: () => ({ id: state.memoryId }),
      expected: () => ({ outcome: "succeeded", proofKinds: ["memory_state"], subjectRefs: [`memory:${state.memoryId!}`] }),
    },
    {
      name: "telegram_agent_watch",
      params: () => ({ kind: "thread_idle", threadId: "thr_active", instruction: "Report matrix completion." }),
      capture: () => {
        const monitor = store.listMonitors(turn.controllerKey, false)[0];
        if (!monitor) throw new Error("matrix monitor was not persisted");
        state.monitorId = monitor.id;
      },
      expected: () => ({
        outcome: "succeeded",
        proofKinds: ["monitor_state", "obligation"],
        subjectRefs: [`monitor:${state.monitorId!}`, "thread:thr_active"],
      }),
    },
    {
      name: "telegram_agent_list_watches",
      params: () => ({}),
      expected: () => ({
        outcome: "observed",
        proofKinds: ["monitor_state", "obligation"],
        subjectRefs: [`monitor:${state.monitorId!}`],
      }),
    },
    {
      name: "telegram_agent_cancel_watch",
      params: () => ({ id: state.monitorId }),
      expected: () => ({ outcome: "succeeded", proofKinds: ["monitor_state"], subjectRefs: [`monitor:${state.monitorId!}`] }),
    },
    {
      name: "telegram_agent_health",
      params: () => ({}),
      expected: () => ({
        outcome: "observed",
        proofKinds: ["health_snapshot"],
        subjectRefs: ["controller:owner-7-controller"],
      }),
    },
    {
      name: "telegram_agent_delegate",
      params: () => ({
        instruction: "Join the matrix result.",
        tasks: [{ projectId: "proj_1", title: "Matrix delegate", prompt: "Check the matrix." }],
      }),
      capture: () => {
        const row = bb.storage.database().prepare(
          "SELECT id FROM delegations WHERE instruction = 'Join the matrix result.' ORDER BY created_at DESC LIMIT 1",
        ).get() as { id: string } | undefined;
        if (!row) throw new Error("matrix delegation was not persisted");
        state.delegationId = row.id;
      },
      expected: () => ({
        outcome: "succeeded",
        proofKinds: ["thread_state", "external_mutation", "obligation"],
        subjectRefs: [`delegation:${state.delegationId!}`, "thread:thr_matrix_2"],
      }),
    },
    {
      name: "telegram_agent_scorecard",
      params: () => ({}),
      expected: () => ({
        outcome: "observed",
        proofKinds: ["health_snapshot"],
        subjectRefs: ["controller:owner-7-controller"],
      }),
    },
    {
      name: "telegram_agent_set_working_style",
      params: () => ({ text: "Keep runtime evidence ordered." }),
      expected: () => ({
        outcome: "succeeded",
        proofKinds: ["memory_state"],
        subjectRefs: ["controller:owner-7-controller"],
      }),
    },
  ];

  expect(rows.map((row) => row.name)).toEqual(CONTROLLER_TOOL_NAMES.slice(0, 21));
  for (const row of rows) {
    const params = row.params();
    const result = parseToolWithEvidence(await harness.behavior.callAgentTool(
      row.name,
      params,
      controllerToolContext,
    ));
    row.capture?.();
    expect(runtimeProjection(result._hanoonEvidence), row.name).toEqual(row.expected());
    if (row.name === "telegram_agent_create_thread") {
      const replay = parseToolWithEvidence(await harness.behavior.callAgentTool(
        row.name,
        params,
        controllerToolContext,
      ));
      expect(runtimeProjection(replay._hanoonEvidence)).toEqual({ ...row.expected(), outcome: "observed" });
      expect(spawnNumber).toBe(1);
    }
    if (row.name === "telegram_agent_set_working_style") {
      const noOp = parseToolWithEvidence(await harness.behavior.callAgentTool(
        row.name,
        params,
        controllerToolContext,
      ));
      expect(runtimeProjection(noOp._hanoonEvidence)).toEqual({ ...row.expected(), outcome: "observed" });
    }
  }
});

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
  const { bb, harness, store, turn } = fixture({ active: true });
  const notify = vi.fn();
  const requestThreadOperation = vi.fn(async (input: {
    kind: "steer_thread" | "stop_thread" | "retry_thread";
    threadId: string;
    text?: string;
  }) => {
    store.createThreadOperation({
      id: "operation_1",
      nonceHash: "a".repeat(64),
      ownerUserId: "7",
      ownerChatId: "7",
      kind: input.kind,
      threadId: input.threadId,
      text: input.kind === "steer_thread" ? input.text ?? "steer" : null,
      expiresAt: 20_000,
      now: 9_000,
    });
    const awaiting = store.markThreadOperationConfirmationSent("operation_1", 77, 9_001);
    return { id: awaiting.id, kind: awaiting.kind, threadId: awaiting.threadId, state: awaiting.state, expiresAt: awaiting.expiresAt };
  });
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
    controllerProviderId: () => "codex",
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
  // The active controller must use the currently configured provider.
  expect((await harness.behavior.resolveAgentConfiguration({
    ...context,
    provider: { id: "claude-code", model: "claude-opus-5[1m]" },
  })).tools).toEqual([]);
  expect((await harness.behavior.resolveAgentConfiguration({
    ...context,
    provider: { id: "claude-code", model: "claude-opus-5[1m]" },
  })).instructions).toBeNull();
  expect((await harness.behavior.resolveAgentConfiguration({
    ...context,
    provider: { id: "acp-grok", model: "grok" },
  })).tools).toEqual([]);
  expect((await harness.behavior.resolveAgentConfiguration({
    ...context,
    thread: {
      ...context.thread,
      title: controllerSpawnTitle("owner-7-controller", turn.id, "proj_personal", "host_personal", "codex"),
    },
  })).tools.map((tool) => tool.name)).toEqual(CONTROLLER_TOOL_NAMES);

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
  )).rejects.toThrow(/scope|not visible/i);

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

it("authorizes one exact pending spawn identity before the BB thread mapping exists", async () => {
  const { bb, harness, store, turn, controller, fence } = pendingConfigurationFixture();
  const pendingSpawnToken = controller.pendingSpawnToken;
  if (!pendingSpawnToken) throw new Error("missing pending controller token");
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_000,
    controllerProviderId: () => "claude-code",
  });
  const title = controllerSpawnTitle(controller.controllerKey, pendingSpawnToken, "proj_personal", "host_personal", "claude-code");
  expect(parseControllerSpawnTitle(title)).toEqual({
    controllerKey: controller.controllerKey,
    pendingSpawnToken,
    projectId: "proj_personal",
    hostId: "host_personal",
    providerId: "claude-code",
  });
  expect(store.getControllerForPendingSpawn({
    controllerKey: controller.controllerKey,
    turnId: turn.id,
    pendingSpawnToken,
    now: fence.now,
  })).toMatchObject({ state: "pending_spawn", threadId: null });
  const context = {
    thread: { id: "thr_pre_return", title, parentThreadId: null, sourceThreadId: null },
    project: { id: "proj_personal", kind: "personal" as const, name: "Personal", gitRemoteUrl: null },
    environment: { id: "env_personal", name: null, path: "/personal", workspaceProvisionType: "personal" as const, branchName: null },
    host: { id: "host_personal", name: "Host" },
    provider: { id: "claude-code", model: "claude-opus-5[1m]" },
    origin: { kind: null, pluginId: bb.pluginId },
  };
  const configured = await harness.behavior.resolveAgentConfiguration(context);
  expect(configured.tools.map((tool) => tool.name)).toEqual(CONTROLLER_TOOL_NAMES);
  expect(configured.skills).toEqual([]);
  expect(configured.instructions).toContain(CONTROLLER_INSTRUCTION_SENTINEL);
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ threadId: null, state: "pending_spawn" });

  const forgedContexts = [
    { ...context, thread: { ...context.thread, title: `${title} suffix-spoof` } },
    { ...context, thread: { ...context.thread, title: `prefix-spoof ${title}` } },
    { ...context, thread: { ...context.thread, title: controllerSpawnTitle("owner-8-controller", pendingSpawnToken, "proj_personal", "host_personal", "claude-code") } },
    { ...context, thread: { ...context.thread, title: controllerSpawnTitle(controller.controllerKey, "controller-turn-wrong", "proj_personal", "host_personal", "claude-code") } },
    { ...context, origin: { kind: "fork" as const, pluginId: bb.pluginId } },
    { ...context, origin: { kind: null, pluginId: "other-plugin" } },
    { ...context, provider: { id: "acp-grok", model: "grok" } },
    { ...context, provider: { id: "codex", model: "gpt-5.6-luna" } },
    { ...context, host: { id: "host_other", name: "Other host" } },
    { ...context, project: { ...context.project, id: "proj_other" } },
    { ...context, project: { ...context.project, kind: "standard" as const } },
    { ...context, environment: { ...context.environment, workspaceProvisionType: "managed-worktree" as const } },
  ];
  for (const forged of forgedContexts) {
    const rejected = await harness.behavior.resolveAgentConfiguration(forged);
    expect(rejected).toMatchObject({ tools: [], skills: [] });
    expect(rejected.instructions).toBeNull();
  }
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
      "pr-writer",
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
  const { bb, harness, store, turn, activate, deactivate } = fixture({ active: true });
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
  deactivate();
  queueControllerCandidate(store, "controller_job_a", "proj_a", "failed");
  activate();
  expect(parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_job_status",
    {},
    controllerToolContext,
  ))).toMatchObject({ job: { id: "controller_job_a", projectId: "proj_a", state: "failed" } });
  deactivate();
  queueControllerCandidate(store, "controller_job_b", "proj_b", "failed");
  activate();

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

  for (const toolName of [
    "telegram_agent_job_status",
    "telegram_agent_retry_job",
    "telegram_agent_cancel_job",
  ] as const) {
    const output = parseToolWithEvidence(await harness.behavior.callAgentTool(
      toolName,
      {},
      controllerToolContext,
    ));
    const { _hanoonEvidence, ...domain } = output;
    expect(domain).toEqual(expected);
    expect(runtimeProjection(_hanoonEvidence)).toEqual({
      outcome: "observed",
      proofKinds: ["job_state"],
      subjectRefs: ["job:controller_job_a", "job:controller_job_b"],
    });
  }
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

it.each([
  "telegram_agent_job_status",
  "telegram_agent_retry_job",
  "telegram_agent_cancel_job",
] as const)("denies an explicit missing job id for %s", async (toolName) => {
  const { bb, harness, store } = fixture({ active: true });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  await expect(harness.behavior.callAgentTool(
    toolName,
    { jobId: "missing_job" },
    controllerToolContext,
  )).rejects.toMatchObject({ code: "scope_denied" });
});

it.each([
  ["telegram_agent_retry_job", "failed", "blocked"],
  ["telegram_agent_cancel_job", "awaiting_confirmation", "cancelled"],
] as const)("does not re-resolve an authorized no-id choice for %s", async (toolName, initialState, racedState) => {
  const { bb, harness, store, turn } = fixture({ active: true });
  store.releaseExecutorLease("executor", turn.leaseGeneration!, 10_000);
  queueControllerCandidate(store, "controller_job_a", "proj_a", initialState);
  queueControllerCandidate(store, "controller_job_b", "proj_b", initialState);
  const reacquired = store.acquireExecutorLease("executor", 10_100, 30_000);
  if (!reacquired.acquired) throw new Error("missing race-test lease");
  expect(store.adoptSubmittedControllerTurnFence({
    ownerId: "executor",
    generation: reacquired.generation,
    now: 10_100,
    turnId: turn.id,
  })).toBe(true);
  const listControlJobs = store.listControlJobs.bind(store);
  let raced = false;
  vi.spyOn(store, "listControlJobs").mockImplementation((kind, limit) => {
    const candidates = listControlJobs(kind, limit);
    if (!raced) {
      raced = true;
      bb.storage.database().prepare(
        "UPDATE jobs SET state = ?, version = version + 1 WHERE id = ?",
      ).run(racedState, "controller_job_b");
    }
    return candidates;
  });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  expect(parseToolJson(await harness.behavior.callAgentTool(
    toolName,
    {},
    controllerToolContext,
  ))).toEqual({
    outcome: "choose_job",
    candidates: [
      { id: "controller_job_a", projectId: "proj_a", state: initialState },
      { id: "controller_job_b", projectId: "proj_b", state: initialState },
    ],
  });
  expect(store.getJob("controller_job_a")?.state).toBe(initialState);
  expect(store.getJob("controller_job_b")?.state).toBe(racedState);
});

it.each([
  ["telegram_agent_retry_job", "failed"],
  ["telegram_agent_cancel_job", "awaiting_confirmation"],
] as const)("rejects an exact authorized job whose version races before %s", async (toolName, initialState) => {
  const { bb, harness, store, turn, activate, deactivate } = fixture({ active: true });
  deactivate();
  queueControllerCandidate(store, "controller_job_exact", "proj_exact", initialState);
  activate();
  const before = store.getJob("controller_job_exact");
  if (!before) throw new Error("exact race job was not created");
  const getJob = store.getJob.bind(store);
  let raced = false;
  vi.spyOn(store, "getJob").mockImplementation((jobId) => {
    const job = getJob(jobId);
    if (!raced && jobId === before.id) {
      raced = true;
      bb.storage.database().prepare(
        "UPDATE jobs SET version = version + 1 WHERE id = ?",
      ).run(before.id);
    }
    return job;
  });
  const notify = vi.fn();
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify,
    now: () => 10_100,
  });

  await expect(harness.behavior.callAgentTool(
    toolName,
    { jobId: before.id },
    controllerToolContext,
  )).rejects.toThrow(/version/i);
  expect(store.getJob(before.id)).toMatchObject({ state: initialState, version: before.version + 1 });
  expect(notify).not.toHaveBeenCalled();
  expect(store.listToolReceipts(turn.id)).toEqual([
    expect.objectContaining({ toolName, state: "failed" }),
  ]);
});

it("keeps job_state proof when an omitted job id resolves to none", async () => {
  const { bb, harness, store } = fixture({ active: true });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  const output = JSON.parse(await harness.behavior.callAgentTool(
    "telegram_agent_job_status",
    {},
    controllerToolContext,
  ) as string) as { _hanoonEvidence: { proofKinds: string[]; subjectRefs: string[] } };
  expect(output._hanoonEvidence).toMatchObject({ proofKinds: ["job_state"], subjectRefs: [] });
});

it("does not expose a synthetic schedule scope in interrupted evidence", async () => {
  const { bb, harness, store, turn } = fixture({ active: true });
  const params = { kind: "schedule" as const, cron: "0 9 * * 1-5", instruction: "Review the queue." };
  expect(store.claimToolReceipt({
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    toolName: "telegram_agent_watch",
    argsSha256: sha256ControllerJson(params),
    now: 10_099,
  })).toEqual({ outcome: "fresh" });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  const output = JSON.parse(await harness.behavior.callAgentTool(
    "telegram_agent_watch",
    params,
    controllerToolContext,
  ) as string) as { _hanoonEvidence: { outcome: string; proofKinds: string[]; subjectRefs: string[] } };
  expect(runtimeProjection(output._hanoonEvidence as RuntimeEvidence)).toEqual({
    outcome: "interrupted",
    proofKinds: [],
    subjectRefs: [],
  });
});

it("denies a valid enabled policy stored under a different project identity", async () => {
  const { bb, harness, store } = fixture({ active: true });
  const mismatched = policyFixture({ projectId: "proj_other", alias: "other" });
  bb.storage.database().prepare(
    "UPDATE project_policies SET policy_json = ? WHERE project_id = 'proj_1'",
  ).run(JSON.stringify(mismatched));
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  await expect(harness.behavior.callAgentTool(
    "telegram_agent_start_job",
    { projectId: "proj_1", task: "must not cross project policy identity" },
    controllerToolContext,
  )).rejects.toMatchObject({ code: "scope_denied" });
});

it("reads what a thread is doing so slowness can be explained rather than deflected", async () => {
  const { bb, harness, store } = fixture({ active: true });
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
  const { bb, harness, store } = fixture({ active: true });
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
    ...visibleThread(threadId === "thr_hidden"
      ? { id: "thr_hidden", visibility: "hidden" }
      : { id: threadId }),
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
  )).rejects.toThrow(/scope|not visible/i);
});

it("uses the authorized project host once and interrupts replay after cross-project projection failure", async () => {
  const { bb, harness, store } = fixture({ active: true });
  let projectReads = 0;
  harness.sdk.stub("projects.list", async () => {
    projectReads += 1;
    return [{
      id: "proj_1",
      kind: "software" as const,
      name: "Cyndra",
      gitRemoteUrl: null,
      createdAt: 1,
      updatedAt: 1,
      sources: [{
        id: "src_1",
        projectId: "proj_1",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
        type: "local_path" as const,
        hostId: projectReads === 1 ? "host_authorized" : "host_changed",
        path: "/repo",
      }],
    }];
  });
  const spawn = vi.fn(async () => ({ id: "thr_cross_project", environmentId: "env_other" }));
  harness.sdk.stub("threads.spawn", spawn);
  harness.sdk.stub("threads.get", async () => ({
    ...visibleThread({ id: "thr_cross_project", projectId: "proj_other" }),
    canSpawnChild: true,
  }));
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  await expect(harness.behavior.callAgentTool(
    "telegram_agent_create_thread",
    { projectId: "proj_1", title: "Inspect", prompt: "Inspect only" },
    controllerToolContext,
  )).rejects.toMatchObject({ code: "evidence_projection_invalid" });
  expect(projectReads).toBe(1);
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
    projectId: "proj_1",
    environment: expect.objectContaining({ type: "host", hostId: "host_authorized" }),
  }));
  const replay = JSON.parse(await harness.behavior.callAgentTool(
    "telegram_agent_create_thread",
    { projectId: "proj_1", title: "Inspect", prompt: "Inspect only" },
    controllerToolContext,
  ) as string) as { _hanoonEvidence: { outcome: string; proofKinds: string[]; subjectRefs: string[] } };
  expect(runtimeProjection(replay._hanoonEvidence as RuntimeEvidence)).toEqual({
    outcome: "interrupted",
    proofKinds: [],
    subjectRefs: ["project:proj_1"],
  });
  expect(spawn).toHaveBeenCalledOnce();
  expect(projectReads).toBe(2);
});

it("does not promote a thread operation for a different thread, kind, or owner binding", async () => {
  const { bb, harness, store } = fixture({ active: true });
  harness.sdk.stub("threads.get", async () => ({ ...visibleThread({ id: "thr_active" }), canSpawnChild: true }));
  const crossOperation = store.createThreadOperation({
    id: "operation_cross",
    nonceHash: "a".repeat(64),
    ownerUserId: "7",
    ownerChatId: "7",
    kind: "stop_thread",
    threadId: "thr_other",
    text: null,
    expiresAt: 20_000,
    now: 9_000,
  });
  const awaiting = store.markThreadOperationConfirmationSent(crossOperation.id, 77, 9_001);
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn(async () => awaiting) },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  await expect(harness.behavior.callAgentTool(
    "telegram_agent_request_thread_operation",
    { kind: "retry_thread", threadId: "thr_active" },
    controllerToolContext,
  )).rejects.toMatchObject({ code: "evidence_projection_invalid" });
});

it("rejects replayed strong proof for a memory outside the authorized scope", async () => {
  const { bb, harness, store, turn } = fixture({ active: true });
  const memory = store.rememberMemory({
    scope: "proj_other",
    kind: "fact",
    subject: "foreign memory",
    body: "belongs elsewhere",
    source: "agent",
    now: 9_000,
  });
  const params = {
    subject: "local memory",
    body: "must stay local",
    kind: "fact" as const,
    projectId: "proj_1",
  };
  const key = {
    turnId: turn.id,
    toolName: "telegram_agent_remember" as const,
    argsSha256: sha256ControllerJson(params),
  };
  expect(store.claimToolReceipt({ ...key, controllerKey: turn.controllerKey, now: 9_100 })).toEqual({ outcome: "fresh" });
  store.completeToolReceipt({
    ...key,
    result: canonicalControllerJson({ remembered: { id: memory.id, subject: memory.subject, scope: memory.scope } }),
    now: 9_101,
  });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  await expect(harness.behavior.callAgentTool(
    "telegram_agent_remember",
    params,
    controllerToolContext,
  )).rejects.toMatchObject({ code: "evidence_projection_invalid" });
});

it("rejects replayed job proof for an entity outside the authorized project", async () => {
  const { bb, harness, store, turn, activate, deactivate } = fixture({ active: true });
  deactivate();
  queueControllerCandidate(store, "controller_job_foreign", "proj_other", "failed");
  activate();
  const params = { projectId: "proj_1", task: "create the local job" };
  const key = {
    turnId: turn.id,
    toolName: "telegram_agent_start_job" as const,
    argsSha256: sha256ControllerJson(params),
  };
  expect(store.claimToolReceipt({ ...key, controllerKey: turn.controllerKey, now: 10_099 })).toEqual({ outcome: "fresh" });
  store.completeToolReceipt({
    ...key,
    result: canonicalControllerJson({ job: { id: "controller_job_foreign" } }),
    now: 10_099,
  });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  await expect(harness.behavior.callAgentTool(
    "telegram_agent_start_job",
    params,
    controllerToolContext,
  )).rejects.toMatchObject({ code: "evidence_projection_invalid" });
});

it("rejects replayed monitor proof for a different requested watch", async () => {
  const { bb, harness, store, turn } = fixture({ active: true });
  const existing = store.createMonitor({
    controllerKey: turn.controllerKey,
    kind: "schedule",
    cron: "0 8 * * *",
    instruction: "Existing instruction",
    dueAt: 20_000,
    now: 9_000,
  });
  const params = { kind: "schedule" as const, cron: "0 9 * * *", instruction: "New instruction" };
  const key = {
    turnId: turn.id,
    toolName: "telegram_agent_watch" as const,
    argsSha256: sha256ControllerJson(params),
  };
  expect(store.claimToolReceipt({ ...key, controllerKey: turn.controllerKey, now: 9_100 })).toEqual({ outcome: "fresh" });
  store.completeToolReceipt({
    ...key,
    result: canonicalControllerJson({ watching: { id: existing.id } }),
    now: 9_101,
  });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  await expect(harness.behavior.callAgentTool(
    "telegram_agent_watch",
    params,
    controllerToolContext,
  )).rejects.toMatchObject({ code: "evidence_projection_invalid" });
});

it("scans every returned watch for obligations while capping only subject refs", async () => {
  const { bb, harness, store, turn } = fixture({ active: true });
  const monitorIds: string[] = [];
  for (let index = 0; index < 17; index += 1) {
    const monitor = store.createMonitor({
      controllerKey: turn.controllerKey,
      kind: "schedule",
      cron: `0 ${String(index % 24)} * * *`,
      instruction: `Monitor ${String(index)}`,
      dueAt: 20_000 + index,
      now: 9_000 + index,
    });
    monitorIds.push(monitor.id);
    if (index > 0) expect(store.cancelControllerMonitor(turn.controllerKey, monitor.id, 9_100 + index)).toBe(true);
  }
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  const output = JSON.parse(await harness.behavior.callAgentTool(
    "telegram_agent_list_watches",
    { includeFinished: true },
    controllerToolContext,
  ) as string) as { _hanoonEvidence: { proofKinds: string[]; subjectRefs: string[] } };
  expect(output._hanoonEvidence.proofKinds).toEqual(["monitor_state", "obligation"]);
  const returnedOrder = store.listMonitors(turn.controllerKey, true).map((monitor) => monitor.id);
  expect(returnedOrder.at(-1)).toBe(monitorIds[0]);
  expect(output._hanoonEvidence.subjectRefs).toEqual(returnedOrder.slice(0, 16).map((id) => `monitor:${id}`));
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
  const { bb, harness, store } = fixture({ active: true });
  for (const projectId of ["proj_a", "proj_b"]) {
    store.upsertProjectPolicy(policyFixture({ projectId, alias: projectId.replace("_", "-") }), 10_000);
  }
  const spawned: string[] = [];
  harness.sdk.stub("projects.list", async () => delegationProjects());
  harness.sdk.stub("threads.spawn", async ({ title }: { title: string }) => {
    spawned.push(title);
    return { id: `thr_${spawned.length}`, environmentId: "env_worker" };
  });
  harness.sdk.stub("threads.get", async ({ threadId }) => ({
    ...visibleThread({ id: threadId, projectId: threadId === "thr_1" ? "proj_a" : "proj_b" }),
    canSpawnChild: true,
  }));
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

it("rejects delegation proof when a joined BB thread belongs to another project", async () => {
  const { bb, harness, store } = fixture({ active: true });
  store.upsertProjectPolicy(policyFixture({ projectId: "proj_a", alias: "proj-a" }), 10_000);
  harness.sdk.stub("projects.list", async () => delegationProjects().slice(0, 1));
  harness.sdk.stub("threads.spawn", async () => ({ id: "thr_cross_delegate", environmentId: "env_other" }));
  harness.sdk.stub("threads.get", async () => ({
    ...visibleThread({ id: "thr_cross_delegate", projectId: "proj_other" }),
    canSpawnChild: true,
  }));
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  await expect(harness.behavior.callAgentTool("telegram_agent_delegate", {
    instruction: "report back",
    tasks: [{ projectId: "proj_a", title: "inspect", prompt: "inspect" }],
  }, controllerToolContext)).rejects.toMatchObject({ code: "evidence_projection_invalid" });
});

it("keeps the threads that did start when a later spawn fails", async () => {
  const { bb, harness, store } = fixture({ active: true });
  for (const projectId of ["proj_a", "proj_b"]) {
    store.upsertProjectPolicy(policyFixture({ projectId, alias: projectId.replace("_", "-") }), 10_000);
  }
  let spawnCount = 0;
  harness.sdk.stub("projects.list", async () => delegationProjects());
  harness.sdk.stub("threads.spawn", async () => {
    spawnCount += 1;
    if (spawnCount === 2) throw new Error("BB refused the second spawn");
    return { id: `thr_${spawnCount}`, environmentId: "env_worker" };
  });
  harness.sdk.stub("threads.get", async ({ threadId }) => ({
    ...visibleThread({ id: threadId, projectId: "proj_a" }),
    canSpawnChild: true,
  }));
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
  const { bb, harness, store } = fixture({ active: true });
  store.upsertProjectPolicy(policyFixture({ projectId: "proj_a", alias: "proj-a" }), 10_000);
  harness.sdk.stub("projects.list", async () => delegationProjects().slice(0, 1));
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
  }, { threadId: "thr_unrelated", projectId: "proj_personal" })).rejects.toThrow(/identity|not authorized/);
  expect(store.listOpenDelegations(10)).toEqual([]);
});

it("tells the agent a confirmed job is queued rather than waiting on the owner", async () => {
  const { bb, harness, store } = fixture({ active: true });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });
  // The path the agent itself uses: creation already confirms and queues it.
  const created = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_start_job",
    { projectId: "proj_1", task: "fix the guardian import" },
    controllerToolContext,
  )) as { job: { id: string; state: string; queue: string | null; awaitingOwner: boolean } };

  expect(created.job.state).toBe("awaiting_confirmation");
  // The state name alone reads as "the owner must tap approve" — which is false
  // here, and is exactly what made the agent promise a button that never came.
  expect(created.job.queue).toBe("queued");
  expect(created.job.awaitingOwner).toBe(false);

  const status = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_job_status",
    { jobId: created.job.id },
    controllerToolContext,
  )) as { job: { queue: string | null; awaitingOwner: boolean } };

  expect(status.job).toMatchObject({ queue: "queued", awaitingOwner: false });
});

type EvidenceIndex = Readonly<{
  turnId: string;
  evidenceLimitExceeded: boolean;
  reconciliationIncomplete: null | "page_cap" | "source_gap";
  truncated: boolean;
  nextEvidenceId: number | null;
  evidence: Array<{
    ref: `evidence:${number}`;
    source: string;
    outcome: string;
    proofKinds: string[];
    subjectRefs: string[];
    observedAt: number;
  }>;
}>;

function evidenceIndex(value: unknown): EvidenceIndex {
  if (typeof value !== "string") throw new Error("evidence index did not return canonical JSON text");
  return JSON.parse(value) as EvidenceIndex;
}

function activeControllerTrustState(store: TelegramAgentStore) {
  const controller = store.getControllerByThreadId("thr_controller");
  if (!controller?.threadId || !controller.projectId || !controller.hostId) {
    throw new Error("active controller is missing its BB identity");
  }
  const turn = store.getPendingControllerTurn(controller.controllerKey);
  if (!turn || turn.state !== "submitted" || !turn.leaseOwner || turn.leaseGeneration === null) {
    throw new Error("active controller is missing its submitted turn fence");
  }
  return {
    controller,
    turn,
    fence: { ownerId: turn.leaseOwner, generation: turn.leaseGeneration, now: 10_100 },
  };
}

function stubControllerEvidenceSdk(
  harness: ReturnType<typeof fixture>["harness"],
  rows: readonly Record<string, unknown>[] = [],
  maxSeq = rows.reduce((maximum, row) => Math.max(maximum, Number(row.seq)), 0),
): void {
  harness.sdk.stub("threads.get", async () => ({
    id: "thr_controller",
    projectId: "proj_personal",
    environmentId: "env_personal",
  }));
  harness.sdk.stub("environments.get", async () => ({
    id: "env_personal",
    projectId: "proj_personal",
    hostId: "host_personal",
    path: "/private/controller-root",
    status: "ready",
    workspaceProvisionType: "personal",
  }));
  harness.sdk.stub("threads.timeline", async () => ({ maxSeq }));
  harness.sdk.stub("threads.events.list", async ({ afterSeq = "0", limit = "100" }) => rows
    .filter((row) => Number(row.seq) > Number(afterSeq))
    .slice(0, Number(limit)));
}

function controllerProjector(value: ReturnType<typeof fixture>): ControllerEvidenceProjector {
  return new ControllerEvidenceProjector({
    sdk: value.bb.sdk,
    store: value.store,
    clock: { now: () => 10_100 },
    hanoonToolNames: CONTROLLER_TOOL_NAMES,
  });
}

function registerEvidenceTools(
  value: ReturnType<typeof fixture>,
  evidenceProjector: Pick<ControllerEvidenceProjector, "reconcile">,
  maxSeq = 0,
): void {
  value.harness.sdk.stub("threads.timeline", async () => ({ maxSeq }));
  registerControllerTools(value.bb, {
    store: value.store,
    sdk: value.bb.sdk,
    evidenceProjector,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });
}

function plainFinalization(text = "Here is the requested answer.") {
  return {
    disposition: "answered",
    segments: [{ type: "text", text }],
    obligationRefs: [],
  };
}

it("routes malformed finalizer input through durable validation without storing unsafe text", async () => {
  const value = fixture({ active: true });
  const reconcile = vi.fn(async () => ({
    outcome: "reconciled" as const,
    reconciliationIncomplete: null,
    fromSeq: 0,
    throughSeq: 0,
    targetSeq: 0,
  }));
  registerEvidenceTools(value, { reconcile });

  const response = JSON.parse(await value.harness.behavior.callAgentTool(
    "telegram_agent_respond",
    { unsafe: "password=DO_NOT_STORE_FINALIZER_SECRET" },
    controllerToolContext,
  ) as string);

  expect(response).toMatchObject({ outcome: "rejected", revision: 1, code: "invalid_contract" });
  expect(reconcile).toHaveBeenCalledOnce();
  const stored = value.bb.storage.database().prepare(
    "SELECT payload_json FROM controller_finalizations WHERE turn_id = ?",
  ).get(value.turn.id) as { payload_json: string };
  expect(stored.payload_json).not.toContain("DO_NOT_STORE_FINALIZER_SECRET");
});

it("accepts through the special finalizer and makes retries projector-free", async () => {
  const value = fixture({ active: true });
  const reconcile = vi.fn(async () => ({
    outcome: "reconciled" as const,
    reconciliationIncomplete: null,
    fromSeq: 0,
    throughSeq: 0,
    targetSeq: 0,
  }));
  registerEvidenceTools(value, { reconcile });

  expect(JSON.parse(await value.harness.behavior.callAgentTool(
    "telegram_agent_respond",
    plainFinalization("Answer 😀"),
    controllerToolContext,
  ) as string)).toEqual({ outcome: "accepted", ref: "finalization:1", renderedCharacters: 8 });
  expect(reconcile).toHaveBeenCalledOnce();

  expect(JSON.parse(await value.harness.behavior.callAgentTool(
    "telegram_agent_respond",
    plainFinalization("Changed"),
    controllerToolContext,
  ) as string)).toMatchObject({ outcome: "rejected", code: "accepted_already" });
  expect(reconcile).toHaveBeenCalledOnce();
  await expect(value.harness.behavior.callAgentTool(
    "telegram_agent_list_projects",
    {},
    controllerToolContext,
  )).rejects.toThrow(/turn_finalized/);
  expect(value.store.listControllerEvidence(value.turn.id, 128)).toEqual([]);
});

it("fails closed when the evidence projector misses the fixed native high-water", async () => {
  const value = fixture({ active: true });
  registerEvidenceTools(value, { reconcile: vi.fn(async () => ({
    outcome: "reconciled" as const,
    reconciliationIncomplete: null,
    fromSeq: 0,
    throughSeq: 0,
    targetSeq: 0,
  })) }, 1);

  await expect(value.harness.behavior.callAgentTool(
    "telegram_agent_turn_evidence",
    {},
    controllerToolContext,
  )).rejects.toThrow(/fence_lost|turn_missing/);
});

it.each(["page_cap", "source_gap"] as const)(
  "does not consume a revision when finalizer reconciliation ends at %s",
  async (reconciliationIncomplete) => {
    const value = fixture({ active: true });
    registerEvidenceTools(value, { reconcile: vi.fn(async () => ({
      outcome: "reconciled" as const,
      reconciliationIncomplete,
      fromSeq: 0,
      throughSeq: 0,
      targetSeq: 1,
    })) }, 1);

    await expect(value.harness.behavior.callAgentTool(
      "telegram_agent_respond",
      plainFinalization(),
      controllerToolContext,
    )).rejects.toThrow(new RegExp(reconciliationIncomplete));
    expect(value.bb.storage.database().prepare(
      "SELECT COUNT(*) AS count FROM controller_finalizations WHERE turn_id = ?",
    ).get(value.turn.id)).toEqual({ count: 0 });
  },
);

it("does not consume a revision when reconciliation throws", async () => {
  const value = fixture({ active: true });
  registerEvidenceTools(value, { reconcile: vi.fn(async () => {
    throw new Error("projector failed closed");
  }) });

  await expect(value.harness.behavior.callAgentTool(
    "telegram_agent_respond",
    plainFinalization(),
    controllerToolContext,
  )).rejects.toThrow(/projector failed closed/);
  expect(value.bb.storage.database().prepare(
    "SELECT COUNT(*) AS count FROM controller_finalizations WHERE turn_id = ?",
  ).get(value.turn.id)).toEqual({ count: 0 });
});

it("does not consume a revision when the executor fence is lost during reconciliation", async () => {
  const value = fixture({ active: true });
  registerEvidenceTools(value, { reconcile: vi.fn(async () => {
    value.deactivate();
    return {
      outcome: "reconciled" as const,
      reconciliationIncomplete: null,
      fromSeq: 0,
      throughSeq: 0,
      targetSeq: 0,
    };
  }) });

  await expect(value.harness.behavior.callAgentTool(
    "telegram_agent_respond",
    plainFinalization(),
    controllerToolContext,
  )).rejects.toThrow(/fence_lost/);
  expect(value.bb.storage.database().prepare(
    "SELECT COUNT(*) AS count FROM controller_finalizations WHERE turn_id = ?",
  ).get(value.turn.id)).toEqual({ count: 0 });
});

it("persists the evidence-limit rejection after limit-exceeded reconciliation", async () => {
  const value = fixture({ active: true });
  value.bb.storage.database().prepare(
    "UPDATE controller_turns SET evidence_limit_exceeded_at = ? WHERE id = ?",
  ).run(10_100, value.turn.id);
  registerEvidenceTools(value, { reconcile: vi.fn(async () => ({
      outcome: "limit_exceeded" as const,
      reconciliationIncomplete: null,
      fromSeq: 0,
      throughSeq: 0,
      targetSeq: 1,
    })) }, 1);

  expect(JSON.parse(await value.harness.behavior.callAgentTool(
    "telegram_agent_respond",
    plainFinalization(),
    controllerToolContext,
  ) as string)).toMatchObject({
    outcome: "rejected",
    revision: 1,
    code: "evidence_limit_exceeded",
  });
});

function recordIndexEvidence(
  store: TelegramAgentStore,
  turn: ReturnType<typeof activeControllerTrustState>["turn"],
  fence: ReturnType<typeof activeControllerTrustState>["fence"],
  index: number,
  subjectRefs: readonly string[],
): void {
  const written = store.recordControllerEvidence({
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    sourceKind: "hanoon_tool",
    sourceName: `seed_${index}`,
    sourceItemId: null,
    outcome: "observed",
    argsSha256: index.toString(16).padStart(64, "0"),
    resultSha256: (index + 1).toString(16).padStart(64, "0"),
    proofKinds: ["project_state"],
    subjectRefs,
    ...fence,
  });
  expect(written.outcome).toBe("recorded");
}

it("authorizes, reconciles before listing, and uses the injected projector without self-evidence", async () => {
  const value = fixture({ active: true });
  const trust = activeControllerTrustState(value.store);
  const reconcile = vi.fn(async (
    controller: typeof trust.controller,
    turn: typeof trust.turn,
    fence: typeof trust.fence,
    _signal: AbortSignal,
  ) => {
    expect(controller).toEqual(trust.controller);
    expect(turn).toEqual(trust.turn);
    recordIndexEvidence(value.store, turn, fence, 1, ["project:proj_1"]);
    return {
      outcome: "reconciled" as const,
      reconciliationIncomplete: "page_cap" as const,
      fromSeq: 0,
      throughSeq: 0,
      targetSeq: 1,
    };
  });
  registerEvidenceTools(value, { reconcile }, 1);
  const signal = new AbortController().signal;

  const listed = evidenceIndex(await value.harness.behavior.callAgentTool(
    "telegram_agent_turn_evidence",
    {},
    { ...controllerToolContext, signal },
  ));

  expect(reconcile).toHaveBeenCalledOnce();
  expect(reconcile.mock.calls[0]?.[3]).toBe(signal);
  expect(listed).toMatchObject({
    turnId: trust.turn.id,
    evidenceLimitExceeded: false,
    reconciliationIncomplete: "page_cap",
    truncated: false,
    nextEvidenceId: null,
    evidence: [{ source: "seed_1", subjectRefs: ["project:proj_1"] }],
  });
  expect(value.store.listControllerEvidence(trust.turn.id, 128).map((row) => row.sourceName))
    .toEqual(["seed_1"]);

  await expect(value.harness.behavior.callAgentTool(
    "telegram_agent_turn_evidence",
    {},
    { threadId: "thr_unrelated", projectId: "proj_personal" },
  )).rejects.toThrow(/identity|authorized/i);
  expect(reconcile).toHaveBeenCalledOnce();
});

it("reconciles a Hanoon native tool item without recording it a second time", async () => {
  const value = fixture({ active: true });
  const row = {
    id: "event_1",
    scope: { kind: "thread" },
    threadId: "thr_controller",
    seq: 1,
    createdAt: 10_050,
    type: "item/completed",
    data: {
      providerThreadId: "provider_thread",
      item: {
        type: "toolCall",
        id: "hanoon_item",
        tool: "telegram_agent_turn_evidence",
        status: "completed",
        result: { secret: "must-not-be-evidence" },
      },
    },
  };
  stubControllerEvidenceSdk(value.harness, [row]);
  registerEvidenceTools(value, controllerProjector(value), 1);

  const listed = evidenceIndex(await value.harness.behavior.callAgentTool(
    "telegram_agent_turn_evidence",
    {},
    controllerToolContext,
  ));

  expect(listed.evidence).toEqual([]);
  expect(value.store.listControllerEvidence(listed.turnId, 128)).toEqual([]);
  expect(value.store.getControllerTurn(listed.turnId)?.evidenceEventSeq).toBe(1);
});

it("paginates the largest complete canonical prefix under 8,000 UTF-8 bytes", async () => {
  const value = fixture({ active: true });
  const trust = activeControllerTrustState(value.store);
  stubControllerEvidenceSdk(value.harness);
  registerEvidenceTools(value, controllerProjector(value));
  for (let index = 1; index <= 20; index += 1) {
    recordIndexEvidence(value.store, trust.turn, trust.fence, index, [
      `project:${index}:${"é".repeat(230)}`,
    ]);
  }

  const firstRaw = await value.harness.behavior.callAgentTool(
    "telegram_agent_turn_evidence",
    {},
    controllerToolContext,
  );
  const first = evidenceIndex(firstRaw);
  expect(Buffer.byteLength(firstRaw as string, "utf8")).toBeLessThanOrEqual(8_000);
  expect(first).toMatchObject({ truncated: true });
  expect(first.nextEvidenceId).toBe(first.evidence.at(-1)?.ref === undefined
    ? null
    : Number(first.evidence.at(-1)!.ref.slice("evidence:".length)));

  const secondRaw = await value.harness.behavior.callAgentTool(
    "telegram_agent_turn_evidence",
    { afterEvidenceId: first.nextEvidenceId },
    controllerToolContext,
  );
  const second = evidenceIndex(secondRaw);
  expect(Buffer.byteLength(secondRaw as string, "utf8")).toBeLessThanOrEqual(8_000);
  expect(second.truncated).toBe(false);
  expect([...first.evidence, ...second.evidence].map((row) => row.ref))
    .toEqual(value.store.listControllerEvidence(trust.turn.id, 128).map((row) => row.ref));

  const firstUnreturned = second.evidence[0];
  if (!firstUnreturned) throw new Error("pagination fixture did not produce a second page");
  const expanded = canonicalControllerJson({
    ...first,
    evidence: [...first.evidence, firstUnreturned],
    truncated: true,
    nextEvidenceId: Number(firstUnreturned.ref.slice("evidence:".length)),
  });
  expect(Buffer.byteLength(expanded, "utf8")).toBeGreaterThan(8_000);
});

it("fails closed when one complete valid evidence descriptor cannot fit", async () => {
  const value = fixture({ active: true });
  const trust = activeControllerTrustState(value.store);
  stubControllerEvidenceSdk(value.harness);
  registerEvidenceTools(value, controllerProjector(value));
  recordIndexEvidence(
    value.store,
    trust.turn,
    trust.fence,
    1,
    Array.from({ length: 16 }, (_, index) => `project:${index}:${"😀".repeat(120)}`),
  );

  await expect(value.harness.behavior.callAgentTool(
    "telegram_agent_turn_evidence",
    {},
    controllerToolContext,
  )).rejects.toThrow(/8,000|8000|fit|limit/i);
});

it("reports source-gap reconciliation and the durable evidence cap without claiming catch-up", async () => {
  const sourceGap = fixture({ active: true });
  stubControllerEvidenceSdk(sourceGap.harness, [], 1);
  registerEvidenceTools(sourceGap, controllerProjector(sourceGap), 1);
  expect(evidenceIndex(await sourceGap.harness.behavior.callAgentTool(
    "telegram_agent_turn_evidence",
    {},
    controllerToolContext,
  ))).toMatchObject({
    reconciliationIncomplete: "source_gap",
    evidenceLimitExceeded: false,
  });

  const capped = fixture({ active: true });
  const trust = activeControllerTrustState(capped.store);
  for (let index = 1; index <= 128; index += 1) {
    recordIndexEvidence(capped.store, trust.turn, trust.fence, index, [`project:proj_${index}`]);
  }
  expect(capped.store.recordControllerEvidence({
    turnId: trust.turn.id,
    controllerKey: trust.turn.controllerKey,
    sourceKind: "hanoon_tool",
    sourceName: "over_cap",
    sourceItemId: null,
    outcome: "observed",
    argsSha256: "e".repeat(64),
    resultSha256: "f".repeat(64),
    proofKinds: [],
    subjectRefs: [],
    ...trust.fence,
  })).toEqual({ outcome: "limit_exceeded" });
  registerEvidenceTools(capped, controllerProjector(capped));
  expect(evidenceIndex(await capped.harness.behavior.callAgentTool(
    "telegram_agent_turn_evidence",
    {},
    controllerToolContext,
  ))).toMatchObject({
    evidenceLimitExceeded: true,
    reconciliationIncomplete: null,
    truncated: true,
  });
  expect(capped.harness.inspection.sdk.callsTo("threads.timeline")).toHaveLength(1);
});

it("rejects unknown evidence-index parameters before authorization or reconciliation", async () => {
  const value = fixture({ active: true });
  const reconcile = vi.fn();
  registerEvidenceTools(value, { reconcile });

  await expect(value.harness.behavior.callAgentTool(
    "telegram_agent_turn_evidence",
    { unexpected: true },
    controllerToolContext,
  )).rejects.toThrow(/invalid|unrecognized|parameter/i);
  expect(reconcile).not.toHaveBeenCalled();
});
