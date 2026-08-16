import { createHash } from "node:crypto";
import type { Job, JobEvent } from "../domain/models";
import type {
  CapabilityProfile,
} from "../storage/capability-repository";
import type { TelegramAgentStore } from "../storage/store";
import {
  CAPABILITY_BY_ID,
  CAPABILITY_GRAPH_DIGEST,
  CAPABILITY_REGISTRY_DIGEST,
} from "./catalog";
import { DEFAULT_MODEL_POOL_REGISTRY, selectModelRoute, type ModelPool } from "./models";
import type { CapabilityTerminalOutcome } from "./contracts";

export const NATIVE_ADAPTER_TRANSITIONS = [
  "plan-worktree-created",
  "implementation-worktree-created",
  "review-created",
  "branch-finished",
] as const;

export type NativeAdapterTransition = typeof NATIVE_ADAPTER_TRANSITIONS[number];

export type NativeAdapterTransitionOutcome = Readonly<{
  capabilityId: string;
  descriptorDigest: string;
  outcome: CapabilityTerminalOutcome;
  evidenceRefs: readonly string[];
}>;

export type NativeAdapterTransitionEnvelope = Readonly<{
  profileId: string;
  profileRevision: number;
  transition: NativeAdapterTransition;
  operationDigest: string;
  settled: boolean;
  outcomes: readonly NativeAdapterTransitionOutcome[];
}>;

export type NativeAdapterActivation = Readonly<{
  selectedCapabilityIds: readonly string[];
  denied: readonly Readonly<{
    capabilityId: string;
    reasonCode: "one_writer_worktree";
  }>[];
}>;

type NativeAdapterRequirement = Readonly<{
  transition: NativeAdapterTransition;
  capabilityIds: readonly string[];
  acceptedOutcomes: readonly CapabilityTerminalOutcome[];
}>;

const ADAPTER_CONTRACTS: Readonly<Record<string, Readonly<{
  preservedInvariants: readonly string[];
  replacedMechanics: string;
}>>> = {
  "hanoon-native-using-superpowers": {
    preservedInvariants: ["capability-profile-before-action", "smallest-safe-workflow"],
    replacedMechanics: "executor-owned-capability-routing",
  },
  "hanoon-native-using-git-worktrees": {
    preservedInvariants: ["managed-worktree-ownership", "one-code-writer-per-worktree"],
    replacedMechanics: "bb-managed-worktree-lifecycle",
  },
  "hanoon-native-executing-plans": {
    preservedInvariants: ["immutable-recipe-version", "ordered-plan-checkpoints"],
    replacedMechanics: "effect-driven-plan-execution",
  },
  "hanoon-native-subagent-driven-development": {
    preservedInvariants: ["genuinely-independent-tasks", "one-code-writer-per-worktree"],
    replacedMechanics: "executor-owned-independent-workstreams",
  },
  "hanoon-native-dispatching-parallel-agents": {
    preservedInvariants: ["bounded-fanout", "independent-review-lanes"],
    replacedMechanics: "executor-owned-parallel-fanout",
  },
  "hanoon-native-requesting-code-review": {
    preservedInvariants: ["exact-head-review", "independent-reviewer"],
    replacedMechanics: "bb-review-attempt-creation",
  },
  "hanoon-native-finishing-a-development-branch": {
    preservedInvariants: ["exact-head-delivery", "owner-controlled-integration"],
    replacedMechanics: "fenced-branch-finishing",
  },
};

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function nativeAdapterActivationForTransition(
  job: Job,
  transition: NativeAdapterTransition,
  reviewLaneCount?: number,
): NativeAdapterActivation {
  const workflowDiscipline = "hanoon-native-using-superpowers";
  switch (transition) {
    case "plan-worktree-created":
      return {
        selectedCapabilityIds: ["hanoon-native-using-git-worktrees", workflowDiscipline].sort(),
        denied: [],
      };
    case "implementation-worktree-created":
      return {
        selectedCapabilityIds: sortedUnique([
          "hanoon-native-using-git-worktrees",
          workflowDiscipline,
          ...(job.taskRecipe === "architectural" ? ["hanoon-native-executing-plans"] : []),
        ]),
        // The current recipe projection owns exactly one implementation
        // worktree. Selecting this adapter without a durable partition into
        // independent worktrees would silently authorize multiple writers.
        denied: [{
          capabilityId: "hanoon-native-subagent-driven-development",
          reasonCode: "one_writer_worktree",
        }],
      };
    case "review-created":
      if (!Number.isInteger(reviewLaneCount) || (reviewLaneCount ?? 0) < 1 || (reviewLaneCount ?? 0) > 4) {
        throw new TypeError("Active review adapter requires a bounded review-lane count");
      }
      return {
        selectedCapabilityIds: sortedUnique([
          "hanoon-native-requesting-code-review",
          workflowDiscipline,
          ...((reviewLaneCount ?? 0) > 1 ? ["hanoon-native-dispatching-parallel-agents"] : []),
        ]),
        denied: [],
      };
    case "branch-finished":
      return {
        selectedCapabilityIds: ["hanoon-native-finishing-a-development-branch", workflowDiscipline].sort(),
        denied: [],
      };
  }
}

