// Task text as Markdown text, never markup, and front-matter values as YAML: shared by both
// projections. A Markdown viewer must run or load nothing a text says: agents write most of it,
// some from mail and tickets.

const YAML_WORDS = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n", "~"]);
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_./:@+-]*$/;
// Decimal, and YAML 1.2's hexadecimal and octal integers (`0x1f`, `0o17`).
const NUMBER_LIKE = /^([-+]?[0-9._]+([eE][-+]?[0-9]+)?|0x[0-9a-fA-F]+|0o[0-7]+)$/;
const DATE_LIKE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+Z)?$/;

/**
 * A front-matter value as YAML 1.2: an integer as it is, null as nothing, a plain word where one
 * reads back as the same string (so `rg '^status: waiting'` works), else a double-quoted string,
 * which JSON's escapes make valid YAML.
 */
export function yamlValue(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const plain =
    DATE_LIKE.test(value) ||
    (PLAIN.test(value) &&
      !YAML_WORDS.has(value.toLowerCase()) &&
      !NUMBER_LIKE.test(value) &&
      !value.includes(": ") &&
      !value.endsWith(":"));
  return plain ? value : JSON.stringify(value);
}

/**
 * One line of task text as Markdown text, never markup: a line break becomes a space; a backslash
 * that would escape the next character is escaped itself; `<` (HTML, autolinks), `[` (links,
 * images, references) and the `&` of an entity reference are escaped; and so is a block marker at
 * the line's start (a heading, a quote, a list, a rule, a fence). What CommonMark lets a backslash
 * escape renders as itself, so a viewer shows the text and runs or loads nothing.
 */
export function mdLine(text: string): string {
  return text
    .replace(/[ \t]*\n[ \t\n]*/g, " ")
    .replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\")
    .replace(/[<[]/g, "\\$&")
    .replace(/&(?=#?[0-9A-Za-z]+;)/g, "\\&")
    .replace(/^( {0,3})([#>+*=_`~-])/, "$1\\$2")
    .replace(/^( {0,3}[0-9]{1,9})([.)])/, "$1\\$2");
}

/** A heading of task text: mdLine, and a closing run of `#` escaped, which would be dropped. */
export function heading(level: number, text: string): string {
  return `${"#".repeat(level)} ${mdLine(text).replace(/(^|[ \t])(#+)([ \t]*)$/, "$1\\$2$3")}`;
}

/**
 * A text of several lines, verbatim in a fenced block: its fence is one backtick longer than the
 * longest run of backticks in the text (at least three), so no line of it closes the block, and
 * inside it nothing is markup. Each line gets `indent`, an empty one none.
 */
export function fenced(text: string, indent: string): string[] {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}text`, ...text.split("\n"), fence].map((line) =>
    line === "" ? "" : `${indent}${line}`,
  );
}

/** A section's text: one line as Markdown text, more lines fenced, nothing when it is empty. */
export function block(text: string): string {
  const trimmed = text.replace(/\s+$/u, "");
  if (trimmed === "") return "";
  return trimmed.includes("\n") ? fenced(trimmed, "").join("\n") : mdLine(trimmed);
}

/**
 * A list's item: `head` (Markdown already), then the text on the same line when it is one line,
 * else fenced under it.
 */
export function item(head: string, body: string): string {
  const text = body.replace(/\s+$/u, "");
  if (!text.includes("\n")) return `- ${head}${mdLine(text)}`;
  return [`- ${head}`.trimEnd(), ...fenced(text, "  ")].join("\n");
}

/** A section: its heading and blocks, or nothing when it has none. */
export function section(level: 2 | 3, heading: string, blocks: readonly string[]): string[] {
  const kept = blocks.filter((block) => block !== "");
  return kept.length === 0 ? [] : [`${"#".repeat(level)} ${heading}`, "", kept.join("\n"), ""];
}
