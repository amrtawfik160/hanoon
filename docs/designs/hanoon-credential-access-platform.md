# Hanoon Credential and Access Platform Design

Status: approved for implementation planning

Date: 2026-08-12

Hanoon committed baseline: `cc71a96f9b719128505a8073597ca4390a47f26e`

Package: `bb-plugin-telegram-agent`

Plugin id: `telegram-agent`

## Decision

Hanoon will manage access, not possess a model-readable collection of passwords. A user may authorize Hanoon to use and administer an account, but passwords, API tokens, OAuth refresh tokens, session cookies, TOTP seeds, recovery codes, and vault bootstrap credentials never enter an agent prompt, BB thread, agent shell environment, Hanoon SQLite row, Telegram message, evidence projection, or ordinary log.

Credential use crosses a separate broker trust boundary. The controller asks for a typed capability against a durable task and credential binding. Hanoon's policy kernel and the broker independently validate the request. Only the broker resolves secret material, and only a connector or isolated session worker receives the minimum material required for the selected operation. Neither returns it to Hanoon.

This architecture deliberately accepts that some providers require a human. Hanoon may automate a workload identity, OAuth grant, persistent session, or explicitly approved TOTP flow. It does not bypass provider-required user presence, WebAuthn, identity verification, CAPTCHA, or recovery procedures.

## Outcome

Once the complete program ships, an owner can give each Hanoon installation its own employee identity, connect narrowly scoped accounts through an external vault or OAuth, define standing access policies, and let Hanoon finish supported tasks independently. Hanoon resumes after restarts, renews short-lived access, verifies outcomes against authoritative systems, and asks the owner only for a genuine decision or human-presence ceremony.

The product claim is bounded: Hanoon is autonomous inside its qualified capability catalog. An unknown provider, unqualified workflow, insufficient scope, unsafe topology, or human-only challenge produces a typed blocker. It never becomes an invitation to fetch a broader secret or improvise around an authentication boundary.

## Relationship to the Hanoon operating system

The [Hanoon Agent Operating System design](hanoon-agent-operating-system.md) remains authoritative for controller finalization, capability policy, effect fencing, evidence, interactions, obligations, and evaluation. Credentialed capabilities may not register until its Slice 1 trust kernel is complete and the default controller permission mode is `auto`.

Credential safety requires one stronger condition than permission mode: no controller or worker OS identity may read the broker's credentials, client keys, vault storage, process environment, socket, or control-plane filesystem. A prompt or approval cannot repair a topology in which an agent shell and the broker share the same readable operating-system principal.

The same separation applies to BB administration. An agent identity used for credentialed work may not change plugin settings, replace broker trust roots, obtain plugin route tokens, install or reload plugin code, or mutate credential policy through the `bb` CLI or another BB API. If the installed BB permission model cannot enforce that separation, credential capabilities remain disabled.

## Scope decomposition

This program contains several independently reviewable security subsystems. They ship as separate specifications and implementation plans in this order:

1. **Credential-broker foundation.** Protected control-plane service, authenticated typed protocol, per-installation binding metadata, one external-vault adapter, readiness checks, and secret-free audit receipts.
2. **API identities and OAuth connectors.** Provider-specific service identities, minimal scopes, OAuth callbacks terminating at the broker, short-lived token exchange, and authoritative read/write verification.
3. **Isolated browser and session manager.** Per-installation profiles, stable resource identity, serialized ownership, stale-state tokens, exact-origin credential injection, encrypted session persistence, and deterministic replay.
4. **MFA and strong approval.** Broker-managed TOTP policy, human-presence challenge resumption, WebAuthn-backed high-risk approval, and human-only recovery controls.
5. **Credential lifecycle.** Rotation, revocation, compromise response, pending-secret recovery, access reviews, and deprovisioning.
6. **Connector qualification and acceptance lab.** Versioned real-service journeys, negative and red-state proofs, repeated nondeterministic trials, canaries, and a published support matrix.

Each subsystem must produce working, testable software. Later subsystems may consume earlier contracts but may not weaken their invariants.

## Non-goals

