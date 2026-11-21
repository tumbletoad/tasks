// Two roots that are one folder, where the real paths do not say so (A1 3.15, "Case is the
// volume's"). Linux's realpath keeps the spelling it was given on a case-folding folder (ext4
// casefold, vfat, an SMB mount) and through a bind mount, so one folder can have two real paths.
// Sameness of roots is decided by identity, so `placeOf` still finds the folder held by two roots.
// The file system here is real; only realpath is made to keep the spelling of one root, as such a
// volume does: every other call, and every identity, comes from the file system.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const keep = vi.hoisted(() => ({
  /** Paths at or below this one come back from realpath as they were given. */
  spelling: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    realpath: async (...args: Parameters<typeof real.realpath>) => {
      const given = String(args[0]);
      if (keep.spelling !== undefined && given.startsWith(keep.spelling)) return given;
      return real.realpath(...args);
    },
  };
});

const { placeOf, rootNaming, resolvePlace } = await import("../src/places.ts");

let base = "";
beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ttasks-places-same-")));
});
afterAll(() => {
  keep.spelling = undefined;
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe("[A1.3.15.places.inverse] two roots that are one folder, whatever their real paths say", () => {
  test("a folder below two roots of one identity is ambiguous_root, even when the real paths differ", async () => {
    const work = join(base, "work");
    const portal = join(work, "portal");
    mkdirSync(portal, { recursive: true });
    // `mount` is the folder `work` under another path whose realpath keeps that path.
    const mount = join(base, "mount");
    symlinkSync(work, mount, process.platform === "win32" ? "junction" : "dir");
    keep.spelling = mount;
    const first = { id: "work", path: work };
    const roots = [first, { id: "mount", path: mount }];
    // `ttasks roots add` compares identities and finds the folder named.
    expect(await rootNaming(mount, [first])).toEqual({ status: "named", root: "work" });
    // Each root resolves its own places.
    expect(await resolvePlace({ root: "mount", path: "portal" }, roots)).toMatchObject({
      status: "ok",
    });
    // The folder is under both: no one place, in either order of the roots.
    for (const order of [roots, [...roots].reverse()]) {
      expect(await placeOf(portal, order)).toEqual({
        status: "failed",
        reason: "ambiguous_root",
        roots: ["mount", "work"],
      });
      expect(await placeOf(join(mount, "portal"), order)).toEqual({
        status: "failed",
        reason: "ambiguous_root",
        roots: ["mount", "work"],
      });
    }
    // A root nested in one of them still holds its own folders: the closest root wins.
    const nested = [...roots, { id: "portal", path: portal }];
    expect(await placeOf(portal, nested)).toMatchObject({ status: "ok", root: "portal", path: "" });
  });
});
