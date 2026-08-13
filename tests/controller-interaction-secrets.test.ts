import { createHash } from "node:crypto";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import { BbControllerAdapter } from "../src/controller/bb-controller";
import { ControllerInteractionService } from "../src/controller/interaction-service";
import { ControllerInteractionRepository } from "../src/storage/controller-interaction-repository";
import { LunaControllerService } from "../src/controller/service";
import { DEFAULT_CONTROLLER_EXECUTION_PROFILE } from "../src/controller/execution-profile";
import { parseControllerInteraction, parseThreadInteraction } from "../src/controller/questions";
import { policyFixture } from "./helpers";
import type { ControllerEvidenceReconciler } from "../src/controller/evidence-projector";

const OWNER = "7";
const THREAD_ID = "thr_secret_controller";
const INTERACTION_ID = "pint_secret";
const CONTROLLER_KEY = createHash("sha256")
  .update(`telegram-controller:${OWNER}:${OWNER}`, "utf8")
  .digest("base64url")
  .slice(0, 32);

/**
 * One marker per field, so a leak names the exact field it came through rather
 * than merely proving that something leaked.
 */
const SECRETS = {
  prompt: "token: sk-promptleak0000000000",
  shortLabel: "token: sk-shortlabelleak000000",
  optionValue: "token: sk-optionvalueleak00000",
  optionLabel: "token: sk-optionlabelleak00000",
  optionDescription: "token: sk-optiondescleak0000000",
  approval: "token: sk-approvalleak000000000",
} as const;

const ALL_MARKERS = Object.values(SECRETS);

let hostNumber = 0;

const evidenceProjector: ControllerEvidenceReconciler = {
  reconcile: vi.fn(async (_controller, turn) => ({
    outcome: "reconciled" as const,
    reconciliationIncomplete: null,
    fromSeq: turn.evidenceEventSeq,
    throughSeq: turn.evidenceEventSeq,
    targetSeq: turn.evidenceEventSeq,
  })),
};

function safeQuestionPayload() {
  return {
    kind: "user_question",
    questions: [{
      id: "q1",
      prompt: "Which branch should I ship?",
      shortLabel: "Branch",
      multiSelect: false,
      allowFreeText: true,
      options: [{ value: "main", label: "Main", description: "The release branch." }],
    }],
  };
}

function questionPayloadWith(field: keyof typeof SECRETS) {
  const payload = safeQuestionPayload();
  const question = payload.questions[0]!;
  const option = question.options[0]!;
  if (field === "prompt") question.prompt = SECRETS.prompt;
  if (field === "shortLabel") question.shortLabel = SECRETS.shortLabel;
  if (field === "optionValue") option.value = SECRETS.optionValue;
  if (field === "optionLabel") option.label = SECRETS.optionLabel;
  if (field === "optionDescription") option.description = SECRETS.optionDescription;
  return payload;
}

it.each([
  ["a question prompt", "prompt"],
  ["a question short label", "shortLabel"],
  ["an option value", "optionValue"],
  ["an option label", "optionLabel"],
  ["an option description", "optionDescription"],
] as const)("downgrades a controller question carrying a credential in %s", (_scenario, field) => {
  const projected = parseControllerInteraction(INTERACTION_ID, questionPayloadWith(field));

  // Still identified, so the cursor can move past it; just not answerable.
  expect(projected).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "user_question" },
  });
  expect(JSON.stringify(projected)).not.toContain(SECRETS[field]);
});

it.each([
  ["a question prompt", "prompt"],
  ["an option label", "optionLabel"],
] as const)("keeps a worker-thread question carrying a credential in %s off Telegram", (_scenario, field) => {
  const projected = parseThreadInteraction(INTERACTION_ID, questionPayloadWith(field));

  expect(projected).toEqual({ kind: "unsupported", interactionId: INTERACTION_ID });
  expect(JSON.stringify(projected)).not.toContain(SECRETS[field]);
});

it("downgrades an approval whose command carries a credential", () => {
  const projected = parseControllerInteraction(INTERACTION_ID, {
    kind: "approval",
    subject: { kind: "command", command: `curl -H "Authorization: Bearer ${SECRETS.approval}"` },
    availableDecisions: ["allow_once", "deny"],
  });

  expect(projected).toMatchObject({ kind: "approval", summary: "wants to run:\n\n`a redacted command`" });
  expect(JSON.stringify(projected)).not.toContain(SECRETS.approval);
});

