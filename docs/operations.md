# Operations

Telegram Agent keeps controller turns, memories, monitors, tool receipts, jobs, effects, approvals, worker liveness, and Telegram delivery state in its plugin database. Operational decisions should come from those durable records and BB's live thread/environment state—not from elapsed time or a missing process alone.

## Health

Send `/health` in the paired chat. It is answered from durable state rather than by the agent, so it still reports when the agent itself is the stuck part:

```text
/health
```

A healthy `/health` reply confirms the executor is running and summarizes queued job steps, waiting messages, armed monitors, and stored memories. It also prints `Activation: current` with the registered source root, loaded build fingerprint, load time, and `schema=applied/expected` migration identity. `ACTIVATION MISMATCH` means the process is stale or its database is not at the schema expected by the loaded code; do not treat `running` as success. The durable health report used by controller health inspection additionally separates the configured cap, admitted, draining and queued counts, occupied slots, available slots, pipeline/control lane use, oldest queue age, and held project/repository/production resource counts. An invalid cap is reported as a configuration problem rather than replaced with the default. An unhealthy reply also names executor, dead-letter, Telegram, monitor, memory-search, database-integrity, and activation problems.

From a shell:

```bash
bb plugin list --json
bb telegram-agent doctor
bb telegram-agent doctor proj_7f3d2a91
bb plugin logs telegram-agent -n 50
```

`bb plugin list --json` is only a host lifecycle report: it can say `running` while the loaded source or schema is stale. Use `bb telegram-agent doctor --json` and require the `plugin activation` row to pass; its JSON includes the same source, build, and schema identity. The global doctor requires a configured token and paired owner, and always reports the credential broker section covered below. The project doctor reports every failing prerequisite and returns a non-zero exit code if the project is not ready.

Use `--json` on Telegram Agent commands when another tool must consume the result.

## Autonomy readiness

A project whose enabled policy carries an `autonomy` block gets extra rows from
the project doctor. They are read-only diagnostics; nothing here changes a
policy or a repository setting.

```bash
bb telegram-agent doctor proj_7f3d2a91 --json
```

| Row | `pass` | `warn` | `fail` |
| --- | --- | --- | --- |
| `autonomy: branch protection` | GitHub requires at least one status check on the base branch, and the rules bind administrators | the checks exist but administrators are exempt | no protection or ruleset could be read, or none requires a check |
| `autonomy: required checks` | the policy lists at least one `requiredChecks` entry | none listed | — |
| `autonomy: rollback command` | `production.rollbackCommand` is configured | — | it is missing while `unattendedMerge` is on with a configured production |
| `autonomy: production health checks` | `production.healthCommands` are configured | none configured, so a crash between deploys is not noticed and no automatic revert can start | — |
| `autonomy: regression checks` | a `regression` policy is configured | none configured, so nothing checks the project between jobs | — |

