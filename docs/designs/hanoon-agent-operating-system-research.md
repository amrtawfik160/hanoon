# Hanoon Harness Research Review

Status: research complete; implementation approval pending

Date: 2026-08-12

Compared baselines:

- Hanoon at commit `8652692` (`bb-plugin-telegram-agent`)
- Valor at commit `a13a31a083746d0c66e8cba17b84fea82c8b8096`

## Verdict

The Hanoon direction is correct, but the original sequencing was not strong enough to approve unchanged.

The recommended architecture is a BB-native thin trust kernel followed by measured expansion. Hanoon should adapt Valor's implemented ideas where evaluation shows they improve outcomes—schema-first exits, bounded recovery, context fidelity modes, hybrid recall, telemetry, and budgets—while retaining BB as the provider/session/worktree harness and retaining SQLite effects, claims, approvals, and receipts as the authority.

Two items move into Slice 1 before broader autonomy:

1. a minimum outcome-evaluation baseline; and
2. enforceable capability policy for every Hanoon controller tool.

This changes the roadmap from “build breadth, then measure and generalize safety” to “establish the trust and measurement kernel, then add breadth only when it produces measured lift.” It does not authorize implementation.

No source or code comparison proves that Hanoon is already more capable than Valor. That claim becomes defensible only after both systems are evaluated on the same task corpus, harness disclosure, tool access, model settings, and budget. Until then, “Valor-class breadth with stronger transactional safety” is a target, not a benchmark result.

## Method and limits

This review used primary sources from the organizations or authors responsible for the work, plus direct inspection of both local codebases. It did not use secondary listicles or framework marketing comparisons.

The code comparison separates three categories:

- **observed:** directly present in source or tests;
- **inferred:** an architectural consequence of the observed mechanism; and
- **decided:** the Hanoon response selected for the design.

Concurrent uncommitted Hanoon production changes were not treated as part of the baseline and are outside this documentation change.

## Architecture choices considered

| Choice | Benefit | Cost and risk | Decision |
| --- | --- | --- | --- |
| Copy Valor's bridge, worker, subprocess harness, and ledger topology | Fast feature-name parity and a mature reference implementation | Duplicates BB ownership, adds Redis/process recovery, imports fail-open completion paths, and increases the number of authorities | Rejected |
| Keep the original seven slices unchanged | Preserves the safe BB-native direction | Defers outcome evaluation to Slice 3 and generalized capability metadata to Slice 7, after the first autonomous behavior change | Rejected as sequenced |
| BB-native thin trust kernel plus evaluation-first expansion | Preserves Hanoon's transactional strengths, uses BB primitives, and makes each later capability earn its complexity | Requires a small evaluation and policy foundation before visible breadth | Selected |

## What the external evidence changes

### Prefer the simplest sufficient orchestration

Anthropic distinguishes deterministic workflows from model-directed agents and reports that successful systems tend to use simple, composable patterns, adding complexity only when it is needed. OpenAI similarly recommends beginning with a single-agent loop and adding multi-agent structure when tool overlap or prompt complexity justifies it.

Design response:

- keep the conversational controller model-directed;
- keep merge, deployment, approvals, effects, and workflow advancement deterministic;
- do not add another agent framework or provider runner;
- do not add multi-agent roles merely to match Valor's role count.

Sources: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), [A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/).

### Treat tool interfaces as part of capability

Anthropic's context guidance calls for a minimal viable set of distinct, well-described tools. OpenAI notes that overlap matters more than a raw tool count and recommends standardized reusable definitions. The SWE-agent paper independently shows that agent-computer interface design materially changes coding-agent performance.

Design response:

- retain Hanoon's distinct domain tools instead of replacing them with open-ended shell or URL tools;
- add a descriptor and blocking pre-execution policy to every existing Hanoon controller tool in Slice 1;
- avoid a brittle model-based intent classifier for tool selection;
- let stable controller/worker identity and enabled features select tool sets through BB's existing agent configuration seam.

Sources: [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/), [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793).

### Measure outcomes, not convincing transcripts

Anthropic's evaluation guidance separates the transcript from the final environment outcome, recommends multiple trials for nondeterministic systems, and combines deterministic, model, and human graders. OpenAI's evaluation playbook says the harness, tools, and budget materially change measured capability and recommends reporting cost per successful solve.

Design response:

- extend the existing answer-form evaluation rather than treating it as an outcome suite;
- make deterministic receipt/state assertions authoritative;
- use trace and answer graders as diagnostic evidence that cannot override a failed outcome assertion;
- run multiple trials for live nondeterministic scenarios;
- record model, provider, reasoning, tool manifest, prompt/policy version, context budget, token/cost budget, and retry allowance with every result;
- compare routing or harness changes under both a fixed budget and a clearly labeled strong-elicitation budget.

