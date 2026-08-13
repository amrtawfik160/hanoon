import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it } from "vitest";
import {
  BbControllerAdapter,
  parseControllerInteractionResolution,
} from "../src/controller/bb-controller";
import {
  DEFAULT_CONTROLLER_EXECUTION_PROFILE,
} from "../src/controller/execution-profile";
import { ControllerEvidenceProjector } from "../src/controller/evidence-projector";
import { ControllerInteractionService } from "../src/controller/interaction-service";
import { LunaControllerService } from "../src/controller/service";
import { CONTROLLER_TOOL_NAMES, registerControllerTools } from "../src/controller/tools";
import { controllerInteractionToken } from "../src/controller/questions";
import { TelegramIngress } from "../src/telegram/ingress";
import type { TelegramUpdate } from "../src/telegram/types";
import { openStore } from "../src/storage/store";
import { policyFixture } from "./helpers";
import { submittedControllerFixture } from "./support/controller-trust-fixtures";

const NOW = 2_000;
const EXECUTOR_OWNER = "executor";
const LEASE_MS = 30_000;

type ControllerTrustFixture = ReturnType<typeof submittedControllerFixture>;
type EventRow = Record<string, unknown> & {
  threadId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
};

type FakeControllerSdkState = {
  threadId: string;
  projectId: string;
  hostId: string;
  status: "active" | "idle";
  maxSeq: number;
  events: EventRow[];
  interactionStatus: "pending" | "resolved";
  interactionResolution: Record<string, unknown> | null;
};

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
  harness.sdk.stub("threads.send", async () => ({ ok: true }));
  if (!interactionId) return;
  harness.sdk.stub("threads.interactions.get", async () => fakeControllerInteraction(state, interactionId));
  harness.sdk.stub("threads.interactions.resolve", async (input: {
    threadId: string;
    interactionId: string;
    resolution: Record<string, unknown>;
  }) => {
    expect(input.threadId).toBe(state.threadId);
    expect(input.interactionId).toBe(interactionId);
    state.interactionResolution = input.resolution;
    state.interactionStatus = "resolved";
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
    hanoonToolNames: CONTROLLER_TOOL_NAMES,
  });
}

function registerTrustTools(
  bb: BbPluginApi,
  store: ControllerTrustFixture["store"],
  projector: ControllerEvidenceProjector,
): void {
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    evidenceProjector: projector,
    threadOperations: {
      request: async () => {
        throw new Error("thread operation is outside this integration scenario");
      },
    },
    health: () => ({ ok: true }),
    notify: () => undefined,
    now: () => NOW,
  });
}

function registeredToolNames(fixture: ControllerTrustFixture): string[] {
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
  signal: AbortSignal,
): LunaControllerService {
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

function controllerFence(fixture: ControllerTrustFixture, signal: AbortSignal) {
  return { ...fixture.fence, signal };
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

function telegramCallback(token: string, updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 7, is_bot: false },
      message: {
        message_id: 800 + updateId,
        chat: { id: 7, type: "private" },
      },
      data: `i:${token}`,
    },
  };
}

function fakeTelegramTransport() {
  return {
    sendMessage: async () => ({ message_id: 900 }),
    editMessage: async () => undefined,
    answerCallback: async () => undefined,
  };
}

function finalizationClaim(evidenceRef: string, outcome: "failed" | "succeeded") {
  return {
    disposition: "answered",
    segments: [{
      type: "claim",
      text: outcome === "failed" ? "The requested command was denied." : "The requested command succeeded.",
      kind: "execution_result",
      outcome,
      subjectRef: "bb-item:command-approval-1",
      evidenceRefs: [evidenceRef],
    }],
    obligationRefs: [],
  };
}

