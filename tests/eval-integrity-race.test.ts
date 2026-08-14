import {
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const installCompetitorAtCommit = (targetPath: Parameters<typeof actual.writeFileSync>[0]) => {
    const targetText = String(targetPath);
    const parentText = targetText.slice(0, targetText.lastIndexOf("/"));
    if (actual.realpathSync(parentText).includes("eval-integrity-no-clobber-") && targetText.endsWith("artifact.json")) {
      actual.writeFileSync(targetPath, "competitor\n", { mode: 0o600 });
    }
  };
  const replaceParentAtCommit = (targetPath: Parameters<typeof actual.writeFileSync>[0]) => {
    const targetText = String(targetPath);
    if (!targetText.endsWith("artifact.json")) return;
    const parentText = targetText.slice(0, targetText.lastIndexOf("/"));
    const parentPath = actual.realpathSync(parentText);
    if (!parentPath.includes("eval-integrity-parent-commit-")) return;
    actual.renameSync(parentPath, `${parentPath}-moved`);
    actual.mkdirSync(parentPath);
    actual.writeFileSync(`${parentPath}/artifact.json`, "attacker\n", { mode: 0o600 });
  };
  return {
    ...actual,
    linkSync(sourcePath: Parameters<typeof actual.linkSync>[0], targetPath: Parameters<typeof actual.linkSync>[1]) {
      installCompetitorAtCommit(targetPath);
      return actual.linkSync(sourcePath, targetPath);
    },
    renameSync(sourcePath: Parameters<typeof actual.renameSync>[0], targetPath: Parameters<typeof actual.renameSync>[1]) {
      installCompetitorAtCommit(targetPath);
      replaceParentAtCommit(targetPath);
      return actual.renameSync(sourcePath, targetPath);
    },
  };
});

const {
  closePreparedArtifactTarget,
  prepareArtifactTarget,
  publishValidatedArtifact,
} = await import("../src/eval/eval-integrity");

it("keeps preflight publication anchored to the approved parent after a path swap", () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-integrity-preflight-swap-"));
  const parentPath = join(directory, "publisher");
  const movedParentPath = join(directory, "publisher-moved");
  const artifactPath = join(parentPath, "artifact.json");
  mkdirSync(parentPath);
  const preparedTarget = prepareArtifactTarget(artifactPath);
  try {
    renameSync(parentPath, movedParentPath);
    mkdirSync(parentPath);
    writeFileSync(artifactPath, "attacker\\n", { mode: 0o600 });

    expect(() => publishValidatedArtifact({
      artifactPath,
      preparedTarget,
      serialized: "winner\\n",
      replace: true,
      validateSerialized: () => undefined,
      verifyIdentity: () => undefined,
    })).toThrow(/parent changed/i);
    expect(readFileSync(artifactPath, "utf8")).toBe("attacker\\n");
    expect(readdirSync(movedParentPath)).toEqual([]);
  } finally {
    closePreparedArtifactTarget(preparedTarget);
    expect(() => closePreparedArtifactTarget(preparedTarget)).not.toThrow();
    expect(() => fstatSync(preparedTarget.descriptor)).toThrow();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("does not clobber a competitor that appears during a no-replace commit", () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-integrity-no-clobber-"));
  const artifactPath = join(directory, "artifact.json");
  try {
    expect(() => publishValidatedArtifact({
      artifactPath,
      serialized: "winner\n",
      replace: false,
      validateSerialized: () => undefined,
      verifyIdentity: () => undefined,
    })).toThrow(/existing|publication/i);
    expect(readFileSync(artifactPath, "utf8")).toBe("competitor\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("fails closed without publishing into a replacement parent during no-replace publication", () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-integrity-parent-no-replace-"));
  const parentPath = join(directory, "publisher");
  const movedParentPath = join(directory, "publisher-moved");
  mkdirSync(parentPath);
  try {
    expect(() => publishValidatedArtifact({
      artifactPath: join(parentPath, "artifact.json"),
      serialized: "winner\n",
      replace: false,
      validateSerialized: () => undefined,
      verifyBeforePublish: () => {
        renameSync(parentPath, movedParentPath);
        mkdirSync(parentPath);
      },
      verifyIdentity: () => undefined,
    })).toThrow(/parent changed/i);
    expect(existsSync(join(parentPath, "artifact.json"))).toBe(false);
    expect(existsSync(join(movedParentPath, "artifact.json"))).toBe(false);
    expect(readdirSync(movedParentPath)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("fails closed without clobbering a replacement parent during replace publication", () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-integrity-parent-replace-"));
  const parentPath = join(directory, "publisher");
  const movedParentPath = join(directory, "publisher-moved");
  mkdirSync(parentPath);
  writeFileSync(join(parentPath, "artifact.json"), "attacker\n");
  try {
    expect(() => publishValidatedArtifact({
      artifactPath: join(parentPath, "artifact.json"),
      serialized: "winner\n",
      replace: true,
      validateSerialized: () => undefined,
      verifyBeforePublish: () => {
        renameSync(parentPath, movedParentPath);
        mkdirSync(parentPath);
        writeFileSync(join(parentPath, "artifact.json"), "attacker\n");
      },
      verifyIdentity: () => undefined,
    })).toThrow(/parent changed/i);
    expect(readFileSync(join(parentPath, "artifact.json"), "utf8")).toBe("attacker\n");
    expect(readFileSync(join(movedParentPath, "artifact.json"), "utf8")).toBe("attacker\n");
    expect(readdirSync(movedParentPath)).toEqual(["artifact.json"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("cleans the original committed artifact through its parent anchor after replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-integrity-parent-cleanup-"));
  const parentPath = join(directory, "publisher");
  const movedParentPath = join(directory, "publisher-moved");
  mkdirSync(parentPath);
  try {
    expect(() => publishValidatedArtifact({
      artifactPath: join(parentPath, "artifact.json"),
      serialized: "winner\n",
      replace: true,
      validateSerialized: () => undefined,
      verifyIdentity: () => {
        renameSync(parentPath, movedParentPath);
        mkdirSync(parentPath);
        writeFileSync(join(parentPath, "artifact.json"), "attacker\n");
      },
    })).toThrow(/parent changed|ownership/i);
    expect(readFileSync(join(parentPath, "artifact.json"), "utf8")).toBe("attacker\n");
    expect(existsSync(join(movedParentPath, "artifact.json"))).toBe(false);
    expect(readdirSync(movedParentPath)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("cleans a replace publication when the parent changes immediately after commit", () => {
  const directory = mkdtempSync(join(tmpdir(), "eval-integrity-parent-commit-"));
  const parentPath = join(directory, "publisher");
  const movedParentPath = join(directory, "publisher-moved");
  mkdirSync(parentPath);
  try {
    expect(() => publishValidatedArtifact({
      artifactPath: join(parentPath, "artifact.json"),
      serialized: "winner\n",
      replace: true,
      validateSerialized: () => undefined,
      verifyIdentity: () => undefined,
    })).toThrow(/parent changed/i);
    expect(readFileSync(join(parentPath, "artifact.json"), "utf8")).toBe("attacker\n");
    expect(existsSync(join(movedParentPath, "artifact.json"))).toBe(false);
    expect(readdirSync(movedParentPath)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
