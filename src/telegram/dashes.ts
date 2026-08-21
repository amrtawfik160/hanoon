// The owner has one standing rule about everything sent to them: no em or en
// dashes, ever. The model carries the same rule in its writing skills, but a
// rule a model follows most of the time is not a rule. The wire boundary is
// where it becomes mechanical, so every path that can put text in front of
// the owner - answers, drafts, captions, callback toasts - goes through here.
//
// Held <pre> and <code> spans keep their bytes: code is quoted material, not
// Hanoon's own voice, and rewriting it would corrupt what the owner asked to
// see.

// NUL cannot appear in a Telegram message, so a held span can never collide
// with surrounding text. Same trick as the markdown renderer.
const HELD_MARKER = String.fromCharCode(0);

// Em dash, en dash, and their look-alikes: figure dash and horizontal bar.
const DASH = "[\\u2012-\\u2015]";
const NUMERIC_RANGE = new RegExp(`(\\d)[ \\t]*${DASH}[ \\t]*(?=\\d)`, "g");
const LINE_TRAILING = new RegExp(`[ \\t]*${DASH}+[ \\t]*(?=\\r?\\n|$)`, "g");
const LINE_LEADING = new RegExp(`(^|\\n)[ \\t]*${DASH}+[ \\t]*`, "g");
const CLAUSE = new RegExp(`[ \\t]*${DASH}+[ \\t]*`, "g");
const CODE_SPAN = /<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>/g;

function scrubProse(text: string): string {
  return text
    .replace(NUMERIC_RANGE, "$1-")
    .replace(LINE_TRAILING, "")
    .replace(LINE_LEADING, "$1- ")
    .replace(CLAUSE, ", ");
}

export function scrubOwnerDashes(text: string): string {
  const held: string[] = [];
  const withoutCode = text.replace(CODE_SPAN, (span) => {
    const token = `${HELD_MARKER}${held.length}${HELD_MARKER}`;
    held.push(span);
    return token;
  });
  let scrubbed = scrubProse(withoutCode);
  held.forEach((span, index) => {
    scrubbed = scrubbed.split(`${HELD_MARKER}${index}${HELD_MARKER}`).join(span);
  });
  return scrubbed;
}
