// `ttasks prefs set <key> --file <file>`: a value too rich for one argument, such as the effort
// levels with their times and lines, from a file. The file is what `ttasks prefs get <key> --json`
// printed, edited, or the value alone. The output's `as_of` goes with it as the base, so a change
// made since that read is refused rather than overwritten.
import { isAbsolute, join } from "node:path";
import { UsageError, type Globals, type VerbSpec } from "./args.ts";
import type { ConnectOptions } from "./connect.ts";
import type { Io } from "./io.ts";
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
  return { value: row["value"], ...(typeof base === "string" ? { base } : {}) };
}

/** `ttasks prefs` with `--file <file>` taken out and read first. */
export async function prefsVerb(
  io: Io,
  globals: Globals,
  verb: VerbSpec,
  args: readonly string[],
  options: ConnectOptions,
): Promise<number> {
  const end = args.indexOf("--");
  const head = end === -1 ? [...args] : args.slice(0, end);
  const at = head.findIndex((a) => a === "--file" || a.startsWith("--file="));
  if (at === -1) return runVerb(io, globals, verb, args, options);
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
    },
  });
}
