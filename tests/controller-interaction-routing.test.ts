import { expect, it } from "vitest";
import { routeThreadInteraction } from "../src/controller/interaction-routing";
import type { ThreadInteraction } from "../src/controller/questions";

type ApprovalDecision = "allow_once" | "allow_for_session" | "deny";

function approval(summary: string, decisions: ApprovalDecision[]): ThreadInteraction {
  return { kind: "approval", interactionId: "pint_1", summary, decisions };
}

const QUESTION: ThreadInteraction = {
  kind: "user_question",
  interactionId: "pint_1",
  questions: [{
    id: "q1",
    prompt: "Which shape should the retry take?",
    shortLabel: "Approach",
    multiSelect: false,
    allowFreeText: false,
    options: [
      { value: "a", label: "Retry in place", description: null },
      { value: "b", label: "Fresh thread", description: null },
    ],
  }],
};

// The failure this exists to prevent: a thread the controller started raised a
// three-option design question and it arrived on the owner's phone at 1:50am as
// a menu to tap.
it("sends a spawned thread's design question to the controller", () => {
  expect(routeThreadInteraction({ threadOwnedByController: true, interaction: QUESTION }))
    .toMatchObject({ audience: "controller" });
});

it("leaves a question from the owner's own thread with the owner", () => {
  expect(routeThreadInteraction({ threadOwnedByController: false, interaction: QUESTION }))
    .toMatchObject({ audience: "owner", reason: "thread_not_controller_owned" });
});

it("routes an ordinary command approval to the controller without a standing grant", () => {
  const route = routeThreadInteraction({
    threadOwnedByController: true,
    interaction: approval("wants to run:\n\n`npm test`", ["allow_once", "allow_for_session", "deny"]),
  });
  expect(route).toEqual({ audience: "controller", decisions: ["allow_once", "deny"] });
});

it.each([
  ["wants to run:\n\n`gh pr merge 42 --squash`", "merge_or_deploy"],
  ["wants to run:\n\n`git push origin main`", "merge_or_deploy"],
  ["wants to run:\n\n`vercel deploy --prod`", "merge_or_deploy"],
  ["wants to run:\n\n`terraform apply`", "merge_or_deploy"],
  ["wants to run:\n\n`npm publish`", "irreversible_external_action"],
  ["wants to run:\n\n`gh auth login`", "irreversible_external_action"],
  ["wants to run:\n\n`curl -X POST https://api.example.com/charge`", "irreversible_external_action"],
  ["wants to run:\n\n`stripe charges create --amount 5000`", "irreversible_external_action"],
])("keeps %s with the owner", (summary, reason) => {
  expect(routeThreadInteraction({
    threadOwnedByController: true,
    interaction: approval(summary, ["allow_once", "deny"]),
  })).toEqual({ audience: "owner", reason });
});

// A local write inside the thread's own worktree is the work the controller
// asked for, so stopping to ask the owner about it is the noise being removed.
it("routes a local file write to the controller", () => {
  expect(routeThreadInteraction({
    threadOwnedByController: true,
    interaction: approval("wants to write files under src", ["allow_once", "deny"]),
  })).toMatchObject({ audience: "controller" });
});

it("gives the owner an approval that offers only a standing grant", () => {
  expect(routeThreadInteraction({
    threadOwnedByController: true,
    interaction: approval("wants to run:\n\n`npm test`", ["allow_for_session"]),
  })).toMatchObject({ audience: "owner" });
});

// The plugin cannot turn this into a menu for anyone, so the controller hears
// its own thread is stuck rather than the owner being woken to look in BB.
it("tells the controller about a block it cannot represent", () => {
  expect(routeThreadInteraction({
    threadOwnedByController: true,
    interaction: { kind: "unsupported", interactionId: "pint_1" },
  })).toMatchObject({ audience: "controller" });
});
