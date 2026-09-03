import { describe, expect, it } from "vitest";
import {
  capabilityDescriptorSchema,
  descriptorDigest,
  validateCapabilityCatalog,
  type CapabilityDescriptor,
} from "../src/capabilities/contracts";
import {
  ADMITTED_CAPABILITY_SKILL_IDS,
  CAPABILITY_CATALOG,
  CAPABILITY_GRAPH_DIGEST,
  CAPABILITY_REGISTRY_DIGEST,
  CONTROLLER_BUNDLE_TOOLS,
  CONTROLLER_METADATA_TOOL_IDS,
  CONTROLLER_PROTOCOL_TOOL_IDS,
  HISTORICAL_RECIPE_CAPABILITY_CATALOG,
  HISTORICAL_RECIPE_GRAPH_DIGEST,
  HISTORICAL_RECIPE_REGISTRY_DIGEST,
} from "../src/capabilities/catalog";
import { CONTROLLER_TOOL_NAMES } from "../src/controller/capability-policy";

const EXPECTED_SKILL_ROUTES = {
  "ask-matt": "manual-only",
  "blast-radius": "worker",
  "checking-system-logs": "worker",
  "clean-code-guard": "worker",
  "code-review": "worker",
  "codebase-design": "worker",
  "diagnosing-bugs": "worker",
  "docs-guard": "worker",
  "domain-modeling": "worker",
  "driving-bb": "worker",
  "durable-boundary-audit": "worker",
  "grill-me": "manual-only",
  "grill-with-docs": "manual-only",
  grilling: "worker",
  handoff: "manual-only",
  implement: "manual-only",
  "improve-codebase-architecture": "manual-only",
  "pr-writer": "worker",
  prototype: "worker",
  research: "worker",
  "resolving-merge-conflicts": "worker",
  "setup-matt-pocock-skills": "manual-only",
  "show-me": "worker",
  tdd: "worker",
  teach: "manual-only",
  "technical-writing": "worker",
  "test-guard": "worker",
  "to-questionnaire": "manual-only",
  "to-spec": "manual-only",
  "to-tickets": "manual-only",
  triage: "manual-only",
  unslop: "worker",
  "wait-what": "manual-only",
  wayfinder: "manual-only",
  wizard: "worker",
  "writing-for-agents": "worker",
} as const;

function cloneCatalog(): CapabilityDescriptor[] {
  return structuredClone(CAPABILITY_CATALOG) as CapabilityDescriptor[];
}

function redigest(descriptor: CapabilityDescriptor): CapabilityDescriptor {
  return { ...descriptor, digest: descriptorDigest(descriptor) };
}

