// A paste into the top field that is more than a title: a paragraph from a mail, a ticket's text.
// Its first line goes in the field, cut at a word when it does not fit; everything after it is
// kept for the new task's context, so no word of it is lost.

export interface Pasted {
  /** The field's text with the paste's first line in it. */
  readonly text: string;
  /** Where the caret goes: after what was put in. */
  readonly caret: number;
  /** What did not go in the field, for the task's context; empty when all of it did. */
  readonly rest: string;
}

/**
 * The field after pasting `pasted` over its selection `[start, end)`, or undefined when the paste
 * is one line that fits: then the field takes it as it is.
 */
export function splitPaste(
  value: string,
  start: number,
  end: number,
  pasted: string,
  max: number,
): Pasted | undefined {
  const words = pasted.replace(/\r\n?/gu, "\n");
  const before = value.slice(0, start);
  const after = value.slice(end);
  const room = Math.max(0, max - before.length - after.length);
  const lineEnd = words.indexOf("\n");
  const first = lineEnd === -1 ? words : words.slice(0, lineEnd);
  if (lineEnd === -1 && first.length <= room) return undefined;
  let cut = first.length;
  if (cut > room) {
    // At the last space that keeps most of the room, else where the room ends.
    const space = first.lastIndexOf(" ", room);
    cut = space > room / 2 ? space : room;
  }
  const head = first.slice(0, cut).trimEnd();
  const over = first.slice(cut).trim();
  const tail = lineEnd === -1 ? "" : words.slice(lineEnd + 1).trim();
  return {
    text: `${before}${head}${after}`,
    caret: before.length + head.length,
    rest: [over, tail].filter((part) => part !== "").join("\n"),
  };
}

/** Joins what an earlier paste kept for the context with what this one keeps. */
export const joinRest = (kept: string, more: string): string =>
  [kept, more].filter((part) => part !== "").join("\n\n");
