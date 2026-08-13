import { expect, it } from "vitest";
import {
  buildPublishPullRequestCommand,
  environmentBranchName,
  parsePublishedPullRequest,
  publishImplementationPullRequest,
} from "../src/bb/pr-publish";
import { jobFixture, policyFixture } from "./helpers";

it("reads the named checkout branch from either environment shape", () => {
  expect(environmentBranchName({
    workspace: { checkout: { kind: "branch", branchName: "feature/refunds" } },
  })).toBe("feature/refunds");
  expect(environmentBranchName({
    checkout: { kind: "branch", branch: "feature/refunds" },
  })).toBe("feature/refunds");
  expect(environmentBranchName({ available: true })).toBeNull();
});

it("builds a bounded publish script that commits only when needed and never interpolates raw request text into the shell", () => {
  const command = buildPublishPullRequestCommand({
    baseBranch: "main",
    title: "Fix refunds'; rm -rf /",
    body: "Job details",
  });

  expect(command.startsWith("bash -lc ")).toBe(true);
  expect(command).toContain("git add -A");
  expect(command).toContain("git commit");
  expect(command).toContain("git push -u origin HEAD");
  expect(command).toContain("gh pr create");
  expect(command).toContain("gh pr view --json number,url");
  expect(command).toContain("NO_UNIQUE_COMMITS");
  expect(command).not.toContain("Fix refunds'; rm -rf /");
  expect(command).toContain("Fix refunds rm -rf /");
});

it("parses the last valid pull-request JSON line from command output", () => {
  expect(parsePublishedPullRequest("noise\n{\"number\":17,\"url\":\"https://github.com/acme/app/pull/17\"}\n")).toEqual({
    number: 17,
    url: "https://github.com/acme/app/pull/17",
  });
  expect(parsePublishedPullRequest("NO_UNIQUE_COMMITS")).toBeNull();
});

it("publishes from executor output and reports a missing PR when there is nothing unique to push", async () => {
  const published = await publishImplementationPullRequest({
    runner: {
      run: async () => ({
        outcome: "exited",
        exitCode: 0,
        output: '{"number":867,"url":"https://github.com/Cyndra-AI/cyndra-saas/pull/867"}',
      }),
    },
    job: jobFixture({ requestText: "Fix the SSH write hang" }),
    policy: policyFixture(),
    environmentId: "env_1",
    environmentStatus: { checkout: { kind: "branch", branchName: "feature/ssh" } },
  });
  expect(published).toEqual({
    outcome: "published",
    number: 867,
    url: "https://github.com/Cyndra-AI/cyndra-saas/pull/867",
  });

  const empty = await publishImplementationPullRequest({
    runner: {
      run: async () => ({ outcome: "exited", exitCode: 2, output: "NO_UNIQUE_COMMITS" }),
    },
    job: jobFixture(),
    policy: policyFixture(),
    environmentId: "env_1",
    environmentStatus: { checkout: { kind: "branch", branchName: "feature/ssh" } },
  });
  expect(empty).toEqual({
    outcome: "missing",
    reason: "Implementation left no unique commits to publish",
  });
});
