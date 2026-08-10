export class ExecutorNudge {
  private pending = false;
  private waiter: (() => void) | null = null;

  public notify(): void {
    this.pending = true;
    this.waiter?.();
  }

  public wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      return Promise.reject(new TypeError("milliseconds must be non-negative"));
    }
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("executor stopped"));
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.waiter === onNudge) this.waiter = null;
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onNudge = () => {
        this.pending = false;
        finish();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal.reason ?? new Error("executor stopped"));
      };
      const timer = setTimeout(finish, milliseconds);
      this.waiter = onNudge;
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
