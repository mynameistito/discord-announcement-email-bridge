import { describe, expect, it } from "vitest";

import { renderEmailMarkdown } from "@/email-markdown";

describe("renderEmailMarkdown", () => {
  it("renders inline formatting, headings, lists, and quotes", () => {
    expect(
      renderEmailMarkdown(
        "# News\n**bold** *italic* __underlined__ ~~removed~~\n- first\n- [second](https://example.com/a?x=1&y=2)\n> quoted"
      )
    ).toBe(
      '<h1>News</h1>\n<p><strong>bold</strong> <em>italic</em> <u>underlined</u> <del>removed</del></p>\n<ul><li>first</li><li><a href="https://example.com/a?x=1&amp;y=2">second</a></li></ul>\n<blockquote><p>quoted</p></blockquote>'
    );
  });

  it("escapes raw HTML and fenced or inline code without parsing their contents", () => {
    expect(
      renderEmailMarkdown(
        "<img src=x onerror=alert(1)> `**literal**`\n```html\n<b>**literal**</b>\n```"
      )
    ).toBe(
      "<p>&lt;img src=x onerror=alert(1)&gt; <code>**literal**</code></p>\n<pre><code>&lt;b&gt;**literal**&lt;/b&gt;</code></pre>"
    );
  });

  it("rejects unsafe links and preserves unsupported spoiler and mention syntax", () => {
    expect(
      renderEmailMarkdown(
        "[bad](javascript:alert(1)) ||hidden **text**|| <@123456> [also bad](data:text/html,x)"
      )
    ).toBe(
      "<p>[bad](javascript:alert(1)) ||hidden **text**|| &lt;@123456&gt; [also bad](data:text/html,x)</p>"
    );
  });

  it("renders ordered lists and remains deterministic for empty input", () => {
    expect(renderEmailMarkdown("1. one\n2) two")).toBe(
      "<ol><li>one</li><li>two</li></ol>"
    );
    expect(renderEmailMarkdown("")).toBe("");
    expect(renderEmailMarkdown("same")).toBe(renderEmailMarkdown("same"));
  });
});
