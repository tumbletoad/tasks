// Synthetic fixture tasks for row U07: 5,000 open tasks in the fixture space Mira, spread over
// 30 areas and 200 projects (A5 3.25's UI fixture), in the collapsed-row shape of A5 3.6. The
// generator is seeded, so every run and every machine sees the same list. Fixture text only.

export type Status = "open" | "waiting" | "review" | "backlog";
export type SourceKind = "mail" | "chat" | "ticket" | "pr" | "doc" | "calendar" | "link";
export type Place = "here" | "missing" | "elsewhere" | "none";

export interface Task {
  id: number;
  ref: string;
  title: string;
  summary: string;
  area: number;
  project: number;
  status: Status;
  /** Days from today: negative is late, null has no due date. */
  due: number | null;
  /** Days since creation. */
  age: number;
  /** 1 to 4. 4 is the default, "no priority" (A5 U23). */
  priority: 1 | 2 | 3 | 4;
  sources: SourceKind[];
  place: Place;
  starred: boolean;
  marker: "changed" | "input" | null;
  /** The effective launch instance: 0 "Cc", 1 "Cx", 2 "T3". */
  instance: 0 | 1 | 2;
  waitingOn: string | null;
  /** Bumped by every event, so a memoised row re-renders only when its task changed. */
  v: number;
}

export interface Area {
  name: string;
  /** Colour slot 1-8 (A5 3.19). */
  slot: number;
}

export interface Project {
  name: string;
  area: number;
}

/** mulberry32: small, fast and seeded. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, list: readonly T[]): T =>
  list[Math.floor(random() * list.length)] as T;

const AREA_WORDS = [
  "Home",
  "Studio",
  "Garden",
  "Finance",
  "Health",
  "Travel",
  "Reading",
  "Music",
  "Kitchen",
  "Workshop",
  "Bikes",
  "Photos",
  "Letters",
  "Family",
  "Friends",
  "Moving",
  "Car",
  "Taxes",
  "Website",
  "Courses",
  "Volunteering",
  "Library",
  "Running",
  "Pottery",
  "Archive",
  "Admin",
  "Neighbours",
  "Holidays",
  "Repairs",
  "Planning",
] as const;

const PROJECT_WORDS = [
  "spring clean",
  "new shelves",
  "release 2.4",
  "photo book",
  "insurance review",
  "lease renewal",
  "seed swap",
  "app stores",
  "summer trip",
  "winter kit",
  "recipe box",
  "workbench",
  "newsletter",
  "tax return",
  "dentist plan",
  "garage sale",
  "reading list",
  "practice plan",
  "repair log",
  "label maker",
] as const;

const VERBS = [
  "Review",
  "Draft",
  "Fix",
  "Book",
  "Sort",
  "Plan",
  "Call about",
  "Order",
  "Update",
  "Check",
  "Write up",
  "Clean",
  "Replace",
  "Compare",
  "Send",
  "Collect",
  "Measure",
  "Paint",
  "Return",
  "Prepare",
] as const;

const OBJECTS = [
  "the appointment time zones",
  "the moving van",
  "new product photos",
  "the lease papers",
  "the bike chain",
  "the release notes",
  "the garden hose",
  "the photo backup",
  "the van quote",
  "the shelf brackets",
  "the recipe cards",
  "the travel insurance",
  "the window seals",
  "the library books",
  "the course notes",
  "the invoice batch",
  "the bathroom tiles",
  "the running shoes",
  "the kiln schedule",
  "the website footer",
  "the spare keys",
  "the guest list",
  "the tax receipts",
  "the boiler service",
] as const;

const SUMMARY_WORDS = [
  "Mira",
  "asked",
  "for",
  "a",
  "short",
  "update",
  "before",
  "Friday",
  "and",
  "the",
  "notes",
  "from",
  "Tuesday",
  "list",
  "two",
  "open",
  "questions",
  "about",
  "timing",
  "budget",
  "and",
  "who",
  "picks",
  "it",
  "up",
  "next",
  "week",
  "after",
  "the",
  "call",
] as const;

const PEOPLE = ["Tom", "Ana", "Joris", "Lena", "Sam", "Ines", "Piet", "Noor"] as const;
const SOURCE_KINDS: readonly SourceKind[] = [
  "mail",
  "chat",
  "ticket",
  "pr",
  "doc",
  "calendar",
  "link",
];

export interface Fixture {
  areas: Area[];
  projects: Project[];
  tasks: Task[];
}

export const AREA_COUNT = 30;
export const PROJECT_COUNT = 200;

function summary(random: () => number): string {
  const length = 8 + Math.floor(random() * 10);
  const words: string[] = [];
  for (let i = 0; i < length; i++) words.push(pick(random, SUMMARY_WORDS));
  const text = words.join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export function makeTask(random: () => number, id: number, projects: readonly Project[]): Task {
  const project = Math.floor(random() * projects.length);
  const statusRoll = random();
  const status: Status =
    statusRoll < 0.72
      ? "open"
      : statusRoll < 0.84
        ? "waiting"
        : statusRoll < 0.9
          ? "review"
          : "backlog";
  const dueRoll = random();
  const sourceCount = Math.floor(random() * random() * 5);
  const sources: SourceKind[] = [];
  for (let i = 0; i < sourceCount; i++) sources.push(pick(random, SOURCE_KINDS));
  const placeRoll = random();
  const markerRoll = random();
  return {
    id,
    ref: `M-${String(id + 1)}`,
    title: `${pick(random, VERBS)} ${pick(random, OBJECTS)}`,
    summary: summary(random),
    area: (projects[project] as Project).area,
    project,
    status,
    due: dueRoll < 0.45 ? null : Math.floor(random() * 60) - 12,
    age: Math.floor(random() * random() * 400),
    priority: (1 + Math.floor(random() * random() * 4)) as 1 | 2 | 3 | 4,
    sources,
    place:
      placeRoll < 0.55
        ? "here"
        : placeRoll < 0.62
          ? "missing"
          : placeRoll < 0.66
            ? "elsewhere"
            : "none",
    starred: random() < 0.08,
    marker: markerRoll < 0.04 ? "input" : markerRoll < 0.12 ? "changed" : null,
    instance: Math.floor(random() * 3) as 0 | 1 | 2,
    waitingOn: status === "waiting" ? pick(random, PEOPLE) : null,
    v: 0,
  };
}

/** The design-scale fixture: `count` open tasks (5,000 for U07). */
export function makeFixture(count: number, seed = 20261112): Fixture {
  const random = rng(seed);
  const areas: Area[] = AREA_WORDS.slice(0, AREA_COUNT).map((name, i) => ({
    name,
    slot: (i % 8) + 1,
  }));
  const projects: Project[] = [];
  for (let i = 0; i < PROJECT_COUNT; i++) {
    const area = i % AREA_COUNT;
    const word = PROJECT_WORDS[Math.floor(i / AREA_COUNT) % PROJECT_WORDS.length] ?? "misc";
    projects.push({
      name: `${word.charAt(0).toUpperCase()}${word.slice(1)} ${String(i + 1)}`,
      area,
    });
  }
  const tasks: Task[] = [];
  for (let id = 0; id < count; id++) tasks.push(makeTask(random, id, projects));
  return { areas, projects, tasks };
}

