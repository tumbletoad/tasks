// What `ttasks service install` writes (A2 3.3.2 to 3.3.4): the systemd user unit, the HKCU Run
// value and the LaunchAgent, each named with the install ID (A2 3.2.2 rule 3), and the
// `ttasks-launchd` wrapper that the build places beside the macOS launcher. Pure functions of their
// inputs, so the golden files of every OS are checked on every OS.
//
// Names. The daily install (no TTASKS_HOME) keeps the plain names `ttasks.service`, `TTasks` and
// `local.ttasks.service`: its paths are the fixed per-user defaults, so no other install can have
// them, and a renamed home folder (a new install ID) still finds its own entry. A separate install
// carries its install ID: `ttasks-<id>.service`, `TTasks (<id>)`, `local.ttasks.service.<id>`. A folder
// name is never used, because two different paths can end in the same name.
import { posix, win32 } from "node:path";
import { envVar, PRODUCT_ID, PRODUCT_NAME } from "@ttasks/brand";
import { isInstallId, type Layout } from "../hub/paths.ts";

/** The variable that tells `ttasks serve` which manager started it (hub/service.ts reads it). */
const TTASKS_SERVICE_MANAGER = envVar("SERVICE_MANAGER");

export type ServicePlatform = "linux" | "win32" | "darwin";

export const isServicePlatform = (value: string): value is ServicePlatform =>
  value === "linux" || value === "win32" || value === "darwin";

/** The names one install's OS entries carry. */
export interface ServiceNames {
  /** Linux: the systemd user unit. */
  readonly unit: string;
  /** Windows: the value under HKCU's Run key. */
  readonly runValue: string;
  /** macOS: the launchd label, and the plist's name without `.plist`. */
  readonly label: string;
}

/** A placeholder until the naming effort picks a reverse-DNS prefix (A2 3.3.4, A2 6 item 6). */
export const LABEL_PREFIX = "local";

/** The names of an install's OS entries: plain for the daily install, with the ID for a separate one. */
export function serviceNames(installId: string, separate: boolean): ServiceNames {
  if (!isInstallId(installId)) throw new TypeError("Invalid install ID");
  return separate
    ? {
        unit: `${PRODUCT_ID}-${installId}.service`,
        runValue: `${PRODUCT_NAME} (${installId})`,
        label: `${LABEL_PREFIX}.${PRODUCT_ID}.service.${installId}`,
      }
    : {
        unit: `${PRODUCT_ID}.service`,
        runValue: PRODUCT_NAME,
        label: `${LABEL_PREFIX}.${PRODUCT_ID}.service`,
      };
}

/**
 * The program an install's OS entry starts, by A2's layout (3.12.2): the version-following
 * launcher, never a version folder, so an update needs no new entry.
 * - Linux: `<root>/current/bin/ttasks`, run as `ttasks serve`.
 * - Windows: `ttasksw.exe` in the command folder (`%USERPROFILE%\.local\bin`, or `<root>\bin` of a
 *   TTASKS_HOME install), the stable supervisor, with no arguments.
 * - macOS: `<root>/current/bin/ttasks-launchd`, the wrapper, with no arguments.
 * The build (M1.13) and the installer (M1.14) may pass another path.
 */
export function defaultProgram(
  platform: ServicePlatform,
  layout: Pick<Layout, "root" | "bin">,
): string {
  if (platform === "win32") return win32.join(layout.bin, `${PRODUCT_ID}w.exe`);
  const bin = posix.join(layout.root, "current", "bin");
  return platform === "darwin"
    ? posix.join(bin, `${PRODUCT_ID}-launchd`)
    : posix.join(bin, PRODUCT_ID);
}

/** A path as an OS entry may carry it: absolute and free of control characters. */
export class EntryPathError extends Error {
  override readonly name = "EntryPathError";
}

