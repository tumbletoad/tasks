// Fixture generators for the storage bench (A7 3.7 M0.04, A1 3.20). Every corpus is built from a
// seed, so the same seed gives the same rows on every machine: IDs, text and instants all come from
// the seeded source, never from the clock. The text is invented fixture text for Mira Okafor's
// space ("Mira", reference prefix M) and nothing else.
//
// A space with history has one commit per change, with its receipt and its change rows, and long
// text stored once in history_text (A1 3.4). The events of one task are contiguous in the commit
// sequence, which is simpler than a real interleaved timeline and gives the same row counts.
//
// Two text profiles. "default" is the calibrated corpus whose numbers the first runs recorded, and
// it must stay byte-identical (the fixed digests in storage-bench.test.ts). "heavy" writes longer
// note and log bodies and more of them, so notes and log entries come near A1 3.20's 80 MB.
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { withConnection } from "./connection.ts";
import type { TextProfile } from "./results.ts";
import { Rng } from "./rng.ts";
import { SCHEMA } from "./schema.ts";

export interface SpaceOptions {
  seed: string;
  open: number;
  completed: number;
  /** Write commits, receipts, changes and history_text. Without it the space holds rows only. */
  history: boolean;
  /** The space name and its reference prefix (A1 3.3). */
  name: string;
  prefix: string;
  /** The text profile. Default "default". */
  text?: TextProfile;
  /** Test hook: throw inside the open transaction before writing task number `faultAt` (0 based). */
  faultAt?: number;
}

export interface SpaceInfo {
  tasks: number;
  open: number;
  completed: number;
  notes: number;
  logEntries: number;
  sources: number;
  commits: number;
  searchDocs: number;
  lastSeq: number;
  /** SHA-256 over every row, read back from the database (corpusDigest). */
  digest: string;
  /** Size of the database file after a TRUNCATE checkpoint. */
  bytes: number;
  ms: number;
}

// ---------------------------------------------------------------------------------------------
// Fixture vocabulary. Invented content only.

const AREAS: readonly (readonly [slug: string, title: string])[] = [
  ["client-work", "Client work"],
  ["studio", "Studio"],
  ["home", "Home"],
  ["health", "Health"],
  ["learning", "Learning"],
  ["admin", "Admin"],
];

const PROJECTS: readonly (readonly [slug: string, title: string, area: number])[] = [
  ["lumen-portal", "Lumen portal", 0],
  ["lumen-mobile", "Lumen mobile app", 0],
  ["harbor-api", "Harbor API", 0],
  ["orchard-site", "Orchard website", 0],
  ["tide-billing", "Tide billing", 0],
  ["kiln-dashboard", "Kiln dashboard", 1],
  ["sketchbook", "Sketchbook", 1],
  ["open-source", "Open-source maintenance", 1],
  ["garden", "Garden", 2],
  ["kitchen-renovation", "Kitchen renovation", 2],
  ["bike", "Bike", 2],
  ["running-plan", "Running plan", 3],
  ["rust-course", "Rust course", 4],
  ["spanish", "Spanish lessons", 4],
  ["taxes-2026", "Taxes 2026", 5],
  ["insurance", "Insurance", 5],
];

export const VERBS = [
  "Fix",
  "Review",
  "Draft",
  "Update",
  "Migrate",
  "Test",
  "Plan",
  "Write",
  "Check",
  "Prepare",
  "Refactor",
  "Document",
  "Schedule",
  "Clean up",
  "Investigate",
  "Book",
  "Reply to",
  "Measure",
  "Order",
  "Compare",
] as const;