Sources: [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [A shared playbook for trustworthy third-party evaluations](https://openai.com/index/trustworthy-third-party-evaluations-foundations/), [METR task-completion time horizons](https://metr.org/time-horizons/).

### Reset long-running context with a structured handoff

Anthropic reports that compaction alone can leave long-running agents disoriented or prematurely confident. Its long-running harnesses use incremental work, durable progress artifacts, clean checkpoints, fresh sessions, and structured handoffs. OpenAI describes repository documentation as a progressively disclosed map and mechanically enforces architecture and documentation invariants.

Design response:

- preserve the planned context capsule and fidelity modes;
- prefer a fresh BB provider generation seeded from a typed capsule and receipts over indefinite in-place compaction;
- orient each new work unit from current repository state, accepted work, and the next bounded objective;
- keep project knowledge in a structured repository map, not in a giant standing prompt;
- add mechanical checks for knowledge-map links and architectural boundaries when the relevant slice lands.

Sources: [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps), [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/).

### Use independent evaluation selectively

Anthropic found a separate evaluator easier to calibrate than generator self-review, but also reports a full planner/generator/evaluator harness costing more than twenty times its solo example. The lesson is not “always add agents”; it is to ablate expensive components and retain them only where realistic evaluation shows lift.

Design response:

- retain Hanoon's independent review conversations for code delivery;
- require an explicit acceptance contract before a bounded implementation work unit;
- add reviewer count or evaluator loops only for task classes where the scorecard shows improved outcome per cost;
- never let the same attempt be its own independent judge.

Source: [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps).

### Make approvals and tool policy durable

OpenAI's Agents SDK exposes per-tool approval declarations, pauses a run on the exact call, serializes state, and resumes after a decision. Its guardrail documentation applies tool guardrails to every custom tool invocation and distinguishes blocking checks before side effects. OWASP identifies excessive functionality, permissions, and autonomy as separate risks.

Design response:

- bind approval to the exact capability call and durable call identity;
- persist the decision before resuming;
- revalidate current authorization and capability policy on resume;
- use blocking pre-execution checks for side-effecting tools;
- preserve Hanoon's narrower domain tools, one-use approvals, and effect receipts.

Sources: [OpenAI Agents SDK human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/), [OpenAI Agents SDK guardrails](https://openai.github.io/openai-agents-python/guardrails/), [OWASP LLM06: Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/).

### Fence credentials and untrusted connector content

The MCP authorization specification requires resource/audience-bound tokens and forbids token passthrough. MCP security guidance treats session state as insufficient authentication and documents confused-deputy and session-hijacking risks.

Design response:

- declare credential scope, egress, and data classification in capability descriptors;
- never use a connector token as controller identity;
- use short-lived, audience-bound credentials where the connector supports them;
- never pass an inbound connector token through to another service;
- treat connector content as untrusted context that cannot change capability policy.

Sources: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices).

### Borrow durable-execution patterns, not another runtime

Temporal's workflow model separates deterministic orchestration from nondeterministic activities and recommends small, recoverable, idempotent work units.

Design response:

- keep Hanoon's SQLite executor instead of adding Temporal;
- make recipe transitions deterministic;
- represent provider calls and external mutations as fenced, receipted effects;
- resume from committed state and never replay an irreversible side effect from model narration;
- checkpoint or roll over long histories at a typed boundary.

Sources: [Temporal Workflow Definition](https://docs.temporal.io/workflow-definition), [Temporal Activities](https://docs.temporal.io/activities).

## Valor code audit

The following observations refer to Valor commit `a13a31a083746d0c66e8cba17b84fea82c8b8096`.

### Mechanisms to adapt

| Valor mechanism | Observed source | Hanoon adaptation |
| --- | --- | --- |
| Schema-first route with a bounded route enum and fallback telemetry | `agent/session_runner/router.py`, `PM_TURN_JSON_SCHEMA`; `agent/session_runner/runner.py`, `_classify_turn` | Use a stricter plugin-owned finalization tool whose acceptance is bound to current evidence; record every rejection and missing-finalizer continuation |
| Normalized turn result and event seam | `agent/session_runner/harness/base.py`, `TurnRequest`, `TurnResult`, `TurnEvent`, `HarnessAdapter` | Reuse the conceptual normalization, but consume BB's provider/thread/item APIs instead of implementing another CLI adapter |
| Four context fidelity modes | `agent/context_modes.py`, `ContextFidelity` and `SKILL_FIDELITY` | Preserve `full`, `compact`, `minimal`, and `steering` packs with explicit budgets and typed references |
| Measured hybrid retrieval with lexical fallback | `agent/memory_retrieval.py`, `retrieve_memories` and `_retrieve_memories_rrf` | Keep Hanoon's current SQLite lexical/recency/importance/confidence ranking as baseline; add optional vector ranking as rebuildable cache and fuse only after an evaluation shows lift |
| Bounded tool-call budget and optional pause | `agent/tool_budget.py`, `evaluate_tool_budget` | Add durable per-attempt and per-workflow budgets whose denial is visible and cannot silently reset on resume |
| Schema fallback and completion-refusal metrics | `agent/session_runner/router.py`; `agent/session_runner/runner.py` | Add finalization acceptance, rejection, continuation, evidence-coverage, and unsupported-claim metrics |
| Iterative prompt hypothesis and evaluation loop | `scripts/autoexperiment.py`, `ExperimentRunner` | Run only in an actual isolated BB worktree/branch, cap spend, use multiple trials, and emit a proposal or reviewed job rather than editing live configuration |

Valor also documents useful operating principles in `CLAUDE.md`: context is a first-class resource, tools should be minimal and distinct, independent tasks may run concurrently, and repository rules should be mechanically enforced. Those principles are retained without copying Valor's runtime topology.

### Mechanisms not to copy

#### Duplicate process and provider ownership

Valor's bridge, Redis queue, standalone worker, CLI subprocess harness, resume-handle persistence, watchdog, and worktree manager solve responsibilities BB already owns for Hanoon. Copying them would introduce two session authorities and two recovery systems.

Decision: BB remains the sole provider, thread, interaction, host, environment, and worktree harness.

#### Fail-open completion

`agent/session_runner/completion_guard.py` explicitly allows completion when the ledger query fails, when the ledger is empty, when a terminal pull-request state is unavailable, or when a free-form structured `blocked_reason` is present. This avoids wedging Valor but permits an unverified terminal result.

Decision: Hanoon's finalization remains fail-closed for success claims. A blocker may end an attempt only as a blocker outcome, never as successful completion, and it must not manufacture missing evidence.

#### Raw or prefix-fallback delivery

Valor correctly prefers structured routing and measures fallback, but `agent/session_runner/runner.py` can still deliver regex-classified payloads and floor-deliver prefixless wrap-up text.

Decision: Hanoon delivers only an accepted structured finalization. A provider may receive one bounded corrective continuation; raw provider prose never becomes the durable Telegram answer.

#### Unisolated automatic prompt editing

`scripts/autoexperiment.py` says experiments use branch isolation, but `ExperimentRunner.branch` is assigned and never used to create or switch a branch or worktree. `_write_source` edits the active checkout and `_git_commit` commits the active branch.

Decision: Hanoon never runs that pattern against a live checkout or live prompt. Experiments require a verified isolated worktree, a recorded baseline, a budget, multiple trials, and a reviewed proposal boundary.

#### Raw telemetry payloads

`agent/session_telemetry.py` caps append-only JSONL events, but unknown event shapes preserve their raw payload.

Decision: Hanoon stores bounded typed projections, hashes, and stable references in SQLite. Unknown payloads are counted and dropped or redacted, not copied into durable telemetry.

## Hanoon baseline verified

The current Hanoon code already supplies the core primitives this roadmap needs:

- `src/storage/migrations.ts` defines durable jobs, approvals, effects, outbox entries, memories, and lease-bearing records in SQLite.
- `src/services/approval-service.ts`, `src/services/merge-handler.ts`, and `src/domain/gates.ts` bind expiring approval and merge evidence to the reviewed pull-request head.
- `src/services/merge-handler.ts` resolves the pull-request head with `git ls-remote`, and the validation tests reject ambiguous or mismatched evidence.
- `src/storage/store.ts` generation-fences effect and outbox leasing and persists resource claims.
- `src/controller/tools.ts` authorizes the durable controller, provides idempotent per-turn receipts for mutating tools, and selects controller tools through `bb.agents.configure`.
- `src/storage/memory-ranking.ts` provides a no-provider lexical, recency, importance, and confidence baseline.
- `src/eval/answer-contract.ts` and `scripts/eval-controller-answers.mjs` provide an opt-in answer-form judge that checks itself against golden cases before its verdict is accepted.

The important gaps are narrower than “build a harness”:

1. the standing controller instructions are also copied into the first input;
2. the default controller permission mode is `full` because hidden BB interactions cannot be answered from Telegram;
3. ordinary controller completion accepts provider prose rather than a structured, evidence-bound final action;
4. controller tools lack a common enforceable risk/proof/credential descriptor;
5. the answer evaluation intentionally does not grade factual or environmental outcomes;
6. trace, cost, recovery, and multi-trial outcome comparisons are not yet one correlated evaluation surface.

## Required design amendments

### Amendment 1: put a minimum evaluation baseline in Slice 1

Slice 1 extends, rather than replaces, the current answer-form evaluation. Before the finalizer controls owner delivery, record a baseline for:

- conversational answer form;
- evidence-backed live status;
- accepted and rejected success claims;
- missing finalization and bounded continuation;
- exact-call owner approval pause and resume;
- restart between accepted evidence, finalization, and Telegram delivery;
- no duplicate irreversible effect.

Deterministic fixtures run once. Nondeterministic provider scenarios run multiple trials. Each result records the complete harness configuration and reports success rate, cost per successful outcome, latency, and failure class. Slice 3 expands this into the trace cockpit, replay corpus, nightly regression lab, and prompt experiments.

### Amendment 2: put enforceable core capability policy in Slice 1

Every Hanoon-managed controller tool declares:

- stable capability id and schema version;
- read/write class and side-effect class;
- risk and data classification;
- reversibility and idempotency strategy;
- approval requirement and exact approval subject;
- allowed controller/worker role and project scope;
- credential and egress requirements;
- proof kinds and receipt type;
- bounded result projection.

A common blocking wrapper validates identity, current turn, policy, approval, and fence before a side effect. Slice 7 generalizes these descriptors for artifacts, connectors, recipes, and discovery; it does not postpone the core safety metadata.

### Amendment 3: gate adaptive routing on controlled evaluation

The most capable eligible model establishes the baseline. A smaller model, reduced reasoning level, lower context fidelity, or shorter retry budget may control a task class only after shadow evaluation meets explicit outcome and safety thresholds. An active attempt never switches its provider/model tuple.

### Amendment 4: make context rollover reset-first

Slice 4 uses a fresh provider generation plus a typed capsule, receipts, current repository state, and the next bounded objective. In-place compaction is an optimization within a generation, not the durable handoff mechanism.

### Amendment 5: specify hybrid memory as an evaluated fusion

Hanoon's current SQLite ranker remains the baseline and fallback. Optional embeddings are rebuildable cache data. Lexical and vector candidate lists are fused with a deterministic method such as reciprocal-rank fusion only if the held-out recall corpus improves without breaking lexical-provider-failure scenarios.

### Amendment 6: separate deterministic recipes from nondeterministic effects

Recipe state transitions, joins, retries, approval waits, and checkpoints are deterministic executor decisions. Provider calls, shell work, connector calls, and external mutations are fenced effects with durable results. A resume revalidates policy and consumes committed results; it does not replay narration.

### Amendment 7: add repository legibility and bounded maintenance

Project context is a short map into structured source-of-truth documents and current machine-readable state. CI checks architectural direction, links, schema/version drift, and focused size boundaries. Scheduled maintenance may identify and propose stale documentation or architecture debt, but it follows the same cost, effect, and review gates as other work.

## Power scorecard

“More powerful than Valor” is evaluated across outcomes, not feature count:

| Dimension | Required measure |
| --- | --- |
| Task capability | Outcome pass rate by scenario class and human-duration bucket |
| Truthfulness | Unsupported success claims; evidence coverage; false blocker claims |
| Long-horizon reliability | Completion rate after restart, provider failure, approval delay, and context rollover |
| Side-effect safety | Duplicate irreversible effects, stale approvals accepted, policy bypasses |
| Recovery | Mean recoveries per successful outcome and terminal failure classification |
| Efficiency | Tokens, provider cost, wall time, and cost per successful outcome |
| Context quality | Capsule size, retrieval hit quality, repeated-owner-context incidents |
| Tool quality | Invalid calls, ambiguous tool choice, guard denials, fallback rate |
| Review quality | Defects found independently, remediation cycles, escaped regression rate |
| Operator experience | Telegram decision completion, notification duplication, unresolved hidden interaction count |

Two reports are needed for any direct Valor comparison:

1. a controlled comparison with the same tasks, tools, models, and budgets; and
2. a strong-elicitation comparison where each system uses its best credible configuration and reports the differing harness and budget.

## Approval gate

Implementation planning may begin only after the owner approves the research-amended operating-system specification. Approval covers architecture and slice order, not automatic merge, deployment, connector installation, spending, credential changes, or destructive actions.

## Source register

### Agent and harness architecture

- Anthropic: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Anthropic: [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic: [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Anthropic: [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- OpenAI: [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
- OpenAI: [A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)
- SWE-agent authors: [Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793)

### Evaluation

- Anthropic: [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- OpenAI: [A shared playbook for trustworthy third-party evaluations](https://openai.com/index/trustworthy-third-party-evaluations-foundations/)
- METR: [Task-completion time horizons](https://metr.org/time-horizons/)

### Approval, security, and durable execution

- OpenAI Agents SDK: [Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- OpenAI Agents SDK: [Guardrails](https://openai.github.io/openai-agents-python/guardrails/)
- Model Context Protocol: [Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- Model Context Protocol: [Security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- OWASP: [LLM06: Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)
- Temporal: [Workflow Definition](https://docs.temporal.io/workflow-definition)
- Temporal: [Activities](https://docs.temporal.io/activities)
