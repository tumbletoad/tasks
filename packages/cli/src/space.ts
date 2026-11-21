// `ttasks space` (A2 3.10.1, A1 3.18): local commands that the service carries out
// through its `space/*` methods. The CLI opens no space database itself. Paths are resolved here,
// against the CLI's working folder, and sent absolute.
//
//   ttasks space list
//   ttasks space create <name> [--path <folder>] [--prefix <P>]
//   ttasks space open <folder> [--excluded] [--retry-migration]
//   ttasks space close [<space>]
//   ttasks space forget <space>                       a closed space off the list; its folder stays
//   ttasks space backup [<space>]
//   ttasks space backups [list] [<space>]
//   ttasks space export [<space>] [--mode backup|fork] [--with-jsonl]
//   ttasks space restore <backup> --to <folder>       a read-only copy until it is claimed
//   ttasks space restore <backup> --in-place [<space>]
//                                                    <backup> is a backup or an export bundle
//   ttasks space restore latest [<space>] --to <folder>
//   ttasks space rescue [<space>]                     the readable rows into exchange/rescued
//   ttasks space claim [<space>]
//   ttasks space recover [<space>]                    also as `ttasks recover [<space>]`
//   ttasks space use <space>                          the machine's default space
//
// <space> is an ID, a name or a folder; without one, --space, else the one space the service has.
// Which copy of a space an ID or a name means is the service's one rule (A2 3.10.5): the writable
// copy, and a read-only copy by its folder.
//
// The service records what create, open, close, restore and claim do in machine.toml, so it holds
// after a restart. When it cannot, the answer's `not_remembered` line says why, on stderr.
import { isAbsolute, resolve } from "node:path";
import { CLI_NAME } from "@ttasks/brand";
import { isAmbiguity, onlySpace } from "@ttasks/service/copies";
import { defaultSpaceFolder, hostFacts, resolveLayout } from "@ttasks/service/paths";
import { UsageError, type Globals } from "./args.ts";
import { connectService, type ConnectOptions, type Session } from "./connect.ts";
import type { Io } from "./io.ts";
import { migratedLine, type Migrated } from "./migrations.ts";
import { bodyOf, printError, printUsage, str } from "./output.ts";
import { asAppError } from "./verbs.ts";

/** `ttasks space --help` and `ttasks help space`. */
export const SPACE_HELP = `Usage: ttasks space <command> [arguments] [--json]

  list                                     The spaces of the service, with their state and folder
  create <name> [--path <folder>] [--prefix <P>]
  open <folder> [--excluded]               Serve a space folder; --excluded: its synced folder
       [--retry-migration]                 is excluded from sync, so it opens for writing;
                                           --retry-migration: try a migration that failed again
  close [<space>]                          Close a space while the service keeps running
  forget <space>                           Take a closed space off the list. Its folder and files
                                           stay; space open <folder> lists it again
  backup [<space>]                         Take a backup now
  backups [list] [<space>]                 The backups of a space
  export [<space>] [--mode backup|fork]    Write an export bundle into the space's exports folder,
         [--with-jsonl]                    the copy to keep off this machine; --with-jsonl adds
                                           every table as JSON lines
  restore <backup> [<space>] --to <folder> Restore a backup or a bundle into a new folder: a
                                           read-only copy. A <backup> given by its name is one of
                                           <space>'s
  restore latest [<space>] --to <folder>   Restore the space's newest backup that verifies
  restore <backup> --in-place [<space>]    Replace the space with the backup, keeping the old
                                           folder. Name the space when several are open: this
                                           one does not take the default
  rescue [<space>]                         Write the rows that can still be read into the space's
                                           exchange/rescued folder
  claim [<space>]                          Make a restored copy this machine's
  recover [<space>]                        Play back a space's rollback journal (also: ttasks recover)
  use <space>                              Make it the default: what a new tab and a command
                                           without --space open

<space> is an ID, a name or a folder. Without one: --space, TTASKS_SPACE, the default space
(ttasks space use), else the one space the service serves; recover takes the space that needs it
and claim the restored copy. An ID or a name means the copy that takes writes; name a restored
copy beside it by its folder. <backup> is a file, or a name ttasks space backups prints. A space
stays open or closed as you left it, also after a restart: the service records it in machine.toml.
Only the user can run these, from a terminal; list and backups work everywhere.
`;

