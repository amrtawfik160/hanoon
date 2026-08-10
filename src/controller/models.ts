export type ControllerThreadState = "pending_spawn" | "active" | "failed" | "revoked";
export type ControllerTurnState = "queued" | "dispatching" | "submitted" | "completed" | "failed";
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
  createdAt: number;
  updatedAt: number;
};

export type ControllerLeaseFence = {
  ownerId: string;
  generation: number;
  now: number;
};
