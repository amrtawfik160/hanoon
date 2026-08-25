import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { ROLE_SKILLS } from "../src/agent-skills/role-resolver";
import { CAPABILITY_CATALOG } from "../src/capabilities/catalog";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const registeredRoots = [
  "skills/workflow-kit",
  "skills/guards",
  "skills/delivery",
  "skills/discovery",
  "skills/matt-pocock/engineering",
  "skills/matt-pocock/productivity",
  "skills/hanoon",
  "skills/pstack",
] as const;
const lockedRoots = [
  "skills/workflow-kit",
  "skills/guards",
  "skills/delivery",
  "skills/discovery",
  "skills/matt-pocock",
  "skills/hanoon",
  "skills/pstack",
] as const;

type LockFile = Readonly<{ path: string; sha256: string }>;
type LockSkill = Readonly<{
  id: string;
  skillPath: string;
  source: string;
  sourceDigest: string;
  license: string;
}>;
type SkillLock = Readonly<{
  schemaVersion: number;
  mattPocockKit: Readonly<Record<string, string>>;
  workflowKit: Readonly<Record<string, string>>;
  discoveryKit: Readonly<Record<string, string>>;
  guardKit: Readonly<Record<string, string>>;
  deliveryKit: Readonly<Record<string, string>>;
  hanoonKit: Readonly<Record<string, string>>;
  pstackKit: Readonly<Record<string, string>>;
  skills: readonly LockSkill[];
  legacySkills: readonly LockSkill[];
  shadowedSkills: readonly LockSkill[];
  files: readonly LockFile[];
}>;

function pluginSkillCandidates(): Map<string, string[]> {
  const candidates = new Map<string, string[]>();
  for (const root of registeredRoots) {
    for (const entry of readdirSync(join(repositoryRoot, root), { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(join(repositoryRoot, root, entry.name, "SKILL.md"))) continue;
      candidates.set(entry.name, [...(candidates.get(entry.name) ?? []), `${root}/${entry.name}/SKILL.md`]);
    }
  }
  return candidates;
}

function readLock(): SkillLock {
  return JSON.parse(readFileSync(join(repositoryRoot, "skills/skills.lock.json"), "utf8")) as SkillLock;
}

function recursiveFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return recursiveFiles(path);
    return [relative(repositoryRoot, path).replaceAll("\\", "/")];
  });
}

describe("committed agent skill bundle", () => {
  test("registers exactly one runtime source for every skill id during expansion", () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      bb: { skills: unknown };
    };

    expect(manifest.bb.skills).toEqual(registeredRoots);
    const candidates = pluginSkillCandidates();
    expect([...candidates.values()].every((paths) => paths.length === 1)).toBe(true);
    for (const id of ["domain-modeling", "grill-with-docs", "grilling"]) {
      expect(candidates.get(id)?.[0]).toBe(`skills/discovery/${id}/SKILL.md`);
    }
  });

  test("locks every active, compatibility, and archived bundle file by SHA-256", () => {
    const lock = readLock();
    const locked = lock.files.map((file) => file.path).sort();
    const actual = lockedRoots.flatMap((root) => recursiveFiles(join(repositoryRoot, root))).sort();

    expect(locked).toEqual(actual);
    for (const file of lock.files) {
      const absolute = join(repositoryRoot, file.path);
      expect(existsSync(absolute), `${file.path} exists`).toBe(true);
      expect(statSync(absolute).isFile(), `${file.path} is a file`).toBe(true);
      expect(createHash("sha256").update(readFileSync(absolute)).digest("hex")).toBe(file.sha256);
    }
  });

  test("keeps the exact recipe compatibility descriptors while admitting the new portfolio separately", () => {
    const lock = readLock();
    const catalogSkills = new Map(
      CAPABILITY_CATALOG
        .filter((descriptor) => descriptor.kind === "skill")
        .map((descriptor) => [descriptor.id, descriptor]),
    );
    const retained = lock.skills.filter((skill) => skill.source !== "https://github.com/mattpocock/skills");
    const compatibilityBound = [...lock.legacySkills, ...retained];

    expect(compatibilityBound).toHaveLength(25);
    expect(catalogSkills.size).toBe(28);
    for (const skill of compatibilityBound) {
      const descriptor = catalogSkills.get(skill.id);
      expect(descriptor, `${skill.id} has a compatibility descriptor`).toBeDefined();
      expect(descriptor?.sourceDigest).toBe(skill.sourceDigest);
    }
    for (const id of ["domain-modeling", "grill-with-docs", "grilling"]) {
      expect(catalogSkills.get(id), `${id} keeps its historical recipe descriptor`).toBeDefined();
      expect(lock.shadowedSkills.find((skill) => skill.id === id)?.sourceDigest)
        .toBe(catalogSkills.get(id)?.sourceDigest);
    }
  });

  test("records current and archived source provenance without conflating licenses", () => {
    const lock = readLock();

    expect(lock.schemaVersion).toBe(2);
    expect(lock.mattPocockKit).toMatchObject({
      revision: "6654f6b60cd9d5be8b54c6fafe44346dabeb3b76",
      sourceUrl: "https://github.com/mattpocock/skills",
      license: "MIT",
      licensePath: "skills/matt-pocock/LICENSE",
    });
    expect(lock.workflowKit).toMatchObject({
      version: "6.3.0",
      sourceUrl: "https://github.com/obra/superpowers",
      license: "MIT",
      licensePath: "skills/workflow-kit/LICENSE",
    });
    expect(lock.discoveryKit).toMatchObject({
      revision: "84fdeffd12f2ee307994d1eb6feb48173b6e0502",
      licensePath: "skills/discovery/LICENSE",
    });
    expect(lock.guardKit.licensePath).toBe("skills/guards/LICENSE");
    expect(lock.deliveryKit.licensePath).toBe("skills/delivery/LICENSE");
    expect(lock.hanoonKit.licensePath).toBe("skills/hanoon/NOTICE");
    expect(lock.pstackKit.licensePath).toBe("skills/pstack/LICENSE");
  });

  test("ships every source license and notice", () => {
    for (const licensePath of [
      "skills/workflow-kit/LICENSE",
      "skills/guards/LICENSE",
      "skills/delivery/LICENSE",
      "skills/discovery/LICENSE",
      "skills/matt-pocock/LICENSE",
      "skills/hanoon/NOTICE",
      "skills/pstack/LICENSE",
    ]) {
      const absolute = join(repositoryRoot, licensePath);
      expect(existsSync(absolute), `${licensePath} exists`).toBe(true);
      expect(readFileSync(absolute, "utf8").length).toBeGreaterThan(500);
    }
  });

  test("keeps existing recipe role profiles executable during the expansion", () => {
    const lock = readLock();
    const executableIds = new Set([...lock.skills, ...lock.legacySkills].map((skill) => skill.id));

    for (const id of Object.values(ROLE_SKILLS).flat()) {
      expect(executableIds, `${id} remains executable`).toContain(id);
    }
    expect(ROLE_SKILLS.planner).toEqual(["unslop", "writing-plans", "docs-guard"]);
    expect(ROLE_SKILLS.critic).toEqual(["unslop"]);
  });
});
