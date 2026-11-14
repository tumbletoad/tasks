// Strict JSON for an agent app's configuration file (setup/agents.ts). The grammar is JSON.parse's,
// and a key that appears twice in one object is refused: JSON.parse keeps the last one silently,
// an app may keep the first, so setup could read another entry than the app does. Such a file is a
// state setup does not understand, and it changes nothing there.

export type StrictJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "invalid_file" | "duplicate_key" };

/** Parses `text`, refusing invalid JSON and a duplicate key in any object. */
export function parseStrictJson(text: string): StrictJson {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_file" };
  }
  return hasDuplicateKey(text) ? { ok: false, reason: "duplicate_key" } : { ok: true, value };
}

interface Frame {
  /** The keys of an object so far; undefined for an array. */
  readonly keys: Set<string> | undefined;
  /** In an object: the next string is a key. */
  expectKey: boolean;
}

/**
 * Whether valid JSON text has two equal keys in one object, compared after decoding (`"a"` and
 * `"a"` are one key). Iterative, so nesting depth costs no stack. Runs on text JSON.parse has
 * accepted, so it only needs to tell strings, brackets, colons and commas apart.
 */
function hasDuplicateKey(text: string): boolean {
  const stack: Frame[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push({ keys: undefined, expectKey: false });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") {
      const top = stack.at(-1);
      if (top?.keys !== undefined) top.expectKey = true;
    } else if (c === '"') {
      const start = i;
      for (i += 1; i < text.length; i += 1) {
        const d = text.charAt(i);
        if (d === "\\") i += 1;
        else if (d === '"') break;
      }
      const top = stack.at(-1);
      if (top?.keys !== undefined && top.expectKey) {
        const key = JSON.parse(text.slice(start, i + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
    }
  }
  return false;
}
