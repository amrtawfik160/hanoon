/**
 * The literal tuple type for the runtime vocabulary in `proof-kinds.js`. It is
 * spelled out here because a `.js` module cannot carry `as const`, and
 * `ControllerProofKind` is derived from it, so this declaration is what keeps
 * that union exact rather than widening it to `string`.
 */
export declare const CONTROLLER_PROOF_KINDS: readonly [
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
  "obligation",
  "retrieved_content",
  "health_snapshot",
];
