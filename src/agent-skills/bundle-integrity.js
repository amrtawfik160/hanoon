import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { skillFrontmatterName } from "./frontmatter.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_LOCK_BYTES = 1024 * 1024;
const MAX_SKILLS = 64;
const MAX_LOCKED_FILES = 512;
const MAX_MARKDOWN_LINKS = 128;
const LOCK_PATH = "skills/skills.lock.json";
const REGISTERED_ROOTS = ["skills/workflow-kit", "skills/guards"];

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

function readRegularFile(path, relativePath, maximumBytes) {
  if (!existsSync(path)) throw integrityError(`missing ${relativePath}`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw integrityError(`symbolic link is not allowed: ${relativePath}`);
  if (!stats.isFile()) throw integrityError(`not a regular file: ${relativePath}`);
  if (stats.size > maximumBytes) throw integrityError(`file exceeds ${maximumBytes} bytes: ${relativePath}`);
  return readFileSync(path);
}

function assertDirectory(path, relativePath) {
  if (!existsSync(path)) throw integrityError(`missing root: ${relativePath}`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw integrityError(`symbolic link is not allowed: ${relativePath}`);
  if (!stats.isDirectory()) throw integrityError(`not a directory: ${relativePath}`);
}

function parseLock(pluginRoot) {
  const lockAbsolute = join(pluginRoot, LOCK_PATH);
  let decoded;
  try {
    decoded = JSON.parse(readRegularFile(lockAbsolute, LOCK_PATH, MAX_LOCK_BYTES).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Skill bundle integrity error:")) throw error;
    throw integrityError(`malformed lock JSON: ${LOCK_PATH}`);
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw integrityError("malformed lock JSON: skills/skills.lock.json");
  if (decoded.schemaVersion !== 1) throw integrityError("unsupported lock schema version");
  if (!Array.isArray(decoded.files) || !Array.isArray(decoded.skills) || !decoded.workflowKit || typeof decoded.workflowKit !== "object") {
    throw integrityError("malformed lock schema");
  }
  if (decoded.files.length > MAX_LOCKED_FILES) throw integrityError(`locked file count exceeds ${MAX_LOCKED_FILES}`);
  if (decoded.skills.length > MAX_SKILLS) throw integrityError(`skill count exceeds ${MAX_SKILLS}`);
  return decoded;
}

function declaredRoots(pluginRoot) {
  let manifest;
  try {
    manifest = JSON.parse(readRegularFile(join(pluginRoot, "package.json"), "package.json", MAX_FILE_BYTES).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Skill bundle integrity error:")) throw error;
    throw integrityError("malformed package.json");
  }
  if (!Array.isArray(manifest?.bb?.skills) || manifest.bb.skills.length !== REGISTERED_ROOTS.length || manifest.bb.skills.some((root, index) => root !== REGISTERED_ROOTS[index])) {
    throw integrityError("registered skill roots must be skills/workflow-kit and skills/guards");
  }
  return REGISTERED_ROOTS;
}

function collectFiles(pluginRoot, roots) {
  const files = [];
  const visit = (absolute, relativePath) => {
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) throw integrityError(`symbolic link is not allowed: ${relativePath}`);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) visit(join(absolute, entry), `${relativePath}/${entry}`);
      return;
    }
    if (!stats.isFile()) throw integrityError(`not a regular file: ${relativePath}`);
    if (stats.size > MAX_FILE_BYTES) throw integrityError(`file exceeds ${MAX_FILE_BYTES} bytes: ${relativePath}`);
    if (files.length >= MAX_LOCKED_FILES) throw integrityError(`bundle file count exceeds ${MAX_LOCKED_FILES}`);
    files.push(relativePath);
  };
  for (const root of roots) {
    assertDirectory(join(pluginRoot, root), root);
    visit(join(pluginRoot, root), root);
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
    const contents = readRegularFile(join(pluginRoot, path), path, MAX_FILE_BYTES);
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

function skillName(skillPath, path) {
  const contents = readRegularFile(skillPath, path, MAX_FILE_BYTES).toString("utf8");
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
    readRegularFile(resolved, bundlePath, MAX_FILE_BYTES);
  }
}

function verifySkills(pluginRoot, lock, roots) {
  const records = new Map();
  for (const record of lock.skills) {
    if (!record || typeof record !== "object") throw integrityError("malformed skill record");
    if (typeof record.id !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(record.id)) throw integrityError("invalid skill id");
    const skillPath = normalizedRelativePath(record.skillPath, "skill path");
    if (records.has(record.id)) throw integrityError(`duplicate skill id: ${record.id}`);
    records.set(record.id, { ...record, skillPath });
  }
  const discovered = [];
  for (const root of roots) {
    for (const entry of readdirSync(join(pluginRoot, root), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = `${root}/${entry.name}/SKILL.md`;
      if (!records.has(entry.name)) throw integrityError(`unlocked skill directory: ${root}/${entry.name}`);
      discovered.push(entry.name);
      const record = records.get(entry.name);
      if (record.skillPath !== path) throw integrityError(`skill lock path differs for ${entry.name}`);
      const parsed = skillName(join(pluginRoot, path), path);
      if (parsed.name !== entry.name || parsed.name !== record.id) throw integrityError(`frontmatter name differs from lock record: ${path}`);
      verifyNestedResources(pluginRoot, path, parsed.contents);
    }
  }
  if (discovered.length !== records.size) throw integrityError("lock references a missing skill directory");
  const workflow = lock.workflowKit;
  if (workflow.version !== "6.2.0" || workflow.sourceUrl !== "https://github.com/obra/superpowers" || workflow.license !== "MIT" || workflow.licensePath !== "skills/workflow-kit/LICENSE") {
    throw integrityError("malformed workflow-kit provenance");
  }
  readRegularFile(join(pluginRoot, workflow.licensePath), workflow.licensePath, MAX_FILE_BYTES);
  for (const record of records.values()) {
    const expected = record.skillPath.startsWith("skills/workflow-kit/")
      ? ["https://github.com/obra/superpowers", "MIT"]
      : ["project-owned", "repository"];
    if (record.source !== expected[0] || record.license !== expected[1]) throw integrityError(`invalid provenance for ${record.id}`);
  }
  return [...records.keys()].sort();
}

/** @param {string} moduleUrl */
export function resolvePluginRoot(moduleUrl) {
  const start = dirname(fileURLToPath(moduleUrl));
  for (let current = start; ; current = dirname(current)) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        if (JSON.parse(readFileSync(packagePath, "utf8")).name === "bb-plugin-telegram-agent") return current;
      } catch {
        // A parent package may be unrelated or malformed; keep searching upward.
      }
    }
    if (dirname(current) === current || parse(current).root === current) break;
  }
  throw integrityError("unable to locate bb-plugin-telegram-agent package root");
}

/** @param {string} pluginRoot */
export function verifySkillBundle(pluginRoot) {
  const root = resolve(pluginRoot);
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
