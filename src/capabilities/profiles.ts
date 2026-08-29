import { createHash } from "node:crypto";
import { ROLE_SKILLS, type WorkerSkillRole } from "../agent-skills/role-resolver";
import type { TaskRecipe } from "../domain/recipes";
import {
  CAPABILITY_BY_ID,
  HISTORICAL_RECIPE_CAPABILITY_BY_ID,
  HISTORICAL_RECIPE_CAPABILITY_CATALOG,
  capabilityDescriptorById,
  type CapabilitySkillId,
} from "./catalog";
import type { CapabilityDescriptor, CapabilityRoute } from "./contracts";

export const WORKER_PROFILE_STAGES = [
  "discovery",
  "planning",
  "implementation",
  "remediation",
  "review",
  "task-review",
  "integrated-review",
  "documentation",
  "delivery",
] as const;

export type WorkerProfileStage = typeof WORKER_PROFILE_STAGES[number];

export type CapabilityProfileAssignment = Readonly<{
  capabilityId: CapabilitySkillId;
  descriptorDigest: string;
  route: CapabilityRoute;
  mandatory: boolean;
}>;

export type CapabilityDenial = Readonly<{
  capabilityId: string;
  reasonCode: string;
}>;

export type SelectedCapabilityProfile = Readonly<{
  role: WorkerSkillRole;
  recipe: TaskRecipe;
  stage: WorkerProfileStage;
  skills: readonly CapabilitySkillId[];
  assignments: readonly CapabilityProfileAssignment[];
  denied: readonly CapabilityDenial[];
  digest: string;
}>;

export type CapabilityProfileSelectionInput = Readonly<{
  role: WorkerSkillRole;
  recipe: TaskRecipe;
  stage: WorkerProfileStage;
  traits: readonly string[];
  requestedCapabilities?: readonly string[];
}>;

export type PersistedWorkerCapabilityProfile = Readonly<{
  profileId: string;
  revision: number;
  recipeVersion: number;
  role: WorkerSkillRole;
  jobId: string;
  attemptId: string;
  projectId: string;
  environmentId: string | null;
  threadId: string | null;
  assignments: readonly CapabilityProfileAssignment[];
}>;

type ExpectedWorkerProfileIdentity = Omit<PersistedWorkerCapabilityProfile, "assignments">;

const BOUNDED_KEY = /^[a-z][a-z0-9._:-]{0,127}$/u;
const PROFILE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;

function desiredCapabilities(input: CapabilityProfileSelectionInput, traits: ReadonlySet<string>): Set<string> {
  const desired = new Set<string>();
  if (input.role === "planner" && input.stage === "discovery" && input.recipe === "architectural") {
    if (traits.has("needs-discovery") && !traits.has("grilled")) desired.add("brainstorming");
  }
  if (input.role === "planner" && input.stage === "planning" && input.recipe === "architectural") {
    desired.add("writing-plans");
  }
  if (input.role === "implementation") {
    if (input.stage === "implementation") {
      if (input.recipe === "bug") desired.add("systematic-debugging");
      if (traits.has("behavioral-change") || input.recipe === "skill-authoring") {
        desired.add("test-driven-development");
      }
      if (input.recipe === "skill-authoring") desired.add("writing-skills");
      desired.add("verification-before-completion");
    }
    if (input.stage === "remediation") {
      desired.add("receiving-code-review");
      if (traits.has("behavioral-change")) desired.add("test-driven-development");
      desired.add("verification-before-completion");
    }
    if (input.stage === "delivery") {
      desired.add("verification-before-completion");
      if (traits.has("nontrivial-diff")) desired.add("pr-writer");
    }
  }
  if (input.role === "documentation" && input.stage === "documentation" && traits.has("docs-changed")) {
    desired.add("docs-guard");
    desired.add("verification-before-completion");
  }
  if ((input.role === "review" || input.role === "final-review") && [
    "review", "task-review", "integrated-review",
  ].includes(input.stage) && !traits.has("risk-lens")) {
    if (traits.has("code-changed")) desired.add("clean-code-guard");
    if (traits.has("tests-changed")) desired.add("test-guard");
    if (traits.has("docs-changed")) desired.add("docs-guard");
  }
  for (const requested of input.requestedCapabilities ?? []) desired.add(requested);
  return desired;
}

function addDenial(denied: Map<string, string>, capabilityId: string, reasonCode: string): void {
  if (!denied.has(capabilityId)) denied.set(capabilityId, reasonCode);
}

