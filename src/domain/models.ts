import { z } from "zod";
import type {
  GuardAssessmentPolicy,
  GuardEnvelopeAssessment,
  GuardResultEnvelope,
} from "../capabilities/guards";
import {
  consensusReviewSchema,
  executionProfileSchema,
  stageExecutionPolicySchema,
  type PipelineStage,
} from "./stage-execution";

export { executionProfileSchema };
export type { ExecutionProfile } from "./stage-execution";

export const policyCommandSchema = z
  .object({
    name: z.string().min(1).max(40),
    command: z.string().min(1).max(8_000),
    timeoutMs: z.number().int().min(1_000).max(3_600_000),
  })
  .strict();

export const productionPolicySchema = z
  .object({
    deployCommands: z.array(policyCommandSchema).min(1).max(20),
    canaryCommands: z.array(policyCommandSchema).min(1).max(20),
    // Canary commands run once, immediately after a deploy. Between deploys
    // nothing looks at production at all, which is how a crash loop can run for
    // days unnoticed. These run on a timer instead, so they must be cheap and
    // read-only — a canary is allowed to be neither.
    healthCommands: z.array(policyCommandSchema).min(1).max(5).optional(),
    healthIntervalMs: z.number().int().min(60_000).max(86_400_000).optional(),
    rollbackCommand: policyCommandSchema.optional(),
    targetKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional(),
    convexDeployRequired: z.boolean().default(false),
  })
  .strict()
  .superRefine((production, context) => {
    if (!production.convexDeployRequired) return;
    const convexCliDeploy = /(?:^|&&|\|\||;|\||\n)\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:(?:npx|bunx)\s+|(?:yarn\s+dlx|pnpm\s+exec)\s+)?convex\s+deploy(?:\s|$)/;
    if (!production.deployCommands.some((entry) => convexCliDeploy.test(entry.command))) {
      context.addIssue({
        code: "custom",
        path: ["deployCommands"],
        message: "A Convex deployment must use the Convex CLI",
      });
    }
  });

/**
 * Validation commands prove one job's change. Nothing proves the project still
 * works *between* jobs, which is how a broken dependency, an expired token, or
 * someone else's merge stays invisible until the next time work is requested.
 * These run on a timer in the project's checkout for exactly that reason.
 */
export const regressionPolicySchema = z
  .object({
    commands: z.array(policyCommandSchema).min(1).max(5),
    /** Defaults to daily. Bounded to at least an hour so it cannot become a busy loop. */
    intervalMs: z.number().int().min(3_600_000).max(604_800_000).optional(),
  })
  .strict();

/**
 * What this project may do without the owner in the loop. Every field is
 * opt-in and absent by default: a policy with no `autonomy` block behaves
 * exactly as it did before this existed — every merge asks, and a project with
 * no production settings finishes at the reviewed pull request.
 *
 * The cross-field rules that make these safe are enforced where the whole
 * policy is visible, in `projectPolicySchema` below, so they fail at
 * `project enable` and at load rather than at the merge they would have
 * governed.
 */
export const autonomyPolicySchema = z
  .object({
    /**
     * Merge on the project's own standing authority, on exactly the terms of an
     * owner-granted standing approval: it replaces the owner's signature and
     * nothing else. Every gate that produced the merge candidate still runs.
     */
    unattendedMerge: z.boolean().default(false),
    /**
     * Merge a project that deploys nothing. Without this a reviewed pull
     * request with no production settings is finished work, not a merge
     * candidate.
     */
    mergeWithoutProduction: z.boolean().default(false),
    /**
     * The route a consensus review pass runs on. Absent means the strong route
     * of whichever provider the job's review stage did not use.
     */
    consensusReview: consensusReviewSchema.optional(),
  })
  .strict();

