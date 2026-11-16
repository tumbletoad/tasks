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
  const dir = mkdtempSync(join(tmpdir(), "tasks-prefs-"));
  temps.push(dir);
  return dir;
};

/** The platform's own absolute path, and the other platform's. */
const here = process.platform === "win32" ? "C:\\tasks-view" : "/srv/tasks-view";
const there = process.platform === "win32" ? "/srv/tasks-view" : "C:\\tasks-view";

describe("[A1.3.16.prefs.machine] machine preferences live in machine.toml with the registry's validation", () => {
  test("a valid value is read; a key not set reads its default", () => {
    const empty = parseMachineConfig("", "linux");
    expect(readMachinePreferences(empty.config)).toEqual([
      { key: "ui.theme", value: "sumi", state: "default" },
      { key: "ui.single_keys", value: true, state: "default" },
      { key: "projection.dir", value: null, state: "default" },
    ]);
    const { config, problems } = parseMachineConfig(
      [
        "[preferences]",
        '"projection.dir" = "/srv/tasks-view"',
        '"ui.theme" = "washi"',
        '"ui.single_keys" = false',
        "",
      ].join("\n"),
      "linux",
    );
    expect(problems).toEqual([]);
    expect(readMachinePreferences(config)).toEqual([
      { key: "ui.theme", value: "washi", state: "set" },
      { key: "ui.single_keys", value: false, state: "set" },
      { key: "projection.dir", value: "/srv/tasks-view", state: "set" },
    ]);
  });

  test("a bad entry drops itself with a problem that names the key, never the value", () => {
    const text = [
      "[preferences]",
      '"projection.dir" = "views"',
      '"autonomy.level" = "full"',
      '"ui.unknown" = "secret-value"',
      "",
    ].join("\n");
    const { config, problems } = parseMachineConfig(text, "linux");
    expect(config.preferences.size).toBe(0);
    expect(problems).toEqual([
      { key: "preferences.projection.dir", code: "not_absolute", severity: "error" },
      // A space preference lives in the space, where it travels with backups and exports.
      { key: "preferences.autonomy.level", code: "invalid_value", severity: "error" },
      { key: "preferences.ui.unknown", code: "unknown_key", severity: "warning" },
    ]);
    expect(JSON.stringify(problems)).not.toMatch(/views|full|secret/);
    // A Windows path on Linux is not absolute there, and the other way round.
    const windows = parseMachineConfig('[preferences]\n"projection.dir" = "C:\\\\v"\n', "linux");
    expect(windows.problems.map((p) => p.code)).toEqual(["not_absolute"]);
    expect(parseMachineConfig("preferences = 1\n", "linux").problems).toEqual([
      { key: "preferences", code: "wrong_type", severity: "error" },
    ]);
    // Nested tables are not a whole name: their key is unknown, and nothing is read from them.
    const nested = parseMachineConfig('[preferences.projection]\ndir = "/srv/v"\n', "linux");
    expect(nested.config.preferences.size).toBe(0);
    expect(nested.problems).toEqual([
      { key: "preferences.projection", code: "unknown_key", severity: "warning" },
    ]);
  });

  test("a set and a reset each splice one line and keep every other byte", () => {
    const dir = tempDir();
    const path = join(dir, MACHINE_TOML);
    const before = '# mine\r\n[ui]\r\nopen_mode = "app" # keep\r\n';
    writeFileSync(path, before, { mode: 0o600 });
    expect(setMachinePreference(dir, "projection.dir", here)).toMatchObject({ ok: true });
    const set = readFileSync(path, "utf8");
    expect(set.startsWith(before)).toBe(true);
    expect(loadMachineConfig(dir).config.preferences.get("projection.dir")).toBe(here);
    // Again with another value: the value is replaced in place.
    const other = `${here}2`;
    expect(setMachinePreference(dir, "projection.dir", other)).toMatchObject({ ok: true });
    expect(readFileSync(path, "utf8")).toBe(set.replace(here, other));
    expect(loadMachineConfig(dir).config.preferences.get("projection.dir")).toBe(other);
    // Reset: the line goes, the header stays, everything else is as it was.
    expect(setMachinePreference(dir, "projection.dir", null)).toMatchObject({ ok: true });
    const reset = readFileSync(path, "utf8");
    expect(reset).toBe(`${before}\r\n[preferences]\r\n`);
    expect(loadMachineConfig(dir).problems).toEqual([]);
    expect(
      readMachinePreferences(loadMachineConfig(dir).config).find((p) => p.key === "projection.dir"),
    ).toMatchObject({ state: "default" });
  });

  test("a reset of a key that is not set writes nothing, and makes no file", () => {
    const dir = tempDir();
    expect(setMachinePreference(dir, "projection.dir", null)).toMatchObject({ ok: true });
    expect(existsSync(join(dir, MACHINE_TOML))).toBe(false);
  });

  test("a space key, an unknown key, a value outside the shape and another platform's path are refused unwritten", () => {
    const dir = tempDir();
    const path = join(dir, MACHINE_TOML);
    writeFileSync(path, "", { mode: 0o600 });
    for (const [key, value] of [
      ["autonomy.level", "full"],
      ["ui.theme", "purple"],
      ["ui.single_keys", "no"],
      ["ui.unknown", "x"],
      ["projection.dir", 3],
      ["projection.dir", "relative/view"],
      ["projection.dir", there],
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
    const before = '[preferences]\n"projection.dir" = "' + here.replaceAll("\\", "\\\\") + '"\n';
    writeFileSync(join(target, MACHINE_TOML), before, { mode: 0o600 });
    const link = join(tempDir(), "config");
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(setMachinePreference(link, "projection.dir", `${here}2`)).toEqual({
      ok: false,
      reason: "unsafe",
    });
    expect(setMachinePreference(link, "projection.dir", null)).toEqual({
      ok: false,
      reason: "unsafe",
    });
    expect(prepareEdit(link, [])).toEqual({ ok: false, reason: "unsafe" });
    expect(readFileSync(join(target, MACHINE_TOML), "utf8")).toBe(before);
  });

  test("unset removes only its own line, and a key set another way is refused", () => {
    const text = '[preferences]\n"projection.dir" = "/a" # mine\n"other.key" = 1\n';
    expect(
      applyEdits(text, [{ op: "unset", table: ["preferences"], key: "projection.dir" }]),
    ).toEqual({ ok: true, text: '[preferences]\n"other.key" = 1\n' });
    expect(applyEdits(text, [{ op: "unset", table: ["preferences"], key: "missing" }])).toEqual({
      ok: true,
      text,
    });
    expect(
      applyEdits('preferences = { "projection.dir" = "/a" }\n', [
        { op: "unset", table: ["preferences"], key: "projection.dir" },
      ]),
    ).toEqual({ ok: false, reason: "unsupported_layout" });
  });
});
