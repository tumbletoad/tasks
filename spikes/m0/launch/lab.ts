// Lab run L (M0.10): the unattended row L10, trust writes and their undo on scratch homes. Usage:
//   node spikes/m0/launch/lab.ts l10 --scratch <folder> [--results <folder>]
// Everything happens under --scratch: a scratch CLAUDE_CONFIG_DIR and a scratch CODEX_HOME per
// check, with no sign-in, and scratch working folders. No model session is started: the only CLI
// commands are `--version`, `claude mcp list` and `codex mcp list --json`, which read
// configuration. A real home is never read or written.
//
// How trust is seen without a session (both documented, checked 2026-11-12):
// - Claude Code reads `.mcp.json` approvals from the project's own `.claude/settings.json` only in
//   a trusted folder, so `claude mcp list` shows the folder's marker server as "Pending approval"
//   until the folder is trusted (code.claude.com/docs/en/mcp, "Project server approvals and
//   workspace trust"). Trusting a parent folder does not count there.
// - Codex loads a project's `.codex/config.toml` only when the project is trusted, so
//   `codex mcp list --json` lists the marker server defined there only then
//   (learn.chatgpt.com/docs/config-file/config-basic).
//
// Rules (A7 3.7's lab rules, reused from lab run A): facts only
// (an exit code, a yes or no, a class from a fixed list; no CLI output, no path), every CLI through
// the clean spawner (spawn.ts), every removal through the removal rule (scratch.ts).
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { option } from "../kit/wire.ts";
import { findClis, type Cli, type Clis } from "../agents/clis.ts";
import { compareRecords, recordHome } from "../agents/config-record.ts";
import { errorLabel } from "../agents/facts.ts";
import { openScratch } from "../agents/scratch.ts";
import { cleanEnv, endAll, installCleanup, run, type ExtraName } from "../agents/spawn.ts";
import { claudeCases, codexCases, type Case } from "./fixtures.ts";
import {
  TrustPatchError,
  claudeTrustKey,
  codexTrustKey,
  decodeUtf8,
  patchClaudeJson,
  patchCodexToml,
  readTrust,
  tomlQuote,
  undoTrust,
  type Os,
} from "./trust-patch.ts";

const fail = (error: unknown) => {
  process.stderr.write(`error: ${errorLabel(error)}\n`);
  void endAll().finally(() => process.exit(1));
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
installCleanup();

const WIN = process.platform === "win32";
const OS: Os = WIN ? "win32" : "posix";
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const scratchArg = option(args, "--scratch");
if (command !== "l10" || scratchArg === undefined) {
  process.stderr.write("Usage: lab l10 --scratch <folder> [--results <folder>]\n");
  process.exit(64);
}
/** Whether anything, a dangling link included, has this name. Only "not found" counts as free. */
const taken = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
};

// Every file the lab writes lies in a folder this run created: the scratch folder must be new (or
// empty). A folder from an earlier run could hold a link to a file outside, and a write follows it.
// The check uses the path the removal rule uses, resolved once: on POSIX the raw text can fail a
// lookup (`<old scratch>/missing/..`) while it resolves to an existing folder.
const scratchPath = resolve(scratchArg);
if (
  taken(scratchPath) &&
  (!lstatSync(scratchPath).isDirectory() || readdirSync(scratchPath).length > 0)
) {
  throw new TrustPatchError("scratch folder is not fresh");
}
const sc = openScratch(scratchPath);
const scratch = sc.root;
const results = option(args, "--results") ?? join(scratch, "results");
mkdirSync(results, { recursive: true });
const machine = WIN ? "desktop" : "laptop";

// Every PID the lab starts, so the end of the run can show that none is left.
const ledgerFile = join(scratch, "ledger.json");
const ledger: { pids: number[] } = { pids: [] };

let clisFound: Clis | undefined;
const clis = (): Clis => (clisFound ??= findClis());