function adapterIdsForTransition(
  job: Job,
  transition: NativeAdapterTransition,
  reviewLaneCount?: number,
): string[] {
  return [...nativeAdapterActivationForTransition(job, transition, reviewLaneCount).selectedCapabilityIds];
}

export function nativeAdapterRequirementForEvent(
  job: Job,
  event: JobEvent,
): NativeAdapterRequirement | null {
  if (job.routingMode !== "active") return null;
  if (event.type === "PLAN_CREATED") {
    return {
      transition: "plan-worktree-created",
      capabilityIds: adapterIdsForTransition(job, "plan-worktree-created"),
      acceptedOutcomes: ["passed"],
    };
  }
  if (event.type === "IMPLEMENTATION_CREATED") {
    return {
      transition: "implementation-worktree-created",
      capabilityIds: adapterIdsForTransition(job, "implementation-worktree-created"),
      acceptedOutcomes: ["passed"],
    };
  }
  if (event.type === "REVIEW_STARTED") {
    return {
      transition: "review-created",
      capabilityIds: adapterIdsForTransition(job, "review-created", event.laneCount),
      acceptedOutcomes: ["passed"],
    };
  }
  if (event.type === "PR_LOCATED" && job.state === "locating_pr") {
    return {
      transition: "branch-finished",
      capabilityIds: adapterIdsForTransition(job, "branch-finished"),
      acceptedOutcomes: ["passed"],
    };
  }
  if ((event.type === "PR_MISSING" || event.type === "PR_UNAVAILABLE") && job.state === "locating_pr") {
    return {
      transition: "branch-finished",
      capabilityIds: adapterIdsForTransition(job, "branch-finished"),
      acceptedOutcomes: ["failed", "blocked"],
    };
  }
  return null;
}

function transitionSubjectId(job: Job, transition: NativeAdapterTransition, operationDigest: string): string {
  if (!/^[0-9a-f]{64}$/u.test(operationDigest)) {
    throw new TypeError("Native-adapter operation digest must be a SHA-256");
  }
  const digest = createHash("sha256")
    .update(`${job.id}\0${transition}\0${operationDigest}`, "utf8")
    .digest("hex")
    .slice(0, 40);
  return `native:${digest}`;
}

