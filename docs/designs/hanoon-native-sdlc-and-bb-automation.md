# Hanoon-native full-SDLC and BB automation integration

Status: decision complete

Date: 2026-08-30

Inputs: the approved [agent-owned workflow navigator](agent-owned-workflow-navigator-design.md), [credential access platform](hanoon-credential-access-platform.md), [owner boundary and task authority](owner-boundary-and-task-authority-design.md), and ADR [0006](../adr/0006-orchestration-skills-use-native-adapters.md)

## Outcome

Hanoon will use BB as its execution platform and remain the only employee-facing control plane. It will use real BB threads, environments, worktrees, providers, models, machines, terminals, browser sessions, server sharing, and automations. Hanoon will add the task authority, credential protection, acceptance evidence, recovery, and Telegram reporting needed to turn those BB capabilities into one dependable software-development employee.

`orchestrate-implementation` and `review-fix-loop` are adopted as Hanoon-native recipes. Their useful safety rules are preserved, but their raw instructions do not receive a second worktree, branch, pull-request, reviewer, or release authority. Hanoon never says that the upstream skill ran when a native adapter ran.

The target is lifecycle coverage, not a false promise that every task succeeds. Hanoon owns each required phase and reaches either the requested task outcome or a truthful, evidence-backed owner boundary or terminal block.

## One SDLC owner

The workflow navigator chooses the next admitted operation from a durable snapshot. The executor remains the only component that may create an effect, claim a worktree, start a worker, mutate a tracker, publish or merge a pull request, deploy, roll back, or use managed credentials.

For the first native implementation recipe:

1. Freeze the accepted specification, ticket graph, base SHA, integration branch, worktree, capability catalog, and policy versions.
2. Claim one integration worktree and run implementation tickets serially. Each ticket uses a fresh BB thread and the exact accepted artifact snapshot.
3. Require a structured result for every stable acceptance-criterion id. Each result is `passed` or `blocked` and includes evidence for the exact implemented head.
4. Observe Git after each worker. The expected base must remain an ancestor, the worktree must be clean at publication boundaries, and the accepted ticket commits must be present on the integration branch.
5. Publish or refresh one final pull request for the complete owner request. Do not create a pull request per ticket in the first version.
6. Verify the remote pull-request base, head branch, and head SHA immediately after publication. A local push receipt is not enough.
7. Run the exact-head release gates, merge, deployment, canary, and rollback rules already owned by Hanoon's release executor.

Missing or stale BB resources are reconciled from observed BB and Git state. Hanoon resumes the existing accepted operation when safe. It does not create a replacement worker or publish again merely because a process restarted.

## Native review and repair

Every releasable code change receives two review axes:

- the accepted requirements and their stable acceptance criteria;
- repository and engineering standards selected from the observed change surface.

A standards-only review may produce useful findings but cannot approve release.

The native loop is:

1. A fresh reviewer inspects the exact remote pull-request head and returns strict structured findings.
2. Hanoon independently checks each claimed root cause against the repository and exact head.
3. The registry, not reviewer prose, classifies the checked finding as `must_fix` or `advisory`.
4. Confirmed `must_fix` findings enter an append-only finding ledger and return to one targeted repair worker. Advisory findings are reported and do not block release.
5. After repair, Hanoon proves the head changed, runs checks targeted to the changed surface and finding, and checks ledger closure. It does not rerun every expensive review after every repair.
6. The number of open confirmed `must_fix` root causes must decrease. One bounded recovery is allowed when evidence changed but the burden did not. A second plateau, the configured cycle limit, or the third recurrence of the same normalized root cause produces a truthful block.
7. When the ledger is clear, one fresh integrated reviewer checks the final exact head across both review axes before release continues.

Moving the head invalidates prior review and acceptance evidence. Findings remain historical evidence and change state to `resolved` or `disputed`; they are not deleted.

## Plain-language behavior

Simple language is a permanent conduct rule, not an optional personality:

> Lead with the result. Use simple, direct sentences. Use a technical term only when it adds needed precision, and explain it briefly the first time. Show internal detail only when it helps or the owner asks.

The bundled `/wait-what` skill remains the explicit repair command when the owner wants a previous answer explained again. Hanoon routes the exact command, but does not load it on every turn because the skill describes an after-the-fact re-explanation and disables normal model invocation.