export const projectPolicySchema = z
  .object({
    projectId: z.string().startsWith("proj_"),
    alias: z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/),
    enabled: z.boolean(),
    githubRepository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    baseBranch: z.string().min(1),
    implementation: executionProfileSchema,
    review: executionProfileSchema,
    /**
     * Per-worker-kind execution overrides. An absent entry takes the stage's
     * declared default tier; `implementation` and `review` fall back to the two
     * profiles above so stored policies keep working untouched.
     *
     * Model ids named here are checked against the pipeline catalog whenever a
     * policy is parsed, so a model no provider offers fails at save and load
     * rather than when a worker refuses to start. The two profiles above are
     * deliberately not checked: they predate the catalog and policies already
     * stored with them must keep running.
     */
    stageExecution: stageExecutionPolicySchema.optional(),
    /** Absent means today's behaviour: nothing happens without the owner. */
    autonomy: autonomyPolicySchema.optional(),
    validationCommands: z.array(policyCommandSchema).max(20),
    production: productionPolicySchema.optional(),
    regression: regressionPolicySchema.optional(),
    requiredChecks: z.array(z.string().min(1)).max(50),
    outputRedactionPatterns: z.array(z.string().min(1).max(200)).max(20),
    workerStartGraceMs: z.number().int().min(10_000).max(900_000).default(120_000),
    workerLivenessWatchdogMs: z.number().int().min(60_000).max(3_600_000).default(300_000),
    workerRecoveryLimit: z.number().int().min(1).max(5).default(2),
    maxReviewCycles: z.number().int().min(1).max(10).default(3),
    mergeMethod: z.enum(["merge", "rebase", "squash"]),
  })
  .strict()
  .superRefine((policy, context) => {
    for (const [index, pattern] of policy.outputRedactionPatterns.entries()) {
      try {
        new RegExp(pattern, "g");
      } catch {
        context.addIssue({
          code: "custom",
          path: ["outputRedactionPatterns", index],
          message: "Invalid regular expression",
        });
      }
    }
    // A project that deploys is a project that can break production, and
    // nobody is watching an unattended merge do it. A rollback command is the
    // one thing that turns that from an incident into a recovery, so it is
    // required before the owner's signature may be skipped.
    if (policy.autonomy?.unattendedMerge && policy.production && !policy.production.rollbackCommand) {
      context.addIssue({
        code: "custom",
        path: ["autonomy", "unattendedMerge"],
        message: "Unattended merging of a project with production requires production.rollbackCommand",
      });
    }
    // Merging without production removes the deploy and canary that would
    // otherwise prove the merged change works. Required checks and a scheduled
    // regression run are what is left to notice a bad merge, so both must exist
    // before the pipeline may finish this way.
    if (policy.autonomy?.mergeWithoutProduction) {
      if (policy.requiredChecks.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["autonomy", "mergeWithoutProduction"],
          message: "Merging without production requires at least one required check",
        });
      }
      if (!policy.regression) {
        context.addIssue({
          code: "custom",
          path: ["autonomy", "mergeWithoutProduction"],
          message: "Merging without production requires a configured regression policy",
        });
      }
    }
  });

export type AutonomyPolicy = z.infer<typeof autonomyPolicySchema>;
export type PolicyCommand = z.infer<typeof policyCommandSchema>;
export type ProductionPolicy = z.infer<typeof productionPolicySchema>;
export type RegressionPolicy = z.infer<typeof regressionPolicySchema>;
export type ProjectPolicy = z.infer<typeof projectPolicySchema>;

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

export interface ReviewFinding {
  severity: ReviewSeverity;
  file: string | null;
  line: number | null;
  title: string;
  details: string;
}

export interface ReviewCheck {
  name: string;
  command: string | null;
  outcome: "passed" | "failed" | "blocked";
  exitCode: number | null;
  summary: string;
}

export interface ReviewVerdict {
  verdict: "pass" | "changes_requested" | "blocked";
  reviewedHeadSha: string;
  summary: string;
  findings: ReviewFinding[];
  checks: ReviewCheck[];
}

export type ReviewAssessmentOutcome = "pass" | "changes_requested" | "blocked";

export interface ReviewAssessment {
  outcome: ReviewAssessmentOutcome;
  reasons: string[];
  findings: ReviewFinding[];
}

export type ReviewAttemptOutcome = ReviewAssessmentOutcome | "format_correction_sent";

export interface ReviewAttemptResult {
  outcome: ReviewAttemptOutcome;
  reasons: string[];
  findings: ReviewFinding[];
  reviewedHeadSha: string | null;
  verdict?: ReviewVerdict;
  guardEnvelope?: GuardResultEnvelope;
  guardPolicy?: GuardAssessmentPolicy;
  guardAssessment?: GuardEnvelopeAssessment;
  formatCorrectionSent?: boolean;
}

