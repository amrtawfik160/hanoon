# Telegram Luna Controller Design

Status: approved for implementation planning

Date: 2026-08-10

Package: `bb-plugin-telegram-agent`

Plugin id: `telegram-agent`

## Outcome

Upgrade the Telegram BB Agent from deterministic task intake into a conversational BB controller powered by Codex `gpt-5.6-luna` at `max` reasoning. Every authorized ordinary Telegram message goes to one durable Luna controller thread for the paired private chat. Luna decides whether to answer conversationally, ask a clarifying question, inspect an existing job, or start a guarded software job.

The existing leased executor remains the only execution engine. Luna may create durable job intent through narrow native plugin tools, but it may not spawn implementation or review worktrees, validate a pull request, approve a merge, or merge directly. Implementation, fresh-context review, testing, authoritative Git head validation, Telegram merge approval, and merge remain deterministic plugin-owned stages.

## Current failures addressed

This design includes the two live failures observed during acceptance:

1. Implementation spawn currently constructs a managed-worktree environment without `hostId`. The live BB server rejects it with `HTTP 400: hostId is required unless workspace.type is personal`.
2. Telegram API failures currently preserve only the numeric status (`Telegram API 400`) and discard Telegram's `description`. Callback and status-message failures therefore crash or back off without an actionable reason.

The current ingress also routes ordinary text directly into the task state machine. It has no provider-backed conversational thread, so it cannot satisfy the Luna controller requirement without this architectural change.

## Product decisions

- Every authorized ordinary Telegram message is conversational input to Luna. No `/run` prefix is required.
- The controller uses provider `codex`, model `gpt-5.6-luna`, reasoning level `max`, and permission mode `auto` explicitly. It does not inherit a different remembered model.
- One durable hidden controller thread exists per paired Telegram private chat.
- Luna automatically starts a coding job only after it has an unambiguous task and enabled project. Otherwise it asks a concise clarifying question.
- A controller-started job skips the old Start confirmation because Luna has already resolved the intent. The existing mandatory, expiring Telegram approval before merge remains unchanged.
- Project implementation and review profiles remain policy-controlled. They may use Luna or other configured providers/models.
- The controller does not receive a project checkout. It runs in BB's personal workspace on an explicitly resolved host.
- Worktrees remain the code and filesystem isolation boundary. BB thread isolation supplies provider-conversation, history, lifecycle, identity, permission, visibility, and parent-child coordination; it does not replace worktrees.
- Only one active software job is allowed in V1. Luna reports the current job or asks the owner to cancel it before starting another.

## Architecture

```text
Telegram private chat
        |
        v
long-poll ingress (I/O only)
  |- authenticate paired private chat
  |- deduplicate Telegram update
  `- enqueue durable controller turn or command/callback input
        |
        v
single leased executor
  |- dispatch queued turn to durable hidden Luna Max BB thread
  |- reconcile controller thread lifecycle and output
  |- deliver responses through Telegram outbox
  `- execute existing deterministic software-job effects
        ^
        |
Luna controller native tools
  |- list enabled projects
  |- start guarded job intent
  |- inspect current/recent job
  |- retry recoverable job
  `- request job cancellation
        |
        v
existing job pipeline
  implementation worktree/thread
        -> fresh review/test thread in the same worktree
        -> deterministic validation
        -> two matching git ls-remote PR-head reads
        -> expiring Telegram approval
        -> one BB pull-request merge
