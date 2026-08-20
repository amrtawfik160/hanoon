# Security

Telegram Agent is a full-trust BB plugin with access to BB's SDK, its own SQLite database, background services, configured project worktrees, and owner-authored commands. A vulnerability can affect source code, pull requests, deployments, Telegram messages, or credentials.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability, exposed credential, pairing link, callback nonce, private transcript, or exploit description.

Use GitHub private vulnerability reporting when it is enabled for the published repository. Otherwise contact the maintainer through a private channel and include only the minimum evidence needed to reproduce the problem. Do not attach real tokens or private message contents.

If a credential may have been exposed, rotate it with its provider first. For a Telegram bot token, update the secret plugin setting after rotation and run `bb telegram-agent doctor`.

## Trust model

- One Telegram user and one private chat are paired as the owner. Pairing that chat grants the holder of it operator-level control of this BB installation.
- The plugin itself is trusted server-side code; installation is not a sandbox boundary.
- The conversational agent runs in a hidden personal workspace with the plugin's guarded tools **and** BB's ordinary agent capabilities. Fresh or unset controller permission settings resolve to `auto`; an explicitly saved `auto`, `accept-edits`, or `full` value is preserved. A permission prompt BB raises for the hidden controller is bridged into Telegram as *Allow once* / *Deny*.
- Approval prompts raised by visible top-level worker threads are bridged to Telegram, so an owner's tap there authorizes a command or file write in that thread. This moves where the decision is made, not who may make it — the paired chat already holds operator-level control. Approvals the plugin cannot represent faithfully are reported without buttons rather than resolved by guess.
- Enabled project policies are trusted operator input. Their validation, deployment, and canary commands execute on the selected project host.
- BB controls provider conversations, permissions, environments, worktrees, and merge execution.
- GitHub authentication, repository rules, and branch protection remain external security boundaries.

## High-impact operations

The plugin can:

- start BB agent threads and managed worktrees, and send messages into visible threads;
- run shell commands, including the `bb` CLI, on connected machines under the configured permission mode;
- run configured validation, deployment, and canary commands;
- send bounded remediation to an implementation worker;
- request a pull-request merge after review, validation, and owner approval;
- read and update its durable job, memory, monitor, approval, liveness, and Telegram outbox state;
- resolve pending BB interactions on **visible top-level** threads from the owner's Telegram tap, including *Allow once* and *Allow all session* on a command or file-change approval;
- resolve the **hidden controller's** own questions and permission approvals from the owner's Telegram tap. These offer exactly *Allow once* and *Deny*: there is no session-wide grant on the controller path, and a session-wide token cannot settle one.

## Controller trust boundary

Every owner-visible reply from the conversational agent is an accepted structured finalization bound to evidence gathered in that same turn. A claim without compatible evidence, an answer whose evidence advanced after acceptance, or a deferred promise with no live durable obligation is rejected rather than delivered. Unstructured assistant prose reaches no draft, stored answer, digest, outbox row, finalization row, or Telegram reply; BB retains its own provider transcript separately.

Interaction projections are the one bounded exception, and they are not prose. When BB blocks the thread on a question or a permission prompt, the plugin must carry the provider's own wording — the prompt, the option labels, the command being approved — because that is what the owner is being asked about. Each of those fields is length-bounded and passes a single fail-closed credential and callback screen before it is stored or sent. A field that fails the screen is not redacted in place: the whole interaction is downgraded to an unanswerable notice that names no provider text at all, so a leak cannot be traded for answerability.

The controller runs against an enforced manifest of exactly 34 Hanoon capabilities, and denials are decided before any effect. That manifest bounds Hanoon's own tools only. Work the provider performs natively inside BB, or through an opaque third-party tool that emits no BB interaction and no evidence boundary, is outside it: **Hanoon claims no policy over an action it never sees.**

The controller permission mode defaults to `auto`; it remains an operator setting rather than mechanically enforced isolation, and instruction text is not enforcement. Explicit `accept-edits` or `full` values remain supported. The current worker-driven commit, push, and pull-request path remains protected by the existing review, exact-head, and owner-approval boundaries.

An owner's tap on a controller interaction commits durably — decision, callback outcome, and acknowledgement together — before BB is told, and survives a restart. The reply itself is one durable logical outbox obligation, but Telegram delivery is **at-least-once**: an ambiguous send is retained as unknown, a retry may duplicate the Telegram message, and an attempt or an enqueue is never recorded as delivered.

