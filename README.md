# Telegram Agent BB plugin

Telegram Agent gives one paired private Telegram owner a durable Luna Max conversation for controlling reviewed BB delivery jobs. Ordinary messages go to one hidden BB controller thread. Guarded controller tools commit job intent to durable plugin storage; the single leased executor runs fresh-context planning, critique, implementation, review, documentation, validation, merge, deployment, and canary stages around one managed worktree.

## Prerequisites

- BB 0.36 or newer.
- GitHub CLI (`gh`) authenticated on every host that owns an enabled project source.
- A standard BB project backed by a GitHub repository, with a reachable local or cloned source and a named base branch.
- A source host for BB's personal project, or exactly one connected BB host when that project has no source binding. The hidden controller runs there in a personal workspace and never receives an implementation worktree.
- Codex access to `gpt-5.6-luna` with the `max` reasoning level.
- A Telegram bot created through [BotFather](https://core.telegram.org/bots#botfather).

Installation is full-trust code: review the plugin source and every BB project policy before installing it. The plugin can start agent threads, run owner-authored commands, request a BB-managed pull-request merge, deploy production, and verify a canary. GitHub branch protection and repository rules still apply to the merge.

## Install and build

From this repository:

```bash
npm install
npm run check
bb plugin install . --yes
bb plugin enable telegram-agent
bb plugin reload telegram-agent
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
  "production": {
    "deployCommands": [
      { "name": "deploy", "command": "./scripts/deploy-production.sh", "timeoutMs": 1800000 }
    ],
    "canaryCommands": [
      { "name": "health", "command": "./scripts/verify-production.sh", "timeoutMs": 300000 }
    ],
    "rollbackCommand": {
      "name": "rollback",
      "command": "./scripts/rollback-production.sh",
      "timeoutMs": 600000
    },
    "convexDeployRequired": false
  },
  "requiredChecks": ["unit"],
  "outputRedactionPatterns": [],
  "workerLivenessWatchdogMs": 300000,
  "maxReviewCycles": 3,
  "mergeMethod": "squash"
}
```

The profiles accept optional `providerId`, `model`, `reasoningLevel`, `serviceTier`, and `permissionMode`. Validation, deploy, canary, and rollback entries are owner-authored commands with a name, command, and timeout in milliseconds. Deploy and canary must both be configured before the plugin will issue merge approval. After merge, the managed job worktree is detached at the exact merge commit fetched from the base branch; each production stage verifies that checkout before running its configured commands sequentially. Commands should be safe to reconcile after interruption. A rollback command is operator guidance only: the plugin records it but never runs it automatically. Set `convexDeployRequired` to `true` for a Convex project; the policy is then rejected unless deployment explicitly invokes `convex deploy` through the Convex CLI. `requiredChecks` are the required GitHub check names. Redaction patterns are regular expressions applied to persisted command/output evidence. The project alias is lowercase, starts with a letter or number, and is at most 24 characters.

```bash
bb telegram-agent project enable <project-id> --policy-json '<policy-json>'
bb telegram-agent project list
bb telegram-agent project disable <project-id>
```

Individual policy mode also accepts repeatable `--deploy-json` and `--canary-json` entries, one `--rollback-json` entry, and `--convex-deploy-required`:

```bash
bb telegram-agent project enable <project-id> \
  --alias example --base main --merge-method squash \
  --deploy-json '{"name":"deploy","command":"./scripts/deploy-production.sh","timeoutMs":1800000}' \
  --canary-json '{"name":"health","command":"./scripts/verify-production.sh","timeoutMs":300000}'
```

For a policy file on a project host, use an absolute host path and, when needed, `--host <host-id>`:

```bash
bb telegram-agent project enable <project-id> --policy-file /absolute/path/to/policy.json --host <host-id>
```

## Telegram conversation and task flow

1. The paired owner sends a normal message in the private chat. Telegram ingress durably queues it and nudges the leased executor; ingress never starts a BB session itself.
2. The executor creates or resumes one hidden controller thread in BB's personal workspace with provider `codex`, model `gpt-5.6-luna`, reasoning `max`, and permission mode `auto`. Later messages stay FIFO and use `mode: start` only when that thread is idle.
3. Luna answers ordinary questions conversationally. For software work it uses the registered tools to list enabled projects, ask which project is intended when needed, and atomically create a guarded confirmed job. The tools only write durable intent; they cannot spawn, merge, or touch a worktree.
4. A fresh Luna Max planner creates one visible managed-worktree thread and writes a bounded plan artifact. A separate fresh Luna Max critic receives that artifact; it may request one fresh planning revision but cannot implement.
5. The executor creates the implementation thread in that same environment and gives it only the immutable work order and accepted plan attachments.
6. When implementation is idle, BB locates the pull request and resolves its full head SHA with Git-native `git ls-remote` evidence.
7. Deterministic tests run before a visible review child is spawned in the exact implementation environment. The reviewer has a fresh provider conversation, receives an immutable review packet, and returns a strict JSON verdict without editing the worktree.
8. A changes-requested verdict sends bounded remediation to the implementation thread. A new head causes another test and fresh review cycle.
9. After review passes, a fresh Luna Max documentation thread uses Docs Guard and BB CLI instructions, updates only necessary docs, commits and pushes, and reports a bounded artifact. Final validation then runs before a separate fresh final review.
10. The final gate produces a one-use, expiring Telegram **Merge + deploy &lt;SHA&gt;** approval only when deployment and canary are configured. The merge executor re-checks the exact receipt immediately before the BB merge SDK call. Stale or unknown evidence fails closed and requires fresh review and validation.
11. After GitHub reports the merge, Git fetches the base branch, requires its head to equal GitHub's merge commit, verifies that every path changed by the approved head has the approved Git object, and detaches the managed worktree at that exact commit. Deploy and canary each re-check the checkout before their configured commands run. Merge, deploy, and canary each have a separate durable receipt. Only canary success reaches `complete`. A post-merge failure reaches `production_failed`, preserves the successful merge fact, alerts the owner, and never attempts automatic rollback.
12. While a controller turn or authoritative plan, critique, implementation, review, documentation, validation, deploy, or canary worker is active, the leased executor refreshes Telegram's native `typing...` action every four seconds. This signal is best-effort and ephemeral; it is never written to the durable outbox and cannot fail the job.
13. Job and controller replies are durable before Telegram delivery. A failed Telegram send is retried after restart without issuing a second merge, deployment, or canary.

One status message is durably edited at job milestones and exposes the current job state, review findings, validation evidence, pull request identity, merge fact, deployment/canary outcome, worker liveness, and approval expiry without storing the raw merge callback nonce. Luna controller replies are live-edited from bounded output deltas; background job agents report through durable milestone status rather than forwarding private provider transcripts.

Natural messages continue going to Luna while a job runs. Reply to the exact current status message to steer its implementation thread. `/status`, `/projects`, `/retry`, `/cancel`, and merge buttons remain deterministic recovery paths and do not become controller turns.

## Operations and recovery

```bash
bb telegram-agent job list
bb telegram-agent job show <job-id>
bb telegram-agent job retry <job-id>
bb telegram-agent job cancel <job-id>
bb telegram-agent unpair
bb plugin reload telegram-agent
bb plugin list --json
bb plugin logs telegram-agent -n 50
```

- `job retry` is for a failed job and resumes its durable resume state.
- `job cancel` requests safe worker cancellation; it does not delete the worktree or artifacts.
- Review-limit blocks expose a Telegram **Re-run Review** action. Continue starts another bounded review window; stopping leaves the job blocked.
- Rotate the bot token in **Extensions → Plugins → Telegram Agent**. The polling service recreates its Telegram client for the new token while retaining the stored bot identity. Never use a command-line token setter.
- `unpair` revokes the owner, pairing codes, and outstanding approvals. Pair again only after the owner intentionally reconfigures access.
- Restarting BB or the plugin services resumes durable effects, outbox delivery, and worker reconciliation. It does not create speculative replacement workers when BB liveness is stale or unknown.
- `production_failed` means the pull request is already merged. Inspect the redacted `DEPLOY` or `CANARY` receipt and use the approved operator procedure. The plugin does not automatically retry deployment or run the configured rollback command.
- Native typing presence resumes from durable controller/job state after executor failover and expires naturally when work stops. Presence delivery failures are logged and isolated from durable work.
- A Telegram `message is not modified` response is treated as success. Expired callback answers complete without replay; an uneditable status is replaced with a new durable message id; malformed HTML is retried once without `parse_mode`; permanent Telegram 4xx responses are dead-lettered; and 429/5xx responses retain bounded retry behavior.
- If a controller send outcome is uncertain after executor loss, that turn fails closed and asks the owner to resend. Revoking and re-pairing starts a fresh controller conversation instead of reviving the old mapping.
- Remove the plugin from **Extensions → Plugins** after stopping active work. Uninstalling does not replace GitHub protection or erase project-side work; inspect the job and worktree before removal.

## Safety boundaries

- There is one paired private-chat owner and one active job.
- The executor has one generation-fenced owner. A second executor instance cannot mutate leased effects or issue a duplicate merge.
- Telegram ingress only records intent and nudges the executor; it never touches a worktree or calls BB thread APIs.
- The leased executor is the only execution engine. It owns controller spawn/send, job effects, Telegram outbox delivery, native typing presence, and its authoritative lease heartbeat. Ingress and BB lifecycle handlers never own presence timers.
- The Luna controller has durable BB thread identity, provider conversation/history/status/interactions, explicit execution settings and permissions, hidden visibility, plugin origin, and owner-bound tool authorization. It uses a personal workspace and has no implementation files.
- Implementation work happens in a visible managed-worktree thread. Reviewers are visible spawned children, never provider-session forks, and reuse the implementation environment.
- BB threads do not replace worktrees. Threads isolate provider conversations, durable histories, statuses, interactions, permissions, visibility, and parent-child coordination. Managed worktrees remain the branch, checkout, uncommitted-file, artifact, and filesystem-mutation boundary; threads that reuse one environment see the same files.
- Work orders and review packets are immutable BB project attachments. Handoffs record their attachment paths and SHA-256 digests.
- Exact full-SHA binding comes from `git ls-remote`, not from stale or authoritative-looking `gh` head metadata. After merge, a Git-native base fetch and object comparison verifies the approved content before deployment.
- Worker liveness is BB-owned. Stale or unknown state is visible and fail-closed; it does not authorize a speculative restart.
- The plugin never treats an HTTP success, a stale provider response, or a prose review as merge proof. Merge requires fresh structured review, deterministic validation, GitHub checks, a one-use owner approval, and post-merge confirmation. Completion additionally requires configured deployment and canary receipts.

For disposable live testing, use [docs/acceptance-test.md](docs/acceptance-test.md). Do not use a production application repository.
