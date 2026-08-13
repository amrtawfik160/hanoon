import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ANSWER_CLAUSES,
  ANSWER_CLAUSE_IDS,
  ANSWER_JUDGE_PROFILE,
  ANSWER_RUBRIC_VERSION,
  type AnswerClauseId,
  buildAnswerJudgeSpawnArgs,
  buildClauseAssessment,
  buildClauseJudgePrompt,
  detectExplicitClauseViolation,
  parseClauseVerdict,
  sanitizeInfrastructureDetail,
} from "../src/eval/answer-contract";

const repositoryRoot = join(import.meta.dirname, "..");

it("keeps every clause id unique and stable", () => {
  expect(new Set(ANSWER_CLAUSE_IDS).size).toBe(ANSWER_CLAUSES.length);
  expect(ANSWER_CLAUSE_IDS).toContain("no-tool-narration");
  expect(ANSWER_CLAUSE_IDS).toContain("not-process-only");
});

it("pins the answer judge identity and rubric version", () => {
  // Catches silently inheriting project defaults or accepting a different judge profile.
  expect(ANSWER_RUBRIC_VERSION).toBe("answer-contract-hybrid-v1");
  expect(ANSWER_JUDGE_PROFILE).toEqual({
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoningLevel: "max",
    serviceTier: "fast",
    permissionMode: "auto",
    visibility: "hidden",
  });
});

it("records deterministic and model clause provenance with the pinned identity", () => {
  // Catches losing source, thread, rubric, or judge identity when results are serialized.
  expect(buildClauseAssessment({
    clauseId: "no-dead-end-referral",
    holds: false,
    source: "deterministic",
    reason: "Explicitly transfers a routine BB action to the owner.",
    judgeThreadId: null,
  })).toEqual({
    id: "no-dead-end-referral",
    holds: false,
    source: "deterministic",
    reason: "Explicitly transfers a routine BB action to the owner.",
    judgeThreadId: null,
    rubricVersion: "answer-contract-hybrid-v1",
    judgeProfile: {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "max",
      serviceTier: "fast",
      permissionMode: "auto",
      visibility: "hidden",
    },
  });
  expect(buildClauseAssessment({
    clauseId: "outcome-first",
    holds: true,
    source: "model",
    reason: "The result leads the reply.",
    judgeThreadId: "thr_clause_1",
  }).judgeThreadId).toBe("thr_clause_1");
});

it("builds the exact pinned hidden BB spawn tuple", () => {
  // Catches a missing pin, an obsolete flag, or a provider/model override at the CLI boundary.
  expect(buildAnswerJudgeSpawnArgs({
    project: "proj_1",
    title: "answer-eval status-good",
    prompt: "judge prompt",
  })).toEqual([
    "thread", "spawn",
    "--project", "proj_1",
    "--provider", "codex",
    "--model", "gpt-5.6-sol",
    "--reasoning-level", "max",
    "--service-tier", "fast",
    "--permission-mode", "auto",
    "--visibility", "hidden",
    "--title", "answer-eval status-good",
    "--prompt", "judge prompt",
    "--json",
  ]);
});

it("builds one isolated clause prompt with operational definition and distinct anchors", () => {
  // Catches reverting to a monolithic prompt or using the golden corpus as calibration examples.
  const prompt = buildClauseJudgePrompt({
    clauseId: "no-dead-end-referral",
    ownerMessage: "What is blocking the release?",
    answer: "The worker is blocked on a migration assertion.",
  });

  expect(prompt).toContain(`Rubric version ${ANSWER_RUBRIC_VERSION}`);
  expect(prompt).toContain('clause id "no-dead-end-referral"');
  expect(prompt).toContain("Operational definition:");
  expect(prompt).toContain("Positive anchor (holds):");
  expect(prompt).toContain("Negative anchor (fails):");
  expect(prompt).toContain("Have the worker inspect its diagnostic view before retrying.");
  expect(prompt).toContain("Please open the workspace panel and click Stop yourself.");
  expect(prompt).not.toContain("same assertion since 14:20");
  expect(prompt).not.toContain("You'll need to open the BB app");
});