it("accepts an evidence-bound natural answer through registered tools, reconciliation, and one reply outbox", async () => {
  const fixture = submittedControllerFixture();
  fixture.store.upsertProjectPolicy(policyFixture(), 1_500);
  const signal = new AbortController().signal;
  const controller = fixture.store.getControllerForOwner("7", "7");
  if (!controller?.threadId || !controller.projectId) throw new Error("controller fixture is incomplete");
  const state: FakeControllerSdkState = {
    threadId: controller.threadId,
    projectId: controller.projectId,
    hostId: controller.hostId ?? "host_1",
    status: "idle",
    maxSeq: 0,
    events: [],
    interactionStatus: "pending",
    interactionResolution: null,
  };
  stubControllerSdk(fixture.harness, state);
  registerTrustTools(fixture.bb, fixture.store, evidenceProjector(fixture.bb, fixture.store));

  expect(registeredToolNames(fixture)).toEqual(CONTROLLER_TOOL_NAMES);
  const toolContext = controllerContext(fixture.store, signal);
  const projects = parseToolResult(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_list_projects",
    {},
    { ...toolContext, signal },
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
        text: "The enabled project is available.",
        kind: "observed_state",
        outcome: "observed",
        subjectRef: "project:proj_1",
        evidenceRefs: [listEvidence.ref],
      }],
      obligationRefs: [],
    },
    { ...toolContext, signal },
  ));
  expect(finalizationResult).toMatchObject({ outcome: "accepted", ref: expect.stringMatching(/^finalization:/) });

  const service = buildService(fixture.bb, fixture.store, signal);
  await expect(service.reconcile(controllerFence(fixture, signal), signal)).resolves.toBe(true);

  const accepted = fixture.store.getAcceptedControllerFinalization(fixture.turn.id);
  const completed = fixture.store.getControllerTurn(fixture.turn.id);
  const finalOutbox = fixture.store.listOutbox(20).filter(
    (item) => item.logicalKey === `controller:${fixture.turn.id}:reply`,
  );
  const leasedReply = fixture.store.leaseOutbox(
    EXECUTOR_OWNER,
    fixture.fence.generation,
    NOW,
    20,
    LEASE_MS,
  ).filter((item) => item.logicalKey === `controller:${fixture.turn.id}:reply`);

  expect(accepted).not.toBeNull();
  expect(accepted?.consumedAt).toBe(NOW);
  expect(completed).toMatchObject({
    state: "completed",
    responseText: "The enabled project is available.",
    completedAt: NOW,
  });
  expect(fixture.store.readControllerDigest(fixture.turn.controllerKey, 12)).toEqual([{
    ownerText: fixture.turn.inputText,
    agentText: "The enabled project is available.",
  }]);
  expect(finalOutbox).toHaveLength(1);
  expect(leasedReply).toHaveLength(1);
  expect(leasedReply[0]?.payload).toEqual({
    text: "The enabled project is available.",
    disable_web_page_preview: true,
  });
});

