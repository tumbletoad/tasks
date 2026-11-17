// Which word of a search query is a filter: one reading for the service that runs the query and
// the page that decides what to offer around it. No dependencies, so the page can import it.

/** The query language's filter keys. */
export const QUERY_KEYS = [
  "status",
  "area",
  "project",
  "p",
  "effort",
  "due",
  "is",
  "has",
  "source",
  "by",
  "created",
  "updated",
  "completed",
  "on",
  "folder",
  "id",
  "sort",
] as const;
export type QueryKey = (typeof QUERY_KEYS)[number];

export type QueryOp = ":" | "<" | "<=" | ">" | ">=";

const FILTER = /^([A-Za-z]+)(<=|>=|:|<|>|=)/u;

/**
 * The filter a word starts with: its key in lower case, its operator and how many characters the
 * two take. A key is letters only, so `10:30` stays a word. `p=3` is how many other tools write
 * `p:3`, so `=` makes a filter behind a known key and is text behind any other word, as in `x=1`.
 * A negating `-` is the caller's to take off first.
 */
export function filterOf(word: string): { key: string; op: QueryOp; length: number } | undefined {
  const found = FILTER.exec(word);
  if (found === null) return undefined;
  const key = (found[1] ?? "").toLowerCase();
  const op = found[2] ?? "";
  if (op === "=") {
    return (QUERY_KEYS as readonly string[]).includes(key)
      ? { key, op: ":", length: found[0].length }
      : undefined;
  }
  return { key, op: op as QueryOp, length: found[0].length };
}
