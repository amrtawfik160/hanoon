#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { skillFrontmatterName } from "../src/agent-skills/frontmatter.js";

const REVIEWED_VERSION = "6.2.0";
const REVIEWED_PACKAGE_NAME = "superpowers";
const REVIEWED_MIT_LICENSE_SHA256 = "a37e0e9697144819e1d965176ac4ae5bc3fa02d11e7812036bbcadf6dafe2400";
const SOURCE_URL = "https://github.com/obra/superpowers";
const EXCLUDED_SEGMENTS = new Set([".git", ".cache", "node_modules", "coverage", "dist", "build", "out"]);
const EXCLUDED_FILES = new Set([".DS_Store", "Thumbs.db"]);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(moduleDirectory, "..");
const skillsRoot = join(pluginRoot, "skills");
const workflowDestination = join(skillsRoot, "workflow-kit");
const guardsRoot = join(skillsRoot, "guards");
const lockDestination = join(skillsRoot, "skills.lock.json");

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

function assertRegularTree(root, current = root, label = relative(root, current)) {
  const stats = lstatIfPresent(current);
  if (!stats) fail(`missing ${label || "directory"}`);
  if (stats.isSymbolicLink()) fail(`symbolic link is not allowed: ${label || "."}`);
  if (stats.isFile()) return;
  if (!stats.isDirectory()) fail(`non-regular entry is not allowed: ${label || "."}`);
  for (const entry of readdirSync(current).sort()) {
    assertRegularTree(root, join(current, entry), label ? `${label}/${entry}` : entry);
  }
}

function assertDirectory(path, label) {
  const stats = lstatIfPresent(path);
  if (!stats) fail(`missing ${label}`);
  if (stats.isSymbolicLink()) fail(`symbolic link is not allowed: ${label}`);
  if (!stats.isDirectory()) fail(`not a directory: ${label}`);
}

function assertDestinationSafe() {
  const skills = lstatIfPresent(skillsRoot);
  if (!skills) return;
  if (skills.isSymbolicLink()) fail("symbolic link is not allowed: skills");
  if (!skills.isDirectory()) fail("not a directory: skills");
  assertRegularTree(skillsRoot, skillsRoot, "skills");
}

function copyFiltered(source, destination, sourceRoot) {
  if (isExcluded(sourceRoot, source)) return;
  const stats = lstatSync(source);
  if (stats.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source).sort()) copyFiltered(join(source, entry), join(destination, entry), sourceRoot);
    return;
  }
  if (!stats.isFile()) fail(`non-regular entry is not allowed: ${relative(sourceRoot, source)}`);
  cpSync(source, destination, { force: true, errorOnExist: false, dereference: false });
}

function frontmatterName(skillPath) {
  try {
    return skillFrontmatterName(readFileSync(skillPath, "utf8"));
  } catch (error) {
    fail(`${error.message} in ${relative(pluginRoot, skillPath)}`);
  }
}

function bundleFiles(root) {
  if (!lstatIfPresent(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...bundleFiles(path));
    else if (entry.isFile()) files.push(path);
    else fail(`bundle contains a non-regular file: ${relative(pluginRoot, path)}`);
  }
  return files;
}

function skillRecords(root, publicRoot, source, license) {
  if (!lstatIfPresent(root)) return [];
  const seenNames = new Set();
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const skillPath = join(root, entry.name, "SKILL.md");
      if (!lstatIfPresent(skillPath)) fail(`skill directory lacks SKILL.md: ${relative(pluginRoot, join(root, entry.name))}`);
      const id = frontmatterName(skillPath);
      if (id !== entry.name) fail(`skill name does not match directory: ${relative(pluginRoot, skillPath)}`);
      if (seenNames.has(id)) fail(`duplicate skill name: ${id}`);
      seenNames.add(id);
      return { id, skillPath: `${publicRoot}/${relative(root, skillPath).replaceAll(sep, "/")}`, source, license };
    });
}

function buildLock(workflowRoot) {
  const skills = [
    ...skillRecords(workflowRoot, "skills/workflow-kit", SOURCE_URL, "MIT"),
    ...skillRecords(guardsRoot, "skills/guards", "project-owned", "repository"),
  ];
  const ids = new Set();
  for (const skill of skills) {
    if (ids.has(skill.id)) fail(`duplicate skill name: ${skill.id}`);
    ids.add(skill.id);
  }
  const files = [
    ...bundleFiles(workflowRoot).map((path) => ({ path, publicPath: `skills/workflow-kit/${relative(workflowRoot, path).replaceAll(sep, "/")}` })),
    ...bundleFiles(guardsRoot).map((path) => ({ path, publicPath: `skills/guards/${relative(guardsRoot, path).replaceAll(sep, "/")}` })),
  ]
    .map(({ path, publicPath }) => ({
      path: publicPath,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    workflowKit: {
      version: REVIEWED_VERSION,
      sourceUrl: SOURCE_URL,
      license: "MIT",
      licensePath: "skills/workflow-kit/LICENSE",
    },
    skills: skills.sort((left, right) => left.id.localeCompare(right.id)),
    files,
  };
}

function validateSource(source, version) {
  assertDirectory(source, "source directory");
  const license = join(source, "LICENSE");
  const sourceSkills = join(source, "skills");
  const metadataPath = join(source, "package.json");
  for (const [path, label] of [[license, "source LICENSE"], [metadataPath, "source package.json"]]) {
    const stats = lstatIfPresent(path);
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) fail(`${label} must be a regular file`);
  }
  assertDirectory(sourceSkills, "source skills directory");
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    fail("source package.json is malformed");
  }
  if (metadata.name !== REVIEWED_PACKAGE_NAME) fail(`source package name must be ${REVIEWED_PACKAGE_NAME}`);
  if (metadata.version !== version) fail(`source package version ${JSON.stringify(metadata.version)} does not match ${version}`);
  const licenseDigest = createHash("sha256").update(readFileSync(license)).digest("hex");
  if (licenseDigest !== REVIEWED_MIT_LICENSE_SHA256) fail("source LICENSE does not match the reviewed MIT license");
  assertRegularTree(source, source, "source");
  return { license, sourceSkills };
}

function replaceBundle(stage, lockContents) {
  const stagedWorkflow = join(stage, "workflow-kit");
  const stagedLock = join(stage, "skills.lock.json");
  writeFileSync(stagedLock, lockContents);
  const backup = join(skillsRoot, `.workflow-kit-backup-${process.pid}-${Date.now()}`);
  const hasCurrentWorkflow = Boolean(lstatIfPresent(workflowDestination));
  if (hasCurrentWorkflow) renameSync(workflowDestination, backup);
  try {
    renameSync(stagedWorkflow, workflowDestination);
    renameSync(stagedLock, lockDestination);
    if (hasCurrentWorkflow) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (lstatIfPresent(workflowDestination)) rmSync(workflowDestination, { recursive: true, force: true });
    if (hasCurrentWorkflow && lstatIfPresent(backup)) renameSync(backup, workflowDestination);
    throw error;
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
    copyFiltered(license, join(stagedWorkflow, "LICENSE"), source);
    copyFiltered(sourceSkills, stagedWorkflow, source);
    assertRegularTree(stagedWorkflow, stagedWorkflow, "staged workflow-kit");
    const lockContents = `${JSON.stringify(buildLock(stagedWorkflow), null, 2)}\n`;
    assertDestinationSafe();
    replaceBundle(stage, lockContents);
  } finally {
    if (lstatIfPresent(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

main();
