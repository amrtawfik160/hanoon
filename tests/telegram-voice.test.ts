import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { TelegramIngress } from "../src/telegram/ingress";
import type { SendMessagePayload, TelegramUpdate } from "../src/telegram/types";
import { openStore } from "../src/storage/store";
import {
  MAX_CONTROLLER_VOICE_SECONDS,
  controllerVoiceFromMessage,
  parseTranscript,
  voiceTooLargeToTranscribe,
  voiceUnavailableNotice,
  type ControllerVoiceNote,
} from "../src/telegram/voice";

let fixtureNumber = 0;

class FakeTelegram {
  public readonly sent: Array<{ chatId: string; payload: SendMessagePayload }> = [];
  private nextMessageId = 100;

  public async sendMessage(chatId: string, payload: SendMessagePayload): Promise<{ message_id: number }> {
    this.sent.push({ chatId, payload });
    return { message_id: this.nextMessageId++ };
  }

  public async editMessage(): Promise<void> {}
  public async answerCallback(): Promise<void> {}

  public get texts(): string[] {
    return this.sent.map((entry) => entry.payload.text ?? "");
  }
}

function voiceUpdate(
  updateId: number,
  voice: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  userId = 7,
  chatId = 70,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1,
      from: { id: userId, is_bot: false },
      chat: { id: chatId, type: "private" },
      voice,
      ...extra,
    },
  } as TelegramUpdate;
}

function fixture(options: {
  transcribe?: (input: { bytes: Uint8Array; mimeType: string }) => Promise<string | null>;
  download?: () => Promise<Uint8Array>;
  withVoiceService?: boolean;
} = {}) {
  const { bb } = createFakePluginHost({ pluginId: `telegram-voice-${fixtureNumber++}` });
  const db: Database.Database = bb.storage.database();
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  db.prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, ?, ?, ?, NULL)",
  ).run("7", "70", 1_000);
  const telegram = new FakeTelegram();
  const download = vi.fn(options.download ?? (async () => new Uint8Array([1, 2, 3])));
  const transcribe = vi.fn(options.transcribe ?? (async () => "ship the redirect fix"));
  const ingress = new TelegramIngress({
    store,
    telegram,
    ...(options.withVoiceService === false ? {} : { voice: { download, transcribe } }),
  });
  const turnTexts = (): string[] =>
    (db.prepare("SELECT input_text FROM controller_turns ORDER BY ordinal").all() as Array<{ input_text: string }>)
      .map((row) => row.input_text);
  return { ingress, store, telegram, db, download, transcribe, turnTexts };
}

const NOTE: ControllerVoiceNote = {
  fileId: "file_1",
  mimeType: "audio/ogg",
  sizeBytes: 1_000,
  durationSeconds: 4,
  kind: "voice",
};

it("reads a voice note and an audio file, defaulting the type Telegram omits", () => {
  expect(controllerVoiceFromMessage({
    message_id: 1,
    from: { id: 7, is_bot: false },
    chat: { id: 70, type: "private" },
    voice: { file_id: "v1", file_unique_id: "u1", duration: 3 },
  } as never)).toEqual({
    fileId: "v1",
    mimeType: "audio/ogg",
    sizeBytes: null,
    durationSeconds: 3,
    kind: "voice",
  });
  expect(controllerVoiceFromMessage({
    message_id: 1,
    from: { id: 7, is_bot: false },
    chat: { id: 70, type: "private" },
    audio: { file_id: "a1", file_unique_id: "u2", duration: 9, mime_type: "audio/mpeg", file_size: 42 },
  } as never)).toEqual({
    fileId: "a1",
    mimeType: "audio/mpeg",
    sizeBytes: 42,
    durationSeconds: 9,
    kind: "audio",
  });
  expect(controllerVoiceFromMessage({
    message_id: 1,
    from: { id: 7, is_bot: false },
    chat: { id: 70, type: "private" },
    text: "typed",
  } as never)).toBeNull();
});

it("refuses a recording too long to be a message, by size or by duration", () => {
  expect(voiceTooLargeToTranscribe(NOTE)).toBe(false);
  expect(voiceTooLargeToTranscribe({ ...NOTE, sizeBytes: 21 * 1024 * 1024 })).toBe(true);
  expect(voiceTooLargeToTranscribe({ ...NOTE, durationSeconds: MAX_CONTROLLER_VOICE_SECONDS + 1 })).toBe(true);
  // An unknown size is not a large one; duration still bounds it.
  expect(voiceTooLargeToTranscribe({ ...NOTE, sizeBytes: null })).toBe(false);
});

