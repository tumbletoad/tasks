// A folder as a list names it beside others: as few of its last parts as tell it apart from them.

const partsOf = (folder: string): string[] =>
  folder
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter((part) => part !== "");

/** A folder's label shows at most this many of its last parts, and this many characters. */
export const LABEL_PARTS = 3;
export const LABEL_CHARS = 40;

/**
 * Each folder by as few of its last parts as tell it apart from the others: its own name, which
 * names a project, and more of its path only where two folders share that name, up to
 * LABEL_PARTS parts and LABEL_CHARS characters. What it leaves out is behind "…"; the whole path
 * is the label's tip.
 */
export function folderLabels(folders: readonly string[]): Map<string, string> {
  const unique = [...new Set(folders)];
  const parts = new Map(unique.map((f) => [f, partsOf(f)]));
  const tail = (folder: string, n: number): string =>
    (parts.get(folder) ?? []).slice(-n).join("/") || folder;
  const out = new Map<string, string>();
  for (const folder of unique) {
    const own = Math.min(parts.get(folder)?.length ?? 1, LABEL_PARTS);
    let n = 1;
    while (
      n < own &&
      unique.some((other) => other !== folder && tail(other, n) === tail(folder, n))
    ) {
      n += 1;
    }
    const shown = tail(folder, n);
    const label = n > 1 && n < (parts.get(folder)?.length ?? 1) ? `…/${shown}` : shown;
    out.set(folder, label.length <= LABEL_CHARS ? label : `…${label.slice(1 - LABEL_CHARS)}`);
  }
  return out;
}
