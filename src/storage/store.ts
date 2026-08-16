import type { BbPluginApi } from "@bb/plugin-sdk";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  isResumablePermanentFailure,
  isReviewedPrCompletionBlock,
  PRODUCTION_NOT_CONFIGURED,
  projectPolicySchema,
  type Job,
  type JobEffect,
  type JobEvent,
  type JobState,
  type ProjectPolicy,
  type StoredEffect,
  type WorkerLiveness,
  type WorkerKind,
  type WorkerRecoveryClassification,
} from "../domain/models";
import type { MergeAuthorityGrant } from "../services/merge-authority";
import { classifyTaskTraits } from "../capabilities/routing";
import {
  controllerBundleIdsFromProfile,
  CONTROLLER_BUNDLE_IDS,
  DEFAULT_CONTROLLER_CAPABILITY_MODEL,
  expandControllerCapabilityProfile,
  selectControllerCapabilityProfile,
  type ControllerToolBundleId,
} from "../capabilities/controller-bundles";
import type { ModelRoute } from "../capabilities/models";
import {
  routingModeForNewAttempt,
  type AppendRecipeRolloutDecisionInput,
  type CapabilityJobGraphMode,
  type RecipeRolloutDecision,
} from "../capabilities/promotion";
import type { TaskRecipe } from "../domain/recipes";
import type { CapabilityInventoryItem, InventoryHealth } from "../capabilities/inventory";
import { CAPABILITY_BY_ID } from "../capabilities/catalog";
import {
  nativeAdapterRequirementForEvent,
  validateNativeAdapterTransition,
  type NativeAdapterTransitionEnvelope,
} from "../capabilities/native-adapters";
import type {
  GuardFingerprintPersistenceInput,
  GuardSettlementPersistenceInput,
  GuardSettlementPersistenceResult,
} from "../capabilities/guards";
import {
  guardAssessmentPolicySchema,
  guardResultEnvelopeSchema,
} from "../capabilities/guards";
import {
  admissionAllowsEffect,
  isReleaseCandidate,
  isSafeControlEffect,
  projectResourceKey,
  productionResourceKey,
  repositoryMergeResourceKey,
  type AdmissionState,
  type JobAdmission,
  type JobResourceClaim,
  type ResourceKind,
} from "../autonomy/models";
import { reviewVerdictSchema } from "../domain/review";
import { assessReviewGroup } from "../domain/review-lenses";
import { formattedMessage, renderThreadInteractionRetired, renderThreadLifecycleNotice } from "../telegram/markdown";
import { renderJobFinishNote } from "../telegram/finish-note";
import {
  adjustedConfidence,
  decayedConfidence,
  ftsQuery,
  memoryScore,
  subjectsContradict,
  MEMORY_DEMOTION,
  MEMORY_REINFORCEMENT,
  MEMORY_TOMBSTONE_CONFIDENCE,
} from "./memory-ranking";
import { assertSafeFailureSummary, containsCredentialLikeText, transition } from "../domain/state-machine";
import { ALL_MIGRATIONS } from "./migrations";
import {
  CONTROLLER_MEDIA_MIME_TYPES,
  CONTROLLER_IMAGE_MIME_TYPES,
  CONTROLLER_PHASE_TEXT,
  MAX_CONTROLLER_IMAGE_BYTES,
  MAX_PERSISTED_MEDIA_BYTES,
  normalizeControllerImage,
  type ControllerDeliveryState,
  type ControllerDispatchKind,
  type ControllerImage,
  type ControllerLeaseFence,
  type ControllerMediaKind,
  type ControllerMediaMimeType,
  type ControllerThreadRecord,
  type ControllerThreadState,
  type ControllerTurnRecord,
  type ControllerTurnState,
} from "../controller/models";
import { SUPERVISOR_REASONS, type SupervisorReason } from "../controller/supervisor";
import { MAX_CONTROLLER_OVERLAY } from "../controller/instructions";
import { isUnsafeProviderText } from "../controller/credential-policy";
import {
  MAX_OWNER_REPLY_CHARS,
  THREAD_ASK_REDACTED,
  composeOwnerReply,
  normalizeThreadAsk,
  normalizeThreadName,
  type RecordedThreadAsk,
} from "../controller/thread-ask";
import {
  nextUnansweredQuestion,
  parseControllerInteraction,
  parseControllerInteractionResolution,
  questionOptionToken,
  renderControllerInteraction,
  renderThreadInteraction,
  parseThreadInteraction,
  type ThreadApprovalDecision,
  threadDecisionToken,
  type ControllerInteraction,
  type ControllerQuestionAnswers,
  type ControllerQuestion,
  type ThreadInteraction,
} from "../controller/questions";
import { routeThreadInteraction } from "../controller/interaction-routing";
import {
  JOB_SELECT,
  MAX_MERGE_RESULT_JSON,
  VersionConflictError,
  assertBoundedString,
  assertNoRawMergeCallback,
  assertSafeExternalHttpsUrl,
  parseJobRow as parseJob,
  parseStoredEffect as parseEffect,
  persistJobTransition,
  persistPendingEffects,
  readJobById,
  readJobBySourceUpdate,
  serializeBoundedJson,
  type EffectRow,
  type JobRow,
} from "./job-persistence";
import {
  AutonomyAdmissionConflictError,
  MAX_AUTONOMY_ROWS,
  AutonomyRepository,
  queueAdmissionInTransaction,
  type AdmissionAttempt,
  type AdmissionAttemptInput,
  type ClaimAdoptionInput,
  type AdmissionWriteInput,
  type JobContinuationCandidate,
} from "./autonomy-repository";
import {
  CapabilityRepository,
  type AppendCapabilityReceiptInput,
  type AppendCapabilityTerminalInput,
  type CapabilityProfile,
  type CapabilityReceipt,
  type CapabilitySubjectKind,
  type CreateCapabilityProfileInput,
  type ModelRouteTrial,
  type RecordModelRouteSelectionInput,
  type SettleModelRouteTrialInput,
  type SkillReceiptProjection,
} from "./capability-repository";
import {
  ControllerEvidenceRepository,
  type AcceptedControllerFinalization,
  type ControllerEvidenceInput,
  type ControllerEvidenceRecord,
  type ControllerToolReceiptSettlementInput,
  type ControllerEvidenceWrite,
  type ControllerFinalizationProposalInput,
  type ControllerFinalizationProposalResult,
  type ControllerNativeEvidenceInput,
  type ControllerNativeEvidenceWrite,
} from "./controller-evidence-repository";
import {
  ControllerInteractionRepository,
  type ControllerInteractionAnswer,
  type ControllerInteractionRecordOutcome,
  type ControllerInteractionDeliveryFence,
  type ControllerInteractionDelivery,
  type ControllerInteractionRecord,
} from "./controller-interaction-repository";

export type {
  ControllerInteractionAnswer,
  ControllerInteractionDelivery,
  ControllerInteractionRecord,
  ControllerInteractionStore,
} from "./controller-interaction-repository";

import {
  CredentialAccessRepository,
  type CredentialDiagnosticPrepareResult,
  type CredentialHealthReconcileInput,
  type CredentialHealthReconcileResult,
  type CredentialHealthRecord,
  type CredentialOperationCompleteInput,
  type CredentialOperationCompleteResult,
  type CredentialOperationRecord,
  type CredentialReceiptRecord,
  type CredentialVerificationCompleteInput,
  type CredentialVerificationCompleteResult,
  type CredentialVerificationPrepareInput,
  type CredentialVerificationPrepareResult,
} from "./credential-access-repository";
import {
  StageExecutionRepository,
  type RecordStageExecutionInput,
  type SettleStageExecutionInput,
  type StageExecutionRecord,
} from "./stage-execution-repository";
import type { BrokerBindingState, BrokerRequestEnvelope, CredentialBindingMetadata } from "../credentials/protocol";

/**
 * A tapped controller button. `replayed` is a Telegram redelivery of a callback
 * that was already settled, so it must neither answer again nor acknowledge
 * twice.
 */
export type ControllerInteractionCallbackAnswer =
  | { ok: true; interactionId: string; turnId: string }
  | { ok: false; reason: "stale" | "replayed" };

export { VersionConflictError, assertSafeExternalHttpsUrl };

type PluginStorage = BbPluginApi["storage"];
type SqliteDatabase = Database.Database;
type PluginKv = PluginStorage["kv"];
const CONTROLLER_INTERACTION_TAIL_ID = 29;
const CONTROLLER_GENERATION_CONSTRAINT_ID = 53;
const CONTROLLER_GENERATION_QUARANTINE_REASON = "ambiguous_open_generations";
const CONTROLLER_GENERATION_MISMATCH_REASON = "generation_mapping_mismatch";
const CONTROLLER_GENERATION_RECOVERY_ERROR = "Controller generation identity was ambiguous; owner input preserved for recovery";
const CONTROLLER_GENERATION_RECOVERY_END_REASON = "quarantined: ambiguous controller generation identity";
const RETIRED_CONTROLLER_INTERACTION_NOTICE = "This interaction is no longer available. Open BB to review it.";
const RETIRED_CONTROLLER_INTERACTION_PAYLOAD = JSON.stringify({
  text: RETIRED_CONTROLLER_INTERACTION_NOTICE,
  reply_markup: { inline_keyboard: [] },
  disable_web_page_preview: true,
});

type LegacyControllerQuestionRow = Readonly<{
  rowid: number;
  interaction_id: unknown;
  turn_id: unknown;
  controller_key: unknown;
  questions_json: unknown;
  state: unknown;
  answers_json: unknown;
  asked_at: unknown;
  answered_at: unknown;
}>;

export type CapabilityDispatchSettings = Readonly<{
  jobGraph: CapabilityJobGraphMode;
  controllerTools: "bundled" | "all-tools";
}>;

const DEFAULT_CAPABILITY_DISPATCH_SETTINGS: CapabilityDispatchSettings = Object.freeze({
  jobGraph: "adaptive",
  controllerTools: "bundled",
});

export type PairingResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing" | "expired" | "consumed" | "already_paired";
    };

export type Owner = { userId: string; chatId: string; pairedAt: number };
type TelegramIdentity = {
  botId: string;
  username: string;
  verifiedAt: number;
};
export type ProjectPolicyRecord = { policy: ProjectPolicy; version: number };
export type JobControlKind = "status" | "retry" | "cancel";

export type ControllerCapabilityExpansionResult =
  | Readonly<{
      outcome: "resume_required";
      continuationCount: 1;
      profile: CapabilityProfile;
      selectedBundleIds: readonly ControllerToolBundleId[];
    }>
  | Readonly<{ outcome: "denied"; reasonCode: string }>;

export type ReviewAdmissionResult =
  | { outcome: "queued"; admission: JobAdmission }
  | { outcome: "still_cleaning_up"; admission: JobAdmission }
  | { outcome: "unavailable" };

export type RetryJobResult =
  | { outcome: "retried"; job: Job; admission: JobAdmission }
  | { outcome: "queued"; job: Job; admission: JobAdmission }
  | { outcome: "unavailable" };

export type ThreadOperationKind = "steer_thread" | "stop_thread" | "retry_thread";
export type ThreadOperationState =
  | "confirmation_sending"
  | "awaiting_confirmation"
  | "confirmed"
  | "executing"
  | "completed"
  | "failed"
  | "expired";
export type ThreadOperation = {
  id: string;
  nonceHash: string;
  ownerUserId: string;
  ownerChatId: string;
  kind: ThreadOperationKind;
  threadId: string;
  text: string | null;
  state: ThreadOperationState;
  confirmationMessageId: number | null;
  expiresAt: number;
  confirmedAt: number | null;
  leaseOwner: string | null;
  leaseGeneration: number | null;
  leaseExpiresAt: number | null;
  result: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};
export type ThreadOperationConfirmResult =
  | { ok: true; operation: ThreadOperation }
  | { ok: false; reason: "missing" | "expired" | "consumed" };

export type OutboxInput = {
  logicalKey: string;
  chatId: string;
  messageId?: number | null;
  payload: Record<string, unknown>;
};

export type StoredOutbox = OutboxInput & {
  status: "pending" | "leased" | "sent" | "failed" | "dead";
  attempts: number;
  leaseOwner: string | null;
  leaseGeneration: number | null;
  leaseExpiresAt: number | null;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ApprovalIdentity = { userId: string; chatId: string };
export type ApprovalRecord = {
  jobId: string;
  headSha: string;
  expiresAt: number;
  jobVersion: number | null;
  ownerUserId: string | null;
  ownerChatId: string | null;
};
export type ApprovalState = ApprovalRecord & {
  consumedAt: number | null;
  outcome: string | null;
};
export type ApprovalConsumeResult =
  | { ok: true; jobId: string; headSha: string; expiresAt: number }
  | { ok: false; reason: "missing" | "expired" | "consumed" | "revoked" };
export type ApprovalAcceptResult =
  | { ok: true; jobId: string; headSha: string }
  | { ok: false; reason: "missing" | "expired" | "consumed" | "revoked" | "version_conflict" };
export type CallbackRecord = {
  callbackId: string;
  jobId: string | null;
  action: string;
  outcome: string;
  processedAt: number;
  approvalNonceHash: string | null;
  headSha: string | null;
  effectIdempotencyKey: string | null;
};

export type MergeCallbackIdentity = {
  approvalNonceHash: string;
  headSha: string;
  effectIdempotencyKey: string;
};

export type ToolReceiptKey = {
  turnId: string;
  toolName: string;
  argsSha256: string;
};

/**
 * `fresh` means nothing ran before. `completed` replays the previous result
 * instead of repeating the mutation. `interrupted` means an earlier attempt
 * started and never reported — the outcome is unknown and must be checked,
 * never blindly retried.
 */
export type ToolReceiptClaim =
  | { outcome: "fresh" }
  | { outcome: "completed"; result: string }
  | { outcome: "interrupted" }
  | { outcome: "finalized" }
  | { outcome: "fence_lost" };

export type ToolReceiptClaimInput = ToolReceiptKey & Readonly<{
  controllerKey: string;
  now: number;
  ownerId?: string;
  generation?: number;
}>;

export type ControllerFailureCode =
  | "unknown"
  | "stalled"
  | "budget_exceeded"
  | "oauth_expired"
  | "provider_rejected"
  | "recovery_exhausted"
  | "owner_message_delivery_uncertain"
  | "owner_message_delivery_exhausted"
  | "owner_message_delivery_unresolved"
  | "owner_message_waiting_for_fresh_generation"
  | "owner_message_requeued"
  | "image_preparation_failed";

export type ControllerDeliveryReconciliationResult = "pending" | "failed" | "recovery_required" | "stale";

export type ControllerGeneration = {
  id: string;
  controllerKey: string;
  threadId: string;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
};

export type MonitorKind = "thread_idle" | "schedule";
export type MonitorState = "armed" | "cancelled" | "done" | "failed";

export type MonitorRecord = {
  id: string;
  controllerKey: string;
  kind: MonitorKind;
  threadId: string | null;
  cron: string | null;
  instruction: string;
  state: MonitorState;
  /** Set when the plugin owns this monitor rather than the owner. */
  systemKey: string | null;
  dueAt: number | null;
  fireCount: number;
  lastFiredAt: number | null;
  lastError: string | null;
  /** When this watch's one stall report was sent, if its thread ever wedged. */
  stallNotifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type JobMemoryExtractionState = "pending" | "running" | "done" | "failed";

/**
 * One attempt to learn something durable from a finished job. Jobs are the only
 * place the plugin spends inference of its own, so this is deliberately rare:
 * a handful a day rather than one per message.
 */
export type JobMemoryExtractionRecord = {
  jobId: string;
  projectId: string;
  outcome: string;
  state: JobMemoryExtractionState;
  threadId: string | null;
  attempts: number;
  savedCount: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ProductionHealthState = "unknown" | "ok" | "failing";

export type ProductionHealthRecord = {
  projectId: string;
  state: ProductionHealthState;
  consecutiveFailures: number;
  lastSummary: string | null;
  lastCheckedAt: number | null;
  /** The last state the owner was actually told about. */
  reportedState: ProductionHealthState | null;
  reportedAt: number | null;
};

export type RegressionWatchRecord = {
  projectId: string;
  confirmedFailures: string[];
  reportedFailures: string[];
  flakyFailures: string[];
  lastSummary: string | null;
  lastCheckedAt: number | null;
  reportedAt: number | null;
};

export type MergeAuthorityEvent = {
  projectId: string;
  action: "granted" | "revoked" | "used";
  jobId: string | null;
  actorUserId: string | null;
  actorChatId: string | null;
  reason: string | null;
  occurredAt: number;
};

export type DelegationState = "open" | "fired" | "cancelled" | "failed";
export type DelegationThreadState = "running" | "finished" | "failed" | "missing";

export type DelegationThreadRecord = {
  threadId: string;
  projectId: string;
  title: string;
  state: DelegationThreadState;
  /** Bounded excerpt of the thread's final output; null until it settles. */
  summary: string | null;
  settledAt: number | null;
  /** When this member's stall was escalated, so it is escalated only once. */
  stallNotifiedAt: number | null;
};

/**
 * A fan-out with a join: several BB threads doing independent work, and one
 * instruction the agent wrote to its future self for when they all land.
 */
export type DelegationRecord = {
  id: string;
  controllerKey: string;
  instruction: string;
  state: DelegationState;
  /** Set once every member has been published; the join waits for it. */
  sealedAt: number | null;
  threads: readonly DelegationThreadRecord[];
  firedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MemoryKind = "preference" | "fact" | "decision" | "correction";

export type MemoryRecord = {
  id: string;
  scope: string;
  kind: MemoryKind;
  subject: string;
  body: string;
  importance: number;
  confidence: number;
  source: "owner" | "agent";
  /** Where an agent-written memory came from, e.g. "job_outcome". */
  origin: string | null;
  sourceTurnId: string | null;
  useCount: number;
  lastUsedAt: number | null;
  supersededBy: string | null;
  forgottenAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type MemoryInput = {
  scope: string;
  kind: MemoryKind;
  subject: string;
  body: string;
  importance?: number;
  confidence?: number;
  source: "owner" | "agent";
  /** Where an agent-written memory came from, e.g. "job_outcome". */
  origin?: string;
  sourceTurnId?: string;
  now: number;
};

/** One entry of an owner-supplied import file. Source and origin are fixed by
 *  the import itself, so a caller cannot present a file entry as agent-written. */
export type OwnerMemoryImportInput = {
  scope: string;
  kind: MemoryKind;
  subject: string;
  body: string;
  importance?: number;
  confidence?: number;
  now: number;
};

export type AttemptRecord = {
  id: string;
  jobId: string;
  kind: "implementation" | "review" | "validation";
  reviewLens: "quality" | "risk" | null;
  reviewStage: "review" | "final_review" | null;
  ordinal: number;
  threadId: string | null;
  headSha: string | null;
  handoffPath: string | null;
  handoffSha256: string | null;
  resultJson: string | null;
  completedAt: number | null;
};

export type ExecutorFence = Readonly<{
  ownerId: string;
  generation: number;
  now: number;
}>;

export type OutboxDeliveryFailureNoticeInput = ExecutorFence & Readonly<{
  logicalKey: string;
  error: string;
}>;

export type OutboxLeaseRenewalInput = ExecutorFence & Readonly<{
  logicalKey: string;
  leaseMs: number;
}>;

export type ExecutorEventInput = ExecutorFence & Readonly<{
  jobId: string;
  expectedVersion: number;
  event: JobEvent;
  nativeAdapter?: NativeAdapterTransitionEnvelope;
}>;

export type ExecutorAttemptInput = ExecutorFence & Readonly<{
  id: string;
  jobId: string;
  kind: AttemptRecord["kind"];
  /**
   * `"next"` allocates the next free ordinal for this job and kind inside the
   * insert's own transaction. Review attempts pass a number because their
   * ordinal is the review cycle and sibling lenses deliberately share it;
   * implementation attempts have no such meaning to carry, so they must not
   * pick a number outside the transaction that enforces its uniqueness.
   */
  ordinal: number | "next";
  headSha?: string | null;
  reviewLens?: AttemptRecord["reviewLens"];
  reviewStage?: AttemptRecord["reviewStage"];
}>;

export type ExecutorAttemptPatch = ExecutorFence & Readonly<{
  jobId?: string;
  attemptId: string;
  patch: {
    threadId?: string | null;
    headSha?: string | null;
    handoffPath?: string | null;
    handoffSha256?: string | null;
    result?: Record<string, unknown> | null;
    completedAt?: number | null;
  };
}>;

export type ControllerSteerReservation = Readonly<{
  controllerKey: string;
  runningTurnId: string;
  waitingTurnId: string;
  threadId: string;
  inputText: string | null;
  idempotencyKey: string;
}>;
export type ControllerSteerSettlement = "applied" | "not_applied" | "unknown";
export type ControllerSteerSettlementResult = "settled" | "stale";
export type ControllerSteerSettlementInput = ControllerLeaseFence & Readonly<{
  runningTurnId: string;
  waitingTurnId: string;
  controllerKey: string;
  outcome: ControllerSteerSettlement;
}>;

export type ControllerSupervisorSteerState = "pending" | "applied" | "unknown";
export type ControllerSupervisorSteerAttempt = Readonly<{
  turnId: string;
  controllerKey: string;
  reason: SupervisorReason;
  threadId: string;
  inputText: string;
  idempotencyKey: string;
  state: ControllerSupervisorSteerState;
  createdAt: number;
  settledAt: number | null;
}>;
export type ControllerSupervisorSteerClaim = "claimed" | "pending" | "settled" | "stale";
export type ControllerSupervisorSteerClaimInput = ControllerLeaseFence & Readonly<{
  turnId: string;
  controllerKey: string;
  expectedThreadId: string;
  reason: SupervisorReason;
  inputText: string;
}>;
export type ControllerSupervisorSteerSettlement = "applied" | "unknown";
export type ControllerSupervisorSteerSettlementInput = ControllerLeaseFence & Readonly<{
  turnId: string;
  controllerKey: string;
  reason: SupervisorReason;
  outcome: ControllerSupervisorSteerSettlement;
}>;

type ControllerSteerSettlementRow = Readonly<{
  controllerKey: string;
  waitingState: ControllerTurnState | null;
  waitingOrdinal: number | null;
  inputText: string | null;
  telegramChatId: string;
}>;

export type ExecutorReviewThreadInput = ExecutorFence & Readonly<{
  jobId: string;
  expectedVersion: number;
  threadId: string;
}>;

export type ExecutorReviewFormatCorrectionInput = ExecutorFence & Readonly<{
  jobId?: string;
  attemptId: string;
  threadId: string;
  headSha: string;
}>;

export type ExecutorApprovalInput = ExecutorFence & Readonly<{
  nonceHash: string;
  jobId: string;
  headSha: string;
  expiresAt: number;
  ownerUserId?: string | null;
  ownerChatId?: string | null;
  jobVersion?: number | null;
}>;

export type ExecutorApprovalRevocationInput = ExecutorFence & Readonly<{
  jobId: string;
  reason: string;
}>;

export type ExecutorStatusOutboxInput = ExecutorFence & Readonly<{
  outbox: OutboxInput;
}>;

export type ExecutorWorkerLivenessInput = ExecutorFence & Readonly<{
  value: WorkerLiveness;
}>;

export type ControlEffectLeaseInput = ExecutorFence & Readonly<{
  limit: number;
  leaseMs: number;
  busyJobIds?: readonly string[];
}>;

export type JobEffectLeaseInput = ExecutorFence & Readonly<{
  jobId: string;
  leaseMs: number;
}>;

export type CurrentHeldMergeResourceClaimsInput = Readonly<{
  jobId: string;
  policy: ProjectPolicy;
  limit: number;
}>;

export type ProductionStageFenceInput = ExecutorFence & Readonly<{
  jobId: string;
  effectIdempotencyKey: string;
}>;

export type JobOperationFenceRenewalInput = ExecutorFence & Readonly<{
  jobId: string;
  effectIdempotencyKey: string;
  leaseMs: number;
}>;

export type ControlEffectFenceRenewalInput = JobOperationFenceRenewalInput;

export type ReleaseResult =
  | Readonly<{ outcome: "waiting"; reason: "worker_active" | "worker_unknown" | "safe_cleanup" | "unresolved_effect" }>
  | Readonly<{ outcome: "released"; admission: JobAdmission }>;

export type PipelineStageRole =
  | "PLAN"
  | "CRITIQUE"
  | "BUILD"
  | "TEST"
  | "REVIEW"
  | "PATCH"
  | "DOCS"
  | "FINAL_TEST"
  | "FINAL_REVIEW"
  | "DEPLOY"
  | "CANARY";
export type PipelineStageAttemptState = "spawning" | "running" | "completed" | "failed" | "skipped";
export type PipelineStageAttempt = {
  id: string;
  jobId: string;
  role: PipelineStageRole;
  ordinal: number;
  state: PipelineStageAttemptState;
  threadId: string | null;
  environmentId: string | null;
  resourceKind: "bb_thread" | "bb_terminal" | null;
  resourceId: string | null;
  inputSha256: string;
  outputText: string | null;
  outputSha256: string | null;
  outcome: Record<string, unknown> | null;
  startSha: string | null;
  endSha: string | null;
  lastError: string | null;
  createdAt: number;
  completedAt: number | null;
  updatedAt: number;
};

export type WorkerRecoveryState = "detected" | "retiring" | "owner_required" | "requeued" | "recovered";
export type WorkerRecoveryAction = "auto_retry" | "owner_required";
export type WorkerRecoveryRecord = Readonly<{
  id: string;
  jobId: string;
  projectId: string;
  jobState: JobState;
  workerKind: WorkerKind;
  resourceId: string;
  workerGeneration: number;
  classification: WorkerRecoveryClassification;
  signature: string;
  action: WorkerRecoveryAction;
  state: WorkerRecoveryState;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}>;

export type WorkerRecoveryRegistration = Readonly<{
  action: "auto_retry" | "owner_required" | "already_recorded";
  record: WorkerRecoveryRecord;
}>;

export type MergeSuccessInput = {
  jobId: string;
  effectIdempotencyKey: string;
  message: string;
  result: Record<string, unknown>;
  outbox?: OutboxInput;
  now: number;
  leaseOwner: string;
  leaseGeneration: number;
};

export type MergeFailureInput = {
  jobId: string;
  effectIdempotencyKey: string;
  reason: string;
  now: number;
  leaseOwner: string;
  leaseGeneration: number;
};

export type MergeStaleInput = {
  jobId: string;
  effectIdempotencyKey: string;
  reason: string;
  now: number;
  leaseOwner: string;
  leaseGeneration: number;
};

export type DurableMergeReceipt = {
  jobId: string;
  effectIdempotencyKey: string;
  approvalNonceHash: string;
  approvalOwnerUserId: string;
  approvalOwnerChatId: string;
  jobVersion: number;
  approvalJobVersion: number;
  projectId: string;
  environmentId: string;
  prNumber: number;
  baseBranch: string;
  headSha: string;
  reviewAttemptId: string;
  validationCompletedAt: string;
  requiredCheckNames: string[];
  mergeMethod: "merge" | "rebase" | "squash";
  expiresAt: string;
};

export type PersistedMergeSuccessResult = {
  jobId: string;
  effectIdempotencyKey: string;
  approvalNonceHash: string;
  environmentId: string;
  prNumber: number;
  authoritativeHeadSha: string;
  baseContentVerified: boolean;
  mergedAt: string;
  mergeCommit: { oid: string };
  pullRequest: { number: number; url: string; state: "MERGED" };
  confirmedAt: string;
};

export type MergeEffectPayload = {
  headSha: string;
  receipt: DurableMergeReceipt;
  mergeCallStartedAt?: number;
  mergeCallOutcome?: "unknown";
  mergeOutcome?: "stale";
};

export type PendingMergeEffectPayload = {
  headSha: string;
  reviewAttemptId: string;
  approvalNonceHash: string;
  approvalOwnerUserId: string;
  approvalOwnerChatId: string;
  approvalJobVersion: number;
  approvalExpiresAt: number;
};

export type StaleMergeTombstone = {
  mergeOutcome: "stale";
  jobId: string;
  effectIdempotencyKey: string;
};

export type PersistedMergeEvidence =
  | {
      disposition: "failed" | "dead";
      status: "failed" | "dead";
      jobId: string;
      effectIdempotencyKey: string;
    }
  | {
      disposition: "stale";
      status: "done";
      jobId: string;
      effectIdempotencyKey: string;
      tombstone: StaleMergeTombstone;
    }
  | {
      disposition: "active";
      status: "pending" | "leased";
      jobId: string;
      effectIdempotencyKey: string;
      payload: MergeEffectPayload;
    }
  | {
      disposition: "success";
      status: "done";
      jobId: string;
      effectIdempotencyKey: string;
      payload: MergeEffectPayload;
      result: PersistedMergeSuccessResult;
    };

export type PersistedMergeEvidenceInput = {
  idempotencyKey: unknown;
  jobId: unknown;
  kind: unknown;
  status: unknown;
  payload: unknown;
};

export function isReplayableMergeEvidence(
  evidence: PersistedMergeEvidence,
): evidence is Extract<PersistedMergeEvidence, { disposition: "active" | "success" }> {
  return evidence.disposition === "active" || evidence.disposition === "success";
}

export type MergeCallPreparation =
  | {
      ok: true;
      shouldCallProvider: boolean;
      effect: StoredEffect;
      job: Job;
      receipt: DurableMergeReceipt;
    }
  | { ok: false; reason: string };

export type ApprovalRejectionResult = {
  outcome: "accepted" | "rejected";
  callbackRecorded: boolean;
};

type PairingCodeRow = {
  consumed_at: number | null;
  expires_at: number;
};
type OwnerRow = {
  telegram_user_id: string;
  telegram_chat_id: string;
  paired_at: number;
};
type ProjectPolicyRow = {
  policy_json: string;
  version: number;
};
type TelegramIdentityRow = {
  bot_id: string;
  username: string;
  verified_at: number;
};
type ApprovalRow = {
  nonce_hash: string;
  job_id: string;
  head_sha: string;
  expires_at: number;
  consumed_at: number | null;
  outcome: string | null;
  owner_user_id: string | null;
  owner_chat_id: string | null;
  job_version: number | null;
};
type CallbackRow = {
  callback_query_id: string;
  job_id: string | null;
  action: string;
  outcome: string;
  processed_at: number;
  approval_nonce_hash: string | null;
  head_sha: string | null;
  effect_idempotency_key: string | null;
};

type OutboxRow = {
  logical_key: string;
  chat_id: string;
  message_id: number | null;
  payload_json: string;
  status: StoredOutbox["status"];
  attempts: number;
  lease_owner: string | null;
  lease_generation: number | null;
  lease_expires_at: number | null;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};
type WorkerLivenessRow = {
  job_id: string;
  worker_kind: WorkerLiveness["workerKind"];
  resource_kind: WorkerLiveness["resourceKind"];
  resource_id: string;
  generation: number;
  state: WorkerLiveness["state"];
  source_updated_at: number;
  observed_at: number;
  stale_notified_at: number | null;
};
type ControllerThreadRow = {
  controller_key: string;
  telegram_user_id: string;
  telegram_chat_id: string;
  project_id: string | null;
  host_id: string | null;
  bb_thread_id: string | null;
  state: ControllerThreadState;
  pending_spawn_token: string | null;
  capability_subject_id: string | null;
  capability_profile_id: string | null;
  capability_profile_revision: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};
type ControllerTurnRow = {
  id: string;
  telegram_update_id: number;
  controller_key: string;
  ordinal: number;
  input_text: string;
  image_file_id: string | null;
  image_file_name: string | null;
  image_mime_type: string | null;
  image_size_bytes: number | null;
  image_kind: string | null;
  image_duration_seconds: number | null;
  thumbnail_file_id: string | null;
  thumbnail_file_name: string | null;
  thumbnail_size_bytes: number | null;
  state: ControllerTurnState;
  lease_owner: string | null;
  lease_generation: number | null;
  dispatch_after_seq: number;
  delivery_state: ControllerDeliveryState;
  dispatch_kind: ControllerDispatchKind | null;
  dispatch_correlation_id: string | null;
  dispatch_retry_count: number;
  delivery_reconcile_attempts: number;
  busy_wait_notified_at: number | null;
  next_dispatch_at: number;
  retry_count: number;
  model_fallback_index: number;
  bb_event_seq: number;
  evidence_event_seq: number;
  completion_continuations: number;
  accepted_finalization_id: number | null;
  input_accepted: number;
  private_draft_item_id: string | null;
  private_draft_text: string;
  recovery_source_turn_id: string | null;
  thread_follow_up_json: string | null;
  steer_reservation_turn_id: string | null;
  evidence_limit_exceeded_at: number | null;
  stream_text: string;
  telegram_message_id: number | null;
  stream_phase: ControllerTurnRecord["streamPhase"];
  response_text: string | null;
  last_error: string | null;
  submitted_at: number | null;
  completed_at: number | null;
  awaiting_interaction_id: string | null;
  tool_calls: number;
  command_failures: number;
  total_tokens: number;
  supervisor_steers: number;
  supervisor_reasons: string;
  token_baseline: number | null;
  origin: string;
  capability_profile_id: string | null;
  capability_profile_revision: number;
  capability_configured_revision: number;
  capability_continuation_count: number;
  capability_continuation_state: ControllerTurnRecord["capabilityContinuationState"];
  created_at: number;
  updated_at: number;
};
type ControllerSupervisorSteerAttemptRow = {
  turn_id: string;
  controller_key: string;
  reason: string;
  thread_id: string;
  input_text: string;
  idempotency_key: string;
  state: string;
  created_at: number;
  settled_at: number | null;
};
type ObservedThreadRow = {
  thread_id: string;
  title: string;
  last_status: string;
  notified_status: string | null;
  notified_at: number | null;
  first_seen_at: number;
  updated_at: number;
};
type ThreadFollowUp = Readonly<{
  threadId: string;
  title: string;
  status: "idle" | "error";
}>;
type ThreadInteractionRow = {
  interaction_id: string;
  thread_id: string;
  title: string;
  kind: ThreadInteraction["kind"];
  payload_json: string;
  state: "pending" | "answered" | "delivered";
  answer_json: string | null;
  asked_at: number;
  answered_at: number | null;
};
export type ThreadInteractionAnswer =
  | { ok: true; interactionId: string; threadId: string; title: string; label: string }
  | { ok: false; reason: "stale" };
export type ThreadInteractionDelivery = {
  interactionId: string;
  threadId: string;
  title: string;
  resolution: Record<string, unknown>;
};
export type ControllerInteractionCallbackResult = Readonly<{
  answer: ControllerInteractionAnswer;
  recorded: boolean;
}>;

export type ControllerInteractionTextUpdateResult =
  | Readonly<{ outcome: "replay" }>
  | Readonly<{ outcome: "handled"; answer: ControllerInteractionAnswer }>;
type ThreadOperationRow = {
  id: string;
  nonce_hash: string;
  owner_user_id: string;
  owner_chat_id: string;
  kind: ThreadOperationKind;
  thread_id: string;
  operation_text: string | null;
  state: ThreadOperationState;
  confirmation_message_id: number | null;
  expires_at: number;
  confirmed_at: number | null;
  lease_owner: string | null;
  lease_generation: number | null;
  lease_expires_at: number | null;
  result: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};
type PipelineStageAttemptRow = {
  id: string;
  job_id: string;
  role: PipelineStageRole;
  ordinal: number;
  state: PipelineStageAttemptState;
  thread_id: string | null;
  environment_id: string | null;
  resource_kind: "bb_thread" | "bb_terminal" | null;
  resource_id: string | null;
  input_sha256: string;
  output_text: string | null;
  output_sha256: string | null;
  outcome_json: string | null;
  start_sha: string | null;
  end_sha: string | null;
  last_error: string | null;
  created_at: number;
  completed_at: number | null;
  updated_at: number;
};
type WorkerRecoveryRow = {
  id: string;
  job_id: string;
  project_id: string;
  job_state: JobState;
  worker_kind: WorkerKind;
  resource_id: string;
  worker_generation: number;
  classification: WorkerRecoveryClassification;
  signature: string;
  action: WorkerRecoveryAction;
  state: WorkerRecoveryState;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
};
type TelegramUpdateRow = {
  status: "processing" | "processed" | "failed";
  claim_owner: string | null;
  claim_generation: number | null;
  claim_expires_at: number | null;
};

const THREAD_OPERATION_KINDS: ReadonlySet<ThreadOperationKind> = new Set([
  "steer_thread",
  "stop_thread",
  "retry_thread",
]);
const PIPELINE_STAGE_ROLES: ReadonlySet<PipelineStageRole> = new Set([
  "PLAN", "CRITIQUE", "BUILD", "TEST", "REVIEW", "PATCH", "DOCS",
  "FINAL_TEST", "FINAL_REVIEW", "DEPLOY", "CANARY",
]);

export class IdempotencyConflictError extends Error {
  public constructor(sourceUpdateId: number) {
    super(`Telegram update ${sourceUpdateId} was replayed with different job input`);
    this.name = "IdempotencyConflictError";
  }
}

export class UpdateClaimConflictError extends Error {
  public constructor(updateId: number) {
    super(`Telegram update ${updateId} is not owned by this store claim`);
    this.name = "UpdateClaimConflictError";
  }
}

export class AdmissionRequiredError extends Error {
  public constructor(eventType: "CONFIRMED" | "CONTINUE_REVIEW" | "RETRY") {
    super(`${eventType} must be applied through an admitted autonomy admission`);
    this.name = "AdmissionRequiredError";
  }
}

const FENCED_JOB_EVENT_TYPES: ReadonlySet<JobEvent["type"]> = new Set([
  "MERGE_SUCCEEDED",
  "MERGE_FAILED",
  "DEPLOY_SUCCEEDED",
  "DEPLOY_FAILED",
  "CANARY_SUCCEEDED",
  "CANARY_FAILED",
  "WORKER_RECOVERY_REQUESTED",
  "WORKER_RECOVERY_REQUEUED",
]);
/**
 * Effects that only redraw what the job already knows. They carry the pipeline
 * nowhere, so exhausting their retries is a display problem, not grounds for
 * abandoning the work: one job died to a Telegram 400 for a status card whose
 * text had not changed.
 */
const COSMETIC_EFFECT_KINDS: ReadonlySet<string> = new Set(["render_status"]);
const PRODUCTION_LIFECYCLE_EVENT_TYPES: ReadonlySet<JobEvent["type"]> = new Set([
  "DEPLOY_SUCCEEDED",
  "DEPLOY_FAILED",
  "CANARY_SUCCEEDED",
  "CANARY_FAILED",
]);
const WORKER_RECOVERY_SUCCESS_EVENT_TYPES: ReadonlySet<JobEvent["type"]> = new Set([
  "PLAN_READY",
  "CRITIQUE_PASSED",
  "CRITIQUE_NEEDS_REVISION",
  "IMPLEMENTATION_IDLE",
  "REVIEW_PASSED",
  "REVIEW_CHANGES_REQUESTED",
  "DOCS_IDLE",
]);

class ProductionSettlementConflictError extends Error {
  public constructor() {
    super("production claim settlement was lost");
    this.name = "ProductionSettlementConflictError";
  }
}

class WorkerRecoverySettlementConflictError extends Error {
  public constructor() {
    super("worker recovery settlement was lost");
    this.name = "WorkerRecoverySettlementConflictError";
  }
}

const LAST_PROJECT_KEY = "telegram-agent:last-project";

const CANONICAL_POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const TELEGRAM_UPDATE_LEASE_MS = 300_000;
/** Claims one update may cost before ingress gives up and moves the cursor on. */
export const MAX_TELEGRAM_UPDATE_ATTEMPTS = 3;
export const OWNER_MEMORY_SCOPE = "owner";
const MEMORY_KINDS = new Set<MemoryKind>(["preference", "fact", "decision", "correction"]);
/** Marks the rows that came from an owner import, so they are distinguishable
 *  from anything the agent concluded on its own. */
const OWNER_IMPORT_ORIGIN = "owner_import";
const MAX_MEMORY_SUBJECT = 120;
const MAX_MEMORY_BODY = 1_000;
const MAX_LIVE_MEMORIES_PER_SCOPE = 10;
const DEFAULT_MEMORY_IMPORTANCE = 0.6;
const DEFAULT_MEMORY_CONFIDENCE = 0.7;
const MAX_DIGEST_TURNS = 12;
const MAX_DIGEST_TEXT = 600;
const MAX_MONITOR_INSTRUCTION = 1_000;
const MAX_ARMED_MONITORS = 20;
// Four is what one owner can follow in a chat, and two open fan-outs is already
// eight threads of work the agent has to reconcile into one answer.
const MAX_DELEGATION_THREADS = 4;
const MAX_OPEN_DELEGATIONS = 2;
const MAX_DELEGATION_SUMMARY = 600;
const MAX_DELEGATION_TITLE = 120;
const MAX_RECEIPT_RESULT_BYTES = 8_000;
const MAX_CONTROLLER_PRIVATE_DRAFT_CHARS = 4_000;
const MAX_EFFECT_KEY = 256;
const MAX_PIPELINE_OUTPUT_BYTES = 65_536;
const SAFE_MERGE_FAILURE_REASON = "Merge effect failed safely";
const UNKNOWN_MERGE_OUTCOME_REASON = "Merge outcome is unknown; provider truth requires reconciliation";
const SAFE_FAILED_MERGE_PAYLOAD = JSON.stringify({ mergeCleanup: "failed" });

function assertControllerKey(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TypeError("controllerKey is invalid");
}

function assertControllerIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${field} must be between 1 and 256 characters`);
  }
}

function assertControllerText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4_000) {
    throw new TypeError(`${field} must be between 1 and 4000 characters`);
  }
}

const MEDIA_KINDS = new Set<ControllerMediaKind>(["image", "animation", "video"]);

function assertControllerImage(value: ControllerImage): void {
  const image = normalizeControllerImage(value);
  if (typeof image.fileId !== "string" || image.fileId.length === 0 || image.fileId.length > 1_024) {
    throw new TypeError("controller image fileId must be between 1 and 1024 characters");
  }
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(image.fileName)) {
    throw new TypeError("controller image fileName is invalid");
  }
  if (!(CONTROLLER_MEDIA_MIME_TYPES as readonly string[]).includes(image.mimeType)) {
    throw new TypeError("controller image mimeType is invalid");
  }
  if (!MEDIA_KINDS.has(image.kind)) {
    throw new TypeError("controller image kind is invalid");
  }
  if (image.durationSeconds !== null && (
    !Number.isFinite(image.durationSeconds) ||
    image.durationSeconds < 0
  )) {
    throw new TypeError("controller image durationSeconds is invalid");
  }
  if (image.sizeBytes !== null && (
    !Number.isSafeInteger(image.sizeBytes) ||
    image.sizeBytes < 0 ||
    image.sizeBytes > MAX_PERSISTED_MEDIA_BYTES
  )) {
    throw new TypeError("controller image sizeBytes is invalid");
  }
  if (image.thumbnail) {
    if (typeof image.thumbnail.fileId !== "string" || image.thumbnail.fileId.length === 0 || image.thumbnail.fileId.length > 1_024) {
      throw new TypeError("controller thumbnail fileId must be between 1 and 1024 characters");
    }
    if (!/^[A-Za-z0-9._-]{1,255}$/.test(image.thumbnail.fileName)) {
      throw new TypeError("controller thumbnail fileName is invalid");
    }
    if (image.thumbnail.sizeBytes !== null && (
      !Number.isSafeInteger(image.thumbnail.sizeBytes) ||
      image.thumbnail.sizeBytes < 0 ||
      image.thumbnail.sizeBytes > MAX_PERSISTED_MEDIA_BYTES
    )) {
      throw new TypeError("controller thumbnail sizeBytes is invalid");
    }
  }
}
function assertCanonicalPositiveDecimal(value: string, field: string): void {
  if (typeof value !== "string" || !CANONICAL_POSITIVE_DECIMAL.test(value)) {
    throw new TypeError(`${field} must be a canonical positive decimal string`);
  }
}

function assertSha256Hex(value: string): void {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError("Pairing code must be a lowercase 64-character SHA-256 hex string");
  }
}

function assertContentSha256(value: string, field: string): void {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError(`${field} must be a lowercase 64-character SHA-256 hex string`);
  }
}

function assertFullSha(value: string, field: string): void {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new TypeError(`${field} must be a 40-character lowercase SHA`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
}

function assertFiniteTimestamp(value: unknown, field: string): asserts value is string {
  assertBoundedString(value, field);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be a valid finite timestamp`);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${field} contains an unexpected field`);
  }
}

function assertExactObjectKeys(value: Record<string, unknown>, required: readonly string[], field: string): void {
  assertExactKeys(value, required, field);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(`${field} is missing ${key}`);
  }
}

function parsePersistedMergeSuccessResultInternal(value: unknown): PersistedMergeSuccessResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("merge result must be a JSON object");
  }
  const json = serializeBoundedJson(value, "merge result", MAX_MERGE_RESULT_JSON);
  const result = value as Record<string, unknown>;
  assertExactObjectKeys(result, [
    "jobId",
    "effectIdempotencyKey",
    "approvalNonceHash",
    "environmentId",
    "prNumber",
    "authoritativeHeadSha",
    "baseContentVerified",
    "mergedAt",
    "mergeCommit",
    "pullRequest",
    "confirmedAt",
  ], "merge result");
  assertBoundedString(result.jobId, "merge result.jobId");
  assertBoundedString(result.effectIdempotencyKey, "merge result.effectIdempotencyKey", MAX_EFFECT_KEY);
  assertBoundedString(result.approvalNonceHash, "merge result.approvalNonceHash");
  if (!SHA256_HEX.test(result.approvalNonceHash)) throw new TypeError("merge result.approvalNonceHash must be SHA-256 hex");
  assertBoundedString(result.environmentId, "merge result.environmentId");
  assertPositiveInteger(result.prNumber as number, "merge result.prNumber");
  if ((result.prNumber as number) > 2_147_483_647) throw new TypeError("merge result.prNumber is too large");
  assertBoundedString(result.authoritativeHeadSha, "merge result.authoritativeHeadSha");
  if (!FULL_SHA.test(result.authoritativeHeadSha)) throw new TypeError("merge result head must be a full lowercase SHA");
  if (typeof result.baseContentVerified !== "boolean") throw new TypeError("merge result base-content verification must be boolean");
  assertFiniteTimestamp(result.mergedAt, "merge result.mergedAt");
  assertFiniteTimestamp(result.confirmedAt, "merge result.confirmedAt");

  if (result.mergeCommit === null || typeof result.mergeCommit !== "object" || Array.isArray(result.mergeCommit)) {
    throw new TypeError("merge result.mergeCommit must be an object");
  }
  const mergeCommit = result.mergeCommit as Record<string, unknown>;
  assertExactObjectKeys(mergeCommit, ["oid"], "merge result.mergeCommit");
  assertBoundedString(mergeCommit.oid, "merge result.mergeCommit.oid");
  if (!FULL_SHA.test(mergeCommit.oid)) {
    throw new TypeError("merge result merge commit must be a full lowercase SHA");
  }

  if (result.pullRequest === null || typeof result.pullRequest !== "object" || Array.isArray(result.pullRequest)) {
    throw new TypeError("merge result.pullRequest must be an object");
  }
  const pullRequest = result.pullRequest as Record<string, unknown>;
  assertExactObjectKeys(pullRequest, ["number", "url", "state"], "merge result.pullRequest");
  assertPositiveInteger(pullRequest.number as number, "merge result.pullRequest.number");
  if (pullRequest.number !== result.prNumber) throw new TypeError("merge result pull-request number does not match");
  const url = assertSafeExternalHttpsUrl(pullRequest.url, "merge result.pullRequest.url");
  if (pullRequest.state !== "MERGED") throw new TypeError("merge result pull-request state must be MERGED");

  if (json.length > MAX_MERGE_RESULT_JSON) throw new TypeError("merge result must be bounded JSON");
  return {
    jobId: result.jobId,
    effectIdempotencyKey: result.effectIdempotencyKey,
    approvalNonceHash: result.approvalNonceHash,
    environmentId: result.environmentId,
    prNumber: result.prNumber as number,
    authoritativeHeadSha: result.authoritativeHeadSha,
    baseContentVerified: result.baseContentVerified,
    mergedAt: result.mergedAt,
    mergeCommit: { oid: mergeCommit.oid },
    pullRequest: { number: pullRequest.number as number, url, state: "MERGED" },
    confirmedAt: result.confirmedAt,
  };
}

export function parsePersistedMergeSuccessResult(value: unknown): PersistedMergeSuccessResult {
  return parsePersistedMergeSuccessResultInternal(value);
}

function mergeSuccessResultMatchesDurable(
  result: PersistedMergeSuccessResult,
  effect: EffectRow,
  payload: MergeEffectPayload,
  job: Job,
  approval: ApprovalRow | undefined,
  expectedJobState: "merging" | "post_merge",
): boolean {
  const receipt = payload.receipt;
  const postMergeStates = new Set<JobState>(["deploying", "verifying_production", "production_failed", "complete", "merged"]);
  const expectedJobVersion = expectedJobState === "post_merge" ? receipt.jobVersion + 1 : receipt.jobVersion;
  const stateMatches = expectedJobState === "merging"
    ? job.state === "merging"
    : postMergeStates.has(job.state);
  const mergeFactMatches = expectedJobState === "merging" || job.state === "merged"
    ? true
    : job.mergeMessage !== null && job.mergeCommitSha === result.mergeCommit.oid && job.mergedAt === result.mergedAt;
  return effect.job_id === job.id &&
    result.jobId === job.id &&
    result.effectIdempotencyKey === effect.idempotency_key &&
    receipt.effectIdempotencyKey === effect.idempotency_key &&
    result.approvalNonceHash === receipt.approvalNonceHash &&
    result.environmentId === receipt.environmentId &&
    result.environmentId === job.environmentId &&
    result.prNumber === receipt.prNumber &&
    result.prNumber === job.prNumber &&
    result.authoritativeHeadSha === receipt.headSha &&
    result.authoritativeHeadSha === job.prHeadSha &&
    result.pullRequest.number === receipt.prNumber &&
    result.pullRequest.state === "MERGED" &&
    stateMatches &&
    mergeFactMatches &&
    job.cancelRequestedAt === null &&
    (expectedJobState === "post_merge" ? job.version >= expectedJobVersion : job.version === expectedJobVersion) &&
    job.projectId === receipt.projectId &&
    job.policy !== null &&
    job.policy.baseBranch === receipt.baseBranch &&
    job.policy.mergeMethod === receipt.mergeMethod &&
    JSON.stringify([...job.policy.requiredChecks].sort()) === JSON.stringify(receipt.requiredCheckNames) &&
    approval !== undefined &&
    approval.job_id === job.id &&
    approval.head_sha === receipt.headSha &&
    approval.consumed_at !== null &&
    approval.outcome === "accepted" &&
    approval.job_version === receipt.approvalJobVersion &&
    approval.owner_user_id === receipt.approvalOwnerUserId &&
    approval.owner_chat_id === receipt.approvalOwnerChatId &&
    approval.expires_at === Date.parse(receipt.expiresAt);
}

function isStrictPassReviewResult(value: unknown, headSha: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const parsed = value as Record<string, unknown>;
  const requiredKeys = ["outcome", "reasons", "findings", "reviewedHeadSha", "verdict"];
  const optionalKeys = ["formatCorrectionSent", "requiresNewHead"];
  if (
    Object.keys(parsed).some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key)) ||
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(parsed, key)) ||
    parsed.outcome !== "pass" ||
    parsed.reviewedHeadSha !== headSha ||
    parsed.requiresNewHead === true ||
    (parsed.formatCorrectionSent !== undefined && typeof parsed.formatCorrectionSent !== "boolean") ||
    (parsed.requiresNewHead !== undefined && typeof parsed.requiresNewHead !== "boolean") ||
    !Array.isArray(parsed.reasons) ||
    parsed.reasons.length !== 0 ||
    !Array.isArray(parsed.findings) ||
    parsed.findings.length !== 0
  ) return false;
  const verdict = reviewVerdictSchema.safeParse(parsed.verdict);
  return verdict.success &&
    verdict.data.verdict === "pass" &&
    verdict.data.reviewedHeadSha === headSha &&
    verdict.data.findings.length === 0 &&
    verdict.data.checks.every((check) => check.outcome === "passed");
}

function evidenceRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pipelineEvidenceHashMatches(attempt: PipelineStageAttempt): boolean {
  return attempt.outputText !== null && attempt.outputSha256 !== null &&
    createHash("sha256").update(attempt.outputText, "utf8").digest("hex") === attempt.outputSha256;
}

function verificationEvidenceMatchesPolicy(value: unknown, policy: ProjectPolicy): boolean {
  const verification = evidenceRecord(value);
  if (!verification || !Array.isArray(verification.checks)) return false;
  const checks = verification.checks;
  if (policy.validationCommands.length === 0) {
    return verification.disposition === "skipped" && checks.length === 0;
  }
  if (verification.disposition !== "commands" || checks.length !== policy.validationCommands.length) return false;
  return policy.validationCommands.every((configured, index) => {
    const check = evidenceRecord(checks[index]);
    return check !== null && Object.keys(check).length === 3 &&
      check.name === configured.name && check.command === configured.command && check.expectedExitCode === 0;
  });
}

function validationEvidenceMatchesPolicy(
  attempt: PipelineStageAttempt,
  job: Job,
  headSha: string,
): boolean {
  if (!job.policy || attempt.state !== "completed" || attempt.startSha !== headSha || attempt.endSha !== headSha ||
      !pipelineEvidenceHashMatches(attempt)) return false;
  const outcome = evidenceRecord(attempt.outcome);
  if (!outcome || outcome.validationOutcome !== "pass" || outcome.headSha !== headSha ||
      outcome.originRepository !== job.policy.githubRepository.toLowerCase()) return false;
  const policyReceipts = Array.isArray(outcome.policyCommandReceipts) ? outcome.policyCommandReceipts : [];
  if (policyReceipts.length !== job.policy.validationCommands.length) return false;
  if (!job.policy.validationCommands.every((configured, index) => {
    const receipt = evidenceRecord(policyReceipts[index]);
    return receipt !== null && receipt.name === configured.name &&
      receipt.commandSha256 === createHash("sha256").update(configured.command, "utf8").digest("hex") &&
      receipt.outcome === "pass" && receipt.exitCode === 0;
  })) return false;
  const githubPr = evidenceRecord(outcome.githubPr);
  if (!githubPr || githubPr.number !== job.prNumber || githubPr.url !== job.prUrl ||
      githubPr.state !== "OPEN" || githubPr.isDraft !== false || githubPr.baseRefName !== job.policy.baseBranch) return false;
  const checks = Array.isArray(outcome.requiredChecks) ? outcome.requiredChecks : [];
  const passedNames = new Set<string>();
  for (const rawCheck of checks) {
    const check = evidenceRecord(rawCheck);
    if (!check || typeof check.name !== "string" || typeof check.bucket !== "string" ||
        check.bucket.toLowerCase() !== "pass" || passedNames.has(check.name)) return false;
    passedNames.add(check.name);
  }
  return job.policy.requiredChecks.every((name) => passedNames.has(name));
}

function docsEvidenceIsComplete(attempt: PipelineStageAttempt): boolean {
  if (attempt.state !== "completed" || !pipelineEvidenceHashMatches(attempt)) return false;
  const outcome = evidenceRecord(attempt.outcome);
  const documentation = evidenceRecord(outcome?.documentation);
  if (outcome?.verdict !== "success" || !documentation || !Array.isArray(documentation.files) ||
      !Array.isArray(documentation.checks)) return false;
  if (documentation.disposition === "skipped") {
    return documentation.files.length === 0 && documentation.checks.length === 0 &&
      typeof documentation.reason === "string" && documentation.reason.trim().length >= 10;
  }
  return documentation.disposition === "changed" && documentation.files.length > 0 &&
    documentation.files.every((file) => typeof file === "string" && file.length > 0) &&
    documentation.checks.length > 0 && documentation.checks.every((check) => typeof check === "string" && check.length > 0) &&
    typeof documentation.summary === "string" && documentation.summary.length > 0;
}

function isBoundedAttemptCompletion(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

export function isCompletedReviewAttempt(
  attempt: AttemptRecord | null,
  jobId: string,
  headSha: string,
): boolean {
  if (!attempt || attempt.jobId !== jobId || attempt.kind !== "review" || attempt.headSha !== headSha ||
      !isBoundedAttemptCompletion(attempt.completedAt) || typeof attempt.resultJson !== "string") return false;
  try {
    return isStrictPassReviewResult(JSON.parse(attempt.resultJson), headSha);
  } catch {
    return false;
  }
}

export function parseDurableMergeReceipt(value: unknown): DurableMergeReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("merge receipt must be a JSON object");
  }
  const receipt = value as Record<string, unknown>;
  assertExactKeys(receipt, [
    "jobId",
    "effectIdempotencyKey",
    "approvalNonceHash",
    "approvalOwnerUserId",
    "approvalOwnerChatId",
    "jobVersion",
    "approvalJobVersion",
    "projectId",
    "environmentId",
    "prNumber",
    "baseBranch",
    "headSha",
    "reviewAttemptId",
    "validationCompletedAt",
    "requiredCheckNames",
    "mergeMethod",
    "expiresAt",
  ], "merge receipt");
  assertBoundedString(receipt.jobId, "receipt.jobId");
  assertBoundedString(receipt.effectIdempotencyKey, "receipt.effectIdempotencyKey", MAX_EFFECT_KEY);
  assertBoundedString(receipt.approvalNonceHash, "receipt.approvalNonceHash");
  if (!SHA256_HEX.test(receipt.approvalNonceHash)) throw new TypeError("receipt.approvalNonceHash must be SHA-256 hex");
  assertBoundedString(receipt.approvalOwnerUserId, "receipt.approvalOwnerUserId");
  assertBoundedString(receipt.approvalOwnerChatId, "receipt.approvalOwnerChatId");
  assertCanonicalPositiveDecimal(receipt.approvalOwnerUserId, "receipt.approvalOwnerUserId");
  assertCanonicalPositiveDecimal(receipt.approvalOwnerChatId, "receipt.approvalOwnerChatId");
  assertPositiveInteger(receipt.jobVersion as number, "receipt.jobVersion");
  assertPositiveInteger(receipt.approvalJobVersion as number, "receipt.approvalJobVersion");
  assertBoundedString(receipt.projectId, "receipt.projectId");
  if (!receipt.projectId.startsWith("proj_")) throw new TypeError("receipt.projectId is invalid");
  assertBoundedString(receipt.environmentId, "receipt.environmentId");
  assertPositiveInteger(receipt.prNumber as number, "receipt.prNumber");
  if ((receipt.prNumber as number) > 2_147_483_647) throw new TypeError("receipt.prNumber is too large");
  assertBoundedString(receipt.baseBranch, "receipt.baseBranch");
  assertBoundedString(receipt.headSha, "receipt.headSha");
  if (!FULL_SHA.test(receipt.headSha)) throw new TypeError("receipt.headSha must be a full lowercase SHA");
  assertBoundedString(receipt.reviewAttemptId, "receipt.reviewAttemptId");
  assertFiniteTimestamp(receipt.validationCompletedAt, "receipt.validationCompletedAt");
  if (!Array.isArray(receipt.requiredCheckNames) || receipt.requiredCheckNames.length > 50) {
    throw new TypeError("receipt.requiredCheckNames must be a bounded array");
  }
  const requiredCheckNames = receipt.requiredCheckNames.map((name, index) => {
    assertBoundedString(name, `receipt.requiredCheckNames[${index}]`);
    return name;
  });
  if (new Set(requiredCheckNames).size !== requiredCheckNames.length ||
      JSON.stringify(requiredCheckNames) !== JSON.stringify([...requiredCheckNames].sort())) {
    throw new TypeError("receipt.requiredCheckNames must be unique and sorted");
  }
  if (receipt.mergeMethod !== "merge" && receipt.mergeMethod !== "rebase" && receipt.mergeMethod !== "squash") {
    throw new TypeError("receipt.mergeMethod is invalid");
  }
  assertFiniteTimestamp(receipt.expiresAt, "receipt.expiresAt");
  return {
    jobId: receipt.jobId,
    effectIdempotencyKey: receipt.effectIdempotencyKey,
    approvalNonceHash: receipt.approvalNonceHash,
    approvalOwnerUserId: receipt.approvalOwnerUserId,
    approvalOwnerChatId: receipt.approvalOwnerChatId,
    jobVersion: receipt.jobVersion as number,
    approvalJobVersion: receipt.approvalJobVersion as number,
    projectId: receipt.projectId,
    environmentId: receipt.environmentId,
    prNumber: receipt.prNumber as number,
    baseBranch: receipt.baseBranch,
    headSha: receipt.headSha,
    reviewAttemptId: receipt.reviewAttemptId,
    validationCompletedAt: receipt.validationCompletedAt,
    requiredCheckNames,
    mergeMethod: receipt.mergeMethod,
    expiresAt: receipt.expiresAt,
  };
}

export function parseMergeEffectPayload(value: unknown): MergeEffectPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("merge effect payload must be a JSON object");
  }
  const payload = value as Record<string, unknown>;
  assertExactKeys(payload, ["headSha", "receipt", "mergeCallStartedAt", "mergeCallOutcome", "mergeOutcome"], "merge effect payload");
  assertBoundedString(payload.headSha, "effect.headSha");
  if (!FULL_SHA.test(payload.headSha)) throw new TypeError("effect.headSha must be a full lowercase SHA");
  const receipt = parseDurableMergeReceipt(payload.receipt);
  if (receipt.headSha !== payload.headSha) throw new TypeError("effect head and receipt head do not match");
  if (payload.mergeCallStartedAt !== undefined) assertNonNegativeInteger(payload.mergeCallStartedAt as number, "effect.mergeCallStartedAt");
  if (payload.mergeCallOutcome !== undefined && payload.mergeCallOutcome !== "unknown") {
    throw new TypeError("effect.mergeCallOutcome is invalid");
  }
  if (payload.mergeCallStartedAt !== undefined && payload.mergeCallOutcome !== "unknown") {
    throw new TypeError("a started merge effect must have unknown outcome");
  }
  if (payload.mergeCallStartedAt === undefined && payload.mergeCallOutcome !== undefined) {
    throw new TypeError("an unknown merge effect must have a started-call timestamp");
  }
  if (payload.mergeOutcome !== undefined && payload.mergeOutcome !== "stale") {
    throw new TypeError("effect.mergeOutcome is invalid");
  }
  if (payload.mergeOutcome !== undefined && (payload.mergeCallStartedAt !== undefined || payload.mergeCallOutcome !== undefined)) {
    throw new TypeError("a stale merge effect cannot have an external-call fence");
  }
  return {
    headSha: payload.headSha,
    receipt,
    ...(payload.mergeCallStartedAt === undefined ? {} : { mergeCallStartedAt: payload.mergeCallStartedAt as number }),
    ...(payload.mergeCallOutcome === undefined ? {} : { mergeCallOutcome: "unknown" as const }),
    ...(payload.mergeOutcome === undefined ? {} : { mergeOutcome: "stale" as const }),
  };
}

export function parsePendingMergeEffectPayload(value: unknown): PendingMergeEffectPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("pending merge effect payload must be a JSON object");
  }
  const payload = value as Record<string, unknown>;
  assertExactKeys(payload, [
    "headSha",
    "reviewAttemptId",
    "approvalNonceHash",
    "approvalOwnerUserId",
    "approvalOwnerChatId",
    "approvalJobVersion",
    "approvalExpiresAt",
  ], "pending merge effect payload");
  assertBoundedString(payload.headSha, "pending.headSha");
  if (!FULL_SHA.test(payload.headSha)) throw new TypeError("pending.headSha must be a full lowercase SHA");
  assertBoundedString(payload.reviewAttemptId, "pending.reviewAttemptId");
  assertBoundedString(payload.approvalNonceHash, "pending.approvalNonceHash");
  if (!SHA256_HEX.test(payload.approvalNonceHash)) throw new TypeError("pending.approvalNonceHash must be SHA-256 hex");
  assertBoundedString(payload.approvalOwnerUserId, "pending.approvalOwnerUserId");
  assertBoundedString(payload.approvalOwnerChatId, "pending.approvalOwnerChatId");
  assertCanonicalPositiveDecimal(payload.approvalOwnerUserId, "pending.approvalOwnerUserId");
  assertCanonicalPositiveDecimal(payload.approvalOwnerChatId, "pending.approvalOwnerChatId");
  assertPositiveInteger(payload.approvalJobVersion as number, "pending.approvalJobVersion");
  assertPositiveInteger(payload.approvalExpiresAt as number, "pending.approvalExpiresAt");
  return {
    headSha: payload.headSha,
    reviewAttemptId: payload.reviewAttemptId,
    approvalNonceHash: payload.approvalNonceHash,
    approvalOwnerUserId: payload.approvalOwnerUserId,
    approvalOwnerChatId: payload.approvalOwnerChatId,
    approvalJobVersion: payload.approvalJobVersion as number,
    approvalExpiresAt: payload.approvalExpiresAt as number,
  };
}

export function parsePersistedMergeEffectPayload(
  value: unknown,
  status: StoredEffect["status"],
): MergeEffectPayload {
  if (status !== "done" || value === null || typeof value !== "object" || Array.isArray(value)) {
    return parseMergeEffectPayload(value);
  }
  const persisted = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(persisted, "mergeResult")) {
    return parseMergeEffectPayload(value);
  }
  const { mergeResult, ...activePayload } = persisted;
  parsePersistedMergeSuccessResult(mergeResult);
  return parseMergeEffectPayload(activePayload);
}

function parseActiveMergeEffectPayload(value: unknown): MergeEffectPayload {
  const payload = parseMergeEffectPayload(value);
  if (payload.mergeOutcome !== undefined) {
    throw new TypeError("an active merge effect cannot have a terminal stale outcome");
  }
  return payload;
}

function parseStaleMergeTombstone(
  value: unknown,
  jobId: string,
  effectIdempotencyKey: string,
): StaleMergeTombstone {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("stale merge tombstone must be a JSON object");
  }
  const tombstone = value as Record<string, unknown>;
  assertExactObjectKeys(
    tombstone,
    ["mergeOutcome", "jobId", "effectIdempotencyKey"],
    "stale merge tombstone",
  );
  if (tombstone.mergeOutcome !== "stale") {
    throw new TypeError("stale merge tombstone outcome is invalid");
  }
  assertBoundedString(tombstone.jobId, "stale merge tombstone.jobId");
  assertBoundedString(tombstone.effectIdempotencyKey, "stale merge tombstone.effectIdempotencyKey", MAX_EFFECT_KEY);
  assertNoRawMergeCallback(tombstone.jobId, "stale merge tombstone.jobId");
  assertNoRawMergeCallback(tombstone.effectIdempotencyKey, "stale merge tombstone.effectIdempotencyKey");
  if (tombstone.jobId !== jobId || tombstone.effectIdempotencyKey !== effectIdempotencyKey) {
    throw new TypeError("stale merge tombstone identity does not match its effect");
  }
  return {
    mergeOutcome: "stale",
    jobId: tombstone.jobId,
    effectIdempotencyKey: tombstone.effectIdempotencyKey,
  };
}

type PersistedMergeStatus = "pending" | "leased" | "done" | "failed" | "dead";

function parseMergeEvidenceIdentity(input: PersistedMergeEvidenceInput): {
  jobId: string;
  effectIdempotencyKey: string;
  status: PersistedMergeStatus;
} {
  assertBoundedString(input.jobId, "merge effect.jobId");
  assertBoundedString(input.idempotencyKey, "merge effect.idempotencyKey", MAX_EFFECT_KEY);
  assertNoRawMergeCallback(input.jobId, "merge effect.jobId");
  assertNoRawMergeCallback(input.idempotencyKey, "merge effect.idempotencyKey");
  if (input.kind !== "merge_pr") throw new TypeError("merge evidence kind is not merge_pr");
  if (input.status !== "pending" && input.status !== "leased" && input.status !== "done" &&
      input.status !== "failed" && input.status !== "dead") {
    throw new TypeError("merge evidence status is invalid");
  }
  return {
    jobId: input.jobId,
    effectIdempotencyKey: input.idempotencyKey,
    status: input.status,
  };
}

function parseTerminalMergeEvidence(
  payload: unknown,
  status: "failed" | "dead",
  jobId: string,
  effectIdempotencyKey: string,
): PersistedMergeEvidence {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("failed merge effect payload must be a JSON object");
  }
  const cleanupPayload = payload as Record<string, unknown>;
  assertExactObjectKeys(cleanupPayload, ["mergeCleanup"], `${status} merge effect payload`);
  if (cleanupPayload.mergeCleanup !== "failed") {
    throw new TypeError(`${status} merge effect cleanup outcome is invalid`);
  }
  return { disposition: status, status, jobId, effectIdempotencyKey };
}

function parseStaleMergeEvidence(
  payload: unknown,
  jobId: string,
  effectIdempotencyKey: string,
): PersistedMergeEvidence {
  return {
    disposition: "stale",
    status: "done",
    jobId,
    effectIdempotencyKey,
    tombstone: parseStaleMergeTombstone(payload, jobId, effectIdempotencyKey),
  };
}

function assertMergeReceiptRowBinding(
  payload: MergeEffectPayload,
  jobId: string,
  effectIdempotencyKey: string,
): void {
  if (payload.receipt.jobId !== jobId || payload.receipt.effectIdempotencyKey !== effectIdempotencyKey) {
    throw new TypeError("merge receipt identity does not match its effect");
  }
}

function parseSuccessfulMergeEvidence(
  payload: unknown,
  jobId: string,
  effectIdempotencyKey: string,
): PersistedMergeEvidence {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("done merge effect payload must be a JSON object");
  }
  const persisted = payload as Record<string, unknown>;
  assertExactObjectKeys(
    persisted,
    ["headSha", "receipt", "mergeCallStartedAt", "mergeCallOutcome", "mergeResult"],
    "done merge effect payload",
  );
  const { mergeResult, ...activePayload } = persisted;
  const mergePayload = parseActiveMergeEffectPayload(activePayload);
  const successResult = parsePersistedMergeSuccessResult(mergeResult);
  assertMergeReceiptRowBinding(mergePayload, jobId, effectIdempotencyKey);
  if (
    successResult.jobId !== jobId ||
    successResult.effectIdempotencyKey !== effectIdempotencyKey ||
    successResult.approvalNonceHash !== mergePayload.receipt.approvalNonceHash ||
    successResult.environmentId !== mergePayload.receipt.environmentId ||
    successResult.prNumber !== mergePayload.receipt.prNumber ||
    successResult.authoritativeHeadSha !== mergePayload.receipt.headSha ||
    successResult.pullRequest.number !== mergePayload.receipt.prNumber ||
    successResult.pullRequest.state !== "MERGED"
  ) throw new TypeError("done merge result does not match its durable receipt");
  return {
    disposition: "success",
    status: "done",
    jobId,
    effectIdempotencyKey,
    payload: mergePayload,
    result: successResult,
  };
}

export function parsePersistedMergeEvidence(
  input: PersistedMergeEvidenceInput,
): PersistedMergeEvidence {
  const identity = parseMergeEvidenceIdentity(input);
  if (identity.status === "failed" || identity.status === "dead") {
    return parseTerminalMergeEvidence(input.payload, identity.status, identity.jobId, identity.effectIdempotencyKey);
  }
  if (identity.status === "done" && input.payload !== null && typeof input.payload === "object" &&
      !Array.isArray(input.payload) && Object.prototype.hasOwnProperty.call(input.payload, "mergeOutcome")) {
    return parseStaleMergeEvidence(input.payload, identity.jobId, identity.effectIdempotencyKey);
  }
  if (identity.status === "done") {
    return parseSuccessfulMergeEvidence(input.payload, identity.jobId, identity.effectIdempotencyKey);
  }
  const mergePayload = parseActiveMergeEffectPayload(input.payload);
  assertMergeReceiptRowBinding(mergePayload, identity.jobId, identity.effectIdempotencyKey);
  return {
    disposition: "active",
    status: identity.status,
    jobId: identity.jobId,
    effectIdempotencyKey: identity.effectIdempotencyKey,
    payload: mergePayload,
  };
}

function mergeEvidenceJobBindingError(
  evidence: Extract<PersistedMergeEvidence, { disposition: "active" | "success" }>,
  job: Job,
): string | null {
  const receipt = evidence.payload.receipt;
  if (evidence.jobId !== job.id || receipt.jobId !== job.id) {
    return "merge evidence job binding does not match the selected job";
  }
  if (receipt.jobVersion !== receipt.approvalJobVersion + 1) {
    return "merge evidence job-version binding is invalid";
  }
  if (job.projectId !== receipt.projectId || job.environmentId !== receipt.environmentId ||
      job.prNumber !== receipt.prNumber || job.policy === null ||
      job.policy.baseBranch !== receipt.baseBranch || job.policy.mergeMethod !== receipt.mergeMethod ||
      JSON.stringify([...job.policy.requiredChecks].sort()) !== JSON.stringify(receipt.requiredCheckNames)) {
    return "merge evidence does not match the immutable job policy";
  }
  return null;
}

function mergeEvidenceApprovalBindingError(
  evidence: Extract<PersistedMergeEvidence, { disposition: "active" | "success" }>,
  job: Job,
  approval: ApprovalState | null,
): string | null {
  const receipt = evidence.payload.receipt;
  if (
    approval === null ||
    approval.jobId !== job.id ||
    approval.headSha !== receipt.headSha ||
    approval.consumedAt === null ||
    approval.outcome !== "accepted" ||
    approval.jobVersion !== receipt.approvalJobVersion ||
    approval.ownerUserId !== receipt.approvalOwnerUserId ||
    approval.ownerChatId !== receipt.approvalOwnerChatId ||
    approval.expiresAt !== Date.parse(receipt.expiresAt)
  ) {
    return "merge evidence does not match its approval";
  }
  return null;
}

function mergeEvidenceAttemptBindingError(
  evidence: Extract<PersistedMergeEvidence, { disposition: "active" | "success" }>,
  job: Job,
  attempt: AttemptRecord | null,
): string | null {
  const receipt = evidence.payload.receipt;
  if (
    attempt === null ||
    attempt.id !== receipt.reviewAttemptId ||
    attempt.jobId !== evidence.jobId ||
    attempt.jobId !== receipt.jobId ||
    attempt.kind !== "review" ||
    attempt.headSha !== receipt.headSha ||
    !isBoundedAttemptCompletion(attempt.completedAt) ||
    typeof attempt.resultJson !== "string"
  ) {
    return "merge evidence owning review attempt is not a strict completed pass";
  }
  if (evidence.disposition === "active" && !isCompletedReviewAttempt(attempt, job.id, receipt.headSha)) {
    return "merge evidence owning review attempt is not a strict completed pass";
  }
  if (evidence.disposition === "success") {
    try {
      const attemptResult = parsePersistedMergeSuccessResult(JSON.parse(attempt.resultJson));
      if (JSON.stringify(attemptResult) !== JSON.stringify(evidence.result)) {
        return "merge success evidence does not match its owning attempt result";
      }
    } catch {
      return "merge success evidence owning attempt result is invalid";
    }
  }
  return null;
}

export function mergeEvidenceBindingError(
  evidence: PersistedMergeEvidence,
  job: Job,
  approval: ApprovalState | null,
  attempt: AttemptRecord | null,
): string | null {
  if (!isReplayableMergeEvidence(evidence)) return null;
  return mergeEvidenceJobBindingError(evidence, job) ??
    mergeEvidenceApprovalBindingError(evidence, job, approval) ??
    mergeEvidenceAttemptBindingError(evidence, job, attempt);
}

function ensureApprovalOwnershipColumns(db: SqliteDatabase): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("owner_user_id")) db.exec("ALTER TABLE approvals ADD COLUMN owner_user_id TEXT");
  if (!columns.has("owner_chat_id")) db.exec("ALTER TABLE approvals ADD COLUMN owner_chat_id TEXT");
  if (!columns.has("job_version")) db.exec("ALTER TABLE approvals ADD COLUMN job_version INTEGER");
}

export type ControllerFailAndRetireOutcome = "retired" | "stale" | "accepted_won";
export type ControllerRecoveryOutcome = "requeued" | "stale" | "accepted_won" | "exhausted";
function parseLegacyJson(jsonText: unknown): unknown | null {
  if (typeof jsonText !== "string") return null;
  try {
    return JSON.parse(jsonText) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

type LegacyControllerQuestionRepair = Readonly<{
  invalid: LegacyControllerQuestionRow[];
}>;

type ValidatedLegacyControllerQuestion = Readonly<{
  questionsJson: string;
  answersJson: string | null;
  state: "pending" | "answered";
  answeredAt: number | null;
}>;

function nonNegativeLegacyTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function legacyQuestionAnswerIsSubstantive(
  answer: ControllerQuestionAnswers[string] | undefined,
): boolean {
  return (answer?.selected.length ?? 0) > 0 || (answer?.freeText?.trim().length ?? 0) > 0;
}

function legacyQuestionAnswerMapHasAllQuestionKeys(
  questions: readonly ControllerQuestion[],
  answers: ControllerQuestionAnswers,
): boolean {
  return questions.every((question) => Object.hasOwn(answers, question.id));
}

function legacyQuestionAnswerMapHasNonSubstantiveAnswer(
  questions: readonly ControllerQuestion[],
  answers: ControllerQuestionAnswers,
): boolean {
  return questions.some((question) => (
    Object.hasOwn(answers, question.id) && !legacyQuestionAnswerIsSubstantive(answers[question.id])
  ));
}

function legacyQuestionAnswersWithoutNonSubstantive(
  answers: ControllerQuestionAnswers,
): ControllerQuestionAnswers {
  const normalized: ControllerQuestionAnswers = {};
  for (const [questionId, answer] of Object.entries(answers)) {
    if (legacyQuestionAnswerIsSubstantive(answer)) normalized[questionId] = answer;
  }
  return normalized;
}

function legacyQuestionAnswerMapIsComplete(
  questions: readonly ControllerQuestion[],
  answers: ControllerQuestionAnswers,
): boolean {
  return nextUnansweredQuestion(questions, answers) === null && questions.every((question) => (
    legacyQuestionAnswerIsSubstantive(answers[question.id])
  ));
}

function sanitizedLegacyQuestionsJson(interactionId: string, jsonText: unknown): string {
  const questions = parseLegacyJson(jsonText);
  const interaction = parseControllerInteraction(interactionId, { kind: "user_question", questions });
  return interaction?.kind === "user_question" ? JSON.stringify(interaction.questions) : "[]";
}

function validateLegacyControllerQuestion(row: LegacyControllerQuestionRow): ValidatedLegacyControllerQuestion | null {
  if (row.state !== "pending" && row.state !== "answered") return null;
  const questions = parseLegacyJson(row.questions_json);
  const interaction = parseControllerInteraction(row.interaction_id, { kind: "user_question", questions });
  if (!interaction || interaction.kind !== "user_question") return null;
  if (row.answers_json === null) {
    return row.state === "pending"
      ? {
          questionsJson: JSON.stringify(interaction.questions),
          answersJson: null,
          state: "pending",
          answeredAt: null,
        }
      : null;
  }
  const answers = parseLegacyJson(row.answers_json);
  const resolution = parseControllerInteractionResolution(interaction, answers, row.state);
  if (!resolution || resolution.kind !== "user_answer") return null;
  const answerMap = resolution.answers as ControllerQuestionAnswers;
  if (legacyQuestionAnswerMapHasAllQuestionKeys(interaction.questions, answerMap) &&
      legacyQuestionAnswerMapHasNonSubstantiveAnswer(interaction.questions, answerMap)) return null;
  const normalizedAnswers = legacyQuestionAnswersWithoutNonSubstantive(answerMap);
  const complete = legacyQuestionAnswerMapIsComplete(
    interaction.questions,
    normalizedAnswers,
  );
  if (!complete && nextUnansweredQuestion(
    interaction.questions,
    normalizedAnswers,
  ) === null) return null;
  if (row.state === "answered" && !complete) return null;
  const answeredAt = complete
    ? nonNegativeLegacyTimestamp(row.answered_at) ?? nonNegativeLegacyTimestamp(row.asked_at)
    : null;
  if (complete && answeredAt === null) return null;
  return {
    questionsJson: JSON.stringify(interaction.questions),
    answersJson: JSON.stringify(normalizedAnswers),
    state: complete ? "answered" : "pending",
    answeredAt,
  };
}

function sanitizeLegacyControllerQuestionSources(db: SqliteDatabase): void {
  const rows = db.prepare(
    `SELECT rowid, interaction_id, questions_json, answers_json
       FROM controller_questions
      ORDER BY rowid ASC`,
  ).all() as Array<{
    rowid: number;
    interaction_id: unknown;
    questions_json: unknown;
    answers_json: unknown;
  }>;
  const update = db.prepare(
    `UPDATE controller_questions
        SET interaction_id = ?, questions_json = ?, answers_json = ?
      WHERE rowid = ?`,
  );
  for (const row of rows) {
    const interactionId = typeof row.interaction_id === "string" && row.interaction_id.length > 0
      ? row.interaction_id
      : `legacy-row-${row.rowid}`;
    const questionsJson = sanitizedLegacyQuestionsJson(interactionId, row.questions_json);
    const answersJson = row.answers_json === null || parseLegacyJson(row.answers_json) !== null
      ? row.answers_json
      : null;
    if (interactionId !== row.interaction_id || questionsJson !== row.questions_json || answersJson !== row.answers_json) {
      update.run(interactionId, questionsJson, answersJson, row.rowid);
    }
  }
}

function validateLegacyControllerQuestions(db: SqliteDatabase): LegacyControllerQuestionRepair {
  const rows = db.prepare(
    `SELECT rowid, interaction_id, turn_id, controller_key, questions_json, state,
            answers_json, asked_at, answered_at
       FROM controller_questions
      WHERE state IN ('pending', 'answered')
      ORDER BY rowid ASC`,
  ).all() as LegacyControllerQuestionRow[];
  const invalid: LegacyControllerQuestionRow[] = [];
  const stale = db.prepare(
    `UPDATE controller_questions
        SET state = 'delivered', answers_json = NULL, answered_at = COALESCE(answered_at, asked_at)
      WHERE interaction_id = ? AND state IN ('pending', 'answered')`,
  );
  for (const row of rows) {
    const projection = validateLegacyControllerQuestion(row);
    const identity = typeof row.turn_id === "string" && typeof row.controller_key === "string" &&
      db.prepare(
        `SELECT 1
           FROM controller_turns AS turn
           JOIN controller_threads AS controller
             ON controller.controller_key = turn.controller_key
            AND controller.state = 'active'
            AND controller.bb_thread_id IS NOT NULL
           JOIN controller_generations AS generation
             ON generation.controller_key = controller.controller_key
            AND generation.thread_id = controller.bb_thread_id
            AND generation.ended_at IS NULL
          WHERE turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
            AND (SELECT COUNT(*) FROM controller_generations AS open_generation
                  WHERE open_generation.controller_key = controller.controller_key
                    AND open_generation.ended_at IS NULL) = 1`,
      ).get(row.turn_id, row.controller_key) !== undefined;
    if (projection && identity) {
      db.prepare(
        `UPDATE controller_questions
            SET questions_json = ?, answers_json = ?, state = ?, answered_at = ?
          WHERE rowid = ? AND state IN ('pending', 'answered')`,
      ).run(
        projection.questionsJson,
        projection.answersJson,
        projection.state,
        projection.answeredAt,
        row.rowid,
      );
      continue;
    }
    invalid.push(row);
    const safeInteractionId = typeof row.interaction_id === "string" && row.interaction_id.length > 0
      ? row.interaction_id
      : `legacy-row-${row.rowid}`;
    if (safeInteractionId !== row.interaction_id) {
      db.prepare("UPDATE controller_questions SET interaction_id = ? WHERE rowid = ?")
        .run(safeInteractionId, row.rowid);
    }
    stale.run(safeInteractionId);
  }
  sanitizeLegacyControllerQuestionSources(db);
  return { invalid };
}

function jsonValue(jsonText: string | null): unknown {
  if (jsonText === null) return null;
  try {
    return JSON.parse(jsonText) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

type RepairQuarantineRow = Readonly<{
  source: "controller" | "thread" | "controller_questions";
  interaction_id: string;
  turn_id: string | null;
  controller_key: string | null;
  bb_thread_id: string | null;
  controller_generation_id: string | null;
  thread_id: string | null;
  title: string | null;
  kind: string;
  payload_json: string;
  answer_json: string | null;
  prior_state: "pending" | "answered";
  asked_at: number;
  answered_at: number | null;
  quarantined_at: number;
  consumed_at: number | null;
}>;

function isCurrentControllerInteractionIdentity(
  db: SqliteDatabase,
  row: RepairQuarantineRow,
): boolean {
  if (row.turn_id === null || row.controller_key === null ||
      row.bb_thread_id === null || row.controller_generation_id === null) return false;
  return db.prepare(
    `SELECT 1
       FROM controller_turns AS turn
       JOIN controller_threads AS controller
         ON controller.controller_key = turn.controller_key
        AND controller.state = 'active'
        AND controller.bb_thread_id = ?
       JOIN controller_generations AS generation
         ON generation.id = ?
        AND generation.controller_key = controller.controller_key
        AND generation.thread_id = controller.bb_thread_id
        AND generation.ended_at IS NULL
      WHERE turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
        AND (SELECT COUNT(*) FROM controller_generations AS open_generation
              WHERE open_generation.controller_key = controller.controller_key
                AND open_generation.ended_at IS NULL) = 1`,
  ).get(row.bb_thread_id, row.controller_generation_id, row.turn_id, row.controller_key) !== undefined;
}

function restoreQuarantinedControllerQuestion(
  db: SqliteDatabase,
  row: RepairQuarantineRow,
): boolean {
  if (row.source !== "controller" || row.kind !== "user_question" ||
      !isCurrentControllerInteractionIdentity(db, row)) return false;
  const payload = jsonValue(row.payload_json);
  const interaction = parseControllerInteraction(row.interaction_id, payload);
  if (!interaction || interaction.kind !== "user_question") return false;
  const rawAnswer = jsonValue(row.answer_json);
  const resolution = rawAnswer === null
    ? null
    : parseControllerInteractionResolution(interaction, rawAnswer, row.prior_state);
  if (row.answer_json !== null && resolution === null) return false;
  if (row.prior_state === "answered" && resolution === null) return false;
  const answers: ControllerQuestionAnswers = resolution?.kind === "user_answer"
    ? resolution.answers as ControllerQuestionAnswers
    : {};
  if (legacyQuestionAnswerMapHasAllQuestionKeys(interaction.questions, answers) &&
      legacyQuestionAnswerMapHasNonSubstantiveAnswer(interaction.questions, answers)) return false;
  const normalizedAnswers = legacyQuestionAnswersWithoutNonSubstantive(answers);
  const next = nextUnansweredQuestion(interaction.questions, normalizedAnswers);
  const complete = legacyQuestionAnswerMapIsComplete(interaction.questions, normalizedAnswers);
  if (!complete && next === null) return false;
  if (row.prior_state === "answered" && !complete) return false;
  const restoredState: "pending" | "answered" = complete ? "answered" : "pending";
  const restoredAnsweredAt = restoredState === "answered"
    ? row.answered_at ?? row.asked_at
    : null;
  const restored = db.prepare(
    `UPDATE controller_interactions
        SET bb_thread_id = ?, controller_generation_id = ?, kind = 'user_question',
            payload_json = ?, state = ?, answer_json = ?, answered_at = ?, delivered_at = NULL
      WHERE interaction_id = ? AND state = 'delivered'`,
  ).run(
    row.bb_thread_id,
    row.controller_generation_id,
    JSON.stringify(interaction),
    restoredState,
    resolution ? JSON.stringify({ kind: "user_answer", answers: normalizedAnswers }) : null,
    restoredAnsweredAt,
    row.interaction_id,
  );
  if (restored.changes !== 1) return false;
  if (restoredState !== "pending") return true;
  const controller = db.prepare(
    "SELECT telegram_chat_id FROM controller_threads WHERE controller_key = ?",
  ).get(row.controller_key) as { telegram_chat_id: string } | undefined;
  if (!controller) return false;
  if (!next) return true;
  const rendered = renderControllerInteraction(interaction, normalizedAnswers);
  if (!("reply_markup" in rendered)) return true;
  persistControllerOutbox(db, {
    logicalKey: `controller-interaction:${row.interaction_id}:${next.index}`,
    chatId: controller.telegram_chat_id,
    payload: {
      ...formattedMessage(rendered.text),
      reply_markup: rendered.reply_markup,
      disable_web_page_preview: true,
    },
  }, row.asked_at);
  return true;
}

function restoreQuarantinedThreadQuestion(
  db: SqliteDatabase,
  row: RepairQuarantineRow,
): boolean {
  if (row.source !== "thread" || row.kind !== "user_question") return false;
  const interaction = parseThreadInteraction(row.interaction_id, jsonValue(row.payload_json));
  if (!interaction || interaction.kind !== "user_question") return false;
  const rawAnswer = jsonValue(row.answer_json);
  const resolution = rawAnswer === null
    ? null
    : parseControllerInteractionResolution(interaction, rawAnswer, row.prior_state);
  if (row.answer_json !== null && resolution === null) return false;
  if (row.prior_state === "answered" && resolution === null) return false;
  const answers: ControllerQuestionAnswers = resolution?.kind === "user_answer"
    ? resolution.answers as ControllerQuestionAnswers
    : {};
  if (legacyQuestionAnswerMapHasAllQuestionKeys(interaction.questions, answers) &&
      legacyQuestionAnswerMapHasNonSubstantiveAnswer(interaction.questions, answers)) return false;
  const normalizedAnswers = legacyQuestionAnswersWithoutNonSubstantive(answers);
  const next = nextUnansweredQuestion(interaction.questions, normalizedAnswers);
  const complete = legacyQuestionAnswerMapIsComplete(interaction.questions, normalizedAnswers);
  if (!complete && next === null) return false;
  if (row.prior_state === "answered" && !complete) return false;
  const restoredState: "pending" | "answered" = complete ? "answered" : "pending";
  const restoredAnsweredAt = restoredState === "answered"
    ? row.answered_at ?? row.asked_at
    : null;
  const restored = db.prepare(
    `UPDATE thread_interactions
        SET kind = 'user_question', payload_json = ?, state = ?, answer_json = ?, answered_at = ?
      WHERE interaction_id = ? AND state = 'delivered'`,
  ).run(
    JSON.stringify(interaction),
    restoredState,
    resolution ? JSON.stringify({ kind: "user_answer", answers: normalizedAnswers }) : null,
    restoredAnsweredAt,
    row.interaction_id,
  );
  if (restored.changes !== 1) return false;
  if (restoredState !== "pending" || row.thread_id === null || row.title === null) return true;
  const rendered = renderThreadInteraction(row.title, interaction);
  if (!("reply_markup" in rendered)) return true;
  const existing = db.prepare(
    "SELECT chat_id FROM outbox WHERE logical_key = ?",
  ).get(`thread-interaction:${row.interaction_id}`) as { chat_id: string } | undefined;
  if (!existing) return true;
  persistControllerOutbox(db, {
    logicalKey: `thread-interaction:${row.interaction_id}`,
    chatId: existing.chat_id,
    payload: {
      ...formattedMessage(rendered.text),
      reply_markup: rendered.reply_markup,
      disable_web_page_preview: true,
    },
  }, row.asked_at);
  return true;
}

function quarantineLegacyControllerQuestions(
  db: SqliteDatabase,
  rows: readonly LegacyControllerQuestionRow[],
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO controller_interaction_quarantine (
       source, interaction_id, turn_id, controller_key, bb_thread_id,
       controller_generation_id, thread_id, title, kind, payload_json, answer_json,
       prior_state, asked_at, answered_at, quarantined_at
     ) VALUES ('controller_questions', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const clearOutbox = db.prepare(
    `UPDATE outbox
        SET payload_json = ?,
            status = 'pending', lease_owner = NULL, lease_generation = NULL,
            lease_expires_at = NULL, next_attempt_at = updated_at, last_error = NULL
      WHERE substr(logical_key, 1, length('controller-interaction:' || ? || ':')) =
            'controller-interaction:' || ? || ':'`,
  );
  for (const row of rows) {
    const interactionId = typeof row.interaction_id === "string" && row.interaction_id.length > 0
      ? row.interaction_id
      : `legacy-row-${row.rowid}`;
    const state = row.state === "answered" ? "answered" : "pending";
    const askedAt = typeof row.asked_at === "number" && Number.isSafeInteger(row.asked_at) && row.asked_at >= 0
      ? row.asked_at
      : 0;
    const answeredAt = typeof row.answered_at === "number" && Number.isSafeInteger(row.answered_at) && row.answered_at >= 0
      ? row.answered_at
      : null;
    insert.run(
      interactionId,
      typeof row.turn_id === "string" ? row.turn_id : null,
      typeof row.controller_key === "string" ? row.controller_key : null,
      "user_question",
      typeof row.questions_json === "string" ? row.questions_json : String(row.questions_json ?? ""),
      typeof row.answers_json === "string" ? row.answers_json : null,
      state,
      askedAt,
      answeredAt,
      askedAt,
    );
    clearOutbox.run(RETIRED_CONTROLLER_INTERACTION_PAYLOAD, interactionId, interactionId);
  }
}

function restoreQuarantinedInteractions(db: SqliteDatabase): void {
  const rows = db.prepare(
    `SELECT source, interaction_id, turn_id, controller_key, bb_thread_id,
            controller_generation_id, thread_id, title, kind, payload_json, answer_json,
            prior_state, asked_at, answered_at, quarantined_at, consumed_at
       FROM controller_interaction_quarantine
      WHERE consumed_at IS NULL
      ORDER BY quarantined_at ASC, interaction_id ASC`,
  ).all() as RepairQuarantineRow[];
  const consume = db.prepare(
    `UPDATE controller_interaction_quarantine
        SET consumed_at = ?
      WHERE source = ? AND interaction_id = ? AND consumed_at IS NULL`,
  );
  for (const row of rows) {
    if (row.source === "controller") restoreQuarantinedControllerQuestion(db, row);
    else if (row.source === "thread") restoreQuarantinedThreadQuestion(db, row);
    consume.run(row.quarantined_at, row.source, row.interaction_id);
  }
  db.prepare(
    `UPDATE controller_turns AS turn
        SET awaiting_interaction_id = (
          SELECT interaction.interaction_id
            FROM controller_interactions AS interaction
           WHERE interaction.turn_id = turn.id
             AND interaction.state IN ('pending', 'answered')
           ORDER BY interaction.asked_at ASC, interaction.interaction_id ASC
           LIMIT 1
        )
      WHERE EXISTS (
        SELECT 1 FROM controller_interactions AS interaction
         WHERE interaction.turn_id = turn.id
           AND interaction.state IN ('pending', 'answered')
      )`,
  ).run();
}

function hasMigration(db: SqliteDatabase, migrationId: number): boolean {
  return db.prepare("SELECT 1 FROM _bb_migrations WHERE id = ?").get(migrationId) !== undefined;
}

type OpenControllerGenerationRow = Readonly<{
  id: string;
  controller_key: string;
  thread_id: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
}>;

type ControllerGenerationRepair = Readonly<{
  controllerKey: string;
  telegramChatId: string | null;
  now: number;
  reason: typeof CONTROLLER_GENERATION_QUARANTINE_REASON | typeof CONTROLLER_GENERATION_MISMATCH_REASON;
  generations: readonly OpenControllerGenerationRow[];
}>;

function listOpenControllerGenerations(
  db: SqliteDatabase,
  controllerKey: string,
): OpenControllerGenerationRow[] {
  return db.prepare(
    `SELECT id, controller_key, thread_id, started_at, ended_at, end_reason
       FROM controller_generations
      WHERE controller_key = ? AND ended_at IS NULL
      ORDER BY id ASC`,
  ).all(controllerKey) as OpenControllerGenerationRow[];
}

function quarantineControllerGenerationEvidence(
  db: SqliteDatabase,
  repair: ControllerGenerationRepair,
): void {
  const quarantine = db.prepare(
    `INSERT INTO controller_generation_quarantine (
       generation_id, controller_key, thread_id, started_at,
       original_ended_at, original_end_reason, quarantined_at, reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const generation of repair.generations) {
    quarantine.run(
      generation.id,
      generation.controller_key,
      generation.thread_id,
      generation.started_at,
      generation.ended_at,
      generation.end_reason,
      repair.now,
      repair.reason,
    );
  }
}

function closeCorruptControllerGenerations(
  db: SqliteDatabase,
  repair: ControllerGenerationRepair,
): void {
  db.prepare(
    `UPDATE controller_generations
        SET ended_at = ?, end_reason = ?
      WHERE controller_key = ? AND ended_at IS NULL`,
  ).run(repair.now, CONTROLLER_GENERATION_RECOVERY_END_REASON, repair.controllerKey);
}

function preserveControllerTurnsForGenerationRecovery(
  db: SqliteDatabase,
  repair: ControllerGenerationRepair,
): void {
  db.prepare(
    `UPDATE controller_turns
        SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
            dispatch_after_seq = 0, bb_event_seq = 0, evidence_event_seq = 0,
            completion_continuations = 2, input_accepted = 0,
            stream_text = '', stream_phase = 'queued', submitted_at = NULL,
            last_error = ?, updated_at = ?
      WHERE controller_key = ? AND state IN ('dispatching', 'submitted')`,
  ).run(CONTROLLER_GENERATION_RECOVERY_ERROR, repair.now, repair.controllerKey);
}

function clearCorruptControllerMapping(
  db: SqliteDatabase,
  repair: ControllerGenerationRepair,
): void {
  db.prepare(
    `UPDATE controller_threads
        SET project_id = NULL, host_id = NULL, bb_thread_id = NULL,
            state = CASE WHEN state = 'revoked' THEN 'revoked' ELSE 'pending_spawn' END,
            pending_spawn_token = NULL,
            capability_subject_id = NULL, capability_profile_id = NULL,
            capability_profile_revision = 0, last_error = NULL, updated_at = ?
      WHERE controller_key = ?`,
  ).run(repair.now, repair.controllerKey);
}

function enqueueControllerGenerationRecoveryNotice(
  db: SqliteDatabase,
  repair: ControllerGenerationRepair,
): void {
  if (repair.telegramChatId === null) return;
  persistControllerOutbox(db, {
    logicalKey: `controller-generation-recovery:${repair.controllerKey}`,
    chatId: repair.telegramChatId,
    payload: {
      text: CONTROLLER_FAILURE_TEXT.owner_message_delivery_uncertain,
      disable_web_page_preview: true,
    },
  }, repair.now);
}

function repairControllerGenerationSet(
  db: SqliteDatabase,
  repair: ControllerGenerationRepair,
): void {
  quarantineControllerGenerationEvidence(db, repair);
  closeCorruptControllerGenerations(db, repair);
  preserveControllerTurnsForGenerationRecovery(db, repair);
  clearCorruptControllerMapping(db, repair);
  enqueueControllerGenerationRecoveryNotice(db, repair);
}

function repairControllerGenerationInvariant(
  db: SqliteDatabase,
  input: Readonly<{
    controllerKey: string;
    expectedThreadId: string;
    telegramChatId: string;
    now: number;
  }>,
): boolean {
  const generations = listOpenControllerGenerations(db, input.controllerKey);
  if (generations.length === 1 && generations[0]?.thread_id === input.expectedThreadId) return false;
  repairControllerGenerationSet(db, {
    ...input,
    reason: generations.length > 1
      ? CONTROLLER_GENERATION_QUARANTINE_REASON
      : CONTROLLER_GENERATION_MISMATCH_REASON,
    generations,
  });
  return true;
}

function preflightControllerGenerationConstraint(db: SqliteDatabase, now: number): void {
  const duplicates = db.prepare(
    `SELECT generation.controller_key, controller.telegram_chat_id
       FROM controller_generations AS generation
       LEFT JOIN controller_threads AS controller
         ON controller.controller_key = generation.controller_key
      WHERE generation.ended_at IS NULL
      GROUP BY generation.controller_key, controller.telegram_chat_id
     HAVING COUNT(*) > 1
      ORDER BY generation.controller_key ASC`,
  ).all() as Array<{ controller_key: string; telegram_chat_id: string | null }>;
  for (const duplicate of duplicates) {
    repairControllerGenerationSet(db, {
      controllerKey: duplicate.controller_key,
      telegramChatId: duplicate.telegram_chat_id,
      now,
      reason: CONTROLLER_GENERATION_QUARANTINE_REASON,
      generations: listOpenControllerGenerations(db, duplicate.controller_key),
    });
  }
}

export function migrateControllerInteractionStorage(
  storage: PluginStorage,
  now: number = Date.now(),
): void {
  assertNonNegativeInteger(now, "controller generation migration time");
  const db = storage.database();
  storage.migrate(db, ALL_MIGRATIONS.slice(0, CONTROLLER_INTERACTION_TAIL_ID));
  if (hasMigration(db, CONTROLLER_INTERACTION_TAIL_ID)) {
    storage.migrate(db, ALL_MIGRATIONS.slice(0, CONTROLLER_GENERATION_CONSTRAINT_ID));
    db.transaction(() => {
      restoreQuarantinedInteractions(db);
      preflightControllerGenerationConstraint(db, now);
      storage.migrate(db, [...ALL_MIGRATIONS]);
    }).immediate();
    return;
  }
  db.transaction(() => {
    const legacy = validateLegacyControllerQuestions(db);
    storage.migrate(db, ALL_MIGRATIONS.slice(0, CONTROLLER_GENERATION_CONSTRAINT_ID));
    quarantineLegacyControllerQuestions(db, legacy.invalid);
    restoreQuarantinedInteractions(db);
    preflightControllerGenerationConstraint(db, now);
    storage.migrate(db, [...ALL_MIGRATIONS]);
  }).immediate();
}

export interface TelegramAgentStore {
  createCapabilityProfile(input: CreateCapabilityProfileInput): CapabilityProfile;
  appendCapabilityReceipt(input: AppendCapabilityReceiptInput): CapabilityReceipt;
  appendCapabilityTerminalOutcome(input: AppendCapabilityTerminalInput): boolean;
  recordGuardFingerprint(input: GuardFingerprintPersistenceInput): number;
  settleGuardOutcomes(input: GuardSettlementPersistenceInput): GuardSettlementPersistenceResult;
  getActiveCapabilityProfile(
    subjectKind: CapabilitySubjectKind,
    subjectId: string,
  ): CapabilityProfile | null;
  getLatestCapabilityProfile(
    subjectKind: CapabilitySubjectKind,
    subjectId: string,
  ): CapabilityProfile | null;
  getCapabilityProfileById(profileId: string): CapabilityProfile | null;
  getCapabilityProfileForThread(threadId: string): CapabilityProfile | null;
  listCapabilityReceipts(profileId: string, limit: number): CapabilityReceipt[];
  listSkillReceiptProjection(profileId: string, limit: number): SkillReceiptProjection[];
  listMissingMandatoryCapabilityOutcomes(profileId: string): string[];
  recordModelRouteSelection(input: RecordModelRouteSelectionInput): ModelRouteTrial;
  settleModelRouteTrial(input: SettleModelRouteTrialInput): ModelRouteTrial;
  listModelRouteTrials(
    subjectKind: CapabilitySubjectKind,
    subjectId: string,
    limit: number,
  ): ModelRouteTrial[];
  recordStageExecution(input: RecordStageExecutionInput): StageExecutionRecord;
  settleStageExecution(input: SettleStageExecutionInput): StageExecutionRecord | null;
  listStageExecutions(jobId: string, limit?: number): StageExecutionRecord[];
  replaceExternalCapabilityInventory(input: {
    hostScope: string;
    items: readonly CapabilityInventoryItem[];
    now: number;
  }): void;
  recordExternalInventoryDiscoveryFailure(input: {
    hostScope: string;
    errorClass: string;
    now: number;
  }): void;
  listExternalCapabilityInventory(hostScope: string, limit: number): CapabilityInventoryItem[];
  getExternalCapabilityInventoryHealth(hostScope: string): (InventoryHealth & { hostScope: string }) | null;
  readDurableRecipePromotionEvidenceSnapshot(recipe: TaskRecipe): unknown | null;
  appendRecipeRolloutDecision(input: AppendRecipeRolloutDecisionInput): RecipeRolloutDecision;
  listRecipeRolloutDecisions(recipe: TaskRecipe, limit: number): RecipeRolloutDecision[];
  getLatestRecipeRolloutDecision(recipe: TaskRecipe): RecipeRolloutDecision | null;
  createPairingCode(codeHash: string, createdAt: number, expiresAt: number): void;
  pairOwnerWithCode(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
  ): PairingResult;
  pairOwnerWithPrivateChatCode(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
  ): PairingResult;
  getOwner(): Owner | null;
  revokeOwner(now: number): boolean;
  enqueueControllerTurn(input: {
    controllerKey: string;
    telegramUserId: string;
    telegramChatId: string;
    updateId: number;
    inputText: string;
    image?: ControllerImage | null;
    origin?: "owner" | "system";
    threadFollowUp?: ThreadFollowUp;
    now: number;
  }): ControllerTurnRecord;
  getControllerByThreadId(threadId: string): ControllerThreadRecord | null;
  getControllerForPendingSpawn(input: {
    controllerKey: string;
    turnId: string;
    pendingSpawnToken: string;
    now: number;
  }): ControllerThreadRecord | null;
  getControllerForOwner(userId: string, chatId: string): ControllerThreadRecord | null;
  getControllerTurn(turnId: string): ControllerTurnRecord | null;
  requestControllerCapabilityExpansion(input: {
    controllerKey: string;
    turnId: string;
    expectedProfileId: string;
    bundleIds: readonly string[];
    now: number;
  }): ControllerCapabilityExpansionResult;
  prepareControllerCapabilityContinuation(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    expectedThreadId: string;
  }): boolean;
  adoptSubmittedControllerTurnFence(
    input: ControllerLeaseFence & Readonly<{ turnId: string }>,
  ): boolean;
  recordControllerEvidence(input: ControllerEvidenceInput): ControllerEvidenceWrite;
  settleToolReceiptAndRecordEvidence(
    input: ControllerToolReceiptSettlementInput,
  ): ControllerEvidenceWrite;
  recordControllerNativeEvidence(
    input: ControllerNativeEvidenceInput,
  ): ControllerNativeEvidenceWrite;
  listControllerEvidence(turnId: string, limit: number): ControllerEvidenceRecord[];
  /** Evidence rows recorded so far, which is what the evidence budget reads. */
  countControllerEvidence(turnId: string): number;
  getControllerEvidence(turnId: string, evidenceId: number): ControllerEvidenceRecord | null;
  proposeControllerFinalization(
    input: ControllerFinalizationProposalInput,
  ): ControllerFinalizationProposalResult;
  getAcceptedControllerFinalization(turnId: string): AcceptedControllerFinalization | null;
  claimControllerCompletionContinuation(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    bbHighWaterSeq: number;
  }): "claimed" | "already_claimed" | "stale";
  completeControllerTurnFromFinalization(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    /** The accepted finalization's provider high-water marker, or legacy cursor. */
    bbHighWaterSeq: number;
  }): "completed" | "stale" | "evidence_advanced";
  /** Record what the controller asked a worker thread to do, for the owner. */
  recordControllerThreadAsk(input: {
    controllerKey: string;
    turnId: string;
    threadId: string;
    threadName: string | null;
    ask: string;
    now: number;
  }): void;
  /** Asks this controller has not yet told the owner about, oldest first. */
  unreportedControllerThreadAsks(controllerKey: string): RecordedThreadAsk[];
  claimNextControllerTurn(fence: ControllerLeaseFence & { leaseMs?: number }): ControllerTurnRecord | null;
  prepareControllerDispatch(input: ControllerLeaseFence & {
    turnId: string;
    kind: ControllerDispatchKind;
    expectedThreadId?: string;
    dispatchAfterSeq?: number;
  }): boolean;
  markControllerDeliveryUnknown(input: ControllerLeaseFence & { turnId: string }): boolean;
  recordControllerDeliveryReconciliationPending(input: ControllerLeaseFence & {
    turnId: string;
    retryAfterMs: number;
  }): ControllerDeliveryReconciliationResult;
  reserveControllerSpawn(input: {
    controllerKey: string;
    turnId: string;
    projectId: string;
    hostId: string;
    now: number;
  }): boolean;
  requeueControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    retryAfterMs?: number;
    error?: string;
    incrementDispatchRetry?: boolean;
  }): boolean;
  recordControllerBusyWaitNotice(input: ControllerLeaseFence & { turnId: string }): boolean;
  recordControllerImagePreparationFailure(input: ControllerLeaseFence & {
    turnId: string;
    incrementRetry?: boolean;
  }): boolean;
  failStaleControllerDispatches(fence: ControllerLeaseFence): boolean;
  markControllerSpawned(input: ControllerLeaseFence & {
    turnId: string;
    projectId: string;
    hostId: string;
    threadId: string;
    /** Older in-process callers omit this; the durable turn id is the only accepted fallback. */
    spawnToken?: string;
    leaseMs?: number;
  }): boolean;
  markControllerTurnSubmitted(input: ControllerLeaseFence & {
    turnId: string;
    dispatchAfterSeq?: number;
    leaseMs?: number;
  }): boolean;
  retryUnacceptedControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    expectedThreadId: string;
    nextFallbackIndex: number;
  }): boolean;
  updateControllerStream(input: ControllerLeaseFence & {
    turnId: string;
    cursor: number;
    phase: ControllerTurnRecord["streamPhase"];
    toolCalls?: number;
    commandFailures?: number;
    totalTokens?: number;
  } & Record<string, unknown>): boolean;
  claimControllerSupervisorSteer(input: ControllerSupervisorSteerClaimInput): ControllerSupervisorSteerClaim;
  getControllerSupervisorSteerAttempt(
    turnId: string,
    reason: SupervisorReason,
  ): ControllerSupervisorSteerAttempt | null;
  getPendingControllerSupervisorSteer(turnId: string): ControllerSupervisorSteerAttempt | null;
  settleControllerSupervisorSteer(input: ControllerSupervisorSteerSettlementInput): "settled" | "stale";
  refreshControllerDraft(input: ControllerLeaseFence & {
    turnId: string;
    sentBefore: number;
  }): boolean;
  recordControllerInteraction(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    bbThreadId: string;
    controllerGenerationId: string;
    interaction: ControllerInteraction;
  }): ControllerInteractionRecordOutcome;
  markControllerInteractionResolved(input: ControllerLeaseFence & {
    interactionId: string;
    turnId: string;
    bbThreadId: string;
  }): boolean;
  answerControllerInteractionByToken(input: {
    token: string;
    userId: string;
    chatId: string;
    now: number;
  }): ControllerInteractionAnswer;
  answerControllerInteractionByToken(input: {
    token: string;
    userId: string;
    chatId: string;
    callbackId: string;
    now: number;
  }): ControllerInteractionCallbackAnswer;
  answerControllerInteractionWithText(input: {
    controllerKey: string;
    userId: string;
    chatId: string;
    text: string;
    now: number;
  }): ControllerInteractionAnswer;
  answerControllerInteractionWithText(input: {
    controllerKey: string;
    userId: string;
    chatId: string;
    text: string;
    now: number;
    settleUpdateId?: number;
  }): ControllerInteractionAnswer & { updateSettled: boolean };
  answerControllerInteractionTextUpdate(input: {
    updateId: number;
    controllerKey: string;
    userId: string;
    chatId: string;
    text: string;
    now: number;
  }): ControllerInteractionTextUpdateResult;
  answerControllerInteractionByTokenAndRecordCallback(input: {
    token: string;
    userId: string;
    chatId: string;
    callbackId: string;
    now: number;
  }): ControllerInteractionCallbackResult;
  getPendingControllerInteraction(controllerKey: string): ControllerInteractionRecord | null;
  getAnsweredControllerInteraction(controllerKey: string): ControllerInteractionDelivery | null;
  markControllerInteractionDelivered(input: ControllerLeaseFence & {
    interactionId: string;
    turnId: string;
    bbThreadId: string;
  }): boolean;
  observeThread(input: {
    threadId: string;
    title: string;
    status: string;
    userId: string;
    chatId: string;
    now: number;
  }): "finished" | "failed" | null;
  recordThreadInteraction(input: {
    interactionId: string;
    threadId: string;
    title: string;
    interaction: ThreadInteraction;
    chatId: string;
    now: number;
    parentThreadId?: string | null;
  }): boolean;
  isControllerOwnedThread(parentThreadId: string | null): boolean;
  answerThreadInteraction(input: {
    token: string;
    userId: string;
    chatId: string;
    now: number;
  }): ThreadInteractionAnswer;
  answerThreadInteractionAsController(input: {
    interactionId: string;
    threadId: string;
    decision?: ThreadApprovalDecision;
    answers?: ControllerQuestionAnswers;
    now: number;
  }): { ok: true } | { ok: false; reason: "unknown" | "not_controller_routed" | "decision_not_allowed" };
  getAnsweredThreadInteraction(): ThreadInteractionDelivery | null;
  markThreadInteractionDelivered(interactionId: string, now: number): boolean;
  discardThreadInteractions(threadId: string, keep: readonly string[], now?: number): number;
  getPendingControllerInteraction(controllerKey: string): ControllerInteractionRecord | null;
  getAnsweredControllerInteraction(controllerKey: string): ControllerInteractionDelivery | null;
  hasActiveControllerInteraction(turnId: string, controllerKey: string): boolean;
  markControllerInteractionResolved(input: ControllerLeaseFence & {
    interactionId: string;
    turnId: string;
    bbThreadId: string;
  }): boolean;
  controllerInteractionSourceCanRecord(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    bbThreadId: string;
    controllerGenerationId: string;
  }): boolean;
  getOpenControllerGeneration(controllerKey: string, threadId: string): ControllerGeneration | null;
  canMutateControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    expectedThreadId?: string | null;
  }): boolean;
  getQueuedControllerTurn(controllerKey: string): ControllerTurnRecord | null;
  getControllerSteerReservation(controllerKey: string): ControllerSteerReservation | null;
  reserveControllerSteer(input: ControllerLeaseFence & {
    runningTurnId: string;
    waitingTurnId: string;
    controllerKey: string;
    expectedThreadId: string;
  }): boolean;
  settleControllerSteer(input: ControllerSteerSettlementInput): ControllerSteerSettlementResult;
  recordControllerSteerFailure(input: ControllerLeaseFence & {
    runningTurnId: string;
    waitingTurnId: string;
  }): boolean;
  foldControllerTurnIntoRunning(input: ControllerLeaseFence & {
    runningTurnId: string;
    waitingTurnId: string;
  }): boolean;
  resetControllerThread(input: ControllerLeaseFence & {
    controllerKey: string;
    expectedThreadId: string;
    reason?: string;
  }): boolean;
  failControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    error: string;
    failureCode?: ControllerFailureCode;
    leaseMs?: number;
  }): boolean;
  failAndRetireControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    expectedThreadId: string;
    error: string;
    failureCode?: ControllerFailureCode;
    expectedAcceptedFinalizationId?: number | null;
  }): ControllerFailAndRetireOutcome;
  beginControllerRecovery(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    expectedThreadId: string;
    error: string;
    nextFallbackIndex: number;
  }): ControllerRecoveryOutcome;
  listControllerTurns(controllerKey: string, limit: number): ControllerTurnRecord[];
  getPendingControllerTurn(controllerKey: string): ControllerTurnRecord | null;
  claimToolReceipt(input: ToolReceiptClaimInput): ToolReceiptClaim;
  completeToolReceipt(input: ToolReceiptKey & { result: string; now: number }): void;
  failToolReceipt(input: ToolReceiptKey & Readonly<{
    error: string;
    now: number;
    controllerKey?: string;
    ownerId?: string;
    generation?: number;
  }>): void;
  listToolReceipts(turnId: string): { toolName: string; state: string; result: string | null }[];
  listControllerGenerations(controllerKey: string, limit: number): ControllerGeneration[];
  createMonitor(input: {
    controllerKey: string;
    kind: MonitorKind;
    threadId?: string;
    cron?: string;
    instruction: string;
    dueAt: number | null;
    now: number;
  }): MonitorRecord;
  ensureThreadWatch(input: {
    controllerKey: string;
    threadId: string;
    instruction: string;
    dueAt: number;
    now: number;
    mode: "courtesy" | "explicit";
  }): MonitorRecord | null;
  getProductionHealth(projectId: string): ProductionHealthRecord | null;
  recordProductionHealth(input: {
    projectId: string;
    ok: boolean;
    summary: string;
    failureThreshold: number;
    now: number;
  }): ProductionHealthRecord;
  recordProductionHealthReported(input: {
    projectId: string;
    state: ProductionHealthState;
    now: number;
  }): boolean;
  getMergeAuthority(projectId: string): MergeAuthorityGrant | null;
  grantMergeAuthority(input: {
    projectId: string;
    userId: string;
    chatId: string;
    now: number;
  }): MergeAuthorityGrant;
  revokeMergeAuthority(input: {
    projectId: string;
    reason: string;
    now: number;
    userId?: string;
    chatId?: string;
  }): boolean;
  recordMergeAuthorityUse(input: { projectId: string; jobId: string; now: number }): void;
  listMergeAuthorityEvents(projectId: string, limit?: number): MergeAuthorityEvent[];
  getRegressionWatch(projectId: string): RegressionWatchRecord | null;
  recordRegressionReading(input: {
    projectId: string;
    confirmed: readonly string[];
    flaky: readonly string[];
    summary: string;
    now: number;
  }): RegressionWatchRecord;
  recordRegressionReported(input: {
    projectId: string;
    reported: readonly string[];
    now: number;
  }): boolean;
  listRecentJobFailures(input: { since: number; limit: number }): {
    jobId: string;
    projectId: string | null;
    reason: string | null;
    failedAt: number;
  }[];
  claimFailureEscalation(input: {
    fingerprint: string;
    projectId: string | null;
    clusterSize: number;
    reason: string;
    now: number;
    dedupMs: number;
  }): boolean;
  /**
   * True the first time a housekeeping notice is claimed inside its window.
   * The agent's own upkeep speaks once and then stays quiet.
   */
  claimHousekeepingNotice(input: {
    key: string;
    detail: string;
    now: number;
    dedupMs: number;
  }): boolean;
  pauseProjectAdmission(input: {
    projectId: string;
    reason: string;
    fingerprint: string | null;
    now: number;
  }): boolean;
  listPausedProjectAdmissions(): { projectId: string; reason: string; pausedAt: number }[];
  clearProjectAdmissionPause(input: { projectId?: string; now: number }): number;
  listSystemMonitors(): MonitorRecord[];
  cancelSystemMonitors(now: number): number;
  ensureSystemMonitor(input: {
    systemKey: string;
    controllerKey: string;
    cron: string;
    instruction: string;
    dueAt: number;
    now: number;
  }): MonitorRecord;
  buildAutonomyScorecard(input: { now: number; windowMs: number }): {
    windowMs: number;
    jobs: Record<string, number>;
    blockedJobs: { id: string; projectId: string | null; reason: string | null; updatedAt: number }[];
    projectsHeldByFailedJobs: { jobId: string; projectId: string | null; failedAt: number }[];
    remediationCycles: number;
    approvalsRequested: number;
    approvalsConsumed: number;
    deliveryRetries: number;
    undeliverable: number;
    memory: { live: number; tombstoned: number; superseded: number; lowConfidence: number; extracted: number };
    monitors: { armed: number; system: number; failed: number };
  };
  getControllerOverlay(): string | null;
  setControllerOverlay(input: { text: string; now: number }): string | null;
  listMonitors(controllerKey: string, includeFinished: boolean): MonitorRecord[];
  listArmedMonitors(limit: number): MonitorRecord[];
  getControllerMonitor(controllerKey: string, id: string): MonitorRecord | null;
  cancelControllerMonitor(controllerKey: string, id: string, now: number): boolean;
  cancelMonitor(id: string, now: number): boolean;
  recordMonitorFired(input: { id: string; nextDueAt: number | null; now: number }): boolean;
  failMonitor(input: { id: string; error: string; now: number }): boolean;
  createDelegation(input: { controllerKey: string; instruction: string; now: number }): DelegationRecord;
  addDelegationThread(input: {
    delegationId: string;
    threadId: string;
    projectId: string;
    title: string;
    now: number;
  }): boolean;
  listOpenDelegations(limit: number): DelegationRecord[];
  getDelegation(id: string): DelegationRecord | null;
  settleDelegationThread(input: {
    delegationId: string;
    threadId: string;
    state: Exclude<DelegationThreadState, "running">;
    summary: string | null;
    now: number;
  }): boolean;
  /**
   * Claims the right to escalate one member's stall. True only for the caller
   * that got there first, so a wedged thread is reported once, not every sweep.
   */
  claimDelegationThreadStall(input: {
    delegationId: string;
    threadId: string;
    now: number;
  }): boolean;
  /** The same claim for a watched thread that wedged instead of settling. */
  claimMonitorStall(input: { id: string; now: number }): boolean;
  sealDelegation(input: { id: string; now: number }): boolean;
  recordDelegationFired(input: { id: string; now: number }): boolean;
  failDelegation(input: { id: string; error: string; now: number }): boolean;
  cancelDelegation(id: string, now: number): boolean;
  enrolFinishedJobsForMemory(outcomes: readonly string[], limit: number, now: number): number;
  listJobMemoryExtractions(state: JobMemoryExtractionState, limit: number): JobMemoryExtractionRecord[];
  startJobMemoryExtraction(input: { jobId: string; threadId: string; now: number }): boolean;
  recordJobMemoryExtractionFailure(input: { jobId: string; error: string; now: number }): boolean;
  completeJobMemoryExtraction(input: { jobId: string; savedCount: number; now: number }): boolean;
  recordJobMemorySaved(input: { jobId: string; savedCount: number; now: number }): boolean;
  failJobMemoryExtraction(input: { jobId: string; error: string; now: number }): boolean;
  rememberMemory(input: MemoryInput): MemoryRecord;
  importOwnerMemory(input: OwnerMemoryImportInput): MemoryRecord;
  recallMemories(input: {
    scope: string;
    query?: string;
    limit: number;
    now: number;
    turnId?: string;
  }): MemoryRecord[];
  curateMemories(input: { now: number }): { decayed: number; tombstoned: number };
  listUnscoredRecallTurns(limit: number): { turnId: string; controllerKey: string; ordinal: number }[];
  getControllerTurnAfter(controllerKey: string, ordinal: number): ControllerTurnRecord | null;
  scoreRecalledMemories(input: {
    turnId: string;
    outcome: "reinforced" | "demoted";
    now: number;
  }): number;
  getMemory(id: string): MemoryRecord | null;
  forgetMemory(input: { id: string; now: number }): boolean;
  countMemories(scope: string): number;
  appendControllerDigest(input: {
    controllerKey: string;
    ordinal: number;
    ownerText: string;
    agentText: string;
    now: number;
  }): void;
  readControllerDigest(controllerKey: string, limit: number): { ownerText: string; agentText: string }[];
  createThreadOperation(input: {
    id: string;
    nonceHash: string;
    ownerUserId: string;
    ownerChatId: string;
    kind: ThreadOperationKind;
    threadId: string;
    text: string | null;
    expiresAt: number;
    now: number;
  }): ThreadOperation;
  markThreadOperationConfirmationSent(id: string, messageId: number, now: number): ThreadOperation;
  failThreadOperationConfirmation(id: string, now: number): boolean;
  confirmThreadOperation(input: {
    nonceHash: string;
    userId: string;
    chatId: string;
    messageId: number;
    now: number;
  }): ThreadOperationConfirmResult;
  getThreadOperation(id: string): ThreadOperation | null;
  failStaleThreadOperations(fence: ControllerLeaseFence): boolean;
  claimNextThreadOperation(fence: ControllerLeaseFence & { leaseMs?: number }): ThreadOperation | null;
  completeThreadOperation(input: ControllerLeaseFence & { id: string; result: string }): boolean;
  failThreadOperation(input: ControllerLeaseFence & { id: string; error: string }): boolean;
  bindTelegramIdentity(input: {
    botId: string;
    username: string;
    now: number;
    hasActiveJob: boolean;
  }): "created" | "same" | "identity_mismatch" | "active_job_conflict";
  getTelegramIdentity(): TelegramIdentity | null;
  upsertProjectPolicy(policy: ProjectPolicy, now: number): ProjectPolicyRecord;
  getProjectPolicy(projectId: string): ProjectPolicyRecord | null;
  getProjectPolicyByAlias(alias: string): ProjectPolicyRecord | null;
  listEnabledProjectPolicies(): ProjectPolicyRecord[];
  createConfirmedControllerJob(input: {
    controllerThreadId: string;
    projectId: string;
    task: string;
    now: number;
    path?: "full" | "small_fix";
  }): Job;
  createAdoptedControllerJob(input: {
    controllerThreadId: string;
    projectId: string;
    task: string;
    prNumber: number;
    prUrl: string;
    headSha: string;
    branchName: string;
    now: number;
  }): Job;
  getJobBySourceUpdateId(sourceUpdateId: number): Job | null;
  selectProjectAndQueueAdmission(input: {
    jobId: string;
    expectedVersion: number;
    projectId: string;
    policyVersion: number;
    policy: ProjectPolicy;
    now: number;
  }): Job;
  queueAdmission(input: AdmissionWriteInput): JobAdmission;
  requeueAdmission(input: AdmissionWriteInput): JobAdmission;
  requeueReviewAdmission(jobId: string, expectedVersion: number, now: number): ReviewAdmissionResult;
  retryFailedJob(jobId: string, expectedVersion: number, now: number): RetryJobResult;
  createJob(input: {
    id: string;
    sourceUpdateId: number;
    requestText: string;
    now: number;
  }): Job;
  setJobStatusMessage(jobId: string, messageId: number, expectedVersion: number, now: number): Job;
  enqueueSteeringEffect(
    jobId: string,
    updateId: number,
    threadId: string,
    text: string,
    now: number,
  ): boolean;
  enqueueOutbox(item: OutboxInput, now: number): void;
  setLastProject(projectId: string): Promise<void>;
  getLastProject(): Promise<string | null>;
  getJob(jobId: string): Job | null;
  getActiveJob(): Job | null;
  findJobByThreadId(threadId: string): Job | null;
  listJobs(limit: number): Job[];
  listLegacyActiveJobs(limit: number): Job[];
  findOpenJobByProject(projectId: string): Job | null;
  findOpenJobByProjectAndTask(projectId: string, task: string): Job | null;
  listControlJobs(kind: JobControlKind, limit: number): Job[];
  countControlJobs(kind: JobControlKind): number;
  hasUnreleasedAdmissions(): boolean;
  getAdmission(jobId: string): JobAdmission | null;
  listAdmissions(states: readonly AdmissionState[], limit: number): JobAdmission[];
  listReleaseCandidates(limit: number): JobAdmission[];
  listHeldResourceClaims(jobId: string | null, limit: number): JobResourceClaim[];
  listCurrentHeldResourceClaims(jobId: string, limit: number): JobResourceClaim[];
  listCurrentHeldMergeResourceClaims(input: CurrentHeldMergeResourceClaimsInput): JobResourceClaim[];
  adoptHeldClaims(input: ClaimAdoptionInput): boolean;
  listActiveJobs(limit: number): Job[];
  listContinuationCandidates(limit: number): JobContinuationCandidate[];
  recordAutoContinue(input: { jobId: string; key: string; now: number }): void;
  recordContinuationEscalation(input: { jobId: string; now: number }): void;
  findJobByStatusMessageId(messageId: number): Job | null;
  tryAdmit(input: AdmissionAttemptInput): AdmissionAttempt;
  applyJobEvent(jobId: string, expectedVersion: number, event: JobEvent, now: number): Job;
  applyExecutorJobEvent(input: ExecutorEventInput): Job | null;
  listEffectsForJob(jobId: string): StoredEffect[];
  getEffect(jobId: string, idempotencyKey: string): StoredEffect | null;
  getAttempt(attemptId: string): AttemptRecord | null;
  getAttemptByThreadId(threadId: string): AttemptRecord | null;
  nextAttemptOrdinal(jobId: string, kind: AttemptRecord["kind"]): number;
  listReviewAttempts(jobId: string, reviewStage: NonNullable<AttemptRecord["reviewStage"]>, ordinal: number): AttemptRecord[];
  createAttempt(input: {
    id: string;
    jobId: string;
    kind: AttemptRecord["kind"];
    ordinal: number;
    headSha?: string | null;
    now: number;
  }): AttemptRecord;
  createExecutorAttempt(input: ExecutorAttemptInput): AttemptRecord | null;
  createPipelineStageAttempt(input: ControllerLeaseFence & {
    id: string;
    jobId: string;
    role: PipelineStageRole;
    ordinal: number;
    inputSha256: string;
  }): PipelineStageAttempt;
  bindPipelineStageThread(input: ControllerLeaseFence & {
    id: string;
    threadId: string;
    environmentId: string;
  }): boolean;
  bindPipelineStageResource(input: ControllerLeaseFence & {
    id: string;
    resourceKind: "bb_thread" | "bb_terminal";
    resourceId: string;
    environmentId: string;
  }): boolean;
  completePipelineStageAttempt(input: ControllerLeaseFence & {
    id: string;
    outputText: string;
    outputSha256: string;
    outcome: Record<string, unknown>;
    startSha?: string | null;
    endSha?: string | null;
  }): boolean;
  failPipelineStageAttempt(input: ControllerLeaseFence & {
    id: string;
    error: string;
  }): boolean;
  getPipelineStageAttempt(id: string): PipelineStageAttempt | null;
  getPipelineStageAttemptByThreadId(threadId: string): PipelineStageAttempt | null;
  getLatestPipelineStageAttempt(jobId: string, role: PipelineStageRole): PipelineStageAttempt | null;
  nextPipelineStageOrdinal(jobId: string, role: PipelineStageRole): number;
  updateAttempt(attemptId: string, patch: {
    threadId?: string | null;
    headSha?: string | null;
    handoffPath?: string | null;
    handoffSha256?: string | null;
    result?: Record<string, unknown> | null;
    completedAt?: number | null;
  }): AttemptRecord;
  updateExecutorAttempt(input: ExecutorAttemptPatch): AttemptRecord | null;
  claimReviewFormatCorrection(attemptId: string, threadId: string, headSha: string): boolean;
  claimExecutorReviewFormatCorrection(input: ExecutorReviewFormatCorrectionInput): boolean;
  registerReviewThread(jobId: string, expectedVersion: number, threadId: string, now: number): Job;
  registerExecutorReviewThread(input: ExecutorReviewThreadInput): Job | null;
  createExecutorApproval(input: ExecutorApprovalInput): boolean;
  revokeExecutorApprovals(input: ExecutorApprovalRevocationInput): number | null;
  enqueueExecutorStatus(input: ExecutorStatusOutboxInput): boolean;
  acquireExecutorLease(
    ownerId: string,
    now: number,
    leaseMs: number,
  ): { acquired: true; generation: number } | { acquired: false };
  renewExecutorLease(ownerId: string, generation: number, now: number, leaseMs: number): boolean;
  releaseExecutorLease(ownerId: string, generation: number, now: number): boolean;
  isExecutorLeaseCurrent(ownerId: string, generation: number, now: number): boolean;
  isControllerInteractionDeliveryFenceCurrent(input: ControllerInteractionDeliveryFence): boolean;
  leaseControlEffects(input: ControlEffectLeaseInput): StoredEffect[];
  leaseNextJobEffect(input: JobEffectLeaseInput): StoredEffect | null;
  renewJobOperationFences(input: JobOperationFenceRenewalInput): boolean;
  assertProductionStageFence(input: ProductionStageFenceInput): boolean;
  renewControlEffectFence(input: ControlEffectFenceRenewalInput): boolean;
  beginDraining(input: ExecutorFence & Readonly<{ jobId: string }>): Job | null;
  finalizeRelease(input: ExecutorFence & Readonly<{ jobId: string }>): ReleaseResult | null;
  leaseOutbox(ownerId: string, generation: number, now: number, limit: number, leaseMs: number): StoredOutbox[];
  renewOutboxLease(input: OutboxLeaseRenewalInput): boolean;
  completeEffect(key: string, ownerId: string, generation: number, now: number): boolean;
  completeOutbox(key: string, ownerId: string, generation: number, messageId: number | null, now: number): boolean;
  completeStatusOutbox(
    key: string,
    ownerId: string,
    generation: number,
    jobId: string,
    expectedVersion: number,
    messageId: number,
    now: number,
  ): boolean;
  replaceStatusOutboxMessage(
    key: string,
    ownerId: string,
    generation: number,
    jobId: string,
    expectedVersion: number,
    messageId: number,
    now: number,
  ): boolean;
  failEffect(key: string, ownerId: string, generation: number, error: string, nextAttemptAt: number, now: number): boolean;
  failOutbox(key: string, ownerId: string, generation: number, error: string, nextAttemptAt: number, now: number): boolean;
  replaceOutboxWithDeliveryFailureNotice(input: OutboxDeliveryFailureNoticeInput): boolean;
  deadLetterEffect(key: string, ownerId: string, generation: number, error: string, now: number): boolean;
  deadLetterOutbox(key: string, ownerId: string, generation: number, error: string, now: number): boolean;
  getOutbox(logicalKey: string): StoredOutbox | null;
  listOutbox(limit: number): StoredOutbox[];
  upsertWorkerLiveness(value: WorkerLiveness): void;
  upsertExecutorWorkerLiveness(input: ExecutorWorkerLivenessInput): boolean;
  getWorkerLiveness(jobId: string): WorkerLiveness | null;
  getWorkerLivenessForResource(jobId: string, resourceId: string): WorkerLiveness | null;
  getCurrentWorkerLiveness(jobId: string): WorkerLiveness[] | null;
  getWorkerRecovery(id: string): WorkerRecoveryRecord | null;
  registerExecutorWorkerRecovery(input: ExecutorFence & Readonly<{
    id: string;
    jobId: string;
    expectedVersion: number;
    projectId: string;
    jobState: JobState;
    workerKind: WorkerKind;
    resourceId: string;
    workerGeneration: number;
    classification: WorkerRecoveryClassification;
    signature: string;
    retryLimit: number;
  }>): WorkerRecoveryRegistration | null;
  markExecutorWorkerRecoveryRetiring(input: ExecutorFence & Readonly<{ id: string }>): boolean;
  markExecutorWorkerRecoveryRequeued(input: ExecutorFence & Readonly<{ id: string }>): boolean;
  markExecutorWorkerRecoveryRecovered(input: ExecutorFence & Readonly<{ jobId: string }>): number;
  markWorkerLivenessNotified(jobId: string, generation: number, now: number, resourceId?: string): boolean;
  markExecutorWorkerLivenessNotified(input: ExecutorFence & Readonly<{ jobId: string; workerGeneration: number; resourceId?: string }>): boolean;
  clearWorkerLiveness(jobId: string, generation: number): boolean;
  clearExecutorWorkerLiveness(input: ExecutorFence & Readonly<{ jobId: string; workerGeneration: number }>): boolean;
  bindMergeEffectReceipt(input: {
    jobId: string;
    effectIdempotencyKey: string;
    receipt: DurableMergeReceipt;
    leaseOwner: string;
    leaseGeneration: number;
    now: number;
  }): boolean;
  prepareMergeCall(input: {
    jobId: string;
    effectIdempotencyKey: string;
    leaseOwner: string;
    leaseGeneration: number;
    now: number;
  }): MergeCallPreparation;
  rejectApprovalAndRecordCallback(input: {
    nonceHash: string;
    callbackId: string;
    jobId: string | null;
    now: number;
    headSha?: string;
  }): ApprovalRejectionResult;
  createApproval(input: {
    nonceHash: string;
    jobId: string;
    headSha: string;
    expiresAt: number;
    now: number;
    ownerUserId?: string | null;
    ownerChatId?: string | null;
    jobVersion?: number | null;
  }): void;
  getUsableApproval(nonceHash: string, now: number): ApprovalRecord | null;
  getApproval(nonceHash: string): ApprovalState | null;
  consumeApproval(input: {
    nonceHash: string;
    now: number;
    identity?: ApprovalIdentity;
  }): ApprovalConsumeResult;
  acceptApprovalAndEnqueueMerge(input: {
    nonceHash: string;
    expectedJobVersion: number;
    effect: JobEffect;
    now: number;
    identity?: ApprovalIdentity;
  }): ApprovalAcceptResult;
  revokeApprovals(jobId: string, reason: string, now: number): number;
  beginTelegramUpdate(updateId: number, now: number): "process" | "processed";
  completeTelegramUpdate(updateId: number, outcome: string, now: number): void;
  failTelegramUpdate(updateId: number, error: string, now: number): void;
  abandonTelegramUpdate(updateId: number, error: string, now: number): void;
  getTelegramUpdateAttempts(updateId: number): number;
  reconcileTelegramCursor(): void;
  getNextTelegramOffset(): number;
  recordCallback(
    callbackId: string,
    jobId: string | null,
    action: string,
    outcome: string,
    now: number,
    completion?: MergeCallbackIdentity,
  ): boolean;
  getCallback(callbackId: string): CallbackRecord | null;
  completeMergeSuccess(input: MergeSuccessInput): boolean;
  preserveUnknownMergeEffect(input: {
    jobId: string;
    effectIdempotencyKey: string;
    now: number;
    leaseOwner: string;
    leaseGeneration: number;
  }): boolean;
  failLeasedMergeEffect(input: MergeFailureInput): boolean;
  failMergeEffect(input: MergeFailureInput): boolean;
  staleMergeEffect(input: MergeStaleInput): boolean;
  enqueueReconcileForThread(threadId: string, now: number): boolean;
  enqueueReconcileForEnvironment(environmentId: string, now: number): boolean;
  shouldWakeForThread(threadId: string): boolean;
  shouldWakeForEnvironment(environmentId: string): boolean;
  reconcileCredentialHealth(input: CredentialHealthReconcileInput): CredentialHealthReconcileResult;
  listCredentialBindings(input: Readonly<{
    installationId: string;
    state?: BrokerBindingState;
    afterBindingId?: string;
    limit: number;
  }>): readonly CredentialBindingMetadata[];
  getCredentialBinding(installationId: string, bindingId: string): CredentialBindingMetadata | null;
  prepareCredentialDiagnosticOperation(input: Readonly<{
    installationId: string;
    envelope: BrokerRequestEnvelope;
    now: number;
  }>): CredentialDiagnosticPrepareResult;
  prepareCredentialVerificationOperation(
    input: CredentialVerificationPrepareInput,
  ): CredentialVerificationPrepareResult;
  markCredentialOperationAmbiguous(input: Readonly<{
    installationId: string;
    requestId: string;
    now: number;
  }>): CredentialOperationRecord | null;
  completeCredentialDiagnosticOperation(input: CredentialOperationCompleteInput): CredentialOperationCompleteResult;
  completeCredentialVerificationOperation(
    input: CredentialVerificationCompleteInput,
  ): CredentialVerificationCompleteResult;
  getCredentialReceipt(installationId: string, receiptId: string): CredentialReceiptRecord | null;
  getCredentialHealth(installationId: string): CredentialHealthRecord | null;
}

export type TelegramStatusOutboxStore = TelegramAgentStore & {
  setJobStatusMessageAndOutbox(
    jobId: string,
    messageId: number,
    expectedVersion: number,
    outbox: OutboxInput,
    now: number,
  ): Job;
};

function parsePolicy(row: ProjectPolicyRow): ProjectPolicyRecord {
  return {
    policy: projectPolicySchema.parse(JSON.parse(row.policy_json)),
    version: row.version,
  };
}

function parseControllerThread(row: ControllerThreadRow): ControllerThreadRecord {
  return {
    controllerKey: row.controller_key,
    telegramUserId: row.telegram_user_id,
    telegramChatId: row.telegram_chat_id,
    projectId: row.project_id,
    hostId: row.host_id,
    threadId: row.bb_thread_id,
    state: row.state,
    pendingSpawnToken: row.pending_spawn_token,
    capabilitySubjectId: row.capability_subject_id,
    capabilityProfileId: row.capability_profile_id,
    capabilityProfileRevision: row.capability_profile_revision,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseControllerTurn(row: ControllerTurnRow): ControllerTurnRecord {
  const image = parseControllerImage(row);
  const evidenceEventSeq = parsePersistedControllerNonNegativeInteger(
    row.evidence_event_seq,
    "evidence_event_seq",
  );
  const completionContinuations = parsePersistedControllerNonNegativeInteger(
    row.completion_continuations,
    "completion_continuations",
  );
  const acceptedFinalizationId = parsePersistedControllerNullablePositiveInteger(
    row.accepted_finalization_id,
    "accepted_finalization_id",
  );
  const evidenceLimitExceededAt = parsePersistedControllerNullableNonNegativeInteger(
    row.evidence_limit_exceeded_at,
    "evidence_limit_exceeded_at",
  );
  if (row.input_accepted !== 0 && row.input_accepted !== 1) {
    throw new Error("Persisted controller turn input_accepted must be zero or one");
  }
  if (row.private_draft_item_id !== null &&
      (row.private_draft_item_id.length === 0 || row.private_draft_item_id.length > 256)) {
    throw new Error("Persisted controller private draft item id is invalid");
  }
  if (row.private_draft_text.length > MAX_CONTROLLER_PRIVATE_DRAFT_CHARS) {
    throw new Error("Persisted controller private draft exceeds its bound");
  }
  if (row.recovery_source_turn_id !== null) {
    assertControllerIdentifier(row.recovery_source_turn_id, "persisted recovery source turn id");
  }
  if (row.delivery_state !== "none" && row.delivery_state !== "intent" && row.delivery_state !== "delivery_unknown") {
    throw new Error("Persisted controller turn delivery_state is invalid");
  }
  if (row.dispatch_kind !== null && row.dispatch_kind !== "send" && row.dispatch_kind !== "spawn") {
    throw new Error("Persisted controller turn dispatch_kind is invalid");
  }
  if (row.dispatch_correlation_id !== null) {
    assertControllerIdentifier(row.dispatch_correlation_id, "persisted dispatch correlation id");
  }
  const dispatchRetryCount = parsePersistedControllerNonNegativeInteger(
    row.dispatch_retry_count,
    "dispatch_retry_count",
  );
  const deliveryReconcileAttempts = parsePersistedControllerNonNegativeInteger(
    row.delivery_reconcile_attempts,
    "delivery_reconcile_attempts",
  );
  const busyWaitNotifiedAt = parsePersistedControllerNullableNonNegativeInteger(
    row.busy_wait_notified_at,
    "busy_wait_notified_at",
  );
  const nextDispatchAt = parsePersistedControllerNonNegativeInteger(
    row.next_dispatch_at,
    "next_dispatch_at",
  );
  const continuationCorrelationId = `controller-continuation:${row.id}:1`;
  const continuationDelivery = row.state === "submitted" && completionContinuations === 1 &&
    row.dispatch_kind === "send" && row.dispatch_correlation_id === continuationCorrelationId;
  if (row.delivery_state === "intent" && (
    (row.state !== "dispatching" && !continuationDelivery) ||
    row.dispatch_kind === null || row.dispatch_correlation_id === null
  )) {
    throw new Error("Persisted controller dispatch intent is incomplete");
  }
  if (row.delivery_state === "delivery_unknown" &&
      row.state !== "dispatching" && row.state !== "failed" && !continuationDelivery) {
    throw new Error("Persisted unknown controller delivery has an invalid turn state");
  }
  return {
    id: row.id,
    updateId: row.telegram_update_id,
    controllerKey: row.controller_key,
    ordinal: row.ordinal,
    inputText: row.input_text,
    image,
    state: row.state,
    leaseOwner: row.lease_owner,
    leaseGeneration: row.lease_generation,
    dispatchAfterSeq: row.dispatch_after_seq,
    deliveryState: row.delivery_state,
    dispatchKind: row.dispatch_kind,
    dispatchCorrelationId: row.dispatch_correlation_id,
    dispatchRetryCount,
    deliveryReconcileAttempts,
    busyWaitNotifiedAt,
    nextDispatchAt,
    retryCount: row.retry_count,
    modelFallbackIndex: row.model_fallback_index,
    bbEventSeq: row.bb_event_seq,
    evidenceEventSeq,
    completionContinuations,
    acceptedFinalizationId,
    inputAccepted: row.input_accepted === 1,
    privateDraftItemId: row.private_draft_item_id,
    privateDraftText: row.private_draft_text,
    recoverySourceTurnId: row.recovery_source_turn_id,
    evidenceLimitExceededAt,
    streamText: CONTROLLER_PHASE_TEXT[row.stream_phase],
    telegramMessageId: row.telegram_message_id,
    streamPhase: row.stream_phase,
    responseText: row.response_text,
    lastError: row.last_error,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    awaitingInteractionId: row.awaiting_interaction_id ?? null,
    toolCalls: row.tool_calls,
    commandFailures: row.command_failures,
    totalTokens: row.total_tokens,
    supervisorSteers: row.supervisor_steers,
    supervisorReasons: parseSupervisorReasons(row.supervisor_reasons),
    tokenBaseline: row.token_baseline,
    origin: row.origin === "system" ? "system" : "owner",
    capabilityProfileId: row.capability_profile_id,
    capabilityProfileRevision: row.capability_profile_revision,
    capabilityConfiguredRevision: row.capability_configured_revision,
    capabilityContinuationCount: row.capability_continuation_count,
    capabilityContinuationState: row.capability_continuation_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePersistedControllerNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Persisted controller turn ${field} must be a non-negative safe integer`);
  }
  return value;
}

function parsePersistedControllerNullablePositiveInteger(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Persisted controller turn ${field} must be null or a positive safe integer`);
  }
  return value;
}

function parsePersistedControllerNullableNonNegativeInteger(value: number | null, field: string): number | null {
  if (value === null) return null;
  return parsePersistedControllerNonNegativeInteger(value, field);
}

// Stored as a comma-separated slug list: the vocabulary is closed and tiny, so
// JSON would only add a parse failure mode to a column that cannot grow.
function parseSupervisorReasons(value: string): readonly SupervisorReason[] {
  return value.split(",").filter((slug): slug is SupervisorReason => SUPERVISOR_REASONS.has(slug));
}

function parseControllerSupervisorSteerAttempt(
  row: ControllerSupervisorSteerAttemptRow,
): ControllerSupervisorSteerAttempt {
  assertControllerIdentifier(row.turn_id, "persisted supervisor turnId");
  assertControllerKey(row.controller_key);
  assertControllerIdentifier(row.thread_id, "persisted supervisor threadId");
  assertControllerText(row.input_text, "persisted supervisor inputText");
  assertBoundedString(row.idempotency_key, "persisted supervisor idempotencyKey");
  assertNonNegativeInteger(row.created_at, "persisted supervisor createdAt");
  if (row.settled_at !== null) assertNonNegativeInteger(row.settled_at, "persisted supervisor settledAt");
  if (!SUPERVISOR_REASONS.has(row.reason)) throw new Error("Unknown persisted controller supervisor reason");
  if (row.state !== "pending" && row.state !== "applied" && row.state !== "unknown") {
    throw new Error("Unknown persisted controller supervisor steer state");
  }
  if ((row.state === "pending") !== (row.settled_at === null)) {
    throw new Error("Persisted controller supervisor steer settlement is inconsistent");
  }
  return {
    turnId: row.turn_id,
    controllerKey: row.controller_key,
    reason: row.reason as SupervisorReason,
    threadId: row.thread_id,
    inputText: row.input_text,
    idempotencyKey: row.idempotency_key,
    state: row.state as ControllerSupervisorSteerState,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function parseControllerImage(row: ControllerTurnRow): ControllerImage | null {
  if (
    row.image_file_id === null &&
    row.image_file_name === null &&
    row.image_mime_type === null &&
    row.image_size_bytes === null
  ) return null;
  if (row.image_file_id === null || row.image_file_name === null || row.image_mime_type === null) {
    throw new Error("Persisted controller image is incomplete");
  }
  const kind = row.image_kind === "animation" || row.image_kind === "video" ? row.image_kind : "image";
  if (
    (row.thumbnail_file_id === null) !== (row.thumbnail_file_name === null)
  ) {
    throw new Error("Persisted controller thumbnail is incomplete");
  }
  const thumbnail = row.thumbnail_file_id === null || row.thumbnail_file_name === null
    ? null
    : {
      fileId: row.thumbnail_file_id,
      fileName: row.thumbnail_file_name,
      sizeBytes: row.thumbnail_size_bytes,
    };
  const image: ControllerImage = {
    fileId: row.image_file_id,
    fileName: row.image_file_name,
    mimeType: row.image_mime_type as ControllerMediaMimeType,
    sizeBytes: row.image_size_bytes,
    kind,
    durationSeconds: row.image_duration_seconds,
    thumbnail,
  };
  assertControllerImage(image);
  return image;
}

function parseThreadOperation(row: ThreadOperationRow): ThreadOperation {
  return {
    id: row.id,
    nonceHash: row.nonce_hash,
    ownerUserId: row.owner_user_id,
    ownerChatId: row.owner_chat_id,
    kind: row.kind,
    threadId: row.thread_id,
    text: row.operation_text,
    state: row.state,
    confirmationMessageId: row.confirmation_message_id,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    leaseOwner: row.lease_owner,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at,
    result: row.result,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type MonitorRow = {
  id: string;
  controller_key: string;
  kind: string;
  thread_id: string | null;
  cron: string | null;
  instruction: string;
  state: string;
  due_at: number | null;
  fire_count: number;
  last_fired_at: number | null;
  last_error: string | null;
  stall_notified_at: number | null;
  created_at: number;
  updated_at: number;
  system_key: string | null;
};

type JobMemoryExtractionRow = {
  job_id: string;
  project_id: string;
  outcome: string;
  state: string;
  thread_id: string | null;
  attempts: number;
  saved_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

const JOB_MEMORY_EXTRACTION_STATES: ReadonlySet<string> = new Set<JobMemoryExtractionState>([
  "pending", "running", "done", "failed",
]);

function parseJobMemoryExtraction(row: JobMemoryExtractionRow): JobMemoryExtractionRecord {
  if (!JOB_MEMORY_EXTRACTION_STATES.has(row.state)) {
    throw new Error(`Unknown persisted job memory extraction state: ${row.state}`);
  }
  return {
    jobId: row.job_id,
    projectId: row.project_id,
    outcome: row.outcome,
    state: row.state as JobMemoryExtractionState,
    threadId: row.thread_id,
    attempts: row.attempts,
    savedCount: row.saved_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type DelegationRow = {
  id: string;
  controller_key: string;
  instruction: string;
  state: string;
  fired_at: number | null;
  sealed_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

type DelegationThreadRow = {
  delegation_id: string;
  thread_id: string;
  project_id: string;
  title: string;
  ordinal: number;
  state: string;
  summary: string | null;
  settled_at: number | null;
  stall_notified_at: number | null;
};

const DELEGATION_STATES: ReadonlySet<string> = new Set<DelegationState>([
  "open", "fired", "cancelled", "failed",
]);
const DELEGATION_THREAD_STATES: ReadonlySet<string> = new Set<DelegationThreadState>([
  "running", "finished", "failed", "missing",
]);
const SETTLED_DELEGATION_THREAD_STATES: ReadonlySet<string> =
  new Set<Exclude<DelegationThreadState, "running">>(["finished", "failed", "missing"]);

function parseDelegationThread(row: DelegationThreadRow): DelegationThreadRecord {
  if (!DELEGATION_THREAD_STATES.has(row.state)) {
    throw new Error(`Unknown persisted delegation thread state: ${row.state}`);
  }
  return {
    threadId: row.thread_id,
    projectId: row.project_id,
    title: row.title,
    state: row.state as DelegationThreadState,
    summary: row.summary,
    settledAt: row.settled_at,
    stallNotifiedAt: row.stall_notified_at,
  };
}

function parseDelegation(row: DelegationRow, threads: readonly DelegationThreadRecord[]): DelegationRecord {
  if (!DELEGATION_STATES.has(row.state)) {
    throw new Error(`Unknown persisted delegation state: ${row.state}`);
  }
  return {
    id: row.id,
    controllerKey: row.controller_key,
    instruction: row.instruction,
    state: row.state as DelegationState,
    sealedAt: row.sealed_at,
    threads,
    firedAt: row.fired_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseNameList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseRegressionWatch(row: Record<string, unknown>): RegressionWatchRecord {
  return {
    projectId: String(row.project_id),
    confirmedFailures: parseNameList(row.confirmed_failures),
    reportedFailures: parseNameList(row.reported_failures),
    flakyFailures: parseNameList(row.flaky_failures),
    lastSummary: row.last_summary === null || row.last_summary === undefined ? null : String(row.last_summary),
    lastCheckedAt: row.last_checked_at === null || row.last_checked_at === undefined
      ? null
      : Number(row.last_checked_at),
    reportedAt: row.reported_at === null || row.reported_at === undefined ? null : Number(row.reported_at),
  };
}

function parseMergeAuthority(row: Record<string, unknown>): MergeAuthorityGrant {
  return {
    projectId: String(row.project_id),
    grantedAt: Number(row.granted_at),
    grantedByUserId: String(row.granted_by_user_id),
    grantedByChatId: String(row.granted_by_chat_id),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
    revokedReason: row.revoked_reason === null || row.revoked_reason === undefined
      ? null
      : String(row.revoked_reason),
  };
}

function parseMergeAuthorityEvent(row: Record<string, unknown>): MergeAuthorityEvent {
  const optionalText = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  return {
    projectId: String(row.project_id),
    action: row.action as MergeAuthorityEvent["action"],
    jobId: row.job_id === null || row.job_id === undefined ? null : String(row.job_id),
    actorUserId: optionalText(row.actor_user_id),
    actorChatId: optionalText(row.actor_chat_id),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    occurredAt: Number(row.occurred_at),
  };
}

function parseProductionHealth(row: Record<string, unknown>): ProductionHealthRecord {
  const state = String(row.state);
  if (!["unknown", "ok", "failing"].includes(state)) {
    throw new Error(`Unknown persisted production health state: ${state}`);
  }
  const reported = row.reported_state === null || row.reported_state === undefined
    ? null
    : String(row.reported_state) as ProductionHealthState;
  return {
    projectId: String(row.project_id),
    state: state as ProductionHealthState,
    consecutiveFailures: Number(row.consecutive_failures),
    lastSummary: row.last_summary === null || row.last_summary === undefined ? null : String(row.last_summary),
    lastCheckedAt: row.last_checked_at === null || row.last_checked_at === undefined ? null : Number(row.last_checked_at),
    reportedState: reported,
    reportedAt: row.reported_at === null || row.reported_at === undefined ? null : Number(row.reported_at),
  };
}

function parseMonitor(row: MonitorRow): MonitorRecord {
  if (row.kind !== "thread_idle" && row.kind !== "schedule") {
    throw new Error(`Unknown persisted monitor kind: ${row.kind}`);
  }
  if (!["armed", "cancelled", "done", "failed"].includes(row.state)) {
    throw new Error(`Unknown persisted monitor state: ${row.state}`);
  }
  return {
    id: row.id,
    controllerKey: row.controller_key,
    kind: row.kind,
    threadId: row.thread_id,
    cron: row.cron,
    instruction: row.instruction,
    state: row.state as MonitorState,
    systemKey: row.system_key ?? null,
    dueAt: row.due_at,
    fireCount: row.fire_count,
    lastFiredAt: row.last_fired_at,
    lastError: row.last_error,
    stallNotifiedAt: row.stall_notified_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type MemoryRow = {
  id: string;
  scope: string;
  kind: string;
  subject: string;
  body: string;
  importance: number;
  confidence: number;
  source: string;
  origin: string | null;
  source_turn_id: string | null;
  curated_at: number | null;
  use_count: number;
  last_used_at: number | null;
  superseded_by: string | null;
  forgotten_at: number | null;
  created_at: number;
  updated_at: number;
};

function assertMemoryScope(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError("memory scope must be between 1 and 256 characters");
  }
}

function assertMemoryText(value: string, limit: number, field: string): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length === 0 || text.length > limit) {
    throw new TypeError(`${field} must be between 1 and ${limit} characters`);
  }
  return text;
}

/**
 * The shared `containsCredentialLikeText` guard was tuned for short
 * agent-authored failure summaries, so it only catches a bare `secret=` or
 * `token=`. Anything long-lived — a memory replayed into every turn, or output
 * captured from a shell the agent drove — needs a wider net: prose phrasings
 * ("the password is …"), env-var assignments, key blocks, and provider token
 * shapes all reached storage untouched.
 *
 * Additive on purpose: this does not change what the merge and failure paths
 * reject, only what may be stored and replayed.
 */
const STORED_SECRET_PATTERNS = [
  // "the password is hunter2", "passphrase: hunter2"
  /\b(?:password|passphrase|passwd)\b\s*(?:is|are|=|:)\s*\S+/i,
  /\blogin\s+(?:password|credentials?)\b\s*(?:is|are|=|:)\s*\S+/i,
  // Env-var style assignment: AWS_SECRET_ACCESS_KEY=…, GITHUB_TOKEN: …
  /[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|APIKEY)[A-Z0-9_]*\s*[:=]\s*\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
];

/** True when text should never be stored verbatim and replayed later. */
export function looksLikeStoredSecret(text: string): boolean {
  return containsCredentialLikeText(text) ||
    STORED_SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * A delegated thread's output is arbitrary text the agent never wrote, so it is
 * clipped rather than rejected — and withheld entirely when it looks like it
 * carries a credential, because this text is replayed into a later prompt.
 */
function clipDelegationSummary(value: string, limit: number): string | null {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length === 0) return null;
  if (looksLikeStoredSecret(text)) return "(withheld: output looked like it contained a credential)";
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function assertUnitInterval(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${field} must be between 0 and 1`);
  }
  return value;
}

function parseMemory(row: MemoryRow): MemoryRecord {
  if (!MEMORY_KINDS.has(row.kind as MemoryKind)) throw new Error(`Unknown persisted memory kind: ${row.kind}`);
  if (row.source !== "owner" && row.source !== "agent") {
    throw new Error(`Unknown persisted memory source: ${row.source}`);
  }
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind as MemoryKind,
    subject: row.subject,
    body: row.body,
    importance: row.importance,
    confidence: row.confidence,
    source: row.source,
    origin: row.origin ?? null,
    sourceTurnId: row.source_turn_id,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    supersededBy: row.superseded_by,
    forgottenAt: row.forgotten_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Recovers which button was tapped. Callback data carries only a digest, so the
 * candidates are re-derived from the stored interaction and compared.
 */
// Statuses a thread can stop working *from*. Reaching idle or error from
// anything else is bookkeeping, not news.
const WORKING_THREAD_STATUSES = new Set(["active", "starting", "stopping"]);
const NOTICE_COOLDOWN_MS = 10 * 60_000;
// Other system turns use clock-derived ids. A disjoint high range keeps this
// transactional writer from colliding with their in-memory counters.
const THREAD_FOLLOW_UP_UPDATE_ID_BASE = 8_000_000_000_000_000;

function matchThreadInteractionToken(
  interaction: ThreadInteraction,
  token: string,
): { label: string; resolution: Record<string, unknown> } | null {
  if (interaction.kind === "unsupported") return null;
  if (interaction.kind === "approval") {
    for (const decision of interaction.decisions) {
      if (threadDecisionToken(interaction.interactionId, decision) !== token) continue;
      return {
        label: decision === "deny" ? "Denied" : "Allowed",
        resolution: decision === "deny"
          ? { decision }
          : { decision, grantedPermissions: null },
      };
    }
    return null;
  }
  for (const question of interaction.questions) {
    for (const option of question.options) {
      if (questionOptionToken(interaction.interactionId, question.id, option.value) !== token) continue;
      return {
        label: option.label,
        resolution: { kind: "user_answer", answers: { [question.id]: { selected: [option.value] } } },
      };
    }
  }
  return null;
}

const CONTROLLER_FAILURE_TEXT: Readonly<Record<ControllerFailureCode, string>> = {
  // Every line here is read by the owner in place of the answer they asked for,
  // so each one has to be true for the single path that reaches it and has to
  // say what became of their message. A resend is invited only where nothing
  // ran, so taking it up cannot repeat an action.
  unknown: "I couldn't finish that one, so your message didn't get an answer. Nothing was repeated. Send it again and I'll pick it up.",
  stalled: "That one stopped making progress after I tried again, so I ended it safely. Your message didn't get an answer. Nothing was repeated. Send it again and I'll pick it up.",
  budget_exceeded: "That one reached its safety limit, so I stopped it. Your message didn't get a full answer. Nothing was repeated. Send it again and I'll pick it up.",
  oauth_expired: "The provider sign-in has expired, so I couldn't answer your message. Reconnect that provider, then send your message again.",
  provider_rejected: "The provider refused its current model or account settings, so I couldn't answer your message. Fix those provider settings, then send your message again.",
  recovery_exhausted: "I tried that again and still couldn't finish it, so your message didn't get an answer. Nothing was repeated. Send it again and I'll pick it up.",
  owner_message_delivery_uncertain: "I preserved that message because its delivery could not be confirmed. It will be reconciled before any action is repeated.",
  owner_message_delivery_exhausted: "I couldn't confirm whether my previous message reached you after repeated attempts. It may be missing or duplicated; open BB to inspect the result.",
  owner_message_delivery_unresolved: "I preserved that message, but could not confirm whether it was delivered. I did not repeat it. Please review the conversation before trying again.",
  owner_message_waiting_for_fresh_generation: "I kept your message queued because that controller is still busy. If it does not free up soon, I’ll continue in a fresh conversation.",
  owner_message_requeued: "I couldn't finish that one, but nothing had started yet, so I've put your message back and I'm picking it up again in a fresh conversation. Nothing was repeated.",
  image_preparation_failed: "I couldn't read that image safely. Please resend a smaller JPEG, PNG, WebP, or GIF.",
};

/** Shown when a message arrives mid-turn and is folded into the running reply. */
const CONTROLLER_STEER_FOLDED_TEXT = "Got that, and I'm working it into the answer I'm already writing.";

/**
 * The system turn that hands a spawned thread's block to the controller.
 *
 * It carries the question itself, not a pointer to go and read one, because a
 * turn that has to go looking is a turn that can decide it has nothing to say.
 * The instruction is explicit that this is the controller's to answer: the
 * routing already established the owner is not needed.
 */
function describeThreadBlockForController(
  threadId: string,
  title: string,
  interaction: ThreadInteraction,
  decisions: readonly ThreadApprovalDecision[],
): string {
  const head = `A thread you started is blocked and waiting on you: ${threadId} (${title}).`;
  const tail = "Answer it with telegram_agent_answer_thread so the thread continues. " +
    "This is yours to decide; do not pass it to the owner unless it turns out to need " +
    "their merge or deploy approval, or an irreversible external action.";
  if (interaction.kind === "unsupported") {
    return `${head} I can't read what it is asking, so read the thread in BB to see what it needs. ${tail}`;
  }
  if (interaction.kind === "user_question") {
    const asked = interaction.questions
      .map((question, index) => {
        const options = question.options.map((option) => option.label).join(", ");
        return `${index + 1}. ${question.prompt}${options.length > 0 ? ` Options: ${options}.` : ""}`;
      })
      .join("\n");
    return `${head} It asks:\n${asked}\n${tail}`;
  }
  return `${head} It ${interaction.summary}\nYou may answer: ${decisions.join(", ")}.\n${tail}`;
}

const MAX_CONTROLLER_DISPATCH_RETRY_COUNT = 6;
const MAX_CONTROLLER_DELIVERY_RECONCILIATION_ATTEMPTS = 3;

function validatedThreadFollowUp(input: unknown): ThreadFollowUp {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("thread follow-up must be an object");
  }
  const followUp = input as Record<string, unknown>;
  assertControllerIdentifier(followUp.threadId as string, "thread follow-up id");
  assertControllerText(followUp.title as string, "thread follow-up title");
  if (followUp.status !== "idle" && followUp.status !== "error") {
    throw new TypeError("thread follow-up status must be idle or error");
  }
  return {
    threadId: followUp.threadId as string,
    title: followUp.title as string,
    status: followUp.status,
  };
}

function parseThreadFollowUp(value: string | null): ThreadFollowUp | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  return validatedThreadFollowUp(parsed);
}

function controllerReplyLogicalKey(turnId: string, threadFollowUpJson: string | null): string {
  const followUp = parseThreadFollowUp(threadFollowUpJson);
  return followUp === null
    ? `controller:${turnId}:reply`
    : `thread:${followUp.threadId}:${followUp.status}`;
}

function controllerFailureOutbox(
  turnId: string,
  chatId: string,
  failureCode: ControllerFailureCode = "unknown",
  threadFollowUpJson: string | null = null,
): OutboxInput {
  const followUp = parseThreadFollowUp(threadFollowUpJson);
  if (followUp !== null) {
    return {
      logicalKey: `thread:${followUp.threadId}:${followUp.status}`,
      chatId,
      payload: renderThreadLifecycleNotice(
        followUp.title,
        followUp.status === "idle" ? "finished" : "failed",
      ),
    };
  }
  return {
    logicalKey: controllerReplyLogicalKey(turnId, null),
    chatId,
    payload: {
      text: CONTROLLER_FAILURE_TEXT[failureCode],
      disable_web_page_preview: true,
    },
  };
}

function controllerPhaseOutbox(
  turnId: string,
  chatId: string,
  phase: "queued" | "connecting",
  threadFollowUpJson: string | null,
): OutboxInput {
  return {
    logicalKey: controllerReplyLogicalKey(turnId, threadFollowUpJson),
    chatId,
    payload: { text: CONTROLLER_PHASE_TEXT[phase], disable_web_page_preview: true },
  };
}

function parsePipelineStageAttempt(row: PipelineStageAttemptRow): PipelineStageAttempt {
  return {
    id: row.id,
    jobId: row.job_id,
    role: row.role,
    ordinal: row.ordinal,
    state: row.state,
    threadId: row.thread_id,
    environmentId: row.environment_id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    inputSha256: row.input_sha256,
    outputText: row.output_text,
    outputSha256: row.output_sha256,
    outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json) as Record<string, unknown>,
    startSha: row.start_sha,
    endSha: row.end_sha,
    lastError: row.last_error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function parseWorkerRecovery(row: WorkerRecoveryRow): WorkerRecoveryRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    projectId: row.project_id,
    jobState: row.job_state,
    workerKind: row.worker_kind,
    resourceId: row.resource_id,
    workerGeneration: row.worker_generation,
    classification: row.classification,
    signature: row.signature,
    action: row.action,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function parseOutbox(row: OutboxRow): StoredOutbox {
  return {
    logicalKey: row.logical_key,
    chatId: row.chat_id,
    messageId: row.message_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseWorkerLiveness(row: WorkerLivenessRow): WorkerLiveness {
  return {
    jobId: row.job_id,
    workerKind: row.worker_kind,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    generation: row.generation,
    state: row.state,
    sourceUpdatedAt: row.source_updated_at,
    observedAt: row.observed_at,
    staleNotifiedAt: row.stale_notified_at,
  };
}

function parseAttempt(row: {
  id: string;
  job_id: string;
  kind: AttemptRecord["kind"];
  review_lens?: AttemptRecord["reviewLens"];
  review_stage?: AttemptRecord["reviewStage"];
  ordinal: number;
  thread_id: string | null;
  head_sha: string | null;
  handoff_path: string | null;
  handoff_sha256: string | null;
  result_json: string | null;
  completed_at: number | null;
}): AttemptRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    reviewLens: row.review_lens ?? null,
    reviewStage: row.review_stage ?? null,
    ordinal: row.ordinal,
    threadId: row.thread_id,
    headSha: row.head_sha,
    handoffPath: row.handoff_path,
    handoffSha256: row.handoff_sha256,
    resultJson: row.result_json,
    completedAt: row.completed_at,
  };
}

function serializeOutbox(item: OutboxInput, now: number): string {
  if (!item.logicalKey || !item.chatId) throw new TypeError("outbox identity is required");
  if (!Number.isInteger(now) || now < 0) throw new TypeError("now must be a non-negative integer");
  assertNoRawMergeCallback(item.logicalKey, "outbox logical key");
  assertNoRawMergeCallback(item.chatId, "outbox chat id");
  const payloadJson = serializeBoundedJson(item.payload, "outbox payload", MAX_MERGE_RESULT_JSON);
  if (
    item.messageId !== undefined &&
    item.messageId !== null &&
    (!Number.isInteger(item.messageId) || item.messageId < 1)
  ) {
    throw new TypeError("outbox messageId must be a positive integer");
  }
  return payloadJson;
}

function sanitizedUnknownMergePayload(payloadJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (!Number.isInteger(raw.mergeCallStartedAt) || raw.mergeCallOutcome !== "unknown") return null;
  try {
    const payload = parseMergeEffectPayload(raw);
    return serializeBoundedJson(payload, "unknown merge effect payload", MAX_MERGE_RESULT_JSON);
  } catch {
    return serializeBoundedJson({
      mergeCallStartedAt: raw.mergeCallStartedAt,
      mergeCallOutcome: "unknown",
    }, "unknown merge fence", MAX_MERGE_RESULT_JSON);
  }
}

function persistOutbox(
  db: SqliteDatabase,
  item: OutboxInput,
  payloadJson: string,
  now: number,
): void {
  db
    .prepare(
      `INSERT INTO outbox (
         logical_key, chat_id, message_id, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT(logical_key) DO UPDATE SET
         chat_id = excluded.chat_id,
         message_id = COALESCE(excluded.message_id, outbox.message_id),
         payload_json = excluded.payload_json,
         status = 'pending',
         next_attempt_at = excluded.next_attempt_at,
         last_error = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(
      item.logicalKey,
      item.chatId,
      item.messageId ?? null,
      payloadJson,
      now,
      now,
      now,
    );
}

function persistControllerOutbox(
  db: SqliteDatabase,
  item: OutboxInput,
  now: number,
): void {
  persistOutbox(db, item, serializeOutbox(item, now), now);
  db.prepare("UPDATE outbox SET attempts = 0 WHERE logical_key = ?").run(item.logicalKey);
}

function advanceTelegramCursor(db: SqliteDatabase): void {
  const cursor = db
    .prepare("SELECT next_offset FROM telegram_cursor WHERE singleton = 1")
    .get() as { next_offset: number } | undefined;
  if (!cursor) throw new Error("Telegram cursor was not initialized");

  // An update that has burned its retry budget no longer holds the cursor: one
  // undeliverable update must not stall every later update behind it forever.
  const firstUnprocessed = db
    .prepare(
      `SELECT MIN(update_id) AS update_id FROM telegram_updates
        WHERE update_id >= ? AND status <> 'processed' AND attempts < ?`,
    )
    .get(cursor.next_offset, MAX_TELEGRAM_UPDATE_ATTEMPTS) as { update_id: number | null };
  const highest = db
    .prepare(
      "SELECT MAX(update_id) AS update_id FROM telegram_updates WHERE update_id >= ? AND status = 'processed'",
    )
    .get(cursor.next_offset) as { update_id: number | null };

  const nextOffset =
    firstUnprocessed.update_id ??
    (highest.update_id === null ? null : highest.update_id + 1);
  if (nextOffset === null || nextOffset <= cursor.next_offset) return;
  db
    .prepare(
      `UPDATE telegram_cursor
          SET next_offset = CASE WHEN next_offset < ? THEN ? ELSE next_offset END
        WHERE singleton = 1`,
    )
    .run(nextOffset, nextOffset);
}

function sqliteErrorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return (error as { code?: unknown }).code;
}

class MergeClaimConflictError extends Error {
  public constructor() {
    super("merge resource claim is unavailable");
    this.name = "MergeClaimConflictError";
  }
}

type MergeClaimKind = Extract<ResourceKind, "repository_merge" | "production_target">;

type MergeResourceRequirement = Readonly<{
  resourceKey: string;
  resourceKind: MergeClaimKind;
}>;

type HeldMergeClaim = Readonly<{
  resource_key: string;
  resource_kind: string;
  job_id: string;
  owner_id: string;
  generation: number;
  lease_expires_at: number;
}>;

type AcceptedMergeLease = Readonly<{
  headSha: string;
  approvalNonceHash: string;
  approvalOwnerUserId: string;
  approvalOwnerChatId: string;
  approvalJobVersion: number;
  approvalExpiresAt: number;
}>;

type ResourceClaimSettlement = Readonly<{
  jobId: string;
  ownerId: string;
  generation: number;
  now: number;
  reason: string;
  resourceKinds: readonly MergeClaimKind[];
}>;

class SqliteTelegramAgentStore implements TelegramAgentStore {
  private readonly claimOwner = randomUUID();
  private readonly claimedUpdates = new Map<number, number>();
  private readonly autonomyRepository: AutonomyRepository;
  private readonly capabilityRepository: CapabilityRepository;
  private readonly controllerEvidenceRepository: ControllerEvidenceRepository;
  private readonly controllerInteractionRepository: ControllerInteractionRepository;
  private readonly credentialAccessRepository: CredentialAccessRepository;
  private readonly stageExecutionRepository: StageExecutionRepository;

  public constructor(
    private readonly db: SqliteDatabase,
    private readonly kv: PluginKv,
    private readonly clock: () => number,
    private readonly controllerModelRoute: () => ModelRoute = () => DEFAULT_CONTROLLER_CAPABILITY_MODEL,
    private readonly capabilityDispatchSettings: () => CapabilityDispatchSettings = () => DEFAULT_CAPABILITY_DISPATCH_SETTINGS,
  ) {
    this.autonomyRepository = new AutonomyRepository(db);
    this.capabilityRepository = new CapabilityRepository(db);
    this.controllerInteractionRepository = new ControllerInteractionRepository(db);
    this.controllerEvidenceRepository = new ControllerEvidenceRepository(db, clock);
    this.credentialAccessRepository = new CredentialAccessRepository(db);
    this.stageExecutionRepository = new StageExecutionRepository(db);
  }

  public reconcileCredentialHealth(input: CredentialHealthReconcileInput): CredentialHealthReconcileResult {
    return this.credentialAccessRepository.reconcileCredentialHealth(input);
  }

  public listCredentialBindings(input: Readonly<{
    installationId: string;
    state?: BrokerBindingState;
    afterBindingId?: string;
    limit: number;
  }>): readonly CredentialBindingMetadata[] {
    return this.credentialAccessRepository.listCredentialBindings(input);
  }

  public getCredentialBinding(installationId: string, bindingId: string): CredentialBindingMetadata | null {
    return this.credentialAccessRepository.getCredentialBinding(installationId, bindingId);
  }

  public prepareCredentialDiagnosticOperation(input: Readonly<{
    installationId: string;
    envelope: BrokerRequestEnvelope;
    now: number;
  }>): CredentialDiagnosticPrepareResult {
    return this.credentialAccessRepository.prepareCredentialDiagnosticOperation(input);
  }

  public prepareCredentialVerificationOperation(
    input: CredentialVerificationPrepareInput,
  ): CredentialVerificationPrepareResult {
    return this.credentialAccessRepository.prepareCredentialVerificationOperation(input);
  }

  public markCredentialOperationAmbiguous(input: Readonly<{
    installationId: string;
    requestId: string;
    now: number;
  }>): CredentialOperationRecord | null {
    return this.credentialAccessRepository.markCredentialOperationAmbiguous(input);
  }

  public completeCredentialDiagnosticOperation(
    input: CredentialOperationCompleteInput,
  ): CredentialOperationCompleteResult {
    return this.credentialAccessRepository.completeCredentialDiagnosticOperation(input);
  }

  public completeCredentialVerificationOperation(
    input: CredentialVerificationCompleteInput,
  ): CredentialVerificationCompleteResult {
    return this.credentialAccessRepository.completeCredentialVerificationOperation(input);
  }

  public getCredentialReceipt(installationId: string, receiptId: string): CredentialReceiptRecord | null {
    return this.credentialAccessRepository.getCredentialReceipt(installationId, receiptId);
  }

  public getCredentialHealth(installationId: string): CredentialHealthRecord | null {
    return this.credentialAccessRepository.getCredentialHealth(installationId);
  }

  public createCapabilityProfile(input: CreateCapabilityProfileInput): CapabilityProfile {
    return this.capabilityRepository.createProfile(input);
  }

  public appendCapabilityReceipt(input: AppendCapabilityReceiptInput): CapabilityReceipt {
    return this.capabilityRepository.appendReceipt(input);
  }

  public appendCapabilityTerminalOutcome(input: AppendCapabilityTerminalInput): boolean {
    return this.capabilityRepository.appendTerminalOutcome(input);
  }

  public recordGuardFingerprint(input: GuardFingerprintPersistenceInput): number {
    return this.capabilityRepository.recordGuardFingerprint(input);
  }

  public settleGuardOutcomes(input: GuardSettlementPersistenceInput): GuardSettlementPersistenceResult {
    return this.capabilityRepository.settleGuardOutcomes(input);
  }

  public recordModelRouteSelection(input: RecordModelRouteSelectionInput): ModelRouteTrial {
    return this.capabilityRepository.recordModelRouteSelection(input);
  }

  public settleModelRouteTrial(input: SettleModelRouteTrialInput): ModelRouteTrial {
    return this.capabilityRepository.settleModelRouteTrial(input);
  }

  public listModelRouteTrials(
    subjectKind: CapabilitySubjectKind,
    subjectId: string,
    limit: number,
  ): ModelRouteTrial[] {
    return this.capabilityRepository.listModelRouteTrials(subjectKind, subjectId, limit);
  }

  public recordStageExecution(input: RecordStageExecutionInput): StageExecutionRecord {
    return this.stageExecutionRepository.recordStageExecution(input);
  }

  public settleStageExecution(input: SettleStageExecutionInput): StageExecutionRecord | null {
    return this.stageExecutionRepository.settleStageExecution(input);
  }

  public listStageExecutions(jobId: string, limit = 200): StageExecutionRecord[] {
    return this.stageExecutionRepository.listStageExecutions(jobId, limit);
  }

  public replaceExternalCapabilityInventory(input: {
    hostScope: string;
    items: readonly CapabilityInventoryItem[];
    now: number;
  }): void {
    this.capabilityRepository.replaceInventorySnapshot(input);
  }

  public recordExternalInventoryDiscoveryFailure(input: {
    hostScope: string;
    errorClass: string;
    now: number;
  }): void {
    this.capabilityRepository.recordInventoryDiscoveryFailure(input);
  }

  public listExternalCapabilityInventory(hostScope: string, limit: number): CapabilityInventoryItem[] {
    return this.capabilityRepository.listInventory(hostScope, limit);
  }

  public getExternalCapabilityInventoryHealth(hostScope: string): (InventoryHealth & { hostScope: string }) | null {
    return this.capabilityRepository.getInventoryHealth(hostScope);
  }

  public readDurableRecipePromotionEvidenceSnapshot(recipe: TaskRecipe): unknown | null {
    return this.capabilityRepository.readDurableRecipePromotionEvidenceSnapshot(recipe);
  }

  public appendRecipeRolloutDecision(input: AppendRecipeRolloutDecisionInput): RecipeRolloutDecision {
    return this.capabilityRepository.appendRecipeRolloutDecision(input);
  }

  public listRecipeRolloutDecisions(recipe: TaskRecipe, limit: number): RecipeRolloutDecision[] {
    return this.capabilityRepository.listRecipeRolloutDecisions(recipe, limit);
  }

  public getLatestRecipeRolloutDecision(recipe: TaskRecipe): RecipeRolloutDecision | null {
    return this.capabilityRepository.getLatestRecipeRolloutDecision(recipe);
  }

  public getActiveCapabilityProfile(
    subjectKind: CapabilitySubjectKind,
    subjectId: string,
  ): CapabilityProfile | null {
    return this.capabilityRepository.getActiveProfile(subjectKind, subjectId);
  }

  public getLatestCapabilityProfile(
    subjectKind: CapabilitySubjectKind,
    subjectId: string,
  ): CapabilityProfile | null {
    return this.capabilityRepository.getLatestProfile(subjectKind, subjectId);
  }

  public getCapabilityProfileById(profileId: string): CapabilityProfile | null {
    return this.capabilityRepository.getProfileById(profileId);
  }

  public getCapabilityProfileForThread(threadId: string): CapabilityProfile | null {
    return this.capabilityRepository.getProfileForThread(threadId);
  }

  public listCapabilityReceipts(profileId: string, limit: number): CapabilityReceipt[] {
    return this.capabilityRepository.listReceipts(profileId, limit);
  }

  public listSkillReceiptProjection(profileId: string, limit: number): SkillReceiptProjection[] {
    return this.capabilityRepository.listSkillReceiptProjection(profileId, limit);
  }

  public listMissingMandatoryCapabilityOutcomes(profileId: string): string[] {
    return this.capabilityRepository.listMissingMandatoryOutcomes(profileId);
  }

  private currentNow(): number {
    const now = this.clock();
    assertNonNegativeInteger(now, "store clock");
    return now;
  }

  public createPairingCode(
    codeHash: string,
    createdAt: number,
    expiresAt: number,
  ): void {
    assertSha256Hex(codeHash);
    this.db
      .prepare(
        "INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)",
      )
      .run(codeHash, createdAt, expiresAt);
  }

  public pairOwnerWithCode(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
  ): PairingResult {
    return this.pairOwnerWithCodeInternal(codeHash, userId, chatId, now, true);
  }

  public pairOwnerWithPrivateChatCode(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
  ): PairingResult {
    return this.pairOwnerWithCodeInternal(codeHash, userId, chatId, now, false);
  }

  private pairOwnerWithCodeInternal(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
    requireMatchingIdentity: boolean,
  ): PairingResult {
    assertSha256Hex(codeHash);
    assertCanonicalPositiveDecimal(userId, "userId");
    assertCanonicalPositiveDecimal(chatId, "chatId");
    if (requireMatchingIdentity && userId !== chatId) {
      throw new TypeError("V1 owner pairing requires userId to equal chatId for a private chat");
    }

    const pair = this.db.transaction((): PairingResult => {
      const code = this.db
        .prepare(
          "SELECT consumed_at, expires_at FROM pairing_codes WHERE code_hash = ?",
        )
        .get(codeHash) as PairingCodeRow | undefined;

      if (!code) return { ok: false, reason: "missing" };
      if (code.consumed_at !== null) return { ok: false, reason: "consumed" };
      if (now >= code.expires_at) return { ok: false, reason: "expired" };

      const owner = this.db
        .prepare(
          "SELECT telegram_user_id, telegram_chat_id, paired_at FROM owners WHERE singleton = 1 AND revoked_at IS NULL",
        )
        .get() as OwnerRow | undefined;
      if (owner) return { ok: false, reason: "already_paired" };

      const consumed = this.db
        .prepare(
          "UPDATE pairing_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?",
        )
        .run(now, codeHash, now);
      if (consumed.changes !== 1) {
        return { ok: false, reason: "consumed" };
      }

      this.db
        .prepare(
          `INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at)
           VALUES (1, ?, ?, ?, NULL)
           ON CONFLICT(singleton) DO UPDATE SET
             telegram_user_id = excluded.telegram_user_id,
             telegram_chat_id = excluded.telegram_chat_id,
             paired_at = excluded.paired_at,
             revoked_at = NULL`,
        )
        .run(userId, chatId, now);

      return { ok: true };
    });

    return pair();
  }

  public getOwner(): Owner | null {
    const row = this.db
      .prepare(
        "SELECT telegram_user_id, telegram_chat_id, paired_at FROM owners WHERE singleton = 1 AND revoked_at IS NULL",
      )
      .get() as OwnerRow | undefined;
    if (!row) return null;
    return {
      userId: row.telegram_user_id,
      chatId: row.telegram_chat_id,
      pairedAt: row.paired_at,
    };
  }

  public revokeOwner(now: number): boolean {
    return this.db.transaction((): boolean => {
      this.revokeControllerAccess(now);
      return this.db
        .prepare("UPDATE owners SET revoked_at = ? WHERE singleton = 1 AND revoked_at IS NULL")
        .run(now).changes === 1;
    }).immediate();
  }

  public enqueueControllerTurn(input: {
    controllerKey: string;
    telegramUserId: string;
    telegramChatId: string;
    updateId: number;
    inputText: string;
    image?: ControllerImage | null;
    origin?: "owner" | "system";
    threadFollowUp?: ThreadFollowUp;
    now: number;
  }): ControllerTurnRecord {
    assertControllerKey(input.controllerKey);
    assertCanonicalPositiveDecimal(input.telegramUserId, "telegramUserId");
    assertCanonicalPositiveDecimal(input.telegramChatId, "telegramChatId");
    assertNonNegativeInteger(input.updateId, "updateId");
    assertControllerText(input.inputText, "controller input");
    const image = input.image ? normalizeControllerImage(input.image) : null;
    if (image) assertControllerImage(image);
    const threadFollowUp = input.threadFollowUp === undefined
      ? null
      : validatedThreadFollowUp(input.threadFollowUp);
    const threadFollowUpJson = threadFollowUp === null ? null : JSON.stringify(threadFollowUp);
    assertNonNegativeInteger(input.now, "now");
    const dispatchSettings = this.capabilityDispatchSettings();
    if (
      !["adaptive", "legacy"].includes(dispatchSettings.jobGraph) ||
      !["bundled", "all-tools"].includes(dispatchSettings.controllerTools)
    ) throw new TypeError("Capability dispatch settings are invalid");
    const capabilitySelection = selectControllerCapabilityProfile(
      input.inputText,
      dispatchSettings.controllerTools === "all-tools" ? CONTROLLER_BUNDLE_IDS : undefined,
      this.controllerModelRoute(),
    );

    return this.db.transaction((): ControllerTurnRecord => {
      const owner = this.getOwner();
      if (!owner || owner.userId !== input.telegramUserId || owner.chatId !== input.telegramChatId) {
        throw new TypeError("controller owner is not the active paired owner");
      }

      const existing = this.db
        .prepare("SELECT * FROM controller_turns WHERE telegram_update_id = ?")
        .get(input.updateId) as ControllerTurnRow | undefined;
      if (existing) {
        if (
          existing.controller_key !== input.controllerKey ||
          existing.input_text !== input.inputText ||
          existing.image_file_id !== (image?.fileId ?? null) ||
          existing.image_file_name !== (image?.fileName ?? null) ||
          existing.image_mime_type !== (image?.mimeType ?? null) ||
          existing.image_size_bytes !== (image?.sizeBytes ?? null) ||
          (existing.image_kind ?? (existing.image_file_id ? "image" : null)) !== (image?.kind ?? null) ||
          existing.image_duration_seconds !== (image?.durationSeconds ?? null) ||
          existing.thumbnail_file_id !== (image?.thumbnail?.fileId ?? null) ||
          existing.thumbnail_file_name !== (image?.thumbnail?.fileName ?? null) ||
          existing.thumbnail_size_bytes !== (image?.thumbnail?.sizeBytes ?? null) ||
          existing.thread_follow_up_json !== threadFollowUpJson
        ) {
          throw new IdempotencyConflictError(input.updateId);
        }
        return parseControllerTurn(existing);
      }

      const controller = this.db
        .prepare("SELECT * FROM controller_threads WHERE controller_key = ?")
        .get(input.controllerKey) as ControllerThreadRow | undefined;
      if (controller && (
        controller.telegram_user_id !== input.telegramUserId ||
        controller.telegram_chat_id !== input.telegramChatId
      )) {
        throw new TypeError("controller key belongs to a different Telegram owner");
      }
      if (controller?.state === "revoked") {
        this.db.prepare(
          `UPDATE controller_threads
              SET project_id = NULL, host_id = NULL, bb_thread_id = NULL,
                  state = 'pending_spawn', pending_spawn_token = NULL,
                  capability_subject_id = NULL, capability_profile_id = NULL,
                  capability_profile_revision = 0,
                  last_error = NULL, updated_at = ?
            WHERE controller_key = ? AND state = 'revoked'`,
        ).run(input.now, input.controllerKey);
      }
      if (!controller) {
        this.db.prepare(
          `INSERT INTO controller_threads (
             controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at
           ) VALUES (?, ?, ?, 'pending_spawn', ?, ?)`,
        ).run(input.controllerKey, input.telegramUserId, input.telegramChatId, input.now, input.now);
      }

      const next = this.db
        .prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM controller_turns WHERE controller_key = ?")
        .get(input.controllerKey) as { ordinal: number };
      const id = `controller-turn-${input.updateId}`;
      this.db.prepare(
        `INSERT INTO controller_turns (
           id, telegram_update_id, controller_key, ordinal, input_text,
           image_file_id, image_file_name, image_mime_type, image_size_bytes,
           image_kind, image_duration_seconds,
           thumbnail_file_id, thumbnail_file_name, thumbnail_size_bytes,
           state, origin, thread_follow_up_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      ).run(
        id,
        input.updateId,
        input.controllerKey,
        next.ordinal,
        input.inputText,
        image?.fileId ?? null,
        image?.fileName ?? null,
        image?.mimeType ?? null,
        image?.sizeBytes ?? null,
        image?.kind ?? null,
        image?.durationSeconds ?? null,
        image?.thumbnail?.fileId ?? null,
        image?.thumbnail?.fileName ?? null,
        image?.thumbnail?.sizeBytes ?? null,
        input.origin === "system" ? "system" : "owner",
        threadFollowUpJson,
        input.now,
        input.now,
      );
      const profile = this.capabilityRepository.createProfile({
        subjectKind: "controller_turn",
        subjectId: id,
        threadId: null,
        recipeId: capabilitySelection.recipeId,
        recipeVersion: capabilitySelection.recipeVersion,
        registryDigest: capabilitySelection.registryDigest,
        graphDigest: capabilitySelection.graphDigest,
        mode: capabilitySelection.mode,
        model: capabilitySelection.model,
        assignments: [...capabilitySelection.assignments],
        reasonCodes: [...capabilitySelection.reasonCodes],
        traits: [...capabilitySelection.traits],
        expectedRevision: 1,
        now: input.now,
      });
      this.db.prepare(
        `UPDATE controller_turns
            SET capability_profile_id = ?, capability_profile_revision = ?
          WHERE id = ? AND capability_profile_id IS NULL`,
      ).run(profile.id, profile.revision, id);
      const stored = this.db.prepare("SELECT * FROM controller_turns WHERE id = ?").get(id) as ControllerTurnRow;
      return parseControllerTurn(stored);
    }).immediate();
  }

  public getControllerByThreadId(threadId: string): ControllerThreadRecord | null {
    assertControllerIdentifier(threadId, "threadId");
    const row = this.db.prepare(
      `SELECT controller_threads.* FROM controller_threads
         JOIN owners ON owners.singleton = 1
          AND owners.revoked_at IS NULL
          AND owners.telegram_user_id = controller_threads.telegram_user_id
          AND owners.telegram_chat_id = controller_threads.telegram_chat_id
        WHERE controller_threads.bb_thread_id = ? AND controller_threads.state <> 'revoked'`,
    ).get(threadId) as ControllerThreadRow | undefined;
    return row ? parseControllerThread(row) : null;
  }

  public getControllerForPendingSpawn(input: {
    controllerKey: string;
    turnId: string;
    pendingSpawnToken: string;
    now: number;
  }): ControllerThreadRecord | null {
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.turnId, "turnId");
    assertControllerIdentifier(input.pendingSpawnToken, "pendingSpawnToken");
    assertNonNegativeInteger(input.now, "now");
    const row = this.db.prepare(
      `SELECT controller.* FROM controller_threads AS controller
         JOIN controller_turns AS turn
           ON turn.id = ? AND turn.controller_key = controller.controller_key
         JOIN owners ON owners.singleton = 1
          AND owners.revoked_at IS NULL
          AND owners.telegram_user_id = controller.telegram_user_id
          AND owners.telegram_chat_id = controller.telegram_chat_id
         JOIN executor_lease AS lease ON lease.singleton = 1
        WHERE controller.controller_key = ?
          AND controller.state = 'pending_spawn'
          AND controller.bb_thread_id IS NULL
          AND controller.pending_spawn_token = ?
          AND turn.state = 'dispatching'
          AND turn.lease_owner IS NOT NULL
          AND turn.lease_owner = lease.owner_id
          AND turn.lease_generation = lease.generation
          AND lease.owner_id IS NOT NULL
          AND lease.lease_expires_at IS NOT NULL
          AND lease.lease_expires_at > ?`,
    ).get(
      input.turnId,
      input.controllerKey,
      input.pendingSpawnToken,
      input.now,
    ) as ControllerThreadRow | undefined;
    return row ? parseControllerThread(row) : null;
  }

  public getControllerForOwner(userId: string, chatId: string): ControllerThreadRecord | null {
    assertCanonicalPositiveDecimal(userId, "userId");
    assertCanonicalPositiveDecimal(chatId, "chatId");
    const row = this.db.prepare(
      `SELECT controller_threads.* FROM controller_threads
         JOIN owners ON owners.singleton = 1
          AND owners.revoked_at IS NULL
          AND owners.telegram_user_id = controller_threads.telegram_user_id
          AND owners.telegram_chat_id = controller_threads.telegram_chat_id
        WHERE controller_threads.telegram_user_id = ? AND controller_threads.telegram_chat_id = ?
          AND controller_threads.state <> 'revoked'`,
    ).get(userId, chatId) as ControllerThreadRow | undefined;
    return row ? parseControllerThread(row) : null;
  }

  public getControllerTurn(turnId: string): ControllerTurnRecord | null {
    assertControllerIdentifier(turnId, "turnId");
    const row = this.db.prepare("SELECT * FROM controller_turns WHERE id = ?").get(turnId) as ControllerTurnRow | undefined;
    return row ? parseControllerTurn(row) : null;
  }

  public requestControllerCapabilityExpansion(input: {
    controllerKey: string;
    turnId: string;
    expectedProfileId: string;
    bundleIds: readonly string[];
    now: number;
  }): ControllerCapabilityExpansionResult {
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.turnId, "turnId");
    assertControllerIdentifier(input.expectedProfileId, "expectedProfileId");
    assertNonNegativeInteger(input.now, "now");
    if (input.bundleIds.length < 1 || input.bundleIds.length > 6 || new Set(input.bundleIds).size !== input.bundleIds.length) {
      throw new TypeError("bundleIds must contain between one and six unique bundle ids");
    }

    return this.db.transaction((): ControllerCapabilityExpansionResult => {
      const turn = this.db.prepare(
        `SELECT turn.* FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
          WHERE turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
            AND controller.state = 'active' AND controller.bb_thread_id IS NOT NULL
            AND controller.capability_subject_id = turn.id`,
      ).get(input.turnId, input.controllerKey) as ControllerTurnRow | undefined;
      if (!turn) return { outcome: "denied", reasonCode: "turn_not_active" };
      if (turn.capability_profile_id !== input.expectedProfileId) {
        return { outcome: "denied", reasonCode: "stale_profile" };
      }
      const current = this.capabilityRepository.getProfileById(input.expectedProfileId);
      if (
        !current || current.subjectKind !== "controller_turn" || current.subjectId !== turn.id ||
        current.mode !== "active" || current.revision !== turn.capability_profile_revision
      ) {
        return { outcome: "denied", reasonCode: "profile_mismatch" };
      }

      const appendRequestReceipts = (
        profile: CapabilityProfile,
        eventType: "requested" | "denied",
        reasonCode: string,
      ): void => {
        for (const bundleId of input.bundleIds) {
          const capabilityId = `controller-bundle-${bundleId}`;
          const descriptor = CAPABILITY_BY_ID.get(capabilityId);
          if (!descriptor || descriptor.kind !== "bundle") continue;
          this.capabilityRepository.appendReceipt({
            profileId: profile.id,
            capabilityId,
            capabilityKind: descriptor.kind,
            descriptorDigest: descriptor.digest,
            eventType,
            reasonCode,
            mandatory: descriptor.evidence.requirement === "mandatory",
            evidenceRefs: [],
            now: input.now,
          });
        }
      };

      if (turn.capability_continuation_count >= 1) {
        appendRequestReceipts(current, "requested", "capability_expansion_requested");
        appendRequestReceipts(current, "denied", "expansion_limit");
        return { outcome: "denied", reasonCode: "expansion_limit" };
      }

      const selection = expandControllerCapabilityProfile(current, input.bundleIds);
      if ("denied" in selection) {
        appendRequestReceipts(current, "requested", "capability_expansion_requested");
        appendRequestReceipts(current, "denied", selection.denied);
        return { outcome: "denied", reasonCode: selection.denied };
      }
      const profile = this.capabilityRepository.createProfile({
        subjectKind: "controller_turn",
        subjectId: turn.id,
        threadId: null,
        recipeId: selection.recipeId,
        recipeVersion: selection.recipeVersion,
        registryDigest: selection.registryDigest,
        graphDigest: selection.graphDigest,
        mode: selection.mode,
        model: selection.model,
        assignments: [...selection.assignments],
        reasonCodes: [...selection.reasonCodes],
        traits: [...selection.traits],
        expectedRevision: current.revision + 1,
        now: input.now,
      });
      appendRequestReceipts(profile, "requested", "capability_expansion_requested");
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET capability_profile_id = ?, capability_profile_revision = ?,
                capability_continuation_count = 1,
                capability_continuation_state = 'requested', updated_at = ?
          WHERE id = ? AND state = 'submitted' AND capability_continuation_count = 0
            AND capability_profile_id = ? AND capability_profile_revision = ?`,
      ).run(
        profile.id,
        profile.revision,
        input.now,
        turn.id,
        current.id,
        current.revision,
      );
      if (updated.changes !== 1) throw new Error("Controller capability profile changed during expansion");
      return {
        outcome: "resume_required",
        continuationCount: 1,
        profile,
        selectedBundleIds: controllerBundleIdsFromProfile(profile),
      };
    }).immediate();
  }

  public prepareControllerCapabilityContinuation(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    expectedThreadId: string;
  }): boolean {
    this.assertControllerMutation(input);
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.expectedThreadId, "expectedThreadId");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const turn = this.db.prepare(
        `SELECT turn.* FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
          WHERE turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
            AND turn.capability_continuation_count = 1
            AND turn.capability_continuation_state = 'requested'
            AND controller.bb_thread_id = ? AND controller.state = 'active'
            AND controller.capability_subject_id = turn.id`,
      ).get(input.turnId, input.controllerKey, input.expectedThreadId) as ControllerTurnRow | undefined;
      if (!turn?.capability_profile_id) return false;
      const profile = this.capabilityRepository.getActiveProfile("controller_turn", turn.id);
      if (!profile || profile.id !== turn.capability_profile_id || profile.revision !== turn.capability_profile_revision) {
        return false;
      }
      const requeued = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
                dispatch_after_seq = 0, bb_event_seq = 0, stream_text = '',
                stream_phase = 'queued', response_text = NULL, submitted_at = NULL,
                awaiting_interaction_id = NULL, tool_calls = 0, command_failures = 0,
                total_tokens = 0, token_baseline = NULL,
                capability_continuation_state = 'relaunching', last_error = NULL,
                updated_at = ?
          WHERE id = ? AND state = 'submitted' AND capability_continuation_state = 'requested'`,
      ).run(input.now, turn.id);
      if (requeued.changes !== 1) return false;
      const retired = this.db.prepare(
        `UPDATE controller_threads
            SET project_id = NULL, host_id = NULL, bb_thread_id = NULL,
                state = 'pending_spawn', pending_spawn_token = NULL,
                capability_subject_id = NULL, capability_profile_id = NULL,
                capability_profile_revision = 0, last_error = NULL, updated_at = ?
          WHERE controller_key = ? AND bb_thread_id = ? AND state = 'active'`,
      ).run(input.now, input.controllerKey, input.expectedThreadId);
      if (retired.changes !== 1) throw new Error("Controller generation changed during capability continuation");
      this.db.prepare(
        `UPDATE controller_generations SET ended_at = ?, end_reason = ?
          WHERE controller_key = ? AND thread_id = ? AND ended_at IS NULL`,
      ).run(input.now, "Capability profile continuation", input.controllerKey, input.expectedThreadId);
      return true;
    }).immediate();
  }

  public adoptSubmittedControllerTurnFence(
    input: ControllerLeaseFence & Readonly<{ turnId: string }>,
  ): boolean {
    return this.controllerEvidenceRepository.adoptSubmittedTurnFence(input);
  }

  public recordControllerEvidence(input: ControllerEvidenceInput): ControllerEvidenceWrite {
    return this.controllerEvidenceRepository.record(input);
  }

  public settleToolReceiptAndRecordEvidence(
    input: ControllerToolReceiptSettlementInput,
  ): ControllerEvidenceWrite {
    return this.controllerEvidenceRepository.settleToolReceiptAndRecordEvidence(input);
  }

  public recordControllerNativeEvidence(
    input: ControllerNativeEvidenceInput,
  ): ControllerNativeEvidenceWrite {
    return this.controllerEvidenceRepository.recordNativeBatch(input);
  }

  public listControllerEvidence(turnId: string, limit: number): ControllerEvidenceRecord[] {
    return this.controllerEvidenceRepository.list(turnId, limit);
  }

  public countControllerEvidence(turnId: string): number {
    return this.controllerEvidenceRepository.count(turnId);
  }

  public getControllerEvidence(turnId: string, evidenceId: number): ControllerEvidenceRecord | null {
    return this.controllerEvidenceRepository.get(turnId, evidenceId);
  }

  public proposeControllerFinalization(
    input: ControllerFinalizationProposalInput,
  ): ControllerFinalizationProposalResult {
    return this.controllerEvidenceRepository.proposeFinalization(input);
  }

  public getAcceptedControllerFinalization(turnId: string): AcceptedControllerFinalization | null {
    return this.controllerEvidenceRepository.getAcceptedFinalization(turnId);
  }

  public claimControllerCompletionContinuation(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    bbHighWaterSeq: number;
  }): "claimed" | "already_claimed" | "stale" {
    return this.controllerEvidenceRepository.claimCompletionContinuation(input);
  }

  /**
   * Record what the controller asked a worker thread to do, at the moment it
   * sends. The substance is captured here rather than reconstructed later,
   * because this is when the controller knows why it is asking.
   *
   * An ask that cannot be safely repeated is still recorded, with its text
   * withheld: the owner learns that his authority was used either way.
   */
  public recordControllerThreadAsk(input: {
    controllerKey: string;
    turnId: string;
    threadId: string;
    threadName: string | null;
    ask: string;
    now: number;
  }): void {
    assertControllerKey(input.controllerKey);
    assertNonNegativeInteger(input.now, "now");
    const normalized = normalizeThreadAsk(input.ask);
    const repeatable = normalized.length > 0 && !isUnsafeProviderText(normalized);
    this.db.prepare(
      `INSERT INTO controller_thread_asks
         (controller_key, turn_id, thread_id, thread_name, ask, recorded_at, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      input.controllerKey,
      input.turnId,
      input.threadId,
      input.threadName === null ? null : normalizeThreadName(input.threadName),
      repeatable ? normalized : THREAD_ASK_REDACTED,
      input.now,
    );
  }

  /**
   * Asks this controller has not yet told the owner about, oldest first.
   *
   * Keyed to the controller rather than one turn, so an ask made by a turn that
   * died before replying is still waiting on the next reply instead of being
   * lost with it.
   *
   * The read is bounded because the reply that consumes it is. The bound also
   * caps the "and N more" count, so it is set far above any backlog a replying
   * controller can build: reaching it needs hundreds of sends without one
   * completed turn.
   */
  public unreportedControllerThreadAsks(controllerKey: string): RecordedThreadAsk[] {
    assertControllerKey(controllerKey);
    const rows = this.db.prepare(
      `SELECT thread_id, thread_name, ask FROM controller_thread_asks
        WHERE controller_key = ? AND reported_at IS NULL
        ORDER BY id ASC LIMIT 256`,
    ).all(controllerKey) as { thread_id: string; thread_name: string | null; ask: string }[];
    return rows.map((row) => ({
      threadId: row.thread_id,
      threadName: row.thread_name,
      ask: row.ask,
    }));
  }

  /**
   * Mark the oldest `count` unreported asks as told, in the same order the
   * reply states them. Asks the reply only counted rather than named stay
   * unreported so the next reply can name them.
   */
  private markControllerThreadAsksReported(controllerKey: string, count: number, now: number): void {
    if (count <= 0) return;
    this.db.prepare(
      `UPDATE controller_thread_asks SET reported_at = ?
        WHERE id IN (
          SELECT id FROM controller_thread_asks
           WHERE controller_key = ? AND reported_at IS NULL
           ORDER BY id ASC LIMIT ?
        )`,
    ).run(now, controllerKey, count);
  }

  public completeControllerTurnFromFinalization(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    bbHighWaterSeq: number;
  }): "completed" | "stale" | "evidence_advanced" {
    this.assertControllerMutation(input);
    assertControllerKey(input.controllerKey);
    return this.db.transaction(() => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return "stale" as const;
      const turn = this.db.prepare(
        `SELECT turn.controller_key, turn.ordinal, turn.input_text,
                turn.accepted_finalization_id, turn.thread_follow_up_json,
                turn.evidence_limit_exceeded_at, controller.telegram_chat_id
           FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
            AND turn.lease_owner = ? AND turn.lease_generation = ?
            AND turn.accepted_finalization_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM controller_supervisor_steer_attempts
               WHERE turn_id = turn.id AND state = 'pending'
            )
            AND controller.state = 'active'`,
      ).get(
        input.turnId,
        input.controllerKey,
        input.ownerId,
        input.generation,
      ) as {
        controller_key: string;
        ordinal: number;
        input_text: string;
        accepted_finalization_id: number;
        thread_follow_up_json: string | null;
        evidence_limit_exceeded_at: number | null;
        telegram_chat_id: string;
      } | undefined;
      if (!turn) return "stale" as const;
      const accepted = this.controllerEvidenceRepository.getAcceptedFinalization(input.turnId);
      if (!accepted || accepted.id !== turn.accepted_finalization_id || accepted.consumedAt !== null) {
        return "stale" as const;
      }
      if (this.db.prepare(
        `SELECT 1 FROM controller_interactions
          WHERE turn_id = ? AND controller_key = ? AND state IN ('pending', 'answered')
          LIMIT 1`,
      ).get(input.turnId, input.controllerKey)) {
        return "stale" as const;
      }
      const completionHighWater = input.bbHighWaterSeq;
      if (
          !Number.isSafeInteger(completionHighWater) || completionHighWater < 0 ||
          (accepted.bbEventHighWaterSeq !== null && completionHighWater < accepted.bbEventHighWaterSeq)) {
        return "evidence_advanced" as const;
      }
      // Composed inside the transaction that delivers it, so marking an ask
      // told and sending the message that tells him either both happen or
      // neither do. An ask the owner never hears about is a decision taken in
      // his name that he cannot see, so it must not be lost to a failed write.
      const pendingAsks = this.unreportedControllerThreadAsks(turn.controller_key);
      const reply = composeOwnerReply(accepted.renderedMessage, pendingAsks, MAX_OWNER_REPLY_CHARS, {
        evidenceBudgetSpent: turn.evidence_limit_exceeded_at !== null,
      });
      const completed = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'completed', response_text = ?, stream_text = '',
                stream_phase = 'complete', last_error = NULL, lease_owner = NULL,
                lease_generation = NULL, private_draft_item_id = NULL,
                private_draft_text = '', delivery_state = 'none',
                delivery_reconcile_attempts = 0, next_dispatch_at = 0,
                completed_at = ?, updated_at = ?
          WHERE id = ? AND controller_key = ? AND state = 'submitted'
            AND lease_owner = ? AND lease_generation = ?
            AND accepted_finalization_id = ?`,
      ).run(
        reply.text,
        input.now,
        input.now,
        input.turnId,
        input.controllerKey,
        input.ownerId,
        input.generation,
        accepted.id,
      );
      if (completed.changes !== 1) return "stale" as const;
      this.markControllerThreadAsksReported(turn.controller_key, reply.reportedCount, input.now);
      this.appendControllerDigestRow({
        controllerKey: turn.controller_key,
        ordinal: turn.ordinal,
        ownerText: turn.input_text,
        agentText: reply.text,
        now: input.now,
      });
      const consumed = this.db.prepare(
        "UPDATE controller_finalizations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
      ).run(input.now, accepted.id);
      if (consumed.changes !== 1) throw new Error("Accepted controller finalization consumption raced");
      persistControllerOutbox(this.db, {
        logicalKey: controllerReplyLogicalKey(input.turnId, turn.thread_follow_up_json),
        chatId: turn.telegram_chat_id,
        payload: { text: reply.text, disable_web_page_preview: true },
      }, input.now);
      return "completed" as const;
    }).immediate();
  }

  public claimNextControllerTurn(
    fence: ControllerLeaseFence & { leaseMs?: number },
  ): ControllerTurnRecord | null {
    this.assertLeaseIdentity("controller-turn", fence.ownerId, fence.generation, fence.now);
    return this.db.transaction((): ControllerTurnRecord | null => {
      if (!this.executorLeaseIsCurrent(fence.ownerId, fence.generation, fence.now)) return null;
      const row = this.db.prepare(
        `SELECT turn.* FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1
            AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE turn.state = 'queued'
            AND turn.delivery_state = 'none'
            AND turn.next_dispatch_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM controller_turns AS active
               WHERE active.controller_key = turn.controller_key
                 AND active.state IN ('dispatching', 'submitted')
            )
          ORDER BY turn.created_at ASC, turn.ordinal ASC LIMIT 1`,
      ).get(fence.now) as ControllerTurnRow | undefined;
      if (!row) return null;
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'dispatching', lease_owner = ?, lease_generation = ?, updated_at = ?
          WHERE id = ? AND state = 'queued'`,
      ).run(fence.ownerId, fence.generation, fence.now, row.id);
      if (updated.changes !== 1) return null;
      this.db.prepare(
        `UPDATE controller_threads
            SET pending_spawn_token = COALESCE(pending_spawn_token, ?), updated_at = ?
          WHERE controller_key = ? AND bb_thread_id IS NULL`,
      ).run(row.id, fence.now, row.controller_key);
      const claimed = this.db.prepare("SELECT * FROM controller_turns WHERE id = ?").get(row.id) as ControllerTurnRow;
      return parseControllerTurn(claimed);
    }).immediate();
  }

  public prepareControllerDispatch(input: ControllerLeaseFence & {
    turnId: string;
    kind: ControllerDispatchKind;
    expectedThreadId?: string;
    dispatchAfterSeq?: number;
  }): boolean {
    this.assertControllerMutation(input);
    if (input.kind !== "send" && input.kind !== "spawn") {
      throw new TypeError("controller dispatch kind is invalid");
    }
    if (input.kind === "send") {
      if (input.expectedThreadId === undefined) {
        throw new TypeError("send dispatch requires an expected thread id");
      }
      assertControllerIdentifier(input.expectedThreadId, "expectedThreadId");
    }
    const dispatchAfterSeq = input.dispatchAfterSeq ?? 0;
    assertNonNegativeInteger(dispatchAfterSeq, "dispatchAfterSeq");
    if (input.kind === "spawn" && dispatchAfterSeq !== 0) {
      throw new TypeError("spawn dispatch cannot carry a timeline baseline");
    }
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const row = this.db.prepare(
        `SELECT turn.controller_key, turn.thread_follow_up_json,
                controller.telegram_chat_id, controller.state AS controller_state,
                controller.bb_thread_id, controller.pending_spawn_token
           FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE turn.id = ? AND turn.state = 'dispatching'
            AND turn.lease_owner = ? AND turn.lease_generation = ?
            AND turn.delivery_state = 'none'`,
      ).get(input.turnId, input.ownerId, input.generation) as {
        controller_key: string;
        thread_follow_up_json: string | null;
        telegram_chat_id: string;
        controller_state: ControllerThreadState;
        bb_thread_id: string | null;
        pending_spawn_token: string | null;
      } | undefined;
      if (!row) return false;
      if (input.kind === "send" && (
        row.controller_state !== "active" || row.bb_thread_id !== input.expectedThreadId
      )) return false;
      if (input.kind === "spawn" && (
        row.controller_state !== "pending_spawn" || row.bb_thread_id !== null ||
        row.pending_spawn_token !== input.turnId
      )) return false;
      const correlationId = input.kind === "spawn"
        ? input.turnId
        : `controller-dispatch:${input.turnId}`;
      const prepared = this.db.prepare(
        `UPDATE controller_turns
            SET delivery_state = 'intent', dispatch_kind = ?, dispatch_correlation_id = ?,
                dispatch_after_seq = ?, dispatch_retry_count = 0,
                delivery_reconcile_attempts = 0, next_dispatch_at = 0,
                last_error = NULL, updated_at = ?
          WHERE id = ? AND state = 'dispatching' AND delivery_state = 'none'
            AND lease_owner = ? AND lease_generation = ?`,
      ).run(
        input.kind,
        correlationId,
        dispatchAfterSeq,
        input.now,
        input.turnId,
        input.ownerId,
        input.generation,
      );
      if (prepared.changes !== 1) return false;
      persistControllerOutbox(this.db, controllerPhaseOutbox(
        input.turnId,
        row.telegram_chat_id,
        "connecting",
        row.thread_follow_up_json,
      ), input.now);
      return true;
    }).immediate();
  }

  public markControllerDeliveryUnknown(
    input: ControllerLeaseFence & { turnId: string },
  ): boolean {
    this.assertControllerMutation(input);
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      return this.db.prepare(
        `UPDATE controller_turns
            SET delivery_state = 'delivery_unknown',
                last_error = 'Controller delivery outcome is unknown',
                next_dispatch_at = ?, updated_at = ?
          WHERE id = ? AND delivery_state = 'intent'
            AND (
              state = 'dispatching' OR (
                state = 'submitted' AND completion_continuations = 1
                AND dispatch_kind = 'send'
                AND dispatch_correlation_id = 'controller-continuation:' || id || ':1'
              )
            )
            AND lease_owner = ? AND lease_generation = ?`,
      ).run(
        input.now,
        input.now,
        input.turnId,
        input.ownerId,
        input.generation,
      ).changes === 1;
    }).immediate();
  }

  public recordControllerDeliveryReconciliationPending(input: ControllerLeaseFence & {
    turnId: string;
    retryAfterMs: number;
  }): ControllerDeliveryReconciliationResult {
    this.assertControllerMutation(input);
    assertNonNegativeInteger(input.retryAfterMs, "retryAfterMs");
    const nextDispatchAt = input.now + input.retryAfterMs;
    assertNonNegativeInteger(nextDispatchAt, "nextDispatchAt");
    return this.db.transaction((): ControllerDeliveryReconciliationResult => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return "stale";
      const row = this.db.prepare(
        `SELECT turn.controller_key, turn.state, turn.delivery_reconcile_attempts,
                turn.thread_follow_up_json, controller.telegram_chat_id,
                controller.bb_thread_id, controller.pending_spawn_token
           FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE turn.id = ? AND (
              turn.state = 'dispatching' OR (
                turn.state = 'submitted' AND turn.completion_continuations = 1
                AND turn.dispatch_kind = 'send'
                AND turn.dispatch_correlation_id = 'controller-continuation:' || turn.id || ':1'
              )
            )
            AND turn.delivery_state = 'delivery_unknown'
            AND turn.lease_owner = ? AND turn.lease_generation = ?`,
      ).get(input.turnId, input.ownerId, input.generation) as {
        controller_key: string;
        state: "dispatching" | "submitted";
        delivery_reconcile_attempts: number;
        thread_follow_up_json: string | null;
        telegram_chat_id: string;
        bb_thread_id: string | null;
        pending_spawn_token: string | null;
      } | undefined;
      if (!row) return "stale";
      const attempts = row.delivery_reconcile_attempts + 1;
      if (attempts >= MAX_CONTROLLER_DELIVERY_RECONCILIATION_ATTEMPTS) {
        if (row.state === "submitted") {
          const released = this.db.prepare(
            `UPDATE controller_turns
                SET delivery_state = 'none', delivery_reconcile_attempts = ?,
                    next_dispatch_at = 0,
                    last_error = 'Controller correction delivery could not be reconciled',
                    updated_at = ?
              WHERE id = ? AND state = 'submitted'
                AND delivery_state = 'delivery_unknown'
                AND lease_owner = ? AND lease_generation = ?`,
          ).run(
            attempts,
            input.now,
            input.turnId,
            input.ownerId,
            input.generation,
          );
          return released.changes === 1 ? "recovery_required" : "stale";
        }
        const failed = this.db.prepare(
          `UPDATE controller_turns
              SET state = 'failed', delivery_reconcile_attempts = ?,
                  last_error = 'Controller delivery could not be reconciled',
                  stream_text = '', stream_phase = 'failed',
                  lease_owner = NULL, lease_generation = NULL,
                  next_dispatch_at = 0, completed_at = ?, updated_at = ?
            WHERE id = ? AND state = 'dispatching'
              AND delivery_state = 'delivery_unknown'
              AND lease_owner = ? AND lease_generation = ?`,
        ).run(
          attempts,
          input.now,
          input.now,
          input.turnId,
          input.ownerId,
          input.generation,
        );
        if (failed.changes !== 1) return "stale";
        if (row.bb_thread_id === null && row.pending_spawn_token === input.turnId) {
          this.db.prepare(
            `UPDATE controller_threads
                SET project_id = NULL, host_id = NULL, pending_spawn_token = NULL, updated_at = ?
              WHERE controller_key = ? AND bb_thread_id IS NULL AND pending_spawn_token = ?`,
          ).run(input.now, row.controller_key, input.turnId);
        }
        persistControllerOutbox(this.db, controllerFailureOutbox(
          input.turnId,
          row.telegram_chat_id,
          "owner_message_delivery_unresolved",
          row.thread_follow_up_json,
        ), input.now);
        return "failed";
      }
      const pending = this.db.prepare(
        `UPDATE controller_turns
            SET delivery_reconcile_attempts = ?,
                last_error = 'Controller delivery reconciliation is pending',
                next_dispatch_at = ?, updated_at = ?
          WHERE id = ? AND state IN ('dispatching', 'submitted')
            AND delivery_state = 'delivery_unknown'
            AND lease_owner = ? AND lease_generation = ?`,
      ).run(
        attempts,
        nextDispatchAt,
        input.now,
        input.turnId,
        input.ownerId,
        input.generation,
      );
      if (pending.changes !== 1) return "stale";
      persistControllerOutbox(
        this.db,
        row.state === "dispatching"
          ? controllerFailureOutbox(
            input.turnId,
            row.telegram_chat_id,
            "owner_message_delivery_uncertain",
            row.thread_follow_up_json,
          )
          : controllerPhaseOutbox(
            input.turnId,
            row.telegram_chat_id,
            "connecting",
            row.thread_follow_up_json,
          ),
        input.now,
      );
      return "pending";
    }).immediate();
  }

  public reserveControllerSpawn(input: {
    controllerKey: string;
    turnId: string;
    projectId: string;
    hostId: string;
    now: number;
  }): boolean {
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.turnId, "turnId");
    assertControllerIdentifier(input.projectId, "projectId");
    assertControllerIdentifier(input.hostId, "hostId");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): boolean => {
      const eligible = this.db.prepare(
        `SELECT controller.controller_key
           FROM controller_threads AS controller
           JOIN controller_turns AS turn
             ON turn.id = ? AND turn.controller_key = controller.controller_key
           JOIN owners ON owners.singleton = 1
            AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
           JOIN executor_lease AS lease ON lease.singleton = 1
          WHERE controller.controller_key = ?
            AND controller.state = 'pending_spawn'
            AND controller.bb_thread_id IS NULL
            AND controller.pending_spawn_token = ?
            AND (controller.project_id IS NULL AND controller.host_id IS NULL
                 OR controller.project_id = ? AND controller.host_id = ?)
            AND turn.state = 'dispatching'
            AND turn.lease_owner = lease.owner_id
            AND turn.lease_generation = lease.generation
            AND lease.lease_expires_at > ?`,
      ).get(
        input.turnId,
        input.controllerKey,
        input.turnId,
        input.projectId,
        input.hostId,
        input.now,
      );
      if (!eligible) return false;
      return this.db.prepare(
        `UPDATE controller_threads
            SET project_id = ?, host_id = ?, updated_at = ?
          WHERE controller_key = ? AND state = 'pending_spawn' AND bb_thread_id IS NULL
            AND pending_spawn_token = ?
            AND (project_id IS NULL AND host_id IS NULL
                 OR project_id = ? AND host_id = ?)` ,
      ).run(
        input.projectId,
        input.hostId,
        input.now,
        input.controllerKey,
        input.turnId,
        input.projectId,
        input.hostId,
      ).changes === 1;
    }).immediate();
  }

  // A claim taken while the BB thread is still answering is returned to the
  // queue; the service separately bounds that wait with a notice and rollover.
  public requeueControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    retryAfterMs?: number;
    error?: string;
    incrementDispatchRetry?: boolean;
  }): boolean {
    this.assertControllerMutation(input);
    const retryAfterMs = input.retryAfterMs ?? 0;
    assertNonNegativeInteger(retryAfterMs, "retryAfterMs");
    const nextDispatchAt = input.now + retryAfterMs;
    assertNonNegativeInteger(nextDispatchAt, "nextDispatchAt");
    if (input.error !== undefined) {
      assertSafeFailureSummary(input.error);
      assertNoRawMergeCallback(input.error, "controller requeue error");
    }
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const row = this.db.prepare(
        `SELECT turn.controller_key, turn.thread_follow_up_json, controller.telegram_chat_id
           FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE turn.id = ? AND turn.state = 'dispatching' AND turn.delivery_state = 'none'
            AND turn.lease_owner = ? AND turn.lease_generation = ?`,
      ).get(input.turnId, input.ownerId, input.generation) as {
        controller_key: string;
        thread_follow_up_json: string | null;
        telegram_chat_id: string;
      } | undefined;
      if (!row) return false;
      const requeued = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
                dispatch_after_seq = 0, delivery_state = 'none', dispatch_kind = NULL,
                dispatch_correlation_id = NULL, delivery_reconcile_attempts = 0,
                dispatch_retry_count = CASE WHEN ? = 1
                  THEN MIN(dispatch_retry_count + 1, ?)
                  ELSE dispatch_retry_count
                END,
                next_dispatch_at = ?, last_error = ?, updated_at = ?
          WHERE id = ? AND state = 'dispatching' AND delivery_state = 'none'
            AND lease_owner = ? AND lease_generation = ?`,
      ).run(
        input.incrementDispatchRetry === true ? 1 : 0,
        MAX_CONTROLLER_DISPATCH_RETRY_COUNT,
        nextDispatchAt,
        input.error ?? null,
        input.now,
        input.turnId,
        input.ownerId,
        input.generation,
      );
      if (requeued.changes !== 1) return false;
      this.db.prepare(
        `UPDATE controller_threads SET project_id = NULL, host_id = NULL, pending_spawn_token = NULL, updated_at = ?
          WHERE controller_key = ? AND bb_thread_id IS NULL AND pending_spawn_token = ?`,
      ).run(input.now, row.controller_key, input.turnId);
      persistControllerOutbox(this.db, controllerPhaseOutbox(
        input.turnId,
        row.telegram_chat_id,
        "queued",
        row.thread_follow_up_json,
      ), input.now);
      return true;
    }).immediate();
  }

  public recordControllerBusyWaitNotice(
    input: ControllerLeaseFence & { turnId: string },
  ): boolean {
    this.assertControllerMutation(input);
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const row = this.db.prepare(
        `SELECT turn.thread_follow_up_json, controller.telegram_chat_id
           FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE turn.id = ? AND turn.state = 'dispatching' AND turn.delivery_state = 'none'
            AND turn.busy_wait_notified_at IS NULL
            AND turn.lease_owner = ? AND turn.lease_generation = ?`,
      ).get(input.turnId, input.ownerId, input.generation) as {
        thread_follow_up_json: string | null;
        telegram_chat_id: string;
      } | undefined;
      if (!row) return false;
      const recorded = this.db.prepare(
        `UPDATE controller_turns
            SET busy_wait_notified_at = ?, updated_at = ?
          WHERE id = ? AND state = 'dispatching' AND delivery_state = 'none'
            AND busy_wait_notified_at IS NULL
            AND lease_owner = ? AND lease_generation = ?`,
      ).run(
        input.now,
        input.now,
        input.turnId,
        input.ownerId,
        input.generation,
      );
      if (recorded.changes !== 1) return false;
      const notice = controllerFailureOutbox(
        input.turnId,
        row.telegram_chat_id,
        "owner_message_waiting_for_fresh_generation",
        row.thread_follow_up_json,
      );
      persistControllerOutbox(this.db, {
        ...notice,
        logicalKey: row.thread_follow_up_json === null
          ? `controller:${input.turnId}:busy-wait`
          : notice.logicalKey,
      }, input.now);
      return true;
    }).immediate();
  }

  public recordControllerImagePreparationFailure(
    input: ControllerLeaseFence & { turnId: string; incrementRetry?: boolean },
  ): boolean {
    this.assertControllerMutation(input);
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const row = this.db.prepare(
        `SELECT turn.controller_key, turn.thread_follow_up_json, controller.telegram_chat_id
           FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
          WHERE turn.id = ? AND turn.state = 'dispatching'
            AND turn.lease_owner = ? AND turn.lease_generation = ?
            AND turn.delivery_state IN ('none', 'intent')`,
      ).get(input.turnId, input.ownerId, input.generation) as {
        controller_key: string;
        thread_follow_up_json: string | null;
        telegram_chat_id: string;
      } | undefined;
      if (!row) return false;
      const requeued = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'queued', retry_count = retry_count + ?,
                lease_owner = NULL, lease_generation = NULL,
                dispatch_after_seq = 0, delivery_state = 'none', dispatch_kind = NULL,
                dispatch_correlation_id = NULL, dispatch_retry_count = 0,
                delivery_reconcile_attempts = 0, next_dispatch_at = ?,
                last_error = 'Controller image preparation failed', updated_at = ?
          WHERE id = ? AND state = 'dispatching' AND lease_owner = ? AND lease_generation = ?
            AND delivery_state IN ('none', 'intent')`,
      ).run(
        input.incrementRetry === false ? 0 : 1,
        input.now,
        input.now,
        input.turnId,
        input.ownerId,
        input.generation,
      );
      if (requeued.changes !== 1) return false;
      this.db.prepare(
        `UPDATE controller_threads SET project_id = NULL, host_id = NULL, pending_spawn_token = NULL, updated_at = ?
          WHERE controller_key = ? AND bb_thread_id IS NULL AND pending_spawn_token = ?`,
      ).run(input.now, row.controller_key, input.turnId);
      persistControllerOutbox(this.db, controllerPhaseOutbox(
        input.turnId,
        row.telegram_chat_id,
        "queued",
        row.thread_follow_up_json,
      ), input.now);
      return true;
    }).immediate();
  }

  public failStaleControllerDispatches(fence: ControllerLeaseFence): boolean {
    this.assertLeaseIdentity("controller-turn", fence.ownerId, fence.generation, fence.now);
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(fence.ownerId, fence.generation, fence.now)) return false;
      const stale = this.db.prepare(
        `SELECT turn.*, controller.telegram_chat_id FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE (
              turn.state = 'dispatching' OR (
                turn.state = 'submitted' AND turn.delivery_state IN ('intent', 'delivery_unknown')
                AND turn.completion_continuations = 1 AND turn.dispatch_kind = 'send'
                AND turn.dispatch_correlation_id = 'controller-continuation:' || turn.id || ':1'
              )
            )
            AND (turn.lease_owner <> ? OR turn.lease_generation <> ?)
          ORDER BY turn.created_at ASC, turn.ordinal ASC LIMIT 1`,
      ).get(fence.ownerId, fence.generation) as (ControllerTurnRow & { telegram_chat_id: string }) | undefined;
      if (!stale) return false;
      if (stale.delivery_state === "none") {
        const requeued = this.db.prepare(
          `UPDATE controller_turns
              SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
                  dispatch_after_seq = 0, dispatch_kind = NULL,
                  dispatch_correlation_id = NULL, delivery_reconcile_attempts = 0,
                  next_dispatch_at = ?, updated_at = ?
            WHERE id = ? AND state = 'dispatching' AND delivery_state = 'none'`,
        ).run(fence.now, fence.now, stale.id);
        if (requeued.changes !== 1) return false;
        this.db.prepare(
          `UPDATE controller_threads
              SET project_id = NULL, host_id = NULL, pending_spawn_token = NULL, updated_at = ?
            WHERE controller_key = ? AND bb_thread_id IS NULL AND pending_spawn_token = ?`,
        ).run(fence.now, stale.controller_key, stale.id);
        persistControllerOutbox(this.db, controllerPhaseOutbox(
          stale.id,
          stale.telegram_chat_id,
          "queued",
          stale.thread_follow_up_json,
        ), fence.now);
        return true;
      }
      const adopted = this.db.prepare(
        `UPDATE controller_turns
            SET delivery_state = 'delivery_unknown', lease_owner = ?, lease_generation = ?,
                next_dispatch_at = ?,
                last_error = 'Controller delivery requires reconciliation after lease loss',
                updated_at = ?
          WHERE id = ? AND state IN ('dispatching', 'submitted')
            AND delivery_state IN ('intent', 'delivery_unknown')`,
      ).run(
        fence.ownerId,
        fence.generation,
        fence.now,
        fence.now,
        stale.id,
      );
      if (adopted.changes !== 1) return false;
      persistControllerOutbox(this.db, controllerPhaseOutbox(
        stale.id,
        stale.telegram_chat_id,
        "connecting",
        stale.thread_follow_up_json,
      ), fence.now);
      return true;
    }).immediate();
  }

  public markControllerSpawned(input: ControllerLeaseFence & {
    turnId: string;
    projectId: string;
    hostId: string;
    threadId: string;
    spawnToken?: string;
    leaseMs?: number;
  }): boolean {
    this.assertControllerMutation(input);
    assertControllerIdentifier(input.projectId, "projectId");
    assertControllerIdentifier(input.hostId, "hostId");
    assertControllerIdentifier(input.threadId, "threadId");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const turn = this.db.prepare(
        `SELECT turn.* FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1
            AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE turn.id = ?`,
      ).get(input.turnId) as ControllerTurnRow | undefined;
      if (
        !turn || turn.state !== "dispatching" ||
        turn.lease_owner !== input.ownerId || turn.lease_generation !== input.generation
      ) return false;
      const spawnToken = input.spawnToken ?? input.turnId;
      if (spawnToken !== input.turnId) return false;
      if (turn.delivery_state === "none") {
        const compatibilityIntent = this.db.prepare(
          `UPDATE controller_turns
              SET delivery_state = 'intent', dispatch_kind = 'spawn',
                  dispatch_correlation_id = ?, delivery_reconcile_attempts = 0,
                  next_dispatch_at = 0, updated_at = ?
            WHERE id = ? AND state = 'dispatching' AND delivery_state = 'none'
              AND lease_owner = ? AND lease_generation = ?`,
        ).run(input.turnId, input.now, input.turnId, input.ownerId, input.generation);
        if (compatibilityIntent.changes !== 1) return false;
        turn.delivery_state = "intent";
        turn.dispatch_kind = "spawn";
        turn.dispatch_correlation_id = input.turnId;
      }
      if (
        (turn.delivery_state !== "intent" && turn.delivery_state !== "delivery_unknown") ||
        turn.dispatch_kind !== "spawn" || turn.dispatch_correlation_id !== input.turnId
      ) return false;
      if (turn.capability_profile_revision > 0) {
        if (!turn.capability_profile_id) return false;
        const profile = this.capabilityRepository.getActiveProfile("controller_turn", turn.id);
        if (
          !profile || profile.id !== turn.capability_profile_id ||
          profile.revision !== turn.capability_profile_revision
        ) return false;
      }
      // Deployed-line callers predate the explicit reserve/mark split. When
      // they omit the token, perform the same exact project/host reservation
      // here before marking the spawn. Explicit-token callers must already
      // have reserved it through reserveControllerSpawn.
      if (input.spawnToken === undefined) {
        const reserved = this.db.prepare(
          `UPDATE controller_threads
              SET project_id = ?, host_id = ?, updated_at = ?
            WHERE controller_key = ? AND state = 'pending_spawn' AND bb_thread_id IS NULL
              AND pending_spawn_token = ?
              AND (project_id IS NULL AND host_id IS NULL
                   OR project_id = ? AND host_id = ?)` ,
        ).run(
          input.projectId,
          input.hostId,
          input.now,
          turn.controller_key,
          input.turnId,
          input.projectId,
          input.hostId,
        );
        if (reserved.changes !== 1) return false;
      }
      const spawned = this.db.prepare(
        `UPDATE controller_threads
            SET project_id = ?, host_id = ?, bb_thread_id = ?, state = 'active',
                pending_spawn_token = NULL, capability_subject_id = ?,
                capability_profile_id = ?, capability_profile_revision = ?,
                last_error = NULL, updated_at = ?
          WHERE controller_key = ? AND state = 'pending_spawn' AND bb_thread_id IS NULL
            AND pending_spawn_token = ? AND project_id = ? AND host_id = ?`,
      ).run(
        input.projectId,
        input.hostId,
        input.threadId,
        turn.id,
        turn.capability_profile_id,
        turn.capability_profile_revision,
        input.now,
        turn.controller_key,
        input.turnId,
        input.projectId,
        input.hostId,
      ).changes === 1;
      if (spawned) {
        const configured = this.db.prepare(
          `UPDATE controller_turns
              SET capability_configured_revision = capability_profile_revision,
                  capability_continuation_state = CASE
                    WHEN capability_continuation_state = 'relaunching' THEN 'resolved'
                    ELSE capability_continuation_state
                  END,
                  updated_at = ?
            WHERE id = ? AND state = 'dispatching'`,
        ).run(input.now, turn.id);
        if (configured.changes !== 1) throw new Error("Controller profile configuration could not be recorded");
        this.db.prepare(
          `INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason)
           VALUES (?, ?, ?, ?, NULL, NULL)`,
        ).run(`gen-${randomUUID()}`, turn.controller_key, input.threadId, input.now);
      }
      return spawned;
    }).immediate();
  }

  public markControllerTurnSubmitted(
    input: ControllerLeaseFence & {
      turnId: string;
      dispatchAfterSeq?: number;
      leaseMs?: number;
    },
  ): boolean {
    this.assertControllerMutation(input);
    const dispatchAfterSeq = input.dispatchAfterSeq ?? 0;
    assertNonNegativeInteger(dispatchAfterSeq, "dispatchAfterSeq");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const turn = this.db.prepare("SELECT * FROM controller_turns WHERE id = ?")
        .get(input.turnId) as ControllerTurnRow | undefined;
      if (turn?.state === "submitted") {
        if (
          turn.lease_owner !== input.ownerId || turn.lease_generation !== input.generation ||
          turn.completion_continuations !== 1 || turn.dispatch_kind !== "send" ||
          turn.dispatch_correlation_id !== `controller-continuation:${input.turnId}:1` ||
          (turn.delivery_state !== "intent" && turn.delivery_state !== "delivery_unknown") ||
          turn.dispatch_after_seq !== dispatchAfterSeq
        ) return false;
        return this.db.prepare(
          `UPDATE controller_turns
              SET delivery_state = 'none', delivery_reconcile_attempts = 0,
                  next_dispatch_at = 0, last_error = NULL, updated_at = ?
            WHERE id = ? AND state = 'submitted'
              AND lease_owner = ? AND lease_generation = ?
              AND delivery_state IN ('intent', 'delivery_unknown')
              AND completion_continuations = 1 AND dispatch_kind = 'send'
              AND dispatch_correlation_id = ? AND dispatch_after_seq = ?`,
        ).run(
          input.now,
          input.turnId,
          input.ownerId,
          input.generation,
          `controller-continuation:${input.turnId}:1`,
          dispatchAfterSeq,
        ).changes === 1;
      }
      if (
        !turn || turn.state !== "dispatching" || turn.lease_owner !== input.ownerId ||
        turn.lease_generation !== input.generation
      ) return false;
      if (turn.delivery_state === "none") {
        const compatibilityIntent = this.db.prepare(
          `UPDATE controller_turns
              SET delivery_state = 'intent', dispatch_kind = 'send',
                  dispatch_correlation_id = ?, dispatch_after_seq = ?,
                  delivery_reconcile_attempts = 0, next_dispatch_at = 0,
                  updated_at = ?
            WHERE id = ? AND state = 'dispatching' AND delivery_state = 'none'
              AND lease_owner = ? AND lease_generation = ?`,
        ).run(
          `controller-dispatch:${input.turnId}`,
          dispatchAfterSeq,
          input.now,
          input.turnId,
          input.ownerId,
          input.generation,
        );
        if (compatibilityIntent.changes !== 1) return false;
        turn.delivery_state = "intent";
        turn.dispatch_kind = "send";
        turn.dispatch_correlation_id = `controller-dispatch:${input.turnId}`;
      }
      if (
        (turn.delivery_state !== "intent" && turn.delivery_state !== "delivery_unknown") ||
        turn.dispatch_kind === null || turn.dispatch_correlation_id === null
      ) return false;
      if (turn.capability_profile_revision > 0) {
        if (!turn.capability_profile_id) return false;
        const profile = this.capabilityRepository.getActiveProfile("controller_turn", turn.id);
        if (
          !profile || profile.id !== turn.capability_profile_id ||
          profile.revision !== turn.capability_profile_revision
        ) return false;
        const configured = this.db.prepare(
          `UPDATE controller_threads
              SET capability_subject_id = ?, capability_profile_id = ?,
                  capability_profile_revision = ?, updated_at = ?
            WHERE controller_key = ? AND state = 'active' AND bb_thread_id IS NOT NULL`,
        ).run(
          turn.id,
          turn.capability_profile_id,
          turn.capability_profile_revision,
          input.now,
          turn.controller_key,
        );
        if (configured.changes !== 1) return false;
      }
      // The evidence cursor starts where this turn's own message entered the
      // thread, exactly as the continuation path sets all three together. Left
      // at 0 it rescans the whole conversation on every turn, so each turn
      // re-ingests its predecessors' items and the per-turn row count climbs
      // with conversation length until it crosses the evidence cap.
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'submitted', dispatch_after_seq = ?, bb_event_seq = ?,
                evidence_event_seq = ?,
                stream_phase = 'connecting', submitted_at = ?,
                delivery_state = 'none', delivery_reconcile_attempts = 0,
                next_dispatch_at = 0, last_error = NULL,
                capability_configured_revision = capability_profile_revision,
                updated_at = ?
          WHERE id = ? AND state = 'dispatching' AND lease_owner = ? AND lease_generation = ?
            AND delivery_state IN ('intent', 'delivery_unknown')
            AND EXISTS (
              SELECT 1 FROM controller_threads
               WHERE controller_key = controller_turns.controller_key
                 AND state = 'active' AND bb_thread_id IS NOT NULL
                 AND (
                   controller_turns.capability_profile_revision = 0 OR (
                     capability_subject_id = controller_turns.id
                     AND capability_profile_id = controller_turns.capability_profile_id
                     AND capability_profile_revision = controller_turns.capability_profile_revision
                   )
                 )
            )`,
      ).run(
        dispatchAfterSeq,
        dispatchAfterSeq,
        dispatchAfterSeq,
        input.now,
        input.now,
        input.turnId,
        input.ownerId,
        input.generation,
      );
      if (updated.changes !== 1) return false;
      const row = this.db.prepare(
        `SELECT turn.id, turn.thread_follow_up_json, controller.telegram_chat_id
           FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
          WHERE turn.id = ? AND turn.state = 'submitted'`,
      ).get(input.turnId) as {
        id: string;
        thread_follow_up_json: string | null;
        telegram_chat_id: string;
      } | undefined;
      if (!row) throw new Error("Submitted controller turn disappeared before placeholder creation");
      const outbox: OutboxInput = {
        logicalKey: controllerReplyLogicalKey(row.id, row.thread_follow_up_json),
        chatId: row.telegram_chat_id,
        payload: { text: CONTROLLER_PHASE_TEXT.connecting, disable_web_page_preview: true },
      };
      persistControllerOutbox(this.db, outbox, input.now);
      return true;
    }).immediate();
  }

  public retryUnacceptedControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    expectedThreadId: string;
    nextFallbackIndex: number;
  }): boolean {
    this.assertControllerMutation(input);
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.expectedThreadId, "expectedThreadId");
    assertPositiveInteger(input.nextFallbackIndex, "nextFallbackIndex");
    if (input.nextFallbackIndex > 2) {
      throw new TypeError("nextFallbackIndex must select fallback slot 1 or 2");
    }
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const eligible = this.db.prepare(
        `SELECT 1 FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
          WHERE turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
            AND turn.model_fallback_index = ? AND turn.accepted_finalization_id IS NULL
            AND turn.lease_owner = ? AND turn.lease_generation = ?
            AND controller.bb_thread_id = ? AND controller.state = 'active'`,
      ).get(
        input.turnId,
        input.controllerKey,
        input.nextFallbackIndex - 1,
        input.ownerId,
        input.generation,
        input.expectedThreadId,
      );
      if (!eligible) return false;
      const openGenerations = this.db.prepare(
        "SELECT thread_id FROM controller_generations WHERE controller_key = ? AND ended_at IS NULL ORDER BY id ASC",
      ).all(input.controllerKey) as Array<{ thread_id: string }>;
      if (openGenerations.length !== 1 || openGenerations[0]?.thread_id !== input.expectedThreadId) return false;
      const turn = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
                dispatch_after_seq = 0, bb_event_seq = 0,
                model_fallback_index = ?,
                stream_text = '', stream_phase = 'queued', submitted_at = NULL,
                last_error = NULL, updated_at = ?
          WHERE id = ? AND controller_key = ? AND state = 'submitted'
            AND model_fallback_index = ? AND accepted_finalization_id IS NULL
            AND lease_owner = ? AND lease_generation = ?`,
      ).run(
        input.nextFallbackIndex,
        input.now,
        input.turnId,
        input.controllerKey,
        input.nextFallbackIndex - 1,
        input.ownerId,
        input.generation,
      );
      if (turn.changes !== 1) throw new Error("Controller turn changed during unaccepted retry");
      const controller = this.db.prepare(
        `UPDATE controller_threads
            SET project_id = NULL, host_id = NULL, bb_thread_id = NULL,
                state = 'pending_spawn', pending_spawn_token = NULL,
                capability_subject_id = NULL, capability_profile_id = NULL,
                capability_profile_revision = 0,
                last_error = NULL, updated_at = ?
          WHERE controller_key = ? AND bb_thread_id = ? AND state = 'active'`,
      ).run(input.now, input.controllerKey, input.expectedThreadId);
      if (controller.changes !== 1) throw new Error("Controller generation changed during unaccepted retry");
      const generation = this.db.prepare(
        `UPDATE controller_generations SET ended_at = ?, end_reason = ?
          WHERE controller_key = ? AND thread_id = ? AND ended_at IS NULL`,
      ).run(
        input.now,
        `Input was not accepted; trying controller model fallback ${input.nextFallbackIndex}`,
        input.controllerKey,
        input.expectedThreadId,
      );
      if (generation.changes !== 1) throw new Error("Controller open generation changed during unaccepted retry");
      const chat = this.db.prepare(
        `SELECT controller.telegram_chat_id, turn.thread_follow_up_json
           FROM controller_threads AS controller
           JOIN controller_turns AS turn ON turn.controller_key = controller.controller_key
          WHERE controller.controller_key = ? AND turn.id = ?`,
      ).get(input.controllerKey, input.turnId) as {
        telegram_chat_id: string;
        thread_follow_up_json: string | null;
      } | undefined;
      if (!chat) throw new Error("Controller mapping disappeared during unaccepted retry");
      persistControllerOutbox(this.db, {
        logicalKey: controllerReplyLogicalKey(input.turnId, chat.thread_follow_up_json),
        chatId: chat.telegram_chat_id,
        payload: { text: CONTROLLER_PHASE_TEXT.connecting, disable_web_page_preview: true },
      }, input.now);
      return true;
    }).immediate();
  }

  public beginControllerRecovery(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    expectedThreadId: string;
    error: string;
    nextFallbackIndex: number;
  }): ControllerRecoveryOutcome {
    this.assertControllerMutation(input);
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.expectedThreadId, "expectedThreadId");
    assertSafeFailureSummary(input.error);
    assertNoRawMergeCallback(input.error, "controller recovery error");
    assertNonNegativeInteger(input.nextFallbackIndex, "nextFallbackIndex");
    if (input.nextFallbackIndex > 2) throw new TypeError("nextFallbackIndex must be at most 2");
    return this.db.transaction((): ControllerRecoveryOutcome => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return "stale";
      const row = this.db.prepare(
        `SELECT turn.*, controller.telegram_chat_id
           FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
          WHERE turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
            AND turn.lease_owner = ? AND turn.lease_generation = ?
            AND controller.state = 'active' AND controller.bb_thread_id = ?`,
      ).get(
        input.turnId,
        input.controllerKey,
        input.ownerId,
        input.generation,
        input.expectedThreadId,
      ) as (ControllerTurnRow & { telegram_chat_id: string }) | undefined;
      if (!row) return "stale";
      if (repairControllerGenerationInvariant(this.db, {
        controllerKey: input.controllerKey,
        expectedThreadId: input.expectedThreadId,
        telegramChatId: row.telegram_chat_id,
        now: input.now,
      })) return "requeued";
      if (row.accepted_finalization_id !== null) return "accepted_won";
      if (row.completion_continuations >= 2) return "exhausted";
      const recovered = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
                dispatch_after_seq = 0, bb_event_seq = 0, evidence_event_seq = 0,
                completion_continuations = 2, input_accepted = 0,
                model_fallback_index = ?, stream_text = '', stream_phase = 'queued',
                submitted_at = NULL, delivery_state = 'none',
                delivery_reconcile_attempts = 0, next_dispatch_at = 0,
                last_error = ?, updated_at = ?
          WHERE id = ? AND controller_key = ? AND state = 'submitted'
            AND lease_owner = ? AND lease_generation = ?
            AND accepted_finalization_id IS NULL AND completion_continuations < 2`,
      ).run(
        input.nextFallbackIndex,
        input.error,
        input.now,
        input.turnId,
        input.controllerKey,
        input.ownerId,
        input.generation,
      );
      if (recovered.changes !== 1) throw new Error("Controller turn changed during recovery");
      const retired = this.db.prepare(
        `UPDATE controller_threads
            SET project_id = NULL, host_id = NULL, bb_thread_id = NULL,
                state = 'pending_spawn', pending_spawn_token = NULL,
                capability_subject_id = NULL, capability_profile_id = NULL,
                capability_profile_revision = 0, last_error = NULL, updated_at = ?
          WHERE controller_key = ? AND bb_thread_id = ? AND state = 'active'`,
      ).run(input.now, input.controllerKey, input.expectedThreadId);
      if (retired.changes !== 1) throw new Error("Controller changed during recovery");
      const generation = this.db.prepare(
        `UPDATE controller_generations SET ended_at = ?, end_reason = 'recovery'
          WHERE controller_key = ? AND thread_id = ? AND ended_at IS NULL`,
      ).run(input.now, input.controllerKey, input.expectedThreadId);
      if (generation.changes !== 1) throw new Error("Controller generation changed during recovery");
      persistControllerOutbox(this.db, {
        logicalKey: controllerReplyLogicalKey(input.turnId, row.thread_follow_up_json),
        chatId: row.telegram_chat_id,
        payload: { text: CONTROLLER_PHASE_TEXT.connecting, disable_web_page_preview: true },
      }, input.now);
      return "requeued";
    }).immediate();
  }

  public updateControllerStream(input: ControllerLeaseFence & {
    turnId: string;
    cursor: number;
    phase: ControllerTurnRecord["streamPhase"];
    toolCalls?: number;
    commandFailures?: number;
    totalTokens?: number;
    inputAccepted?: boolean;
    assistantDraft?: Readonly<{ itemId: string | null; text: string }> | null;
  } & Record<string, unknown>): boolean {
    this.assertControllerMutation(input);
    assertNonNegativeInteger(input.cursor, "cursor");
    assertNonNegativeInteger(input.toolCalls ?? 0, "toolCalls");
    assertNonNegativeInteger(input.commandFailures ?? 0, "commandFailures");
    assertNonNegativeInteger(input.totalTokens ?? 0, "totalTokens");
    if (input.inputAccepted !== undefined && typeof input.inputAccepted !== "boolean") {
      throw new TypeError("inputAccepted must be boolean");
    }
    if (input.assistantDraft !== undefined && input.assistantDraft !== null) {
      if (input.assistantDraft.itemId !== null &&
          (input.assistantDraft.itemId.length === 0 || input.assistantDraft.itemId.length > 256)) {
        throw new TypeError("assistant draft item id is invalid");
      }
      if (typeof input.assistantDraft.text !== "string") throw new TypeError("assistant draft text is invalid");
    }
    const phases = new Set<ControllerTurnRecord["streamPhase"]>([
      "queued", "connecting", "thinking", "using_tools", "responding", "complete", "failed",
    ]);
    if (!phases.has(input.phase)) throw new TypeError("Unknown controller stream phase");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const row = this.db.prepare(
        `SELECT turn.*, controller.telegram_chat_id
           FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
          WHERE turn.id = ? AND turn.state = 'submitted' AND turn.bb_event_seq <= ?`,
      ).get(input.turnId, input.cursor) as (ControllerTurnRow & { telegram_chat_id: string }) | undefined;
      if (!row) return false;
      const phaseText = CONTROLLER_PHASE_TEXT[input.phase];
      const cursorAdvanced = input.cursor > row.bb_event_seq;
      const needsNormalization = row.stream_text !== phaseText || row.stream_phase !== input.phase;
      const assistantDraft = cursorAdvanced ? input.assistantDraft : undefined;
      const nextDraftText = assistantDraft === undefined || assistantDraft === null
        ? row.private_draft_text
        : `${row.private_draft_item_id === assistantDraft.itemId ? row.private_draft_text : ""}${assistantDraft.text}`
          .slice(-MAX_CONTROLLER_PRIVATE_DRAFT_CHARS);
      const nextDraftItemId = assistantDraft === undefined || assistantDraft === null
        ? row.private_draft_item_id
        : assistantDraft.itemId;
      const acceptedInNewWindow = cursorAdvanced && input.inputAccepted === true;
      const needsPrivateUpdate = (acceptedInNewWindow && row.input_accepted === 0) ||
        nextDraftText !== row.private_draft_text || nextDraftItemId !== row.private_draft_item_id;
      if (!cursorAdvanced && !needsNormalization && !needsPrivateUpdate) return false;
      // A same-cursor call may scrub one legacy raw stream value, but it does
      // not represent new provider activity. Metrics advance only with the BB
      // cursor; updated_at and the outbox change once for a real cursor advance
      // or the one required normalization, then identical replays are no-ops.
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET bb_event_seq = ?, stream_text = ?, stream_phase = ?, updated_at = ?,
                tool_calls = tool_calls + ?,
                command_failures = command_failures + ?,
                total_tokens = MAX(total_tokens, ?),
                input_accepted = MAX(input_accepted, ?),
                private_draft_item_id = ?, private_draft_text = ?,
                -- BB reports tokens cumulatively for the whole thread, and a
                -- controller thread outlives many turns. The first non-zero
                -- reading of a turn is therefore the thread's prior spend, not
                -- this turn's: recording it as a baseline is what keeps a
                -- week-old thread from failing "hi" against a hard budget.
                token_baseline = COALESCE(token_baseline, NULLIF(?, 0))
          WHERE id = ? AND state = 'submitted' AND
                -- Even a zero-advance pass may normalize a pre-cutover raw
                -- stream_text, but a genuinely replayed page (cursor behind the
                -- durable one) must never regress the cursor.
                bb_event_seq <= ?`,
      ).run(
        input.cursor,
        phaseText,
        input.phase,
        input.now,
        cursorAdvanced ? input.toolCalls ?? 0 : 0,
        cursorAdvanced ? input.commandFailures ?? 0 : 0,
        cursorAdvanced ? input.totalTokens ?? 0 : row.total_tokens,
        acceptedInNewWindow ? 1 : row.input_accepted,
        nextDraftItemId,
        nextDraftText,
        cursorAdvanced ? input.totalTokens ?? 0 : 0,
        input.turnId,
        input.cursor,
      );
      if (updated.changes !== 1) return false;
      // Draft text is phase-only. `input.text` may carry legacy raw provider
      // prose from a pre-cutover stream_text row, so the outbox payload and the
      // durable stream_text are both derived exclusively from the phase — raw
      // output can never surface as a draft or be persisted as draft text.
      // Terminal phases (complete/failed) never redraw a live draft: the turn
      // is finalized or retired by its terminal writer, so a placeholder is
      // not surfaced during a transient error observation or a retry.
      if (input.phase !== "complete" && input.phase !== "failed") {
        const outbox: OutboxInput = {
          logicalKey: controllerReplyLogicalKey(input.turnId, row.thread_follow_up_json),
          chatId: row.telegram_chat_id,
          messageId: row.telegram_message_id,
          payload: { ...formattedMessage(phaseText), disable_web_page_preview: true },
        };
        persistControllerOutbox(this.db, outbox, input.now);
      }
      return true;
    }).immediate();
  }

  /** Claims the durable attempt before crossing the provider boundary. */
  public claimControllerSupervisorSteer(input: ControllerSupervisorSteerClaimInput): ControllerSupervisorSteerClaim {
    this.assertControllerMutation(input);
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.expectedThreadId, "expectedThreadId");
    assertControllerText(input.inputText, "inputText");
    if (!SUPERVISOR_REASONS.has(input.reason)) throw new TypeError("Unknown controller supervisor reason");
    return this.db.transaction(() => this.claimControllerSupervisorSteerInTransaction(input)).immediate();
  }

  private claimControllerSupervisorSteerInTransaction(
    input: ControllerSupervisorSteerClaimInput,
  ): ControllerSupervisorSteerClaim {
    if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return "stale";
    const existing = this.controllerSupervisorSteerState(input.turnId, input.reason);
    if (existing) return existing === "pending" ? "pending" : "settled";
    const idempotencyKey = `controller-supervisor:${input.turnId}:${input.reason}`;
    if (this.insertControllerSupervisorSteerAttempt(input, idempotencyKey)) return "claimed";
    const raced = this.controllerSupervisorSteerState(input.turnId, input.reason);
    return raced ? (raced === "pending" ? "pending" : "settled") : "stale";
  }

  private controllerSupervisorSteerState(
    turnId: string,
    reason: SupervisorReason,
  ): ControllerSupervisorSteerState | null {
    const row = this.db.prepare(
      `SELECT state FROM controller_supervisor_steer_attempts
        WHERE turn_id = ? AND reason = ?`,
    ).get(turnId, reason) as { state: ControllerSupervisorSteerState } | undefined;
    return row?.state ?? null;
  }

  private insertControllerSupervisorSteerAttempt(
    input: ControllerSupervisorSteerClaimInput,
    idempotencyKey: string,
  ): boolean {
    const inserted = this.db.prepare(
      `INSERT INTO controller_supervisor_steer_attempts (
         turn_id, controller_key, reason, thread_id, input_text,
         idempotency_key, state, created_at, settled_at
       )
       SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, NULL
         WHERE EXISTS (
           SELECT 1 FROM controller_turns AS turn
            JOIN controller_threads AS controller
              ON controller.controller_key = turn.controller_key
            WHERE turn.id = ? AND turn.controller_key = ?
              AND turn.state = 'submitted'
              AND turn.lease_owner = ? AND turn.lease_generation = ?
              AND turn.accepted_finalization_id IS NULL
              AND turn.steer_reservation_turn_id IS NULL
              AND controller.state = 'active'
              AND controller.bb_thread_id = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM controller_supervisor_steer_attempts
            WHERE turn_id = ? AND state = 'pending'
         )`,
    ).run(
      input.turnId,
      input.controllerKey,
      input.reason,
      input.expectedThreadId,
      input.inputText,
      idempotencyKey,
      input.now,
      input.turnId,
      input.controllerKey,
      input.ownerId,
      input.generation,
      input.expectedThreadId,
      input.turnId,
    );
    return inserted.changes === 1;
  }

  public getControllerSupervisorSteerAttempt(
    turnId: string,
    reason: SupervisorReason,
  ): ControllerSupervisorSteerAttempt | null {
    assertControllerIdentifier(turnId, "turnId");
    if (!SUPERVISOR_REASONS.has(reason)) throw new TypeError("Unknown controller supervisor reason");
    const row = this.db.prepare(
      `SELECT turn_id, controller_key, reason, thread_id, input_text,
              idempotency_key, state, created_at, settled_at
         FROM controller_supervisor_steer_attempts
        WHERE turn_id = ? AND reason = ?`,
    ).get(turnId, reason) as ControllerSupervisorSteerAttemptRow | undefined;
    return row ? parseControllerSupervisorSteerAttempt(row) : null;
  }

  public getPendingControllerSupervisorSteer(turnId: string): ControllerSupervisorSteerAttempt | null {
    assertControllerIdentifier(turnId, "turnId");
    const row = this.db.prepare(
      `SELECT turn_id, controller_key, reason, thread_id, input_text,
              idempotency_key, state, created_at, settled_at
         FROM controller_supervisor_steer_attempts
        WHERE turn_id = ? AND state = 'pending'
        ORDER BY created_at ASC
        LIMIT 1`,
    ).get(turnId) as ControllerSupervisorSteerAttemptRow | undefined;
    return row ? parseControllerSupervisorSteerAttempt(row) : null;
  }

  /** Settles the attempt and folds the reason into the turn in one transaction. */
  public settleControllerSupervisorSteer(
    input: ControllerSupervisorSteerSettlementInput,
  ): "settled" | "stale" {
    this.assertControllerMutation(input);
    assertControllerKey(input.controllerKey);
    if (!SUPERVISOR_REASONS.has(input.reason)) throw new TypeError("Unknown controller supervisor reason");
    if (input.outcome !== "applied" && input.outcome !== "unknown") {
      throw new TypeError("controller supervisor steer settlement outcome is invalid");
    }
    return this.db.transaction(() => this.settleControllerSupervisorSteerInTransaction(input)).immediate();
  }

  private settleControllerSupervisorSteerInTransaction(
    input: ControllerSupervisorSteerSettlementInput,
  ): "settled" | "stale" {
    if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return "stale";
    const row = this.controllerSupervisorSteerSettlementRow(input);
    if (!row) return "stale";
    if (row.state !== "pending") return "settled";
    const settled = this.db.prepare(
      `UPDATE controller_supervisor_steer_attempts
          SET state = ?, settled_at = ?
        WHERE turn_id = ? AND controller_key = ? AND reason = ? AND state = 'pending'`,
    ).run(input.outcome, input.now, input.turnId, input.controllerKey, input.reason);
    if (settled.changes !== 1) return "stale";
    this.foldControllerSupervisorSteer(input);
    return "settled";
  }

  private controllerSupervisorSteerSettlementRow(
    input: ControllerSupervisorSteerSettlementInput,
  ): { state: ControllerSupervisorSteerState } | undefined {
    return this.db.prepare(
      `SELECT attempt.state
         FROM controller_supervisor_steer_attempts AS attempt
         JOIN controller_turns AS turn ON turn.id = attempt.turn_id
        WHERE attempt.turn_id = ? AND attempt.controller_key = ? AND attempt.reason = ?
          AND turn.state = 'submitted'
          AND turn.lease_owner = ? AND turn.lease_generation = ?
          AND turn.accepted_finalization_id IS NULL
          AND turn.steer_reservation_turn_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM controller_supervisor_steer_attempts AS pending
             WHERE pending.turn_id = turn.id AND pending.state = 'pending'
               AND pending.reason <> attempt.reason
          )`,
    ).get(
      input.turnId,
      input.controllerKey,
      input.reason,
      input.ownerId,
      input.generation,
    ) as { state: ControllerSupervisorSteerState } | undefined;
  }

  private foldControllerSupervisorSteer(input: ControllerSupervisorSteerSettlementInput): void {
    const folded = this.db.prepare(
      `UPDATE controller_turns
          SET supervisor_steers = supervisor_steers + 1,
              supervisor_reasons = CASE
                WHEN supervisor_reasons = '' THEN ?
                ELSE supervisor_reasons || ',' || ?
              END,
              updated_at = ?
        WHERE id = ? AND controller_key = ? AND state = 'submitted'
          AND lease_owner = ? AND lease_generation = ?
          AND instr(',' || supervisor_reasons || ',', ',' || ? || ',') = 0`,
    ).run(
      input.reason,
      input.reason,
      input.now,
      input.turnId,
      input.controllerKey,
      input.ownerId,
      input.generation,
      input.reason,
    );
    if (folded.changes !== 1) {
      throw new Error("Controller supervisor steer fold was not applied atomically");
    }
  }

  public recordControllerInteraction(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    bbThreadId: string;
    controllerGenerationId: string;
    interaction: ControllerInteraction;
  }): ControllerInteractionRecordOutcome {
    return this.db.transaction((): ControllerInteractionRecordOutcome => {
      const outcome = this.controllerInteractionRepository.record(input);
      if (outcome !== "recorded") return outcome;
      const pending = this.controllerInteractionRepository.getPending(input.controllerKey);
      if (pending?.interactionId === input.interaction.interactionId) {
        this.persistControllerInteractionPrompt(pending, input.now);
      }
      return outcome;
    }).immediate();
  }

  public markControllerInteractionResolved(input: ControllerLeaseFence & {
    interactionId: string;
    turnId: string;
    bbThreadId: string;
  }): boolean {
    return this.db.transaction((): boolean => {
      const controllerKey = this.controllerInteractionControllerKey(input.interactionId);
      const resolved = this.controllerInteractionRepository.markResolved(input);
      if (resolved && controllerKey) this.persistNextControllerInteractionPrompt(controllerKey, input.now);
      return resolved;
    }).immediate();
  }

  public answerControllerInteractionByToken(input: {
    token: string;
    userId: string;
    chatId: string;
    now: number;
  }): ControllerInteractionAnswer {
    return this.db.transaction((): ControllerInteractionAnswer => {
      const answer = this.controllerInteractionRepository.answerByToken(input);
      this.persistControllerInteractionFollowUp(answer, input.now);
      return answer;
    }).immediate();
  }

  public answerControllerInteractionByTokenAndRecordCallback(input: {
    token: string;
    userId: string;
    chatId: string;
    callbackId: string;
    now: number;
  }): ControllerInteractionCallbackResult {
    return this.db.transaction((): ControllerInteractionCallbackResult => {
      const answer = this.controllerInteractionRepository.answerByToken(input);
      this.persistControllerInteractionFollowUp(answer, input.now);
      const recorded = this.recordCallback(
        input.callbackId,
        null,
        "controller_interaction",
        answer.ok ? "accepted" : answer.reason,
        input.now,
      );
      if (recorded) {
        persistControllerOutbox(this.db, {
          logicalKey: `callback:${input.callbackId}`,
          chatId: input.chatId,
          payload: { text: answer.ok ? "Got it." : "That interaction is no longer open." },
        }, input.now);
      }
      return { answer, recorded };
    }).immediate();
  }

  public answerControllerInteractionWithText(input: {
    controllerKey: string;
    userId: string;
    chatId: string;
    text: string;
    now: number;
    settleUpdateId?: number;
  }): ControllerInteractionAnswer & { updateSettled: boolean } {
    assertControllerKey(input.controllerKey);
    assertCanonicalPositiveDecimal(input.userId, "userId");
    assertCanonicalPositiveDecimal(input.chatId, "chatId");
    assertControllerText(input.text, "controller interaction answer");
    assertNonNegativeInteger(input.now, "now");
    const settleUpdateId = input.settleUpdateId;
    if (settleUpdateId !== undefined) assertNonNegativeInteger(settleUpdateId, "settleUpdateId");
    const claimGeneration = settleUpdateId === undefined ? undefined : this.claimedUpdates.get(settleUpdateId);
    if (settleUpdateId !== undefined && claimGeneration === undefined) {
      throw new UpdateClaimConflictError(settleUpdateId);
    }
    const result = this.db.transaction((): ControllerInteractionAnswer & { updateSettled: boolean } => {
      const answer = this.controllerInteractionRepository.answerWithText(input);
      this.persistControllerInteractionFollowUp(answer, input.now);
      if (!answer.ok || settleUpdateId === undefined) return { ...answer, updateSettled: false };
      const updated = this.db.prepare(
        `UPDATE telegram_updates
            SET status = 'processed', outcome = 'controller_interaction_answered', last_error = NULL,
                processed_at = ?, claim_owner = NULL, claim_expires_at = NULL
          WHERE update_id = ? AND status = 'processing'
            AND claim_owner = ? AND claim_generation = ? AND claim_expires_at > ?`,
      ).run(input.now, settleUpdateId, this.claimOwner, claimGeneration, input.now);
      if (updated.changes !== 1) {
        this.claimedUpdates.delete(settleUpdateId);
        throw new UpdateClaimConflictError(settleUpdateId);
      }
      advanceTelegramCursor(this.db);
      return { ...answer, updateSettled: true };
    }).immediate();
    if (result.updateSettled && settleUpdateId !== undefined) this.claimedUpdates.delete(settleUpdateId);
    return result;
  }

  public answerControllerInteractionTextUpdate(input: {
    updateId: number;
    controllerKey: string;
    userId: string;
    chatId: string;
    text: string;
    now: number;
  }): ControllerInteractionTextUpdateResult {
    assertNonNegativeInteger(input.updateId, "updateId");
    const result = this.db.transaction((): ControllerInteractionTextUpdateResult => {
      const existing = this.db.prepare(
        `SELECT status, claim_owner, claim_generation, claim_expires_at
           FROM telegram_updates WHERE update_id = ?`,
      ).get(input.updateId) as Pick<
        TelegramUpdateRow,
        "status" | "claim_owner" | "claim_generation" | "claim_expires_at"
      > | undefined;
      if (existing?.status === "processed") return { outcome: "replay" };

      let claimGeneration = this.claimedUpdates.get(input.updateId);
      if (!existing) {
        claimGeneration = 1;
        const expiresAt = input.now + TELEGRAM_UPDATE_LEASE_MS;
        this.db.prepare(
          `INSERT INTO telegram_updates (
             update_id, status, attempts, outcome, last_error, processed_at,
             claim_owner, claim_generation, claim_expires_at
           ) VALUES (?, 'processing', 1, NULL, NULL, NULL, ?, ?, ?)`,
        ).run(input.updateId, this.claimOwner, claimGeneration, expiresAt);
        this.claimedUpdates.set(input.updateId, claimGeneration);
      } else if (
        existing.status !== "processing" || claimGeneration === undefined ||
        existing.claim_owner !== this.claimOwner || existing.claim_generation !== claimGeneration ||
        existing.claim_expires_at === null || existing.claim_expires_at <= input.now
      ) {
        throw new UpdateClaimConflictError(input.updateId);
      }

      const answer = this.controllerInteractionRepository.answerWithText(input);
      this.persistControllerInteractionFollowUp(answer, input.now);
      if (!answer.ok) return { outcome: "handled", answer };

      const completed = this.db.prepare(
        `UPDATE telegram_updates
            SET status = 'processed', outcome = 'controller_interaction_answered',
                last_error = NULL, processed_at = ?, claim_owner = NULL, claim_expires_at = NULL
          WHERE update_id = ? AND status = 'processing'
            AND claim_owner = ? AND claim_generation = ? AND claim_expires_at > ?`,
      ).run(input.now, input.updateId, this.claimOwner, claimGeneration!, input.now);
      if (completed.changes !== 1) throw new UpdateClaimConflictError(input.updateId);
      advanceTelegramCursor(this.db);
      return { outcome: "handled", answer };
    }).immediate();
    if (result.outcome === "replay" || result.answer.ok) this.claimedUpdates.delete(input.updateId);
    return result;
  }

  public getPendingControllerInteraction(controllerKey: string): ControllerInteractionRecord | null {
    return this.controllerInteractionRepository.getPending(controllerKey);
  }

  public getAnsweredControllerInteraction(controllerKey: string): ControllerInteractionDelivery | null {
    return this.controllerInteractionRepository.getAnswered(controllerKey);
  }

  public markControllerInteractionDelivered(input: ControllerLeaseFence & {
    interactionId: string;
    turnId: string;
    bbThreadId: string;
  }): boolean {
    return this.db.transaction((): boolean => {
      const controllerKey = this.controllerInteractionControllerKey(input.interactionId);
      const delivered = this.controllerInteractionRepository.markDelivered(input);
      if (delivered && controllerKey) this.persistNextControllerInteractionPrompt(controllerKey, input.now);
      return delivered;
    }).immediate();
  }

  private persistControllerInteractionFollowUp(
    answer: ControllerInteractionAnswer,
    now: number,
  ): void {
    if (!answer.ok || answer.complete) return;
    const pending = this.controllerInteractionRepository.getPending(answer.controllerKey);
    if (!pending || pending.interactionId !== answer.interactionId) return;
    this.persistControllerInteractionPrompt(pending, now);
  }

  private persistControllerInteractionPrompt(
    pending: ControllerInteractionRecord,
    now: number,
  ): void {
    const rendered = renderControllerInteraction(pending.interaction, pending.answers);
    const next = pending.interaction.kind === "user_question"
      ? nextUnansweredQuestion(pending.interaction.questions, pending.answers)
      : null;
    const index = next?.index ?? 0;
    const controller = this.db.prepare(
      "SELECT telegram_chat_id FROM controller_threads WHERE controller_key = ?",
    ).get(pending.controllerKey) as { telegram_chat_id: string } | undefined;
    if (!controller) throw new Error("controller interaction owner is unavailable");
    persistControllerOutbox(this.db, {
      logicalKey: `controller-interaction:${pending.interactionId}:${index}`,
      chatId: controller.telegram_chat_id,
      payload: {
        ...formattedMessage(rendered.text),
        ...( "reply_markup" in rendered ? { reply_markup: rendered.reply_markup } : {}),
        disable_web_page_preview: true,
      },
    }, now);
  }

  private persistNextControllerInteractionPrompt(controllerKey: string, now: number): void {
    const pending = this.controllerInteractionRepository.getPending(controllerKey);
    if (pending) this.persistControllerInteractionPrompt(pending, now);
  }

  private controllerInteractionControllerKey(interactionId: string): string | null {
    const row = this.db.prepare(
      "SELECT controller_key FROM controller_interactions WHERE interaction_id = ?",
    ).get(interactionId) as { controller_key: string } | undefined;
    return row?.controller_key ?? null;
  }

  /**
   * Reserves the queued owner turn before crossing the provider boundary. The
   * reservation is the durable fence that keeps finalization and other turn
   * mutations from winning while BB is deciding whether to accept the steer.
   */
  public reserveControllerSteer(input: ControllerLeaseFence & {
    runningTurnId: string;
    waitingTurnId: string;
    controllerKey: string;
    expectedThreadId: string;
  }): boolean {
    this.assertControllerSteerInput(input);
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.expectedThreadId, "expectedThreadId");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      return this.db.prepare(
        `UPDATE controller_turns
            SET steer_reservation_turn_id = ?, updated_at = ?
          WHERE id = ? AND controller_key = ? AND state = 'submitted'
            AND lease_owner = ? AND lease_generation = ?
            AND accepted_finalization_id IS NULL
            AND (steer_reservation_turn_id IS NULL OR steer_reservation_turn_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM controller_supervisor_steer_attempts
               WHERE turn_id = controller_turns.id AND state = 'pending'
            )
            AND EXISTS (
              SELECT 1 FROM controller_threads AS controller
               WHERE controller.controller_key = controller_turns.controller_key
                 AND controller.state = 'active'
                 AND controller.bb_thread_id = ?
            )
            AND EXISTS (
              SELECT 1 FROM controller_turns AS waiting
               WHERE waiting.id = ? AND waiting.controller_key = controller_turns.controller_key
                 AND waiting.state = 'queued' AND waiting.image_file_id IS NULL
            )`,
      ).run(
        input.waitingTurnId,
        input.now,
        input.runningTurnId,
        input.controllerKey,
        input.ownerId,
        input.generation,
        input.waitingTurnId,
        input.expectedThreadId,
        input.waitingTurnId,
      ).changes === 1;
    }).immediate();
  }

  public getControllerSteerReservation(controllerKey: string): ControllerSteerReservation | null {
    assertControllerKey(controllerKey);
    const row = this.db.prepare(
      `SELECT running.id AS running_turn_id,
              running.steer_reservation_turn_id AS waiting_turn_id,
              running.controller_key,
              controller.bb_thread_id AS thread_id,
              waiting.input_text
         FROM controller_turns AS running
         JOIN controller_threads AS controller ON controller.controller_key = running.controller_key
         LEFT JOIN controller_turns AS waiting
           ON waiting.id = running.steer_reservation_turn_id
        WHERE running.controller_key = ?
          AND running.state = 'submitted'
          AND running.steer_reservation_turn_id IS NOT NULL
        ORDER BY running.ordinal ASC
        LIMIT 1`,
    ).get(controllerKey) as {
      running_turn_id: string;
      waiting_turn_id: string;
      controller_key: string;
      thread_id: string | null;
      input_text: string | null;
    } | undefined;
    if (!row) return null;
    return {
      controllerKey: row.controller_key,
      runningTurnId: row.running_turn_id,
      waitingTurnId: row.waiting_turn_id,
      threadId: row.thread_id ?? "",
      inputText: row.input_text,
      idempotencyKey: `controller-steer:${row.running_turn_id}:${row.waiting_turn_id}`,
    };
  }

  private controllerSteerSettlementRow(input: ControllerSteerSettlementInput): ControllerSteerSettlementRow | null {
    const row = this.db.prepare(
      `SELECT running.controller_key AS controllerKey,
              waiting.state AS waitingState,
              waiting.ordinal AS waitingOrdinal,
              waiting.input_text AS inputText,
              controller.telegram_chat_id AS telegramChatId
         FROM controller_turns AS running
         JOIN controller_threads AS controller ON controller.controller_key = running.controller_key
         LEFT JOIN controller_turns AS waiting
           ON waiting.id = running.steer_reservation_turn_id
        WHERE running.id = ? AND running.controller_key = ? AND running.state = 'submitted'
          AND running.lease_owner = ? AND running.lease_generation = ?
          AND running.accepted_finalization_id IS NULL
          AND running.steer_reservation_turn_id = ?`,
    ).get(
      input.runningTurnId,
      input.controllerKey,
      input.ownerId,
      input.generation,
      input.waitingTurnId,
    ) as ControllerSteerSettlementRow | undefined;
    return row ?? null;
  }

  private clearControllerSteerReservation(input: ControllerSteerSettlementInput): boolean {
    return this.db.prepare(
      `UPDATE controller_turns
          SET steer_reservation_turn_id = NULL, updated_at = ?
        WHERE id = ? AND controller_key = ? AND state = 'submitted'
          AND lease_owner = ? AND lease_generation = ?
          AND accepted_finalization_id IS NULL
          AND steer_reservation_turn_id = ?`,
    ).run(
      input.now,
      input.runningTurnId,
      input.controllerKey,
      input.ownerId,
      input.generation,
      input.waitingTurnId,
    ).changes === 1;
  }

  private completeAppliedControllerSteer(
    input: ControllerSteerSettlementInput,
    row: ControllerSteerSettlementRow,
  ): void {
    const folded = "(sent to the answer already in progress)";
    const updated = this.db.prepare(
      `UPDATE controller_turns
          SET state = 'completed', response_text = ?, stream_phase = 'complete',
              completed_at = ?, updated_at = ?
        WHERE id = ? AND controller_key = ? AND state = 'queued'`,
    ).run(folded, input.now, input.now, input.waitingTurnId, input.controllerKey);
    if (updated.changes !== 1) return;
    if (row.waitingOrdinal === null) throw new Error("queued controller steer has no ordinal");
    this.appendControllerDigestRow({
      controllerKey: row.controllerKey,
      ordinal: row.waitingOrdinal,
      ownerText: row.inputText ?? "",
      agentText: folded,
      now: input.now,
    });
    // The answer itself arrives folded into the reply already being written, so
    // without this the owner's message drew no bubble at all and reads in
    // Telegram exactly like being ignored.
    persistControllerOutbox(this.db, {
      logicalKey: controllerReplyLogicalKey(input.waitingTurnId, null),
      chatId: row.telegramChatId,
      payload: {
        text: CONTROLLER_STEER_FOLDED_TEXT,
        disable_web_page_preview: true,
      },
    }, input.now);
  }

  private retryUnappliedControllerSteer(input: ControllerSteerSettlementInput): void {
    this.db.prepare(
      `UPDATE controller_turns
          SET retry_count = retry_count + 1, updated_at = ?
        WHERE id = ? AND controller_key = ? AND state = 'queued'`,
    ).run(input.now, input.waitingTurnId, input.controllerKey);
  }

  private preserveAmbiguousControllerSteer(input: ControllerSteerSettlementInput): void {
    const preserved = this.db.prepare(
      `UPDATE controller_turns
          SET recovery_source_turn_id = ?,
              last_error = 'Controller steer delivery was uncertain; queued message preserved',
              updated_at = ?
        WHERE id = ? AND controller_key = ? AND state = 'queued'`,
    ).run(input.runningTurnId, input.now, input.waitingTurnId, input.controllerKey);
    if (preserved.changes !== 1) throw new Error("Ambiguous controller steer message could not be preserved");
  }

  public settleControllerSteer(input: ControllerSteerSettlementInput): ControllerSteerSettlementResult {
    this.assertControllerSteerInput(input);
    assertControllerKey(input.controllerKey);
    if (input.outcome !== "applied" && input.outcome !== "not_applied" && input.outcome !== "unknown") {
      throw new TypeError("controller steer settlement outcome is invalid");
    }
    return this.db.transaction((): ControllerSteerSettlementResult => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return "stale";
      const row = this.controllerSteerSettlementRow(input);
      if (!row) return "stale";

      if (!this.clearControllerSteerReservation(input)) return "stale";
      if (row.waitingState !== "queued") return "settled";
      if (input.outcome === "applied") {
        this.completeAppliedControllerSteer(input, row);
        return "settled";
      }
      if (input.outcome === "not_applied") {
        this.retryUnappliedControllerSteer(input);
        return "settled";
      }
      this.preserveAmbiguousControllerSteer(input);
      return "settled";
    }).immediate();
  }

  /**
   * Counts a steer BB would not take and releases its reservation together
   * with the retry increment. The reconcile loop runs at draft speed while an
   * answer streams, so an unbounded retry here would be a hot loop against BB
   * rather than a recovery.
   */
  public recordControllerSteerFailure(input: ControllerLeaseFence & {
    runningTurnId: string;
    waitingTurnId: string;
  }): boolean {
    const running = this.getControllerTurn(input.runningTurnId);
    if (!running) return false;
    return this.settleControllerSteer({
      ...input,
      controllerKey: running.controllerKey,
      outcome: "not_applied",
    }) === "settled";
  }

  /**
   * The oldest owner message waiting behind an answer being written. Lifecycle
   * follow-ups need their own delivery so they cannot be folded into that answer.
   */
  public getQueuedControllerTurn(controllerKey: string): ControllerTurnRecord | null {
    assertControllerKey(controllerKey);
    const row = this.db.prepare(
      `SELECT * FROM controller_turns
        WHERE controller_key = ? AND state = 'queued' AND thread_follow_up_json IS NULL
        ORDER BY created_at ASC, ordinal ASC LIMIT 1`,
    ).get(controllerKey) as ControllerTurnRow | undefined;
    return row ? parseControllerTurn(row) : null;
  }

  /**
   * Retires a queued message that was handed to the turn already running. It
   * gets no reply of its own because the answer in flight now covers it —
   * a correction like "I meant in review" wants the first answer fixed, not a
   * second answer written.
   */
  public foldControllerTurnIntoRunning(input: ControllerLeaseFence & {
    runningTurnId: string;
    waitingTurnId: string;
  }): boolean {
    const running = this.getControllerTurn(input.runningTurnId);
    if (!running) return false;
    return this.settleControllerSteer({
      ...input,
      controllerKey: running.controllerKey,
      outcome: "applied",
    }) === "settled";
  }

  /**
   * Records where a watched thread stands and returns the notice the owner is
   * owed, if any. A thread first seen already finished is recorded silently:
   * the owner wants to hear about threads that finish while they are watching,
   * not a backlog of every thread that ever ran.
   */
  public observeThread(input: {
    threadId: string;
    title: string;
    status: string;
    userId: string;
    chatId: string;
    now: number;
  }): "finished" | "failed" | null {
    assertControllerIdentifier(input.threadId, "threadId");
    assertControllerText(input.title, "thread title");
    assertCanonicalPositiveDecimal(input.userId, "userId");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): "finished" | "failed" | null => {
      const known = this.db.prepare("SELECT * FROM observed_threads WHERE thread_id = ?")
        .get(input.threadId) as ObservedThreadRow | undefined;
      if (!known) {
        this.db.prepare(
          `INSERT INTO observed_threads
             (thread_id, title, last_status, notified_status, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(input.threadId, input.title, input.status, input.status, input.now, input.now);
        return null;
      }
      this.db.prepare(
        "UPDATE observed_threads SET title = ?, last_status = ?, updated_at = ? WHERE thread_id = ?",
      ).run(input.title, input.status, input.now, input.threadId);
      if (input.status === known.last_status) return null;
      const notice = input.status === "idle" ? "finished" : input.status === "error" ? "failed" : null;
      if (notice === null) return null;
      // Only a thread that was working can stop working. A thread that finished
      // and is marked failed afterwards has already had its say, and repeating
      // it as a failure would contradict what the owner just read.
      if (!WORKING_THREAD_STATUSES.has(known.last_status)) return null;
      // A thread being steered turn by turn would otherwise narrate every reply.
      if (known.notified_at !== null && input.now - known.notified_at < NOTICE_COOLDOWN_MS) return null;
      this.db.prepare("UPDATE observed_threads SET notified_status = ?, notified_at = ? WHERE thread_id = ?")
        .run(input.status, input.now, input.threadId);
      const monitorOwnsFollowUp = this.db.prepare(
        `SELECT 1 FROM monitors
          WHERE kind = 'thread_idle' AND thread_id = ?
            AND (state = 'armed' OR last_fired_at >= ?)
          LIMIT 1`,
      ).get(input.threadId, input.now - NOTICE_COOLDOWN_MS);
      if (monitorOwnsFollowUp) return notice;
      const engagement = this.db.prepare(
        `SELECT evidence.controller_key
           FROM controller_evidence AS evidence
           JOIN controller_threads AS controller
             ON controller.controller_key = evidence.controller_key
          WHERE controller.telegram_user_id = ? AND controller.telegram_chat_id = ?
            AND controller.state <> 'revoked'
            AND EXISTS (
              SELECT 1 FROM json_each(evidence.subject_refs_json) AS subject
               WHERE subject.value = ?
            )
          ORDER BY evidence.observed_at DESC, evidence.id DESC
          LIMIT 1`,
      ).get(
        input.userId,
        input.chatId,
        `thread:${input.threadId}`,
      ) as { controller_key: string } | undefined;
      if (engagement) {
        const latestUpdate = this.db.prepare(
          "SELECT COALESCE(MAX(telegram_update_id), 0) AS update_id FROM controller_turns",
        ).get() as { update_id: number };
        const updateId = Math.max(
          latestUpdate.update_id + 1,
          THREAD_FOLLOW_UP_UPDATE_ID_BASE,
        );
        try {
          this.enqueueControllerTurn({
            controllerKey: engagement.controller_key,
            telegramUserId: input.userId,
            telegramChatId: input.chatId,
            updateId,
            inputText: `A BB thread you engaged with has landed: ${input.threadId}. ` +
              `It ${notice === "finished" ? "finished" : "failed"}. Read how it ended, report the outcome, ` +
              "and carry out or offer the next step you promised. If that step is guarded, wait for the " +
              "owner's explicit approval; this system turn grants no merge authority.",
            origin: "system",
            threadFollowUp: {
              threadId: input.threadId,
              title: input.title,
              status: notice === "finished" ? "idle" : "error",
            },
            now: input.now,
          });
          return notice;
        } catch {
          // The lifecycle notice is the recovery path: follow-up must never
          // make the owner lose the plain outcome they received before it.
        }
      }
      persistControllerOutbox(this.db, {
        logicalKey: `thread:${input.threadId}:${input.status}`,
        chatId: input.chatId,
        payload: renderThreadLifecycleNotice(input.title, notice),
      }, input.now);
      return notice;
    }).immediate();
  }

  /** Asks the owner to unblock a thread that is waiting on a decision. */
  /**
   * True when the controller started this thread, which is what makes the
   * thread's questions the controller's to answer.
   *
   * Provenance is BB's own parent link rather than anything this plugin keeps:
   * the controller spawns with `--parent-self`, so the parent is the
   * controller's own BB thread. A thread the owner opened has no such parent
   * and stays theirs, which matters because routing their own work away would
   * silently take it off their phone.
   */
  public isControllerOwnedThread(parentThreadId: string | null): boolean {
    if (parentThreadId === null) return false;
    return this.db.prepare(
      "SELECT 1 FROM controller_threads WHERE bb_thread_id = ? AND state = 'active'",
    ).get(parentThreadId) !== undefined;
  }

  public recordThreadInteraction(input: {
    interactionId: string;
    threadId: string;
    title: string;
    interaction: ThreadInteraction;
    chatId: string;
    now: number;
    parentThreadId?: string | null;
  }): boolean {
    assertControllerIdentifier(input.interactionId, "interactionId");
    assertControllerIdentifier(input.threadId, "threadId");
    assertControllerText(input.title, "thread title");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): boolean => {
      const known = this.db.prepare("SELECT 1 FROM thread_interactions WHERE interaction_id = ?")
        .get(input.interactionId);
      if (known) return false;
      // The routing decision is taken here rather than by the caller, so a
      // future caller cannot put a tappable menu on the owner's phone for a
      // thread the controller started by forgetting to ask.
      const route = routeThreadInteraction({
        threadOwnedByController: this.isControllerOwnedThread(input.parentThreadId ?? null),
        interaction: input.interaction,
      });
      this.db.prepare(
        `INSERT INTO thread_interactions
           (interaction_id, thread_id, title, kind, payload_json, state, answer_json, asked_at, answered_at, audience)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)`,
      ).run(
        input.interactionId,
        input.threadId,
        input.title,
        input.interaction.kind,
        JSON.stringify(input.interaction),
        input.now,
        route.audience,
      );
      if (route.audience === "controller") {
        this.askControllerToAnswerThread({ ...input, now: input.now }, route.decisions);
        return true;
      }
      const rendered = renderThreadInteraction(input.title, input.interaction);
      persistControllerOutbox(this.db, {
        logicalKey: `thread-interaction:${input.interactionId}`,
        chatId: input.chatId,
        payload: {
          ...formattedMessage(rendered.text),
          ...("reply_markup" in rendered ? { reply_markup: rendered.reply_markup } : {}),
          disable_web_page_preview: true,
        },
      }, input.now);
      return true;
    }).immediate();
  }

  /**
   * Puts a spawned thread's block in front of the controller as its own turn.
   *
   * The owner sees nothing here. They asked to hear that a decision was made,
   * not to be asked to make it, and the controller reports the decision in its
   * own words when it next speaks.
   */
  private askControllerToAnswerThread(
    input: {
      interactionId: string;
      threadId: string;
      title: string;
      interaction: ThreadInteraction;
      now: number;
    },
    decisions: readonly ThreadApprovalDecision[],
  ): void {
    const controller = this.db.prepare(
      "SELECT controller_key, telegram_user_id, telegram_chat_id FROM controller_threads WHERE state = 'active' LIMIT 1",
    ).get() as { controller_key: string; telegram_user_id: string; telegram_chat_id: string } | undefined;
    if (!controller) return;
    const latestUpdate = this.db.prepare(
      "SELECT COALESCE(MAX(telegram_update_id), 0) AS update_id FROM controller_turns",
    ).get() as { update_id: number };
    try {
      this.enqueueControllerTurn({
        controllerKey: controller.controller_key,
        telegramUserId: controller.telegram_user_id,
        telegramChatId: controller.telegram_chat_id,
        updateId: Math.max(latestUpdate.update_id + 1, THREAD_FOLLOW_UP_UPDATE_ID_BASE),
        inputText: describeThreadBlockForController(input.threadId, input.title, input.interaction, decisions),
        origin: "system",
        now: input.now,
      });
    } catch {
      // A turn that cannot be queued leaves the interaction pending, so the
      // next sweep offers it again rather than the thread being forgotten.
    }
  }

  /** Resolves a watched thread's block from a tapped button. */
  public answerThreadInteraction(input: {
    token: string;
    userId: string;
    chatId: string;
    now: number;
  }): ThreadInteractionAnswer {
    assertCanonicalPositiveDecimal(input.userId, "userId");
    assertCanonicalPositiveDecimal(input.chatId, "chatId");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): ThreadInteractionAnswer => {
      const owner = this.db.prepare(
        `SELECT 1 FROM owners WHERE singleton = 1 AND revoked_at IS NULL
          AND telegram_user_id = ? AND telegram_chat_id = ?`,
      ).get(input.userId, input.chatId);
      if (!owner) return { ok: false, reason: "stale" };
      const rows = this.db.prepare(
        "SELECT * FROM thread_interactions WHERE state = 'pending' ORDER BY asked_at DESC LIMIT 20",
      ).all() as ThreadInteractionRow[];
      for (const row of rows) {
        const interaction = JSON.parse(row.payload_json) as ThreadInteraction;
        const matched = matchThreadInteractionToken(interaction, input.token);
        if (!matched) continue;
        const updated = this.db.prepare(
          `UPDATE thread_interactions SET state = 'answered', answer_json = ?, answered_at = ?
            WHERE interaction_id = ? AND state = 'pending'`,
        ).run(JSON.stringify(matched.resolution), input.now, row.interaction_id);
        if (updated.changes !== 1) return { ok: false, reason: "stale" };
        return {
          ok: true,
          interactionId: row.interaction_id,
          threadId: row.thread_id,
          title: row.title,
          label: matched.label,
        };
      }
      return { ok: false, reason: "stale" };
    }).immediate();
  }

  /**
   * Records the controller's answer to a block on a thread it started.
   *
   * The answer joins the same queue the owner's tap uses, so it reaches BB
   * through one delivery path with one set of retries. Only an interaction
   * routing already assigned to the controller can be answered here: the owner's
   * own threads, and the decisions reserved for them, are refused rather than
   * quietly taken over. A session-wide grant is refused for the same reason it
   * is never offered, so an answer cannot widen what the thread may do later.
   */
  public answerThreadInteractionAsController(input: {
    interactionId: string;
    threadId: string;
    decision?: ThreadApprovalDecision;
    answers?: ControllerQuestionAnswers;
    now: number;
  }): { ok: true } | { ok: false; reason: "unknown" | "not_controller_routed" | "decision_not_allowed" } {
    assertControllerIdentifier(input.interactionId, "interactionId");
    assertControllerIdentifier(input.threadId, "threadId");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT * FROM thread_interactions WHERE interaction_id = ? AND thread_id = ? AND state = 'pending'",
      ).get(input.interactionId, input.threadId) as (ThreadInteractionRow & { audience?: string }) | undefined;
      if (!row) return { ok: false as const, reason: "unknown" as const };
      if (row.audience !== "controller") {
        return { ok: false as const, reason: "not_controller_routed" as const };
      }
      // The stored payload is the interaction this plugin already validated
      // when it recorded it, not the provider's raw shape, so it is read back
      // the same way the owner's tap reads it rather than parsed again.
      const interaction = JSON.parse(row.payload_json) as ThreadInteraction;
      if (interaction.kind === "unsupported") {
        return { ok: false as const, reason: "unknown" as const };
      }
      let resolution: Record<string, unknown>;
      if (interaction.kind === "approval") {
        const decision = input.decision;
        if (decision === undefined || decision === "allow_for_session" || !interaction.decisions.includes(decision)) {
          return { ok: false as const, reason: "decision_not_allowed" as const };
        }
        resolution = decision === "deny" ? { decision } : { decision, grantedPermissions: null };
      } else {
        const answers = input.answers;
        if (!answers || nextUnansweredQuestion(interaction.questions, answers) !== null) {
          return { ok: false as const, reason: "decision_not_allowed" as const };
        }
        resolution = { kind: "user_answer", answers };
      }
      const updated = this.db.prepare(
        `UPDATE thread_interactions SET state = 'answered', answer_json = ?, answered_at = ?
          WHERE interaction_id = ? AND state = 'pending'`,
      ).run(JSON.stringify(resolution), input.now, input.interactionId);
      if (updated.changes !== 1) return { ok: false as const, reason: "unknown" as const };
      return { ok: true as const };
    }).immediate();
  }

  public getAnsweredThreadInteraction(): ThreadInteractionDelivery | null {
    const row = this.db.prepare(
      "SELECT * FROM thread_interactions WHERE state = 'answered' ORDER BY answered_at ASC LIMIT 1",
    ).get() as ThreadInteractionRow | undefined;
    if (!row || row.answer_json === null) return null;
    return {
      interactionId: row.interaction_id,
      threadId: row.thread_id,
      title: row.title,
      resolution: JSON.parse(row.answer_json) as Record<string, unknown>,
    };
  }

  public markThreadInteractionDelivered(interactionId: string, now: number): boolean {
    assertControllerIdentifier(interactionId, "interactionId");
    assertNonNegativeInteger(now, "now");
    return this.db.prepare(
      "UPDATE thread_interactions SET state = 'delivered' WHERE interaction_id = ? AND state = 'answered'",
    ).run(interactionId).changes === 1;
  }

  /**
   * Forgets a block the thread resolved without the owner, so it stops being
   * offered. A card already on the owner's phone is retired in place: the owner
   * answered in BB, and a live question there is a question they will answer
   * twice or tap in vain.
   */
  public discardThreadInteractions(threadId: string, keep: readonly string[], now?: number): number {
    assertControllerIdentifier(threadId, "threadId");
    const effectiveNow = now ?? this.currentNow();
    assertNonNegativeInteger(effectiveNow, "now");
    const placeholders = keep.map(() => "?").join(", ");
    const filter = keep.length === 0
      ? "thread_id = ? AND state = 'pending'"
      : `thread_id = ? AND state = 'pending' AND interaction_id NOT IN (${placeholders})`;
    return this.db.transaction((): number => {
      const stale = this.db.prepare(
        `SELECT interaction_id, title FROM thread_interactions WHERE ${filter}`,
      ).all(threadId, ...keep) as { interaction_id: string; title: string }[];
      for (const row of stale) this.retireThreadInteractionCard(row.interaction_id, row.title, effectiveNow);
      return this.db.prepare(`DELETE FROM thread_interactions WHERE ${filter}`).run(threadId, ...keep).changes;
    }).immediate();
  }

  // Only a card that actually reached Telegram can be edited; one still waiting
  // to go out is rewritten by its own delete, and there is nothing to retire.
  private retireThreadInteractionCard(interactionId: string, title: string, now: number): void {
    const logicalKey = `thread-interaction:${interactionId}`;
    const sent = this.db.prepare(
      "SELECT chat_id FROM outbox WHERE logical_key = ? AND status = 'sent' AND message_id IS NOT NULL",
    ).get(logicalKey) as { chat_id: string } | undefined;
    if (!sent) return;
    persistControllerOutbox(this.db, {
      logicalKey,
      chatId: sent.chat_id,
      payload: renderThreadInteractionRetired(title),
    }, now);
  }

  /**
   * True while the exact submitted turn is still waiting on a person. Delivery
   * only acknowledges BB, so a delivered interaction no longer parks the turn
   * and its finalization becomes consumable on a later pass.
   */
  public hasActiveControllerInteraction(turnId: string, controllerKey: string): boolean {
    assertControllerIdentifier(turnId, "turnId");
    assertControllerKey(controllerKey);
    // Deliberately the raw row, not the projected one: a row that exists but
    // cannot be parsed or selected must still hold the turn. Releasing it would
    // let completion fire behind an owner boundary nobody has settled.
    return this.db.prepare(
      `SELECT 1 FROM controller_interactions
        WHERE turn_id = ? AND controller_key = ? AND state IN ('pending', 'answered') LIMIT 1`,
    ).get(turnId, controllerKey) !== undefined;
  }

  /** The read-only source fence a lifecycle reference passes before BB is called. */
  public controllerInteractionSourceCanRecord(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    bbThreadId: string;
    controllerGenerationId: string;
  }): boolean {
    return this.controllerInteractionRepository.sourceCanRecord(input);
  }

  /** The controller's sole open generation on a thread, or null if ambiguous. */
  public getOpenControllerGeneration(controllerKey: string, threadId: string): ControllerGeneration | null {
    assertControllerKey(controllerKey);
    assertControllerIdentifier(threadId, "threadId");
    const rows = this.db.prepare(
      `SELECT id, controller_key, thread_id, started_at, ended_at, end_reason
         FROM controller_generations
        WHERE controller_key = ? AND thread_id = ? AND ended_at IS NULL`,
    ).all(controllerKey, threadId) as {
      id: string;
      controller_key: string;
      thread_id: string;
      started_at: number;
      ended_at: number | null;
      end_reason: string | null;
    }[];
    const row = rows.length === 1 ? rows[0]! : null;
    return row === null ? null : {
      id: row.id,
      controllerKey: row.controller_key,
      threadId: row.thread_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      endReason: row.end_reason,
    };
  }

  public canMutateControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    expectedThreadId?: string | null;
  }): boolean {
    this.assertControllerMutation(input);
    assertControllerKey(input.controllerKey);
    if (input.expectedThreadId !== undefined && input.expectedThreadId !== null) {
      assertControllerIdentifier(input.expectedThreadId, "expectedThreadId");
    }
    if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
    const row = this.db.prepare(
      `SELECT 1 FROM controller_turns AS turn
         JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
        WHERE turn.id = ? AND turn.controller_key = ?
          AND ((turn.state = 'submitted' AND controller.state = 'active') OR
               (turn.state = 'dispatching' AND controller.state IN ('active', 'pending_spawn')))
          AND turn.lease_owner = ? AND turn.lease_generation = ?
          AND turn.accepted_finalization_id IS NULL
          AND turn.steer_reservation_turn_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM controller_supervisor_steer_attempts
             WHERE turn_id = turn.id AND state = 'pending'
          )
          AND ((? IS NULL AND controller.bb_thread_id IS NULL) OR controller.bb_thread_id = ?)` ,
    ).get(
      input.turnId,
      input.controllerKey,
      input.ownerId,
      input.generation,
      input.expectedThreadId ?? null,
      input.expectedThreadId ?? null,
    );
    return row !== undefined;
  }


  public refreshControllerDraft(input: ControllerLeaseFence & {
    turnId: string;
    sentBefore: number;
  }): boolean {
    this.assertControllerMutation(input);
    assertNonNegativeInteger(input.sentBefore, "sentBefore");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const turn = this.db.prepare(
        "SELECT thread_follow_up_json FROM controller_turns WHERE id = ?",
      ).get(input.turnId) as { thread_follow_up_json: string | null } | undefined;
      if (!turn) return false;
      return this.db.prepare(
        `UPDATE outbox
            SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ?
          WHERE logical_key = ? AND status = 'sent' AND message_id IS NULL
            AND updated_at <= ?
            AND EXISTS (
              SELECT 1 FROM controller_turns
               WHERE id = ? AND state = 'submitted' AND telegram_message_id IS NULL
                 AND stream_phase NOT IN ('complete', 'failed')
            )`,
      ).run(
        input.now,
        input.now,
        controllerReplyLogicalKey(input.turnId, turn.thread_follow_up_json),
        input.sentBefore,
        input.turnId,
      ).changes === 1;
    }).immediate();
  }

  /**
   * Retires the live thread. The thread id is kept as a closed generation
   * rather than erased, so a failure that cost the owner a conversation stays
   * answerable afterwards.
   */
  public resetControllerThread(input: ControllerLeaseFence & {
    controllerKey: string;
    expectedThreadId: string;
    reason?: string;
  }): boolean {
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.expectedThreadId, "expectedThreadId");
    if (!input.ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const retired = this.db.prepare(
        `UPDATE controller_threads
            SET project_id = NULL, host_id = NULL, bb_thread_id = NULL,
                state = 'pending_spawn', pending_spawn_token = (
                  SELECT id FROM controller_turns
                   WHERE controller_key = ? AND state = 'dispatching'
                     AND lease_owner = ? AND lease_generation = ?
                   ORDER BY ordinal ASC LIMIT 1
                ),
                capability_subject_id = NULL, capability_profile_id = NULL,
                capability_profile_revision = 0,
                last_error = NULL, updated_at = ?
          WHERE controller_key = ? AND bb_thread_id = ?`,
      ).run(
        input.controllerKey,
        input.ownerId,
        input.generation,
        input.now,
        input.controllerKey,
        input.expectedThreadId,
      ).changes === 1;
      if (retired) {
        this.db.prepare(
          `UPDATE controller_generations SET ended_at = ?, end_reason = ?
            WHERE controller_key = ? AND thread_id = ? AND ended_at IS NULL`,
        ).run(input.now, (input.reason ?? "retired").slice(0, 200), input.controllerKey, input.expectedThreadId);
      }
      return retired;
    }).immediate();
  }

  public failControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    error: string;
    failureCode?: ControllerFailureCode;
    leaseMs?: number;
  }): boolean {
    this.assertControllerMutation(input);
    assertSafeFailureSummary(input.error);
    assertNoRawMergeCallback(input.error, "controller error");
    if (input.failureCode !== undefined && !Object.hasOwn(CONTROLLER_FAILURE_TEXT, input.failureCode)) {
      throw new TypeError("controller failure code is invalid");
    }
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const row = this.db.prepare(
        `SELECT turn.*, controller.telegram_chat_id FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE turn.id = ? AND turn.state IN ('dispatching', 'submitted')`,
      ).get(input.turnId) as (ControllerTurnRow & { telegram_chat_id: string }) | undefined;
      if (!row) return false;
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'failed', last_error = ?, completed_at = ?,
                delivery_state = CASE
                  WHEN delivery_state = 'intent' THEN 'delivery_unknown'
                  ELSE delivery_state
                END,
                lease_owner = NULL, lease_generation = NULL, next_dispatch_at = 0,
                capability_continuation_state = CASE
                  WHEN capability_continuation_state IN ('requested', 'relaunching') THEN 'blocked'
                  ELSE capability_continuation_state
                END,
                updated_at = ?
          WHERE id = ? AND state IN ('dispatching', 'submitted')`,
      ).run(input.error, input.now, input.now, input.turnId);
      if (updated.changes !== 1) return false;
      this.db.prepare(
        `UPDATE controller_threads SET project_id = NULL, host_id = NULL, pending_spawn_token = NULL, updated_at = ?
          WHERE controller_key = ? AND bb_thread_id IS NULL AND pending_spawn_token = ?`,
      ).run(input.now, row.controller_key, input.turnId);
      const outbox = controllerFailureOutbox(
        input.turnId,
        row.telegram_chat_id,
        input.failureCode ?? "unknown",
        row.thread_follow_up_json,
      );
      persistControllerOutbox(this.db, outbox, input.now);
      return true;
    }).immediate();
  }

  // The single atomic fail-and-retire writer for a submitted controller turn.
  // A nonrecoverable terminal outcome (evidence cap, native identity conflict,
  // retry exhaustion, ...) fails the turn and retires the live generation in
  // one immediate transaction, so a crash can never leave a submitted turn
  // without a usable thread or an unsafe generation reusable. The safe failure
  // notice never carries the accepted finalization words. Corrupt generation
  // identity takes the recovery path instead, because no thread can be chosen
  // safely and the owner's durable input must remain retryable.
  public failAndRetireControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    expectedThreadId: string;
    error: string;
    failureCode?: ControllerFailureCode;
    expectedAcceptedFinalizationId?: number | null;
  }): ControllerFailAndRetireOutcome {
    this.assertControllerMutation(input);
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.expectedThreadId, "expectedThreadId");
    assertSafeFailureSummary(input.error);
    assertNoRawMergeCallback(input.error, "controller error");
    if (input.failureCode !== undefined && !Object.hasOwn(CONTROLLER_FAILURE_TEXT, input.failureCode)) {
      throw new TypeError("controller failure code is invalid");
    }
    const expectedAcceptedFinalizationId = input.expectedAcceptedFinalizationId ?? null;
    if (expectedAcceptedFinalizationId !== null) {
      assertPositiveInteger(expectedAcceptedFinalizationId, "expectedAcceptedFinalizationId");
    }
    return this.db.transaction((): ControllerFailAndRetireOutcome => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return "stale";
      const row = this.db.prepare(
        `SELECT turn.*, controller.telegram_chat_id
           FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
            AND turn.lease_owner = ? AND turn.lease_generation = ?
            AND controller.state = 'active' AND controller.bb_thread_id = ?`,
      ).get(
        input.turnId,
        input.controllerKey,
        input.ownerId,
        input.generation,
        input.expectedThreadId,
      ) as (ControllerTurnRow & { telegram_chat_id: string }) | undefined;
      if (!row) return "stale";
      if (repairControllerGenerationInvariant(this.db, {
        controllerKey: input.controllerKey,
        expectedThreadId: input.expectedThreadId,
        telegramChatId: row.telegram_chat_id,
        now: input.now,
      })) return "retired";
      if (row.accepted_finalization_id !== expectedAcceptedFinalizationId) {
        if (expectedAcceptedFinalizationId === null && row.accepted_finalization_id !== null) {
          return "accepted_won";
        }
        return "stale";
      }
      const failed = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'failed', last_error = ?, stream_text = '', stream_phase = 'failed',
                lease_owner = NULL, lease_generation = NULL,
                delivery_state = 'none', delivery_reconcile_attempts = 0,
                next_dispatch_at = 0, completed_at = ?,
                capability_continuation_state = CASE
                  WHEN capability_continuation_state IN ('requested', 'relaunching') THEN 'blocked'
                  ELSE capability_continuation_state
                END,
                updated_at = ?
          WHERE id = ? AND controller_key = ? AND state = 'submitted'
            AND lease_owner = ? AND lease_generation = ?
            AND accepted_finalization_id IS ?`,
      ).run(
        input.error,
        input.now,
        input.now,
        input.turnId,
        input.controllerKey,
        input.ownerId,
        input.generation,
        expectedAcceptedFinalizationId,
      );
      if (failed.changes !== 1) throw new Error("Controller turn changed during fail-and-retire");
      const retired = this.db.prepare(
        `UPDATE controller_threads
            SET project_id = NULL, host_id = NULL, bb_thread_id = NULL,
                state = 'pending_spawn', pending_spawn_token = NULL,
                capability_subject_id = NULL, capability_profile_id = NULL,
                capability_profile_revision = 0,
                last_error = NULL, updated_at = ?
          WHERE controller_key = ? AND bb_thread_id = ? AND state = 'active'`,
      ).run(input.now, input.controllerKey, input.expectedThreadId);
      if (retired.changes !== 1) throw new Error("Controller changed during fail-and-retire");
      const generationRetired = this.db.prepare(
        `UPDATE controller_generations SET ended_at = ?, end_reason = ?
          WHERE controller_key = ? AND thread_id = ? AND ended_at IS NULL`,
      ).run(input.now, "retired", input.controllerKey, input.expectedThreadId);
      if (generationRetired.changes !== 1) throw new Error("Controller generation changed during fail-and-retire");
      const requeued = this.requeueUntouchedOwnerMessage(row, input.failureCode ?? "unknown", input.now);
      // The owner-facing notice is a fixed internally mapped safe message,
      // never caller prose: an arbitrary text could equal or leak the accepted
      // rendered message or a credential. The internal `error` stays out of the
      // Telegram payload.
      const outbox = controllerFailureOutbox(
        input.turnId,
        row.telegram_chat_id,
        requeued ? "owner_message_requeued" : input.failureCode ?? "unknown",
        row.thread_follow_up_json,
      );
      persistControllerOutbox(this.db, outbox, input.now);
      return "retired";
    }).immediate();
  }

  /**
   * Put an owner message back only when the failed turn provably cost nothing.
   *
   * A turn that opened no tool, recorded no evidence, reserved no receipt and
   * had no accepted answer cannot have done anything worth not repeating, so
   * replaying it is safe. `input_accepted` is deliberately not part of that
   * test: turns have run dozens of tool calls with it still 0, so trusting it
   * would replay real work. An image is left out because the retry would carry
   * only the text, which is not the message the owner sent.
   *
   * Only an unclassified or recovery-exhausted failure is replayed. An expired
   * sign-in or a rejected provider would fail again the same way until the
   * owner fixes it, and the delivery codes describe a message whose fate is
   * already uncertain. The replacement records where it came from, so a second
   * failure asks the owner instead of looping.
   */
  private requeueUntouchedOwnerMessage(
    row: ControllerTurnRow & { telegram_chat_id: string },
    failureCode: ControllerFailureCode,
    now: number,
  ): boolean {
    if (failureCode !== "unknown" && failureCode !== "recovery_exhausted") return false;
    if (row.origin !== "owner" || row.image_file_id !== null) return false;
    if (row.recovery_source_turn_id !== null) return false;
    if (row.tool_calls !== 0 || row.accepted_finalization_id !== null) return false;
    const touched = this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM controller_evidence WHERE turn_id = ?) AS evidence,
         (SELECT COUNT(*) FROM tool_receipts WHERE turn_id = ?) AS receipts`,
    ).get(row.id, row.id) as { evidence: number; receipts: number };
    if (touched.evidence !== 0 || touched.receipts !== 0) return false;
    const latestUpdate = this.db.prepare(
      "SELECT COALESCE(MAX(telegram_update_id), 0) AS update_id FROM controller_turns",
    ).get() as { update_id: number };
    try {
      const replacement = this.enqueueControllerTurn({
        controllerKey: row.controller_key,
        telegramUserId: this.requiredOwnerForController(row.controller_key).userId,
        telegramChatId: row.telegram_chat_id,
        updateId: Math.max(latestUpdate.update_id + 1, THREAD_FOLLOW_UP_UPDATE_ID_BASE),
        inputText: row.input_text,
        origin: "owner",
        now,
      });
      this.db.prepare(
        "UPDATE controller_turns SET recovery_source_turn_id = ? WHERE id = ? AND state = 'queued'",
      ).run(row.id, replacement.id);
      return true;
    } catch {
      return false;
    }
  }

  private requiredOwnerForController(controllerKey: string): { userId: string; chatId: string } {
    const owner = this.db.prepare(
      "SELECT telegram_user_id, telegram_chat_id FROM controller_threads WHERE controller_key = ?",
    ).get(controllerKey) as { telegram_user_id: string; telegram_chat_id: string };
    return { userId: owner.telegram_user_id, chatId: owner.telegram_chat_id };
  }

  public listControllerTurns(controllerKey: string, limit: number): ControllerTurnRecord[] {
    assertControllerKey(controllerKey);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("limit must be between 1 and 1000");
    }
    const rows = this.db.prepare(
      "SELECT * FROM controller_turns WHERE controller_key = ? ORDER BY ordinal ASC LIMIT ?",
    ).all(controllerKey, limit) as ControllerTurnRow[];
    return rows.map(parseControllerTurn);
  }

  // The in-flight turn is looked up directly: scanning a bounded prefix of the
  // conversation loses it once the history outgrows that bound.
  public getPendingControllerTurn(controllerKey: string): ControllerTurnRecord | null {
    assertControllerKey(controllerKey);
    const row = this.db.prepare(
      `SELECT * FROM controller_turns
        WHERE controller_key = ? AND state IN ('dispatching', 'submitted')
        ORDER BY ordinal ASC LIMIT 1`,
    ).get(controllerKey) as ControllerTurnRow | undefined;
    return row ? parseControllerTurn(row) : null;
  }

  // Reserving before the call is what makes replay safe: a crash mid-tool leaves
  // a 'started' receipt, which is reported as uncertain rather than repeated.
  public claimToolReceipt(input: ToolReceiptClaimInput): ToolReceiptClaim {
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.turnId, "turnId");
    assertControllerIdentifier(input.toolName, "toolName");
    assertSha256Hex(input.argsSha256);
    assertNonNegativeInteger(input.now, "now");
    const hasFence = input.ownerId !== undefined || input.generation !== undefined;
    if (hasFence) {
      if (input.ownerId === undefined || input.generation === undefined) {
        throw new TypeError("tool receipt reservation fence is incomplete");
      }
      assertControllerIdentifier(input.ownerId, "ownerId");
      assertNonNegativeInteger(input.generation, "generation");
    }

    return this.db.transaction((): ToolReceiptClaim => {
      const turn = this.db.prepare(
        `SELECT controller_key, state, lease_owner, lease_generation, accepted_finalization_id,
                steer_reservation_turn_id, recovery_source_turn_id
           FROM controller_turns WHERE id = ?`,
      ).get(input.turnId) as {
        controller_key: string;
        state: string;
        lease_owner: string | null;
        lease_generation: number | null;
        accepted_finalization_id: number | null;
        steer_reservation_turn_id: string | null;
        recovery_source_turn_id: string | null;
      } | undefined;
      if (turn && turn.accepted_finalization_id !== null) {
        return { outcome: "finalized" };
      }
      if (hasFence && (
        !turn || turn.controller_key !== input.controllerKey || turn.state !== "submitted" ||
        turn.lease_owner !== input.ownerId || turn.lease_generation !== input.generation ||
        turn.steer_reservation_turn_id !== null ||
        !this.executorLeaseIsCurrent(input.ownerId!, input.generation!, input.now)
      )) return { outcome: "fence_lost" };
      let inheritedReceipt = false;
      let existing = this.db.prepare(
        `SELECT state, result_text, last_error, controller_key FROM tool_receipts
          WHERE turn_id = ? AND tool_name = ? AND args_sha256 = ?`,
      ).get(input.turnId, input.toolName, input.argsSha256) as
        { state: string; result_text: string | null; last_error: string | null; controller_key: string } | undefined;
      if (!existing && turn?.recovery_source_turn_id) {
        existing = this.db.prepare(
          `SELECT receipt.state, receipt.result_text, receipt.last_error, receipt.controller_key
             FROM tool_receipts AS receipt
             JOIN controller_turns AS source ON source.id = receipt.turn_id
            WHERE receipt.turn_id = ? AND receipt.tool_name = ? AND receipt.args_sha256 = ?
              AND source.controller_key = ?`,
        ).get(
          turn.recovery_source_turn_id,
          input.toolName,
          input.argsSha256,
          input.controllerKey,
        ) as typeof existing;
        inheritedReceipt = existing !== undefined;
      }
      if (inheritedReceipt && existing?.state === "failed" && existing.last_error === "authorization_failed") {
        existing = undefined;
      }
      if (existing && existing.controller_key !== input.controllerKey) return { outcome: "fence_lost" };
      if (existing?.state === "completed") {
        return { outcome: "completed", result: existing.result_text ?? "" };
      }
      if (existing?.state === "started") return { outcome: "interrupted" };
      if (existing?.state === "failed" && existing.last_error !== "authorization_failed") {
        return { outcome: "interrupted" };
      }
      if (existing) {
        this.db.prepare(
          `UPDATE tool_receipts SET state = 'started', last_error = NULL, updated_at = ?
            WHERE turn_id = ? AND tool_name = ? AND args_sha256 = ?`,
        ).run(input.now, input.turnId, input.toolName, input.argsSha256);
        return { outcome: "fresh" };
      }
      this.db.prepare(
        `INSERT INTO tool_receipts (
           turn_id, tool_name, args_sha256, controller_key, state, result_text, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'started', NULL, NULL, ?, ?)`,
      ).run(input.turnId, input.toolName, input.argsSha256, input.controllerKey, input.now, input.now);
      return { outcome: "fresh" };
    }).immediate();
  }

  public completeToolReceipt(input: ToolReceiptKey & { result: string; now: number }): void {
    assertControllerIdentifier(input.turnId, "turnId");
    assertControllerIdentifier(input.toolName, "toolName");
    assertSha256Hex(input.argsSha256);
    if (typeof input.result !== "string" || Buffer.byteLength(input.result, "utf8") > MAX_RECEIPT_RESULT_BYTES) {
      throw new TypeError("tool receipt result must be at most 8000 UTF-8 bytes");
    }
    assertNonNegativeInteger(input.now, "now");
    const completed = this.db.prepare(
      `UPDATE tool_receipts SET state = 'completed', result_text = ?, last_error = NULL, updated_at = ?
        WHERE turn_id = ? AND tool_name = ? AND args_sha256 = ? AND state = 'started'`,
    ).run(input.result, input.now, input.turnId, input.toolName, input.argsSha256);
    if (completed.changes !== 1) throw new Error("exact started tool receipt was not completed");
  }

  public failToolReceipt(input: ToolReceiptKey & Readonly<{
    error: string;
    now: number;
    controllerKey?: string;
    ownerId?: string;
    generation?: number;
  }>): void {
    assertNonNegativeInteger(input.now, "now");
    const hasFence = input.ownerId !== undefined || input.generation !== undefined;
    if (hasFence && (
      input.ownerId === undefined || input.generation === undefined || input.controllerKey === undefined
    )) {
      throw new TypeError("tool receipt failure fence is incomplete");
    }
    if (hasFence) assertControllerKey(input.controllerKey!);
    if (hasFence && !this.executorLeaseIsCurrent(input.ownerId!, input.generation!, input.now)) return;
    const fencePredicate = hasFence
      ? ` AND EXISTS (
           SELECT 1 FROM controller_turns
            WHERE id = ? AND controller_key = ? AND state = 'submitted'
              AND lease_owner = ? AND lease_generation = ? AND accepted_finalization_id IS NULL
              AND steer_reservation_turn_id IS NULL
         )`
      : "";
    const parameters = hasFence
      ? [input.error.slice(0, 500), input.now, input.turnId, input.toolName, input.argsSha256,
          input.turnId, input.controllerKey, input.ownerId!, input.generation!]
      : [input.error.slice(0, 500), input.now, input.turnId, input.toolName, input.argsSha256];
    this.db.prepare(
      `UPDATE tool_receipts SET state = 'failed', last_error = ?, updated_at = ?
        WHERE turn_id = ? AND tool_name = ? AND args_sha256 = ? AND state = 'started'${fencePredicate}`,
    ).run(...parameters);
  }

  public listToolReceipts(turnId: string): { toolName: string; state: string; result: string | null }[] {
    assertControllerIdentifier(turnId, "turnId");
    return this.db.prepare(
      `SELECT receipt.tool_name AS toolName, receipt.state, receipt.result_text AS result
         FROM tool_receipts AS receipt
        WHERE receipt.turn_id = ? OR receipt.turn_id = (
          SELECT recovery_source_turn_id FROM controller_turns WHERE id = ?
        )
        ORDER BY receipt.created_at ASC LIMIT 50`,
    ).all(turnId, turnId) as { toolName: string; state: string; result: string | null }[];
  }

  public listControllerGenerations(controllerKey: string, limit: number): ControllerGeneration[] {
    assertControllerKey(controllerKey);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
    const rows = this.db.prepare(
      `SELECT id, controller_key, thread_id, started_at, ended_at, end_reason
         FROM controller_generations WHERE controller_key = ? ORDER BY started_at DESC LIMIT ?`,
    ).all(controllerKey, limit) as {
      id: string;
      controller_key: string;
      thread_id: string;
      started_at: number;
      ended_at: number | null;
      end_reason: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      controllerKey: row.controller_key,
      threadId: row.thread_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      endReason: row.end_reason,
    }));
  }

  public createMonitor(input: {
    controllerKey: string;
    kind: MonitorKind;
    threadId?: string;
    cron?: string;
    instruction: string;
    dueAt: number | null;
    now: number;
  }): MonitorRecord {
    assertControllerKey(input.controllerKey);
    if (input.kind !== "thread_idle" && input.kind !== "schedule") throw new TypeError("monitor kind is invalid");
    if (input.kind === "thread_idle") assertControllerIdentifier(input.threadId ?? "", "threadId");
    if (input.kind === "schedule" && !input.cron) throw new TypeError("a scheduled monitor requires a cron expression");
    const instruction = assertMemoryText(input.instruction, MAX_MONITOR_INSTRUCTION, "monitor instruction");
    if (input.dueAt !== null) assertNonNegativeInteger(input.dueAt, "dueAt");
    assertNonNegativeInteger(input.now, "now");
    if (this.countArmedMonitors(input.controllerKey) >= MAX_ARMED_MONITORS) {
      throw new TypeError(`at most ${MAX_ARMED_MONITORS} monitors can be armed at once`);
    }

    const id = `mon-${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO monitors (
         id, controller_key, kind, thread_id, cron, instruction, state, due_at,
         fire_count, last_fired_at, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'armed', ?, 0, NULL, NULL, ?, ?)`,
    ).run(
      id,
      input.controllerKey,
      input.kind,
      input.threadId ?? null,
      input.cron ?? null,
      instruction,
      input.dueAt,
      input.now,
      input.now,
    );
    return this.requireMonitor(id);
  }

  /**
   * Keeps exactly one armed watch per thread. Two watches on one thread wake the
   * agent twice for the same landing and burn two of its armed slots, so an
   * existing watch is reused rather than joined by a second.
   *
   * `courtesy` is a watch armed alongside another action, because engaging with
   * a thread is what creates the obligation to hear how it ends and the agent
   * cannot be relied on to arm that itself. It never overwrites what the agent
   * deliberately wrote, and returns null rather than throwing at the armed cap:
   * it must not be able to fail the action the owner actually asked for.
   *
   * `explicit` is the agent arming the watch itself, so its own instruction
   * replaces whatever a courtesy arming left there — that text is all its future
   * self will receive.
   */
  public ensureThreadWatch(input: {
    controllerKey: string;
    threadId: string;
    instruction: string;
    dueAt: number;
    now: number;
    mode: "courtesy" | "explicit";
  }): MonitorRecord | null {
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.threadId, "threadId");
    const instruction = assertMemoryText(input.instruction, MAX_MONITOR_INSTRUCTION, "monitor instruction");
    assertNonNegativeInteger(input.dueAt, "dueAt");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): MonitorRecord | null => {
      const existing = this.db.prepare(
        `SELECT * FROM monitors
          WHERE controller_key = ? AND kind = 'thread_idle' AND thread_id = ? AND state = 'armed'
          ORDER BY created_at ASC LIMIT 1`,
      ).get(input.controllerKey, input.threadId) as MonitorRow | undefined;
      if (existing) {
        if (input.mode === "courtesy") return parseMonitor(existing);
        this.db.prepare(
          "UPDATE monitors SET instruction = ?, due_at = ?, updated_at = ? WHERE id = ?",
        ).run(instruction, input.dueAt, input.now, existing.id);
        return this.requireMonitor(existing.id);
      }
      if (input.mode === "courtesy" && this.countArmedMonitors(input.controllerKey) >= MAX_ARMED_MONITORS) {
        return null;
      }
      return this.createMonitor({
        controllerKey: input.controllerKey,
        kind: "thread_idle",
        threadId: input.threadId,
        instruction,
        dueAt: input.dueAt,
        now: input.now,
      });
    }).immediate();
  }

  /**
   * Installs a monitor the plugin owns rather than the owner. Keyed so install
   * is idempotent across restarts, and exempt from the owner's armed-monitor
   * cap: the agent's own housekeeping must not be crowded out by watches the
   * owner set, nor consume slots they were counting on.
   */
  public ensureSystemMonitor(input: {
    systemKey: string;
    controllerKey: string;
    cron: string;
    instruction: string;
    dueAt: number;
    now: number;
  }): MonitorRecord {
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.systemKey, "systemKey");
    const instruction = assertMemoryText(input.instruction, MAX_MONITOR_INSTRUCTION, "monitor instruction");
    assertNonNegativeInteger(input.dueAt, "dueAt");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): MonitorRecord => {
      const existing = this.db.prepare(
        "SELECT * FROM monitors WHERE system_key = ?",
      ).get(input.systemKey) as MonitorRow | undefined;
      if (existing) {
        // Re-arm a system monitor the owner or a failure retired; its schedule
        // and wording are owned by this release, not by whatever ran before.
        this.db.prepare(
          `UPDATE monitors
              SET cron = ?, instruction = ?, updated_at = ?,
                  state = CASE WHEN state = 'armed' THEN 'armed' ELSE 'armed' END,
                  due_at = CASE WHEN state = 'armed' AND due_at IS NOT NULL THEN due_at ELSE ? END
            WHERE system_key = ?`,
        ).run(input.cron, instruction, input.now, input.dueAt, input.systemKey);
        return this.requireMonitor(existing.id);
      }
      const id = `mon-${randomUUID()}`;
      this.db.prepare(
        `INSERT INTO monitors (
           id, controller_key, kind, thread_id, cron, instruction, state, due_at,
           fire_count, last_fired_at, last_error, created_at, updated_at, system_key
         ) VALUES (?, ?, 'schedule', NULL, ?, ?, 'armed', ?, 0, NULL, NULL, ?, ?, ?)`,
      ).run(id, input.controllerKey, input.cron, instruction, input.dueAt, input.now, input.now, input.systemKey);
      return this.requireMonitor(id);
    }).immediate();
  }

  /**
   * Durable counts only. Every number here is read from committed state, so the
   * agent can report it without inventing a rate the database cannot support.
   */
  public buildAutonomyScorecard(input: { now: number; windowMs: number }): {
    windowMs: number;
    jobs: Record<string, number>;
    blockedJobs: { id: string; projectId: string | null; reason: string | null; updatedAt: number }[];
    projectsHeldByFailedJobs: { jobId: string; projectId: string | null; failedAt: number }[];
    remediationCycles: number;
    approvalsRequested: number;
    approvalsConsumed: number;
    deliveryRetries: number;
    undeliverable: number;
    memory: { live: number; tombstoned: number; superseded: number; lowConfidence: number; extracted: number };
    monitors: { armed: number; system: number; failed: number };
  } {
    assertNonNegativeInteger(input.now, "now");
    if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1) throw new TypeError("windowMs must be positive");
    const since = Math.max(0, input.now - input.windowMs);
    const scalar = (sql: string, ...params: unknown[]): number => {
      const row = this.db.prepare(sql).get(...params) as { value: number } | undefined;
      return row?.value ?? 0;
    };
    const jobRows = this.db.prepare(
      "SELECT state, COUNT(*) AS value FROM jobs WHERE updated_at >= ? GROUP BY state",
    ).all(since) as { state: string; value: number }[];
    const jobs: Record<string, number> = {};
    for (const row of jobRows) jobs[row.state] = row.value;
    const blockedJobs = this.db.prepare(
      `SELECT id, project_id AS projectId, blocked_reason AS reason, updated_at AS updatedAt
         FROM jobs WHERE state = 'blocked' ORDER BY updated_at DESC LIMIT 10`,
    ).all() as { id: string; projectId: string | null; reason: string | null; updatedAt: number }[];
    return {
      windowMs: input.windowMs,
      jobs,
      blockedJobs,
      // A failed job keeps its project's pipeline claim so a retry can resume
      // in place. Nothing expires that, so an abandoned failure silently blocks
      // every future job on that project — the owner has to retry or cancel it,
      // and can only do that if someone tells them.
      projectsHeldByFailedJobs: this.db.prepare(
        `SELECT job.id AS jobId, job.project_id AS projectId, job.updated_at AS failedAt
           FROM job_resource_claims AS claim
           JOIN jobs AS job ON job.id = claim.job_id
          WHERE claim.state = 'held' AND claim.resource_kind = 'project' AND job.state = 'failed'
          ORDER BY job.updated_at ASC LIMIT 10`,
      ).all() as { jobId: string; projectId: string | null; failedAt: number }[],
      remediationCycles: scalar(
        "SELECT COALESCE(SUM(review_cycle), 0) AS value FROM jobs WHERE updated_at >= ?", since),
      approvalsRequested: scalar(
        "SELECT COUNT(*) AS value FROM approvals WHERE expires_at >= ?", since),
      approvalsConsumed: scalar(
        "SELECT COUNT(*) AS value FROM approvals WHERE consumed_at IS NOT NULL AND consumed_at >= ?", since),
      deliveryRetries: scalar(
        "SELECT COALESCE(SUM(attempts), 0) AS value FROM outbox WHERE updated_at >= ? AND attempts > 1", since),
      undeliverable: scalar("SELECT COUNT(*) AS value FROM outbox WHERE status = 'dead'"),
      memory: {
        live: scalar(
          "SELECT COUNT(*) AS value FROM memories WHERE forgotten_at IS NULL AND superseded_by IS NULL"),
        tombstoned: scalar("SELECT COUNT(*) AS value FROM memories WHERE forgotten_at IS NOT NULL"),
        superseded: scalar("SELECT COUNT(*) AS value FROM memories WHERE superseded_by IS NOT NULL"),
        lowConfidence: scalar(
          `SELECT COUNT(*) AS value FROM memories
            WHERE forgotten_at IS NULL AND superseded_by IS NULL AND confidence < 0.3`),
        extracted: scalar(
          `SELECT COUNT(*) AS value FROM memories
            WHERE origin = 'job_outcome' AND forgotten_at IS NULL AND superseded_by IS NULL`),
      },
      monitors: {
        armed: scalar("SELECT COUNT(*) AS value FROM monitors WHERE state = 'armed'"),
        system: scalar("SELECT COUNT(*) AS value FROM monitors WHERE system_key IS NOT NULL"),
        failed: scalar("SELECT COUNT(*) AS value FROM monitors WHERE state = 'failed'"),
      },
    };
  }

  /** The owner's standing wording about how this agent should work. */
  public getControllerOverlay(): string | null {
    const row = this.db.prepare("SELECT text FROM controller_overlay WHERE singleton = 1")
      .get() as { text: string } | undefined;
    const text = row?.text.trim() ?? "";
    return text.length === 0 ? null : text;
  }

  /** Passing empty text clears the overlay rather than storing a blank rule. */
  public setControllerOverlay(input: { text: string; now: number }): string | null {
    assertNonNegativeInteger(input.now, "now");
    const text = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim() : "";
    if (text.length > MAX_CONTROLLER_OVERLAY) {
      throw new TypeError(`controller overlay must be at most ${MAX_CONTROLLER_OVERLAY} characters`);
    }
    // The overlay is replayed into every turn's system instructions, so a
    // pasted credential here would outlive the message that carried it.
    if (containsCredentialLikeText(text)) throw new TypeError("controller overlay must not contain credential-like text");
    if (text.length === 0) {
      this.db.prepare("DELETE FROM controller_overlay WHERE singleton = 1").run();
      return null;
    }
    this.db.prepare(
      `INSERT INTO controller_overlay (singleton, text, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    ).run(text, input.now);
    return text;
  }

  /** Retires every plugin-owned monitor; the owner's own watches are untouched. */
  public listSystemMonitors(): MonitorRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM monitors WHERE system_key IS NOT NULL ORDER BY system_key ASC",
    ).all() as MonitorRow[];
    return rows.map(parseMonitor);
  }

  public cancelSystemMonitors(now: number): number {
    assertNonNegativeInteger(now, "now");
    return this.db.prepare(
      "UPDATE monitors SET state = 'cancelled', updated_at = ? WHERE system_key IS NOT NULL AND state = 'armed'",
    ).run(now).changes;
  }

  public getProductionHealth(projectId: string): ProductionHealthRecord | null {
    const row = this.db.prepare("SELECT * FROM production_health WHERE project_id = ?")
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? parseProductionHealth(row) : null;
  }

  /**
   * One reading. A fault is only declared after enough consecutive failures to
   * rule out a blip, and a single success clears the count immediately.
   */
  public recordProductionHealth(input: {
    projectId: string;
    ok: boolean;
    summary: string;
    failureThreshold: number;
    now: number;
  }): ProductionHealthRecord {
    assertControllerIdentifier(input.projectId, "projectId");
    assertNonNegativeInteger(input.now, "now");
    if (!Number.isInteger(input.failureThreshold) || input.failureThreshold < 1) {
      throw new TypeError("failureThreshold must be a positive integer");
    }
    const summary = assertMemoryText(input.summary || "no output", 400, "health summary");
    return this.db.transaction((): ProductionHealthRecord => {
      const previous = this.getProductionHealth(input.projectId);
      const failures = input.ok ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
      const state: ProductionHealthState = input.ok
        ? "ok"
        : failures >= input.failureThreshold ? "failing" : (previous?.state ?? "unknown");
      this.db.prepare(
        `INSERT INTO production_health (
           project_id, state, consecutive_failures, last_summary, last_checked_at,
           reported_state, reported_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           state = excluded.state,
           consecutive_failures = excluded.consecutive_failures,
           last_summary = excluded.last_summary,
           last_checked_at = excluded.last_checked_at,
           updated_at = excluded.updated_at`,
      ).run(input.projectId, state, failures, summary, input.now, input.now, input.now);
      const stored = this.getProductionHealth(input.projectId);
      if (!stored) throw new Error("Production health was not stored");
      return stored;
    }).immediate();
  }

  /** Claims a transition so a crash cannot report the same change twice. */
  public recordProductionHealthReported(input: {
    projectId: string;
    state: ProductionHealthState;
    now: number;
  }): boolean {
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      `UPDATE production_health SET reported_state = ?, reported_at = ?, updated_at = ?
        WHERE project_id = ? AND (reported_state IS NULL OR reported_state != ?)`,
    ).run(input.state, input.now, input.now, input.projectId, input.state).changes === 1;
  }

  public getMergeAuthority(projectId: string): MergeAuthorityGrant | null {
    assertControllerIdentifier(projectId, "projectId");
    const row = this.db.prepare("SELECT * FROM merge_authority WHERE project_id = ?")
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? parseMergeAuthority(row) : null;
  }

  /**
   * Granting is idempotent and always re-opens a revoked grant, so an owner who
   * says "always" twice does not end up with a grant they think is live and is
   * not.
   */
  public grantMergeAuthority(input: {
    projectId: string;
    userId: string;
    chatId: string;
    now: number;
  }): MergeAuthorityGrant {
    assertControllerIdentifier(input.projectId, "projectId");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): MergeAuthorityGrant => {
      this.db.prepare(
        `INSERT INTO merge_authority (
           project_id, granted_at, granted_by_user_id, granted_by_chat_id, revoked_at, revoked_reason
         ) VALUES (?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(project_id) DO UPDATE SET
           granted_at = excluded.granted_at,
           granted_by_user_id = excluded.granted_by_user_id,
           granted_by_chat_id = excluded.granted_by_chat_id,
           revoked_at = NULL,
           revoked_reason = NULL`,
      ).run(input.projectId, input.now, input.userId, input.chatId);
      this.appendMergeAuthorityEvent({
        projectId: input.projectId,
        action: "granted",
        actorUserId: input.userId,
        actorChatId: input.chatId,
        now: input.now,
      });
      const granted = this.getMergeAuthority(input.projectId);
      if (!granted) throw new Error("merge authority grant did not persist");
      return granted;
    })();
  }

  /** Returns true only when a live grant was actually withdrawn. */
  public revokeMergeAuthority(input: {
    projectId: string;
    reason: string;
    now: number;
    userId?: string;
    chatId?: string;
  }): boolean {
    assertControllerIdentifier(input.projectId, "projectId");
    assertNonNegativeInteger(input.now, "now");
    const reason = assertMemoryText(input.reason, 200, "revocation reason");
    return this.db.transaction((): boolean => {
      const revoked = this.db.prepare(
        `UPDATE merge_authority SET revoked_at = ?, revoked_reason = ?
          WHERE project_id = ? AND revoked_at IS NULL`,
      ).run(input.now, reason, input.projectId).changes === 1;
      if (revoked) {
        this.appendMergeAuthorityEvent({
          projectId: input.projectId,
          action: "revoked",
          reason,
          ...(input.userId === undefined ? {} : { actorUserId: input.userId }),
          ...(input.chatId === undefined ? {} : { actorChatId: input.chatId }),
          now: input.now,
        });
      }
      return revoked;
    })();
  }

  /** Records that a standing grant merged a specific job without asking. */
  public recordMergeAuthorityUse(input: {
    projectId: string;
    jobId: string;
    now: number;
  }): void {
    assertControllerIdentifier(input.projectId, "projectId");
    assertNonNegativeInteger(input.now, "now");
    this.appendMergeAuthorityEvent({
      projectId: input.projectId,
      action: "used",
      jobId: input.jobId,
      now: input.now,
    });
  }

  public listMergeAuthorityEvents(projectId: string, limit = 50): MergeAuthorityEvent[] {
    assertControllerIdentifier(projectId, "projectId");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError("limit must be between 1 and 500");
    }
    const rows = this.db.prepare(
      `SELECT * FROM merge_authority_events
        WHERE project_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    ).all(projectId, limit) as Record<string, unknown>[];
    return rows.map(parseMergeAuthorityEvent);
  }

  private appendMergeAuthorityEvent(input: {
    projectId: string;
    action: MergeAuthorityEvent["action"];
    jobId?: string;
    actorUserId?: string;
    actorChatId?: string;
    reason?: string;
    now: number;
  }): void {
    this.db.prepare(
      `INSERT INTO merge_authority_events (
         project_id, action, job_id, actor_user_id, actor_chat_id, reason, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.projectId,
      input.action,
      input.jobId ?? null,
      input.actorUserId ?? null,
      input.actorChatId ?? null,
      input.reason ?? null,
      input.now,
    );
  }

  public getRegressionWatch(projectId: string): RegressionWatchRecord | null {
    assertControllerIdentifier(projectId, "projectId");
    const row = this.db.prepare("SELECT * FROM regression_watch WHERE project_id = ?")
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? parseRegressionWatch(row) : null;
  }

  public recordRegressionReading(input: {
    projectId: string;
    confirmed: readonly string[];
    flaky: readonly string[];
    summary: string;
    now: number;
  }): RegressionWatchRecord {
    assertControllerIdentifier(input.projectId, "projectId");
    assertNonNegativeInteger(input.now, "now");
    const summary = assertMemoryText(input.summary || "no output", 400, "regression summary");
    const confirmed = JSON.stringify([...new Set(input.confirmed)].sort());
    const flaky = JSON.stringify([...new Set(input.flaky)].sort());
    this.db.prepare(
      `INSERT INTO regression_watch (
         project_id, confirmed_failures, reported_failures, flaky_failures,
         last_summary, last_checked_at, reported_at, created_at, updated_at
       ) VALUES (?, ?, '[]', ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         confirmed_failures = excluded.confirmed_failures,
         flaky_failures = excluded.flaky_failures,
         last_summary = excluded.last_summary,
         last_checked_at = excluded.last_checked_at,
         updated_at = excluded.updated_at`,
    ).run(input.projectId, confirmed, flaky, summary, input.now, input.now, input.now);
    const record = this.getRegressionWatch(input.projectId);
    if (!record) throw new Error("regression reading did not persist");
    return record;
  }

  /**
   * Claims the report before it is sent, so a crash between deciding to tell
   * the owner and telling them cannot produce the same alert twice.
   */
  public recordRegressionReported(input: {
    projectId: string;
    reported: readonly string[];
    now: number;
  }): boolean {
    assertControllerIdentifier(input.projectId, "projectId");
    assertNonNegativeInteger(input.now, "now");
    const reported = JSON.stringify([...new Set(input.reported)].sort());
    return this.db.prepare(
      `UPDATE regression_watch SET reported_failures = ?, reported_at = ?, updated_at = ?
        WHERE project_id = ? AND reported_failures != ?`,
    ).run(reported, input.now, input.now, input.projectId, reported).changes === 1;
  }

  /** Jobs that reached a failed state inside the window, newest first. */
  public listRecentJobFailures(input: { since: number; limit: number }): {
    jobId: string;
    projectId: string | null;
    reason: string | null;
    failedAt: number;
  }[] {
    assertNonNegativeInteger(input.since, "since");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new TypeError("limit must be between 1 and 500");
    }
    const rows = this.db.prepare(
      `SELECT id, project_id, last_error, blocked_reason, updated_at FROM jobs
        WHERE state IN ('failed', 'blocked', 'production_failed') AND updated_at >= ?
        ORDER BY updated_at DESC LIMIT ?`,
    ).all(input.since, input.limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      jobId: String(row.id),
      projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
      reason: row.last_error === null || row.last_error === undefined
        ? (row.blocked_reason === null || row.blocked_reason === undefined ? null : String(row.blocked_reason))
        : String(row.last_error),
      failedAt: Number(row.updated_at),
    }));
  }

  /** True only the first time a fingerprint is escalated within its dedup window. */
  public claimFailureEscalation(input: {
    fingerprint: string;
    projectId: string | null;
    clusterSize: number;
    reason: string;
    now: number;
    dedupMs: number;
  }): boolean {
    assertNonNegativeInteger(input.now, "now");
    if (!/^[0-9a-f]{64}$/.test(input.fingerprint)) throw new TypeError("fingerprint must be a sha256 digest");
    const reason = assertMemoryText(input.reason || "unknown failure", 200, "failure reason");
    return this.db.transaction((): boolean => {
      this.db.prepare("DELETE FROM failure_escalations WHERE expires_at <= ?").run(input.now);
      const existing = this.db.prepare("SELECT fingerprint FROM failure_escalations WHERE fingerprint = ?")
        .get(input.fingerprint);
      if (existing) return false;
      this.db.prepare(
        `INSERT INTO failure_escalations (fingerprint, project_id, cluster_size, reason, escalated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.fingerprint, input.projectId, input.clusterSize, reason, input.now, input.now + input.dedupMs);
      return true;
    })();
  }

  public claimHousekeepingNotice(input: {
    key: string;
    detail: string;
    now: number;
    dedupMs: number;
  }): boolean {
    assertNonNegativeInteger(input.now, "now");
    assertNonNegativeInteger(input.dedupMs, "dedupMs");
    const key = assertMemoryText(input.key, 120, "housekeeping notice key");
    const detail = assertMemoryText(input.detail || "-", 500, "housekeeping notice detail");
    return this.db.transaction((): boolean => {
      this.db.prepare("DELETE FROM housekeeping_notices WHERE expires_at <= ?").run(input.now);
      if (this.db.prepare("SELECT notice_key FROM housekeeping_notices WHERE notice_key = ?").get(key)) {
        return false;
      }
      this.db.prepare(
        `INSERT INTO housekeeping_notices (notice_key, detail, claimed_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      ).run(key, detail, input.now, input.now + input.dedupMs);
      return true;
    })();
  }

  public pauseProjectAdmission(input: {
    projectId: string;
    reason: string;
    fingerprint: string | null;
    now: number;
  }): boolean {
    assertControllerIdentifier(input.projectId, "projectId");
    assertNonNegativeInteger(input.now, "now");
    const reason = assertMemoryText(input.reason, 200, "pause reason");
    return this.db.prepare(
      `INSERT INTO project_admission_pauses (project_id, reason, fingerprint, paused_at, cleared_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(project_id) DO UPDATE SET
         reason = excluded.reason,
         fingerprint = excluded.fingerprint,
         paused_at = excluded.paused_at,
         cleared_at = NULL
       WHERE project_admission_pauses.cleared_at IS NOT NULL`,
    ).run(input.projectId, reason, input.fingerprint, input.now).changes === 1;
  }

  public listPausedProjectAdmissions(): { projectId: string; reason: string; pausedAt: number }[] {
    const rows = this.db.prepare(
      "SELECT project_id, reason, paused_at FROM project_admission_pauses WHERE cleared_at IS NULL",
    ).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      projectId: String(row.project_id),
      reason: String(row.reason),
      pausedAt: Number(row.paused_at),
    }));
  }

  /** Clears one project, or every paused project when no id is given. */
  public clearProjectAdmissionPause(input: { projectId?: string; now: number }): number {
    assertNonNegativeInteger(input.now, "now");
    if (input.projectId === undefined) {
      return this.db.prepare(
        "UPDATE project_admission_pauses SET cleared_at = ? WHERE cleared_at IS NULL",
      ).run(input.now).changes;
    }
    assertControllerIdentifier(input.projectId, "projectId");
    return this.db.prepare(
      "UPDATE project_admission_pauses SET cleared_at = ? WHERE project_id = ? AND cleared_at IS NULL",
    ).run(input.now, input.projectId).changes;
  }

  public listMonitors(controllerKey: string, includeFinished: boolean): MonitorRecord[] {
    assertControllerKey(controllerKey);
    const rows = this.db.prepare(
      `SELECT * FROM monitors
        WHERE controller_key = ? AND system_key IS NULL AND (? = 1 OR state = 'armed')
        ORDER BY created_at DESC LIMIT ?`,
    ).all(controllerKey, includeFinished ? 1 : 0, MAX_ARMED_MONITORS * 4) as MonitorRow[];
    return rows.map(parseMonitor);
  }

  public listArmedMonitors(limit: number): MonitorRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
    const rows = this.db.prepare(
      "SELECT * FROM monitors WHERE state = 'armed' ORDER BY created_at ASC LIMIT ?",
    ).all(limit) as MonitorRow[];
    return rows.map(parseMonitor);
  }

  public getControllerMonitor(controllerKey: string, id: string): MonitorRecord | null {
    assertControllerKey(controllerKey);
    const row = this.db.prepare(
      "SELECT * FROM monitors WHERE controller_key = ? AND id = ? AND system_key IS NULL",
    ).get(controllerKey, id) as MonitorRow | undefined;
    return row ? parseMonitor(row) : null;
  }

  public cancelControllerMonitor(controllerKey: string, id: string, now: number): boolean {
    assertControllerKey(controllerKey);
    assertNonNegativeInteger(now, "now");
    return this.db.prepare(
      `UPDATE monitors SET state = 'cancelled', updated_at = ?
        WHERE controller_key = ? AND id = ? AND system_key IS NULL AND state = 'armed'`,
    ).run(now, controllerKey, id).changes === 1;
  }

  public cancelMonitor(id: string, now: number): boolean {
    assertNonNegativeInteger(now, "now");
    return this.db.prepare(
      "UPDATE monitors SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'armed'",
    ).run(now, id).changes === 1;
  }

  // A one-shot watch retires when it fires; a schedule re-arms for its next due
  // time, so a restart never loses or double-books a recurring job.
  public recordMonitorFired(input: { id: string; nextDueAt: number | null; now: number }): boolean {
    assertNonNegativeInteger(input.now, "now");
    if (input.nextDueAt !== null) assertNonNegativeInteger(input.nextDueAt, "nextDueAt");
    return this.db.prepare(
      `UPDATE monitors
          SET state = CASE WHEN ? IS NULL THEN 'done' ELSE 'armed' END,
              due_at = ?, fire_count = fire_count + 1, last_fired_at = ?, updated_at = ?
        WHERE id = ? AND state = 'armed'`,
    ).run(input.nextDueAt, input.nextDueAt, input.now, input.now, input.id).changes === 1;
  }

  public failMonitor(input: { id: string; error: string; now: number }): boolean {
    assertSafeFailureSummary(input.error);
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      "UPDATE monitors SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND state = 'armed'",
    ).run(input.error, input.now, input.id).changes === 1;
  }

  /**
   * Records the intent to fan out before any thread is spawned, so a crash
   * partway through leaves a joinable delegation rather than orphan threads
   * nobody is waiting on.
   */
  public createDelegation(input: {
    controllerKey: string;
    instruction: string;
    now: number;
  }): DelegationRecord {
    assertControllerKey(input.controllerKey);
    const instruction = assertMemoryText(input.instruction, MAX_MONITOR_INSTRUCTION, "delegation instruction");
    assertNonNegativeInteger(input.now, "now");
    if (this.countOpenDelegations(input.controllerKey) >= MAX_OPEN_DELEGATIONS) {
      throw new TypeError(`at most ${MAX_OPEN_DELEGATIONS} delegations can be open at once`);
    }
    const id = `del-${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO delegations (
         id, controller_key, instruction, state, fired_at, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, 'open', NULL, NULL, ?, ?)`,
    ).run(id, input.controllerKey, instruction, input.now, input.now);
    return this.requireDelegation(id);
  }

  public addDelegationThread(input: {
    delegationId: string;
    threadId: string;
    projectId: string;
    title: string;
    now: number;
  }): boolean {
    assertControllerIdentifier(input.threadId, "threadId");
    assertControllerIdentifier(input.projectId, "projectId");
    const title = assertMemoryText(input.title, MAX_DELEGATION_TITLE, "delegation title");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): boolean => {
      const delegation = this.db.prepare(
        "SELECT * FROM delegations WHERE id = ? AND state = 'open'",
      ).get(input.delegationId) as DelegationRow | undefined;
      if (!delegation) return false;
      const existing = this.db.prepare(
        "SELECT COUNT(*) AS count FROM delegation_threads WHERE delegation_id = ?",
      ).get(input.delegationId) as { count: number };
      if (existing.count >= MAX_DELEGATION_THREADS) {
        throw new TypeError(`a delegation may fan out to at most ${MAX_DELEGATION_THREADS} threads`);
      }
      const inserted = this.db.prepare(
        `INSERT OR IGNORE INTO delegation_threads (
           delegation_id, thread_id, project_id, title, ordinal, state, summary, settled_at
         ) VALUES (?, ?, ?, ?, ?, 'running', NULL, NULL)`,
      ).run(input.delegationId, input.threadId, input.projectId, title, existing.count);
      if (inserted.changes !== 1) return false;
      this.db.prepare("UPDATE delegations SET updated_at = ? WHERE id = ?")
        .run(input.now, input.delegationId);
      return true;
    }).immediate();
  }

  public listOpenDelegations(limit: number): DelegationRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
    const rows = this.db.prepare(
      "SELECT * FROM delegations WHERE state = 'open' ORDER BY created_at ASC LIMIT ?",
    ).all(limit) as DelegationRow[];
    return rows.map((row) => parseDelegation(row, this.delegationThreads(row.id)));
  }

  public getDelegation(id: string): DelegationRecord | null {
    const row = this.db.prepare("SELECT * FROM delegations WHERE id = ?").get(id) as DelegationRow | undefined;
    return row ? parseDelegation(row, this.delegationThreads(row.id)) : null;
  }

  /** Settles one member exactly once; a later poll seeing the same thread is ignored. */
  public settleDelegationThread(input: {
    delegationId: string;
    threadId: string;
    state: Exclude<DelegationThreadState, "running">;
    summary: string | null;
    now: number;
  }): boolean {
    // Checked at runtime too: an untyped caller must not park a member back in
    // 'running', which would make the join wait on a thread already settled.
    if (!SETTLED_DELEGATION_THREAD_STATES.has(input.state)) {
      throw new TypeError("a delegation thread settles as finished, failed, or missing");
    }
    assertNonNegativeInteger(input.now, "now");
    const summary = input.summary === null
      ? null
      : clipDelegationSummary(input.summary, MAX_DELEGATION_SUMMARY);
    return this.db.prepare(
      `UPDATE delegation_threads
          SET state = ?, summary = ?, settled_at = ?
        WHERE delegation_id = ? AND thread_id = ? AND state = 'running'`,
    ).run(input.state, summary, input.now, input.delegationId, input.threadId).changes === 1;
  }

  /**
   * Claims the one stall report a watched thread gets. A watch fires only when
   * its thread reaches idle, error, or missing; a thread that wedges reaches
   * none of them, so without this the watch stays armed and silent forever and
   * the agent never follows up on work it started.
   */
  public claimMonitorStall(input: { id: string; now: number }): boolean {
    assertControllerIdentifier(input.id, "monitor id");
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      `UPDATE monitors
          SET stall_notified_at = ?, updated_at = ?
        WHERE id = ? AND kind = 'thread_idle'
          AND state = 'armed' AND stall_notified_at IS NULL`,
    ).run(input.now, input.now, input.id).changes === 1;
  }

  public claimDelegationThreadStall(input: {
    delegationId: string;
    threadId: string;
    now: number;
  }): boolean {
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      `UPDATE delegation_threads
          SET stall_notified_at = ?
        WHERE delegation_id = ? AND thread_id = ?
          AND state = 'running' AND stall_notified_at IS NULL`,
    ).run(input.now, input.delegationId, input.threadId).changes === 1;
  }

  /**
   * Marks the fan-out complete. Until this lands the executor must not join:
   * members are published one at a time across network round-trips, and a join
   * that fires between them reports a partial result and orphans the rest.
   */
  public sealDelegation(input: { id: string; now: number }): boolean {
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      "UPDATE delegations SET sealed_at = ?, updated_at = ? WHERE id = ? AND state = 'open' AND sealed_at IS NULL",
    ).run(input.now, input.now, input.id).changes === 1;
  }

  public recordDelegationFired(input: { id: string; now: number }): boolean {
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      "UPDATE delegations SET state = 'fired', fired_at = ?, updated_at = ? WHERE id = ? AND state = 'open'",
    ).run(input.now, input.now, input.id).changes === 1;
  }

  public failDelegation(input: { id: string; error: string; now: number }): boolean {
    assertSafeFailureSummary(input.error);
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      "UPDATE delegations SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND state = 'open'",
    ).run(input.error, input.now, input.id).changes === 1;
  }

  public cancelDelegation(id: string, now: number): boolean {
    assertNonNegativeInteger(now, "now");
    return this.db.prepare(
      "UPDATE delegations SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'open'",
    ).run(now, id).changes === 1;
  }

  private delegationThreads(delegationId: string): DelegationThreadRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM delegation_threads WHERE delegation_id = ? ORDER BY ordinal ASC",
    ).all(delegationId) as DelegationThreadRow[];
    return rows.map(parseDelegationThread);
  }

  /**
   * Enrolls terminal jobs that have never been learned from. Scanning for them
   * rather than emitting an effect at the transition keeps the job state
   * machine untouched and makes enrolment self-healing across restarts.
   */
  public enrolFinishedJobsForMemory(outcomes: readonly string[], limit: number, now: number): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
    assertNonNegativeInteger(now, "now");
    if (outcomes.length === 0) return 0;
    const placeholders = outcomes.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT id, state, project_id FROM jobs
        WHERE state IN (${placeholders})
          AND project_id IS NOT NULL
          -- A review-limit block is resumable: CONTINUE_REVIEW puts the job
          -- back to reviewing. Learning from it would draw a lesson from a
          -- live job, and enrolling it here would then bar the eventual merge
          -- — the outcome actually worth learning from — from ever enrolling.
          AND NOT (state = 'blocked' AND blocked_reason IN ('review_limit', 'plan_limit'))
          -- Same reasoning, now that the continuation sweep resumes a
          -- dead-lettered effect too. Such a job is only finished once the
          -- ladder is spent and it has been handed to the owner.
          AND NOT (state = 'blocked' AND blocked_reason = 'permanent_effect_failure'
                   AND auto_continue_escalated_at IS NULL)
          AND id NOT IN (SELECT job_id FROM job_memory_extractions)
        ORDER BY updated_at ASC LIMIT ?`,
    ).all(...outcomes, limit) as { id: string; state: string; project_id: string }[];
    for (const row of rows) {
      this.db.prepare(
        `INSERT OR IGNORE INTO job_memory_extractions (
           job_id, project_id, outcome, state, thread_id, attempts, saved_count,
           last_error, created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', NULL, 0, 0, NULL, ?, ?)`,
      ).run(row.id, row.project_id, row.state, now, now);
    }
    return rows.length;
  }

  public listJobMemoryExtractions(
    state: JobMemoryExtractionState,
    limit: number,
  ): JobMemoryExtractionRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
    const rows = this.db.prepare(
      "SELECT * FROM job_memory_extractions WHERE state = ? ORDER BY created_at ASC LIMIT ?",
    ).all(state, limit) as JobMemoryExtractionRow[];
    return rows.map(parseJobMemoryExtraction);
  }

  public startJobMemoryExtraction(input: { jobId: string; threadId: string; now: number }): boolean {
    assertControllerIdentifier(input.threadId, "threadId");
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      `UPDATE job_memory_extractions
          SET state = 'running', thread_id = ?, attempts = attempts + 1, updated_at = ?
        WHERE job_id = ? AND state = 'pending'`,
    ).run(input.threadId, input.now, input.jobId).changes === 1;
  }

  /**
   * Counts a start that never got off the ground. Without this a permanently
   * unusable project — deleted, renamed — retries on every executor pass
   * forever, because attempts were only ever counted on success.
   */
  public recordJobMemoryExtractionFailure(input: { jobId: string; error: string; now: number }): boolean {
    assertSafeFailureSummary(input.error);
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      `UPDATE job_memory_extractions
          SET attempts = attempts + 1, last_error = ?, updated_at = ?
        WHERE job_id = ? AND state = 'pending'`,
    ).run(input.error, input.now, input.jobId).changes === 1;
  }

  public completeJobMemoryExtraction(input: { jobId: string; savedCount: number; now: number }): boolean {
    assertNonNegativeInteger(input.savedCount, "savedCount");
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      `UPDATE job_memory_extractions
          SET state = 'done', saved_count = ?, updated_at = ?
        WHERE job_id = ? AND state = 'running'`,
    ).run(input.savedCount, input.now, input.jobId).changes === 1;
  }

  /** Records how much a claimed extraction actually stored, after the fact. */
  public recordJobMemorySaved(input: { jobId: string; savedCount: number; now: number }): boolean {
    assertNonNegativeInteger(input.savedCount, "savedCount");
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      "UPDATE job_memory_extractions SET saved_count = ?, updated_at = ? WHERE job_id = ? AND state = 'done'",
    ).run(input.savedCount, input.now, input.jobId).changes === 1;
  }

  public failJobMemoryExtraction(input: { jobId: string; error: string; now: number }): boolean {
    assertSafeFailureSummary(input.error);
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      `UPDATE job_memory_extractions
          SET state = 'failed', last_error = ?, updated_at = ?
        WHERE job_id = ? AND state IN ('pending', 'running')`,
    ).run(input.error, input.now, input.jobId).changes === 1;
  }

  private countOpenDelegations(controllerKey: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM delegations WHERE controller_key = ? AND state = 'open'",
    ).get(controllerKey) as { count: number };
    return row.count;
  }

  private requireDelegation(id: string): DelegationRecord {
    const delegation = this.getDelegation(id);
    if (!delegation) throw new Error("Persisted delegation is unavailable");
    return delegation;
  }

  private countArmedMonitors(controllerKey: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM monitors
        WHERE controller_key = ? AND state = 'armed' AND system_key IS NULL`,
    ).get(controllerKey) as { count: number };
    return row.count;
  }

  private requireMonitor(id: string): MonitorRecord {
    const row = this.db.prepare("SELECT * FROM monitors WHERE id = ?").get(id) as MonitorRow | undefined;
    if (!row) throw new Error("stored monitor disappeared before it could be read");
    return parseMonitor(row);
  }

  public rememberMemory(input: MemoryInput): MemoryRecord {
    assertMemoryScope(input.scope);
    if (!MEMORY_KINDS.has(input.kind)) throw new TypeError("memory kind is invalid");
    const subject = assertMemoryText(input.subject, MAX_MEMORY_SUBJECT, "memory subject");
    const body = assertMemoryText(input.body, MAX_MEMORY_BODY, "memory body");
    // A memory outlives the message that carried it and is replayed into every
    // later turn, so it gets the wider net rather than the failure-summary one.
    if (looksLikeStoredSecret(subject) || looksLikeStoredSecret(body)) {
      throw new TypeError("memory must not contain credential-like text");
    }
    const importance = assertUnitInterval(input.importance ?? DEFAULT_MEMORY_IMPORTANCE, "importance");
    const confidence = assertUnitInterval(input.confidence ?? DEFAULT_MEMORY_CONFIDENCE, "confidence");
    if (input.source !== "owner" && input.source !== "agent") throw new TypeError("memory source is invalid");
    assertNonNegativeInteger(input.now, "now");
    return this.insertMemory(input, { subject, body, importance, confidence });
  }

  /**
   * The owner's own import, and the one write allowed to carry secret-shaped
   * text. It arrives from the protected host under the owner's CLI identity
   * rather than from provider output or a chat message, so the stored-secret
   * screen guarding `rememberMemory` would only be refusing the owner their own
   * file. Everything the agent writes still goes through that screen.
   */
  public importOwnerMemory(input: OwnerMemoryImportInput): MemoryRecord {
    assertMemoryScope(input.scope);
    if (!MEMORY_KINDS.has(input.kind)) throw new TypeError("memory kind is invalid");
    const subject = assertMemoryText(input.subject, MAX_MEMORY_SUBJECT, "memory subject");
    const body = assertMemoryText(input.body, MAX_MEMORY_BODY, "memory body");
    const importance = assertUnitInterval(input.importance ?? DEFAULT_MEMORY_IMPORTANCE, "importance");
    const confidence = assertUnitInterval(input.confidence ?? DEFAULT_MEMORY_CONFIDENCE, "confidence");
    assertNonNegativeInteger(input.now, "now");
    return this.insertMemory(
      { ...input, source: "owner", origin: OWNER_IMPORT_ORIGIN },
      { subject, body, importance, confidence },
    );
  }

  private insertMemory(
    input: Readonly<{
      scope: string;
      kind: MemoryKind;
      source: "owner" | "agent";
      origin?: string;
      sourceTurnId?: string;
      now: number;
    }>,
    prepared: Readonly<{ subject: string; body: string; importance: number; confidence: number }>,
  ): MemoryRecord {
    const { subject, body, importance, confidence } = prepared;
    return this.db.transaction((): MemoryRecord => {
      const id = `mem-${randomUUID()}`;
      // A restated subject replaces its predecessor, so a correction reads as one
      // current belief while the superseded row stays as history.
      const previous = this.db.prepare(
        `SELECT id FROM memories
          WHERE scope = ? AND subject = ? AND forgotten_at IS NULL AND superseded_by IS NULL`,
      ).get(input.scope, subject) as { id: string } | undefined;
      if (previous) {
        this.db.prepare("UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?")
          .run(id, input.now, previous.id);
      }
      // A correction is the owner saying a belief is wrong, so it retires the
      // beliefs it contradicts rather than sitting alongside them. Only a
      // correction may do this: an ordinary restatement is not a refutation.
      if (input.kind === "correction") {
        // No self-exclusion needed: this row is inserted after the loop, so it
        // cannot be among the live rows being scanned.
        const live = this.db.prepare(
          `SELECT id, subject FROM memories
            WHERE scope = ? AND forgotten_at IS NULL AND superseded_by IS NULL`,
        ).all(input.scope) as { id: string; subject: string }[];
        const supersede = this.db.prepare(
          "UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ? AND superseded_by IS NULL",
        );
        for (const candidate of live) {
          if (candidate.id === previous?.id) continue;
          if (subjectsContradict(candidate.subject, subject)) {
            supersede.run(id, input.now, candidate.id);
          }
        }
      }
      this.db.prepare(
        `INSERT INTO memories (
           id, scope, kind, subject, body, importance, confidence, source, origin, source_turn_id,
           use_count, last_used_at, superseded_by, forgotten_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?)`,
      ).run(
        id,
        input.scope,
        input.kind,
        subject,
        body,
        importance,
        confidence,
        input.source,
        input.origin ?? null,
        input.sourceTurnId ?? null,
        input.now,
        input.now,
      );
      this.evictWeakestMemories(input.scope, input.now);
      return this.requireMemory(id);
    }).immediate();
  }

  public recallMemories(input: {
    scope: string;
    query?: string;
    limit: number;
    now: number;
    /** Links what was recalled to the turn it informed, so the answer's
     *  reception can later reinforce or demote exactly those memories. */
    turnId?: string;
  }): MemoryRecord[] {
    assertMemoryScope(input.scope);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError("limit must be between 1 and 100");
    }
    assertNonNegativeInteger(input.now, "now");

    return this.db.transaction((): MemoryRecord[] => {
      // Owner-scoped memories are always in play; project memories only inside
      // their own project, so one project's conventions cannot leak into another.
      const scopes = input.scope === OWNER_MEMORY_SCOPE ? [OWNER_MEMORY_SCOPE] : [OWNER_MEMORY_SCOPE, input.scope];
      const placeholders = scopes.map(() => "?").join(", ");
      const live = this.db.prepare(
        `SELECT * FROM memories
          WHERE scope IN (${placeholders}) AND forgotten_at IS NULL AND superseded_by IS NULL`,
      ).all(...scopes) as MemoryRow[];
      if (live.length === 0) return [];

      const lexicalRanks = new Map<string, number>();
      const match = input.query === undefined ? null : ftsQuery(input.query);
      if (match !== null) {
        const matched = this.db.prepare(
          `SELECT memories.id AS id FROM memories_fts
             JOIN memories ON memories.rowid = memories_fts.rowid
            WHERE memories_fts MATCH ?
              AND memories.scope IN (${placeholders})
              AND memories.forgotten_at IS NULL AND memories.superseded_by IS NULL
            ORDER BY bm25(memories_fts, 2.0, 1.0)
            LIMIT 100`,
        ).all(match, ...scopes) as { id: string }[];
        matched.forEach((row, index) => lexicalRanks.set(row.id, index));
      }

      const ranked = live
        .map((row) => ({
          row,
          score: memoryScore({
            lexicalRank: lexicalRanks.get(row.id) ?? null,
            importance: row.importance,
            confidence: row.confidence,
            ageMs: input.now - row.created_at,
          }),
        }))
        // An explicit question only surfaces memories that actually mention it;
        // an empty question falls back to the strongest standing memories.
        .filter((candidate) => match === null || lexicalRanks.has(candidate.row.id))
        .sort((left, right) => right.score - left.score || right.row.created_at - left.row.created_at)
        .slice(0, input.limit);

      const use = this.db.prepare(
        "UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
      );
      const link = this.db.prepare(
        `INSERT OR IGNORE INTO memory_recalls (turn_id, memory_id, recalled_at, scored_at, outcome)
         VALUES (?, ?, ?, NULL, NULL)`,
      );
      for (const candidate of ranked) {
        use.run(input.now, candidate.row.id);
        if (input.turnId !== undefined) link.run(input.turnId, candidate.row.id, input.now);
      }
      return ranked.map((candidate) => this.requireMemory(candidate.row.id));
    }).immediate();
  }

  public getMemory(id: string): MemoryRecord | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
    return row ? parseMemory(row) : null;
  }

  public forgetMemory(input: { id: string; now: number }): boolean {
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      "UPDATE memories SET forgotten_at = ?, updated_at = ? WHERE id = ? AND forgotten_at IS NULL",
    ).run(input.now, input.now, input.id).changes === 1;
  }

  /**
   * Ages out memories that were never useful. Confidence decays on idle time
   * rather than raw age, and only agent-written memories can be tombstoned:
   * something the owner said out loud must never vanish on a timer.
   */
  public curateMemories(input: { now: number }): { decayed: number; tombstoned: number } {
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): { decayed: number; tombstoned: number } => {
      const live = this.db.prepare(
        `SELECT id, source, confidence, use_count, last_used_at, created_at, curated_at FROM memories
          WHERE forgotten_at IS NULL AND superseded_by IS NULL`,
      ).all() as Pick<
        MemoryRow,
        "id" | "source" | "confidence" | "use_count" | "last_used_at" | "created_at" | "curated_at"
      >[];
      const update = this.db.prepare(
        "UPDATE memories SET confidence = ?, curated_at = ?, updated_at = ? WHERE id = ?",
      );
      const tombstone = this.db.prepare(
        "UPDATE memories SET forgotten_at = ?, curated_at = ?, updated_at = ? WHERE id = ? AND forgotten_at IS NULL",
      );
      let decayed = 0;
      let tombstoned = 0;
      for (const row of live) {
        // Decay the interval since confidence was last touched, not the whole
        // idle span: `confidence` is already the decayed value, so re-applying
        // the full span every pass compounds it. With a six-hour sweep that
        // turned a 217-day half-life into nine days and deleted memories the
        // ranking had barely begun to down-weight. Anchoring here also makes a
        // repeat pass at the same clock a no-op.
        const anchor = Math.max(row.curated_at ?? 0, row.last_used_at ?? 0) || row.created_at;
        const next = decayedConfidence(row.confidence, input.now - anchor);
        // The anchor advances on every pass, even when the value did not move,
        // or a memory resting on the floor would keep an ancient anchor and
        // hand the next pass an interval it has already served.
        update.run(next, input.now, input.now, row.id);
        if (Math.abs(next - row.confidence) > 1e-9) decayed += 1;
        const expendable = row.source === "agent" && row.use_count === 0;
        if (expendable && next <= MEMORY_TOMBSTONE_CONFIDENCE) {
          tombstone.run(input.now, input.now, input.now, row.id);
          tombstoned += 1;
        }
      }
      return { decayed, tombstoned };
    }).immediate();
  }

  /** Turns whose recalled memories have not yet been judged by what came next. */
  public listUnscoredRecallTurns(limit: number): { turnId: string; controllerKey: string; ordinal: number }[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
    const rows = this.db.prepare(
      `SELECT DISTINCT recall.turn_id AS turnId, turn.controller_key AS controllerKey, turn.ordinal AS ordinal
         FROM memory_recalls AS recall
         JOIN controller_turns AS turn ON turn.id = recall.turn_id
        WHERE recall.scored_at IS NULL AND turn.state IN ('completed', 'failed')
        ORDER BY recall.recalled_at ASC LIMIT ?`,
    ).all(limit) as { turnId: string; controllerKey: string; ordinal: number }[];
    return rows;
  }

  /** The owner's next message after a turn, which is how that turn is judged. */
  public getControllerTurnAfter(controllerKey: string, ordinal: number): ControllerTurnRecord | null {
    assertControllerKey(controllerKey);
    const row = this.db.prepare(
      `SELECT * FROM controller_turns
        WHERE controller_key = ? AND ordinal > ? AND origin = 'owner'
        ORDER BY ordinal ASC LIMIT 1`,
    ).get(controllerKey, ordinal) as ControllerTurnRow | undefined;
    return row ? parseControllerTurn(row) : null;
  }

  public scoreRecalledMemories(input: {
    turnId: string;
    outcome: "reinforced" | "demoted";
    now: number;
  }): number {
    if (input.outcome !== "reinforced" && input.outcome !== "demoted") {
      throw new TypeError("a recall is scored as reinforced or demoted");
    }
    assertNonNegativeInteger(input.now, "now");
    const delta = input.outcome === "reinforced" ? MEMORY_REINFORCEMENT : -MEMORY_DEMOTION;
    return this.db.transaction((): number => {
      const recalls = this.db.prepare(
        "SELECT memory_id FROM memory_recalls WHERE turn_id = ? AND scored_at IS NULL",
      ).all(input.turnId) as { memory_id: string }[];
      if (recalls.length === 0) return 0;
      const read = this.db.prepare("SELECT confidence FROM memories WHERE id = ?");
      const update = this.db.prepare(
        "UPDATE memories SET confidence = ?, updated_at = ? WHERE id = ?",
      );
      for (const recall of recalls) {
        const memory = read.get(recall.memory_id) as { confidence: number } | undefined;
        if (!memory) continue;
        update.run(adjustedConfidence(memory.confidence, delta), input.now, recall.memory_id);
      }
      this.db.prepare(
        "UPDATE memory_recalls SET scored_at = ?, outcome = ? WHERE turn_id = ? AND scored_at IS NULL",
      ).run(input.now, input.outcome, input.turnId);
      return recalls.length;
    }).immediate();
  }

  public countMemories(scope: string): number {
    assertMemoryScope(scope);
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM memories
        WHERE scope = ? AND forgotten_at IS NULL AND superseded_by IS NULL`,
    ).get(scope) as { count: number };
    return row.count;
  }

  private evictWeakestMemories(scope: string, now: number): void {
    const live = this.db.prepare(
      `SELECT id, importance, confidence, created_at FROM memories
        WHERE scope = ? AND forgotten_at IS NULL AND superseded_by IS NULL`,
    ).all(scope) as Pick<MemoryRow, "id" | "importance" | "confidence" | "created_at">[];
    if (live.length <= MAX_LIVE_MEMORIES_PER_SCOPE) return;
    const weakest = live
      .map((row) => ({
        id: row.id,
        score: memoryScore({
          lexicalRank: null,
          importance: row.importance,
          confidence: row.confidence,
          ageMs: now - row.created_at,
        }),
      }))
      .sort((left, right) => left.score - right.score)
      .slice(0, live.length - MAX_LIVE_MEMORIES_PER_SCOPE);
    const forget = this.db.prepare("UPDATE memories SET forgotten_at = ?, updated_at = ? WHERE id = ?");
    for (const candidate of weakest) forget.run(now, now, candidate.id);
  }

  private requireMemory(id: string): MemoryRecord {
    const memory = this.getMemory(id);
    if (!memory) throw new Error("stored memory disappeared before it could be read");
    return memory;
  }

  // The conversation outlives the BB thread that hosted it: a provider failure
  // retires the thread, and this digest is what re-seeds its replacement.
  public appendControllerDigest(input: {
    controllerKey: string;
    ordinal: number;
    ownerText: string;
    agentText: string;
    now: number;
  }): void {
    assertControllerKey(input.controllerKey);
    assertNonNegativeInteger(input.ordinal, "ordinal");
    assertNonNegativeInteger(input.now, "now");
    this.db.transaction(() => this.appendControllerDigestRow(input)).immediate();
  }

  private appendControllerDigestRow(input: {
    controllerKey: string;
    ordinal: number;
    ownerText: string;
    agentText: string;
    now: number;
  }): void {
    {
      this.db.prepare(
        `INSERT INTO controller_digest (controller_key, ordinal, owner_text, agent_text, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (controller_key, ordinal) DO UPDATE
           SET owner_text = excluded.owner_text, agent_text = excluded.agent_text`,
      ).run(
        input.controllerKey,
        input.ordinal,
        input.ownerText.slice(0, MAX_DIGEST_TEXT),
        input.agentText.slice(0, MAX_DIGEST_TEXT),
        input.now,
      );
      this.db.prepare(
        `DELETE FROM controller_digest
          WHERE controller_key = ? AND ordinal <= (
            SELECT MAX(ordinal) - ? FROM controller_digest WHERE controller_key = ?
          )`,
      ).run(input.controllerKey, MAX_DIGEST_TURNS, input.controllerKey);
    }
  }

  public readControllerDigest(
    controllerKey: string,
    limit: number,
  ): { ownerText: string; agentText: string }[] {
    assertControllerKey(controllerKey);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DIGEST_TURNS) {
      throw new TypeError(`limit must be between 1 and ${MAX_DIGEST_TURNS}`);
    }
    const rows = this.db.prepare(
      `SELECT owner_text, agent_text FROM controller_digest
        WHERE controller_key = ? ORDER BY ordinal DESC LIMIT ?`,
    ).all(controllerKey, limit) as { owner_text: string; agent_text: string }[];
    return rows
      .reverse()
      .map((row) => ({ ownerText: row.owner_text, agentText: row.agent_text }));
  }

  public createThreadOperation(input: {
    id: string;
    nonceHash: string;
    ownerUserId: string;
    ownerChatId: string;
    kind: ThreadOperationKind;
    threadId: string;
    text: string | null;
    expiresAt: number;
    now: number;
  }): ThreadOperation {
    assertControllerIdentifier(input.id, "operation id");
    if (!SHA256_HEX.test(input.nonceHash)) throw new TypeError("operation nonce hash must be SHA-256 hex");
    assertCanonicalPositiveDecimal(input.ownerUserId, "ownerUserId");
    assertCanonicalPositiveDecimal(input.ownerChatId, "ownerChatId");
    if (!THREAD_OPERATION_KINDS.has(input.kind)) throw new TypeError("thread operation kind is invalid");
    assertControllerIdentifier(input.threadId, "threadId");
    if (input.kind === "steer_thread") assertControllerText(input.text ?? "", "operation text");
    if (input.kind !== "steer_thread" && input.text !== null) throw new TypeError("only steer operations accept text");
    assertNonNegativeInteger(input.now, "now");
    if (!Number.isInteger(input.expiresAt) || input.expiresAt <= input.now) {
      throw new TypeError("operation expiry must be after creation");
    }
    const inserted = this.db.prepare(
      `INSERT INTO thread_operations (
         id, nonce_hash, owner_user_id, owner_chat_id, kind, thread_id, operation_text,
         state, expires_at, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, 'confirmation_sending', ?, ?, ?
         FROM owners
        WHERE singleton = 1 AND revoked_at IS NULL
          AND telegram_user_id = ? AND telegram_chat_id = ?`,
    ).run(
      input.id,
      input.nonceHash,
      input.ownerUserId,
      input.ownerChatId,
      input.kind,
      input.threadId,
      input.text,
      input.expiresAt,
      input.now,
      input.now,
      input.ownerUserId,
      input.ownerChatId,
    );
    if (inserted.changes !== 1) throw new Error("Thread operation requires the current paired owner");
    return this.getThreadOperation(input.id)!;
  }

  public markThreadOperationConfirmationSent(id: string, messageId: number, now: number): ThreadOperation {
    assertControllerIdentifier(id, "operation id");
    assertPositiveInteger(messageId, "messageId");
    assertNonNegativeInteger(now, "now");
    const updated = this.db.prepare(
      `UPDATE thread_operations
          SET state = 'awaiting_confirmation', confirmation_message_id = ?, updated_at = ?
        WHERE id = ? AND state = 'confirmation_sending' AND expires_at > ?`,
    ).run(messageId, now, id, now);
    if (updated.changes !== 1) throw new Error("Thread operation confirmation changed before delivery was recorded");
    return this.getThreadOperation(id)!;
  }

  public failThreadOperationConfirmation(id: string, now: number): boolean {
    assertControllerIdentifier(id, "operation id");
    assertNonNegativeInteger(now, "now");
    return this.db.prepare(
      `UPDATE thread_operations
          SET state = 'failed', last_error = 'Confirmation delivery outcome is uncertain', updated_at = ?
        WHERE id = ? AND state = 'confirmation_sending'`,
    ).run(now, id).changes === 1;
  }

  public confirmThreadOperation(input: {
    nonceHash: string;
    userId: string;
    chatId: string;
    messageId: number;
    now: number;
  }): ThreadOperationConfirmResult {
    if (!SHA256_HEX.test(input.nonceHash)) throw new TypeError("operation nonce hash must be SHA-256 hex");
    assertCanonicalPositiveDecimal(input.userId, "userId");
    assertCanonicalPositiveDecimal(input.chatId, "chatId");
    assertPositiveInteger(input.messageId, "messageId");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): ThreadOperationConfirmResult => {
      const owner = this.db.prepare(
        `SELECT 1 FROM owners WHERE singleton = 1 AND revoked_at IS NULL
          AND telegram_user_id = ? AND telegram_chat_id = ?`,
      ).get(input.userId, input.chatId);
      if (!owner) return { ok: false, reason: "missing" };
      const row = this.db.prepare("SELECT * FROM thread_operations WHERE nonce_hash = ?")
        .get(input.nonceHash) as ThreadOperationRow | undefined;
      if (!row || row.owner_user_id !== input.userId || row.owner_chat_id !== input.chatId ||
        row.confirmation_message_id !== input.messageId) return { ok: false, reason: "missing" };
      if (row.state !== "awaiting_confirmation") return { ok: false, reason: "consumed" };
      if (row.expires_at <= input.now) {
        this.db.prepare(
          "UPDATE thread_operations SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'awaiting_confirmation'",
        ).run(input.now, row.id);
        return { ok: false, reason: "expired" };
      }
      const updated = this.db.prepare(
        `UPDATE thread_operations SET state = 'confirmed', confirmed_at = ?, updated_at = ?
          WHERE id = ? AND state = 'awaiting_confirmation'`,
      ).run(input.now, input.now, row.id);
      if (updated.changes !== 1) return { ok: false, reason: "consumed" };
      return { ok: true, operation: this.getThreadOperation(row.id)! };
    }).immediate();
  }

  public getThreadOperation(id: string): ThreadOperation | null {
    assertControllerIdentifier(id, "operation id");
    const row = this.db.prepare("SELECT * FROM thread_operations WHERE id = ?")
      .get(id) as ThreadOperationRow | undefined;
    return row ? parseThreadOperation(row) : null;
  }

  public failStaleThreadOperations(fence: ControllerLeaseFence): boolean {
    if (!fence.ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(fence.generation, "generation");
    assertNonNegativeInteger(fence.now, "now");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(fence.ownerId, fence.generation, fence.now)) return false;
      const expired = this.db.prepare(
        `UPDATE thread_operations SET state = 'expired', updated_at = ?
          WHERE state IN ('awaiting_confirmation', 'confirmed') AND expires_at <= ?`,
      ).run(fence.now, fence.now).changes;
      const uncertain = this.db.prepare(
        `UPDATE thread_operations
            SET state = 'failed', last_error = 'Thread operation outcome is uncertain',
                lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE state = 'executing' AND lease_expires_at <= ?`,
      ).run(fence.now, fence.now).changes;
      return expired + uncertain > 0;
    }).immediate();
  }

  public claimNextThreadOperation(
    fence: ControllerLeaseFence & { leaseMs?: number },
  ): ThreadOperation | null {
    const leaseMs = fence.leaseMs ?? 30_000;
    if (!fence.ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(fence.generation, "generation");
    assertNonNegativeInteger(fence.now, "now");
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new TypeError("leaseMs must be between 1000 and 300000");
    }
    return this.db.transaction((): ThreadOperation | null => {
      if (!this.executorLeaseIsCurrent(fence.ownerId, fence.generation, fence.now)) return null;
      const candidate = this.db.prepare(
        `SELECT * FROM thread_operations
          WHERE state = 'confirmed' AND expires_at > ? ORDER BY created_at, id LIMIT 1`,
      ).get(fence.now) as ThreadOperationRow | undefined;
      if (!candidate) return null;
      const updated = this.db.prepare(
        `UPDATE thread_operations
            SET state = 'executing', lease_owner = ?, lease_generation = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND state = 'confirmed'`,
      ).run(fence.ownerId, fence.generation, fence.now + leaseMs, fence.now, candidate.id);
      if (updated.changes !== 1) return null;
      return this.getThreadOperation(candidate.id);
    }).immediate();
  }

  public completeThreadOperation(input: ControllerLeaseFence & { id: string; result: string }): boolean {
    assertControllerIdentifier(input.id, "operation id");
    assertControllerText(input.result, "operation result");
    return this.finishThreadOperation(input, "completed", input.result);
  }

  public failThreadOperation(input: ControllerLeaseFence & { id: string; error: string }): boolean {
    assertControllerIdentifier(input.id, "operation id");
    assertSafeFailureSummary(input.error);
    return this.finishThreadOperation(input, "failed", input.error);
  }

  private finishThreadOperation(
    input: ControllerLeaseFence & { id: string },
    state: "completed" | "failed",
    summary: string,
  ): boolean {
    if (!input.ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    const resultColumn = state === "completed" ? "result" : "last_error";
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const updated = this.db.prepare(
        `UPDATE thread_operations
            SET state = ?, ${resultColumn} = ?, lease_owner = NULL, lease_generation = NULL,
                lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'executing' AND lease_owner = ? AND lease_generation = ?
            AND lease_expires_at > ?`,
      ).run(state, summary, input.now, input.id, input.ownerId, input.generation, input.now);
      if (updated.changes !== 1) return false;
      const operation = this.getThreadOperation(input.id);
      if (!operation?.confirmationMessageId) {
        throw new Error("Completed thread operation has no confirmation message");
      }
      const outbox: OutboxInput = {
        logicalKey: `thread-operation:${operation.id}:status`,
        chatId: operation.ownerChatId,
        messageId: operation.confirmationMessageId,
        payload: {
          text: state === "completed" ? `Thread operation completed: ${summary}.` : "Thread operation failed safely.",
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [] },
        },
      };
      persistOutbox(this.db, outbox, serializeOutbox(outbox, input.now), input.now);
      return true;
    }).immediate();
  }

  public bindTelegramIdentity(input: {
    botId: string;
    username: string;
    now: number;
    hasActiveJob: boolean;
  }): "created" | "same" | "identity_mismatch" | "active_job_conflict" {
    assertCanonicalPositiveDecimal(input.botId, "botId");

    const bind = this.db.transaction((): "created" | "same" | "identity_mismatch" | "active_job_conflict" => {
      const current = this.db
        .prepare(
          "SELECT bot_id, username, verified_at FROM telegram_identity WHERE singleton = 1",
        )
        .get() as TelegramIdentityRow | undefined;

      if (!current) {
        if (input.hasActiveJob || this.hasUnreleasedAdmissions()) return "active_job_conflict";
        this.db
          .prepare(
            "INSERT INTO telegram_identity (singleton, bot_id, username, verified_at) VALUES (1, ?, ?, ?)",
          )
          .run(input.botId, input.username, input.now);
        return "created";
      }

      if (current.bot_id === input.botId) {
        this.db
          .prepare(
            "UPDATE telegram_identity SET username = ?, verified_at = ? WHERE singleton = 1",
          )
          .run(input.username, input.now);
        return "same";
      }

      if (input.hasActiveJob || this.hasUnreleasedAdmissions()) return "active_job_conflict";
      return "identity_mismatch";
    });
    return bind();
  }

  public hasUnreleasedAdmissions(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM job_admissions WHERE state IN ('queued', 'admitted', 'draining') LIMIT 1",
        )
        .get() !== undefined
    );
  }

  private revokeControllerAccess(now: number): void {
    this.db.prepare(
      `UPDATE controller_turns
          SET state = 'failed', last_error = 'Controller owner was revoked',
              completed_at = ?, updated_at = ?
        WHERE state IN ('queued', 'dispatching', 'submitted')`,
    ).run(now, now);
    this.db.prepare(
      `UPDATE controller_threads
          SET project_id = NULL, host_id = NULL, bb_thread_id = NULL,
              state = 'revoked', pending_spawn_token = NULL,
              capability_subject_id = NULL, capability_profile_id = NULL,
              capability_profile_revision = 0,
              last_error = 'Controller owner was revoked', updated_at = ?
        WHERE state <> 'revoked'`,
    ).run(now);
    this.db.prepare(
      `UPDATE thread_operations
          SET state = 'failed', last_error = 'Controller owner was revoked',
              lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL,
              updated_at = ?
        WHERE state IN ('confirmation_sending', 'awaiting_confirmation', 'confirmed', 'executing')`,
    ).run(now);
  }

  public getTelegramIdentity(): TelegramIdentity | null {
    const row = this.db
      .prepare(
        "SELECT bot_id, username, verified_at FROM telegram_identity WHERE singleton = 1",
      )
      .get() as TelegramIdentityRow | undefined;
    if (!row) return null;
    return {
      botId: row.bot_id,
      username: row.username,
      verifiedAt: row.verified_at,
    };
  }

  public upsertProjectPolicy(
    policy: ProjectPolicy,
    now: number,
  ): ProjectPolicyRecord {
    const validated = projectPolicySchema.parse(policy);
    this.db
      .prepare(
        `INSERT INTO project_policies (
           project_id, alias, enabled, policy_json, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           alias = excluded.alias,
           enabled = excluded.enabled,
           policy_json = excluded.policy_json,
           version = project_policies.version + 1,
           updated_at = excluded.updated_at`,
      )
      .run(
        validated.projectId,
        validated.alias,
        validated.enabled ? 1 : 0,
        JSON.stringify(validated),
        now,
        now,
      );

    const stored = this.getProjectPolicy(validated.projectId);
    if (!stored) throw new Error("Project policy was not stored");
    return stored;
  }

  public getProjectPolicy(projectId: string): ProjectPolicyRecord | null {
    const row = this.db
      .prepare(
        "SELECT policy_json, version FROM project_policies WHERE project_id = ?",
      )
      .get(projectId) as ProjectPolicyRow | undefined;
    return row ? parsePolicy(row) : null;
  }

  public getProjectPolicyByAlias(alias: string): ProjectPolicyRecord | null {
    const row = this.db
      .prepare(
        "SELECT policy_json, version FROM project_policies WHERE alias = ?",
      )
      .get(alias) as ProjectPolicyRow | undefined;
    return row ? parsePolicy(row) : null;
  }

  public listEnabledProjectPolicies(): ProjectPolicyRecord[] {
    const rows = this.db
      .prepare(
        "SELECT policy_json, version FROM project_policies WHERE enabled = 1 ORDER BY alias",
      )
      .all() as ProjectPolicyRow[];
    return rows.map(parsePolicy);
  }

  public createConfirmedControllerJob(input: {
    controllerThreadId: string;
    projectId: string;
    task: string;
    now: number;
    path?: "full" | "small_fix";
  }): Job {
    assertControllerIdentifier(input.controllerThreadId, "controllerThreadId");
    assertControllerIdentifier(input.projectId, "projectId");
    assertControllerText(input.task, "task");
    assertNonNegativeInteger(input.now, "now");

    return this.db.transaction((): Job => {
      const turn = this.db.prepare(
        `SELECT turn.* FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE controller.bb_thread_id = ? AND controller.state = 'active'
            AND turn.state = 'submitted'
          ORDER BY turn.ordinal ASC LIMIT 1`,
      ).get(input.controllerThreadId) as ControllerTurnRow | undefined;
      if (!turn) throw new TypeError("Controller thread has no authorized submitted turn");

      const existing = this.readJobBySourceUpdate(turn.telegram_update_id);
      if (existing) {
        if (existing.requestText !== input.task || existing.projectId !== input.projectId) {
          throw new IdempotencyConflictError(turn.telegram_update_id);
        }
        return existing;
      }

      const policyRecord = this.getProjectPolicy(input.projectId);
      if (!policyRecord?.policy.enabled) throw new TypeError("Selected project is not enabled");

      const jobId = createHash("sha256")
        .update(`controller-job:${turn.controller_key}:${turn.telegram_update_id}`, "utf8")
        .digest("base64url")
        .slice(0, 22);
      const routing = classifyTaskTraits({ origin: "requested", text: input.task });
      const deliveryMode = routing.recipe === "direct" ? "small_fix" : "full";
      const dispatchSettings = this.capabilityDispatchSettings();
      const routingMode = routingModeForNewAttempt(
        routing.recipe,
        dispatchSettings.jobGraph,
        this.capabilityRepository.getLatestRecipeRolloutDecision(routing.recipe),
      );
      this.db.prepare(
        `INSERT INTO jobs (
           id, source_update_id, request_text, state, delivery_mode, task_recipe,
           recipe_version, recipe_promotion_count, routing_mode, task_traits_json,
           task_reason_codes_json, review_cycle, review_block_at, version, created_at, updated_at
         ) VALUES (?, ?, ?, 'awaiting_project', ?, ?, 1, 0, ?, ?, ?, 0, 3, 1, ?, ?)`,
      ).run(
        jobId,
        turn.telegram_update_id,
        input.task,
        deliveryMode,
        routing.recipe,
        routingMode,
        JSON.stringify(routing.traits),
        JSON.stringify(routing.reasonCodes),
        input.now,
        input.now,
      );
      const created = this.readJobById(jobId);
      if (!created) throw new Error("Controller job was not stored");

      const selected = transition(created, {
        type: "PROJECT_SELECTED",
        projectId: policyRecord.policy.projectId,
        policyVersion: policyRecord.version,
        policy: policyRecord.policy,
      }, input.now);
      persistJobTransition(this.db, jobId, created.version, selected.job);
      persistPendingEffects(this.db, selected.effects, input.now);
      queueAdmissionInTransaction(this.db, {
        jobId,
        expectedVersion: selected.job.version,
        projectId: policyRecord.policy.projectId,
        resumeEvent: "CONFIRMED",
        now: input.now,
      });
      return selected.job;
    }).immediate();
  }

  public createAdoptedControllerJob(input: {
    controllerThreadId: string;
    projectId: string;
    task: string;
    prNumber: number;
    prUrl: string;
    headSha: string;
    branchName: string;
    now: number;
  }): Job {
    assertControllerIdentifier(input.controllerThreadId, "controllerThreadId");
    assertControllerIdentifier(input.projectId, "projectId");
    assertControllerText(input.task, "task");
    assertPositiveInteger(input.prNumber, "prNumber");
    assertFullSha(input.headSha, "headSha");
    assertNonNegativeInteger(input.now, "now");
    if (!/^telegram-agent\/adopt-pr-[1-9][0-9]*-[0-9a-f]{12}$/u.test(input.branchName)) {
      throw new TypeError("Adopted branch identity is invalid");
    }
    const safeUrl = assertSafeExternalHttpsUrl(input.prUrl, "prUrl");

    return this.db.transaction((): Job => {
      const turn = this.db.prepare(
        `SELECT turn.* FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE controller.bb_thread_id = ? AND controller.state = 'active'
            AND turn.state = 'submitted'
          ORDER BY turn.ordinal ASC LIMIT 1`,
      ).get(input.controllerThreadId) as ControllerTurnRow | undefined;
      if (!turn) throw new TypeError("Controller thread has no authorized submitted turn");

      const existing = this.readJobBySourceUpdate(turn.telegram_update_id);
      if (existing) {
        if (
          existing.requestText !== input.task || existing.projectId !== input.projectId ||
          existing.origin !== "adopted_pr" || existing.prNumber !== input.prNumber ||
          existing.adoptedHeadSha !== input.headSha || existing.adoptedBranch !== input.branchName
        ) throw new IdempotencyConflictError(turn.telegram_update_id);
        return existing;
      }

      const policyRecord = this.getProjectPolicy(input.projectId);
      if (!policyRecord?.policy.enabled) throw new TypeError("Selected project is not enabled");
      const expectedPath = `/${policyRecord.policy.githubRepository}/pull/${String(input.prNumber)}`.toLowerCase();
      const parsedUrl = new URL(safeUrl);
      if (
        parsedUrl.hostname.toLowerCase() !== "github.com" ||
        parsedUrl.pathname.replace(/\/$/u, "").toLowerCase() !== expectedPath
      ) throw new TypeError("Pull-request URL does not match the selected project and number");

      const jobId = createHash("sha256")
        .update(`controller-adopted-job:${turn.controller_key}:${turn.telegram_update_id}`, "utf8")
        .digest("base64url")
        .slice(0, 22);
      const routing = classifyTaskTraits({ origin: "adopted_pr", text: input.task });
      const dispatchSettings = this.capabilityDispatchSettings();
      const routingMode = routingModeForNewAttempt(
        routing.recipe,
        dispatchSettings.jobGraph,
        this.capabilityRepository.getLatestRecipeRolloutDecision(routing.recipe),
      );
      this.db.prepare(
        `INSERT INTO jobs (
           id, source_update_id, request_text, state, delivery_mode, job_origin,
           adopted_branch, adopted_head_sha, pr_number, pr_url, pr_head_sha,
           task_recipe, recipe_version, recipe_promotion_count, routing_mode,
           task_traits_json, task_reason_codes_json,
           review_cycle, review_block_at, version, created_at, updated_at
         ) VALUES (?, ?, ?, 'awaiting_project', 'full', 'adopted_pr', ?, ?, ?, ?, ?,
                   ?, 1, 0, ?, ?, ?, 0, 3, 1, ?, ?)`,
      ).run(
        jobId,
        turn.telegram_update_id,
        input.task,
        input.branchName,
        input.headSha,
        input.prNumber,
        safeUrl,
        input.headSha,
        routing.recipe,
        routingMode,
        JSON.stringify(routing.traits),
        JSON.stringify(routing.reasonCodes),
        input.now,
        input.now,
      );
      const created = this.readJobById(jobId);
      if (!created) throw new Error("Adopted controller job was not stored");

      const selected = transition(created, {
        type: "PROJECT_SELECTED",
        projectId: policyRecord.policy.projectId,
        policyVersion: policyRecord.version,
        policy: policyRecord.policy,
      }, input.now);
      persistJobTransition(this.db, jobId, created.version, selected.job);
      persistPendingEffects(this.db, selected.effects, input.now);

      const skippedText = "Skipped because this job adopted an existing pull request.\n";
      const outputSha = createHash("sha256").update(skippedText, "utf8").digest("hex");
      const inputSha = createHash("sha256").update(`${input.task}\0${input.headSha}`, "utf8").digest("hex");
      const outcome = JSON.stringify({ disposition: "skipped", reason: "existing_pull_request" });
      const insertSkipped = this.db.prepare(
        `INSERT INTO pipeline_stage_attempts (
           id, job_id, role, ordinal, state, input_sha256, output_text, output_sha256,
           outcome_json, start_sha, end_sha, created_at, completed_at, updated_at
         ) VALUES (?, ?, ?, 1, 'skipped', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const role of ["PLAN", "CRITIQUE"] as const) {
        insertSkipped.run(
          `stage:${jobId}:adopted:${role.toLowerCase()}`,
          jobId,
          role,
          inputSha,
          skippedText,
          outputSha,
          outcome,
          input.headSha,
          input.headSha,
          input.now,
          input.now,
          input.now,
        );
      }
      queueAdmissionInTransaction(this.db, {
        jobId,
        expectedVersion: selected.job.version,
        projectId: policyRecord.policy.projectId,
        resumeEvent: "CONFIRMED",
        now: input.now,
      });
      return selected.job;
    }).immediate();
  }

  public getJobBySourceUpdateId(sourceUpdateId: number): Job | null {
    assertNonNegativeInteger(sourceUpdateId, "sourceUpdateId");
    return this.readJobBySourceUpdate(sourceUpdateId);
  }

  public selectProjectAndQueueAdmission(input: {
    jobId: string;
    expectedVersion: number;
    projectId: string;
    policyVersion: number;
    policy: ProjectPolicy;
    now: number;
  }): Job {
    if (!input.jobId) throw new TypeError("jobId must not be empty");
    assertPositiveInteger(input.expectedVersion, "expectedVersion");
    assertControllerIdentifier(input.projectId, "projectId");
    assertPositiveInteger(input.policyVersion, "policyVersion");
    assertNonNegativeInteger(input.now, "now");

    const select = this.db.transaction((): Job => {
      const current = this.readJobById(input.jobId);
      if (!current) throw new Error(`Job ${input.jobId} was not found`);
      if (current.version !== input.expectedVersion) throw new VersionConflictError(input.jobId, input.expectedVersion);

      let selected = current;
      if (current.state === "awaiting_project") {
        const transitioned = transition(current, {
          type: "PROJECT_SELECTED",
          projectId: input.projectId,
          policyVersion: input.policyVersion,
          policy: input.policy,
        }, input.now);
        persistJobTransition(this.db, input.jobId, current.version, transitioned.job);
        persistPendingEffects(this.db, transitioned.effects, input.now);
        selected = transitioned.job;
      } else if (
        current.state !== "awaiting_confirmation" ||
        current.projectId !== input.projectId ||
        current.policyVersion !== input.policyVersion ||
        current.policy?.projectId !== input.projectId
      ) {
        throw new AutonomyAdmissionConflictError(input.jobId, "project selection is no longer current");
      }

      queueAdmissionInTransaction(this.db, {
        jobId: input.jobId,
        expectedVersion: selected.version,
        projectId: input.projectId,
        resumeEvent: "CONFIRMED",
        now: input.now,
      });
      return selected;
    });
    return select.immediate();
  }

  public createJob(input: {
    id: string;
    sourceUpdateId: number;
    requestText: string;
    now: number;
  }): Job {
    if (!input.id || !input.requestText) throw new TypeError("Job id and request text are required");
    if (!Number.isInteger(input.sourceUpdateId) || input.sourceUpdateId < 0) {
      throw new TypeError("sourceUpdateId must be a non-negative integer");
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (
           id, source_update_id, request_text, state, review_cycle,
           review_block_at, version, created_at, updated_at
         ) VALUES (?, ?, ?, 'awaiting_project', 0, 3, 1, ?, ?)`,
      )
      .run(input.id, input.sourceUpdateId, input.requestText, input.now, input.now);

    const byId = this.readJobById(input.id);
    const existing = byId ?? this.readJobBySourceUpdate(input.sourceUpdateId);
    if (!existing) throw new Error("Job was not stored");
    if (
      existing.sourceUpdateId !== input.sourceUpdateId ||
      existing.requestText !== input.requestText
    ) {
      throw new IdempotencyConflictError(input.sourceUpdateId);
    }
    return existing;
  }

  public setJobStatusMessage(
    jobId: string,
    messageId: number,
    expectedVersion: number,
    now: number,
  ): Job {
    if (!jobId) throw new TypeError("jobId must not be empty");
    if (!Number.isInteger(messageId) || messageId < 1) {
      throw new TypeError("messageId must be a positive integer");
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("expectedVersion must be a positive integer");
    }
    const current = this.readJobById(jobId);
    if (!current) throw new Error(`Job ${jobId} was not found`);
    if (current.version !== expectedVersion) throw new VersionConflictError(jobId, expectedVersion);

    const updated = this.db
      .prepare(
        `UPDATE jobs
            SET status_message_id = ?, version = ?, updated_at = ?
          WHERE id = ? AND version = ?`,
      )
      .run(messageId, expectedVersion + 1, now, jobId, expectedVersion);
    if (updated.changes !== 1) throw new VersionConflictError(jobId, expectedVersion);
    const stored = this.readJobById(jobId);
    if (!stored) throw new Error(`Job ${jobId} was not found after status-message update`);
    return stored;
  }

  public setJobStatusMessageAndOutbox(
    jobId: string,
    messageId: number,
    expectedVersion: number,
    outbox: OutboxInput,
    now: number,
  ): Job {
    if (!jobId) throw new TypeError("jobId must not be empty");
    if (!Number.isInteger(messageId) || messageId < 1) {
      throw new TypeError("messageId must be a positive integer");
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("expectedVersion must be a positive integer");
    }
    if (outbox.messageId !== messageId) {
      throw new TypeError("outbox messageId must match status message");
    }
    const payloadJson = serializeOutbox(outbox, now);

    const persist = this.db.transaction((): Job => {
      const current = this.readJobById(jobId);
      if (!current) throw new Error(`Job ${jobId} was not found`);
      if (current.version !== expectedVersion) throw new VersionConflictError(jobId, expectedVersion);

      const updated = this.db
        .prepare(
          `UPDATE jobs
              SET status_message_id = ?, version = ?, updated_at = ?
            WHERE id = ? AND version = ?`,
        )
        .run(messageId, expectedVersion + 1, now, jobId, expectedVersion);
      if (updated.changes !== 1) throw new VersionConflictError(jobId, expectedVersion);

      persistOutbox(this.db, outbox, payloadJson, now);
      const stored = this.readJobById(jobId);
      if (!stored) throw new Error(`Job ${jobId} was not found after status-message update`);
      return stored;
    });
    return persist();
  }

  public enqueueSteeringEffect(
    jobId: string,
    updateId: number,
    threadId: string,
    text: string,
    now: number,
  ): boolean {
    if (!jobId || !threadId) throw new TypeError("jobId and threadId must not be empty");
    if (!Number.isInteger(updateId) || updateId < 0) {
      throw new TypeError("updateId must be a non-negative integer");
    }
    if (typeof text !== "string" || text.length === 0 || text.length > 4_000) {
      throw new TypeError("steering text must be between 1 and 4000 characters");
    }

    const enqueue = this.db.transaction((): boolean => {
      const job = this.readJobById(jobId);
      if (!job || job.implementationThreadId !== threadId || ["merged", "cancelled", "blocked", "complete", "production_failed"].includes(job.state)) {
        return false;
      }
      const steeringPayloadJson = serializeBoundedJson({ text, threadId }, "steering effect payload", 64_000);
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO effects (
             idempotency_key, job_id, kind, payload_json, status, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, 'steer_implementation', ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(
          `${jobId}:telegram:${updateId}:steer_implementation`,
          jobId,
          steeringPayloadJson,
          now,
          now,
          now,
        );
      return result.changes === 1;
    });
    return enqueue();
  }

  public enqueueOutbox(item: OutboxInput, now: number): void {
    const payloadJson = serializeOutbox(item, now);
    persistOutbox(this.db, item, payloadJson, now);
  }

  public async setLastProject(projectId: string): Promise<void> {
    if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 200) {
      throw new TypeError("projectId must be a bounded non-empty string");
    }
    await this.kv.set(LAST_PROJECT_KEY, projectId);
  }

  public async getLastProject(): Promise<string | null> {
    const value = await this.kv.get<unknown>(LAST_PROJECT_KEY);
    return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
  }

  public getJob(jobId: string): Job | null {
    return this.readJobById(jobId);
  }

  public getActiveJob(): Job | null {
    const row = this.db
      .prepare(`${JOB_SELECT} WHERE state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed') ORDER BY updated_at DESC, id DESC LIMIT 1`)
      .get() as JobRow | undefined;
    return row ? parseJob(row) : null;
  }

  public findJobByThreadId(threadId: string): Job | null {
    const row = this.db
      .prepare(`${JOB_SELECT} WHERE implementation_thread_id = ? OR review_thread_id = ?
        OR id IN (SELECT job_id FROM pipeline_stage_attempts WHERE thread_id = ?)
        ORDER BY updated_at DESC LIMIT 1`)
      .get(threadId, threadId, threadId) as JobRow | undefined;
    return row ? parseJob(row) : null;
  }

  public listJobs(limit: number): Job[] {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
    const rows = this.db
      .prepare(`${JOB_SELECT} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(Math.min(limit, MAX_AUTONOMY_ROWS)) as JobRow[];
    return rows.map(parseJob);
  }

  public findOpenJobByProjectAndTask(projectId: string, task: string): Job | null {
    assertControllerIdentifier(projectId, "projectId");
    assertControllerText(task, "task");
    const row = this.db
      .prepare(
        `${JOB_SELECT}
          WHERE project_id = ?
            AND request_text = ?
            AND state NOT IN ('merged', 'cancelled', 'complete', 'production_failed')
          ORDER BY updated_at DESC, id DESC
          LIMIT 1`,
      )
      .get(projectId, task) as JobRow | undefined;
    return row ? parseJob(row) : null;
  }

  public findOpenJobByProject(projectId: string): Job | null {
    assertControllerIdentifier(projectId, "projectId");
    const row = this.db
      .prepare(
        `${JOB_SELECT}
          WHERE project_id = ?
            AND state NOT IN ('merged', 'cancelled', 'complete', 'production_failed')
          ORDER BY updated_at DESC, id DESC
          LIMIT 1`,
      )
      .get(projectId) as JobRow | undefined;
    return row ? parseJob(row) : null;
  }

  public listLegacyActiveJobs(limit: number): Job[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be a positive safe integer");
    const rows = this.db
      .prepare(
        `${JOB_SELECT}
          WHERE state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed')
            AND NOT EXISTS (SELECT 1 FROM job_admissions WHERE job_id = jobs.id)
          ORDER BY updated_at ASC, id ASC
          LIMIT ?`,
      )
      .all(Math.min(limit, MAX_AUTONOMY_ROWS)) as JobRow[];
    return rows.map(parseJob);
  }

  public listControlJobs(kind: JobControlKind, limit: number): Job[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be a positive safe integer");
    const predicate = this.controlJobPredicate(kind);
    const admissionStates = this.controlAdmissionStatesSql(kind);
    const rows = this.db
      .prepare(
        `SELECT job.*
           FROM (${JOB_SELECT}) AS job
           JOIN job_admissions AS admission ON admission.job_id = job.id
          WHERE admission.state IN ${admissionStates} AND ${predicate}
          ORDER BY admission.queue_seq ASC, admission.job_id ASC
          LIMIT ?`,
      )
      .all(Math.min(limit, MAX_AUTONOMY_ROWS)) as JobRow[];
    return rows.map(parseJob);
  }

  public countControlJobs(kind: JobControlKind): number {
    const predicate = this.controlJobPredicate(kind);
    const admissionStates = this.controlAdmissionStatesSql(kind);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM jobs AS job
           JOIN job_admissions AS admission ON admission.job_id = job.id
          WHERE admission.state IN ${admissionStates} AND ${predicate}`,
      )
      .get() as { count: number };
    return row.count;
  }

  private controlJobPredicate(kind: JobControlKind): string {
    if (kind === "status") return "1 = 1";
    if (kind === "retry") {
      return `(job.cancel_requested_at IS NULL AND (
        job.state = 'failed'
        OR (job.state = 'blocked' AND job.blocked_reason IN ('review_limit', 'plan_limit', 'permanent_effect_failure'))
        OR (job.state = 'blocked' AND job.blocked_reason = 'configuration'
            AND job.pr_number IS NOT NULL
            AND job.last_error = '${PRODUCTION_NOT_CONFIGURED}')
      ))`;
    }
    if (kind === "cancel") {
      return "job.state NOT IN ('merged', 'cancelled', 'complete', 'production_failed') AND job.cancel_requested_at IS NULL";
    }
    throw new TypeError("unknown job control kind");
  }

  private controlAdmissionStatesSql(kind: JobControlKind): string {
    return kind === "retry" || kind === "cancel"
      ? "('queued', 'admitted', 'draining', 'released')"
      : "('queued', 'admitted', 'draining')";
  }

  public getAdmission(jobId: string): JobAdmission | null {
    return this.autonomyRepository.getAdmission(jobId);
  }

  public queueAdmission(input: AdmissionWriteInput): JobAdmission {
    return this.autonomyRepository.queueAdmission(input);
  }

  public requeueAdmission(input: AdmissionWriteInput): JobAdmission {
    return this.autonomyRepository.requeueAdmission(input);
  }

  public requeueReviewAdmission(jobId: string, expectedVersion: number, now: number): ReviewAdmissionResult {
    if (!jobId) throw new TypeError("jobId must not be empty");
    assertPositiveInteger(expectedVersion, "expectedVersion");
    assertNonNegativeInteger(now, "now");

    const job = this.readJobById(jobId);
    const admission = this.autonomyRepository.getAdmission(jobId);
    if (!job || job.version !== expectedVersion || job.state !== "blocked" ||
      (job.blockedReason !== "review_limit" && job.blockedReason !== "plan_limit" &&
        !isReviewedPrCompletionBlock(job)) || !admission) {
      return { outcome: "unavailable" };
    }
    if (job.projectId !== admission.projectId || job.policy?.projectId !== admission.projectId) {
      return { outcome: "unavailable" };
    }
    if (admission.state === "draining") return { outcome: "still_cleaning_up", admission };
    if (admission.state === "queued") {
      return admission.resumeEvent === "CONTINUE_REVIEW"
        ? { outcome: "queued", admission }
        : { outcome: "unavailable" };
    }
    if (admission.state !== "released") return { outcome: "unavailable" };

    try {
      return {
        outcome: "queued",
        admission: this.autonomyRepository.requeueAdmission({
          jobId,
          expectedVersion,
          projectId: admission.projectId,
          resumeEvent: "CONTINUE_REVIEW",
          now,
        }),
      };
    } catch (error) {
      if (error instanceof AutonomyAdmissionConflictError) return { outcome: "unavailable" };
      throw error;
    }
  }

  public retryFailedJob(jobId: string, expectedVersion: number, now: number): RetryJobResult {
    if (!jobId) throw new TypeError("jobId must not be empty");
    assertPositiveInteger(expectedVersion, "expectedVersion");
    assertNonNegativeInteger(now, "now");

    const retry = this.db.transaction((): RetryJobResult => {
      const job = this.readJobById(jobId);
      const admission = this.autonomyRepository.getAdmission(jobId);
      if (!job || job.version !== expectedVersion || job.cancelRequestedAt !== null || !admission ||
        !(job.state === "failed" && job.resumeState !== null || isResumablePermanentFailure(job))) {
        return { outcome: "unavailable" };
      }
      if (job.projectId !== admission.projectId || job.policy?.projectId !== admission.projectId) {
        return { outcome: "unavailable" };
      }
      if (admission.state === "queued") {
        if (admission.resumeEvent !== "RETRY") return { outcome: "unavailable" };
        this.markOwnerRecoveryRequeuedInTransaction(job.id, now);
        return { outcome: "queued", job, admission };
      }
      if (admission.state === "released") {
        const queued = queueAdmissionInTransaction(this.db, {
          jobId,
          expectedVersion,
          projectId: admission.projectId,
          resumeEvent: "RETRY",
          now,
        }, "requeue");
        this.markOwnerRecoveryRequeuedInTransaction(job.id, now);
        return { outcome: "queued", job, admission: queued };
      }
      if (admission.state !== "admitted") return { outcome: "unavailable" };

      const transitioned = transition(job, { type: "RETRY" }, now);
      persistJobTransition(this.db, jobId, expectedVersion, transitioned.job);
      persistPendingEffects(this.db, transitioned.effects, now);
      this.markOwnerRecoveryRequeuedInTransaction(job.id, now);
      return { outcome: "retried", job: transitioned.job, admission };
    });
    try {
      return retry.immediate();
    } catch (error) {
      if (error instanceof AutonomyAdmissionConflictError) return { outcome: "unavailable" };
      throw error;
    }
  }

  public listAdmissions(states: readonly AdmissionState[], limit: number): JobAdmission[] {
    return this.autonomyRepository.listAdmissions(states, limit);
  }

  public listReleaseCandidates(limit: number): JobAdmission[] {
    return this.autonomyRepository.listReleaseCandidates(limit);
  }

  public listHeldResourceClaims(jobId: string | null, limit: number): JobResourceClaim[] {
    return this.autonomyRepository.listHeldClaims(jobId, limit);
  }

  public listCurrentHeldResourceClaims(jobId: string, limit: number): JobResourceClaim[] {
    return this.autonomyRepository.listCurrentHeldClaims(jobId, limit);
  }

  public listCurrentHeldMergeResourceClaims(input: CurrentHeldMergeResourceClaimsInput): JobResourceClaim[] {
    return this.autonomyRepository.listCurrentHeldMergeClaims(input);
  }

  public adoptHeldClaims(input: ClaimAdoptionInput): boolean {
    return this.autonomyRepository.adoptHeldClaims(input);
  }

  public listActiveJobs(limit: number): Job[] {
    return this.autonomyRepository.listActiveJobs(limit);
  }

  public listContinuationCandidates(limit: number): JobContinuationCandidate[] {
    return this.autonomyRepository.listContinuationCandidates(limit);
  }

  public recordAutoContinue(input: { jobId: string; key: string; now: number }): void {
    this.autonomyRepository.recordAutoContinue(input);
  }

  public recordContinuationEscalation(input: { jobId: string; now: number }): void {
    this.autonomyRepository.recordContinuationEscalation(input);
  }

  public findJobByStatusMessageId(messageId: number): Job | null {
    return this.autonomyRepository.findJobByStatusMessageId(messageId);
  }

  public tryAdmit(input: AdmissionAttemptInput): AdmissionAttempt {
    return this.autonomyRepository.tryAdmit(input);
  }

  public applyJobEvent(
    jobId: string,
    expectedVersion: number,
    event: JobEvent,
    now: number,
  ): Job {
    if (event.type === "CONFIRMED" || event.type === "CONTINUE_REVIEW" || event.type === "RETRY") {
      throw new AdmissionRequiredError(event.type);
    }
    if (FENCED_JOB_EVENT_TYPES.has(event.type)) {
      throw new Error(`${event.type} must be applied through its fenced executor API`);
    }
    const apply = this.db.transaction((): Job => {
      const current = this.readJobById(jobId);
      if (!current) throw new Error(`Job ${jobId} was not found`);
      if (current.version !== expectedVersion) throw new VersionConflictError(jobId, expectedVersion);
      if (nativeAdapterRequirementForEvent(current, event)) {
        throw new Error(`${event.type} requires the fenced native-adapter transition API`);
      }

      const transitioned = transition(current, event, now);
      persistJobTransition(this.db, jobId, expectedVersion, transitioned.job);
      persistPendingEffects(this.db, transitioned.effects, now);
      this.enqueueFinishNoteInTransaction(current, transitioned.job, now);
      this.markAdmissionDrainingForTerminal(transitioned.job, now);
      return transitioned.job;
    });
    return apply();
  }

  public applyExecutorJobEvent(input: ExecutorEventInput): Job | null {
    this.assertExecutorFence(input);
    if (input.event.type === "CONFIRMED" || input.event.type === "CONTINUE_REVIEW" || input.event.type === "RETRY") {
      throw new AdmissionRequiredError(input.event.type);
    }
    const apply = this.db.transaction((): Job | null => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return null;
      const current = this.readJobById(input.jobId);
      if (!current || current.version !== input.expectedVersion) return null;
      const evidenceGate = this.executorEvidenceGate(current, input.event);
      if (!evidenceGate.valid) return null;
      const nativeAdapter = validateNativeAdapterTransition({
        job: current,
        event: input.event,
        envelope: input.nativeAdapter,
        profile: input.nativeAdapter
          ? this.capabilityRepository.getProfileById(input.nativeAdapter.profileId)
          : null,
      });
      if (nativeAdapterRequirementForEvent(current, input.event) && nativeAdapter === null) return null;

      const requestedRecovery = input.event.type === "WORKER_RECOVERY_REQUESTED"
        ? this.getWorkerRecovery(input.event.recoveryId)
        : null;
      if (input.event.type === "WORKER_RECOVERY_REQUESTED" && (
        requestedRecovery === null ||
        requestedRecovery.jobId !== current.id ||
        requestedRecovery.jobState !== current.state ||
        requestedRecovery.workerKind !== input.event.workerKind ||
        requestedRecovery.resourceId !== input.event.resourceId ||
        requestedRecovery.classification !== input.event.classification ||
        requestedRecovery.signature !== input.event.signature ||
        requestedRecovery.action !== "auto_retry" ||
        requestedRecovery.state !== "detected"
      )) return null;
      const requeuedRecovery = input.event.type === "WORKER_RECOVERY_REQUEUED"
        ? this.getWorkerRecovery(input.event.recoveryId)
        : null;
      if (input.event.type === "WORKER_RECOVERY_REQUEUED" && (
        requeuedRecovery === null ||
        requeuedRecovery.jobId !== current.id ||
        requeuedRecovery.state !== "retiring"
      )) return null;

      const transitioned = transition(current, input.event, input.now);
      const terminalProductionState = current.policy?.production !== undefined &&
        PRODUCTION_LIFECYCLE_EVENT_TYPES.has(input.event.type) &&
        (transitioned.job.state === "complete" || transitioned.job.state === "production_failed");
      const productionClaimId = terminalProductionState
        ? this.currentProductionClaimIdInTransaction(current, input.ownerId, input.generation, input.now)
        : null;
      if (terminalProductionState && productionClaimId === null) return null;
      persistJobTransition(this.db, input.jobId, input.expectedVersion, transitioned.job);
      persistPendingEffects(this.db, transitioned.effects, input.now);
      if (nativeAdapter) {
        for (const outcome of nativeAdapter.outcomes) {
          this.capabilityRepository.appendTerminalOutcome({
            profileId: nativeAdapter.profileId,
            capabilityId: outcome.capabilityId,
            descriptorDigest: outcome.descriptorDigest,
            outcome: outcome.outcome,
            evidenceRefs: [...outcome.evidenceRefs],
            reasonCode: `native_${outcome.outcome}`,
            now: input.now,
          });
        }
        if (this.capabilityRepository.listMissingMandatoryOutcomes(nativeAdapter.profileId).length !== 0) {
          throw new Error("Native-adapter transition left mandatory outcomes incomplete");
        }
      }
      this.enqueueFinishNoteInTransaction(current, transitioned.job, input.now);
      for (const attemptId of evidenceGate.completeReviewAttemptIds) {
        const completed = this.db.prepare(
          `UPDATE attempts SET completed_at = ?
            WHERE id = ? AND job_id = ? AND kind = 'review' AND head_sha = ?
              AND completed_at IS NULL`,
        ).run(input.now, attemptId, current.id, current.prHeadSha);
        if (completed.changes !== 1) throw new Error("review evidence completion conflicted");
      }
      if (requestedRecovery) {
        const marked = this.db.prepare(
          `UPDATE worker_recoveries SET state = 'retiring', updated_at = ?
            WHERE id = ? AND state = 'detected' AND action = 'auto_retry'`,
        ).run(input.now, requestedRecovery.id);
        if (marked.changes !== 1) throw new WorkerRecoverySettlementConflictError();
      }
      if (requeuedRecovery) {
        const marked = this.db.prepare(
          `UPDATE worker_recoveries SET state = 'requeued', updated_at = ?
            WHERE id = ? AND state = 'retiring'`,
        ).run(input.now, requeuedRecovery.id);
        if (marked.changes !== 1) throw new WorkerRecoverySettlementConflictError();
      }
      if (WORKER_RECOVERY_SUCCESS_EVENT_TYPES.has(input.event.type)) {
        this.db.prepare(
          `UPDATE worker_recoveries
              SET state = 'recovered', resolved_at = ?, updated_at = ?
            WHERE job_id = ? AND state = 'requeued'`,
        ).run(input.now, input.now, input.jobId);
      }
      if (terminalProductionState) {
        const settled = this.db
          .prepare(
            `UPDATE job_resource_claims
                SET state = 'released', lease_expires_at = 0, released_at = ?, release_reason = ?
              WHERE claim_id = ? AND job_id = ? AND resource_kind = 'production_target'
                AND state = 'held' AND owner_id = ? AND generation = ? AND lease_expires_at > ?`,
          )
          .run(
            input.now,
            transitioned.job.state === "complete" ? "complete" : "production_failed",
            productionClaimId,
            current.id,
            input.ownerId,
            input.generation,
            input.now,
          );
        if (settled.changes !== 1) throw new ProductionSettlementConflictError();
      }
      this.markAdmissionDrainingForTerminal(transitioned.job, input.now);
      return transitioned.job;
    });
    try {
      return apply.immediate();
    } catch (error) {
      if (error instanceof ProductionSettlementConflictError || error instanceof WorkerRecoverySettlementConflictError) return null;
      throw error;
    }
  }

  public beginDraining(input: ExecutorFence & Readonly<{ jobId: string }>): Job | null {
    this.assertExecutorFence(input);
    if (!input.jobId) throw new TypeError("jobId must not be empty");
    const begin = this.db.transaction((): Job | null => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return null;
      const job = this.readJobById(input.jobId);
      const admission = this.autonomyRepository.getAdmission(input.jobId);
      const queuedCancellation = admission?.state === "queued" && job !== null && job.cancelRequestedAt !== null;
      if (!job || (!isReleaseCandidate(job.state) && !queuedCancellation)) return null;
      this.autonomyRepository.markDrainingInTransaction(input.jobId, input.now);
      return job;
    });
    return begin.immediate();
  }

  public finalizeRelease(input: ExecutorFence & Readonly<{ jobId: string }>): ReleaseResult | null {
    this.assertExecutorFence(input);
    if (!input.jobId) throw new TypeError("jobId must not be empty");
    const finalize = this.db.transaction((): ReleaseResult | null => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return null;
      const job = this.readJobById(input.jobId);
      const admission = this.autonomyRepository.getAdmission(input.jobId);
      if (!job || !admission) return null;
      if (admission.state === "released") return { outcome: "released", admission };
      const queuedCancellation = admission.state === "queued" && job.cancelRequestedAt !== null;
      if (!isReleaseCandidate(job.state) && !queuedCancellation) return null;

      const liveness = this.getWorkerLiveness(input.jobId);
      if (liveness && ["active", "starting", "stopping"].includes(liveness.state)) {
        return { outcome: "waiting", reason: "worker_active" };
      }
      if (liveness && ["unknown", "stale"].includes(liveness.state)) {
        return { outcome: "waiting", reason: "worker_unknown" };
      }

      const unsettledControls = this.db
        .prepare(
          `SELECT 1 FROM effects
             WHERE job_id = ? AND kind IN ('render_status', 'revoke_approvals')
               AND status NOT IN ('done', 'dead')
             LIMIT 1`,
        )
        .get(input.jobId);
      if (unsettledControls) return { outcome: "waiting", reason: "safe_cleanup" };

      const unresolvedEffects = this.db
        .prepare(
          `SELECT 1 FROM effects
             WHERE job_id = ? AND kind IN ('merge_pr', 'deploy_production', 'verify_production')
               AND (
                 status IN ('pending', 'failed')
                 OR (status = 'leased' AND lease_expires_at > ?)
               )
             LIMIT 1`,
        )
        .get(input.jobId, input.now);
      if (unresolvedEffects) return { outcome: "waiting", reason: "unresolved_effect" };

      if (queuedCancellation && job.state !== "cancelled") {
        const transitioned = transition(job, { type: "CANCEL_CONFIRMED" }, input.now);
        persistJobTransition(this.db, input.jobId, job.version, transitioned.job);
        persistPendingEffects(this.db, transitioned.effects, input.now);
        return { outcome: "waiting", reason: "safe_cleanup" };
      }

      this.autonomyRepository.markDrainingInTransaction(input.jobId, input.now);
      this.db
        .prepare(
          `UPDATE effects
              SET status = 'done', lease_owner = NULL, lease_generation = NULL,
                  lease_expires_at = NULL, last_error = 'superseded:job_released', updated_at = ?
            WHERE job_id = ?
              AND kind NOT IN ('render_status', 'revoke_approvals')
              AND (
                status IN ('pending', 'failed')
                OR (status = 'leased' AND lease_expires_at <= ?)
              )`,
        )
        .run(input.now, input.jobId, input.now);
      this.db
        .prepare(
          `UPDATE job_resource_claims
              SET state = 'released', lease_expires_at = 0, released_at = ?, release_reason = ?
            WHERE job_id = ? AND state = 'held'`,
        )
        .run(input.now, "job_released", input.jobId);
      const released = this.autonomyRepository.releaseInTransaction(input.jobId, input.now, "job_released");
      if (!released) return null;
      return { outcome: "released", admission: released };
    });
    return finalize.immediate();
  }

  public listEffectsForJob(jobId: string): StoredEffect[] {
    const rows = this.db
      .prepare("SELECT * FROM effects WHERE job_id = ? ORDER BY created_at ASC, idempotency_key ASC")
      .all(jobId) as EffectRow[];
    return rows.map(parseEffect);
  }

  public getEffect(jobId: string, idempotencyKey: string): StoredEffect | null {
    const row = this.db
      .prepare("SELECT * FROM effects WHERE job_id = ? AND idempotency_key = ?")
      .get(jobId, idempotencyKey) as EffectRow | undefined;
    return row ? parseEffect(row) : null;
  }

  public getAttempt(attemptId: string): AttemptRecord | null {
    if (!attemptId) throw new TypeError("attemptId must not be empty");
    const row = this.db
      .prepare(
        "SELECT id, job_id, kind, review_lens, review_stage, ordinal, thread_id, head_sha, handoff_path, handoff_sha256, result_json, completed_at FROM attempts WHERE id = ?",
      )
      .get(attemptId) as {
        id: string;
        job_id: string;
        kind: AttemptRecord["kind"];
        review_lens?: AttemptRecord["reviewLens"];
        review_stage?: AttemptRecord["reviewStage"];
        ordinal?: number;
        thread_id?: string | null;
        head_sha: string | null;
        handoff_path?: string | null;
        handoff_sha256?: string | null;
        result_json: string | null;
        completed_at: number | null;
      } | undefined;
    return row
      ? parseAttempt({
          id: row.id,
          job_id: row.job_id,
          kind: row.kind,
          review_lens: row.review_lens,
          review_stage: row.review_stage,
          ordinal: row.ordinal ?? 0,
          thread_id: row.thread_id ?? null,
          head_sha: row.head_sha,
          handoff_path: row.handoff_path ?? null,
          handoff_sha256: row.handoff_sha256 ?? null,
          result_json: row.result_json,
          completed_at: row.completed_at,
        })
      : null;
  }

  public getAttemptByThreadId(threadId: string): AttemptRecord | null {
    if (!threadId) throw new TypeError("threadId must not be empty");
    const row = this.db
      .prepare(
        "SELECT id, job_id, kind, review_lens, review_stage, ordinal, thread_id, head_sha, handoff_path, handoff_sha256, result_json, completed_at FROM attempts WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(threadId) as {
        id: string;
        job_id: string;
        kind: AttemptRecord["kind"];
        review_lens?: AttemptRecord["reviewLens"];
        review_stage?: AttemptRecord["reviewStage"];
        ordinal?: number;
        thread_id?: string | null;
        head_sha: string | null;
        handoff_path?: string | null;
        handoff_sha256?: string | null;
        result_json: string | null;
        completed_at: number | null;
      } | undefined;
    return row
      ? parseAttempt({
          id: row.id,
          job_id: row.job_id,
          kind: row.kind,
          review_lens: row.review_lens,
          review_stage: row.review_stage,
          ordinal: row.ordinal ?? 0,
          thread_id: row.thread_id ?? null,
          head_sha: row.head_sha,
          handoff_path: row.handoff_path ?? null,
          handoff_sha256: row.handoff_sha256 ?? null,
          result_json: row.result_json,
          completed_at: row.completed_at,
        })
      : null;
  }

  public nextAttemptOrdinal(jobId: string, kind: AttemptRecord["kind"]): number {
    if (!jobId) throw new TypeError("jobId must not be empty");
    const row = this.db
      .prepare("SELECT COALESCE(MAX(ordinal), 0) AS max_ordinal FROM attempts WHERE job_id = ? AND kind = ?")
      .get(jobId, kind) as { max_ordinal: number };
    return row.max_ordinal + 1;
  }

  public listReviewAttempts(
    jobId: string,
    reviewStage: NonNullable<AttemptRecord["reviewStage"]>,
    ordinal: number,
  ): AttemptRecord[] {
    if (!jobId || !["review", "final_review"].includes(reviewStage) || !Number.isInteger(ordinal) || ordinal < 1) {
      throw new TypeError("review attempt query is invalid");
    }
    const rows = this.db.prepare(
      `SELECT id, job_id, kind, review_lens, review_stage, ordinal, thread_id, head_sha,
              handoff_path, handoff_sha256, result_json, completed_at
         FROM attempts
        WHERE job_id = ? AND kind = 'review' AND review_stage = ? AND ordinal = ?
        ORDER BY CASE review_lens WHEN 'quality' THEN 0 ELSE 1 END, id`,
    ).all(jobId, reviewStage, ordinal) as Array<Parameters<typeof parseAttempt>[0]>;
    return rows.map(parseAttempt);
  }

  public createAttempt(input: {
    id: string;
    jobId: string;
    kind: AttemptRecord["kind"];
    ordinal: number;
    headSha?: string | null;
    now: number;
  }): AttemptRecord {
    if (!input.id || !input.jobId) throw new TypeError("attempt identity is required");
    if (!Number.isInteger(input.ordinal) || input.ordinal < 1) {
      throw new TypeError("attempt ordinal must be a positive integer");
    }
    assertNonNegativeInteger(input.now, "now");
    if (input.headSha !== undefined && input.headSha !== null) assertFullSha(input.headSha, "headSha");
    const reviewLens = input.kind === "review" ? "quality" : null;
    const reviewStage = input.kind === "review"
      ? (input.id.includes("final_review") || input.id.includes("final-review") ? "final_review" : "review")
      : null;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO attempts (
           id, job_id, kind, review_lens, review_stage, ordinal, head_sha, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.jobId,
        input.kind,
        reviewLens,
        reviewStage,
        input.ordinal,
        input.headSha ?? null,
        input.now,
      );
    const stored = this.getAttempt(input.id);
    if (!stored) throw new Error("Attempt was not stored");
    if (stored.jobId !== input.jobId || stored.kind !== input.kind || stored.ordinal !== input.ordinal) {
      throw new IdempotencyConflictError(input.ordinal);
    }
    return stored;
  }

  public createExecutorAttempt(input: ExecutorAttemptInput): AttemptRecord | null {
    this.assertExecutorFence(input);
    if (!input.id || !input.jobId) throw new TypeError("attempt identity is required");
    if (input.ordinal !== "next" && (!Number.isInteger(input.ordinal) || input.ordinal < 1)) {
      throw new TypeError("attempt ordinal must be a positive integer");
    }
    if (input.headSha !== undefined && input.headSha !== null) assertFullSha(input.headSha, "headSha");
    if (input.kind !== "review" && (input.reviewLens || input.reviewStage)) {
      throw new TypeError("only review attempts may have a lens or stage");
    }
    const reviewLens = input.kind === "review" ? input.reviewLens ?? "quality" : null;
    const reviewStage = input.kind === "review"
      ? input.reviewStage ?? (input.id.includes("final_review") || input.id.includes("final-review") ? "final_review" : "review")
      : null;
    const create = this.db.transaction((): AttemptRecord | null => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return null;
      // Replaying one effect must reuse its own row rather than claim a second
      // ordinal, so an existing id settles the ordinal before allocation does.
      const replayed = this.getAttempt(input.id);
      const ordinal = replayed?.ordinal
        ?? (input.ordinal === "next" ? this.nextAttemptOrdinal(input.jobId, input.kind) : input.ordinal);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO attempts (
             id, job_id, kind, review_lens, review_stage, ordinal, head_sha, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.jobId,
          input.kind,
          reviewLens,
          reviewStage,
          ordinal,
          input.headSha ?? null,
          input.now,
        );
      const stored = this.getAttempt(input.id);
      // The insert is ignored when another row already holds this ordinal, so a
      // missing row means a conflicting attempt owns it. That can never be
      // resolved by trying again: report it as the permanent conflict it is
      // rather than as a transient failure worth twenty more minutes of retries.
      if (!stored) throw new IdempotencyConflictError(ordinal);
      if (
        stored.jobId !== input.jobId || stored.kind !== input.kind || stored.ordinal !== ordinal ||
        stored.reviewLens !== reviewLens || stored.reviewStage !== reviewStage
      ) {
        throw new IdempotencyConflictError(ordinal);
      }
      return stored;
    });
    return create.immediate();
  }

  public updateAttempt(attemptId: string, patch: {
    threadId?: string | null;
    headSha?: string | null;
    handoffPath?: string | null;
    handoffSha256?: string | null;
    result?: Record<string, unknown> | null;
    completedAt?: number | null;
  }): AttemptRecord {
    if (!attemptId) throw new TypeError("attemptId must not be empty");
    if (patch.headSha !== undefined && patch.headSha !== null) assertFullSha(patch.headSha, "headSha");
    if (patch.handoffSha256 !== undefined && patch.handoffSha256 !== null) assertSha256Hex(patch.handoffSha256);
    if (patch.completedAt !== undefined && patch.completedAt !== null) assertNonNegativeInteger(patch.completedAt, "completedAt");
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.threadId !== undefined) { fields.push("thread_id = ?"); values.push(patch.threadId); }
    if (patch.headSha !== undefined) { fields.push("head_sha = ?"); values.push(patch.headSha); }
    if (patch.handoffPath !== undefined) { fields.push("handoff_path = ?"); values.push(patch.handoffPath); }
    if (patch.handoffSha256 !== undefined) { fields.push("handoff_sha256 = ?"); values.push(patch.handoffSha256); }
    if (patch.result !== undefined) {
      fields.push("result_json = ?");
      values.push(patch.result === null ? null : serializeBoundedJson(patch.result, "attempt result", MAX_MERGE_RESULT_JSON));
    }
    if (patch.completedAt !== undefined) { fields.push("completed_at = ?"); values.push(patch.completedAt); }
    if (fields.length > 0) {
      values.push(attemptId);
      this.db.prepare(`UPDATE attempts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }
    const stored = this.getAttempt(attemptId);
    if (!stored) throw new Error(`Attempt ${attemptId} was not found`);
    return stored;
  }

  public updateExecutorAttempt(input: ExecutorAttemptPatch): AttemptRecord | null {
    this.assertExecutorFence(input);
    if (!input.attemptId) throw new TypeError("attemptId must not be empty");
    this.validateAttemptPatch(input.patch);
    const update = this.db.transaction((): AttemptRecord | null => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return null;
      if (!input.jobId) return null;
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt || attempt.jobId !== input.jobId) return null;
      const fields: string[] = [];
      const values: unknown[] = [];
      this.appendAttemptPatch(fields, values, input.patch);
      if (fields.length > 0) {
        values.push(input.attemptId, input.jobId);
        this.db.prepare(`UPDATE attempts SET ${fields.join(", ")} WHERE id = ? AND job_id = ?`).run(...values);
      }
      const updated = this.getAttempt(input.attemptId);
      return updated?.jobId === input.jobId ? updated : null;
    });
    return update.immediate();
  }

  public createPipelineStageAttempt(input: ControllerLeaseFence & {
    id: string;
    jobId: string;
    role: PipelineStageRole;
    ordinal: number;
    inputSha256: string;
  }): PipelineStageAttempt {
    if (!input.id || !input.jobId) throw new TypeError("pipeline stage identity is required");
    if (!PIPELINE_STAGE_ROLES.has(input.role)) throw new TypeError("pipeline stage role is invalid");
    assertPositiveInteger(input.ordinal, "ordinal");
    assertContentSha256(input.inputSha256, "inputSha256");
    assertNonNegativeInteger(input.now, "now");
    if (!input.ownerId || !Number.isInteger(input.generation) || input.generation < 1) {
      throw new TypeError("executor fence is invalid");
    }
    return this.db.transaction((): PipelineStageAttempt => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) {
        throw new Error("executor lease was lost");
      }
      if (!this.productionStageMutationIsCurrentInTransaction(input.id, input.ownerId, input.generation, input.now)) {
        throw new Error("production claim fence was lost");
      }
      this.db.prepare(
        `INSERT OR IGNORE INTO pipeline_stage_attempts (
           id, job_id, role, ordinal, state, input_sha256, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'spawning', ?, ?, ?)`,
      ).run(input.id, input.jobId, input.role, input.ordinal, input.inputSha256, input.now, input.now);
      const stored = this.getPipelineStageAttempt(input.id);
      if (!stored) throw new Error("Pipeline stage attempt was not stored");
      if (
        stored.jobId !== input.jobId || stored.role !== input.role ||
        stored.ordinal !== input.ordinal || stored.inputSha256 !== input.inputSha256
      ) throw new Error("Pipeline stage attempt idempotency conflict");
      return stored;
    }).immediate();
  }

  public bindPipelineStageThread(input: ControllerLeaseFence & {
    id: string;
    threadId: string;
    environmentId: string;
  }): boolean {
    if (!input.id || !input.threadId || !input.environmentId) throw new TypeError("pipeline thread identity is required");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      if (!this.productionStageMutationIsCurrentInTransaction(input.id, input.ownerId, input.generation, input.now)) return false;
      const current = this.getPipelineStageAttempt(input.id);
      if (!current) return false;
      if (current.threadId !== null || current.environmentId !== null) {
        return current.threadId === input.threadId && current.environmentId === input.environmentId &&
          (current.state === "running" || current.state === "completed");
      }
      return this.db.prepare(
        `UPDATE pipeline_stage_attempts
           SET thread_id = ?, environment_id = ?, resource_kind = 'bb_thread', resource_id = ?,
               state = 'running', updated_at = ?
         WHERE id = ? AND state = 'spawning'
           AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1
             AND owner_id = ? AND generation = ? AND lease_expires_at > ?)`,
      ).run(
        input.threadId,
        input.environmentId,
        input.threadId,
        input.now,
        input.id,
        input.ownerId,
        input.generation,
        input.now,
      ).changes === 1;
    }).immediate();
  }

  public bindPipelineStageResource(input: ControllerLeaseFence & {
    id: string;
    resourceKind: "bb_thread" | "bb_terminal";
    resourceId: string;
    environmentId: string;
  }): boolean {
    if (!input.id || !input.resourceId || !input.environmentId) throw new TypeError("pipeline resource identity is required");
    if (input.resourceKind !== "bb_thread" && input.resourceKind !== "bb_terminal") {
      throw new TypeError("pipeline resource kind is invalid");
    }
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      if (!this.productionStageMutationIsCurrentInTransaction(input.id, input.ownerId, input.generation, input.now)) return false;
      const current = this.getPipelineStageAttempt(input.id);
      if (!current) return false;
      if (current.resourceKind !== null || current.resourceId !== null) {
        return current.resourceKind === input.resourceKind && current.resourceId === input.resourceId &&
          current.environmentId === input.environmentId && (current.state === "running" || current.state === "completed");
      }
      return this.db.prepare(
        `UPDATE pipeline_stage_attempts
           SET resource_kind = ?, resource_id = ?, environment_id = ?, state = 'running', updated_at = ?
         WHERE id = ? AND state = 'spawning'
           AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1
             AND owner_id = ? AND generation = ? AND lease_expires_at > ?)`,
      ).run(
        input.resourceKind,
        input.resourceId,
        input.environmentId,
        input.now,
        input.id,
        input.ownerId,
        input.generation,
        input.now,
      ).changes === 1;
    }).immediate();
  }

  public completePipelineStageAttempt(input: ControllerLeaseFence & {
    id: string;
    outputText: string;
    outputSha256: string;
    outcome: Record<string, unknown>;
    startSha?: string | null;
    endSha?: string | null;
  }): boolean {
    if (!input.id) throw new TypeError("pipeline stage id is required");
    if (
      typeof input.outputText !== "string" || input.outputText.length === 0 ||
      new TextEncoder().encode(input.outputText).byteLength > MAX_PIPELINE_OUTPUT_BYTES
    ) {
      throw new TypeError("pipeline stage output must be bounded to 65536 bytes");
    }
    assertContentSha256(input.outputSha256, "outputSha256");
    if (input.startSha !== undefined && input.startSha !== null) assertFullSha(input.startSha, "startSha");
    if (input.endSha !== undefined && input.endSha !== null) assertFullSha(input.endSha, "endSha");
    assertNonNegativeInteger(input.now, "now");
    const outcomeJson = serializeBoundedJson(input.outcome, "pipeline stage outcome", MAX_MERGE_RESULT_JSON);
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const current = this.getPipelineStageAttempt(input.id);
      if (!current) return false;
      if (current.state === "completed") {
        return current.outputText === input.outputText && current.outputSha256 === input.outputSha256 &&
          JSON.stringify(current.outcome) === outcomeJson;
      }
      if (!this.productionStageMutationIsCurrentInTransaction(input.id, input.ownerId, input.generation, input.now)) return false;
      return this.db.prepare(
        `UPDATE pipeline_stage_attempts
           SET state = 'completed', output_text = ?, output_sha256 = ?, outcome_json = ?,
               start_sha = ?, end_sha = ?, last_error = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND state IN ('spawning', 'running')
           AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1
             AND owner_id = ? AND generation = ? AND lease_expires_at > ?)`,
      ).run(
        input.outputText,
        input.outputSha256,
        outcomeJson,
        input.startSha ?? null,
        input.endSha ?? null,
        input.now,
        input.now,
        input.id,
        input.ownerId,
        input.generation,
        input.now,
      ).changes === 1;
    }).immediate();
  }

  public failPipelineStageAttempt(input: ControllerLeaseFence & { id: string; error: string }): boolean {
    if (!input.id) throw new TypeError("pipeline stage id is required");
    assertSafeFailureSummary(input.error);
    assertNonNegativeInteger(input.now, "now");
    const fail = this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      if (!this.productionStageMutationIsCurrentInTransaction(input.id, input.ownerId, input.generation, input.now)) return false;
      return this.db.prepare(
        `UPDATE pipeline_stage_attempts
           SET state = 'failed', last_error = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND state IN ('spawning', 'running')
           AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1
             AND owner_id = ? AND generation = ? AND lease_expires_at > ?)`,
      ).run(
        input.error,
        input.now,
        input.now,
        input.id,
        input.ownerId,
        input.generation,
        input.now,
      ).changes === 1;
    });
    return fail.immediate();
  }

  public getPipelineStageAttempt(id: string): PipelineStageAttempt | null {
    if (!id) return null;
    const row = this.db.prepare("SELECT * FROM pipeline_stage_attempts WHERE id = ?").get(id) as PipelineStageAttemptRow | undefined;
    return row ? parsePipelineStageAttempt(row) : null;
  }

  public getPipelineStageAttemptByThreadId(threadId: string): PipelineStageAttempt | null {
    if (!threadId) return null;
    const row = this.db.prepare("SELECT * FROM pipeline_stage_attempts WHERE thread_id = ?").get(threadId) as PipelineStageAttemptRow | undefined;
    return row ? parsePipelineStageAttempt(row) : null;
  }

  public getLatestPipelineStageAttempt(jobId: string, role: PipelineStageRole): PipelineStageAttempt | null {
    if (!jobId) throw new TypeError("jobId must not be empty");
    if (!PIPELINE_STAGE_ROLES.has(role)) throw new TypeError("pipeline stage role is invalid");
    const row = this.db.prepare(
      "SELECT * FROM pipeline_stage_attempts WHERE job_id = ? AND role = ? ORDER BY ordinal DESC LIMIT 1",
    ).get(jobId, role) as PipelineStageAttemptRow | undefined;
    return row ? parsePipelineStageAttempt(row) : null;
  }

  public nextPipelineStageOrdinal(jobId: string, role: PipelineStageRole): number {
    if (!jobId) throw new TypeError("jobId must not be empty");
    if (!PIPELINE_STAGE_ROLES.has(role)) throw new TypeError("pipeline stage role is invalid");
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) AS max_ordinal FROM pipeline_stage_attempts WHERE job_id = ? AND role = ?",
    ).get(jobId, role) as { max_ordinal: number };
    return row.max_ordinal + 1;
  }

  public claimReviewFormatCorrection(attemptId: string, threadId: string, headSha: string): boolean {
    if (!attemptId || !threadId) throw new TypeError("review correction identity is required");
    assertFullSha(headSha, "headSha");
    const claim = this.db.transaction(() => this.claimReviewFormatCorrectionInTransaction(attemptId, threadId, headSha));
    return claim();
  }

  public claimExecutorReviewFormatCorrection(input: ExecutorReviewFormatCorrectionInput): boolean {
    this.assertExecutorFence(input);
    if (!input.attemptId || !input.threadId) throw new TypeError("review correction identity is required");
    assertFullSha(input.headSha, "headSha");
    const claim = this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      if (!input.jobId) return false;
      return this.claimReviewFormatCorrectionInTransaction(input.attemptId, input.threadId, input.headSha, input.jobId);
    });
    return claim.immediate();
  }

  public registerReviewThread(jobId: string, expectedVersion: number, threadId: string, now: number): Job {
    if (!jobId || !threadId) throw new TypeError("jobId and threadId are required");
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new TypeError("expectedVersion must be a positive integer");
    assertNonNegativeInteger(now, "now");
    const update = this.db
      .prepare(
        `UPDATE jobs SET review_thread_id = ?, version = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
      )
      .run(threadId, expectedVersion + 1, now, jobId, expectedVersion);
    if (update.changes !== 1) throw new VersionConflictError(jobId, expectedVersion);
    const stored = this.readJobById(jobId);
    if (!stored) throw new Error(`Job ${jobId} was not found after review-thread registration`);
    return stored;
  }

  public registerExecutorReviewThread(input: ExecutorReviewThreadInput): Job | null {
    this.assertExecutorFence(input);
    if (!input.jobId || !input.threadId) throw new TypeError("jobId and threadId are required");
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new TypeError("expectedVersion must be a positive integer");
    }
    const register = this.db.transaction((): Job | null => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return null;
      const updated = this.db
        .prepare(
          `UPDATE jobs SET review_thread_id = ?, version = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
        )
        .run(input.threadId, input.expectedVersion + 1, input.now, input.jobId, input.expectedVersion);
      if (updated.changes !== 1) return null;
      return this.readJobById(input.jobId);
    });
    return register.immediate();
  }

  public createExecutorApproval(input: ExecutorApprovalInput): boolean {
    this.assertExecutorFence(input);
    this.validateApprovalInput(input);
    const create = this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      this.createApprovalInTransaction(input);
      return true;
    });
    return create.immediate();
  }

  public revokeExecutorApprovals(input: ExecutorApprovalRevocationInput): number | null {
    this.assertExecutorFence(input);
    if (!input.jobId) throw new TypeError("jobId must not be empty");
    assertSafeFailureSummary(input.reason);
    assertNoRawMergeCallback(input.reason, "approval outcome");
    const revoke = this.db.transaction((): number | null => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return null;
      return this.db
        .prepare(
          `UPDATE approvals SET consumed_at = ?, outcome = ?
             WHERE job_id = ? AND consumed_at IS NULL`,
        )
        .run(input.now, input.reason, input.jobId).changes;
    });
    return revoke.immediate();
  }

  public enqueueExecutorStatus(input: ExecutorStatusOutboxInput): boolean {
    this.assertExecutorFence(input);
    const payloadJson = serializeOutbox(input.outbox, input.now);
    const enqueue = this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      persistOutbox(this.db, input.outbox, payloadJson, input.now);
      return true;
    });
    return enqueue.immediate();
  }

  public acquireExecutorLease(
    ownerId: string,
    now: number,
    leaseMs: number,
  ): { acquired: true; generation: number } | { acquired: false } {
    this.assertLeaseInput(ownerId, now, leaseMs);
    return this.db.transaction(() => {
      const current = this.executorLeaseRow();
      if (current.owner_id !== null && current.lease_expires_at !== null && current.lease_expires_at > now) {
        return { acquired: false } as const;
      }
      const generation = current.generation + 1;
      const updated = this.db
        .prepare(
          `UPDATE executor_lease SET owner_id = ?, generation = ?, heartbeat_at = ?, lease_expires_at = ?
             WHERE singleton = 1 AND generation = ?`,
        )
        .run(ownerId, generation, now, now + leaseMs, current.generation);
      if (updated.changes !== 1) return { acquired: false } as const;
      return { acquired: true, generation } as const;
    }).immediate();
  }

  public renewExecutorLease(ownerId: string, generation: number, now: number, leaseMs: number): boolean {
    this.assertLeaseInput(ownerId, now, leaseMs);
    assertPositiveInteger(generation, "generation");
    return this.db.transaction(() => this.db
      .prepare(
        `UPDATE executor_lease SET heartbeat_at = ?, lease_expires_at = ?
           WHERE singleton = 1 AND owner_id = ? AND generation = ? AND lease_expires_at > ?`,
      )
      .run(now, now + leaseMs, ownerId, generation, now).changes === 1).immediate();
  }

  public releaseExecutorLease(ownerId: string, generation: number, now: number): boolean {
    if (!ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(generation, "generation");
    assertNonNegativeInteger(now, "now");
    return this.db.transaction(() => this.db
      .prepare(
        `UPDATE executor_lease SET owner_id = NULL, heartbeat_at = ?, lease_expires_at = NULL
           WHERE singleton = 1 AND owner_id = ? AND generation = ?`,
      )
      .run(now, ownerId, generation).changes === 1).immediate();
  }

  public isExecutorLeaseCurrent(ownerId: string, generation: number, now: number): boolean {
    if (!ownerId) return false;
    if (!Number.isInteger(generation) || generation < 1) return false;
    if (!Number.isInteger(now) || now < 0) return false;
    return this.executorLeaseIsCurrent(ownerId, generation, now);
  }

  public isControllerInteractionDeliveryFenceCurrent(input: ControllerInteractionDeliveryFence): boolean {
    return this.controllerInteractionRepository.isControllerInteractionDeliveryFenceCurrent(input);
  }

  public leaseControlEffects(input: ControlEffectLeaseInput): StoredEffect[] {
    this.assertLeaseInput(input.ownerId, input.now, input.leaseMs);
    assertPositiveInteger(input.generation, "generation");
    assertPositiveInteger(input.limit, "limit");
    if (input.limit > MAX_AUTONOMY_ROWS) throw new TypeError("limit must not exceed 100");
    const limit = Math.min(input.limit, 8);
    const rawBusyJobIds = input.busyJobIds ?? [];
    if (!Array.isArray(rawBusyJobIds) || rawBusyJobIds.length > MAX_AUTONOMY_ROWS) {
      throw new TypeError("busyJobIds must contain at most 100 job ids");
    }
    for (const jobId of rawBusyJobIds) {
      if (typeof jobId !== "string" || !jobId || jobId.length > 256) {
        throw new TypeError("busy job id is invalid");
      }
    }
    const busyJobIds = [...new Set(rawBusyJobIds)];
    const lease = this.db.transaction((): StoredEffect[] => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return [];
      const exclusion = busyJobIds.length === 0
        ? ""
        : ` AND e.job_id NOT IN (${busyJobIds.map(() => "?").join(", ")})`;
      const rows = this.db
        .prepare(
          `SELECT e.* FROM effects AS e
             JOIN job_admissions AS admission ON admission.job_id = e.job_id
             JOIN jobs AS job ON job.id = e.job_id
            WHERE (
                admission.state IN ('queued', 'admitted', 'draining')
                OR (
                  admission.state = 'released'
                  AND job.state IN ('blocked', 'cancelled', 'merged', 'production_failed', 'complete')
                  AND e.idempotency_key = e.job_id || ':' || job.version || ':render_status'
                )
              )
              AND e.kind IN ('render_status', 'revoke_approvals')
              AND (
                (e.status IN ('pending', 'failed') AND e.next_attempt_at <= ?)
                OR (e.status = 'leased' AND e.lease_expires_at <= ?)
              )${exclusion}
            ORDER BY e.created_at ASC, e.idempotency_key ASC
            LIMIT ?`,
        )
        .all(input.now, input.now, ...busyJobIds, limit) as EffectRow[];
      const leased: StoredEffect[] = [];
      for (const row of rows) {
        if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) break;
        const effect = parseEffect(row);
        const admission = this.autonomyRepository.getAdmission(effect.jobId);
        if (!admission || !isSafeControlEffect(effect.kind)) continue;
        const updated = this.db
          .prepare(
            `UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?,
               lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
             WHERE idempotency_key = ? AND (
               (status IN ('pending', 'failed') AND next_attempt_at <= ?)
               OR (status = 'leased' AND lease_expires_at <= ?)
             )`,
          )
          .run(
            input.ownerId,
            input.generation,
            input.now + input.leaseMs,
            input.now,
            effect.idempotencyKey,
            input.now,
            input.now,
          );
        if (updated.changes !== 1) continue;
        const claimed = this.db.prepare("SELECT * FROM effects WHERE idempotency_key = ?").get(effect.idempotencyKey) as EffectRow;
        leased.push(parseEffect(claimed));
      }
      return leased;
    });
    return lease.immediate();
  }

  public leaseNextJobEffect(input: JobEffectLeaseInput): StoredEffect | null {
    this.assertLeaseInput(input.ownerId, input.now, input.leaseMs);
    assertPositiveInteger(input.generation, "generation");
    if (!input.jobId || input.jobId.length > 256) throw new TypeError("jobId is invalid");
    const lease = this.db.transaction((): StoredEffect | null => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return null;
      const admission = this.autonomyRepository.getAdmission(input.jobId);
      if (!admission || admission.state === "queued" || admission.state === "released") return null;
      const requiredProjectClaim = this.db
        .prepare(
          `SELECT 1 FROM job_resource_claims
             WHERE job_id = ? AND resource_key = ? AND resource_kind = 'project'
               AND state = 'held' AND owner_id = ? AND generation = ?
               AND lease_expires_at > ?
             LIMIT 1`,
        )
        .get(
          input.jobId,
          projectResourceKey(admission.projectId),
          input.ownerId,
          input.generation,
          input.now,
        );
      if (!requiredProjectClaim) return null;
      const tracked = this.db
        .prepare(
          `SELECT 1 FROM effects
            WHERE job_id = ? AND status = 'leased' AND lease_expires_at > ?
            LIMIT 1`,
        )
        .get(input.jobId, input.now);
      if (tracked) return null;
      const rows = this.db
        .prepare(
          `SELECT * FROM effects
             WHERE job_id = ? AND (
               (status IN ('pending', 'failed') AND next_attempt_at <= ?)
               OR (status = 'leased' AND lease_expires_at <= ?)
             )
            ORDER BY created_at ASC, idempotency_key ASC
            LIMIT 100`,
        )
        .all(input.jobId, input.now, input.now) as EffectRow[];
      const worker = this.getWorkerLiveness(input.jobId);
      for (const row of rows) {
        const effect = parseEffect(row);
        if (!admissionAllowsEffect(admission, effect, worker)) continue;
        if (effect.kind === "merge_pr" || effect.kind === "deploy_production" || effect.kind === "verify_production") {
          const job = this.readJobById(effect.jobId);
          if (!job || !this.admissionJobPolicyIdentityIsValid(admission, job)) return null;
          if (effect.kind === "merge_pr") {
            this.acquireMergeResourceClaimsInTransaction(input, effect, job);
          } else if (!this.productionClaimIsCurrentInTransaction(job, input.ownerId, input.generation, input.now)) {
            continue;
          }
        }
        const updated = this.db
          .prepare(
            `UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?,
               lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
             WHERE idempotency_key = ? AND job_id = ? AND (
               (status IN ('pending', 'failed') AND next_attempt_at <= ?)
               OR (status = 'leased' AND lease_expires_at <= ?)
             )`,
          )
          .run(
            input.ownerId,
            input.generation,
            input.now + input.leaseMs,
            input.now,
            effect.idempotencyKey,
            input.jobId,
            input.now,
            input.now,
          );
        if (updated.changes !== 1) {
          if (effect.kind === "merge_pr") throw new MergeClaimConflictError();
          continue;
        }
        const claimed = this.db.prepare("SELECT * FROM effects WHERE idempotency_key = ?").get(effect.idempotencyKey) as EffectRow;
        return parseEffect(claimed);
      }
      return null;
    });
    try {
      return lease.immediate();
    } catch (error) {
      if (error instanceof MergeClaimConflictError) return null;
      throw error;
    }
  }

  public renewJobOperationFences(input: JobOperationFenceRenewalInput): boolean {
    this.assertLeaseInput(input.ownerId, input.now, input.leaseMs);
    assertPositiveInteger(input.generation, "generation");
    if (!input.jobId || !input.effectIdempotencyKey) throw new TypeError("job operation identity is required");
    const renew = this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const effect = this.db
        .prepare(
          `SELECT kind, status, lease_owner, lease_generation, lease_expires_at
             FROM effects WHERE job_id = ? AND idempotency_key = ?`,
        )
        .get(input.jobId, input.effectIdempotencyKey) as {
          kind: string;
          status: string;
          lease_owner: string | null;
          lease_generation: number | null;
          lease_expires_at: number | null;
        } | undefined;
      if (!effect || effect.status !== "leased" || effect.lease_owner !== input.ownerId ||
        effect.lease_generation !== input.generation || effect.lease_expires_at === null || effect.lease_expires_at <= input.now) {
        return false;
      }
      if (effect.kind === "deploy_production" || effect.kind === "verify_production") {
        const job = this.readJobById(input.jobId);
        const admission = this.autonomyRepository.getAdmission(input.jobId);
        if (!job || !admission || !this.admissionJobPolicyIdentityIsValid(admission, job) ||
          !this.productionClaimIsCurrentInTransaction(job, input.ownerId, input.generation, input.now)) return false;
      }
      const claims = this.db
        .prepare(
          `SELECT claim_id, owner_id, generation FROM job_resource_claims
             WHERE job_id = ? AND state = 'held'`,
        )
        .all(input.jobId) as Array<{ claim_id: number; owner_id: string; generation: number }>;
      if (claims.some((claim) => claim.owner_id !== input.ownerId || claim.generation !== input.generation)) return false;
      const updatedEffect = this.db
        .prepare(
          `UPDATE effects SET lease_expires_at = ?, updated_at = ?
             WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
               AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?
               AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1
                 AND owner_id = ? AND generation = ? AND lease_expires_at > ?)`,
        )
        .run(
          input.now + input.leaseMs,
          input.now,
          input.jobId,
          input.effectIdempotencyKey,
          input.ownerId,
          input.generation,
          input.now,
          input.ownerId,
          input.generation,
          input.now,
        );
      if (updatedEffect.changes !== 1) return false;
      if (claims.length === 0) return true;
      const renewedClaims = this.db
        .prepare(
          `UPDATE job_resource_claims SET lease_expires_at = ?, renewed_at = ?
             WHERE job_id = ? AND state = 'held' AND owner_id = ? AND generation = ?
               AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1
                 AND owner_id = ? AND generation = ? AND lease_expires_at > ?)`,
        )
        .run(
          input.now + input.leaseMs,
          input.now,
          input.jobId,
          input.ownerId,
          input.generation,
          input.ownerId,
          input.generation,
          input.now,
        );
      return renewedClaims.changes === claims.length;
    });
    return renew.immediate();
  }

  public assertProductionStageFence(input: ProductionStageFenceInput): boolean {
    this.assertExecutorFence(input);
    if (!input.jobId || !input.effectIdempotencyKey) throw new TypeError("production stage identity is required");
    const check = this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const effect = this.db
        .prepare(
          `SELECT job_id, kind, status, lease_owner, lease_generation, lease_expires_at
             FROM effects WHERE job_id = ? AND idempotency_key = ?`,
        )
        .get(input.jobId, input.effectIdempotencyKey) as {
          job_id: string;
          kind: string;
          status: string;
          lease_owner: string | null;
          lease_generation: number | null;
          lease_expires_at: number | null;
        } | undefined;
      if (!effect || effect.job_id !== input.jobId ||
        (effect.kind !== "deploy_production" && effect.kind !== "verify_production") ||
        effect.status !== "leased" || effect.lease_owner !== input.ownerId ||
        effect.lease_generation !== input.generation || effect.lease_expires_at === null ||
        effect.lease_expires_at <= input.now) return false;
      const job = this.readJobById(input.jobId);
      const admission = this.autonomyRepository.getAdmission(input.jobId);
      if (!job || !admission || !this.admissionJobPolicyIdentityIsValid(admission, job)) return false;
      const expectedState = effect.kind === "deploy_production" ? "deploying" : "verifying_production";
      return job.state === expectedState &&
        this.productionClaimIsCurrentInTransaction(job, input.ownerId, input.generation, input.now);
    });
    return check.immediate();
  }

  public renewControlEffectFence(input: ControlEffectFenceRenewalInput): boolean {
    this.assertLeaseInput(input.ownerId, input.now, input.leaseMs);
    assertPositiveInteger(input.generation, "generation");
    if (!input.jobId || !input.effectIdempotencyKey) throw new TypeError("job operation identity is required");
    const renew = this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const effect = this.db
        .prepare(
          `SELECT kind, status, lease_owner, lease_generation, lease_expires_at
             FROM effects WHERE job_id = ? AND idempotency_key = ?`,
        )
        .get(input.jobId, input.effectIdempotencyKey) as {
          kind: string;
          status: string;
          lease_owner: string | null;
          lease_generation: number | null;
          lease_expires_at: number | null;
        } | undefined;
      if (!effect || !isSafeControlEffect(effect.kind as JobEffect["kind"]) || effect.status !== "leased" ||
        effect.lease_owner !== input.ownerId || effect.lease_generation !== input.generation ||
        effect.lease_expires_at === null || effect.lease_expires_at <= input.now) {
        return false;
      }
      const updated = this.db
        .prepare(
          `UPDATE effects SET lease_expires_at = ?, updated_at = ?
             WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
               AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?
               AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1
                 AND owner_id = ? AND generation = ? AND lease_expires_at > ?)`,
        )
        .run(
          input.now + input.leaseMs,
          input.now,
          input.jobId,
          input.effectIdempotencyKey,
          input.ownerId,
          input.generation,
          input.now,
          input.ownerId,
          input.generation,
          input.now,
        );
      return updated.changes === 1;
    });
    return renew.immediate();
  }

  /** @deprecated Test-only compatibility wrapper; executor production code uses state-aware leasing. */
  public leaseEffects(ownerId: string, generation: number, now: number, limit: number, leaseMs: number): StoredEffect[] {
    this.assertLeaseInput(ownerId, now, leaseMs);
    assertPositiveInteger(generation, "generation");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
    if (!this.executorLeaseIsCurrent(ownerId, generation, now)) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM effects
           WHERE (status IN ('pending', 'failed') AND next_attempt_at <= ?)
              OR (status = 'leased' AND lease_expires_at <= ?)
           ORDER BY created_at ASC, idempotency_key ASC LIMIT ?`,
      )
      .all(now, now, limit) as EffectRow[];
    const result: StoredEffect[] = [];
    for (const row of rows) {
      if (!this.executorLeaseIsCurrent(ownerId, generation, now)) break;
      if (row.kind === "merge_pr" || row.kind === "deploy_production" || row.kind === "verify_production") {
        const claimed = this.leaseNextJobEffect({
          jobId: row.job_id,
          ownerId,
          generation,
          now,
          leaseMs,
        });
        if (claimed?.idempotencyKey === row.idempotency_key) result.push(claimed);
        continue;
      }
      const claimed = this.db.transaction((): StoredEffect | null => {
        if (!this.executorLeaseIsCurrent(ownerId, generation, now)) return null;
        const updated = this.db
          .prepare(
            `UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?,
               lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
             WHERE idempotency_key = ? AND (
               (status IN ('pending', 'failed') AND next_attempt_at <= ?)
               OR (status = 'leased' AND lease_expires_at <= ?)
             )`,
          )
          .run(ownerId, generation, now + leaseMs, now, row.idempotency_key, now, now);
        if (updated.changes !== 1) return null;
        const stored = this.db.prepare("SELECT * FROM effects WHERE idempotency_key = ?").get(row.idempotency_key) as EffectRow;
        return parseEffect(stored);
      }).immediate();
      if (claimed) result.push(claimed);
    }
    return result;
  }

  public leaseOutbox(ownerId: string, generation: number, now: number, limit: number, leaseMs: number): StoredOutbox[] {
    this.assertLeaseInput(ownerId, now, leaseMs);
    assertPositiveInteger(generation, "generation");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
    return this.db.transaction((): StoredOutbox[] => {
      if (!this.executorLeaseIsCurrent(ownerId, generation, now)) return [];
      const rows = this.db
        .prepare(
          `SELECT * FROM outbox
             WHERE (status IN ('pending', 'failed') AND next_attempt_at <= ?)
                OR (status = 'leased' AND lease_expires_at <= ?)
             ORDER BY created_at ASC, logical_key ASC LIMIT ?`,
        )
        .all(now, now, limit) as OutboxRow[];
      const result: StoredOutbox[] = [];
      for (const row of rows) {
        if (!this.executorLeaseIsCurrent(ownerId, generation, now)) break;
        const updated = this.db
          .prepare(
            `UPDATE outbox SET status = 'leased', lease_owner = ?, lease_generation = ?,
               lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
             WHERE logical_key = ? AND (
               (status IN ('pending', 'failed') AND next_attempt_at <= ?)
               OR (status = 'leased' AND lease_expires_at <= ?)
             )`,
          )
          .run(ownerId, generation, now + leaseMs, now, row.logical_key, now, now);
        if (updated.changes !== 1) continue;
        const claimed = this.db.prepare("SELECT * FROM outbox WHERE logical_key = ?").get(row.logical_key) as OutboxRow;
        result.push(parseOutbox(claimed));
      }
      return result;
    }).immediate();
  }

  public renewOutboxLease(input: OutboxLeaseRenewalInput): boolean {
    this.assertLeaseIdentity(input.logicalKey, input.ownerId, input.generation, input.now);
    this.assertLeaseInput(input.ownerId, input.now, input.leaseMs);
    return this.db.prepare(
      `UPDATE outbox SET lease_expires_at = ?, updated_at = ?
       WHERE logical_key = ? AND status = 'leased' AND lease_owner = ?
         AND lease_generation = ? AND lease_expires_at > ?
         AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1 AND owner_id = ?
           AND generation = ? AND lease_expires_at > ?)`,
    ).run(
      input.now + input.leaseMs,
      input.now,
      input.logicalKey,
      input.ownerId,
      input.generation,
      input.now,
      input.ownerId,
      input.generation,
      input.now,
    ).changes === 1;
  }

  public completeEffect(key: string, ownerId: string, generation: number, now: number): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    const complete = this.db.transaction(() => this.db
      .prepare(
        `UPDATE effects SET status = 'done', lease_owner = NULL, lease_generation = NULL,
           lease_expires_at = NULL, last_error = NULL, updated_at = ?
         WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
           AND lease_generation = ? AND lease_expires_at > ?
           AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1 AND owner_id = ?
             AND generation = ? AND lease_expires_at > ?)`,
      )
      .run(now, key, ownerId, generation, now, ownerId, generation, now).changes === 1);
    return complete.immediate();
  }

  public completeOutbox(key: string, ownerId: string, generation: number, messageId: number | null, now: number): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    if (messageId !== null && (!Number.isInteger(messageId) || messageId < 1)) throw new TypeError("messageId must be positive or null");
    return this.db.transaction((): boolean => {
      const updated = this.db.prepare(
        `UPDATE outbox SET status = 'sent', message_id = COALESCE(?, message_id),
           lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL,
           last_error = NULL, updated_at = ?
         WHERE logical_key = ? AND status = 'leased' AND lease_owner = ?
           AND lease_generation = ? AND lease_expires_at > ?
           AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1 AND owner_id = ?
             AND generation = ? AND lease_expires_at > ?)`,
      ).run(messageId, now, key, ownerId, generation, now, ownerId, generation, now);
      if (updated.changes !== 1) return false;
      const controllerReply = /^controller:(controller-turn-[^:]+):reply$/.exec(key);
      if (controllerReply && messageId !== null) {
        const linked = this.db.prepare(
          `UPDATE controller_turns SET telegram_message_id = ?, updated_at = ?
            WHERE id = ? AND (telegram_message_id IS NULL OR telegram_message_id = ?)`,
        ).run(messageId, now, controllerReply[1], messageId);
        if (linked.changes !== 1) throw new Error("Controller reply message changed before completion");
      }
      return true;
    }).immediate();
  }

  public completeStatusOutbox(
    key: string,
    ownerId: string,
    generation: number,
    jobId: string,
    expectedVersion: number,
    messageId: number,
    now: number,
  ): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    if (!jobId) throw new TypeError("jobId must not be empty");
    assertPositiveInteger(expectedVersion, "expectedVersion");
    if (!Number.isInteger(messageId) || messageId < 1) throw new TypeError("messageId must be positive");
    return this.db.transaction(() => {
      const updatedJob = this.db
        .prepare(
          `UPDATE jobs SET status_message_id = ?, version = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
        )
        .run(messageId, expectedVersion + 1, now, jobId, expectedVersion);
      if (updatedJob.changes !== 1) return false;
      const updatedOutbox = this.db
        .prepare(
          `UPDATE outbox SET status = 'sent', message_id = ?, lease_owner = NULL,
             lease_generation = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
             WHERE logical_key = ? AND status = 'leased' AND lease_owner = ?
               AND lease_generation = ? AND lease_expires_at > ?
               AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1 AND owner_id = ?
                 AND generation = ? AND lease_expires_at > ?)`,
        )
        .run(messageId, now, key, ownerId, generation, now, ownerId, generation, now);
      if (updatedOutbox.changes !== 1) throw new Error("status outbox lease changed before atomic completion");
      return true;
    }).immediate();
  }

  public replaceStatusOutboxMessage(
    key: string,
    ownerId: string,
    generation: number,
    jobId: string,
    expectedVersion: number,
    messageId: number,
    now: number,
  ): boolean {
    return this.completeStatusOutbox(key, ownerId, generation, jobId, expectedVersion, messageId, now);
  }

  public failEffect(key: string, ownerId: string, generation: number, error: string, nextAttemptAt: number, now: number): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    assertSafeFailureSummary(error);
    assertNoRawMergeCallback(error, "effect error");
    assertNonNegativeInteger(nextAttemptAt, "nextAttemptAt");
    return this.db.transaction(() => {
      const effect = this.effectByKey(key);
      if (!effect || !this.effectLeaseIsActiveForRow(effect, ownerId, generation, now)) return false;
      if (effect.attempts >= 20) {
        const updated = this.db
          .prepare(
            `UPDATE effects SET status = 'dead', lease_owner = NULL, lease_generation = NULL,
               lease_expires_at = NULL, last_error = ?, updated_at = ?
             WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
               AND lease_generation = ? AND lease_expires_at > ?`,
          )
          .run(error, now, key, ownerId, generation, now);
        if (updated.changes === 1) this.settleJobForDeadEffect(effect, error, now);
        return updated.changes === 1;
      }
      return this.db
        .prepare(
          `UPDATE effects SET status = 'failed', lease_owner = NULL, lease_generation = NULL,
             lease_expires_at = NULL, last_error = ?, next_attempt_at = ?, updated_at = ?
           WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
             AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(error, nextAttemptAt, now, key, ownerId, generation, now).changes === 1;
    }).immediate();
  }

  public failOutbox(key: string, ownerId: string, generation: number, error: string, nextAttemptAt: number, now: number): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    assertSafeFailureSummary(error);
    assertNoRawMergeCallback(error, "outbox error");
    assertNonNegativeInteger(nextAttemptAt, "nextAttemptAt");
    return this.db.transaction(() => {
      const outbox = this.outboxByKey(key);
      if (!outbox || !this.outboxLeaseIsActiveForRow(outbox, ownerId, generation, now)) return false;
      const status = outbox.attempts >= 20 ? "dead" : "failed";
      const updated = this.db
        .prepare(
          `UPDATE outbox SET status = ?, lease_owner = NULL, lease_generation = NULL,
             lease_expires_at = NULL, last_error = ?, next_attempt_at = ?, updated_at = ?
           WHERE logical_key = ? AND status = 'leased' AND lease_owner = ?
             AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(status, error, nextAttemptAt, now, key, ownerId, generation, now);
      // Exhausting 20 delivery attempts of a status card says Telegram is
      // unreachable, not that the work is unsound. See `deadLetterOutbox`.
      return updated.changes === 1;
    }).immediate();
  }

  public replaceOutboxWithDeliveryFailureNotice(input: OutboxDeliveryFailureNoticeInput): boolean {
    this.assertLeaseIdentity(input.logicalKey, input.ownerId, input.generation, input.now);
    assertSafeFailureSummary(input.error);
    assertNoRawMergeCallback(input.error, "outbox error");
    const payloadJson = serializeBoundedJson({
      text: CONTROLLER_FAILURE_TEXT.owner_message_delivery_exhausted,
      disable_web_page_preview: true,
    }, "outbox payload", MAX_MERGE_RESULT_JSON);
    return this.db.transaction(() => {
      const outbox = this.outboxByKey(input.logicalKey);
      if (!outbox || !this.outboxLeaseIsActiveForRow(
        outbox,
        input.ownerId,
        input.generation,
        input.now,
      )) return false;
      return this.db.prepare(
        `UPDATE outbox SET payload_json = ?, status = 'failed', attempts = 0,
           lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL,
           next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE logical_key = ? AND status = 'leased' AND lease_owner = ?
           AND lease_generation = ? AND lease_expires_at > ?`,
      ).run(
        payloadJson,
        input.now,
        input.error,
        input.now,
        input.logicalKey,
        input.ownerId,
        input.generation,
        input.now,
      ).changes === 1;
    }).immediate();
  }

  public deadLetterEffect(key: string, ownerId: string, generation: number, error: string, now: number): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    assertSafeFailureSummary(error);
    assertNoRawMergeCallback(error, "effect error");
    return this.db.transaction(() => {
      const effect = this.effectByKey(key);
      if (!effect || !this.effectLeaseIsActiveForRow(effect, ownerId, generation, now)) return false;
      const updated = this.db
        .prepare(
          `UPDATE effects SET status = 'dead', lease_owner = NULL, lease_generation = NULL,
             lease_expires_at = NULL, last_error = ?, updated_at = ?
           WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
             AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(error, now, key, ownerId, generation, now);
      if (updated.changes === 1) this.settleJobForDeadEffect(effect, error, now);
      return updated.changes === 1;
    }).immediate();
  }

  public deadLetterOutbox(key: string, ownerId: string, generation: number, error: string, now: number): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    assertSafeFailureSummary(error);
    assertNoRawMergeCallback(error, "outbox error");
    return this.db.transaction(() => {
      const outbox = this.outboxByKey(key);
      if (!outbox || !this.outboxLeaseIsActiveForRow(outbox, ownerId, generation, now)) return false;
      const updated = this.db
        .prepare(
          `UPDATE outbox SET status = 'dead', lease_owner = NULL, lease_generation = NULL,
             lease_expires_at = NULL, last_error = ?, updated_at = ?
           WHERE logical_key = ? AND status = 'leased' AND lease_owner = ?
             AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(error, now, key, ownerId, generation, now);
      // The only job-bound outbox is the Telegram status card, which is a
      // redraw of state the job already holds. Failing the job over it loses
      // real work to a cosmetic delivery error, and tells the owner nothing:
      // the block enqueues another status render, which fails the same way.
      return updated.changes === 1;
    }).immediate();
  }

  public getOutbox(logicalKey: string): StoredOutbox | null {
    if (!logicalKey) throw new TypeError("logicalKey must not be empty");
    const row = this.db.prepare("SELECT * FROM outbox WHERE logical_key = ?").get(logicalKey) as OutboxRow | undefined;
    return row ? parseOutbox(row) : null;
  }

  public listOutbox(limit: number): StoredOutbox[] {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
    const rows = this.db
      .prepare("SELECT * FROM outbox ORDER BY created_at ASC, logical_key ASC LIMIT ?")
      .all(limit) as OutboxRow[];
    return rows.map(parseOutbox);
  }

  public upsertWorkerLiveness(value: WorkerLiveness): void {
    if (!value.jobId || !value.resourceId) throw new TypeError("worker liveness identity is required");
    assertPositiveInteger(value.generation, "generation");
    assertNonNegativeInteger(value.sourceUpdatedAt, "sourceUpdatedAt");
    assertNonNegativeInteger(value.observedAt, "observedAt");
    if (value.staleNotifiedAt !== null) assertNonNegativeInteger(value.staleNotifiedAt, "staleNotifiedAt");
    this.db
      .prepare(
        `INSERT INTO worker_liveness (
           job_id, worker_kind, resource_kind, resource_id, generation, state,
           source_updated_at, observed_at, stale_notified_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id, resource_id) DO UPDATE SET
           worker_kind = excluded.worker_kind,
           resource_kind = excluded.resource_kind,
           resource_id = excluded.resource_id,
           generation = excluded.generation,
           state = excluded.state,
           source_updated_at = excluded.source_updated_at,
           observed_at = excluded.observed_at,
           stale_notified_at = excluded.stale_notified_at
         WHERE worker_liveness.generation <= excluded.generation`,
      )
      .run(
        value.jobId,
        value.workerKind,
        value.resourceKind,
        value.resourceId,
        value.generation,
        value.state,
        value.sourceUpdatedAt,
        value.observedAt,
        value.staleNotifiedAt,
      );
  }

  public upsertExecutorWorkerLiveness(input: ExecutorWorkerLivenessInput): boolean {
    this.assertExecutorFence(input);
    this.validateWorkerLiveness(input.value);
    const upsert = this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const value = input.value;
      const updated = this.db
        .prepare(
          `INSERT INTO worker_liveness (
             job_id, worker_kind, resource_kind, resource_id, generation, state,
             source_updated_at, observed_at, stale_notified_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id, resource_id) DO UPDATE SET
             worker_kind = excluded.worker_kind,
             resource_kind = excluded.resource_kind,
             resource_id = excluded.resource_id,
             generation = excluded.generation,
             state = excluded.state,
             source_updated_at = excluded.source_updated_at,
             observed_at = excluded.observed_at,
             stale_notified_at = excluded.stale_notified_at
           WHERE worker_liveness.generation <= excluded.generation`,
        )
        .run(
          value.jobId,
          value.workerKind,
          value.resourceKind,
          value.resourceId,
          value.generation,
          value.state,
          value.sourceUpdatedAt,
          value.observedAt,
          value.staleNotifiedAt,
        );
      return updated.changes === 1;
    });
    return upsert.immediate();
  }

  public getWorkerLiveness(jobId: string): WorkerLiveness | null {
    if (!jobId) throw new TypeError("jobId must not be empty");
    const row = this.db
      .prepare(
        `SELECT job_id, worker_kind, resource_kind, resource_id, generation, state,
                source_updated_at, observed_at, stale_notified_at
           FROM worker_liveness WHERE job_id = ?
          ORDER BY observed_at DESC, resource_id ASC LIMIT 1`,
      )
      .get(jobId) as WorkerLivenessRow | undefined;
    return row ? parseWorkerLiveness(row) : null;
  }

  public getWorkerLivenessForResource(jobId: string, resourceId: string): WorkerLiveness | null {
    if (!jobId || !resourceId) throw new TypeError("worker liveness identity is required");
    const row = this.db.prepare(
      `SELECT job_id, worker_kind, resource_kind, resource_id, generation, state,
              source_updated_at, observed_at, stale_notified_at
         FROM worker_liveness WHERE job_id = ? AND resource_id = ?`,
    ).get(jobId, resourceId) as WorkerLivenessRow | undefined;
    return row ? parseWorkerLiveness(row) : null;
  }

  public getCurrentWorkerLiveness(jobId: string): WorkerLiveness[] | null {
    if (!jobId) throw new TypeError("jobId must not be empty");
    const job = this.readJobById(jobId);
    if (!job) return [];
    if (job.state !== "reviewing" && job.state !== "final_reviewing") {
      const latest = this.getWorkerLiveness(jobId);
      return latest ? [latest] : [];
    }
    if (!job.reviewThreadId) return null;
    const quality = this.getAttemptByThreadId(job.reviewThreadId);
    if (!quality || quality.kind !== "review" || quality.jobId !== job.id ||
      quality.reviewStage === null || quality.reviewLens !== "quality") return null;
    const attempts = this.listReviewAttempts(job.id, quality.reviewStage, quality.ordinal);
    const expectedCount = job.deliveryMode === "small_fix" ? 1 : 2;
    if (attempts.length !== expectedCount || attempts.some((attempt) => attempt.threadId === null)) return null;
    const workers = attempts.map((attempt) => this.getWorkerLivenessForResource(job.id, attempt.threadId!));
    return workers.some((worker) => worker === null) ? null : workers as WorkerLiveness[];
  }

  public getWorkerRecovery(id: string): WorkerRecoveryRecord | null {
    assertControllerIdentifier(id, "worker recovery id");
    const row = this.db.prepare("SELECT * FROM worker_recoveries WHERE id = ?").get(id) as WorkerRecoveryRow | undefined;
    return row ? parseWorkerRecovery(row) : null;
  }

  public registerExecutorWorkerRecovery(input: ExecutorFence & Readonly<{
    id: string;
    jobId: string;
    expectedVersion: number;
    projectId: string;
    jobState: JobState;
    workerKind: WorkerKind;
    resourceId: string;
    workerGeneration: number;
    classification: WorkerRecoveryClassification;
    signature: string;
    retryLimit: number;
  }>): WorkerRecoveryRegistration | null {
    this.assertExecutorFence(input);
    assertControllerIdentifier(input.id, "worker recovery id");
    assertControllerIdentifier(input.jobId, "worker recovery job id");
    assertControllerIdentifier(input.projectId, "worker recovery project id");
    assertControllerIdentifier(input.resourceId, "worker recovery resource id");
    assertPositiveInteger(input.expectedVersion, "expectedVersion");
    assertPositiveInteger(input.workerGeneration, "workerGeneration");
    assertPositiveInteger(input.retryLimit, "retryLimit");
    if (input.retryLimit > 5) throw new TypeError("retryLimit must not exceed 5");
    assertBoundedString(input.signature, "worker recovery signature", 200);
    assertNoRawMergeCallback(input.signature, "worker recovery signature");

    const register = this.db.transaction((): WorkerRecoveryRegistration | null => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return null;
      const job = this.readJobById(input.jobId);
      if (!job || job.version !== input.expectedVersion || job.projectId !== input.projectId || job.state !== input.jobState) {
        return null;
      }
      const existing = this.db.prepare(
        `SELECT * FROM worker_recoveries
          WHERE job_id = ? AND resource_id = ? AND worker_generation = ? AND signature = ?`,
      ).get(input.jobId, input.resourceId, input.workerGeneration, input.signature) as WorkerRecoveryRow | undefined;
      if (existing) return { action: "already_recorded", record: parseWorkerRecovery(existing) };

      const recoveredSignature = input.classification === "crash" && this.db.prepare(
        `SELECT 1 FROM worker_recoveries
          WHERE project_id = ? AND worker_kind = ? AND signature = ? AND state = 'recovered'
          LIMIT 1`,
      ).get(input.projectId, input.workerKind, input.signature) !== undefined;
      const previousAutomatic = this.db.prepare(
        `SELECT COUNT(*) AS count FROM worker_recoveries
          WHERE job_id = ? AND job_state = ? AND worker_kind = ? AND action = 'auto_retry'`,
      ).get(input.jobId, input.jobState, input.workerKind) as { count: number };
      const silent = input.classification !== "crash";
      const action: WorkerRecoveryAction = (silent || recoveredSignature) && previousAutomatic.count < input.retryLimit
        ? "auto_retry"
        : "owner_required";
      const state: WorkerRecoveryState = action === "auto_retry" ? "detected" : "owner_required";
      this.db.prepare(
        `INSERT INTO worker_recoveries (
           id, job_id, project_id, job_state, worker_kind, resource_id,
           worker_generation, classification, signature, action, state,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.jobId,
        input.projectId,
        input.jobState,
        input.workerKind,
        input.resourceId,
        input.workerGeneration,
        input.classification,
        input.signature,
        action,
        state,
        input.now,
        input.now,
      );
      const stored = this.getWorkerRecovery(input.id);
      if (!stored) throw new Error("worker recovery was not stored");
      return { action, record: stored };
    });
    return register.immediate();
  }

  public markExecutorWorkerRecoveryRetiring(input: ExecutorFence & Readonly<{ id: string }>): boolean {
    this.assertExecutorFence(input);
    assertControllerIdentifier(input.id, "worker recovery id");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      return this.db.prepare(
        `UPDATE worker_recoveries SET state = 'retiring', updated_at = ?
          WHERE id = ? AND action = 'auto_retry' AND state = 'detected'`,
      ).run(input.now, input.id).changes === 1;
    }).immediate();
  }

  public markExecutorWorkerRecoveryRequeued(input: ExecutorFence & Readonly<{ id: string }>): boolean {
    this.assertExecutorFence(input);
    assertControllerIdentifier(input.id, "worker recovery id");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      return this.db.prepare(
        `UPDATE worker_recoveries SET state = 'requeued', updated_at = ?
          WHERE id = ? AND state IN ('detected', 'retiring', 'owner_required')`,
      ).run(input.now, input.id).changes === 1;
    }).immediate();
  }

  public markExecutorWorkerRecoveryRecovered(input: ExecutorFence & Readonly<{ jobId: string }>): number {
    this.assertExecutorFence(input);
    assertControllerIdentifier(input.jobId, "worker recovery job id");
    return this.db.transaction((): number => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return 0;
      return this.db.prepare(
        `UPDATE worker_recoveries
            SET state = 'recovered', resolved_at = ?, updated_at = ?
          WHERE job_id = ? AND state = 'requeued'`,
      ).run(input.now, input.now, input.jobId).changes;
    }).immediate();
  }

  public markWorkerLivenessNotified(jobId: string, generation: number, now: number, resourceId?: string): boolean {
    if (!jobId) throw new TypeError("jobId must not be empty");
    assertPositiveInteger(generation, "generation");
    assertNonNegativeInteger(now, "now");
    return this.db
      .prepare(
        `UPDATE worker_liveness SET stale_notified_at = ?
           WHERE job_id = ? AND generation = ?
             AND (? IS NULL OR resource_id = ?)
             AND state IN ('stale', 'unknown') AND stale_notified_at IS NULL`,
      )
      .run(now, jobId, generation, resourceId ?? null, resourceId ?? null).changes > 0;
  }

  public markExecutorWorkerLivenessNotified(input: ExecutorFence & Readonly<{ jobId: string; workerGeneration: number; resourceId?: string }>): boolean {
    this.assertExecutorFence(input);
    if (!input.jobId) throw new TypeError("jobId must not be empty");
    assertPositiveInteger(input.workerGeneration, "workerGeneration");
    const mark = this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      return this.db
        .prepare(
          `UPDATE worker_liveness SET stale_notified_at = ?
             WHERE job_id = ? AND generation = ? AND state IN ('stale', 'unknown') AND stale_notified_at IS NULL
               AND (? IS NULL OR resource_id = ?)
               AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1
                 AND owner_id = ? AND generation = ? AND lease_expires_at > ?)`,
        )
        .run(
          input.now,
          input.jobId,
          input.workerGeneration,
          input.resourceId ?? null,
          input.resourceId ?? null,
          input.ownerId,
          input.generation,
          input.now,
        ).changes > 0;
    });
    return mark.immediate();
  }

  public clearWorkerLiveness(jobId: string, generation: number): boolean {
    if (!jobId) throw new TypeError("jobId must not be empty");
    assertPositiveInteger(generation, "generation");
    return this.db
      .prepare("DELETE FROM worker_liveness WHERE job_id = ? AND generation = ?")
      .run(jobId, generation).changes > 0;
  }

  public clearExecutorWorkerLiveness(input: ExecutorFence & Readonly<{ jobId: string; workerGeneration: number }>): boolean {
    this.assertExecutorFence(input);
    if (!input.jobId) throw new TypeError("jobId must not be empty");
    assertPositiveInteger(input.workerGeneration, "workerGeneration");
    const clear = this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      return this.db
        .prepare(
          `DELETE FROM worker_liveness
             WHERE job_id = ? AND generation = ?
               AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1
                 AND owner_id = ? AND generation = ? AND lease_expires_at > ?)`,
        )
        .run(input.jobId, input.workerGeneration, input.ownerId, input.generation, input.now).changes > 0;
    });
    return clear.immediate();
  }

  public bindMergeEffectReceipt(input: {
    jobId: string;
    effectIdempotencyKey: string;
    receipt: DurableMergeReceipt;
    leaseOwner: string;
    leaseGeneration: number;
    now: number;
  }): boolean {
    if (!input.jobId || !input.effectIdempotencyKey || !input.leaseOwner) {
      throw new TypeError("merge receipt binding identity is required");
    }
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    assertNonNegativeInteger(input.now, "now");
    const receipt = parseDurableMergeReceipt(input.receipt);
    const bind = this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.leaseOwner, input.leaseGeneration, input.now)) return false;
      const boundaryNow = this.currentNow();
      const effect = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!effect || effect.kind !== "merge_pr" || !this.effectLeaseIsActive(effect, input.leaseOwner, input.leaseGeneration, boundaryNow)) return false;
      let pending: PendingMergeEffectPayload;
      try {
        pending = parsePendingMergeEffectPayload(JSON.parse(effect.payload_json));
      } catch {
        return false;
      }
      const job = this.readJobById(input.jobId);
      const approval = this.readApproval(pending.approvalNonceHash);
      if (!job || job.state !== "merging" || job.cancelRequestedAt !== null || !approval) return false;
      if (
        receipt.jobId !== input.jobId ||
        receipt.effectIdempotencyKey !== input.effectIdempotencyKey ||
        receipt.headSha !== pending.headSha ||
        receipt.reviewAttemptId !== pending.reviewAttemptId ||
        receipt.approvalNonceHash !== pending.approvalNonceHash ||
        receipt.approvalOwnerUserId !== pending.approvalOwnerUserId ||
        receipt.approvalOwnerChatId !== pending.approvalOwnerChatId ||
        receipt.approvalJobVersion !== pending.approvalJobVersion ||
        Date.parse(receipt.expiresAt) !== pending.approvalExpiresAt
      ) return false;
      if (this.mergeReceiptBindingError(effect, { headSha: receipt.headSha, receipt }, job, approval, boundaryNow) !== null) return false;
      const updated = this.db
        .prepare(
          `UPDATE effects SET payload_json = ?, updated_at = ?
             WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
               AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(
          serializeBoundedJson({ headSha: receipt.headSha, receipt }, "merge effect payload", MAX_MERGE_RESULT_JSON),
          boundaryNow,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          boundaryNow,
        );
      return updated.changes === 1;
    });
    return bind.immediate();
  }

  public prepareMergeCall(input: {
    jobId: string;
    effectIdempotencyKey: string;
    leaseOwner: string;
    leaseGeneration: number;
    now: number;
  }): MergeCallPreparation {
    if (!input.jobId || !input.effectIdempotencyKey || !input.leaseOwner) {
      throw new TypeError("merge call fence identity is required");
    }
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    assertNonNegativeInteger(input.now, "now");

    const prepare = this.db.transaction((): MergeCallPreparation => {
      if (!this.executorLeaseIsCurrent(input.leaseOwner, input.leaseGeneration, input.now)) {
        return { ok: false, reason: "executor lease is missing, stale, or expired" };
      }
      const boundaryNow = this.currentNow();
      const row = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!row) return { ok: false, reason: "durable merge effect was not found" };
      if (row.kind !== "merge_pr") return { ok: false, reason: "durable effect is not merge_pr" };
      if (
        row.status !== "leased" ||
        row.lease_owner !== input.leaseOwner ||
        row.lease_generation !== input.leaseGeneration ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= boundaryNow
      ) {
        return { ok: false, reason: "merge effect lease is missing, stale, or expired" };
      }

      let payload: MergeEffectPayload;
      try {
        payload = parseMergeEffectPayload(JSON.parse(row.payload_json));
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? `invalid durable merge effect: ${error.message}` : "invalid durable merge effect" };
      }
      const job = this.readJobById(row.job_id);
      if (!job) return { ok: false, reason: "merge effect job was not found" };
      const approval = this.readApproval(payload.receipt.approvalNonceHash);
      const bindingError = this.mergeReceiptBindingError(row, payload, job, approval, boundaryNow);
      if (bindingError) return { ok: false, reason: bindingError };
      if (!this.mergeClaimsAreCurrentInTransaction(job, input.leaseOwner, input.leaseGeneration, boundaryNow)) {
        return { ok: false, reason: "merge resource claim is missing, stale, or owned by another job" };
      }

      if (payload.mergeCallStartedAt !== undefined) {
        return {
          ok: true,
          shouldCallProvider: false,
          effect: parseEffect(row),
          job,
          receipt: payload.receipt,
        };
      }

      const markedPayload: MergeEffectPayload = {
        ...payload,
        mergeCallStartedAt: boundaryNow,
        mergeCallOutcome: "unknown",
      };
      const payloadJson = serializeBoundedJson(markedPayload, "merge effect payload", MAX_MERGE_RESULT_JSON);
      const marked = this.db
        .prepare(
          `UPDATE effects SET payload_json = ?, updated_at = ?
             WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
               AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(
          payloadJson,
          boundaryNow,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          boundaryNow,
        );
      if (marked.changes !== 1) return { ok: false, reason: "merge effect lease changed before provider call" };
      const markedRow = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!markedRow) return { ok: false, reason: "merge effect fence was not persisted" };
      return {
        ok: true,
        shouldCallProvider: true,
        effect: parseEffect(markedRow),
        job,
        receipt: payload.receipt,
      };
    });
    return prepare.immediate();
  }

  public rejectApprovalAndRecordCallback(input: {
    nonceHash: string;
    callbackId: string;
    jobId: string | null;
    now: number;
    headSha?: string;
  }): ApprovalRejectionResult {
    assertSha256Hex(input.nonceHash);
    if (!input.callbackId) throw new TypeError("callbackId must not be empty");
    assertNonNegativeInteger(input.now, "now");
    if (input.headSha !== undefined) assertFullSha(input.headSha, "headSha");
    assertNoRawMergeCallback(input.callbackId, "callbackId");
    if (input.jobId !== null) assertNoRawMergeCallback(input.jobId, "callback job id");
    const reject = this.db.transaction((): ApprovalRejectionResult => {
      const boundaryNow = this.currentNow();
      const previous = this.db
        .prepare("SELECT outcome FROM callbacks WHERE callback_query_id = ?")
        .get(input.callbackId) as { outcome: string } | undefined;
      if (previous) {
        return { outcome: previous.outcome === "accepted" ? "accepted" : "rejected", callbackRecorded: false };
      }

      const approval = this.readApproval(input.nonceHash);
      const acceptedIdentity = approval?.outcome === "accepted" && approval.consumed_at !== null
        ? this.findAcceptedMergeCallbackIdentity(approval.job_id, approval.head_sha, input.nonceHash)
        : null;
      if (approval && acceptedIdentity) {
        const recorded = this.insertCallback(
          input.callbackId,
          approval.job_id,
          "merge",
          "accepted",
          boundaryNow,
          acceptedIdentity,
        );
        return { outcome: "accepted", callbackRecorded: recorded };
      }

      const jobId = input.jobId ?? approval?.job_id ?? null;
      if (approval?.consumed_at === null) {
        this.db
          .prepare(
            `UPDATE approvals SET consumed_at = ?, outcome = 'revoked'
               WHERE nonce_hash = ? AND consumed_at IS NULL`,
          )
          .run(boundaryNow, input.nonceHash);
        const job = approval ? this.readJobById(approval.job_id) : null;
        if (job?.state === "awaiting_merge_approval") {
          const transitioned = transition(job, {
            type: "APPROVAL_STALE",
            ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
          }, boundaryNow);
          persistJobTransition(this.db, job.id, job.version, transitioned.job);
          persistPendingEffects(this.db, transitioned.effects, boundaryNow);
        }
      } else if (approval?.outcome === "accepted") {
        this.db
          .prepare("UPDATE approvals SET outcome = 'revoked' WHERE nonce_hash = ?")
          .run(input.nonceHash);
      }

      const recorded = this.insertCallback(input.callbackId, jobId, "merge", "rejected", boundaryNow);
      return { outcome: "rejected", callbackRecorded: recorded };
    });
    return reject();
  }

  public createApproval(input: {
    nonceHash: string;
    jobId: string;
    headSha: string;
    expiresAt: number;
    now: number;
    ownerUserId?: string | null;
    ownerChatId?: string | null;
    jobVersion?: number | null;
  }): void {
    this.validateApprovalInput(input);
    const create = this.db.transaction(() => this.createApprovalInTransaction(input));
    create();
  }

  public getUsableApproval(nonceHash: string, now: number): ApprovalRecord | null {
    assertSha256Hex(nonceHash);
    assertNonNegativeInteger(now, "now");
    const usable = this.db.transaction((): ApprovalRecord | null => {
      const boundaryNow = this.currentNow();
      const row = this.readApproval(nonceHash);
      if (!row || row.consumed_at !== null || boundaryNow >= row.expires_at) return null;
      if (!this.approvalIsCurrent(row, undefined)) {
        this.db
          .prepare(
            `UPDATE approvals SET consumed_at = ?, outcome = 'revoked'
               WHERE nonce_hash = ? AND consumed_at IS NULL`,
          )
          .run(boundaryNow, nonceHash);
        return null;
      }
      return {
        jobId: row.job_id,
        headSha: row.head_sha,
        expiresAt: row.expires_at,
        jobVersion: row.job_version,
        ownerUserId: row.owner_user_id,
        ownerChatId: row.owner_chat_id,
      };
    });
    return usable();
  }

  public getApproval(nonceHash: string): ApprovalState | null {
    assertSha256Hex(nonceHash);
    const row = this.readApproval(nonceHash);
    return row
      ? {
          jobId: row.job_id,
          headSha: row.head_sha,
          expiresAt: row.expires_at,
          jobVersion: row.job_version,
          ownerUserId: row.owner_user_id,
          ownerChatId: row.owner_chat_id,
          consumedAt: row.consumed_at,
          outcome: row.outcome,
        }
      : null;
  }

  public consumeApproval(input: {
    nonceHash: string;
    now: number;
    identity?: ApprovalIdentity;
  }): ApprovalConsumeResult {
    assertSha256Hex(input.nonceHash);
    assertNonNegativeInteger(input.now, "now");
    const consume = this.db.transaction((): ApprovalConsumeResult => {
      const boundaryNow = this.currentNow();
      const row = this.readApproval(input.nonceHash);
      if (!row) return { ok: false, reason: "missing" };
      if (row.consumed_at !== null) {
        return row.outcome !== null && row.outcome !== "consumed" && row.outcome !== "accepted"
          ? { ok: false, reason: "revoked" }
          : { ok: false, reason: "consumed" };
      }
      if (boundaryNow >= row.expires_at) return { ok: false, reason: "expired" };
      if (!this.approvalIsCurrent(row, input.identity)) {
        this.db
          .prepare(
            `UPDATE approvals SET consumed_at = ?, outcome = 'revoked'
               WHERE nonce_hash = ? AND consumed_at IS NULL`,
          )
          .run(boundaryNow, input.nonceHash);
        return { ok: false, reason: "revoked" };
      }

      const updated = this.db
        .prepare(
          `UPDATE approvals
              SET consumed_at = ?, outcome = 'consumed'
            WHERE nonce_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(boundaryNow, input.nonceHash, boundaryNow);
      if (updated.changes !== 1) {
        const current = this.readApproval(input.nonceHash);
        return current?.consumed_at !== null
          ? { ok: false, reason: "consumed" }
          : { ok: false, reason: "expired" };
      }
      return { ok: true, jobId: row.job_id, headSha: row.head_sha, expiresAt: row.expires_at };
    });
    return consume();
  }

  public acceptApprovalAndEnqueueMerge(input: {
    nonceHash: string;
    expectedJobVersion: number;
    effect: JobEffect;
    now: number;
    identity?: ApprovalIdentity;
  }): ApprovalAcceptResult {
    assertSha256Hex(input.nonceHash);
    if (!Number.isInteger(input.expectedJobVersion) || input.expectedJobVersion < 1) {
      throw new TypeError("expectedJobVersion must be a positive integer");
    }
    assertNonNegativeInteger(input.now, "now");
    if (
      input.effect.kind !== "merge_pr" ||
      input.effect.jobId.length === 0 ||
      input.effect.idempotencyKey.length === 0
    ) {
      throw new TypeError("approval acceptance requires one merge_pr effect");
    }

    const accept = this.db.transaction((): ApprovalAcceptResult => {
      const boundaryNow = this.currentNow();
      const row = this.readApproval(input.nonceHash);
      if (!row) return { ok: false, reason: "missing" };
      if (row.consumed_at !== null) {
        if (row.outcome === "accepted") {
          const current = this.readJobById(row.job_id);
          const expectedKey = `${row.job_id}:${(row.job_version ?? input.expectedJobVersion) + 1}:merge_pr`;
          const existing = this.readEffect(row.job_id, expectedKey);
          if (!current || !existing) throw new Error("accepted approval is missing its durable merge effect");
          if (input.effect.idempotencyKey !== expectedKey || input.effect.jobId !== row.job_id) {
            throw new Error("accepted merge effect idempotency key does not match the generated key");
          }
          let existingPayload: MergeEffectPayload | PendingMergeEffectPayload;
          let suppliedPayload: MergeEffectPayload | PendingMergeEffectPayload;
          try {
            const existingRaw = JSON.parse(existing.payload_json) as Record<string, unknown>;
            existingPayload = Object.prototype.hasOwnProperty.call(existingRaw, "receipt")
              ? parseMergeEffectPayload(existingRaw)
              : parsePendingMergeEffectPayload(existingRaw);
            const suppliedRaw = input.effect.payload as Record<string, unknown>;
            if (Object.prototype.hasOwnProperty.call(suppliedRaw, "receipt")) {
              suppliedPayload = parseMergeEffectPayload(suppliedRaw);
            } else if (Object.keys(suppliedRaw).length === 1 && Object.prototype.hasOwnProperty.call(suppliedRaw, "headSha")) {
              if ("receipt" in existingPayload) throw new TypeError("accepted merge effect payload shape changed");
              suppliedPayload = {
                headSha: suppliedRaw.headSha as string,
                reviewAttemptId: existingPayload.reviewAttemptId,
                approvalNonceHash: input.nonceHash,
                approvalOwnerUserId: row.owner_user_id ?? "",
                approvalOwnerChatId: row.owner_chat_id ?? "",
                approvalJobVersion: row.job_version ?? input.expectedJobVersion,
                approvalExpiresAt: row.expires_at,
              };
            } else {
              suppliedPayload = parsePendingMergeEffectPayload(suppliedRaw);
            }
          } catch (error) {
            throw new Error(error instanceof Error ? `accepted merge effect is invalid: ${error.message}` : "accepted merge effect is invalid");
          }
          const existingMatches = "receipt" in existingPayload
            ? existingPayload.receipt.approvalNonceHash === input.nonceHash &&
              existingPayload.receipt.headSha === row.head_sha
            : existingPayload.approvalNonceHash === input.nonceHash &&
              existingPayload.headSha === row.head_sha &&
              existingPayload.reviewAttemptId.length > 0 &&
              existingPayload.approvalJobVersion === (row.job_version ?? input.expectedJobVersion);
          const suppliedMatches = "receipt" in suppliedPayload
            ? suppliedPayload.receipt.approvalNonceHash === input.nonceHash && suppliedPayload.receipt.headSha === row.head_sha
            : suppliedPayload.approvalNonceHash === input.nonceHash && suppliedPayload.headSha === row.head_sha;
          if (!existingMatches || !suppliedMatches || JSON.stringify(suppliedPayload) !== JSON.stringify(existingPayload)) {
            throw new Error("accepted merge effect payload does not match the approval");
          }
          return { ok: true, jobId: row.job_id, headSha: row.head_sha };
        }
        return row.outcome !== null && row.outcome !== "consumed"
          ? { ok: false, reason: "revoked" }
          : { ok: false, reason: "consumed" };
      }
      if (boundaryNow >= row.expires_at) return { ok: false, reason: "expired" };
      const current = this.readJobById(row.job_id);
      if (!current || current.version !== input.expectedJobVersion || row.job_version !== null && row.job_version !== input.expectedJobVersion) {
        return { ok: false, reason: "version_conflict" };
      }
      if (!this.approvalIsCurrent(row, input.identity)) {
        this.db
          .prepare(
            `UPDATE approvals SET consumed_at = ?, outcome = 'revoked'
               WHERE nonce_hash = ? AND consumed_at IS NULL`,
          )
          .run(boundaryNow, input.nonceHash);
        return { ok: false, reason: "revoked" };
      }
      if (current.state !== "awaiting_merge_approval" || input.effect.jobId !== row.job_id) {
        return { ok: false, reason: "version_conflict" };
      }

      const transitioned = transition(
        current,
        { type: "APPROVAL_ACCEPTED", headSha: row.head_sha },
        boundaryNow,
      );
      const generated = transitioned.effects.filter((effect) => effect.kind === "merge_pr");
      if (generated.length !== 1) throw new Error("approval acceptance did not generate exactly one merge effect");
      const generatedEffect = generated[0];
      if (
        input.effect.idempotencyKey !== generatedEffect.idempotencyKey ||
        input.effect.jobId !== generatedEffect.jobId ||
        input.effect.kind !== generatedEffect.kind
      ) {
        throw new Error("caller-supplied merge effect does not use the exact generated identity");
      }
      const rawPayload = input.effect.payload as Record<string, unknown>;
      let persistedPayload: MergeEffectPayload | PendingMergeEffectPayload;
      if (Object.prototype.hasOwnProperty.call(rawPayload, "receipt")) {
        const payload = parseMergeEffectPayload(rawPayload);
        if (payload.mergeCallStartedAt !== undefined || payload.mergeCallOutcome !== undefined) {
          throw new TypeError("a new merge effect cannot already have an external-call fence");
        }
        if (JSON.stringify(generatedEffect.payload) !== JSON.stringify({ headSha: payload.headSha })) {
          throw new TypeError("caller-supplied merge effect does not use the exact generated payload");
        }
        const receiptError = this.approvalReceiptBindingError(
          input.effect,
          payload,
          generatedEffect.idempotencyKey,
          current,
          row,
          input.nonceHash,
          boundaryNow,
        );
        if (receiptError) throw new TypeError(receiptError);
        persistedPayload = payload;
      } else {
        const headSha = rawPayload.headSha;
        if (Object.keys(rawPayload).length !== 1 || typeof headSha !== "string" || headSha !== row.head_sha) {
          throw new TypeError("caller-supplied pending merge effect does not use the exact generated head");
        }
        const reviewAttempt = this.db
          .prepare("SELECT id FROM attempts WHERE job_id = ? AND kind = 'review' AND head_sha = ? ORDER BY created_at DESC, id DESC LIMIT 1")
          .get(row.job_id, row.head_sha) as { id?: string } | undefined;
        persistedPayload = {
          headSha: row.head_sha,
          reviewAttemptId: reviewAttempt?.id ?? `review:${row.job_id}`,
          approvalNonceHash: input.nonceHash,
          approvalOwnerUserId: row.owner_user_id ?? input.identity?.userId ?? "",
          approvalOwnerChatId: row.owner_chat_id ?? input.identity?.chatId ?? "",
          approvalJobVersion: row.job_version ?? input.expectedJobVersion,
          approvalExpiresAt: row.expires_at,
        };
        parsePendingMergeEffectPayload(persistedPayload);
      }

      const consumed = this.db
        .prepare(
          `UPDATE approvals
              SET consumed_at = ?, outcome = 'accepted'
            WHERE nonce_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(boundaryNow, input.nonceHash, boundaryNow);
      if (consumed.changes !== 1) return { ok: false, reason: "consumed" };

      persistJobTransition(this.db, current.id, input.expectedJobVersion, transitioned.job);
      const effectPayloadJson = serializeBoundedJson(persistedPayload, "merge effect payload", MAX_MERGE_RESULT_JSON);
      const inserted = this.db
        .prepare(
          `INSERT INTO effects (
             idempotency_key, job_id, kind, payload_json, status, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, 'merge_pr', ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(
          generatedEffect.idempotencyKey,
          generatedEffect.jobId,
          effectPayloadJson,
          boundaryNow,
          boundaryNow,
          boundaryNow,
        );
      if (inserted.changes !== 1) throw new Error("durable merge effect insertion did not insert exactly one row");
      const otherEffects = transitioned.effects.filter((effect) => effect.kind !== "merge_pr");
      persistPendingEffects(this.db, otherEffects, boundaryNow);
      return { ok: true, jobId: row.job_id, headSha: row.head_sha };
    });
    return accept();
  }

  public revokeApprovals(jobId: string, reason: string, now: number): number {
    if (!jobId) throw new TypeError("jobId must not be empty");
    assertSafeFailureSummary(reason);
    assertNoRawMergeCallback(reason, "approval outcome");
    assertNonNegativeInteger(now, "now");
    return this.db
      .prepare(
        `UPDATE approvals
            SET consumed_at = ?, outcome = ?
          WHERE job_id = ? AND consumed_at IS NULL`,
      )
      .run(now, reason, jobId).changes;
  }

  private releaseUnknownMergeFence(input: {
    effect: EffectRow;
    payloadJson: string;
    boundaryNow: number;
    leaseOwner: string;
    leaseGeneration: number;
  }): boolean {
    const updated = this.db
      .prepare(
        `UPDATE effects SET payload_json = ?, status = 'pending', lease_owner = NULL,
           lease_generation = NULL, lease_expires_at = NULL, last_error = ?,
           next_attempt_at = ?, updated_at = ?
         WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
           AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
      )
      .run(
        input.payloadJson,
        UNKNOWN_MERGE_OUTCOME_REASON,
        input.boundaryNow,
        input.boundaryNow,
        input.effect.job_id,
        input.effect.idempotency_key,
        input.leaseOwner,
        input.leaseGeneration,
        input.boundaryNow,
      );
    if (updated.changes !== 1) return false;

    this.cancelUnknownMergeJob(input.effect.job_id, input.boundaryNow);
    return true;
  }

  private cancelUnknownMergeJob(jobId: string, boundaryNow: number): void {
    const job = this.db
      .prepare("SELECT state, cancel_requested_at, version FROM jobs WHERE id = ?")
      .get(jobId) as { state: string; cancel_requested_at: number | null; version: number } | undefined;
    if (job?.state === "merging" && job.cancel_requested_at !== null) {
      const cancelled = this.db
        .prepare(
          `UPDATE jobs SET state = 'cancelled', resume_state = NULL, last_error = NULL,
             version = ?, updated_at = ? WHERE id = ? AND state = 'merging' AND version = ?`,
        )
        .run(job.version + 1, boundaryNow, jobId, job.version);
      if (cancelled.changes === 1) {
        persistPendingEffects(this.db, [{
          idempotencyKey: `${jobId}:${job.version + 1}:render_status`,
          jobId,
          kind: "render_status",
          payload: {},
        }], boundaryNow);
      }
      this.db
        .prepare(
          `UPDATE approvals SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
             WHERE job_id = ? AND (outcome IS NULL OR outcome = 'accepted')`,
        )
        .run(boundaryNow, jobId);
    }
  }

  public completeMergeSuccess(input: MergeSuccessInput): boolean {
    assertSafeFailureSummary(input.message);
    assertNonNegativeInteger(input.now, "now");
    const persistedResult = parsePersistedMergeSuccessResult(input.result);
    const resultJson = serializeBoundedJson(persistedResult, "merge result", MAX_MERGE_RESULT_JSON);
    const complete = this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.leaseOwner, input.leaseGeneration, input.now)) return false;
      const boundaryNow = this.currentNow();
      const effect = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!effect) return false;
      if (effect.status === "done") {
        try {
          const persistedPayload = JSON.parse(effect.payload_json) as Record<string, unknown>;
          const payload = parsePersistedMergeEffectPayload(persistedPayload, "done");
          const storedResult = parsePersistedMergeSuccessResult(persistedPayload.mergeResult);
          const current = this.readJobById(input.jobId);
          if (!current || !mergeSuccessResultMatchesDurable(
            storedResult,
            effect,
            payload,
            current,
            this.readApproval(payload.receipt.approvalNonceHash),
            "post_merge",
          ) || !this.attemptResultMatches(
            payload.receipt.reviewAttemptId,
            input.jobId,
            payload.receipt.headSha,
            storedResult,
          )) return false;
        } catch {
          return false;
        }
        if (input.outbox) persistOutbox(this.db, input.outbox, serializeOutbox(input.outbox, boundaryNow), boundaryNow);
        return true;
      }
      if (!this.effectLeaseIsActive(effect, input.leaseOwner, input.leaseGeneration, boundaryNow)) return false;
      const current = this.readJobById(input.jobId);
      if (!current || current.state !== "merging" || current.cancelRequestedAt !== null) return false;
      let storedPayload: MergeEffectPayload;
      try {
        storedPayload = parseMergeEffectPayload(JSON.parse(effect.payload_json));
      } catch {
        return false;
      }
      const bindingError = this.mergeReceiptBindingError(
        effect,
        storedPayload,
        current,
        this.readApproval(storedPayload.receipt.approvalNonceHash),
        boundaryNow,
      );
      if (bindingError) return false;
      if (storedPayload.mergeCallStartedAt === undefined || storedPayload.mergeCallOutcome !== "unknown") return false;
      if (!mergeSuccessResultMatchesDurable(
        persistedResult,
        effect,
        storedPayload,
        current,
        this.readApproval(storedPayload.receipt.approvalNonceHash),
        "merging",
      )) return false;

      const attempt = this.getAttempt(storedPayload.receipt.reviewAttemptId);
      if (
        !attempt ||
        attempt.jobId !== input.jobId ||
        attempt.kind !== "review" ||
        attempt.headSha !== storedPayload.receipt.headSha
      ) return false;
      const updatedAttempt = this.db
        .prepare(
          `UPDATE attempts SET result_json = ?, completed_at = ?
             WHERE id = ? AND job_id = ? AND kind = 'review'`,
        )
        .run(resultJson, boundaryNow, storedPayload.receipt.reviewAttemptId, input.jobId);
      if (updatedAttempt.changes !== 1) throw new Error("merge result owning attempt was not updated");

      const transitioned = transition(current, {
        type: "MERGE_SUCCEEDED",
        message: input.message,
        mergeCommitSha: persistedResult.mergeCommit.oid,
        mergedAt: persistedResult.mergedAt,
        baseContentVerified: persistedResult.baseContentVerified,
      }, boundaryNow);
      const payloadJson = serializeBoundedJson({
        ...storedPayload,
        mergeResult: persistedResult,
      }, "merge effect result", MAX_MERGE_RESULT_JSON);

      persistJobTransition(this.db, input.jobId, current.version, transitioned.job);
      const updated = this.db
        .prepare(
          `UPDATE effects SET payload_json = ?, status = 'done', lease_owner = NULL,
             lease_generation = NULL, lease_expires_at = NULL, last_error = NULL,
             updated_at = ? WHERE job_id = ? AND idempotency_key = ?
               AND status = 'leased' AND lease_owner = ? AND lease_generation = ?
               AND lease_expires_at > ?`,
        )
        .run(
          payloadJson,
          boundaryNow,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          boundaryNow,
        );
      if (updated.changes !== 1) throw new Error("Merge effect completion lost its durable row");
      this.settleResourceClaimsInTransaction({
        jobId: current.id,
        ownerId: input.leaseOwner,
        generation: input.leaseGeneration,
        now: boundaryNow,
        reason: "merge_succeeded",
        resourceKinds: transitioned.job.state === "production_failed"
          ? ["repository_merge", "production_target"]
          : ["repository_merge"],
      });
      if (input.outbox) persistOutbox(this.db, input.outbox, serializeOutbox(input.outbox, boundaryNow), boundaryNow);
      persistPendingEffects(this.db, transitioned.effects, boundaryNow);
      return true;
    });
    return complete.immediate();
  }

  public preserveUnknownMergeEffect(input: {
    jobId: string;
    effectIdempotencyKey: string;
    now: number;
    leaseOwner: string;
    leaseGeneration: number;
  }): boolean {
    if (!input.jobId || !input.effectIdempotencyKey || !input.leaseOwner) {
      throw new TypeError("merge effect unknown-outcome identity is required");
    }
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    assertNonNegativeInteger(input.now, "now");
    const preserve = this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.leaseOwner, input.leaseGeneration, input.now)) return false;
      const boundaryNow = this.currentNow();
      const updated = this.db
        .prepare(
          `UPDATE effects SET status = 'pending', lease_owner = NULL,
             lease_generation = NULL, lease_expires_at = NULL,
             last_error = ?, next_attempt_at = ?, updated_at = ?
           WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
             AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(
          UNKNOWN_MERGE_OUTCOME_REASON,
          boundaryNow,
          boundaryNow,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          boundaryNow,
        );
      return updated.changes === 1;
    });
    return preserve.immediate();
  }

  public failLeasedMergeEffect(input: MergeFailureInput): boolean {
    if (!input.jobId || !input.effectIdempotencyKey || !input.leaseOwner) {
      throw new TypeError("merge effect failure identity is required");
    }
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    assertNonNegativeInteger(input.now, "now");
    void input.reason;

    const fail = this.db.transaction((): boolean => {
      const effect = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!effect || effect.kind !== "merge_pr") return false;
      const boundaryNow = this.currentNow();
      if (!this.effectLeaseIsActive(effect, input.leaseOwner, input.leaseGeneration, boundaryNow)) return false;
      const unknownPayloadJson = sanitizedUnknownMergePayload(effect.payload_json);
      if (unknownPayloadJson !== null) {
        return this.releaseUnknownMergeFence({
          effect,
          payloadJson: unknownPayloadJson,
          boundaryNow,
          leaseOwner: input.leaseOwner,
          leaseGeneration: input.leaseGeneration,
        });
      }
      const updated = this.db
        .prepare(
          `UPDATE effects SET payload_json = ?, status = 'failed', lease_owner = NULL,
             lease_generation = NULL, lease_expires_at = NULL, last_error = ?,
             next_attempt_at = ?, updated_at = ?
           WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
             AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(
          SAFE_FAILED_MERGE_PAYLOAD,
          SAFE_MERGE_FAILURE_REASON,
          boundaryNow,
          boundaryNow,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          boundaryNow,
        );
      if (updated.changes !== 1) return false;

      this.db
        .prepare(
          `UPDATE approvals SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
             WHERE job_id = ? AND (outcome IS NULL OR outcome = 'accepted')`,
        )
        .run(boundaryNow, input.jobId);

      const job = this.db
        .prepare("SELECT state, cancel_requested_at, version FROM jobs WHERE id = ?")
        .get(input.jobId) as { state: string; cancel_requested_at: number | null; version: number } | undefined;
      if (job?.state === "merging") {
        const cancelled = job.cancel_requested_at !== null;
        const nextVersion = job.version + 1;
        const changed = this.db
          .prepare(
            `UPDATE jobs SET state = ?, resume_state = ?, last_error = ?, version = ?, updated_at = ?
               WHERE id = ? AND state = 'merging' AND version = ?`,
          )
          .run(
            cancelled ? "cancelled" : "failed",
            cancelled ? null : "merging",
            cancelled ? null : SAFE_MERGE_FAILURE_REASON,
            nextVersion,
            boundaryNow,
            input.jobId,
            job.version,
          );
        if (changed.changes === 1) {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO effects (
                 idempotency_key, job_id, kind, payload_json, status, attempts,
               next_attempt_at, created_at, updated_at
             ) VALUES (?, ?, 'render_status', '{}', 'pending', 0, ?, ?, ?)`,
            )
            .run(`${input.jobId}:${nextVersion}:render_status`, input.jobId, boundaryNow, boundaryNow, boundaryNow);
        }
      }
      this.settleResourceClaimsInTransaction({
        jobId: input.jobId,
        ownerId: input.leaseOwner,
        generation: input.leaseGeneration,
        now: boundaryNow,
        reason: "premerge_rejected",
        resourceKinds: ["repository_merge", "production_target"],
      });
      return true;
    });
    return fail.immediate();
  }

  public failMergeEffect(input: MergeFailureInput): boolean {
    return this.failLeasedMergeEffect(input);
  }

  public staleMergeEffect(input: MergeStaleInput): boolean {
    assertSafeFailureSummary(input.reason);
    assertNoRawMergeCallback(input.reason, "merge stale reason");
    assertNonNegativeInteger(input.now, "now");
    const stale = this.db.transaction((): boolean => {
      const boundaryNow = this.currentNow();
      const effect = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!effect || effect.kind !== "merge_pr" || effect.status === "done") return false;
      if (!this.effectLeaseIsActive(effect, input.leaseOwner, input.leaseGeneration, boundaryNow)) return false;
      const unknownPayloadJson = sanitizedUnknownMergePayload(effect.payload_json);
      if (unknownPayloadJson !== null) {
        return this.releaseUnknownMergeFence({
          effect,
          payloadJson: unknownPayloadJson,
          boundaryNow,
          leaseOwner: input.leaseOwner,
          leaseGeneration: input.leaseGeneration,
        });
      }
      const current = this.readJobById(input.jobId);
      if (!current || current.state !== "merging") return false;
      if (current.prNumber === null) return false;

      let validPrUrl: string;
      try {
        validPrUrl = assertSafeExternalHttpsUrl(current.prUrl, "job.prUrl");
      } catch {
        const transitioned = current.cancelRequestedAt !== null
          ? transition(current, { type: "CANCEL_CONFIRMED" }, boundaryNow)
          : transition(current, { type: "FAILED", error: SAFE_MERGE_FAILURE_REASON }, boundaryNow);
        transitioned.job.prUrl = null;
        persistJobTransition(this.db, input.jobId, current.version, transitioned.job);
        this.db
          .prepare(
            `UPDATE approvals SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
               WHERE job_id = ? AND (outcome IS NULL OR outcome = 'accepted')`,
          )
          .run(boundaryNow, input.jobId);
        persistPendingEffects(this.db, transitioned.effects, boundaryNow);
        const cleaned = this.db
          .prepare(
            `UPDATE effects SET payload_json = ?, status = 'failed', lease_owner = NULL,
               lease_generation = NULL, lease_expires_at = NULL, last_error = ?,
               updated_at = ? WHERE job_id = ? AND idempotency_key = ?
               AND status = 'leased' AND lease_owner = ? AND lease_generation = ?
               AND lease_expires_at > ?`,
          )
          .run(
            SAFE_FAILED_MERGE_PAYLOAD,
            SAFE_MERGE_FAILURE_REASON,
            boundaryNow,
            input.jobId,
            input.effectIdempotencyKey,
            input.leaseOwner,
            input.leaseGeneration,
            boundaryNow,
        );
        if (cleaned.changes !== 1) throw new Error("Stale merge effect lost its durable row");
        this.settleResourceClaimsInTransaction({
          jobId: current.id,
          ownerId: input.leaseOwner,
          generation: input.leaseGeneration,
          now: boundaryNow,
          reason: "premerge_rejected",
          resourceKinds: ["repository_merge", "production_target"],
        });
        return true;
      }

      const next = structuredClone(current);
      const cancelled = current.cancelRequestedAt !== null;
      if (cancelled) {
        next.state = "cancelled";
        next.resumeState = null;
        next.lastError = null;
      } else {
        next.prHeadSha = null;
        next.state = "resolving_pr_head";
        next.lastError = input.reason;
      }
      next.version += 1;
      next.updatedAt = boundaryNow;
      persistJobTransition(this.db, input.jobId, current.version, next);
      this.db
        .prepare(
          `UPDATE approvals SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
             WHERE job_id = ? AND (outcome IS NULL OR outcome = 'accepted')`,
        )
        .run(boundaryNow, input.jobId);
      const effects: JobEffect[] = cancelled
        ? [{ idempotencyKey: `${input.jobId}:${next.version}:render_status`, jobId: input.jobId, kind: "render_status", payload: {} }]
        : [{
            idempotencyKey: `${input.jobId}:${next.version}:resolve_pr_head`,
            jobId: input.jobId,
            kind: "resolve_pr_head",
            payload: { number: current.prNumber, url: validPrUrl },
          }, {
            idempotencyKey: `${input.jobId}:${next.version}:render_status`,
            jobId: input.jobId,
            kind: "render_status",
            payload: {},
          }];
      persistPendingEffects(this.db, effects, boundaryNow);
      const stalePayloadJson = serializeBoundedJson({
        mergeOutcome: "stale",
        jobId: input.jobId,
        effectIdempotencyKey: input.effectIdempotencyKey,
      }, "stale merge effect payload", MAX_MERGE_RESULT_JSON);
      const updated = this.db
        .prepare(
          `UPDATE effects SET payload_json = ?, status = 'done', lease_owner = NULL,
             lease_generation = NULL, lease_expires_at = NULL, last_error = ?,
             updated_at = ? WHERE job_id = ? AND idempotency_key = ?
               AND status = 'leased' AND lease_owner = ? AND lease_generation = ?
               AND lease_expires_at > ?`,
        )
        .run(
          stalePayloadJson,
          input.reason,
          boundaryNow,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          boundaryNow,
        );
      if (updated.changes !== 1) throw new Error("Stale merge effect lost its durable row");
      this.settleResourceClaimsInTransaction({
        jobId: current.id,
        ownerId: input.leaseOwner,
        generation: input.leaseGeneration,
        now: boundaryNow,
        reason: "premerge_rejected",
        resourceKinds: ["repository_merge", "production_target"],
      });
      return true;
    });
    return stale.immediate();
  }

  public beginTelegramUpdate(updateId: number, now: number): "process" | "processed" {
    if (!Number.isInteger(updateId) || updateId < 0) throw new TypeError("updateId must be a non-negative integer");
    const begin = this.db.transaction((): "process" | "processed" => {
      const existing = this.db
        .prepare(
          "SELECT status, claim_owner, claim_generation, claim_expires_at FROM telegram_updates WHERE update_id = ?",
        )
        .get(updateId) as TelegramUpdateRow | undefined;
      if (existing?.status === "processed") return "processed";

      // Sequential ingress keeps this store's claimed handler in flight; tokenless
      // completion cannot safely distinguish a same-store reclaim from that handler.
      if (this.claimedUpdates.has(updateId)) return "processed";

      if (
        existing?.status === "processing" &&
        existing.claim_expires_at !== null &&
        existing.claim_expires_at > now
      ) {
        return "processed";
      }

      const generation = (existing?.claim_generation ?? 0) + 1;
      const expiresAt = now + TELEGRAM_UPDATE_LEASE_MS;
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO telegram_updates (
               update_id, status, attempts, outcome, last_error, processed_at,
               claim_owner, claim_generation, claim_expires_at
             ) VALUES (?, 'processing', 1, NULL, NULL, NULL, ?, ?, ?)`,
          )
          .run(updateId, this.claimOwner, generation, expiresAt);
      } else {
        this.db
          .prepare(
            `UPDATE telegram_updates
                SET status = 'processing', attempts = attempts + 1,
                    outcome = NULL, last_error = NULL, processed_at = NULL,
                    claim_owner = ?, claim_generation = ?, claim_expires_at = ?
              WHERE update_id = ?`,
          )
          .run(this.claimOwner, generation, expiresAt, updateId);
      }
      this.claimedUpdates.set(updateId, generation);
      return "process";
    });
    return begin();
  }

  public completeTelegramUpdate(updateId: number, outcome: string, now: number): void {
    assertSafeFailureSummary(outcome);
    assertNoRawMergeCallback(outcome, "Telegram update outcome");
    const claimGeneration = this.claimedUpdates.get(updateId);
    if (claimGeneration === undefined) {
      const existing = this.db.prepare(
        "SELECT status FROM telegram_updates WHERE update_id = ?",
      ).get(updateId) as { status: string } | undefined;
      if (existing?.status === "processed") {
        advanceTelegramCursor(this.db);
        return;
      }
      throw new UpdateClaimConflictError(updateId);
    }

    const complete = this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE telegram_updates
              SET status = 'processed', outcome = ?, last_error = NULL, processed_at = ?,
                  claim_owner = NULL, claim_expires_at = NULL
            WHERE update_id = ?
              AND status = 'processing'
              AND claim_owner = ?
              AND claim_generation = ?
              AND claim_expires_at > ?`,
        )
        .run(outcome, now, updateId, this.claimOwner, claimGeneration, now);
      if (updated.changes !== 1) {
        this.claimedUpdates.delete(updateId);
        throw new UpdateClaimConflictError(updateId);
      }
      advanceTelegramCursor(this.db);
    });
    complete();
    this.claimedUpdates.delete(updateId);
  }

  public failTelegramUpdate(updateId: number, error: string, now: number): void {
    assertSafeFailureSummary(error);
    assertNoRawMergeCallback(error, "Telegram update error");
    const claimGeneration = this.claimedUpdates.get(updateId);
    if (claimGeneration === undefined) throw new UpdateClaimConflictError(updateId);

    const fail = this.db.transaction(() => {
      const failed = this.db
        .prepare(
          `UPDATE telegram_updates
              SET status = 'failed', outcome = NULL, last_error = ?, processed_at = ?,
                  claim_owner = NULL, claim_expires_at = NULL
            WHERE update_id = ?
              AND status = 'processing'
              AND claim_owner = ?
              AND claim_generation = ?
              AND claim_expires_at > ?`,
        )
        .run(error, now, updateId, this.claimOwner, claimGeneration, now);
      if (failed.changes !== 1) {
        this.claimedUpdates.delete(updateId);
        throw new UpdateClaimConflictError(updateId);
      }
    });
    fail();
    this.claimedUpdates.delete(updateId);
  }

  // A durably failed update pins the cursor, so an update that cannot ever be
  // handled must be retired: the failure stays readable, but polling moves on.
  public abandonTelegramUpdate(updateId: number, error: string, now: number): void {
    assertSafeFailureSummary(error);
    assertNoRawMergeCallback(error, "Telegram update error");
    const claimGeneration = this.claimedUpdates.get(updateId);
    if (claimGeneration === undefined) throw new UpdateClaimConflictError(updateId);

    const abandon = this.db.transaction(() => {
      const abandoned = this.db
        .prepare(
          `UPDATE telegram_updates
              SET status = 'processed', outcome = 'abandoned', last_error = ?, processed_at = ?,
                  claim_owner = NULL, claim_expires_at = NULL
            WHERE update_id = ?
              AND status = 'processing'
              AND claim_owner = ?
              AND claim_generation = ?
              AND claim_expires_at > ?`,
        )
        .run(error, now, updateId, this.claimOwner, claimGeneration, now);
      if (abandoned.changes !== 1) {
        this.claimedUpdates.delete(updateId);
        throw new UpdateClaimConflictError(updateId);
      }
      advanceTelegramCursor(this.db);
    });
    abandon();
    this.claimedUpdates.delete(updateId);
  }

  public getTelegramUpdateAttempts(updateId: number): number {
    if (!Number.isInteger(updateId) || updateId < 0) throw new TypeError("updateId must be a non-negative integer");
    const row = this.db
      .prepare("SELECT attempts FROM telegram_updates WHERE update_id = ?")
      .get(updateId) as { attempts: number } | undefined;
    return row?.attempts ?? 0;
  }

  // Recovers a cursor left pinned by an update that failed under an earlier
  // build, so polling stops replaying a backlog it has already handled.
  public reconcileTelegramCursor(): void {
    this.db.transaction(() => advanceTelegramCursor(this.db)).immediate();
  }

  public getNextTelegramOffset(): number {
    const row = this.db
      .prepare("SELECT next_offset FROM telegram_cursor WHERE singleton = 1")
      .get() as { next_offset: number } | undefined;
    if (!row) throw new Error("Telegram cursor was not initialized");
    return row.next_offset;
  }

  public recordCallback(
    callbackId: string,
    jobId: string | null,
    action: string,
    outcome: string,
    now: number,
    completion?: MergeCallbackIdentity,
  ): boolean {
    if (!callbackId || !action || !outcome) throw new TypeError("Callback identity and outcome are required");
    assertNonNegativeInteger(now, "now");
    assertNoRawMergeCallback(callbackId, "callbackId");
    if (jobId !== null) assertNoRawMergeCallback(jobId, "callback job id");
    assertNoRawMergeCallback(action, "callback action");
    assertNoRawMergeCallback(outcome, "callback outcome");
    return this.insertCallback(callbackId, jobId, action, outcome, now, completion);
  }

  public getCallback(callbackId: string): CallbackRecord | null {
    if (!callbackId) throw new TypeError("callbackId must not be empty");
    const row = this.db
      .prepare(
        `SELECT callback_query_id, job_id, action, outcome, processed_at,
                approval_nonce_hash, head_sha, effect_idempotency_key
           FROM callbacks WHERE callback_query_id = ?`,
      )
      .get(callbackId) as CallbackRow | undefined;
    if (!row) return null;
    const callback: CallbackRecord = {
      callbackId: row.callback_query_id,
      jobId: row.job_id,
      action: row.action,
      outcome: row.outcome,
      processedAt: row.processed_at,
      approvalNonceHash: row.approval_nonce_hash,
      headSha: row.head_sha,
      effectIdempotencyKey: row.effect_idempotency_key,
    };
    if (
      callback.action !== "merge" ||
      callback.outcome !== "accepted" ||
      callback.approvalNonceHash !== null ||
      callback.headSha !== null ||
      callback.effectIdempotencyKey !== null ||
      callback.jobId === null
    ) return callback;
    try {
      const identity = this.findUniqueLegacyAcceptedCallbackIdentity(callback.jobId);
      return identity ? { ...callback, ...identity } : callback;
    } catch {
      return callback;
    }
  }

  public enqueueReconcileForThread(threadId: string, now: number): boolean {
    if (!threadId) throw new TypeError("threadId must not be empty");
    assertNonNegativeInteger(now, "now");
    return this.db.transaction(() => this.enqueueReconcileForKnownThread(threadId, now)).immediate();
  }

  public enqueueReconcileForEnvironment(environmentId: string, now: number): boolean {
    assertControllerIdentifier(environmentId, "environmentId");
    assertNonNegativeInteger(now, "now");
    return this.db.transaction((): boolean => {
      let queued = false;
      for (const threadId of this.workerThreadIdsForEnvironment(environmentId)) {
        queued = this.enqueueReconcileForKnownThread(threadId, now) || queued;
      }
      return queued;
    }).immediate();
  }

  public shouldWakeForThread(threadId: string): boolean {
    assertControllerIdentifier(threadId, "threadId");
    const row = this.db.prepare(
      `SELECT 1 AS ok WHERE EXISTS (
         SELECT 1 FROM controller_threads
          WHERE bb_thread_id = ? AND state <> 'revoked'
       ) OR EXISTS (
         SELECT 1 FROM jobs
          WHERE implementation_thread_id = ? OR review_thread_id = ?
       ) OR EXISTS (
         SELECT 1 FROM pipeline_stage_attempts WHERE thread_id = ?
       ) OR EXISTS (
         SELECT 1 FROM attempts WHERE kind = 'review' AND thread_id = ?
       ) OR EXISTS (
         SELECT 1 FROM monitors
          WHERE state = 'armed' AND kind = 'thread_idle' AND thread_id = ?
       ) OR EXISTS (
         SELECT 1 FROM delegation_threads dt
           JOIN delegations d ON d.id = dt.delegation_id
          WHERE dt.thread_id = ? AND d.state = 'open' AND dt.state = 'running'
       ) OR EXISTS (
         SELECT 1 FROM thread_interactions
          WHERE thread_id = ? AND state = 'pending'
       )`,
    ).get(threadId, threadId, threadId, threadId, threadId, threadId, threadId, threadId) as { ok: number } | undefined;
    return row !== undefined;
  }

  public shouldWakeForEnvironment(environmentId: string): boolean {
    assertControllerIdentifier(environmentId, "environmentId");
    const row = this.db.prepare(
      "SELECT 1 AS ok FROM jobs WHERE environment_id = ? LIMIT 1",
    ).get(environmentId) as { ok: number } | undefined;
    return row !== undefined;
  }

  private workerThreadIdsForEnvironment(environmentId: string): string[] {
    const jobRows = this.db.prepare(
      `${JOB_SELECT} WHERE environment_id = ?`,
    ).all(environmentId) as JobRow[];
    const threadIds = new Set<string>();
    for (const job of jobRows) {
      if (job.implementation_thread_id) threadIds.add(job.implementation_thread_id);
      if (job.review_thread_id) threadIds.add(job.review_thread_id);
    }
    const attemptRows = this.db.prepare(
      `SELECT thread_id FROM pipeline_stage_attempts
        WHERE job_id IN (SELECT id FROM jobs WHERE environment_id = ?)
          AND thread_id IS NOT NULL`,
    ).all(environmentId) as Array<{ thread_id: string }>;
    for (const attempt of attemptRows) threadIds.add(attempt.thread_id);
    const reviewRows = this.db.prepare(
      `SELECT thread_id FROM attempts
        WHERE kind = 'review'
          AND job_id IN (SELECT id FROM jobs WHERE environment_id = ?)
          AND thread_id IS NOT NULL`,
    ).all(environmentId) as Array<{ thread_id: string }>;
    for (const attempt of reviewRows) threadIds.add(attempt.thread_id);
    return [...threadIds];
  }

  private enqueueReconcileForKnownThread(threadId: string, now: number): boolean {
    const job = this.db
      .prepare(`${JOB_SELECT} WHERE implementation_thread_id = ? OR review_thread_id = ?
        OR id IN (SELECT job_id FROM pipeline_stage_attempts WHERE thread_id = ?)
        OR id IN (SELECT job_id FROM attempts WHERE kind = 'review' AND thread_id = ?)
        ORDER BY updated_at DESC LIMIT 1`)
      .get(threadId, threadId, threadId, threadId) as JobRow | undefined;
    if (!job) return false;
    const key = `reconcile:${job.id}:${threadId}`;
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO effects (
           idempotency_key, job_id, kind, payload_json, status, attempts,
           next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, 'reconcile_job', ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(
        key,
        job.id,
        serializeBoundedJson({ threadId }, "reconcile effect payload", MAX_MERGE_RESULT_JSON),
        now,
        now,
        now,
      );
    if (inserted.changes === 1) return true;
    return this.db
      .prepare(
        `UPDATE effects
            SET status = 'pending', attempts = 0, lease_owner = NULL,
                lease_generation = NULL, lease_expires_at = NULL,
                next_attempt_at = ?, last_error = NULL, updated_at = ?
          WHERE idempotency_key = ? AND status IN ('done', 'failed', 'dead')`,
      )
      .run(now, now, key).changes === 1;
  }

  private assertExecutorFence(input: ExecutorFence): void {
    if (!input.ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
  }

  private executorEvidenceGate(
    job: Job,
    event: JobEvent,
  ): { valid: boolean; completeReviewAttemptIds: string[] } {
    const pass = (completeReviewAttemptIds: string[] = []) => ({ valid: true, completeReviewAttemptIds });
    const fail = () => ({ valid: false, completeReviewAttemptIds: [] });

    if (event.type === "PLAN_READY") {
      const attempt = this.getPipelineStageAttempt(event.attemptId);
      const outcome = evidenceRecord(attempt?.outcome);
      return attempt && job.policy && attempt.jobId === job.id && attempt.role === "PLAN" && attempt.state === "completed" &&
          pipelineEvidenceHashMatches(attempt) && outcome?.verdict === "success" &&
          verificationEvidenceMatchesPolicy(outcome.verification, job.policy)
        ? pass()
        : fail();
    }

    if (event.type === "CRITIQUE_PASSED" || event.type === "CRITIQUE_NEEDS_REVISION") {
      const attempt = this.getPipelineStageAttempt(event.attemptId);
      const outcome = evidenceRecord(attempt?.outcome);
      const expectedVerdict = event.type === "CRITIQUE_PASSED" ? "pass" : "needs_revision";
      return attempt && attempt.jobId === job.id && attempt.role === "CRITIQUE" && attempt.state === "completed" &&
          pipelineEvidenceHashMatches(attempt) && outcome?.verdict === expectedVerdict &&
          typeof outcome.summary === "string" && outcome.summary.length > 0
        ? pass()
        : fail();
    }

    if (event.type === "PR_HEAD_RESOLVED") {
      const attempt = this.getLatestPipelineStageAttempt(job.id, "BUILD");
      const outcome = evidenceRecord(attempt?.outcome);
      return attempt && job.policy && attempt.state === "completed" && pipelineEvidenceHashMatches(attempt) &&
          attempt.endSha === event.headSha && outcome?.verdict === "success" &&
          outcome.prNumber === job.prNumber && outcome.headSha === event.headSha &&
          outcome.originRepository === job.policy.githubRepository.toLowerCase()
        ? pass()
        : fail();
    }

    if (event.type === "VALIDATION_PASSED") {
      const role = job.state === "final_validating" ? "FINAL_TEST" : "TEST";
      const attempt = this.getLatestPipelineStageAttempt(job.id, role);
      return attempt && validationEvidenceMatchesPolicy(attempt, job, event.headSha) ? pass() : fail();
    }

    if (event.type === "REVIEW_PASSED" || event.type === "REVIEW_CHANGES_REQUESTED") {
      const headSha = event.headSha;
      if (!job.reviewThreadId || !headSha || job.prHeadSha !== headSha) return fail();
      const quality = this.getAttemptByThreadId(job.reviewThreadId);
      const expectedStage = job.state === "final_reviewing" ? "final_review" : "review";
      if (!quality || quality.jobId !== job.id || quality.kind !== "review" || quality.reviewLens !== "quality" ||
          quality.reviewStage !== expectedStage || quality.headSha !== headSha) return fail();
      const attempts = this.listReviewAttempts(job.id, expectedStage, quality.ordinal);
      if (job.routingMode === "active" && !this.activeGuardEvidenceIsComplete(attempts)) return fail();
      const assessment = assessReviewGroup(
        attempts,
        job.deliveryMode,
        headSha,
      );
      if (event.type === "REVIEW_PASSED") {
        return assessment.outcome === "pass" ? pass(assessment.attemptIds) : fail();
      }
      const eventFindings = event.findings ?? [];
      const eventReasons = event.reasons ?? [];
      return assessment.outcome === "changes_requested" &&
          event.summary === assessment.summary &&
          JSON.stringify(eventFindings) === JSON.stringify(assessment.findings) &&
          JSON.stringify(eventReasons) === JSON.stringify(assessment.reasons)
        ? pass(assessment.attemptIds)
        : fail();
    }

    if (event.type === "DOCS_IDLE") {
      const attempt = this.getLatestPipelineStageAttempt(job.id, "DOCS");
      return attempt && attempt.jobId === job.id && attempt.threadId === job.documentationThreadId && docsEvidenceIsComplete(attempt)
        ? pass()
        : fail();
    }

    return pass();
  }

  private activeGuardEvidenceIsComplete(attempts: readonly AttemptRecord[]): boolean {
    for (const attempt of attempts) {
      const profile = this.getLatestCapabilityProfile("worker_attempt", attempt.id);
      if (!profile || profile.mode !== "active") return false;
      const guardAssignments = profile.assignments.filter((assignment) =>
        CAPABILITY_BY_ID.get(assignment.capabilityId)?.evidence.receiptType === "guard");
      if (guardAssignments.length === 0) continue;
      if (attempt.resultJson === null) return false;
      let raw: unknown;
      try {
        raw = JSON.parse(attempt.resultJson);
      } catch {
        return false;
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
      const result = raw as Record<string, unknown>;
      const envelope = guardResultEnvelopeSchema.safeParse(result.guardEnvelope);
      const policy = guardAssessmentPolicySchema.safeParse(result.guardPolicy);
      if (!envelope.success || !policy.success || policy.data.profileId !== profile.id ||
        policy.data.profileRevision !== profile.revision || envelope.data.profileId !== profile.id ||
        envelope.data.profileRevision !== profile.revision) return false;
      const policyById = new Map(policy.data.selectedGuards.map((guard) => [guard.capabilityId, guard]));
      const envelopeById = new Map(envelope.data.guards.map((guard) => [guard.capabilityId, guard]));
      if (policyById.size !== guardAssignments.length || envelopeById.size !== guardAssignments.length) return false;
      const receipts = this.listCapabilityReceipts(profile.id, 256)
        .filter((receipt) => receipt.eventType === "outcome");
      const receiptById = new Map(receipts.map((receipt) => [receipt.capabilityId, receipt]));
      for (const assignment of guardAssignments) {
        const selected = policyById.get(assignment.capabilityId);
        const terminal = envelopeById.get(assignment.capabilityId);
        const receipt = receiptById.get(assignment.capabilityId);
        if (!selected || !terminal || !receipt ||
          selected.descriptorDigest !== assignment.descriptorDigest || selected.mandatory !== assignment.mandatory ||
          terminal.descriptorDigest !== assignment.descriptorDigest ||
          receipt.descriptorDigest !== assignment.descriptorDigest || receipt.outcome !== terminal.outcome) return false;
      }
    }
    return true;
  }

  private markAdmissionDrainingForTerminal(job: Job, now: number): void {
    if (!isReleaseCandidate(job.state)) return;
    this.autonomyRepository.markDrainingInTransaction(job.id, now);
  }

  private enqueueFinishNoteInTransaction(previous: Job, completed: Job, now: number): void {
    if (previous.state === "complete" || completed.state !== "complete") return;
    const text = renderJobFinishNote(completed);
    const owner = this.getOwner();
    if (text === null || owner === null) return;
    if (completed.prUrl === null) return;
    assertSafeExternalHttpsUrl(completed.prUrl, "completed job PR URL");
    const item: OutboxInput = {
      logicalKey: `job:${completed.id}:finish`,
      chatId: owner.chatId,
      payload: { text, disable_web_page_preview: true },
    };
    const payloadJson = serializeOutbox(item, now);
    this.db.prepare(
      `INSERT OR IGNORE INTO outbox (
         logical_key, chat_id, message_id, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, NULL, ?, 'pending', 0, ?, ?, ?)`,
    ).run(item.logicalKey, item.chatId, payloadJson, now, now, now);
  }

  private markOwnerRecoveryRequeuedInTransaction(jobId: string, now: number): void {
    this.db.prepare(
      `UPDATE worker_recoveries SET state = 'requeued', updated_at = ?
        WHERE id = (
          SELECT id FROM worker_recoveries
           WHERE job_id = ? AND state = 'owner_required'
           ORDER BY created_at DESC, id DESC LIMIT 1
        )`,
    ).run(now, jobId);
  }

  private claimReviewFormatCorrectionInTransaction(
    attemptId: string,
    threadId: string,
    headSha: string,
    jobId?: string,
  ): boolean {
    const attempt = this.getAttempt(attemptId);
    if (!attempt || attempt.kind !== "review" ||
      (jobId !== undefined && attempt.jobId !== jobId) ||
      attempt.threadId !== threadId || attempt.headSha !== headSha) return false;
    let current: Record<string, unknown> = {};
    if (attempt.resultJson !== null) {
      try {
        const parsed = JSON.parse(attempt.resultJson);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
        current = parsed as Record<string, unknown>;
      } catch {
        return false;
      }
    }
    if (current.formatCorrectionSent === true) return false;
    const updated = jobId === undefined
      ? this.db
        .prepare("UPDATE attempts SET result_json = ? WHERE id = ? AND thread_id = ? AND head_sha = ?")
        .run(
          serializeBoundedJson({ ...current, formatCorrectionSent: true }, "attempt result", MAX_MERGE_RESULT_JSON),
          attemptId,
          threadId,
          headSha,
        )
      : this.db
        .prepare("UPDATE attempts SET result_json = ? WHERE id = ? AND job_id = ? AND thread_id = ? AND head_sha = ?")
        .run(
          serializeBoundedJson({ ...current, formatCorrectionSent: true }, "attempt result", MAX_MERGE_RESULT_JSON),
          attemptId,
          jobId,
          threadId,
          headSha,
        );
    return updated.changes === 1;
  }

  private validateAttemptPatch(patch: ExecutorAttemptPatch["patch"]): void {
    if (patch.headSha !== undefined && patch.headSha !== null) assertFullSha(patch.headSha, "headSha");
    if (patch.handoffSha256 !== undefined && patch.handoffSha256 !== null) assertSha256Hex(patch.handoffSha256);
    if (patch.completedAt !== undefined && patch.completedAt !== null) {
      assertNonNegativeInteger(patch.completedAt, "completedAt");
    }
  }

  private appendAttemptPatch(
    fields: string[],
    values: unknown[],
    patch: ExecutorAttemptPatch["patch"],
  ): void {
    if (patch.threadId !== undefined) { fields.push("thread_id = ?"); values.push(patch.threadId); }
    if (patch.headSha !== undefined) { fields.push("head_sha = ?"); values.push(patch.headSha); }
    if (patch.handoffPath !== undefined) { fields.push("handoff_path = ?"); values.push(patch.handoffPath); }
    if (patch.handoffSha256 !== undefined) { fields.push("handoff_sha256 = ?"); values.push(patch.handoffSha256); }
    if (patch.result !== undefined) {
      fields.push("result_json = ?");
      values.push(patch.result === null ? null : serializeBoundedJson(patch.result, "attempt result", MAX_MERGE_RESULT_JSON));
    }
    if (patch.completedAt !== undefined) { fields.push("completed_at = ?"); values.push(patch.completedAt); }
  }

  private validateApprovalInput(input: {
    nonceHash: string;
    jobId: string;
    headSha: string;
    expiresAt: number;
    now: number;
    jobVersion?: number | null;
  }): void {
    assertSha256Hex(input.nonceHash);
    assertFullSha(input.headSha, "headSha");
    assertNonNegativeInteger(input.now, "now");
    assertNonNegativeInteger(input.expiresAt, "expiresAt");
    if (input.expiresAt <= input.now) throw new TypeError("expiresAt must be after now");
    if (!input.jobId) throw new TypeError("jobId must not be empty");
    if (input.jobVersion !== null && input.jobVersion !== undefined) {
      if (!Number.isInteger(input.jobVersion) || input.jobVersion < 1) {
        throw new TypeError("jobVersion must be a positive integer");
      }
    }
  }

  private createApprovalInTransaction(input: {
    nonceHash: string;
    jobId: string;
    headSha: string;
    expiresAt: number;
    now: number;
    ownerUserId?: string | null;
    ownerChatId?: string | null;
    jobVersion?: number | null;
  }): void {
    const job = this.readJobById(input.jobId);
    if (!job) throw new Error(`Job ${input.jobId} was not found`);
    if (job.prHeadSha !== input.headSha) throw new VersionConflictError(input.jobId, job.version);

    const owner = this.getOwner();
    const ownerUserId = input.ownerUserId ?? owner?.userId ?? null;
    const ownerChatId = input.ownerChatId ?? owner?.chatId ?? null;
    if ((ownerUserId === null) !== (ownerChatId === null)) {
      throw new TypeError("Approval owner identity must include both user and chat ids");
    }
    if (ownerUserId !== null) assertCanonicalPositiveDecimal(ownerUserId, "ownerUserId");
    if (ownerChatId !== null) assertCanonicalPositiveDecimal(ownerChatId, "ownerChatId");

    this.db
      .prepare(
        `UPDATE approvals SET consumed_at = ?, outcome = 'superseded'
           WHERE job_id = ? AND consumed_at IS NULL`,
      )
      .run(input.now, input.jobId);
    this.db
      .prepare(
        `INSERT INTO approvals (
           nonce_hash, job_id, head_sha, expires_at, consumed_at, outcome,
           owner_user_id, owner_chat_id, job_version
         ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        input.nonceHash,
        input.jobId,
        input.headSha,
        input.expiresAt,
        ownerUserId,
        ownerChatId,
        input.jobVersion ?? job.version,
      );
  }

  private validateWorkerLiveness(value: WorkerLiveness): void {
    if (!value.jobId || !value.resourceId) throw new TypeError("worker liveness identity is required");
    assertPositiveInteger(value.generation, "generation");
    assertNonNegativeInteger(value.sourceUpdatedAt, "sourceUpdatedAt");
    assertNonNegativeInteger(value.observedAt, "observedAt");
    if (value.staleNotifiedAt !== null) assertNonNegativeInteger(value.staleNotifiedAt, "staleNotifiedAt");
  }

  private assertLeaseInput(ownerId: string, now: number, leaseMs: number): void {
    if (!ownerId) throw new TypeError("ownerId must not be empty");
    assertNonNegativeInteger(now, "now");
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new TypeError("leaseMs must be a positive integer");
  }

  private assertControllerMutation(input: ControllerLeaseFence & { turnId: string }): void {
    assertControllerIdentifier(input.turnId, "turnId");
    if (!input.ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
  }

  private assertControllerSteerInput(input: ControllerLeaseFence & {
    runningTurnId: string;
    waitingTurnId: string;
  }): void {
    this.assertControllerMutation({ ...input, turnId: input.runningTurnId });
    assertControllerIdentifier(input.waitingTurnId, "waitingTurnId");
  }

  private assertLeaseIdentity(key: string, ownerId: string, generation: number, now: number): void {
    if (!key) throw new TypeError("lease key must not be empty");
    if (!ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(generation, "generation");
    assertNonNegativeInteger(now, "now");
  }

  private executorLeaseRow(): {
    owner_id: string | null;
    generation: number;
    heartbeat_at: number | null;
    lease_expires_at: number | null;
  } {
    const row = this.db
      .prepare("SELECT owner_id, generation, heartbeat_at, lease_expires_at FROM executor_lease WHERE singleton = 1")
      .get() as {
        owner_id: string | null;
        generation: number;
        heartbeat_at: number | null;
        lease_expires_at: number | null;
      } | undefined;
    if (!row) throw new Error("Executor lease was not initialized");
    return row;
  }

  private executorLeaseIsCurrent(ownerId: string, generation: number, now: number): boolean {
    const row = this.executorLeaseRow();
    return row.owner_id === ownerId && row.generation === generation &&
      row.lease_expires_at !== null && row.lease_expires_at > now;
  }

  private mergeResourceRequirements(job: Job): MergeResourceRequirement[] | null {
    if (!job.policy || !job.projectId || job.policy.projectId !== job.projectId) return null;
    return [
      {
        resourceKind: "repository_merge" as const,
        resourceKey: repositoryMergeResourceKey(job.policy.githubRepository),
      },
      ...(job.policy.production === undefined ? [] : [{
        resourceKind: "production_target" as const,
        resourceKey: productionResourceKey(job.policy),
      }]),
    ].sort((left, right) =>
      left.resourceKey < right.resourceKey ? -1 : left.resourceKey > right.resourceKey ? 1 : 0,
    );
  }

  private admissionJobPolicyIdentityIsValid(admission: JobAdmission, job: Job): boolean {
    return job.projectId !== null && job.policy !== null &&
      admission.projectId === job.projectId && job.policy.projectId === job.projectId;
  }

  private productionClaimIsCurrentInTransaction(
    job: Job,
    ownerId: string,
    generation: number,
    now: number,
  ): boolean {
    return this.currentProductionClaimIdInTransaction(job, ownerId, generation, now) !== null;
  }

  private currentProductionClaimIdInTransaction(
    job: Job,
    ownerId: string,
    generation: number,
    now: number,
  ): number | null {
    if (!job.policy?.production || job.projectId !== job.policy.projectId) return null;
    const rows = this.db
      .prepare(
        `SELECT claim_id
           FROM job_resource_claims
          WHERE job_id = ? AND resource_key = ? AND resource_kind = 'production_target'
            AND state = 'held' AND owner_id = ? AND generation = ? AND lease_expires_at > ?
          ORDER BY claim_id ASC
          LIMIT 2`,
      )
      .all(job.id, productionResourceKey(job.policy), ownerId, generation, now) as Array<{ claim_id: number }>;
    return rows.length === 1 ? rows[0]!.claim_id : null;
  }

  private productionStageMutationIsCurrentInTransaction(
    attemptId: string,
    ownerId: string,
    generation: number,
    now: number,
  ): boolean {
    const prefix = "stage:";
    if (!attemptId.startsWith(prefix)) return true;
    const effectIdempotencyKey = attemptId.slice(prefix.length);
    const effect = this.db
      .prepare(
        `SELECT job_id, kind, status, lease_owner, lease_generation, lease_expires_at
           FROM effects WHERE idempotency_key = ?`,
      )
      .get(effectIdempotencyKey) as {
        job_id: string;
        kind: string;
        status: string;
        lease_owner: string | null;
        lease_generation: number | null;
        lease_expires_at: number | null;
      } | undefined;
    if (!effect || (effect.kind !== "deploy_production" && effect.kind !== "verify_production")) return true;
    if (effect.status !== "leased" || effect.lease_owner !== ownerId || effect.lease_generation !== generation ||
      effect.lease_expires_at === null || effect.lease_expires_at <= now) return false;
    const job = this.readJobById(effect.job_id);
    const admission = this.autonomyRepository.getAdmission(effect.job_id);
    if (!job || !admission || !this.admissionJobPolicyIdentityIsValid(admission, job)) return false;
    const expectedState = effect.kind === "deploy_production" ? "deploying" : "verifying_production";
    return job.state === expectedState &&
      this.productionClaimIsCurrentInTransaction(job, ownerId, generation, now);
  }

  private acceptedMergeEffectForLease(effect: StoredEffect, job: Job): boolean {
    if (
      effect.kind !== "merge_pr" ||
      effect.jobId !== job.id ||
      effect.idempotencyKey !== `${job.id}:${job.version}:merge_pr` ||
      job.state !== "merging" ||
      job.cancelRequestedAt !== null ||
      job.prHeadSha === null
    ) return false;
    const acceptedLease = this.readAcceptedMergeLease(effect, job);
    if (!acceptedLease || acceptedLease.headSha !== job.prHeadSha || acceptedLease.approvalJobVersion + 1 !== job.version) return false;

    const approval = this.readApproval(acceptedLease.approvalNonceHash);
    return approval !== undefined &&
      approval.job_id === job.id &&
      approval.head_sha === acceptedLease.headSha &&
      approval.consumed_at !== null &&
      approval.outcome === "accepted" &&
      approval.owner_user_id === acceptedLease.approvalOwnerUserId &&
      approval.owner_chat_id === acceptedLease.approvalOwnerChatId &&
      approval.job_version === acceptedLease.approvalJobVersion &&
      approval.expires_at === acceptedLease.approvalExpiresAt;
  }

  private readAcceptedMergeLease(effect: StoredEffect, job: Job): AcceptedMergeLease | null {
    try {
      return Object.prototype.hasOwnProperty.call(effect.payload, "receipt")
        ? this.readReceiptMergeLease(effect, job)
        : this.readPendingMergeLease(effect);
    } catch {
      return null;
    }
  }

  private readReceiptMergeLease(effect: StoredEffect, job: Job): AcceptedMergeLease | null {
    const payload = parseMergeEffectPayload(effect.payload);
    if (
      payload.mergeOutcome !== undefined ||
      payload.receipt.jobId !== job.id ||
      payload.receipt.effectIdempotencyKey !== effect.idempotencyKey ||
      payload.receipt.jobVersion !== job.version
    ) return null;
    return {
      headSha: payload.headSha,
      approvalNonceHash: payload.receipt.approvalNonceHash,
      approvalOwnerUserId: payload.receipt.approvalOwnerUserId,
      approvalOwnerChatId: payload.receipt.approvalOwnerChatId,
      approvalJobVersion: payload.receipt.approvalJobVersion,
      approvalExpiresAt: Date.parse(payload.receipt.expiresAt),
    };
  }

  private readPendingMergeLease(effect: StoredEffect): AcceptedMergeLease {
    const payload = parsePendingMergeEffectPayload(effect.payload);
    return {
      headSha: payload.headSha,
      approvalNonceHash: payload.approvalNonceHash,
      approvalOwnerUserId: payload.approvalOwnerUserId,
      approvalOwnerChatId: payload.approvalOwnerChatId,
      approvalJobVersion: payload.approvalJobVersion,
      approvalExpiresAt: payload.approvalExpiresAt,
    };
  }

  private acquireMergeResourceClaimsInTransaction(
    input: JobEffectLeaseInput,
    effect: StoredEffect,
    job: Job,
  ): void {
    const requirements = this.mergeResourceRequirements(job);
    if (!requirements || !this.acceptedMergeEffectForLease(effect, job)) {
      throw new MergeClaimConflictError();
    }
    const heldByKey = this.readHeldMergeClaimsInTransaction(requirements);
    this.assertMergeClaimsBelongToLease(job, input, requirements, heldByKey);
    this.insertMissingMergeClaims(job, input, requirements, heldByKey);
  }

  private readHeldMergeClaimsInTransaction(
    requirements: readonly MergeResourceRequirement[],
  ): Map<string, HeldMergeClaim> {
    const heldRows = this.db
      .prepare(
        `SELECT resource_key, resource_kind, job_id, owner_id, generation, lease_expires_at
           FROM job_resource_claims
          WHERE state = 'held' AND resource_key IN (${requirements.map(() => "?").join(", ")})
          ORDER BY resource_key ASC
          LIMIT ?`,
      )
      .all(...requirements.map((requirement) => requirement.resourceKey), requirements.length) as HeldMergeClaim[];
    return new Map(heldRows.map((row) => [row.resource_key, row]));
  }

  private assertMergeClaimsBelongToLease(
    job: Job,
    input: JobEffectLeaseInput,
    requirements: readonly MergeResourceRequirement[],
    heldByKey: ReadonlyMap<string, HeldMergeClaim>,
  ): void {
    for (const requirement of requirements) {
      const held = heldByKey.get(requirement.resourceKey);
      if (!held) continue;
      if (
        held.job_id !== job.id ||
        held.resource_kind !== requirement.resourceKind ||
        held.owner_id !== input.ownerId ||
        held.generation !== input.generation ||
        held.lease_expires_at <= input.now
      ) throw new MergeClaimConflictError();
    }
  }

  private insertMissingMergeClaims(
    job: Job,
    input: JobEffectLeaseInput,
    requirements: readonly MergeResourceRequirement[],
    heldByKey: ReadonlyMap<string, HeldMergeClaim>,
  ): void {
    try {
      for (const requirement of requirements) {
        if (heldByKey.has(requirement.resourceKey)) continue;
        this.db
          .prepare(
            `INSERT INTO job_resource_claims (
               job_id, resource_key, resource_kind, state, owner_id, generation,
               lease_expires_at, acquired_at, renewed_at
             ) VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?)`,
          )
          .run(
            job.id,
            requirement.resourceKey,
            requirement.resourceKind,
            input.ownerId,
            input.generation,
            input.now + input.leaseMs,
            input.now,
            input.now,
          );
      }
    } catch (error) {
      if (sqliteErrorCode(error) === "SQLITE_CONSTRAINT_UNIQUE") throw new MergeClaimConflictError();
      throw error;
    }
  }

  private mergeClaimsAreCurrentInTransaction(
    job: Job,
    ownerId: string,
    generation: number,
    now: number,
  ): boolean {
    const requirements = this.mergeResourceRequirements(job);
    if (!requirements) return false;
    const rows = this.db
      .prepare(
        `SELECT resource_key, resource_kind
           FROM job_resource_claims
          WHERE job_id = ? AND state = 'held' AND owner_id = ? AND generation = ?
            AND lease_expires_at > ?
            AND resource_key IN (${requirements.map(() => "?").join(", ")})
          ORDER BY resource_key ASC
          LIMIT ?`,
      )
      .all(
        job.id,
        ownerId,
        generation,
        now,
        ...requirements.map((requirement) => requirement.resourceKey),
        requirements.length,
      ) as Array<{ resource_key: string; resource_kind: string }>;
    const current = new Map(rows.map((row) => [row.resource_key, row.resource_kind]));
    return requirements.every((requirement) => current.get(requirement.resourceKey) === requirement.resourceKind);
  }

  private settleResourceClaimsInTransaction(input: ResourceClaimSettlement): void {
    if (input.resourceKinds.length === 0) return;
    this.db
      .prepare(
        `UPDATE job_resource_claims
            SET state = 'released', lease_expires_at = 0, released_at = ?, release_reason = ?
          WHERE job_id = ? AND state = 'held' AND owner_id = ? AND generation = ?
            AND resource_kind IN (${input.resourceKinds.map(() => "?").join(", ")})`,
      )
      .run(
        input.now,
        input.reason,
        input.jobId,
        input.ownerId,
        input.generation,
        ...input.resourceKinds,
      );
  }

  private effectByKey(key: string): EffectRow | undefined {
    return this.db.prepare("SELECT * FROM effects WHERE idempotency_key = ?").get(key) as EffectRow | undefined;
  }

  private outboxByKey(key: string): OutboxRow | undefined {
    return this.db.prepare("SELECT * FROM outbox WHERE logical_key = ?").get(key) as OutboxRow | undefined;
  }

  private effectLeaseIsActiveForRow(
    effect: EffectRow,
    ownerId: string,
    generation: number,
    now: number,
  ): boolean {
    return effect.status === "leased" && effect.lease_owner === ownerId &&
      effect.lease_generation === generation && effect.lease_expires_at !== null && effect.lease_expires_at > now &&
      this.executorLeaseIsCurrent(ownerId, generation, now);
  }

  private outboxLeaseIsActiveForRow(
    outbox: OutboxRow,
    ownerId: string,
    generation: number,
    now: number,
  ): boolean {
    return outbox.status === "leased" && outbox.lease_owner === ownerId &&
      outbox.lease_generation === generation && outbox.lease_expires_at !== null && outbox.lease_expires_at > now &&
      this.executorLeaseIsCurrent(ownerId, generation, now);
  }

  /**
   * An effect has just gone dead, either dead-lettered outright or out of
   * retries. Both routes reach here so the question "does this cost the job?"
   * is answered in one place: a cosmetic effect carries the pipeline nowhere,
   * so losing it is a display problem, not grounds for abandoning the work.
   */
  private settleJobForDeadEffect(effect: { job_id: string; kind: string }, error: string, now: number): void {
    if (COSMETIC_EFFECT_KINDS.has(effect.kind)) return;
    this.markJobPermanentFailure(effect.job_id, error, now);
  }

  private markJobPermanentFailure(jobId: string, error: string, now: number): void {
    const job = this.readJobById(jobId);
    if (!job || ["merged", "cancelled", "blocked", "complete", "production_failed"].includes(job.state)) return;
    const isProductionIncident = job.mergeCommitSha !== null &&
      (job.state === "deploying" || job.state === "verifying_production");
    const changed = this.db
      .prepare(
        `UPDATE jobs SET state = ?, resume_state = ?, blocked_reason = ?,
           last_error = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        isProductionIncident ? "production_failed" : "blocked",
        isProductionIncident ? null : job.state,
        isProductionIncident ? null : "permanent_effect_failure",
        error,
        job.version + 1,
        now,
        job.id,
        job.version,
      );
    if (changed.changes === 1) {
      this.db
        .prepare(
          `UPDATE approvals SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
             WHERE job_id = ? AND consumed_at IS NULL`,
        )
        .run(now, job.id);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO effects (
             idempotency_key, job_id, kind, payload_json, status, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, 'render_status', '{}', 'pending', 0, ?, ?, ?)`,
        )
        .run(`${job.id}:${job.version + 1}:render_status`, job.id, now, now, now);
    }
  }


  private readJobById(jobId: string): Job | null {
    return readJobById(this.db, jobId);
  }

  private readApproval(nonceHash: string): ApprovalRow | undefined {
    return this.db
      .prepare(
        `SELECT nonce_hash, job_id, head_sha, expires_at, consumed_at, outcome,
                owner_user_id, owner_chat_id, job_version
           FROM approvals WHERE nonce_hash = ?`,
      )
      .get(nonceHash) as ApprovalRow | undefined;
  }

  private readEffect(jobId: string, idempotencyKey: string): EffectRow | undefined {
    return this.db
      .prepare("SELECT * FROM effects WHERE job_id = ? AND idempotency_key = ?")
      .get(jobId, idempotencyKey) as EffectRow | undefined;
  }

  private findUniqueLegacyAcceptedCallbackIdentity(jobId: string): MergeCallbackIdentity | null {
    const rows = this.db
      .prepare("SELECT * FROM effects WHERE job_id = ? AND kind = 'merge_pr'")
      .all(jobId) as EffectRow[];
    let candidate: MergeCallbackIdentity | null = null;
    const job = this.readJobById(jobId);
    if (!job) return null;
    const owner = this.getOwner();
    for (const row of rows) {
      let evidence: PersistedMergeEvidence;
      try {
        evidence = parsePersistedMergeEvidence({
          idempotencyKey: row.idempotency_key,
          jobId: row.job_id,
          kind: row.kind,
          status: row.status,
          payload: JSON.parse(row.payload_json),
        });
      } catch {
        return null;
      }
      if (!isReplayableMergeEvidence(evidence)) continue;
      const receipt = evidence.payload.receipt;
      const approval = this.readApproval(receipt.approvalNonceHash);
      const bindingError = mergeEvidenceBindingError(
        evidence,
        job,
        this.getApproval(receipt.approvalNonceHash),
        this.getAttempt(receipt.reviewAttemptId),
      );
      if (bindingError !== null) return null;
      if (evidence.disposition === "success") {
        if (
          !mergeSuccessResultMatchesDurable(evidence.result, row, evidence.payload, job, approval, "post_merge") ||
          !this.attemptResultMatches(receipt.reviewAttemptId, jobId, receipt.headSha, evidence.result) ||
          owner === null ||
          owner.userId !== receipt.approvalOwnerUserId ||
          owner.chatId !== receipt.approvalOwnerChatId
        ) return null;
      } else if (this.acceptedMergeReceiptBindingError(row, evidence.payload, job, approval) !== null) {
        return null;
      }
      const identity = {
        approvalNonceHash: receipt.approvalNonceHash,
        headSha: receipt.headSha,
        effectIdempotencyKey: row.idempotency_key,
      };
      if (candidate !== null) return null;
      candidate = identity;
    }
    return candidate;
  }

  private findAcceptedMergeCallbackIdentity(
    jobId: string,
    headSha: string,
    approvalNonceHash: string,
  ): MergeCallbackIdentity | null {
    const rows = this.db
      .prepare("SELECT * FROM effects WHERE job_id = ? AND kind = 'merge_pr'")
      .all(jobId) as EffectRow[];
    let candidate: MergeCallbackIdentity | null = null;
    const job = this.readJobById(jobId);
    if (!job) return null;
    const owner = this.getOwner();
    for (const row of rows) {
      let evidence: PersistedMergeEvidence;
      try {
        evidence = parsePersistedMergeEvidence({
          idempotencyKey: row.idempotency_key,
          jobId: row.job_id,
          kind: row.kind,
          status: row.status,
          payload: JSON.parse(row.payload_json),
        });
      } catch {
        return null;
      }
      if (!isReplayableMergeEvidence(evidence)) continue;
      const receipt = evidence.payload.receipt;
      const approval = this.readApproval(receipt.approvalNonceHash);
      const bindingError = mergeEvidenceBindingError(
        evidence,
        job,
        this.getApproval(receipt.approvalNonceHash),
        this.getAttempt(receipt.reviewAttemptId),
      );
      if (bindingError !== null) return null;
      if (receipt.headSha !== headSha || receipt.approvalNonceHash !== approvalNonceHash) continue;
      if (evidence.disposition === "success") {
        if (
          !mergeSuccessResultMatchesDurable(
            evidence.result,
            row,
            evidence.payload,
            job,
            approval,
            "post_merge",
          ) || !this.attemptResultMatches(receipt.reviewAttemptId, jobId, receipt.headSha, evidence.result) ||
          owner === null ||
          owner.userId !== receipt.approvalOwnerUserId ||
          owner.chatId !== receipt.approvalOwnerChatId
        ) return null;
      } else if (this.acceptedMergeReceiptBindingError(row, evidence.payload, job, approval) !== null) {
        return null;
      }
      const identity = {
        approvalNonceHash,
        headSha,
        effectIdempotencyKey: row.idempotency_key,
      };
      if (candidate !== null) return null;
      candidate = identity;
    }
    return candidate;
  }

  private attemptResultMatches(
    attemptId: string,
    jobId: string,
    headSha: string,
    result: PersistedMergeSuccessResult,
  ): boolean {
    const attempt = this.getAttempt(attemptId);
    if (
      !attempt ||
      attempt.jobId !== jobId ||
      attempt.kind !== "review" ||
      attempt.headSha !== headSha ||
      attempt.completedAt === null ||
      attempt.resultJson === null
    ) return false;
    try {
      const stored = parsePersistedMergeSuccessResult(JSON.parse(attempt.resultJson));
      return JSON.stringify(stored) === JSON.stringify(result);
    } catch {
      return false;
    }
  }

  private approvalIsCurrent(
    row: ApprovalRow,
    identity: ApprovalIdentity | undefined,
  ): boolean {
    const job = this.readJobById(row.job_id);
    if (!job || job.state !== "awaiting_merge_approval" || job.cancelRequestedAt !== null) return false;
    if (job.prHeadSha !== row.head_sha) return false;
    if (row.job_version !== null && job.version !== row.job_version) return false;

    const owner = this.getOwner();
    const expectedUserId = row.owner_user_id ?? identity?.userId ?? null;
    const expectedChatId = row.owner_chat_id ?? identity?.chatId ?? null;
    if (row.owner_user_id === null && row.owner_chat_id === null && identity === undefined) return true;
    if (!owner || expectedUserId === null || expectedChatId === null) return false;
    if (owner.userId !== expectedUserId || owner.chatId !== expectedChatId) return false;
    if (identity && (identity.userId !== expectedUserId || identity.chatId !== expectedChatId)) return false;
    return true;
  }

  private effectLeaseMatches(
    effect: EffectRow,
    leaseOwner: string,
    leaseGeneration: number,
  ): boolean {
    return effect.status === "leased" &&
      effect.lease_owner === leaseOwner &&
      effect.lease_generation === leaseGeneration;
  }

  private effectLeaseIsActive(
    effect: EffectRow,
    leaseOwner: string,
    leaseGeneration: number,
    now: number,
  ): boolean {
    return this.effectLeaseMatches(effect, leaseOwner, leaseGeneration) &&
      effect.lease_expires_at !== null && effect.lease_expires_at > now &&
      this.executorLeaseIsCurrent(leaseOwner, leaseGeneration, now);
  }

  private mergeReceiptBindingError(
    effect: EffectRow,
    payload: MergeEffectPayload,
    job: Job,
    approval: ApprovalRow | undefined,
    now: number,
  ): string | null {
    const identityError = this.mergeReceiptIdentityError(effect, payload, job, approval);
    if (identityError) return identityError;
    if (!approval) return "durable merge receipt approval binding is missing";
    const receipt = payload.receipt;
    if (now >= approval.expires_at || now >= Date.parse(receipt.expiresAt)) {
      return "durable merge approval has expired";
    }
    return null;
  }

  private acceptedMergeReceiptBindingError(
    effect: EffectRow,
    payload: MergeEffectPayload,
    job: Job,
    approval: ApprovalRow | undefined,
  ): string | null {
    return this.mergeReceiptIdentityError(effect, payload, job, approval);
  }

  private mergeReceiptIdentityError(
    effect: EffectRow,
    payload: MergeEffectPayload,
    job: Job,
    approval: ApprovalRow | undefined,
  ): string | null {
    const receipt = payload.receipt;
    if (effect.job_id !== job.id || receipt.jobId !== job.id || receipt.effectIdempotencyKey !== effect.idempotency_key) {
      return "durable merge receipt identity does not match its effect";
    }
    if (payload.headSha !== receipt.headSha || job.prHeadSha !== receipt.headSha) {
      return "durable merge receipt head does not match the job";
    }
    if (job.state !== "merging" || job.cancelRequestedAt !== null) {
      return "job is no longer an uncancelled merging job";
    }
    if (job.version !== receipt.jobVersion || receipt.jobVersion !== receipt.approvalJobVersion + 1) {
      return "durable merge receipt job version is stale";
    }
    if (
      job.projectId !== receipt.projectId ||
      job.environmentId !== receipt.environmentId ||
      job.prNumber !== receipt.prNumber ||
      job.policy === null ||
      job.policy.baseBranch !== receipt.baseBranch ||
      job.policy.mergeMethod !== receipt.mergeMethod ||
      JSON.stringify([...job.policy.requiredChecks].sort()) !== JSON.stringify(receipt.requiredCheckNames)
    ) {
      return "durable merge receipt does not match the immutable job policy";
    }
    if (!approval || approval.job_id !== job.id || approval.head_sha !== receipt.headSha) {
      return "durable merge receipt approval binding is missing";
    }
    if (approval.consumed_at === null || approval.outcome !== "accepted") {
      return "durable merge approval is not accepted";
    }
    if (
      approval.job_version !== receipt.approvalJobVersion ||
      approval.owner_user_id !== receipt.approvalOwnerUserId ||
      approval.owner_chat_id !== receipt.approvalOwnerChatId ||
      approval.expires_at !== Date.parse(receipt.expiresAt)
    ) {
      return "durable merge receipt does not match the approval row";
    }
    const owner = this.getOwner();
    if (!owner || owner.userId !== receipt.approvalOwnerUserId || owner.chatId !== receipt.approvalOwnerChatId) {
      return "paired Telegram owner changed";
    }
    return null;
  }

  private approvalReceiptBindingError(
    effect: JobEffect,
    payload: MergeEffectPayload,
    generatedKey: string,
    job: Job,
    approval: ApprovalRow,
    nonceHash: string,
    now: number,
  ): string | null {
    const receipt = payload.receipt;
    const owner = this.getOwner();
    if (effect.jobId !== job.id || receipt.jobId !== job.id || receipt.effectIdempotencyKey !== generatedKey) {
      return "merge effect identity is not the exact generated identity";
    }
    if (payload.headSha !== receipt.headSha || receipt.headSha !== approval.head_sha || receipt.headSha !== job.prHeadSha) {
      return "merge effect head is not bound to the approval and job";
    }
    if (
      receipt.approvalNonceHash !== nonceHash ||
      approval.job_id !== job.id ||
      approval.consumed_at !== null ||
      approval.outcome !== null ||
      approval.job_version !== job.version ||
      approval.owner_user_id !== receipt.approvalOwnerUserId ||
      approval.owner_chat_id !== receipt.approvalOwnerChatId ||
      !owner ||
      owner.userId !== receipt.approvalOwnerUserId ||
      owner.chatId !== receipt.approvalOwnerChatId
    ) {
      return "merge effect approval binding does not match durable state";
    }
    if (
      receipt.jobVersion !== job.version + 1 ||
      receipt.approvalJobVersion !== job.version ||
      job.projectId !== receipt.projectId ||
      job.environmentId !== receipt.environmentId ||
      job.prNumber !== receipt.prNumber ||
      job.policy === null ||
      job.policy.baseBranch !== receipt.baseBranch ||
      job.policy.mergeMethod !== receipt.mergeMethod ||
      JSON.stringify([...job.policy.requiredChecks].sort()) !== JSON.stringify(receipt.requiredCheckNames)
    ) {
      return "merge effect receipt does not match the durable job policy or version";
    }
    if (approval.expires_at !== Date.parse(receipt.expiresAt) || now >= approval.expires_at) {
      return "merge effect receipt expiry does not match the approval boundary";
    }
    return null;
  }

  private insertCallback(
    callbackId: string,
    jobId: string | null,
    action: string,
    outcome: string,
    now: number,
    completion?: MergeCallbackIdentity,
  ): boolean {
    assertNonNegativeInteger(now, "now");
    assertNoRawMergeCallback(callbackId, "callbackId");
    if (jobId !== null) assertNoRawMergeCallback(jobId, "callback job id");
    assertNoRawMergeCallback(action, "callback action");
    assertNoRawMergeCallback(outcome, "callback outcome");
    if (completion) {
      if (action !== "merge" || outcome !== "accepted") {
        throw new TypeError("callback completion identity is only valid for accepted merge callbacks");
      }
      assertSha256Hex(completion.approvalNonceHash);
      assertFullSha(completion.headSha, "callback headSha");
      if (!completion.effectIdempotencyKey || completion.effectIdempotencyKey.length > MAX_EFFECT_KEY) {
        throw new TypeError("callback effect idempotency key is invalid");
      }
      assertNoRawMergeCallback(completion.effectIdempotencyKey, "callback effect idempotency key");
    } else if (action === "merge" && outcome === "accepted") {
      throw new TypeError("accepted merge callback identity is required");
    }
    const callbackNow = this.currentNow();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO callbacks (
           callback_query_id, job_id, action, outcome, processed_at,
           approval_nonce_hash, head_sha, effect_idempotency_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        callbackId,
        jobId,
        action,
        outcome,
        callbackNow,
        completion?.approvalNonceHash ?? null,
        completion?.headSha ?? null,
        completion?.effectIdempotencyKey ?? null,
      );
    return result.changes === 1;
  }

  private readJobBySourceUpdate(sourceUpdateId: number): Job | null {
    return readJobBySourceUpdate(this.db, sourceUpdateId);
  }

}

export function openStore(
  storage: PluginStorage,
  kv: PluginKv = storage.kv,
  now: () => number = () => Date.now(),
  controllerModelRoute: () => ModelRoute = () => DEFAULT_CONTROLLER_CAPABILITY_MODEL,
  capabilityDispatchSettings: () => CapabilityDispatchSettings = () => DEFAULT_CAPABILITY_DISPATCH_SETTINGS,
): TelegramAgentStore {
  migrateControllerInteractionStorage(storage, now());
  const db = storage.database();
  ensureApprovalOwnershipColumns(db);
  return new SqliteTelegramAgentStore(db, kv, now, controllerModelRoute, capabilityDispatchSettings);
}
