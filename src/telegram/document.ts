import {
  CONTROLLER_DOCUMENT_MIME_TYPES,
  MAX_CONTROLLER_DOCUMENT_BYTES,
  type ControllerDocument,
  type ControllerDocumentMimeType,
} from "../controller/models";
import type { TelegramMessage } from "./types";

export const CAPTIONLESS_DOCUMENT_PROMPT = "Please read this file.";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const TEXT_EXTENSIONS = new Set(["txt", "text"]);

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

function mimeTypeFor(fileName: string, reported: string | undefined): ControllerDocumentMimeType | null {
  const normalized = reported?.toLowerCase();
  const supported = CONTROLLER_DOCUMENT_MIME_TYPES.find((candidate) => candidate === normalized);
  if (supported) return supported;
  // Telegram reports generic mime types for some uploads; the file extension
  // decides whether a generic attachment is still a readable document.
  if (normalized === undefined || normalized === "application/octet-stream" || normalized === "") {
    const extension = extensionOf(fileName);
    if (extension === "pdf") return "application/pdf";
    if (MARKDOWN_EXTENSIONS.has(extension)) return "text/markdown";
    if (TEXT_EXTENSIONS.has(extension)) return "text/plain";
  }
  return null;
}

export type ControllerDocumentExtraction =
  | { status: "accepted"; document: ControllerDocument }
  | { status: "unsupported" }
  | { status: "oversized" };

/**
 * Reads the document attachment off a Telegram message. Only PDF, Markdown,
 * and plain text are accepted; anything else — and anything over the size cap —
 * is refused by name so the owner hears one plain reply instead of silence.
 */
export function controllerDocumentFromMessage(message: TelegramMessage): ControllerDocumentExtraction | null {
  const document = message.document;
  if (!document) return null;
  const fileName = document.file_name ?? "document";
  const mimeType = mimeTypeFor(fileName, document.mime_type);
  if (mimeType === null) return { status: "unsupported" };
  const sizeBytes = document.file_size ?? null;
  if (sizeBytes !== null && sizeBytes > MAX_CONTROLLER_DOCUMENT_BYTES) {
    return { status: "oversized" };
  }
  return {
    status: "accepted",
    document: {
      fileId: document.file_id,
      fileName,
      mimeType,
      sizeBytes,
    },
  };
}
