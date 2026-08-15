# Architecture

Telegram Agent is a full-trust BB plugin that turns one paired private Telegram chat into a durable controller for reviewed software delivery. Telegram is the operator interface; BB owns agent conversations, environments, worktrees, and merge execution; SQLite owns the plugin's recoverable control state.

## System model

The system has three layers:

1. **Telegram I/O** polls updates, validates the paired private owner, records accepted input, and delivers drafts, status edits, callbacks, and final messages. Photos, image files, GIFs, and short videos are accepted on the same owner turn. Stills attach as BB images. GIFs and videos are downloaded and sampled into an ordered set of stills the controller can see; if sampling is unavailable, Telegram's preview still is used instead.
2. **Durable control** stores pairing, controller turns, jobs, immutable policy snapshots, effects, approvals, attempts, liveness, and the Telegram outbox in the plugin database.
3. **BB execution** runs the hidden conversational controller and hidden planning, implementation, review, documentation, validation, merge, deployment, and canary workers. The owner hears about that work through Telegram job cards, not BB sidebar threads.

Ingress, BB lifecycle events, and BB realtime thread or environment changes do not start agent sessions. They record or enqueue work and nudge the executor. A completed reconcile for a worker thread can be re-armed when that thread or its environment changes again, so a job that stays active is observed again instead of going stale until the next scheduled poll. The single generation-fenced executor is the only component that dispatches controller turns, spawns pipeline threads, runs effects, or delivers Telegram output. Within that authority it can run a bounded number of independent project lanes concurrently.

## Ownership and data flow

```mermaid
flowchart LR
    Owner[Paired Telegram owner] -->|private messages and approvals| Ingress[Telegram ingress]
    Ingress -->|durable input only| State[(Plugin SQLite)]
    Events[BB lifecycle and realtime events] -->|enqueue reconciliation| State
    State -->|work notification| Executor[Single leased executor, bounded lanes]
    Executor -->|conversation| Controller[Hidden BB controller thread]
    Executor -->|reviewed job effects| Pipeline[Hidden BB pipeline threads]
    Pipeline -->|managed environment| Worktree[Git worktree]
    Controller -->|bounded reply state| State
    Pipeline -->|attempts, receipts, liveness| State
    State -->|durable outbox| Executor
    Executor -->|drafts, status, final delivery| Owner
```

The executor renews one authoritative lease heartbeat. A second instance may poll for the lease, but it cannot run a fenced effect or merge on behalf of the current generation. Lane concurrency does not create more executor authorities: each durable write and provider boundary remains fenced by the same owner and generation.

## Admissions and resource ownership

An admission is the durable scheduling record for a job:

- `queued` means the request is waiting for the global cap or its project claim;
- `admitted` means it occupies a concurrency slot and holds the project's pipeline claim;
- `draining` means terminal state is durable but authoritative worker/effect cleanup still owns the slot;
- `released` means cleanup completed and the slot and held claims no longer block later work.

The configured cap is global, but a unique held project claim permits only one admitted job per project. FIFO queue order decides between jobs for the same project; work from other free projects can fill the remaining slots.

Merge-time claims add two narrower exclusion boundaries. A normalized `repository_merge` claim serializes merges to the same GitHub repository. A configured production policy also takes a `production_target` claim; `production.targetKey` lets distinct projects name a shared target, while an omitted key falls back to the project id. Claims are acquired in the fenced merge lease transaction and exposed as bounded kind/key wait projections.

After an executor restart, the successor reconciles the exact job before adopting that job's held claims under its new generation. It never adopts another job's claims. A merge whose provider outcome may have started but is unknown retains its repository and production claims until provider truth is reconciled.

## Reviewed delivery pipeline

```mermaid
flowchart LR
    Intake --> Plan --> Critique --> Build --> Test --> Review[Quality + risk review] --> Docs
    Docs --> FinalTest[Final test] --> FinalReview[Quality + risk final review]
    FinalReview --> Approval[Owner approval] --> Merge --> Deploy --> Canary --> Complete
    FinalReview -->|no production| Complete
    Intake -->|small fix| SmallBuild[Build] --> SmallTest[Validation] --> SmallReview[Quality review] --> Complete
    Intake -->|existing PR| Adopt[Verify repository, base, and head] --> Test
    Critique -->|one revision| Plan
    Test -->|failure| Patch
    Review -->|changes requested| Patch
    FinalTest -->|failure| Patch
    FinalReview -->|changes requested| Patch
    Patch --> Test
    Critique -->|limit| Blocked
    Patch -->|cycle limit| Blocked
```