- Giving the model a `read_secret`, `reveal_password`, `copy_token`, arbitrary vault-query, or generic authenticated-request tool.
- Loading a complete vault into a worker environment, including through `op run`, dotenv, launch configuration, or a generated shell script.
- Controlling the owner's everyday browser profile or inheriting unrelated personal sessions.
- Treating redaction, prompt-injection classification, audit logging, or model instructions as a credential boundary.
- Supporting every website in the first release.
- Defeating provider anti-automation controls or human-presence requirements.
- Hosting a central multi-tenant Hanoon vault in the first release. The first supported topology is per installation and owner controlled.
- Letting Hanoon broaden its own scopes, change credential policy, enroll a new factor, expose recovery material, or grant another principal access.

## Threat model

The design must contain these threats:

- Untrusted instructions embedded in email, webpages, documents, issue text, tool output, or retrieved memory.
- A compromised, manipulated, or simply mistaken model using every tool it can reach.
- Arbitrary shell execution by a controller or worker on an execution host.
- Replay after a provider retry, controller replacement, process crash, network timeout, or stale browser observation.
- Cross-installation, cross-owner, cross-project, cross-account, or cross-browser-profile confusion.
- Secret exposure through environment variables, command arguments, stdout, stderr, screenshots, clipboard, crash reports, telemetry, database fields, tests, or support bundles.
- A malicious redirect, nested frame, lookalike origin, stale tab, or prompt that tries to move credential filling to an attacker-selected destination.
- A stolen Telegram session attempting high-risk access administration.
- Revoked, expired, under-scoped, over-scoped, or silently replaced credentials.
- Vault, broker, connector, provider, and network outages.

The following remain outside the boundary: compromise of the protected broker host or external vault service itself, malicious code running as the broker's OS principal, a compromised provider, and a malicious Hanoon release signed and installed by the owner. Per-installation scoping, audit, rotation, and revocation limit their blast radius but cannot make them harmless.

## Non-negotiable invariants

1. **References, never values.** Hanoon stores an opaque `bindingId` and bounded metadata. The broker owns the external vault reference. Neither value nor reversible encoding of a secret may cross into Hanoon state.
2. **No secret-bearing agent environment.** Controller, worker, test-agent, browser-driver, and reviewer environments use explicit allowlists. They never inherit broker, vault, OAuth, cookie, TOTP, or connector credentials.
3. **No generic credential primitive.** Every operation is a versioned, typed connector capability with fixed destination semantics and bounded output.
4. **Dual enforcement.** Hanoon validates identity, task, policy, approval, fence, destination, and binding generation. The broker repeats the security-relevant validation against its own policy snapshot.
5. **Authority cannot come from content.** Untrusted content may provide data for an already-authorized task. It cannot select a new binding, expand scope, change destination, waive approval, or authorize egress.
6. **Fail closed before use.** Missing policy, ambiguous identity, stale approval, expired deadline, lost fence, unavailable audit persistence, origin mismatch, unknown schema version, or broker authentication failure denies the operation.
7. **Evidence before success.** A connector result is not returned as successful until a secret-free receipt commits. A task does not complete until an independent verifier observes the requested external outcome.
8. **Tenant and generation binding.** Every policy, request, receipt, idempotency key, browser profile, session, and approval binds to one installation, owner, task or turn, credential binding, and binding generation.
9. **Least privilege by default.** Use provider-native service identities, OAuth, and short-lived tokens before passwords. A binding carries the smallest scopes, origins, audiences, and operations that satisfy its qualified workflows.
10. **No fallback to weaker storage.** Broker or vault failure never falls back to plaintext files, an old environment variable, a personal browser, a copied recovery code, or an interactive password-manager prompt.
11. **Hanoon cannot administer its own authority.** Enrollment, policy broadening, recovery access, broker trust changes, and high-impact credential lifecycle operations require a strong human ceremony outside model control.
12. **Unsafe topology is unsupported.** Production credential support remains disabled when an agent execution identity can read or reach broker control material directly.
13. **Agent BB access is not administrative access.** Controller and worker identities cannot configure, install, reload, remove, or mint route tokens for the Hanoon or broker plugins. Native BB permissions must enforce this independently of model instructions.

