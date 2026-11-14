// R06 (A1 M0 item 3): a full projection rebuild (A1 3.13) at spike level. Tasks are read in
// batches of at most 200 per read transaction at snapshot T (A1 3.9), each is rendered as a
// Markdown file with front matter into view.new/, written read-only, and hashed. After each batch
// the writer records the batch in projection_files (path, task, hash, seq and the catalogue line)
// and acknowledges the processed projection outbox rows (A1 3.13 step 5). The catalogue and the
// index are then assembled from projection_files, .projection.json carries the watermark, and
// view.new/ replaces view/. Pass: <= 60 s on Ubuntu, <= 180 s on Windows with Defender on.
//
// Not timed here, and listed in the result as `omitted`: the rescue check of hand-edited files
// (an incremental update compares the file on disk with projection_files, a rebuild into view.new/
// has nothing to compare), the per-file temporary name and rename of an incremental update, and
// the message round trip to the writer worker (the writer connection runs on this thread).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { closeAfterFailure, closeConnection } from "./connection.ts";
import {
  condition,
  type Context,
  DESIGN_TASKS,
  fullScale,
  type RowResult,
  summarize,
  verdict,
} from "./results.ts";
import { openReader, openWriter } from "./space.ts";

export interface R06Options {
  primary: string;
  /** The folder that holds view/ (the space folder). */
  spaceDir: string;
}

type Row = Record<string, unknown>;

const BATCH = 200;

const OMITTED = [
  "rescue check of hand-edited files (incremental updates only)",
  "per-file temporary name and rename (incremental updates only)",
  "message round trip to the writer worker (the writer connection runs on this thread)",
];

const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

const shortDay = (ms: number): string =>
  new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

interface Rendered {
  path: string;
  taskId: string;
  hash: string;
  entry: string;
}

