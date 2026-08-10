import { describe, expect, test, vi } from "vitest";
import {
  parseGitHubRemote,
  parseLsRemoteHead,
  resolvePrHead,
  runValidation,
} from "../src/bb/validation";

const remoteSha = "a".repeat(40);
const movedSha = "b".repeat(40);
const prNumber = 17;
const lsRemoteCommand = "git ls-remote --exit-code origin refs/pull/17/head";
const prViewCommand =
  "gh pr view 17 --json number,url,state,isDraft,baseRefName,headRefName,mergeStateStatus,mergeable,reviewDecision,changedFiles,additions,deletions,mergeCommit,mergedAt";
const checksCommand = "gh pr checks 17 --required --json name,bucket,state,link";

const prJson = {
  number: prNumber,
  url: "https://github.com/Acme/Telegram/pull/17",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feature/telegram",
  mergeStateStatus: "CLEAN",
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  changedFiles: 3,
  additions: 14,
  deletions: 2,
  mergeCommit: null,
  mergedAt: null,
};

const checksJson = [{ name: "lint", bucket: "pass", state: "SUCCESS", link: "https://ci/lint" }];

function cleanEnvironmentStatus(headSha = remoteSha) {
  return {
    available: true,
    clean: true,
    checkout: { kind: "branch", branch: "feature/telegram", headSha },
  };
}

function exited(output: string, exitCode = 0) {
  return { outcome: "exited" as const, exitCode, output };
}

function makeValidationHarness(options: {
  remoteOutputs?: string[];
  prOutput?: string;
  checksOutput?: string;
  checksExitCode?: number;
  policyCommands?: string[];
  policyResults?: Array<{ output: string; exitCode: number }>;
  statuses?: unknown[];
  remoteOutput?: string;
  extraPolicy?: Record<string, unknown>;
} = {}) {
  const statuses = options.statuses ?? [cleanEnvironmentStatus(), cleanEnvironmentStatus()];
  const status = vi.fn();
  for (const value of statuses) status.mockResolvedValueOnce(value);

  const remoteOutputs = options.remoteOutputs ?? [options.remoteOutput ?? `\n${remoteSha}\trefs/pull/17/head\n`, `\n${remoteSha}\trefs/pull/17/head\n`];
  let lsRemoteIndex = 0;
  let policyIndex = 0;
  const runner = {
    run: vi.fn(async ({ command }: { command: string }) => {
      if (command === "git remote get-url origin") {
        return exited("git@github.com:Acme/Telegram.git\n");
      }
      if (command === lsRemoteCommand) {
        const output = remoteOutputs[Math.min(lsRemoteIndex++, remoteOutputs.length - 1)];
        return exited(output);
      }
      if (command === prViewCommand) {
        return exited(options.prOutput ?? JSON.stringify(prJson));
      }
      if (command === checksCommand) {
        return exited(options.checksOutput ?? JSON.stringify(checksJson), options.checksExitCode ?? 0);
      }
      if ((options.policyCommands ?? []).includes(command)) {
        const result = options.policyResults?.[policyIndex++] ?? { output: "", exitCode: 0 };
        return exited(result.output, result.exitCode);
      }
      throw new Error(`unexpected command: ${command}`);
    }),
  };

  const input = {
    runner,
    environments: { status },
    environmentId: "env-1",
    job: {
      id: "job-1",
      version: 4,
      prNumber,
      policy: {
        githubRepository: "acme/telegram",
        baseBranch: "main",
        validationCommands: options.policyCommands ?? [],
        requiredChecks: ["lint"],
        outputRedactionPatterns: [],
        ...options.extraPolicy,
      },
    },
    currentReviewAttempt: { id: "attempt-1" },
  };

  return { input, runner, status };
}

describe("GitHub remote parsing", () => {
  test.each([
    ["https://github.com/Acme/Telegram.git", "acme/telegram"],
    ["https://github.com/Acme/Telegram", "acme/telegram"],
    ["git@github.com:Acme/Telegram.git", "acme/telegram"],
    ["ssh://git@github.com/Acme/Telegram.git", "acme/telegram"],
  ])("normalizes a credential-free GitHub origin %s", (remote, expected) => {
    expect(parseGitHubRemote(remote)).toBe(expected);
  });

  test.each([
    "https://github.com:token@Acme/Telegram.git",
    "https://token@github.com/Acme/Telegram.git",
    "https://git@github.com/Acme/Telegram.git",
    "https://gitlab.com/Acme/Telegram.git",
    "not a remote url",
  ])("rejects an unsupported or credential-bearing origin %s", (remote) => {
    expect(() => parseGitHubRemote(remote)).toThrow();
  });
});

