// Routines on the tree: work that comes back on a schedule, one node of kind `routine` that its times
// never finish. Its `tasks` row gives it a reference, a lifecycle and a priority, so runs, launches,
// notes and Open point at it as at a task. Its `routines` row holds the schedule and the open time:
// the time that comes next or, once it has come, the one still to do. Each time done or skipped is
// an `occurrences` row under it, and only then is the next time computed, so a missed time never
// stacks. A person's routine moves to the schedule's first time after both its open time and now;
// an agent's to the slot after its open time, which the service's claim then runs once however
// many passed. Who does it, its words and switching an agent's routine on are the person's alone.
import { dateOf, dayNumber, isTimeZone, localDate } from "@ttasks/contracts/day";
import { RUN_REQUEST_MAX_BYTES } from "@ttasks/contracts/runs";
import {
  claim,
  following,
  nextDate,
  nextInstant,
  parseRule,
  readSchedule,
  type Schedule,
} from "@ttasks/contracts/schedule";
import type { Row, SqlValue } from "../driver.ts";
import { isId, type Id } from "../ids.ts";
import { OPEN_RUN, TREE_QUESTION_WAITS } from "../questions.ts";
import { runAfter } from "../write/moves.ts";
import { WRITE_LIMITS } from "../write/request.ts";
import { decodeRun } from "../write/runs.ts";
import {
  BRIEF,
  DESCRIPTION,
  endOf,
  findNode,
  KEY,
  parentFor,
  problem,
  read,
  refText,
  required,
  str,
  TITLE,
  type Check,
  type Input,
} from "./commands.ts";
import { asToday } from "./runs.ts";
import type { Command, Tx } from "./tx.ts";

type Run = Command["run"];

/** The reasons a run could not start or reach its provider: its time is tried again. */
const COULD_NOT_START = ["spawn_failed", "start_timed_out", "no_output", "service_ended"];

/** How long after a run that could not start its time is tried again. */
export const RETRY_MS = 15 * 60_000;

const SQL = {
  routine:
    "SELECT n.id, n.title, n.deleted_at, t.ref, t.lifecycle, r.rule, r.start, r.tz, r.due_date, " +
    "r.due_at, r.instance, r.instruction, r.role, r.paused, r.enabled_by FROM nodes n " +
    "JOIN tasks t ON t.id = n.id JOIN routines r ON r.id = n.id WHERE n.id = $id",
  entry:
    "SELECT id FROM occurrences WHERE routine_id = $routine AND due_date = $date " +
    "AND coalesce(due_at, 0) = coalesce($at, 0) AND deleted_at IS NULL",
  occurrence: "SELECT * FROM occurrences WHERE id = $id",
  run: "SELECT * FROM runs WHERE id = $id",
  /** The runs of a routine for one due time, newest first. */
  runsFor:
    "SELECT * FROM runs WHERE task_id = $id AND json_extract(spec, '$.due_at') = $due " +
    "ORDER BY attempt DESC",
  open: `SELECT 1 FROM runs r WHERE r.task_id = $id AND ${OPEN_RUN}`,
  question: `SELECT 1 FROM tasks t WHERE t.id = $id AND (${TREE_QUESTION_WAITS})`,
} as const;

/** A routine's time: a local date, with its instant when it has a time of day. */
interface Time {
  due_date: string;
  due_at: number | null;
}

const scheduleOf = (r: Row): Schedule => ({
  rule: String(r["rule"]),
  start: String(r["start"]),
  zone: String(r["tz"]),
});

const timeOf = (r: Row): Time => ({
  due_date: String(r["due_date"]),
  due_at: typeof r["due_at"] === "number" ? r["due_at"] : null,
});

const sameTime = (a: Time, b: Time): boolean => a.due_date === b.due_date && a.due_at === b.due_at;

const at = (instant: number, schedule: Schedule): Time => ({
  due_date: localDate(instant, schedule.zone),
  due_at: instant,
});

