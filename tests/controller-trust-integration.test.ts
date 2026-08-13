import type { BbPluginApi } from "@bb/plugin-sdk";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import plugin from "../server";
import { controllerSpawnTitle } from "../src/controller/bb-controller";
import {
  CONTROLLER_INSTRUCTIONS,
  CONTROLLER_INSTRUCTION_SENTINEL,
} from "../src/controller/instructions";
import { controllerInteractionToken } from "../src/controller/questions";
import type { TelegramUpdate } from "../src/telegram/types";
import { openStore, type StoredOutbox } from "../src/storage/store";
import { policyFixture } from "./helpers";
import { submittedControllerFixture } from "./support/controller-trust-fixtures";

const NOW = 2_000;
const LEASE_MS = 30_000;
const RECOVERY_PROMPT = "Inspect telegram_agent_turn_evidence and call telegram_agent_respond with the evidence already available.";
const RAW_PROVIDER_SENTINEL = "RAW PROVIDER PROSE MUST NOT SHIP";
const NATURAL_RESPONSE = "The enabled project is available.";
const DENIAL_RESPONSE = "The requested command was denied.";
const OWNER_OVERLAY = "Prefer concise summaries.";

// These are independent expected values. They are intentionally not imported
// from the controller execution profile or tool manifest under test.
const EXPECTED_LIST_PROJECTS_ARGS_SHA256 = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
const EXPECTED_LIST_PROJECTS_RESULT_SHA256 = "c84c3c5fe063788ca9b683b0dc76479d70cfaeb540bd56ecc59b9163b8edee5a";
const EXPECTED_COMMAND_ARGS_SHA256 = "dfa51cc11e96df7b8a30721dc37e14738e7893318b60715d216441de26dbf78a";
const EXPECTED_COMMAND_RESULT_SHA256 = "45e246b1e4715f3a97ca0e53d7fe80d3a4b2d86b72caa513da32e0d6ca72fff4";

function directSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertIndependentArtifactHashes(): void {
  expect(directSha256("{}")).toBe(EXPECTED_LIST_PROJECTS_ARGS_SHA256);
  expect(directSha256(
    "{\"projects\":[{\"alias\":\"cyndra\",\"baseBranch\":\"main\",\"id\":\"proj_1\",\"implementationModel\":\"implementation-model\",\"productionConfigured\":true,\"reviewModel\":\"review-model\"}]}",
  )).toBe(EXPECTED_LIST_PROJECTS_RESULT_SHA256);
  expect(directSha256("{\"command\":\"npm test\",\"cwd\":\"/workspace\",\"type\":\"commandExecution\"}")).toBe(EXPECTED_COMMAND_ARGS_SHA256);
  expect(directSha256("{\"approvalStatus\":\"denied\",\"exitCode\":1,\"status\":\"failed\"}")).toBe(EXPECTED_COMMAND_RESULT_SHA256);
}

// The real plugin uses Date.now() for capability fences while the fixture and
// reconciliation clock intentionally use a deterministic value.
vi.useFakeTimers();
vi.setSystemTime(new Date(NOW));
afterAll(() => vi.useRealTimers());

// Deliberately independent from src/controller/tools.ts. A source constant
// cannot prove that production registration still exposes the intended API.
const EXPECTED_CONTROLLER_TOOL_NAMES = [
  "telegram_agent_list_projects",
  "telegram_agent_start_job",
  "telegram_agent_job_status",
  "telegram_agent_retry_job",
  "telegram_agent_cancel_job",
  "telegram_agent_list_threads",
  "telegram_agent_thread_status",
  "telegram_agent_read_thread",
  "telegram_agent_create_thread",
  "telegram_agent_send_to_thread",
  "telegram_agent_request_thread_operation",
  "telegram_agent_remember",
  "telegram_agent_recall",
  "telegram_agent_forget",
  "telegram_agent_watch",
  "telegram_agent_list_watches",
  "telegram_agent_cancel_watch",
  "telegram_agent_health",
  "telegram_agent_delegate",
  "telegram_agent_scorecard",
  "telegram_agent_set_working_style",
  "telegram_agent_turn_evidence",
  "telegram_agent_respond",
] as const;

type ControllerTrustFixture = ReturnType<typeof submittedControllerFixture>;
type ProductionFixture = Readonly<{
  bb: BbPluginApi;
  harness: ControllerTrustFixture["harness"];
}>;
type EventRow = Record<string, unknown> & {
  threadId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
};
type OrderEntry =
  | "callback-persistence"
  | "reopen"
  | "provider-get"
  | "provider-resolve"
  | "resolved-lifecycle"
  | "provider-terminal-read"
  | "continuation-send"
  | "continuation-events"
  | "finalization"
  | "final-delivery";
type FakeControllerSdkState = {
  threadId: string;
  projectId: string;
  hostId: string;
  status: "active" | "idle";
  maxSeq: number;
  events: EventRow[];
  interactionStatus: "pending" | "resolved";
  interactionResolution: Record<string, unknown> | null;
  orderLedger: OrderEntry[];
  afterReopen: boolean;
  callbackReceived: boolean;
  preReopenGetBlocked: boolean;
  preReopenGetAborted: boolean;
  providerGetCount: number;
  providerResolveCount: number;
  providerId: string;
  threadGetIds: string[];
  threadStatuses: string[];
  environmentGetIds: string[];
};

type TelegramApiCall = Readonly<{
  method: string;
  token: string;
  payload: Record<string, unknown>;
}>;
type RecordingMessage = Readonly<{
  chatId: string;
  payload: Record<string, unknown>;
  messageId: number;
}>;
type RecordingEdit = Readonly<{
  chatId: string;
  messageId: number;
  payload: Record<string, unknown>;
}>;
type RecordingDraft = Readonly<{
  chatId: string;
  draftId: number;
  payload: Record<string, unknown>;
}>;
type RecordingCallbackAnswer = Readonly<{
  callbackQueryId: string;
  payload: Record<string, unknown>;
}>;
type RecordingTelegram = Readonly<{
  fetch: typeof fetch;
  calls: TelegramApiCall[];
  sentMessages: RecordingMessage[];
  editedMessages: RecordingEdit[];
  drafts: RecordingDraft[];
  callbackAnswers: RecordingCallbackAnswer[];
  queueCallback(update: TelegramUpdate): void;
}>;

