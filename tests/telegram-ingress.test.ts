import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { hashSecret } from "../src/crypto";
import type { ProjectPolicy } from "../src/domain/models";
import { buildHealthReport } from "../src/services/health-report";
import { resolveMergeGrant } from "../src/services/merge-authority";
import { TelegramIngress } from "../src/telegram/ingress";
import { TelegramApiError } from "../src/telegram/errors";
import type {
  InlineKeyboardMarkup,
  SendMessagePayload,
  TelegramUpdate,
} from "../src/telegram/types";
import { encodeCallbackData, persistableJobStatusPayload, renderProjectPicker } from "../src/telegram/view";
import { VersionConflictError, openStore, type TelegramAgentStore } from "../src/storage/store";
import {
  controllerInteractionToken,
  questionOptionToken,
  threadDecisionToken,
  type ControllerInteraction,
} from "../src/controller/questions";
import { EXPECTED_MIGRATION_ID, type RuntimeIdentity } from "../src/services/runtime-identity";
import { admitConfirmedJob, policyFixture } from "./helpers";

type SentMessage = {
  chatId: string;
  messageId: number;
  payload: SendMessagePayload;
};

class FakeTelegram {
  public readonly sent: SentMessage[] = [];
  public readonly deliveries: SendMessagePayload[] = [];
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
    this.deliveries.push(payload);
    return { message_id: message.messageId };
  }

  public async editMessage(chatId: string, messageId: number, payload: SendMessagePayload): Promise<void> {
    this.edited.push({ chatId, messageId, payload });
    this.deliveries.push(payload);
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

const CONTROLLER_KEY = createHash("sha256")
  .update("telegram-controller:7:70", "utf8")
  .digest("base64url")
  .slice(0, 32);

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

function createImplementingJob(
  fixture: ReturnType<typeof ingressFixture>,
  jobId: string,
  updateId: number,
  threadId: string,
): string {
  const projectId = `proj_${updateId}`;
  const jobPolicy = policy({
    projectId,
    alias: `job-${updateId}`,
    githubRepository: `acme/job-${updateId}`,
    production: undefined,
  });
  fixture.store.upsertProjectPolicy(jobPolicy, 1_900 + updateId);
  const draft = fixture.store.createJob({
    id: jobId,
    sourceUpdateId: updateId,
    requestText: jobId,
    now: 2_000,
  });
  const selected = fixture.store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId,
    policyVersion: 1,
    policy: jobPolicy,
  }, 2_001);
  const admitted = admitConfirmedJob(fixture.store, selected, 2_002);
  const planned = fixture.store.applyJobEvent(
    admitted.id,
    admitted.version,
    { type: "PLAN_READY", attemptId: `${jobId}-plan` },
    2_003,
  );
  const critiqued = fixture.store.applyJobEvent(
    planned.id,
    planned.version,
    { type: "CRITIQUE_PASSED", attemptId: `${jobId}-critique` },
    2_004,
  );
  const implementing = fixture.store.applyJobEvent(
    critiqued.id,
    critiqued.version,
    { type: "IMPLEMENTATION_CREATED", threadId, environmentId: `${jobId}-environment` },
    2_005,
  );
  return fixture.store.setJobStatusMessage(
    implementing.id,
    10_000 + updateId,
    implementing.version,
    2_006,
  ).id;
}

function createOwnerControllerJob(fixture: ReturnType<typeof ingressFixture>, updateId: number): string {
  fixture.store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY,
    telegramUserId: "7",
    telegramChatId: "70",
    updateId,
    inputText: "Fix and ship the redirect loop",
    now: 2_000,
  });
  const lease = fixture.store.acquireExecutorLease("executor", 2_000, 30_000);
  if (!lease.acquired) throw new Error("missing executor lease");
  const turn = fixture.store.claimNextControllerTurn({
    ownerId: "executor",
    generation: lease.generation,
    now: 2_000,
  });
  if (!turn) throw new Error("missing controller turn");
  if (!fixture.store.markControllerSpawned({
    turnId: turn.id,
    ownerId: "executor",
    generation: lease.generation,
    projectId: "proj_1",
    hostId: "host_1",
    threadId: "thr_controller",
    now: 2_001,
  })) throw new Error("controller spawn was not recorded");
  if (!fixture.store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: "executor",
    generation: lease.generation,
    now: 2_002,
  })) throw new Error("controller submission was not recorded");
  const job = fixture.store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller",
    projectId: "proj_1",
    task: "Fix and ship the redirect loop",
    now: 2_003,
  });
  fixture.store.setJobStatusMessage(job.id, 9_000 + updateId, job.version, 2_004);
  return job.id;
}

