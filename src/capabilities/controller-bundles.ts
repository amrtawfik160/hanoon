import type {
  CapabilityModelSelection,
  CapabilityProfile,
} from "../storage/capability-repository";
import {
  CAPABILITY_BY_ID,
  CAPABILITY_GRAPH_DIGEST,
  CAPABILITY_REGISTRY_DIGEST,
  CONTROLLER_BUNDLE_TOOLS,
  CONTROLLER_DOMAIN_TOOL_IDS,
  CONTROLLER_METADATA_TOOL_IDS,
  CONTROLLER_PROTOCOL_TOOL_IDS,
  type CapabilitySkillId,
} from "./catalog";
import type { CapabilityDescriptor } from "./contracts";
import { modelRouteSchema } from "./models";
import type { ControllerToolName } from "../controller/capability-policy";
import {
  PROTECTED_CONNECTOR_OPERATIONS,
  protectedConnectorCapabilityFor,
  type ProtectedConnectorOperation,
} from "../credentials/connector-protocol";

export const DEFAULT_CONTROLLER_CAPABILITY_MODEL: CapabilityModelSelection = Object.freeze({
  pool: "standard",
  providerId: "claude-code",
  modelId: "claude-opus-5[1m]",
  reasoning: "xhigh",
  serviceTier: "default",
});

export const CONTROLLER_TOOL_BUNDLES = {
  "core-observation": CONTROLLER_BUNDLE_TOOLS["core-observation"],
  "job-control": CONTROLLER_BUNDLE_TOOLS["job-control"],
  "thread-control": CONTROLLER_BUNDLE_TOOLS["thread-control"],
  memory: CONTROLLER_BUNDLE_TOOLS.memory,
  monitoring: CONTROLLER_BUNDLE_TOOLS.monitoring,
  operations: CONTROLLER_BUNDLE_TOOLS.operations,
} as const;

export type ControllerToolBundleId = keyof typeof CONTROLLER_TOOL_BUNDLES;

export const CONTROLLER_BUNDLE_IDS = [
  "core-observation",
  "job-control",
  "thread-control",
  "memory",
  "monitoring",
  "operations",
] as const satisfies readonly ControllerToolBundleId[];

export const CONTROLLER_DEFAULT_SKILLS = [
  // The agent is told to use the `bb` CLI for anything its own tools do not
  // cover, and until this was attached it had no description of one command.
  // It is a default rather than an intent match because the need for it shows
  // up mid-turn, once a tool has already come back short.
  //
  // Listed first so this order matches the profile path's, which sorts by
  // capability id: the two ways a turn can be configured should not hand the
  // agent the same skills in two different orders.
  "driving-bb",
  // Unslop is standing, not a match. Conduct and telegram_agent_respond also
  // require it. Do not move it to an intent list.
  "unslop",
] as const satisfies readonly CapabilitySkillId[];

if (!(CONTROLLER_DEFAULT_SKILLS as readonly string[]).includes("unslop")) {
  throw new TypeError("Controller default skills must include unslop");
}

export const CONTROLLER_MANUAL_DISCOVERY_SKILLS = [
  "grill-with-docs",
  "grilling",
  "domain-modeling",
] as const satisfies readonly CapabilitySkillId[];

const BUNDLE_INTENT: Readonly<Record<Exclude<ControllerToolBundleId, "core-observation">, RegExp>> = {
  // The conduct block already names these actions. A turn that asks for them
  // must receive the tools, or the agent can only describe the job pipeline.
  "job-control": /\b(?:start|retry|cancel|steer|adopt)\b[^\n]{0,80}\b(?:job|implementation|pull request|pr)\b|\b(?:implement|implementation)\b|\b(?:merge|land)\b|\bresume\b[^\n]{0,40}\b(?:project|job)\b|\b(?:fix|repair|debug)\b[^\n]{0,80}\b(?:bug|crash|regression|error|failure)\b|\b(?:add|build|create)\b[^\n]{0,80}\b(?:feature|page|flow|endpoint|api|service|system)\b|\b(?:ship|deploy|release)\b/iu,
  "thread-control": /\b(?:create|open|send|message|tell)\b[^\n]{0,60}\bthread\b|\bthread\b[^\n]{0,60}\b(?:send|message|tell)\b/iu,
  memory: /\b(?:remember|recall|forget|memory)\b/iu,
  monitoring: /\b(?:watch|monitor|schedule|cron)\b/iu,
  operations: /\b(?:delegate|delegation|working style|how you work)\b|\b(?:stop|retry)\b[^\n]{0,60}\bthread\b/iu,
};

