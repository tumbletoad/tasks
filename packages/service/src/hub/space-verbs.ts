// The service's side of `ttasks space` (A2 3.10.1, A1 3.18): rpc
// methods `space/*`, registered in the handler table (endpoint.ts). Every one but those that only
// read (`space/list`, `space/backups`) is a user-only operation: the method table lets only
// `cli-interactive` call them, and each checks the class again, so another transport that reaches
// them refuses agents too.
//
//   space/list      the registered spaces with their state and folder, and the default space
//   space/create    a new space folder, then served          (createSpace, in a worker)
//   space/open      serve a space folder while the service runs; `retry_migration` tries a failed
//                   migration again (A1 3.17)
//   space/close     close one space while the service keeps running (A1 3.1)
//   space/forget    take a closed space off the list and out of machine.toml; no file is touched
//   space/backup    a manual backup                           (backupSpace, kind manual)
//   space/backups   the backups and leftovers of a space      (listBackups)
//   space/export    an export bundle in `<space>/exports`     (exportBundle, backup or fork mode;
//                   transfer waits for M3.08's machine keys and states)
//   space/restore   a backup or a bundle into a new folder,   (restoreBackup, then served)
//                   a read-only copy, or in place, claimed    (SpaceManager.restoreInPlace)
//                   with a new epoch; `latest` of a space:    (restoreLatest)
//                   its newest backup that verifies, into a new folder (A1 3.2)
//   space/rescue    the rows that can still be read, into     (rescueSpace)
//                   `exchange/rescued/` (A1 3.2)
//   space/claim     claim a read-only copy                    (SpaceManager.claim)
//   space/recover   play a rollback journal back              (SpaceManager.recover)
//   view/rebuild    the space's projection reconciled with every task queued (A1 3.13 rule 5;
//                   SpaceManager.rebuildView): nothing it cannot prove it wrote is removed
//
// A1 3.2: a space in a synced folder opens read-only until the person confirms the folder is
// excluded from sync (`space/open` with `excluded`), and one on a network file system is never
// written. A new folder for a space (create, restore into a new folder) is checked first: a
// network file system is refused, and a new space in a synced folder opens read-only.
//
// The service opens machine.toml's `[[spaces]]` at start (A2 3.1), and the verbs record what they
// do there (space-records.ts), so what a person last did to a space holds after a restart: create,
// open, a restore and a claim leave the space's entry enabled, close leaves it `enabled = false`.
// An entry opens only as the one space it names (A2 3.2.4).
//
// A space is named by its folder, its ID or its name. A restored copy has its original's ID, but one
// folder serves a space at a time (spaces.ts): opening a copy while another is served is refused
// with what is open and how to look at the copy instead, so an ID or a name always means the folder
// that serves the space (ops/copies.ts, A2 3.10.5).
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";
import { AppError } from "@ttasks/contracts";
import { shellLine } from "@ttasks/launch";
import {
  backupsFolder,
  exportsFolder,
  listBackups,
  readManifest,
  StorageError,
  type Id,
  type MachineInfo,
} from "@ttasks/storage";
import type { JsonObject } from "@ttasks/bridge/protocol";
import type { ConnectionClass } from "../local/index.ts";
import { ambiguousError, findSpace, isAmbiguity } from "../ops/copies.ts";
import { isUserClass } from "../ops/index.ts";
import { storageFailureBody } from "./space-errors.ts";
import { AdminFailed, runAdmin, type AdminResult } from "./space-admin.ts";
import {
  because,
  forgetSpaceRecord,
  notRememberedLine,
  recordSpace,
  type SpaceChange,
  type SpaceRecordsHost,
} from "./space-records.ts";
import { readSpaceSettings } from "./space-settings.ts";
import { OtherCopyOpen, restoredOf, type Restored } from "./restored.ts";
import type { SpaceManager, SpaceView } from "./spaces.ts";
import type { FolderCheck } from "./sync-folders.ts";

/**
 * A6 3.5's warning at a claim: the copy becomes this machine's, and another machine that still
 * has the space goes on without it.
 */
export const CLAIM_WARNING =
  "If another machine still has this space, its later changes will not appear here.";

