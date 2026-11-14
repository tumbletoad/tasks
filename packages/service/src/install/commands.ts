// `tasks service install|uninstall|start|stop|status` (A2 3.3.5) as functions over a
// ServiceContext.
//
// install and uninstall first make a plan: the exact steps, which the entry shows as the preview
// before anything is written, and which applyPlan then carries out in that order. A plan writes
// only this install's own entry (a unit file, a Run value or a plist named with the install ID),
// the folders or keys that entry needs, and a note of the ones it created (CREATED_FILE). Uninstall
// removes exactly that entry, Windows's on or off record of it, and the folders and keys the note
// names, each only when empty. An entry of another program at the install's name is never changed:
// both refuse. Neither enables linger, changes Task Manager's choice or needs elevation.
//
// Every step that changes the entry, or that a manager carries out on it, reads the entry last
// before it acts, with nothing else read in between, and reads it again afterwards (applyPlan).
// What that prevents and what it only detects is the decision's "guarantee".
//
// start goes through the OS (A2 3.3.5, 3.5 rule 5) and never runs `tasks serve` in this process's
// tree, except where nothing else can start it: Linux without a user manager (setsid), and Windows
// without Explorer in this session (detached). Both wait for a ready service that completes a
// handshake.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { CLI_NAME, PRODUCT_NAME } from "@tasks/brand";
import type { ServiceStatus } from "../hub/endpoint.ts";
import {
  atomicWrite,
  createFile,
  ensurePrivateDir,
  judgePath,
  makeDir,
  type Judged,
} from "../hub/files.ts";
import { unsafeMessage } from "../hub/permissions.ts";
import { readUmask, umaskRefusal } from "../hub/umask.ts";
import { liveRecord, type Probe, type ProbeReason, type ServiceContext } from "./context.ts";
import { ServiceCommandError } from "./errors.ts";
import { TOOL_TIMEOUT_MS, type Runner } from "./process.ts";
import {
  missingKeys,
  regBytes,
  RegistryTimeoutError,
  regKey,
  type RegReadOptions,
  type RegValue,
} from "./registry.ts";
import {
  EntryPathError,
  plistNotOurs,
  renderPlist,
  renderRunValue,
  renderUnit,
  runDataNotOurs,
  runKeys,
  startupApproved,
  unitNotOurs,
  type NotOurs,
} from "./render.ts";

// ---------------------------------------------------------------------------------------------
// The entry and what install would write

export type EntryKind = "systemd-unit" | "run-value" | "launch-agent";

/** This install's OS entry as it stands. */
export interface EntryInfo {
  readonly kind: EntryKind;
  /** The unit, the Run value's name or the launchd label. */
  readonly name: string;
  /** The unit or plist file, or the key that holds the Run value. */
  readonly where: string;
  /** `foreign`: something at the install's name that is not this install's entry (render.ts NotOurs). */
  readonly state: "absent" | "ours" | "foreign";
  /** Why a foreign entry is not ours. */
  readonly why?: NotOurs;
  /** Ours and exactly what install writes now. */
  readonly current: boolean;
}

type StartupApps = "on" | "off" | "not_set";

/**
 * What is at the entry, exactly, as a plan compares it. A plan keeps what it saw; its apply reads
 * the entry again before and after each step that touches it (applyPlan).
 */
export interface Observed {
  /** The unit or plist file (`absent`, its exact bytes, or a link or folder), or the Run value. */
  readonly entry: string;
  /** Linux: the drop-ins systemd applies to the unit, with their bytes ("" for none). */
  readonly dropIns?: string;
  /** Windows, uninstall: Task Manager's record of the entry, which uninstall removes. */
  readonly approved?: string;
}

interface Wanted {
  readonly info: EntryInfo;
  /** The unit or plist text, or the Run value's data. */
  readonly content: string;
  readonly observed: Observed;
  /** Windows: Task Manager's record of this entry, and whether a record exists. */
  readonly startupApps?: StartupApps;
  readonly approvedRecord?: boolean;
  /** Windows: whether the Run key itself exists (install would create it). */
  readonly runKey?: boolean;
}

const verbFor = (verb: string) => `${CLI_NAME} service ${verb}`;

function rendered<T>(render: () => T): T {
  try {
    return render();
  } catch (error) {
    if (!(error instanceof EntryPathError)) throw error;
    throw new ServiceCommandError("usage", "invalid_install_path", `${error.message}.`);
  }
}

/** A file at an entry's path, exactly: absent, its bytes, or something that is not a file. */
type Found =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly bytes: Buffer }
  | { readonly kind: "other"; readonly mark: string };

// Not on Windows, where no unit or plist is read.
const OPEN_FLAGS =
  constants.O_RDONLY |
  ((constants as Partial<typeof constants>).O_NOFOLLOW ?? 0) |
  ((constants as Partial<typeof constants>).O_NONBLOCK ?? 0);

/**
 * What is at `path`, read without following a link there: a link, a folder or anything else that
 * is not a regular file is `other`. A file is read through the descriptor that was checked, so it
 * cannot be swapped for a link between the check and the read.
 */
