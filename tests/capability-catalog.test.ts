import { describe, expect, it } from "vitest";
import {
  capabilityDescriptorSchema,
  descriptorDigest,
  validateCapabilityCatalog,
  type CapabilityDescriptor,
} from "../src/capabilities/contracts";
import { CAPABILITY_CATALOG } from "../src/capabilities/catalog";

const EXPECTED_SKILL_ROUTES = {
  brainstorming: "worker",
  "clean-code-guard": "worker",
  "dispatching-parallel-agents": "hanoon-native",
  "docs-guard": "worker",
  "domain-modeling": "manual-only",
  "durable-boundary-audit": "worker",
  "executing-plans": "hanoon-native",
  "finishing-a-development-branch": "hanoon-native",
  "grill-with-docs": "manual-only",
  grilling: "manual-only",
  "human-friendly-coding-communication": "worker",
  "pr-writer": "worker",
  "proportional-development-workflow": "worker",
  "receiving-code-review": "worker",
  "requesting-code-review": "hanoon-native",
  "subagent-driven-development": "hanoon-native",
  "systematic-debugging": "worker",
  "test-driven-development": "worker",
  "test-guard": "worker",
  "using-git-worktrees": "hanoon-native",
  "using-superpowers": "hanoon-native",
  "verification-before-completion": "worker",
  "writing-plans": "worker",
  "writing-skills": "worker",
} as const;

function cloneCatalog(): CapabilityDescriptor[] {
  return structuredClone(CAPABILITY_CATALOG) as CapabilityDescriptor[];
}

function redigest(descriptor: CapabilityDescriptor): CapabilityDescriptor {
  return { ...descriptor, digest: descriptorDigest(descriptor) };
}

describe("capability catalog", () => {
  it("describes every bundled skill exactly once with its approved route", () => {
    const skills = CAPABILITY_CATALOG.filter((entry) => entry.kind === "skill");
    expect(skills.map((entry) => entry.id).sort())
      .toEqual(Object.keys(EXPECTED_SKILL_ROUTES).sort());
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
