import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { hashSecret } from "../src/crypto";
import type { ProjectPolicy } from "../src/domain/models";
import { TelegramIngress } from "../src/telegram/ingress";
import { TelegramApiError } from "../src/telegram/errors";
import type {
  InlineKeyboardMarkup,
  SendMessagePayload,
  TelegramUpdate,
} from "../src/telegram/types";
import { encodeCallbackData, persistableJobStatusPayload, renderProjectPicker } from "../src/telegram/view";
import { VersionConflictError, openStore, type TelegramAgentStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

type SentMessage = {
  chatId: string;
  messageId: number;
  payload: SendMessagePayload;
};

class FakeTelegram {
  public readonly sent: SentMessage[] = [];
  public readonly edited: Array<{
    chatId: string;
    messageId: number;
    payload: SendMessagePayload;
  }> = [];
  public readonly answered: Array<{ callbackId: string; text: string }> = [];
  public failNextEdit = false;
  public nextEditError: Error | null = null;
  private nextMessageId = 100;

  public async sendMessage(chatId: string, payload: SendMessagePayload): Promise<{ message_id: number }> {
    const message = { chatId, messageId: this.nextMessageId++, payload };
    this.sent.push(message);
    return { message_id: message.messageId };
  }

  public async editMessage(chatId: string, messageId: number, payload: SendMessagePayload): Promise<void> {
    this.edited.push({ chatId, messageId, payload });
    if (this.nextEditError) {
      const error = this.nextEditError;
      this.nextEditError = null;
      throw error;
    }
    if (this.failNextEdit) {
      this.failNextEdit = false;
      throw new Error("simulated Telegram edit failure");
    }
  }

  public async answerCallback(callbackId: string, text: string): Promise<void> {
    this.answered.push({ callbackId, text });
  }
}

type Kv = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
};

function memoryKv(): Kv {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
    async delete(key: string): Promise<void> {
      values.delete(key);
    },
    async list(prefix = ""): Promise<string[]> {
      return [...values.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

function messageUpdate(
  updateId: number,
  userId: number,
  chatId: number,
  text?: string,
  overrides: Record<string, unknown> = {},
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1,
      from: { id: userId, is_bot: false },
      chat: { id: chatId, type: "private" },
      ...(text === undefined ? {} : { text }),
      ...overrides,
    },
  } as TelegramUpdate;
}

function stableJobId(chatId: string, updateId: number): string {
  return createHash("sha256")
    .update(`telegram-job:${chatId}:${updateId}`, "utf8")
    .digest("base64url")
    .slice(0, 22);
}

function callbackUpdate(
  updateId: number,
  callbackId: string,
  userId: number,
  chatId: number,
  data?: string,
  chatType = "private",
  messageId = 100,
): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: { id: userId, is_bot: false },
      message: {
        message_id: messageId,
        chat: { id: chatId, type: chatType },
      },
      ...(data === undefined ? {} : { data }),
    },
  } as TelegramUpdate;
}

function policy(overrides: Partial<ProjectPolicy> = {}): ProjectPolicy {
  return policyFixture(overrides);
}

function seedOwner(db: Database.Database, userId = "7", chatId = "70"): void {
  db.prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, ?, ?, ?, NULL)",
  ).run(userId, chatId, 1_000);
}

function ingressFixture(options: {
  owner?: { userId: string; chatId: string };
  policies?: ProjectPolicy[];
  pairingCode?: string;
  onWorkAvailable?: () => void;
} = {}): {
  ingress: TelegramIngress;
  store: TelegramAgentStore;
  telegram: FakeTelegram;
  db: Database.Database;
} {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const db = bb.storage.database();
  const kv = memoryKv();
  const store = openStore(bb.storage, kv);
  if (options.owner) seedOwner(db, options.owner.userId, options.owner.chatId);
  for (const project of options.policies ?? [
    policy(),
    policy({ projectId: "proj_2", alias: "other-project" }),
    policy({ projectId: "proj_disabled", alias: "disabled", enabled: false }),
  ]) {
    store.upsertProjectPolicy(project, 900);
  }
  if (options.pairingCode) {
    store.createPairingCode(hashSecret(options.pairingCode), 1_000, 11_000);
  }
  const telegram = new FakeTelegram();
  return { ingress: new TelegramIngress({ store, telegram, onWorkAvailable: options.onWorkAvailable }), store, telegram, db };
}

