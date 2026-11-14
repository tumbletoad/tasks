// The space path rules (A1 3.1): an absolute path whose folder name is
// a portable slug, and on Windows no component Windows would silently change or refuse.
import { describe, expect, test } from "vitest";
import { StorageError } from "./errors.ts";
import { checkSpacePath, isSpaceSlug, isWindowsDeviceName, slugFromName } from "./space-path.ts";

function refused(path: unknown, platform: NodeJS.Platform): string {
  try {
    checkSpacePath(path, platform);
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe("SPACE_PATH_INVALID");
    if (typeof path === "string" && path.length > 3) {
      expect((error as StorageError).message).not.toContain(path);
    }
    return (error as StorageError).message;
  }
  throw new Error(`${String(path)} was accepted on ${platform}`);
}

describe("[A1.5.space.path-rules] space folder paths", () => {
  test("a slug: a-z, 0-9 and inner hyphens, at most 64, never a device name", () => {
    for (const ok of ["mira", "work", "lumen-portal", "a", "2026", "x".repeat(64), "con-space"]) {
      expect(isSpaceSlug(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "Mira",
      "mira.",
      "mira ",
      "-mira",
      "mira-",
      "mi ra",
      "mira_1",
      "x".repeat(65),
      "con",
      "NUL",
      "com1",
      "lpt9",
      "aux",
      "prn",
      "ålborg",
      42,
    ]) {
      expect(isSpaceSlug(bad), String(bad)).toBe(false);
    }
  });

  test("device names: Microsoft's list, by the part before the first dot", () => {
    for (const device of [
      "con",
      "PRN",
      "Aux",
      "nul",
      "com1",
      "COM9",
      "lpt1",
      "lpt9",
      "com¹",
      "COM²",
      "lpt³",
      "nul.txt",
      "NUL.tar.gz",
      "nul.one.two", // the reviewer's case: the stem is before the FIRST dot
      "con .txt", // trailing spaces of the stem are ignored
      "aux  .x.y",
      "lpt¹.log",
    ]) {
      expect(isWindowsDeviceName(device), device).toBe(true);
    }
    for (const name of [
      "com0", // not on Microsoft's list: the reviewer's case
      "lpt0",
      "com10",
      "conin$", // console names only as a whole path, not as a folder
      "conout$",
      "console",
      "nul-space",
      "con-space",
      "xnul",
      " con",
      ".con",
      "com",
      "com⁴",
    ]) {
      expect(isWindowsDeviceName(name), name).toBe(false);
    }
    expect(isSpaceSlug("com0")).toBe(true);
    expect(isSpaceSlug("lpt0")).toBe(true);
  });

  test("a slug from a space name", () => {
    expect(slugFromName("Mira")).toBe("mira");
    expect(slugFromName("Ålborg Kontor")).toBe("alborg-kontor");
    expect(slugFromName("  Work / Home!  ")).toBe("work-home");
    expect(slugFromName("???")).toBe("space");
    expect(slugFromName("CON")).toBe("con-space");
    expect(slugFromName("x".repeat(100))).toBe("x".repeat(64));
    for (const name of ["Mira", "Ålborg Kontor", "???", "CON", "a-", "-".repeat(70) + "b"]) {
      expect(isSpaceSlug(slugFromName(name)), name).toBe(true);
    }
  });

  test("Linux and macOS: absolute, resolved, the last component a slug", () => {
    expect(checkSpacePath("/home/mira/Tasks/mira", "linux")).toBe("/home/mira/Tasks/mira");
    expect(checkSpacePath("/home/mira/x/../Tasks/mira/", "linux")).toBe("/home/mira/Tasks/mira");
    // The parent is machine-local: a trailing dot is a real name there.
    expect(checkSpacePath("/home/mira/odd./mira", "darwin")).toBe("/home/mira/odd./mira");
    refused("Tasks/mira", "linux");
    refused("/home/mira/Tasks/Mira", "linux");
    refused("/home/mira/Tasks/mira.", "linux");
    refused("/home/mira/Tasks/mi\0ra", "linux");
    refused("", "linux");
    refused(undefined, "linux");
  });

  test("Windows: a drive or share, and no component Windows would change or refuse", () => {
    expect(checkSpacePath("C:\\Users\\Mira\\Tasks\\mira", "win32")).toBe(
      "C:\\Users\\Mira\\Tasks\\mira",
    );
    expect(checkSpacePath("C:/Users/Mira/Tasks/mira", "win32")).toBe(
      "C:\\Users\\Mira\\Tasks\\mira",
    );
    expect(checkSpacePath("\\\\server\\share\\Tasks\\mira", "win32")).toBe(
      "\\\\server\\share\\Tasks\\mira",
    );
    expect(checkSpacePath("C:\\Users\\Mira Okafor\\Tasks\\mira", "win32")).toBe(
      "C:\\Users\\Mira Okafor\\Tasks\\mira",
    );
    expect(checkSpacePath("C:\\folder\\com0\\mira", "win32")).toBe("C:\\folder\\com0\\mira");
    expect(checkSpacePath("\\\\server\\share\\mira", "win32")).toBe("\\\\server\\share\\mira");
    for (const bad of [
      "C:\\Users\\Mira\\Tasks\\mira.", // the slug rule
      "C:\\Users\\Mira.\\Tasks\\mira", // Windows drops the trailing dot: another folder
      "C:\\Users\\Mira \\Tasks\\mira", // and a trailing space
      "C:\\Users\\...\\mira",
      "C:\\con\\mira", // a device name
      "C:\\Users\\nul.txt\\mira",
      "C:\\folder\\nul.one.two\\mira", // the reviewer's cases
      "C:\\folder\\con .txt\\mira",
      "C:\\folder\\com¹\\mira",
      "\\\\server.\\share\\mira", // a UNC server and share are components too
      "\\\\server\\share \\mira",
      "\\\\server.\\share \\mira",
      "\\\\con\\share\\mira",
      "\\\\server\\nul.x\\mira",
      "\\\\server\\mira", // no share: the folder name is empty
      "C:\\Users\\a<b\\mira", // reserved characters
      "C:\\Users\\a|b\\mira",
      "C:\\Users\\a:stream\\mira",
      "C:\\Users\\a*\\mira",
      "\\\\?\\C:\\Users\\Mira\\mira", // device namespaces
      "\\\\.\\C:\\Users\\Mira\\mira",
      "//?/C:/Users/Mira/mira",
      "C:mira", // drive-relative
      "\\Tasks\\mira", // root-relative
      "Tasks\\mira",
    ]) {
      refused(bad, "win32");
    }
    expect(refused("C:\\Users\\Mira.\\Tasks\\mira", "win32")).toContain("dot or a space");
  });

  test.runIf(process.platform === "win32")("the current platform is the default", () => {
    refused("C:\\Users\\Mira.\\Tasks\\mira", process.platform);
    expect(() => checkSpacePath("C:\\Users\\Mira.\\Tasks\\mira")).toThrow(StorageError);
  });

  test.runIf(process.platform !== "win32")("the current platform is the default", () => {
    expect(checkSpacePath("/tmp/odd./mira")).toBe("/tmp/odd./mira");
  });
});
