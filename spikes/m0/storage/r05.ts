// R05 (A1 3.20, A1 3.12, A3 M0-11): FTS5 top 20 with snippets over the design-scale space, then
// the optional trigram index: present, its build time, its size against the unicode61 index and its
// substring query latency. The same queries also run over the stress corpus, for information.
// Pass: p95 <= 50 ms for the `desktop` role, <= 100 ms for the `laptop` role, and the trigram tokenizer present.
//
// Three query groups, each with its own percentiles:
// - broad: words of the fixture vocabulary, which match a large share of all documents. This is
//   the stress case and the row's verdict, unchanged from the first runs.
// - selective: task and ticket references and full title phrases, which match a handful.
// - noHit: words that never occur in the fixture text.
// The lab can then tell a broad-term cost (ranking tens of thousands of matches) from a general one.
import type { DatabaseSync } from "node:sqlite";
import { withConnection } from "./connection.ts";
import { OBJECTS, QUALIFIERS, VERBS } from "./fixture.ts";
import {
  condition,
  type Context,
  DESIGN_TASKS,
  fullScale,
  type Latency,
  type RowResult,
  summarize,
  verdict,
} from "./results.ts";
import { Rng } from "./rng.ts";
import { TRIGRAM } from "./schema.ts";
import { openReader, openWriter } from "./space.ts";

export interface R05Options {
  primary: string;
  stress: string;
  queries: number;
}

/** The bench's query count at full scale. */
export const QUERIES = 1000;

// Words that occur in the fixture text, many of them in most documents.
const WORDS = [
  "invoice",
  "staging",
  "runner",
  "webhook",
  "appointment",
  "migration",
  "backup",
  "reminder",
  "mobile",
  "export",
  "release",
  "review",
  "client",
  "login",
  "search",
  "lumen",
  "harbor",
  "dashboard",
  "garden",
  "quarter",
  "changelog",
  "vendor",
  "zone",
  "rotation",
] as const;

// Words that never occur in the fixture text (the vocabulary in fixture.ts).
const ABSENT = [
  "zebra",
  "quasar",
  "pelican",
  "violin",
  "glacier",
  "walrus",
  "saxophone",
  "tundra",
] as const;

/** A seeded list of broad FTS5 queries: single words, two words, prefixes and phrases. */
function broadQueries(rng: Rng, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = rng.pick(WORDS);
    const b = rng.pick(WORDS);
    switch (i % 4) {
      case 0:
        out.push(a);
        break;
      case 1:
        out.push(`${a} ${b}`);
        break;
      case 2:
        out.push(`${a.slice(0, 4)}*`);
        break;
      default:
        out.push(`"time zone" OR "${a}"`);
    }
  }
  return out;
}

/**
 * Selective queries: a task reference ("M-1234", one task), a ticket reference ("LUM-512", a few
 * sources) and a title phrase with its qualifier (a few dozen tasks with their notes and log).
 */
function selectiveQueries(rng: Rng, n: number, tasks: number): string[] {
  const qualifiers = QUALIFIERS.filter((q) => q !== "").map((q) => q.trim());
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    switch (i % 3) {
      case 0:
        out.push(`"M-${String(rng.range(1, Math.max(1, tasks)))}"`);
        break;
      case 1:
        out.push(`"LUM-${String(rng.range(100, 999))}"`);
        break;
      default:
        out.push(`"${rng.pick(VERBS)} ${rng.pick(OBJECTS)}" "${rng.pick(qualifiers)}"`);
    }
  }
  return out;
}

/** Queries over words that never occur: single words, two words, prefixes and phrases. */
function noHitQueries(rng: Rng, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = rng.pick(ABSENT);
    switch (i % 4) {
      case 0:
        out.push(a);
        break;
      case 1:
        out.push(`${a} ${rng.pick(WORDS)}`);
        break;
      case 2:
        out.push(`${a.slice(0, 4)}*`);
        break;
      default:
        out.push(`"time ${a}"`);
    }
  }
  return out;
}

/** Substrings of three to six letters from inside fixture words, for the trigram index. */
function trigramQueries(rng: Rng, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const word = rng.pick(WORDS);
    const len = Math.min(word.length, rng.range(3, 6));
    const from = rng.int(word.length - len + 1);
    out.push(`"${word.slice(from, from + len)}"`);
  }
  return out;
}

const topTwenty = (table: string): string => `
  SELECT d.entity_id, d.kind, d.task_id, snippet(${table}, -1, '[', ']', '...', 12) AS snip,
         bm25(${table}) AS score
  FROM ${table} JOIN search_docs d ON d.doc = ${table}.rowid
  WHERE ${table} MATCH ? AND d.audience = 'all'
  ORDER BY rank LIMIT 20`;

interface Timed {
  latency: Latency;
  /** Rows returned, at most 20 per query. */
  hits: number;
}

function timeQueries(db: DatabaseSync, table: string, queries: readonly string[]): Timed {
  const stmt = db.prepare(topTwenty(table));
  const samples: number[] = [];
  let hits = 0;
  for (const q of queries) {
    const t0 = performance.now();
    hits += stmt.all(q).length;
    samples.push(performance.now() - t0);
  }
  return { latency: summarize(samples), hits };
}

