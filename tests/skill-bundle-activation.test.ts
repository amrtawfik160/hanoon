import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterEach, expect, test } from "vitest";
import { activatePlugin } from "../server";
import { resolvePluginRoot, verifySkillBundle } from "../src/agent-skills/bundle-integrity.js";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const temporaryRoots: string[] = [];

type MutableSkillRecord = {
  id: string;
  skillPath: string;
  sourcePath: string;
  source: string;
  sourceRevision: string;
  sourceDigest: string;
  descriptorDigest: string;
  license: string;
  invocationClass: "user" | "model";
};

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
  skills: MutableSkillRecord[];
  legacySkills: MutableSkillRecord[];
  shadowedSkills: MutableSkillRecord[];
}) => void): void {
  const lockPath = join(root, "skills/skills.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    files: Array<{ path: string; sha256: string }>;
    skills: MutableSkillRecord[];
    legacySkills: MutableSkillRecord[];
    shadowedSkills: MutableSkillRecord[];
  };
  mutate(lock);
  lock.files.sort((left, right) => left.path.localeCompare(right.path));
  lock.skills.sort((left, right) => left.id.localeCompare(right.id));
  lock.legacySkills.sort((left, right) => left.id.localeCompare(right.id));
  lock.shadowedSkills.sort((left, right) => left.id.localeCompare(right.id));
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function redigestSkillRecord(record: MutableSkillRecord): void {
  record.descriptorDigest = createHash("sha256").update(JSON.stringify({
    id: record.id,
    invocationClass: record.invocationClass,
    license: record.license,
    skillPath: record.skillPath,
    source: record.source,
    sourceDigest: record.sourceDigest,
    sourcePath: record.sourcePath,
    sourceRevision: record.sourceRevision,
  })).digest("hex");
}

function updateSkillDigests(root: string, path: string): void {
  updateLockedDigest(root, path);
  updateLock(root, (lock) => {
    const record = [...lock.skills, ...lock.legacySkills, ...lock.shadowedSkills]
      .find((skill) => skill.skillPath === path);
    if (!record) throw new Error(`Missing test skill record for ${path}`);
    record.sourceDigest = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
    redigestSkillRecord(record);
  });
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

function fillLockedFileCount(root: string, targetCount: number): void {
  const directory = join(root, "skills/guards/clean-code-guard/file-boundary");
  mkdirSync(directory);
  updateLock(root, (lock) => {
    const filesToAdd = targetCount - lock.files.length;
    if (filesToAdd < 0) throw new Error(`Fixture already exceeds ${targetCount} locked files`);
    for (let index = 0; index < filesToAdd; index += 1) {
      const path = `skills/guards/clean-code-guard/file-boundary/file-${String(index).padStart(3, "0")}.txt`;
      writeFileSync(join(root, path), "x");
      lock.files.push({ path, sha256: createHash("sha256").update("x").digest("hex") });
    }
  });
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

  expect(verified.skillIds).toHaveLength(35);
  expect(verified.admittedSkillIds).toHaveLength(35);
  expect(verified.legacySkillIds).toHaveLength(0);
  expect(verified.skillIds).toEqual(expect.arrayContaining([
    "blast-radius",
    "clean-code-guard",
    "docs-guard",
    "domain-modeling",
    "grill-with-docs",
    "grilling",
    "technical-writing",
    "test-guard",
    "pr-writer",
    "unslop",
    "ask-matt",
    "code-review",
    "diagnosing-bugs",
    "implement",
    "tdd",
    "wayfinder",
  ]));
  expect(verified.skillIds).not.toEqual(expect.arrayContaining([
    "brainstorming",
    "proportional-development-workflow",
    "writing-skills",
    "using-superpowers",
  ]));
  expect(verified.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
});

test("rejects leftover workflow-kit or discovery-kit lock fields", () => {
  const root = copiedBundleRoot();
  const lockPath = join(root, "skills/skills.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
  lock.workflowKit = { version: "6.3.0" };
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  expect(() => verifySkillBundle(root)).toThrow(
    "Skill bundle integrity error: malformed lock schema",
  );
});

test("rejects every do-prefixed admitted skill id", () => {
  const root = copiedBundleRoot();
  updateLock(root, (lock) => {
    const record = lock.skills.find((skill) => skill.id === "ask-matt");
    if (!record) throw new Error("Missing ask-matt fixture record");
    record.id = "do-anything";
    redigestSkillRecord(record);
  });

  expect(() => verifySkillBundle(root)).toThrow(
    "Skill bundle integrity error: forbidden admitted skill id: do-anything",
  );
});

test("rejects a changed promoted invocation class", () => {
  const root = copiedBundleRoot();
  updateLock(root, (lock) => {
    const record = lock.skills.find((skill) => skill.id === "ask-matt");
    if (!record) throw new Error("Missing ask-matt fixture record");
    record.invocationClass = "model";
    redigestSkillRecord(record);
  });

  expect(() => verifySkillBundle(root)).toThrow(
    "Skill bundle integrity error: required skill catalog differs",
  );
});

test("rejects promoted OpenAI metadata that makes a user skill implicit", () => {
  const root = copiedBundleRoot();
  const metadataPath = "skills/matt-pocock/engineering/ask-matt/agents/openai.yaml";
  const absolute = join(root, metadataPath);
  writeFileSync(absolute, readFileSync(absolute, "utf8").replace(
    "allow_implicit_invocation: false",
    "allow_implicit_invocation: true",
  ));
  updateLockedDigest(root, metadataPath);

  expect(() => verifySkillBundle(root)).toThrow(
    "Skill bundle integrity error: user-invoked skill ask-matt does not disable implicit invocation",
  );
});

test("rejects a missing promoted support file", () => {
  const root = copiedBundleRoot();
  rmSync(join(root, "skills/matt-pocock/engineering/ask-matt/PHASE-BOUNDARIES.md"));

  expect(() => verifySkillBundle(root)).toThrow(
    "Skill bundle integrity error: missing skills/matt-pocock/engineering/ask-matt/PHASE-BOUNDARIES.md",
  );
});

test("rejects a locked skill beneath an unsupported Matt Pocock bucket", () => {
  const root = copiedBundleRoot();
  const skillPath = "skills/matt-pocock/unsupported/unreviewed/SKILL.md";
  const contents = "---\nname: unreviewed\ndescription: fixture\n---\n";
  mkdirSync(dirname(join(root, skillPath)), { recursive: true });
  writeFileSync(join(root, skillPath), contents);
  updateLock(root, (lock) => {
    lock.files.push({ path: skillPath, sha256: createHash("sha256").update(contents).digest("hex") });
  });

  expect(() => verifySkillBundle(root)).toThrow(
    `Skill bundle integrity error: unsupported Matt Pocock bundle path: ${skillPath}`,
  );
});

test("rejects a changed promoted license even when the file lock is recomputed", () => {
  const root = copiedBundleRoot();
  const licensePath = "skills/matt-pocock/LICENSE";
  const absolute = join(root, licensePath);
  writeFileSync(absolute, `${readFileSync(absolute, "utf8")}changed\n`);
  updateLockedDigest(root, licensePath);

  expect(() => verifySkillBundle(root)).toThrow(
    "Skill bundle integrity error: Matt Pocock license digest differs",
  );
});

test("rejects an admitted id that collides with the legacy compatibility catalog", () => {
  const root = copiedBundleRoot();
  updateLock(root, (lock) => {
    const source = lock.skills.find((skill) => skill.id === "unslop");
    if (!source) throw new Error("Missing unslop fixture record");
    const record: MutableSkillRecord = {
      ...source,
      id: "ask-matt",
      skillPath: "skills/guards/ask-matt-legacy/SKILL.md",
      sourcePath: "skills/guards/ask-matt-legacy/SKILL.md",
    };
    redigestSkillRecord(record);
    lock.legacySkills.push(record);
  });

  expect(() => verifySkillBundle(root)).toThrow(
    "Skill bundle integrity error: legacy skill collides with admitted id: ask-matt",
  );
});

test.each([
  ["inline", "[escape](../../pstack/LICENSE)"],
  ["reference-style", "[escape]: ../../pstack/LICENSE"],
])("rejects a %s Markdown resource that escapes its registered skill root", (_variant, link) => {
  const root = copiedBundleRoot();
  const skillPath = "skills/guards/clean-code-guard/SKILL.md";
  const absolutePath = join(root, skillPath);
  writeFileSync(absolutePath, `${readFileSync(absolutePath, "utf8")}\n${link}\n`);
  updateSkillDigests(root, skillPath);

  expect(() => verifySkillBundle(root)).toThrow(
    `Skill bundle integrity error: Markdown link escapes registered skill root: ${skillPath} -> ../../pstack/LICENSE`,
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

test("rejects a symbolic link in an intermediate component beneath a real plugin root", () => {
  const root = copiedBundleRoot();
  const actualSkills = join(root, "in-root-skills");
  renameSync(join(root, "skills"), actualSkills);
  symlinkSync(actualSkills, join(root, "skills"), "dir");

  expect(() => verifySkillBundle(root)).toThrow("Skill bundle integrity error: symbolic link is not allowed: skills/skills.lock.json");
});

test.each([
  [640, false],
  [641, true],
])("enforces the total bundle-entry boundary at %i entries", (limit, rejected) => {
  const root = copiedBundleRoot();
  const roots = [
    join(root, "skills/guards"),
    join(root, "skills/delivery"),
    join(root, "skills/matt-pocock"),
    join(root, "skills/hanoon"),
    join(root, "skills/pstack"),
  ];
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
  ["missing admitted id", (root: string) => {
    const prefix = "skills/guards/clean-code-guard/";
    rmSync(join(root, "skills/guards/clean-code-guard"), { recursive: true, force: true });
    updateLock(root, (lock) => {
      lock.skills = lock.skills.filter((skill) => skill.id !== "clean-code-guard");
      lock.files = lock.files.filter((file) => !file.path.startsWith(prefix));
    });
  }],
  ["extra admitted id", (root: string) => {
    const skillPath = "skills/guards/unreviewed/SKILL.md";
    mkdirSync(dirname(join(root, skillPath)), { recursive: true });
    writeFileSync(join(root, skillPath), "---\nname: unreviewed\ndescription: fixture\n---\n");
    updateLock(root, (lock) => {
      const sourceDigest = createHash("sha256").update(readFileSync(join(root, skillPath))).digest("hex");
      const record: MutableSkillRecord = {
        id: "unreviewed",
        skillPath,
        sourcePath: skillPath,
        source: "https://github.com/amElnagdy/guard-skills",
        sourceRevision: "vendored",
        sourceDigest,
        descriptorDigest: "",
        license: "MIT",
        invocationClass: "model",
      };
      redigestSkillRecord(record);
      lock.skills.push(record);
      lock.files.push({ path: skillPath, sha256: createHash("sha256").update(readFileSync(join(root, skillPath))).digest("hex") });
    });
  }],
  ["guard id in the hanoon root", (root: string) => {
    const oldPrefix = "skills/guards/clean-code-guard/";
    const newPrefix = "skills/hanoon/clean-code-guard/";
    renameSync(join(root, oldPrefix), join(root, newPrefix));
    updateLock(root, (lock) => {
      const skill = lock.skills.find((record) => record.id === "clean-code-guard");
      if (!skill) throw new Error("Missing clean-code-guard fixture record");
      skill.skillPath = `${newPrefix}SKILL.md`;
      skill.source = "first-party";
      skill.license = "first-party";
      redigestSkillRecord(skill);
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

test("accepts exactly 512 locked bundle files", () => {
  const root = copiedBundleRoot();
  fillLockedFileCount(root, 512);

  expect(() => verifySkillBundle(root)).not.toThrow();
});

test("rejects discovered bundle file 513 before unlocked-file validation", () => {
  const root = copiedBundleRoot();
  fillLockedFileCount(root, 512);
  writeFileSync(join(root, "skills/guards/clean-code-guard/file-boundary/file-513.txt"), "x");

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

test("root discovery propagates a nested package.json filesystem read error", () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-agent-root-discovery-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "package.json"), '{"name":"bb-plugin-telegram-agent"}\n');
  const nested = join(root, "nested", "dist");
  const nestedPackage = join(root, "nested", "package.json");
  mkdirSync(nested, { recursive: true });
  writeFileSync(nestedPackage, '{"name":"not-the-plugin"}\n');
  const modulePath = join(repositoryRoot, "src/agent-skills/bundle-integrity.js");
  const harness = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { pathToFileURL } from "node:url";
    const originalRead = fs.readFileSync.bind(fs);
    fs.readFileSync = (path, options) => {
      if (String(path) === ${JSON.stringify(nestedPackage)}) {
        throw Object.assign(new Error("injected package read failure"), { code: "EACCES" });
      }
      return originalRead(path, options);
    };
    syncBuiltinESMExports();
    const { resolvePluginRoot } = await import(pathToFileURL(${JSON.stringify(modulePath)}).href + "?read-error");
    resolvePluginRoot(pathToFileURL(${JSON.stringify(join(nested, "server.js"))}).href);
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", harness], { encoding: "utf8" });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("injected package read failure");
  expect(result.stderr).not.toContain("malformed package.json");
});
