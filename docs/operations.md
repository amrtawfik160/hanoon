# Operations

Telegram Agent keeps controller turns, jobs, effects, approvals, worker liveness, and Telegram delivery state in its plugin database. Operational decisions should come from those durable records and BB's live thread/environment state—not from elapsed time or a missing process alone.

## Health

Check plugin and service state:

```bash
bb plugin list --json
bb telegram-agent doctor
bb telegram-agent doctor <project-id>
bb plugin logs telegram-agent -n 50
```

A healthy loaded plugin reports `running` with both `telegram-ingress` and `job-executor` services running. The global doctor requires a configured token and paired owner. The project doctor reports every failing prerequisite and returns a non-zero exit code if the project is not ready.

Use `--json` on Telegram Agent commands when another tool must consume the result.

## Inspect jobs

```bash
bb telegram-agent job list
bb telegram-agent job list --limit 10 --json
bb telegram-agent job show <job-id>
bb telegram-agent job show <job-id> --json
```

`job list` returns at most 100 recent jobs; `--limit` accepts `1`–`100`. `job show` returns the bounded stored projection for exactly one job. It does not expose raw prompts, secrets, or unbounded provider logs.

In Telegram, the durable status message reports the current state, review/validation summaries, pull-request identity, liveness, approval expiry, and production outcome. BB does not expose a reliable completion ETA, so the controller reports observed progress instead of inventing one.

## Retry or cancel

Retry a job only after it reaches the recoverable `failed` state:

```bash
bb telegram-agent job retry <job-id>
```

Retry resumes the state recorded before failure and re-enqueues the corresponding idempotent effect. It does not reset the job, bypass review, or reuse a stale approval.

Request cancellation with:

```bash
bb telegram-agent job cancel <job-id>
```

Cancellation revokes approvals and asks the authoritative active worker to stop when one exists. The job is not marked cancelled until stop/reconciliation evidence permits the transition. Cancellation does not delete the worktree or project attachments.

## Rotate the bot token

Change **Telegram bot token** only in **Extensions → Plugins → Telegram Agent**. The background service recreates its Telegram client for the new token. Do not set or pass the token through a command line.

The plugin binds the observed Telegram bot identity. Changing to a different bot while a job is active fails closed. Rotate credentials during an idle window and run:

```bash
bb telegram-agent doctor
```

## Unpair

```bash
bb telegram-agent unpair
```

Unpairing revokes the owner mapping, controller access, pending controller operations, and merge approvals. A later pairing creates a fresh controller mapping rather than reviving the previous owner's hidden conversation.

## Restart and recovery

Reload after source changes or to restart both plugin services:

```bash
bb plugin reload telegram-agent
bb plugin list --json
```

The plugin resumes from durable controller/job/effect/outbox state. The executor reacquires its generation-fenced lease and reconciles BB state before continuing. It does not start a speculative replacement when liveness is stale or unknown.

Important recovery behavior:

- An uncertain controller send fails closed and asks the owner to resend; it is not submitted twice.
- A failed controller thread is retired before a later queued turn starts a new generation.
- Telegram draft/presence failures do not change durable BB job state.
- A Telegram `message is not modified` response is accepted as success.
- An uneditable status message is replaced and the new message id is stored.
- Permanent Telegram 4xx responses are dead-lettered; retryable 429/5xx failures use bounded retry accounting.
- Restart recovery does not issue a second merge, deploy, or canary for a completed receipt.

## Production failures

`production_failed` means the pull request was already merged and either deployment or canary failed. The merge fact remains durable. Inspect the job and redacted command receipt before following the operator-approved recovery or rollback procedure:

```bash
bb telegram-agent job show <job-id> --json
bb plugin logs telegram-agent -n 50
```

The plugin does not automatically retry production or run the policy's rollback command. It also does not report `complete` unless canary succeeds.

## Remove the plugin

Before removal:

1. inspect active jobs and worker liveness;
2. cancel or finish active work;
3. inspect the project worktree and pull request;
4. unpair the Telegram owner if the installation will not return.

Then disable and remove it from **Extensions → Plugins**, or use:

```bash
bb plugin disable telegram-agent
bb plugin remove telegram-agent
```

Removing the plugin does not delete GitHub branches, pull requests, managed worktrees, or project-side commits. It also does not replace branch protection or repository rules.

See [Configuration](configuration.md) for policy inputs and [Disposable live acceptance](live-acceptance.md) before testing merge/deploy behavior.
