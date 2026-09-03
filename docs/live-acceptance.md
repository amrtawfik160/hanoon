# Disposable live acceptance

This runbook is for owner-only live acceptance after the automated test suite passes. It collects evidence from a real Telegram bot, BB environment, disposable GitHub repository, and disposable production commands. It is not a substitute for the mocked end-to-end test.

## Hard boundaries

- Use a disposable GitHub repository or a disposable test branch whose merge is safe to undo. Never use a production application repository.
- The owner enters the Telegram bot token in **Extensions → Plugins → Telegram Agent**. Do not request the token in chat, put it in a command, or record it in evidence.
- Do not record pairing codes, bot tokens, provider credentials, raw private message content, or raw command output containing secrets.
- Record identifiers, digests, SHAs, statuses, and bounded summaries only.
- A live run is not successful unless every required step has evidence. HTTP 200, static tests, or a plugin registration row alone is not live acceptance.

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

## Adaptive recipe promotion status

The automated fake-host suite exercises all six recipe graphs, active-mode failure and recovery, restart reconstruction, mandatory guard gating, stale approval rejection, and rollback snapshot behavior. That proof is deterministic; it is not a disposable Telegram, BB-provider, GitHub, deployment, or canary run.

The production promotion reader and append-only evidence ledger are wired. It reads only the newest manifest and accepts it only when its integrity-bound artifact, job, receipt, model-trial, chronology, and safety references resolve to stored rows. The status command reports `incomplete` for missing, corrupt, duplicate, non-causal, or mismatched data, and typed envelopes alone cannot create evidence.

Recipe promotion still has no trusted live collector. Treat that gate as **not run/incomplete** and keep every recipe in `shadow` while following this runbook. Do not turn a passing local suite into a recipe receipt, insert evidence with ad hoc SQL, or enable a recipe to make this runbook easier to complete.

Navigator-v1 evidence is different. `DualEngineCoordinator.persistEvaluationEvidence` appends the measured corpus, restart and safety counters, and the required disposable live scenarios. It rejects a job whose terminal state was only SQL-stamped. `capability status navigator-v1` and `capability promote navigator-v1` / `capability rollback navigator-v1` consume that ledger. After contraction, new admissions always use navigator-v1 even if the **Workflow engine graph** setting still says `recipe`. The leased executor runs the live navigator, implementation, and release workers.

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
| controller execution tuple | `<provider selected by the model>`, `<selected model>`, `<reasoning>`, `<service tier>`, `<permission mode>` |
| selected job recipe and routing mode | `<recipe>@<version>`, `<shadow/active>` |
| controller/worker capability profiles | `<profile id>`, `<revision>`, `<registry digest>`, `<graph digest>` |
| mandatory capability outcomes | `<capability id>`, `<terminal outcome>`, `<bounded evidence references>` |
| candidate/baseline model trials | `<trial ids>`, `<provider/model/reasoning/tier>`, `<terminal outcomes>`, `<harness/budget digests>` |
| deterministic promotion artifacts | `<category>`, `<suite id>`, `<run id>`, `<artifact digest>`, `<passed/failed>` |
| classifier promotion artifact | `<corpus digest>`, `<run id>`, `<result digest>`, `<total/correct/unsafe downgrade>` |
| live failure/recovery receipts | `<live run id>`, `<job id>`, `<failure receipt id>`, `<recovery receipt id>` |
| zero-tolerance safety snapshots | `<counter>`, `<count>`, `<snapshot id>`, `<evidence digest>` |
| promotion manifest and status | `<manifest id>`, `<recipe>`, `<incomplete/failed/passed>` |
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
| implementation skill-provider evidence | real thread id: `<pending>`; role: `implementation`; selected ids: `unslop`, `systematic-debugging`, `test-driven-development`, `verification-before-completion`, `clean-code-guard`, `test-guard`; bundle digest: `<pending>`; provider-session outcome: `<pending>` |
| review skill-provider evidence | real thread id: `<pending>`; role: `review`; selected ids: `unslop`, `clean-code-guard`, `test-guard`; bundle digest: `<pending>`; provider-session outcome: `<pending>` |
| documentation skill-provider evidence | real thread id: `<pending>`; role: `documentation`; selected ids: `unslop`, `technical-writing`, `docs-guard`, `verification-before-completion`; bundle digest: `<pending>`; provider-session outcome: `<pending>` |
| final-review skill-provider evidence | real thread id: `<pending>`; role: `final-review`; selected ids: `unslop`, `clean-code-guard`, `test-guard`, `docs-guard`; bundle digest: `<pending>`; provider-session outcome: `<pending>` |
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