// --- Views: derive, sort and group the visible list (the part A5 3.25's view switch times).

export type ViewName = "area" | "due";

export type Item =
  | { kind: "area"; key: string; area: number }
  | { kind: "project"; key: string; project: number }
  | {
      kind: "task";
      key: string;
      task: Task;
      /** 1-based position among the tasks (aria-posinset). */ pos: number;
    };

const dueKey = (t: Task) => (t.due === null ? 10_000 : t.due);

/**
 * `area`: every task grouped by area, then project (area headings and project headings are
 * virtual items too, A5 3.25). `due`: one flat list by due date, then priority, then age.
 */
export function deriveView(tasks: readonly (Task | undefined)[], view: ViewName): Item[] {
  const live = tasks.filter((t): t is Task => t !== undefined);
  if (view === "due") {
    live.sort(
      (a, b) => dueKey(a) - dueKey(b) || a.priority - b.priority || b.age - a.age || a.id - b.id,
    );
    return live.map((task, i) => ({ kind: "task", key: `t${String(task.id)}`, task, pos: i + 1 }));
  }
  live.sort(
    (a, b) =>
      a.area - b.area ||
      a.project - b.project ||
      a.priority - b.priority ||
      dueKey(a) - dueKey(b) ||
      a.id - b.id,
  );
  const items: Item[] = [];
  let area = -1;
  let project = -1;
  let pos = 0;
  for (const task of live) {
    if (task.area !== area) {
      area = task.area;
      project = -1;
      items.push({ kind: "area", key: `a${String(area)}`, area });
    }
    if (task.project !== project) {
      project = task.project;
      items.push({ kind: "project", key: `p${String(project)}`, project });
    }
    pos++;
    items.push({ kind: "task", key: `t${String(task.id)}`, task, pos });
  }
  return items;
}

// --- Live events (A5 3.15 at spike level): patches, completions and new tasks.

export type LiveEvent =
  | {
      kind: "patch";
      id: number;
      field: "title" | "due" | "priority" | "starred" | "marker" | "status";
    }
  | { kind: "complete"; id: number }
  | { kind: "create" };

/** A burst of `count` events, about `visibleShare` of them on the given visible task ids. */
export function makeBurst(
  random: () => number,
  count: number,
  liveIds: readonly number[],
  visibleIds: readonly number[],
  visibleShare = 0.2,
): LiveEvent[] {
  const fields = ["title", "due", "priority", "starred", "marker", "status"] as const;
  const events: LiveEvent[] = [];
  for (let i = 0; i < count; i++) {
    const roll = random();
    const pool = visibleIds.length > 0 && random() < visibleShare ? visibleIds : liveIds;
    const id = pick(random, pool);
    if (roll < 0.05) events.push({ kind: "complete", id });
    else if (roll < 0.1) events.push({ kind: "create" });
    else events.push({ kind: "patch", id, field: pick(random, fields) });
  }
  return events;
}

/** Applies events in order to a copy of the task array. Returns the new array. */
export function applyEvents(
  random: () => number,
  tasks: readonly (Task | undefined)[],
  events: readonly LiveEvent[],
  projects: readonly Project[],
): (Task | undefined)[] {
  const next = tasks.slice();
  for (const event of events) {
    if (event.kind === "create") {
      next.push(makeTask(random, next.length, projects));
      continue;
    }
    const task = next[event.id];
    if (task === undefined) continue;
    if (event.kind === "complete") {
      next[event.id] = undefined;
      continue;
    }
    const patched: Task = { ...task, v: task.v + 1 };
    switch (event.field) {
      case "title":
        patched.title = `${pick(random, VERBS)} ${pick(random, OBJECTS)}`;
        break;
      case "due":
        patched.due = Math.floor(random() * 60) - 12;
        break;
      case "priority":
        patched.priority = (1 + Math.floor(random() * 4)) as 1 | 2 | 3 | 4;
        break;
      case "starred":
        patched.starred = !task.starred;
        break;
      case "marker":
        patched.marker = "changed";
        break;
      case "status":
        patched.status = task.status === "open" ? "waiting" : "open";
        patched.waitingOn = patched.status === "waiting" ? pick(random, PEOPLE) : null;
        break;
    }
    next[event.id] = patched;
  }
  return next;
}
