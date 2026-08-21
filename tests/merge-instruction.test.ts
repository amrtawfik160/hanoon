import { expect, it } from "vitest";
import { isMergeInstruction } from "../src/controller/merge-instruction";

it("reads a plain instruction to land the work", () => {
  for (const message of [
    "merge it",
    "Merge it.",
    "land this",
    "merge the PR",
    "merge the pull request",
    "please merge it",
    "go ahead and merge it",
    "yes, merge it",
    "ok merge it",
    "just land it",
    "Looks good. Merge it.",
    "Nice work. Land it.",
    "merge job_abc12345",
    "land the job job_abc12345",
  ]) {
    expect(isMergeInstruction(message), message).toBe(true);
  }
});

// "you have my approval", answered to the agent's own request for merge
// approval, was refused; the merge died and the turn burned its budget
// trying to work around its own guard. A grant that names approval itself is
// as unambiguous as the imperative.
it("reads an explicit grant of approval", () => {
  for (const message of [
    "you have my approval",
    "You have my approval.",
    "I approve",
    "i approve it",
    "approved",
    "Approved!",
    "approval granted",
    "please, you have my approval",
  ]) {
    expect(isMergeInstruction(message), message).toBe(true);
  }
});

it("refuses approval talk that grants nothing", () => {
  for (const message of [
    "do I have your approval?",
    "do you need my approval?",
    "approved once CI passes",
    "not approved",
    "I approve of the plan to ask first",
    "you would have my approval if the tests passed",
    "go ahead",
    "yes",
    "sounds good",
  ]) {
    expect(isMergeInstruction(message), message).toBe(false);
  }
});

it("refuses anything conditional, deferred, or hypothetical", () => {
  // A false positive merges work the owner did not ask to merge, so every one
  // of these has to fall through to the button.
  for (const message of [
    "merge it once CI passes",
    "merge it when the review is done",
    "if it looks good, merge it",
    "after the tests pass, ship it",
    "should I merge it?",
    "can you merge it?",
    "shall i merge this",
    "let me know before you merge it",
    "wait, don't merge it",
    "do not merge it",
    "don't merge it yet",
    "never merge it without asking",
    "not yet, hold off on merging it",
    "hold off, then ship it",
    "instead of merging it, open a draft",
    "unless it breaks, merge it",
    "ship it",
    "deploy it",
    "release it",
    "go live with it",
    "merge and deploy it",
    "reviewer said: merge it",
    "the reviewer wrote — merge it",
    "nice work — merge it",
  ]) {
    expect(isMergeInstruction(message), message).toBe(false);
  }
});

it("refuses talk about merging that is not an instruction", () => {
  for (const message of [
    "merge",
    "the merge failed",
    "what happened to the merge",
    "did the deploy go out",
    "how does merging work here",
    "I merged it myself",
    "merge conflicts everywhere",
    "the deployment is broken",
    "ship",
    "",
    "   ",
  ]) {
    expect(isMergeInstruction(message), message).toBe(false);
  }
});

it("refuses anything that is not usable text", () => {
  for (const value of [null, undefined, 42, {}, [], "x".repeat(2_001)]) {
    expect(isMergeInstruction(value)).toBe(false);
  }
});
