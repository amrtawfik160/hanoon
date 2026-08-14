import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import {
  ThreadNoticeService,
  type PendingThreadInteraction,
  type WatchedThread,
} from "../src/services/thread-notice-service";
import { questionOptionToken, threadDecisionToken } from "../src/controller/questions";

const APPROVAL_ID = "pint_approval1";
const QUESTION_ID = "pint_question1";

let fixtureNumber = 0;

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-notices-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001)).toEqual({ ok: true });
  return store;
}

function watched(overrides: Partial<WatchedThread> = {}): WatchedThread {
  return { id: "thr_work", title: "Fix the login bug", status: "active", parentThreadId: null, ...overrides };
}

function approvalInteraction(): PendingThreadInteraction {
  return {
    id: APPROVAL_ID,
    status: "pending",
    payload: {
      kind: "approval",
      subject: { kind: "command", itemId: "i1", command: "rm -rf build", cwd: "repo", actions: [] },
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    },
  };
}

function questionInteraction(): PendingThreadInteraction {
  return {
    id: QUESTION_ID,
    status: "pending",
    payload: {
      kind: "user_question",
      questions: [{
        id: "q1",
        prompt: "Which database should I migrate first?",
        multiSelect: false,
        allowFreeText: true,
        options: [
          { value: "primary", label: "Primary", description: null },
          { value: "replica", label: "Replica", description: null },
        ],
      }],
    },
  };
}

function service(store: ReturnType<typeof fixture>, options: {
  threads?: WatchedThread[];
  interactions?: PendingThreadInteraction[];
  resolve?: ReturnType<typeof vi.fn>;
  now?: () => number;
} = {}) {
  const resolve = options.resolve ?? vi.fn(async () => undefined);
  const listWatchable = vi.fn(async () => options.threads ?? []);
  const interactions = vi.fn(async () => options.interactions ?? []);
  return {
    resolve,
    listWatchable,
    interactions,
    service: new ThreadNoticeService({
      store,
      threads: { listWatchable, interactions, resolve },
      clock: { now: options.now ?? (() => 3_000) },
    }),
  };
}

it("says nothing about a thread that was already finished when it first looked", async () => {
  const store = fixture();
  const { service: notices } = service(store, { threads: [watched({ status: "idle" })] });

  await expect(notices.processDue()).resolves.toBe(false);

  expect(store.getOutbox("thread:thr_work:idle")).toBeNull();
});

it("tells the owner when a watched thread finishes", async () => {
  const store = fixture();
  const running = service(store, { threads: [watched({ status: "active" })] });
  await running.service.processDue();

  const finished = service(store, { threads: [watched({ status: "idle" })] });
  await expect(finished.service.processDue()).resolves.toBe(true);

  expect(store.getOutbox("thread:thr_work:idle")?.payload.text).toContain("Fix the login bug");
  expect(store.getOutbox("thread:thr_work:idle")?.payload.text).toContain("finished");
});

it("does not announce a Hanoon pipeline worker as a generic thread notice", async () => {
  const store = fixture();
  const title = "Telegram abcdefghijklmnopqrstuv plan abcdefghijklmnopqrstuv:3:spawn_plan";
  const worker = watched({ id: "thr_plan", title, status: "active" });
  await service(store, { threads: [worker] }).service.processDue();
  await service(store, { threads: [{ ...worker, status: "idle" }] }).service.processDue();

  expect(store.getOutbox("thread:thr_plan:idle")).toBeNull();
});

it("keeps a title with markdown markers from breaking the finished notice", async () => {
  const store = fixture();
  const title = "Fix *this* and login_bug_now";
  await service(store, { threads: [watched({ title, status: "active" })] }).service.processDue();
  await service(store, { threads: [watched({ title, status: "idle" })] }).service.processDue();

  const payload = store.getOutbox("thread:thr_work:idle")?.payload;
  expect(payload?.parse_mode).toBe("HTML");
  expect(payload?.text).toContain("Fix *this* and login_bug_now");
  expect(payload?.text).not.toMatch(/<i>/);
});

it("tells the owner when a watched thread fails", async () => {
  const store = fixture();
  await service(store, { threads: [watched({ status: "active" })] }).service.processDue();

  await service(store, { threads: [watched({ status: "error" })] }).service.processDue();

  expect(store.getOutbox("thread:thr_work:error")?.payload.text).toContain("failed");
});

