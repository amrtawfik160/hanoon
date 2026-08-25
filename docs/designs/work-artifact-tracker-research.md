# Durable Work Artifact and Tracker Research

Status: research complete

Date: 2026-08-25

Wayfinder ticket: [Trace durable specification, ticket, and tracker options](https://github.com/amrtawfik160/hanoon/issues/32)

Inspected upstream revision: [`6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`](https://github.com/mattpocock/skills/commit/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76)

## Verdict

Hanoon needs two related records with different authority:

- The configured issue tracker is the canonical collaboration surface for maps, specifications, decision tickets, implementation tickets, parent relationships, blockers, claims, resolution comments, and links that the owner or another engineer should see.
- Hanoon's SQLite store is the canonical execution and evidence ledger. It mirrors tracker identities and revisions, snapshots the exact artifact content a job is working against, fences tracker mutations, links artifacts to BB attempts and release evidence, and decides whether an external status is earned.

For a project whose remote is GitHub, use GitHub Issues by default. GitHub now exposes issue hierarchy and blocker relationships through both the CLI and REST API, and the current Hanoon repository has already proven those operations with the live wayfinder map. For a project with no supported remote, use the upstream local Markdown layout as a compatibility fallback. BB threads and Hanoon jobs must not become the tracker: they are execution resources and lack the shared artifact, dependency, and collaboration contract.

The first implementation should provide one tracker adapter contract with GitHub and local Markdown adapters. BB Tasks can be considered as a later optional adapter. It is currently disabled, is not part of the Matt Pocock tracker templates, and its inspected surface has hierarchy, statuses, comments, attachments, and attached threads but no native blocker graph in its CLI contract.

## Upstream artifact lifecycle

The promoted skills describe a coherent planning and implementation vocabulary, but they do not provide a durable supervisor that chains the whole lifecycle.

| Skill | Artifact or operation | Durable representation | Important behavior |
| --- | --- | --- | --- |
| `setup-matt-pocock-skills` | Project tracker configuration | `docs/agents/issue-tracker.md`, plus domain and optional triage configuration | Inspects the repository, recommends GitHub when a GitHub remote exists, and otherwise supports GitLab, local Markdown, or a described custom tracker. It expects a user choice before writing. |
| `wayfinder` | Map and decision tickets | One map issue or file, one child issue or file per decision | The map is a low-resolution index. Decision detail lives in the child ticket. Native parent and blocker relationships are preferred. Assignment is the visible claim. Resolution is a comment or answer, issue closure, and a one-line map pointer. |
| `to-spec` | Specification | One issue on a real tracker, or `.scratch/<feature>/spec.md` locally | Synthesizes current context, confirms test seams with the user, publishes one spec, and marks it ready for an agent. It defines no immutable execution snapshot or relationship to a later release. |
| `to-tickets` | Implementation tickets | One issue or file per tracer-bullet slice | Creates parent references, acceptance criteria, blocker edges, and ready-for-agent state. It asks the user to approve granularity and dependencies before publishing. It does not close or modify the parent spec. |
| `implement` | Code change | Current branch and commit | Implements a supplied spec or ticket, uses TDD where possible, runs focused and full verification, invokes code review, and commits. It does not claim or close a ticket, choose the next frontier item, open or merge a pull request, deploy, run a canary, or reconcile after restart. |

Sources: [`setup-matt-pocock-skills`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/setup-matt-pocock-skills/SKILL.md), [`wayfinder`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/wayfinder/SKILL.md), [`to-spec`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/to-spec/SKILL.md), [`to-tickets`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/to-tickets/SKILL.md), and [`implement`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/implement/SKILL.md).

### Identities and relationships

The upstream tracker, not a generated slug, gives each remote artifact its identity. Wayfinder uses a parent map plus child issues, and implementation tickets refer back to their source spec. Native blockers define the frontier. Local Markdown substitutes numbered filenames, `Blocked by` fields, and explicit status lines.

The required relationship vocabulary is small:

- `parent`: map to decision ticket, or spec to implementation ticket;
- `blocks`: one ticket must resolve before another is eligible;
- `derived_from`: a spec came from a map, or tickets came from a spec;
- `executed_by`: an artifact was handled by a Hanoon job and one or more BB attempts;
- `delivered_by`: implementation work reached a pull request, merge commit, deployment, and canary evidence.

The first two should use tracker-native relationships when available. The last three are Hanoon evidence links and should not be encoded only in prose.

### Claims and frontier

Wayfinder treats assignment as the human-visible claim and defines the frontier as open, unblocked, and unclaimed children in tracker order. This prevents two sessions from choosing the same ticket when every participant follows the same convention.

Hanoon needs a stronger internal claim as well. A remote assignee has no lease, can outlive a crash, and can be edited by a person. Claiming a ticket should therefore be one fenced operation that:

1. refreshes the artifact and open blocker state;
2. records a Hanoon claim bound to the effort, artifact, job, executor generation, and expiry;
3. publishes the visible tracker claim;
4. reconciles an ambiguous remote response before creating any worker attempt.

The visible assignee and internal lease represent the same claim for different audiences. A restarted executor may adopt the internal claim only through the same generation and resource-claim rules used for other Hanoon work.

### Interaction assumptions

The upstream playbooks intentionally contain human checks:

- setup asks which tracker and instruction file to use;
- wayfinder grilling and prototypes are human-in-the-loop;
- `to-spec` checks the proposed test seams;
- `to-tickets` quizzes ticket granularity and blocker edges.

Hanoon must not impersonate the human side of a genuinely human-in-the-loop decision. It can skip a new interaction when the task instruction, closed wayfinder decisions, project policy, and owner-boundary policy already settle the choice. The remaining authority question belongs to [Define the owner boundary and task-level shipping authority](https://github.com/amrtawfik160/hanoon/issues/34).

## Current Hanoon support

### Reference documents are a useful content index, not a tracker

Hanoon already stores project and global reference documents in SQLite. It parses Markdown into a bounded structural map and searchable passages, keeps one live version per title, records which sections changed, scopes project references, and briefs pipeline workers. See [`src/reference/document.ts`](../../src/reference/document.ts), [`src/storage/reference-repository.ts`](../../src/storage/reference-repository.ts), [`src/reference/briefing.ts`](../../src/reference/briefing.ts), and [`src/bb/runner.ts`](../../src/bb/runner.ts).

That is reusable for reading a specification, but it lacks:

- artifact kinds, parent links, blocker edges, claims, readiness, resolution, and frontier queries;
- a stable tracker binding and remote revision;
- a link from a job to the exact specification or ticket revision it accepted;
- a relationship between several tickets and one release candidate;
- immutable historical content needed by an in-flight job after the current document is replaced.

The current controller filing tool also accepts only a specification supplied in an owner-originated message. An autonomous `to-spec` result cannot be filed through it. See [`src/controller/tools.ts`](../../src/controller/tools.ts).

The parser and search index should remain a downstream view of the current canonical specification. They should not be overloaded into a work queue. A job needs an immutable artifact snapshot and digest even when the searchable current version later advances.

### Jobs hold execution state, not work structure

A Hanoon job persists the owner request, project policy snapshot, recipe, traits, worker ids, pull request and head, merge facts, production summaries, state, and version. It has no effort id, artifact id, spec revision, parent, blockers, frontier position, or ticket completion record. See [`src/domain/models.ts`](../../src/domain/models.ts), [`src/storage/job-persistence.ts`](../../src/storage/job-persistence.ts), and [`src/storage/store.ts`](../../src/storage/store.ts).

The controller currently starts one guarded software-lifecycle job from one Telegram turn and usually prevents unrelated work from entering the same project unless it is marked separate. A large effort needs a durable parent that can sequence several artifacts without pretending each ticket is a new owner request. Whether those become child jobs or typed steps of one navigator job belongs to the navigator design.

### BB threads are execution resources

Runtime inspection shows that BB persists thread ids, parent ids, status, history, environment and worktree association, provider settings, attachments, and final output. Multiple review and implementation threads can share an environment. That makes a thread a strong worker attempt resource.

It is not a work artifact by itself:

- a title is presentation, not a stable ticket identity;
- parent threads express execution lineage, not arbitrary blocker edges;
- thread status does not mean acceptance criteria passed, a pull request merged, or production was verified;
- there is no tracker-wide frontier or visible claim contract;
- archiving the last thread in a managed worktree can destroy that environment, while specifications and tickets must remain.

Hanoon should attach artifact and snapshot ids to its own attempt records, then bind those attempts to BB thread or terminal ids. A thread may stop, compact, archive, or be replaced without changing the artifact identity.

## Tracker comparison

| Property | GitHub Issues | Local Markdown | BB Threads | BB Tasks today | Hanoon SQLite today |
| --- | --- | --- | --- | --- | --- |
| Shared human-visible artifacts | Strong | Files only | Conversation-oriented | Strong inside BB | Telegram projections only |
| Parent hierarchy | Native sub-issues | Filename and body convention | Parent thread only | Parent task | None for work artifacts |
| Blocking graph | Native issue dependencies | `Blocked by` convention | None | No native blocker contract inspected | Resource claims only, not ticket blockers |
| Visible claim | Assignee | Status line | Active runtime, not a claim | Attached/delegated thread | Job admission, not artifact claim |
| Discussion and resolution | Comments and close state | Appended sections and status | Timeline and final output | Comments and status | Evidence and outbox, not a collaboration record |
| Restart behavior | Remote durable | Same-disk durable | BB durable | BB plugin durable when installed | Durable and fenced |
| Multi-host collaboration | Strong | Weak unless separately synchronized | Strong through BB | Strong through BB | Plugin-instance local |
| Delivery proof | Links only | Prose only | No | Pull request association, not Hanoon gates | Strong exact-head, merge, deploy, and canary evidence |

GitHub officially supports nested sub-issues and exposes parent and progress data in the CLI. Its REST APIs list and mutate both sub-issues and issue dependencies. Dependencies are available on GitHub Free, Pro, Team, and Enterprise Cloud. Sources: [adding sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues), [sub-issue REST endpoints](https://docs.github.com/en/rest/issues/sub-issues), [creating issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies), and [dependency REST endpoints](https://docs.github.com/en/rest/issues/issue-dependencies).

The live Hanoon map currently has five native sub-issues. Closed research tickets are reflected in parent progress, and the remaining navigator ticket reports the three research tickets as blockers. This proves the desired GitHub representation against the target repository, not only against documentation.

The upstream tracker templates are the portability reference: [GitHub tracker operations](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md) and [local Markdown operations](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/setup-matt-pocock-skills/issue-tracker-local.md).

## Required tracker adapter contract

The later design can assume a project-scoped adapter with these behaviors, without making the navigator aware of GitHub CLI commands or local filenames:

1. Discover or load the configured tracker binding.
2. Create, read, and update a bounded map, specification, or ticket.
3. Create and query parent and blocker relationships.
4. List the ordered frontier of open, unblocked, unclaimed children.
5. Claim, renew, release, resolve, cancel, and rule an artifact out of scope.
6. Append a resolution or progress comment without rewriting user-owned text.
7. Return a stable external identity, URL or path, observed revision, content digest, relationships, status, and assignees.
8. Reconcile every ambiguous mutation by Hanoon's stable operation marker before retrying.

Tracker writes are external mutations and must run as leased effects. For GitHub, Hanoon should place an unobtrusive stable marker in artifacts it creates and query for that marker after an interrupted create, because repeating a create can produce duplicate issues. Before editing a body, it should refresh the remote artifact and change only the section or marker it owns. For local Markdown, it should use an atomic replacement and compare the previously observed digest so a concurrent edit fails closed.

The adapter must normalize tracker capabilities instead of pretending every backend is equal. When native parent or dependency relationships are unavailable, it may use the upstream body convention and report that degraded representation. A backend with no safe claim or compare-and-swap behavior cannot run parallel frontier workers.

## Artifact snapshots and completion

The tracker body or local file is the editable collaboration source. A claimed job runs against an immutable Hanoon snapshot containing at least the artifact identity, tracker revision, normalized body, content digest, relationship set, and acceptance criteria. If the source changes materially, Hanoon invalidates affected downstream work and asks the navigator to re-evaluate. It does not silently switch a running worker to new requirements.

External status is not delivery proof:

- Closing a decision ticket means its resolution comment and map pointer are durable.
- Marking a spec ready means its required decisions and test seam are settled, not that any code exists.
- Closing an implementation ticket requires its acceptance evidence and its chosen integration outcome to be durable.
- Completing the large effort requires every required ticket to be resolved, the final approved head to be reviewed and validated, the merge to be confirmed, deployment to succeed when configured, and canary verification to succeed.

Hanoon should publish tracker closure only after the corresponding internal evidence transaction succeeds. A person closing an issue manually is an observed request or override to reconcile, not proof that code shipped. Likewise, a BB thread finishing is worker evidence, not artifact completion.

## Decision carried forward

Use GitHub Issues as the default collaboration surface for GitHub projects and local Markdown as the no-remote fallback. Add a common tracker adapter plus a durable Hanoon artifact projection, immutable execution snapshots, leased tracker effects, internal claims, and links from artifacts to jobs, attempts, pull requests, merge facts, deployment, and canary evidence. Reuse the existing reference parser and search index for specification reading, but do not turn reference documents, BB threads, or current jobs into the tracker.

This research does not decide whether one large effort owns one integration branch or several ticket pull requests, whether tickets become child jobs or navigator steps, or which decisions consume task-level shipping authority. Those belong to the remaining wayfinder tickets.
