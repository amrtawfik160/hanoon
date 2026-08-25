import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ADMITTED_CAPABILITY_SKILL_IDS,
  SKILL_ADMISSION_CATALOG,
  skillInvocationAllowed,
} from "../src/capabilities/catalog";

const repositoryRoot = new URL("..", import.meta.url).pathname;

type LockedSkill = Readonly<{
  id: string;
  sourceDigest: string;
  descriptorDigest: string;
  invocationClass: "user" | "model";
}>;

function lockedSkills(): readonly LockedSkill[] {
  const lock = JSON.parse(readFileSync(join(repositoryRoot, "skills/skills.lock.json"), "utf8")) as {
    skills: LockedSkill[];
  };
  return lock.skills;
}

describe("skill invocation policy", () => {
  test("binds the deterministic 35-skill admission catalog to the bundle lock", () => {
    const locked = lockedSkills();
    const byId = new Map<string, (typeof SKILL_ADMISSION_CATALOG)[number]>(
      SKILL_ADMISSION_CATALOG.map((entry) => [entry.id, entry]),
    );

    expect(ADMITTED_CAPABILITY_SKILL_IDS).toEqual(locked.map((skill) => skill.id).sort());
    expect(SKILL_ADMISSION_CATALOG).toHaveLength(35);
    expect(byId.size).toBe(35);
    for (const skill of locked) {
      expect(byId.get(skill.id)).toMatchObject({
        id: skill.id,
        sourceDigest: skill.sourceDigest,
        bundleDescriptorDigest: skill.descriptorDigest,
        invocationClass: skill.invocationClass,
      });
    }
  });

  test.each([
    ["ask-matt", false, true, true],
    ["implement", false, true, true],
    ["technical-writing", false, true, true],
    ["diagnosing-bugs", true, true, true],
    ["code-review", true, true, true],
  ] as const)("enforces the invocation routes for %s", (id, general, navigator, owner) => {
    expect(skillInvocationAllowed(id, "general-worker")).toBe(general);
    expect(skillInvocationAllowed(id, "navigator")).toBe(navigator);
    expect(skillInvocationAllowed(id, "owner")).toBe(owner);
  });

  test("rejects legacy, unknown, and do-prefixed ids from every admitted route", () => {
    for (const id of ["using-superpowers", "proportional-development-workflow", "do-anything", "unknown"]) {
      expect(skillInvocationAllowed(id, "general-worker")).toBe(false);
      expect(skillInvocationAllowed(id, "navigator")).toBe(false);
      expect(skillInvocationAllowed(id, "owner")).toBe(false);
    }
  });
});
