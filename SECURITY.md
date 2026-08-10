# Security

Telegram Agent is a full-trust BB plugin with access to BB's SDK, its own SQLite database, background services, configured project worktrees, and owner-authored commands. A vulnerability can affect source code, pull requests, deployments, Telegram messages, or credentials.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability, exposed credential, pairing link, callback nonce, private transcript, or exploit description.

Use GitHub private vulnerability reporting when it is enabled for the published repository. Otherwise contact the maintainer through a private channel and include only the minimum evidence needed to reproduce the problem. Do not attach real tokens or private message contents.

If a credential may have been exposed, rotate it with its provider first. For a Telegram bot token, update the secret plugin setting after rotation and run `bb telegram-agent doctor`.

## Trust model

- One Telegram user and one private chat are paired as the owner.
- The plugin itself is trusted server-side code; installation is not a sandbox boundary.
- The conversational controller receives only the plugin's guarded tools and runs in a hidden personal workspace without implementation files.
- Enabled project policies are trusted operator input. Their validation, deployment, and canary commands execute on the selected project host.
- BB controls provider conversations, permissions, environments, worktrees, and merge execution.
- GitHub authentication, repository rules, and branch protection remain external security boundaries.

## High-impact operations

The plugin can:

- start BB agent threads and managed worktrees;
- run configured validation, deployment, and canary commands;
- send bounded remediation to an implementation worker;
- request a pull-request merge after review, validation, and owner approval;
- read and update its durable job, approval, liveness, and Telegram outbox state.

Merge approval is one-use, expiring, and bound to the current full pull-request head. Deployment and canary run only after the merge is confirmed and the worktree is verified at the merge commit. The plugin does not automatically run rollback.

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