export interface ReviewAttempt {
  id: string;
  jobId: string;
  kind: "review";
  ordinal: number;
  threadId: string | null;
  headSha: string;
  formatCorrectionSent: boolean;
  requiresNewHead: boolean;
  result: ReviewAttemptResult | null;
  createdAt: number;
  completedAt: number | null;
}

export type JobState =
  | "awaiting_project"
  | "awaiting_confirmation"
  | "planning"
  | "critiquing"
  | "creating_implementation"
  | "implementing"
  | "locating_pr"
  | "resolving_pr_head"
  | "reviewing"
  | "remediating"
  | "validating"
  | "documenting"
  | "resolving_docs_head"
  | "final_validating"
  | "final_reviewing"
  | "awaiting_merge_approval"
  | "merging"
  | "deploying"
  | "verifying_production"
  | "recovering_worker"
  | "production_failed"
  | "complete"
  | "failed"
  | "blocked"
  | "cancelled"
  | "merged";

/** One worker kind per pipeline stage, so every stage has its own model. */
export type WorkerKind = PipelineStage;
export type WorkerRecoveryClassification = "never_started" | "no_progress" | "missing" | "crash";
export type WorkerResourceKind = "bb_thread" | "bb_terminal";
export type WorkerLivenessState =
  | "starting"
  | "active"
  | "stopping"
  | "idle"
  | "failed"
  | "unknown"
  | "stale";

export interface WorkerLiveness {
  jobId: string;
  workerKind: WorkerKind;
  resourceKind: WorkerResourceKind;
  resourceId: string;
  generation: number;
  state: WorkerLivenessState;
  sourceUpdatedAt: number;
  observedAt: number;
  staleNotifiedAt: number | null;
}

export type BlockedReason =
  | "plan_limit"
  | "review_limit"
  | "configuration"
  | "cancellation_unconfirmed"
  | "permanent_effect_failure"
  | null;

export type DeliveryMode = "full" | "small_fix";
export type JobOrigin = "requested" | "adopted_pr";
export type RoutingMode = "legacy" | "shadow" | "active";

export const PRODUCTION_NOT_CONFIGURED = "Production deployment and canary are not configured";

const RETRYABLE_RESUME_STATES = new Set<JobState>([
  "planning",
  "critiquing",
  "creating_implementation",
  "implementing",
  "locating_pr",
  "resolving_pr_head",
  "reviewing",
  "remediating",
  "validating",
  "documenting",
  "resolving_docs_head",
  "final_validating",
  "final_reviewing",
  "awaiting_merge_approval",
  "merging",
  "deploying",
  "verifying_production",
]);

const EARLY_RESUME_STATES = new Set<JobState>([
  "planning",
  "critiquing",
  "creating_implementation",
  "implementing",
]);

const SMALL_FIX_TASK =
  /\b(?:typos?|lint(?:ing)?|wording|copy(?:\s+edit|\s+change)?|changelog|whitespace|nits?|one[\s-](?:line|file)|renames?|bump(?:\s+the)?\s+version|small[\s-]fix|quick[\s-]fix|tiny[\s-]fix)\b/i;

export function classifyDeliveryMode(task: string, explicit?: DeliveryMode | null): DeliveryMode {
  if (explicit === "full" || explicit === "small_fix") return explicit;
  const text = task.trim();
  if (text.length === 0 || text.length > 240) return "full";
  return SMALL_FIX_TASK.test(text) ? "small_fix" : "full";
}

export function isSmallFixJob(job: Pick<Job, "deliveryMode">): boolean {
  return job.deliveryMode === "small_fix";
}

export function isResumablePlanBlock(job: Pick<Job, "state" | "blockedReason" | "implementationThreadId" | "prNumber" | "reviewCycle">): boolean {
  if (job.state !== "blocked" || job.prNumber !== null) return false;
  if (job.blockedReason === "plan_limit") return true;
  return job.blockedReason === "review_limit"
    && job.implementationThreadId === null
    && job.reviewCycle === 0;
}

