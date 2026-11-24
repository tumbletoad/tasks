// The page's folder chooser: the folders in a folder on this machine, for the person only, read
// by name and bounded in time and size. A fake disk covers what no test machine has (a share that
// stops answering, Windows drives and shares on any OS); a scratch folder covers links, files and
// permissions on the real disk. Scratch folders only.
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pageFolderVerbs } from "../src/hub/page-folders.ts";
import { SPACE_HEADER } from "../src/http/app.ts";
import {
  listFolders,
  makeFolder,
  nodeListFs,
  type ListFacts,
  type ListFs,
  type Listing,
} from "../src/ops/listing.ts";
import { tempRoot } from "./harness.ts";
import { post } from "./http-client.ts";
import { httpWorld, signIn, type HttpWorld } from "./http-world.ts";

const SLOW = 120_000;

type Kind = "dir" | "file" | "link-dir" | "link-file";

/** A disk of folders by path; a path in `hang` never answers, one in `slow` stops after a few. */
function fakeFs(
  tree: Record<string, Record<string, Kind> | number>,
  options: { hang?: readonly string[]; slow?: readonly string[]; denied?: readonly string[] } = {},
): ListFs {
  const never = () => new Promise<never>(() => undefined);
  const errno = (code: string) => Object.assign(new Error(code), { code });
  return {
    entries: async function* (path) {
      if (options.hang?.includes(path)) await never();
      if (options.denied?.includes(path)) throw errno("EACCES");
      const found = tree[path];
      if (found === undefined) throw errno("ENOENT");
      if (typeof found === "number") {
        for (let k = 0; k < found; k += 1) {
          yield { name: `f${String(k)}`, isDirectory: () => true, isSymbolicLink: () => false };
        }
        return;
      }
      let k = 0;
      for (const [name, kind] of Object.entries(found)) {
        if (options.slow?.includes(path) && k === 2) await never();
        k += 1;
        yield {
          name,
          isDirectory: () => kind === "dir",
          isSymbolicLink: () => kind.startsWith("link"),
        };
      }
    },
    isFolder: async (path) => {
      if (options.hang?.includes(path)) return never();
      if (tree[path] !== undefined) return true;
      // A link's target: its kind in its folder.
      const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      const parent = tree[path.slice(0, cut)] ?? tree[path.slice(0, cut + 1)];
      const kind = typeof parent === "object" ? parent[path.slice(cut + 1)] : undefined;
      if (kind === undefined) throw errno("ENOENT");
      return kind === "dir" || kind === "link-dir";
    },
    make: () => Promise.resolve(),
    repo: (path) => Promise.resolve(path.endsWith("portal") ? "portal-web" : undefined),
  };
}

const linux = (fs: ListFs, more: Partial<ListFacts> = {}): ListFacts => ({
  home: "/home/mira",
  platform: "linux",
  fs,
  ms: 300,
  ...more,
});

const names = (listing: Listing): string[] =>
  listing.kind === "list" ? listing.folders.map((f) => f.name) : [];

describe("[A7.3.12.m5-14.folders-gate] Only the person looks through this machine's folders", () => {
  it("refuses an agent's connection, a script, the bridge and a shim before it reads anything", async () => {
    // Nothing of the host is read before the refusal: an empty one would fail if it were.
    const verbs = pageFolderVerbs({ ops: {} as never, fs: {} as ListFs });
    for (const cls of ["cli-agent", "cli-script", "bridge", "shim"] as const) {
      for (const verb of [verbs.list, verbs.make, verbs.project]) {
        await expect(verb({ path: "~/" }, cls)).rejects.toMatchObject({ code: "forbidden" });
      }
    }
  });

  it("answers the page and a person at a terminal", async () => {
    const fs = fakeFs({ "/home/mira": { work: "dir" } });
    const verbs = pageFolderVerbs({
      ops: { machine: { id: "m_x" }, spaces: () => [], platform: "linux", home: "/home/mira" },
      fs,
    });
    for (const cls of ["ui", "cli-interactive"] as const) {
      expect(names((await verbs.list({ path: "~/" }, cls)) as Listing)).toEqual(["work"]);
    }
  });
});

