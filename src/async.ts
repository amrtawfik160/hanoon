export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class OperationDeadlineError extends Error {
  public constructor(public readonly timeoutMs: number) {
    super(`Operation did not settle within ${timeoutMs}ms`);
    this.name = "OperationDeadlineError";
  }
}

/**
 * Bounds one asynchronous round trip. The caller signal and deadline are both
 * authoritative, and a dependency that ignores cancellation cannot settle the
 * returned promise later.
 */
export function withAbortDeadline<T>(
  callerSignal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  const deadlineAbort = new AbortController();
  const signal = AbortSignal.any([callerSignal, deadlineAbort.signal]);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      deadlineAbort.abort(new OperationDeadlineError(timeoutMs));
    }, timeoutMs);
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = (): void => {
      finish(() => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let pending: Promise<T>;
    try {
      pending = operation(signal);
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    void pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
