import { createHash } from "node:crypto";
import { CONTROLLER_TOOL_NAMES, type ControllerToolName } from "../controller/capability-policy";
import {
  descriptorDigest,
  validateCapabilityCatalog,
  type CapabilityDescriptor,
  type CapabilityRoute,
} from "./contracts";
import {
  PROTECTED_CONNECTOR_OPERATIONS,
  protectedConnectorCapabilityFor,
} from "../credentials/connector-protocol";
import { evaluateFindingDisposition, isBoundedPolicyKey, type FindingDispositionInput } from "./guards";

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

type SkillAdmissionEvidence = Readonly<{
  sourceDigest: string;
  bundleDescriptorDigest: string;
  invocationClass: "user" | "model";
}>;

const ADMITTED_SKILL_BUNDLE = {
  "ask-matt": { sourceDigest: "b25d86fb36b1d294eeead5d7db529f86135f9671f2afcd607579a63bb2213769", bundleDescriptorDigest: "4ef913dc61cc753023e96ebc2e8d2983e89bc606a250e81d18a5d7fdc75ea8d8", invocationClass: "user" },
  "blast-radius": { sourceDigest: "efc3956ba00a6a0a06c8283fd3f8344f1b700d2923c65f73db801e05d50ac783", bundleDescriptorDigest: "6960af3e86855ebe7f58be640afa871fb2fefb032d098151399d35a83c6bed44", invocationClass: "model" },
  "checking-system-logs": { sourceDigest: "76d6b6f8ff80a410b65a1c30a51e45b1d2cfa0e82267ce251462ac0c0b64bbaf", bundleDescriptorDigest: "76cb8c6f6d5add9fe66369d8d64ab4aca1e00f42a558021f8e6d90285a5fd510", invocationClass: "model" },
  "clean-code-guard": { sourceDigest: "4694ad1d36cdcff2e1bfe3b1f903bc21820b682a35385e0f8b382e2cce897be2", bundleDescriptorDigest: "539aa4075dc5a4142705238a0c4ef35b46b09a48fa4693300c6558804fe02b6d", invocationClass: "model" },
  "code-review": { sourceDigest: "47f4e52c21694def9c7c11cbfbf891ca35eac7a93e395797515be3c8a409ae50", bundleDescriptorDigest: "700ee1661d4eff3add54f10baa5202851314d17b4538db818ca1bf572921bad3", invocationClass: "model" },
  "codebase-design": { sourceDigest: "2c20617f87ec8af6a434859f381b2f061a69b530444e74eb39e78bb016a6d1e2", bundleDescriptorDigest: "46460be29afb7f5ebdfc8bda398ad9c21199c5074850cf8a7707ec8378c70136", invocationClass: "model" },
  "diagnosing-bugs": { sourceDigest: "77f3cf31bc99b2f49af943222526531fcc9fc41d047626d3640e875e85af3e84", bundleDescriptorDigest: "2e9d27811a60afee0ee9951a75e459cf59489e712e1ac0832f663940184558f5", invocationClass: "model" },
  "docs-guard": { sourceDigest: "8648f87ad021a87225d46a5c83c977e8e56594068a9f3fe4e4ad47da93f418ef", bundleDescriptorDigest: "9cb8301e495687ad40ee11e8e1ccb508a0b2c331423880eb8fbb753a517a9f06", invocationClass: "model" },
  "domain-modeling": { sourceDigest: "327a2b50620e2fd70abc6893cd6965e76b20f8d0adb0dc2c8d5eb3845efb643e", bundleDescriptorDigest: "60fa9d0ae9095d4ebe066b51d5e78529ca8cb75302aed71de4181f0f946db8bb", invocationClass: "model" },
  "driving-bb": { sourceDigest: "8ad1cb127379be028e01b3bfd07e3a91defd9971cf1da1b5c268c021470f34d4", bundleDescriptorDigest: "99e1b9d2f0d8be7ad1073cb81a58eb2b32907189259a7da03958b8230e9632ae", invocationClass: "model" },
  "durable-boundary-audit": { sourceDigest: "bbe224ed820694e7b54b1030a5aa951d996b7a6d4a6758dcb5b941012484dd2c", bundleDescriptorDigest: "a145e28c30fc432520a1905f694d711f2ec8fb6827af21828c259588ae2e6b82", invocationClass: "model" },
  "grill-me": { sourceDigest: "caaf8b8de1684f96e26b28f3c29189db5c89cce4b73e1c93d86164f66ef88637", bundleDescriptorDigest: "b60265b7de314625667b53857322f0a543502705a8453c0b2023bc0308bd1938", invocationClass: "user" },
  "grill-with-docs": { sourceDigest: "7de372c13488f1ee96cc11cd8907b56b6809cc93eef776eeddd37de6b6cbe3fe", bundleDescriptorDigest: "164d91e3beb314fb449ce5aa004b63df3cde7971d9e35ea4c12cb4d8c4e99bf5", invocationClass: "user" },
  grilling: { sourceDigest: "10ff989e7498b23b5acb49d5048f11dcd906757d2f79c5cdf8a00001381296f2", bundleDescriptorDigest: "45ecfed1492a2c7647346d3b3f8e21c6a09552c078cf97c2748ab914621beeab", invocationClass: "model" },
  handoff: { sourceDigest: "7c62de979fdc7ac32fb5ddb2146156c917f80ee070d30fadc9d40343c4b6ed25", bundleDescriptorDigest: "423c22f3804d4033a4435e629187bad38242fe76199376cc2ee039bf025753ff", invocationClass: "user" },
  implement: { sourceDigest: "6d3fd9e83b8f36e5213854779db49b256a457a7ebb4a503e53fa7dcff696adc3", bundleDescriptorDigest: "e41da514b2c2f671bff0efc0dee773a606842c84ae1dccb6e5f82d43595a80ef", invocationClass: "user" },
  "improve-codebase-architecture": { sourceDigest: "d1ac25511a936ff4250a48dbcefda363837d6bb9321b3cba73df99fa37270a75", bundleDescriptorDigest: "24732f0720aaa6b7dd37db3669e394722698d24ba0578098ed3990fab739ac9b", invocationClass: "user" },
  "pr-writer": { sourceDigest: "785a2b1f084407e42f61661f83c7b0c621889865a483774f44c893c0cbcf57bc", bundleDescriptorDigest: "6fe1ab2cbe47303da8a613703b3e7d49c5e7ffd03f7273d365a1584ac4e7e11f", invocationClass: "model" },
  prototype: { sourceDigest: "714de632d116bb73f65cdb5a882db15b9369a6713b9a47c0fad827848f0bfbe3", bundleDescriptorDigest: "7bd26fbafde838442449be94facaee393a9c89fc783b7975b68fc3f468bb67ab", invocationClass: "model" },
  research: { sourceDigest: "985569f15739c713d6784887c3d186d4ef9ac85bec5ad9c068d25bf0739928e4", bundleDescriptorDigest: "0607555f7ea8634bff956695f02c42c4f87a814dcf1761a5555833235be0e312", invocationClass: "model" },
  "resolving-merge-conflicts": { sourceDigest: "9d8114f8ef0b31f535a265fc05c364bd8cf2e2895a830040e06c22acb11f54b0", bundleDescriptorDigest: "0d0b45ea81e64fe6eaa4e2650770d4015363c4ccf6638b76546809ed447494c8", invocationClass: "model" },
  "setup-matt-pocock-skills": { sourceDigest: "2bcd89e97777cdb705914424e39c97d5db524c8eb4eafac8120778a07774f0ec", bundleDescriptorDigest: "be6b0e4460c175a93c2e814de91584b278f7159c51211e1121a0528e90f6d6c0", invocationClass: "user" },
  tdd: { sourceDigest: "cb01f66bebfaa25fa1f88e6b7e769cd9fd9f35b1120b8563749820738814c927", bundleDescriptorDigest: "4cce72c6f2afef293007eecf4ec18436ee454a8a3c37e81ea860c30d0c0c566a", invocationClass: "model" },
  teach: { sourceDigest: "a32df9dcdfc0c4fdc1c98e1ed3940c5f56b84c1aa90ff60346f32b8b53915b43", bundleDescriptorDigest: "d1cbc2515700c1370b8f74a0e7e41df053dc3299e579b90b054588daf66bd0df", invocationClass: "user" },
  "technical-writing": { sourceDigest: "bd0cb21034f4fe6695cfdf8cd3561026eec943f0bb6e9300bc78a2b3340865a7", bundleDescriptorDigest: "9d355e8d479c993462baf65f53560ed273056346a17b69a3e5022696b4a5972f", invocationClass: "user" },
  "test-guard": { sourceDigest: "77aeeb60d5cd12f075b358c3a99b49aba5eaf012fa8f3e217d1ed6983922e9b0", bundleDescriptorDigest: "ac83a80f2930ac5ec029cbdf8637ac7f89070c2ba44da3a40138238eee31e472", invocationClass: "model" },
  "to-questionnaire": { sourceDigest: "b5eb929842ee0e93d867c5e906d183d350f2f2d149eaeaa86967d94d8eda1d3b", bundleDescriptorDigest: "506194622581c1bb9a46483544fe031cec39f741bbdba34e4616a427b1b3adcb", invocationClass: "user" },
  "to-spec": { sourceDigest: "43ad9cf318e5e7d3d1fa360253a37021796dc87a0c2e595ad262661a10f85088", bundleDescriptorDigest: "5c46ca1e93c69d81889bbc364589898ba55bc5406d9c8cef4321c07157aeecb5", invocationClass: "user" },
  "to-tickets": { sourceDigest: "5c9fba69845c2519b9b35b9af42ae5142c21f8ca15ac2123dc2722002c8058ae", bundleDescriptorDigest: "9a08bf131473369099956d3e12a00f7c2ab83442a42a7e7245d67952c6fca636", invocationClass: "user" },
  triage: { sourceDigest: "623a2ed692bdc77d2090e2a3dea3b627dd722ad3bbaca0be83aada75292c8fc4", bundleDescriptorDigest: "4587c75023a35b9e8f48134b0782c0c4cead02dfb2f0e6225c4397a4cb797ea5", invocationClass: "user" },
  unslop: { sourceDigest: "181883e539caec8258ec9129e3ba5f133409144a2cbf2aa361158ab94cfc3441", bundleDescriptorDigest: "6e14a9599a53f3e56bb1bc209305afb17a9ea874563be261b05c113dcc607abd", invocationClass: "model" },
  "wait-what": { sourceDigest: "e3f44e3ccbc0e7b62f20ba70b295fc9c9f4aa3f96c77168faee1c71bacbf4215", bundleDescriptorDigest: "de05f7ead3a572428d42b2703510e9acf1c7cc3f7dcb535d271af998b45342ea", invocationClass: "user" },
  wayfinder: { sourceDigest: "fee6e1d0c50f0e736b4ef8a599060c959afae904c9a97d82c97f049fcc3aa0f1", bundleDescriptorDigest: "9a14b2db7afa928d558b3127cbcf82da906f58b7d6cb557043798a04adfaff28", invocationClass: "user" },
  wizard: { sourceDigest: "bdf31d48211ea559878f95a4f344aeabf8d85897488ba564382bab0b000daac1", bundleDescriptorDigest: "1723a91b0d9ffcc0b35e0996823fd17bd46925c15d13be55d8d3cd5e016ac3bf", invocationClass: "model" },
  "writing-for-agents": { sourceDigest: "551adca942227b44192edba88acd4e8db911f0121ce58ad16944ccf6a896a74a", bundleDescriptorDigest: "68e5ea2a8427966c48f162b48e9854cebf9f967d3cc09a28e234b5a13fb237ae", invocationClass: "model" },
} as const satisfies Readonly<Record<string, SkillAdmissionEvidence>>;

