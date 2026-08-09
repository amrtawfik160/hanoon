import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import type { ProjectPolicy } from "../src/domain/models";
import { TelegramIngress, stableJobId } from "../src/telegram/ingress";
import type {
  InlineKeyboardMarkup,
  SendMessagePayload,
  TelegramUpdate,
} from "../src/telegram/types";
import { encodeCallbackData } from "../src/telegram/view";
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
  private nextMessageId = 100;

  public async sendMessage(chatId: string, payload: SendMessagePayload): Promise<{ message_id: number }> {
    const message = { chatId, messageId: this.nextMessageId++, payload };
    this.sent.push(message);
    return { message_id: message.messageId };
  }

  public async editMessage(chatId: string, messageId: number, payload: SendMessagePayload): Promise<void> {
    this.edited.push({ chatId, messageId, payload });
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

function callbackUpdate(
  updateId: number,
  callbackId: string,
  userId: number,
  chatId: number,
  data?: string,
  chatType = "private",
): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: { id: userId, is_bot: false },
      message: {
      message_id: 100,
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
  return { ingress: new TelegramIngress({ store, telegram }), store, telegram, db };
}

async function createDraft(fixture: ReturnType<typeof ingressFixture>, updateId = 10): Promise<string> {
  await fixture.ingress.handleClaimed(messageUpdate(updateId, 7, 70, "Fix the redirect loop"), 2_000);
  const job = fixture.store.getActiveJob();
  if (!job) throw new Error("draft was not created");
  return job.id;
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

it("creates a deterministic awaiting-project draft and renders only enabled aliases", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });

  await fixture.ingress.handleClaimed(messageUpdate(10, 7, 70, "Fix the redirect loop"), 2_000);

  const job = fixture.store.getActiveJob();
  expect(job).toMatchObject({
    id: stableJobId("70", 10),
    sourceUpdateId: 10,
    requestText: "Fix the redirect loop",
    state: "awaiting_project",
    projectId: null,
  });
  expect(fixture.telegram.sent).toHaveLength(1);
  const pickerButtons = fixture.telegram.sent[0]?.payload.reply_markup?.inline_keyboard.flat() ?? [];
  expect(pickerButtons.map((button) => button.text)).toEqual(["cyndra", "other-project", "Cancel"]);
  expect(pickerButtons.map((button) => button.text)).not.toContain("disabled");
  expect(fixture.store.getNextTelegramOffset()).toBe(0);
});

it("uses last project only for picker ordering and never skips selection or confirmation", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  await fixture.store.setLastProject("proj_2");

  await fixture.ingress.handleClaimed(messageUpdate(11, 7, 70, "Do the work"), 2_000);

  const job = fixture.store.getActiveJob();
  expect(job?.state).toBe("awaiting_project");
  expect(job?.projectId).toBeNull();
  const buttons = fixture.telegram.sent[0]?.payload.reply_markup?.inline_keyboard.flat() ?? [];
  expect(buttons.map((button) => button.text)).toEqual(["other-project", "cyndra", "Cancel"]);
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
  expect(job?.state).toBe("creating_implementation");
  expect(effects.filter((effect) => effect.kind === "spawn_implementation")).toHaveLength(1);
  expect(effects.find((effect) => effect.kind === "spawn_implementation")?.idempotencyKey).toBe(
    `${jobId}:4:spawn_implementation`,
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
  expect(base.store.getJob(jobId)?.state).toBe("creating_implementation");
  expect(effects.filter((effect) => effect.kind === "spawn_implementation")).toHaveLength(1);
  expect(base.db.prepare("SELECT COUNT(*) AS count FROM callbacks").get()).toEqual({ count: 2 });
});

it("deduplicates replayed update ids and callback ids without advancing the cursor", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const draft = messageUpdate(30, 7, 70, "Do it once");

  await fixture.ingress.handleClaimed(draft, 3_000);
  await fixture.ingress.handleClaimed(draft, 3_001);
  expect(fixture.store.listJobs(10)).toHaveLength(1);
  expect(fixture.store.listJobs(10)[0]?.id).toBe(stableJobId("70", 30));

  const jobId = fixture.store.getActiveJob()?.id;
  if (!jobId) throw new Error("missing draft");
  await selectProject(fixture, jobId, "same-project-callback");
  await selectProject(fixture, jobId, "same-project-callback");
  expect(fixture.store.listEffectsForJob(jobId).filter((effect) => effect.kind === "render_status")).toHaveLength(1);
  expect(fixture.store.getNextTelegramOffset()).toBe(0);
});

it("rejects standalone text while a job is active and steers only a status-message reply", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const jobId = await createDraft(fixture, 40);
  const statusMessageId = fixture.store.getJob(jobId)?.statusMessageId;
  if (statusMessageId === null || statusMessageId === undefined) throw new Error("missing status message");

  await fixture.ingress.handleClaimed(messageUpdate(41, 7, 70, "a second task"), 4_100);
  expect(fixture.store.listJobs(10)).toHaveLength(1);
  expect(fixture.telegram.sent.at(-1)?.payload.text).toMatch(/reply/i);
  expect(fixture.store.listEffectsForJob(jobId).some((effect) => effect.kind === "steer_implementation")).toBe(false);

  const selected = fixture.store.applyJobEvent(
    jobId,
    fixture.store.getJob(jobId)?.version ?? 0,
    { type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policy() },
    4_200,
  );
  const confirmed = fixture.store.applyJobEvent(jobId, selected.version, { type: "CONFIRMED" }, 4_201);
  const implementing = fixture.store.applyJobEvent(
    jobId,
    confirmed.version,
    { type: "IMPLEMENTATION_CREATED", threadId: "thr_implementation", environmentId: "env_1" },
    4_202,
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
  const cancel = callbackUpdate(51, "cancel-callback", 7, 70, encodeCallbackData({ type: "cancel", jobId }));

  await fixture.ingress.handleClaimed(cancel, 5_100);
  await fixture.ingress.handleClaimed(cancel, 5_101);

  const job = fixture.store.getJob(jobId);
  expect(job?.cancelRequestedAt).toBe(5_100);
  expect(fixture.store.listEffectsForJob(jobId).filter((effect) => effect.kind === "revoke_approvals")).toHaveLength(1);
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
      logicalKey: `${job.id}:status`,
      chatId: "70",
      messageId: 123,
      payload: { text: "hello", reply_markup: {} as InlineKeyboardMarkup },
    },
    7_003,
  );
  fixture.store.enqueueOutbox(
    {
      logicalKey: `${job.id}:status`,
      chatId: "70",
      messageId: 999,
      payload: { text: "replay" },
    },
    7_004,
  );
  expect(fixture.db.prepare("SELECT logical_key, chat_id, message_id, payload_json FROM outbox").all()).toEqual([
    {
      logical_key: `${job.id}:status`,
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
