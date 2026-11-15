// The service's side of `tasks space` (A2 3.10.1, A1 3.18): rpc
// methods `space/*`, registered in the handler table (endpoint.ts). Every one but `space/list` is
// a user-only operation: the method table lets only `cli-interactive` call them (A2 3.6.5), and
// each checks the class again, so another transport that reaches them refuses agents too.
//
//   space/list      the registered spaces with their state and folder, and the default space
//   space/create    a new space folder, then served          (createSpace, in a worker)
//   space/open      serve a space folder while the service runs; `retry_migration` tries a failed
//                   migration again (A1 3.17)
//   space/close     close one space while the service keeps running (A1 3.1)
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
//
// A1 3.2: a space in a synced folder opens read-only until the person confirms the folder is
// excluded from sync (`space/open` with `excluded`), and one on a network file system is never
// written. A new folder for a space (create, restore into a new folder) is checked first: a
// network file system is refused, and a new space in a synced folder opens read-only.
//
// The service registers the enabled `[[spaces]]` of machine.toml at start (A2 3.1). A space
// that `create`, `open` or `restore --to` adds is served until the service stops, and its entry
// opens only as that one space, as a `[[spaces]]` entry does; writing it to machine.toml is the
// step that adds `tasks space add`.
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { PRODUCT_NAME } from "@tasks/brand";
import { AppError } from "@tasks/contracts";
import {
  backupsFolder,
  exportsFolder,
  listBackups,
  StorageError,
  type Id,
  type MachineInfo,
} from "@tasks/storage";
import type { JsonObject } from "@tasks/bridge/protocol";
import type { ConnectionClass } from "../local/index.ts";
import { unsupported } from "../ops/errors.ts";
import { isUserClass } from "../ops/index.ts";
import { storageFailureBody } from "./space-errors.ts";
import { AdminFailed, runAdmin, type AdminResult } from "./space-admin.ts";
import { readSpaceSettings } from "./space-settings.ts";
import type { SpaceManager, SpaceView } from "./spaces.ts";
import type { FolderCheck } from "./sync-folders.ts";

export interface SpaceVerbsHost {
  readonly manager: Pick<
    SpaceManager,
    | "list"
    | "open"
    | "close"
    | "claim"
    | "restoreInPlace"
    | "recover"
    | "folderOf"
    | "checkFolder"
    | "confirmExcluded"
  >;
  readonly machine: MachineInfo;
  /** The state folder, for each space's machine-local settings (`backup.dir`). */
  readonly settingsDir: string;
  /** The machine's default space (A2 3.1), which `space/list` names. */
  readonly defaultSpace?: () => string | undefined;
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

/** A storage failure, or a worker's code, as A3's error body. */
function failure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof AdminFailed) {
    const body = storageFailureBody(error.code);
    // An export's secret scan says what kind of secret it found and where: words, never text.
    return new AppError(
      error.secret === undefined
        ? body
        : { ...body, data: { ...body.data, secret: { ...error.secret } } },
    );
  }
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

const same = (a: string, b: string): boolean =>
  process.platform === "win32" || process.platform === "darwin"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;

