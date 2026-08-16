import { containsCredentialLikeText } from "../domain/state-machine";
import { assertNoRawMergeCallback } from "../storage/job-persistence";

const INTERNAL_CALLBACK_MATERIAL = /(?:m|a|o|q|i|w):[A-Za-z0-9_-]{32}/u;

/**
 * True when a merge callback's raw material appears in the text. The assertion
 * is the authority on what that material looks like, so this reads its verdict
 * rather than restating the rule.
 */
function hasUnsafeCallbackMaterial(text: string): boolean {
  if (INTERNAL_CALLBACK_MATERIAL.test(text)) return true;
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
  // Basic and proxy auth pass a `user:secret` pair, attached (`-ualice:pw`),
  // joined (`-u=alice:pw`), or separated (`-u alice:pw`). Requiring the pair is
  // what keeps `sort -u names.txt` and `docker run -u 1000` readable: those are
  // the same letter doing an unrelated job.
  /(?:^|\s)-[uU](?:\s+|=)?[^\s:=-][^\s:]*:\S+/,
  // The password flag's secret is written straight onto it (`mysql -phunter2`)
  // or joined to it (`-p=hunter2`). A separated value is left alone, so
  // `docker run -p 8080:8080` stays readable and `mysql -p -h db` is not
  // mistaken for one.
  /(?:^|\s)-p(?:=\S+|[^\s=-]\S*)/,
  // The long form stays delimiter-bound and the option names are exact. A
  // generic prefix allowance would read `--no-user` and `--fake-password` as
  // credentials, so the proxy spellings are listed rather than inferred.
  /(?:^|\s)--(?:proxy-user|proxy-password|proxy-auth|user|username|password|pass|token|api[-_]?key|apikey|auth|secret|credential)s?(?:\s+|=)\S+/i,
  /(?:^|\s)-H(?:\s+|=)['"]?\s*authorization\s*:/i,
];

/**
 * A URI carrying its own credentials. Any scheme counts: a database, broker, or
 * object-store URI hands over a live password exactly as an https one does.
 */
const CREDENTIAL_URI = /[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@/i;

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
/** How many nested percent-encodings are unwrapped before giving up. */
const MAX_DECODE_DEPTH = 4;

/**
 * Quotes and backslash escapes hide a flag from any rule that anchors on
 * whitespace: `curl '-Uproxy:pw'` is the same command as `curl -Uproxy:pw`, and
 * `'-U''proxy:pw'` is too. Removing the quoting characters is deliberately
 * cruder than parsing a shell — it can only ever join tokens that were already
 * adjacent, which is the direction that fails closed.
 */
function unquoted(text: string): string {
  return text.replace(/[\\'"`\u2018\u2019\u201C\u201D]/g, "");
}

/**
 * Each successful percent-decoding of a view, up to the depth cap, and whether
 * the cap ran out with readable encoding still left. Exhaustion is not evidence
 * of safety: whatever was not unwrapped could be anything, so the caller treats
 * it as unsafe rather than as clean.
 */
function decodedViews(text: string): { views: string[]; exhausted: boolean } {
  const views: string[] = [];
  let current = text;
  for (let depth = 0; depth < MAX_DECODE_DEPTH; depth += 1) {
    if (!decodesFurther(current)) return { views, exhausted: false };
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      // Reached only with a well-formed escape in hand, so the failure is a
      // layer that refused to decode rather than absent encoding, and an unread
      // layer could be anything.
      return { views, exhausted: true };
    }
    if (next === current) return { views, exhausted: false };
    current = next;
    views.push(current);
  }
  return { views, exhausted: decodesFurther(current) };
}

/**
 * True when another well-formed percent-escape is still waiting to be read.
 * Its mere presence is enough: requiring the whole string to decode would let a
 * stray percent elsewhere in the text vouch for the escape that was not read.
 */
function decodesFurther(text: string): boolean {
  return /%[0-9A-Fa-f]{2}/.test(text);
}

/**
 * Bash's ANSI-C and localized quoting carry their own escape language, so the
 * bytes inside bear no relation to what a screen reading the text can see.
 * Rather than reimplement shell escaping, the construct itself is unreadable:
 * `curl $'\x2d\x55proxy:pw'` is refused because of the `$'`, not because of
 * anything recovered from inside it.
 */
const SHELL_ESCAPE_CONSTRUCT = /\$['"]/;

/**
 * The readings of one string that a screen has to consider. A secret hidden by
 * quoting, escaping, or encoding is still a secret, so the rules are applied to
 * each reading rather than to the raw text alone.
 *
 * The two transforms compose in both directions on purpose: quoting can hide an
 * encoding and an encoding can hide the quoting, so `%27-Uproxy:pw%27` decodes
 * into a quoted flag that has to be dequoted afterwards to be seen at all.
 * Every decoded view is therefore screened dequoted as well.
 */
function credentialViews(text: string): {
  views: string[];
  exhausted: boolean;
  shellEscaped: boolean;
} {
  const views = new Set<string>();
  let exhausted = false;
  // A shell-escape construct is only visible before its quotes are removed, and
  // an encoded one only after decoding, so every reading is checked at the point
  // it still has its quoting: `%24%27-Uproxy:pw%27` decodes into `$'…'` and must
  // be caught there rather than after dequoting flattens it.
  let shellEscaped = SHELL_ESCAPE_CONSTRUCT.test(text);
  for (const base of [text, unquoted(text)]) {
    views.add(base);
    const decoded = decodedViews(base);
    exhausted = exhausted || decoded.exhausted;
    for (const view of decoded.views) {
      shellEscaped = shellEscaped || SHELL_ESCAPE_CONSTRUCT.test(view);
      views.add(view);
      views.add(unquoted(view));
    }
  }
  return { views: [...views], exhausted, shellEscaped };
}

export function isUnsafeProviderText(text: string): boolean {
  const { views, exhausted, shellEscaped } = credentialViews(text);
  if (shellEscaped || exhausted) return true;
  return views.some((view) => (
    containsCredentialLikeText(view) || hasUnsafeCallbackMaterial(view) ||
    CLI_CREDENTIAL_FLAG.some((pattern) => pattern.test(view)) ||
    CREDENTIAL_URI.test(view)
  ));
}

/** True when a bare file name is one that conventionally holds a secret. */
export function isSensitiveApprovalPathName(basename: string): boolean {
  return SENSITIVE_PATH_NAME.some((pattern) => pattern.test(basename));
}
