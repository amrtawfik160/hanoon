import { createHash } from "node:crypto";
import { z } from "zod";
import { SKILL_ADMISSION_CATALOG } from "../capabilities/catalog";
import { modelRouteSchema } from "../capabilities/models";
import { projectPolicySchema } from "../domain/models";
import { artifactBindingSchema } from "./models";
import type { WorkArtifactSnapshot } from "../work-artifacts/models";

const identifierSchema = z.string().trim().min(1).max(256);
const boundedTextSchema = z.string().trim().min(1).max(8_000);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const requiredEvidenceRefsSchema = z.array(z.string().trim().min(1).max(1_024)).min(1).max(128);
const projectPathSchema = z.string().trim().min(1).max(4_096).refine(
  (path) => !path.startsWith("/") && !path.includes("\0") &&
    path.split(/[\\/]/u).every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
  "changed paths must be safe project-relative paths",
);
const taskEvidenceSchema = z.array(z.enum([
  "reproducible-bug",
  "behavioral-change",
  "interface-design",
  "merge-conflict",
  "agent-instructions",
])).max(5);

export const navigatorReviewFindingSchema = z.object({
  rootCauseId: identifierSchema,
  capabilityId: identifierSchema,
  ruleId: identifierSchema,
  severity: z.enum(["critical", "high", "medium", "low"]),
  subject: projectPathSchema,
  line: z.number().int().positive().nullable(),
  requirementId: identifierSchema.nullable(),
  summary: boundedTextSchema,
  evidenceRefs: requiredEvidenceRefsSchema,
}).strict();
export type NavigatorReviewFinding = Readonly<z.infer<typeof navigatorReviewFindingSchema>>;

const profileAssignmentSchema = z.object({
  capabilityId: identifierSchema,
  descriptorDigest: sha256Schema,
  invocationClass: z.enum(["user", "model"]),
  mandatory: z.boolean(),
}).strict();

export const navigatorTicketWorkerProfileSchema = z.object({
  role: z.enum(["implementation", "review"]),
  assignments: z.array(profileAssignmentSchema).min(1).max(16),
  denials: z.array(z.object({
    capabilityId: identifierSchema,
    reasonCode: identifierSchema,
  }).strict()).max(16),
  digest: sha256Schema,
}).strict();

export type NavigatorTicketWorkerProfile = Readonly<z.infer<typeof navigatorTicketWorkerProfileSchema>>;
export type NavigatorTicketTaskEvidence = Readonly<z.infer<typeof taskEvidenceSchema>>;

export const navigatorTicketWorkOrderSchema = z.object({
  kind: z.literal("navigator_ticket_work_order"),
  jobId: identifierSchema,
  integrationBranch: identifierSchema,
  baseBranch: identifierSchema,
  worktreeId: identifierSchema,
  baseHeadSha: gitShaSchema,
  comparisonBaseHeadSha: gitShaSchema,
  projectPolicyVersion: z.number().int().positive(),
  projectPolicy: projectPolicySchema,
  projectPolicyDigest: sha256Schema,
  specification: artifactBindingSchema,
  ticket: artifactBindingSchema,
  taskEvidence: taskEvidenceSchema,
  evidenceRefs: requiredEvidenceRefsSchema,
  changedPaths: z.array(projectPathSchema).max(512),
  verificationOf: z.object({
    attemptId: identifierSchema,
    resultDigest: sha256Schema,
    findings: z.array(navigatorReviewFindingSchema).min(1).max(128),
  }).strict().optional(),
}).strict().superRefine((workOrder, context) => {
  if (navigatorJsonDigest(workOrder.projectPolicy) !== workOrder.projectPolicyDigest) {
    context.addIssue({
      code: "custom",
      path: ["projectPolicyDigest"],
      message: "project policy digest must match the immutable policy",
    });
  }
});

export type NavigatorTicketWorkOrder = Readonly<z.infer<typeof navigatorTicketWorkOrderSchema>>;

const verificationReceiptSchema = z.object({
  command: z.string().trim().min(1).max(8_000),
  outcome: z.enum(["passed", "failed"]),
}).strict();

const capabilityOutcomeSchema = z.object({
  capabilityId: identifierSchema,
  outcome: z.enum(["passed", "findings", "blocked", "failed"]),
  evidenceRefs: requiredEvidenceRefsSchema,
}).strict();

const acceptanceCriterionResultSchema = z.object({
  criterionId: identifierSchema,
  outcome: z.enum(["passed", "blocked"]),
  evidenceRefs: requiredEvidenceRefsSchema,
}).strict();

