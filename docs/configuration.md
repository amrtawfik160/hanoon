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
| Controller model | `claude-opus-5[1m]`, `claude-opus-4-8[1m]`, `claude-sonnet-5`, `claude-fable-5`, `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol` | `claude-opus-5[1m]` |
| Fallback model 1 | `disabled` or any controller model | `gpt-5.6-sol` |
| Fallback model 2 | `disabled` or any controller model | `disabled` |
| Controller reasoning level | `low`, `medium`, `high`, `xhigh`, `max` | `xhigh` |
| Controller service tier | `fast`, `default` | `default` |
| Controller permission mode | `auto`, `accept-edits`, `full` | `full` |

The model selects its provider: `claude-*` models run on Claude Code, `gpt-*` models on Codex. Service tier is a Codex-only input and is not sent for Claude models.

Each new Telegram message starts with the primary model. The ordered fallbacks are tried only when BB proves the preceding provider failed before accepting that message; they are never used after the model could have started tools or other effects. Disabled entries and duplicates are skipped. Fallbacks share the primary turn's reasoning, service-tier, and permission policy. The `strong-only` routing kill switch still wins and cannot be weakened by a fallback setting.

Changing the model to one owned by the other provider retires the live BB conversation thread, because a thread cannot switch providers. The next message opens a replacement seeded with the recent conversation, so the change costs a pause rather than the conversation.

Saved values apply when the next controller turn starts, including later turns in the existing durable conversation. They do not rewrite a running turn or an active job. BB and the execution machine may reduce a requested permission mode.

### Capability routing controls

Three independent plugin settings control only newly created routing snapshots:

| Setting | Options | Default | Effect |
| --- | --- | --- | --- |
| Capability job graph | `adaptive`, `legacy` | `adaptive` | `adaptive` classifies new jobs into versioned recipes and uses each recipe's rollout decision; `legacy` pins new jobs to the established full/small-fix graph. |
| Controller capabilities | `bundled`, `all-tools` | `bundled` | `bundled` selects the minimum controller bundle for each new turn; `all-tools` restores all admitted controller bundles for new turns. |
| Capability model routing | `adaptive`, `strong-only` | `adaptive` | `adaptive` selects the declared pool; `strong-only` applies a strong-pool floor to new controller turns and worker attempts. |

These are kill switches, not data migrations. They do not rewrite an in-flight job, an existing controller or worker profile, a provider trial, or a capability receipt. Recipe promotion and rollback are also new-job decisions: a promoted job keeps `active` after rollback, while the next matching job returns to `shadow` (or `legacy` when the job-graph switch says so).

Model route identity is the exact provider, model, reasoning, and service-tier tuple. Permission remains owned by controller or project policy and is never inferred from the model pool. `strong-only` raises the model floor without granting broader filesystem, command, merge, or production authority.

