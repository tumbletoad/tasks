// pnpm seed --planning (A7 3.14 M7.01 Verify: "pnpm seed --planning regenerates it
// deterministically"). Runs the script twice into fresh folders, compares the two outputs byte for
// byte, and compares them with the committed fixture, which CI checks out on Windows and Ubuntu:
// .gitattributes must keep the fixture's CRLF lines and LF lines as they are.
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  buildPlanningFixture,
  PLANNING,
  serializeIndex,
} from "../packages/testkit/src/planning.ts";
import { seedPlanning } from "./seed-planning.ts";
import { repoRoot } from "./run.ts";

const made: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "seed-planning-"));
  made.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const seed = (args: string[]) =>
  spawnSync(process.execPath, [join(repoRoot, "scripts", "seed.ts"), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });

/** Every file under `folder` with its bytes, by POSIX path, in path order. */
function tree(folder: string): [string, Buffer][] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry): [string, Buffer] => {
      const full = join(entry.parentPath, entry.name);
      return [relative(folder, full).split(sep).join("/"), readFileSync(full)];
    })
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

/** The fixture folder and its index under `root`, as one comparable list. */
const output = (root: string): [string, Buffer][] => [
  ...tree(join(root, PLANNING.folder)),
  [PLANNING.index, readFileSync(join(root, PLANNING.index))],
];

const digestOf = (stdout: string): string | undefined =>
  /^digest: ([0-9a-f]{64})$/m.exec(stdout)?.[1];

describe("[A7.3.14.planning-fixture.deterministic] pnpm seed --planning", () => {
  test("regenerates the committed fixture byte for byte, twice", () => {
    const runs = [temp(), temp()].map((out) => {
      const result = seed(["--planning", "--out", out]);
      expect(result.status, result.stderr).toBe(0);
      expect(readdirSync(out).sort()).toEqual([PLANNING.folder, PLANNING.index].sort());
      return { files: output(out), digest: digestOf(result.stdout) };
    });
    const [a, b] = runs;
    expect(a?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(b?.digest).toBe(a?.digest);
    expect(b?.files).toEqual(a?.files);
    const committed = output(join(repoRoot, "fixtures"));
    // Compare names first, then each file, so a failure names the file that differs.
    expect(committed.map(([path]) => path)).toEqual(a?.files.map(([path]) => path));
    for (const [i, [path, bytes]] of committed.entries()) {
      expect(
        bytes.equals(a?.files[i]?.[1] ?? Buffer.alloc(0)),
        `${path} differs: run pnpm seed --planning`,
      ).toBe(true);
    }
  }, 60_000);

  test("the committed fixture keeps its line ends through checkout", () => {
    const read = (name: string) =>
      readFileSync(join(repoRoot, "fixtures", PLANNING.folder, name), "latin1");
    const done = read("DONE.md");
    // DONE.md is CRLF throughout; TODO.md mixes LF and CRLF lines.
    expect(done.split("\r\n").length).toBe(done.split("\n").length);
    const todo = read("TODO.md");
    expect(todo).toContain("\r\n");
    expect(/[^\r]\n/.test(todo)).toBe(true);
  });

  test("replacing the fixture never writes through a file that is linked elsewhere", () => {
    // The replace path (no --out) against a stand-in repository root, so the committed fixture
    // is not touched. Each output file is first hard-linked to a sentinel outside the target.
    const root = temp();
    expect(seedPlanning(["--planning"], root)).toBe(0);
    const fixtures = join(root, "fixtures");
    const linked = [PLANNING.index, `${PLANNING.folder}/TODO.md`];
    const sentinels = linked.map((path, i) => {
      const sentinel = join(root, `sentinel-${String(i)}.txt`);
      writeFileSync(sentinel, "outside the target\n");
      rmSync(join(fixtures, path));
      linkSync(sentinel, join(fixtures, path));
      return sentinel;
    });
    expect(seedPlanning(["--planning"], root)).toBe(0);
    for (const sentinel of sentinels) {
      expect(readFileSync(sentinel, "utf8"), sentinel).toBe("outside the target\n");
    }
    const fresh = buildPlanningFixture();
    expect(readFileSync(join(fixtures, PLANNING.index), "utf8")).toBe(serializeIndex(fresh.index));
    expect(readFileSync(join(fixtures, PLANNING.folder, "TODO.md"), "utf8")).toBe(
      fresh.files.get("TODO.md"),
    );
  });

  test("refuses bad options and an existing fixture, naming no path", () => {
    const out = temp();
    for (const args of [
      ["--planning", "--out", ""],
      ["--planning", "--out", out, "--colour", "red"],
      ["--planning", "--out", out, "extra"],
    ]) {
      expect(seed(args).status, args.join(" ")).toBe(2);
    }
    expect(readdirSync(out)).toEqual([]);
    mkdirSync(join(out, PLANNING.folder));
    const again = seed(["--planning", "--out", out]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already exists");
    expect(again.stderr).not.toContain(out);
    expect(readdirSync(join(out, PLANNING.folder))).toEqual([]);
  }, 60_000);
});