const LEGACY_SKILL_DIGESTS = {
  brainstorming: "74edf03ea6d24ef53db48677b93558d14a979bdf052ca3f57ecdca0c66791608",
  "dispatching-parallel-agents": "1968923066f3b707eb01d1992cdf4c42284c3855f70253b9cd5000ff45fca13c",
  "executing-plans": "c4c3d8b628c51114cd165fb8246fe02744cd8be180032328391252e653028d9b",
  "finishing-a-development-branch": "8db5a922b242dd4e1bf824cb91c13b3e8d8e8a86d6ceaf7f0774eb9cce909d65",
  "proportional-development-workflow": "96870c75b91543cf751afa47bd9a217f99c3d5e8d27ccdada6e1dcfec3af2096",
  "receiving-code-review": "091df1629510af1b92fc4abd6f96732ebedb4cb2c0f3457e8f2740b0504a2438",
  "requesting-code-review": "d71cc01ba56d2325cf8af5f7c11837819b63ecd57de0bfdb812f7f3ff7751df8",
  "subagent-driven-development": "8dd1b8e698edec3700c6d89517dbe96febd3bacd3f6ea21c1a3569c62ea104b5",
  "systematic-debugging": "808fc5717aa88ad65efff312b11c186294d3e6ee301afb584e2f86599b137787",
  "test-driven-development": "bf1b8216e523851a411e91d429a7c1c2a173e79d88957bc78e348218d50edd54",
  "using-git-worktrees": "8cfb86f121269e8f7f12361e6795c4f6738828340e28964c9229d365666c9edd",
  "using-superpowers": "30f2ab78e20ddc27ee7158ae8d4a2abe161c360981c7cc3548070913142d3dc3",
  "verification-before-completion": "2befe7fc55bcadaa3d97dd9e8efeb633d2561c0ebe74c5a8b17c4d9e7e4520b3",
  "writing-plans": "48508f44bbfd7d24b029fbf3a314f3cd14c9615599059366e922f47b8dc08cf2",
  "writing-skills": "d34db5c8aed6a4e0440132bd0613aace70a693ec7819d5637ad77481d8e10d1b",
} as const;

