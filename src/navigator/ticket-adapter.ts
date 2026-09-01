import type {
  NavigatorEffectAdapter,
  NavigatorEffectOutcome,
} from "./effect-protocol";
import {
  NavigatorEffectAmbiguousError,
  NavigatorEffectPermanentError,
  NavigatorEffectTransientError,
} from "./effect-protocol";
import {
  navigatorTicketReceiptSchema,
  type NavigatorTicketEffectContext,
  type NavigatorTicketReceipt,
  type NavigatorCapabilityEvidence,
} from "./effect-contracts";
import {
  navigatorGitObservationSchema,
  navigatorTicketWorkerReceiptResultSchema,
  navigatorTicketWorkerResultSchema,
  type NavigatorGitObservation,
} from "./implementation-contracts";
import type { WorkArtifactClaim, WorkArtifactSnapshot } from "../work-artifacts/models";
import type { JobResourceClaim } from "../autonomy/models";
import type { NavigatorTicketWorkerAttempt } from "./implementation-executor";

export type NavigatorTicketWorkerInput = Readonly<{
  attempt: NavigatorTicketWorkerAttempt;
  workOrder: NavigatorTicketWorkerAttempt["workOrder"];
  specification: WorkArtifactSnapshot;
  ticket: WorkArtifactSnapshot;
  ticketClaim: WorkArtifactClaim;
  resourceClaims: readonly JobResourceClaim[];
  capabilityEvidence: readonly NavigatorCapabilityEvidence[];
}>;

export type NavigatorTicketWorkerRun = Readonly<{
  resource: { kind: "bb_thread"; id: string };
  result: unknown;
}>;

export type NavigatorGitObservationRequest = Readonly<{
  purpose: "implementation" | "review" | "pull_request";
  worktreeId: string;
  integrationBranch: string;
  expectedHeadSha: string;
  baseHeadSha: string;
  comparisonBaseHeadSha: string;
  expectedChangedPaths: readonly string[];
}>;

