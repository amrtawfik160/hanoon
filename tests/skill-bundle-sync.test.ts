import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "telegram-skill-lock-"));
  temporaryRoots.push(root);
  mkdirTree(root);
  return root;
}

function mkdirTree(root: string): void {
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "src", "agent-skills"), { recursive: true });
  cpSync(join(repositoryRoot, "scripts/sync-matt-pocock-skills.mjs"), join(root, "scripts/sync-matt-pocock-skills.mjs"));
  cpSync(join(repositoryRoot, "src/agent-skills/bundle-contract.js"), join(root, "src/agent-skills/bundle-contract.js"));
  cpSync(join(repositoryRoot, "src/agent-skills/frontmatter.js"), join(root, "src/agent-skills/frontmatter.js"));
  cpSync(join(repositoryRoot, "skills"), join(root, "skills"), { recursive: true });
}

function rebuildLock(root: string) {
  return spawnSync(process.execPath, [join(root, "scripts/sync-matt-pocock-skills.mjs"), "--rebuild-lock"], {
    encoding: "utf8",
  });
}

test("rebuild-lock cannot rebuild the lock outside the reviewed-source maintainer gate", () => {
  const root = fixtureRoot();
  const before = readFileSync(join(root, "skills/skills.lock.json"), "utf8");

  const result = rebuildLock(root);

  expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
  expect(`${result.stderr}${result.stdout}`).toMatch(/reviewed-source maintainer sync/u);
  expect(readFileSync(join(root, "skills/skills.lock.json"), "utf8")).toBe(before);
});

test("committed lock still admits 36 skills with no leftover kits", () => {
  const lock = JSON.parse(readFileSync(join(repositoryRoot, "skills/skills.lock.json"), "utf8")) as {
    skills: Array<{ id: string }>;
    legacySkills: unknown[];
    shadowedSkills: unknown[];
    workflowKit?: unknown;
    discoveryKit?: unknown;
  };

  expect(lock.skills).toHaveLength(36);
  expect(lock.legacySkills).toEqual([]);
  expect(lock.shadowedSkills).toEqual([]);
  expect(lock.workflowKit).toBeUndefined();
  expect(lock.discoveryKit).toBeUndefined();
});
