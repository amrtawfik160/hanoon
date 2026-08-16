const MAX_DIFF_BYTES = 2_000_000;
const MAX_PATH_BYTES = 4_096;

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
  "\"": 0x22,
};

function gitHeaderTokens(payload: string): string[] {
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < payload.length) {
    while (/\s/u.test(payload[cursor] ?? "")) cursor += 1;
    if (cursor >= payload.length) break;
    const start = cursor;
    if (payload[cursor] === "\"") {
      cursor += 1;
      let closed = false;
      while (cursor < payload.length) {
        if (payload[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (payload[cursor] === "\"") {
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (!closed) throw new TypeError("Git diff contains an unterminated C-quoted path");
      if (cursor < payload.length && !/\s/u.test(payload[cursor] ?? "")) {
        throw new TypeError("Git diff contains an invalid quoted path boundary");
      }
    } else {
      while (cursor < payload.length && !/\s/u.test(payload[cursor] ?? "")) cursor += 1;
    }
    tokens.push(payload.slice(start, cursor));
  }
  return tokens;
}

function decodeCQuotedPath(token: string): string {
  if (!token.startsWith("\"")) {
    if (token.includes("\"") || token.length === 0) throw new TypeError("Git diff contains an invalid path token");
    return token;
  }
  if (!token.endsWith("\"") || token.length < 2) {
    throw new TypeError("Git diff contains an unterminated C-quoted path");
  }
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const inner = token.slice(1, -1);
  for (let cursor = 0; cursor < inner.length;) {
    const character = inner[cursor];
    if (character !== "\\") {
      const codePoint = inner.codePointAt(cursor);
      if (codePoint === undefined) throw new TypeError("Git diff path decoding failed");
      const decoded = String.fromCodePoint(codePoint);
      bytes.push(...encoder.encode(decoded));
      cursor += decoded.length;
      continue;
    }
    cursor += 1;
    const escaped = inner[cursor];
    if (escaped === undefined) throw new TypeError("Git diff path has a trailing escape");
    if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      cursor += 1;
      while (octal.length < 3 && cursor < inner.length && /[0-7]/u.test(inner[cursor] ?? "")) {
        octal += inner[cursor];
        cursor += 1;
      }
      const value = Number.parseInt(octal, 8);
      if (value > 0xff) throw new TypeError("Git diff path octal escape is out of range");
      bytes.push(value);
      continue;
    }
    const value = SIMPLE_ESCAPES[escaped];
    if (value === undefined) throw new TypeError("Git diff path contains an unsupported C escape");
    bytes.push(value);
    cursor += 1;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    throw new TypeError("Git diff C-quoted path is not valid UTF-8");
  }
}

function diffHeaderPathPair(payload: string): readonly [string, string] {
  if (payload.startsWith("\"")) {
    const tokens = gitHeaderTokens(payload);
    if (tokens.length !== 2) throw new TypeError("Git diff quoted header must contain exactly two paths");
    return [decodeCQuotedPath(tokens[0]), decodeCQuotedPath(tokens[1])];
  }
  if (!payload.startsWith("a/")) throw new TypeError("Git diff header is missing its a/ path");
  const candidates: Array<readonly [string, string]> = [];
  for (let cursor = payload.indexOf(" b/"); cursor >= 0; cursor = payload.indexOf(" b/", cursor + 1)) {
    const before = payload.slice(0, cursor);
    const after = payload.slice(cursor + 1);
    if (before.startsWith("a/") && after.startsWith("b/")) candidates.push([before, after]);
  }
  const equalPath = candidates.filter(([before, after]) => before.slice(2) === after.slice(2));
  if (equalPath.length === 1) return equalPath[0];
  if (equalPath.length === 0 && candidates.length === 1) return candidates[0];
  throw new TypeError("Git diff unquoted-space header is ambiguous");
}

function patchHeaderPath(payload: string): string {
  if (payload.startsWith("\"")) {
    const tokens = gitHeaderTokens(payload);
    if (tokens.length !== 1) throw new TypeError("Git patch quoted header must contain exactly one path");
    return decodeCQuotedPath(tokens[0]);
  }
  const tab = payload.indexOf("\t");
  return decodeCQuotedPath(tab < 0 ? payload : payload.slice(0, tab));
}

function normalizedRepositoryPath(rawPath: string, prefix: "a/" | "b/"): string | null {
  if (rawPath === "/dev/null") return null;
  if (!rawPath.startsWith(prefix)) throw new TypeError(`Git diff path is missing its ${prefix} prefix`);
  const path = rawPath.slice(prefix.length).replace(/\\/gu, "/");
  if (path.length === 0 || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES || path.startsWith("/") ||
    path.includes("\0") || /[\u0001-\u001f\u007f]/u.test(path) ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError("Git diff path is not a safe project-relative path");
  }
  return path;
}

export function changedPathsFromGitDiff(diff: string): string[] {
  if (typeof diff !== "string" || Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
    throw new TypeError("Git diff must be bounded text");
  }
  const paths = new Set<string>();
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      const [rawBefore, rawAfter] = diffHeaderPathPair(line.slice("diff --git ".length));
      const before = normalizedRepositoryPath(rawBefore, "a/");
      const after = normalizedRepositoryPath(rawAfter, "b/");
      if (before !== null && after !== null && before !== after) {
        // A rename is still represented by the authoritative destination path.
        paths.add(after);
      } else if (after !== null) {
        paths.add(after);
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      const path = normalizedRepositoryPath(patchHeaderPath(line.slice(4)), "a/");
      if (path !== null) paths.add(path);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = normalizedRepositoryPath(patchHeaderPath(line.slice(4)), "b/");
      if (path !== null) paths.add(path);
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}