const MANUAL_DISCOVERY_COMMAND = /(?:^|\s)\/(?:grill-with-docs|grilling|domain-modeling)(?=\s|$)/iu;

function connectorOperationForText(text: string): ProtectedConnectorOperation | null {
  if (/\bvercel\b[\s\S]{0,80}\b(?:browser|session)\b|\b(?:browser|session)\b[\s\S]{0,80}\bvercel\b/iu.test(text)) {
    return "browser.vercel_project.inspect.v1";
  }
  if (/\bvercel\b/iu.test(text)) return "vercel.project.inspect.v1";
  if (/\bconvex\b/iu.test(text)) return "convex.project.inspect.v1";
  return null;
}

function assertBundleIds(values: readonly string[]): asserts values is readonly ControllerToolBundleId[] {
  if (values.length > CONTROLLER_BUNDLE_IDS.length || new Set(values).size !== values.length) {
    throw new TypeError("Controller bundle ids must be a bounded unique set");
  }
  for (const value of values) {
    if (!(CONTROLLER_BUNDLE_IDS as readonly string[]).includes(value)) {
      throw new TypeError(`Unknown controller bundle ${value}`);
    }
  }
}

function orderedBundles(values: ReadonlySet<ControllerToolBundleId>): ControllerToolBundleId[] {
  return CONTROLLER_BUNDLE_IDS.filter((bundleId) => values.has(bundleId));
}

export function selectControllerBundles(text: string): ControllerToolBundleId[] {
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 8_000) {
    throw new TypeError("Controller input must be between 1 and 8000 characters");
  }
  const selected = new Set<ControllerToolBundleId>(["core-observation"]);
  for (const bundleId of CONTROLLER_BUNDLE_IDS) {
    if (bundleId === "core-observation") continue;
    if (BUNDLE_INTENT[bundleId].test(text)) selected.add(bundleId);
  }
  return orderedBundles(selected);
}

const AFFIRMATIVE_REPLY =
  /^\s*(?:yes|yeah|yep|ya|ok(?:ay)?|sure|go ahead|do it|do that|do both|proceed|please do|sounds good|go on|approved?|confirm(?:ed)?)\b/iu;
// Offers sit at the end of an answer, so the tail is where their intent lives.
const PREVIOUS_ANSWER_TAIL_CHARS = 2_000;

/**
 * "yes but sent the pr link first" carries no intent a regex can see. The
 * intent lives in the offer it accepts, one turn back: the agent had just
 * asked "Want me to sort the conflict out and put it back through review?",
 * and the reply arrived with observation tools only, so the agent promised
 * the work and could not start it.
 *
 * An affirmative answering an offer therefore opens the whole fenced toolbox.
 * Selecting a bundle exposes already-fenced tool interfaces, it executes
 * nothing, so breadth here costs safety nothing while a missing tool costs
 * the owner a promise that goes nowhere. Any reply also inherits whatever
 * intent the previous answer itself names, for references like "the second
 * option".
 */
export function selectControllerBundlesForConversation(
  text: string,
  previousResponse: string | null,
): ControllerToolBundleId[] {
  const selected = new Set<ControllerToolBundleId>(selectControllerBundles(text));
  const tail = previousResponse?.slice(-PREVIOUS_ANSWER_TAIL_CHARS).trim() ?? "";
  if (tail.length > 0) {
    for (const bundleId of selectControllerBundles(tail)) selected.add(bundleId);
    if (AFFIRMATIVE_REPLY.test(text) && tail.includes("?")) {
      for (const bundleId of CONTROLLER_BUNDLE_IDS) selected.add(bundleId);
    }
  }
  return orderedBundles(selected);
}

export function controllerSkillsForTurn(text: string): CapabilitySkillId[] {
  return MANUAL_DISCOVERY_COMMAND.test(text)
    ? [...CONTROLLER_DEFAULT_SKILLS, ...CONTROLLER_MANUAL_DISCOVERY_SKILLS]
    : [...CONTROLLER_DEFAULT_SKILLS];
}

