import type { Job, ProjectPolicy } from "../domain/models";
import type { CommandResult } from "./terminal-command";

export type PublishCommandRunner = {
  run(input: {
    scope: { kind: "environment"; environmentId: string };
    title: string;
    command: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<CommandResult>;
};

export type PublishPullRequestResult =
  | { outcome: "published"; number: number; url: string }
  | { outcome: "missing"; reason: string };

const PR_JSON = /^\s*\{[\s\S]*\}\s*$/;
const SAFE_TITLE = /[^A-Za-z0-9 .,_/-]+/g;

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function environmentBranchName(status: unknown): string | null {
  const raw = asRecord(status);
  const workspace = asRecord(raw.workspace);
  const checkout = asRecord(raw.checkout ?? workspace.checkout);
  const branch = checkout.branchName ?? checkout.branch;
  return typeof branch === "string" && branch.trim().length > 0 ? branch.trim() : null;
}

export function parsePublishedPullRequest(output: string): { number: number; url: string } | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!PR_JSON.test(line)) continue;
    try {
      const parsed = JSON.parse(line) as { number?: unknown; url?: unknown };
      if (typeof parsed.number === "number" && Number.isInteger(parsed.number) && parsed.number >= 1
        && typeof parsed.url === "string" && parsed.url.startsWith("https://")) {
        return { number: parsed.number, url: parsed.url };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function buildPublishPullRequestCommand(input: {
  baseBranch: string;
  title: string;
  body: string;
}): string {
  const title = input.title.replace(SAFE_TITLE, " ").replace(/\s+/g, " ").trim().slice(0, 72) || "Implement requested change";
  const body = input.body.replace(/\r/g, "").slice(0, 500) || "Implemented by the Telegram agent executor.";
  const script = [
    "set -euo pipefail",
    `base=${shellSingleQuote(input.baseBranch)}`,
    `title=${shellSingleQuote(title)}`,
    `body=${shellSingleQuote(body)}`,
    'git add -A',
    'if ! git diff --cached --quiet; then git commit -m "$title"; fi',
    'git fetch --no-tags origin "$base"',
    'if git merge-base --is-ancestor HEAD "origin/$base"; then',
    '  printf \'%s\\n\' "NO_UNIQUE_COMMITS"',
    '  exit 2',
    'fi',
    'git push -u origin HEAD',
    'if ! gh pr view --json number,url >/dev/null 2>&1; then',
    '  gh pr create --base "$base" --title "$title" --body "$body" >/dev/null',
    'fi',
    'gh pr view --json number,url',
  ].join("\n");
  return `bash -lc ${shellSingleQuote(script)}`;
}

export async function publishImplementationPullRequest(input: {
  runner: PublishCommandRunner;
  job: Pick<Job, "id" | "requestText">;
  policy: ProjectPolicy;
  environmentId: string;
  environmentStatus: unknown;
  signal?: AbortSignal;
}): Promise<PublishPullRequestResult> {
  const branch = environmentBranchName(input.environmentStatus);
  if (!branch) return { outcome: "missing", reason: "Implementation checkout has no named branch to publish" };
  const command = buildPublishPullRequestCommand({
    baseBranch: input.policy.baseBranch,
    title: input.job.requestText,
    body: `Job ${input.job.id}\n\n${input.job.requestText}`.slice(0, 500),
  });
  let result: CommandResult;
  try {
    result = await input.runner.run({
      scope: { kind: "environment", environmentId: input.environmentId },
      title: `Telegram publish PR ${input.job.id}`,
      command,
      timeoutMs: 180_000,
      signal: input.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "publish command failed";
    return { outcome: "missing", reason: `Executor could not publish the pull request: ${message.slice(0, 160)}` };
  }
  if (result.outcome === "timed_out") return { outcome: "missing", reason: "Executor timed out while publishing the pull request" };
  if (result.outcome === "aborted") return { outcome: "missing", reason: "Executor publish was aborted" };
  if (result.exitCode === 2 && result.output.includes("NO_UNIQUE_COMMITS")) {
    return { outcome: "missing", reason: "Implementation left no unique commits to publish" };
  }
  const published = parsePublishedPullRequest(result.output);
  if (result.exitCode === 0 && published) return { outcome: "published", ...published };
  return { outcome: "missing", reason: "Executor could not create or locate a pull request after publish" };
}
