import { createHash } from "node:crypto";
import { lstatSync, opendirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_LIMITS,
  LOCK_PATH,
  LOCK_SCHEMA_VERSION,
  REGISTERED_ROOTS,
  REQUIRED_SKILLS,
  SKILL_ID_PATTERN,
  WORKFLOW_KIT,
} from "./bundle-contract.js";
import { skillFrontmatterName } from "./frontmatter.js";

const {
  maximumFileBytes: MAX_FILE_BYTES,
  maximumLockBytes: MAX_LOCK_BYTES,
  maximumSkills: MAX_SKILLS,
  maximumLockedFiles: MAX_LOCKED_FILES,
  maximumMarkdownLinks: MAX_MARKDOWN_LINKS,
  maximumTreeEntries: MAX_TREE_ENTRIES,
  maximumTreeDepth: MAX_TREE_DEPTH,
} = BUNDLE_LIMITS;
const requiredSkillsById = new Map(REQUIRED_SKILLS.map((skill) => [skill.id, skill]));

function integrityError(reason) {
  return new Error(`Skill bundle integrity error: ${reason}`);
}

function bundleError(reason) {
  return new Error(`Skill bundle ${reason}`);
}

function normalizedRelativePath(path, description) {
  if (typeof path !== "string" || !path || path.includes("\\") || isAbsolute(path)) {
    throw integrityError(`${description} must be a relative POSIX path`);
  }
  const normalized = path.split("/");
  if (normalized.some((part) => !part || part === "." || part === "..")) {
    throw integrityError(`${description} escapes its allowed directory`);
  }
  return path;
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
  const pathFromRoot = relative(root, path);
  return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

function assertPathComponents(root, path, relativePath) {
  if (!pathInside(root, path)) throw integrityError(`path escapes plugin root: ${relativePath}`);
  let current = root;
  let stats = lstatSync(root);
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, component);
    stats = lstatIfPresent(current);
    if (!stats) throw integrityError(`missing ${relativePath}`);
    if (stats.isSymbolicLink()) throw integrityError(`symbolic link is not allowed: ${relativePath}`);
  }
  const canonical = realpathSync(path);
  if (!pathInside(root, canonical)) throw integrityError(`real path escapes plugin root: ${relativePath}`);
  return stats;
}

function readRegularFile(pluginRoot, path, relativePath, maximumBytes) {
  const stats = assertPathComponents(pluginRoot, path, relativePath);
  if (!stats.isFile()) throw integrityError(`not a regular file: ${relativePath}`);
  if (stats.size > maximumBytes) throw integrityError(`file exceeds ${maximumBytes} bytes: ${relativePath}`);
  return readFileSync(path);
}

function parsedJson(contents, malformedReason) {
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw integrityError(malformedReason);
  }
}

function assertDirectory(pluginRoot, path, relativePath) {
  const stats = assertPathComponents(pluginRoot, path, relativePath);
  if (!stats.isDirectory()) throw integrityError(`not a directory: ${relativePath}`);
}

function verifiedPluginRoot(pluginRoot) {
  const absoluteRoot = resolve(pluginRoot);
  const filesystemRoot = parse(absoluteRoot).root;
  let current = filesystemRoot;
  for (const component of relative(filesystemRoot, absoluteRoot).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stats = lstatIfPresent(current);
    if (!stats) throw integrityError(`missing plugin root: ${absoluteRoot}`);
    if (stats.isSymbolicLink()) throw integrityError(`symbolic link is not allowed in plugin root: ${current}`);
  }
  const stats = lstatSync(absoluteRoot);
  if (!stats.isDirectory()) throw integrityError(`plugin root is not a directory: ${absoluteRoot}`);
  return realpathSync(absoluteRoot);
}

function parseLock(pluginRoot) {
  const lockAbsolute = join(pluginRoot, LOCK_PATH);
  const contents = readRegularFile(pluginRoot, lockAbsolute, LOCK_PATH, MAX_LOCK_BYTES);
  const decoded = parsedJson(contents, `malformed lock JSON: ${LOCK_PATH}`);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw integrityError("malformed lock JSON: skills/skills.lock.json");
  if (decoded.schemaVersion !== LOCK_SCHEMA_VERSION) throw integrityError("unsupported lock schema version");
  if (!Array.isArray(decoded.files) || !Array.isArray(decoded.skills) || !decoded.workflowKit || typeof decoded.workflowKit !== "object") {
    throw integrityError("malformed lock schema");
  }
  if (decoded.files.length > MAX_LOCKED_FILES) throw integrityError(`locked file count exceeds ${MAX_LOCKED_FILES}`);
  if (decoded.skills.length > MAX_SKILLS) throw integrityError(`skill count exceeds ${MAX_SKILLS}`);
  return decoded;
}

