import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  cpSync(join(repositoryRoot, "src/agent-skills/bundle-contract.js"), join(root, "src/agent-skills/bundle-contract.js"));
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

function entryCount(paths: readonly string[]): number {
  const pending = [...paths];
  let count = 0;
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path) continue;
    count += 1;
    if (lstatSync(path).isDirectory()) {
      for (const name of readdirSync(path)) pending.push(join(path, name));
    }
  }
  return count;
}

function fileCount(paths: readonly string[]): number {
  const pending = [...paths];
  let count = 0;
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path) continue;
    if (lstatSync(path).isDirectory()) {
      for (const name of readdirSync(path)) pending.push(join(path, name));
    } else {
      count += 1;
    }
  }
  return count;
}

function sourceBundleRoots(root: string, source: string): string[] {
  return [join(source, "LICENSE"), join(source, "skills"), join(root, "skills/guards")];
}

function fillEntryLimit(roots: readonly string[], parent: string, limit: number): void {
  mkdirSync(parent);
  const remaining = limit - entryCount(roots);
  for (let index = 0; index < remaining; index += 1) mkdirSync(join(parent, `entry-${index}`));
}

function fillFileLimit(roots: readonly string[], parent: string, limit: number): void {
  mkdirSync(parent);
  const remaining = limit - fileCount(roots);
  for (let index = 0; index < remaining; index += 1) writeFileSync(join(parent, `file-${index}.txt`), "x");
}

function extendDepth(parent: string, currentDepth: number, targetDepth: number): void {
  let current = parent;
  for (let depth = currentDepth + 1; depth <= targetDepth; depth += 1) {
    current = join(current, `depth-${depth}`);
    mkdirSync(current);
  }
}

function writePackageAtSize(path: string, bytes: number): void {
  const metadata = { name: "superpowers", version: "6.2.0", padding: "" };
  const empty = `${JSON.stringify(metadata)}\n`;
  metadata.padding = "x".repeat(bytes - Buffer.byteLength(empty));
  writeFileSync(path, `${JSON.stringify(metadata)}\n`);
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

test("rejects an oversized bundle file before staging or replacing the current vendor bundle", () => {
  const { root, source, sentinel } = syncFixture();
  writeFileSync(join(source, "skills/brainstorming/oversized.bin"), Buffer.alloc(256 * 1024 + 1));

  const result = runSync(root, source);

  expect(result.status).not.toBe(0);
  expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
  expect(readdirSync(join(root, "skills")).some((entry) => entry.startsWith(".workflow-kit-stage-"))).toBe(false);
});

test.each([
  [512, false],
  [513, true],
])("enforces the bundle-file boundary at %i files before staging", (limit, rejected) => {
  const { root, source, sentinel } = syncFixture();
  fillFileLimit(sourceBundleRoots(root, source), join(source, "skills/brainstorming/excess"), limit);

  const result = runSync(root, source);

  expect(result.status === 0).toBe(!rejected);
  if (rejected) expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
});

test.each([
  [640, false],
  [641, true],
])("enforces the total bundle-entry boundary at %i entries before staging", (limit, rejected) => {
  const { root, source, sentinel } = syncFixture();
  fillEntryLimit(sourceBundleRoots(root, source), join(source, "skills/brainstorming/excess"), limit);

  const result = runSync(root, source);

  expect(result.status === 0).toBe(!rejected);
  if (rejected) {
    expect(result.stderr).toContain("bundle entry count exceeds 640");
    expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
  }
});

test.each([
  [32, false],
  [33, true],
])("enforces the bundle-depth boundary at depth %i before staging", (depth, rejected) => {
  const { root, source, sentinel } = syncFixture();
  extendDepth(join(source, "skills/brainstorming"), 1, depth);

  const result = runSync(root, source);

  expect(result.status === 0).toBe(!rejected);
  if (rejected) {
    expect(result.stderr).toContain("bundle depth exceeds 32");
    expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
  }
});

test.each([
  ["package.json", (source: string) => writePackageAtSize(join(source, "package.json"), 256 * 1024 + 1)],
  ["LICENSE", (source: string) => writeFileSync(join(source, "LICENSE"), Buffer.alloc(256 * 1024 + 1))],
])("rejects an oversized source %s before reading it", (_file, makeOversized) => {
  const { root, source, sentinel } = syncFixture();
  makeOversized(source);

  const result = runSync(root, source);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("file exceeds 262144 bytes");
  expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
});

test("accepts a source package.json exactly at the byte limit", () => {
  const { root, source } = syncFixture();
  writePackageAtSize(join(source, "package.json"), 256 * 1024);

  expect(runSync(root, source).status).toBe(0);
});

test("hashes a source LICENSE exactly at the byte limit", () => {
  const { root, source, sentinel } = syncFixture();
  writeFileSync(join(source, "LICENSE"), Buffer.alloc(256 * 1024));

  const result = runSync(root, source);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("source LICENSE does not match the reviewed MIT license");
  expect(result.stderr).not.toContain("file exceeds");
  expect(readFileSync(sentinel, "utf8")).toBe("preserve me");
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