export interface SpaceVerbsHost {
  readonly manager: Pick<
    SpaceManager,
    | "list"
    | "open"
    | "close"
    | "forget"
    | "forgettable"
    | "claim"
    | "restoreInPlace"
    | "recover"
    | "folderOf"
    | "checkFolder"
    | "confirmExcluded"
    | "rebuildView"
    | "repairSearch"
    | "backedUp"
  >;
  readonly machine: MachineInfo;
  /** The state folder, for each space's machine-local settings (`backup.dir`). */
  readonly settingsDir: string;
  /** The machine's default space (A2 3.1), which `space/list` names. */
  readonly defaultSpace?: () => string | undefined;
  /** Unsets the default when it names this space, which `space/forget` took off the list. */
  readonly clearDefault?: (id: string) => Promise<void>;
  /** Where the verbs record what they did (machine.toml, space-records.ts). None: no record. */
  readonly records?: SpaceRecordsHost;
}

type Verb = (params: JsonObject, cls: ConnectionClass) => Promise<unknown>;

const invalid = (path: string, message: string): AppError =>
  new AppError({
    code: "invalid_input",
    message: `${message}.`,
    data: { issues: [{ path, message }] },
  });

const text = (params: JsonObject, key: string, max = 4096): string | undefined => {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "" || value.length > max) {
    throw invalid(key, "Expected text");
  }
  return value;
};

const required = (params: JsonObject, key: string, max?: number): string => {
  const value = text(params, key, max);
  if (value === undefined) throw invalid(key, "Required");
  return value;
};

/** A flag: true, or absent for false. */
const flag = (params: JsonObject, key: string): boolean => {
  const value = params[key];
  if (value === undefined || value === false) return false;
  if (value !== true) throw invalid(key, "Expected true or false");
  return true;
};

/** What the folder check found, for the person (no path: the caller named the folder). */
const checkData = (check: FolderCheck): JsonObject => ({
  verdict: check.verdict,
  ...(check.provider === undefined ? {} : { provider: check.provider }),
  ...(check.fs === undefined ? {} : { fs: check.fs }),
  ...(check.conflicts.length === 0 ? {} : { conflicts: [...check.conflicts] }),
});

/** A new space folder on a network file system is refused: a space is never written there. */
function refuseNetwork(check: FolderCheck, key: string): void {
  if (check.verdict !== "network") return;
  throw new AppError({
    code: "invalid_input",
    message:
      "That folder is on a network file system. A live database there can be corrupted, so a space is never written there. Choose a local folder.",
    data: {
      issues: [{ path: key, message: "On a network file system" }],
      folder_check: checkData(check),
    },
  });
}

/** An absolute path the CLI resolved: never a relative one, which would be the service's cwd. */
const absolute = (params: JsonObject, key: string): string => {
  const value = required(params, key);
  if (!isAbsolute(value)) throw invalid(key, "Expected an absolute path");
  return resolve(value);
};

function userOnly(cls: ConnectionClass): void {
  if (!isUserClass(cls)) {
    throw new AppError({
      code: "forbidden",
      message: "Only the user can do this.",
      hint: `Ask the user to do this in ${PRODUCT_NAME}.`,
      data: { rule: "user_only" },
    });
  }
}

/** The space an admin job made: a create's new space, a restore's read-only copy. */
function spaceOf(result: AdminResult): Id<"sp"> {
  if (result.kind !== "create" && result.kind !== "restore") {
    throw new AppError({ code: "internal", message: "No space." });
  }
  return result.spaceId;
}

/** The export modes a person can ask for now: transfer comes with M3.08. */
const EXPORT_MODES = ["backup", "fork", "transfer"] as const;

/**
 * A view rebuild of a space that is not open here: it needs the space open first, so a retry on
 * its own does not help.
 */
export function viewNotKept(state: string): AppError {
  return new AppError({
    code: "space_unavailable",
    message: `${PRODUCT_NAME} keeps a space's view only while the space is open on this machine.`,
    hint: `Run ${CLI_NAME} space list to see why it is not open.`,
    data: { reason: "not_served", retryable: false, state },
  });
}

/** A storage failure, or a worker's code, as A3's error body. */
function failure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof AdminFailed) return new AppError(storageFailureBody(error.code));
  if (error instanceof StorageError) return new AppError(storageFailureBody(error.code));
  return new AppError({ code: "internal", message: "Something went wrong in the service." });
}

