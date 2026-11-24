// Fixture tasks in bulk for the list's end-to-end tests (A5 3.25: the design scale is 5,000 open
// tasks): written straight through the space's writer, before the service opens the space, in
// requests of 50 creates. Deterministic: task n is the same on every run, and its dates are set
// relative to the day the test runs, so the rows show late, soon and later dues, planned days,
// stars, every status chip, long titles and summaries. Fixture text only. Tests only.
import {
  formatAsOf,
  newId,
  openSpace,
  SpaceWriter,
  type Credential,
  type Id,
  type Operation,
} from "../../packages/storage/src/index.ts";
import { checkedDriver } from "../../packages/testkit/src/index.ts";
import {
  EFFORT_LEVELS,
  EFFORT_NAME_MAX,
  effortKeys,
  readPreference,
  type EffortLevel,
} from "../../packages/contracts/src/preferences.ts";
import { day } from "./days.ts";

const TITLES = [
  "Check the invoice totals",
  "Answer the clinic about the export",
  "Plan the sprint review",
  "Order new desk lamps",
  "Write the migration notes",
  "Repot the fig tree",
  "Compare the two backup reports",
  "Book the train to the offsite",
];

const LONG =
  "Investigate why the appointment reminders arrive twice for patients who booked through the " +
  "partner portal during the daylight saving change";

const SUMMARIES = [
  "",
  "Next: compare the totals with last month",
  "Waiting for the sample file",
  "Draft is half done; the tables still need numbers from the finance export",
];

const PEOPLE = ["Tom Haas", "Aiko Tanaka", "Ana Reyes"];
/** Mira's projects and areas, by slug (packages/testkit's seed). Undefined: the Inbox. */
const PLACES = ["lumen-portal", "clinic-sync", "garden", undefined, "lumen-portal", "garden"];

/** Task n's create operation. */
export function bulkTask(n: number): Operation {
  const status = ["open", "open", "open", "waiting", "review", "open", "backlog"][n % 7] ?? "open";
  const project = PLACES[n % PLACES.length];
  // Mixed so that no column follows another: each uses another part of n.
  const priority = (Math.floor(n / 6) % 4) + 1;
  const person = PEOPLE[Math.floor(n / 7) % PEOPLE.length] ?? null;
  const title =
    n % 13 === 0 ? `${LONG} (${String(n)})` : `${TITLES[n % TITLES.length] ?? ""} ${String(n)}`;
  return {
    kind: "task.create",
    title,
    summary: SUMMARIES[n % SUMMARIES.length] ?? "",
    status,
    inbox: project === undefined,
    priority,
    ...(project === undefined ? {} : { project }),
    ...(status === "waiting" && n % 5 !== 3 ? { waiting_on: person } : {}),
    ...(n % 5 === 0 ? { due: { date: day((n % 23) - 4).iso } } : {}),
    ...(n % 9 === 0 ? { planned_for: day(n % 6).iso } : {}),
    ...(n % 17 === 0 ? { focus: day(0).iso } : {}),
  };
}

type Machine = {
  readonly id: string;
  readonly name: string;
  readonly os: "linux" | "macos" | "windows";
};

/** A request's operations, or how to make them from what the space holds when it is sent. */
type Request = readonly Operation[] | ((read: (sql: string) => Row[]) => Operation[]);
type Row = Record<string, unknown>;

/**
 * Writes `requests` into the space at `folder`, as its owner, on the authority's machine, each
 * with the space as it stands as its base. `now` gets the request's index: the writer never lets a
 * commit's time go back past the last one.
 */
async function writeRequests(
  folder: string,
  machine: Machine,
  requests: readonly Request[],
  now: (request: number) => number,
): Promise<void> {
  const opened = openSpace(await checkedDriver(), folder, { role: "writer" });
  const human = opened.conn
    .prepare("SELECT id FROM actors WHERE kind = 'human' ORDER BY created_at LIMIT 1")
    .get<{ id: string }>();
  if (human === undefined) {
    opened.conn.close();
    throw new Error("the space has no owner actor");
  }
  let request = 0;
  const writer = SpaceWriter.open(opened, {
    machine: { id: machine.id as Id<"m">, name: machine.name, os: machine.os },
    now: () => now(request),
  });
  try {
    const actor: Credential = {
      scope_id: "cli:e2e-bulk",
      principal_id: human.id as Id<"ac">,
      actor_kind: "human",
      machine_id: machine.id as Id<"m">,
      origin: "cli",
    };
    const read = (sql: string): Row[] => opened.conn.prepare(sql).all();
    for (const given of requests) {
      const ops = typeof given === "function" ? given(read) : [...given];
      if (ops.length === 0) {
        request += 1;
        continue;
      }
      const result = writer.submit({
        space_id: opened.space.spaceId,
        request_id: newId("op").slice(3),
        actor,
        base: formatAsOf(writer.asOf()),
        ops,
      });
      request += 1;
      if (result.status !== "applied") {
        const why =
          result.error === undefined ? "" : `${result.error.code}: ${result.error.message}`;
        throw new Error(`a bulk request was ${result.status}: ${why}`);
      }
    }
  } finally {
    writer.close();
  }
}