export function controllerToolsForBundles(
  rawBundleIds: readonly string[],
): Array<
  | (typeof CONTROLLER_TOOL_BUNDLES)[ControllerToolBundleId][number]
  | "telegram_agent_connector_inspect"
  | (typeof CONTROLLER_METADATA_TOOL_IDS)[number]
  | (typeof CONTROLLER_PROTOCOL_TOOL_IDS)[number]
> {
  assertBundleIds(rawBundleIds);
  const selected = new Set(rawBundleIds);
  const selectedTools = new Set<string>(
    CONTROLLER_BUNDLE_IDS.flatMap((bundleId) =>
      selected.has(bundleId) ? [...CONTROLLER_TOOL_BUNDLES[bundleId]] : []
    ),
  );
  return [
    ...CONTROLLER_DOMAIN_TOOL_IDS.filter((toolId) => selectedTools.has(toolId)),
    ...(selected.has("core-observation") ? ["telegram_agent_connector_inspect" as const] : []),
    ...CONTROLLER_METADATA_TOOL_IDS,
    ...CONTROLLER_PROTOCOL_TOOL_IDS,
  ] as Array<ControllerToolName | (typeof CONTROLLER_METADATA_TOOL_IDS)[number] | (typeof CONTROLLER_PROTOCOL_TOOL_IDS)[number]>;
}

export type ControllerCapabilityCompatibility =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      reasonCode:
        | "not_admitted"
        | "owner_approval_required"
        | "credentials_required"
        | "egress_change"
        | "side_effect_change"
        | "orchestration_change"
        | "risk_change";
    }>;

export function assessControllerCapabilityDescriptor(
  descriptor: CapabilityDescriptor,
): ControllerCapabilityCompatibility {
  if (descriptor.status !== "admitted") return { allowed: false, reasonCode: "not_admitted" };
  if (descriptor.kind !== "bundle" || descriptor.effects.class === "orchestrate") {
    return { allowed: false, reasonCode: "orchestration_change" };
  }
  if (descriptor.authority.ownerApproval !== "never") {
    return { allowed: false, reasonCode: "owner_approval_required" };
  }
  if (descriptor.authority.credentials) return { allowed: false, reasonCode: "credentials_required" };
  if (descriptor.authority.egress) return { allowed: false, reasonCode: "egress_change" };
  if (descriptor.effects.class !== "none") return { allowed: false, reasonCode: "side_effect_change" };
  if (descriptor.effects.risk !== "low") return { allowed: false, reasonCode: "risk_change" };
  return { allowed: true };
}

export type ControllerCapabilityProfileSelection = Readonly<{
  recipeId: string;
  recipeVersion: number;
  registryDigest: string;
  graphDigest: string;
  mode: "active";
  model: CapabilityModelSelection;
  reasonCodes: readonly string[];
  traits: readonly string[];
  bundleIds: readonly ControllerToolBundleId[];
  skills: readonly CapabilitySkillId[];
  assignments: readonly Readonly<{
    capabilityId: string;
    capabilityKind: CapabilityDescriptor["kind"];
    descriptorDigest: string;
    mandatory: boolean;
  }>[];
}>;

function profileAssignments(input: {
  recipeId: string;
  modelPool: CapabilityModelSelection["pool"];
  bundleIds: readonly ControllerToolBundleId[];
  skills: readonly CapabilitySkillId[];
  connectorOperation?: ProtectedConnectorOperation | null;
}): ControllerCapabilityProfileSelection["assignments"] {
  const capabilityIds = new Set<string>([
    ...input.skills,
    `model-pool-${input.modelPool}`,
    "controller-bundle-metadata",
    ...input.bundleIds.map((bundleId) => `controller-bundle-${bundleId}`),
    ...controllerToolsForBundles(input.bundleIds),
    ...(input.connectorOperation ? [protectedConnectorCapabilityFor(input.connectorOperation)] : []),
  ]);
  return [...capabilityIds]
    .sort((left, right) => left.localeCompare(right))
    .map((capabilityId) => {
      const descriptor = CAPABILITY_BY_ID.get(capabilityId);
      if (!descriptor) throw new Error(`Controller profile references unknown capability ${capabilityId}`);
      return {
        capabilityId,
        capabilityKind: descriptor.kind,
        descriptorDigest: descriptor.digest,
        mandatory: descriptor.evidence.requirement === "mandatory",
      };
    });
}

