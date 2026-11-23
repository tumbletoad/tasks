// `ttasks space` through the service (A2 3.10.1, A1 3.18): a person at a terminal
// (in this process, with a TTY as the class says) creates, backs up, restores, claims and closes
// spaces; the script and agent classes are refused the user-only verbs; a space read-only for its
// synced or network folder names the ways out (A1 3.2). Fixture text only.
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CLI_NAME } from "@ttasks/brand";
import { configOf } from "@ttasks/service/test/harness";
import { createSpace, newId } from "@ttasks/storage";
import { checkedDriver } from "@ttasks/testkit";
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

describe("[A2.3.10.cli.space] ttasks space through the service", () => {
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
    // Listing a space and its backups only reads: not user-only.
    expect((await world.tasks(["space", "list", "--json"])).code).toBe(0);
    const backups = await world.tasks(["space", "backups", "Mira", "--json"]);
    expect(backups.code, backups.stdout + backups.stderr).toBe(0);
    // A refusal says why in plain words and how to run the command.
    const refused = await world.tasks(["space", "backup", "Mira"]);
    expect(refused.code).toBe(5);
    expect(refused.stderr).toContain("ssh -t");
    expect(refused.stderr).not.toContain("cannot call this method");
  }, 180_000);

  test("a person who pipes or redirects the output is still the person at the terminal", async () => {
    // `ttasks space backup | cat`, `x=$(ttasks space backup)`: the input and errors are a terminal.
    const piped = await runMain(["space", "backup", "Mira", "--json"], {
      home: world.home,
      cwd: world.root,
      tty: { stdin: true, stdout: false, stderr: true },
    });
    expect(piped.code, piped.stdout + piped.stderr).toBe(0);
    // `echo y | tasks … > file`: only the errors are a terminal.
    const redirected = await runMain(["space", "backup", "Mira", "--json"], {
      home: world.home,
      cwd: world.root,
      tty: { stdin: false, stdout: false, stderr: true },
    });
    expect(redirected.code, redirected.stdout + redirected.stderr).toBe(0);
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
      expect(ran.stdout).toMatch(/^Usage: ttasks space/);
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

    // Into a new folder while the space is open: a read-only copy, made but not opened beside the
    // space it is a copy of, and the answer says how to look inside it.
    const copyFolder = join(world.root, "s", "copy");
    const file = join(listing.folder, `${name}.db.gz`);
    const copy = await user(["space", "restore", file, "--to", copyFolder]);
    expect(copy.code, copy.stdout + copy.stderr).toBe(0);
    expect(copy.stdout).toContain(`Restored into ${copyFolder}`);
    expect(copy.stdout).toContain(`Mira is open from ${world.spaceFolder}`);
    expect(copy.stdout).toContain(`${CLI_NAME} space close `);
    // Opening it is refused while Mira is open, with what is open and what the folder holds.
    const early = await user(["space", "open", copyFolder, "--json"]);
    expect(early.code).toBe(2);
    const said = String((parsed(early.stdout)["error"] as Record<string, unknown>)["message"]);
    expect(said).toMatch(/^Mira is open from .*\. This folder holds a copy of it restored on /u);
    expect(said).toContain(`from the backup ${name}.db.gz.`);
    // Mira closed, the copy opens: read-only, a restored copy.
    const closedOriginal = await user(["space", "close", "Mira", "--json"]);
    expect(closedOriginal.code, closedOriginal.stdout).toBe(0);
    expect(parsed(closedOriginal.stdout)["space"]).toMatchObject({
      folder: world.spaceFolder,
      state: "closed",
    });
    const opened = await user(["space", "open", copyFolder]);
    expect(opened.code, opened.stdout + opened.stderr).toBe(0);
    expect(opened.stdout).toMatch(/^Opened Mira .* read_only: read_only_copy /u);
    expect(opened.stdout).toContain(`A copy restored `);
    expect(opened.stdout).toContain(`from ${name}.db.gz`);
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

    // The closed original and the claimed copy share an ID: the ID means the claimed copy, which
    // takes writes, never the closed original listed first.
    const byId = await user(["space", "backup", miraId, "--json"]);
    expect(byId.code, byId.stdout + byId.stderr).toBe(0);
    // With no space named, the one open space is the copy, and the copy is what is backed up.
    const only = await user(["space", "backup", "--json"]);
    expect(only.code, only.stdout + only.stderr).toBe(0);
    const copyBackups = parsed((await user(["space", "backups", copyFolder, "--json"])).stdout);
    for (const ran of [byId, only]) {
      const backedUp = (parsed(ran.stdout)["backup"] as { name: string }).name;
      expect(copyBackups["backups"]).toContainEqual(expect.objectContaining({ name: backedUp }));
    }

    const reopened = await user(["space", "open", lifeFolder, "--json"]);
    expect(reopened.code, reopened.stdout + reopened.stderr).toBe(0);
    expect(parsed(reopened.stdout)["space"]).toMatchObject({ name: "Life", state: "open" });
  }, 300_000);

  test("forget takes a closed space off the list and keeps its folder; an open one is closed first", async () => {
    const folder = join(world.root, "s", "forgotten");
    expect((await user(["space", "create", "Forgotten", "--path", folder])).code).toBe(0);
    const open = await user(["space", "forget", "Forgotten"]);
    expect(open.code).toBe(2);
    expect(open.stderr).toContain(`Close it first: ${CLI_NAME} space close `);
    expect((await user(["space", "close", "Forgotten"])).code).toBe(0);
    const forgot = await user(["space", "forget", folder]);
    expect(forgot.code, forgot.stdout + forgot.stderr).toBe(0);
    expect(forgot.stdout).toBe(
      `Forgot Forgotten in ${folder}. Its folder and files are kept: ${CLI_NAME} space open <folder> lists it again.\n`,
    );
    expect((await user(["space", "list"])).stdout).not.toContain("Forgotten");
    expect(existsSync(join(folder, "space.db"))).toBe(true);
    // Only by name: forget never takes the default or the one space.
    expect((await user(["space", "forget"])).code).toBe(2);
    expect((await world.tasks(["space", "forget", folder])).code).toBe(5);
  }, 180_000);

  test("recover of a space that needs none says so and changes nothing", async () => {
    const ran = await user(["space", "recover", "Life"]);
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    expect(ran.stdout).toBe("Life needs no recovery.\n");
  }, 180_000);

  test("a folder is never a name, and the space verbs take TTASKS_SPACE", async () => {
    // A space whose name is another space's folder: that folder still names the space in it.
    const lifeFolder = join(world.root, "s", "life");
    const oddFolder = join(world.root, "s", "odd");
    const odd = await user(["space", "create", lifeFolder, "--path", oddFolder, "--json"]);
    expect(odd.code, odd.stdout + odd.stderr).toBe(0);
    const closed = await user(["space", "close", lifeFolder, "--json"]);
    expect(closed.code, closed.stdout).toBe(0);
    expect(parsed(closed.stdout)["space"]).toMatchObject({ name: "Life", state: "closed" });

    // TTASKS_SPACE comes after an argument and --space, before the one open space (A2 3.10.5):
    // naming the closed Life refuses, never backs up another space.
    const env = (value: string) =>
      runMain(["space", "backup", "--json"], {
        home: world.home,
        cwd: world.root,
        tty: true,
        env: { TTASKS_SPACE: value },
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

describe("[A2.3.10.cli.space-export] ttasks space export writes a bundle that restores", () => {
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

    // The bundle holds the same space: restored while it is open, the copy is made, not opened.
    const copyFolder = join(world.root, "s", "exported-copy");
    const copy = await user(["space", "restore", bundle.file, "--to", copyFolder, "--json"]);
    expect(copy.code, copy.stdout + copy.stderr).toBe(0);
    expect(parsed(copy.stdout)).toMatchObject({ read_only_copy: true, folder: copyFolder });
    expect(String(parsed(copy.stdout)["not_opened"])).toContain("Exported is open from ");
    expect(existsSync(join(copyFolder, "space.db"))).toBe(true);

    const transfer = await user(["space", "export", folder, "--mode", "transfer", "--json"]);
    expect(transfer.code, transfer.stdout).toBe(2);
    expect(parsed(transfer.stdout)).toMatchObject({
      error: { code: "invalid_input", hint: "It arrives with M3.08." },
    });
    expect((await world.tasks(["space", "export", folder, "--json"])).code).toBe(5);
    expect((await user(["space", "close", folder, "--json"])).code).toBe(0);
  }, 180_000);

  test("[A1.5.sync.check-failed-ways] restore latest skips a newer backup that does not verify; rescue writes the readable rows", async () => {
    const folder = join(world.root, "s", "rescued");
    const made = await user(["space", "create", "Rescued", "--path", folder, "--json"]);
    expect(made.code, made.stdout + made.stderr).toBe(0);
    const added = await world.tasks([
      "add",
      "Rescued task",
      "--space",
      "Rescued",
      "--request-id",
      "fixture-rescue-0001",
      "--json",
    ]);
    expect(added.code, added.stdout + added.stderr).toBe(0);
    const names: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const backup = await user(["space", "backup", folder, "--json"]);
      expect(backup.code, backup.stdout + backup.stderr).toBe(0);
      names.push((parsed(backup.stdout)["backup"] as { name: string }).name);
      // Two backups, two names: a backup's name has the millisecond it began.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The newer backup no longer verifies, though its size is right.
    const dir = join(folder, "backups");
    const newer = join(dir, `${names[1] ?? ""}.db.gz`);
    const bytes = readFileSync(newer);
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 1;
    writeFileSync(newer, bytes);

    const copyFolder = join(world.root, "s", "rescued-copy");
    const latest = await user(["space", "restore", "latest", folder, "--to", copyFolder, "--json"]);
    expect(latest.code, latest.stdout + latest.stderr).toBe(0);
    expect(parsed(latest.stdout)).toMatchObject({
      backup: names[0],
      read_only_copy: true,
      folder: copyFolder,
    });
    expect(String(parsed(latest.stdout)["not_opened"])).toContain("Rescued is open from ");
    // The damaged one stays, for a person to look at.
    expect(existsSync(newer)).toBe(true);

    const rescue = await user(["space", "rescue", folder, "--json"]);
    expect(rescue.code, rescue.stdout + rescue.stderr).toBe(0);
    const rescued = parsed(rescue.stdout)["rescue"] as {
      file: string;
      rows: number;
      failed: string[];
    };
    expect(rescued.failed).toEqual([]);
    expect(rescued.file.startsWith(join(folder, "exchange", "rescued"))).toBe(true);
    const lines = readFileSync(rescued.file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(rescued.rows);
    expect(lines.some((line) => line.includes("Rescued task"))).toBe(true);
    expect((await user(["space", "close", folder, "--json"])).code).toBe(0);
  }, 180_000);

  test("a secret-shaped title is a warning with its kind and place, never the text, and the bundle is written", async () => {
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
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    const bundle = parsed(ran.stdout)["export"] as {
      file: string;
      secrets: { kind: string; place: string }[];
    };
    expect(existsSync(bundle.file)).toBe(true);
    expect(bundle.secrets).toContainEqual({ kind: "github_token", place: "tasks.title" });
    for (const s of bundle.secrets) expect(s.place).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(ran.stdout + ran.stderr).not.toContain(token);

    const said = await user(["space", "export", folder]);
    expect(said.code, said.stdout + said.stderr).toBe(0);
    expect(said.stdout).toMatch(/Warning: .*github token in tasks\.title/);
    expect(said.stdout + said.stderr).not.toContain(token);
    expect(readdirSync(join(folder, "exports"))).toHaveLength(2);
    expect((await user(["space", "close", folder, "--json"])).code).toBe(0);
  }, 180_000);
});

/** What `ttasks space` prints under a space read-only for its synced or network folder. */
const BACKUP_WAY = [
  "To move the space, restore a backup into a new local folder and claim the copy:",
  `  ${CLI_NAME} space backup <folder>`,
  `  ${CLI_NAME} space close <folder>`,
  `  ${CLI_NAME} space restore <folder>/backups/<name>.db.gz --to <new folder>`,
  `  ${CLI_NAME} space claim <new folder>`,
  "<name> is the name the backup prints. <new folder> must not exist yet.",
  "The old folder stays where it is, closed, and keeps all its files.",
  "The copy opens at every start from now on.",
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
    const closed = await user(["space", "close", folder]);
    expect(closed.code, closed.stdout + closed.stderr).toBe(0);
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

    // The copy is writable; the old folder stays where it is, closed, with its files.
    const listed = parsed((await user(["space", "list", "--json"])).stdout)["spaces"] as Row[];
    expect(listed.find((s) => s.folder === copy)).toMatchObject({ name: "Notes", state: "open" });
    expect(listed.find((s) => s.folder === folder)).toMatchObject({ state: "closed" });
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
    // A database that failed its check takes no new backup: its two actions are A1 3.2's.
    expect(wayOut({ entry: 0, state: "read_only", reason: "check_failed" })).toEqual([
      "Restore the newest backup that verifies into a new local folder, or keep the rows that can still be read:",
      `  ${CLI_NAME} space restore latest <folder> --to <new folder>`,
      `  ${CLI_NAME} space rescue <folder>`,
      "<new folder> must not exist yet. The rescue writes a file into <folder>/exchange/rescued. The old folder keeps all its files.",
    ]);
    for (const reason of ["read_only_copy", "not_authority", undefined]) {
      expect(
        wayOut({ entry: 0, state: "read_only", ...(reason === undefined ? {} : { reason }) }),
      ).toEqual([]);
    }
    expect(wayOut({ entry: 0, state: "open" })).toEqual([]);
  });
});

