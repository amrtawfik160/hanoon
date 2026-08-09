# Telegram BB Agent Plugin Design

Status: approved for implementation planning

Date: 2026-08-09

Package: `bb-plugin-telegram-agent`

Plugin id: `telegram-agent`

## Outcome

Build a native, headless BB plugin that lets one paired owner control an end-to-end software task from a private Telegram chat. The owner can describe a bug, choose an enabled BB project, confirm the task, watch live progress, and approve a GitHub pull-request merge.

For every task, the plugin creates an implementation thread in an isolated BB worktree, then creates a separate review-and-test child thread in the same environment. Review failures return to the implementation thread and trigger a fresh review. A merge button appears only after deterministic git, test, pull-request, and required-check gates pass. Tapping Merge revalidates the exact pull-request head before using BB's pull-request merge operation.

## Goals

- Accept natural-language software tasks from the paired Telegram owner.
- Let the owner choose an explicitly enabled BB project for each task.
- Run implementation in an isolated BB worktree and produce a GitHub pull request.
- Run review and testing in a separate, fresh BB thread with the same environment.
- Remediate actionable review findings, with a default maximum of three review cycles.
- Show concise, human-readable progress in one editable Telegram status message.
- Require an explicit, expiring Telegram approval before merge.
- Revalidate all merge gates at approval time and fail closed on drift.
- Recover deterministically after plugin, BB server, Telegram, or provider interruption.
- Keep worker threads visible in BB so the owner can inspect exact activity and output.

## Non-goals for V1

- Supporting Telegram groups, channels, or multiple owners.
- Executing arbitrary shell commands received from Telegram.
- Managing non-Git projects or repositories without a GitHub pull-request workflow.
- Automatically deploying after merge.
- Replacing BB's thread UI, provider configuration, machine permission limits, or GitHub branch protection.
- Running more than one active Telegram-controlled job at a time.
- Providing a custom BB frontend panel. Operator configuration is exposed through plugin settings and a `bb telegram-agent` command.

## Settled product decisions

- The merge target is a GitHub pull request, not a direct local-branch merge.
- Work and review threads are visible in BB.
- The plugin uses Telegram long polling, so BB does not need a public webhook.
- Project selection happens per task through an inline Telegram picker.
- A human Telegram approval is mandatory for every merge.
- V1 uses one paired Telegram account in a private chat.
- The native plugin owns orchestration directly; it does not depend on the BB Workflows plugin.

## Architecture

```text
Telegram private chat
        |
        v
BB Telegram Agent plugin
  |- Telegram long-poll service
  |- pairing, authorization, and callback validation
  |- durable SQLite job state and Telegram outbox
  |- idempotent orchestration state machine
  |- BB thread and environment adapter
  |- deterministic validation and merge gates
        |
        |- visible implementation thread
        |     `- isolated BB worktree and GitHub PR
        |
        |- visible review/test child thread
        |     `- same environment, fresh provider conversation
        |
        |- remediation message to implementation thread
        |     `- fresh review child after every change
        |
        `- Telegram Merge approval
              `- fresh gate evaluation and BB PR merge