it("announces a finish once rather than on every sweep", async () => {
  const store = fixture();
  await service(store, { threads: [watched({ status: "active" })] }).service.processDue();
  await service(store, { threads: [watched({ status: "idle" })] }).service.processDue();

  const again = service(store, { threads: [watched({ status: "idle" })] });
  await expect(again.service.processDue()).resolves.toBe(false);
});

it("ignores a sub-agent's thread, which is the parent's business", async () => {
  const store = fixture();
  const child = watched({ id: "thr_child", parentThreadId: "thr_work", status: "active" });
  const { service: notices, interactions } = service(store, { threads: [child] });

  await notices.processDue();

  expect(interactions).not.toHaveBeenCalled();
  expect(store.getOutbox("thread:thr_child:idle")).toBeNull();
});

it("asks the owner to approve a command a thread is blocked on", async () => {
  const store = fixture();
  const { service: notices } = service(store, {
    threads: [watched()],
    interactions: [approvalInteraction()],
  });

  await expect(notices.processDue()).resolves.toBe(true);

  const asked = store.getOutbox(`thread-interaction:${APPROVAL_ID}`);
  expect(asked?.payload.text).toContain("rm -rf build");
  expect(asked?.payload.reply_markup).toEqual({
    inline_keyboard: [
      [{ text: "Allow once", callback_data: `w:${threadDecisionToken(APPROVAL_ID, "allow_once")}` }],
      [{ text: "Allow all session", callback_data: `w:${threadDecisionToken(APPROVAL_ID, "allow_for_session")}` }],
      [{ text: "Deny", callback_data: `w:${threadDecisionToken(APPROVAL_ID, "deny")}` }],
    ],
  });
});

it("does not render an approval with a protected absolute cwd", async () => {
  const store = fixture();
  const interaction: PendingThreadInteraction = {
    id: "pint_canonical",
    status: "pending",
    payload: {
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "i2",
        command: "git status",
        cwd: "/home/alice/.ssh/id_rsa",
        actions: [],
      },
      availableDecisions: ["allow_once", "deny"],
    },
  };

  await service(store, { threads: [watched()], interactions: [interaction] }).service.processDue();

  const asked = store.getOutbox("thread-interaction:pint_canonical");
  expect(asked?.payload.text).toContain("can't answer from here");
  expect(asked?.payload.text).not.toContain("/home/");
  expect(asked?.payload.text).not.toContain("id_rsa");
  expect(asked?.payload.reply_markup).toBeUndefined();
});

it("does not render an approval with a protected absolute write scope", async () => {
  const store = fixture();
  const interaction: PendingThreadInteraction = {
    id: "pint_write_scope",
    status: "pending",
    payload: {
      kind: "approval",
      subject: { kind: "file_change", writeScope: "/srv/private/credentials.json" },
      availableDecisions: ["deny"],
    },
  };

  await service(store, { threads: [watched()], interactions: [interaction] }).service.processDue();

  const asked = store.getOutbox("thread-interaction:pint_write_scope");
  expect(asked?.payload.text).toContain("can't answer from here");
  expect(asked?.payload.text).not.toContain("/srv/");
  expect(asked?.payload.text).not.toContain("credentials.json");
  expect(asked?.payload.reply_markup).toBeUndefined();
});

it("does not offer approval buttons when a command cannot be displayed losslessly", async () => {
  const store = fixture();
  const interaction: PendingThreadInteraction = {
    id: "pint_lossy_command",
    status: "pending",
    payload: {
      kind: "approval",
      subject: { kind: "command", command: "echo safe API_KEY=secret-value", cwd: "/repo" },
      availableDecisions: ["allow_once", "deny"],
    },
  };

  await service(store, { threads: [watched()], interactions: [interaction] }).service.processDue();

  const asked = store.getOutbox("thread-interaction:pint_lossy_command");
  expect(asked?.payload.text).toContain("can't answer from here");
  expect(asked?.payload.reply_markup).toBeUndefined();
  expect(JSON.stringify(asked?.payload)).not.toContain("secret-value");
});