async function createDraft(fixture: ReturnType<typeof ingressFixture>, updateId = 10): Promise<string> {
  const job = fixture.store.createJob({
    id: stableJobId("70", updateId),
    sourceUpdateId: updateId,
    requestText: "Fix the redirect loop",
    now: 2_000,
  });
  const payload = renderProjectPicker(job, fixture.store.listEnabledProjectPolicies());
  const sent = await fixture.telegram.sendMessage("70", payload);
  const current = fixture.store.setJobStatusMessage(job.id, sent.message_id, job.version, 2_000);
  fixture.store.enqueueOutbox({
    logicalKey: `job:${job.id}:status`,
    chatId: "70",
    messageId: sent.message_id,
    payload: persistableJobStatusPayload(payload),
  }, 2_000);
  return current.id;
}

async function selectProject(
  fixture: ReturnType<typeof ingressFixture>,
  jobId: string,
  callbackId = "project-callback",
): Promise<void> {
  await fixture.ingress.handleClaimed(
    callbackUpdate(20, callbackId, 7, 70, encodeCallbackData({ type: "project", jobId, alias: "cyndra" })),
    2_100,
  );
}

it("reveals no project information to an unauthorized chat", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });

  await fixture.ingress.handleClaimed(messageUpdate(1, 8, 80, "show projects"), 1_000);

  expect(fixture.telegram.sent).toEqual([]);
  expect(fixture.store.getActiveJob()).toBeNull();
});

it("queues authorized standalone text for Luna without creating a software job", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });

  await fixture.ingress.handleClaimed(messageUpdate(9, 7, 70, "What projects can you work on?"), 1_900);

  expect(fixture.store.getActiveJob()).toBeNull();
  const controller = fixture.store.getControllerForOwner("7", "70");
  expect(controller).not.toBeNull();
  expect(fixture.store.listControllerTurns(controller!.controllerKey, 10)).toMatchObject([{
    updateId: 9,
    state: "queued",
    inputText: "What projects can you work on?",
  }]);
});

it("pairs only a valid unconsumed code in a private chat", async () => {
  const fixture = ingressFixture({ pairingCode: "pair-code" });

  await fixture.ingress.handleClaimed(messageUpdate(1, 7, 70, "/start pair-code"), 2_000);
  expect(fixture.store.getOwner()).toMatchObject({ userId: "7", chatId: "70" });

  await fixture.ingress.handleClaimed(messageUpdate(2, 8, 80, "/start pair-code"), 2_001);
  expect(fixture.store.getOwner()?.userId).toBe("7");

  const groupFixture = ingressFixture({ pairingCode: "group-code" });
  await groupFixture.ingress.handleClaimed(
    messageUpdate(3, 7, 70, "/start group-code", { chat: { id: -70, type: "group" } }),
    2_002,
  );
  expect(groupFixture.store.getOwner()).toBeNull();
});

it("keeps /projects deterministic and out of the Luna controller queue", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });

  await fixture.ingress.handleClaimed(messageUpdate(10, 7, 70, "/projects"), 2_000);

  expect(fixture.store.getActiveJob()).toBeNull();
  expect(fixture.store.getControllerForOwner("7", "70")).toBeNull();
  expect(fixture.telegram.sent).toHaveLength(1);
  expect(fixture.telegram.sent[0]?.payload.text).toBe("Enabled projects:\ncyndra\nother-project");
  expect(fixture.telegram.sent[0]?.payload.text).not.toContain("disabled");
  expect(fixture.store.getNextTelegramOffset()).toBe(0);
});

it("uses last project only for deterministic /projects ordering", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  await fixture.store.setLastProject("proj_2");

  await fixture.ingress.handleClaimed(messageUpdate(11, 7, 70, "/projects"), 2_000);

  expect(fixture.store.getActiveJob()).toBeNull();
  expect(fixture.telegram.sent[0]?.payload.text).toBe("Enabled projects:\nother-project\ncyndra");
});

