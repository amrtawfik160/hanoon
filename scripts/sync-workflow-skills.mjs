#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REVIEWED_VERSION = "6.2.0";
const SOURCE_URL = "https://github.com/obra/superpowers";
const EXCLUDED_SEGMENTS = new Set([".git", ".cache", "node_modules", "coverage", "dist", "build", "out"]);
const EXCLUDED_FILES = new Set([".DS_Store", "Thumbs.db"]);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(moduleDirectory, "..");
const skillsRoot = join(pluginRoot, "skills");
const workflowDestination = join(skillsRoot, "workflow-kit");
const lockDestination = join(skillsRoot, "skills.lock.json");

function fail(message) {
  throw new Error(`Workflow skill sync: ${message}`);
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

function isExcluded(path) {
  const segments = relative(path.sourceRoot, path.current).split(sep);
  return segments.some((segment) => EXCLUDED_SEGMENTS.has(segment)) || EXCLUDED_FILES.has(segments.at(-1));
}

function assertRegularTree(sourceRoot, current = sourceRoot) {
  if (isExcluded({ sourceRoot, current })) return;
  const stats = lstatSync(current);
  if (stats.isSymbolicLink()) fail(`source contains a symbolic link: ${relative(sourceRoot, current)}`);
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(current)) assertRegularTree(sourceRoot, join(current, entry));
}

function copyFiltered(source, destination, sourceRoot) {
  if (isExcluded({ sourceRoot, current: source })) return;
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) fail(`source contains a symbolic link: ${relative(sourceRoot, source)}`);
  if (stats.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) copyFiltered(join(source, entry), join(destination, entry), sourceRoot);
    return;
  }
  if (!stats.isFile()) fail(`source contains a non-regular file: ${relative(sourceRoot, source)}`);
  cpSync(source, destination, { force: true, errorOnExist: false, dereference: false });
}

function frontmatterName(skillPath) {
  const contents = readFileSync(skillPath, "utf8");
  const frontmatter = /^---\r?\n([\s\S]{0,8192}?)\r?\n---\r?\n/.exec(contents)?.[1];
  const name = frontmatter?.match(/^name:\s*([^\r\n#]+)\s*$/m)?.[1].trim();
  if (!name || !/^[a-z][a-z0-9-]{0,127}$/.test(name)) fail(`invalid frontmatter name in ${relative(pluginRoot, skillPath)}`);
  return name;
}

function bundleFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...bundleFiles(path));
    else if (entry.isFile()) files.push(path);
    else fail(`bundle contains a non-regular file: ${relative(pluginRoot, path)}`);
  }
  return files;
}

function buildLock() {
  const skillDefinitions = [];
  const seenNames = new Set();
  for (const [root, source, license] of [
    [join(skillsRoot, "workflow-kit"), SOURCE_URL, "MIT"],
    [join(skillsRoot, "guards"), "project-owned", "repository"],
  ]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const skillPath = join(root, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) fail(`skill directory lacks SKILL.md: ${relative(pluginRoot, join(root, entry.name))}`);
      const id = frontmatterName(skillPath);
      if (id !== entry.name) fail(`skill name does not match directory: ${relative(pluginRoot, skillPath)}`);
      if (seenNames.has(id)) fail(`duplicate skill name: ${id}`);
      seenNames.add(id);
      skillDefinitions.push({ id, skillPath: relative(pluginRoot, skillPath).replaceAll(sep, "/"), source, license });
    }
  }
  const files = [join(skillsRoot, "workflow-kit"), join(skillsRoot, "guards")]
    .flatMap(bundleFiles)
    .map((path) => ({
      path: relative(pluginRoot, path).replaceAll(sep, "/"),
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
    skills: skillDefinitions.sort((left, right) => left.id.localeCompare(right.id)),
    files,
  };
}

function main() {
  const { source, version } = readArguments(process.argv.slice(2));
  const license = join(source, "LICENSE");
  const sourceSkills = join(source, "skills");
  if (!existsSync(license) || !lstatSync(license).isFile()) fail("source requires LICENSE");
  if (!existsSync(sourceSkills) || !lstatSync(sourceSkills).isDirectory()) fail("source requires skills directory");
  const metadataPath = join(source, "package.json");
  if (!existsSync(metadataPath)) fail("source requires package.json for version verification");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (metadata.version !== version) fail(`source package version ${JSON.stringify(metadata.version)} does not match ${version}`);
  assertRegularTree(sourceSkills);

  rmSync(workflowDestination, { recursive: true, force: true });
  mkdirSync(workflowDestination, { recursive: true });
  copyFiltered(license, join(workflowDestination, "LICENSE"), source);
  copyFiltered(sourceSkills, workflowDestination, source);
  writeFileSync(lockDestination, `${JSON.stringify(buildLock(), null, 2)}\n`);
}

main();
