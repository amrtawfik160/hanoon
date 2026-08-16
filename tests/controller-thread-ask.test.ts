import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import {
  MAX_LISTED_THREAD_ASKS,
  THREAD_ASK_HEADING,
  THREAD_ASK_REDACTED,
  THREAD_ASK_UNNAMED_THREAD,
  composeOwnerReply,
  renderThreadAskReport,
} from "../src/controller/thread-ask";
import { hashSecret } from "../src/crypto";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { completeTurnThroughFinalization } from "./support/controller-trust-fixtures";

let fixtureNumber = 0;

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-thread-ask-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair-thread-ask"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-thread-ask"), "7", "7", 1_001)).toEqual({ ok: true });
  const lease = store.acquireExecutorLease("executor", 2_000, 30_000);
  if (!lease.acquired) throw new Error("executor lease was not acquired");
  return { bb, store, fence: { ownerId: "executor", generation: lease.generation, now: 2_000 } };
}

/**
 * Drive one turn to the point where the controller may message a thread. The
 * first turn spawns the controller thread; later turns are sent to the thread
 * that already exists, which is how a real second turn reaches the owner.
 */
function submitTurn(
  store: TelegramAgentStore,
  fence: { ownerId: string; generation: number; now: number },
  updateId: number,
  inputText: string,
) {
  const turn = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId,
    inputText,
    now: 2_000,
  });
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  const spawned = store.getControllerByThreadId("thr_controller") !== null;
  if (spawned) {
    expect(store.prepareControllerDispatch({
      ...fence,
      turnId: turn.id,
      kind: "send",
      expectedThreadId: "thr_controller",
    })).toBe(true);
  } else {
    expect(store.markControllerSpawned({
      ...fence,
      turnId: turn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
      threadId: "thr_controller",
    })).toBe(true);
  }
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ...fence })).toBe(true);
  return turn;
}

function ownerReplyFor(store: TelegramAgentStore, turnId: string): string {
  const reply = store.getOutbox(`controller:${turnId}:reply`);
  if (!reply) throw new Error("controller reply was not queued for the owner");
  const { text } = reply.payload;
  if (typeof text !== "string") throw new Error("controller reply carried no text for the owner");
  return text;
}

it("states what the controller asked a thread to do, naming the thread", () => {
  const report = renderThreadAskReport([
    { threadId: "thr_a", threadName: "Payments API", ask: "prove the false-reject with a failing test, not an assertion" },
    { threadId: "thr_b", threadName: "Release runner", ask: "stop merging by hand and wait for the owner's tap" },
  ], 1_000);

  expect(report?.reportedCount).toBe(2);
  expect(report?.block).toBe([
    "",
    "",
    THREAD_ASK_HEADING,
    "- Payments API: prove the false-reject with a failing test, not an assertion",
    "- Release runner: stop merging by hand and wait for the owner's tap",
  ].join("\n"));
});

it("still names the target when the thread has no title", () => {
  const report = renderThreadAskReport(
    [{ threadId: "thr_a", threadName: null, ask: "roll back the migration" }],
    1_000,
  );

  expect(report?.block).toContain(`- ${THREAD_ASK_UNNAMED_THREAD}: roll back the migration`);
});

it("counts asks it cannot list, and reports only the ones it named", () => {
  const asks = Array.from({ length: MAX_LISTED_THREAD_ASKS + 3 }, (_, index) => ({
    threadId: `thr_${index}`,
    threadName: `Thread ${index}`,
    ask: `ask number ${index}`,
  }));

  const report = renderThreadAskReport(asks, 10_000);

  // The unnamed remainder stays owed rather than being written off as told,
  // so the next reply can name it.
  expect(report?.reportedCount).toBe(MAX_LISTED_THREAD_ASKS);
  expect(report?.block).toContain("- and 3 more");
});

