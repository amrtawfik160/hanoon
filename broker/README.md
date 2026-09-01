# Hanoon Credential Broker

This package runs the protected broker service on a Linux control-plane host. It exposes private HTTPS routes, `POST /v1/operations` and the executor-fence attestation route `POST /v1/fences`, authenticated with TLS 1.3 client certificates. Installation and binding administration are available only through the local Unix socket used by `hanoon-credential-broker-admin`.

The broker returns binding metadata, health states, and audit receipt references. It never returns a resolved value, a vault reference, a vault id, a field value, a certificate private key, or a provider diagnostic.

## Build and install

Use Node.js 22 or newer and the repository's locked dependencies:

```bash
npm ci
npm run broker:build
npm pack --workspace @hanoon/credential-broker
```

Install the resulting package under `/opt/hanoon-credential-broker/current`. The package contains the compiled broker and shared protocol, the admin executable, this runbook, and the reference systemd unit.

The non-secret JSON configuration contains exactly these keys:

```json
{
  "listenHost": "broker.internal.example",
  "listenPort": 8443,
  "publicHostname": "broker.internal.example",
  "databasePath": "/var/lib/hanoon-credential-broker/broker.sqlite",
  "adminSocketPath": "/run/hanoon-credential-broker/admin.sock",
  "requestBodyLimitBytes": 16384,
  "responseBodyLimitBytes": 1048576,
  "retentionDays": 30
}
```

The configuration file must be absolute, regular, and not group- or world-writable. The listener host is a specific DNS name or IP address; wildcard listeners are rejected. The certificate loaded as `server_certificate` must contain the configured `publicHostname` in its subject alternative names.

## Protected credentials and PKI

Create a dedicated read-only 1Password service account for one dedicated vault. Do not use a personal, shared, production, recovery, or unrelated vault. Enter the service-account token on the protected host without putting it in a shell argument, environment variable, log, or file that an agent can read:

```bash
systemd-ask-password --echo=no --timeout=300 -n "1Password service-account token" \
  | sudo systemd-creds encrypt --with-key=host --name=onepassword_service_token \
      - /etc/credstore.encrypted/hanoon-onepassword-token.cred
```

Provision the other five encrypted credentials using the same fixed names expected by the service: `broker_data_key`, `broker_audit_key`, `server_certificate`, `server_private_key`, and `client_ca_certificate`. The two broker keys are raw 32-byte values. The last three are operator-created PEM material. The service refuses supported secret names supplied through the process environment.

Generate each broker key on the protected host and pipe it directly into its encrypted credential; do not write a plaintext key to disk, an argument, or an environment variable:

```bash
openssl rand 32 \
  | sudo systemd-creds encrypt --with-key=host --name=broker_data_key \
      - /etc/credstore.encrypted/hanoon-broker-data-key.cred
openssl rand 32 \
  | sudo systemd-creds encrypt --with-key=host --name=broker_audit_key \
      - /etc/credstore.encrypted/hanoon-broker-audit-key.cred
```

The broker supports systemd encrypted credentials only; other operating-system secret backends are unsupported.

The server certificate must be valid for `publicHostname`. The client CA credential must contain the CA that issued the Hanoon installation certificates. Keep the client private key outside the broker database and outside agent-accessible files.

## systemd deployment

Create the static service identity and protected directories on the broker host. Review the unit before installing it:

```bash
sudo systemd-analyze verify /opt/hanoon-credential-broker/current/deploy/hanoon-credential-broker.service
sudo install -m 0644 /opt/hanoon-credential-broker/current/deploy/hanoon-credential-broker.service \
  /etc/systemd/system/hanoon-credential-broker.service
sudo systemctl daemon-reload
sudo systemctl enable --now hanoon-credential-broker.service
```

The unit runs as `hanoon-broker`, enables no secret `Environment=` setting, and restricts writes to the state and runtime directories. `MemorySwapMax=0` requires a cgroup v2 host. Operators use the local CLI as the broker identity; controller and worker identities receive no access to the socket or credential directory:

```bash
sudo -u hanoon-broker /usr/bin/node /opt/hanoon-credential-broker/current/dist/broker/src/admin-cli.js status --json
```

