// Fixture tasks in bulk for the list's end-to-end tests (A5 3.25: the design scale is 5,000 open
// tasks): written straight through the space's writer, before the service opens the space, in
// requests of 50 creates. Deterministic: task n is the same on every run, and its dates are set
// relative to the day the test runs, so the rows show late, soon and later dues, planned days,
// stars, every status chip, long titles and summaries. Fixture text only. Tests only.
import {
  newId,
  openSpace,
  SpaceWriter,
  type Credential,
  type Id,
  type Operation,
} from "../../packages/storage/src/index.ts";
import { checkedDriver } from "../../packages/testkit/src/index.ts";

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

/** A local calendar date `days` from today, as the browser on this machine reads today. */
function day(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

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
    ...(n % 5 === 0 ? { due: { date: day((n % 23) - 4) } } : {}),
    ...(n % 9 === 0 ? { planned_for: day(n % 6) } : {}),
    ...(n % 17 === 0 ? { focus: day(0) } : {}),
  };
}

/** Adds `count` tasks to the space at `folder`, as its owner, on the authority's machine. */
export async function addBulkTasks(
  folder: string,
  machine: { readonly id: string; readonly name: string; readonly os: "linux" },
  count: number,
): Promise<void> {
  const opened = openSpace(await checkedDriver(), folder, { role: "writer" });
  const human = opened.conn
    .prepare("SELECT id FROM actors WHERE kind = 'human' ORDER BY created_at LIMIT 1")
    .get<{ id: string }>();
  if (human === undefined) {
    opened.conn.close();
    throw new Error("the space has no owner actor");
  }
  // The requests are spread over the last ten days, so the rows' ages differ. The writer never
  // lets a commit's time go back past the seed's last one.
  let request = 0;
  const requests = Math.ceil(count / 50);
  const start = Date.now() - 10 * 86_400_000;
  const writer = SpaceWriter.open(opened, {
    machine: { id: machine.id as Id<"m">, name: machine.name, os: machine.os },
    now: () => start + Math.floor((request / requests) * 10 * 86_400_000),
  });
  try {
    const actor: Credential = {
      scope_id: "cli:e2e-bulk",
      principal_id: human.id as Id<"ac">,
      actor_kind: "human",
      machine_id: machine.id as Id<"m">,
      origin: "cli",
    };
    for (let from = 0; from < count; from += 50) {
      const ops: Operation[] = [];
      for (let n = from; n < Math.min(count, from + 50); n += 1) ops.push(bulkTask(n));
      const result = writer.submit({
        space_id: opened.space.spaceId,
        request_id: newId("op").slice(3),
        actor,
        ops,
      });
      request += 1;
      if (result.status !== "applied") {
        throw new Error(`a bulk request was ${result.status}: ${result.error?.code ?? ""}`);
      }
    }
  } finally {
    writer.close();
  }
}