function declaredRoots(pluginRoot) {
  const contents = readRegularFile(pluginRoot, join(pluginRoot, "package.json"), "package.json", MAX_FILE_BYTES);
  const manifest = parsedJson(contents, "malformed package.json");
  if (!Array.isArray(manifest?.bb?.skills) || manifest.bb.skills.length !== REGISTERED_ROOTS.length || manifest.bb.skills.some((root, index) => root !== REGISTERED_ROOTS[index])) {
    throw integrityError(`registered skill roots must be ${REGISTERED_ROOTS.join(" and ")}`);
  }
  return REGISTERED_ROOTS;
}

function addTreeEntry(pending, traversal, entry) {
  if (entry.depth > MAX_TREE_DEPTH) throw integrityError(`bundle depth exceeds ${MAX_TREE_DEPTH}: ${entry.relativePath}`);
  traversal.entries += 1;
  if (traversal.entries > MAX_TREE_ENTRIES) throw integrityError(`bundle entry count exceeds ${MAX_TREE_ENTRIES}`);
  pending.push(entry);
}

function addDirectoryChildren(absolute, relativePath, depth, pending, traversal) {
  const directory = opendirSync(absolute);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      addTreeEntry(pending, traversal, {
        absolute: join(absolute, entry.name),
        relativePath: `${relativePath}/${entry.name}`,
        depth: depth + 1,
      });
    }
  } finally {
    directory.closeSync();
  }
}

function collectFiles(pluginRoot, roots) {
  const files = [];
  const pending = [];
  const traversal = { entries: 0 };
  for (const root of roots) {
    assertDirectory(pluginRoot, join(pluginRoot, root), root);
    addTreeEntry(pending, traversal, { absolute: join(pluginRoot, root), relativePath: root, depth: 0 });
  }
  while (pending.length > 0) {
    const current = pending.pop();
    const stats = assertPathComponents(pluginRoot, current.absolute, current.relativePath);
    if (stats.isDirectory()) {
      addDirectoryChildren(current.absolute, current.relativePath, current.depth, pending, traversal);
      continue;
    }
    if (!stats.isFile()) throw integrityError(`not a regular file: ${current.relativePath}`);
    if (stats.size > MAX_FILE_BYTES) throw integrityError(`file exceeds ${MAX_FILE_BYTES} bytes: ${current.relativePath}`);
    if (files.length >= MAX_LOCKED_FILES) throw integrityError(`bundle file count exceeds ${MAX_LOCKED_FILES}`);
    files.push(current.relativePath);
  }
  return files.sort();
}

