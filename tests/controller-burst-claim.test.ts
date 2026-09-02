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

it("claims a burst as one leader and folds followers that arrived within the quiet gap", () => {
  const { store, fence } = open();
  const leader = enqueue(store, 1, "what do you think about below convo?", 996_500);
  const forwarded = enqueue(store, 2, "the forwarded words", 996_900, {
    source: { kind: "forwarded", forwardedFrom: "Tom Counsell", forwardedHidden: false, quotedAuthor: null, quotedFromAgent: false, quotedText: null, replyToMessageId: null, albumId: null },
  });
  const plain = enqueue(store, 3, "and also this", 997_300);

  const claimed = store.claimNextControllerTurn(fence);

  expect(claimed).toMatchObject({ id: leader.id, state: "dispatching" });
  expect(store.getControllerTurn(forwarded.id)).toMatchObject({ state: "completed", burstLeaderTurnId: leader.id });
  expect(store.getControllerTurn(plain.id)).toMatchObject({ state: "completed", burstLeaderTurnId: leader.id });
  // The leader's answer is the burst's answer: no answer was in progress when
  // the burst was claimed, so nothing is acknowledged as folded into one.
  const acknowledgements = store.listOutbox(50)
    .filter((row) => /already writing/i.test(String(row.payload.text ?? "")));
  expect(acknowledgements).toHaveLength(0);
  // The conversation digest records the burst once, with the leader's answer,
  // rather than each member as a turn of its own.
  expect(store.readControllerDigest("owner-7-controller", 10)).toHaveLength(0);
});

it("claims a system turn alone, at once, and folds no owner message into it", () => {
  const { store, fence } = open();
  const systemTurn = enqueue(store, 1, "system check", 999_900, { origin: "system" as const });
  const owner = enqueue(store, 2, "my own question", 999_950);

  // A system turn is no burst: it neither waits out the quiet gap nor takes
  // the owner's words that happened to arrive right behind it.
  expect(store.claimNextControllerTurn(fence)).toMatchObject({ id: systemTurn.id, state: "dispatching" });
  expect(store.getControllerTurn(owner.id)).toMatchObject({ state: "queued", burstLeaderTurnId: null });
});

it("round-trips a reply that quotes up to 500 characters", () => {
  const { store, fence } = open();
  const quotedText = "q".repeat(500);
  const turn = enqueue(store, 1, "this one", 996_500, {
    source: { kind: "reply", forwardedFrom: null, forwardedHidden: false, quotedAuthor: "Tom Counsell", quotedFromAgent: false, quotedText, replyToMessageId: 44, albumId: null },
  });
  expect(store.getControllerTurn(turn.id)?.source?.quotedText).toBe(quotedText);
  expect(store.claimNextControllerTurn(fence)).toMatchObject({ id: turn.id });
});

it("treats a repeated update as the same turn only when its provenance and file match", () => {
  const { store } = open();
  const source = { kind: "forwarded" as const, forwardedFrom: "Tom Counsell", forwardedHidden: false, quotedAuthor: null, quotedFromAgent: false, quotedText: null, replyToMessageId: null, albumId: null };
  const document = { fileId: "pdf-1", fileName: "review.pdf", mimeType: "application/pdf" as const, sizeBytes: 4_000 };
  const first = enqueue(store, 1, "look at this", 996_500, { source, document });

  expect(enqueue(store, 1, "look at this", 996_500, { source, document }).id).toBe(first.id);
  expect(() => enqueue(store, 1, "look at this", 996_500, { source: { ...source, forwardedFrom: "Someone Else" }, document }))
    .toThrow(IdempotencyConflictError);
  expect(() => enqueue(store, 1, "look at this", 996_500, { source, document: { ...document, fileId: "pdf-2" } }))
    .toThrow(IdempotencyConflictError);
});

