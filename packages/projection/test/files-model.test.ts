// The pass against random sequences of what may happen to it: commits that add, rename, finish,
// reopen, move and trash tasks and add pages; a person who edits a generated file, adds a file of
// their own, deletes a generated file or renames a project's folder; passes, kills at any act of a
// pass, and restarts. After every step:
//
// 1. every byte a person wrote still exists, in the tree or in a rescue folder;
// 2. a rescue folder holds only what a person wrote: the projector never moves its own files aside;
// 3. at the end, after a restart, the tree settles to a fresh render, with no temporary file and
//    no pending hash, besides what the person made (their files, and folders they renamed).
//
// Fixture text only; every person's text carries a marker, so the model finds it wherever it is.
import { readdirSync, renameSync, statSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import type { FilesProjector } from "../src/index.ts";
import { tempFolders } from "../../storage/test/space-helpers.ts";
import {
  expectConverged,
  filesBelow,
  filesWorld,
  Killed,
  settle,
  smallTree,
  TEMP,
} from "./files-helpers.ts";

const temp = tempFolders("files-model");
afterAll(temp.cleanup);

type Op =
  | { kind: "add" | "rename" | "finish" | "reopen" | "move" | "trash" | "page"; pick: number }
  | { kind: "edit" | "editTask" | "mine" | "delete" | "renameFolder"; pick: number }
  | { kind: "pass" | "restart" }
  | { kind: "kill"; at: number };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constantFrom(
      "add",
      "rename",
      "finish",
      "reopen",
      "move",
      "trash",
      "page",
      "edit",
      "editTask",
      "editTask",
      "mine",
      "delete",
      "renameFolder",
    ),
    pick: fc.nat(1000),
  }) as fc.Arbitrary<Op>,
  fc.record({ kind: fc.constantFrom("pass", "restart") }) as fc.Arbitrary<Op>,
  fc.record({ kind: fc.constant("kill"), at: fc.integer({ min: 1, max: 60 }) }) as fc.Arbitrary<Op>,
);

