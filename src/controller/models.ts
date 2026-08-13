import { CONTROLLER_PROOF_KINDS } from "./proof-kinds.js";
import type { SupervisorReason } from "./supervisor";

export type ControllerThreadState = "pending_spawn" | "active" | "failed" | "revoked";
export type ControllerTurnState = "queued" | "dispatching" | "submitted" | "completed" | "failed";
export { CONTROLLER_PROOF_KINDS } from "./proof-kinds.js";
export type ControllerProofKind = (typeof CONTROLLER_PROOF_KINDS)[number];
export const CONTROLLER_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;
export const MAX_CONTROLLER_IMAGE_BYTES = 10 * 1024 * 1024;
export type ControllerImageMimeType = (typeof CONTROLLER_IMAGE_MIME_TYPES)[number];
export type ControllerImage = {
  fileId: string;
  fileName: string;
  mimeType: ControllerImageMimeType;
  sizeBytes: number | null;
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
  state: ControllerTurnState;
  leaseOwner: string | null;
  leaseGeneration: number | null;
  dispatchAfterSeq: number;
  retryCount: number;
  bbEventSeq: number;
  evidenceEventSeq: number;
  completionContinuations: number;
  acceptedFinalizationId: number | null;
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