const none = (): never => problem("VALIDATION_FAILED", "The schedule has no time to come", "rule");

/**
 * The first time from now: today's date or later for a date only, the first instant after now
 * for a time of day. An agent's routine always has one (DEFAULT_RUN_TIME when the rule names none).
 */
function firstFrom(schedule: Schedule, agent: boolean, now: number): Time {
  if (agent || parseRule(schedule.rule)?.time != null) {
    const next = nextInstant(schedule, now - 1);
    return next === undefined ? none() : at(next, schedule);
  }
  const today = localDate(now, schedule.zone);
  const yesterday = dateOf((dayNumber(today) ?? 0) - 1);
  const date = nextDate(schedule, yesterday);
  return date === undefined ? none() : { due_date: date, due_at: null };
}

/** The open time after the open time `own` is done or skipped. */
function after(r: Row, own: Time, now: number): Time {
  const schedule = scheduleOf(r);
  if (r["instance"] !== null) {
    const next = nextInstant(schedule, own.due_at ?? now);
    return next === undefined ? none() : at(next, schedule);
  }
  const next = following(schedule, now, own.due_date);
  if (next === undefined) return none();
  return { due_date: next.date, due_at: next.at ?? null };
}

/** A live routine by its key, with its node, task and routine rows. */
function liveRoutine(tx: Tx, key: unknown): Row {
  const found = findNode(tx, key);
  if (found?.["kind"] !== "routine")
    return problem("NOT_FOUND", "The space has no such routine", "routine");
  const r = tx.get(SQL.routine, { id: String(found["id"]) }) as Row;
  if (r["deleted_at"] !== null) problem("DELETED", "The routine is in the Trash", "routine");
  return r;
}

const active = (r: Row): Row =>
  r["lifecycle"] === "active"
    ? r
    : problem("INVALID_TRANSITION", "The routine is finished", "routine");

/** Who does a routine, its words and switching an agent's routine on are the person's alone. */
function persons(tx: Tx, field = "routine"): void {
  if (tx.request.actor.actor_kind !== "human") {
    problem("USER_ONLY", "Only the person sets, pauses or switches on an agent's routine", field);
  }
}

const answer = (tx: Tx, r: Row, extra: Record<string, unknown> = {}) => ({
  routine: { id: r["id"], ref: refText(tx, r["ref"]), ...extra },
});

/** Cancels a queued run of the routine for `due`: the time was done or skipped without it. */
function cancelQueued(tx: Tx, routine: string, due: number | null): void {
  if (due === null) return;
  for (const row of tx.all(SQL.runsFor, { id: routine, due })) {
    if (row["state"] !== "queued") continue;
    const id = String(row["id"]);
    const moved = runAfter(
      decodeRun(asToday(row)),
      {
        run: id as Id<"ru">,
        expect: "queued",
        expect_version: Number(row["version"]),
        next: "cancelled",
      },
      tx.at,
    );
    if (moved !== undefined && "write" in moved)
      tx.set("runs", id, null, { state: { ...moved.write } }, false);
  }
}

interface Entry {
  state: "done" | "skipped";
  why?: "you" | "run_failed";
  run?: string;
  note?: string;
}

function addEntry(tx: Tx, routine: string, due: Time | null, entry: Entry): string {
  const id = tx.newId("oc");
  tx.create(
    "occurrences",
    {
      id,
      routine_id: routine,
      due_date: due?.due_date ?? null,
      due_at: due?.due_at ?? null,
      state: entry.state,
      actor_id: tx.author,
      at: tx.at,
      run_id: entry.run ?? null,
      why: entry.why ?? null,
      note: entry.note ?? null,
    },
    routine,
  );
  return id;
}

/**
 * Logs `due` done or skipped once, and moves the open time on when `due` is it. `based` false for
 * a run's own done, which decides on the routine as it is now.
 */
