// A2 5: "/proc/net/tcp parser against captured samples (IPv4, IPv6, many rows, missing entry).
// Foreign-holder detection from captured samples for all three OSes, including a port in use whose
// owner lsof cannot see. macOS lsof -F parser ... the service's own accepted socket ... must never
// match." Samples have the OS's exact layout; the identities in them are injected, never real.
import { createServer } from "node:net";
import { describe, expect, test } from "vitest";
import {
  linuxForeignHolders,
  linuxPeerCheck,
  linuxPeerUid,
  macForeignHolders,
  macPeerIsMine,
  parseLsof,
  parseNetstat,
  parseProcNetTcp,
  osHolderCheck,
  parseTasklistOwner,
  procAddress,
  windowsForeignHolders,
  windowsPidOwner,
  type PidOwner,
} from "./holders.ts";

// Port 7713 is 1E21, 7714 is 1E22, 50000 is C350.
const PROC_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1E21 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41001 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1E21 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 41002 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:C350 0100007F:1E21 01 00000000:00000000 00:00000000 00000000  1001        0 41003 1 0000000000000000 20 4 30 10 -1
   3: 0100007F:1E22 0100007F:C351 06 00000000:00000000 03:00001234 00000000     0        0 0 3 0000000000000000
   4: 0100007F:1E22 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41004 1 0000000000000000 100 0 0 10 0
   5: 0A00020F:0016 0A000201:D431 01 00000000:00000000 02:0002A0B1 00000000     0        0 9123 2 0000000000000000 20 4 31 10 -1
   garbage line
`;
const PROC_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1E21 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 52001 1 0000000000000000 100 0 0 10 0
   1: 0000000000000000FFFF00000100007F:1E23 0000000000000000FFFF00000100007F:D000 01 00000000:00000000 00:00000000 00000000  1000        0 52002 1 0000000000000000 20 4 30 10 -1
`;

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1148
  TCP    127.0.0.1:7713         0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:7713         127.0.0.1:50000        ESTABLISHED     4242
  TCP    127.0.0.1:50000        127.0.0.1:7713         ESTABLISHED     5151
  TCP    127.0.0.1:7714         127.0.0.1:50001        TIME_WAIT       0
  TCP    [::1]:7715             [::]:0                 ABHÖREN         6262
  UDP    0.0.0.0:7716           *:*                                    999
