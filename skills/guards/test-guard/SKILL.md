---
name: test-guard
description: Review the enclosing worker's changed production path and its focused verification evidence.
---

# Test review guard

Review only the files and evidence supplied by the enclosing worker contract. This guard does not authorize any state transition, approval, merge, deployment, push, or destructive cleanup.

Follow the enclosing stage's output format, especially strict JSON review packets. Without an enclosing format, make every finding bounded with severity, file, line when known, evidence, and the smallest corrective action.

Prove the changed production path, including durable side effects and absence of forbidden effects. For behavioral changes, require observed RED before GREEN. Keep mocks at external boundaries and reject tests that merely restate implementation logic. Report `passed` only after inspecting the relevant changed material and fresh verification evidence.
