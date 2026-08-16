import {
  discoverExternalInventory,
  type ExternalInventoryReadClient,
} from "../capabilities/inventory";
import type { TelegramAgentStore } from "../storage/store";

export const CAPABILITY_INVENTORY_REFRESH_MS = 15 * 60_000;
export const CAPABILITY_INVENTORY_READ_TIMEOUT_MS = 15_000;

type InventoryStore = Pick<
  TelegramAgentStore,
  | "listEnabledProjectPolicies"
  | "listExternalCapabilityInventory"
  | "replaceExternalCapabilityInventory"
  | "recordExternalInventoryDiscoveryFailure"
>;

export type CapabilityInventoryServiceDependencies = Readonly<{
  store: InventoryStore;
  client: ExternalInventoryReadClient;
  clock: { now(): number };
  warn?: (message: string) => void;
  refreshIntervalMs?: number;
  readTimeoutMs?: number;
}>;

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Refreshes read-only discovery evidence. It cannot install, enable, update,
 * remove, call a plugin RPC, or obtain credentials because those surfaces are
 * absent from its dependency contract.
 */
export class CapabilityInventoryService {
  private lastAttemptAt: number | null = null;

  public constructor(private readonly dependencies: CapabilityInventoryServiceDependencies) {}

  public async refresh(parentSignal?: AbortSignal): Promise<boolean> {
    const now = this.dependencies.clock.now();
    this.lastAttemptAt = now;
    const policy = [...this.dependencies.store.listEnabledProjectPolicies()]
      .sort((left, right) => left.policy.projectId.localeCompare(right.policy.projectId))[0]?.policy;
    if (!policy) {
      this.dependencies.store.recordExternalInventoryDiscoveryFailure({
        hostScope: "primary",
        errorClass: "workspace_unavailable",
        now,
      });
      return false;
    }
    const hostScope = `project:${policy.projectId}`;
    const previous = this.dependencies.store.listExternalCapabilityInventory(hostScope, 512);
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(
      this.dependencies.readTimeoutMs ?? CAPABILITY_INVENTORY_READ_TIMEOUT_MS,
      60_000,
    ));
    const timeout = setTimeout(
      () => controller.abort(new Error("inventory discovery timeout")),
      timeoutMs,
    );
    const cancel = (): void => controller.abort(parentSignal?.reason ?? new Error("inventory discovery cancelled"));
    if (parentSignal?.aborted) cancel();
    else parentSignal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await discoverExternalInventory({
        client: this.dependencies.client,
        workspace: { projectId: policy.projectId, environmentId: null },
        hostScope,
        previousSnapshot: previous,
        now,
        signal: controller.signal,
      });
      if (result.health.status === "degraded") {
        this.dependencies.store.recordExternalInventoryDiscoveryFailure({
          hostScope,
          errorClass: result.health.errorClass ?? "read_failed",
          now,
        });
        this.dependencies.warn?.(`Capability inventory refresh for ${policy.projectId} is degraded`);
        return false;
      }
      this.dependencies.store.replaceExternalCapabilityInventory({ hostScope, items: result.items, now });
      return true;
    } catch {
      this.dependencies.store.recordExternalInventoryDiscoveryFailure({
        hostScope,
        errorClass: "normalization_failed",
        now,
      });
      this.dependencies.warn?.(`Capability inventory refresh for ${policy.projectId} could not be normalized`);
      return false;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", cancel);
    }
  }

  public async run(signal: AbortSignal): Promise<void> {
    const interval = Math.max(60_000, Math.min(
      this.dependencies.refreshIntervalMs ?? CAPABILITY_INVENTORY_REFRESH_MS,
      24 * 60 * 60_000,
    ));
    while (!signal.aborted) {
      const elapsed = this.lastAttemptAt === null ? interval : this.dependencies.clock.now() - this.lastAttemptAt;
      await abortableDelay(Math.max(0, interval - elapsed), signal);
      if (signal.aborted) return;
      await this.refresh(signal);
    }
  }
}
