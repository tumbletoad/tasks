// The property behind resolve() (A1 3.15, R11; M2.07), with an oracle. Random folder trees with
// links that lead inside the root, outside it and nowhere are built by a model of the test's own,
// which knows by construction which directory every path names (it never asks the code under
// test, nor follows a link on the file system to find out). For random relative paths (`..`, `.`,
// case variants, files and missing names included) and two roots (one nested in the other, which
// may itself be a link), resolvePlace must return exactly the reason the model gives, or exactly
// the directory the model names: its identity and its real path. Whatever it returns turns back
// into the place the model expects (the closest root and the path below it). Three wrong
// resolvers fail the same property: one that returns the root for every path, one without the
// containment check, and one that falls back to the parent of a missing folder. The trees are
// real, in a temporary folder per run, with junctions on Windows and symbolic links elsewhere.
//
// Case is the volume's, learnt from the file system, never from the OS name: each world asks
// whether its own folder answers to another spelling. Where names differ only in case they are one
// name (Windows, macOS by default), and the model folds case as the volume does; elsewhere (Linux,
// a case-sensitive folder) they are two. The generator is the same on both, and the property
// counts that each side was exercised: a place whose stored spelling differs in case from the
// folder's own name where the volume folds, and a name with a sibling that differs only in case
// where it keeps them apart.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  isPlacePath,
  placeOf,
  resolvePlace,
  type PlaceRef,
  type Resolution,
  type RootFolder,
} from "../src/places.ts";

const WINDOWS = process.platform === "win32";
const NAMES = ["a", "b", "A", "c d", "e.f"] as const;

type Spec =
  | { readonly kind: "dir"; readonly path: readonly string[] }
  | { readonly kind: "file"; readonly path: readonly string[] }
  | {
      readonly kind: "link";
      readonly path: readonly string[];
      readonly to: "inside" | "outside" | "nowhere";
      readonly target: readonly string[];
    };

const segments = fc.array(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 3 });
const spec: fc.Arbitrary<Spec> = fc.oneof(
  { weight: 4, arbitrary: segments.map((path) => ({ kind: "dir" as const, path })) },
  { weight: 1, arbitrary: segments.map((path) => ({ kind: "file" as const, path })) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("link" as const),
      path: segments,
      to: fc.constantFrom("inside" as const, "outside" as const, "nowhere" as const),
      target: fc.array(fc.constantFrom(...NAMES), { maxLength: 2 }),
    }),
  },
);
const relPath = fc
  .array(fc.constantFrom(...NAMES, "..", ".", "B", "missing"), { maxLength: 4 })
  .map((parts) => parts.join("/"));
/** A world's specs and paths, most of them through what the specs made (links included). */
const worldAndPaths = fc.array(spec, { maxLength: 12 }).chain((specs) => {
  const along =
    specs.length === 0
      ? relPath
      : fc
          .tuple(
            fc.constantFrom(...specs),
            fc.nat(),
            fc.array(fc.constantFrom(...NAMES), { maxLength: 2 }),
          )
          .map(([s, n, extra]) =>
            [...s.path.slice(0, 1 + (n % s.path.length)), ...extra].join("/"),
          );
  const path = fc.oneof({ weight: 3, arbitrary: along }, { weight: 1, arbitrary: relPath });
  return fc.tuple(fc.constant(specs), fc.array(path, { minLength: 1, maxLength: 8 }));
});

// ---------------------------------------------------------------------------------------------
// The model: what each path names, by construction

interface Dir {
  readonly kind: "dir";
  /** Its own name, as it was made. */
  readonly name: string;
  /** Where it was made: a path of plain folders only, so its real path by construction. */
  readonly phys: string;
  readonly parent: Dir | undefined;
  readonly children: Map<string, Node>;
}
type Node =
  | Dir
  | { readonly kind: "file"; readonly name: string }
  | {
      readonly kind: "link";
      readonly name: string;
      readonly base: Dir | undefined;
      readonly segs: readonly string[];
    };