it("still projects an ordinary safe question and approval in full", () => {
  expect(parseControllerInteraction(INTERACTION_ID, safeQuestionPayload())).toMatchObject({
    kind: "user_question",
    questions: [{ prompt: "Which branch should I ship?", shortLabel: "Branch" }],
  });
  expect(parseControllerInteraction(INTERACTION_ID, {
    kind: "approval",
    subject: { kind: "command", command: "npm test" },
    availableDecisions: ["allow_once", "deny"],
  })).toMatchObject({ kind: "approval", summary: "wants to run:\n\n`npm test`" });
});

it("keeps a malformed identity invalid rather than downgrading it", () => {
  expect(parseControllerInteraction("", safeQuestionPayload())).toBeNull();
  expect(parseControllerInteraction(INTERACTION_ID, "not-an-object")).toBeNull();
});

/**
 * The whole durable path for one provider question: the real service records
 * whatever BB returns into a real file-backed SQLite database and enqueues the
 * real Telegram outbox row. Nothing here is stubbed at the storage layer, so a
 * leak would show up in the bytes on disk.
 */
it("keeps a provider credential out of storage, the outbox, and the logs", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: `telegram-secret-${hostNumber++}` });
  const database = bb.storage.database();
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.upsertProjectPolicy(policyFixture(), 1_500);
  store.createPairingCode(hashSecret("pair-secret"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-secret"), OWNER, OWNER, 1_001)).toEqual({ ok: true });
  const lease = store.acquireExecutorLease("executor", 2_000, 60 * 60_000);
  if (!lease.acquired) throw new Error("executor lease was unavailable");
  const fence = { ownerId: "executor", generation: lease.generation, now: 2_000 };
  const signal = AbortSignal.timeout(5_000);

  const leaked = questionPayloadWith("prompt");
  const question = leaked.questions[0]!;
  question.shortLabel = SECRETS.shortLabel;
  question.options[0]!.value = SECRETS.optionValue;
  question.options[0]!.label = SECRETS.optionLabel;
  question.options[0]!.description = SECRETS.optionDescription;

  harness.sdk.stub("threads.get", async () => ({
    id: THREAD_ID, projectId: "proj_secret", status: "active",
    providerId: "claude-code", archivedAt: null, deletedAt: null,
  }));
  harness.sdk.stub("threads.timeline", async () => ({ maxSeq: 5 }));
  harness.sdk.stub("threads.events.list", async ({ afterSeq = "0" }: { afterSeq?: string }) => (
    Number(afterSeq) >= 5 ? [] : [{
      id: "e5", threadId: THREAD_ID, seq: 5, createdAt: 5, scope: { kind: "turn" },
      type: "system/userQuestion/lifecycle",
      data: { interactionId: INTERACTION_ID, providerId: "claude-code", status: "pending", resolution: null },
    }]
  ));
  harness.sdk.stub("threads.interactions.get", async () => ({
    id: INTERACTION_ID, threadId: THREAD_ID, status: "pending", payload: leaked,
  }));

  const logged: string[] = [];
  const turn = store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY, telegramUserId: OWNER, telegramChatId: OWNER,
    updateId: 300, inputText: "ship it", now: 2_000,
  });
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    ...fence, turnId: turn.id, projectId: "proj_secret", hostId: "host_secret", threadId: THREAD_ID,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, turnId: turn.id })).toBe(true);

  const service = new LunaControllerService({
    store,
    adapter: new BbControllerAdapter({
      sdk: bb.sdk, pluginId: bb.pluginId,
      executionProfile: () => DEFAULT_CONTROLLER_EXECUTION_PROFILE,
    }),
    evidenceProjector,
    interactionService: new ControllerInteractionService({
      store: new ControllerInteractionRepository(database),
      interactions: bb.sdk.threads.interactions,
      clock: () => 2_100,
    }),
    clock: { now: () => 2_100 },
  });

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  const recorded = store.getPendingControllerInteraction(CONTROLLER_KEY);
  expect(recorded?.interaction).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "user_question" },
  });

  // Every durable and outbound surface, checked against the raw bytes.
  const payloadRows = database
    .prepare("SELECT payload_json FROM controller_interactions")
    .all() as { payload_json: string }[];
  expect(payloadRows).toHaveLength(1);
  const outbox = JSON.stringify(store.listOutbox(50));
  const wholeDatabase = database
    .prepare("SELECT group_concat(sql, ' ') AS schema FROM sqlite_master")
    .get() as { schema: string | null };

  for (const marker of ALL_MARKERS) {
    expect(payloadRows[0]!.payload_json).not.toContain(marker);
    expect(outbox).not.toContain(marker);
    expect(wholeDatabase.schema ?? "").not.toContain(marker);
    expect(logged.join("\n")).not.toContain(marker);
  }
  // The owner is still told the thread is blocked, just not with the secret.
  expect(outbox).toContain("can't answer from here");
});
