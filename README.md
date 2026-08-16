# Hanoon

Hanoon is a private Telegram AI agent for BB. One paired owner runs their whole BB installation from a phone: ask questions, drive threads and machines, set monitors that follow up on their own, and ship code through a reviewed pipeline from planning to merge, deployment, and canary verification.

The installed plugin and CLI namespace remain `telegram-agent`.

## Why Hanoon?

- **Run BB from Telegram, not from BB.** Hanoon has the shell, the `bb` CLI, installed skills and MCP servers, and reach across every connected machine. A question or permission prompt it hits reaches you in Telegram; a block it cannot render into buttons is still reported, naming the thread and saying it needs you in BB.
- **It remembers, and keeps it honest.** Standing preferences, decisions, and corrections persist in SQLite with full-text recall. Correcting Hanoon devalues whatever misled it, notes it never uses fade, and a correction retires the belief it contradicts.
- **It learns from finished work.** When a job ends, Hanoon works out what is worth knowing about that repository next time — a check that always fails for a known reason, a convention it enforces — and keeps it per project.
- **It follows up by itself.** Any thread Hanoon starts or messages is watched until it lands, including threads it did not open; you can also set a monitor on a schedule. When one fires, Hanoon does the work and messages you. It also runs its own daily and weekly upkeep, and stays quiet when nothing needs you.
- **It works in parallel.** Independent questions go out to several BB threads at once and come back as one answer.
- **Conversations survive failures.** A dead provider session retires a BB thread, not the conversation. The replacement resumes with what was said and what was already done.
- **Pipeline workers recover safely.** Silent or missing workers are retired and the exact stage is retried only for failure signatures that have recovered before; unfamiliar failures still stop for you.
- **Mutations happen once.** Every mutating tool call is receipted by turn and argument hash, so a recovered agent replays the result instead of repeating the action.
- **Fail closed at the merge boundary.** Review and validation bind to the full pull-request head resolved from Git, approval is one-use and expiring unless the owner grants a project a standing approval, and GitHub repository rules still apply.
- **Use BB's isolation model.** Threads isolate provider conversations and coordination; managed worktrees isolate branches, checkouts, and filesystem mutation.

## How it works

Hanoon has three layers:

| Layer | Responsibility |
| --- | --- |
| Telegram I/O | Poll the paired private chat, durably record input, and deliver drafts, status updates, confirmations, and final replies. |
| Durable control | Store owner pairing, project policies, controller turns and conversation digest, memories, monitors, tool receipts, jobs, effects, approvals, liveness, and the outbox in plugin SQLite. |
| BB execution | Run the hidden controller and visible planning, implementation, review, documentation, validation, merge, deployment, and canary work. |

Ingress never starts a BB session; it claims each Telegram update durably before anything acts on it. One generation-fenced executor owns controller dispatch, monitors, pipeline effects, and Telegram delivery. That executor may run bounded pipeline lanes for independent projects, while durable project claims keep each project serialized. Reviewers are newly spawned BB threads with fresh provider conversations; they reuse the implementation environment only to inspect the same worktree.

Agent sessions run out of process as BB threads and never open the plugin database, so the single-writer SQLite store stays uncontended: state transitions, their effects, memory writes, and the conversation digest all commit in one transaction.

## What Hanoon can do