function failJob(fixture: ReturnType<typeof ingressFixture>, jobId: string, updateId: number): string {
  const implementing = createImplementingJob(fixture, jobId, updateId, `${jobId}-thread`);
  const current = fixture.store.getJob(implementing);
  if (!current) throw new Error(`missing ${jobId}`);
  return fixture.store.applyJobEvent(
    current.id,
    current.version,
    { type: "FAILED", error: `${jobId} failed` },
    2_007,
  ).id;
}

function statusPayload(fixture: ReturnType<typeof ingressFixture>): SendMessagePayload {
  return fixture.telegram.deliveries.at(-1) ?? { text: "" };
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

it("durably queues the largest Telegram photo with its caption for Luna", async () => {
  const onWorkAvailable = vi.fn();
  const fixture = ingressFixture({
    owner: { userId: "7", chatId: "70" },
    onWorkAvailable,
  });

  await fixture.ingress.handleClaimed(messageUpdate(10, 7, 70, undefined, {
    caption: "Fix what is overlapping in this screenshot",
    photo: [
      {
        file_id: "small-file-id",
        file_unique_id: "small-unique-id",
        width: 90,
        height: 90,
        file_size: 1_024,
      },
      {
        file_id: "large-file-id",
        file_unique_id: "large-unique-id",
        width: 1_280,
        height: 960,
        file_size: 250_000,
      },
    ],
  }), 1_901);

  const controller = fixture.store.getControllerForOwner("7", "70");
  expect(controller).not.toBeNull();
  expect(fixture.store.listControllerTurns(controller!.controllerKey, 10)).toMatchObject([{
    updateId: 10,
    state: "queued",
    inputText: "Fix what is overlapping in this screenshot",
    image: {
      fileId: "large-file-id",
      fileName: "telegram-large-unique-id.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 250_000,
    },
  }]);
  expect(onWorkAvailable).toHaveBeenCalledOnce();
});

it("queues a captionless image document with a default inspection prompt", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });

  await fixture.ingress.handleClaimed(messageUpdate(11, 7, 70, undefined, {
    document: {
      file_id: "document-file-id",
      file_unique_id: "document-unique-id",
      file_name: "original screenshot.png",
      mime_type: "image/png",
      file_size: 125_000,
    },
  }), 1_902);

  const controller = fixture.store.getControllerForOwner("7", "70");
  expect(controller).not.toBeNull();
  expect(fixture.store.listControllerTurns(controller!.controllerKey, 10)).toMatchObject([{
    updateId: 11,
    inputText: "Please inspect this image.",
    image: {
      fileId: "document-file-id",
      fileName: "telegram-document-unique-id.png",
      mimeType: "image/png",
      sizeBytes: 125_000,
    },
  }]);
});

it("queues a captionless Telegram GIF animation for the controller", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });

  await fixture.ingress.handleClaimed(messageUpdate(13, 7, 70, undefined, {
    animation: {
      file_id: "gif-file-id",
      file_unique_id: "gif-unique-id",
      width: 480,
      height: 480,
      duration: 2,
      mime_type: "video/mp4",
      file_size: 180_000,
      thumbnail: {
        file_id: "gif-thumb-id",
        file_unique_id: "gif-thumb-unique",
        width: 320,
        height: 320,
        file_size: 8_000,
      },
    },
  }), 1_904);

  const controller = fixture.store.getControllerForOwner("7", "70");
  expect(controller).not.toBeNull();
  expect(fixture.store.listControllerTurns(controller!.controllerKey, 10)).toMatchObject([{
    updateId: 13,
    inputText: "Please inspect this clip.",
    image: {
      kind: "animation",
      fileId: "gif-file-id",
      fileName: "telegram-gif-unique-id.mp4",
      mimeType: "video/mp4",
      sizeBytes: 180_000,
      durationSeconds: 2,
      thumbnail: {
        fileId: "gif-thumb-id",
        fileName: "telegram-gif-thumb-unique.jpg",
        sizeBytes: 8_000,
      },
    },
  }]);
});