it("keeps no-invented-progress closed to completion metrics rather than ordinary facts", () => {
  // Catches broadening completion progress into an unverified-fact or timestamp rule.
  const prompt = buildClauseJudgePrompt({
    clauseId: "no-invented-progress",
    ownerMessage: "What is the current state?",
    answer: "The check has failed repeatedly since breakfast after three attempts.",
  });

  expect(prompt).toContain("unsupported completion percentages and forecasts of time-to-completion");
  expect(prompt).toContain("Observed timestamps, elapsed durations, retry counts, attempt counts, event counts, error text, and ordinary status facts are outside this clause");
  expect(prompt).toContain("The check has failed repeatedly since breakfast after three attempts.");
  expect(prompt).toContain("The batch is 72% complete and is forecast to finish in 11 minutes.");
});

it("keeps no-dead-end-referral closed to explicit owner BB operation delegation", () => {
  // Catches treating a worker recommendation as an owner dead-end transfer.
  const prompt = buildClauseJudgePrompt({
    clauseId: "no-dead-end-referral",
    ownerMessage: "What should happen next?",
    answer: "The worker should inspect its own diagnostic view before retrying.",
  });

  expect(prompt).toContain("explicitly delegating a routine BB app/UI/tool operation to the owner");
  expect(prompt).toContain("open/click/navigate/stop/restart/run themselves");
  expect(prompt).toContain("It holds when the reply recommends what the worker should do");
  expect(prompt).toContain("The worker should inspect its own diagnostic view before retrying.");
  expect(prompt).toContain("Please open the workspace panel and click Stop yourself.");
});

it("uses explicit deterministic violations without auto-passing nuanced clauses", () => {
  // Catches a deterministic shortcut that incorrectly passes a clause without model judgment.
  expect(detectExplicitClauseViolation(
    "no-dead-end-referral",
    "You'll need to open the BB app and stop that thread yourself.",
  )).toContain("owner");
  expect(detectExplicitClauseViolation(
    "no-dead-end-referral",
    "The worker should stop retrying and inspect its failed check.",
  )).toBeNull();
  expect(detectExplicitClauseViolation(
    "no-tool-narration",
    "I called telegram_agent_read_thread and BB does not expose an ETA.",
  )).toContain("tool");
  expect(detectExplicitClauseViolation(
    "no-tool-narration",
    "The worker is blocked on the same migration assertion.",
  )).toBeNull();
});

it("parses exactly one matching clause verdict", () => {
  // Catches accepting a full multi-clause answer, the wrong clause, or extra wrapper text.
  expect(parseClauseVerdict(
    '{"id":"no-dead-end-referral","holds":true,"why":"It keeps the action with the worker."}',
    "no-dead-end-referral",
  )).toEqual({
    id: "no-dead-end-referral",
    holds: true,
    why: "It keeps the action with the worker.",
  });
});

it.each([
  ["multiple clauses", '{"clauses":[]}', "no-tool-narration"],
  ["wrong id", '{"id":"outcome-first","holds":true,"why":"ok"}', "no-tool-narration"],
  ["fenced output", '```json\n{"id":"no-tool-narration","holds":true,"why":"ok"}\n```', "no-tool-narration"],
  ["preamble", 'Result: {"id":"no-tool-narration","holds":true,"why":"ok"}', "no-tool-narration"],
  ["extra field", '{"id":"no-tool-narration","holds":true,"why":"ok","source":"model"}', "no-tool-narration"],
  ["missing reason", '{"id":"no-tool-narration","holds":true}', "no-tool-narration"],
])("fails closed for %s clause output", (_label, output, clauseId) => {
  // Catches treating malformed or ambiguous judge output as a pass.
  expect(parseClauseVerdict(output, clauseId as AnswerClauseId)).toBeNull();
});

it("sanitizes captured infrastructure detail without exposing prompt or answer text", () => {
  // Catches an infrastructure failure path that leaks sensitive calibration inputs.
  expect(sanitizeInfrastructureDetail(
    "bb failed: owner=owner-secret answer=answer-secret prompt=prompt-secret",
    ["owner-secret", "answer-secret", "prompt-secret"],
  )).toBe("bb failed: owner=[redacted] answer=[redacted] prompt=[redacted]");
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