function log(
  tx: Tx,
  r: Row,
  due: Time | null,
  entry: Entry,
  based: boolean,
): { id: string; existing?: true; next?: Time } {
  const routine = String(r["id"]);
  if (due !== null) {
    const found = tx.get(SQL.entry, { routine, date: due.due_date, at: due.due_at });
    if (found !== undefined) return { id: String(found["id"]), existing: true };
  }
  const id = addEntry(tx, routine, due, entry);
  if (due === null || !sameTime(due, timeOf(r))) return { id };
  const next = after(r, due, tx.at);
  tx.set("routines", routine, routine, { open: { ...next } }, based);
  cancelQueued(tx, routine, due.due_at);
  return { id, next };
}

const routineSet: Run = (tx, input) => {
  if (input["instance"] !== undefined || input["instruction"] !== undefined) {
    persons(tx, "instance");
  }
  if (input["routine"] === undefined) return make(tx, input);
  const r = active(liveRoutine(tx, input["routine"]));
  const id = String(r["id"]);
  if (r["instance"] !== null) persons(tx);
  const node: Record<string, SqlValue> = {};
  for (const k of ["title", "brief", "description"])
    if (input[k] !== undefined) node[k] = str(input, k) ?? "";
  if (Object.keys(node).length > 0) tx.set("nodes", id, id, node);
  if (input["priority"] !== undefined)
    tx.set("tasks", id, id, { priority: Number(input["priority"]) });
  const instance = input["instance"] === undefined ? r["instance"] : input["instance"];
  const instruction = input["instruction"] === undefined ? r["instruction"] : input["instruction"];
  if ((instance === null) !== (instruction === null)) {
    problem(
      "VALIDATION_FAILED",
      "An agent's routine takes its words, and only an agent's",
      "instruction",
    );
  }
  const schedule: Schedule = {
    rule: str(input, "rule") ?? String(r["rule"]),
    start: str(input, "start") ?? String(r["start"]),
    zone: str(input, "tz") ?? String(r["tz"]),
  };
  if (readSchedule(schedule) === undefined) problem("VALIDATION_FAILED", "Not a schedule", "rule");
  const routine: Record<string, SqlValue | Record<string, SqlValue>> = {};
  const rescheduled = ["rule", "start", "tz"].some((k) => input[k] !== undefined);
  if (rescheduled)
    routine["schedule"] = { rule: schedule.rule, start: schedule.start, tz: schedule.zone };
  if (input["instance"] !== undefined) routine["instance"] = instance as SqlValue;
  if (input["instruction"] !== undefined) routine["instruction"] = instruction as SqlValue;
  const becomesAgents = (r["instance"] === null) !== (instance === null);
  // A new schedule, or a new kind of doer, starts at its first time from now.
  if (rescheduled || becomesAgents)
    routine["open"] = { ...firstFrom(schedule, instance !== null, tx.at) };
  if (becomesAgents) {
    routine["paused"] = {
      paused: r["paused"] as SqlValue,
      enabled_by: instance === null ? null : tx.request.actor.principal_id,
    };
  }
  if (Object.keys(routine).length > 0) tx.set("routines", id, id, routine);
  return answer(tx, r);
};

