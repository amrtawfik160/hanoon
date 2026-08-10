# Operations

Telegram Agent keeps controller turns, memories, monitors, tool receipts, jobs, effects, approvals, worker liveness, and Telegram delivery state in its plugin database. Operational decisions should come from those durable records and BB's live thread/environment state—not from elapsed time or a missing process alone.

## Health

Send `/health` in the paired chat. It is answered from durable state rather than by the agent, so it still reports when the agent itself is the stuck part:

```text
/health
```

A healthy reply confirms the executor is running and reports queued job steps, waiting messages, armed monitors, and stored memories. An unhealthy reply names each problem: an executor lease that is not current, job steps that gave up, messages that could not be delivered, failed Telegram updates, failed monitors, unavailable memory search, or a database integrity fault.

From a shell:

```bash
bb plugin list --json
bb telegram-agent doctor
bb telegram-agent doctor <project-id>
bb plugin logs telegram-agent -n 50
```

A healthy loaded plugin reports `running` with both `telegram-ingress` and `job-executor` services running. The global doctor requires a configured token and paired owner. The project doctor reports every failing prerequisite and returns a non-zero exit code if the project is not ready.

Use `--json` on Telegram Agent commands when another tool must consume the result.

## Memory and monitors

Both are owner-facing in the chat rather than through the CLI:

- ask what it remembers, or tell it something is wrong and to forget it;
- ask what it is watching, or to stop watching something.

Memories are bounded per scope; when the bound is reached the weakest is dropped, so recall stays useful rather than unbounded. Credential-shaped text is refused at the write, so a pasted token never enters memory or the search index.

An invalid cron expression is rejected when the monitor is created. A schedule that later cannot be advanced is marked failed and reported by `/health` rather than retried forever.

## Thread notices

Notices about top-level threads are automatic; nothing needs arming. The plugin records each thread the first time it sees it and reports later moves into `idle` or `error`, so a freshly installed or restarted plugin does not replay a backlog.

If a thread seems stuck and you were told nothing, check that it is top-level — a sub-agent's thread is reported to its parent, not to you — and that it is `visible`. To recover a controller thread that has wedged, `bb thread archive <id>`: the plugin reads the archived thread as missing and opens a fresh session on its own, which is safer than editing the database.

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