function eventRow(
  threadId: string,
  seq: number,
  type: string,
  data: Record<string, unknown>,
): EventRow {
  return {
    id: `event-${seq}`,
    threadId,
    seq,
    createdAt: seq,
    scope: { kind: "thread" },
    type,
    data,
  };
}

function fakeControllerInteraction(
  state: FakeControllerSdkState,
  interactionId: string,
): Record<string, unknown> {
  return {
    id: interactionId,
    threadId: state.threadId,
    status: state.interactionStatus,
    statusReason: null,
    createdAt: 2_001,
    resolvedAt: state.interactionStatus === "resolved" ? 2_006 : null,
    turnId: "provider-turn-1",
    providerId: "claude-code",
    providerThreadId: "provider-thread-1",
    providerRequestId: "provider-request-1",
    payload: {
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "command-approval-1",
        command: "npm test",
        cwd: "/workspace",
        actions: [],
        sessionGrant: null,
      },
      reason: null,
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    },
    resolution: state.interactionResolution,
  };
}

function expectedContinuationRequest(threadId: string): Record<string, unknown> {
  return {
    threadId,
    mode: "start",
    model: "claude-opus-5[1m]",
    reasoningLevel: "xhigh",
    permissionMode: "auto",
    executionInputSources: {
      model: "explicit",
      reasoningLevel: "explicit",
      permissionMode: "explicit",
    },
    input: [{ type: "text", text: RECOVERY_PROMPT, mentions: [] }],
  };
}

function stubControllerSdk(
  harness: ControllerTrustFixture["harness"],
  state: FakeControllerSdkState,
  interactionId?: string,
): void {
  harness.sdk.stub("threads.timeline", async (input: { threadId: string }) => {
    expect(input.threadId).toBe(state.threadId);
    return { maxSeq: state.maxSeq };
  });
  harness.sdk.stub("threads.get", async (input: { threadId: string }) => {
    expect(input.threadId).toBe(state.threadId);
    state.threadGetIds.push(input.threadId);
    state.threadStatuses.push(state.status);
    return {
      id: input.threadId,
      projectId: state.projectId,
      environmentId: "environment-controller-trust",
      providerId: state.providerId,
      status: state.status,
      archivedAt: null,
      deletedAt: null,
    };
  });
  harness.sdk.stub("environments.get", async (input: { environmentId: string }) => {
    expect(input.environmentId).toBe("environment-controller-trust");
    state.environmentGetIds.push(input.environmentId);
    return {
      id: input.environmentId,
      projectId: state.projectId,
      hostId: state.hostId,
      path: "/tmp/controller-trust-project",
      status: "ready",
      workspaceProvisionType: "personal",
    };
  });
  harness.sdk.stub("threads.events.list", async (input: {
    threadId: string;
    afterSeq?: string;
    limit?: string;
  }) => {
    expect(input.threadId).toBe(state.threadId);
    return state.events
      .filter((row) => row.threadId === input.threadId && row.seq > Number(input.afterSeq ?? "0"))
      .slice(0, Number(input.limit ?? "100"));
  });
  harness.sdk.stub("threads.send", async (input: Record<string, unknown>) => {
    if (!state.afterReopen) throw new Error("continuation was sent before the restart proof");
    expect(input).toEqual(expectedContinuationRequest(state.threadId));
    expect(input).not.toHaveProperty("providerId");
    expect(input).not.toHaveProperty("serviceTier");
    expect(state.orderLedger).not.toContain("continuation-send");
    state.orderLedger.push("continuation-send");
    const continuationEvents = [
      eventRow(state.threadId, 3, "item/agentMessage/delta", { delta: RAW_PROVIDER_SENTINEL }),
      commandApprovalEvent(state.threadId, 4),
      eventRow(state.threadId, 5, "turn/completed", {}),
    ];
    state.events = [...state.events, ...continuationEvents];
    state.maxSeq = 5;
    // Keep the fake provider active for the reconciliation that projects the
    // continuation result; the test makes it idle only after finalization.
    state.status = "active";
    state.orderLedger.push("continuation-events");
    return { ok: true };
  });
  if (!interactionId) return;
  harness.sdk.stub("threads.interactions.get", async (input: {
    threadId: string;
    interactionId: string;
    signal?: AbortSignal;
  }) => {
    // The fake must reject identity drift at the SDK boundary, not merely
    // return the fixture interaction regardless of what production requested.
    expect(input.threadId).toBe(state.threadId);
    expect(input.interactionId).toBe(interactionId);
    if (state.callbackReceived && !state.afterReopen) {
      state.preReopenGetBlocked = true;
      return new Promise<Record<string, unknown>>((resolve) => {
        const release = (): void => {
          state.preReopenGetAborted = true;
          resolve(fakeControllerInteraction(state, interactionId));
        };
        if (input.signal?.aborted) release();
        else input.signal?.addEventListener("abort", release, { once: true });
      });
    }
    if (state.afterReopen) {
      state.providerGetCount += 1;
      state.orderLedger.push(state.interactionStatus === "pending" ? "provider-get" : "provider-terminal-read");
    }
    return fakeControllerInteraction(state, interactionId);
  });
  harness.sdk.stub("threads.interactions.resolve", async (input: {
    threadId: string;
    interactionId: string;
    resolution: Record<string, unknown>;
  }) => {
    expect(state.afterReopen).toBe(true);
    expect(input.threadId).toBe(state.threadId);
    expect(input.interactionId).toBe(interactionId);
    expect(input.resolution).toEqual({ decision: "deny" });
    expect(state.interactionStatus).toBe("pending");
    state.interactionResolution = input.resolution;
    state.interactionStatus = "resolved";
    state.providerResolveCount += 1;
    state.orderLedger.push("provider-resolve");
    // This event is created only by the exact successful resolve transition.
    state.events = [
      ...state.events,
      eventRow(state.threadId, 2, "system/permissionGrant/lifecycle", {
        interactionId,
        status: "resolved",
      }),
    ];
    state.maxSeq = 2;
    state.orderLedger.push("resolved-lifecycle");
    state.status = "idle";
    return fakeControllerInteraction(state, interactionId);
  });
}

