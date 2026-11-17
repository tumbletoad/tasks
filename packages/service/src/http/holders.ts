// Who holds a TCP port, and who is on the other end of an accepted connection (A2 3.8.2 step 3,
// 3.8.4). Each OS's facts come from a parser over the text the OS gives, so every parser is tested
// on every OS against captured samples, and the service's decisions take the facts as values
// (port.ts), so the other-user cases are tested with injected identities. No account is ever made.
//
// - Linux: `/proc/net/tcp` and `/proc/net/tcp6`. A row records its socket's owner (`uid`) in every
//   state that still has a socket (`inode` not 0: a TIME_WAIT row has none).
// - Windows: `netstat.exe -ano` lists each socket's PID without admin rights, and `tasklist /v`
//   names the account each PID runs as, read from its token. Another account's process counts, and
//   so does one whose account this user cannot read (A2: "a process this user cannot open counts
//   as another user"). Being able to open a process proves nothing: its owner may have opened it
//   to everyone. A2 names `tasks.exe --port-owner`, which reads the same table and token natively:
//   until that launcher mode exists, netstat and tasklist stand in (A2 3.8.2).
//   Both run without blocking the service.
// - macOS: `lsof -nP -iTCP:<port> -F pu`. A non-root lsof may not see another user's socket, so a
//   port whose bind failed and that lsof does not give to one of this user's processes counts as
//   another user's.
import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { system32 } from "../hub/identity.ts";

/** One socket of `/proc/net/tcp` or `/proc/net/tcp6`. */
export interface ProcTcpRow {
  readonly local: string;
  readonly localPort: number;
  readonly remote: string;
  readonly remotePort: number;
  /** The state as the kernel's hex code: 0A is LISTEN, 01 ESTABLISHED, 06 TIME_WAIT. */
  readonly state: string;
  readonly uid: number;
  readonly inode: number;
}

/** An address of `/proc/net/tcp{,6}` as text: 32-bit words in host (little-endian) order. */
export function procAddress(hex: string): string | undefined {
  if (!/^[0-9A-Fa-f]+$/.test(hex)) return undefined;
  const words = hex.match(/.{8}/g) ?? [];
  if (words.length * 8 !== hex.length || (words.length !== 1 && words.length !== 4)) return;
  const bytes = words.flatMap((word) =>
    [6, 4, 2, 0].map((i) => Number.parseInt(word.slice(i, i + 2), 16)),
  );
  if (bytes.length === 4) return bytes.join(".");
  // IPv4 mapped into IPv6 reads as the IPv4 address.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) {
    return bytes.slice(12).join(".");
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  }
  return groups.join(":").replace(/(^|:)0(:0)+(:|$)/, "::");
}

/** Parses `/proc/net/tcp` or `/proc/net/tcp6`. Rows that do not parse are left out. */
export function parseProcNetTcp(text: string): ProcTcpRow[] {
  const rows: ProcTcpRow[] = [];
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const [localHex, localPortHex] = (cols[1] ?? "").split(":");
    const [remoteHex, remotePortHex] = (cols[2] ?? "").split(":");
    const local = procAddress(localHex ?? "");
    const remote = procAddress(remoteHex ?? "");
    const localPort = Number.parseInt(localPortHex ?? "", 16);
    const remotePort = Number.parseInt(remotePortHex ?? "", 16);
    const uid = Number(cols[7]);
    const inode = Number(cols[9]);
    if (
      local === undefined ||
      remote === undefined ||
      !Number.isInteger(localPort) ||
      !Number.isInteger(remotePort) ||
      !Number.isInteger(uid) ||
      !Number.isInteger(inode)
    ) {
      continue;
    }
    rows.push({ local, localPort, remote, remotePort, state: cols[3] ?? "", uid, inode });
  }
  return rows;
}

/** One TCP socket of `netstat -ano`: its local port and owning PID. */
export interface NetstatRow {
  readonly localPort: number;
  readonly pid: number;
}

/**
 * Parses `netstat -ano`. Only TCP rows count. The state column is translated in some display
 * languages, so a row is read by its first, second and last columns only.
 */
export function parseNetstat(text: string): NetstatRow[] {
  const rows: NetstatRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "TCP" || cols.length < 4) continue;
    const local = cols[1] ?? "";
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    const pid = Number(cols.at(-1));
    if (!Number.isInteger(port) || !Number.isInteger(pid) || port <= 0) continue;
    rows.push({ localPort: port, pid });
  }
  return rows;
}

/** One process record of `lsof -F`: its PID, UID and the names of its files (`-F pun`). */
export interface LsofRecord {
  readonly pid: number;
  readonly uid: number | undefined;
  readonly names: readonly string[];
}

