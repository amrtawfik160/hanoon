import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import {
  OVERSIZED_FILE_REPLY,
  TelegramIngress,
  UNSUPPORTED_FILE_REPLY,
} from "../src/telegram/ingress";
import type { SendMessagePayload, TelegramUpdate } from "../src/telegram/types";
import { CONTROLLER_BURST_QUIET_GAP_MS } from "../src/controller/burst";

const NOW = 10_000;

class FakeTelegram {
  public readonly sent: { chatId: string; payload: SendMessagePayload }[] = [];

  public async sendMessage(chatId: string, payload: SendMessagePayload): Promise<{ message_id: number }> {
    this.sent.push({ chatId, payload });
    return { message_id: this.sent.length + 100 };
  }

  public async editMessage(): Promise<void> {}
  public async answerCallback(): Promise<void> {}
}

function ingressFixture() {
  const { bb } = createFakePluginHost({ pluginId: "telegram-ingress-burst" });
  const db = bb.storage.database();
  const store = openStore(bb.storage, bb.storage.kv);
  db.prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, '7', '70', 1_000, NULL)",
  ).run();
  const telegram = new FakeTelegram();
  const ingress = new TelegramIngress({ store, telegram });
  return { store, ingress, telegram };
}

function update(updateId: number, overrides: Record<string, unknown>): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1,
      from: { id: 7, is_bot: false },
      chat: { id: 70, type: "private" },
      ...overrides,
    },
  } as TelegramUpdate;
}

it("persists a forwarded message's sender attribution", async () => {
  const { store, ingress } = ingressFixture();
  await ingress.handleClaimed(update(1, {
    text: "look at this",
    forward_origin: {
      type: "user",
      date: 9_000,
      sender_user: { id: 5, is_bot: false, first_name: "Tom", last_name: "Counsell" },
    },
  } as never), NOW);

  const turn = store.getControllerTurn("controller-turn-1");
  expect(turn?.source).toMatchObject({
    kind: "forwarded",
    forwardedFrom: "Tom Counsell",
    forwardedHidden: false,
  });
});

it("persists a reply's quoted author and text", async () => {
  const { store, ingress } = ingressFixture();
  await ingress.handleClaimed(update(2, {
    text: "this one instead",
    reply_to_message: {
      message_id: 44,
      from: { id: 42, is_bot: true, first_name: "Hanoon" },
      text: "the earlier answer",
    },
  } as never), NOW);

  const turn = store.getControllerTurn("controller-turn-2");
  expect(turn?.source).toMatchObject({
    kind: "reply",
    quotedFromAgent: true,
    quotedText: "the earlier answer",
    replyToMessageId: 44,
  });
});

it("queues a PDF with its caption as the message text", async () => {
  const { store, ingress } = ingressFixture();
  await ingress.handleClaimed(update(3, {
    caption: "please review section 2",
    document: {
      file_id: "pdf-1",
      file_unique_id: "u1",
      file_name: "architecture-review.pdf",
      mime_type: "application/pdf",
      file_size: 40_000,
    },
  } as never), NOW);

  const turn = store.getControllerTurn("controller-turn-3");
  expect(turn?.inputText).toBe("please review section 2");
  expect(turn?.document).toMatchObject({ fileName: "architecture-review.pdf", mimeType: "application/pdf" });
});

it("queues a captionless document with the default reading request", async () => {
  const { store, ingress } = ingressFixture();
  await ingress.handleClaimed(update(4, {
    document: {
      file_id: "md-1",
      file_unique_id: "u2",
      file_name: "brief.md",
      mime_type: "text/markdown",
    },
  } as never), NOW);

  const turn = store.getControllerTurn("controller-turn-4");
  expect(turn?.inputText).toBe("Please read this file.");
  expect(turn?.document).toMatchObject({ mimeType: "text/markdown" });
});

it("replies once to a burst of unsupported files and queues nothing", async () => {
  const { store, ingress, telegram } = ingressFixture();
  const unsupported = {
    file_id: "zip-1",
    file_unique_id: "u3",
    file_name: "archive.zip",
    mime_type: "application/zip",
  };
  await ingress.handleClaimed(update(5, { document: unsupported } as never), NOW);
  await ingress.handleClaimed(update(6, {
    document: { ...unsupported, file_id: "zip-2", file_unique_id: "u4" },
  } as never), NOW + 100);

  const refusals = telegram.sent.filter((row) => row.payload.text === UNSUPPORTED_FILE_REPLY);
  expect(refusals).toHaveLength(1);
  expect(store.listControllerTurns("owner-7-controller", 10)).toHaveLength(0);
});

it("keeps a burst of refusals to one reply across an ingress restart", async () => {
  const { store, ingress, telegram } = ingressFixture();
  const unsupported = {
    file_id: "zip-1",
    file_unique_id: "u3",
    file_name: "archive.zip",
    mime_type: "application/zip",
  };
  await ingress.handleClaimed(update(11, { document: unsupported } as never), NOW);
  // The plugin restarts mid-burst: a fresh ingress over the same store.
  const restarted = new TelegramIngress({ store, telegram });
  await restarted.handleClaimed(update(12, {
    document: { ...unsupported, file_id: "zip-2", file_unique_id: "u4" },
  } as never), NOW + 100);
  // After the quiet gap, a new bad file is a new burst and is told again.
  await restarted.handleClaimed(update(13, {
    document: { ...unsupported, file_id: "zip-3", file_unique_id: "u5" },
  } as never), NOW + CONTROLLER_BURST_QUIET_GAP_MS + 100);

  const refusals = telegram.sent.filter((row) => row.payload.text === UNSUPPORTED_FILE_REPLY);
  expect(refusals).toHaveLength(2);
});

it("replies once to an oversized file and queues nothing", async () => {
  const { store, ingress, telegram } = ingressFixture();
  await ingress.handleClaimed(update(7, {
    document: {
      file_id: "pdf-big",
      file_unique_id: "u5",
      file_name: "big.pdf",
      mime_type: "application/pdf",
      file_size: 21 * 1024 * 1024,
    },
  } as never), NOW);

  expect(telegram.sent.map((row) => row.payload.text)).toContain(OVERSIZED_FILE_REPLY);
  expect(store.listControllerTurns("owner-7-controller", 10)).toHaveLength(0);
});

it("carries the album id on an album member's source record", async () => {
  const { store, ingress } = ingressFixture();
  await ingress.handleClaimed(update(9, {
    caption: "the three of them",
    media_group_id: "album-9",
    photo: [{ file_id: "p1", file_unique_id: "u7", width: 10, height: 10 }],
  } as never), NOW);

  const turn = store.getControllerTurn("controller-turn-9");
  expect(turn?.source).toMatchObject({ kind: "album", albumId: "album-9" });
  // An album member rides through the image path, so its photo is attached.
  expect(turn?.image).toMatchObject({ fileId: "p1" });
});
