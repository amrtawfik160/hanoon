# Matt Pocock Skill Migration Research

Status: research complete

Date: 2026-08-25

Wayfinder ticket: [Inventory the promoted Matt Pocock skill set and trust model](https://github.com/amrtawfik160/hanoon/issues/30)

Inspected upstream revision: [`6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`](https://github.com/mattpocock/skills/commit/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76)

## Verdict

Hanoon should replace both the Superpowers workflow root and its older three-skill Matt Pocock discovery root with one pinned, curated Matt Pocock root containing the 25 skills in the upstream plugin manifest. The manifest is the promotion boundary. Files under `misc`, `in-progress`, `deprecated`, or any future unlisted bucket remain outside the executable bundle.

Hanoon should preserve the upstream distinction between user-invoked and model-invoked skills:

- The 14 user-invoked skills are explicit workflow operations. A general worker does not auto-select them from their descriptions. Hanoon's workflow navigator may schedule them as durable steps, which is an explicit invocation by the orchestration layer.
- The 11 model-invoked skills may be selected for a matching worker role and task state through Hanoon's capability policy.
- `ask-matt` remains user-invoked in the vendored source. The workflow navigator may explicitly schedule it only when the next workflow step is unresolved, recording why the fallback was needed. Hanoon does not edit the upstream frontmatter or make `ask-matt` globally auto-triggerable.

The source must be pinned by full Git commit and content digests. Version `1.2.3` alone is insufficient: Hanoon's current discovery revision and the inspected upstream revision both report `1.2.3`, while many promoted files differ between them. Synchronization remains a maintainer action from a reviewed local checkout. Plugin startup never fetches or updates skills.

Sources: [upstream plugin manifest](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/.claude-plugin/plugin.json), [upstream distribution decision](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/.agents/adr/0002-ship-as-a-claude-code-plugin.md), [upstream package metadata](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/package.json), [revision comparison](https://github.com/mattpocock/skills/compare/84fdeffd12f2ee307994d1eb6feb48173b6e0502...6654f6b60cd9d5be8b54c6fafe44346dabeb3b76).

## Promoted inventory

The upstream plugin manifest lists 25 promoted skills under `engineering` and `productivity`. Its distribution decision explicitly excludes the other buckets. The inspected promoted subtree contains 74 files and 202,855 bytes, including each skill's templates, references, scripts, and agent metadata.

### User-invoked workflow operations

| Skill | Intended use in Hanoon |
| --- | --- |
| `ask-matt` | Fallback router when the navigator cannot settle the next workflow step |
| `grill-with-docs` | Stateful product discovery with domain documentation |
| `triage` | Normalize incoming issues before implementation |
| `improve-codebase-architecture` | Survey for deepening opportunities |
| `setup-matt-pocock-skills` | Establish per-project tracker and domain-document conventions |
| `to-spec` | Synthesize settled context into a specification |
| `to-tickets` | Split a specification into dependency-linked tracer tickets |
| `wayfinder` | Resolve a multi-session decision map before specification |
| `implement` | Build an approved specification or ticket and close with review |
| `grill-me` | Stateless discovery outside a repository |
| `handoff` | Carry context across a real phase or workspace boundary |
| `teach` | Run a stateful learning workflow |
| `to-questionnaire` | Collect a decision asynchronously from its owner |
| `wait-what` | Re-explain context that did not land |

### Model-invoked disciplines

| Skill | Intended use in Hanoon |
| --- | --- |
| `diagnosing-bugs` | Evidence-first diagnosis for hard failures |
| `tdd` | Red, green, refactor implementation at an agreed seam |
| `prototype` | Throwaway executable evidence for a design decision |
| `research` | Primary-source research captured as a cited artifact |
| `domain-modeling` | Maintain precise domain language and rare ADRs |
| `codebase-design` | Design deep modules and clean seams |
| `code-review` | Standards and specification review against a fixed point |
| `resolving-merge-conflicts` | Resolve an active merge or rebase by intent |
| `wizard` | Generate a safe human-only setup or migration wizard |
| `grilling` | Reusable decision interview used by orchestration skills |
| `writing-for-agents` | Write instructions and documents that agents consume |

Invocation classification comes from each promoted `SKILL.md` frontmatter. The upstream reference also documents the same user-invoked versus model-invoked split. Sources: [upstream skills reference](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/README.md#reference), [`ask-matt`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/ask-matt/SKILL.md), [`wayfinder`](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/skills/engineering/wayfinder/SKILL.md).

## Supporting files that must travel with the skills

Copy each promoted directory as a complete bounded subtree, not only its `SKILL.md`. Required supporting material includes:

- tracker, triage, and domain templates under `setup-matt-pocock-skills`;
- phase-boundary guidance under `ask-matt`;
- testing references under `tdd`;
- prototype UI and logic guidance;
- domain-modeling formats;
- codebase-design references;
- diagnosis and wizard scripts;
- teaching state formats;
- `agents/openai.yaml` metadata shipped with every promoted skill.

The source is MIT licensed and the root license must remain beside the curated bundle. At the inspected revision the license digest is `0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5`. Source: [upstream MIT license](https://github.com/mattpocock/skills/blob/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76/LICENSE).

## Current Hanoon bundle and migration boundary

Hanoon currently locks 28 skills across six roots:

- 14 Superpowers skills under `skills/workflow-kit`;
- 3 Matt Pocock discovery skills under `skills/discovery`;
- 3 review guards under `skills/guards`;
- `pr-writer` under `skills/delivery`;
- 5 first-party skills under `skills/hanoon`;
- `technical-writing` and `unslop` under `skills/pstack`.

The migration should remove all 14 Superpowers skills, remove the duplicate three-skill discovery root, and remove the first-party `proportional-development-workflow` skill because it routes work through Superpowers. It should retain these non-workflow capabilities:

- `blast-radius`, `checking-system-logs`, `driving-bb`, and `durable-boundary-audit`;
- `clean-code-guard`, `docs-guard`, and `test-guard`;
- `pr-writer`;
- `technical-writing` and mandatory owner-facing `unslop`.

That produces 35 unique bundled skill ids before any later design decides to retire an additional non-workflow capability. Neither the current lock nor the promoted upstream manifest contains a skill id beginning with `do-`. The new contract should still reject any admitted `do-*` id so the requested removal remains mechanically true.

Local sources: [bundle contract](../../src/agent-skills/bundle-contract.js), [current lock](../../skills/skills.lock.json), [role resolver](../../src/agent-skills/role-resolver.ts), [current capability catalog](../../src/capabilities/catalog.ts), [Superpowers-specific first-party router](../../skills/hanoon/proportional-development-workflow/SKILL.md).

## Recommended trust and synchronization contract

### Source admission

1. Accept only an absolute local checkout of `https://github.com/mattpocock/skills` at an explicitly reviewed 40-character commit.
2. Require `package.json` and `.claude-plugin/plugin.json` to agree on package name and version.
3. Treat the plugin manifest's explicit `skills` array as the only source of promoted directories.
4. Require the reviewed skill id and path list in Hanoon code to match that manifest exactly. An upstream addition or removal therefore needs a normal reviewed Hanoon change.
5. Reject symlinks, non-regular files, dirty promoted paths, path escapes, duplicate ids, missing support files, oversized files, and a changed license.

### Bundle layout

Preserve the upstream `engineering` and `productivity` directories under one locked `skills/matt-pocock` parent. Keeping the bucket layout avoids rewriting upstream relative links and makes the copied paths match the reviewed manifest. Hanoon's integrity scanner treats that parent as one bounded two-level tree. BB itself discovers only immediate child skill directories, so the plugin manifest registers the `engineering` and `productivity` buckets separately.

During dual-engine expansion, keep the promoted copies of the three colliding recipe-v1 ids in an unregistered compatibility subtree. BB then sees exactly one plugin source for every runtime id while still exposing the other promoted ids. Lock the three historical descriptors as intentional shadows of the admitted ids. The later navigator execution slice must bind the promoted source explicitly, and final contraction removes the historical root after recipe-v1 drains.

Copy only:

- the root `LICENSE`;
- the 25 promoted directories named by the reviewed manifest;
- a bounded provenance record containing the source URL, full revision, package version, manifest digest, and license digest.

Do not copy the rest of the upstream repository and do not run `npx skills` or another network installer during activation.

### Invocation policy

Parse and lock `disable-model-invocation` as an explicit `user` or `model` invocation class. This becomes descriptor evidence rather than an unenforced comment:

- general profile selection may choose only model-invoked skills;
- manual slash commands may select user-invoked skills;
- the workflow navigator may explicitly schedule a user-invoked skill as a durable workflow step;
- `ask-matt` may be scheduled only from a recorded unresolved-next-step state;
- no skill grants its own tools, credentials, merge authority, or effect authority.

### Atomic update and verification

Stage the selected subtree and new lock, verify both before replacement, then atomically replace the old bundle. The lock should record every file digest and, for each skill, its source path, invocation class, source revision, and descriptor digest. Activation should fail closed on any mismatch.

Keep the existing bounds and add checks that:

- the reviewed upstream manifest digest matches `e531ddc6560515397ac32d93334fa3eb586b6b6bcc2e472c3646641fd3d2b951` for the initial pin;
- no bundled id is duplicated across retained roots;
- no admitted id begins with `do-`;
- no file from the removed Superpowers or old discovery roots remains in the lock;
- all Markdown links stay inside the locked Matt Pocock parent and resolve after copying;
- startup performs no network access and never repairs a mismatch automatically.

## Decision carried forward

The next design tickets can assume one curated, revision-pinned Matt Pocock bundle with 25 promoted skills and explicit invocation classes. The workflow navigator, not a fixed recipe classifier and not free-form model discovery, chooses user-invoked workflow operations. Hanoon's executor remains responsible for capability admission, persistence, effects, review evidence, merge, deployment, and recovery.

This research does not decide the navigator state model, artifact tracker interface, owner boundary, migration schema, or rollout gates. Those remain on the wayfinder map.
