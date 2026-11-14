// Atomic writes and bounded reads in the space folder (A1 3.1): every byte through short writes,
// no temporary file left behind by a failure, the first error kept, and no path in any error.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { StorageError } from "../src/errors.ts";
import { NODE_IO, readBounded, writeFileAtomic, type FileIo } from "../src/files.ts";
import { tempFolders } from "./space-helpers.ts";

const folders = tempFolders("files");

afterEach(() => {
  folders.cleanup();
});

/** A native-looking error whose message holds a path, as Node's file system errors do. */
function nativeError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: simulated failure, open '${path}'`), { code });
}

function storageError(fn: () => unknown): StorageError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    return error as StorageError;
  }
  throw new Error("nothing was thrown");
}

const temporaries = (folder: string): string[] =>
  readdirSync(folder).filter((f) => f.includes(".tmp-"));

/** The text has multi-byte characters, so a short write can split one. */
const TEXT = `{"name": "Ålborg ✓ 日本"}\n`.repeat(40);

describe("[A1.5.space.atomic-write] atomic writes and bounded reads", () => {
  test("a short write is continued until every byte is written", () => {
    const folder = folders.make();
    writeFileSync(join(folder, "space.json"), "old");
    let calls = 0;
    const io: FileIo = {
      ...NODE_IO,
      // At most 7 bytes per call, as a write to a pipe, a full disk or a signal can do.
      writeSync: (fd, buffer, offset, length) => {
        calls += 1;
        return NODE_IO.writeSync(fd, buffer, offset, Math.min(length, 7));
      },
    };
    writeFileAtomic(folder, "space.json", TEXT, io);
    expect(readFileSync(join(folder, "space.json"), "utf8")).toBe(TEXT);
    expect(calls).toBe(Math.ceil(Buffer.byteLength(TEXT) / 7));
    expect(temporaries(folder)).toEqual([]);
  });

  test("a write that makes no progress fails instead of looping, and leaves the old file", () => {
    const folder = folders.make();
    writeFileSync(join(folder, "space.json"), "old");
    const error = storageError(() => {
      writeFileAtomic(folder, "space.json", TEXT, { ...NODE_IO, writeSync: () => 0 });
    });
    expect(error.code).toBe("DURABILITY_FAILED");
    expect(readFileSync(join(folder, "space.json"), "utf8")).toBe("old");
    expect(temporaries(folder)).toEqual([]);
  });

  test("a failed write, fsync or rename removes the temporary file and names no path", () => {
    const folder = folders.make();
    writeFileSync(join(folder, "space.json"), "old");
    const failing: [string, FileIo][] = [
      [
        "write",
        {
          ...NODE_IO,
          writeSync: () => {
            throw nativeError("EIO", folder);
          },
        },
      ],
      [
        "fsync",
        {
          ...NODE_IO,
          fsyncSync: () => {
            throw nativeError("ENOSPC", folder);
          },
        },
      ],
      [
        "rename",
        {
          ...NODE_IO,
          renameSync: () => {
            throw nativeError("EACCES", folder);
          },
        },
      ],
    ];
    for (const [step, io] of failing) {
      const error = storageError(() => {
        writeFileAtomic(folder, "space.json", TEXT, io);
      });
      expect(error.code, step).toBe(step === "rename" ? "STORAGE_CANT_OPEN" : "DURABILITY_FAILED");
      expect(error.message, step).not.toContain(folder);
      expect(error.message, step).not.toContain("simulated");
      expect(JSON.stringify(error), step).not.toContain(folder);
      expect(readFileSync(join(folder, "space.json"), "utf8"), step).toBe("old");
      expect(temporaries(folder), step).toEqual([]);
    }
  });

  test("a cleanup that fails never replaces the first error", () => {
    const folder = folders.make();
    const io: FileIo = {
      ...NODE_IO,
      writeSync: () => {
        throw nativeError("EIO", folder);
      },
      rmSync: (path) => {
        throw nativeError("EPERM", path);
      },
      closeSync: (fd) => {
        NODE_IO.closeSync(fd);
        throw nativeError("EBADF", folder);
      },
    };
    const error = storageError(() => {
      writeFileAtomic(folder, "space.json", TEXT, io);
    });
    expect(error.code).toBe("DURABILITY_FAILED");
    expect(error.message).toBe("File system error (EIO)");
    // The removal failed, so the temporary file stays, under the name M1.10's cleanup looks for.
    expect(temporaries(folder)).toHaveLength(1);
    expect(temporaries(folder)[0]).toMatch(/^\.space\.json\.tmp-[0-9a-f]{16}$/);
  });

  test("a bounded read reads at most its limit and one byte more", () => {
    const folder = folders.make();
    const path = join(folder, "f");
    expect(readBounded(path, 10)).toEqual({ state: "missing" });
    writeFileSync(path, "0123456789");
    const ok = readBounded(path, 10);
    expect(ok.state === "ok" && Buffer.from(ok.bytes).toString()).toBe("0123456789");
    writeFileSync(path, "x".repeat(1_000_000));
    let read = 0;
    const counting: FileIo = {
      ...NODE_IO,
      // Short reads too: at most 3 bytes per call.
      readSync: (fd, buffer, offset, length, position) => {
        const n = NODE_IO.readSync(fd, buffer, offset, Math.min(length, 3), position);
        read += n;
        return n;
      },
    };
    expect(readBounded(path, 10, counting)).toEqual({ state: "too_large" });
    expect(read).toBe(11);
    const error = storageError(() =>
      readBounded(path, 10, {
        ...NODE_IO,
        readSync: () => {
          throw nativeError("EIO", folder);
        },
      }),
    );
    expect(error.message).not.toContain(folder);
  });
});