// Control characters (C0, DEL and C1) end a line or a value in every format here.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function checkPath(path: string, platform: ServicePlatform, what: string): void {
  const absolute = platform === "win32" ? win32.isAbsolute(path) : posix.isAbsolute(path);
  if (!absolute || CONTROL.test(path) || (platform === "win32" && path.includes('"'))) {
    throw new EntryPathError(`The ${what} must be an absolute path without control characters`);
  }
}

// ---------------------------------------------------------------------------------------------
// Linux: the systemd user unit (A2 3.3.3)

/**
 * The comment that opens a unit or plist this command wrote, for the person who reads the file.
 * It never decides ownership: a comment says nothing about what the entry runs.
 */
export const WRITTEN_BY = `${PRODUCT_NAME}'s service, written by \`${PRODUCT_ID} service install\`. Remove it with \`${PRODUCT_ID} service uninstall\`.`;

/**
 * The executable of an `ExecStart=` line (systemd.service(5), "Command lines"): quoted when it holds
 * anything but plain path characters, `\` and `"` written as C escapes and `%` as `%%`, because
 * systemd expands specifiers and C escapes in the executable's path too. `$` stays as it is:
 * systemd expands variables only in the arguments, never in the path it executes, so `$$` there
 * would name another file (checked with `systemd-analyze verify` in render.test.ts).
 */
export function execPath(path: string): string {
  if (/^[A-Za-z0-9/._+-]+$/.test(path)) return path;
  const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${escaped}"`;
}

/** A unit-file value with specifiers: `%` is written `%%` (systemd.unit(5), "Specifiers"). */
const unitValue = (text: string): string => text.replaceAll("%", "%%");

export interface UnitInput {
  /** `<root>/current/bin/ttasks`: the launcher, run as `ttasks serve`. */
  readonly program: string;
  /** TTASKS_HOME of a separate install, named in the description (A2 3.2.2 rule 3). */
  readonly tasksHome?: string | undefined;
}

/**
 * systemd refuses a program path with a quote, an apostrophe or a backslash in it, however it is
 * escaped ("Executable name contains special characters", string_is_safe in systemd's source;
 * seen with `systemd-analyze verify`). Such a unit would be written and enabled, then never start.
 */