/** Adds `count` tasks to the space at `folder`, in requests of 50 creates. */
export async function addBulkTasks(folder: string, machine: Machine, count: number): Promise<void> {
  const requests: Operation[][] = [];
  for (let from = 0; from < count; from += 50) {
    const ops: Operation[] = [];
    for (let n = from; n < Math.min(count, from + 50); n += 1) ops.push(bulkTask(n));
    requests.push(ops);
  }
  // Spread over the last ten days, so the rows' ages differ.
  const start = Date.now() - 10 * 86_400_000;
  await writeRequests(folder, machine, requests, (request) =>
    Math.floor(start + (request / requests.length) * 10 * 86_400_000),
  );
}

/**
 * The areas and projects a space grows into after some months of real use: with the sample's own
 * two areas and three projects, five areas and thirty-two projects, some with long names.
 */
const LARGE: readonly { readonly area: string; readonly projects: readonly string[] }[] = [
  {
    area: "Client work",
    projects: [
      "Brightside Bikes",
      "Harbor Dental",
      "Northwind Library (archive migration)",
      "Orchard Cafe",
      "Pinecrest School",
      "Riverside Clinic",
      "Sunset Studios",
      "Tidewater Museum",
    ],
  },
  {
    area: "lumen",
    projects: [
      "Developer portal (staging and docs)",
      "Release tooling",
      "Billing export",
      "Design system",
      "Performance profiling (power and memory)",
      "Support rotation",
    ],
  },
  {
    area: "Learning",
    projects: ["Rust book", "Spanish", "Photography basics", "Talks to watch", "Statistics"],
  },
  {
    area: "Errands and admin",
    projects: ["Car", "Taxes 2026", "Insurance renewal", "Moving house", "Recurring chores"],
  },
  { area: "home", projects: ["Kitchen renovation", "Bike repairs"] },
];

/**
 * Grows the space at `folder` to the size of a space in real use: five areas, thirty-two projects
 * and, with the sample's own, about a hundred open tasks spread over them in every status.
 */
export async function addLargeSpace(folder: string, machine: Machine): Promise<void> {
  const groups: Operation[] = [];
  const projects: string[] = [];
  for (const { area, projects: titles } of LARGE) {
    let areaRef = area;
    if (area !== "lumen" && area !== "home") {
      const id = newId("a");
      groups.push({ kind: "area.create", id, title: area });
      areaRef = id;
    }
    for (const title of titles) {
      const id = newId("p");
      groups.push({ kind: "project.create", id, title, area: areaRef });
      projects.push(id);
    }
  }
  const tasks: Operation[] = [];
  for (let n = 0; n < 84; n += 1) {
    const inbox = n % 12 === 5;
    const project = inbox ? undefined : projects[(n * 7) % projects.length];
    // The sample's project, if any, gives way to one of the grown space's.
    const made = { ...bulkTask(n), inbox } as Operation & { project?: string };
    delete made.project;
    tasks.push({ ...made, ...(project === undefined ? {} : { project }) });
  }
  const start = Date.now() - 10 * 86_400_000;
  await writeRequests(folder, machine, [groups, tasks.slice(0, 42), tasks.slice(42)], (request) =>
    Math.floor(start + request * 86_400_000),
  );
}

/** A space's own statuses and effort levels (`tasks.statuses`, `tasks.effort_scale`). */
export interface Scales {
  readonly statuses: readonly string[];
  /** Levels, or their names alone. */
  readonly efforts: readonly (string | EffortLevel)[];
}

/** The levels of a scale, a name alone as a level with nothing more. */
export const levelsOf = (scales: Scales): EffortLevel[] =>
  scales.efforts.map((level) => (typeof level === "string" ? { key: level } : level));

/** What resting on a level of `levels` says: its name, its time, what belongs on it. */
export function levelTip(key: string, levels: readonly EffortLevel[] = EFFORT_LEVELS): string {
  const level = levels.find((known) => known.key === key);
  const time = level?.time;
  const unit = time === undefined ? "" : time.amount === 1 ? time.unit.slice(0, -1) : time.unit;
  return `${key}${time === undefined ? "" : `, about ${String(time.amount)} ${unit}`}${level?.about === undefined ? "" : `. ${level.about}`}`;
}

