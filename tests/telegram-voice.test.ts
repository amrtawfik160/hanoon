import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { TelegramIngress } from "../src/telegram/ingress";
import type { SendMessagePayload, TelegramUpdate } from "../src/telegram/types";
import { openStore } from "../src/storage/store";
import { ControllerVoiceService } from "../src/services/controller-voice-service";
import {
  MAX_CONTROLLER_VOICE_SECONDS,
  controllerVoiceFromMessage,
  parseTranscript,
  voiceTooLargeToTranscribe,
  voiceUnavailableNotice,
  type ControllerVoiceNote,
  type VoiceTranscription,
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
  transcribe?: (input: { bytes: Uint8Array; mimeType: string; signal: AbortSignal }) => Promise<VoiceTranscription>;
  download?: (fileId: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;
  withVoiceService?: boolean;
} = {}) {
  const { bb } = createFakePluginHost({ pluginId: `telegram-voice-${fixtureNumber++}` });
  const db: Database.Database = bb.storage.database();
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  db.prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, ?, ?, ?, NULL)",
  ).run("7", "70", 1_000);
  const telegram = new FakeTelegram();
  let now = 2_000;
  const download = vi.fn(options.download ?? (async () => new Uint8Array([1, 2, 3])));
  const transcribe = vi.fn(options.transcribe ?? (async () => ({
    outcome: "transcribed" as const,
    text: "ship the redirect fix",
  })));
  const ingress = new TelegramIngress({
    store,
    telegram,
  });
  const voice = options.withVoiceService === false ? null : { download, transcribe };
  const voiceService = new ControllerVoiceService({
    store,
    voice,
    clock: { now: () => now },
    ownerId: `voice-worker-${fixtureNumber}`,
  });
  const turnTexts = (): string[] =>
    (db.prepare("SELECT input_text FROM controller_turns ORDER BY ordinal").all() as Array<{ input_text: string }>)
      .map((row) => row.input_text);
  const noticeTexts = (): string[] => store.listOutbox(100)
    .filter((item) => item.logicalKey.startsWith("controller-voice:"))
    .map((item) => String(item.payload.text ?? ""));
  const ingest = async (update: TelegramUpdate, at = now, signal?: AbortSignal) => {
    now = at;
    expect(store.beginTelegramUpdate(update.update_id, at)).toBe("process");
    return ingress.handleClaimed(update, at, signal);
  };
  const processOne = async (signal = new AbortController().signal) => voiceService.processOne(signal);
  const setNow = (value: number): void => { now = value; };
  return {
    ingress,
    voiceService,
    voice,
    store,
    telegram,
    db,
    download,
    transcribe,
    turnTexts,
    noticeTexts,
    ingest,
    processOne,
    setNow,
  };
}

const NOTE: ControllerVoiceNote = {
  fileId: "file_1",
  mimeType: "audio/ogg",
  sizeBytes: 1_000,
  durationSeconds: 4,
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
  for (const reason of ["too_large", "transcript_too_long", "no_service", "empty", "unreadable"] as const) {
    expect(voiceUnavailableNotice(reason)).toMatch(/type it|send it again|send a shorter|try again/i);
  }
});

it("turns a voice note into the turn the owner would have typed", async () => {
  const test = fixture();

  await test.ingest(
    voiceUpdate(10, { file_id: "v1", file_unique_id: "u1", duration: 4, mime_type: "audio/ogg" }),
  );
  await test.processOne();

  expect(test.download).toHaveBeenCalledWith("v1", expect.any(Number), expect.any(AbortSignal));
  expect(test.transcribe).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "audio/ogg" }));
  expect(test.turnTexts()).toEqual(["ship the redirect fix"]);
  expect(test.store.getControllerVoice(10)).toMatchObject({ state: "completed", outcome: "transcribed" });
  expect(test.telegram.texts).toEqual([]);
});

it("hands a voice note off durably without downloading or transcribing in ingress", async () => {
  const test = fixture();

  await expect(test.ingest(
    voiceUpdate(19, { file_id: "v1", file_unique_id: "u1", duration: 4, mime_type: "audio/ogg" }),
  )).resolves.toEqual({ updateSettled: true });

  expect(test.download).not.toHaveBeenCalled();
  expect(test.transcribe).not.toHaveBeenCalled();
  expect(test.db.prepare(
    "SELECT update_id, state FROM controller_voice_inbox WHERE update_id = 19",
  ).get()).toEqual({ update_id: 19, state: "pending" });
});

it("tells the owner when a valid transcript is too long for one controller turn", async () => {
  const test = fixture({
    transcribe: async () => ({ outcome: "transcribed", text: "x".repeat(4_001) }),
  });

  await test.ingest(
    voiceUpdate(20, { file_id: "v1", file_unique_id: "u1", duration: 4 }),
  );
  await test.processOne();
  await expect(test.processOne()).resolves.toBe(false);

  expect(test.noticeTexts()).toEqual([voiceUnavailableNotice("transcript_too_long")]);
  expect(test.turnTexts()).toEqual([]);
});