`;

describe("[A2.3.8.http.holders] who holds a port, and who is on the other end", () => {
  test("/proc/net/tcp and tcp6: addresses, ports, states, owners; bad rows are skipped", () => {
    const rows = parseProcNetTcp(PROC_TCP);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      local: "127.0.0.1",
      localPort: 7713,
      remote: "0.0.0.0",
      remotePort: 0,
      state: "0A",
      uid: 1000,
      inode: 41001,
    });
    expect(rows[5]?.local).toBe("15.2.0.10");
    const six = parseProcNetTcp(PROC_TCP6);
    expect(six.map((r) => [r.local, r.localPort, r.uid])).toEqual([
      ["::1", 7713, 1002],
      ["127.0.0.1", 7715, 1000],
    ]);
    expect(procAddress("0100007F")).toBe("127.0.0.1");
    expect(procAddress("zz")).toBeUndefined();
    expect(procAddress("0100007F01")).toBeUndefined();
    // Many rows: the parser is linear and keeps them all.
    const many = [PROC_TCP.split("\n")[0]];
    for (let i = 0; i < 5000; i++) {
      const port = (20000 + i).toString(16).toUpperCase();
      many.push(
        `${String(i)}: 0100007F:${port} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 ${String(i + 1)} 1`,
      );
    }
    expect(parseProcNetTcp(many.join("\n"))).toHaveLength(5000);
  });

  test("Linux: another UID's listener or connection on the port counts; TIME_WAIT and ours do not", () => {
    const rows = [...parseProcNetTcp(PROC_TCP), ...parseProcNetTcp(PROC_TCP6)];
    // 7713: our listener (1000), our accepted socket, and another user's IPv6 listener (1002).
    expect(linuxForeignHolders(rows, 7713, 1000)).toEqual([{ owner: "1002" }]);
    // 7714: a TIME_WAIT row (uid 0, inode 0) and our listener: nobody else.
    expect(linuxForeignHolders(rows, 7714, 1000)).toEqual([]);
    // Seen as another user, the same rows name 1000.
    expect(linuxForeignHolders(rows, 7714, 2000)).toEqual([{ owner: "1000" }]);
    expect(linuxForeignHolders(rows, 7799, 1000)).toEqual([]);
  });

  test("Linux peer check: the client's own end, by its tuple; a missing entry is no peer", () => {
    const rows = parseProcNetTcp(PROC_TCP);
    // The client's end of 50000 -> 7713 is owned by 1001.
    expect(linuxPeerUid(rows, 50000, 7713)).toBe(1001);
    // The service's own accepted socket (7713 -> 50000) is never taken for the client's.
    expect(linuxPeerUid(rows, 7713, 50000)).toBe(1000);
    expect(linuxPeerUid(rows, 50001, 7713)).toBeUndefined();
    expect(linuxPeerUid([], 50000, 7713)).toBeUndefined();
  });

  test("Linux peer check: a client whose IPv6 socket reaches 127.0.0.1 is found in tcp6", () => {
    // The client's end 50002 -> 7713 as an IPv4-mapped IPv6 socket, owned by 1000.
    const mapped = `${PROC_TCP6.trimEnd()}
   2: 0000000000000000FFFF00000100007F:C352 0000000000000000FFFF00000100007F:1E21 01 00000000:00000000 00:00000000 00000000  1000        0 52003 1 0000000000000000 20 4 30 10 -1