export function selectControllerCapabilityProfile(
  text: string,
  requestedBundleIds: readonly string[] = selectControllerBundles(text),
  model: CapabilityModelSelection = DEFAULT_CONTROLLER_CAPABILITY_MODEL,
): ControllerCapabilityProfileSelection {
  assertBundleIds(requestedBundleIds);
  const selected = new Set<ControllerToolBundleId>(requestedBundleIds);
  selected.add("core-observation");
  const bundleIds = orderedBundles(selected);
  const skills = controllerSkillsForTurn(text);
  const connectorOperation = connectorOperationForText(text);
  return {
    recipeId: "architectural",
    recipeVersion: 1,
    registryDigest: CAPABILITY_REGISTRY_DIGEST,
    graphDigest: CAPABILITY_GRAPH_DIGEST,
    mode: "active",
    model: modelRouteSchema.parse(model),
    reasonCodes: bundleIds.map((id) => `controller_bundle:${id}`)
      .sort((left, right) => left.localeCompare(right)),
    traits: [],
    bundleIds,
    skills,
    assignments: profileAssignments({
      recipeId: "architectural",
      modelPool: model.pool,
      bundleIds,
      skills,
      connectorOperation,
    }),
  };
}

export function controllerBundleIdsFromProfile(profile: CapabilityProfile): ControllerToolBundleId[] {
  const selected = new Set<ControllerToolBundleId>();
  for (const assignment of profile.assignments) {
    const prefix = "controller-bundle-";
    if (!assignment.capabilityId.startsWith(prefix)) continue;
    const bundleId = assignment.capabilityId.slice(prefix.length);
    if (bundleId === "metadata") continue;
    if ((CONTROLLER_BUNDLE_IDS as readonly string[]).includes(bundleId)) {
      selected.add(bundleId as ControllerToolBundleId);
    }
  }
  return orderedBundles(selected);
}

export function expandControllerCapabilityProfile(
  current: CapabilityProfile,
  rawRequestedBundleIds: readonly string[],
): ControllerCapabilityProfileSelection | Readonly<{ denied: string }> {
  if (
    rawRequestedBundleIds.length < 1 || rawRequestedBundleIds.length > CONTROLLER_BUNDLE_IDS.length ||
    new Set(rawRequestedBundleIds).size !== rawRequestedBundleIds.length
  ) {
    throw new TypeError("Controller expansion must contain a bounded unique bundle set");
  }
  if (rawRequestedBundleIds.some((bundleId) => !(CONTROLLER_BUNDLE_IDS as readonly string[]).includes(bundleId))) {
    return { denied: "unknown_bundle" };
  }
  const requestedBundleIds = rawRequestedBundleIds as readonly ControllerToolBundleId[];
  const selected = new Set(controllerBundleIdsFromProfile(current));
  let added = false;
  for (const bundleId of requestedBundleIds) {
    if (selected.has(bundleId)) continue;
    const descriptor = CAPABILITY_BY_ID.get(`controller-bundle-${bundleId}`);
    if (!descriptor) return { denied: "unknown_bundle" };
    const compatible = assessControllerCapabilityDescriptor(descriptor);
    if (!compatible.allowed) return { denied: compatible.reasonCode };
    selected.add(bundleId);
    added = true;
  }
  if (!added) return { denied: "already_selected" };
  const bundleIds = orderedBundles(selected);
  const skills = current.assignments
    .filter((entry): entry is typeof entry & { capabilityId: CapabilitySkillId } => entry.capabilityKind === "skill")
    .map((entry) => entry.capabilityId);
  const connectorOperation = PROTECTED_CONNECTOR_OPERATIONS.find((operation) =>
    current.assignments.some((entry) => entry.capabilityId === protectedConnectorCapabilityFor(operation))
  );
  return {
    recipeId: current.recipeId,
    recipeVersion: current.recipeVersion,
    registryDigest: current.registryDigest,
    graphDigest: current.graphDigest,
    mode: "active",
    model: { ...current.model },
    reasonCodes: [...new Set([...current.reasonCodes, "controller_capability_expanded"])]
      .sort((left, right) => left.localeCompare(right)),
    traits: [...current.traits],
    bundleIds,
    skills,
    assignments: profileAssignments({
      recipeId: current.recipeId,
      modelPool: current.model.pool,
      bundleIds,
      skills,
      connectorOperation,
    }),
  };
}