```

The package initially declares only `bb.server`. It uses these native BB plugin surfaces:

- `bb.settings` for the secret Telegram bot token and simple global settings;
- `bb.storage.database()` and append-only migrations for durable state;
- `bb.background.service()` for Telegram ingress and job reconciliation/outbox delivery;
- `bb.sdk.threads` to spawn and steer threads;
- BB environment, terminal, file, and pull-request SDK surfaces for deterministic inspection and validation;
- `bb.events.on()` for immediate thread lifecycle reactions;
- `bb.cli.register()` for pairing, project policy, job inspection, retry, and cancellation;
- `bb.status.needsConfiguration()` when the bot token is absent.

The implementation must run `bb plugin types` before coding against the BB SDK and use the generated declarations as the exact API contract. It must not guess SDK method names from this design document.

## Module boundaries

### `server.ts`

Defines settings, opens storage, registers the two services, lifecycle handlers, and the operator CLI. It contains wiring only; orchestration decisions stay in pure modules.

### `telegram-client.ts`

Implements the narrow Telegram Bot API surface required by V1: `getUpdates`, `sendMessage`, `editMessageText`, and `answerCallbackQuery`. It applies request timeouts, bounded exponential backoff, Telegram `retry_after`, and an abort signal on plugin reload or shutdown.

### `pairing.ts`

Creates a cryptographically random, single-use pairing code through the CLI. Only a `/start <code>` message in a private chat can consume it. The database stores a hash, ten-minute expiry, and consumed timestamp rather than the plaintext code. A successful pairing records the numeric Telegram user and private-chat ids.

### `job-store.ts`

Owns append-only SQLite migrations and transactional persistence for project policies, jobs, attempts, Telegram updates, callbacks, approval nonces, and outbound messages. No growing job data is stored in the 256 KB plugin key-value store.

### `orchestrator.ts`

Implements a pure, idempotent state machine. A transition takes the durable job snapshot plus a typed event and returns a new snapshot and explicit effects. Effects have durable idempotency keys before external execution.

### `bb-runner.ts`

Creates the implementation worktree/thread, creates review children in the same environment, sends remediation findings back to the implementation thread, reads live thread state, and resolves the environment and pull request. It does not decide whether a merge is safe.

### `review-contract.ts`

Validates the reviewer's final response as one strict JSON object. Malformed output can never be interpreted as approval.

### `validation-runner.ts`

Runs owner-configured validation commands sequentially on the BB environment's owning host with per-command timeouts. It records the exact command label, exit status, bounded output summary, and commit SHA. It obtains git state through BB's environment-scoped surfaces and GitHub PR/check state through the authenticated `gh` CLI on that same host. Commands are configuration entered by the BB owner, never Telegram text. The implementation must never resolve an environment path with server-local `node:fs`.

### `merge-gates.ts`

Evaluates the complete, fresh merge predicate and returns either a typed ready receipt or explicit blocking reasons. The ready receipt binds the job, project, environment, PR, base branch, exact head SHA, review attempt, validation receipt, required checks, and expiry.

### `project-policy.ts`

Validates enabled-project configuration: BB project id, display alias, base branch, validation commands, required GitHub checks, implementation and review execution settings, maximum review cycles, and merge method.

### `telegram-view.ts`

Projects durable job state into Telegram text and inline buttons. Rendering is deterministic and contains no orchestration logic.

## Durable data model

The initial schema contains the following logical records:

- `owner`: paired Telegram user id, chat id, pairing timestamp, and revocation timestamp.
- `pairing_codes`: code hash, expiry, consumed timestamp, and creation metadata.
- `project_policies`: BB project id, alias, enabled flag, base branch, serialized validated execution policy, and version.
- `jobs`: immutable request text plus current state, project id, environment id, implementation thread id, current review thread id, PR identity, exact head SHA, status-message id, timestamps, and version.
- `attempts`: job id, kind (`implementation`, `review`, or `validation`), ordinal, thread id, head SHA, structured result, and timestamps.
- `telegram_updates`: Telegram update id and processed outcome for ingress deduplication.
- `callbacks`: callback-query id, action, job id, outcome, and processed timestamp.
- `approvals`: nonce hash, job id, bound head SHA, expiry, consumed timestamp, and outcome.
- `outbox`: logical message key, target chat/message, desired payload, attempt state, next-attempt time, and last error.

Every job mutation uses an optimistic version or a transaction that checks the expected current state. External effects are safe to retry because their logical idempotency key is written first.

## Job state machine

```text
draft
  -> awaiting_project
  -> awaiting_confirmation
  -> creating_implementation
  -> implementing
  -> locating_pr
  -> reviewing
  -> remediating -> reviewing
  -> validating
  -> awaiting_merge_approval
  -> merging
  -> merged
