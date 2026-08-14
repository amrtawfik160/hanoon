# Operations

Telegram Agent keeps controller turns, memories, monitors, tool receipts, jobs, effects, approvals, worker liveness, and Telegram delivery state in its plugin database. Operational decisions should come from those durable records and BB's live thread/environment state—not from elapsed time or a missing process alone.

## Health

Send `/health` in the paired chat. It is answered from durable state rather than by the agent, so it still reports when the agent itself is the stuck part:

```text
/health
```

A healthy `/health` reply confirms the executor is running and summarizes queued job steps, waiting messages, armed monitors, and stored memories. The durable health report used by controller health inspection additionally separates the configured cap, admitted, draining and queued counts, occupied slots, available slots, pipeline/control lane use, oldest queue age, and held project/repository/production resource counts. An invalid cap is reported as a configuration problem rather than replaced with the default. An unhealthy reply also names executor, dead-letter, Telegram, monitor, memory-search, and database-integrity problems.

From a shell:

```bash
bb plugin list --json
bb telegram-agent doctor
bb telegram-agent doctor proj_7f3d2a91
bb plugin logs telegram-agent -n 50
```

A healthy loaded plugin reports `running` with both `telegram-ingress` and `job-executor` services running. The global doctor requires a configured token and paired owner. The project doctor reports every failing prerequisite and returns a non-zero exit code if the project is not ready.

Use `--json` on Telegram Agent commands when another tool must consume the result.

## Verify the bundled skill runtime

Skills are committed locally under the five manifest roots `skills/workflow-kit`, `skills/guards`, `skills/delivery`, `skills/discovery`, and `skills/hanoon`; operators do not install another runtime skill plugin. The catalog has 23 locked local skills, but the resolver selects only the exact verified role profile described in [Architecture](architecture.md). A provider session is not evidence that a role received a skill: the later live-acceptance slice must record the real thread and provider outcome separately.

Run the deterministic integrity gate from the repository root:

```bash
npm run skills:verify
```

The command checks the manifest roots and lock, file sizes/counts and regular-file type, complete SHA-256 coverage, frontmatter and directory names, nested local Markdown resources, and the pinned provenance and licence of every vendored root. Success prints a bounded `bundleDigest` and `skillCount`; a malformed lock, missing or unlocked file, escaped path, symlink, oversized entry, frontmatter/resource mismatch, or digest mismatch exits non-zero. `npm run build` invokes this verifier before `bb plugin build`, and activation invokes it before plugin registration. Treat any failure as a stop: the runtime never downloads, substitutes, or repairs a bundle.

Only a maintainer may synchronize the pinned upstream workflow kit. Use an already-reviewed local absolute checkout of the `superpowers` package with version `6.3.0`, `LICENSE`, `skills/`, and the reviewed MIT license; the synchronizer is network-free and has no runtime role:

```bash
WORKFLOW_KIT_SOURCE=/absolute/path/to/superpowers-6.3.0
npm run skills:sync -- --source "$WORKFLOW_KIT_SOURCE" --version 6.3.0
```

Synchronization rewrites the local `skills/workflow-kit` files and `skills/skills.lock.json`. Re-run `npm run skills:verify` and review the resulting diff before any plugin reload. Do not use synchronization as an activation-time repair mechanism.

## Memory and monitors

Both are owner-facing in the chat rather than through the CLI:

- ask what it remembers, or tell it something is wrong and to forget it;
- ask what it is watching, or to stop watching something.

Memories are bounded per scope; when the bound is reached the weakest is dropped, so recall stays useful rather than unbounded. Credential-shaped text is refused at the write, so a pasted token never enters memory or the search index.

An invalid cron expression is rejected when the monitor is created. A schedule that later cannot be advanced is marked failed and reported by `/health` rather than retried forever.

Watches are not all owner-requested: a thread the agent starts or messages is watched automatically, so asking what it is watching will list those too. They retire themselves when their thread lands. Armed monitors are capped per controller, and at the cap an automatic watch is declined rather than arming — the thread still runs, but nothing wakes the agent when it finishes. The armed count in `/health` is the one to watch; the next-due time beside it covers schedules only, since a thread watch waits on its thread rather than on the clock.

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

