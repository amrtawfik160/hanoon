import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramUpdate } from "../src/telegram/types";
import { TelegramIngress } from "../src/telegram/ingress";
import { TelegramClient } from "../src/telegram/client";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { admitConfirmedJob, policyFixture, telegramFetch } from "./helpers";
import { runTelegramService, type TelegramServiceDeps } from "../src/services/telegram-service";

let fixtureNumber = 0;

afterEach(() => {
  vi.useRealTimers();
});

type Kv = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
};

function memoryKv(): Kv {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> { return values.get(key) as T | undefined; },
    async set(key: string, value: unknown): Promise<void> { values.set(key, value); },
    async delete(key: string): Promise<void> { values.delete(key); },
    async list(prefix = ""): Promise<string[]> { return [...values.keys()].filter((key) => key.startsWith(prefix)); },
  };
}

function storeFixture(): { store: TelegramAgentStore; db: Database.Database } {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-task10-telegram-${fixtureNumber++}` });
  const db = bb.storage.database();
  const store = openStore(bb.storage, memoryKv(), () => 1_000);
  db.prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, '7', '70', 1, NULL)",
  ).run();
  store.bindTelegramIdentity({ botId: "123", username: "bot", now: 1, hasActiveJob: false });
  store.upsertProjectPolicy(policyFixture(), 1);
  return { store, db };
}

function callbackStartUpdate(jobId: string, updateId = 50): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 7, is_bot: false },
      message: { message_id: 123, chat: { id: 70, type: "private" } },
      data: `s:${jobId}`,
    },
  } as TelegramUpdate;
}

function realClientFactory(
  responses: Parameters<typeof telegramFetch>[0],
  onPoll?: (pollNumber: number) => void,
): TelegramServiceDeps["client"] {
  const boundary = telegramFetch(responses);
  let pollNumber = 0;
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/getUpdates")) {
      pollNumber += 1;
      onPoll?.(pollNumber);
    }
    return boundary(input, init);
  }) as unknown as typeof fetch;
  return vi.fn((token: string) => new TelegramClient(token, fetchFn));
}

function serviceDeps(
  store: TelegramAgentStore,
  client: TelegramServiceDeps["client"],
  ingress: TelegramServiceDeps["ingress"],
  getConfig: TelegramServiceDeps["getConfig"],
): TelegramServiceDeps {
  return {
    store,
    client,
    ingress,
    getConfig,
    clock: { now: () => 2_000 },
  };
}

describe("Telegram ingress service", () => {
  it("uses the fixed 30-second Telegram long-poll timeout", async () => {
    const { store } = storeFixture();
    const abort = new AbortController();
    const pollTimeouts: number[] = [];
    const client = vi.fn(() => ({
      getMe: vi.fn(async () => ({ id: 123, username: "bot" })),
      getUpdates: vi.fn(async (_offset: number, timeoutSeconds: number) => {
        pollTimeouts.push(timeoutSeconds);
        abort.abort();
        return [];
      }),
    })) as TelegramServiceDeps["client"];

    await runTelegramService(
      serviceDeps(
        store,
        client,
        { handleClaimed: vi.fn(async () => ({ updateSettled: false })) },
        () => ({ ok: true, value: { botToken: "123:secret" } }),
      ),
      abort.signal,
    );

    expect(pollTimeouts).toEqual([30]);
  });

  it("orders updates and advances the SQLite cursor only after each claimed update completes", async () => {
    vi.useFakeTimers();
    const { store } = storeFixture();
    const seen: number[] = [];
    const abort = new AbortController();
    const client = realClientFactory([
      { ok: true, result: { id: 123, username: "bot" } },
      { ok: true, result: [{ update_id: 12 }, { update_id: 10 }, { update_id: 11 }] },
      { ok: true, result: [] },
    ], (pollNumber) => {
      if (pollNumber === 2) abort.abort();
    });
    const ingress = {
      handleClaimed: vi.fn(async (update: TelegramUpdate) => {
        seen.push(update.update_id);
        expect(store.getNextTelegramOffset()).toBe(update.update_id === 10 ? 0 : update.update_id);
        return { updateSettled: false };
      }),
    };
    const promise = runTelegramService(
      serviceDeps(
        store,
        client,
        ingress,
        () => ({ ok: true, value: { botToken: "123:secret" } }),
      ),
      abort.signal,
    );

    await promise;

    expect(seen).toEqual([10, 11, 12]);
    expect(store.getNextTelegramOffset()).toBe(13);
    expect(client).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets the pure service persist a Start transition without any BB worker capability", async () => {
    const { store } = storeFixture();
    const draft = store.createJob({ id: "abcdefghijklmnopqrstuv", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    store.applyJobEvent(draft.id, draft.version, {
      type: "PROJECT_SELECTED",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
    }, 1_001);
    admitConfirmedJob(store, store.getJob(draft.id)!, 1_002);
    store.setJobStatusMessage(draft.id, 123, store.getJob(draft.id)!.version, 1_003);

    const abort = new AbortController();
    const client = realClientFactory([
      { ok: true, result: { id: 123, username: "bot" } },
      { ok: true, result: [callbackStartUpdate(draft.id)] },
      { ok: true, result: [] },
    ], (pollNumber) => {
      if (pollNumber === 2) abort.abort();
    });
    const ingress = new TelegramIngress({
      store,
      telegram: {
        sendMessage: vi.fn(async () => ({ message_id: 200 })),
        editMessage: vi.fn(async () => undefined),
        answerCallback: vi.fn(async () => undefined),
      },
    });

    const promise = runTelegramService(
      serviceDeps(
        store,
        client,
        ingress,
        () => ({ ok: true, value: { botToken: "123:secret" } }),
      ),
      abort.signal,
    );
    await promise;

    expect(store.listEffectsForJob(draft.id).filter((effect) => effect.kind === "spawn_plan")).toHaveLength(1);
    expect(client).toHaveBeenCalledTimes(1);
  });

  it("leaves the cursor unchanged when ingress fails so the same update can be replayed", async () => {
    const { store, db } = storeFixture();
    const abort = new AbortController();
    const error = new Error("boom");
    const client = realClientFactory([
      { ok: true, result: { id: 123, username: "bot" } },
      { ok: true, result: [{ update_id: 10 }] },
      { ok: true, result: [] },
    ], (pollNumber) => {
      if (pollNumber === 2) abort.abort();
    });
    const ingress = { handleClaimed: vi.fn(async () => { throw error; }) };

    await runTelegramService(
      serviceDeps(
        store,
        client,
        ingress,
        () => ({ ok: true, value: { botToken: "123:secret" } }),
      ),
      abort.signal,
    );

    expect(store.getNextTelegramOffset()).toBe(0);
    expect(db.prepare("SELECT status, last_error FROM telegram_updates WHERE update_id = 10").get()).toEqual({
      status: "failed",
      last_error: "boom",
    });
  });

  it("keeps polling after a failed update instead of crashing the ingress service", async () => {
    const { store } = storeFixture();
    const abort = new AbortController();
    const seen: number[] = [];
    const client = realClientFactory([
      { ok: true, result: { id: 123, username: "bot" } },
      { ok: true, result: [{ update_id: 10 }, { update_id: 11 }] },
      { ok: true, result: [] },
    ], (pollNumber) => {
      if (pollNumber === 2) abort.abort();
    });
    const ingress = {
      handleClaimed: vi.fn(async (update: TelegramUpdate) => {
        seen.push(update.update_id);
        if (update.update_id === 10) throw new Error("Telegram API 400");
        return { updateSettled: false };
      }),
    };

    await runTelegramService(
      serviceDeps(
        store,
        client,
        ingress,
        () => ({ ok: true, value: { botToken: "123:secret" } }),
      ),
      abort.signal,
    );

    expect(seen).toEqual([10, 11]);
  });

  it("abandons an update that keeps failing so the cursor can advance past it", async () => {
    const { store, db } = storeFixture();
    const abort = new AbortController();
    const client = realClientFactory([
      { ok: true, result: { id: 123, username: "bot" } },
      { ok: true, result: [{ update_id: 10 }, { update_id: 11 }] },
      { ok: true, result: [{ update_id: 10 }, { update_id: 11 }] },
      { ok: true, result: [{ update_id: 10 }, { update_id: 11 }] },
      { ok: true, result: [] },
    ], (pollNumber) => {
      if (pollNumber === 4) abort.abort();
    });
    const ingress = {
      handleClaimed: vi.fn(async (update: TelegramUpdate) => {
        if (update.update_id === 10) throw new Error("Telegram API 400");
        return { updateSettled: false };
      }),
    };

    await runTelegramService(
      serviceDeps(
        store,
        client,
        ingress,
        () => ({ ok: true, value: { botToken: "123:secret" } }),
      ),
      abort.signal,
    );

    expect(db.prepare("SELECT status, outcome, last_error FROM telegram_updates WHERE update_id = 10").get()).toEqual({
      status: "processed",
      outcome: "abandoned",
      last_error: "Telegram API 400",
    });
    expect(store.getNextTelegramOffset()).toBe(12);
  });

  it("retries a stalled long poll instead of crashing the ingress service", async () => {
    vi.useFakeTimers();
    const { store } = storeFixture();
    const abort = new AbortController();
    const warnings: string[] = [];
    let poll = 0;
    const client = vi.fn(() => ({
      getMe: vi.fn(async () => ({ id: 123, username: "bot" })),
      getUpdates: vi.fn(async () => {
        poll += 1;
        if (poll === 1) throw new Error("Telegram request aborted");
        abort.abort();
        return [];
      }),
    })) as TelegramServiceDeps["client"];

    const promise = runTelegramService(
      {
        ...serviceDeps(store, client, { handleClaimed: vi.fn(async () => ({ updateSettled: false })) }, () => ({
          ok: true,
          value: { botToken: "123:secret" },
        })),
        warn: (message: string) => warnings.push(message),
      },
      abort.signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(poll).toBe(2);
    expect(warnings[0]).toContain("Telegram request aborted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supersedes an orphaned activation before its replacement starts polling", async () => {
    const { store } = storeFixture();
    const firstAbort = new AbortController();
    const replacementAbort = new AbortController();
    let activation = 0;
    let activePolls = 0;
    let maximumActivePolls = 0;
    let markFirstPollStarted: () => void = () => undefined;
    const firstPollStarted = new Promise<void>((resolve) => {
      markFirstPollStarted = resolve;
    });
    const client = vi.fn(() => {
      activation += 1;
      const currentActivation = activation;
      return {
        getMe: vi.fn(async () => ({ id: 123, username: "bot" })),
        getUpdates: vi.fn(async (_offset: number, _timeoutSeconds: number, signal: AbortSignal) => {
          activePolls += 1;
          maximumActivePolls = Math.max(maximumActivePolls, activePolls);
          if (currentActivation === 1) {
            markFirstPollStarted();
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                activePolls -= 1;
                reject(signal.reason);
              }, { once: true });
            });
            return [];
          }
          firstAbort.abort();
          replacementAbort.abort();
          activePolls -= 1;
          return [];
        }),
      };
    }) as TelegramServiceDeps["client"];
    const deps = serviceDeps(
      store,
      client,
      { handleClaimed: vi.fn(async () => ({ updateSettled: false })) },
      () => ({ ok: true, value: { botToken: "123:secret" } }),
    );

    const first = runTelegramService(deps, firstAbort.signal);
    await firstPollStarted;
    const replacement = runTelegramService(deps, replacementAbort.signal);
    await Promise.all([first, replacement]);

    expect(maximumActivePolls).toBe(1);
  });

  it("binds identity once per token and keeps polling through a transient conflict", async () => {
    const { store } = storeFixture();
    const abort = new AbortController();
    const client = realClientFactory([
      { ok: true, result: { id: 123, username: "bot" } },
      { ok: false, error_code: 409, description: "Conflict" },
      { ok: true, result: [{ update_id: 10 }] },
      { ok: true, result: [] },
    ], (pollNumber) => {
      if (pollNumber === 3) abort.abort();
    });

    await runTelegramService(
      serviceDeps(
        store,
        client,
        { handleClaimed: vi.fn(async () => ({ updateSettled: false })) },
        () => ({ ok: true, value: { botToken: "123:secret" } }),
      ),
      abort.signal,
    );

    expect(store.getTelegramIdentity()).toMatchObject({ botId: "123", username: "bot" });
    expect(store.getNextTelegramOffset()).toBe(11);
  });

  it("stops only once a polling conflict is sustained", async () => {
    vi.useFakeTimers();
    const { store } = storeFixture();
    const abort = new AbortController();
    const client = realClientFactory([
      { ok: true, result: { id: 123, username: "bot" } },
      ...Array.from({ length: 12 }, () => ({ ok: false as const, error_code: 409, description: "Conflict" })),
    ]);

    const promise = runTelegramService(
      serviceDeps(
        store,
        client,
        { handleClaimed: vi.fn(async () => ({ updateSettled: false })) },
        () => ({ ok: true, value: { botToken: "123:secret" } }),
      ),
      abort.signal,
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: "NeedsConfigurationError" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await assertion;
    vi.useRealTimers();
  });

  it("redacts bot tokens from service failures", async () => {
    const { store, db } = storeFixture();
    const abort = new AbortController();
    const client = realClientFactory([
      { ok: true, result: { id: 123, username: "bot" } },
      { ok: true, result: [{ update_id: 10 }] },
      { ok: true, result: [] },
    ], (pollNumber) => {
      if (pollNumber === 2) abort.abort();
    });

    await runTelegramService(
      serviceDeps(
        store,
        client,
        { handleClaimed: vi.fn(async () => { throw new Error("failed bot123:abcdefghijklmnopqrstuvwxyzABCDE"); }) },
        () => ({ ok: true, value: { botToken: "123:abcdefghijklmnopqrstuvwxyzABCDE" } }),
      ),
      abort.signal,
    );
    expect(db.prepare("SELECT status, last_error FROM telegram_updates WHERE update_id = 10").get()).toEqual({
      status: "failed",
      last_error: "failed bot[redacted]",
    });
  });

  it("recreates the client after an in-memory token rotation without resetting the same bot identity", async () => {
    vi.useFakeTimers();
    const { store } = storeFixture();
    const abort = new AbortController();
    let token = "123:first";
    const clientTokens: string[] = [];
    const client = vi.fn((clientToken: string) => {
      clientTokens.push(clientToken);
      return {
        getMe: vi.fn(async () => ({ id: 123, username: "bot" })),
        getUpdates: vi.fn((_offset: number, _timeoutSeconds: number, signal: AbortSignal) => new Promise<TelegramUpdate[]>((resolve) => {
          const timer = setTimeout(() => {
            if (clientToken === "123:first") {
              token = "123:second";
            } else {
              abort.abort();
            }
            resolve([]);
          }, 100);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve([]);
          }, { once: true });
        })),
      };
    }) as TelegramServiceDeps["client"];

    const promise = runTelegramService(
      serviceDeps(store, client, { handleClaimed: vi.fn(async () => ({ updateSettled: false })) }, () => ({
        ok: true,
        value: { botToken: token },
      })),
      abort.signal,
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(clientTokens).toEqual(["123:first", "123:second"]);
    expect(store.getTelegramIdentity()).toMatchObject({ botId: "123", username: "bot" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a pending polling heartbeat without leaking its timer", async () => {
    vi.useFakeTimers();
    const { store } = storeFixture();
    const abort = new AbortController();
    const client = vi.fn(() => ({
      getMe: vi.fn(async () => ({ id: 123, username: "bot" })),
      getUpdates: vi.fn((_offset: number, _timeoutSeconds: number, signal: AbortSignal) => new Promise<TelegramUpdate[]>((resolve) => {
        const timer = setTimeout(() => resolve([]), 30_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve([]);
        }, { once: true });
      })),
    })) as TelegramServiceDeps["client"];

    const promise = runTelegramService(
      serviceDeps(store, client, { handleClaimed: vi.fn(async () => ({ updateSettled: false })) }, () => ({
        ok: true,
        value: { botToken: "123:secret" },
      })),
      abort.signal,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    abort.abort();
    await promise;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a stalled Telegram poll at its timeout without leaking timer handles", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
    }));
    const client = new TelegramClient("123:secret", fetchMock);
    const controller = new AbortController();
    const pending = client.getUpdates(0, 5, controller.signal);
    setTimeout(() => controller.abort(), 1_000);
    const rejected = expect(pending).rejects.toThrow("Telegram request aborted");

    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
