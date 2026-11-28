// Machine preferences (A1 3.16, A2 3.2.4; A7 3.10 M3.11): machine.toml's `[preferences]`, read with
// the registry's validation, and set or reset by one splice that keeps every other byte.
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyEdits, prepareEdit } from "./edit.ts";
import { loadMachineConfig, MACHINE_TOML, parseMachineConfig } from "./machine-toml.ts";
import { readMachinePreferences, setMachinePreference } from "./preferences.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ttasks-prefs-"));
  temps.push(dir);
  return dir;
};

describe("[A1.3.16.prefs.machine] machine preferences live in machine.toml with the registry's validation", () => {
  test("a valid value is read; a key not set reads its default", () => {
    const empty = parseMachineConfig("", "linux");
    expect(readMachinePreferences(empty.config)).toEqual([
      { key: "ui.theme", value: "sumi", state: "default" },
      { key: "ui.single_keys", value: true, state: "default" },
    ]);
    const { config, problems } = parseMachineConfig(
      ["[preferences]", '"ui.theme" = "washi"', '"ui.single_keys" = false', ""].join("\n"),
      "linux",
    );
    expect(problems).toEqual([]);
    expect(readMachinePreferences(config)).toEqual([
      { key: "ui.theme", value: "washi", state: "set" },
      { key: "ui.single_keys", value: false, state: "set" },
    ]);
  });

  test("a bad entry drops itself with a problem that names the key, never the value", () => {
    const text = [
      "[preferences]",
      '"ui.theme" = "purple-secret"',
      '"tasks.dedupe_window_days" = 7',
      '"ui.unknown" = "secret-value"',
      "",
    ].join("\n");
    const { config, problems } = parseMachineConfig(text, "linux");
    expect(config.preferences.size).toBe(0);
    expect(problems).toEqual([
      { key: "preferences.ui.theme", code: "invalid_value", severity: "error" },
      // A space preference lives in the space, where it travels with backups and exports.
      { key: "preferences.tasks.dedupe_window_days", code: "invalid_value", severity: "error" },
      { key: "preferences.ui.unknown", code: "unknown_key", severity: "warning" },
    ]);
    expect(JSON.stringify(problems)).not.toMatch(/purple|secret/);
    expect(parseMachineConfig("preferences = 1\n", "linux").problems).toEqual([
      { key: "preferences", code: "wrong_type", severity: "error" },
    ]);
    // Nested tables are not a whole name: their key is unknown, and nothing is read from them.
    const nested = parseMachineConfig('[preferences.ui]\ntheme = "washi"\n', "linux");
    expect(nested.config.preferences.size).toBe(0);
    expect(nested.problems).toEqual([
      { key: "preferences.ui", code: "unknown_key", severity: "warning" },
    ]);
  });

  test("a set and a reset each splice one line and keep every other byte", () => {
    const dir = tempDir();
    const path = join(dir, MACHINE_TOML);
    const before = '# mine\r\n[ui]\r\nopen_mode = "app" # keep\r\n';
    writeFileSync(path, before, { mode: 0o600 });
    expect(setMachinePreference(dir, "ui.theme", "washi")).toMatchObject({ ok: true });
    const set = readFileSync(path, "utf8");
    expect(set.startsWith(before)).toBe(true);
    expect(loadMachineConfig(dir).config.preferences.get("ui.theme")).toBe("washi");
    // Again with another value: the value is replaced in place.
    expect(setMachinePreference(dir, "ui.theme", "system")).toMatchObject({ ok: true });
    expect(readFileSync(path, "utf8")).toBe(set.replace("washi", "system"));
    expect(loadMachineConfig(dir).config.preferences.get("ui.theme")).toBe("system");
    // Reset: the line goes, the header stays, everything else is as it was.
    expect(setMachinePreference(dir, "ui.theme", null)).toMatchObject({ ok: true });
    const reset = readFileSync(path, "utf8");
    expect(reset).toBe(`${before}\r\n[preferences]\r\n`);
    expect(loadMachineConfig(dir).problems).toEqual([]);
    expect(
      readMachinePreferences(loadMachineConfig(dir).config).find((p) => p.key === "ui.theme"),
    ).toMatchObject({ state: "default" });
  });

  test("a reset of a key that is not set writes nothing, and makes no file", () => {
    const dir = tempDir();
    expect(setMachinePreference(dir, "ui.theme", null)).toMatchObject({ ok: true });
    expect(existsSync(join(dir, MACHINE_TOML))).toBe(false);
  });

  test("a space key, an unknown key and a value outside the shape are refused unwritten", () => {
    const dir = tempDir();
    const path = join(dir, MACHINE_TOML);
    writeFileSync(path, "", { mode: 0o600 });
    for (const [key, value] of [
      ["tasks.dedupe_window_days", 7],
      ["ui.theme", "purple"],
      ["ui.single_keys", "no"],
      ["ui.unknown", "x"],
    ] as const) {
      expect(setMachinePreference(dir, key, value), key).toEqual({
        ok: false,
        reason: "invalid_value",
      });
    }
    expect(readFileSync(path, "utf8")).toBe("");
  });

  test("a config folder that is a link (a junction on Windows) is refused, and its target is left alone", () => {
    const target = tempDir();
    const before = '[preferences]\n"ui.theme" = "washi"\n';
    writeFileSync(join(target, MACHINE_TOML), before, { mode: 0o600 });
    const link = join(tempDir(), "config");
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(setMachinePreference(link, "ui.theme", "system")).toEqual({
      ok: false,
      reason: "unsafe",
    });
    expect(setMachinePreference(link, "ui.theme", null)).toEqual({
      ok: false,
      reason: "unsafe",
    });
    expect(prepareEdit(link, [])).toEqual({ ok: false, reason: "unsafe" });
    expect(readFileSync(join(target, MACHINE_TOML), "utf8")).toBe(before);
  });

  test("unset removes only its own setting, its comment stays, and a key set another way is refused", () => {
    const text = '[preferences]\n"ui.theme" = "washi" # mine\n"other.key" = 1\n';
    expect(applyEdits(text, [{ op: "unset", table: ["preferences"], key: "ui.theme" }])).toEqual({
      ok: true,
      text: '[preferences]\n# mine\n"other.key" = 1\n',
    });
    expect(applyEdits(text, [{ op: "unset", table: ["preferences"], key: "missing" }])).toEqual({
      ok: true,
      text,
    });
    expect(
      applyEdits('preferences = { "ui.theme" = "washi" }\n', [
        { op: "unset", table: ["preferences"], key: "ui.theme" },
      ]),
    ).toEqual({ ok: false, reason: "unsupported_layout" });
  });
});
