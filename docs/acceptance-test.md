# Disposable live acceptance runbook

This runbook is for the owner-only live acceptance after the automated Task 12 gate. It is evidence collection, not a substitute for the mocked end-to-end test.

## Hard boundaries

- Use a disposable GitHub repository or a disposable test branch whose merge is safe to undo. Never use a production application repository.
- The owner enters the Telegram bot token in **Extensions → Plugins → Telegram Agent**. Do not request the token in chat, put it in a command, or record it in evidence.
- Do not record pairing codes, bot tokens, provider credentials, raw private message content, or raw command output containing secrets.
- Record identifiers, digests, SHAs, statuses, and bounded summaries only.
- A live run is not successful unless every required step has evidence. HTTP 200, static tests, or a plugin registration row alone is not live acceptance.

## Owner-only Step 8 pause

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
| task/status/confirmation/review/approval/completion message ids | `<message ids only>` |
| paired owner identity | `<redacted Telegram user/chat identifiers>` |
| configured project alias | `<alias, not a private path>` |
| disposable project id and branch | `<project id>`, `<test branch>` |
| work-order attachment name and SHA-256 | `<name>`, `<64-hex digest>` |
| review-packet attachment name and SHA-256 | `<name>`, `<64-hex digest>` per review |
| implementation BB thread id | `<thread id>` |
| review BB thread ids | `<thread id>` per attempt |
| implementation environment id | `<environment id>` |
| review environment ids | `<same environment id>` per attempt |
| spawn-versus-fork proof | `<spawned=true, forked=false>` |
| executor owner and generation | `<owner id>`, `<generation>` |
| losing executor owner/generation result | `<not acquired or fenced>` |
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
| restart recovery result | `<completion delivered; no second merge>` |
| final `bb plugin list --json` status | `<installed/running status>` |

## Twelve design-spec steps

### 1. Pair the owner

After the owner has configured the token, run:

```bash
bb telegram-agent pair
```

Open the short-lived link from the intended owner account in a private chat. Record only the Telegram message id and the paired identity in redacted form.

### 2. Enable the disposable project

Create a policy JSON that names the disposable `proj_...` project, its GitHub repository, test branch base, implementation/review profiles, deterministic validation commands, required checks, redaction patterns, liveness watchdog, review limit, and merge method. Enable it with an absolute policy file or JSON input:

```bash
bb telegram-agent project enable <disposable-project-id> --policy-file /absolute/path/to/policy.json
bb telegram-agent doctor <disposable-project-id>
```

Record the alias and doctor check statuses. Do not record the policy file contents if they contain private paths.

### 3. Submit a bounded task

Send one small task from the paired private chat. Record the task/status message ids and confirm that only one active job exists:

```bash
bb telegram-agent job list --json
```

Do not record raw private message text.

### 4. Select the project and confirm

Use the Telegram project picker, select the disposable alias, and press **Start** only after the confirmation view appears. Record the selected alias, confirmation/status message ids, and resulting job id/state.

### 5. Capture implementation handoff and worker isolation

Verify that BB creates a visible implementation thread in a managed worktree. Record the thread id, environment id, work-order filename/digest, executor owner/generation, and liveness source/state. Confirm the implementation input uses an attachment and a tiny handoff prompt. Prove that the thread was spawned and not forked.

### 6. Observe the PR and bind its exact head

When the implementation thread is idle with a pull request, record the PR number/URL and the full SHA returned by each required `git ls-remote --exit-code origin refs/pull/<number>/head` lookup. The stored job head must be the Git-native full SHA, not a `gh` metadata shortcut.

### 7. Run the first review and forced remediation

Verify a visible spawned review child in the implementation environment, its immutable review-packet filename/digest, and its liveness source/state. Supply a strict JSON `changes_requested` verdict. Record the verdict and bounded finding summary. Confirm remediation is sent to the original implementation thread and that the review attempt remains bound to its original head.

### 8. Produce a new implementation head and fresh review

After remediation, wait for the implementation worker to become idle with a new full head SHA. Record the old/new SHAs, a new review child id, attachment digest, spawn-versus-fork proof, and exact environment reuse. Supply a strict JSON pass verdict only for that new SHA.

### 9. Validate and deliberately stale the first approval

Run the configured deterministic validation and record command names/outcomes, both Git-native head OIDs, required checks, clean-worktree evidence, and liveness observations. Issue the merge approval. Before clicking it, make the disposable branch’s `refs/pull/<number>/head` move while serving deliberately stale `gh` head metadata. Click the old approval and record the stale/rejected outcome. Confirm there was no merge SDK call.

### 10. Fresh review, validation, and approval

Confirm stale handling resolves the new exact Git-native head, revokes the old approval, and starts a third fresh review attempt. Record its review-packet digest, thread/environment ids, verdict, validation commands, both head OIDs, and the new one-use approval. Do not reuse the old approval callback.

### 11. Race executors and merge once

Start or exercise a second executor instance at the merge boundary. Record the winning executor owner/generation and the losing instance’s rejected acquisition or lease-fence result. Accept the fresh approval and record the bounded merge response, one BB merge SDK call, post-merge GitHub confirmation, and full merge commit SHA. A second merge call is a failure.

### 12. Fail delivery, restart, and recover completion

Cause the first Telegram completion delivery to fail in the disposable run, record the failure as a bounded liveness/outbox event, restart the plugin services, and verify that completion is delivered from durable state without a second merge. Record restart time, final completion message id, and:

```bash
bb plugin list --json
bb plugin logs telegram-agent -n 50
```

Record the final installed/running status and confirm logs contain no crash loop and no secret material.

## Final acceptance decision

Accept only when the evidence sheet contains all required ids, attachment names/digests, thread/environment relationships, three review attempts, executor fencing, liveness source/state, old/new full SHAs, Git-native stale-head rejection despite stale `gh` metadata, one merge result, and restart recovery. If the owner did not configure the token or the disposable project was not used, report the live acceptance as **not run**, not successful.
