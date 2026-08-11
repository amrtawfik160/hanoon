import {
  CONTROLLER_IMAGE_MIME_TYPES,
  type ControllerImage,
  type ControllerImageMimeType,
} from "../controller/models";
import type { TelegramMessage } from "./types";

export const CAPTIONLESS_IMAGE_PROMPT = "Please inspect this image.";

const MIME_TYPE_EXTENSIONS: Record<ControllerImageMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function imageMimeType(value: string | undefined): ControllerImageMimeType | null {
  const normalized = value?.toLowerCase();
  return CONTROLLER_IMAGE_MIME_TYPES.find((candidate) => candidate === normalized) ?? null;
}

function safeUniqueId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 160);
  return normalized.length > 0 ? normalized : "image";
}

function fileName(fileUniqueId: string, mimeType: ControllerImageMimeType): string {
  return `telegram-${safeUniqueId(fileUniqueId)}.${MIME_TYPE_EXTENSIONS[mimeType]}`;
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

export function controllerImageFromMessage(message: TelegramMessage): ControllerImage | null {
  const photo = largestPhoto(message);
  if (photo) {
    return {
      fileId: photo.file_id,
      fileName: fileName(photo.file_unique_id, "image/jpeg"),
      mimeType: "image/jpeg",
      sizeBytes: photo.file_size ?? null,
    };
  }

  const document = message.document;
  const mimeType = imageMimeType(document?.mime_type);
  if (!document || !mimeType) return null;
  return {
    fileId: document.file_id,
    fileName: fileName(document.file_unique_id, mimeType),
    mimeType,
    sizeBytes: document.file_size ?? null,
  };
}