export interface SpaceRow {
  entry: number;
  id?: string;
  /** The ID the entry names, also before the space has been served (closed, unavailable). */
  registered?: string;
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
  /** The newest migration this machine ran on the space, with the backup from just before it. */
  migrated?: Migrated;
  /** An open space whose backups are not working: what happened and what to do. */
  backup?: { why?: string; message?: string };
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
          `ttasks space has no option ${/^--[a-z-]{1,30}$/.test(name) ? name : "like that"}`,
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

const defaultFolder = (io: Io, name: string): string =>
  defaultSpaceFolder(resolveLayout(hostFacts(io.env, io.platform)), name);

/** A1 3.2's two actions for a database that failed its check, as the person runs them. */
const CHECK_FAILED_WAY = [
  "Restore the newest backup that verifies into a new local folder, or keep the rows that can still be read:",
  `  ${CLI_NAME} space restore latest <folder> --to <new folder>`,
  `  ${CLI_NAME} space rescue <folder>`,
  "<new folder> must not exist yet. The rescue writes a file into <folder>/exchange/rescued. The old folder keeps all its files.",
];

/**
 * The ways out of a space that is read-only for its folder (A1 3.2), as the person
 * runs them: confirm a synced folder is excluded from sync, or restore a backup into a new local
 * folder and claim the copy, which leaves the old folder where it is. A database that failed its
 * check gets its two actions instead, and never a new backup of it: restore the newest backup
 * that verifies into a new folder, or rescue the rows that can still be read. The backup's file is
 * in the space's own backups folder: machine-local `backup.dir` is written by no command yet.
 */
export function wayOut(row: Pick<SpaceRow, "state" | "reason"> & Partial<SpaceRow>): string[] {
  if (row.state !== "read_only") return [];
  // A1 3.2's two actions for a failed check: never a new backup of the damaged database.
  if (row.reason === "check_failed") return CHECK_FAILED_WAY;
  if (row.reason !== "synced_folder" && row.reason !== "network_filesystem") return [];
  const backup = [
    "To move the space, restore a backup into a new local folder and claim the copy:",
    `  ${CLI_NAME} space backup <folder>`,
    `  ${CLI_NAME} space restore <folder>/backups/<name>.db.gz --to <new folder>`,
    `  ${CLI_NAME} space claim <new folder>`,
    "<name> is the name the backup prints. <new folder> must not exist yet.",
    "The old folder stays where it is, read-only, and keeps all its files.",
    `The copy opens at every start from now on. Close the old folder when you no longer need it: ${CLI_NAME} space close <folder>`,
  ];
  return row.reason === "network_filesystem"
    ? backup
    : [
        `If this folder is excluded from sync, open it for writing: ${CLI_NAME} space open <folder> --excluded`,
        ...backup,
      ];
}

function printSpace(io: Io, row: SpaceRow, verb: string, isDefault = false): void {
  // A space not served since the start (closed, or unavailable) has no name read yet.
  const name = row.name ?? (row.state === "closed" ? "(not open)" : "(unnamed)");
  const state = `${row.reason === undefined ? row.state : `${row.state}: ${row.reason}`}${isDefault ? ", default" : ""}`;
  const id = row.id ?? row.registered;
  io.stdout(
    `${verb}${name}${row.ref_prefix === undefined ? "" : ` (${row.ref_prefix})`}  ${state}${id === undefined ? "" : `  ${id}`}${row.folder === undefined ? "" : `  ${row.folder}`}\n`,
  );
  if (row.message !== undefined) io.stdout(`  ${row.message}\n`);
  if (row.migrated !== undefined) io.stdout(`  ${migratedLine(row.migrated)}\n`);
  if (row.backup?.message !== undefined) io.stdout(`  ${row.backup.message}\n`);
  for (const line of wayOut(row)) io.stdout(`  ${line}\n`);
}

/**
 * What the service could not record in machine.toml (A2 3.10.1): the verb was done for this run,
 * and this line says what a restart does instead, and why. On stderr, beside the result.
 */
function printNotRemembered(io: Io, result: Record<string, unknown>): void {
  const line = result["not_remembered"];
  if (typeof line === "string") io.stderr(`${line}\n`);
}

/** How a command picks its space when none is named. */
export interface Unnamed {
  /**
   * False: the machine's default space is not taken, only the one space the service serves. For a
   * command that replaces a space's contents, which a wrong default would aim at the wrong one.
   */
  readonly useDefault?: boolean;
  /** When exactly one served space passes this, that one: `recover` finds the space that needs it. */
  readonly prefer?: (row: Pick<SpaceRow, "state" | "reason">) => boolean;
}

/**
 * The space a command names, in the order op/call takes it: its argument, --space, TTASKS_SPACE,
 * the machine's default space (`ttasks space use`), else the one space the service has. A copy is
 * picked by the one rule for copies (the writable one) and sent by its folder, never its ID, so the
 * service acts on the copy that was chosen here. `ttasks view` names its space the same way.
 */
export async function whichSpace(
  io: Io,
  globals: Globals,
  given: string | undefined,
  call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  unnamed: Unnamed = {},
): Promise<string> {
  const fromEnv = io.env["TTASKS_SPACE"];
  const named = given ?? globals.space ?? (fromEnv === "" ? undefined : fromEnv);
  if (named !== undefined)
    return isAbsolute(named) || named.includes("/") || named.includes("\\")
      ? absolute(io, named)
      : named;
  const result = await call("space/list", {});
  const live = (result["spaces"] as SpaceRow[])
    .filter((s) => s.state !== "closed")
    .map((s) => ({ ...s, id: s.id ?? s.registered }));
  const folderOf = (rows: typeof live): string | undefined => {
    const found = onlySpace(rows);
    return found === "several" || isAmbiguity(found) ? undefined : found?.folder;
  };
  const preferred = unnamed.prefer === undefined ? [] : live.filter(unnamed.prefer);
  if (preferred.length === 1 && preferred[0]?.folder !== undefined) return preferred[0].folder;
  const defaultId = result["default"];
  if (unnamed.useDefault !== false && typeof defaultId === "string") {
    const folder = folderOf(live.filter((s) => s.id === defaultId));
    if (folder !== undefined) return folder;
  }
  const folder = folderOf(live);
  if (folder !== undefined) return folder;
  throw new UsageError(
    unnamed.useDefault === false
      ? "Name the space: an ID, a name or a folder. This command does not take the default space, since it replaces the space's contents"
      : "Name the space: an ID, a name or a folder, or make one the default: ttasks space use <space>",
  );
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
  const which = (given: string | undefined): Promise<string> =>
    whichSpace(io, globals, given, call);
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
            io.stdout("No spaces. Create one with: ttasks space create <name>\n");
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
          throw new UsageError("ttasks space create takes one <name>");
        const path = o.values.get("--path");
        const result = await call("space/create", {
          name,
          path: path === undefined ? defaultFolder(io, name) : absolute(io, path),
          ...(o.values.has("--prefix") ? { ref_prefix: o.values.get("--prefix") } : {}),
        });
        out(result, () => {
          printSpace(io, result["space"] as SpaceRow, "Created ");
          printNotRemembered(io, result);
        });
        return 0;
      }
      case "open": {
        const o = options(rest, [], ["--excluded", "--retry-migration"]);
        const folder = o.positional[0];
        if (folder === undefined || o.positional.length > 1)
          throw new UsageError("ttasks space open takes one <folder>");
        const result = await call("space/open", {
          path: absolute(io, folder),
          ...(o.set.has("--excluded") ? { excluded: true } : {}),
          ...(o.set.has("--retry-migration") ? { retry_migration: true } : {}),
        });
        out(result, () => {
          printSpace(io, result["space"] as SpaceRow, "Opened ");
          printNotRemembered(io, result);
        });
        return 0;
      }
      case "close":
      case "backup":
      case "claim":
      case "recover": {
        const o = options(rest, [], []);
        if (o.positional.length > 1) throw new UsageError(`ttasks space ${sub} takes one <space>`);
        // Unnamed, `recover` takes the one space that needs a recovery and `claim` the one restored
        // copy, before the default.
        const prefer: Unnamed["prefer"] =
          sub === "recover"
            ? (row) => row.reason === "needs_recovery"
            : sub === "claim"
              ? (row) => row.reason === "read_only_copy"
              : undefined;
        const space = await whichSpace(io, globals, o.positional[0], call, {
          ...(prefer === undefined ? {} : { prefer }),
        });
        const result = await call(`space/${sub}`, { space });
        out(result, () => {
          if (sub === "backup") {
            const backup = result["backup"] as Record<string, unknown>;
            io.stdout(`Backed up to ${String(backup["name"])} (seq ${String(backup["seq"])})\n`);
          } else if (sub === "recover" && result["recovered"] === false) {
            const row = result["space"] as SpaceRow;
            io.stdout(`${row.name ?? row.folder ?? "The space"} needs no recovery.\n`);
          } else {
            const verb = { close: "Closed ", claim: "Claimed ", recover: "Recovered " }[sub];
            printSpace(io, result["space"] as SpaceRow, verb);
            // A6 3.5's warning at a claim, in the service's words.
            if (typeof result["warning"] === "string") io.stdout(`${result["warning"]}\n`);
            printNotRemembered(io, result);
          }
        });
        return 0;
      }
      case "forget": {
        const o = options(rest, [], []);
        const wanted = o.positional[0];
        if (wanted === undefined || o.positional.length > 1)
          throw new UsageError(`${CLI_NAME} space forget takes one <space>`);
        const result = await call("space/forget", { space: await which(wanted) });
        out(result, () => {
          const row = result["space"] as SpaceRow;
          io.stdout(
            `Forgot ${row.name ?? "the space"}${row.folder === undefined ? "" : ` in ${row.folder}`}. Its folder and files are kept: ${CLI_NAME} space open <folder> lists it again.\n`,
          );
        });
        return 0;
      }
      case "backups": {
        const o = options(rest[0] === "list" ? rest.slice(1) : rest, [], []);
        if (o.positional.length > 1) throw new UsageError("ttasks space backups takes one <space>");
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
      case "export": {
        const o = options(rest, ["--mode", "--to"], ["--with-jsonl"]);
        if (o.positional.length > 1) throw new UsageError("ttasks space export takes one <space>");
        const result = await call("space/export", {
          space: await which(o.positional[0]),
          ...(o.values.has("--mode") ? { mode: o.values.get("--mode") } : {}),
          ...(o.values.has("--to") ? { to: o.values.get("--to") } : {}),
          ...(o.set.has("--with-jsonl") ? { with_jsonl: true } : {}),
        });
        out(result, () => {
          const bundle = result["export"] as Record<string, unknown>;
          io.stdout(
            `Exported to ${str(bundle["file"])} (seq ${str(bundle["seq"])}, ${str(bundle["size"])} bytes)\n`,
          );
          // A6 3.16.6: the export screen says that a bundle is plaintext.
          io.stdout(
            "The bundle is a plain, unencrypted copy of the space. Keep it where only you can read it.\n",
          );
          const secrets = (bundle["secrets"] ?? []) as { kind: string; place: string }[];
          if (secrets.length > 0) {
            const where = secrets.map((s) => `${s.kind.replaceAll("_", " ")} in ${s.place}`);
            io.stdout(
              `Warning: it holds text shaped like a secret (${where.join(", ")}). Whoever reads the bundle can use it.\n`,
            );
          }
        });
        return 0;
      }
      case "restore": {
        const o = options(rest, ["--to", "--in-place"], ["--in-place"]);
        const backup = o.positional[0];
        if (backup === undefined || o.positional.length > 2)
          throw new UsageError("ttasks space restore takes one <backup>");
        const to = o.values.get("--to");
        const inPlace = o.set.has("--in-place") || o.values.has("--in-place");
        if ((to === undefined) === !inPlace)
          throw new UsageError("ttasks space restore takes --to <folder> or --in-place");
        // A path is a file. A bare name is a backup's or a bundle's as `space backups` prints it,
        // in the folders of the space named after it; with --to, a bare file name with its
        // extension stays a file in the working folder.
        const isFile =
          isAbsolute(backup) ||
          backup.includes("/") ||
          backup.includes("\\") ||
          (/\.(?:db\.gz|zip)$/i.test(backup) && to !== undefined);
        const result = await call("space/restore", {
          backup: isFile ? absolute(io, backup) : backup,
          // In place replaces the space's contents: the default space is not taken for it.
          ...(to === undefined
            ? {
                space: await whichSpace(
                  io,
                  globals,
                  o.values.get("--in-place") ?? o.positional[1],
                  call,
                  { useDefault: false },
                ),
              }
            : { to: absolute(io, to) }),
          // `latest` names the space whose newest verified backup it restores, and a backup's name
          // the space it is of.
          ...(to !== undefined && !isFile ? { of: await which(o.positional[1]) } : {}),
        });
        out(result, () => {
          if (typeof result["backup"] === "string") {
            io.stdout(`The newest backup that verifies: ${result["backup"]}\n`);
          }
          printSpace(io, result["space"] as SpaceRow, "Restored ");
          if (result["read_only_copy"] === true) {
            io.stdout(
              `This is a read-only copy. Claim it to write to it: ${CLI_NAME} space claim <folder>\n`,
            );
          }
          printNotRemembered(io, result);
        });
        return 0;
      }
      case "rescue": {
        const o = options(rest, [], []);
        if (o.positional.length > 1) throw new UsageError("ttasks space rescue takes one <space>");
        const result = await call("space/rescue", { space: await which(o.positional[0]) });
        out(result, () => {
          const rescue = result["rescue"] as Record<string, unknown>;
          const failed = rescue["failed"] as string[];
          io.stdout(
            `Rescued ${str(rescue["rows"])} rows of ${str(rescue["tables"])} tables into ${str(rescue["file"])}\n`,
          );
          if (failed.length > 0) io.stdout(`Not read to the end: ${failed.join(", ")}\n`);
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
        // Copies of one space share its ID, which is what the default names: they are one match.
        if (new Set(chosen.map((row) => row.id)).size > 1)
          throw new UsageError("Several spaces match: name it by its folder");
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
          `${CLI_NAME} space has list, create, open, close, forget, backup, backups, export, restore, rescue, claim, recover and use`,
        );
    }
  } catch (error) {
    if (error instanceof UsageError) return printUsage(io, globals.json, error.message);
    return printError(io, globals.json, bodyOf(asAppError(error)));
  } finally {
    session?.close();
  }
}
