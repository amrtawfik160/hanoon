# Managed browser work

Use the browser only when a provider API or a deterministic CLI cannot do the
job. The browser profile is Hanoon's employee session, not the owner's personal
profile and not a source of credentials.

## Qualify access before opening a page

Read the selected profile and grants from BB:

```bash
bb browser status --profile <profile-id> --json
bb browser grants --profile <profile-id> --json
```

Continue only when all of these are true:

- the profile was provisioned for this Hanoon installation;
- readiness is healthy;
- the exact HTTPS origin already has a project or owner grant;
- the current task and project policy authorize the operation.

Do not create, select, import, repair, trust, grant, revoke, reset, delete, or
purge a profile. Those commands administer access and belong to the owner or an
access administrator. Do not fall back to a personal profile when the employee
profile is missing or unhealthy.

## Run the bounded journey

Pass a plain purpose, exact origin, profile id, and stable tab id to every
browser action. Keep one mutable profile lease at a time. Prefer visible clicks,
fills, and provider-native controls over page JavaScript.

Never read or return passwords, cookies, tokens, recovery codes, browser
storage, password fields, or clipboard contents. Never fill a credential after
an origin change or inside a cross-origin frame. Stop with
`human_presence_required` for CAPTCHA, WebAuthn, identity verification,
recovery, or any challenge the provider requires a person to complete.

## Prove the result

After a write, navigate to the provider's authoritative status view and read the
new state back. Return the provider object label, bounded status, observation
time, and page origin. Redact sensitive fields and omit DOM dumps, screenshots
of credentials, cookies, headers, and browser storage.

The journey is complete only when the authoritative read-back matches the
requested outcome. A click, navigation, or successful browser command alone is
not proof.
