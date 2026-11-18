// The actor a connection writes as (A3 3.7.4; A7 3.8 M1.10): the space's human, or an agent actor
// that joins the space on its first act, in a system commit of its own. Fixture text only.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { StorageError } from "../src/errors.ts";
import { isId } from "../src/ids.ts";
import { StorageWorker } from "../src/worker/client.ts";
import { tempFolders } from "./space-helpers.ts";
import {
  checkHistory,
  MACHINE,
  writeFixture,
  type Fixture,
  fixtureCopies,
} from "./write-helpers.ts";

const temp = tempFolders("actors");
/** The fixture space, made once and copied for each test. */
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

let fx: Fixture;
beforeEach(async () => {
  fx = await fixture();
});
afterEach(() => {
  checkHistory(fx.reader);
  fx.close();
});

const all = (sql: string, params = {}): Record<string, unknown>[] =>
  fx.reader.prepare(sql).all(params);

describe("[A3.3.7.actors.first-act] an agent actor joins a space on its first act", () => {
  test("the human is the space's own; an agent label is added once, in a system commit", () => {
    const human = fx.writer.actor("human", "ignored");
    expect(human).toBe(fx.human.principal_id);
    const before = all("SELECT last_seq FROM space")[0]?.["last_seq"];

    const script = fx.writer.actor("agent", "script");
    expect(isId(script, "ac")).toBe(true);
    expect(fx.writer.actor("agent", "script")).toBe(script);
    const unknown = fx.writer.actor("agent", "agent:unknown");
    expect(unknown).not.toBe(script);

    const rows = all("SELECT kind, label FROM actors WHERE id IN ($a, $b) ORDER BY label", {
      a: script,
      b: unknown,
    });
    expect(rows).toEqual([
      { kind: "agent", label: "agent:unknown" },
      { kind: "agent", label: "script" },
    ]);
    const commits = all(
      "SELECT scope_id, origin, kind, ops FROM commits WHERE seq > $seq ORDER BY seq",
      { seq: before },
    );
    expect(commits).toHaveLength(2);
    for (const commit of commits) {
      expect(commit).toMatchObject({ scope_id: "system", origin: "system", kind: "ops" });
      expect(JSON.parse(String(commit["ops"]))).toMatchObject([
        { v: 1, op: "actor.register", input: { kind: "agent" } },
      ]);
    }
    // A request by the new actor is accepted.
    const result = fx.writer.submit(
      fx.request(
        { ...fx.human, scope_id: "script:test", principal_id: script, actor_kind: "agent" },
        [{ kind: "task.create", title: "Fixture task" }],
      ),
    );
    expect(result.status).toBe("applied");
  });

  test("a label that is not one line of 1 to 100 characters is refused", () => {
    for (const label of ["", "two\nlines", "x".repeat(101)]) {
      expect(() => fx.writer.actor("agent", label)).toThrow(StorageError);
    }
  });

  test("the worker's handle reaches the same writer", async () => {
    fx.close();
    const worker = await StorageWorker.start({ driver: "node:sqlite" });
    try {
      const handle = await worker.openSpaceWriter(fx.folder, { machine: MACHINE });
      const id = await handle.actor("agent", "script");
      expect(await handle.actor("agent", "script")).toBe(id);
      await handle.close();
    } finally {
      await worker.close();
      fx = await writeFixture(temp.make());
    }
  });
});