export interface NavigatorGitObserver {
  observe(request: NavigatorGitObservationRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface NavigatorTicketWorkerOperation {
  run(input: NavigatorTicketWorkerInput, signal: AbortSignal): Promise<NavigatorTicketWorkerRun>;
  reconcile(input: NavigatorTicketWorkerInput, signal: AbortSignal): Promise<NavigatorTicketWorkerRun>;
  observe(request: NavigatorGitObservationRequest, signal: AbortSignal): Promise<unknown>;
}

export class NavigatorTicketWorkerUnavailableError extends Error {
  public readonly name = "NavigatorTicketWorkerUnavailableError";

  public constructor(
    public readonly reason: "missing" | "stale",
    public readonly resource: NavigatorTicketWorkerRun["resource"] | null = null,
  ) {
    super(`navigator ticket worker is ${reason}`);
  }
}

export class NavigatorTicketWorkerRetryableError extends Error {
  public readonly name = "NavigatorTicketWorkerRetryableError";

  public constructor(message: string, public readonly resource: NavigatorTicketWorkerRun["resource"] | null = null) {
    super(message);
  }
}

export class NavigatorTicketWorkerPermanentError extends Error {
  public readonly name = "NavigatorTicketWorkerPermanentError";

  public constructor(message: string, public readonly resource: NavigatorTicketWorkerRun["resource"] | null = null) {
    super(message);
  }
}

function workerInput(context: NavigatorTicketEffectContext): NavigatorTicketWorkerInput {
  return Object.freeze({
    attempt: context.ticket.attempt,
    workOrder: context.ticket.attempt.workOrder,
    specification: context.ticket.specificationSnapshot,
    ticket: context.ticket.ticketSnapshot,
    ticketClaim: context.ticket.claim,
    resourceClaims: context.resourceClaims,
    capabilityEvidence: context.capabilityEvidence,
  });
}

function isWorkerResource(value: unknown): value is NavigatorTicketWorkerRun["resource"] {
  if (typeof value !== "object" || value === null) return false;
  const resource = value as Record<string, unknown>;
  return resource.kind === "bb_thread" && typeof resource.id === "string" &&
    resource.id.trim().length > 0 && resource.id.length <= 256;
}

function normalizeWorkerRun(raw: unknown): NavigatorTicketWorkerRun | null {
  if (typeof raw !== "object" || raw === null || !("resource" in raw)) return null;
  const candidate = raw as { resource?: unknown; result?: unknown };
  return isWorkerResource(candidate.resource)
    ? { resource: candidate.resource, result: candidate.result }
    : null;
}

function expectedHeadSha(
  attempt: NavigatorTicketWorkerAttempt,
  rawResult: unknown,
): string {
  const parsed = navigatorTicketWorkerResultSchema.safeParse(rawResult);
  if (!parsed.success) return attempt.workOrder.baseHeadSha;
  return parsed.data.kind === "implementation_result"
    ? parsed.data.headSha
    : parsed.data.reviewedHeadSha;
}

function expectedChangedPaths(
  attempt: NavigatorTicketWorkerAttempt,
  rawResult: unknown,
): readonly string[] {
  const parsed = navigatorTicketWorkerResultSchema.safeParse(rawResult);
  return parsed.success && parsed.data.kind === "implementation_result"
    ? parsed.data.changedPaths
    : attempt.workOrder.changedPaths;
}

async function observeWorkerGit(
  operation: NavigatorTicketWorkerOperation,
  input: NavigatorTicketWorkerInput,
  run: NavigatorTicketWorkerRun,
  signal: AbortSignal,
): Promise<NavigatorGitObservation | null> {
  if (!navigatorTicketWorkerResultSchema.safeParse(run.result).success) return null;
  const rawObservation = await operation.observe({
    purpose: input.attempt.kind,
    worktreeId: input.attempt.workOrder.worktreeId,
    integrationBranch: input.attempt.workOrder.integrationBranch,
    expectedHeadSha: expectedHeadSha(input.attempt, run.result),
    baseHeadSha: input.attempt.workOrder.baseHeadSha,
    comparisonBaseHeadSha: input.attempt.workOrder.comparisonBaseHeadSha,
    expectedChangedPaths: expectedChangedPaths(input.attempt, run.result),
  }, signal);
  const parsedObservation = navigatorGitObservationSchema.safeParse(rawObservation);
  return parsedObservation.success ? parsedObservation.data : null;
}

function ticketReceipt(
  context: NavigatorTicketEffectContext,
  run: NavigatorTicketWorkerRun,
  gitObservation: NavigatorGitObservation | null,
): NavigatorTicketReceipt | null {
  const parsedReceiptResult = navigatorTicketWorkerReceiptResultSchema.safeParse(run.result);
  if (!parsedReceiptResult.success) return null;
  const isNormalResult = navigatorTicketWorkerResultSchema.safeParse(parsedReceiptResult.data).success;
  if (isNormalResult !== (gitObservation !== null)) return null;
  const receipt = navigatorTicketReceiptSchema.safeParse({
    kind: "run_navigator_ticket_worker",
    effectIdempotencyKey: context.effect.idempotencyKey,
    attemptId: context.ticket.attempt.id,
    resource: run.resource,
    exactHeadSha: gitObservation?.headSha ?? expectedHeadSha(context.ticket.attempt, run.result),
    result: run.result,
    gitObservation,
  });
  return receipt.success ? receipt.data : null;
}

function completedTicketOutcome(
  context: NavigatorTicketEffectContext,
  run: NavigatorTicketWorkerRun,
  gitObservation: NavigatorGitObservation | null,
): NavigatorEffectOutcome {
  const receipt = ticketReceipt(context, run, gitObservation);
  return receipt === null
    ? failureReceipt(
      context,
      new NavigatorTicketWorkerPermanentError("Navigator ticket worker receipt is invalid", run.resource),
    )
    : { outcome: "completed", receipt };
}

function failureReceipt(
  context: NavigatorTicketEffectContext,
  error: NavigatorTicketWorkerRetryableError | NavigatorTicketWorkerPermanentError,
): NavigatorEffectOutcome {
  if (!isWorkerResource(error.resource)) return classifyTicketWorkerError(error);
  return completedTicketOutcome(context, {
    resource: error.resource,
    result: {
      kind: "worker_failure",
      failureClass: error instanceof NavigatorTicketWorkerPermanentError ? "permanent" : "retryable",
      retryClass: "bounded_exponential",
      attempts: context.effect.attempts,
      summary: safeErrorMessage(error),
    },
  }, null);
}

function unavailableOutcome(error: NavigatorTicketWorkerUnavailableError): NavigatorEffectOutcome {
  return {
    outcome: "ambiguous",
    reason: `navigator ticket worker is ${error.reason}`,
    ...(isWorkerResource(error.resource) ? { resource: error.resource } : {}),
  };
}

function workerOperationError(
  context: NavigatorTicketEffectContext,
  error: unknown,
  resource: NavigatorTicketWorkerRun["resource"] | null,
): NavigatorEffectOutcome {
  if (error instanceof NavigatorTicketWorkerRetryableError) {
    return failureReceipt(context, error.resource === null && resource !== null
      ? new NavigatorTicketWorkerRetryableError(safeErrorMessage(error), resource)
      : error);
  }
  if (error instanceof NavigatorTicketWorkerPermanentError) {
    return failureReceipt(context, error.resource === null && resource !== null
      ? new NavigatorTicketWorkerPermanentError(safeErrorMessage(error), resource)
      : error);
  }
  if (resource !== null && !(error instanceof NavigatorEffectTransientError) &&
    !(error instanceof NavigatorEffectPermanentError) && !(error instanceof NavigatorEffectAmbiguousError)) {
    return failureReceipt(context, new NavigatorTicketWorkerRetryableError(errorMessage(error), resource));
  }
  return classifyTicketWorkerError(error);
}

function classifyTicketWorkerError(error: unknown): NavigatorEffectOutcome {
  if (error instanceof NavigatorTicketWorkerUnavailableError) {
    return unavailableOutcome(error);
  }
  if (error instanceof NavigatorTicketWorkerPermanentError || error instanceof NavigatorEffectPermanentError) {
    return { outcome: "permanent", reason: safeErrorMessage(error) };
  }
  if (error instanceof NavigatorTicketWorkerRetryableError || error instanceof NavigatorEffectTransientError) {
    return { outcome: "transient", reason: safeErrorMessage(error) };
  }
  if (error instanceof NavigatorEffectAmbiguousError) {
    return { outcome: "ambiguous", reason: safeErrorMessage(error) };
  }
  throw error;
}

function safeErrorMessage(error: Error): string {
  return error.message.replace(/[^\x20-\x7E]/gu, " ").trim().slice(0, 500) || "Navigator ticket worker failed";
}

function errorMessage(error: unknown): string {
  return safeErrorMessage(error instanceof Error ? error : new Error("Navigator ticket worker failed"));
}

async function executeWorkerRun(
  request: Readonly<{
    operation: NavigatorTicketWorkerOperation;
    input: NavigatorTicketWorkerInput;
    context: NavigatorTicketEffectContext;
    signal: AbortSignal;
    mode: "execute" | "reconcile";
  }>,
): Promise<NavigatorTicketWorkerRun | NavigatorEffectOutcome> {
  try {
    const rawRun = request.mode === "reconcile"
      ? await request.operation.reconcile(request.input, request.signal)
      : await request.operation.run(request.input, request.signal);
    const normalizedRun = normalizeWorkerRun(rawRun);
    return normalizedRun ?? {
      outcome: "permanent",
      reason: "Navigator ticket worker returned an invalid execution record",
    };
  } catch (error) {
    return workerOperationError(request.context, error, null);
  }
}

async function executeTicketOperation(
  operation: NavigatorTicketWorkerOperation,
  context: NavigatorTicketEffectContext,
  mode: "execute" | "reconcile",
): Promise<NavigatorEffectOutcome> {
  const input = workerInput(context);
  const runOutcome = await executeWorkerRun({ operation, input, context, signal: context.signal, mode });
  if ("outcome" in runOutcome) return runOutcome;
  try {
    const gitObservation = await observeWorkerGit(operation, input, runOutcome, context.signal);
    return completedTicketOutcome(context, runOutcome, gitObservation);
  } catch (error) {
    return workerOperationError(context, error, runOutcome.resource);
  }
}

export function createNavigatorTicketEffectAdapter(
  operation: NavigatorTicketWorkerOperation,
): NavigatorEffectAdapter {
  return {
    kind: "run_navigator_ticket_worker",
    execute: async (context) => context.kind === "run_navigator_ticket_worker"
      ? executeTicketOperation(operation, context, "execute")
      : { outcome: "permanent", reason: "Navigator ticket adapter received another effect kind" },
    reconcile: async (context) => context.kind === "run_navigator_ticket_worker"
      ? executeTicketOperation(operation, context, "reconcile")
      : { outcome: "permanent", reason: "Navigator ticket adapter received another effect kind" },
  };
}