`job list` returns at most 100 recent jobs; `--limit` accepts `1`–`100`. `job show` returns the bounded stored projection for exactly one job. Its safe projection includes admission state, queue sequence/age/release reason, held resource kind/key pairs, and merge-resource waits, but not raw prompts, secrets, claim owners, lease generations, or unbounded provider logs.

In Telegram, the durable status message reports the current state, review/validation summaries, pull-request identity, liveness, approval expiry, and production outcome. On completion, a separate two-sentence finish note says what passed or shipped and includes the pull-request link. BB does not expose a reliable completion ETA, so the controller reports observed progress instead of inventing one.

`/status` without an id lists up to eight current jobs and reports when more exist. `/status <job-id>`, `/cancel <job-id>`, and `/retry <job-id>` target that exact job. Replying to a job status message is another exact selector. If cancel or retry has neither an id nor a status reply, one eligible job is selected only when unambiguous; otherwise Telegram returns bounded choices. A clear free-text correction or added constraint can be steered into the one admitted implementation job; ambiguous cases return bounded choices. A request to start distinct work in a project that already has an open job is refused unless the owner explicitly marks it as separate work.

To finish work that already has a pull request, tell the controller which enabled project and PR number to adopt. Adoption accepts only an open, non-draft PR whose repository, base branch, canonical URL, and exact remote head match policy. It checks out a deterministic local branch, records planning and critique as skipped, and runs the full validation and review gates; it never creates a replacement PR.

## Capability routing and rollout

New jobs use one of six recipes: `direct`, `bounded`, `bug`, `skill-authoring`, `adopted-pr`, or `architectural`. With the default adaptive job graph, an unpromoted recipe stays in `shadow`: the plugin records its candidate classification and profile, but the candidate graph cannot control delivery or create production success evidence.

Inspect all recipe decisions or one recipe:

```bash
bb telegram-agent capability status
bb telegram-agent capability status direct --json
```

`incomplete` means at least one required proof is absent or cannot be resolved. `failed` means a durable result exists and violates a gate, such as an imperfect safety classifier, a non-zero safety counter, or candidate model results below the baseline. Neither state can write a promotion decision.

Promotion evidence is not accepted as command-line values. The production reader uses the newest append-only manifest for that recipe and resolves every reference against stored records. It requires all eight deterministic categories, a perfect fixed-corpus classifier result, at least one active post-merge run, distinct induced-failure and recovery receipts backed by terminal model trials for that job, at least five candidate and five baseline trials under the same harness and budget, and all five zero-tolerance safety snapshots. Missing, malformed, duplicate, cross-recipe, non-causal, or mismatched references make the manifest incomplete; the reader never falls back to an older valid manifest. A future trusted collector must additionally establish that the live acceptance job is disposable before writing the ledger.

This release does not expose a production collector or evidence-ingestion command. Ordinary operator commands can inspect or consume a future trusted ledger but cannot manufacture one from typed pass/fail or safety assertions. The remaining collector seam is explicitly incomplete, so a fresh installation has no completed live bundle and every adaptive recipe starts in `shadow`.

After a later trusted collector derives and stores that evidence, promotion follows the fixed order shown by `capability status`:

```bash
bb telegram-agent capability promote direct --json
bb telegram-agent capability rollback direct --json
```

Promotion affects only newly created matching jobs. Rollback returns only later matching jobs to `shadow`; it does not mutate the routing mode, model tuple, profile, or receipts of a job already in flight. The independent **Capability job graph** setting can force later jobs onto `legacy` without deleting capability data.

For a known profile id, inspect its bounded selection and outcome receipts:

```bash
bb telegram-agent capability receipts <profile-id> --limit 50 --json
```

The current controller can disclose its own profile id through its read-only capability detail tool. The receipt command returns ids, descriptor-bound capability names, reason codes, terminal outcomes, and evidence counts; it excludes prompts, private reasoning, credentials, filesystem paths, and raw provider output.