function controllerContext(store: ControllerTrustFixture["store"], signal: AbortSignal) {
  const controller = store.getControllerForOwner("7", "7");
  if (!controller?.threadId || !controller.projectId) throw new Error("controller fixture is incomplete");
  return {
    threadId: controller.threadId,
    projectId: controller.projectId,
    signal,
  };
}

function registeredToolNames(fixture: ProductionFixture): string[] {
  return fixture.harness.inspection.registrations.agentTools.map((tool) => tool.name);
}

function parseToolResult(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("controller tool did not return JSON text");
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("controller tool returned a non-object JSON value");
  }
  return parsed as Record<string, unknown>;
}

function productionConfigurationContext(bb: BbPluginApi, store: ControllerTrustFixture["store"]) {
  const controller = store.getControllerForOwner("7", "7");
  const turn = controller?.controllerKey ? store.getControllerTurn(store.listControllerTurns(controller.controllerKey, 1)[0]?.id ?? "") : null;
  if (!controller?.threadId || !controller.projectId || !controller.hostId || !turn) {
    throw new Error("controller configuration fixture is incomplete");
  }
  return {
    thread: {
      id: controller.threadId,
      title: controllerSpawnTitle(
        controller.controllerKey,
        turn.id,
        controller.projectId,
        controller.hostId,
        "claude-code",
      ),
      parentThreadId: null,
      sourceThreadId: null,
    },
    project: {
      id: controller.projectId,
      kind: "personal" as const,
      name: "Controller trust project",
      gitRemoteUrl: null,
    },
    environment: {
      id: "environment-controller-trust",
      name: null,
      path: "/tmp/controller-trust-project",
      workspaceProvisionType: "personal" as const,
      branchName: null,
    },
    host: { id: controller.hostId, name: "Controller trust host" },
    provider: { id: "claude-code", model: "claude-opus-5[1m]" },
    origin: { kind: null, pluginId: bb.pluginId },
  };
}

async function assertProductionWiring(
  fixture: ProductionFixture,
  store: ControllerTrustFixture["store"],
  state: FakeControllerSdkState,
): Promise<void> {
  expect(fixture.harness.inspection.registrations.services.map((service) => service.name))
    .toEqual(expect.arrayContaining(["telegram-ingress", "job-executor"]));
  expect(registeredToolNames(fixture)).toEqual(EXPECTED_CONTROLLER_TOOL_NAMES);
  const context = productionConfigurationContext(fixture.bb, store);
  expect(context.thread.id).toBe(state.threadId);
  expect(context.project.id).toBe(state.projectId);
  expect(context.host.id).toBe(state.hostId);
  expect(context.provider).toEqual({ id: "claude-code", model: "claude-opus-5[1m]" });
  expect(state.providerId).toBe(context.provider.id);
  const configured = await fixture.harness.behavior.resolveAgentConfiguration(context);
  expect(configured.tools.map((tool) => tool.name)).toEqual(EXPECTED_CONTROLLER_TOOL_NAMES);
  expect(configured.skills).toEqual([]);
  if (configured.instructions === null) throw new Error("controller instructions were not configured");
  const expectedInstructions = `${CONTROLLER_INSTRUCTIONS}\n\nHow this owner has asked you to work — their wording, and it outranks style guidance above, never a boundary:\n${OWNER_OVERLAY}`;
  expect(configured.instructions).toBe(expectedInstructions);
  expect(configured.instructions).toContain("telegram-agent:controller-instructions:v1");
  expect(configured.instructions).toContain(OWNER_OVERLAY);
  expect(CONTROLLER_INSTRUCTION_SENTINEL).toBe("telegram-agent:controller-instructions:v1");

  await fixture.harness.behavior.setSettings({ botToken: null });
  await expect(fixture.harness.behavior.resolveAgentConfiguration(context)).resolves.toEqual({
    tools: [],
    skills: [],
    instructions: null,
  });
  await fixture.harness.behavior.setSettings({ botToken: "123:test-token" });
}

function jsonResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function recordingTelegramTransport(onFinalDelivery?: () => void): RecordingTelegram {
  let nextMessageId = 900;
  let callbackUpdate: TelegramUpdate | null = null;
  const calls: TelegramApiCall[] = [];
  const sentMessages: RecordingMessage[] = [];
  const editedMessages: RecordingEdit[] = [];
  const drafts: RecordingDraft[] = [];
  const callbackAnswers: RecordingCallbackAnswer[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const token = url.match(/\/bot([^/]+)\/[^/]+$/)?.[1] ?? "";
    const payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    calls.push({ method, token, payload });
    if (method === "getMe") return jsonResponse({ id: 999, username: "controller_trust_bot" });
    if (method === "getUpdates") {
      if (callbackUpdate !== null) {
        const update = callbackUpdate;
        callbackUpdate = null;
        return jsonResponse([update]);
      }
      return new Promise<Response>((resolve) => {
        const signal = init?.signal;
        const release = (): void => resolve(jsonResponse([]));
        if (signal?.aborted) release();
        else signal?.addEventListener("abort", release, { once: true });
      });
    }
    if (method === "sendMessage") {
      const message = { chatId: String(payload.chat_id), payload, messageId: nextMessageId++ };
      sentMessages.push(message);
      if (payload.text === DENIAL_RESPONSE || payload.text === NATURAL_RESPONSE) onFinalDelivery?.();
      return jsonResponse({ message_id: message.messageId });
    }
    if (method === "editMessageText") {
      editedMessages.push({
        chatId: String(payload.chat_id),
        messageId: Number(payload.message_id),
        payload,
      });
      return jsonResponse(true);
    }
    if (method === "sendMessageDraft") {
      drafts.push({ chatId: String(payload.chat_id), draftId: Number(payload.draft_id), payload });
      return jsonResponse(true);
    }
    if (method === "answerCallbackQuery") {
      callbackAnswers.push({ callbackQueryId: String(payload.callback_query_id), payload });
      return jsonResponse(true);
    }
    if (method === "sendChatAction") return jsonResponse(true);
    throw new Error(`unexpected fake Telegram method: ${method}`);
  };
  return {
    fetch: fetchFn,
    calls,
    sentMessages,
    editedMessages,
    drafts,
    callbackAnswers,
    queueCallback: (update) => {
      if (callbackUpdate !== null) throw new Error("a Telegram callback is already queued");
      callbackUpdate = update;
    },
  };
}

