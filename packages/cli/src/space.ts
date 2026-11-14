// `tasks space` (A2 3.10.1, A1 3.18): local commands that the service carries out
// through its `space/*` methods. The CLI opens no space database itself. Paths are resolved here,
// against the CLI's working folder, and sent absolute.
//
//   tasks space list
//   tasks space create <name> [--path <folder>] [--prefix <P>]
//   tasks space open <folder> [--excluded] [--retry-migration]
//   tasks space close [<space>]
//   tasks space backup [<space>]
//   tasks space backups [list] [<space>]
//   tasks space restore <backup> --to <folder>       a read-only copy until it is claimed
//   tasks space restore <backup> --in-place [<space>]
//   tasks space claim [<space>]
//   tasks space recover [<space>]
//   tasks space use <space>                          the machine's default space
//
// <space> is an ID, a name or a folder; without one, --space, else the one space the service has.
import { isAbsolute, join, resolve } from "node:path";
import { CLI_NAME } from "@tasks/brand";
import { hostFacts, resolveLayout } from "@tasks/service/paths";
import { UsageError, type Globals } from "./args.ts";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { bodyOf, printError, printUsage, str } from "./output.ts";
import { asAppError } from "./verbs.ts";

/** `tasks space --help` and `tasks help space`. */
export const SPACE_HELP = `Usage: tasks space <command> [arguments] [--json]

  list                                     The spaces of the service, with their state and folder
  create <name> [--path <folder>] [--prefix <P>]
  open <folder> [--excluded]               Serve a space folder; --excluded: its synced folder
       [--retry-migration]                 is excluded from sync, so it opens for writing;
                                           --retry-migration: try a migration that failed again
  close [<space>]                        Close a space while the service keeps running
  backup [<space>]                         Take a backup now
  backups [list] [<space>]                 The backups of a space
  restore <backup> --to <folder>           Restore into a new folder: a read-only copy
  restore <backup> --in-place [<space>]    Replace the space with the backup, keeping the old folder
  claim [<space>]                          Make a read-only copy this machine's
  recover [<space>]                        Play back a space's rollback journal
  use <space>                             Make it the default: what a new tab and a command
                                           without --space open

<space> is an ID, a name or a folder. Without one, --space, else the one space the service serves.
Only the user can run these, in an interactive terminal; list works everywhere.
`;

interface SpaceRow {
  entry: number;
  id?: string;
  name?: string;
  ref_prefix?: string;
  state: string;
  reason?: string;
  folder?: string;
  leftovers?: string[];
  /**
   * Why a read-only space is read-only, in the service's words: A1 3.2's for a synced or network
   * folder, or a failed migration's (A1 3.17: what happened, and the barrier backup's name).
   */
  message?: string;
}

/** Options of a space command: `--name value` or `--flag`. Values are never shown in errors. */
function options(
  args: readonly string[],
  valued: readonly string[],
  flags: readonly string[],
): { positional: string[]; values: Map<string, string>; set: Set<string> } {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const set = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq > 0 ? token.slice(0, eq) : token;
      if (flags.includes(name) && eq < 0) {
        set.add(name);
        continue;
      }
      if (!valued.includes(name))
        throw new UsageError(
          `tasks space has no option ${/^--[a-z-]{1,30}$/.test(name) ? name : "like that"}`,
        );
      const value = eq > 0 ? token.slice(eq + 1) : args[(i += 1)];
      if (value === undefined) throw new UsageError(`${name} needs a value`);
      values.set(name, value);
      continue;
    }
    positional.push(token);
  }
  return { positional, values, set };
}

const absolute = (io: Io, path: string): string =>
  isAbsolute(path) ? resolve(path) : resolve(io.cwd, path);

/** A name's folder name: lower case letters, digits and hyphens. */
function slugOf(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug === "" ? "space" : slug;
}

/**
 * Where a new space goes by default: the data folder's `spaces/<slug>`, so `~/.tasks/spaces/<slug>`
 * or `<TASKS_HOME>/spaces/<slug>` (A2 3.2.1).
 */
function defaultFolder(io: Io, name: string): string {
  return join(resolveLayout(hostFacts(io.env, io.platform)).spaces, slugOf(name));
}

/**
 * The ways out of a space that is read-only for its folder (A1 3.2), as the person
 * runs them: confirm a synced folder is excluded from sync, or restore a backup into a new local
 * folder and claim the copy, which leaves the old folder where it is. A database that failed its
 * check gets none: its words name the restore of a verified backup, and a new backup of it fails.
 * The backup's file is in the space's own backups folder: machine-local `backup.dir` is written
 * by no command yet.
 */