export type AdmittedCapabilitySkillId = keyof typeof ADMITTED_SKILL_BUNDLE;
export type LegacyCapabilitySkillId = keyof typeof LEGACY_SKILL_DIGESTS;
export type CapabilitySkillId = AdmittedCapabilitySkillId | LegacyCapabilitySkillId;

export const ADMITTED_CAPABILITY_SKILL_IDS = Object.freeze(
  Object.keys(ADMITTED_SKILL_BUNDLE).sort((left, right) => left.localeCompare(right)),
) as readonly AdmittedCapabilitySkillId[];
export const LEGACY_CAPABILITY_SKILL_IDS = Object.freeze(
  Object.keys(LEGACY_SKILL_DIGESTS).sort((left, right) => left.localeCompare(right)),
) as readonly LegacyCapabilitySkillId[];
export const CAPABILITY_SKILL_IDS = Object.freeze([
  ...ADMITTED_CAPABILITY_SKILL_IDS,
  ...LEGACY_CAPABILITY_SKILL_IDS,
].sort((left, right) => left.localeCompare(right))) as readonly CapabilitySkillId[];

export type SkillInvocationRoute = "general-worker" | "navigator" | "owner";
export const SKILL_ADMISSION_CATALOG = Object.freeze(ADMITTED_CAPABILITY_SKILL_IDS.map((id) => {
  const { sourceDigest, bundleDescriptorDigest, invocationClass } = ADMITTED_SKILL_BUNDLE[id];
  const selectionRoutes: readonly SkillInvocationRoute[] = invocationClass === "model"
    ? ["general-worker", "navigator", "owner"]
    : ["navigator", "owner"];
  return Object.freeze({
    id,
    sourceDigest,
    bundleDescriptorDigest,
    invocationClass,
    selectionRoutes: Object.freeze(selectionRoutes),
  });
}));
const SKILL_ADMISSION_BY_ID = new Map(SKILL_ADMISSION_CATALOG.map((entry) => [entry.id, entry]));

