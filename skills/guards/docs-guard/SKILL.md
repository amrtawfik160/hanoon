---
name: docs-guard
description: Review documentation in the enclosing worker contract against current source and runnable evidence.
---

# Documentation review guard

Review only the files and evidence supplied by the enclosing worker contract. This guard does not authorize any state transition, approval, merge, deployment, push, or destructive cleanup.

Follow the enclosing stage's required output format, particularly strict JSON review packets. If no format applies, bound each finding with severity, file, line when known, evidence, and the smallest corrective action.

Verify names, commands, defaults, links, and examples against current source; preserve the established documentation structure. Exclude secrets, transient task reports, internal planning paths, and claims unsupported by runnable evidence. Report `passed` only after inspecting the relevant changed material and fresh verification evidence.