const SYSTEMD_UNSAFE = /["'\\]/;

const DELEGATE_COMMENT =
  "# Background runs: each in a child cgroup of this unit, which the service manages itself.";

/**
 * A unit an earlier version wrote, without `Delegate=yes`, with it added at the end of its
 * `[Service]` section as `renderUnit` writes it, every other byte kept. Undefined when the unit
 * already says something about delegation, has no `[Service]` section, or ends that section in a
 * continued line.
 */
export function withDelegate(text: string): string | undefined {
  if (unitDirectives(text).some((d) => d.section === "Service" && d.key === "Delegate")) {
    return undefined;
  }
  const lines = text.split("\n");
  let service = -1;
  let end = lines.length;
  for (const [i, raw] of lines.entries()) {
    const line = sdTrim(raw);
    if (!line.startsWith("[") || !line.endsWith("]")) continue;
    if (service !== -1) {
      end = i;
      break;
    }
    if (line === "[Service]") service = i;
  }
  if (service === -1) return undefined;
  // Before the blank lines and comments that close the section, where renderUnit writes it.
  let at = end;
  const closing = (line: string) => line === "" || line.startsWith("#") || line.startsWith(";");
  while (at > service + 1 && closing(sdTrim(lines[at - 1] ?? ""))) at -= 1;
  if ((lines[at - 1] ?? "").trimEnd().endsWith("\\")) return undefined;
  lines.splice(at, 0, DELEGATE_COMMENT, "Delegate=yes");
  return lines.join("\n");
}

/** The systemd user unit of A2 3.3.3. */
export function renderUnit(input: UnitInput): string {
  checkPath(input.program, "linux", "launcher");
  if (SYSTEMD_UNSAFE.test(input.program)) {
    throw new EntryPathError(
      "The launcher's path holds a quote, an apostrophe or a backslash, which systemd does not accept in a program path",
    );
  }
  if (input.tasksHome !== undefined) checkPath(input.tasksHome, "linux", "TTASKS_HOME");
  const description =
    input.tasksHome === undefined
      ? `${PRODUCT_NAME} service`
      : `${PRODUCT_NAME} service (TTASKS_HOME=${unitValue(input.tasksHome)})`;
  return [
    `# ${WRITTEN_BY}`,
    "[Unit]",
    `Description=${description}`,
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=exec",
    `ExecStart=${execPath(input.program)} serve`,
    "WorkingDirectory=%h",
    `Environment=${TTASKS_SERVICE_MANAGER}=systemd`,
    "Restart=on-failure",
    "RestartSec=2",
    "RestartPreventExitStatus=64 73",
    "KillMode=mixed",
    "TimeoutStopSec=15",
    DELEGATE_COMMENT,
    "Delegate=yes",
    "# No ProtectHome, PrivateTmp or NoNewPrivileges: launched agents need the user's full home and tools.",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * Why an entry at the install's name is not this install's, or undefined when it is. Decided on
 * everything the entry makes its manager do, never on a comment:
 * - `unusual_text`: text install never writes and a reader may split differently from this one: a
 *   control character other than the line feed (NUL, which systemd reads as a line end, CR, tab,
 *   C1), a byte order mark anywhere but at the start of a unit, text that is not UTF-8, or more
 *   than ENTRY_MAX_BYTES;
 * - `not_ours`: it does not start a TTasks launcher in the form install writes;
 * - `names_other_units`: a unit whose `[Install]` section has `Also=`, so `systemctl --user
 *   disable` (and enable) would change those units too;
 * - `other_settings`: a setting install does not write (another command such as `ExecStartPre=`,
 *   another variable, another section, even an empty one, an `.include`, a plist key). The person,
 *   or another program, made it theirs;
 * - `overridden`: a unit that drop-ins change (commands.ts unitDropIns);
 * - `not_a_file`: a link or a folder at the entry's path.
 */
export type NotOurs =
  | "unusual_text"
  | "not_ours"
  | "names_other_units"
  | "other_settings"
  | "overridden"
  | "not_a_file";

/**
 * The most a unit or plist of this install can hold. Install writes under 1 KiB (a path is at most
 * a few KiB); systemd refuses a line over 1 MiB, so a file of this size never reaches that rule.
 */
export const ENTRY_MAX_BYTES = 64 * 1024;

// Every control character but the line feed: install writes no other into a unit, plist or value.
// eslint-disable-next-line no-control-regex
const UNWRITTEN_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/**
 * Whether `text` holds something install never writes and that a reader might split differently
 * from this module (see NotOurs `unusual_text`). `bom`: a byte order mark may open the text, where
 * systemd skips it. Text that is not UTF-8 is caught where bytes are decoded (commands.ts); a
 * string that is not well formed is caught here.
 */
export function unusualText(text: string, options: { readonly bom?: boolean } = {}): boolean {
  const body = options.bom === true && text.startsWith("\uFEFF") ? text.slice(1) : text;
  return (
    UNWRITTEN_CONTROL.test(body) ||
    body.includes("\uFEFF") ||
    !body.isWellFormed() ||
    Buffer.byteLength(text, "utf8") > ENTRY_MAX_BYTES
  );
}

/** systemd's whitespace: ASCII only (WHITESPACE in its string-util.h). */
const SD_SPACE = " \t\n\r";
const sdTrim = (text: string): string => {
  let from = 0;
  let to = text.length;
  while (from < to && SD_SPACE.includes(text.charAt(from))) from += 1;
  while (to > from && SD_SPACE.includes(text.charAt(to - 1))) to -= 1;
  return text.slice(from, to);
};

/** A unit file's line that systemd reads: a section header, an assignment, or one it cannot place. */
export type UnitLine =
  | { readonly header: string }
  | { readonly section: string; readonly key: string; readonly value: string }
  | { readonly section: string; readonly odd: string };

/**
 * A unit file's lines as systemd reads them (systemd.syntax(7), conf-parser.c), for text that
 * passed unusualText: so no NUL, CR or other control character but the line feed, which is then
 * the only line end, as it is for systemd. A leading byte order mark skipped; a line whose first
 * non-blank character is `#` or `;` skipped, also inside a continuation; a line ending in an
 * unescaped backslash continued on the next line, the backslash becoming a space, and a
 * continuation still open at the end of the file read as a line, as is a last line without a line
 * feed. A line that is neither a section nor `key=value` (an `.include`, a broken header) comes
 * back as `odd`.
 */
export function unitLines(text: string): UnitLine[] {
  const out: UnitLine[] = [];
  let section = "";
  const parse = (raw: string) => {
    const line = sdTrim(raw);
    if (line === "") return;
    if (line.startsWith("[")) {
      if (line.endsWith("]")) {
        section = line.slice(1, -1);
        out.push({ header: section });
      } else {
        out.push({ section, odd: line });
      }
      return;
    }
    const at = line.indexOf("=");
    if (at <= 0) {
      out.push({ section, odd: line });
      return;
    }
    out.push({ section, key: sdTrim(line.slice(0, at)), value: sdTrim(line.slice(at + 1)) });
  };
  let pending: string | undefined;
  for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
    const first = raw.charAt(raw.search(/[^ \t\n\r]/));
    if (first === "#" || first === ";") continue;
    const joined = pending === undefined ? raw : pending + raw;
    let escaped = false;
    for (const c of joined) escaped = !escaped && c === "\\";
    if (escaped) {
      pending = `${joined.slice(0, -1)} `;
      continue;
    }
    pending = undefined;
    parse(joined);
  }
  if (pending !== undefined) parse(pending);
  return out;
}

/** The assignments of a unit file, in order (see unitLines). */
export function unitDirectives(text: string): { section: string; key: string; value: string }[] {
  return unitLines(text).filter(
    (line): line is { section: string; key: string; value: string } => "key" in line,
  );
}

/**
 * The words of a command line as systemd splits them (systemd.service(5), "Command lines"): `%%`
 * is a `%`, double and single quotes group, a backslash escapes the next character (`\\`, `\"`,
 * `\'`; other C escapes are kept as written, which no path install writes contains), and words end
 * at ASCII whitespace only.
 */
export function execWords(value: string): string[] {
  const words: string[] = [];
  let i = 0;
  const s = value.replaceAll("%%", "\u0000");
  const blank = (c: string) => SD_SPACE.includes(c);
  while (i < s.length) {
    while (i < s.length && blank(s.charAt(i))) i += 1;
    if (i >= s.length) break;
    let word = "";
    let quote: string | undefined;
    for (; i < s.length; i += 1) {
      const c = s.charAt(i);
      if (quote === undefined && blank(c)) break;
      if (c === "\\" && i + 1 < s.length) {
        const next = s.charAt(i + 1);
        word += next === "\\" || next === '"' || next === "'" ? next : `\\${next}`;
        i += 1;
      } else if (quote !== undefined && c === quote) {
        quote = undefined;
      } else if (quote === undefined && (c === '"' || c === "'")) {
        quote = c;
      } else {
        word += c;
      }
    }
    words.push(word.replaceAll("\u0000", "%"));
  }
  return words;
}

/**
 * The settings install writes, by section. A unit is ours only when it has no other: any other
 * setting could run another program (`ExecStartPre=`, `EnvironmentFile=`, `LD_PRELOAD` in
 * `Environment=`) or reach another unit. Their values may differ (a person may tune `RestartSec=`),
 * except `ExecStart=` and `Environment=`, which must be install's own. A later version that writes
 * another setting adds it here, so it still recognises the units earlier versions wrote.
 */
const UNIT_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  Unit: ["Description", "StartLimitIntervalSec", "StartLimitBurst"],
  Service: [
    "Type",
    "ExecStart",
    "WorkingDirectory",
    "Environment",
    "Restart",
    "RestartSec",
    "RestartPreventExitStatus",
    "KillMode",
    "TimeoutStopSec",
    "Delegate",
  ],
  Install: ["WantedBy"],
};

/**
 * Whether an `ExecStart=` value holds only what install writes there: no backslash or apostrophe
 * (install refuses both in a program path) and no specifier but `%%`. systemd unescapes C escapes
 * and expands specifiers in the path it runs, which execWords does not, so a value with them would
 * name another program than the words read here.
 */
function plainExec(value: string): boolean {
  if (value.includes("\\") || value.includes("'")) return false;
  for (let at = value.indexOf("%"); at !== -1; at = value.indexOf("%", at + 2)) {
    if (value.charAt(at + 1) !== "%") return false;
  }
  return true;
}

/**
 * Whether a unit file is this install's (see NotOurs): it holds only text install writes
 * (unusualText); read as systemd reads it, its `[Service]` section starts exactly one command,
 * `<absolute path ending in /tasks> serve`, with no prefix, escape or specifier; its only variable
 * is `TTASKS_SERVICE_MANAGER=systemd`; its `[Install]` section names no other unit; and it has no
 * setting, section (not even an empty one) or line install does not write. Drop-ins are checked by
 * the caller.
 */
export function unitNotOurs(text: string): NotOurs | undefined {
  if (unusualText(text, { bom: true })) return "unusual_text";
  const lines = unitLines(text);
  const directives = unitDirectives(text);
  let starts: string[] = [];
  for (const d of directives) {
    if (d.section !== "Service" || d.key !== "ExecStart") continue;
    // An empty assignment resets the list (systemd.service(5)).
    starts = d.value === "" ? [] : [...starts, d.value];
  }
  const words = starts.length === 1 && plainExec(starts[0] ?? "") ? execWords(starts[0] ?? "") : [];
  const program = words[0] ?? "";
  if (
    words.length !== 2 ||
    words[1] !== "serve" ||
    !program.startsWith("/") ||
    !program.endsWith(`/${PRODUCT_ID}`)
  ) {
    return "not_ours";
  }
  if (directives.some((d) => d.section === "Install" && d.key === "Also" && d.value !== "")) {
    return "names_other_units";
  }
  const own = `${TTASKS_SERVICE_MANAGER}=systemd`;
  const allowed = (section: string): readonly string[] | undefined =>
    Object.hasOwn(UNIT_SETTINGS, section) ? UNIT_SETTINGS[section] : undefined;
  const foreign = lines.some((line) => {
    if ("header" in line) return allowed(line.header) === undefined;
    if (!("key" in line)) return true;
    return (
      !(allowed(line.section) ?? []).includes(line.key) ||
      (line.key === "Environment" && line.value !== "" && execWords(line.value).join("\n") !== own)
    );
  });
  return foreign ? "other_settings" : undefined;
}

export const isOwnUnit = (text: string): boolean => unitNotOurs(text) === undefined;

// ---------------------------------------------------------------------------------------------
// Windows: the HKCU Run value (A2 3.3.2)

/** The key under HKCU that holds Run and Explorer\StartupApproved\Run. */
export const REGISTRY_ROOT = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion";

/** The Run key and the key where Task Manager records each Run entry's on or off state. */
export const runKeys = (root: string) =>
  ({
    run: `${root}\\Run`,
    approved: `${root}\\Explorer\\StartupApproved\\Run`,
  }) as const;

export interface RunValue {
  readonly name: string;
  readonly type: "REG_SZ";
  /** The quoted absolute path of `ttasksw.exe`, with no arguments. */
  readonly data: string;
}

/** The Run value of A2 3.3.2: `"<root>\bin\ttasksw.exe"`, quoted, absolute, no arguments. */
export function renderRunValue(name: string, program: string): RunValue {
  checkPath(program, "win32", "supervisor");
  return { name, type: "REG_SZ", data: `"${program}"` };
}

/**
 * Why a REG_SZ Run value's data is not this install's (see NotOurs), or undefined when it starts a
 * TTasks supervisor as install writes it: exactly one quoted absolute path to `ttasksw.exe`, with
 * nothing around it and no control character (Explorer would stop reading at a NUL).
 */
export function runDataNotOurs(data: string): NotOurs | undefined {
  if (unusualText(data)) return "unusual_text";
  const match = /^"([^"]+)"$/.exec(data);
  return match?.[1] !== undefined &&
    win32.isAbsolute(match[1]) &&
    win32.basename(match[1]).toLowerCase() === `${PRODUCT_ID}w.exe`
    ? undefined
    : "not_ours";
}

