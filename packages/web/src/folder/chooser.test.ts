import { describe, expect, test } from "vitest";
// The folder chooser's choices from what the service listed, and the folder a typed text names.
import { choicesOf, chosenFolder } from "./chooser.ts";

describe("[A7.3.12.m5-14.web-chooser] the folder chooser's choices and the folder its text names", () => {
  test("begins at the home, the folders that hold the projects, and the roots", () => {
    const choices = choicesOf(
      {
        kind: "start",
        sep: "\\",
        places: [{ folder: "~" }, { folder: "~\\code", project: "Portal" }],
        roots: ["C:\\", "D:\\"],
      },
      true,
    );
    expect(choices.map((c) => [c.kind, c.value])).toEqual([
      ["home", "~\\"],
      ["place", "~\\code\\"],
      ["root", "C:\\"],
      ["root", "D:\\"],
    ]);
  });

  test("a folder's choice lists its own folders; a new name typed can be made, an existing one not", () => {
    const listing = {
      kind: "list" as const,
      sep: "/",
      at: "~/work/",
      prefix: "atl",
      folders: [{ name: "atlas", link: true as const }],
      more: false,
    };
    expect(choicesOf(listing, true)).toEqual([
      { key: "folder:atlas", kind: "folder", label: "atlas", value: "~/work/atlas/", link: true },
      { key: "make", kind: "make", label: "atl", value: "~/work/atl" },
    ]);
    expect(choicesOf(listing, false).map((c) => c.kind)).toEqual(["folder"]);
    expect(
      choicesOf({ ...listing, prefix: "atlas", exact: { folder: "~/work/atlas" } }, true).map(
        (c) => c.kind,
      ),
    ).toEqual(["folder"]);
    expect(choicesOf({ kind: "problem", sep: "/", reason: "folder_missing" }, true)).toEqual([]);
  });

  test("the folder a text names drops its trailing separators, but a root keeps its own", () => {
    expect(chosenFolder("  ~/work/portal/ ")).toBe("~/work/portal");
    expect(chosenFolder("~/")).toBe("~");
    expect(chosenFolder("C:\\Users\\mira\\")).toBe("C:\\Users\\mira");
    expect(chosenFolder("C:\\")).toBe("C:\\");
    expect(chosenFolder("/")).toBe("/");
    expect(chosenFolder("")).toBeUndefined();
  });
});
