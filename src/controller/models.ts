import type { SupervisorReason } from "./supervisor";

export type ControllerThreadState = "pending_spawn" | "active" | "failed" | "revoked";
export type ControllerTurnState = "queued" | "dispatching" | "submitted" | "completed" | "failed";
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
