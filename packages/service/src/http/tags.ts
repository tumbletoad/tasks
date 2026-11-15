// Reading the start tags of a served page the way a browser reads them (A2 3.8.3, 3.13): the one
// reader that both the service's check of a built `index.html` (page.ts) and doctor's self-test of
// the live page use, so the two cannot read one page differently.
//
// It follows the HTML tokenizer's rules for a start tag: the tag name and the attribute names in
// any case (both are ASCII-lowercased), values double-quoted, single-quoted or unquoted, `/` before
// `>` or between attributes ignored, the first of two attributes with one name kept, a few
// character references in a value decoded, and nothing inside a comment read. It reads tags only,
// for the shell's head: no element tree, no `<script>` or `<style>` content rules, no template.
// Attribute values compare exactly, as `querySelector('meta[name="csp-nonce"]')` compares them.

/** One start tag: its lowercased name and its attributes, first one of each name kept. */
export interface StartTag {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
}

const WS = /[\t\n\f\r ]/u;
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
};

/** The character references a build or the service may write in an attribute value. */
function decode(value: string): string {
  return value.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z]+));/gu,
    (all, dec, hex, name) => {
      if (typeof name === "string") return NAMED[name] ?? all;
      const code = Number.parseInt(
        typeof dec === "string" ? dec : String(hex),
        typeof dec === "string" ? 10 : 16,
      );
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "�";
    },
  );
}

/** Every start tag of `html`, in order, outside comments. */
export function startTags(html: string): StartTag[] {
  const tags: StartTag[] = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (!/[A-Za-z]/u.test(html.charAt(lt + 1))) {
      // An end tag, a doctype, a processing instruction or a plain `<`: up to its `>`.
      if (
        html.charAt(lt + 1) === "/" ||
        html.charAt(lt + 1) === "!" ||
        html.charAt(lt + 1) === "?"
      ) {
        const end = html.indexOf(">", lt + 1);
        i = end === -1 ? n : end + 1;
      } else i = lt + 1;
      continue;
    }
    let j = lt + 1;
    let name = "";
    while (j < n && !WS.test(html.charAt(j)) && html.charAt(j) !== "/" && html.charAt(j) !== ">") {
      name += html.charAt(j);
      j += 1;
    }
    const attributes = new Map<string, string>();
    for (;;) {
      while (j < n && (WS.test(html.charAt(j)) || html.charAt(j) === "/")) j += 1;
      if (j >= n || html.charAt(j) === ">") break;
      // An attribute name: up to whitespace, `/`, `>` or `=`; a leading `=` belongs to the name.
      let attr = html.charAt(j);
      j += 1;
      while (j < n && !WS.test(html.charAt(j)) && !"/>=".includes(html.charAt(j))) {
        attr += html.charAt(j);
        j += 1;
      }
      while (j < n && WS.test(html.charAt(j))) j += 1;
      let value = "";
      if (html.charAt(j) === "=") {
        j += 1;
        while (j < n && WS.test(html.charAt(j))) j += 1;
        const quote = html.charAt(j);
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, j + 1);
          value = html.slice(j + 1, end === -1 ? n : end);
          j = end === -1 ? n : end + 1;
        } else {
          const from = j;
          while (j < n && !WS.test(html.charAt(j)) && html.charAt(j) !== ">") j += 1;
          value = html.slice(from, j);
        }
      }
      const key = attr.toLowerCase();
      if (!attributes.has(key)) attributes.set(key, decode(value));
    }
    tags.push({ name: name.toLowerCase(), attributes });
    i = j + 1;
  }
  return tags;
}

/** The start tags of one element name (lowercase), in order. */
export const tagsNamed = (html: string, name: string): StartTag[] =>
  startTags(html).filter((tag) => tag.name === name);

/**
 * The `content` of the first `<meta>` whose `name` is exactly `name`, as a browser's
 * `querySelector('meta[name="…"]').getAttribute("content")` gives it; undefined when there is none
 * or it has no `content`.
 */
export function metaContent(html: string, name: string): string | undefined {
  const tag = tagsNamed(html, "meta").find((t) => t.attributes.get("name") === name);
  return tag?.attributes.get("content");
}