it("queues a video and its caption instead of dropping the update", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });

  await fixture.ingress.handleClaimed(messageUpdate(14, 7, 70, undefined, {
    caption: "The settings page I recorded",
    video: {
      file_id: "video-file-id",
      file_unique_id: "video-unique-id",
      width: 720,
      height: 1280,
      duration: 12,
      mime_type: "video/mp4",
      file_size: 1_200_000,
      thumbnail: {
        file_id: "video-thumb-id",
        file_unique_id: "video-thumb-unique",
        width: 180,
        height: 320,
        file_size: 9_000,
      },
    },
  }), 1_905);

  const controller = fixture.store.getControllerForOwner("7", "70");
  expect(controller).not.toBeNull();
  expect(fixture.store.listControllerTurns(controller!.controllerKey, 10)).toMatchObject([{
    updateId: 14,
    inputText: "The settings page I recorded",
    image: {
      kind: "video",
      fileId: "video-file-id",
      fileName: "telegram-video-unique-id.mp4",
      mimeType: "video/mp4",
      durationSeconds: 12,
    },
  }]);
});

it("rejects a known oversized image before queueing controller work", async () => {
  const onWorkAvailable = vi.fn();
  const fixture = ingressFixture({
    owner: { userId: "7", chatId: "70" },
    onWorkAvailable,
  });

  await fixture.ingress.handleClaimed(messageUpdate(12, 7, 70, undefined, {
    caption: "Inspect this",
    photo: [{
      file_id: "oversized-file-id",
      file_unique_id: "oversized-unique-id",
      width: 2_000,
      height: 2_000,
      file_size: 10 * 1024 * 1024 + 1,
    }],
  }), 1_903);

  expect(fixture.store.getControllerForOwner("7", "70")).toBeNull();
  expect(onWorkAvailable).not.toHaveBeenCalled();
  expect(fixture.telegram.sent).toMatchObject([{
    chatId: "70",
    payload: { text: expect.stringContaining("10 MB") },
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

it("tells the private-chat sender when a pairing code is expired or invalid instead of going silent", async () => {
  // The code is valid 1_000..11_000; deliver it after it expired.
  const expiredFixture = ingressFixture({ pairingCode: "pair-code" });
  await expiredFixture.ingress.handleClaimed(messageUpdate(1, 7, 70, "/start pair-code"), 12_000);
  expect(expiredFixture.store.getOwner()).toBeNull();
  expect(expiredFixture.telegram.sent).toHaveLength(1);
  expect(expiredFixture.telegram.sent[0]?.payload.text ?? "").toMatch(/expired|invalid|new pairing link/i);

  // An unknown code (typo, or a link that was never issued here).
  const unknownFixture = ingressFixture({ pairingCode: "pair-code" });
  await unknownFixture.ingress.handleClaimed(messageUpdate(2, 8, 80, "/start wrong-code"), 2_000);
  expect(unknownFixture.store.getOwner()).toBeNull();
  expect(unknownFixture.telegram.sent).toHaveLength(1);
  expect(unknownFixture.telegram.sent[0]?.payload.text ?? "").toMatch(/expired|invalid|new pairing link/i);
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

it("makes an activation mismatch explicit in /health", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  expect(fixture.store.acquireExecutorLease("executor", 2_000, 30_000).acquired).toBe(true);
  const runtime: RuntimeIdentity = {
    sourceRoot: "/registered/plugin",
    loadedAt: 1_000,
    loadedFingerprint: "old-build",
    expectedMigrationId: EXPECTED_MIGRATION_ID,
    currentFingerprint: () => "new-build",
  };
  const ingress = new TelegramIngress({
    store: fixture.store,
    telegram: fixture.telegram,
    health: (now) => buildHealthReport(
      fixture.db,
      now,
      2,
      { pipelineActive: 0, controlActive: 0, busyJobIds: [] },
      runtime,
    ),
  });

  await ingress.handleClaimed(messageUpdate(12, 7, 70, "/health"), 2_000);

  expect(fixture.telegram.sent[0]?.payload.text).toEqual(expect.stringContaining("ACTIVATION MISMATCH"));
  expect(fixture.telegram.sent[0]?.payload.text).toEqual(expect.stringContaining("source=/registered/plugin"));
  expect(fixture.telegram.sent[0]?.payload.text).toEqual(expect.stringContaining("build=old-build"));
  expect(fixture.telegram.sent[0]?.payload.text).toEqual(
    expect.stringContaining(`schema=${EXPECTED_MIGRATION_ID}/${EXPECTED_MIGRATION_ID}`),
  );
});

it("binds the selected policy version and queues without spawning", async () => {
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
  expect(fixture.store.getAdmission(jobId)).toMatchObject({
    projectId: "proj_1",
    state: "queued",
    resumeEvent: "CONFIRMED",
  });
  expect(fixture.store.listEffectsForJob(jobId).map((effect) => effect.kind)).toEqual(["render_status"]);
  const rendered = fixture.telegram.edited.at(-1)?.payload ?? fixture.telegram.sent.at(-1)?.payload;
  const buttons = rendered?.reply_markup?.inline_keyboard.flat().map((button) => button.text);
  expect(rendered?.text).toContain("starts on its own, nothing to approve");
  expect(buttons).not.toContain("Start");
  expect(buttons).toContain("Cancel");
});

it("keeps the legacy Start callback idempotent for an existing queued admission", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const jobId = await createDraft(fixture);
  await selectProject(fixture, jobId);

  await fixture.ingress.handleClaimed(
    callbackUpdate(21, "start-callback", 7, 70, encodeCallbackData({ type: "start", jobId })),
    2_200,
  );

  const job = fixture.store.getJob(jobId);
  const effects = fixture.store.listEffectsForJob(jobId);
  expect(job?.state).toBe("awaiting_confirmation");
  expect(fixture.store.getAdmission(jobId)).toMatchObject({ state: "queued", resumeEvent: "CONFIRMED" });
  expect(effects.filter((effect) => effect.kind === "spawn_plan")).toHaveLength(0);
  expect(fixture.store.getOutbox("callback:start-callback")?.payload.text).toBe("Job queued.");
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM callbacks").get()).toEqual({ count: 2 });
});

it("queues a legacy selected row without applying CONFIRMED inline", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const jobId = await createDraft(fixture, 22);
  const draft = fixture.store.getJob(jobId);
  if (!draft) throw new Error("missing draft job");
  const selected = fixture.store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policy(),
  }, 2_150);
  expect(fixture.store.getAdmission(jobId)).toBeNull();

  await fixture.ingress.handleClaimed(
    callbackUpdate(23, "legacy-start", 7, 70, encodeCallbackData({ type: "start", jobId })),
    2_200,
  );

  expect(selected.state).toBe("awaiting_confirmation");
  expect(fixture.store.getJob(jobId)?.state).toBe("awaiting_confirmation");
  expect(fixture.store.getAdmission(jobId)).toMatchObject({ state: "queued", resumeEvent: "CONFIRMED" });
  expect(fixture.store.listEffectsForJob(jobId).map((effect) => effect.kind)).toEqual(["render_status"]);
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
  expect(base.store.getJob(jobId)?.state).toBe("awaiting_confirmation");
  expect(base.store.getAdmission(jobId)).toMatchObject({ state: "queued" });
  expect(effects.filter((effect) => effect.kind === "spawn_plan")).toHaveLength(0);
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
  const confirmed = admitConfirmedJob(fixture.store, fixture.store.getJob(jobId)!, 4_201);
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

it("atomically narrows the exact owner task from an authenticated status reply", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const jobId = createOwnerControllerJob(fixture, 43);
  const statusMessageId = fixture.store.getJob(jobId)?.statusMessageId;
  if (statusMessageId === null || statusMessageId === undefined) throw new Error("missing status message");

  expect(fixture.store.beginTelegramUpdate(44, 4_399)).toBe("process");

  await fixture.ingress.handleClaimed(messageUpdate(44, 7, 70, "Do not merge it and do not deploy it", {
    reply_to_message: { message_id: statusMessageId },
  }), 4_400);

  expect(fixture.store.getTaskAuthority(jobId)).toMatchObject({
    revision: 2,
    outcome: "reviewed_change",
    constraints: ["no_merge", "no_deploy"],
  });
  expect(fixture.store.listEffectsForJob(jobId)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "reconcile_job" }),
  ]));
});