function adapterEvidence(
  capabilityId: string,
  transition: NativeAdapterTransition,
  operationDigest: string,
): string[] {
  const adapter = CAPABILITY_BY_ID.get(capabilityId);
  const contract = ADAPTER_CONTRACTS[capabilityId];
  if (!adapter || adapter.kind !== "native-adapter" || adapter.route !== "hanoon-native" || !contract) {
    throw new TypeError(`Unknown native adapter ${capabilityId}`);
  }
  if (adapter.composition.prerequisites.length !== 1) {
    throw new TypeError(`Native adapter ${capabilityId} must bind exactly one source skill`);
  }
  const sourceSkillId = adapter.composition.prerequisites[0];
  const sourceSkill = CAPABILITY_BY_ID.get(sourceSkillId);
  if (!sourceSkill || sourceSkill.kind !== "skill" || sourceSkill.route !== "hanoon-native") {
    throw new TypeError(`Native adapter ${capabilityId} has an invalid source skill`);
  }
  return sortedUnique([
    `adapter:${adapter.id}:${adapter.digest}`,
    `adapter-version:${adapter.version}`,
    `authority:fenced-executor-transition`,
    `effect:${operationDigest}`,
    `mechanics:${contract.replacedMechanics}`,
    ...contract.preservedInvariants.map((invariant) => `preserved:${invariant}`),
    `route:hanoon-native`,
    `source-skill:${sourceSkill.id}:${sourceSkill.sourceDigest}`,
    `transition:${transition}`,
  ]);
}

