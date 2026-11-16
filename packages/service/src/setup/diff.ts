// A unified diff of one contiguous change, as setup's preview shows the instruction block's change
// to a person's file (A3 3.12). Setup changes one place in a file (the block appended, replaced or
// taken out), so one hunk with three lines of context around it is the whole diff. A carriage
// return at a line's end is not shown, and a last line without a newline is marked as diff marks it.

/** One line of a text: its words, and whether a newline ends it. */
interface Line {
  readonly text: string;
  readonly newline: boolean;
}

function linesOf(text: string): Line[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const ended = text.endsWith("\n");
  if (ended) parts.pop();
  return parts.map((part, i) => ({ text: part, newline: ended || i < parts.length - 1 }));
}

const same = (a: Line | undefined, b: Line | undefined): boolean =>
  a !== undefined && b !== undefined && a.text === b.text && a.newline === b.newline;

const CONTEXT = 3;
const NO_NEWLINE = "\\ No newline at end of file";

/** The diff from `before` to `after` of the file `name`, or "" when they are the same. */
export function unifiedDiff(name: string, before: string, after: string): string {
  if (before === after) return "";
  const a = linesOf(before);
  const b = linesOf(after);
  let head = 0;
  while (head < a.length && head < b.length && same(a[head], b[head])) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    same(a[a.length - 1 - tail], b[b.length - 1 - tail])
  ) {
    tail += 1;
  }
  const start = Math.max(0, head - CONTEXT);
  const endA = Math.min(a.length, a.length - tail + CONTEXT);
  const endB = Math.min(b.length, b.length - tail + CONTEXT);
  const range = (from: number, to: number) =>
    `${String(to - from === 0 ? from : from + 1)},${String(to - from)}`;
  const out = [`--- ${name}`, `+++ ${name}`, `@@ -${range(start, endA)} +${range(start, endB)} @@`];
  const show = (mark: string, line: Line) => {
    out.push(`${mark}${line.text.endsWith("\r") ? line.text.slice(0, -1) : line.text}`);
    if (!line.newline) out.push(NO_NEWLINE);
  };
  for (let i = start; i < head; i += 1) show(" ", a[i] as Line);
  for (let i = head; i < a.length - tail; i += 1) show("-", a[i] as Line);
  for (let i = head; i < b.length - tail; i += 1) show("+", b[i] as Line);
  for (let i = a.length - tail; i < endA; i += 1) show(" ", a[i] as Line);
  return `${out.join("\n")}\n`;
}