## Trust topology

```text
Paired owner                     External identity providers
Telegram / BB UI                APIs / OAuth / websites
      |                                   ^
      v                                   |
Hanoon plugin control plane               |
  - durable task and turn identity        |
  - capability policy                     |
  - approvals and effect fence            |
  - secret-free evidence                  |
      | signed typed request               |
      v                                   |
Credential broker -------------------------+
  - separate protected OS/network identity
  - per-installation policy and audit
  - vault and token adapters
  - connector/session execution
      |
      v
Owner-controlled external vault

Agent execution hosts
  - controller, workers, reviewers, browser observers
  - no broker key, vault token, broker socket, or broker filesystem access
  - no BB authority to alter plugin settings, trust roots, or credential policy
```

The protected control plane is intentionally not an execution host available to Hanoon's shell. If an installation has only one host and uses one OS identity for BB, agents, and broker storage, credential capabilities stay disabled. Development may use synthetic credentials and fake providers under that topology, but the product may not call it isolated.

## Installation and tenancy

The first release is single owner and single tenant per Hanoon plugin installation. Each installation receives:

- one random installation identifier generated by the broker;
- one revocable broker client identity scoped to that installation;
- one dedicated vault or vault subset;
- one set of credential bindings and connector policies;
- isolated OAuth grants, browser profiles, sessions, audit receipts, and approval keys.

No installation-wide credential may grant access to another user's namespace. A broker may technically serve several installations, but it authenticates them with different client identities and keeps policy, storage, idempotency, rate limits, and audit partitions separate.

## Credential and capability contracts

Hanoon persists this secret-free shape:

```ts
export type CredentialBindingMetadata = Readonly<{
  bindingId: string;
  installationId: string;
  bindingKind: "vault_item" | "oauth_grant" | "workload_identity" | "browser_session";
  authorityProvider: string;
  secretProvider: "onepassword" | "provider_native" | "broker_session";
  principalLabel: string;
  capabilityIds: readonly string[];
  audiences: readonly string[];
  origins: readonly string[];
  scopes: readonly string[];
  riskClass: "low" | "medium" | "high" | "critical";
  mfaMode: "none" | "workload_identity" | "totp_broker" | "human_presence";
  approvalMode: "standing_policy" | "telegram_once" | "strong_once" | "human_only";
  state: "pending" | "vault_verified" | "active" | "degraded" | "expired" | "revoked" | "compromised";
  generation: number;
  verifiedAt: number | null;
  expiresAt: number | null;
}>;
```

`principalLabel`, scopes, origins, and audiences are owner-visible metadata, not secret material. They are bounded and validated. The broker keeps the external vault item identifier, OAuth token family, cookie jar, TOTP seed, and provider-specific private metadata.

A Hanoon capability descriptor extends the operating-system manifest with:

- required credential provider and binding type;
- exact connector operation and schema version;
- permitted destination or origin class;
- required provider scopes and data classes;
- task provenance allowed to drive arguments;
- approval mode and exact approval subject;
- idempotency and reconciliation strategy;
- verifier operation and proof kind;
- maximum request, response, and receipt sizes.

The model never receives a bearer lease. The plugin creates an internal lease only after policy succeeds and calls the connector itself. A broker request contains the installation, request, task or turn, capability, binding, generation, destination, approval, fence, policy digest, idempotency key, issue time, and deadline. It contains no prompt, transcript, arbitrary shell command, arbitrary URL, or secret.

## Provenance and prompt-injection containment

Every value that may influence a credentialed action is assigned one deterministic provenance class:

- `owner_direct`: typed by the paired owner in the current task;
- `owner_policy`: selected earlier through a strong administrative ceremony;
- `trusted_system`: produced by a versioned Hanoon or broker component;
- `provider_observation`: structured output from the selected connector;
- `untrusted_content`: email, webpage, document, issue, message from another person, retrieved prose, or model-generated extraction.

