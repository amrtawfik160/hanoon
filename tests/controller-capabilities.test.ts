import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_BY_ID,
  CONTROLLER_DOMAIN_TOOL_IDS,
  CONTROLLER_METADATA_TOOL_IDS,
  CONTROLLER_PROTOCOL_TOOL_IDS,
} from "../src/capabilities/catalog";
import {
  CONTROLLER_BUNDLE_IDS,
  CONTROLLER_MANUAL_DISCOVERY_SKILLS,
  CONTROLLER_TOOL_BUNDLES,
  assessControllerCapabilityDescriptor,
  controllerSkillsForTurn,
  controllerToolsForBundles,
  selectControllerCapabilityProfile,
  selectControllerBundles,
  selectControllerBundlesForConversation,
} from "../src/capabilities/controller-bundles";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";

function pairedStore() {
  const { bb } = createFakePluginHost({ pluginId: "controller-capability-test" });
  const store = openStore(bb.storage, bb.storage.kv, () => 10_000);
  store.createPairingCode(hashSecret("pair-controller-capabilities"), 1_000, 20_000);
  expect(store.pairOwnerWithCode(
    hashSecret("pair-controller-capabilities"),
    "7",
    "7",
    1_001,
  )).toEqual({ ok: true });
  return { bb, store };
}

const permittedBundleCombinations = Array.from(
  { length: 2 ** CONTROLLER_BUNDLE_IDS.length },
  (_, mask) => CONTROLLER_BUNDLE_IDS.filter((_, index) => (mask & (1 << index)) !== 0),
);

it("partitions all 33 domain tools exactly once and keeps metadata and protocol separate", () => {
  const partition = Object.values(CONTROLLER_TOOL_BUNDLES).flat();

  expect(partition).toHaveLength(32);
  expect(new Set([...partition, "telegram_agent_connector_inspect"])).toEqual(new Set(CONTROLLER_DOMAIN_TOOL_IDS));
  expect(new Set(partition).size).toBe(partition.length);
  expect(CONTROLLER_METADATA_TOOL_IDS).toEqual([
    "telegram_agent_capabilities",
    "telegram_agent_request_capability",
  ]);
  expect(CONTROLLER_PROTOCOL_TOOL_IDS).toEqual([
    "telegram_agent_turn_evidence",
    "telegram_agent_respond",
  ]);
  expect(partition).not.toEqual(expect.arrayContaining([...CONTROLLER_PROTOCOL_TOOL_IDS]));
});

it.each([
  ["show job status", ["core-observation"]],
  ["start the approved implementation", ["core-observation", "job-control"]],
  ["merge it", ["core-observation", "job-control"]],
  ["just land it", ["core-observation", "job-control"]],
  ["resume the paused project", ["core-observation", "job-control"]],
  ["fix the checkout crash", ["core-observation", "job-control"]],
  ["add a settings page", ["core-observation", "job-control"]],
  ["ship the feature", ["core-observation", "job-control"]],
  ["create a thread and send it these constraints", ["core-observation", "thread-control"]],
  ["remember this preference", ["core-observation", "memory"]],
  ["watch that thread until it is idle", ["core-observation", "monitoring"]],
  ["delegate these independent tasks", ["core-observation", "operations"]],
] as const)("selects the least controller bundles for %s", (text, expected) => {
  expect(selectControllerBundles(text)).toEqual(expected);
});

