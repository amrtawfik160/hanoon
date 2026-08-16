import { expect, it } from "vitest";
import { CAPTIONLESS_CLIP_PROMPT, CAPTIONLESS_IMAGE_PROMPT, captionlessPromptFor, controllerImageFromMessage } from "../src/telegram/image";
import type { TelegramMessage } from "../src/telegram/types";

function message(overrides: Partial<TelegramMessage>): TelegramMessage {
  return {
    message_id: 1,
    from: { id: 7, is_bot: false },
    chat: { id: 70, type: "private" },
    ...overrides,
  } as TelegramMessage;
}

it("reads Telegram GIFs and videos that used to be dropped", () => {
  expect(controllerImageFromMessage(message({
    animation: {
      file_id: "anim",
      file_unique_id: "anim-id",
      width: 100,
      height: 100,
      duration: 1,
      mime_type: "video/mp4",
      file_size: 50_000,
    },
  }))).toMatchObject({ kind: "animation", fileId: "anim", mimeType: "video/mp4" });

  expect(controllerImageFromMessage(message({
    video: {
      file_id: "vid",
      file_unique_id: "vid-id",
      width: 100,
      height: 100,
      duration: 8,
      mime_type: "video/mp4",
      file_size: 90_000,
    },
  }))).toMatchObject({ kind: "video", fileId: "vid" });

  expect(controllerImageFromMessage(message({
    video_note: {
      file_id: "note",
      file_unique_id: "note-id",
      length: 240,
      duration: 4,
      file_size: 40_000,
    },
  }))).toMatchObject({ kind: "video", fileId: "note", mimeType: "video/mp4" });
});

it("treats an image/gif document as a clip, not a still photo", () => {
  const image = controllerImageFromMessage(message({
    document: {
      file_id: "gif-doc",
      file_unique_id: "gif-doc-id",
      mime_type: "image/gif",
      file_size: 20_000,
    },
  }));
  expect(image).toMatchObject({ kind: "animation", mimeType: "image/gif" });
  expect(captionlessPromptFor(image!)).toBe(CAPTIONLESS_CLIP_PROMPT);
});

it("keeps photos on the still prompt", () => {
  const image = controllerImageFromMessage(message({
    photo: [{
      file_id: "photo",
      file_unique_id: "photo-id",
      width: 10,
      height: 10,
    }],
  }));
  expect(image?.kind).toBe("image");
  expect(captionlessPromptFor(image!)).toBe(CAPTIONLESS_IMAGE_PROMPT);
});
