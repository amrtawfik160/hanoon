import { z } from "zod";

const scenarioIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
const unique = <T>(entries: readonly T[]): boolean => new Set(entries).size === entries.length;

const textExpectationSchema = z.object({
  scenarioId: scenarioIdSchema,
  kind: z.literal("text"),
  responseText: z.string().min(1).max(1_000),
  outboxText: z.string().min(1).max(1_000),
}).strict();

const jobStatusExpectationSchema = z.object({
  scenarioId: scenarioIdSchema,
  kind: z.literal("job_status"),
  responseText: z.string().min(1).max(1_000),
  outboxText: z.string().min(1).max(1_000),
  jobId: z.string().min(1).max(128),
  jobState: z.string().min(1).max(80),
}).strict();

const interactionExpectationSchema = z.object({
  scenarioId: scenarioIdSchema,
  kind: z.literal("interaction"),
  rowState: z.literal("delivered"),
  decision: z.enum(["allow_once", "deny"]),
  grantedPermissions: z.null(),
}).strict();

const deferredMonitorExpectationSchema = z.object({
  scenarioId: scenarioIdSchema,
  kind: z.literal("deferred_monitor"),
  responseContains: z.string().min(1).max(160),
  obligationPrefix: z.string().min(1).max(80),
}).strict();

const answerExpectationSchema = z.discriminatedUnion("kind", [
  textExpectationSchema,
  jobStatusExpectationSchema,
  interactionExpectationSchema,
  deferredMonitorExpectationSchema,
]);

const recoveryPromptExpectationSchema = z.object({
  scenarioId: scenarioIdSchema,
  exactText: z.string().min(1).max(1_000),
  requiredMarkers: z.array(z.string().min(1).max(160)).min(1).max(8).refine(unique, "recovery prompt markers must be unique"),
}).strict();

export const controllerScenarioAnswerFixtureSchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(answerExpectationSchema).min(1).max(64).refine(
    (cases) => unique(cases.map((candidate) => candidate.scenarioId)),
    "scenario answer expectation ids must be unique",
  ),
  recoveryPrompt: recoveryPromptExpectationSchema,
}).strict();

export type ControllerScenarioAnswerExpectation = z.infer<typeof answerExpectationSchema>;
export type ControllerScenarioAnswerFixture = z.infer<typeof controllerScenarioAnswerFixtureSchema>;
export type ControllerScenarioAnswerObservation = Readonly<{
  responseText: string | null;
  outboxText: string | null;
  observedJobStatus: Readonly<{ id: string; state: string }> | null;
  interactionRowState: string | null;
  interactionAnswer: Readonly<Record<string, unknown>> | null;
  monitorId: string | null;
  acceptedObligationRefs: readonly string[];
}>;
export type ControllerRecoveryPromptExpectation = z.infer<typeof recoveryPromptExpectationSchema>;

export function parseControllerScenarioAnswerFixture(candidate: unknown): ControllerScenarioAnswerFixture {
  return controllerScenarioAnswerFixtureSchema.parse(candidate);
}

export function evaluateControllerScenarioAnswer(
  expectation: ControllerScenarioAnswerExpectation,
  observation: ControllerScenarioAnswerObservation,
): boolean {
  switch (expectation.kind) {
    case "text":
      return observation.responseText === expectation.responseText
        && observation.outboxText === expectation.outboxText;
    case "job_status":
      return observation.responseText === expectation.responseText
        && observation.outboxText === expectation.outboxText
        && observation.observedJobStatus?.id === expectation.jobId
        && observation.observedJobStatus.state === expectation.jobState;
    case "interaction":
      return observation.interactionRowState === expectation.rowState
        && observation.interactionAnswer?.decision === expectation.decision
        && observation.interactionAnswer.grantedPermissions === expectation.grantedPermissions;
    case "deferred_monitor":
      return observation.responseText?.includes(expectation.responseContains) === true
        && observation.monitorId !== null
        && observation.responseText.includes(observation.monitorId)
        && observation.acceptedObligationRefs.includes(`${expectation.obligationPrefix}${observation.monitorId}`);
  }
}

export function isExpectedControllerRecoveryPrompt(
  expectation: ControllerRecoveryPromptExpectation,
  text: string,
): boolean {
  return text === expectation.exactText && expectation.requiredMarkers.every((marker) => text.includes(marker));
}
