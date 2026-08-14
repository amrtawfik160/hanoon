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
  if (!isAbsolute(artifactPath)) throw new Error("artifact path must be absolute");
  const requestedPath = resolve(artifactPath);
  const parentPath = dirname(requestedPath);
  const parentStat = lstatSync(parentPath);
  if (!parentStat.isDirectory()) throw new Error("artifact parent must be a directory");
  const canonicalParent = realpathSync(parentPath);
  if (pathExists(requestedPath)) {
    const targetStat = lstatSync(requestedPath);
    if (targetStat.isSymbolicLink()) throw new Error("artifact target must not be a symbolic link");
    if (!targetStat.isFile()) throw new Error("artifact target must be a regular file");
  }
  return join(canonicalParent, basename(requestedPath));
}

export type ArtifactPublicationOptions = Readonly<{
  artifactPath: string;
  serialized: string;
  replace: boolean;
  validateSerialized: (serialized: string) => void;
  verifyBeforePublish?: () => void;
  verifyIdentity: () => void;
}>;

type FileIdentity = Readonly<{ dev: number; ino: number }>;
type PublicationLock = Readonly<{ descriptor: number; identity: FileIdentity; path: string }>;
type OpenedTemporary = Readonly<{ descriptor: number; identity: FileIdentity; path: string }>;
type PublishedArtifact = Readonly<{
  descriptor: number;
  identity: FileIdentity;
  parentPath: string;
  targetPath: string;
}>;

export function publishValidatedArtifact(options: ArtifactPublicationOptions): string {
  const targetPath = canonicalArtifactPath(options.artifactPath);
  options.validateSerialized(options.serialized);
  const parentPath = dirname(targetPath);
  const lock = acquirePublicationLock(parentPath, targetPath);
  try {
    assertCanonicalParent(parentPath, targetPath);
    publishArtifactUnderLock(options, parentPath, targetPath);
    return targetPath;
  } finally {
    releasePublicationLock(lock, parentPath);
  }
}

function assertTargetDoesNotExist(targetPath: string): void {
  if (pathExists(targetPath)) throw new Error(`refusing to overwrite existing artifact ${targetPath}`);
}

function publishArtifactUnderLock(
  options: ArtifactPublicationOptions,
  parentPath: string,
  targetPath: string,
): void {
  const temporaryPath = join(parentPath, `.${basename(targetPath)}.${randomUUID()}.tmp`);
  let temporary: OpenedTemporary | null = null;
  let published: PublishedArtifact | null = null;
  try {
    if (!options.replace) assertTargetDoesNotExist(targetPath);
    options.verifyBeforePublish?.();
    temporary = writeDurableTemporaryFile(temporaryPath, options.serialized);
    published = commitArtifact(options, temporary, parentPath, targetPath);
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
  parentPath: string,
  targetPath: string,
): PublishedArtifact {
  if (options.replace) renameSync(temporary.path, targetPath);
  else linkSync(temporary.path, targetPath);
  return { descriptor: temporary.descriptor, identity: temporary.identity, parentPath, targetPath };
}

function publicationFailure(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`artifact publication failed: ${detail}`);
}

function writeDurableTemporaryFile(temporaryPath: string, serialized: string): OpenedTemporary {
  const descriptor = openSync(temporaryPath, "wx+", 0o600);
  const identity = fileIdentity(fstatSync(descriptor));
  try {
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    return { descriptor, identity, path: temporaryPath };
  } catch (error) {
    cleanupTemporaryFile({ descriptor, identity, path: temporaryPath });
    closeSync(descriptor);
    throw error;
  }
}

function verifyPublishedArtifact(
  published: PublishedArtifact,
  options: ArtifactPublicationOptions,
): void {
  assertCanonicalParent(published.parentPath, published.targetPath);
  fsyncDirectory(published.parentPath);
  assertPublishedOwnership(published);
  const publishedText = readPublishedBytes(published, options.serialized);
  options.validateSerialized(publishedText);
  assertPublishedOwnership(published);
  options.verifyIdentity();
  assertPublishedOwnership(published);
  readPublishedBytes(published, options.serialized);
  assertCanonicalParent(published.parentPath, published.targetPath);
}

function fsyncDirectory(directoryPath: string): void {
  const descriptor = openSync(directoryPath, "r");
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
    fsyncDirectory(published.parentPath);
  } catch {
    // A changed or unavailable target must not be removed after another writer took ownership.
  }
}

function acquirePublicationLock(parentPath: string, targetPath: string): PublicationLock {
  const lockPath = join(parentPath, `.${basename(targetPath)}.lock`);
  try {
    const descriptor = openSync(lockPath, "wx", 0o600);
    return { descriptor, identity: fileIdentity(fstatSync(descriptor)), path: lockPath };
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) throw new Error(`artifact publication already in progress for ${targetPath}`);
    throw error;
  }
}

function releasePublicationLock(lock: PublicationLock, parentPath: string): void {
  closeSync(lock.descriptor);
  try {
    const lockStat = lstatSync(lock.path);
    if (!sameFileIdentity(fileIdentity(lockStat), lock.identity)) return;
    unlinkSync(lock.path);
    fsyncDirectory(parentPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

function assertCanonicalParent(parentPath: string, targetPath: string): void {
  if (dirname(targetPath) !== parentPath || realpathSync(parentPath) !== parentPath) {
    throw new Error("artifact parent changed during publication");
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
