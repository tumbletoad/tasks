// The projection against a model of what may happen to it (A1 3.13 rule 10): random sequences of
// commits, a person's acts in the tree (an edit of a generated file, a file of theirs at a generated
// path and elsewhere, a deleted generated file, a folder replaced by a file or a link, a hard link
// to a file outside, text where the old control files were, files with temporary-looking names, a
// rescue folder swapped for a link, during a batch too), and a kill at any act of a start or a
// batch, each followed by a restart. After every step:
//
// 1. every byte a person put in the tree still exists, at its path or in a rescue folder, with
//    its mode unchanged;
// 2. what the projection does creates, changes or removes nothing outside the tree and the rescue
//    folders it makes, and nothing in a rescue folder made before;
// 3. the watermark covers no task whose file is not on disk (tasks whose files the person touched
//    excepted, until the projection has been at rest since);
// 4. the projection never moves its own files aside;
// 5. at rest (after a restart and its reconciliation, with nothing left to do), the generated files
//    equal a fresh render and every path the catalogue names exists.
//
// Fixture text only; every person's text carries a marker, so the model finds it wherever it is.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Projector, ProjectorOptions } from "../src/index.ts";
import { checkWatermark, killAt, Killed, settle, treeOf, world, type World } from "./helpers.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "projection-model-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const LINK = process.platform === "win32" ? "junction" : "dir";
const MARK = "Person ";
const FOLDERS = ["open", "completed", "completed/2026"] as const;

type During = "none" | "open-link" | "view-link";

type Action =
  | { readonly kind: "create"; readonly squat: boolean }
  | { readonly kind: "rename" | "summary" | "complete" | "reopen"; readonly pick: number }
  | {
      readonly kind: "run";
      readonly steps: number;
      readonly killAt: number | null;
      readonly during: During;
    }
  | { readonly kind: "restart" | "rebuild"; readonly killAt: number | null }
  | { readonly kind: "edit" | "replace" | "delete"; readonly pick: number }
  | { readonly kind: "hardlink"; readonly pick: number; readonly same: boolean }
  | { readonly kind: "elsewhere" | "decoy"; readonly which: number }
  | { readonly kind: "folder-file" | "folder-link"; readonly which: number }
  | { readonly kind: "swap-rescue" | "swap-rescued-root" | "rest" };

const kill = fc.option(fc.integer({ min: 1, max: 40 }), { nil: null, freq: 3 });
const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("create" as const), squat: fc.boolean() }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constantFrom(
        "rename" as const,
        "summary" as const,
        "complete" as const,
        "reopen" as const,
      ),
      pick: fc.nat(),
    }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant("run" as const),
      steps: fc.integer({ min: 1, max: 3 }),
      killAt: kill,
      during: fc.constantFrom<During>("none", "none", "none", "open-link", "view-link"),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constantFrom("restart" as const, "rebuild" as const),
      killAt: kill,
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constantFrom("edit" as const, "replace" as const, "delete" as const),
      pick: fc.nat(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("hardlink" as const),
      pick: fc.nat(),
      same: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constantFrom("elsewhere" as const, "decoy" as const),
      which: fc.nat({ max: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constantFrom("folder-file" as const, "folder-link" as const),
      which: fc.nat({ max: 2 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constantFrom("swap-rescue" as const, "swap-rescued-root" as const, "rest" as const),
    }),
  },
);

const hash = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const modeOf = (path: string): number => statSync(path).mode & 0o777;

interface Entry {
  readonly type: "file" | "dir" | "link" | "other";
  readonly mode: number;
  readonly hash?: string;
}

/** Every entry under `dir` by its path below it; links are listed, never followed. */
function walk(dir: string, skip: (rel: string) => boolean = () => false): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const visit = (abs: string, rel: string): void => {
    const stats = lstatSync(abs, { throwIfNoEntry: false });
    if (stats === undefined) return;
    if (rel !== "" && skip(rel)) return;
    const mode = stats.mode & 0o777;
    if (stats.isDirectory()) {
      if (rel !== "") out.set(rel, { type: "dir", mode });
      for (const name of readdirSync(abs))
        visit(join(abs, name), rel === "" ? name : `${rel}/${name}`);
    } else if (stats.isFile()) {
      out.set(rel, { type: "file", mode, hash: hash(readFileSync(abs)) });
    } else {
      out.set(rel, { type: stats.isSymbolicLink() ? "link" : "other", mode });
    }
  };
  visit(dir, "");
  return out;
}