it("requests cancellation once and keeps it replay-safe", async () => {
  let workNotifications = 0;
  const fixture = ingressFixture({
    owner: { userId: "7", chatId: "70" },
    onWorkAvailable: () => {
      workNotifications += 1;
    },
  });
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
  const latestStatus = fixture.telegram.edited.at(-1)?.payload;
  expect(latestStatus?.reply_markup?.inline_keyboard.flat().map((button) => button.text) ?? []).not.toContain("Cancel");
  expect(fixture.store.getOutbox(`job:${jobId}:status`)?.payload).toEqual(latestStatus);
  expect(workNotifications).toBe(1);
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

it("resolves plural Telegram status and controls by exact ids or status replies", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const runningId = createImplementingJob(fixture, "R".repeat(22), 801, "thread-running");
  const queuedId = await createDraft(fixture, 802);
  await selectProject(fixture, queuedId, "queued-project");
  const failedId = failJob(fixture, "F".repeat(22), 803);
  const secondFailedId = failJob(fixture, "G".repeat(22), 804);
  const runningStatusId = fixture.store.getJob(runningId)?.statusMessageId;
  if (runningStatusId === null || runningStatusId === undefined) throw new Error("missing running status message");

  await fixture.ingress.handleClaimed(messageUpdate(805, 7, 70, "/status"), 2_100);
  const summary = statusPayload(fixture);
  expect(summary.text).toContain("Running");
  expect(summary.text).toContain("Queued");
  expect(summary.text).toContain("Failed");
  expect(summary.text).toContain(runningId);
  expect(summary.text).toContain(queuedId);
  expect(summary.text).toContain(failedId);

  await fixture.ingress.handleClaimed(messageUpdate(806, 7, 70, `/status ${runningId}`), 2_101);
  expect(statusPayload(fixture).text).toContain(`Task: <code>${runningId}</code>`);
  expect(statusPayload(fixture).text).not.toContain(`Task: <code>${failedId}</code>`);

  await fixture.ingress.handleClaimed(messageUpdate(807, 7, 70, "/status", {
    reply_to_message: { message_id: runningStatusId },
  }), 2_102);
  expect(statusPayload(fixture).text).toContain(`Task: <code>${runningId}</code>`);

  const before = new Map([
    [runningId, fixture.store.getJob(runningId)?.cancelRequestedAt],
    [queuedId, fixture.store.getJob(queuedId)?.cancelRequestedAt],
    [failedId, fixture.store.getJob(failedId)?.cancelRequestedAt],
  ]);
  await fixture.ingress.handleClaimed(messageUpdate(808, 7, 70, "/cancel"), 2_103);
  expect(statusPayload(fixture).text).toContain("Choose");
  expect(new Map([
    [runningId, fixture.store.getJob(runningId)?.cancelRequestedAt],
    [queuedId, fixture.store.getJob(queuedId)?.cancelRequestedAt],
    [failedId, fixture.store.getJob(failedId)?.cancelRequestedAt],
  ])).toEqual(before);

  await fixture.ingress.handleClaimed(messageUpdate(809, 7, 70, "/retry"), 2_104);
  expect(statusPayload(fixture).text).toContain("Choose");
  expect(fixture.store.getJob(failedId)?.state).toBe("failed");
  expect(fixture.store.getJob(secondFailedId)?.state).toBe("failed");

  await fixture.ingress.handleClaimed(messageUpdate(810, 7, 70, `/cancel ${runningId}`), 2_105);
  expect(fixture.store.getJob(runningId)?.cancelRequestedAt).toBe(2_105);
  expect(fixture.store.getJob(queuedId)?.cancelRequestedAt).toBeNull();

  await fixture.ingress.handleClaimed(messageUpdate(811, 7, 70, `/retry ${failedId}`), 2_106);
  expect(fixture.store.getJob(failedId)?.state).toBe("implementing");
  expect(fixture.store.getJob(secondFailedId)?.state).toBe("failed");
});

it("steers only an admitted job with the exact status reply identity", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const runningId = createImplementingJob(fixture, "P".repeat(22), 821, "thread-reply");
  const queuedId = await createDraft(fixture, 822);
  await selectProject(fixture, queuedId, "queued-reply-project");
  const runningStatusId = fixture.store.getJob(runningId)?.statusMessageId;
  const queuedStatusId = fixture.store.getJob(queuedId)?.statusMessageId;
  if (runningStatusId === null || runningStatusId === undefined || queuedStatusId === null || queuedStatusId === undefined) {
    throw new Error("missing status message identity");
  }

  await fixture.ingress.handleClaimed(messageUpdate(823, 7, 70, "steer running", {
    reply_to_message: { message_id: runningStatusId },
  }), 2_200);
  await fixture.ingress.handleClaimed(messageUpdate(824, 7, 70, "steer queued", {
    reply_to_message: { message_id: queuedStatusId },
  }), 2_201);
  await fixture.ingress.handleClaimed(messageUpdate(825, 7, 70, "not a status reply", {
    reply_to_message: { message_id: 999_999 },
  }), 2_202);

  expect(fixture.store.listEffectsForJob(runningId).filter((effect) => effect.kind === "steer_implementation").map((effect) => effect.payload)).toEqual([
    { text: "steer running", threadId: "thread-reply" },
  ]);
  expect(fixture.store.listEffectsForJob(queuedId).filter((effect) => effect.kind === "steer_implementation")).toHaveLength(0);
  expect(fixture.store.getControllerForOwner("7", "70")).not.toBeNull();
});

