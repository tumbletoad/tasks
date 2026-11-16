// Edits to machine.toml (A2 3.2.4): every byte outside an edit survives (comments, order, spacing,
// CRLF, a byte order mark), each edit is verified by parsing the result, layouts an edit cannot
// place are refused untouched, and a file the person saved meanwhile is never overwritten.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { atomicWrite } from "../hub/files.ts";
import { MAX_CONFIG_BYTES } from "./toml.ts";

/** A rename that fails once with EBUSY (a Windows sharing failure), running a callback first. */
const renameFaults = vi.hoisted(() => ({ busyOnce: undefined as undefined | (() => void) }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      const fault = renameFaults.busyOnce;
      if (fault !== undefined) {
        renameFaults.busyOnce = undefined;
        fault();
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }
      fs.renameSync(from, to);
    },
  };
});
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { applyEdits, commitEdit, editMachineToml, prepareEdit, type Edit } from "./edit.ts";
import { loadMachineConfig, MACHINE_TOML, parseMachineConfig } from "./machine-toml.ts";
import { scanToml } from "./scan.ts";

const FIXTURES = fileURLToPath(new URL("../../test/config/", import.meta.url));
const BEFORE = readFileSync(join(FIXTURES, "edit.before.toml"), "utf8");

const ALLOW = "sha256-bbb50b140ef4052560a197c58ac0d48a02a61125e068cb6d6eed256d6ee340d9";
const OTHER = `sha256-${"0".repeat(63)}1`;

const EDITS: Edit[] = [
  { op: "set", table: ["approvals"], key: ALLOW, value: "allow" },
  { op: "set", table: ["approvals"], key: OTHER, value: "deny" },
  {
    op: "append",
    array: "instance",
    entries: new Map<string, string | boolean | readonly string[] | Record<string, string>>([
      ["id", "codex-personal"],
      ["target", "codex-cli"],
      ["label", "Codex · personal"],
      ["exec", "/home/mira/.local/bin/codex-personal"],
      ["extra_args", []],
      ["env", { CODEX_HOME: "/home/mira/.codex-personal" }],
      ["remote_allowed", false],
    ]),
  },
  { op: "add_table", table: ["roots", "work"], entries: { path: "/home/mira/work", runs: true } },
  { op: "set", table: ["terminal"], key: "app", value: "ghostty" },
];

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "tasks-edit-"));
  temps.push(dir);
  return dir;
};

function applied(text: string, edits: readonly Edit[]): string {
  const result = applyEdits(text, edits);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.text;
}

