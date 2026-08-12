# Hanoon Credential Broker Foundation Design

Status: approved for implementation planning

Date: 2026-08-12

Parent: [Hanoon Credential and Access Platform Design](hanoon-credential-access-platform.md)

Hanoon committed baseline: `cc71a96f9b719128505a8073597ca4390a47f26e`

Package: `bb-plugin-telegram-agent`

Plugin id: `telegram-agent`

## Outcome

Build the first independently deployable access subsystem: a protected credential broker that authenticates one Hanoon installation, stores its external-vault configuration outside agent reach, exposes only two fixed operations (`broker.health` and `vault.binding.verify`), and returns secret-free receipts to Hanoon's existing fenced control plane.

The owner can provision a dedicated 1Password vault and service account directly on the broker, register opaque credential bindings, inspect connection health from Hanoon, and run a live resolve verification without any application secret entering Hanoon or an agent process.

This phase proves the trust boundary and onboarding path. It does not yet authorize a controller to use an application credential, perform OAuth, operate a browser, generate TOTP, rotate a credential, or mutate an external application.

## Prerequisites

Implementation is blocked until all of these are true:

- The controller trust-kernel plan is complete: accepted structured finalization is the only Telegram answer path, every Hanoon controller tool has a descriptor and pre-execution wrapper, native evidence is reconciled, and the fresh controller default is `auto`.
- The BB server/plugin control plane and broker run under identities unavailable to controller and worker execution. The controller's personal project host is not the broker host, no enabled project gives an agent shell access to the broker control plane, and the agent's BB identity cannot change plugin settings, broker trust, plugin route tokens, or credential policy.
- A disposable 1Password account or vault is available for live acceptance. Production or personal credentials are not used.
- Broker TLS names, endpoint, and installation identity are fixed during setup; an agent cannot supply them per request.

If the topology preflight fails, the plugin reports `unsafe_topology`, denies credential verification before broker dispatch, and does not attempt a credential-resolution call. Read-only access metadata and readiness diagnostics remain available.

## Product behavior

The phase adds three owner-visible surfaces:

1. **Access list.** Hanoon and the CLI list bounded credential-binding metadata: label, provider, state, generation, allowed future capability ids, risk, MFA mode, and last verification time.
2. **Access status.** Hanoon and the CLI inspect broker reachability, authenticated installation identity, schema compatibility, external-vault adapter health, and one selected binding without resolving or revealing its value.
3. **Access verification.** The owner may request a live `vault.binding.verify`. The broker resolves the selected item in memory, validates that the required field exists and is nonempty within configured bounds, immediately discards the value, commits an audit receipt, and returns only `valid`, `invalid`, or a stable failure class.

`vault.binding.verify` proves that the broker can reach the configured vault item. It does not claim the credential is valid for its eventual application. Each connector child specification must add a provider-authoritative verification operation before that binding can become `active` for application use.

## Deployment boundary

The broker is a standalone service on a protected control-plane host or private service network. It does not run inside an agent worktree, BB thread, browser process, controller process, or worker process.

The supported production topology is:

```text
Hanoon plugin process                         Broker service
BB control-plane host                        protected host/service identity
  client certificate + key  -- mTLS -->       installation policy
  no vault token                              1Password adapter token
  secret-free SQLite                          opaque external item references

Controller and worker hosts
  no client key
  no route to broker administrative endpoint
  no broker or vault filesystem access
  no BB permission to alter plugin or broker trust configuration
```

The plugin client key is stored using a BB secret plugin setting on the protected BB server. BB stores that value outside plugin SQLite and does not send it to the frontend. The external-vault service-account token is configured directly in the broker's OS secret store and never enters BB settings.

A single-host, single-UID deployment is test-only. File mode `0600`, redaction, and a different process do not create a boundary when the controller shell has the same operating-system authority.

## Components

### Broker protocol package

A dependency-free shared TypeScript module defines and validates request, response, health, binding metadata, receipt, and failure schemas. It exposes no function that accepts or returns a secret value. The plugin and broker build against the same schema version.

### Broker server

The server terminates mTLS, authenticates the installation from the client certificate, applies request size and time bounds, validates the typed request, enforces installation/binding/generation/operation policy, claims the idempotency key, invokes one adapter operation, commits its audit receipt, and returns a bounded response.

