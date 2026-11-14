// Self-test of the M0.05 lab checks (A7 3.7 rows R07, R10, R11, R12). Everything here runs on
// fixture trees in a temporary folder and on fixed strings: no real home, sync or state folder of
// the machine is read, and no identifier is read.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type AclFacts, aclProblems, parseSddl, readAcls } from "../kit/perms.ts";
import { redactSid } from "./common.ts";
import { describe as describeId, formatClass } from "./machine-id.ts";
import { ADMINISTRATORS, onlyUser, ownerOnly, SYSTEM } from "./owner-only.ts";
import { sacState } from "./smart-app-control.ts";
import {
  classifyLinuxMount,
  type Context,
  defaultTargets,
  detect,
  driveFsPaths,
  isInside,
  mountOf,
  parseMountinfo,
  type Volume,
} from "./sync-detect.ts";

let tmp = "";
beforeAll(() => {
  tmp = mkdtempSync(join(os.tmpdir(), "tasks-lab-checks-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A context that sees only the fixture tree, so markers above the temporary folder never count. */
function fixtureContext(over: Partial<Context> = {}): Context {
  const mine = (p: string) => isInside(process.platform, p, tmp);
  return {
    platform: process.platform,
    home: tmp,
    roots: [],
    exists: (p) => mine(p) && existsSync(p),
    list: (d) => {
      if (!mine(d)) return undefined;
      try {
        return readdirSync(d);
      } catch {
        return undefined;
      }
    },
    volume: (): Volume => ({ kind: "local", fsType: "fixture" }),
    ...over,
  };
}

function tree(...paths: string[]): void {
  for (const p of paths) {
    const full = join(tmp, p);
    if (p.endsWith("/")) mkdirSync(full, { recursive: true });
    else {
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, "fixture");
    }
  }
}

describe("[A7.3.7.lab-checks.self-test] the M0.05 lab checks", () => {
  test("R07: a plain folder is local, markers in an ancestor make it synced", () => {
    tree(
      "plain/Tasks/",
      "sync/.stfolder/",
      "sync/a/Tasks/",
      "box/.dropbox",
      "box/Tasks/",
      "repo/.git/",
      "repo/Tasks/",
      "cloud/.owncloudsync.log",
      "cloud/Tasks/",
    );
    const ctx = fixtureContext();
    expect(detect(join(tmp, "plain", "Tasks"), ctx)).toMatchObject({
      verdict: "local",
      providers: [],
    });
    const st = detect(join(tmp, "sync", "a", "Tasks"), ctx);
    expect(st).toMatchObject({ verdict: "synced", providers: ["syncthing"] });
    expect(st.signals[0]).toMatchObject({ rule: "marker .stfolder", depth: 2 });
    expect(detect(join(tmp, "box", "Tasks"), ctx).providers).toEqual(["dropbox"]);
    expect(detect(join(tmp, "repo", "Tasks"), ctx).providers).toEqual(["git"]);
    expect(detect(join(tmp, "cloud", "Tasks"), ctx).providers).toEqual(["nextcloud"]);
  });

  test("R07: patterns need a listing, and conflict copies count only next to the path", () => {
    tree("nc/.sync_0a1b.db", "nc/Tasks/", "conf/space.sync-conflict-20261112.db", "conf/sub/");
    const ctx = fixtureContext();
    expect(detect(join(tmp, "nc", "Tasks"), ctx).providers).toEqual(["nextcloud"]);
    const noList = fixtureContext({ list: () => undefined });
    expect(detect(join(tmp, "nc", "Tasks"), noList).verdict).toBe("local");
    expect(detect(join(tmp, "conf"), ctx).providers).toEqual(["syncthing"]);
    expect(detect(join(tmp, "conf", "sub"), ctx).verdict).toBe("local");
  });

  test("R07: a missing path is judged from its nearest existing ancestor", () => {
    tree("deep/.stfolder/", "deep/base/");
    const d = detect(join(tmp, "deep", "base", "not", "yet", "there"), fixtureContext());
    expect(d).toMatchObject({ exists: false, judgedFrom: 3, verdict: "synced" });
    expect(existsSync(join(tmp, "deep", "base", "not"))).toBe(false);
  });

  test("R07: provider roots match by path, case-insensitively on Windows only", () => {
    expect(isInside("win32", "C:\\Users\\M\\OneDrive\\Tasks", "c:\\users\\m\\onedrive")).toBe(true);
    expect(isInside("win32", "C:\\Users\\M\\OneDriveX", "C:\\Users\\M\\OneDrive")).toBe(false);
    expect(isInside("win32", "G:\\My Drive", "G:\\")).toBe(true);
    expect(isInside("linux", "/home/m/Dropbox/x", "/home/m/dropbox")).toBe(false);
    expect(isInside("linux", "/home/m/Dropbox", "/home/m/Dropbox/")).toBe(true);
    tree("od/inside/");
    const ctx = fixtureContext({
      roots: [{ provider: "onedrive", root: join(tmp, "od"), source: "env OneDrive" }],
    });
    expect(detect(join(tmp, "od", "inside"), ctx)).toMatchObject({
      verdict: "synced",
      providers: ["onedrive"],
      signals: [{ rule: "env OneDrive", depth: 1 }],
    });
  });

  test("R07: a network volume wins over every other signal, then synced, then removable", () => {
    tree("vol/.stfolder/");
    const net = fixtureContext({ volume: () => ({ kind: "network", fsType: "cifs" }) });
    expect(detect(join(tmp, "vol"), net).verdict).toBe("network");
    const usb = fixtureContext({ volume: () => ({ kind: "removable", fsType: "vfat" }) });
    expect(detect(join(tmp, "vol"), usb).verdict).toBe("synced");
    tree("usb/");
    expect(detect(join(tmp, "usb"), usb).verdict).toBe("removable");
    const gdrive = fixtureContext({
      volume: () => ({ kind: "local", fsType: "FAT32", provider: "google-drive" }),
    });
    expect(detect(join(tmp, "usb"), gdrive).providers).toEqual(["google-drive"]);
  });

  test("R07: Linux mounts are read from mountinfo and classified", () => {
    const info = [
      "22 1 253:1 / / rw,relatime shared:1 - ext4 /dev/mapper/vg-root rw",
      "40 22 0:44 / /home/m/remote\\040share rw - fuse.sshfs m@host:/x rw",
      "41 22 0:45 / /media/m/STICK rw - vfat /dev/sdb1 rw",
      "42 22 0:46 / /mnt/nas rw - nfs4 nas:/export rw",
    ].join("\n");
    const mounts = parseMountinfo(info);
    expect(mounts.map((m) => m.mountPoint)).toContain("/home/m/remote share");
    const at = (p: string, removable = false) => classifyLinuxMount(mountOf(mounts, p), removable);
    expect(at("/home/m/Tasks")).toEqual({ kind: "local", fsType: "ext4" });
    expect(at("/home/m/remote share/Tasks").kind).toBe("network");
    expect(at("/mnt/nas/k").kind).toBe("network");
    expect(at("/media/m/STICK/k").kind).toBe("removable");
    expect(at("/home/m", true).kind).toBe("removable");
  });

  test("R07: Drive for desktop sync targets are found in its binary value", () => {
    const blob = Buffer.concat([
      Buffer.from([0x0a, 0x12]),
      Buffer.from("D:\\Google Drive", "utf8"),
      Buffer.from([0x12, 0x00]),
      Buffer.from("E:\\Sync\\Team\\", "utf16le"),
    ]);
    expect(driveFsPaths(blob.toString("base64")).sort()).toEqual([
      "D:\\Google Drive",
      "E:\\Sync\\Team",
    ]);
    expect(driveFsPaths("")).toEqual([]);
  });

  test("R07: the default targets follow A2 3.2.1 and are only computed", () => {
    const linux = defaultTargets("linux", "/home/m", 1000);
    expect(linux.get("~/Tasks")).toBe(join("/home/m", "Tasks"));
    expect(linux.get("<state> ~/.local/state/tasks")).toBe(
      join("/home/m", ".local", "state", "tasks"),
    );
    expect(linux.get("socket dir /run/user/<uid>")).toBe("/run/user/1000");
    const win = defaultTargets("win32", "C:\\Users\\M", -1);
    expect([...win.keys()]).toEqual([
      "~/Tasks",
      "<root> %USERPROFILE%\\.tasks",
      "<config>",
      "<state>",
      "<cache>",
    ]);
  });

  test("R10: ACLs are judged by SID", () => {
    const user = "S-1-5-21-1-2-3-1001";
    const other = "S-1-5-21-1-2-3-1002";
    const entry = (sid: string, inherited = true) => ({
      sid,
      type: "Allow",
      rights: "FA",
      inherited,
      inheritOnly: false,
    });
    const acl = (protect: boolean, ...entries: ReturnType<typeof entry>[]): AclFacts => ({
      path: "x",
      owner: user,
      entries,
      protected: protect,
    });
    // The inherited items: the user, SYSTEM and Administrators only (the kit's rule).
    const inherited = acl(false, entry(user), entry(SYSTEM), entry(ADMINISTRATORS));
    expect(aclProblems(inherited, user)).toEqual([]);
    expect(
      aclProblems({ ...inherited, entries: [...inherited.entries, entry(other)] }, user),
    ).toHaveLength(1);
    // The secrets rule: only the user, and a protected DACL on the folder.
    expect(onlyUser(acl(true, entry(user, false)), user)).toBe(true);
    expect(onlyUser(acl(false, entry(user)), user)).toBe(false);
    expect(onlyUser(acl(false, entry(user)), user, false)).toBe(true);
    // An explicit SYSTEM or Administrators grant fails it (a review finding).
    expect(onlyUser(acl(true, entry(user, false), entry(SYSTEM, false)), user)).toBe(false);
    expect(onlyUser(acl(true, entry(user, false), entry(ADMINISTRATORS, false)), user)).toBe(false);
    expect(onlyUser(acl(true), user)).toBe(false);
    expect(onlyUser({ ...acl(true, entry(user, false)), owner: other }, user)).toBe(false);
    // The SDDL reader reports the protected flag.
    expect(parseSddl("x", `O:${user}D:PAI(A;OICI;FA;;;${user})`, user).protected).toBe(true);
    expect(parseSddl("x", `O:${user}D:AI(A;OICIID;FA;;;${user})`, user).protected).toBe(false);
    expect(parseSddl("x", `O:${user}D:NO_ACCESS_CONTROL`, user).protected).toBe(false);
    expect(redactSid(user)).toBe("S-1-5-21-…-1001");
    expect(redactSid(SYSTEM)).toBe(SYSTEM);
  });

  test("R10: Node creates owner-only folders and files in a temporary folder", () => {
    const scratch = join(tmp, "owner-only");
    mkdirSync(scratch);
    const r = ownerOnly(scratch);
    if (process.platform !== "win32") {
      expect(r.ok).toBe(true);
      return;
    }
    // A temporary folder need not carry the profile's ACL (a sandbox may add principals to
    // %TEMP%), so the inherited items are judged against their parent: Node adds no principal.
    // The secrets folder must hold only the user whatever the parent grants.
    const d = r.detail as { secretsOnlyUser: boolean; acls: Record<string, AclFacts | undefined> };
    expect(d.secretsOnlyUser).toBe(true);
    const sids = (a: AclFacts | undefined) => new Set((a?.entries ?? []).map((x) => x.sid));
    const parent = sids(d.acls.scratch);
    expect(parent.size).toBeGreaterThan(0);
    for (const item of ["space", "db"]) {
      expect([...sids(d.acls[item])].filter((s) => !parent.has(s))).toEqual([]);
    }
  }, 60_000);

  test("R10: other explicit grants on the secrets folder are removed, not kept", () => {
    if (process.platform !== "win32") return;
    // A review finding: CI's elevated runner gives new objects explicit SYSTEM and
    // Administrators entries, which `/inheritance:r /grant:r` keeps. The fixture puts such
    // explicit grants on the secrets folder before the check makes it user-only.
    const scratch = join(tmp, "owner-only-explicit");
    const secrets = join(scratch, "state", "secrets");
    mkdirSync(secrets, { recursive: true });
    const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
    const grant = spawnSync(
      icacls,
      [secrets, "/grant", `*${SYSTEM}:(OI)(CI)F`, "/grant", `*${ADMINISTRATORS}:(OI)(CI)F`],
      { encoding: "utf8", windowsHide: true },
    );
    expect(grant.status).toBe(0);
    const before = readAcls([secrets]).items[0];
    expect(before?.entries.some((e) => e.sid === SYSTEM && !e.inherited)).toBe(true);

    const r = ownerOnly(scratch);
    const d = r.detail as {
      user: string;
      secretsOnlyUser: boolean;
      acls: Record<string, AclFacts | undefined>;
    };
    expect(d.secretsOnlyUser).toBe(true);
    expect(d.acls.secrets?.protected).toBe(true);
    expect(d.acls.secrets?.entries.map((e) => [e.sid, e.inherited])).toEqual([[d.user, false]]);
    expect(d.acls.key?.entries.map((e) => [e.sid, e.inherited])).toEqual([[d.user, true]]);
  }, 60_000);

  test("R11: identifiers are described by class and length, never kept", () => {
    expect(formatClass("0123456789abcdef0123456789abcdef")).toBe("hex32");
    expect(formatClass("01234567-89ab-cdef-0123-456789abcdef")).toBe("guid");
    expect(formatClass("S-1-5-21-1-2-3-1001")).toBe("sid");
    expect(formatClass("100076")).toBe("uid");
    expect(formatClass("")).toBe("empty");
    const fake = "fedcba9876543210fedcba9876543210";
    const d = describeId("fixture", () => `${fake}\n`);
    expect(d.probe).toEqual({ source: "fixture", readable: true, length: 32, format: "hex32" });
    expect(JSON.stringify(d.probe)).not.toContain(fake);
    expect(d.prefix).toMatch(/^[0-9a-f]{8}$/);
    const missing = describeId("fixture", () => {
      throw Object.assign(new Error("no"), { code: "EACCES" });
    });
    expect(missing.probe).toMatchObject({ readable: false, error: "EACCES" });
  });

  test("R12: the Smart App Control value maps to its state", () => {
    expect([0, 1, 2, 7].map(sacState)).toEqual(["off", "on", "evaluation", "unknown"]);
    expect(sacState(null)).toBe("absent");
  });
});