/** How a walk met case: the spelling it was given against the names it found. */
interface Spelling {
  /** A name was found under another case than it was given (a case-folding volume). */
  otherCase: boolean;
  /** A name was looked up beside a sibling that differs from it only in case (a case-keeping one). */
  caseApart: boolean;
}

class World {
  readonly base: string;
  readonly work: Dir;
  readonly outside: Dir;
  /** Whether names that differ only in case are one name here: asked of the volume itself. */
  readonly folds: boolean;
  constructor(base: string) {
    this.base = base;
    this.work = {
      kind: "dir",
      name: "work",
      phys: join(base, "work"),
      parent: undefined,
      children: new Map(),
    };
    this.outside = {
      kind: "dir",
      name: "outside",
      phys: join(base, "outside"),
      parent: undefined,
      children: new Map(),
    };
    mkdirSync(this.work.phys);
    mkdirSync(this.outside.phys);
    this.folds = idOrUndefined(join(base, "WORK")) === idOf(this.work.phys);
  }

  /** A name as the volume tells names apart: case-folded where names differ only in case. */
  key(name: string): string {
    return this.folds ? name.toLowerCase() : name;
  }

  /** The plain folder at `segs` below `from`, made as needed; undefined where a file or a link is. */
  ensure(from: Dir, segs: readonly string[]): Dir | undefined {
    let at = from;
    for (const name of segs) {
      const found = at.children.get(this.key(name));
      if (found === undefined) {
        const made: Dir = {
          kind: "dir",
          name,
          phys: join(at.phys, name),
          parent: at,
          children: new Map(),
        };
        mkdirSync(made.phys);
        at.children.set(this.key(name), made);
        at = made;
      } else if (found.kind === "dir") at = found;
      else return undefined;
    }
    return at;
  }

  /** Adds one spec; a spec whose name is taken, or whose parent is not a plain folder, is skipped. */
  add(s: Spec): void {
    const parent = this.ensure(this.work, s.path.slice(0, -1));
    const name = s.path[s.path.length - 1] ?? "";
    if (parent === undefined || parent.children.has(this.key(name))) return;
    const phys = join(parent.phys, name);
    if (s.kind === "dir") {
      this.ensure(parent, [name]);
    } else if (s.kind === "file") {
      writeFileSync(phys, "x");
      parent.children.set(this.key(name), { kind: "file", name });
    } else {
      const base = s.to === "inside" ? this.work : s.to === "outside" ? this.outside : undefined;
      // A link's target is made as plain folders where it can be; whatever is in the way decides
      // what the link leads to, and the model follows it the same way. Making the target may take
      // the link's own name: then there is no link.
      if (base !== undefined) this.ensure(base, s.target);
      if (parent.children.has(this.key(name))) return;
      const target =
        base === undefined ? join(this.base, "nowhere", ...s.target) : join(base.phys, ...s.target);
      symlinkSync(target, phys, WINDOWS ? "junction" : "dir");
      parent.children.set(this.key(name), { kind: "link", name, base, segs: s.target });
    }
  }

  /**
   * What `segs` below `from` names, following links as stat does: a node, or missing. `spelling`
   * notes how the given names met case on the way (a link's own target is not counted).
   */
  walk(
    from: Dir,
    segs: readonly string[],
    hops = 0,
    spelling?: Spelling,
  ): Dir | { kind: "file" } | "missing" {
    let at: Node = from;
    for (const name of segs) {
      const dir = this.follow(at, hops);
      if (dir === "missing" || dir.kind !== "dir") return "missing";
      const child = dir.children.get(this.key(name));
      if (spelling !== undefined) {
        if (child !== undefined && child.name !== name) spelling.otherCase = true;
        // Keys are names where the volume keeps case: a sibling equal but for case is another one.
        for (const sibling of this.folds ? [] : dir.children.keys()) {
          if (sibling !== name && sibling.toLowerCase() === name.toLowerCase()) {
            spelling.caseApart = true;
          }
        }
      }
      if (child === undefined) return "missing";
      at = child;
    }
    return this.follow(at, hops);
  }

