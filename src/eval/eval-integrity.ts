import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
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

export function publishValidatedArtifact(options: ArtifactPublicationOptions): string {
  const targetPath = canonicalArtifactPath(options.artifactPath);
  options.validateSerialized(options.serialized);
  const parentPath = dirname(targetPath);
  const temporaryPath = join(parentPath, `.${basename(targetPath)}.${randomUUID()}.tmp`);
  let published = false;
  try {
    if (!options.replace) assertTargetDoesNotExist(targetPath);
    options.verifyBeforePublish?.();
    writeDurableTemporaryFile(temporaryPath, options.serialized);
    if (!options.replace) assertTargetDoesNotExist(targetPath);
    renameSync(temporaryPath, targetPath);
    published = true;
    verifyPublishedArtifact(targetPath, parentPath, options);
    return targetPath;
  } catch (error) {
    cleanupTemporaryFile(temporaryPath);
    if (published) cleanupPublishedFile(targetPath, options.serialized);
    throw new Error(`artifact publication failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertTargetDoesNotExist(targetPath: string): void {
  if (pathExists(targetPath)) throw new Error(`refusing to overwrite existing artifact ${targetPath}`);
}

function writeDurableTemporaryFile(temporaryPath: string, serialized: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function verifyPublishedArtifact(
  targetPath: string,
  parentPath: string,
  options: ArtifactPublicationOptions,
): void {
  fsyncDirectory(parentPath);
  canonicalArtifactPath(targetPath);
  const publishedText = readFileSync(targetPath, "utf8");
  if (publishedText !== options.serialized) {
    throw new Error("published artifact bytes differ from the validated bytes");
  }
  options.validateSerialized(publishedText);
  canonicalArtifactPath(targetPath);
  options.verifyIdentity();
}

function fsyncDirectory(directoryPath: string): void {
  const descriptor = openSync(directoryPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function cleanupTemporaryFile(temporaryPath: string): void {
  try {
    unlinkSync(temporaryPath);
  } catch {
    // Cleanup cannot make an incomplete artifact valid; the publication error remains primary.
  }
}

function cleanupPublishedFile(targetPath: string, serialized: string): void {
  try {
    if (readFileSync(targetPath, "utf8") === serialized) {
      unlinkSync(targetPath);
      fsyncDirectory(dirname(targetPath));
    }
  } catch {
    // A changed or unavailable target must not be removed after another writer took ownership.
  }
}
