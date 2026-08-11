import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { afterEach, expect, test } from "vitest";
import { activatePlugin } from "../server";
import { resolvePluginRoot, verifySkillBundle } from "../src/agent-skills/bundle-integrity.js";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copiedBundleRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "telegram-agent-skills-"));
  temporaryRoots.push(root);
  cpSync(join(repositoryRoot, "package.json"), join(root, "package.json"));
  cpSync(join(repositoryRoot, "skills"), join(root, "skills"), { recursive: true });
  return root;
}

function updateLockedDigest(root: string, path: string): void {
  const lockPath = join(root, "skills/skills.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    files: Array<{ path: string; sha256: string }>;
  };
  const record = lock.files.find((entry) => entry.path === path);
  if (!record) throw new Error(`Missing test lock record for ${path}`);
  record.sha256 = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function updateLock(root: string, mutate: (lock: {
  files: Array<{ path: string; sha256: string }>;
  skills: Array<{ id: string; skillPath: string; source: string; license: string }>;
}) => void): void {
  const lockPath = join(root, "skills/skills.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    files: Array<{ path: string; sha256: string }>;
    skills: Array<{ id: string; skillPath: string; source: string; license: string }>;
  };
  mutate(lock);
  lock.files.sort((left, right) => left.path.localeCompare(right.path));
  lock.skills.sort((left, right) => left.id.localeCompare(right.id));
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
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

function fillEntryLimit(roots: readonly string[], parent: string, limit: number): void {
  mkdirSync(parent);
  const remaining = limit - entryCount(roots);
  for (let index = 0; index < remaining; index += 1) mkdirSync(join(parent, `entry-${index}`));
}

function extendDepth(parent: string, currentDepth: number, targetDepth: number): void {
  let current = parent;
  for (let depth = currentDepth + 1; depth <= targetDepth; depth += 1) {
    current = join(current, `depth-${depth}`);
    mkdirSync(current);
  }
}

test("rejects a corrupted locked skill before the BB host is accessed", async () => {
  const root = copiedBundleRoot();
  const corruptedPath = "skills/guards/clean-code-guard/SKILL.md";
  const absolutePath = join(root, corruptedPath);
  writeFileSync(absolutePath, `${readFileSync(absolutePath, "utf8")}\ncorrupted`);
  let hostAccesses = 0;
  const host = new Proxy({}, {
    get() {
      hostAccesses += 1;
      throw new Error("BB host was accessed before integrity verification");
    },
  }) as BbPluginApi;

  expect(() => activatePlugin(host, root)).toThrow(
    `Skill bundle digest mismatch: ${corruptedPath}`,
  );
  expect(hostAccesses).toBe(0);
});

test("verifies the real committed bundle", () => {
  const verified = verifySkillBundle(repositoryRoot);

  expect(verified.skillIds).toHaveLength(17);
  expect(verified.skillIds).toEqual(expect.arrayContaining([
    "brainstorming",
    "clean-code-guard",
    "docs-guard",
    "test-guard",
    "writing-skills",
  ]));
  expect(verified.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
});

test.each([
  ["inline", "[escape](../../workflow-kit/LICENSE)"],
  ["reference-style", "[escape]: ../../workflow-kit/LICENSE"],
])("rejects a %s Markdown resource that escapes its registered skill root", (_variant, link) => {
  const root = copiedBundleRoot();
  const skillPath = "skills/guards/clean-code-guard/SKILL.md";
  const absolutePath = join(root, skillPath);
  writeFileSync(absolutePath, `${readFileSync(absolutePath, "utf8")}\n${link}\n`);
  updateLockedDigest(root, skillPath);

  expect(() => verifySkillBundle(root)).toThrow(
    `Skill bundle integrity error: Markdown link escapes registered skill root: ${skillPath} -> ../../workflow-kit/LICENSE`,
  );
});

test.each(["root", "ancestor"])("rejects a symbolic link in a plugin-root %s component before bundle reads", (position) => {
  const parent = mkdtempSync(join(tmpdir(), "telegram-agent-root-link-"));
  temporaryRoots.push(parent);
  const actualRoot = position === "root" ? join(parent, "actual") : join(parent, "actual", "plugin");
  mkdirSync(actualRoot, { recursive: true });
  cpSync(join(repositoryRoot, "package.json"), join(actualRoot, "package.json"));
  cpSync(join(repositoryRoot, "skills"), join(actualRoot, "skills"), { recursive: true });
  const link = join(parent, "linked");
  symlinkSync(position === "root" ? actualRoot : dirname(actualRoot), link, "dir");
  const linkedRoot = position === "root" ? link : join(link, "plugin");

  expect(() => verifySkillBundle(linkedRoot)).toThrow(/symbolic link is not allowed in plugin root/);
});

test("rejects a descendant symbolic link beneath a real plugin root", () => {
  const root = copiedBundleRoot();
  const link = join(root, "skills/guards/clean-code-guard/license-link");
  symlinkSync(join(root, "skills/workflow-kit/LICENSE"), link);

  expect(() => verifySkillBundle(root)).toThrow("Skill bundle integrity error: symbolic link is not allowed: skills/guards/clean-code-guard/license-link");
});

test.each([
  [640, false],
  [641, true],
])("enforces the total bundle-entry boundary at %i entries", (limit, rejected) => {
  const root = copiedBundleRoot();
  const roots = [join(root, "skills/workflow-kit"), join(root, "skills/guards")];
  fillEntryLimit(roots, join(root, "skills/guards/clean-code-guard/excess"), limit);

  if (rejected) {
    expect(() => verifySkillBundle(root)).toThrow("Skill bundle integrity error: bundle entry count exceeds 640");
  } else {
    expect(() => verifySkillBundle(root)).not.toThrow();
  }
});

test.each([
  [32, false],
  [33, true],
])("enforces the bundle-depth boundary at depth %i", (depth, rejected) => {
  const root = copiedBundleRoot();
  extendDepth(join(root, "skills/guards/clean-code-guard"), 1, depth);

  if (rejected) {
    expect(() => verifySkillBundle(root)).toThrow("Skill bundle integrity error: bundle depth exceeds 32");
  } else {
    expect(() => verifySkillBundle(root)).not.toThrow();
  }
});

test.each([
  ["missing workflow id", (root: string) => {
    const prefix = "skills/workflow-kit/brainstorming/";
    rmSync(join(root, "skills/workflow-kit/brainstorming"), { recursive: true, force: true });
    updateLock(root, (lock) => {
      lock.skills = lock.skills.filter((skill) => skill.id !== "brainstorming");
      lock.files = lock.files.filter((file) => !file.path.startsWith(prefix));
    });
  }],
  ["extra workflow id", (root: string) => {
    const skillPath = "skills/workflow-kit/unreviewed/SKILL.md";
    mkdirSync(dirname(join(root, skillPath)), { recursive: true });
    writeFileSync(join(root, skillPath), "---\nname: unreviewed\ndescription: fixture\n---\n");
    updateLock(root, (lock) => {
      lock.skills.push({ id: "unreviewed", skillPath, source: "https://github.com/obra/superpowers", license: "MIT" });
      lock.files.push({ path: skillPath, sha256: createHash("sha256").update(readFileSync(join(root, skillPath))).digest("hex") });
    });
  }],
  ["guard id in the workflow root", (root: string) => {
    const oldPrefix = "skills/guards/clean-code-guard/";
    const newPrefix = "skills/workflow-kit/clean-code-guard/";
    renameSync(join(root, oldPrefix), join(root, newPrefix));
    updateLock(root, (lock) => {
      const skill = lock.skills.find((record) => record.id === "clean-code-guard");
      if (!skill) throw new Error("Missing clean-code-guard fixture record");
      skill.skillPath = `${newPrefix}SKILL.md`;
      skill.source = "https://github.com/obra/superpowers";
      skill.license = "MIT";
      for (const file of lock.files) {
        if (file.path.startsWith(oldPrefix)) file.path = `${newPrefix}${file.path.slice(oldPrefix.length)}`;
      }
    });
  }],
])("rejects a catalog with %s", (_scenario, mutate) => {
  const root = copiedBundleRoot();
  mutate(root);

  expect(() => verifySkillBundle(root)).toThrow("Skill bundle integrity error: required skill catalog differs");
});

test("rejects an oversized discovered bundle tree before hashing locked files", () => {
  const root = copiedBundleRoot();
  const directory = join(root, "skills/guards/clean-code-guard/excess");
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < 460; index += 1) {
    writeFileSync(join(directory, `extra-${String(index).padStart(3, "0")}.txt`), "x");
  }

  expect(() => verifySkillBundle(root)).toThrow("Skill bundle integrity error: bundle file count exceeds 512");
});

test.each([
  ["duplicate name keys", "---\nname: clean-code-guard\nname: clean-code-guard\ndescription: fixture\n---\n"],
  ["a literal-block fake name", "---\ndescription: |\nname: clean-code-guard\n---\n"],
])("rejects %s in skill frontmatter", (_label, contents) => {
  const root = copiedBundleRoot();
  const skillPath = "skills/guards/clean-code-guard/SKILL.md";
  writeFileSync(join(root, skillPath), contents);
  updateLockedDigest(root, skillPath);

  expect(() => verifySkillBundle(root)).toThrow("Skill bundle integrity error: malformed frontmatter");
});

test("root discovery skips only malformed package JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-agent-root-discovery-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "package.json"), '{"name":"bb-plugin-telegram-agent"}\n');
  const nested = join(root, "nested", "dist");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, "nested", "package.json"), "{malformed\n");

  expect(resolvePluginRoot(pathToFileURL(join(nested, "server.js")).href)).toBe(root);
});