export const navigatorImplementationResultSchema = z.object({
  kind: z.literal("implementation_result"),
  baseHeadSha: gitShaSchema,
  headSha: gitShaSchema,
  summary: boundedTextSchema,
  changedPaths: z.array(projectPathSchema).max(512),
  focusedVerification: z.array(verificationReceiptSchema).min(1).max(64),
  fullVerification: z.array(verificationReceiptSchema).min(1).max(64),
  acceptanceCriteria: z.array(acceptanceCriterionResultSchema).max(128),
  capabilityOutcomes: z.array(capabilityOutcomeSchema).min(1).max(16),
}).strict();

export const navigatorCodeReviewResultSchema = z.object({
  kind: z.literal("code_review_result"),
  reviewedHeadSha: gitShaSchema,
  outcome: z.enum(["passed", "findings"]),
  summary: boundedTextSchema,
  axes: z.object({
    requirements: z.object({
      outcome: z.enum(["passed", "findings"]),
      evidenceRefs: requiredEvidenceRefsSchema,
    }).strict(),
    standards: z.object({
      outcome: z.enum(["passed", "findings"]),
      evidenceRefs: requiredEvidenceRefsSchema,
    }).strict(),
  }).strict(),
  findings: z.array(navigatorReviewFindingSchema).max(128),
  capabilityOutcomes: z.array(capabilityOutcomeSchema).min(1).max(16),
}).strict().superRefine((result, context) => {
  if ((result.outcome === "passed") !== (result.findings.length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "a passing review has no findings and a findings review has at least one",
    });
  }
  const axisHasFindings = result.axes.requirements.outcome === "findings" || result.axes.standards.outcome === "findings";
  if ((result.outcome === "findings") !== axisHasFindings) {
    context.addIssue({
      code: "custom",
      path: ["axes"],
      message: "review outcome must match the separate requirements and standards axes",
    });
  }
});

export const navigatorTicketWorkerResultSchema = z.discriminatedUnion("kind", [
  navigatorImplementationResultSchema,
  navigatorCodeReviewResultSchema,
]);

export type NavigatorTicketWorkerResult = Readonly<z.infer<typeof navigatorTicketWorkerResultSchema>>;

const navigatorWorkerResourceObservationSchema = z.object({
  resource: z.object({
    kind: z.literal("bb_thread"),
    id: identifierSchema,
  }).strict(),
  state: z.enum(["terminal", "missing"]),
  evidenceRef: boundedTextSchema,
  observedAt: z.number().int().nonnegative(),
}).strict();

export const navigatorTicketWorkerUnavailableResultSchema = z.object({
  kind: z.literal("worker_unavailable"),
  reason: z.enum(["missing", "stale"]),
  resourceObservation: navigatorWorkerResourceObservationSchema,
}).strict();

export const navigatorTicketWorkerFailureResultSchema = z.object({
  kind: z.literal("worker_failure"),
  failureClass: z.enum(["retryable", "permanent"]),
  retryClass: z.literal("bounded_exponential"),
  attempts: z.number().int().positive(),
  summary: boundedTextSchema,
}).strict();

export const navigatorTicketWorkerReceiptResultSchema = z.union([
  navigatorTicketWorkerResultSchema,
  navigatorTicketWorkerUnavailableResultSchema,
  navigatorTicketWorkerFailureResultSchema,
]);

export type NavigatorTicketWorkerUnavailableResult = Readonly<z.infer<typeof navigatorTicketWorkerUnavailableResultSchema>>;
export type NavigatorTicketWorkerFailureResult = Readonly<z.infer<typeof navigatorTicketWorkerFailureResultSchema>>;
export type NavigatorTicketWorkerReceiptResult = Readonly<z.infer<typeof navigatorTicketWorkerReceiptResultSchema>>;

export type NavigatorAcceptanceCriterion = Readonly<{
  id: string;
  text: string;
}>;

export function navigatorAcceptanceCriteria(snapshot: WorkArtifactSnapshot): readonly NavigatorAcceptanceCriterion[] {
  return snapshot.acceptanceCriteria.map((text, index) => ({
    id: `ac:${String(index + 1)}:${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 24)}`,
    text,
  }));
}

export function navigatorAcceptanceCriteriaAreSatisfied(
  snapshot: WorkArtifactSnapshot,
  results: readonly Readonly<{ criterionId: string; outcome: "passed" | "blocked" }>[],
): boolean {
  const expected = navigatorAcceptanceCriteria(snapshot).map((criterion) => criterion.id);
  return JSON.stringify(results.map((result) => result.criterionId)) === JSON.stringify(expected) &&
    results.every((result) => result.outcome === "passed");
}