`;
    const read = (file: string) => (file.endsWith("tcp6") ? mapped : PROC_TCP);
    expect(linuxPeerCheck(1000, read)(50002, 7713)).toBe(true);
    // Another user's IPv4 client, and a peer in neither table: refused.
    expect(linuxPeerCheck(1000, read)(50000, 7713)).toBe(false);
    expect(linuxPeerCheck(1000, read)(50009, 7713)).toBe(false);
    // Without tcp6 (no IPv6 in the kernel) the IPv4 table still decides.
    const noSix = (file: string) => {
      if (file.endsWith("tcp6")) throw new Error("ENOENT");
      return PROC_TCP;
    };
    expect(linuxPeerCheck(1001, noSix)(50000, 7713)).toBe(true);
    expect(linuxPeerCheck(undefined, read)(50002, 7713)).toBe(false);
  });

  test("Windows netstat: TCP rows by local port and PID, in any display language", async () => {
    const rows = parseNetstat(NETSTAT);
    expect(rows).toEqual([
      { localPort: 135, pid: 1148 },
      { localPort: 7713, pid: 4242 },
      { localPort: 7713, pid: 4242 },
      { localPort: 50000, pid: 5151 },
      { localPort: 7714, pid: 0 },
      { localPort: 7715, pid: 6262 },
    ]);
    const owners: Record<number, PidOwner> = { 4242: "other", 6262: "mine", 5151: "mine" };
    const ownerOf = (pid: number): PidOwner => owners[pid] ?? "gone";
    expect(await windowsForeignHolders(rows, 7713, ownerOf)).toEqual([{ owner: null }]);
    // A TIME_WAIT row has PID 0 and no owner.
    expect(await windowsForeignHolders(rows, 7714, ownerOf)).toEqual([]);
    expect(await windowsForeignHolders(rows, 7715, ownerOf)).toEqual([]);
    // A process that is gone holds nothing.
    expect(await windowsForeignHolders(rows, 135, ownerOf)).toEqual([]);
  });

  test("Windows owner: the account tasklist reads off the process's token, never whether it opens", () => {
    const row = (pid: number, user: string) =>
      `"node.exe","${String(pid)}","Console","1","92,892 K","Running","${user}","0:00:01","N/A"`;
    const me = "desktop-test\\fixture";
    // This account's process, whatever the case of its name.
    expect(windowsPidOwner(row(4242, "DESKTOP-TEST\\Fixture"), 4242, me)).toBe("mine");
    // Another account's process, even one this user could open: another user's.
    expect(windowsPidOwner(row(4242, "DESKTOP-TEST\\other"), 4242, me)).toBe("other");
    // A process whose account cannot be read (any language's placeholder): another user's.
    expect(windowsPidOwner(row(4242, "N/A"), 4242, me)).toBe("other");
    expect(windowsPidOwner(row(4242, "Nicht zutreffend"), 4242, me)).toBe("other");
    // No row for the PID (tasklist's message is in the display language): gone.
    const none = "INFO: No tasks are running which match the specified criteria.\r\n";
    expect(windowsPidOwner(none, 4242, me)).toBe("gone");
    expect(windowsPidOwner(row(4243, "DESKTOP-TEST\\fixture"), 4242, me)).toBe("gone");
    expect(parseTasklistOwner(`${row(1, "A\\b")}\r\n${row(2, "C\\d")}\r\n`, 2)).toBe("C\\d");
  });

  test.runIf(process.platform === "win32")(
    "Windows, for real: this process's own listener is ours; a service account's listener is not",
    { timeout: 60_000 },
    async () => {
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        const check = osHolderCheck("win32");
        expect(await check(port, { bindFailed: true })).toEqual([]);
        // RPC's endpoint mapper listens on 135 on every Windows, as a service account.
        expect(await check(135, { bindFailed: true })).toEqual([{ owner: null }]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );

  test("macOS lsof: another UID counts; a busy port lsof cannot attribute to us counts too", () => {
    const records = parseLsof("p4242\nu501\np5151\nu502\n");
    expect(records).toEqual([
      { pid: 4242, uid: 501, names: [] },
      { pid: 5151, uid: 502, names: [] },
    ]);
    expect(macForeignHolders(records, 501, false)).toEqual([{ owner: "502" }]);
    expect(macForeignHolders(parseLsof("p4242\nu501\n"), 501, true)).toEqual([]);
    // Nothing visible: free before a bind, another user's after a failed bind.
    expect(macForeignHolders([], 501, false)).toEqual([]);
    expect(macForeignHolders([], 501, true)).toEqual([{ owner: null }]);
  });

  test("macOS redeem check: only the client's own end, never the service's reversed socket", () => {
    const sample = [
      "p800",
      "u501",
      "f12",
      "n127.0.0.1:50000->127.0.0.1:7713",
      "p4242",
      "u501",
      "f20",
      "n127.0.0.1:7713->127.0.0.1:50000",
    ].join("\n");
    expect(macPeerIsMine(parseLsof(sample), 50000, 7713, 4242, 501)).toBe(true);
    // The client is another user; the service's own socket, owned by us, must not match.
    const other = sample.replace("p800\nu501", "p800\nu502");
    expect(macPeerIsMine(parseLsof(other), 50000, 7713, 4242, 501)).toBe(false);
    // lsof shows only the service's own socket: no match, so no redemption.
    const own = "p4242\nu501\nf20\nn127.0.0.1:7713->127.0.0.1:50000\n";
    expect(macPeerIsMine(parseLsof(own), 50000, 7713, 4242, 501)).toBe(false);
    // A PID alone never counts.
    expect(macPeerIsMine(parseLsof("p800\nu501\n"), 50000, 7713, 4242, 501)).toBe(false);
    // Two matching records of different users: refused.
    const both = `${sample}\np900\nu502\nf3\nn127.0.0.1:50000->127.0.0.1:7713\n`;
    expect(macPeerIsMine(parseLsof(both), 50000, 7713, 4242, 501)).toBe(false);
  });
});