it("surfaces a stale executor heartbeat in the status summary", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  expect(fixture.store.acquireExecutorLease("executor", 1_000, 30_000).acquired).toBe(true);
  const ingress = new TelegramIngress({
    store: fixture.store,
    telegram: fixture.telegram,
    health: (now) => buildHealthReport(
      fixture.db,
      now,
      2,
      { pipelineActive: 0, controlActive: 0, busyJobIds: [] },
    ),
  });

  await ingress.handleClaimed(messageUpdate(826, 7, 70, "/status"), 40_001);

  expect(statusPayload(fixture).text).toContain("Executor warning: the executor heartbeat is stale.");
});

function parkedControllerInteraction(
  fixture: ReturnType<typeof ingressFixture>,
  interaction: ControllerInteraction,
): { controllerKey: string; turnId: string } {
  const turn = fixture.store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY,
    telegramUserId: "7",
    telegramChatId: "70",
    updateId: 900,
    inputText: "look at the failing build",
    now: 3_000,
  });
  const lease = fixture.store.acquireExecutorLease("executor", 3_000, 60_000);
  if (!lease.acquired) throw new Error("missing executor lease");
  const fence = { ownerId: "executor", generation: lease.generation, now: 3_000 };
  fixture.store.claimNextControllerTurn(fence);
  expect(fixture.store.markControllerSpawned({
    ...fence, turnId: turn.id, projectId: "proj_1", hostId: "host_1", threadId: "thr_ingress_controller",
  })).toBe(true);
  expect(fixture.store.markControllerTurnSubmitted({ ...fence, turnId: turn.id })).toBe(true);
  const generation = fixture.store.getOpenControllerGeneration(CONTROLLER_KEY, "thr_ingress_controller");
  if (!generation) throw new Error("missing open controller generation");
  expect(fixture.store.recordControllerInteraction({
    ...fence,
    turnId: turn.id,
    controllerKey: CONTROLLER_KEY,
    bbThreadId: "thr_ingress_controller",
    controllerGenerationId: generation.id,
    interaction,
  })).toBe("recorded");
  return { controllerKey: CONTROLLER_KEY, turnId: turn.id };
}

