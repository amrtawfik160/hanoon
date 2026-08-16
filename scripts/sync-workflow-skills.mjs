#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_LIMITS,
  DELIVERY_KIT,
  DELIVERY_PROVENANCE,
  DELIVERY_ROOT,
  DISCOVERY_KIT,
  DISCOVERY_PROVENANCE,
  DISCOVERY_ROOT,
  HANOON_KIT,
  HANOON_PROVENANCE,
  HANOON_ROOT,
  GUARD_KIT,
  GUARD_PROVENANCE,
  GUARDS_ROOT,
  LOCK_PATH,
  LOCK_SCHEMA_VERSION,
  REQUIRED_DELIVERY_SKILLS,
  REQUIRED_DISCOVERY_SKILLS,
  REQUIRED_GUARD_SKILLS,
  REQUIRED_HANOON_SKILLS,
  REQUIRED_WORKFLOW_SKILLS,
  SYNC_EXCLUDED_FILES,
  SYNC_EXCLUDED_SEGMENTS,
  WORKFLOW_KIT,
  WORKFLOW_PROVENANCE,
  WORKFLOW_ROOT,
} from "../src/agent-skills/bundle-contract.js";
import { skillFrontmatterName } from "../src/agent-skills/frontmatter.js";

const REVIEWED_VERSION = WORKFLOW_KIT.version;
const REVIEWED_PACKAGE_NAME = "superpowers";
const REVIEWED_MIT_LICENSE_SHA256 = "a37e0e9697144819e1d965176ac4ae5bc3fa02d11e7812036bbcadf6dafe2400";
const {
  maximumFileBytes: MAX_FILE_BYTES,
  maximumLockBytes: MAX_LOCK_BYTES,
  maximumSkills: MAX_SKILLS,
  maximumLockedFiles: MAX_BUNDLE_FILES,
  maximumTreeEntries: MAX_TREE_ENTRIES,
  maximumTreeDepth: MAX_TREE_DEPTH,
} = BUNDLE_LIMITS;
const EXCLUDED_SEGMENTS = new Set(SYNC_EXCLUDED_SEGMENTS);
const EXCLUDED_FILES = new Set(SYNC_EXCLUDED_FILES);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(moduleDirectory, "..");
const skillsRoot = join(pluginRoot, dirname(WORKFLOW_ROOT));
const workflowDestination = join(pluginRoot, WORKFLOW_ROOT);
const guardsRoot = join(pluginRoot, GUARDS_ROOT);
const deliveryRoot = join(pluginRoot, DELIVERY_ROOT);
const discoveryRoot = join(pluginRoot, DISCOVERY_ROOT);
const hanoonRoot = join(pluginRoot, HANOON_ROOT);
const lockDestination = join(pluginRoot, LOCK_PATH);

function fail(message) {
  throw new Error(`Workflow skill sync: ${message}`);
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

function readArguments(argumentsList) {
  let source;
  let version;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--source") source = argumentsList[++index];
    else if (argument === "--version") version = argumentsList[++index];
    else fail(`unsupported argument ${argument}`);
  }
  if (!source || !isAbsolute(source)) fail("--source must be an absolute directory");
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail("--version must be a semver value");
  if (version !== REVIEWED_VERSION) fail(`--version must be ${REVIEWED_VERSION}`);
  return { source: resolve(source), version };
}

function isExcluded(sourceRoot, current) {
  const segments = relative(sourceRoot, current).split(sep);
  return segments.some((segment) => EXCLUDED_SEGMENTS.has(segment)) || EXCLUDED_FILES.has(segments.at(-1));
}

function addTreeEntry(pending, limits, entry) {
  if (entry.depth > MAX_TREE_DEPTH) fail(`bundle depth exceeds ${MAX_TREE_DEPTH}: ${entry.label}`);
  limits.entries += 1;
  if (limits.entries > MAX_TREE_ENTRIES) fail(`bundle entry count exceeds ${MAX_TREE_ENTRIES}`);
  pending.push(entry);
}

