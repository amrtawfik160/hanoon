# Disposable live acceptance

This runbook is for owner-only live acceptance after the automated test suite passes. It collects evidence from a real Telegram bot, BB environment, disposable GitHub repository, and disposable production commands. It is not a substitute for the mocked end-to-end test, and this documentation update is not a live run. No live Telegram/provider acceptance has been run for the current trust-kernel documentation.

## Hard boundaries

- Use a disposable GitHub repository or a disposable test branch whose merge is safe to undo. Never use a production application repository.
- The owner enters the Telegram bot token in **Extensions → Plugins → Telegram Agent**. Do not request the token in chat, put it in a command, or record it in evidence.
- Do not record pairing codes, bot tokens, provider credentials, raw private message content, or raw command output containing secrets.
- Record identifiers, digests, SHAs, statuses, and bounded summaries only.
- A live run is not successful unless every required step has evidence. HTTP 200, static tests, or a plugin registration row alone is not live acceptance.
- Every required evidence row below is mandatory. An empty, pending, unavailable-without-an-explicit-value, or ambiguous row makes the live result **incomplete**, never **passed**.

## Evidence boundaries

Keep these proof classes separate in the final record:

| Proof class | What it can establish |
| --- | --- |
| Local tests and typecheck | Deterministic code contracts only; they do not prove Telegram, GitHub, deployment, or canary behavior. |
| Local skill-bundle verification | The committed manifest roots, lock, skill bytes, names, resources, provenance, and bundle digest are internally consistent; it does not prove that a real provider session received or used a role skill. |
| Real Telegram | Pairing, commands, replies, callbacks, delivery, and owner-visible recovery. |
| Live BB and GitHub mutation | Thread/environment identity, executor takeover, pull-request head binding, review, approval, and exactly one merge. |
| Disposable deploy command | Exact merged checkout, production-target exclusion, command receipt, and failure classification. |
| Disposable canary command | Post-deploy verification and the terminal `complete` decision. |

## Token configuration pause

Before this runbook begins, the owner must perform exactly this UI action:

**Extensions → Plugins → Telegram Agent → enter the bot token in the secret setting and save it.**

The agent must not request or receive the token in chat. After the owner confirms that UI action, continue with the commands below.

## Evidence sheet

Fill this sheet with placeholders or redacted values. Use one row per attempt where a field repeats.

