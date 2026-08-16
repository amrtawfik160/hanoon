import { isLiveWorkPollingSchedule } from "./monitor-policy";

export type ControllerToolReceipt = Readonly<{
  toolName: string;
  state: string;
  result: string | null;
}>;

export const CONTROLLER_UNWATCHED_PROMISE_RESPONSE =
  "This isn't done yet, and I haven't set a follow-up watch.";

const FOLLOW_UP_PROMISE = /\b(?:i|we)\s+will\s+(?:follow\s+up|(?:circle|report)\s+back|get\s+back(?:\s+to\s+you)?|check\s+(?:back|in)|come\s+back|(?:send\s+an?\s+|give\s+you\s+an?\s+)?update|let\s+you\s+know|keep\s+you\s+posted|keep\s+(?:checking|watching|monitoring)|(?:message|tell|notify|ping)\s+you|(?:watch|monitor)\s+(?:it|this|that|the\s+\w+)|keep\s+an?\s+eye\s+on)/i;

function normalizedPromiseText(response: string): string {
  return response
    .replace(/[’‘]/g, "'")
    .replace(/\bi'll\b/gi, "I will")
    .replace(/\bwe'll\b/gi, "we will");
}

export function hasFutureFollowUpPromise(response: string): boolean {
  return FOLLOW_UP_PROMISE.test(normalizedPromiseText(response));
}

function isDurableWatchReceipt(receipt: ControllerToolReceipt): boolean {
  if (receipt.toolName !== "telegram_agent_watch" || receipt.state !== "completed" || receipt.result === null) {
    return false;
  }
  try {
    const parsed = JSON.parse(receipt.result) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const watching = (parsed as Record<string, unknown>).watching;
    const kind = String((watching as Record<string, unknown>)?.kind);
    const instruction = (watching as Record<string, unknown>)?.instruction;
    return watching !== null && typeof watching === "object" && !Array.isArray(watching) &&
      typeof (watching as Record<string, unknown>).id === "string" &&
      (watching as Record<string, unknown>).state === "armed" &&
      (kind === "thread_idle" || (
        kind === "schedule" && typeof instruction === "string" &&
        !isLiveWorkPollingSchedule(instruction)
      ));
  } catch {
    return false;
  }
}

export function enforceControllerPromiseGate(
  response: string,
  receipts: readonly ControllerToolReceipt[],
): Readonly<{ response: string; replaced: boolean }> {
  if (!hasFutureFollowUpPromise(response) || receipts.some(isDurableWatchReceipt)) {
    return { response, replaced: false };
  }
  return { response: CONTROLLER_UNWATCHED_PROMISE_RESPONSE, replaced: true };
}
