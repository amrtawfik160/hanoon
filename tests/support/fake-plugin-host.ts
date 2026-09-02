/**
 * Every fake plugin host allocates a temp directory (`bb-fake-plugin-host-*`,
 * roughly 900KB) and only `harness.dispose()` removes it. Most suites never
 * disposed, so a run left one directory per host behind: 533,000 of them had
 * accumulated in /tmp and filled the machine's disk to 100%.
 *
 * Tests import `@get-bb/plugin-sdk/testing` through this module (see the alias in
 * vitest.config.ts), so every host is tracked here and disposed after the test
 * that made it, without 69 suites each having to remember.
 */
// A private specifier, because the public one now resolves to this file.
import * as sdkTesting from "@bb/plugin-sdk-testing-actual";

type FakePluginHost = ReturnType<typeof sdkTesting.createFakePluginHost>;
type DisposableHarness = Readonly<{ dispose(): Promise<void> }>;

const trackedHarnesses = new Set<DisposableHarness>();

export function createFakePluginHost(
  ...args: Parameters<typeof sdkTesting.createFakePluginHost>
): FakePluginHost {
  const host = sdkTesting.createFakePluginHost(...args);
  trackedHarnesses.add(host.harness as DisposableHarness);
  return host;
}

/** How many hosts are still holding a temp directory open. */
export function trackedFakePluginHostCount(): number {
  return trackedHarnesses.size;
}

/**
 * Dispose every host made since the last call. A host the test already
 * disposed is safe to dispose again: the SDK's disposer returns early.
 */
export async function disposeTrackedFakePluginHosts(): Promise<void> {
  const harnesses = [...trackedHarnesses];
  trackedHarnesses.clear();
  for (const harness of harnesses) {
    // A suite that fails mid-flight must not turn into a teardown failure that
    // hides it, and one bad host must not strand the rest.
    try {
      await harness.dispose();
    } catch {
      // The temp directory is best-effort; the test result is what matters.
    }
  }
}

export * from "@bb/plugin-sdk-testing-actual";
