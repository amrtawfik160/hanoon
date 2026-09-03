import { createHash } from "node:crypto";
import { lstatSync, opendirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_LIMITS,
  FORBIDDEN_SKILL_ID_PATTERN,
  GUARD_KIT,
  HANOON_KIT,
  HUMANLAYER_KIT,
  LOCKED_ROOTS,
  MATT_POCOCK_KIT,
  MATT_POCOCK_ROOT,
  PSTACK_KIT,
  LOCK_PATH,
  LOCK_SCHEMA_VERSION,
  REGISTERED_ROOTS,
  REQUIRED_LEGACY_SKILLS,
  REQUIRED_MATT_POCOCK_SKILLS,
  REQUIRED_SHADOWED_SKILLS,
  REQUIRED_SKILLS,
  SKILL_ID_PATTERN,
} from "./bundle-contract.js";
import { skillFrontmatter } from "./frontmatter.js";

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
const requiredLegacySkillsById = new Map(REQUIRED_LEGACY_SKILLS.map((skill) => [skill.id, skill]));
const requiredShadowedSkillsById = new Map(REQUIRED_SHADOWED_SKILLS.map((skill) => [skill.id, skill]));
const mattMetadataPaths = new Set([
  MATT_POCOCK_KIT.licensePath,
  MATT_POCOCK_KIT.manifestPath,
  `${MATT_POCOCK_ROOT}/PROVENANCE.json`,
]);
const requiredMattSkillRoots = REQUIRED_MATT_POCOCK_SKILLS.map((skill) =>
  skill.skillPath.slice(0, -"/SKILL.md".length));
const expectedKits = [
  ["mattPocockKit", "matt-pocock-kit", MATT_POCOCK_KIT],
  ["guardKit", "guard-kit", GUARD_KIT],
  ["hanoonKit", "hanoon-kit", HANOON_KIT],
  ["pstackKit", "pstack-kit", PSTACK_KIT],
  ["humanlayerKit", "humanlayer-kit", HUMANLAYER_KIT],
];

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

/**
 * A Markdown link may legitimately point at a directory of further reading, not
 * only at a file. The trust boundary is unchanged either way: the component
 * walk above still rejects every symlink and every escape from the plugin root,
 * so the only thing relaxed here is the file-versus-directory shape.
 */
function assertLinkedResource(pluginRoot, path, relativePath, maximumBytes) {
  const stats = assertPathComponents(pluginRoot, path, relativePath);
  if (stats.isDirectory()) return;
  if (!stats.isFile()) throw integrityError(`not a regular file or directory: ${relativePath}`);
  if (stats.size > maximumBytes) throw integrityError(`file exceeds ${maximumBytes} bytes: ${relativePath}`);
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
  if (!Array.isArray(decoded.files) || !Array.isArray(decoded.skills) || !Array.isArray(decoded.legacySkills) ||
    !Array.isArray(decoded.shadowedSkills) ||
    decoded.workflowKit !== undefined || decoded.discoveryKit !== undefined ||
    !decoded.mattPocockKit || typeof decoded.mattPocockKit !== "object") {
    throw integrityError("malformed lock schema");
  }
  if (decoded.files.length > MAX_LOCKED_FILES) throw integrityError(`locked file count exceeds ${MAX_LOCKED_FILES}`);
  if (decoded.skills.length + decoded.legacySkills.length + decoded.shadowedSkills.length > MAX_SKILLS) {
    throw integrityError(`skill count exceeds ${MAX_SKILLS}`);
  }
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
    if (!LOCKED_ROOTS.some((root) => path.startsWith(`${root}/`))) throw integrityError(`locked file escapes skills/: ${path}`);
    if (path.startsWith(`${MATT_POCOCK_ROOT}/`) && !mattMetadataPaths.has(path) &&
      !requiredMattSkillRoots.some((root) => path.startsWith(`${root}/`))) {
      throw integrityError(`unsupported Matt Pocock bundle path: ${path}`);
    }
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

function parsedSkill(pluginRoot, skillPath, path) {
  const contents = readRegularFile(pluginRoot, skillPath, path, MAX_FILE_BYTES).toString("utf8");
  let frontmatter;
  try {
    frontmatter = skillFrontmatter(contents);
  } catch (error) {
    throw integrityError(`${error.message}: ${path}`);
  }
  return { ...frontmatter, contents };
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
  const bundleRoot = LOCKED_ROOTS.find((root) => skillPath.startsWith(`${root}/`));
  if (!bundleRoot) throw integrityError(`skill is outside a locked root: ${skillPath}`);
  const rootDirectory = join(pluginRoot, bundleRoot);
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
    assertLinkedResource(pluginRoot, resolved, bundlePath, MAX_FILE_BYTES);
  }
}

function assertRequiredCatalog(records, expectedSkills) {
  if (records.size !== expectedSkills.length) throw integrityError("required skill catalog differs");
  for (const expected of expectedSkills) {
    const record = records.get(expected.id);
    if (!record || ["skillPath", "sourcePath", "sourceRevision", "invocationClass", "source", "license"]
      .some((field) => record[field] !== expected[field])) {
      throw integrityError("required skill catalog differs");
    }
  }
}

