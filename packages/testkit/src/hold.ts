// A file another program holds for a moment, as a virus scanner or a backup does: on Windows an
// open that shares nothing, so every other open fails with a sharing violation; elsewhere a file
// its owner may not read. Root reads every file, so there it cannot be held.
import { chmodSync, closeSync, constants, openSync, readFileSync, statSync } from "node:fs";

/** libuv's UV_FS_O_EXLOCK on Windows: an open that shares nothing (no read, write or delete). */
const EXCLUSIVE = 0x10000000;

/** Whether this process can hold a file from its own reads: not as root outside Windows. */
export const CAN_HOLD_FILES = process.platform === "win32" || process.getuid?.() !== 0;

/** Holds `path` until `release`: every read of it fails meanwhile. */
export function holdFile(path: string): { release(): void } {
  let release: () => void;
  if (process.platform === "win32") {
    const fd = openSync(path, constants.O_RDONLY | EXCLUSIVE);
    release = () => {
      closeSync(fd);
    };
  } else {
    const mode = statSync(path).mode & 0o777;
    chmodSync(path, 0);
    release = () => {
      chmodSync(path, mode);
    };
  }
  try {
    readFileSync(path);
  } catch {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        release();
      },
    };
  }
  release();
  throw new Error("The file could still be read: it cannot be held here");
}
