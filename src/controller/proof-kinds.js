// The one runtime source of the proof vocabulary.
//
// It is plain JavaScript so that a single `./proof-kinds.js` specifier resolves
// everywhere: native Node ESM over the sources, the bundler that emits
// dist/server.js, and the test runner. The alternative this replaced — a dynamic
// import of `./models.ts` — survived bundling and left the built artifact
// reaching for a source file that is never emitted, so activation failed after a
// build that had reported success.
//
// Deliberately not frozen: `capability-policy` reads this vocabulary and must
// leave it exactly as `models` owns it, which is asserted from a separate
// process rather than assumed.
export const CONTROLLER_PROOF_KINDS = [
  "project_state",
  "job_state",
  "thread_state",
  "monitor_state",
  "memory_state",
  "command_result",
  "tool_result",
  "workspace_change",
  "external_mutation",
  "pipeline_outcome",
  "production_outcome",
  "obligation",
  "retrieved_content",
  "health_snapshot",
];
