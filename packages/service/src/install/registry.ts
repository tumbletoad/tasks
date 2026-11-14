// The registry, through System32's reg.exe (A2 3.3.2). Node has no registry API, and reg.exe is
// part of every Windows, starts in milliseconds and needs no execution policy or profile.
//
// - Writes pass the name and data as arguments, which Windows hands to reg.exe as UTF-16, exactly.
// - Reads use `reg export`, which writes a UTF-16 file. `reg query` prints through the console code
//   page when its output is a pipe, so a path such as `C:\Users\Mïra` comes back altered: a status
//   would then call an entry foreign that is ours.
// - Every key must be under `HKCU\Software\`. Nothing here can touch another hive, so a mistake can
//   only ever reach this user's own software settings. The tests pass a scratch key there.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { ensurePrivateDir } from "../hub/files.ts";
import type { Runner, RunResult } from "./process.ts";

/**
 * The topmost folder of `path` that does not exist yet, in `path`'s own spelling, or undefined
 * when it exists. (mkdirSync's own answer is spelled `\\?\C:\…` on Windows, so it is not used.)
 */
function firstMissing(path: string): string | undefined {
  let missing: string | undefined;
  for (let at = path; !existsSync(at); at = dirname(at)) {
    missing = at;
    if (dirname(at) === at) break;
  }
  return missing;
}

/**
 * Removes `from` and each folder above it up to and including `top`, while each is empty. It never
 * goes above `top`: a folder outside it is not one this read created.
 */
function removeEmptyUpTo(from: string, top: string): void {
  for (let at = from; ; at = dirname(at)) {
    const inside = relative(top, at);
    if (inside.startsWith("..") || isAbsolute(inside)) return;
    try {
      rmdirSync(at);
    } catch {
      return;
    }
    if (inside === "" || dirname(at) === at) return;
  }
}

/** One value as `reg export` writes it. */
export interface RegValue {
  /** The value's name as stored ("" for the key's default value). */
  readonly name: string;
  /** `REG_SZ`, `REG_DWORD`, `REG_BINARY`, or `hex(<n>)` for the other types. */
  readonly kind: string;
  /** REG_SZ: the text. Every other type: its bytes as lowercase hex (a dword as 8 digits). */
  readonly data: string;
}

/** The values of each key in an export, by key path (`HKCU\…`, lower case) and lower-case name. */
export type RegTree = Map<string, Map<string, RegValue>>;

export class RegExportError extends Error {
  override readonly name = "RegExportError";
}

/** A key path as a lookup key: `HKEY_CURRENT_USER` shortened to `HKCU`, lower case. */
export function regKey(path: string): string {
  return path.replace(/^HKEY_CURRENT_USER(?=\\|$)/i, "HKCU").toLowerCase();
}

/**
 * Reads the text of a `reg export` file (format "Windows Registry Editor Version 5.00"): keys in
 * brackets, then `"name"=` or `@=` with a quoted string, `dword:`, `hex:` or `hex(<n>):` data,
 * hex continued on the next line after a trailing backslash. In names and strings `\\` stands for
 * a backslash and `\"` for a quote. A string may hold a raw line break.
 */
