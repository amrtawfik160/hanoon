# Documentation

Telegram Agent gives one private Telegram owner full control of their BB installation, plus a guarded delivery pipeline for code changes.

- [Architecture](architecture.md) — ownership, durable state, what can become an answer, controller interactions, conversation continuity, memory, monitors, and the delivery pipeline.
- [Configuration](configuration.md) — installation, pairing, model and permission settings including what the permission default does not do, and project policies.
- [Operations](operations.md) — health checks, memory and monitors, job recovery, token rotation, and removal.
- [Disposable live acceptance](live-acceptance.md) — evidence-based testing against a repository that is safe to merge and deploy.
- [Agent experience and proven autonomy design](designs/agent-experience-autonomy.md) — approved architecture for role-selected skills, evidence-backed Telegram updates, and executable live acceptance.
- [Credential and access platform design](designs/hanoon-credential-access-platform.md) — planned vault, identity, browser-session, MFA, lifecycle, and real-verification trust boundaries.
- [Credential broker foundation design](designs/hanoon-credential-broker-foundation.md) — first planned access slice: an isolated typed broker, 1Password binding verification, and secret-free receipts.
- [Contributing](../CONTRIBUTING.md) — development setup and change requirements.
- [Security](../SECURITY.md) — trust boundaries, credential handling, and vulnerability reporting.
