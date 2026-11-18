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

/** Words people write for a key, read as the key they mean. */
export const QUERY_KEY_ALIASES: Readonly<Record<string, QueryKey>> = {
  prio: "p",
  pri: "p",
  priority: "p",
  state: "status",
  proj: "project",
  ref: "id",
  task: "id",
  modified: "updated",
  changed: "updated",
  done: "completed",
  where: "on",
  order: "sort",
};

/** A filter: its key, its operator and how many characters the two take in the word. */
export interface QueryFilter {
  readonly key: QueryKey;
  readonly op: QueryOp;
  readonly length: number;
}

/** A word that reads as a mistyped filter: the keys it is close to, and no key of its own. */
export interface MistypedFilter {
  readonly key?: undefined;
  readonly suggestions: readonly QueryKey[];
  readonly length: number;
}

const FILTER = /^([A-Za-z]+)(<=|>=|:|<|>|=)/u;
const KEYS: ReadonlySet<string> = new Set(QUERY_KEYS);

/**
 * What a word is: a filter, a mistyped filter, or (undefined) a word. A negating `-` is the
 * caller's to take off first.
 *
 * A person who types ordinary text never meets a filter error for it. A key is letters only, so
 * `10:30` is a word; a drive path (`P:\…`, `c:/…`) is a word; a link (`https://…`) is a word
 * unless its scheme is a key (`folder://server/share`); and a prefix that is no key is a word
 * (`re:`, `mailto:…`, `port:8080`) unless it is plainly a misspelt key (`stauts:open`), with a
 * value right behind it. An alias is read as its key (`prio:1` is `p:1`). `p=3` is how many other
 * tools write `p:3`, so `=` makes a filter behind a key or an alias.
 */
export function filterOf(word: string): QueryFilter | MistypedFilter | undefined {
  const found = FILTER.exec(word);
  if (found === null) return undefined;
  const written = (found[1] ?? "").toLowerCase();
  const op = found[2] ?? "";
  const length = found[0].length;
  const rest = word.slice(length);
  if (op === ":" && written.length === 1 && /^[\\/]/u.test(rest)) return undefined;
  if (KEYS.has(written)) {
    return { key: written as QueryKey, op: op === "=" ? ":" : (op as QueryOp), length };
  }
  if (op === ":" && rest.startsWith("//")) return undefined;
  const key: QueryKey | undefined =
    Object.hasOwn(QUERY_KEY_ALIASES, written) && rest !== ""
      ? QUERY_KEY_ALIASES[written]
      : undefined;
  if (key !== undefined) return { key, op: op === "=" ? ":" : (op as QueryOp), length };
  if (op === "=" || rest === "") return undefined;
  const suggestions = QUERY_KEYS.filter((k) => misspelt(written, k));
  return suggestions.length === 0 ? undefined : { suggestions, length };
}

/**
 * Whether `word` is plainly `key` mistyped: the same first letter, and an abbreviation of the key
 * or one slip from it (two for a key of six letters or more). Keys of three letters or fewer are
 * too close to everyday words to guess at.
 */
function misspelt(word: string, key: string): boolean {
  if (key.length <= 3 || word[0] !== key[0]) return false;
  if (word.length >= 3 && key.startsWith(word)) return true;
  return editDistance(word, key) <= (key.length >= 6 ? 2 : 1);
}

/** Edits between two strings, a swap of two neighbours counting as one. */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const rows: number[][] = [Array.from({ length: y.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= x.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= y.length; j += 1) {
      const above = rows[i - 1] ?? [];
      let best = Math.min(
        (above[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (above[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        best = Math.min(best, (rows[i - 2]?.[j - 2] ?? 0) + 1);
      }
      row[j] = best;
    }
    rows.push(row);
  }
  return rows[x.length]?.[y.length] ?? 0;
}
