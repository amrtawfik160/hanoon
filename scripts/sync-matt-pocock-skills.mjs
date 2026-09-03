#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_LIMITS,
  DELIVERY_KIT,
  FORBIDDEN_SKILL_ID_PATTERN,
  GUARD_KIT,
  HANOON_KIT,
  HUMANLAYER_KIT,
  LOCK_PATH,
  LOCK_SCHEMA_VERSION,
  LOCKED_ROOTS,
  MATT_POCOCK_KIT,
  MATT_POCOCK_ROOT,
  PSTACK_KIT,
  REQUIRED_LEGACY_SKILLS,
  REQUIRED_MATT_POCOCK_SKILLS,
  REQUIRED_SHADOWED_SKILLS,
  REQUIRED_SKILLS,
} from "../src/agent-skills/bundle-contract.js";
import { skillFrontmatter } from "../src/agent-skills/frontmatter.js";

const {
  maximumFileBytes: MAX_FILE_BYTES,
  maximumLockBytes: MAX_LOCK_BYTES,
  maximumLockedFiles: MAX_LOCKED_FILES,
  maximumSkills: MAX_SKILLS,
  maximumTreeDepth: MAX_TREE_DEPTH,
  maximumTreeEntries: MAX_TREE_ENTRIES,
} = BUNDLE_LIMITS;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(moduleDirectory, "..");
const skillsRoot = join(pluginRoot, "skills");
const mattDestination = join(pluginRoot, MATT_POCOCK_ROOT);
const lockDestination = join(pluginRoot, LOCK_PATH);

function fail(message) {
  throw new Error(`Matt Pocock skill sync: ${message}`);
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

function pathInside(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function assertRealDirectory(path, label) {
  const absolute = resolve(path);
  const filesystemRoot = parse(absolute).root;
  let current = filesystemRoot;
  for (const component of relative(filesystemRoot, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stats = lstatIfPresent(current);
    if (!stats) fail(`missing ${label}`);
    if (stats.isSymbolicLink()) fail(`symbolic link is not allowed: ${label}`);
  }
  const stats = lstatSync(absolute);
  if (!stats.isDirectory()) fail(`${label} must be a directory`);
  return realpathSync(absolute);
}

function readRegularFile(path, label, maximumBytes = MAX_FILE_BYTES) {
  const stats = lstatIfPresent(path);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) fail(`${label} must be a regular file`);
  if (stats.size > maximumBytes) fail(`file exceeds ${maximumBytes} bytes: ${label}`);
  return readFileSync(path);
}

function readArguments(args) {
  let source;
  let revision;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--source") source = args[++index];
    else if (args[index] === "--revision") revision = args[++index];
    else fail(`unsupported argument ${args[index]}`);
  }
  if (!source || !isAbsolute(source)) fail("--source must be an absolute directory");
  if (revision !== MATT_POCOCK_KIT.revision) fail(`--revision must be ${MATT_POCOCK_KIT.revision}`);
  return { source: assertRealDirectory(source, "source directory"), revision };
}

function runGit(source, args, label) {
  const command = spawnSync("git", ["-C", source, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_LOCK_BYTES,
    shell: false,
  });
  if (command.error || command.status !== 0) fail(`${label} failed`);
  return command.stdout.trim();
}

function addEntry(pending, limits, entry) {
  if (entry.depth > MAX_TREE_DEPTH) fail(`bundle depth exceeds ${MAX_TREE_DEPTH}: ${entry.label}`);
  limits.entries += 1;
  if (limits.entries > MAX_TREE_ENTRIES) fail(`bundle entry count exceeds ${MAX_TREE_ENTRIES}`);
  pending.push(entry);
}

function* boundedTree(roots, limits) {
  const pending = [];
  for (const root of roots) addEntry(pending, limits, { ...root, depth: 0 });
  while (pending.length > 0) {
    const current = pending.pop();
    const stats = lstatIfPresent(current.path);
    if (!stats) fail(`missing ${current.label}`);
    if (stats.isSymbolicLink()) fail(`symbolic link is not allowed: ${current.label}`);
    if (stats.isFile()) {
      if (stats.size > MAX_FILE_BYTES) fail(`file exceeds ${MAX_FILE_BYTES} bytes: ${current.label}`);
      limits.files += 1;
      if (limits.files > MAX_LOCKED_FILES) fail(`bundle file count exceeds ${MAX_LOCKED_FILES}`);
    } else if (!stats.isDirectory()) {
      fail(`non-regular entry is not allowed: ${current.label}`);
    }
    yield { ...current, stats };
    if (!stats.isDirectory()) continue;
    const directory = opendirSync(current.path);
    try {
      for (let child = directory.readSync(); child; child = directory.readSync()) {
        addEntry(pending, limits, {
          ...current,
          path: join(current.path, child.name),
          label: `${current.label}/${child.name}`,
          depth: current.depth + 1,
        });
      }
    } finally {
      directory.closeSync();
    }
  }
}

function scanTree(path, label, limits) {
  for (const _entry of boundedTree([{ path, label }], limits)) {}
}

function copyTree(source, destination, label, limits) {
  const root = { path: source, label, source, destination };
  for (const entry of boundedTree([root], limits)) {
    const target = join(entry.destination, relative(entry.source, entry.path));
    if (entry.stats.isDirectory()) mkdirSync(target, { recursive: true });
    else cpSync(entry.path, target, { force: true, errorOnExist: false, dereference: false });
  }
}

function exactManifestPaths(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.name !== "mattpocock-skills" ||
    manifest.version !== MATT_POCOCK_KIT.version || manifest.license !== MATT_POCOCK_KIT.license ||
    !Array.isArray(manifest.skills)) {
    fail("source plugin manifest does not match the reviewed package identity");
  }
  const actual = manifest.skills;
  const expected = REQUIRED_MATT_POCOCK_SKILLS.map((skill) => `./${skill.sourcePath}`);
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    fail("source plugin manifest contains an unsupported promoted skill catalog");
  }
  return expected;
}

