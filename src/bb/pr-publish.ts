import type { Job, ProjectPolicy } from "../domain/models";
import { shellSingleQuote } from "./terminal-command";
import type { CommandResult } from "./terminal-command";
import {
  SELF_DIAGNOSIS_PR_TITLE_PREFIX,
  buildSelfDiagnosisPullRequestBody,
  type SelfDiagnosisCandidate,
  type StructuredSelfDiagnosis,
} from "../services/self-diagnosis-service";

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

export type SelfDiagnosisPullRequestResult = PublishPullRequestResult;

const PR_JSON = /^\s*\{[\s\S]*\}\s*$/;
const SAFE_TITLE = /[^A-Za-z0-9 .,_/-]+/g;
const SAFE_GIT_REF = /^[A-Za-z0-9._/-]{1,200}$/;
const PROTECTED_BRANCHES = new Set(["main", "master", "trunk"]);

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

function selfDiagnosisTitle(kind: SelfDiagnosisCandidate["kind"]): string {
  return `${SELF_DIAGNOSIS_PR_TITLE_PREFIX}: ${kind}`;
}

export function buildListSelfDiagnosisPullRequestsCommand(): string {
  return "gh pr list --state open --search 'in:title \"Self-diagnosis candidate fix\"' --limit 1000 --json number,url,title";
}

export function parseOpenSelfDiagnosisPullRequests(output: string): Array<{ number: number; url: string }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const open: Array<{ number: number; url: string }> = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.title !== "string" || !record.title.startsWith(SELF_DIAGNOSIS_PR_TITLE_PREFIX) ||
      typeof record.number !== "number" || !Number.isInteger(record.number) || record.number < 1 ||
      typeof record.url !== "string" || !record.url.startsWith("https://")
    ) continue;
    open.push({ number: record.number, url: record.url });
  }
  return open;
}

export function parseDraftSelfDiagnosisPullRequest(output: string): { number: number; url: string } | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!PR_JSON.test(line)) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (
        parsed.isDraft !== true ||
        typeof parsed.number !== "number" || !Number.isInteger(parsed.number) || parsed.number < 1 ||
        typeof parsed.url !== "string" || !parsed.url.startsWith("https://") ||
        typeof parsed.headRefName !== "string" || PROTECTED_BRANCHES.has(parsed.headRefName)
      ) continue;
      return { number: parsed.number, url: parsed.url };
    } catch {
      continue;
    }
  }
  return null;
}

export function buildSelfDiagnosisPullRequestCommand(input: {
  baseBranch: string;
  kind: SelfDiagnosisCandidate["kind"];
  body: string;
}): string {
  if (!SAFE_GIT_REF.test(input.baseBranch)) {
    throw new TypeError("self-diagnosis base branch is invalid");
  }
  const title = selfDiagnosisTitle(input.kind);
  const body = input.body.replace(/\r/g, "").slice(0, 2_000);
  if (!body.includes("<!-- bb-self-diagnosis -->")) throw new TypeError("self-diagnosis PR body marker is missing");
  const script = [
    "set -euo pipefail",
    `base=${shellSingleQuote(input.baseBranch)}`,
    `title=${shellSingleQuote(title)}`,
    `body=${shellSingleQuote(body)}`,
    'branch="$(git branch --show-current)"',
    'if [ -z "$branch" ]; then printf \'%s\\n\' "NO_NAMED_BRANCH"; exit 3; fi',
    'if [ "$branch" = "$base" ]; then printf \'%s\\n\' "BASE_BRANCH"; exit 3; fi',
    'case "$branch" in main|master|trunk) printf \'%s\\n\' "PROTECTED_BRANCH"; exit 3;; esac',
    'if ! remote_branch_ref="$(git ls-remote origin "refs/heads/$branch")"; then',
    '  printf \'%s\\n\' "BRANCH_CHECK_FAILED"',
    '  exit 5',
    'fi',
    'if [ -n "$remote_branch_ref" ]; then',
    '  printf \'%s\\n\' "BRANCH_ALREADY_EXISTS"',
    '  exit 3',
    'fi',
    'git add -A',
    'if git diff --cached --quiet; then',
    '  printf \'%s\\n\' "NO_UNIQUE_CHANGES"',
    '  exit 2',
    'fi',
    'git commit -m "fix: address self-diagnosed controller failure"',
    'git fetch --no-tags origin "$base"',
    'if ! git merge-base --is-ancestor "origin/$base" HEAD; then',
    '  printf \'%s\\n\' "BASE_NOT_ANCESTOR"',
    '  exit 4',
    'fi',
    'git push -u origin HEAD',
    'gh pr create --draft --base "$base" --title "$title" --body "$body" >/dev/null',
    'gh pr view --json number,url,isDraft,headRefName',
  ].join("\n");
  return `bash -lc ${shellSingleQuote(script)}`;
}

export async function publishSelfDiagnosisPullRequest(input: {
  runner: PublishCommandRunner;
  baseBranch: string;
  candidate: SelfDiagnosisCandidate;
  diagnosisId: string;
  diagnosis: StructuredSelfDiagnosis;
  environmentId: string;
  environmentStatus: unknown;
  signal?: AbortSignal;
}): Promise<SelfDiagnosisPullRequestResult> {
  const branch = environmentBranchName(input.environmentStatus);
  if (!branch) return { outcome: "missing", reason: "Self-diagnosis checkout has no named branch" };
  if (PROTECTED_BRANCHES.has(branch)) return { outcome: "missing", reason: "Self-diagnosis checkout is on a protected branch" };
  let command: string;
  try {
    command = buildSelfDiagnosisPullRequestCommand({
      baseBranch: input.baseBranch,
      kind: input.candidate.kind,
      body: buildSelfDiagnosisPullRequestBody({
        diagnosisId: input.diagnosisId,
        candidate: input.candidate,
        diagnosis: input.diagnosis,
      }),
    });
  } catch {
    return { outcome: "missing", reason: "Self-diagnosis pull-request data was not safe to publish" };
  }
  let result: CommandResult;
  try {
    result = await input.runner.run({
      scope: { kind: "environment", environmentId: input.environmentId },
      title: "Publish self-diagnosis draft",
      command,
      timeoutMs: 180_000,
      signal: input.signal,
    });
  } catch {
    return { outcome: "missing", reason: "Self-diagnosis publish command failed" };
  }
  if (result.outcome === "timed_out") return { outcome: "missing", reason: "Self-diagnosis publish timed out" };
  if (result.outcome === "aborted") return { outcome: "missing", reason: "Self-diagnosis publish was aborted" };
  if (result.exitCode === 2 && result.output.includes("NO_UNIQUE_CHANGES")) {
    return { outcome: "missing", reason: "Self-diagnosis worker left no changes" };
  }
  if (result.exitCode === 3 && result.output.includes("PROTECTED_BRANCH")) {
    return { outcome: "missing", reason: "Self-diagnosis refused a protected branch" };
  }
  const published = parseDraftSelfDiagnosisPullRequest(result.output);
  return result.exitCode === 0 && published
    ? { outcome: "published", ...published }
    : { outcome: "missing", reason: "Self-diagnosis draft pull request was not created" };
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
