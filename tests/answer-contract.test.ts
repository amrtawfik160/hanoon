import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ANSWER_CLAUSES,
  ANSWER_CLAUSE_IDS,
  buildAnswerJudgeSpawnArgs,
  buildJudgePrompt,
  parseAnswerVerdict,
} from "../src/eval/answer-contract";

const repositoryRoot = join(import.meta.dirname, "..");

function verdictJson(overrides: Record<string, boolean> = {}): string {
  return JSON.stringify({
    clauses: ANSWER_CLAUSES.map((clause) => ({
      id: clause.id,
      holds: overrides[clause.id] ?? true,
      why: "because",
    })),
  });
}

it("keeps every clause id unique and stable", () => {
  expect(new Set(ANSWER_CLAUSE_IDS).size).toBe(ANSWER_CLAUSES.length);
  expect(ANSWER_CLAUSE_IDS).toContain("no-tool-narration");
  expect(ANSWER_CLAUSE_IDS).toContain("not-process-only");
});

it("puts the owner message, the answer, and every clause into the judge prompt", () => {
  const prompt = buildJudgePrompt({ ownerMessage: "is it done?", answer: "Yes, merged at 14:02." });

  expect(prompt).toContain("is it done?");
  expect(prompt).toContain("Yes, merged at 14:02.");
  for (const clause of ANSWER_CLAUSES) expect(prompt).toContain(clause.id);
  // The judge cannot see the systems described, so it must be told not to grade truth.
  expect(prompt).toContain("never grade whether it is factually correct");
});

it.each([
  ["with optional model", "model-x", ["thread", "spawn", "--project", "proj_1", "--title", "answer-eval status-good", "--prompt", "judge prompt", "--json", "--model", "model-x"]],
  ["without optional model", undefined, ["thread", "spawn", "--project", "proj_1", "--title", "answer-eval status-good", "--prompt", "judge prompt", "--json"]],
] as const)("builds the current BB prompt spawn args %s", (_label, model, expected) => {
  expect(buildAnswerJudgeSpawnArgs({
    project: "proj_1",
    title: "answer-eval status-good",
    prompt: "judge prompt",
    ...(model ? { model } : {}),
  })).toEqual(expected);
});

it("reads a verdict where every clause holds", () => {
  expect(parseAnswerVerdict(verdictJson())).toMatchObject({ passed: true });
});

it("fails the answer when any single clause does not hold", () => {
  const verdict = parseAnswerVerdict(verdictJson({ "no-tool-narration": false }));

  expect(verdict?.passed).toBe(false);
  expect(verdict?.clauses.find((clause) => clause.id === "no-tool-narration")?.holds).toBe(false);
});

it("reads a verdict out of a fence or a preamble", () => {
  expect(parseAnswerVerdict("Sure:\n```json\n" + verdictJson() + "\n```")).toMatchObject({ passed: true });
});

it.each([
  ["prose", "All the rules look fine to me."],
  ["broken JSON", '{"clauses":[{"id":"outcome-first",]}'],
  ["a missing clause", JSON.stringify({ clauses: [{ id: "outcome-first", holds: true }] })],
  ["an unknown clause only", JSON.stringify({ clauses: [{ id: "invented", holds: true }] })],
])("refuses to grade %s rather than passing it silently", (_label, output) => {
  expect(parseAnswerVerdict(output)).toBeNull();
});

it("ignores a duplicated clause instead of letting it overwrite the first", () => {
  const doubled = JSON.stringify({
    clauses: [
      ...ANSWER_CLAUSES.map((clause) => ({ id: clause.id, holds: true, why: "" })),
      { id: "outcome-first", holds: false, why: "second opinion" },
    ],
  });

  expect(parseAnswerVerdict(doubled)).toMatchObject({ passed: true });
});

it("ships golden cases covering both a passing and a failing shape of every kind", () => {
  const { cases } = JSON.parse(
    readFileSync(join(repositoryRoot, "evals/answers.json"), "utf8"),
  ) as { cases: { id: string; expect: string; ownerMessage: string; answer: string }[] };

  expect(cases.length).toBeGreaterThanOrEqual(6);
  expect(new Set(cases.map((each) => each.id)).size).toBe(cases.length);
  expect(cases.some((each) => each.expect === "pass")).toBe(true);
  expect(cases.some((each) => each.expect === "fail")).toBe(true);
  for (const each of cases) {
    expect(["pass", "fail"]).toContain(each.expect);
    expect(each.ownerMessage.length).toBeGreaterThan(0);
    expect(each.answer.length).toBeGreaterThan(0);
  }
});