/** Matching documents per query, untimed, over a sample of at most 50 queries of the group. */
function matches(
  db: DatabaseSync,
  queries: readonly string[],
): { sampled: number; median: number; p95: number; max: number } {
  const stmt = db.prepare(
    `SELECT count(*) AS n FROM search_fts JOIN search_docs d ON d.doc = search_fts.rowid
     WHERE search_fts MATCH ? AND d.audience = 'all'`,
  );
  const counts = queries
    .slice(0, 50)
    .map((q) => (stmt.get(q) as { n: number }).n)
    .sort((a, b) => a - b);
  const at = (p: number): number =>
    counts[Math.max(0, Math.ceil((p / 100) * counts.length) - 1)] ?? 0;
  return { sampled: counts.length, median: at(50), p95: at(95), max: counts.at(-1) ?? 0 };
}

interface Group extends Timed {
  queries: number;
  matches: ReturnType<typeof matches>;
}

/** Times one group after warming the page cache with its first queries. */
function group(db: DatabaseSync, queries: readonly string[]): Group {
  timeQueries(db, "search_fts", queries.slice(0, 5));
  const timed = timeQueries(db, "search_fts", queries);
  return { queries: queries.length, ...timed, matches: matches(db, queries) };
}

interface Groups {
  broad: Group;
  selective: Group;
  noHit: Group;
}

function bytes(db: DatabaseSync, table: string): { total: number; index: number } {
  const stmt = db.prepare("SELECT coalesce(sum(pgsize), 0) AS b FROM dbstat WHERE name = ?");
  const size = (name: string): number => (stmt.get(name) as { b: number }).b;
  const index = size(`${table}_data`) + size(`${table}_idx`);
  return {
    index,
    total: index + size(`${table}_content`) + size(`${table}_docsize`) + size(`${table}_config`),
  };
}

const ratio = (a: number, b: number): number => (b === 0 ? 0 : Math.round((a / b) * 1000) / 1000);
const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

export function r05(ctx: Context, o: R05Options): RowResult {
  const rng = new Rng(`${ctx.seed}/r05`);
  // The broad queries and the substrings are drawn first, so they stay the same as in the first runs.
  const broad = broadQueries(rng, o.queries);
  const substrings = trigramQueries(rng, o.queries);

  const searchAll = (path: string): { tasks: number; docs: number; groups: Groups } =>
    withConnection(openReader(path), (db) => {
      const tasks = count(db, "tasks");
      const groupRng = new Rng(`${ctx.seed}/r05/groups`);
      return {
        tasks,
        docs: count(db, "search_docs"),
        groups: {
          broad: group(db, broad),
          selective: group(db, selectiveQueries(groupRng, o.queries, tasks)),
          noHit: group(db, noHitQueries(groupRng, o.queries)),
        },
      };
    });

  const main = searchAll(o.primary);

  // The trigram index is built through the writer, as features.search_trigram would.
  const tri = withConnection(openWriter(o.primary), (writer) => {
    let buildMs = 0;
    let present: boolean;
    let timed: Timed = { latency: summarize([]), hits: 0 };
    const t0 = performance.now();
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer.exec(TRIGRAM);
      writer.exec("COMMIT");
      buildMs = performance.now() - t0;
      present = true;
    } catch {
      // A build without the trigram tokenizer fails here. R05 records it as not present.
      if (writer.isTransaction) writer.exec("ROLLBACK");
      present = false;
    }
    if (present) {
      timeQueries(writer, "search_tri", substrings.slice(0, 5));
      timed = timeQueries(writer, "search_tri", substrings);
    }
    return {
      present,
      buildMs,
      timed,
      fts: bytes(writer, "search_fts"),
      tri: present ? bytes(writer, "search_tri") : { total: 0, index: 0 },
    };
  });

  const stress = searchAll(o.stress);

  const latency = main.groups.broad.latency;
  const limit = ctx.machine.role === "desktop" ? 50 : 100;
  // A7 3.7: the design-scale space of 55,000 tasks. The bench runs 1,000 broad queries there.
  const v = verdict(
    [
      fullScale(ctx),
      condition("tasks", String(DESIGN_TASKS), main.tasks, main.tasks === DESIGN_TASKS),
      condition("broad queries", String(QUERIES), latency.count, latency.count === QUERIES),
    ],
    () => latency.p95 <= limit && tri.present,
  );
  return {
    row: "R05",
    title: `FTS5 top 20 with snippets, ${String(o.queries)} broad queries over ${String(main.tasks)} tasks`,
    threshold: `broad p95 <= ${String(limit)} ms (${ctx.machine.role}; desktop 50 ms, laptop 100 ms) and trigram present`,
    ...v,
    latency,
    metrics: {
      tasks: main.tasks,
      documents: main.docs,
      queries: o.queries,
      hits: main.groups.broad.hits,
      // Each group has its own percentiles and the matching documents of a sample of its queries.
      groups: main.groups,
      trigramPresent: tri.present,
      trigramBuildMs: Math.round(tri.buildMs),
      ftsBytes: tri.fts.total,
      ftsIndexBytes: tri.fts.index,
      trigramBytes: tri.tri.total,
      trigramIndexBytes: tri.tri.index,
      // Three readings of A1 open item 4's "2x the index size". A1 must say which one it means:
      // - trigramRatio: the trigram table against unicode61, all shadow tables (content included);
      // - trigramIndexRatio: index pages only (_data and _idx), without the stored text;
      // - combinedRatio: unicode61 and trigram both installed, against unicode61 alone.
      trigramRatio: ratio(tri.tri.total, tri.fts.total),
      trigramIndexRatio: ratio(tri.tri.index, tri.fts.index),
      combinedRatio: ratio(tri.fts.total + tri.tri.total, tri.fts.total),
      trigram: tri.timed.latency,
      trigramHits: tri.timed.hits,
      stressTasks: stress.tasks,
      stress: stress.groups.broad.latency,
      stressGroups: stress.groups,
    },
  };
}
