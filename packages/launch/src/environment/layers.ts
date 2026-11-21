// The layers of the agent's environment (A4 3.8), as pure functions over what the helpers wrote:
// - Linux and macOS: the session (`systemctl --user show-environment`, a fixed list of names) and
//   the login-shell snapshot (`$SHELL -lic` printing `env -0` between two random markers);
// - Windows: the user and system environment from the registry, REG_EXPAND_SZ expanded.
// What row E01 of the M0 lab measured (A7 3.7): the Linux snapshot from a transient user
// unit took 736 ms and found every tool a hand-opened shell found (nvm's `node` and `codex`
// included, which the unit's own environment missed); the Windows registry layers took 36 to
// 47 ms and found what a fresh `pwsh` found.
import { randomBytes } from "node:crypto";
import { envVar } from "@ttasks/brand";
import { TERMINAL_ENV } from "../shim/wire.ts";
import { base64Text, REGISTRY_READS } from "../windows-reads.ts";

type Env = Record<string, string>;

/** Set while the snapshot's shell runs, so a profile can tell (A4 3.8). Never reaches an agent. */
export const RESOLVING = envVar("RESOLVING_ENVIRONMENT");

/**
 * The session variables layer 1 takes (A4 3.8): the display, the bus, XDG's session variables, the
 * X authority, the SSH agent and the person's chosen terminal.
 */
export const SESSION_NAMES =
  /^(DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_[A-Z0-9_]+|XAUTHORITY|SSH_AUTH_SOCK|TERMINAL)$/;

/**
 * What the snapshot's shell had only because it was the snapshot's shell: the TERM it was given,
 * its working folder, its depth, its last command, the marker variable, and a terminal's own
 * variables (the shim's terminal sets those, wire.ts TERMINAL_ENV). Left out of the snapshot.
 */
export const SNAPSHOT_DROPPED: readonly string[] = [
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  RESOLVING,
  ...TERMINAL_ENV,
];

/** A random marker for one snapshot: hex, so no shell reads anything into it. */
export const newMarker = (): string => randomBytes(12).toString("hex");

/**
 * The fixed command string of the snapshot. Only the marker varies, and it is hex. `printf '\0'`
 * writes a NUL in bash, zsh and dash; `env -0` ends each entry with one.
 */
export function snapshotScript(marker: string): string {
  if (!/^[0-9a-f]{8,64}$/.test(marker)) throw new Error("Not a marker");
  return `printf '\\0%s\\0' ${marker}; env -0; printf '\\0%s\\0' ${marker}`;
}

/** The fence around the snapshot: NUL, the marker, NUL. */
const fence = (marker: string): Buffer => Buffer.from(`\0${marker}\0`);

/** Whether both fences have arrived: the snapshot is complete. */
export function snapshotComplete(output: Buffer, marker: string): boolean {
  const f = fence(marker);
  const start = output.indexOf(f);
  return start !== -1 && output.indexOf(f, start + f.length) !== -1;
}

/**
 * The environment between the two fences, or undefined when they are not both there. Whatever a
 * profile prints before or after them does not matter. An entry that is not `NAME=value` with a
 * name an environment can carry is left out, and so is invalid UTF-8 (U+FFFD would stand for
 * other bytes).
 */
export function parseSnapshot(output: Buffer, marker: string): Env | undefined {
  const f = fence(marker);
  const start = output.indexOf(f);
  if (start === -1) return undefined;
  const end = output.indexOf(f, start + f.length);
  if (end === -1) return undefined;
  const env: Env = {};
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const raw of splitNul(output.subarray(start + f.length, end))) {
    let entry: string;
    try {
      entry = decoder.decode(raw);
    } catch {
      continue;
    }
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (SNAPSHOT_DROPPED.includes(name)) continue;
    env[name] = entry.slice(eq + 1);
  }
  return env;
}

function splitNul(bytes: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let from = 0;
  for (;;) {
    const at = bytes.indexOf(0, from);
    if (at === -1) {
      if (from < bytes.length) out.push(bytes.subarray(from));
      return out;
    }
    if (at > from) out.push(bytes.subarray(from, at));
    from = at + 1;
  }
}

/**
 * `systemctl --user show-environment`, one `NAME=value` per line, filtered to SESSION_NAMES. A
 * value with special characters comes as `$'…'` with C escapes, which are decoded; anything that
 * cannot be decoded exactly is left out.
 */
export function parseSessionEnvironment(text: string): Env {
  const env: Env = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq);
    if (!SESSION_NAMES.test(name)) continue;
    const raw = line.slice(eq + 1);
    const value = raw.startsWith("$'") ? unquoteAnsiC(raw) : raw;
    if (value !== undefined && !value.includes("\0")) env[name] = value;
  }
  return env;
}