it("takes only the transcript text, and nothing from malformed output", () => {
  expect(parseTranscript('{"text":"  hello there  "}')).toBe("hello there");
  expect(parseTranscript('{"text":"   "}')).toBeNull();
  expect(parseTranscript('{"text":42}')).toBeNull();
  expect(parseTranscript('{"other":"hello"}')).toBeNull();
  expect(parseTranscript("not json")).toBeNull();
  expect(parseTranscript("null")).toBeNull();
});

it("names a next step in every notice, because the owner cannot leave this chat", () => {
  for (const reason of ["too_large", "no_service", "empty", "unreadable"] as const) {
    expect(voiceUnavailableNotice(reason)).toMatch(/type it|send it again|send a shorter|try again/i);
  }
});

it("turns a voice note into the turn the owner would have typed", async () => {
  const test = fixture();

  await test.ingress.handleClaimed(
    voiceUpdate(10, { file_id: "v1", file_unique_id: "u1", duration: 4, mime_type: "audio/ogg" }),
    2_000,
  );

  expect(test.download).toHaveBeenCalledWith("v1", expect.any(Number), expect.any(AbortSignal));
  expect(test.transcribe).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "audio/ogg" }));
  expect(test.turnTexts()).toEqual(["ship the redirect fix"]);
  expect(test.telegram.texts).toEqual([]);
});

it("lets a caption lead the transcript rather than be replaced by it", async () => {
  const test = fixture();

  await test.ingress.handleClaimed(
    voiceUpdate(11, { file_id: "v1", file_unique_id: "u1", duration: 4 }, { caption: "about proj_1" }),
    2_000,
  );

  expect(test.turnTexts()).toEqual(["about proj_1\n\nship the redirect fix"]);
});

it("says so plainly when this install has no voice service, and starts nothing", async () => {
  const test = fixture({ withVoiceService: false });

  await test.ingress.handleClaimed(
    voiceUpdate(12, { file_id: "v1", file_unique_id: "u1", duration: 4 }),
    2_000,
  );

  expect(test.telegram.texts).toEqual([voiceUnavailableNotice("no_service")]);
  expect(test.turnTexts()).toEqual([]);
});

it("distinguishes a recording it could not fetch from one it could not hear", async () => {
  const unreadable = fixture({ download: async () => { throw new Error("gateway"); } });
  await unreadable.ingress.handleClaimed(
    voiceUpdate(13, { file_id: "v1", file_unique_id: "u1", duration: 4 }),
    2_000,
  );
  expect(unreadable.telegram.texts).toEqual([voiceUnavailableNotice("unreadable")]);
  expect(unreadable.turnTexts()).toEqual([]);

  const silent = fixture({ transcribe: async () => null });
  await silent.ingress.handleClaimed(
    voiceUpdate(14, { file_id: "v1", file_unique_id: "u1", duration: 4 }),
    2_000,
  );
  expect(silent.telegram.texts).toEqual([voiceUnavailableNotice("empty")]);
  expect(silent.turnTexts()).toEqual([]);
});

it("refuses an over-long recording before spending a download on it", async () => {
  const test = fixture();

  await test.ingress.handleClaimed(
    voiceUpdate(15, {
      file_id: "v1",
      file_unique_id: "u1",
      duration: MAX_CONTROLLER_VOICE_SECONDS + 1,
    }),
    2_000,
  );

  expect(test.telegram.texts).toEqual([voiceUnavailableNotice("too_large")]);
  expect(test.download).not.toHaveBeenCalled();
  expect(test.turnTexts()).toEqual([]);
});

it("never transcribes for someone who is not the owner", async () => {
  const test = fixture();

  await test.ingress.handleClaimed(
    voiceUpdate(16, { file_id: "v1", file_unique_id: "u1", duration: 4 }, {}, 999, 999),
    2_000,
  );

  // Transcription is work and a stranger does not get it, nor a reply telling
  // them the bot is here.
  expect(test.download).not.toHaveBeenCalled();
  expect(test.transcribe).not.toHaveBeenCalled();
  expect(test.telegram.texts).toEqual([]);
  expect(test.turnTexts()).toEqual([]);
});