/** Whether a Run value's data starts a TTasks supervisor: one quoted path to `ttasksw.exe`. */
export const isOwnRunData = (data: string): boolean => runDataNotOurs(data) === undefined;

/**
 * Task Manager's record of a Run entry (A2 3.3.2): a REG_BINARY whose first byte is even when the
 * entry is on and odd when the user turned it off (0x03 is what Task Manager writes; 0x02 and 0x06
 * mean on). No record means on: Windows writes one only when the user changes it.
 */
export function startupApproved(bytes: Uint8Array | undefined): "on" | "off" | "not_set" {
  if (bytes === undefined || bytes.length === 0) return "not_set";
  return ((bytes[0] ?? 0) & 1) === 1 ? "off" : "on";
}

// ---------------------------------------------------------------------------------------------
// macOS: the LaunchAgent (A2 3.3.4)

const xml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export interface PlistInput {
  readonly label: string;
  /** `<root>/current/bin/ttasks-launchd`. */
  readonly program: string;
  /** The user's home folder: the working directory. */
  readonly home: string;
  /** The install's log folder: launchd writes the service's stdout and stderr there. */
  readonly logs: string;
}

/** The LaunchAgent of A2 3.3.4. */
export function renderPlist(input: PlistInput): string {
  for (const [path, what] of [
    [input.program, "wrapper"],
    [input.home, "home folder"],
    [input.logs, "log folder"],
  ] as const) {
    checkPath(path, "darwin", what);
  }
  const string = (key: string, value: string) =>
    `  <key>${key}</key>\n  <string>${xml(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- ${WRITTEN_BY} -->`,
    '<plist version="1.0">',
    "<dict>",
    string("Label", input.label),
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xml(input.program)}</string>`,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    `    <key>${TTASKS_SERVICE_MANAGER}</key>`,
    "    <string>launchd</string>",
    "  </dict>",
    string("WorkingDirectory", input.home),
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>5</integer>",
    "  <key>ExitTimeOut</key>",
    "  <integer>15</integer>",
    "  <key>ProcessType</key>",
    "  <string>Interactive</string>",
    "  <key>AbandonProcessGroup</key>",
    "  <true/>",
    string("StandardOutPath", posix.join(input.logs, "service.stdout.log")),
    string("StandardErrorPath", posix.join(input.logs, "service.stderr.log")),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** A plist value, as far as the ownership check needs one. */
export type PlistValue =
  | { readonly kind: "text"; readonly element: string; readonly text: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "array"; readonly items: readonly PlistValue[] }
  | { readonly kind: "dict"; readonly entries: readonly (readonly [string, PlistValue])[] };

const PLIST_PROLOG: ReadonlySet<string> = new Set([
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
]);
const PLIST_TAG = /^<(\/?)(dict|key|string|array|integer|real|true|false|date|data)(\/?)>$/;

/**
 * A plist in the plain spelling install writes, or undefined for anything else: no attribute,
 * space or other markup inside a tag, no character reference, entity, CDATA section or internal
 * DTD, only `&amp;`, `&lt;` and `&gt;` in text. What XML can spell another way (`Progr&#97;m`,
 * `<key >`) is then never read as something else, and launchd's reading of such a file is never
 * guessed at: it is not ours.
 */