it("carries an approval decision back to the blocked thread", async () => {
  const store = fixture();
  const asked = service(store, { threads: [watched()], interactions: [approvalInteraction()] });
  await asked.service.processDue();

  const answer = store.answerThreadInteraction({
    token: threadDecisionToken(APPROVAL_ID, "allow_once"),
    userId: "7",
    chatId: "7",
    now: 4_000,
  });
  expect(answer).toEqual({
    ok: true,
    interactionId: APPROVAL_ID,
    threadId: "thr_work",
    title: "Fix the login bug",
    label: "Allowed",
  });

  const delivering = service(store, { threads: [], now: () => 4_100 });
  await expect(delivering.service.processDue()).resolves.toBe(true);
  expect(delivering.resolve).toHaveBeenCalledWith("thr_work", APPROVAL_ID, {
    decision: "allow_once",
    grantedPermissions: null,
  });

  // Delivered once, even though the sweep runs continuously.
  const again = service(store, { threads: [], now: () => 4_200 });
  await again.service.processDue();
  expect(again.resolve).not.toHaveBeenCalled();
});

it("carries a question answer back to the blocked thread", async () => {
  const store = fixture();
  await service(store, { threads: [watched()], interactions: [questionInteraction()] }).service.processDue();

  const answer = store.answerThreadInteraction({
    token: questionOptionToken(QUESTION_ID, "q1", "replica"),
    userId: "7",
    chatId: "7",
    now: 4_000,
  });
  expect(answer.ok).toBe(true);

  const delivering = service(store, { threads: [], now: () => 4_100 });
  await delivering.service.processDue();

  expect(delivering.resolve).toHaveBeenCalledWith("thr_work", QUESTION_ID, {
    kind: "user_answer",
    answers: { q1: { selected: ["replica"] } },
  });
});

it("refuses a decision from anyone who is not the paired owner", () => {
  const store = fixture();

  expect(store.answerThreadInteraction({
    token: threadDecisionToken(APPROVAL_ID, "deny"),
    userId: "8",
    chatId: "8",
    now: 4_000,
  })).toEqual({ ok: false, reason: "stale" });
});

it("stops offering a decision the thread resolved without the owner", async () => {
  const store = fixture();
  await service(store, { threads: [watched()], interactions: [approvalInteraction()] }).service.processDue();

  // The next sweep sees the thread no longer waiting on anything.
  await service(store, { threads: [watched()], interactions: [] }).service.processDue();

  expect(store.answerThreadInteraction({
    token: threadDecisionToken(APPROVAL_ID, "allow_once"),
    userId: "7",
    chatId: "7",
    now: 4_000,
  })).toEqual({ ok: false, reason: "stale" });
});

it("retires the Telegram card for a decision the owner answered in BB", async () => {
  const store = fixture();
  await service(store, { threads: [watched()], interactions: [approvalInteraction()] }).service.processDue();
  const lease = store.acquireExecutorLease("executor", 3_000, 30_000);
  if (!lease.acquired) throw new Error("executor lease missing");
  const [asked] = store.leaseOutbox("executor", lease.generation, 3_000, 10, 30_000);
  expect(asked?.logicalKey).toBe(`thread-interaction:${APPROVAL_ID}`);
  expect(store.completeOutbox(asked!.logicalKey, "executor", lease.generation, 437, 3_000)).toBe(true);

  // The owner answered in the BB app, so BB stops listing the interaction.
  await service(store, { threads: [watched()], interactions: [] }).service.processDue();

  const retired = store.getOutbox(`thread-interaction:${APPROVAL_ID}`);
  expect(retired?.messageId).toBe(437);
  expect(retired?.status).toBe("pending");
  expect(retired?.payload.text).toContain("Fix the login bug");
  expect(retired?.payload.text).toContain("answered in BB");
  expect(retired?.payload.reply_markup).toEqual({ inline_keyboard: [] });
  // A tap on the card that has not been edited yet still finds nothing to answer.
  expect(store.answerThreadInteraction({
    token: threadDecisionToken(APPROVAL_ID, "allow_once"),
    userId: "7",
    chatId: "7",
    now: 4_000,
  })).toEqual({ ok: false, reason: "stale" });
});

