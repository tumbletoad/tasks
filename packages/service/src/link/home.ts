// `<state>/link.json`: what this computer is to its paired phones. Its key and certificate, whose
// pin every phone holds, and the port it listens on, which every phone's addresses name. Mode 0600,
// written atomically. A file that is missing or does not read is made again; every phone then has
// to be paired again, because none can trust another key.
import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "@ttasks/files";
import { makeIdentity, pinOf, type LinkIdentity } from "./cert.ts";

export const LINK_FILE = "link.json";

export interface LinkHome extends LinkIdentity {
  /** The pin of the computer's key: what a phone checks before it sends anything. */
  readonly pin: string;
  /** The port kept from the first listen, if there was one. */
  readonly port: number | undefined;
}

function read(path: string): LinkHome | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { key, cert, port } = parsed as Record<string, unknown>;
  if (typeof key !== "string" || typeof cert !== "string") return undefined;
  try {
    const x509 = new X509Certificate(cert);
    if (!x509.checkPrivateKey(createPrivateKey(key))) return undefined;
    return {
      key,
      cert,
      pin: pinOf(x509.publicKey),
      port: Number.isInteger(port) && (port as number) > 0 ? (port as number) : undefined,
    };
  } catch {
    return undefined;
  }
}

function write(path: string, home: LinkIdentity & { port?: number | undefined }): void {
  atomicWrite(
    path,
    JSON.stringify({
      key: home.key,
      cert: home.cert,
      ...(home.port === undefined ? {} : { port: home.port }),
    }),
  );
}

/** The computer's link identity, made on first use. */
export function loadOrCreateHome(state: string): LinkHome {
  const path = join(state, LINK_FILE);
  const found = read(path);
  if (found !== undefined) return found;
  const identity = makeIdentity();
  write(path, identity);
  const made = read(path);
  if (made === undefined) throw new Error("The link file could not be read back");
  return made;
}

/** Keeps the port the listener got, so the addresses phones hold stay true. */
export function keepPort(state: string, home: LinkHome, port: number): LinkHome {
  if (home.port === port) return home;
  write(join(state, LINK_FILE), { ...home, port });
  return { ...home, port };
}