Verify that the leased executor creates a hidden implementation thread in a managed worktree on the disposable project's exact source host. Record the thread id, environment id, work-order filename/digest, executor owner/generation, and liveness source/state from bounded BB/operator projections. Confirm the implementation input uses an attachment and a small handoff prompt. Prove that the thread was spawned and not forked. Confirm the hidden controller remains in its personal workspace and cannot see the implementation checkout.

#### Capability and skill-provider observations

The deterministic `npm run skills:verify` gate proves only the committed bundle's structure, provenance, and bytes. It does not prove provider use. For each non-empty implementation, review, documentation, and final-review profile, record the real BB thread id, profile id and revision, recipe/version, exact model tuple, selected skill ids, verifier bundle digest, and every mandatory terminal outcome. Confirm the profile existed before the provider call and that the outcome receipt belongs to the same subject. A `selected` event without its required terminal outcome is incomplete. A shadow profile is observational evidence only and cannot be counted as active delivery success.

### 6. Observe the PR and bind its exact head

When the implementation thread is idle with a pull request, record the PR number/URL and the full SHA returned by each required `git ls-remote --exit-code origin refs/pull/<number>/head` lookup. The stored job head must be the Git-native full SHA, not a `gh` metadata shortcut.

### 7. Run the first review and forced remediation

Verify a hidden spawned review child in the implementation environment, its immutable review-packet filename/digest, and its liveness source/state. Confirm it has a fresh provider conversation rather than the implementation transcript. Supply a strict JSON `changes_requested` verdict. Record the verdict and bounded finding summary. Confirm remediation is sent to the original implementation thread and that the review attempt remains bound to its original head.

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

### 13. Future gate: record adaptive promotion evidence without operator assertions

Run this step separately for each recipe, in the fixed order `direct`, `bounded`, `bug`, `skill-authoring`, `adopted-pr`, then `architectural`. Use a fresh disposable active-mode job and a disclosed fixed harness and budget. Induce one recoverable provider failure, verify its terminal failed or blocked model trial, recover through a distinct passed trial on the same job, and finish the disposable job through merge. Record at least five independent candidate trials and five strong-baseline trials for the recipe.

A later trusted acceptance collector—not an operator CLI argument—must derive and append one bounded evidence bundle containing:

- all eight deterministic artifact categories and their digests;
- the fixed classifier corpus/result with 100% correct and zero unsafe downgrades;
- the active post-merge disposable job and distinct failure/recovery receipt ids;
- candidate and baseline model-trial references under identical harness and budget digests;
- all five zero-tolerance safety counter snapshots;
- one manifest that references those exact stored records.

The bundle write must be transactional. If any job, receipt, trial, artifact, recipe, chronology, or identity does not resolve, the write must leave no partial manifest. Recipe promotion still has no such collector, so stop here for recipes and mark this gate **incomplete**; do not substitute direct database inserts.

Navigator-v1 collection is the dual-engine persist seam, not this recipe step. It still must not accept SQL-stamped terminal jobs. Inspect that engine separately:

```bash
bb telegram-agent capability status navigator-v1 --json
```

Inspect the result before any rollout decision:

```bash
bb telegram-agent capability status <recipe> --json
```

Only a future `passed` and `ready: true` result may permit `capability promote <recipe>`. After promotion, create a new matching job and prove it is `active`; the acceptance job used as evidence must not be retroactively rewritten. Exercise `capability rollback <recipe>` and prove that the in-flight active job stays pinned while a later matching job returns to `shadow`. Record both append-only decisions. Do not promote the next recipe until every earlier recipe remains active.

For navigator-v1, `capability promote navigator-v1` is allowed only after the dual-engine collector has written a reviewed manifest whose restart and safety records were measured. `capability rollback navigator-v1` records the operator decision without returning later admissions to recipe-v1 or rewriting in-flight navigator jobs.

## Final acceptance decision

Accept the base live run only when the evidence sheet contains the controller tuple and personal-workspace isolation, the no-job conversational check, all required ids, attachment names/digests, thread/environment relationships, fresh review conversations, all four concurrency/resource cases, exact post-reconcile claim adoption, executor fencing, liveness source/state, old/new full SHAs, Git-native stale-head rejection despite stale `gh` metadata, one merge result, separate deploy/canary receipts, `complete` production state, Telegram recovery, and restart recovery. Keep local-test, skill-bundle, Telegram, GitHub, deploy, canary, and promotion conclusions separate. The four role-specific capability rows must contain real thread ids, profiles, selected ids, bundle digest, exact model tuple, and mandatory terminal outcomes; deterministic bundle verification alone cannot satisfy them.