export function wayOut(row: Pick<SpaceRow, "state" | "reason"> & Partial<SpaceRow>): string[] {
  if (row.state !== "read_only") return [];
  if (row.reason !== "synced_folder" && row.reason !== "network_filesystem") return [];
  const backup = [
    "To move the space, restore a backup into a new local folder and claim the copy:",
    `  ${CLI_NAME} space backup <folder>`,
    `  ${CLI_NAME} space restore <folder>/backups/<name>.db.gz --to <new folder>`,
    `  ${CLI_NAME} space claim <new folder>`,
    "<name> is the name the backup prints. <new folder> must not exist yet.",
    "The old folder stays where it is, read-only, and keeps all its files.",
    "If machine.toml names the old folder, change that path to the new folder: the next start then opens the copy.",
  ];
  return row.reason === "network_filesystem"
    ? backup
    : [
        `If this folder is excluded from sync, open it for writing: ${CLI_NAME} space open <folder> --excluded`,
        ...backup,
      ];
}

function printSpace(io: Io, row: SpaceRow, verb: string, isDefault = false): void {
  const name = row.name ?? "(unnamed)";
  const state = `${row.reason === undefined ? row.state : `${row.state}: ${row.reason}`}${isDefault ? ", default" : ""}`;
  io.stdout(
    `${verb}${name}${row.ref_prefix === undefined ? "" : ` (${row.ref_prefix})`}  ${state}${row.id === undefined ? "" : `  ${row.id}`}${row.folder === undefined ? "" : `  ${row.folder}`}\n`,
  );
  if (row.message !== undefined) io.stdout(`  ${row.message}\n`);
  for (const line of wayOut(row)) io.stdout(`  ${line}\n`);
}

