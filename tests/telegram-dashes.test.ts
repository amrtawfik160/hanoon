import { describe, expect, it } from "vitest";
import { scrubOwnerDashes } from "../src/telegram/dashes";

// The owner's standing rule: no em or en dashes in anything sent to them.
// The model is asked politely in its skills; this is the mechanical guarantee.
describe("scrubOwnerDashes", () => {
  it("turns an em dash clause into a comma", () => {
    expect(scrubOwnerDashes("the four docs findings are all one shape — plan and spec files"))
      .toBe("the four docs findings are all one shape, plan and spec files");
  });

  it("handles unspaced em dashes", () => {
    expect(scrubOwnerDashes("yes—but not yet")).toBe("yes, but not yet");
  });

  it("scrubs en dashes like em dashes in prose", () => {
    expect(scrubOwnerDashes("no result – so treat that silence as unknown"))
      .toBe("no result, so treat that silence as unknown");
  });

  it("keeps numeric ranges readable with a plain hyphen", () => {
    expect(scrubOwnerDashes("retry 3–5 times")).toBe("retry 3-5 times");
  });

  it("collapses a run of dashes into one comma", () => {
    expect(scrubOwnerDashes("wait —— what")).toBe("wait, what");
  });

  it("drops a dangling dash at the end of a line", () => {
    expect(scrubOwnerDashes("he trailed off —\nthen stopped")).toBe("he trailed off\nthen stopped");
  });

  it("turns a dash-led line into a plain bullet", () => {
    expect(scrubOwnerDashes("changes:\n— first\n— second")).toBe("changes:\n- first\n- second");
  });

  it("leaves quoted code untouched", () => {
    const html = 'see <code>a — b</code> and <pre><code>x —— y</code></pre> here — done';
    expect(scrubOwnerDashes(html)).toBe('see <code>a — b</code> and <pre><code>x —— y</code></pre> here, done');
  });

  it("passes dash-free text through unchanged", () => {
    const text = "plain text, with commas, and a hyphenated-word";
    expect(scrubOwnerDashes(text)).toBe(text);
  });
});
