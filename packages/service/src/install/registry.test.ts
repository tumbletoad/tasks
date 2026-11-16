import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  parseRegExport,
  regBytes,
  RegExe,
  RegExportError,
  RegistryError,
  regKey,
} from "./registry.ts";

// An export in the format `reg export` wrote for a scratch key on Windows 11 (2026-11-13), as
// UTF-16 decoded to text, extended by hand to every value type and escape.
const EXPORT = [
  "\uFEFFWindows Registry Editor Version 5.00",
  "",
  "[HKEY_CURRENT_USER\\Software\\tasks-test-abc\\Run]",
  '"Tasks (abc)"="\\"C:\\\\Users\\\\Mïra 日本\\\\.local\\\\bin\\\\tasksw.exe\\""',
  '"Empty"=""',
  '@="default"',
  '"Quote \\"in\\" name"="a\\\\b"',
  '"Count"=dword:0000000a',
  '"Multi"=hex(7):61,00,00,00,00,00',
  '"Long"=hex:00,01,02,03,04,05,06,07,08,09,0a,0b,0c,0d,0e,0f,10,11,12,13,14,15,16,17,\\',
  "  18,19,1a,1b",
  '"Line"="first',
  'second"',
  "",
  "[HKEY_CURRENT_USER\\Software\\tasks-test-abc\\Explorer\\StartupApproved\\Run]",
  '"Tasks (abc)"=hex:03,00,00,00,11,22,33,44,55,66,77,88',
  "",
  "",
].join("\r\n");

