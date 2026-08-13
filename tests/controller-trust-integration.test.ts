import type { BbPluginApi } from "@bb/plugin-sdk";
import type Database from "better-sqlite3";
import { afterAll, expect, it, vi } from "vitest";
import plugin from "../server";
import {
  BbControllerAdapter,
  controllerSpawnTitle,
  parseControllerInteractionResolution,
} from "../src/controller/bb-controller";
import { DEFAULT_CONTROLLER_EXECUTION_PROFILE } from "../src/controller/execution-profile";
import { CONTROLLER_INSTRUCTION_SENTINEL } from "../src/controller/instructions";
import { ControllerEvidenceProjector } from "../src/controller/evidence-projector";
import { ControllerInteractionService } from "../src/controller/interaction-service";
import { LunaControllerService } from "../src/controller/service";
import { controllerInteractionToken } from "../src/controller/questions";
import { runJobExecutorService, type JobExecutorTelegram } from "../src/services/job-executor-service";
import { TelegramIngress } from "../src/telegram/ingress";
import type { TelegramUpdate } from "../src/telegram/types";
import { openStore } from "../src/storage/store";
import { policyFixture } from "./helpers";
import { submittedControllerFixture } from "./support/controller-trust-fixtures";

const NOW = 2_000;
const LEASE_MS = 30_000;
const RECOVERY_PROMPT = "Inspect telegram_agent_turn_evidence and call telegram_agent_respond with the evidence already available.";
const RAW_PROVIDER_SENTINEL = "RAW PROVIDER PROSE MUST NOT SHIP";
const NATURAL_RESPONSE = "The enabled project is available.";
const DENIAL_RESPONSE = "The requested command was denied.";

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
  providerGetCount: number;
  providerResolveCount: number;
};

type RecordingMessage = Readonly<{
  chatId: string;
  payload: Record<string, unknown>;
  messageId: number;
}>;

