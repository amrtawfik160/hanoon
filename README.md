# Hanoon

Hanoon is a private Telegram AI agent for BB. It lets one paired owner talk to a configurable controller and run a reviewed software-delivery pipeline from planning through merge, deployment, and canary verification.

Inspired by [Valor](https://github.com/tomcounsell/ai) and adapted to BB's native projects, threads, environments, worktrees, permissions, and merge API.

The installed plugin and CLI namespace remain `telegram-agent`.

## Why Hanoon?

- **Work from Telegram.** Ask questions, inspect BB threads, start a bounded change, receive live drafts, and follow one durable status message without opening another dashboard.
- **Keep the controller durable.** Ordinary messages stay in one hidden BB conversation. Controller identity, FIFO turns, streaming cursors, jobs, approvals, and delivery state survive plugin restarts.
- **Separate implementation from review.** Planning, critique, implementation, deterministic tests, fresh-context review, documentation, and final review are distinct stages with immutable handoffs.
- **Fail closed at the merge boundary.** Review and validation bind to the full pull-request head resolved from Git, approval is one-use and expiring, and GitHub repository rules still apply.
- **Use BB's isolation model.** Threads isolate provider conversations and coordination; managed worktrees isolate branches, checkouts, and filesystem mutation.

## How it works

Hanoon has three layers:

| Layer | Responsibility |
| --- | --- |
| Telegram I/O | Poll the paired private chat, durably record input, and deliver drafts, status updates, confirmations, and final replies. |
| Durable control | Store owner pairing, project policies, controller turns, jobs, effects, attempts, approvals, liveness, and the outbox in plugin SQLite. |
| BB execution | Run the hidden controller and visible planning, implementation, review, documentation, validation, merge, deployment, and canary work. |

Ingress never starts a BB session. One generation-fenced executor owns controller dispatch, pipeline effects, and Telegram delivery. Reviewers are newly spawned BB threads with fresh provider conversations; they reuse the implementation environment only to inspect the same worktree.

## Architecture

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Hanoon architecture: private Telegram chat → I/O bridge → durable SQLite control plane → single leased executor → isolated BB controller and pipeline threads backed by a managed Git worktree" width="680">
</p>

Read the [architecture guide](docs/architecture.md) for diagrams, state ownership, and the exact BB thread/worktree boundary.

## Pipeline

<p align="center">
  <img src="docs/assets/reviewed-pipeline.svg" alt="Reviewed delivery pipeline: intake → plan → critique → build → test → fresh review → docs → final test and review → owner approval → merge → deploy → canary → complete, with bounded critique and patch loops" width="960">
</p>

Critique can request one replacement plan. Test or review failures return to a bounded patch/test/review cycle. Invalid evidence, stale pull-request heads, exhausted limits, unknown liveness, and expired approvals block instead of silently advancing.

The project policy chooses implementation/review providers and commands. The conversational controller is configurable independently and defaults to Codex Luna with maximum reasoning on the fast tier.

> [!WARNING]
> This is a full-trust BB plugin. An enabled project policy may run owner-authored validation, deployment, and canary commands and may request a BB-managed pull-request merge. Review the source and policy, keep GitHub protection enabled, and use a disposable repository for the first live run.

## Quick start

### 1. Install from a checkout

Requirements: BB `0.36` or newer, npm, an authenticated GitHub CLI on each project source host, a standard BB GitHub project, Codex access, and a Telegram bot from [BotFather](https://core.telegram.org/bots#botfather).

```bash
npm ci
npm run check
bb plugin install . --yes
bb plugin enable telegram-agent
bb plugin reload telegram-agent
```

### 2. Configure and pair

In **Extensions → Plugins → Telegram Agent**, enter the Telegram bot token in the secret setting. Choose the controller model, reasoning level, service tier, and permission mode on the same page.

```bash
bb telegram-agent pair
bb telegram-agent doctor
```

Open the sensitive, ten-minute pairing link from the intended owner's private Telegram chat.

### 3. Enable a project

Create a reviewed project policy, then enable and validate it:

```bash
bb telegram-agent project enable <project-id> --policy-file /absolute/path/to/policy.json
bb telegram-agent doctor <project-id>
```

The policy defines the exact GitHub repository/base branch, worker profiles, validation commands, required checks, redaction patterns, review limit, merge method, and optional deployment/canary commands. See [Configuration](docs/configuration.md) for the complete verified schema and examples.

### 4. Talk to Hanoon

Send a normal private message to Hanoon. It can answer conversationally, list enabled projects, report truthful BB thread progress, or create one guarded implementation job. Merge still requires the current one-use Telegram approval.

## Documentation

| Guide | Use it for |
| --- | --- |
| [Documentation index](docs/README.md) | Find operator, contributor, security, and design-history material. |
| [Architecture](docs/architecture.md) | Understand ownership, durability, review isolation, and worktree boundaries. |
| [Configuration](docs/configuration.md) | Install, pair, select a controller profile, and enable project policies. |
| [Operations](docs/operations.md) | Inspect, retry, cancel, rotate credentials, recover, and remove. |
| [Disposable live acceptance](docs/live-acceptance.md) | Prove the end-to-end pipeline without risking a production repository. |
| [Contributing](CONTRIBUTING.md) | Set up development and prepare a reviewable change. |
| [Security](SECURITY.md) | Report vulnerabilities and understand the trust model. |

## Repository layout

```text
telegram-bb-agent-plugin/
├── src/
│   ├── bb/           # BB thread, environment, handoff, validation, and merge adapters
│   ├── controller/   # Durable conversational controller and guarded native tools
│   ├── domain/       # Project policies, job state machine, review, and pipeline graph
│   ├── services/     # Leased executor, effects, review, merge, production, and liveness
│   ├── storage/      # SQLite migrations and transactional store
│   └── telegram/     # Telegram API client, ingress, errors, and bounded rendering
├── tests/            # Unit, integration, state-machine, and mocked end-to-end coverage
├── docs/             # Public guides plus design/implementation history
├── server.ts         # BB plugin entry point
└── package.json      # Plugin manifest and verification scripts
```

## Development

```bash
npm ci
npx vitest run tests/controller-service.test.ts
npm run check
bb plugin types --check .
```

`npm run check` runs TypeScript validation, the full Vitest suite, and `bb plugin build`. See [CONTRIBUTING.md](CONTRIBUTING.md) for change boundaries, documentation checks, and pull-request evidence.

## Project status

The repository currently declares version `0.1.0` and installs directly from a local path. The package is marked private and no public package or release channel is claimed.

A license has not been selected. Before publishing the repository as open source, the maintainer must add a license that states the intended reuse terms.
