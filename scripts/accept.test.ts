// pnpm accept: the arguments, and which manifest entries a run takes.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  currentFolderOf,
  parseAcceptArgs,
  PARTS,
  runnable,
  selectEntries,
  versionFolderOf,
  type AcceptArgs,
} from "./accept.ts";
import { parseManifest, type ManifestEntry } from "./manifest.ts";
import { repoRoot } from "./run.ts";

const entry = (id: string, owner: string, kind: ManifestEntry["kind"] = "ci"): ManifestEntry => ({
  id,
  title: id,
  source: "A7 3.18.6",
  owner,
  kind,
  profiles: ["v1"],
});

describe("[A7.3.18.6.accept.parts] pnpm accept m<N> [--part <name>]", () => {
  test("arguments", () => {
    expect(parseAcceptArgs(["m1", "--part", "cli"])).toEqual({
      milestone: 1,
      part: "cli",
      profile: "v1",
      installed: undefined,
    });
    expect(parseAcceptArgs(["m1", "--part", "nothing"])).toBe("m1 has no part nothing");
    expect(parseAcceptArgs(["x"])).toMatch(/^usage/);
    expect(parseAcceptArgs(["m2", "--profile", "v9"])).toBe("unknown profile v9");
  });

  test("entries owned by M1 to M<N>, in the profile and the part", () => {
    const entries = [
      entry("A0.a", "M0"),
      entry("A1.b", "M1"),
      entry("A2.3.10.cli.accept", "M1"),
      entry("A2.c", "M2"),
    ];
    const all: AcceptArgs = { milestone: 1, part: undefined, profile: "v1", installed: undefined };
    expect(selectEntries(entries, all).map((e) => e.id)).toEqual(["A1.b", "A2.3.10.cli.accept"]);
    expect(selectEntries(entries, { ...all, part: "cli" }).map((e) => e.id)).toEqual([
      "A2.3.10.cli.accept",
    ]);
    expect(PARTS["m1"]?.["cli"]).toEqual(["A2.3.10.cli.accept"]);
    expect(PARTS["m1"]?.["build"]).toEqual(["A2.3.10.cli.accept", "A2.3.10.cli.space"]);
    // M2's build part is M1's and the launch shim from the build.
    expect(PARTS["m2"]?.["build"]).toEqual([
      ...(PARTS["m1"]?.["build"] ?? []),
      "A4.5.shim.installed",
    ]);
    expect(parseAcceptArgs(["m1", "--part", "build", "--installed", "dist/linux-x64"])).toEqual({
      milestone: 1,
      part: "build",
      profile: "v1",
      installed: "dist/linux-x64",
    });
    // The installed-build migration drill.
    expect(PARTS["m3"]?.["migration"]).toEqual(["A1.5.migration.drill"]);
    const drill = [...entries, entry("A1.5.migration.drill", "M3"), entry("A3.d", "M3")];
    expect(
      selectEntries(drill, { ...all, milestone: 3, part: "migration" }).map((e) => e.id),
    ).toEqual(["A1.5.migration.drill"]);
    expect(parseAcceptArgs(["m3", "--part", "migration"])).toMatchObject({ part: "migration" });
  });

  test("--installed names a version folder, or the one version folder inside a folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "ttasks-accept-"));
    try {
      const version = join(dir, "linux-x64", "0.1.0");
      mkdirSync(version, { recursive: true });
      writeFileSync(join(version, "manifest.json"), "{}");
      expect(versionFolderOf(version)).toBe(version);
      expect(versionFolderOf(join(dir, "linux-x64"))).toBe(version);
      mkdirSync(join(dir, "linux-x64", "0.2.0"));
      writeFileSync(join(dir, "linux-x64", "0.2.0", "manifest.json"), "{}");
      expect(versionFolderOf(join(dir, "linux-x64"))).toBeUndefined();
      expect(versionFolderOf(join(dir, "missing"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--installed names an install root by the version folder its current names", () => {
    const dir = mkdtempSync(join(tmpdir(), "ttasks-accept-root-"));
    try {
      const root = join(dir, "home");
      const version = join(root, "versions", "0.1.0");
      mkdirSync(version, { recursive: true });
      writeFileSync(join(version, "manifest.json"), "{}");
      expect(currentFolderOf(root)).toBeUndefined();
      writeFileSync(join(root, "home.marker"), "");
      if (process.platform === "win32") writeFileSync(join(root, "current"), "0.1.0");
      else symlinkSync("versions/0.1.0", join(root, "current"));
      expect(currentFolderOf(root)?.toLowerCase()).toBe(version.toLowerCase());
      expect(currentFolderOf(version)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("from source a run takes the ci and installed entries, against an installed build only the installed ones", () => {
    const chosen = [
      entry("A1.a", "M1", "ci"),
      entry("A1.b", "M1", "installed"),
      entry("A1.c", "M1", "manual"),
    ];
    const args: AcceptArgs = { milestone: 1, part: undefined, profile: "v1", installed: undefined };
    expect(runnable(chosen, args).map((e) => e.id)).toEqual(["A1.a", "A1.b"]);
    expect(runnable(chosen, { ...args, installed: "root" }).map((e) => e.id)).toEqual(["A1.b"]);
  });

  test("every part runs all of its entries against an installed build, in the real manifest", () => {
    // An installed run takes only `installed` entries: a part naming a `ci` entry would run nothing
    // there and still pass (the migration drill).
    const { entries, errors } = parseManifest(
      JSON.parse(readFileSync(join(repoRoot, "tests", "manifest.json"), "utf8")) as unknown,
    );
    expect(errors).toEqual([]);
    for (const [milestone, parts] of Object.entries(PARTS)) {
      for (const [part, ids] of Object.entries(parts)) {
        const args: AcceptArgs = {
          milestone: Number(milestone.slice(1)),
          part,
          profile: "v1",
          installed: "root",
        };
        // In manifest order, which need not be the part's.
        expect(
          runnable(selectEntries(entries, args), args)
            .map((e) => e.id)
            .sort(),
          `${milestone} --part ${part}`,
        ).toEqual([...ids].sort());
      }
    }
  });
});