export function parseRegExport(text: string): RegTree {
  const s = text.replace(/^\uFEFF/, "");
  const tree: RegTree = new Map();
  const header = /^Windows Registry Editor Version 5\.00\r?\n/.exec(s);
  if (header === null) throw new RegExportError("Not a registry export");
  let i = header[0].length;
  let current: Map<string, RegValue> | undefined;

  const lineEnd = (from: number): number => {
    const at = s.indexOf("\n", from);
    return at === -1 ? s.length : at;
  };
  const quoted = (from: number): [string, number] => {
    let out = "";
    let j = from + 1;
    for (;;) {
      const c = s[j];
      if (c === undefined) throw new RegExportError("Unterminated string");
      if (c === '"') return [out, j + 1];
      if (c === "\\" && (s[j + 1] === "\\" || s[j + 1] === '"')) {
        out += s.charAt(j + 1);
        j += 2;
        continue;
      }
      out += c;
      j += 1;
    }
  };

  while (i < s.length) {
    const c = s[i];
    if (c === "\r" || c === "\n" || c === " " || c === "\t") {
      i += 1;
      continue;
    }
    if (c === ";") {
      i = lineEnd(i);
      continue;
    }
    if (c === "[") {
      const end = lineEnd(i);
      const line = s.slice(i, end).trimEnd();
      if (!line.endsWith("]")) throw new RegExportError("Malformed key line");
      current = new Map();
      tree.set(regKey(line.slice(1, -1)), current);
      i = end;
      continue;
    }
    if (current === undefined) throw new RegExportError("A value before any key");
    let name: string;
    if (c === "@") {
      name = "";
      i += 1;
    } else if (c === '"') {
      [name, i] = quoted(i);
    } else {
      throw new RegExportError("Malformed value line");
    }
    if (s[i] !== "=") throw new RegExportError("Missing '=' after a value name");
    i += 1;
    let value: RegValue;
    if (s[i] === '"') {
      let data: string;
      [data, i] = quoted(i);
      value = { name, kind: "REG_SZ", data };
    } else {
      // Data up to the end of the logical line: a trailing backslash continues it.
      let raw = "";
      for (;;) {
        const end = lineEnd(i);
        const line = s.slice(i, end).trim();
        i = end;
        if (line.endsWith("\\")) {
          raw += line.slice(0, -1);
          i = end + 1;
          continue;
        }
        raw += line;
        break;
      }
      const dword = /^dword:([0-9a-fA-F]{8})$/.exec(raw);
      const hex = /^(hex(?:\([0-9a-fA-F]+\))?):((?:[0-9a-fA-F]{2}(?:,[0-9a-fA-F]{2})*)?)$/.exec(
        raw,
      );
      if (dword?.[1] !== undefined) {
        value = { name, kind: "REG_DWORD", data: dword[1].toLowerCase() };
      } else if (hex?.[1] !== undefined && hex[2] !== undefined) {
        const kind = hex[1].toLowerCase() === "hex" ? "REG_BINARY" : hex[1].toLowerCase();
        value = { name, kind, data: hex[2].replaceAll(",", "").toLowerCase() };
      } else {
        throw new RegExportError("Unknown value data");
      }
    }
    current.set(name.toLowerCase(), value);
  }
  return tree;
}

/** The bytes of a REG_BINARY value's data. */
export const regBytes = (value: RegValue): Uint8Array =>
  Uint8Array.from(Buffer.from(value.data, "hex"));

/** A read's bound: every reg.exe run of it together takes at most about `timeoutMs`. */
export interface RegReadOptions {
  readonly timeoutMs?: number | undefined;
}

/** What the service install needs of the registry. Tests pass a scratch key's root to RegExe. */
export interface Registry {
  /** A key and its subkeys, or undefined when the key does not exist. */
  tree(key: string, options?: RegReadOptions): Promise<RegTree | undefined>;
  /** The values of one key (not its subkeys), or undefined when the key does not exist. */
  values(key: string, options?: RegReadOptions): Promise<Map<string, RegValue> | undefined>;
  /** Creates or replaces a REG_SZ value, creating the key and any missing key above it. */
  setString(key: string, name: string, data: string): Promise<void>;
  /** Removes one value. */
  remove(key: string, name: string): Promise<void>;
  /**
   * Removes `key` when it has no value and no subkey, and says whether it did. reg.exe has no
   * "only if empty": the key is read, then deleted, so a value another program adds between the two
   * goes with it (decision: the window).
   */
  removeEmptyKey(key: string): Promise<boolean>;
}

/** A failure of reg.exe itself: the step and the exit code, never the data. */
export class RegistryError extends Error {
  override readonly name: string = "RegistryError";
}

/** A read that did not finish within its bound. */
export class RegistryTimeoutError extends RegistryError {
  override readonly name: string = "RegistryTimeoutError";
}

/**
 * The keys from `key` upwards that do not exist, deepest first: what `setString` would create.
 * Stops at the first key that exists, and never goes above `HKCU\Software\<name>`.
 */
export async function missingKeys(
  registry: Registry,
  key: string,
  options?: RegReadOptions,
): Promise<string[]> {
  const missing: string[] = [];
  for (let at = key; ALLOWED.test(at); at = at.slice(0, at.lastIndexOf("\\"))) {
    if ((await registry.tree(at, options)) !== undefined) break;
    missing.push(at);
  }
  return missing;
}

const ALLOWED = /^HKCU\\Software\\[^\\]/i;

function checkKey(key: string): void {
  if (!ALLOWED.test(key) || key.includes("\\\\") || key.endsWith("\\")) {
    throw new RegistryError("Only keys under HKCU\\Software are used");
  }
}

/** The registry through reg.exe at `regExe`, with export files in the private folder `scratch`. */
export class RegExe implements Registry {
  readonly #reg: string;
  readonly #scratch: string;
  readonly #run: Runner;

  constructor(options: { regExe: string; scratch: string; run: Runner }) {
    this.#reg = options.regExe;
    this.#scratch = options.scratch;
    this.#run = options.run;
  }