export const OBJECTS = [
  "appointment time zones",
  "the release notes",
  "the invoice export",
  "the login flow",
  "the staging data",
  "the CI runner",
  "the reminders service",
  "the search index",
  "the onboarding email",
  "the backup script",
  "the client brief",
  "the quarterly report",
  "the dentist appointment",
  "the bike brakes",
  "the garden irrigation",
  "the cache headers",
  "the payment webhook",
  "the accessibility audit",
  "the error budget",
  "the database migration",
  "the design tokens",
  "the photo archive",
  "the spare-room shelves",
  "the conference talk",
  "the API rate limits",
  "the mobile push setup",
  "the date picker",
  "the contract renewal",
  "the sprint retro notes",
  "the dependency upgrades",
] as const;

export const QUALIFIERS = [
  "",
  "",
  "",
  " before Friday",
  " for the Lumen demo",
  " after the DST change",
  " on staging",
  " with the new runner",
  " for next week",
  " in the shared drive",
  " for the client call",
] as const;

const SUBJECTS = [
  "The export",
  "The staging build",
  "The reminder job",
  "Mira",
  "The client",
  "The test suite",
  "The migration",
  "The new runner",
  "The search page",
  "The webhook handler",
  "The mobile app",
  "The invoice template",
  "The nightly backup",
  "The date picker",
] as const;

const PREDICATES = [
  "fails when the time zone changes",
  "needs a second review",
  "runs twice after a restart",
  "shows the wrong total for the last month",
  "is blocked on the API key rotation",
  "works on desktop but not on mobile",
  "takes about four minutes longer than last week",
  "should move to the new queue",
  "still uses the old date format",
  "needs a short note in the changelog",
  "was rolled back on Tuesday",
  "depends on the vendor's fix",
  "passes locally and fails in CI",
  "has no owner yet",
  "converts appointment dates twice",
  "drops the last row of the invoice export",
] as const;

const TAILS = [
  "",
  "",
  " Check the logs from Monday.",
  " Ask on the client channel.",
  " Keep the old path until the release.",
  " Reproduce with the staging data.",
  " See the ticket for the trace.",
  " Compare with last quarter.",
] as const;

const SOURCE_KINDS = ["email", "ticket", "chat", "pr", "doc", "calendar"] as const;
const SOURCE_TITLES = [
  "Wrong appointment times since Sunday",
  "Appointments off by one hour",
  "Invoice totals do not match",
  "Login loops on the mobile app",
  "Question about the release date",
  "Runner migration checklist",
  "Backup failed overnight",
  "Feedback on the onboarding email",
] as const;
const WHO = ["Ana Reyes", "Jonas", "Lumen support", "Harbor ops", "Mira"] as const;
const STATUSES = ["open", "open", "open", "waiting", "in-progress"] as const;
const LOG_KINDS = ["progress", "progress", "evidence", "blocker", "decision", "handoff"] as const;
const EFFORTS = ["S", "M", "L", null] as const;

const sentence = (rng: Rng): string =>
  `${rng.pick(SUBJECTS)} ${rng.pick(PREDICATES)}.${rng.pick(TAILS)}`;

/** A one-line task summary, as the benchmarks' patches write it. */
export const summaryText = sentence;

function sentences(rng: Rng, min: number, max: number): string {
  const n = rng.range(min, max);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(sentence(rng));
  return out.join(" ");
}

/** Agent-maintained Markdown of a few paragraphs and a step list, about 0.2 to 2 KB. */
function context(rng: Rng): string {
  const parts: string[] = [];
  const paragraphs = rng.range(1, 2);
  for (let i = 0; i < paragraphs; i++) parts.push(sentences(rng, 2, 4));
  if (rng.chance(0.4)) {
    const steps: string[] = [];
    for (let i = rng.range(2, 4); i > 0; i--) steps.push(`- ${sentence(rng)}`);
    parts.push(`Steps:\n${steps.join("\n")}`);
  }
  return parts.join("\n\n");
}

export const title = (rng: Rng): string =>
  `${rng.pick(VERBS)} ${rng.pick(OBJECTS)}${rng.pick(QUALIFIERS)}`;

/** A seeded Fisher-Yates shuffle into a new array. */
function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let k = out.length - 1; k > 0; k--) {
    const j = rng.int(k + 1);
    const a = out[k] as T;
    out[k] = out[j] as T;
    out[j] = a;
  }
  return out;
}