export const navigatorTicketRepairSnapshotSchema = z.object({
  kind: z.literal("navigator_ticket_repair_snapshot"),
  snapshotId: identifierSchema,
  digest: sha256Schema,
  jobId: identifierSchema,
  sliceId: identifierSchema,
  ticket: artifactBindingSchema,
  reviewAttemptId: identifierSchema,
  reviewedHeadSha: gitShaSchema,
  reviewResultDigest: sha256Schema,
  gitObservationDigest: sha256Schema,
  findings: z.array(navigatorReviewFindingSchema).min(1).max(128),
  evidenceRefs: requiredEvidenceRefsSchema,
  createdAt: z.number().int().min(0),
}).strict();

export type NavigatorTicketRepairSnapshot = Readonly<z.infer<typeof navigatorTicketRepairSnapshotSchema>>;

const repairProposalBase = {
  basedOn: z.object({ snapshotId: identifierSchema, digest: sha256Schema }).strict(),
  objective: boundedTextSchema,
  evidenceRefs: requiredEvidenceRefsSchema,
};

export const navigatorTicketRepairProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    ...repairProposalBase,
    kind: z.literal("implementation"),
    taskEvidence: taskEvidenceSchema,
  }).strict(),
  z.object({ ...repairProposalBase, kind: z.literal("diagnosis") }).strict(),
  z.object({ ...repairProposalBase, kind: z.literal("research") }).strict(),
  z.object({ ...repairProposalBase, kind: z.literal("owner_boundary") }).strict(),
]);

export type NavigatorTicketRepairProposal = Readonly<z.infer<typeof navigatorTicketRepairProposalSchema>>;

export const navigatorGitObservationSchema = z.object({
  kind: z.literal("navigator_git_observation"),
  worktreeId: identifierSchema,
  branch: identifierSchema,
  headSha: gitShaSchema,
  baseHeadSha: gitShaSchema,
  baseHeadIsAncestor: z.boolean(),
  comparisonBaseHeadSha: gitShaSchema,
  comparisonBaseHeadIsAncestor: z.boolean(),
  clean: z.boolean(),
  changedPaths: z.array(projectPathSchema).max(512),
  evidenceRef: z.string().trim().min(1).max(1_024),
  observedAt: z.number().int().min(0),
}).strict();

export type NavigatorGitObservation = Readonly<z.infer<typeof navigatorGitObservationSchema>>;

export const navigatorPullRequestRequestSchema = z.object({
  operationId: identifierSchema,
  jobId: identifierSchema,
  baseBranch: identifierSchema,
  integrationBranch: identifierSchema,
  headSha: gitShaSchema,
  title: z.string().trim().min(1).max(256),
  body: z.string().trim().min(1).max(65_536),
  gitObservation: navigatorGitObservationSchema,
  gitObservationDigest: sha256Schema,
  evidenceRefs: requiredEvidenceRefsSchema,
}).strict().superRefine((request, context) => {
  if (navigatorJsonDigest(request.gitObservation) !== request.gitObservationDigest) {
    context.addIssue({
      code: "custom",
      path: ["gitObservationDigest"],
      message: "pull request Git observation digest must match its immutable evidence",
    });
  }
});

export type NavigatorPullRequestRequest = Readonly<z.infer<typeof navigatorPullRequestRequestSchema>>;

export type NavigatorPullRequestRecord = Readonly<{
  operationId: string;
  jobId: string;
  number: number;
  url: string;
  headSha: string;
}>;

const navigatorTicketStepContractBase = {
  id: identifierSchema,
  revision: z.number().int().positive(),
  skillId: z.enum(["implement", "code-review"]),
  freshContext: z.literal(true),
  codeWriting: z.boolean(),
  resourceClass: z.literal("managed_integration_worktree"),
  resultSchema: z.enum(["navigator-implementation-result-v1", "navigator-code-review-result-v1"]),
  mandatoryEvidence: z.array(identifierSchema).min(1).max(16),
  modelPools: z.array(z.enum(["standard", "strong"])).min(1).max(2),
  timeoutMs: z.number().int().positive(),
  maximumResultBytes: z.number().int().positive(),
} as const;

const navigatorTicketStepContractV1Schema = z.object({
  ...navigatorTicketStepContractBase,
  digest: sha256Schema,
}).strict();

export const navigatorTicketStepContractSchema = z.object({
  ...navigatorTicketStepContractBase,
  retryClass: z.literal("bounded_exponential"),
  maximumAttempts: z.number().int().min(1).max(20),
  backoffBaseMs: z.number().int().positive().max(30_000),
  backoffMaximumMs: z.number().int().positive().max(300_000),
  digest: sha256Schema,
}).strict();

export const navigatorPersistedTicketStepContractSchema = z.union([
  navigatorTicketStepContractSchema,
  navigatorTicketStepContractV1Schema,
]);

export type NavigatorTicketStepContract = Readonly<z.infer<typeof navigatorTicketStepContractSchema>>;
export type NavigatorPersistedTicketStepContract = Readonly<z.infer<typeof navigatorPersistedTicketStepContractSchema>>;

