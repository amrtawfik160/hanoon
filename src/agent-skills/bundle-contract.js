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

export const LOCK_SCHEMA_VERSION = 2;
export const SKILL_ID_PATTERN = new RegExp(
  `^[a-z][a-z0-9-]{0,${BUNDLE_LIMITS.maximumSkillIdCharacters - 1}}$`,
);
export const FORBIDDEN_SKILL_ID_PATTERN = /^do-/u;

export const WORKFLOW_ROOT = "skills/workflow-kit";
export const GUARDS_ROOT = "skills/guards";
export const DELIVERY_ROOT = "skills/delivery";
export const DISCOVERY_ROOT = "skills/discovery";
export const MATT_POCOCK_ROOT = "skills/matt-pocock";
export const MATT_POCOCK_ENGINEERING_ROOT = `${MATT_POCOCK_ROOT}/engineering`;
export const MATT_POCOCK_PRODUCTIVITY_ROOT = `${MATT_POCOCK_ROOT}/productivity`;
export const HANOON_ROOT = "skills/hanoon";
export const PSTACK_ROOT = "skills/pstack";
export const HUMANLAYER_ROOT = "skills/humanlayer";
export const LOCK_PATH = "skills/skills.lock.json";

// BB discovers only immediate child skill directories. The contracted bundle
// registers the reviewed Matt Pocock buckets plus retained first-party roots.
export const REGISTERED_ROOTS = Object.freeze([
  GUARDS_ROOT,
  DELIVERY_ROOT,
  MATT_POCOCK_ENGINEERING_ROOT,
  MATT_POCOCK_PRODUCTIVITY_ROOT,
  HANOON_ROOT,
  PSTACK_ROOT,
  HUMANLAYER_ROOT,
]);