The planner writes a bounded plan artifact. Its verification section must reproduce the policy's exact commands in a table that expects exit code `0`, or use the exact explicit-skip line when the policy has no commands. The critic receives the work order and plan as immutable project attachments in a fresh BB thread. The implementation worker receives the accepted plan without inheriting the planner's provider conversation.

After implementation produces a pull request, deterministic validation runs before fresh review threads are spawned in the same BB environment. Full jobs require independent quality and risk verdicts; small fixes require only the quality verdict. The group cannot advance until every required lens has durable evidence for the exact head. A reviewer never forks or resumes the implementation conversation. A changes-requested verdict returns bounded findings to the implementation thread; a new pull-request head requires new validation and another fresh review group.

Documentation, final validation, and final review happen before the owner receives a one-use merge approval when production is configured. Documentation may be skipped only with a strict report and an observed clean, empty documentation diff. If production is not configured, a successful final review completes the job at the reviewed pull request. A small-fix job skips planning, critique, documentation, and final review, but still must pass deterministic validation and one independent quality review. An adopted pull request records planning and critique as honestly skipped after verifying its repository, base branch, URL, remote head, and deterministic local branch, then enters the normal full validation/review/finish path. Merge, deploy, and canary each produce separate durable receipts. A successful merge followed by a failed deploy or canary is recorded as `production_failed`; the plugin does not claim completion. It runs the policy's rollback command when one is configured, in the failing stage, before reporting.

## Adaptive capability control plane

The capability control plane sits before provider work and reuses the delivery state machine rather than replacing its merge or production fences:

```mermaid
flowchart LR
    Request --> Classifier[Traits + six recipes]
    Classifier --> JobSnapshot[Recipe + legacy/shadow/active mode]
    JobSnapshot --> Profile[Immutable least-capability profile]
    Profile --> Route[Exact model tuple]
    Route --> Provider[BB provider boundary]
    Provider --> Outcomes[Append-only trials and capability outcomes]
    Outcomes --> Gate[Native, validation, and guard gates]
    Gate --> Transition[Authoritative job transition]
```

The pinned catalog validates every admitted skill, controller bundle, native adapter, model-pool marker, and recipe descriptor by digest and dependency graph. Profiles bind the catalog and graph digests, recipe/version, routing mode, exact model tuple, selected assignments, traits, and reason codes to one controller turn or worker attempt. A profile is written before its provider call. Selected mandatory capabilities receive exactly one terminal outcome before their stage may advance; native-adapter outcomes commit in the same SQLite transaction as the transition they authorize.

The six recipes are `direct`, `bounded`, `bug`, `skill-authoring`, `adopted-pr`, and `architectural`. Their graphs express direct diff guards, approved-design implementation, diagnosis plus regression, skill baseline proof, adopted-pull-request inspection, and plan/critique plus task and integrated review respectively. Later evidence can raise rigor at most twice, never downgrade it, and the persisted job snapshot survives retry and restart.

Active model routing pins provider, model, reasoning, and service tier before spawn. One equivalent provider failure retries the same tuple; a second escalates only the next provider call from `fast` to `standard` to `strong`. It never switches within an attempt or downgrades after restart. A second equivalent failure at `strong` blocks. Permission remains a separate policy field.

Review guards are selected from the canonical exact-head diff. Their strict envelopes bind profile revision, head SHA, diff digest, descriptor digests, and bounded findings. Mandatory outcomes are checked again at the executor transition. The same mandatory finding requests remediation twice and blocks on its third occurrence in the durable job/review lineage.

External provider, model, plugin, and skill discovery is read-only and deadline-bound. A failed refresh preserves the previous snapshot with degraded health. Discovered entries stay `inventory-only`: discovery alone grants no execution authority, and admission requires a validated descriptor, explicit role/recipe/stage mapping, and at least five compatible shadow trials.

Rollout is per recipe. `shadow` computes candidate profiles and routing evidence without controlling provider behavior or recording candidate success as production truth. `active` can control only after a durable promotion decision; rollback affects new jobs while retaining profiles, receipts, trials, and in-flight snapshots. The production promotion reader resolves the newest append-only manifest against integrity-bound deterministic and classifier artifacts, safety snapshots, an active post-merge job, distinct failure/recovery receipts, and terminal candidate/baseline model trials. Trial settlement timestamps must prove failure before recovery, both receipts before merge, merge before the live-run record, and that record before the manifest. A missing, corrupt, duplicate, cross-recipe, reversed, or mismatched reference makes the whole manifest incomplete; it never falls back to older proof.