describe("[A2.3.2.4.config.edit] edits to machine.toml keep every other byte", () => {
  test("the golden edit: an approval replaced and added, an instance appended, a root and a table added", async () => {
    const after = applied(BEFORE, EDITS);
    await expect(after).toMatchFileSnapshot("../../test/golden/edit.after.toml");
    // What the person wrote is all still there, in order: the edit only inserted text, apart from
    // the one value it replaced.
    const original = BEFORE.replace('= "deny"   # kept', '= "allow"   # kept');
    let at = 0;
    for (const ch of original) {
      at = after.indexOf(ch, at);
      expect(at).toBeGreaterThanOrEqual(0);
      at += 1;
    }
    const { config } = parseMachineConfig(after, "linux");
    expect(Object.fromEntries(config.approvals)).toEqual({ [ALLOW]: "allow", [OTHER]: "deny" });
    // codex-work's extra argument holds a line break, which an argument may not: it stays dropped.
    expect(config.instances.map((i) => [i.id, i.env])).toEqual([
      ["codex-personal", { CODEX_HOME: "/home/mira/.codex-personal" }],
    ]);
    expect(config.roots).toEqual([
      { id: "work", label: "work", path: "/home/mira/work", runs: true },
    ]);
    expect(config.terminal.app).toBe("ghostty");
  });

  test("CRLF files get CRLF lines, and a file without a final line break gets one first", () => {
    const crlf = BEFORE.replaceAll("\n", "\r\n");
    expect(applied(crlf, EDITS)).toBe(applied(BEFORE, EDITS).replaceAll("\n", "\r\n"));
    expect(
      applied('[log]\nlevel = "info"', [
        { op: "set", table: ["log"], key: "level", value: "debug" },
      ]),
    ).toBe('[log]\nlevel = "debug"');
    expect(
      applied('[log]\nlevel = "info"', [
        { op: "set", table: ["ui"], key: "open_mode", value: "app" },
      ]),
    ).toBe('[log]\nlevel = "info"\n\n[ui]\nopen_mode = "app"\n');
    expect(applied("", [{ op: "set", table: ["log"], key: "level", value: "warn" }])).toBe(
      '[log]\nlevel = "warn"\n',
    );
  });

  test("values are written so they read back exactly: Windows paths as literal strings, escapes, quoted keys", () => {
    const tricky = 'tab\there "quoted" \\ back\u0001\u007f é 😀';
    const text = applied("", [
      { op: "set", table: ["t"], key: "path", value: "C:\\Users\\mira\\Tasks" },
      { op: "set", table: ["t"], key: "tricky", value: tricky },
      { op: "set", table: ["t"], key: "key with space", value: 7 },
      { op: "set", table: ["t"], key: "it's", value: "it's C:\\x" },
    ]);
    expect(text).toContain("path = 'C:\\Users\\mira\\Tasks'");
    expect(text).toContain('"key with space" = 7');
    const result = applyEdits(text, []);
    expect(result.ok).toBe(true);
    expect(applyEdits("", [{ op: "set", table: ["t"], key: "n", value: 2 ** 60 }])).toEqual({
      ok: false,
      reason: "invalid_value",
    });
  });

  test("layouts an edit cannot place are refused, and nothing changes", () => {
    const refusals: [string, Edit, string][] = [
      [
        'approvals = { a = "allow" }\n',
        { op: "set", table: ["approvals"], key: ALLOW, value: "allow" },
        "unsupported_layout",
      ],
      [
        'approvals.x = "allow"\n',
        { op: "set", table: ["approvals"], key: ALLOW, value: "allow" },
        "unsupported_layout",
      ],
      [
        '[approvals]\nsha256.x = "allow"\n',
        { op: "set", table: ["approvals"], key: "sha256", value: "allow" },
        "unsupported_layout",
      ],
      [
        'instance = [{ id = "a" }]\n',
        { op: "append", array: "instance", entries: { id: "b" } },
        "unsupported_layout",
      ],
      [
        '[roots.work]\npath = "/w"\n',
        { op: "add_table", table: ["roots", "work"], entries: { path: "/x" } },
        "exists",
      ],
      ["[log\n", { op: "set", table: ["log"], key: "level", value: "info" }, "invalid_file"],
    ];
    for (const [text, edit, reason] of refusals) {
      expect(applyEdits(text, [edit]), text).toEqual({ ok: false, reason });
    }
  });

  test("on disk: the mode and a byte order mark are kept, a change made meanwhile is never overwritten", () => {
    const dir = tempDir();
    const file = join(dir, MACHINE_TOML);
    // Created when missing.
    expect(
      editMachineToml(dir, [{ op: "set", table: ["log"], key: "level", value: "warn" }]).ok,
    ).toBe(true);
    expect(readFileSync(file, "utf8")).toBe('[log]\nlevel = "warn"\n');
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    writeFileSync(file, '\ufeff# mine\n[log]\nlevel = "warn"\n');
    chmodSync(file, 0o640);
    expect(
      editMachineToml(dir, [{ op: "set", table: ["log"], key: "level", value: "debug" }]).ok,
    ).toBe(true);
    expect(readFileSync(file, "utf8")).toBe('\ufeff# mine\n[log]\nlevel = "debug"\n');
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o640);

    const prepared = prepareEdit(dir, [{ op: "set", table: ["log"], key: "level", value: "info" }]);
    if (!prepared.ok) throw new Error("not prepared");
    writeFileSync(file, '# saved by the person meanwhile\n[log]\nlevel = "error"\n');
    expect(commitEdit(prepared.edit)).toEqual({ ok: false, reason: "changed_meanwhile" });
    expect(readFileSync(file, "utf8")).toBe(
      '# saved by the person meanwhile\n[log]\nlevel = "error"\n',
    );

    writeFileSync(file, "not = [toml\n");
    expect(
      editMachineToml(dir, [{ op: "set", table: ["log"], key: "level", value: "info" }]),
    ).toEqual({
      ok: false,
      reason: "invalid_file",
    });
    expect(readFileSync(file, "utf8")).toBe("not = [toml\n");
  });

  test("the last check runs after the new file is written, just before the rename, and giving up leaves nothing behind", () => {
    const dir = tempDir();
    const file = join(dir, MACHINE_TOML);
    writeFileSync(file, "# mine\n");
    let checked = 0;
    expect(() => {
      atomicWrite(file, "# new\n", 0o600, () => {
        checked += 1;
        // The new file exists beside the old one when the check runs.
        expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
        throw new Error("changed");
      });
    }).toThrow("changed");
    expect(checked).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("# mine\n");
    expect(readdirSync(dir)).toEqual([MACHINE_TOML]);
  });

  test("the last check runs before every rename attempt: a save during a Windows sharing retry is never overwritten", () => {
    const dir = tempDir();
    const file = join(dir, MACHINE_TOML);
    // Owner-only, as the product makes it: the editor writes into nothing that fails the rule.
    writeFileSync(file, '[log]\nlevel = "warn"\n', { mode: 0o600 });
    const prepared = prepareEdit(dir, [{ op: "set", table: ["log"], key: "level", value: "info" }]);
    if (!prepared.ok) throw new Error("not prepared");
    // The first rename meets a sharing failure, and the person saves during the pause.
    renameFaults.busyOnce = () => {
      writeFileSync(file, '[log]\nlevel = "error"\n');
    };
    expect(commitEdit(prepared.edit)).toEqual({ ok: false, reason: "changed_meanwhile" });
    expect(renameFaults.busyOnce).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe('[log]\nlevel = "error"\n');
    expect(readdirSync(dir)).toEqual([MACHINE_TOML]);
  });

  test("an edit that would make the file too large to read is refused, and nothing is written", () => {
    const dir = tempDir();
    const file = join(dir, MACHINE_TOML);
    // Exactly at the bound, with a byte order mark: valid, and one more byte would be too much.
    const text = `${String.fromCharCode(0xfeff)}[log]\nlevel = "warn"\n`;
    const filler = MAX_CONFIG_BYTES - Buffer.byteLength(text, "utf8") - 1;
    const before = `${text}${"#".repeat(filler)}\n`;
    // Owner-only, as the product makes it: a file the umask made group-writable may be refused.
    writeFileSync(file, before, { mode: 0o600 });
    expect(Buffer.byteLength(before, "utf8")).toBe(MAX_CONFIG_BYTES);
    expect(loadMachineConfig(dir, "linux").problems).toEqual([]);
    expect(
      editMachineToml(dir, [{ op: "set", table: ["ui"], key: "open_mode", value: "app" }]),
    ).toEqual({ ok: false, reason: "too_large" });
    expect(readFileSync(file, "utf8")).toBe(before);
    // A change that keeps the size is fine.
    expect(
      editMachineToml(dir, [{ op: "set", table: ["log"], key: "level", value: "info" }]).ok,
    ).toBe(true);
  });

  test("only nothing at all is a missing file: a folder in place of <config>, or a dangling link, is refused", (context) => {
    const dir = tempDir();
    // <config> is a file: no machine.toml can be in it, and the defaults must not stand in.
    const notDir = join(dir, "config-file");
    writeFileSync(notDir, "x");
    expect(loadMachineConfig(notDir, "linux").problems).toEqual([
      { key: "", code: "unreadable", severity: "error" },
    ]);
    expect(
      editMachineToml(notDir, [{ op: "set", table: ["log"], key: "level", value: "info" }]),
    ).toEqual({ ok: false, reason: "invalid_file" });
    // A link whose target is gone: the person's file is elsewhere, so neither the defaults nor a
    // new regular file may replace it.
    const config = join(dir, "config");
    mkdirSync(config, { mode: 0o700 });
    try {
      symlinkSync(join(dir, "gone", MACHINE_TOML), join(config, MACHINE_TOML), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip();
      throw error;
    }
    // A link is never followed: on every OS it is named as a link, with where it points.
    expect(loadMachineConfig(config, "linux").problems).toEqual([
      { key: "", code: "unsafe_permissions", severity: "error" },
    ]);
    expect(
      editMachineToml(config, [{ op: "set", table: ["log"], key: "level", value: "info" }]),
    ).toEqual({ ok: false, reason: "unsafe" });
    expect(lstatSync(join(config, MACHINE_TOML)).isSymbolicLink()).toBe(true);
  });

  test("a file nested past the bound is refused as invalid, never a crash", () => {
    const deep = `[remote.${"x.".repeat(5000)}x]\nk = 1\n`;
    expect(applyEdits(deep, [{ op: "set", table: ["log"], key: "level", value: "info" }])).toEqual({
      ok: false,
      reason: "invalid_file",
    });
  });

  test("text that UTF-8 cannot carry (a lone surrogate) is refused, never written as something else", () => {
    const lone = String.fromCharCode(0xd800);
    const edits: Edit[] = [
      { op: "set", table: ["roots", "a"], key: "path", value: `/home/mira/${lone}` },
      { op: "set", table: ["approvals"], key: `k${lone}`, value: "allow" },
      { op: "append", array: "instance", entries: { id: "a", extra_args: [`x${lone}`] } },
      { op: "append", array: "instance", entries: { id: "a", env: { HOME: `x${lone}` } } },
    ];
    for (const edit of edits) {
      expect(applyEdits("", [edit])).toEqual({ ok: false, reason: "invalid_value" });
    }
    const dir = tempDir();
    expect(editMachineToml(dir, [edits[0] as Edit])).toEqual({
      ok: false,
      reason: "invalid_value",
    });
    expect(existsSync(join(dir, MACHINE_TOML))).toBe(false);
  });

  test("a machine.toml that is a link is never written through: the edit is refused, the link and its target stay", (context) => {
    // Configuration is never read or written through a link (A2 3.2.4), so no edit can reach a
    // file elsewhere.
    const dir = tempDir();
    const real = join(dir, "real");
    mkdirSync(real);
    const text = '# mine\n[log]\nlevel = "warn"\n';
    writeFileSync(join(real, MACHINE_TOML), text, { mode: 0o600 });
    const config = join(dir, "config");
    mkdirSync(config, { mode: 0o700 });
    try {
      symlinkSync(join(real, MACHINE_TOML), join(config, MACHINE_TOML), "file");
    } catch (error) {
      // Windows without the right to make links.
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip();
      throw error;
    }
    expect(
      editMachineToml(config, [{ op: "set", table: ["log"], key: "level", value: "debug" }]),
    ).toEqual({ ok: false, reason: "unsafe" });
    expect(lstatSync(join(config, MACHINE_TOML)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(real, MACHINE_TOML), "utf8")).toBe(text);
  });

  test("the scanner finds headers and keys, never text inside strings, arrays or comments", () => {
    const lines = scanToml(BEFORE);
    expect(lines.filter((l) => l.kind === "header").map((l) => l.path.join("."))).toEqual([
      "log",
      "spaces",
      "instance",
      "instance.env",
      "approvals",
    ]);
    const approval = lines.at(-1);
    expect(approval?.kind === "keyval" && approval.key).toEqual([ALLOW]);
  });
});

