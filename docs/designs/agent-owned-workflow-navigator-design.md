# Agent-Owned Workflow Navigator Seam

Status: decision complete

Date: 2026-08-25

Wayfinder ticket: [Define the agent-owned workflow navigator seam](https://github.com/amrtawfik160/hanoon/issues/33)

Inputs: [skill migration research](matt-pocock-skill-migration-research.md), [workflow ownership research](workflow-ownership-invariants-research.md), and [work artifact and tracker research](work-artifact-tracker-research.md)

## Decision

Replace recipe selection and fixed knowledge-work stages with one versioned navigator that proposes a single next step from a read-only durable snapshot. Keep Hanoon's executor as the only component allowed to accept a proposal, mutate durable state, claim resources, invoke BB or tracker adapters, validate evidence, merge, deploy, or verify production.

The first navigator version uses one Hanoon job, one integration branch, and one managed worktree for the whole owner request. A fresh BB worker handles each decision or implementation ticket, but code-writing workers run sequentially under the existing one-writer claim. All accepted ticket work accumulates on the integration branch. Hanoon opens one final pull request and performs one exact-head release after the required tickets are complete.

This is intentionally narrower than parallel ticket branches or one pull request per ticket. It supports the requested end-to-end behavior without adding a second integration system. Later parallelism must introduce explicit branch partitions and integration evidence rather than weakening the one-writer rule.

## Module boundary

The navigator answers one question: what should Hanoon try next, and why?

The executor answers the authority questions: is that step legal now, what exact capability and model may run it, which resources may it touch, what result schema counts, and which durable transition follows?

```text
versioned job, artifacts, evidence, policy, and prior outcomes
                              |
                              v
                    navigator proposes one step
                              |
                              v
              executor validates the current snapshot
                              |
                   accepted /           \ rejected
                         v                 v
            transition plus effect     new durable fact,
            persisted atomically       no side effect
                         |
                         v
          fenced worker, tracker, release, or owner effect
                         |
                         v
          validated result becomes the next snapshot
```

The navigator receives values, not repositories or service objects. It has no BB, GitHub, Telegram, filesystem, merge, deployment, or database client. A skill cannot acquire those clients on its behalf.

## The small interface

The public navigator module needs one operation:

```ts
export interface WorkflowNavigator {
  propose(snapshot: NavigatorSnapshot): Promise<NavigatorProposal>;
}
```

`NavigatorSnapshot` is immutable and bounded. `NavigatorProposal` is a strict discriminated union. The exact names may change during implementation, but the information and authority boundary are normative.

```ts
type SnapshotIdentity = Readonly<{
  jobId: string;
  jobVersion: number;
  workflowRevision: number;
  digest: string;
}>;

type ProposalBase = Readonly<{
  basedOn: SnapshotIdentity;
  rationale: string;
  evidenceRefs: readonly string[];
}>;

type NavigatorProposal =
  | ProposalBase & Readonly<{
      kind: "invoke_skill";
      skillId: string;
      subjectArtifactIds: readonly string[];
      objective: string;
    }>
  | ProposalBase & Readonly<{
      kind: "start_release";
      implementationTicketIds: readonly string[];
    }>
  | ProposalBase & Readonly<{
      kind: "owner_boundary";
      boundaryCode: string;
      question: string;
      recommendedAction: string | null;
    }>
  | ProposalBase & Readonly<{
      kind: "unresolved_next_step";
      question: string;
      candidateSkillIds: readonly string[];
    }>
  | ProposalBase & Readonly<{
      kind: "finish";
      artifactIds: readonly string[];
    }>;
```

The executor calculates the proposal identity from the accepted content and snapshot digest. Echoing the snapshot identity prevents a delayed model response from acting on a newer job version. A stale, malformed, over-sized, unauthorized, or unsupported proposal is recorded as a rejection and creates no external effect.

The union stays small because low-level operations are executor concerns. The navigator does not propose `create_thread`, `edit_issue`, `push_branch`, `merge_pull_request`, `run_command`, or `retry_effect`. It names an admitted skill, asks for a release, identifies a valid owner boundary, reports that routing remains unresolved, or reports that the effort appears complete.

## Snapshot contents

The snapshot contains only facts needed to choose the next step:

- the original owner request and current project and policy identities;
- the task-level authority snapshot decided at intake;
- the navigator engine id and revision;
- the admitted skill catalog, invocation classes, descriptor digests, and relevant availability or denial facts;
- the current map, specification, ticket frontier, claims, artifact revisions, and immutable content digests;
- accepted workflow steps, their structured outcomes, and any supersession links;
- current worktree, branch, pull request, exact-head, review, validation, merge, deployment, and canary facts;
- unresolved findings, failure signatures, retry or cost limits, and an active operation if one exists;
- evidence references and bounded summaries instead of raw logs or mutable handles.

Large artifact bodies and logs are supplied through immutable attachments referenced by digest. They do not make the proposal payload unbounded. Secrets are never placed in the snapshot.

## Skill step contracts

An admitted skill descriptor is necessary but not sufficient to execute a workflow step. Hanoon needs an executor-owned step contract for each schedulable skill. That contract supplies:

- the invocation class copied from upstream frontmatter;
- allowed artifact subjects and operation class;
- read, artifact-write, or code-write resource requirements;
- the input packet builder and result schema;
- mandatory capability outcomes and evidence strength;
- tracker mutations that may be derived from a valid result;
- model pool constraints, timeout, output bound, and retry class.

The navigator chooses the skill and objective. The contract chooses mechanics and validates the result. This keeps upstream skill prose useful without treating free-form prose as an executable API.

User-invoked Matt Pocock skills can run only as an explicit `invoke_skill` proposal from the navigator or as an owner command. They are never placed in a general worker's auto-discoverable set. Model-invoked skills may be scheduled as top-level steps or attached as admitted disciplines inside a worker profile. Every accepted step binds the exact skill source revision, descriptor digest, step contract revision, catalog digest, model route, artifact snapshot digests, and job version.

Workers do not write the tracker directly. A skill such as `wayfinder`, `to-spec`, or `to-tickets` returns a structured artifact draft and relationship changes. The executor validates and stores that result, then applies remote mutations through fenced tracker effects with interrupted-call reconciliation. A code-writing skill may mutate only its claimed managed worktree. Pull request publication and all release operations remain executor effects.

## End-to-end navigation

There is no persisted array of stages. After each accepted outcome, the navigator receives a new snapshot and chooses again. The normal large-task path is evidence-driven:

1. Intake creates the navigator job, captures project policy and task authority, and selects the configured tracker without asking when project configuration already settles it.
2. If the destination is too unclear for a specification, the navigator explicitly invokes `wayfinder`. Research, prototypes, or focused owner decisions become separate map tickets only when they would materially change the result.
3. When the map is clear enough, the navigator invokes `to-spec` against the resolved decisions. The executor publishes one canonical specification and snapshots its accepted revision.
4. For work too large for one implementation context, the navigator invokes `to-tickets`. The executor publishes the parent and blocker graph, then exposes the ordered open, unblocked, unclaimed frontier.
5. The navigator selects one frontier ticket, records why it is the best next slice, and invokes `implement` in a fresh BB thread attached to that immutable ticket and specification snapshot. The executor claims the tracker ticket and the shared integration worktree before dispatch.
6. `implement` may use model-invoked disciplines such as `diagnosing-bugs`, `tdd`, `codebase-design`, and `code-review` through its admitted worker profile. Ticket-level checks and review evidence must pass before the executor resolves the ticket.
7. The job returns to navigation. The navigator chooses another frontier ticket, revisits the specification, runs research, or responds to evidence. A changed specification invalidates dependent snapshots and forces reconsideration instead of silently changing an active worker's requirements.
8. When required tickets are resolved and acceptance evidence is present, the navigator proposes `start_release`.
9. The release controller creates or refreshes the final pull request, resolves the exact head, runs required validation and independent review, applies documentation requirements, and either returns findings to navigation or advances through approval, merge, deployment, and canary under executor policy.
10. Only durable release evidence can satisfy `finish` for a software task. The executor rejects a completion proposal based only on closed issues, worker messages, commits, or an open pull request.

Small tasks can skip maps, specs, or tickets when the snapshot already contains enough acceptance detail. The navigator makes that judgment and records it. Release evidence cannot be skipped.

### Revision instead of fixed loops

Workflow revision is a new proposal against a new snapshot, not mutation of an old plan. Completed steps remain append-only evidence and may be marked superseded. A proposed but unstarted step may be superseded transactionally. An active step can be replaced only after its reversible worker is stopped and its resource claims are reconciled.

Validation or review findings return the job to navigation with exact-head evidence. The navigator may invoke `implement`, `diagnosing-bugs`, `research`, or another admitted capability instead of entering a hard-coded patch loop. Executor attempt limits, repeated-failure signatures, budgets, and project brakes still prevent infinite activity.

## `ask-matt` fallback

`ask-matt` remains a user-invoked upstream skill and is not made globally auto-triggerable.

When the navigator cannot choose a next step, it emits `unresolved_next_step` with the specific routing question, plausible admitted candidates, rationale, and evidence references. The executor first records that state. It may then explicitly schedule `ask-matt` only when:

- no workflow or release effect is active;
- the proposal was based on the current snapshot;
- each named candidate is admitted or has an explicit denial;
- the same unresolved decision digest has not already received `ask-matt` advice;
- the question concerns workflow routing, not missing credentials, merge authority, or another owner-only boundary.

The result is stored as advisory evidence and the navigator runs again. It does not execute a skill merely because `ask-matt` named it. If the same decision remains unresolved, Hanoon must choose a safe default, produce a valid owner-boundary proposal, or stop with an explicit policy block. It cannot loop through `ask-matt` on unchanged evidence.

## Release remains an executor submachine

The workflow becomes agent-owned, but the safety order around a release does not become optional model choreography. `start_release` enters an executor-owned release submachine that preserves:

- one final integration head and invalidation when that head moves;
- clean-worktree and repository identity checks;
- validation and independent review bound to the same head;
- required status checks and merge-method policy;
- task-level or one-use approval bound to the exact head;
- at-most-once merge and unknown-outcome reconciliation;
- base-branch content verification before production;
- deploy before canary, redacted receipts, rollback, and the project failure brake;
- truthful terminal states and durable owner delivery.

A required code or documentation change exits release back to navigation and revokes stale receipts. Retries of provider calls, lease recovery, and reconciliation remain executor decisions. Once valid task authority and every gate are present, merge, deployment, and canary continue without another navigator or owner round trip.

## Persistence and recovery

The additive storage model needs:

- a workflow engine id and revision on the job;
- immutable navigator snapshots and their digests;
- append-only proposals, acceptance or rejection records, step contracts, results, and supersession links;
- a current step pointer and one active operation constraint;
- artifact snapshots, tracker bindings, relationships, and leased claims from the tracker decision;
- attempt records bound to the workflow step and artifact snapshot, in addition to the BB resource;
- release findings and evidence links that can return control to navigation.

Proposal acceptance and effect creation are one transaction. A restart resumes a leased accepted step or reconciles its external mutation. It never asks the navigator to recreate an already accepted proposal. The navigator is called again only after the current durable step reaches a settled boundary.

The first version deliberately processes implementation tickets sequentially in one integration worktree. It may run independent read-only research or review lanes concurrently only when existing resource rules prove they are independent. Parallel code tickets are a later capability requiring separate worktrees, explicit branch ancestry, deterministic integration, and conflict evidence.

## Model routing

The navigator selects capability, not model. The executor replaces recipe-keyed model routing with a route derived from the step contract, effect risk, observed complexity, attempt history, and project override. Judgment-heavy navigation, wayfinding, architecture, and high-risk review require a strong route. Mechanical extraction or formatting may use a fast route. Implementation defaults to standard and escalates from durable failure evidence.

The chosen route is immutable for an attempt and remains part of capability evidence. Model failure recovery continues to use normalized signatures and bounded escalation.

## Additive migration

Persist `recipe-v1` or `navigator-v1` as the workflow engine on every job.

- Existing nonterminal recipe jobs continue through the legacy state handlers and their historical capability receipts.
- New jobs enter `navigator-v1` only after its feature gate is promoted.
- No job converts engines in place.
- Shadow navigation may record proposals for comparison, but it cannot create effects for a recipe job.
- Activation must drain every legacy job that still needs an executable Superpowers capability before the old bundle is deleted. Historical descriptors and receipts remain readable after the files are removed.
- Rollback routes new jobs to the previously deployed engine version and does not rewrite navigator history.

Knowledge-work states such as planning, critique, documentation selection, and fixed remediation become generic navigation and skill-step states for `navigator-v1`. The existing exact-head release states may remain behind the release boundary. New navigator code must not use the old recipe id to select skills, stages, models, or retry paths.

## Decision carried forward

The final specification can assume a one-method navigator, one-step proposals, executor-owned skill contracts, immutable snapshots, sequential ticket workers on one integration branch, a single final release, and a bounded `ask-matt` fallback. The remaining wayfinder decision defines which `owner_boundary` proposals are legal and when the original task grants merge and deployment authority.
