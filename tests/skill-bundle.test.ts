import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { ROLE_SKILLS } from "../src/agent-skills/role-resolver";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const workflowIds = [
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
] as const;
const guardIds = ["clean-code-guard", "test-guard", "docs-guard"] as const;
const allIds = [...workflowIds, ...guardIds].sort();

type LockFile = Readonly<{ path: string; sha256: string }>;
type LockSkill = Readonly<{
  id: string;
  skillPath: string;
  source: string;
  license: string;
}>;
type SkillLock = Readonly<{
  schemaVersion: number;
  workflowKit: Readonly<{
    version: string;
    sourceUrl: string;
    license: string;
    licensePath: string;
  }>;
  skills: readonly LockSkill[];
  files: readonly LockFile[];
}>;

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

function skillName(skillFile: string): string | null {
  const contents = readFileSync(skillFile, "utf8");
  const match = /^---\r?\n([\s\S]{0,8192}?)\r?\n---\r?\n/.exec(contents);
  return match?.[1].match(/^name:\s*([^\r\n#]+)\s*$/m)?.[1].trim() ?? null;
}

describe("committed agent skill bundle", () => {
  test("registers exactly the committed skill roots", () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      bb: { skills: unknown };
    };

    expect(manifest.bb.skills).toEqual(["skills/workflow-kit", "skills/guards"]);
  });

  test("contains exactly the reviewed skill catalog with bounded frontmatter names", () => {
    const catalog = ["skills/workflow-kit", "skills/guards"].flatMap((root) =>
      readdirSync(join(repositoryRoot, root), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          id: entry.name,
          file: join(repositoryRoot, root, entry.name, "SKILL.md"),
        })),
    );

    expect(catalog.map((skill) => skill.id).sort()).toEqual(allIds);
    for (const skill of catalog) {
      expect(existsSync(skill.file), `${skill.id} registers a SKILL.md`).toBe(true);
      expect(skillName(skill.file), `${skill.id} has a bounded frontmatter name`).toBe(skill.id);
    }
  });

  test("locks every committed bundle file by SHA-256", () => {
    const lock = readLock();
    const locked = lock.files.map((file) => file.path).sort();
    const actual = ["skills/workflow-kit", "skills/guards"]
      .flatMap((root) => recursiveFiles(join(repositoryRoot, root)))
      .sort();

    expect(locked).toEqual(actual);
    for (const file of lock.files) {
      const absolute = join(repositoryRoot, file.path);
      expect(existsSync(absolute), `${file.path} exists`).toBe(true);
      expect(statSync(absolute).isFile(), `${file.path} is a file`).toBe(true);
      expect(createHash("sha256").update(readFileSync(absolute)).digest("hex")).toBe(file.sha256);
    }
  });

  test("records provenance for workflow-kit and project-owned guards", () => {
    const lock = readLock();

    expect(lock.workflowKit).toEqual({
      version: "6.2.0",
      sourceUrl: "https://github.com/obra/superpowers",
      license: "MIT",
      licensePath: "skills/workflow-kit/LICENSE",
    });
    expect(lock.skills.map((skill) => skill.id).sort()).toEqual(allIds);
    for (const id of workflowIds) {
      expect(lock.skills).toContainEqual({
        id,
        skillPath: `skills/workflow-kit/${id}/SKILL.md`,
        source: "https://github.com/obra/superpowers",
        license: "MIT",
      });
    }
    for (const id of guardIds) {
      expect(lock.skills).toContainEqual({
        id,
        skillPath: `skills/guards/${id}/SKILL.md`,
        source: "project-owned",
        license: "repository",
      });
    }
  });

  test("cross-checks every role-selected skill against the registered manifest", () => {
    const selected = Object.values(ROLE_SKILLS).flat();
    for (const id of selected) expect(allIds, `${id} is registered in the manifest`).toContain(id);
    expect(new Set(ROLE_SKILLS.implementation).size).toBe(ROLE_SKILLS.implementation.length);
    expect(ROLE_SKILLS.planner).toEqual([]);
    expect(ROLE_SKILLS.critic).toEqual([]);
  });
});
