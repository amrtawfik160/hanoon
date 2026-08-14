import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  publishValidatedArtifact,
  readJsonFixtureSnapshot,
  verifyFixtureSnapshotUnchanged,
} from "../src/eval/eval-integrity";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

it("derives fixture parsing and digest from one immutable byte snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-integrity-fixture-"));
  const fixturePath = join(directory, "fixture.json");
  const originalText = '{"version":1}\n';
  writeFileSync(fixturePath, originalText);
  try {
    const snapshot = readJsonFixtureSnapshot(fixturePath, (candidate) => {
      writeFileSync(fixturePath, '{"version":2}\n');
      return candidate as { version: number };
    });

    expect(snapshot.value).toEqual({ version: 1 });
    expect(Object.isFrozen(snapshot.value)).toBe(true);
    expect(() => { (snapshot.value as { version: number }).version = 2; }).toThrow(TypeError);
    expect(snapshot.sha256).toBe(sha256(originalText));
    expect(() => verifyFixtureSnapshotUnchanged(snapshot, fixturePath)).toThrow(/changed/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("publishes bytes atomically and validates the bytes and identity after rename", () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-integrity-publication-"));
  const artifactPath = join(directory, "artifact.json");
  const serialized = '{"status":"failed"}\n';
  const validationInputs: string[] = [];
  try {
    publishValidatedArtifact({
      artifactPath,
      serialized,
      replace: true,
      validateSerialized: (candidate) => {
        validationInputs.push(candidate);
        expect(JSON.parse(candidate)).toEqual({ status: "failed" });
      },
      verifyIdentity: () => {
        expect(readFileSync(artifactPath, "utf8")).toBe(serialized);
      },
    });

    expect(readFileSync(artifactPath, "utf8")).toBe(serialized);
    expect(validationInputs).toEqual([serialized, serialized]);
    expect(readdirSync(directory)).toEqual(["artifact.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("removes a publication when post-write identity verification fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-integrity-identity-"));
  const artifactPath = join(directory, "artifact.json");
  try {
    expect(() => publishValidatedArtifact({
      artifactPath,
      serialized: '{"status":"failed"}\n',
      replace: true,
      validateSerialized: (candidate) => expect(JSON.parse(candidate)).toEqual({ status: "failed" }),
      verifyIdentity: () => { throw new Error("run identity changed"); },
    })).toThrow(/identity changed/i);
    expect(existsSync(artifactPath)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects a symlink target before publication", () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-integrity-link-"));
  const protectedPath = join(directory, "protected.json");
  const artifactPath = join(directory, "artifact.json");
  writeFileSync(protectedPath, "protected\n");
  symlinkSync(protectedPath, artifactPath);
  try {
    expect(() => publishValidatedArtifact({
      artifactPath,
      serialized: "replacement\n",
      replace: true,
      validateSerialized: () => undefined,
      verifyIdentity: () => undefined,
    })).toThrow(/symbolic link|symlink/i);
    expect(readFileSync(protectedPath, "utf8")).toBe("protected\n");
    expect(existsSync(artifactPath)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