function cli(
  c: Cli,
  argv: readonly string[],
  extra: Partial<Record<ExtraName, string>>,
  cwd: string,
) {
  return run(c.file, [...c.prefix, ...argv], {
    env: cleanEnv(process.env, extra, { path: clis().path }),
    cwd,
    timeoutMs: 120_000,
    onPid: (pid) => {
      ledger.pids.push(pid);
      writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
    },
  });
}

function save(name: string, data: unknown): void {
  writeFileSync(join(results, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${name}.json`);
}

// Files are read as strict UTF-8 (invalid bytes are refused, a byte order mark is kept), so the
// text written back has exactly the bytes that were read.
const bytes = (file: string) => (existsSync(file) ? readFileSync(file) : null);
const read = (file: string) => {
  const b = bytes(file);
  return b === null ? null : decodeUtf8(b);
};
const write = (file: string, text: string | null) => {
  if (text === null) {
    if (existsSync(file)) sc.remove(file);
  } else writeFileSync(file, text);
};

// ---------------------------------------------------------------------------------------------
// The scratch working folders, each with the two marker servers.

const MARKER = "tasks-trust-marker";

/** Puts the marker servers into `folder` (the project's own files, never a home). */
function markFolder(folder: string, codex = true): void {
  sc.mkdir(join(folder, ".claude"));
  const mcp = {
    mcpServers: { [MARKER]: { command: process.execPath, args: ["-e", "process.exit(0)"] } },
  };
  // Created, never overwritten (`wx`): a name that is already there is refused.
  writeFileSync(join(folder, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, { flag: "wx" });
  writeFileSync(
    join(folder, ".claude", "settings.json"),
    '{\n  "enableAllProjectMcpServers": true\n}\n',
    { flag: "wx" },
  );
  const codexDir = join(folder, ".codex");
  if (!codex) {
    if (existsSync(codexDir)) sc.remove(codexDir);
    return;
  }
  sc.mkdir(codexDir);
  // Never started: `codex mcp list` does not start servers (lab run A, A02).
  writeFileSync(
    join(folder, ".codex", "config.toml"),
    `[mcp_servers.${MARKER}]\ncommand = "${MARKER}-not-started"\n`,
    { flag: "wx" },
  );
}

type Indicator = "trusted" | "untrusted" | "marker absent" | "failed";

/** Claude Code: the marker's line in `claude mcp list` (facts: one class, never the output). */
async function claudeIndicator(
  home: string,
  cwd: string,
): Promise<{ state: Indicator; exit: number | null }> {
  const r = await cli(clis().claude, ["mcp", "list"], { CLAUDE_CONFIG_DIR: home }, cwd);
  if (r.code !== 0) return { state: "failed", exit: r.code };
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith(`${MARKER}:`));
  if (line === undefined) return { state: "marker absent", exit: r.code };
  return { state: /Pending approval/i.test(line) ? "untrusted" : "trusted", exit: r.code };
}

/** Codex: whether `codex mcp list --json` names the marker of the project's `.codex/` layer. */
async function codexIndicator(
  home: string,
  cwd: string,
): Promise<{ state: Indicator; exit: number | null }> {
  const r = await cli(clis().codex, ["mcp", "list", "--json"], { CODEX_HOME: home }, cwd);
  if (r.code !== 0) return { state: "failed", exit: r.code };
  try {
    const list = JSON.parse(r.stdout) as { name?: unknown }[];
    return { state: list.some((s) => s.name === MARKER) ? "trusted" : "untrusted", exit: r.code };
  } catch {
    return { state: "failed", exit: r.code };
  }
}

interface Target {
  name: "claude" | "codex";
  file: string;
  kind: "json" | "toml";
  key: (folder: string) => string;
  patch: (text: string | null, key: string) => ReturnType<typeof patchClaudeJson>;
  indicator: (home: string, cwd: string) => Promise<{ state: Indicator; exit: number | null }>;
  cases: (key: string, other: string) => Case[];
}

const CLAUDE: Target = {
  name: "claude",
  file: ".claude.json",
  kind: "json",
  key: (f) => claudeTrustKey(f, OS),
  patch: patchClaudeJson,
  indicator: claudeIndicator,
  cases: claudeCases,
};
const CODEX: Target = {
  name: "codex",
  file: "config.toml",
  kind: "toml",
  key: (f) => codexTrustKey(f),
  patch: (t, k) => patchCodexToml(t, k, WIN),
  indicator: codexIndicator,
  cases: (k, o) => codexCases(k, o, tomlQuote),
};

function freshHome(name: string): string {
  const home = join(scratch, "homes", name);
  if (existsSync(home)) sc.remove(home);
  sc.mkdir(join(scratch, "homes"));
  return sc.mkdir(home);
}

// ---------------------------------------------------------------------------------------------
// Part 1: how the folder is spelled as a key. One entry per run, in a home that holds nothing
// else, then the read-only indicator.

interface Variant {
  name: string;
  about: string;
  cwd: string;
  /** The key for each target, or null when the variant does not apply to it. */
  claude: string | null;
  codex: string | null;
}

function variants(f: Record<string, string>): Variant[] {
  const work = f["work"] ?? "";
  const both = (name: string, about: string, cwd: string, key: string): Variant => ({
    name,
    about,
    cwd,
    claude: CLAUDE.key(key),
    codex: CODEX.key(key),
  });
  const list: Variant[] = [
    {
      name: "no entry",
      about: "control: the home holds no trust entry",
      cwd: work,
      claude: null,
      codex: null,
    },
    both("exact", "the key the patch writes for the working folder", work, work),
    both("parent", "the working folder's parent", work, resolve(work, "..")),
    both("space", "a folder name with a space", f["space"] ?? "", f["space"] ?? ""),
    both(
      "non-ascii",
      "a folder name with non-ASCII characters",
      f["nonascii"] ?? "",
      f["nonascii"] ?? "",
    ),
    both(
      "git root, cwd in a subfolder",
      "a git repository's root as the key",
      f["sub"] ?? "",
      f["repo"] ?? "",
    ),
    both(
      "git subfolder, cwd there",
      "the subfolder of a repository as the key",
      f["sub"] ?? "",
      f["sub"] ?? "",
    ),
  ];
  const sep = WIN ? "\\" : "/";
  list.push({
    name: "trailing separator",
    about: "the exact key with a separator at the end",
    cwd: work,
    claude: `${CLAUDE.key(work)}/`,
    codex: `${CODEX.key(work)}${sep}`,
  });
  list.push({
    name: "other case",
    about: "the exact key in upper case",
    cwd: work,
    claude: CLAUDE.key(work).toUpperCase(),
    codex: CODEX.key(work).toUpperCase(),
  });
  if (WIN) {
    const lowerDrive = (p: string) => p.charAt(0).toLowerCase() + p.slice(1);
    list.push(
      {
        name: "other separator",
        about: "Claude Code with backslashes, Codex with forward slashes",
        cwd: work,
        claude: work,
        codex: work.replaceAll("\\", "/"),
      },
      {
        name: "lower-case drive letter",
        about: "the exact key with the drive letter in lower case",
        cwd: work,
        claude: lowerDrive(CLAUDE.key(work)),
        codex: lowerDrive(CODEX.key(work)),
      },
      {
        name: "verbatim prefix",
        about: "the exact key behind the \\\\?\\ prefix",
        cwd: work,
        claude: `//?/${CLAUDE.key(work)}`,
        codex: `\\\\?\\${CODEX.key(work)}`,
      },
      {
        name: "cwd with a lower-case drive, key exact",
        about: "the CLI started in the folder spelled with a lower-case drive letter",
        cwd: lowerDrive(work),
        claude: CLAUDE.key(work),
        codex: CODEX.key(work),
      },
      {
        name: "cwd with a lower-case drive, key the same",
        about: "the key spelled like that cwd",
        cwd: lowerDrive(work),
        claude: CLAUDE.key(lowerDrive(work)),
        codex: CODEX.key(lowerDrive(work)),
      },
    );
  } else {
    const link = f["link"] ?? "";
    list.push(
      {
        name: "double separator",
        about: "the exact key with one separator doubled",
        cwd: work,
        claude: work.replace("/", "//"),
        codex: work.replace("/", "//"),
      },
      both("symlink: cwd the link, key the real folder", "a symlinked folder", link, work),
      both("symlink: cwd the link, key the link", "a symlinked folder", link, link),
      both("symlink: cwd the real folder, key the link", "a symlinked folder", work, link),
    );
  }
  return list;
}