describe("[A2.3.3.2.service-install.reg-export] reading reg.exe export files", () => {
  test("every value type, escaped names and data, the default value and continued hex lines", () => {
    const tree = parseRegExport(EXPORT);
    const run = tree.get("hkcu\\software\\tasks-test-abc\\run");
    expect(run?.get("tasks (abc)")).toEqual({
      name: "Tasks (abc)",
      kind: "REG_SZ",
      data: '"C:\\Users\\Mïra 日本\\.local\\bin\\tasksw.exe"',
    });
    expect(run?.get("empty")).toEqual({ name: "Empty", kind: "REG_SZ", data: "" });
    expect(run?.get("")).toEqual({ name: "", kind: "REG_SZ", data: "default" });
    expect(run?.get('quote "in" name')).toEqual({
      name: 'Quote "in" name',
      kind: "REG_SZ",
      data: "a\\b",
    });
    expect(run?.get("count")).toEqual({ name: "Count", kind: "REG_DWORD", data: "0000000a" });
    expect(run?.get("multi")).toEqual({ name: "Multi", kind: "hex(7)", data: "610000000000" });
    expect(run?.get("long")?.data).toBe(
      Array.from({ length: 28 }, (_, n) => n.toString(16).padStart(2, "0")).join(""),
    );
    expect(run?.get("line")?.data).toBe("first\r\nsecond");
    const approved = tree.get("hkcu\\software\\tasks-test-abc\\explorer\\startupapproved\\run");
    const record = approved?.get("tasks (abc)");
    expect(record?.kind).toBe("REG_BINARY");
    expect(record === undefined ? undefined : [...regBytes(record)]).toEqual([
      3, 0, 0, 0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
    ]);
    expect([...tree.keys()]).toHaveLength(2);
  });

  test("key paths compare without case and with HKEY_CURRENT_USER shortened", () => {
    expect(regKey("HKEY_CURRENT_USER\\Software\\X")).toBe("hkcu\\software\\x");
    expect(regKey("HKCU\\Software\\X")).toBe("hkcu\\software\\x");
    expect(regKey("HKEY_CURRENT_USER_X\\Software")).toBe("hkey_current_user_x\\software");
  });

  test("text that is not an export is refused, not half read", () => {
    expect(() => parseRegExport("REGEDIT4\r\n")).toThrow(RegExportError);
    const header = "Windows Registry Editor Version 5.00\r\n\r\n";
    expect(() => parseRegExport(`${header}"a"="b"\r\n`)).toThrow(RegExportError);
    expect(() => parseRegExport(`${header}[HKEY_CURRENT_USER\\X]\r\n"a"="open`)).toThrow(
      RegExportError,
    );
    expect(() => parseRegExport(`${header}[HKEY_CURRENT_USER\\X]\r\n"a"=qword:1\r\n`)).toThrow(
      RegExportError,
    );
    expect(parseRegExport(`${header}; a comment\r\n`).size).toBe(0);
  });

  test("a key is absent only when its parent's listing says so: every other failure throws, and a read leaves no folder", async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "tasks-reg-")));
    try {
      const KEY = "HKCU\\Software\\tasks-test-abc\\Explorer\\StartupApproved\\Run";
      /** reg.exe played: `export` per `exportCode`, `query <key>` by `listings`. */
      const reg = (exportCode: number | null, listings: Record<string, string | null>) => {
        const calls: string[] = [];
        const scratch = join(dir, "state", "tmp");
        const registry = new RegExe({
          regExe: "reg.exe",
          scratch,
          run: (_file, args) => {
            calls.push(args.slice(0, 2).join(" "));
            if (args[0] === "export") {
              if (exportCode === 0) writeFileSync(args[2] ?? "", Buffer.from(EXPORT, "utf16le"));
              return Promise.resolve({ code: exportCode, stdout: "", stderr: "" });
            }
            const listing = listings[args[1] ?? ""];
            return Promise.resolve(
              listing === undefined || listing === null
                ? { code: listing === null ? null : 1, stdout: "", stderr: "" }
                : { code: 0, stdout: listing, stderr: "" },
            );
          },
        });
        return { registry, calls, scratch };
      };
      const parent = "HKCU\\Software\\tasks-test-abc\\Explorer\\StartupApproved";
      const listing = (...subkeys: string[]) =>
        [
          `\r\nHKEY_CURRENT_USER${parent.slice(4)}`,
          ...subkeys.map((s) => `HKEY_CURRENT_USER${s.slice(4)}`),
          "",
        ].join("\r\n");

      // The parent lists other keys only: absent.
      const absent = reg(1, { [parent]: listing(`${parent}\\Run32`) });
      expect(await absent.registry.tree(KEY)).toBeUndefined();
      expect(absent.calls).toEqual([`export ${KEY}`, `query ${parent}`]);
      // The parent lists it: the export failed for another reason, so the read fails.
      await expect(
        reg(1, { [parent]: listing(`${parent}\\RUN`) }).registry.tree(KEY),
      ).rejects.toThrow(RegistryError);
      // The parent cannot be listed: its parent decides about it.
      const grand = "HKCU\\Software\\tasks-test-abc\\Explorer";
      const gone = reg(1, { [grand]: `\r\nHKEY_CURRENT_USER${grand.slice(4)}\r\n` });
      expect(await gone.registry.tree(KEY)).toBeUndefined();
      const there = reg(1, {
        [grand]: `HKEY_CURRENT_USER${grand.slice(4)}\r\nHKEY_CURRENT_USER${parent.slice(4)}\r\n`,
      });
      await expect(there.registry.tree(KEY)).rejects.toThrow(RegistryError);
      // reg.exe timed out or failed everywhere: never "absent".
      const timedOut = reg(null, {});
      await expect(timedOut.registry.tree(KEY)).rejects.toThrow(RegistryError);
      expect(timedOut.calls.at(-1)).toBe("query HKCU\\Software");

      // A read that worked; no scratch folder is left by any of them.
      const read = reg(0, {});
      expect((await read.registry.tree(KEY))?.size).toBe(2);
      expect(existsSync(join(dir, "state"))).toBe(false);
      // Never above what it created: the empty folder that held it stays (Node spells the folder
      // mkdirSync made as \\?\C:\… on Windows, which once let the cleanup walk past it).
      expect(existsSync(dir)).toBe(true);
      // A scratch folder that was there before stays.
      mkdirSync(read.scratch, { recursive: true });
      expect((await read.registry.tree(KEY))?.size).toBe(2);
      expect(readdirSync(read.scratch)).toEqual([]);
      rmSync(join(dir, "state"), { recursive: true });

      // Two reads at once: the first creates the scratch folders and ends while the second's
      // export is still running. Each read has its own folder, so the second still succeeds.
      const gates: (() => void)[] = [];
      const reader = () =>
        new RegExe({
          regExe: "reg.exe",
          scratch: read.scratch,
          run: (_file, args) =>
            new Promise((resolve) => {
              gates.push(() => {
                writeFileSync(args[2] ?? "", Buffer.from(EXPORT, "utf16le"));
                resolve({ code: 0, stdout: "", stderr: "" });
              });
            }),
        });
      const first = reader().tree(KEY);
      const second = reader().tree(KEY);
      gates[0]?.();
      expect((await first)?.size).toBe(2);
      gates[1]?.();
      expect((await second)?.size).toBe(2);
      expect(existsSync(join(dir, "state"))).toBe(true);
      expect(readdirSync(read.scratch)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
