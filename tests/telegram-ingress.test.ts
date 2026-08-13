import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { controllerInteractionToken, questionOptionToken, type ControllerInteraction } from "../src/controller/questions";
import { ControllerInteractionService } from "../src/controller/interaction-service";
import { VersionConflictError, openStore, type TelegramAgentStore } from "../src/storage/store";
import type { ControllerInteractionStore } from "../src/storage/controller-interaction-repository";
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

function seedControllerInteraction(
  fixture: ReturnType<typeof ingressFixture>,
  interaction: ControllerInteraction,
): { controllerKey: string; token: string; interactionId: string; turnId: string; threadId: string; fence: { ownerId: string; generation: number } } {
  const controllerKey = createHash("sha256")
    .update("telegram-controller:7:70", "utf8")
    .digest("base64url")
    .slice(0, 32);
  const turn = fixture.store.enqueueControllerTurn({
    controllerKey,
    telegramUserId: "7",
    telegramChatId: "70",
    updateId: 90_001,
    inputText: "controller interaction fixture",
    now: 9_000,
  });
  const lease = fixture.store.acquireExecutorLease("ingress-executor", 9_000, 60_000);
  if (!lease.acquired) throw new Error("missing executor lease");
  const fence = { ownerId: "ingress-executor", generation: lease.generation };
  expect(fixture.store.claimNextControllerTurn({ ...fence, now: 9_000 })?.id).toBe(turn.id);
  expect(fixture.store.markControllerSpawned({
    ...fence,
    now: 9_000,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_ingress_controller",
  })).toBe(true);
  expect(fixture.store.markControllerTurnSubmitted({ ...fence, now: 9_000, turnId: turn.id })).toBe(true);
  const generation = fixture.store.listControllerGenerations(controllerKey, 1)[0];
  if (!generation) throw new Error("missing controller generation");
  expect(fixture.store.recordControllerInteraction({
    ...fence,
    now: 9_001,
    turnId: turn.id,
    controllerKey,
    bbThreadId: "thr_ingress_controller",
    controllerGenerationId: generation.id,
    interaction,
  })).toBe(true);
  if (interaction.kind === "unsupported") throw new Error("unsupported interactions have no callback token");
  const token = interaction.kind === "approval"
    ? controllerInteractionToken(interaction.interactionId, interaction.decisions[0] ?? "deny")
    : questionOptionToken(interaction.interactionId, interaction.questions[0]!.id, interaction.questions[0]!.options[0]!.value);
  return {
    controllerKey,
    token,
    interactionId: interaction.interactionId,
    turnId: turn.id,
    threadId: "thr_ingress_controller",
    fence,
  };
}

type CallbackRaceResult = Readonly<{
  callbackId: string;
  outcome: string | null;
  nudgeCalls: number;
  delivered: boolean;
  answeredRemaining: boolean;
  providerGetCalls: number;
  providerResolveCalls: number;
  providerOwner: boolean;
  providerDuplicate: boolean;
  nudgeOwner: boolean;
  nudgeDuplicate: boolean;
}>;

type CallbackRaceWorker = Readonly<{
  child: ChildProcess;
  result: Promise<CallbackRaceResult>;
}>;

type CallbackRace = Readonly<{
  results: CallbackRaceResult[];
  barrierDir: string;
}>;

