# Telegram BB Valor Pipeline Design

Status: approved through the user's instruction to implement the recommended approach

Date: 2026-08-10

Package: `bb-plugin-telegram-agent`

Plugin id: `telegram-agent`

## Outcome

Turn the existing Telegram Agent into a responsive Luna Max BB operator and a complete, guarded software-delivery pipeline. The owner can talk naturally, inspect every visible BB project and active thread, start work in enabled projects, watch agent output arrive through Telegram's native animated draft stream, approve consequential controls, and receive a final production-verification report.

The design takes the durable graph, bounded correction loops, bridge/worker separation, disk handoffs, fresh review context, and explicit liveness lessons from [Valor](https://github.com/tomcounsell/ai), while using BB threads, environments, interactions, and managed worktrees instead of reproducing Valor's Claude/Redis runtime. Valor's current [pipeline graph](https://github.com/tomcounsell/ai/blob/main/docs/features/pipeline-graph.md) and [bridge/worker boundary](https://github.com/tomcounsell/ai/blob/main/docs/features/bridge-worker-architecture.md) are reference inputs, not dependencies.

## Product decisions

- The Telegram-facing agent is Codex `gpt-5.6-luna`, reasoning `max`, service tier `fast`, permission mode `auto`.
- Telegram long polling remains pure I/O: authenticate, deduplicate, enqueue, acknowledge, and deliver outbox entries. It never touches a worktree or spawns a BB session.
- The leased executor remains the only execution engine and the only component allowed to spawn, send, stop, validate, merge, or deploy.
- Controller tools commit bounded durable intent. Read-only BB inspection may query the SDK; mutating tools enqueue an operation for the executor.
- All visible BB projects and non-hidden threads are inspectable. Existing threads can be steered, stopped, or retried only after a one-use Telegram confirmation naming the exact thread and action.
- Coding jobs can start only in explicitly enabled project policies.
- Merge approval is labeled `Merge + deploy`. Approval is invalid unless production deployment and verification are configured for the project.
- The plugin never invents an ETA. It reports stage, elapsed time, last activity, liveness, and an ETA only when enough completed Telegram jobs provide a defensible historical estimate.
- Worktrees remain the code/filesystem isolation boundary. BB threads isolate provider conversations, durable identities, history, lifecycle, interactions, execution settings, permissions, visibility, attribution, and parent-child coordination.

## Architecture

```text
Telegram private chat
        |
        v
long-poll bridge (I/O only)
  authenticate -> dedupe -> durable controller turn / callback
        |
        v
SQLite durable control plane
  controller generations + turns + stream cursors
  confirmed BB operations
  job runs + canonical stage records + receipts
  effects + outbox + approval tokens + liveness
        |
        v
single leased executor
  controller dispatch/recovery/stream projection
  BB read/control effects
  stage router and sole session spawner
  deterministic git/test/merge/deploy effects
        |
        +---------------- conversational controller ----------------+
        | hidden personal-workspace Luna Max thread                 |
        | narrow registered tools; no implementation checkout       |
        +------------------------------------------------------------+
        |
        +---------------- guarded software run ----------------------+
          one managed worktree / branch
            PLAN (fresh Luna Max) -> plan.md attachment
            CRITIQUE (fresh conversation) --fail--> PLAN, max 2
            BUILD (implementation policy)
            TEST (deterministic terminal receipts) --fail--> PATCH
            REVIEW (fresh conversation, read-only) --fail--> PATCH
            PATCH (resume builder) -> TEST -> fresh REVIEW, max 3
            DOCS (fresh Luna Max using Docs Guard + BB CLI skills)
            FINAL TEST + fresh FINAL REVIEW at exact new SHA
            Telegram one-use approval for exact SHA
            MERGE -> production DEPLOY -> CANARY/health verification
        +------------------------------------------------------------+
```

## Why BB threads and worktrees are both required

A worktree owns branch, checkout, uncommitted files, generated artifacts, and filesystem mutations. Two threads in one environment see the same files and can conflict even though their conversations are separate. Separate threads without separate environments therefore do not isolate code.

A BB thread owns a durable provider conversation, thread identity, lifecycle/status, output/event history, pending interactions, execution settings and resolved permissions, visibility/origin attribution, and parent-child relationships. A fresh review thread reusing the implementation environment sees the same diff without receiving the builder's provider transcript. That separation reduces rubber-stamping while preserving the exact filesystem under review.

The controller has a personal workspace and never receives the job worktree. Plan, implementation, review, docs, and deploy roles receive explicit environments. No design claims that BB threads replace worktrees.

## Realtime Telegram conversation

The current Telegram Bot API supports ephemeral `sendMessageDraft` streaming in private chats. Realtime behavior uses that native presentation without weakening durable controller state:

1. Within one executor cycle of a submitted turn, call `sendMessageDraft` with empty text so Telegram renders its native `Thinking…` placeholder. Derive one stable non-zero `draft_id` from the durable controller-turn identity and reuse it for the whole response.
2. Dispatch the turn with explicit Luna Max, fast service tier, and auto permission settings.
3. Read BB thread events from the persisted sequence cursor. Consume only `turn/input/accepted`, `item/agentMessage/delta`, `turn/completed`, `system/error`, and `provider/error`. Never expose reasoning deltas, raw tool arguments, command output, tokens, or secrets.
4. Accumulate a bounded plain-text preview and refresh the same draft at most once per executor tick. When no output changes, requeue the draft after 20 seconds so Telegram's 30-second preview stays visible. Continue Telegram `typing` presence as a fallback. A runtime without draft support falls back to the existing one-message edit path.
5. On completion, switch the logical outbox item to normal `sendMessage` delivery with the durable final response. Telegram then clears the ephemeral preview. Final delivery uses the existing bounded retry policy. Restarting the plugin resumes from the persisted cursor and text and regenerates the same draft id; it never treats an ephemeral draft as the final delivery.

Each controller turn stores `bb_event_seq`, `stream_text`, `stream_phase`, the final/fallback `telegram_message_id`, and lifecycle timestamps. The executor lease fences every update. Draft previews are intentionally ephemeral; only their reconstructible source state is durable.

## Controller latency and recovery

The live failure had two independent causes: a large controller conversation incurred a slow provider initialization with no cache hit, and the resulting `initialize` timeout left the mapped thread in `error`, which the current service treats as permanently non-idle.

The controller becomes a durable logical conversation with replaceable BB thread generations:

- Use `serviceTier: "fast"` explicitly on spawn and every send while preserving Luna Max.
- Rotate the provider thread after a bounded number of completed turns, a bounded context estimate, deletion/archive, or any terminal provider error. Carry only a bounded durable conversation digest and recent owner messages into the next generation.
- Before retrying a failed dispatch, inspect events after its recorded baseline. If no `turn/input/accepted` exists, retry once in a fresh generation. If acceptance is present or uncertain, fail closed and do not duplicate the input.
- A failed generation is retired after the current turn is settled. It never poisons later Telegram messages.
- Specific sanitized errors replace the generic `Please resend` response.

BB thread status is the authoritative provider lifecycle signal. The executor lease heartbeat is the authoritative plugin-worker signal. Stored observations do not override either source.

## BB operator tools

### Read-only tools

- `telegram_agent_list_projects`: every visible standard BB project plus whether it is enabled for guarded jobs.
- `telegram_agent_list_threads`: bounded visible threads filtered by project/status, including id, title, project, BB status, host/environment, branch, PR, parent, elapsed time, and last activity.
- `telegram_agent_thread_status`: the same projection plus bounded latest assistant output, pending interaction summary, child summary, and liveness. It reports `eta: unavailable` unless a defensible estimate exists.
- Existing guarded-job status and project-policy tools remain.

### Confirmed mutating tools

- start guarded job in an enabled project;
- steer an exact existing BB thread;
- stop an exact existing BB thread;
- retry an eligible failed thread or guarded job;
- cancel a guarded job;
- approve exact-SHA merge and mandatory deployment.

The tool call creates a durable pending operation and one-use confirmation token. The callback contains only an opaque token. The executor re-resolves the target and legal preconditions when applying it. Tokens expire, are owner/chat bound, action bound, target bound, and single use.

## Canonical job graph

The stage graph is the only legal transition source:

```text
INTAKE -> PLAN -> CRITIQUE -> BUILD -> TEST -> REVIEW -> DOCS
                                   ^       |       |
                                   |       v       v
                                   +---- PATCH   FINAL_TEST -> FINAL_REVIEW

FINAL_REVIEW -> APPROVAL -> MERGE -> DEPLOY -> CANARY -> COMPLETE
```

Failure edges:

- `CRITIQUE(needs_revision) -> PLAN`, maximum two critique cycles.
- `TEST(fail) -> PATCH -> TEST`, maximum three patch cycles.
- `REVIEW(changes_requested) -> PATCH -> TEST -> REVIEW`, always a fresh reviewer thread.
- Any docs commit invalidates earlier SHA receipts and routes through `FINAL_TEST -> FINAL_REVIEW`.
- SHA drift at any later gate returns to exact-head resolution and fresh final verification.
- Cycle exhaustion, ambiguous ownership, unavailable evidence, or missing deployment configuration escalates to the owner instead of guessing.

Every stage attempt records input-artifact hashes, BB thread/terminal identity, environment id, starting and ending SHAs, status, structured verdict or command receipts, timestamps, and error. A stage cannot become complete from artifact inference alone.

## Role contracts and artifact handoff

- `PLAN`: fresh Luna Max thread in the job environment. It receives the immutable work order attachment and returns a bounded structured plan. The executor persists it as `plan.md` and uploads it as a BB attachment.
- `CRITIQUE`: fresh Luna Max conversation receives only the work order and plan attachments. It returns a strict critique verdict. It never receives the planner transcript.
- `BUILD`: receives a tiny prompt instructing it to read `work-order.md` and `plan.md`; the prompt does not inline either document.
- `TEST`: deterministic configured terminal commands, not a model claim.
- `REVIEW`: fresh non-forked BB child in the same environment. It receives a complete immutable review packet and may not edit, commit, push, merge, or deploy. Before/after git state must match.
- `PATCH`: resumes the builder conversation with bounded receipts/findings so it retains implementation context.
- `DOCS`: fresh Codex Luna Max thread in the same environment, explicitly instructed to use Docs Guard and BB CLI skills, update necessary documentation, run documentation checks, commit, and push. A no-op requires evidence.
- `FINAL_REVIEW`: a newly spawned conversation at the post-docs Git head.

## Exact-SHA gates

The executor resolves the pull-request head with:

```text
git ls-remote --exit-code origin refs/pull/<N>/head
```

The Git remote is ground truth; GitHub API results are metadata only. Review, final review, validation, approval, and merge receipts are bound to a full lowercase SHA. The merge boundary performs two matching Git-native head reads around fresh validation and rejects drift. It never accepts a verdict merely because a trailer matches a cached API SHA.

## Merge, deployment, and production verification

Enabled project policy adds a mandatory `production` block:

- deployment commands with names and timeouts;
- health/canary commands with names and timeouts;
- optional rollback command shown to the owner but never run automatically;
- output redaction patterns;
- deployment liveness timeout.

Projects without a complete production block may implement and review but cannot receive merge approval. The button states `Merge + deploy <short SHA>`.

After merge, the executor verifies the merged base branch contains the approved content, runs production deployment commands in the fenced job environment, then runs configured health/canary commands. Convex deployments must invoke the Convex CLI. A merge is reported separately from deployment and canary; deployment failure after a successful merge is a production incident, not a failed merge, and is surfaced immediately with the safe rollback instruction.

## Liveness and split-brain prevention

- `executor_lease` is the only authority allowed to start or mutate work.
- Every running controller/stage record has one executor-owned `liveness_state`, `liveness_resource_id`, `liveness_generation`, `last_observed_at`, and `first_output_at` projection sourced from the owning BB thread or terminal.
- The long-poll bridge only nudges the executor after writes. It never touches a worktree.
- A job-level ownership key serializes one run per project worktree. Unknown stages fail closed to project serialization.
- Effects are idempotent and generation fenced. Uncertain spawns reconcile by plugin origin, deterministic title, parent/environment, and attempt id before any retry.
- A first-output deadline distinguishes silent initialization hangs from long reasoning. Provider errors and command timeouts have bounded, stage-specific recovery; no infinite redispatch loop is legal.

## Security and visibility

- Only the paired private-chat owner can use the controller.
- Controller tools expose bounded projections, not raw logs, absolute paths, secrets, prompts, callback payloads, or command output.
- Controller threads are hidden. Work, review, docs, and deployment threads are visible and parented to the job root so the owner can inspect and coordinate them in BB.
- Project policies are immutable snapshots per run. A policy edit affects only future jobs.
- Existing-thread mutations require explicit confirmation; read-only status does not.
- Machine permission ceilings remain authoritative. The plugin never silently widens permissions.

## Testing and live rollout

Implementation follows red-green TDD in independently shippable slices:

1. controller recovery and fast-tier dispatch;
2. durable event cursor and native Telegram draft streaming;
3. visible BB thread status projection and confirmed control operations;
4. PLAN/CRITIQUE artifact loop;
5. TEST/REVIEW/PATCH cycles and exact-SHA invalidation;
6. DOCS and final fresh verification;
7. merge/deploy/canary receipts and incident reporting.

Each slice runs focused tests, the full Vitest suite, TypeScript typecheck, plugin build, generated SDK type check, and tracked-diff review. The plugin is then reloaded and tested from the paired Telegram chat. Live acceptance must prove:

- an immediate native `Thinking…` draft, at least one animated draft update, and successful persistent final Luna delivery;
- recovery from the currently poisoned controller without manual database repair;
- accurate active-thread status for `cyndra-saas` without a fabricated ETA;
- a disposable repository run with separate plan, critic, builder, reviewer, docs, and final-review conversations;
- exact-SHA approval, merge, configured production deployment, and post-deploy verification reported as distinct outcomes.