function invocationClass(source, expected) {
  const skillFile = join(source, expected.sourcePath, "SKILL.md");
  const parsed = skillFrontmatter(readRegularFile(skillFile, expected.sourcePath).toString("utf8"));
  if (parsed.name !== expected.id || parsed.invocationClass !== expected.invocationClass) {
    fail(`invocation frontmatter differs for ${expected.id}`);
  }
  const metadataPath = join(source, expected.sourcePath, "agents", "openai.yaml");
  const metadata = readRegularFile(metadataPath, `${expected.sourcePath}/agents/openai.yaml`).toString("utf8");
  const implicit = /^\s*allow_implicit_invocation:\s*(true|false)\s*$/mu.exec(metadata)?.[1];
  if (expected.invocationClass === "user" && implicit !== "false") {
    fail(`user-invoked skill ${expected.id} must disable implicit OpenAI invocation`);
  }
  if (expected.invocationClass === "model" && implicit === "false") {
    fail(`model-invoked skill ${expected.id} disables implicit OpenAI invocation`);
  }
  return parsed.invocationClass;
}

function assertSourceRevision(input) {
  const head = runGit(input.source, ["rev-parse", "HEAD"], "source revision check");
  if (head !== input.revision) fail(`source revision must be ${input.revision}`);
  const checkout = runGit(input.source, ["rev-parse", "--show-toplevel"], "source root check");
  const topLevel = assertRealDirectory(checkout, "Git source root");
  if (topLevel !== input.source) fail("--source must name the Git checkout root");
}

function sourceMetadataFiles(source) {
  const licensePath = join(source, "LICENSE");
  const manifestPath = join(source, ".claude-plugin", "plugin.json");
  return {
    licensePath,
    manifestPath,
    license: readRegularFile(licensePath, "source LICENSE"),
    manifest: readRegularFile(manifestPath, "source plugin manifest"),
    packageContents: readRegularFile(join(source, "package.json"), "source package.json"),
  };
}