export function readPlist(text: string): PlistValue | undefined {
  const all = [...text.matchAll(/<!--[\s\S]*?-->|<[^<>]*>|[^<]+/g)].map((m) => m[0]);
  if (all.join("") !== text) return undefined;
  const tokens = all.filter((t) => !t.startsWith("<!--"));
  let i = 0;
  const blank = (t: string | undefined) => t !== undefined && /^[ \t\r\n]*$/.test(t);
  const skip = () => {
    while (blank(tokens[i])) i += 1;
  };
  const textOf = (t: string): string | undefined =>
    /&(?!(amp|lt|gt);)/.test(t)
      ? undefined
      : t.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  /** The text of a leaf element whose opening tag was read; undefined when it is not one. */
  const leaf = (name: string): string | undefined => {
    let text = "";
    const next = tokens[i];
    if (next !== undefined && !next.startsWith("<")) {
      const decoded = textOf(next);
      if (decoded === undefined) return undefined;
      text = decoded;
      i += 1;
    }
    if (tokens[i] !== `</${name}>`) return undefined;
    i += 1;
    return text;
  };
  const value = (): PlistValue | undefined => {
    skip();
    const tag = PLIST_TAG.exec(tokens[i] ?? "");
    if (tag === null || tag[1] === "/" || tag[2] === "key") return undefined;
    i += 1;
    const name = tag[2] ?? "";
    const empty = tag[3] === "/";
    if (name === "true" || name === "false") {
      if (!empty && leaf(name) !== "") return undefined;
      return { kind: "bool", value: name === "true" };
    }
    if (name === "array") {
      const items: PlistValue[] = [];
      skip();
      while (!empty && tokens[i] !== "</array>") {
        const item = value();
        if (item === undefined) return undefined;
        items.push(item);
        skip();
      }
      if (!empty) i += 1;
      return { kind: "array", items };
    }
    if (name === "dict") {
      const entries: [string, PlistValue][] = [];
      skip();
      while (!empty && tokens[i] !== "</dict>") {
        if (tokens[i] !== "<key>") return undefined;
        i += 1;
        const key = leaf("key");
        const item = key === undefined ? undefined : value();
        if (key === undefined || item === undefined) return undefined;
        entries.push([key, item]);
        skip();
      }
      if (!empty) i += 1;
      return { kind: "dict", entries };
    }
    const content = empty ? "" : leaf(name);
    return content === undefined ? undefined : { kind: "text", element: name, text: content };
  };
  skip();
  while (PLIST_PROLOG.has(tokens[i] ?? "")) {
    i += 1;
    skip();
  }
  if (tokens[i] !== '<plist version="1.0">') return undefined;
  i += 1;
  const root = value();
  skip();
  if (root === undefined || tokens[i] !== "</plist>") return undefined;
  i += 1;
  skip();
  return i === tokens.length ? root : undefined;
}

