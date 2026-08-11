import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";

const repositoryRoot = new URL("..", import.meta.url).pathname;
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
  mkdirSync(join(source, "skills"), { recursive: true });
  cpSync(join(repositoryRoot, "scripts/sync-workflow-skills.mjs"), join(root, "scripts/sync-workflow-skills.mjs"));
  cpSync(join(repositoryRoot, "src/agent-skills/frontmatter.js"), join(root, "src/agent-skills/frontmatter.js"));
  cpSync(join(repositoryRoot, "skills/guards"), join(root, "skills/guards"), { recursive: true });
  cpSync(join(repositoryRoot, "skills/workflow-kit/LICENSE"), join(source, "LICENSE"));
  for (const entry of readdirSync(join(repositoryRoot, "skills/workflow-kit"), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      cpSync(join(repositoryRoot, "skills/workflow-kit", entry.name), join(source, "skills", entry.name), { recursive: true });
    }
  }
  writeFileSync(join(source, "package.json"), '{"name":"superpowers","version":"6.2.0"}\n');
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

function runSyncWithFault(root: string, source: string, fault: "lock-publish" | "backup-cleanup") {
  const script = join(root, "scripts/sync-workflow-skills.mjs");
  const harness = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { pathToFileURL } from "node:url";
    const originalRename = fs.renameSync.bind(fs);
    const originalRemove = fs.rmSync.bind(fs);
    const fault = ${JSON.stringify(fault)};
    if (fault === "lock-publish") {
      fs.renameSync = (from, to) => {
        if (String(from).includes(".workflow-kit-stage-") && String(from).endsWith("skills.lock.json")) {
          originalRename(from, to);
          throw Object.assign(new Error("injected lock publish failure"), { code: "EIO" });
        }
        return originalRename(from, to);
      };
    } else {
      fs.rmSync = (path, options) => {
        if (String(path).includes(".workflow-kit-backup-")) throw Object.assign(new Error("injected backup cleanup failure"), { code: "EIO" });
        return originalRemove(path, options);
      };
    }
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(script)}, "--source", ${JSON.stringify(source)}, "--version", "6.2.0"];
    await import(pathToFileURL(${JSON.stringify(script)}).href + "?fault=" + fault);
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", harness], { encoding: "utf8" });
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
  expect(lock).toContain('"path": "skills/workflow-kit/brainstorming/SKILL.md"');
  expect(lock).not.toContain(".workflow-kit-stage-");
  expect(existsSync(join(root, "skills/workflow-kit/brainstorming/SKILL.md"))).toBe(true);
});

test.each([
  ["missing reviewed workflow skill", (_root: string, source: string) => rmSync(join(source, "skills/brainstorming"), { recursive: true })],
  ["extra workflow skill", (_root: string, source: string) => {
    mkdirSync(join(source, "skills/unreviewed"));
    writeFileSync(join(source, "skills/unreviewed/SKILL.md"), "---\nname: unreviewed\ndescription: fixture\n---\n");
  }],
  ["extra project-owned guard", (root: string) => {
    mkdirSync(join(root, "skills/guards/unreviewed"));
    writeFileSync(join(root, "skills/guards/unreviewed/SKILL.md"), "---\nname: unreviewed\ndescription: fixture\n---\n");
  }],
])("rejects a bundle with %s before replacing the current vendor bundle", (_scenario, mutate) => {
  const { root, source, sentinel } = syncFixture();
  mutate(root, source);

  const result = runSync(root, source);

  expect(result.status).not.toBe(0);
  expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
});

test("ignores excluded repository, dependency, cache, and output trees during preflight and copy", () => {
  const { root, source } = syncFixture();
  for (const segment of [".git", "node_modules", "cache", "output"]) {
    const excluded = join(source, "skills/brainstorming", segment);
    mkdirSync(excluded, { recursive: true });
    writeFileSync(join(excluded, "oversized.bin"), Buffer.alloc(256 * 1024 + 1));
    symlinkSync(join(source, "LICENSE"), join(excluded, "license-link"));
  }

  const result = runSync(root, source);

  expect(result.status).toBe(0);
  for (const segment of [".git", "node_modules", "cache", "output"]) {
    expect(existsSync(join(root, "skills/workflow-kit/brainstorming", segment))).toBe(false);
  }
});

test.each([
  ["an oversized file", (source: string) => writeFileSync(join(source, "skills/brainstorming/oversized.bin"), Buffer.alloc(256 * 1024 + 1))],
  ["more than 512 bundle files", (source: string) => {
    const directory = join(source, "skills/brainstorming/excess");
    mkdirSync(directory);
    for (let index = 0; index < 513; index += 1) writeFileSync(join(directory, `extra-${index}.txt`), "x");
  }],
])("rejects %s before staging or replacing the current vendor bundle", (_scenario, mutate) => {
  const { root, source, sentinel } = syncFixture();
  mutate(source);

  const result = runSync(root, source);

  expect(result.status).not.toBe(0);
  expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
  expect(readdirSync(join(root, "skills")).some((entry) => entry.startsWith(".workflow-kit-stage-"))).toBe(false);
});

test("rolls back both the workflow tree and lock when lock publication fails after its rename", () => {
  const { root, source, sentinel } = syncFixture();

  const result = runSyncWithFault(root, source, "lock-publish");

  expect(result.status).not.toBe(0);
  expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
  expect(readFileSync(join(root, "skills/skills.lock.json"), "utf8")).toBe("{}\n");
});

test("does not roll back a committed workflow and lock when backup deletion fails", () => {
  const { root, source, sentinel } = syncFixture();

  const result = runSyncWithFault(root, source, "backup-cleanup");

  expect(result.status).not.toBe(0);
  expect(existsSync(sentinel)).toBe(false);
  expect(existsSync(join(root, "skills/workflow-kit/brainstorming/SKILL.md"))).toBe(true);
  expect(readFileSync(join(root, "skills/skills.lock.json"), "utf8")).toContain('"id": "brainstorming"');
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
  const fifo = join(source, "skills/brainstorming/blocked.fifo");
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
  writeFileSync(join(source, "skills/brainstorming/SKILL.md"), contents.replaceAll("safe", "brainstorming"));

  const result = runSync(root, source);

  expect(result.status).not.toBe(0);
  expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
});
