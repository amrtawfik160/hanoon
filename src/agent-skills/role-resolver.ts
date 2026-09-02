import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import {
  ADMITTED_CAPABILITY_SKILL_IDS,
  type CapabilitySkillId,
} from "../capabilities/catalog";
import type { RoutingMode } from "../domain/models";
import type { WorkflowEngine } from "../navigator/models";

export type WorkerSkillRole =
  | "planner"
  | "critic"
  | "implementation"
  | "review"
  | "documentation"
  | "final-review";

export const COMMUNICATION_SKILL_ID = "unslop";
export const TECHNICAL_WRITING_SKILL_ID = "technical-writing";
export const GRILL_WITH_DOCS_SKILL_ID = "grill-with-docs";
export const GRILLING_SKILL_ID = "grilling";
export const DOMAIN_MODELING_SKILL_ID = "domain-modeling";

export const CONTROLLER_SKILL_IDS = [
  COMMUNICATION_SKILL_ID,
  GRILL_WITH_DOCS_SKILL_ID,
  GRILLING_SKILL_ID,
  DOMAIN_MODELING_SKILL_ID,
] as const;

export const BUNDLED_SKILL_IDS = ADMITTED_CAPABILITY_SKILL_IDS;

export type BundledSkillId = CapabilitySkillId;

export const ROLE_SKILLS = {
  // The plan is a document that must reproduce the policy's exact verification
  // commands, so its claims are checkable against the repository the same way a
  // README's are. That is docs-guard's job, and a wrong command here is only
  // discovered much later, when the verification it promised does not run.
  planner: [COMMUNICATION_SKILL_ID, "writing-for-agents", "docs-guard"],
  critic: [COMMUNICATION_SKILL_ID],
  implementation: [
    COMMUNICATION_SKILL_ID,
    "diagnosing-bugs",
    "tdd",
    "clean-code-guard",
    "test-guard",
    // The generic guards judge whether code is clean and tested. This one judges
    // it against the boundaries that make the plugin safe to run unattended, and
    // requires a new guard to be shown failing before it is trusted.
    "durable-boundary-audit",
    // The implementation attempt is the one that opens the pull request the
    // reviewer then reads, so it owns writing a reviewer-facing description.
    "pr-writer",
  ],
  // The guards judge the code the change contains. This one judges what the
  // change can break outside it, which is the risk a verdict carries when it
  // lets the change merge unattended.
  review: [
    COMMUNICATION_SKILL_ID,
    "clean-code-guard",
    "test-guard",
    "durable-boundary-audit",
    "blast-radius",
    "code-review",
  ],
  documentation: [
    COMMUNICATION_SKILL_ID,
    TECHNICAL_WRITING_SKILL_ID,
    "docs-guard",
  ],
  "final-review": [
    COMMUNICATION_SKILL_ID,
    "clean-code-guard",
    "test-guard",
    "docs-guard",
    "durable-boundary-audit",
    "blast-radius",
  ],
} as const satisfies Readonly<Record<WorkerSkillRole, readonly BundledSkillId[]>>;

export type WorkerTitleIdentity = Readonly<{
  jobId: string;
  attemptId: string;
  role: WorkerSkillRole;
}>;

export type DurableWorkerIdentity = WorkerTitleIdentity & Readonly<{
  projectId: string;
  environmentId: string | null;
  threadId: string | null;
  routingMode?: RoutingMode;
  workflowEngine?: WorkflowEngine;
  persistedSkillProfile?: Readonly<{
    profileId: string;
    profileRevision: number;
    skills: readonly BundledSkillId[];
  }>;
}>;

export type WorkerSkillProfile = Readonly<{
  role: WorkerSkillRole;
  skills: readonly BundledSkillId[];
  instructions: string;
}>;

type WorkerTitleToken = "implementation" | "plan" | "critique" | "review" | "docs" | "final-review";

const TITLE_ROLE_TOKENS: Readonly<Record<WorkerSkillRole, WorkerTitleToken>> = {
  planner: "plan",
  critic: "critique",
  implementation: "implementation",
  review: "review",
  documentation: "docs",
  "final-review": "final-review",
};