async function keySpelling(folders: Record<string, string>): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (const target of [CLAUDE, CODEX]) {
    for (const v of variants(folders)) {
      const key = v[target.name];
      const home = freshHome(`${target.name}-paths`);
      const file = join(home, target.file);
      write(file, key === null ? null : target.patch(null, key).text);
      const r = await target.indicator(home, v.cwd);
      rows.push({
        target: target.name,
        variant: v.name,
        about: v.about,
        indicator: r.state,
        exit: r.exit,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Part 2: write and undo through the real CLIs. Per fixture case: the case's file in a scratch
// home, the indicator, the patch, the indicator, the undo, the indicator, and the config recorder
// before the patch against after the undo.

async function writeUndo(work: string, other: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (const target of [CLAUDE, CODEX]) {
    const key = target.key(work);
    for (const c of target.cases(key, target.key(other))) {
      if (c.expect === "refused") continue;
      const home = freshHome(`${target.name}-${c.name}`);
      const file = join(home, target.file);
      write(file, c.text);
      const row: Record<string, unknown> = { target: target.name, case: c.name, about: c.about };
      // The CLI may write its own file first (Claude Code creates `.claude.json`). Tasks patches
      // what is on disk, so "before" is taken after that run. The no-file case skips this run, so
      // the patch meets the missing file.
      if (c.text !== null) {
        const r0 = await target.indicator(home, work);
        row["indicator_before"] = r0.state;
        const now = read(file);
        row["cli_changed_file_before"] = now !== c.text;
        // Whether the CLI's own write left the file in JSON.stringify's two-space form (LF, no
        // byte order mark): then the case's own formatting did not survive to the patch.
        if (target.kind === "json" && now !== null) {
          try {
            const canonical = JSON.stringify(JSON.parse(now), null, 2);
            row["file_in_cli_format_before_patch"] = now === canonical || now === `${canonical}\n`;
          } catch {
            row["file_in_cli_format_before_patch"] = false;
          }
        }
      }
      const before = recordHome(home, c.text === null ? [] : [target.file]);
      const bytes0 = bytes(file);
      const text0 = read(file);
      const patched = target.patch(text0, key);
      write(file, patched.text);
      row["change"] = patched.undo.change;
      row["key_reads_trusted"] = readTrust(
        target.kind,
        read(file),
        key,
        WIN && target.name === "codex",
      );
      const added = compareRecords(before, recordHome(home, [target.file]));
      row["keys_added"] = (added.keys_added[target.file] ?? []).length;
      row["values_changed"] = (added.values_changed[target.file] ?? []).length;
      const r1 = await target.indicator(home, work);
      row["indicator_after_patch"] = r1.state;
      row["cli_changed_file_after_patch"] = read(file) !== patched.text;
      const undone = undoTrust(read(file), patched.undo, WIN && target.name === "codex");
      write(file, undone.text);
      row["undo_path"] = undone.path;
      const after = recordHome(home, c.text === null ? [] : [target.file]);
      const cmp = compareRecords(before, after);
      row["restored_exactly"] = cmp.restored;
      const bytes1 = bytes(file);
      row["bytes_equal"] =
        bytes0 === null ? bytes1 === null : bytes1 !== null && bytes1.equals(bytes0);
      row["files_added"] = cmp.files_added.length;
      row["files_changed"] = cmp.files_changed.length;
      const r2 = await target.indicator(home, work);
      row["indicator_after_undo"] = r2.state;
      row["cli_changed_file_after_undo"] = read(file) !== undone.text;
      rows.push(row);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------

async function l10(): Promise<void> {
  const versions: Record<string, string | null> = {};
  for (const target of [CLAUDE, CODEX]) {
    const home = freshHome(`${target.name}-version`);
    const extra = target.name === "claude" ? { CLAUDE_CONFIG_DIR: home } : { CODEX_HOME: home };
    const r = await cli(
      target.name === "claude" ? clis().claude : clis().codex,
      ["--version"],
      extra,
      scratch,
    );
    versions[target.name] = /\d+\.\d+\.\d+/.exec(r.stdout)?.[0] ?? null;
  }
  // The scratch working folders: a plain one, a sibling, a space, non-ASCII, a git repository
  // with a subfolder, and on Linux a symbolic link to the plain one.
  const folders: Record<string, string> = {
    work: sc.mkdir(join(scratch, "work")),
    other: sc.mkdir(join(scratch, "other")),
    space: sc.mkdir(join(scratch, "work dir")),
    nonascii: sc.mkdir(join(scratch, "wörk-ü")),
    repo: sc.mkdir(join(scratch, "repo")),
  };
  folders["sub"] = sc.mkdir(join(folders["repo"] ?? "", "sub"));
  let gitExit: number | null = null;
  try {
    const git = await run("git", ["init", "-q"], {
      env: cleanEnv(process.env, {}, { path: clis().path }),
      cwd: folders["repo"] ?? "",
      timeoutMs: 30_000,
      onPid: (pid) => ledger.pids.push(pid),
    });
    gitExit = git.code;
  } catch {
    // git not found: gitExit stays null, and the two git variants show a folder without a repository
  }
  for (const name of ["work", "space", "nonascii", "repo"]) markFolder(folders[name] ?? "");
  // The repository's subfolder gets Claude Code's marker only: Claude Code reads the project's
  // `.claude/settings.json` (the marker's approval) from the working folder, while Codex's marker
  // stays in the repository root's `.codex/` layer, so the git rows show which key trusts the root.
  markFolder(folders["sub"] ?? "", false);
  if (!WIN) {
    // Every removal goes through the removal rule, which never removes a link: a name that is
    // taken (a run before this one in the same scratch folder) is refused, not replaced.
    const link = sc.inside(join(scratch, "work-link"));
    if (taken(link)) throw new TrustPatchError("link name taken, use a fresh scratch folder");
    symlinkSync(folders["work"] ?? "", link);
    folders["link"] = link;
  }
  const spelling = await keySpelling(folders);
  save("l10-key-spelling", {
    row: "L10",
    machine,
    versions,
    git_init_exit: gitExit,
    indicator: {
      claude:
        "claude mcp list in the folder: the project .mcp.json marker, approved by the project's .claude/settings.json, is 'Pending approval' until the folder is trusted",
      codex:
        "codex mcp list --json in the folder: the marker from the project's .codex/config.toml is listed only when the project is trusted",
    },
    rows: spelling,
  });
  const rows = await writeUndo(folders["work"] ?? "", folders["other"] ?? "");
  save("l10-write-undo", {
    row: "L10",
    machine,
    versions,
    approach:
      "text-level single-key patch with a recorded inverse (spikes/m0/launch/trust-patch.ts); restored_exactly is the config recorder's before-patch record against the after-undo record (file list, hash of every file, key list)",
    rows,
  });
}

await l10();
await endAll();
// Whether any process the lab started is still there after the one cleanup path (a count only; a
// PID reused by the OS in the meantime would count too).
const alive = ledger.pids.filter((pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}).length;
save("l10-pids", { pids_started: ledger.pids.length, pids_alive_after: alive });