function assertRegisteredControllerMapping(
  recording: RecordingTelegram,
  state: FakeControllerSdkState,
): void {
  expect(recording.calls.length).toBeGreaterThan(0);
  expect(recording.calls.every((call) => call.token === "123:test-token")).toBe(true);
  expect(state.threadGetIds.length).toBeGreaterThan(0);
  expect(state.threadGetIds.every((threadId) => threadId === state.threadId)).toBe(true);
  expect(state.environmentGetIds.every((environmentId) => environmentId === "environment-controller-trust")).toBe(true);
}

function telegramCallback(token: string, updateId: number, messageId: number): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 7, is_bot: false },
      message: {
        message_id: messageId,
        chat: { id: 7, type: "private" },
      },
      data: `i:${token}`,
    },
  };
}

function commandApprovalEvent(threadId: string, seq: number): EventRow {
  return eventRow(threadId, seq, "item/completed", {
    providerThreadId: "provider-thread-1",
    item: {
      type: "commandExecution",
      id: "command-approval-1",
      command: "npm test",
      cwd: "/workspace",
      status: "failed",
      approvalStatus: "denied",
      exitCode: 1,
    },
  });
}

function storedInteractionState(db: Database.Database, interactionId: string): Record<string, unknown> {
  const row = db.prepare(
    `SELECT interaction_id, turn_id, controller_key, bb_thread_id, controller_generation_id,
            kind, payload_json, state, answer_json, asked_at, answered_at, delivered_at
       FROM controller_interactions
      WHERE interaction_id = ?`,
  ).get(interactionId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("controller interaction was not durable");
  return row;
}

function storedControllerTurn(db: Database.Database, turnId: string): Record<string, unknown> {
  const row = db.prepare(
    `SELECT id, controller_key, state, lease_owner, lease_generation,
            dispatch_after_seq, bb_event_seq, evidence_event_seq,
            completion_continuations, accepted_finalization_id,
            evidence_limit_exceeded_at, stream_text, stream_phase,
            response_text, telegram_message_id, awaiting_interaction_id,
            submitted_at, completed_at
       FROM controller_turns
      WHERE id = ?`,
  ).get(turnId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("controller turn was not durable");
  return row;
}

function finalOutbox(store: ControllerTrustFixture["store"], turnId: string): StoredOutbox {
  const row = store.getOutbox(`controller:${turnId}:reply`);
  if (!row) throw new Error("controller reply outbox was not durable");
  return row;
}

function exactOutbox(
  store: ControllerTrustFixture["store"],
  input: Readonly<{
    logicalKey: string;
    chatId: string;
    messageId: number | null;
    payload: Record<string, unknown>;
    status: "pending" | "sent";
    attempts: number;
  }>,
): StoredOutbox {
  const row = store.getOutbox(input.logicalKey);
  if (!row) throw new Error(`missing outbox ${input.logicalKey}`);
  expect(row).toEqual({
    logicalKey: input.logicalKey,
    chatId: input.chatId,
    messageId: input.messageId,
    payload: input.payload,
    status: input.status,
    attempts: input.attempts,
    leaseOwner: null,
    leaseGeneration: null,
    leaseExpiresAt: null,
    nextAttemptAt: NOW,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return row;
}

function finalizationClaim(evidenceRef: string) {
  return {
    disposition: "answered",
    segments: [{
      type: "claim",
      text: DENIAL_RESPONSE,
      kind: "execution_result",
      outcome: "failed",
      subjectRef: "bb-item:command-approval-1",
      evidenceRefs: [evidenceRef],
    }],
    obligationRefs: [],
  };
}

function assertNoRawProviderProse(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(RAW_PROVIDER_SENTINEL);
}

async function waitForCondition<T>(read: () => T, attempts = 2_000): Promise<T> {
  let lastError: unknown = new Error("condition was not checked");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return read();
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
  }
  throw lastError;
}

async function stopService(run: { controller: AbortController; done: Promise<void> }): Promise<void> {
  run.controller.abort();
  await run.done;
}

async function nudgeExecutor(
  fixture: ProductionFixture,
  maxConcurrentJobs: "4" | "5",
): Promise<void> {
  await fixture.harness.behavior.setSettings({ maxConcurrentJobs });
}

it("accepts an evidence-bound natural answer through registered tools, reconciliation, and one reply outbox", async () => {
  assertIndependentArtifactHashes();
  const fixture = submittedControllerFixture();
  fixture.store.upsertProjectPolicy(policyFixture(), 1_500);
  fixture.store.setControllerOverlay({ text: OWNER_OVERLAY, now: NOW });
  const controller = fixture.store.getControllerForOwner("7", "7");
  if (!controller?.threadId || !controller.projectId) throw new Error("controller fixture is incomplete");
  const state: FakeControllerSdkState = {
    threadId: controller.threadId,
    projectId: controller.projectId,
    hostId: controller.hostId ?? "host_1",
    status: "active",
    maxSeq: 0,
    events: [],
    interactionStatus: "pending",
    interactionResolution: null,
    orderLedger: [],
    afterReopen: false,
    callbackReceived: false,
    preReopenGetBlocked: false,
    preReopenGetAborted: false,
    providerGetCount: 0,
    providerResolveCount: 0,
    providerId: "claude-code",
    threadGetIds: [],
    threadStatuses: [],
    environmentGetIds: [],
  };
  stubControllerSdk(fixture.harness, state);
  await plugin(fixture.bb);
  await fixture.harness.behavior.setSettings({ botToken: "123:test-token" });
  await assertProductionWiring(fixture, fixture.store, state);

  const toolContext = controllerContext(fixture.store, new AbortController().signal);
  const projects = parseToolResult(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_list_projects",
    {},
    toolContext,
  ));
  const listEvidence = projects._hanoonEvidence as {
    ref: `evidence:${number}`;
    subjectRefs: string[];
  };
  expect(listEvidence).toEqual({
    ref: "evidence:1",
    outcome: "observed",
    proofKinds: ["project_state"],
    subjectRefs: ["project:proj_1"],
    observedAt: NOW,
  });
  const naturalEvidence = fixture.store.listControllerEvidence(fixture.turn.id, 128);
  expect(naturalEvidence).toEqual([{
    id: 1,
    ref: "evidence:1",
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    sourceKind: "hanoon_tool",
    sourceName: "telegram_agent_list_projects",
    sourceItemId: null,
    outcome: "observed",
    argsSha256: EXPECTED_LIST_PROJECTS_ARGS_SHA256,
    resultSha256: EXPECTED_LIST_PROJECTS_RESULT_SHA256,
    proofKinds: ["project_state"],
    subjectRefs: ["project:proj_1"],
    observedAt: NOW,
  }]);
  assertNoRawProviderProse(naturalEvidence);

  const naturalCandidate = {
    disposition: "answered",
    segments: [{
      type: "claim",
      text: NATURAL_RESPONSE,
      kind: "observed_state",
      outcome: "observed",
      subjectRef: "project:proj_1",
      evidenceRefs: ["evidence:1"],
    }],
    obligationRefs: [],
  };
  const finalizationResult = parseToolResult(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_respond",
    naturalCandidate,
    toolContext,
  ));
  expect(finalizationResult).toEqual({
    outcome: "accepted",
    ref: "finalization:1",
    renderedCharacters: NATURAL_RESPONSE.length,
  });
  expect(fixture.store.getAcceptedControllerFinalization(fixture.turn.id)).toEqual({
    id: 1,
    ref: "finalization:1",
    turnId: fixture.turn.id,
    revision: 1,
    candidate: naturalCandidate,
    renderedMessage: NATURAL_RESPONSE,
    evidenceHighWaterId: 1,
    bbEventHighWaterSeq: 0,
    createdAt: NOW,
    validatedAt: NOW,
    consumedAt: null,
  });
  assertNoRawProviderProse(fixture.store.getAcceptedControllerFinalization(fixture.turn.id));

  expect(fixture.store.releaseExecutorLease(fixture.fence.ownerId, fixture.fence.generation, NOW)).toBe(true);
  const recording = recordingTelegramTransport();
  vi.stubGlobal("fetch", recording.fetch);
  const executorRun = fixture.harness.behavior.runService("job-executor");
  try {
    await waitForCondition(() => expect(finalOutbox(fixture.store, fixture.turn.id)).toEqual(expect.objectContaining({
      status: "sent",
      messageId: null,
      payload: { text: "Hanoon is connecting…", disable_web_page_preview: true },
    })));
    expect(fixture.store.getAcceptedControllerFinalization(fixture.turn.id)?.consumedAt).toBeNull();
    expect(state.threadStatuses).toContain("active");
    expect(storedControllerTurn(fixture.db, fixture.turn.id)).toMatchObject({
      state: "submitted",
      lease_owner: expect.any(String),
      lease_generation: expect.any(Number),
      dispatch_after_seq: 0,
      bb_event_seq: 0,
      evidence_event_seq: 0,
      completion_continuations: 0,
      accepted_finalization_id: 1,
      stream_text: "",
      stream_phase: "connecting",
      response_text: null,
      telegram_message_id: null,
      submitted_at: NOW,
      completed_at: null,
    });
    expect(recording.sentMessages).toEqual([]);
    expect(recording.editedMessages).toEqual([]);
    assertRegisteredControllerMapping(recording, state);
    expect(recording.drafts.every((draft) => draft.payload.text !== NATURAL_RESPONSE)).toBe(true);

    state.status = "idle";
    await nudgeExecutor(fixture, "4");
    await waitForCondition(() => expect(fixture.store.getControllerTurn(fixture.turn.id)).toMatchObject({
      state: "completed",
      responseText: NATURAL_RESPONSE,
      completedAt: NOW,
    }));
    const finalMessage = await waitForCondition(() => {
      const message = recording.sentMessages.find((candidate) => candidate.payload.text === NATURAL_RESPONSE);
      if (!message) throw new Error("the registered executor did not send the natural final reply");
      return message;
    });
    expect(recording.sentMessages).toEqual([{
      chatId: "7",
      messageId: finalMessage.messageId,
      payload: {
        text: NATURAL_RESPONSE,
        disable_web_page_preview: true,
        chat_id: "7",
      },
    }]);
    expect(finalMessage.messageId).toBe(900);
    expect(state.threadStatuses).toContain("idle");
    expect(recording.editedMessages).toEqual([]);
    await waitForCondition(() => expect(fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`)).toMatchObject({
      status: "sent",
      messageId: 900,
    }));
    exactOutbox(fixture.store, {
      logicalKey: `controller:${fixture.turn.id}:reply`,
      chatId: "7",
      messageId: 900,
      payload: { text: NATURAL_RESPONSE, disable_web_page_preview: true },
      status: "sent",
      attempts: 1,
    });
    expect(fixture.store.listOutbox(128)).toHaveLength(1);
    expect(fixture.store.getAcceptedControllerFinalization(fixture.turn.id)).toEqual({
      id: 1,
      ref: "finalization:1",
      turnId: fixture.turn.id,
      revision: 1,
      candidate: naturalCandidate,
      renderedMessage: NATURAL_RESPONSE,
      evidenceHighWaterId: 1,
      bbEventHighWaterSeq: 0,
      createdAt: NOW,
      validatedAt: NOW,
      consumedAt: NOW,
    });
    expect(fixture.store.readControllerDigest(fixture.turn.controllerKey, 12)).toEqual([{
      ownerText: fixture.turn.inputText,
      agentText: NATURAL_RESPONSE,
    }]);
    expect(fixture.store.listControllerEvidence(fixture.turn.id, 128)).toEqual(naturalEvidence);
    expect(storedControllerTurn(fixture.db, fixture.turn.id)).toMatchObject({
      state: "completed",
      lease_owner: expect.any(String),
      lease_generation: expect.any(Number),
      dispatch_after_seq: 0,
      bb_event_seq: 0,
      evidence_event_seq: 0,
      completion_continuations: 0,
      accepted_finalization_id: 1,
      stream_text: "",
      stream_phase: "complete",
      response_text: NATURAL_RESPONSE,
      telegram_message_id: 900,
      submitted_at: NOW,
      completed_at: NOW,
    });
    assertNoRawProviderProse({
      evidence: fixture.store.listControllerEvidence(fixture.turn.id, 128),
      finalization: fixture.store.getAcceptedControllerFinalization(fixture.turn.id),
      digest: fixture.store.readControllerDigest(fixture.turn.controllerKey, 12),
      turn: fixture.store.getControllerTurn(fixture.turn.id),
      outbox: fixture.store.listOutbox(128),
      transport: recording,
    });

    await stopService(executorRun);
    const replayHost = await fixture.harness.lifecycle.reload(async (bb) => {
      await plugin(bb);
    });
    const replayStore = openStore(replayHost.bb.storage, replayHost.bb.storage.kv, () => NOW);
    stubControllerSdk(replayHost.harness, state);
    await assertProductionWiring(replayHost, replayStore, state);
    const replayRun = replayHost.harness.behavior.runService("job-executor");
    try {
      await waitForCondition(() => expect(replayStore.getOutbox(`controller:${fixture.turn.id}:reply`)).toMatchObject({ status: "sent" }));
    } finally {
      await stopService(replayRun);
    }
    expect(recording.sentMessages).toHaveLength(1);
    expect(recording.editedMessages).toHaveLength(0);
    expect(replayStore.listOutbox(128)).toHaveLength(1);
    await replayHost.harness.lifecycle.dispose();
  } finally {
    if (!executorRun.controller.signal.aborted) await stopService(executorRun);
    vi.unstubAllGlobals();
  }
});

it("restarts across a Telegram approval, resolves the exact BB interaction once, and finalizes only from denial evidence", async () => {
  assertIndependentArtifactHashes();
  const fixture = submittedControllerFixture();
  fixture.store.setControllerOverlay({ text: OWNER_OVERLAY, now: NOW });
  const controller = fixture.store.getControllerForOwner("7", "7");
  if (!controller?.threadId || !controller.projectId) throw new Error("controller fixture is incomplete");
  const interactionId = "permission-command-1";
  const pendingEvent = eventRow(controller.threadId, 1, "system/permissionGrant/lifecycle", {
    interactionId,
    status: "pending",
  });
  const state: FakeControllerSdkState = {
    threadId: controller.threadId,
    projectId: controller.projectId,
    hostId: controller.hostId ?? "host_1",
    status: "active",
    maxSeq: 1,
    events: [pendingEvent],
    interactionStatus: "pending",
    interactionResolution: null,
    orderLedger: [],
    afterReopen: false,
    callbackReceived: false,
    preReopenGetBlocked: false,
    preReopenGetAborted: false,
    providerGetCount: 0,
    providerResolveCount: 0,
    providerId: "claude-code",
    threadGetIds: [],
    threadStatuses: [],
    environmentGetIds: [],
  };
  stubControllerSdk(fixture.harness, state, interactionId);
  await plugin(fixture.bb);
  await fixture.harness.behavior.setSettings({ botToken: "123:test-token" });
  await assertProductionWiring(fixture, fixture.store, state);

  expect(fixture.store.releaseExecutorLease(fixture.fence.ownerId, fixture.fence.generation, NOW)).toBe(true);
  const recording = recordingTelegramTransport(() => state.orderLedger.push("final-delivery"));
  vi.stubGlobal("fetch", recording.fetch);
  const executorRun = fixture.harness.behavior.runService("job-executor");
  let ingressRun: { controller: AbortController; done: Promise<void> } | null = null;
  try {
    const prompt = await waitForCondition(() => {
      const candidate = recording.sentMessages.find((message) => Array.isArray(
        (message.payload.reply_markup as { inline_keyboard?: unknown } | undefined)?.inline_keyboard,
      ));
      if (!candidate) throw new Error("actual registered executor did not send the approval prompt");
      return candidate;
    });
    const allowToken = controllerInteractionToken(interactionId, "allow_once");
    const denyToken = controllerInteractionToken(interactionId, "deny");
    expect(prompt).toEqual({
      chatId: "7",
      messageId: 900,
      payload: {
        text: "The controller wants to run:\n\n<code>npm test</code>\n\nin workspace",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Allow once", callback_data: `i:${allowToken}` }],
            [{ text: "Deny", callback_data: `i:${denyToken}` }],
          ],
        },
        disable_web_page_preview: true,
        chat_id: "7",
      },
    });
    await waitForCondition(() => expect(fixture.store.getOutbox(`controller-interaction:${interactionId}:0`)).toMatchObject({
      status: "sent",
      messageId: 900,
    }));
    exactOutbox(fixture.store, {
      logicalKey: `controller-interaction:${interactionId}:0`,
      chatId: "7",
      messageId: 900,
      payload: {
        text: "The controller wants to run:\n\n<code>npm test</code>\n\nin workspace",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Allow once", callback_data: `i:${allowToken}` }],
            [{ text: "Deny", callback_data: `i:${denyToken}` }],
          ],
        },
        disable_web_page_preview: true,
      },
      status: "sent",
      attempts: 1,
    });

    recording.queueCallback(telegramCallback(denyToken, 70_001, prompt.messageId));
    ingressRun = fixture.harness.behavior.runService("telegram-ingress");
    await waitForCondition(() => expect(fixture.store.getAnsweredControllerInteraction(controller.controllerKey)).toMatchObject({
      interactionId,
      resolution: { decision: "deny" },
      answeredAt: NOW,
    }));
    state.callbackReceived = true;
    state.orderLedger.push("callback-persistence");
    expect(storedInteractionState(fixture.db, interactionId)).toEqual(expect.objectContaining({
      interaction_id: interactionId,
      state: "answered",
      answer_json: '{"decision":"deny"}',
      asked_at: NOW,
      answered_at: NOW,
      delivered_at: null,
    }));
    exactOutbox(fixture.store, {
      logicalKey: "callback:callback-70001",
      chatId: "7",
      messageId: null,
      payload: { text: "Got it." },
      status: "pending",
      attempts: 0,
    });
    await waitForCondition(() => expect(state.preReopenGetBlocked).toBe(true));
    expect(state.providerResolveCount).toBe(0);
    await stopService(ingressRun);
    ingressRun = null;
    await stopService(executorRun);

    const restarted = await fixture.harness.lifecycle.reload(async (bb) => {
      await plugin(bb);
    });
    state.afterReopen = true;
    state.orderLedger.push("reopen");
    expect(state.preReopenGetAborted).toBe(true);
    expect(state.events).toEqual([pendingEvent]);
    expect(state.maxSeq).toBe(1);
    expect(state.interactionStatus).toBe("pending");
    expect(state.interactionResolution).toBeNull();
    const restartedStore = openStore(restarted.bb.storage, restarted.bb.storage.kv, () => NOW);
    await assertProductionWiring(restarted, restartedStore, state);
    stubControllerSdk(restarted.harness, state, interactionId);
    const restartedExecutor = restarted.harness.behavior.runService("job-executor");
    try {
      await waitForCondition(() => expect(state.providerResolveCount).toBe(1));
      await waitForCondition(() => expect(storedInteractionState(restarted.bb.storage.database(), interactionId)).toMatchObject({
        state: "delivered",
        delivered_at: NOW,
      }));
      expect(restarted.harness.inspection.sdk.callsTo("threads.interactions.get")).toEqual([
        [{ threadId: controller.threadId, interactionId, signal: expect.any(AbortSignal) }],
        [{ threadId: controller.threadId, interactionId, signal: expect.any(AbortSignal) }],
      ]);
      expect(restarted.harness.inspection.sdk.callsTo("threads.interactions.resolve")).toEqual([[
        {
          threadId: controller.threadId,
          interactionId,
          resolution: { decision: "deny" },
        },
      ]]);
      expect(storedInteractionState(restarted.bb.storage.database(), interactionId)).toEqual(expect.objectContaining({
        interaction_id: interactionId,
        state: "delivered",
        answer_json: '{"decision":"deny"}',
        answered_at: NOW,
        delivered_at: NOW,
      }));
      expect(state.events).toEqual([pendingEvent, eventRow(
        controller.threadId,
        2,
        "system/permissionGrant/lifecycle",
        { interactionId, status: "resolved" },
      )]);
      expect(state.orderLedger).toEqual([
        "callback-persistence",
        "reopen",
        "provider-get",
        "provider-resolve",
        "resolved-lifecycle",
        "provider-terminal-read",
      ]);

      await nudgeExecutor(restarted, "5");
      await waitForCondition(() => expect(state.orderLedger).toContain("continuation-send"));
      expect(restarted.harness.inspection.sdk.callsTo("threads.send")).toEqual([[
        expectedContinuationRequest(controller.threadId),
      ]]);
      expect(state.events.slice(0, 2)).toEqual([pendingEvent, eventRow(
        controller.threadId,
        2,
        "system/permissionGrant/lifecycle",
        { interactionId, status: "resolved" },
      )]);
      expect(state.events.slice(2)).toEqual([
        eventRow(controller.threadId, 3, "item/agentMessage/delta", { delta: RAW_PROVIDER_SENTINEL }),
        commandApprovalEvent(controller.threadId, 4),
        eventRow(controller.threadId, 5, "turn/completed", {}),
      ]);
      expect(state.orderLedger).toEqual([
        "callback-persistence",
        "reopen",
        "provider-get",
        "provider-resolve",
        "resolved-lifecycle",
        "provider-terminal-read",
        "continuation-send",
        "continuation-events",
      ]);

      await nudgeExecutor(restarted, "4");
      const denialEvidence = await waitForCondition(() => {
        const rows = restartedStore.listControllerEvidence(fixture.turn.id, 128);
        const row = rows.find((candidate) => candidate.sourceKind === "bb_item");
        if (!row) throw new Error("denial evidence was not reconciled");
        return row;
      });
      expect(restartedStore.listControllerEvidence(fixture.turn.id, 128)).toEqual([{
        id: 1,
        ref: "evidence:1",
        turnId: fixture.turn.id,
        controllerKey: fixture.turn.controllerKey,
        sourceKind: "bb_item",
        sourceName: "commandExecution",
        sourceItemId: "command-approval-1",
        outcome: "denied",
        argsSha256: EXPECTED_COMMAND_ARGS_SHA256,
        resultSha256: EXPECTED_COMMAND_RESULT_SHA256,
        proofKinds: ["command_result"],
        subjectRefs: ["bb-item:command-approval-1"],
        observedAt: NOW,
      }]);
      expect(denialEvidence.ref).toBe("evidence:1");
      const streamed = restartedStore.getControllerTurn(fixture.turn.id);
      expect(streamed?.streamText).not.toContain(RAW_PROVIDER_SENTINEL);
      expect(streamed?.streamPhase).toBe("thinking");
      assertNoRawProviderProse(restartedStore.listControllerEvidence(fixture.turn.id, 128));

      const denialCandidate = finalizationClaim(denialEvidence.ref);
      const finalization = parseToolResult(await restarted.harness.behavior.callAgentTool(
        "telegram_agent_respond",
        denialCandidate,
        controllerContext(restartedStore, new AbortController().signal),
      ));
      expect(finalization).toEqual({
        outcome: "accepted",
        ref: "finalization:1",
        renderedCharacters: DENIAL_RESPONSE.length,
      });
      state.orderLedger.push("finalization");
      expect(restartedStore.getAcceptedControllerFinalization(fixture.turn.id)).toEqual({
        id: 1,
        ref: "finalization:1",
        turnId: fixture.turn.id,
        revision: 1,
        candidate: denialCandidate,
        renderedMessage: DENIAL_RESPONSE,
        evidenceHighWaterId: 1,
        bbEventHighWaterSeq: 5,
        createdAt: NOW,
        validatedAt: NOW,
        consumedAt: null,
      });
      expect(storedControllerTurn(restarted.bb.storage.database(), fixture.turn.id)).toMatchObject({
        state: "submitted",
        dispatch_after_seq: 2,
        bb_event_seq: 5,
        evidence_event_seq: 5,
        completion_continuations: 1,
        accepted_finalization_id: 1,
        response_text: null,
        completed_at: null,
      });

      state.status = "idle";
      await nudgeExecutor(restarted, "5");
      await waitForCondition(() => expect(restartedStore.getControllerTurn(fixture.turn.id)).toMatchObject({
        state: "completed",
        responseText: DENIAL_RESPONSE,
        completedAt: NOW,
      }));
      const finalMessage = await waitForCondition(() => {
        const message = recording.sentMessages.find((candidate) => candidate.payload.text === DENIAL_RESPONSE);
        if (!message) throw new Error("the registered executor did not send the denial reply");
        return message;
      });
      expect(recording.sentMessages).toEqual([
        prompt,
        {
          chatId: "7",
          messageId: finalMessage.messageId,
          payload: {
            text: DENIAL_RESPONSE,
            disable_web_page_preview: true,
            chat_id: "7",
          },
        },
      ]);
      expect(finalMessage.messageId).toBe(901);
      expect(recording.editedMessages).toEqual([]);
      expect(recording.callbackAnswers).toEqual([{
        callbackQueryId: "callback-70001",
        payload: { callback_query_id: "callback-70001", text: "Got it." },
      }]);
      expect(recording.drafts.every((draft) => draft.payload.text !== RAW_PROVIDER_SENTINEL)).toBe(true);
      await waitForCondition(() => expect(restartedStore.getOutbox(`controller:${fixture.turn.id}:reply`)).toMatchObject({
        status: "sent",
        messageId: 901,
      }));

      exactOutbox(restartedStore, {
        logicalKey: `controller-interaction:${interactionId}:0`,
        chatId: "7",
        messageId: 900,
        payload: {
          text: "The controller wants to run:\n\n<code>npm test</code>\n\nin workspace",
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Allow once", callback_data: `i:${allowToken}` }],
              [{ text: "Deny", callback_data: `i:${denyToken}` }],
            ],
          },
          disable_web_page_preview: true,
        },
        status: "sent",
        attempts: 1,
      });
      exactOutbox(restartedStore, {
        logicalKey: "callback:callback-70001",
        chatId: "7",
        messageId: null,
        payload: { text: "Got it." },
        status: "sent",
        attempts: 1,
      });
      exactOutbox(restartedStore, {
        logicalKey: `controller:${fixture.turn.id}:reply`,
        chatId: "7",
        messageId: 901,
        payload: { text: DENIAL_RESPONSE, disable_web_page_preview: true },
        status: "sent",
        attempts: 1,
      });
      expect(restartedStore.listOutbox(128)).toHaveLength(3);
      expect(restartedStore.getAcceptedControllerFinalization(fixture.turn.id)).toEqual({
        id: 1,
        ref: "finalization:1",
        turnId: fixture.turn.id,
        revision: 1,
        candidate: denialCandidate,
        renderedMessage: DENIAL_RESPONSE,
        evidenceHighWaterId: 1,
        bbEventHighWaterSeq: 5,
        createdAt: NOW,
        validatedAt: NOW,
        consumedAt: NOW,
      });
      expect(restartedStore.readControllerDigest(controller.controllerKey, 12)).toEqual([{
        ownerText: fixture.turn.inputText,
        agentText: DENIAL_RESPONSE,
      }]);
      expect(storedControllerTurn(restarted.bb.storage.database(), fixture.turn.id)).toMatchObject({
        state: "completed",
        dispatch_after_seq: 2,
        bb_event_seq: 5,
        evidence_event_seq: 5,
        completion_continuations: 1,
        accepted_finalization_id: 1,
        stream_text: "",
        stream_phase: "complete",
        response_text: DENIAL_RESPONSE,
        telegram_message_id: 901,
        completed_at: NOW,
      });
      expect(state.orderLedger).toEqual([
        "callback-persistence",
        "reopen",
        "provider-get",
        "provider-resolve",
        "resolved-lifecycle",
        "provider-terminal-read",
        "continuation-send",
        "continuation-events",
        "finalization",
        "final-delivery",
      ]);
      expect(state.providerResolveCount).toBe(1);
      expect(state.providerGetCount).toBe(2);
      assertRegisteredControllerMapping(recording, state);
      expect(storedInteractionState(restarted.bb.storage.database(), interactionId)).toMatchObject({ state: "delivered" });
      const ownerVisible = {
        evidence: restartedStore.listControllerEvidence(fixture.turn.id, 128),
        finalization: restartedStore.getAcceptedControllerFinalization(fixture.turn.id),
        digest: restartedStore.readControllerDigest(controller.controllerKey, 12),
        turn: restartedStore.getControllerTurn(fixture.turn.id),
        outbox: restartedStore.listOutbox(128),
        transport: {
          sent: recording.sentMessages,
          edited: recording.editedMessages,
          drafts: recording.drafts,
          callbackAnswers: recording.callbackAnswers,
        },
      };
      assertNoRawProviderProse(ownerVisible);

      await stopService(restartedExecutor);
      const sentCount = recording.sentMessages.length + recording.editedMessages.length;
      const resolvedCount = state.providerResolveCount;
      const replayRun = restarted.harness.behavior.runService("job-executor");
      try {
        await waitForCondition(() => expect(restartedStore.getOutbox(`controller:${fixture.turn.id}:reply`)).toMatchObject({ status: "sent" }));
      } finally {
        await stopService(replayRun);
      }
      expect(recording.sentMessages.length + recording.editedMessages.length).toBe(sentCount);
      expect(state.providerResolveCount).toBe(resolvedCount);
      expect(restarted.harness.inspection.sdk.callsTo("threads.interactions.resolve")).toHaveLength(1);
      expect(state.orderLedger).toEqual([
        "callback-persistence",
        "reopen",
        "provider-get",
        "provider-resolve",
        "resolved-lifecycle",
        "provider-terminal-read",
        "continuation-send",
        "continuation-events",
        "finalization",
        "final-delivery",
      ]);
      await restarted.harness.lifecycle.dispose();
    } finally {
      if (!restartedExecutor.controller.signal.aborted) await stopService(restartedExecutor);
    }
  } finally {
    if (ingressRun !== null && !ingressRun.controller.signal.aborted) await stopService(ingressRun);
    if (!executorRun.controller.signal.aborted) await stopService(executorRun);
    vi.unstubAllGlobals();
  }
});