| Evidence | Value |
| --- | --- |
| plugin id and installed path | `telegram-agent`, `<local path without private parent details>` |
| plugin restart time(s) | `<UTC timestamp>` |
| pairing Telegram message id(s) | `<message id>` |
| task/status/review/approval/completion message ids | `<message ids only>` |
| controller BB thread/project/host ids | `<thread id>`, `<personal project id>`, `<host id>` |
| controller execution tuple | `<claude-code or codex>`, `<selected model>`, `<reasoning>`, `<service tier>`, `<permission mode>` |
| controller conversation check | `<ordinary question received a natural answer and created no job>` |
| paired owner identity | `<redacted Telegram user/chat identifiers>` |
| configured project alias | `<alias, not a private path>` |
| disposable project id and branch | `<project id>`, `<test branch>` |
| work-order attachment name and SHA-256 | `<name>`, `<64-hex digest>` |
| review-packet attachment name and SHA-256 | `<name>`, `<64-hex digest>` per review |
| implementation BB thread id | `<thread id>` |
| review BB thread ids | `<thread id>` per attempt |
| implementation environment id | `<environment id>` |
| review environment ids | `<same environment id>` per attempt |
| implementation skill-provider evidence | real thread id: `<pending>`; role: `implementation`; selected ids: `systematic-debugging`, `test-driven-development`, `verification-before-completion`, `clean-code-guard`, `test-guard`, `pr-writer`; bundle digest: `<pending>`; provider-session outcome: `<pending>` |
| review skill-provider evidence | real thread id: `<pending>`; role: `review`; selected ids: `clean-code-guard`, `test-guard`; bundle digest: `<pending>`; provider-session outcome: `<pending>` |
| documentation skill-provider evidence | real thread id: `<pending>`; role: `documentation`; selected ids: `docs-guard`, `verification-before-completion`; bundle digest: `<pending>`; provider-session outcome: `<pending>` |
| final-review skill-provider evidence | real thread id: `<pending>`; role: `final-review`; selected ids: `clean-code-guard`, `test-guard`, `docs-guard`; bundle digest: `<pending>`; provider-session outcome: `<pending>` |
| spawn-versus-fork proof | `<spawned=true, forked=false>` |
| executor owner and generation | `<owner id>`, `<generation>` |
| losing executor owner/generation result | `<not acquired or fenced>` |
| configured concurrency cap | `<1-8; use 2 for the concurrency matrix>` |
| admission/lane observations | `<queued/admitted/draining/released counts and pipeline/control use>` |
| project/repository/production resource observations | `<bounded kind/key pairs and waiting job ids>` |
| concurrency fixtures | `<independent projects; same project; shared repository; shared production target>` |
| liveness source and state | `<bb_thread/bb_terminal>`, `<starting/active/idle/stale/unknown/...>` |
| pull request number and URL | `<number>`, `<URL>` |
| first `git ls-remote` OID(s) | `<full SHA>` per lookup |
| second `git ls-remote` OID(s) | `<full SHA>` per lookup |
| deliberately stale `gh` head metadata | `<old SHA shown by gh>` |
| old and new pull-request head SHAs | `<old full SHA>`, `<new full SHA>` |
| review verdicts | `<changes_requested/pass/block>` per attempt |
| validation commands and outcomes | `<command name>: <pass/fail>` |
| stale approval outcome | `<rejected/stale; no merge call>` |
| fresh approval outcome | `<accepted>` |
| merge response | `<bounded response summary>` |
| merge commit | `<full merge commit SHA>` |
| base content verification | `<pass/fail plus terminal id>` |
| production checkout | `<detached HEAD equals merge commit>` |
| deploy receipt | `<command names/outcomes and terminal ids>` |
| canary receipt | `<command names/outcomes and terminal ids>` |
| production state | `<complete or production_failed>` |
| restart recovery result | `<completion delivered; no second merge>` |
| final `bb plugin list --json` status | `<installed/running status>` |
| normal accepted finalization id and exact evidence refs | `<finalization id>`; `<evidence:ids in the accepted finalization>` |
| live current-status evidence | `<live job/thread/monitor status id and bounded observation>` |
| one process-only continuation with no leaked draft | `<continuation id>`; `<phase-only draft evidence>`; `<raw provider prose leaked=false>` |
| auto-mode permission interaction id | `<controller interaction id>`; `<permission mode=auto>` |
| Allow once exact resolution | `<interaction id>`; `<resolution=allow_once>`; `<BB resolution receipt>` |
| restart between tap persistence and BB resolution | `<restart time>`; `<answer persisted before restart>`; `<exact resolution after restart>` |
| armed monitor obligation for deferred response | `<monitor id>`; `<state=armed>`; `<deferred finalization obligation ref>` |
| unsupported-success count zero | `<count=0>`; `<fixed report path/digest>` |
| stale capability approval denied before effect | `<interaction/effect ids>`; `<denied>`; `<effect count=0>` |
| fixed report path/digest, budgets, denominators, outcomes, and cost availability | `<path>`; `<digest>`; `<budgets>`; `<denominators>`; `<outcomes>`; `<cost available or unavailable/null explicitly>` |
| explicit assertion no merge/deploy/credential/spend/destructive action exercised | `<assertion>`; `<bounded call counts>` |

The eleven trust-kernel rows are part of the acceptance gate, not explanatory notes. A row is complete only when its identifier or explicit zero/unavailable outcome is recorded with a bounded source. Any incomplete row forces the overall live result to **incomplete**, never **passed**.

The Task 14 historical fixed before/after comparison is not currently comparable: the original fake-provider baseline recorded token availability as `0`, while the current audited harness reports token availability as unavailable/null. Do not report that comparison as fixed or passed. Cost availability must likewise be recorded explicitly as available or unavailable/null in the fixed report row.

## Acceptance procedure

### 1. Pair the owner

After the owner has configured the token, run:

```bash
bb telegram-agent pair
```

