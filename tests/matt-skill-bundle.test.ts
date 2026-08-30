import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repositoryRoot = new URL("..", import.meta.url).pathname;

const userInvoked = [
  "ask-matt",
  "grill-me",
  "grill-with-docs",
  "handoff",
  "implement",
  "improve-codebase-architecture",
  "setup-matt-pocock-skills",
  "teach",
  "to-questionnaire",
  "to-spec",
  "to-tickets",
  "triage",
  "wait-what",
  "wayfinder",
  "technical-writing",
] as const;

const modelInvoked = [
  "code-review",
  "codebase-design",
  "diagnosing-bugs",
  "domain-modeling",
  "grilling",
  "prototype",
  "research",
  "resolving-merge-conflicts",
  "tdd",
  "wizard",
  "writing-for-agents",
] as const;

const retained = [
  "blast-radius",
  "checking-system-logs",
  "clean-code-guard",
  "docs-guard",
  "driving-bb",
  "durable-boundary-audit",
  "pr-writer",
  "test-guard",
  "unslop",
] as const;

type SkillRecord = Readonly<{
  id: string;
  skillPath: string;
  sourcePath: string;
  source: string;
  sourceRevision: string;
  license: string;
  invocationClass: "user" | "model";
}>;

type SkillLock = Readonly<{
  schemaVersion: number;
  mattPocockKit: Readonly<{
    version: string;
    revision: string;
    sourceUrl: string;
    license: string;
    licensePath: string;
    manifestPath: string;
    licenseSha256: string;
    manifestSha256: string;
  }>;
  skills: readonly SkillRecord[];
  files: readonly Readonly<{ path: string; sha256: string }>[];
}>;

function lock(): SkillLock {
  return JSON.parse(readFileSync(join(repositoryRoot, "skills/skills.lock.json"), "utf8")) as SkillLock;
}

describe("pinned Matt Pocock skill portfolio", () => {
  test("registers promoted bucket roots without a discovery root", () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      bb: { skills: string[] };
    };

    expect(manifest.bb.skills).toContain("skills/matt-pocock/engineering");
    expect(manifest.bb.skills).toContain("skills/matt-pocock/productivity");
    expect(manifest.bb.skills).not.toContain("skills/discovery");
    expect(manifest.bb.skills).not.toContain("skills/workflow-kit");
  });

  test("locks the exact reviewed revision and source artifacts", () => {
    const bundle = lock();

    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.mattPocockKit).toEqual({
      version: "1.2.3",
      revision: "6654f6b60cd9d5be8b54c6fafe44346dabeb3b76",
      sourceUrl: "https://github.com/mattpocock/skills",
      license: "MIT",
      licensePath: "skills/matt-pocock/LICENSE",
      manifestPath: "skills/matt-pocock/UPSTREAM_MANIFEST.json",
      licenseSha256: "0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5",
      manifestSha256: "e531ddc6560515397ac32d93334fa3eb586b6b6bcc2e472c3646641fd3d2b951",
    });
  });

  test("admits exactly 35 unique skills with locked invocation classes", () => {
    const skills = lock().skills;
    const byId = new Map(skills.map((skill) => [skill.id, skill]));

    expect(skills).toHaveLength(35);
    expect(byId.size).toBe(35);
    expect([...byId.keys()].sort()).toEqual([...userInvoked, ...modelInvoked, ...retained].sort());
    for (const id of userInvoked) expect(byId.get(id)?.invocationClass).toBe("user");
    for (const id of [...modelInvoked, ...retained]) expect(byId.get(id)?.invocationClass).toBe("model");
    expect(skills.some((skill) => skill.id.startsWith("do-"))).toBe(false);
  });

  test("preserves every promoted subtree with its reviewed upstream source path", () => {
    const bundle = lock();
    const lockedFiles = new Map(bundle.files.map((file) => [file.path, file.sha256]));
    const promoted = bundle.skills.filter((skill) => skill.source === "https://github.com/mattpocock/skills");

    expect(promoted).toHaveLength(25);
    for (const skill of promoted) {
      expect(skill.sourceRevision).toBe(bundle.mattPocockKit.revision);
      const promotedPath = skill.sourcePath.slice("skills/".length);
      const bundlePath = `skills/matt-pocock/${promotedPath}`;
      expect(skill.skillPath).toBe(`${bundlePath}/SKILL.md`);
      const prefix = `${bundlePath}/`;
      const subtree = [...lockedFiles.keys()].filter((path) => path.startsWith(prefix));
      expect(subtree, `${skill.id} keeps its support files`).not.toHaveLength(0);
      for (const path of subtree) {
        const absolute = join(repositoryRoot, path);
        expect(existsSync(absolute), `${path} exists`).toBe(true);
        expect(statSync(absolute).isFile(), `${path} is regular`).toBe(true);
        expect(createHash("sha256").update(readFileSync(absolute)).digest("hex")).toBe(lockedFiles.get(path));
      }
    }
  });
});