function make(tx: Tx, input: Input) {
  const parent = parentFor(tx, input["under"], "under");
  if (parent["kind"] === "task")
    problem("VALIDATION_FAILED", "A routine sits in the space or a project", "under");
  const instance = (input["instance"] ?? null) as string | null;
  const instruction = (input["instruction"] ?? null) as string | null;
  if ((instance === null) !== (instruction === null)) {
    problem(
      "VALIDATION_FAILED",
      "An agent's routine takes its words, and only an agent's",
      "instruction",
    );
  }
  const zone = String(input["tz"]);
  const schedule: Schedule = {
    rule: String(input["rule"]),
    start: str(input, "start") ?? localDate(tx.at, zone),
    zone,
  };
  if (readSchedule(schedule) === undefined) problem("VALIDATION_FAILED", "Not a schedule", "rule");
  const open = firstFrom(schedule, instance !== null, tx.at);
  const under = String(parent["id"]);
  const id = str(input, "id") ?? tx.newId("t");
  const ref = tx.ref();
  tx.create(
    "nodes",
    {
      id,
      kind: "routine",
      parent_id: under,
      position: endOf(tx, under, "routine"),
      title: str(input, "title") ?? "",
      brief: str(input, "brief") ?? "",
      description: str(input, "description") ?? "",
      created_at: tx.at,
      created_by: tx.author,
    },
    id,
  );
  tx.create(
    "tasks",
    { id, ref, priority: typeof input["priority"] === "number" ? input["priority"] : 4 },
    id,
  );
  tx.create(
    "routines",
    {
      id,
      rule: schedule.rule,
      start: schedule.start,
      tz: zone,
      ...open,
      instance,
      instruction,
      paused: 0,
      enabled_by: instance === null ? null : tx.request.actor.principal_id,
    },
    id,
  );
  return { routine: { id, ref: refText(tx, ref), due: open } };
}

const routinePaused =
  (paused: boolean): Run =>
  (tx, input) => {
    const r = active(liveRoutine(tx, input["routine"]));
    const id = String(r["id"]);
    const agents = r["instance"] !== null;
    if (agents) persons(tx);
    if ((r["paused"] === 1) === paused) return answer(tx, r);
    // Resume starts at the first time from now; switching an agent's routine on makes its runs the
    // person's who did.
    tx.set("routines", id, id, {
      paused: {
        paused: paused ? 1 : 0,
        enabled_by:
          paused || !agents ? (r["enabled_by"] as SqlValue) : tx.request.actor.principal_id,
      },
      ...(paused ? {} : { open: { ...firstFrom(scheduleOf(r), agents, tx.at) } }),
    });
    return answer(tx, r);
  };

/**
 * A time done: the open time, or a run's own due time. A run's done for a time that has its entry
 * already, by the person's check-off meanwhile, changes nothing: it never checks off the next.
 */
const routineDone: Run = (tx, input) => {
  const r = active(liveRoutine(tx, input["routine"]));
  const runId = str(input, "run");
  let due: Time | null = timeOf(r);
  if (runId !== undefined) {
    const run = tx.get(SQL.run, { id: runId });
    if (run === undefined || run["task_id"] !== r["id"])
      return problem("NOT_FOUND", "The routine has no such run", "run");
    const spec = JSON.parse(String(run["spec"])) as { due_at?: unknown };
    const own = typeof spec.due_at === "number" ? spec.due_at : null;
    if ((input["due"] ?? null) !== own)
      problem("VALIDATION_FAILED", "The run is for another time", "due");
    due = own === null ? null : at(own, scheduleOf(r));
  }
  const note = str(input, "note");
  const entry = log(
    tx,
    r,
    due,
    {
      state: "done",
      ...(runId === undefined ? {} : { run: runId }),
      ...(note === undefined ? {} : { note }),
    },
    runId === undefined,
  );
  return answer(tx, r, { entry, due: entry.next ?? timeOf(r) });
};

const routineSkip: Run = (tx, input) => {
  const r = active(liveRoutine(tx, input["routine"]));
  const entry = log(tx, r, timeOf(r), { state: "skipped", why: "you" }, true);
  return answer(tx, r, { entry, due: entry.next ?? timeOf(r) });
};

const routineLifecycle =
  (finished: boolean): Run =>
  (tx, input) => {
    persons(tx);
    const r = liveRoutine(tx, input["routine"]);
    const id = String(r["id"]);
    if ((r["lifecycle"] !== "active") === finished) return answer(tx, r);
    tx.set("tasks", id, id, {
      lifecycle: finished
        ? {
            lifecycle: "completed",
            completed_at: tx.at,
            completed_by: tx.request.actor.principal_id,
            archived_reason: null,
          }
        : { lifecycle: "active", completed_at: null, completed_by: null, archived_reason: null },
    });
    return answer(tx, r);
  };