Only the first row leaves the machine. It asks GitHub through `gh` on the
project's source host, exactly as `project enable` did before storing the policy
— see [Configuration](configuration.md#the-check-project-enable-runs-against-github)
— and its summary never carries an API error, a token, or an account name. The
other four read the stored policy and nothing else.

The rollback and health rows appear only for a project whose policy sets
`unattendedMerge` and configures production. The branch-protection row reports
`disabled` for a policy whose `autonomy` block merges nothing — an
`intake`-only project has no merge grant for it to be about — and no GitHub call
is made in that case.

A `warn` row never changes the exit code. Each one is a gap only you can close,
in a repository setting or a policy field, and a doctor that failed on advice
would teach you to ignore the rows that mean the project genuinely cannot work.

## Credential broker

`bb telegram-agent doctor` always includes credential readiness, whether or not the broker foundation is configured:

```bash
bb telegram-agent doctor --json
```

With **Credential broker mode** at its `disabled` default, this prints one `credential broker` row and nothing else attempts to reach a broker. Once isolated mode is configured, it prints `credential: <check>` rows in a fixed order — trust kernel, controller permission, isolated configuration, topology receipt, broker TLS, broker identity, protocol version, installation identity, broker audit, and the 1Password adapter — with only 3 or 4 rows when trust kernel, controller permission, isolated configuration, or a stale topology receipt already fails, and all 10 otherwise. None of these rows ever contain a certificate, endpoint, digest value, vault id, or raw broker error; see [Configuration](configuration.md#credential-broker-foundation) for the full settings shape.

Read-only binding and broker inspection:

```bash
bb telegram-agent access list [--state <state>] [--after <binding-id>] [--limit <1-10>] [--json]
bb telegram-agent access status [binding-id] [--json]
```

Import a protected-host projection into Hanoon (mutates local binding state):

```bash
bb telegram-agent access reconcile <project-id> --projection-json '<secret-free projection JSON>' [--json]
```

`access list` returns only locally stored, secret-free binding metadata and never contacts the broker. `access status` runs the same diagnostic health check as the doctor and, when given a binding id, reports that one binding's state and generation. `access reconcile` is the mutating local projection import: it accepts only a validated, secret-free projection from protected-host `connector binding enroll --stdin`, requires the active controller project/thread and executor lease, writes Hanoon's local projection, and performs no broker call or credential verification. Typed provider identity probes use fixed Convex/Vercel adapters and can only be requested by the owner from Telegram; the governed browser operation is unavailable in the default broker composition. The installed `@1password/sdk` 0.5.0 has no `AbortSignal` for `Secrets.resolveAll` and no public client close/dispose operation, so SDK-backed credential resolution fails closed before starting that operation; injected-port cancellation tests do not close this SDK gap. Current full readiness is required before and after dispatch; timeout, stale authority, mismatch, and ambiguity fail closed. The repository's executable acceptance path uses controlled local vault/TLS fixtures and makes no live-provider claim.

Rotating broker settings follows the same rule as the bot token: change them only in **Extensions → Plugins → Telegram Agent**, never on a command line. Changing the endpoint, installation id, certificates, private key, or topology receipt digest/expiry while already isolated rotates the connection immediately; the next `access status` or doctor call re-attempts the broker health check under the new material. Turning isolated mode on for the first time additionally needs `bb plugin reload telegram-agent` before verification becomes reachable. An endpoint change does not migrate existing bindings.

If the broker client's private key may have leaked, treat it as a compromised credential: revoke the installation on the protected broker host first (see `broker/README.md`), then update the installation id, certificate, key, and topology settings here to a freshly re-enrolled installation before considering isolated mode again. This foundation cannot make credential capabilities usable on its own — it also needs the disposable 1Password account, protected broker host, and reviewed topology probes described in [Disposable live acceptance](live-acceptance.md).

## Verify the bundled skill runtime

Skills are committed locally. The contracted bundle admits exactly 35 reviewed skill ids and no legacy-only Superpowers, discovery, delivery, or router ids. BB registers six immediate roots: the two promoted Matt Pocock buckets plus guards, Hanoon, pstack, and humanlayer. Every registered runtime id has one plugin source.

Run the deterministic integrity gate from the repository root:

```bash
npm run skills:verify
```

The command checks package root order, schema 2 lock structure, the 35-skill catalog with empty legacy and shadow lists, file bounds and regular-file type, complete SHA-256 coverage, frontmatter and directory names, invocation metadata, nested local Markdown resources, and every source license and provenance record. Success prints `bundleDigest`, `admittedSkillCount=35`, and `legacySkillCount=0`. Any malformed lock, leftover workflow or discovery kit, missing or unlocked file, escaped path, symlink, oversized entry, frontmatter mismatch, unsupported id, or digest mismatch exits nonzero. Build and activation run the same verifier before plugin registration.

Only a maintainer may synchronize the promoted portfolio. Use a clean, already-reviewed absolute checkout at the pinned revision:

```bash
MATT_SKILLS_SOURCE=/absolute/path/to/mattpocock-skills
MATT_SKILLS_REVISION=6654f6b60cd9d5be8b54c6fafe44346dabeb3b76
npm run skills:sync -- --source "$MATT_SKILLS_SOURCE" --revision "$MATT_SKILLS_REVISION"
```

The synchronizer verifies the Git head, checkout root, package and plugin metadata, license and manifest digests, exact promoted path list, invocation metadata, cleanliness, and tree bounds. It stages and atomically replaces only `skills/matt-pocock` and `skills/skills.lock.json`. Re-run `npm run skills:verify`, review the diff, and rebuild before reloading the plugin. Synchronization is never an activation-time repair path.

## Memory and monitors

Both are owner-facing in the chat rather than through the CLI:

- ask what it remembers, or tell it something is wrong and to forget it;
- ask what it is watching, or to stop watching something.

Memories are bounded per scope; when the bound is reached the weakest is dropped, so recall stays useful rather than unbounded. Credential-shaped text is refused at the write, so a pasted token never enters memory or the search index.

A schedule is a BB agent automation with a UTC cron, created only from a turn you sent yourself. When BB refuses to host automations for the controller's project, which is the case for BB's personal project, the plugin keeps the schedule itself and fires it as a follow-up turn. An invalid cron expression is rejected before BB is asked. A schedule BB cannot read back exactly is not activated, and one whose project policy is later disabled is paused at the next reconciliation sweep rather than left running.

Asking what the agent is watching lists durable monitor rows and the BB schedules the agent manages. Starting or messaging a thread tries to arm a best-effort courtesy monitor; at the armed-monitor cap the action still succeeds without that monitor. Lifecycle handling can also infer engagement from durable controller evidence containing the exact `thread:<id>` reference and enqueue a follow-up without a monitor row. That inferred follow-up is absent from the watch list and does not consume the armed-monitor cap; thread list and status reads currently produce qualifying evidence too. The armed count in `/health` therefore covers monitors, not every possible lifecycle follow-up. Its next-due time covers schedules only, since a thread watch waits on its thread rather than on the clock.

## Reference documents

Reference documents are filed by the paired owner in Telegram and may govern one project or every project. Worker threads read them through the read-only CLI:

```bash
bb telegram-agent reference list [--project <project-id>] [--json]
bb telegram-agent reference search "<query>" [--project <project-id>] [--limit <1-8>] [--json]
bb telegram-agent reference show <passage-id> [--project <project-id>] [--json]
```

Inside a project-bound BB thread, the invoking project is authoritative: omitting `--project` uses that project, and naming a different one is refused. An unbound operator may name a project explicitly; omitting it reads only global references. `show` applies the same scope check as `search` and `list`, so a passage id is not a scope bypass.

## Thread notices

Notices about top-level threads are automatic; nothing needs arming. The plugin records each thread the first time it sees it and reports later moves into `idle` or `error`, so a freshly installed or restarted plugin does not replay a backlog.

If a thread seems stuck and you were told nothing, check that it is top-level — a sub-agent's thread is reported to its parent, not to you — and that it is `visible`. To recover a controller thread that has wedged, `bb thread archive <id>`: the plugin reads the archived thread as missing and opens a fresh session on its own, which is safer than editing the database.

## Controller attachments and bursts

Messages sent in quick succession are answered as one burst; each answer starts about two seconds after the last message so the whole burst is read together. The fixed caps are 25 messages per burst, 32 KB of rendered transcript, and 10 attachments counting the first message's own file. A burst gets one answer and no separate acknowledgement; only messages folded into an answer already being written draw the one-line "got that" bubble, once per burst.

The controller accepts PDF, Markdown, and plain-text documents as attachments, plus images and clips as before. A document's caption becomes the message text. Per-file limits: images 10 MB, clips and documents 20 MB; Markdown and plain-text files of up to 64,000 characters are also inlined into the answer's input. A file of another type, or over its limit, gets one short reply at intake and is not queued; several such files arriving together, even across a plugin restart, draw that reply once.

## Inspect jobs

```bash
bb telegram-agent job list
bb telegram-agent job list --limit 10 --json
bb telegram-agent job show <job-id>
bb telegram-agent job show <job-id> --json
bb telegram-agent job spend <job-id>
bb telegram-agent job spend <job-id> --json
```

`job spend` lists every stage attempt of one job with the provider, model, reasoning level, service tier, tier and any escalation, tokens, duration, and cost, so tiering can be tuned from observed numbers. Cost reads `unpriced` — a null `costMicroUsd` with `--json` — for models with no published rate entered in the catalog.

`job list` returns at most 100 recent jobs; `--limit` accepts `1`–`100`. `job show` returns the bounded stored projection for exactly one job. Its safe projection includes admission state, queue sequence/age/release reason, held resource kind/key pairs, and merge-resource waits, but not raw prompts, secrets, claim owners, lease generations, or unbounded provider logs.

### Work nobody asked for

A job the project started for itself carries that provenance from creation, and
it is never rewritten. `job show` prints it as `startedBy` on the plain line, and
both commands expose it as `autonomousOrigin` in JSON — one of `audit_intake`,
`self_diagnosis`, or `crash_revert`:

```bash
bb telegram-agent job show <job-id> --json
bb telegram-agent job list --json
```

An automatic revert is a `crash_revert` job, and only a project whose current
enabled policy sets `autonomy.unattendedMerge` starts one. Its work order names
the exact merge commit it is reverting, and one merge commit gets at most one
automatic revert ever, so a second failure on the same commit produces the
ordinary fault report rather than another job. A `crash_revert` job's own merge
is never reverted automatically either, and no earlier merge is reverted in its
place: when the last thing merged is a revert, the fault is reported and nothing
starts. Reverts do not spend the `autonomy.intake` allowance; `audit_intake` and
`self_diagnosis` jobs share it.

These are ordinary jobs in every other respect. `job retry`, `job cancel`, and
the approval rules apply to them exactly as they do to work you asked for.

In Telegram, the durable status message reports the current state, review/validation summaries, pull-request identity, liveness, approval expiry, and production outcome. On completion, a separate two-sentence finish note says what passed or shipped and includes the pull-request link. BB does not expose a reliable completion ETA, so the controller reports observed progress instead of inventing one.

`/status` without an id lists up to eight current jobs and reports when more exist. `/status <job-id>`, `/cancel <job-id>`, and `/retry <job-id>` target that exact job. Replying to a job status message is another exact selector. If cancel or retry has neither an id nor a status reply, one eligible job is selected only when unambiguous; otherwise Telegram returns bounded choices. A clear free-text correction or added constraint can be steered into the one admitted implementation job; ambiguous cases return bounded choices. A request to start distinct work in a project that already has an open job is refused unless the owner explicitly marks it as separate work.

To finish work that already has a pull request, tell the controller which enabled project and PR number to adopt. Adoption accepts only an open, non-draft PR whose repository, base branch, canonical URL, and exact remote head match policy. It checks out a deterministic local branch, records planning and critique as skipped, and runs the full validation and review gates; it never creates a replacement PR.

## Capability routing and rollout

New jobs use one of six recipes: `direct`, `bounded`, `bug`, `skill-authoring`, `adopted-pr`, or `architectural`. With the default adaptive job graph, an unpromoted recipe stays in `shadow`: the plugin records its candidate classification and profile, but the candidate graph cannot control delivery or create production success evidence.

Inspect all recipe decisions, one recipe, or the navigator-v1 engine gate:

```bash
bb telegram-agent capability status
bb telegram-agent capability status direct --json
bb telegram-agent capability status navigator-v1 --json
```

`incomplete` means at least one required proof is absent or cannot be resolved. `failed` means a durable result exists and violates a gate, such as an imperfect safety classifier, a non-zero safety counter, or candidate model results below the baseline. Neither state can write a promotion decision.

Promotion evidence is not accepted as command-line values. The recipe reader uses the newest append-only manifest for that recipe and resolves every reference against stored records. It requires all eight deterministic categories, a perfect fixed-corpus classifier result, at least one active post-merge run, distinct induced-failure and recovery receipts backed by terminal model trials for that job, at least five candidate and five baseline trials under the same harness and budget, and all five zero-tolerance safety snapshots. Missing, malformed, duplicate, cross-recipe, non-causal, or mismatched references make the manifest incomplete; the reader never falls back to an older valid manifest. Recipe promotion still has no trusted collector that can prove a disposable live job and write that ledger.

Navigator-v1 uses a separate append-only ledger. `DualEngineCoordinator.persistEvaluationEvidence` is the trusted collector: it writes deterministic categories from the measured corpus, including restart and safety only when those were actually measured, and it records the required disposable live scenarios only when each job is an executed run rather than a SQL-stamped terminal state. `promote()` then fails closed if restart or safety was not measured. Ordinary operator commands inspect or consume that ledger. They cannot manufacture it from typed pass/fail assertions.

Recipe promotion stays incomplete on a fresh install, so every adaptive recipe starts in `shadow`. After the navigator collector has written a reviewed manifest, engine promotion follows `capability status`:

```bash
bb telegram-agent capability promote direct --json
bb telegram-agent capability rollback direct --json
bb telegram-agent capability promote navigator-v1 --json
bb telegram-agent capability rollback navigator-v1 --json
```

Promotion affects only newly created matching jobs. Recipe rollback returns only later matching jobs to `shadow`. Navigator rollback records the operator decision without changing later admissions, which stay on navigator-v1. Neither mutates the routing mode, model tuple, profile, receipts, or engine of a job already in flight. The independent **Capability job graph** setting can force later jobs onto `legacy` without deleting capability data. The independent **Workflow engine graph** setting is a retired kill switch and is ignored for admission. The leased executor runs the live navigator, implementation, and release workers.

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

## Withdraw autonomy

Nothing here needs a restart or a database edit.

**Stop a project merging without you.** From the paired chat, `/approvals` lists
the projects that merge without asking and says whether each was granted by
button or set in its policy; `/approvals off <alias>` withdraws one and
`/approvals off` withdraws all. A policy-carried grant has no row to clear — this
plugin cannot edit your policy file — so the withdrawal is recorded durably
instead, and stays in force until that project's enabled policy is stored again
by `bb telegram-agent project enable`. `project disable` stores a snapshot too
and deliberately does not count. To withdraw it permanently, remove
`autonomy.unattendedMerge` from the policy file before enabling the project again.
That setting is also what lets the project revert a merge that broke production
and lets the continuation sweep re-enter a merge or production stage, so removing
it stops all three.

**Stop a project starting its own work.** Remove `autonomy.intake` from the
policy and run `project enable` again. A project the failure brake is holding
already starts nothing unattended, so pausing it is the faster stop.

**Stop everything at once.** `bb telegram-agent project disable <project-id>`
takes the project out of the enabled set entirely. Work already running finishes.

The plugin also withdraws a grant by itself when a deploy or canary fails and the
rollback was missing or itself failed. Both grant sources stop and the project's
failure brake trips with no fingerprint, so no new work is admitted there until
you send `/resume <alias>`. That is deliberate: a production that could not be
rolled back is not something the agent may clear for itself. If the project was
already braked for something else, that brake is taken over rather than left as
it was — its reason becomes the incident and its fingerprint is dropped, so
`/resume <alias>` is the only way back either way.

## Unpair

```bash
bb telegram-agent unpair
```

Unpairing revokes the owner mapping, controller access, pending controller operations, and merge approvals. A later pairing creates a fresh controller mapping rather than reviving the previous owner's hidden conversation.

## Restart and recovery

BB reloads the source root recorded in the installed plugin registration. It does not select the checkout that happens to be your current directory, and the plugin cannot change that host behavior. Check the registered source before deploying:

```bash
bb plugin source telegram-agent --json
```

The `resolved` path in that output must be the source root containing the code and migration you deployed. Then reload and verify the activation identity, not just the lifecycle line:

```bash
bb plugin reload telegram-agent
bb plugin list --json
bb telegram-agent doctor --json
```

The plugin resumes from durable controller/job/effect/outbox state. The executor reacquires its generation-fenced lease and reconciles each occupied job before adopting that job's held claims into the new generation. After adoption it rechecks active workers every ten seconds, in addition to event-driven reconciliation. It never adopts foreign claims.

If reload leaves the activation stale, use a full disable/enable cycle. Do not run the two commands back-to-back: wait until the plugin is `disabled` and its services are gone, then keep a pause of at least 12 seconds before enabling it. Wait longer if the host still reports a service or `degraded` state.

```bash
bb plugin disable telegram-agent
bb plugin list --json
# After disabled and with no services remaining, wait at least 12 seconds.
bb plugin enable telegram-agent
bb plugin list --json
bb telegram-agent doctor --json
```

After deploying a migration, require the doctor activation row and `/health` to show matching `schema=applied/expected` values, then verify the migrated table or columns. If inspecting SQLite directly, first copy the live database and open the copy read-only; query `_bb_migrations` and the relevant `PRAGMA table_info(...)`. A `running` status by itself does not prove that the migration or the new code is live.

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
- A project paused by the failure brake admits no new jobs; in-flight work finishes and queued jobs stay queued. The controller may clear a fingerprinted cause once. A repeated cause, an un-fingerprinted pause, or any desired manual override waits for `/resume`.
- Every merge still requires current review/validation evidence and an approval, regardless of available capacity: the exact unexpired one-use approval from a button or owner-origin merge instruction, or a standing grant from the owner's button tap or the project's own policy snapshot.

## Production failures

`production_failed` means the pull request was already merged and either deployment or canary failed. The merge fact remains durable. Inspect the job and redacted command receipt before following the operator-approved recovery or rollback procedure:

```bash
bb telegram-agent job show <job-id> --json
bb plugin logs telegram-agent -n 50
```

The plugin does not automatically retry production. It does run the policy's `rollbackCommand` when one is configured, immediately after the failing deploy or canary command and before reporting the failure; the receipt is on the stage evidence. If no rollback was configured, or the rollback itself failed, both merge grants for that project are withdrawn — the button-granted one and any grant its policy carries — and the project's failure brake trips without a fingerprint, so it admits no new work until you send `/resume <alias>`. A rollback that succeeded is a recovery: it withdraws nothing and brakes nothing. A job reports `complete` after a successful canary, or earlier when production is not configured and the pull request has passed final review. Small-fix jobs complete only after the pull request passes configured validation and its quality review.

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
