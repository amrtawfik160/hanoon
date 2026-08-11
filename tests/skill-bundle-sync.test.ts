import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const pinnedSource = "/root/.codex/plugins/cache/superpowers-dev/superpowers/6.2.0";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function syncFixture(): { root: string; source: string; sentinel: string } {
  const root = temporaryRoot("telegram-skill-sync-");
  const source = join(root, "source");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "src", "agent-skills"), { recursive: true });
  mkdirSync(join(root, "skills", "workflow-kit"), { recursive: true });
  mkdirSync(join(source, "skills", "safe"), { recursive: true });
  cpSync(join(repositoryRoot, "scripts/sync-workflow-skills.mjs"), join(root, "scripts/sync-workflow-skills.mjs"));
  cpSync(join(repositoryRoot, "src/agent-skills/frontmatter.js"), join(root, "src/agent-skills/frontmatter.js"));
  cpSync(join(repositoryRoot, "skills/guards"), join(root, "skills/guards"), { recursive: true });
  cpSync(join(pinnedSource, "LICENSE"), join(source, "LICENSE"));
  writeFileSync(join(source, "package.json"), '{"name":"superpowers","version":"6.2.0"}\n');
  writeFileSync(join(source, "skills/safe/SKILL.md"), "---\nname: safe\ndescription: fixture\n---\n");
  const sentinel = join(root, "skills/workflow-kit/sentinel.txt");
  writeFileSync(sentinel, "preserve me");
  writeFileSync(join(root, "skills/skills.lock.json"), "{}\n");
  return { root, source, sentinel };
}

function runSync(root: string, source: string) {
  return spawnSync(
    process.execPath,
    [join(root, "scripts/sync-workflow-skills.mjs"), "--source", source, "--version", "6.2.0"],
    { encoding: "utf8" },
  );
}

test("rejects an existing lock symlink without following its target", () => {
  const { root, source, sentinel } = syncFixture();
  const outside = join(root, "outside-lock.json");
  writeFileSync(outside, "outside remains unchanged");
  rmSync(join(root, "skills/skills.lock.json"));
  symlinkSync(outside, join(root, "skills/skills.lock.json"));

  const result = runSync(root, source);

  expect(result.status).not.toBe(0);
  expect(readFileSync(outside, "utf8")).toBe("outside remains unchanged");
  expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
});

test("publishes staged workflow paths only after the replacement is complete", () => {
  const { root, source } = syncFixture();

  const result = runSync(root, source);
  const lock = readFileSync(join(root, "skills/skills.lock.json"), "utf8");

  expect(result.status).toBe(0);
  expect(lock).toContain('"path": "skills/workflow-kit/safe/SKILL.md"');
  expect(lock).not.toContain(".workflow-kit-stage-");
  expect(existsSync(join(root, "skills/workflow-kit/safe/SKILL.md"))).toBe(true);
});

test.each([
  ["wrong source package identity", (source: string) => writeFileSync(join(source, "package.json"), '{"name":"other","version":"6.2.0"}\n')],
  ["non-MIT source license", (source: string) => writeFileSync(join(source, "LICENSE"), "not the reviewed MIT license\n")],
])("rejects %s before replacing the current vendor bundle", (_label, corruptSource) => {
  const { root, source, sentinel } = syncFixture();
  corruptSource(source);

  const result = runSync(root, source);

  expect(result.status).not.toBe(0);
  expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
});

test("rejects a FIFO source entry before replacing the current vendor bundle", () => {
  const { root, source, sentinel } = syncFixture();
  const fifo = join(source, "skills/safe/blocked.fifo");
  const created = spawnSync("mkfifo", [fifo]);
  expect(created.status).toBe(0);

  const result = runSync(root, source);

  expect(result.status).not.toBe(0);
  expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
  expect(existsSync(join(root, "skills/workflow-kit/sentinel.txt"))).toBe(true);
});

test.each([
  ["duplicate name keys", "---\nname: safe\nname: safe\ndescription: fixture\n---\n"],
  ["a literal-block fake name", "---\ndescription: |\nname: safe\n---\n"],
])("rejects %s in source skill frontmatter before replacing the current vendor bundle", (_label, contents) => {
  const { root, source, sentinel } = syncFixture();
  writeFileSync(join(source, "skills/safe/SKILL.md"), contents);

  const result = runSync(root, source);

  expect(result.status).not.toBe(0);
  expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
});
