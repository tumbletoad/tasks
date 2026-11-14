// Self-test of the M0.10 lab code (row L10): the trust-entry patch and its inverse on fixture files.
// No CLI and no agent home: every case runs in a temporary folder, so this runs in CI. "Restored
// exactly" is checked with lab run A's config recorder (a hash of every file and the key list).
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { compareRecords, recordHome } from "../agents/config-record.ts";
import { openScratch } from "../agents/scratch.ts";
import { cleanEnv, run } from "../agents/spawn.ts";
import { claudeCases, codexCases, type Case } from "./fixtures.ts";
import {
  TrustPatchError,
  claudeTrustKey,
  codexTrustKey,
  decodeUtf8,
  patchClaudeJson,
  patchCodexToml,
  readTrust,
  sha256,
  tomlQuote,
  undoTrust,
  type PatchResult,
} from "./trust-patch.ts";

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "tasks-m0-10-"));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const write = (file: string, text: string | null) => {
  if (text === null) {
    if (existsSync(file)) unlinkSync(file);
  } else writeFileSync(file, text);
};
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);

interface Kind {
  name: "claude" | "codex";
  file: string;
  kind: "json" | "toml";
  patch: (text: string | null, key: string) => PatchResult;
  /** The key path the config recorder lists for the trust key. */
  keyPath: (key: string) => string;
}

const CLAUDE: Kind = {
  name: "claude",
  file: ".claude.json",
  kind: "json",
  patch: patchClaudeJson,
  keyPath: (k) => `projects.${k}.hasTrustDialogAccepted`,
};
const CODEX: Kind = {
  name: "codex",
  file: "config.toml",
  kind: "toml",
  patch: (t, k) => patchCodexToml(t, k),
  keyPath: (k) => `projects.${/[.]/.test(k) ? `"${k}"` : k}.trust_level`,
};

// Keys as the two OSes spell them (fixture paths only), with a space, a non-ASCII character, and
// on Linux a quote that forces a TOML basic string.
const KEYS = {
  claude: [
    claudeTrustKey("C:\\scratch\\work dir ü", "win32"),
    claudeTrustKey("/home/u/scratch/wörk", "posix"),
  ],
  codex: [codexTrustKey("C:\\scratch\\work dir ü"), codexTrustKey("/home/u/scratch/it's wörk")],
} as const;

function cases(k: Kind, key: string): Case[] {
  return k.name === "claude"
    ? claudeCases(key, `${key}-other`)
    : codexCases(key, `${key}-other`, tomlQuote);
}

/** Patch and undo one case in a fresh home folder; returns the records for the assertions. */
function roundTrip(k: Kind, key: string, c: Case) {
  const home = temp();
  const file = join(home, k.file);
  write(file, c.text);
  const before = recordHome(home, c.text === null ? [] : [k.file]);
  const patched = k.patch(c.text, key);
  write(file, patched.text);
  const after = recordHome(home, [k.file]);
  const undone = undoTrust(read(file), patched.undo);
  write(file, undone.text);
  const restored = recordHome(home, c.text === null ? [] : [k.file]);
  return { file, before, after, patched, undone, restored };
}