const approvalFixtureInteraction: ControllerInteraction = {
  kind: "approval",
  interactionId: "pint_ingress_approval",
  summary: "wants to run:\n\n`npm test`",
  decisions: ["allow_once", "deny"],
};

const questionFixtureInteraction: ControllerInteraction = {
  kind: "user_question",
  interactionId: "pint_ingress_question",
  questions: [{
    id: "which",
    prompt: "Which branch should I use?",
    shortLabel: null,
    multiSelect: false,
    allowFreeText: true,
    options: [{ value: "main", label: "main", description: null }],
  }],
};

it("commits a tapped controller decision, its callback, and the acknowledgement together", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const { controllerKey } = parkedControllerInteraction(fixture, approvalFixtureInteraction);
  const token = controllerInteractionToken("pint_ingress_approval", "allow_once");

  await fixture.ingress.handleClaimed(callbackUpdate(910, "cb-allow", 7, 70, `i:${token}`), 4_000);

  expect(fixture.store.getAnsweredControllerInteraction(controllerKey)).toMatchObject({
    interactionId: "pint_ingress_approval",
    resolution: { decision: "allow_once", grantedPermissions: null },
  });
  expect(fixture.store.getCallback("cb-allow")).toMatchObject({
    action: "controller_interaction",
    outcome: "accepted",
  });
  expect(fixture.store.getOutbox("callback:cb-allow")?.payload.text).toBe("Got it.");
});