  private follow(node: Node, hops: number): Dir | { kind: "file" } | "missing" {
    if (node.kind !== "link") return node;
    if (node.base === undefined || hops > 32) return "missing";
    return this.walk(node.base, node.segs, hops + 1);
  }
}

/** Whether `dir` is `root` or below it, by the model's parents. */
function within(dir: Dir, root: Dir): boolean {
  for (let at: Dir | undefined = dir; at !== undefined; at = at.parent) {
    if (at === root) return true;
  }
  return false;
}

/** The root folders of a world: `work`, and `nested` at `work/a` (whatever that is). */
const rootsOf = (world: World): RootFolder[] => [
  { id: "work", path: world.work.phys },
  { id: "nested", path: join(world.work.phys, "a") },
];

/** The model's root directory of a root ID, or undefined when it is no folder. */
function rootDir(world: World, id: string): Dir | undefined {
  if (id === "work") return world.work;
  const found = world.walk(world.work, ["a"]);
  return found !== "missing" && found.kind === "dir" ? found : undefined;
}

type Expected =
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "ok"; readonly dir: Dir };

/** What resolvePlace must return, by the model alone; `spelling` notes how the path met case. */
function expected(world: World, id: string, path: string, spelling?: Spelling): Expected {
  if (!isPlacePath(path)) return { status: "failed", reason: "invalid_path" };
  const root = rootDir(world, id);
  if (root === undefined) return { status: "failed", reason: "root_unavailable" };
  const found = world.walk(root, path === "" ? [] : path.split("/"), 0, spelling);
  if (found === "missing") return { status: "failed", reason: "path_missing" };
  if (found.kind !== "dir") return { status: "failed", reason: "not_a_directory" };
  if (!within(found, root)) return { status: "failed", reason: "escapes_root" };
  return { status: "ok", dir: found };
}

/** The identity of a directory made at `phys`, as text. */
function idOf(phys: string): string {
  const s = statSync(phys, { bigint: true });
  return `${String(s.dev)}:${String(s.ino)}`;
}

/** The identity of what `path` names, or undefined when it names nothing. */
function idOrUndefined(path: string): string | undefined {
  try {
    return idOf(path);
  } catch {
    return undefined;
  }
}

/** How many plain folders deep a model directory lies (its distance from the world's top). */
function depthOf(dir: Dir): number {
  let n = 0;
  for (let at = dir.parent; at !== undefined; at = at.parent) n += 1;
  return n;
}

/** The relative path from `root` down to `dir`, by the model's parents (`dir` is within it). */
function relOf(dir: Dir, root: Dir): string {
  const names: string[] = [];
  for (let at: Dir | undefined = dir; at !== undefined && at !== root; at = at.parent) {
    names.unshift(at.name);
  }
  return names.join("/");
}

type Resolver = (place: PlaceRef, roots: readonly RootFolder[]) => Promise<Resolution>;

/** What the property met, for the caller to see that each side of case was exercised. */
type Tally = Map<string, number>;
const bump = (tally: Tally | undefined, k: string): void => {
  tally?.set(k, (tally.get(k) ?? 0) + 1);
};

/**
 * The property, for a resolver: on each world and each path, the resolver's answer is the
 * model's, and an answer of a folder turns back into the place the model expects.
 */