/**
 * Sets the space's statuses and effort scale, as its owner. A scale never drops a status an
 * active task holds, so those tasks move to the first status first. The levels change as a
 * person changes them: the tasks on a level the new list leaves out, in any state, go with it to
 * no size. A level's name longer than a person sets now is stored as the earlier build that let
 * them set it did, past this build's writer.
 */
export async function setScales(folder: string, machine: Machine, scales: Scales): Promise<void> {
  const levels = levelsOf(scales);
  const names = levels.map((level) => level.key);
  const earlier = names.some((name) => name.length > EFFORT_NAME_MAX);
  const status = scales.statuses[0] ?? "open";
  await writeRequests(
    folder,
    machine,
    [
      (read) =>
        read(
          "SELECT id, status FROM tasks WHERE lifecycle = 'active' AND deleted_at IS NULL",
        ).flatMap((task): Operation[] =>
          scales.statuses.includes(String(task["status"]))
            ? []
            : [{ kind: "task.patch", task: String(task["id"]), set: { status } }],
        ),
      (read) => {
        const [row] = read(
          "SELECT value, schema_ver FROM preferences WHERE key = 'tasks.effort_scale'",
        );
        const stored =
          row === undefined
            ? undefined
            : { value: String(row["value"]), schemaVer: Number(row["schema_ver"]) };
        const now = effortKeys(readPreference("tasks.effort_scale", stored).value) ?? [];
        const moves = now.filter((key) => !names.includes(key)).map((from) => ({ from, to: null }));
        return [
          { kind: "pref.set", key: "tasks.statuses", value: [...scales.statuses] },
          ...(earlier
            ? []
            : [{ kind: "pref.set" as const, key: "tasks.effort_scale", value: levels, moves }]),
        ];
      },
    ],
    () => Date.now(),
  );
  if (!earlier) return;
  const opened = openSpace(await checkedDriver(), folder, { role: "writer" });
  try {
    opened.conn
      .prepare(
        "INSERT INTO preferences (key, value, schema_ver, policy, created_seq, version) " +
          "VALUES ('tasks.effort_scale', $value, 1, 0, 0, 0) " +
          "ON CONFLICT (key) DO UPDATE SET value = $value, schema_ver = 1",
      )
      .run({ value: JSON.stringify(levels) });
  } finally {
    opened.conn.close();
  }
}

/** Finished fixture tasks: completed and wrapped up, checked off (wrap-up waiting), dropped. */
export interface FinishedCounts {
  readonly done: number;
  readonly pending: number;
  readonly dropped: number;
}

/** Outcomes the done tasks take in turn: one line, several lines, and one longer than a row. */
const OUTCOMES = [
  "Done as planned.",
  "Repotted the herbs into the larger planters.\nEvidence: photos in the garden log.",
  "Moved the compost bins to the shady corner by the shed, turned both piles, added two bags " +
    "of leaves and a layer of grass cuttings, and checked the moisture again after the rain.",
];

/** Why the dropped tasks were dropped, in turn; the last gives no reason. */
const REASONS = ["The neighbours share theirs now.", "Too late in the season.", undefined];

/**
 * Adds finished tasks to the space at `folder`, each made and finished in one request, 25 a
 * request, a millisecond apart in the order they are made, all in this month: no month's end falls
 * among them. Each has a summary, which a row shows when the task has no ending.
 */
export async function addFinishedTasks(
  folder: string,
  machine: Machine,
  counts: FinishedCounts,
): Promise<void> {
  const requests: Operation[][] = [];
  const add = (count: number, how: keyof FinishedCounts, title: string) => {
    for (let from = 0; from < count; from += 25) {
      const ids = Array.from({ length: Math.min(25, count - from) }, () => newId("t"));
      requests.push([
        ...ids.map((id, i): Operation => ({
          kind: "task.create",
          id,
          title: `${title} ${String(from + i + 1)}`,
          summary: "Check the beds after the frost",
          project: "garden",
        })),
        ...ids.map((task, i): Operation => {
          const turn = (from + i) % 3;
          const reason = REASONS[turn];
          if (how === "dropped") {
            return { kind: "task.archive", task, ...(reason === undefined ? {} : { reason }) };
          }
          return how === "pending"
            ? { kind: "task.complete", task }
            : { kind: "task.complete", task, outcome: OUTCOMES[turn] ?? "" };
        }),
      ]);
    }
  };
  add(counts.done, "done", "Finished fixture task");
  add(counts.pending, "pending", "Checked off fixture task");
  add(counts.dropped, "dropped", "Dropped fixture task");
  const now = new Date();
  const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const first = Math.max(month, now.getTime() - requests.length);
  await writeRequests(folder, machine, requests, (request) => first + request);
}
