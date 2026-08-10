import { describe, expect, it, vi } from "vitest";
import {
  TelegramClient,
  TelegramConflictError,
} from "../src/telegram/client";
import { classifyTelegramError, TelegramApiError } from "../src/telegram/errors";
import { abortableSleep } from "../src/async";
import {
  immediateSleep,
  privateMessage,
  telegramFetch,
} from "./helpers";

describe("Telegram Bot API client", () => {
  it("long-polls with an offset and validates the returned update", async () => {
    const fetchMock = telegramFetch([
      { ok: true, result: [{ update_id: 42, message: privateMessage("fix it") }] },
    ]);
    const client = new TelegramClient("123:secret", fetchMock);

    const updates = await client.getUpdates(42, 30, AbortSignal.timeout(1_000));

    expect(updates[0]?.update_id).toBe(42);
    expect(updates[0]?.message?.text).toBe("fix it");
    expect(fetchMock.calls[0]?.method).toBe("getUpdates");
    expect(fetchMock.calls[0]?.body).toContain('"offset":42');
    expect(JSON.stringify(fetchMock.calls)).toContain("allowed_updates");
    expect(JSON.stringify(fetchMock.calls)).not.toContain("123:secret");
  });

  it("honors retry_after without exposing the token", async () => {
    immediateSleep.mockClear();
    const fetchMock = telegramFetch([
      { ok: false, error_code: 429, description: "slow", parameters: { retry_after: 1 } },
      { ok: true, result: { message_id: 9 } },
    ]);
    const client = new TelegramClient("123:secret", fetchMock, { sleep: immediateSleep });

    await expect(client.sendMessage("1", { text: "hello" })).resolves.toMatchObject({ message_id: 9 });

    expect(immediateSleep).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
    expect(fetchMock.calls).toHaveLength(2);
    expect(JSON.stringify(fetchMock.calls)).not.toContain("123:secret");
  });

  it("allows three transient retries after the initial request", async () => {
    immediateSleep.mockClear();
    const fetchMock = telegramFetch([
      { ok: false, error_code: 500, description: "first" },
      { ok: false, error_code: 502, description: "second" },
      { ok: false, error_code: 503, description: "third" },
      { ok: true, result: { message_id: 10 } },
    ]);
    const client = new TelegramClient("token", fetchMock, { sleep: immediateSleep });

    await expect(client.sendMessage("1", { text: "hello" })).resolves.toMatchObject({ message_id: 10 });

    expect(fetchMock.calls).toHaveLength(4);
    expect(immediateSleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1_000]);
  });

  it("aborts a retry delay through the caller signal", async () => {
    const controller = new AbortController();
    const fetchMock = telegramFetch([
      { ok: false, error_code: 503, description: "temporary" },
    ]);
    const sleep = vi.fn((_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        void resolve;
      }),
    );
    const client = new TelegramClient("token", fetchMock, { sleep });

    const pending = client.sendMessage("1", { text: "hello" }, controller.signal);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
    controller.abort(new Error("caller secret"));

    await expect(pending).rejects.toThrow("Telegram request aborted");
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("throws safe errors for unauthorized responses", async () => {
    const fetchMock = telegramFetch([
      {
        ok: false,
        error_code: 401,
        description: "raw response body containing 123:secret and message text",
      },
    ]);
    const client = new TelegramClient("123:secret", fetchMock);

    const error = await client.getMe().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Telegram API 401");
    expect((error as Error).message).not.toContain("123:secret");
    expect((error as Error).message).not.toContain("raw response body");
  });

  it("surfaces polling conflicts as a typed non-retryable error", async () => {
    immediateSleep.mockClear();
    const fetchMock = telegramFetch([
      { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" },
    ]);
    const client = new TelegramClient("token", fetchMock, { sleep: immediateSleep });

    const error = await client.getUpdates(0, 30, AbortSignal.timeout(1_000)).catch((value) => value);

    expect(error).toBeInstanceOf(TelegramConflictError);
    expect(fetchMock.calls).toHaveLength(1);
    expect(immediateSleep).not.toHaveBeenCalled();
  });

  it("preserves sanitized Telegram metadata without exposing the bot token", async () => {
    const fetchMock = telegramFetch([
      { ok: false, error_code: 400, description: "Bad Request: query is too old and response timeout expired" },
    ]);
    const client = new TelegramClient("123:secret", fetchMock);

    const error = await client.answerCallback("callback-1", "Done").catch((value: unknown) => value);

    expect(error).toMatchObject({
      name: "TelegramApiError",
      httpStatus: 400,
      errorCode: 400,
      description: "Bad Request: query is too old and response timeout expired",
      retryAfterSeconds: null,
    });
    expect(String(error)).not.toContain("123:secret");
  });

  it.each([
    ["message is not modified", 400, "not_modified"],
    ["Bad Request: query is too old and response timeout expired", 400, "expired_callback"],
    ["Bad Request: message to edit not found", 400, "edit_unavailable"],
    ["Bad Request: can't parse entities", 400, "bad_entities"],
    ["Unauthorized", 401, "authentication"],
    ["Too Many Requests", 429, "retryable"],
    ["Internal Server Error", 500, "retryable"],
    ["Unknown response", 600, "permanent"],
    ["Bad Request: chat not found", 400, "permanent"],
  ])("classifies %s", (description, errorCode, expected) => {
    const error = new TelegramApiError({
      httpStatus: errorCode,
      errorCode,
      description,
      retryAfterSeconds: errorCode === 429 ? 2 : null,
    });

    expect(classifyTelegramError(error)).toBe(expected);
  });

  it("treats the exact not-modified edit response as success", async () => {
    const fetchMock = telegramFetch([
      { ok: false, error_code: 400, description: "Bad Request: message is not modified" },
    ]);
    const client = new TelegramClient("token", fetchMock);

    await expect(client.editMessage("70", 9, { text: "same" })).resolves.toBeUndefined();
    expect(fetchMock.calls[0]?.method).toBe("editMessageText");
  });

  it("sends narrow JSON payloads for message, callback, and identity calls", async () => {
    const fetchMock = telegramFetch([
      { ok: true, result: { message_id: 11 } },
      { ok: true, result: true },
      { ok: true, result: { id: 99, username: "safe_bot" } },
    ]);
    const client = new TelegramClient("token", fetchMock);

    await client.sendMessage("70", { text: "hello", parse_mode: "HTML" });
    await client.answerCallback("callback-1", "Done");
    await expect(client.getMe()).resolves.toEqual({ id: 99, username: "safe_bot" });

    expect(fetchMock.calls.map((call) => call.method)).toEqual([
      "sendMessage",
      "answerCallbackQuery",
      "getMe",
    ]);
    expect(fetchMock.calls[0]?.body).toContain('"chat_id":"70"');
    expect(fetchMock.calls[1]?.body).toContain('"callback_query_id":"callback-1"');
  });

  it("rejects an update that is outside the narrow Telegram schema", async () => {
    const fetchMock = telegramFetch([
      { ok: true, result: [{ update_id: 42, message: { message_id: "not-an-id" } }] },
    ]);
    const client = new TelegramClient("token", fetchMock);

    await expect(client.getUpdates(0, 30, AbortSignal.timeout(1_000))).rejects.toThrow(
      "Telegram response was invalid",
    );
  });
});

describe("abortableSleep", () => {
  it("rejects immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await expect(abortableSleep(60_000, controller.signal)).rejects.toThrow("stop");
  });
});