it("binds the selected policy version and renders Start and Cancel without spawning", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const jobId = await createDraft(fixture);

  await selectProject(fixture, jobId);

  const selected = fixture.store.getJob(jobId);
  expect(selected).toMatchObject({
    state: "awaiting_confirmation",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policy(),
  });
  expect(fixture.store.listEffectsForJob(jobId).map((effect) => effect.kind)).toEqual(["render_status"]);
  const rendered = fixture.telegram.edited.at(-1)?.payload ?? fixture.telegram.sent.at(-1)?.payload;
  const buttons = rendered?.reply_markup?.inline_keyboard.flat().map((button) => button.text);
  expect(buttons).toContain("Start");
  expect(buttons).toContain("Cancel");
});

it("starts only the selected confirmed job with one deterministic effect", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const jobId = await createDraft(fixture);
  await selectProject(fixture, jobId);

  await fixture.ingress.handleClaimed(
    callbackUpdate(21, "start-callback", 7, 70, encodeCallbackData({ type: "start", jobId })),
    2_200,
  );

  const job = fixture.store.getJob(jobId);
  const effects = fixture.store.listEffectsForJob(jobId);
  expect(job?.state).toBe("planning");
  expect(effects.filter((effect) => effect.kind === "spawn_plan")).toHaveLength(1);
  expect(effects.find((effect) => effect.kind === "spawn_plan")?.idempotencyKey).toBe(
    `${jobId}:4:spawn_plan`,
  );
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM callbacks").get()).toEqual({ count: 2 });
});