An LLM may help classify or summarize content, but that verdict is diagnostic only. Enforcement uses provenance and capability schemas. `untrusted_content` may fill a bounded content field for a pre-authorized operation, such as the body of a reply inside an approved support workflow. It may not choose credentials, add recipients outside policy, alter an origin, approve spending, change access, or create a new external action class.

Any attempt to cross those boundaries is denied or converted to a durable owner interaction. A classifier outage does not remove the boundary because the boundary does not depend on a classifier.

## How an owner gives Hanoon access

### External-vault credentials

1. The owner creates a dedicated Hanoon vault or vault subset in the vault provider's native UI.
2. The owner provisions a per-installation service identity scoped only to that subset and configures it directly on the protected broker host.
3. The owner creates or moves credential items in the vault provider's UI. Hanoon never asks for the password text.
4. The Access Center requests vault metadata from the broker and lets the owner bind an item to an account, exact origins, connector capabilities, scopes, risk, MFA mode, and approval policy.
5. The broker validates that the item can be resolved and, once a connector exists, verifies the credential against the provider's authoritative API. It returns only a structured health result and receipt.

The BB `secret` command's dotenv workflow is not used for managed credentials because its destination is a plaintext environment file. BB secret plugin settings may hold the broker client key on the protected BB server, but not application passwords or the external-vault service token.

### OAuth and provider-native identities

The owner clicks Connect in the Access Center. The OAuth redirect and callback terminate at the broker, which validates state, PKCE, redirect identity, issuer, audience, scopes, and account identity. Hanoon receives only the binding metadata and verification receipt. Refresh tokens remain broker-side, and access tokens are minted or refreshed just in time for one typed connector operation.

Provider-native workload identities, GitHub Apps, delegated service accounts, and narrowly scoped machine principals are preferred over user passwords. The account should be named and auditable as Hanoon's identity rather than silently borrowing the owner's personal account.

### Existing browser sessions

The owner performs the initial interactive login inside an isolated Hanoon profile. The session manager encrypts and binds the resulting session to one installation, account, and allowed origin set. Hanoon may reuse that session until it expires or policy requires reauthentication. It never imports the owner's everyday Chrome profile.

## Browser security contract

Browser automation is a separate subsystem because a general DOM or JavaScript tool is too broad for credential use. Its fixed requirements are:

- one isolated profile per installation and account;
- an explicit stable profile, page, and tab identifier on every operation;
- one serialized resource lease for each mutable profile;
- a state token from the last observation, rejected when stale;
- exact HTTPS origin matching before secret fill or authenticated submission;
- no fill inside cross-origin frames or after an unapproved redirect;
- no clipboard transfer, raw cookie export, password-field readback, or arbitrary JavaScript evaluation in a credential-enabled profile;
- screenshots and DOM projections redact configured sensitive fields before leaving the session service;
- deterministic interaction traces use placeholders and broker operations, never environment variables containing credentials;
- browser discovery may propose a trace, but a reviewed deterministic trace and verifier qualify the workflow for autonomous use.

## MFA and human-presence contract

| Authentication method | Autonomous behavior | Security meaning |
| --- | --- | --- |
| Workload identity or service account | Broker authenticates noninteractively within fixed scope | Preferred automation identity |
| OAuth authorization code with refresh token | Owner grants once; broker refreshes within granted scope | Preferred user-delegated access |
| Existing isolated session | Session manager reuses until expiry or provider challenge | Reduces repeated login ceremonies |
| TOTP | Broker may generate and inject only under explicit `totp_broker` policy | Password and TOTP under one automation domain weaken factor independence |
| Push, SMS, email OTP | Hanoon waits for the provider or owner to complete the challenge | Code is not pasted into Telegram or a prompt |
| WebAuthn, passkey, security key | Owner or a provider-approved hardware-bound machine identity completes it | User-presence requirements are honored |
| CAPTCHA or identity verification | Hanoon reports `human_presence_required` and resumes after completion | No bypass or solving service |
| Recovery code or account recovery | Human-only break glass | Never accessible to Hanoon or the broker operation API |

High-risk access administration requires a WebAuthn-backed `strong_once` approval in the Access Center. Telegram may carry low- or medium-risk one-use approvals within existing owner policy, but a stolen Telegram session is not sufficient to enroll a credential, expand scopes, change broker trust, expose recovery material, or authorize a critical security mutation.