function verifyFiles(pluginRoot, lockFiles, actualFiles) {
  const lockedPaths = new Set();
  let previousPath = "";
  for (const entry of lockFiles) {
    if (!entry || typeof entry !== "object") throw integrityError("malformed locked file record");
    const path = normalizedRelativePath(entry.path, "locked file path");
    if (!REGISTERED_ROOTS.some((root) => path.startsWith(`${root}/`))) throw integrityError(`locked file escapes skills/: ${path}`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw integrityError(`invalid SHA-256 for ${path}`);
    if (lockedPaths.has(path)) throw integrityError(`duplicate locked file: ${path}`);
    if (previousPath && previousPath.localeCompare(path) >= 0) throw integrityError("locked files are not lexically sorted");
    previousPath = path;
    lockedPaths.add(path);
    const contents = readRegularFile(pluginRoot, join(pluginRoot, path), path, MAX_FILE_BYTES);
    const actual = createHash("sha256").update(contents).digest("hex");
    if (actual !== entry.sha256) throw bundleError(`digest mismatch: ${path}`);
  }
  for (const path of actualFiles) {
    if (!lockedPaths.has(path)) throw integrityError(`contains unlocked file: ${path}`);
  }
  for (const path of lockedPaths) {
    if (!actualFiles.includes(path)) throw integrityError(`missing locked file: ${path}`);
  }
}

function skillName(pluginRoot, skillPath, path) {
  const contents = readRegularFile(pluginRoot, skillPath, path, MAX_FILE_BYTES).toString("utf8");
  let name;
  try {
    name = skillFrontmatterName(contents);
  } catch (error) {
    throw integrityError(`${error.message}: ${path}`);
  }
  return { name, contents };
}

function localMarkdownTargets(contents) {
  const withoutCode = contents.replace(/^(```|~~~)[^\r\n]*\r?\n[\s\S]*?^\1[^\r\n]*\r?$/gm, "");
  const targets = [];
  const addTarget = (target) => {
    if (!target || target.startsWith("#") || /^(https?:|mailto:)/i.test(target)) return;
    if (targets.length >= MAX_MARKDOWN_LINKS) throw integrityError(`Markdown link count exceeds ${MAX_MARKDOWN_LINKS}`);
    targets.push(target.split("#", 1)[0]);
  };
  for (const match of withoutCode.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim();
    const target = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw.split(/\s+/)[0];
    addTarget(target);
  }
  for (const match of withoutCode.matchAll(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))(?:\s+.*)?$/gm)) {
    addTarget(match[1] ?? match[2]);
  }
  return targets.filter(Boolean);
}

function verifyNestedResources(pluginRoot, skillPath, contents) {
  const absoluteSkillPath = join(pluginRoot, skillPath);
  const skillDirectory = dirname(absoluteSkillPath);
  const registeredRoot = REGISTERED_ROOTS.find((root) => skillPath.startsWith(`${root}/`));
  if (!registeredRoot) throw integrityError(`skill is outside a registered root: ${skillPath}`);
  const rootDirectory = join(pluginRoot, registeredRoot);
  for (const target of localMarkdownTargets(contents)) {
    let decoded;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      throw integrityError(`invalid Markdown link in ${skillPath}: ${target}`);
    }
    const resolved = resolve(skillDirectory, decoded);
    const pathFromRoot = relative(rootDirectory, resolved);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw integrityError(`Markdown link escapes registered skill root: ${skillPath} -> ${target}`);
    }
    const bundlePath = relative(pluginRoot, resolved).replaceAll(sep, "/");
    readRegularFile(pluginRoot, resolved, bundlePath, MAX_FILE_BYTES);
  }
}

function assertRequiredCatalog(records) {
  if (records.size !== REQUIRED_SKILLS.length) throw integrityError("required skill catalog differs");
  for (const expected of REQUIRED_SKILLS) {
    if (records.get(expected.id)?.skillPath !== expected.skillPath) throw integrityError("required skill catalog differs");
  }
}

function verifySkills(pluginRoot, lock, roots) {
  const records = new Map();
  for (const record of lock.skills) {
    if (!record || typeof record !== "object") throw integrityError("malformed skill record");
    if (typeof record.id !== "string" || !SKILL_ID_PATTERN.test(record.id)) throw integrityError("invalid skill id");
    const skillPath = normalizedRelativePath(record.skillPath, "skill path");
    if (records.has(record.id)) throw integrityError(`duplicate skill id: ${record.id}`);
    records.set(record.id, { ...record, skillPath });
  }
  assertRequiredCatalog(records);
  const discovered = [];
  for (const root of roots) {
    const directory = opendirSync(join(pluginRoot, root));
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (!entry.isDirectory()) continue;
        const path = `${root}/${entry.name}/SKILL.md`;
        if (!records.has(entry.name)) throw integrityError(`unlocked skill directory: ${root}/${entry.name}`);
        discovered.push(entry.name);
        const record = records.get(entry.name);
        if (record.skillPath !== path) throw integrityError(`skill lock path differs for ${entry.name}`);
        const parsed = skillName(pluginRoot, join(pluginRoot, path), path);
        if (parsed.name !== entry.name || parsed.name !== record.id) throw integrityError(`frontmatter name differs from lock record: ${path}`);
        verifyNestedResources(pluginRoot, path, parsed.contents);
      }
    } finally {
      directory.closeSync();
    }
  }
  if (discovered.length !== records.size) throw integrityError("lock references a missing skill directory");
  const workflow = lock.workflowKit;
  if (workflow.version !== WORKFLOW_KIT.version || workflow.sourceUrl !== WORKFLOW_KIT.sourceUrl || workflow.license !== WORKFLOW_KIT.license || workflow.licensePath !== WORKFLOW_KIT.licensePath) {
    throw integrityError("malformed workflow-kit provenance");
  }
  readRegularFile(pluginRoot, join(pluginRoot, workflow.licensePath), workflow.licensePath, MAX_FILE_BYTES);
  for (const record of records.values()) {
    const expected = requiredSkillsById.get(record.id);
    if (record.source !== expected.source || record.license !== expected.license) throw integrityError(`invalid provenance for ${record.id}`);
  }
  return [...records.keys()].sort();
}

/** @param {string} moduleUrl */
export function resolvePluginRoot(moduleUrl) {
  const start = dirname(fileURLToPath(moduleUrl));
  for (let current = start; ; current = dirname(current)) {
    const packagePath = join(current, "package.json");
    const packageStats = lstatIfPresent(packagePath);
    if (packageStats) {
      verifiedPluginRoot(current);
      if (!packageStats.isFile()) throw integrityError(`not a regular file: ${packagePath}`);
      if (packageStats.size > MAX_FILE_BYTES) throw integrityError(`file exceeds ${MAX_FILE_BYTES} bytes: ${packagePath}`);
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(packagePath, "utf8"));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (manifest?.name === "bb-plugin-telegram-agent") return current;
    }
    if (dirname(current) === current || parse(current).root === current) break;
  }
  throw integrityError("unable to locate bb-plugin-telegram-agent package root");
}

/** @param {string} pluginRoot */
export function verifySkillBundle(pluginRoot) {
  const root = verifiedPluginRoot(pluginRoot);
  const roots = declaredRoots(root);
  const lock = parseLock(root);
  const actualFiles = collectFiles(root, roots);
  verifyFiles(root, lock.files, actualFiles);
  const skillIds = verifySkills(root, lock, roots);
  const bundleDigest = createHash("sha256")
    .update(lock.files.map((entry) => `${entry.path}\0${entry.sha256}\n`).join(""))
    .digest("hex");
  return Object.freeze({ bundleDigest, skillIds: Object.freeze(skillIds) });
}