async function run(ops: readonly Op[]): Promise<void> {
  const w = await filesWorld(temp.make());
  smallTree(w);
  let p: FilesProjector = w.projector();
  p.start();
  p.pass();
  let marks = 0;
  const marked = new Set<string>();
  const renamed: string[] = [];
  const pick = <T>(list: readonly T[], n: number): T | undefined =>
    list[n % Math.max(1, list.length)];
  const tasks = (where: string): string[] =>
    w.fx.conn
      .prepare(
        `SELECT 'M-' || t.ref AS ref FROM tasks t JOIN nodes n ON n.id = t.id WHERE n.kind = 'task' AND n.deleted_at IS NULL AND ${where} ORDER BY t.ref`,
      )
      .all()
      .map((r) => String(r["ref"]));
  const places = (): string[] => [
    "space",
    ...w.fx.conn
      .prepare("SELECT id FROM nodes WHERE kind = 'project' ORDER BY id")
      .all()
      .map((r) => String(r["id"])),
  ];
  const generated = (): string[] =>
    [...filesBelow(w.view).keys()].filter((path) => !TEMP.test(path)).sort();
  const everywhere = (): string[] => [
    ...filesBelow(w.view).values(),
    ...filesBelow(join(w.space, "rescued")).values(),
  ];
  /** The person writes over or deletes a file: what it held of theirs is theirs to lose. */
  const forget = (path: string): void => {
    const text = filesBelow(w.view).get(path) ?? "";
    for (const mark of [...marked]) if (text.includes(mark)) marked.delete(mark);
  };
  const check = (): void => {
    const all = everywhere().join("\n");
    for (const mark of marked) expect(all.includes(mark), `lost ${mark}`).toBe(true);
    for (const [path, text] of filesBelow(join(w.space, "rescued"))) {
      expect(text.includes("person-mark-"), `the projector's own file rescued: ${path}`).toBe(true);
    }
  };

  for (const step of ops) {
    const send = (command: string, input: Record<string, unknown>): void => {
      w.fx.send(command, input);
    };
    switch (step.kind) {
      case "add":
        send("tasks.add", {
          tasks: [{ under: pick(places(), step.pick), title: `Task ${String(step.pick)}` }],
        });
        break;
      case "rename": {
        const task = pick(tasks("1"), step.pick);
        if (task !== undefined)
          send("task.update", { task, set: { title: `Renamed ${String(step.pick)}` } });
        break;
      }
      case "finish": {
        const task = pick(tasks("t.lifecycle = 'active'"), step.pick);
        if (task !== undefined) send("task.finish", { task, subtasks: "only" });
        break;
      }
      case "reopen": {
        const task = pick(tasks("t.lifecycle <> 'active'"), step.pick);
        if (task !== undefined) send("task.reopen", { task });
        break;
      }
      case "move": {
        const task = pick(tasks("1"), step.pick);
        if (task !== undefined) send("task.move", { task, under: pick(places(), step.pick >> 3) });
        break;
      }
      case "trash": {
        const task = pick(tasks("1"), step.pick);
        if (task !== undefined) send("nodes.trash", { task });
        break;
      }
      case "page":
        send("page.create", { on: pick(places(), step.pick), title: `Page ${String(step.pick)}` });
        break;
      case "edit": {
        const path = pick(generated(), step.pick);
        if (path === undefined) break;
        const abs = join(w.view, ...path.split("/"));
        marks += 1;
        const mark = `person-mark-${String(marks)}`;
        forget(path);
        chmodSync(abs, 0o600);
        writeFileSync(abs, `edited ${mark}`);
        marked.add(mark);
        break;
      }
      case "editTask": {
        // A task's file edited, then the task changed: its file is replaced, or its path retired.
        const task = pick(tasks("1"), step.pick);
        const path = generated().find((p) =>
          p
            .split("/")
            .at(-1)
            ?.startsWith(`${task ?? "-"}-`),
        );
        if (task === undefined || path === undefined) break;
        const abs = join(w.view, ...path.split("/"));
        marks += 1;
        const mark = `person-mark-${String(marks)}`;
        forget(path);
        chmodSync(abs, 0o600);
        writeFileSync(abs, `edited ${mark}`);
        marked.add(mark);
        if (step.pick % 2 === 0)
          send("task.update", { task, set: { title: `Retitled ${String(step.pick)}` } });
        else send("task.update", { task, set: { priority: 1 + (step.pick % 4) } });
        p.pass();
        break;
      }
      case "mine": {
        const folder = pick(
          [...new Set(generated().map((p) => p.slice(0, Math.max(0, p.lastIndexOf("/")))))],
          step.pick,
        );
        marks += 1;
        const mark = `person-mark-${String(marks)}`;
        writeFileSync(
          join(w.view, ...(folder ?? "").split("/").filter(Boolean), `mine-${String(marks)}.txt`),
          mark,
        );
        marked.add(mark);
        break;
      }
      case "delete": {
        const path = pick(generated(), step.pick);
        if (path === undefined) break;
        const abs = join(w.view, ...path.split("/"));
        forget(path);
        chmodSync(abs, 0o600);
        unlinkSync(abs);
        break;
      }
      case "renameFolder": {
        const top = readdirSync(w.view).filter(
          (name) =>
            !name.startsWith("_") &&
            statSync(join(w.view, name)).isDirectory() &&
            !name.includes("-moved-"),
        );
        const name = pick(top, step.pick);
        if (name === undefined) break;
        const to = `${name}-moved-${String(step.pick)}`;
        try {
          renameSync(join(w.view, name), join(w.view, to));
          renamed.push(`${to}/`);
        } catch {
          // Taken already.
        }
        break;
      }
      case "pass":
        p.pass();
        break;
      case "restart":
        p = w.projector();
        p.start();
        break;
      case "kill": {
        let count = 0;
        let dead = false;
        const killed = w.projector((act) => {
          count += 1;
          if (count === step.at) dead = true;
          if (dead) throw new Killed(act);
        });
        try {
          killed.start();
          killed.pass();
        } catch (error) {
          if (!(error instanceof Killed)) throw error;
        }
        p = w.projector();
        p.start();
        break;
      }
    }
    check();
  }
  p = w.projector();
  p.start();
  settle(p);
  check();
  const want = w.fresh();
  const theirs = new Set(
    [...filesBelow(w.view)]
      .filter(
        ([path, text]) =>
          !want.has(path) &&
          (text.includes("person-mark-") || renamed.some((r) => path.startsWith(r))),
      )
      .map(([path]) => path),
  );
  expectConverged(w, theirs);
  w.fx.close();
}

describe("[S3.files.model] the pass against commits, a person's acts, kills and restarts", () => {
  test("seed 20261128: a person's bytes are never lost, own files are never rescued, and it converges", async () => {
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 4, maxLength: 18 }), run), {
      seed: 20261128,
      numRuns: 40,
    });
  }, 600_000);
});