const SIMPLE: Readonly<Record<string, string>> = {
  a: "\u0007",
  b: "\b",
  e: "\u001b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

/** `$'…'` as systemd writes it (C escapes), or undefined when it is not exactly that. */
export function unquoteAnsiC(quoted: string): string | undefined {
  if (!quoted.startsWith("$'") || !quoted.endsWith("'") || quoted.length < 3) return undefined;
  const body = quoted.slice(2, -1);
  const bytes: number[] = [];
  const push = (text: string): void => {
    bytes.push(...Buffer.from(text, "utf8"));
  };
  for (let i = 0; i < body.length; i += 1) {
    // A whole code point: a character outside the BMP is two UTF-16 units, never two halves.
    const c = String.fromCodePoint(body.codePointAt(i) ?? 0);
    if (c === "'") return undefined; // an unescaped quote inside
    if (c !== "\\") {
      push(c);
      i += c.length - 1;
      continue;
    }
    const next = body.charAt(i + 1);
    if (next === "") return undefined;
    const simple = SIMPLE[next];
    if (simple !== undefined) {
      push(simple);
      i += 1;
      continue;
    }
    const hex = /^x([0-9a-fA-F]{1,2})/.exec(body.slice(i + 1));
    if (hex?.[1] !== undefined) {
      bytes.push(parseInt(hex[1], 16));
      i += hex[0].length;
      continue;
    }
    const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1));
    if (oct !== null) {
      const value = parseInt(oct[0], 8);
      if (value > 255) return undefined;
      bytes.push(value);
      i += oct[0].length;
      continue;
    }
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
}

/**
 * A4 3.8's merge of layers 1 and 2: session variables beat the snapshot, which may be from an
 * earlier login, except `SSH_AUTH_SOCK`: the snapshot's wins when that socket exists (a profile
 * that starts its own agent), else the session's, else none.
 */
export function mergeLayers(
  session: Readonly<Env>,
  snapshot: Readonly<Env>,
  isSocket: (path: string) => boolean,
): Env {
  const merged: Env = { ...snapshot };
  for (const [name, value] of Object.entries(session)) {
    if (name !== "SSH_AUTH_SOCK") merged[name] = value;
  }
  const fromSnapshot = snapshot["SSH_AUTH_SOCK"];
  const fromSession = session["SSH_AUTH_SOCK"];
  if (fromSnapshot !== undefined && fromSnapshot !== "" && isSocket(fromSnapshot)) {
    merged["SSH_AUTH_SOCK"] = fromSnapshot;
  } else if (fromSession !== undefined && fromSession !== "") {
    merged["SSH_AUTH_SOCK"] = fromSession;
  } else delete merged["SSH_AUTH_SOCK"];
  return merged;
}

// ---------------------------------------------------------------------------------------------
// Windows: the registry layers

/** One registry value as the reader returns it: its kind and its text, unexpanded. */
export interface RegistryValue {
  readonly kind: "String" | "ExpandString";
  readonly value: string;
}

/** Expands `%NAME%` against `env`, names without case; an unknown name stays as written. */
export function expandWindows(value: string, env: Readonly<Env>): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(/%([^%]+)%/g, (all, name: string) => lower.get(name.toLowerCase()) ?? all);
}

/**
 * The variables Windows derives rather than storing under Environment, by the step of the logon
 * that sets them (below). They come from the base (the service's own environment, which Windows
 * built at the logon). The machine's: before the system's values, which may replace them (the
 * processor and OS names are usually among those values too).
 */
export const CORE_SYSTEM_NAMES = [
  "ALLUSERSPROFILE",
  "ProgramData",
  "PUBLIC",
  "SystemDrive",
  "SystemRoot",
  "windir",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
] as const;

/** The account's profile and the program folders: after the system's values, before the user's. */
export const CORE_USER_NAMES = [
  // eslint-disable-next-line no-restricted-syntax -- a variable Windows sets for the account, not a path TTasks writes
  "APPDATA",
  "COMPUTERNAME",
  // eslint-disable-next-line no-restricted-syntax -- a variable Windows sets for the account, not a path TTasks writes
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "USERPROFILE",
] as const;

/**
 * The account's logon names: after the user's own environment, so a registry value of the same
 * name never replaces them.
 */
export const ACCOUNT_NAMES = [
  "USERDNSDOMAIN",
  "USERDOMAIN",
  "USERNAME",
  "USERDOMAIN_ROAMINGPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
] as const;

/**
 * A4 3.8's Windows layers, in the order Windows builds a logon's environment (The Old New Thing,
 * 2023-12-12, "What order does Windows use…"): the machine's derived names, the system's `REG_SZ`
 * values, the system's `REG_EXPAND_SZ` values, the account's profile names, the user's `REG_SZ`
 * values, the user's `REG_EXPAND_SZ` values, then the account's logon names. Each step may replace
 * an earlier one's name. A `REG_EXPAND_SZ` value is expanded against what the earlier steps gave,
 * never against a value of its own step or a later one (a system value's `%USERPROFILE%` stays as
 * written), so the order the reader lists the values in never matters. The user's Path is
 * appended to the system's.
 */
