# Security

Telegram Agent is a full-trust BB plugin with access to BB's SDK, its own SQLite database, background services, configured project worktrees, and owner-authored commands. A vulnerability can affect source code, pull requests, deployments, Telegram messages, or credentials.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability, exposed credential, pairing link, callback nonce, private transcript, or exploit description.

Use GitHub private vulnerability reporting when it is enabled for the published repository. Otherwise contact the maintainer through a private channel and include only the minimum evidence needed to reproduce the problem. Do not attach real tokens or private message contents.

If a credential may have been exposed, rotate it with its provider first. For a Telegram bot token, update the secret plugin setting after rotation and run `bb telegram-agent doctor`.

## Trust model

- One Telegram user and one private chat are paired as the owner. Pairing that chat grants the holder of it operator-level control of this BB installation.
- The plugin itself is trusted server-side code; installation is not a sandbox boundary.
- The conversational agent runs in a hidden personal workspace with the plugin's guarded tools **and** BB's ordinary agent capabilities. The permission mode is an operator setting whose current default is `full`, so by default it may use the shell, the `bb` CLI, installed skills, and MCP servers on any connected machine without a per-action prompt. That default is current residual risk carried forward, not enforced isolation. Set `auto` or `accept-edits` if you want execution approved as it happens: a permission prompt BB then raises for the hidden controller is bridged into Telegram as *Allow once* / *Deny*, so it no longer waits on the BB app.
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

The controller runs against an enforced manifest of exactly 23 Hanoon capabilities, and denials are decided before any effect. That manifest bounds Hanoon's own tools only. Work the provider performs natively inside BB, or through an opaque third-party tool that emits no BB interaction and no evidence boundary, is outside it: **Hanoon claims no policy over an action it never sees.**

The controller permission mode is an operator setting whose current default is `full`, carried forward from before the trust kernel. It is current residual risk, not enforced isolation, and instruction text is not enforcement. Changing the fresh default to `auto` and enabling `executor_v2` managed-job publication are both **disabled** until versioned runtime BB attestations prove an atomic activity snapshot, an atomic expected-head-and-tree conditional commit with a deterministic request key, and mechanical denial of worker and controller native commit, ref mutation, push, GitHub write, merge, deploy, and equivalent network effects. The current `legacy_v1` worker-driven commit, push, and pull-request creation is what actually runs.

An owner's tap on a controller interaction commits durably — decision, callback outcome, and acknowledgement together — before BB is told, and survives a restart. The reply itself is one durable logical outbox obligation, but Telegram delivery is **at-least-once**: an ambiguous send is retained as unknown, a retry may duplicate the Telegram message, and an attempt or an enqueue is never recorded as delivered.

Merge approval is one-use, expiring, and bound to the current full pull-request head. Deployment and canary run only after the merge is confirmed and the worktree is verified at the merge commit. The plugin does not automatically run rollback.

Memory is owner-visible and correctable from the chat. Credential-shaped text is refused before it can be stored or indexed, with one deliberate exception: `bb telegram-agent memory import` runs on the protected BB host under the owner's own identity and stores its entries unscreened. Nothing the agent writes uses that path — its own `remember` is still refused. Hidden threads remain unreachable from the agent's thread tools.

## Credential handling

- Enter the Telegram bot token only in the secret field under **Extensions → Plugins → Telegram Agent**.
- Treat pairing links as credentials until their ten-minute expiry.
- Never put credentials in project policies, commands, redaction examples, issues, logs, tests, or docs.
- Use `outputRedactionPatterns` for project-specific sensitive output, but do not treat redaction as permission to print secrets.
- Do not persist raw merge callback data or private provider transcripts as evidence.
- `bb telegram-agent memory import` is the one path that stores credential-shaped text. Its entries live in plugin SQLite in plaintext, are readable by anyone who can read that database or its backups, and are recallable by an agent whose default permission mode is `full`. It is a convenience for standing information, not a vault: prefer a real secret manager for anything whose disclosure matters, and rotate what you load if the installation is compromised.

## Operational containment

For the first live run, use a disposable GitHub repository or test branch whose merge and deployment are safe to undo. Keep repository protection enabled. Verify exact head binding, a fresh review conversation, one merge call, and separate deploy/canary receipts before trusting a configuration with production access.

If a worker's ownership or liveness is stale or unknown, stop and inspect the durable job and BB thread. Do not start a second execution engine or manually reuse an old approval.

## Supported versions

The repository currently contains the `0.1.x` development line and does not declare a formal security-support window. Reports should identify the exact commit tested.