```

Terminal alternatives are `cancelled` and `blocked`. `failed` is a recoverable stage outcome that records the error and exposes Retry or Stop; it is not treated as success.

Key transition rules:

1. A plain private-chat message starts a draft only when no job is active.
2. The project picker lists only enabled standard Git projects. Remembering the last choice only changes ordering; it never skips confirmation.
3. Start creates one isolated worktree from the configured base branch and one visible implementation thread.
4. Implementation idle does not imply success. The plugin reconciles the environment and PR before review.
5. Review always uses a new visible child thread with the implementation environment id and a fresh provider conversation.
6. `changes_requested` returns structured findings to the implementation thread. A later idle transition must produce a new head SHA before another review can pass.
7. Three unsuccessful review cycles block by default. Continue authorizes another bounded set; Stop cancels the job.
8. Reviewer `pass` proceeds to independent deterministic validation. It does not itself unlock merge.
9. Validation success produces a merge-ready receipt and a one-use Telegram approval.
10. Approval re-runs the entire gate against live state. Drift returns to review or validation as appropriate.
11. A successful merge records the merge commit before Telegram reports completion.

Lifecycle events make normal transitions immediate. On service startup and periodically while work exists, the reconciler reads current thread/environment state so a missed event cannot strand a job.

## Telegram interaction model

### Pairing and operator setup

1. The BB owner enters the bot token through the plugin's secret setting UI.
2. `bb telegram-agent pair` creates a ten-minute, one-use `/start` link.
3. The owner sends the link to the bot in a private Telegram chat.
4. The plugin records the Telegram numeric identities and invalidates the code.
5. `bb telegram-agent project enable <project-id> ...` enables each allowed project and its policy.

All other users, chats, groups, and channels receive no project information and cannot create or control jobs.

### Task flow

1. Owner: `Fix the login redirect loop and add a regression test.`
2. Bot: inline picker of enabled projects, last-used project first.
3. Bot: confirmation showing project, base branch, requested outcome, and Start/Cancel.
4. Bot creates one durable status message and edits it through the job lifecycle.

The status message includes the current stage, relevant BB thread ids/links when a configured BB app base URL can produce them, current review cycle, concise findings or blockers, PR link, test/check summary, and abbreviated commit SHA. It must not expose tokens, raw provider prompts, environment secrets, or unbounded logs.

When a job is active, only a reply to that job's status message is treated as follow-up steering. Standalone text is rejected with guidance, preventing accidental routing to the wrong thread. `/status`, `/cancel`, `/retry`, `/projects`, and `/help` are supported. Destructive actions always use inline confirmation.

### Ready-to-merge message

The final card shows:

- project and base branch;
- PR number, title, and URL;
- exact abbreviated head SHA;
- changed-file and diff-stat summary;
- implementation thread and latest review thread;
- reviewer verdict and finding count;
- validation commands with outcomes;
- required GitHub checks;
- approval expiry.

Buttons are View PR, Open BB when available, Re-run Review, Merge, and Cancel. Merge is never the default action.

## Thread contracts

### Implementation thread

The implementation prompt contains the exact user request, selected project/base branch, scope and safety rules, expected PR workflow, validation policy, and required final report. It asks the agent to investigate, implement the narrow fix, add appropriate regressions, run checks, commit all intended changes, push the branch, and create or update a PR. It must report changed files, tests, PR identity, commit SHA, and blockers.

The plugin uses the project's configured BB execution settings and never silently widens the machine or project permission policy. If those settings cannot push or create a PR, the job blocks with an operator-facing configuration error.

### Review thread

The review thread receives the original request, base and head SHAs, PR identity, current diff, project validation policy, and an explicit instruction not to edit source, commit, push, or merge. It inspects the complete diff and runs the requested tests. The plugin compares git state before and after review; reviewer mutation invalidates the attempt.

The final output must be exactly this semantic shape:

```json
{
  "verdict": "pass | changes_requested | blocked",
  "reviewedHeadSha": "full git sha",
  "summary": "concise result",
  "findings": [
    {
      "severity": "critical | high | medium | low",
      "file": "repository-relative path or null",
      "line": 1,
      "title": "finding title",
      "details": "evidence and required change"
    }
  ],
  "checks": [
    {
      "name": "check label",
      "command": "command or null",
      "outcome": "passed | failed | blocked",
      "exitCode": 0,
      "summary": "bounded evidence"
    }
  ]
}
```

`line` and `exitCode` may be null when not applicable. The implementation schema will express those nullable fields explicitly. A pass requires the exact current head SHA, zero actionable findings, and no failed or blocked checks. Invalid JSON triggers one format-correction turn; a second invalid result blocks the attempt and creates no approval.

## Merge gates

The plugin exposes Merge only when one fresh evaluation proves all of the following:

1. The implementation thread is idle rather than failed or interrupted.
2. The environment belongs to the selected project and expected worktree.
3. Repository HEAD equals the PR head SHA.
4. The PR targets the configured base branch, is open, non-draft, and mergeable.
5. The worktree has no uncommitted tracked or untracked changes.
6. The latest schema-valid review is `pass` for the exact head SHA.
7. The review attempt did not mutate the worktree.
8. Every project-policy validation command independently exited successfully for the exact head SHA.
9. Every configured required GitHub check is successful for the exact head SHA.
10. No newer implementation, review, validation, cancellation, or approval event exists.

The approval nonce is random, one-use, stored only as a hash, bound to the job and full head SHA, and expires after fifteen minutes. The callback is accepted only from the paired user and chat. It transactionally consumes the nonce before attempting merge.

At click time, the plugin evaluates all ten gates again. A changed SHA invalidates the receipt and schedules a fresh review. A pending check returns to validation. A closed, conflicting, or non-mergeable PR blocks. The merge request uses BB's core pull-request merge surface, respects repository branch protection, and records the returned merge result. It does not shell out to `git merge` on the default branch.

## Security model

- Bot tokens are secret BB settings and are never stored in SQLite, logs, Telegram messages, or prompts.
- Only one paired numeric Telegram user id in its paired private chat is authorized.
- Pairing codes are random, hashed, single-use, and short-lived.
- Telegram update ids, callback-query ids, and approval nonces are deduplicated durably.
- Telegram text is treated as task content, never as a command line or project identifier.
- The project picker reveals only explicitly enabled projects.
- Project policies are writable only from the local/authorized BB CLI, not Telegram.
- All SQL uses prepared statements. All runtime JSON is schema-validated.
- Logs redact bot tokens, pairing codes, Telegram message bodies beyond bounded diagnostics, provider secrets, and command output that matches configured secret redactions.
- The plugin does not bind BB to `0.0.0.0`; long polling needs only outbound HTTPS.
- Plugin code is full-trust and must be installed only from the owner-controlled repository.
- Agent permissions remain bounded by BB project defaults and machine maximums. The plugin cannot override the machine's permission ceiling.

## Failure handling and recovery

- Telegram timeouts retry with jittered exponential backoff; HTTP 429 honors `retry_after`.
- The update offset advances only after the update has a durable deduplication record.
- Outbound status is a desired-state projection. Re-sending edits the same message instead of creating progress spam.
- A plugin reload aborts both services cleanly. On restart, reconciliation resumes every nonterminal job from live BB state.
- Thread failure or interruption records stage, provider error, and available output, then offers Retry or Stop.
- A missing PR returns the task to the implementation thread with an exact request to create or identify it.
- Test failure and review findings return structured feedback to implementation.
- Merge conflict, branch-protection rejection, GitHub unavailability, or a changed head fails closed and never reports success.
- If Telegram delivery fails after a successful merge, the durable merged state and outbox cause later delivery; merge is not repeated.
- Cancellation revokes approvals, asks BB to stop an active worker turn, and marks the job cancelled only after the worker is idle or interrupted. If BB cannot confirm the stop, the job remains blocked rather than pretending cancellation succeeded. Cancellation never archives threads or deletes a worktree, branch, or PR automatically.

## Operator CLI

One plugin command, `bb telegram-agent`, provides:

- `pair` and `unpair`;
- `project list`;
- `project enable <project-id>` with policy flags or a policy JSON file;
- `project disable <project-id>`;
- `job list` and `job show <job-id>`;
- `job retry <job-id>` and `job cancel <job-id>`;
- `doctor` for token presence, pairing, project policy, BB project/source, provider, machine, GitHub CLI/auth, and merge-surface checks.

Every collection command is bounded and supports JSON output. CLI metadata includes clear summaries and usage lines so BB agents discover it through the generated plugin-commands skill.

## Verification strategy

### Unit and component tests

Use `@bb/plugin-sdk/testing` with a real temporary SQLite database and mocked BB SDK methods. Mock Telegram at the HTTP boundary. Tests cover:

- settings and needs-configuration behavior;
- one-use pairing, expiry, unauthorized users, and non-private chats;
- project allowlist and confirmation;
- every valid and invalid state transition;
- implementation creation attribution and environment selection;
- lifecycle-event handling plus restart reconciliation;
- duplicate Telegram updates, duplicate idle events, callback replay, and outbox retry;
- reviewer JSON validation, wrong SHA, findings, malformed output, and reviewer mutation;
- validation command success, timeout, nonzero exit, and bounded output;
- clean and dirty worktrees;
- missing/draft/closed/conflicting PRs and wrong base branches;
- pending, failed, and changed-head GitHub checks;
- expired/stale/consumed merge approval;
- merge failure and success followed by Telegram-delivery failure;
- service abort and plugin reload without duplicate work.

Pure state-machine, gate, and rendering modules receive exhaustive table tests. Random identifiers and clocks are injected for deterministic tests.

### Live BB acceptance test

Use a disposable test repository or disposable branch where merging is safe:

1. Configure the bot and pair the owner.
2. Enable exactly the test project.
3. Submit a small bug-and-regression task from Telegram.
4. Verify a visible implementation thread and isolated environment appear.
5. Verify a visible child review thread uses the same environment.
6. Force one review failure and verify remediation plus a fresh review.
7. Reach Ready to merge and record the approval head SHA.
8. Push a new commit before clicking Merge and verify stale approval is rejected.
9. Complete fresh review and validation.
10. Approve Merge in Telegram and verify the remote PR merged at the approved SHA.
11. Restart the plugin during a separate test job and verify recovery without duplicate threads or messages.

No production application repository is used for destructive acceptance testing.

## Acceptance criteria

- An unauthorized Telegram identity cannot list projects, start work, steer a thread, approve, cancel, or merge.
- A paired owner can choose an enabled project and start a confirmed task without opening BB.
- BB shows a visible implementation thread and a separate visible review child in the same worktree environment.
- Review findings return to implementation and a later attempt uses a fresh review thread.
- Telegram shows one continuously updated status message with accurate stage and evidence.
- No merge button appears from assistant prose alone or while any deterministic gate is incomplete.
- A merge approval is one-use, expires, and is invalidated by any head change.
- The plugin merges only through BB's PR merge surface after fresh validation and reports the actual merge result.
- Restart, duplicated updates, and callback replays do not duplicate implementation threads, review threads, or merges.
- Automated tests and the disposable live acceptance flow pass.

## Alternatives considered

### Telegram plugin plus BB Workflows

This would make the orchestration graph reusable, but adds another durable runtime and a plugin-to-workflow handoff without improving the V1 single-owner flow. The native state machine keeps task identity, approvals, and recovery in one transactional store. The module boundaries leave room to adopt Workflows later.

### External Telegram service plus BB bridge plugin

This is useful for a multi-tenant service controlling many BB servers, but requires another public deployment and authentication boundary. Long polling inside one owner-controlled plugin is smaller and safer for V1.

### Telegram webhook into BB

This removes polling but requires a publicly reachable, signature-verified endpoint. BB Connect shares are owner-session-gated and are not a Telegram webhook transport. Long polling avoids exposing the BB server.

### Automatic merge

Even strict automated gates cannot express every product or operational concern. The approved design therefore requires an explicit Telegram merge action and revalidates the exact head at click time.
