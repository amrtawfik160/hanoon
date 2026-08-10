# Telegram Live Presence Design

Date: 2026-08-10

## Goal

Show the paired owner that work is actively progressing without streaming partial model output or creating noisy Telegram messages. Telegram must display its native `typing...` indicator while Luna or an active background worker is running, while the existing durable job-status message continues to show milestone changes.

## User-visible behavior

- Start the native Telegram `typing` action as soon as the leased executor begins processing a Luna controller turn.
- Refresh the action at most once every four seconds while the controller turn remains dispatching or submitted.
- Show the same indicator while an implementation, review, remediation, or validation worker has authoritative liveness state `starting` or `active`.
- Do not show typing while a job is waiting for project selection, confirmation, merge approval, user input, retry, or another external condition.
- Stop refreshing on completion, failure, cancellation, blocking, lease loss, or plugin shutdown. Telegram expires the last action naturally within five seconds.
- Continue editing the job's single durable status message at state-machine milestones. Do not send periodic progress messages.
- Send only the final Luna response after the controller turn settles; partial provider tokens are not relayed.

## Ownership and data flow

The leased job executor is the only presence execution engine. The long-poll ingress continues to validate, persist, enqueue, and nudge; it never starts a timer or sends chat actions. BB lifecycle handlers continue to enqueue reconciliation only.

Each executor iteration determines presence from authoritative state already owned by the system:

1. A controller turn in `dispatching` or `submitted` identifies the paired Telegram chat.
2. Otherwise, the active job and its persisted worker-liveness row identify whether implementation, review, remediation, or validation is `starting` or `active`.
3. When presence is active and the four-second refresh deadline has elapsed, the executor asks the Telegram client to send `sendChatAction` with action `typing`.
4. Durable reconciliation, effects, and outbox delivery remain independent of this best-effort action.

Only the current executor lease may run the heartbeat. Losing the lease aborts the request and discards the in-memory refresh deadline. A replacement executor recomputes presence from durable controller/job state and may safely resume the ephemeral action.

## Telegram transport

`TelegramClient` gains a typed `sendChatAction(chatId, "typing", signal?)` operation. It validates the chat action locally and calls Telegram's `sendChatAction` endpoint with a short request timeout and one attempt. Presence must not consume the durable delivery retry budget or delay job execution through exponential retries.

The executor-facing Telegram adapter exposes this operation separately from durable `sendMessage`, `editMessage`, and callback delivery. The presence coordinator catches and redacts transport failures, logs a bounded warning, and continues the job.

## Scheduling

- Heartbeat interval: 4,000 milliseconds.
- Telegram action lifetime: up to 5 seconds, so a healthy loop refreshes before expiry.
- When presence is active, the executor's next wait is capped by the remaining heartbeat interval.
- When presence is inactive, existing active and idle polling intervals remain unchanged.
- No heartbeat timestamp is persisted because the action is ephemeral and duplicate refreshes after failover are harmless.

## Milestone status

The existing state-machine/outbox path remains the source of durable progress. The implementation verifies that transitions render or update the single status message for these milestones:

- implementation starting or running;
- pull request discovery;
- independent review;
- remediation after requested changes;
- validation and required checks;
- waiting for the one-use merge approval;
- merging;
- merged, failed, blocked, or cancelled.

No new free-standing progress messages are introduced.

## Failure and safety behavior

- A failed, rate-limited, or malformed chat-action response never changes controller or job state.
- Presence errors do not enter the durable outbox and are not retried by the job executor.
- Authentication errors remain visible in bounded plugin logs, without exposing the bot token.
- An unknown or stale worker-liveness state does not produce typing because the system cannot prove active work.
- Waiting-for-host and host-reconnecting states do not produce typing.
- Final replies and status messages keep their existing durable, idempotent delivery semantics.

## Test strategy

Use RED-GREEN TDD for each behavior:

1. Telegram client sends the exact `sendChatAction` request and rejects unsupported actions.
2. The executor sends an immediate typing action for a dispatching/submitted controller turn.
3. It refreshes no more than once per four-second interval while the same work remains active.
4. It sends typing for authoritative `starting` or `active` implementation, review, remediation, and validation liveness.
5. It does not send typing for idle, failed, unknown, stale, terminal, or approval-waiting states.
6. A chat-action failure does not fail or delay durable controller/job reconciliation and outbox delivery.
7. Lease loss and shutdown abort the heartbeat; the next lease holder can resume from durable state.
8. Existing focused and full plugin tests remain green.

After unit tests, build the plugin, reload the installed path plugin, confirm both background services are running, trigger a real Luna Max Telegram turn, and observe repeated successful `sendChatAction` calls followed by the durable final response. Then start or inspect a guarded job to verify milestone status edits and presence cessation at a waiting or terminal state.

## Non-goals

- Streaming provider token deltas into Telegram.
- Persisting ephemeral typing actions.
- Letting ingress, BB lifecycle handlers, or another service start work or own heartbeat timers.
- Sending periodic text progress messages.
- Changing merge, review, validation, approval, project-policy, or worktree isolation rules.