export function isResumableReviewBlock(job: Pick<Job, "state" | "blockedReason" | "implementationThreadId" | "prNumber" | "reviewCycle">): boolean {
  if (job.state !== "blocked") return false;
  if (job.prNumber !== null && (job.blockedReason === "plan_limit" || job.blockedReason === "review_limit")) {
    return true;
  }
  return job.blockedReason === "review_limit" && !isResumablePlanBlock(job);
}

export function isResumablePermanentFailure(
  job: Pick<Job, "state" | "blockedReason" | "resumeState" | "cancelRequestedAt">,
): boolean {
  return job.state === "blocked"
    && job.blockedReason === "permanent_effect_failure"
    && job.resumeState !== null
    && job.cancelRequestedAt === null
    && RETRYABLE_RESUME_STATES.has(job.resumeState);
}

/**
 * Whether this project's reviewed pull request is a merge candidate even though
 * it deploys nothing.
 *
 * By default a reviewed pull request with no production settings is finished
 * work: there is nothing to deploy, so the pipeline stops at the pull request
 * rather than merging into silence. A project that says otherwise in its policy
 * carries it through the same approval and merge gates and ends at the merge,
 * with no deploy or canary to run.
 */
export function mergesWithoutProduction(policy: ProjectPolicy | null | undefined): boolean {
  return policy?.production === undefined && policy?.autonomy?.mergeWithoutProduction === true;
}

export function isReviewedPrCompletionBlock(
  job: Pick<Job, "state" | "blockedReason" | "lastError" | "prNumber" | "policy">,
): boolean {
  return job.state === "blocked"
    && job.blockedReason === "configuration"
    && job.lastError === PRODUCTION_NOT_CONFIGURED
    && job.prNumber !== null
    && job.policy?.production === undefined;
}

export function shouldResumeExistingPr(
  job: Pick<Job, "prNumber" | "deliveryMode" | "resumeState">,
): boolean {
  if (job.prNumber === null) return false;
  if (isSmallFixJob(job)) return true;
  return job.resumeState !== null && EARLY_RESUME_STATES.has(job.resumeState);
}

export function isRetryableJob(
  job: Pick<
    Job,
    | "state"
    | "blockedReason"
    | "implementationThreadId"
    | "prNumber"
    | "reviewCycle"
    | "resumeState"
    | "cancelRequestedAt"
    | "lastError"
    | "policy"
  >,
): boolean {
  if (job.cancelRequestedAt !== null) return false;
  if (job.state === "failed" && job.resumeState !== null) return true;
  return isResumablePlanBlock(job)
    || isResumableReviewBlock(job)
    || isResumablePermanentFailure(job)
    || isReviewedPrCompletionBlock(job);
}