/** The writer side of A1 3.13 step 5, at spike level. */
class Bookkeeping {
  readonly #db: DatabaseSync;
  readonly #file: StatementSync;
  readonly #done: StatementSync;
  readonly #again: StatementSync;
  acknowledged = 0;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#file = db.prepare(`INSERT INTO projection_files (path, task_id, sha256, seq, entry)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET task_id = excluded.task_id,
      sha256 = excluded.sha256, seq = excluded.seq, entry = excluded.entry`);
    this.#done = db.prepare(
      "DELETE FROM outbox WHERE topic = 'projection' AND key = ? AND seq <= ?",
    );
    this.#again = db.prepare(
      "UPDATE outbox SET first_seq = ? WHERE topic = 'projection' AND key = ? AND seq > ?",
    );
  }

  /** A full rebuild starts from an empty record of what the projection wrote. */
  reset(): void {
    this.#db.exec("DELETE FROM projection_files");
  }

  /** Records one batch rendered at snapshot `t` and acknowledges its outbox rows. */
  batch(t: number, rendered: readonly Rendered[]): void {
    this.#db.exec("BEGIN IMMEDIATE");
    for (const r of rendered) {
      this.#file.run(r.path, r.taskId, r.hash, t, r.entry);
      this.acknowledged += Number(this.#done.run(r.taskId, t).changes);
      this.#again.run(t + 1, r.taskId, t);
    }
    this.#db.exec("COMMIT");
  }

  /** Acknowledges the `*` row once the indexes are written, and returns the watermark W (DA-13). */
  indexes(t: number): number {
    this.#db.exec("BEGIN IMMEDIATE");
    this.acknowledged += Number(this.#done.run("*", t).changes);
    this.#again.run(t + 1, "*", t);
    const left = this.#db
      .prepare(
        "SELECT min(first_seq) AS f FROM outbox WHERE topic = 'projection' AND key <> '*' AND first_seq <= ?",
      )
      .get(t) as { f: number | null };
    this.#db.exec("COMMIT");
    return left.f === null ? t : left.f - 1;
  }
}

export function r06(ctx: Context, o: R06Options): RowResult {
  const view = join(o.spaceDir, "view");
  const next = join(o.spaceDir, "view.new");
  rmSync(next, { recursive: true, force: true });
  const reader = openReader(o.primary);
  let writer: DatabaseSync;
  try {
    writer = openWriter(o.primary);
  } catch (error) {
    closeAfterFailure(reader);
    throw error;
  }
  const started = performance.now();
  const perFile: number[] = [];
  const perBatch: number[] = [];
  let files = 0;
  let bytes = 0;
  let watermark: number;
  let projectionFiles: number;
  let acknowledged: number;
  try {
    const book = new Bookkeeping(writer);
    const db = reader;
    const space = db
      .prepare(
        "SELECT space_id, ref_prefix, last_seq, authority_epoch, authority_incarnation FROM space",
      )
      .get() as Row;
    const prefix = space["ref_prefix"] as string;
    const areas = new Map(
      (db.prepare("SELECT id, slug, title FROM areas").all() as Row[]).map((r) => [
        r["id"] as string,
        r,
      ]),
    );
    const projects = new Map(
      (db.prepare("SELECT id, slug, title FROM projects").all() as Row[]).map((r) => [
        r["id"] as string,
        r,
      ]),
    );
    const actors = new Map(
      (db.prepare("SELECT id, label FROM actors").all() as Row[]).map((r) => [
        r["id"] as string,
        r["label"] as string,
      ]),
    );
    const lastSeq = db.prepare("SELECT last_seq FROM space");
    const batch = db.prepare(
      `SELECT * FROM tasks WHERE ref > ? AND deleted_at IS NULL ORDER BY ref LIMIT ${String(BATCH)}`,
    );
    const notes = db.prepare(
      "SELECT ordinal, author_id, addressee, body, created_at FROM notes WHERE task_id = ? AND deleted_at IS NULL AND audience = 'all' ORDER BY ordinal",
    );
    const log = db.prepare(
      "SELECT ordinal, author_id, body, created_at FROM log_entries WHERE task_id = ? AND deleted_at IS NULL ORDER BY ordinal",
    );
    const sources =
      db.prepare(`SELECT s.kind, s.title, s.who, s.ref FROM task_sources ts JOIN sources s ON s.id = ts.source_id
      WHERE ts.task_id = ? AND ts.removed_at IS NULL ORDER BY ts.position`);

    book.reset();
    mkdirSync(join(next, "open"), { recursive: true });
    const made = new Set<string>();
    let after = 0;
    let t = 0;
    for (;;) {
      db.exec("BEGIN");
      t = (lastSeq.get() as { last_seq: number }).last_seq;
      const rows = batch.all(after) as Row[];
      const rendered: Rendered[] = [];
      for (const task of rows) {
        const t0 = performance.now();
        const id = task["id"] as string;
        const ref = `${prefix}-${String(task["ref"])}`;
        const title = task["title"] as string;
        const lifecycle = task["lifecycle"] as string;
        const area = areas.get(task["area_id"] as string);
        const project = projects.get(task["project_id"] as string);
        let dir = "open";
        if (lifecycle !== "active") {
          const year = new Date(
            (task["completed_at"] as number | null) ?? (task["created_at"] as number),
          ).getUTCFullYear();
          dir = `${lifecycle}/${String(year)}`;
          if (!made.has(dir)) {
            mkdirSync(join(next, dir), { recursive: true });
            made.add(dir);
          }
        }
        const path = `${dir}/${ref}-${slug(title)}.md`;
        const front = [
          "---",
          "generated: true",
          `space: ${space["space_id"] as string}`,
          `ref: ${ref}`,
          `id: ${id}`,
          `status: ${task["status"] as string}`,
          `lifecycle: ${lifecycle}`,
          `priority: ${String(task["priority"])}`,
          `effort: ${(task["effort"] as string | null) ?? ""}`,
          `due: ${(task["due_date"] as string | null) ?? ""}`,
          `area: ${(area?.["slug"] as string | undefined) ?? ""}`,
          `project: ${(project?.["slug"] as string | undefined) ?? ""}`,
          `version: ${String(task["version"])}`,
          `seq: ${String(t)}`,
          "---",
        ];
        const record: string[] = [];
        const context = task["context"] as string;
        if (context !== "") record.push("## Context", context, "");
        const src = sources.all(id) as Row[];
        if (src.length > 0) {
          record.push("## Sources");
          for (const s of src) {
            record.push(
              `- ${[s["kind"], s["title"], s["who"], s["ref"]].filter((x) => typeof x === "string").join(" · ")}`,
            );
          }
          record.push("");
        }
        const n = notes.all(id) as Row[];
        if (n.length > 0) {
          record.push("## Notes");
          for (const x of n) {
            const to = x["addressee"] === "agents" ? " → agents" : "";
            record.push(
              `- n${String(x["ordinal"])} · ${shortDay(x["created_at"] as number)} · ${actors.get(x["author_id"] as string) ?? ""}${to}: ${x["body"] as string}`,
            );
          }
          record.push("");
        }
        const l = log.all(id) as Row[];
        if (l.length > 0) {
          record.push("## Log");
          for (const x of l) {
            record.push(
              `- l${String(x["ordinal"])} · ${shortDay(x["created_at"] as number)} · ${actors.get(x["author_id"] as string) ?? ""}: ${x["body"] as string}`,
            );
          }
          record.push("");
        }
        const body = [`# ${title}`, "", task["summary"] as string, ""];
        if (lifecycle === "completed") {
          body.push(
            "## Outcome",
            (task["outcome"] as string | null) ?? "",
            "",
            "## Record",
            "",
            ...record,
          );
        } else {
          body.push(...record);
        }
        const text = `${front.join("\n")}\n${body.join("\n")}`;
        // Read-only, as A1 3.13 writes every projection file (0444 or the Windows attribute).
        writeFileSync(join(next, path), text, { mode: 0o444 });
        // The catalogue line as rendered, stored in projection_files (A1 3.4).
        const entry = JSON.stringify({
          ref,
          id,
          title,
          summary: task["summary"],
          status: task["status"],
          lifecycle,
          priority: task["priority"],
          effort: task["effort"],
          due: task["due_date"],
          area: area?.["slug"] ?? null,
          project: project?.["slug"] ?? null,
          labels: [],
          path,
          version: task["version"],
        });
        rendered.push({ path, taskId: id, hash: sha256(text), entry });
        perFile.push(performance.now() - t0);
        files += 1;
        bytes += Buffer.byteLength(text);
        after = task["ref"] as number;
      }
      db.exec("COMMIT");
      const b0 = performance.now();
      book.batch(t, rendered);
      perBatch.push(performance.now() - b0);
      if (rows.length < BATCH) break;
    }

    // The catalogue and the index come from what projection_files records, so the catalogue never
    // names a path that was not written (A1 3.13 step 6).
    const catalog: string[] = [];
    const index: string[] = [];
    db.exec("BEGIN");
    const recorded = db
      .prepare(
        `SELECT pf.entry, t.lifecycle, t.title, t.ref FROM projection_files pf
         JOIN tasks t ON t.id = pf.task_id ORDER BY t.lifecycle, t.ref`,
      )
      .all() as Row[];
    db.exec("COMMIT");
    for (const r of recorded) {
      catalog.push(r["entry"] as string);
      if (r["lifecycle"] === "active") {
        index.push(`- ${prefix}-${String(r["ref"])} ${r["title"] as string}`);
      }
    }
    projectionFiles = recorded.length;
    writeFileSync(join(next, "index.md"), `# Open tasks\n\n${index.join("\n")}\n`);
    writeFileSync(
      join(next, "README.md"),
      "# Generated view\n\nRead-only. Edit through an exchange.\n",
    );
    const b0 = performance.now();
    watermark = book.indexes(t);
    perBatch.push(performance.now() - b0);
    acknowledged = book.acknowledged;
    const header = {
      kind: "header",
      space: space["space_id"],
      epoch: space["authority_epoch"],
      incarnation: space["authority_incarnation"],
      seq: watermark,
      generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    };
    writeFileSync(
      join(next, "catalog.jsonl"),
      `${[JSON.stringify(header), ...catalog].join("\n")}\n`,
    );
    writeFileSync(join(next, ".projection.json"), `${JSON.stringify({ ...header, format: 1 })}\n`);
    if (existsSync(view)) rmSync(view, { recursive: true, force: true });
    renameSync(next, view);
  } catch (error) {
    closeAfterFailure(writer, reader);
    throw error;
  }
  closeConnection(writer);
  closeConnection(reader);
  const totalMs = performance.now() - started;
  const limitS = process.platform === "win32" ? 180 : 60;
  // A7 3.7: a full rebuild of 55,000 files.
  const v = verdict(
    [fullScale(ctx), condition("files", String(DESIGN_TASKS), files, files === DESIGN_TASKS)],
    () => totalMs <= limitS * 1000,
  );
  const bookkeeping = summarize(perBatch);
  return {
    row: "R06",
    title: `full projection rebuild, ${String(files)} files, per-file render and write`,
    threshold: `total <= ${String(limitS)} s (${process.platform}; Ubuntu 60 s, Windows 180 s with Defender on)`,
    ...v,
    latency: summarize(perFile),
    metrics: {
      files,
      bytes,
      // Includes the bookkeeping below.
      totalMs: Math.round(totalMs),
      batch: BATCH,
      // projection_files rows and outbox acknowledgements through the writer, per batch.
      bookkeeping,
      bookkeepingMs: Math.round(perBatch.reduce((a, b) => a + b, 0)),
      projectionFiles,
      outboxAcknowledged: acknowledged,
      watermark,
      omitted: OMITTED,
    },
  };
}
