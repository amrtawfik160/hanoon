import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import {
  MEMORY_DEMOTION,
  MEMORY_IDLE_HALF_LIFE_MS,
  MEMORY_REINFORCEMENT,
  MEMORY_TOMBSTONE_CONFIDENCE,
  adjustedConfidence,
  decayedConfidence,
  subjectsContradict,
} from "../src/storage/memory-ranking";
import { MemoryCurationService, recallOutcome } from "../src/services/memory-curation-service";

let fixtureNumber = 0;
const CONTROLLER_KEY = "owner-7-controller";

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-curation-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001)).toEqual({ ok: true });
  return { bb, store };
}

function completedTurn(store: TelegramAgentStore, updateId: number, inputText: string, now: number) {
  const turn = store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY,
    telegramUserId: "7",
    telegramChatId: "7",
    updateId,
    inputText,
    now,
  });
  const lease = store.acquireExecutorLease(`executor-${updateId}`, now, 60 * 60_000);
  if (!lease.acquired) throw new Error("missing lease");
  const fence = { ownerId: `executor-${updateId}`, generation: lease.generation, now };
  store.claimNextControllerTurn(fence);
  store.markControllerSpawned({ ...fence, turnId: turn.id, projectId: "p", hostId: "h", threadId: "thr_c" });
  store.markControllerTurnSubmitted({ ...fence, turnId: turn.id });
  store.completeControllerTurn({ ...fence, turnId: turn.id, responseText: "an answer" });
  // Released so a later turn in the same test can take the singleton lease.
  store.releaseExecutorLease(fence.ownerId, fence.generation, now);
  return turn;
}

it("appends the curation migration after every shipped one", () => {
  expect(ALL_MIGRATIONS[21]).toContain("CREATE TABLE memory_recalls");
});

it("decays confidence on idle time and never below the floor", () => {
  expect(decayedConfidence(0.8, 0)).toBeCloseTo(0.8, 6);
  expect(decayedConfidence(0.8, MEMORY_IDLE_HALF_LIFE_MS)).toBeCloseTo(0.4, 6);
  expect(decayedConfidence(0.8, MEMORY_IDLE_HALF_LIFE_MS * 2)).toBeCloseTo(0.2, 6);
  expect(decayedConfidence(0.8, MEMORY_IDLE_HALF_LIFE_MS * 100)).toBe(0.05);
});

it("bounds an adjusted confidence to the unit interval", () => {
  expect(adjustedConfidence(0.7, MEMORY_REINFORCEMENT)).toBeCloseTo(0.75, 6);
  expect(adjustedConfidence(0.99, 0.5)).toBe(1);
  expect(adjustedConfidence(0.1, -0.5)).toBe(0.05);
});

it.each([
  ["a strict superset", "deploy on fridays", "never deploy on fridays", true],
  ["identical wording", "deploy on fridays", "deploy on fridays", true],
  ["one shared word", "deploy the api", "restart the database", false],
  ["a single-token subject", "deploy", "never deploy anything ever", false],
  ["unrelated subjects", "invoice retries", "canary timing", false],
])("treats %s as contradiction=%s", (_label, left, right, expected) => {
  expect(subjectsContradict(left, right)).toBe(expected);
});

it("retires a contradicted belief when the owner corrects it", () => {
  const { store } = fixture();
  const original = store.rememberMemory({
    scope: "owner", kind: "preference", subject: "deploy on fridays",
    body: "always deploy on fridays", source: "owner", now: 2_000,
  });
  const unrelated = store.rememberMemory({
    scope: "owner", kind: "fact", subject: "canary timing",
    body: "the canary needs two minutes", source: "owner", now: 2_001,
  });

  store.rememberMemory({
    scope: "owner", kind: "correction", subject: "never deploy on fridays",
    body: "never deploy on fridays", source: "owner", now: 2_002,
  });

  expect(store.getMemory(original.id)?.supersededBy).not.toBeNull();
  expect(store.getMemory(unrelated.id)?.supersededBy).toBeNull();
});