No setting promotes a recipe. Promotion is an append-only operator decision available only after the production evidence reader resolves the required deterministic, live-recovery, model-comparison, and zero-tolerance records. This release has no trusted production collector or operator ingestion path for those records; the future collector must separately prove the acceptance job is disposable. Use `bb telegram-agent capability status [recipe] --json` to inspect the installed database and follow [Capability routing and rollout](operations.md#capability-routing-and-rollout) for the future promotion path or immediate rollback. A fresh installation starts every adaptive recipe in `shadow`.

### Background work

Two settings govern what the agent does when you have not asked it anything:

| Setting | Options | Default | Purpose |
| --- | --- | --- | --- |
| Background learning model | `inherit` or any controller model | `inherit` | Model used to learn lessons from finished jobs. `inherit` leaves it to the project default, which is the only safe answer when the installation's providers are unknown; naming a cheaper model keeps background work off your conversational tier. |
| Self-maintenance | `enabled`, `disabled` | `enabled` | Lets the agent run its own daily stale-work sweep, weekly memory audit, and weekly scorecard. |

Turning self-maintenance off stops the agent installing its own monitors. It does not touch monitors you set yourself, and it does not stop the agent learning from finished jobs.

The conversation's own budgets are deliberately not settings. A turn is bounded by tool calls, tokens, and repeated command failures, and those bounds sit far above any healthy turn: they exist to stop a runaway, not to be tuned from a phone. See [Architecture](architecture.md) for the exact behaviour.

### How the agent works for you

How the agent should behave — terser answers, always leading with the pull-request link — is not a setting. Tell it in the chat and it records a single standing instruction that is applied to every later turn, replaced whenever you restate it, and cleared when you tell it to stop. It is layered after the fixed instructions, so it can change tone and habits but never a safety boundary.

### Why the default is `full`

The owner works from Telegram and is not watching the BB app, so an approval prompt rendered there stalls the agent with nobody to answer it. `full` lets it use the shell, the `bb` CLI, installed skills, and MCP servers on any connected machine without that dead end.

The limits that remain are the ones the owner can actually see and answer:

- merging a pull request and promoting to production run through the job pipeline and need a one-use Telegram approval;
- destructive or irreversible actions outside a worktree are asked about in the chat first;
- credential-shaped text is refused before it can be stored as a memory.

Set `auto` or `accept-edits` if you would rather approve execution in the BB app, and expect the agent to stop and wait when it hits one.

Planner, critic, and documentation stages pin their own execution tuple and are unaffected by this setting; implementation and review workers use the enabled project's immutable policy snapshot.

## Enable a project

Only standard BB Git projects with a canonical GitHub remote and an available source can be enabled. The command verifies the live project, remote, source, and base branch before storing the policy.

Prepare a JSON policy, then use one of three mutually exclusive input modes:

```bash
bb telegram-agent project enable <project-id> --policy-file /absolute/path/to/policy.json
bb telegram-agent project enable <project-id> --policy-file /absolute/path/to/policy.json --host <host-id>
bb telegram-agent project enable <project-id> --policy-json '<policy-json>'
```

The `--host` flag is valid only with an absolute `--policy-file` path and selects the BB host that owns that file. A command invoked from a BB thread can otherwise resolve the invoking environment's host.

Individual flags are also supported. At minimum they require `--alias`, `--base`, and `--merge-method`:

```bash
bb telegram-agent project enable <project-id> \
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
| `implementation`, `review` | Optional provider/model/reasoning/tier/permission fields. Missing values use BB's resolved defaults. |
| `validationCommands` | Up to 20 owner-authored commands. |
| `production.targetKey` | Optional shared isolation key: 1–64 lowercase letters, numbers, `.`, `_`, or `-`, starting alphanumeric. When absent, the project id is used. |
| `production.deployCommands` | One to 20 commands when production is configured. |
| `production.canaryCommands` | One to 20 commands when production is configured. |
| `production.rollbackCommand` | Optional operator guidance. It is recorded but never executed automatically. |
| `production.convexDeployRequired` | When true, a deploy command must invoke `convex deploy` through the supported CLI form. |
| `requiredChecks` | Up to 50 non-empty GitHub check names. |
| `outputRedactionPatterns` | Up to 20 valid regular expressions, each at most 200 characters. |
| `workerStartGraceMs` | `10000`–`900000`; default `120000`. How long a newly registered worker may remain missing or silent before recovery classification. |
| `workerLivenessWatchdogMs` | `60000`–`3600000`; default `300000`. |
| `workerRecoveryLimit` | `1`–`5`; default `2`. Maximum automatic recoveries for a job after the same failure signature has previously recovered. |
| `maxReviewCycles` | `1`–`10`; default `3`. |
| `mergeMethod` | `merge`, `rebase`, or `squash`. |

Every command entry requires a non-empty name of at most 40 characters, a command of at most 8,000 characters, and `timeoutMs` from `1000` to `3600000`.

Deploy and canary must both be present before the plugin can issue merge approval. Commands run sequentially after merge in the detached, verified worktree. They should be safe to reconcile after interruption. The plugin never runs the stored rollback command automatically.

## Validate configuration

```bash
bb telegram-agent doctor
bb telegram-agent doctor <project-id>
bb telegram-agent project list
```

The global doctor checks token presence and owner pairing. The project form additionally checks the enabled policy, deployment/canary configuration, standard Git project/source, BB defaults, provider availability, source host/path, `gh auth status`, repository access, and merge SDK availability. It exits non-zero when any required check fails.

Next: [Operations](operations.md) · [Architecture](architecture.md)