export function prepareNativeAdapterTransition(input: Readonly<{
  store: TelegramAgentStore;
  job: Job;
  transition: NativeAdapterTransition;
  effectIdempotencyKey: string;
  reviewLaneCount?: number;
  minimumModelPool?: ModelPool;
  now: number;
}>): NativeAdapterTransitionEnvelope | undefined {
  if (input.job.routingMode !== "active") return undefined;
  const operationDigest = createHash("sha256").update(input.effectIdempotencyKey, "utf8").digest("hex");
  const activation = nativeAdapterActivationForTransition(input.job, input.transition, input.reviewLaneCount);
  const capabilityIds = [...activation.selectedCapabilityIds];
  const subjectId = transitionSubjectId(input.job, input.transition, operationDigest);
  const risk = input.job.taskRecipe === "architectural" ? "high" as const : "medium" as const;
  const model = selectModelRoute({
    executionClass: "controller",
    recipe: input.job.taskRecipe,
    stage: "orchestration",
    risk,
    minimumPool: input.minimumModelPool,
  }, DEFAULT_MODEL_POOL_REGISTRY);
  const assignments = capabilityIds.map((capabilityId) => {
    const descriptor = CAPABILITY_BY_ID.get(capabilityId);
    if (!descriptor || descriptor.kind !== "native-adapter" || descriptor.route !== "hanoon-native") {
      throw new TypeError(`Native adapter ${capabilityId} is not an admitted exact descriptor`);
    }
    // Generate the evidence before any external action. This verifies the
    // adapter-to-source-skill digest binding at the selection boundary.
    adapterEvidence(capabilityId, input.transition, operationDigest);
    return {
      capabilityId,
      capabilityKind: "native-adapter" as const,
      descriptorDigest: descriptor.digest,
      mandatory: true,
    };
  });
  const expected = {
    subjectKind: "worker_attempt" as const,
    subjectId,
    recipeId: input.job.taskRecipe,
    recipeVersion: input.job.recipeVersion,
    registryDigest: CAPABILITY_REGISTRY_DIGEST,
    graphDigest: CAPABILITY_GRAPH_DIGEST,
    mode: "active" as const,
    model,
    assignments,
    reasonCodes: sortedUnique([
      `native_transition:${input.transition}`,
      ...activation.denied.map((denial) =>
        `native_denial:${denial.capabilityId}:${denial.reasonCode}`),
    ]),
    traits: ["hanoon-native", `transition:${input.transition}`],
  };
  const existing = input.store.getLatestCapabilityProfile("worker_attempt", subjectId);
  const profile = existing ?? input.store.createCapabilityProfile({
    ...expected,
    threadId: null,
    expectedRevision: 1,
    now: input.now,
  });
  const mismatches = [
    ["subjectKind", profile.subjectKind === expected.subjectKind],
    ["subjectId", profile.subjectId === expected.subjectId],
    ["recipeId", profile.recipeId === expected.recipeId],
    ["recipeVersion", profile.recipeVersion === expected.recipeVersion],
    ["registryDigest", profile.registryDigest === expected.registryDigest],
    ["graphDigest", profile.graphDigest === expected.graphDigest],
    ["mode", profile.mode === expected.mode],
    ["model", profile.model.pool === expected.model.pool &&
      profile.model.providerId === expected.model.providerId && profile.model.modelId === expected.model.modelId &&
      profile.model.reasoning === expected.model.reasoning && profile.model.serviceTier === expected.model.serviceTier],
    ["assignments", JSON.stringify(profile.assignments) === JSON.stringify(expected.assignments)],
    ["reasonCodes", JSON.stringify(profile.reasonCodes) === JSON.stringify(expected.reasonCodes)],
    ["traits", JSON.stringify(profile.traits) === JSON.stringify(expected.traits)],
  ] as const;
  const changed = mismatches.filter(([, matches]) => !matches).map(([field]) => field);
  if (changed.length > 0) {
    throw new TypeError(`Persisted native-adapter profile does not match immutable ${changed.join(",")}`);
  }
  for (const denial of activation.denied) {
    const descriptor = CAPABILITY_BY_ID.get(denial.capabilityId);
    if (!descriptor || descriptor.kind !== "native-adapter" || descriptor.route !== "hanoon-native") {
      throw new TypeError(`Denied native adapter ${denial.capabilityId} is not an admitted exact descriptor`);
    }
    const expectedEvidence = sortedUnique([
      "boundary:one-code-writer-per-worktree",
      `effect:${operationDigest}`,
      `transition:${input.transition}`,
    ]);
    const existingDenials = input.store.listCapabilityReceipts(profile.id, 256)
      .filter((receipt) => receipt.eventType === "denied" && receipt.capabilityId === denial.capabilityId);
    if (existingDenials.length > 1 || existingDenials.some((receipt) =>
      receipt.descriptorDigest !== descriptor.digest || receipt.reasonCode !== denial.reasonCode ||
      receipt.mandatory || JSON.stringify(receipt.evidenceRefs) !== JSON.stringify(expectedEvidence))) {
      throw new TypeError(`Persisted native-adapter denial changed for ${denial.capabilityId}`);
    }
    if (existingDenials.length === 0) {
      input.store.appendCapabilityReceipt({
        profileId: profile.id,
        capabilityId: denial.capabilityId,
        capabilityKind: "native-adapter",
        descriptorDigest: descriptor.digest,
        eventType: "denied",
        reasonCode: denial.reasonCode,
        mandatory: false,
        evidenceRefs: expectedEvidence,
        now: input.now,
      });
    }
  }
  const existingOutcomes = input.store.listCapabilityReceipts(profile.id, 256)
    .filter((receipt) => receipt.eventType === "outcome");
  if (existingOutcomes.length !== 0 && existingOutcomes.length !== assignments.length) {
    throw new TypeError("Native-adapter transition profile is partially settled");
  }
  const settled = existingOutcomes.length === assignments.length;
  const outcomes = capabilityIds.map((capabilityId) => {
    const descriptor = CAPABILITY_BY_ID.get(capabilityId);
    if (!descriptor) throw new TypeError(`Native adapter ${capabilityId} disappeared`);
    return Object.freeze({
      capabilityId,
      descriptorDigest: descriptor.digest,
      outcome: "passed" as const,
      evidenceRefs: Object.freeze(adapterEvidence(capabilityId, input.transition, operationDigest)),
    });
  });
  if (settled) {
    const existingByCapability = new Map(existingOutcomes.map((receipt) => [receipt.capabilityId, receipt]));
    for (const outcome of outcomes) {
      const existingOutcome = existingByCapability.get(outcome.capabilityId);
      if (!existingOutcome || existingOutcome.descriptorDigest !== outcome.descriptorDigest ||
        existingOutcome.outcome !== outcome.outcome ||
        JSON.stringify(existingOutcome.evidenceRefs) !== JSON.stringify(outcome.evidenceRefs)) {
        throw new TypeError(`Persisted native-adapter outcome changed for ${outcome.capabilityId}`);
      }
    }
  }
  return Object.freeze({
    profileId: profile.id,
    profileRevision: profile.revision,
    transition: input.transition,
    operationDigest,
    settled,
    outcomes: Object.freeze(outcomes),
  });
}