function property(resolve: Resolver, tally?: Tally) {
  return fc.asyncProperty(worldAndPaths, async ([specs, paths]) => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "tasks-places-prop-")));
    try {
      const world = new World(base);
      for (const s of specs) world.add(s);
      bump(tally, world.folds ? "volume_folds_case" : "volume_keeps_case");
      const roots = rootsOf(world);
      for (const given of paths) {
        for (const id of ["work", "nested"]) {
          // Below the nested root, the same path without its leading `a`.
          const [head, ...rest] = given.split("/");
          const path =
            id === "nested" && head !== undefined && world.key(head) === "a"
              ? rest.join("/")
              : given;
          const spelling: Spelling = { otherCase: false, caseApart: false };
          const want = expected(world, id, path, spelling);
          if (spelling.caseApart) bump(tally, "case_apart");
          if (spelling.otherCase && want.status === "ok") bump(tally, "ok_in_other_case");
          const got = await resolve({ root: id, path }, roots);
          if (want.status === "failed") {
            expect([id, path, got]).toEqual([
              id,
              path,
              { status: "failed", reason: want.reason, root: id },
            ]);
            continue;
          }
          expect([id, path, got.status]).toEqual([id, path, "ok"]);
          if (got.status !== "ok") continue;
          // Exactly the directory the model names: its identity and its real path.
          expect([id, path, `${String(got.identity.dev)}:${String(got.identity.ino)}`]).toEqual([
            id,
            path,
            idOf(want.dir.phys),
          ]);
          expect([id, path, got.folder]).toEqual([id, path, want.dir.phys]);
          // Back to a place: the closest root holding the directory, by the model.
          const holders = (["work", "nested"] as const)
            .map((r) => ({ r, dir: rootDir(world, r) }))
            .filter((h): h is { r: "work" | "nested"; dir: Dir } => h.dir !== undefined)
            .filter((h) => within(want.dir, h.dir));
          const deepest = Math.max(...holders.map((h) => depthOf(h.dir)));
          const closest = holders.filter((h) => depthOf(h.dir) === deepest);
          const back = await placeOf(got.folder, roots);
          if (closest.length > 1) {
            expect(back).toMatchObject({ status: "failed", reason: "ambiguous_root" });
            continue;
          }
          const [best] = closest;
          if (best === undefined) throw new Error("the model lost the root it resolved under");
          expect([id, path, back]).toMatchObject([
            id,
            path,
            { status: "ok", root: best.r, path: relOf(want.dir, best.dir) },
          ]);
        }
      }
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
}

const link = (path: string[], to: "inside" | "outside" | "nowhere", target: string[]): Spec => ({
  kind: "link",
  path,
  to,
  target,
});
const file = (path: string[]): Spec => ({ kind: "file", path });
const dir = (path: string[]): Spec => ({ kind: "dir", path });

/**
 * Worlds that once failed on Windows, shrunk from the seeds 1802256153, -24590030, 591581345,
 * -287201831, -1371263580 and 729078548: a link whose target is a file (a junction to a file,
 * which Windows cannot follow, so its stat says the path is missing). The model says
 * `not_a_directory`, as Linux does, and so must the resolver. Run first, before the random worlds.
 */
const LINK_TO_FILE: [[Spec[], string[]]][] = [
  [[[file(["c d", "e.f"]), link(["a"], "inside", ["c d", "e.f"])], ["a"]]],
  [[[file(["c d", "a"]), link(["a"], "inside", ["c d", "a"])], ["a"]]],
  // On Windows `e.f/a` is the file `e.f/A`; elsewhere the model makes it a folder.
  [
    [
      [file(["e.f", "A"]), link(["c d", "a"], "inside", ["e.f", "a"])],
      ["c d/a", "c d"],
    ],
  ],
  [
    [
      [file(["a", "e.f"]), link(["a", "a"], "inside", ["a", "e.f"])],
      ["a/a", "a"],
    ],
  ],
  [
    [
      [file(["c d"]), link(["e.f", "b"], "inside", ["c d"])],
      ["e.f/b", "A"],
    ],
  ],
  // Seed 729078548. Where the volume folds case, the link `A` is not made beside the folder `a`
  // (one name), the folder `A/b` is `a/b`, and the link `a/c d` leads to `c d/A`, the file
  // `c d/a`: below the nested root `c d` is a junction to a file. Where the volume keeps case, `A`
  // is a link of its own beside `a`, so neither `A/b` nor the link `A/c d` is made (a link is no
  // parent), and `c d` below the nested root is missing.
  [
    [
      [
        dir(["a", "e.f"]),
        link(["b"], "inside", []),
        link(["A"], "outside", ["b"]),
        dir(["A", "b"]),
        link(["e.f", "c d"], "nowhere", ["b"]),
        file(["c d", "a"]),
        link(["A", "c d"], "inside", ["c d", "A"]),
      ],
      ["c d", ""],
    ],
  ],
];

