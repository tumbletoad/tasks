// A kill at every act on disk of a pass, the record's writes included: that act and every one after
// it never happen. A new projector then starts on the same folder and record. The tree must hold
// whole files at once (each the bytes of the render before or after), nothing may be rescued,
// since nobody changed anything, and once it settles the tree equals a fresh render with no
// temporary file and no pending hash. Fixture text only.
import { afterAll, describe, expect, test } from "vitest";
import { tempFolders } from "../../storage/test/space-helpers.ts";
import {
  expectConverged,
  filesBelow,
  filesWorld,
  Killed,
  settle,
  smallTree,
  TEMP,
  type FilesWorld,
} from "./files-helpers.ts";

const temp = tempFolders("files-kill");
afterAll(temp.cleanup);

/** Changes that write, move and remove files. */
function change(w: FilesWorld, t: ReturnType<typeof smallTree>): void {
  w.ok("task.update", { task: t.menu, set: { title: "Fix the menu bar" } });
  w.ok("task.move", { task: t.widths, under: "studio" });
  w.ok("task.reopen", { task: t.dns });
  w.add({ under: t.site, title: "Write the copy" });
}

/**
 * Kills the pass at its n-th act, for every n until a pass runs through, after a first build when
 * `changes`, else during it.
 */
async function killEverywhere(changes: boolean): Promise<number> {
  let kills = 0;
  for (let n = 1; ; n += 1) {
    const w = await filesWorld(temp.make());
    const t = smallTree(w);
    if (changes) {
      const p = w.projector();
      p.start();
      settle(p);
      change(w, t);
    }
    const old = changes ? filesBelow(w.view) : new Map<string, string>();
    const next = w.fresh();
    const kill = { count: 0, dead: false };
    const killed = w.projector((act) => {
      kill.count += 1;
      if (kill.count === n) kill.dead = true;
      if (kill.dead) throw new Killed(act);
    });
    try {
      killed.start();
      killed.pass();
    } catch (error) {
      if (!(error instanceof Killed)) throw error;
    }
    if (kill.dead) kills += 1;
    for (const [path, text] of filesBelow(w.view)) {
      if (TEMP.test(path)) continue;
      const whole = text === next.get(path) || text === old.get(path);
      expect(whole, `${path} after a kill at act ${String(n)}`).toBe(true);
    }
    // A commit before the restart: a file that holds what the killed pass meant to place must still
    // be known as ours, though the render now wants other bytes there.
    w.ok("task.update", { task: t.menu, set: { priority: 1 } });
    w.ok("node.set", { node: "space", brief: "After the kill" });
    const again = w.projector();
    again.start();
    expect([...filesBelow(w.view).keys()].filter((p) => TEMP.test(p))).toEqual([]);
    settle(again);
    expect(filesBelow(`${w.space}/rescued`).size, `rescued after a kill at act ${String(n)}`).toBe(
      0,
    );
    expectConverged(w);
    w.fx.close();
    if (!kill.dead) return kills;
  }
}

describe("[S3.files.kill] a kill at any act leaves whole files, rescues nothing, and converges", () => {
  test("during the first build", async () => {
    expect(await killEverywhere(false)).toBeGreaterThan(20);
  }, 300_000);

  test("during a pass of renames, moves, a reopening and a new task", async () => {
    expect(await killEverywhere(true)).toBeGreaterThan(10);
  }, 300_000);
});
