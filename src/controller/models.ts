import { CONTROLLER_PROOF_KINDS } from "./proof-kinds.js";
import type { SupervisorReason } from "./supervisor";

export type ControllerThreadState = "pending_spawn" | "active" | "failed" | "revoked";
export type ControllerTurnState = "queued" | "dispatching" | "submitted" | "completed" | "failed";
export type ControllerDeliveryState = "none" | "intent" | "delivery_unknown";
export type ControllerDispatchKind = "send" | "spawn";
export type ControllerCapabilityContinuationState = "requested" | "relaunching" | "resolved" | "blocked";
export { CONTROLLER_PROOF_KINDS } from "./proof-kinds.js";
export type ControllerProofKind = (typeof CONTROLLER_PROOF_KINDS)[number];
export const CONTROLLER_STILL_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;
export const CONTROLLER_MOTION_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
] as const;
export const CONTROLLER_IMAGE_MIME_TYPES = CONTROLLER_STILL_MIME_TYPES;
export const CONTROLLER_MEDIA_MIME_TYPES = [
  ...CONTROLLER_STILL_MIME_TYPES,
  ...CONTROLLER_MOTION_MIME_TYPES,
] as const;
/** Document types a burst may carry; anything else is refused at intake. */
export const CONTROLLER_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "text/markdown",
  "text/plain",
] as const;
export type ControllerDocumentMimeType = (typeof CONTROLLER_DOCUMENT_MIME_TYPES)[number];
export const MAX_CONTROLLER_IMAGE_BYTES = 10 * 1024 * 1024;
/** Telegram Bot API `getFile` ceiling. Larger clips stay queued and use the preview still. */
export const MAX_CONTROLLER_VIDEO_BYTES = 20 * 1024 * 1024;
/** Largest size Telegram may report that we still persist. Download stays at the getFile ceiling. */
export const MAX_PERSISTED_MEDIA_BYTES = 50 * 1024 * 1024;
export type ControllerImageMimeType = (typeof CONTROLLER_STILL_MIME_TYPES)[number];
export type ControllerMotionMimeType = (typeof CONTROLLER_MOTION_MIME_TYPES)[number];
export type ControllerMediaMimeType = (typeof CONTROLLER_MEDIA_MIME_TYPES)[number];
export type ControllerMediaKind = "image" | "animation" | "video";
/** Per-file cap for documents; BB's attachment limit sits above it. */
export const MAX_CONTROLLER_DOCUMENT_BYTES = 20 * 1024 * 1024;
/** Text documents at or below this size are also inlined into the dispatch text. */
export const CONTROLLER_DOCUMENT_INLINE_MAX_CHARS = 64_000;

/** PDFs are attached for the agent's own tools; text types can be inlined. */
export function isTextDocument(mimeType: ControllerDocumentMimeType): boolean {
  return mimeType !== "application/pdf";
}

export type ControllerDocument = {
  fileId: string;
  fileName: string;
  mimeType: ControllerDocumentMimeType;
  sizeBytes: number | null;
};

/** One file a dispatch carries, gathered across every member of its burst. */
export type ControllerAttachment = {
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
  kind: ControllerMediaKind | "document";
  /**
   * The file's contents when the dispatcher already fetched them to inline the
   * document; the adapter then uploads these instead of downloading again.
   * Dispatch-time only: never persisted.
   */
  bytes?: Uint8Array;
};

export type ControllerImageThumbnail = {
  fileId: string;
  fileName: string;
  sizeBytes: number | null;
};
export type ControllerImage = {
  fileId: string;
  fileName: string;
  mimeType: ControllerMediaMimeType;
  sizeBytes: number | null;
  kind?: ControllerMediaKind;
  durationSeconds?: number | null;
  thumbnail?: ControllerImageThumbnail | null;
};

export function normalizeControllerImage(image: ControllerImage): Required<ControllerImage> {
  return {
    fileId: image.fileId,
    fileName: image.fileName,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    kind: image.kind ?? "image",
    durationSeconds: image.durationSeconds ?? null,
    thumbnail: image.thumbnail ?? null,
  };
}

export function isMotionMedia(image: Pick<ControllerImage, "kind" | "mimeType">): boolean {
  return image.kind === "animation" || image.kind === "video" ||
    (CONTROLLER_MOTION_MIME_TYPES as readonly string[]).includes(image.mimeType);
}

export function controllerDownloadLimitBytes(image: Pick<ControllerImage, "kind" | "mimeType">): number {
  return isMotionMedia(image) ? MAX_CONTROLLER_VIDEO_BYTES : MAX_CONTROLLER_IMAGE_BYTES;
}

export function controllerAttachmentDownloadLimitBytes(attachment: ControllerAttachment): number {
  if (attachment.kind === "document") return MAX_CONTROLLER_DOCUMENT_BYTES;
  return controllerDownloadLimitBytes({ kind: attachment.kind, mimeType: attachment.mimeType as ControllerMediaMimeType });
}

/** Every file a turn carries, in a single dispatch-shaped list. */
export function controllerAttachmentsForTurn(
  turn: Pick<ControllerTurnRecord, "image" | "document">,
): ControllerAttachment[] {
  const attachments: ControllerAttachment[] = [];
  if (turn.image) {
    attachments.push({
      fileId: turn.image.fileId,
      fileName: turn.image.fileName,
      mimeType: turn.image.mimeType,
      sizeBytes: turn.image.sizeBytes,
      kind: turn.image.kind ?? "image",
    });
  }
  if (turn.document) {
    attachments.push({
      fileId: turn.document.fileId,
      fileName: turn.document.fileName,
      mimeType: turn.document.mimeType,
      sizeBytes: turn.document.sizeBytes,
      kind: "document",
    });
  }
  return attachments;
}
/**
 * Structured provenance for one owner message, persisted per turn so a burst
 * can be rendered as one attributed transcript. Nothing here contains file
 * bytes, tokens, or callback data.
 */