describe("[A7.3.7.m0-launch.trust-patch] the M0.10 trust-entry patch and its exact undo", () => {
  for (const k of [CLAUDE, CODEX]) {
    for (const key of KEYS[k.name]) {
      for (const c of cases(k, key)) {
        if (c.expect === "refused") continue;
        test(`${k.name} ${key.startsWith("/") ? "posix" : "windows"} key, ${c.name}: ${c.about}`, () => {
          const r = roundTrip(k, key, c);
          expect(r.patched.undo.change).toBe(c.expect);
          // The patched file holds the trust key, readable by the same scanner and by the
          // recorder's own parser; for JSON also by JSON.parse.
          expect(readTrust(k.kind, r.patched.text, key)).toBe("trusted");
          if (k.kind === "json") {
            const parsed = JSON.parse(r.patched.text.replace(/^\uFEFF/, "")) as {
              projects: Record<string, { hasTrustDialogAccepted: boolean }>;
            };
            expect(parsed.projects[key]?.hasTrustDialogAccepted).toBe(true);
          }
          if (c.expect === "none") {
            expect(compareRecords(r.before, r.after).restored).toBe(true);
          } else {
            const diff = compareRecords(r.before, r.after);
            expect(diff.restored).toBe(false);
            const keys = [
              ...(diff.keys_added[k.file] ?? []),
              ...(diff.values_changed[k.file] ?? []),
            ];
            // The recorder lists keys as written: a key spelled with escapes, or a file it cannot
            // parse (JSON behind a byte order mark), shows the trust key in another form.
            if (c.name !== "bom") {
              const leaf = k.kind === "json" ? ".hasTrustDialogAccepted" : ".trust_level";
              expect(
                keys.some(
                  (p) => p === k.keyPath(key) || (c.name.includes("key") && p.endsWith(leaf)),
                ),
              ).toBe(true);
            }
            // Only the trust key and its containers changed: every key from before keeps its value
            // except the trust key itself.
            expect(
              (diff.values_changed[k.file] ?? []).filter((p) => !p.startsWith("projects")),
            ).toEqual([]);
            expect(diff.keys_removed).toEqual({});
          }
          // The undo restores the exact bytes (or removes the file it created).
          const cmp = compareRecords(r.before, r.restored);
          expect(cmp.restored).toBe(true);
          expect(read(r.file)).toBe(c.text);
          expect(r.undone.path).toBe(
            c.expect === "none"
              ? "nothing to undo"
              : c.expect === "file"
                ? "file removed"
                : "exact",
          );
          if (c.text !== null) expect(sha256(read(r.file) ?? "")).toBe(r.patched.undo.sha_before);
          // Line endings and indentation follow the file.
          if (c.text?.includes("\r\n") === true) {
            expect(r.patched.text.replace(/\r\n/g, "")).not.toContain("\n");
          }
        });
      }
    }
  }

  test("the undo record holds only Tasks's own text and the key's previous value, never other content", () => {
    for (const k of [CLAUDE, CODEX]) {
      const key = KEYS[k.name][0];
      for (const c of cases(k, key)) {
        if (c.expect === "refused" || c.text === null) continue;
        const { undo } = k.patch(c.text, key);
        const record = JSON.stringify(undo);
        for (const marker of [
          "fixture-server",
          "fixture-model",
          "server.js",
          "numStartups",
          "lastCost",
        ]) {
          expect(record).not.toContain(marker);
        }
        for (const s of undo.splices) {
          expect(
            s.removed.trim() === "" || s.removed === "false" || /untrusted/.test(s.removed),
          ).toBe(true);
        }
      }
    }
  });

  test("layouts the patch does not edit are refused with a fixed code and no change", () => {
    for (const key of KEYS.codex) {
      for (const c of codexCases(key, `${key}-other`, tomlQuote).filter(
        (x) => x.expect === "refused",
      )) {
        let error: unknown;
        try {
          patchCodexToml(c.text, key);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(TrustPatchError);
        expect((error as TrustPatchError).code).toBe("unsupported projects layout");
        expect((error as Error).message).not.toContain(key);
      }
    }
    expect(() => patchClaudeJson("[1, 2]", "/x")).toThrow("the file's top level is not an object");
    expect(() => patchClaudeJson('{"projects": []}', "/x")).toThrow("projects is not an object");
    expect(() => patchClaudeJson('{"a": 1,}', "/x")).toThrow("not strict JSON");
    expect(() => patchClaudeJson('{"projects": {"/x": {}, "/x": {}}}', "/x")).toThrow(
      "duplicate key",
    );
  });

  test("Codex on Windows: an existing table in another case is the same folder (fold)", () => {
    const key = "C:\\Scratch\\Work";
    const text = `[projects.'c:\\scratch\\work']\ntrust_level = "untrusted"\n`;
    const r = patchCodexToml(text, key, true);
    expect(r.undo.change).toBe("value");
    expect(r.text).toBe(`[projects.'c:\\scratch\\work']\ntrust_level = "trusted"\n`);
    expect(undoTrust(r.text, r.undo, true).text).toBe(text);
    // Without fold a second table is added: the case Tasks must avoid on Windows.
    expect(patchCodexToml(text, key).undo.change).toBe("entry");
  });

  test("Codex: an escaped quote run inside a multi-line basic string does not close it", () => {
    // `\"""` is an escaped quote and two quotes, still inside the string, so the header-like line
    // below is string content, not the folder's table.
    const key = "/scratch/work";
    const text = `note = """a \\""" b\n[projects.'${key}']\ntrust_level = "untrusted"\n"""\n`;
    expect(readTrust("toml", text, key)).toBe("absent");
    const r = patchCodexToml(text, key);
    expect(r.undo.change).toBe("entry");
    expect(r.text.startsWith(text)).toBe(true);
    expect(undoTrust(r.text, r.undo).text).toBe(text);
    // An escaped backslash before the closing quotes does close it.
    const closed = `note = """a \\\\"""\n[projects.'${key}']\ntrust_level = "untrusted"\n`;
    expect(readTrust("toml", closed, key)).toBe("other");
  });

  test("a TOML file the scanner cannot fully account for is refused untouched, valid odd TOML is not", () => {
    const key = "/x";
    const refused = [
      // An ordinary string that does not end on its line: the header below would be misread.
      `note = "unterminated\n[projects.'${key}']\ntrust_level = "untrusted"\n`,
      `note = 'unterminated\n`,
      `[projects.'${key}']\ntrust_level = "untrusted\nfoo = 1\n`,
      // Brackets that do not match, or close what was never opened.
      `a = [1, 2}\n`,
      `a = ]\n`,
      `a = [1, [2]\n[projects.'${key}']\n]]\n`,
      // Text after a complete value, or no value at all.
      `a = 1 2\n`,
      `a = "x" y\n`,
      `a = # nothing\n`,
      `a = [1]\n x\n`,
      // A carriage return that is not part of a CRLF line ending.
      `a = 1\rb = 2\n`,
      // The same table or key twice.
      `[x]\n[x]\n`,
      `a = 1\na = 2\n`,
      `[projects.'${key}']\ntrust_level = "untrusted"\n[y]\nz = 1\nz = 2\n`,
      // Bare words that are no TOML value, and a carriage return at the very end.
      `a = xyz\n`,
      `a = 1foo\n`,
      `a = 0xGG\n`,
      `a = 1__2\n`,
      `a = 1979-05-27 x\n`,
      `a = 1\r`,
    ];
    for (const text of refused) {
      expect(() => patchCodexToml(text, key), JSON.stringify(text)).toThrow(TrustPatchError);
      expect(readTrust("toml", text, key)).toBe("unreadable");
    }
    const accepted = [
      `d = 1979-05-27 07:32:00Z\nn = +inf\nx = -1_000\nh = 0xDEAD_beef\n`,
      `t = { a = [1, { b = "]" }], c = 'x' }\n`,
      `arr = [\n  "a", # c ]\n  [1, 2],\n  { k = "}" },\n]\n`,
      `[[fruits]]\nname = "a"\n[[fruits]]\nname = "b"\n`,
      `s = """\nx = 1\n[projects.'${key}']\n"""\n`,
      `l = '''it''s'''\nm = """a\\\n  b"""  # done\n`,
      `[a]\nb.c = 1\nb.d = 2\n`,
      // Every bare value form of TOML 1.0.
      [
        "i = +99",
        "j = -17",
        "k = 1_000",
        "h = 0xdead_BEEF",
        "o = 0o755",
        "b = 0b1101_0110",
        "f = -6.626e-34",
        "g = 5e+22",
        "m = 224_617.445_991_228",
        "pi = +inf",
        "ni = -nan",
        "t = true",
        "u = false",
        "odt1 = 1979-05-27T07:32:00Z",
        "odt2 = 1979-05-27t00:32:00.999999-07:00",
        "odt3 = 1979-05-27 07:32:00z",
        "ldt = 1979-05-27T07:32:00",
        "ld = 1979-05-27",
        "lt = 00:32:00.999999",
      ].join("\n") + "\n",
      // Sub-tables of different array elements are not duplicates.
      `[[fruits]]\n[fruits.physical]\nc = 1\n[[fruits]]\n[fruits.physical]\nc = 2\n`,
    ];
    for (const text of accepted) {
      const r = patchCodexToml(text, key);
      expect(r.undo.change, JSON.stringify(text)).toBe("entry");
      expect(undoTrust(r.text, r.undo).text).toBe(text);
    }
  });

  test("files are read as strict UTF-8: invalid bytes are refused, a byte order mark is kept", () => {
    expect(() => decodeUtf8(Buffer.from("7b226e6f7465223a22ff227d", "hex"))).toThrow(
      TrustPatchError,
    );
    const bom = Buffer.from("efbbbf7b7d0a", "hex");
    const text = decodeUtf8(bom);
    expect(text).toBe("﻿{}\n");
    expect(Buffer.from(text, "utf8").equals(bom)).toBe(true);
  });

  test("an existing trust value that is not a plain value is refused, so the undo record never holds other content", () => {
    expect(() =>
      patchClaudeJson('{"projects": {"/x": {"hasTrustDialogAccepted": {"a": "s"}}}}', "/x"),
    ).toThrow("unexpected trust value");
    expect(() =>
      patchClaudeJson('{"projects": {"/x": {"hasTrustDialogAccepted": "yes"}}}', "/x"),
    ).toThrow("unexpected trust value");
    expect(() => patchCodexToml(`[projects.'/x']\ntrust_level = { a = "x" }\n`, "/x")).toThrow(
      "unexpected trust value",
    );
    expect(() => patchCodexToml(`[projects.'/x']\ntrust_level = [1]\n`, "/x")).toThrow(
      "unexpected trust value",
    );
    // Plain earlier values stay possible: false, null, any string.
    expect(
      patchClaudeJson('{"projects": {"/x": {"hasTrustDialogAccepted": null}}}', "/x").undo.previous,
    ).toBe("null");
    expect(patchCodexToml(`[projects.'/x']\ntrust_level = 'other'\n`, "/x").undo.previous).toBe(
      "'other'",
    );
  });

  test("the lab command removes nothing outside the removal rule and starts CLIs only through the clean spawner", () => {
    const source = readFileSync(new URL("./lab.ts", import.meta.url), "utf8");
    // Removals: only `sc.remove` (scratch.ts). No direct fs removal, rename or copy.
    expect(source).not.toMatch(
      /\b(?:rmSync|rmdirSync|unlinkSync|renameSync|copyFileSync|cpSync)\b/,
    );
    expect(source).not.toMatch(/from "node:fs\/promises"/);
    // Processes: only `run` from spawn.ts, never child_process directly.
    expect(source).not.toMatch(/node:child_process/);
  });

  test("the lab command refuses a scratch folder it did not create in this run, before it writes anything", async () => {
    const base = temp();
    const scratchDir = join(base, "m0-10");
    // A scratch folder from an earlier run, with a working folder whose `.mcp.json` is a hard link
    // to a file outside: a write through it would change that file.
    openScratch(scratchDir).mkdir(join(scratchDir, "work"));
    const outside = join(base, "outside.json");
    writeFileSync(outside, "{}");
    linkSync(outside, join(scratchDir, "work", ".mcp.json"));
    const fakes = join(base, "fakes");
    mkdirSync(fakes);
    for (const name of ["claude", "codex"]) {
      writeFileSync(
        join(fakes, `${name}.mjs`),
        'console.log(process.argv.includes("--version") ? "0.0.0" : "[]")\n',
      );
    }
    // The same folder spelled through a name that does not exist: on POSIX a lookup of the raw
    // text fails, while the resolved path is the reused folder. A ledger linked outside too.
    const outsideLedger = join(base, "outside-ledger.json");
    writeFileSync(outsideLedger, "sentinel");
    linkSync(outsideLedger, join(scratchDir, "ledger.json"));
    for (const spelled of [scratchDir, `${scratchDir}/missing/..`]) {
      const r = await run(
        process.execPath,
        [fileURLToPath(new URL("./lab.ts", import.meta.url)), "l10", "--scratch", spelled],
        {
          env: { ...cleanEnv(process.env), TASKS_M0_TEST_CLIS: fakes },
          cwd: base,
          timeoutMs: 60_000,
        },
      );
      expect(r.code).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("error: scratch folder is not fresh");
      expect(`${r.stdout}${r.stderr}`).not.toContain(base);
      expect(readFileSync(outside, "utf8")).toBe("{}");
      expect(readFileSync(outsideLedger, "utf8")).toBe("sentinel");
      expect(existsSync(join(scratchDir, "homes"))).toBe(false);
    }
  });

  test("the key spelling the CLIs look up (lab run L)", () => {
    expect(claudeTrustKey("C:\\Users\\x\\work dir", "win32")).toBe("C:/Users/x/work dir");
    expect(claudeTrustKey("/home/x/work", "posix")).toBe("/home/x/work");
    expect(codexTrustKey("C:\\Users\\x\\work")).toBe("C:\\Users\\x\\work");
    expect(tomlQuote("C:\\a b\\ü")).toBe("'C:\\a b\\ü'");
    expect(tomlQuote("/a/it's")).toBe(`"/a/it's"`);
  });

  describe("the file changed after the patch: only Tasks's key reverts, the app's changes stay", () => {
    test("Claude: the app changed another key", () => {
      const key = KEYS.claude[0];
      for (const c of claudeCases(key, `${key}-other`)) {
        if (c.text === null || c.expect === "none" || !c.text.includes('"numStartups": 12'))
          continue;
        const p = patchClaudeJson(c.text, key);
        const app = (t: string) => t.replace('"numStartups": 12', '"numStartups": 13');
        const u = undoTrust(app(p.text), p.undo);
        expect(u.path).toBe("key-level");
        expect(u.text).toBe(app(c.text));
      }
    });

    test("Claude: the app rewrote the whole file in its own format", () => {
      const key = KEYS.claude[0];
      for (const c of claudeCases(key, `${key}-other`)) {
        if (c.text === null || c.expect === "none") continue;
        const p = patchClaudeJson(c.text, key);
        const rewritten = `${JSON.stringify(JSON.parse(p.text.replace(/^\uFEFF/, "")), null, 2)}\n`;
        const u = undoTrust(rewritten, p.undo);
        // A file already in the app's format comes back unchanged, so the exact path applies.
        expect(u.path).toBe(rewritten === p.text ? "exact" : "key-level");
        const want = JSON.parse(c.text.replace(/^\uFEFF/, "")) as Record<string, unknown>;
        expect(JSON.parse(u.text ?? "")).toEqual(want);
      }
      // The file did not exist: the app added a key; the undo keeps the file without the entry.
      const p = patchClaudeJson(null, key);
      const app = p.text.replace("{\n", '{\n  "numStartups": 1,\n');
      const u = undoTrust(app, p.undo);
      expect(u.path).toBe("key-level");
      expect(JSON.parse(u.text ?? "")).toEqual({ numStartups: 1 });
    });

    test("Codex: the user added a table after Tasks's", () => {
      for (const key of KEYS.codex) {
        for (const c of codexCases(key, `${key}-other`, tomlQuote)) {
          if (c.text === null || c.expect === "none" || c.expect === "refused") continue;
          const p = patchCodexToml(c.text, key);
          const nl = p.text.includes("\r\n") ? "\r\n" : "\n";
          const extra = `${nl}[features]${nl}web_search = true${nl}`;
          const u = undoTrust(p.text + extra, p.undo);
          expect(u.path).toBe("key-level");
          // Tasks's own table goes with the blank line that separated it; a changed or added
          // trust_level line inside an existing table goes alone.
          const want =
            p.undo.change === "entry"
              ? c.text + (c.text.endsWith("\n") ? "" : nl) + extra.slice(nl.length)
              : c.text + extra;
          expect(u.text).toBe(want);
        }
      }
    });

    test("Codex: a comment the user put on Tasks's table header keeps the header", () => {
      const p = patchCodexToml('model = "a"\n', "/x");
      const commented = p.text.replace("[projects.'/x']", "[projects.'/x'] # Keep this note");
      const u = undoTrust(commented, p.undo);
      expect(u.path).toBe("key-level");
      expect(u.text).toBe(`model = "a"\n\n[projects.'/x'] # Keep this note\n`);
      // A comment on Tasks's key line stays as a comment line, and the table with it.
      const onKey = p.text.replace(
        'trust_level = "trusted"',
        'trust_level = "trusted" # Keep this too',
      );
      expect(undoTrust(onKey, p.undo).text).toBe(
        `model = "a"\n\n[projects.'/x']\n# Keep this too\n`,
      );
    });

    test("a trust key whose value changed since the patch is left alone and reported", () => {
      const key = "/x";
      // Claude Code: Tasks's entry, then the value set to false by someone else.
      const c = patchClaudeJson('{\n  "projects": {}\n}\n', key);
      const cFalse = c.text.replace(
        '"hasTrustDialogAccepted": true',
        '"hasTrustDialogAccepted": false',
      );
      expect(undoTrust(cFalse, c.undo)).toEqual({ text: cFalse, path: "key changed" });
      // Claude Code: a value change, then changed again.
      const v = patchClaudeJson('{"projects": {"/x": {"hasTrustDialogAccepted": false}}}', key);
      const vNull = v.text.replace(
        '"hasTrustDialogAccepted": true',
        '"hasTrustDialogAccepted": null',
      );
      expect(vNull).not.toBe(v.text);
      expect(undoTrust(vNull, v.undo)).toEqual({ text: vNull, path: "key changed" });
      // Codex: Tasks's table, then the user chose "untrusted".
      const t = patchCodexToml('model = "a"\n', key);
      const tUntrusted = t.text.replace('"trusted"', '"untrusted"');
      expect(undoTrust(tUntrusted, t.undo)).toEqual({ text: tUntrusted, path: "key changed" });
      // Codex: the same value in the other string kind is still Tasks's value.
      const tLiteral = `${t.text.replace('"trusted"', "'trusted'")}# app note\n`;
      expect(undoTrust(tLiteral, t.undo).path).toBe("key-level");
    });

    test("an entry that was removed by the app is reported, not invented", () => {
      const key = KEYS.claude[0];
      const p = patchClaudeJson('{\n  "numStartups": 1\n}\n', key);
      expect(undoTrust('{\n  "numStartups": 2\n}\n', p.undo).path).toBe("key gone");
      expect(undoTrust(null, p.undo).path).toBe("key gone");
    });
  });
});
