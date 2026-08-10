# Telegram Agent BB plugin

Telegram Agent lets one paired private Telegram owner start reviewed implementation jobs in BB projects. The plugin keeps task state and effects in durable BB plugin storage, creates visible managed-worktree implementation threads, reuses that environment for visible spawned review children, and gates merge through fresh validation and one-use approval.

## Prerequisites

- BB 0.36 or newer.
- GitHub CLI (`gh`) authenticated on every host that owns an enabled project source.
- A standard BB project backed by a GitHub repository, with a reachable local or cloned source and a named base branch.
- A Telegram bot created through [BotFather](https://core.telegram.org/bots#botfather).

Installation is full-trust code: review the plugin source and the BB project policies before installing it. The plugin can start agent threads and request a BB-managed pull-request merge. GitHub branch protection and repository rules still apply to the merge.

## Install and build

From this repository:

```bash
npm install
npm run check
bb plugin install . --yes
```

The check runs TypeScript validation, the full Vitest suite, and the BB plugin build. The local install registers the plugin id `telegram-agent`.

## Configure the bot and pair the owner

Enter the bot token only in **Extensions → Plugins → Telegram Agent**. The setting is secret-backed. Do not put the token in a shell command, policy file, README, issue, log, or chat message.

After the token is configured, create a one-use pairing link:

```bash
bb telegram-agent pair
```

Open the returned link from the owner’s Telegram account and complete pairing in the bot’s private chat. Pairing accepts only a private human chat and binds one Telegram user/chat identity. The link is sensitive and expires after ten minutes; do not copy it into logs or tickets.

Useful configuration checks:

```bash
bb telegram-agent doctor
bb telegram-agent doctor <project-id>
```

The project form checks token presence, owner pairing, the standard Git project/source, default execution options, required providers, source-host connectivity, `gh auth status`, repository access, and merge-SDK availability.

## Enable a project

`project enable` stores an immutable policy snapshot after BB verifies the live project, canonical GitHub remote, source, and base branch. Use either `--policy-json`, an absolute `--policy-file`, or the individual policy flags; do not mix input modes.

Example policy shape (replace placeholders with the project’s approved values):

```json
{
  "projectId": "proj_example",
  "alias": "example",
  "enabled": true,
  "githubRepository": "OWNER/REPOSITORY",
  "baseBranch": "main",
  "implementation": {
    "providerId": "PROVIDER_ID",
    "model": "IMPLEMENTATION_MODEL",
    "reasoningLevel": "high",
    "serviceTier": "default",
    "permissionMode": "auto"
  },
  "review": {
    "providerId": "PROVIDER_ID",
    "model": "REVIEW_MODEL",
    "reasoningLevel": "medium",
    "serviceTier": "default",
    "permissionMode": "auto"
  },
  "validationCommands": [
    { "name": "unit", "command": "npm test", "timeoutMs": 600000 }
  ],
  "requiredChecks": ["unit"],
  "outputRedactionPatterns": [],
  "workerLivenessWatchdogMs": 300000,
  "maxReviewCycles": 3,
  "mergeMethod": "squash"
}
```

The profiles accept optional `providerId`, `model`, `reasoningLevel`, `serviceTier`, and `permissionMode`. `validationCommands` are owner-authored commands with a name, command, and timeout in milliseconds. `requiredChecks` are the required GitHub check names. Redaction patterns are regular expressions applied to persisted command/output evidence. The project alias is lowercase, starts with a letter or number, and is at most 24 characters.

```bash
bb telegram-agent project enable <project-id> --policy-json '<policy-json>'
bb telegram-agent project list
bb telegram-agent project disable <project-id>
```

For a policy file on a project host, use an absolute host path and, when needed, `--host <host-id>`:

```bash
bb telegram-agent project enable <project-id> --policy-file /absolute/path/to/policy.json --host <host-id>
```

## Telegram task flow

1. The paired owner sends a task in the private chat.
2. Telegram Agent shows enabled projects; select one and then confirm Start. A task never skips the project or confirmation step.
3. BB creates one visible implementation thread in a managed worktree and uploads an immutable work-order attachment. The implementation prompt is intentionally small and points to that attachment.
4. When the implementation thread is idle, BB locates the pull request and resolves its full head SHA with Git-native `git ls-remote` evidence.
5. A visible review child is spawned in the exact implementation environment. It receives an immutable review-packet attachment and returns a strict JSON verdict.
6. A changes-requested verdict sends bounded remediation to the original implementation thread. A new implementation head causes a fresh review child; a pass proceeds to deterministic validation.
7. Validation checks the clean environment, origin repository, exact pull-request head, configured commands, GitHub metadata, required checks, and a second Git-native pull-request head read.
8. A fresh gate produces a one-use, expiring Merge approval. The merge executor re-checks the exact receipt immediately before the BB merge SDK call. Stale or unknown evidence fails closed and requires fresh review/validation.
9. Completion is durable before Telegram delivery. A failed Telegram send is retried after restart without issuing a second merge.

Status messages expose the current job state, review findings, validation evidence, pull request identity, worker liveness, and approval expiry without storing the raw merge callback nonce.

## Operations and recovery

```bash
bb telegram-agent job list
bb telegram-agent job show <job-id>
bb telegram-agent job retry <job-id>
bb telegram-agent job cancel <job-id>
bb telegram-agent unpair
bb plugin logs telegram-agent -n 50
```

- `job retry` is for a failed job and resumes its durable resume state.
- `job cancel` requests safe worker cancellation; it does not delete the worktree or artifacts.
- Review-limit blocks expose a Telegram **Re-run Review** action. Continue starts another bounded review window; stopping leaves the job blocked.
- Rotate the bot token in **Extensions → Plugins → Telegram Agent**. The polling service recreates its Telegram client for the new token while retaining the stored bot identity. Never use a command-line token setter.
- `unpair` revokes the owner, pairing codes, and outstanding approvals. Pair again only after the owner intentionally reconfigures access.
- Restarting BB or the plugin services resumes durable effects, outbox delivery, and worker reconciliation. It does not create speculative replacement workers when BB liveness is stale or unknown.
- Remove the plugin from **Extensions → Plugins** after stopping active work. Uninstalling does not replace GitHub protection or erase project-side work; inspect the job and worktree before removal.

## Safety boundaries

- There is one paired private-chat owner and one active job.
- The executor has one generation-fenced owner. A second executor instance cannot mutate leased effects or issue a duplicate merge.
- Telegram ingress only records intent and queues effects; it does not touch a worktree.
- Implementation work happens in a visible managed-worktree thread. Reviewers are visible spawned children, never provider-session forks, and reuse the implementation environment.
- Work orders and review packets are immutable BB project attachments. Handoffs record their attachment paths and SHA-256 digests.
- Exact full-SHA binding comes from `git ls-remote`, not from stale or authoritative-looking `gh` head metadata.
- Worker liveness is BB-owned. Stale or unknown state is visible and fail-closed; it does not authorize a speculative restart.
- The plugin never treats an HTTP success, a stale provider response, or a prose review as merge proof. Merge requires fresh structured review, deterministic validation, GitHub checks, a one-use owner approval, and post-merge confirmation.

For disposable live testing, use [docs/acceptance-test.md](docs/acceptance-test.md). Do not use a production application repository.