/**
 * What a crash can leave beside a space or in it, by name (A1 3.1, 3.18): a create's
 * `.<slug>.creating-*` folder, a restore's `.<slug>.restoring-*` staging folder, the
 * `<slug>.replaced-*` folder a restore in place keeps, `.space.json.tmp-*` files, an export's
 * `exports/.export.tmp-*` work folder and a rescue's `exchange/rescued/.rescue.tmp-*` scratch
 * folder. Listed for the person, never removed here: a staging, work or scratch folder may belong
 * to a create, restore, export or rescue still running.
 */
export function leftoversOf(folder: string): string[] {
  const slug = basename(folder);
  const found: string[] = [];
  const names = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const name of names(dirname(folder))) {
    if (
      name.startsWith(`.${slug}.creating-`) ||
      name.startsWith(`.${slug}.restoring-`) ||
      name.startsWith(`${slug}.replaced-`)
    ) {
      found.push(join(dirname(folder), name));
    }
  }
  for (const name of names(folder)) {
    if (name.startsWith(".space.json.tmp-")) found.push(join(folder, name));
  }
  const exports = join(folder, "exports");
  for (const name of names(exports)) {
    if (name.startsWith(".export.tmp-")) found.push(join(exports, name));
  }
  const rescued = join(folder, "exchange", "rescued");
  for (const name of names(rescued)) {
    if (name.startsWith(".rescue.tmp-")) found.push(join(rescued, name));
  }
  return found.sort();
}

/** Whether `folder` holds a space: its space.json or its database is there. */
function holdsSpace(folder: string): boolean {
  try {
    return readManifest(folder).state === "present" || existsSync(join(folder, "space.db"));
  } catch {
    return existsSync(join(folder, "space.db"));
  }
}

/** A command for the person to run, quoted for their shell, or its pattern when it cannot be. */
const command = (words: readonly string[], pattern: string): string =>
  shellLine(process.platform, [CLI_NAME, ...words]) ?? `${CLI_NAME} ${pattern}`;

/**
 * A create into a folder that is there already: when the folder holds a space, the way to serve it
 * is to open it, which the answer names.
 */
function existsAnswer(error: AppError, folder: string): AppError {
  if (error.data["cause"] !== "SPACE_EXISTS" || !holdsSpace(folder)) return error;
  return new AppError({
    ...error.toBody(),
    message: "A space is already in that folder.",
    hint: `Open it with: ${command(["space", "open", folder], "space open <folder>")}`,
  });
}

/**
 * Why a space that is not a restored copy is not claimed, and the way that works: another
 * machine's space is copied through an export bundle, whose restore is a copy this machine claims
 * (A6 3.5; a transfer comes with M3.08).
 */
function notClaimable(view: SpaceView): AppError {
  if (view.state === "read_only" && view.reason === "not_authority") {
    return new AppError({
      code: "invalid_input",
      message:
        "This space belongs to another machine, so it is not claimed where it is. Make a copy of it this machine's: export it, close it, restore the bundle into a new folder and claim that copy.",
      hint: `${CLI_NAME} space export <folder>; ${CLI_NAME} space close <folder>; ${CLI_NAME} space restore <bundle> --to <new folder>; ${CLI_NAME} space claim <new folder>`,
      data: { issues: [{ path: "space", message: "Another machine's space" }] },
    });
  }
  // A restored copy that something else keeps read-only (a synced folder, a newer build): that
  // comes first, in its own words.
  if (view.restored !== undefined && view.message !== undefined) {
    return new AppError({
      code: "invalid_input",
      message: `This restored copy cannot be claimed yet. ${view.message}`,
      data: { issues: [{ path: "space", message: "Read-only for another reason" }] },
    });
  }
  return new AppError({
    code: "invalid_input",
    message:
      view.state === "open"
        ? "This space takes writes on this machine already: there is nothing to claim."
        : "Only a restored copy is claimed, and this space is not one.",
    hint: `${CLI_NAME} space list shows a restored copy as read_only: read_only_copy.`,
    data: { issues: [{ path: "space", message: "Not a restored copy" }] },
  });
}

/** When a copy was restored, for a person: the service's local day and time. */
const restoredWhen = (restored: Restored): string =>
  new Date(restored.at).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** What `folder` holds, for a person: a copy restored when and from which backup, or a copy. */