it("replays a Start callback after a crash before callback recording without duplicating the transition", async () => {
  const base = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const jobId = await createDraft(base);
  await selectProject(base, jobId);

  let crash = true;
  const crashingStore = new Proxy(base.store, {
    get(target, property, receiver) {
      if (property === "recordCallback") {
        return (...args: Parameters<TelegramAgentStore["recordCallback"]>) => {
          if (crash) {
            crash = false;
            throw new Error("simulated crash before callback record");
          }
          return target.recordCallback(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const ingress = new TelegramIngress({ store: crashingStore, telegram: base.telegram });
  const update = callbackUpdate(21, "crash-start", 7, 70, encodeCallbackData({ type: "start", jobId }));

  await expect(ingress.handleClaimed(update, 2_200)).rejects.toThrow("simulated crash");
  await ingress.handleClaimed(update, 2_201);

  const effects = base.store.listEffectsForJob(jobId);
  expect(base.store.getJob(jobId)?.state).toBe("planning");
  expect(effects.filter((effect) => effect.kind === "spawn_plan")).toHaveLength(1);
  expect(base.db.prepare("SELECT COUNT(*) AS count FROM callbacks").get()).toEqual({ count: 2 });
});

it("deduplicates replayed update ids and callback ids without advancing the cursor", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const draft = messageUpdate(30, 7, 70, "Do it once");

  await fixture.ingress.handleClaimed(draft, 3_000);
  await fixture.ingress.handleClaimed(draft, 3_001);
  expect(fixture.store.listJobs(10)).toHaveLength(0);
  const controller = fixture.store.getControllerForOwner("7", "70");
  if (!controller) throw new Error("missing controller");
  expect(fixture.store.listControllerTurns(controller.controllerKey, 10)).toHaveLength(1);

  const jobId = await createDraft(fixture, 31);
  await selectProject(fixture, jobId, "same-project-callback");
  await selectProject(fixture, jobId, "same-project-callback");
  expect(fixture.store.listEffectsForJob(jobId).filter((effect) => effect.kind === "render_status")).toHaveLength(1);
  expect(fixture.store.getNextTelegramOffset()).toBe(0);
});

it("confirms one owner-bound thread operation callback and rejects its replay", async () => {
  let nudges = 0;
  const fixture = ingressFixture({
    owner: { userId: "7", chatId: "70" },
    onWorkAvailable: () => { nudges += 1; },
  });
  const nonce = "A".repeat(32);
  const operation = fixture.store.createThreadOperation({
    id: "B".repeat(22),
    nonceHash: hashSecret(nonce),
    ownerUserId: "7",
    ownerChatId: "70",
    kind: "stop_thread",
    threadId: "thr_target",
    text: null,
    expiresAt: 20_000,
    now: 1_000,
  });
  fixture.store.markThreadOperationConfirmationSent(operation.id, 701, 1_001);
  const callback = callbackUpdate(
    35,
    "operation-confirm",
    7,
    70,
    encodeCallbackData({ type: "operation", nonce }),
    "private",
    701,
  );

  await fixture.ingress.handleClaimed(callback, 1_100);
  await fixture.ingress.handleClaimed(callback, 1_101);

  expect(fixture.store.getThreadOperation(operation.id)).toMatchObject({ state: "confirmed" });
  expect(fixture.store.getCallback("operation-confirm")).toMatchObject({
    action: "thread_operation",
    outcome: "accepted",
  });
  expect(fixture.store.getOutbox("callback:operation-confirm")?.payload.text).toBe("Thread operation queued.");
  expect(nudges).toBe(1);
});

it("routes standalone text to Luna while a job is active and steers only a status-message reply", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const jobId = await createDraft(fixture, 40);
  const statusMessageId = fixture.store.getJob(jobId)?.statusMessageId;
  if (statusMessageId === null || statusMessageId === undefined) throw new Error("missing status message");

  await fixture.ingress.handleClaimed(messageUpdate(41, 7, 70, "a second task"), 4_100);
  expect(fixture.store.listJobs(10)).toHaveLength(1);
  const controller = fixture.store.getControllerForOwner("7", "70");
  if (!controller) throw new Error("missing controller turn");
  expect(fixture.store.listControllerTurns(controller.controllerKey, 10)).toMatchObject([{
    updateId: 41,
    inputText: "a second task",
    state: "queued",
  }]);
  expect(fixture.store.listEffectsForJob(jobId).some((effect) => effect.kind === "steer_implementation")).toBe(false);

  const selected = fixture.store.applyJobEvent(
    jobId,
    fixture.store.getJob(jobId)?.version ?? 0,
    { type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policy() },
    4_200,
  );
  const confirmed = fixture.store.applyJobEvent(jobId, selected.version, { type: "CONFIRMED" }, 4_201);
  const planned = fixture.store.applyJobEvent(
    jobId,
    confirmed.version,
    { type: "PLAN_READY", attemptId: "stage_plan" },
    4_202,
  );
  const critiqued = fixture.store.applyJobEvent(
    jobId,
    planned.version,
    { type: "CRITIQUE_PASSED", attemptId: "stage_critique" },
    4_203,
  );
  const implementing = fixture.store.applyJobEvent(
    jobId,
    critiqued.version,
    { type: "IMPLEMENTATION_CREATED", threadId: "thr_implementation", environmentId: "env_1" },
    4_204,
  );
  expect(implementing.state).toBe("implementing");

  await fixture.ingress.handleClaimed(
    messageUpdate(42, 7, 70, "focus on the redirect test", {
      reply_to_message: { message_id: statusMessageId },
    }),
    4_300,
  );

  const steering = fixture.store.listEffectsForJob(jobId).filter((effect) => effect.kind === "steer_implementation");
  expect(steering).toHaveLength(1);
  expect(steering[0]?.payload).toEqual({
    text: "focus on the redirect test",
    threadId: "thr_implementation",
  });
});

it("requests cancellation once and keeps it replay-safe", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const jobId = await createDraft(fixture, 50);
  const job = fixture.store.getJob(jobId);
  if (!job) throw new Error("draft was not created");
  fixture.store.upsertWorkerLiveness({
    jobId,
    workerKind: "implementation",
    resourceKind: "bb_thread",
    resourceId: "thr_active",
    generation: job.version,
    state: "active",
    sourceUpdatedAt: 5_099,
    observedAt: 5_099,
    staleNotifiedAt: null,
  });
  const cancel = callbackUpdate(51, "cancel-callback", 7, 70, encodeCallbackData({ type: "cancel", jobId }));

  await fixture.ingress.handleClaimed(cancel, 5_100);
  await fixture.ingress.handleClaimed(cancel, 5_101);

  expect(fixture.store.getJob(jobId)?.cancelRequestedAt).toBe(5_100);
  expect(fixture.store.listEffectsForJob(jobId).filter((effect) => effect.kind === "revoke_approvals")).toHaveLength(1);
  expect(fixture.store.listEffectsForJob(jobId).filter((effect) => effect.kind === "stop_thread")).toHaveLength(1);
  expect(fixture.telegram.answered).toEqual([]);
  expect(fixture.store.getOutbox("callback:cancel-callback")).toMatchObject({
    payload: { text: "Cancellation requested." },
  });
});

it("exposes no project data for malformed, wrong-identity, bot, textless, or non-private callbacks", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const jobId = await createDraft(fixture, 60);
  const before = fixture.telegram.sent.length + fixture.telegram.edited.length;
  const cases = [
    callbackUpdate(61, "group", 7, 70, encodeCallbackData({ type: "project", jobId, alias: "cyndra" }), "group"),
    callbackUpdate(62, "wrong-user", 8, 70, encodeCallbackData({ type: "project", jobId, alias: "cyndra" })),
    callbackUpdate(63, "wrong-chat", 7, 71, encodeCallbackData({ type: "project", jobId, alias: "cyndra" })),
    callbackUpdate(64, "bot", 7, 70, encodeCallbackData({ type: "project", jobId, alias: "cyndra" })),
    callbackUpdate(65, "textless", 7, 70),
    callbackUpdate(66, "malformed", 7, 70, "p:not-a-job:cyndra"),
  ];
  (cases[3] as { callback_query?: { from: { id: number; is_bot: boolean } } }).callback_query!.from.is_bot = true;

  for (const update of cases) await fixture.ingress.handleClaimed(update, 6_000);

  expect(fixture.store.getJob(jobId)?.state).toBe("awaiting_project");
  expect(fixture.telegram.sent.length + fixture.telegram.edited.length).toBe(before);
  expect(
    fixture.telegram.sent.some((message) =>
      message.payload.reply_markup?.inline_keyboard.flat().some((button) => button.text === "cyndra"),
    ),
  ).toBe(true);
});

it("persists status-message identity with optimistic versioning and stores outbox rows in SQLite", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const job = fixture.store.createJob({
    id: stableJobId("70", 70),
    sourceUpdateId: 70,
    requestText: "status helper",
    now: 7_000,
  });

  const withMessage = fixture.store.setJobStatusMessage(job.id, 123, job.version, 7_001);
  expect(withMessage.statusMessageId).toBe(123);
  expect(() => fixture.store.setJobStatusMessage(job.id, 124, job.version, 7_002)).toThrow(VersionConflictError);

  fixture.store.enqueueOutbox(
    {
      logicalKey: `job:${job.id}:status`,
      chatId: "70",
      messageId: 123,
      payload: { text: "hello", reply_markup: {} as InlineKeyboardMarkup },
    },
    7_003,
  );
  fixture.store.enqueueOutbox(
    {
      logicalKey: `job:${job.id}:status`,
      chatId: "70",
      messageId: 999,
      payload: { text: "replay" },
    },
    7_004,
  );
  expect(fixture.db.prepare("SELECT logical_key, chat_id, message_id, payload_json FROM outbox").all()).toEqual([
    {
      logical_key: `job:${job.id}:status`,
      chat_id: "70",
      message_id: 999,
      payload_json: JSON.stringify({ text: "replay" }),
    },
  ]);
});

it("uses only the injected KV for last-project ordering state", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  await fixture.store.setLastProject("proj_2");

  expect(await fixture.store.getLastProject()).toBe("proj_2");
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 0 });
});

