# Domain Docs

Engineering skills consume this repository's domain language before exploring or writing work artifacts.

## Read before exploring

- Read `CONTEXT.md` at the repository root.
- Read ADRs under `docs/adr/` that affect the area being changed.

Proceed silently when an optional ADR directory or relevant ADR does not exist. Create domain documentation only when a term or durable architectural decision is actually resolved.

## Layout

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/
```

`CONTEXT.md` is a glossary, not a specification or implementation record. ADRs are reserved for decisions that are difficult to reverse, surprising without context, and based on a real tradeoff.

## Use canonical vocabulary

Use terms as defined in `CONTEXT.md` in issue titles, specifications, tickets, tests, and code. When the glossary marks a synonym as avoided, use the canonical term.

If a needed concept is absent, reconsider whether the project already has a term for it. Use domain modeling only when a real language gap remains.

## ADR conflicts

Surface a conflict with an existing ADR explicitly. Do not silently override the recorded decision.