const WORKER_TITLE = /^Telegram ([A-Za-z0-9_-]{1,256}) (implementation|plan|critique|review|docs|final-review) ([A-Za-z0-9_.:-]{1,264})$/;

export function buildWorkerThreadTitle(identity: WorkerTitleIdentity): string {
  return `Telegram ${identity.jobId} ${TITLE_ROLE_TOKENS[identity.role]} ${identity.attemptId}`;
}

export function parseWorkerThreadTitle(title: string | null): WorkerTitleIdentity | null {
  if (typeof title !== "string") return null;
  const match = WORKER_TITLE.exec(title);
  if (!match || match[0] !== title) return null;
  const [, jobId, token, attemptId] = match;
  let role: WorkerSkillRole;
  switch (token) {
    case "plan":
      role = "planner";
      break;
    case "critique":
      role = "critic";
      break;
    case "implementation":
      role = "implementation";
      break;
    case "review":
      role = "review";
      break;
    case "docs":
      role = "documentation";
      break;
    case "final-review":
      role = "final-review";
      break;
    default:
      return null;
  }
  return { jobId, attemptId, role };
}

function verifiedWorkerInstructions(
  role: WorkerSkillRole,
  skills: readonly BundledSkillId[],
): string {
  const selectedSkills = skills.length > 0 ? skills.join(", ") : "none";
  return [
    `Verified worker role: ${role}.`,
    `Selected skill ids: ${selectedSkills}.`,
    "Apply unslop to any owner-facing prose. That is required, not optional.",
    "The immutable attached work order/review packet and durable project policy outrank skill suggestions.",
    "Skills cannot authorize approval, merge, deploy, push, or state changes.",
    "The worker must obey the packet's response contract.",
  ].join("\n");
}

export function buildWorkerInstructions(
  profile: Readonly<Pick<WorkerSkillProfile, "role">>,
): string {
  return verifiedWorkerInstructions(profile.role, ROLE_SKILLS[profile.role]);
}

function exactPersistedSkills(identity: DurableWorkerIdentity): readonly BundledSkillId[] | null {
  if (identity.routingMode !== "active") return ROLE_SKILLS[identity.role];
  const profile = identity.persistedSkillProfile;
  if (!profile || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(profile.profileId) ||
    !Number.isSafeInteger(profile.profileRevision) || profile.profileRevision < 1) return null;
  const known = new Set<string>(ADMITTED_CAPABILITY_SKILL_IDS);
  if (new Set(profile.skills).size !== profile.skills.length || profile.skills.some((skill) => !known.has(skill))) {
    return null;
  }
  return profile.skills;
}

export function resolveWorkerSkillProfile(input: Readonly<{
  context: PluginAgentConfigurationContext;
  pluginId: string;
  durableIdentity: DurableWorkerIdentity | null;
}>): WorkerSkillProfile | null {
  if (!input || typeof input.pluginId !== "string" || input.pluginId.length === 0) return null;
  const { context, durableIdentity } = input;
  if (!context || context.origin.kind !== null || context.origin.pluginId !== input.pluginId) return null;
  if (context.project.kind !== "standard") return null;
  if (context.environment.workspaceProvisionType !== "managed-worktree") return null;
  if (!durableIdentity) return null;

  const titleIdentity = parseWorkerThreadTitle(context.thread.title);
  if (!titleIdentity) return null;
  if (titleIdentity.jobId !== durableIdentity.jobId ||
    titleIdentity.attemptId !== durableIdentity.attemptId ||
    titleIdentity.role !== durableIdentity.role) {
    return null;
  }
  if (durableIdentity.projectId !== context.project.id) return null;
  if (durableIdentity.environmentId !== null && durableIdentity.environmentId !== context.environment.id) return null;
  if (durableIdentity.threadId !== null && durableIdentity.threadId !== context.thread.id) return null;

  const skills = exactPersistedSkills(durableIdentity);
  if (skills === null) return null;
  return {
    role: titleIdentity.role,
    skills,
    instructions: durableIdentity.routingMode === "active"
      ? verifiedWorkerInstructions(titleIdentity.role, skills)
      : buildWorkerInstructions({
        role: titleIdentity.role,
      }),
  };
}