function readFound(path: string): Found {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    // A link (ELOOP), a folder on Windows, a socket: identified by lstat. A file that cannot be
    // opened is not decided here.
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      throw error;
    }
    if (stat.isFile()) throw error;
    return { kind: "other", mark: `${String(stat.mode)} ${String(stat.ino)}` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: "other", mark: `${String(stat.mode)} ${String(stat.ino)}` };
    return { kind: "file", bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

const fileMark = (found: Found): string =>
  found.kind === "absent"
    ? "absent"
    : found.kind === "file"
      ? `file\n${found.bytes.toString("base64")}`
      : `other ${found.mark}`;

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The text of `bytes` when they are UTF-8, a byte order mark kept; undefined otherwise. */
function strictText(bytes: Uint8Array): string | undefined {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** A unit or plist file at `path`: absent, ours or foreign. A link or a folder there is foreign. */
function fileEntry(
  kind: EntryKind,
  name: string,
  path: string,
  content: string,
  notOurs: (text: string) => NotOurs | undefined,
): Wanted {
  const found = readFound(path);
  let state: EntryInfo["state"] = "absent";
  let why: NotOurs | undefined;
  let current = false;
  if (found.kind === "file") {
    const text = strictText(found.bytes);
    why = text === undefined ? "unusual_text" : notOurs(text);
    state = why === undefined ? "ours" : "foreign";
    current = state === "ours" && found.bytes.equals(Buffer.from(content, "utf8"));
  } else if (found.kind === "other") {
    state = "foreign";
    why = "not_a_file";
  }
  return {
    info: { kind, name, where: path, state, ...(why === undefined ? {} : { why }), current },
    content,
    observed: { entry: fileMark(found) },
  };
}

const valueText = (value: RegValue | undefined): string =>
  value === undefined ? "absent" : `${value.kind}\n${value.data}`;

/**
 * The drop-ins systemd would apply to `unit` from the user's unit folder (systemd.unit(5)): the
 * `.conf` files in `<unit>.d/` and, for a name with dashes, in each prefix folder such as
 * `tasks-.service.d/`, each with its exact bytes. Empty when there are none. The type-wide
 * `service.d/` is the person's setting for every service and is left out; so are drop-ins in
 * system folders.
 */
export function unitDropIns(unitDir: string, unit: string): string {
  const stem = unit.endsWith(".service") ? unit.slice(0, -".service".length) : unit;
  const folders = [`${unit}.d`];
  for (let at = stem.indexOf("-"); at !== -1; at = stem.indexOf("-", at + 1)) {
    folders.push(`${stem.slice(0, at + 1)}.service.d`);
  }
  const found: string[] = [];
  for (const folder of folders) {
    let names: string[];
    try {
      names = readdirSync(join(unitDir, folder));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    for (const name of names.filter((n) => n.endsWith(".conf")).sort()) {
      let content: string;
      try {
        content = readFileSync(join(unitDir, folder, name)).toString("base64");
      } catch {
        content = "(unreadable)";
      }
      found.push(`${folder}/${name}\n${content}`);
    }
  }
  return found.join("\n");
}

const unitPath = (ctx: ServiceContext) => join(ctx.roots.unitDir, ctx.names.unit);
const plistPath = (ctx: ServiceContext) =>
  join(ctx.roots.launchAgentsDir, `${ctx.names.label}.plist`);

/**
 * This install's entry, and what install would write. Like every check, it reads the part a step
 * changes last: drop-ins before the unit, Task Manager's record before the Run value.
 */
export async function readEntry(
  ctx: ServiceContext,
  options: RegReadOptions = {},
): Promise<Wanted> {
  switch (ctx.platform) {
    case "linux": {
      const text = rendered(() => renderUnit({ program: ctx.program, tasksHome: ctx.layout.home }));
      const dropIns = unitDropIns(ctx.roots.unitDir, ctx.names.unit);
      const unit = fileEntry("systemd-unit", ctx.names.unit, unitPath(ctx), text, unitNotOurs);
      const observed = { entry: unit.observed.entry, dropIns };
      if (dropIns === "") return { ...unit, observed };
      // A drop-in changes what the unit does, including what enable and disable act on, so a
      // unit with one is not this install's to write or remove, whatever its own file says.
      return {
        ...unit,
        info: { ...unit.info, state: "foreign", why: "overridden", current: false },
        observed,
      };
    }
    case "darwin": {
      const text = rendered(() =>
        renderPlist({
          label: ctx.names.label,
          program: ctx.program,
          home: ctx.home,
          logs: ctx.layout.logs,
        }),
      );
      return fileEntry("launch-agent", ctx.names.label, plistPath(ctx), text, (found) =>
        plistNotOurs(found, ctx.names.label),
      );
    }
    case "win32": {
      const value = rendered(() => renderRunValue(ctx.names.runValue, ctx.program));
      const keys = runKeys(ctx.roots.registryRoot);
      // Value names compare without case, as the registry compares them.
      const name = value.name.toLowerCase();
      const record = (await ctx.registry.values(keys.approved, options))?.get(name);
      const run = await ctx.registry.values(keys.run, options);
      const found = run?.get(name);
      const why =
        found === undefined
          ? undefined
          : found.kind === "REG_SZ"
            ? runDataNotOurs(found.data)
            : "not_ours";
      const state = found === undefined ? "absent" : why === undefined ? "ours" : "foreign";
      return {
        info: {
          kind: "run-value",
          name: value.name,
          where: keys.run,
          state,
          ...(why === undefined ? {} : { why }),
          current: state === "ours" && found?.data === value.data,
        },
        content: value.data,
        observed: { entry: valueText(found), approved: valueText(record) },
        startupApps: startupApproved(record?.kind === "REG_BINARY" ? regBytes(record) : undefined),
        approvedRecord: record !== undefined,
        runKey: run !== undefined,
      };
    }
  }
}

/**
 * The entry as it is now, in the form a plan compares (Observed), with the part a step changes
 * read last: drop-ins before the unit file; Task Manager's record before the Run value, or after it
 * when the step removes the record. Only what `expected` holds is read. `timeoutMs` bounds the
 * registry reads together.
 */
async function observe(
  ctx: ServiceContext,
  expected: Observed,
  last: "entry" | "approved",
  timeoutMs?: number,
): Promise<Observed> {
  switch (ctx.platform) {
    case "linux": {
      const dropIns = unitDropIns(ctx.roots.unitDir, ctx.names.unit);
      return { entry: fileMark(readFound(unitPath(ctx))), dropIns };
    }
    case "darwin":
      return { entry: fileMark(readFound(plistPath(ctx))) };
    case "win32": {
      const keys = runKeys(ctx.roots.registryRoot);
      const name = ctx.names.runValue.toLowerCase();
      const end = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
      const read = async (key: string) =>
        valueText(
          (
            await ctx.registry.values(
              key,
              end === undefined ? {} : { timeoutMs: Math.max(1, end - Date.now()) },
            )
          )?.get(name),
        );
      if (expected.approved === undefined) return { entry: await read(keys.run) };
      if (last === "approved") {
        const entry = await read(keys.run);
        return { entry, approved: await read(keys.approved) };
      }
      const approved = await read(keys.approved);
      return { entry: await read(keys.run), approved };
    }
  }
}

const sameEntry = (now: Observed, expected: Observed): boolean =>
  now.entry === expected.entry &&
  (expected.dropIns === undefined || now.dropIns === expected.dropIns) &&
  (expected.approved === undefined || now.approved === expected.approved);

// ---------------------------------------------------------------------------------------------
// What install created: noted in the install's state folder, so a later uninstall removes it

/**
 * The note of the folders and keys install created around its entry, in the install's state
 * folder: `{format: 1, entry, folders, keys}`. Uninstall, in this process or a later one, removes
 * those that are still empty and then the note. A folder or key that existed before install is
 * never in it, so uninstall never removes one; a lost note leaves empty folders, never removes
 * more.
 */
export const CREATED_FILE = "service-entry.json";

interface Created {
  readonly folders: readonly string[];
  readonly keys: readonly string[];
}

const createdPath = (ctx: ServiceContext) => join(ctx.layout.state, CREATED_FILE);

/** The entry a note belongs to: a note of another entry (other roots) is not this one's. */
function entryId(ctx: ServiceContext): string {
  switch (ctx.platform) {
    case "linux":
      return `systemd-unit ${unitPath(ctx)}`;
    case "darwin":
      return `launch-agent ${plistPath(ctx)}`;
    case "win32":
      return `run-value ${runKeys(ctx.roots.registryRoot).run} ${ctx.names.runValue}`;
  }
}

const strictlyInside = (path: string, top: string): boolean => {
  const rel = relative(top, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** `path` and the folders above it that lie inside `top`, deepest first. */
function folderChain(path: string, top: string): string[] {
  const chain = [path];
  for (let at = dirname(path); strictlyInside(at, top); at = dirname(at)) chain.push(at);
  return chain;
}

const KEY_BELOW_SOFTWARE = /^HKCU\\Software\\[^\\]/i;
const WANTS = "default.target.wants";

/**
 * What install may create, and so all a note may name: the entry's folder and those above it
 * inside the home folder, systemd's `default.target.wants` (enable creates it), and the Run key
 * with the keys above it below `HKCU\Software\<name>`. Never a folder of the data folder: on macOS
 * install makes `<state>/logs` when launchd needs it, but does not note it, so uninstall leaves it
 * (A2 3.2.1: nothing in the data folder is removed unasked).
 */
function creatable(ctx: ServiceContext): { folders: Set<string>; keys: Set<string> } {
  const folders = new Set<string>();
  const keys = new Set<string>();
  switch (ctx.platform) {
    case "linux":
      for (const folder of folderChain(ctx.roots.unitDir, ctx.home)) folders.add(folder);
      folders.add(join(ctx.roots.unitDir, WANTS));
      break;
    case "darwin":
      for (const folder of folderChain(ctx.roots.launchAgentsDir, ctx.home)) folders.add(folder);
      break;
    case "win32": {
      const run: string = runKeys(ctx.roots.registryRoot).run;
      for (let at = run; KEY_BELOW_SOFTWARE.test(at); at = at.slice(0, at.lastIndexOf("\\"))) {
        keys.add(regKey(at));
      }
      break;
    }
  }
  return { folders, keys };
}

/** The note of this entry, keeping only what install may create; undefined when there is none. */
function readCreated(ctx: ServiceContext): Created | undefined {
  let note: unknown;
  try {
    note = JSON.parse(readFileSync(createdPath(ctx), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof note !== "object" || note === null) return undefined;
  const fields = note as Record<string, unknown>;
  if (fields["format"] !== 1 || fields["entry"] !== entryId(ctx)) return undefined;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const allowed = creatable(ctx);
  return {
    folders: strings(fields["folders"]).filter((folder) => allowed.folders.has(folder)),
    keys: strings(fields["keys"]).filter((key) => allowed.keys.has(regKey(key))),
  };
}

/**
 * Refuses a state folder that fails the service's own rule (permissions.ts): install writes its
 * note there, and the service it sets up would refuse to start in it. The message names the fix.
 */
function refuseUnsafeState(judged: Judged | "unseen" | undefined, so: string): void {
  if (judged === undefined) return;
  if (judged === "unseen") {
    throw new ServiceCommandError(
      "forbidden",
      "unsafe_permissions",
      `${PRODUCT_NAME}'s state folder cannot be looked at, so ${so}.`,
    );
  }
  throw new ServiceCommandError(
    "forbidden",
    "unsafe_permissions",
    unsafeMessage(
      [{ name: `${PRODUCT_NAME}'s state folder`, ...judged }],
      `Whoever can change it could change what ${PRODUCT_NAME} records and runs, so ${so}`,
    ),
  );
}

/** Adds what a step just created to the note. Only what install may create is noted. */
function remember(ctx: ServiceContext, made: Partial<Created>): void {
  const allowed = creatable(ctx);
  const folders = (made.folders ?? []).filter((folder) => allowed.folders.has(folder));
  const keys = (made.keys ?? []).filter((key) => allowed.keys.has(regKey(key)));
  if (folders.length === 0 && keys.length === 0) return;
  const now = readCreated(ctx) ?? { folders: [], keys: [] };
  const note = {
    format: 1,
    entry: entryId(ctx),
    folders: [...new Set([...now.folders, ...folders])],
    keys: [...new Set([...now.keys, ...keys])],
  };
  // Never written into a state folder another user could change (A2 3.2.2 rule 5).
  refuseUnsafeState(
    ensurePrivateDir(ctx.layout.state),
    `${verbFor("install")} does not write its note of what it created there`,
  );
  atomicWrite(createdPath(ctx), `${JSON.stringify(note, null, 2)}\n`);
}

/** The folders of `path` that do not exist yet, deepest first: what `mkdir -p` creates. */
function missingFolders(path: string): string[] {
  const missing: string[] = [];
  for (let at = path; !existsSync(at); at = dirname(at)) {
    missing.push(at);
    if (dirname(at) === at) break;
  }
  return missing;
}

const depth = (path: string, separator: string) => path.split(separator).length;

// ---------------------------------------------------------------------------------------------
// Plans

type Existing = "absent" | "same" | "different";

export type Step =
  | { readonly do: "create-folder"; readonly path: string; readonly private: boolean }
  | {
      readonly do: "write-file";
      readonly path: string;
      readonly text: string;
      readonly existing: Existing;
    }
  | { readonly do: "remove-file"; readonly path: string }
  | { readonly do: "remove-empty-folder"; readonly path: string }
  | {
      readonly do: "set-value";
      readonly key: string;
      readonly name: string;
      readonly data: string;
      readonly existing: Existing;
      /** The keys that do not exist yet, deepest first: the write creates them. */
      readonly creates: readonly string[];
    }
  | {
      readonly do: "remove-value";
      readonly key: string;
      readonly name: string;
      readonly record: "entry" | "startup-approved";
    }
  | { readonly do: "remove-empty-key"; readonly key: string }
  | { readonly do: "forget-created"; readonly path: string }
  | {
      readonly do: "run";
      readonly file: string;
      readonly args: readonly string[];
      /** A folder the tool creates when it is missing (`systemctl enable`'s default.target.wants). */
      readonly creates?: string;
    }
  | { readonly do: "start" }
  | { readonly do: "stop" };

export interface Plan {
  readonly verb: "install" | "uninstall";
  readonly entry: EntryInfo;
  readonly steps: readonly Step[];
  /** What a person should know before saying yes: linger, Task Manager's choice, the note. */
  readonly notes: readonly string[];
  /** What the plan saw at the entry. Every step that touches it checks it (applyPlan). */
  readonly observed: Observed;
}

/**
 * Refusals before anything is read or changed (A2 3.5 rule 4, 3.6.5; A6 3.16.1): root; an agent's
 * shell for a command that changes whether and how the service runs (`operator`); an elevated or
 * uncheckable token and package identity for one that writes an OS entry (`entry`).
 */
function refuseIdentity(
  ctx: ServiceContext,
  verb: string,
  checks: { readonly operator?: boolean; readonly entry?: boolean },
): void {
  const identity = ctx.identity();
  const elevated = checks.entry === true;
  if (identity.root) {
    throw new ServiceCommandError(
      "forbidden",
      "root",
      `${verbFor(verb)} does not run as root: ${PRODUCT_NAME}'s service is a per-user service.`,
    );
  }
  if (checks.operator === true && ctx.agentShell) {
    throw new ServiceCommandError(
      "forbidden",
      "agent_shell",
      `${verbFor(verb)} is not run from an agent's shell: it changes whether and how ${PRODUCT_NAME}'s service runs. Run it in your own terminal.`,
    );
  }
  if (elevated && ctx.platform === "win32" && identity.elevated !== false) {
    throw new ServiceCommandError(
      "forbidden",
      identity.elevated === undefined ? "elevation_unknown" : "elevated",
      identity.elevated === undefined
        ? `${verbFor(verb)} could not check whether it runs elevated, so it changes nothing.`
        : `${verbFor(verb)} does not run as administrator. Run it in a normal terminal.`,
    );
  }
  if (elevated && identity.package !== null) {
    throw new ServiceCommandError(
      "forbidden",
      "packaged",
      `${verbFor(verb)} cannot run inside another app's package. Run it in a normal terminal, not from inside another app.`,
    );
  }
}

function needProgram(ctx: ServiceContext): void {
  if (!existsSync(ctx.program)) {
    throw new ServiceCommandError(
      "not_found",
      "no_build",
      `No ${PRODUCT_NAME} build at ${ctx.program}. Install ${PRODUCT_NAME} first.`,
    );
  }
}

const FOREIGN: Readonly<Record<NotOurs, string>> = {
  unusual_text: `holds what ${CLI_NAME} service install never writes (a control character such as NUL, a carriage return or a tab, text that is not UTF-8, or an unusual size), so it is not read as ours`,
  not_ours: `belongs to something else: it does not start ${PRODUCT_NAME} the way ${CLI_NAME} service install writes it`,
  names_other_units:
    "names other units in its [Install] section (Also=), so systemctl would enable or disable them too",
  other_settings: `has settings that ${CLI_NAME} service install does not write, so it is someone's own now`,
  overridden:
    "is changed by drop-in files (a .d folder beside it), so what it does is not only what it says",
  not_a_file: "is a link or a folder, not a file this command writes",
};

const entryName = (entry: EntryInfo): string =>
  `${entry.where}${entry.kind === "run-value" ? `, value "${entry.name}"` : ""}`;

function refuseForeign(entry: EntryInfo, verb: string): void {
  if (entry.state !== "foreign") return;
  throw new ServiceCommandError(
    "conflict",
    "entry_conflict",
    `${entryName(entry)} ${FOREIGN[entry.why ?? "not_ours"]}. ${verbFor(verb)} leaves it as it is.`,
    "Remove or rename it yourself if it is not needed, then run the command again.",
  );
}

const SYSTEMCTL = "systemctl";
const LOGINCTL = "loginctl";
const LAUNCHCTL = "launchctl";

type RunStep = Extract<Step, { readonly do: "run" }>;

const systemctl = (...args: string[]): RunStep => ({
  do: "run",
  file: SYSTEMCTL,
  args: ["--user", ...args],
});
const launchctl = (...args: string[]): RunStep => ({ do: "run", file: LAUNCHCTL, args });

/**
 * Whether a systemd user manager answers (some WSL setups and containers have none). `call` runs
 * the tool; start passes one bounded by its deadline, which throws rather than answer "none".
 */
export async function userManager(ctx: ServiceContext, call: Runner = ctx.run): Promise<boolean> {
  const result = await call(SYSTEMCTL, ["--user", "show", "--property=Version"]);
  return result.code === 0;
}

/** loginctl's Linger for this user: read only. Tasks never enables it (A2 3.3.3). */
export async function linger(ctx: ServiceContext): Promise<"yes" | "no" | "unknown"> {
  if (ctx.uid === undefined) return "unknown";
  const result = await ctx.run(LOGINCTL, [
    "show-user",
    String(ctx.uid),
    "--property=Linger",
    "--value",
  ]);
  const value = result.stdout.trim();
  return result.code === 0 && (value === "yes" || value === "no") ? value : "unknown";
}

const domain = (ctx: ServiceContext) => `gui/${String(ctx.uid ?? 0)}`;
const target = (ctx: ServiceContext) => `${domain(ctx)}/${ctx.names.label}`;

async function launchdLoaded(ctx: ServiceContext): Promise<boolean> {
  return (await ctx.run(LAUNCHCTL, ["print", target(ctx)])).code === 0;
}

function lingerNote(state: "yes" | "no" | "unknown"): string | undefined {
  if (state === "yes") return "Linger is on: the service starts at boot, before you sign in.";
  if (state === "no") {
    return `Linger is off: the service starts when you sign in and stops when you sign out. ${PRODUCT_NAME} does not change that. To start it at boot, you can run: loginctl enable-linger`;
  }
  return undefined;
}

const STARTUP_OFF_NOTE = `${PRODUCT_NAME} is turned off in Startup apps (Task Manager), so Windows does not start it at sign-in. ${CLI_NAME} service install does not change that: turn it on in Task Manager if you want it.`;

const createdNote = (ctx: ServiceContext) =>
  `The folders and keys this creates are noted in ${createdPath(ctx)}, so ${verbFor("uninstall")} removes them again when they are empty.`;

/** The steps of `tasks service install`. Reads only; nothing is written until applyPlan. */
export async function planInstall(ctx: ServiceContext): Promise<Plan> {
  refuseIdentity(ctx, "install", { operator: true, entry: true });
  // Install creates folders and files in this process: a umask that takes away the person's own
  // bits would leave them unusable (A2 3.2.2 rule 5). The service checks its own umask at its
  // start, which a service manager may set differently, so `start` does not judge this shell's.
  const umaskLine = umaskRefusal(
    (ctx.umask ?? (() => readUmask(ctx.platform)))(),
    `${verbFor("install")} changes nothing`,
  );
  if (umaskLine !== undefined) {
    throw new ServiceCommandError("forbidden", "unsafe_umask", umaskLine);
  }
  // A state folder that is there and fails the rule: refused before anything is planned.
  refuseUnsafeState(
    judgePath(ctx.layout.state, "folder", { followLink: true }),
    `${verbFor("install")} changes nothing`,
  );
  needProgram(ctx);
  const wanted = await readEntry(ctx);
  refuseForeign(wanted.info, "install");
  const existing =
    wanted.info.state === "absent" ? "absent" : wanted.info.current ? "same" : "different";
  const steps: Step[] = [];
  const notes: string[] = [];
  let creates = false;
  switch (ctx.platform) {
    case "linux": {
      if (!(await userManager(ctx))) {
        throw new ServiceCommandError(
          "internal",
          "no_user_manager",
          `This machine has no systemd user manager, so nothing would start ${PRODUCT_NAME}'s service at sign-in or boot. Nothing was written.`,
          `${CLI_NAME} service start`,
        );
      }
      if (!existsSync(ctx.roots.unitDir)) {
        steps.push({ do: "create-folder", path: ctx.roots.unitDir, private: false });
        creates = true;
      }
      const wants = join(ctx.roots.unitDir, WANTS);
      const enable = systemctl("enable", ctx.names.unit);
      const wantsMissing = !existsSync(wants);
      steps.push(
        { do: "write-file", path: wanted.info.where, text: wanted.content, existing },
        systemctl("daemon-reload"),
        wantsMissing ? { ...enable, creates: wants } : enable,
        { do: "start" },
      );
      creates ||= wantsMissing;
      const note = lingerNote(await linger(ctx));
      if (note !== undefined) notes.push(note);
      break;
    }
    case "win32": {
      const keys =
        wanted.runKey === false ? await missingKeys(ctx.registry, wanted.info.where) : [];
      steps.push(
        {
          do: "set-value",
          key: wanted.info.where,
          name: wanted.info.name,
          data: wanted.content,
          existing,
          creates: keys,
        },
        { do: "start" },
      );
      creates = keys.length > 0;
      if (wanted.startupApps === "off") notes.push(STARTUP_OFF_NOTE);
      break;
    }
    case "darwin": {
      if (!existsSync(ctx.roots.launchAgentsDir)) {
        steps.push({ do: "create-folder", path: ctx.roots.launchAgentsDir, private: false });
        creates = true;
      }
      // launchd opens the log files before the service runs, so their folder must exist.
      if (!existsSync(ctx.layout.logs)) {
        steps.push({ do: "create-folder", path: ctx.layout.logs, private: true });
        creates = true;
      }
      const loaded = wanted.info.state === "ours" && (await launchdLoaded(ctx));
      if (loaded && existing !== "same") steps.push(launchctl("bootout", target(ctx)));
      steps.push({ do: "write-file", path: wanted.info.where, text: wanted.content, existing });
      if (!loaded || existing !== "same") {
        steps.push(launchctl("bootstrap", domain(ctx), wanted.info.where));
      }
      steps.push({ do: "start" });
      break;
    }
  }
  if (creates) notes.push(createdNote(ctx));
  // Install checks only its entry: Task Manager's record is the person's, and install leaves it.
  // Linux's drop-ins are part of the entry (readEntry).
  const seen = wanted.observed;
  const observed: Observed =
    seen.dropIns === undefined
      ? { entry: seen.entry }
      : { entry: seen.entry, dropIns: seen.dropIns };
  return { verb: "install", entry: wanted.info, steps, notes, observed };
}

/**
 * The steps of `tasks service uninstall`: this install's entry, Task Manager's record of it, and
 * what install noted it created, each folder or key only when empty, deepest first.
 */
export async function planUninstall(ctx: ServiceContext): Promise<Plan> {
  refuseIdentity(ctx, "uninstall", { operator: true, entry: true });
  const wanted = await readEntry(ctx);
  refuseForeign(wanted.info, "uninstall");
  const steps: Step[] = [];
  const present = wanted.info.state === "ours";
  switch (ctx.platform) {
    case "linux": {
      if (!present) break;
      const manager = await userManager(ctx);
      steps.push({ do: "stop" });
      if (manager) steps.push(systemctl("disable", ctx.names.unit));
      steps.push({ do: "remove-file", path: wanted.info.where });
      if (manager) steps.push(systemctl("daemon-reload"));
      break;
    }
    case "win32": {
      const keys = runKeys(ctx.roots.registryRoot);
      if (present) {
        steps.push(
          { do: "stop" },
          { do: "remove-value", key: keys.run, name: wanted.info.name, record: "entry" },
        );
      }
      if (wanted.approvedRecord === true) {
        steps.push({
          do: "remove-value",
          key: keys.approved,
          name: wanted.info.name,
          record: "startup-approved",
        });
      }
      break;
    }
    case "darwin": {
      if (!present) break;
      if (await launchdLoaded(ctx)) steps.push(launchctl("bootout", target(ctx)));
      steps.push({ do: "remove-file", path: wanted.info.where });
      break;
    }
  }
  // The note goes first, so a folder it lies in can go too; a run cut short after it leaves empty
  // folders behind, never removes one install did not create.
  const created = readCreated(ctx);
  if (created !== undefined) {
    const folders = created.folders
      .filter((folder) => existsSync(folder))
      .sort((a, b) => depth(b, sep) - depth(a, sep) || b.localeCompare(a));
    const keys = [...created.keys].sort(
      (a, b) => depth(b, "\\") - depth(a, "\\") || b.localeCompare(a),
    );
    steps.push({ do: "forget-created", path: createdPath(ctx) });
    for (const folder of folders) steps.push({ do: "remove-empty-folder", path: folder });
    for (const key of keys) steps.push({ do: "remove-empty-key", key });
  }
  return { verb: "uninstall", entry: wanted.info, steps, notes: [], observed: wanted.observed };
}

export interface Applied {
  readonly started?: StartOutcome;
  readonly stopped?: StopOutcome;
}

/**
 * Steps that change the entry, or that a manager carries out on it (start and stop included): the
 * entry is read last before each, and again after it. Folder, key and note steps touch no entry.
 */
const ON_ENTRY: ReadonlySet<Step["do"]> = new Set([
  "write-file",
  "remove-file",
  "set-value",
  "remove-value",
  "run",
  "start",
  "stop",
]);

const carriedOut = (upTo: number): string =>
  upTo < 1
    ? ""
    : upTo === 1
      ? " Step 1 was carried out."
      : ` Steps 1 to ${String(upTo)} were carried out.`;

/**
 * The entry was not what the plan expects at step `n`: `before` the step began, `during` it after
 * part of it was done, or `after` it, when it is not what the step left. Exit 4.
 */
function changed(
  plan: Plan,
  n: number,
  when: "before" | "after" | { readonly during: string },
): ServiceCommandError {
  const where = entryName(plan.entry);
  const verb = verbFor(plan.verb);
  const step = String(n);
  const message =
    when === "before"
      ? `${where} changed after the preview was shown, so ${verb} stopped before step ${step} and changed nothing more.${carriedOut(n - 1)}`
      : when === "after"
        ? `${where} changed while ${verb} was running: after step ${step} it is not what that step left there. ${verb} stopped and did not go on.${carriedOut(n)}`
        : `${where} changed while ${verb} was running, so it stopped during step ${step}, after ${when.during}, and did nothing more.${carriedOut(n - 1)}`;
  return new ServiceCommandError(
    "conflict",
    "entry_changed",
    message,
    `${verb}, to see what it would do now`,
  );
}

/**
 * A plan's start or stop step: `check` reads the entry last before each action of the step and
 * throws entry_changed when it is not the one the plan expects. `done` says what of the step has
 * happened already; `timeoutMs` bounds the read.
 */
export interface EntryGuard {
  readonly check: (done: string | undefined, timeoutMs?: number) => Promise<void>;
}

function guardFor(ctx: ServiceContext, plan: Plan, expected: Observed, n: number): EntryGuard {
  return {
    check: async (done, timeoutMs) => {
      const now = await observe(ctx, expected, "entry", timeoutMs);
      if (!sameEntry(now, expected)) {
        throw changed(plan, n, done === undefined ? "before" : { during: done });
      }
    },
  };
}

/** A guard's check within `timeoutMs`; a registry read that runs out of it throws `late()`. */
async function checkWithin(
  guard: EntryGuard | undefined,
  done: string | undefined,
  timeoutMs: number,
  late: () => ServiceCommandError,
): Promise<void> {
  if (guard === undefined) return;
  try {
    await guard.check(done, timeoutMs);
  } catch (error) {
    if (error instanceof RegistryTimeoutError) throw late();
    throw error;
  }
}

/** An entry file (a unit, a plist): 0644, as its manager expects, whatever the umask. */
const ENTRY_FILE_MODE = 0o644;
/** A service manager's folder Tasks creates for its entry. */
const ENTRY_FOLDER_MODE = 0o755;

/**
 * Writes a new entry file, created exclusively: anything that appeared at the path since the plan
 * looked (a file, a link, a folder) stops the step instead of being replaced.
 */
function createEntryFile(path: string, text: string, changedError: () => Error): void {
  let fd: number;
  try {
    fd = createFile(path, ENTRY_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw changedError();
    throw error;
  }
  try {
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

/**
 * Replaces an entry file: the new text goes to a temporary file beside it, then the file at the
 * path is read once more and compared, byte for byte, with what the plan expects there, and only
 * then is the temporary file renamed over it. Between that comparison and the rename nothing is
 * awaited: both are calls of this thread, microseconds apart.
 */
function replaceEntryFile(
  path: string,
  text: string,
  expected: string,
  changedError: () => Error,
): void {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const fd = createFile(temp, ENTRY_FILE_MODE);
  try {
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (fileMark(readFound(path)) !== expected) throw changedError();
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Removes an entry file after a last byte-for-byte comparison with what the plan expects. */
function removeEntryFile(path: string, expected: string, changedError: () => Error): void {
  if (fileMark(readFound(path)) !== expected) throw changedError();
  // unlink removes a file, never what a link points to, and never a folder.
  unlinkSync(path);
}

/**
 * Carries out a plan's steps in order. For each step that touches the entry: first whatever else
 * the step needs is read, then the entry, last, and it must be what the plan expects (the preview,
 * changed only by the plan's own steps before); then the step acts; then the entry is read again
 * and must be what the step left. A difference stops the run with exit 4 (`entry_changed`), saying
 * which steps were carried out. A failed step stops it with an error naming the step.
 */
export async function applyPlan(ctx: ServiceContext, plan: Plan): Promise<Applied> {
  let started: StartOutcome | undefined;
  let stopped: StopOutcome | undefined;
  let expected: Observed = plan.observed;
  for (const [index, step] of plan.steps.entries()) {
    const n = index + 1;
    const last =
      step.do === "remove-value" && step.record === "startup-approved" ? "approved" : "entry";
    // 1. What else the step needs to know, read before the entry.
    const keysMissing =
      step.do === "set-value" && step.existing === "absent"
        ? await missingKeys(ctx.registry, step.key)
        : [];
    const toolCreates =
      step.do === "run" && step.creates !== undefined && !existsSync(step.creates)
        ? step.creates
        : undefined;
    // 2. The entry, read last before the step acts.
    if (ON_ENTRY.has(step.do) && !sameEntry(await observe(ctx, expected, last), expected)) {
      throw changed(plan, n, "before");
    }
    const changedBefore = () => changed(plan, n, "before");
    // 3. The step.
    switch (step.do) {
      case "create-folder": {
        const made = missingFolders(step.path);
        // The service manager's own folders (the systemd unit folder, LaunchAgents) are 0755 as
        // their managers make them; the state's are user-only. Exactly so, whatever the umask.
        if (step.private) ensurePrivateDir(step.path);
        else makeDir(step.path, ENTRY_FOLDER_MODE);
        remember(ctx, { folders: made });
        break;
      }
      case "write-file":
        if (step.existing === "absent") createEntryFile(step.path, step.text, changedBefore);
        else if (step.existing === "different") {
          replaceEntryFile(step.path, step.text, expected.entry, changedBefore);
        }
        expected = {
          ...expected,
          entry: fileMark({ kind: "file", bytes: Buffer.from(step.text, "utf8") }),
        };
        break;
      case "remove-file":
        removeEntryFile(step.path, expected.entry, changedBefore);
        expected = { ...expected, entry: "absent" };
        break;
      case "remove-empty-folder":
        try {
          rmdirSync(step.path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            code !== "ENOENT" &&
            code !== "ENOTEMPTY" &&
            code !== "EEXIST" &&
            code !== "ENOTDIR"
          ) {
            throw error;
          }
        }
        break;
      case "set-value":
        if (step.existing !== "same") {
          await ctx.registry.setString(step.key, step.name, step.data);
          remember(ctx, { keys: keysMissing });
        }
        expected = { ...expected, entry: `REG_SZ\n${step.data}` };
        break;
      case "remove-value":
        await ctx.registry.remove(step.key, step.name);
        expected =
          step.record === "entry"
            ? { ...expected, entry: "absent" }
            : { ...expected, approved: "absent" };
        break;
      case "remove-empty-key":
        await ctx.registry.removeEmptyKey(step.key);
        break;
      case "forget-created":
        rmSync(step.path, { force: true });
        break;
      case "run": {
        const result = await ctx.run(step.file, step.args);
        if (result.code !== 0) {
          throw new ServiceCommandError(
            "internal",
            "tool_failed",
            `${[step.file, ...step.args].join(" ")} failed (${result.failure ?? `exit ${String(result.code)}`}).`,
            plan.verb === "install" ? `${CLI_NAME} service uninstall` : undefined,
          );
        }
        if (toolCreates !== undefined && existsSync(toolCreates)) {
          remember(ctx, { folders: [toolCreates] });
        }
        break;
      }
      case "start":
        started = await startService(ctx, guardFor(ctx, plan, expected, n));
        break;
      case "stop":
        stopped = await stopService(ctx, guardFor(ctx, plan, expected, n));
        break;
    }
    // 4. The entry again: what the step left there, or the run stops here.
    if (ON_ENTRY.has(step.do) && !sameEntry(await observe(ctx, expected, last), expected)) {
      throw changed(plan, n, "after");
    }
  }
  return {
    ...(started === undefined ? {} : { started }),
    ...(stopped === undefined ? {} : { stopped }),
  };
}

// ---------------------------------------------------------------------------------------------
// start and stop

export interface StartOutcome {
  readonly outcome: "started" | "already_running";
  /** How it was started: the manager, Explorer, or a direct start. */
  readonly via: "systemd" | "launchd" | "explorer" | "direct" | "manual" | "none";
  readonly status: ServiceStatus;
}

export interface StopOutcome {
  readonly outcome: "stopped" | "not_running";
  readonly via: "systemd" | "launchd" | "shutdown" | "none";
}

/**
 * One running service: its process and the start of it that service.json and status name, with
 * the process's start time where the OS gives one (ServiceContext.processStart).
 */
interface Instance {
  readonly pid: number;
  readonly instance: string;
  readonly started?: string;
}

function identify(ctx: ServiceContext, pid: number, instance: string): Instance {
  const started = ctx.processStart(pid);
  return started === undefined ? { pid, instance } : { pid, instance, started };
}

/** The service this install's service.json names while it still runs (liveRecord), or undefined. */
function recorded(ctx: ServiceContext): Instance | undefined {
  const record = ctx.record();
  return record !== undefined && record.installId === ctx.installId && liveRecord(record, ctx.alive)
    ? identify(ctx, record.pid, record.instance)
    : undefined;
}

/**
 * Whether a process has ended: its PID is gone, or, where the OS gives a start time, the PID now
 * names a process that started at another time. Without a start time a PID reused within the wait
 * keeps it going until it runs out (exit 6): the safe side.
 */
function ended(ctx: ServiceContext, running: Instance): boolean {
  if (!ctx.alive(running.pid)) return true;
  return running.started !== undefined && ctx.processStart(running.pid) !== running.started;
}

/**
 * Waits until each process has ended. Nothing less counts: service.json going away or changing
 * does not prove a process ended, and the drain releases the lock only at its very end.
 */
async function waitEnded(
  ctx: ServiceContext,
  processes: readonly Instance[],
  deadline: number,
): Promise<boolean> {
  for (;;) {
    if (processes.every((p) => ended(ctx, p))) return true;
    if (Date.now() >= deadline) return false;
    await ctx.sleep(Math.max(0, Math.min(ctx.pollMs, deadline - Date.now())));
  }
}

/**
 * Runs tools within what is left before `deadline()`: each gets only that time (at most a tool's
 * usual bound), and one that has no time left or runs out of it throws `late()` instead of
 * returning, so a timed-out question to the user manager or tasklist never reads as "none".
 */
function bounded(
  ctx: ServiceContext,
  deadline: () => number,
  late: () => ServiceCommandError,
): Runner {
  return async (file, args, options = {}) => {
    const left = deadline() - Date.now();
    if (left <= 0) throw late();
    const result = await ctx.run(file, args, {
      ...options,
      timeoutMs: Math.min(left, TOOL_TIMEOUT_MS),
    });
    if (result.failure === "ETIMEDOUT") throw late();
    return result;
  };
}

const VERSION_TEXT = {
  restart_session: `${PRODUCT_NAME}'s service runs a newer version than this ${CLI_NAME} command, so the command cannot talk to it. Use the ${CLI_NAME} command of the installed version.`,
  service_too_old: `A newer ${PRODUCT_NAME} is installed than the running service, so this command cannot talk to it. Restart the service (on Windows: sign out and in again).`,
} as const;

/** A probe that met a service of another protocol (A2 3.6.6): exit 7, the CLI's version class. */
function refuseVersion(probe: Probe): void {
  if (probe.answers) return;
  if (probe.reason === "restart_session" || probe.reason === "service_too_old") {
    throw new ServiceCommandError("version", probe.reason, VERSION_TEXT[probe.reason]);
  }
}

/** A service that runs but that this command cannot reach: exit 6 with the reason. */
function unreachable(probe: Probe): ServiceCommandError {
  const reason = probe.answers ? "unreachable" : probe.reason;
  return new ServiceCommandError(
    "service",
    "service_unavailable",
    `${PRODUCT_NAME}'s service runs, but this command cannot reach it (${reason}).`,
    `${CLI_NAME} service status`,
  );
}

/**
 * Probes until the service answers ready, or the deadline passed. Each probe gets only the time
 * that is left, so the wait ends at the deadline (A2 3.3.5).
 */
async function waitReady(
  ctx: ServiceContext,
  deadline: number,
): Promise<ServiceStatus | undefined> {
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    const probe = await ctx.probe(left);
    if (probe.answers && probe.status.state === "ready") return probe.status;
    refuseVersion(probe);
    if (Date.now() >= deadline) return undefined;
    await ctx.sleep(Math.max(0, Math.min(ctx.pollMs, deadline - Date.now())));
  }
}

/** Probes while the service is starting without an endpoint yet (A2 3.3.6), until the deadline. */
async function waitAnswer(ctx: ServiceContext, deadline: number): Promise<Probe> {
  for (;;) {
    const probe = await ctx.probe(Math.max(1, deadline - Date.now()));
    if (probe.answers || probe.reason !== "starting" || Date.now() >= deadline) return probe;
    await ctx.sleep(Math.max(0, Math.min(ctx.pollMs, deadline - Date.now())));
  }
}

/** The fields of tasklist's CSV rows: "image","pid","session name","session#","memory". */
const csvRows = (text: string): string[][] =>
  text
    .split(/\r?\n/)
    .map((line) => [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? ""))
    .filter((fields) => fields.length >= 4);

/**
 * Whether Explorer runs in this process's session, so `explorer.exe <program>` starts the program
 * as the Run value does at sign-in (A2 3.5 rule 5). Session 0 (services, SSH) has none. `call`
 * runs tasklist; start passes one bounded by its deadline.
 */
export async function explorerInSession(
  ctx: ServiceContext,
  call: Runner = ctx.run,
): Promise<boolean> {
  const tools = ctx.windows;
  if (tools === undefined) return false;
  const own = await call(tools.tasklist, [
    "/FO",
    "CSV",
    "/NH",
    "/FI",
    `PID eq ${String(process.pid)}`,
  ]);
  const session = csvRows(own.stdout).find((row) => row[1] === String(process.pid))?.[3];
  if (session === undefined || !/^\d+$/.test(session) || session === "0") return false;
  const shells = await call(tools.tasklist, [
    "/FO",
    "CSV",
    "/NH",
    "/FI",
    "IMAGENAME eq explorer.exe",
  ]);
  return csvRows(shells.stdout).some(
    (row) => row[0]?.toLowerCase() === "explorer.exe" && row[3] === session,
  );
}

function notReady(seconds: number): ServiceCommandError {
  return new ServiceCommandError(
    "service",
    "service_unavailable",
    `${PRODUCT_NAME}'s service did not become ready within ${String(seconds)} s.`,
    `${CLI_NAME} service status`,
  );
}

/** start's time ran out before the step that starts the service: it was not started. */
function notStartedInTime(seconds: number): ServiceCommandError {
  return new ServiceCommandError(
    "service",
    "service_unavailable",
    `${PRODUCT_NAME}'s service was not started: the ${String(seconds)} s of ${verbFor("start")} ran out before it could be started.`,
    `${CLI_NAME} service status`,
  );
}

function notInstalled(): ServiceCommandError {
  return new ServiceCommandError(
    "not_found",
    "not_installed",
    `${PRODUCT_NAME}'s service is not installed for this install.`,
    `${CLI_NAME} service install`,
  );
}

function stillRunning(ctx: ServiceContext, what: string): ServiceCommandError {
  return new ServiceCommandError(
    "service",
    "service_still_running",
    `${PRODUCT_NAME}'s service ${what} within ${String(Math.round(ctx.stopTimeoutMs / 1000))} s.`,
    `${CLI_NAME} service status`,
  );
}

/**
 * `tasks service start` (A2 3.3.5): through the OS, then up to 15 s (20 s on Windows) for a ready
 * service that completes a handshake. It succeeds only with a ready service. One of this install
 * that is already ready is left as it is, one that is starting is waited for, and one that is
 * stopping is let end first, so a second service never starts only to exit 73.
 *
 * Every tool and probe gets only the time left, and the step that starts the service runs only
 * with time left. As a plan's step, `guard` reads the entry last before that step: a changed entry
 * is not started (exit 4).
 */
export async function startService(ctx: ServiceContext, guard?: EntryGuard): Promise<StartOutcome> {
  refuseIdentity(ctx, "start", {});
  // One deadline for the command: the first probe, a wait for a service already starting, the
  // start and the wait for ready. A wait for a draining service has its own bound (stop's) and then
  // starts the deadline again, since the new service's start begins only after it.
  let deadline = Date.now() + ctx.readyTimeoutMs;
  const seconds = Math.round(ctx.readyTimeoutMs / 1000);
  const call = bounded(
    ctx,
    () => deadline,
    () => notStartedInTime(seconds),
  );
  // A start that runs out of time may still have started it: then it did not become ready in time.
  const launch = bounded(
    ctx,
    () => deadline,
    () => notReady(seconds),
  );
  /** Right before the step that starts the service: time left, and the entry the plan expects. */
  const ready = async () => {
    const left = deadline - Date.now();
    if (left <= 0) throw notStartedInTime(seconds);
    await checkWithin(guard, undefined, left, () => notStartedInTime(seconds));
    if (Date.now() >= deadline) throw notStartedInTime(seconds);
  };
  const before = await ctx.probe(ctx.readyTimeoutMs);
  refuseVersion(before);
  if (before.answers && before.status.state === "ready") {
    return { outcome: "already_running", via: "none", status: before.status };
  }
  if (before.answers ? before.status.state === "starting" : before.reason === "starting") {
    const status = await waitReady(ctx, deadline);
    if (status === undefined) throw notReady(seconds);
    return { outcome: "already_running", via: "none", status };
  }
  const stopping = before.answers
    ? identify(ctx, before.status.pid, before.status.instance)
    : before.reason === "stopping"
      ? recorded(ctx)
      : undefined;
  if (stopping !== undefined) {
    if (!(await waitEnded(ctx, [stopping], Date.now() + ctx.stopTimeoutMs))) {
      throw stillRunning(ctx, "was stopping and did not end");
    }
    deadline = Date.now() + ctx.readyTimeoutMs;
  } else if (!before.answers && before.reason !== "not_running" && recorded(ctx) !== undefined) {
    // It runs, but this command cannot reach it: a second one would only exit 73.
    throw unreachable(before);
  }
  let via: StartOutcome["via"];
  switch (ctx.platform) {
    case "linux": {
      if (await userManager(ctx, call)) {
        if ((await readEntry(ctx)).info.state !== "ours") throw notInstalled();
        await ready();
        const result = await launch(SYSTEMCTL, ["--user", "start", ctx.names.unit]);
        if (result.code !== 0) {
          throw new ServiceCommandError(
            "internal",
            "tool_failed",
            `systemctl --user start ${ctx.names.unit} failed (${result.failure ?? `exit ${String(result.code)}`}).`,
            `journalctl --user -u ${ctx.names.unit}`,
          );
        }
        via = "systemd";
      } else {
        // No user manager (A2 3.3.3): a detached service in its own session; nothing restarts it.
        needProgram(ctx);
        await ready();
        ctx.startDetached(ctx.program, ["serve"]);
        via = "manual";
      }
      break;
    }
    case "win32": {
      needProgram(ctx);
      if (await explorerInSession(ctx, call)) {
        await ready();
        // Explorer is the parent the Run value has at sign-in: outside any package and any job of
        // this process. explorer.exe hands the start to the running shell and exits at once.
        // Always quoted: explorer.exe splits an unquoted path at its commas and opens a folder
        // window instead (seen on the Windows reference machine). A Windows path holds no quote, so this is exact.
        await launch(ctx.windows?.explorer ?? "explorer.exe", [`"${ctx.program}"`], {
          verbatim: true,
        });
        via = "explorer";
      } else {
        if (ctx.identity().package !== null) {
          throw new ServiceCommandError(
            "forbidden",
            "packaged",
            `${PRODUCT_NAME}'s service cannot be started from inside another app's package without Explorer. Start it from the Start menu or a normal terminal.`,
          );
        }
        await ready();
        ctx.startDetached(ctx.program, []);
        via = "direct";
      }
      break;
    }
    case "darwin": {
      if ((await readEntry(ctx)).info.state !== "ours") throw notInstalled();
      await ready();
      if ((await launch(LAUNCHCTL, ["kickstart", target(ctx)])).code !== 0) {
        // Not loaded (booted out by hand): load it, which starts it (RunAtLoad).
        await ready();
        const loaded = await launch(LAUNCHCTL, ["bootstrap", domain(ctx), plistPath(ctx)]);
        if (loaded.code !== 0) {
          throw new ServiceCommandError(
            "internal",
            "tool_failed",
            `launchctl could not start ${ctx.names.label} (exit ${String(loaded.code)}).`,
          );
        }
      }
      via = "launchd";
      break;
    }
  }
  const status = await waitReady(ctx, deadline);
  if (status === undefined) throw notReady(seconds);
  return { outcome: "started", via, status };
}

const SYSTEMD_RUNNING = new Set(["active", "activating", "reloading", "deactivating"]);

/**
 * `tasks service stop` (A2 3.3.5): through the manager where one runs it (systemctl stop,
 * launchctl kill TERM), else `service/shutdown {restart: false}` over the endpoint, which every
 * manager treats as a clean stop that it does not restart. A service still starting is waited for
 * until it can be asked (A2 3.3.6). Then it waits until the service's process has ended, not only
 * its endpoint: a drain closes the endpoint first, removes service.json and exits last.
 *
 * The process to wait for is taken before anything is asked to stop, with its start time where
 * the OS gives one, so a record that goes away during the stop cannot hide a process that still
 * runs. Every tool and probe gets only the time left. As a plan's step, `guard` reads the entry
 * last before each request to stop: a changed entry is not stopped (exit 4).
 */
export async function stopService(ctx: ServiceContext, guard?: EntryGuard): Promise<StopOutcome> {
  refuseIdentity(ctx, "stop", { operator: true });
  const deadline = Date.now() + ctx.stopTimeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  const late = () => stillRunning(ctx, "did not stop");
  const call = bounded(ctx, () => deadline, late);
  const check = (done?: string) => checkWithin(guard, done, left(), late);
  const before = recorded(ctx);
  let via: StopOutcome["via"] = "none";
  let done: string | undefined;
  if (ctx.platform === "linux" && (await readEntry(ctx)).info.state === "ours") {
    const active = await call(SYSTEMCTL, ["--user", "is-active", ctx.names.unit]);
    if (SYSTEMD_RUNNING.has(active.stdout.trim())) {
      await check();
      const result = await call(SYSTEMCTL, ["--user", "stop", ctx.names.unit]);
      if (result.code !== 0) {
        throw new ServiceCommandError(
          "internal",
          "tool_failed",
          `systemctl --user stop ${ctx.names.unit} failed (exit ${String(result.code)}).`,
        );
      }
      via = "systemd";
      done = `systemctl --user stop ${ctx.names.unit} ran`;
    }
  }
  if (ctx.platform === "darwin" && (await readEntry(ctx)).info.state === "ours") {
    await check();
    if ((await call(LAUNCHCTL, ["kill", "TERM", target(ctx)])).code === 0) {
      via = "launchd";
      done = `launchctl kill TERM ${target(ctx)} ran`;
    }
  }
  // A service the manager did not run (started by hand) still answers: ask it to stop. One that is
  // still starting has no endpoint yet: wait until it can be asked.
  let probe = await ctx.probe(left());
  if (!probe.answers && probe.reason === "starting") probe = await waitAnswer(ctx, deadline);
  // The processes to wait for: the one the manager was asked to stop, the one that answers.
  const ending: Instance[] = via !== "none" && before !== undefined ? [before] : [];
  if (probe.answers) {
    ending.push(identify(ctx, probe.status.pid, probe.status.instance));
    await check(done);
    const asked = await ctx.shutdown(left());
    if (asked === "forbidden") {
      throw new ServiceCommandError(
        "forbidden",
        "forbidden",
        `An agent's shell cannot stop ${PRODUCT_NAME}'s service. Run ${CLI_NAME} service stop in your own terminal.`,
      );
    }
    if (asked === "stopping") via = "shutdown";
  } else if (probe.reason === "stopping" || probe.reason === "starting" || via !== "none") {
    // Already draining, still starting past the deadline, or stopped by its manager just now. A
    // record that went away meanwhile leaves the one taken before.
    const now = recorded(ctx) ?? (via === "none" ? before : undefined);
    if (now !== undefined) ending.push(now);
  } else if (probe.reason !== "not_running" && probe.reason !== "other_install") {
    refuseVersion(probe);
    if (recorded(ctx) !== undefined) throw unreachable(probe);
  }
  const processes = ending.filter((p, i) => ending.findIndex((q) => q.pid === p.pid) === i);
  if (processes.length === 0) {
    // No process of the service was seen. A manager that was asked stopped what it ran.
    return via === "none" ? { outcome: "not_running", via } : { outcome: "stopped", via };
  }
  if (!(await waitEnded(ctx, processes, deadline))) throw late();
  return { outcome: "stopped", via };
}

// ---------------------------------------------------------------------------------------------
// status

export type Autostart =
  | {
      readonly kind: "systemd";
      readonly user_manager: boolean;
      /** `systemctl --user is-enabled` and `is-active` for the unit, as systemd words them. */
      readonly enabled: string | null;
      readonly active: string | null;
      readonly linger: "yes" | "no" | "unknown";
    }
  | { readonly kind: "run"; readonly startup_apps: StartupApps }
  | { readonly kind: "launchd"; readonly loaded: boolean };

export type ServiceAnswer =
  | {
      readonly answers: true;
      readonly state: ServiceStatus["state"];
      readonly pid: number;
      readonly instance: string;
      readonly version: string;
      readonly build: string;
      readonly manager: string;
      readonly uptime_ms: number;
      readonly endpoint: "unix" | "pipe" | null;
      /** The spaces as the service reports them (A2 3.3.5). */
      readonly spaces: ServiceStatus["spaces"];
      /** The UI's listener (A2 3.8.2): its port, whether it moved or is blocked; null: none. */
      readonly http: NonNullable<ServiceStatus["http"]> | null;
    }
  | { readonly answers: false; readonly reason: ProbeReason };

export interface StatusReport {
  readonly install_id: string;
  /** TASKS_HOME of a separate install, else null. */
  readonly tasks_home: string | null;
  readonly platform: string;
  readonly program: string;
  readonly program_present: boolean;
  readonly entry: EntryInfo;
  readonly autostart: Autostart;
  readonly service: ServiceAnswer;
}

const answer = (probe: Probe): ServiceAnswer =>
  probe.answers
    ? {
        answers: true,
        state: probe.status.state,
        pid: probe.status.pid,
        instance: probe.status.instance,
        version: probe.status.version,
        build: probe.status.build,
        manager: probe.status.manager,
        uptime_ms: probe.status.uptime_ms,
        endpoint: probe.status.endpoint?.kind ?? null,
        spaces: probe.status.spaces,
        http: probe.status.http ?? null,
      }
    : { answers: false, reason: probe.reason };

const word = (text: string): string | null => {
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return /^[a-z-]{1,32}$/.test(line) ? line : null;
};

/** `tasks service status`: reads and reports, and changes nothing. */
export async function serviceStatus(ctx: ServiceContext): Promise<StatusReport> {
  const wanted = await readEntry(ctx);
  let autostart: Autostart;
  switch (ctx.platform) {
    case "linux": {
      const manager = await userManager(ctx);
      const ask = async (verb: string) =>
        manager ? word((await ctx.run(SYSTEMCTL, ["--user", verb, ctx.names.unit])).stdout) : null;
      autostart = {
        kind: "systemd",
        user_manager: manager,
        enabled: await ask("is-enabled"),
        active: await ask("is-active"),
        linger: await linger(ctx),
      };
      break;
    }
    case "win32":
      autostart = { kind: "run", startup_apps: wanted.startupApps ?? "not_set" };
      break;
    case "darwin":
      autostart = { kind: "launchd", loaded: await launchdLoaded(ctx) };
      break;
  }
  return {
    install_id: ctx.installId,
    tasks_home: ctx.layout.home ?? null,
    platform: ctx.platform,
    program: ctx.program,
    program_present: existsSync(ctx.program),
    entry: wanted.info,
    autostart,
    service: answer(await ctx.probe()),
  };
}