## Access policy

The initial policy classes are:

- **Low:** identity and health reads with no sensitive content. May run under standing policy.
- **Medium:** reversible or reconcilable actions against exact pre-authorized targets, such as creating a draft or updating a known issue. May run under standing policy or `telegram_once` according to owner configuration.
- **High:** sending to a new recipient, publishing, spending, deletion, production mutation, security-setting change, credential rotation, or grant/revoke. Requires `strong_once` unless a later connector specification defines a narrower independently approved standing workflow.
- **Critical:** broker trust, vault scope, recovery, factor enrollment, policy broadening, ownership transfer, or disabling audit. Human-only; no autonomous capability is registered.

The owner changes policy through an administrative surface whose request is signed and bound to the installation and policy version. The model can explain or propose a policy change but cannot submit it.

## Credential lifecycle

Binding generation is monotonic. Every lease and receipt records the generation it used. Rotation or compromise increments the generation and immediately invalidates outstanding leases and browser sessions whose credential lineage changed.

A password rotation uses a durable broker-side state machine:

1. generate the replacement inside the broker;
2. keep it in protected pending state;
3. update the provider through a qualified connector or isolated session;
4. verify the new credential through a fresh authoritative session;
5. promote the new vault version;
6. verify the old credential is invalid when the provider supports that check;
7. close the transaction with a secret-free receipt.

If provider change succeeds but vault promotion fails, the broker retains the protected pending value and retries reconciliation. Hanoon reports `rotation_reconciliation_required`; it never repeats the provider mutation or guesses that the newer copy is correct.

Fingerprints use a broker-held HMAC key or provider version identifier. Hanoon never stores a plain SHA-256 digest of a password, TOTP seed, or other potentially guessable secret.

Revocation is immediate and fail closed. Compromise state disables use before notification. Recovery codes remain outside the lifecycle API.

## Autonomous task behavior

Credentialed work uses Hanoon's existing durable attempt, effect, resource-claim, approval, and obligation contracts:

1. The controller translates the owner's request into a supported capability and explicit Definition of Done.
2. The plugin binds it to the current turn or job, project, target, policy version, binding generation, and idempotency key.
3. Policy either denies, creates a durable interaction, or admits one broker operation.
4. The executor claims the operation under the current generation fence.
5. The broker and connector execute once and commit a secret-free receipt.
6. An independent verifier reads authoritative external state using a separate read capability where possible.
7. Hanoon continues, retries only reconcilable failures, waits on a durable human ceremony, or reports a typed terminal blocker.
8. Structured finalization may claim success only from the verifier evidence.

A deferred response must name an existing monitor, human interaction, scheduled retry, or other durable obligation. Status narration is never a stopping point.

## Error model

Credential surfaces use stable public failure classes rather than raw provider errors:

- `unsafe_topology`
- `broker_unavailable`
- `broker_auth_failed`
- `binding_missing`
- `binding_inactive`
- `binding_generation_stale`
- `scope_insufficient`
- `destination_denied`
- `approval_required`
- `strong_approval_required`
- `human_presence_required`
- `credential_invalid`
- `credential_expired`
- `credential_revoked`
- `provider_rate_limited`
- `provider_unavailable`
- `result_ambiguous`
- `receipt_persistence_failed`
- `reconciliation_required`

Raw provider responses remain inside the broker's bounded diagnostic store. Hanoon receives a safe class, retryability, bounded recovery instruction, correlation id, and proof reference. Unknown errors map to `result_ambiguous` and deny blind replay.

## Evidence and audit

Hanoon receipts contain only:

- installation, task or turn, capability, binding, and generation identifiers;
- broker request and provider operation correlation identifiers;
- normalized destination identity allowed by policy;
- outcome and stable failure class;
- issue, completion, expiry, and verification times;
- policy, schema, connector, verifier, and broker versions;
- idempotency and fence identity;
- HMAC fingerprint or provider version identifier when needed;
- bounded proof references.

