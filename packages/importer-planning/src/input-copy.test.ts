// The input copy (A7 3.15.1): only the inputs, into a folder the copy creates, with the SHA-256 of
// each, and every source change reported.
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { copyInput, hashInputs, parsePrototype, readInput, verifySource } from "./index.ts";

// A hook after each file the copy writes, so a test can change the source mid-copy, and one after
// each folder it makes, so a test can replace the folder before its mode is set.
let afterCopied: ((path: string) => void) | undefined;
let afterMkdir: ((path: string) => void) | undefined;
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    mkdir: async (...args: Parameters<typeof real.mkdir>) => {
      const made = await real.mkdir(...args);
      if (typeof args[0] === "string") afterMkdir?.(args[0]);
      return made;
    },
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      await real.writeFile(...args);
      if (typeof args[0] === "string") afterCopied?.(args[0]);
    },
    // The copy creates each file exclusively and writes it through its handle (its mode is set on
    // the handle first): the hook runs once that write is done.
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      const [path, flags] = args;
      if (typeof path === "string" && flags === "wx") {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...data: Parameters<typeof handle.writeFile>) => {
          await write(...data);
          afterCopied?.(path);
        };
      }
      return handle;
    },
  };
});

// Made in a hook, not at import: the manifest check imports test files without running hooks.
let work = "";
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "tasks-m7-02-copy-"));
});
afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});
let n = 0;
let source = "";
let runs = "";

/** A small prototype folder, with files that are no inputs beside the inputs. */
function makeSource(dir: string): void {
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "events"));
  mkdirSync(join(dir, "context"));
  writeFileSync(join(dir, "TODO.md"), "## A\r\n- [ ] **One** <!-- task:one -->\r\n");
  writeFileSync(join(dir, "DONE.md"), "# Done\n");
  writeFileSync(join(dir, "data", "metadata.json"), '{"one": {"status": "open"}}');
  writeFileSync(
    join(dir, "events", "cli-1.json"),
    '{"id":"cli-1","task":"one","action":"check","at":"2026-01-01T10:00Z"}',
  );
  writeFileSync(join(dir, "events", "web-1.ready"), "");
  writeFileSync(join(dir, "events", "notes.txt"), "not an event");
  writeFileSync(join(dir, "planning.py"), "raise SystemExit(1)\n");
  writeFileSync(join(dir, "context", "a.md"), "notes\n");
}

