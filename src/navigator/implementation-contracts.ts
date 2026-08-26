import { createHash } from "node:crypto";
import { z } from "zod";
import { SKILL_ADMISSION_CATALOG } from "../capabilities/catalog";
import { modelRouteSchema } from "../capabilities/models";
import { projectPolicySchema } from "../domain/models";
import { artifactBindingSchema } from "./models";

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

export const navigatorImplementationResultSchema = z.object({
  kind: z.literal("implementation_result"),
  baseHeadSha: gitShaSchema,
  headSha: gitShaSchema,
  summary: boundedTextSchema,
  changedPaths: z.array(projectPathSchema).max(512),
  focusedVerification: z.array(verificationReceiptSchema).min(1).max(64),
  fullVerification: z.array(verificationReceiptSchema).min(1).max(64),
  capabilityOutcomes: z.array(capabilityOutcomeSchema).min(1).max(16),
}).strict();

const reviewFindingSchema = z.object({
  ruleId: identifierSchema,
  severity: z.enum(["critical", "high", "medium", "low"]),
  summary: boundedTextSchema,
  evidenceRefs: requiredEvidenceRefsSchema,
}).strict();

export const navigatorCodeReviewResultSchema = z.object({
  kind: z.literal("code_review_result"),
  reviewedHeadSha: gitShaSchema,
  outcome: z.enum(["passed", "findings"]),
  summary: boundedTextSchema,
  findings: z.array(reviewFindingSchema).max(128),
  capabilityOutcomes: z.array(capabilityOutcomeSchema).min(1).max(16),
}).strict().superRefine((result, context) => {
  if ((result.outcome === "passed") !== (result.findings.length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "a passing review has no findings and a findings review has at least one",
    });
  }
});

export const navigatorTicketWorkerResultSchema = z.discriminatedUnion("kind", [
  navigatorImplementationResultSchema,
  navigatorCodeReviewResultSchema,
]);

export type NavigatorTicketWorkerResult = Readonly<z.infer<typeof navigatorTicketWorkerResultSchema>>;

export const navigatorPullRequestRequestSchema = z.object({
  operationId: identifierSchema,
  jobId: identifierSchema,
  baseBranch: identifierSchema,
  integrationBranch: identifierSchema,
  headSha: gitShaSchema,
  title: z.string().trim().min(1).max(256),
  body: z.string().trim().min(1).max(65_536),
  evidenceRefs: requiredEvidenceRefsSchema,
}).strict();

export type NavigatorPullRequestRequest = Readonly<z.infer<typeof navigatorPullRequestRequestSchema>>;

export type NavigatorPullRequestRecord = Readonly<{
  operationId: string;
  jobId: string;
  number: number;
  url: string;
  headSha: string;
}>;

export type NavigatorTicketStepContract = Readonly<{
  id: string;
  revision: number;
  skillId: "implement" | "code-review";
  freshContext: true;
  codeWriting: boolean;
  resourceClass: "managed_integration_worktree";
  resultSchema: "navigator-implementation-result-v1" | "navigator-code-review-result-v1";
  mandatoryEvidence: readonly string[];
  modelPools: readonly ("standard" | "strong")[];
  timeoutMs: number;
  maximumResultBytes: number;
  digest: string;
}>;

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
    revision: 1,
    skillId: "implement",
    freshContext: true,
    codeWriting: true,
    resourceClass: "managed_integration_worktree",
    resultSchema: "navigator-implementation-result-v1",
    mandatoryEvidence: ["ticket_snapshot", "specification_snapshot", "focused_verification", "full_verification"],
    modelPools: ["standard", "strong"],
    timeoutMs: 14_400_000,
    maximumResultBytes: 256_000,
  }),
  review: ticketStepContract({
    id: "navigator-ticket-code-review",
    revision: 1,
    skillId: "code-review",
    freshContext: true,
    codeWriting: false,
    resourceClass: "managed_integration_worktree",
    resultSchema: "navigator-code-review-result-v1",
    mandatoryEvidence: ["ticket_snapshot", "specification_snapshot", "exact_head_review"],
    modelPools: ["strong"],
    timeoutMs: 3_600_000,
    maximumResultBytes: 256_000,
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