Open the short-lived link from the intended owner account in a private chat. Record only the Telegram message id and the paired identity in redacted form.

### 2. Enable the disposable project

Create a policy JSON that names the disposable `proj_...` project, its GitHub repository, test branch base, implementation/review profiles, deterministic validation commands, required checks, redaction patterns, liveness watchdog, review limit, merge method, and disposable deploy/canary commands. Include an operator-only rollback command if desired. If the fixture uses Convex, set `convexDeployRequired` and invoke `convex deploy` through the Convex CLI. Enable it with an absolute policy file or JSON input:

```bash
bb telegram-agent project enable <disposable-project-id> --policy-file /absolute/path/to/policy.json
bb telegram-agent doctor <disposable-project-id>
```

Record the alias and doctor check statuses. Do not record the policy file contents if they contain private paths.

### 3. Verify the controller conversation

Send an ordinary question such as which projects are available. Confirm that BB creates one hidden plugin-owned controller thread in the personal workspace with the execution tuple currently saved in plugin settings. The host must be the personal project's selected source host, or the only connected BB host when the personal project has no source. Confirm Telegram receives a natural answer and `bb telegram-agent job list --json` still shows no new job.

Record only the message ids and bounded answer summary, not the raw private conversation.

### 4. Prove bounded admissions and resource exclusions

Set **Maximum concurrent jobs** to `2`. Prepare disposable policies and controlled tasks that can pause at known boundaries. The controller must use `telegram_agent_list_projects` when project selection is needed and `telegram_agent_start_job` to commit each guarded job. If more than one project matches, answer the controller's project question; there is no deterministic project-picker or Start callback in the conversational path.

Run and record all four cases. Use `job list/show --json` for bounded admission/resource projections and the structured health report for lane counts; do not infer concurrency from timestamps alone.

1. **Independent projects:** queue two jobs whose project ids, repositories, and production targets differ. Both must become `admitted` and make pipeline progress concurrently under cap `2`.
2. **Same project:** queue two controlled jobs for one project. The earlier queue sequence must be `admitted`; the later must remain `queued` until the first becomes `released`, then admit in FIFO order.
3. **Shared repository:** use two distinct BB projects that resolve to the same canonical GitHub repository. Pause the first at the disposable merge boundary. It alone may hold the normalized `repository_merge` claim; the other job must report that kind/key as waiting and must not call merge until release.
4. **Shared production target:** use distinct repositories with the same explicit `production.targetKey`. Pause the first disposable deployment. It alone may hold the `production_target` claim; the other job must report the shared target as waiting and must not run deploy or canary until release.

For each case, record Telegram status ids, admission states, queue sequence, cap/occupied/available fields, live lane counts, held/waiting resource kind/key pairs, and provider/command call counts:

```bash
bb telegram-agent job list --json
bb telegram-agent job show <job-id> --json
```

Do not record raw private message text or claim-owner internals. Finish or cancel the extra fixtures and verify their admissions become `released`. Choose one independent-project job for the remaining end-to-end pipeline steps.

### 5. Capture implementation handoff and worker isolation

Verify that the leased executor creates a visible implementation thread in a managed worktree on the disposable project's exact source host. Record the thread id, environment id, work-order filename/digest, executor owner/generation, and liveness source/state. Confirm the implementation input uses an attachment and a small handoff prompt. Prove that the thread was spawned and not forked. Confirm the hidden controller remains in its personal workspace and cannot see the implementation checkout.

#### Skill-provider observations (pending follow-up slice)

The deterministic `npm run skills:verify` gate proves only the committed bundle's structure, provenance, and bytes. It does not prove provider skill use. In the separately approved receipt/acceptance slice, capture one real BB thread id, the exact role, selected skill ids, the verifier's bundle digest, and the bounded provider-session outcome for each non-empty profile: `implementation`, `review`, `documentation`, and `final-review`. Keep the four evidence rows above **pending** during this slice; persistent skill receipts do not exist yet, so these observations cannot be marked passed or treated as complete live skill-use evidence.

### 6. Observe the PR and bind its exact head