it("rejects callbacks without an exact persisted status-message identity", async () => {
  const missingStatus = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const missingJob = missingStatus.store.createJob({
    id: stableJobId("70", 71),
    sourceUpdateId: 71,
    requestText: "missing status identity",
    now: 7_100,
  });

  await missingStatus.ingress.handleClaimed(
    callbackUpdate(72, "missing-status", 7, 70, encodeCallbackData({ type: "project", jobId: missingJob.id, alias: "cyndra" })),
    7_200,
  );

  expect(missingStatus.store.getJob(missingJob.id)?.state).toBe("awaiting_project");
  expect(missingStatus.telegram.edited).toHaveLength(0);
  expect(missingStatus.telegram.answered).toHaveLength(0);

  const wrongMessage = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const wrongMessageJobId = await createDraft(wrongMessage, 73);
  const statusMessageId = wrongMessage.store.getJob(wrongMessageJobId)?.statusMessageId;
  if (statusMessageId === null || statusMessageId === undefined) throw new Error("missing status message");

  await wrongMessage.ingress.handleClaimed(
    callbackUpdate(
      74,
      "wrong-status-message",
      7,
      70,
      encodeCallbackData({ type: "project", jobId: wrongMessageJobId, alias: "cyndra" }),
      "private",
      statusMessageId + 1,
    ),
    7_400,
  );

  expect(wrongMessage.store.getJob(wrongMessageJobId)?.state).toBe("awaiting_project");
  expect(wrongMessage.telegram.edited).toHaveLength(0);
  expect(wrongMessage.telegram.answered).toHaveLength(0);
});