it("lets a caption lead the transcript rather than be replaced by it", async () => {
  const test = fixture();

  await test.ingest(
    voiceUpdate(11, { file_id: "v1", file_unique_id: "u1", duration: 4 }, { caption: "about proj_1" }),
  );
  await test.processOne();

  expect(test.turnTexts()).toEqual(["about proj_1\n\nship the redirect fix"]);
});

it("says so plainly when this install has no voice service, and starts nothing", async () => {
  const test = fixture({ withVoiceService: false });

  await test.ingest(
    voiceUpdate(12, { file_id: "v1", file_unique_id: "u1", duration: 4 }),
  );
  await test.processOne();

  expect(test.telegram.texts).toEqual([]);
  expect(test.noticeTexts()).toEqual([voiceUnavailableNotice("no_service")]);
  expect(test.turnTexts()).toEqual([]);
});

it("distinguishes a recording it could not fetch from one it could not hear", async () => {
  const unreadable = fixture({ download: async () => { throw new Error("gateway"); } });
  await unreadable.ingest(
    voiceUpdate(13, { file_id: "v1", file_unique_id: "u1", duration: 4 }),
  );
  await unreadable.processOne();
  expect(unreadable.noticeTexts()).toEqual([voiceUnavailableNotice("unreadable")]);
  expect(unreadable.turnTexts()).toEqual([]);

  const silent = fixture({ transcribe: async () => ({ outcome: "empty" }) });
  await silent.ingest(
    voiceUpdate(14, { file_id: "v1", file_unique_id: "u1", duration: 4 }),
  );
  await silent.processOne();
  expect(silent.noticeTexts()).toEqual([voiceUnavailableNotice("empty")]);
  expect(silent.turnTexts()).toEqual([]);
});

it("reports the production transcriber being unavailable even though its adapter is registered", async () => {
  const test = fixture({ transcribe: async () => ({ outcome: "unavailable" }) });

  await test.ingest(
    voiceUpdate(17, { file_id: "v1", file_unique_id: "u1", duration: 4 }),
  );
  await test.processOne();

  expect(test.noticeTexts()).toEqual([voiceUnavailableNotice("no_service")]);
  expect(test.turnTexts()).toEqual([]);
});

it("recovers an interrupted transcription after its durable lease expires", async () => {
  let started!: () => void;
  const transcribing = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const test = fixture({
    transcribe: async ({ signal }): Promise<VoiceTranscription> => {
      calls += 1;
      if (calls > 1) return { outcome: "transcribed", text: "recovered voice" };
      started();
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const shutdown = new AbortController();

  await test.ingest(
    voiceUpdate(18, { file_id: "v1", file_unique_id: "u1", duration: 4 }),
  );
  const pending = test.processOne(shutdown.signal);
  await transcribing;
  shutdown.abort(new Error("service stopped"));
  await expect(pending).resolves.toBe(true);

  expect(test.store.getControllerVoice(18)).toMatchObject({ state: "processing", attempts: 1 });
  expect(test.noticeTexts()).toEqual([]);
  expect(test.turnTexts()).toEqual([]);

  test.setNow(302_001);
  const restarted = new ControllerVoiceService({
    store: test.store,
    voice: test.voice,
    clock: { now: () => 302_001 },
    ownerId: "restarted-voice-worker",
  });
  await expect(restarted.processOne(new AbortController().signal)).resolves.toBe(true);

  expect(test.store.getControllerVoice(18)).toMatchObject({ state: "completed", attempts: 2 });
  expect(test.turnTexts()).toEqual(["recovered voice"]);
});

it("refuses an over-long recording before spending a download on it", async () => {
  const test = fixture();

  await test.ingest(
    voiceUpdate(15, {
      file_id: "v1",
      file_unique_id: "u1",
      duration: MAX_CONTROLLER_VOICE_SECONDS + 1,
    }),
  );
  await test.processOne();

  expect(test.noticeTexts()).toEqual([voiceUnavailableNotice("too_large")]);
  expect(test.download).not.toHaveBeenCalled();
  expect(test.turnTexts()).toEqual([]);
});

it("never transcribes for someone who is not the owner", async () => {
  const test = fixture();

  await test.ingest(
    voiceUpdate(16, { file_id: "v1", file_unique_id: "u1", duration: 4 }, {}, 999, 999),
  );

  // Transcription is work and a stranger does not get it, nor a reply telling
  // them the bot is here.
  expect(test.download).not.toHaveBeenCalled();
  expect(test.transcribe).not.toHaveBeenCalled();
  expect(test.telegram.texts).toEqual([]);
  expect(test.turnTexts()).toEqual([]);
  expect(test.store.getControllerVoice(16)).toBeNull();
});
