# Splitting the Deciding Session from the Writing Session

Status: proposal; not authorized for implementation

Date: 2026-08-16

Package: `bb-plugin-telegram-agent`

## The problem this is about

The controller turn is both the thing deciding and the thing at risk. One turn holds the owner's question, chooses what to do about it, and carries whatever authority is needed to do it. When a budget trips, a provider dies, or an environment breaks, the same turn that would have handled the failure is the one that failed.

The 15 August evidence-budget incident is the shape of it. A per-turn cap fired, the turn was retired, and the owner's question went with it — there was nothing left to notice the question had been lost, because the noticing and the losing were the same session. That specific hole is now closed (`src/controller/evidence-budget.ts`): the turn degrades to a plain-text answer instead of dying. But the closure is one patch on one failure mode. The structural version of the question is whether steering and doing should be the same session at all.

## The pattern this draws on, and how much of it is real

The pattern separates a steering session from the sessions that write. The steering session triages, routes to the delivery pipeline, and never implements code directly — a rule that had to be rewritten twice in its original setting to make it unambiguous, because any qualifier permitting a bypass gets used to bypass.

The split is less complete than it reads. The reference implementation's own budget module says so plainly:

> the D1 topology runs Dev inside the PM session, sharing one counter

So in the topology that actually ships, the steering and writing roles share a session and a budget. The separation achieved is one of *role and instruction*, enforced by persona text and pipeline routing, not one of process or permission. That is worth knowing before adopting it: the version of the split that exists in production is mostly the version Hanoon already has.

## What Hanoon already has

Hanoon has the delegation half, and has it structurally rather than by instruction:

- The controller does not implement. Implementation runs as jobs through the pipeline (`src/services/job-executor-service.ts`) and as delegated BB threads, each on its own managed worktree, each with its own lifecycle, evidence, and failure handling. ADR 0005 makes one-code-writer-per-worktree a decision rather than a convention.
- Every controller tool is already classified read or write. `src/capabilities/catalog.ts` marks eleven tools `effectClass: "read"` with `ownerApproval: "never"`, and everything else `write` with `ownerApproval: "conditional"`. Write tools go through capability policy, owner approval, and evidence before they take effect.
- A controller turn that dies does not take the work with it. Jobs, delegations, monitors, and effects are durable and leased; a retired turn is re-driven by the executor, not lost.

So the question is narrower than "should Hanoon split steering from writing". It already has. The question is what remains unsplit.

## What remains unsplit

One thing, and it is the one that matters.

The controller thread is spawned as an ordinary BB thread on the owner's **personal workspace** (`src/controller/bb-controller.ts`), with `permissionMode` from global config and **no tool restriction**. It therefore holds the provider's full native toolset — shell, file writes, network — in the owner's own checkout, on top of the plugin's audited tools.

The plugin's own write path is gated. The native one beside it is not. Everything the capability catalogue, the approval gate, and the evidence contract enforce can be walked around by a controller turn that simply runs a shell command instead of calling a tool. That is the real asymmetry, and it is what "the thing deciding is also the thing at risk" cashes out to here.

The default `permissionMode` is `auto`, which BB resolves to `permissionScope: "workspace"` with an automatic reviewer and an escalation policy — so the exposure is bounded today by BB, not by Hanoon. Setting it to `full` removes the reviewer entirely (`approvalReviewer: null`, `permissionScope: "full"`). The safe default is already the default. It is the ceiling that is unbounded.

## The full split, and why not now

The full version — a read-only steering session that dispatches to a separate full-permission session — costs roughly this:

- A second controller thread identity, with its own lease, generation fence, spawn/adopt/retire lifecycle, and quarantine handling.
- A dispatch protocol between them, with its own idempotency, reconciliation, and failure semantics, since a request that may or may not have reached the writer is a new class of ambiguity.
- Evidence spanning two sessions. The finalization contract binds claims to evidence recorded on one turn; work done in a second session has to be attested back, which is a new trust boundary in the one place the design is most careful.
- Roughly a doubling of the controller state machine, whose current cost is visible in `src/controller/service.ts` and its tests.

Against that, the safety benefit is bounded by what the writer session could do wrong — which is the same set of things, in the same workspace, with the same tools. Splitting the sessions does not remove the native toolset; it moves it. Recommendation: **do not build the full split.** It buys less than it costs, and the recorded experience with it is that the enforcement lives in the routing and the permissions rather than in the process boundary.

## The smallest version that gets the benefit

Deny the controller session's native mutating tools, and leave every plugin write tool alone.

This gets the whole safety benefit of the split — a deciding session that cannot quietly write — without a second session, a dispatch protocol, or a cross-session evidence boundary. The controller keeps every read tool it needs to answer questions, and keeps every write it should be making, because those already go through the plugin's audited, evidence-bearing, owner-approvable path. What it loses is exactly the unaudited path beside them.

Sketch, in the order it would land:

1. **A denied-tool list on the controller spawn.** Native shell and file-write tools denied; native read tools kept. One constant, next to the execution profile, so what the controller may do to a machine is stated in one place rather than inferred from the absence of a restriction.
2. **A settings escape hatch, off by default.** The owner can already choose `permissionMode: "full"`; the same setting should govern whether native writes are available at all, so there is one switch and one mental model rather than two that interact.
3. **An owner-visible refusal.** A controller turn that tries a denied tool should say so in its answer, not fail opaquely. The evidence-budget work established the pattern: degrade deliberately and tell the owner, rather than dying quietly.

### Why this is not implemented here

`bb.sdk.threads.spawn` does not accept a tool policy. `disallowedTools` exists in the BB runtime — it is on the internal `thread.start` message in `@bb/plugin-sdk`'s bundled types — but it is not on `CreateThreadRequest`, which is what a plugin can send. So the smallest useful version needs a BB-side change first: `disallowedTools` (or an equivalent) plumbed through `threads.spawn`.

That is the honest state of it. The design question resolves to a small, well-scoped change; the change is blocked on a capability the plugin SDK does not expose yet. Implementing something else in its place — instructing the controller not to use its shell, say — would be the "trivial work may bypass the gate" mistake described above: a rule that relies on the model choosing to follow it is not a permission boundary, and calling it one is worse than not having it.

## Recommendation

1. Do not build the full steering/writing session split. It costs a doubled controller state machine and buys less than it appears to, because the native toolset moves rather than disappears.
2. Ask for `disallowedTools` on `threads.spawn` in the BB plugin SDK. It is the single prerequisite.
3. When it lands, deny native writes on the controller spawn by default, governed by the permission-mode setting the owner already has, with a visible refusal when a turn hits it.
4. Until then, treat the current default (`permissionMode: "auto"`) as load-bearing, and know that `full` removes the only reviewer standing between a controller turn and the owner's personal workspace.
