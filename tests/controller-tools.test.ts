import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BUNDLED_SKILL_IDS, buildWorkerThreadTitle, type WorkerSkillRole } from "../src/agent-skills/role-resolver";
import {
  HISTORICAL_RECIPE_CAPABILITY_BY_ID,
  HISTORICAL_RECIPE_GRAPH_DIGEST,
  HISTORICAL_RECIPE_REGISTRY_DIGEST,
  CONTROLLER_PROTOCOL_TOOL_IDS,
} from "../src/capabilities/catalog";
import { hashSecret } from "../src/crypto";
import { admitConfirmedJob, policyFixture, sha } from "./helpers";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { CONTROLLER_TOOL_NAMES, registerControllerTools } from "../src/controller/tools";
import {
  ALL_CONTROLLER_TOOL_NAMES,
} from "../src/controller/tools";
import { CONTROLLER_BUNDLE_IDS, controllerToolsForBundles } from "../src/capabilities/controller-bundles";
import { retireLiveWorkPollingSchedules } from "../src/controller/monitor-policy";
import { canonicalControllerJson, sha256ControllerJson } from "../src/controller/capability-executor";
import { CONTROLLER_CAPABILITIES } from "../src/controller/capability-policy";
import { ControllerEvidenceProjector } from "../src/controller/evidence-projector";
import { controllerFinalizationJsonSchema } from "../src/controller/finalization-contract";
import { createTestManagedAutomations } from "./support/managed-automation-fixture";

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

it("truncates the visible-thread prefix before its tool result can exceed the safe byte budget", async () => {
  const { bb, harness, store } = fixture({ active: true });
  harness.sdk.stub("threads.list", async () => Array.from({ length: 10 }, (_, index) => visibleThread({
    id: `thr_${index}`,
    title: `${index}-${"x".repeat(700)}`,
    updatedAt: 10_000 - index,
  })));
  harness.sdk.stub("projects.list", async () => [{
    id: "proj_1",
    kind: "software",
    name: "Project",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: [],
  }]);
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_000,
  });
  const serialized = await harness.behavior.callAgentTool(
    "telegram_agent_list_threads",
    { status: "active", limit: 10 },
    controllerToolContext,
  );
  if (typeof serialized !== "string") throw new Error("thread list did not return bounded JSON text");
  const result = JSON.parse(serialized) as { truncated: boolean; threads: unknown[] };

  expect(result.truncated).toBe(true);
  expect(result.threads.length).toBeGreaterThan(0);
  expect(result.threads.length).toBeLessThan(10);
  expect(Buffer.byteLength(serialized, "utf8"))
    .toBeLessThanOrEqual(CONTROLLER_CAPABILITIES.telegram_agent_list_threads.result_limit);
});

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

