import { z } from "zod";
import type { ProjectPolicy } from "../domain/models";
import { GIT_REMOTE_COMMAND, PR_HEAD_COMMAND, parseGitHubRemote, parseLsRemoteHead } from "./validation";
import type { CommandResult, TerminalScope } from "./terminal-command";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const prSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.string().min(1),
  isDraft: z.boolean(),
  baseRefName: z.string().min(1),
  headRefName: z.string().min(1),
}).strict();

type AdoptionRunner = {
  run(input: {
    scope: TerminalScope;
    title: string;
    command: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<CommandResult>;
};

export type AdoptedPullRequest = {
  prNumber: number;
  prUrl: string;
  headSha: string;
  branchName: string;
  originRepository: string;
};

export function adoptedBranchName(prNumber: number, headSha: string): string {
  if (!Number.isInteger(prNumber) || prNumber < 1 || !FULL_SHA.test(headSha)) {
    throw new TypeError("Adopted pull-request branch requires a positive number and full head SHA");
  }
  return `telegram-agent/adopt-pr-${String(prNumber)}-${headSha.slice(0, 12)}`;
}

async function runRequired(
  runner: AdoptionRunner,
  scope: TerminalScope,
  title: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runner.run({ scope, title, command, timeoutMs, signal });
  if (result.outcome !== "exited" || result.exitCode !== 0) {
    throw new Error(`${title} failed`);
  }
  return result.output;
}

function jsonPayload(rawOutput: string): string {
  const text = rawOutput.trim();
  const end = text.lastIndexOf("}");
  if (end === -1) return text;
  for (let start = text.indexOf("{"); start !== -1 && start < end; start = text.indexOf("{", start + 1)) {
    const candidate = text.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Terminal scrollback carries the echoed command and gh's progress label, so keep scanning.
    }
  }
  return text;
}

export async function adoptPullRequest(input: {
  runner: AdoptionRunner;
  scope: TerminalScope;
  policy: ProjectPolicy;
  prNumber: number;
  signal?: AbortSignal;
}): Promise<AdoptedPullRequest> {
  if (!Number.isInteger(input.prNumber) || input.prNumber < 1) {
    throw new TypeError("Pull-request number must be a positive integer");
  }
  const originRepository = parseGitHubRemote(await runRequired(
    input.runner, input.scope, "Read adoption origin", GIT_REMOTE_COMMAND, 60_000, input.signal,
  ));
  if (originRepository !== input.policy.githubRepository.toLowerCase()) {
    throw new Error("Origin repository does not match immutable project policy");
  }
  const headSha = parseLsRemoteHead(await runRequired(
    input.runner,
    input.scope,
    "Read adoption pull-request head",
    PR_HEAD_COMMAND(input.prNumber),
    60_000,
    input.signal,
  ), input.prNumber);
  const metadataCommand = `gh pr view ${String(input.prNumber)} --json number,url,state,isDraft,baseRefName,headRefName`;
  const metadataOutput = await runRequired(
    input.runner, input.scope, "Read adoption pull request", metadataCommand, 120_000, input.signal,
  );
  let metadata: z.infer<typeof prSchema>;
  try {
    metadata = prSchema.parse(JSON.parse(jsonPayload(metadataOutput)));
  } catch {
    throw new Error("Pull-request metadata is invalid");
  }
  if (metadata.number !== input.prNumber) throw new Error("Pull-request number does not match the requested identity");
  if (metadata.state.toUpperCase() !== "OPEN") throw new Error("Pull request must be open to adopt it");
  if (metadata.isDraft) throw new Error("Draft pull requests cannot be adopted");
  if (metadata.baseRefName !== input.policy.baseBranch) throw new Error("Pull-request base branch does not match project policy");
  const expectedUrl = `https://github.com/${input.policy.githubRepository}/pull/${String(input.prNumber)}`.toLowerCase();
  if (metadata.url.replace(/\/$/u, "").toLowerCase() !== expectedUrl) {
    throw new Error("Pull-request URL does not match the requested identity");
  }

  const branchName = adoptedBranchName(input.prNumber, headSha);
  await runRequired(
    input.runner,
    input.scope,
    "Fetch adoption pull request",
    `git fetch --force origin refs/pull/${String(input.prNumber)}/head:refs/heads/${branchName}`,
    120_000,
    input.signal,
  );
  const localHead = (await runRequired(
    input.runner,
    input.scope,
    "Verify adoption branch",
    `git rev-parse --verify refs/heads/${branchName}`,
    60_000,
    input.signal,
  )).trim().toLowerCase();
  if (localHead !== headSha) throw new Error("Adopted branch head does not match the verified pull-request head");
  return { prNumber: input.prNumber, prUrl: metadata.url, headSha, branchName, originRepository };
}