// "yes but sent the pr link first" carries no intent a regex can see; the
// intent lives in the offer it accepts, one turn back. The owner said yes to
// "Want me to sort the conflict out and put it back through review?" and the
// turn arrived with observation tools only, so the agent promised the work
// and could not start it.
describe("conversation-aware bundle selection", () => {
  it("gives an affirmative reply to an offer the full fenced toolbox", () => {
    expect(selectControllerBundlesForConversation(
      "yes but sent the pr link first",
      "Want me to sort the conflict out and put it back through review?",
    )).toEqual([...CONTROLLER_BUNDLE_IDS]);
  });

  it("keeps a plain statement after a statement at its own bundles", () => {
    expect(selectControllerBundlesForConversation(
      "show job status",
      "The pipeline finished the build stage.",
    )).toEqual(["core-observation"]);
  });

  it("does not escalate an affirmative when nothing was offered", () => {
    expect(selectControllerBundlesForConversation(
      "yes that reads right",
      "The four docs findings all point at deleted files.",
    )).toEqual(["core-observation"]);
  });

  it("reads intent from the previous answer for a non-affirmative reference", () => {
    expect(selectControllerBundlesForConversation(
      "the second option",
      "I can retry the job now, or wait for the review. Which one?",
    )).toContain("job-control");
  });

  it("survives a previous answer longer than the classifier bound", () => {
    const long = `${"history ".repeat(2_000)}Want me to retry the job?`;
    expect(selectControllerBundlesForConversation("yes", long)).toEqual([...CONTROLLER_BUNDLE_IDS]);
  });

  it("matches plain selection when there is no previous answer", () => {
    expect(selectControllerBundlesForConversation("yes do it", null)).toEqual(["core-observation"]);
  });
});

it.each(permittedBundleCombinations.map((bundleIds) => [bundleIds]))(
  "always projects protocol tools exactly once for %j",
  (bundleIds) => {
    const selected = controllerToolsForBundles(bundleIds);
    const selectedDomainTools = new Set(bundleIds.flatMap((bundleId) => CONTROLLER_TOOL_BUNDLES[bundleId]));
    const expectedDomainTools = [
      ...CONTROLLER_DOMAIN_TOOL_IDS.filter((toolId) => (selectedDomainTools as ReadonlySet<string>).has(toolId)),
      ...(bundleIds.includes("core-observation") ? ["telegram_agent_connector_inspect" as const] : []),
    ];

    expect(selected).toEqual([
      ...expectedDomainTools,
      ...CONTROLLER_METADATA_TOOL_IDS,
      ...CONTROLLER_PROTOCOL_TOOL_IDS,
    ]);
    for (const protocolToolId of CONTROLLER_PROTOCOL_TOOL_IDS) {
      expect(selected.filter((toolId) => toolId === protocolToolId)).toHaveLength(1);
    }
  },
);

it.each([
  ["Inspect the enrolled Convex project", "telegram_agent_convex_project_inspect"],
  ["Inspect the enrolled Vercel project", "telegram_agent_vercel_project_inspect"],
  ["Inspect the enrolled Vercel browser session", "telegram_agent_browser_vercel_project_inspect"],
] as const)("selects the exact connector assignment for %s", (inputText, capabilityId) => {
  const selection = selectControllerCapabilityProfile(inputText, ["core-observation"]);

  expect(selection.assignments).toEqual(expect.arrayContaining([
    expect.objectContaining({ capabilityId, capabilityKind: "connector" }),
  ]));
  expect(selection.assignments.filter((entry) => entry.capabilityKind === "connector")).toHaveLength(1);
});

it("loads manual discovery skills only for an explicit slash invocation", () => {
    expect(controllerSkillsForTurn("Help me think this through")).toEqual([
    "driving-bb",
    "unslop",
  ]);
  for (const command of ["/grill-with-docs", "/grilling", "/domain-modeling"]) {
    expect(controllerSkillsForTurn(`${command} design the workflow`)).toEqual([
      "driving-bb",
      "unslop",
      ...CONTROLLER_MANUAL_DISCOVERY_SKILLS,
    ]);
  }
  expect(selectControllerCapabilityProfile("/grill-with-docs design the workflow").assignments
    .filter((entry) => entry.capabilityKind === "skill")
    .map((entry) => entry.capabilityId)).toEqual(expect.arrayContaining([...CONTROLLER_MANUAL_DISCOVERY_SKILLS]));
});

