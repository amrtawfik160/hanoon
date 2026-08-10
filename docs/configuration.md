# Configuration

Telegram Agent is configured in two places:

- plugin settings control the Telegram connection and conversational controller;
- a versioned project policy controls implementation, review, validation, merge, deployment, and canary work for each enabled BB project.

Controller settings never override a job's stored project policy.

## Prerequisites

- BB `0.36` or newer.
- npm for installing the repository dependencies.
- A Telegram bot created with [BotFather](https://core.telegram.org/bots#botfather).
- Codex access for the controller and any providers/models selected by project policies.
- A standard BB project backed by a GitHub repository.
- A reachable local or cloned BB project source with a named base branch.
- GitHub CLI (`gh`) authenticated on every source host used by an enabled project.

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
| Telegram poll timeout | Integer from `5` to `50` seconds | `30` | Telegram long-poll timeout. |

An empty BB app URL disables the link. Non-HTTPS values are not rendered as Telegram buttons.

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
| Controller model | `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol` | `gpt-5.6-luna` |
| Reasoning level | `low`, `medium`, `high`, `xhigh`, `max` | `max` |
| Service tier | `fast`, `default` | `fast` |
| Permission mode | `auto`, `accept-edits`, `full` | `auto` |

Saved values apply when the next controller turn starts, including later turns in the existing durable conversation. They do not rewrite a running turn or an active job. BB and the execution machine may reduce a requested permission mode.

The provider stays fixed to `codex`. Planner, critic, and documentation stages use the pipeline's fixed profile; implementation and review workers use the enabled project's immutable policy snapshot.

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
  "workerLivenessWatchdogMs": 300000,
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
| `production.deployCommands` | One to 20 commands when production is configured. |
| `production.canaryCommands` | One to 20 commands when production is configured. |
| `production.rollbackCommand` | Optional operator guidance. It is recorded but never executed automatically. |
| `production.convexDeployRequired` | When true, a deploy command must invoke `convex deploy` through the supported CLI form. |
| `requiredChecks` | Up to 50 non-empty GitHub check names. |
| `outputRedactionPatterns` | Up to 20 valid regular expressions, each at most 200 characters. |
| `workerLivenessWatchdogMs` | `60000`–`3600000`; default `300000`. |
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