function stageEligible(descriptor: CapabilityDescriptor, stage: WorkerProfileStage): boolean {
  return descriptor.routing.stages.includes(stage) ||
    (stage === "review" && descriptor.routing.stages.includes("diff-guards"));
}

function validateInput(input: CapabilityProfileSelectionInput): ReadonlySet<string> {
  if (!input || !WORKER_PROFILE_STAGES.includes(input.stage)) throw new TypeError("Unknown worker profile stage");
  if (input.traits.length > 64 || new Set(input.traits).size !== input.traits.length) {
    throw new TypeError("Worker profile traits must be a bounded unique set");
  }
  for (const trait of input.traits) {
    if (!BOUNDED_KEY.test(trait)) throw new TypeError(`Invalid worker profile trait ${trait}`);
  }
  if ((input.requestedCapabilities?.length ?? 0) > 32) {
    throw new TypeError("Requested capabilities exceed their bounded limit");
  }
  return new Set(input.traits);
}

function topologicalSkills(selected: ReadonlyMap<string, CapabilityDescriptor>): CapabilitySkillId[] {
  const temporary = new Set<string>();
  const permanent = new Set<string>();
  const result: CapabilitySkillId[] = [];
  const visit = (id: string): void => {
    if (permanent.has(id)) return;
    if (temporary.has(id)) throw new TypeError(`Selected worker capabilities contain an ordering cycle at ${id}`);
    temporary.add(id);
    const descriptor = selected.get(id);
    if (!descriptor) return;
    for (const prior of [
      ...descriptor.composition.prerequisites,
      ...descriptor.composition.orderAfter,
    ].sort((left, right) => left.localeCompare(right))) {
      if (selected.has(prior)) visit(prior);
    }
    temporary.delete(id);
    permanent.add(id);
    result.push(id as CapabilitySkillId);
  };
  for (const id of [...selected.keys()].sort((left, right) => left.localeCompare(right))) visit(id);
  return result;
}

export function capabilityProfileDigest(
  assignments: readonly Readonly<{
    capabilityId: string;
    descriptorDigest: string;
    mandatory: boolean;
  }>[],
): string {
  const canonical = assignments
    .map(({ capabilityId, descriptorDigest, mandatory }) => ({
      capabilityId,
      descriptorDigest,
      mandatory,
    }))
    .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function selectCapabilityProfile(input: CapabilityProfileSelectionInput): SelectedCapabilityProfile {
  const traits = validateInput(input);
  const desired = desiredCapabilities(input, traits);
  const denied = new Map<string, string>();
  const selected = new Map<string, CapabilityDescriptor>();

  for (const capabilityId of [...desired].sort((left, right) => left.localeCompare(right))) {
    const descriptor = HISTORICAL_RECIPE_CAPABILITY_BY_ID.get(capabilityId);
    if (!descriptor || descriptor.kind !== "skill") {
      addDenial(denied, capabilityId, "unknown_capability");
      continue;
    }
    if (descriptor.route !== "worker") {
      addDenial(denied, capabilityId, "route_not_worker");
      continue;
    }
    if (!descriptor.routing.roles.includes(input.role)) {
      addDenial(denied, capabilityId, "role_ineligible");
      continue;
    }
    if (!descriptor.routing.recipes.includes(input.recipe)) {
      addDenial(denied, capabilityId, "recipe_ineligible");
      continue;
    }
    if (!stageEligible(descriptor, input.stage)) {
      addDenial(denied, capabilityId, "stage_ineligible");
      continue;
    }
    if (capabilityId === "brainstorming" && traits.has("grilled")) {
      addDenial(denied, capabilityId, "completed_grill");
      continue;
    }
    if (capabilityId === "writing-skills" && !traits.has("baseline-proven")) {
      addDenial(denied, capabilityId, "baseline_evidence_missing");
      continue;
    }
    const missingTrait = descriptor.routing.requiredTraits.find((trait) => !traits.has(trait));
    if (missingTrait && !(capabilityId === "test-driven-development" && input.recipe === "skill-authoring")) {
      addDenial(denied, capabilityId, "required_trait_missing");
      continue;
    }
    if (descriptor.routing.forbiddenTraits.some((trait) => traits.has(trait))) {
      addDenial(denied, capabilityId, "forbidden_trait_present");
      continue;
    }
    const conflict = descriptor.composition.conflicts.find((id) => selected.has(id));
    if (conflict) {
      addDenial(denied, capabilityId, "capability_conflict");
      continue;
    }
    selected.set(capabilityId, descriptor);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [capabilityId, descriptor] of selected) {
      const missing = descriptor.composition.prerequisites.find((id) => !selected.has(id));
      if (!missing) continue;
      selected.delete(capabilityId);
      addDenial(denied, capabilityId, "prerequisite_missing");
      changed = true;
    }
  }

  const skills = topologicalSkills(selected);
  const assignments = skills.map((capabilityId): CapabilityProfileAssignment => {
    const descriptor = selected.get(capabilityId);
    if (!descriptor) throw new Error(`Selected capability ${capabilityId} disappeared`);
    return {
      capabilityId,
      descriptorDigest: descriptor.digest,
      route: descriptor.route,
      mandatory: descriptor.evidence.requirement === "mandatory",
    };
  });
  return {
    role: input.role,
    recipe: input.recipe,
    stage: input.stage,
    skills,
    assignments,
    denied: [...denied.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([capabilityId, reasonCode]) => ({ capabilityId, reasonCode })),
    digest: capabilityProfileDigest(assignments),
  };
}

