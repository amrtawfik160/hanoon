import {
  CONTROLLER_MOTION_MIME_TYPES,
  CONTROLLER_STILL_MIME_TYPES,
  MAX_CONTROLLER_VIDEO_BYTES,
  type ControllerImage,
  type ControllerImageThumbnail,
  type ControllerMediaKind,
  type ControllerMediaMimeType,
  type ControllerMotionMimeType,
} from "../controller/models";
import type { TelegramMessage } from "./types";

export const CAPTIONLESS_IMAGE_PROMPT = "Please inspect this image.";
export const CAPTIONLESS_CLIP_PROMPT = "Please inspect this clip.";

const STILL_EXTENSIONS: Record<(typeof CONTROLLER_STILL_MIME_TYPES)[number], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const MOTION_EXTENSIONS: Record<ControllerMotionMimeType, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

function stillMimeType(value: string | undefined): (typeof CONTROLLER_STILL_MIME_TYPES)[number] | null {
  const normalized = value?.toLowerCase();
  return CONTROLLER_STILL_MIME_TYPES.find((candidate) => candidate === normalized) ?? null;
}

function motionMimeType(value: string | undefined): ControllerMotionMimeType | null {
  const normalized = value?.toLowerCase();
  return CONTROLLER_MOTION_MIME_TYPES.find((candidate) => candidate === normalized) ?? null;
}

function safeUniqueId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 160);
  return normalized.length > 0 ? normalized : "image";
}

function stillFileName(fileUniqueId: string, mimeType: (typeof CONTROLLER_STILL_MIME_TYPES)[number]): string {
  return `telegram-${safeUniqueId(fileUniqueId)}.${STILL_EXTENSIONS[mimeType]}`;
}

function motionFileName(fileUniqueId: string, mimeType: ControllerMotionMimeType): string {
  return `telegram-${safeUniqueId(fileUniqueId)}.${MOTION_EXTENSIONS[mimeType]}`;
}

function largestPhoto(message: TelegramMessage): NonNullable<TelegramMessage["photo"]>[number] | null {
  if (!message.photo) return null;
  return message.photo.reduce((largest, candidate) => {
    const largestArea = largest.width * largest.height;
    const candidateArea = candidate.width * candidate.height;
    if (candidateArea !== largestArea) return candidateArea > largestArea ? candidate : largest;
    return (candidate.file_size ?? 0) > (largest.file_size ?? 0) ? candidate : largest;
  });
}

function thumbnailFrom(
  photo: { file_id: string; file_unique_id: string; file_size?: number } | undefined,
): ControllerImageThumbnail | null {
  if (!photo) return null;
  return {
    fileId: photo.file_id,
    fileName: stillFileName(photo.file_unique_id, "image/jpeg"),
    sizeBytes: photo.file_size ?? null,
  };
}

function reportedSize(size: number | undefined): number | null {
  return size === undefined ? null : size;
}

function media(input: {
  kind: ControllerMediaKind;
  fileId: string;
  fileName: string;
  mimeType: ControllerMediaMimeType;
  sizeBytes: number | null;
  durationSeconds?: number | null;
  thumbnail?: ControllerImageThumbnail | null;
}): ControllerImage {
  return {
    kind: input.kind,
    fileId: input.fileId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    durationSeconds: input.durationSeconds ?? null,
    thumbnail: input.thumbnail ?? null,
  };
}

export function captionlessPromptFor(image: ControllerImage): string {
  return image.kind === "image" ? CAPTIONLESS_IMAGE_PROMPT : CAPTIONLESS_CLIP_PROMPT;
}

export function clipTooLargeForDownload(image: ControllerImage): boolean {
  return image.sizeBytes !== null && image.sizeBytes > MAX_CONTROLLER_VIDEO_BYTES;
}

export function controllerImageFromMessage(message: TelegramMessage): ControllerImage | null {
  const photo = largestPhoto(message);
  if (photo) {
    return media({
      kind: "image",
      fileId: photo.file_id,
      fileName: stillFileName(photo.file_unique_id, "image/jpeg"),
      mimeType: "image/jpeg",
      sizeBytes: reportedSize(photo.file_size),
    });
  }

  const animation = message.animation;
  if (animation) {
    const mimeType = stillMimeType(animation.mime_type) ?? motionMimeType(animation.mime_type) ?? "video/mp4";
    return media({
      kind: "animation",
      fileId: animation.file_id,
      fileName: mimeType.startsWith("image/")
        ? stillFileName(animation.file_unique_id, mimeType as (typeof CONTROLLER_STILL_MIME_TYPES)[number])
        : motionFileName(animation.file_unique_id, mimeType as ControllerMotionMimeType),
      mimeType,
      sizeBytes: reportedSize(animation.file_size),
      durationSeconds: animation.duration,
      thumbnail: thumbnailFrom(animation.thumbnail),
    });
  }

  const video = message.video;
  if (video) {
    const mimeType = motionMimeType(video.mime_type) ?? "video/mp4";
    return media({
      kind: "video",
      fileId: video.file_id,
      fileName: motionFileName(video.file_unique_id, mimeType),
      mimeType,
      sizeBytes: reportedSize(video.file_size),
      durationSeconds: video.duration,
      thumbnail: thumbnailFrom(video.thumbnail),
    });
  }

  const videoNote = message.video_note;
  if (videoNote) {
    return media({
      kind: "video",
      fileId: videoNote.file_id,
      fileName: motionFileName(videoNote.file_unique_id, "video/mp4"),
      mimeType: "video/mp4",
      sizeBytes: reportedSize(videoNote.file_size),
      durationSeconds: videoNote.duration,
      thumbnail: thumbnailFrom(videoNote.thumbnail),
    });
  }

  const document = message.document;
  const documentStill = stillMimeType(document?.mime_type);
  if (document && documentStill) {
    return media({
      kind: documentStill === "image/gif" ? "animation" : "image",
      fileId: document.file_id,
      fileName: stillFileName(document.file_unique_id, documentStill),
      mimeType: documentStill,
      sizeBytes: reportedSize(document.file_size),
    });
  }

  const documentMotion = motionMimeType(document?.mime_type);
  if (document && documentMotion) {
    return media({
      kind: "video",
      fileId: document.file_id,
      fileName: motionFileName(document.file_unique_id, documentMotion),
      mimeType: documentMotion,
      sizeBytes: reportedSize(document.file_size),
    });
  }

  return null;
}