it("restarts across a Telegram approval, resolves the exact BB interaction once, and finalizes only from denial evidence", async () => {
  const fixture = submittedControllerFixture();
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
  };
  stubControllerSdk(fixture.harness, state, interactionId);
  const firstSignal = new AbortController().signal;
  const firstService = buildService(fixture.bb, fixture.store, firstSignal);
  await expect(firstService.reconcile(controllerFence(fixture, firstSignal), firstSignal)).resolves.toBe(true);

  const initialOutbox = fixture.store.leaseOutbox(
    EXECUTOR_OWNER,
    fixture.fence.generation,
    NOW,
    20,
    LEASE_MS,
  );
  const prompt = initialOutbox.find((item) => item.logicalKey.startsWith(`controller-interaction:${interactionId}:`));
  const replyMarkup = prompt?.payload.reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
  } | undefined;
  expect(replyMarkup?.inline_keyboard.map((row) => row.map((button) => button.text))).toEqual([
    ["Allow once"],
    ["Deny"],
  ]);
  const promptButtons = replyMarkup?.inline_keyboard.flat() ?? [];
  expect(promptButtons.map((button) => button.callback_data)).toEqual([
    `i:${controllerInteractionToken(interactionId, "allow_once")}`,
    `i:${controllerInteractionToken(interactionId, "deny")}`,
  ]);
  expect(promptButtons.map((button) => button.text)).not.toContain("Allow all session");

  const ingress = new TelegramIngress({
    store: fixture.store,
    telegram: fakeTelegramTransport(),
    onWorkAvailable: () => undefined,
  });
  await ingress.handleClaimed(
    telegramCallback(controllerInteractionToken(interactionId, "deny"), 70_001),
    NOW,
  );
  expect(fixture.store.getAnsweredControllerInteraction(controller.controllerKey)).toMatchObject({
    interactionId,
    resolution: { decision: "deny" },
  });

  const restarted = await fixture.harness.lifecycle.reload(async () => undefined);
  const restartedStore = openStore(restarted.bb.storage, restarted.bb.storage.kv, () => NOW);
  const restartedState = state;
  restartedState.status = "idle";
  restartedState.maxSeq = 5;
  restartedState.events = [
    pendingEvent,
    eventRow(controller.threadId, 2, "system/permissionGrant/lifecycle", {
      interactionId,
      status: "resolved",
    }),
    eventRow(controller.threadId, 3, "item/agentMessage/delta", {
      delta: "RAW PROVIDER PROSE MUST NOT SHIP",
    }),
    commandApprovalEvent(controller.threadId, 4),
    eventRow(controller.threadId, 5, "turn/completed", {}),
  ];
  stubControllerSdk(restarted.harness, restartedState, interactionId);
  registerTrustTools(
    restarted.bb,
    restartedStore,
    evidenceProjector(restarted.bb, restartedStore),
  );
  expect(restarted.harness.inspection.registrations.agentTools).toHaveLength(23);

  const restartSignal = new AbortController().signal;
  const restartedService = buildService(restarted.bb, restartedStore, restartSignal);
  await expect(restartedService.reconcile(
    { ...fixture.fence, signal: restartSignal },
    restartSignal,
  )).resolves.toBe(true);
  expect(restarted.harness.inspection.sdk.callsTo("threads.interactions.resolve")).toHaveLength(1);
  expect(restarted.harness.inspection.sdk.callsTo("threads.interactions.resolve")[0]).toEqual([{
    threadId: controller.threadId,
    interactionId,
    resolution: { decision: "deny" },
  }]);

  await expect(restartedService.reconcile(
    { ...fixture.fence, signal: restartSignal },
    restartSignal,
  )).resolves.toBe(true);
  const denialEvidence = restartedStore.listControllerEvidence(fixture.turn.id, 128).find(
    (row) => row.sourceKind === "bb_item" && row.sourceItemId === "command-approval-1",
  );
  expect(denialEvidence).toMatchObject({
    outcome: "denied",
    proofKinds: ["command_result"],
    subjectRefs: ["bb-item:command-approval-1"],
  });
  if (!denialEvidence) throw new Error("denial evidence was not reconciled");
  expect(restarted.harness.inspection.sdk.callsTo("threads.send")).toContainEqual([
    expect.objectContaining({
      threadId: controller.threadId,
      mode: "start",
    }),
  ]);

  const finalization = parseToolResult(await restarted.harness.behavior.callAgentTool(
    "telegram_agent_respond",
    finalizationClaim(denialEvidence.ref, "failed"),
    controllerContext(restartedStore, restartSignal),
  ));
  expect(finalization).toMatchObject({ outcome: "accepted", ref: expect.stringMatching(/^finalization:/) });
  await expect(restartedService.reconcile(
    { ...fixture.fence, signal: restartSignal },
    restartSignal,
  )).resolves.toBe(true);

  const completed = restartedStore.getControllerTurn(fixture.turn.id);
  const finalMessages = restartedStore.listOutbox(20).filter(
    (item) => item.logicalKey === `controller:${fixture.turn.id}:reply`,
  );
  expect(completed).toMatchObject({
    state: "completed",
    responseText: "The requested command was denied.",
  });
  expect(restartedStore.getAcceptedControllerFinalization(fixture.turn.id)?.consumedAt).toBe(NOW);
  expect(finalMessages).toHaveLength(1);
  expect(JSON.stringify(finalMessages[0]?.payload)).not.toContain("RAW PROVIDER PROSE MUST NOT SHIP");
  expect(restartedStore.readControllerDigest(controller.controllerKey, 12)).toEqual([{
    ownerText: fixture.turn.inputText,
    agentText: "The requested command was denied.",
  }]);
});