export interface Job {
  id: string;
  sourceUpdateId: number;
  requestText: string;
  state: JobState;
  resumeState: JobState | null;
  projectId: string | null;
  policyVersion: number | null;
  policy: ProjectPolicy | null;
  environmentId: string | null;
  implementationThreadId: string | null;
  reviewThreadId: string | null;
  documentationThreadId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prHeadSha: string | null;
  mergeMessage: string | null;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  deploymentSummary: string | null;
  canarySummary: string | null;
  statusMessageId: number | null;
  deliveryMode: DeliveryMode;
  taskRecipe: import("./recipes").TaskRecipe;
  recipeVersion: number;
  recipePromotionCount: number;
  routingMode: RoutingMode;
  taskTraits: readonly import("../capabilities/routing").TaskTraitEvidence[];
  taskReasonCodes: readonly string[];
  origin: JobOrigin;
  adoptedBranch: string | null;
  adoptedHeadSha: string | null;
  planCycle: number;
  reviewCycle: number;
  reviewBlockAt: number;
  cancelRequestedAt: number | null;
  blockedReason: BlockedReason;
  lastError: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface JobEffect {
  idempotencyKey: string;
  jobId: string;
  kind:
    | "render_status"
    | "spawn_plan"
    | "spawn_critique"
    | "spawn_implementation"
    | "inspect_implementation"
    | "resolve_pr_head"
    | "spawn_review"
    | "send_remediation"
    | "run_validation"
    | "spawn_docs"
    | "run_final_validation"
    | "spawn_final_review"
    /**
     * One extra independent review of the exact approved head, on a provider
     * the job's own reviewer did not use. It stands in for the owner's look at
     * a change that argued with its review, and never for their approval.
     */
    | "spawn_consensus_review"
    | "issue_approval"
    | "revoke_approvals"
    | "merge_pr"
    | "deploy_production"
    | "verify_production"
    | "recover_worker"
    | "stop_thread"
    | "steer_implementation"
    | "reconcile_job";
  payload: Record<string, unknown>;
}

export type EffectStatus = "pending" | "leased" | "done" | "failed" | "dead";

export interface StoredEffect extends JobEffect {
  status: EffectStatus;
  attempts: number;
  leaseOwner: string | null;
  leaseGeneration: number | null;
  leaseExpiresAt: number | null;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type JobEvent =
  | {
      type: "PROJECT_SELECTED";
      projectId: string;
      policyVersion: number;
      policy: ProjectPolicy;
    }
  | { type: "CONFIRMED" }
  | { type: "PLAN_CREATED"; attemptId: string; threadId: string; environmentId: string }
  | { type: "PLAN_READY"; attemptId: string }
  | { type: "CRITIQUE_PASSED"; attemptId: string }
  | { type: "CRITIQUE_NEEDS_REVISION"; attemptId: string; summary: string }
  | { type: "IMPLEMENTATION_CREATED"; threadId: string; environmentId: string }
  | { type: "IMPLEMENTATION_IDLE" }
  | { type: "PR_LOCATED"; number: number; url: string }
  | { type: "PR_HEAD_RESOLVED"; headSha: string }
  | { type: "REVIEW_STARTED"; laneCount?: number }
  | {
      type: "REVIEW_PASSED";
      headSha: string;
      documentation?: Readonly<{
        required: boolean;
        diffDigest: string;
        reasons: readonly string[];
      }>;
    }
  | {
      type: "REVIEW_CHANGES_REQUESTED";
      headSha?: string;
      summary?: string;
      findings?: ReviewFinding[];
      reasons?: string[];
    }
  | {
      type: "REVIEW_BLOCKED";
      reason?: "review_limit" | "configuration" | "permanent_effect_failure";
    }
  | { type: "PR_MISSING"; reason?: string }
  | { type: "PR_UNAVAILABLE"; reason?: string }
  | { type: "REMEDIATION_SENT" }
  | { type: "VALIDATION_PASSED"; headSha: string }
  | { type: "VALIDATION_FAILED"; headSha?: string; reason?: string }
  | { type: "DOCS_CREATED"; attemptId: string; threadId: string; environmentId: string }
  | { type: "DOCS_IDLE" }
  | { type: "APPROVAL_ACCEPTED"; headSha: string }
  | { type: "APPROVAL_STALE"; headSha?: string }
  /** Start the one consensus pass this head is allowed. */
  | { type: "CONSENSUS_REQUIRED"; headSha: string }
  /** That pass produced durable evidence; decide the approval again. */
  | { type: "CONSENSUS_SETTLED"; headSha: string }
  | { type: "MERGE_SUCCEEDED"; message: string; mergeCommitSha: string; mergedAt: string; baseContentVerified: boolean }
  | { type: "MERGE_FAILED"; reason?: string }
  | { type: "DEPLOY_SUCCEEDED"; summary: string }
  | { type: "DEPLOY_FAILED"; reason: string }
  | { type: "CANARY_SUCCEEDED"; summary: string }
  | { type: "CANARY_FAILED"; reason: string }
  | { type: "THREAD_FAILED"; workerKind?: WorkerKind; error?: string }
  | {
      type: "WORKER_RECOVERY_REQUESTED";
      recoveryId: string;
      workerKind: WorkerKind;
      resourceId: string;
      classification: WorkerRecoveryClassification;
      signature: string;
      retryPayload?: Record<string, unknown>;
    }
  | { type: "WORKER_RECOVERY_REQUEUED"; recoveryId: string; retryPayload?: Record<string, unknown> }
  | { type: "FAILED"; error: string }
  | { type: "RETRY" }
  | {
      type: "CANCEL_REQUESTED";
      activeWorker?: WorkerLiveness | null;
      activeWorkers?: WorkerLiveness[];
    }
  | { type: "CANCEL_CONFIRMED" }
  | { type: "CANCELLATION_UNCONFIRMED"; reason?: string }
  | { type: "CONTINUE_REVIEW" };