function callbackRaceWorkerSource(): string {
  return String.raw`
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { TelegramIngress } from "TELEGRAM_INGRESS_MODULE";
import { openStore } from "STORE_MODULE";
import { ControllerInteractionService } from "INTERACTION_SERVICE_MODULE";

const [dbPath, barrierDir, label, callbackId, token, controllerKey, interactionId, threadId, generationText] = process.argv.slice(2);
if (!dbPath || !barrierDir || !label || !callbackId || !token || !controllerKey || !interactionId || !threadId || !generationText) {
  throw new Error("callback race arguments are incomplete");
}
const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");
const values = new Map();
const kv = {
  get: async (key) => values.get(key),
  set: async (key, value) => { values.set(key, value); },
  delete: async (key) => { values.delete(key); },
  list: async (prefix = "") => [...values.keys()].filter((key) => key.startsWith(prefix)),
};
const storage = {
  database: () => db,
  kv,
  migrate: () => undefined,
};
const store = openStore(storage, kv, () => 9_002);
const interactionStore = {
  isControllerInteractionDeliveryFenceCurrent: (input) => store.isControllerInteractionDeliveryFenceCurrent(input),
  record: (input) => store.recordControllerInteraction(input),
  markResolved: (input) => store.markControllerInteractionResolved(input),
  answerByToken: (input) => store.answerControllerInteractionByToken(input),
  answerWithText: (input) => store.answerControllerInteractionWithText(input),
  getPending: (key) => store.getPendingControllerInteraction(key),
  getAnswered: (key) => store.getAnsweredControllerInteraction(key),
  markDelivered: (input) => store.markControllerInteractionDelivered(input),
};
const writeExclusiveMarker = (ownerPath, duplicatePath) => {
  try {
    writeFileSync(ownerPath, label, { flag: "wx" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      writeFileSync(duplicatePath, label);
      return;
    }
    throw error;
  }
};
let providerGetCalls = 0;
let providerResolveCalls = 0;
const interactions = {
  get: async (requestedThreadId, requestedInteractionId) => {
    if (requestedThreadId !== threadId || requestedInteractionId !== interactionId) {
      throw new Error("provider get identity mismatch");
    }
    providerGetCalls += 1;
    return { id: requestedInteractionId, threadId: requestedThreadId, status: "pending" };
  },
  resolve: async (input) => {
    if (input.threadId !== threadId || input.interactionId !== interactionId) {
      throw new Error("provider resolve identity mismatch");
    }
    providerResolveCalls += 1;
    writeExclusiveMarker(
      join(barrierDir, "provider-resolution-owner"),
      join(barrierDir, "provider-resolution-duplicate-" + label),
    );
    return { id: input.interactionId, threadId: input.threadId, status: "resolved" };
  },
};
const interactionService = new ControllerInteractionService({
  store: interactionStore,
  clock: { now: () => 9_002 },
  interactions,
});
let nudgeCalls = 0;
let nudgePromise = Promise.resolve(false);
const telegram = {
  sendMessage: async () => ({ message_id: 1 }),
  editMessage: async () => undefined,
  answerCallback: async () => undefined,
};
const ingress = new TelegramIngress({
  store,
  telegram,
  onWorkAvailable: () => {
    nudgeCalls += 1;
    writeExclusiveMarker(
      join(barrierDir, "nudge-owner"),
      join(barrierDir, "nudge-duplicate-" + label),
    );
    nudgePromise = nudgePromise.then(() => interactionService.deliverAnswered(
      controllerKey,
      { ownerId: "ingress-executor", generation: Number(generationText), now: 9_002 },
      AbortSignal.timeout(2_000),
    ));
  },
});
writeFileSync(join(barrierDir, "ready-" + label), "ready");
while (!existsSync(join(barrierDir, "go"))) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
await ingress.handleClaimed({
  update_id: label === "one" ? 90_020 : 90_021,
  callback_query: {
    id: callbackId,
    from: { id: 7, is_bot: false },
    message: { message_id: 100, chat: { id: 70, type: "private" } },
    data: "i:" + token,
  },
}, 9_002);
const delivered = await nudgePromise;
process.stdout.write(JSON.stringify({
  callbackId,
  outcome: store.getCallback(callbackId)?.outcome ?? null,
  nudgeCalls,
  delivered,
  answeredRemaining: store.getAnsweredControllerInteraction(controllerKey) !== null,
  providerGetCalls,
  providerResolveCalls,
  providerOwner: existsSync(join(barrierDir, "provider-resolution-owner")) &&
    readFileSync(join(barrierDir, "provider-resolution-owner"), "utf8") === label,
  providerDuplicate: existsSync(join(barrierDir, "provider-resolution-duplicate-" + label)),
  nudgeOwner: existsSync(join(barrierDir, "nudge-owner")) &&
    readFileSync(join(barrierDir, "nudge-owner"), "utf8") === label,
  nudgeDuplicate: existsSync(join(barrierDir, "nudge-duplicate-" + label)),
}) + "\n");
db.close();
`;
}

