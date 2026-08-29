import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const revision = "6654f6b60cd9d5be8b54c6fafe44346dabeb3b76";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; source: string; script: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "matt-skill-sync-"));
  temporaryRoots.push(root);
  const source = join(root, "source");
  const bin = join(root, "bin");
  const script = join(root, "scripts", "sync-matt-pocock-skills.mjs");
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(join(root, "src", "agent-skills"), { recursive: true });
  mkdirSync(join(source, ".claude-plugin"), { recursive: true });
  mkdirSync(join(source, "skills"), { recursive: true });
  mkdirSync(bin);

  cpSync(join(repositoryRoot, "scripts/sync-matt-pocock-skills.mjs"), script);
  cpSync(join(repositoryRoot, "src/agent-skills/bundle-contract.js"), join(root, "src/agent-skills/bundle-contract.js"));
  cpSync(join(repositoryRoot, "src/agent-skills/frontmatter.js"), join(root, "src/agent-skills/frontmatter.js"));
  cpSync(join(repositoryRoot, "skills"), join(root, "skills"), { recursive: true });

  const vendored = join(repositoryRoot, "skills", "matt-pocock");
  cpSync(join(vendored, "LICENSE"), join(source, "LICENSE"));
  cpSync(join(vendored, "UPSTREAM_MANIFEST.json"), join(source, ".claude-plugin", "plugin.json"));
  const lock = JSON.parse(readFileSync(join(repositoryRoot, "skills", "skills.lock.json"), "utf8")) as {
    skills: Array<{ skillPath: string; sourcePath: string; source: string }>;
  };
  for (const skill of lock.skills.filter((entry) => entry.source === "https://github.com/mattpocock/skills")) {
    cpSync(
      dirname(join(repositoryRoot, skill.skillPath)),
      join(source, skill.sourcePath),
      { recursive: true },
    );
  }
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "mattpocock-skills",
    version: "1.2.3",
    license: "MIT",
  }, null, 2) + "\n");

  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2).join(' ');",
    "if (args.endsWith('rev-parse HEAD')) process.stdout.write(process.env.FAKE_GIT_REVISION + '\\n');",
    "else if (args.endsWith('rev-parse --show-toplevel')) process.stdout.write(process.env.FAKE_GIT_SOURCE + '\\n');",
    "else if (args.includes('status --porcelain=v1')) {",
    "  if (process.env.FAKE_GIT_DIRTY === '1') process.stdout.write(' M skills/engineering/ask-matt/SKILL.md\\n');",
    "} else process.exitCode = 1;",
    "",
  ].join("\n"));
  chmodSync(fakeGit, 0o755);
  return { root, source, script, bin };
}

function runSync(input: ReturnType<typeof fixture>, overrides: Readonly<Record<string, string>> = {}) {
  return spawnSync(process.execPath, [
    input.script,
    "--source",
    input.source,
    "--revision",
    overrides.ARGUMENT_REVISION ?? revision,
  ], {
    cwd: input.root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: input.bin + ":" + (process.env.PATH ?? ""),
      FAKE_GIT_SOURCE: input.source,
      FAKE_GIT_REVISION: overrides.FAKE_GIT_REVISION ?? revision,
      FAKE_GIT_DIRTY: overrides.FAKE_GIT_DIRTY ?? "0",
    },
  });
}

function lockText(root: string): string {
  return readFileSync(join(root, "skills", "skills.lock.json"), "utf8");
}

describe("Matt Pocock maintainer sync", () => {
  test("rebuilds the reviewed portfolio and lock from a clean pinned checkout", () => {
    const input = fixture();
    writeFileSync(join(input.root, "skills", "matt-pocock", "stale.txt"), "stale");

    const result = runSync(input);
    const lock = JSON.parse(lockText(input.root)) as {
      skills: Array<{ id: string }>;
      legacySkills: Array<{ id: string }>;
      shadowedSkills: Array<{ id: string }>;
      mattPocockKit: { revision: string };
    };

    expect(result.status, result.stderr).toBe(0);
    expect(lock.skills).toHaveLength(35);
    expect(lock.legacySkills).toHaveLength(15);
    expect(lock.shadowedSkills.map((skill) => skill.id).sort()).toEqual([
      "domain-modeling",
      "grill-with-docs",
      "grilling",
    ]);
    expect(lock.mattPocockKit.revision).toBe(revision);
    expect(() => readFileSync(join(input.root, "skills", "matt-pocock", "stale.txt"))).toThrow();
  });

  test.each([
    ["wrong requested revision", (input: ReturnType<typeof fixture>) =>
      runSync(input, { ARGUMENT_REVISION: "0".repeat(40) })],
    ["wrong checkout head", (input: ReturnType<typeof fixture>) =>
      runSync(input, { FAKE_GIT_REVISION: "0".repeat(40) })],
    ["dirty promoted source", (input: ReturnType<typeof fixture>) =>
      runSync(input, { FAKE_GIT_DIRTY: "1" })],
    ["changed license", (input: ReturnType<typeof fixture>) => {
      writeFileSync(join(input.source, "LICENSE"), "changed\n");
      return runSync(input);
    }],
    ["changed manifest", (input: ReturnType<typeof fixture>) => {
      writeFileSync(join(input.source, ".claude-plugin", "plugin.json"), "{}\n");
      return runSync(input);
    }],
    ["symlinked support file", (input: ReturnType<typeof fixture>) => {
      const path = join(input.source, "skills", "engineering", "ask-matt", "PHASE-BOUNDARIES.md");
      rmSync(path);
      symlinkSync(join(input.source, "LICENSE"), path);
      return runSync(input);
    }],
  ])("rejects %s without replacing the committed bundle", (_scenario, attempt) => {
    const input = fixture();
    const beforeLock = lockText(input.root);
    const provenancePath = join(input.root, "skills", "matt-pocock", "PROVENANCE.json");
    const beforeProvenance = readFileSync(provenancePath, "utf8");

    const result = attempt(input);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Matt Pocock skill sync:");
    expect(lockText(input.root)).toBe(beforeLock);
    expect(readFileSync(provenancePath, "utf8")).toBe(beforeProvenance);
  });
});