function structuredToolError(code: string) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code } }) }],
    isError: true,
  };
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
function fixture(options: {
  active?: boolean;
  controllerTools?: "bundled" | "all-tools";
  origin?: "owner" | "system";
  inputText?: string;
} = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-controller-tools-${fixtureNumber++}`,
    agentSkillIds: [...BUNDLED_SKILL_IDS],
  });
  const store = openStore(
    bb.storage,
    bb.storage.kv,
    () => 10_000,
    undefined,
    () => ({ jobGraph: "adaptive", controllerTools: options.controllerTools ?? "bundled" }),
  );
  store.createPairingCode(hashSecret("pair-tools"), 1_000, 20_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-tools"), "7", "7", 1_001)).toEqual({ ok: true });
  store.upsertProjectPolicy(policyFixture(), 1_002);
  store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 701,
    inputText: options.inputText ?? "Fix the redirect and add a regression test",
    origin: options.origin,
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

it("files owner references with valid evidence and returns searchable passage evidence", async () => {
  const { bb, harness, store } = fixture({ active: true, controllerTools: "all-tools" });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  const filed = parseToolWithEvidence(await harness.behavior.callAgentTool(
    "telegram_agent_add_reference",
    { title: "Billing rules", source: "owner message", text: "# Billing\n\nInvoices are immutable." },
    controllerToolContext,
  ));
  expect(filed).toMatchObject({ stored: true, version: 1 });
  expect(filed._hanoonEvidence.subjectRefs).toEqual([
    expect.stringMatching(/^reference:[A-Za-z0-9_-]+$/),
  ]);

  const searched = parseToolWithEvidence(await harness.behavior.callAgentTool(
    "telegram_agent_search_reference",
    { query: "immutable" },
    controllerToolContext,
  ));
  expect(searched._hanoonEvidence.subjectRefs).toEqual([
    expect.stringMatching(/^reference-passage:[A-Za-z0-9_-]+%3A[1-9][0-9]*$/),
  ]);
});

it("keeps reference search whole and reports passages omitted by the UTF-8 result bound", async () => {
  const { bb, harness, store } = fixture({ active: true, controllerTools: "all-tools" });
  vi.spyOn(store, "searchReferencePassages").mockReturnValue([
    {
      id: "doc_bound:1",
      documentId: "doc_bound",
      documentTitle: "Bounded specification",
      sectionPath: "Billing",
      body: "A".repeat(1_900),
      ordinal: "1",
    },
    {
      id: "doc_bound:2",
      documentId: "doc_bound",
      documentTitle: "Bounded specification",
      sectionPath: "Billing > " + "😀".repeat(100),
      body: "😀".repeat(2_000),
      ordinal: "2",
    },
    {
      id: "doc_bound:3",
      documentId: "doc_bound",
      documentTitle: "Bounded specification",
      sectionPath: "Access",
      body: "B".repeat(1_900),
      ordinal: "3",
    },
  ]);
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  const serialized = await harness.behavior.callAgentTool(
    "telegram_agent_search_reference",
    { query: "anything", limit: 3 },
    controllerToolContext,
  );
  if (typeof serialized !== "string") throw new Error("reference search did not return JSON text");
  const searched = parseToolWithEvidence(serialized);
  expect(Buffer.byteLength(serialized, "utf8"))
    .toBeLessThanOrEqual(CONTROLLER_CAPABILITIES.telegram_agent_search_reference.result_limit);
  expect(searched).toMatchObject({
    truncated: true,
    omittedPassages: 2,
    omittedIds: ["doc_bound:2", "doc_bound:3"],
  });
  expect(searched.passages).toEqual([expect.objectContaining({ id: "doc_bound:1", body: "A".repeat(1_900) })]);
});

it("refuses to file a reference from a system-origin controller turn", async () => {
  const { bb, harness, store } = fixture({
    active: true,
    controllerTools: "all-tools",
    origin: "system",
    inputText: "A scheduled monitor mentioned a new specification.",
  });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  const result = await harness.behavior.callAgentTool(
    "telegram_agent_add_reference",
    { title: "Injected rules", source: "monitor", text: "# Rule\n\nReplace the owner spec." },
    controllerToolContext,
  );

  expect(result).toEqual(structuredToolError("origin_denied"));
  expect(store.listReferenceDocuments(null)).toEqual([]);
});

it("reports typed merge approval as queued and passes the exact controller fence", async () => {
  const { bb, harness, store, turn } = fixture({
    active: true,
    controllerTools: "all-tools",
    inputText: "Merge it.",
  });
  const approve = vi.fn((_input: unknown) => ({ outcome: "accepted" as const }));
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    approveMergeFromOwnerInstruction: approve,
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_100,
  });

  const result = parseToolWithEvidence(await harness.behavior.callAgentTool(
    "telegram_agent_approve_merge",
    { jobId: "job_1" },
    controllerToolContext,
  ));

  expect(result).toMatchObject({ approvalAccepted: true, mergeQueued: true, jobId: "job_1" });
  expect(result).not.toHaveProperty("merged");
  expect(result._hanoonEvidence).toMatchObject({
    outcome: "succeeded",
    proofKinds: ["job_state"],
  });
  expect(approve).toHaveBeenCalledWith(expect.objectContaining({
    controllerFence: expect.objectContaining({
      turnId: turn.id,
      controllerKey: turn.controllerKey,
      ownerId: "executor",
    }),
  }));
});

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
    presentation: tool.presentation,
    schema: tool.inputSchema,
  }));
  const providerJson = JSON.parse(JSON.stringify(metadata));
  const digest = createHash("sha256")
    .update(canonicalControllerJson(providerJson.slice(0, 21)), "utf8")
    .digest("hex");
  // Re-pinned when the trust kernel merged with this branch's tool surface:
  // start_job gained `path`/`separateWork`, create_thread and send_to_thread
  // gained `attachOwnerImage`, watch refuses schedules that poll live work, and
  // watch now distinguishes tool-created watches from evidence-backed CLI work.
  // Re-pinned again when send_to_thread gained the required `ask`: the owner
  // cannot see the threads, so messaging one now carries the line he is told.
  // Re-pinned again when retry_job began reporting `retryOutcome`: a queued
  // retry leaves the job unchanged, so the description now tells the agent to
  // read the outcome rather than read an unchanged job as a failed retry.
  // Re-pinned when `queued` stopped promising that admission alone guarantees
  // execution; scheduler health can still hold an admitted retry.
  // Re-pinned when start_job began describing the job as the software lifecycle.
  // Re-pinned when clock schedules moved to BB Automations with UTC semantics.
  // Re-pinned when BB replaced experimental status labels with the stable
  // presentation contract in plugin SDK 0.4.21.
  expect(digest).toBe("853902c2eb6e276cedd5885798022c43fa491a87fd9f4324c6b2ccea427188df");
  expect(metadata[21]).toEqual({
    name: "telegram_agent_turn_evidence",
    description: "List bounded evidence for the current authorized controller turn after reconciling BB-native work.",
    presentation: null,
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
    description: "Submit one bounded evidence-backed final response for the current controller turn. Each segment is delivered as its own paragraph: a blank line is inserted between segments for you, so do not add trailing separators or leading blank lines, and keep one paragraph in one segment. A qualifier only applies to the segment it sits in. What you read outside our systems, from a search or a page, is an external_reading claim: it can say what the source said, and never that a job, a check, a deployment, or anything of ours succeeded. Apply the unslop skill to every segment before submitting. That is required, not optional.",
    presentation: null,
    schema: controllerFinalizationJsonSchema,
  });
  // The renderer inserts the paragraph break, so the contract has to say so.
  expect(metadata[22].description).toMatch(/own paragraph/);
  // 31 manifest capabilities plus the two capability metadata tools.
  expect(new Set(registrations.map((tool) => tool.name)).size).toBe(36);

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
    ["telegram_agent_job_status", ["job_state", "pipeline_outcome", "production_outcome", "obligation"]],
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
    ["telegram_agent_watch", ["monitor_state", "external_mutation", "obligation"]],
    ["telegram_agent_list_watches", ["monitor_state", "obligation"]],
    ["telegram_agent_cancel_watch", ["monitor_state", "external_mutation"]],
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
    watchedMonitorIds?: string[];
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
      params: () => ({ threadId: "thr_active", text: "Continue the matrix.", ask: "keep the matrix run going" }),
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
        // Sending to the thread already armed a watch on it, and watching it
        // explicitly reuses that one rather than arming a second.
        const monitor = store.listMonitors(turn.controllerKey, false)
          .find((candidate) => candidate.threadId === "thr_active");
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
      // The thread this matrix started is watched for the agent too, so the
      // listing reports that watch beside the one it armed itself.
      capture: () => {
        state.watchedMonitorIds = store.listMonitors(turn.controllerKey, false).map((monitor) => monitor.id);
      },
      expected: () => ({
        outcome: "observed",
        proofKinds: ["monitor_state", "obligation"],
        subjectRefs: state.watchedMonitorIds!.map((id) => `monitor:${id}`),
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
        outcome: "succeeded",
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
    provider: {
      id: "codex",
      model: "gpt-5.6",
      capabilities: { supportsNativeUserQuestion: false },
    },
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

  expect(job).toMatchObject({
    state: "awaiting_confirmation",
    projectId: "proj_1",
    policyVersion: 1,
    workflowEngine: "navigator-v1",
    workflowMode: "deterministic",
    routingMode: "legacy",
    recipeVersion: 1,
    recipePromotionCount: 0,
  });
  expect(job.taskRecipe).not.toBe("bug");
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

it("does not let an explicit legacy small-fix hint downgrade behavioral work", () => {
  const { store } = fixture();
  const job = store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller",
    projectId: "proj_1",
    task: "fix the redirect",
    path: "small_fix",
    now: 10_010,
  });
  expect(job).toMatchObject({
    deliveryMode: "full",
    workflowEngine: "navigator-v1",
    routingMode: "legacy",
  });
  expect(job.taskRecipe).not.toBe("bounded");
});

it("creates an adopted-PR job with honest skipped planning stages", () => {
  const { store } = fixture();
  const headSha = "a".repeat(40);
  const job = store.createAdoptedControllerJob({
    controllerThreadId: "thr_controller",
    projectId: "proj_1",
    task: "Review and finish the existing pull request",
    prNumber: 17,
    prUrl: "https://github.com/acme/cyndra/pull/17",
    headSha,
    branchName: "telegram-agent/adopt-pr-17-aaaaaaaaaaaa",
    now: 10_010,
  });

  expect(job).toMatchObject({
    state: "awaiting_confirmation",
    origin: "adopted_pr",
    workflowEngine: "navigator-v1",
    routingMode: "legacy",
    adoptedBranch: "telegram-agent/adopt-pr-17-aaaaaaaaaaaa",
    adoptedHeadSha: headSha,
    prNumber: 17,
    prHeadSha: headSha,
  });
  expect(job.taskRecipe).not.toBe("adopted-pr");
  expect(store.getLatestPipelineStageAttempt(job.id, "PLAN")).toMatchObject({
    state: "skipped",
    outcome: { disposition: "skipped", reason: "existing_pull_request" },
  });
  expect(store.getLatestPipelineStageAttempt(job.id, "CRITIQUE")).toMatchObject({ state: "skipped" });
  const admitted = admitConfirmedJob(store, job, 10_011);
  expect(admitted.state).toBe("creating_implementation");
  expect(store.listEffectsForJob(job.id).find((effect) => effect.kind === "spawn_implementation")?.payload)
    .toMatchObject({ adoptedBranch: job.adoptedBranch, adoptedHeadSha: headSha });
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
  const { bb, harness, store } = fixture({ active: true, inputText: "what is running right now?" });
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

  expect(harness.registrations.agentTools.map((tool) => tool.name)).toEqual(ALL_CONTROLLER_TOOL_NAMES);
  const context = {
    thread: { id: "thr_controller", title: "Telegram Luna controller owner-7-controller", parentThreadId: null, sourceThreadId: null },
    project: { id: "proj_personal", kind: "personal" as const, name: "Personal", gitRemoteUrl: null },
    environment: { id: "env_personal", name: null, path: "/private/path", workspaceProvisionType: "personal" as const, branchName: null },
    host: { id: "host_personal", name: "Host" },
    provider: {
      id: "codex",
      model: "gpt-5.6-luna",
      capabilities: { supportsNativeUserQuestion: false },
    },
    origin: { kind: null, pluginId: bb.pluginId },
  };
  const selected = await harness.behavior.resolveAgentConfiguration(context);
  const minimumTools = controllerToolsForBundles(["core-observation"]);
  expect(selected.tools.map((tool) => tool.name)).toHaveLength(minimumTools.length);
  expect(new Set(selected.tools.map((tool) => tool.name))).toEqual(new Set(minimumTools));
  expect(selected.skills).toEqual([
    "driving-bb",
    "unslop",
  ]);
  expect(selected.instructions).toContain("You are the owner's teammate");
  const aliasTools = (await harness.behavior.resolveAgentConfiguration({
    ...context,
    thread: { ...context.thread, title: "Telegram Codex controller owner-7-controller" },
  })).tools.map((tool) => tool.name);
  expect(aliasTools).toHaveLength(minimumTools.length);
  expect(new Set(aliasTools)).toEqual(new Set(minimumTools));
  expect((await harness.behavior.resolveAgentConfiguration({
    ...context,
    thread: { ...context.thread, id: "thr_unrelated" },
  })).tools).toEqual([]);
  // The controller is bound to the configured provider; anything else may not.
  expect((await harness.behavior.resolveAgentConfiguration({
    ...context,
    provider: {
      id: "claude-code",
      model: "claude-opus-5[1m]",
      capabilities: { supportsNativeUserQuestion: false },
    },
  })).tools).toEqual([]);
  expect((await harness.behavior.resolveAgentConfiguration({
    ...context,
    provider: {
      id: "acp-grok",
      model: "grok",
      capabilities: { supportsNativeUserQuestion: false },
    },
  })).tools).toEqual([]);

  store.replaceExternalCapabilityInventory({
    hostScope: "project:proj_1",
    now: 10_000,
    items: [{
      inventoryKey: "inventory:skill:external-safe",
      capabilityId: "external-safe",
      capabilityKind: "skill",
      source: "/private/provider/source",
      version: "1.0.0",
      digest: "a".repeat(64),
      hostScope: "project:proj_1",
      status: "inventory-only",
      metadata: { privatePath: "/private/provider/source" },
      discoveredAt: 10_000,
    }],
  });

  const capabilitySummary = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_capabilities",
    {},
    controllerToolContext,
  ));
  expect(capabilitySummary).toMatchObject({
    profile: { revision: 1, bundles: ["core-observation"], continuationCount: 0 },
    inventory: {
      available: true,
      hostScope: "project:proj_1",
      items: [{ id: "external-safe", kind: "skill", version: "1.0.0", status: "inventory-only" }],
      truncated: false,
    },
  });
  expect(JSON.stringify(capabilitySummary)).not.toContain("descriptorDigest");
  expect(JSON.stringify(capabilitySummary)).not.toContain("/private/provider/source");

  await expect(harness.behavior.callAgentTool(
    "telegram_agent_list_projects",
    {},
    { threadId: "thr_unrelated", projectId: "proj_personal" },
  )).resolves.toEqual(structuredToolError("identity_mismatch"));
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
  )).resolves.toEqual(structuredToolError("scope_denied"));

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

it("keeps protocol tools in all-tools and old-profile compatibility configurations", async () => {
  const register = (target: ReturnType<typeof fixture>) => {
    registerControllerTools(target.bb, {
      store: target.store,
      sdk: target.bb.sdk,
      threadOperations: { request: vi.fn() },
      health: () => ({ ok: true }),
      notify: vi.fn(),
      now: () => 10_000,
      controllerProviderId: () => "codex",
    });
  };
  const context = (pluginId: string) => ({
    thread: { id: "thr_controller", title: "Telegram Luna controller owner-7-controller", parentThreadId: null, sourceThreadId: null },
    project: { id: "proj_personal", kind: "personal" as const, name: "Personal", gitRemoteUrl: null },
    environment: { id: "env_personal", name: null, path: "/private/path", workspaceProvisionType: "personal" as const, branchName: null },
    host: { id: "host_personal", name: "Host" },
    provider: {
      id: "codex",
      model: "gpt-5.6-luna",
      capabilities: { supportsNativeUserQuestion: false },
    },
    origin: { kind: null, pluginId },
  });
  const names = (configuration: { tools: readonly { name: string }[] }) =>
    configuration.tools.map((tool) => tool.name);

  const allTools = fixture({ active: true, controllerTools: "all-tools" });
  register(allTools);
  const allToolsNames = names(await allTools.harness.behavior.resolveAgentConfiguration(context(allTools.bb.pluginId)));
  const expectedAllTools = controllerToolsForBundles(CONTROLLER_BUNDLE_IDS);
  expect(allToolsNames).toHaveLength(expectedAllTools.length);
  expect(new Set(allToolsNames)).toEqual(new Set(expectedAllTools));

  const stale = fixture({ active: true });
  register(stale);
  if (!stale.turn.capabilityProfileId) throw new Error("stale profile fixture is incomplete");
  const currentProfile = stale.store.getCapabilityProfileById(stale.turn.capabilityProfileId);
  if (!currentProfile) throw new Error("stale profile was not persisted");
  const staleProfile = stale.store.createCapabilityProfile({
    subjectKind: currentProfile.subjectKind,
    subjectId: currentProfile.subjectId,
    threadId: currentProfile.threadId,
    recipeId: currentProfile.recipeId,
    recipeVersion: currentProfile.recipeVersion,
    registryDigest: "0".repeat(64),
    graphDigest: currentProfile.graphDigest,
    mode: currentProfile.mode,
    model: currentProfile.model,
    assignments: [...currentProfile.assignments],
    reasonCodes: [...currentProfile.reasonCodes],
    traits: [...currentProfile.traits],
    expectedRevision: currentProfile.revision + 1,
    now: 10_001,
  });
  stale.bb.storage.database().prepare(
    `UPDATE controller_turns
        SET capability_profile_id = ?, capability_profile_revision = ?,
            capability_configured_revision = ?
      WHERE id = ?`,
  ).run(staleProfile.id, staleProfile.revision, staleProfile.revision, stale.turn.id);
  stale.bb.storage.database().prepare(
    `UPDATE controller_threads
        SET capability_subject_id = ?, capability_profile_id = ?,
            capability_profile_revision = ?
      WHERE controller_key = ?`,
  ).run(stale.turn.id, staleProfile.id, staleProfile.revision, stale.turn.controllerKey);
  const staleNames = names(await stale.harness.behavior.resolveAgentConfiguration(context(stale.bb.pluginId)));
  expect(staleNames).toEqual(ALL_CONTROLLER_TOOL_NAMES);

  const migrated = fixture({ active: true });
  register(migrated);
  migrated.bb.storage.database().prepare(
    `UPDATE controller_turns
        SET capability_profile_id = NULL, capability_profile_revision = 0,
            capability_configured_revision = 0
      WHERE id = ?`,
  ).run(migrated.turn.id);
  migrated.bb.storage.database().prepare(
    `UPDATE controller_threads
        SET capability_subject_id = NULL, capability_profile_id = NULL,
            capability_profile_revision = 0
      WHERE controller_key = ?`,
  ).run(migrated.turn.controllerKey);
  const migratedNames = names(await migrated.harness.behavior.resolveAgentConfiguration(context(migrated.bb.pluginId)));
  expect(migratedNames).toEqual(ALL_CONTROLLER_TOOL_NAMES);
  for (const protocolToolId of CONTROLLER_PROTOCOL_TOOL_IDS) {
    expect(allToolsNames.filter((name) => name === protocolToolId)).toHaveLength(1);
    expect(staleNames.filter((name) => name === protocolToolId)).toHaveLength(1);
    expect(migratedNames.filter((name) => name === protocolToolId)).toHaveLength(1);
  }
});

it("exposes an approved bundle only after the persisted continuation profile is configured", async () => {
  const { bb, harness, store, turn, deactivate } = fixture({
    active: true,
    inputText: "what is running right now?",
  });
  let now = 10_000;
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => now,
    controllerProviderId: () => "codex",
  });

  const pending = store.getPendingControllerTurn(turn.controllerKey);
  if (!pending?.leaseOwner || pending.leaseGeneration === null) throw new Error("missing controller fence");
  expect(store.canMutateControllerTurn({
    ownerId: pending.leaseOwner,
    generation: pending.leaseGeneration,
    now,
    turnId: pending.id,
    controllerKey: pending.controllerKey,
    expectedThreadId: controllerToolContext.threadId,
  })).toBe(true);

  const expansion = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_request_capability",
    { bundleIds: ["job-control"] },
    controllerToolContext,
  ));
  expect(expansion).toEqual({
    outcome: "resume_required",
    profileRevision: 2,
    continuationCount: 1,
    selectedBundleIds: ["core-observation", "job-control"],
  });

  deactivate();
  const lease = store.acquireExecutorLease("capability-continuation", ++now, 30_000);
  if (!lease.acquired) throw new Error("missing capability continuation lease");
  const fence = { ownerId: "capability-continuation", generation: lease.generation };
  expect(store.prepareControllerCapabilityContinuation({
    ...fence,
    now: ++now,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    expectedThreadId: "thr_controller",
  })).toBe(true);
  expect(store.claimNextControllerTurn({ ...fence, now: ++now })?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    ...fence,
    now: ++now,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller_continued",
  })).toBe(true);

  const continuedContext = {
    thread: {
      id: "thr_controller_continued",
      title: "Telegram Luna controller owner-7-controller",
      parentThreadId: null,
      sourceThreadId: null,
    },
    project: { id: "proj_personal", kind: "personal" as const, name: "Personal", gitRemoteUrl: null },
    environment: {
      id: "env_personal",
      name: null,
      path: "/private/path",
      workspaceProvisionType: "personal" as const,
      branchName: null,
    },
    host: { id: "host_personal", name: "Host" },
    provider: {
      id: "codex",
      model: "gpt-5.6-luna",
      capabilities: { supportsNativeUserQuestion: false },
    },
    origin: { kind: null, pluginId: bb.pluginId },
  };
  const continuedTools = (await harness.behavior.resolveAgentConfiguration(continuedContext)).tools.map((tool) => tool.name);
  const expectedContinuedTools = controllerToolsForBundles(["core-observation", "job-control"]);
  expect(continuedTools).toHaveLength(expectedContinuedTools.length);
  expect(new Set(continuedTools)).toEqual(new Set(expectedContinuedTools));
  expect(store.markControllerTurnSubmitted({ ...fence, now: ++now, turnId: turn.id })).toBe(true);

  expect(parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_request_capability",
    { bundleIds: ["memory"] },
    { threadId: "thr_controller_continued", projectId: "proj_personal" },
  ))).toEqual({
    outcome: "denied",
    reasonCode: "expansion_limit",
    scope: "controller_tool_expansion",
    accessDenied: false,
    guidance: "This limits additional controller tools for this turn; it does not deny BB, shell, provider, connector, or project access.",
  });
});

it("rejects repeating schedules that poll live work", async () => {
  const { bb, harness, store } = fixture({ active: true });
  const automations = createTestManagedAutomations();
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_000,
    controllerProviderId: () => "codex",
    controllerExecution: () => ({
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "default",
      permissionMode: "auto",
    }),
    automations,
  });

  await expect(harness.behavior.callAgentTool(
    "telegram_agent_watch",
    {
      kind: "schedule",
      cron: "*/30 * * * *",
      instruction: "Check whether the cancelled job is still holding the project lock; if it is, clear the stale worker record and retry the queued job.",
    },
    controllerToolContext,
  )).rejects.toThrow(/live work|thread_idle/i);
  expect(store.listMonitors("owner-7-controller", false)).toEqual([]);

  await expect(harness.behavior.callAgentTool(
    "telegram_agent_watch",
    { kind: "schedule", cron: "0 9 * * 1-5", instruction: "Send the weekday morning digest." },
    controllerToolContext,
  )).resolves.toContain('"kind":"schedule"');
  expect(automations.create).toHaveBeenCalledOnce();
});

it("retires an already-armed live-work poller without touching clock-time schedules", () => {
  const { store } = fixture();
  const poller = store.createMonitor({
    controllerKey: "owner-7-controller",
    kind: "schedule",
    cron: "*/30 * * * *",
    instruction: "Check whether the queued job is still blocked, then retry it.",
    dueAt: 30_000,
    now: 10_000,
  });
  const digest = store.createMonitor({
    controllerKey: "owner-7-controller",
    kind: "schedule",
    cron: "0 9 * * 1-5",
    instruction: "Send the weekday morning digest.",
    dueAt: 86_400_000,
    now: 10_001,
  });

  expect(retireLiveWorkPollingSchedules(store, 20_000)).toBe(1);
  expect(store.listMonitors("owner-7-controller", true)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: poller.id, state: "cancelled" }),
    expect.objectContaining({ id: digest.id, state: "armed" }),
  ]));
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
      "unslop",
      "diagnosing-bugs",
      "tdd",
      "clean-code-guard",
      "test-guard",
      "durable-boundary-audit",
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

it("routes an active worker from only its exact persisted capability profile", async () => {
  const { bb, harness, store } = registerWorkerConfiguration();
  const { job, effect: implementationEffect } = advanceToImplementation(store, "job_active_profile");
  bb.storage.database().prepare("UPDATE jobs SET routing_mode = 'active' WHERE id = ?").run(job.id);
  const activeJob = store.getJob(job.id);
  if (!activeJob) throw new Error("active job missing");
  const attemptId = `attempt:${implementationEffect.idempotencyKey}`;
  store.createAttempt({ id: attemptId, jobId: job.id, kind: "implementation", ordinal: 1, now: 1_006 });
  const unslop = HISTORICAL_RECIPE_CAPABILITY_BY_ID.get("unslop");
  if (!unslop) throw new Error("historical unslop descriptor missing");
  const persisted = store.createCapabilityProfile({
    subjectKind: "worker_attempt",
    subjectId: attemptId,
    threadId: null,
    recipeId: activeJob.taskRecipe,
    recipeVersion: activeJob.recipeVersion,
    registryDigest: HISTORICAL_RECIPE_REGISTRY_DIGEST,
    graphDigest: HISTORICAL_RECIPE_GRAPH_DIGEST,
    mode: "active",
    model: {
      pool: "strong",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      reasoning: "xhigh",
      serviceTier: "fast",
    },
    assignments: [{
      capabilityId: "unslop",
      descriptorDigest: unslop.digest,
      capabilityKind: "skill",
      mandatory: unslop.evidence.requirement === "mandatory",
    }],
    reasonCodes: ["worker_role:implementation", "worker_stage:implementation"],
    traits: ["behavioral-change"],
    now: 1_006,
  });
  const identity = { jobId: job.id, attemptId, role: "implementation" as const };

  const configuration = await harness.behavior.resolveAgentConfiguration(workerContext(bb.pluginId, identity));

  expect(configuration).toMatchObject({
    tools: [],
    skills: ["unslop"],
  });
  expect(configuration.instructions).toContain("Selected skill ids: unslop");
  expect(configuration.instructions).not.toContain("diagnosing-bugs");
  expect(store.getActiveCapabilityProfile("worker_attempt", attemptId)?.id).toBe(persisted.id);
});

it("fails closed for an active worker whose persisted profile is missing or stale", async () => {
  const { bb, harness, store } = registerWorkerConfiguration();
  const { job, effect: implementationEffect } = advanceToImplementation(store, "job_active_missing_profile");
  bb.storage.database().prepare("UPDATE jobs SET routing_mode = 'active' WHERE id = ?").run(job.id);
  const attemptId = `attempt:${implementationEffect.idempotencyKey}`;
  store.createAttempt({ id: attemptId, jobId: job.id, kind: "implementation", ordinal: 1, now: 1_006 });
  const identity = { jobId: job.id, attemptId, role: "implementation" as const };

  const missing = await harness.behavior.resolveAgentConfiguration(workerContext(bb.pluginId, identity));
  expect(missing).toMatchObject({ tools: [], skills: [] });

  const activeJob = store.getJob(job.id);
  if (!activeJob) throw new Error("active job missing");
  store.createCapabilityProfile({
    subjectKind: "worker_attempt",
    subjectId: attemptId,
    threadId: null,
    recipeId: activeJob.taskRecipe,
    recipeVersion: activeJob.recipeVersion,
    registryDigest: "0".repeat(64),
    graphDigest: HISTORICAL_RECIPE_GRAPH_DIGEST,
    mode: "active",
    model: { pool: "strong", providerId: "codex", modelId: "model", reasoning: "high", serviceTier: "fast" },
    assignments: [],
    reasonCodes: [],
    traits: [],
    now: 1_007,
  });

  const stale = await harness.behavior.resolveAgentConfiguration(workerContext(bb.pluginId, identity));
  expect(stale).toMatchObject({ tools: [], skills: [] });
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
    [{ jobId: review.job.id, attemptId: reviewId, role: "review" as const }, undefined, ["unslop", "clean-code-guard", "test-guard", "durable-boundary-audit", "blast-radius", "code-review"]],
    [{ jobId: finalReview.job.id, attemptId: finalReviewId, role: "final-review" as const }, undefined, ["unslop", "clean-code-guard", "test-guard", "docs-guard", "durable-boundary-audit", "blast-radius"]],
    [{ jobId: implementation.job.id, attemptId: `stage:${planEffect.idempotencyKey}`, role: "planner" as const }, "thr_plan", ["unslop", "writing-for-agents", "docs-guard"]],
    [{ jobId: implementation.job.id, attemptId: `stage:${critiqueEffect.idempotencyKey}`, role: "critic" as const }, undefined, ["unslop"]],
    [{ jobId: docs.job.id, attemptId: `stage:${docs.effect.idempotencyKey}`, role: "documentation" as const }, undefined, ["unslop", "technical-writing", "docs-guard"]],
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
  )).resolves.toEqual(structuredToolError("scope_denied"));
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
    subjectRefs: ["project:proj_personal"],
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
  )).resolves.toEqual(structuredToolError("scope_denied"));
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

it("refuses a project with no stored policy at the scope gate, before the base branch is ever read", async () => {
  const { bb, harness, store } = fixture({ active: true });
  const spawn = vi.fn(async () => ({ id: "thr_new", environmentId: "env_new" }));
  harness.sdk.stub("threads.spawn", spawn);
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_000,
  });

  // A project the owner never enabled has no stored policy, so it has no base
  // branch to resolve. Requiring an explicit base branch must not turn that into
  // a new failure: the scope gate already refuses it, and the tool body — and so
  // the base-branch lookup — is never reached.
  await expect(harness.behavior.callAgentTool(
    "telegram_agent_create_thread",
    { projectId: "proj_without_policy", title: "Look at the logs", prompt: "Read the CI log" },
    { threadId: "thr_controller", projectId: "proj_personal" },
  )).resolves.toEqual(structuredToolError("scope_denied"));

  expect(spawn).not.toHaveBeenCalled();
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
    controllerExecution: () => ({
      model: "grok-4.6",
      reasoningLevel: "xhigh",
      serviceTier: "default",
      permissionMode: "auto",
    }),
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
    providerId: "acp-grok",
    model: "grok-4.6",
    permissionMode: "accept-edits",
    environment: expect.objectContaining({ type: "host", hostId: "host_cyndra" }),
  }));

  const sent = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_send_to_thread",
    { threadId: "thr_active", text: "Use the staging database", ask: "point it at staging so it stops touching live data" },
    { threadId: "thr_controller", projectId: "proj_personal" },
  ));
  expect(sent).toMatchObject({ sent: { threadId: "thr_active" } });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    threadId: "thr_active",
    input: [{ type: "text", text: "Use the staging database", mentions: [] }],
  }));
  // Messaging a thread spends the owner's authority, so what was asked is
  // recorded here and owed to him until the reply states it.
  expect(store.unreportedControllerThreadAsks("owner-7-controller")).toContainEqual({
    threadId: "thr_active",
    threadName: "Fix Cyndra billing",
    ask: "point it at staging so it stops touching live data",
  });

  // Engaging with a thread is what earns the follow-up, so the thread the agent
  // started and the one it merely messaged are both watched, and messaging the
  // same thread again reuses the watch rather than arming a second one.
  await harness.behavior.callAgentTool(
    "telegram_agent_send_to_thread",
    { threadId: "thr_active", text: "Report when the tests land", ask: "report back once the tests finish" },
    { threadId: "thr_controller", projectId: "proj_personal" },
  );
  expect(store.listMonitors("owner-7-controller", false).map((monitor) => ({
    kind: monitor.kind,
    threadId: monitor.threadId,
    state: monitor.state,
  }))).toEqual(expect.arrayContaining([
    { kind: "thread_idle", threadId: "thr_new", state: "armed" },
    { kind: "thread_idle", threadId: "thr_active", state: "armed" },
  ]));
  expect(store.listMonitors("owner-7-controller", false)).toHaveLength(2);

  await expect(harness.behavior.callAgentTool(
    "telegram_agent_send_to_thread",
    { threadId: "thr_hidden", text: "leak", ask: "should never reach a hidden thread" },
    { threadId: "thr_controller", projectId: "proj_personal" },
  )).resolves.toEqual(structuredToolError("scope_denied"));
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
    // The receipt is keyed by the parsed arguments, so schema defaults are part
    // of the hash the executor looks up.
    argsSha256: sha256ControllerJson({ ...params, separateWork: false }),
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
  ) as string) as { monitors: Array<{ id: string }>; _hanoonEvidence: { proofKinds: string[]; subjectRefs: string[] } };
  expect(output._hanoonEvidence.proofKinds).toEqual(["monitor_state", "obligation"]);
  // The list packs the armed watch first and settled history newest-first, so
  // the refs are read from the rows the tool actually returned, not from the
  // store's raw order.
  const returnedOrder = output.monitors.map((monitor) => monitor.id);
  expect(returnedOrder[0]).toBe(monitorIds[0]);
  expect(returnedOrder).toHaveLength(17);
  expect(output._hanoonEvidence.subjectRefs).toEqual(returnedOrder.slice(0, 16).map((id) => `monitor:${id}`));
});

it("attaches the owner's Telegram photo when starting or messaging a visible thread", async () => {
  const { bb, harness, store, turn } = fixture({ active: true });
  const spawn = vi.fn(async () => ({ id: "thr_new", environmentId: "env_new" }));
  const send = vi.fn(async () => ({ ok: true }));
  const upload = vi.fn(async () => ({
    type: "localImage" as const,
    path: "attachments/owner-shot.jpg",
    name: "owner-shot.jpg",
  }));
  const downloadImage = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
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
  harness.sdk.stub("projects.attachments.upload", upload);
  harness.sdk.stub("threads.spawn", spawn);
  harness.sdk.stub("threads.send", send);
  harness.sdk.stub("threads.get", async ({ threadId }) => ({
    ...visibleThread({ id: threadId }),
    canSpawnChild: true,
  }));
  bb.storage.database().prepare(
    `UPDATE controller_turns
        SET image_file_id = ?, image_file_name = ?, image_mime_type = ?,
            image_size_bytes = ?, image_kind = ?
      WHERE id = ?`,
  ).run("AgAD-photo", "owner-shot.jpg", "image/jpeg", 4, "image", turn.id);
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    downloadImage,
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_000,
  });

  const created = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_create_thread",
    {
      projectId: "proj_1",
      title: "Check this screenshot",
      prompt: "What is wrong in this screenshot?",
      attachOwnerImage: true,
    },
    { threadId: "thr_controller", projectId: "proj_personal" },
  ));
  expect(created).toMatchObject({ thread: { id: "thr_new", imageCount: 1 } });
  expect(downloadImage).toHaveBeenCalledWith("AgAD-photo", expect.any(Number), expect.anything());
  expect(upload).toHaveBeenCalledWith(expect.objectContaining({
    projectId: "proj_1",
    filename: "owner-shot.jpg",
    mimeType: "image/jpeg",
  }));
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
    input: [
      { type: "text", text: "What is wrong in this screenshot?", mentions: [] },
      { type: "localImage", path: "attachments/owner-shot.jpg" },
    ],
  }));

  const sent = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_send_to_thread",
    { threadId: "thr_active", text: "Here is the screenshot", ask: "pass on the owner's screenshot", attachOwnerImage: true },
    { threadId: "thr_controller", projectId: "proj_personal" },
  ));
  expect(sent).toMatchObject({ sent: { threadId: "thr_active", imageCount: 1 } });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    input: [
      { type: "text", text: "Here is the screenshot", mentions: [] },
      { type: "localImage", path: "attachments/owner-shot.jpg" },
    ],
  }));

  bb.storage.database().prepare(
    `UPDATE controller_turns
        SET image_file_id = NULL, image_file_name = NULL, image_mime_type = NULL,
            image_size_bytes = NULL, image_kind = NULL
      WHERE id = ?`,
  ).run(turn.id);
  await expect(harness.behavior.callAgentTool(
    "telegram_agent_create_thread",
    {
      projectId: "proj_1",
      title: "No photo",
      prompt: "Look at this",
      attachOwnerImage: true,
    },
    { threadId: "thr_controller", projectId: "proj_personal" },
  )).rejects.toThrow(/did not send an image/i);
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
  }, { threadId: "thr_unrelated", projectId: "proj_personal" }))
    .resolves.toEqual(structuredToolError("identity_mismatch"));
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

it("returns an existing open job instead of starting a duplicate for the same task", async () => {
  const { bb, harness, store } = fixture({ active: true });
  const notify = vi.fn();
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify,
    now: () => 10_200,
  });
  const first = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_start_job",
    { projectId: "proj_1", task: "surface refunds in order knowledge" },
    controllerToolContext,
  )) as { job: { id: string }; existing: boolean };
  expect(first.existing).toBe(false);

  const second = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_start_job",
    { projectId: "proj_1", task: "surface refunds in order knowledge" },
    controllerToolContext,
  )) as { job: { id: string }; existing: boolean };
  // Within one turn the capability layer replays the tool receipt verbatim, so
  // the repeat returns the first result rather than reaching the open-job
  // branch. Either way the guarantee that matters holds: exactly one job.
  expect(second).toMatchObject({ job: { id: first.job.id } });
  expect(store.listJobs(10).filter((job) => job.requestText === "surface refunds in order knowledge")).toHaveLength(1);
});

it("refuses a distinct second job in one project unless it is explicitly separate", async () => {
  const { bb, harness, store } = fixture({ active: true });
  const notify = vi.fn();
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify,
    now: () => 10_250,
  });
  queueControllerCandidate(store, "open_project_job_A", "proj_1");
  const first = { job: { id: "open_project_job_A" } };

  const guarded = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_start_job",
    { projectId: "proj_1", task: "also change the receipt copy" },
    controllerToolContext,
  )) as { outcome: string; job: { id: string } };
  expect(guarded).toMatchObject({
    outcome: "open_job_requires_resolution",
    job: { id: first.job.id },
  });
  expect(store.listJobs(10)).toHaveLength(1);

  const separate = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_start_job",
    { projectId: "proj_1", task: "also change the receipt copy", separateWork: true },
    controllerToolContext,
  )) as { existing: boolean; job: { id: string } };
  expect(separate.existing).toBe(false);
  expect(separate.job.id).not.toBe(first.job.id);
  expect(store.listJobs(10)).toHaveLength(2);
});

it("steers a clear free-text follow-up into the admitted implementation job", async () => {
  const { bb, harness, store, activate, deactivate } = fixture({ active: true });
  const notify = vi.fn();
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify,
    now: () => 10_260,
  });
  // Admission takes its own executor lease, so the controller fence stands down
  // for exactly that setup step and is re-adopted before the tool call.
  deactivate();
  const advanced = advanceToImplementation(store, "job_free_text_steer");
  const job = store.applyJobEvent(advanced.job.id, advanced.job.version, {
    type: "IMPLEMENTATION_CREATED",
    threadId: "thr_free_text_implementation",
    environmentId: "env_worker",
  }, 10_255);
  activate();

  const result = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_steer_job",
    { jobId: job.id, text: "Keep the existing API name and add the timeout regression." },
    controllerToolContext,
  )) as { steered: boolean; job: { id: string } };

  expect(result).toMatchObject({ steered: true, job: { id: job.id } });
  expect(store.listEffectsForJob(job.id).filter((effect) => effect.kind === "steer_implementation").at(-1)?.payload)
    .toEqual({
      text: "Keep the existing API name and add the timeout regression.",
      threadId: job.implementationThreadId,
    });
  expect(notify).toHaveBeenCalledOnce();
});

it("retries a blocked plan and cancels a blocked job from the controller", async () => {
  const { bb, harness, store } = fixture({ active: true });
  const notify = vi.fn();
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify,
    now: () => 10_300,
  });
  const created = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_start_job",
    { projectId: "proj_1", task: "narrow refund fix" },
    controllerToolContext,
  )) as { job: { id: string } };
  const job = store.getJob(created.job.id)!;
  const db = bb.storage.database();
  db.prepare("UPDATE jobs SET state = 'blocked', blocked_reason = 'plan_limit', last_error = 'Plan needs revision: add tests' WHERE id = ?")
    .run(job.id);
  db.prepare("UPDATE job_admissions SET state = 'released', released_at = ?, release_reason = 'plan_limit' WHERE job_id = ?")
    .run(10_250, job.id);

  const resumed = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_retry_job",
    { jobId: job.id },
    controllerToolContext,
  )) as { job: { id: string; state: string; resumable?: boolean } };
  expect(resumed.job.id).toBe(job.id);
  expect(store.getAdmission(job.id)?.resumeEvent).toBe("CONTINUE_REVIEW");

  const blockedAgain = store.getJob(job.id)!;
  db.prepare("UPDATE jobs SET state = 'blocked', blocked_reason = 'plan_limit' WHERE id = ?").run(job.id);
  db.prepare("UPDATE job_admissions SET state = 'released', released_at = ?, release_reason = 'plan_limit' WHERE job_id = ?")
    .run(10_280, job.id);
  const cancelled = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_cancel_job",
    { jobId: blockedAgain.id },
    controllerToolContext,
  )) as { job: { state: string; cancelRequested: boolean } };
  expect(cancelled.job.cancelRequested).toBe(true);
});

it("tells the controller a retry is parked behind the failure brake, not resumed", async () => {
  const { bb, harness, store } = fixture({ active: true });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_300,
  });
  const created = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_start_job",
    { projectId: "proj_1", task: "finish the adopted pull request" },
    controllerToolContext,
  )) as { job: { id: string } };
  const db = bb.storage.database();
  db.prepare(
    `UPDATE jobs SET state = 'blocked', blocked_reason = 'permanent_effect_failure',
       resume_state = 'creating_implementation', last_error = 'spawn_implementation gave up' WHERE id = ?`,
  ).run(created.job.id);
  db.prepare("UPDATE job_admissions SET state = 'released', released_at = ?, release_reason = 'blocked' WHERE job_id = ?")
    .run(10_250, created.job.id);
  expect(store.pauseProjectAdmission({
    projectId: "proj_1",
    reason: "four jobs failed the same way",
    fingerprint: "proj_1:permanent_effect_failure",
    now: 10_260,
  })).toBe(true);
  const before = store.getJob(created.job.id)!;

  const retried = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_retry_job",
    { jobId: created.job.id },
    controllerToolContext,
  )) as { job: { state: string; updatedAt: number }; retryOutcome: string };

  // The job is deliberately untouched here, which is exactly why the caller has
  // to be told the difference between "resumed" and "queued behind a brake".
  expect(retried.job).toMatchObject({ state: before.state, updatedAt: before.updatedAt });
  expect(retried.retryOutcome).toBe("queued_project_paused");
  expect(store.getAdmission(created.job.id)?.resumeEvent).toBe("RETRY");
});

it("distinguishes a retry merely queued from one held by the failure brake", async () => {
  const { bb, harness, store } = fixture({ active: true });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_300,
  });
  const created = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_start_job",
    { projectId: "proj_1", task: "finish the adopted pull request" },
    controllerToolContext,
  )) as { job: { id: string } };
  const db = bb.storage.database();
  db.prepare(
    `UPDATE jobs SET state = 'blocked', blocked_reason = 'permanent_effect_failure',
       resume_state = 'creating_implementation', last_error = 'Attempt was not stored' WHERE id = ?`,
  ).run(created.job.id);
  db.prepare("UPDATE job_admissions SET state = 'released', released_at = ?, release_reason = 'blocked' WHERE job_id = ?")
    .run(10_250, created.job.id);

  const retried = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_retry_job",
    { jobId: created.job.id },
    controllerToolContext,
  )) as { retryOutcome: string };

  // No brake here, so this retry is genuinely waiting its turn rather than
  // parked forever. Reporting it as paused would send the owner after a brake
  // that does not exist.
  expect(retried.retryOutcome).toBe("queued");
  expect(store.getAdmission(created.job.id)?.resumeEvent).toBe("RETRY");
});

it("reports a retry the state machine actually applied as resumed", async () => {
  const { bb, harness, store, activate, deactivate } = fixture({ active: true });
  deactivate();
  queueControllerCandidate(store, "job_resumed_retry", "proj_resumed", "failed");
  activate();
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 10_300,
  });

  const retried = parseToolJson(await harness.behavior.callAgentTool(
    "telegram_agent_retry_job",
    { jobId: "job_resumed_retry" },
    controllerToolContext,
  )) as { job: { state: string }; retryOutcome: string };

  expect(retried.retryOutcome).toBe("resumed");
  expect(retried.job.state).not.toBe("failed");
});