## Enrollment

Enrollment input is bounded JSON from protected standard input. References and expected vault ids must never be command-line arguments.

```bash
sudo -u hanoon-broker /usr/bin/node /opt/hanoon-credential-broker/current/dist/broker/src/admin-cli.js installation add --stdin
sudo -u hanoon-broker /usr/bin/node /opt/hanoon-credential-broker/current/dist/broker/src/admin-cli.js binding add --stdin
sudo -u hanoon-broker /usr/bin/node /opt/hanoon-credential-broker/current/dist/broker/src/admin-cli.js installation doctor <installation-id> --json
sudo -u hanoon-broker /usr/bin/node /opt/hanoon-credential-broker/current/dist/broker/src/admin-cli.js status --json
```

`installation add` accepts the public client certificate, a topology receipt digest and expiry, and the expected vault id. It returns only a generated installation id and state. `binding add` accepts one exact `op://<26-character-vault>/<26-character-item>/<field>` reference and returns only an opaque binding id, state, and generation. It does not make a binding active; a later provider-authoritative connector is required for application use.

Typed connector enrollment is separate from the legacy vault binding command. Submit bounded JSON on protected standard input; the target and credential reference remain broker-private:

```bash
sudo -u hanoon-broker /usr/bin/node /opt/hanoon-credential-broker/current/dist/broker/src/admin-cli.js connector binding enroll --stdin
```

The request contains the project policy digest, one fixed Convex/Vercel/browser operation, its typed target, and (for workload identities) an opaque vault reference. The broker atomically records policy, encrypted target/reference, and audit events. The response contains only ids, state, generation, and the secret-free projection; it does not create credentials or provider resources. On Hanoon, from the active controller project context, run `bb telegram-agent access reconcile <project-id> --projection-json '<secret-free projection JSON>' --json`; this is a mutating local projection import, not a read-only inspection, and it accepts only the returned projection after the controller fence, active executor lease, and installation scope are checked. It does not contact the broker or verify a credential. Then use the owner-only guarded inspection tool. Current installation topology, audit, independent executor fence, and policy evidence is required before provider I/O, and the exact request envelope is persisted for restart/ambiguity recovery. The installed `@1password/sdk` 0.5.0 exposes no `AbortSignal` for `Secrets.resolveAll` and no public client close/dispose operation, so SDK-backed credential resolution fails closed before starting that operation; the repository's injected-port cancellation proof does not claim SDK transport cancellation. The repository's executable acceptance path uses synthetic local vault/TLS fixtures only.

The HTTPS client certificate fingerprint, expected vault reference, encrypted external reference, and all resolved values remain broker-side. The local CLI output contains only stable states, opaque ids, counts, and failure classes.

## Attestation, revocation, and recovery

Topology evidence is valid for no more than 30 days. Replace it without changing the installation identity or vault binding:

```bash
sudo -u hanoon-broker /usr/bin/node /opt/hanoon-credential-broker/current/dist/broker/src/admin-cli.js installation attest <installation-id> --stdin
```

To withdraw one binding, increment its generation and leave a tombstone:

```bash
sudo -u hanoon-broker /usr/bin/node /opt/hanoon-credential-broker/current/dist/broker/src/admin-cli.js binding revoke <installation-id> <binding-id>
```

If the installation client key may have leaked, revoke the installation immediately:

```bash
sudo -u hanoon-broker /usr/bin/node /opt/hanoon-credential-broker/current/dist/broker/src/admin-cli.js installation revoke <installation-id>
```

Installation revocation stops certificate authentication, marks every binding compromised, and increments every generation in one database transaction. Re-enrollment on the protected host is required before use can be considered again. If audit persistence fails, the transaction rolls back and the CLI reports only a stable failure class.

## Teardown

Stop the service, revoke the installation and service account, remove the dedicated disposable vault items, and retain only the secret-free audit evidence required by the retention policy:

```bash
sudo systemctl disable --now hanoon-credential-broker.service
sudo rm /etc/systemd/system/hanoon-credential-broker.service
sudo systemctl daemon-reload
```

Do not copy the database, credential directory, socket, PEM files, command output, or provider responses into a worktree, agent thread, support bundle, or screenshot.