The server has no generic proxy, shell, URL fetch, vault search, item list, field read, or debug-response endpoint. Its production listener is private. The administrative enrollment interface is a separate local CLI available only on the protected host.

### 1Password adapter

The first adapter authenticates noninteractively with a service account scoped to one dedicated vault. It resolves one exact item field on demand and returns the value only to the broker operation's in-memory callback. It never exports the complete vault, populates a process-wide environment, writes a resolved dotenv file, invokes an interactive prompt, or logs command output.

The implementation prefers a provider SDK or API that keeps the token and returned value inside the broker process. If a reviewed adapter must invoke `op`, it uses direct argv with no shell, a minimal child environment containing only the scoped service token and required process variables, `OP_CACHE=false`, bounded piped output, disabled inherited stdio, and explicit output disposal. It may not use `op run --no-masking` or populate the broker's parent environment.

### Hanoon broker client

The plugin client owns the fixed broker endpoint and mTLS material, constructs request envelopes from durable Hanoon state, enforces deadlines, validates every response, maps failures, and returns only typed metadata and receipt references. It follows redirects zero times and never accepts an endpoint, operation name, origin, binding, or installation id from model-generated free text.

### Credential metadata repository

Hanoon's plugin SQLite stores binding metadata and receipt projections. It does not store the external vault id or path, service-account token, client private key, certificate body, resolved value, value length, value prefix, provider raw error, or broker diagnostic body.

### Read-only Hanoon capabilities

The trust-kernel manifest contains these capabilities, all guarded by readiness and topology policy:

- `telegram_agent_access_list`: read / low / no approval / no credential resolution;
- `telegram_agent_access_status`: read / low / no approval / no credential resolution;
- `telegram_agent_access_verify`: read / medium / exact binding / broker credential / one receipted verification.

All three bind to the current installation and turn. `access_verify` accepts a `bindingId` selected from an exact bounded list; it cannot accept an external vault reference.

## Protocol

### Request envelope

Every broker call uses this exact security envelope:

```ts
export type BrokerRequestEnvelope = Readonly<{
  schemaVersion: 1;
  installationId: string;
  requestId: string;
  idempotencyKey: string;
  operation: "broker.health" | "vault.binding.verify";
  bindingId: string | null;
  bindingGeneration: number | null;
  turnId: string | null;
  capabilityId:
    | "system.broker.health"
    | "telegram_agent_access_status"
    | "telegram_agent_access_verify";
  policyDigest: string;
  fenceOwner: string | null;
  fenceGeneration: number | null;
  issuedAt: number;
  deadlineAt: number;
  nonce: string;
}>;
```

`broker.health` uses null binding, binding generation, turn, and fence fields. It is diagnostic and cannot resolve a vault item. `vault.binding.verify` requires all of them and the plugin verifies that the fence is current immediately before dispatch and again before accepting the result. The envelope contains no arbitrary object, prompt, transcript, URL, vault reference, provider arguments, or secret.

The mTLS channel authenticates the installation. The broker verifies that the certificate installation matches the body, `requestId` and nonce are new, the deadline is at most 30 seconds after issue, clock skew is within 60 seconds, the policy digest is current, the operation is enabled, the binding belongs to the installation, and the generation matches.

### Response envelope

```ts
export type BrokerHealthSnapshot = Readonly<{
  protocolVersion: 1;
  brokerVersion: string;
  adapter: "onepassword";
  adapterState: "ready" | "degraded" | "unavailable";
  auditWritable: boolean;
  bindingCount: number;
  topologyReceiptDigest: string;
  topologyReceiptExpiresAt: number;
}>;

export type BrokerResponseEnvelope = Readonly<{
  schemaVersion: 1;
  installationId: string;
  requestId: string;
  operation: "broker.health" | "vault.binding.verify";
  outcome: "succeeded" | "failed";
  result: "ready" | "valid" | "invalid" | null;
  failureClass:
    | "broker_auth_failed"
    | "vault_auth_failed"
    | "request_rejected"
    | "binding_missing"
    | "binding_inactive"
    | "binding_generation_stale"
    | "credential_invalid"
    | "provider_rate_limited"
    | "provider_unavailable"
    | "receipt_persistence_failed"
    | "result_ambiguous"
    | null;
  retryable: boolean;
  retryAfterMs: number | null;
  receiptId: string | null;
  health: BrokerHealthSnapshot | null;
  bindings: readonly CredentialBindingMetadata[];
  completedAt: number;
}>;
```