/** An entry taken back or put back, with the open time it had: what Undo and Redo write. */
const routineEntry: Run = (tx, input) => {
  persons(tx, "entry");
  const entry = tx.get(SQL.occurrence, { id: String(input["entry"]) });
  if (entry === undefined) return problem("NOT_FOUND", "The routine has no such entry", "entry");
  const r = liveRoutine(tx, entry["routine_id"]);
  const routine = String(r["id"]);
  const removed = input["removed"] === true;
  if ((entry["deleted_at"] !== null) !== removed) {
    tx.set("occurrences", String(entry["id"]), routine, { deleted: removed ? tx.at : null });
  }
  const open = input["open"] as Time | undefined;
  if (open !== undefined && !sameTime(open, timeOf(r)))
    tx.set("routines", routine, routine, { open: { ...open } });
  return answer(tx, r, { entry: { id: entry["id"] } });
};

/**
 * The service's look at an agent's routine: when it is on, its open time has passed, no question
 * waits and no run of it is queued or working, a later slot that has passed skips the open time (a
 * time that had a run is logged "skipped: its run failed"; one missed while nothing ran leaves no
 * row) and takes its place; the open time then gets a run when it has none, or when its last
 * could not start RETRY_MS ago or more. The run carries the due time.
 */
const routineClaim: Run = (tx, input) => {
  const r = active(liveRoutine(tx, input["routine"]));
  const id = String(r["id"]);
  if (r["instance"] === null)
    return problem("VALIDATION_FAILED", "A routine you do has no runs", "routine");
  if (tx.request.actor.origin !== "system")
    problem("VALIDATION_FAILED", "Only the service claims a routine's time", "routine");
  if (tx.request.actor.principal_id !== r["enabled_by"]) {
    problem(
      "VALIDATION_FAILED",
      "A routine runs as the person who switched it on",
      "actor.principal_id",
    );
  }
  const now = tx.at;
  const open = timeOf(r);
  // An agent's routine always has a due time (the schema's CHECK).
  const dueAt = Number(open.due_at);
  const idle = (why: string) => ({ ...answer(tx, r), claimed: false, why });
  if (r["paused"] === 1) return idle("paused");
  if (dueAt > now) return idle("not_due");
  if (tx.get(SQL.open, { id }) !== undefined) return idle("working");
  if (tx.get(SQL.question, { id }) !== undefined) return idle("question");
  const slot = claim(scheduleOf(r), dueAt, now);
  let due = open;
  if (slot !== undefined && slot.due > dueAt) {
    if (tx.all(SQL.runsFor, { id, due: dueAt }).length > 0) {
      addEntry(tx, id, open, { state: "skipped", why: "run_failed" });
    }
    due = at(slot.due, scheduleOf(r));
    tx.set("routines", id, id, { open: { ...due } }, false);
  }
  const last = tx.all(SQL.runsFor, { id, due: due.due_at })[0];
  const retry =
    last !== undefined &&
    COULD_NOT_START.includes(String(last["reason"])) &&
    typeof last["ended_at"] === "number" &&
    last["ended_at"] <= now - RETRY_MS;
  if (last !== undefined && !retry) return idle("waiting");
  const made = tx.call("run.create", {
    ...(input["run"] as Input),
    task: id,
    instance: r["instance"],
    request: r["instruction"],
    due_at: due.due_at,
  }) as { run: { id: string } };
  return { ...answer(tx, r), claimed: true, run: made.run, due };
};

/** The request ID of a claim: a second start replays it, and a retry is a request of its own. */
export const claimRequestId = (routine: string, due: number, attempt: number): string =>
  `claim-${routine.slice(2)}-${String(due)}-${String(attempt)}`;

// ---------------------------------------------------------------------------------------------
// The checks

