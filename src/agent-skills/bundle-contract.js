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
export const DELIVERY_ROOT = "skills/delivery";
export const DISCOVERY_ROOT = "skills/discovery";
export const HANOON_ROOT = "skills/hanoon";
export const LOCK_PATH = "skills/skills.lock.json";
export const REGISTERED_ROOTS = Object.freeze([
  WORKFLOW_ROOT,
  GUARDS_ROOT,
  DELIVERY_ROOT,
  DISCOVERY_ROOT,
  HANOON_ROOT,
]);

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
const deliverySkillIds = ["pr-writer"];
const discoverySkillIds = ["domain-modeling", "grill-with-docs", "grilling"];
const hanoonSkillIds = ["human-friendly-coding-communication", "proportional-development-workflow"];

export const WORKFLOW_KIT = Object.freeze({
  version: "6.3.0",
  sourceUrl: "https://github.com/obra/superpowers",
  license: "MIT",
  licensePath: `${WORKFLOW_ROOT}/LICENSE`,
});

// Guards are vendored verbatim from an MIT-licensed upstream, so the bundle
// carries that licence alongside them rather than claiming them as its own.
export const GUARD_KIT = Object.freeze({
  sourceUrl: "https://github.com/amElnagdy/guard-skills",
  license: "MIT",
  licensePath: `${GUARDS_ROOT}/LICENSE`,
});

// Apache-2.0 rather than MIT, so it is licensed and attributed separately: the
// bundle must ship the Apache text, not fold it under another root's notice.
export const DELIVERY_KIT = Object.freeze({
  sourceUrl: "https://github.com/getsentry/skills",
  license: "Apache-2.0",
  licensePath: `${DELIVERY_ROOT}/LICENSE`,
});

export const DISCOVERY_KIT = Object.freeze({
  version: "1.2.3",
  revision: "84fdeffd12f2ee307994d1eb6feb48173b6e0502",
  sourceUrl: "https://github.com/mattpocock/skills",
  license: "MIT",
  licensePath: `${DISCOVERY_ROOT}/LICENSE`,
});

export const WORKFLOW_PROVENANCE = Object.freeze({
  source: WORKFLOW_KIT.sourceUrl,
  license: WORKFLOW_KIT.license,
});
export const GUARD_PROVENANCE = Object.freeze({
  source: GUARD_KIT.sourceUrl,
  license: GUARD_KIT.license,
});
export const DELIVERY_PROVENANCE = Object.freeze({
  source: DELIVERY_KIT.sourceUrl,
  license: DELIVERY_KIT.license,
});
export const DISCOVERY_PROVENANCE = Object.freeze({
  source: DISCOVERY_KIT.sourceUrl,
  license: DISCOVERY_KIT.license,
});

// First-party Hanoon guidance, not a vendored upstream copy.
export const HANOON_KIT = Object.freeze({
  sourceUrl: "first-party",
  license: "first-party",
  licensePath: `${HANOON_ROOT}/NOTICE`,
});
export const HANOON_PROVENANCE = Object.freeze({
  source: HANOON_KIT.sourceUrl,
  license: HANOON_KIT.license,
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

export const REQUIRED_DELIVERY_SKILLS = Object.freeze(deliverySkillIds.map((id) => Object.freeze({
  id,
  skillPath: `${DELIVERY_ROOT}/${id}/SKILL.md`,
  ...DELIVERY_PROVENANCE,
})));

export const REQUIRED_DISCOVERY_SKILLS = Object.freeze(discoverySkillIds.map((id) => Object.freeze({
  id,
  skillPath: `${DISCOVERY_ROOT}/${id}/SKILL.md`,
  ...DISCOVERY_PROVENANCE,
})));

export const REQUIRED_HANOON_SKILLS = Object.freeze(hanoonSkillIds.map((id) => Object.freeze({
  id,
  skillPath: `${HANOON_ROOT}/${id}/SKILL.md`,
  ...HANOON_PROVENANCE,
})));

export const REQUIRED_SKILLS = Object.freeze([
  ...REQUIRED_WORKFLOW_SKILLS,
  ...REQUIRED_GUARD_SKILLS,
  ...REQUIRED_DELIVERY_SKILLS,
  ...REQUIRED_DISCOVERY_SKILLS,
  ...REQUIRED_HANOON_SKILLS,
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