test("root discovery propagates a non-regular package.json read failure", () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-agent-root-discovery-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "package.json"), '{"name":"bb-plugin-telegram-agent"}\n');
  const nested = join(root, "nested", "dist");
  mkdirSync(join(root, "nested", "package.json"), { recursive: true });
  mkdirSync(nested, { recursive: true });

  expect(() => resolvePluginRoot(pathToFileURL(join(nested, "server.js")).href)).toThrow(/not a regular file/);
});

test("root discovery rejects an oversized package.json before parsing it", () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-agent-root-discovery-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "package.json"), '{"name":"bb-plugin-telegram-agent"}\n');
  const nested = join(root, "nested", "dist");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, "nested", "package.json"), JSON.stringify({
    name: "bb-plugin-telegram-agent",
    padding: "x".repeat(256 * 1024),
  }));

  expect(() => resolvePluginRoot(pathToFileURL(join(nested, "server.js")).href)).toThrow(/file exceeds 262144 bytes/);
});

test("bundle verification propagates package.json filesystem read errors", () => {
  const root = copiedBundleRoot();
  const modulePath = join(repositoryRoot, "src/agent-skills/bundle-integrity.js");
  const harness = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { pathToFileURL } from "node:url";
    const originalRead = fs.readFileSync.bind(fs);
    fs.readFileSync = (path, options) => {
      if (String(path) === ${JSON.stringify(join(root, "package.json"))}) {
        throw Object.assign(new Error("injected package read failure"), { code: "EACCES" });
      }
      return originalRead(path, options);
    };
    syncBuiltinESMExports();
    const { verifySkillBundle } = await import(pathToFileURL(${JSON.stringify(modulePath)}).href + "?read-error");
    verifySkillBundle(${JSON.stringify(root)});
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", harness], { encoding: "utf8" });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("injected package read failure");
  expect(result.stderr).not.toContain("malformed package.json");
});
