import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  evaluateControllerScenarioAnswer,
  parseControllerScenarioAnswerFixture,
} from "../src/eval/controller-scenario-answer-contract";

it("parses the independent deterministic answer fixture", () => {
  const path = fileURLToPath(new URL("../evals/controller-scenario-answers.json", import.meta.url));
  const fixture = parseControllerScenarioAnswerFixture(JSON.parse(readFileSync(path, "utf8")));
  expect(fixture.schemaVersion).toBe(1);
  expect(fixture.cases.map((candidate) => candidate.scenarioId)).toEqual([
    "plain-conversation",
    "current-job-status",
    "duplicate-mutation-replay",
    "telegram-allow-once",
    "restart-after-owner-tap",
    "durable-deferred-monitor",
  ]);
});

it("rejects duplicate deterministic answer expectations", () => {
  expect(() => parseControllerScenarioAnswerFixture({
    schemaVersion: 1,
    cases: [
      { scenarioId: "plain-conversation", kind: "text", responseText: "one", outboxText: "one" },
      { scenarioId: "plain-conversation", kind: "text", responseText: "two", outboxText: "two" },
    ],
  })).toThrow(/unique|duplicate/i);
});

it("lets an independent expected-value mutation change the answer result", () => {
  const expectation = parseControllerScenarioAnswerFixture({
    schemaVersion: 1,
    cases: [{ scenarioId: "plain-conversation", kind: "text", responseText: "literal answer", outboxText: "literal answer" }],
    recoveryPrompt: { scenarioId: "process-only-finalization", exactText: "recovery", requiredMarkers: ["recovery"] },
  }).cases[0]!;
  if (expectation.kind !== "text") throw new Error("test fixture did not produce a text expectation");
  const observation = {
    responseText: "literal answer",
    outboxText: "literal answer",
    observedJobStatus: null,
    interactionRowState: null,
    interactionAnswer: null,
    monitorId: null,
    acceptedObligationRefs: [],
  };

  expect(evaluateControllerScenarioAnswer(expectation, observation)).toBe(true);
  expect(evaluateControllerScenarioAnswer({ ...expectation, responseText: "mutated answer" }, observation)).toBe(false);
});