it("retires a card once rather than on every later sweep", async () => {
  const store = fixture();
  await service(store, { threads: [watched()], interactions: [approvalInteraction()] }).service.processDue();
  const lease = store.acquireExecutorLease("executor", 3_000, 30_000);
  if (!lease.acquired) throw new Error("executor lease missing");
  const [asked] = store.leaseOutbox("executor", lease.generation, 3_000, 10, 30_000);
  expect(store.completeOutbox(asked!.logicalKey, "executor", lease.generation, 437, 3_000)).toBe(true);
  await service(store, { threads: [watched()], interactions: [] }).service.processDue();
  const [retirement] = store.leaseOutbox("executor", lease.generation, 3_100, 10, 30_000);
  expect(store.completeOutbox(retirement!.logicalKey, "executor", lease.generation, 437, 3_100)).toBe(true);

  await service(store, { threads: [watched()], interactions: [], now: () => 30_000 }).service.processDue();

  expect(store.getOutbox(`thread-interaction:${APPROVAL_ID}`)?.status).toBe("sent");
});

it("retires a card inside the sweep interval when a realtime change asks it to", async () => {
  const store = fixture();
  let pending: PendingThreadInteraction[] = [approvalInteraction()];
  let now = 3_000;
  const notices = new ThreadNoticeService({
    store,
    threads: {
      listWatchable: vi.fn(async () => [watched()]),
      interactions: vi.fn(async () => pending),
      resolve: vi.fn(async () => undefined),
    },
    clock: { now: () => now },
  });
  await notices.processDue();
  const lease = store.acquireExecutorLease("executor", 3_000, 30_000);
  if (!lease.acquired) throw new Error("executor lease missing");
  const [asked] = store.leaseOutbox("executor", lease.generation, 3_000, 10, 30_000);
  expect(store.completeOutbox(asked!.logicalKey, "executor", lease.generation, 437, 3_000)).toBe(true);

  // The owner answers in BB seconds after the sweep, so the pacing guard would
  // otherwise hold the card on their phone until the next idle poll.
  pending = [];
  now = 3_500;
  await notices.processDue();
  expect(store.getOutbox(`thread-interaction:${APPROVAL_ID}`)?.status).toBe("sent");

  notices.requestSweep();
  await expect(notices.processDue()).resolves.toBe(true);

  const retired = store.getOutbox(`thread-interaction:${APPROVAL_ID}`);
  expect(retired?.status).toBe("pending");
  expect(retired?.messageId).toBe(437);
  expect(retired?.payload.reply_markup).toEqual({ inline_keyboard: [] });
});

it("wakes the executor for a thread that still owes the owner an answer", async () => {
  const store = fixture();
  expect(store.shouldWakeForThread("thr_work")).toBe(false);

  await service(store, { threads: [watched()], interactions: [approvalInteraction()] }).service.processDue();

  expect(store.shouldWakeForThread("thr_work")).toBe(true);
});

it("asks once for a block it has already reported", async () => {
  const store = fixture();
  await service(store, { threads: [watched()], interactions: [approvalInteraction()] }).service.processDue();

  const again = service(store, { threads: [watched()], interactions: [approvalInteraction()] });
  await expect(again.service.processDue()).resolves.toBe(false);
});

it("keeps sweeping when one thread's interactions cannot be read", async () => {
  const store = fixture();
  await service(store, { threads: [watched({ status: "active" })] }).service.processDue();
  const warn = vi.fn();
  const listWatchable = vi.fn(async () => [watched({ status: "idle" })]);
  const notices = new ThreadNoticeService({
    store,
    threads: {
      listWatchable,
      interactions: vi.fn(async () => { throw new Error("BB is unreachable"); }),
      resolve: vi.fn(async () => undefined),
    },
    clock: { now: () => 3_000 },
    warn,
  });

  await expect(notices.processDue()).resolves.toBe(true);
  expect(store.getOutbox("thread:thr_work:idle")?.payload.text).toContain("finished");
});

it("sweeps on its own cadence rather than on every executor tick", async () => {
  const store = fixture();
  let now = 3_000;
  const listWatchable = vi.fn(async () => [watched({ status: "active" })]);
  const notices = new ThreadNoticeService({
    store,
    threads: { listWatchable, interactions: vi.fn(async () => []), resolve: vi.fn(async () => undefined) },
    clock: { now: () => now },
  });

  // The executor loop runs as often as every 250ms while an answer streams.
  for (let tick = 0; tick < 20; tick += 1) {
    now += 250;
    await notices.processDue();
  }

  expect(listWatchable.mock.calls.length).toBeLessThanOrEqual(2);
});