function validatedTreeStats(current, limits) {
  const stats = lstatIfPresent(current.path);
  if (!stats) fail(`missing ${current.label}`);
  if (stats.isSymbolicLink()) fail(`symbolic link is not allowed: ${current.label}`);
  if (stats.isFile()) {
    if (stats.size > MAX_FILE_BYTES) fail(`file exceeds ${MAX_FILE_BYTES} bytes: ${current.label}`);
    limits.files += 1;
    if (limits.files > MAX_BUNDLE_FILES) fail(`bundle file count exceeds ${MAX_BUNDLE_FILES}`);
  } else if (!stats.isDirectory()) {
    fail(`non-regular entry is not allowed: ${current.label}`);
  }
  return stats;
}

function addDirectoryEntries(current, pending, limits, filterRoot) {
  const directory = opendirSync(current.path);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      const childPath = join(current.path, entry.name);
      if (filterRoot && isExcluded(filterRoot, childPath)) continue;
      addTreeEntry(pending, limits, {
        ...current,
        path: childPath,
        label: `${current.label}/${entry.name}`,
        depth: current.depth + 1,
      });
    }
  } finally {
    directory.closeSync();
  }
}

function* boundedTreeEntries(roots, limits, filterRoot = null) {
  const pending = [];
  for (const root of roots) addTreeEntry(pending, limits, { ...root, depth: 0 });
  while (pending.length > 0) {
    const current = pending.pop();
    const stats = validatedTreeStats(current, limits);
    yield { ...current, stats };
    if (stats.isDirectory()) addDirectoryEntries(current, pending, limits, filterRoot);
  }
}

function scanTree(root, label, limits, filterRoot = null) {
  for (const _entry of boundedTreeEntries([{ path: root, label }], limits, filterRoot)) {}
}

function assertDirectory(path, label) {
  const stats = lstatIfPresent(path);
  if (!stats) fail(`missing ${label}`);
  if (stats.isSymbolicLink()) fail(`symbolic link is not allowed: ${label}`);
  if (!stats.isDirectory()) fail(`not a directory: ${label}`);
}

function readBoundedRegularFile(path, label, maximumBytes = MAX_FILE_BYTES) {
  const stats = lstatIfPresent(path);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) fail(`${label} must be a regular file`);
  if (stats.size > maximumBytes) fail(`file exceeds ${maximumBytes} bytes: ${label}`);
  return readFileSync(path);
}

function assertDestinationSafe() {
  const skills = lstatIfPresent(skillsRoot);
  if (!skills) return;
  if (skills.isSymbolicLink()) fail("symbolic link is not allowed: skills");
  if (!skills.isDirectory()) fail("not a directory: skills");
  const limits = { entries: 0, files: 0 };
  if (lstatIfPresent(workflowDestination)) scanTree(workflowDestination, WORKFLOW_ROOT, limits);
  if (lstatIfPresent(guardsRoot)) scanTree(guardsRoot, GUARDS_ROOT, limits);
  if (lstatIfPresent(deliveryRoot)) scanTree(deliveryRoot, DELIVERY_ROOT, limits);
  if (lstatIfPresent(discoveryRoot)) scanTree(discoveryRoot, DISCOVERY_ROOT, limits);
  if (lstatIfPresent(hanoonRoot)) scanTree(hanoonRoot, HANOON_ROOT, limits);
  const lock = lstatIfPresent(lockDestination);
  if (lock?.isSymbolicLink()) fail(`symbolic link is not allowed: ${LOCK_PATH}`);
  if (lock && !lock.isFile()) fail(`not a regular file: ${LOCK_PATH}`);
  if (lock && lock.size > MAX_LOCK_BYTES) fail(`file exceeds ${MAX_LOCK_BYTES} bytes: ${LOCK_PATH}`);
}