function copyWords(folder: string): string {
  let restored: Restored | undefined;
  try {
    const read = readManifest(folder);
    restored = read.state === "present" ? restoredOf(read.manifest?.transfer) : undefined;
  } catch {
    restored = undefined;
  }
  if (restored === undefined) return "This folder holds another copy of it.";
  const from = restored.backup === undefined ? "" : ` from the backup ${restored.backup}`;
  return `This folder holds a copy of it restored on ${restoredWhen(restored)}${from}.`;
}

/**
 * How a person closes the copy that is open, so the command works as printed in any shell: by the
 * space's name, which means the one folder that serves it; by its ID when another space has that
 * name too; by its folder when the name is not known.
 */
function closeCommand(error: OtherCopyOpen, spaces: readonly SpaceView[]): string {
  const name = error.spaceName;
  const shared =
    name !== undefined &&
    spaces.some(
      (view) =>
        view.name?.toLowerCase() === name.toLowerCase() &&
        (view.id ?? view.registered) !== error.spaceId,
    );
  return command(
    ["space", "close", shared ? error.spaceId : (name ?? error.open)],
    "space close <folder>",
  );
}

/**
 * The refusal of an open of `folder` while another folder serves its space (one copy at a time):
 * what is open, what this folder is, and how to look at it instead.
 */
function otherCopyRefusal(
  error: OtherCopyOpen,
  folder: string,
  spaces: readonly SpaceView[],
): AppError {
  const name = error.spaceName ?? "This space";
  const close = closeCommand(error, spaces);
  return new AppError({
    code: "invalid_input",
    message: `${name} is open from ${error.open}. ${copyWords(folder)} Two copies of one space are never open together.`,
    hint: `To look inside this copy, close ${name} first (${close}), then open this folder again.`,
    data: {
      issues: [{ path: "path", message: "Another copy of this space is open" }],
      reason: "other_copy_open",
    },
  });
}

/**
 * One table per host, whichever transport asks for it (the socket's handler table, the page's
 * routes): the verbs that add a space share one queue.
 */
const tables = new WeakMap<SpaceVerbsHost, Readonly<Record<string, Verb>>>();

export function spaceVerbs(host: SpaceVerbsHost): Readonly<Record<string, Verb>> {
  const made = tables.get(host);
  if (made !== undefined) return made;
  const table = makeSpaceVerbs(host);
  tables.set(host, table);
  return table;
}

