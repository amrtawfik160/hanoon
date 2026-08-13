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
 * Command-line ways of handing a credential to a program without ever writing
 * the word "password". `curl -u alice:hunter2` carries a live secret that no
 * keyword screen would see.
 */
const CLI_CREDENTIAL_FLAG = [
  /(?:^|\s)-[up](?:\s+|=)\S+/,
  /(?:^|\s)--(?:user|username|password|pass|token|api[-_]?key|apikey|auth|secret|credential)s?(?:\s+|=)\S+/i,
  /(?:^|\s)-H(?:\s+|=)['"]?\s*authorization\s*:/i,
];

/**
 * File names that are secrets by convention. Approving a write to one is not
 * something to render as an ordinary path.
 */
const SENSITIVE_PATH_NAME = [
  /^\.?env(?:\..+)?$/i,
  /^\.(?:npmrc|netrc|pgpass|htpasswd|pypirc|dockercfg)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /^(?:credentials?|secrets?|passwords?|tokens?)(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|asc|gpg|ppk)$/i,
];

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
  return containsCredentialLikeText(text) || hasUnsafeCallbackMaterial(text) ||
    CLI_CREDENTIAL_FLAG.some((pattern) => pattern.test(text));
}

/** True when a bare file name is one that conventionally holds a secret. */
export function isSensitiveApprovalPathName(basename: string): boolean {
  return SENSITIVE_PATH_NAME.some((pattern) => pattern.test(basename));
}