const DAY = 86_400_000;
const START = Date.UTC(2024, 0, 8, 8, 0, 0);
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const position = (i: number): string => `a${i.toString(36).padStart(5, "0")}`;
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

interface Actor {
  id: string;
  kind: "human" | "agent" | "routine" | "system";
  label: string;
  scope: string;
}

interface Change {
  entity: string;
  entityId: string;
  taskId: string;
  action: "create" | "set";
  field: string | null;
  before: unknown;
  after: unknown;
  beforeVer: number | null;
}

// ---------------------------------------------------------------------------------------------

/**
 * Builds one space database at `path` (which must not exist) and returns its counts and digest.
 * On a failure the open transaction is rolled back and the connection closed before the error
 * leaves, so the caller can remove the folder.
 */
export function generateSpace(path: string, options: SpaceOptions): SpaceInfo {
  const started = performance.now();
  const filled = withConnection(new DatabaseSync(path), (db) => {
    const counts = fill(db, options);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return counts;
  });
  return {
    tasks: options.open + options.completed,
    open: options.open,
    completed: options.completed,
    ...filled,
    digest: corpusDigest(path),
    bytes: statSync(path).size,
    ms: Math.round(performance.now() - started),
  };
}

/** Text lengths per profile: [min, max] sentences, and the chance of a second note. */
// The default profile draws no random numbers for the extras, so its sequence stays unchanged.
const PROFILES: Record<
  TextProfile,
  { note: [number, number]; log: [number, number]; extraNote: number; extraLog: number }
> = {
  default: { note: [1, 3], log: [1, 4], extraNote: 0, extraLog: 0 },
  heavy: { note: [3, 10], log: [4, 12], extraNote: 0.35, extraLog: 0.5 },
};

