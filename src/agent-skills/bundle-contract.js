export const BUNDLE_LIMITS = Object.freeze({
  maximumFileBytes: 256 * 1024,
  maximumLockBytes: 1024 * 1024,
  maximumSkills: 64,
  maximumLockedFiles: 512,
  maximumMarkdownLinks: 128,
  maximumFrontmatterBytes: 8 * 1024,
  maximumSkillIdCharacters: 128,
  maximumTreeEntries: 640,
  maximumTreeDepth: 32,
});

export const LOCK_SCHEMA_VERSION = 1;
export const SKILL_ID_PATTERN = new RegExp(
  `^[a-z][a-z0-9-]{0,${BUNDLE_LIMITS.maximumSkillIdCharacters - 1}}$`,
);

export const WORKFLOW_ROOT = "skills/workflow-kit";
export const GUARDS_ROOT = "skills/guards";
export const LOCK_PATH = "skills/skills.lock.json";
export const REGISTERED_ROOTS = Object.freeze([WORKFLOW_ROOT, GUARDS_ROOT]);

const workflowSkillIds = [
  "brainstorming",
  "dispatching-parallel-agents",
  "executing-plans",
  "finishing-a-development-branch",
  "receiving-code-review",
  "requesting-code-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "using-git-worktrees",
  "using-superpowers",
  "verification-before-completion",
  "writing-plans",
  "writing-skills",
];
const guardSkillIds = ["clean-code-guard", "docs-guard", "test-guard"];

export const WORKFLOW_KIT = Object.freeze({
  version: "6.2.0",
  sourceUrl: "https://github.com/obra/superpowers",
  license: "MIT",
  licensePath: `${WORKFLOW_ROOT}/LICENSE`,
});

export const WORKFLOW_PROVENANCE = Object.freeze({
  source: WORKFLOW_KIT.sourceUrl,
  license: WORKFLOW_KIT.license,
});
export const GUARD_PROVENANCE = Object.freeze({
  source: "project-owned",
  license: "repository",
});

export const REQUIRED_WORKFLOW_SKILLS = Object.freeze(workflowSkillIds.map((id) => Object.freeze({
  id,
  skillPath: `${WORKFLOW_ROOT}/${id}/SKILL.md`,
  ...WORKFLOW_PROVENANCE,
})));

export const REQUIRED_GUARD_SKILLS = Object.freeze(guardSkillIds.map((id) => Object.freeze({
  id,
  skillPath: `${GUARDS_ROOT}/${id}/SKILL.md`,
  ...GUARD_PROVENANCE,
})));

export const REQUIRED_SKILLS = Object.freeze([
  ...REQUIRED_WORKFLOW_SKILLS,
  ...REQUIRED_GUARD_SKILLS,
]);

export const SYNC_EXCLUDED_SEGMENTS = Object.freeze([
  ".git",
  ".cache",
  "cache",
  "caches",
  "node_modules",
  "coverage",
  "dist",
  "build",
  "out",
  "output",
]);
export const SYNC_EXCLUDED_FILES = Object.freeze([".DS_Store", "Thumbs.db"]);