A recipe promotion is a separate acceptance decision. It remains **incomplete** until step 13 has a resolved durable manifest and the status command reports `ready: true`. If the owner did not configure the token, production commands, disposable projects, or trusted collection harness needed for every case, report the affected live acceptance as **not run**, never successful. This release cannot create that recipe manifest because the trusted recipe collector is absent; do not approve a recipe for activation from local evidence.

Navigator-v1 promotion is also separate. Report it **not run** unless `capability status navigator-v1` shows a resolved measured ledger and a new admission actually ran on the live navigator workers. Do not SQL-insert that ledger.
## Trust-kernel evidence sheet

Score each row separately. Mocked/deterministic, live provider, Telegram, and external-system evidence stay in different classes, and an unavailable installation, provider, bot chat, interaction shape, or host attestation makes a row **incomplete** — never passed.

| # | Evidence | Value |
| --- | --- | --- |
| 1 | accepted finalization id and its exact evidence refs | `<finalization id>`, `<evidence:N list>` |
| 2 | live current-status evidence (source, proof kinds, subject refs) | `<bounded evidence row>` |
| 3 | one process-only continuation with no leaked draft or answer | `<continuation count>`, `<draft text observed>` |
| 4 | permission interaction id under the actually configured mode | `<interaction id>`, `<permission mode, explicit or default>` |
| 5 | exact Allow-once resolution sent to BB | `<interaction id>`, `<resolution payload>` |
| 6 | restart between tap persistence and BB resolution | `incomplete` unless a mechanically controlled window exists |
| 7 | armed monitor obligation named by a deferred response | `<monitor id>`, `<obligation ref>` |
| 8 | unsupported-success delivery count | `0` expected; record the observed count |
| 9 | stale capability/fence denial before effect | `<denial code>`, `<unchanged durable state>` |
| 10 | fixed report path/digest, harness identity, budgets, denominators, outcomes, and time/token/cost availability | `<report path>`, `<sha-256>`, `<passed/denominator per scenario>` |
| 11 | proof that merge, deploy, credential, spend, destructive action, managed publication, and privilege/default activation were **not** exercised | `<explicit not-exercised statement per item>` |
| 12 | runtime atomic-activity, conditional-commit, and native-isolation attestations | `unavailable / disabled` unless real host evidence exists |
| 13 | Telegram backoff, retry, and uncertainty-report status, reported separately from the one logical outbox result | `<logical key>`, `<retry delay>`, `<exhaustion notice>` |

Row 6 has no planned production fault hook for pausing exactly after tap persistence and before BB resolution, so it is **incomplete** unless a mechanically controlled window exists; the deterministic restart proof lives in `tests/controller-trust-integration.test.ts`.

Row 4 may use an explicitly configured disposable `auto` profile and a harmless read-only command. If BB emits no supported interaction, mark the row incomplete. Record the actual configured permission mode and whether it was explicit.

Row 12 is **disabled/unavailable** on the current runtime: the vendored BB thread, timeline, and interaction calls share no atomic activity revision and the commit API is unconditional. Because of that row, the overall live gate cannot be called passed.

Row 13 records transport truth, not intent: an explicit server backoff is persisted in full, a transient failure known not to have sent is retried durably, a known-message edit reconciles by stored message id, and an uncertain brand-new send retries on its existing logical row even though that may duplicate it. If uncertainty exhausts the retry budget, the row must deliver the store-mapped warning instead of disappearing silently. Never record an attempt or an enqueue as a delivery.

Never exercise a live merge, deploy, credential change, spend, destructive action, ref mutation, or managed publication for this acceptance run.

## Final acceptance decision

Accept only when both evidence sheets are complete. The trust-kernel sheet above is scored separately, and because row 12's runtime attestations are unavailable on this runtime, **the overall live gate cannot be called passed** however well the rest scores. Beyond that, accept only when the evidence sheet contains the controller tuple and personal-workspace isolation, the no-job conversational check, all required ids, attachment names/digests, thread/environment relationships, fresh review conversations, all four concurrency/resource cases, exact post-reconcile claim adoption, executor fencing, liveness source/state, old/new full SHAs, Git-native stale-head rejection despite stale `gh` metadata, one merge result, separate deploy/canary receipts, `complete` production state, Telegram recovery, and restart recovery. Keep local-test, skill-bundle, Telegram, GitHub, deploy, and canary conclusions separate. The four role-specific skill-provider rows must contain real thread ids, roles, selected ids, a bundle digest, and provider-session outcomes from the later receipt slice; the deterministic gate alone cannot satisfy them. Until then, live provider skill-use evidence remains **pending**, not passed or complete. If the owner did not configure the token, production commands, or disposable projects needed for every case, report the live acceptance as **not run**, not successful.

