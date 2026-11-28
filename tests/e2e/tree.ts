// A space on the new storage, one tree of nodes, four levels of projects deep, for the browser tests
// that walk a tree space as a person. The tree's own commands make it before the service opens the
// space: today's entries make two levels at most. Made-up text only. Tests only.
import { join } from "node:path";
import {
  createSpace,
  DATABASE_FILE,
  openSpaceConnection,
  type CheckedDriver,
  type Id,
} from "../../packages/storage/src/index.ts";
import { TreeWriter, type TreeActor } from "../../packages/storage/src/tree/core.ts";
import { day } from "./days.ts";

/** A project of the tree: its ID, title and brief. */
export interface TreeProject {
  readonly id: string;
  readonly title: string;
  readonly brief: string;
}

/** A task of the tree: its ID, reference and title. */
export interface TreeTask {
  readonly id: string;
  readonly ref: string;
  readonly title: string;
}

/**
 * The tree, top down: Home (1) holds Renovation (2), which holds Kitchen (3), which holds Worktop
 * (4); Writing (1) holds Essays (2). Each project holds tasks of its own.
 */
export interface TreeSpace {
  readonly folder: string;
  readonly name: string;
  readonly home: TreeProject;
  readonly renovation: TreeProject;
  readonly kitchen: TreeProject;
  readonly worktop: TreeProject;
  readonly writing: TreeProject;
  readonly essays: TreeProject;
  /** In Worktop (4), for Today: its focus is today. Holds notes and a page. */
  readonly measure: TreeTask;
  /** In Worktop (4), waiting on the fitters. */
  readonly quote: TreeTask;
  /** In Kitchen (3). */
  readonly handles: TreeTask;
  /** In Renovation (2), for Review. */
  readonly electrician: TreeTask;
  /** In Home (1), due in a week. */
  readonly insurance: TreeTask;
  /** In Essays (2), in the backlog. */
  readonly rivers: TreeTask;
  /** In Kitchen (3), finished. */
  readonly tiles: TreeTask;
  /** The page on Kitchen (3): its title. */
  readonly page: string;
}

/** Makes the tree space in `folder` for `machine`, the service's own. */
export function makeTreeSpace(
  checked: CheckedDriver,
  folder: string,
  machine: Id<"m">,
  os: "linux" | "windows" | "macos",
): TreeSpace {
  const name = "Grove";
  createSpace(checked, folder, {
    name,
    refPrefix: "G",
    machineId: machine,
    ownerLabel: "user",
    tree: true,
  });
  const conn = openSpaceConnection(checked, join(folder, DATABASE_FILE), "writer");
  try {
    const writer = new TreeWriter(conn, { machineId: machine });
    writer.registerMachine({ name: "e2e-desktop", os });
    const spaceId = String(conn.prepare("SELECT space_id FROM space").get()?.["space_id"]);
    const person: TreeActor = {
      scope_id: "ui:e2e",
      principal_id: writer.actor("human", "user"),
      actor_kind: "human",
      machine_id: machine,
      origin: "ui",
    };
    let sent = 0;
    // Each change is based on the space as the one before it left it.
    let base: string | undefined;
    const send = (command: string, input: Record<string, unknown>): unknown => {
      sent += 1;
      const answer = writer.submit({
        space_id: spaceId,
        request_id: `e2e-tree-fixture-${String(sent).padStart(4, "0")}`,
        actor: person,
        command,
        input,
        ...(base === undefined ? {} : { base }),
      });
      if (answer.status !== "applied") {
        throw new Error(`the tree fixture was refused: ${JSON.stringify(answer.error)}`);
      }
      base = answer.as_of;
      return answer.result;
    };
    const project = (title: string, brief: string, under?: TreeProject): TreeProject => {
      const made = send("project.create", {
        title,
        brief,
        ...(under === undefined ? {} : { under: under.id }),
      }) as { project: { id: string } };
      return { id: made.project.id, title, brief };
    };
    const task = (
      title: string,
      under: TreeProject,
      more: Record<string, unknown> = {},
    ): TreeTask => {
      const made = send("tasks.add", {
        tasks: [{ title, under: under.id, ...more }],
      }) as { tasks: { id: string; ref: string }[] };
      const [one] = made.tasks;
      if (one === undefined) throw new Error("the tree fixture made no task");
      return { id: one.id, ref: one.ref, title };
    };

    const home = project("Home", "The house, its money and its paperwork");
    const renovation = project("Renovation", "The kitchen and the attic, this winter", home);
    const kitchen = project("Kitchen", "New cupboards and a worktop", renovation);
    const worktop = project("Worktop", "Oak or stone, fitted by March", kitchen);
    const writing = project("Writing", "Essays and letters in progress");
    const essays = project("Essays", "Short pieces for the quarterly", writing);

    const measure = task("Measure the corner for the worktop", worktop, {
      focus: day(0).iso,
      effort: "M",
    });
    const quote = task("Ask two fitters for a quote", worktop, {
      status: "waiting",
      waiting_on: "The fitters' replies",
    });
    const handles = task("Choose the cupboard handles", kitchen, { effort: "S" });
    const electrician = task("Book the electrician", renovation, { status: "review" });
    const insurance = task("Renew the home insurance", home, { due: { date: day(7).iso } });
    const rivers = task("Draft the essay on rivers", essays, { status: "backlog" });
    const tiles = task("Pick the wall tiles", kitchen);
    send("task.finish", { task: tiles.id });

    send("note.add", { on: measure.id, body: "The corner is not square: allow two centimetres." });
    send("note.add", { on: measure.id, body: "Measured twice, both walls.", kind: "progress" });
    const page = "Worktop materials";
    send("page.create", {
      on: kitchen.id,
      title: page,
      brief: "What oak and stone each ask of the kitchen",
      body: "Oak wants oil twice a year. Stone wants a template before it is cut.",
    });
    send("page.create", {
      on: measure.id,
      title: "Corner measurements",
      brief: "The corner's three lengths",
      body: "Left wall 182 cm, right wall 96 cm, depth 62 cm.",
    });

    return {
      folder,
      name,
      home,
      renovation,
      kitchen,
      worktop,
      writing,
      essays,
      measure,
      quote,
      handles,
      electrician,
      insurance,
      rivers,
      tiles,
      page,
    };
  } finally {
    conn.close();
  }
}
