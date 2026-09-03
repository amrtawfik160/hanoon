import { describe, expect, it } from "vitest";
import { controllerDocumentFromMessage } from "../src/telegram/document";
import { controllerSourceFromMessage } from "../src/telegram/source";
import type { TelegramMessage } from "../src/telegram/types";

function message(overrides: Record<string, unknown> = {}): TelegramMessage {
  return {
    message_id: 1,
    from: { id: 7, is_bot: false, first_name: "Owner" },
    chat: { id: 7, type: "private" },
    ...overrides,
  } as TelegramMessage;
}

describe("controllerDocumentFromMessage", () => {
  it("accepts a PDF document", () => {
    const result = controllerDocumentFromMessage(message({
      document: {
        file_id: "pdf-1",
        file_unique_id: "u1",
        file_name: "architecture-review.pdf",
        mime_type: "application/pdf",
        file_size: 40_000,
      },
    }));
    expect(result).toEqual({
      status: "accepted",
      document: {
        fileId: "pdf-1",
        fileName: "architecture-review.pdf",
        mimeType: "application/pdf",
        sizeBytes: 40_000,
      },
    });
  });

  it("accepts a markdown file by extension when the mime type is generic", () => {
    const result = controllerDocumentFromMessage(message({
      document: {
        file_id: "md-1",
        file_unique_id: "u2",
        file_name: "brief.md",
        mime_type: "application/octet-stream",
      },
    }));
    expect(result).toMatchObject({
      status: "accepted",
      document: { fileName: "brief.md", mimeType: "text/markdown", sizeBytes: null },
    });
  });

  it("accepts a plain-text file", () => {
    const result = controllerDocumentFromMessage(message({
      document: {
        file_id: "txt-1",
        file_unique_id: "u3",
        file_name: "notes.txt",
        mime_type: "text/plain",
        file_size: 10,
      },
    }));
    expect(result).toMatchObject({ status: "accepted", document: { mimeType: "text/plain" } });
  });

  it("refuses an unsupported document type by name", () => {
    const result = controllerDocumentFromMessage(message({
      document: {
        file_id: "zip-1",
        file_unique_id: "u4",
        file_name: "archive.zip",
        mime_type: "application/zip",
      },
    }));
    expect(result).toEqual({ status: "unsupported" });
  });

  it("refuses an oversized document before queueing", () => {
    const result = controllerDocumentFromMessage(message({
      document: {
        file_id: "pdf-big",
        file_unique_id: "u5",
        file_name: "big.pdf",
        mime_type: "application/pdf",
        file_size: 21 * 1024 * 1024,
      },
    }));
    expect(result).toEqual({ status: "oversized" });
  });

  it("returns null for a message without a document", () => {
    expect(controllerDocumentFromMessage(message())).toBeNull();
    expect(controllerDocumentFromMessage(message({ photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }] }))).toBeNull();
  });
});

describe("controllerSourceFromMessage", () => {
  it("records nothing for a plain owner message", () => {
    expect(controllerSourceFromMessage(message({ text: "hello" }))).toBeNull();
  });

  it("records the forwarded sender's name", () => {
    const source = controllerSourceFromMessage(message({
      text: "forwarded words",
      forward_origin: { type: "user", date: 1, sender_user: { id: 5, is_bot: false, first_name: "Tom", last_name: "Counsell" } },
    }));
    expect(source).toMatchObject({ kind: "forwarded", forwardedFrom: "Tom Counsell", forwardedHidden: false });
  });

  it("marks a forward whose sender hid their identity", () => {
    const source = controllerSourceFromMessage(message({
      text: "mysterious",
      forward_origin: { type: "hidden_user", date: 1 },
    }));
    expect(source).toMatchObject({ kind: "forwarded", forwardedFrom: null, forwardedHidden: true });
  });

  it("uses the chat title when a message is forwarded from a chat or channel", () => {
    const chatSource = controllerSourceFromMessage(message({
      text: "from a chat",
      forward_origin: { type: "chat", date: 1, sender_chat: { id: 9, type: "group", title: "Launch Crew" } },
    }));
    expect(chatSource).toMatchObject({ kind: "forwarded", forwardedFrom: "Launch Crew" });
    const channelSource = controllerSourceFromMessage(message({
      text: "from a channel",
      forward_origin: { type: "channel", date: 1, chat: { id: 10, type: "channel", title: "Cyndra News" } },
    }));
    expect(channelSource).toMatchObject({ kind: "forwarded", forwardedFrom: "Cyndra News" });
  });

  it("records the quoted author and text of a reply", () => {
    const source = controllerSourceFromMessage(message({
      text: "and my answer",
      reply_to_message: {
        message_id: 44,
        from: { id: 5, is_bot: false, first_name: "Tom", last_name: "Counsell" },
        text: "the original words",
      },
    }));
    expect(source).toMatchObject({
      kind: "reply",
      quotedAuthor: "Tom Counsell",
      quotedText: "the original words",
      quotedFromAgent: false,
      replyToMessageId: 44,
    });
  });

  it("marks a reply to the agent's own message", () => {
    const source = controllerSourceFromMessage(message({
      text: "not that one",
      reply_to_message: { message_id: 12, from: { id: 42, is_bot: true, first_name: "Hanoon" } },
    }));
    expect(source).toMatchObject({ kind: "reply", quotedFromAgent: true, quotedAuthor: null });
  });

  it("records the album id of a media group", () => {
    const source = controllerSourceFromMessage(message({
      caption: "a photo",
      photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }],
      media_group_id: "album-9",
    }));
    expect(source).toMatchObject({ kind: "album", albumId: "album-9" });
  });

  it("bounds the quoted text", () => {
    const source = controllerSourceFromMessage(message({
      text: "reply",
      reply_to_message: { message_id: 1, text: "q".repeat(2_000) },
    }));
    expect(source?.quotedText).toHaveLength(500);
  });

  it("keeps a forwarded reply's provenance on both fields", () => {
    const source = controllerSourceFromMessage(message({
      text: "forwarded reply",
      forward_origin: { type: "user", date: 1, sender_user: { id: 5, is_bot: false, first_name: "Tom" } },
      reply_to_message: { message_id: 44, text: "earlier" },
    }));
    expect(source).toMatchObject({ kind: "forwarded", forwardedFrom: "Tom", replyToMessageId: 44, quotedText: "earlier" });
  });
});
