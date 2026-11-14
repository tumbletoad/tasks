// `<state>/ipc.key` (A2 3.2.3): 32 random bytes as base64url, the shared secret of the local
// handshake (A2 3.6.3) and the HTTP probe. Mode 0600, written atomically.
//
// Clients read the key for every connection, so a new key needs no other step. That makes
// replacing a bad key safe: the service writes a new one when the file is missing, does not hold
// exactly 32 bytes in canonical base64url, or (on Linux and macOS) is not a regular file of this
// user that only this user can read, because another user may then have read it.
//
// The key is read the way every client reads it: tasks-local/1's parseKey (M1.09), so the service
// and its clients agree on which texts are a key.
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_BYTES, parseKey } from "@tasks/bridge/protocol";
import { atomicWrite } from "./files.ts";

export { KEY_BYTES };
export const KEY_FILE = "ipc.key";

/** The 32 bytes a key file's text encodes, or undefined when it is not exactly that. */
export function decodeKey(text: string): Buffer | undefined {
  try {
    return parseKey(text);
  } catch {
    return undefined;
  }
}

export type KeyReplaced = "missing" | "invalid" | "not_private";

/** Reads the key, or writes a new one. Returns the bytes and why a new one was written. */
export function loadOrCreateKey(
  state: string,
  platform: NodeJS.Platform = process.platform,
): { key: Buffer; replaced: KeyReplaced | undefined } {
  const path = join(state, KEY_FILE);
  let replaced: KeyReplaced;
  try {
    const stat = lstatSync(path);
    const uid = process.getuid?.();
    const privateFile =
      stat.isFile() &&
      (platform === "win32" ||
        uid === undefined ||
        (stat.uid === uid && (stat.mode & 0o077) === 0));
    if (privateFile) {
      const key = decodeKey(readFileSync(path, "utf8"));
      if (key !== undefined) return { key, replaced: undefined };
      replaced = "invalid";
    } else {
      replaced = "not_private";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    replaced = "missing";
  }
  const key = randomBytes(KEY_BYTES);
  atomicWrite(path, key.toString("base64url"));
  return { key, replaced };
}