it("delivers a tapped answer without waiting for the next sweep", async () => {
  const store = fixture();
  await service(store, { threads: [watched()], interactions: [approvalInteraction()] }).service.processDue();
  store.answerThreadInteraction({
    token: threadDecisionToken(APPROVAL_ID, "deny"),
    userId: "7",
    chatId: "7",
    now: 3_100,
  });
  const resolve = vi.fn(async () => undefined);
  const notices = new ThreadNoticeService({
    store,
    threads: { listWatchable: vi.fn(async () => []), interactions: vi.fn(async () => []), resolve },
    clock: { now: () => 3_200 },
  });

  await expect(notices.processDue()).resolves.toBe(true);

  expect(resolve).toHaveBeenCalledWith("thr_work", APPROVAL_ID, { decision: "deny" });
});

it("still reports a block it cannot render, instead of leaving the thread silent", async () => {
  const store = fixture();
  const { service: notices } = service(store, {
    threads: [watched()],
    interactions: [{ id: "pint_plugin1", status: "pending", payload: { kind: "plugin", detail: "something new" } }],
  });

  await expect(notices.processDue()).resolves.toBe(true);

  const asked = store.getOutbox("thread-interaction:pint_plugin1");
  expect(asked?.payload.text).toContain("Fix the login bug");
  expect(asked?.payload.reply_markup).toBeUndefined();
});

it("does not contradict a finish it already reported when the thread errors later", async () => {
  const store = fixture();
  await service(store, { threads: [watched({ status: "active" })] }).service.processDue();
  await service(store, { threads: [watched({ status: "idle" })], now: () => 4_000 }).service.processDue();
  expect(store.getOutbox("thread:thr_work:idle")?.payload.text).toContain("finished");

  // A thread that has already finished can still be marked failed afterwards.
  // Its work is done; saying "failed" now would contradict what the owner read.
  const later = service(store, { threads: [watched({ status: "error" })], now: () => 5_000 });
  await expect(later.service.processDue()).resolves.toBe(false);

  expect(store.getOutbox("thread:thr_work:error")).toBeNull();
});

it("does not narrate every turn of a thread that keeps being given more work", async () => {
  const store = fixture();
  let clock = 3_000;
  const tick = (status: string) => {
    clock += 30_000;
    return service(store, { threads: [watched({ status })], now: () => clock });
  };
  await tick("active").service.processDue();
  await tick("idle").service.processDue();
  expect(store.getOutbox("thread:thr_work:idle")?.status).toBe("pending");

  await tick("active").service.processDue();
  const second = tick("idle");
  await expect(second.service.processDue()).resolves.toBe(false);
});

it("reports a later finish once the quiet period has passed", async () => {
  const store = fixture();
  let clock = 3_000;
  const tick = (status: string, jump = 30_000) => {
    clock += jump;
    return service(store, { threads: [watched({ status })], now: () => clock });
  };
  await tick("active").service.processDue();
  await tick("idle").service.processDue();

  await tick("active", 20 * 60_000).service.processDue();
  await expect(tick("idle").service.processDue()).resolves.toBe(true);
});

it("paginates past a full first page so later top-level threads are observed", async () => {
  const store = fixture();
  const firstPage = Array.from({ length: 100 }, (_, index) => watched({
    id: `thr_page_${index}`,
    title: `Thread ${index}`,
    status: "idle",
  }));
  const last = watched({ id: "thr_page_100", title: "Last thread", status: "idle" });
  const listWatchable = vi.fn(async (offset: number, limit: number) => {
    expect(limit).toBe(100);
    return offset === 0 ? firstPage : offset === 100 ? [last] : [];
  });
  const notices = new ThreadNoticeService({
    store,
    threads: { listWatchable, interactions: vi.fn(async () => []), resolve: vi.fn(async () => undefined) },
    clock: { now: () => 30_000 },
  });

  await expect(notices.processDue()).resolves.toBe(false);

  expect(listWatchable.mock.calls).toEqual([[0, 100], [100, 100]]);
  expect(store.getOutbox("thread:thr_page_100:idle")).toBeNull();
});