it("drops the report rather than pushing the owner's message over the limit", () => {
  const asks = [{ threadId: "thr_a", threadName: "Payments API", ask: "a".repeat(120) }];

  expect(renderThreadAskReport(asks, 20)).toBeNull();
  expect(composeOwnerReply("done", asks, 4)).toEqual({ text: "done", reportedCount: 0 });
});

it("never alters the reply the evidence gate accepted", () => {
  const accepted = "The build is still running.";
  const composed = composeOwnerReply(
    accepted,
    [{ threadId: "thr_a", threadName: "Payments API", ask: "re-run the failing suite" }],
    4_096,
  );

  expect(composed.text.startsWith(accepted)).toBe(true);
});

it("tells the owner what was asked on the reply that closes the turn, once", () => {
  const { store, fence } = fixture();
  const first = submitTurn(store, fence, 301, "Get the payments thread to prove it");
  store.recordControllerThreadAsk({
    controllerKey: "owner-7-controller",
    turnId: first.id,
    threadId: "thr_payments",
    threadName: "Payments API",
    ask: "prove the false-reject with a failing test instead of asserting it",
    now: 2_000,
  });

  completeTurnThroughFinalization(store, fence, {
    turnId: first.id,
    controllerKey: "owner-7-controller",
    responseText: "The review is still open.",
  });

  const reply = ownerReplyFor(store, first.id);
  expect(reply).toContain("The review is still open.");
  expect(reply).toContain(THREAD_ASK_HEADING);
  expect(reply).toContain("- Payments API: prove the false-reject with a failing test instead of asserting it");
  expect(store.unreportedControllerThreadAsks("owner-7-controller")).toEqual([]);

  // A later turn must not repeat an ask the owner has already been told.
  const second = submitTurn(store, fence, 302, "Anything else?");
  completeTurnThroughFinalization(store, fence, {
    turnId: second.id,
    controllerKey: "owner-7-controller",
    responseText: "Nothing further.",
  });
  expect(ownerReplyFor(store, second.id)).not.toContain(THREAD_ASK_HEADING);
});

it("reports an ask whose turn died before it could reply", () => {
  const { store, fence } = fixture();
  const abandoned = submitTurn(store, fence, 401, "Tell the release thread to stop");
  store.recordControllerThreadAsk({
    controllerKey: "owner-7-controller",
    turnId: abandoned.id,
    threadId: "thr_release",
    threadName: "Release runner",
    ask: "stop merging by hand, wait for the owner's tap",
    now: 2_000,
  });
  // The turn never reaches its finalization: the ask was made in the owner's
  // name and must not die with the turn that made it.
  expect(store.failControllerTurn({
    ...fence,
    turnId: abandoned.id,
    failureCode: "stalled",
    error: "provider went away",
  })).toBe(true);

  const next = submitTurn(store, fence, 402, "What happened?");
  completeTurnThroughFinalization(store, fence, {
    turnId: next.id,
    controllerKey: "owner-7-controller",
    responseText: "The last turn failed.",
  });

  expect(ownerReplyFor(store, next.id))
    .toContain("- Release runner: stop merging by hand, wait for the owner's tap");
});

it("reports that an ask was made even when its text cannot be safely repeated", () => {
  const { store, fence } = fixture();
  const turn = submitTurn(store, fence, 501, "Send the token over");
  store.recordControllerThreadAsk({
    controllerKey: "owner-7-controller",
    turnId: turn.id,
    threadId: "thr_deploy",
    threadName: "Deploy",
    ask: "use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    now: 2_000,
  });

  completeTurnThroughFinalization(store, fence, {
    turnId: turn.id,
    controllerKey: "owner-7-controller",
    responseText: "That is with the deploy thread now.",
  });

  const reply = ownerReplyFor(store, turn.id);
  expect(reply).toContain(`- Deploy: ${THREAD_ASK_REDACTED}`);
  expect(reply).not.toContain("sk-ant-api03");
});
