import { describe, expect, it, vi } from "vitest";
import { adoptPullRequest, adoptedBranchName } from "../src/bb/pr-adoption";
import { policyFixture } from "./helpers";

const HEAD = "a".repeat(40);
const PR = {
  number: 17,
  url: "https://github.com/acme/cyndra/pull/17",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "feature/existing",
};

function harness(overrides: Partial<typeof PR> = {}, revParse = HEAD) {
  const runner = {
    run: vi.fn(async ({ command }: { command: string }) => {
      if (command === "git remote get-url origin") return { outcome: "exited" as const, exitCode: 0, output: "git@github.com:acme/cyndra.git\n" };
      if (command === "git ls-remote --exit-code origin refs/pull/17/head") {
        return { outcome: "exited" as const, exitCode: 0, output: `${HEAD}\trefs/pull/17/head\n` };
      }
      if (command.startsWith("gh pr view 17 ")) {
        return { outcome: "exited" as const, exitCode: 0, output: JSON.stringify({ ...PR, ...overrides }) };
      }
      if (command.startsWith("git fetch --force origin ")) return { outcome: "exited" as const, exitCode: 0, output: "" };
      if (command.startsWith("git rev-parse --verify ")) return { outcome: "exited" as const, exitCode: 0, output: `${revParse}\n` };
      throw new Error(`unexpected command: ${command}`);
    }),
  };
  return runner;
}

describe("existing pull-request adoption", () => {
  it("verifies and materializes the exact pull-request head as a deterministic local branch", async () => {
    const runner = harness();
    await expect(adoptPullRequest({
      runner,
      scope: { kind: "host_path", hostId: "host_1", cwd: "/project" },
      policy: policyFixture(),
      prNumber: 17,
    })).resolves.toEqual({
      prNumber: 17,
      prUrl: PR.url,
      headSha: HEAD,
      branchName: adoptedBranchName(17, HEAD),
      originRepository: "acme/cyndra",
    });
    expect(runner.run.mock.calls.map(([input]) => input.command)).toEqual([
      "git remote get-url origin",
      "git ls-remote --exit-code origin refs/pull/17/head",
      expect.stringMatching(/^gh pr view 17 /),
      `git fetch --force origin refs/pull/17/head:refs/heads/${adoptedBranchName(17, HEAD)}`,
      `git rev-parse --verify refs/heads/${adoptedBranchName(17, HEAD)}`,
    ]);
  });

  it.each([
    [{ state: "CLOSED" }, /open/i],
    [{ isDraft: true }, /draft/i],
    [{ baseRefName: "release" }, /base/i],
    [{ number: 18 }, /number|identity/i],
  ])("refuses an ineligible pull request before fetching it (%o)", async (change, message) => {
    const runner = harness(change as Partial<typeof PR>);
    await expect(adoptPullRequest({
      runner,
      scope: { kind: "host_path", hostId: "host_1", cwd: "/project" },
      policy: policyFixture(),
      prNumber: 17,
    })).rejects.toThrow(message);
    expect(runner.run.mock.calls.some(([input]) => input.command.startsWith("git fetch"))).toBe(false);
  });

  it("refuses a local branch that does not resolve to the verified remote head", async () => {
    await expect(adoptPullRequest({
      runner: harness({}, "b".repeat(40)),
      scope: { kind: "host_path", hostId: "host_1", cwd: "/project" },
      policy: policyFixture(),
      prNumber: 17,
    })).rejects.toThrow(/head/i);
  });
});