export function skillInvocationAllowed(id: string, route: SkillInvocationRoute): boolean {
  return SKILL_ADMISSION_BY_ID.get(id as AdmittedCapabilitySkillId)?.selectionRoutes.includes(route) ?? false;
}

const RECIPE_COMPATIBILITY_SKILL_IDS = [
  "blast-radius", "brainstorming", "checking-system-logs", "clean-code-guard",
  "dispatching-parallel-agents", "docs-guard", "domain-modeling", "driving-bb",
  "durable-boundary-audit", "executing-plans", "finishing-a-development-branch",
  "grill-with-docs", "grilling", "pr-writer", "proportional-development-workflow",
  "receiving-code-review", "requesting-code-review", "subagent-driven-development",
  "systematic-debugging", "technical-writing", "test-driven-development", "test-guard", "unslop",
  "using-git-worktrees", "using-superpowers", "verification-before-completion", "writing-plans",
  "writing-skills",
] as const satisfies readonly CapabilitySkillId[];

const HISTORICAL_DISCOVERY_SKILL_DIGESTS = {
  "domain-modeling": "152e2c97239affb12a60c5f4a7e74ab546a49ae169688c81f4e2ccc42dafa579",
  "grill-with-docs": "610d091047bcfb9db0f75c057d15538481a721111579fc5ec7f83ad9131a2165",
  grilling: "fa5c1e5ee76b1c8f1ae56101f52c9e239de75d5c578adc61227b92d10b7e52ef",
} as const;

// recipe-v1 profiles are immutable snapshots. Updating a first-party skill
// changes the live navigator catalog, never the digest an installed recipe-v1
// job already recorded.
const HISTORICAL_FIRST_PARTY_SKILL_DIGESTS = {
  "blast-radius": "05f1dcf76d833e133be0201b43e3bfaec886b272169955ae26f8c2b43e12eb8d",
  "checking-system-logs": "9c1831af51faa71827be4abb0c5a13862576a3bda9788d37f2f886635e6c6245",
  "driving-bb": "e66fc93e4940ac8372ea88d7c5a3d2d0668db5872e919046e0f82d2ab7ffd216",
  "durable-boundary-audit": "5e0ce676aae53ced4e50e225eb1cb630d7d7f7c33769a63e7fb3886cedc9b44f",
} as const;

const WORKER_SKILLS = new Set<string>([
  "blast-radius", "brainstorming", "checking-system-logs", "clean-code-guard", "docs-guard",
  "driving-bb", "durable-boundary-audit", "pr-writer", "proportional-development-workflow",
  "receiving-code-review", "systematic-debugging", "technical-writing", "test-driven-development",
  "test-guard", "unslop", "verification-before-completion", "writing-plans", "writing-skills",
]);

const NATIVE_SKILLS = new Set<string>([
  "dispatching-parallel-agents", "executing-plans", "finishing-a-development-branch",
  "requesting-code-review", "subagent-driven-development", "using-git-worktrees", "using-superpowers",
]);

const MANUAL_SKILLS = new Set<string>([
  "domain-modeling", "grill-with-docs", "grilling",
]);