function makeSpaceVerbs(host: SpaceVerbsHost): Readonly<Record<string, Verb>> {
  const { manager } = host;

  /**
   * The verbs that add a space to the service (create, open, restore into a new folder) run one
   * at a time: a create picks its reference prefix from the registered spaces, so a second create
   * must see the first one registered, or both could take the same prefix.
   */
  let registering: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const run = registering.then(work, work);
    registering = run.catch(() => undefined);
    return run;
  };

  /** The spaces a person sees and names: every entry but those they forgot. */
  const listed = (): SpaceView[] => manager.list().filter((view) => view.forgotten !== true);

  const describe = (view: SpaceView) => {
    const folder = manager.folderOf(view.entry);
    const leftovers = leftoversOf(folder);
    return { ...view, folder, ...(leftovers.length === 0 ? {} : { leftovers }) };
  };

  /**
   * A space by folder, ID or name (ops/copies.ts, A2 3.10.5): an absolute path is a folder and only
   * a folder, so a space whose name looks like a path never stands in for the space at that path;
   * an ID or a name means the folder that serves the space, else the first one listed. A space not
   * served yet is found by the ID its entry names; it has no name until it is served.
   */
  const find = (wanted: string): SpaceView => {
    const copies = listed().map((view) => ({
      view,
      id: view.id ?? view.registered,
      name: view.name,
      state: view.state,
      reason: view.reason,
      folder: manager.folderOf(view.entry),
    }));
    const found = findSpace(copies, wanted);
    if (isAmbiguity(found)) throw ambiguousError();
    if (found !== undefined) return found.view;
    throw new AppError({
      code: "not_found",
      message: isAbsolute(wanted)
        ? "The service has no space in that folder."
        : "The service has no space by that ID or name.",
      hint: `Run ${CLI_NAME} space list.`,
    });
  };

  /**
   * Records in machine.toml what the verb did to `view`'s space (space-records.ts), and says so in
   * the answer: `remembered`, and when it is false, the plain line why a restart will not keep it.
   */
  const remember = (
    view: SpaceView,
    enabled: boolean,
    extra: Pick<SpaceChange, "repoint" | "others"> = {},
  ): JsonObject => {
    const id = view.id ?? view.registered;
    if (host.records === undefined || id === undefined) return {};
    const folder = manager.folderOf(view.entry);
    const done = recordSpace(host.records, { folder, id, enabled, ...extra });
    if (done.remembered) return { remembered: true };
    // Once the file is fixed, `space open` or `space close` of the folder records the state the verb
    // left: they do nothing more to a space already open or closed, while a create, a restore, a
    // claim or a recovery cannot simply be run again.
    const again = enabled
      ? command(["space", "open", folder], "space open <folder>")
      : command(["space", "close", folder], "space close <folder>");
    return {
      remembered: false,
      not_remembered: notRememberedLine(done.why, enabled, again, id, extra.repoint === true),
    };
  };

  const viewOf = (entry: number): SpaceView => {
    const view = manager.list()[entry];
    if (view === undefined)
      throw new AppError({ code: "internal", message: "A space is missing." });
    return view;
  };

  /**
   * Serves the copy a restore just made in `folder`. While another folder serves its space, the
   * copy stays closed and the answer says how to look inside it (one copy at a time). Nothing is
   * recorded for it then: `space open` of the folder serves and records it.
   */
  const openRestored = async (
    folder: string,
    id: Id<"sp">,
    extra: JsonObject,
  ): Promise<JsonObject> => {
    let entry: number;
    try {
      entry = await manager.open(folder, id);
    } catch (error) {
      if (!(error instanceof OtherCopyOpen)) throw error;
      const name = error.spaceName ?? "The space";
      const close = closeCommand(error, manager.list());
      const open = command(["space", "open", folder], "space open <folder>");
      return {
        folder,
        read_only_copy: true,
        ...extra,
        not_opened: `${name} is open from ${error.open}, and two copies of one space are never open together, so the copy is not opened. To look inside it, close ${name} first (${close}), then run: ${open}`,
      };
    }
    const view = viewOf(entry);
    return {
      space: describe(view),
      read_only_copy: true,
      ...extra,
      ...remember(view, true, { repoint: true }),
    };
  };

  const backupDirOf = (view: SpaceView): string => {
    const id = view.id ?? view.registered;
    const settings = id === undefined ? {} : readSpaceSettings(host.settingsDir, id);
    return settings.backupDir ?? backupsFolder(manager.folderOf(view.entry));
  };

  return {
    "space/list": () =>
      Promise.resolve({
        spaces: listed().map(describe),
        default: host.defaultSpace?.() ?? null,
      }),

    "space/create": async (params, cls) => {
      userOnly(cls);
      const name = required(params, "name", 100);
      const folder = absolute(params, "path");
      const refPrefix = text(params, "ref_prefix", 6);
      return oneAtATime(async () => {
        const taken = listed().flatMap((v) => (v.ref_prefix === undefined ? [] : [v.ref_prefix]));
        try {
          // A1 3.2: never written on a network file system. In a synced folder the new space
          // opens read-only, with the words that say why.
          refuseNetwork(await manager.checkFolder(folder), "path");
          const created = await runAdmin({
            kind: "create",
            folder,
            name,
            ...(refPrefix === undefined ? {} : { refPrefix }),
            takenPrefixes: taken,
            machineId: host.machine.id,
            ownerLabel: "user",
          });
          // The entry opens only as the space just made (A2 3.2.4), from now on also after a
          // restart: the folder was not there, so an entry it had names this space now.
          const entry = await manager.open(folder, spaceOf(created));
          const view = viewOf(entry);
          return { space: describe(view), ...remember(view, true, { repoint: true }) };
        } catch (error) {
          throw existsAnswer(failure(error), folder);
        }
      });
    },

    "space/open": async (params, cls) => {
      userOnly(cls);
      const folder = absolute(params, "path");
      // "It is excluded, open anyway" (A1 3.2): the person confirms this folder is excluded from
      // sync, for this machine and this folder.
      const excluded = flag(params, "excluded");
      // A migration that failed is tried again, now, behind a new barrier backup (A1 3.17).
      // Only the person asks for it: every copy it makes is one act of theirs.
      const retryMigration = flag(params, "retry_migration");
      if (!existsSync(folder)) {
        throw new AppError({ code: "not_found", message: "No space folder is there." });
      }
      return oneAtATime(async () => {
        try {
          let entry: number;
          try {
            entry = await manager.open(folder, undefined, { retryMigration });
          } catch (error) {
            if (error instanceof OtherCopyOpen) {
              throw otherCopyRefusal(error, folder, manager.list());
            }
            throw error;
          }
          const view = viewOf(entry);
          if (excluded && view.state === "read_only") {
            if (view.reason === "synced_folder") await manager.confirmExcluded(entry);
            else if (view.reason === "network_filesystem" || view.reason === "check_failed") {
              throw new AppError({
                code: "invalid_input",
                message: `${view.message ?? "The space is read-only."} Confirming the folder does not change that.`,
                data: { issues: [{ path: "excluded", message: "Not a synced folder to confirm" }] },
              });
            }
          }
          const opened = viewOf(entry);
          return { space: describe(opened), ...remember(opened, true) };
        } catch (error) {
          throw failure(error);
        }
      });
    },

    "space/close": async (params, cls) => {
      userOnly(cls);
      const view = find(required(params, "space"));
      try {
        await manager.close(view.entry);
      } catch (error) {
        throw failure(error);
      }
      // Closed also after a restart: the entry stays, `enabled = false`, and is listed closed.
      const closed = viewOf(view.entry);
      return { space: describe(closed), ...remember(closed, false) };
    },

    "space/forget": async (params, cls) => {
      userOnly(cls);
      const wanted = required(params, "space");
      // An ID or a name means the copy that takes writes, but only a copy that serves nothing is
      // forgotten: the closed original beside a claimed copy is the one a person means here.
      const resting = (view: SpaceView) => view.state === "closed" || view.state === "unavailable";
      const restingMatches = isAbsolute(wanted)
        ? []
        : listed().filter(
            (view) =>
              resting(view) &&
              ((view.id ?? view.registered) === wanted ||
                view.name?.toLowerCase() === wanted.toLowerCase()),
          );
      const view =
        restingMatches.length === 1 && restingMatches[0] ? restingMatches[0] : find(wanted);
      const folder = manager.folderOf(view.entry);
      if (!resting(view)) {
        throw new AppError({
          code: "invalid_input",
          message: "Only a closed space is forgotten, and this one is open.",
          hint: `Close it first: ${command(["space", "close", folder], "space close <folder>")}`,
          data: { issues: [{ path: "space", message: "Open" }] },
        });
      }
      if (!manager.forgettable(view.entry)) {
        throw new AppError({
          code: "invalid_input",
          message:
            "The space is being restored, claimed or recovered now, so it was not forgotten.",
          hint: "Forget it once that is done.",
          data: { issues: [{ path: "space", message: "Changing" }] },
        });
      }
      // machine.toml first: when the entry cannot be taken out, the space would come back at the
      // next start, so nothing is forgotten and the answer says why.
      if (host.records !== undefined) {
        const done = forgetSpaceRecord(host.records, folder);
        if (!done.remembered) {
          throw new AppError({
            code: "invalid_input",
            message: `${because(done.why)}, so the space was not forgotten.`,
            hint: "Take its [[spaces]] entry out of machine.toml by hand, or run ttasks doctor.",
            data: { issues: [{ path: "space", message: "machine.toml not changed" }] },
          });
        }
      }
      manager.forget(view.entry);
      const id = view.id ?? view.registered;
      // The default names a space by its ID: it goes only when no listed copy of it is left.
      if (id !== undefined && !listed().some((other) => (other.id ?? other.registered) === id)) {
        await host.clearDefault?.(id);
      }
      return { space: { ...describe(view), forgotten: true }, forgotten: true };
    },

    "space/backup": async (params, cls) => {
      userOnly(cls);
      const view = find(required(params, "space"));
      if (view.state !== "open" && view.state !== "read_only") {
        throw new AppError({
          code: "space_unavailable",
          message: "The space is not served now.",
          data: { reason: "not_served", retryable: false, state: view.state },
        });
      }
      const settings = view.id === undefined ? {} : readSpaceSettings(host.settingsDir, view.id);
      try {
        const done = await runAdmin({
          kind: "backup",
          folder: manager.folderOf(view.entry),
          ...(settings.backupDir === undefined ? {} : { backupDir: settings.backupDir }),
        });
        if (done.kind !== "backup") return {};
        manager.backedUp(view.entry, Date.parse(done.backup.created_at));
        if (done.searchIndexDamaged === true) manager.repairSearch(view.entry);
        return { backup: done.backup };
      } catch (error) {
        throw failure(error);
      }
    },

    "view/rebuild": async (params, cls) => {
      userOnly(cls);
      const view = find(required(params, "space"));
      const running = view.state === "open" ? manager.rebuildView(view.entry) : undefined;
      if (running === undefined) throw viewNotKept(view.state);
      try {
        const found = await running;
        return { checked: found.checked, queued: found.queued, forgotten: found.forgotten };
      } catch (error) {
        if (error instanceof StorageError) throw failure(error);
        // The projection ended before its reconciliation ran: the space closed meanwhile.
        throw viewNotKept("closed");
      }
    },

    "space/backups": (params) => {
      const view = find(required(params, "space"));
      const dir = backupDirOf(view);
      try {
        const listing = listBackups(dir);
        return Promise.resolve({
          folder: dir,
          backups: listing.backups.map((b) => ({
            name: b.name,
            state: b.state,
            created_at: new Date(b.createdAt).toISOString(),
            ...(b.sidecar === undefined
              ? {}
              : {
                  kind: b.sidecar.kind,
                  epoch: b.sidecar.epoch,
                  seq: b.sidecar.seq,
                  size: b.sidecar.size,
                  compressed_size: b.sidecar.compressed_size,
                }),
          })),
          leftovers: listing.leftovers,
        });
      } catch (error) {
        throw failure(error);
      }
    },

    "space/export": async (params, cls) => {
      userOnly(cls);
      const view = find(required(params, "space"));
      const mode = text(params, "mode", 16) ?? "backup";
      if (!(EXPORT_MODES as readonly string[]).includes(mode)) {
        throw invalid("mode", "Expected backup, fork or transfer");
      }
      // A transfer moves authority: it needs the machine key that signs its statement and the
      // durable transfer states, which come with M3.08.
      if (mode === "transfer") {
        throw new AppError({
          code: "invalid_input",
          message: "This service does not support that field yet.",
          hint: "It arrives with M3.08.",
          data: { issues: [{ path: "mode", message: "Not supported by this service yet" }] },
        });
      }
      if (text(params, "to", 64) !== undefined) {
        throw invalid("to", "Only a transfer names the machine it is for");
      }
      if (view.state !== "open" && view.state !== "read_only") {
        throw new AppError({
          code: "space_unavailable",
          message: "The space is not served now.",
          data: { reason: "not_served", retryable: false, state: view.state },
        });
      }
      try {
        const done = await runAdmin({
          kind: "export",
          folder: manager.folderOf(view.entry),
          mode: mode as "backup" | "fork",
          withJsonl: flag(params, "with_jsonl"),
          // A6 3.16.4: no file of an export comes from the secrets folder.
          secretFolders: [join(host.settingsDir, "secrets")],
        });
        return done.kind === "export" ? { export: done.export } : {};
      } catch (error) {
        throw failure(error);
      }
    },

    "space/restore": async (params, cls) => {
      userOnly(cls);
      const backup = required(params, "backup");
      const to = text(params, "to");
      const inPlace = text(params, "space");
      if ((to === undefined) === (inPlace === undefined)) {
        throw invalid("to", "Give either a new folder or the space to restore in place");
      }
      // `latest`: the newest backup of the space `of` that verifies, into a new folder. The way
      // out of a database that fails its check (A1 3.2), whose restore in place is refused.
      if (backup === "latest") {
        if (to === undefined || !isAbsolute(to)) {
          throw invalid("to", "The latest backup is restored into a new folder");
        }
        const of = find(required(params, "of"));
        // A space that never opened, such as one whose database is refused, still has the ID its
        // entry names: its backups are the way out.
        const spaceId = of.id ?? of.registered;
        if (spaceId === undefined) throw invalid("of", "The space's ID is not known yet");
        const target = resolve(to);
        try {
          return await oneAtATime(async () => {
            refuseNetwork(await manager.checkFolder(target), "to");
            const restored = await runAdmin({
              kind: "restore-latest",
              backupDir: backupDirOf(of),
              spaceId,
              target,
            });
            return await openRestored(
              target,
              spaceOf(restored),
              restored.kind === "restore" && restored.backup !== undefined
                ? { backup: restored.backup }
                : {},
            );
          });
        } catch (error) {
          throw failure(error);
        }
      }
      // A backup's or a bundle's file, or its name as `space backups` prints it: a backup's in the
      // backups folder of the space it restores (`space` in place, `of` into a new folder), a
      // bundle's (`.zip`) in its exports folder.
      let file: string;
      const from = inPlace ?? text(params, "of");
      if (isAbsolute(backup)) file = resolve(backup);
      else if (from !== undefined && /^[A-Za-z0-9._-]+$/.test(backup)) {
        const space = find(from);
        file = /\.zip$/i.test(backup)
          ? join(exportsFolder(manager.folderOf(space.entry)), backup)
          : join(backupDirOf(space), backup.endsWith(".db.gz") ? backup : `${backup}.db.gz`);
      } else {
        throw invalid(
          "backup",
          "Expected the backup's file as an absolute path, or its name with the space it is of",
        );
      }
      try {
        if (to !== undefined) {
          if (!isAbsolute(to)) throw invalid("to", "Expected an absolute path");
          const target = resolve(to);
          return await oneAtATime(async () => {
            refuseNetwork(await manager.checkFolder(target), "to");
            const restored = await runAdmin({ kind: "restore", backupFile: file, target });
            return await openRestored(target, spaceOf(restored), {});
          });
        }
        const view = find(inPlace ?? "");
        const change = await manager.restoreInPlace(view.entry, file);
        // The space opens again after a restore in place, whatever it was before.
        const restored = viewOf(view.entry);
        return {
          space: describe(restored),
          epoch: change.epoch,
          incarnation: change.incarnation,
          ...remember(restored, true),
        };
      } catch (error) {
        throw failure(error);
      }
    },

    "space/rescue": async (params, cls) => {
      userOnly(cls);
      const view = find(required(params, "space"));
      try {
        const done = await runAdmin({ kind: "rescue", folder: manager.folderOf(view.entry) });
        return done.kind === "rescue"
          ? {
              rescue: {
                file: done.file,
                tables: done.tables,
                rows: done.rows,
                failed: done.failed,
              },
            }
          : {};
      } catch (error) {
        throw failure(error);
      }
    },

    "space/claim": async (params, cls) => {
      userOnly(cls);
      const view = find(required(params, "space"));
      if (view.state !== "read_only" || view.reason !== "read_only_copy") {
        throw notClaimable(view);
      }
      let change;
      try {
        change = await manager.claim(view.entry);
      } catch (error) {
        throw failure(error);
      }
      // The claimed copy is the space from now on, also after a restart: every other entry of the
      // space (none of them is served while this one is) is recorded closed, so the list shows this
      // copy as the space. That this copy is the one opened at a start is the space settings'
      // `writer_folder` (spaces.ts openAll), which its open after the claim recorded.
      const claimed = viewOf(view.entry);
      return {
        space: describe(claimed),
        epoch: change.epoch,
        incarnation: change.incarnation,
        warning: CLAIM_WARNING,
        ...remember(claimed, true, { others: { keep: [] } }),
      };
    },

    "space/recover": async (params, cls) => {
      userOnly(cls);
      const view = find(required(params, "space"));
      // Nothing to do is not a failure: the answer says so, and nothing is changed or recorded.
      if (view.state !== "unavailable" || view.reason !== "needs_recovery") {
        return { space: describe(view), recovered: false };
      }
      // The folder must still hold the space its entry names. Its database cannot be read before
      // the journal is played back, so its space.json is what is checked, when it is there; the
      // open after the recovery checks the database (A2 3.10.1).
      const folder = manager.folderOf(view.entry);
      let named: string | undefined;
      try {
        const read = readManifest(folder);
        named = read.state === "present" ? read.safety.space_id : undefined;
      } catch {
        named = undefined;
      }
      if (named !== undefined && view.registered !== undefined && named !== view.registered) {
        throw new AppError(storageFailureBody("SPACE_ID_MISMATCH"));
      }
      try {
        await manager.recover(view.entry);
      } catch (error) {
        throw failure(error);
      }
      const recovered = viewOf(view.entry);
      return { space: describe(recovered), recovered: true, ...remember(recovered, true) };
    },
  };
}
