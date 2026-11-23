// What the page's snapshot tells a person who comes back: the tasks agents changed in the last
// seven days, newest first, with who changed each last and when. Against a real space in this
// thread, with the writer's clock set per request. Fixture text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, type Credential, type Id, type Operation } from "@ttasks/storage";
import { writeFixture, type Fixture } from "@ttasks/storage/write-helpers";
import { readSnapshot } from "../src/http/feed.ts";
import { readerOf, tempRoot } from "./harness.ts";

let temp: { root: string; cleanup: () => void };
let fx: Fixture;
const DAY = 86_400_000;
/** A week after the fixture's own writes: the writer's commit times only move forward. */
const START = Date.now() + 7 * DAY;
let clock = START;

beforeAll(async () => {
  temp = tempRoot("while-away");
  const folder = join(temp.root, "space");
  mkdirSync(folder);
  fx = await writeFixture(folder, { flush: false });
  fx.reopen({ now: () => clock });
}, 60_000);

afterAll(() => {
  fx.close();
  temp.cleanup();
});

function submit(actor: Credential, ops: Operation[], at: number): void {
  clock = at;
  const result = fx.writer.submit(fx.request(actor, ops, { base: fx.base() }));
  if (result.status !== "applied") throw new Error(JSON.stringify(result.error));
}

describe("[A5.while-away.service.recent] a snapshot holds the tasks agents changed lately", () => {
  test("newest first, each with its last agent and when; not the person's own, a deleted one or one older than a week", async () => {
    const [mine, logged, finished, old, deleted] = [
      newId("t"),
      newId("t"),
      newId("t"),
      newId("t"),
      newId("t"),
    ];
    const create = (id: Id<"t">, title: string): Operation => ({
      kind: "task.create",
      id,
      title,
      area: fx.areas.home,
    });
    submit(
      fx.human,
      [
        create(mine, "Fixture mine"),
        create(logged, "Fixture logged"),
        create(old, "Fixture old"),
        create(deleted, "Fixture deleted"),
      ],
      START,
    );
    submit(fx.codex, [{ kind: "log.add", task: old, body: "Fixture early" }], START + DAY);
    const now = START + 10 * DAY;
    submit(fx.codex, [{ kind: "log.add", task: logged, body: "Fixture one" }], now - 3 * DAY);
    submit(fx.claude, [create(finished, "Fixture finished")], now - 2 * DAY);
    submit(fx.codex, [{ kind: "log.add", task: deleted, body: "Fixture two" }], now - 2 * DAY);
    submit(fx.human, [{ kind: "task.delete", task: deleted }], now - 2 * DAY);
    submit(fx.claude, [{ kind: "task.complete", task: finished }], now - DAY);
    // The person's later change leaves the agent's in place.
    submit(fx.human, [{ kind: "task.patch", task: logged, set: { priority: 1 } }], now - DAY);
    submit(fx.human, [{ kind: "task.patch", task: mine, set: { priority: 2 } }], now);

    const snapshot = await readSnapshot(readerOf(fx.reader), undefined, now);
    expect(snapshot.agent_changes.map(({ task, actor, at }) => ({ task, actor, at }))).toEqual([
      { task: finished, actor: "Claude Code · work", at: now - DAY },
      { task: logged, actor: "Codex · work", at: now - 3 * DAY },
    ]);
    // The finished task is in no open row: its change brings its row.
    expect(snapshot.agent_changes[0]?.row).toMatchObject({ id: finished, lifecycle: "completed" });
    expect(snapshot.agent_changes[1]?.row).toBeUndefined();
    // Read a week later, nothing is that recent.
    expect(
      (await readSnapshot(readerOf(fx.reader), undefined, now + 8 * DAY)).agent_changes,
    ).toEqual([]);
  });
});