beforeEach(() => {
  n += 1;
  source = join(work, `source-${String(n)}`);
  runs = join(work, `runs-${String(n)}`);
  makeSource(source);
  mkdirSync(runs);
});

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("[A7.3.15.importer.input-copy] the input copy", () => {
  test("copies only the inputs, byte for byte, with their hashes, and nothing beside them", async () => {
    const dest = join(runs, "input");
    const copy = await copyInput(source, dest);
    expect(copy.problems).toEqual([]);
    expect(copy.ok).toBe(true);
    expect(copy.files.map((f) => f.path)).toEqual([
      "TODO.md",
      "DONE.md",
      "data/metadata.json",
      "events/cli-1.json",
      "events/web-1.ready",
    ]);
    for (const f of copy.files) {
      const from = join(source, ...f.path.split("/"));
      expect(f.sha256).toBe(sha(from));
      expect(sha(join(dest, ...f.path.split("/")))).toBe(f.sha256);
    }
    expect(readdirSync(runs)).toEqual(["input"]);
    expect(readdirSync(dest).sort()).toEqual(["DONE.md", "TODO.md", "data", "events"]);
    expect((await hashInputs(dest)).files).toEqual(copy.files);
    expect(await verifySource(source, copy.files)).toEqual([]);

    const read = await readInput(dest);
    expect(read.problems).toEqual([]);
    const parse = parsePrototype(read.input);
    expect(parse.tasks.map((t) => [t.id, t.group])).toEqual([["one", "A"]]);
    expect(parse.events.state.get("one")?.check?.checked).toBe(true);
    expect(parse.problems).toEqual([]);
  });

  test("refuses a destination that exists, lies inside the source or has no parent", async () => {
    mkdirSync(join(runs, "taken"));
    const taken = await copyInput(source, join(runs, "taken"));
    expect(taken).toEqual({
      ok: false,
      files: [],
      problems: [{ code: "destination-exists", severity: "error", file: "." }],
    });
    expect(readdirSync(join(runs, "taken"))).toEqual([]);
    for (const dest of [source, join(source, "input"), join(source, "events", "x")]) {
      const inside = await copyInput(source, dest);
      expect(
        inside.problems.map((p) => p.code),
        dest,
      ).toEqual(["destination-inside-source"]);
    }
    expect(readdirSync(source).sort()).toEqual(
      ["DONE.md", "TODO.md", "context", "data", "events", "planning.py"].sort(),
    );
    const orphan = await copyInput(source, join(runs, "no", "parent"));
    expect(orphan.problems.map((p) => p.code)).toEqual(["write-failed"]);
  });

  test("reports every source file that changed, appeared or went away", async () => {
    const copy = await copyInput(source, join(runs, "input"));
    expect(copy.ok).toBe(true);
    writeFileSync(join(source, "TODO.md"), "- [ ] **Changed**\n");
    unlinkSync(join(source, "DONE.md"));
    writeFileSync(join(source, "events", "cli-2.json"), "{}");
    writeFileSync(join(source, "data", "jira.json"), "[]");
    writeFileSync(join(source, "planning.py"), "changed, but no input\n");
    const changed = await verifySource(source, copy.files);
    expect(changed.map((p) => `${p.code} ${p.file}`).sort()).toEqual(
      [
        "source-changed TODO.md",
        "source-changed DONE.md",
        "source-changed events/cli-2.json",
        "source-changed data/jira.json",
      ].sort(),
    );
  });

  test("a folder with no optional files copies, and the parse reports the missing ledger", async () => {
    unlinkSync(join(source, "DONE.md"));
    rmSync(join(source, "data"), { recursive: true });
    rmSync(join(source, "events"), { recursive: true });
    const copy = await copyInput(source, join(runs, "input"));
    expect(copy.ok).toBe(true);
    expect(copy.files.map((f) => f.path)).toEqual(["TODO.md"]);
    const parse = parsePrototype((await readInput(join(runs, "input"))).input);
    expect(parse.problems.map((p) => `${p.code} ${p.file}`)).toEqual(["file-missing DONE.md"]);
    expect(parse.metadata.size).toBe(0);
  });

  test("a file over its bound is not copied, and the copy is not ok", async () => {
    const copy = await copyInput(source, join(runs, "input"), { ledgerBytes: 10 });
    expect(copy.ok).toBe(false);
    expect(copy.problems.map((p) => `${p.code} ${p.file}`)).toEqual(["file-too-large TODO.md"]);
    expect(copy.files.map((f) => f.path)).not.toContain("TODO.md");
    const events = await copyInput(source, join(runs, "events-bound"), { eventFiles: 1 });
    expect(events.problems.map((p) => p.code)).toEqual(["too-many-event-files"]);
  });

  test("a directory or a link where a file belongs is not copied", async (ctx) => {
    mkdirSync(join(source, "events", "dir.json"));
    const copy = await copyInput(source, join(runs, "input"));
    expect(copy.problems.map((p) => `${p.code} ${p.file}`)).toEqual([
      "not-a-regular-file events/dir.json",
    ]);
    expect(copy.ok).toBe(false);

    rmSync(join(source, "events", "dir.json"), { recursive: true });
    const outside = join(work, `outside-${String(n)}.md`);
    writeFileSync(outside, "- [ ] **Outside the folder**\n");
    unlinkSync(join(source, "DONE.md"));
    try {
      symlinkSync(outside, join(source, "DONE.md"), "file");
    } catch {
      // Windows without the symlink privilege: the link half of this test runs on Ubuntu.
      ctx.skip();
      return;
    }
    const linked = await copyInput(source, join(runs, "linked"));
    expect(linked.problems.map((p) => `${p.code} ${p.file}`)).toEqual([
      "not-a-regular-file DONE.md",
    ]);
    expect(linked.files.map((f) => f.path)).not.toContain("DONE.md");
  });

  // A junction needs no privilege on Windows; on Linux "junction" makes a directory link.
  const linkDir = (target: string, path: string) => {
    symlinkSync(target, path, "junction");
  };

  test("a linked data/ or events/ folder is not followed (review finding)", async () => {
    const outside = join(work, `outside-${String(n)}`);
    mkdirSync(join(outside, "data"), { recursive: true });
    writeFileSync(join(outside, "data", "metadata.json"), '{"outside": {}}');
    rmSync(join(source, "data"), { recursive: true });
    linkDir(join(outside, "data"), join(source, "data"));
    rmSync(join(source, "events"), { recursive: true });
    linkDir(join(outside, "data"), join(source, "events"));
    const copy = await copyInput(source, join(runs, "input"));
    expect(copy.ok).toBe(false);
    expect(copy.problems.map((p) => `${p.code} ${p.file}`)).toEqual([
      "not-a-regular-file data",
      "not-a-regular-file events",
    ]);
    expect(copy.files.map((f) => f.path)).toEqual(["TODO.md", "DONE.md"]);
  });

  test("refuses a destination inside the source by any spelling or link (review finding)", async () => {
    // `..input` is a name inside the source, not its parent.
    const dotted = await copyInput(source, join(source, "..input"));
    expect(dotted.problems.map((p) => p.code)).toEqual(["destination-inside-source"]);
    // A parent that is a link back into the source.
    linkDir(source, join(runs, "alias"));
    const aliased = await copyInput(source, join(runs, "alias", "input"));
    expect(aliased.problems.map((p) => p.code)).toEqual(["destination-inside-source"]);
    expect(readdirSync(source).sort()).toEqual(
      ["DONE.md", "TODO.md", "context", "data", "events", "planning.py"].sort(),
    );
  });

  test("verification fails closed on a source it cannot fully read (review finding)", async () => {
    const copy = await copyInput(source, join(runs, "input"));
    expect(copy.ok).toBe(true);
    mkdirSync(join(source, "events", "new.json"));
    writeFileSync(join(source, "events", "big.json"), "x".repeat(70 * 1024));
    writeFileSync(join(source, "data", "audit.json"), "x".repeat(100));
    const changed = await verifySource(source, copy.files, { jsonBytes: 50 });
    expect(changed.map((p) => `${p.code} ${p.file}`).sort()).toEqual(
      [
        "source-changed events/new.json",
        "source-changed events/big.json",
        "source-changed data/audit.json",
      ].sort(),
    );
  });

  test("the event-file bound counts every candidate name, files or not (review finding)", async () => {
    for (const d of ["d1.json", "d2.json", "d3.json"]) mkdirSync(join(source, "events", d));
    const copy = await copyInput(source, join(runs, "input"), { eventFiles: 2 });
    expect(copy.problems.map((p) => p.code)).toContain("too-many-event-files");
    expect(copy.problems.filter((p) => p.code === "not-a-regular-file").length).toBeLessThan(3);
  });

  test("a problem names an event file only by a name of the event grammar", async () => {
    mkdirSync(join(source, "events", "Call Tomas.json"));
    const copy = await copyInput(source, join(runs, "input"));
    expect(copy.problems).toEqual([
      { code: "not-a-regular-file", severity: "error", file: "events" },
    ]);
  });

  test("a source file that changes while the copy runs stops the copy", async () => {
    // TODO.md changes after its bytes were copied, while later files are still being copied.
    afterCopied = (path) => {
      if (path.endsWith("TODO.md")) writeFileSync(join(source, "TODO.md"), "- [ ] **Later**\n");
    };
    try {
      const copy = await copyInput(source, join(runs, "input"));
      expect(copy.ok).toBe(false);
      expect(copy.problems.map((p) => `${p.code} ${p.file}`)).toEqual(["source-changed TODO.md"]);
    } finally {
      afterCopied = undefined;
    }
  });
});

