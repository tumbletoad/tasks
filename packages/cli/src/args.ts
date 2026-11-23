// The CLI's arguments (A2 3.10.2, A3 3.2.2): the global flags, then a generated verb's arguments
// from `cli-spec.json`. Argv can hold task text, so a usage error names the option or the verb,
// never a value it was given.
import { RequestId } from "@ttasks/contracts";
import spec from "@ttasks/contracts/generated/cli-spec.json" with { type: "json" };

/** A usage error (exit 2). Its message names options and verbs only. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/**
 * Whether `value` is a request ID (A3 3.4.1), from whatever source: --request-id or --input. The
 * CLI prints a request ID in its retry hint, so one that is not checked could carry any text.
 */
export const isRequestId = (value: unknown): value is string => RequestId.safeParse(value).success;
export const REQUEST_ID_RULE = "takes 16 to 64 characters from A-Z, a-z, 0-9, _ and -";

export interface Globals {
  readonly json: boolean;
  readonly space: string | undefined;
  readonly requestId: string | undefined;
  /** Seconds a call may take (A2 3.10.2: 30 by default). */
  readonly timeoutS: number;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly noColor: boolean;
  readonly help: boolean;
  /** `--input <file or ->`: the whole input as JSON. */
  readonly input: string | undefined;
}

const VALUE_GLOBALS = new Set(["--space", "--request-id", "--timeout", "--input"]);
const FLAG_GLOBALS = new Set([
  "--json",
  "-q",
  "--quiet",
  "--verbose",
  "--no-color",
  "-h",
  "--help",
]);

/** Fields an earlier build took, and the field that replaced each. */
const RENAMED: Readonly<Record<string, string>> = { place: "folder" };

/**
 * The usage error for an unknown option: it names the option when it is a plain option word, else
 * nothing of what was typed (argv can hold task text).
 */
export function unknownOption(command: string, token: string): UsageError {
  const name = token.split("=")[0] ?? "";
  const now = Object.hasOwn(RENAMED, name.replace(/^--/, ""))
    ? RENAMED[name.replace(/^--/, "")]
    : undefined;
  return new UsageError(
    now !== undefined
      ? `${command} has no option ${name}: use --${now}`
      : /^--?[A-Za-z][A-Za-z0-9-]{0,40}$/.test(name)
        ? `${command} has no option ${name}`
        : `${command} has no such option`,
  );
}

/** Takes the global flags out of `argv`, anywhere before `--`. */
export function splitGlobals(argv: readonly string[]): { globals: Globals; rest: string[] } {
  const rest: string[] = [];
  const g = {
    json: false,
    space: undefined as string | undefined,
    requestId: undefined as string | undefined,
    timeoutS: 30,
    quiet: false,
    verbose: false,
    noColor: false,
    help: false,
    input: undefined as string | undefined,
  };
  let ended = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (ended) {
      rest.push(token);
      continue;
    }
    if (token === "--") {
      ended = true;
      rest.push(token);
      continue;
    }
    const [name = "", inline] =
      token.startsWith("--") && token.includes("=")
        ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
        : [token, undefined];
    if (FLAG_GLOBALS.has(name) && inline === undefined) {
      if (name === "--json") g.json = true;
      else if (name === "-q" || name === "--quiet") g.quiet = true;
      else if (name === "--verbose") g.verbose = true;
      else if (name === "--no-color") g.noColor = true;
      else g.help = true;
      continue;
    }
    if (VALUE_GLOBALS.has(name)) {
      let value = inline;
      if (value === undefined) {
        i += 1;
        value = argv[i];
      }
      if (value === undefined) throw new UsageError(`${name} needs a value`);
      if (name === "--space") g.space = value;
      else if (name === "--request-id") {
        if (!isRequestId(value)) throw new UsageError(`--request-id ${REQUEST_ID_RULE}`);
        g.requestId = value;
      } else if (name === "--timeout") {
        const s = Number(value);
        if (!/^[0-9]{1,5}$/.test(value) || s < 1) {
          throw new UsageError("--timeout takes a whole number of seconds");
        }
        g.timeoutS = s;
      } else g.input = value;
      continue;
    }
    rest.push(token);
  }
  return { globals: g, rest };
}

