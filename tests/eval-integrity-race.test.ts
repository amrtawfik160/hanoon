import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const installCompetitorAtCommit = (targetPath: Parameters<typeof actual.writeFileSync>[0]) => {
    if (String(targetPath).endsWith("artifact.json")) {
      actual.writeFileSync(targetPath, "competitor\n", { mode: 0o600 });
    }
  };
  return {
    ...actual,
    linkSync(sourcePath: Parameters<typeof actual.linkSync>[0], targetPath: Parameters<typeof actual.linkSync>[1]) {
      installCompetitorAtCommit(targetPath);
      return actual.linkSync(sourcePath, targetPath);
    },
    renameSync(sourcePath: Parameters<typeof actual.renameSync>[0], targetPath: Parameters<typeof actual.renameSync>[1]) {
      installCompetitorAtCommit(targetPath);
      return actual.renameSync(sourcePath, targetPath);
    },
  };
});

const { publishValidatedArtifact } = await import("../src/eval/eval-integrity");

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