function compatibilitySkillSourceDigest(id: CapabilitySkillId): string {
  if (id in HISTORICAL_DISCOVERY_SKILL_DIGESTS) {
    return HISTORICAL_DISCOVERY_SKILL_DIGESTS[id as keyof typeof HISTORICAL_DISCOVERY_SKILL_DIGESTS];
  }
  if (id in HISTORICAL_FIRST_PARTY_SKILL_DIGESTS) {
    return HISTORICAL_FIRST_PARTY_SKILL_DIGESTS[id as keyof typeof HISTORICAL_FIRST_PARTY_SKILL_DIGESTS];
  }
  if (id in LEGACY_SKILL_DIGESTS) return LEGACY_SKILL_DIGESTS[id as LegacyCapabilitySkillId];
  return ADMITTED_SKILL_BUNDLE[id as AdmittedCapabilitySkillId].sourceDigest;
}

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
  if (["clean-code-guard", "docs-guard", "test-guard"].includes(id)) {
    return { source: "https://github.com/amElnagdy/guard-skills", version: "pinned" };
  }
  if (id === "pr-writer") return { source: "https://github.com/getsentry/skills", version: "pinned" };
  if (["technical-writing", "unslop"].includes(id)) {
    return { source: "https://github.com/cursor/plugins", version: "pstack@60c641e4" };
  }
  if (id in HISTORICAL_DISCOVERY_SKILL_DIGESTS) {
    return { source: "https://github.com/mattpocock/skills", version: "1.2.3+84fdeffd" };
  }
  if (["blast-radius", "checking-system-logs", "driving-bb", "durable-boundary-audit", "proportional-development-workflow"].includes(id)) {
    return { source: "first-party", version: "1" };
  }
  if (id in LEGACY_SKILL_DIGESTS) {
    return { source: "https://github.com/obra/superpowers", version: "6.3.0" };
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

const skillDescriptors = RECIPE_COMPATIBILITY_SKILL_IDS.map((id) => {
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
    sourceDigest: compatibilitySkillSourceDigest(id),
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

const liveConnectorDescriptors = PROTECTED_CONNECTOR_OPERATIONS.map((operation) => descriptor({
  id: protectedConnectorCapabilityFor(operation),
  kind: "connector",
  source: "first-party-protected-connector",
  version: "protocol-v2",
  route: "hanoon-native",
  roles: ["executor"],
  recipes: TASK_RECIPES,
  stages: ["orchestration"],
  effectClass: "read",
  risk: "low",
  dataClasses: ["external-content", "operational-state"],
  credentials: operation !== "browser.vercel_project.inspect.v1",
  egress: true,
  hosts: ["any-readonly"],
  permissionModes: ["none"],
  inputSchema: "protected-connector-request-v2",
  outputSchema: "protected-connector-response-v2",
  timeoutMs: 60_000,
  maxResultBytes: 32_768,
  evidenceRequirement: "mandatory",
  receiptType: "connector",
  evidenceStrength: "high",
}));

export const PROTECTED_CONNECTOR_CAPABILITY_DESCRIPTORS = Object.freeze(
  Object.fromEntries(liveConnectorDescriptors.map((entry) => [entry.id, entry])) as Record<
    string,
    CapabilityDescriptor
  >,
);

function catalogDigests(catalog: readonly CapabilityDescriptor[]): Readonly<{ registry: string; graph: string }> {
  return {
    registry: createHash("sha256")
      .update(JSON.stringify(catalog.map((entry) => [entry.id, entry.digest])), "utf8")
      .digest("hex"),
    graph: createHash("sha256")
      .update(JSON.stringify(catalog.map((entry) => [entry.id, entry.composition])), "utf8")
      .digest("hex"),
  };
}

export const HISTORICAL_RECIPE_CAPABILITY_CATALOG = validateCapabilityCatalog([
  ...skillDescriptors,
  ...toolDescriptors,
  ...bundleDescriptors,
  ...nativeAdapterDescriptors,
  ...recipeDescriptors,
  ...modelPoolDescriptors,
]);
export const HISTORICAL_RECIPE_CAPABILITY_BY_ID: ReadonlyMap<string, CapabilityDescriptor> = new Map(
  HISTORICAL_RECIPE_CAPABILITY_CATALOG.map((entry) => [entry.id, entry]),
);
export const HISTORICAL_RECIPE_REGISTRY_DIGEST =
  "d14130f744f1ca484beec08d8956a20e16db854b88a304f9576fcc79bdaa0481";
export const HISTORICAL_RECIPE_GRAPH_DIGEST =
  "665deccc825d74de0d814e94a3799ea50aab2d18176ea6aacbc779651eebf64e";

const historicalDigests = catalogDigests(HISTORICAL_RECIPE_CAPABILITY_CATALOG);
if (historicalDigests.registry !== HISTORICAL_RECIPE_REGISTRY_DIGEST) {
  throw new Error("Historical recipe registry digest drifted");
}
if (historicalDigests.graph !== HISTORICAL_RECIPE_GRAPH_DIGEST) {
  throw new Error("Historical recipe graph digest drifted");
}

const RETAINED_WORKER_SKILL_IDS = new Set<AdmittedCapabilitySkillId>([
  "blast-radius", "checking-system-logs", "clean-code-guard", "docs-guard", "driving-bb",
  "durable-boundary-audit", "pr-writer", "technical-writing", "test-guard", "unslop",
]);

function admittedSkillRoute(id: AdmittedCapabilitySkillId): CapabilityRoute {
  if (RETAINED_WORKER_SKILL_IDS.has(id)) return "worker";
  return ADMITTED_SKILL_BUNDLE[id].invocationClass === "user" ? "manual-only" : "worker";
}

function admittedSkillSource(id: AdmittedCapabilitySkillId): { source: string; version: string } {
  if (["clean-code-guard", "docs-guard", "test-guard"].includes(id)) {
    return { source: "https://github.com/amElnagdy/guard-skills", version: "pinned" };
  }
  if (id === "pr-writer") return { source: "https://github.com/getsentry/skills", version: "pinned" };
  if (id === "technical-writing" || id === "unslop") {
    return { source: "https://github.com/cursor/plugins", version: "pstack@60c641e4" };
  }
  if (["blast-radius", "checking-system-logs", "driving-bb", "durable-boundary-audit"].includes(id)) {
    return { source: "first-party", version: "1" };
  }
  return { source: "https://github.com/mattpocock/skills", version: "1.2.3+6654f6b6" };
}

function admittedSkillRouting(id: AdmittedCapabilitySkillId): Pick<DescriptorInput,
  "roles" | "stages" | "requiredTraits" | "forbiddenTraits" |
  "prerequisites" | "conflicts" | "orderAfter" |
  "evidenceRequirement" | "receiptType" | "evidenceStrength" | "modelPools" | "costClass"> {
  switch (id) {
    case "driving-bb":
      return { roles: ["controller"], stages: ["intake"] };
    case "unslop":
      return {
        roles: ["controller", "planner", "implementation", "documentation", "review"],
        stages: ["communication"],
        forbiddenTraits: ["strict-json"],
      };
    case "technical-writing":
      return {
        roles: ["documentation"],
        stages: ["documentation"],
        forbiddenTraits: ["strict-json"],
      };
    case "clean-code-guard":
    case "test-guard":
      return {
        roles: ["review", "final-review"],
        stages: ["review"],
        evidenceRequirement: "mandatory",
        receiptType: "guard",
        evidenceStrength: "high",
        modelPools: ["standard", "strong"],
      };
    case "docs-guard":
      return {
        roles: ["review", "final-review", "documentation"],
        stages: ["review", "documentation"],
        evidenceRequirement: "mandatory",
        receiptType: "guard",
        evidenceStrength: "high",
        modelPools: ["standard", "strong"],
      };
    case "blast-radius":
      return {
        roles: ["review", "final-review"],
        stages: ["review"],
        evidenceRequirement: "mandatory",
        receiptType: "guard",
        evidenceStrength: "high",
        modelPools: ["standard", "strong"],
      };
    case "pr-writer":
      return {
        roles: ["implementation"],
        stages: ["delivery"],
        receiptType: "worker",
        modelPools: ["fast", "standard"],
      };
    case "durable-boundary-audit":
      return {
        roles: ["implementation", "review", "final-review"],
        stages: ["implementation", "review"],
        evidenceRequirement: "mandatory",
        receiptType: "guard",
        evidenceStrength: "high",
        modelPools: ["standard", "strong"],
      };
    case "checking-system-logs":
      return { roles: ["implementation"], stages: ["diagnosis"], modelPools: ["standard"] };
    case "tdd":
      return {
        roles: ["implementation", "navigator"],
        stages: ["workflow-step"],
        evidenceRequirement: "mandatory",
        receiptType: "worker",
        modelPools: ["fast", "standard", "strong"],
      };
    case "diagnosing-bugs":
      return {
        roles: ["implementation", "navigator"],
        stages: ["workflow-step"],
        modelPools: ["standard", "strong"],
      };
    case "code-review":
      return {
        roles: ["review", "final-review", "navigator"],
        stages: ["workflow-step"],
        evidenceRequirement: "mandatory",
        receiptType: "guard",
        evidenceStrength: "high",
        modelPools: ["standard", "strong"],
      };
    case "writing-for-agents":
      return { roles: ["planner", "documentation", "navigator"], stages: ["workflow-step"] };
    default:
      return ADMITTED_SKILL_BUNDLE[id].invocationClass === "user"
        ? { roles: ["navigator", "owner"], stages: ["workflow-step"] }
        : { roles: ["implementation", "review", "navigator"], stages: ["workflow-step"] };
  }
}

const admittedSkillDescriptors = ADMITTED_CAPABILITY_SKILL_IDS.map((id) => {
  const route = admittedSkillRoute(id);
  const source = admittedSkillSource(id);
  return descriptor({
    id,
    kind: "skill",
    route,
    source: source.source,
    version: source.version,
    sourceDigest: ADMITTED_SKILL_BUNDLE[id].sourceDigest,
    effectClass: "none",
    dataClasses: route === "manual-only" ? ["owner-message", "repository"] : ["repository"],
    workspaces: route === "manual-only" ? ["personal", "managed-worktree"] : ["managed-worktree"],
    permissionModes: ["none"],
    recipes: [],
    ...admittedSkillRouting(id),
  });
});

const liveToolDescriptors = toolDescriptors.map((entry) => descriptor({
  id: entry.id,
  kind: entry.kind,
  source: entry.source,
  version: entry.version,
  sourceDigest: entry.sourceDigest,
  route: entry.route,
  roles: entry.routing.roles,
  recipes: [],
  stages: entry.routing.stages,
  effectClass: entry.effects.class,
  risk: entry.effects.risk,
  dataClasses: entry.effects.dataClasses,
  ownerApproval: entry.authority.ownerApproval,
  egress: entry.authority.egress,
  hosts: entry.authority.hosts,
  workspaces: entry.authority.workspaces,
  permissionModes: entry.authority.permissionModes,
  inputSchema: entry.contract.inputSchema,
  outputSchema: entry.contract.outputSchema,
  timeoutMs: entry.contract.timeoutMs,
  evidenceRequirement: entry.evidence.requirement,
  receiptType: entry.evidence.receiptType,
}));

const liveBundleDescriptors = bundleDescriptors.map((entry) => descriptor({
  id: entry.id,
  kind: entry.kind,
  source: entry.source,
  version: entry.version,
  sourceDigest: entry.sourceDigest,
  route: entry.route,
  roles: entry.routing.roles,
  recipes: [],
  stages: entry.routing.stages,
  prerequisites: entry.composition.prerequisites,
  effectClass: entry.effects.class,
  dataClasses: entry.effects.dataClasses,
  receiptType: entry.evidence.receiptType,
}));

const liveModelPoolDescriptors = modelPoolDescriptors.map((entry) => descriptor({
  id: entry.id,
  kind: entry.kind,
  source: entry.source,
  version: entry.version,
  sourceDigest: entry.sourceDigest,
  route: entry.route,
  roles: entry.routing.roles,
  recipes: [],
  stages: entry.routing.stages,
  effectClass: entry.effects.class,
  risk: entry.effects.risk,
  dataClasses: entry.effects.dataClasses,
  egress: entry.authority.egress,
  hosts: entry.authority.hosts,
  workspaces: entry.authority.workspaces,
  permissionModes: entry.authority.permissionModes,
  costClass: entry.economics.costClass,
  modelPools: entry.economics.modelPools,
  evidenceRequirement: entry.evidence.requirement,
  receiptType: entry.evidence.receiptType,
  evidenceStrength: entry.evidence.strength,
}));

export const CAPABILITY_CATALOG = validateCapabilityCatalog([
  ...admittedSkillDescriptors,
  ...liveToolDescriptors,
  ...liveBundleDescriptors,
  ...liveModelPoolDescriptors,
  ...liveConnectorDescriptors,
]);

export const CAPABILITY_BY_ID: ReadonlyMap<string, CapabilityDescriptor> = new Map(
  CAPABILITY_CATALOG.map((entry) => [entry.id, entry]),
);

export function capabilityDescriptorById(id: string, digest?: string): CapabilityDescriptor | undefined {
  const live = CAPABILITY_BY_ID.get(id);
  const historical = HISTORICAL_RECIPE_CAPABILITY_BY_ID.get(id);
  if (digest !== undefined) {
    if (live?.digest === digest) return live;
    if (historical?.digest === digest) return historical;
    return undefined;
  }
  return live ?? historical;
}

export const CAPABILITY_REGISTRY_DIGEST = catalogDigests(CAPABILITY_CATALOG).registry;
export const CAPABILITY_GRAPH_DIGEST = catalogDigests(CAPABILITY_CATALOG).graph;

export type CapabilityFindingPolicy = Readonly<{
  capabilityId: string;
  descriptorDigest: string;
  descriptorVersion: string;
  policyRevision: number;
  defaultDisposition: "must_fix" | "advisory";
  mustFixRuleIds: readonly string[];
  advisoryRuleIds: readonly string[];
  requirementIds: readonly string[];
  policyDigest: string;
}>;

const FINDING_POLICY_DEFAULTS: Readonly<Record<string, Readonly<{
  defaultDisposition: CapabilityFindingPolicy["defaultDisposition"];
  mustFixRuleIds: readonly string[];
  advisoryRuleIds: readonly string[];
}>>> = Object.freeze({
  "code-review": Object.freeze({ defaultDisposition: "advisory", mustFixRuleIds: [], advisoryRuleIds: [] }),
  "blast-radius": Object.freeze({ defaultDisposition: "advisory", mustFixRuleIds: [], advisoryRuleIds: [] }),
  "clean-code-guard": Object.freeze({
    defaultDisposition: "advisory",
    mustFixRuleIds: ["clean.rule-1"],
    advisoryRuleIds: ["clean.rule-10"],
  }),
  "docs-guard": Object.freeze({
    defaultDisposition: "advisory",
    mustFixRuleIds: ["docs.rule-1"],
    advisoryRuleIds: ["docs.rule-10"],
  }),
  "test-guard": Object.freeze({
    defaultDisposition: "advisory",
    mustFixRuleIds: ["tests.rule-1"],
    advisoryRuleIds: ["tests.rule-10"],
  }),
  "durable-boundary-audit": Object.freeze({ defaultDisposition: "advisory", mustFixRuleIds: [], advisoryRuleIds: [] }),
});

export function admittedCapabilityFindingPolicy(input: Readonly<{
  capabilityId: string;
  descriptorDigest: string;
  requirementIds: readonly string[];
}>): CapabilityFindingPolicy | null {
  const descriptor = capabilityDescriptorById(input.capabilityId, input.descriptorDigest) ??
    CAPABILITY_BY_ID.get(input.capabilityId);
  const defaults = FINDING_POLICY_DEFAULTS[input.capabilityId];
  const admission = SKILL_ADMISSION_BY_ID.get(input.capabilityId as AdmittedCapabilitySkillId);
  const admittedDescriptorDigests = [admission?.bundleDescriptorDigest, descriptor?.digest, CAPABILITY_BY_ID.get(input.capabilityId)?.digest].filter(
    (digest): digest is string => digest !== undefined,
  );
  if (
    !descriptor || descriptor.status !== "admitted" || descriptor.evidence.receiptType !== "guard" ||
    !admittedDescriptorDigests.includes(input.descriptorDigest) || !defaults ||
    input.requirementIds.length > 100 || new Set(input.requirementIds).size !== input.requirementIds.length
  ) return null;
  const requirementIds = [...input.requirementIds].sort((left, right) => left.localeCompare(right));
  const policyRevision = 1;
  const policyDigest = stableDigest(JSON.stringify({
    capabilityId: descriptor.id,
    descriptorDigest: input.descriptorDigest,
    descriptorVersion: descriptor.version,
    policyRevision,
    defaultDisposition: defaults.defaultDisposition,
    mustFixRuleIds: defaults.mustFixRuleIds,
    advisoryRuleIds: defaults.advisoryRuleIds,
    requirementIds,
  }));
  return Object.freeze({
    capabilityId: descriptor.id,
    descriptorDigest: input.descriptorDigest,
    descriptorVersion: descriptor.version,
    policyRevision,
    defaultDisposition: defaults.defaultDisposition,
    mustFixRuleIds: Object.freeze([...defaults.mustFixRuleIds]),
    advisoryRuleIds: Object.freeze([...defaults.advisoryRuleIds]),
    requirementIds: Object.freeze(requirementIds),
    policyDigest,
  });
}

/**
 * Compatibility classification for callers that still expose the old helper.
 * Navigator assessment uses the versioned ledger policy, including evidence and
 * requirement inputs, through `NavigatorFindingLedger.assess`.
 */
type CompatibilityFindingInput = Readonly<{
  capabilityId: string;
  ruleId: string;
} & Partial<Record<string, unknown>>>;

function isFindingSeverity(value: unknown): value is FindingDispositionInput["severity"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low";
}

function compatibilityFindingObservation(input: CompatibilityFindingInput): FindingDispositionInput | null {
  const severity = input.severity === undefined ? "low" : input.severity;
  const requirementId = input.requirementId === undefined ? null : input.requirementId;
  const evidenceClass = input.evidenceClass === undefined ? "review" : input.evidenceClass;
  return isBoundedPolicyKey(input.ruleId) && isFindingSeverity(severity) &&
    (requirementId === null || isBoundedPolicyKey(requirementId)) && isBoundedPolicyKey(evidenceClass)
    ? { ruleId: input.ruleId, severity, requirementId, evidenceClass }
    : null;
}

function compatibilityRequirementIds(input: CompatibilityFindingInput): readonly string[] | null {
  const requirementIds = input.requirementIds;
  if (requirementIds === undefined) return [];
  return Array.isArray(requirementIds) && requirementIds.length <= 100 && requirementIds.every(isBoundedPolicyKey)
    ? requirementIds
    : null;
}

function compatibilityDescriptorDigest(
  input: CompatibilityFindingInput,
  admission: SkillAdmissionEvidence | undefined,
  descriptor: CapabilityDescriptor,
): string | null {
  if (input.descriptorDigest === undefined) return admission?.bundleDescriptorDigest ?? descriptor.digest;
  return typeof input.descriptorDigest === "string" ? input.descriptorDigest : null;
}

export function compatibilityCapabilityFindingDisposition(
  input: CompatibilityFindingInput,
): "must_fix" | "advisory" | null {
  if (!isBoundedPolicyKey(input.capabilityId)) return null;
  const descriptor = CAPABILITY_BY_ID.get(input.capabilityId);
  if (!descriptor) return null;
  const admission = SKILL_ADMISSION_BY_ID.get(input.capabilityId as AdmittedCapabilitySkillId);
  const finding = compatibilityFindingObservation(input);
  const requirementIds = compatibilityRequirementIds(input);
  const descriptorDigest = compatibilityDescriptorDigest(input, admission, descriptor);
  if (!finding || requirementIds === null || descriptorDigest === null) return null;
  const policy = admittedCapabilityFindingPolicy({
    capabilityId: input.capabilityId,
    descriptorDigest,
    requirementIds,
  });
  if (!policy) return null;
  return evaluateFindingDisposition(finding, policy);
}

export function capabilityCatalogView(engine: "recipe-v1" | "navigator-v1"): Readonly<{
  byId: ReadonlyMap<string, CapabilityDescriptor>;
  registryDigest: string;
  graphDigest: string;
}> {
  return engine === "recipe-v1"
    ? {
      byId: HISTORICAL_RECIPE_CAPABILITY_BY_ID,
      registryDigest: HISTORICAL_RECIPE_REGISTRY_DIGEST,
      graphDigest: HISTORICAL_RECIPE_GRAPH_DIGEST,
    }
    : {
      byId: CAPABILITY_BY_ID,
      registryDigest: CAPABILITY_REGISTRY_DIGEST,
      graphDigest: CAPABILITY_GRAPH_DIGEST,
    };
}
