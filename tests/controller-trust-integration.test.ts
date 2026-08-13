import { existsSync } from "node:fs";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { BbControllerAdapter } from "../src/controller/bb-controller";
import { ControllerEvidenceProjector } from "../src/controller/evidence-projector";
import { ControllerInteractionService } from "../src/controller/interaction-service";
import { ControllerInteractionRepository } from "../src/storage/controller-interaction-repository";
import { LunaControllerService } from "../src/controller/service";
import { CONTROLLER_TOOL_NAMES, registerControllerTools } from "../src/controller/tools";
import { DEFAULT_CONTROLLER_EXECUTION_PROFILE } from "../src/controller/execution-profile";
import { threadDecisionToken } from "../src/controller/questions";
import { TelegramIngress } from "../src/telegram/ingress";
import { policyFixture } from "./helpers";
import type { SendMessagePayload, TelegramUpdate } from "../src/telegram/types";

const OWNER = "7";
const THREAD_ID = "thr_trust_controller";
const PROJECT_ID = "proj_trust";
const HOST_ID = "host_trust";
const ENVIRONMENT_ID = "env_trust";
const PROJECT_ROOT = "/private/trust";
const INTERACTION_ID = "pint_trust_approval";

let hostNumber = 0;

class FakeTelegram {
  public readonly sent: { chatId: string; payload: SendMessagePayload }[] = [];
  public readonly answered: { callbackId: string; text: string }[] = [];
  private nextMessageId = 500;

  public async sendMessage(chatId: string, payload: SendMessagePayload): Promise<{ message_id: number }> {
    this.sent.push({ chatId, payload });
    return { message_id: this.nextMessageId++ };
  }

  public async editMessage(): Promise<void> {}

  public async answerCallback(callbackId: string, text: string): Promise<void> {
    this.answered.push({ callbackId, text });
  }
}

type ThreadPhase = {
  status: string;
  maxSeq: number;
  events: readonly Record<string, unknown>[];
  interaction: Record<string, unknown>;
};

type SdkOptions = Partial<ThreadPhase>;

/**
 * One registered controller on the real fake BB host, over the real file-backed
 * SQLite database that host owns. Nothing here injects evidence, finalization,
 * or completion rows: every durable row below is written by the production path
 * under a real executor lease.
 */
