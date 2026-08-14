import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

type FileIdentity = Readonly<{ dev: number; ino: number }>;

export type JsonFixtureSnapshot<T> = Readonly<{
  path: string;
  bytes: ReadonlyArray<number>;
  sha256: string;
  value: T;
}>;

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function freezeJsonValue<T>(snapshotValue: T): T {
  if (typeof snapshotValue !== "object" || snapshotValue === null) return snapshotValue;
  for (const childValue of Object.values(snapshotValue as Record<string, unknown>)) freezeJsonValue(childValue);
  return Object.freeze(snapshotValue);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export function readJsonFixtureSnapshot<T>(
  fixturePath: string,
  parse: (candidate: unknown) => T,
): JsonFixtureSnapshot<T> {
  const absolutePath = resolve(fixturePath);
  const bytes = Buffer.from(readFileSync(absolutePath));
  const text = bytes.toString("utf8");
  const value = freezeJsonValue(parse(JSON.parse(text)));
  return Object.freeze({
    path: absolutePath,
    bytes: Object.freeze(Array.from(bytes)),
    sha256: sha256Bytes(bytes),
    value,
  });
}

export function verifyFixtureSnapshotUnchanged<T>(
  snapshot: JsonFixtureSnapshot<T>,
  fixturePath: string = snapshot.path,
): void {
  const currentBytes = Buffer.from(readFileSync(resolve(fixturePath)));
  const expectedBytes = Buffer.from(snapshot.bytes);
  const sameLength = currentBytes.byteLength === expectedBytes.byteLength;
  const sameBytes = sameLength && timingSafeEqual(currentBytes, expectedBytes);
  if (!sameBytes) throw new Error(`fixture changed before publication: ${resolve(fixturePath)}`);
}

export function canonicalArtifactPath(artifactPath: string): string {
  return canonicalArtifactLocation(artifactPath).targetPath;
}

type CanonicalArtifactLocation = Readonly<{
  targetPath: string;
  parentPath: string;
  parentIdentity: FileIdentity;
}>;

function canonicalArtifactLocation(artifactPath: string): CanonicalArtifactLocation {
  if (!isAbsolute(artifactPath)) throw new Error("artifact path must be absolute");
  const requestedPath = resolve(artifactPath);
  const parentPath = dirname(requestedPath);
  const parentStat = lstatSync(parentPath);
  if (!parentStat.isDirectory()) throw new Error("artifact parent must be a directory");
  const canonicalParent = realpathSync(parentPath);
  const canonicalParentStat = lstatSync(canonicalParent);
  if (!canonicalParentStat.isDirectory()
    || !sameFileIdentity(fileIdentity(parentStat), fileIdentity(canonicalParentStat))) {
    throw new Error("artifact parent changed during publication");
  }
  if (pathExists(requestedPath)) {
    const targetStat = lstatSync(requestedPath);
    if (targetStat.isSymbolicLink()) throw new Error("artifact target must not be a symbolic link");
    if (!targetStat.isFile()) throw new Error("artifact target must be a regular file");
  }
  return {
    targetPath: join(canonicalParent, basename(requestedPath)),
    parentPath: canonicalParent,
    parentIdentity: fileIdentity(canonicalParentStat),
  };
}

export type ArtifactPublicationOptions = Readonly<{
  artifactPath: string;
  serialized: string;
  replace: boolean;
  validateSerialized: (serialized: string) => void;
  verifyBeforePublish?: () => void;
  verifyIdentity: () => void;
}>;

type PublicationParent = Readonly<{
  descriptor: number;
  identity: FileIdentity;
  path: string;
  anchorPath: string;
}>;
type PublicationLock = Readonly<{ descriptor: number; identity: FileIdentity; path: string }>;
type OpenedTemporary = Readonly<{ descriptor: number; identity: FileIdentity; path: string }>;
type PublishedArtifact = Readonly<{
  descriptor: number;
  identity: FileIdentity;
  parent: PublicationParent;
  targetPath: string;
}>;

export function publishValidatedArtifact(options: ArtifactPublicationOptions): string {
  const location = canonicalArtifactLocation(options.artifactPath);
  const targetPath = location.targetPath;
  options.validateSerialized(options.serialized);
  const parent = openPublicationParent(location.parentPath, location.parentIdentity);
  let lock: PublicationLock | null = null;
  try {
    lock = acquirePublicationLock(parent, targetPath);
    assertCurrentPublicationParent(parent);
    publishArtifactUnderLock(options, parent, targetPath);
    assertCurrentPublicationParent(parent);
    return targetPath;
  } finally {
    try {
      if (lock) releasePublicationLock(lock, parent);
    } finally {
      closePublicationParent(parent);
    }
  }
}

function openPublicationParent(parentPath: string, expectedIdentity: FileIdentity): PublicationParent {
  if (process.platform !== "linux") {
    throw new Error("artifact publication requires Linux directory descriptor anchoring");
  }
  const parentStat = lstatSync(parentPath);
  if (!parentStat.isDirectory()) throw new Error("artifact parent must be a directory");
  if (!sameFileIdentity(fileIdentity(parentStat), expectedIdentity)) {
    throw new Error("artifact parent changed during publication");
  }
  const descriptor = openSync(parentPath, "r");
  try {
    const parent: PublicationParent = {
      descriptor,
      identity: expectedIdentity,
      path: parentPath,
      anchorPath: join("/proc/self/fd", String(descriptor)),
    };
    if (!sameFileIdentity(fileIdentity(fstatSync(descriptor)), expectedIdentity)) {
      throw new Error("artifact parent changed during publication");
    }
    realpathSync(parent.anchorPath);
    assertCurrentPublicationParent(parent);
    return parent;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function closePublicationParent(parent: PublicationParent): void {
  closeSync(parent.descriptor);
}

function assertCurrentPublicationParent(parent: PublicationParent): void {
  try {
    const currentStat = lstatSync(parent.path);
    const descriptorIdentity = fileIdentity(fstatSync(parent.descriptor));
    if (!currentStat.isDirectory()
      || !sameFileIdentity(fileIdentity(currentStat), parent.identity)
      || !sameFileIdentity(descriptorIdentity, parent.identity)) {
      throw new Error("artifact parent changed during publication");
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR") || hasErrorCode(error, "ELOOP")) {
      throw new Error("artifact parent changed during publication");
    }
    throw error;
  }
}

function anchoredPath(parent: PublicationParent, displayPath: string): string {
  return join(parent.anchorPath, basename(displayPath));
}

function assertTargetDoesNotExist(targetPath: string, displayTargetPath: string): void {
  if (pathExists(targetPath)) throw new Error(`refusing to overwrite existing artifact ${displayTargetPath}`);
}

function publishArtifactUnderLock(
  options: ArtifactPublicationOptions,
  parent: PublicationParent,
  targetPath: string,
): void {
  const anchoredTargetPath = anchoredPath(parent, targetPath);
  const temporaryPath = join(parent.anchorPath, `.${basename(targetPath)}.${randomUUID()}.tmp`);
  let temporary: OpenedTemporary | null = null;
  let published: PublishedArtifact | null = null;
  try {
    assertCurrentPublicationParent(parent);
    if (!options.replace) assertTargetDoesNotExist(anchoredTargetPath, targetPath);
    options.verifyBeforePublish?.();
    assertCurrentPublicationParent(parent);
    temporary = writeDurableTemporaryFile(temporaryPath, options.serialized, parent);
    published = commitArtifact(options, temporary, parent, targetPath);
    verifyPublishedArtifact(published, options);
  } catch (error) {
    failPublication(error, published);
  } finally {
    closeTemporaryFile(temporary);
  }
}

function failPublication(error: unknown, published: PublishedArtifact | null): never {
  if (published) cleanupPublishedFile(published);
  throw publicationFailure(error);
}

function closeTemporaryFile(temporary: OpenedTemporary | null): void {
  if (temporary === null) return;
  cleanupTemporaryFile(temporary);
  closeSync(temporary.descriptor);
}

function commitArtifact(
  options: ArtifactPublicationOptions,
  temporary: OpenedTemporary,
  parent: PublicationParent,
  targetPath: string,
): PublishedArtifact {
  const anchoredTargetPath = anchoredPath(parent, targetPath);
  assertCurrentPublicationParent(parent);
  if (options.replace) renameSync(temporary.path, anchoredTargetPath);
  else linkSync(temporary.path, anchoredTargetPath);
  const published: PublishedArtifact = {
    descriptor: temporary.descriptor,
    identity: temporary.identity,
    parent,
    targetPath: anchoredTargetPath,
  };
  try {
    assertCurrentPublicationParent(parent);
    return published;
  } catch (error) {
    cleanupPublishedFile(published);
    throw error;
  }
}

function publicationFailure(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`artifact publication failed: ${detail}`);
}

function writeDurableTemporaryFile(
  temporaryPath: string,
  serialized: string,
  parent: PublicationParent,
): OpenedTemporary {
  assertCurrentPublicationParent(parent);
  const descriptor = openSync(temporaryPath, "wx+", 0o600);
  const identity = fileIdentity(fstatSync(descriptor));
  const temporary = { descriptor, identity, path: temporaryPath };
  try {
    assertCurrentPublicationParent(parent);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    assertCurrentPublicationParent(parent);
    return temporary;
  } catch (error) {
    cleanupTemporaryFile(temporary);
    closeSync(descriptor);
    throw error;
  }
}

function verifyPublishedArtifact(
  published: PublishedArtifact,
  options: ArtifactPublicationOptions,
): void {
  assertCurrentPublicationParent(published.parent);
  fsyncDirectory(published.parent.anchorPath);
  assertPublishedOwnership(published);
  const publishedText = readPublishedBytes(published, options.serialized);
  options.validateSerialized(publishedText);
  assertPublishedOwnership(published);
  options.verifyIdentity();
  assertCurrentPublicationParent(published.parent);
  assertPublishedOwnership(published);
  readPublishedBytes(published, options.serialized);
  assertCurrentPublicationParent(published.parent);
}

function fsyncDirectory(directoryAnchorPath: string): void {
  const descriptor = openSync(directoryAnchorPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function cleanupTemporaryFile(temporary: OpenedTemporary): void {
  try {
    const stat = lstatSync(temporary.path);
    if (!sameFileIdentity(fileIdentity(stat), temporary.identity)) return;
    unlinkSync(temporary.path);
  } catch {
    // Cleanup cannot make an incomplete artifact valid; the publication error remains primary.
  }
}

function cleanupPublishedFile(published: PublishedArtifact): void {
  try {
    if (!pathOwnsPublishedDescriptor(published)) return;
    unlinkSync(published.targetPath);
    fsyncDirectory(published.parent.anchorPath);
  } catch {
    // A changed or unavailable target must not be removed after another writer took ownership.
  }
}

function acquirePublicationLock(parent: PublicationParent, targetPath: string): PublicationLock {
  const lockPath = join(parent.anchorPath, `.${basename(targetPath)}.lock`);
  assertCurrentPublicationParent(parent);
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) throw new Error(`artifact publication already in progress for ${targetPath}`);
    throw error;
  }
  let lock: PublicationLock;
  try {
    lock = { descriptor, identity: fileIdentity(fstatSync(descriptor)), path: lockPath };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  try {
    assertCurrentPublicationParent(parent);
    return lock;
  } catch (error) {
    releasePublicationLock(lock, parent);
    throw error;
  }
}

function releasePublicationLock(lock: PublicationLock, parent: PublicationParent): void {
  closeSync(lock.descriptor);
  try {
    const lockStat = lstatSync(lock.path);
    if (!sameFileIdentity(fileIdentity(lockStat), lock.identity)) return;
    unlinkSync(lock.path);
    fsyncDirectory(parent.anchorPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

function fileIdentity(stat: { dev: number; ino: number }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function pathOwnsPublishedDescriptor(published: PublishedArtifact): boolean {
  try {
    const targetStat = lstatSync(published.targetPath);
    return sameFileIdentity(fileIdentity(targetStat), published.identity);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function assertPublishedOwnership(published: PublishedArtifact): void {
  if (!pathOwnsPublishedDescriptor(published)) {
    throw new Error("published artifact ownership changed during verification");
  }
}

function readPublishedBytes(published: PublishedArtifact, expectedSerialized: string): string {
  const expectedBytes = Buffer.from(expectedSerialized, "utf8");
  const descriptorStat = fstatSync(published.descriptor);
  if (descriptorStat.size !== expectedBytes.byteLength) throw new Error("published artifact bytes differ from the validated bytes");
  const currentBytes = readDescriptorBytes(published.descriptor, descriptorStat.size);
  assertExpectedArtifactBytes(currentBytes, expectedBytes);
  if (!sameFileIdentity(fileIdentity(fstatSync(published.descriptor)), published.identity)) {
    throw new Error("published artifact descriptor identity changed during verification");
  }
  return currentBytes.toString("utf8");
}

function readDescriptorBytes(descriptor: number, byteLength: number): Buffer {
  const bytes = Buffer.alloc(byteLength);
  let bytesRead = 0;
  while (bytesRead < bytes.byteLength) {
    const readCount = readSync(
      descriptor,
      bytes,
      bytesRead,
      bytes.byteLength - bytesRead,
      bytesRead,
    );
    if (readCount === 0) throw new Error("published artifact bytes could not be fully read");
    bytesRead += readCount;
  }
  return bytes;
}

function assertExpectedArtifactBytes(currentBytes: Buffer, expectedBytes: Buffer): void {
  if (!currentBytes.equals(expectedBytes)) {
    throw new Error("published artifact bytes differ from the validated bytes");
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === code;
}
