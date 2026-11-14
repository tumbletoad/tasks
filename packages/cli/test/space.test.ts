// `tasks space` through the service (A2 3.10.1, A1 3.18): a person at a terminal
// (in this process, with a TTY as the class says) creates, backs up, restores, claims and closes
// spaces; the script and agent classes are refused the user-only verbs; a space read-only for its
// synced or network folder names the ways out (A1 3.2). Fixture text only.
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CLI_NAME } from "@tasks/brand";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { wayOut } from "../src/space.ts";
import { runMain, startWorld, type CliWorld } from "./cli-harness.ts";

let world: CliWorld;

beforeAll(async () => {
  world = await startWorld("sp");
}, 180_000);

afterAll(async () => {
  await world.close();
}, 120_000);

interface Row {
  entry: number;
  id?: string;
  name?: string;
  state: string;
  reason?: string;
  folder: string;
}

const user = (argv: string[]) => runMain(argv, { home: world.home, cwd: world.root, tty: true });
const parsed = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

describe("[A2.3.10.cli.space] tasks space through the service", () => {
  test("the user-only verbs refuse the script and agent classes", async () => {
    for (const env of [{}, { CLAUDECODE: "1" }]) {
      for (const args of [
        ["space", "restore", "backup.db.gz", "--to", "copy"],
        ["space", "claim", "Mira"],
        ["space", "recover", "Mira"],
        ["space", "backup", "Mira"],
        ["space", "create", "Other", "--path", "other"],
      ]) {
        const ran = await world.tasks([...args, "--json"], { env });
        expect(ran.code, args.join(" ")).toBe(5);
        expect(parsed(ran.stdout)).toMatchObject({
          error: { code: "forbidden", class: "forbidden" },
        });
      }
    }
    // Listing is not user-only.
    expect((await world.tasks(["space", "list", "--json"])).code).toBe(0);
  }, 180_000);

  test("--help prints the help and runs nothing", async () => {
    for (const args of [
      ["space", "create", "Helped", "--path", join("s", "helped"), "--help"],
      ["space", "close", "Mira", "--help"],
      ["space", "restore", "missing.db.gz", "--in-place", "Mira", "-h"],
      ["help", "space"],
    ]) {
      const ran = await user(args);
      expect(ran.code, args.join(" ")).toBe(0);
      expect(ran.stdout).toMatch(/^Usage: tasks space/);
    }
    const spaces = parsed((await user(["space", "list", "--json"])).stdout)["spaces"] as Row[];
    expect(spaces.map((s) => [s.name, s.state])).toEqual([["Mira", "open"]]);
  }, 180_000);

  test("create, list, back up, restore in place and into a new folder, claim, close and open", async () => {
    const life = await user(["space", "create", "Life", "--path", join("s", "life"), "--json"]);
    expect(life.code, life.stdout + life.stderr).toBe(0);
    expect(parsed(life.stdout)["space"]).toMatchObject({ name: "Life", state: "open" });

    const listed = await user(["space", "list", "--json"]);
    const spaces = parsed(listed.stdout)["spaces"] as Row[];
    expect(spaces.map((s) => s.name).sort()).toEqual(["Life", "Mira"]);

    // Two spaces: a verb must name one.
    expect((await world.tasks(["status"])).code).toBe(2);
    const addId = "fixture-space-add-0001";
    const added = await world.tasks([
      "add",
      "Fixture task",
      "--space",
      "Mira",
      "--request-id",
      addId,
      "--json",
    ]);
    expect(added.code, added.stderr).toBe(0);
    const miraId = spaces.find((s) => s.name === "Mira")?.id ?? "";

    const backup = await user(["space", "backup", "Mira", "--json"]);
    expect(backup.code, backup.stdout + backup.stderr).toBe(0);
    const name = (parsed(backup.stdout)["backup"] as { name: string }).name;
    const backups = await user(["space", "backups", "list", "Mira", "--json"]);
    const listing = parsed(backups.stdout) as {
      folder: string;
      backups: { name: string; state: string }[];
    };
    expect(listing.backups).toContainEqual(expect.objectContaining({ name, state: "ok" }));

    // In place, by the backup's name: claimed with a new epoch, the old folder kept beside it.
    const inPlace = await user(["space", "restore", name, "--in-place", "Mira", "--json"]);
    expect(inPlace.code, inPlace.stdout + inPlace.stderr).toBe(0);
    expect(parsed(inPlace.stdout)).toMatchObject({ epoch: 2, space: { state: "open" } });
    expect((await world.tasks(["show", "M-1", "--space", "Mira", "--json"])).code).toBe(0);

    // Into a new folder: a read-only copy, which takes no write until it is claimed.
    const copyFolder = join(world.root, "s", "copy");
    const file = join(listing.folder, `${name}.db.gz`);
    const copy = await user(["space", "restore", file, "--to", copyFolder, "--json"]);
    expect(copy.code, copy.stdout + copy.stderr).toBe(0);
    expect(parsed(copy.stdout)).toMatchObject({
      read_only_copy: true,
      space: { state: "read_only", reason: "read_only_copy" },
    });
    // The copy has the original's space ID: the original closes before the copy is claimed.
    // Two spaces are called Mira now: the name is ambiguous, the folder is not.
    expect((await user(["space", "close", "Mira", "--json"])).code).toBe(3);
    expect((await user(["space", "close", world.spaceFolder, "--json"])).code).toBe(0);
    // The read-only copy answers reads, receipt.get among them: its receipts came with it, and
    // its ID names it now that the original is closed.
    const receipt = await world.tasks(["receipt", addId, "--space", miraId, "--json"]);
    expect(receipt.code, receipt.stdout + receipt.stderr).toBe(0);
    expect(parsed(receipt.stdout)).toMatchObject({ found: true, status: "applied" });
    const claimed = await user(["space", "claim", copyFolder, "--json"]);
    expect(claimed.code, claimed.stdout + claimed.stderr).toBe(0);
    expect(parsed(claimed.stdout)).toMatchObject({ space: { state: "open" } });
    expect((parsed(claimed.stdout) as { epoch: number }).epoch).toBeGreaterThan(2);

    // The restore in place kept the replaced folder beside the space: listed as a leftover.
    const after = parsed((await user(["space", "list", "--json"])).stdout)["spaces"] as (Row & {
      leftovers?: string[];
    })[];
    const mira = after.find((s) => s.folder === world.spaceFolder);
    expect(mira?.leftovers?.some((l) => l.includes("mira.replaced-"))).toBe(true);

    // Close and open again by folder.
    const lifeFolder = join(world.root, "s", "life");
    expect((await user(["space", "close", "Life"])).code).toBe(0);

    // The closed original and the claimed copy share an ID: the ID names neither for certain.
    const byId = await user(["space", "backup", miraId, "--json"]);
    expect(byId.code, byId.stdout).toBe(3);
    expect(parsed(byId.stdout)).toMatchObject({ error: { code: "ambiguous" } });
    // With no space named, the one open space is the copy, and the copy is what is backed up.
    const only = await user(["space", "backup", "--json"]);
    expect(only.code, only.stdout + only.stderr).toBe(0);
    const onlyName = (parsed(only.stdout)["backup"] as { name: string }).name;
    const copyBackups = parsed((await user(["space", "backups", copyFolder, "--json"])).stdout);
    expect(copyBackups["backups"]).toContainEqual(expect.objectContaining({ name: onlyName }));

    const reopened = await user(["space", "open", lifeFolder, "--json"]);
    expect(reopened.code, reopened.stdout + reopened.stderr).toBe(0);
    expect(parsed(reopened.stdout)["space"]).toMatchObject({ name: "Life", state: "open" });
  }, 300_000);

  test("recover refuses a space that needs none, with a usage error", async () => {
    const ran = await user(["space", "recover", "Life", "--json"]);
    expect(ran.code, ran.stdout).toBe(2);
  }, 180_000);

  test("a folder is never a name, and the space verbs take TASKS_SPACE", async () => {
    // A space whose name is another space's folder: that folder still names the space in it.
    const lifeFolder = join(world.root, "s", "life");
    const oddFolder = join(world.root, "s", "odd");
    const odd = await user(["space", "create", lifeFolder, "--path", oddFolder, "--json"]);
    expect(odd.code, odd.stdout + odd.stderr).toBe(0);
    const closed = await user(["space", "close", lifeFolder, "--json"]);
    expect(closed.code, closed.stdout).toBe(0);
    expect(parsed(closed.stdout)["space"]).toMatchObject({ name: "Life", state: "closed" });

    // TASKS_SPACE comes after an argument and --space, before the one open space (A2 3.10.5):
    // naming the closed Life refuses, never backs up another space.
    const env = (value: string) =>
      runMain(["space", "backup", "--json"], {
        home: world.home,
        cwd: world.root,
        tty: true,
        env: { TASKS_SPACE: value },
      });
    const toClosed = await env("Life");
    expect(toClosed.code, toClosed.stdout).toBe(8);
    const toOdd = await env(oddFolder);
    expect(toOdd.code, toOdd.stdout + toOdd.stderr).toBe(0);
    const oddName = (parsed(toOdd.stdout)["backup"] as { name: string }).name;
    const oddBackups = parsed((await user(["space", "backups", oddFolder, "--json"])).stdout);
    expect(oddBackups["backups"]).toContainEqual(expect.objectContaining({ name: oddName }));
    expect((await user(["space", "open", lifeFolder])).code).toBe(0);
  }, 180_000);

  test("an entry the verbs add opens only as its own space, as a [[spaces]] entry does (A2 3.2.4)", async () => {
    const [a, b, aside] = ["swap-a", "swap-b", "swap-aside"].map((n) => join(world.root, "s", n));
    for (const [name, folder] of [
      ["Swap A", a],
      ["Swap B", b],
    ] as const) {
      const made = await user(["space", "create", name, "--path", folder ?? "", "--json"]);
      expect(made.code, made.stdout + made.stderr).toBe(0);
      expect((await user(["space", "close", folder ?? "", "--json"])).code).toBe(0);
    }
    // B's space is put where A's entry points: that entry refuses it, before anything is written.
    renameSync(a ?? "", aside ?? "");
    renameSync(b ?? "", a ?? "");
    const other = await user(["space", "open", a ?? "", "--json"]);
    expect(other.code, other.stdout + other.stderr).toBe(0);
    expect(parsed(other.stdout)["space"]).toMatchObject({
      state: "unavailable",
      reason: "other_space",
    });
    // A folder opened by its path registers the space it holds now: A's space, moved aside.
    const moved = await user(["space", "open", aside ?? "", "--json"]);
    expect(moved.code, moved.stdout + moved.stderr).toBe(0);
    expect(parsed(moved.stdout)["space"]).toMatchObject({ name: "Swap A", state: "open" });
    // The entry that refused B's space is not A's to restore in place either, even from A's own
    // backup: nothing in its folder is replaced.
    const backup = await user(["space", "backup", aside ?? "", "--json"]);
    expect(backup.code, backup.stdout + backup.stderr).toBe(0);
    const backupName = (parsed(backup.stdout)["backup"] as { name: string }).name;
    const listing = parsed((await user(["space", "backups", aside ?? "", "--json"])).stdout) as {
      folder: string;
    };
    const restore = await user([
      "space",
      "restore",
      join(listing.folder, `${backupName}.db.gz`),
      "--in-place",
      a ?? "",
      "--json",
    ]);
    expect(parsed(restore.stdout)).toMatchObject({
      error: { data: { cause: "SPACE_ID_MISMATCH" } },
    });
    const listed = parsed((await user(["space", "list", "--json"])).stdout)["spaces"] as Row[];
    expect(listed.find((s) => s.folder === a)).toMatchObject({ reason: "other_space" });
  }, 180_000);
});