it("persists the controller turn before nudging the executor", async () => {
  let durableAtNotify = false;
  let fixture: ReturnType<typeof ingressFixture>;
  fixture = ingressFixture({
    owner: { userId: "7", chatId: "70" },
    onWorkAvailable: () => {
      const controller = fixture.store.getControllerForOwner("7", "70");
      durableAtNotify = controller !== null && fixture.store.listControllerTurns(controller.controllerKey, 10).length === 1;
    },
  });

  await fixture.ingress.handleClaimed(messageUpdate(75, 7, 70, "stage before nudge"), 7_500);

  expect(durableAtNotify).toBe(true);
});

it("upserts the status outbox before an edit so a thrown edit leaves the latest projection durable", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const jobId = await createDraft(fixture, 77);
  const statusMessageId = fixture.store.getJob(jobId)?.statusMessageId;
  if (statusMessageId === null || statusMessageId === undefined) throw new Error("missing status message");
  fixture.telegram.failNextEdit = true;

  await expect(selectProject(fixture, jobId, "edit-failure")).rejects.toThrow("simulated Telegram edit failure");

  const attemptedPayload = fixture.telegram.edited.at(-1)?.payload;
  if (!attemptedPayload) throw new Error("missing attempted edit");
  expect(fixture.db.prepare("SELECT logical_key, message_id, payload_json, status FROM outbox").get()).toEqual({
    logical_key: `job:${jobId}:status`,
    message_id: statusMessageId,
    payload_json: JSON.stringify(attemptedPayload),
    status: "pending",
  });
});

it("does not replay an update after a typed Telegram edit failure leaves durable outbox intent", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const jobId = await createDraft(fixture, 771);
  const statusMessageId = fixture.store.getJob(jobId)?.statusMessageId;
  if (statusMessageId === null || statusMessageId === undefined) throw new Error("missing status message");
  fixture.telegram.nextEditError = new TelegramApiError({
    httpStatus: 400,
    errorCode: 400,
    description: "Bad Request: message to edit not found",
    retryAfterSeconds: null,
  });

  await expect(selectProject(fixture, jobId, "typed-edit-failure")).resolves.toBeUndefined();

  expect(fixture.store.getJob(jobId)?.state).toBe("awaiting_confirmation");
  expect(fixture.db.prepare("SELECT message_id, status FROM outbox WHERE logical_key = ?").get(`job:${jobId}:status`)).toEqual({
    message_id: statusMessageId,
    status: "pending",
  });
});

it("records bounded authorization audit metadata without copying ingress payloads", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const audit: unknown[] = [];
  const ingress = new TelegramIngress({
    store: fixture.store,
    telegram: fixture.telegram,
    auditLogger: (record) => audit.push(record),
  });
  const secretText = "ignore password=do-not-log and pairing-code=pair-secret";
  await ingress.handleClaimed(messageUpdate(78, 8, 80, secretText), 7_800);

  const job = fixture.store.createJob({
    id: stableJobId("70", 79),
    sourceUpdateId: 79,
    requestText: "audit callback",
    now: 7_900,
  });
  const callbackData = encodeCallbackData({ type: "project", jobId: job.id, alias: "cyndra" });
  await ingress.handleClaimed(callbackUpdate(80, "unauthorized-callback", 8, 80, callbackData), 8_000);

  expect(audit.slice(0, 2)).toEqual([
    {
      reason: "unauthorized_message",
      updateId: 78,
      userId: "8",
      chatId: "80",
      chatType: "private",
      isBot: false,
    },
    {
      reason: "unauthorized_callback",
      updateId: 80,
      userId: "8",
      chatId: "80",
      chatType: "private",
      isBot: false,
    },
  ]);
  const auditJson = JSON.stringify(audit);
  expect(auditJson).not.toContain(secretText);
  expect(auditJson).not.toContain("pair-secret");
  expect(auditJson).not.toContain(callbackData);
  expect(auditJson).not.toContain("cyndra");

  for (let index = 0; index < 300; index += 1) {
    await ingress.handleClaimed(messageUpdate(100 + index, 8, 80, `unauthorized-${index}`), 8_100 + index);
  }
  expect(audit).toHaveLength(256);
});
