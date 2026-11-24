// `ttasks prefs set <key> --file <file>`: a value too rich for one argument, such as the effort
// levels with their times and lines, from a file. The file is what `ttasks prefs get <key> --json`
// printed, edited, or the value alone. The output's `as_of` goes with it as the base, so a change
// made since that read is refused rather than overwritten; such a file without it is refused, as an
// edit that lost it would otherwise put back what the file held over a newer change. The value
// alone has no base on purpose: its person sets exactly that, whatever the space holds now.
import { isAbsolute, join } from "node:path";
import { checkEffortMoves, patterns, sizesHeldText, type EffortHeld } from "@ttasks/contracts";
import { UsageError, type Globals, type VerbSpec } from "./args.ts";
import type { ConnectOptions } from "./connect.ts";
import type { Io } from "./io.ts";
import { movedText, printError } from "./output.ts";
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
 * `--dry-run`: what the moves would move, from a read of the key, and nothing written. It keeps the
 * write's rules (checkEffortMoves) and exits as the write would; the count is the read's, and the
 * write counts again.
 */
async function preview(
  io: Io,
  globals: Globals,
  verb: VerbSpec,
  head: readonly string[],
  moves: readonly Move[],
  options: ConnectOptions,
): Promise<number> {
  const [action, key, value] = head;
  if (action !== "set" || key === undefined || value === undefined) {
    throw new UsageError("--dry-run goes with set, a key and its levels by name");
  }
  let read: Record<string, unknown> | undefined;
  const code = await runVerb(io, globals, verb, ["get", key], options, (result) => {
    read = (result["prefs"] as Record<string, unknown>[] | undefined)?.[0];
    return Promise.resolve();
  });
  if (code !== 0 || read === undefined) return code;
  const now = ((read["value"] ?? []) as { key: string }[]).map((level) => level.key);
  const next = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const held = (read["held"] ?? []) as EffortHeld[];
  const refused = checkEffortMoves(now, next, held, moves);
  if (refused !== undefined) {
    const said =
      refused.holders === undefined
        ? { message: `${refused.message}.` }
        : sizesHeldText(refused.holders);
    return printError(io, globals.json, { code: "invalid_input", ...said });
  }
  const lines = moves.map((move) => {
    const counts = move.to === move.from ? {} : (held.find((h) => h.effort === move.from) ?? {});
    return `Would move ${movedText({ active: 0, finished: 0, trash: 0, ...counts, ...move })}.`;
  });
  io.stdout(
    globals.json
      ? `${JSON.stringify({ would_move: lines })}\n`
      : `${lines.join("\n")} Nothing was changed.\n`,
  );
  return 0;
}

/** `ttasks prefs` with `--move`, `--dry-run` and `--file <file>` taken out, the file read first. */
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
  const dry = head.indexOf("--dry-run");
  if (dry !== -1) return preview(io, globals, verb, head.toSpliced(dry, 1), moves, options);
  const withMoves = (input: Record<string, unknown>): void => {
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
    return runVerb(io, globals, verb, rest, options, undefined, { input: withMoves });
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
  return runVerb(io, globals, verb, rest, options, undefined, {
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
