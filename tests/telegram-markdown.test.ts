import { describe, expect, it } from "vitest";
import { formattedMessage, renderThreadLifecycleNotice, telegramHtml } from "../src/telegram/markdown";

describe("Telegram Markdown rendering", () => {
  it("renders the bold, italic, strike, and code the model actually emits", () => {
    expect(telegramHtml("**Reduce excessive thread complexity** — active"))
      .toBe("<b>Reduce excessive thread complexity</b> — active");
    expect(telegramHtml("__also bold__")).toBe("<b>also bold</b>");
    expect(telegramHtml("a *slanted* word")).toBe("a <i>slanted</i> word");
    expect(telegramHtml("an _underscored_ word")).toBe("an <i>underscored</i> word");
    expect(telegramHtml("~~dropped~~")).toBe("<s>dropped</s>");
    expect(telegramHtml("run `npm test` now")).toBe("run <code>npm test</code> now");
  });

  it("escapes HTML so message text can never inject Telegram markup", () => {
    expect(telegramHtml("5 < 6 & 7 > 2")).toBe("5 &lt; 6 &amp; 7 &gt; 2");
    expect(telegramHtml("<b>not mine</b>")).toBe("&lt;b&gt;not mine&lt;/b&gt;");
    expect(telegramHtml("**<script>alert(1)</script>**"))
      .toBe("<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>");
  });

  it("keeps code spans and fences literal instead of formatting inside them", () => {
    expect(telegramHtml("`**not bold**`")).toBe("<code>**not bold**</code>");
    expect(telegramHtml("```ts\nconst x = a < b;\n```"))
      .toBe("<pre><code>const x = a &lt; b;</code></pre>");
    expect(telegramHtml("```\nplain\n```")).toBe("<pre><code>plain</code></pre>");
  });

  it("turns headings and list markers into something Telegram can show", () => {
    expect(telegramHtml("## Progress\ntext")).toBe("<b>Progress</b>\ntext");
    expect(telegramHtml("- first\n- second")).toBe("• first\n• second");
    expect(telegramHtml("* starred")).toBe("• starred");
    expect(telegramHtml("  - nested")).toBe("  • nested");
    expect(telegramHtml("1. numbered")).toBe("1. numbered");
  });

  it("renders links and leaves bare urls alone", () => {
    expect(telegramHtml("[the PR](https://example.com/pr/1)"))
      .toBe(`<a href="https://example.com/pr/1">the PR</a>`);
    expect(telegramHtml("see https://example.com/x")).toBe("see https://example.com/x");
    expect(telegramHtml("[bad](javascript:alert(1))")).toBe("[bad](javascript:alert(1))");
  });

  it("leaves half-typed markers literal so a streaming draft never breaks", () => {
    expect(telegramHtml("**still typing")).toBe("**still typing");
    expect(telegramHtml("a * b * c")).toBe("a * b * c");
    expect(telegramHtml("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(telegramHtml("```ts\nunclosed")).toBe("```ts\nunclosed");
  });

  it("returns plain text unchanged", () => {
    expect(telegramHtml("Hi! How can I help?")).toBe("Hi! How can I help?");
    expect(telegramHtml("")).toBe("");
  });
});

describe("Telegram message payloads", () => {
  it("asks Telegram to parse HTML only when the answer contains formatting", () => {
    expect(formattedMessage("**done** in 3 files")).toEqual({
      text: "<b>done</b> in 3 files",
      parse_mode: "HTML",
    });
    expect(formattedMessage("Hi! How can I help?")).toEqual({ text: "Hi! How can I help?" });
  });

  it("renders a finished-thread notice without interpreting the title as markup", () => {
    expect(renderThreadLifecycleNotice("Fix *this* and login_bug_now", "finished")).toEqual({
      text: "<b>Fix *this* and login_bug_now</b> finished.",
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  });

  it("ships an answer unformatted rather than overflowing Telegram's text limit", () => {
    const overflowing = `**${"<".repeat(3_900)}**`;

    expect(formattedMessage(overflowing)).toEqual({ text: overflowing });
  });
});
