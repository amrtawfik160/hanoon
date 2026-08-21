import { createHash } from "node:crypto";
import { CONTROLLER_TOOL_NAMES, type ControllerToolName } from "../controller/capability-policy";
import {
  descriptorDigest,
  validateCapabilityCatalog,
  type CapabilityDescriptor,
  type CapabilityRoute,
} from "./contracts";

export const TASK_RECIPES = [
  "direct",
  "bounded",
  "bug",
  "architectural",
  "skill-authoring",
  "adopted-pr",
] as const;

export const CONTROLLER_PROTOCOL_TOOL_IDS = [
  "telegram_agent_turn_evidence",
  "telegram_agent_respond",
] as const;

/**
 * Every controller tool that is not a protocol tool, derived rather than
 * listed.
 *
 * It used to be a second hand-maintained copy of the allowlist, and it drifted:
 * seven tools were declared, implemented, documented, and tested while missing
 * here, so no descriptor existed, no bundle could carry them, and they reached
 * no session at all. Deriving it means adding a tool to the allowlist cannot
 * silently fail to produce one.
 */
export const CONTROLLER_DOMAIN_TOOL_IDS = CONTROLLER_TOOL_NAMES
  .filter((name): name is Exclude<ControllerToolName, (typeof CONTROLLER_PROTOCOL_TOOL_IDS)[number]> =>
    !(CONTROLLER_PROTOCOL_TOOL_IDS as readonly string[]).includes(name));



export const CONTROLLER_METADATA_TOOL_IDS = [
  "telegram_agent_capabilities",
  "telegram_agent_request_capability",
] as const;

const WORKER_SKILLS = new Set([
  "blast-radius",
  "brainstorming",
  "checking-system-logs",
  "clean-code-guard",
  "docs-guard",
  "driving-bb",
  "durable-boundary-audit",
  "pr-writer",
  "proportional-development-workflow",
  "receiving-code-review",
  "systematic-debugging",
  "technical-writing",
  "test-driven-development",
  "test-guard",
  "unslop",
  "verification-before-completion",
  "writing-plans",
  "writing-skills",
]);

const NATIVE_SKILLS = new Set([
  "dispatching-parallel-agents",
  "executing-plans",
  "finishing-a-development-branch",
  "requesting-code-review",
  "subagent-driven-development",
  "using-git-worktrees",
  "using-superpowers",
]);

const MANUAL_SKILLS = new Set(["domain-modeling", "grill-with-docs", "grilling"]);

