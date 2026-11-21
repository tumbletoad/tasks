import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { MEMORY } from "./driver.ts";
import { StorageError } from "./errors.ts";
import { literalPath, sqliteUri, windowsLongPath } from "./sqlite-uri.ts";

const WINDOWS = process.platform === "win32";

/** The StorageError code `fn` throws. */
function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    return (error as StorageError).code;
  }
  throw new Error("expected a StorageError");
}

/** The path SQLite decodes from a URI this module built. */
const decoded = (uri: string): string => {
  expect(uri.startsWith("file:")).toBe(true);
  const query = uri.indexOf("?");
  return decodeURIComponent(uri.slice("file:".length, query));
};

const long = (root: string, sep: string): string => {
  let path = root;
  while (path.length < 300) path += `${sep}a-folder-with-a-long-name`;
  return `${path}${sep}space.db`;
};

describe("[A1.5.driver.contract] the SQLite URI a driver opens a path through", () => {
  test("encodes every byte that is not unreserved, so SQLite decodes the exact path", () => {
    const path = "/home/mira/Mira's space #1 100% é 名前 ?&=+;,[]{}/space ü.db";
    const uri = sqliteUri(path, "rw", "linux");
    expect(uri).toMatch(/^file:%2Fhome%2Fmira%2F[A-Za-z0-9._~%-]+\?mode=rw$/);
    expect(decoded(uri)).toBe(path);
  });

  test("carries the open mode, and nothing else, in the query", () => {
    expect(sqliteUri("/s.db", "ro", "linux")).toBe("file:%2Fs.db?mode=ro");
    expect(sqliteUri("/s.db", "rw", "linux")).toBe("file:%2Fs.db?mode=rw");
    expect(sqliteUri("/s.db", "rwc", "linux")).toBe("file:%2Fs.db?mode=rwc");
  });

  test("keeps Windows drive, UNC, extended and device paths as they are", () => {
    for (const path of [
      "C:\\Users\\mira\\Tasks\\space.db",
      "\\\\server\\share\\Tasks\\space.db",
      "\\\\?\\C:\\Users\\mira\\Tasks\\space.db",
      "\\\\?\\UNC\\server\\share\\Tasks\\space.db",
      "\\\\.\\C:\\Users\\mira\\Tasks\\space.db",
    ]) {
      const uri = sqliteUri(path, "rwc", "win32");
      // No authority, so SQLite never reads a server name as a URI host.
      expect(uri.startsWith("file://")).toBe(false);
      expect(decoded(uri)).toBe(path);
    }
  });

  test("moves a Windows path beyond MAX_PATH into the extended namespace", () => {
    const drive = long("C:\\Users\\mira", "\\");
    expect(windowsLongPath(drive)).toBe(`\\\\?\\${drive}`);
    expect(decoded(sqliteUri(drive, "rw", "win32"))).toBe(`\\\\?\\${drive}`);
    const unc = long("\\\\server\\share", "\\");
    expect(windowsLongPath(unc)).toBe(`\\\\?\\UNC\\${unc.slice(2)}`);
    // The extended form skips Windows' own normalisation, so the path is resolved first.
    const messy = drive.replace("C:\\Users\\mira", "C:/Users/mira/./x/..").replaceAll("\\", "/");
    expect(windowsLongPath(messy)).toBe(`\\\\?\\${drive}`);
    // Short paths and paths already in a device namespace stay as they are.
    expect(windowsLongPath("C:\\Users\\mira\\space.db")).toBe("C:\\Users\\mira\\space.db");
    const extended = `\\\\?\\${drive}`;
    expect(windowsLongPath(extended)).toBe(extended);
    // On other systems the path is never rewritten.
    expect(decoded(sqliteUri(long("/home/mira", "/"), "rw", "linux"))).toBe(
      long("/home/mira", "/"),
    );
  });
});

