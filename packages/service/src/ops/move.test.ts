// What a folder change does to the folders inside the old one when a look at the disk does not
// answer: the old folder's, the new folder's, its marker's, or a folder's inside the new one. Nothing
// moves on a guess, and the answer says a folder could not be checked. The folders are temporary
// ones of this test; a look that does not answer is a mock (hung-fs.ts).
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_MARKER } from "@ttasks/brand";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { hang } from "../../test/hung-fs.ts";
import { moveOf, storedForm, type Folder, type Move } from "./folders.ts";
import { FolderMarkers, type MarkerOwner } from "./marker.ts";

vi.mock("node:fs/promises", async () => (await import("../../test/hung-fs.ts")).hungFs());

const base = mkdtempSync(join(tmpdir(), "ttasks-move-"));
const facts = { home: join(base, "home"), platform: process.platform };
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
});

const SPACE = "s_0000000000000000000000000a";
const project: MarkerOwner = { space: SPACE, kind: "project", id: "p_0000000000000000000000000a" };
const self = { kind: "project", owner: project.id } as const;

let n = 0;

/** The stored form of a folder of this test. */
function form(path: string): Folder {
  const found = storedForm(path, facts.home, facts.platform);
  if (typeof found === "string") throw new Error(found);
  return found;
}

/**
 * A project's folder marked here with two tasks' folders inside, copied to a new place with them,
 * and gone from the old one: a move by every other sign.
 */
async function copied() {
  n += 1;
  const old = form(join(base, `old-${String(n)}`));
  const next = form(join(base, `new-${String(n)}`));
  const markers = new FolderMarkers({
    file: join(base, `marks-${String(n)}.json`),
    home: facts.home,
  });
  mkdirSync(join(old.absolute, "inner"), { recursive: true });
  mkdirSync(join(old.absolute, "other"), { recursive: true });
  await markers.mark(project, old.stored);
  cpSync(old.absolute, next.absolute, { recursive: true });
  rmSync(old.absolute, { recursive: true });
  const here = ["inner", "other"].map((name, k) => ({
    kind: "task" as const,
    owner: `t_000000000000000000000000${String(k).padStart(2, "0")}`,
    label: `M-${String(k)}`,
    path: join(old.stored, name),
  }));
  const move = () =>
    moveOf(old.stored, next, self, here, facts, () =>
      markers.movedTo(project, old.stored, next.stored),
    );
  return { old, next, here, markers, move };
}

/** Which folders inside moved and which stayed, by their tasks' references, and why. */
const outcome = (move: Move) => ({
  moved: move.moved.map((f) => f.label),
  stayed: move.stayed.map((f) => f.label),
  ...(move.because === undefined ? {} : { because: move.because }),
});
const NONE_MOVED = { moved: [], stayed: ["M-0", "M-1"], because: "unchecked" };

/** Runs `work` until a look hangs, then lets every look's limit pass. */
async function pastLimit<T>(reached: Promise<void>, work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const running = work();
  await reached;
  await vi.advanceTimersByTimeAsync(60_000);
  return running;
}

describe("[A1.3.15.folders.move] a look that does not answer moves no folder inside the old one", () => {
  test("a copy with its marker carries them; the same copy whose marker, or whose folder, does not answer moves none and says a folder could not be checked", async () => {
    const marker = await copied();
    expect(outcome(await marker.move())).toEqual({ moved: ["M-0", "M-1"], stayed: [] });

    const read = await copied();
    const held = hang(join(read.next.absolute, FOLDER_MARKER));
    try {
      expect(outcome(await pastLimit(held.reached, read.move))).toEqual(NONE_MOVED);
    } finally {
      held.release();
    }

    const look = await copied();
    const away = hang(look.next.absolute);
    try {
      expect(outcome(await pastLimit(away.reached, look.move))).toEqual(NONE_MOVED);
    } finally {
      away.release();
    }
  });

  test("an old folder whose look does not answer is no move, and neither is one folder inside the new one that does not", async () => {
    const old = await copied();
    mkdirSync(old.old.absolute);
    const held = hang(old.old.absolute);
    try {
      expect(outcome(await pastLimit(held.reached, old.move))).toEqual(NONE_MOVED);
    } finally {
      held.release();
    }

    const inside = await copied();
    const one = hang(join(inside.next.absolute, "other"));
    try {
      expect(outcome(await pastLimit(one.reached, inside.move))).toEqual(NONE_MOVED);
    } finally {
      one.release();
    }
  });
});