/**
 * One world that meets every outcome and both sides of case by construction, so the counts below
 * never rest on what the random worlds happen to reach: a folder `a` beside `A` (one name where the
 * volume folds case, two where it keeps it), a file, a link out of the root, a missing name and an
 * invalid path.
 */
const EVERY_OUTCOME: [[Spec[], string[]]] = [
  [
    [dir(["a"]), dir(["A"]), file(["c d"]), link(["b"], "outside", [])],
    ["", "A", "a", "b", "c d", "missing", ".."],
  ],
];

describe("[A1.3.15.places.prop] resolve returns exactly the directory a model of the tree names, or its reason", () => {
  test("random trees with links, random paths, checked against the model", async () => {
    // The real resolver, counting its outcomes, and how the model met case.
    const seen = new Map<string, number>();
    const met: Tally = new Map();
    const counting: Resolver = async (place, roots) => {
      const r = await resolvePlace(place, roots);
      const k = r.status === "ok" ? "ok" : r.reason;
      seen.set(k, (seen.get(k) ?? 0) + 1);
      return r;
    };
    // fast-check counts the examples among the runs: 100 random worlds still run after them.
    const examples = [EVERY_OUTCOME, ...LINK_TO_FILE];
    await fc.assert(property(counting, met), { numRuns: 100 + examples.length, examples });
    // Every outcome was met, so the property is not met by trees that never escape.
    for (const outcome of [
      "ok",
      "escapes_root",
      "path_missing",
      "not_a_directory",
      "invalid_path",
    ]) {
      expect([outcome, (seen.get(outcome) ?? 0) > 0]).toEqual([outcome, true]);
    }
    // Case was exercised on the volume's own terms: where it folds case, a stored spelling in
    // another case resolved to the folder's own name; where it keeps case, a name was told apart
    // from a sibling that differs only in case. One temporary folder answers one way.
    const folds = (met.get("volume_folds_case") ?? 0) > 0;
    expect([folds, (met.get("volume_keeps_case") ?? 0) > 0]).toEqual([folds, !folds]);
    const exercised = folds ? "ok_in_other_case" : "case_apart";
    expect([exercised, (met.get(exercised) ?? 0) > 0]).toEqual([exercised, true]);
  }, 240_000);

  test("three wrong resolvers fail the same property", async () => {
    // Every path resolves to the root.
    const rootOnly: Resolver = async (place, roots) => {
      const found = await resolvePlace({ ...place, path: "" }, roots);
      return isPlacePath(place.path) ? found : resolvePlace(place, roots);
    };
    // No containment check: a folder outside the root is returned as the place's folder.
    const noContainment: Resolver = async (place, roots) => {
      const found = await resolvePlace(place, roots);
      if (found.status !== "failed" || found.reason !== "escapes_root") return found;
      const root = roots.find((r) => r.id === place.root)?.path ?? "";
      const folder = realpathSync.native(join(root, ...place.path.split("/")));
      const s = statSync(folder, { bigint: true });
      const identity = { dev: s.dev, ino: s.ino };
      return {
        status: "ok",
        root: place.root,
        folder,
        identity,
        check: { dev: "", ino: "", rootDev: "", rootIno: "", depth: 0 },
        remote: { status: "none" },
      };
    };
    // A missing folder falls back to its parent.
    const parentFallback: Resolver = async (place, roots) => {
      const found = await resolvePlace(place, roots);
      if (found.status !== "failed" || found.reason !== "path_missing") return found;
      const up = place.path.split("/").slice(0, -1).join("/");
      return resolvePlace({ ...place, path: up }, roots);
    };
    for (const [name, wrong] of [
      ["root for every path", rootOnly],
      ["no containment check", noContainment],
      ["parent of a missing folder", parentFallback],
    ] as const) {
      const outcome = await fc.check(property(wrong), {
        numRuns: 120,
        endOnFailure: true,
        examples: [EVERY_OUTCOME],
      });
      expect([name, outcome.failed]).toEqual([name, true]);
    }
  }, 240_000);
});