| Capability | What it means in the chat |
| --- | --- |
| Full BB control | "Restart that host", "what's on machine two" — the shell and `bb` CLI on any connected machine, under the configured permission mode. Installing or connecting an integration needs your decision first. |
| Live thread insight | "Why is this taking so long?" answers from the thread's current step, todo list, running commands, and latest message — not just its status. |
| Thread management | Open a thread to explore something, message a running one to answer its question or redirect it, stop or retry with a one-tap confirmation. |
| Memory | "Always deploy on weekday mornings" is kept and applied later. Ask what it knows, or tell it to forget. Secrets are refused, never stored. |
| Voice notes | Send a Telegram voice note or audio message. Hanoon durably queues transcription without storing the audio bytes, keeps later messages in order, and tells you plainly when transcription is unavailable or too long for one message. |
| Reference documents | File project or global specifications, search their passages, and give every pipeline stage a bounded structural map of what governs the work. |
| Working style | "Be terser" or "always show me the PR link" sticks, without a code change. It can shape tone and habits, never a safety boundary. |
| Parallel work | "Compare the invoice spike and the billing latency" opens both at once and answers from what comes back. |
| Self-maintenance | Daily stale-work and read-only repository audits, bounded cleanup of old allowlisted plugin temporary directories, a weekly memory audit, and a weekly scorecard. Off by one setting; disk-pressure warnings remain active. |
| Monitors | "Tell me when this finishes and open a PR", or "every weekday at 9, summarise the overnight runs." |
| Thread notices | Every top-level thread reports itself: you are told when one finishes or fails, and a thread blocked on a question or a permission prompt asks you in Telegram with buttons. A block it cannot render is still reported, so nothing waits on you in silence. |
| Answers you can check | Every reply is an accepted structured finalization backed by evidence gathered in that same turn. Raw model prose never becomes an answer, and a claim without compatible evidence is rejected rather than sent. |
| Steering you can see | When the agent messages a worker thread it must say, in one line, what it asked for and why. You cannot see the threads, so that line is carried back on the reply that closes the turn: an instruction given in your name is visible while it still matters, not discoverable later. |
| Reviewed delivery | A guarded job takes a change from plan to a reviewed pull request; merging and production still ask you in Telegram when those are set up. |
| Self-diagnosis | `/health` reports the executor, queued work, undelivered messages, monitors, memory, and database integrity — even when the agent is the stuck part. |
| Bounded turns | A question that runs away is nudged once to land the answer, then stopped before it burns your budget out of sight. |

## What an answer is

Every owner-visible reply is one accepted structured finalization, plus what the agent asked worker threads to do on that turn. Nothing else can become one:

- **Evidence in the same turn.** A claim about current state or completed work must reference evidence the agent gathered during that turn, with compatible proof kinds and a matching subject. Evidence is sealed at a high-water mark when the finalization is accepted, and an answer whose evidence advanced afterwards is refused rather than sent.
- **Raw prose reaches nothing.** Unstructured assistant prose never becomes a Telegram draft, a stored answer, a conversation digest, an outbox row, a finalization row, or a reply. BB still owns its own provider transcript. Drafts show one of the fixed phase lines, such as "Hanoon is thinking…", never partial output. The one exception is not prose: when BB blocks on a question or an approval, the provider's own prompt, options, and command are what the owner is being asked about, so they are carried through — each field bounded and credential-screened, and the whole interaction downgraded to an unanswerable notice if any field fails the screen.
- **What was asked in your name comes back.** Messaging a worker thread requires a one-line reason, recorded once the message has actually landed and owed to you until a reply states it. The reply is composed from that record rather than from anything the agent remembered to mention, so it cannot be skipped by wording. Because the record belongs to the agent rather than to one turn, an instruction sent by a turn that then dies is reported on the next reply instead of vanishing with it.
- **A bounded capability surface.** The controller runs against an enforced manifest of exactly 34 Hanoon capabilities. Denials are decided before any effect, and a stale executor fence or a stale approval is denied rather than retried.
- **Owner boundaries reach the phone.** A hidden-controller question or BB permission prompt is fetched from BB by exact identity, shown in Telegram, and answered by tap or plain reply. Approvals offer exactly *Allow once* and *Deny*; there is no session-wide grant on the hidden controller path. Your tap commits durably before BB is told, survives a restart, and is retried only for that exact resolution.
- **One logical reply, recoverable at-least-once transport.** The answer is one durable outbox obligation. Server-directed backoffs, transient failures known not to have sent, and uncertain brand-new sends remain on the same logical outbox row for bounded scheduler retries; an uncertain retry may duplicate the Telegram message, while edits retry against their stored message id. If uncertainty exhausts the retry budget, that same row becomes a vetted delivery-warning obligation with a fresh retry budget instead of disappearing silently. Enqueuing or attempting is never recorded as delivered.

