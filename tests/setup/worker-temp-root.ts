import { inject } from "vitest";
import { applyTempRoot } from "./temp-root";

/**
 * Worker half of the temp-root policy. Test files run in their own processes,
 * so each one points `os.tmpdir()` at the run root before any fixture asks for
 * a temp directory. Removing that one root then removes everything the run
 * created, including the `bb-fake-plugin-host-*` directories the plugin SDK's
 * fake host creates and only removes on an explicit `harness.dispose()`.
 */
applyTempRoot(inject("pluginTestTempRoot"));