describe("[A2.3.10.cli.space-export] tasks space export writes a bundle that restores", () => {
  test("backup and fork mode, the bundle restored into a new folder, a transfer and a script refused", async () => {
    const folder = join(world.root, "s", "exported");
    const made = await user(["space", "create", "Exported", "--path", folder, "--json"]);
    expect(made.code, made.stdout + made.stderr).toBe(0);
    const added = await world.tasks([
      "add",
      "Exported task",
      "--space",
      "Exported",
      "--request-id",
      "fixture-export-0001",
      "--json",
    ]);
    expect(added.code, added.stdout + added.stderr).toBe(0);

    const ran = await user(["space", "export", folder, "--json"]);
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    const bundle = parsed(ran.stdout)["export"] as { file: string; mode: string; seq: number };
    expect(bundle.mode).toBe("backup");
    expect(bundle.file.startsWith(join(folder, "exports"))).toBe(true);
    expect(existsSync(bundle.file)).toBe(true);
    const forked = await user(["space", "export", folder, "--mode", "fork", "--with-jsonl"]);
    expect(forked.code, forked.stdout + forked.stderr).toBe(0);
    expect(forked.stdout).toMatch(
      /^Exported to .+fork-[^ ]+\.zip \(seq \d+, \d+ bytes\)\nThe bundle is a plain, unencrypted copy of the space\./,
    );

    const copyFolder = join(world.root, "s", "exported-copy");
    const copy = await user(["space", "restore", bundle.file, "--to", copyFolder, "--json"]);
    expect(copy.code, copy.stdout + copy.stderr).toBe(0);
    expect(parsed(copy.stdout)).toMatchObject({
      read_only_copy: true,
      space: { state: "read_only", reason: "read_only_copy" },
    });

    const transfer = await user(["space", "export", folder, "--mode", "transfer", "--json"]);
    expect(transfer.code, transfer.stdout).toBe(2);
    expect(parsed(transfer.stdout)).toMatchObject({
      error: { code: "invalid_input", hint: "It arrives with M3.08." },
    });
    expect((await world.tasks(["space", "export", folder, "--json"])).code).toBe(5);
    for (const done of [copyFolder, folder]) {
      expect((await user(["space", "close", done, "--json"])).code).toBe(0);
    }
  }, 180_000);

  test("a secret-shaped title refuses the export, naming its kind and place but never the text", async () => {
    // Built from parts: the source holds no token.
    const token = ["gh", "p_", "aB3dE5".repeat(6)].join("");
    const folder = join(world.root, "s", "secretive");
    const made = await user(["space", "create", "Secretive", "--path", folder, "--json"]);
    expect(made.code, made.stdout + made.stderr).toBe(0);
    const added = await world.tasks([
      "add",
      `Rotate ${token}`,
      "--space",
      "Secretive",
      "--request-id",
      "fixture-export-0002",
      "--json",
    ]);
    expect(added.code, added.stdout + added.stderr).toBe(0);
    const ran = await user(["space", "export", folder, "--json"]);
    expect(ran.code, ran.stdout).toBe(2);
    const error = parsed(ran.stdout)["error"] as {
      code: string;
      data: { cause: string; secret: { kind: string; place: string } };
    };
    expect(error.code).toBe("invalid_input");
    expect(error.data.cause).toBe("EXPORT_SECRET_FOUND");
    expect(error.data.secret.kind).toBe("github_token");
    // The first table that holds it, by name: the title's history comes before the task.
    expect(error.data.secret.place).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(ran.stdout + ran.stderr).not.toContain(token);
    expect(readdirSync(join(folder, "exports"))).toEqual([]);
    expect((await user(["space", "close", folder, "--json"])).code).toBe(0);
  }, 180_000);
});

