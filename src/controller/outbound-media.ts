import { createHash } from "node:crypto";
import {
  CONTROLLER_MOTION_MIME_TYPES,
  CONTROLLER_STILL_MIME_TYPES,
  MAX_CONTROLLER_IMAGE_BYTES,
  MAX_CONTROLLER_VIDEO_BYTES,
} from "./models";

/**
 * What the agent is allowed to put in front of the owner, and as what.
 *
 * The owner works only from Telegram, so a screenshot of the thing being
 * described is often the shortest true answer available. But the bytes come off
 * a machine the plugin does not otherwise read, so the decision to send them is
 * made here, once, from the file's own extension and size — never from what the
 * agent claims about it.
 *
 * Deliberately narrow. This carries pictures of work, not an escape hatch for
 * moving files out of a host into a chat: an extension that is not a still or a
 * clip is refused, whatever it actually contains.
 */

/** Telegram renders these inline; anything else would arrive as a silent file. */
const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
});

export const MAX_OUTBOUND_CAPTION = 1_024;

export type OutboundMediaField = "photo" | "video";

export type OutboundMediaPlan = Readonly<{
  field: OutboundMediaField;
  mimeType: string;
  filename: string;
  maxBytes: number;
}>;

export type OutboundMediaRefusal = Readonly<{ reason: string }>;

export type OutboundMediaDecision =
  | Readonly<{ ok: true; plan: OutboundMediaPlan }>
  | Readonly<{ ok: false; refusal: OutboundMediaRefusal }>;

/**
 * A `gif` is a still by extension but Telegram treats it as an animation, so it
 * goes out as a video. Sending it as a photo would deliver a frozen frame.
 */
function fieldFor(mimeType: string): OutboundMediaField {
  return (CONTROLLER_STILL_MIME_TYPES as readonly string[]).includes(mimeType) && mimeType !== "image/gif"
    ? "photo"
    : "video";
}

function extensionOf(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * The name Telegram shows. Reduced to one path segment so a caption cannot leak
 * the directory layout of the owner's machine, and to characters that survive a
 * multipart filename intact.
 */
export function outboundFilename(path: string): string {
  const base = path.split("/").pop() ?? "attachment";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "").slice(0, 96);
  return safe.length === 0 ? "attachment" : safe;
}

/**
 * Decides from the path alone, before any bytes are read, so an oversized or
 * unsupported file costs nothing to refuse. `sizeBytes` is checked separately
 * by `withinOutboundLimit` once the read reports it.
 */
export function planOutboundMedia(path: string): OutboundMediaDecision {
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, refusal: { reason: "The attachment path is empty." } };
  }
  if (!path.startsWith("/")) {
    return { ok: false, refusal: { reason: "The attachment path must be absolute." } };
  }
  if (path.includes("\0") || path.split("/").includes("..")) {
    return { ok: false, refusal: { reason: "The attachment path is not a plain absolute path." } };
  }
  const extension = extensionOf(path);
  const mimeType = extension === null ? undefined : EXTENSION_MIME_TYPES[extension];
  if (mimeType === undefined) {
    return {
      ok: false,
      refusal: {
        reason: "Only screenshots and screen recordings can be sent: "
          + `${Object.keys(EXTENSION_MIME_TYPES).join(", ")}.`,
      },
    };
  }
  const field = fieldFor(mimeType);
  return {
    ok: true,
    plan: {
      field,
      mimeType,
      filename: outboundFilename(path),
      maxBytes: (CONTROLLER_MOTION_MIME_TYPES as readonly string[]).includes(mimeType) || mimeType === "image/gif"
        ? MAX_CONTROLLER_VIDEO_BYTES
        : MAX_CONTROLLER_IMAGE_BYTES,
    },
  };
}

export function withinOutboundLimit(plan: OutboundMediaPlan, sizeBytes: number): boolean {
  return Number.isFinite(sizeBytes) && sizeBytes > 0 && sizeBytes <= plan.maxBytes;
}

/**
 * Distinguishes one queued picture from another. Deriving it from the file and
 * caption means an agent that asks for the same picture twice in a turn queues
 * it once, while a genuinely different picture is never collapsed into it.
 */
export function mediaKey(path: string, caption: string | null): string {
  return createHash("sha256").update(`${path}\0${caption ?? ""}`, "utf8").digest("hex").slice(0, 32);
}

/** Telegram rejects a caption over its own ceiling, which would lose the message. */
export function boundedCaption(caption: string | null): string | null {
  if (caption === null) return null;
  const trimmed = caption.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= MAX_OUTBOUND_CAPTION
    ? trimmed
    : `${trimmed.slice(0, MAX_OUTBOUND_CAPTION - 1)}…`;
}
