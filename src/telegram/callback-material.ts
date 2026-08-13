const RAW_MERGE_CALLBACK = /m:[A-Za-z0-9_-]{32}/;
const ENCODED_MERGE_CALLBACK = /(?:m|%6d)%3a[A-Za-z0-9_-]{32}/i;
const MAX_ENCODING_LAYERS = 4;

function decodeCallbackEncodingLayer(value: string): string {
  return value.replace(/%(25|6d|3a)/gi, (encoded, byte: string) => {
    switch (byte.toLowerCase()) {
      case "25": return "%";
      case "6d": return "m";
      case "3a": return ":";
      default: return encoded;
    }
  });
}

/** Detect a raw or percent-encoded merge callback without interpreting unrelated percent text. */
export function containsForbiddenCallbackMaterial(value: string): boolean {
  let candidate = value;
  for (let layer = 0; layer < MAX_ENCODING_LAYERS; layer += 1) {
    if (RAW_MERGE_CALLBACK.test(candidate) || ENCODED_MERGE_CALLBACK.test(candidate)) return true;
    const decoded = decodeCallbackEncodingLayer(candidate);
    if (decoded === candidate) return false;
    candidate = decoded;
  }
  return RAW_MERGE_CALLBACK.test(candidate) || ENCODED_MERGE_CALLBACK.test(candidate);
}
