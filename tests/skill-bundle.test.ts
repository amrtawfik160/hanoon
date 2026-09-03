import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { ROLE_SKILLS } from "../src/agent-skills/role-resolver";
import { CAPABILITY_CATALOG } from "../src/capabilities/catalog";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const registeredRoots = [
  "skills/guards",
  "skills/matt-pocock/engineering",
  "skills/matt-pocock/productivity",
  "skills/hanoon",
  "skills/pstack",
  "skills/humanlayer",
] as const;
const lockedRoots = [
  "skills/guards",
  "skills/matt-pocock",
  "skills/hanoon",
  "skills/pstack",
  "skills/humanlayer",
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
  workflowKit?: Readonly<Record<string, string>>;
  discoveryKit?: Readonly<Record<string, string>>;
  guardKit: Readonly<Record<string, string>>;
  hanoonKit: Readonly<Record<string, string>>;
  pstackKit: Readonly<Record<string, string>>;
  humanlayerKit: Readonly<Record<string, string>>;
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
  test("registers exactly one runtime source for every skill id", () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      bb: { skills: unknown };
    };

    expect(manifest.bb.skills).toEqual(registeredRoots);
    const candidates = pluginSkillCandidates();
    expect([...candidates.values()].every((paths) => paths.length === 1)).toBe(true);
    expect(candidates.get("grill-with-docs")?.[0]).toBe("skills/matt-pocock/engineering/grill-with-docs/SKILL.md");
    expect(candidates.get("domain-modeling")?.[0]).toBe("skills/matt-pocock/engineering/domain-modeling/SKILL.md");
    expect(candidates.get("grilling")?.[0]).toBe("skills/matt-pocock/productivity/grilling/SKILL.md");
    expect(candidates.has("using-superpowers")).toBe(false);
    expect(candidates.has("proportional-development-workflow")).toBe(false);
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

  test("locks the contracted 35-skill catalog without leftover workflow, discovery, or delivery kits", () => {
    const lock = readLock();
    const catalogSkills = new Map(
      CAPABILITY_CATALOG
        .filter((descriptor) => descriptor.kind === "skill")
        .map((descriptor) => [descriptor.id, descriptor]),
    );

    expect(lock.skills).toHaveLength(35);
    expect(lock.legacySkills).toEqual([]);
    expect(lock.shadowedSkills).toEqual([]);
    expect(lock.workflowKit).toBeUndefined();
    expect(lock.discoveryKit).toBeUndefined();
    expect(catalogSkills.size).toBe(35);
    expect(catalogSkills.has("pr-writer")).toBe(false);
    for (const skill of lock.skills) {
      const descriptor = catalogSkills.get(skill.id);
      expect(descriptor, `${skill.id} has a live descriptor`).toBeDefined();
      expect(descriptor?.sourceDigest).toBe(skill.sourceDigest);
    }
    expect(catalogSkills.has("using-superpowers")).toBe(false);
    expect(catalogSkills.has("writing-plans")).toBe(false);
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
    expect(lock.workflowKit).toBeUndefined();
    expect(lock.discoveryKit).toBeUndefined();
    expect(lock.guardKit.licensePath).toBe("skills/guards/LICENSE");
    expect(lock.hanoonKit.licensePath).toBe("skills/hanoon/NOTICE");
    expect(lock.pstackKit.licensePath).toBe("skills/pstack/LICENSE");
    expect(lock.humanlayerKit).toMatchObject({
      revision: "3c2629142c5d437428269b1b722b08c0b87f574d",
      sourceUrl: "https://github.com/humanlayer/skills",
      license: "MIT",
      licensePath: "skills/humanlayer/LICENSE",
    });
  });

  test("ships every source license and notice", () => {
    for (const licensePath of [
      "skills/guards/LICENSE",
      "skills/matt-pocock/LICENSE",
      "skills/hanoon/NOTICE",
      "skills/pstack/LICENSE",
      "skills/humanlayer/LICENSE",
    ]) {
      const absolute = join(repositoryRoot, licensePath);
      expect(existsSync(absolute), `${licensePath} exists`).toBe(true);
      expect(readFileSync(absolute, "utf8").length).toBeGreaterThan(500);
    }
  });

  test("keeps navigator role profiles executable from the contracted catalog", () => {
    const lock = readLock();
    const executableIds = new Set(lock.skills.map((skill) => skill.id));

    for (const id of Object.values(ROLE_SKILLS).flat()) {
      expect(executableIds, `${id} remains executable`).toContain(id);
    }
    expect(ROLE_SKILLS.planner).toEqual(["unslop", "writing-for-agents", "docs-guard"]);
    expect(ROLE_SKILLS.critic).toEqual(["unslop"]);
  });
});