const DISCIPLINE_BY_EVIDENCE: Readonly<Record<NavigatorTicketTaskEvidence[number], string>> = {
  "reproducible-bug": "diagnosing-bugs",
  "behavioral-change": "tdd",
  "interface-design": "codebase-design",
  "merge-conflict": "resolving-merge-conflicts",
  "agent-instructions": "writing-for-agents",
};

function digestJson(subject: unknown): string {
  return createHash("sha256").update(JSON.stringify(subject), "utf8").digest("hex");
}

function ticketStepContract(
  input: Omit<NavigatorTicketStepContract, "digest">,
): NavigatorTicketStepContract {
  return Object.freeze({ ...input, digest: digestJson(input) });
}

export const NAVIGATOR_TICKET_STEP_CONTRACTS = Object.freeze({
  implementation: ticketStepContract({
    id: "navigator-ticket-implementation",
    revision: 3,
    skillId: "implement",
    freshContext: true,
    codeWriting: true,
    resourceClass: "managed_integration_worktree",
    resultSchema: "navigator-implementation-result-v1",
    mandatoryEvidence: ["ticket_snapshot", "specification_snapshot", "acceptance_criteria", "focused_verification", "full_verification"],
    modelPools: ["standard", "strong"],
    timeoutMs: 14_400_000,
    maximumResultBytes: 256_000,
    retryClass: "bounded_exponential",
    maximumAttempts: 5,
    backoffBaseMs: 500,
    backoffMaximumMs: 30_000,
  }),
  review: ticketStepContract({
    id: "navigator-ticket-code-review",
    revision: 3,
    skillId: "code-review",
    freshContext: true,
    codeWriting: false,
    resourceClass: "managed_integration_worktree",
    resultSchema: "navigator-code-review-result-v1",
    mandatoryEvidence: ["ticket_snapshot", "specification_snapshot", "requirements_review", "standards_review", "exact_head_review"],
    modelPools: ["strong"],
    timeoutMs: 3_600_000,
    maximumResultBytes: 256_000,
    retryClass: "bounded_exponential",
    maximumAttempts: 5,
    backoffBaseMs: 500,
    backoffMaximumMs: 30_000,
  }),
});

function assignment(capabilityId: string) {
  const descriptor = SKILL_ADMISSION_CATALOG.find((entry) => entry.id === capabilityId);
  if (!descriptor) throw new Error(`navigator ticket capability ${capabilityId} is not admitted`);
  return {
    capabilityId,
    descriptorDigest: descriptor.bundleDescriptorDigest,
    invocationClass: descriptor.invocationClass,
    mandatory: true,
  } as const;
}

function reviewGuardIds(changedPaths: readonly string[]): string[] {
  const selected = new Set<string>(["code-review"]);
  if (changedPaths.some((path) => /(?:^|\/)src\//u.test(path) || /\.(?:[cm]?[jt]sx?|py|go|rs|php)$/u.test(path))) {
    selected.add("clean-code-guard");
  }
  if (changedPaths.some((path) => /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path))) {
    selected.add("test-guard");
  }
  if (changedPaths.some((path) => /(?:^|\/)(?:docs?|README|CONTRIBUTING|CHANGELOG)(?:[./]|$)|\.md$/iu.test(path))) {
    selected.add("docs-guard");
  }
  return [...selected].sort((left, right) => left.localeCompare(right));
}

export function navigatorTicketWorkerProfile(input: Readonly<{
  kind: "implementation" | "review";
  taskEvidence: readonly string[];
  changedPaths: readonly string[];
}>): NavigatorTicketWorkerProfile {
  const taskEvidence = taskEvidenceSchema.parse(input.taskEvidence);
  const capabilityIds = input.kind === "implementation"
    ? [
      "implement",
      ...taskEvidence.map((evidence) => DISCIPLINE_BY_EVIDENCE[evidence]),
    ].sort((left, right) => left.localeCompare(right))
    : reviewGuardIds(input.changedPaths);
  const assignments = [...new Set(capabilityIds)].map(assignment);
  const unsigned = {
    role: input.kind,
    assignments,
    denials: [],
  } as const;
  return navigatorTicketWorkerProfileSchema.parse({ ...unsigned, digest: digestJson(unsigned) });
}

export function parseNavigatorTicketModelRoute(route: unknown, kind: "implementation" | "review") {
  const parsed = modelRouteSchema.parse(route);
  if (kind === "implementation" && parsed.pool === "fast") {
    throw new TypeError("navigator ticket implementation requires a standard or strong model route");
  }
  if (kind === "review" && parsed.pool !== "strong") {
    throw new TypeError("navigator ticket review requires a strong model route");
  }
  return parsed;
}

export function navigatorJsonDigest(subject: unknown): string {
  return digestJson(subject);
}
