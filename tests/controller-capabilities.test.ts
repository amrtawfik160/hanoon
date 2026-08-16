import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
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

it("partitions all 23 domain tools exactly once and keeps metadata and protocol separate", () => {
  const partition = Object.values(CONTROLLER_TOOL_BUNDLES).flat();

  expect(partition).toHaveLength(23);
  expect(new Set(partition)).toEqual(new Set(CONTROLLER_DOMAIN_TOOL_IDS));
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
  ["create a thread and send it these constraints", ["core-observation", "thread-control"]],
  ["remember this preference", ["core-observation", "memory"]],
  ["watch that thread until it is idle", ["core-observation", "monitoring"]],
  ["delegate these independent tasks", ["core-observation", "operations"]],
] as const)("selects the least controller bundles for %s", (text, expected) => {
  expect(selectControllerBundles(text)).toEqual(expected);
});

it.each(permittedBundleCombinations.map((bundleIds) => [bundleIds]))(
  "always projects protocol tools exactly once for %j",
  (bundleIds) => {
    const selected = controllerToolsForBundles(bundleIds);
    const selectedDomainTools = new Set(bundleIds.flatMap((bundleId) => CONTROLLER_TOOL_BUNDLES[bundleId]));
    const expectedDomainTools = CONTROLLER_DOMAIN_TOOL_IDS.filter((toolId) => selectedDomainTools.has(toolId));

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

it("loads manual discovery skills only for an explicit slash invocation", () => {
  expect(controllerSkillsForTurn("Help me think this through")).toEqual([
    "driving-bb",
    "human-friendly-coding-communication",
    "proportional-development-workflow",
  ]);
  for (const command of ["/grill-with-docs", "/grilling", "/domain-modeling"]) {
    expect(controllerSkillsForTurn(`${command} design the workflow`)).toEqual([
      "driving-bb",
      "human-friendly-coding-communication",
      "proportional-development-workflow",
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