describe("capability catalog", () => {
  it("freezes the historical recipe registry while the live catalog admits 36 navigator skills", () => {
    expect(HISTORICAL_RECIPE_REGISTRY_DIGEST)
      .toBe("d14130f744f1ca484beec08d8956a20e16db854b88a304f9576fcc79bdaa0481");
    expect(HISTORICAL_RECIPE_GRAPH_DIGEST)
      .toBe("665deccc825d74de0d814e94a3799ea50aab2d18176ea6aacbc779651eebf64e");
    expect(CAPABILITY_REGISTRY_DIGEST).not.toBe(HISTORICAL_RECIPE_REGISTRY_DIGEST);
    expect(CAPABILITY_GRAPH_DIGEST).not.toBe(HISTORICAL_RECIPE_GRAPH_DIGEST);
    expect(HISTORICAL_RECIPE_CAPABILITY_CATALOG.some((entry) => entry.id === "using-superpowers")).toBe(true);
    expect(CAPABILITY_CATALOG.some((entry) => entry.id === "using-superpowers")).toBe(false);
    expect(CAPABILITY_CATALOG.some((entry) => entry.kind === "recipe")).toBe(false);
    expect(CAPABILITY_CATALOG.some((entry) => entry.kind === "native-adapter")).toBe(false);
  });

  it("describes every bundled skill exactly once with its approved route", () => {
    const skills = CAPABILITY_CATALOG.filter((entry) => entry.kind === "skill");
    expect(skills.map((entry) => entry.id).sort())
      .toEqual([...ADMITTED_CAPABILITY_SKILL_IDS].sort());
    expect(Object.fromEntries(skills.map((entry) => [entry.id, entry.route])))
      .toEqual(EXPECTED_SKILL_ROUTES);
  });

  it("contains one valid descriptor for every catalog identity", () => {
    expect(() => validateCapabilityCatalog(CAPABILITY_CATALOG)).not.toThrow();
    expect(new Set(CAPABILITY_CATALOG.map((entry) => entry.id)).size)
      .toBe(CAPABILITY_CATALOG.length);
    for (const descriptor of CAPABILITY_CATALOG) {
      expect(capabilityDescriptorSchema.parse(descriptor)).toEqual(descriptor);
      expect(descriptorDigest(descriptor)).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("rejects unknown descriptor fields and missing proof contracts", () => {
    const valid = CAPABILITY_CATALOG[0];
    expect(() => capabilityDescriptorSchema.parse({ ...valid, surprise: true })).toThrow();
    const { evidence: _evidence, ...withoutEvidence } = valid;
    expect(() => capabilityDescriptorSchema.parse(withoutEvidence)).toThrow(/evidence/i);
  });

  it("rejects duplicate identities and unknown prerequisites", () => {
    const duplicate = cloneCatalog();
    duplicate.push(structuredClone(duplicate[0]));
    expect(() => validateCapabilityCatalog(duplicate)).toThrow(/duplicate/i);

    const unknown = cloneCatalog();
    unknown[0] = redigest({
      ...unknown[0],
      composition: {
        ...unknown[0].composition,
        prerequisites: ["missing-capability"],
      },
    });
    expect(() => validateCapabilityCatalog(unknown)).toThrow(/prerequisite/i);
  });

  it("rejects a descriptor whose canonical digest was tampered with", () => {
    const catalog = cloneCatalog();
    catalog[0] = { ...catalog[0], digest: "0".repeat(64) };
    expect(() => validateCapabilityCatalog(catalog)).toThrow(/digest mismatch/i);
  });

  it("rejects asymmetric conflicts and ordering cycles", () => {
    const asymmetric = cloneCatalog();
    asymmetric[0] = redigest({
      ...asymmetric[0],
      composition: { ...asymmetric[0].composition, conflicts: [asymmetric[1].id] },
    });
    expect(() => validateCapabilityCatalog(asymmetric)).toThrow(/symmetric/i);

    const cyclic = cloneCatalog();
    cyclic[0] = redigest({
      ...cyclic[0],
      composition: { ...cyclic[0].composition, orderAfter: [cyclic[1].id] },
    });
    cyclic[1] = redigest({
      ...cyclic[1],
      composition: { ...cyclic[1].composition, orderAfter: [cyclic[0].id] },
    });
    expect(() => validateCapabilityCatalog(cyclic)).toThrow(/cycle/i);
  });

  it("rejects a declared substitute with weaker evidence protection", () => {
    const catalog = cloneCatalog();
    const source = catalog.findIndex((entry) => entry.id === "clean-code-guard");
    const substitute = catalog.findIndex((entry) => entry.id === "docs-guard");
    catalog[source] = redigest({
      ...catalog[source],
      composition: { ...catalog[source].composition, substitutes: [catalog[substitute].id] },
      evidence: { ...catalog[source].evidence, strength: "high" },
    });
    catalog[substitute] = redigest({
      ...catalog[substitute],
      evidence: { ...catalog[substitute].evidence, strength: "standard" },
    });
    expect(() => validateCapabilityCatalog(catalog)).toThrow(/substitute.*weaker/i);
  });

  it("hashes canonical descriptor content rather than insertion order", () => {
    const descriptor = CAPABILITY_CATALOG[0];
    const reordered = Object.fromEntries(Object.entries(descriptor).reverse()) as CapabilityDescriptor;
    expect(descriptorDigest(reordered)).toBe(descriptorDigest(descriptor));
    expect(descriptorDigest({ ...descriptor, digest: "0".repeat(64) }))
      .toBe(descriptorDigest(descriptor));
  });
});

it("leaves no controller tool unreachable from every profile", () => {
  // The fault this exists to stop, which shipped three times before it did:
  // a tool declared in the allowlist, implemented, documented, and tested,
  // but absent from every bundle. Profiles select bundles and bundles carry
  // tools, so such a tool reaches no session at all. Nothing else notices —
  // the registration-versus-manifest check compares the allowlist against
  // itself, and a grep for the name finds all of it.
  const bundled = new Set<string>(Object.values(CONTROLLER_BUNDLE_TOOLS).flat());
  bundled.add("telegram_agent_connector_inspect");
  const alwaysOn = new Set<string>([
    ...CONTROLLER_METADATA_TOOL_IDS,
    ...CONTROLLER_PROTOCOL_TOOL_IDS,
  ]);
  const unreachable = (CONTROLLER_TOOL_NAMES as readonly string[])
    .filter((name) => !bundled.has(name) && !alwaysOn.has(name));

  expect(unreachable).toEqual([]);
});