describe("[A2.3.2.4.config.edit-remove] taking out an element exactly as it was written", () => {
  const entry = new Map<string, string | boolean | readonly string[] | Record<string, string>>([
    ["id", "codex"],
    ["target", "codex-cli"],
    ["label", "Codex"],
    ["account", "default"],
    ["exec", "/usr/bin/codex"],
    ["config_home", "/home/mira/.codex"],
    ["remote_allowed", false],
  ]);
  const append: Edit = { op: "append", array: "instance", entries: entry };
  const remove: Edit = { op: "remove", array: "instance", entries: entry };

  test("append then remove gives the file back byte for byte, in its own line breaks", () => {
    const files = [
      BEFORE,
      "",
      "# mine\n[http]\nport = 7713\n",
      "[http]\r\nport = 7713\r\n",
      '[[instance]]\nid = "claude"\ntarget = "claude-cli"\nlabel = "Claude Code"\n\n[terminal]\napp = "ghostty"\n',
    ];
    for (const text of files) {
      const added = applyEdits(text, [append]);
      expect(added.ok, text).toBe(true);
      const back = applyEdits(added.ok ? added.text : "", [remove]);
      expect(back, text).toEqual({ ok: true, text });
    }
    // Two added to an empty file, taken out first to last: the file is empty again.
    const other = new Map(entry).set("id", "claude").set("target", "claude-cli");
    const both = applyEdits("", [append, { op: "append", array: "instance", entries: other }]);
    const first = applyEdits(both.ok ? both.text : "", [remove]);
    expect(first).toEqual(applyEdits("", [{ op: "append", array: "instance", entries: other }]));
    const last = applyEdits(first.ok ? first.text : "", [
      { op: "remove", array: "instance", entries: other },
    ]);
    expect(last).toEqual({ ok: true, text: "" });
  });

  test("a file without a final line break: the element ends without one too, and its removal gives the file back", () => {
    const files = [
      "[http]\nport = 7713",
      "[http]\r\nport = 7713",
      "# only a comment",
      '[[instance]]\nid = "claude"\ntarget = "claude-cli"\nlabel = "Claude Code"',
      '[[instance]]\r\nid = "claude"\r\ntarget = "claude-cli"\r\nlabel = "Claude Code"',
    ];
    const other = new Map(entry).set("id", "claude-b").set("target", "claude-cli");
    const appendOther: Edit = { op: "append", array: "instance", entries: other };
    for (const text of files) {
      const added = applyEdits(text, [append]);
      expect(added.ok, text).toBe(true);
      const written = added.ok ? added.text : "";
      expect(written.endsWith("\n"), text).toBe(false);
      expect(applyEdits(written, [remove]), text).toEqual({ ok: true, text });
      // Two appended, taken out in either order: the file comes back.
      const both = applyEdits(text, [append, appendOther]);
      const two = both.ok ? both.text : "";
      expect(two.endsWith("\n"), text).toBe(false);
      expect(
        applyEdits(two, [remove, { op: "remove", array: "instance", entries: other }]),
      ).toEqual({ ok: true, text });
      expect(
        applyEdits(two, [{ op: "remove", array: "instance", entries: other }, remove]),
      ).toEqual({ ok: true, text });
    }
  });

  test("a comment the person wrote directly above or below the element makes it theirs; one a blank line away stays when it goes", () => {
    const base = "[http]\nport = 7713\n";
    const added = applyEdits(base, [append]);
    const text = added.ok ? added.text : "";
    const header = "[[instance]]\n";
    const touching = [
      `${text}# about codex\n`,
      `${text}# about codex`,
      text.replace(header, `# about codex\n${header}`),
      text.replace("\n\n[[instance]]", "\n# about codex\n[[instance]]"),
    ];
    for (const other of touching) {
      expect(applyEdits(other, [remove]), other).toEqual({ ok: false, reason: "absent" });
    }
    // A blank line away, the comment is not the element's: it stays where the person wrote it.
    expect(applyEdits(`${text}\n# later\n`, [remove])).toEqual({
      ok: true,
      text: `${base}\n# later\n`,
    });
    expect(applyEdits(text.replace(base, `${base}# http end\n`), [remove])).toEqual({
      ok: true,
      text: `${base}# http end\n`,
    });
    expect(applyEdits(`# top\n\n${text}`, [remove])).toEqual({
      ok: true,
      text: `# top\n\n${base}`,
    });
  });

  test("an element the person changed, or one with more in it, is never taken out", () => {
    const added = applyEdits("", [append]);
    const text = added.ok ? added.text : "";
    // A value changed, a key added, a comment inside, a sub-table: each is no longer setup's.
    const changed = [
      text.replace('label = "Codex"', 'label = "Codex · work"'),
      text.replace("remote_allowed = false", "remote_allowed = false\nenabled = false"),
      text.replace('label = "Codex"\n', 'label = "Codex" # mine\n'),
      `${text}\n[instance.env]\nCODEX_HOME = "/home/mira/.codex"\n`,
    ];
    for (const other of changed) {
      expect(applyEdits(other, [remove]), other).toEqual({ ok: false, reason: "absent" });
    }
    expect(applyEdits("[http]\nport = 7713\n", [remove])).toEqual({ ok: false, reason: "absent" });
    // Two elements written the same: which one setup wrote cannot be told.
    const twice = applyEdits("", [append, append]);
    expect(applyEdits(twice.ok ? twice.text : "", [remove])).toEqual({
      ok: false,
      reason: "unsupported_layout",
    });
  });
});
