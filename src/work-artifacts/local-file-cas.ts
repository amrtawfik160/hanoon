import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type LockOwner = Readonly<{
  pid: number;
  processIdentity: string;
  token: string;
  expectedDigest: string;
  createdAt: number;
}>;

const LOCK_SUFFIX = ".hanoon-cas-lock";
const TOKEN = /^[0-9a-f-]{36}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const PROCESS_IDENTITY = /^[A-Za-z0-9:._-]{1,128}$/u;
const MAX_LOCAL_FILE_BYTES = 1_048_576;

export class LocalFileCasConflictError extends Error {
  public constructor() {
    super("local file changed after it was observed");
    this.name = "LocalFileCasConflictError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function readBoundedRegularFile(path: string, maximum = MAX_LOCAL_FILE_BYTES): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (
      typeof error === "object" && error !== null && "code" in error &&
      (error as { code?: unknown }).code === "ELOOP"
    ) {
      throw new TypeError("local tracker artifact is not a bounded regular file");
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maximum) {
      throw new TypeError("local tracker artifact is not a bounded regular file");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function assertBoundedLocalFileContent(content: string): void {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_LOCAL_FILE_BYTES) {
    throw new TypeError("local tracker artifact must be at most 1048576 UTF-8 bytes");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeSyncedFile(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    if (
      !Number.isSafeInteger(value.pid) || (value.pid ?? 0) < 1 ||
      typeof value.processIdentity !== "string" || !PROCESS_IDENTITY.test(value.processIdentity) ||
      typeof value.token !== "string" || !TOKEN.test(value.token) ||
      typeof value.expectedDigest !== "string" || !DIGEST.test(value.expectedDigest) ||
      !Number.isSafeInteger(value.createdAt) || (value.createdAt ?? -1) < 0
    ) return null;
    return value as LockOwner;
  } catch {
    return null;
  }
}

async function readProcessIdentity(pid: number): Promise<string | null> {
  if (process.platform !== "linux") {
    throw new Error("local file CAS requires Linux process and directory descriptor identities");
  }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/u);
    const startTime = fieldsAfterCommand[19];
    return startTime && /^[0-9]+$/u.test(startTime) ? `${pid}:${startTime}` : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

type FileIdentity = Readonly<{ dev: number; ino: number }>;

export type LocalFileContainment = Readonly<{
  root: string;
  dev: number;
  ino: number;
}>;

function fileIdentity(stats: Readonly<{ dev: number; ino: number }>): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function withAnchoredLocalPath<T>(
  absolutePathValue: string,
  containment: LocalFileContainment | undefined,
  operation: (anchoredPath: string) => Promise<T>,
): Promise<T> {
  if (process.platform !== "linux") {
    throw new Error("local file CAS requires Linux directory descriptor anchoring");
  }
  if (!isAbsolute(absolutePathValue)) throw new TypeError("local file CAS path must be absolute");
  const absolutePath = resolve(absolutePathValue);
  const requestedParent = dirname(absolutePath);
  const requestedStats = await lstat(requestedParent);
  if (requestedStats.isSymbolicLink() || !requestedStats.isDirectory()) {
    throw new TypeError("local file CAS parent must be a regular directory");
  }
  const canonicalParent = await realpath(requestedParent);
  const canonicalStats = await lstat(canonicalParent);
  const containmentRoot = containment ? resolve(containment.root) : canonicalParent;
  const containmentStats = await lstat(containmentRoot);
  const canonicalContainmentRoot = await realpath(containmentRoot);
  const relativeParent = relative(canonicalContainmentRoot, canonicalParent);
  if (
    !canonicalStats.isDirectory() ||
    !sameFileIdentity(fileIdentity(requestedStats), fileIdentity(canonicalStats)) ||
    !containmentStats.isDirectory() || canonicalContainmentRoot !== containmentRoot ||
    (containment !== undefined &&
      !sameFileIdentity(fileIdentity(containmentStats), fileIdentity(containment))) ||
    relativeParent === ".." || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)
  ) {
    throw new TypeError("local file CAS parent changed or escaped containment before it was anchored");
  }
  const directory = await open(canonicalParent, "r");
  try {
    const descriptorIdentity = fileIdentity(await directory.stat());
    if (!sameFileIdentity(descriptorIdentity, fileIdentity(canonicalStats))) {
      throw new TypeError("local file CAS parent changed while it was anchored");
    }
    const anchor = join("/proc/self/fd", String(directory.fd));
    const resolvedAnchor = await realpath(anchor);
    const anchorStats = await lstat(resolvedAnchor);
    if (
      resolvedAnchor !== canonicalParent ||
      !sameFileIdentity(fileIdentity(anchorStats), descriptorIdentity)
    ) {
      throw new TypeError("local file CAS directory descriptor could not be verified");
    }
    return await operation(join(anchor, basename(absolutePath)));
  } finally {
    await directory.close();
  }
}

function transactionPaths(absolutePath: string, token: string): Readonly<{
  candidate: string;
  previous: string;
  conflict: string;
}> {
  return {
    candidate: `${absolutePath}.hanoon-${token}.candidate`,
    previous: `${absolutePath}.hanoon-${token}.previous`,
    conflict: `${absolutePath}.hanoon-${token}.conflict`,
  };
}

async function recoverAbandonedLock(absolutePath: string, lockPath: string): Promise<boolean> {
  try {
    await lstat(lockPath);
  } catch (error) {
    if (isNotFound(error)) return true;
    throw error;
  }
  const raw = await readBoundedRegularFile(lockPath, 4_096);
  const owner = parseOwner(raw);
  if (!owner) {
    throw new TypeError("local file mutation lock has invalid ownership metadata");
  }
  if (await readProcessIdentity(owner.pid) === owner.processIdentity) return false;

  const paths = transactionPaths(absolutePath, owner.token);
  const targetExists = await exists(absolutePath);
  if (await exists(paths.previous)) {
    if (!targetExists) {
      try {
        await link(paths.previous, absolutePath);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    } else if (sha256(await readBoundedRegularFile(paths.previous)) !== owner.expectedDigest) {
      try {
        await rename(paths.previous, paths.conflict);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }
  }
  await rm(paths.candidate, { force: true });
  await rm(paths.previous, { force: true });
  await rm(lockPath, { force: true });
  await rm(`${lockPath}.${owner.token}.owner`, { force: true });
  await syncDirectory(absolutePath);
  return true;
}

async function recoverAnchoredLocalFileCas(absolutePath: string): Promise<void> {
  const lockPath = `${absolutePath}${LOCK_SUFFIX}`;
  if (!await exists(lockPath)) return;
  if (!await recoverAbandonedLock(absolutePath, lockPath)) {
    throw new LocalFileCasConflictError();
  }
}

async function acquireLock(absolutePath: string, expectedDigest: string): Promise<LockOwner> {
  const lockPath = `${absolutePath}${LOCK_SUFFIX}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const processIdentity = await readProcessIdentity(process.pid);
    if (!processIdentity) throw new Error("could not establish local file mutation process identity");
    const owner: LockOwner = {
      pid: process.pid,
      processIdentity,
      token: randomUUID(),
      expectedDigest,
      createdAt: Date.now(),
    };
    const ownerCandidate = `${lockPath}.${owner.token}.owner`;
    let published = false;
    try {
      await writeSyncedFile(ownerCandidate, JSON.stringify(owner));
      try {
        await link(ownerCandidate, lockPath);
        published = true;
      } finally {
        await rm(ownerCandidate, { force: true });
      }
      await syncDirectory(absolutePath);
      return owner;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        await rm(ownerCandidate, { force: true });
        if (published) await releaseLock(absolutePath, owner);
        throw error;
      }
      if (!await recoverAbandonedLock(absolutePath, lockPath)) {
        throw new LocalFileCasConflictError();
      }
    }
  }
  throw new LocalFileCasConflictError();
}

async function preservePreviousOnConflict(
  absolutePath: string,
  owner: LockOwner,
): Promise<void> {
  const paths = transactionPaths(absolutePath, owner.token);
  if (!await exists(paths.previous)) return;
  if (!await exists(absolutePath)) {
    try {
      await link(paths.previous, absolutePath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  if (
    await exists(absolutePath) &&
    sha256(await readBoundedRegularFile(paths.previous)) !== owner.expectedDigest
  ) {
    try {
      await rename(paths.previous, paths.conflict);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
}

async function releaseLock(absolutePath: string, owner: LockOwner): Promise<void> {
  const lockPath = `${absolutePath}${LOCK_SUFFIX}`;
  let current: LockOwner | null = null;
  try {
    current = parseOwner(await readBoundedRegularFile(lockPath, 4_096));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (current?.token === owner.token) await rm(lockPath, { force: true });
}

async function atomicCreateAnchoredLocalFile(absolutePath: string, content: string): Promise<void> {
  const candidate = `${absolutePath}.hanoon-${randomUUID()}.candidate`;
  try {
    await writeSyncedFile(candidate, content);
    await link(candidate, absolutePath);
    await syncDirectory(absolutePath);
  } finally {
    await rm(candidate, { force: true });
  }
}

async function compareAndSwapAnchoredLocalFile(
  absolutePath: string,
  expectedDigest: string,
  content: string,
): Promise<void> {
  if (!DIGEST.test(expectedDigest)) throw new TypeError("expectedDigest must be a SHA-256 digest");
  const owner = await acquireLock(absolutePath, expectedDigest);
  const paths = transactionPaths(absolutePath, owner.token);
  let committed = false;
  let failure: unknown = null;
  try {
    await writeSyncedFile(paths.candidate, content);
    await rename(absolutePath, paths.previous);
    if (sha256(await readBoundedRegularFile(paths.previous)) !== expectedDigest) {
      throw new LocalFileCasConflictError();
    }
    try {
      // Exclusive publication matters here. A normal rename would overwrite a
      // human editor that atomically saved after the target was captured.
      await link(paths.candidate, absolutePath);
    } catch (error) {
      if (isAlreadyExists(error)) throw new LocalFileCasConflictError();
      throw error;
    }
    await syncDirectory(absolutePath);
    if (sha256(await readBoundedRegularFile(absolutePath)) !== sha256(content)) {
      throw new LocalFileCasConflictError();
    }
    committed = true;
  } catch (error) {
    failure = isNotFound(error) ? new LocalFileCasConflictError() : error;
  }
  const cleanup = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      if (failure === null) failure = error;
    }
  };
  if (!committed) await cleanup(() => preservePreviousOnConflict(absolutePath, owner));
  await cleanup(() => rm(paths.candidate, { force: true }));
  await cleanup(() => rm(paths.previous, { force: true }));
  await cleanup(() => releaseLock(absolutePath, owner));
  await cleanup(() => syncDirectory(absolutePath));
  if (failure !== null) throw failure;
}

export async function recoverLocalFileCas(
  absolutePath: string,
  containment?: LocalFileContainment,
): Promise<void> {
  try {
    await withAnchoredLocalPath(absolutePath, containment, recoverAnchoredLocalFileCas);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

export function atomicCreateLocalFile(
  absolutePath: string,
  content: string,
  containment?: LocalFileContainment,
): Promise<void> {
  assertBoundedLocalFileContent(content);
  return withAnchoredLocalPath(absolutePath, containment, (anchoredPath) =>
    atomicCreateAnchoredLocalFile(anchoredPath, content));
}

export function readBoundedLocalFile(
  absolutePath: string,
  containment?: LocalFileContainment,
): Promise<string> {
  return withAnchoredLocalPath(absolutePath, containment, readBoundedRegularFile);
}

export function ensureLocalDirectory(
  absolutePath: string,
  containment?: LocalFileContainment,
): Promise<void> {
  return withAnchoredLocalPath(absolutePath, containment, async (anchoredPath) => {
    try {
      await mkdir(anchoredPath, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const stats = await lstat(anchoredPath);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new TypeError("local tracker directory is not a regular directory");
      }
    }
  });
}

export function compareAndSwapLocalFile(
  absolutePath: string,
  expectedDigest: string,
  content: string,
  containment?: LocalFileContainment,
): Promise<void> {
  assertBoundedLocalFileContent(content);
  return withAnchoredLocalPath(absolutePath, containment, (anchoredPath) =>
    compareAndSwapAnchoredLocalFile(anchoredPath, expectedDigest, content));
}