function parsedSourceMetadata(files) {
  try {
    return {
      manifest: JSON.parse(files.manifest.toString("utf8")),
      packageMetadata: JSON.parse(files.packageContents.toString("utf8")),
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    fail("source metadata is malformed");
  }
}

function assertSourceMetadata(files) {
  if (digest(files.license) !== MATT_POCOCK_KIT.licenseSha256) {
    fail("source LICENSE does not match the reviewed MIT license");
  }
  if (digest(files.manifest) !== MATT_POCOCK_KIT.manifestSha256) fail("source plugin manifest digest differs");
  const { manifest, packageMetadata } = parsedSourceMetadata(files);
  exactManifestPaths(manifest);
  if (packageMetadata.name !== manifest.name || packageMetadata.version !== manifest.version ||
    packageMetadata.license !== manifest.license) {
    fail("source package and plugin metadata disagree");
  }
}

function assertCleanSource(source) {
  const dirtyPaths = ["LICENSE", "package.json", ".claude-plugin/plugin.json", ...REQUIRED_MATT_POCOCK_SKILLS.map((skill) => skill.sourcePath)];
  if (runGit(source, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...dirtyPaths], "source cleanliness check")) {
    fail("reviewed source paths are dirty");
  }
}

function verifyPromotedSource(source, licensePath) {
  const limits = { entries: 0, files: 0 };
  scanTree(licensePath, "LICENSE", limits);
  for (const expected of REQUIRED_MATT_POCOCK_SKILLS) {
    const sourcePath = join(source, expected.sourcePath);
    if (!pathInside(source, sourcePath)) fail(`source path escapes checkout: ${expected.sourcePath}`);
    scanTree(sourcePath, expected.sourcePath, limits);
    invocationClass(source, expected);
  }
}

function validatedSource(input) {
  assertSourceRevision(input);
  const files = sourceMetadataFiles(input.source);
  assertSourceMetadata(files);
  assertCleanSource(input.source);
  verifyPromotedSource(input.source, files.licensePath);
  return { licensePath: files.licensePath, manifestPath: files.manifestPath };
}

function recordDigest(record) {
  return digest(JSON.stringify({
    id: record.id,
    invocationClass: record.invocationClass,
    license: record.license,
    skillPath: record.skillPath,
    source: record.source,
    sourceDigest: record.sourceDigest,
    sourcePath: record.sourcePath,
    sourceRevision: record.sourceRevision,
  }));
}

