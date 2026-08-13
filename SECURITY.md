# Security

Telegram Agent is a full-trust BB plugin with access to BB's SDK, its own SQLite database, background services, configured project worktrees, and owner-authored commands. A vulnerability can affect source code, pull requests, deployments, Telegram messages, or credentials.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability, exposed credential, pairing link, callback nonce, private transcript, or exploit description.

Use GitHub private vulnerability reporting when it is enabled for the published repository. Otherwise contact the maintainer through a private channel and include only the minimum evidence needed to reproduce the problem. Do not attach real tokens or private message contents.

If a credential may have been exposed, rotate it with its provider first. For a Telegram bot token, update the secret plugin setting after rotation and run `bb telegram-agent doctor`.

## Trust model

- One Telegram user and one private chat are paired as the owner. Pairing that chat grants the holder of it operator-level control of this BB installation.
- The plugin itself is trusted server-side code; installation is not a sandbox boundary.
- The conversational agent runs in a hidden personal workspace with the plugin's guarded tools **and** BB's ordinary agent capabilities. Fresh or unset controller settings resolve to `auto`; an explicitly saved `auto`, `accept-edits`, or `full` value remains that value for later turns. Supported BB-native controller approvals are routed to Telegram as one-use *Allow once*/*Deny* choices, while BB and the execution machine continue to enforce their permission limits. This does not make ordinary BB-native or opaque provider capabilities part of Hanoon's controller manifest.
- Approval prompts raised by visible top-level worker threads are bridged to Telegram, so an owner's tap there authorizes a command or file write in that thread. Visible worker notices may include *Allow all session* when BB exposes that option; the hidden controller bridge accepts only one-use *Allow once*/*Deny*. Approvals the plugin cannot represent faithfully are reported without buttons rather than resolved by guess.
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
- resolve pending BB interactions on visible top-level threads from the owner's Telegram tap, including BB-supported *Allow once* and, where exposed by the visible worker, *Allow all session* choices; hidden-controller approval resolution is limited to *Allow once* or *Deny*.

Merge approval is one-use, expiring, and bound to the current full pull-request head. Deployment and canary run only after the merge is confirmed and the worktree is verified at the merge commit. The plugin does not automatically run rollback.

Memory is owner-visible and correctable from the chat, and credential-shaped text is refused before it can be stored or indexed. Hidden threads remain unreachable from the agent's thread tools.

## Controller answer boundary

The controller's final answer has one source: an accepted structured finalization. `telegram_agent_respond` supplies bounded text and evidence-backed claim segments; raw provider prose and deltas are never copied into the final answer, durable digest, or final Telegram delivery. Drafts are phase-only status text and are not answer content.

Every claim must reference same-turn evidence whose subject matches and whose proof is compatible with the claim. High-impact success statements must be claims rather than ungrounded prose. A `deferred` finalization must name a live durable obligation; the active obligation set includes a nonterminal job, an armed owner monitor, or an open sealed delegation with a running member. A process-only continuation is not a final answer. The evidence projector is bounded at 128 rows per turn and finalization revisions at eight; either limit, or evidence advancing after acceptance, rejects delivery rather than widening the record.

The exact 23-tool Hanoon-only manifest and the migration history for the former controller-question table are documented in [Architecture](docs/architecture.md). BB-native capabilities and opaque third-party provider actions outside that manifest remain residual risk: they are still bounded by BB, the execution machine, and provider behavior, but are not made Hanoon-attested merely by appearing in a provider session.

Controller questions and supported BB-native approval interactions are durable Telegram interactions. The owner tap is persisted before the exact BB interaction is resolved, and restart recovery retries that exact resolution. The hidden controller offers only one-use *Allow once*/*Deny*. Merge, deploy, and canary approval and receipt boundaries are unchanged.

## Credential handling

- Enter the Telegram bot token only in the secret field under **Extensions → Plugins → Telegram Agent**.
- Treat pairing links as credentials until their ten-minute expiry.
- Never put credentials in project policies, commands, redaction examples, issues, logs, tests, or docs.
- Use `outputRedactionPatterns` for project-specific sensitive output, but do not treat redaction as permission to print secrets.
- Do not persist raw merge callback data or private provider transcripts as evidence.

## Operational containment

For the first live run, use a disposable GitHub repository or test branch whose merge and deployment are safe to undo. Keep repository protection enabled. Verify exact head binding, a fresh review conversation, one merge call, and separate deploy/canary receipts before trusting a configuration with production access.

If a worker's ownership or liveness is stale or unknown, stop and inspect the durable job and BB thread. Do not start a second execution engine or manually reuse an old approval.

## Supported versions

The repository currently contains the `0.1.x` development line and does not declare a formal security-support window. Reports should identify the exact commit tested.
