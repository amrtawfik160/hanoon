import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import { buildHealthReport } from "../src/services/health-report";

const NOW = 1_800_000_000_000;

let fixtureNumber = 0;
function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-health-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  store.createPairingCode(hashSecret("pair-health"), NOW - 1_000, NOW + 10_000);
  expect(store.pairOwnerWithPrivateChatCode(hashSecret("pair-health"), "7", "70", NOW - 500)).toEqual({ ok: true });
  return { db: bb.storage.database(), store };
}

it("reports a healthy agent with nothing outstanding", () => {
  const { db, store } = fixture();
  expect(store.acquireExecutorLease("executor", NOW, 30_000).acquired).toBe(true);

  const report = buildHealthReport(db, NOW);

  expect(report).toMatchObject({
    ok: true,
    problems: [],
    executor: { current: true },
    work: { pendingEffects: 0, deadEffects: 0 },
    memory: { live: 0, searchable: true },
    database: { integrity: "ok" },
  });
});

it("names what is wrong when the executor has stopped", () => {
  const { db } = fixture();

  const report = buildHealthReport(db, NOW);

  expect(report.ok).toBe(false);
  expect(report.problems).toContain("the executor lease is not current");
});

it("surfaces undelivered messages and failed Telegram updates", () => {
  const { db, store } = fixture();
  expect(store.acquireExecutorLease("executor", NOW, 30_000).acquired).toBe(true);
  db.prepare(
    `INSERT INTO outbox (logical_key, chat_id, message_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES ('job:x:status', '70', NULL, '{}', 'dead', 20, ?, ?, ?)`,
  ).run(NOW, NOW, NOW);
  expect(store.beginTelegramUpdate(11, NOW)).toBe("process");
  store.failTelegramUpdate(11, "Telegram API 400", NOW);

  const report = buildHealthReport(db, NOW);

  expect(report.ok).toBe(false);
  expect(report.problems).toEqual(expect.arrayContaining([
    "1 message(s) could not be delivered",
    "1 Telegram update(s) failed",
  ]));
});

it("counts what the agent is watching and remembering", () => {
  const { db, store } = fixture();
  expect(store.acquireExecutorLease("executor", NOW, 30_000).acquired).toBe(true);
  store.rememberMemory({
    scope: "owner",
    kind: "preference",
    subject: "deploy window",
    body: "Weekday mornings only.",
    source: "owner",
    now: NOW,
  });
  store.createMonitor({
    controllerKey: "owner-7-controller",
    kind: "thread_idle",
    threadId: "thr_watched",
    instruction: "Report when it lands.",
    dueAt: null,
    now: NOW,
  });

  expect(buildHealthReport(db, NOW)).toMatchObject({
    ok: true,
    monitors: { armed: 1, failed: 0 },
    memory: { live: 1, searchable: true },
  });
});