// ---------------------------------------------------------------------------------------------
// Generated verbs

type ScalarType = "string" | "integer" | "number" | "boolean";

export interface FlagSpec {
  readonly field: string;
  readonly flag: string;
  readonly help: string;
  readonly repeat: boolean;
  readonly required: boolean;
  readonly type: ScalarType;
  readonly values?: readonly (string | number | boolean)[];
  readonly short?: string;
  readonly userOnly?: boolean;
}

export interface PositionalSpec {
  readonly field: string;
  /** The array field a read action puts it in instead (`ttasks prefs get <key>`). */
  readonly readInto?: string;
  /** An array field, the last positional: it takes every argument left. */
  readonly repeat?: boolean;
  readonly help: string;
  readonly name: string;
  readonly required: boolean;
  readonly type: ScalarType;
  readonly values?: readonly (string | number | boolean)[];
}

export interface KeySpec {
  readonly field: string;
  readonly help: string;
  readonly key: string;
  readonly type: ScalarType;
  readonly values?: readonly (string | number | boolean)[];
}

export interface VerbSpec {
  readonly verb: string;
  /** The flags that send the verb to this entry, when another entry has the verb too. */
  readonly when?: readonly string[];
  readonly entry: string;
  readonly kind: "read" | "write";
  readonly actors: string;
  readonly summary: string;
  readonly auto: readonly string[];
  readonly positionals: readonly PositionalSpec[];
  readonly flags: readonly FlagSpec[];
  readonly keyValue?: { readonly field: string; readonly keys: readonly KeySpec[] };
  readonly item?: string;
  readonly fixed?: Readonly<Record<string, unknown>>;
  readonly inputOnly: readonly string[];
  /** A write verb whose action field also picks reads (A3 3.2.3): those take no request ID. */
  readonly actions?: { readonly field: string; readonly reads: readonly string[] };
}

/** Whether a verb's call with `input` writes: a write verb, unless its action only reads. */
export function writes(verb: VerbSpec, input: Readonly<Record<string, unknown>>): boolean {
  if (verb.kind !== "write") return false;
  const action = verb.actions === undefined ? undefined : input[verb.actions.field];
  return !(typeof action === "string" && verb.actions?.reads.includes(action) === true);
}

export const CLI_SPEC = spec as unknown as {
  readonly verbs: readonly VerbSpec[];
  readonly exitCodes: Readonly<Record<string, number>>;
};

/** The entries whose verbs take the CLI's own `--here` and `--create` (folders.ts). */
const FOLDER_ENTRIES: ReadonlySet<string> = new Set(["task.add", "task.update", "group.manage"]);

/** Whether a verb takes `--here` and `--create`. */
export const takesFolder = (verb: Pick<VerbSpec, "entry">): boolean =>
  FOLDER_ENTRIES.has(verb.entry);

/**
 * The verb's face for these arguments: one whose `when` flag is among them (before `--`), else the
 * verb's face without `when`. Without arguments, that face.
 */
export function verbSpec(verb: string, args: readonly string[] = []): VerbSpec | undefined {
  const end = args.indexOf("--");
  const given = new Set(
    (end < 0 ? args : args.slice(0, end)).map((arg) => arg.split("=")[0] ?? ""),
  );
  const faces = verbFaces(verb);
  return (
    faces.find((v) => v.when?.some((flag) => given.has(flag)) === true) ??
    faces.find((v) => v.when === undefined)
  );
}

/** Every face of a verb: more than one when a face shares it through `when`. */
export const verbFaces = (verb: string): readonly VerbSpec[] =>
  CLI_SPEC.verbs.filter((v) => v.verb === verb);

/** The face of a shared verb whose `when` field the `--input` JSON names, else `verb` itself. */
export function faceOfInput(verb: VerbSpec, input: unknown): VerbSpec {
  if (verb.when !== undefined || typeof input !== "object" || input === null) return verb;
  const names = (face: VerbSpec) =>
    (face.when ?? []).flatMap((flag) => face.flags.find((f) => f.flag === flag)?.field ?? []);
  return (
    verbFaces(verb.verb).find((face) => names(face).some((field) => Object.hasOwn(input, field))) ??
    verb
  );
}

