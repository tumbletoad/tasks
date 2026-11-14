// `tasks roots` (A1 3.15, A2 3.2.4, A5's Folders; M2.07): the service's side, as rpc methods
// registered in the handler table (endpoint.ts), like `space/*`.
//
//   roots/list   this machine's roots: ID, label, folder, runs        (every CLI class)
//   roots/add    a new root in machine.toml, live at once              (the user only)
//
// Only the user adds roots (A1 3.15, A5: roots are policy). The method table lets only
// `cli-interactive` call `roots/add`, and the handler checks the class again, so another transport
// that reaches it refuses agents too. The edit goes through `editMachineToml` (A2 3.2.4): one
// table added at the end, every other byte of the file kept. The service holds the roots it
// resolves places with; an added root joins them at once (reloading the whole file on change is
// not built, A2 3.2.4), and its `root_rev` is brought up to date in machine state.
//
// A root's folder is written as the person gave it (made absolute by the CLI), not as its real
// path: a root that is a link stays a link, and resolution follows it (places.ts). A folder that
// is not there, or that another root already names (by identity, whatever the spelling), is
// refused: two roots on one folder would leave that folder without one place. Adds run one at a
// time, and each checks the folder against the roots the file holds when the edit is prepared
// (hand edits included) as well as the live ones; the edit is written only if the file is still
// what was checked.
import { stat } from "node:fs/promises";
import type { JsonObject } from "@tasks/bridge/protocol";
import { AppError } from "@tasks/contracts";
import {
  absoluteFolder,
  isAbsoluteFor,
  ROOT_ID,
  rootNaming,
  hasControl,
  type Root,
} from "@tasks/launch";
import { commitEdit, prepareEdit, type EditRefusal } from "../config/edit.ts";
import { parseMachineConfig } from "../config/machine-toml.ts";
import { syncRootRevisions } from "../config/root-revs.ts";
import type { ConnectionClass } from "../local/index.ts";
import { isUserClass } from "../ops/index.ts";
import type { Logger } from "./log.ts";

/** What the roots verbs need from the hub. */
export interface RootsHost {
  /** The folder of machine.toml. */
  readonly configDir: string;
  /** The state folder, which holds `roots.json` (the revisions). */
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly log: Logger;
  /** The roots places resolve with now. */
  current(): readonly Root[];
  /** Replaces them, after an edit. */
  set(roots: readonly Root[]): void;
}

type Verb = (params: JsonObject, cls: ConnectionClass) => Promise<unknown>;

const invalid = (path: string, message: string, hint?: string, data: JsonObject = {}): AppError =>
  new AppError({
    code: "invalid_input",
    message: `${message}.`,
    ...(hint === undefined ? {} : { hint }),
    data: { issues: [{ path, message }], ...data },
  });

function userOnly(cls: ConnectionClass): void {
  if (!isUserClass(cls)) {
    throw new AppError({
      code: "forbidden",
      message: "Only the user can do this.",
      hint: "Ask the user to add the root: tasks roots add <id> <folder>.",
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
        message: "machine.toml changed while the root was being added.",
        hint: "Run the command again.",
      });
    case "invalid_file":
      return new AppError({
        code: "invalid_input",
        message: "machine.toml cannot be read as it is, so nothing was changed.",
        hint: "Run tasks doctor, then fix machine.toml.",
      });
    case "exists":
      // Another add of the same ID got there first.
      return new AppError({
        code: "invalid_input",
        message: "machine.toml has a root with this ID already.",
        data: { issues: [{ path: "id", message: "This machine has a root with this ID already" }] },
      });
    case "unsafe":
      return new AppError({
        code: "invalid_input",
        message:
          "machine.toml or its folder fails the permission rule (another user could change it, or it is a link), so nothing was changed.",
        hint: "Run tasks doctor: it names the fix.",
      });
    case "unsupported_layout":
      return new AppError({
        code: "invalid_input",
        message: "machine.toml writes its roots in a way this command cannot add to.",
        hint: "Add the root to machine.toml by hand.",
      });
    default:
      return new AppError({
        code: "invalid_input",
        message: "The root cannot be written to machine.toml.",
      });
  }
}

const rowOf = (root: Root) => ({
  id: root.id,
  label: root.label,
  path: root.path,
  runs: root.runs,
});

