import { containsCredentialLikeText } from "../domain/state-machine";
import { assertNoRawMergeCallback } from "../storage/job-persistence";

/**
 * True when a merge callback's raw material appears in the text. The assertion
 * is the authority on what that material looks like, so this reads its verdict
 * rather than restating the rule.
 */
function hasUnsafeCallbackMaterial(text: string): boolean {
  try {
    assertNoRawMergeCallback(text, "provider text");
    return false;
  } catch (error) {
    if (error instanceof TypeError) return true;
    throw error;
  }
}

/**
 * The one screen every provider-derived string passes before the plugin keeps
 * it, stores it, or shows it to the owner. It is deliberately the single
 * definition: a question prompt, an option label, a finalization segment, and an
 * approval subject all reach the same surfaces, so screening them by different
 * rules would only mean one of those rules is the weakest link.
 *
 * Fail-closed by construction — anything carrying credential or callback
 * material is unsafe, and callers downgrade rather than redact in place.
 */
export function isUnsafeProviderText(text: string): boolean {
  return containsCredentialLikeText(text) || hasUnsafeCallbackMaterial(text);
}