function copyFiltered(source, destination, sourceRoot, limits) {
  const root = { path: source, label: relative(sourceRoot, source), source, destination };
  for (const entry of boundedTreeEntries([root], limits, sourceRoot)) {
    const destinationPath = join(entry.destination, relative(entry.source, entry.path));
    if (entry.stats.isDirectory()) mkdirSync(destinationPath, { recursive: true });
    else cpSync(entry.path, destinationPath, { force: true, errorOnExist: false, dereference: false });
  }
}

function frontmatterName(skillPath) {
  const contents = readBoundedRegularFile(skillPath, relative(pluginRoot, skillPath)).toString("utf8");
  try {
    return skillFrontmatterName(contents);
  } catch (error) {
    fail(`${error.message} in ${relative(pluginRoot, skillPath)}`);
  }
}

function bundleFileRecords(roots) {
  const files = [];
  const limits = { entries: 0, files: 0 };
  const descriptors = roots.map((root) => ({ ...root, root: root.path, label: root.publicRoot }));
  for (const current of boundedTreeEntries(descriptors, limits)) {
    if (!current.stats.isFile()) continue;
    files.push({
      path: `${current.publicRoot}/${relative(current.root, current.path).replaceAll(sep, "/")}`,
      sha256: createHash("sha256").update(readFileSync(current.path)).digest("hex"),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function skillRecord(context, directoryName) {
  const skillPath = join(context.root, directoryName, "SKILL.md");
  if (!lstatIfPresent(skillPath)) fail(`skill directory lacks SKILL.md: ${relative(pluginRoot, dirname(skillPath))}`);
  const id = frontmatterName(skillPath);
  if (id !== directoryName) fail(`skill name does not match directory: ${relative(pluginRoot, skillPath)}`);
  return {
    id,
    skillPath: `${context.publicRoot}/${relative(context.root, skillPath).replaceAll(sep, "/")}`,
    source: context.provenance.source,
    license: context.provenance.license,
  };
}

function appendSkillRecord(records, seenNames, context, directoryName) {
  const record = skillRecord(context, directoryName);
  if (seenNames.has(record.id)) fail(`duplicate skill name: ${record.id}`);
  seenNames.add(record.id);
  records.push(record);
  if (records.length > MAX_SKILLS) fail(`skill count exceeds ${MAX_SKILLS}`);
}

function skillRecords(root, publicRoot, provenance, filterRoot = null) {
  if (!lstatIfPresent(root)) return [];
  const seenNames = new Set();
  const records = [];
  const context = { root, publicRoot, provenance };
  let entries = 0;
  const directory = opendirSync(root);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) fail(`bundle entry count exceeds ${MAX_TREE_ENTRIES}`);
      const entryPath = join(root, entry.name);
      if (filterRoot && isExcluded(filterRoot, entryPath)) continue;
      if (entry.isSymbolicLink()) fail(`symbolic link is not allowed: ${relative(pluginRoot, entryPath)}`);
      if (entry.isDirectory()) appendSkillRecord(records, seenNames, context, entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return records.sort((left, right) => left.id.localeCompare(right.id));
}

function assertCatalog(records, expectedSkills, expectedRoot) {
  if (records.length !== expectedSkills.length) fail(`required ${expectedRoot} skill catalog differs`);
  for (let index = 0; index < expectedSkills.length; index += 1) {
    const expected = expectedSkills[index];
    const record = records[index];
    if (record.id !== expected.id || record.skillPath !== expected.skillPath) {
      fail(`required ${expectedRoot} skill catalog differs`);
    }
  }
}

function buildLock(workflowRoot) {
  const workflowSkills = skillRecords(workflowRoot, WORKFLOW_ROOT, WORKFLOW_PROVENANCE);
  const guardSkills = skillRecords(guardsRoot, GUARDS_ROOT, GUARD_PROVENANCE);
  const deliverySkills = skillRecords(deliveryRoot, DELIVERY_ROOT, DELIVERY_PROVENANCE);
  const discoverySkills = skillRecords(discoveryRoot, DISCOVERY_ROOT, DISCOVERY_PROVENANCE);
  const hanoonSkills = skillRecords(hanoonRoot, HANOON_ROOT, HANOON_PROVENANCE);
  assertCatalog(workflowSkills, REQUIRED_WORKFLOW_SKILLS, WORKFLOW_ROOT);
  assertCatalog(guardSkills, REQUIRED_GUARD_SKILLS, GUARDS_ROOT);
  assertCatalog(deliverySkills, REQUIRED_DELIVERY_SKILLS, DELIVERY_ROOT);
  assertCatalog(discoverySkills, REQUIRED_DISCOVERY_SKILLS, DISCOVERY_ROOT);
  assertCatalog(hanoonSkills, REQUIRED_HANOON_SKILLS, HANOON_ROOT);
  const skills = [...workflowSkills, ...guardSkills, ...deliverySkills, ...discoverySkills, ...hanoonSkills];
  const ids = new Set();
  for (const skill of skills) {
    if (ids.has(skill.id)) fail(`duplicate skill name: ${skill.id}`);
    ids.add(skill.id);
  }
  const files = bundleFileRecords([
    { path: workflowRoot, publicRoot: WORKFLOW_ROOT },
    { path: guardsRoot, publicRoot: GUARDS_ROOT },
    { path: deliveryRoot, publicRoot: DELIVERY_ROOT },
    { path: discoveryRoot, publicRoot: DISCOVERY_ROOT },
    { path: hanoonRoot, publicRoot: HANOON_ROOT },
  ]);
  const lock = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    workflowKit: WORKFLOW_KIT,
    guardKit: GUARD_KIT,
    deliveryKit: DELIVERY_KIT,
    discoveryKit: DISCOVERY_KIT,
    hanoonKit: HANOON_KIT,
    skills: skills.sort((left, right) => left.id.localeCompare(right.id)),
    files,
  };
  const lockContents = `${JSON.stringify(lock, null, 2)}\n`;
  if (Buffer.byteLength(lockContents) > MAX_LOCK_BYTES) fail(`lock file exceeds ${MAX_LOCK_BYTES} bytes`);
  return lockContents;
}

function validateSource(source, version) {
  assertDirectory(source, "source directory");
  const license = join(source, "LICENSE");
  const sourceSkills = join(source, "skills");
  const metadataPath = join(source, "package.json");
  const licenseContents = readBoundedRegularFile(license, "source LICENSE");
  const metadataContents = readBoundedRegularFile(metadataPath, "source package.json");
  assertDirectory(sourceSkills, "source skills directory");
  let metadata;
  try {
    metadata = JSON.parse(metadataContents.toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    fail("source package.json is malformed");
  }
  if (metadata.name !== REVIEWED_PACKAGE_NAME) fail(`source package name must be ${REVIEWED_PACKAGE_NAME}`);
  if (metadata.version !== version) fail(`source package version ${JSON.stringify(metadata.version)} does not match ${version}`);
  const licenseDigest = createHash("sha256").update(licenseContents).digest("hex");
  if (licenseDigest !== REVIEWED_MIT_LICENSE_SHA256) fail("source LICENSE does not match the reviewed MIT license");
  assertSourceBundle(source, license, sourceSkills);
  return { license, sourceSkills };
}

function assertSourceBundle(source, license, sourceSkills) {
  const limits = { entries: 0, files: 0 };
  scanTree(license, "LICENSE", limits, source);
  scanTree(sourceSkills, "skills", limits, source);
  scanTree(guardsRoot, GUARDS_ROOT, limits);
  scanTree(deliveryRoot, DELIVERY_ROOT, limits);
  scanTree(discoveryRoot, DISCOVERY_ROOT, limits);
  scanTree(hanoonRoot, HANOON_ROOT, limits);
  assertCatalog(skillRecords(sourceSkills, WORKFLOW_ROOT, WORKFLOW_PROVENANCE, source), REQUIRED_WORKFLOW_SKILLS, WORKFLOW_ROOT);
  assertCatalog(skillRecords(guardsRoot, GUARDS_ROOT, GUARD_PROVENANCE), REQUIRED_GUARD_SKILLS, GUARDS_ROOT);
  assertCatalog(skillRecords(deliveryRoot, DELIVERY_ROOT, DELIVERY_PROVENANCE), REQUIRED_DELIVERY_SKILLS, DELIVERY_ROOT);
  assertCatalog(skillRecords(discoveryRoot, DISCOVERY_ROOT, DISCOVERY_PROVENANCE), REQUIRED_DISCOVERY_SKILLS, DISCOVERY_ROOT);
  assertCatalog(skillRecords(hanoonRoot, HANOON_ROOT, HANOON_PROVENANCE), REQUIRED_HANOON_SKILLS, HANOON_ROOT);
}

function replaceBundle(stage, lockContents) {
  const stagedWorkflow = join(stage, "workflow-kit");
  const stagedLock = join(stage, "skills.lock.json");
  writeFileSync(stagedLock, lockContents);
  const suffix = `${process.pid}-${Date.now()}`;
  const workflowBackup = lstatIfPresent(workflowDestination)
    ? join(skillsRoot, `.workflow-kit-backup-${suffix}`)
    : null;
  const lockBackup = lstatIfPresent(lockDestination)
    ? join(skillsRoot, `.skills-lock-backup-${suffix}`)
    : null;
  try {
    if (workflowBackup) renameSync(workflowDestination, workflowBackup);
    if (lockBackup) renameSync(lockDestination, lockBackup);
    renameSync(stagedWorkflow, workflowDestination);
    renameSync(stagedLock, lockDestination);
  } catch (error) {
    rollbackReplacement(workflowDestination, workflowBackup);
    rollbackReplacement(lockDestination, lockBackup);
    throw error;
  }
  if (workflowBackup) rmSync(workflowBackup, { recursive: true, force: true });
  if (lockBackup) rmSync(lockBackup, { recursive: true, force: true });
}

function rollbackReplacement(destination, backup) {
  if (backup && lstatIfPresent(backup)) {
    if (lstatIfPresent(destination)) rmSync(destination, { recursive: true, force: true });
    renameSync(backup, destination);
  } else if (!backup && lstatIfPresent(destination)) {
    rmSync(destination, { recursive: true, force: true });
  }
}

function main() {
  const { source, version } = readArguments(process.argv.slice(2));
  const { license, sourceSkills } = validateSource(source, version);
  assertDestinationSafe();
  mkdirSync(skillsRoot, { recursive: true });
  assertDestinationSafe();
  const stage = mkdtempSync(join(skillsRoot, ".workflow-kit-stage-"));
  try {
    const stagedWorkflow = join(stage, "workflow-kit");
    mkdirSync(stagedWorkflow);
    const copyLimits = { entries: 0, files: 0 };
    copyFiltered(license, join(stagedWorkflow, "LICENSE"), source, copyLimits);
    copyFiltered(sourceSkills, stagedWorkflow, source, copyLimits);
    const stagedLimits = { entries: 0, files: 0 };
    scanTree(stagedWorkflow, WORKFLOW_ROOT, stagedLimits);
    scanTree(guardsRoot, GUARDS_ROOT, stagedLimits);
    scanTree(deliveryRoot, DELIVERY_ROOT, stagedLimits);
    scanTree(discoveryRoot, DISCOVERY_ROOT, stagedLimits);
    scanTree(hanoonRoot, HANOON_ROOT, stagedLimits);
    const lockContents = buildLock(stagedWorkflow);
    assertDestinationSafe();
    replaceBundle(stage, lockContents);
  } finally {
    if (lstatIfPresent(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

main();