const SKILL_DIGESTS = {
  "blast-radius": "05f1dcf76d833e133be0201b43e3bfaec886b272169955ae26f8c2b43e12eb8d",
  brainstorming: "74edf03ea6d24ef53db48677b93558d14a979bdf052ca3f57ecdca0c66791608",
  "checking-system-logs": "9c1831af51faa71827be4abb0c5a13862576a3bda9788d37f2f886635e6c6245",
  "clean-code-guard": "4694ad1d36cdcff2e1bfe3b1f903bc21820b682a35385e0f8b382e2cce897be2",
  "dispatching-parallel-agents": "1968923066f3b707eb01d1992cdf4c42284c3855f70253b9cd5000ff45fca13c",
  "docs-guard": "8648f87ad021a87225d46a5c83c977e8e56594068a9f3fe4e4ad47da93f418ef",
  "driving-bb": "e66fc93e4940ac8372ea88d7c5a3d2d0668db5872e919046e0f82d2ab7ffd216",
  "domain-modeling": "152e2c97239affb12a60c5f4a7e74ab546a49ae169688c81f4e2ccc42dafa579",
  "durable-boundary-audit": "5e0ce676aae53ced4e50e225eb1cb630d7d7f7c33769a63e7fb3886cedc9b44f",
  "executing-plans": "c4c3d8b628c51114cd165fb8246fe02744cd8be180032328391252e653028d9b",
  "finishing-a-development-branch": "8db5a922b242dd4e1bf824cb91c13b3e8d8e8a86d6ceaf7f0774eb9cce909d65",
  "grill-with-docs": "610d091047bcfb9db0f75c057d15538481a721111579fc5ec7f83ad9131a2165",
  grilling: "fa5c1e5ee76b1c8f1ae56101f52c9e239de75d5c578adc61227b92d10b7e52ef",
  "pr-writer": "785a2b1f084407e42f61661f83c7b0c621889865a483774f44c893c0cbcf57bc",
  "proportional-development-workflow": "96870c75b91543cf751afa47bd9a217f99c3d5e8d27ccdada6e1dcfec3af2096",
  "receiving-code-review": "091df1629510af1b92fc4abd6f96732ebedb4cb2c0f3457e8f2740b0504a2438",
  "requesting-code-review": "d71cc01ba56d2325cf8af5f7c11837819b63ecd57de0bfdb812f7f3ff7751df8",
  "subagent-driven-development": "8dd1b8e698edec3700c6d89517dbe96febd3bacd3f6ea21c1a3569c62ea104b5",
  "systematic-debugging": "808fc5717aa88ad65efff312b11c186294d3e6ee301afb584e2f86599b137787",
  "technical-writing": "bd0cb21034f4fe6695cfdf8cd3561026eec943f0bb6e9300bc78a2b3340865a7",
  "test-driven-development": "bf1b8216e523851a411e91d429a7c1c2a173e79d88957bc78e348218d50edd54",
  "test-guard": "77aeeb60d5cd12f075b358c3a99b49aba5eaf012fa8f3e217d1ed6983922e9b0",
  unslop: "181883e539caec8258ec9129e3ba5f133409144a2cbf2aa361158ab94cfc3441",
  "using-git-worktrees": "8cfb86f121269e8f7f12361e6795c4f6738828340e28964c9229d365666c9edd",
  "using-superpowers": "30f2ab78e20ddc27ee7158ae8d4a2abe161c360981c7cc3548070913142d3dc3",
  "verification-before-completion": "2befe7fc55bcadaa3d97dd9e8efeb633d2561c0ebe74c5a8b17c4d9e7e4520b3",
  "writing-plans": "48508f44bbfd7d24b029fbf3a314f3cd14c9615599059366e922f47b8dc08cf2",
  "writing-skills": "d34db5c8aed6a4e0440132bd0613aace70a693ec7819d5637ad77481d8e10d1b",
} as const;

export type CapabilitySkillId = keyof typeof SKILL_DIGESTS;
export const CAPABILITY_SKILL_IDS = Object.freeze(
  Object.keys(SKILL_DIGESTS).sort((left, right) => left.localeCompare(right)),
) as readonly CapabilitySkillId[];