export function nativeAdapterEnvelopeWithOutcome(
  prepared: NativeAdapterTransitionEnvelope,
  outcome: CapabilityTerminalOutcome,
): NativeAdapterTransitionEnvelope {
  return Object.freeze({
    ...prepared,
    settled: false,
    outcomes: Object.freeze(prepared.outcomes.map((entry) => Object.freeze({
      ...entry,
      outcome: entry.capabilityId === "hanoon-native-using-superpowers" ? "passed" : outcome,
    }))),
  });
}

export function validateNativeAdapterTransition(input: Readonly<{
  job: Job;
  event: JobEvent;
  envelope: NativeAdapterTransitionEnvelope | undefined;
  profile: CapabilityProfile | null;
}>): NativeAdapterTransitionEnvelope | null {
  const requirement = nativeAdapterRequirementForEvent(input.job, input.event);
  if (!requirement) {
    if (input.envelope !== undefined) {
      throw new TypeError("Legacy, shadow, or unrelated transitions cannot persist native-adapter outcomes");
    }
    return null;
  }
  const envelope = input.envelope;
  if (!envelope) return null;
  if (envelope.settled || !/^[0-9a-f]{64}$/u.test(envelope.operationDigest)) {
    throw new TypeError("Native-adapter transition envelope is already settled or has invalid operation identity");
  }
  const profile = input.profile;
  if (!profile || profile.id !== envelope.profileId || profile.revision !== envelope.profileRevision ||
    profile.subjectKind !== "worker_attempt" ||
    profile.subjectId !== transitionSubjectId(input.job, requirement.transition, envelope.operationDigest) ||
    profile.recipeId !== input.job.taskRecipe || profile.recipeVersion !== input.job.recipeVersion ||
    profile.registryDigest !== CAPABILITY_REGISTRY_DIGEST || profile.graphDigest !== CAPABILITY_GRAPH_DIGEST ||
    profile.mode !== "active" || envelope.transition !== requirement.transition) {
    throw new TypeError("Native-adapter transition profile does not match the authoritative job transition");
  }
  const expectedIds = [...requirement.capabilityIds].sort((left, right) => left.localeCompare(right));
  const assignments = [...profile.assignments].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  const outcomes = [...envelope.outcomes].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  if (assignments.length !== expectedIds.length || outcomes.length !== expectedIds.length ||
    new Set(outcomes.map((entry) => entry.capabilityId)).size !== outcomes.length) {
    throw new TypeError("Native-adapter transition must settle every mandatory selected adapter exactly once");
  }
  for (let index = 0; index < expectedIds.length; index += 1) {
    const capabilityId = expectedIds[index];
    const assignment = assignments[index];
    const outcome = outcomes[index];
    const descriptor = CAPABILITY_BY_ID.get(capabilityId);
    const outcomeAccepted = capabilityId === "hanoon-native-using-superpowers"
      ? outcome?.outcome === "passed"
      : outcome !== undefined && requirement.acceptedOutcomes.includes(outcome.outcome);
    if (!descriptor || descriptor.kind !== "native-adapter" || descriptor.route !== "hanoon-native" ||
      !assignment || assignment.capabilityId !== capabilityId || assignment.capabilityKind !== "native-adapter" ||
      !assignment.mandatory || assignment.descriptorDigest !== descriptor.digest ||
      !outcome || outcome.capabilityId !== capabilityId || outcome.descriptorDigest !== descriptor.digest ||
      !outcomeAccepted) {
      throw new TypeError(`Native-adapter outcome does not match exact assignment ${capabilityId}`);
    }
    const requiredEvidence = adapterEvidence(capabilityId, requirement.transition, envelope.operationDigest);
    if (requiredEvidence.some((reference) => !outcome.evidenceRefs.includes(reference)) ||
      outcome.evidenceRefs.length !== requiredEvidence.length) {
      throw new TypeError(`Native-adapter outcome evidence is incomplete for ${capabilityId}`);
    }
  }
  return envelope;
}
