# Proposal: catch a reply that answers nothing

Not implemented. This is a proposal for review, plus one eval scenario that
already pins the behaviour so a future gate can be graded against it.

## What happened

The owner asked the agent to update its own worktree and follow a set of
practices. The turn ran 87 seconds and made 9 tool calls. The whole delivered
reply was two aphorisms: a sentence naming the reference it should follow, and
a sentence about the lesson worth taking from it. No statement of what it did,
no finding, no next step. The owner's next message was "what do you mean".

That turn was not a boundary failure and not a false claim. It did the work and
then reported none of it.

## Why the existing gates missed it

The finalization contract already rejects two nearby shapes:

- `process_only` rejects a reply that is only a promise ("I'll look into it").
- `high_impact_text_unclaimed` rejects a success assertion with no matching
  proof ("the fix is deployed").

An aphorism is neither. It promises nothing and asserts nothing, so it passes
both. The gate has no notion of "this turn gathered evidence and then said
nothing about it".

## The rule worth considering

A turn that gathered evidence should say what it found.

Concretely, in `validateControllerFinalization`, when the turn has evidence
available (`context.evidenceByRef.size > 0`) and the candidate carries zero
claim segments, reject with a new code whose correction reads roughly: *You
gathered evidence this turn. Say what you found, and put anything you observed
in a claim segment.*

The signal is already in the validation context, so this costs no new
plumbing and no new state.

### Why this is not obviously safe to just turn on

The rule assumes evidence implies something worth claiming. That is not always
true:

- A turn may read a thread only to decide the question was about something
  else, then answer conversationally. Under the rule it must either invent a
  claim or lose the turn to a rejection loop.
- Evidence is projected from native items, so a turn can accumulate rows from
  routine navigation it never intended to report.
- Rejections cost revisions, and the revision limit is 8. A rule that misfires
  turns a good answer into a failed turn, which is the failure mode this
  branch just spent its time removing.

A softer variant avoids most of that: apply the rule only when the turn
recorded a `hanoon_tool` evidence row, meaning the agent deliberately invoked
something, rather than any `bb_item` projected from its own navigation. That
narrows it to turns that took an action and then declined to report it.

## Recommendation

Take the eval scenario first and hold the gate.

The scenario is written out below rather than applied. The golden corpus is
content-addressed: `answer-contract.test.ts` pins `RELEASE_GOLDEN_SHA256`, and
`evals/answers.json` and `evals/answer-expectations.json` must move together
with it. Landing that on one of three branches being consolidated into a single
PR would collide on the pinned hash, so this is left as a deliberate step for
whoever does the consolidation.

Add to `evals/answers.json`:

```json
{
  "id": "answerless-aphorism",
  "expect": "fail",
  "ownerMessage": "update the hanoon worktree to do that and follow the best practices",
  "answer": "That project is the reference now.\n\nThe lesson worth taking from it: nothing should hang on me remembering to mention something."
}
```

Add to `evals/answer-expectations.json`, where `outcome-first` is the clause
that fails, because the reply never states an outcome at all:

```json
{
  "id": "answerless-aphorism",
  "aggregate": "fail",
  "clauses": {
    "outcome-first": false,
    "no-tool-narration": true,
    "no-invented-progress": true,
    "bounded-uncertainty": true,
    "no-dead-end-referral": true,
    "not-process-only": true
  }
}
```

Then regenerate `RELEASE_GOLDEN_SHA256`; the answer eval is opt-in and never
part of `npm run check`, so this costs nothing at check time.

If the scenario shows the judge already discriminates, the cheaper fix is a
prompt change rather than a hard gate: the standing instructions say to answer
first and take the obvious next step, but they never say that a turn which
acted must report what it did. That sentence is a smaller change than a new
rejection code, and it cannot fail a turn.

If a gate is still wanted after that, prefer the `hanoon_tool` variant above,
and add it behind the same eval so a regression is visible before it ships.