/** Parses `lsof -F` output with the fields p, u and n. */
export function parseLsof(text: string): LsofRecord[] {
  const records: { pid: number; uid: number | undefined; names: string[] }[] = [];
  for (const line of text.split("\n")) {
    const field = line[0];
    const value = line.slice(1).trim();
    if (field === "p") {
      const pid = Number(value);
      if (Number.isInteger(pid)) records.push({ pid, uid: undefined, names: [] });
    } else if (field === "u") {
      const current = records.at(-1);
      const uid = Number(value);
      if (current !== undefined && Number.isInteger(uid)) current.uid = uid;
    } else if (field === "n") {
      records.at(-1)?.names.push(value);
    }
  }
  return records;
}

/** Another user on a port: their UID or SID where the OS told, else null. */
export interface ForeignHolder {
  readonly owner: string | null;
}

/** Linux: the sockets on `port` (listeners and connections) owned by another UID. */
export function linuxForeignHolders(rows: readonly ProcTcpRow[], port: number, uid: number) {
  const owners = new Set<string>();
  for (const row of rows) {
    if (row.localPort === port && row.inode !== 0 && row.uid !== uid) owners.add(String(row.uid));
  }
  return [...owners].map((owner): ForeignHolder => ({ owner }));
}

/** How a PID relates to this user: ours, another user's (or one we cannot open), or gone. */
export type PidOwner = "mine" | "other" | "gone";

/**
 * Windows: whether a socket on `port` belongs to a process of another account, or to one whose
 * account this user cannot read. PID 0 owns no socket.
 */
export async function windowsForeignHolders(
  rows: readonly NetstatRow[],
  port: number,
  ownerOf: (pid: number) => PidOwner | Promise<PidOwner>,
): Promise<ForeignHolder[]> {
  const pids = new Set(rows.filter((r) => r.localPort === port && r.pid !== 0).map((r) => r.pid));
  for (const pid of pids) if ((await ownerOf(pid)) === "other") return [{ owner: null }];
  return [];
}

/**
 * The account a process runs as, from `tasklist /v /fo csv /nh /fi "PID eq <pid>"`: its "User
 * Name" column (`DOMAIN\user`, or a placeholder such as `N/A` for a process this user cannot
 * read), or undefined when no row names the PID (the process is gone).
 */
export function parseTasklistOwner(text: string, pid: number): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const fields = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
    if (fields.length >= 7 && fields[1] === String(pid)) return fields[6];
  }
  return undefined;
}

/**
 * macOS: the processes lsof names on `port` that are another user's. When the bind failed and
 * lsof names none of this user's processes, the holder is one lsof cannot see: another user's.
 */
export function macForeignHolders(
  records: readonly LsofRecord[],
  uid: number,
  bindFailed: boolean,
): ForeignHolder[] {
  const owners = new Set<string>();
  let mine = false;
  for (const record of records) {
    if (record.uid === undefined) continue;
    if (record.uid === uid) mine = true;
    else owners.add(String(record.uid));
  }
  if (owners.size > 0) return [...owners].map((owner) => ({ owner }));
  return bindFailed && !mine ? [{ owner: null }] : [];
}

/**
 * How a PID relates to this account, from the account tasklist reads off its token. A process
 * this user can open is not therefore this user's (its owner may have opened it to everyone), so
 * the account names are compared: `me` is whoami's `DOMAIN\user`. A process whose account cannot
 * be read counts as another user's (A2 3.8.2 step 3).
 */
export function windowsPidOwner(text: string, pid: number, me: string): PidOwner {
  const owner = parseTasklistOwner(text, pid);
  if (owner === undefined) return "gone";
  return owner.toLowerCase() === me.toLowerCase() ? "mine" : "other";
}

/** Runs a tool without blocking the service: its output, or undefined when it failed. */
function runAsync(file: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        shell: false,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        resolve(error === null ? stdout : undefined);
      },
    );
  });
}

function run(file: string, args: readonly string[]): string | undefined {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.error === undefined && result.status === 0 ? result.stdout : undefined;
}

/** The OS facts about a port, read the way this OS can. Throws when the OS gave no answer. */
export type HolderCheck = (
  port: number,
  options: { bindFailed: boolean },
) => ForeignHolder[] | Promise<ForeignHolder[]>;

export class HolderCheckFailed extends Error {}

