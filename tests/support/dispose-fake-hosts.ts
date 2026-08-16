import { afterAll } from "vitest";
import { disposeTrackedFakePluginHosts } from "./fake-plugin-host";

/**
 * Released per file rather than per test: a suite may build one host in
 * `beforeAll` and use it across every test, and disposing after the first test
 * would invalidate it under the rest. A file's hosts are freed when the file
 * ends, which is what stops them accumulating across a run.
 */
afterAll(async () => {
  await disposeTrackedFakePluginHosts();
});
