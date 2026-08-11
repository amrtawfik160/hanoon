import { describe, expect, it, vi } from "vitest";
import {
  TelegramClient,
  TelegramConflictError,
  TelegramFileTooLargeError,
} from "../src/telegram/client";
import { classifyTelegramError, TelegramApiError } from "../src/telegram/errors";
import { abortableSleep } from "../src/async";
import {
  immediateSleep,
  privateMessage,
  telegramFetch,
} from "./helpers";

describe("Telegram Bot API client", () => {
  it("resolves and downloads a bounded Telegram file without returning a token-bearing URL", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/getFile")) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            file_id: "photo-file-id",
            file_unique_id: "photo-unique-id",
            file_size: 4,
            file_path: "photos/screenshot.jpg",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-length": "4", "content-type": "image/jpeg" },
      });
    });
    const client = new TelegramClient("123:secret", fetchMock);

    await expect(client.downloadFile(
      "photo-file-id",
      10_000,
      AbortSignal.timeout(1_000),
    )).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.endsWith("/bot123:secret/getFile")).toBe(true);
    expect(calls[0]?.init?.body).toBe('{"file_id":"photo-file-id"}');
    expect(calls[1]).toMatchObject({
      url: "https://api.telegram.org/file/bot123:secret/photos/screenshot.jpg",
      init: { method: "GET", redirect: "error", cache: "no-store" },
    });
  });

  it("rejects an oversized Telegram file before downloading its bytes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: {
        file_id: "photo-file-id",
        file_unique_id: "photo-unique-id",
        file_size: 10_001,
        file_path: "photos/too-large.jpg",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new TelegramClient("123:secret", fetchMock);

    await expect(client.downloadFile(
      "photo-file-id",
      10_000,
      AbortSignal.timeout(1_000),
    )).rejects.toBeInstanceOf(TelegramFileTooLargeError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops a file download when the received bytes cross the size limit", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            file_id: "photo-file-id",
            file_unique_id: "photo-unique-id",
            file_path: "photos/unknown-size.jpg",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(new Uint8Array(10_001), { status: 200 });
    });
    const client = new TelegramClient("123:secret", fetchMock);

    await expect(client.downloadFile(
      "photo-file-id",
      10_000,
      AbortSignal.timeout(1_000),
    )).rejects.toBeInstanceOf(TelegramFileTooLargeError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("redacts the bot token when the private file download fails", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            file_id: "photo-file-id",
            file_unique_id: "photo-unique-id",
            file_path: "photos/screenshot.jpg",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`network failure for ${String(input)}`);
    });
    const client = new TelegramClient("123:secret", fetchMock);

    const error = await client.downloadFile(
      "photo-file-id",
      10_000,
      AbortSignal.timeout(1_000),
    ).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("123:secret");
    expect(String(error)).toContain("Telegram request failed");
  });

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
    ["Bad Request: message is not modified: specified new message content and reply markup are exactly the same", 400, "not_modified"],
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

  it("treats Telegram's detailed not-modified edit response as success", async () => {
    const fetchMock = telegramFetch([
      {
        ok: false,
        error_code: 400,
        description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
      },
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

  it("sends the native typing chat action with the exact Telegram payload", async () => {
    const fetchMock = telegramFetch([{ ok: true, result: true }]);
    const client = new TelegramClient("token", fetchMock);

    await expect(client.sendChatAction("70", "typing")).resolves.toBeUndefined();

    expect(fetchMock.calls).toEqual([{
      method: "sendChatAction",
      body: '{"chat_id":"70","action":"typing"}',
    }]);
  });

  it("streams an ephemeral Telegram draft with one stable non-zero draft id", async () => {
    const fetchMock = telegramFetch([
      { ok: true, result: true },
      { ok: true, result: true },
    ]);
    const client = new TelegramClient("token", fetchMock);

    await expect(client.sendMessageDraft("70", 91, "")).resolves.toBeUndefined();
    await expect(client.sendMessageDraft("70", 91, "Partial answer")).resolves.toBeUndefined();

    expect(fetchMock.calls).toEqual([
      {
        method: "sendMessageDraft",
        body: '{"chat_id":"70","draft_id":91,"text":""}',
      },
      {
        method: "sendMessageDraft",
        body: '{"chat_id":"70","draft_id":91,"text":"Partial answer"}',
      },
    ]);
  });

  it("rejects an invalid Telegram draft id before making a request", () => {
    const fetchMock = telegramFetch([]);
    const client = new TelegramClient("token", fetchMock);

    expect(() => client.sendMessageDraft("70", 0, "Partial answer")).toThrow(
      "draftId must be a non-zero safe integer",
    );
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("fails a chat action after one attempt and rejects unsupported actions before fetch", async () => {
    immediateSleep.mockClear();
    const fetchMock = telegramFetch([
      { ok: false, error_code: 429, description: "slow", parameters: { retry_after: 30 } },
    ]);
    const client = new TelegramClient("token", fetchMock, { sleep: immediateSleep });

    await expect(client.sendChatAction("70", "typing")).rejects.toBeInstanceOf(TelegramApiError);
    expect(() => client.sendChatAction("70", "upload_photo" as "typing")).toThrow(
      "Unsupported Telegram chat action",
    );

    expect(fetchMock.calls).toHaveLength(1);
    expect(immediateSleep).not.toHaveBeenCalled();
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
