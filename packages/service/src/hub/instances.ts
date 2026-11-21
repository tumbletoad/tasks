// `ttasks setup instances` (A4 3.2 "Detection proposes, the user confirms"): the service's side, as
// rpc methods registered in the handler table (endpoint.ts), like `roots/*`.
//
//   instances/add     [[instance]] entries the person confirmed, live at once     (the user only)
//   instances/remove  the entries instances/add wrote, each only while it is still
//                     exactly as written                                          (the user only)
//
// Detection runs in the CLI, in the person's session, because the agents' commands must be the
// ones on the person's PATH (A3 3.13.1); the CLI sends the entries the person saw in its preview.
// The service writes them, because every edit of machine.toml but the first start's port is a
// user-only operation in the service under `service.lock` (A2 3.2.4). The method table lets only
// `cli-interactive` call them and each handler checks the class again.
//
// The edit is machine.toml's own splice editor (config/edit.ts): an `append` per entry, every other
// byte kept, and the folder and file judged as the service judges them (a link or a file another
// user can change is refused). An entry is written only when the reader takes it back whole: one it
// would drop is refused before anything is written. What was written is recorded first in
// `<state>/instances.json`, so `instances/remove` takes back only an element setup wrote, and only
// while it is byte for byte what was written (`remove` of the editor). An element the person
// changed is left, and so is every [[instance]] setup did not write.
//
// Every call ends, whether it succeeded or failed, by setting the service's instances to those
// machine.toml holds then, read as at start (`follow`; reloading the rest of machine.toml is not
// built, A2 3.2.4): what Open offers is always what the file holds, also after a write whose
// bookkeeping failed, and a retry ends consistent. Open offers them at the page's next snapshot.
// Nothing in any agent app changes here: registering TTasks's tools in an agent home is `ttasks setup
// agents`.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@ttasks/bridge/protocol";
import { AppError } from "@ttasks/contracts";
import { INSTANCE_ID, isTable, MANUAL_INSTANCE, type Instance } from "@ttasks/launch";
import { commitEdit, prepareEdit, type EditRefusal, type EditValue } from "../config/edit.ts";
import { loadMachineConfig, parseMachineConfig } from "../config/machine-toml.ts";
import { BOM, parseToml } from "../config/toml.ts";
import type { ConnectionClass } from "../local/index.ts";
import { isUserClass } from "../ops/index.ts";
import { atomicWrite } from "./files.ts";
import type { Logger } from "./log.ts";

/** What the instance verbs need from the hub. */
export interface InstancesHost {
  /** The folder of machine.toml. */
  readonly configDir: string;
  /** The state folder, which holds `instances.json`. */
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly log: Logger;
  /** Replaces them, after an edit. */
  set(instances: readonly Instance[]): void;
}

type Verb = (params: JsonObject, cls: ConnectionClass) => Promise<unknown>;

/** The record of what `instances/add` wrote. */
export const INSTANCES_RECORD = "instances.json";
const RECORD_FORMAT = 1;
const MAX_RECORD_BYTES = 1024 * 1024;
/** At most this many entries in one add: a machine has a handful of agent homes. */
const MAX_ENTRIES = 16;

/** The targets detection proposes an instance for and this command writes. */
const TARGETS = ["claude-cli", "codex-cli", "t3"] as const;

/** The keys an entry may have, in the order they are written (A4 3.2, detect.ts instanceEntry). */
const KEYS = [
  "id",
  "target",
  "label",
  "account",
  "exec",
  "args_prefix",
  "config_home",
  "env",
  "t3_environment",
  "t3_provider_instance",
  "t3_model",
  "remote_allowed",
] as const;

/** The T3 keys, which only a T3 entry has (the reader's rule too, sections.ts). */
const T3_KEYS = ["t3_environment", "t3_provider_instance", "t3_model"] as const;

interface Recorded {
  readonly id: string;
  /** The entry as written, keys in their order. */
  readonly entries: readonly (readonly [string, EditValue])[];
  readonly at: string;
}

const invalid = (path: string, message: string, hint?: string): AppError =>
  new AppError({
    code: "invalid_input",
    message: `${message}.`,
    ...(hint === undefined ? {} : { hint }),
    data: { issues: [{ path, message }] },
  });

function userOnly(cls: ConnectionClass): void {
  if (!isUserClass(cls)) {
    throw new AppError({
      code: "forbidden",
      message: "Only the user can do this.",
      hint: "Ask the user to run: ttasks setup instances",
      data: { rule: "user_only" },
    });
  }
}

