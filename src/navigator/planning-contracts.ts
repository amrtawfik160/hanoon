import { createHash } from "node:crypto";
import { z } from "zod";
import {
  NAVIGATOR_RESEARCH_STEP_CONTRACT,
  artifactBindingSchema,
  type NavigatorArtifactBinding,
  type NavigatorSkillStepContract,
} from "./models";

const identifierSchema = z.string().trim().min(1).max(256);
const boundedTextSchema = z.string().trim().min(1).max(8_000);
const evidenceRefsSchema = z.array(z.string().trim().min(1).max(1_024)).max(128);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

const artifactDraftSchema = z.object({
  title: z.string().trim().min(1).max(512),
  body: z.string().trim().min(1).max(65_536),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_048)).max(128),
}).strict();

const artifactEvidenceSchema = z.object({
  artifactId: identifierSchema,
  snapshotId: identifierSchema,
  snapshotDigest: sha256Schema,
  finding: boundedTextSchema,
  evidenceRefs: evidenceRefsSchema,
}).strict();

const setupResultSchema = z.object({
  kind: z.literal("setup_result"),
  summary: boundedTextSchema,
  trackerKind: z.enum(["github", "local_markdown"]),
  trackerNamespace: z.string().trim().min(1).max(1_024),
  evidenceRefs: evidenceRefsSchema,
}).strict();

const wayfinderResultSchema = z.object({
  kind: z.literal("wayfinder_result"),
  summary: boundedTextSchema,
  map: artifactDraftSchema,
  decisionTickets: z.array(artifactDraftSchema.extend({
    blockedBy: z.array(z.number().int().min(0).max(29)).max(30),
  }).strict()).min(1).max(30),
  evidenceRefs: evidenceRefsSchema,
}).strict();

const toSpecResultSchema = z.object({
  kind: z.literal("to_spec_result"),
  summary: boundedTextSchema,
  specification: artifactDraftSchema,
  evidenceRefs: evidenceRefsSchema,
}).strict();

const toTicketsResultSchema = z.object({
  kind: z.literal("to_tickets_result"),
  summary: boundedTextSchema,
  tickets: z.array(artifactDraftSchema.extend({
    blockedBy: z.array(z.number().int().min(0).max(31)).max(32),
  }).strict()).min(1).max(32),
  evidenceRefs: evidenceRefsSchema,
}).strict();

const prototypeResultSchema = z.object({
  kind: z.literal("prototype_result"),
  summary: boundedTextSchema,
  verdict: boundedTextSchema,
  assetRef: z.string().trim().min(1).max(2_048),
  artifactEvidence: z.array(artifactEvidenceSchema).min(1).max(32),
}).strict();

const handoffResultSchema = z.object({
  kind: z.literal("handoff_result"),
  summary: boundedTextSchema,
  handoffRef: z.string().trim().min(1).max(2_048),
  evidenceRefs: evidenceRefsSchema,
}).strict();

const askMattResultSchema = z.object({
  kind: z.literal("ask_matt_result"),
  decisionDigest: sha256Schema,
  advice: boundedTextSchema,
  suggestedSkillIds: z.array(identifierSchema).max(32),
  evidenceRefs: evidenceRefsSchema,
}).strict();

export const navigatorPlanningResultSchema = z.discriminatedUnion("kind", [
  setupResultSchema,
  wayfinderResultSchema,
  toSpecResultSchema,
  toTicketsResultSchema,
  prototypeResultSchema,
  handoffResultSchema,
  askMattResultSchema,
]);

export type NavigatorPlanningResult = Readonly<z.infer<typeof navigatorPlanningResultSchema>>;

export const navigatorPlanningInputSchema = z.object({
  kind: z.literal("navigator_planning_input"),
  skillId: identifierSchema,
  objective: boundedTextSchema,
  artifactBindings: z.array(artifactBindingSchema).max(128),
  evidenceRefs: evidenceRefsSchema,
  routingDecisionDigest: sha256Schema.nullable(),
}).strict();

