// Markdown from a task (A5 3.26): context, notes, log entries, outcome and learnings are written by
// agents and arrive from emails, tickets and chats, so they are untrusted text. They are parsed
// here into React elements from a small subset: paragraphs with their line breaks, `#` lines as
// strong lines (no heading elements in the task), lists, quotes, fenced code, inline code,
// emphasis and links. Nothing is ever HTML: raw HTML in the text shows as the text it is, React
// escapes every string, and no string reaches `innerHTML`, so there is nothing to sanitise and
// Trusted Types are never asked. A link opens only through an allowed scheme (`https:`, `http:`,
// `mailto:`, `safeHref`), in a new tab with no opener and no referrer; any other link is its text.
import type { ReactNode } from "react";
import { safeHref } from "../row/model.ts";

/** A source or content link opens with no opener and no referrer (A5 3.26). */
export const LINK_REL = ["noopener", "noreferrer"].join(" ");

/** Inline tokens are looked for in this order at each place; the earliest match wins. */
const INLINE =
  /`([^`\n]+)`|\[([^\]\n]{1,500})\]\(([^()\s]{1,2000})\)|\*\*([^*\n]+)\*\*|(?<![\w_])__([^_\n]+)__(?![\w_])|(?<![\w*])\*([^*\n]+)\*(?!\w)|(?<![\w_])_([^_\n]+)_(?!\w)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/gu;

/** How deep emphasis may nest inside emphasis: beyond it, the rest is text. */
const MAX_DEPTH = 4;

function link(text: ReactNode, url: string, key: string): ReactNode {
  const safe = safeHref(url);
  if (safe === undefined) return text;
  return (
    <a key={key} href={safe.href} target="_blank" rel={LINK_REL} data-tip={url}>
      {text}
    </a>
  );
}

/** The inline content of one line of text. */
export function inline(text: string, key = "i", depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index;
    if (start > at) out.push(text.slice(at, start));
    const k = `${key}.${String((n += 1))}`;
    const [whole, code, label, url, bold1, bold2, em1, em2, bare] = match;
    const inner = (s: string) => (depth >= MAX_DEPTH ? [s] : inline(s, k, depth + 1));
    if (code !== undefined) out.push(<code key={k}>{code}</code>);
    else if (label !== undefined && url !== undefined) out.push(link(inner(label), url, k));
    else if (bold1 !== undefined || bold2 !== undefined)
      out.push(<strong key={k}>{inner(bold1 ?? bold2 ?? "")}</strong>);
    else if (em1 !== undefined || em2 !== undefined)
      out.push(<em key={k}>{inner(em1 ?? em2 ?? "")}</em>);
    else if (bare !== undefined) out.push(link(bare, bare, k));
    else out.push(whole);
    at = start + whole.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Lines joined with line breaks, each line's inline content. */
function lines(list: readonly string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  list.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${key}.br${String(i)}`} />);
    out.push(...inline(line, `${key}.${String(i)}`));
  });
  return out;
}

// Every block pattern has at most one unbounded quantifier that can meet another over the same
// characters, so a long run of spaces or marks parses in linear time: the text is untrusted.
const FENCE = /^\s{0,3}(```|~~~)/u;
const HEADING_START = /^\s{0,3}#{1,6}(?:\s|$)/u;
const QUOTE = /^\s{0,3}>\s?(.*)$/u;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/u;
const NUMBERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/u;
const BLANK = /^\s*$/u;

/**
 * A `#` line's text, without its marks and an optional closing run of `#` (CommonMark: the closing
 * run follows a space, so "C#" keeps its mark), or undefined when the line is no heading. Plain
 * scans, not one pattern: a lazy body between two runs of spaces backtracks without bound.
 */
/** A `#` line's level, 1 to 6. */
const levelOf = (line: string): number => /#+/u.exec(line)?.[0].length ?? 1;

function headingOf(line: string): string | undefined {
  const start = HEADING_START.exec(line);
  if (start === null) return undefined;
  const body = line.slice(start[0].length).trim();
  let end = body.length;
  while (end > 0 && body[end - 1] === "#") end -= 1;
  if (end === 0) return "";
  return end < body.length && /\s/u.test(body[end - 1] ?? "") ? body.slice(0, end).trimEnd() : body;
}

/**
 * The blocks of a Markdown text, as React elements. With `headings`, a `#` line is a heading one
 * level below the screen's own (a page's title is its h1); otherwise a strong line, as in a task.
 */
export function markdown(text: string, headings = false): ReactNode[] {
  const all = text.replace(/\r\n?/gu, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => `b${String(out.length)}`;
  while (i < all.length) {
    const line = all[i] ?? "";
    if (BLANK.test(line)) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      i += 1;
      while (i < all.length && !(all[i] ?? "").trimStart().startsWith(fence[1] ?? "```")) {
        body.push(all[i] ?? "");
        i += 1;
      }
      i += 1;
      out.push(
        <pre key={key()}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = headingOf(line);
    if (heading !== undefined) {
      const k = key();
      const level = Math.min(levelOf(line) + 1, 4);
      out.push(
        headings ? (
          level === 2 ? (
            <h2 key={k}>{inline(heading, k)}</h2>
          ) : level === 3 ? (
            <h3 key={k}>{inline(heading, k)}</h3>
          ) : (
            <h4 key={k}>{inline(heading, k)}</h4>
          )
        ) : (
          <p key={k}>
            <strong>{inline(heading, k)}</strong>
          </p>
        ),
      );
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < all.length && QUOTE.test(all[i] ?? "")) {
        body.push(QUOTE.exec(all[i] ?? "")?.[1] ?? "");
        i += 1;
      }
      const k = key();
      out.push(
        <blockquote key={k}>
          <p>{lines(body, k)}</p>
        </blockquote>,
      );
      continue;
    }
    const ordered = NUMBERED.test(line);
    if (ordered || BULLET.test(line)) {
      const marker = ordered ? NUMBERED : BULLET;
      const items: string[][] = [];
      while (i < all.length) {
        const current = all[i] ?? "";
        const item = marker.exec(current);
        if (item !== null) items.push([item[1] ?? ""]);
        else if (!BLANK.test(current) && /^\s+\S/u.test(current) && items.length > 0)
          items[items.length - 1]?.push(current.trim());
        else break;
        i += 1;
      }
      const k = key();
      const children = items.map((item, j) => (
        <li key={`${k}.${String(j)}`}>{lines(item, `${k}.${String(j)}`)}</li>
      ));
      out.push(ordered ? <ol key={k}>{children}</ol> : <ul key={k}>{children}</ul>);
      continue;
    }
    const body: string[] = [];
    while (i < all.length) {
      const current = all[i] ?? "";
      if (
        BLANK.test(current) ||
        FENCE.test(current) ||
        headingOf(current) !== undefined ||
        QUOTE.test(current) ||
        BULLET.test(current) ||
        NUMBERED.test(current)
      ) {
        break;
      }
      body.push(current);
      i += 1;
    }
    const k = key();
    out.push(<p key={k}>{lines(body, k)}</p>);
  }
  return out;
}

/** A Markdown text in a container of its own: `dir="auto"`, so each text keeps its direction. */
export function Markdown({
  text,
  className,
  headings = false,
}: {
  readonly text: string;
  readonly className?: string | undefined;
  /** A page's body: its `#` lines are headings. */
  readonly headings?: boolean;
}) {
  return (
    <div className={className} dir="auto" data-md="">
      {markdown(text, headings)}
    </div>
  );
}