it("does not let an ordinary restatement retire a neighbouring belief", () => {
  const { store } = fixture();
  const original = store.rememberMemory({
    scope: "owner", kind: "preference", subject: "deploy on fridays",
    body: "always deploy on fridays", source: "owner", now: 2_000,
  });

  store.rememberMemory({
    scope: "owner", kind: "fact", subject: "we deploy on fridays and mondays",
    body: "both days are used", source: "owner", now: 2_001,
  });

  expect(store.getMemory(original.id)?.supersededBy).toBeNull();
});

it("links a recall to the turn it informed", () => {
  const { store } = fixture();
  store.rememberMemory({
    scope: "owner", kind: "fact", subject: "canary timing",
    body: "the canary needs two minutes", source: "owner", now: 2_000,
  });
  const turn = completedTurn(store, 501, "how long does the canary take?", 2_001);

  store.recallMemories({ scope: "owner", query: "canary", limit: 5, now: 2_002, turnId: turn.id });

  expect(store.listUnscoredRecallTurns(10)).toMatchObject([{ turnId: turn.id, ordinal: 1 }]);
});

it.each([
  ["a correction", "never tell me that again", "demoted"],
  ["an ordinary reply", "thanks, ship it", "reinforced"],
])("scores the previous recall from %s", (_label, nextText, expected) => {
  expect(recallOutcome(nextText)).toBe(expected);
});

it("demotes what was recalled when the owner's next message corrects it", () => {
  const { store } = fixture();
  const memory = store.rememberMemory({
    scope: "owner", kind: "fact", subject: "canary timing",
    body: "the canary needs two minutes", source: "owner", confidence: 0.7, now: 2_000,
  });
  const turn = completedTurn(store, 502, "how long does the canary take?", 2_001);
  store.recallMemories({ scope: "owner", query: "canary", limit: 5, now: 2_002, turnId: turn.id });
  completedTurn(store, 503, "never say that, it is ten minutes", 2_003);
  const service = new MemoryCurationService({ store, clock: { now: () => 2_004 } });

  expect(service.processDue()).toBe(true);

  expect(store.getMemory(memory.id)?.confidence).toBeCloseTo(0.7 - MEMORY_DEMOTION, 6);
  expect(store.listUnscoredRecallTurns(10)).toEqual([]);
});

it("reinforces what was recalled when the owner moves on", () => {
  const { store } = fixture();
  const memory = store.rememberMemory({
    scope: "owner", kind: "fact", subject: "canary timing",
    body: "the canary needs two minutes", source: "owner", confidence: 0.7, now: 2_000,
  });
  const turn = completedTurn(store, 504, "how long does the canary take?", 2_001);
  store.recallMemories({ scope: "owner", query: "canary", limit: 5, now: 2_002, turnId: turn.id });
  completedTurn(store, 505, "great, deploy it", 2_003);
  const service = new MemoryCurationService({ store, clock: { now: () => 2_004 } });

  expect(service.processDue()).toBe(true);

  expect(store.getMemory(memory.id)?.confidence).toBeCloseTo(0.7 + MEMORY_REINFORCEMENT, 6);
});

it("leaves a recall unscored until the owner says something next", () => {
  const { store } = fixture();
  store.rememberMemory({
    scope: "owner", kind: "fact", subject: "canary timing",
    body: "the canary needs two minutes", source: "owner", now: 2_000,
  });
  const turn = completedTurn(store, 506, "how long does the canary take?", 2_001);
  store.recallMemories({ scope: "owner", query: "canary", limit: 5, now: 2_002, turnId: turn.id });
  const service = new MemoryCurationService({ store, clock: { now: () => 2_003 } });

  expect(service.processDue()).toBe(false);

  expect(store.listUnscoredRecallTurns(10)).toHaveLength(1);
});

