// This machine's identity, `<state>/machine.json` (A6 3.4, A2 3.2.3). A space's writer needs it:
// the writer registers the machine on a space's first open and writes only where this machine is
// the space's authority (A1 3.6).
//
// M1.08 keeps the minimum the writer needs: `machine_id` (A1's ID scheme, never derived from the
// host name), the display name and the creation time. The host fingerprint, the machine keys and
// the copy detection that compares them arrive with A6's steps, which add their fields to this
// file. A file that exists is never rewritten here, so their fields survive.
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { PRODUCT_ID } from "@ttasks/brand";
import { isId, newId, type Id, type MachineInfo, type MachineOs } from "@ttasks/storage";
import { atomicWrite } from "./files.ts";

export const MACHINE_FILE = "machine.json";
const NAME_MAX = 100;
const FILE_MAX_BYTES = 64 * 1024;

/** The machine's invalid file, which the service refuses to replace (exit 64). */
export class MachineFileInvalid extends Error {
  override readonly name = "MachineFileInvalid";
  constructor() {
    super("machine.json is not a valid machine record");
  }
}

export const machineOs = (platform: NodeJS.Platform): MachineOs =>
  platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";

/** A display name from the host name: one line of at most 100 characters. */
export function displayName(host: string): string {
  // eslint-disable-next-line no-control-regex -- the C0 controls and DEL are what is removed
  const controls = /[\u0000-\u001f\u007f]+/g;
  const line = host.replace(controls, " ").trim().slice(0, NAME_MAX);
  return line === "" ? PRODUCT_ID : line;
}

/**
 * Reads this machine's identity, or creates it on the first start. Throws MachineFileInvalid for a
 * file that exists but holds no valid record: replacing it would give the machine a new ID and
 * turn the spaces it owns into read-only copies, so the person decides (doctor reports it).
 */
export function loadOrCreateMachine(
  state: string,
  platform: NodeJS.Platform,
  now: () => Date = () => new Date(),
): { machine: MachineInfo; created: boolean } {
  const path = join(state, MACHINE_FILE);
  let text: string | undefined;
  try {
    const bytes = readFileSync(path);
    if (bytes.length > FILE_MAX_BYTES) throw new MachineFileInvalid();
    text = bytes.toString("utf8");
  } catch (error) {
    if (error instanceof MachineFileInvalid) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const os = machineOs(platform);
  if (text !== undefined) {
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      throw new MachineFileInvalid();
    }
    const { machine_id: id, name } = (record ?? {}) as Record<string, unknown>;
    if (!isId(id, "m") || typeof name !== "string" || displayName(name) !== name) {
      throw new MachineFileInvalid();
    }
    return { machine: { id, name, os }, created: false };
  }
  const id: Id<"m"> = newId("m");
  const name = displayName(hostname());
  const record = { machine_id: id, name, created_at: now().toISOString() };
  atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
  return { machine: { id, name, os }, created: true };
}