export type NavigatorPlanningInput = Readonly<z.infer<typeof navigatorPlanningInputSchema>>;

type PlanningSkillId =
  | "setup-matt-pocock-skills"
  | "wayfinder"
  | "to-spec"
  | "to-tickets"
  | "research"
  | "prototype"
  | "handoff"
  | "ask-matt";

const RESULT_KIND_BY_SKILL: Readonly<Record<
  Exclude<PlanningSkillId, "research">,
  NavigatorPlanningResult["kind"]
>> = {
  "setup-matt-pocock-skills": "setup_result",
  wayfinder: "wayfinder_result",
  "to-spec": "to_spec_result",
  "to-tickets": "to_tickets_result",
  prototype: "prototype_result",
  handoff: "handoff_result",
  "ask-matt": "ask_matt_result",
};

function digestJson(subject: unknown): string {
  return createHash("sha256").update(JSON.stringify(subject), "utf8").digest("hex");
}

function planningContract(input: Omit<NavigatorSkillStepContract, "digest">): NavigatorSkillStepContract {
  return Object.freeze({ ...input, digest: digestJson(input) });
}

const sharedContract = {
  revision: 1,
  inputSchema: "navigator-planning-input-v1" as const,
  mandatoryEvidence: ["structured_result", "bb_resource"],
  modelPools: ["strong"] as const,
  timeoutMs: 600_000,
  maximumResultBytes: 64_000,
  retryClass: "resume_bound_resource" as const,
};

export const NAVIGATOR_PLANNING_STEP_CONTRACTS: Readonly<Record<PlanningSkillId, NavigatorSkillStepContract>> =
  Object.freeze({
    "setup-matt-pocock-skills": planningContract({
      ...sharedContract,
      id: "navigator-setup",
      skillId: "setup-matt-pocock-skills",
      invocationClass: "user",
      allowedArtifactKinds: [],
      minimumSubjects: 0,
      operationClass: "read_only",
      resourceClass: "bb_thread_read_only",
      resultSchema: "navigator-setup-result-v1",
    }),
    wayfinder: planningContract({
      ...sharedContract,
      id: "navigator-wayfinder",
      skillId: "wayfinder",
      invocationClass: "user",
      allowedArtifactKinds: ["map", "decision_ticket", "specification", "implementation_ticket"],
      minimumSubjects: 1,
      operationClass: "artifact_write",
      resourceClass: "bb_thread_read_only",
      resultSchema: "navigator-wayfinder-result-v1",
    }),
    "to-spec": planningContract({
      ...sharedContract,
      id: "navigator-to-spec",
      skillId: "to-spec",
      invocationClass: "user",
      allowedArtifactKinds: ["map", "decision_ticket", "specification"],
      minimumSubjects: 1,
      operationClass: "artifact_write",
      resourceClass: "bb_thread_read_only",
      resultSchema: "navigator-to-spec-result-v1",
    }),
    "to-tickets": planningContract({
      ...sharedContract,
      id: "navigator-to-tickets",
      skillId: "to-tickets",
      invocationClass: "user",
      allowedArtifactKinds: ["specification"],
      minimumSubjects: 1,
      operationClass: "artifact_write",
      resourceClass: "bb_thread_read_only",
      resultSchema: "navigator-to-tickets-result-v1",
    }),
    research: NAVIGATOR_RESEARCH_STEP_CONTRACT,
    prototype: planningContract({
      ...sharedContract,
      id: "navigator-prototype",
      skillId: "prototype",
      invocationClass: "model",
      allowedArtifactKinds: ["map", "decision_ticket", "specification"],
      minimumSubjects: 1,
      operationClass: "read_only",
      resourceClass: "bb_thread_read_only",
      resultSchema: "navigator-prototype-result-v1",
    }),
    handoff: planningContract({
      ...sharedContract,
      id: "navigator-handoff",
      skillId: "handoff",
      invocationClass: "user",
      allowedArtifactKinds: ["map", "decision_ticket", "specification", "implementation_ticket"],
      minimumSubjects: 1,
      operationClass: "read_only",
      resourceClass: "bb_thread_read_only",
      resultSchema: "navigator-handoff-result-v1",
    }),
    "ask-matt": planningContract({
      ...sharedContract,
      id: "navigator-ask-matt",
      skillId: "ask-matt",
      invocationClass: "user",
      allowedArtifactKinds: ["map", "decision_ticket", "specification", "implementation_ticket"],
      minimumSubjects: 0,
      operationClass: "read_only",
      resourceClass: "bb_thread_read_only",
      resultSchema: "navigator-ask-matt-result-v1",
    }),
  });