Merge approval is one-use, expiring, and bound to the current full pull-request head, unless the project holds a standing grant — see [Unattended merging](#unattended-merging). Deployment and canary run only after the merge is confirmed and the worktree is verified at the merge commit. A configured `rollbackCommand` is run automatically as soon as a deploy or canary command fails; with none configured, nothing is rolled back.

Memory is owner-visible and correctable from the chat. Credential-shaped text is refused before it can be stored or indexed, with one deliberate exception: `bb telegram-agent memory import` runs on the protected BB host under the owner's own identity and stores its entries unscreened. Nothing the agent writes uses that path — its own `remember` is still refused. Hidden threads remain unreachable from the agent's thread tools.

## Text from outside the repository

A project whose policy sets `autonomy.intake` lets its daily audit start work rather than only report it. Two of the four audits build that work order out of text nobody in this installation wrote: the title of a GitHub issue (`bug-backlog`) and the body of an unresolved pull-request review comment (`pr-review-findings`). Anyone who can open an issue or leave a review comment on the configured repository can author that text.

That text reaches three places: the durable job record, the Telegram status card, and the implementation worker's prompt. Treat it as an untrusted input to a model, because that is what it is.

What bounds it:

- **`autonomy.intake` is opt-in and absent by default.** Without it the audits report exactly as they always did and no outside text becomes a prompt this way.
- **Each excerpt is capped at 200 characters** and the whole work order at 1,200, so no amount of outside text can become the bulk of the order.
- **Control and invisible characters are removed** before the excerpt is carried: the C0 and C1 ranges, DEL, soft hyphen, line and paragraph separators, zero-width and bidirectional formatting marks, and the interlinear annotation characters. What the owner reads on the status card is what the worker receives.
- **The excerpt is delimited as quotation** — `«…»`, with those two characters stripped from the content so quoted text cannot close its own quotation — and the order says in words that the quoted part is information rather than instruction.
- **A work order carrying credential-shaped text drops the finding entirely.** It is not redacted in place; nothing is started from it. The daily digest still reports the finding to the owner.

What this does **not** claim: the quoting is instruction text, and instruction text is not enforcement. A worker is a model and may still act on something it reads inside the marks. The boundaries that hold are the ones outside the prompt — the excerpt caps, the character strip, the credential refusal, and the fact that whatever the worker produces still passes deterministic validation, independent review, and the project's own merge rule before it can reach the trunk. An unattended merge additionally requires GitHub to enforce at least one required status check on the base branch, verified at `project enable`.

## Unattended merging

A project may merge without the owner's signature, either because they tapped **Merge + deploy, and always from now on** or because the project's policy sets `autonomy.unattendedMerge`. Both replace the owner's signature and nothing else: every review, validation, and evidence gate that produced the merge candidate still runs, and unusual jobs still stop to ask.

- `bb telegram-agent project enable` refuses to store either merge grant unless the policy's base branch has branch protection or a ruleset requiring at least one status check, asked live through the authenticated `gh` CLI. A 404, an unreadable answer, and a protection requiring nothing all refuse. Protection that does not bind administrators is accepted with a warning, because the merge runs under an owner-scoped token GitHub may exempt.
- A change that needed two or more rounds of review fixes is not waved through: it needs an independent second review of the exact head, on a provider the review stage did not use, and only an unambiguous pass merges it.
- A production deploy or canary that fails, and whose rollback was missing or itself failed, withdraws both grants durably and stops the project admitting new work until the owner sends `/resume`.
- `/approvals off` withdraws a grant by name or all of them. A policy-declared grant stays silenced until the project's enabled policy snapshot is stored again.

GitHub authentication, repository rules, and branch protection remain external security boundaries. Nothing here replaces them; the enable-time preflight only refuses to proceed without them.

## Credential broker trust boundary

This foundation adds a second, deliberately separate trust boundary: a broker service meant to run on its own protected host or private service network, outside this plugin's process, database, and full-trust boundary. Nothing above in this document — "the plugin itself is trusted server-side code," or the controller's shell and `bb` CLI reach — applies to the broker. The broker is designed so that a compromised controller or worker identity cannot reach its administrative interface, its filesystem, or the vault service-account token, and so that a compromised plugin never receives that token or a resolved credential value.

- **`credentialBrokerMode` defaults to `disabled`.** In that state every access command and doctor check fails closed, and no request reaches a broker. Moving to `isolated` requires an endpoint, an installation id, a topology receipt digest/expiry from a reviewed negative-probe report, and certificate material — none of which a fresh installation has. This repository does not include the disposable 1Password account, the protected broker host, or the live acceptance run that would make enabling it meaningful; see [Disposable live acceptance](docs/live-acceptance.md).
- **Only two operations exist end to end:** a diagnostic health check, and a single-item vault resolve. There is no generic proxy, shell, URL fetch, or vault search/list reachable from Hanoon, and no operator CLI command to verify or enroll a credential — `bb telegram-agent access list` and `access status` only read local, secret-free metadata. A live verification can only be requested by the owner, in chat, through Hanoon's guarded tool, never from the CLI.
- **A `vault_verified` binding proves the broker can reach the configured vault item. It does not prove the credential works for its application**, and nothing in this foundation can move a binding to `active`. Do not treat a verification reply as a login or account check.
- **Only the broker client's private key is a BB secret plugin setting.** The 1Password service-account token is never configured in BB; it is entered directly on the protected broker host through its own OS credential prompt. See `broker/README.md` for the protected-host build, credential provisioning, enrollment, revocation, and teardown procedures.

## Credential handling

- Enter the Telegram bot token only in the secret field under **Extensions → Plugins → Telegram Agent**.
- Treat pairing links as credentials until their ten-minute expiry.
- Never put credentials in project policies, commands, redaction examples, issues, logs, tests, or docs.
- Use `outputRedactionPatterns` for project-specific sensitive output, but do not treat redaction as permission to print secrets.
- Do not persist raw merge callback data or private provider transcripts as evidence.
- `bb telegram-agent memory import` is the one path that stores credential-shaped text. Its entries live in plugin SQLite in plaintext, are readable by anyone who can read that database or its backups, and are recallable by the agent. It is a convenience for standing information, not a vault: prefer a real secret manager for anything whose disclosure matters, and rotate what you load if the installation is compromised.

## Operational containment

For the first live run, use a disposable GitHub repository or test branch whose merge and deployment are safe to undo. Keep repository protection enabled. Verify exact head binding, a fresh review conversation, one merge call, and separate deploy/canary receipts before trusting a configuration with production access.

If a worker's ownership or liveness is stale or unknown, stop and inspect the durable job and BB thread. Do not start a second execution engine or manually reuse an old approval.

## Supported versions

The repository currently contains the `0.1.x` development line and does not declare a formal security-support window. Reports should identify the exact commit tested.