export function selectWorkerCapabilityProfile(input: CapabilityProfileSelectionInput & {
  engine: "recipe-v1" | "navigator-v1";
}): SelectedCapabilityProfile {
  if (input.engine === "recipe-v1") return selectCapabilityProfile(input);
  const selected = new Map<string, CapabilityDescriptor>();
  for (const capabilityId of ROLE_SKILLS[input.role]) {
    const descriptor = CAPABILITY_BY_ID.get(capabilityId);
    if (!descriptor || descriptor.kind !== "skill") {
      throw new TypeError(`Navigator worker role ${input.role} references unknown skill ${capabilityId}`);
    }
    selected.set(capabilityId, descriptor);
  }
  const skills = [...ROLE_SKILLS[input.role]];
  const assignments = skills.map((capabilityId): CapabilityProfileAssignment => {
    const descriptor = selected.get(capabilityId);
    if (!descriptor) throw new Error(`Selected capability ${capabilityId} disappeared`);
    return {
      capabilityId,
      descriptorDigest: descriptor.digest,
      route: descriptor.route,
      mandatory: descriptor.evidence.requirement === "mandatory",
    };
  });
  return {
    role: input.role,
    recipe: input.recipe,
    stage: input.stage,
    skills,
    assignments,
    denied: [],
    digest: capabilityProfileDigest(assignments),
  };
}

function sameIdentity(
  persisted: PersistedWorkerCapabilityProfile,
  expected: ExpectedWorkerProfileIdentity,
): boolean {
  return persisted.profileId === expected.profileId &&
    persisted.revision === expected.revision &&
    persisted.recipeVersion === expected.recipeVersion &&
    persisted.role === expected.role &&
    persisted.jobId === expected.jobId &&
    persisted.attemptId === expected.attemptId &&
    persisted.projectId === expected.projectId &&
    persisted.environmentId === expected.environmentId &&
    persisted.threadId === expected.threadId;
}

export function resolvePersistedWorkerProfile(input: Readonly<{
  persisted: PersistedWorkerCapabilityProfile | null;
  expected: ExpectedWorkerProfileIdentity;
}>): Readonly<{ skills: readonly CapabilitySkillId[]; assignments: readonly CapabilityProfileAssignment[] }> | null {
  if (!input.persisted || !sameIdentity(input.persisted, input.expected)) return null;
  if (!PROFILE_ID.test(input.persisted.profileId) || input.persisted.revision < 1 || input.persisted.recipeVersion < 1) {
    return null;
  }
  const seen = new Set<string>();
  for (const assignment of input.persisted.assignments) {
    if (seen.has(assignment.capabilityId) || assignment.route !== "worker") return null;
    seen.add(assignment.capabilityId);
    const descriptor = capabilityDescriptorById(assignment.capabilityId, assignment.descriptorDigest);
    if (!descriptor || descriptor.kind !== "skill" || descriptor.route !== "worker" ||
      descriptor.digest !== assignment.descriptorDigest ||
      (descriptor.evidence.requirement === "mandatory") !== assignment.mandatory) {
      return null;
    }
  }
  return {
    skills: input.persisted.assignments.map((assignment) => assignment.capabilityId),
    assignments: input.persisted.assignments,
  };
}

export const WORKER_SKILL_DESCRIPTORS = Object.freeze(
  HISTORICAL_RECIPE_CAPABILITY_CATALOG.filter((descriptor) => descriptor.kind === "skill" && descriptor.route === "worker"),
);