/**
 * The adds in progress per machine.toml: one at a time, so each one checks the roots the one
 * before it wrote. Keyed by the config folder, so every handler table of one service shares it.
 */
const adding = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier add for the same machine.toml has finished. */
function oneAtATime<T>(configDir: string, task: () => Promise<T>): Promise<T> {
  const before = adding.get(configDir) ?? Promise.resolve();
  const run = before.then(task, task);
  const settled = run.catch(() => undefined);
  adding.set(configDir, settled);
  void settled.then(() => {
    if (adding.get(configDir) === settled) adding.delete(configDir);
  });
  return run;
}

export function rootVerbs(host: RootsHost): Readonly<Record<string, Verb>> {
  return {
    "roots/list": () => Promise.resolve({ roots: host.current().map(rowOf) }),

    "roots/add": (params, cls) => {
      userOnly(cls);
      return oneAtATime(host.configDir, () => addRoot(host, params));
    },
  };
}

async function addRoot(host: RootsHost, params: JsonObject): Promise<unknown> {
  const { id, path, label, runs } = params;
  if (typeof id !== "string" || !ROOT_ID.test(id)) {
    throw invalid("id", "Expected a root ID: a to z, 0 to 9, _ and -, at most 32 characters");
  }
  // The rules places resolve a root's folder by (no `.` or `..` segment, no name Win32 reads as
  // another), so a root that is added can be resolved.
  if (
    typeof path !== "string" ||
    path.length > 4096 ||
    !isAbsoluteFor(host.platform, path) ||
    !absoluteFolder(path, host.platform).ok
  ) {
    throw invalid("path", "Expected an absolute folder");
  }
  if (
    label !== undefined &&
    (typeof label !== "string" || label === "" || label.length > 80 || hasControl(label))
  ) {
    throw invalid("label", "Expected a label of at most 80 characters");
  }
  if (runs !== undefined && typeof runs !== "boolean") {
    throw invalid("runs", "Expected true or false");
  }
  const live = host.current();
  if (live.some((root) => root.id === id)) {
    throw invalid("id", "This machine has a root with this ID already", "Pick another ID.");
  }
  let isFolder = false;
  try {
    isFolder = (await stat(path)).isDirectory();
  } catch {
    // Not there, or not reachable: refused below.
  }
  if (!isFolder) throw invalid("path", "The folder is not there", "Create it first.");

  const entries: Record<string, string | boolean> = {
    ...(label === undefined ? {} : { label }),
    path,
    ...(runs === undefined ? {} : { runs }),
  };
  const prepared = prepareEdit(host.configDir, [
    { op: "add_table", table: ["roots", id], entries },
  ]);
  if (!prepared.ok) throw editRefused(prepared.reason);
  // The roots the file will hold: the added one and every other, those written by hand since the
  // service started included. The folder is checked against those and the live ones.
  const inFile = parseMachineConfig(prepared.edit.text, host.platform).config.roots;
  // Every mapping of both: a root the file now maps to another folder than the live one is
  // checked under both folders, since either may be the one in use.
  const others = [...live, ...inFile].filter((root) => root.id !== id);
  const naming = await rootNaming(path, others, { platform: host.platform });
  if (naming.status === "named") {
    throw invalid("path", "A root of this machine names this folder already", undefined, {
      roots: [naming.root],
    });
  }
  // A volume that gives no file number gives no identity: no place under the root could resolve.
  if (naming.status === "identity_unavailable") {
    throw invalid(
      "path",
      "The folder's volume gives no file identity, so places under it cannot be resolved",
      "Pick a folder on a local volume.",
    );
  }
  if (naming.status === "unavailable")
    throw invalid("path", "The folder is not there", "Create it first.");
  // Written only if the file is still the one checked (`changed_meanwhile` otherwise).
  const edited = commitEdit(prepared.edit);
  if (!edited.ok) throw editRefused(edited.reason);

  const added: Root = { id, label: label ?? id, path, runs: runs ?? false };
  const next = inFile.some((root) => root.id === id) ? inFile : [...live, added];
  host.set(next);
  let rev = 1;
  try {
    rev = syncRootRevisions(host.stateDir, next).revs.get(id) ?? 1;
  } catch {
    // The revision is reserved for L1: a failure to keep it never undoes the root.
  }
  host.log.log("config.root_added", { rev, runs: added.runs });
  return { root: { ...rowOf(next.find((root) => root.id === id) ?? added), rev } };
}