/** Every regular file's text under `dir`, by its path below it; links never followed. */
function texts(dir: string): Map<string, { text: string; mode: number }> {
  const out = new Map<string, { text: string; mode: number }>();
  for (const [rel, entry] of walk(dir)) {
    if (entry.type !== "file") continue;
    out.set(rel, { text: readFileSync(join(dir, ...rel.split("/")), "utf8"), mode: entry.mode });
  }
  return out;
}

/** Moves a folder; Windows refuses for a moment while a scanner holds a file just written in it. */
function move(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (attempt >= 50 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/** One run of the model on a fresh space. */
class Model {
  readonly w: World;
  readonly outside: string;
  readonly hidden: string;
  /** What the person wrote, by its text: each must stay findable, with its mode. */
  readonly artifacts = new Map<string, number>();
  /** Bytes the person's own entries hold that equal generated bytes (a hard link to a copy). */
  readonly theirs = new Set<string>();
  /** Where the person put such a hard link in the tree: an entry of theirs, never the projection's. */
  readonly theirLinks = new Set<string>();
  /** Tasks whose files the person touched since the projection was last at rest. */
  readonly disturbed = new Set<string>();
  /** The person touched a folder or a root file: no claim is checked until the next rest. */
  all = false;
  projector: Projector | undefined;
  n = 0;
  created = 0;

  constructor(w: World, folder: string) {
    this.w = w;
    this.outside = join(folder, "outside");
    this.hidden = join(folder, "outside-rescue");
    for (const dir of [this.outside, this.hidden]) {
      mkdirSync(dir);
      writeFileSync(join(dir, "canary.txt"), "Outside the tree: never touched.\n");
    }
  }

  get view(): string {
    return this.w.dir;
  }

  get exchange(): string {
    return join(this.w.folder, "exchange");
  }

  personText(): string {
    this.n += 1;
    return `${MARK}${String(this.n)}: my own words, not the projection's.\n`;
  }

  /** The person writes `text` at `abs`, making it theirs: their file, their mode. */
  write(abs: string, text: string): void {
    this.forget(abs);
    if (existsSync(abs)) chmodSync(abs, 0o600);
    writeFileSync(abs, text);
    this.artifacts.set(text, modeOf(abs));
  }

  /** The person overwrites or removes a file at `abs`: words of theirs in it are theirs to lose. */
  forget(abs: string): void {
    if (lstatSync(abs, { throwIfNoEntry: false })?.isFile() !== true) return;
    this.artifacts.delete(readFileSync(abs, "utf8"));
  }

  realFolder(abs: string): boolean {
    return lstatSync(abs, { throwIfNoEntry: false })?.isDirectory() === true;
  }

  /** The generated task files the trusted record names, with their tasks. */
  generated(): { path: string; task: string }[] {
    if (!existsSync(this.w.record)) return [];
    const record = JSON.parse(readFileSync(this.w.record, "utf8")) as {
      entries: Record<string, { path: string }>;
    };
    return Object.entries(record.entries)
      .map(([task, entry]) => ({ path: entry.path, task }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /** A generated file on disk, reached through real folders, or undefined. */
  pickFile(pick: number): { path: string; task: string; abs: string } | undefined {
    const files = this.generated().filter(({ path }) => {
      const parts = path.split("/");
      for (let i = 0; i < parts.length; i += 1) {
        if (!this.realFolder(join(this.view, ...parts.slice(0, i)))) return false;
      }
      return lstatSync(join(this.view, ...parts), { throwIfNoEntry: false })?.isFile() === true;
    });
    const found = files[pick % Math.max(1, files.length)];
    return found === undefined
      ? undefined
      : { ...found, abs: join(this.view, ...found.path.split("/")) };
  }

  ids(lifecycle: "active" | "completed"): string[] {
    return this.w.reader
      .prepare("SELECT id FROM tasks WHERE lifecycle = $l ORDER BY ref")
      .all<{ id: string }>({ l: lifecycle })
      .map((row) => row.id);
  }

  // ------------------------------------------------------------------------------------------
  // The projection's acts, each checked against invariant 2.

  /** The kill armed for the projection's current act, if any. */
  killer: ReturnType<typeof killAt> | undefined;
  /** A person's act run once while a batch waits on the writer. */
  during: (() => void) | undefined;
  /** The state outside the tree the projection's current act is checked against. */
  baseline: Map<string, Entry> | undefined;

  /** A projector as the service makes one, its acts and its writer watched by the model. */
  newProjector(): Projector {
    const w = this.w;
    const refuse = (): Promise<never> => Promise.reject(new Killed());
    const options: Partial<ProjectorOptions> = {
      at: (act, path) => {
        this.killer?.hook(act, path);
      },
      writer: {
        projected: (batch) => {
          if (this.killer?.dead() === true) return refuse();
          const answer = w.writer.projected(batch);
          const during = this.during;
          this.during = undefined;
          during?.();
          return Promise.resolve(answer);
        },
        queueProjection: (keys) =>
          this.killer?.dead() === true ? refuse() : Promise.resolve(w.writer.queueProjection(keys)),
      },
    };
    return w.projector(options);
  }

  get current(): Projector {
    if (this.projector === undefined) throw new Error("no projector");
    return this.projector;
  }

  /**
   * Runs `work` as the projection, with a kill at its `at`-th act if one is armed, and checks
   * invariant 2 around it. A kill ends in a restart, as the service's next start would be.
   */
  async act(work: () => Promise<void>, at: number | null = null): Promise<void> {
    this.baseline = this.outsideState();
    this.killer = at === null ? undefined : killAt(at);
    try {
      await work();
    } catch (error) {
      if (this.killer?.dead() !== true) throw error;
    }
    const killed = this.killer?.dead() === true;
    if (killed) seen.kills += 1;
    this.killer = undefined;
    this.during = undefined;
    if (killed) {
      this.projector = this.newProjector();
      await this.projector.start();
    }
    this.checkOutside(this.baseline);
    this.baseline = undefined;
  }

  async restart(at: number | null): Promise<void> {
    await this.act(async () => {
      this.projector = this.newProjector();
      await this.projector.start();
    }, at);
  }

  async run(steps: number, at: number | null, during: During): Promise<void> {
    if (during !== "none") {
      this.during = () => {
        const target = during === "open-link" ? join(this.view, "open") : this.view;
        if (!this.realFolder(target)) return;
        // What the projection did so far is checked; the person's act then changes the baseline.
        if (this.baseline !== undefined) this.checkOutside(this.baseline);
        this.all = true;
        const away = join(this.outside, `${during}-${String((this.n += 1))}`);
        move(target, away);
        symlinkSync(away, target, LINK);
        seen.during += 1;
        this.baseline = this.outsideState();
      };
    }
    await this.act(async () => {
      for (let i = 0; i < steps && this.current.pending().dirty; i += 1) await this.current.step();
    }, at);
  }

  async rebuild(at: number | null): Promise<void> {
    await this.act(async () => {
      this.current.rebuild();
      await this.current.step();
    }, at);
  }

  /** What lies outside the tree and the rescue folders made since `before`. */
  outsideState(): Map<string, Entry> {
    const state = new Map<string, Entry>();
    for (const [rel, entry] of walk(this.outside)) state.set(`outside/${rel}`, entry);
    for (const [rel, entry] of walk(this.hidden)) state.set(`hidden/${rel}`, entry);
    const top = /^(view|space\.db.*|writer\.lock)$/;
    for (const [rel, entry] of walk(this.w.folder, (r) => top.test(r))) {
      state.set(`space/${rel}`, entry);
    }
    return state;
  }

  /** Invariant 2: only new rescue folders appeared; nothing else changed. */
  checkOutside(before: Map<string, Entry>): void {
    const after = this.outsideState();
    for (const [key, entry] of before) expect(after.get(key), key).toEqual(entry);
    const tops = new Set(
      [...before.keys()]
        .filter((key) => key.startsWith("space/exchange/rescued/"))
        .map((key) => key.split("/")[3]),
    );
    for (const key of after.keys()) {
      if (before.has(key)) continue;
      const parts = key.split("/");
      const fresh =
        key === "space/exchange" ||
        key === "space/exchange/rescued" ||
        (parts[1] === "exchange" && parts[2] === "rescued" && !tops.has(parts[3]));
      expect(fresh, `${key} appeared outside the tree`).toBe(true);
    }
  }

  // ------------------------------------------------------------------------------------------
  // The person's acts.

  disturb(task: string | undefined): void {
    if (task === undefined) this.all = true;
    else this.disturbed.add(task);
  }

  person(a: Action): void {
    switch (a.kind) {
      case "edit": {
        const file = this.pickFile(a.pick);
        if (file === undefined) return;
        this.disturb(file.task);
        this.write(file.abs, this.personText());
        return;
      }
      case "replace": {
        const file = this.pickFile(a.pick);
        if (file === undefined) return;
        this.disturb(file.task);
        this.forget(file.abs);
        chmodSync(file.abs, 0o600);
        rmSync(file.abs);
        this.write(file.abs, this.personText());
        return;
      }
      case "delete": {
        const file = this.pickFile(a.pick);
        if (file === undefined) return;
        this.disturb(file.task);
        this.forget(file.abs);
        chmodSync(file.abs, 0o600);
        rmSync(file.abs);
        return;
      }
      case "hardlink": {
        const file = this.pickFile(a.pick);
        if (file === undefined) return;
        this.disturb(file.task);
        const away = join(this.outside, `hard-${String((this.n += 1))}.md`);
        if (a.same) {
          const bytes = readFileSync(file.abs, "utf8");
          writeFileSync(away, bytes);
          this.theirs.add(bytes);
          this.theirLinks.add(file.path);
        } else {
          const text = this.personText();
          writeFileSync(away, text);
          this.artifacts.set(text, modeOf(away));
        }
        this.forget(file.abs);
        chmodSync(file.abs, 0o600);
        rmSync(file.abs);
        linkSync(away, file.abs);
        seen.hardlinks += 1;
        return;
      }
      case "elsewhere": {
        const n = String((this.n += 1));
        const places = [
          ["", `notes-${n}.txt`],
          ["open", `notes-${n}.txt`],
          [`mine-${n}`, "note.txt"],
          ["open", `M-${n}-mine.md`],
        ] as const;
        const [folder, name] = places[a.which % places.length] ?? places[0];
        if (!this.realFolder(this.view)) return;
        const dir = join(this.view, folder);
        if (!existsSync(dir)) mkdirSync(dir);
        if (!this.realFolder(dir)) return;
        this.write(join(dir, name), this.personText());
        return;
      }
      case "decoy": {
        if (!this.realFolder(this.view)) return;
        const tag = createHash("sha256").update(String(this.n)).digest("hex");
        const names = [
          ".projection-files.json",
          ".projection-journal.json",
          `open/.M-1-mine.md.${tag.slice(0, 32)}.${tag.slice(32, 40)}.tmp`,
          `.index.md.tmp-${tag.slice(0, 16)}`,
        ];
        const name = names[a.which % names.length] ?? "";
        const abs = join(this.view, ...name.split("/"));
        if (name.startsWith("open/")) {
          const open = join(this.view, "open");
          if (!existsSync(open)) mkdirSync(open);
          if (!this.realFolder(open)) return;
        }
        if (existsSync(abs)) return;
        this.write(abs, this.personText());
        return;
      }
      case "folder-file":
      case "folder-link": {
        const rel = FOLDERS[a.which % FOLDERS.length] ?? "open";
        const abs = join(this.view, ...rel.split("/"));
        if (!this.realFolder(abs)) return;
        this.all = true;
        const away = join(this.outside, `${a.kind}-${String((this.n += 1))}`);
        move(abs, away);
        seen.folders += 1;
        if (a.kind === "folder-link") symlinkSync(away, abs, LINK);
        else this.write(abs, this.personText());
        return;
      }
      case "swap-rescue": {
        const rescued = join(this.exchange, "rescued");
        if (!this.realFolder(rescued)) return;
        const newest = readdirSync(rescued)
          .filter((name) => this.realFolder(join(rescued, name)) && !name.endsWith("-kept"))
          .sort()
          .at(-1);
        if (newest === undefined) return;
        move(join(rescued, newest), join(rescued, `${newest}-kept`));
        symlinkSync(this.hidden, join(rescued, newest), LINK);
        seen.swaps += 1;
        return;
      }
      case "swap-rescued-root": {
        const rescued = join(this.exchange, "rescued");
        if (!this.realFolder(rescued)) return;
        move(rescued, join(this.exchange, `rescued-kept-${String((this.n += 1))}`));
        symlinkSync(this.hidden, rescued, LINK);
        seen.swaps += 1;
        return;
      }
      default:
        return;
    }
  }

  commit(a: Action): void {
    const w = this.w;
    if (a.kind === "create") {
      this.created += 1;
      const title = `Model ${String(this.created)}`;
      if (a.squat && this.realFolder(this.view)) {
        // A file of the person's where the new task's file will go.
        const next = Number(w.reader.prepare("SELECT max(ref) + 1 AS r FROM tasks").get()?.["r"]);
        const open = join(this.view, "open");
        if (!existsSync(open)) mkdirSync(open);
        if (this.realFolder(open)) {
          this.write(
            join(open, `M-${String(next)}-model-${String(this.created)}.md`),
            this.personText(),
          );
        }
      }
      w.submit([{ kind: "task.create", title }]);
      return;
    }
    if (
      a.kind !== "rename" &&
      a.kind !== "summary" &&
      a.kind !== "complete" &&
      a.kind !== "reopen"
    ) {
      return;
    }
    const pool = this.ids(a.kind === "reopen" ? "completed" : "active");
    const task = pool[a.pick % Math.max(1, pool.length)];
    if (task === undefined) return;
    this.n += 1;
    if (a.kind === "rename") {
      w.submit([{ kind: "task.patch", task, set: { title: `Renamed ${String(this.n)}` } }]);
    } else if (a.kind === "summary") {
      w.submit([{ kind: "task.patch", task, set: { summary: `Summary ${String(this.n)}` } }]);
    } else if (a.kind === "complete") w.submit([{ kind: "task.complete", task }]);
    else w.submit([{ kind: "task.reopen", task }]);
  }

  // ------------------------------------------------------------------------------------------
  // Invariants 1, 3 and 4, after every step.

  /** Every text of the person's, wherever it is now: the tree, the exchange folder, outside. */
  findable(): Map<string, number[]> {
    const found = new Map<string, number[]>();
    for (const dir of [this.view, this.exchange, this.outside, this.hidden]) {
      for (const { text, mode } of texts(dir).values()) {
        found.set(text, [...(found.get(text) ?? []), mode]);
      }
    }
    return found;
  }

  check(): void {
    // 1. The person's bytes, each with its mode.
    const found = this.findable();
    for (const [text, mode] of this.artifacts) {
      expect(found.get(text), `${text.trim()} still exists`).toBeDefined();
      expect(found.get(text), `${text.trim()} keeps its mode`).toContain(mode);
    }
    // 4. Only the person's entries are ever moved aside.
    for (const [rel, { text }] of texts(this.exchange)) {
      expect(text.startsWith(MARK) || this.theirs.has(text), `${rel} is the person's`).toBe(true);
    }
    // 3. The claim, where nobody touched what it covers.
    if (!this.all) checkWatermark(this.view, this.w.reader, this.disturbed);
  }

  /** 5. At rest: a restart, its reconciliation, nothing left to do. */
  async rest(): Promise<void> {
    // The person undoes a swapped rescue folder first: no rescue could happen through it.
    const rescued = join(this.exchange, "rescued");
    if (lstatSync(rescued, { throwIfNoEntry: false })?.isSymbolicLink() === true) rmSync(rescued);
    await this.act(async () => {
      this.projector = this.newProjector();
      await this.projector.start();
      await settle(this.projector, 400);
    });
    this.all = false;
    this.disturbed.clear();
    this.check();
    checkWatermark(this.view, this.w.reader);
    seen.rests += 1;
    const fresh = await this.w.fresh(join(this.w.folder, "..", `fresh-${String((this.n += 1))}`));
    const tree = treeOf(this.view);
    for (const [path, text] of fresh) expect(tree.get(path), path).toBe(text);
    for (const [path, text] of tree) {
      if (fresh.has(path)) continue;
      const theirs = text.startsWith(MARK) || this.theirLinks.has(path);
      expect(theirs, `${path} is the person's`).toBe(true);
    }
  }

  async apply(a: Action): Promise<void> {
    switch (a.kind) {
      case "create":
      case "rename":
      case "summary":
      case "complete":
      case "reopen":
        this.commit(a);
        return;
      case "run":
        await this.run(a.steps, a.killAt, a.during);
        return;
      case "restart":
        await this.restart(a.killAt);
        return;
      case "rebuild":
        await this.rebuild(a.killAt);
        return;
      case "rest":
        await this.rest();
        return;
      default:
        this.person(a);
    }
  }
}

let runs = 0;

/** What the runs reached: a fixed seed must reach each often enough to mean something. */
const seen = { kills: 0, during: 0, hardlinks: 0, folders: 0, swaps: 0, rescued: 0, rests: 0 };
const LEAST = {
  kills: 40,
  during: 20,
  hardlinks: 10,
  folders: 15,
  swaps: 8,
  rescued: 100,
  rests: 70,
};

async function run(actions: readonly Action[]): Promise<void> {
  runs += 1;
  const folder = join(root, `run-${String(runs)}`);
  mkdirSync(folder);
  const w = await world(folder, 6);
  try {
    const model = new Model(w, folder);
    await model.restart(null);
    await model.act(async () => {
      await settle(model.current);
    });
    model.check();
    for (const a of actions) {
      await model.apply(a);
      model.check();
    }
    await model.rest();
    // What was moved aside in this run: one folder per rescue, wherever the person put them.
    for (const [rel, entry] of walk(model.exchange)) {
      if (entry.type === "dir" && /(^|\/)[0-9]{8}T[0-9]{9}Z-[0-9a-f]{4}-[0-9]+$/.test(rel)) {
        seen.rescued += 1;
      }
    }
  } finally {
    w.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe("[A1.5.projection.model] commits, a person's acts in the tree and kills at every act, against the projection's invariants", () => {
  test("no byte of a person's is lost or changed in mode, nothing outside is touched, the watermark covers only files on disk, and at rest the tree is a fresh render", async () => {
    const property = fc.asyncProperty(fc.array(action, { minLength: 4, maxLength: 20 }), run);
    // A fixed seed, whose runs must reach each kind of trouble often, then fresh random runs.
    await fc.assert(property, { numRuns: 60, seed: 20261114 });
    for (const [what, least] of Object.entries(LEAST)) {
      expect(seen[what as keyof typeof seen], `${what}: ${JSON.stringify(seen)}`).toBeGreaterThan(
        least,
      );
    }
    await fc.assert(property, { numRuns: 20 });
  }, 600_000);
});