export function registryEnvironment(
  system: ReadonlyMap<string, RegistryValue>,
  user: ReadonlyMap<string, RegistryValue>,
  base: Readonly<Record<string, string | undefined>>,
): Env {
  const vars = new Map<string, { name: string; value: string }>();
  const flat = (): Env => Object.fromEntries([...vars.values()].map((v) => [v.name, v.value]));
  const lowerBase = new Map(Object.entries(base).map(([k, v]) => [k.toLowerCase(), [k, v]]));
  const fromBase = (names: readonly string[]): void => {
    for (const name of names) {
      const value = lowerBase.get(name.toLowerCase())?.[1];
      if (value !== undefined) vars.set(name.toLowerCase(), { name, value });
    }
  };
  fromBase(CORE_SYSTEM_NAMES);
  const step = (
    values: ReadonlyMap<string, RegistryValue>,
    kind: RegistryValue["kind"],
    joinPath: boolean,
  ): void => {
    const before = flat();
    for (const [name, value] of values) {
      if (value.kind !== kind) continue;
      if (name === "" || name.includes("=") || value.value.includes("\0")) continue;
      const expanded = kind === "ExpandString" ? expandWindows(value.value, before) : value.value;
      const existing = vars.get(name.toLowerCase());
      if (joinPath && name.toLowerCase() === "path" && existing !== undefined) {
        existing.value = existing.value === "" ? expanded : `${existing.value};${expanded}`;
      } else vars.set(name.toLowerCase(), { name, value: expanded });
    }
  };
  step(system, "String", false);
  step(system, "ExpandString", false);
  fromBase(CORE_USER_NAMES);
  step(user, "String", true);
  step(user, "ExpandString", true);
  fromBase(ACCOUNT_NAMES);
  return flat();
}

/**
 * The registry reader's script (Windows PowerShell 5.1): both keys' string values, unexpanded, one
 * line each, `<system|user> <String|ExpandString> <name> <value>` with the name and the value in
 * base64 of UTF-8, so no console code page touches them, then a last line `end`. Fixed text.
 *
 * It calls .NET only, never a cmdlet: Windows PowerShell finds a cmdlet by searching the modules
 * on its module path, and in the reader's minimal environment that search took 12 s on a machine
 * with a few hundred modules installed (GitHub's Windows runner), against 0.13 s for the start
 * itself. Past the reader's deadline every launch fell back to the service's environment.
 *
 * A read that fails ends the script without `end` (`Stop`), so the claim falls back to the service's
 * environment, never a partial one: a key is absent only when its parent does not list it, and a
 * listed value that reads as nothing throws (windows-reads.ts). A value of another kind than a
 * string is no environment variable and is skipped.
 */
export const REGISTRY_SCRIPT =
  "$ErrorActionPreference='Stop';" +
  `${REGISTRY_READS};` +
  "$e=[Text.Encoding]::UTF8;$o=[Text.StringBuilder]::new();" +
  "foreach($pair in @(@('system',[Microsoft.Win32.Registry]::LocalMachine," +
  "'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')," +
  "@('user',[Microsoft.Win32.Registry]::CurrentUser,'Environment'))){" +
  "$k=key $pair[1] $pair[2];" +
  "if($null -ne $k){foreach($n in $k.GetValueNames()){" +
  "$kind=$k.GetValueKind($n).ToString();" +
  "if($kind -eq 'String' -or $kind -eq 'ExpandString'){" +
  "$v=$k.GetValue($n,$null,'DoNotExpandEnvironmentNames');if($null -eq $v){throw 'value'};" +
  "[void]$o.Append($pair[0]+' '+$kind+' '+[Convert]::ToBase64String($e.GetBytes($n))+' '+" +
  "[Convert]::ToBase64String($e.GetBytes([string]$v))+[char]10)}}}};" +
  "[void]$o.Append('end');" +
  "[Console]::Out.Write($o.ToString())";

/**
 * The reader's output, checked: both keys' values, or undefined when it is not exactly that (a
 * line of another shape or with a field missing, a field that is not base64 of UTF-8, or no `end`:
 * a cut-off run). An empty name or value is still a field: the empty string's base64.
 */
export function parseRegistryOutput(
  text: string,
): { system: Map<string, RegistryValue>; user: Map<string, RegistryValue> } | undefined {
  const lines = text.trimEnd().split("\n");
  if (lines.pop() !== "end") return undefined;
  const sections = {
    system: new Map<string, RegistryValue>(),
    user: new Map<string, RegistryValue>(),
  };
  for (const line of lines) {
    const fields = line.split(" ");
    if (fields.length !== 4) return undefined;
    const [section = "", kind = "", name = "", value = ""] = fields;
    if (section !== "system" && section !== "user") return undefined;
    if (kind !== "String" && kind !== "ExpandString") return undefined;
    const decodedName = base64Text(name);
    const decodedValue = base64Text(value);
    if (decodedName === undefined || decodedValue === undefined) return undefined;
    sections[section].set(decodedName, { kind, value: decodedValue });
  }
  return sections;
}