This release deliberately exposes no promotion-evidence append method, CLI input, controller tool, or plugin callback. A future trusted live collector must prove the acceptance job is disposable, derive artifact and safety records from authoritative harness output, and commit the bounded ledger transactionally. Until that collector exists, the seam remains explicitly incomplete: a fresh installation has no promotion evidence, `capability promote` fails closed, and adaptive recipes default to `shadow`.

## Agent skill runtime

The BB manifest registers five local skill roots. Four are vendored from reviewed permissively licensed upstreams. The fifth is first-party Hanoon guidance:

| Root | Upstream | Licence | Contents |
| --- | --- | --- | --- |
| `skills/workflow-kit` | [obra/superpowers](https://github.com/obra/superpowers), pinned `6.3.0` | MIT | 14 workflow skills |
| `skills/guards` | [amElnagdy/guard-skills](https://github.com/amElnagdy/guard-skills) | MIT | `clean-code-guard`, `test-guard`, `docs-guard` |
| `skills/delivery` | [getsentry/skills](https://github.com/getsentry/skills) | Apache-2.0 | `pr-writer` |
| `skills/discovery` | [mattpocock/skills](https://github.com/mattpocock/skills), pinned `1.2.3` at revision `84fdeffd12f2ee307994d1eb6feb48173b6e0502` | MIT | `grill-with-docs`, `grilling`, `domain-modeling` |
| `skills/hanoon` | first-party | first-party | `human-friendly-coding-communication`, `proportional-development-workflow` |

A root's licence is recorded per root rather than per bundle, because the vendored roots do not share one licence: folding Apache-2.0 material under an MIT notice would misstate its terms. The Hanoon root is owned by this plugin and is not a third-party vendor copy. All 23 catalog entries are committed in this repository, so the plugin has no runtime dependency on another skill plugin and never downloads a skill while starting a thread.

The existing single `bb.agents.configure` callback keeps the controller and worker boundaries separate. Its exact role-selection matrix is:

| Verified role/context | Selected skill ids |
| --- | --- |
| controller | `human-friendly-coding-communication`, `proportional-development-workflow`, `grill-with-docs`, `grilling`, `domain-modeling`; controller tools and `CONTROLLER_INSTRUCTIONS` |
| planner | `human-friendly-coding-communication` |
| critic | `human-friendly-coding-communication` |
| implementation | `human-friendly-coding-communication`, `systematic-debugging`, `test-driven-development`, `verification-before-completion`, `clean-code-guard`, `test-guard`, `pr-writer` |
| review | `human-friendly-coding-communication`, `clean-code-guard`, `test-guard` |
| documentation | `human-friendly-coding-communication`, `docs-guard`, `verification-before-completion` |
| final-review | `human-friendly-coding-communication`, `clean-code-guard`, `test-guard`, `docs-guard` |
| validation, merge, deploy, canary | none; these are deterministic stages, not skill-bearing worker roles |

### Fail-closed worker selection

The resolver first checks structural context. The origin must be non-fork (`origin.kind === null`) and belong to plugin `telegram-agent`; the project must be `standard`; and the environment must be a `managed-worktree`. The thread title must match the anchored production protocol exactly:

```text
Telegram <jobId> <role-token> <attemptId>
```

The parser accepts job ids of 1–256 `[A-Za-z0-9_-]` characters and attempt ids of 1–264 `[A-Za-z0-9_.:-]` characters. The only role tokens are `implementation`, `plan`, `critique`, `review`, `docs`, and `final-review`, mapped respectively to implementation, planner, critic, review, documentation, and final-review.

It then checks durable ownership. Implementation, review, and final-review titles must use an `attempt:` id and an exact durable attempt of kind `implementation` or `review`; planner, critic, and documentation titles must use a `stage:` id and an exact durable stage role `PLAN`, `CRITIQUE`, or `DOCS`. The id after that prefix is looked up as the exact job effect idempotency key, and its effect must be respectively `spawn_implementation`, `spawn_review`, `spawn_final_review`, `spawn_plan`, `spawn_critique`, or `spawn_docs`. The job must exist and belong to the current project. Its persisted environment id, when non-null, and persisted worker thread id, when non-null, must equal the current context. A null binding is allowed only for the first start; it is not a wildcard after persistence. Title, job, attempt, role, effect, project, environment, thread, origin, project-kind, or workspace mismatches all return no tools and no skills. There is no fallback to a newest job, parent thread, or title-only inference.

The controller branch is independently exact: it requires the active durable controller, matching project and host, the plugin origin, an allowed controller provider, a personal project and personal workspace, and the stable controller title. It receives controller tools, the two first-party guidance skills, the three discovery skills, and `CONTROLLER_INSTRUCTIONS`. A spoofed or unrecognized context cannot inherit either controller tools or a worker profile.

### Bundle integrity and maintenance

`npm run skills:verify` runs the synchronous verifier used by activation. It requires the manifest roots and `skills/skills.lock.json` schema version 1, bounds the lock to 1 MiB, the bundle to 64 skills and 512 locked files, rejects symlinks/non-regular or over-256 KiB files, and requires every discovered file to be locked exactly once with a SHA-256 digest. It also checks lexical safe paths, skill directory/frontmatter/lock-name agreement, nested local Markdown links that stay within their registered root and resolve to a regular file or a directory inside it, and the recorded provenance and licence of all four vendored roots (including pinned workflow-kit `6.3.0` and discovery kit `1.2.3`) plus the first-party Hanoon root. Success prints a bundle digest and skill count.

The package `build` script runs `npm run skills:verify` before `bb plugin build`; `server.ts` runs the same verification before `createPlugin` can register services, tools, schedules, or commands. Any malformed lock, missing root/skill/resource, unlocked or escaped path, frontmatter/provenance mismatch, symlink, size/count limit, or digest mismatch stops the build or activation. There is no runtime download, replacement, or repair path.

Synchronization is a maintainer-only, network-free operation from an already-reviewed absolute checkout. The checkout must identify the `superpowers` package at version `6.3.0`, contain `LICENSE` and `skills/`, and carry the reviewed MIT license. The exact command is:

```bash
WORKFLOW_KIT_SOURCE=/absolute/path/to/superpowers-6.3.0
npm run skills:sync -- --source "$WORKFLOW_KIT_SOURCE" --version 6.3.0
```

It rewrites only the local `skills/workflow-kit` tree and `skills/skills.lock.json`; ordinary plugin startup never invokes it.

## BB threads and worktrees

BB threads and Git worktrees solve different isolation problems:

| Boundary | BB thread | Managed worktree |
| --- | --- | --- |
| Provider conversation | Isolated identity and history | Not applicable |
| Status and interactions | Durable per thread | Not applicable |
| Model, reasoning, and permissions | Resolved per turn/thread | Not applicable |
| Visibility and parent-child coordination | Owned by BB | Not applicable |
| Branch and checkout | References an environment | Owns the checkout |
| Uncommitted files and artifacts | Shared when threads reuse an environment | Isolated from other worktrees |
| Filesystem mutation | Runs through the thread's environment | The actual mutation boundary |

The conversational controller runs in a hidden personal workspace and has no implementation checkout. Planning creates or reuses the job's managed worktree. Implementation, review, documentation, and validation threads that reuse that environment see the same files, even though their provider conversations remain separate. Each implementation worktree also has a gitignored `PROGRESS.md` scratchpad. Workers read it on entry and update it at meaningful milestones so a replacement session can continue after context compaction or recovery without turning transient notes into a commit.

## Durable state

The plugin database records:

- one owner identity and expiring pairing codes;
- enabled project policies as immutable versioned snapshots;
- controller thread identity, FIFO turns, streaming cursors, and delivery state;
- every controller thread generation with its lifetime and the reason it was retired;
- a rolling conversation digest of answered turns;
- long-term memories with full-text search, supersession, and provenance;
- tool receipts keyed by turn, tool name, and argument hash;
- armed monitors, their trigger, and their firing history;
- watched threads with their last reported status, and the interactions offered to the owner with their answers and delivery state;
- jobs, queue admissions, resource claims, state-machine versions, stage attempts, and immutable handoff digests;
- idempotent effects and retry accounting;
- executor lease ownership and worker liveness;
- merge approvals, callback consumption, and production receipts;
- a durable Telegram outbox.

Restart recovery resumes from these records. It does not infer success from a missing process, stale provider output, or an HTTP success alone.

## Conversation continuity

A BB thread is one disposable execution generation serving a durable conversation. When a provider session fails, the thread is retired — recorded, not erased — and the next message opens a replacement seeded with:

- the recent conversation digest, so the owner is not asked to repeat themselves;
- the memories relevant to the new message;
- receipts for what the previous generation already did for that message.

Each answered turn writes its digest entry in the same transaction that records the answer, so a crash cannot leave a delivered reply that the next generation has no record of.

## Memory

Memories are typed (`preference`, `fact`, `decision`, `correction`), scoped to the owner globally or to one project, and ranked by a deterministic blend of BM25 relevance, recency decay, importance, and confidence. Ranking runs entirely inside SQLite through an FTS5 index: no embedding service, no API key, and no vector files to reconcile. A memory write commits in the same transaction as the row it indexes.

Restating a subject supersedes its predecessor instead of overwriting it, so corrections keep their history. Credential-shaped text is refused at the write, and the owner's explicit standing instructions ("always…", "never…", "remember that…") are captured at intake so they survive even if the answer itself fails.

## Monitors

A monitor is a durable obligation, not a reminder. It watches a BB thread for completion or failure, or fires on a cron schedule. Thread watches are event-driven: BB realtime and lifecycle events wake the executor instead of waiting for the next idle poll. Firing is claimed before it happens, so a crash mid-fire cannot double-book it; a one-shot watch retires and a schedule re-arms for its next occurrence. The agent receives its own instruction back as an ordinary turn, acts on it, and reports to the owner. Schedules are for clock time, not for polling whether a thread or job has moved.

Visible-thread follow-up currently has two paths. Starting or messaging a thread tries to arm one best-effort courtesy monitor for it; a later explicit watch reuses that row and replaces its instruction. A new thread watch holds for a settling minute, and reaching the armed-monitor cap declines only the courtesy monitor rather than the action that prompted it. Independently, lifecycle observation treats an exact `thread:<id>` reference in durable controller evidence as engagement and can enqueue a follow-up when no monitor owns the landing. This inferred obligation has no monitor row, is absent from monitor listings, and does not consume the armed-monitor cap; read-only thread list and status evidence currently qualifies. Delegated fan-outs use their join record instead of one watch per member.

## Thread notices

The owner drives BB from Telegram, so anything that would wait for a click in the BB app is work that waits forever. A background sweep watches every **top-level** visible thread — a sub-agent's thread is reported to its parent, not to the owner, and a Hanoon pipeline worker is already covered by the job status card — and delivers two things:

- **Finished and failed.** A thread's first observation is recorded silently, so enabling the sweep does not replay a backlog. After that, only a thread that was *working* can stop working: a move into `idle` or `error` is announced when it comes from `active`, `starting`, or `stopping`. A thread marked failed after it already finished has had its say, and repeating it as a failure would contradict what the owner just read. A thread being steered turn by turn is announced at most once every ten minutes, so it does not narrate every reply.
- **Blocked.** A **visible watched** thread waiting on a BB interaction is rendered into Telegram with inline buttons: the options of a question, or *Allow once* / *Allow all session* / *Deny* for a command or file-change approval. The session-wide option exists only on this visible-thread path; the hidden controller never offers it. The tap is carried back through BB's interaction resolution, and delivery is recorded separately from the answer so a crash between the two re-sends rather than loses it.

Notices are written straight to the durable outbox rather than routed through the agent. They are a property of the plugin, not of the conversation, so they still arrive when the agent itself is the stuck part.

An interaction the plugin cannot render into buttons — an unfamiliar payload, or an approval whose subject it does not recognise — is reported without them, naming the thread and saying it needs the BB app. Guessing at a resolution would answer it wrongly; saying nothing would leave the thread waiting on an owner who was never told.

The sweep is paced independently of the executor loop it rides on, which polls as often as every 250ms while an answer streams. An owner's tap is delivered immediately; only the polling is paced.

## Controller interactions

The conversational agent can be blocked mid-answer on a question it needs the owner to settle, or on a permission BB wants granted. Both are BB interactions, answerable only in the BB app, so the plugin bridges both.

The event stream the reconcile loop already reads carries only a bounded reference — an interaction id, a kind, and a status. That reference is never authority for what the interaction says. Before anything is stored or shown, the plugin revalidates its own source against the fresh executor lease, the exact submitted turn, the active controller thread, and that thread's single open generation, then fetches the exact interaction with `threads.interactions.get` and checks the returned id, thread, and status. Only then is the payload projected into the bounded, redacted form the plugin may keep.

What the owner sees:

- **Questions** keep their bounded sequential options and accept a plain typed reply. Multi-question interactions are asked one at a time and resolved once every question is settled.
- **Permission approvals** render exactly *Allow once* and *Deny*. There is no session-wide grant on the hidden controller path, and a session-wide token cannot settle one even if presented.
- **Anything the plugin cannot represent** is reported as bounded explanatory text with no buttons, rather than guessed at.

A tap is durable before BB hears anything about it: the pending-to-answered transition, the Telegram callback outcome, and the acknowledgement the owner is owed all commit in one transaction under the claimed update. The executor is nudged only after that commit. Repeated callback ids and repeated tokens are idempotent, and a wrong user, a wrong chat, or a revoked owner settles nothing.

Delivering the answer to BB is the one operation allowed to run before evidence reconciliation: until BB hears a decision the owner already made, the thread cannot produce anything new. The exact interaction is fetched again before resolving, so an interaction BB already settled is adopted locally instead of resolved twice. While an interaction is pending or answered the turn is parked — no draft refresh, steering, supervisor budget, stall failure, continuation, completion, or silence — and a parked turn is never failed for elapsed time, because that time is the owner thinking. Only a thread BB has provably lost ends a parked turn.

Legacy controller-question storage remains as migration history and a one-release compatibility read for in-flight messages. It is never written again.

Two timeouts bound the ways an answer can go missing, and their ordering matters. A submitted turn that produces no BB event for eight minutes is treated as wedged: the turn fails with a message to the owner **and the thread is retired**, so the next message opens a fresh session. That deadline sits below the ten-minute limit on how long a queued message waits for a busy thread, so recovery happens before the queue starts failing behind it. A turn parked on an interaction is exempt — waiting on a person is not a stall.

A message the owner sends while an answer is still being written is steered into the running thread rather than queued behind it, so a correction lands while it can still correct something.

A controller answer may promise a later check-in only when that same turn has a completed receipt for a durable thread watch or schedule. Otherwise the settlement gate replaces the promise with an explicit statement that the work is unfinished and no follow-up is armed.

While Luna is connecting, thinking, or using tools, Telegram shows a live draft instead of a blank loading state. That draft is derived from the durable stream phase alone — never from provider text — so nothing partial or unaccepted is ever visible. The finished reply comes from the accepted finalization, not from the draft.

## What can become an answer

An owner-visible reply is one accepted structured finalization. There is no other path to one.

- **Evidence is same-turn.** Each capability call records a bounded evidence row — its source, outcome, proof kinds, and subject refs — against the current turn. A finalization's claims must reference those rows with compatible proof kinds and an exactly matching subject, and are rejected with a stable code otherwise. Evidence is capped at 128 rows per turn and a finalization at eight revisions; exceeding either fails the turn rather than answering unprovably.
- **Acceptance seals the boundary.** An accepted finalization records the evidence high-water mark it was validated against. If evidence advances afterwards, completion refuses and the turn is retired instead of delivering an answer that no longer matches what was observed.
- **Obligations are durable.** A deferred answer must name a live obligation — a non-terminal job, an armed controller monitor, or a running sealed delegation — that already exists. An intention is not a follow-up. An answered reply that promises to act at a later moment — "I'll take it through the merge once it lands" — is refused for the same reason: nothing in the plugin acts on prose, so the promise has to be a deferred answer resting on a live obligation. A promise the owner's own tap gates ("after approval") is left alone, because their reply is what wakes the agent. A `needs_owner` answer requires an active owner boundary, and stays parked until the exact interaction has been delivered to BB.
- **BB-native work is projected too.** Work the provider does natively — commands, file changes, tool calls — is reconciled into the same bounded evidence index before completion, so an answer can rest on it without the raw command or diff ever being retained.
- **Drafts are phase-only.** The Telegram draft is derived from the durable stream phase, never from provider text, so nothing partial or unaccepted is ever visible.

## Learning from finished jobs

Memory only grew when the agent chose to write something down, which meant it never learned the things it most needed: that a check always fails here for a known reason, that a repo enforces a convention, that work keeps going wrong in the same place.

A finished job is where those lessons live, so it is the one place the plugin spends inference of its own. When a job reaches a genuinely terminal outcome — merged, complete, blocked, or production-failed — it is enrolled for a single extraction. **`failed` is deliberately excluded: a failed job is still retryable, and a lesson drawn from an attempt that later succeeds is a wrong lesson.**

Enrolment scans for terminal jobs that have never been learned from rather than firing at the transition. That leaves the job state machine untouched and makes enrolment self-healing: a job finished during a restart is picked up on the next pass.

One extraction runs at a time, in a hidden thread on the job's own project, and is asked for strict JSON. Everything about the result is treated as untrusted: a fence or preamble is tolerated, a malformed entry costs that entry rather than the extraction, the cap counts usable lessons rather than attempts, and a lesson carrying credential-like text is refused by the ordinary memory guard. What survives is stored against the **project** scope — never the owner scope — at lower confidence than anything the owner said directly, because an extracted lesson is a guess about a pattern that has to earn its place by surviving.

## Keeping memory honest

Memory that only ever grows becomes memory that is mostly wrong, so two forces curate it, and neither needs a model.

**What the owner said next is the verdict on the last answer.** Every recall is linked to the turn it informed. When the owner's following message is a correction, exactly those memories lose confidence; when they move on, those memories gain a little. Demotion outweighs reinforcement, because being wrong in front of the owner is much stronger evidence than going unchallenged. A turn stays unscored until there *is* a next message — silence is not a verdict.

**Idle time ages out what was never useful.** Confidence decays on time since last recall rather than raw age, on a longer half-life than the ranking's, so a memory is never discarded faster than it is merely down-ranked. Only agent-written memories that were never recalled can be tombstoned; something the owner said out loud decays in confidence but never vanishes on a timer, and tombstoning sets `forgotten_at` rather than deleting.

A correction also retires the beliefs it contradicts. Two subjects contradict when one's words wholly contain the other's — "deploy on fridays" against "never deploy on fridays" — and only a `correction` may trigger it. A single shared word is a coincidence, and an ordinary restatement is not a refutation.

## Watching production

A canary runs once, immediately after a deploy. Between deploys nothing looks at production at all, which is how a crash loop runs for days while every job still reports green: the agent was watching its own work, not the thing its work produced.

A project policy may declare optional `healthCommands` — cheap, read-only checks, distinct from the canary because a canary is allowed to be neither. The executor runs them on `healthIntervalMs` (fifteen minutes by default) **without a model**, so a quiet week costs nothing but the commands themselves.

The agent is woken only when the answer changes. A single failure is a blip — a deploy in flight, a node restarting — so a fault is declared only after three consecutive failures, and one success clears the count. Crossing into failure wakes the agent once to investigate and tell the owner; recovery is reported once; everything in between is silence. The transition is claimed before the turn is enqueued, so a crash cannot report the same change twice, and a check that cannot be run at all is recorded as no evidence rather than as an outage.

## Self-maintenance

The plugin installs monitors it owns, keyed so installation is idempotent across restarts and exempt from the owner's armed-monitor cap: the agent's upkeep must not crowd out watches the owner set, nor consume slots they were counting on. They install on the first executor pass that finds a controller, because pairing can happen long after the plugin starts.

| Monitor | Cadence | Purpose |
| --- | --- | --- |
| `system-stale-jobs` | daily | Surface work that has stopped needing the agent and started needing a decision. |
| `system-memory-audit` | weekly | Re-judge the weakest memories and forget what is no longer true. |
| `system-autonomy-scorecard` | weekly | Report the durable scorecard. |

The first two are told to say nothing when nothing needs a person; upkeep that reports on quiet days trains the owner to ignore it. The scorecard is the deliberate exception, because it is a report rather than a sweep. Every figure it carries is read from committed state, so the agent can report what happened without inventing a rate the database cannot support.

## Controller delegation

A question often splits into independent pieces — different projects, different machines, different angles on one problem. Working through them in a single conversation is serial for no reason, and asking the agent to poll for its own subtasks turns every wait into wasted turns.

A delegation is a durable fan-out with a join. The controller opens up to four visible BB threads, each on its own managed worktree, and records them against one delegation row alongside the instruction it wrote to its future self. The delegation is written **before** any thread is spawned, so a failure partway through leaves threads that are still joined and reported rather than orphans nobody is waiting on. A spawn that fails after others have started returns a partial outcome and keeps watching the ones that did start; a spawn that fails first cancels the delegation and reports the error.

The monitor pass — which already turns durable obligations into controller turns — settles members as they land, capturing a clipped excerpt of each finished thread's output. When the last member settles, one turn is enqueued carrying the instruction and every result. The delegation is claimed before that turn is enqueued, so a crash mid-fire cannot replay it.

Two bounds keep the join honest:

- **Six hours.** A fan-out the owner is waiting on cannot hang on one wedged thread, so the join also fires on a deadline, describing any member still running rather than pretending it finished.
- **Withheld output.** Member summaries come from a shell the agent drove, which is a far wider exposure than the agent-authored text elsewhere in the system. A summary matching a credential shape — env-var assignments, key blocks, provider token prefixes — is replaced by a withheld marker instead of being stored and replayed into a later prompt.

At most two delegations are open per controller, and at most four threads each: eight threads is already more than one owner can follow in a chat.

## Working style

The fixed instructions are code-owned, but how the owner wants the agent to *work* — terser answers, always lead with the PR link — is theirs, and should not need a release. A single bounded overlay is stored durably and rendered after the fixed instructions on every turn, never before them, so it can adjust tone and habits but cannot argue its way past a boundary stated above. It is replaced wholesale rather than appended to, refused if it carries credential-like text, and cleared by setting it empty.

Background learning runs on its own model setting, defaulting to `inherit`. Extraction reads a repository and writes three sentences; it does not need the owner's conversational tier. `inherit` is the default because a model this installation's providers do not offer would fail every extraction.

## Controller supervision

The stall clock only catches a turn that goes silent. A turn that keeps producing events while getting nowhere is invisible to it, so the work is also bounded by the controller's evidence, tool, token, and failure budgets.

The reconcile loop already pages the BB event stream to redraw the Telegram draft. It now also counts what that stream reveals: tool-shaped item starts, non-zero command exits, and the cumulative token total. Those land on the turn row inside the same cursor-guarded update that advances the draft, so a replayed page cannot count twice.

A submitted turn is then judged against two kinds of budget:

- Crossing a **soft** budget — tool calls, tokens, or repeated command failures — spends one of two available nudges, steered into the running thread. Each reason may nudge only once: a tripped budget stays tripped on every later poll, so without that guard one crossing would nudge forever. A nudge that fails to deliver is not fatal; the hard budget still applies.
- Crossing a **hard** budget — tool calls or tokens — fails the turn with a short message to the owner **and retires the thread**, matching the stall path. Retiring is the half that matters: a turn stopped for cost that left its thread alive would let the next message resume the same loop.

The owner's own words outrank a budget nudge, so supervision runs only when nothing they sent is waiting to be steered. A turn parked on a question is exempt entirely — no budget should fire against a person's thinking time.

Budgets are constants rather than settings, on the same reasoning as the stall deadline: they are safety backstops well above any healthy turn, not a knob the owner should have to tune from a phone.

## Safety properties

- Exactly one private Telegram user/chat identity is paired. Multiple independent projects may be admitted up to the configured bound, but each project pipeline is serialized.
- The controller permission mode defaults to `auto`; explicit `auto`, `accept-edits`, and `full` values are preserved. It is not mechanically enforced isolation, and instruction text is not enforcement. The agent cannot approve a merge or merge code. Merging stays behind a Telegram approval the owner gives directly — a one-use approval, or a standing approval granted by button tap, never by the agent interpreting a sentence.
- `executor_v2` managed-job publication remains **disabled**. It requires versioned runtime BB attestations proving an atomic activity snapshot, an atomic expected-head-and-tree conditional commit with a deterministic request key, and mechanical denial of worker and controller native commit, ref mutation, push, GitHub write, merge, deploy, and equivalent network effects. The vendored BB thread, timeline, and interaction calls share no atomic activity revision and the commit API is unconditional, so that protocol cannot be implemented safely today.
- Every owner-visible answer is an accepted structured finalization bound to same-turn evidence. Raw provider prose reaches no draft, stored answer, digest, outbox row, finalization row, or reply; BB still owns its own provider transcript.
- The controller runs against an enforced manifest of exactly 28 Hanoon capabilities, and that manifest bounds only Hanoon's own tools. Work the provider does natively inside BB, or through an opaque third-party tool that emits no BB interaction or evidence boundary, is outside it — there is no Hanoon policy over an action Hanoon never sees.
- Hidden-controller questions and permission approvals bridge to Telegram with exactly *Allow once* and *Deny*, no session-wide grant, an owner tap that commits before BB is told, and recovery across restart. Legacy controller-question storage is migration history and a one-release compatibility read, never an active write path.
- The final answer is one durable logical outbox obligation, but Telegram delivery is **at-least-once**: an ambiguous send is retained as unknown, a retry may duplicate the Telegram message, and an attempt or an enqueue is never recorded as delivered.
- Reviewed code work goes through the job pipeline. The agent creates durable job intent through registered tools; it cannot spawn pipeline workers or touch a worktree directly.
- A mutating tool call runs at most once per turn for identical arguments. A call interrupted mid-flight is reported to the agent as an uncertain outcome to verify, never silently retried.
- Memory never stores credential-shaped text, and hidden threads stay unreachable from the thread tools.
- Project worker settings come from the job's immutable project policy. Changing the controller model or reasoning level does not rewrite an active job.
- Review verdicts are structured and bound to an exact full pull-request head SHA.
- Plan verification, validation receipts, documentation disposition, and every required review lens are checked from durable structured evidence before their transition can advance.
- Pull-request head evidence is resolved from `git ls-remote origin refs/pull/<number>/head`; cached API metadata is not the merge authority.
- Merge requires current review and validation evidence plus owner approval: an expiring, one-use approval, or a standing per-project approval the owner granted by button. A standing approval replaces only the owner's signature; every other check still runs, and unusual jobs still stop to ask. Concurrency and resource ownership never replace approval, and GitHub repository rules still apply.
- Deployment and canary commands are owner-authored policy inputs. They run only after the approved merge is confirmed and the worktree is detached at that merge commit.
- Tokens, pairing links, callback nonces, raw private messages, and credential-like command output are excluded from normal evidence and documentation.

See [Configuration](configuration.md) for the operator-controlled inputs and [Operations](operations.md) for recovery behavior.
