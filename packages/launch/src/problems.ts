// Typed, content-free problems with machine-local configuration, and a strict reader for
// one table of it. A problem names the key and a fixed code, never the value: machine.toml holds
// paths, account labels and commands, which no log, status line or crash file may carry.
//
// The reader takes plain values (what a TOML parser returns), so the launch's sections are checked
// here and the file itself is read by the service (packages/service/src/config).

/** Every code a configuration problem can have. A closed list: logs and doctor print these. */
export const PROBLEM_CODES = [
  /** The file cannot be read (permissions, a folder where the file belongs). */
  "unreadable",
  /**
   * Linux and macOS: the file or its folder belongs to another user or others can write it. The
   * file names commands TTasks runs, so it is not used.
   */
  "unsafe_permissions",
  /**
   * The file is larger than the bound for a configuration file, or nests tables and arrays (through
   * headers, dotted keys or inline values) deeper than the bound.
   */
  "too_large",
  /** The file is not valid UTF-8. */
  "encoding",
  /** The file is not valid TOML. The problem carries the line and column, never the text. */
  "syntax",
  /** A key this build does not know. A warning: a newer build may know it. */
  "unknown_key",
  /** A value of the wrong TOML type (a string where a table belongs, and so on). */
  "wrong_type",
  /** A value of the right type outside its allowed set or shape. */
  "invalid_value",
  /** A required key is missing. */
  "missing",
  /** A second entry with an ID, path or name that must be unique. */
  "duplicate",
  /** A path that is not absolute for this OS. */
  "not_absolute",
  /** An instance names a target that is neither built in nor a `custom:` ID. */
  "unknown_target",
  /** A template names a placeholder that does not exist. */
  "unknown_placeholder",
  /** A key that this entry's target does not take (`via_login_shell` on Windows). */
  "not_for_target",
  /** A second instance of a target that has a single instance. */
  "single_instance",
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

export type Severity = "error" | "warning";

export interface ConfigProblem {
  /**
   * The key, as a path into the file: `instance[2].exec`, `spaces[1].path`. Array
   * entries count from 1, as a person counts `[[instance]]` blocks. Empty for the whole file.
   */
  readonly key: string;
  readonly code: ProblemCode;
  readonly severity: Severity;
  /** For `syntax`: where the parser stopped, counted from 1. */
  readonly line?: number;
  readonly column?: number;
}

/** Collects problems in the order they are found. */
export class Problems {
  readonly list: ConfigProblem[] = [];

  error(key: string, code: ProblemCode): void {
    this.list.push({ key, code, severity: "error" });
  }

  warn(key: string, code: ProblemCode): void {
    this.list.push({ key, code, severity: "warning" });
  }

  add(problem: ConfigProblem): void {
    this.list.push(problem);
  }

  /** Whether any error has a key at or under `prefix`. */
  hasErrorsUnder(prefix: string): boolean {
    return this.list.some((p) => p.severity === "error" && keyUnder(p.key, prefix));
  }
}

/** Whether `key` is `prefix` itself or a key inside it. */
export function keyUnder(key: string, prefix: string): boolean {
  if (prefix === "") return true;
  if (!key.startsWith(prefix)) return false;
  const next = key.charAt(prefix.length);
  return next === "" || next === "." || next === "[";
}

/** Joins a key path the way problems spell it. */
export const keyPath = (parent: string, name: string): string =>
  parent === "" ? name : `${parent}.${name}`;

/** The key of the n-th entry (from 0) of an array, counted from 1 for a person. */
export const entryKey = (name: string, index: number): string => `${name}[${String(index + 1)}]`;

export type Plain = Record<string, unknown>;

/** A TOML table as a parser returns it: a plain object, not an array or a date. */
export function isTable(value: unknown): value is Plain {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Whether `text` holds a control character other than tab: no label, account or path may. */
export function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

/** Whether `value` is an absolute path on `platform`: a drive or UNC path on Windows. */
export function isAbsoluteFor(platform: NodeJS.Platform, value: string): boolean {
  if (value.includes("\u0000")) return false;
  if (platform === "win32") {
    return /^[A-Za-z]:[\\/]/u.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/u.test(value);
  }
  return value.startsWith("/");
}

export interface StringRule {
  readonly required?: boolean;
  /** An empty string is refused. */
  readonly nonEmpty?: boolean;
  readonly max?: number;
  readonly pattern?: RegExp;
}

/**
 * Reads one table strictly. Each getter checks one key and records a problem for it; `done()`
 * reports the keys nobody asked for as `unknown_key` warnings. `failed` says whether any error was
 * recorded for this table, so a caller can drop an entry that is not whole.
 */
export class TableReader {
  readonly #table: Plain;
  readonly #key: string;
  readonly #problems: Problems;
  readonly #seen = new Set<string>();
  #failed = false;

  constructor(table: Plain, key: string, problems: Problems) {
    this.#table = table;
    this.#key = key;
    this.#problems = problems;
  }

  get failed(): boolean {
    return this.#failed;
  }

  /** The key path of `name` in this table. */
  key(name: string): string {
    return keyPath(this.#key, name);
  }

  /** Records an error on `name` and marks the table failed. */
  error(name: string, code: ProblemCode): void {
    this.#failed = true;
    this.#problems.error(name === "" ? this.#key : this.key(name), code);
  }

  /** The raw value, marked as read. */
  raw(name: string): unknown {
    this.#seen.add(name);
    return this.#table[name];
  }

  string(name: string, rule: StringRule = {}): string | undefined {
    const value = this.raw(name);
    if (value === undefined) {
      if (rule.required === true) this.error(name, "missing");
      return undefined;
    }
    if (typeof value !== "string") {
      this.error(name, "wrong_type");
      return undefined;
    }
    if (
      hasControl(value) ||
      (rule.nonEmpty === true && value === "") ||
      (rule.max !== undefined && value.length > rule.max) ||
      (rule.pattern !== undefined && !rule.pattern.test(value))
    ) {
      this.error(name, "invalid_value");
      return undefined;
    }
    return value;
  }

  /** An absolute path on `platform`. An empty string counts as absent when `emptyIsAbsent`. */
  path(
    name: string,
    platform: NodeJS.Platform,
    rule: { required?: boolean; emptyIsAbsent?: boolean } = {},
  ): string | undefined {
    const value = this.string(name, { required: rule.required === true });
    if (value === undefined) return undefined;
    if (value === "" && rule.emptyIsAbsent === true) {
      if (rule.required === true) this.error(name, "missing");
      return undefined;
    }
    if (!isAbsoluteFor(platform, value)) {
      this.error(name, "not_absolute");
      return undefined;
    }
    return value;
  }

  bool(name: string, fallback: boolean): boolean {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
      this.error(name, "wrong_type");
      return fallback;
    }
    return value;
  }

  int(name: string, range: { min: number; max: number }): number | undefined {
    const value = this.raw(name);
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      this.error(name, "wrong_type");
      return undefined;
    }
    if (value < range.min || value > range.max) {
      this.error(name, "invalid_value");
      return undefined;
    }
    return value;
  }

  oneOf<const T extends string>(name: string, values: readonly T[], fallback: T): T;
  oneOf<const T extends string>(
    name: string,
    values: readonly T[],
    fallback?: undefined,
  ): T | undefined;
  oneOf<const T extends string>(name: string, values: readonly T[], fallback?: T): T | undefined {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    if (typeof value !== "string") {
      this.error(name, "wrong_type");
      return fallback;
    }
    if (!(values as readonly string[]).includes(value)) {
      this.error(name, "invalid_value");
      return fallback;
    }
    return value as T;
  }

  /** An array of strings, each checked by `rule`. */
  strings(name: string, rule: StringRule = {}): string[] | undefined {
    const value = this.raw(name);
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      this.error(name, "wrong_type");
      return undefined;
    }
    const out: string[] = [];
    for (const [i, item] of (value as unknown[]).entries()) {
      if (typeof item !== "string") {
        this.error(entryKey(name, i), "wrong_type");
        return undefined;
      }
      if (
        hasControl(item) ||
        (rule.nonEmpty === true && item === "") ||
        (rule.max !== undefined && item.length > rule.max) ||
        (rule.pattern !== undefined && !rule.pattern.test(item))
      ) {
        this.error(entryKey(name, i), "invalid_value");
        return undefined;
      }
      out.push(item);
    }
    return out;
  }

  /** A table of strings whose keys match `keyPattern`. */
  stringTable(name: string, keyPattern: RegExp): Record<string, string> | undefined {
    const value = this.raw(name);
    if (value === undefined) return undefined;
    if (!isTable(value)) {
      this.error(name, "wrong_type");
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!keyPattern.test(k)) {
        this.error(`${name}.${k}`, "invalid_value");
        return undefined;
      }
      if (typeof v !== "string") {
        this.error(`${name}.${k}`, "wrong_type");
        return undefined;
      }
      if (v.includes("\u0000")) {
        this.error(`${name}.${k}`, "invalid_value");
        return undefined;
      }
      out[k] = v;
    }
    return out;
  }

  /** Reports every key no getter read as an `unknown_key` warning. */
  done(): void {
    for (const name of Object.keys(this.#table)) {
      if (!this.#seen.has(name)) this.#problems.warn(this.key(name), "unknown_key");
    }
  }
}
