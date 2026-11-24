// The stored form of a folder on Linux, macOS and Windows: the home as `~`, the separators made
// plain, the Unicode form and a link's name kept; and the project a working folder belongs to.
// Fixture paths, and for a link a temporary folder of this test.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bounded, deepestProject, expanded, storedForm } from "./folders.ts";

describe("[A1.3.15.folders.stored-form] a folder as the space stores it, the home written as ~", () => {
  test("Linux and macOS: ~ in and out, separators made plain, case kept on Linux", () => {
    const home = "/home/mira";
    expect(storedForm("/home/mira/work/tasks", home, "linux")).toEqual({
      stored: "~/work/tasks",
      absolute: "/home/mira/work/tasks",
    });
    expect(storedForm("~/work//tasks/", home, "linux")).toEqual({
      stored: "~/work/tasks",
      absolute: "/home/mira/work/tasks",
    });
    expect(storedForm("~", home, "linux")).toEqual({ stored: "~", absolute: "/home/mira" });
    expect(storedForm("/srv/build", home, "linux")).toEqual({
      stored: "/srv/build",
      absolute: "/srv/build",
    });
    // Whole segments: /home/mirafixture is no folder of /home/mira; Linux keeps case.
    expect(storedForm("/home/mirafixture/x", home, "linux")).toMatchObject({
      stored: "/home/mirafixture/x",
    });
    expect(storedForm("/home/Mira/x", home, "linux")).toMatchObject({ stored: "/home/Mira/x" });
    // macOS compares the home without case.
    expect(storedForm("/Users/MIRA/work", "/Users/mira", "darwin")).toMatchObject({
      stored: "~/work",
    });
    // A decomposed é stays decomposed: it names another folder than a composed one on Linux.
    const decomposed = "/srv/cafe\u0301";
    expect(storedForm(decomposed, home, "linux")).toMatchObject({ stored: decomposed });
    expect(storedForm("relative/x", home, "linux")).toBe("not_absolute");
    expect(storedForm("/srv/../etc", home, "linux")).toBe("invalid_path");
    expect(storedForm("/srv/./portal/.", home, "linux")).toMatchObject({ stored: "/srv/portal" });
    expect(storedForm("C:\\work\\.\\portal", "C:\\Users\\mira", "win32")).toMatchObject({
      stored: "C:\\work\\portal",
    });
    expect(storedForm("/srv/a\u0007b", home, "linux")).toBe("invalid_path");
    expect(expanded("~/work/tasks", home, "linux")).toBe("/home/mira/work/tasks");
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

describe("[A1.3.15.folders.bounded] a look at the disk is timed by the time this process could listen", () => {
  /** Keeps this process busy for `ms`, as a stall of the service does. */
  function holdUp(ms: number): void {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      /* held up */
    }
  }

  test("a look of several steps answered while this process was held up before each counts as answered", async () => {
    // Each answer is already on its way when the process is held up, as a read of the disk's is,
    // and each next step is asked only once the one before was delivered: one turn of the event
    // loop per step.
    const look = bounded(async () => {
      for (const step of ["first", "second", "third"]) {
        const answer = new Promise((resolve) => setImmediate(resolve, step));
        holdUp(100);
        expect(await answer).toBe(step);
      }
      return "answered";
    }, 40);
    expect(await look).toBe("answered");
  });

  test("a look that never answers is given up after its limit of time this process ran, a stall counting little", async () => {
    let started = performance.now();
    expect(await bounded(() => new Promise<never>(() => undefined), 60)).toBe("not_answering");
    expect(performance.now() - started).toBeGreaterThanOrEqual(60);

    started = performance.now();
    const look = bounded(() => {
      holdUp(300);
      return new Promise<never>(() => undefined);
    }, 60);
    expect(await look).toBe("not_answering");
    // The stall counts as one short tick: the look still had most of its limit after it.
    expect(performance.now() - started).toBeGreaterThanOrEqual(300 + 50);
  });

  test("a look given up is told so, and one that answered is not", async () => {
    const signals: AbortSignal[] = [];
    await bounded((signal) => {
      signals.push(signal);
      return new Promise<never>(() => undefined);
    }, 20);
    await bounded((signal) => {
      signals.push(signal);
      return Promise.resolve("answered");
    }, 20);
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
  });
});
describe("[A1.3.15.folders.deepest] the project a working folder belongs to", () => {
  const project = (name: string, stored: string) => ({ project: name, name, stored });

  test("the deepest project folder that holds it, by whole names and the machine's case rule", async () => {
    const home = "/home/mira";
    const projects = [
      project("portal", "~/work/portal"),
      project("web", "~/work/portal/web"),
      project("old", "~/work/old"),
    ];
    const at = (path: string, platform: NodeJS.Platform = "linux", own = home) => {
      const folder = storedForm(path, own, platform);
      if (typeof folder === "string") throw new Error(folder);
      return deepestProject(folder, projects, { home: own, platform });
    };
    expect(await at("/home/mira/work/portal/web/app")).toMatchObject({
      projects: [{ project: "web" }],
      exact: false,
    });
    expect(await at("/home/mira/work/portal")).toMatchObject({
      projects: [{ project: "portal" }],
      exact: true,
    });
    expect(await at("/home/mira/work/portal-old/x")).toBeUndefined();
    // Any number of projects share a folder: each is the folder's.
    projects.push(project("bugs", "~/work/portal"));
    const shared = await at("/home/mira/work/portal/docs");
    expect(shared?.projects.map((p) => p.project)).toEqual(["portal", "bugs"]);
    expect(shared?.exact).toBe(false);
    expect(await at("/home/mira/work/Portal/x")).toBeUndefined();
    const windows = [project("portal", "~\\work\\portal")];
    const folder = storedForm("C:\\Users\\Mira\\Work\\PORTAL\\api", "C:\\Users\\Mira", "win32");
    if (typeof folder === "string") throw new Error(folder);
    expect(
      await deepestProject(folder, windows, { home: "C:\\Users\\Mira", platform: "win32" }),
    ).toMatchObject({ projects: [{ project: "portal" }], exact: false });
  });

  test("a project folder reached through a link holds the folders of its target", async () => {
    const root = mkdtempSync(join(tmpdir(), "ttasks-deepest-"));
    try {
      const real = join(root, "real", "portal");
      mkdirSync(join(real, "src"), { recursive: true });
      const link = join(root, "linked");
      symlinkSync(join(root, "real"), link, process.platform === "win32" ? "junction" : "dir");
      const home = join(root, "home");
      const folder = storedForm(join(real, "src"), home, process.platform);
      if (typeof folder === "string") throw new Error(folder);
      const found = await deepestProject(folder, [project("portal", join(link, "portal"))], {
        home,
        platform: process.platform,
      });
      expect(found).toMatchObject({ projects: [{ project: "portal" }], exact: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