External discovery is read-only and never grants authority. Use the enabled project's scope to inspect its last snapshot and health:

```bash
bb telegram-agent capability inventory --host project:<project-id> --limit 50 --json
```

A degraded refresh preserves the previous snapshot. Discovered entries remain `inventory-only` until a separately reviewed descriptor and adapter admission path exists.

## Admissions and concurrency

The executor may run independent projects concurrently up to **Maximum concurrent jobs** (`5` by default, `1`–`8` allowed). One project claim permits only one admitted pipeline for a project, so same-project jobs remain FIFO even when spare global slots exist.

- `queued`: waiting for capacity or the project claim;
- `admitted`: occupies a slot and may run ordinary pipeline work;
- `draining`: terminal transition is recorded, but worker/effect cleanup still owns the slot;
- `released`: cleanup finished and its claims no longer block later work.

At merge time, the job must also own the normalized repository merge claim and, for production policies, the production target claim. Different projects with the same repository therefore cannot merge concurrently. Different repositories can share `production.targetKey` to serialize one deployment target; without it, the target key falls back to the project id. These waits appear in the safe CLI job projection.

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

Cancellation revokes approvals and asks every authoritative active worker to stop. During a two-lens review, both reviewer identities are carried in one bounded stop effect, and the job is not marked cancelled until every lens has settled. Cancellation does not delete the worktree or project attachments.

## Rotate the bot token

Change **Telegram bot token** only in **Extensions → Plugins → Telegram Agent**. The background service recreates its Telegram client for the new token. Do not set or pass the token through a command line.

The plugin binds the observed Telegram bot identity. Changing to a different bot while any queued, admitted, or draining admission exists fails closed. Rotate credentials during an idle window and run:

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

The plugin resumes from durable controller/job/effect/outbox state. The executor reacquires its generation-fenced lease and reconciles each occupied job before adopting that job's held claims into the new generation. After adoption it rechecks active workers every ten seconds, in addition to event-driven reconciliation. It never adopts foreign claims.

Important recovery behavior:

- An uncertain controller send fails closed and asks the owner to resend; it is not submitted twice.
- A failed controller thread is retired before a later queued turn starts a new generation.
- A worker that never starts, disappears, or remains silent beyond policy is classified from durable liveness, retired, and requeued at the same stage only when that failure signature has recovered before. The first occurrence and any novel signature stop for owner action. A failed review group retires its sibling lens too, so old verdicts cannot leak into the replacement group.
- Telegram draft/presence failures do not change durable BB job state.
- A Telegram `message is not modified` response is accepted as success.
- An uneditable status message is replaced and the new message id is stored.
- Permanent Telegram 4xx responses are dead-lettered; retryable 429/5xx failures use bounded retry accounting.
- Restart recovery does not issue a second merge, deploy, or canary for a completed receipt.
- A merge call with an unknown provider outcome keeps its repository and production claims held until authoritative reconciliation; capacity is not guessed free.
- A project paused by the failure brake admits no new jobs until `/resume`; in-flight work finishes and queued jobs stay queued.
- Every merge still requires current review/validation evidence and a Telegram approval, regardless of available capacity: the exact unexpired one-use approval, or a standing approval the owner granted that project.

## Production failures

`production_failed` means the pull request was already merged and either deployment or canary failed. The merge fact remains durable. Inspect the job and redacted command receipt before following the operator-approved recovery or rollback procedure:

```bash
bb telegram-agent job show <job-id> --json
bb plugin logs telegram-agent -n 50
```

The plugin does not automatically retry production. It does run the policy's `rollbackCommand` when one is configured, immediately after the failing deploy or canary command and before reporting the failure; the receipt is on the stage evidence. If no rollback was configured, or the rollback itself failed, any standing merge approval for that project is withdrawn. A job reports `complete` after a successful canary, or earlier when production is not configured and the pull request has passed final review. Small-fix jobs complete only after the pull request passes configured validation and its quality review.

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