Unknown fields, schema versions, operations, result values, failure classes, health fields, or binding fields fail response validation. A successful `broker.health` response has `outcome: "succeeded"`, `result: "ready"`, one health snapshot, a non-null receipt, and every secret-free binding for the authenticated installation. The foundation caps an installation at 100 bindings, so reconciliation is complete rather than silently truncated. The broker reads those bindings from its policy store; it does not search or list the external vault. Hanoon reconciles the returned metadata into its local projection.

A valid verification has `outcome: "succeeded"`, `result: "valid"`, and a non-null receipt. A missing item or field, empty value, or value outside the configured bound has `outcome: "failed"`, `result: "invalid"`, `failureClass: "credential_invalid"`, `retryable: false`, and a non-null audit receipt. Transport, policy, provider, authentication, and persistence failures have `result: null`. `retryAfterMs` is non-null only for a retryable provider rate limit or outage, and is bounded from 1,000 through 300,000 milliseconds. Every non-health response carries `health: null` and `bindings: []`; a failed health response does too. An active duplicate may return `result_ambiguous` without a receipt; a startup-reconciled interrupted claim returns it with an audit receipt. A local timeout or unparseable response is also treated as ambiguous, but is not itself a broker receipt. Hanoon never retries it blindly under a new idempotency key.

### Idempotency and audit

The broker durably claims `(installationId, idempotencyKey)` before adapter work. A completed duplicate returns the original secret-free response. A duplicate that is still executing returns a transient `result_ambiguous` with no receipt. On restart, the broker cannot prove whether an uncompleted 1Password SDK read happened; it therefore finalizes the original claim as an audited `result_ambiguous` without invoking the adapter again. The same idempotency key with a different request digest is rejected without changing the original claim.

Hanoon reconciles a local timeout by resending the exact stored envelope. A completed broker result is replayed; an active claim remains pending; a restart-interrupted claim eventually returns the audited ambiguous receipt. Hanoon never retries under a new key automatically. After an audited ambiguity, only a new explicit owner verification request in a later turn may create a new key. This foundation does not claim provider-side exactly-once observability that the 1Password read API cannot supply.

The broker audit row stores:

- installation, request, idempotency, operation, binding, and generation ids;
- capability, policy digest, and Hanoon fence identity;
- request digest and client-certificate fingerprint;
- start, completion, and deadline times;
- result or stable failure class;
- adapter and protocol versions;
- a broker-held HMAC fingerprint of the resolved vault version when required.

It stores none of the excluded secret or raw diagnostic fields. A successful verification response is released only after the audit transaction commits.

## Binding enrollment

Enrollment occurs on the protected broker host, not through a model tool:

1. The owner creates a dedicated vault and service account in 1Password.
2. The owner installs the service-account token into the broker's OS secret store using the protected host's native credential prompt or provider-native handoff. The value never appears in argv, an agent environment, or command output retained by Hanoon.
3. The broker runs a live service-account identity probe and displays only the account, vault scope, and status.
4. The owner registers an exact vault item and field in the broker. The broker creates a random `bindingId` and stores the external reference broker-side.
5. The owner assigns a label, future capability ids, risk, MFA mode, and approval mode. The foundation accepts only inactive future capability ids because no application connector exists yet, and rejects enrollment when the installation already has 100 binding records, including tombstones. This keeps every health reconciliation complete in protocol version 1.
6. The broker emits secret-free binding metadata in the authenticated, bounded `broker.health` response; Hanoon reconciles that projection without querying or listing the external vault.
7. Hanoon records the metadata as `pending` and may run `vault.binding.verify`.
8. A successful resolve changes the binding to `vault_verified`, not `active`: vault access is proven, application validity is not.

Only a connector-authoritative verification may later set a binding to `active`.

Deletion first revokes the binding and increments its generation. Removal of broker-side metadata occurs only after outstanding request retention expires. Hanoon retains a tombstone and audit references, not the external vault reference.

## Topology and readiness checks

`bb telegram-agent doctor` gains a credential section with these independent states:

- trust kernel ready;
- controller permission default ready;
- protected topology declared and verified;
- controller and worker BB administration denied by an enforceable permission rule;
- broker DNS/TLS reachable;
- broker client identity authenticated;
- protocol versions compatible;
- installation id matched;
- broker audit writable;
- 1Password adapter authenticated;
- selected binding present and generation matched;
- last live verification status and age.

The doctor prints no certificate, vault id, item id, token status detail that reveals a secret, path to secret storage, or raw broker error. `--json` carries the same bounded fields.

Readiness is conjunctive. A failed check prevents `telegram_agent_access_verify` execution. A transient runtime failure fails the call closed and updates health; it does not remove historical receipts.

BB does not currently expose a read-only authorization-introspection API that can prove the controller and worker identities lack plugin administration. Before isolated mode is enabled, the operator runs the versioned negative probes from those exact identities, reviews the secret-free acceptance report on the protected control plane, and installs its SHA-256 digest and expiry in both the broker installation policy and Hanoon settings. `broker.health` returns both values and Hanoon requires an exact match and an unexpired report. Version 1 caps validity at 30 days. A digest match binds the reviewed operational evidence; it does not excuse a missing or failed probe. A BB version, identity, host assignment, endpoint, trust-root, or policy change invalidates the report immediately and returns the credential subsystem to `unsafe_topology` until the probes are rerun.

## Configuration

Hanoon adds these settings:

- `credentialBrokerMode`: `disabled` or `isolated`; default `disabled`;
- `credentialBrokerEndpoint`: fixed HTTPS URL, non-secret;
- `credentialBrokerInstallationId`: fixed opaque id, non-secret;
- `credentialBrokerTopologyReceiptDigest`: SHA-256 of the current reviewed topology acceptance report, non-secret;
- `credentialBrokerTopologyReceiptExpiresAt`: expiry from the same report as an epoch-millisecond integer, non-secret;
- `credentialBrokerClientCertificate`: public certificate string;
- `credentialBrokerClientKey`: secret string;
- `credentialBrokerCaCertificate`: public certificate string when a private CA is used.

The client private key never enters controller configuration, instructions, tool results, health output, logs, or SQLite. Public endpoint and certificate metadata may appear in protected administrative diagnostics but not in ordinary agent context. Settings changes retire cached broker connections and require a fresh readiness check. Enabling isolated mode requires a plugin reload so the complete capability manifest and readiness state are rebuilt. An endpoint change does not migrate bindings automatically.

The broker separately configures its service-account token and external item references. There is no Hanoon setting for either.

## Failure and recovery

- **Broker unavailable before adapter work:** retry with the same idempotency key under bounded backoff while the current Hanoon fence remains valid.
- **Timeout after dispatch:** record local ambiguity and resend the exact stored envelope after recovery. Do not create a new verification request until the broker replays a completion or returns an audited ambiguous receipt; after the latter, only a new explicit owner request may try again.
- **Vault unavailable or rate limited:** return the stable class and provider retry-after bound; Hanoon may create a durable retry obligation within policy.
- **Binding generation changed:** deny immediately, refresh metadata, and require the controller to select the current binding.
- **Audit commit failed:** return `receipt_persistence_failed` even if the item was resolved; no success reaches Hanoon.
- **Client key compromised:** revoke the installation client at the broker, set every binding to `compromised`, increment generations, and require protected-host reenrollment.
- **Service-account token compromised:** revoke it in the vault provider, disable the adapter, rotate broker configuration on the protected host, and reverify every binding.
- **Plugin restart:** reload only secret-free metadata and settings; no credential cache is reconstructed.
- **Broker restart:** recover idempotency and audit state before accepting requests; no resolved credential survives restart.

## Data retention

Hanoon binding metadata and receipts follow the plugin's operational history retention. Broker request/audit receipts remain long enough to cover Hanoon's maximum task, retry, and incident-investigation window. Tombstones retain identifiers and outcome metadata but not external references.

Resolved secret values have operation lifetime only. The adapter drops references in `finally` paths and never writes swap, cache, temp files, core dumps, traces, or structured diagnostics containing values. JavaScript cannot guarantee physical zeroization; the security claim is no intentional persistence, propagation, or reuse, not impossible runtime-memory recovery after broker-host compromise.

## Testing strategy

### Deterministic tests

