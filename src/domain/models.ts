import { z } from "zod";

export const executionProfileSchema = z
  .object({
    providerId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoningLevel: z
      .enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"])
      .optional(),
    serviceTier: z.enum(["default", "fast"]).optional(),
    permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
  })
  .strict();

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
    rollbackCommand: policyCommandSchema.optional(),
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

export const projectPolicySchema = z
  .object({
    projectId: z.string().startsWith("proj_"),
    alias: z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/),
    enabled: z.boolean(),
    githubRepository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    baseBranch: z.string().min(1),
    implementation: executionProfileSchema,
    review: executionProfileSchema,
    validationCommands: z.array(policyCommandSchema).max(20),
    production: productionPolicySchema.optional(),
    requiredChecks: z.array(z.string().min(1)).max(50),
    outputRedactionPatterns: z.array(z.string().min(1).max(200)).max(20),
    workerLivenessWatchdogMs: z.number().int().min(60_000).max(3_600_000).default(300_000),
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
  });

export type ExecutionProfile = z.infer<typeof executionProfileSchema>;
export type PolicyCommand = z.infer<typeof policyCommandSchema>;
export type ProductionPolicy = z.infer<typeof productionPolicySchema>;
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
  | "production_failed"
  | "complete"
  | "failed"
  | "blocked"
  | "cancelled"
  | "merged";

export type WorkerKind = "plan" | "critique" | "implementation" | "review" | "validation" | "docs" | "merge" | "deploy" | "canary";
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
  | "review_limit"
  | "configuration"
  | "cancellation_unconfirmed"
  | "permanent_effect_failure"
  | null;

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
    | "issue_approval"
    | "revoke_approvals"
    | "merge_pr"
    | "deploy_production"
    | "verify_production"
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
  | { type: "REVIEW_STARTED" }
  | { type: "REVIEW_PASSED"; headSha: string }
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
  | { type: "MERGE_SUCCEEDED"; message: string; mergeCommitSha: string; mergedAt: string; baseContentVerified: boolean }
  | { type: "MERGE_FAILED"; reason?: string }
  | { type: "DEPLOY_SUCCEEDED"; summary: string }
  | { type: "DEPLOY_FAILED"; reason: string }
  | { type: "CANARY_SUCCEEDED"; summary: string }
  | { type: "CANARY_FAILED"; reason: string }
  | { type: "THREAD_FAILED"; workerKind?: WorkerKind; error?: string }
  | { type: "FAILED"; error: string }
  | { type: "RETRY" }
  | { type: "CANCEL_REQUESTED"; activeWorker?: WorkerLiveness | null }
  | { type: "CANCEL_CONFIRMED" }
  | { type: "CANCELLATION_UNCONFIRMED"; reason?: string }
  | { type: "CONTINUE_REVIEW" };
