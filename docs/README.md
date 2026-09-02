# Documentation

Telegram Agent gives one private Telegram owner full control of their BB installation, plus a guarded delivery pipeline for code changes.

- [Architecture](architecture.md) — ownership, durable state, what can become an answer, controller interactions, conversation continuity, memory, monitors, and the delivery pipeline.
- [Hanoon-native full-SDLC and BB automation integration](designs/hanoon-native-sdlc-and-bb-automation.md) — the approved integration of BB orchestration, review repair, plain language, independent employee access, and cron automation.
- [Configuration](configuration.md) — installation, pairing, model and permission settings including what the permission default does not do, project policies, and the disabled-by-default credential broker foundation settings.
- [Operations](operations.md) — health checks, memory and monitors, job recovery, token rotation, the credential broker doctor and access commands, and removal.
- [Disposable live acceptance](live-acceptance.md) — evidence-based testing against a repository that is safe to merge and deploy, plus the not-yet-run credential broker acceptance contract.
- [Agent experience and proven autonomy design](designs/agent-experience-autonomy.md) — approved architecture for role-selected skills, evidence-backed Telegram updates, and executable live acceptance.
- [Credential and access platform design](designs/hanoon-credential-access-platform.md) — planned vault, identity, browser-session, MFA, lifecycle, and real-verification trust boundaries.
- [Credential broker foundation design](designs/hanoon-credential-broker-foundation.md) — first planned access slice: an isolated typed broker, 1Password binding verification, and secret-free receipts.
- [Reference documents, voice notes, and identity](designs/reference-documents-voice-and-identity.md) — built behavior, constraints, and deferred work for these owner-facing capabilities.
- [Repository history](repository-history.md) — why `main` shares no ancestor with the work, how it happened, and the base-branch and ancestry guards that stop it recurring.
- [Reconciling `main`](main-reconciliation-options.md) — the open owner decision, with each option's risk and undo cost.
- [Contributing](../CONTRIBUTING.md) — development setup and change requirements.
- [Security](../SECURITY.md) — trust boundaries, credential handling, and vulnerability reporting.
