// Archives no build writes, for the updater's entry checks: a name that leaves the folder, an
// absolute name, a name with a space, a link. The tar is written header by header; the zip is the
// build's writer with a stand-in name of the same length, patched afterwards. Tests only.
import { basename } from "node:path";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { KeyObject } from "node:crypto";
import { writeZip } from "../../scripts/build/archive.ts";
import { signSums, writeSums } from "../../scripts/build/signing.ts";
import type { FixtureRelease } from "./fixture.ts";

export interface Crafted {
  readonly path: string;
  readonly data?: Buffer;
  /** A symbolic link to this target. */
  readonly link?: string;
}

function tarHeader(name: string, type: "0" | "2", size: number, link = ""): Buffer {
  const h = Buffer.alloc(512);
  const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;
  h.write(name, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(1_767_225_600, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write(link, 157, 100, "utf8");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

/** A stand-in the writer accepts, of the same length as `path`. */
const standIn = (path: string): string =>
  path
    .replace(/[^A-Za-z0-9._/-]/g, "x")
    .replace(/^\//, "x")
    .replace(/(^|\/)\.\.(?=\/|$)/g, "$1xx");

/** The archive of `os` with exactly these entries, in this order, unchecked. */
export function craft(os: NodeJS.Platform, entries: readonly Crafted[]): Buffer {
  if (os !== "win32") {
    const chunks: Buffer[] = [];
    for (const e of entries) {
      if (e.link !== undefined) {
        chunks.push(tarHeader(e.path, "2", 0, e.link));
        continue;
      }
      const data = e.data ?? Buffer.alloc(0);
      chunks.push(tarHeader(e.path, "0", data.length), data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad > 0) chunks.push(Buffer.alloc(pad));
    }
    chunks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(chunks), { level: 1 });
  }
  const zip = writeZip(
    entries.map((e) => ({
      path: standIn(e.path),
      data: e.link === undefined ? (e.data ?? Buffer.alloc(0)) : Buffer.from(e.link),
      mode: 0o644,
    })),
    { level: 0 },
  );
  for (const e of entries) {
    const from = Buffer.from(standIn(e.path));
    const to = Buffer.from(e.path);
    if (from.equals(to)) continue;
    for (let at = zip.indexOf(from); at !== -1; at = zip.indexOf(from, at + 1)) to.copy(zip, at);
  }
  // A link: the Unix mode of a symbolic link in the central directory's external attributes.
  for (const e of entries) {
    if (e.link === undefined) continue;
    for (let at = zip.indexOf("PK\x01\x02"); at !== -1; at = zip.indexOf("PK\x01\x02", at + 4)) {
      const length = zip.readUInt16LE(at + 28);
      if (zip.subarray(at + 46, at + 46 + length).toString() === e.path) {
        zip.writeUInt8(3, at + 5);
        zip.writeUInt32LE((0o120777 << 16) >>> 0, at + 38);
      }
    }
  }
  return zip;
}

/** Writes `archive` as the release's archive and signs SHA256SUMS over it again with `key`. */
export function resign(release: FixtureRelease, archive: Buffer, key: KeyObject): void {
  writeFileSync(release.archive, archive);
  writeSums(release.dist, [basename(release.archive)]);
  signSums(release.dist, key, `${release.dist}.signing`);
}