it("answers a migrated legacy q: controller callback exactly once", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const { controllerKey } = parkedControllerInteraction(fixture, questionFixtureInteraction);
  const token = questionOptionToken("pint_ingress_question", "which", "main");

  await fixture.ingress.handleClaimed(callbackUpdate(911, "cb-legacy", 7, 70, `q:${token}`), 4_000);
  await fixture.ingress.handleClaimed(callbackUpdate(912, "cb-legacy", 7, 70, `q:${token}`), 4_001);

  expect(fixture.store.getAnsweredControllerInteraction(controllerKey)).toMatchObject({
    resolution: { kind: "user_answer", answers: { which: { selected: ["main"] } } },
    answeredAt: 4_000,
  });
});

it("never lets a controller callback from another user or chat decide anything", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const { controllerKey } = parkedControllerInteraction(fixture, approvalFixtureInteraction);
  const token = threadDecisionToken("pint_ingress_approval", "deny");

  await fixture.ingress.handleClaimed(callbackUpdate(913, "cb-wrong-user", 8, 70, `i:${token}`), 4_000);
  await fixture.ingress.handleClaimed(callbackUpdate(914, "cb-wrong-chat", 7, 71, `i:${token}`), 4_001);

  expect(fixture.store.getAnsweredControllerInteraction(controllerKey)).toBeNull();
  expect(fixture.store.getPendingControllerInteraction(controllerKey)).not.toBeNull();
  expect(fixture.store.getCallback("cb-wrong-user")).toBeNull();
  expect(fixture.store.getCallback("cb-wrong-chat")).toBeNull();
});

it("reads a plain reply as the answer to an open controller question", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const { controllerKey } = parkedControllerInteraction(fixture, questionFixtureInteraction);
  // The answer settles this update's own claim, so the claim has to exist —
  // exactly as it does when the poller hands a claimed update to the ingress.
  expect(fixture.store.beginTelegramUpdate(915, 3_999)).toBe("process");

  const outcome = await fixture.ingress.handleClaimed(messageUpdate(915, 7, 70, "use the release branch"), 4_000);

  expect(outcome).toEqual({ updateSettled: true });
  expect(fixture.store.getAnsweredControllerInteraction(controllerKey)?.resolution).toEqual({
    kind: "user_answer",
    answers: { which: { selected: [], freeText: "use the release branch" } },
  });
  expect(fixture.store.listControllerTurns(controllerKey, 10)).toHaveLength(1);
});