/** Bounds a source record's strings share at intake, on write, and on read. */
export const CONTROLLER_SOURCE_NAME_MAX_CHARS = 256;
export const CONTROLLER_SOURCE_QUOTE_MAX_CHARS = 500;
export const CONTROLLER_SOURCE_ALBUM_ID_MAX_CHARS = 128;

export type ControllerTurnSource = {
  kind: "owner" | "forwarded" | "reply" | "album";
  /** Forwarded sender's display name or chat title, when Telegram supplies one. */
  forwardedFrom: string | null;
  /** True when the sender chose to hide their identity. */
  forwardedHidden: boolean;
  /** The quoted message's author, when Telegram supplies one. */
  quotedAuthor: string | null;
  /** True when the quoted message is the agent's own. */
  quotedFromAgent: boolean;
  quotedText: string | null;
  replyToMessageId: number | null;
  albumId: string | null;
};

export type ControllerStreamPhase =
  | "queued"
  | "connecting"
  | "thinking"
  | "using_tools"
  | "responding"
  | "complete"
  | "failed";

/**
 * The only text a live controller draft may ever carry. A draft is a progress
 * placeholder derived from the observed phase, never raw provider prose: raw
 * assistant output and the legacy pre-cutover `stream_text` value must never
 * surface as a draft, digest, final-answer outbox, or completed response.
 */
export const CONTROLLER_PHASE_TEXT: Readonly<Record<ControllerStreamPhase, string>> = {
  queued: "Queued…",
  connecting: "Connecting to Hanoon…",
  thinking: "Hanoon is thinking…",
  using_tools: "Hanoon is checking the current state…",
  responding: "Hanoon is preparing the answer…",
  complete: "Hanoon finished.",
  failed: "Hanoon could not finish safely.",
};

export type ControllerThreadRecord = {
  controllerKey: string;
  telegramUserId: string;
  telegramChatId: string;
  projectId: string | null;
  hostId: string | null;
  threadId: string | null;
  state: ControllerThreadState;
  pendingSpawnToken: string | null;
  /** Logical turn whose immutable profile configured the live provider session. */
  capabilitySubjectId: string | null;
  capabilityProfileId: string | null;
  capabilityProfileRevision: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ControllerTurnRecord = {
  id: string;
  updateId: number;
  controllerKey: string;
  ordinal: number;
  inputText: string;
  image: ControllerImage | null;
  document: ControllerDocument | null;
  /** Structured provenance for the transcript; null for turns without one. */
  source: ControllerTurnSource | null;
  /** Leader turn whose burst this turn folded into; null for leaders and singles. */
  burstLeaderTurnId: string | null;
  state: ControllerTurnState;
  leaseOwner: string | null;
  leaseGeneration: number | null;
  dispatchAfterSeq: number;
  /** Write-ahead state for the provider mutation represented by this turn. */
  deliveryState: ControllerDeliveryState;
  dispatchKind: ControllerDispatchKind | null;
  dispatchCorrelationId: string | null;
  /** Capped pre-dispatch backoff level, separate from media retries. */
  dispatchRetryCount: number;
  /** Exact-delivery reconciliation attempts after a provider result became ambiguous. */
  deliveryReconcileAttempts: number;
  /** When the owner was told once that a persistently busy thread still holds this input. */
  busyWaitNotifiedAt: number | null;
  nextDispatchAt: number;
  retryCount: number;
  /** Zero is the primary model; one and two select the ordered fallback slots. */
  modelFallbackIndex: number;
  bbEventSeq: number;
  evidenceEventSeq: number;
  completionContinuations: number;
  acceptedFinalizationId: number | null;
  /** Whether the provider durably acknowledged this generation's input. */
  inputAccepted: boolean;
  /** Private, bounded recovery material; never owner-visible. */
  privateDraftItemId: string | null;
  privateDraftText: string;
  /** Prior turn whose exact receipts protect an ambiguously steered message. */
  recoverySourceTurnId: string | null;
  evidenceLimitExceededAt: number | null;
  streamText: string;
  telegramMessageId: number | null;
  streamPhase: ControllerStreamPhase;
  responseText: string | null;
  lastError: string | null;
  submittedAt: number | null;
  completedAt: number | null;
  /** Set while the answer is blocked on a question the owner has to settle. */
  awaitingInteractionId: string | null;
  /** Tool-shaped item starts observed so far on this turn. */
  toolCalls: number;
  /** Non-zero command exits observed so far on this turn. */
  commandFailures: number;
  /** Highest cumulative thread token total observed on this turn. */
  totalTokens: number;
  /** The thread's cumulative token total before this turn began, so spend can
   *  be measured for the turn rather than for the thread's whole lifetime. */
  tokenBaseline: number | null;
  /** `system` marks a turn the plugin raised itself — a fired monitor or a
   *  delegation join — which must never be read as the owner reacting. */
  origin: "owner" | "system";
  /** Exact immutable profile revision selected for this logical turn. */
  capabilityProfileId: string | null;
  capabilityProfileRevision: number;
  /** Revision proven at the provider-session boundary. */
  capabilityConfiguredRevision: number;
  /** A logical turn may cross at most one capability relaunch boundary. */
  capabilityContinuationCount: number;
  capabilityContinuationState: ControllerCapabilityContinuationState | null;
  supervisorSteers: number;
  supervisorReasons: readonly SupervisorReason[];
  createdAt: number;
  updatedAt: number;
};

export type ControllerLeaseFence = {
  ownerId: string;
  generation: number;
  now: number;
};