function waitForCallbackRaceFile(path: string, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    const startedAt = Date.now();
    const poll = () => {
      if (existsSync(path)) return resolveWait();
      if (Date.now() - startedAt >= timeoutMs) return rejectWait(new Error(`callback race barrier timed out: ${path}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

type CallbackRaceWorkerInput = Readonly<{
  scriptPath: string;
  fixture: ReturnType<typeof ingressFixture>;
  barrierDir: string;
  label: "one" | "two";
  callbackId: string;
  seeded: ReturnType<typeof seedControllerInteraction>;
}>;

function startCallbackRaceWorker(input: CallbackRaceWorkerInput): CallbackRaceWorker {
  const child = spawn(resolve("node_modules/.bin/vite-node"), [
    "--script",
    input.scriptPath,
    input.fixture.db.name,
    input.barrierDir,
    input.label,
    input.callbackId,
    input.seeded.token,
    input.seeded.controllerKey,
    input.seeded.interactionId,
    input.seeded.threadId,
    String(input.seeded.fence.generation),
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const result = new Promise<CallbackRaceResult>((resolveResult, rejectResult) => {
    child.once("error", rejectResult);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectResult(new Error(`callback race worker exited ${code}: ${stderr || stdout}`));
        return;
      }
      const line = stdout.trim().split("\n").at(-1);
      if (!line) {
        rejectResult(new Error(`callback race worker returned no result: ${stderr}`));
        return;
      }
      try {
        resolveResult(JSON.parse(line) as CallbackRaceResult);
      } catch (error) {
        rejectResult(new Error(`callback race worker returned invalid JSON: ${stdout}`, { cause: error }));
      }
    });
  });
  return { child, result };
}

async function runCallbackRace(
  fixture: ReturnType<typeof ingressFixture>,
  seeded: ReturnType<typeof seedControllerInteraction>,
): Promise<CallbackRace> {
  const barrierDir = mkdtempSync(join(tmpdir(), "telegram-controller-callback-race-"));
  const scriptPath = join(barrierDir, "worker.ts");
  writeFileSync(scriptPath, callbackRaceWorkerSource()
    .replace("TELEGRAM_INGRESS_MODULE", resolve("src/telegram/ingress.ts"))
    .replace("STORE_MODULE", resolve("src/storage/store.ts"))
    .replace("INTERACTION_SERVICE_MODULE", resolve("src/controller/interaction-service.ts")));
  const workers = [
    startCallbackRaceWorker({
      scriptPath,
      fixture,
      barrierDir,
      label: "one",
      callbackId: "callback-race-one",
      seeded,
    }),
    startCallbackRaceWorker({
      scriptPath,
      fixture,
      barrierDir,
      label: "two",
      callbackId: "callback-race-two",
      seeded,
    }),
  ];
  let resultProduced = false;
  try {
    await Promise.all([
      waitForCallbackRaceFile(join(barrierDir, "ready-one")),
      waitForCallbackRaceFile(join(barrierDir, "ready-two")),
    ]);
    writeFileSync(join(barrierDir, "go"), "go");
    const race = { results: await Promise.all(workers.map((worker) => worker.result)), barrierDir };
    resultProduced = true;
    return race;
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
    }
    if (!resultProduced) rmSync(barrierDir, { recursive: true, force: true });
  }
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

it("authenticates and atomically records a generic controller callback before nudging", async () => {
  let durableBeforeNudge = false;
  let nudges = 0;
  let fixture: ReturnType<typeof ingressFixture>;
  fixture = ingressFixture({
    owner: { userId: "7", chatId: "70" },
    onWorkAvailable: () => {
      nudges += 1;
      const row = fixture.db.prepare(
        "SELECT state, answer_json FROM controller_interactions WHERE interaction_id = ?",
      ).get("ingress_question") as { state: string; answer_json: string | null } | undefined;
      durableBeforeNudge = row?.state === "answered" && row.answer_json !== null &&
        fixture.store.getCallback("controller-callback")?.outcome === "accepted" &&
        fixture.store.getOutbox("callback:controller-callback")?.payload.text === "Got it.";
    },
  });
  const seeded = seedControllerInteraction(fixture, {
    kind: "user_question",
    interactionId: "ingress_question",
    questions: [{
      id: "route",
      prompt: "Which route?",
      shortLabel: "Route",
      multiSelect: false,
      allowFreeText: true,
      options: [{ value: "first", label: "First", description: "Use the first route." }],
    }],
  });

  const callback = callbackUpdate(
    90_002,
    "controller-callback",
    7,
    70,
    encodeCallbackData({ type: "controller_interaction", token: seeded.token }),
  );
  await fixture.ingress.handleClaimed(callback, 9_002);
  await fixture.ingress.handleClaimed(callback, 9_003);

  expect(fixture.db.prepare(
    "SELECT state, answer_json FROM controller_interactions WHERE interaction_id = ?",
  ).get("ingress_question")).toMatchObject({ state: "answered" });
  expect(fixture.store.getCallback("controller-callback")).toMatchObject({
    action: "controller_interaction",
    outcome: "accepted",
  });
  expect(fixture.store.getOutbox("callback:controller-callback")?.payload.text).toBe("Got it.");
  expect(durableBeforeNudge).toBe(true);
  expect(nudges).toBe(1);
  expect(fixture.store.listControllerTurns(seeded.controllerKey, 10)).toHaveLength(1);
});

it("races real ingress wrappers and delivers the durable winner through one nudge", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  const seeded = seedControllerInteraction(fixture, {
    kind: "approval",
    interactionId: "ingress_wrapper_race",
    summary: "wants to run a bounded command",
    decisions: ["allow_once", "deny"],
  });
  const race = await runCallbackRace(fixture, seeded);
  try {
    const workerResults = race.results;
    expect(workerResults.map((result) => result.outcome).sort()).toEqual(["accepted", "stale"]);
    expect(workerResults.reduce((total, result) => total + result.nudgeCalls, 0)).toBe(1);
    expect(workerResults.filter((result) => result.delivered)).toHaveLength(1);
    expect(workerResults.filter((result) => result.delivered && !result.answeredRemaining)).toHaveLength(1);
    expect(workerResults.filter((result) => result.providerOwner)).toHaveLength(1);
    expect(workerResults.filter((result) => result.nudgeOwner)).toHaveLength(1);
    expect(workerResults.reduce((total, result) => total + result.providerGetCalls, 0)).toBe(1);
    expect(workerResults.reduce((total, result) => total + result.providerResolveCalls, 0)).toBe(1);
    expect(workerResults.every((result) => !result.providerDuplicate && !result.nudgeDuplicate)).toBe(true);
    expect(readFileSync(join(race.barrierDir, "provider-resolution-owner"), "utf8")).toMatch(/^(one|two)$/);
    expect(readFileSync(join(race.barrierDir, "nudge-owner"), "utf8")).toMatch(/^(one|two)$/);
    for (const result of workerResults) {
      expect(fixture.store.getCallback(result.callbackId)).toMatchObject({ outcome: result.outcome });
      expect(fixture.store.getOutbox(`callback:${result.callbackId}`)?.payload.text).toBe(
        result.outcome === "accepted" ? "Got it." : "That interaction is no longer open.",
      );
    }
    expect(fixture.db.prepare(
      "SELECT state, delivered_at FROM controller_interactions WHERE interaction_id = ?",
    ).get(seeded.interactionId)).toEqual({ state: "delivered", delivered_at: 9_002 });

    const get = vi.fn(async (requestedThreadId: string, requestedInteractionId: string) => ({
      id: requestedInteractionId,
      threadId: requestedThreadId,
      status: "pending",
    }));
    const resolve = vi.fn(async (input: {
      threadId: string;
      interactionId: string;
      resolution: Record<string, unknown>;
    }) => {
      return { id: input.interactionId, threadId: input.threadId, status: "resolved" };
    });
    const interactionStore: ControllerInteractionStore = {
      isControllerInteractionDeliveryFenceCurrent: (input) => fixture.store.isControllerInteractionDeliveryFenceCurrent(input),
      record: (input) => fixture.store.recordControllerInteraction(input),
      markResolved: (input) => fixture.store.markControllerInteractionResolved(input),
      answerByToken: (input) => fixture.store.answerControllerInteractionByToken(input),
      answerWithText: (input) => fixture.store.answerControllerInteractionWithText(input),
      getPending: (controllerKey) => fixture.store.getPendingControllerInteraction(controllerKey),
      getAnswered: (controllerKey) => fixture.store.getAnsweredControllerInteraction(controllerKey),
      markDelivered: (input) => fixture.store.markControllerInteractionDelivered(input),
    };
    const interactionService = new ControllerInteractionService({
      store: interactionStore,
      clock: { now: () => 9_100 },
      interactions: { get, resolve },
    });
    const serviceFence = { ...seeded.fence, now: 9_100 };

    await expect(interactionService.deliverAnswered(seeded.controllerKey, serviceFence, AbortSignal.timeout(2_000)))
      .resolves.toBe(false);

    expect(resolve).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(existsSync(join(race.barrierDir, "provider-resolution-duplicate-one"))).toBe(false);
    expect(existsSync(join(race.barrierDir, "provider-resolution-duplicate-two"))).toBe(false);
    expect(fixture.store.getAnsweredControllerInteraction(seeded.controllerKey)).toBeNull();
    expect(fixture.store.listControllerTurns(seeded.controllerKey, 10)).toHaveLength(1);
  } finally {
    rmSync(race.barrierDir, { recursive: true, force: true });
    fixture.db.close();
  }
});

it("does not let wrong-identity controller callbacks consume the parked interaction", async () => {
  let nudges = 0;
  const fixture = ingressFixture({
    owner: { userId: "7", chatId: "70" },
    onWorkAvailable: () => { nudges += 1; },
  });
  const seeded = seedControllerInteraction(fixture, {
    kind: "approval",
    interactionId: "ingress_approval",
    summary: "wants to run a bounded command",
    decisions: ["allow_once", "deny"],
  });
  await fixture.ingress.handleClaimed(callbackUpdate(
    90_004,
    "wrong-controller-callback",
    8,
    70,
    encodeCallbackData({ type: "controller_interaction", token: seeded.token }),
  ), 9_004);

  expect(fixture.store.getPendingControllerInteraction(seeded.controllerKey)?.interactionId)
    .toBe("ingress_approval");
  expect(fixture.store.getCallback("wrong-controller-callback")).toBeNull();
  expect(nudges).toBe(0);
});

it("routes plain text to the oldest pending controller question instead of queueing a new turn", async () => {
  let nudges = 0;
  const fixture = ingressFixture({
    owner: { userId: "7", chatId: "70" },
    onWorkAvailable: () => { nudges += 1; },
  });
  const seeded = seedControllerInteraction(fixture, {
    kind: "user_question",
    interactionId: "ingress_text_question",
    questions: [{
      id: "route",
      prompt: "Which route?",
      shortLabel: "Route",
      multiSelect: false,
      allowFreeText: true,
      options: [{ value: "first", label: "First", description: null }],
    }],
  });

  await fixture.ingress.handleClaimed(messageUpdate(90_005, 7, 70, "Use the fallback route."), 9_005);

  expect(fixture.store.getAnsweredControllerInteraction(seeded.controllerKey)).toMatchObject({
    interactionId: "ingress_text_question",
    resolution: { kind: "user_answer" },
  });
  expect(fixture.store.listControllerTurns(seeded.controllerKey, 10)).toHaveLength(1);
  expect(nudges).toBe(1);
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
