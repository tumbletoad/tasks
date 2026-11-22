// The projection against a model of what may happen to it (A1 3.13 rule 10): random sequences of
// commits, a person's acts in the tree (an edit of a generated file, in place or by an editor's
// save through a temporary file renamed over it, some keeping the file's size; a file of theirs at
// a generated path and elsewhere, a deleted generated file, a folder replaced by a file or a link,
// a hard link to a file outside, text where the old control files were, files with
// temporary-looking names, a rescue folder swapped for a link, during a batch too; on Windows a
// generated file held open without sharing while a batch runs), a kill at any act of a start or a
// batch, and faults in what the projection writes outside the tree (a short write or a full volume
// for its trusted state, a rescue notice the service could not save), each followed by a restart,
// the person sometimes typing into a temporary file the kill left before it. A run ends early only
// by a kill or by the full volume's own error: a short write must complete and a refused notice
// must not fail a batch, and any other error fails the model. After every step:
//
// 1. every byte a person put in the tree still exists, at its path or in a rescue folder, with
//    its mode unchanged;
// 2. what the projection does creates, changes or removes nothing outside the tree and the rescue
//    folders it makes, and nothing in a rescue folder made before;
// 3. the watermark covers no task whose file is not on disk (tasks whose files the person touched
//    excepted, until the projection has been at rest since);
// 4. the projection never moves its own files aside;
// 5. at rest (after a restart and its reconciliation, with nothing left to do), the generated files
//    equal a fresh render and every path the catalogue names exists;
// 6. at rest, every rescue folder in the space's exchange/rescued/ was told to the receiver.
//
// Fixture text only; every person's text carries a marker, so the model finds it wherever it is.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, expect } from "vitest";
import { ProjectionError, type Projector, type ProjectorOptions } from "../src/index.ts";
import {
  checkWatermark,
  faultState,
  killAt,
  Killed,
  settle,
  treeOf,
  world,
  type Fault,
  type FaultLog,
  type World,
} from "./helpers.ts";

// Each test file that imports this module has its own folder for its runs.
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "projection-model-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const LINK = process.platform === "win32" ? "junction" : "dir";
/** libuv's UV_FS_O_EXLOCK on Windows: an open that shares nothing (no read, write or delete). */
const EXCLUSIVE = 0x10000000;
const MARK = "Person ";
/** One of the projection's rescue folders: `<stem>-<n>`. */
const RESCUE_FOLDER = /^([0-9]{8}T[0-9]{9}Z-[0-9a-f]{4})-[0-9]+$/;
const FOLDERS = ["open", "completed", "completed/2026"] as const;

/** A person swaps a folder for a link while a batch waits on the writer. */
type During = "none" | "open-link" | "view-link";

/** A commit to an existing task; "delete-task" tombstones it, "restore" brings a deleted one back. */
type Commit = "rename" | "summary" | "complete" | "archive" | "reopen" | "delete-task" | "restore";

/**
 * How a person edits a generated file: written in place, or saved by an editor (a new file beside
 * it, renamed over it); "same" keeps its size, so only its bytes tell it from the generated file.
 */
type EditHow = "write" | "same" | "editor" | "editor-same";

/**
 * A fault in what a run writes outside the tree, from the `from`-th write of the trusted state on:
 * each write takes half the bytes it is given ("short", as on a filling volume), or fails as on a
 * full one ("enospc"); or the service cannot save the run's rescue notices ("notice"). A restart
 * follows.
 */
interface RunFault {
  readonly what: Fault | "notice";
  readonly from: number;
}

export type Action =
  | { readonly kind: "create"; readonly squat: boolean }
  | {
      readonly kind: Commit;
      readonly pick: number;
    }
  | {
      readonly kind: "run";
      readonly steps: number;
      readonly killAt: Kill;
      readonly during: During;
      /** After a kill, before the restart: the person types into a temporary file it left. */
      readonly leftover: boolean;
      /** Windows: a generated file held open without sharing while the run lasts; its task changes. */
      readonly hold: number | null;
      readonly fault: RunFault | null;
    }
  | { readonly kind: "restart" | "rebuild"; readonly killAt: Kill }
  | { readonly kind: "edit"; readonly pick: number; readonly how: EditHow }
  | { readonly kind: "replace" | "delete"; readonly pick: number }
  | { readonly kind: "hardlink"; readonly pick: number; readonly same: boolean }
  | { readonly kind: "elsewhere" | "decoy"; readonly which: number }
  | { readonly kind: "folder-file" | "folder-link"; readonly which: number }
  | { readonly kind: "swap-rescue" | "swap-rescued-root" | "rest" };