## Credential broker evidence sheet

The credential broker foundation (see [Configuration](configuration.md#credential-broker-foundation) and [Operations](operations.md#credential-broker)) has its own versioned acceptance contract, separate from the two sheets above: a fixed case catalog in `evals/credential-broker-cases.json`, a schema and aggregation rule in `src/eval/credential-broker-acceptance.ts`, and a secret-free recorder/validator at `scripts/record-credential-broker-acceptance.mjs`. **This repository defines that contract; it does not run it.** `credentialBrokerMode` remains `disabled`, no case in the catalog has been executed against a real broker, provider, or protected host, and this foundation cannot be exercised live until a disposable 1Password account and a protected broker host exist. Treat every case below as **not run** until that live pass completes and this section is updated with its result.

The catalog fixes four case categories — `deterministic` and `contract` (covered by the focused `credential-*.test.ts` suite runnable with `npm run test:credentials`), `live`, and `red_state` — and every case in it is mandatory. The 14 mandatory live ids and 8 mandatory red-state ids are:

```text
live-broker-noninteractive-start           live-admin-interface-unreachable
live-service-account-single-vault-scope    live-bb-admin-negative-probes
live-exact-binding-valid                   live-topology-reattest
live-out-of-scope-item-denied              live-disposable-teardown
live-missing-field-invalid                 red-secret-log-canary
live-revoked-service-token-closed          red-unknown-protocol-field
live-broker-restart-receipt-replay         red-stale-binding-generation
live-hanoon-restart-no-credential-transfer red-redirect-endpoint
live-secret-canary-zero-findings           red-unsafe-topology
live-doctor-all-gates                      red-expired-topology-receipt
                                            red-audit-persistence-failure
                                            red-idempotency-digest-change
```

Each red-state case names, in the catalog, the exact other case whose fail-closed guarantee it adversarially proves. The overall report status the recorder computes is `passed` only when every mandatory case is recorded `passed` and cleaned — closed out with `cleanupStatus: "complete"` whenever it touched a disposable resource — **and** every red-state case that another case depends on is itself `passed` and cleaned. A case that is missing, `failed`, still `incomplete`, or whose required red-state counterpart is unmet leaves the aggregate `incomplete` or `failed`, never `passed`; the recorder recomputes this from the recorded cases every time, so a hand-edited `"status": "passed"` in the report file is rejected rather than trusted. Evidence references in the report are opaque ids and paths only — never a secret, a `op://` vault reference, PEM material, or a token — and the schema refuses any value shaped like one.

The report itself is not part of this repository: it is generated outside Git, under `$BB_THREAD_STORAGE` or another path the operator explicitly confirms is protected.

```bash
npm run acceptance:credential-broker -- init --output "$BB_THREAD_STORAGE/credential-broker-acceptance-v1.json"
npm run acceptance:credential-broker -- record --input "$BB_THREAD_STORAGE/credential-broker-acceptance-v1.json" \
  --case <case-id> --status <passed|failed|incomplete> --cleanup <not_applicable|pending|complete> \
  --procedure-revision <n> --started-at <epoch-ms> --completed-at <epoch-ms> \
  --actor <who> --reviewer <who> --actual-result <stable-label> \
  --evidence <opaque-ref> --resource <disposable-resource-id>
npm run acceptance:credential-broker -- validate --input "$BB_THREAD_STORAGE/credential-broker-acceptance-v1.json"
```

`init` writes one `incomplete` entry per catalog case and exits `0`; running `validate` against that untouched file exits nonzero with status `incomplete` by design, since nothing has been proven yet. `record` re-validates the whole report before writing and refuses a write that would make it invalid — for example a `passed` case with no cleanup, no evidence, or a secret-shaped value — so the file on disk can never silently drift into a false `passed`. Do not call this "100% real" testing until `validate` exits `0`: that specific claim means every mandatory case in the catalog is `passed` and cleaned, its evidence reference exists, and no red-state proof was skipped — not that every website, credential type, or future provider works.