type RecordingTelegram = Omit<JobExecutorTelegram, "answerCallback"> & Readonly<{
  answerCallback: NonNullable<JobExecutorTelegram["answerCallback"]>;
  sentMessages: RecordingMessage[];
  editedMessages: Array<Readonly<{ chatId: string; messageId: number; payload: Record<string, unknown> }>>;
  drafts: Array<Readonly<{ chatId: string; draftId: number; text: string }>>;
  callbackAnswers: Array<Readonly<{ callbackQueryId: string; text: string }>>;
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
    model: DEFAULT_CONTROLLER_EXECUTION_PROFILE.model,
    reasoningLevel: DEFAULT_CONTROLLER_EXECUTION_PROFILE.reasoningLevel,
    permissionMode: DEFAULT_CONTROLLER_EXECUTION_PROFILE.permissionMode,
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
  harness.sdk.stub("threads.timeline", async () => ({ maxSeq: state.maxSeq }));
  harness.sdk.stub("threads.get", async (input: { threadId: string; signal?: AbortSignal }) => ({
    id: input.threadId,
    projectId: state.projectId,
    environmentId: "environment-controller-trust",
    providerId: "claude-code",
    status: state.status,
    archivedAt: null,
    deletedAt: null,
  }));
  harness.sdk.stub("environments.get", async (input: { environmentId: string; signal?: AbortSignal }) => ({
    id: input.environmentId,
    projectId: state.projectId,
    hostId: state.hostId,
    path: "/tmp/controller-trust-project",
    status: "ready",
    workspaceProvisionType: "personal",
  }));
  harness.sdk.stub("threads.events.list", async (input: {
    threadId: string;
    afterSeq?: string;
    limit?: string;
    signal?: AbortSignal;
  }) => state.events
    .filter((row) => row.threadId === input.threadId && row.seq > Number(input.afterSeq ?? "0"))
    .slice(0, Number(input.limit ?? "100")));
  harness.sdk.stub("threads.send", async (input: Record<string, unknown>) => {
    if (!state.afterReopen) throw new Error("continuation was sent before the restart proof");
    expect(input).toEqual(expectedContinuationRequest(state.threadId));
    state.orderLedger.push("continuation-send");
    const continuationEvents = [
      eventRow(state.threadId, 3, "item/agentMessage/delta", { delta: RAW_PROVIDER_SENTINEL }),
      commandApprovalEvent(state.threadId, 4),
      eventRow(state.threadId, 5, "turn/completed", {}),
    ];
    state.events = [...state.events, ...continuationEvents];
    state.maxSeq = 5;
    // Keep the fake provider active for the reconciliation that projects the
    // continuation result; otherwise the service would retry before evidence
    // can be finalized.
    state.status = "active";
    state.orderLedger.push("continuation-events");
    return { ok: true };
  });
  if (!interactionId) return;
  harness.sdk.stub("threads.interactions.get", async (input: {
    threadId: string;
    interactionId: string;
  }) => {
    expect(input.threadId).toBe(state.threadId);
    expect(input.interactionId).toBe(interactionId);
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
    expect(input.threadId).toBe(state.threadId);
    expect(input.interactionId).toBe(interactionId);
    expect(input.resolution).toEqual({ decision: "deny" });
    state.interactionResolution = input.resolution;
    state.interactionStatus = "resolved";
    state.providerResolveCount += 1;
    if (state.afterReopen) state.orderLedger.push("provider-resolve");
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

function evidenceProjector(
  bb: BbPluginApi,
  store: ControllerTrustFixture["store"],
): ControllerEvidenceProjector {
  return new ControllerEvidenceProjector({
    sdk: bb.sdk,
    store,
    clock: { now: () => NOW },
    hanoonToolNames: [...EXPECTED_CONTROLLER_TOOL_NAMES],
  });
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

function buildService(
  bb: BbPluginApi,
  store: ControllerTrustFixture["store"],
): LunaControllerService {
  const signal = new AbortController().signal;
  const projector = evidenceProjector(bb, store);
  const adapter = new BbControllerAdapter({
    sdk: bb.sdk,
    pluginId: bb.pluginId,
    executionProfile: () => DEFAULT_CONTROLLER_EXECUTION_PROFILE,
    now: () => NOW,
    reserveSpawn: (input) => store.reserveControllerSpawn(input),
  });
  const interactionService = new ControllerInteractionService({
    store: {
      isControllerInteractionDeliveryFenceCurrent: (input) =>
        store.isControllerInteractionDeliveryFenceCurrent(input),
      record: (input) => store.recordControllerInteraction(input),
      markResolved: (input) => store.markControllerInteractionResolved(input),
      answerByToken: (input) => store.answerControllerInteractionByToken(input),
      answerWithText: (input) => store.answerControllerInteractionWithText(input),
      getPending: (controllerKey) => store.getPendingControllerInteraction(controllerKey),
      getAnswered: (controllerKey) => store.getAnsweredControllerInteraction(controllerKey),
      markDelivered: (input) => store.markControllerInteractionDelivered(input),
    },
    clock: { now: () => NOW },
    interactions: {
      get: async (threadId, interactionId, interactionSignal) => {
        const snapshot = await adapter.getInteraction!(threadId, interactionId, interactionSignal ?? signal);
        return snapshot;
      },
      resolve: async (input, interactionSignal) => {
        await adapter.resolveInteraction!(
          input.threadId,
          input.interactionId,
          parseControllerInteractionResolution(input.resolution),
          interactionSignal ?? signal,
        );
        return adapter.getInteraction!(input.threadId, input.interactionId, interactionSignal ?? signal);
      },
    },
  });
  return new LunaControllerService({
    store,
    adapter,
    interactionService,
    evidenceProjector: projector,
    clock: { now: () => NOW },
  });
}

function acquireFence(store: ControllerTrustFixture["store"], ownerId: string) {
  const lease = store.acquireExecutorLease(ownerId, NOW, LEASE_MS);
  if (!lease.acquired) throw new Error(`executor lease was not acquired for ${ownerId}`);
  return { ownerId, generation: lease.generation, now: NOW, signal: new AbortController().signal };
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

function recordingTelegramTransport(finalText?: string, onFinalDelivery?: () => void): RecordingTelegram {
  let nextMessageId = 900;
  const sentMessages: RecordingMessage[] = [];
  const editedMessages: Array<Readonly<{ chatId: string; messageId: number; payload: Record<string, unknown> }>> = [];
  const drafts: Array<Readonly<{ chatId: string; draftId: number; text: string }>> = [];
  const callbackAnswers: Array<Readonly<{ callbackQueryId: string; text: string }>> = [];
  const markFinal = (payload: Record<string, unknown>): void => {
    if (finalText !== undefined && payload.text === finalText) onFinalDelivery?.();
  };
  return {
    sentMessages,
    editedMessages,
    drafts,
    callbackAnswers,
    sendMessage: async (chatId, payload) => {
      markFinal(payload);
      const message = { chatId, payload, messageId: nextMessageId++ };
      sentMessages.push(message);
      return { message_id: message.messageId };
    },
    sendMessageDraft: async (chatId, draftId, text) => {
      drafts.push({ chatId, draftId, text });
    },
    editMessage: async (chatId, messageId, payload) => {
      markFinal(payload);
      editedMessages.push({ chatId, messageId, payload });
    },
    answerCallback: async (callbackQueryId, text) => {
      callbackAnswers.push({ callbackQueryId, text });
    },
  };
}

async function runExecutorPass(
  store: ControllerTrustFixture["store"],
  controller: LunaControllerService,
  telegram: JobExecutorTelegram,
  afterWork?: () => Promise<void>,
): Promise<void> {
  const abort = new AbortController();
  let waitCalls = 0;
  await runJobExecutorService({
    store,
    clock: { now: () => NOW },
    controller,
    getTelegramClient: () => telegram,
    releaseOnShutdown: true,
    jitter: () => 0,
    waitForWork: async () => {
      waitCalls += 1;
      if (waitCalls === 1) {
        await afterWork?.();
        abort.abort(new Error("single integration executor pass complete"));
      }
    },
  }, abort.signal);
  expect(waitCalls).toBeGreaterThanOrEqual(1);
}

function productionConfigurationContext(bb: BbPluginApi, store: ControllerTrustFixture["store"]) {
  const controller = store.getControllerForOwner("7", "7");
  const turn = controller?.controllerKey ? store.getPendingControllerTurn(controller.controllerKey) : null;
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
    provider: { id: "claude-code", model: DEFAULT_CONTROLLER_EXECUTION_PROFILE.model },
    origin: { kind: null, pluginId: bb.pluginId },
  };
}

async function assertProductionWiring(
  fixture: ProductionFixture,
  store: ControllerTrustFixture["store"],
): Promise<void> {
  expect(registeredToolNames(fixture)).toEqual(EXPECTED_CONTROLLER_TOOL_NAMES);
  const context = productionConfigurationContext(fixture.bb, store);
  const configured = await fixture.harness.behavior.resolveAgentConfiguration(context);
  expect(configured.tools.map((tool) => tool.name)).toEqual(EXPECTED_CONTROLLER_TOOL_NAMES);
  expect(configured.skills).toEqual([]);
  if (configured.instructions === null) throw new Error("controller instructions were not configured");
  const overlay = store.getControllerOverlay();
  if (overlay === null) throw new Error("controller overlay was not persisted");
  expect(configured.instructions).toContain(CONTROLLER_INSTRUCTION_SENTINEL);
  expect(configured.instructions).toContain(overlay);
  expect(configured.instructions.split(CONTROLLER_INSTRUCTION_SENTINEL)).toHaveLength(2);
  expect(configured.instructions.split(overlay)).toHaveLength(2);

  await fixture.harness.behavior.setSettings({ botToken: null });
  await expect(fixture.harness.behavior.resolveAgentConfiguration(context)).resolves.toEqual({
    tools: [],
    skills: [],
    instructions: null,
  });
  await fixture.harness.behavior.setSettings({ botToken: "123:test-token" });
}

function storedInteractionState(db: Database.Database, interactionId: string): Record<string, unknown> {
  const row = db.prepare(
    `SELECT interaction_id, state, answer_json, answered_at
       FROM controller_interactions
      WHERE interaction_id = ?`,
  ).get(interactionId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("controller interaction was not durable");
  return row;
}

function finalOutbox(store: ControllerTrustFixture["store"], turnId: string) {
  return store.listOutbox(128).filter((item) => item.logicalKey === `controller:${turnId}:reply`);
}

function approvalOutbox(store: ControllerTrustFixture["store"], interactionId: string) {
  return store.listOutbox(128).filter((item) => item.logicalKey.startsWith(`controller-interaction:${interactionId}:`));
}

function callbackOutbox(store: ControllerTrustFixture["store"], callbackId: string) {
  return store.listOutbox(128).filter((item) => item.logicalKey === `callback:${callbackId}`);
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

it("accepts an evidence-bound natural answer through registered tools, reconciliation, and one reply outbox", async () => {
  const fixture = submittedControllerFixture();
  fixture.store.upsertProjectPolicy(policyFixture(), 1_500);
  fixture.store.setControllerOverlay({ text: "Prefer concise summaries.", now: NOW });
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
    providerGetCount: 0,
    providerResolveCount: 0,
  };
  stubControllerSdk(fixture.harness, state);
  await plugin(fixture.bb);
  await fixture.harness.behavior.setSettings({ botToken: "123:test-token" });
  await assertProductionWiring(fixture, fixture.store);

  const signal = new AbortController().signal;
  const toolContext = controllerContext(fixture.store, signal);
  const projects = parseToolResult(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_list_projects",
    {},
    toolContext,
  ));
  const listEvidence = projects._hanoonEvidence as {
    ref: `evidence:${number}`;
    subjectRefs: string[];
  };
  expect(listEvidence.ref).toMatch(/^evidence:[1-9][0-9]*$/);
  expect(listEvidence.subjectRefs).toEqual(["project:proj_1"]);

  const finalizationResult = parseToolResult(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_respond",
    {
      disposition: "answered",
      segments: [{
        type: "claim",
        text: NATURAL_RESPONSE,
        kind: "observed_state",
        outcome: "observed",
        subjectRef: "project:proj_1",
        evidenceRefs: [listEvidence.ref],
      }],
      obligationRefs: [],
    },
    toolContext,
  ));
  expect(finalizationResult).toMatchObject({ outcome: "accepted", ref: expect.stringMatching(/^finalization:/) });

  const service = buildService(fixture.bb, fixture.store);
  await expect(service.reconcile({ ...fixture.fence, signal }, signal)).resolves.toBe(true);
  expect(fixture.store.getAcceptedControllerFinalization(fixture.turn.id)?.consumedAt).toBeNull();
  expect(fixture.store.getControllerTurn(fixture.turn.id)).toMatchObject({ state: "submitted" });
  expect(finalOutbox(fixture.store, fixture.turn.id)).toMatchObject([{
    status: "pending",
    payload: { text: "Hanoon is connecting…", disable_web_page_preview: true },
  }]);
  expect(JSON.stringify(finalOutbox(fixture.store, fixture.turn.id))).not.toContain(NATURAL_RESPONSE);

  state.status = "idle";
  await expect(service.reconcile({ ...fixture.fence, signal }, signal)).resolves.toBe(true);
  const completed = fixture.store.getControllerTurn(fixture.turn.id);
  expect(fixture.store.getAcceptedControllerFinalization(fixture.turn.id)?.consumedAt).toBe(NOW);
  expect(completed).toMatchObject({
    state: "completed",
    responseText: NATURAL_RESPONSE,
    completedAt: NOW,
  });
  expect(fixture.store.readControllerDigest(fixture.turn.controllerKey, 12)).toEqual([{
    ownerText: fixture.turn.inputText,
    agentText: NATURAL_RESPONSE,
  }]);
  expect(finalOutbox(fixture.store, fixture.turn.id)).toHaveLength(1);

  // The production plugin is now disposed while the original lease still
  // fences the durable state; the executor below is the actual delivery path.
  const deliveryHost = await fixture.harness.lifecycle.reload(async () => undefined);
  const deliveryStore = openStore(deliveryHost.bb.storage, deliveryHost.bb.storage.kv, () => NOW);
  expect(deliveryStore.releaseExecutorLease(fixture.fence.ownerId, fixture.fence.generation, NOW)).toBe(true);
  stubControllerSdk(deliveryHost.harness, state);
  const recording = recordingTelegramTransport(NATURAL_RESPONSE, () => state.orderLedger.push("final-delivery"));
  const deliveryService = buildService(deliveryHost.bb, deliveryStore);
  await runExecutorPass(deliveryStore, deliveryService, recording);
  expect(recording.sentMessages.filter((message) => message.payload.text === NATURAL_RESPONSE)).toHaveLength(1);
  expect(recording.editedMessages.filter((message) => message.payload.text === NATURAL_RESPONSE)).toHaveLength(0);
  expect(finalOutbox(deliveryStore, fixture.turn.id)).toMatchObject([{ status: "sent" }]);
  expect(state.orderLedger).toEqual(["final-delivery"]);

  const deliveryCount = recording.sentMessages.length + recording.editedMessages.length;
  await runExecutorPass(deliveryStore, deliveryService, recording);
  expect(recording.sentMessages.length + recording.editedMessages.length).toBe(deliveryCount);
  expect(JSON.stringify(deliveryStore.listOutbox(128))).not.toContain(RAW_PROVIDER_SENTINEL);
  await deliveryHost.harness.lifecycle.dispose();
});

it("restarts across a Telegram approval, resolves the exact BB interaction once, and finalizes only from denial evidence", async () => {
  const fixture = submittedControllerFixture();
  fixture.store.setControllerOverlay({ text: "Prefer concise summaries.", now: NOW });
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
    providerGetCount: 0,
    providerResolveCount: 0,
  };
  stubControllerSdk(fixture.harness, state, interactionId);
  await plugin(fixture.bb);
  await fixture.harness.behavior.setSettings({ botToken: "123:test-token" });
  await assertProductionWiring(fixture, fixture.store);

  const firstService = buildService(fixture.bb, fixture.store);
  const firstSignal = new AbortController().signal;
  await expect(firstService.reconcile({ ...fixture.fence, signal: firstSignal }, firstSignal)).resolves.toBe(true);
  expect(approvalOutbox(fixture.store, interactionId)).toMatchObject([{
    status: "pending",
    payload: { reply_markup: { inline_keyboard: [[{ text: "Allow once" }], [{ text: "Deny" }]] } },
  }]);

  const recording = recordingTelegramTransport(DENIAL_RESPONSE, () => state.orderLedger.push("final-delivery"));
  const ingress = new TelegramIngress({
    store: fixture.store,
    telegram: recording,
    onWorkAvailable: () => undefined,
  });
  expect(fixture.store.releaseExecutorLease(fixture.fence.ownerId, fixture.fence.generation, NOW)).toBe(true);
  await runExecutorPass(fixture.store, firstService, recording, async () => {
    const prompt = recording.sentMessages.find((message) => {
      const markup = message.payload.reply_markup as { inline_keyboard?: unknown } | undefined;
      return Array.isArray(markup?.inline_keyboard);
    });
    if (!prompt) throw new Error("actual executor did not send the approval prompt");
    expect(prompt.payload.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "Allow once", callback_data: `i:${controllerInteractionToken(interactionId, "allow_once")}` }],
        [{ text: "Deny", callback_data: `i:${controllerInteractionToken(interactionId, "deny")}` }],
      ],
    });
    await ingress.handleClaimed(
      telegramCallback(controllerInteractionToken(interactionId, "deny"), 70_001, prompt.messageId),
      NOW,
    );
    expect(fixture.store.getAnsweredControllerInteraction(controller.controllerKey)).toMatchObject({
      interactionId,
      resolution: { decision: "deny" },
    });
    state.orderLedger.push("callback-persistence");
  });
  expect(recording.sentMessages.filter((message) => Array.isArray(
    (message.payload.reply_markup as { inline_keyboard?: unknown } | undefined)?.inline_keyboard,
  ))).toHaveLength(1);

  const restarted = await fixture.harness.lifecycle.reload(async (bb) => {
    await plugin(bb);
  });
  state.afterReopen = true;
  state.orderLedger.push("reopen");
  const restartedStore = openStore(restarted.bb.storage, restarted.bb.storage.kv, () => NOW);
  expect(state.events).toEqual([pendingEvent]);
  expect(state.maxSeq).toBe(1);
  expect(state.interactionStatus).toBe("pending");
  expect(state.interactionResolution).toBeNull();
  await assertProductionWiring(restarted, restartedStore);
  stubControllerSdk(restarted.harness, state, interactionId);

  const restartFence = acquireFence(restartedStore, "restart-executor");
  const restartSignal = restartFence.signal;
  const restartedService = buildService(restarted.bb, restartedStore);
  await expect(restartedService.reconcile(restartFence, restartSignal)).resolves.toBe(true);
  expect(restarted.harness.inspection.sdk.callsTo("threads.interactions.get")).toHaveLength(2);
  expect(restarted.harness.inspection.sdk.callsTo("threads.interactions.get")).toEqual([
    [{ threadId: controller.threadId, interactionId, signal: expect.any(AbortSignal) }],
    [{ threadId: controller.threadId, interactionId, signal: expect.any(AbortSignal) }],
  ]);
  expect(restarted.harness.inspection.sdk.callsTo("threads.interactions.resolve")).toHaveLength(1);
  expect(restarted.harness.inspection.sdk.callsTo("threads.interactions.resolve")[0]).toEqual([{
    threadId: controller.threadId,
    interactionId,
    resolution: { decision: "deny" },
  }]);
  expect(storedInteractionState(restarted.bb.storage.database(), interactionId)).toMatchObject({
    interaction_id: interactionId,
    state: "delivered",
    answer_json: expect.stringContaining('"decision":"deny"'),
  });
  expect(state.events).toHaveLength(2);
  expect(state.events[1]).toMatchObject({
    seq: 2,
    type: "system/permissionGrant/lifecycle",
    data: { interactionId, status: "resolved" },
  });
  expect(state.orderLedger).toEqual([
    "callback-persistence",
    "reopen",
    "provider-get",
    "provider-resolve",
    "resolved-lifecycle",
    "provider-terminal-read",
  ]);

  await expect(restartedService.reconcile(restartFence, restartSignal)).resolves.toBe(true);
  const continuationCall = restarted.harness.inspection.sdk.callsTo("threads.send");
  expect(continuationCall).toHaveLength(1);
  expect(continuationCall[0]).toEqual([expectedContinuationRequest(controller.threadId)]);
  expect(state.events).toHaveLength(5);
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

  await expect(restartedService.reconcile(restartFence, restartSignal)).resolves.toBe(true);
  const denialEvidence = restartedStore.listControllerEvidence(fixture.turn.id, 128).find(
    (row) => row.sourceKind === "bb_item" && row.sourceItemId === "command-approval-1",
  );
  expect(denialEvidence).toMatchObject({
    outcome: "denied",
    proofKinds: ["command_result"],
    subjectRefs: ["bb-item:command-approval-1"],
  });
  if (!denialEvidence) throw new Error("denial evidence was not reconciled");
  const streamed = restartedStore.getControllerTurn(fixture.turn.id);
  expect(streamed?.streamText).not.toContain(RAW_PROVIDER_SENTINEL);
  expect(streamed?.streamPhase).toBe("complete");

  state.status = "idle";
  const finalization = parseToolResult(await restarted.harness.behavior.callAgentTool(
    "telegram_agent_respond",
    finalizationClaim(denialEvidence.ref),
    controllerContext(restartedStore, restartSignal),
  ));
  expect(finalization).toMatchObject({ outcome: "accepted", ref: expect.stringMatching(/^finalization:/) });
  state.orderLedger.push("finalization");
  await expect(restartedService.reconcile(restartFence, restartSignal)).resolves.toBe(true);

  expect(restartedStore.getControllerTurn(fixture.turn.id)).toMatchObject({
    state: "completed",
    responseText: DENIAL_RESPONSE,
  });
  expect(restartedStore.getAcceptedControllerFinalization(fixture.turn.id)?.consumedAt).toBe(NOW);
  expect(restartedStore.readControllerDigest(controller.controllerKey, 12)).toEqual([{
    ownerText: fixture.turn.inputText,
    agentText: DENIAL_RESPONSE,
  }]);
  expect(JSON.stringify(restartedStore.readControllerDigest(controller.controllerKey, 12))).not.toContain(RAW_PROVIDER_SENTINEL);
  expect(finalOutbox(restartedStore, fixture.turn.id)).toHaveLength(1);
  expect(JSON.stringify(finalOutbox(restartedStore, fixture.turn.id))).not.toContain(RAW_PROVIDER_SENTINEL);
  expect(JSON.stringify(restartedStore.listOutbox(128))).not.toContain(RAW_PROVIDER_SENTINEL);
  expect(JSON.stringify(restartedStore.getControllerTurn(fixture.turn.id))).not.toContain(RAW_PROVIDER_SENTINEL);

  const deliveryHost = await restarted.harness.lifecycle.reload(async () => undefined);
  const deliveryStore = openStore(deliveryHost.bb.storage, deliveryHost.bb.storage.kv, () => NOW);
  expect(deliveryStore.releaseExecutorLease(restartFence.ownerId, restartFence.generation, NOW)).toBe(true);
  stubControllerSdk(deliveryHost.harness, state, interactionId);
  const deliveryService = buildService(deliveryHost.bb, deliveryStore);
  await runExecutorPass(deliveryStore, deliveryService, recording);

  expect(recording.sentMessages.filter((message) => Array.isArray(
    (message.payload.reply_markup as { inline_keyboard?: unknown } | undefined)?.inline_keyboard,
  ))).toHaveLength(1);
  const finalDeliveries = [
    ...recording.sentMessages.filter((message) => message.payload.text === DENIAL_RESPONSE),
    ...recording.editedMessages.filter((message) => message.payload.text === DENIAL_RESPONSE),
  ];
  expect(finalDeliveries).toHaveLength(1);
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
  expect(storedInteractionState(deliveryHost.bb.storage.database(), interactionId)).toMatchObject({ state: "delivered" });
  expect(approvalOutbox(deliveryStore, interactionId)).toMatchObject([{ status: "sent" }]);
  expect(callbackOutbox(deliveryStore, "callback-70001")).toMatchObject([{ status: "sent" }]);
  expect(finalOutbox(deliveryStore, fixture.turn.id)).toMatchObject([{ status: "sent" }]);
  const ownerVisible = JSON.stringify({
    outbox: deliveryStore.listOutbox(128),
    sent: recording.sentMessages,
    edited: recording.editedMessages,
    drafts: recording.drafts,
    final: deliveryStore.getControllerTurn(fixture.turn.id)?.responseText,
  });
  expect(ownerVisible).not.toContain(RAW_PROVIDER_SENTINEL);

  const sentCount = recording.sentMessages.length + recording.editedMessages.length;
  const resolveCount = state.providerResolveCount;
  await runExecutorPass(deliveryStore, deliveryService, recording);
  expect(recording.sentMessages.length + recording.editedMessages.length).toBe(sentCount);
  expect(state.providerResolveCount).toBe(resolveCount);
  expect(restarted.harness.inspection.sdk.callsTo("threads.interactions.resolve")).toHaveLength(1);
  await deliveryHost.harness.lifecycle.dispose();
});