describe("ls-remote head parsing", () => {
  test("accepts exactly one full OID for the requested pull ref", () => {
    expect(parseLsRemoteHead(`${remoteSha}\trefs/pull/17/head\n`, prNumber)).toBe(remoteSha);
  });

  test.each([
    ["", "missing row"],
    [`${remoteSha}\trefs/pull/18/head\n`, "wrong ref name"],
    [`${remoteSha}\trefs/pull/17/head\n${movedSha}\trefs/pull/17/head\n`, "multiple rows"],
    ["not-a-sha refs/pull/17/head\n", "malformed row"],
    [`${remoteSha.slice(0, 39)}\trefs/pull/17/head\n`, "short OID"],
  ])("rejects a %s ls-remote response", (output) => {
    expect(() => parseLsRemoteHead(output, prNumber)).toThrow();
  });
});

describe("runValidation", () => {
  test("runs the exact origin, PR, checks, and repeated head commands in order", async () => {
    const { input, runner } = makeValidationHarness();

    const snapshot = await runValidation(input as never);

    expect(runner.run.mock.calls.map(([call]) => call.command)).toEqual([
      "git remote get-url origin",
      lsRemoteCommand,
      prViewCommand,
      checksCommand,
      lsRemoteCommand,
    ]);
    expect(snapshot).toMatchObject({
      headSha: remoteSha,
      originRepository: "acme/telegram",
      requiredChecks: checksJson,
    });
    expect(snapshot).not.toHaveProperty("githubPr.headRefOid");
    expect(snapshot.githubPr).toEqual(prJson);
    expect(typeof snapshot.completedAt).toBe("string");
  });

  test.each([
    [0, "pass"],
    [1, "fail"],
    [8, "pending"],
  ])("parses strict checks JSON and derives readiness from bucket for exit %s", async (exitCode, bucket) => {
    const { input } = makeValidationHarness({
      checksExitCode: exitCode,
      checksOutput: JSON.stringify([{ name: "lint", bucket, state: bucket.toUpperCase(), link: null }]),
    });

    const snapshot = await runValidation(input as never);

    expect(snapshot.requiredChecks).toEqual([
      { name: "lint", bucket, state: bucket.toUpperCase(), link: null },
    ]);
  });

  test("rejects an infrastructure exit from gh checks even when output looks like JSON", async () => {
    const { input } = makeValidationHarness({
      checksExitCode: 2,
      checksOutput: JSON.stringify(checksJson),
    });

    await expect(runValidation(input as never)).rejects.toThrow(/checks/i);
  });

  test("stops policy validation at the first non-pass and retains prior receipts", async () => {
    const commands = ["npm run lint", "npm test"];
    const { input, runner } = makeValidationHarness({
      policyCommands: commands,
      policyResults: [
        { output: "lint passed", exitCode: 0 },
        { output: "unit failed", exitCode: 1 },
      ],
    });

    const snapshot = await runValidation(input as never);

    expect(runner.run.mock.calls.map(([call]) => call.command)).toEqual([
      "git remote get-url origin",
      lsRemoteCommand,
      "npm run lint",
      "npm test",
    ]);
    expect(snapshot.validationOutcome).toBe("fail");
    expect(snapshot.commandReceipts).toHaveLength(4);
    expect(snapshot.commandReceipts.map((receipt: { command: string }) => receipt.command)).toEqual([
      "git remote get-url origin",
      lsRemoteCommand,
      "npm run lint",
      "npm test",
    ]);
  });

  test("redacts configured patterns and generic bearer or token-shaped output", async () => {
    const { input } = makeValidationHarness({
      extraPolicy: { outputRedactionPatterns: ["customer-secret-[0-9]+"] },
      policyCommands: ["echo secrets"],
      policyResults: [
        {
          output: "customer-secret-123 Bearer abcdefghijklmnopqrstuvwxyz github_pat_1234567890",
          exitCode: 0,
        },
      ],
    });

    const snapshot = await runValidation(input as never);
    const rendered = JSON.stringify(snapshot.commandReceipts);

    expect(rendered).not.toContain("customer-secret-123");
    expect(rendered).not.toContain("Bearer abcdefghijklmnopqrstuvwxyz");
    expect(rendered).not.toContain("github_pat_1234567890");
    expect(rendered).toContain("[REDACTED]");
  });

  test("rejects an invalid configured redaction expression before running commands", async () => {
    const { input, runner } = makeValidationHarness({
      extraPolicy: { outputRedactionPatterns: ["["] },
    });

    await expect(runValidation(input as never)).rejects.toThrow(/redaction|regular expression|regex/i);
    expect(runner.run).not.toHaveBeenCalled();
  });

  test("rejects stale non-head PR metadata instead of mapping it into the snapshot", async () => {
    const { input } = makeValidationHarness({
      prOutput: JSON.stringify({ ...prJson, headRefOid: movedSha }),
    });

    await expect(runValidation(input as never)).rejects.toThrow(/unexpected|schema|headRefOid/i);
  });

  test("rejects a changing remote head between the two Git lookups", async () => {
    const { input } = makeValidationHarness({
      remoteOutputs: [
        `${remoteSha}\trefs/pull/17/head\n`,
        `${movedSha}\trefs/pull/17/head\n`,
      ],
    });

    await expect(runValidation(input as never)).rejects.toThrow(/move|changed|head/i);
  });

  test("requires a clean branch checkout again after validation", async () => {
    const { input } = makeValidationHarness({
      statuses: [cleanEnvironmentStatus(), { available: true, clean: false, checkout: { kind: "branch", branch: "feature/telegram", headSha: remoteSha } }],
    });

    await expect(runValidation(input as never)).rejects.toThrow(/clean|worktree/i);
  });

  test("does not render credential-bearing remote output in an error", async () => {
    const secretRemote = "https://x-access-token:super-secret@github.com/Acme/Telegram.git\n";
    const { input } = makeValidationHarness({ remoteOutput: secretRemote });

    const error = await runValidation(input as never).then(
      () => new Error("expected validation to reject"),
      (value: unknown) => value as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("super-secret");
    expect(error.message).not.toContain(secretRemote.trim());
  });

  test("resolves a clean PR head from the same strict Git evidence before review", async () => {
    const { runner } = makeValidationHarness();
    const environments = {
      status: vi
        .fn()
        .mockResolvedValue(cleanEnvironmentStatus()),
    };

    const resolved = await resolvePrHead({
      runner,
      environments,
      environmentId: "env-1",
      prNumber,
      githubRepository: "acme/telegram",
    } as never);

    expect(resolved).toMatchObject({
      event: "PR_HEAD_RESOLVED",
      remoteHeadSha: remoteSha,
      headSha: remoteSha,
    });
  });

  test("returns a typed failure when pre-review head truth cannot be resolved", async () => {
    const { runner } = makeValidationHarness({
      remoteOutputs: [`${movedSha}\trefs/pull/17/head\n`],
    });
    const environments = { status: vi.fn().mockResolvedValue(cleanEnvironmentStatus(remoteSha)) };

    const result = await resolvePrHead({
      runner,
      environments,
      environmentId: "env-1",
      prNumber,
      githubRepository: "acme/telegram",
    } as never);

    expect(result).toMatchObject({ event: "PR_HEAD_RESOLUTION_FAILED" });
    expect(result).toHaveProperty("code");
  });

  describe("Task 8 round 1: owner command redaction", () => {
    test("executes the raw owner command but never persists or titles it", async () => {
      const rawCommand = "npm run verify -- --owner-secret=command-secret";
      const { input, runner } = makeValidationHarness({
        policyCommands: [rawCommand],
        policyResults: [{ output: "verification passed", exitCode: 0 }],
      });

      const snapshot = await runValidation(input as never);
      const policyCall = runner.run.mock.calls.find(([call]) => call.command === rawCommand)?.[0] as
        | { command: string; title?: string }
        | undefined;
      const persisted = JSON.stringify(snapshot.commandReceipts);

      expect(policyCall?.command).toBe(rawCommand);
      expect(policyCall?.title).not.toContain(rawCommand);
      expect(persisted).not.toContain(rawCommand);
      expect(persisted).not.toContain("command-secret");
      expect(persisted).toContain("[REDACTED]");
    });

    test.each(["error", "timeout", "abort"] as const)(
      "redacts the raw owner command from a %s message",
      async (outcome) => {
        const rawCommand = `npm run verify -- --owner-secret=${outcome}-secret`;
        const { input, runner } = makeValidationHarness({ policyCommands: [rawCommand] });
        const baseRun = runner.run.getMockImplementation();
        runner.run.mockImplementation(
          (async ({ command }: { command: string }) => {
            if (command === rawCommand) {
              if (outcome === "error") throw new Error(`validation failed: ${rawCommand}`);
              return { outcome: outcome === "timeout" ? "timed_out" : "aborted" } as never;
            }
            if (!baseRun) throw new Error("missing validation harness");
            return baseRun({ command });
          }) as never,
        );

        const error = await runValidation(input as never).then(
          () => new Error("expected validation to reject"),
          (value: unknown) => value as Error,
        );

        expect(error).toBeInstanceOf(Error);
        expect(error.message).not.toContain(rawCommand);
        expect(error.message).not.toContain(`${outcome}-secret`);
        expect(error.message).toContain("[REDACTED]");
      },
    );
  });
});