describe.skipIf(process.platform === "win32")(
  "[A2.3.2.2.permissions.create] the input copy sets a mode only on what it created",
  () => {
    test("an existing destination keeps its mode; a new one replaced by a link is not followed", async () => {
      const taken = join(runs, "taken");
      mkdirSync(taken);
      chmodSync(taken, 0o755);
      const refused = await copyInput(source, taken);
      expect(refused.problems.map((p) => p.code)).toEqual(["destination-exists"]);
      expect(statSync(taken).mode & 0o777).toBe(0o755);
      // Right after its mkdir, the new destination is replaced by a link to another folder.
      const outside = join(runs, "outside");
      mkdirSync(outside);
      chmodSync(outside, 0o755);
      const dest = join(runs, "input");
      afterMkdir = (path) => {
        if (path.endsWith("/input")) {
          rmSync(path, { recursive: true });
          symlinkSync(outside, path);
        }
      };
      try {
        const copy = await copyInput(source, dest);
        expect(copy.ok).toBe(false);
        expect(copy.problems.map((p) => p.code)).toEqual(["write-failed"]);
      } finally {
        afterMkdir = undefined;
      }
      expect(statSync(outside).mode & 0o777).toBe(0o755);
      expect(readdirSync(outside)).toEqual([]);
      // Without a swap, every folder and file of the copy is the user's alone.
      const fresh = await copyInput(source, join(runs, "fresh"));
      expect(fresh.ok).toBe(true);
      expect(statSync(join(runs, "fresh")).mode & 0o777).toBe(0o700);
      expect(statSync(join(runs, "fresh", "events")).mode & 0o777).toBe(0o700);
      expect(statSync(join(runs, "fresh", "TODO.md")).mode & 0o777).toBe(0o600);
    });
  },
);