describe("[A7.3.12.m5-14.folders-list] The chooser lists folders by name, bounded in time and size", () => {
  it("lists the folders in the folder typed, completes the name typed after it, and hides no folder a prefix asks for", async () => {
    const fs = fakeFs({
      "/home/mira": { work: "dir", Writing: "dir", ".config": "dir", "notes.txt": "file" },
      "/home/mira/work": { portal: "dir", billing: "dir" },
    });
    const all = await listFolders("~/", linux(fs));
    expect(all).toMatchObject({ kind: "list", at: "~/", prefix: "", up: "/home/" });
    expect(await listFolders("/", linux(fs))).not.toHaveProperty("up");
    // Folders only, in name order whatever the case, a dot folder only when the prefix asks.
    expect(names(all)).toEqual(["work", "Writing"]);
    expect(names(await listFolders("~/w", linux(fs)))).toEqual(["work", "Writing"]);
    expect(names(await listFolders("~/.c", linux(fs)))).toEqual([".config"]);
    // `~` alone is the home.
    expect(await listFolders("~", linux(fs))).toMatchObject({ kind: "list", at: "~/" });
    // The folder the text names: the name a project gets, and its repository.
    const exact = await listFolders("/home/mira/work/portal", linux(fs));
    expect(exact).toMatchObject({
      kind: "list",
      at: "~/work/",
      prefix: "portal",
      exact: { folder: "~/work/portal", name: "portal", repo: "portal-web" },
    });
  });

  it("says which projects of the space have the folder named, every one of them", async () => {
    const fs = fakeFs({ "/home/mira/work": { portal: "dir", billing: "dir" } });
    const projects = [
      { id: "p_1", name: "Lumen portal", stored: "~/work/portal" },
      { id: "p_2", name: "Portal bugs", stored: "~/work/portal" },
    ];
    const listing = await listFolders("~/work/", linux(fs, { projects }));
    expect(listing.kind === "list" ? listing.folders : []).toEqual([
      { name: "billing" },
      { name: "portal" },
    ]);
    expect(await listFolders("~/work/portal", linux(fs, { projects }))).toMatchObject({
      exact: {
        projects: [
          { id: "p_1", name: "Lumen portal" },
          { id: "p_2", name: "Portal bugs" },
        ],
      },
    });
  });

  it("reads a huge folder up to its cap and says there is more; a prefix narrows it", async () => {
    const fs = fakeFs({ "/data": 50_000 });
    const listing = await listFolders("/data/", linux(fs, { ms: 10_000 }));
    expect(listing).toMatchObject({ kind: "list", more: true });
    expect(names(listing)).toHaveLength(200);
    const narrow = await listFolders("/data/f4999", linux(fs, { ms: 10_000 }));
    expect(names(narrow)).toContain("f4999");
    // It stops reading at the cap, even when no folder read so far is shown.
    let read = 0;
    const counted: ListFs = {
      ...fs,
      entries: async function* (path) {
        for await (const entry of fs.entries(path)) {
          read += 1;
          yield entry;
        }
      },
    };
    const capped = await listFolders("/data/zzz", linux(counted, { ms: 10_000, scanMax: 1_000 }));
    expect(capped).toMatchObject({ kind: "list", more: true, folders: [] });
    expect(read).toBeLessThanOrEqual(1_001);
  });

  it("a folder whose look is still on its way is not looked at again", async () => {
    let looks = 0;
    const base = fakeFs({}, { hang: ["/mnt/gone"] });
    const fs: ListFs = {
      ...base,
      isFolder: (path) => {
        looks += 1;
        return base.isFolder(path);
      },
    };
    const verbs = pageFolderVerbs({
      ops: { machine: { id: "m_x" }, spaces: () => [], platform: "linux", home: "/home/mira" },
      fs,
      ms: 50,
    });
    // The person types on in a folder of a share that stopped answering.
    for (const typed of ["/mnt/gone/a", "/mnt/gone/ab", "/mnt/gone/abc"]) {
      expect(await verbs.list({ path: typed }, "ui")).toMatchObject({ reason: "not_answering" });
    }
    expect(looks).toBe(1);
  });

  it("a folder whose read stopped answering is not read again while that read is on its way", async () => {
    let reads = 0;
    const base = fakeFs(
      { "/mnt/share": { a: "dir", b: "dir", c: "dir" } },
      { slow: ["/mnt/share"] },
    );
    const fs: ListFs = {
      ...base,
      entries: (path) => {
        reads += 1;
        return base.entries(path);
      },
    };
    const verbs = pageFolderVerbs({
      ops: { machine: { id: "m_x" }, spaces: () => [], platform: "linux", home: "/home/mira" },
      fs,
      ms: 50,
    });
    expect(names((await verbs.list({ path: "/mnt/share/" }, "ui")) as Listing)).toEqual(["a", "b"]);
    expect(await verbs.list({ path: "/mnt/share/b" }, "ui")).toMatchObject({
      reason: "not_answering",
    });
    expect(reads).toBe(1);
  });

  it("looks only at the links it would show", async () => {
    const tree: Record<string, Kind> = {};
    for (let k = 0; k < 50; k += 1) tree[`l${String(k).padStart(2, "0")}`] = "link-dir";
    const base = fakeFs({ "/data": tree });
    let looks = 0;
    const fs: ListFs = {
      ...base,
      isFolder: (path) => {
        looks += 1;
        return base.isFolder(path);
      },
    };
    const listing = await listFolders("/data/", linux(fs, { showMax: 10 }));
    expect(names(listing)).toHaveLength(10);
    expect(listing).toMatchObject({ more: true });
    // The folder itself, and the ten links shown.
    expect(looks).toBe(11);
  });

  it("on Linux a folder whose name ends in a backslash is that folder, not its sibling", async () => {
    const fs = fakeFs({
      "/home/mira": { "draft\\": "dir", draft: "dir" },
      "/home/mira/draft\\": {},
    });
    expect(await listFolders("~/draft\\/", linux(fs))).toMatchObject({
      kind: "list",
      at: "~/draft\\/",
      exact: { folder: "~/draft\\", name: "draft\\" },
    });
  });

  it("a folder that does not answer in time is said so, and one that stops answering gives what it read", async () => {
    const fs = fakeFs(
      { "/mnt/share": { a: "dir", b: "dir", c: "dir" }, "/mnt/gone": { a: "dir" } },
      { hang: ["/mnt/gone"], slow: ["/mnt/share"] },
    );
    const started = Date.now();
    expect(await listFolders("/mnt/gone/", linux(fs))).toMatchObject({
      kind: "problem",
      reason: "not_answering",
      at: "/mnt/gone/",
    });
    const partial = await listFolders("/mnt/share/", linux(fs));
    expect(partial).toMatchObject({ kind: "list", more: true });
    expect(names(partial)).toEqual(["a", "b"]);
    // Two looks, each bounded by its time limit: far from a hang.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a folder it may not read, one that is not there, a file and a relative path are said so", async () => {
    const fs = fakeFs(
      { "/home/mira": { "notes.txt": "file" }, "/root": {} },
      { denied: ["/root"] },
    );
    expect(await listFolders("/root/", linux(fs))).toMatchObject({ reason: "folder_unreadable" });
    expect(await listFolders("/nowhere/x", linux(fs))).toMatchObject({ reason: "folder_missing" });
    expect(await listFolders("~/notes.txt/", linux(fs))).toMatchObject({
      reason: "not_a_directory",
    });
    expect(await listFolders("work/portal", linux(fs))).toMatchObject({ reason: "not_absolute" });
    expect(await listFolders("~/a/../b/", linux(fs))).toMatchObject({ reason: "invalid_path" });
  });

  it("begins at the home and the folders that hold the space's projects", async () => {
    const fs = fakeFs({});
    const projects = [
      { id: "p_1", name: "Portal", stored: "~/work/lumen/portal" },
      { id: "p_2", name: "Billing", stored: "~/work/lumen/billing" },
      { id: "p_3", name: "Thesis", stored: "/srv/thesis" },
    ];
    expect(await listFolders("", linux(fs, { projects }))).toEqual({
      kind: "start",
      sep: "/",
      places: [
        { folder: "~" },
        { folder: "~/work/lumen", project: "Portal" },
        { folder: "/srv", project: "Thesis" },
      ],
      roots: ["/"],
    });
  });

  it("on Windows: the drives that answer, a share by its server and name, and ~ as the home", async () => {
    const fs = fakeFs(
      {
        "C:\\": { Users: "dir" },
        "D:\\": {},
        "C:\\Users\\mira": { code: "dir" },
        "C:\\Users\\mira\\code": { portal: "dir" },
        "\\\\nas\\team": { Projects: "dir" },
      },
      { hang: ["E:\\"] },
    );
    const windows: ListFacts = { home: "C:\\Users\\mira", platform: "win32", fs, ms: 300 };
    expect(await listFolders("", windows)).toMatchObject({
      kind: "start",
      sep: "\\",
      roots: ["C:\\", "D:\\"],
    });
    // A drive letter alone, in either case, is its root.
    expect(await listFolders("c:", windows)).toMatchObject({
      at: "C:\\",
      folders: [{ name: "Users" }],
    });
    // Forward slashes are a Windows path's too; the home is ~.
    expect(await listFolders("~/code/", windows)).toMatchObject({
      at: "~\\code\\",
      up: "~\\",
      folders: [{ name: "portal" }],
    });
    expect(await listFolders("C:\\Users\\mira\\code\\PORTAL", windows)).toMatchObject({
      exact: { folder: "~\\code\\portal", name: "portal" },
    });
    expect(await listFolders("\\\\nas\\team\\", windows)).toMatchObject({
      at: "\\\\nas\\team\\",
      folders: [{ name: "Projects" }],
    });
    expect(await listFolders("\\\\nas\\", windows)).toMatchObject({ reason: "share_needed" });
    expect(await listFolders("\\\\nas", windows)).toMatchObject({ reason: "share_needed" });
  });

  it("makes a folder in one that exists, takes one that is there, and refuses one without its parent", async () => {
    const made: string[] = [];
    const fs: ListFs = {
      ...fakeFs({ "/home/mira/work": {} }),
      make: (path) => {
        if (!path.startsWith("/home/mira/work/")) {
          return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        }
        made.push(path);
        return Promise.resolve();
      },
    };
    expect(await makeFolder("~/work/atlas/", linux(fs))).toEqual({ folder: "~/work/atlas" });
    expect(made).toEqual(["/home/mira/work/atlas"]);
    expect(await makeFolder("/tmp/x/y", linux(fs))).toEqual({ reason: "folder_missing" });
    expect(await makeFolder("atlas", linux(fs))).toEqual({ reason: "not_absolute" });
  });
});

