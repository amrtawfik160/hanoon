import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { modelRouteSchema, type ModelRoute } from "../capabilities/models";
import type { Job, StoredEffect } from "../domain/models";
import type { TaskAuthorityEffect } from "../domain/task-authority";
import type { OwnerBoundaryDraft } from "../domain/owner-boundary";
import {
  CAPABILITY_GRAPH_DIGEST,
  CAPABILITY_REGISTRY_DIGEST,
} from "../capabilities/catalog";
import {
  CapabilityRepository,
  type CapabilityProfile,
} from "../storage/capability-repository";
import { DEFAULT_MODEL_POOL_REGISTRY } from "../capabilities/models";
import type {
  NavigatorCapabilityAssignment,
  NavigatorCapabilityEvidence,
  NavigatorCapabilityOperation,
  NavigatorSkillReceipt,
} from "./effect-contracts";
import type { NavigatorTicketAttemptContext } from "./effect-contracts";
import type { NavigatorTicketWorkerAttempt } from "./implementation-executor";
import {
  navigatorJsonDigest,
  navigatorPersistedTicketStepContractSchema,
  navigatorTicketWorkerProfileSchema,
  navigatorTicketWorkOrderSchema,
  parseNavigatorTicketModelRoute,
} from "./implementation-contracts";
import {
  type EffectRow,
  parseStoredEffect,
  readJobById,
  serializeBoundedJson,
  VersionConflictError,
} from "../storage/job-persistence";
import { WorkArtifactRepository } from "../work-artifacts/repository";
import { OwnerBoundaryRepository } from "../storage/owner-boundary-repository";
import { ReleaseAuthorityRepository } from "../storage/release-authority-repository";
import { taskArtifactGraphDigest, TaskAuthorityRepository } from "../storage/task-authority-repository";
import {
  navigatorPlanningInput,
  navigatorPlanningInputSchema,
  navigatorStepContract,
  parseNavigatorStepResult,
  safeParseNavigatorStepResult,
} from "./planning-contracts";
import {
  MATT_POCOCK_SKILL_REVISION,
  MAX_NAVIGATOR_JSON_BYTES,
  NAVIGATOR_ENGINE_REVISION,
  NAVIGATOR_SKILL_CATALOG,
  NAVIGATOR_SKILL_CATALOG_DIGEST,
  artifactBindingSchema,
  assertModelRouteForContract,
  freezeNavigatorSnapshot,
  navigatorInferenceObservationSchema,
  navigatorProposalSchema,
  navigatorResearchInputSchema,
  navigatorResearchResultSchema,
  navigatorSnapshotDigest,
  navigatorSnapshotSchema,
  proposalDigest,
  type NavigatorArtifactBinding,
  type NavigatorInferenceObservation,
  type NavigatorProposal,
  type NavigatorProposalDecision,
  type NavigatorProposalRecord,
  type NavigatorPlanningResultRecord,
  type NavigatorRoutingDecision,
  type NavigatorSkillAttempt,
  type NavigatorSnapshot,
  type NavigatorWorkflowStep,
  type NavigatorWorkflowStepOutcome,
} from "./models";
import { NAVIGATOR_RELEASE_STEP_SKILL_ID, type NavigatorReleaseAttempt } from "./release-contracts";

type SqliteDatabase = Database.Database;

type SnapshotRow = Readonly<{
  id: string;
  job_id: string;
  job_version: number;
  workflow_revision: number;
  digest: string;
  external_state_digest: string;
  payload_json: string;
  created_at: number;
}>;

type ProposalRow = Readonly<{
  id: string;
  job_id: string;
  snapshot_id: string;
  digest: string;
  kind: string | null;
  raw_json: string;
  proposal_json: string | null;
  observation_json: string;
  observation_digest: string;
  created_at: number;
}>;

type AttemptRow = Readonly<{
  id: string;
  job_id: string;
  workflow_step_id: string;
  effect_idempotency_key: string;
  skill_id: string;
  skill_revision: string;
  skill_source_digest: string;
  descriptor_digest: string;
  step_contract_id: string;
  step_contract_revision: number;
  step_contract_digest: string;
  catalog_digest: string;
  step_input_json: string;
  step_input_digest: string;
  model_route_json: string;
  artifact_bindings_json: string;
  snapshot_digest: string;
  job_version: number;
  workflow_revision: number;
  resource_kind: string | null;
  resource_id: string | null;
  created_at: number;
  updated_at: number;
  capability_profile_id: string | null;
  capability_profile_revision: number | null;
}>;

type NavigatorCapabilityEvidenceRow = Readonly<{
  effect_idempotency_key: string;
  job_id: string;
  project_id: string;
  operation: NavigatorCapabilityOperation;
  profile_id: string;
  profile_revision: number;
  capability_id: string;
  capability_kind: "skill" | "tool" | "bundle" | "native-adapter" | "model" | "connector" | "recipe";
  descriptor_digest: string;
  receipt_id: string;
  owner_id: string | null;
  generation: number | null;
}>;

type TicketAttemptRow = Readonly<{
  id: string;
  job_id: string;
  slice_id: string;
  kind: "implementation" | "review";
  ordinal: number;
  effect_idempotency_key: string;
  work_order_json: string;
  work_order_digest: string;
  step_contract_id: string;
  step_contract_revision: number;
  step_contract_digest: string;
  step_contract_json: string;
  profile_json: string;
  profile_digest: string;
  model_route_json: string;
  resource_kind: "bb_thread" | null;
  resource_id: string | null;
  created_at: number;
  updated_at: number;
  capability_profile_id: string | null;
  capability_profile_revision: number | null;
}>;

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive safe integer`);
}

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
}

function digestId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("base64url").slice(0, 24)}`;
}

function boundedRawJson(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = JSON.stringify({ invalid: "unserializable" });
  }
  if (serialized === undefined) serialized = JSON.stringify({ invalid: "undefined" });
  if (Buffer.byteLength(serialized, "utf8") <= MAX_NAVIGATOR_JSON_BYTES) return serialized;
  return JSON.stringify({ invalid: "oversized", digest: proposalDigest(value) });
}

function serializeNavigatorJson(value: unknown, field: string): string {
  const json = serializeBoundedJson(value, field, MAX_NAVIGATOR_JSON_BYTES);
  if (Buffer.byteLength(json, "utf8") > MAX_NAVIGATOR_JSON_BYTES) {
    throw new TypeError(`${field} must be bounded JSON`);
  }
  return json;
}

const NAVIGATOR_RELEASE_CAPABILITY_ID = "navigator-release";
const NAVIGATOR_RELEASE_DESCRIPTOR_DIGEST = createHash("sha256")
  .update("navigator-release:capability:v1", "utf8")
  .digest("hex");

function navigatorProfileModel(route: ModelRoute): ModelRoute {
  return modelRouteSchema.parse(route);
}

const NAVIGATOR_EFFECT_LEASE_QUERY = `SELECT effect.*
  FROM effects AS effect
  JOIN jobs AS job ON job.id = effect.job_id
 WHERE job.workflow_engine = 'navigator-v1' AND job.workflow_mode = 'deterministic'
   AND job.state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed')
   AND job.cancel_requested_at IS NULL
   AND (
     (
       effect.kind = 'run_navigator_skill'
       AND EXISTS (
         SELECT 1
           FROM navigator_skill_attempts AS attempt
           JOIN workflow_steps AS step ON step.id = attempt.workflow_step_id
           JOIN navigator_snapshots AS snapshot ON snapshot.id = step.snapshot_id
          WHERE attempt.effect_idempotency_key = effect.idempotency_key
            AND attempt.job_id = effect.job_id AND attempt.job_id = step.job_id
            AND step.job_id = snapshot.job_id
            AND attempt.job_version = step.job_version
            AND step.job_version = snapshot.job_version
            AND attempt.workflow_revision = step.workflow_revision
            AND step.workflow_revision = snapshot.workflow_revision
            AND attempt.snapshot_digest = snapshot.digest
            AND job.workflow_revision = step.workflow_revision
            AND job.current_workflow_step_id = attempt.workflow_step_id
            AND NOT EXISTS (
              SELECT 1 FROM workflow_step_outcomes AS outcome
               WHERE outcome.workflow_step_id = attempt.workflow_step_id
            )
       )
     )
     OR (
       effect.kind = 'run_navigator_ticket_worker'
       AND EXISTS (
         SELECT 1
           FROM navigator_ticket_worker_attempts AS attempt
           JOIN navigator_integrations AS integration ON integration.job_id = attempt.job_id
          WHERE attempt.effect_idempotency_key = effect.idempotency_key
            AND attempt.job_id = effect.job_id
            AND integration.state = 'implementing'
            AND NOT EXISTS (
              SELECT 1 FROM navigator_ticket_worker_outcomes AS outcome
               WHERE outcome.attempt_id = attempt.id
            )
       )
     )
     OR (
       effect.kind = 'run_navigator_release'
       AND EXISTS (
         SELECT 1
           FROM navigator_release_attempts AS attempt
           JOIN workflow_steps AS step ON step.id = attempt.workflow_step_id
           JOIN navigator_snapshots AS snapshot ON snapshot.id = step.snapshot_id
          WHERE attempt.effect_idempotency_key = effect.idempotency_key
            AND attempt.job_id = effect.job_id AND attempt.job_id = step.job_id
            AND step.job_id = snapshot.job_id
            AND attempt.job_version = step.job_version
            AND step.job_version = snapshot.job_version
            AND attempt.workflow_revision = step.workflow_revision
            AND step.workflow_revision = snapshot.workflow_revision
            AND attempt.snapshot_digest = snapshot.digest
            AND job.workflow_revision = step.workflow_revision
            AND job.current_workflow_step_id = attempt.workflow_step_id
            AND NOT EXISTS (
              SELECT 1 FROM navigator_release_outcomes AS outcome
               WHERE outcome.attempt_id = attempt.id
            )
       )
     )
   )
   AND ((effect.status IN ('pending', 'failed') AND effect.next_attempt_at <= ?)
     OR (effect.status = 'leased' AND effect.lease_expires_at <= ?))
 ORDER BY effect.created_at, effect.idempotency_key
 LIMIT 1`;

function parseSnapshot(row: SnapshotRow): NavigatorSnapshot {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const snapshot = navigatorSnapshotSchema.parse({
    snapshotId: row.id,
    identity: {
      jobId: row.job_id,
      jobVersion: row.job_version,
      workflowRevision: row.workflow_revision,
      digest: row.digest,
    },
    ...payload,
  });
  const expectedDigest = navigatorSnapshotDigest({
    jobId: snapshot.identity.jobId,
    jobVersion: snapshot.identity.jobVersion,
    workflowRevision: snapshot.identity.workflowRevision,
    payload: {
      engine: snapshot.engine,
      engineRevision: snapshot.engineRevision,
      mode: snapshot.mode,
      ownerRequest: snapshot.ownerRequest,
      artifactBindings: snapshot.artifactBindings,
      skillCatalog: snapshot.skillCatalog,
      catalogDigest: snapshot.catalogDigest,
      externalStateDigest: snapshot.externalStateDigest,
      evidenceRefs: snapshot.evidenceRefs,
      createdAt: snapshot.createdAt,
    },
  });
  if (snapshot.identity.digest !== expectedDigest || row.external_state_digest !== snapshot.externalStateDigest) {
    throw new Error("navigator snapshot digest binding is invalid");
  }
  return freezeNavigatorSnapshot(snapshot);
}

function parseProposal(row: ProposalRow): NavigatorProposalRecord {
  const proposal = row.proposal_json === null
    ? null
    : navigatorProposalSchema.parse(JSON.parse(row.proposal_json));
  if (proposal !== null && proposalDigest(proposal) !== row.digest) {
    throw new Error("navigator proposal digest binding is invalid");
  }
  const observation = navigatorInferenceObservationSchema.parse(JSON.parse(row.observation_json));
  const observationDigest = createHash("sha256").update(JSON.stringify(observation), "utf8").digest("hex");
  if (observationDigest !== row.observation_digest) {
    throw new Error("navigator proposal observation digest binding is invalid");
  }
  return {
    id: row.id,
    jobId: row.job_id,
    snapshotId: row.snapshot_id,
    digest: row.digest,
    kind: proposal?.kind ?? null,
    proposal,
    observation,
    observationDigest,
    createdAt: row.created_at,
  };
}

