// A skill file in the open Agent Skills format: `SKILL.md`, a front matter with the skill's name
// and a one-line "when to use", then the text an agent follows. Only those two keys are read; a
// file from another app's skill folder, with more keys, reads the same.
import { SKILL_NAME, SKILL_NAME_CHARS } from "@ttasks/contracts";

/** Whether a folder's name is a skill's name. */
export const isSkillName = (name: string): boolean =>
  name.length <= SKILL_NAME_CHARS && SKILL_NAME.test(name);

/** The file of a skill in its folder. */
export const SKILL_FILE = "SKILL.md";

/** The most bytes a skill file may hold. A larger one is not served at all, so nothing is cut. */
export const SKILL_BYTES = 16 * 1024;

/** The longest "when to use", as the Agent Skills format allows. */
export const DESCRIPTION_CHARS = 1024;

export type Parsed =
  | { readonly ok: true; readonly description: string | undefined; readonly body: string }
  | { readonly ok: false; readonly problem: string };

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A front matter value: quotes removed, a folded or literal block joined into one line. */
function scalar(lines: readonly string[]): string {
  const [first = "", ...rest] = lines;
  const block = /^[>|][+-]?$/u.test(first);
  const text = (block ? rest : [first, ...rest])
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return String(JSON.parse(text));
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

/** The keys of a front matter, each with its lines: indented lines continue the key above. */
function keys(lines: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines) {
    const key = /^([A-Za-z][\w-]*):(.*)$/u.exec(line);
    if (key !== null) {
      current = [key[2]?.trim() ?? ""];
      found.set(key[1] ?? "", current);
    } else if (/^\s/u.test(line)) current?.push(line);
  }
  return found;
}

/** A skill file's bytes as its "when to use" and its text, or why they cannot be used. */
export function parseSkill(bytes: Uint8Array): Parsed {
  if (bytes.byteLength > SKILL_BYTES) {
    return {
      ok: false,
      problem: `it is ${kib(bytes.byteLength)}, over the limit of ${kib(SKILL_BYTES)}`,
    };
  }
  let text: string;
  try {
    // Windows PowerShell 5 writes UTF-16 with a byte order mark when output goes to a file.
    const utf16 =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? "utf-16be"
          : undefined;
    text =
      utf16 === undefined
        ? utf8.decode(bytes)
        : new TextDecoder(utf16, { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, problem: "it is not UTF-8 text" };
  }
  if (text.includes("\0")) return { ok: false, problem: "it is not text: it holds a NUL byte" };
  if (text.trim() === "") return { ok: false, problem: "it is empty" };
  // The decoder has taken off a byte order mark.
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let description: string | undefined;
  let body = lines;
  if (lines[0]?.trimEnd() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)\s*$/u.test(line));
    if (end < 0) return { ok: false, problem: "its front matter has no closing --- line" };
    const given = keys(lines.slice(1, end)).get("description");
    description = given === undefined ? undefined : scalar(given);
    if (description === "") description = undefined;
    body = lines.slice(end + 1);
  }
  if (description !== undefined && description.length > DESCRIPTION_CHARS) {
    return {
      ok: false,
      problem: `its description is over ${String(DESCRIPTION_CHARS)} characters`,
    };
  }
  const kept = body.join("\n").trim();
  // A copy cut short, or one that kept only its front matter, would take away the whole part.
  if (kept === "") return { ok: false, problem: "it has no text after its front matter" };
  return { ok: true, description, body: kept };
}

/** A size for a person: `16 KB`. */
export const kib = (bytes: number): string => `${String(Math.ceil(bytes / 1024))} KB`;