describe("[A2.3.10.cli.space-needs-recovery] a space that needs recovery says what to run", () => {
  test("space list and doctor name ttasks space recover, which then opens it", async () => {
    const folder = join(world.root, "s", "journal");
    const made = await user(["space", "create", "Journal", "--path", folder, "--json"]);
    expect(made.code, made.stdout + made.stderr).toBe(0);
    expect((await user(["space", "close", folder])).code).toBe(0);
    // A rollback journal beside the database, as a crash in another tool leaves one.
    writeFileSync(join(folder, "space.db-journal"), "");
    const opened = await user(["space", "open", folder, "--json"]);
    expect(parsed(opened.stdout)["space"]).toMatchObject({
      state: "unavailable",
      reason: "needs_recovery",
    });

    const way = `${CLI_NAME} space recover <folder>`;
    const listed = await user(["space", "list"]);
    expect(listed.stdout).toContain("unavailable: needs_recovery");
    expect(listed.stdout).toContain(way);
    const doctor = parsed((await world.tasks(["doctor", "--json"])).stdout) as {
      checks: { id: string; detail: string }[];
    };
    const spaces = doctor.checks.find((c) => c.id === "spaces")?.detail ?? "";
    expect(spaces).toContain(way);
    expect(spaces).toContain(`${CLI_NAME} space list`);

    const recovered = await user(["space", "recover", folder, "--json"]);
    expect(recovered.code, recovered.stdout + recovered.stderr).toBe(0);
    expect(parsed(recovered.stdout)["space"]).toMatchObject({ name: "Journal", state: "open" });
    const after = parsed((await user(["space", "list", "--json"])).stdout)["spaces"] as Row[];
    expect(after.find((s) => s.name === "Journal")).not.toHaveProperty("message");
    expect((await user(["space", "close", folder])).code).toBe(0);
  }, 300_000);

  test("a space whose database is refused before it opened is restored from its backups, as its way out says", async () => {
    const folder = join(world.root, "s", "linked");
    expect((await user(["space", "create", "Linked", "--path", folder])).code).toBe(0);
    expect((await user(["space", "backup", folder])).code).toBe(0);
    expect((await user(["space", "close", folder])).code).toBe(0);
    // A second name for the database, as a copy tool that hard-links leaves one.
    const second = join(world.root, "linked-second.db");
    linkSync(join(folder, "space.db"), second);
    try {
      const opened = await user(["space", "open", folder, "--json"]);
      const space = parsed(opened.stdout)["space"] as Record<string, unknown>;
      expect(space).toMatchObject({ state: "unavailable", reason: "linked_database" });
      expect(space).not.toHaveProperty("id");
      expect(String(space["message"])).toContain(`${CLI_NAME} space restore latest <folder>`);

      const copy = join(world.root, "s", "linked-copy");
      const restored = await user(["space", "restore", "latest", folder, "--to", copy, "--json"]);
      expect(restored.code, restored.stdout + restored.stderr).toBe(0);
      expect(parsed(restored.stdout)).toMatchObject({
        read_only_copy: true,
        space: { name: "Linked", state: "read_only", reason: "read_only_copy" },
      });
      for (const done of [copy, folder]) {
        expect((await user(["space", "close", done])).code).toBe(0);
      }
    } finally {
      unlinkSync(second);
    }
  }, 300_000);
});