/** A kill at the n-th act on disk, right after the writer answered a batch, or none. */
type Kill = number | "reported" | null;
const kill: fc.Arbitrary<Kill> = fc.oneof(
  { weight: 4, arbitrary: fc.option(fc.integer({ min: 1, max: 40 }), { nil: null, freq: 3 }) },
  { weight: 1, arbitrary: fc.constant("reported" as const) },
);
const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("create" as const), squat: fc.boolean() }),
  },
  {
    weight: 7,
    arbitrary: fc.record({
      kind: fc.constantFrom<Commit>(
        "rename",
        "summary",
        "complete",
        "archive",
        "reopen",
        "delete-task",
        "restore",
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
      leftover: fc.boolean(),
      hold: fc.oneof(
        { weight: 4, arbitrary: fc.constant(null) },
        { weight: 1, arbitrary: fc.nat() },
      ),
      fault: fc.oneof(
        { weight: 4, arbitrary: fc.constant(null) },
        {
          weight: 1,
          arbitrary: fc.record({
            what: fc.constantFrom<RunFault["what"]>("short", "enospc", "notice"),
            from: fc.integer({ min: 1, max: 6 }),
          }),
        },
      ),
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
      kind: fc.constant("edit" as const),
      pick: fc.nat(),
      how: fc.constantFrom<EditHow>("write", "same", "editor", "editor-same"),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constantFrom("replace" as const, "delete" as const),
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

/**
 * What is at `abs`, never followed; undefined when nothing is. Linux answers ENOTDIR, not ENOENT,
 * when a folder on the way is a file (the person put one where `completed/` was), and lstat's
 * throwIfNoEntry covers only ENOENT.
 */
function entryAt(abs: string): Stats | undefined {
  try {
    return lstatSync(abs, { throwIfNoEntry: false });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOTDIR") return undefined;
    throw error;
  }
}

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
    if (entryAt(abs)?.isFile() !== true) return;
    this.artifacts.delete(readFileSync(abs, "utf8"));
  }

  realFolder(abs: string): boolean {
    return entryAt(abs)?.isDirectory() === true;
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
  pickFile(pick: number, live = false): { path: string; task: string; abs: string } | undefined {
    const alive = live
      ? new Set(
          this.w.reader
            .prepare("SELECT id FROM tasks WHERE deleted_at IS NULL")
            .all<{ id: string }>()
            .map((row) => row.id),
        )
      : undefined;
    const files = this.generated().filter(({ path, task }) => {
      if (alive !== undefined && !alive.has(task)) return false;
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
      .prepare("SELECT id FROM tasks WHERE lifecycle = $l AND deleted_at IS NULL ORDER BY ref")
      .all<{ id: string }>({ l: lifecycle })
      .map((row) => row.id);
  }

  // ------------------------------------------------------------------------------------------
  // The projection's acts, each checked against invariant 2.

  /** The kill armed for the projection's current act, if any. */
  killer: ReturnType<typeof killAt> | undefined;
  /** A person's act run once while a batch waits on the writer. */
  during: (() => void) | undefined;
  /** The kill is right after the writer's next answer. */
  killOnReport = false;
  /** The state outside the tree the projection's current act is checked against. */
  baseline: Map<string, Entry> | undefined;
  /** The stems of rescue folders the receiver saved, as the service's settings would hold them. */
  readonly told = new Set<string>();
  /** The service cannot save a rescue notice now: the receiver refuses. */
  noticeFails = false;
  /**
   * A fault is armed for the current act: the failures it injected, and only those, may end it.
   * Anything else a run throws (a programming error) fails the model, faulted or not.
   */
  injected: ((error: unknown) => boolean) | undefined;
  /** Windows: a generated file the person holds open without sharing during the current act. */
  held: number | undefined;

  /** A projector as the service makes one, its acts and its writer watched by the model. */
  newProjector(): Projector {
    const w = this.w;
    const refuse = (): Promise<never> => Promise.reject(new Killed());
    const options: Partial<ProjectorOptions> = {
      at: (act, path) => {
        this.killer?.hook(act, path);
      },
      // The service's receiver: a dead process tells nothing; one that cannot save refuses.
      onRescued: (rescue) => {
        if (this.killer?.dead() === true) return refuse();
        if (this.noticeFails) {
          seen.refused += 1;
          return Promise.reject(Object.assign(new Error("fixture"), { code: "EBUSY" }));
        }
        this.told.add(rescue.stem);
        return Promise.resolve();
      },
      writer: {
        projected: (batch) => {
          if (this.killer?.dead() === true) return refuse();
          const answer = w.writer.projected(batch);
          if (this.killOnReport) {
            // The writer marked the batch; the process ends before anything else happens.
            this.killOnReport = false;
            this.killer?.kill();
            return refuse();
          }
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
   * invariant 2 around it. A kill ends in a restart, as the service's next start would be;
   * `afterKill` is what the person does in between.
   */
  async act(work: () => Promise<void>, at: Kill = null, afterKill?: () => void): Promise<void> {
    try {
      this.baseline = this.outsideState();
    } catch (error) {
      this.release();
      throw error;
    }
    this.killer =
      at === null ? undefined : killAt(at === "reported" ? Number.MAX_SAFE_INTEGER : at);
    this.killOnReport = at === "reported";
    try {
      await work();
    } catch (error) {
      if (this.killer?.dead() !== true && this.injected?.(error) !== true) throw error;
    } finally {
      // The person lets go of a file they held: nothing after this act finds it locked.
      this.release();
    }
    const killed = this.killer?.dead() === true;
    if (killed) seen.kills += 1;
    this.killer = undefined;
    this.killOnReport = false;
    this.during = undefined;
    if (killed) {
      // What the dead projection did is checked; the person's act then changes the baseline.
      if (afterKill !== undefined) {
        this.checkOutside(this.baseline);
        afterKill();
        this.baseline = this.outsideState();
      }
      this.projector = this.newProjector();
      await this.projector.start();
    }
    this.checkOutside(this.baseline);
    this.baseline = undefined;
  }

  /** The person types into a temporary file a kill left in the tree, if there is one. */
  typeIntoLeftover(): void {
    if (!this.realFolder(this.view)) return;
    const leftover = [...walk(this.view)]
      .filter(([rel, entry]) => entry.type === "file" && rel.endsWith(".tmp"))
      .map(([rel]) => rel)
      .sort()[0];
    if (leftover === undefined) return;
    const parts = leftover.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (!this.realFolder(join(this.view, ...parts.slice(0, i)))) return;
    }
    this.write(join(this.view, ...parts), this.personText());
    seen.leftovers += 1;
  }

  async restart(at: Kill): Promise<void> {
    await this.act(async () => {
      this.projector = this.newProjector();
      await this.projector.start();
    }, at);
  }

  /**
   * Windows: the person holds a generated file open without sharing (as some editors and backup
   * tools do), and its task changes, so the run must replace it: nothing can read, rename or
   * remove it until it is let go. Elsewhere a file cannot be held that way: nothing happens.
   */
  hold(pick: number): void {
    if (process.platform !== "win32") return;
    const file = this.pickFile(pick, true);
    // A hard link to a file outside would lock that file too, which the model reads.
    if (file === undefined || statSync(file.abs).nlink !== 1) return;
    this.w.submit([
      { kind: "task.patch", task: file.task, set: { summary: `Held ${String((this.n += 1))}` } },
    ]);
    this.held = openSync(file.abs, constants.O_RDONLY | EXCLUSIVE);
    seen.holds += 1;
  }

  release(): void {
    if (this.held === undefined) return;
    closeSync(this.held);
    this.held = undefined;
  }

  /**
   * A run with a fault armed (see RunFault), then a restart once it is gone: space freed, the
   * service's settings writable again.
   */
  async faultedRun(steps: number, fault: RunFault): Promise<void> {
    seen.faults += 1;
    let end: (() => void) | undefined;
    const log: FaultLog = { thrown: [], short: 0 };
    if (fault.what === "notice") {
      // A rescue the run must make, and tell: the person edits a generated file, its task changes.
      const file = this.pickFile(fault.from, true);
      if (file !== undefined) {
        this.disturb(file.task);
        this.write(file.abs, this.personText());
        this.w.submit([
          {
            kind: "task.patch",
            task: file.task,
            set: { summary: `Notice ${String((this.n += 1))}` },
          },
        ]);
      }
      this.noticeFails = true;
    } else {
      // Work for the run: a task deleted (A1 3.13's story of a full volume) or changed.
      const pool = [...this.ids("active"), ...this.ids("completed")];
      const task = pool[fault.from % Math.max(1, pool.length)];
      if (task !== undefined) {
        this.w.submit([
          fault.from % 2 === 1
            ? { kind: "task.delete", task }
            : { kind: "task.patch", task, set: { summary: `Fault ${String((this.n += 1))}` } },
        ]);
      }
      const what = fault.what;
      end = faultState(this.w.state, (k) => (k >= fault.from ? what : "whole"), log);
    }
    // Only a full volume may end the run: its ENOSPC as the fault threw it, or as the projector
    // reports it (a record it could not write). A short write must complete, since every write of
    // the trusted state is whole, and a notice the service could not save is told again later:
    // neither may fail a batch.
    this.injected = (error) =>
      log.thrown.includes(error as Error) ||
      (error instanceof ProjectionError && error.code === "ENOSPC" && log.thrown.length > 0);
    try {
      await this.act(async () => {
        for (let i = 0; i < steps && this.current.pending().dirty; i += 1) {
          await this.current.step();
        }
      });
    } finally {
      end?.();
      this.noticeFails = false;
      this.injected = undefined;
      seen.shortWrites += log.short;
    }
    await this.restart(null);
  }

  async run(
    steps: number,
    at: Kill,
    during: During,
    leftover = false,
    hold: number | null = null,
  ): Promise<void> {
    // A file held open stays where it is: a folder above it cannot be swapped then.
    if (hold !== null && during === "none") this.hold(hold);
    if (during !== "none") {
      const swap = (): void => {
        const target = during === "view-link" ? this.view : join(this.view, "open");
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
      this.during = swap;
    }
    await this.act(
      async () => {
        for (let i = 0; i < steps && this.current.pending().dirty; i += 1) {
          await this.current.step();
        }
      },
      at,
      leftover
        ? () => {
            this.typeIntoLeftover();
          }
        : undefined,
    );
  }

  async rebuild(at: Kill): Promise<void> {
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

  /**
   * A text of the person's with exactly as many bytes as the file at `abs` holds, other bytes: its
   * start is the marker (a generated file and a person's text both start in ASCII).
   */
  sameSizeText(abs: string): string {
    const text = readFileSync(abs, "utf8");
    this.n += 1;
    const mark = `${MARK}${String(this.n)}: `;
    const edited = `${mark}${text.slice(mark.length)}`;
    expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(text));
    return edited;
  }

  /** An editor's save: the new text beside the file, renamed over it, the person's mode. */
  editorSave(abs: string, text: string): void {
    this.forget(abs);
    const swap = join(dirname(abs), `.${basename(abs)}.swp`);
    writeFileSync(swap, text);
    // Windows refuses a rename over a read-only file: the editor makes it writable first.
    chmodSync(abs, 0o600);
    move(swap, abs);
    this.artifacts.set(text, modeOf(abs));
    seen.editorSaves += 1;
  }

  person(a: Action): void {
    switch (a.kind) {
      case "edit": {
        const file = this.pickFile(a.pick);
        if (file === undefined) return;
        this.disturb(file.task);
        const same = a.how === "same" || a.how === "editor-same";
        const text = same ? this.sameSizeText(file.abs) : this.personText();
        if (same) seen.sameSize += 1;
        if (a.how === "editor" || a.how === "editor-same") this.editorSave(file.abs, text);
        else this.write(file.abs, text);
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
          // A read-only copy of the generated file: its mode must stay what it is.
          const bytes = readFileSync(file.abs, "utf8");
          writeFileSync(away, bytes);
          chmodSync(away, 0o444);
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
    if (!("pick" in a)) return;
    const pool =
      a.kind === "reopen"
        ? this.ids("completed")
        : a.kind === "restore"
          ? this.deleted()
          : a.kind === "delete-task"
            ? [...this.ids("active"), ...this.ids("completed")]
            : this.ids("active");
    const task = pool[a.pick % Math.max(1, pool.length)];
    if (task === undefined) return;
    this.n += 1;
    if (a.kind === "rename") {
      w.submit([{ kind: "task.patch", task, set: { title: `Renamed ${String(this.n)}` } }]);
    } else if (a.kind === "summary") {
      w.submit([{ kind: "task.patch", task, set: { summary: `Summary ${String(this.n)}` } }]);
    } else if (a.kind === "complete") w.submit([{ kind: "task.complete", task }]);
    else if (a.kind === "archive") w.submit([{ kind: "task.archive", task }]);
    else if (a.kind === "reopen") w.submit([{ kind: "task.reopen", task }]);
    else if (a.kind === "delete-task") w.submit([{ kind: "task.delete", task }]);
    else if (a.kind === "restore") w.submit([{ kind: "task.restore", task }]);
  }

  deleted(): string[] {
    return this.w.reader
      .prepare("SELECT id FROM tasks WHERE deleted_at IS NOT NULL ORDER BY ref")
      .all<{ id: string }>()
      .map((row) => row.id);
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
    // 3. The claim, where nobody touched what it covers; and it never moves backwards.
    if (this.all) return;
    const claimed = checkWatermark(this.view, this.w.reader, this.disturbed);
    if (claimed === undefined) return;
    expect(claimed, "the watermark never moves backwards").toBeGreaterThanOrEqual(this.claimed);
    this.claimed = claimed;
  }

  /** The highest watermark the tree has claimed. */
  claimed = 0;

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
      // A file the projection made and left behind fails here, never a person's.
      expect(theirs, `${path} is not in a fresh render, so it is the person's`).toBe(true);
    }
    // 6. Every rescue folder there is was told, whatever failed or was killed on the way.
    if (this.realFolder(rescued) && this.realFolder(this.exchange)) {
      for (const name of readdirSync(rescued)) {
        const stem = RESCUE_FOLDER.exec(name)?.[1];
        if (stem === undefined || !this.realFolder(join(rescued, name))) continue;
        if (!existsSync(join(rescued, name, "view"))) continue;
        expect(this.told.has(`exchange/rescued/${stem}`), `${name} was told`).toBe(true);
      }
    }
  }

  async apply(a: Action): Promise<void> {
    switch (a.kind) {
      case "create":
      case "rename":
      case "summary":
      case "complete":
      case "archive":
      case "reopen":
      case "delete-task":
      case "restore":
        this.commit(a);
        return;
      case "run":
        if (a.fault !== null) await this.faultedRun(a.steps, a.fault);
        else await this.run(a.steps, a.killAt, a.during, a.leftover, a.hold);
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
      case "swap-rescue":
      case "swap-rescued-root": {
        // A swapped rescue folder matters at the next rescue: the person edits a generated file,
        // its task changes, and a batch must move the edit aside.
        this.person(a);
        // A task that is not deleted: a patch must apply.
        const file = this.pickFile(0, true);
        if (file === undefined) return;
        this.disturb(file.task);
        this.write(file.abs, this.personText());
        this.w.submit([
          {
            kind: "task.patch",
            task: file.task,
            set: { summary: `Swap ${String((this.n += 1))}` },
          },
        ]);
        await this.run(1, null, "none");
        return;
      }
      default:
        this.person(a);
    }
  }
}

let runs = 0;

/** What this file's runs reached: a fixed seed must reach each often enough to mean something. */
const seen = {
  kills: 0,
  during: 0,
  hardlinks: 0,
  folders: 0,
  swaps: 0,
  rescued: 0,
  rests: 0,
  leftovers: 0,
  sameSize: 0,
  editorSaves: 0,
  faults: 0,
  /** Writes of the trusted state cut short, each of which the run completed. */
  shortWrites: 0,
  refused: 0,
  holds: 0,
};
/** One run: a fresh space of its own, the acts, and the checks after each. */
export async function run(actions: readonly Action[]): Promise<void> {
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

export type Reached = typeof seen;

/** Random sequences of acts, each run on a fresh space of its own. */
export const property = fc.asyncProperty(fc.array(action, { minLength: 4, maxLength: 20 }), run);

export const SUITE =
  "[A1.5.projection.model] commits, a person's acts in the tree, kills at every act and faults in what the projection writes outside the tree, against the projection's invariants";
export const INVARIANTS =
  "no byte of a person's is lost or changed in mode, nothing outside is touched, the watermark covers only files on disk, and at rest the tree is a fresh render and every rescue was told";

/**
 * `numRuns` runs of a fixed seed, which must reach each kind of trouble more often than `least`
 * says. One file per seed (model-seed-*.test.ts), so the seeds run side by side; each file's
 * values come from its seed's counts on Windows and Linux, with room to spare.
 */
export async function fixedSeed(seed: number, numRuns: number, least: Reached): Promise<void> {
  await fc.assert(property, { numRuns, seed });
  for (const [what, n] of Object.entries(least)) {
    expect(seen[what as keyof Reached], `${what}: ${JSON.stringify(seen)}`).toBeGreaterThan(n);
  }
}