const RULE = { chars: 200, line: true } as const;
const INSTRUCTION = { bytes: RUN_REQUEST_MAX_BYTES } as const;

const checkSet: Check = (f) => {
  const making = !f.has("routine");
  if (making) for (const k of ["title", "rule", "tz"]) required(f, k);
  const out = read(f, {
    routine: (k) => f.text(k, KEY),
    id: (k) => f.id(k, "t"),
    under: (k) => f.text(k, KEY),
    title: (k) => f.text(k, TITLE),
    brief: (k) => f.text(k, BRIEF),
    description: (k) => f.text(k, DESCRIPTION),
    priority: (k) => f.int(k, 1, 4),
    rule: (k) => {
      const rule = f.text(k, RULE);
      return parseRule(rule) === undefined
        ? f.fail("VALIDATION_FAILED", "Not a schedule", k)
        : rule;
    },
    start: (k) => f.dateOrNull(k) ?? f.fail("VALIDATION_FAILED", "Expected a date YYYY-MM-DD", k),
    tz: (k) => {
      const zone = f.text(k, { chars: 64, line: true });
      return isTimeZone(zone) ? zone : f.fail("VALIDATION_FAILED", "Expected an IANA time zone", k);
    },
    instance: (k) => (f.raw(k) === null ? null : f.key(k)),
    instruction: (k) => f.nullableText(k, INSTRUCTION),
  });
  if (!making && (out["id"] !== undefined || out["under"] !== undefined)) {
    f.fail(
      "VALIDATION_FAILED",
      "A routine is placed when it is made",
      out["id"] === undefined ? "under" : "id",
    );
  }
  return out;
};

const oneRoutine: Check = (f) => {
  required(f, "routine");
  return read(f, { routine: (k) => f.text(k, KEY) });
};

const checkDone: Check = (f) => {
  required(f, "routine");
  const out = read(f, {
    routine: (k) => f.text(k, KEY),
    run: (k) => f.id(k, "ru"),
    due: (k) => f.instantOrNull(k),
    note: (k) => f.text(k, { bytes: WRITE_LIMITS.outcome }),
  });
  if (out["due"] !== undefined && out["run"] === undefined) {
    f.fail("VALIDATION_FAILED", "A due time is a run's", "due");
  }
  return out;
};

const checkEntry: Check = (f) => {
  required(f, "entry");
  required(f, "removed");
  const out = read(f, {
    entry: (k) => {
      const id = f.text(k, KEY);
      return isId(id, "oc") ? id : f.fail("VALIDATION_FAILED", "Expected an ID", k);
    },
    removed: (k) => f.boolean(k),
    open: (k) => {
      const o = f.sub(k);
      const time = { due_date: o.dateOrNull("due_date"), due_at: o.instantOrNull("due_at") };
      o.done();
      return time.due_date === null
        ? o.fail("VALIDATION_FAILED", "Expected a date", "due_date")
        : time;
    },
  });
  return out;
};

const checkClaim: Check = (f) => {
  required(f, "routine");
  required(f, "run");
  return read(f, {
    routine: (k) => f.text(k, KEY),
    // The run's own fields are checked as run.create checks them, inside the claim.
    run: (k) => {
      f.sub(k);
      return f.raw(k);
    },
  });
};

export const ROUTINES: Readonly<Record<string, Command>> = {
  "routine.set": { check: checkSet, run: routineSet },
  "routine.pause": { check: oneRoutine, run: routinePaused(true) },
  "routine.resume": { check: oneRoutine, run: routinePaused(false) },
  "routine.done": { check: checkDone, run: routineDone },
  "routine.skip": { check: oneRoutine, run: routineSkip },
  "routine.finish": { check: oneRoutine, run: routineLifecycle(true) },
  "routine.reopen": { check: oneRoutine, run: routineLifecycle(false) },
  "routine.entry": { check: checkEntry, run: routineEntry },
  "routine.claim": { check: checkClaim, run: routineClaim },
};