it("renders the burst transcript with attribution when the leader completes", async () => {
  const { store, fence } = open();
  const leader = enqueue(store, 1, "framing line", 996_500);
  enqueue(store, 2, "forwarded words", 996_900, {
    source: { kind: "forwarded", forwardedFrom: "Tom Counsell", forwardedHidden: false, quotedAuthor: null, quotedFromAgent: false, quotedText: null, replyToMessageId: null, albumId: null },
  });
  store.claimNextControllerTurn(fence);
  // Nothing enters the conversation digest until the burst is answered...
  const digestAfterClaim = store.readControllerDigest("owner-7-controller", 10);
  expect(digestAfterClaim).toHaveLength(0);

  expect(store.markControllerSpawned({
    turnId: leader.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_burst_transcript",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: leader.id, ...fence })).toBe(true);
  const { completeTurnThroughFinalization } = await import("./support/controller-trust-fixtures");
  completeTurnThroughFinalization(store, fence, {
    turnId: leader.id, controllerKey: leader.controllerKey, responseText: "Here is my read.",
  });
  // ...and then the leader's digest row records the whole attributed
  // transcript, once, with the answer that covered it.
  const digest = store.readControllerDigest("owner-7-controller", 10);
  expect(digest).toHaveLength(1);
  const leaderRow = digest[0]!;
  expect(leaderRow.agentText).toBe("Here is my read.");
  expect(leaderRow.ownerText).toContain("1. You: framing line");
  expect(leaderRow.ownerText).toContain("2. Forwarded from Tom Counsell: forwarded words");
});

it("starts a second dispatch when a message arrives after the quiet gap", async () => {
  const { store, fence } = open();
  enqueue(store, 1, "first request", 993_500);
  enqueue(store, 2, "second request", 996_500);

  const first = store.claimNextControllerTurn(fence);
  expect(first).toMatchObject({ inputText: "first request" });
  // The answer in flight holds the queue; the second burst waits its turn.
  expect(store.claimNextControllerTurn(fence)).toBeNull();
  expect(store.markControllerSpawned({
    turnId: first!.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_gap_split",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: first!.id, ...fence })).toBe(true);
  const { completeTurnThroughFinalization } = await import("./support/controller-trust-fixtures");
  completeTurnThroughFinalization(store, fence, {
    turnId: first!.id, controllerKey: first!.controllerKey, responseText: "Done.",
  });
  expect(store.claimNextControllerTurn(fence)).toMatchObject({ inputText: "second request" });
});

it("defers the claim while the newest message is still fresh and reports the quiet deadline", () => {
  const { store, fence } = open();
  enqueue(store, 1, "first request", 1_000_000 - 100);
  enqueue(store, 2, "second request", 1_000_000 - 50);

  expect(store.claimNextControllerTurn(fence)).toBeNull();
  // The burst goes quiet when its newest message is 2s old.
  expect(store.nextControllerBurstQuietMs(1_000_000)).toBe(1_900);
  expect(store.claimNextControllerTurn({ ...fence, now: 1_000_000 + 2_000 })).not.toBeNull();
});

it("claims a lone message once the quiet gap has passed", () => {
  const { store, fence } = open();
  enqueue(store, 1, "just one message", 1_000_000);
  expect(store.claimNextControllerTurn(fence)).toBeNull();
  expect(store.claimNextControllerTurn({ ...fence, now: 1_000_000 + CONTROLLER_BURST_QUIET_GAP_MS }))
    .toMatchObject({ inputText: "just one message" });
});

it("closes the burst at the count cap and leaves the remainder for the next burst", () => {
  const { store, fence } = open();
  const start = 996_500;
  enqueue(store, 1, "leader", start);
  for (let index = 0; index < CONTROLLER_BURST_MAX_MEMBERS - 1; index += 1) {
    enqueue(store, index + 2, `member ${index}`, start + index + 1);
  }
  const trailing = enqueue(store, 200, "after the cap", start + CONTROLLER_BURST_MAX_MEMBERS + 10_000);

  const claimed = store.claimNextControllerTurn(fence);
  expect(claimed).not.toBeNull();
  expect(store.listControllerTurns("owner-7-controller", 100)
    .filter((turn) => turn.burstLeaderTurnId !== null)).toHaveLength(CONTROLLER_BURST_MAX_MEMBERS - 1);
  expect(store.getControllerTurn(trailing.id)).toMatchObject({ state: "queued" });
});

it("closes the burst when further attachment-bearing turns would pass the attachment cap", () => {
  const { store, fence } = open();
  const start = 996_500;
  enqueue(store, 1, "leader", start);
  for (let index = 0; index < CONTROLLER_BURST_MAX_ATTACHMENTS; index += 1) {
    enqueue(store, index + 2, `photo ${index}`, start + index + 1, {
      image: {
        fileId: `photo-${index}`,
        fileName: `photo-${index}.png`,
        mimeType: "image/png" as const,
        sizeBytes: 1_000,
      },
    });
  }
  const trailing = enqueue(store, 200, "one photo too many", start + 500, {
    image: {
      fileId: "photo-extra",
      fileName: "photo-extra.png",
      mimeType: "image/png" as const,
      sizeBytes: 1_000,
    },
  });

  expect(store.claimNextControllerTurn(fence)).not.toBeNull();
  expect(store.getControllerTurn(trailing.id)).toMatchObject({ state: "queued" });
});

it("counts the leader's own file toward the attachment cap", () => {
  const { store, fence } = open();
  const start = 996_500;
  const photo = (index: number) => ({
    fileId: `photo-${index}`,
    fileName: `photo-${index}.png`,
    mimeType: "image/png" as const,
    sizeBytes: 1_000,
  });
  enqueue(store, 1, "leader with a photo", start, { image: photo(0) });
  for (let index = 1; index < CONTROLLER_BURST_MAX_ATTACHMENTS; index += 1) {
    enqueue(store, index + 1, `photo ${index}`, start + index, { image: photo(index) });
  }
  const trailing = enqueue(store, 200, "one photo too many", start + 500, { image: photo(99) });

  expect(store.claimNextControllerTurn(fence)).not.toBeNull();
  expect(store.listControllerTurns("owner-7-controller", 100)
    .filter((turn) => turn.burstLeaderTurnId !== null)).toHaveLength(CONTROLLER_BURST_MAX_ATTACHMENTS - 1);
  expect(store.getControllerTurn(trailing.id)).toMatchObject({ state: "queued" });
});

it("closes the burst when one more member would pass the text cap", () => {
  const { store, fence } = open();
  // Per-message intake caps at 4,000 characters, so the 32 KB transcript cap
  // is reached across roughly eight of them.
  const longText = "x".repeat(4_000);
  enqueue(store, 1, "leader", 996_500);
  for (let index = 0; index < 8; index += 1) {
    enqueue(store, index + 2, longText, 996_600 + index);
  }
  const trailing = enqueue(store, 50, longText, 996_700);

  const claimed = store.claimNextControllerTurn(fence);
  expect(claimed).not.toBeNull();
  expect(store.listControllerTurns("owner-7-controller", 100)
    .filter((turn) => turn.burstLeaderTurnId !== null)).toHaveLength(8);
  expect(store.getControllerTurn(trailing.id)).toMatchObject({ state: "queued" });
  expect(CONTROLLER_BURST_MAX_TEXT_CHARS).toBe(32_768);
});

it("stops the burst before an untranscribed voice note so it keeps its ordinal place", () => {
  const { store, fence } = open();
  const leader = enqueue(store, 1, "leader", 996_500);
  const member = enqueue(store, 2, "in the middle", 996_600);
  // The voice note claims its conversation slot when Telegram accepts it;
  // its turn exists only after transcription.
  const voiceUpdateId = 3;
  if (store.beginTelegramUpdate(voiceUpdateId, 996_700) !== "process") {
    throw new Error("voice update could not be claimed");
  }
  store.queueControllerVoice({
    updateId: voiceUpdateId,
    controllerKey: "owner-7-controller",
    telegramUserId: OWNER,
    telegramChatId: OWNER,
    fileId: "voice-file",
    mimeType: "audio/ogg",
    sizeBytes: 4_000,
    durationSeconds: 3,
    caption: null,
    now: 996_700,
  });
  const afterVoice = enqueue(store, 4, "after the voice", 996_800);

  const claimed = store.claimNextControllerTurn(fence);
  expect(claimed).toMatchObject({ id: leader.id });
  expect(store.getControllerTurn(member.id)).toMatchObject({ state: "completed" });
  expect(store.getControllerTurn(afterVoice.id)).toMatchObject({ state: "queued" });
  // The voice note itself has no turn until it is transcribed.
  expect(store.getControllerTurn(`controller-turn-${voiceUpdateId}`)).toBeNull();
});

it("stops the burst at a system turn, which can join no burst", () => {
  const { store, fence } = open();
  const leader = enqueue(store, 1, "leader", 996_500);
  const member = enqueue(store, 2, "joined", 996_600);
  const systemTurn = enqueue(store, 3, "system check", 996_700, { origin: "system" as const });
  const afterSystem = enqueue(store, 4, "after the system turn", 996_800);

  store.claimNextControllerTurn(fence);
  expect(store.getControllerTurn(leader.id)).toMatchObject({ state: "dispatching" });
  expect(store.getControllerTurn(member.id)).toMatchObject({ state: "completed" });
  expect(store.getControllerTurn(systemTurn.id)).toMatchObject({ state: "queued" });
  expect(store.getControllerTurn(afterSystem.id)).toMatchObject({ state: "queued" });
});

it("keeps the folded burst intact across a lease loss and re-claim", () => {
  const { store, fence } = open();
  const leader = enqueue(store, 1, "leader", 996_500);
  enqueue(store, 2, "joined", 996_600);
  const claimed = store.claimNextControllerTurn(fence);
  expect(claimed).not.toBeNull();

  // A successor generation takes over; the leader is requeued by stale dispatch recovery.
  const successor = store.acquireExecutorLease("successor", 1_100_000, 60_000);
  if (!successor.acquired) throw new Error("successor lease was unavailable");
  expect(store.failStaleControllerDispatches({
    ownerId: "successor",
    generation: successor.generation,
    now: 1_100_000,
  })).toBe(true);
  const reclaimed = store.claimNextControllerTurn({
    ownerId: "successor",
    generation: successor.generation,
    now: 1_100_000,
  });
  expect(reclaimed).toMatchObject({ id: leader.id });
  // The member was folded once and is never answered twice.
  expect(store.listControllerTurns("owner-7-controller", 10)
    .filter((turn) => turn.burstLeaderTurnId === leader.id)).toHaveLength(1);
  const acknowledgements = store.listOutbox(50)
    .filter((row) => /already writing/i.test(String(row.payload.text ?? "")));
  expect(acknowledgements).toHaveLength(0);
});

it("replays a failed burst leader whole, with its members re-linked to the replacement", () => {
  const { store, fence } = open();
  const leaderSource = { kind: "forwarded" as const, forwardedFrom: "Tom Counsell", forwardedHidden: false, quotedAuthor: null, quotedFromAgent: false, quotedText: null, replyToMessageId: null, albumId: null };
  const leader = enqueue(store, 1, "the first forwarded words", 996_500, { source: leaderSource });
  const member = enqueue(store, 2, "and the second", 996_900);
  expect(store.claimNextControllerTurn(fence)).toMatchObject({ id: leader.id });
  expect(store.markControllerSpawned({
    turnId: leader.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_burst_replay",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: leader.id, ...fence })).toBe(true);

  // The thread died having done nothing, so the message is put back.
  expect(store.failAndRetireControllerTurn({
    ...fence,
    turnId: leader.id,
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_burst_replay",
    error: "bounded internal summary",
  })).toBe("retired");

  const replacement = store.listControllerTurns("owner-7-controller", 10)
    .find((turn) => turn.recoverySourceTurnId === leader.id);
  expect(replacement).toMatchObject({ state: "queued", inputText: leader.inputText, source: leaderSource });
  // The whole burst rides with the replacement, not the framing line alone.
  expect(store.listControllerBurstMembers(replacement!.id).map((turn) => turn.id)).toEqual([member.id]);
  expect(store.getControllerTurn(member.id)).toMatchObject({ burstLeaderTurnId: replacement!.id });
});

it("does not replay a failed document turn as bare text", () => {
  const { store, fence } = open();
  const leader = enqueue(store, 1, "Please read this file.", 996_500, {
    document: { fileId: "pdf-1", fileName: "review.pdf", mimeType: "application/pdf" as const, sizeBytes: 4_000 },
  });
  expect(store.claimNextControllerTurn(fence)).toMatchObject({ id: leader.id });
  expect(store.markControllerSpawned({
    turnId: leader.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_doc_no_replay",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: leader.id, ...fence })).toBe(true);

  expect(store.failAndRetireControllerTurn({
    ...fence,
    turnId: leader.id,
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_doc_no_replay",
    error: "bounded internal summary",
  })).toBe("retired");

  // A retry that dropped the file would not be the message the owner sent.
  expect(store.listControllerTurns("owner-7-controller", 10)).toHaveLength(1);
  expect(store.getOutbox(`controller:${leader.id}:reply`)?.payload.text).not.toMatch(/picking it up again/i);
});

function submittedTurn(store: ReturnType<typeof openStore>, fence: Record<string, unknown>, updateId: number, threadId: string) {
  const turn = enqueue(store, updateId, "the running answer's question", 990_000);
  const claimed = store.claimNextControllerTurn(fence as never);
  expect(claimed).not.toBeNull();
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId,
  } as never)).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ...fence } as never)).toBe(true);
  return turn;
}

it("steers one combined transcript for a waiting burst and acknowledges it once", () => {
  const { store, fence } = open();
  const running = submittedTurn(store, fence, 1, "thr_burst_steer");
  const leader = enqueue(store, 2, "first addition", 996_500);
  const member = enqueue(store, 3, "second addition", 996_900, {
    source: { kind: "forwarded", forwardedFrom: "Tom Counsell", forwardedHidden: false, quotedAuthor: null, quotedFromAgent: false, quotedText: null, replyToMessageId: null, albumId: null },
  });

  const burst = store.getQueuedControllerSteerBurst("owner-7-controller", 1_000_000);
  expect(burst?.leader.id).toBe(leader.id);
  expect(burst?.members.map((row) => row.id)).toEqual([member.id]);

  expect(store.reserveControllerSteer({
    ...fence,
    runningTurnId: running.id,
    waitingTurnId: leader.id,
    memberTurnIds: burst!.members.map((row) => row.id),
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_burst_steer",
  })).toBe(true);

  // The reserved steer text is one attributed transcript, not one per message.
  const reservation = store.getControllerSteerReservation("owner-7-controller");
  expect(reservation?.inputText).toContain("1. You: first addition");
  expect(reservation?.inputText).toContain("2. Forwarded from Tom Counsell: second addition");

  expect(store.settleControllerSteer({
    ...fence,
    runningTurnId: running.id,
    waitingTurnId: leader.id,
    controllerKey: "owner-7-controller",
    outcome: "applied",
  })).toBe("settled");

  expect(store.getControllerTurn(leader.id)).toMatchObject({ state: "completed" });
  expect(store.getControllerTurn(member.id)).toMatchObject({
    state: "completed",
    burstLeaderTurnId: leader.id,
  });
  const acknowledgements = store.listOutbox(50)
    .filter((row) => /already writing/i.test(String(row.payload.text ?? "")));
  expect(acknowledgements).toHaveLength(1);
});

it("leaves no reservation behind when a burst member can no longer join the steer", () => {
  const { store, fence } = open();
  const running = submittedTurn(store, fence, 1, "thr_burst_rollback");
  const leader = enqueue(store, 2, "first addition", 996_500);
  // A member that stopped being steerable between selection and reservation:
  // here, one that carries a file.
  const attached = enqueue(store, 3, "with a photo", 996_900, {
    image: { fileId: "photo-1", fileName: "photo-1.png", mimeType: "image/png" as const, sizeBytes: 2_000 },
  });

  expect(store.reserveControllerSteer({
    ...fence,
    runningTurnId: running.id,
    waitingTurnId: leader.id,
    memberTurnIds: [attached.id],
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_burst_rollback",
  })).toBe(false);

  // Either the whole burst is reserved or none of it is.
  expect(store.getControllerSteerReservation("owner-7-controller")).toBeNull();
  expect(store.getControllerTurn(leader.id)).toMatchObject({ state: "queued", burstLeaderTurnId: null });
  expect(store.getControllerTurn(attached.id)).toMatchObject({ state: "queued", burstLeaderTurnId: null });
});

it("restores a burst whose steer was not applied, so nothing is lost", () => {
  const { store, fence } = open();
  const running = submittedTurn(store, fence, 1, "thr_burst_retry");
  const leader = enqueue(store, 2, "first addition", 996_500);
  const member = enqueue(store, 3, "second addition", 996_900);
  const burst = store.getQueuedControllerSteerBurst("owner-7-controller", 1_000_000);
  expect(store.reserveControllerSteer({
    ...fence,
    runningTurnId: running.id,
    waitingTurnId: leader.id,
    memberTurnIds: burst!.members.map((row) => row.id),
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_burst_retry",
  })).toBe(true);

  expect(store.settleControllerSteer({
    ...fence,
    runningTurnId: running.id,
    waitingTurnId: leader.id,
    controllerKey: "owner-7-controller",
    outcome: "not_applied",
  })).toBe("settled");

  // Every message of the burst is back in the queue, membership cleared.
  expect(store.getControllerTurn(leader.id)).toMatchObject({ state: "queued", burstLeaderTurnId: null, retryCount: 1 });
  expect(store.getControllerTurn(member.id)).toMatchObject({ state: "queued", burstLeaderTurnId: null });
  expect(store.getControllerSteerReservation("owner-7-controller")).toBeNull();
});

it("preserves every member of a burst whose steer outcome stayed ambiguous", () => {
  const { store, fence } = open();
  const running = submittedTurn(store, fence, 1, "thr_burst_ambiguous");
  const leader = enqueue(store, 2, "first addition", 996_500);
  const member = enqueue(store, 3, "second addition", 996_900);
  const burst = store.getQueuedControllerSteerBurst("owner-7-controller", 1_000_000);
  expect(store.reserveControllerSteer({
    ...fence,
    runningTurnId: running.id,
    waitingTurnId: leader.id,
    memberTurnIds: burst!.members.map((row) => row.id),
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_burst_ambiguous",
  })).toBe(true);

  expect(store.settleControllerSteer({
    ...fence,
    runningTurnId: running.id,
    waitingTurnId: leader.id,
    controllerKey: "owner-7-controller",
    outcome: "unknown",
  })).toBe("settled");

  expect(store.getControllerTurn(leader.id)).toMatchObject({
    state: "queued",
    recoverySourceTurnId: running.id,
  });
  expect(store.getControllerTurn(member.id)).toMatchObject({
    state: "queued",
    recoverySourceTurnId: running.id,
    burstLeaderTurnId: null,
  });
});

it("stops the steer burst before a member that carries an attachment", () => {
  const { store, fence } = open();
  submittedTurn(store, fence, 1, "thr_burst_attach");
  const leader = enqueue(store, 2, "text addition", 996_500);
  const attached = enqueue(store, 3, "a photo arrived with it", 996_900, {
    image: { fileId: "photo-1", fileName: "photo-1.png", mimeType: "image/png" as const, sizeBytes: 2_000 },
  });
  const after = enqueue(store, 4, "after the photo", 997_300);

  const burst = store.getQueuedControllerSteerBurst("owner-7-controller", 1_000_000);
  expect(burst?.leader.id).toBe(leader.id);
  expect(burst?.members).toEqual([]);

  expect(store.reserveControllerSteer({
    ...fence,
    runningTurnId: runningTurnId(store, "thr_burst_attach"),
    waitingTurnId: leader.id,
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_burst_attach",
  })).toBe(true);
  expect(store.settleControllerSteer({
    ...fence,
    runningTurnId: runningTurnId(store, "thr_burst_attach"),
    waitingTurnId: leader.id,
    controllerKey: "owner-7-controller",
    outcome: "applied",
  })).toBe("settled");

  // The attachment turn is never folded into a text-only steer; it and
  // everything after it wait to be claimed as the next burst.
  expect(store.getControllerTurn(attached.id)).toMatchObject({ state: "queued", burstLeaderTurnId: null });
  expect(store.getControllerTurn(after.id)).toMatchObject({ state: "queued" });
});

function runningTurnId(store: ReturnType<typeof openStore>, threadId: string): string {
  const submitted = store.listControllerTurns("owner-7-controller", 20)
    .find((turn) => turn.state === "submitted");
  if (!submitted) throw new Error(`no submitted turn for ${threadId}`);
  return submitted.id;
}

it("holds the steer while the waiting burst tail is still fresh", () => {
  const { store } = open();
  submittedTurn(store, { ownerId: "executor", generation: 1, now: 1_000_000 }, 1, "thr_burst_hold");
  // Newest member is 1.5s old on the store's clock: still in flight.
  enqueue(store, 2, "first addition", 998_500);
  expect(store.getQueuedControllerSteerBurst("owner-7-controller", 1_000_000)).toBeNull();
});

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