export function spaceVerbs(host: SpaceVerbsHost): Readonly<Record<string, Verb>> {
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

  const describe = (view: SpaceView) => {
    const folder = manager.folderOf(view.entry);
    const leftovers = leftoversOf(folder);
    return { ...view, folder, ...(leftovers.length === 0 ? {} : { leftovers }) };
  };

  /**
   * A space by folder, ID or name (an unavailable space has no ID or name yet). An absolute path
   * is a folder and only a folder, so a space whose name looks like a path never stands in for the
   * space at that path. A restored copy has its original's ID and name, so an ID or a name that two
   * registered spaces share is `ambiguous`, never the first one listed: only the folder names one
   * of them for certain.
   */
  const find = (wanted: string): SpaceView => {
    const views = manager.list();
    if (isAbsolute(wanted)) {
      const folder = resolve(wanted);
      const byFolder = views.find((v) => same(manager.folderOf(v.entry), folder));
      if (byFolder !== undefined) return byFolder;
      throw new AppError({
        code: "not_found",
        message: "The service has no space in that folder.",
        hint: "Run tasks space list.",
      });
    }
    const byId = views.filter((v) => v.id === wanted);
    const found =
      byId.length > 0 ? byId : views.filter((v) => v.name?.toLowerCase() === wanted.toLowerCase());
    if (found.length > 1) {
      throw new AppError({
        code: "ambiguous",
        message:
          byId.length > 1 ? "Several spaces have this ID." : "Several spaces have this name.",
        hint: "Name the space by its folder: tasks space list.",
      });
    }
    if (found[0] !== undefined) return found[0];
    throw new AppError({
      code: "not_found",
      message: "The service has no space by that ID or name.",
      hint: "Run tasks space list.",
    });
  };

  const viewOf = (entry: number): SpaceView => {
    const view = manager.list()[entry];
    if (view === undefined)
      throw new AppError({ code: "internal", message: "A space is missing." });
    return view;
  };

  const backupDirOf = (view: SpaceView): string => {
    const settings = view.id === undefined ? {} : readSpaceSettings(host.settingsDir, view.id);
    return settings.backupDir ?? backupsFolder(manager.folderOf(view.entry));
  };

  return {
    "space/list": () =>
      Promise.resolve({
        spaces: manager.list().map(describe),
        default: host.defaultSpace?.() ?? null,
      }),

    "space/create": async (params, cls) => {
      userOnly(cls);
      const name = required(params, "name", 100);
      const folder = absolute(params, "path");
      const refPrefix = text(params, "ref_prefix", 6);
      return oneAtATime(async () => {
        const taken = manager
          .list()
          .flatMap((v) => (v.ref_prefix === undefined ? [] : [v.ref_prefix]));
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
          // The entry opens only as the space just made (A2 3.2.4).
          const entry = await manager.open(folder, spaceOf(created));
          return { space: describe(viewOf(entry)) };
        } catch (error) {
          throw failure(error);
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
          const entry = await manager.open(folder, undefined, { retryMigration });
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
          return { space: describe(viewOf(entry)) };
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
      return { space: describe(viewOf(view.entry)) };
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
        return done.kind === "backup" ? { backup: done.backup } : {};
      } catch (error) {
        throw failure(error);
      }
    },

    "space/backups": (params, cls) => {
      userOnly(cls);
      const view = find(required(params, "space"));
      const dir = backupDirOf(view);
      try {
        const listing = listBackups(dir);
        return Promise.resolve({
          folder: dir,
          backups: listing.backups.map((b) => ({
            name: b.name,
            state: b.state,
            ...(b.sidecar === undefined
              ? {}
              : {
                  kind: b.sidecar.kind,
                  created_at: new Date(b.sidecar.created_at).toISOString(),
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
      if (mode === "transfer") throw unsupported("mode", "M3.08");
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
        if (of.id === undefined) throw invalid("of", "The space's ID is not known yet");
        const target = resolve(to);
        const spaceId = of.id;
        try {
          return await oneAtATime(async () => {
            refuseNetwork(await manager.checkFolder(target), "to");
            const restored = await runAdmin({
              kind: "restore-latest",
              backupDir: backupDirOf(of),
              spaceId,
              target,
            });
            const entry = await manager.open(target, spaceOf(restored));
            return {
              space: describe(viewOf(entry)),
              read_only_copy: true,
              ...(restored.kind === "restore" && restored.backup !== undefined
                ? { backup: restored.backup }
                : {}),
            };
          });
        } catch (error) {
          throw failure(error);
        }
      }
      // A backup's or a bundle's file, or its name: a backup's in the backups folder of the space
      // it restores, a bundle's (`.zip`) in its exports folder.
      let file: string;
      if (isAbsolute(backup)) file = resolve(backup);
      else if (inPlace !== undefined && /^[A-Za-z0-9._-]+$/.test(backup)) {
        const space = find(inPlace);
        file = /\.zip$/i.test(backup)
          ? join(exportsFolder(manager.folderOf(space.entry)), backup)
          : join(backupDirOf(space), backup.endsWith(".db.gz") ? backup : `${backup}.db.gz`);
      } else throw invalid("backup", "Expected the backup's file as an absolute path");
      try {
        if (to !== undefined) {
          if (!isAbsolute(to)) throw invalid("to", "Expected an absolute path");
          const target = resolve(to);
          return await oneAtATime(async () => {
            refuseNetwork(await manager.checkFolder(target), "to");
            const restored = await runAdmin({ kind: "restore", backupFile: file, target });
            const entry = await manager.open(target, spaceOf(restored));
            return { space: describe(viewOf(entry)), read_only_copy: true };
          });
        }
        const view = find(inPlace ?? "");
        const change = await manager.restoreInPlace(view.entry, file);
        return {
          space: describe(viewOf(view.entry)),
          epoch: change.epoch,
          incarnation: change.incarnation,
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
        throw new AppError({
          code: "invalid_input",
          message: "Only a read-only copy is claimed.",
          data: { issues: [{ path: "space", message: "Not a read-only copy" }] },
        });
      }
      try {
        const change = await manager.claim(view.entry);
        return {
          space: describe(viewOf(view.entry)),
          epoch: change.epoch,
          incarnation: change.incarnation,
        };
      } catch (error) {
        throw failure(error);
      }
    },

    "space/recover": async (params, cls) => {
      userOnly(cls);
      const view = find(required(params, "space"));
      if (view.state !== "unavailable" || view.reason !== "needs_recovery") {
        throw new AppError({
          code: "invalid_input",
          message: "The space needs no recovery.",
          data: { issues: [{ path: "space", message: "Not refused with a rollback journal" }] },
        });
      }
      try {
        await manager.recover(view.entry);
      } catch (error) {
        throw failure(error);
      }
      return { space: describe(viewOf(view.entry)), recovered: true };
    },
  };
}
