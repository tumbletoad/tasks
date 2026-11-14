// The task's Markdown (A5 3.26): untrusted text becomes React elements of a small allow-list, raw
// HTML shows as text, and a link opens only through an allowed scheme, with no opener and no
// referrer. Rendered to markup by React itself, so what is checked is what the page would draw.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Markdown } from "./markdown.tsx";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

/** Every element name in the markup. */
const tags = (markup: string) => [...markup.matchAll(/<([a-z0-9]+)[\s>/]/gu)].map((m) => m[1]);

const ALLOWED = new Set([
  "div",
  "p",
  "br",
  "strong",
  "em",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "blockquote",
  "a",
]);

/** Payloads from A5 3.26's XSS suite, as they might arrive in an email, a ticket or a note. */
const PAYLOADS = [
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  "<svg onload=alert(1)>",
  '<iframe src="https://evil.example"></iframe>',
  '<a href="javascript:alert(1)">x</a>',
  "[click](javascript:alert(1))",
  "[click](JAVASCRIPT:alert(1))",
  "[click](data:text/html,<script>alert(1)</script>)",
  "[click](vbscript:msgbox(1))",
  "[click](file:///etc/passwd)",
  "[t3](t3://thread/1)",
  "```\n<script>alert(1)</script>\n```",
  "**<b onmouseover=alert(1)>bold</b>**",
  '<style>body{display:none}</style><div style="position:fixed">x</div>',
  "‮evil‬ <scr<script>ipt>",
];

describe("[A5.3.26.web.markdown] task Markdown is elements of an allow-list, never HTML", () => {
  test("formatting: paragraphs and their line breaks, strong lines, lists, quotes, code, emphasis", () => {
    const out = html(
      "# Plan\nFirst line\nsecond line\n\n- one **bold**\n- two _em_ and `code`\n\n1. a\n2. b\n\n> quoted\n\n```\nconst x = 1;\n```",
    );
    expect(out).toContain("<p><strong>Plan</strong></p>");
    expect(out).toContain("<p>First line<br/>second line</p>");
    expect(out).toContain(
      "<ul><li>one <strong>bold</strong></li><li>two <em>em</em> and <code>code</code></li></ul>",
    );
    expect(out).toContain("<ol><li>a</li><li>b</li></ol>");
    expect(out).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(out).toContain("<pre><code>const x = 1;</code></pre>");
    expect(tags(out).every((tag) => ALLOWED.has(tag ?? ""))).toBe(true);
  });

  test("links: https, http and mailto open in a new tab with no opener; every other scheme is text", () => {
    const out = html(
      "See [the ticket](https://tickets.example/LUM-212) and https://docs.example/a/b. Mail [Ana](mailto:ana@example.com).",
    );
    expect(out).toContain(
      '<a href="https://tickets.example/LUM-212" target="_blank" rel="noopener noreferrer"',
    );
    expect(out).toContain('href="https://docs.example/a/b"');
    // The sentence's full stop is not part of a bare link.
    expect(out).toContain("https://docs.example/a/b</a>.");
    expect(out).toContain('href="mailto:ana@example.com"');
    for (const scheme of ["javascript:", "data:", "vbscript:", "file:", "t3:"]) {
      expect(html(`[x](${scheme}whatever)`)).not.toContain("<a");
    }
  });

  test.each(PAYLOADS)(
    "payload %#: nothing but allowed elements, no handler, no blocked scheme",
    (payload) => {
      const out = html(payload);
      expect(tags(out).every((tag) => ALLOWED.has(tag ?? ""))).toBe(true);
      expect(out).not.toMatch(/<[a-z]+[^>]*\son[a-z]+=/iu);
      expect(out).not.toMatch(/href="(?:javascript|data|vbscript|file|t3):/iu);
      // Escaped text holds no "<": every "<" in the markup opens a real element.
      expect(out).not.toMatch(/<[^>]*\s(?:style|src)=/iu);
      expect(out).toContain("&lt;".repeat(payload.includes("<") ? 1 : 0));
    },
  );
});
