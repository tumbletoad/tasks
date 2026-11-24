// `ttasks prefs set <key> --file <file>`: a value too rich for one argument, such as the effort
// levels with their times and lines, from a file. The file is what `ttasks prefs get <key> --json`
// printed, edited, or the value alone. The output's `as_of` goes with it as the base, so a change
// made since that read is refused rather than overwritten; such a file without it is refused, as an
// edit that lost it would otherwise put back what the file held over a newer change. The value
// alone has no base on purpose: its person sets exactly that, whatever the space holds now.
import { isAbsolute, join } from "node:path";
import { patterns } from "@ttasks/contracts";
import { UsageError, type Globals, type VerbSpec } from "./args.ts";
import type { ConnectOptions } from "./connect.ts";
import type { Io } from "./io.ts";
import { movedText, prefChangeText } from "./output.ts";
import { runVerb } from "./verbs.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value for `key` and its base from the file's JSON: a get's output, or the value alone. */
function valueOf(json: unknown, key: string): { value: unknown; base?: string } {
  if (!isRecord(json)) return { value: json };
  const rows = Array.isArray(json["prefs"]) ? (json["prefs"] as unknown[]) : [];
  const row = rows.find((r) => isRecord(r) && r["key"] === key);
  if (!isRecord(row) || !Object.hasOwn(row, "value")) {
    throw new UsageError("--file holds no value of that key");
  }
  const base = json["as_of"];
  if (typeof base !== "string" || !patterns.asOf.test(base)) {
    throw new UsageError(
      "--file holds a prefs answer without its as_of: read the key again with --json and make your change there",
    );
  }
  return { value: row["value"], base };
}

type Move = { from: string; to: string | null };

/** Each `--move <size>=<level>` taken out of `args`; `<size>=` takes the size off. */
function takeMoves(args: string[]): Move[] {
  const moves: Move[] = [];
  for (let at = args.indexOf("--move"); at !== -1; at = args.indexOf("--move")) {
    const given = args.splice(at, 2)[1] ?? "";
    const cut = given.indexOf("=");
    if (cut < 1) throw new UsageError("--move takes <size>=<level>, or <size>= for no size");
    const to = given.slice(cut + 1).trim();
    moves.push({ from: given.slice(0, cut).trim(), to: to === "" ? null : to });
  }
  return moves;
}

/**
 * The answer as printed, or a dry run's: the write decided its request whole and wrote nothing
 * (WriteRequest.dry_run), so it says what the write would. What it cannot know is what changes
 * before the write. `sent` is the request's own input, so the words follow what it asked.
 */
function present(io: Io, globals: Globals, sent: () => Record<string, unknown> | undefined) {
  return (result: Record<string, unknown>, printed: string): Promise<void> => {
    if (globals.json || sent()?.["dry_run"] !== true) {
      io.stdout(printed);
      return Promise.resolve();
    }
    const changed = (result["changed"] ?? []) as { key: string; from: unknown; to: unknown }[];
    const moved = (result["moved"] ?? []) as Parameters<typeof movedText>[0][];
    io.stdout(
      [
        ...changed.map((c) => `Would set ${prefChangeText(c)}`),
        ...moved.map((m) => `Would move ${movedText(m)}.`),
        "Nothing was changed. The counts are as of now.",
      ].join("\n") + "\n",
    );
    return Promise.resolve();
  };
}

/** `ttasks prefs` with `--move` and `--file <file>` taken out, the file read first. */
export async function prefsVerb(
  io: Io,
  globals: Globals,
  verb: VerbSpec,
  args: readonly string[],
  options: ConnectOptions,
): Promise<number> {
  const end = args.indexOf("--");
  const head = end === -1 ? [...args] : args.slice(0, end);
  const moves = takeMoves(head);
  let sent: Record<string, unknown> | undefined;
  const shown = present(io, globals, () => sent);
  const withMoves = (input: Record<string, unknown>): void => {
    sent = input;
    const item = (input["set"] as Record<string, unknown>[] | undefined)?.[0];
    if (moves.length === 0) return;
    if (input["action"] !== "set" || item === undefined) {
      throw new UsageError("--move goes with set and a key");
    }
    item["moves"] = moves;
  };
  const at = head.findIndex((a) => a === "--file" || a.startsWith("--file="));
  if (at === -1) {
    const rest = [...head, ...(end === -1 ? [] : args.slice(end))];
    return runVerb(io, globals, verb, rest, options, shown, { input: withMoves });
  }
  const given = head[at] ?? "";
  const path = given.startsWith("--file=") ? given.slice("--file=".length) : head[at + 1];
  if (path === undefined || path === "") throw new UsageError("--file needs a file");
  head.splice(at, given.startsWith("--file=") ? 1 : 2);
  let text: string;
  try {
    text = await io.readFile(isAbsolute(path) ? path : join(io.cwd, path));
  } catch {
    throw new UsageError("--file cannot be read");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UsageError("--file is not JSON");
  }
  const rest = [...head, ...(end === -1 ? [] : args.slice(end))];
  return runVerb(io, globals, verb, rest, options, shown, {
    input: (input) => {
      const items = Array.isArray(input["set"]) ? (input["set"] as unknown[]) : [];
      const item = items[0];
      if (input["action"] !== "set" || items.length !== 1 || !isRecord(item)) {
        throw new UsageError("--file goes with set and one key");
      }
      if (item["value"] !== undefined || item["reset"] !== undefined) {
        throw new UsageError("--file gives the value: give no other value and no --reset");
      }
      const { value, base } = valueOf(json, String(item["key"]));
      item["value"] = value;
      if (base !== undefined && input["base"] === undefined) input["base"] = base;
      withMoves(input);
    },
  });
}