function stableDigest(identity: string): string {
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

type DescriptorInput = Readonly<{
  id: string;
  kind: CapabilityDescriptor["kind"];
  source: string;
  version?: string;
  sourceDigest?: string;
  route: CapabilityRoute;
  roles?: readonly string[];
  recipes?: readonly string[];
  stages?: readonly string[];
  requiredTraits?: readonly string[];
  forbiddenTraits?: readonly string[];
  prerequisites?: readonly string[];
  conflicts?: readonly string[];
  orderAfter?: readonly string[];
  substitutes?: readonly string[];
  effectClass?: CapabilityDescriptor["effects"]["class"];
  risk?: CapabilityDescriptor["effects"]["risk"];
  dataClasses?: CapabilityDescriptor["effects"]["dataClasses"];
  reversible?: boolean;
  idempotent?: boolean;
  ownerApproval?: CapabilityDescriptor["authority"]["ownerApproval"];
  credentials?: boolean;
  egress?: boolean;
  hosts?: CapabilityDescriptor["authority"]["hosts"];
  workspaces?: CapabilityDescriptor["authority"]["workspaces"];
  permissionModes?: CapabilityDescriptor["authority"]["permissionModes"];
  inputSchema?: string;
  outputSchema?: string;
  timeoutMs?: number;
  maxResultBytes?: number;
  costClass?: CapabilityDescriptor["economics"]["costClass"];
  modelPools?: CapabilityDescriptor["economics"]["modelPools"];
  evidenceRequirement?: CapabilityDescriptor["evidence"]["requirement"];
  receiptType?: CapabilityDescriptor["evidence"]["receiptType"];
  evidenceStrength?: CapabilityDescriptor["evidence"]["strength"];
}>;

function descriptor(input: DescriptorInput): CapabilityDescriptor {
  const version = input.version ?? "1";
  const unsigned: CapabilityDescriptor = {
    id: input.id,
    kind: input.kind,
    source: input.source,
    sourceDigest: input.sourceDigest ?? stableDigest(`${input.source}:${input.id}:${version}:source`),
    version,
    digest: "0".repeat(64),
    status: "admitted",
    route: input.route,
    routing: {
      roles: sorted(input.roles ?? []),
      recipes: sorted(input.recipes ?? []),
      stages: sorted(input.stages ?? []),
      requiredTraits: sorted(input.requiredTraits ?? []),
      forbiddenTraits: sorted(input.forbiddenTraits ?? []),
    },
    composition: {
      prerequisites: sorted(input.prerequisites ?? []),
      conflicts: sorted(input.conflicts ?? []),
      orderAfter: sorted(input.orderAfter ?? []),
      substitutes: sorted(input.substitutes ?? []),
    },
    effects: {
      class: input.effectClass ?? "none",
      risk: input.risk ?? "low",
      dataClasses: input.dataClasses ?? ["none"],
      reversible: input.reversible ?? true,
      idempotent: input.idempotent ?? true,
    },
    authority: {
      ownerApproval: input.ownerApproval ?? "never",
      credentials: input.credentials ?? false,
      egress: input.egress ?? false,
      hosts: input.hosts ?? [],
      workspaces: input.workspaces ?? [],
      permissionModes: input.permissionModes ?? ["none"],
    },
    contract: {
      inputSchema: input.inputSchema ?? "bounded-v1",
      outputSchema: input.outputSchema ?? "bounded-v1",
      timeoutMs: input.timeoutMs ?? 0,
      maxResultBytes: input.maxResultBytes ?? 8_000,
    },
    economics: {
      costClass: input.costClass ?? "none",
      modelPools: input.modelPools ?? [],
    },
    evidence: {
      requirement: input.evidenceRequirement ?? "optional",
      outcomes: ["passed", "findings", "blocked", "failed"],
      proofSchema: "capability-proof-v1",
      receiptType: input.receiptType ?? "selection",
      strength: input.evidenceStrength ?? "standard",
    },
  };
  return { ...unsigned, digest: descriptorDigest(unsigned) };
}

function skillSource(id: CapabilitySkillId): { source: string; version: string } {
  if ([
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
  ].includes(id)) return { source: "https://github.com/obra/superpowers", version: "6.3.0" };
  if (["clean-code-guard", "docs-guard", "test-guard"].includes(id)) {
    return { source: "https://github.com/amElnagdy/guard-skills", version: "pinned" };
  }
  if (id === "pr-writer") return { source: "https://github.com/getsentry/skills", version: "pinned" };
  if (["domain-modeling", "grill-with-docs", "grilling"].includes(id)) {
    return { source: "https://github.com/mattpocock/skills", version: "1.2.3+84fdeffd" };
  }
  if (["technical-writing", "unslop"].includes(id)) {
    return { source: "https://github.com/cursor/plugins", version: "pstack@60c641e4" };
  }
  return { source: "first-party", version: "1" };
}

function skillRouting(id: CapabilitySkillId): Pick<DescriptorInput,
  "roles" | "recipes" | "stages" | "requiredTraits" | "forbiddenTraits" |
  "prerequisites" | "conflicts" | "orderAfter" | "evidenceRequirement" |
  "receiptType" | "evidenceStrength" | "modelPools" | "costClass"> {
  switch (id) {
    case "proportional-development-workflow":
      return { roles: ["controller"], recipes: TASK_RECIPES, stages: ["intake"] };
    case "unslop":
      return {
        roles: ["controller", "planner", "implementation", "documentation"],
        recipes: TASK_RECIPES,
        stages: ["communication"],
        forbiddenTraits: ["strict-json"],
      };
    case "technical-writing":
      return {
        roles: ["documentation"],
        recipes: TASK_RECIPES,
        stages: ["documentation"],
        forbiddenTraits: ["strict-json"],
      };
    case "brainstorming":
      return {
        roles: ["controller", "planner"], recipes: ["architectural"], stages: ["discovery"],
        requiredTraits: ["needs-discovery"], forbiddenTraits: ["grilled"], conflicts: ["grill-with-docs"],
        costClass: "high", modelPools: ["strong"],
      };
    case "writing-plans":
      return {
        roles: ["planner"], recipes: ["architectural"], stages: ["planning"],
        requiredTraits: ["approved-spec"], costClass: "high", modelPools: ["strong"],
      };
    case "systematic-debugging":
      return {
        roles: ["implementation"], recipes: ["bug"], stages: ["diagnosis", "implementation"],
        requiredTraits: ["unexpected-behavior"], costClass: "medium", modelPools: ["standard", "strong"],
      };
    case "test-driven-development":
      return {
        roles: ["implementation"], recipes: TASK_RECIPES, stages: ["regression", "implementation", "remediation"],
        requiredTraits: ["behavioral-change"], orderAfter: ["systematic-debugging"],
        evidenceRequirement: "mandatory", receiptType: "worker", modelPools: ["fast", "standard", "strong"],
      };
    case "receiving-code-review":
      return {
        roles: ["implementation"], recipes: TASK_RECIPES, stages: ["remediation"],
        requiredTraits: ["review-findings"], modelPools: ["standard", "strong"],
      };
    case "verification-before-completion":
      return {
        roles: ["implementation", "documentation"], recipes: TASK_RECIPES,
        stages: ["implementation", "remediation", "delivery", "documentation", "completion"],
        orderAfter: ["writing-skills"],
        evidenceRequirement: "mandatory", receiptType: "worker", evidenceStrength: "high",
        modelPools: ["fast", "standard", "strong"],
      };
    case "writing-skills":
      return {
        roles: ["implementation"], recipes: ["skill-authoring"], stages: ["implementation"],
        prerequisites: ["test-driven-development"], evidenceRequirement: "mandatory", receiptType: "worker",
        modelPools: ["standard", "strong"],
      };
    case "clean-code-guard":
    case "test-guard":
      return {
        roles: ["review", "final-review"], recipes: TASK_RECIPES,
        stages: ["diff-guards", "review", "task-review", "integrated-review"],
        evidenceRequirement: "mandatory", receiptType: "guard", evidenceStrength: "high",
        modelPools: ["standard", "strong"],
      };
    case "docs-guard":
      return {
        roles: ["review", "final-review", "documentation"], recipes: TASK_RECIPES,
        stages: ["diff-guards", "review", "task-review", "integrated-review", "documentation"],
        evidenceRequirement: "mandatory", receiptType: "guard", evidenceStrength: "high",
        modelPools: ["standard", "strong"],
      };
    // Not a diff guard: it judges what the change reaches outside the diff, so
    // it is eligible for the review stages but never the per-file guard sweep.
    case "blast-radius":
      return {
        roles: ["review", "final-review"], recipes: TASK_RECIPES,
        stages: ["review", "task-review", "integrated-review"],
        evidenceRequirement: "mandatory", receiptType: "guard", evidenceStrength: "high",
        modelPools: ["standard", "strong"],
      };
    case "pr-writer":
      return {
        roles: ["implementation"], recipes: TASK_RECIPES, stages: ["delivery"],
        requiredTraits: ["nontrivial-diff"], orderAfter: ["verification-before-completion"],
        receiptType: "worker", modelPools: ["fast", "standard"],
      };
    case "grill-with-docs":
      return {
        roles: ["controller"], recipes: ["bounded", "architectural"], stages: ["discovery"],
        prerequisites: ["domain-modeling", "grilling"], conflicts: ["brainstorming"],
        costClass: "high", modelPools: ["strong"],
      };
    case "grilling":
    case "domain-modeling":
      return { roles: ["controller"], recipes: ["bounded", "architectural"], stages: ["discovery"] };
    default:
      return { roles: ["executor"], recipes: TASK_RECIPES, stages: ["orchestration"] };
  }
}

const skillDescriptors = CAPABILITY_SKILL_IDS.map((id) => {
  const route: CapabilityRoute = WORKER_SKILLS.has(id)
    ? "worker"
    : NATIVE_SKILLS.has(id)
      ? "hanoon-native"
      : MANUAL_SKILLS.has(id)
        ? "manual-only"
        : "inventory-only";
  const source = skillSource(id);
  return descriptor({
    id,
    kind: "skill",
    route,
    source: source.source,
    version: source.version,
    sourceDigest: SKILL_DIGESTS[id],
    effectClass: route === "hanoon-native" ? "orchestrate" : "none",
    dataClasses: route === "manual-only" ? ["owner-message", "repository"] : ["repository"],
    workspaces: route === "manual-only" ? ["personal", "managed-worktree"] : ["managed-worktree"],
    permissionModes: ["none"],
    ...skillRouting(id),
  });
});

const READ_TOOLS = new Set([
  "telegram_agent_list_projects",
  "telegram_agent_job_status",
  "telegram_agent_list_threads",
  "telegram_agent_thread_status",
  "telegram_agent_read_thread",
  "telegram_agent_recall",
  "telegram_agent_list_watches",
  "telegram_agent_health",
  "telegram_agent_scorecard",
  "telegram_agent_capabilities",
  "telegram_agent_turn_evidence",
]);

const toolDescriptors = [
  ...CONTROLLER_DOMAIN_TOOL_IDS,
  ...CONTROLLER_METADATA_TOOL_IDS,
  ...CONTROLLER_PROTOCOL_TOOL_IDS,
].map((id) => {
  const readOnly = READ_TOOLS.has(id);
  const mandatory = (CONTROLLER_PROTOCOL_TOOL_IDS as readonly string[]).includes(id) || !readOnly;
  return descriptor({
    id,
    kind: "tool",
    source: "first-party",
    route: "worker",
    roles: ["controller"],
    recipes: TASK_RECIPES,
    stages: ["controller-turn"],
    effectClass: readOnly ? "read" : "write",
    risk: readOnly ? "low" : "medium",
    dataClasses: ["operational-state"],
    ownerApproval: readOnly ? "never" : "conditional",
    egress: id.includes("thread") || id.includes("job") || id.includes("adopt"),
    hosts: ["controller"],
    workspaces: ["personal"],
    permissionModes: ["auto", "full"],
    inputSchema: `${id}-input-v1`,
    outputSchema: `${id}-output-v1`,
    timeoutMs: 60_000,
    evidenceRequirement: mandatory ? "mandatory" : "optional",
    receiptType: "tool",
  });
});

export const CONTROLLER_BUNDLE_TOOLS = {
  "core-observation": [
    "telegram_agent_list_projects", "telegram_agent_job_status", "telegram_agent_list_threads",
    "telegram_agent_thread_status", "telegram_agent_read_thread", "telegram_agent_health",
    "telegram_agent_scorecard",
    // Showing the owner a picture belongs to any turn, not to a subject the
    // opening message happened to name.
    "telegram_agent_send_media",
  ],
  "job-control": [
    "telegram_agent_start_job", "telegram_agent_retry_job", "telegram_agent_cancel_job",
    "telegram_agent_steer_job", "telegram_agent_adopt_pr",
    // Landing work the owner asked to land, and lifting the brake that is
    // stopping it. Both are job control, and both were unreachable until now.
    "telegram_agent_approve_merge", "telegram_agent_resume_project",
  ],
  "thread-control": [
    "telegram_agent_create_thread", "telegram_agent_send_to_thread",
    "telegram_agent_answer_thread",
  ],
  memory: [
    "telegram_agent_remember", "telegram_agent_recall", "telegram_agent_forget",
    // A specification the owner handed over is theirs to recall the same way a
    // standing preference is, so it travels with the memory bundle.
    "telegram_agent_add_reference", "telegram_agent_search_reference",
  ],
  monitoring: ["telegram_agent_watch", "telegram_agent_list_watches", "telegram_agent_cancel_watch"],
  operations: [
    "telegram_agent_request_thread_operation", "telegram_agent_delegate", "telegram_agent_set_working_style",
    "telegram_agent_access_list", "telegram_agent_access_status", "telegram_agent_access_verify",
  ],
  metadata: CONTROLLER_METADATA_TOOL_IDS,
} as const;

const bundleDescriptors = Object.entries(CONTROLLER_BUNDLE_TOOLS).map(([id, tools]) => descriptor({
  id: `controller-bundle-${id}`,
  kind: "bundle",
  source: "first-party",
  route: "hanoon-native",
  roles: ["controller"],
  recipes: TASK_RECIPES,
  stages: ["profile-selection"],
  prerequisites: tools,
  // Selecting a bundle exposes already-fenced tool interfaces. It does not
  // execute a domain operation or grant authority by itself.
  effectClass: "none",
  dataClasses: ["operational-state"],
  receiptType: "native",
}));

const nativeAdapterDescriptors = [...NATIVE_SKILLS].map((skillId) => descriptor({
  id: `hanoon-native-${skillId}`,
  kind: "native-adapter",
  source: "first-party",
  route: "hanoon-native",
  roles: ["executor"],
  recipes: TASK_RECIPES,
  stages: ["orchestration"],
  prerequisites: [skillId],
  effectClass: "orchestrate",
  risk: "high",
  dataClasses: ["repository", "operational-state"],
  workspaces: ["managed-worktree"],
  permissionModes: ["none"],
  evidenceRequirement: "mandatory",
  receiptType: "native",
  evidenceStrength: "high",
}));

const recipeDescriptors = TASK_RECIPES.map((recipe) => descriptor({
  id: `recipe-${recipe}`,
  kind: "recipe",
  source: "first-party",
  route: "hanoon-native",
  roles: ["executor"],
  recipes: [recipe],
  stages: ["dispatch"],
  prerequisites: ["hanoon-native-using-superpowers"],
  effectClass: "orchestrate",
  risk: recipe === "architectural" ? "high" : "medium",
  dataClasses: ["repository", "operational-state"],
  evidenceRequirement: "mandatory",
  receiptType: "recipe",
  evidenceStrength: recipe === "architectural" ? "high" : "standard",
}));

const modelPoolDescriptors = (["fast", "standard", "strong"] as const).map((pool) => descriptor({
  id: `model-pool-${pool}`,
  kind: "model",
  source: "configured-bb-provider",
  route: "hanoon-native",
  roles: ["controller", "planner", "implementation", "review", "documentation"],
  recipes: TASK_RECIPES,
  stages: ["model-selection"],
  effectClass: "orchestrate",
  risk: pool === "strong" ? "high" : pool === "standard" ? "medium" : "low",
  dataClasses: ["owner-message", "repository", "operational-state"],
  egress: true,
  hosts: ["controller", "project"],
  workspaces: ["personal", "managed-worktree"],
  permissionModes: ["none"],
  costClass: pool === "strong" ? "high" : pool === "standard" ? "medium" : "low",
  modelPools: [pool],
  evidenceRequirement: "mandatory",
  receiptType: "model",
  evidenceStrength: pool === "strong" ? "high" : "standard",
}));

export const CAPABILITY_CATALOG = validateCapabilityCatalog([
  ...skillDescriptors,
  ...toolDescriptors,
  ...bundleDescriptors,
  ...nativeAdapterDescriptors,
  ...recipeDescriptors,
  ...modelPoolDescriptors,
]);

export const CAPABILITY_BY_ID: ReadonlyMap<string, CapabilityDescriptor> = new Map(
  CAPABILITY_CATALOG.map((entry) => [entry.id, entry]),
);

export const CAPABILITY_REGISTRY_DIGEST = createHash("sha256")
  .update(JSON.stringify(CAPABILITY_CATALOG.map((entry) => [entry.id, entry.digest])), "utf8")
  .digest("hex");

export const CAPABILITY_GRAPH_DIGEST = createHash("sha256")
  .update(JSON.stringify(CAPABILITY_CATALOG.map((entry) => [entry.id, entry.composition])), "utf8")
  .digest("hex");