it("never lets a plain reply approve anything and queues it as a new turn", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const { controllerKey } = parkedControllerInteraction(fixture, approvalFixtureInteraction);

  await fixture.ingress.handleClaimed(messageUpdate(916, 7, 70, "yes go ahead"), 4_000);

  expect(fixture.store.getAnsweredControllerInteraction(controllerKey)).toBeNull();
  expect(fixture.store.getPendingControllerInteraction(controllerKey)).not.toBeNull();
  expect(fixture.store.listControllerTurns(controllerKey, 10)).toHaveLength(2);
});

it("lists paused projects for a bare /resume and never restarts one implicitly", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  fixture.store.pauseProjectAdmission({
    projectId: fixture.store.listEnabledProjectPolicies()[0].policy.projectId,
    reason: "the same failure repeated 3 times",
    fingerprint: null,
    now: 2_000,
  });

  await fixture.ingress.handleClaimed(messageUpdate(90, 7, 70, "/resume"), 3_000);

  const reply = fixture.telegram.sent.at(-1)?.payload.text ?? "";
  expect(reply).toContain("paused");
  expect(reply).toContain("cyndra");
  // The single-project case must still be a list, not a silent restart.
  expect(fixture.store.listPausedProjectAdmissions()).toHaveLength(1);
});

it("restarts a paused project only when the owner names it", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  fixture.store.pauseProjectAdmission({
    projectId: fixture.store.listEnabledProjectPolicies()[0].policy.projectId,
    reason: "the same failure repeated 3 times",
    fingerprint: null,
    now: 2_000,
  });

  await fixture.ingress.handleClaimed(messageUpdate(91, 7, 70, "/resume cyndra"), 3_000);

  expect(fixture.telegram.sent.at(-1)?.payload.text).toContain("taking work again");
  expect(fixture.store.listPausedProjectAdmissions()).toEqual([]);
});

it("says nothing is paused when the brake has not tripped", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });

  await fixture.ingress.handleClaimed(messageUpdate(92, 7, 70, "/resume"), 3_000);

  expect(fixture.telegram.sent.at(-1)?.payload.text).toContain("Nothing is paused");
});

function policyGrantFixture() {
  return ingressFixture({
    owner: { userId: "7", chatId: "70" },
    policies: [
      policy({
        projectId: "proj_policy",
        alias: "policy-granted",
        production: {
          ...policyFixture().production!,
          rollbackCommand: { name: "rollback", command: "./rollback.sh", timeoutMs: 60_000 },
        },
        autonomy: { unattendedMerge: true, mergeWithoutProduction: false },
      }),
      policy({ projectId: "proj_asks", alias: "asks-every-time" }),
    ],
  });
}

it("lists a policy-granted project alongside a granted one and says which is which", async () => {
  const fixture = policyGrantFixture();
  fixture.store.grantMergeAuthority({ projectId: "proj_asks", userId: "7", chatId: "70", now: 1_000 });

  await fixture.ingress.handleClaimed(messageUpdate(93, 7, 70, "/approvals"), 3_000);

  const reply = fixture.telegram.sent.at(-1)?.payload.text ?? "";
  expect(reply).toContain("• policy-granted (set in its project policy)");
  expect(reply).toContain("• asks-every-time (you granted this)");
});

it("withdraws a policy-granted project by name and says the policy still asks for it", async () => {
  const fixture = policyGrantFixture();

  await fixture.ingress.handleClaimed(messageUpdate(94, 7, 70, "/approvals off policy-granted"), 3_000);

  const reply = fixture.telegram.sent.at(-1)?.payload.text ?? "";
  expect(reply).toContain("I will ask you before merging policy-granted again");
  expect(reply).toContain("enabling the project again turns it back on");
  expect(resolveMergeGrant({
    projectId: "proj_policy",
    policy: fixture.store.getProjectPolicy("proj_policy")?.policy ?? null,
    evidence: fixture.store.getMergeGrantEvidence("proj_policy"),
  })).toBeNull();
});

it("leaves a project that never merges unattended off the listing", async () => {
  const fixture = policyGrantFixture();

  await fixture.ingress.handleClaimed(messageUpdate(95, 7, 70, "/approvals"), 3_000);

  const reply = fixture.telegram.sent.at(-1)?.payload.text ?? "";
  expect(reply).not.toContain("asks-every-time");
});