- Every protocol enum, bound, nullability rule, and schema version accepts canonical input and rejects unknown or oversized input.
- Tenant, installation, certificate, binding, generation, policy digest, operation, deadline, nonce, request digest, and idempotency mismatches deny before adapter invocation.
- A duplicate completed request returns the original response; a changed digest under the same key denies; an interrupted request becomes an audited ambiguity without a second adapter call.
- Hanoon SQLite, broker audit rows, plugin logs, broker logs, tool results, error strings, and serialized test artifacts do not contain injected canary secret values or their prefixes.
- Controller and worker process fixtures receive no broker or vault variables.
- An agent-originated endpoint, external reference, operation, arbitrary URL, or raw provider argument cannot enter a request envelope.
- Audit failure, stale Hanoon fence, and response-validation failure prevent success.
- Topology failure makes every credential-resolving capability return `unsafe_topology` before broker dispatch.
- Binding deletion invalidates an outstanding generation and leaves a secret-free tombstone.

### Contract tests

The plugin client talks to a real TLS test server with a test CA and client certificates. Tests cover trusted and untrusted certificates, hostname validation, zero redirects, request cancellation, timeout, truncated response, invalid JSON, unknown schema, oversized body, and connection reuse after settings rotation.

Persistence tests use real temporary SQLite for both Hanoon and broker stores. Vault behavior is faked only at the adapter seam.

### Real live acceptance

A disposable 1Password vault and service account prove:

1. the broker starts without an interactive unlock;
2. the service identity can reach only the dedicated test vault;
3. an exact bound item verifies successfully;
4. an item outside scope fails;
5. a missing field returns `result: "invalid"` with `failureClass: "credential_invalid"` without revealing item contents;
6. a revoked service token fails closed;
7. a broker restart preserves request receipts but not resolved values;
8. a Hanoon plugin restart reauthenticates without an agent receiving credentials;
9. the secret-canary scan across plugin database, broker database, logs, BB thread output, and test artifacts is empty;
10. `bb telegram-agent doctor --json` reports every gate and no secret material;
11. no controller or worker host can reach the broker administrative interface or read its secret storage;
12. a controller-side negative probe cannot read or change broker settings, plugin trust roots, plugin route tokens, or credential policy;
13. teardown revokes the service account, removes the disposable vault items, revokes the broker client, and records completion.

Every required live item has a start time, end time, actor, disposable resource id, command or UI procedure, expected result, actual result, evidence reference, and cleanup status. Missing external access is `incomplete`; it never becomes a pass through mocks.

### Red-state proof

The acceptance package must demonstrate that these deliberate violations fail their matching gates before being reverted:

- expose a canary value in a synthetic log;
- allow an unknown protocol field;
- accept a stale binding generation;
- point the client at a redirecting endpoint;
- run the topology check with the broker host marked agent-accessible;
- make broker audit persistence fail after adapter success;
- reuse one idempotency key with changed request identity.

## Acceptance criteria

- No raw application or vault credential enters Hanoon settings, SQLite, agent input, tool output, BB events, agent shell environments, process-wide broker environment, logs, or evidence. A reviewed `op` adapter may pass only its scoped service token to its short-lived broker child as specified above.
- The broker service account is scoped to one disposable vault and is configured only on the protected broker host.
- The Hanoon broker client can perform only the two protocol operations defined here.
- The controller can list, inspect, and verify only opaque bindings belonging to its installation.
- `vault.binding.verify` resolves exactly one configured field, releases no value metadata, audits before success, and replays safely.
- Unsafe topology, stale fence, stale generation, wrong installation, invalid client certificate, unavailable audit, and unknown protocol input all fail closed before a successful result.
- The trust-kernel finalizer may cite a verification receipt but cannot turn vault resolution into a claim of application validity.
- Deterministic suites, TLS contract tests, real temporary-database tests, all red-state proofs, and the disposable live acceptance sheet pass with no skipped mandatory case.
- No existing merge, deployment, production, Telegram pairing, project policy, memory, monitor, or job-execution invariant changes.

## Explicitly deferred child work

The next specification adds one provider-native identity connector and an authoritative account probe. OAuth callbacks, application writes, browser profiles, session cookies, password form filling, TOTP, WebAuthn, rotation, central multi-tenancy, and a hosted broker offering are outside this foundation and remain unavailable.

Approval of this child specification authorizes implementation planning only. It does not authorize creation of a real vault, service account, credential binding, certificate, external account, or production deployment.
