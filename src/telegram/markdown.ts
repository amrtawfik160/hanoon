// Models answer in CommonMark, but Telegram only understands its own small HTML
// subset — so unconverted "**bold**" reaches the owner as literal asterisks.
// Only closed pairs convert, which keeps a half-typed streaming draft readable.

// NUL cannot appear in a Telegram message, so a held code span can never be
// confused with surrounding text, and the marker adds no visible whitespace.
const HELD_MARKER = String.fromCharCode(0);
const SAFE_LINK = /^https?:\/\/[^\s"'<>]+$/i;

type HeldSpan = { token: string; html: string };

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Code keeps its content literal, so it is lifted out before the inline rules
// run and restored afterwards.
function holdCode(text: string, held: HeldSpan[]): string {
  const hold = (html: string): string => {
    const token = `${HELD_MARKER}${held.length}${HELD_MARKER}`;
    held.push({ token, html });
    return token;
  };
  return text
    .replace(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g, (_fence, code: string) =>
      hold(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`))
    .replace(/`([^`\n]+)`/g, (_span, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
}

function renderLinks(text: string): string {
  return text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (link, label: string, url: string) =>
    SAFE_LINK.test(url) ? `<a href="${url}">${label}</a>` : link);
}

function renderEmphasis(text: string): string {
  return text
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<b>$1</b>")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "<b>$1</b>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<s>$1</s>")
    .replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");
}

function renderBlocks(text: string): string {
  return text
    .replace(/^ {0,3}#{1,6} +(.+?)#*$/gm, "<b>$1</b>")
    .replace(/^(\s*)[-*+] +/gm, "$1• ");
}

export function telegramHtml(markdown: string): string {
  const held: HeldSpan[] = [];
  const withoutCode = holdCode(markdown, held);
  let rendered = renderBlocks(renderEmphasis(renderLinks(escapeHtml(withoutCode))));
  for (const { token, html } of held) rendered = rendered.split(token).join(html);
  return rendered;
}

const TELEGRAM_TEXT_LIMIT = 4_096;

/**
 * Escaping and tags grow the text, so an answer that fits Telegram plain can
 * overflow once rendered. Such an answer ships unformatted rather than failing.
 */
export function formattedMessage(text: string): { text: string; parse_mode?: "HTML" } {
  const rendered = telegramHtml(text);
  if (rendered === text) return { text };
  return rendered.length <= TELEGRAM_TEXT_LIMIT ? { text: rendered, parse_mode: "HTML" } : { text };
}