function trustFixture(options: SdkOptions = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: `telegram-trust-${hostNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  const databasePath = bb.storage.database().name;
  expect(existsSync(databasePath)).toBe(true);

  store.upsertProjectPolicy(policyFixture(), 1_500);
  store.createPairingCode(hashSecret("pair-trust"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-trust"), OWNER, OWNER, 1_001)).toEqual({ ok: true });
  const lease = store.acquireExecutorLease("executor", 2_000, 60 * 60_000);
  if (!lease.acquired) throw new Error("executor lease was unavailable");
  const fence = { ownerId: "executor", generation: lease.generation, now: 2_000 };
  const signal = AbortSignal.timeout(5_000);

  const phase: ThreadPhase = {
    status: options.status ?? "idle",
    maxSeq: options.maxSeq ?? 0,
    events: options.events ?? [],
    interaction: options.interaction ?? { id: INTERACTION_ID, threadId: THREAD_ID, status: "pending", payload: null },
  };
  const resolveInteraction = vi.fn(async () => ({
    id: INTERACTION_ID, threadId: THREAD_ID, status: "resolved",
  }));
  // Addressed exactly, so a mis-addressed fetch fails loudly instead of being
  // answered by a stub that ignores its arguments.
  const getInteraction = vi.fn(async (input: { threadId: string; interactionId: string }) => {
    if (input.threadId !== THREAD_ID || input.interactionId !== INTERACTION_ID) {
      throw new Error(`no interaction ${input.interactionId} on ${input.threadId}`);
    }
    return phase.interaction;
  });
  harness.sdk.stub("threads.get", async () => ({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    status: phase.status,
    providerId: "claude-code",
    archivedAt: null,
    deletedAt: null,
  }));
  harness.sdk.stub("environments.get", async () => ({
    id: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    hostId: HOST_ID,
    path: PROJECT_ROOT,
    status: "ready",
    workspaceProvisionType: "personal",
  }));
  harness.sdk.stub("threads.timeline", async () => ({ maxSeq: phase.maxSeq }));
  harness.sdk.stub("threads.events.list", async ({ afterSeq = "0", limit = "100" }) => {
    const after = Number(afterSeq);
    return phase.events
      .filter((row) => Number(row.seq) > after)
      .slice(0, Number(limit))
      .map((row) => ({ ...row, threadId: THREAD_ID }));
  });
  harness.sdk.stub("threads.interactions.get", getInteraction);
  harness.sdk.stub("threads.interactions.resolve", resolveInteraction);
  harness.sdk.stub("projects.list", async () => [{
    id: PROJECT_ID,
    kind: "personal",
    name: "Personal",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: [{
      id: "src_trust", projectId: PROJECT_ID, isDefault: true, createdAt: 1, updatedAt: 1,
      type: "local_path", hostId: HOST_ID, path: PROJECT_ROOT,
    }],
  }]);

  const evidenceProjector = new ControllerEvidenceProjector({
    sdk: bb.sdk,
    store,
    clock: { now: () => 2_100 },
    hanoonToolNames: CONTROLLER_TOOL_NAMES,
  });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    evidenceProjector,
    threadOperations: { request: async () => { throw new Error("thread operations are out of this path"); } },
    health: () => ({ ok: true }),
    notify: () => undefined,
    now: () => 2_100,
  });

  const turn = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: OWNER,
    telegramChatId: OWNER,
    updateId: 4_100 + hostNumber,
    inputText: "which projects can you work on?",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    ...fence, turnId: turn.id, projectId: PROJECT_ID, hostId: HOST_ID, threadId: THREAD_ID,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, turnId: turn.id })).toBe(true);

  const adapter = new BbControllerAdapter({
    sdk: bb.sdk,
    pluginId: bb.pluginId,
    executionProfile: () => DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  });
  const interactionService = new ControllerInteractionService({
    store: new ControllerInteractionRepository(bb.storage.database()),
    interactions: bb.sdk.threads.interactions,
    clock: () => 2_100,
  });
  const service = new LunaControllerService({
    store, adapter, evidenceProjector, interactionService, clock: { now: () => 2_100 },
  });
  const toolContext = { threadId: THREAD_ID, projectId: PROJECT_ID, signal };
  return {
    phase,
    bb, harness, store, databasePath, turn, fence, signal, service, adapter,
    evidenceProjector, interactionService, resolveInteraction, getInteraction, toolContext,
    reopen: () => openStore(bb.storage, bb.storage.kv, () => 2_000),
  };
}

function callTool(
  fixture: ReturnType<typeof trustFixture>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return fixture.harness.behavior.callAgentTool(name, args, {
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
  });
}

/** Delivers whatever the durable outbox holds through the ordinary lease path. */
async function deliverOutbox(
  store: TelegramAgentStore,
  fence: { ownerId: string; generation: number },
  telegram: FakeTelegram,
  now: number,
): Promise<number> {
  const leased = store.leaseOutbox(fence.ownerId, fence.generation, now, 10, 30_000);
  for (const item of leased) {
    const sent = await telegram.sendMessage(item.chatId, item.payload as SendMessagePayload);
    expect(store.completeOutbox(item.logicalKey, fence.ownerId, fence.generation, sent.message_id, now)).toBe(true);
  }
  return leased.length;
}

function callbackUpdate(updateId: number, callbackId: string, data: string, userId = 7, chatId = 7): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: { id: userId, is_bot: false },
      message: { message_id: 900, chat: { id: chatId, type: "private" } },
      data,
    },
  } as TelegramUpdate;
}

function nativeCommandEvent(seq: number) {
  return {
    id: `event_${seq}`,
    seq,
    createdAt: 1_000 + seq,
    scope: { kind: "thread" },
    type: "item/completed",
    data: {
      providerThreadId: "provider_thread",
      item: {
        type: "commandExecution",
        id: `cmd_${seq}`,
        command: "printf provider-only-secret",
        cwd: PROJECT_ROOT,
        status: "completed",
        approvalStatus: null,
      },
    },
  };
}

it("answers one owner turn end to end through the registered trust path", async () => {
  const fixture = trustFixture({ maxSeq: 2, events: [nativeCommandEvent(2)] });
  const telegram = new FakeTelegram();

  expect(fixture.harness.registrations.agentTools.map((tool) => tool.name)).toEqual([...CONTROLLER_TOOL_NAMES]);
  expect(CONTROLLER_TOOL_NAMES).toHaveLength(23);

  const projects = JSON.parse(await callTool(fixture, "telegram_agent_list_projects", {}) as string);
  expect(projects.projects).toHaveLength(1);
  expect(projects.projects[0]).toMatchObject({ id: policyFixture().projectId });

  const index = JSON.parse(await callTool(fixture, "telegram_agent_turn_evidence", {}) as string);
  // The projector's own BB-native row is indexed beside the Hanoon tool's, and
  // the raw command never reaches the bounded projection.
  expect(index.evidence).toHaveLength(2);
  expect(index.evidence.map((row: { source: string }) => row.source))
    .toEqual(["telegram_agent_list_projects", "commandExecution"]);
  expect(index.evidence[1]).toMatchObject({ ref: "evidence:2", proofKinds: ["command_result"] });
  expect(JSON.stringify(index)).not.toContain("provider-only-secret");
  const hanoonEvidence = index.evidence[0];
  const evidenceRef = hanoonEvidence.ref as string;
  expect(evidenceRef).toBe("evidence:1");
  expect(hanoonEvidence).toMatchObject({
    source: "telegram_agent_list_projects",
    outcome: "observed",
    proofKinds: ["project_state"],
  });
  expect(hanoonEvidence.subjectRefs).toEqual([`project:${policyFixture().projectId}`]);
  const subjectRef = hanoonEvidence.subjectRefs[0] as string;

  const accepted = JSON.parse(await callTool(fixture, "telegram_agent_respond", {
    disposition: "answered",
    segments: [{
      type: "claim",
      text: "You have one project I can work on.",
      kind: "observed_state",
      outcome: "observed",
      subjectRef,
      evidenceRefs: [evidenceRef],
    }],
    obligationRefs: [],
  }) as string);
  expect(accepted).toMatchObject({ outcome: "accepted", ref: "finalization:1" });

  await expect(fixture.service.reconcile(
    { ...fixture.fence, signal: fixture.signal },
    fixture.signal,
  )).resolves.toBe(true);

  const completed = fixture.store.getControllerTurn(fixture.turn.id);
  expect(completed).toMatchObject({
    state: "completed",
    responseText: "You have one project I can work on.",
    evidenceEventSeq: 2,
  });
  const finalization = fixture.store.getAcceptedControllerFinalization(fixture.turn.id);
  expect(finalization?.consumedAt).toBe(2_100);
  expect(fixture.store.listControllerTurns("owner-7-controller", 10)).toHaveLength(1);
  expect(fixture.store.readControllerDigest("owner-7-controller", 10)).toEqual([{
    ownerText: "which projects can you work on?",
    agentText: "You have one project I can work on.",
  }]);

  const reply = fixture.store.getOutbox(`controller:${fixture.turn.id}:reply`);
  expect(reply?.payload.text).toBe("You have one project I can work on.");
  expect(await deliverOutbox(fixture.store, fixture.fence, telegram, 2_200)).toBe(1);
  expect(telegram.sent.map((message) => message.payload.text)).toEqual(["You have one project I can work on."]);
  expect(await deliverOutbox(fixture.store, fixture.fence, telegram, 2_300)).toBe(0);
  expect(telegram.sent).toHaveLength(1);
});

it("bridges one permission interaction to Telegram and back across a restart", async () => {
  const commandInteraction = {
    id: INTERACTION_ID,
    threadId: THREAD_ID,
    status: "pending",
    payload: {
      kind: "approval",
      subject: { kind: "command", command: "npm test", cwd: null },
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    },
  };
  const fixture = trustFixture({
    // The thread is working and blocked on the owner, not finished.
    status: "active",
    maxSeq: 5,
    interaction: commandInteraction,
    events: [{
      id: "e5",
      seq: 5,
      createdAt: 5,
      scope: { kind: "turn" },
      type: "system/permissionGrant/lifecycle",
      data: {
        interactionId: INTERACTION_ID,
        providerId: "claude-code",
        status: "pending",
        resolution: null,
        subject: { kind: "permission_grant", itemId: "item_1", toolName: "bash", permissions: {} },
      },
    }],
  });
  const telegram = new FakeTelegram();
  const ingress = new TelegramIngress({ store: fixture.store, telegram, onWorkAvailable: () => undefined });

  await expect(fixture.service.reconcile(
    { ...fixture.fence, signal: fixture.signal },
    fixture.signal,
  )).resolves.toBe(true);

  const asked = fixture.store.getOutbox(`controller-interaction:${INTERACTION_ID}:0`);
  expect(asked?.payload.reply_markup).toEqual({
    inline_keyboard: [
      [{ text: "Allow once", callback_data: `i:${threadDecisionToken(INTERACTION_ID, "allow_once")}` }],
      [{ text: "Deny", callback_data: `i:${threadDecisionToken(INTERACTION_ID, "deny")}` }],
    ],
  });
  expect(JSON.stringify(asked)).not.toContain("allow_for_session");
  expect(JSON.stringify(asked)).not.toContain("Allow all session");
  expect(fixture.store.getControllerTurn(fixture.turn.id)?.awaitingInteractionId).toBe(INTERACTION_ID);

  const allowOnce = `i:${threadDecisionToken(INTERACTION_ID, "allow_once")}`;
  // A session-wide grant is not merely unrendered: its token cannot settle the
  // interaction even when the owner presents it.
  await ingress.handleClaimed(
    callbackUpdate(509, "cb-session", `i:${threadDecisionToken(INTERACTION_ID, "allow_for_session")}`),
    2_149,
  );
  expect(fixture.store.getAnsweredControllerInteraction("owner-7-controller")).toBeNull();
  expect(fixture.store.getPendingControllerInteraction("owner-7-controller")?.state).toBe("pending");

  await ingress.handleClaimed(callbackUpdate(510, "cb-wrong-user", allowOnce, 8, 7), 2_150);
  await ingress.handleClaimed(callbackUpdate(511, "cb-wrong-chat", allowOnce, 7, 8), 2_151);
  expect(fixture.store.getAnsweredControllerInteraction("owner-7-controller")).toBeNull();
  expect(fixture.resolveInteraction).not.toHaveBeenCalled();

  await ingress.handleClaimed(callbackUpdate(512, "cb-owner", allowOnce), 2_160);

  // The tap is durable before BB hears anything about it.
  expect(fixture.store.getAnsweredControllerInteraction("owner-7-controller")).toMatchObject({
    interactionId: INTERACTION_ID,
    answer: { decision: "allow_once", grantedPermissions: null },
  });
  expect(fixture.resolveInteraction).not.toHaveBeenCalled();

  // A replayed tap and a second decision both fail closed.
  await ingress.handleClaimed(callbackUpdate(513, "cb-owner", allowOnce), 2_161);
  await ingress.handleClaimed(
    callbackUpdate(514, "cb-second", `i:${threadDecisionToken(INTERACTION_ID, "deny")}`),
    2_162,
  );
  expect(fixture.store.getAnsweredControllerInteraction("owner-7-controller")?.answer)
    .toEqual({ decision: "allow_once", grantedPermissions: null });

  // Restart between the durable tap and the BB resolution.
  // A fresh store and service over the same durable database: no in-memory
  // state from the tap survives into the resolution path.
  const restartedStore = fixture.reopen();
  const restarted = new LunaControllerService({
    store: restartedStore,
    adapter: fixture.adapter,
    evidenceProjector: new ControllerEvidenceProjector({
      sdk: fixture.bb.sdk, store: restartedStore, clock: { now: () => 2_200 }, hanoonToolNames: CONTROLLER_TOOL_NAMES,
    }),
    interactionService: new ControllerInteractionService({
      store: new ControllerInteractionRepository(fixture.bb.storage.database()),
      interactions: fixture.bb.sdk.threads.interactions,
      clock: () => 2_200,
    }),
    clock: { now: () => 2_200 },
  });

  await expect(restarted.reconcile({ ...fixture.fence, signal: fixture.signal }, fixture.signal)).resolves.toBe(true);

  expect(fixture.resolveInteraction).toHaveBeenCalledOnce();
  expect(fixture.resolveInteraction).toHaveBeenCalledWith({
    threadId: THREAD_ID,
    interactionId: INTERACTION_ID,
    resolution: { decision: "allow_once", grantedPermissions: null },
  });
  // The authoritative read was addressed at the exact interaction on the exact
  // controller thread before anything was resolved.
  expect(fixture.getInteraction).toHaveBeenCalledWith(expect.objectContaining({
    threadId: THREAD_ID,
    interactionId: INTERACTION_ID,
  }));
  expect(restartedStore.getAnsweredControllerInteraction("owner-7-controller")).toBeNull();
  expect(restartedStore.getControllerTurn(fixture.turn.id)?.awaitingInteractionId).toBeNull();

  // BB reports the interaction settled and the provider carries on working.
  fixture.phase.interaction = { id: INTERACTION_ID, threadId: THREAD_ID, status: "resolved", payload: null };
  fixture.phase.maxSeq = 6;
  fixture.phase.events = [...fixture.phase.events, {
    id: "e6",
    seq: 6,
    createdAt: 6,
    scope: { kind: "turn" },
    type: "system/permissionGrant/lifecycle",
    data: {
      interactionId: INTERACTION_ID,
      providerId: "claude-code",
      status: "resolved",
      resolution: { decision: "allow_once", grantedPermissions: null },
      subject: { kind: "permission_grant", itemId: "item_1", toolName: "bash", permissions: {} },
    },
  }];

  // A later pass must not resolve the same decision a second time, and must not
  // go back to BB about a settled interaction at all.
  const fetchesAfterDelivery = fixture.getInteraction.mock.calls.length;
  await restarted.reconcile({ ...fixture.fence, signal: fixture.signal }, fixture.signal);
  expect(fixture.resolveInteraction).toHaveBeenCalledOnce();
  expect(fixture.getInteraction.mock.calls.length).toBe(fetchesAfterDelivery);

  const projects = JSON.parse(await callTool(fixture, "telegram_agent_list_projects", {}) as string);
  expect(Array.isArray(projects.projects)).toBe(true);
  const index = JSON.parse(await callTool(fixture, "telegram_agent_turn_evidence", {}) as string);
  const evidence = index.evidence[0];
  const accepted = JSON.parse(await callTool(fixture, "telegram_agent_respond", {
    disposition: "answered",
    segments: [{
      type: "claim",
      text: "Ran the tests you allowed; one project is in scope.",
      kind: "observed_state",
      outcome: "observed",
      subjectRef: evidence.subjectRefs[0],
      evidenceRefs: [evidence.ref],
    }],
    obligationRefs: [],
  }) as string);
  expect(accepted).toMatchObject({ outcome: "accepted" });

  // Only now does the thread go idle, which is the terminal boundary.
  fixture.phase.status = "idle";
  await expect(restarted.reconcile({ ...fixture.fence, signal: fixture.signal }, fixture.signal)).resolves.toBe(true);

  expect(restartedStore.getControllerTurn(fixture.turn.id)).toMatchObject({
    state: "completed",
    responseText: "Ran the tests you allowed; one project is in scope.",
  });
  const answer = "Ran the tests you allowed; one project is in scope.";
  expect(restartedStore.getOutbox(`controller:${fixture.turn.id}:reply`)?.payload.text).toBe(answer);
  expect(await deliverOutbox(restartedStore, fixture.fence, telegram, 2_300)).toBeGreaterThan(0);

  // One logical outbox row settles into exactly one owner-visible answer, and
  // the owner's tap was acknowledged separately.
  expect(telegram.sent.filter((message) => message.payload.text === answer)).toHaveLength(1);
  expect(telegram.sent.some((message) => message.payload.text === "Got it.")).toBe(true);
  expect(await deliverOutbox(restartedStore, fixture.fence, telegram, 2_400)).toBe(0);
  expect(telegram.sent.filter((message) => message.payload.text === answer)).toHaveLength(1);
  // No raw provider prose reaches Telegram: the command BB asked about never
  // appears in a delivered message, only in the bounded approval question.
  expect(telegram.sent.filter((message) => (message.payload.text ?? "").includes("npm test")))
    .toHaveLength(1);
  expect(restartedStore.readControllerDigest("owner-7-controller", 10)).toEqual([{
    ownerText: "which projects can you work on?",
    agentText: answer,
  }]);
});

it("adopts an interaction BB resolved on its own without issuing a second resolution", async () => {
  const fixture = trustFixture({
    status: "active",
    maxSeq: 5,
    interaction: {
      id: INTERACTION_ID,
      threadId: THREAD_ID,
      status: "pending",
      payload: {
        kind: "approval",
        subject: { kind: "file_change", writeScope: "service.ts" },
        availableDecisions: ["allow_once", "deny"],
      },
    },
    events: [{
      id: "e5",
      seq: 5,
      createdAt: 5,
      scope: { kind: "turn" },
      type: "system/permissionGrant/lifecycle",
      data: {
        interactionId: INTERACTION_ID,
        providerId: "claude-code",
        status: "pending",
        resolution: null,
        subject: { kind: "permission_grant", itemId: "item_2", toolName: "write", permissions: {} },
      },
    }],
  });
  const telegram = new FakeTelegram();
  const ingress = new TelegramIngress({ store: fixture.store, telegram, onWorkAvailable: () => undefined });

  await expect(fixture.service.reconcile(
    { ...fixture.fence, signal: fixture.signal },
    fixture.signal,
  )).resolves.toBe(true);
  await ingress.handleClaimed(
    callbackUpdate(520, "cb-adopt", `i:${threadDecisionToken(INTERACTION_ID, "deny")}`),
    2_150,
  );
  expect(fixture.store.getAnsweredControllerInteraction("owner-7-controller")).not.toBeNull();

  // BB settles the interaction itself between the owner's tap and delivery.
  fixture.phase.interaction = { id: INTERACTION_ID, threadId: THREAD_ID, status: "resolved", payload: null };

  await expect(fixture.service.reconcile(
    { ...fixture.fence, signal: fixture.signal },
    fixture.signal,
  )).resolves.toBe(true);

  // The durable decision is settled locally; BB is never told a second time.
  expect(fixture.getInteraction).toHaveBeenCalledWith(expect.objectContaining({
    threadId: THREAD_ID,
    interactionId: INTERACTION_ID,
  }));
  expect(fixture.resolveInteraction).not.toHaveBeenCalled();
  expect(fixture.store.getAnsweredControllerInteraction("owner-7-controller")).toBeNull();
  expect(fixture.store.getPendingControllerInteraction("owner-7-controller")).toBeNull();
  expect(fixture.store.getControllerTurn(fixture.turn.id)).toMatchObject({
    state: "submitted",
    awaitingInteractionId: null,
  });
});