function verifyKitDeclarations(pluginRoot, lock) {
  for (const [lockKey, label, expected] of expectedKits) {
    const actual = lock[lockKey];
    if (!actual || typeof actual !== "object" || Array.isArray(actual)
      || Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
      throw integrityError(`malformed ${label} provenance`);
    }
    readRegularFile(pluginRoot, join(pluginRoot, actual.licensePath), actual.licensePath, MAX_FILE_BYTES);
  }
}

function fileSha256(pluginRoot, path) {
  const contents = readRegularFile(pluginRoot, join(pluginRoot, path), path, MAX_FILE_BYTES);
  return createHash("sha256").update(contents).digest("hex");
}

function assertPinnedFileDigest(pluginRoot, path, expectedDigest, errorReason) {
  if (fileSha256(pluginRoot, path) !== expectedDigest) throw integrityError(errorReason);
}

function readMattProvenance(pluginRoot) {
  const provenancePath = "skills/matt-pocock/PROVENANCE.json";
  return parsedJson(
    readRegularFile(pluginRoot, join(pluginRoot, provenancePath), provenancePath, MAX_FILE_BYTES),
    `malformed provenance JSON: ${provenancePath}`,
  );
}

function mattProvenanceMatches(provenance) {
  const expectedPaths = REQUIRED_MATT_POCOCK_SKILLS.map((skill) => skill.sourcePath);
  return provenance?.schemaVersion === 1 && provenance.sourceUrl === MATT_POCOCK_KIT.sourceUrl &&
    provenance.revision === MATT_POCOCK_KIT.revision && provenance.version === MATT_POCOCK_KIT.version &&
    provenance.manifestPath === ".claude-plugin/plugin.json" &&
    provenance.manifestSha256 === MATT_POCOCK_KIT.manifestSha256 &&
    provenance.licenseSha256 === MATT_POCOCK_KIT.licenseSha256 &&
    Array.isArray(provenance.promotedPaths) && provenance.promotedPaths.length === expectedPaths.length &&
    provenance.promotedPaths.every((path, index) => path === expectedPaths[index]);
}

function verifyKitProvenance(pluginRoot, lock) {
  verifyKitDeclarations(pluginRoot, lock);
  assertPinnedFileDigest(
    pluginRoot, MATT_POCOCK_KIT.licensePath, MATT_POCOCK_KIT.licenseSha256,
    "Matt Pocock license digest differs",
  );
  assertPinnedFileDigest(
    pluginRoot, MATT_POCOCK_KIT.manifestPath, MATT_POCOCK_KIT.manifestSha256,
    "Matt Pocock manifest digest differs",
  );
  if (!mattProvenanceMatches(readMattProvenance(pluginRoot))) {
    throw integrityError("malformed Matt Pocock provenance record");
  }
}