describe("[A2.3.10.cli.space-words] what ttasks space says, and the ways it names work", () => {
  test("another machine's space: claim names the way that works, the way works, and the claim prints A6's warning", async () => {
    const theirs = join(world.root, "s", "theirs");
    createSpace(await checkedDriver(), theirs, {
      name: "Theirs",
      ownerLabel: "Fixture owner",
      machineId: newId("m"),
    });
    const opened = await user(["space", "open", theirs, "--json"]);
    expect(opened.code, opened.stdout + opened.stderr).toBe(0);
    expect(parsed(opened.stdout)["space"]).toMatchObject({
      state: "read_only",
      reason: "not_authority",
    });
    const refused = await user(["space", "claim", theirs]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("This space belongs to another machine");
    for (const step of [
      `${CLI_NAME} space export <folder>`,
      `${CLI_NAME} space close <folder>`,
      `${CLI_NAME} space restore <bundle> --to <new folder>`,
      `${CLI_NAME} space claim <new folder>`,
    ]) {
      expect(refused.stderr).toContain(step);
    }

    // The way, as it is printed.
    const exported = await user(["space", "export", theirs]);
    expect(exported.code, exported.stdout + exported.stderr).toBe(0);
    const bundle = /^Exported to (.+) \(seq /mu.exec(exported.stdout)?.[1] ?? "";
    expect(bundle).not.toBe("");
    expect((await user(["space", "close", theirs])).code).toBe(0);
    const mine = join(world.root, "s", "theirs-mine");
    const restored = await user(["space", "restore", bundle, "--to", mine]);
    expect(restored.code, restored.stdout + restored.stderr).toBe(0);
    const claimed = await user(["space", "claim", mine]);
    expect(claimed.code, claimed.stdout + claimed.stderr).toBe(0);
    expect(claimed.stdout).toMatch(/^Claimed Theirs .* open /mu);
    expect(claimed.stdout).toContain(
      "If another machine still has this space, its later changes will not appear here.\n",
    );
    // An open space is not claimed, and says why.
    const again = await user(["space", "claim", mine, "--json"]);
    expect(again.code).toBe(2);
    expect(parsed(again.stdout)).toMatchObject({
      error: {
        message: "This space takes writes on this machine already: there is nothing to claim.",
      },
    });
    expect((await user(["space", "close", mine])).code).toBe(0);
  }, 240_000);

  test("a backup by the name space backups prints, restored into a new folder; --space takes that folder for any command", async () => {
    const folder = join(world.root, "s", "named");
    expect((await user(["space", "create", "Named", "--path", folder])).code).toBe(0);
    const added = await world.tasks([
      "add",
      "Named task",
      "--space",
      folder,
      "--request-id",
      "fixture-named-0001",
      "--json",
    ]);
    expect(added.code, added.stdout + added.stderr).toBe(0);
    const ref = (parsed(added.stdout)["tasks"] as { ref: string }[])[0]?.ref ?? "";
    expect((await user(["space", "backup", folder])).code).toBe(0);
    const listed = await user(["space", "backups", folder]);
    const name = /^(\S+) {2}ok/mu.exec(listed.stdout)?.[1] ?? "";
    expect(name).not.toBe("");
    const copy = join("s", "named-copy");
    const restored = await user(["space", "restore", name, folder, "--to", copy]);
    expect(restored.code, restored.stdout + restored.stderr).toBe(0);
    expect(restored.stdout).toMatch(/^Restored into .*named-copy\nNamed is open from /u);
    // As the answer says: the space closes, then the copy opens.
    expect((await user(["space", "close", folder])).code).toBe(0);
    const opened = await user(["space", "open", copy]);
    expect(opened.code, opened.stdout + opened.stderr).toBe(0);
    expect(opened.stdout).toMatch(/^Opened Named .* read_only: read_only_copy /mu);

    // A relative folder is the working folder's, as for the space verbs. The copy answers reads
    // and refuses writes; the name means the copy now, and the original again once it is back.
    const shown = await world.tasks(["show", ref, "--space", copy, "--json"]);
    expect(shown.code, shown.stdout + shown.stderr).toBe(0);
    const write = await world.tasks([
      "add",
      "Into the copy",
      "--space",
      copy,
      "--request-id",
      "fixture-named-0002",
      "--json",
    ]);
    expect(parsed(write.stdout)).toMatchObject({ error: { code: "read_only" } });
    expect((await user(["space", "close", copy])).code).toBe(0);
    expect((await user(["space", "open", folder])).code).toBe(0);
    const original = await world.tasks([
      "add",
      "Into the original",
      "--space",
      "Named",
      "--request-id",
      "fixture-named-0003",
      "--json",
    ]);
    expect(original.code, original.stdout + original.stderr).toBe(0);
    expect((await user(["space", "close", folder])).code).toBe(0);
  }, 240_000);

  test("a create where a space is names ttasks space open; ttasks recover is ttasks space recover; a record machine.toml cannot take is said on stderr", async () => {
    const there = await user(["space", "create", "Mira", "--path", world.spaceFolder]);
    expect(there.code).toBe(2);
    expect(there.stderr).toContain("A space is already in that folder. Open it with: ");
    expect(there.stderr).toContain(`${CLI_NAME} space open `);

    // `ttasks recover` is the same command: a space that needs none is said so, and is no error.
    for (const argv of [
      ["recover", world.spaceFolder],
      ["space", "recover", world.spaceFolder],
    ]) {
      const ran = await user(argv);
      expect(ran.code, argv.join(" ")).toBe(0);
      expect(ran.stdout).toMatch(/^\S+ needs no recovery\.\n$/u);
    }
    expect(parsed((await user(["recover", world.spaceFolder, "--json"])).stdout)).toMatchObject({
      recovered: false,
    });
    expect((await user(["help", "recover"])).stdout).toMatch(
      new RegExp(`^Usage: ${CLI_NAME} recover \\[<space>\\]\\n[\\s\\S]*${CLI_NAME} space recover`),
    );
    // Only the user recovers a space, under either name.
    expect((await world.tasks(["recover", world.spaceFolder, "--json"])).code).toBe(5);

    // machine.toml with a syntax error from a hand edit: the space is created for this run, and
    // stderr says a restart will not keep it.
    const file = join(configOf(world.home), "machine.toml");
    const before = readFileSync(file, "utf8");
    try {
      writeFileSync(file, `${before}\n[log\n`);
      const made = await user(["space", "create", "Unrecorded", "--path", join("s", "unrecorded")]);
      expect(made.code, made.stdout + made.stderr).toBe(0);
      expect(made.stdout).toMatch(/^Created Unrecorded .* open /mu);
      expect(made.stderr).toMatch(
        new RegExp(
          `^The space is open for now, but will not reopen after a restart: machine\\.toml cannot be read as it is\\. Run ${CLI_NAME} doctor: it names the problem\\. Then run: ${CLI_NAME} space open .+\\n$`,
          "u",
        ),
      );
      expect(made.stderr).toContain(join(world.root, "s", "unrecorded"));
    } finally {
      writeFileSync(file, before);
    }
    // The command the line names records it, once the file is fixed.
    const recorded = await user(["space", "open", join(world.root, "s", "unrecorded")]);
    expect(recorded.code, recorded.stdout + recorded.stderr).toBe(0);
    expect(recorded.stderr).toBe("");
    expect(readFileSync(file, "utf8")).toContain("unrecorded");
    expect((await user(["space", "close", join(world.root, "s", "unrecorded")])).code).toBe(0);
  }, 240_000);
});
