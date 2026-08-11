---
name: clean-code-guard
description: Review the enclosing worker's changed code and verification evidence for correctness and maintainability.
---

# Clean code review guard

Review only the files and evidence supplied by the enclosing worker contract. This guard does not authorize any state transition, approval, merge, deployment, push, or destructive cleanup.

Use the enclosing stage's required output format. In particular, emit a strict JSON review packet when that is the required format. If no format is supplied, keep findings bounded and include severity, file, line when known, evidence, and the smallest corrective action.

Prioritize correctness before Clean Code, SOLID, DRY, KISS, and YAGNI. Inspect for duplicated orchestration, hidden state, callback-bearing persistence, swallowed errors, and compatibility branches that do not serve a current caller. Report `passed` only after inspecting the relevant changed material and fresh verification evidence.
