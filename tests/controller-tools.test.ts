import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { policyFixture } from "./helpers";
import { ActiveJobConflictError, openStore } from "../src/storage/store";
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

let fixtureNumber = 0;
function fixture() {
  const { bb, harness } = createFakePluginHost({ pluginId: `telegram-controller-tools-${fixtureNumber++}` });
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
  return { bb, harness, store, turn };
}

it("atomically creates one confirmed controller job through the existing state machine", () => {
  const { store } = fixture();

  const job = store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller",
    projectId: "proj_1",
    task: "Fix the redirect and add a regression test",
    now: 10_000,
  });

  expect(job).toMatchObject({ state: "planning", projectId: "proj_1", policyVersion: 1 });
  expect(store.listEffectsForJob(job.id).map((effect) => effect.kind)).toEqual([
    "render_status",
    "spawn_plan",
  ]);
  expect(store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller",
    projectId: "proj_1",
    task: "Fix the redirect and add a regression test",
    now: 10_001,
  })).toEqual(job);
});

it("rejects unmapped controllers, disabled projects, and a second active job without partial writes", () => {
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

  store.createJob({ id: "existing", sourceUpdateId: 900, requestText: "existing", now: 10_000 });
  expect(() => store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller",
    projectId: "proj_1",
    task: "new work",
    now: 10_000,
  })).toThrow(ActiveJobConflictError);
  expect(bb.storage.database().prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 1 });
  expect(bb.storage.database().prepare("SELECT COUNT(*) AS count FROM effects").get()).toEqual({ count: 0 });
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
  expect(started).toContain("planning");
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
