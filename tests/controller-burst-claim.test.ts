import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { IdempotencyConflictError, openStore } from "../src/storage/store";
import {
  CONTROLLER_BURST_MAX_ATTACHMENTS,
  CONTROLLER_BURST_MAX_MEMBERS,
  CONTROLLER_BURST_MAX_TEXT_CHARS,
  CONTROLLER_BURST_QUIET_GAP_MS,
} from "../src/controller/burst";

const OWNER = "7";

let fixtureNumber = 0;

function open() {
  const fixtureId = `burst-${fixtureNumber++}`;
  const { bb } = createFakePluginHost({ pluginId: fixtureId });
  const store = openStore(bb.storage, bb.storage.kv, () => 1_000_000);
  store.createPairingCode(hashSecret(`pair:${fixtureId}`), 1, 10_000);
  const paired = store.pairOwnerWithCode(hashSecret(`pair:${fixtureId}`), OWNER, OWNER, 2);
  if (!paired.ok) throw new Error("burst fixture owner could not be paired");
  const lease = store.acquireExecutorLease("executor", 1_000_000, 60_000);
  if (!lease.acquired) throw new Error("burst fixture lease was unavailable");
  const fence = { ownerId: "executor", generation: lease.generation, now: 1_000_000 };
  return { store, fence };
}

function enqueue(
  store: ReturnType<typeof openStore>,
  updateId: number,
  inputText: string,
  receivedAt: number,
  extra: Record<string, unknown> = {},
) {
  return store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: OWNER,
    telegramChatId: OWNER,
    updateId,
    inputText,
    now: receivedAt,
    ...extra,
  });
}


// Primary seam: the controller service with the real store and a fake adapter,
// asserting on the exact input the controller thread receives.
import { LunaControllerService } from "../src/controller/service";
import type { ControllerAdapter } from "../src/controller/bb-controller";
import type { ControllerAttachment } from "../src/controller/models";

async function serviceFixtureWithBurst(options: {
  documents?: boolean;
} = {}) {
  const { store, fence } = open();
  const sent: { threadId: string; text: string; attachments: unknown }[] = [];
  const spawned: { id: string; inputText: string; attachments: ControllerAttachment[] | null }[] = [];
  const steered: string[] = [];
  const uploads: { filename: string; mimeType?: string }[] = [];
  const adapter: ControllerAdapter = {
    spawn: async (turn, _controller, _signal, attachments = null) => {
      spawned.push({ id: turn.id, inputText: turn.inputText, attachments });
      // The real adapter reserves the project/host before spawning.
      if (!store.reserveControllerSpawn({
        controllerKey: turn.controllerKey,
        turnId: turn.id,
        projectId: "proj_personal",
        hostId: "host_personal",
        now: 1_000_000,
      })) throw new Error("spawn reservation failed");
      return {
        threadId: "thr_burst_service",
        projectId: "proj_personal",
        hostId: "host_personal",
        spawnToken: turn.id,
      };
    },
    send: async (threadId, text, _signal, attachments) => {
      sent.push({ threadId, text, attachments });
    },
    steer: async (_threadId, text) => { steered.push(text); },
    status: async () => "idle" as const,
    latestSeq: async () => 0,
    events: async () => ({ latestSeq: 0, inputAccepted: true, assistantOutputObserved: true, toolActivityObserved: false, completed: true, error: null, interactionReferences: [], toolCalls: 0, commandFailures: 0, totalTokens: 0 }),
    answerQuestion: async () => undefined,
    findSpawnCandidate: async () => null,
  };
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector: { reconcile: async () => ({ outcome: "reconciled", reconciliationIncomplete: null, fromSeq: 0, throughSeq: 0, targetSeq: 0 }) },
    clock: { now: () => 1_000_000 },
    ...(options.documents ? {
      downloadFile: async (fileId: string) => {
        if (fileId === "md-file") {
          uploads.push({ filename: "brief.md" });
          return new TextEncoder().encode("# The brief\nShip on Friday.");
        }
        return new Uint8Array([1, 2, 3]);
      },
    } : {}),
  });
  const signal = AbortSignal.timeout(2_000);
  const serviceFence = { ...fence, signal };
  return { store, fence, serviceFence, service, sent, spawned, steered, uploads };
}

