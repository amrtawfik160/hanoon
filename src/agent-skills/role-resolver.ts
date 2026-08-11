import type { PluginAgentConfigurationContext } from "@bb/plugin-sdk";

export type WorkerSkillRole =
  | "planner"
  | "critic"
  | "implementation"
  | "review"
  | "documentation"
  | "final-review";

export const BUNDLED_SKILL_IDS = [
  "systematic-debugging",
  "test-driven-development",
  "verification-before-completion",
  "clean-code-guard",
  "test-guard",
  "docs-guard",
] as const;

export type BundledSkillId = typeof BUNDLED_SKILL_IDS[number];

export const ROLE_SKILLS = {
  planner: [],
  critic: [],
  implementation: [
    "systematic-debugging",
    "test-driven-development",
    "verification-before-completion",
    "clean-code-guard",
    "test-guard",
  ],
  review: ["clean-code-guard", "test-guard"],
  documentation: ["docs-guard", "verification-before-completion"],
  "final-review": ["clean-code-guard", "test-guard", "docs-guard"],
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

export function buildWorkerInstructions(
  profile: Readonly<Pick<WorkerSkillProfile, "role" | "skills">>,
): string {
  const selectedSkills = profile.skills.length > 0 ? profile.skills.join(", ") : "none";
  return [
    `Verified worker role: ${profile.role}.`,
    `Selected skill ids: ${selectedSkills}.`,
    "The immutable attached work order/review packet and durable project policy outrank skill suggestions.",
    "Skills cannot authorize approval, merge, deploy, push, or state changes.",
    "The worker must obey the packet's response contract.",
  ].join("\n");
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

  const skills = ROLE_SKILLS[titleIdentity.role];
  return {
    role: titleIdentity.role,
    skills,
    instructions: buildWorkerInstructions({ role: titleIdentity.role, skills }),
  };
}