export const LOCKED_ROOTS = Object.freeze([
  GUARDS_ROOT,
  DELIVERY_ROOT,
  MATT_POCOCK_ROOT,
  HANOON_ROOT,
  PSTACK_ROOT,
  HUMANLAYER_ROOT,
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
const retainedHanoonSkillIds = [
  "blast-radius",
  "checking-system-logs",
  "driving-bb",
  "durable-boundary-audit",
];
const hanoonSkillIds = [...retainedHanoonSkillIds];
const pstackSkillIds = ["technical-writing", "unslop"];
const humanlayerSkillIds = ["show-me"];

const promotedMattSkills = [
  { bucket: "engineering", id: "ask-matt", invocationClass: "user" },
  { bucket: "engineering", id: "diagnosing-bugs", invocationClass: "model" },
  { bucket: "engineering", id: "grill-with-docs", invocationClass: "user" },
  { bucket: "engineering", id: "triage", invocationClass: "user" },
  { bucket: "engineering", id: "improve-codebase-architecture", invocationClass: "user" },
  { bucket: "engineering", id: "setup-matt-pocock-skills", invocationClass: "user" },
  { bucket: "engineering", id: "tdd", invocationClass: "model" },
  { bucket: "engineering", id: "to-spec", invocationClass: "user" },
  { bucket: "engineering", id: "to-tickets", invocationClass: "user" },
  { bucket: "engineering", id: "wayfinder", invocationClass: "user" },
  { bucket: "engineering", id: "implement", invocationClass: "user" },
  { bucket: "engineering", id: "prototype", invocationClass: "model" },
  { bucket: "engineering", id: "research", invocationClass: "model" },
  { bucket: "engineering", id: "domain-modeling", invocationClass: "model" },
  { bucket: "engineering", id: "codebase-design", invocationClass: "model" },
  { bucket: "engineering", id: "code-review", invocationClass: "model" },
  { bucket: "engineering", id: "resolving-merge-conflicts", invocationClass: "model" },
  { bucket: "engineering", id: "wizard", invocationClass: "model" },
  { bucket: "productivity", id: "grill-me", invocationClass: "user" },
  { bucket: "productivity", id: "grilling", invocationClass: "model" },
  { bucket: "productivity", id: "handoff", invocationClass: "user" },
  { bucket: "productivity", id: "teach", invocationClass: "user" },
  { bucket: "productivity", id: "to-questionnaire", invocationClass: "user" },
  { bucket: "productivity", id: "wait-what", invocationClass: "user" },
  { bucket: "productivity", id: "writing-for-agents", invocationClass: "model" },
];

export const WORKFLOW_KIT = Object.freeze({
  version: "6.3.0",
  sourceUrl: "https://github.com/obra/superpowers",
  license: "MIT",
  licensePath: `${WORKFLOW_ROOT}/LICENSE`,
});

export const GUARD_KIT = Object.freeze({
  sourceUrl: "https://github.com/amElnagdy/guard-skills",
  license: "MIT",
  licensePath: `${GUARDS_ROOT}/LICENSE`,
});

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

export const MATT_POCOCK_KIT = Object.freeze({
  version: "1.2.3",
  revision: "6654f6b60cd9d5be8b54c6fafe44346dabeb3b76",
  sourceUrl: "https://github.com/mattpocock/skills",
  license: "MIT",
  licensePath: `${MATT_POCOCK_ROOT}/LICENSE`,
  manifestPath: `${MATT_POCOCK_ROOT}/UPSTREAM_MANIFEST.json`,
  licenseSha256: "0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5",
  manifestSha256: "e531ddc6560515397ac32d93334fa3eb586b6b6bcc2e472c3646641fd3d2b951",
});

export const HANOON_KIT = Object.freeze({
  sourceUrl: "first-party",
  license: "first-party",
  licensePath: `${HANOON_ROOT}/NOTICE`,
});

export const PSTACK_KIT = Object.freeze({
  revision: "60c641e4fad674784b30abcf9f8915dea39df38d",
  sourceUrl: "https://github.com/cursor/plugins",
  license: "MIT",
  licensePath: `${PSTACK_ROOT}/LICENSE`,
});

// Visual explanation for reviewer-facing prose, vendored from humanlayer/skills.
export const HUMANLAYER_KIT = Object.freeze({
  revision: "3c2629142c5d437428269b1b722b08c0b87f574d",
  sourceUrl: "https://github.com/humanlayer/skills",
  license: "MIT",
  licensePath: `${HUMANLAYER_ROOT}/LICENSE`,
});

export const WORKFLOW_PROVENANCE = Object.freeze({
  source: WORKFLOW_KIT.sourceUrl,
  license: WORKFLOW_KIT.license,
});
export const GUARD_PROVENANCE = Object.freeze({ source: GUARD_KIT.sourceUrl, license: GUARD_KIT.license });
export const DELIVERY_PROVENANCE = Object.freeze({ source: DELIVERY_KIT.sourceUrl, license: DELIVERY_KIT.license });
export const DISCOVERY_PROVENANCE = Object.freeze({ source: DISCOVERY_KIT.sourceUrl, license: DISCOVERY_KIT.license });
export const MATT_POCOCK_PROVENANCE = Object.freeze({
  source: MATT_POCOCK_KIT.sourceUrl,
  license: MATT_POCOCK_KIT.license,
});
export const HANOON_PROVENANCE = Object.freeze({ source: HANOON_KIT.sourceUrl, license: HANOON_KIT.license });
export const PSTACK_PROVENANCE = Object.freeze({ source: PSTACK_KIT.sourceUrl, license: PSTACK_KIT.license });
export const HUMANLAYER_PROVENANCE = Object.freeze({
  source: HUMANLAYER_KIT.sourceUrl,
  license: HUMANLAYER_KIT.license,
});

function localSkill({ id, root, provenance, sourceRevision, invocationClass = "model" }) {
  const skillPath = `${root}/${id}/SKILL.md`;
  return Object.freeze({
    id,
    skillPath,
    sourcePath: skillPath,
    sourceRevision,
    invocationClass,
    ...provenance,
  });
}

export const REQUIRED_WORKFLOW_SKILLS = Object.freeze(workflowSkillIds.map((id) => Object.freeze({
  id,
  skillPath: `${WORKFLOW_ROOT}/${id}/SKILL.md`,
  ...WORKFLOW_PROVENANCE,
})));
export const REQUIRED_GUARD_SKILLS = Object.freeze(guardSkillIds.map((id) => localSkill({
  id, root: GUARDS_ROOT, provenance: GUARD_PROVENANCE, sourceRevision: "vendored",
})));
export const REQUIRED_DELIVERY_SKILLS = Object.freeze(deliverySkillIds.map((id) => localSkill({
  id, root: DELIVERY_ROOT, provenance: DELIVERY_PROVENANCE, sourceRevision: "vendored",
})));
export const REQUIRED_DISCOVERY_SKILLS = Object.freeze(discoverySkillIds.map((id) => localSkill({
  id,
  root: DISCOVERY_ROOT,
  provenance: DISCOVERY_PROVENANCE,
  sourceRevision: DISCOVERY_KIT.revision,
  invocationClass: id === "grill-with-docs" ? "user" : "model",
})));
export const REQUIRED_HANOON_SKILLS = Object.freeze(hanoonSkillIds.map((id) => localSkill({
  id, root: HANOON_ROOT, provenance: HANOON_PROVENANCE, sourceRevision: "repository",
})));
export const REQUIRED_PSTACK_SKILLS = Object.freeze(pstackSkillIds.map((id) =>
  localSkill({
    id,
    root: PSTACK_ROOT,
    provenance: PSTACK_PROVENANCE,
    sourceRevision: PSTACK_KIT.revision,
    invocationClass: id === "technical-writing" ? "user" : "model",
  })));
export const REQUIRED_HUMANLAYER_SKILLS = Object.freeze(humanlayerSkillIds.map((id) =>
  localSkill({
    id,
    root: HUMANLAYER_ROOT,
    provenance: HUMANLAYER_PROVENANCE,
    sourceRevision: HUMANLAYER_KIT.revision,
  })));

export const REQUIRED_MATT_POCOCK_SKILLS = Object.freeze(promotedMattSkills.map(({ bucket, id, invocationClass }) =>
  Object.freeze({
    id,
    skillPath: `${MATT_POCOCK_ROOT}/${bucket}/${id}/SKILL.md`,
    sourcePath: `skills/${bucket}/${id}`,
    sourceRevision: MATT_POCOCK_KIT.revision,
    invocationClass,
    ...MATT_POCOCK_PROVENANCE,
  })));

export const REQUIRED_RETAINED_HANOON_SKILLS = Object.freeze(retainedHanoonSkillIds.map((id) =>
  localSkill({ id, root: HANOON_ROOT, provenance: HANOON_PROVENANCE, sourceRevision: "repository" })));

export const REQUIRED_LEGACY_SKILLS = Object.freeze([]);
export const REQUIRED_SHADOWED_SKILLS = Object.freeze([]);

export const REQUIRED_SKILLS = Object.freeze([
  ...REQUIRED_MATT_POCOCK_SKILLS,
  ...REQUIRED_GUARD_SKILLS,
  ...REQUIRED_DELIVERY_SKILLS,
  ...REQUIRED_RETAINED_HANOON_SKILLS,
  ...REQUIRED_PSTACK_SKILLS,
  ...REQUIRED_HUMANLAYER_SKILLS,
].sort((left, right) => left.id.localeCompare(right.id)));

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