function containingBundleRoot(rootByPublicPath, skillPath) {
  const containingRoot = [...rootByPublicPath.keys()]
    .filter((root) => skillPath.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (!containingRoot) fail(`skill path has no bundle root: ${skillPath}`);
  return containingRoot;
}

function verifiedSkillFile(rootByPublicPath, expected) {
  const containingRoot = containingBundleRoot(rootByPublicPath, expected.skillPath);
  const absoluteRoot = rootByPublicPath.get(containingRoot);
  const suffix = expected.skillPath.slice(containingRoot.length + 1);
  const skillFile = join(absoluteRoot, suffix);
  const parsed = skillFrontmatter(readRegularFile(skillFile, expected.skillPath).toString("utf8"));
  if (parsed.name !== expected.id) fail(`skill name differs for ${expected.skillPath}`);
  if (expected.source === MATT_POCOCK_KIT.sourceUrl && parsed.invocationClass !== expected.invocationClass) {
    fail(`invocation class differs for ${expected.id}`);
  }
  return skillFile;
}

function skillRecord(rootByPublicPath, expected) {
  const skillFile = verifiedSkillFile(rootByPublicPath, expected);
  const record = {
    id: expected.id,
    skillPath: expected.skillPath,
    sourcePath: expected.sourcePath,
    source: expected.source,
    sourceRevision: expected.sourceRevision,
    sourceDigest: digest(readFileSync(skillFile)),
    license: expected.license,
    invocationClass: expected.invocationClass,
    descriptorDigest: "",
  };
  return { ...record, descriptorDigest: recordDigest(record) };
}

function bundleFileRecords(rootByPublicPath) {
  const files = [];
  const limits = { entries: 0, files: 0 };
  const roots = [...rootByPublicPath].map(([publicRoot, path]) => ({ path, root: path, publicRoot, label: publicRoot }));
  for (const entry of boundedTree(roots, limits)) {
    if (!entry.stats.isFile()) continue;
    files.push({
      path: `${entry.publicRoot}/${relative(entry.root, entry.path).replaceAll(sep, "/")}`,
      sha256: digest(readFileSync(entry.path)),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function sortedSkillRecords(rootByPublicPath, requiredSkills) {
  return requiredSkills.map((expected) => skillRecord(rootByPublicPath, expected))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function assertSkillCatalog(skills, legacySkills, shadowedSkills) {
  if (skills.length !== 36 || legacySkills.length !== 0 || shadowedSkills.length !== 0 ||
    skills.length + legacySkills.length + shadowedSkills.length > MAX_SKILLS) {
    fail("required active, legacy, or shadowed skill catalog differs");
  }
  const activeIds = new Set();
  for (const skill of skills) {
    if (activeIds.has(skill.id)) fail(`duplicate admitted skill id: ${skill.id}`);
    if (FORBIDDEN_SKILL_ID_PATTERN.test(skill.id)) fail(`forbidden admitted skill id: ${skill.id}`);
    activeIds.add(skill.id);
  }
  for (const skill of legacySkills) {
    if (activeIds.has(skill.id)) fail(`legacy skill collides with admitted id: ${skill.id}`);
  }
  for (const skill of shadowedSkills) {
    if (!activeIds.has(skill.id)) fail(`shadowed skill has no admitted counterpart: ${skill.id}`);
    if (legacySkills.some((legacy) => legacy.id === skill.id)) {
      fail(`shadowed skill collides with legacy-only id: ${skill.id}`);
    }
  }
}

function serializedLock(lock) {
  const contents = `${JSON.stringify(lock, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_LOCK_BYTES) fail(`lock file exceeds ${MAX_LOCK_BYTES} bytes`);
  return contents;
}

function buildLock(stagedMatt) {
  const rootByPublicPath = new Map(LOCKED_ROOTS.map((root) => [
    root,
    root === MATT_POCOCK_ROOT ? stagedMatt : join(pluginRoot, root),
  ]));
  const skills = sortedSkillRecords(rootByPublicPath, REQUIRED_SKILLS);
  const legacySkills = sortedSkillRecords(rootByPublicPath, REQUIRED_LEGACY_SKILLS);
  const shadowedSkills = sortedSkillRecords(rootByPublicPath, REQUIRED_SHADOWED_SKILLS);
  assertSkillCatalog(skills, legacySkills, shadowedSkills);
  const lock = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    mattPocockKit: MATT_POCOCK_KIT,
    guardKit: GUARD_KIT,
    deliveryKit: DELIVERY_KIT,
    hanoonKit: HANOON_KIT,
    pstackKit: PSTACK_KIT,
    humanlayerKit: HUMANLAYER_KIT,
    skills,
    legacySkills,
    shadowedSkills,
    files: bundleFileRecords(rootByPublicPath),
  };
  return serializedLock(lock);
}

function provenanceContents() {
  return `${JSON.stringify({
    schemaVersion: 1,
    sourceUrl: MATT_POCOCK_KIT.sourceUrl,
    revision: MATT_POCOCK_KIT.revision,
    version: MATT_POCOCK_KIT.version,
    manifestPath: ".claude-plugin/plugin.json",
    manifestSha256: MATT_POCOCK_KIT.manifestSha256,
    licenseSha256: MATT_POCOCK_KIT.licenseSha256,
    promotedPaths: REQUIRED_MATT_POCOCK_SKILLS.map((skill) => skill.sourcePath),
  }, null, 2)}\n`;
}

function assertDestinationSafe() {
  const stats = lstatIfPresent(skillsRoot);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) fail("skills must be a real directory");
  const limits = { entries: 0, files: 0 };
  for (const root of LOCKED_ROOTS) {
    const path = join(pluginRoot, root);
    if (lstatIfPresent(path)) scanTree(path, root, limits);
    else if (root !== MATT_POCOCK_ROOT) fail(`missing ${root}`);
  }
  const lock = lstatIfPresent(lockDestination);
  if (lock?.isSymbolicLink()) fail(`symbolic link is not allowed: ${LOCK_PATH}`);
  if (lock && (!lock.isFile() || lock.size > MAX_LOCK_BYTES)) fail(`invalid ${LOCK_PATH}`);
}

function rollback(destination, backup) {
  if (backup && lstatIfPresent(backup)) {
    if (lstatIfPresent(destination)) rmSync(destination, { recursive: true, force: true });
    renameSync(backup, destination);
  } else if (!backup && lstatIfPresent(destination)) {
    rmSync(destination, { recursive: true, force: true });
  }
}

function replaceBundle(stage, lockContents) {
  const stagedMatt = join(stage, "matt-pocock");
  const stagedLock = join(stage, "skills.lock.json");
  writeFileSync(stagedLock, lockContents);
  const suffix = `${process.pid}-${Date.now()}`;
  const mattBackup = lstatIfPresent(mattDestination) ? join(skillsRoot, `.matt-pocock-backup-${suffix}`) : null;
  const lockBackup = lstatIfPresent(lockDestination) ? join(skillsRoot, `.skills-lock-backup-${suffix}`) : null;
  try {
    if (mattBackup) renameSync(mattDestination, mattBackup);
    if (lockBackup) renameSync(lockDestination, lockBackup);
    renameSync(stagedMatt, mattDestination);
    renameSync(stagedLock, lockDestination);
  } catch (error) {
    rollback(mattDestination, mattBackup);
    rollback(lockDestination, lockBackup);
    throw error;
  }
  if (mattBackup) rmSync(mattBackup, { recursive: true, force: true });
  if (lockBackup) rmSync(lockBackup, { recursive: true, force: true });
}

function copyPromotedSkills(sourceRoot, stagedMatt, limits) {
  for (const skill of REQUIRED_MATT_POCOCK_SKILLS) {
    const destination = skill.skillPath
      .slice(`${MATT_POCOCK_ROOT}/`.length, -"/SKILL.md".length);
    copyTree(
      join(sourceRoot, skill.sourcePath),
      join(stagedMatt, destination),
      skill.sourcePath,
      limits,
    );
  }
}

function stageMattBundle(stage, sourceRoot, sourceMetadata) {
  const stagedMatt = join(stage, "matt-pocock");
  mkdirSync(stagedMatt);
  const limits = { entries: 0, files: 0 };
  copyTree(sourceMetadata.licensePath, join(stagedMatt, "LICENSE"), "LICENSE", limits);
  copyTree(sourceMetadata.manifestPath, join(stagedMatt, "UPSTREAM_MANIFEST.json"), ".claude-plugin/plugin.json", limits);
  copyPromotedSkills(sourceRoot, stagedMatt, limits);
  writeFileSync(join(stagedMatt, "PROVENANCE.json"), provenanceContents());
  scanTree(stagedMatt, MATT_POCOCK_ROOT, { entries: 0, files: 0 });
  return stagedMatt;
}

function syncBundle(syncRequest, sourceMetadata) {
  assertDestinationSafe();
  const stage = mkdtempSync(join(skillsRoot, ".matt-skill-stage-"));
  try {
    const stagedMatt = stageMattBundle(stage, syncRequest.source, sourceMetadata);
    const lockContents = buildLock(stagedMatt);
    assertDestinationSafe();
    replaceBundle(stage, lockContents);
  } finally {
    if (lstatIfPresent(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

function main() {
  if (process.argv[2] === "--rebuild-lock") {
    fail("lock rebuild is only allowed through the reviewed-source maintainer sync");
  }
  const syncRequest = readArguments(process.argv.slice(2));
  const sourceMetadata = validatedSource(syncRequest);
  syncBundle(syncRequest, sourceMetadata);
}

main();