  /**
   * One run of reg.exe within what is left of `end` (no bound when undefined). A run that cannot
   * start in time, or that runs out of it, throws RegistryTimeoutError: it never reads as a result.
   */
  async #within(args: readonly string[], end: number | undefined): Promise<RunResult> {
    if (end === undefined) return this.#run(this.#reg, args);
    const left = end - Date.now();
    if (left <= 0) throw new RegistryTimeoutError("reg.exe did not answer in time");
    const result = await this.#run(this.#reg, args, { timeoutMs: left });
    if (result.failure === "ETIMEDOUT") {
      throw new RegistryTimeoutError("reg.exe did not answer in time");
    }
    return result;
  }

  async tree(key: string, options: RegReadOptions = {}): Promise<RegTree | undefined> {
    checkKey(key);
    const end = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
    // Each read exports into a folder of its own, so reads that run at once never remove each
    // other's. That folder, and any folder above it this read created, go again afterwards when
    // empty: a preview or a status leaves nothing behind.
    const own = join(this.#scratch, `.reg-${randomBytes(8).toString("hex")}`);
    const created = firstMissing(own);
    mkdirSync(own, { recursive: true, mode: 0o700 });
    ensurePrivateDir(own);
    const file = join(own, "export.reg");
    try {
      const result = await this.#within(["export", key, file, "/y"], end);
      if (result.code !== 0) {
        // reg.exe exits 1 for a missing key and for every other failure. Only a key shown missing
        // by its parent's listing is absent; anything else fails, so a value that cannot be read
        // is never taken for one that is not there.
        if (await this.#missing(key, end)) return undefined;
        throw new RegistryError(`reg export failed (exit ${String(result.code)})`);
      }
      return parseRegExport(readFileSync(file).toString("utf16le"));
    } finally {
      rmSync(file, { force: true });
      if (created !== undefined) removeEmptyUpTo(own, created);
    }
  }

  /**
   * Whether `key` does not exist: the nearest ancestor that reg.exe can list does not list the
   * next key down. A listing that does list it, or no listable ancestor, is not "missing". The
   * listing prints key names through the console code page, so only an ASCII key is decided.
   */
  async #missing(key: string, end: number | undefined): Promise<boolean> {
    if (!/^[\x20-\x7e]+$/.test(key)) return false;
    let child = key;
    for (;;) {
      const parent = child.slice(0, child.lastIndexOf("\\"));
      if (!ALLOWED.test(`${parent}\\x`) || parent.split("\\").length < 2) return false;
      const listing = await this.#within(["query", parent], end);
      if (listing.code === 0) {
        const subkeys = listing.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /^HKEY_CURRENT_USER\\/i.test(line))
          .map(regKey);
        return !subkeys.includes(regKey(child));
      }
      child = parent;
    }
  }

  async values(key: string, options?: RegReadOptions): Promise<Map<string, RegValue> | undefined> {
    const tree = await this.tree(key, options);
    return tree === undefined ? undefined : (tree.get(regKey(key)) ?? new Map());
  }

  async removeEmptyKey(key: string): Promise<boolean> {
    checkKey(key);
    const tree = await this.tree(key);
    if (tree === undefined || tree.size !== 1 || (tree.get(regKey(key))?.size ?? 0) > 0) {
      return false;
    }
    const result = await this.#run(this.#reg, ["delete", key, "/f"]);
    if (result.code !== 0)
      throw new RegistryError(`reg delete failed (exit ${String(result.code)})`);
    return true;
  }

  async setString(key: string, name: string, data: string): Promise<void> {
    checkKey(key);
    const result = await this.#run(this.#reg, [
      "add",
      key,
      "/v",
      name,
      "/t",
      "REG_SZ",
      "/d",
      data,
      "/f",
    ]);
    if (result.code !== 0) throw new RegistryError(`reg add failed (exit ${String(result.code)})`);
  }

  async remove(key: string, name: string): Promise<void> {
    checkKey(key);
    const result = await this.#run(this.#reg, ["delete", key, "/v", name, "/f"]);
    if (result.code !== 0)
      throw new RegistryError(`reg delete failed (exit ${String(result.code)})`);
  }
}

/** A registry for platforms without one: every call fails. */
export const NO_REGISTRY: Registry = {
  tree: () => Promise.reject(new RegistryError("No registry on this platform")),
  values: () => Promise.reject(new RegistryError("No registry on this platform")),
  setString: () => Promise.reject(new RegistryError("No registry on this platform")),
  remove: () => Promise.reject(new RegistryError("No registry on this platform")),
  removeEmptyKey: () => Promise.reject(new RegistryError("No registry on this platform")),
};