it("permits only admitted low-risk bundle exposure changes", () => {
  const admitted = CAPABILITY_BY_ID.get("controller-bundle-job-control");
  if (!admitted) throw new Error("missing controller bundle descriptor");

  expect(assessControllerCapabilityDescriptor(admitted)).toEqual({ allowed: true });
  expect(assessControllerCapabilityDescriptor({
    ...admitted,
    effects: { ...admitted.effects, class: "write" },
  })).toEqual({ allowed: false, reasonCode: "side_effect_change" });
  expect(assessControllerCapabilityDescriptor({
    ...admitted,
    authority: { ...admitted.authority, credentials: true },
  })).toEqual({ allowed: false, reasonCode: "credentials_required" });
  expect(assessControllerCapabilityDescriptor({
    ...admitted,
    authority: { ...admitted.authority, egress: true },
  })).toEqual({ allowed: false, reasonCode: "egress_change" });
  expect(assessControllerCapabilityDescriptor({
    ...admitted,
    kind: "native-adapter",
    effects: { ...admitted.effects, class: "orchestrate" },
  })).toEqual({ allowed: false, reasonCode: "orchestration_change" });
});

it("persists one additive bundle expansion and denies a second request", () => {
  const { store } = pairedStore();
  const turn = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 701,
    inputText: "show job status",
    now: 2_000,
  });
  const lease = store.acquireExecutorLease("controller-capability-test", 2_001, 30_000);
  if (!lease.acquired) throw new Error("missing controller capability test lease");
  expect(store.claimNextControllerTurn({
    ownerId: "controller-capability-test",
    generation: lease.generation,
    now: 2_002,
  })?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    ownerId: "controller-capability-test",
    generation: lease.generation,
    now: 2_003,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    ownerId: "controller-capability-test",
    generation: lease.generation,
    now: 2_004,
    turnId: turn.id,
  })).toBe(true);
  const initial = store.getActiveCapabilityProfile("controller_turn", turn.id);

  expect(turn).toMatchObject({
    capabilityContinuationCount: 0,
    capabilityContinuationState: null,
  });
  expect(initial).toMatchObject({ revision: 1, subjectId: turn.id, mode: "active" });
  expect(initial?.assignments.map((entry) => entry.capabilityId)).toEqual(expect.arrayContaining([
    "controller-bundle-core-observation",
    "controller-bundle-metadata",
    ...CONTROLLER_TOOL_BUNDLES["core-observation"],
    ...CONTROLLER_METADATA_TOOL_IDS,
    ...CONTROLLER_PROTOCOL_TOOL_IDS,
  ]));
  for (const protocolToolId of CONTROLLER_PROTOCOL_TOOL_IDS) {
    expect(initial?.assignments).toContainEqual(expect.objectContaining({
      capabilityId: protocolToolId,
      capabilityKind: "tool",
      mandatory: true,
    }));
  }

  const expanded = store.requestControllerCapabilityExpansion({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    expectedProfileId: initial!.id,
    bundleIds: ["thread-control", "job-control"],
    now: 2_100,
  });
  expect(expanded).toMatchObject({
    outcome: "resume_required",
    continuationCount: 1,
    profile: { revision: 2 },
    selectedBundleIds: ["core-observation", "job-control", "thread-control"],
  });
  if (expanded.outcome !== "resume_required") throw new Error("controller capability expansion was denied");
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    capabilityContinuationCount: 1,
    capabilityContinuationState: "requested",
    capabilityProfileRevision: 2,
  });

  expect(store.requestControllerCapabilityExpansion({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    expectedProfileId: expanded.profile.id,
    bundleIds: ["memory"],
    now: 2_200,
  })).toEqual({ outcome: "denied", reasonCode: "expansion_limit" });

  const receipts = store.listCapabilityReceipts(expanded.profile.id, 64);
  expect(receipts.filter((entry) => entry.eventType === "requested").map((entry) => entry.capabilityId))
    .toEqual(expect.arrayContaining([
      "controller-bundle-job-control",
      "controller-bundle-thread-control",
      "controller-bundle-memory",
    ]));
  expect(receipts).toContainEqual(expect.objectContaining({
    capabilityId: "controller-bundle-memory",
    eventType: "denied",
    reasonCode: "expansion_limit",
  }));
});