/** The real check of this OS (A2 3.8.2 step 3). */
export function osHolderCheck(platform: NodeJS.Platform = process.platform): HolderCheck {
  if (platform === "linux") {
    return (port) => {
      const uid = process.getuid?.() ?? -1;
      const rows: ProcTcpRow[] = [];
      for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        try {
          rows.push(...parseProcNetTcp(readFileSync(file, "utf8")));
        } catch {
          // A kernel without IPv6 has no tcp6.
        }
      }
      return linuxForeignHolders(rows, port, uid);
    };
  }
  if (platform === "win32") {
    let me: string | undefined;
    return async (port) => {
      const dir = system32();
      if (dir === undefined) throw new HolderCheckFailed("no System32 folder");
      const text = await runAsync(win32.join(dir, "netstat.exe"), ["-ano"]);
      if (text === undefined) throw new HolderCheckFailed("netstat gave no answer");
      return windowsForeignHolders(parseNetstat(text), port, async (pid) => {
        me ??= (await runAsync(win32.join(dir, "whoami.exe"), []))?.trim();
        if (me === undefined || me === "") throw new HolderCheckFailed("whoami gave no answer");
        const list = await runAsync(win32.join(dir, "tasklist.exe"), [
          "/v",
          "/fo",
          "csv",
          "/nh",
          "/fi",
          `PID eq ${String(pid)}`,
        ]);
        if (list === undefined) throw new HolderCheckFailed("tasklist gave no answer");
        return windowsPidOwner(list, pid, me);
      });
    };
  }
  if (platform === "darwin") {
    return (port, { bindFailed }) => {
      const text = run("/usr/sbin/lsof", ["-nP", `-iTCP:${String(port)}`, "-F", "pu"]);
      // lsof exits 1 when it lists nothing.
      return macForeignHolders(parseLsof(text ?? ""), process.getuid?.() ?? -1, bindFailed);
    };
  }
  return () => [];
}

// ---------------------------------------------------------------------------------------------
// The other end of an accepted connection (A2 3.8.4, "the cross-user code leak and its fix")

/**
 * Linux: the UID that owns the client's end of a loopback connection: the row whose local end is
 * the peer's port and whose remote end is ours, both on 127.0.0.1. Undefined when there is none.
 */
export function linuxPeerUid(
  rows: readonly ProcTcpRow[],
  peerPort: number,
  ourPort: number,
): number | undefined {
  const row = rows.find(
    (r) =>
      r.localPort === peerPort &&
      r.remotePort === ourPort &&
      r.local === "127.0.0.1" &&
      r.remote === "127.0.0.1",
  );
  return row?.uid;
}

/**
 * macOS, at `auth/redeem`: whether lsof's records for the peer's port hold exactly the client's own
 * end, `127.0.0.1:<peer>->127.0.0.1:<service>`, in a process that is not the service, owned by
 * this user, and no such record of another user. The service's own accepted socket has the
 * reversed tuple and never matches. A PID alone never counts.
 */
export function macPeerIsMine(
  records: readonly LsofRecord[],
  peerPort: number,
  servicePort: number,
  servicePid: number,
  uid: number,
): boolean {
  const name = `127.0.0.1:${String(peerPort)}->127.0.0.1:${String(servicePort)}`;
  const matching = records.filter((r) => r.pid !== servicePid && r.names.includes(name));
  return matching.length > 0 && matching.every((r) => r.uid === uid);
}

/** Decides for each accepted connection whether its peer is this user (Linux). */
export type PeerCheck = (peerPort: number, ourPort: number) => boolean;

/**
 * Linux: the client's end is looked up in `/proc/net/tcp` and `/proc/net/tcp6` (A2 3.8.4), since
 * a client's IPv6 socket reaches 127.0.0.1 as `::ffff:127.0.0.1` and is listed in tcp6. A table
 * that cannot be read adds no rows; a peer found in neither is refused.
 */
export function linuxPeerCheck(
  uid: number | undefined,
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): PeerCheck {
  return (peerPort, ourPort) => {
    if (uid === undefined) return false;
    const rows: ProcTcpRow[] = [];
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      try {
        rows.push(...parseProcNetTcp(read(file)));
      } catch {
        // A kernel without IPv6 has no tcp6.
      }
    }
    return linuxPeerUid(rows, peerPort, ourPort) === uid;
  };
}

/** The real check: Linux reads /proc; elsewhere every peer passes here (A2 3.8.4). */
export function osPeerCheck(platform: NodeJS.Platform = process.platform): PeerCheck {
  if (platform !== "linux") return () => true;
  return linuxPeerCheck(process.getuid?.());
}

/** Decides at `auth/redeem` whether the redeeming peer is this user (macOS's lsof check). */
export type RedeemCheck = (peerPort: number, ourPort: number) => boolean;

export function osRedeemCheck(platform: NodeJS.Platform = process.platform): RedeemCheck {
  if (platform !== "darwin") return () => true;
  return (peerPort, ourPort) => {
    const text = run("/usr/sbin/lsof", [
      "-nP",
      "-a",
      `-iTCP@127.0.0.1:${String(peerPort)}`,
      "-sTCP:ESTABLISHED",
      "-F",
      "pun",
    ]);
    if (text === undefined) return false;
    return macPeerIsMine(parseLsof(text), peerPort, ourPort, process.pid, process.getuid?.() ?? -1);
  };
}
