export type MemoryCurationDependencies = {
  clock: { now(): number };
};

export class MemoryCurationService {
  public constructor(_dependencies: MemoryCurationDependencies) {}

  public processDue(): boolean {
    return false;
  }
}
