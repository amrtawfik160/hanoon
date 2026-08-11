import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { afterEach, expect, test } from "vitest";
import { activatePlugin } from "../server";
import { verifySkillBundle } from "../src/agent-skills/bundle-integrity.js";

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

test("permits the pinned workflow-kit cross-skill Markdown resources", () => {
  expect(() => verifySkillBundle(repositoryRoot)).not.toThrow();
});

test("rejects a Markdown resource that escapes its registered skill root", () => {
  const root = copiedBundleRoot();
  const skillPath = "skills/guards/clean-code-guard/SKILL.md";
  const absolutePath = join(root, skillPath);
  writeFileSync(absolutePath, `${readFileSync(absolutePath, "utf8")}\n[escape](../../workflow-kit/LICENSE)\n`);
  updateLockedDigest(root, skillPath);

  expect(() => verifySkillBundle(root)).toThrow(
    `Skill bundle integrity error: Markdown link escapes registered skill root: ${skillPath} -> ../../workflow-kit/LICENSE`,
  );
});