export function navigatorStepContract(skillId: string): NavigatorSkillStepContract | null {
  return Object.prototype.hasOwnProperty.call(NAVIGATOR_PLANNING_STEP_CONTRACTS, skillId)
    ? NAVIGATOR_PLANNING_STEP_CONTRACTS[skillId as PlanningSkillId]
    : null;
}

function blockersAreOrdered(planningOutcome: NavigatorPlanningResult): boolean {
  if (planningOutcome.kind !== "wayfinder_result" && planningOutcome.kind !== "to_tickets_result") return true;
  const drafts = planningOutcome.kind === "wayfinder_result"
    ? planningOutcome.decisionTickets
    : planningOutcome.tickets;
  return drafts.every((draft, index) =>
    new Set(draft.blockedBy).size === draft.blockedBy.length &&
    draft.blockedBy.every((blocker) => blocker < index));
}

export function safeParseNavigatorStepResult(skillId: string, rawOutcome: unknown): unknown | null {
  if (skillId === "research") return rawOutcome;
  const parsed = navigatorPlanningResultSchema.safeParse(rawOutcome);
  if (!parsed.success) return null;
  const expectedKind = RESULT_KIND_BY_SKILL[skillId as Exclude<PlanningSkillId, "research">];
  return parsed.data.kind === expectedKind && blockersAreOrdered(parsed.data) ? parsed.data : null;
}

export function parseNavigatorStepResult(skillId: string, rawOutcome: unknown): unknown {
  const parsedOutcome = safeParseNavigatorStepResult(skillId, rawOutcome);
  if (parsedOutcome === null) throw new TypeError(`navigator result does not match ${skillId}`);
  return parsedOutcome;
}

export type NavigatorRoutingSignals = Readonly<{
  trackerConfigured: boolean;
  specificationReady: boolean;
  hugeMultiSessionEffort: boolean;
  routeToDestinationVisible: boolean;
  needsPrimarySourceFacts: boolean;
  runnableDesignQuestion: boolean;
  workingDirectoryAvailable: boolean;
  requirementsUnclear: boolean;
}>;

export type NavigatorPlanningRoute =
  | "setup-matt-pocock-skills"
  | "wayfinder"
  | "research"
  | "prototype"
  | "grill-with-docs"
  | "to-spec"
  | "to-tickets";

export function selectNavigatorPlanningRoute(signals: NavigatorRoutingSignals): NavigatorPlanningRoute {
  if (!signals.trackerConfigured) return "setup-matt-pocock-skills";
  if (signals.specificationReady) return "to-tickets";
  if (signals.needsPrimarySourceFacts) return "research";
  if (signals.runnableDesignQuestion) return "prototype";
  if (signals.hugeMultiSessionEffort && !signals.routeToDestinationVisible) return "wayfinder";
  if (signals.workingDirectoryAvailable && signals.requirementsUnclear) return "grill-with-docs";
  return "to-spec";
}

export function navigatorPlanningInput(input: Readonly<{
  skillId: string;
  objective: string;
  artifactBindings: readonly NavigatorArtifactBinding[];
  evidenceRefs: readonly string[];
  routingDecisionDigest?: string | null;
}>): NavigatorPlanningInput {
  return navigatorPlanningInputSchema.parse({
    kind: "navigator_planning_input",
    skillId: input.skillId,
    objective: input.objective,
    artifactBindings: input.artifactBindings,
    evidenceRefs: input.evidenceRefs,
    routingDecisionDigest: input.routingDecisionDigest ?? null,
  });
}
