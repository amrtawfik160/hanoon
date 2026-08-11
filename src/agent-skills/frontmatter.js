const MAX_FRONTMATTER_BYTES = 8 * 1024;
const SKILL_NAME = /^[a-z][a-z0-9-]{0,127}$/;

function frontmatterError(reason) {
  return new Error(`malformed frontmatter: ${reason}`);
}

export function skillFrontmatterName(contents) {
  if (typeof contents !== "string" || !contents.startsWith("---\n") && !contents.startsWith("---\r\n")) {
    throw frontmatterError("opening delimiter is missing");
  }
  const newline = contents.indexOf("\n");
  const closing = /\r?\n---\r?\n/.exec(contents.slice(newline + 1));
  if (!closing || closing.index + newline + 1 > MAX_FRONTMATTER_BYTES) {
    throw frontmatterError("closing delimiter is missing or too large");
  }
  const body = contents.slice(newline + 1, newline + 1 + closing.index);
  const fields = new Map();
  for (const line of body.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line)) throw frontmatterError("nested values are not supported");
    const field = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/.exec(line);
    if (!field) throw frontmatterError(`invalid field ${JSON.stringify(line)}`);
    const [, key, value = ""] = field;
    if (fields.has(key)) throw frontmatterError(`duplicate key ${key}`);
    if (/^[>|]/.test(value)) throw frontmatterError(`literal values are not supported for ${key}`);
    fields.set(key, value);
  }
  const name = fields.get("name");
  if (!name || !SKILL_NAME.test(name)) throw new Error("missing or invalid frontmatter name");
  return name;
}