The same contract applies to generated answers and deterministic Telegram messages. Default status cards say what is happening, what is waiting, and what the owner needs to do. Internal recipe names and raw state identifiers are hidden unless requested. Release tests cover the permanent conduct instruction, `/wait-what` routing, representative answers, and Telegram status snapshots. Hanoon does not claim strict ASD-STE100 compliance.

## Independent employee access

Each Hanoon installation uses dedicated employee accounts, workload identities, OAuth grants, and isolated browser profiles. It never imports the owner's personal browser profile. Secrets remain on a protected credential-broker host and are never returned to a controller, worker, reviewer, prompt, log, or browser observer.

An enabled project may use every pre-enrolled system it requires. Access does not grant authority: every action still needs the current task grant, project policy, connector operation, and evidence contract. New accounts or scopes, billing administration or new spend, destructive data operations, recovery actions, security-policy changes, and human-presence MFA remain owner boundaries.

Provider-native APIs and workload identities are preferred. Deterministic CLI connectors are second. Authenticated browser journeys are used only where no safer interface exists. Each qualified connector declares exact operations, minimum scopes, allowed origins, serialized session leases, verification, reconciliation, and rollback where the provider supports it. Browser-enabled workers receive typed actions and results, not cookies, passwords, arbitrary credential-page JavaScript, or secret readback.

The first provider package will cover Convex, Vercel, and the exact service meant by `Qlify` after that service is identified. Existing pre-authenticated deployment commands remain transitional and do not count as completion of the access platform. Production readiness requires the protected-host topology and the live acceptance matrix.

## BB automation ownership

BB is the source of truth for clock-based automations and their run history. Hanoon will create, inspect, update, pause, resume, run, and retire real BB automations through a native adapter. Each binding records the BB automation id, project, owner source, task-authority scope, operation contract, notification policy, and last reconciled run evidence. Hanoon does not keep a second cron schedule for the same work.

Automation type follows the work:

- use a BB `script` automation for deterministic checks, health probes, thresholds, and fixed commands;
- use a BB `agent` automation when the work needs judgment, investigation, or a software-development workflow.

Every agent automation declares its project, provider/model route, environment or worktree policy, permission ceiling, timeout, and result contract. A scheduled prompt cannot grant new authority. A run may use only authority already present in its managed-automation binding and current project policy. Automation-created threads cannot create or widen automations; this is a deliberate recursion boundary.

Hanoon keeps event monitors for thread completion, job completion, stalls, and Telegram follow-up because those wake from lifecycle events rather than wall-clock time. Existing Hanoon clock schedules migrate once to BB automations with definition and next-run equivalence checks. A migration records one source of truth before disabling the old schedule. No task may be active in both schedulers.

Clean routine runs stay quiet. Hanoon messages the owner when a run produces a material result, needs a decision, reaches a terminal block, or repeatedly fails. BB's run record proves that execution occurred; Hanoon's exact outcome and evidence contract proves whether the requested work completed.

## Delivery order

1. Make `navigator-v1` production-real: spawn and observe actual BB workers, publish or refresh the real final pull request, and verify its remote base and head.
2. Add stable acceptance-criterion results, the finding ledger, independent verification, decreasing-burden convergence, and the final integrated exact-head review.
3. Make the plain-language conduct permanent, route `/wait-what`, and simplify deterministic owner messages.
4. Add the Hanoon-native BB automation adapter and migrate clock schedules without duplicating them. Keep event monitors unchanged.
5. Reconcile the two existing authority descriptions, qualify the protected credential topology, then add typed Convex, Vercel, and browser-session connectors with live acceptance evidence.
6. Promote each capability through shadow trials and fail closed until its required evidence is available.

The order deliberately makes the normal code-delivery path truthful before giving scheduled or credentialed work broader reach.

## Acceptance

This integration is complete only when automated and live tests prove:

- a multi-ticket navigator job uses fresh real BB workers in one managed integration worktree and creates one final pull request;
- each acceptance criterion has exact-head evidence and standards-only output cannot satisfy release;
- confirmed blockers converge through the finding ledger and a final fresh reviewer approves the final remote head;
- `/wait-what` routes exactly and ordinary first answers and status messages pass the plain-language contract;
- a BB script automation and BB agent automation can be created, reconciled after restart, run under bounded authority, and reported without a second Hanoon cron;
- an authenticated provider operation and browser journey succeed without any model-readable secret and produce redacted authoritative evidence;
- merge, deploy, canary, rollback, and owner boundaries remain correct after all additions.
