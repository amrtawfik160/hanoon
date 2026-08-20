# Configuration

Telegram Agent is configured in two places:

- plugin settings control the Telegram connection and conversational controller;
- a versioned project policy controls implementation, review, validation, merge, deployment, and canary work for each enabled BB project.

Controller settings never override a job's stored project policy.

## Prerequisites

- BB `0.36` or newer.
- npm for installing the repository dependencies.
- A Telegram bot created with [BotFather](https://core.telegram.org/bots#botfather).
- Claude Code or Codex access for the conversational agent, plus any providers/models selected by project policies.
- A standard BB project backed by a GitHub repository.
- A reachable local or cloned BB project source with a named base branch.
- GitHub CLI (`gh`) authenticated on every source host used by an enabled project.
- Optional: a BB voice transcription service configured on every BB server host that runs this plugin. Hanoon invokes `bb voice transcribe`; without that service, voice and audio messages receive an unavailable notice and the owner must type the request instead.
- Optional: `ffmpeg` and `ffprobe` on the PATH of the BB server host. They let the controller sample GIFs and short videos into stills. Without them, clips still arrive; the agent sees Telegram's preview still instead of frames.

The hidden controller uses BB's personal project. That project must have a selected source host, or BB must have exactly one connected host when the personal project has no source binding.

## Install

From a checkout of this repository:

```bash
npm ci
npm run check
bb plugin install . --yes
bb plugin enable telegram-agent
bb plugin reload telegram-agent
```

The plugin id is `telegram-agent`. Installation is full-trust: the plugin runs in the BB server process and can use BB's SDK, plugin database, agent tools, and background services.

## Configure the Telegram bot

Open **Extensions → Plugins → Telegram Agent**. Enter the bot token in **Telegram bot token** and save. The token is a secret setting; do not put it in a shell command, policy file, issue, log, or chat message.

The remaining connection settings are:

| Setting | Accepted value | Default | Purpose |
| --- | --- | --- | --- |
| BB app base URL | Empty or a URL | Empty | An external HTTPS value adds an **Open BB** link to Telegram status messages. |
| Maximum concurrent jobs | Integer select from `1` to `8` | `5` | Bounds admitted or draining project pipelines across the installation. |

An empty BB app URL disables the link. Non-HTTPS values are not rendered as Telegram buttons.

A valid concurrency change affects later admissions immediately. Lowering it does not cancel or preempt already admitted work; available capacity remains zero until enough draining jobs release. Invalid persisted input fails configuration closed and does not silently substitute the default.

## Pair one owner

Create a one-use link:

```bash
bb telegram-agent pair
```

Open the returned link from the intended owner's Telegram account and finish pairing in a private chat. The link contains a sensitive secret and expires after ten minutes. Do not copy it into logs, issues, or screenshots.

Pairing binds one human Telegram user and one private chat. Running `pair` again while an owner is paired fails safely; use `bb telegram-agent unpair` only when you intend to revoke that identity and all outstanding approvals.

## Controller profile

The same plugin settings page controls subsequent turns in the hidden conversational controller:

| Setting | Options | Default |
| --- | --- | --- |
| Controller model | Claude Code: `claude-opus-5[1m]`, `claude-opus-4-8[1m]`, `claude-sonnet-5`, `claude-fable-5`. Codex: `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`. Cursor: `cursor-grok-4.6-medium`, `gpt-5.6-sol-medium`, `claude-opus-5-thinking-medium`, `claude-fable-5-thinking-medium`, `composer-2.5`. Grok: `grok-4.6`, `grok-4.5`. | `claude-opus-5[1m]` |
| Fallback model 1 | `disabled` or any controller model | `gpt-5.6-sol` |
| Fallback model 2 | `disabled` or any controller model | `disabled` |
| Controller reasoning level | `low`, `medium`, `high`, `xhigh`, `max` | `xhigh` |
| Controller service tier | `fast`, `default` | `default` |
| Controller permission mode | `auto`, `accept-edits`, `full` | `auto` |
| Agent identity | Empty, or up to 254 UTF-16 code units | Shipped identity |

Each model id belongs to one provider in the pipeline catalog. Prefix matching is not used: `claude-opus-5-thinking-medium` is Cursor, not Claude Code. Service tier is sent for Codex, Cursor, and Grok, and is omitted for Claude Code. Cursor and Grok reject permission mode `auto`, so a controller turn on those models sends `accept-edits` unless the setting is `full`. Exploratory and delegated child threads opened from that controller use the same provider, model, and compatible permission, so they start instead of inheriting BB's auto default.

Each new Telegram message starts with the primary model. The ordered fallbacks are tried only when BB proves the preceding provider failed before accepting that message; they are never used after the model could have started tools or other effects. Disabled entries and duplicates are skipped. Fallbacks share the primary turn's reasoning, service-tier, and requested permission. A fallback on Cursor or Grok still cannot send `auto`; spawn uses `accept-edits` unless the shared setting is `full`. The `strong-only` routing kill switch still wins and cannot be weakened by a fallback setting.

Changing the model to one owned by the other provider retires the live BB conversation thread, because a thread cannot switch providers. The next message opens a replacement seeded with the recent conversation, so the change costs a pause rather than the conversation.

Saved values apply when the next controller turn starts, including later turns in the existing durable conversation. They do not rewrite a running turn or an active job. BB and the execution machine may reduce a requested permission mode.

Agent identity replaces only who the controller is and how it sounds. Fixed conduct and safety boundaries remain above it. The 254-unit limit is the exact delivery budget: accepted identity text is delivered whole rather than silently shortened. Leave it empty to use the shipped identity.

### Capability routing controls

Three independent plugin settings control only newly created routing snapshots:

| Setting | Options | Default | Effect |
| --- | --- | --- | --- |
| Capability job graph | `adaptive`, `legacy` | `adaptive` | `adaptive` classifies new jobs into versioned recipes and uses each recipe's rollout decision; `legacy` pins new jobs to the established full/small-fix graph. |
| Controller capabilities | `bundled`, `all-tools` | `bundled` | `bundled` selects the minimum controller bundle for each new turn; `all-tools` restores all admitted controller bundles for new turns. The job-control bundle also matches merge, land, resume, bug-fix, feature-build, and ship/deploy/release wording so those turns receive start, steer, retry, and land tools. |
| Capability model routing | `adaptive`, `strong-only` | `adaptive` | `adaptive` selects the declared pool; `strong-only` applies a strong-pool floor to new controller turns and worker attempts. |

These are kill switches, not data migrations. They do not rewrite an in-flight job, an existing controller or worker profile, a provider trial, or a capability receipt. Recipe promotion and rollback are also new-job decisions: a promoted job keeps `active` after rollback, while the next matching job returns to `shadow` (or `legacy` when the job-graph switch says so).

Model route identity is the exact provider, model, reasoning, and service-tier tuple. Permission remains owned by controller or project policy and is never inferred from the model pool. `strong-only` raises the model floor without granting broader filesystem, command, merge, or production authority.

No setting promotes a recipe. Promotion is an append-only operator decision available only after the production evidence reader resolves the required deterministic, live-recovery, model-comparison, and zero-tolerance records. This release has no trusted production collector or operator ingestion path for those records; the future collector must separately prove the acceptance job is disposable. Use `bb telegram-agent capability status [recipe] --json` to inspect the installed database and follow [Capability routing and rollout](operations.md#capability-routing-and-rollout) for the future promotion path or immediate rollback. A fresh installation starts every adaptive recipe in `shadow`.

### Background work

Two settings govern what the agent does when you have not asked it anything:

| Setting | Options | Default | Purpose |
| --- | --- | --- | --- |
| Background learning model | `inherit` or any controller model | `inherit` | Model used to learn lessons from finished jobs. `inherit` leaves it to the project default, which is the only safe answer when the installation's providers are unknown; naming a cheaper model keeps background work off your conversational tier. |
| Self-maintenance | `enabled`, `disabled` | `enabled` | Enables the agent's daily stale-work monitor, daily read-only repository audits, bounded deletion of old allowlisted plugin temporary directories, weekly memory audit, and weekly scorecard. |

Turning self-maintenance off retires the agent's own monitors, disables its repository audits, and prevents temporary-directory deletion. It does not touch monitors you set yourself, stop disk-pressure checks and warnings, or stop the agent learning from finished jobs. Repository audits inspect documentation staleness, debt markers, bug backlogs, and unresolved pull-request review findings through read-only Git and provider commands. Temporary cleanup is limited to old top-level entries whose names match the plugin's allowlist, and each daily pass has a deletion cap.

The conversation's own budgets are deliberately not settings. A turn is bounded by tool calls, tokens, and repeated command failures, and those bounds sit far above any healthy turn: they exist to stop a runaway, not to be tuned from a phone. See [Architecture](architecture.md) for the exact behaviour.

### Giving the agent standing information

Facts the agent should know — account names, service URLs, conventions, and
credentials — can be loaded from a file instead of typed into the chat one at a
time:

```bash
bb telegram-agent memory import --file /absolute/path/to/knowledge.json
```

```json
{
  "entries": [
    { "subject": "staging database", "body": "Runs on db-staging.internal, port 5432." },
    { "subject": "deploy window", "body": "Only weekday mornings.", "kind": "preference" }
  ]
}
```

Each entry needs `subject` and `body`. `kind` is `fact` (the default),
`preference`, `decision`, or `correction`; `scope` defaults to the owner and may
name a project id instead; `importance` is optional. One file may carry at most
200 entries, and re-importing the same subject replaces the earlier entry rather
than stacking a duplicate. Use `--host` to name the BB host holding the file, and
`--scope` to change the default scope for every entry in it.

Imported entries are **not** added to every prompt. They sit in the same memory
the agent already searches, so it retrieves one only when a message calls for it.

This command is the one write allowed to contain credential-shaped text. It runs
on the protected BB host under your own identity, not the agent's, and entries
are recorded as owner-sourced. The agent can never write such a memory itself:
anything it tries to remember is still refused if it looks like a credential.

Anything you put in that file can be read back by the agent, and by whoever can
read the plugin database. It is not a vault, and it is not a substitute for one —
see [Security](../SECURITY.md).

### How the agent works for you

How the agent should behave — terser answers, always leading with the pull-request link — is not a setting. Tell it in the chat and it records a single standing instruction that is applied to every later turn, replaced whenever you restate it, and cleared when you tell it to stop. It is layered after the fixed instructions, so it can change tone and habits but never a safety boundary.

### The permission mode, and what it does not do

`auto` is the default. The owner can choose `accept-edits` or `full` explicitly, and a saved value is preserved for later turns. The permission mode is not mechanically enforced isolation, and the agent's standing instructions are guidance, not enforcement.

The limits that remain are the ones the owner can actually see and answer:

- merging a pull request and promoting to production run through the job pipeline and need a Telegram approval: a one-use approval from the approval button or an unambiguous owner-origin merge instruction, unless the owner has granted that project a standing approval (see [Standing merge approval](#standing-merge-approval));
- installing or connecting an integration, changing a credential, spending money, a destructive external action, or an irreversible external write are asked about in the chat first;
- credential-shaped text is refused before it can be stored as a memory;
- a permission prompt BB does raise for the hidden controller is bridged into Telegram as *Allow once* / *Deny*, so choosing `auto` or `accept-edits` no longer means waiting on a dead end.

A BB permission prompt for the hidden controller can be bridged into Telegram as *Allow once* / *Deny*, so choosing `auto` no longer leaves the owner at a dead end. This does not authorize connector installation, credential mutation, spending, destructive external action, or irreversible external writes through Hanoon's manifest.

Planner, critic, and documentation stages pin their own execution tuple and are unaffected by this setting; implementation and review workers use the enabled project's immutable policy snapshot.

## Credential broker foundation

This is the first slice of a separate credential broker: a protected service that this plugin never runs and that holds no application secret itself, but that can be asked to prove it can reach one exact 1Password vault field. **`credentialBrokerMode` defaults to `disabled`**, and every access command and doctor check fails closed in that state. This section documents the setting shape only — a fresh installation has no broker to point at, and turning isolated mode on for real additionally needs the disposable 1Password account, protected broker host, and reviewed topology probes covered in [Disposable live acceptance](live-acceptance.md). Full readiness also requires an explicitly approved controller permission mode.

| Setting | Accepted value | Default | Purpose |
| --- | --- | --- | --- |
| Credential broker mode | `disabled`, `isolated` | `disabled` | `isolated` enables read-only access to a protected credential broker. |
| Credential broker endpoint | HTTPS origin, e.g. `https://broker.internal` | Empty | Fixed broker origin; no path, query, credentials, or loopback/link-local/multicast host. Ignored while disabled. |
| Credential broker installation id | Opaque id | Empty | Issued by the broker's protected enrollment CLI, not chosen by the operator. |
| Credential broker topology receipt digest | SHA-256 hex | Empty | Digest of the current reviewed topology acceptance report. |
| Credential broker topology receipt expiry | Base-10 epoch-millisecond string | Empty | Expiry from the same reviewed report. |
| Credential broker client certificate | PEM | Empty | This installation's public mTLS client certificate. |
| Credential broker client private key | PEM, secret setting | — | This installation's mTLS client private key. Never logged, stored in plugin SQLite, or shown in CLI/doctor output. |
| Credential broker CA certificate | PEM | Empty | Public CA certificate that issued the broker's server certificate. |

Turning isolated mode on for the first time needs `bb plugin reload telegram-agent` before verification becomes reachable, because the complete capability manifest is rebuilt at reload. Once isolated, changing the endpoint, installation id, certificates, key, or topology digest/expiry rotates the live connection immediately, without a reload — the next `access status` or doctor call re-attempts the broker health check under the new material. An endpoint change does not migrate existing bindings.

The only operator commands are read-only:

```bash
bb telegram-agent access list [--state <state>] [--after <binding-id>] [--limit <1-10>] [--json]
bb telegram-agent access status [binding-id] [--json]
```

`access list` reads locally stored, secret-free binding metadata and never contacts the broker. `access status` runs the same diagnostic health check the doctor uses and reports one selected binding. There is deliberately no `access verify` or enrollment command here — a live verification can only be requested by the owner from Telegram, through Hanoon's guarded tool, and a pass only ever proves vault access, never that the credential works for its application. Binding enrollment happens on the protected broker host itself; see `broker/README.md`.

`bb telegram-agent doctor` includes one `credential broker` row while disabled, or `credential: <check>` rows once isolated — `trust_kernel`, `controller_permission`, `isolated_configuration`, `topology_receipt`, `broker_tls`, `broker_identity`, `protocol_version`, `installation_identity`, `broker_audit`, and `onepassword_adapter`, in that order — with only 3 or 4 rows when an early check already fails and all 10 otherwise; see [Operations](operations.md#credential-broker) for exactly which. None of these rows print a certificate, endpoint, digest value, vault id, or raw broker error.

## Enable a project

Only standard BB Git projects with a canonical GitHub remote and an available source can be enabled. The command verifies the live project, remote, source, and base branch before storing the policy.

Prepare a JSON policy, then use one of three mutually exclusive input modes:

```bash
bb telegram-agent project enable proj_7f3d2a91 --policy-file /absolute/path/to/policy.json
bb telegram-agent project enable proj_7f3d2a91 --policy-file /absolute/path/to/policy.json --host host_2b91c4
bb telegram-agent project enable proj_7f3d2a91 --policy-json "$POLICY_JSON"
```

The `--host` flag is valid only with an absolute `--policy-file` path and selects the BB host that owns that file. A command invoked from a BB thread can otherwise resolve the invoking environment's host.

Individual flags are also supported. At minimum they require `--alias`, `--base`, and `--merge-method`:

```bash
bb telegram-agent project enable proj_7f3d2a91 \
  --alias example \
  --base main \
  --merge-method squash \
  --implementation-provider PROVIDER_ID \
  --implementation-model IMPLEMENTATION_MODEL \
  --review-provider PROVIDER_ID \
  --review-model REVIEW_MODEL \
  --validation-json '{"name":"unit","command":"npm test","timeoutMs":600000}'
```

Policy files/JSON cannot be mixed with individual policy flags.

For production, individual flags accept `--production-target-key shared.prod` alongside at least one `--deploy-json` and one `--canary-json`. A target key without both command groups is rejected with exit code `2`.

## Project policy reference

Use unmistakable placeholders and replace them with values verified for the target BB project:

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
    "reasoningLevel": "high",
    "serviceTier": "default",
    "permissionMode": "auto"
  },
  "stageExecution": {
    "plan": { "tier": "strong" },
    "docs": { "tier": "fast", "maxEscalations": 1 },
    "review": { "providerId": "codex", "model": "gpt-5.6-sol" }
  },
  "validationCommands": [
    {
      "name": "unit",
      "command": "npm test",
      "timeoutMs": 600000
    }
  ],
  "production": {
    "targetKey": "shared.prod",
    "deployCommands": [
      {
        "name": "deploy",
        "command": "./scripts/deploy-production.sh",
        "timeoutMs": 1800000
      }
    ],
    "canaryCommands": [
      {
        "name": "health",
        "command": "./scripts/verify-production.sh",
        "timeoutMs": 300000
      }
    ],
    "rollbackCommand": {
      "name": "rollback",
      "command": "./scripts/rollback-production.sh",
      "timeoutMs": 600000
    },
    "convexDeployRequired": false
  },
  "regression": {
    "commands": [
      {
        "name": "unit",
        "command": "npm test",
        "timeoutMs": 600000
      }
    ],
    "intervalMs": 86400000
  },
  "requiredChecks": ["unit"],
  "outputRedactionPatterns": [],
  "workerStartGraceMs": 120000,
  "workerLivenessWatchdogMs": 300000,
  "workerRecoveryLimit": 2,
  "maxReviewCycles": 3,
  "mergeMethod": "squash"
}
```

### Policy fields

| Field | Contract |
| --- | --- |
| `projectId` | Must start with `proj_` and match the positional BB project id. |
| `alias` | Lowercase letters, numbers, and hyphens; starts alphanumeric; maximum 24 characters. |
| `githubRepository` | `OWNER/REPOSITORY`; when supplied, must match the live GitHub remote. |
| `baseBranch` | Non-empty and present in the selected BB source. |
| `implementation`, `review` | Optional provider/model/reasoning/tier/permission fields. When `stageExecution` has no entry for that stage, these are what the stage runs on. |
| `stageExecution` | Optional per-worker-kind execution table. See [Per-stage model routing](#per-stage-model-routing). |
| `validationCommands` | Up to 20 owner-authored commands. |
| `production.targetKey` | Optional shared isolation key: 1–64 lowercase letters, numbers, `.`, `_`, or `-`, starting alphanumeric. When absent, the project id is used. |
| `production.deployCommands` | One to 20 commands when production is configured. |
| `production.canaryCommands` | One to 20 commands when production is configured. |
| `production.healthCommands` | Optional one to five cheap, read-only commands run on a timer after production is reached, so a crash loop is noticed rather than waited out. |
| `production.healthIntervalMs` | Optional interval for those health commands, from 60,000 ms to 86,400,000 ms. |
| `production.rollbackCommand` | Optional. When set, it is run automatically as soon as a deploy or canary command fails, before the failure is reported. When absent, a failed deploy leaves production on the new code. |
| `production.convexDeployRequired` | When true, a deploy command must invoke `convex deploy` through the supported CLI form. |
| `regression.commands` | Optional one to five commands run on a timer against the project, independent of any job, so breakage between jobs is noticed. |
| `regression.intervalMs` | Optional interval for those commands, from 3,600,000 ms to 604,800,000 ms. Defaults to daily. |
| `requiredChecks` | Up to 50 non-empty GitHub check names. |
| `outputRedactionPatterns` | Up to 20 valid regular expressions, each at most 200 characters. |
| `workerStartGraceMs` | `10000`–`900000`; default `120000`. How long a newly registered worker may remain missing or silent before recovery classification. |
| `workerLivenessWatchdogMs` | `60000`–`3600000`; default `300000`. |
| `workerRecoveryLimit` | `1`–`5`; default `2`. Maximum automatic recoveries for a job after the same failure signature has previously recovered. |
| `maxReviewCycles` | `1`–`10`; default `3`. |
| `mergeMethod` | `merge`, `rebase`, or `squash`. |

Every command entry requires a non-empty name of at most 40 characters, a command of at most 8,000 characters, and `timeoutMs` from `1000` to `3600000`.

Deploy and canary must both be present before the plugin can issue merge approval. Commands run sequentially after merge in the detached, verified worktree. They should be safe to reconcile after interruption.

When a deploy or canary command fails and `rollbackCommand` is configured, the plugin runs it immediately, in the same stage, before reporting the failure. The rollback is deliberately not cancellable: a cancelled job must still finish reverting production. Its receipt is stored on the stage evidence alongside the failed command, and the stage outcome stays `fail` whether or not the rollback worked.

Configuring a `rollbackCommand` is what makes unattended merging safe, so it is effectively required for any project given a standing approval.

## Scheduled checks between jobs

`validationCommands` prove one job's change. Nothing proves the project still works *between* jobs, which is how a broken dependency, an expired credential, or someone else's merge stays invisible until the next time work is requested. `regression.commands` run on a timer for exactly that reason.

The alerting rules exist so a message means "something is newly broken" and nothing else:

- every command runs, and failures are tracked as a **set of command names** rather than a count, so a new break is distinguishable from a different command failing in place of a fixed one;
- a command that fails and then passes an immediate re-run is recorded as flaky and never alerted on;
- a failure the owner has already been told about stays quiet until it changes;
- a command that could not run at all is not evidence of a regression and is ignored.

The owner is messaged when a command newly starts failing, and once more when everything passes again. A steady failure produces exactly one message.

## Failure brake

When the same failure repeats across separate jobs, that is a fault that will keep consuming attempts until something changes. Hanoon groups recent failures by cause — a fingerprint of the failure text with commit hashes, timestamps, paths, and numbers removed, so the same fault matches itself across jobs — and treats three or more of one cause within four hours as a loop.

On detecting a loop he stops admitting **new** jobs for that project, tells the owner once, and leaves everything else alone:

- work already running is unaffected and finishes normally;
- queued jobs stay queued rather than being cancelled;
- other projects are unaffected;
- the same cause is not escalated again for a week, so a fault the owner is already deciding about does not message them hourly.

The controller may clear a fingerprinted cause once after investigating it. Every clear is retained in immutable history, including an owner `/resume`; if that cause trips the brake again, the controller refuses to clear it and leaves the decision to the owner. A pause without a durable fingerprint is also owner-only. `/resume` lists what is paused, `/resume <alias>` starts one project, and `/resume all` starts every one. `/health` names any paused project.

If the pause list cannot be read, no work is admitted that tick — an unreadable list must never look like "nothing is paused".

## Standing merge approval

By default the plugin asks for a one-use approval before every merge. The owner can give it with the approval button or by sending an unambiguous merge instruction for the waiting job. Either form only queues the guarded merge pipeline; it does not mean the provider merge has already landed. The approval message also offers **Merge + deploy, and always from now on**, which approves that merge and records a standing approval for that project. Afterwards the plugin merges, deploys, and runs the canary without asking.

A standing approval replaces the owner's signature only. Every check that produced the merge candidate still runs, and the plugin falls back to asking when:

- the pull-request head is not established, or the owner has asked the job to stop;
- the project has no production configuration;
- the change needed two or more rounds of review fixes.

The standing approval is withdrawn automatically when production fails and the rollback either was not configured or failed — recovery is exhausted, so nothing merges unattended there again until the owner re-grants it. A rollback that succeeded is a recovery, not an incident, and the standing approval survives it.

Granting a standing approval is only ever a button tap. An owner-origin sentence can grant one-use authority for its named job, but system turns and agent-generated text cannot grant either form. Withdrawing standing approval is available by name:

- `/approvals` lists the projects that merge without asking;
- `/approvals off <alias>` withdraws one;
- `/approvals off` withdraws all of them.

Every grant, withdrawal, and unattended merge is recorded in an append-only log keyed by project.

## Per-stage model routing

Every worker kind the pipeline runs has its own execution profile: `plan`, `critique`, `implementation`, `review`, `validation`, `docs`, `merge`, `deploy`, and `canary`. Each entry is optional. Anything left out falls back to that stage's declared default tier, so an unconfigured project already behaves sensibly.

Pipeline stages never inherit the conversational controller's execution settings. Retuning the controller cannot change how plans, critiques, or reviews are produced.

### Tiers and defaults

Three tiers name what a stage runs on:

| Tier | Runs on |
| --- | --- |
| `fast` | `gpt-5.6-luna` at `low` reasoning |
| `standard` | `gpt-5.6-terra` at `high` reasoning |
| `strong` | `gpt-5.6-sol` at `xhigh` reasoning |

Heavy reasoning is spent where judgement is the work; the mechanical stages run cheap:

| Stage | Default tier |
| --- | --- |
| `plan`, `critique`, `review` | `strong` |
| `implementation` | `standard` |
| `validation`, `docs`, `merge`, `deploy`, `canary` | `fast` |

Only `plan`, `critique`, `implementation`, `review`, and `docs` currently dispatch a model-backed worker. `validation`, `merge`, `deploy`, and `canary` run as deterministic terminal commands today; their entries are configured and validated, and take effect if those stages ever gain a worker.

### Stage fields

| Field | Contract |
| --- | --- |
| `tier` | `fast`, `standard`, or `strong`. Absent uses the stage's default above. |
| `providerId` | Must be a provider the plugin knows, and requires `model`, which it must own. A provider on its own is rejected: the tier already supplies a model, and pairing it with another provider's would fail at dispatch. |
| `model` | Must be a model that provider offers. Pinning an exact model disables escalation for that stage. |
| `reasoningLevel` | Overrides the tier's reasoning level. |
| `serviceTier` | `default` or `fast`. **Off unless set here.** Rejected when the stage's `model` belongs to a provider that does not honour a service tier. |
| `permissionMode` | `auto`, `accept-edits`, or `full`. An explicit `auto` is rejected for Cursor, Grok, and Pi. If those providers leave the field unset, spawn uses `accept-edits` (or `full` for Pi). |
| `maxEscalations` | `0`–`2`; how many tiers this stage may climb across retries. `0` disables escalation. Defaults to `2`, or `1` for `merge`, `deploy`, and `canary`. |

An entry is the whole answer for its stage: fields it leaves out come from the tier, not from `implementation` or `review`.

### Escalation on retry

A stage that repeats runs its next attempt one tier stronger, up to `maxEscalations` and never past `strong`. Both a repeated attempt and a repeated plan or review cycle count as the same signal — the stronger of the two decides, so they do not stack. A stage that pins an exact `model` is never substituted.

### Model ids are validated on save and load

A stage naming a model no provider offers, a provider that does not own that model, an unknown provider, a provider given without a model, or a fast service tier that model's provider cannot honour is rejected whenever the policy is parsed. The failure happens at `project enable` and at load, not mid-job when a worker will not start.

The older `implementation` and `review` fields are deliberately exempt: policies stored before this table existed must keep running untouched.

### Measured spend

Every stage attempt records the provider, model, reasoning level, service tier, tier and any escalation, token counts, duration, and cost:

```bash
bb telegram-agent job spend <job-id>
bb telegram-agent job spend <job-id> --json
```

Cost is reported as `unpriced` in the text form, and as a null `costMicroUsd` with `--json`, for any model with no published rate entered in the model catalog. That means "not measured", never "free"; entering the rate is the only step needed to turn measured tokens into measured spend.

## Validate configuration

```bash
bb telegram-agent doctor
bb telegram-agent doctor proj_7f3d2a91
bb telegram-agent project list
```

The global doctor checks token presence and owner pairing, and always includes the credential broker section described above. The project form additionally checks the enabled policy, deployment/canary configuration, standard Git project/source, BB defaults, provider availability, source host/path, `gh auth status`, repository access, and merge SDK availability. It exits non-zero when any required check fails.

Next: [Operations](operations.md) · [Architecture](architecture.md)