```

The long-poll service never calls BB thread, environment, terminal, file, GitHub, or merge APIs. Native controller tools only commit durable intent to SQLite. The leased executor is the only component that calls BB to spawn or send agent work.

## Controller thread contract

### Creation

The executor discovers the singleton BB personal project with `projects.list({ includePersonal: true })`, resolves its default source host, and creates the controller with:

- the personal project id;
- `environment: { type: "host", hostId, workspace: { type: "personal" } }`;
- `providerId: "codex"`;
- `model: "gpt-5.6-luna"`;
- `reasoningLevel: "max"`;
- `permissionMode: "auto"`;
- explicit `executionInputSources` for provider, model, reasoning, and permission;
- `visibility: "hidden"`;
- a stable title containing a non-secret controller key.

The controller key is derived from the paired owner/chat identity and is used to reconcile an uncertain spawn. A pending spawn record is written before the SDK call. If the process stops after BB creates the thread but before SQLite records the returned id, reconciliation searches plugin-origin hidden personal threads for the exact controller title and adopts the single match. Multiple matches fail closed and notify the operator; the executor does not start another controller blindly.

If the mapped thread is deleted or archived, the next message creates a fresh controller thread and the bot tells the owner that conversational context restarted. A failed turn does not automatically create a second thread.

### Conversation order and recovery

Controller turns are durable and FIFO. At most one turn per controller thread is in `submitted` state. Later Telegram messages remain queued until the thread returns to idle or failed, preserving response correlation without steering an active provider turn.

For an existing idle controller, the executor uses `threads.send` with mode `start`. It records a dispatch claim before the SDK call. An executor restart while delivery is uncertain fails that turn closed and asks the owner to resend rather than risking duplicate model input.

`thread.idle` completes the oldest submitted turn and enqueues `lastAssistantText` in the durable Telegram outbox. If the lifecycle event is missed, periodic reconciliation observes the mapped BB thread as idle and reads `threads.output`. `thread.failed` records a bounded error and produces a recoverable Telegram response. Events for implementation or review threads are never mistaken for controller responses because controller thread ids have a separate durable mapping.

BB thread status is the authoritative provider liveness signal. The executor-owned lease heartbeat remains the authoritative plugin-worker liveness signal. The plugin does not infer either signal from Telegram activity, Git changes, or assistant text.

### Controller instructions

The controller receives standing instructions that:

- identify it as the paired owner's Telegram-facing BB controller;
- prefer a normal concise conversational answer when no software action is required;
- use only the registered Telegram Agent tools to start, retry, cancel, or inspect guarded jobs;
- ask for the project when more than one enabled project could match;
- never use shell or BB CLI to spawn implementation/review sessions or perform a merge;
- never claim that tests, review, merge, or deployment succeeded without the tool-reported durable job state;
- explain that merge requires the owner's Telegram approval;
- keep secrets, raw prompts, unbounded logs, and internal callback data out of replies.

## Native controller tools

The plugin registers the following schema-validated tools:

### `telegram_agent_list_projects`

Returns enabled project ids, aliases, base branches, and configured implementation/review model labels. It never returns filesystem paths, tokens, or repository credentials.

### `telegram_agent_start_job`

Input: `{ projectId: string, task: string }`.

Execution checks the exact calling `threadId` against the durable controller mapping, checks the paired owner/chat, validates the enabled policy, enforces the single-active-job rule, bounds the task text, and atomically creates a confirmed job plus its first executor effect. The tool cannot spawn a BB thread itself.

### `telegram_agent_job_status`

Input: `{ jobId?: string }`.

Returns a bounded projection of the current or requested job: state, project alias, worker/review ids, PR identity, abbreviated authoritative head, validation outcome, merge-approval state, and blocker. It returns no stored raw logs.

### `telegram_agent_retry_job`

Input: `{ jobId: string }`.

Applies the same recoverable-state checks as the existing `/retry` command and enqueues reconciliation. It cannot retry terminal or merge-complete jobs.

### `telegram_agent_cancel_job`

Input: `{ jobId: string }`.

Records a cancellation request through the existing cancellation fencing. It does not report cancellation complete until the active worker is authoritatively stopped or already terminal.

Agent configuration selects these tools only for Codex threads that are plugin-origin, hidden, in the personal project, and later confirmed by the execution-time controller mapping. Implementation and review threads never receive them.

## Durable data additions

Append-only SQLite migrations add:

- `controller_threads`: paired user/chat identity, controller key, BB project/host/thread ids, lifecycle state, pending spawn token, last error, and timestamps;
- `controller_turns`: Telegram update id, controller key, bounded input text, FIFO ordinal, state (`queued`, `dispatching`, `submitted`, `completed`, or `failed`), executor lease owner/generation, response, error, and timestamps.

The existing `telegram_updates` table remains the ingress deduplication authority. Existing `jobs`, `effects`, `executor_lease`, `worker_liveness`, and `outbox` remain the software-job authority. Controller state is separate from jobs so a durable conversation survives multiple completed jobs and does not disappear when a provider process exits.

All controller mutations use transactions and expected states. Raw bot tokens and API credentials are never stored in these tables.

## Software-job integration

Controller-started intent enters the existing state machine at `creating_implementation` with an immutable enabled policy snapshot. It creates the same implementation attempt and deterministic effects as an accepted Start callback. Commands and callbacks remain supported for operator recovery and merge approval.

Before spawning a managed worktree, the executor resolves the selected standard project's live default source and verifies its connected host. `BbRunner.spawnImplementation` passes that exact `hostId` in the host environment request. Missing, disconnected, or changed source identity blocks the job with a configuration error; it never falls back to a different machine.

Review remains a new `threads.spawn` child in the implementation environment, never a fork. This preserves a fresh provider conversation while reusing the same code/filesystem state. The controller thread is neither parent nor source of the review thread.

The merge gate continues to resolve the PR head from Git, not the GitHub API. It requires two matching results from `git ls-remote --exit-code origin refs/pull/<number>/head` around fresh validation and rejects any drift.

## Telegram error handling

`TelegramApiError` preserves the HTTP status, Telegram numeric error code, sanitized `description`, and optional `retry_after`. Token values and request bodies are never included.

Error classification is explicit:

- `message is not modified` is success for status edits;
- an expired or invalid callback query is terminal for that callback answer and does not crash ingress;
- a status message that cannot be edited falls back to one new `sendMessage`, then atomically replaces the stored status-message id;
- rate limits honor Telegram `retry_after`;
- authentication/configuration errors move the plugin to actionable degraded or needs-configuration state;
- malformed HTML/entity errors are retried once with plain text and no parse mode;
- other retryable transport/server errors use bounded backoff;
- permanent 4xx failures are dead-lettered with their sanitized description and do not crash the long-poll loop.

Callback acknowledgement is best effort after durable callback claiming. An expired acknowledgement cannot undo an already-committed action and is never retried indefinitely.

## Thread isolation and worktree isolation

BB thread isolation gives each role a durable BB identity, separate provider conversation and context window, independently inspectable history/output/status/interactions, its own execution settings and permission resolution, visibility policy, origin attribution, and parent-child coordination. The separate review thread therefore cannot inherit the implementation provider transcript and is less likely to rubber-stamp it.

Environment ownership binds each implementation/review thread to the intended host and workspace. The review child reuses the implementation environment intentionally. The controller uses a personal workspace and never receives the implementation worktree.

Worktrees remain the code isolation boundary: branch, checkout, uncommitted files, build artifacts, and filesystem mutations are isolated by the managed worktree. Two threads that reuse one environment see the same files even though their provider conversations are isolated. Conversely, separate threads alone do not prevent filesystem conflicts. This plugin uses both boundaries for their distinct purposes.

## Testing

Implementation follows red-green TDD and adds focused tests for:

- live-shaped managed-worktree spawn requiring the project's resolved `hostId`;
- Luna controller spawn arguments, including exact provider/model/reasoning/permission and personal host workspace;
- tool selection limited to controller candidates and execution-time thread authorization;
- controller FIFO dispatch, idle response delivery, missed-event reconciliation, failure recovery, and uncertain-dispatch fail-closed behavior;
- controller job creation using the existing confirmed-job transition without bypassing merge approval;
- single-active-job enforcement and invalid project/tool caller rejection;
- deleted/archived controller replacement without duplicate concurrent controllers;
- Telegram error-description preservation and classification;
- expired callback answers not crashing ingress;
- edit fallback updating the durable Telegram message id;
- malformed HTML fallback to plain text;
- regression coverage for pairing, review freshness, validation, two-read Git head fencing, cancellation, and merge approval.

The final local gate is the complete test suite, TypeScript typecheck, plugin build, generated SDK type check, and tracked-diff inspection. Live acceptance then verifies pairing, natural conversation, an automatically started disposable-repository job, an independent review/test thread, merge approval, merge, and a final conversational summary.

## Acceptance criteria

1. An authorized Telegram message such as `What projects can you work on?` receives a natural Luna Max response without creating a job.
2. An authorized unambiguous task causes Luna to call the guarded start tool and the leased executor to create exactly one implementation worktree/thread on the project's actual source host.
3. A separate fresh review/test child runs in the same environment and cannot share the implementation provider conversation.
4. The owner can continue talking to the same durable Luna controller while background job status remains independently durable.
5. Background implementation/review models follow project policy and may differ from Luna.
6. No component other than the leased executor spawns or sends agent work.
7. Telegram callback or edit 400 responses no longer crash the ingress service and retain an actionable sanitized description.
8. Merge remains impossible without fresh deterministic gates, two matching Git-native PR-head reads, and a one-use Telegram approval.
9. The disposable acceptance pull request merges only after the full flow passes, and Luna reports the durable merged result back to Telegram.
