const THREAD_WAKE_CHANGES = new Set([
  "events-appended",
  "status-changed",
  "interactions-changed",
  "thread-deleted",
  "archived-changed",
  "environment-changed",
  "terminals-changed",
]);

const ENVIRONMENT_WAKE_CHANGES = new Set([
  "git-refs-changed",
  "work-status-changed",
  "status-changed",
  "metadata-changed",
]);

export function threadChangeShouldWake(changes: readonly string[]): boolean {
  return changes.some((change) => THREAD_WAKE_CHANGES.has(change));
}

/** Interaction changes bypass sweep pacing so mirrored cards retire promptly. */
export function threadInteractionsChanged(changes: readonly string[]): boolean {
  return changes.includes("interactions-changed");
}

export function environmentChangeShouldWake(changes: readonly string[]): boolean {
  return changes.some((change) => ENVIRONMENT_WAKE_CHANGES.has(change));
}