export async function spaceCommand(
  io: Io,
  globals: Globals,
  args: readonly string[],
  connect: ConnectOptions,
): Promise<number> {
  const [sub, ...rest] = args;
  let session: Session | undefined;
  const call = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    session ??= await connectService(io, connect);
    return (await session.call(method, params, {
      timeoutMs: Math.max(globals.timeoutS, 120) * 1000,
    })) as Record<string, unknown>;
  };
  /**
   * The space a command names, in A2 3.10.5's order as op/call takes it: its argument, --space,
   * TASKS_SPACE, else the one space the service has. That one is sent by its folder, never its
   * ID: a restored copy shares its original's ID, and the service must act on the space that was
   * chosen here.
   */
  const which = async (given: string | undefined): Promise<string> => {
    const fromEnv = io.env["TASKS_SPACE"];
    const named = given ?? globals.space ?? (fromEnv === "" ? undefined : fromEnv);
    if (named !== undefined)
      return isAbsolute(named) || named.includes("/") || named.includes("\\")
        ? absolute(io, named)
        : named;
    const listed = (await call("space/list", {}))["spaces"] as SpaceRow[];
    const only = listed.filter((s) => s.state !== "closed");
    const folder = only.length === 1 ? only[0]?.folder : undefined;
    if (folder !== undefined) return folder;
    throw new UsageError("Name the space: an ID, a name or a folder");
  };
  const out = (result: Record<string, unknown>, text: () => void): void => {
    if (globals.json) io.stdout(`${JSON.stringify(result)}\n`);
    else text();
  };
  try {
    switch (sub) {
      case undefined:
      case "list": {
        const result = await call("space/list", {});
        out(result, () => {
          const spaces = result["spaces"] as SpaceRow[];
          if (spaces.length === 0)
            io.stdout("No spaces. Create one with: tasks space create <name>\n");
          for (const row of spaces) {
            printSpace(io, row, "", row.id !== undefined && row.id === result["default"]);
            for (const left of row.leftovers ?? []) io.stdout(`  leftover ${left}\n`);
          }
        });
        return 0;
      }
      case "create": {
        const o = options(rest, ["--path", "--prefix"], []);
        const name = o.positional[0];
        if (name === undefined || o.positional.length > 1)
          throw new UsageError("tasks space create takes one <name>");
        const path = o.values.get("--path");
        const result = await call("space/create", {
          name,
          path: path === undefined ? defaultFolder(io, name) : absolute(io, path),
          ...(o.values.has("--prefix") ? { ref_prefix: o.values.get("--prefix") } : {}),
        });
        out(result, () => {
          printSpace(io, result["space"] as SpaceRow, "Created ");
        });
        return 0;
      }
      case "open": {
        const o = options(rest, [], ["--excluded", "--retry-migration"]);
        const folder = o.positional[0];
        if (folder === undefined || o.positional.length > 1)
          throw new UsageError("tasks space open takes one <folder>");
        const result = await call("space/open", {
          path: absolute(io, folder),
          ...(o.set.has("--excluded") ? { excluded: true } : {}),
          ...(o.set.has("--retry-migration") ? { retry_migration: true } : {}),
        });
        out(result, () => {
          printSpace(io, result["space"] as SpaceRow, "Opened ");
        });
        return 0;
      }
      case "close":
      case "backup":
      case "claim":
      case "recover": {
        const o = options(rest, [], []);
        if (o.positional.length > 1) throw new UsageError(`tasks space ${sub} takes one <space>`);
        const result = await call(`space/${sub}`, { space: await which(o.positional[0]) });
        out(result, () => {
          if (sub === "backup") {
            const backup = result["backup"] as Record<string, unknown>;
            io.stdout(`Backed up to ${String(backup["name"])} (seq ${String(backup["seq"])})\n`);
          } else {
            const verb = { close: "Closed ", claim: "Claimed ", recover: "Recovered " }[sub];
            printSpace(io, result["space"] as SpaceRow, verb);
          }
        });
        return 0;
      }
      case "backups": {
        const o = options(rest[0] === "list" ? rest.slice(1) : rest, [], []);
        if (o.positional.length > 1) throw new UsageError("tasks space backups takes one <space>");
        const result = await call("space/backups", { space: await which(o.positional[0]) });
        out(result, () => {
          const backups = result["backups"] as Record<string, unknown>[];
          if (backups.length === 0) io.stdout("No backups.\n");
          for (const b of backups) {
            io.stdout(
              `${str(b["name"])}  ${str(b["state"])}${b["size"] === undefined ? "" : `  ${str(b["size"])} bytes`}\n`,
            );
          }
          for (const name of result["leftovers"] as string[]) io.stdout(`leftover ${name}\n`);
        });
        return 0;
      }
      case "restore": {
        const o = options(rest, ["--to", "--in-place"], ["--in-place"]);
        const backup = o.positional[0];
        if (backup === undefined || o.positional.length > 2)
          throw new UsageError("tasks space restore takes one <backup>");
        const to = o.values.get("--to");
        const inPlace = o.set.has("--in-place") || o.values.has("--in-place");
        if ((to === undefined) === !inPlace)
          throw new UsageError("tasks space restore takes --to <folder> or --in-place");
        const file =
          isAbsolute(backup) ||
          backup.includes("/") ||
          backup.includes("\\") ||
          (backup.endsWith(".db.gz") && to !== undefined)
            ? absolute(io, backup)
            : backup;
        const result = await call("space/restore", {
          backup: file,
          ...(to === undefined
            ? { space: await which(o.values.get("--in-place") ?? o.positional[1]) }
            : { to: absolute(io, to) }),
        });
        out(result, () => {
          printSpace(io, result["space"] as SpaceRow, "Restored ");
          if (result["read_only_copy"] === true) {
            io.stdout(
              "This is a read-only copy. Claim it to write to it: tasks space claim <space>\n",
            );
          }
        });
        return 0;
      }
      case "use": {
        const o = options(rest, [], []);
        const wanted = o.positional[0];
        if (wanted === undefined || o.positional.length > 1)
          throw new UsageError(`${CLI_NAME} space use takes one <space>`);
        // The service takes the ID: a name or a folder is resolved here, and two spaces that
        // match are never decided between.
        const listed = (await call("space/list", {}))["spaces"] as SpaceRow[];
        const folder =
          isAbsolute(wanted) || /[/\\]/.test(wanted) ? absolute(io, wanted) : undefined;
        const fold = (s: string) => (io.platform === "linux" ? s : s.toLowerCase());
        const matches = listed.filter((row) =>
          folder !== undefined
            ? row.folder !== undefined && fold(row.folder) === fold(folder)
            : row.id === wanted || row.name?.toLowerCase() === wanted.toLowerCase(),
        );
        const byId = matches.filter((row) => row.id === wanted);
        const chosen = byId.length > 0 ? byId : matches;
        if (chosen.length > 1) throw new UsageError("Several spaces match: name it by its folder");
        const id = chosen[0]?.id;
        if (id === undefined) throw new UsageError("No space of the service matches");
        const result = await call("space/use", { space: id });
        out(result, () => {
          io.stdout(`New tabs and commands without --space now use ${chosen[0]?.name ?? id}.\n`);
        });
        return 0;
      }
      default:
        throw new UsageError(
          `${CLI_NAME} space has list, create, open, close, backup, backups, restore, claim, recover and use`,
        );
    }
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    return printError(io, globals.json, bodyOf(asAppError(error)));
  } finally {
    session?.close();
  }
}
