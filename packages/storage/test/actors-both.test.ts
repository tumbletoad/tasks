// Who joins a space, the same ordinary sequences on today's writer and the tree's: the machine
// registered twice, an agent joining twice by its label, and another machine that is not the
// space's authority refused. What each answered and what a reader sees of the space's machines,
// agents and their joining commits are compared. Fixture text only.
import { afterAll, describe, test } from "vitest";
import type { Connection } from "../src/driver.ts";
import { StorageError } from "../src/errors.ts";
import { newId } from "../src/ids.ts";
import { TreeWriter } from "../src/tree/core.ts";
import { both, TodaySession, TreeSession, type Answer, type Side } from "./both-helpers.ts";
import { tempFolders } from "./space-helpers.ts";
import { fixtureCopies, MACHINE } from "./write-helpers.ts";

const temp = tempFolders("actors-both");
const fixture = fixtureCopies(temp.make);
afterAll(temp.cleanup);

type Step = { do: "machine" } | { do: "agent"; label: string; elsewhere?: true };

const OTHER = { id: newId("m"), name: "mira-laptop", os: "linux" as const };

/** What a call answered: the actor's ID is each space's own, so only whether it was the same. */
function answered(call: () => unknown, before: Map<string, unknown>, key: string): Answer {
  try {
    const value = call();
    if (typeof value === "boolean") return { status: "done" };
    const same = before.has(key) ? before.get(key) === value : undefined;
    before.set(key, value);
    return { status: "done", ...(same === undefined ? {} : { said: { same } }) };
  } catch (error) {
    return { status: "refused", code: error instanceof StorageError ? error.code : String(error) };
  }
}

/** What a reader sees: this machine's record, and each agent that joined with its commits. */
const seenOf = (conn: Connection, labels: readonly string[]) => ({
  machines: conn.prepare("SELECT name, os FROM machines ORDER BY name").all().length,
  joined: labels.map((label) => ({
    label,
    actors: Number(
      conn
        .prepare("SELECT count(*) AS n FROM actors WHERE kind = 'agent' AND label = $label")
        .get({ label })?.["n"],
    ),
  })),
});

const LABELS = ["agent:gemini"];

const TODAY: Side<Step, TodaySession & { seen: Map<string, unknown> }> = {
  open: async () => Object.assign(new TodaySession(await fixture()), { seen: new Map() }),
  step: (s, step) => {
    if (step.do === "machine") return answered(() => s.fx.writer.registerMachine(), s.seen, "m");
    if (step.elsewhere === true) {
      const other = s.fx.reopen({ machine: OTHER });
      try {
        return answered(() => other.actor("agent", step.label), s.seen, "x");
      } finally {
        s.fx.reopen({ machine: MACHINE });
      }
    }
    return answered(() => s.fx.writer.actor("agent", step.label), s.seen, step.label);
  },
  seen: (s) => seenOf(s.fx.reader, LABELS),
  close: (s) => {
    s.close();
  },
};

const TREE: Side<Step, TreeSession & { seen: Map<string, unknown> }> = {
  open: async () => Object.assign(await TreeSession.open(temp.make()), { seen: new Map() }),
  step: (s, step) => {
    const writer = s.fx.writer;
    if (step.do === "machine") {
      return answered(() => writer.registerMachine({ name: "test", os: "windows" }), s.seen, "m");
    }
    if (step.elsewhere === true) {
      const other = new TreeWriter(s.fx.conn, { machineId: OTHER.id });
      return answered(() => other.actor("agent", step.label), s.seen, "x");
    }
    return answered(() => writer.actor("agent", step.label), s.seen, step.label);
  },
  seen: (s) => seenOf(s.fx.conn, LABELS),
  close: (s) => {
    s.close();
  },
};

describe("[S2.actors.both] who joins a space, the same on both writers", () => {
  test("the machine registered twice, an agent joining twice, and another machine refused", async () => {
    await both({ today: TODAY, tree: TREE }, [
      { do: "machine" },
      { do: "machine" },
      { do: "agent", label: "agent:gemini" },
      { do: "agent", label: "agent:gemini" },
      { do: "agent", label: "agent:other", elsewhere: true },
    ]);
  });
});
