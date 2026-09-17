# Capability evidence is universal

Current status: superseded for mutation idempotency. The `tool_receipts` table and claim/replay path are gone. Mutating controller tools re-run. Controller evidence rows remain as Telegram proof, not per-tool receipts. Capability profiles and append-only skill/tool/model receipts still identify what was selected.

Hanoon stores immutable capability profiles and append-only capability receipts for skills, tools, models, native adapters, connectors, and recipes. The previously planned skill-only table becomes a read-only compatibility projection, while existing tool receipts remain mutation-idempotency evidence linked from—not duplicated by—the universal records. This expands the schema beyond the earlier two-table slice, but gives every selected or denied capability the same auditable identity and proof boundary.
