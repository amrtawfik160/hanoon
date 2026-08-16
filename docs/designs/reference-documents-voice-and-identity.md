# Reference documents, voice notes, and identity

Status: built and tested on 2026-08-16, except the gaps named under
[What is not built](#what-is-not-built). Design settled the same day.

## Why

Hanoon is strong at running BB safely and weak at everything that is not BB. It
cannot be spoken to, it cannot be given a specification to work against, it has
no identity beyond a tone overlay, and nothing it reads from outside our own
machines can become part of an answer.

The last one is the quiet blocker, though not in the way it first appears. The
hidden controller already has the shell, the `bb` CLI, every installed skill and
MCP server, and whatever web tools its provider ships with. Its searches and
page fetches are already projected into evidence as `retrieved_content`
(`src/controller/evidence-projector.ts:282-321`). What is missing is one row in
`CLAIM_PROOFS`: `retrieved_content` backs no claim kind except `uncertainty`
(`src/controller/finalization-contract.ts:114-122`), so the agent can only ever
say it is unsure about what it read. It cannot state what a source said.

This design adds four things: voice notes in, reference documents the whole
pipeline works against, a proof kind for readings from outside, and an identity
that survives being open source.

## Non-goals

Deliberately not in scope, each for a stated reason.

| Not doing | Why |
| --- | --- |
| Building web search | Provider sessions bring their own. We only need its results to count, which is the outside-source proof kind. Where a provider or its configuration has none, the ability is simply absent, which is the degradation rule below. |
| Voice replies | Needs a speech service and a key. Our answers carry links, ids and evidence, which read better than they listen. |
| Email or other channels | Large plumbing, small gain when the owner already has this on their phone. |
| Unprompted outreach and self-tuning | Explicitly dropped from scope during design. The identity layer must not decide when to speak. |
| Browser, image generation, code sandbox | No demonstrated need yet. The shell is still there when one appears. |
| Any new required API key | A fresh open-source install must work. Every optional ability degrades to a plain "not available on this install" message. |

## Language

New terms, for `CONTEXT.md` when this lands.

**Reference document**: A specification the owner gives Hanoon to work against,
scoped either to one project or to every project. It is a source to be consulted,
never an instruction to be followed.
_Avoid_: Uploaded file, attachment, knowledge base

**Structural map**: The heading tree of a reference document with a one-line
summary per section. Small enough to be present in full whenever the document is
in scope, so the agent always knows what exists before it knows what it says.
_Avoid_: Summary, table of contents

**Passage**: One retrievable chunk of a reference document's body, carrying its
section path. The unit of search and of citation.
_Avoid_: Chunk, excerpt, snippet

**Outside reading**: A durable record that the agent read something not produced
by our own tools, naming the source, when it was captured, and a bounded excerpt
of what was actually read.
_Avoid_: Search result, fetched page, tool output

**Specification conflict**: A disagreement between a reference document and the
instruction being followed about *what to build or what rule holds*. A
disagreement about how to build it is not one.
_Avoid_: Mismatch, discrepancy, contradiction

**Conduct layer**: The fixed, non-overridable part of the agent's instructions,
describing what it cannot do rather than how it should sound.
_Avoid_: System prompt, persona, guardrails

**Identity layer**: The replaceable part, describing who the agent is and how it
talks. Ships with a default and can be replaced without forking.
_Avoid_: Persona, character, prompt

## 1. Voice notes in

The owner sends a voice note instead of typing. Nothing else changes.

- Ingress accepts Telegram `voice` and `audio` messages through the same durable
  claim path as text and images. No BB session starts before the update is
  claimed.
- The file is downloaded with the existing client under a size cap. Our current
  caps are 10 MB for still images and 20 MB for motion media
  (`MAX_CONTROLLER_IMAGE_BYTES`, `MAX_CONTROLLER_VIDEO_BYTES`), and a voice note
  sits far below either. Audio needs its own cap in the same place.
- Transcription is `bb voice transcribe <file> --type <mime> --json`, run on the
  executor's machine. BB owns the voice service; we own none of it and require
  no key.
- The transcript becomes the message text for that turn. A caption, when present,
  is appended rather than replaced.
- When BB has no voice service configured, the owner is told plainly, in the same
  shape as the existing oversized-image message. Never a silent drop.
- The audio is not kept once transcribed. The transcript is what enters the
  durable record and the conversation digest.

The transcript is the owner's message, not evidence about the world, so this
introduces no proof kind.

## 2. Reference documents

The motivating case is a 300 page PRD for a project, which the agent is expected
to know and work against for the life of that project.

### The honest constraint

A document that size cannot be held in context, and any design that implies
otherwise is lying. So it is built in two layers:

- The **structural map** is always available when the document is in scope. It is
  how the agent knows a section on billing exists, and roughly what it says,
  before reading a word of it.
- **Passages** are retrieved on demand underneath.

Retrieval alone produces an agent that misses what it was never prompted to look
for. The map is what closes most of that gap.

### Scope

Two kinds, both supported.

- **Project reference**: bound to one project, visible only to work on that
  project, living as long as that project's policy.
- **Global reference**: visible everywhere. For things like a company style
  guide.

Where they overlap the project reference wins, silently and without asking. A
PRD differing from a general guide is not a contradiction, it is a specification.

### Ingestion

- Sources: a document sent in the Telegram chat, or an absolute path on a
  connected machine that the owner points at.
- Formats: whatever the controller's provider reads natively. Markdown and plain
  text are safe everywhere. PDF is provider-dependent, so this is unresolved
  until we check each supported controller model rather than assume. Where the
  provider cannot read a format, the document is refused with a plain message
  rather than half-ingested, and adding a system dependency such as a PDF
  extractor is a decision to make deliberately, not by accident.
- Size decides where it runs. Under a text-length threshold it is ingested inside
  the turn and immediately answerable. Above it, a background job does the work
  and the owner is told when it finishes through the existing thread-notice path,
  so a book never holds the conversation hostage.
- Ingestion produces the structural map and the passages. Passages are chunked on
  heading boundaries under a size cap, each carrying its section path, and land in
  the existing memory store as a distinct record kind, embedded by the existing
  local embedding service and indexed by the existing full-text search. One store,
  not two.
- Section summaries are written by the model already configured under the
  existing background learning setting. No new setting.

### Versions

A newer upload of the same document replaces the previous one. Only one version
is ever searchable, because two live versions of a spec means retrieval quoting
the dead one with nothing looking wrong. A change record notes which sections
moved and when, which is the useful half of history without a second source of
truth.

### How it is recalled in conversation

- Standing memories keep exactly their current behaviour and their own ranking
  budget. A document cannot crowd out "always deploy on weekday mornings".
- Document passages never auto-inject their body. Recall injects a bounded number
  of stubs: section path, one-line title, id. The agent pulls the body by id when
  it decides the stub is worth it.

Two lanes, separate budgets. This is the one idea worth copying wholesale from
the reference implementation at `/root/github_projects/ai`.

### How it reaches the pipeline

Every stage consults it: plan, critique, build, test, review, docs. Phased by
leverage, planning and critique first, review second, implementation last.

Workers are BB threads that deliberately never open the plugin database, so:

- The **structural map** for the job's project is included in every stage prompt.
  It is bounded, and when it exceeds budget it is truncated by depth so the
  top-level shape always survives. Never tail-cut.
- **Search** is a new read-only CLI, `bb telegram-agent reference search
  "<query>"` and `bb telegram-agent reference show <id>`, returning ranked
  passages with section paths and ids. Read-only, no mutation, one source of
  truth, and it matches the CLI pattern the plugin already uses.

Known limitation: a worker can name a project it does not belong to and read that
project's reference. Every project belongs to the same single owner, so this is
noise rather than a privilege boundary, but it should be recorded rather than
discovered.

### Specification conflicts

A conflict is a disagreement about **what to build or what rule holds**. A
disagreement about **how to build it** is not.

- A conflict stops the stage and asks the owner in Telegram through the existing
  question path, naming the section and the instruction it disagrees with.
- An implementation-detail disagreement is noted in the reply, never asked about.
  Otherwise a 300 page document stops the pipeline over a stale library name and
  the feature gets turned off within a week.
- The owner's later instruction is not automatically right and neither is the
  spec. That is the point of asking.

This means a job can now stall waiting on a tap. That is a real behavioural
change and the reason the "what versus how" line is load-bearing.

## 3. Outside readings as claims

Most of this already exists. What follows is what is actually missing, verified
against the source rather than assumed.

### What is already there

- `retrieved_content` is a declared proof kind (`src/controller/proof-kinds.d.ts`).
- Native `webSearch`, `webFetch` and `imageView` items are projected into
  durable evidence with that proof kind, automatically, with no tool call from
  the agent (`src/controller/evidence-projector.ts:282-321`).
- The hard rule this design was going to add is **already enforced, by
  omission**. `retrieved_content` appears in no entry of `CLAIM_PROOFS` other
  than `uncertainty`, so an outside reading structurally cannot back a claim
  about a project, job, thread, monitor, pipeline, or deployment. That is good
  design that predates this document, and it should be locked with a test rather
  than left to survive by accident.

### What is missing

**A claim kind for what a source said.** Today the only affirmative use of
`retrieved_content` is an `uncertainty` claim, so the agent must frame every
external reading as doubt. It cannot say what a library's documentation states,
even having read it. This adds one claim kind whose compatible proofs are
exactly `{retrieved_content}`.

**A source the owner can see, but not in storage.** An earlier draft of this
design proposed putting a fetched page's URL into its evidence subject, so a
claim about a page would be filed under the page rather than under the opaque
`bb-item:<id>` (`src/controller/evidence-projector.ts:232`). That was tried and
reverted. The projector hashes every request and result precisely so a token in
a query string cannot become durable, and
`tests/controller-evidence-projector.test.ts` already asserts by name that a
fetched url never reaches the database. Weakening that for inspection
convenience is the wrong trade.

So the source reaches the owner where it always did: in the words of the claim,
which the agent writes and which are delivered. The durable subject stays
opaque. If filing ever needs to be more legible, the honest route is a subject
derived from the fetched content rather than from the request.

Reference document passages are the same shape: `retrieved_content`, with the
document and section as the subject.

The rule stays exactly as it is:

> An outside reading can never be the only thing backing a claim about our own
> systems, jobs, threads, machines, or deliveries.

It can say what a library's documentation states. It cannot say a deploy
succeeded. It already cannot. The work is keeping it that way while making the
first half possible.

## 4. Identity and conduct

Hanoon ships to strangers, so a single hardcoded character is wrong. The
instructions split into three layers, rendered in this order.

1. **Conduct**, fixed and not overridable. It describes what the agent cannot do:
   never claim a future action rather than a completed one, never claim what
   evidence does not support, never offer an ability it does not have, never
   describe itself as having done what no receipt shows. These are true because
   of how the system works, not because someone preferred them, which is why they
   cannot be edited.
2. **Identity**, replaceable. Name, character, what it cares about, how it talks.
   Ships with a default under the product's own name. An installation replaces it
   without forking.
3. **Working style**, unchanged. The owner's runtime overlay, still able to shape
   tone and habits and still unable to move a boundary.

Ordering is the mechanism: conduct is rendered first and nothing below it can
argue past it, the same layering the instructions already use for the style
overlay. The reference implementation mixes conduct and identity into one
editable file, which is safe when one person owns it and dangerous when anyone
can.

The default identity must not claim abilities that depend on optional setup, or a
fresh install introduces itself as something it is not.

## What is not built

Everything below was in the design and is deliberately absent from the shipped
work. None of it is blocked; each is a slice that was not worth guessing at
under time pressure.

- **A document sent as a Telegram attachment.** The front door for the
  motivating case is missing. Filing a specification works today by pointing the
  agent at a path it can already read, or by passing the text, and a PDF or
  Markdown file attached to a chat message is still ignored. Doing it well needs
  a decision about where a 300 page upload lands before anyone has said which
  project it belongs to, and that decision is worth making deliberately rather
  than at the end of a long session.
- **Inline versus background ingestion.** Ingest is synchronous. A very large
  document will hold its turn rather than handing off to a job with a completion
  notice.
- **One-line summaries in the structural map.** The map carries the heading tree
  and the size of each section, which needs no model. Summaries would say
  roughly what each section holds, and would cost a model pass per section on
  every ingest.
- **Stub recall in conversation.** Passages do not auto-inject as stubs into a
  chat turn. The agent reaches them by searching, which it is told to do. The
  two-lane ranking that keeps standing preferences from being crowded out is
  therefore not yet needed and not yet written.
- **PDF.** Unresolved exactly as stated below. Markdown and plain text are what
  the parser handles.

## Risks worth tracking

- **Retrieval over 300 pages is lossy.** The local embedding model is small. The
  map mitigates this and does not eliminate it. This needs an eval before review
  stages are allowed to cite it as grounds for blocking a change.
- **Stage prompt budget.** A map in every stage prompt costs context on every job,
  including jobs that never touch the spec. The budget and the depth-truncation
  rule need real numbers.
- **A stalled job.** The conflict ask can leave a stage waiting indefinitely.
  What happens after hours of no reply is unresolved and needs deciding during
  implementation.
- **PDF reading is unproven.** The controller can be a Claude or a gpt model and
  they do not read files identically. If neither reads PDF well enough, the
  choice is a system dependency or a narrower format list, and that decision
  should be made with evidence rather than assumed away here.
- **Ingestion cost.** Summarising the sections of a 300 page PDF is real spend.
  The owner should see an estimate before it starts, or at minimum the actual
  cost after.
- **The what-versus-how line is a model judgement.** It will be imperfect. A
  wrongly raised conflict costs one tap, which is survivable, but the rate should
  be observable.

## What was built

1. **Outside readings.** The `external_reading` claim kind, compatible with
   `retrieved_content` and nothing else, plus a test that states the
   prohibition directly rather than deriving it from the same table it guards.
   Smaller than it first looked: the proof kind and the projection already
   existed. Naming the source in the evidence subject was tried and reverted.
2. **Identity split.** `CONTROLLER_CONDUCT`, a replaceable
   `DEFAULT_CONTROLLER_IDENTITY`, and the owner's working style, rendered in
   that order. The identity is a plugin setting. Delivery budgets are computed
   and asserted at module load, so a future edit that squeezes out the owner's
   working style fails the build rather than truncating silently.
3. **Voice notes in.** Telegram `voice` and `audio` through
   `bb voice transcribe`, no new key and no new dependency. Every failure path
   answers in the chat, and a stranger's recording is never transcribed.
4. **Reference documents.** Parsing, chunking and the structural map; a
   `reference_documents` store with full-text search and versioned replacement
   that records what moved; `telegram_agent_add_reference` and
   `telegram_agent_search_reference`; a read-only
   `bb telegram-agent reference` command for worker threads that cannot open
   the database; and the map plus the conflict rule in every stage prompt that
   spawns a worker: plan, critique, build from plan, implementation, docs,
   review, and final review.

## Decisions and why

Compressed record of what was settled, so the reasoning is not lost.

| Decision | Chosen | Why |
| --- | --- | --- |
| Relationship to `/root/github_projects/ai` | Ideas only | Its strengths are breadth and behaviour, not architecture we want. Ours is safer and should stay so. |
| Axes of work | More it can do itself, colleague feel, knows more | Self-improvement and extra channels dropped as lower value for the cost. |
| Boundary | Stays inside the BB plugin | Containment and recoverability are why the agent is trustworthy. |
| Evidence rule | Holds unchanged | A second unverified path becomes the path everything drifts into. On inspection the proof kind already existed, so this needs a claim kind rather than a new lane. |
| Where abilities live | Both native and installed, split by a rule | If the owner's answer depends on it, it needs a declared capability and a proof kind. Exploration can stay on the plain shell. |
| Web search | Not our problem | Every provider ships one. Only the evidence gap was ours. |
| Voice | In only | Replies carry links and ids that read better than they listen, and speech out means another key. |
| Document scope | Project and global | A PRD belongs to one project. A style guide belongs everywhere. |
| Who consults documents | Every stage | A reviewer catching "this contradicts section 4.2" is the highest-value use and we have nothing like it today. |
| Conflicts | Ask the owner, for what-not-how only | Asking about everything gets the feature disabled. Asking about nothing lets the spec lose every argument. |
| New versions | Replace, and record what changed | Two live versions means retrieval quoting a dead spec with nothing looking wrong. |
| Worker access | Read-only CLI plus map in prompt | Materialised files drift. Pre-selected passages cannot anticipate what a builder needs three files in. |
| Persona | Split into fixed conduct and replaceable identity | Open source means anyone can edit it, so what must not be edited has to be a separate layer. |
