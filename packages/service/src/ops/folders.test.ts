// The stored form of a folder on Linux, macOS and Windows: the home as `~`, the separators made
// plain, the Unicode form and a link's name kept. Fixture paths only: nothing here looks at a disk.
import { describe, expect, test } from "vitest";
import { expanded, storedForm } from "./folders.ts";

describe("[A1.3.15.folders.stored-form] a folder as the space stores it, the home written as ~", () => {
  test("Linux and macOS: ~ in and out, separators made plain, case kept on Linux", () => {
    const home = "/home/mira";
    expect(storedForm("/home/mira/Dev/tasks", home, "linux")).toEqual({
      stored: "~/Dev/tasks",
      absolute: "/home/mira/Dev/tasks",
    });
    expect(storedForm("~/Dev//tasks/", home, "linux")).toEqual({
      stored: "~/Dev/tasks",
      absolute: "/home/mira/Dev/tasks",
    });
    expect(storedForm("~", home, "linux")).toEqual({ stored: "~", absolute: "/home/mira" });
    expect(storedForm("/srv/build", home, "linux")).toEqual({
      stored: "/srv/build",
      absolute: "/srv/build",
    });
    // Whole segments: /home/mirabel is no folder of /home/mira; Linux keeps case.
    expect(storedForm("/home/mirabel/x", home, "linux")).toMatchObject({
      stored: "/home/mirabel/x",
    });
    expect(storedForm("/home/Mira/x", home, "linux")).toMatchObject({ stored: "/home/Mira/x" });
    // macOS compares the home without case.
    expect(storedForm("/Users/MIRA/Dev", "/Users/mira", "darwin")).toMatchObject({
      stored: "~/Dev",
    });
    // A decomposed é stays decomposed: it names another folder than a composed one on Linux.
    const decomposed = "/srv/cafe\u0301";
    expect(storedForm(decomposed, home, "linux")).toMatchObject({ stored: decomposed });
    expect(storedForm("relative/x", home, "linux")).toBe("not_absolute");
    expect(storedForm("/srv/../etc", home, "linux")).toBe("invalid_path");
    expect(storedForm("/srv/a\u0007b", home, "linux")).toBe("invalid_path");
    expect(expanded("~/Dev/tasks", home, "linux")).toBe("/home/mira/Dev/tasks");
    expect(expanded("/srv/build", home, "linux")).toBe("/srv/build");
  });

  test("Windows: ~ without case, \\ between names, an upper-case drive, a share", () => {
    const home = "C:\\Users\\Mira";
    expect(storedForm("c:/users/mira/Projects/tasks", home, "win32")).toEqual({
      stored: "~\\Projects\\tasks",
      absolute: "C:\\users\\mira\\Projects\\tasks",
    });
    expect(storedForm("~/Projects\\tasks\\", home, "win32")).toEqual({
      stored: "~\\Projects\\tasks",
      absolute: "C:\\Users\\Mira\\Projects\\tasks",
    });
    expect(storedForm("d:\\work\\x", home, "win32")).toEqual({
      stored: "D:\\work\\x",
      absolute: "D:\\work\\x",
    });
    expect(storedForm("D:\\", home, "win32")).toMatchObject({ stored: "D:\\" });
    expect(storedForm("\\\\server\\share\\x", home, "win32")).toMatchObject({
      stored: "\\\\server\\share\\x",
    });
    // A drive-relative path depends on the current folder of that drive.
    expect(storedForm("C:work", home, "win32")).toBe("not_absolute");
    expect(storedForm("\\work", home, "win32")).toBe("not_absolute");
    expect(expanded("~\\Projects", home, "win32")).toBe("C:\\Users\\Mira\\Projects");
  });
});