/** What `tasks space` prints under a space read-only for its synced or network folder. */
const BACKUP_WAY = [
  "To move the space, restore a backup into a new local folder and claim the copy:",
  `  ${CLI_NAME} space backup <folder>`,
  `  ${CLI_NAME} space restore <folder>/backups/<name>.db.gz --to <new folder>`,
  `  ${CLI_NAME} space claim <new folder>`,
  "<name> is the name the backup prints. <new folder> must not exist yet.",
  "The old folder stays where it is, read-only, and keeps all its files.",
  "If machine.toml names the old folder, change that path to the new folder: the next start then opens the copy.",
];
const EXCLUDED_WAY = `If this folder is excluded from sync, open it for writing: ${CLI_NAME} space open <folder> --excluded`;

describe("[A1.5.sync.way-out] a space read-only for its synced or network folder names the ways out", () => {
  test("in a synced folder: both ways under A1's words, and the commands work as printed", async () => {
    // A Syncthing folder: its marker makes the folders under it synced (A1 3.2).
    const synced = join(world.root, "Sync");
    mkdirSync(join(synced, ".stfolder"), { recursive: true });
    const folder = join(synced, "notes");
    const made = await user(["space", "create", "Notes", "--path", folder]);
    expect(made.code, made.stdout + made.stderr).toBe(0);
    expect(made.stdout).toContain(
      "  This space is inside a Syncthing folder. A live database there can be corrupted. Move it, or confirm that this folder is excluded from sync.\n",
    );
    expect(made.stdout).toContain([EXCLUDED_WAY, ...BACKUP_WAY].map((l) => `  ${l}\n`).join(""));

    // The printed commands, with this space's folder and a new one.
    const backup = await user(["space", "backup", folder]);
    expect(backup.code, backup.stdout + backup.stderr).toBe(0);
    const name = /^Backed up to (\S+) /u.exec(backup.stdout)?.[1] ?? "";
    expect(name).not.toBe("");
    const copy = join(world.root, "s", "notes");
    const restored = await user([
      "space",
      "restore",
      `${folder}/backups/${name}.db.gz`,
      "--to",
      copy,
    ]);
    expect(restored.code, restored.stdout + restored.stderr).toBe(0);
    const claimed = await user(["space", "claim", copy]);
    expect(claimed.code, claimed.stdout + claimed.stderr).toBe(0);
    expect(claimed.stdout).toMatch(/^Claimed Notes .* open /u);

    // The copy is writable; the old folder stays where it is, read-only, with its files.
    const listed = parsed((await user(["space", "list", "--json"])).stdout)["spaces"] as Row[];
    expect(listed.find((s) => s.folder === copy)).toMatchObject({ name: "Notes", state: "open" });
    expect(listed.find((s) => s.folder === folder)).toMatchObject({
      name: "Notes",
      state: "read_only",
      reason: "synced_folder",
    });
    expect(existsSync(join(folder, "space.db"))).toBe(true);
    expect(existsSync(join(folder, "backups", `${name}.db.gz`))).toBe(true);
  }, 240_000);

  test("on a network file system only the backup way; no other state names one", () => {
    expect(wayOut({ entry: 0, state: "read_only", reason: "network_filesystem" })).toEqual(
      BACKUP_WAY,
    );
    expect(wayOut({ entry: 0, state: "read_only", reason: "synced_folder" })).toEqual([
      EXCLUDED_WAY,
      ...BACKUP_WAY,
    ]);
    // A database that failed its check takes no new backup: its words name the restore already.
    for (const reason of ["check_failed", "read_only_copy", "not_authority", undefined]) {
      expect(
        wayOut({ entry: 0, state: "read_only", ...(reason === undefined ? {} : { reason }) }),
      ).toEqual([]);
    }
    expect(wayOut({ entry: 0, state: "open" })).toEqual([]);
  });
});