it("tombstones an agent memory that was never used and never scores twice", () => {
  const { store } = fixture();
  const stale = store.rememberMemory({
    scope: "proj_a", kind: "fact", subject: "an idea nobody needed",
    body: "extracted once and never recalled", source: "agent", confidence: 0.5, now: 2_000,
  });
  const spoken = store.rememberMemory({
    scope: "owner", kind: "preference", subject: "deploy windows",
    body: "deploy on weekday mornings", source: "owner", confidence: 0.5, now: 2_000,
  });
  const long = 2_000 + MEMORY_IDLE_HALF_LIFE_MS * 3;

  const first = store.curateMemories({ now: long });

  expect(first.tombstoned).toBe(1);
  expect(store.getMemory(stale.id)?.forgottenAt).toBe(long);
  // What the owner said out loud decays but is never aged out on a timer.
  expect(store.getMemory(spoken.id)?.forgottenAt).toBeNull();
  expect(store.getMemory(spoken.id)?.confidence).toBeLessThan(0.5);
});

it("does not compound decay across passes", () => {
  const { store } = fixture();
  const memory = store.rememberMemory({
    scope: "owner", kind: "fact", subject: "anchored",
    body: "decays once per elapsed interval", source: "owner", confidence: 0.8, now: 2_000,
  });
  const month = 30 * 86_400_000;

  // One pass a month later, then three more at the same instant.
  store.curateMemories({ now: 2_000 + month });
  const afterFirst = store.getMemory(memory.id)?.confidence ?? 0;
  for (const _ of [1, 2, 3]) store.curateMemories({ now: 2_000 + month });

  expect(store.getMemory(memory.id)?.confidence).toBeCloseTo(afterFirst, 9);
  expect(afterFirst).toBeCloseTo(0.8 * 0.5 ** (month / MEMORY_IDLE_HALF_LIFE_MS), 6);
});

it("reaches the same confidence whether curated once or many times", () => {
  const { store } = fixture();
  const once = store.rememberMemory({
    scope: "owner", kind: "fact", subject: "swept once",
    body: "a", source: "owner", confidence: 0.8, now: 2_000,
  });
  const often = store.rememberMemory({
    scope: "owner", kind: "fact", subject: "swept often",
    body: "b", source: "owner", confidence: 0.8, now: 2_000,
  });
  const span = 60 * 86_400_000;

  // Sweeping every six hours must not age a memory faster than one sweep does.
  for (let elapsed = 6 * 3_600_000; elapsed <= span; elapsed += 6 * 3_600_000) {
    store.curateMemories({ now: 2_000 + elapsed });
  }
  const swept = store.getMemory(often.id)?.confidence ?? 0;

  // `once` has been swept on the same schedule, so compare against the maths.
  expect(swept).toBeCloseTo(0.8 * 0.5 ** (span / MEMORY_IDLE_HALF_LIFE_MS), 4);
  expect(store.getMemory(once.id)?.confidence).toBeCloseTo(swept, 9);
  // Sixty days is nowhere near the tombstone threshold on a 90-day half-life.
  expect(swept).toBeGreaterThan(MEMORY_TOMBSTONE_CONFIDENCE);
});

it("keeps an unused extracted memory alive far longer than the ranking down-weights it", () => {
  const { store } = fixture();
  const extracted = store.rememberMemory({
    scope: "proj_a", kind: "fact", subject: "a project lesson",
    body: "learned from a finished job", source: "agent", confidence: 0.5, now: 2_000,
  });

  // Thirty days of six-hourly sweeps: it must still be here.
  for (let elapsed = 6 * 3_600_000; elapsed <= 30 * 86_400_000; elapsed += 6 * 3_600_000) {
    store.curateMemories({ now: 2_000 + elapsed });
  }

  expect(store.getMemory(extracted.id)?.forgottenAt).toBeNull();
});