When the implementation thread is idle with a pull request, record the PR number/URL and the full SHA returned by each required `git ls-remote --exit-code origin refs/pull/<number>/head` lookup. The stored job head must be the Git-native full SHA, not a `gh` metadata shortcut.

### 7. Run the first review and forced remediation

Verify a visible spawned review child in the implementation environment, its immutable review-packet filename/digest, and its liveness source/state. Confirm it has a fresh provider conversation rather than the implementation transcript. Supply a strict JSON `changes_requested` verdict. Record the verdict and bounded finding summary. Confirm remediation is sent to the original implementation thread and that the review attempt remains bound to its original head.

### 8. Produce a new implementation head and fresh review

After remediation, wait for the implementation worker to become idle with a new full head SHA. Record the old/new SHAs, a new review child id, attachment digest, spawn-versus-fork proof, and exact environment reuse. Supply a strict JSON pass verdict only for that new SHA.

### 9. Validate and deliberately stale the first approval

Run the configured deterministic validation and record command names/outcomes, both Git-native head OIDs, required checks, clean-worktree evidence, and liveness observations. Issue the merge approval. Before clicking it, make the disposable branch’s `refs/pull/<number>/head` move while serving deliberately stale `gh` head metadata. Click the old approval and record the stale/rejected outcome. Confirm there was no merge SDK call.

### 10. Fresh review, validation, and approval

Confirm stale handling resolves the new exact Git-native head, revokes the old approval, and starts a third fresh review attempt. Record its review-packet digest, thread/environment ids, verdict, validation commands, both head OIDs, and the new one-use approval. Do not reuse the old approval callback.

### 11. Restart, adopt exact claims, race executors, and merge once

With the selected job admitted and its controlled merge/production resources held, restart the current plugin service and let a successor executor acquire a new generation. Record that it first reconciles the exact job, then adopts every same-job held claim; no foreign or released claim may change owner/generation. Ordinary pipeline work must remain fenced until that sequence succeeds.

Also start or exercise a losing executor instance at the merge boundary. Record the winning executor owner/generation and the losing instance’s rejected acquisition or lease-fence result. Accept the fresh **Merge + deploy** approval and record the bounded merge response, one BB merge SDK call, post-merge GitHub confirmation, full merge commit SHA, exact detached production checkout, ordered disposable deployment commands, ordered canary commands, terminal-owned liveness, and separate `DEPLOY`/`CANARY` receipts. A second merge, deploy, or canary call is a failure.

### 12. Fail delivery, restart, and recover completion

Cause the first Telegram completion delivery to fail in the disposable run, record the failure as a bounded liveness/outbox event, restart the plugin services, and verify that completion is delivered from durable state without a second merge, deploy, or canary. Record restart time, final completion message id, and:

```bash
bb plugin list --json
bb plugin logs telegram-agent -n 50
```

Record the final installed/running status and confirm logs contain no crash loop and no secret material.

Also exercise one recoverable Telegram failure: an expired callback must not replay, or an uneditable status must be replaced and its new message id persisted. Record the classification and bounded recovery outcome without recording the response body.

## Final acceptance decision

For an actual run, accept only when the evidence sheet contains the controller tuple and personal-workspace isolation, the no-job conversational check, all required ids, attachment names/digests, thread/environment relationships, fresh review conversations, all four concurrency/resource cases, exact post-reconcile claim adoption, executor fencing, liveness source/state, old/new full SHAs, Git-native stale-head rejection despite stale `gh` metadata, one merge result, separate deploy/canary receipts, `complete` production state, Telegram recovery, restart recovery, and all eleven trust-kernel rows. Keep local-test, skill-bundle, Telegram, GitHub, deploy, and canary conclusions separate. The four role-specific skill-provider rows must contain real thread ids, roles, selected ids, a bundle digest, and provider-session outcomes from the later receipt slice; the deterministic gate alone cannot satisfy them. Any incomplete row makes the result **incomplete**, never **passed**. The current documentation track has no live Telegram/provider acceptance result, so it must be reported as **not run/incomplete**, not successful. The Task 14 historical comparison remains non-comparable because its original fake-provider token availability was recorded as `0` while the current audited harness reports unavailable/null; no fixed before/after result may be claimed.