function fill(
  db: DatabaseSync,
  options: SpaceOptions,
): {
  notes: number;
  logEntries: number;
  sources: number;
  commits: number;
  searchDocs: number;
  lastSeq: number;
} {
  const rng = new Rng(options.seed);
  const text = options.text ?? "default";
  const profile = PROFILES[text];
  // Generation speed only: the fixture is rebuilt from the seed if anything goes wrong.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA cache_size = -200000;");
  db.exec(SCHEMA);

  const prepare = (sql: string): StatementSync => db.prepare(sql);
  const ins = {
    actor: prepare("INSERT INTO actors (id, kind, label, created_at) VALUES (?, ?, ?, ?)"),
    area: prepare(
      "INSERT INTO areas (id, slug, title, position, created_at, created_by, created_seq, version) VALUES (?, ?, ?, ?, ?, ?, 0, 0)",
    ),
    project: prepare(
      "INSERT INTO projects (id, area_id, slug, title, position, brief, created_at, created_by, created_seq, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
    ),
    task: prepare(`INSERT INTO tasks (id, ref, title, summary, context, lifecycle, status, priority,
      effort, due_date, planned_for, area_id, project_id, position, completed_at, completed_by,
      wrap_state, outcome, wrapped_at, wrapped_by, created_at, created_by, created_seq, version,
      touched, fv, fp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    note: prepare(`INSERT INTO notes (id, task_id, ordinal, author_id, addressee, body, created_at,
      created_seq, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    log: prepare(`INSERT INTO log_entries (id, task_id, ordinal, author_id, kind, body, created_at,
      created_seq, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    source: prepare(`INSERT INTO sources (id, source_key, kind, title, who, ref, at, created_at,
      created_by, created_seq, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    taskSource: prepare(`INSERT INTO task_sources (task_id, source_id, position, added_by,
      created_seq, version) VALUES (?, ?, 'a0', ?, ?, ?)`),
    commit: prepare(`INSERT INTO commits (seq, id, epoch, incarnation, at, actor_kind, principal_id,
      author_id, scope_id, machine_id, session_id, origin, request_id, kind, ops, affected)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ops', ?, ?)`),
    receipt: prepare(`INSERT INTO receipts (scope_id, request_id, fingerprint, status, seq, epoch,
      incarnation, result, at) VALUES (?, ?, ?, 'applied', ?, 1, ?, ?, ?)`),
    change: prepare(`INSERT INTO changes (seq, n, op, entity, entity_id, task_id, action, field,
      before, after, before_ver, before_prov, after_prov) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    text: prepare("INSERT OR IGNORE INTO history_text (hash, text) VALUES (?, ?)"),
    doc: prepare(
      "INSERT INTO search_docs (doc, kind, entity_id, task_id, lifecycle, seq) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    fts: prepare("INSERT INTO search_fts (rowid, title, body, extra) VALUES (?, ?, ?, ?)"),
  };

  const spaceId = rng.id("sp");
  const machineId = rng.id("m");
  const incarnation = rng.id("ai");
  let at = START;
  let seq = 0;
  let doc = 0;
  const counts = { notes: 0, logEntries: 0, sources: 0, commits: 0 };

  db.exec("BEGIN");
  const actors: Actor[] = [
    { id: rng.id("ac"), kind: "human", label: "Mira", scope: "ui" },
    { id: rng.id("ac"), kind: "agent", label: "Codex · work", scope: "" },
    { id: rng.id("ac"), kind: "agent", label: "Claude · studio", scope: "" },
    { id: rng.id("ac"), kind: "routine", label: "Refresh from sources", scope: "" },
  ];
  for (const a of actors) {
    a.scope = a.kind === "human" ? `ui_${a.id.slice(3)}` : `se_${rng.id("se").slice(3)}`;
    ins.actor.run(a.id, a.kind, a.label, START);
  }
  const human = actors[0] as Actor;
  const areaIds = AREAS.map(([slug, areaTitle], i) => {
    const id = rng.id("a");
    ins.area.run(id, slug, areaTitle, position(i), START, human.id);
    return id;
  });
  const projectIds = PROJECTS.map(([slug, projectTitle, area], i) => {
    const id = rng.id("p");
    ins.project.run(
      id,
      areaIds[area] ?? null,
      slug,
      projectTitle,
      position(i),
      sentences(rng, 1, 3),
      START,
      human.id,
    );
    return id;
  });
  db.prepare(
    `INSERT INTO space (one, space_id, name, ref_prefix, format_major, format_minor,
      authority_machine, authority_incarnation, lineage, created_at)
     VALUES (1, ?, ?, ?, 0, 3, ?, ?, ?, ?)`,
  ).run(
    spaceId,
    options.name,
    options.prefix,
    machineId,
    incarnation,
    JSON.stringify({
      forked_from: null,
      incarnations: [{ incarnation, epoch: 1, kind: "create" }],
    }),
    START,
  );

  /** Long text is stored once in history_text and referenced by hash (A1 3.4). */
  const textRef = (s: string): unknown => {
    if (Buffer.byteLength(s) < 1024) return s;
    const hash = sha256(s);
    if (options.history) ins.text.run(hash, s);
    return { $t: hash };
  };

  /** Writes one commit with its changes and receipt, and returns its seq. */
  const commit = (actor: Actor, ops: unknown[], changes: Change[], affected = 0): number => {
    seq += 1;
    at += rng.range(10_000, 360_000);
    if (!options.history) return seq;
    counts.commits += 1;
    const opId = rng.id("op");
    const requestId = rng.id("rq").slice(3);
    const origin = actor.kind === "human" ? "ui" : actor.kind === "routine" ? "system" : "mcp";
    const opsJson = JSON.stringify(ops);
    ins.commit.run(
      seq,
      opId,
      incarnation,
      at,
      actor.kind,
      actor.id,
      actor.id,
      actor.scope,
      machineId,
      actor.kind === "agent" ? actor.scope : null,
      origin,
      requestId,
      opsJson,
      affected,
    );
    changes.forEach((c, n) => {
      ins.change.run(
        seq,
        n,
        c.entity,
        c.entityId,
        c.taskId,
        c.action,
        c.field,
        c.before === undefined ? null : JSON.stringify(c.before),
        JSON.stringify(c.after),
        c.beforeVer,
        c.beforeVer,
        seq,
      );
    });
    const result = {
      status: "applied",
      epoch: 1,
      seq,
      commit: opId,
      results: [{ i: 0, status: c0(changes) }],
      warnings: [],
    };
    ins.receipt.run(
      actor.scope,
      requestId,
      sha256(`${spaceId}${opsJson}`),
      seq,
      incarnation,
      JSON.stringify(result),
      at,
    );
    return seq;
  };
  const c0 = (changes: Change[]): string =>
    changes[0]?.action === "create" ? "created" : "updated";

  const addDoc = (
    kind: string,
    entityId: string,
    taskId: string,
    lifecycle: string,
    docSeq: number,
    t: string,
    body: string,
    extra: string,
  ): void => {
    doc += 1;
    ins.doc.run(doc, kind, entityId, taskId, lifecycle, docSeq);
    ins.fts.run(doc, t, body, extra);
  };

  const total = options.open + options.completed;
  let openLeft = options.open;
  let completedLeft = options.completed;
  for (let i = 0; i < total; i++) {
    if (i % 250 === 0 && i > 0) {
      db.exec("COMMIT");
      db.exec("BEGIN");
    }
    if (i === options.faultAt) {
      throw new Error(`injected fault: generation stopped before task ${String(i)}`);
    }
    // Exact counts, spread at random over the reference range.
    const done = rng.float() * (openLeft + completedLeft) < completedLeft;
    if (done) completedLeft -= 1;
    else openLeft -= 1;

    const id = rng.id("t");
    const ref = i + 1;
    const project = rng.chance(0.8) ? rng.int(PROJECTS.length) : -1;
    const areaIndex = project >= 0 ? (PROJECTS[project]?.[2] ?? 0) : rng.int(AREAS.length);
    const areaId = areaIds[areaIndex] ?? null;
    const projectId = project >= 0 ? (projectIds[project] ?? null) : null;
    const author = rng.chance(0.55) ? human : rng.pick(actors);
    const createdAt = at;
    const row = {
      title: title(rng),
      summary: sentence(rng),
      context: context(rng),
      status: rng.pick(STATUSES) as string,
      priority: rng.chance(0.7) ? 4 : rng.range(1, 3),
      effort: rng.pick(EFFORTS),
      due: !done && rng.chance(0.25) ? isoDay(createdAt + rng.range(1, 60) * DAY) : null,
      planned: !done && rng.chance(0.15) ? isoDay(createdAt + rng.range(0, 14) * DAY) : null,
    };
    const fv: Record<string, number> = {};
    const createSeq = commit(
      author,
      [
        {
          op: "task.create",
          input: { title: row.title, summary: row.summary, context: textRef(row.context) },
        },
      ],
      [
        {
          entity: "tasks",
          entityId: id,
          taskId: id,
          action: "create",
          field: null,
          before: undefined,
          beforeVer: null,
          after: {
            id,
            ref,
            title: row.title,
            summary: row.summary,
            context: textRef(row.context),
            status: row.status,
            priority: row.priority,
            effort: row.effort,
            due_date: row.due,
            area_id: areaId,
            project_id: projectId,
            position: position(i),
            created_at: createdAt,
            created_by: author.id,
          },
        },
      ],
    );
    let version = createSeq;
    let touched = createSeq;

    // Children and edits, in a seeded order. The task's search document is written at the end,
    // with its final text.
    const notes: {
      id: string;
      ordinal: number;
      author: Actor;
      addressee: string;
      body: string;
      at: number;
      seq: number;
    }[] = [];
    const logs: {
      id: string;
      ordinal: number;
      author: Actor;
      kind: string;
      body: string;
      at: number;
      seq: number;
    }[] = [];
    const events: ("note" | "log" | "patch")[] = [];
    if (rng.chance(0.3)) events.push("note");
    for (let n = rng.range(0, 2) - (rng.chance(0.5) ? 1 : 0); n > 0; n--) events.push("log");
    if (rng.chance(0.3)) events.push("patch");
    if (profile.extraNote > 0 && rng.chance(profile.extraNote)) events.push("note");
    if (profile.extraLog > 0 && rng.chance(profile.extraLog)) events.push("log");
    for (const event of shuffle(rng, events)) {
      const by = rng.chance(0.4) ? human : rng.pick(actors);
      if (event === "note") {
        const note = {
          id: rng.id("n"),
          ordinal: notes.length + 1,
          author: by,
          addressee: rng.chance(0.3) ? "agents" : "self",
          body: sentences(rng, ...profile.note),
          at: 0,
          seq: 0,
        };
        note.seq = commit(
          by,
          [{ op: "note.add", task: id, body: textRef(note.body) }],
          [
            {
              entity: "notes",
              entityId: note.id,
              taskId: id,
              action: "create",
              field: null,
              before: undefined,
              beforeVer: null,
              after: {
                id: note.id,
                task_id: id,
                ordinal: note.ordinal,
                author_id: by.id,
                addressee: note.addressee,
                body: textRef(note.body),
              },
            },
          ],
        );
        note.at = at;
        notes.push(note);
        touched = note.seq;
      } else if (event === "log") {
        const entry = {
          id: rng.id("l"),
          ordinal: logs.length + 1,
          author: by,
          kind: rng.pick(LOG_KINDS) as string,
          body: sentences(rng, ...profile.log),
          at: 0,
          seq: 0,
        };
        entry.seq = commit(
          by,
          [{ op: "log.append", task: id, kind: entry.kind, body: textRef(entry.body) }],
          [
            {
              entity: "log_entries",
              entityId: entry.id,
              taskId: id,
              action: "create",
              field: null,
              before: undefined,
              beforeVer: null,
              after: {
                id: entry.id,
                task_id: id,
                ordinal: entry.ordinal,
                author_id: by.id,
                kind: entry.kind,
                body: textRef(entry.body),
              },
            },
          ],
        );
        entry.at = at;
        logs.push(entry);
        touched = entry.seq;
      } else {
        const kind = rng.pick(["summary", "summary", "context", "status", "priority"] as const);
        let before: unknown;
        let after: unknown;
        if (kind === "summary") {
          before = row.summary;
          row.summary = sentence(rng);
          after = row.summary;
        } else if (kind === "context") {
          before = textRef(row.context);
          row.context = `${row.context}\n\n${sentences(rng, 2, 5)}`;
          after = textRef(row.context);
        } else if (kind === "status") {
          before = row.status;
          row.status = rng.pick(STATUSES);
          after = row.status;
        } else {
          before = row.priority;
          row.priority = rng.range(1, 4);
          after = row.priority;
        }
        const s = commit(
          by,
          [
            {
              op: kind === "context" ? "task.context_append" : "task.patch",
              task: id,
              field: kind,
            },
          ],
          [
            {
              entity: "tasks",
              entityId: id,
              taskId: id,
              action: "set",
              field: kind,
              before,
              after,
              beforeVer: fv[kind] ?? createSeq,
            },
          ],
        );
        fv[kind] = s;
        version = s;
        touched = s;
      }
    }

    let completedAt: number | null = null;
    let completedBy: string | null = null;
    let outcome: string | null = null;
    if (done) {
      const by = rng.chance(0.7) ? human : rng.pick(actors);
      outcome = sentences(rng, 1, 3);
      const s = commit(
        by,
        [{ op: "task.complete", task: id, outcome: textRef(outcome) }],
        [
          {
            entity: "tasks",
            entityId: id,
            taskId: id,
            action: "set",
            field: "lifecycle",
            before: { lifecycle: "active" },
            after: { lifecycle: "completed", completed_at: at, completed_by: by.id },
            beforeVer: createSeq,
          },
          {
            entity: "tasks",
            entityId: id,
            taskId: id,
            action: "set",
            field: "wrap",
            before: null,
            after: { wrap_state: "wrapped", outcome: textRef(outcome) },
            beforeVer: createSeq,
          },
        ],
        1,
      );
      completedAt = at;
      completedBy = by.id;
      row.status = "done";
      fv["lifecycle"] = s;
      fv["wrap"] = s;
      version = s;
      touched = s;
    }

    const fvJson = JSON.stringify(fv);
    ins.task.run(
      id,
      ref,
      row.title,
      row.summary,
      row.context,
      done ? "completed" : "active",
      row.status,
      row.priority,
      row.effort,
      row.due,
      row.planned,
      areaId,
      projectId,
      position(i),
      completedAt,
      completedBy,
      done ? "wrapped" : null,
      outcome,
      completedAt,
      completedBy,
      createdAt,
      author.id,
      createSeq,
      version,
      touched,
      fvJson,
      fvJson,
    );
    for (const n of notes)
      ins.note.run(n.id, id, n.ordinal, n.author.id, n.addressee, n.body, n.at, n.seq, n.seq);
    for (const l of logs)
      ins.log.run(l.id, id, l.ordinal, l.author.id, l.kind, l.body, l.at, l.seq, l.seq);
    counts.notes += notes.length;
    counts.logEntries += logs.length;

    let sourceText = "";
    if (rng.chance(0.5)) {
      const sourceId = rng.id("s");
      const kind = rng.pick(SOURCE_KINDS);
      const sourceTitle = rng.pick(SOURCE_TITLES);
      const who = rng.pick(WHO);
      const sourceRef = kind === "ticket" ? `LUM-${String(rng.range(100, 999))}` : null;
      ins.source.run(
        sourceId,
        `${kind}:${sourceId.slice(2)}`,
        kind,
        sourceTitle,
        who,
        sourceRef,
        createdAt - DAY,
        createdAt,
        author.id,
        createSeq,
        createSeq,
      );
      ins.taskSource.run(id, sourceId, author.id, createSeq, createSeq);
      counts.sources += 1;
      sourceText = [sourceTitle, who, sourceRef].filter((x) => x !== null).join(" ");
    }

    const lifecycle = done ? "completed" : "active";
    const projectTitle = project >= 0 ? (PROJECTS[project]?.[1] ?? "") : "";
    const extra = [
      sourceText,
      projectTitle,
      AREAS[areaIndex]?.[1] ?? "",
      `${options.prefix}-${String(ref)}`,
    ]
      .filter((x) => x !== "")
      .join(" · ");
    addDoc(
      "task",
      id,
      id,
      lifecycle,
      version,
      row.title,
      [row.summary, row.context, outcome ?? ""].join("\n\n"),
      extra,
    );
    for (const n of notes)
      addDoc("note", n.id, id, lifecycle, n.seq, row.title, n.body, n.author.label);
    for (const l of logs)
      addDoc("log", l.id, id, lifecycle, l.seq, row.title, l.body, l.author.label);
  }
  db.prepare("UPDATE space SET last_seq = ?, next_ref = ?").run(seq, total + 1);
  db.exec("COMMIT");
  return { ...counts, searchDocs: doc, lastSeq: seq };
}

export interface TextSizes {
  count: number;
  /** Bytes of UTF-8, nearest-rank. */
  median: number;
  p95: number;
  totalBytes: number;
}

const TEXT_KINDS: readonly (readonly [kind: string, table: string, column: string])[] = [
  ["title", "tasks", "title"],
  ["summary", "tasks", "summary"],
  ["context", "tasks", "context"],
  ["outcome", "tasks", "outcome"],
  ["note", "notes", "body"],
  ["log", "log_entries", "body"],
];

/** Count, median, p95 and total bytes of every kind of text in a space (corpus.json). */
export function textSizes(path: string): Record<string, TextSizes> {
  return withConnection(new DatabaseSync(path, { readOnly: true }), (db) => {
    const out: Record<string, TextSizes> = {};
    for (const [kind, table, column] of TEXT_KINDS) {
      const stmt = db.prepare(
        `SELECT length(CAST(${column} AS BLOB)) FROM ${table} WHERE ${column} IS NOT NULL ORDER BY 1`,
      );
      stmt.setReturnArrays(true);
      const sizes = (stmt.all() as unknown as [number][]).map((r) => r[0]);
      const at = (p: number): number =>
        sizes[Math.max(0, Math.ceil((p / 100) * sizes.length) - 1)] ?? 0;
      out[kind] = {
        count: sizes.length,
        median: at(50),
        p95: at(95),
        totalBytes: sizes.reduce((a, b) => a + b, 0),
      };
    }
    return out;
  });
}

const GROUPS: readonly (readonly [group: string, tables: readonly string[]])[] = [
  ["tasks", ["tasks", "areas", "projects", "sources", "task_sources", "actors", "space"]],
  ["notesAndLog", ["notes", "log_entries"]],
  ["history", ["commits", "receipts", "changes", "history_text", "outbox"]],
  ["search", ["search_docs", "search_fts", "search_tri"]],
];

/** Bytes per group of tables and their indexes, the groups of A1 3.20's size estimate. */
export function sizeBreakdown(path: string): Record<string, number> {
  return withConnection(new DatabaseSync(path, { readOnly: true }), (db) => {
    const rows = db
      .prepare("SELECT name, tbl_name AS tbl FROM sqlite_schema WHERE name IS NOT NULL")
      .all() as { name: string; tbl: string }[];
    const tableOf = new Map(rows.map((r) => [r.name, r.tbl]));
    const out: Record<string, number> = {
      tasks: 0,
      notesAndLog: 0,
      history: 0,
      search: 0,
      other: 0,
    };
    const sizes = db
      .prepare("SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name")
      .all() as { name: string; bytes: number }[];
    for (const { name, bytes } of sizes) {
      // FTS5 shadow tables (search_fts_data and so on) belong to their virtual table.
      const table = tableOf.get(name)?.replace(/_(data|idx|content|docsize|config)$/, "") ?? name;
      const group = GROUPS.find(([, tables]) => tables.includes(table))?.[0] ?? "other";
      out[group] = (out[group] ?? 0) + bytes;
    }
    out["total"] = statSync(path).size;
    return out;
  });
}

// Every table and its key order, so the digest reads rows in one defined order.
const DIGEST_TABLES: readonly (readonly [table: string, order: string, columns?: string])[] = [
  ["space", "one"],
  ["actors", "id"],
  ["areas", "id"],
  ["projects", "id"],
  ["tasks", "id"],
  ["notes", "id"],
  ["log_entries", "id"],
  ["sources", "id"],
  ["task_sources", "task_id, source_id"],
  ["commits", "seq"],
  ["receipts", "scope_id, request_id"],
  ["changes", "seq, n"],
  ["history_text", "hash"],
  ["search_docs", "doc"],
  ["search_fts", "rowid", "rowid, title, body, extra"],
];

/** SHA-256 over every row of a space database, read back in key order. */
export function corpusDigest(path: string): string {
  return withConnection(new DatabaseSync(path, { readOnly: true }), (db) => {
    const hash = createHash("sha256");
    db.exec("BEGIN");
    for (const [table, order, columns] of DIGEST_TABLES) {
      hash.update(`\n#${table}\n`);
      const stmt = db.prepare(`SELECT ${columns ?? "*"} FROM ${table} ORDER BY ${order}`);
      stmt.setReturnArrays(true);
      for (const row of stmt.iterate()) hash.update(`${JSON.stringify(row)}\n`);
    }
    db.exec("COMMIT");
    return hash.digest("hex");
  });
}