function parseAttempt(row: AttemptRow): NavigatorSkillAttempt {
  const resource = row.resource_kind === null || row.resource_id === null
    ? null
    : { kind: "bb_thread" as const, id: row.resource_id };
  const rawStepInput = JSON.parse(row.step_input_json);
  const stepInput = row.skill_id === "research"
    ? navigatorResearchInputSchema.parse(rawStepInput)
    : navigatorPlanningInputSchema.parse(rawStepInput);
  const stepInputDigest = createHash("sha256").update(JSON.stringify(stepInput), "utf8").digest("hex");
  if (stepInputDigest !== row.step_input_digest) throw new Error("navigator step input digest binding is invalid");
  const artifactBindings = artifactBindingSchema.array().parse(JSON.parse(row.artifact_bindings_json));
  if (JSON.stringify(stepInput.artifactBindings) !== JSON.stringify(artifactBindings)) {
    throw new Error("navigator step input artifact bindings are inconsistent");
  }
  return {
    id: row.id,
    jobId: row.job_id,
    workflowStepId: row.workflow_step_id,
    effectIdempotencyKey: row.effect_idempotency_key,
    skillId: row.skill_id,
    skillRevision: row.skill_revision,
    skillSourceDigest: row.skill_source_digest,
    descriptorDigest: row.descriptor_digest,
    stepContractId: row.step_contract_id,
    stepContractRevision: row.step_contract_revision,
    stepContractDigest: row.step_contract_digest,
    catalogDigest: row.catalog_digest,
    stepInput,
    stepInputDigest: row.step_input_digest,
    modelRoute: modelRouteSchema.parse(JSON.parse(row.model_route_json)),
    artifactBindings,
    snapshotDigest: row.snapshot_digest,
    jobVersion: row.job_version,
    workflowRevision: row.workflow_revision,
    resource,
    capabilityProfileId: row.capability_profile_id,
    capabilityProfileRevision: row.capability_profile_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTicketAttempt(row: TicketAttemptRow): NavigatorTicketWorkerAttempt {
  const workOrder = navigatorTicketWorkOrderSchema.parse(JSON.parse(row.work_order_json));
  const profile = navigatorTicketWorkerProfileSchema.parse(JSON.parse(row.profile_json));
  const stepContract = navigatorPersistedTicketStepContractSchema.parse(JSON.parse(row.step_contract_json));
  const { digest: _digest, ...unsignedContract } = stepContract;
  if (
    navigatorJsonDigest(workOrder) !== row.work_order_digest ||
    stepContract.id !== row.step_contract_id || stepContract.revision !== row.step_contract_revision ||
    stepContract.digest !== row.step_contract_digest || navigatorJsonDigest(unsignedContract) !== stepContract.digest ||
    profile.digest !== row.profile_digest
  ) throw new Error(`navigator ticket attempt ${row.id} has invalid durable identity`);
  return {
    id: row.id,
    jobId: row.job_id,
    sliceId: row.slice_id,
    kind: row.kind,
    ordinal: row.ordinal,
    effectIdempotencyKey: row.effect_idempotency_key,
    workOrder,
    workOrderDigest: row.work_order_digest,
    stepContract,
    profile,
    modelRoute: parseNavigatorTicketModelRoute(JSON.parse(row.model_route_json), row.kind),
    resource: row.resource_kind === null ? null : { kind: row.resource_kind, id: row.resource_id! },
    capabilityProfileId: row.capability_profile_id,
    capabilityProfileRevision: row.capability_profile_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function routingDecisionIdentity(
  job: Job,
  snapshot: NavigatorSnapshot,
  proposal: Extract<NavigatorProposal, { kind: "unresolved_next_step" }>,
): Readonly<{ decisionDigest: string; scopeDigest: string }> {
  const boundScope = {
    jobId: job.id,
    workflowRevision: job.workflowRevision,
    artifactBindings: snapshot.artifactBindings,
    question: proposal.question,
    candidateSkillIds: proposal.candidateSkillIds,
    rationale: proposal.rationale,
    evidenceRefs: proposal.evidenceRefs,
  };
  const scopeDigest = createHash("sha256")
    .update(JSON.stringify(boundScope), "utf8")
    .digest("hex");
  const decisionDigest = createHash("sha256").update(JSON.stringify({
    ...boundScope,
    navigatorSnapshotId: snapshot.snapshotId,
    navigatorSnapshotDigest: snapshot.identity.digest,
  }), "utf8").digest("hex");
  return { decisionDigest, scopeDigest };
}

function artifactEvidenceMatchesBindings(
  parsedOutcome: Record<string, unknown>,
  bindings: readonly NavigatorArtifactBinding[],
): boolean {
  if (!Array.isArray(parsedOutcome.artifactEvidence)) return false;
  const evidence = parsedOutcome.artifactEvidence as readonly Readonly<{
    artifactId: string;
    snapshotId: string;
    snapshotDigest: string;
  }>[];
  const evidenceByArtifact = new Map(evidence.map((entry) => [entry.artifactId, entry]));
  return evidenceByArtifact.size === evidence.length && evidenceByArtifact.size === bindings.length &&
    bindings.every((binding) => {
      const entry = evidenceByArtifact.get(binding.artifactId);
      return entry?.snapshotId === binding.snapshotId && entry.snapshotDigest === binding.snapshotDigest;
    });
}

function ownerBoundaryDraftFromProposal(
  proposal: Extract<NavigatorProposal, { kind: "owner_boundary" }>,
): OwnerBoundaryDraft | null {
  if (
    proposal.goal === undefined || proposal.blocker === undefined || proposal.priorChecks === undefined ||
    proposal.options === undefined || proposal.recommendation === undefined || proposal.pausedEffect === undefined ||
    (proposal.affectedArtifactId === undefined && proposal.affectedEffectIdempotencyKey === undefined)
  ) return null;
  return {
    code: proposal.boundaryCode,
    goal: proposal.goal,
    blocker: proposal.blocker,
    priorChecks: proposal.priorChecks,
    options: proposal.options,
    recommendation: proposal.recommendation,
    pausedEffect: proposal.pausedEffect,
    evidenceFacts: proposal.evidenceRefs,
    affectedArtifactId: proposal.affectedArtifactId,
    affectedEffectIdempotencyKey: proposal.affectedEffectIdempotencyKey,
  };
}

function validatedNavigatorOutcome(skillId: string, rawOutcome: unknown): Record<string, unknown> | null {
  const parsed = skillId === "research"
    ? navigatorResearchResultSchema.safeParse(rawOutcome)
    : { success: true as const, data: safeParseNavigatorStepResult(skillId, rawOutcome) };
  if (!parsed.success || parsed.data === null) return null;
  return parsed.data as Record<string, unknown>;
}

function proposalReason(
  job: Job,
  snapshot: NavigatorSnapshot,
  proposal: NavigatorProposal,
  observation: NavigatorInferenceObservation,
  artifacts: WorkArtifactRepository,
): string | null {
  if (job.workflowEngine === "recipe-v1") {
    if (job.currentWorkflowStepId !== null) return "workflow_step_active";
  } else {
    if (job.workflowEngine !== "navigator-v1") return "workflow_engine_mismatch";
    if (job.workflowMode !== "shadow" && job.workflowMode !== "deterministic") return "workflow_mode_denied";
    if (job.currentWorkflowStepId !== null) return "workflow_step_active";
  }
  if (job.version !== snapshot.identity.jobVersion || proposal.basedOn.jobVersion !== job.version) {
    return "stale_job_version";
  }
  if (
    job.workflowRevision !== snapshot.identity.workflowRevision ||
    proposal.basedOn.workflowRevision !== job.workflowRevision
  ) return "stale_workflow_revision";
  if (
    proposal.basedOn.jobId !== job.id ||
    proposal.basedOn.digest !== snapshot.identity.digest
  ) return "snapshot_digest_mismatch";
  const revisableSpecificationIds = proposal.kind === "invoke_skill" && proposal.skillId === "to-spec"
    ? new Set(proposal.subjectArtifactIds.filter((artifactId) =>
      artifacts.getArtifact(artifactId)?.kind === "specification"))
    : new Set<string>();
  for (const binding of job.artifactBindings) {
    const current = artifacts.getCurrentSnapshot(binding.artifactId);
    if (
      current?.id !== binding.snapshotId ||
      current.snapshotDigest !== binding.snapshotDigest || (
        !artifacts.isSnapshotValid(binding.snapshotId) &&
        !revisableSpecificationIds.has(binding.artifactId)
      )
    ) return "stale_artifact_snapshot";
  }
  if (observation.nativeToolCalls.length > 0) return "policy_native_tool_use";
  if (observation.claimedCodeWorktreeId !== null) return "policy_claimed_code_worktree";
  if (observation.dynamicEffectToolIds.length > 0) return "policy_dynamic_effect_tool";
  if (observation.externalStateDigest !== snapshot.externalStateDigest) return "external_drift";
  if (job.workflowMode === "shadow") return null;
  if (proposal.kind === "owner_boundary") {
    if (job.taskOutcome === null) return "owner_boundary_requires_owner_task";
    const snapshotFacts = new Set(snapshot.evidenceRefs);
    return proposal.evidenceRefs.every((fact) => snapshotFacts.has(fact))
      ? null
      : "owner_boundary_evidence_invalid";
  }
  if (proposal.kind === "unresolved_next_step") {
    const candidates = new Set(proposal.candidateSkillIds);
    if (candidates.size !== proposal.candidateSkillIds.length) return "malformed_proposal";
    if (proposal.candidateSkillIds.some((skillId) =>
      !NAVIGATOR_SKILL_CATALOG.some((entry) => entry.id === skillId && entry.admitted))) return "capability_denied";
    return null;
  }
  if (proposal.kind === "start_release") {
    if (job.taskOutcome !== "shipped_change" && job.taskOutcome !== "reviewed_change") {
      return "release_outcome_not_permitted";
    }
    const ticketIds = proposal.implementationTicketIds;
    if (new Set(ticketIds).size !== ticketIds.length) return "malformed_proposal";
    const boundIds = new Set(job.artifactBindings.map((binding) => binding.artifactId));
    for (const artifactId of ticketIds) {
      if (!boundIds.has(artifactId)) return "unauthorized_subject";
      if (artifacts.getArtifact(artifactId)?.kind !== "implementation_ticket") return "unauthorized_subject";
    }
    return null;
  }
  if (proposal.kind === "finish") {
    const boundIds = new Set(job.artifactBindings.map((binding) => binding.artifactId));
    if (proposal.artifactIds.some((artifactId) => !boundIds.has(artifactId))) return "unauthorized_subject";
    if (job.taskOutcome === "artifact") {
      return proposal.artifactIds.every((artifactId) => artifacts.getResolution(artifactId)?.outcome === "resolved")
        ? null
        : "completion_evidence_missing";
    }
    if (job.taskOutcome === "reviewed_change") {
      return job.state === "complete" ? null : "completion_evidence_missing";
    }
    if (job.taskOutcome === "shipped_change") {
      return job.state === "complete" || job.state === "merged" ? null : "completion_evidence_missing";
    }
    return "completion_evidence_missing";
  }
  if (proposal.kind !== "invoke_skill") return "unsupported_deterministic_action";
  const catalog = NAVIGATOR_SKILL_CATALOG.find((entry) => entry.id === proposal.skillId);
  const contract = navigatorStepContract(proposal.skillId);
  if (
    proposal.skillId === "ask-matt" || contract === null ||
    catalog?.admitted !== true ||
    catalog.invocationClass !== contract.invocationClass ||
    catalog.denialReason !== null
  ) return "capability_denied";
  const subjects = new Set(proposal.subjectArtifactIds);
  if (
    subjects.size !== proposal.subjectArtifactIds.length ||
    subjects.size < contract.minimumSubjects
  ) return "malformed_proposal";
  const boundIds = new Set(job.artifactBindings.map((binding) => binding.artifactId));
  if (proposal.subjectArtifactIds.some((artifactId) => !boundIds.has(artifactId))) return "unauthorized_subject";
  if (
    proposal.skillId === "wayfinder" &&
    job.artifactBindings.some((binding) => {
      const kind = artifacts.getArtifact(binding.artifactId)?.kind;
      return kind === "map" || kind === "specification";
    })
  ) return "unnecessary_wayfinding";
  if (
    proposal.skillId === "to-spec" &&
    job.artifactBindings.some((binding) =>
      artifacts.getArtifact(binding.artifactId)?.kind === "specification" &&
      !revisableSpecificationIds.has(binding.artifactId))
  ) return "canonical_specification_exists";
  for (const artifactId of proposal.subjectArtifactIds) {
    const artifact = artifacts.getArtifact(artifactId);
    if (!artifact || !contract.allowedArtifactKinds.includes(artifact.kind)) {
      return "capability_denied";
    }
  }
  return null;
}

export class NavigatorRepository {
  private readonly artifacts: WorkArtifactRepository;
  private readonly capabilities: CapabilityRepository;
  private readonly taskAuthorities: TaskAuthorityRepository;
  private readonly releaseAuthorities: ReleaseAuthorityRepository;
  private readonly ownerBoundaries: OwnerBoundaryRepository;

  public constructor(private readonly db: SqliteDatabase) {
    this.artifacts = new WorkArtifactRepository(db);
    this.capabilities = new CapabilityRepository(db);
    this.taskAuthorities = new TaskAuthorityRepository(db);
    this.releaseAuthorities = new ReleaseAuthorityRepository(db);
    this.ownerBoundaries = new OwnerBoundaryRepository(db);
  }

  private createNavigatorCapabilityProfile(input: Readonly<{
    subjectId: string;
    route: ModelRoute;
    assignments: readonly NavigatorCapabilityAssignment[];
    now: number;
  }>): CapabilityProfile {
    return this.capabilities.createProfile({
      subjectKind: "worker_attempt",
      subjectId: input.subjectId,
      threadId: null,
      recipeId: "navigator-v1",
      recipeVersion: 1,
      registryDigest: CAPABILITY_REGISTRY_DIGEST,
      graphDigest: CAPABILITY_GRAPH_DIGEST,
      mode: "active",
      model: navigatorProfileModel(input.route),
      assignments: input.assignments.map((assignment) => ({
        ...assignment,
        mandatory: true,
      })),
      reasonCodes: ["navigator_effect_admission"],
      traits: [],
      now: input.now,
    });
  }

  public recordNavigatorCapabilityEvidence(input: Readonly<{
    effectIdempotencyKey: string;
    jobId: string;
    projectId: string;
    operation: NavigatorCapabilityOperation;
    profileId: string;
    profileRevision: number;
    assignments: readonly NavigatorCapabilityAssignment[];
    now: number;
  }>): void {
    const record = (): void => {
      const profile = this.capabilities.getProfileById(input.profileId);
      if (!profile || profile.subjectKind !== "worker_attempt" || profile.revision !== input.profileRevision) {
        throw new TypeError("navigator capability profile identity is unavailable");
      }
      const selectedReceipt = this.db.prepare(
        `SELECT id, capability_kind, descriptor_digest
           FROM capability_receipts
          WHERE profile_id = ? AND capability_id = ? AND event_type = 'selected'`,
      );
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO navigator_effect_capability_evidence (
           effect_idempotency_key, job_id, project_id, operation,
           profile_id, profile_revision, capability_id, capability_kind,
           descriptor_digest, receipt_id, owner_id, generation, admitted_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      );
      for (const assignment of input.assignments) {
        const receipt = selectedReceipt.get(input.profileId, assignment.capabilityId) as {
          id: string;
          capability_kind: string;
          descriptor_digest: string;
        } | undefined;
        if (!receipt || receipt.capability_kind !== assignment.capabilityKind ||
          receipt.descriptor_digest !== assignment.descriptorDigest) {
          throw new TypeError("navigator capability selection receipt is not exact");
        }
        insert.run(
          input.effectIdempotencyKey,
          input.jobId,
          input.projectId,
          input.operation,
          input.profileId,
          input.profileRevision,
          assignment.capabilityId,
          assignment.capabilityKind,
          assignment.descriptorDigest,
          receipt.id,
          input.now,
        );
      }
      const rows = this.db.prepare(
        `SELECT capability_id, capability_kind, descriptor_digest, profile_id, profile_revision,
                project_id, job_id, operation
           FROM navigator_effect_capability_evidence
          WHERE effect_idempotency_key = ? AND operation = ?`,
      ).all(input.effectIdempotencyKey, input.operation) as Array<{
        capability_id: string;
        capability_kind: string;
        descriptor_digest: string;
        profile_id: string;
        profile_revision: number;
        project_id: string;
        job_id: string;
        operation: string;
      }>;
      if (rows.length !== input.assignments.length || rows.some((row) =>
        row.job_id !== input.jobId || row.project_id !== input.projectId || row.profile_id !== input.profileId ||
        row.profile_revision !== input.profileRevision || !input.assignments.some((assignment) =>
          assignment.capabilityId === row.capability_id && assignment.capabilityKind === row.capability_kind &&
          assignment.descriptorDigest === row.descriptor_digest))) {
        throw new TypeError("navigator capability evidence identity changed during replay");
      }
    };
    if (this.db.inTransaction) record();
    else this.db.transaction(record).immediate();
  }

  public getNavigatorCapabilityEvidence(effectIdempotencyKey: string): readonly NavigatorCapabilityEvidence[] {
    assertIdentifier(effectIdempotencyKey, "effectIdempotencyKey");
    const rows = this.db.prepare(
      `SELECT effect_idempotency_key, job_id, project_id, operation, profile_id,
              profile_revision, capability_id, capability_kind, descriptor_digest,
              receipt_id, owner_id, generation
         FROM navigator_effect_capability_evidence
        WHERE effect_idempotency_key = ?
        ORDER BY operation, capability_id`,
    ).all(effectIdempotencyKey) as NavigatorCapabilityEvidenceRow[];
    return rows.map((row) => ({
      profileId: row.profile_id,
      profileRevision: row.profile_revision,
      receiptId: row.receipt_id,
      capabilityId: row.capability_id,
      capabilityKind: row.capability_kind,
      descriptorDigest: row.descriptor_digest,
      operation: row.operation,
      projectId: row.project_id,
      jobId: row.job_id,
      ownerId: row.owner_id,
      generation: row.generation,
    }));
  }

  public admitNavigatorCapabilityEvidence(input: Readonly<{
    effectIdempotencyKey: string;
    jobId: string;
    projectId: string;
    ownerId: string;
    generation: number;
    now: number;
  }>): boolean {
    const rows = this.getNavigatorCapabilityEvidence(input.effectIdempotencyKey);
    const effect = this.db.prepare(
      `SELECT kind, payload_json, status, lease_owner, lease_generation, lease_expires_at
         FROM effects WHERE idempotency_key = ? AND job_id = ?`,
    ).get(input.effectIdempotencyKey, input.jobId) as {
      kind: string;
      payload_json: string;
      status: string;
      lease_owner: string | null;
      lease_generation: number | null;
      lease_expires_at: number | null;
    } | undefined;
    if (!effect || effect.status !== "leased" || effect.lease_owner !== input.ownerId ||
      effect.lease_generation !== input.generation || effect.lease_expires_at === null ||
      effect.lease_expires_at <= input.now || rows.length === 0 || rows.some((row) =>
        row.jobId !== input.jobId || row.projectId !== input.projectId)) return false;

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(effect.payload_json);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      payload = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    const attemptId = typeof payload.attemptId === "string" ? payload.attemptId : null;
    if (attemptId === null) return false;
    const profileIdentity = effect.kind === "run_navigator_skill"
      ? this.db.prepare(
        `SELECT skill_id AS capability_id, descriptor_digest, capability_profile_id, capability_profile_revision
           FROM navigator_skill_attempts WHERE id = ? AND effect_idempotency_key = ?`,
      ).get(attemptId, input.effectIdempotencyKey) as {
        capability_id: string;
        descriptor_digest: string;
        capability_profile_id: string | null;
        capability_profile_revision: number | null;
      } | undefined
      : effect.kind === "run_navigator_release"
        ? this.db.prepare(
          `SELECT ? AS capability_id, ? AS descriptor_digest, capability_profile_id, capability_profile_revision
             FROM navigator_release_attempts WHERE id = ? AND effect_idempotency_key = ?`,
        ).get(NAVIGATOR_RELEASE_CAPABILITY_ID, NAVIGATOR_RELEASE_DESCRIPTOR_DIGEST, attemptId, input.effectIdempotencyKey) as {
          capability_id: string;
          descriptor_digest: string;
          capability_profile_id: string | null;
          capability_profile_revision: number | null;
        } | undefined
        : this.db.prepare(
          `SELECT capability_profile_id, capability_profile_revision
             FROM navigator_ticket_worker_attempts WHERE id = ? AND effect_idempotency_key = ?`,
        ).get(attemptId, input.effectIdempotencyKey) as {
          capability_profile_id: string | null;
          capability_profile_revision: number | null;
        } | undefined;
    if (!profileIdentity || profileIdentity.capability_profile_id === null ||
      profileIdentity.capability_profile_revision === null) return false;
    const profile = this.capabilities.getProfileById(profileIdentity.capability_profile_id);
    if (!profile || profile.subjectKind !== "worker_attempt" || profile.subjectId !== attemptId ||
      profile.revision !== profileIdentity.capability_profile_revision || profile.mode !== "active" ||
      profile.recipeId !== "navigator-v1" || profile.registryDigest !== CAPABILITY_REGISTRY_DIGEST ||
      profile.graphDigest !== CAPABILITY_GRAPH_DIGEST) return false;
    const assignments = new Map(profile.assignments.map((assignment) => [assignment.capabilityId, assignment]));
    const expectedRows = effect.kind === "run_navigator_ticket_worker"
      ? profile.assignments.length
      : 1;
    if (rows.length !== expectedRows || new Set(rows.map((row) => row.capabilityId)).size !== rows.length) return false;
    const receipts = this.capabilities.listReceipts(profile.id, 512);
    const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
    for (const row of rows) {
      const assignment = assignments.get(row.capabilityId);
      const receipt = receiptById.get(row.receiptId);
      if (!assignment || !receipt || receipt.eventType !== "selected" || receipt.profileRevision !== profile.revision ||
        receipt.profileId !== profile.id || receipt.capabilityId !== row.capabilityId ||
        receipt.capabilityKind !== row.capabilityKind || receipt.descriptorDigest !== row.descriptorDigest ||
        assignment.capabilityKind !== row.capabilityKind || assignment.descriptorDigest !== row.descriptorDigest ||
        receipts.some((candidate) => candidate.profileId === profile.id && candidate.capabilityId === row.capabilityId &&
          candidate.eventType === "denied")) return false;
    }
    if (effect.kind === "run_navigator_skill") {
      const skill = profileIdentity as {
        capability_id: string;
        descriptor_digest: string;
        capability_profile_id: string | null;
        capability_profile_revision: number | null;
      };
      const row = rows[0];
      if (row?.operation !== (skill.capability_id === "prototype" ? "prototype_write" : "artifact_write") ||
        row.capabilityId !== skill.capability_id || row.descriptorDigest !== skill.descriptor_digest) return false;
    } else if (effect.kind === "run_navigator_release") {
      const row = rows[0];
      if (row?.operation !== "release_entry" || row.capabilityId !== NAVIGATOR_RELEASE_CAPABILITY_ID ||
        row.descriptorDigest !== NAVIGATOR_RELEASE_DESCRIPTOR_DIGEST) return false;
    } else if (rows.some((row) => row.operation !== "worktree_write")) {
      return false;
    }
    const update = this.db.prepare(
      `UPDATE navigator_effect_capability_evidence
          SET owner_id = ?, generation = ?, admitted_at = ?
        WHERE effect_idempotency_key = ?`,
    ).run(input.ownerId, input.generation, input.now, input.effectIdempotencyKey);
    if (update.changes !== 0 && update.changes !== rows.length) return false;
    return this.db.prepare(
      `SELECT 1 FROM navigator_effect_capability_evidence
        WHERE effect_idempotency_key = ? AND owner_id = ? AND generation = ?`,
    ).get(input.effectIdempotencyKey, input.ownerId, input.generation) !== undefined;
  }

  private updateTaskAuthorityGraph(jobId: string, bindings: readonly NavigatorArtifactBinding[], now: number): void {
    const before = this.taskAuthorities.get(jobId);
    const after = this.taskAuthorities.updateArtifactGraph(jobId, taskArtifactGraphDigest(bindings), now);
    if (before && after && after.revision !== before.revision) {
      this.releaseAuthorities.revokeForJob(jobId, "artifact_graph_advanced", now);
      this.ownerBoundaries.revokeForJob(jobId, "artifact_graph_advanced", now);
    }
  }

  public bindJobArtifacts(input: Readonly<{
    jobId: string;
    expectedVersion: number;
    artifactBindings: readonly NavigatorArtifactBinding[];
    now: number;
  }>): Job {
    assertIdentifier(input.jobId, "jobId");
    assertPositiveInteger(input.expectedVersion, "expectedVersion");
    assertNonNegativeInteger(input.now, "now");
    const bindings = artifactBindingSchema.array().min(1).max(128).parse(input.artifactBindings);
    if (new Set(bindings.map((binding) => binding.artifactId)).size !== bindings.length) {
      throw new TypeError("navigator artifact bindings contain a duplicate artifact");
    }
    return this.db.transaction((): Job => {
      const job = readJobById(this.db, input.jobId);
      if (!job) throw new Error(`Job ${input.jobId} was not found`);
      if (job.version !== input.expectedVersion) throw new VersionConflictError(job.id, input.expectedVersion);
      if (
        job.workflowEngine !== "navigator-v1" ||
        (job.workflowMode !== "shadow" && job.workflowMode !== "deterministic") ||
        job.currentWorkflowStepId !== null || job.artifactBindings.length > 0
      ) {
        throw new TypeError("navigator job artifact bindings are already initialized or unavailable");
      }
      if (job.state !== "awaiting_confirmation" || job.projectId === null) {
        throw new TypeError("navigator jobs must be initialized after project selection and before admission");
      }
      for (const binding of bindings) {
        const artifact = this.artifacts.getArtifact(binding.artifactId);
        const snapshot = this.artifacts.getSnapshot(binding.snapshotId);
        if (
          !artifact || artifact.projectId !== job.projectId || snapshot?.artifactId !== artifact.id ||
          snapshot.snapshotDigest !== binding.snapshotDigest ||
          artifact.currentSnapshotId !== snapshot.id || !this.artifacts.isSnapshotValid(snapshot.id)
        ) throw new TypeError("navigator artifact binding is not current for the selected project");
      }
      const updated = this.db.prepare(
        `UPDATE jobs
            SET artifact_bindings_json = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND workflow_engine = 'navigator-v1'
            AND workflow_mode IN ('shadow', 'deterministic') AND artifact_bindings_json = '[]'`,
      ).run(JSON.stringify(bindings), input.now, input.jobId, input.expectedVersion);
      if (updated.changes !== 1) throw new VersionConflictError(input.jobId, input.expectedVersion);
      const stored = readJobById(this.db, input.jobId);
      if (!stored) throw new Error("navigator job disappeared after initialization");
      this.updateTaskAuthorityGraph(stored.id, bindings, input.now);
      return stored;
    }).immediate();
  }

  public createSnapshot(input: Readonly<{
    jobId: string;
    externalStateDigest: string;
    evidenceRefs: readonly string[];
    now: number;
  }>): NavigatorSnapshot {
    assertIdentifier(input.jobId, "jobId");
    assertNonNegativeInteger(input.now, "now");
    if (!/^[0-9a-f]{64}$/u.test(input.externalStateDigest)) {
      throw new TypeError("externalStateDigest must be a SHA-256 digest");
    }
    return this.db.transaction((): NavigatorSnapshot => {
      let job = readJobById(this.db, input.jobId);
      if (!job) throw new Error(`Job ${input.jobId} was not found`);
      const recipeShadow = job.workflowEngine === "recipe-v1";
      if (
        !recipeShadow &&
        (job.workflowEngine !== "navigator-v1" || (job.workflowMode !== "shadow" && job.workflowMode !== "deterministic"))
      ) {
        throw new TypeError("job is not an executable navigator-v1 job");
      }
      if (job.currentWorkflowStepId !== null) throw new TypeError("job already has an active workflow step");
      if (!recipeShadow) {
        const refreshedBindings: NavigatorArtifactBinding[] = [];
        for (const binding of job.artifactBindings) {
          const snapshot = this.artifacts.getCurrentSnapshot(binding.artifactId);
          const artifact = this.artifacts.getArtifact(binding.artifactId);
          if (snapshot && (this.artifacts.isSnapshotValid(snapshot.id) || artifact?.kind === "specification")) {
            refreshedBindings.push({
              artifactId: binding.artifactId,
              snapshotId: snapshot.id,
              snapshotDigest: snapshot.snapshotDigest,
            });
          }
        }
        if (JSON.stringify(refreshedBindings) !== JSON.stringify(job.artifactBindings)) {
          const refreshed = this.db.prepare(
            `UPDATE jobs SET artifact_bindings_json = ?, workflow_revision = workflow_revision + 1,
                 version = version + 1, updated_at = ?
              WHERE id = ? AND version = ? AND current_workflow_step_id IS NULL`,
          ).run(JSON.stringify(refreshedBindings), input.now, job.id, job.version);
          if (refreshed.changes !== 1) throw new VersionConflictError(job.id, job.version);
          job = readJobById(this.db, input.jobId);
          if (!job) throw new Error("navigator job disappeared during artifact reconsideration");
          this.updateTaskAuthorityGraph(job.id, refreshedBindings, input.now);
        }
        if (job.workflowMode !== "shadow" && job.workflowMode !== "deterministic") {
          throw new TypeError("navigator workflow mode changed during artifact reconsideration");
        }
      }
      const snapshotMode: "shadow" | "deterministic" = recipeShadow
        ? "shadow"
        : job.workflowMode === "deterministic" ? "deterministic" : "shadow";
      const payload = {
        engine: "navigator-v1" as const,
        engineRevision: NAVIGATOR_ENGINE_REVISION as 1,
        mode: snapshotMode,
        ownerRequest: job.requestText,
        artifactBindings: [...job.artifactBindings],
        skillCatalog: [...NAVIGATOR_SKILL_CATALOG],
        catalogDigest: NAVIGATOR_SKILL_CATALOG_DIGEST,
        externalStateDigest: input.externalStateDigest,
        evidenceRefs: [...input.evidenceRefs],
        createdAt: input.now,
      };
      const digest = navigatorSnapshotDigest({
        jobId: job.id,
        jobVersion: job.version,
        workflowRevision: job.workflowRevision,
        payload,
      });
      const id = digestId("navsnap", job.id, digest);
      const payloadJson = serializeNavigatorJson(payload, "navigator snapshot");
      this.db.prepare(
        `INSERT OR IGNORE INTO navigator_snapshots (
           id, job_id, job_version, workflow_revision, digest, external_state_digest, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        job.id,
        job.version,
        job.workflowRevision,
        digest,
        input.externalStateDigest,
        payloadJson,
        input.now,
      );
      const row = this.db.prepare("SELECT * FROM navigator_snapshots WHERE id = ?").get(id) as SnapshotRow | undefined;
      if (!row) throw new Error("navigator snapshot was not stored");
      return parseSnapshot(row);
    }).immediate();
  }

  public recordProposal(input: Readonly<{
    snapshotId: string;
    rawProposal: unknown;
    observation: NavigatorInferenceObservation;
    selectModelRoute(): ModelRoute;
    now: number;
  }>): NavigatorProposalDecision {
    assertIdentifier(input.snapshotId, "snapshotId");
    assertNonNegativeInteger(input.now, "now");
    const observation = navigatorInferenceObservationSchema.parse(input.observation);
    const rawJson = boundedRawJson(input.rawProposal);
    const parsed = navigatorProposalSchema.safeParse(input.rawProposal);
    const parsedProposalJson = parsed.success ? JSON.stringify(parsed.data) : null;
    const proposalTooLarge = parsedProposalJson !== null &&
      Buffer.byteLength(parsedProposalJson, "utf8") > MAX_NAVIGATOR_JSON_BYTES;
    const proposal: NavigatorProposal | null = parsed.success && !proposalTooLarge ? parsed.data : null;
    const proposalValidationFailure = !parsed.success
      ? "malformed_proposal"
      : proposalTooLarge ? "oversized_proposal" : null;
    const digest = proposalDigest(parsed.success ? parsed.data : input.rawProposal);
    const observationJson = serializeNavigatorJson(observation, "navigator inference observation");
    const observationDigest = createHash("sha256").update(observationJson, "utf8").digest("hex");
    return this.db.transaction((): NavigatorProposalDecision => {
      const snapshotRow = this.db.prepare("SELECT * FROM navigator_snapshots WHERE id = ?")
        .get(input.snapshotId) as SnapshotRow | undefined;
      if (!snapshotRow) throw new Error(`Navigator snapshot ${input.snapshotId} was not found`);
      const snapshot = parseSnapshot(snapshotRow);
      const job = readJobById(this.db, snapshot.identity.jobId);
      if (!job) throw new Error(`Job ${snapshot.identity.jobId} was not found`);
      const proposalId = digestId("navprop", input.snapshotId, digest);
      const proposalJson = proposal === null ? null : parsedProposalJson;
      this.db.prepare(
        `INSERT OR IGNORE INTO navigator_proposals (
           id, job_id, snapshot_id, digest, kind, raw_json, proposal_json,
           observation_json, observation_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        proposalId,
        job.id,
        input.snapshotId,
        digest,
        proposal?.kind ?? null,
        rawJson,
        proposalJson,
        observationJson,
        observationDigest,
        input.now,
      );
      const storedProposal = this.getProposal(proposalId);
      if (storedProposal?.observationDigest !== observationDigest) {
        throw new Error("navigator proposal observation changed for the same accepted content");
      }
      const existingDecision = this.decisionForProposal(proposalId);
      if (existingDecision) return existingDecision;
      const rejection = proposalValidationFailure ?? (
        proposal === null ? "malformed_proposal" : proposalReason(job, snapshot, proposal, observation, this.artifacts)
      );
      if (rejection !== null) {
        this.insertDecision(proposalId, job.id, input.snapshotId, "rejected", rejection, input.now);
        return this.requireDecision(proposalId);
      }
      if (job.workflowEngine === "recipe-v1") {
        this.insertDecision(proposalId, job.id, input.snapshotId, "shadowed", "recipe_job_shadow", input.now);
        return this.requireDecision(proposalId);
      }
      if (job.workflowMode === "shadow") {
        this.insertDecision(proposalId, job.id, input.snapshotId, "shadowed", "shadow_only", input.now);
        return this.requireDecision(proposalId);
      }
      if (proposal === null) throw new Error("accepted navigator proposal disappeared after validation");
      if (proposal.kind === "owner_boundary") {
        const authority = this.taskAuthorities.get(job.id);
        const draft = ownerBoundaryDraftFromProposal(proposal);
        if (!authority || (
          authority.status !== "active" &&
          !(proposal.boundaryCode === "production_recovery_required" && authority.status === "suspended")
        ) || authority.jobId !== job.id) {
          this.insertDecision(proposalId, job.id, input.snapshotId, "rejected", "owner_boundary_requires_live_task_authority", input.now);
          return this.requireDecision(proposalId);
        }
        if (draft === null) {
          this.insertDecision(proposalId, job.id, input.snapshotId, "rejected", "owner_boundary_evidence_missing", input.now);
          return this.requireDecision(proposalId);
        }
        let boundary: ReturnType<OwnerBoundaryRepository["record"]>;
        try {
          boundary = this.ownerBoundaries.record({
            ...draft,
            jobId: job.id,
            authorityId: authority.authorityId,
            authorityRevision: authority.revision,
            ownerUserId: authority.ownerUserId,
            ownerChatId: authority.ownerChatId,
            now: input.now,
          });
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          boundary = null;
        }
        if (boundary === null) {
          this.insertDecision(proposalId, job.id, input.snapshotId, "rejected", "owner_boundary_evidence_invalid", input.now);
          return this.requireDecision(proposalId);
        }
        this.insertDecision(proposalId, job.id, input.snapshotId, "accepted", "owner_boundary_recorded", input.now);
        return this.requireDecision(proposalId);
      }
      if (proposal.kind === "finish") {
        this.insertDecision(proposalId, job.id, input.snapshotId, "accepted", "completion_recorded", input.now);
        return this.requireDecision(proposalId);
      }
      if (proposal.kind === "start_release") {
        if (this.releasePrerequisitesIncomplete(job, proposal.implementationTicketIds)) {
          this.insertDecision(
            proposalId,
            job.id,
            input.snapshotId,
            "rejected",
            "release_prerequisites_incomplete",
            input.now,
          );
          return this.requireDecision(proposalId);
        }
        const stepId = digestId("wfstep", proposalId, digest);
        const attemptId = digestId("navrelease", stepId, NAVIGATOR_RELEASE_STEP_SKILL_ID);
        const effectKey = `${job.id}:navigator:${stepId}:run_release`;
        const capabilityProfile = this.createNavigatorCapabilityProfile({
          subjectId: attemptId,
          route: { pool: "standard", ...DEFAULT_MODEL_POOL_REGISTRY.worker.standard },
          assignments: [{
            capabilityId: NAVIGATOR_RELEASE_CAPABILITY_ID,
            capabilityKind: "native-adapter",
            descriptorDigest: NAVIGATOR_RELEASE_DESCRIPTOR_DIGEST,
          }],
          now: input.now,
        });
        this.db.prepare(
          `INSERT INTO workflow_steps (
             id, job_id, proposal_id, snapshot_id, skill_id, job_version, workflow_revision, accepted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          stepId,
          job.id,
          proposalId,
          input.snapshotId,
          NAVIGATOR_RELEASE_STEP_SKILL_ID,
          job.version,
          job.workflowRevision,
          input.now,
        );
        this.db.prepare(
          `INSERT INTO effects (
             idempotency_key, job_id, kind, payload_json, status, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, 'run_navigator_release', ?, 'pending', 0, ?, ?, ?)`,
        ).run(
          effectKey,
          job.id,
          serializeNavigatorJson({
            workflowStepId: stepId,
            attemptId,
            snapshotId: input.snapshotId,
          }, "navigator release effect"),
          input.now,
          input.now,
          input.now,
        );
        this.db.prepare(
          `INSERT INTO navigator_release_attempts (
             id, job_id, workflow_step_id, effect_idempotency_key, implementation_ticket_ids_json,
             snapshot_digest, job_version, workflow_revision, capability_profile_id,
             capability_profile_revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          attemptId,
          job.id,
          stepId,
          effectKey,
          JSON.stringify(proposal.implementationTicketIds),
          snapshot.identity.digest,
          job.version,
          job.workflowRevision,
          capabilityProfile.id,
          capabilityProfile.revision,
          input.now,
          input.now,
        );
        this.recordNavigatorCapabilityEvidence({
          effectIdempotencyKey: effectKey,
          jobId: job.id,
          projectId: job.projectId!,
          operation: "release_entry",
          profileId: capabilityProfile.id,
          profileRevision: capabilityProfile.revision,
          assignments: [{
            capabilityId: NAVIGATOR_RELEASE_CAPABILITY_ID,
            capabilityKind: "native-adapter",
            descriptorDigest: NAVIGATOR_RELEASE_DESCRIPTOR_DIGEST,
          }],
          now: input.now,
        });
        const updated = this.db.prepare(
          `UPDATE jobs SET current_workflow_step_id = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND version = ? AND current_workflow_step_id IS NULL`,
        ).run(stepId, input.now, job.id, job.version);
        if (updated.changes !== 1) throw new VersionConflictError(job.id, job.version);
        this.insertDecision(proposalId, job.id, input.snapshotId, "accepted", "accepted", input.now);
        return this.requireDecision(proposalId);
      }
      if (proposal.kind !== "invoke_skill" && proposal.kind !== "unresolved_next_step") {
        throw new Error("deterministic proposal validation was inconsistent");
      }
      const routingIdentity = proposal.kind === "unresolved_next_step"
        ? routingDecisionIdentity(job, snapshot, proposal)
        : null;
      const unresolvedDigest = routingIdentity?.decisionDigest ?? null;
      if (routingIdentity !== null) {
        const existingRouting = this.getRoutingDecisionByScope(routingIdentity.scopeDigest);
        if (existingRouting) {
          this.db.prepare(
            `INSERT OR IGNORE INTO navigator_routing_blocks (
               decision_digest, proposal_id, reason, recorded_at
             ) VALUES (?, ?, 'unchanged_routing_unresolved_after_consultation', ?)`,
          ).run(existingRouting.decisionDigest, proposalId, input.now);
          this.db.prepare(
            `UPDATE jobs SET state = 'blocked', last_error = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND version = ? AND current_workflow_step_id IS NULL`,
          ).run(
            "Navigator routing remained unresolved after one ask-matt consultation",
            input.now,
            job.id,
            job.version,
          );
          this.insertDecision(
            proposalId,
            job.id,
            input.snapshotId,
            "accepted",
            "routing_blocked_after_consultation",
            input.now,
          );
          return this.requireDecision(proposalId);
        }
      }
      const skillId = proposal.kind === "invoke_skill" ? proposal.skillId : "ask-matt";
      const objective = proposal.kind === "invoke_skill" ? proposal.objective : proposal.question;
      const evidenceRefs = proposal.evidenceRefs;
      const subjectArtifactIds = proposal.kind === "invoke_skill"
        ? new Set(proposal.subjectArtifactIds)
        : new Set(job.artifactBindings.map((binding) => binding.artifactId));
      const catalogEntry = NAVIGATOR_SKILL_CATALOG.find((entry) => entry.id === skillId);
      if (!catalogEntry) throw new Error("accepted skill disappeared from the navigator catalog");
      const contract = navigatorStepContract(skillId);
      if (!contract) throw new Error("accepted skill contract disappeared");
      const route = assertModelRouteForContract(input.selectModelRoute(), contract);
      const subjectArtifactBindings = job.artifactBindings.filter((binding) => subjectArtifactIds.has(binding.artifactId));
      const stepInput = skillId === "research"
        ? navigatorResearchInputSchema.parse({
          kind: "navigator_research_input",
          objective,
          artifactBindings: subjectArtifactBindings,
          evidenceRefs,
        })
        : navigatorPlanningInput({
          skillId,
          objective,
          artifactBindings: subjectArtifactBindings,
          evidenceRefs,
          routingDecisionDigest: unresolvedDigest,
        });
      const stepInputJson = serializeNavigatorJson(stepInput, "navigator skill step input");
      const stepInputDigest = createHash("sha256").update(stepInputJson, "utf8").digest("hex");
      const stepId = digestId("wfstep", proposalId, digest);
      const attemptId = digestId("navattempt", stepId, skillId);
      const effectKey = `${job.id}:navigator:${stepId}:run_skill`;
      const capabilityProfile = this.createNavigatorCapabilityProfile({
        subjectId: attemptId,
        route,
        assignments: [{
          capabilityId: skillId,
          capabilityKind: "skill",
          descriptorDigest: catalogEntry.descriptorDigest,
        }],
        now: input.now,
      });
      const contractJson = serializeNavigatorJson(contract, "navigator step contract");
      this.db.prepare(
        `INSERT OR IGNORE INTO workflow_step_contracts (
           id, revision, skill_id, digest, contract_json, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        contract.id,
        contract.revision,
        contract.skillId,
        contract.digest,
        contractJson,
        input.now,
      );
      const storedContract = this.db.prepare(
        `SELECT skill_id, digest, contract_json
           FROM workflow_step_contracts
          WHERE id = ? AND revision = ?`,
      ).get(
        contract.id,
        contract.revision,
      ) as { skill_id: string; digest: string; contract_json: string } | undefined;
      if (
        storedContract?.skill_id !== contract.skillId ||
        storedContract.digest !== contract.digest ||
        storedContract.contract_json !== contractJson
      ) {
        throw new Error("navigator step contract revision drifted");
      }
      this.db.prepare(
        `INSERT INTO workflow_steps (
           id, job_id, proposal_id, snapshot_id, skill_id, job_version, workflow_revision, accepted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        stepId,
        job.id,
        proposalId,
        input.snapshotId,
        skillId,
        job.version,
        job.workflowRevision,
        input.now,
      );
      if (proposal.kind === "unresolved_next_step") {
        this.db.prepare(
          `INSERT INTO navigator_routing_decisions (
             decision_digest, scope_digest, job_id, question, candidate_skill_ids_json,
             rationale, evidence_refs_json, consultation_step_id, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          unresolvedDigest,
          routingIdentity!.scopeDigest,
          job.id,
          proposal.question,
          JSON.stringify(proposal.candidateSkillIds),
          proposal.rationale,
          JSON.stringify(proposal.evidenceRefs),
          stepId,
          input.now,
        );
      }
      const effectPayload = {
        workflowStepId: stepId,
        attemptId,
        snapshotId: input.snapshotId,
      };
      this.db.prepare(
        `INSERT INTO effects (
           idempotency_key, job_id, kind, payload_json, status, attempts,
           next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, 'run_navigator_skill', ?, 'pending', 0, ?, ?, ?)`,
      ).run(
        effectKey,
        job.id,
        serializeNavigatorJson(effectPayload, "navigator skill effect"),
        input.now,
        input.now,
        input.now,
      );
      this.db.prepare(
        `INSERT INTO navigator_skill_attempts (
           id, job_id, workflow_step_id, effect_idempotency_key, skill_id, skill_revision,
           skill_source_digest, descriptor_digest, step_contract_id, step_contract_revision,
           step_contract_digest, catalog_digest, step_input_json, step_input_digest,
           model_route_json, artifact_bindings_json, snapshot_digest, job_version,
           workflow_revision, capability_profile_id, capability_profile_revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        attemptId,
        job.id,
        stepId,
        effectKey,
        skillId,
        MATT_POCOCK_SKILL_REVISION,
        catalogEntry.sourceDigest,
        catalogEntry.descriptorDigest,
        contract.id,
        contract.revision,
        contract.digest,
        NAVIGATOR_SKILL_CATALOG_DIGEST,
        stepInputJson,
        stepInputDigest,
        JSON.stringify(route),
        JSON.stringify(subjectArtifactBindings),
        snapshot.identity.digest,
        job.version,
        job.workflowRevision,
        capabilityProfile.id,
        capabilityProfile.revision,
        input.now,
        input.now,
      );
      this.recordNavigatorCapabilityEvidence({
        effectIdempotencyKey: effectKey,
        jobId: job.id,
        projectId: job.projectId!,
        operation: skillId === "prototype" ? "prototype_write" : "artifact_write",
        profileId: capabilityProfile.id,
        profileRevision: capabilityProfile.revision,
        assignments: [{
          capabilityId: skillId,
          capabilityKind: "skill",
          descriptorDigest: catalogEntry.descriptorDigest,
        }],
        now: input.now,
      });
      const updated = this.db.prepare(
        `UPDATE jobs SET current_workflow_step_id = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND current_workflow_step_id IS NULL`,
      ).run(stepId, input.now, job.id, job.version);
      if (updated.changes !== 1) throw new VersionConflictError(job.id, job.version);
      this.insertDecision(
        proposalId,
        job.id,
        input.snapshotId,
        "accepted",
        proposal.kind === "unresolved_next_step" ? "ask_matt_scheduled" : "accepted",
        input.now,
      );
      return this.requireDecision(proposalId);
    }).immediate();
  }

  public getProposal(id: string): NavigatorProposalRecord | null {
    const row = this.db.prepare("SELECT * FROM navigator_proposals WHERE id = ?").get(id) as ProposalRow | undefined;
    return row ? parseProposal(row) : null;
  }

  public getProposalDecision(id: string): NavigatorProposalDecision | null {
    assertIdentifier(id, "proposalId");
    return this.decisionForProposal(id);
  }

  public getWorkflowStep(id: string): NavigatorWorkflowStep | null {
    const row = this.db.prepare("SELECT * FROM workflow_steps WHERE id = ?").get(id) as {
      id: string;
      job_id: string;
      proposal_id: string;
      snapshot_id: string;
      skill_id: string;
      job_version: number;
      workflow_revision: number;
      accepted_at: number;
    } | undefined;
    return row ? {
      id: row.id,
      jobId: row.job_id,
      proposalId: row.proposal_id,
      snapshotId: row.snapshot_id,
      skillId: row.skill_id,
      jobVersion: row.job_version,
      workflowRevision: row.workflow_revision,
      acceptedAt: row.accepted_at,
    } : null;
  }

  public getAttempt(id: string): NavigatorSkillAttempt | null {
    const row = this.db.prepare("SELECT * FROM navigator_skill_attempts WHERE id = ?").get(id) as AttemptRow | undefined;
    return row ? parseAttempt(row) : null;
  }

  public getNavigatorTicketAttemptContext(input: Readonly<{
    attemptId: string;
    effectIdempotencyKey: string;
    ownerId: string;
    generation: number;
    now: number;
  }>): NavigatorTicketAttemptContext | null {
    assertIdentifier(input.attemptId, "attemptId");
    assertIdentifier(input.effectIdempotencyKey, "effectIdempotencyKey");
    assertIdentifier(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    const row = this.db.prepare(
      "SELECT * FROM navigator_ticket_worker_attempts WHERE id = ? AND effect_idempotency_key = ?",
    ).get(input.attemptId, input.effectIdempotencyKey) as TicketAttemptRow | undefined;
    if (!row) return null;
    const attempt = parseTicketAttempt(row);
    const integration = this.db.prepare(
      `SELECT job_id, worktree_id, integration_branch, current_head_sha, state, active_slice_id
         FROM navigator_integrations WHERE job_id = ?`,
    ).get(row.job_id) as {
      job_id: string;
      worktree_id: string;
      integration_branch: string;
      current_head_sha: string;
      state: string;
      active_slice_id: string | null;
    } | undefined;
    const slice = this.db.prepare(
      `SELECT id, job_id, ticket_artifact_id, claim_id, state, accepted_head_sha,
              ticket_snapshot_id, ticket_snapshot_digest
         FROM navigator_ticket_slices WHERE id = ?`,
    ).get(row.slice_id) as {
      id: string;
      job_id: string;
      ticket_artifact_id: string;
      claim_id: number;
      state: string;
      accepted_head_sha: string | null;
      ticket_snapshot_id: string;
      ticket_snapshot_digest: string;
    } | undefined;
    if (!integration || !slice || integration.job_id !== row.job_id || slice.job_id !== row.job_id ||
      integration.state !== "implementing" || integration.active_slice_id !== slice.id ||
      !["implementation_pending", "implementation_running", "review_pending", "review_running", "repair_pending"]
        .includes(slice.state)) return null;
    const ticket = this.db.prepare(
      `SELECT artifact_id, snapshot_id, snapshot_digest
         FROM navigator_integration_tickets WHERE job_id = ? AND artifact_id = ?`,
    ).get(row.job_id, slice.ticket_artifact_id) as {
      artifact_id: string;
      snapshot_id: string;
      snapshot_digest: string;
    } | undefined;
    if (!ticket || ticket.snapshot_id !== slice.ticket_snapshot_id || ticket.snapshot_digest !== slice.ticket_snapshot_digest ||
      attempt.workOrder.jobId !== row.job_id || attempt.workOrder.ticket.artifactId !== ticket.artifact_id ||
      attempt.workOrder.ticket.snapshotId !== ticket.snapshot_id || attempt.workOrder.ticket.snapshotDigest !== ticket.snapshot_digest ||
      attempt.workOrder.worktreeId !== integration.worktree_id || attempt.workOrder.integrationBranch !== integration.integration_branch) return null;
    const claim = this.artifacts.getClaim(slice.claim_id);
    const ticketSnapshot = this.artifacts.getSnapshot(ticket.snapshot_id);
    const specificationSnapshot = this.artifacts.getSnapshot(attempt.workOrder.specification.snapshotId);
    if (!claim || claim.state !== "held" || claim.jobId !== row.job_id || claim.artifactId !== ticket.artifact_id ||
      claim.snapshotId !== ticket.snapshot_id || claim.ownerId !== input.ownerId || claim.generation !== input.generation ||
      claim.leaseExpiresAt <= input.now || ticketSnapshot === null || specificationSnapshot === null ||
      !this.artifacts.isSnapshotValid(ticketSnapshot.id) || !this.artifacts.isSnapshotValid(specificationSnapshot.id) ||
      ticketSnapshot.snapshotDigest !== ticket.snapshot_digest ||
      specificationSnapshot.artifactId !== attempt.workOrder.specification.artifactId ||
      specificationSnapshot.snapshotDigest !== attempt.workOrder.specification.snapshotDigest ||
      this.artifacts.getArtifact(ticket.artifact_id)?.projectId !==
        this.artifacts.getArtifact(attempt.workOrder.specification.artifactId)?.projectId) return null;
    return {
      attempt,
      integration: {
        jobId: integration.job_id,
        worktreeId: integration.worktree_id,
        integrationBranch: integration.integration_branch,
        currentHeadSha: integration.current_head_sha,
        state: integration.state,
        activeSliceId: integration.active_slice_id,
      },
      activeSlice: {
        id: slice.id,
        ticketArtifactId: slice.ticket_artifact_id,
        claimId: slice.claim_id,
        state: slice.state,
        acceptedHeadSha: slice.accepted_head_sha,
      },
      claim,
      specificationSnapshot,
      ticketSnapshot,
    };
  }

  public getOutcome(workflowStepId: string): NavigatorWorkflowStepOutcome | null {
    const row = this.db.prepare("SELECT * FROM workflow_step_outcomes WHERE workflow_step_id = ?")
      .get(workflowStepId) as {
        workflow_step_id: string;
        attempt_id: string;
        outcome: NavigatorWorkflowStepOutcome["outcome"];
        reason_code: string;
        summary: string;
        artifact_evidence_json: string;
        result_digest: string;
        recorded_at: number;
      } | undefined;
    return row ? {
      workflowStepId: row.workflow_step_id,
      attemptId: row.attempt_id,
      outcome: row.outcome,
      reasonCode: row.reason_code,
      summary: row.summary,
      artifactEvidence: JSON.parse(row.artifact_evidence_json) as NavigatorWorkflowStepOutcome["artifactEvidence"],
      resultDigest: row.result_digest,
      recordedAt: row.recorded_at,
    } : null;
  }

  public recordPlanningResult(input: Readonly<{
    attemptId: string;
    effectIdempotencyKey: string;
    observedExternalStateDigest: string;
    result: unknown;
    ownerId: string;
    generation: number;
    now: number;
  }>): NavigatorPlanningResultRecord | null {
    assertIdentifier(input.attemptId, "attemptId");
    assertIdentifier(input.effectIdempotencyKey, "effectIdempotencyKey");
    assertIdentifier(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction(() => {
      if (!this.effectLeaseCurrent(input.effectIdempotencyKey, input.ownerId, input.generation, input.now)) {
        return null;
      }
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt || attempt.effectIdempotencyKey !== input.effectIdempotencyKey || attempt.resource === null) {
        return null;
      }
      const snapshotRow = this.db.prepare(
        `SELECT snapshot.* FROM navigator_snapshots AS snapshot
          JOIN workflow_steps AS step ON step.snapshot_id = snapshot.id
         WHERE step.id = ?`,
      ).get(attempt.workflowStepId) as SnapshotRow | undefined;
      if (!snapshotRow) return null;
      const snapshot = parseSnapshot(snapshotRow);
      const job = this.acceptedSettlementJob(attempt, input.effectIdempotencyKey, snapshot);
      if (
        !job || job.cancelRequestedAt !== null ||
        !/^[0-9a-f]{64}$/u.test(input.observedExternalStateDigest) ||
        input.observedExternalStateDigest !== snapshot.externalStateDigest ||
        attempt.artifactBindings.some((binding) => {
          const current = this.artifacts.getCurrentSnapshot(binding.artifactId);
          const revisableSpecification = attempt.skillId === "to-spec" &&
            this.artifacts.getArtifact(binding.artifactId)?.kind === "specification";
          return current?.id !== binding.snapshotId || current.snapshotDigest !== binding.snapshotDigest ||
            (!revisableSpecification && !this.artifacts.isSnapshotValid(binding.snapshotId));
        })
      ) return null;
      const existing = this.getPlanningResult(input.attemptId);
      if (existing) return existing;
      const contract = navigatorStepContract(attempt.skillId);
      if (!contract) return null;
      const parsedResult = validatedNavigatorOutcome(attempt.skillId, input.result);
      if (parsedResult === null) return null;
      const resultKind = typeof parsedResult.kind === "string" ? parsedResult.kind : null;
      if (
        (resultKind === "research_result" || resultKind === "prototype_result") &&
        !artifactEvidenceMatchesBindings(parsedResult, attempt.artifactBindings)
      ) return null;
      const resultJson = JSON.stringify(parsedResult);
      if (Buffer.byteLength(resultJson, "utf8") > contract.maximumResultBytes) return null;
      const resultDigest = createHash("sha256").update(resultJson, "utf8").digest("hex");
      this.db.prepare(
        `INSERT INTO navigator_planning_results (
           attempt_id, workflow_step_id, skill_id, result_json, result_digest,
           observed_external_state_digest, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        attempt.id,
        attempt.workflowStepId,
        attempt.skillId,
        resultJson,
        resultDigest,
        input.observedExternalStateDigest,
        input.now,
      );
      return this.getPlanningResult(input.attemptId);
    }).immediate();
  }

  public getPlanningResult(attemptId: string): NavigatorPlanningResultRecord | null {
    assertIdentifier(attemptId, "attemptId");
    const row = this.db.prepare(
      `SELECT attempt_id, workflow_step_id, skill_id, result_json, result_digest,
              observed_external_state_digest, recorded_at
         FROM navigator_planning_results WHERE attempt_id = ?`,
    ).get(attemptId) as Readonly<{
      attempt_id: string;
      workflow_step_id: string;
      skill_id: string;
      result_json: string;
      result_digest: string;
      observed_external_state_digest: string;
      recorded_at: number;
    }> | undefined;
    if (!row) return null;
    const persistedOutcome = row.skill_id === "research"
      ? navigatorResearchResultSchema.parse(JSON.parse(row.result_json))
      : parseNavigatorStepResult(row.skill_id, JSON.parse(row.result_json));
    if (createHash("sha256").update(JSON.stringify(persistedOutcome), "utf8").digest("hex") !== row.result_digest) {
      throw new Error("navigator planning result digest binding is invalid");
    }
    return {
      attemptId: row.attempt_id,
      workflowStepId: row.workflow_step_id,
      skillId: row.skill_id,
      result: persistedOutcome,
      resultDigest: row.result_digest,
      observedExternalStateDigest: row.observed_external_state_digest,
      recordedAt: row.recorded_at,
    };
  }

  public getRoutingDecision(decisionDigest: string): NavigatorRoutingDecision | null {
    if (!/^[0-9a-f]{64}$/u.test(decisionDigest)) throw new TypeError("decisionDigest must be a SHA-256 digest");
    const row = this.db.prepare(
      `SELECT decision.*, advice.attempt_id AS advice_attempt_id,
              advice.advice_json, advice.result_digest, advice.recorded_at AS advice_recorded_at,
              block.decision_digest AS blocked_digest
         FROM navigator_routing_decisions AS decision
         LEFT JOIN navigator_routing_advice AS advice
           ON advice.decision_digest = decision.decision_digest
         LEFT JOIN navigator_routing_blocks AS block
           ON block.decision_digest = decision.decision_digest
        WHERE decision.decision_digest = ?`,
    ).get(decisionDigest) as Readonly<{
      decision_digest: string;
      scope_digest: string;
      job_id: string;
      question: string;
      candidate_skill_ids_json: string;
      rationale: string;
      evidence_refs_json: string;
      consultation_step_id: string;
      recorded_at: number;
      advice_attempt_id: string | null;
      advice_json: string | null;
      result_digest: string | null;
      advice_recorded_at: number | null;
      blocked_digest: string | null;
    }> | undefined;
    if (!row) return null;
    const adviceValue = row.advice_json === null ? null : JSON.parse(row.advice_json) as Readonly<{
      advice: string;
      suggestedSkillIds: readonly string[];
      evidenceRefs: readonly string[];
    }>;
    return {
      decisionDigest: row.decision_digest,
      scopeDigest: row.scope_digest,
      jobId: row.job_id,
      question: row.question,
      candidateSkillIds: JSON.parse(row.candidate_skill_ids_json) as readonly string[],
      rationale: row.rationale,
      evidenceRefs: JSON.parse(row.evidence_refs_json) as readonly string[],
      consultationStepId: row.consultation_step_id,
      recordedAt: row.recorded_at,
      advice: adviceValue === null ? null : {
        attemptId: row.advice_attempt_id!,
        ...adviceValue,
        resultDigest: row.result_digest!,
        recordedAt: row.advice_recorded_at!,
      },
      blocked: row.blocked_digest !== null,
    };
  }

  private getRoutingDecisionByScope(scopeDigest: string): NavigatorRoutingDecision | null {
    if (!/^[0-9a-f]{64}$/u.test(scopeDigest)) throw new TypeError("scopeDigest must be a SHA-256 digest");
    const row = this.db.prepare(
      "SELECT decision_digest FROM navigator_routing_decisions WHERE scope_digest = ?",
    ).get(scopeDigest) as { decision_digest: string } | undefined;
    return row ? this.getRoutingDecision(row.decision_digest) : null;
  }

  private releasePrerequisitesIncomplete(job: Job, implementationTicketIds: readonly string[]): boolean {
    const integration = this.db.prepare(
      "SELECT state FROM navigator_integrations WHERE job_id = ?",
    ).get(job.id) as { state: string } | undefined;
    if (
      !integration ||
      !["ready_for_pull_request", "publishing_pull_request", "ready_for_release"].includes(integration.state)
    ) return true;
    const tickets = this.db.prepare(
      "SELECT artifact_id, state FROM navigator_integration_tickets WHERE job_id = ? ORDER BY ticket_order",
    ).all(job.id) as Array<{ artifact_id: string; state: string }>;
    if (tickets.length === 0 || tickets.some((ticket) => ticket.state !== "resolved")) return true;
    const ticketIds = new Set(tickets.map((ticket) => ticket.artifact_id));
    return ticketIds.size !== implementationTicketIds.length ||
      implementationTicketIds.some((artifactId) => !ticketIds.has(artifactId));
  }

  public leaseEffect(input: Readonly<{
    ownerId: string;
    generation: number;
    now: number;
    leaseMs: number;
  }>): StoredEffect | null {
    assertIdentifier(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    assertPositiveInteger(input.leaseMs, "leaseMs");
    return this.db.transaction(() => this.leaseEffectInTransaction(input)).immediate();
  }

  private leaseEffectInTransaction(input: Readonly<{
    ownerId: string;
    generation: number;
    now: number;
    leaseMs: number;
  }>): StoredEffect | null {
    if (!this.executorLeaseCurrent(input.ownerId, input.generation, input.now)) return null;
    const row = this.db.prepare(NAVIGATOR_EFFECT_LEASE_QUERY)
      .get(input.now, input.now) as EffectRow | undefined;
    if (!row) return null;
    const effect = parseStoredEffect(row);
    return this.admitAndLeaseEffect(effect, input);
  }

  private admitAndLeaseEffect(
    effect: StoredEffect,
    input: Readonly<{
      ownerId: string;
      generation: number;
      now: number;
      leaseMs: number;
    }>,
  ): StoredEffect | null {
    if (!this.navigatorAuthorityCanBeAdmitted(effect, input.now)) return null;
    if (!this.updateNavigatorEffectLease(effect, input)) return null;
    return parseStoredEffect(this.db.prepare("SELECT * FROM effects WHERE idempotency_key = ?")
      .get(effect.idempotencyKey) as EffectRow);
  }

  private navigatorAuthorityCanBeAdmitted(effect: StoredEffect, now: number): boolean {
    return this.navigatorEffectAuthorityEffects(effect).every((authorityEffect) => this.taskAuthorities.admitEffect(
      effect.jobId,
      effect.idempotencyKey,
      authorityEffect,
      now,
    ));
  }

  private updateNavigatorEffectLease(
    effect: StoredEffect,
    input: Readonly<{
      ownerId: string;
      generation: number;
      now: number;
      leaseMs: number;
    }>,
  ): boolean {
    return this.db.prepare(
      `UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?,
           lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
        WHERE idempotency_key = ? AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
          OR (status = 'leased' AND lease_expires_at <= ?))`,
    ).run(
      input.ownerId,
      input.generation,
      input.now + input.leaseMs,
      input.now,
      effect.idempotencyKey,
      input.now,
      input.now,
    ).changes === 1;
  }

  private navigatorEffectAuthorityEffects(effect: StoredEffect): readonly TaskAuthorityEffect[] {
    if (effect.kind === "run_navigator_ticket_worker") {
      return ["worktree_write", "commit", "push", "pull_request"];
    }
    if (effect.kind === "run_navigator_release") return ["commit", "push", "pull_request"];
    const attemptId = effect.payload.attemptId;
    const attempt = typeof attemptId === "string"
      ? this.db.prepare("SELECT skill_id FROM navigator_skill_attempts WHERE id = ?")
        .get(attemptId) as { skill_id: string } | undefined
      : undefined;
    return [attempt?.skill_id === "prototype" ? "prototype_write" : "artifact_write"];
  }

  public leaseSkillEffect(input: Readonly<{
    ownerId: string;
    generation: number;
    now: number;
    leaseMs: number;
  }>): StoredEffect | null {
    assertIdentifier(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    assertPositiveInteger(input.leaseMs, "leaseMs");
    return this.db.transaction((): StoredEffect | null => {
      if (!this.executorLeaseCurrent(input.ownerId, input.generation, input.now)) return null;
      const row = this.db.prepare(
        `SELECT effect.*
           FROM effects AS effect
           JOIN navigator_skill_attempts AS attempt ON attempt.effect_idempotency_key = effect.idempotency_key
           JOIN workflow_steps AS step ON step.id = attempt.workflow_step_id
           JOIN navigator_snapshots AS snapshot ON snapshot.id = step.snapshot_id
           JOIN jobs AS job ON job.id = effect.job_id
          WHERE effect.kind = 'run_navigator_skill'
            AND job.workflow_engine = 'navigator-v1' AND job.workflow_mode = 'deterministic'
            AND job.state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed')
            AND job.cancel_requested_at IS NULL
            AND effect.job_id = attempt.job_id AND attempt.job_id = step.job_id
            AND step.job_id = snapshot.job_id
            AND attempt.job_version = step.job_version AND step.job_version = snapshot.job_version
            AND attempt.workflow_revision = step.workflow_revision
            AND step.workflow_revision = snapshot.workflow_revision
            AND attempt.snapshot_digest = snapshot.digest
            AND job.workflow_revision = step.workflow_revision
            AND job.current_workflow_step_id = attempt.workflow_step_id
            AND NOT EXISTS (
              SELECT 1 FROM workflow_step_outcomes AS outcome
               WHERE outcome.workflow_step_id = attempt.workflow_step_id
            )
            AND ((effect.status IN ('pending', 'failed') AND effect.next_attempt_at <= ?)
              OR (effect.status = 'leased' AND effect.lease_expires_at <= ?))
          ORDER BY effect.created_at, effect.idempotency_key
          LIMIT 1`,
      ).get(input.now, input.now) as EffectRow | undefined;
      if (!row) return null;
      const skill = this.db.prepare(
        "SELECT skill_id FROM navigator_skill_attempts WHERE effect_idempotency_key = ?",
      ).get(row.idempotency_key) as { skill_id: string } | undefined;
      if (!skill || !this.taskAuthorities.admitEffect(
        row.job_id,
        row.idempotency_key,
        skill.skill_id === "prototype" ? "prototype_write" : "artifact_write",
        input.now,
      )) return null;
      const updated = this.db.prepare(
        `UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?,
             lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE idempotency_key = ? AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
            OR (status = 'leased' AND lease_expires_at <= ?))`,
      ).run(
        input.ownerId,
        input.generation,
        input.now + input.leaseMs,
        input.now,
        row.idempotency_key,
        input.now,
        input.now,
      );
      if (updated.changes !== 1) return null;
      const leased = this.db.prepare("SELECT * FROM effects WHERE idempotency_key = ?")
        .get(row.idempotency_key) as EffectRow;
      return parseStoredEffect(leased);
    }).immediate();
  }

  public leaseReleaseEffect(input: Readonly<{
    ownerId: string;
    generation: number;
    now: number;
    leaseMs: number;
  }>): StoredEffect | null {
    assertIdentifier(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    assertPositiveInteger(input.leaseMs, "leaseMs");
    return this.db.transaction((): StoredEffect | null => {
      if (!this.executorLeaseCurrent(input.ownerId, input.generation, input.now)) return null;
      const row = this.db.prepare(
        `SELECT effect.*
           FROM effects AS effect
           JOIN navigator_release_attempts AS attempt ON attempt.effect_idempotency_key = effect.idempotency_key
           JOIN workflow_steps AS step ON step.id = attempt.workflow_step_id
           JOIN navigator_snapshots AS snapshot ON snapshot.id = step.snapshot_id
           JOIN jobs AS job ON job.id = effect.job_id
          WHERE effect.kind = 'run_navigator_release'
            AND job.workflow_engine = 'navigator-v1' AND job.workflow_mode = 'deterministic'
            AND job.state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed')
            AND job.cancel_requested_at IS NULL
            AND effect.job_id = attempt.job_id AND attempt.job_id = step.job_id
            AND step.job_id = snapshot.job_id
            AND attempt.job_version = step.job_version AND step.job_version = snapshot.job_version
            AND attempt.workflow_revision = step.workflow_revision
            AND step.workflow_revision = snapshot.workflow_revision
            AND attempt.snapshot_digest = snapshot.digest
            AND job.workflow_revision = step.workflow_revision
            AND job.current_workflow_step_id = attempt.workflow_step_id
            AND NOT EXISTS (
              SELECT 1 FROM navigator_release_outcomes AS outcome WHERE outcome.attempt_id = attempt.id
            )
            AND ((effect.status IN ('pending', 'failed') AND effect.next_attempt_at <= ?)
              OR (effect.status = 'leased' AND effect.lease_expires_at <= ?))
          ORDER BY effect.created_at, effect.idempotency_key
          LIMIT 1`,
      ).get(input.now, input.now) as EffectRow | undefined;
      if (!row) return null;
      if (!(["commit", "push", "pull_request"] as const).every((operation) => this.taskAuthorities.admitEffect(
        row.job_id,
        row.idempotency_key,
        operation,
        input.now,
      ))) return null;
      const updated = this.db.prepare(
        `UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?,
             lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE idempotency_key = ? AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
            OR (status = 'leased' AND lease_expires_at <= ?))`,
      ).run(
        input.ownerId,
        input.generation,
        input.now + input.leaseMs,
        input.now,
        row.idempotency_key,
        input.now,
        input.now,
      );
      if (updated.changes !== 1) return null;
      const leased = this.db.prepare("SELECT * FROM effects WHERE idempotency_key = ?")
        .get(row.idempotency_key) as EffectRow;
      return parseStoredEffect(leased);
    }).immediate();
  }

  public getReleaseAttempt(id: string): NavigatorReleaseAttempt | null {
    assertIdentifier(id, "attemptId");
    const row = this.db.prepare("SELECT * FROM navigator_release_attempts WHERE id = ?").get(id) as {
      id: string;
      job_id: string;
      workflow_step_id: string;
      effect_idempotency_key: string;
      implementation_ticket_ids_json: string;
      snapshot_digest: string;
      job_version: number;
      workflow_revision: number;
      capability_profile_id: string | null;
      capability_profile_revision: number | null;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      jobId: row.job_id,
      workflowStepId: row.workflow_step_id,
      effectIdempotencyKey: row.effect_idempotency_key,
      implementationTicketIds: JSON.parse(row.implementation_ticket_ids_json) as readonly string[],
      snapshotDigest: row.snapshot_digest,
      jobVersion: row.job_version,
      workflowRevision: row.workflow_revision,
      capabilityProfileId: row.capability_profile_id,
      capabilityProfileRevision: row.capability_profile_revision,
    };
  }

  public bindAttemptResource(input: Readonly<{
    attemptId: string;
    effectIdempotencyKey: string;
    resource: { kind: "bb_thread"; id: string };
    ownerId: string;
    generation: number;
    now: number;
  }>): boolean {
    assertIdentifier(input.attemptId, "attemptId");
    assertIdentifier(input.effectIdempotencyKey, "effectIdempotencyKey");
    assertIdentifier(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    if (input.resource.kind !== "bb_thread") throw new TypeError("navigator skill resource kind is invalid");
    assertIdentifier(input.resource.id, "resource id");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): boolean => {
      if (!this.effectLeaseCurrent(input.effectIdempotencyKey, input.ownerId, input.generation, input.now)) return false;
      const current = this.getAttempt(input.attemptId);
      if (!current || current.effectIdempotencyKey !== input.effectIdempotencyKey) return false;
      if (current.resource !== null) return current.resource.kind === input.resource.kind && current.resource.id === input.resource.id;
      return this.db.prepare(
        `UPDATE navigator_skill_attempts SET resource_kind = 'bb_thread', resource_id = ?, updated_at = ?
          WHERE id = ? AND effect_idempotency_key = ? AND resource_kind IS NULL AND resource_id IS NULL`,
      ).run(input.resource.id, input.now, input.attemptId, input.effectIdempotencyKey).changes === 1;
    }).immediate();
  }

  public settleAttempt(input: Readonly<{
    attemptId: string;
    effectIdempotencyKey: string;
    observedExternalStateDigest: string;
    result: unknown;
    receipt?: NavigatorSkillReceipt;
    publishedArtifactBindings?: readonly NavigatorArtifactBinding[];
    reconciledArtifactIds?: readonly string[];
    policyFailureReason?: string;
    ownerId: string;
    generation: number;
    now: number;
  }>): NavigatorWorkflowStepOutcome | null {
    assertIdentifier(input.attemptId, "attemptId");
    assertIdentifier(input.effectIdempotencyKey, "effectIdempotencyKey");
    assertIdentifier(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    if (input.policyFailureReason !== undefined) assertIdentifier(input.policyFailureReason, "policyFailureReason");
    return this.db.transaction((): NavigatorWorkflowStepOutcome | null => {
      if (!this.effectLeaseCurrent(input.effectIdempotencyKey, input.ownerId, input.generation, input.now)) return null;
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt || attempt.effectIdempotencyKey !== input.effectIdempotencyKey) return null;
      if (input.receipt !== undefined && (
        input.receipt.kind !== "run_navigator_skill" || input.receipt.effectIdempotencyKey !== input.effectIdempotencyKey ||
        input.receipt.attemptId !== attempt.id || input.receipt.observedExternalStateDigest !== input.observedExternalStateDigest
      )) return null;
      const receiptResource = input.receipt?.resource ?? attempt.resource;
      if (receiptResource === null) return null;
      if (attempt.resource !== null && (
        attempt.resource.kind !== receiptResource.kind || attempt.resource.id !== receiptResource.id
      )) return null;
      if (attempt.resource === null) {
        const bound = this.db.prepare(
          `UPDATE navigator_skill_attempts SET resource_kind = 'bb_thread', resource_id = ?, updated_at = ?
            WHERE id = ? AND effect_idempotency_key = ? AND resource_kind IS NULL AND resource_id IS NULL`,
        ).run(receiptResource.id, input.now, attempt.id, input.effectIdempotencyKey);
        if (bound.changes !== 1) return null;
      }
      const existing = this.getOutcome(attempt.workflowStepId);
      if (existing) return existing;
      const snapshotRow = this.db.prepare(
        `SELECT snapshot.* FROM navigator_snapshots AS snapshot
          JOIN workflow_steps AS step ON step.snapshot_id = snapshot.id
         WHERE step.id = ?`,
      ).get(attempt.workflowStepId) as SnapshotRow | undefined;
      if (!snapshotRow) throw new Error("navigator attempt snapshot disappeared");
      const snapshot = parseSnapshot(snapshotRow);
      const job = this.acceptedSettlementJob(attempt, input.effectIdempotencyKey, snapshot);
      if (!job) return null;
      if (job.cancelRequestedAt !== null || job.state === "cancelled") {
        this.supersedeCancelledAttempt({ attempt, ...input });
        return null;
      }
      if (["merged", "cancelled", "blocked", "complete", "production_failed"].includes(job.state)) return null;
      let reasonCode = input.policyFailureReason ?? "succeeded";
      let outcome: NavigatorWorkflowStepOutcome["outcome"] = input.policyFailureReason ? "policy_failure" : "succeeded";
      const contract = navigatorStepContract(attempt.skillId);
      const parsedResult = validatedNavigatorOutcome(attempt.skillId, input.result);
      if (outcome === "succeeded" && !/^[0-9a-f]{64}$/u.test(input.observedExternalStateDigest)) {
        outcome = "policy_failure";
        reasonCode = "malformed_external_state_digest";
      }
      if (outcome === "succeeded" && input.observedExternalStateDigest !== snapshot.externalStateDigest) {
        outcome = "policy_failure";
        reasonCode = "external_drift";
      }
      if (outcome === "succeeded" && parsedResult === null) {
        outcome = "policy_failure";
        reasonCode = "malformed_result";
      }
      if (
        outcome === "succeeded" && parsedResult !== null && contract !== null &&
        Buffer.byteLength(JSON.stringify(parsedResult), "utf8") > contract.maximumResultBytes
      ) {
        outcome = "policy_failure";
        reasonCode = "result_too_large";
      }
      const resultKind = typeof parsedResult?.kind === "string" ? parsedResult.kind : null;
      const validatesBoundEvidence = resultKind === "research_result" || resultKind === "prototype_result";
      if (
        outcome === "succeeded" && parsedResult !== null && validatesBoundEvidence &&
        input.publishedArtifactBindings === undefined
      ) {
        if (!artifactEvidenceMatchesBindings(parsedResult, attempt.artifactBindings)) {
          outcome = "policy_failure";
          reasonCode = "unauthorized_artifact_evidence";
        } else {
          for (const binding of attempt.artifactBindings) {
            const current = this.artifacts.getCurrentSnapshot(binding.artifactId);
            if (
              current?.id !== binding.snapshotId || current.snapshotDigest !== binding.snapshotDigest ||
              !this.artifacts.isSnapshotValid(binding.snapshotId)
            ) {
              outcome = "policy_failure";
              reasonCode = "stale_artifact_snapshot";
              break;
            }
          }
        }
      }
      const publishedBindings = input.publishedArtifactBindings === undefined
        ? null
        : artifactBindingSchema.array().max(128).parse(input.publishedArtifactBindings);
      const reconciledArtifactIds = new Set(input.reconciledArtifactIds ?? []);
      if (reconciledArtifactIds.size !== (input.reconciledArtifactIds?.length ?? 0)) {
        throw new TypeError("reconciled navigator artifacts contain duplicates");
      }
      if (
        outcome === "succeeded" &&
        !this.attemptBindingsAreCurrent(attempt, publishedBindings, reconciledArtifactIds)
      ) {
        outcome = "policy_failure";
        reasonCode = "stale_artifact_snapshot";
      }
      if (outcome === "succeeded" && contract?.operationClass === "artifact_write") {
        if (publishedBindings === null || publishedBindings.length === 0) {
          outcome = "policy_failure";
          reasonCode = "artifact_publication_missing";
        } else if (publishedBindings.some((binding) => {
          const current = this.artifacts.getCurrentSnapshot(binding.artifactId);
          return current?.id !== binding.snapshotId || current.snapshotDigest !== binding.snapshotDigest ||
            !this.artifacts.isSnapshotValid(binding.snapshotId);
        })) {
          outcome = "policy_failure";
          reasonCode = "stale_published_artifact";
        }
      }
      if (outcome === "succeeded" && resultKind === "ask_matt_result") {
        const routingDigest = attempt.stepInput.kind === "navigator_planning_input"
          ? attempt.stepInput.routingDecisionDigest
          : null;
        if (routingDigest === null || parsedResult?.decisionDigest !== routingDigest) {
          outcome = "policy_failure";
          reasonCode = "routing_decision_digest_mismatch";
        }
      }
      const evidenceSource = input.publishedArtifactBindings === undefined
        ? parsedResult?.artifactEvidence as NavigatorWorkflowStepOutcome["artifactEvidence"] | undefined
        : undefined;
      const artifactEvidence = outcome === "succeeded"
        ? evidenceSource ?? (publishedBindings ?? []).map((binding) => ({
          ...binding,
          finding: String(parsedResult?.summary ?? "Navigator planning artifact published."),
          evidenceRefs: Array.isArray(parsedResult?.evidenceRefs)
            ? parsedResult.evidenceRefs as readonly string[]
            : [],
        }))
        : [];
      const summary = outcome === "succeeded" && typeof parsedResult?.summary === "string"
        ? parsedResult.summary
        : `Navigator skill result rejected: ${reasonCode}`;
      const resultJson = serializeNavigatorJson(
        outcome === "succeeded" && parsedResult !== null ? parsedResult : { outcome, reasonCode },
        "navigator skill result",
      );
      const resultDigest = createHash("sha256").update(resultJson, "utf8").digest("hex");
      if (input.receipt !== undefined) {
        const receiptJson = JSON.stringify(input.receipt);
        this.db.prepare(
          `INSERT INTO navigator_effect_receipts (
             effect_idempotency_key, job_id, kind, receipt_json, receipt_digest,
             owner_id, generation, recorded_at
           ) VALUES (?, ?, 'run_navigator_skill', ?, ?, ?, ?, ?)`,
        ).run(
          input.effectIdempotencyKey,
          attempt.jobId,
          receiptJson,
          createHash("sha256").update(receiptJson, "utf8").digest("hex"),
          input.ownerId,
          input.generation,
          input.now,
        );
      }
      this.db.prepare(
        `INSERT INTO workflow_step_outcomes (
           workflow_step_id, attempt_id, outcome, reason_code, summary,
           artifact_evidence_json, result_digest, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        attempt.workflowStepId,
        attempt.id,
        outcome,
        reasonCode,
        summary,
        JSON.stringify(artifactEvidence),
        resultDigest,
        input.now,
      );
      if (outcome === "succeeded" && resultKind === "ask_matt_result") {
        const routingDigest = attempt.stepInput.kind === "navigator_planning_input"
          ? attempt.stepInput.routingDecisionDigest!
          : "";
        this.db.prepare(
          `INSERT OR IGNORE INTO navigator_routing_advice (
             decision_digest, attempt_id, advice_json, result_digest, recorded_at
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run(
          routingDigest,
          attempt.id,
          JSON.stringify({
            advice: parsedResult!.advice,
            suggestedSkillIds: parsedResult!.suggestedSkillIds,
            evidenceRefs: parsedResult!.evidenceRefs,
          }),
          resultDigest,
          input.now,
        );
      }
      const nextBindings = outcome === "succeeded" && publishedBindings !== null
        ? publishedBindings
        : job.artifactBindings;
      const jobUpdate = this.db.prepare(
        `UPDATE jobs SET current_workflow_step_id = NULL,
             artifact_bindings_json = ?,
             workflow_revision = workflow_revision + CASE WHEN ? = 'ask_matt_result' THEN 0 ELSE 1 END,
             version = version + 1, updated_at = ?
          WHERE id = ? AND current_workflow_step_id = ?`,
      ).run(JSON.stringify(nextBindings), resultKind, input.now, attempt.jobId, attempt.workflowStepId);
      if (jobUpdate.changes !== 1) throw new Error("navigator workflow step changed before settlement");
      this.updateTaskAuthorityGraph(attempt.jobId, nextBindings, input.now);
      const effectUpdate = this.db.prepare(
        `UPDATE effects SET status = 'done', lease_owner = NULL, lease_generation = NULL,
             lease_expires_at = NULL, last_error = NULL, updated_at = ?
          WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
            AND lease_generation = ? AND lease_expires_at > ?`,
      ).run(input.now, input.effectIdempotencyKey, input.ownerId, input.generation, input.now);
      if (effectUpdate.changes !== 1) throw new Error("navigator effect lease changed before settlement");
      return this.getOutcome(attempt.workflowStepId);
    }).immediate();
  }

  private attemptBindingsAreCurrent(
    attempt: NavigatorSkillAttempt,
    publishedBindings: readonly NavigatorArtifactBinding[] | null,
    reconciledArtifactIds: ReadonlySet<string>,
  ): boolean {
    return attempt.artifactBindings.every((binding) => {
      const current = this.artifacts.getCurrentSnapshot(binding.artifactId);
      const exact = current?.id === binding.snapshotId &&
        current.snapshotDigest === binding.snapshotDigest &&
        this.artifacts.isSnapshotValid(binding.snapshotId);
      if (exact) return true;
      return current !== null && this.artifacts.isSnapshotValid(current.id) &&
        reconciledArtifactIds.has(binding.artifactId) &&
        publishedBindings?.some((published) =>
          published.artifactId === binding.artifactId && published.snapshotId === current.id &&
          published.snapshotDigest === current.snapshotDigest) === true;
    });
  }

  private acceptedSettlementJob(
    attempt: NavigatorSkillAttempt,
    effectIdempotencyKey: string,
    snapshot: NavigatorSnapshot,
  ): Job | null {
    const acceptedIdentity = this.db.prepare(
      `SELECT 1 FROM effects AS effect
        JOIN navigator_skill_attempts AS attempt ON attempt.effect_idempotency_key = effect.idempotency_key
        JOIN workflow_steps AS step ON step.id = attempt.workflow_step_id
        JOIN navigator_snapshots AS snapshot ON snapshot.id = step.snapshot_id
       WHERE effect.idempotency_key = ? AND attempt.id = ? AND snapshot.id = ?
         AND effect.job_id = attempt.job_id AND attempt.job_id = step.job_id AND step.job_id = snapshot.job_id
         AND attempt.job_version = step.job_version AND step.job_version = snapshot.job_version
         AND attempt.workflow_revision = step.workflow_revision
         AND step.workflow_revision = snapshot.workflow_revision
         AND attempt.snapshot_digest = snapshot.digest`,
    ).get(effectIdempotencyKey, attempt.id, snapshot.snapshotId);
    if (!acceptedIdentity) return null;
    const job = readJobById(this.db, attempt.jobId);
    if (
      !job || job.workflowEngine !== "navigator-v1" || job.workflowMode !== "deterministic" ||
      job.currentWorkflowStepId !== attempt.workflowStepId || job.workflowRevision !== attempt.workflowRevision
    ) return null;
    return job;
  }

  private supersedeCancelledAttempt(input: Readonly<{
    attempt: NavigatorSkillAttempt;
    effectIdempotencyKey: string;
    ownerId: string;
    generation: number;
    now: number;
  }>): void {
    const reason = this.cancellationSupersessionReason(input.attempt.workflowStepId, input.now);
    this.db.prepare(
      `UPDATE jobs SET current_workflow_step_id = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND current_workflow_step_id = ?
          AND (cancel_requested_at IS NOT NULL OR state = 'cancelled')`,
    ).run(input.now, input.attempt.jobId, input.attempt.workflowStepId);
    this.finishSupersededEffect({ ...input, reason });
  }

  private cancellationSupersessionReason(workflowStepId: string, now: number): string {
    const existing = this.db.prepare(
      "SELECT reason FROM workflow_step_supersessions WHERE workflow_step_id = ?",
    ).get(workflowStepId) as { reason: string } | undefined;
    if (existing) return existing.reason;
    this.db.prepare(
      `INSERT INTO workflow_step_supersessions (
         workflow_step_id, superseded_by_step_id, reason, recorded_at
       ) VALUES (?, NULL, 'job_cancelled', ?)`,
    ).run(workflowStepId, now);
    return "job_cancelled";
  }

  private finishSupersededEffect(input: Readonly<{
    effectIdempotencyKey: string;
    ownerId: string;
    generation: number;
    now: number;
    reason: string;
  }>): void {
    const effectUpdate = this.db.prepare(
      `UPDATE effects SET status = 'done', lease_owner = NULL, lease_generation = NULL,
           lease_expires_at = NULL, last_error = ?, updated_at = ?
        WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
          AND lease_generation = ? AND lease_expires_at > ?`,
    ).run(
      `superseded:${input.reason}`,
      input.now,
      input.effectIdempotencyKey,
      input.ownerId,
      input.generation,
      input.now,
    );
    if (effectUpdate.changes !== 1) throw new Error("navigator effect lease changed before cancellation settlement");
  }

  private insertDecision(
    proposalId: string,
    jobId: string,
    snapshotId: string,
    decision: NavigatorProposalDecision["decision"],
    reasonCode: string,
    now: number,
  ): void {
    this.db.prepare(
      `INSERT INTO navigator_decisions (
         proposal_id, job_id, snapshot_id, decision, reason_code, decided_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(proposalId, jobId, snapshotId, decision, reasonCode, now);
  }

  private decisionForProposal(proposalId: string): NavigatorProposalDecision | null {
    const row = this.db.prepare(
      `SELECT decision.*, step.id AS workflow_step_id,
              COALESCE(attempt.id, release_attempt.id) AS attempt_id,
              COALESCE(attempt.effect_idempotency_key, release_attempt.effect_idempotency_key) AS effect_idempotency_key
         FROM navigator_decisions AS decision
         LEFT JOIN workflow_steps AS step ON step.proposal_id = decision.proposal_id
         LEFT JOIN navigator_skill_attempts AS attempt ON attempt.workflow_step_id = step.id
         LEFT JOIN navigator_release_attempts AS release_attempt ON release_attempt.workflow_step_id = step.id
        WHERE decision.proposal_id = ?`,
    ).get(proposalId) as {
      snapshot_id: string;
      proposal_id: string;
      decision: NavigatorProposalDecision["decision"];
      reason_code: string;
      workflow_step_id: string | null;
      attempt_id: string | null;
      effect_idempotency_key: string | null;
    } | undefined;
    return row ? {
      snapshotId: row.snapshot_id,
      proposalId: row.proposal_id,
      decision: row.decision,
      reasonCode: row.reason_code,
      workflowStepId: row.workflow_step_id,
      attemptId: row.attempt_id,
      effectIdempotencyKey: row.effect_idempotency_key,
    } : null;
  }

  private requireDecision(proposalId: string): NavigatorProposalDecision {
    const decision = this.decisionForProposal(proposalId);
    if (!decision) throw new Error("navigator decision was not stored");
    return decision;
  }

  private executorLeaseCurrent(ownerId: string, generation: number, now: number): boolean {
    return this.db.prepare(
      `SELECT 1 FROM executor_lease
        WHERE singleton = 1 AND owner_id = ? AND generation = ? AND lease_expires_at > ?`,
    ).get(ownerId, generation, now) !== undefined;
  }

  private effectLeaseCurrent(key: string, ownerId: string, generation: number, now: number): boolean {
    return this.executorLeaseCurrent(ownerId, generation, now) && this.db.prepare(
      `SELECT 1 FROM effects WHERE idempotency_key = ? AND status = 'leased'
        AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
    ).get(key, ownerId, generation, now) !== undefined;
  }
}