/** The keys install writes. Their values may differ, except Label, ProgramArguments, the variables. */
const PLIST_KEYS: readonly string[] = [
  "Label",
  "ProgramArguments",
  "EnvironmentVariables",
  "WorkingDirectory",
  "RunAtLoad",
  "KeepAlive",
  "ThrottleInterval",
  "ExitTimeOut",
  "ProcessType",
  "AbandonProcessGroup",
  "StandardOutPath",
  "StandardErrorPath",
];

/**
 * Whether a plist is this install's LaunchAgent (see NotOurs): it holds only text install writes
 * (unusualText, no byte order mark); read as a plist in install's plain spelling (readPlist), its
 * top-level dictionary has each key once, `Label` is `label`, there is no `Program` (launchd would
 * run it instead of ProgramArguments), `ProgramArguments` holds only `<absolute path ending in
 * /ttasks-launchd>`, the only variable is `TTASKS_SERVICE_MANAGER=launchd`, and there is no key
 * install does not write.
 */
export function plistNotOurs(text: string, label: string): NotOurs | undefined {
  if (unusualText(text)) return "unusual_text";
  const root = readPlist(text);
  if (root?.kind !== "dict") return "not_ours";
  const keys = root.entries.map(([key]) => key);
  const get = (key: string) => root.entries.find(([k]) => k === key)?.[1];
  const labelValue = get("Label");
  const args = get("ProgramArguments");
  const program =
    args?.kind === "array" && args.items.length === 1 && args.items[0]?.kind === "text"
      ? args.items[0]
      : undefined;
  if (
    new Set(keys).size !== keys.length ||
    labelValue?.kind !== "text" ||
    labelValue.element !== "string" ||
    labelValue.text !== label ||
    keys.includes("Program") ||
    program?.element !== "string" ||
    !program.text.startsWith("/") ||
    !program.text.endsWith(`/${PRODUCT_ID}-launchd`)
  ) {
    return "not_ours";
  }
  const env = get("EnvironmentVariables");
  const ownEnv =
    env === undefined ||
    (env.kind === "dict" &&
      env.entries.length === 1 &&
      env.entries[0]?.[0] === TTASKS_SERVICE_MANAGER &&
      env.entries[0][1].kind === "text" &&
      env.entries[0][1].element === "string" &&
      env.entries[0][1].text === "launchd");
  return ownEnv && keys.every((key) => PLIST_KEYS.includes(key)) ? undefined : "other_settings";
}