function skillRecordDigest(record) {
  return createHash("sha256").update(JSON.stringify({
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

function assertSkillRecordShape(record) {
  if (!record || typeof record !== "object") throw integrityError("malformed skill record");
  if (typeof record.id !== "string" || !SKILL_ID_PATTERN.test(record.id)) throw integrityError("invalid skill id");
  if (record.invocationClass !== "user" && record.invocationClass !== "model") {
    throw integrityError(`invalid invocation class for ${record.id}`);
  }
  const boundedRevision = typeof record.sourceRevision === "string" &&
    record.sourceRevision.length > 0 && record.sourceRevision.length <= 128;
  const validProvenance = typeof record.source === "string" && record.source.length > 0 &&
    typeof record.license === "string" && record.license.length > 0;
  if (!boundedRevision || !validProvenance || !/^[a-f0-9]{64}$/.test(record.sourceDigest) ||
    !/^[a-f0-9]{64}$/.test(record.descriptorDigest)) {
    throw integrityError(`malformed skill record for ${record.id}`);
  }
}

function normalizedSkillRecord(record) {
  assertSkillRecordShape(record);
  const skillPath = normalizedRelativePath(record.skillPath, "skill path");
  const sourcePath = normalizedRelativePath(record.sourcePath, "source path");
  if (!LOCKED_ROOTS.some((root) => skillPath.startsWith(`${root}/`))) {
    throw integrityError(`skill is outside a locked root: ${skillPath}`);
  }
  const normalized = { ...record, skillPath, sourcePath };
  if (skillRecordDigest(normalized) !== normalized.descriptorDigest) {
    throw integrityError(`descriptor digest differs for ${record.id}`);
  }
  return normalized;
}

function parsedRecords(records, label) {
  const parsed = new Map();
  for (const candidate of records) {
    const record = normalizedSkillRecord(candidate);
    if (parsed.has(record.id)) throw integrityError(`duplicate ${label} skill id: ${record.id}`);
    parsed.set(record.id, record);
  }
  return parsed;
}

function verifyOpenAiInvocationMetadata(pluginRoot, record) {
  if (record.source !== MATT_POCOCK_KIT.sourceUrl) return;
  const metadataPath = `${dirname(record.skillPath)}/agents/openai.yaml`;
  const metadata = readRegularFile(
    pluginRoot, join(pluginRoot, metadataPath), metadataPath, MAX_FILE_BYTES,
  ).toString("utf8");
  const implicit = /^\s*allow_implicit_invocation:\s*(true|false)\s*$/mu.exec(metadata)?.[1];
  if (record.invocationClass === "user" && implicit !== "false") {
    throw integrityError(`user-invoked skill ${record.id} does not disable implicit invocation`);
  }
  if (record.invocationClass === "model" && implicit === "false") {
    throw integrityError(`model-invoked skill ${record.id} disables implicit invocation`);
  }
}

function assertCatalogSeparation(records, legacyRecords, shadowedRecords) {
  for (const id of records.keys()) {
    if (FORBIDDEN_SKILL_ID_PATTERN.test(id)) throw integrityError(`forbidden admitted skill id: ${id}`);
    if (legacyRecords.has(id)) throw integrityError(`legacy skill collides with admitted id: ${id}`);
  }
  for (const id of shadowedRecords.keys()) {
    if (!records.has(id)) throw integrityError(`shadowed skill has no admitted counterpart: ${id}`);
    if (legacyRecords.has(id)) throw integrityError(`shadowed skill collides with legacy-only id: ${id}`);
  }
}

function verifySkillFile(pluginRoot, record) {
  const absolutePath = join(pluginRoot, record.skillPath);
  const parsed = parsedSkill(pluginRoot, absolutePath, record.skillPath);
  if (parsed.name !== record.id || parsed.invocationClass !== record.invocationClass) {
    throw integrityError(`frontmatter differs from lock record: ${record.skillPath}`);
  }
  if (fileSha256(pluginRoot, record.skillPath) !== record.sourceDigest) {
    throw bundleError(`source digest mismatch: ${record.skillPath}`);
  }
  verifyNestedResources(pluginRoot, record.skillPath, parsed.contents);
  verifyOpenAiInvocationMetadata(pluginRoot, record);
}

function verifiedSkillPaths(pluginRoot, records) {
  const byPath = new Map();
  for (const record of records) {
    if (byPath.has(record.skillPath)) throw integrityError(`duplicate skill path: ${record.skillPath}`);
    byPath.set(record.skillPath, record);
    verifySkillFile(pluginRoot, record);
  }
  return byPath;
}

function assertCatalogedSkillFiles(lock, byPath) {
  const discoveredPaths = lock.files
    .map((entry) => entry.path)
    .filter((path) => path.endsWith("/SKILL.md"));
  if (discoveredPaths.length !== byPath.size || discoveredPaths.some((path) => !byPath.has(path))) {
    throw integrityError("bundled skill files differ from active, legacy, and shadowed catalogs");
  }
}

function assertRecordProvenance(records, expectedById, label) {
  for (const record of records.values()) {
    const expected = expectedById.get(record.id);
    if (record.source !== expected.source || record.license !== expected.license) {
      throw integrityError(`invalid ${label}provenance for ${record.id}`);
    }
  }
}

function verifiedSkillIds(records, legacyRecords) {
  return {
    admittedSkillIds: [...records.keys()].sort(),
    legacySkillIds: [...legacyRecords.keys()].sort(),
    skillIds: [...records.keys(), ...legacyRecords.keys()].sort(),
  };
}

function verifySkills(pluginRoot, lock) {
  const records = parsedRecords(lock.skills, "admitted");
  const legacyRecords = parsedRecords(lock.legacySkills, "legacy");
  const shadowedRecords = parsedRecords(lock.shadowedSkills, "shadowed");
  assertCatalogSeparation(records, legacyRecords, shadowedRecords);
  assertRequiredCatalog(records, REQUIRED_SKILLS);
  assertRequiredCatalog(legacyRecords, REQUIRED_LEGACY_SKILLS);
  assertRequiredCatalog(shadowedRecords, REQUIRED_SHADOWED_SKILLS);
  const allRecords = [...records.values(), ...legacyRecords.values(), ...shadowedRecords.values()];
  assertCatalogedSkillFiles(lock, verifiedSkillPaths(pluginRoot, allRecords));
  verifyKitProvenance(pluginRoot, lock);
  assertRecordProvenance(records, requiredSkillsById, "");
  assertRecordProvenance(legacyRecords, requiredLegacySkillsById, "legacy ");
  assertRecordProvenance(shadowedRecords, requiredShadowedSkillsById, "shadowed ");
  return verifiedSkillIds(records, legacyRecords);
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
  declaredRoots(root);
  const lock = parseLock(root);
  const actualFiles = collectFiles(root, LOCKED_ROOTS);
  verifyFiles(root, lock.files, actualFiles);
  const verifiedSkills = verifySkills(root, lock);
  const bundleDigest = createHash("sha256")
    .update(lock.files.map((entry) => `${entry.path}\0${entry.sha256}\n`).join(""))
    .digest("hex");
  return Object.freeze({
    bundleDigest,
    admittedSkillIds: Object.freeze(verifiedSkills.admittedSkillIds),
    legacySkillIds: Object.freeze(verifiedSkills.legacySkillIds),
    skillIds: Object.freeze(verifiedSkills.skillIds),
  });
}