/** An edit's refusal as the body a person reads. Never a value from the file. */
function editRefused(reason: EditRefusal): AppError {
  switch (reason) {
    case "changed_meanwhile":
      return new AppError({
        code: "conflict",
        message: "machine.toml changed while the instances were being written.",
        hint: "Run the command again.",
      });
    case "invalid_file":
      return new AppError({
        code: "invalid_input",
        message: "machine.toml cannot be read as it is, so nothing was changed.",
        hint: "Run ttasks doctor, then fix machine.toml.",
      });
    case "unsafe":
      return new AppError({
        code: "invalid_input",
        message:
          "machine.toml or its folder fails the permission rule (another user could change it, or it is a link), so nothing was changed.",
        hint: "Run ttasks doctor: it names the fix.",
      });
    case "unsupported_layout":
      return new AppError({
        code: "invalid_input",
        message: "machine.toml writes its instances in a way this command cannot change.",
        hint: "Change the [[instance]] entries in machine.toml by hand.",
      });
    default:
      return new AppError({
        code: "invalid_input",
        message: "The instances cannot be written to machine.toml.",
      });
  }
}

const isText = (value: unknown, max = 4096): value is string =>
  typeof value === "string" && value !== "" && value.length <= max;

/** One entry from the request, checked, its keys in the written order. */
function entryOf(value: unknown, at: number): Map<string, EditValue> {
  const path = `entries.${String(at)}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(path, "Expected an instance entry");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(KEYS as readonly string[]).includes(key))
      throw invalid(`${path}.${key}`, "Not a key this command writes");
  }
  const { id, target, label, account, exec, config_home, args_prefix, env, remote_allowed } = raw;
  if (typeof id !== "string" || !INSTANCE_ID.test(id) || id === MANUAL_INSTANCE) {
    throw invalid(`${path}.id`, "Expected an instance ID");
  }
  if (typeof target !== "string" || !(TARGETS as readonly string[]).includes(target)) {
    throw invalid(`${path}.target`, "Expected claude-cli, codex-cli or t3");
  }
  const entry = new Map<string, EditValue>([
    ["id", id],
    ["target", target],
  ]);
  if (!isText(label, 40))
    throw invalid(`${path}.label`, "Expected a label of at most 40 characters");
  entry.set("label", label);
  if (account !== undefined) {
    if (!isText(account, 40))
      throw invalid(`${path}.account`, "Expected an account of at most 40 characters");
    entry.set("account", account);
  }
  if (exec !== undefined) {
    if (!isText(exec)) throw invalid(`${path}.exec`, "Expected the agent's command");
    entry.set("exec", exec);
  }
  if (args_prefix !== undefined) {
    if (
      !Array.isArray(args_prefix) ||
      args_prefix.length > 8 ||
      !args_prefix.every((a) => isText(a))
    ) {
      throw invalid(`${path}.args_prefix`, "Expected the arguments before TTasks's");
    }
    entry.set("args_prefix", args_prefix);
  }
  if (config_home !== undefined) {
    if (!isText(config_home))
      throw invalid(`${path}.config_home`, "Expected the agent's home folder");
    entry.set("config_home", config_home);
  }
  if (env !== undefined) {
    const values =
      typeof env === "object" && env !== null && !Array.isArray(env)
        ? Object.entries(env)
        : undefined;
    if (values === undefined || values.length > 8 || !values.every(([, v]) => isText(v))) {
      throw invalid(`${path}.env`, "Expected the agent's environment variables");
    }
    entry.set("env", Object.fromEntries(values));
  }
  // T3 (A4 3.2): the local environment, the provider instance and its model, all three or none.
  const t3 = T3_KEYS.map((key) => raw[key]);
  if (target === "t3") {
    const [environment, provider, model] = t3;
    if (environment !== "local") {
      throw invalid(`${path}.t3_environment`, "Expected local");
    }
    if (!isText(provider, 64)) {
      throw invalid(`${path}.t3_provider_instance`, "Expected T3's provider instance");
    }
    if (!isText(model, 128)) throw invalid(`${path}.t3_model`, "Expected a model");
    entry.set("t3_environment", environment);
    entry.set("t3_provider_instance", provider);
    entry.set("t3_model", model);
  } else if (t3.some((value) => value !== undefined)) {
    throw invalid(`${path}.target`, "Only a T3 instance takes the t3 keys");
  }
  // Reserved for L1 (A6): a command from another machine never uses an instance this writes.
  if (remote_allowed !== undefined && remote_allowed !== false) {
    throw invalid(`${path}.remote_allowed`, "Expected false");
  }
  entry.set("remote_allowed", false);
  return entry;
}

/** An entry's ID, which entryOf set. */
const idOf = (entry: ReadonlyMap<string, EditValue>): string => {
  const id = entry.get("id");
  return typeof id === "string" ? id : "";
};

// ---------------------------------------------------------------------------------------------
// The record

const recordPath = (stateDir: string): string => join(stateDir, INSTANCES_RECORD);

function isEntryValue(value: unknown): value is EditValue {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every((v) => typeof v === "string");
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value as Record<string, unknown>).every((v) => typeof v === "string")
  );
}

function isRecorded(value: unknown): value is Recorded {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    typeof r["at"] === "string" &&
    Array.isArray(r["entries"]) &&
    (r["entries"] as unknown[]).every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        isEntryValue(pair[1]),
    )
  );
}

/** The record: what instances/add wrote. Missing is none; a damaged one refuses the change. */
export function readInstancesRecord(stateDir: string): Recorded[] {
  let fd: number;
  try {
    // A regular file only: a link put in its place is refused below by fstat of what opened.
    fd = openSync(recordPath(stateDir), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw damaged();
  }
  let raw: string;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw damaged();
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    raw = buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw damaged();
  }
  const list = (doc as { instances?: unknown } | null)?.instances;
  if ((doc as { format?: unknown } | null)?.format !== RECORD_FORMAT || !Array.isArray(list)) {
    throw damaged();
  }
  if (!list.every(isRecorded)) throw damaged();
  return list;
}

function damaged(): AppError {
  return new AppError({
    code: "invalid_input",
    message: `The record of the instances setup wrote (${INSTANCES_RECORD} in the state folder) cannot be read, so nothing was changed.`,
    hint: "Change the [[instance]] entries in machine.toml by hand.",
  });
}

function writeRecord(stateDir: string, list: readonly Recorded[]): void {
  atomicWrite(
    recordPath(stateDir),
    `${JSON.stringify({ format: RECORD_FORMAT, instances: list }, null, 2)}\n`,
    0o600,
  );
}

// ---------------------------------------------------------------------------------------------
// The verbs

export function instanceVerbs(host: InstancesHost): Readonly<Record<string, Verb>> {
  return {
    "instances/add": async (params, cls) => {
      userOnly(cls);
      return await Promise.resolve(following(host, () => addInstances(host, params)));
    },
    "instances/remove": async (params, cls) => {
      userOnly(cls);
      return await Promise.resolve(following(host, () => removeInstances(host, params)));
    },
  };
}

/** Runs a verb, then sets the service's instances to the file's, whatever happened in between. */
function following<T>(host: InstancesHost, run: () => T): T {
  try {
    return run();
  } finally {
    follow(host);
  }
}

/**
 * The service's instances become those machine.toml holds now, read as the service reads it at
 * start. A file that cannot be read (unsafe, not TOML, unreadable) keeps them: the start would
 * refuse it, and dropping every instance for it would be worse.
 */
function follow(host: InstancesHost): void {
  try {
    const loaded = loadMachineConfig(host.configDir, host.platform);
    if (loaded.unsafe !== undefined) return;
    if (loaded.problems.some((p) => p.severity === "error" && p.key === "")) return;
    host.set(loaded.config.instances);
  } catch {
    // Keep them: the verb's own result or error is what the person needs to see.
  }
}

/** Each edit is prepared and committed with nothing awaited in between, so edits never interleave. */
function addInstances(host: InstancesHost, params: JsonObject): unknown {
  const list = params["entries"];
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ENTRIES) {
    throw invalid("entries", `Expected 1 to ${String(MAX_ENTRIES)} instance entries`);
  }
  const entries = list.map((value, i) => entryOf(value, i));
  const ids = entries.map((e) => idOf(e));
  if (new Set(ids).size !== ids.length) throw invalid("entries", "Expected each instance ID once");
  const prepared = prepareEdit(
    host.configDir,
    entries.map((e) => ({ op: "append" as const, array: "instance", entries: e })),
  );
  if (!prepared.ok) throw editRefused(prepared.reason);
  // The file decides, as it holds the instances written by hand too; the live list follows it.
  const named = instanceIds(prepared.edit.before?.toString("utf8") ?? "");
  if (ids.some((id) => named.includes(id))) {
    throw invalid(
      "entries",
      "This machine has an instance with this ID already",
      "Run ttasks setup instances again.",
    );
  }
  // The file as it will be: each entry must come back as an instance, or nothing is written.
  const read = parseMachineConfig(withoutBom(prepared.edit.text), host.platform);
  const dropped = ids.filter((id) => !read.config.instances.some((i) => i.id === id));
  if (dropped.length > 0) {
    throw new AppError({
      code: "invalid_input",
      message:
        "machine.toml's reader would not take an entry back as an instance, so nothing was written.",
      hint: "Run ttasks doctor: its config row names the key and the problem.",
      data: {
        issues: dropped.map((id) => ({ path: `instance.${id}`, message: "Would be dropped" })),
      },
    });
  }
  // Recorded before the write, so an entry in the file always has its record: a write that does
  // not happen takes its record back (commitEdit changes the file only by its last step, the
  // rename). Should that take-back fail too, the record names an entry the file lacks, which is
  // harmless: a retry of the add records it again, and remove reports it `missing` and drops it.
  const before = readInstancesRecord(host.stateDir);
  const at = new Date().toISOString();
  const added = entries.map((e) => ({ id: idOf(e), entries: [...e], at }));
  writeRecord(host.stateDir, [...before.filter((r) => !ids.includes(r.id)), ...added]);
  let edited;
  try {
    edited = commitEdit(prepared.edit);
  } catch (error) {
    writeRecord(host.stateDir, before);
    throw error;
  }
  if (!edited.ok) {
    writeRecord(host.stateDir, before);
    throw editRefused(edited.reason);
  }
  host.log.log("config.instances_changed", { added: ids.length, removed: 0 });
  return { added: ids };
}

/**
 * Takes out what instances/add wrote: every recorded entry, or those `ids` names. Each is removed
 * only while it is byte for byte as written (`removed`); one the person changed stays (`edited`),
 * and one that is gone from the file loses its record (`missing`).
 */
function removeInstances(host: InstancesHost, params: JsonObject): unknown {
  const wanted = params["ids"];
  if (
    wanted !== undefined &&
    (!Array.isArray(wanted) ||
      !wanted.every((id) => typeof id === "string" && INSTANCE_ID.test(id)))
  ) {
    throw invalid("ids", "Expected instance IDs");
  }
  let record = readInstancesRecord(host.stateDir);
  const chosen = record.filter((r) => wanted === undefined || (wanted as string[]).includes(r.id));
  const outcomes: { id: string; result: "removed" | "edited" | "missing" }[] = [];
  for (const entry of chosen) {
    const prepared = prepareEdit(host.configDir, [
      { op: "remove", array: "instance", entries: new Map(entry.entries) },
    ]);
    if (!prepared.ok && prepared.reason !== "absent") throw editRefused(prepared.reason);
    if (!prepared.ok) {
      // Still in the file under its ID, but no longer as written: the person's now.
      const result = namesInstance(host.configDir, entry.id) ? "edited" : "missing";
      outcomes.push({ id: entry.id, result });
      if (result === "missing") {
        record = record.filter((r) => r.id !== entry.id);
        writeRecord(host.stateDir, record);
      }
      continue;
    }
    const edited = commitEdit(prepared.edit);
    if (!edited.ok) throw editRefused(edited.reason);
    // The file is written: should the record's update fail now, the instance is still gone from
    // what Open offers (`following`), and a retry finds it `missing` and drops its record.
    outcomes.push({ id: entry.id, result: "removed" });
    record = record.filter((r) => r.id !== entry.id);
    writeRecord(host.stateDir, record);
  }
  const removed = outcomes.filter((o) => o.result === "removed").length;
  if (removed > 0) host.log.log("config.instances_changed", { added: 0, removed });
  return { outcomes };
}

/** machine.toml's text without the byte order mark the editor keeps. */
const withoutBom = (text: string): string => (text.startsWith(BOM) ? text.slice(BOM.length) : text);

/** The IDs of machine.toml's [[instance]] elements in `text`, also those the reader drops. */
function instanceIds(text: string): string[] {
  const parsed = parseToml(withoutBom(text));
  const list = parsed.ok ? parsed.doc["instance"] : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((element) =>
    isTable(element) && typeof element["id"] === "string" ? [element["id"]] : [],
  );
}

/**
 * Whether machine.toml still has an [[instance]] with this ID, one the reader drops included, read
 * as the editor reads it. When the file cannot be read, it counts as there, so the record stays.
 */
function namesInstance(configDir: string, id: string): boolean {
  const read = prepareEdit(configDir, []);
  return !read.ok || instanceIds(read.edit.text).includes(id);
}