They contain no prompt, secret, OAuth code, token, cookie, TOTP value, recovery material, raw request body, raw response body, arbitrary URL, DOM, screenshot, or provider error text.

The broker audit is append-only and must commit before a successful result is released. Audit unavailability fails closed for mutations. Owners can inspect use, denial, scope, target, and verification without being able to reveal the credential.

## Real-testing contract

"100% real testing" means every mandatory case in a versioned acceptance matrix passed; it does not mean every possible provider behavior is known. The release report distinguishes:

1. **Deterministic safety tests:** policy, tenant isolation, generation and fence races, idempotency, redaction, no-secret persistence, approval binding, origin checks, stale state, and replay. Every case must pass.
2. **Contract tests:** real plugin SQLite and fake protocol peers validate the exact broker and connector schemas, bounds, timeouts, cancellation, and failure mapping.
3. **Real vault and provider integration:** disposable accounts and vaults exercise actual authentication, scope, expiry, revocation, rate-limit, and live verification paths. A missing credential or skipped test is `incomplete`, not `passed`.
4. **Browser end-to-end:** actual isolated profiles exercise initial login, persistent session, expiry, wrong origin, redirect, frame, MFA, restart, and deterministic replay.
5. **Adversarial acceptance:** prompt injection, attacker-selected destination, secret-read attempts, arbitrary shell, broker endpoint probing, duplicate mutations, and cross-tenant references all fail.
6. **Chaos and recovery:** kill the plugin, broker, connector, or browser between request, provider effect, receipt, and verification; prove recovery does not duplicate an irreversible action.
7. **Red-state proof:** deliberately introduce each mechanically detectable violation and show the corresponding acceptance check fails before reverting it.
8. **Repeated behavioral trials:** nondeterministic model scenarios report the complete denominator, harness, tools, budgets, cost, latency, and failure class. A one-off live run is labeled smoke evidence only.
9. **Independent verification:** screenshots and model assertions are diagnostic. Authoritative provider state, a receiving test account, or a separately authenticated read path determines the outcome.

Critical safety failures are release blockers on any trial: secret exposure, policy bypass, cross-tenant access, wrong-origin fill, stale approval acceptance, duplicate irreversible effect, recovery-material exposure, or unsupported success.

## Qualification and support matrix

Every autonomous connector workflow publishes:

- provider, account type, connector and schema version;
- required scopes, origins, authentication and MFA modes;
- exact supported operations and risk classes;
- approval and idempotency rules;
- authoritative verifier and cleanup procedure;
- deterministic and live scenario identifiers;
- last passing release and known provider limitations.

Unlisted operations are unsupported even if the model believes it knows how to perform them. A generic browser is not a qualification shortcut.

## Design adaptations

These decisions keep the credential surface fail-closed and independently authored:

- retain noninteractive, fail-closed external-vault access and verify a credential against its provider before adoption;
- retain auto-continue, durable obligations, stable browser/window identities, serialized resource ownership, stale-state rejection, machine-readable Definition of Done, anti-criteria, red-state proof, and trace-and-verify diagnosis;
- replace shared dotenv files and broad process-environment inheritance with on-demand broker resolution;
- replace personal-browser control and arbitrary browser evaluation with isolated profiles and typed session operations;
- replace annotation-only, fail-open prompt-injection inspection with deterministic provenance and capability denial for credentialed actions;
- replace audit-only arbitrary Bash at the credential boundary with an unreachable broker control plane;
- expand the example happy-path pipeline into a required per-connector real acceptance corpus.

Hanoon keeps BB as the session, provider, environment, and worktree authority.

## Release sequence and gates

The credential-broker foundation specification is the first child design. No child implementation begins until:

- the owner approves this written specification;
- the Hanoon trust-kernel prerequisite is implemented and verified;
- the broker-host and agent-host separation can be demonstrated;
- the child specification defines its exact secret-free protocol and live acceptance sheet.

Subsequent child designs return to the same review gate. Approval of this umbrella architecture does not authorize installation, external-vault provisioning, credential creation, OAuth consent, security-factor enrollment, spending, destructive actions, deployment, or production access.