export const isOwnPlist = (text: string, label: string): boolean =>
  plistNotOurs(text, label) === undefined;

/**
 * `bin/ttasks-launchd` (A2 3.3.4): runs `ttasks serve` as its child and turns the exit codes into
 * what launchd's `KeepAlive.SuccessfulExit = false` understands. 0, 64 and 73 exit 0, so launchd
 * does not restart a clean stop or a permanent refusal. 75 starts the service again at once. Any
 * other code is passed on, and launchd restarts after `ThrottleInterval`. A TERM or INT is
 * forwarded to the service, and a stop always ends in 0, so `launchctl kill TERM` stops it for good.
 *
 * Three additions to A2's text: a stop that arrives before the child's PID is known is still
 * forwarded; `child` is cleared once the child is reaped, so a late signal never reaches a reused
 * PID; and more than 5 restarts on 75 within 10 minutes exit 75 instead, so launchd's throttle
 * bounds a service that always asks for a restart, as ttasksw.exe and systemd bound it (A2
 * 3.3.1). The build (M1.13) writes this text to `versions/<v>/bin/ttasks-launchd`, mode 0755.
 */
export const LAUNCHD_WRAPPER = `#!/bin/sh
# ttasks-launchd: runs \`ttasks serve\` for launchd. Generated at build time. Do not edit.
ttasks=\${0%/*}/ttasks                  # <root>/current/bin/ttasks, so a restart re-reads current
child= stop= quick=0 since=$(date +%s)
trap 'stop=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null' TERM INT
while [ -z "$stop" ]; do
  "$ttasks" serve & child=$!
  [ -n "$stop" ] && kill -TERM "$child" 2>/dev/null   # a stop that came before child was set
  while wait "$child"; code=$?; kill -0 "$child" 2>/dev/null; do :; done   # wait again after a trapped signal
  child=
  [ -n "$stop" ] && exit 0             # asked to stop: never restart
  case $code in
    0|64|73) exit 0 ;;                 # clean stop or permanent refusal: no restart
    75) now=$(date +%s)                # restart requested: start again at once,
        [ $((now - since)) -ge 600 ] && quick=0 since=$now
        quick=$((quick + 1))
        [ "$quick" -le 5 ] && continue
        exit 75 ;;                     # but more than 5 in 10 minutes: launchd's throttle
    *) exit "$code" ;;                 # crash: launchd restarts after ThrottleInterval
  esac
done
exit 0
`;