it("dispatches a burst as one attributed transcript through the service", async () => {
  const { store, serviceFence, service, spawned } = await serviceFixtureWithBurst();
  enqueue(store, 1, "what do you think about below convo?", 996_500);
  enqueue(store, 2, "the launch plan is delayed", 996_900, {
    source: { kind: "forwarded", forwardedFrom: "Tom Counsell", forwardedHidden: false, quotedAuthor: null, quotedFromAgent: false, quotedText: null, replyToMessageId: null, albumId: null },
  });
  enqueue(store, 3, "please check section 2", 997_300);

  await service.processOne(serviceFence, serviceFence.signal);

  // The spawn opens with the digest context, then the burst transcript.
  const transcript = [
    "1. You: what do you think about below convo?",
    "2. Forwarded from Tom Counsell: the launch plan is delayed",
    "3. You: please check section 2",
  ].join("\n");
  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.inputText.endsWith(transcript)).toBe(true);
});

it("sends a later single message with its own words unchanged", async () => {
  const { store, serviceFence, service, spawned, sent } = await serviceFixtureWithBurst();
  enqueue(store, 1, "a lone question", 996_500);
  await service.processOne(serviceFence, serviceFence.signal);
  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.inputText).toBe("a lone question");

  const { completeTurnThroughFinalization } = await import("./support/controller-trust-fixtures");
  completeTurnThroughFinalization(store, { ...serviceFence, now: serviceFence.now }, {
    turnId: spawned[0]!.id, controllerKey: "owner-7-controller", responseText: "Done.",
  });

  enqueue(store, 2, "and one more thing", 993_000);
  await service.processOne(serviceFence, serviceFence.signal);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).toBe("and one more thing");
});

function enqueuedId(store: ReturnType<typeof openStore>, updateId: number): string {
  return `controller-turn-${updateId}`;
}

it("uploads a burst's documents and inlines a short markdown body", async () => {
  const { store, serviceFence, service, spawned, uploads } = await serviceFixtureWithBurst({ documents: true });
  enqueue(store, 1, "what do you think about below convo?", 996_500);
  enqueue(store, 2, "Please read this file.", 996_900, {
    document: {
      fileId: "md-file",
      fileName: "brief.md",
      mimeType: "text/markdown" as const,
      sizeBytes: 28,
    },
  });

  await service.processOne(serviceFence, serviceFence.signal);

  expect(uploads).toEqual([{ filename: "brief.md" }]);
  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.inputText).toContain("2. You:");
  expect(spawned[0]!.inputText).toContain("File attached: brief.md");
  expect(spawned[0]!.inputText).toContain("# The brief");
  expect(spawned[0]!.inputText).toContain("Ship on Friday.");
  // The inlined body is dispatch-time only: it never persists.
  expect(store.getControllerTurn(enqueuedId(store, 1))?.inputText).toBe("what do you think about below convo?");
});

it("fetches an inlined document once and hands the adapter the bytes it already has", async () => {
  const { store, serviceFence, service, spawned, uploads } = await serviceFixtureWithBurst({ documents: true });
  enqueue(store, 1, "Please read this file.", 996_500, {
    document: { fileId: "md-file", fileName: "brief.md", mimeType: "text/markdown" as const, sizeBytes: 28 },
  });

  await service.processOne(serviceFence, serviceFence.signal);

  // One Telegram download for the whole dispatch: the dispatcher fetched the
  // file to inline it, and the adapter uploads those same bytes.
  expect(uploads).toEqual([{ filename: "brief.md" }]);
  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.attachments).toHaveLength(1);
  expect(spawned[0]!.attachments![0]).toMatchObject({ fileId: "md-file", kind: "document" });
  expect(new TextDecoder().decode(spawned[0]!.attachments![0]!.bytes)).toBe("# The brief\nShip on Friday.");
});