describe("[A1.5.writer.file-names] the one literal path every file name reaches SQLite as", () => {
  test("is the path resolved against the working folder: a URI, file:, ? and # are characters of a path", () => {
    const folder = resolve("ttasks-literal-path-probe");
    const uri = pathToFileURL(join(folder, "uri.db")).href;
    const spellings = [
      join(folder, "native.db"),
      join(folder, ".", "x", "..", "dots.db"),
      relative(process.cwd(), join(folder, "relative.db")),
      `file:${sep}..${sep}${relative(process.cwd(), join(folder, "a%41b", "prefixed.db"))}`,
      "file:relative.db",
      uri,
      `${uri}?mode=rwc`,
      `${uri}?cache=shared`,
      join(folder, "h#x%3Fy", "marks.db"),
      ...(WINDOWS ? [] : [join(folder, "q?x#y", "marks.db")]),
    ];
    for (const spelling of spellings) {
      if (WINDOWS && resolve(spelling).slice(2).includes(":")) {
        // A colon after the drive names a stream on Windows: refused.
        expect(
          thrown(() => literalPath(spelling)),
          spelling,
        ).toBe("STORAGE_MISUSE");
        continue;
      }
      const literal = literalPath(spelling);
      expect(literal, spelling).toBe(resolve(spelling));
      // The URI carries that path and the open mode, and nothing of the spelling's own query.
      const opened = sqliteUri(spelling, "ro");
      expect(opened.endsWith("?mode=ro"), spelling).toBe(true);
      expect(opened.slice(0, -"?mode=ro".length)).not.toMatch(/[?#]/);
      expect(decoded(opened), spelling).toBe(WINDOWS ? windowsLongPath(literal) : literal);
      // It is its own literal path, so the claim and SQLite name the same file.
      expect(literalPath(literal)).toBe(literal);
    }
    expect(literalPath(`file:${sep}..${sep}x.db`)).toBe(resolve("x.db"));
  });

  test("keeps every Linux and macOS name as it is", () => {
    for (const path of [
      "/home/mira/space.db.",
      "/home/mira/space.db ",
      "/home/mira/nul",
      "/home/mira/a:b/q?x#y/space.db",
      "/home/mira/file:/space.db",
    ]) {
      expect(literalPath(path, "linux")).toBe(path);
    }
    expect(literalPath("/home/mira/./x/../space.db", "linux")).toBe("/home/mira/space.db");
  });

  test("refuses on Windows a part Windows would not keep as written", () => {
    for (const [path, expected] of [
      ["C:\\Tasks\\space.db", "C:\\Tasks\\space.db"],
      ["C:/Tasks/./x/../space.db", "C:\\Tasks\\space.db"],
      ["\\\\server\\share\\Tasks\\space.db", "\\\\server\\share\\Tasks\\space.db"],
      ["\\\\?\\C:\\Tasks\\space.db", "\\\\?\\C:\\Tasks\\space.db"],
      ["\\\\?\\UNC\\server\\share\\space.db", "\\\\?\\UNC\\server\\share\\space.db"],
      ["\\\\.\\C:\\Tasks\\space.db", "\\\\.\\C:\\Tasks\\space.db"],
    ] as const) {
      expect(literalPath(path, "win32")).toBe(expected);
    }
    for (const path of [
      // Windows drops a trailing dot or space, so these name another file.
      "C:\\Tasks\\space.db.",
      "C:\\Tasks\\space.db ",
      "C:\\Tasks.\\space.db",
      "\\\\server\\share.\\space.db",
      // A device name opens the device.
      "C:\\Tasks\\nul",
      "C:\\Tasks\\com1.db",
      "C:\\Tasks\\LPT¹",
      // A colon names a stream, ? and * are wildcards, and the rest Windows does not allow.
      "C:\\Tasks\\space.db:stream",
      "C:\\Tasks\\file:\\space.db",
      "C:\\Tasks\\file:\\C:\\Tasks\\space.db",
      "C:\\Tasks\\a?b\\space.db",
      "C:\\Tasks\\a*b.db",
      "C:\\Tasks\\a<b>.db",
      'C:\\Tasks\\a"b.db',
      "C:\\Tasks\\a|b.db",
      "C:\\Tasks\\a\u0001b.db",
    ]) {
      expect(
        thrown(() => literalPath(path, "win32")),
        path,
      ).toBe("STORAGE_MISUSE");
    }
  });

  test("passes MEMORY, which names no file, and refuses what is not a path", () => {
    expect(literalPath(MEMORY)).toBe(MEMORY);
    for (const path of ["", "space\0.db", 42 as unknown as string]) {
      expect(thrown(() => literalPath(path))).toBe("STORAGE_MISUSE");
    }
  });
});