## Credential broker foundation (disabled by default)

Hanoon carries the first slice of a separate credential broker: a protected service, run outside this plugin, that can hold a 1Password service-account token and answer only two fixed operations — a health check and a single vault-item resolve. **Credential broker mode defaults to `disabled`**, and the subsystem cannot be safely turned on until a real disposable 1Password account, a protected broker host, and the live acceptance run in [Disposable live acceptance](docs/live-acceptance.md) exist.

While it applies, this foundation only ever proves that the broker can reach a configured vault item — never that the resulting credential works for its application:

- `bb telegram-agent access list` and `bb telegram-agent access status [binding-id]` are the only operator commands, and they read local, secret-free metadata; there is deliberately no `access verify` or enrollment command in this CLI.
- The owner can ask Hanoon in Telegram to run a live verification of one known binding; a pass moves that binding to `vault_verified`, never `active`, and Hanoon never claims an application login succeeded from it.
- `bb telegram-agent doctor` reports one `credential broker` row, `disabled`, until isolated mode is configured, and one row per readiness check afterwards; see [Configuration](docs/configuration.md#credential-broker-foundation) and [Operations](docs/operations.md#credential-broker).

## Architecture

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Hanoon architecture: private Telegram chat → I/O bridge → durable SQLite control plane → single leased executor → isolated BB controller and pipeline threads backed by a managed Git worktree" width="680">
</p>

Read the [architecture guide](docs/architecture.md) for diagrams, state ownership, and the exact BB thread/worktree boundary.

## Pipeline

<p align="center">
  <img src="docs/assets/reviewed-pipeline.svg" alt="Reviewed delivery pipeline: intake → plan → critique → build → test → fresh review → docs → final test and review → owner approval → merge → deploy → canary → complete, with bounded critique and patch loops" width="960">
</p>

Critique can request one replacement plan. Test or review failures return to a bounded patch/test/review cycle. Full jobs require independent quality and risk reviews; small fixes still run deterministic validation plus one quality review. Existing open pull requests can be adopted with planning and critique recorded as skipped. Invalid evidence, stale pull-request heads, exhausted limits, novel worker failures, and expired approvals block instead of silently advancing.

The project policy chooses implementation/review providers and commands. The conversational agent is configured independently and defaults to Claude Opus 5 (1M) at `xhigh` reasoning. Claude and Codex models are both selectable; picking a model selects its provider. The concurrent-job cap defaults to `5`, accepts `1`–`8`, and applies to later admissions without cancelling work already admitted.

### Adaptive capability routing

New jobs are classified into one of six versioned recipes: `direct`, `bounded`, `bug`, `skill-authoring`, `adopted-pr`, or `architectural`. The job stores that recipe and its routing mode before admission. Every provider subject then gets an immutable least-capability profile, an exact provider/model/reasoning/service-tier tuple, and append-only selection and outcome receipts. Mandatory native adapters and review guards must settle before the authoritative state transition can advance.

The shipped rollout is conservative: adaptive recipes default to `shadow`, where candidate routing is observational and cannot control production behavior or manufacture success receipts. A recipe becomes active for new jobs only after an append-only promotion decision backed by a resolved durable evidence ledger. The production reader verifies recorded artifacts, an active post-merge job, failure/recovery chronology, and model trials against authoritative SQLite rows. This release exposes no operator or typed-envelope ingestion path and includes no trusted live collector, so a fresh installation cannot produce promotion evidence and no recipe is enabled merely because deterministic tests pass. See [Operations](docs/operations.md#capability-routing-and-rollout) for inspection and rollback commands.

## Bundled agent skills

The plugin bundles 26 skills locally across five manifest roots; no separate runtime skill installation is required. The workflow kit is pinned to Superpowers `6.3.0`, the discovery kit to `mattpocock/skills` `1.2.3` at a reviewed commit, and each root retains its own provenance and licence. Agents receive only the verified profile below.

| Verified context | Selected skill ids |
| --- | --- |
| controller | `human-friendly-coding-communication`, `proportional-development-workflow`, `grill-with-docs`, `grilling`, `domain-modeling` |
| planner | `human-friendly-coding-communication` |
| critic | `human-friendly-coding-communication` |
| implementation | `human-friendly-coding-communication`, `systematic-debugging`, `test-driven-development`, `verification-before-completion`, `clean-code-guard`, `test-guard`, `pr-writer` |
| review | `human-friendly-coding-communication`, `clean-code-guard`, `test-guard` |
| documentation | `human-friendly-coding-communication`, `docs-guard`, `verification-before-completion` |
| final-review | `human-friendly-coding-communication`, `clean-code-guard`, `test-guard`, `docs-guard` |
| validation, merge, deploy, canary | none; these stages remain deterministic |

Selection is fail-closed. Structurally, a worker must be from plugin `telegram-agent` with a non-fork origin, use a `standard` project and a `managed-worktree`, and have an anchored title of the form `Telegram <jobId> <role-token> <attemptId>`. Job ids are 1–256 characters from `[A-Za-z0-9_-]`; attempt ids are 1–264 characters from `[A-Za-z0-9_.:-]`. Durably, the exact `attempt:` or `stage:` record must match the title's job, attempt, and role, and its originating effect must be the corresponding `spawn_implementation`, `spawn_review`, `spawn_final_review`, `spawn_plan`, `spawn_critique`, or `spawn_docs` effect. The job project, persisted environment (when present), and persisted thread (when present) must match the current context. A null environment or thread is accepted only for the first start; a later context must match the persisted id. Any mismatch receives no tools and no skills; the hidden controller branch receives no worker skills.

The bundle is checked before it can run. `npm run skills:verify` validates the five registered roots, lock schema/provenance, bounded regular files, frontmatter names, nested local Markdown resources, and every SHA-256 file digest; it emits a bounded `bundleDigest` and skill count. `npm run build` runs this check before `bb plugin build`, and plugin activation runs it before registration. A missing, unlocked, escaped, oversized, symlinked, malformed, or digest-mismatched bundle stops build/activation. The runtime never downloads or repairs a replacement.

Only a maintainer synchronizes the pinned workflow kit from an already-reviewed local checkout. The source must be an absolute directory for the reviewed `superpowers` `6.3.0` package; synchronization is network-free and rewrites only the local bundle and lock:

```bash
WORKFLOW_KIT_SOURCE=/absolute/path/to/superpowers-6.3.0
npm run skills:sync -- --source "$WORKFLOW_KIT_SOURCE" --version 6.3.0
```

> [!WARNING]
> This is a full-trust BB plugin. Fresh or unset controller permission settings resolve to `auto`; an explicitly saved `auto`, `accept-edits`, or `full` value is preserved. BB-native permission prompts raised for the hidden controller can be bridged into Telegram as *Allow once* / *Deny*. Merging a pull request and promoting to production still require a Telegram approval from the owner — one-use, or standing for a project the owner explicitly granted — and an enabled project policy may run owner-authored validation, deployment, and canary commands. Review the source and policy, keep GitHub protection enabled, and use a disposable repository for the first live run.

## Quick start

### 1. Install from a checkout

Requirements: BB `0.36` or newer, npm, an authenticated GitHub CLI on each project source host, a standard BB GitHub project, access to Claude Code or Codex, and a Telegram bot from [BotFather](https://core.telegram.org/bots#botfather).

```bash
npm ci
npm run check
bb plugin install . --yes
bb plugin enable telegram-agent
bb plugin reload telegram-agent
```

### 2. Configure and pair

In **Extensions → Plugins → Telegram Agent**, enter the Telegram bot token in the secret setting. The model, reasoning level, service tier, permission mode, and maximum concurrent jobs are on the same page; the defaults are ready to use.

```bash
bb telegram-agent pair
bb telegram-agent doctor
```

Open the sensitive, ten-minute pairing link from the intended owner's private Telegram chat.

### 3. Enable a project

Create a reviewed project policy, then enable and validate it:

```bash
bb telegram-agent project enable proj_7f3d2a91 --policy-file /absolute/path/to/policy.json
bb telegram-agent doctor proj_7f3d2a91
```

The policy defines the exact GitHub repository/base branch, worker profiles, validation commands, required checks, redaction patterns, review limit, merge method, and optional deployment/canary commands. Projects that deploy to the same target can share `production.targetKey`, which serializes that target even when their repositories differ. See [Configuration](docs/configuration.md) for the complete verified schema and examples.

Self-diagnosis is off by default. To enable it, set the boolean `selfDiagnosisEnabled` to `true`, set `selfDiagnosisProjectId` to the enabled project containing this checkout, and reload the plugin. It runs out of band and creates only cooled-down draft pull requests; it never merges or changes an existing pull request.

### 4. Talk to Hanoon

Send a normal private message. Hanoon answers conversationally, and acts when asked. Screenshots, GIFs, and short videos are part of the same turn — clips are sampled into stills the agent can see.

```text
what's running right now?
why is the billing thread taking so long?
open a thread on cyndra to look into the invoice spike
tell me when it's done and summarise what changed
always deploy parknwash on weekday mornings
/health
```

Recovery commands remain available without the agent: `/status`, `/projects`, `/health`, `/approvals`, `/resume`, `/retry [job-id]`, `/cancel [job-id]`. `/status` lists current jobs; replying to a job status message or supplying its id selects that exact job. `/approvals` lists the projects that merge without asking, and `/approvals off [alias]` withdraws that. `/resume [alias]` restarts a project the failure brake stopped. Merging still requires a Telegram approval: one-use, or standing where the owner granted it.

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
hanoon/
├── src/
│   ├── bb/           # BB thread, environment, handoff, validation, and merge adapters
│   ├── controller/   # Durable conversational controller and guarded native tools
│   ├── domain/       # Project policies, job state machine, review, and pipeline graph
│   ├── services/     # Leased executor, effects, review, merge, production, and liveness
│   ├── storage/      # SQLite migrations and transactional store
│   └── telegram/     # Telegram API client, ingress, errors, and bounded rendering
├── tests/            # Unit, integration, state-machine, and mocked end-to-end coverage
├── skills/           # Vendored skill bundle: workflow kit, guards, and pr-writer
├── evals/            # Golden answers for the opt-in response-quality check
├── docs/             # Public guides plus design/implementation history
├── server.ts         # BB plugin entry point
└── package.json      # Plugin manifest and verification scripts
```

## Development

```bash
npm ci
npm run typecheck
npm run skills:verify
npm run build
bb plugin types --check .
```

Type checking resolves `@bb/plugin-sdk` through `types/bb-plugin-sdk.d.ts`, which `bb plugin types` regenerates from your installed BB. Building needs only the `bb` CLI.

> [!NOTE]
> The test suite additionally imports `@bb/plugin-sdk/testing` at runtime. BB does not publish that package to a registry, so `npm test`, and therefore `npm run check`, only works where the package is installed. `npm run check` runs typecheck, tests, the plugin build, artifact verification, and the credential-broker TypeScript build. Type checking and building work from a clean clone.

See [CONTRIBUTING.md](CONTRIBUTING.md) for change boundaries, documentation checks, and pull-request evidence.

## Project status

Version `0.1.0`, installed directly from a checkout. There is no package registry or release channel. The repository is licensed under the [MIT License](LICENSE).