describe("[A7.3.12.m5-14.folders-disk] On this machine's disk: links said so, files never listed", () => {
  let temp: { root: string; cleanup: () => void };
  beforeAll(() => {
    temp = tempRoot("folders-disk");
  });
  afterAll(() => {
    temp.cleanup();
  });

  it("lists folders and links to folders, marks the links, and leaves out files and broken links", async () => {
    const root = join(temp.root, "work");
    mkdirSync(join(root, "portal", ".git"), { recursive: true });
    writeFileSync(
      join(root, "portal", ".git", "config"),
      '[remote "origin"]\n\turl = https://git.example.com/mira/portal-web.git\n',
    );
    mkdirSync(join(temp.root, "elsewhere", "inside"), { recursive: true });
    writeFileSync(join(root, "readme.md"), "never read");
    // A junction on Windows: no special right needed.
    symlinkSync(join(temp.root, "elsewhere"), join(root, "shortcut"), "junction");
    symlinkSync(join(temp.root, "nothing"), join(root, "broken"), "junction");
    const fs = nodeListFs(process.platform);
    const facts: ListFacts = { home: temp.root, platform: process.platform, fs };
    const sep = process.platform === "win32" ? "\\" : "/";
    const listing = await listFolders(`${root}${sep}`, facts);
    expect(listing.kind === "list" ? listing.folders : []).toEqual([
      { name: "portal" },
      { name: "shortcut", link: true },
    ]);
    // Opening the link lists what it points to: the person chose it.
    expect(names(await listFolders(`${root}${sep}shortcut${sep}`, facts))).toEqual(["inside"]);
    expect(await listFolders(`${root}${sep}portal`, facts)).toMatchObject({
      exact: { folder: `~${sep}work${sep}portal`, name: "portal", repo: "portal-web" },
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a folder without read permission is said so",
    async () => {
      const locked = join(temp.root, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      try {
        const facts: ListFacts = {
          home: temp.root,
          platform: process.platform,
          fs: nodeListFs(process.platform),
        };
        expect(await listFolders(`${locked}/`, facts)).toMatchObject({
          kind: "problem",
          reason: "folder_unreadable",
        });
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  it("makes a new folder as a plain mkdir would, in a folder that exists", async () => {
    const fs = nodeListFs(process.platform);
    const facts = { home: temp.root, platform: process.platform, fs };
    const sep = process.platform === "win32" ? "\\" : "/";
    const made = await makeFolder(join(temp.root, "fresh"), facts);
    expect(made).toEqual({ folder: `~${sep}fresh` });
    if (process.platform !== "win32") {
      // The mode a plain mkdir gives under the same umask, not the product's own private one.
      mkdirSync(join(temp.root, "plain"));
      const mode = (path: string) => statSync(path).mode & 0o777;
      expect(mode(join(temp.root, "fresh"))).toBe(mode(join(temp.root, "plain")));
    }
    expect(await makeFolder(join(temp.root, "fresh"), facts)).toEqual({ folder: `~${sep}fresh` });
    expect(await makeFolder(join(temp.root, "no", "parent"), facts)).toEqual({
      reason: "folder_missing",
    });
  });
});

describe("[A7.3.12.m5-14.folders-http] The page's folder calls over HTTP", () => {
  let w: HttpWorld;
  let token: string;
  let space: string;
  beforeAll(async () => {
    w = await httpWorld("folders-http");
    token = (await signIn(w)).token;
    const listed = await post(w.port(), "/api/v1/space/list", {}, { token });
    space =
      (JSON.parse(listed.body) as { result: { spaces: { id: string }[] } }).result.spaces[0]?.id ??
      "";
  }, SLOW);
  afterAll(async () => {
    await w.close();
  }, SLOW);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the result's shape
  const page = async <T>(path: string, body: unknown): Promise<{ status: number; result: T }> => {
    const reply = await post(w.port(), path, body, { token, headers: { [SPACE_HEADER]: space } });
    return { status: reply.status, result: (JSON.parse(reply.body) as { result: T }).result };
  };

  it(
    "lists a folder, and names a project's folder here and elsewhere",
    async () => {
      const work = join(w.root, "work");
      mkdirSync(join(work, "portal"), { recursive: true });
      mkdirSync(join(work, "billing"));
      const user = await w.user();
      const status = (await user.call(
        "op/call",
        { space, op: "space.status", input: {} },
        { timeoutMs: SLOW },
      )) as { as_of: string };
      const added = (await user.call(
        "op/call",
        {
          space,
          op: "folder.manage",
          input: {
            action: "add_project",
            folder: join(work, "portal"),
            area: "Client work",
            base: status.as_of,
            request_id: "folders-http-add-portal-01",
          },
        },
        { timeoutMs: SLOW },
      )) as { owner: { id: string }; folder: string };
      const sep = process.platform === "win32" ? "\\" : "/";
      const listed = await page<Listing>("/api/v1/machine/folders", { path: `${work}${sep}` });
      expect(listed.status).toBe(200);
      expect(listed.result).toMatchObject({
        kind: "list",
        folders: [{ name: "billing" }, { name: "portal" }],
      });
      const line = await page<{ here?: { folder: string; state: string }; elsewhere: string[] }>(
        "/api/v1/machine/project_folder",
        { project: added.owner.id },
      );
      expect(line.result).toEqual({ here: { folder: added.folder, state: "here" }, elsewhere: [] });
      const made = await page<{ folder: string }>("/api/v1/machine/folder_make", {
        path: join(work, "atlas"),
      });
      expect(made.result.folder.endsWith(`work${sep}atlas`)).toBe(true);
    },
    SLOW,
  );
});