/** Converts one value to its field's type, or a usage error naming the option. */
function typed(
  raw: string,
  type: ScalarType,
  values: readonly (string | number | boolean)[] | undefined,
  name: string,
): string | number | boolean {
  let value: string | number | boolean = raw;
  if (type === "integer") {
    if (!/^-?[0-9]{1,15}$/.test(raw)) throw new UsageError(`${name} takes a whole number`);
    value = Number(raw);
  } else if (type === "number") {
    if (!/^-?[0-9]{1,15}(?:\.[0-9]{1,15})?$/.test(raw))
      throw new UsageError(`${name} takes a number`);
    value = Number(raw);
  } else if (type === "boolean") {
    if (raw !== "true" && raw !== "false") throw new UsageError(`${name} takes true or false`);
    value = raw === "true";
  }
  if (values !== undefined && !values.includes(value)) {
    throw new UsageError(`${name} takes one of: ${values.map(String).join(", ")}`);
  }
  return value;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Sets `value` at a spec path: `title`, `set.title` or `tasks[].title` (the item's one element).
 * `--input`'s JSON may hold anything where an argument goes: a field that is not the object or
 * list the argument needs is a usage error naming the field, never a crash.
 */
function setAt(
  input: Record<string, unknown>,
  path: string,
  value: unknown,
  repeat: boolean,
): void {
  const steps = path.split(".");
  const field = steps.map((step) => step.replace(/\[\]$/, "")).join(".");
  const wrong = (): UsageError =>
    new UsageError(`--input's ${field} has the wrong type for this argument`);
  let node: Record<string, unknown> = input;
  for (let i = 0; i < steps.length - 1; i += 1) {
    const step = steps[i] ?? "";
    if (step.endsWith("[]")) {
      const key = step.slice(0, -2);
      const list = (node[key] ??= []) as unknown;
      if (!Array.isArray(list)) throw wrong();
      if (list.length === 0) list.push({});
      const item: unknown = list[0];
      if (!isObject(item)) throw wrong();
      node = item;
    } else {
      const next = (node[step] ??= {}) as unknown;
      if (!isObject(next)) throw wrong();
      node = next;
    }
  }
  const last = steps[steps.length - 1] ?? "";
  if (repeat) {
    const list = (node[last] ??= []) as unknown;
    if (!Array.isArray(list)) throw wrong();
    list.push(value);
  } else node[last] = value;
}

/** The value at a spec path (`reason`, `set.title`, `tasks[].title`), or undefined. */
function valueAt(input: Record<string, unknown>, path: string): unknown {
  let node: unknown = input;
  for (const step of path.split(".")) {
    if (!isObject(node)) return undefined;
    node = node[step.replace(/\[\]$/, "")];
    if (step.endsWith("[]")) node = Array.isArray(node) ? node[0] : undefined;
  }
  return node;
}

export interface ParsedVerb {
  readonly input: Record<string, unknown>;
  /** Whether any argument was given besides `--input`'s JSON. */
  readonly arguments: boolean;
}

/**
 * A generated verb's input from its arguments (A3 3.2.2): positionals in order, flags, repeated
 * flags, `key=value` for the verb's object field, and its fixed values. A text value `-` reads
 * stdin (A2 3.10.2), once.
 */
export async function parseVerb(
  verb: VerbSpec,
  args: readonly string[],
  readStdin: () => Promise<string>,
  base?: Record<string, unknown>,
): Promise<ParsedVerb> {
  // `--input`'s JSON is the base; arguments set fields over it, and none is required then.
  const input: Record<string, unknown> = base === undefined ? {} : structuredClone(base);
  let stdinUsed = false;
  const text = async (raw: string, type: ScalarType): Promise<string> => {
    if (raw !== "-" || type !== "string") return raw;
    if (stdinUsed) throw new UsageError("Only one argument can read stdin");
    stdinUsed = true;
    return (await readStdin()).replace(/\r?\n$/, "");
  };
  const flags = new Map<string, FlagSpec>();
  for (const flag of verb.flags) {
    flags.set(flag.flag, flag);
    if (flag.short !== undefined) flags.set(flag.short, flag);
  }
  const keys = new Map((verb.keyValue?.keys ?? []).map((k) => [k.key, k]));
  const tokens: string[] = [];
  let any = false;
  let ended = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (!ended && token === "--") {
      ended = true;
      continue;
    }
    if (!ended && token.startsWith("-") && token !== "-") {
      const eq = token.indexOf("=");
      const name = token.startsWith("--") && eq > 0 ? token.slice(0, eq) : token;
      const flag = flags.get(name);
      if (flag === undefined) throw unknownOption(`ttasks ${verb.verb}`, token);
      let raw: string | undefined =
        token.startsWith("--") && eq > 0 ? token.slice(eq + 1) : undefined;
      if (raw === undefined) {
        if (flag.type === "boolean") raw = "true";
        else {
          i += 1;
          raw = args[i];
          if (raw === undefined) throw new UsageError(`${flag.flag} needs a value`);
        }
      }
      setAt(
        input,
        flag.field,
        typed(await text(raw, flag.type), flag.type, flag.values, flag.flag),
        flag.repeat,
      );
      any = true;
      continue;
    }
    const eq = token.indexOf("=");
    const key = eq > 0 ? keys.get(token.slice(0, eq)) : undefined;
    const old = eq > 0 ? token.slice(0, eq) : "";
    if (
      !ended &&
      key === undefined &&
      Object.hasOwn(RENAMED, old) &&
      keys.has(RENAMED[old] ?? "")
    ) {
      throw new UsageError(`ttasks ${verb.verb} has no key ${old}: use ${RENAMED[old] ?? ""}=`);
    }
    if (!ended && key !== undefined && verb.keyValue !== undefined) {
      const raw = await text(token.slice(eq + 1), key.type);
      setAt(input, key.field, typed(raw, key.type, key.values, key.key), false);
      any = true;
      continue;
    }
    tokens.push(token);
  }
  // Positionals in order. With fewer arguments than positionals, an optional one before a
  // required one is left out first: `ttasks log "text"` gives the text, and the
  // task comes from the binding. A last positional that repeats takes every argument left.
  const specs = verb.positionals;
  if (tokens.length > specs.length && specs[specs.length - 1]?.repeat !== true) {
    throw new UsageError(`ttasks ${verb.verb} takes no more arguments`);
  }
  let spare = tokens.length - specs.filter((s) => s.required).length;
  for (const spec of specs) {
    if (!spec.required && spare <= 0) continue;
    if (!spec.required) spare -= 1;
    if (spec.repeat === true && tokens.length > 0) {
      for (const token of tokens.splice(0)) {
        setAt(input, spec.field, typed(token, spec.type, undefined, `<${spec.name}>`), true);
      }
      any = true;
      continue;
    }
    const token = tokens.shift();
    if (token === undefined) {
      if (spec.required && base === undefined) {
        throw new UsageError(`ttasks ${verb.verb} needs <${spec.name}>`);
      }
      continue;
    }
    const value = typed(await text(token, spec.type), spec.type, undefined, `<${spec.name}>`);
    const action = verb.actions === undefined ? undefined : input[verb.actions.field];
    const reads = typeof action === "string" && verb.actions?.reads.includes(action) === true;
    if (reads && spec.readInto !== undefined) setAt(input, spec.readInto, value, true);
    else setAt(input, spec.field, value, false);
    any = true;
  }
  // A flag the contract requires is named before the call, as a missing <positional> is: the
  // person reads which flag, not a schema path.
  if (base === undefined) {
    for (const flag of verb.flags) {
      if (flag.required && valueAt(input, flag.field) === undefined) {
        throw new UsageError(`ttasks ${verb.verb} needs ${flag.flag}`);
      }
    }
  }
  for (const [field, value] of Object.entries(verb.fixed ?? {})) setAt(input, field, value, false);
  return { input, arguments: any };
}
