// The runtime gate (A2 3.12.1, A7 row R01), run inside the packaged runtime through its launcher.
// Every check must pass, or the build is blocked:
//   node-version          the runtime is the pinned Node
//   sqlite-version        process.versions.sqlite is the pinned SQLite
//   fts5-compiled         sqlite_compileoption_used('ENABLE_FTS5') is 1
//   fts5-match            an FTS5 table answers a MATCH query
//   strict-table          a STRICT table refuses a value of the wrong type
//   json-functions        json_extract, ->>, json_each and json_valid work
//   backup-api            node:sqlite backup() copies a database that passes integrity_check
//   report-exclude-env    --report-exclude-env reached Node and keeps the environment out of reports
//
// Usage: tasks gate --scratch <folder> [--expect-node <v>] [--expect-sqlite <v>] [--json]
// The expected versions default to the ones this version folder's manifest.json pins.
// The scratch folder holds two small databases while the gate runs. They are deleted after.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync, backup } from "node:sqlite";
import { URL } from "node:url";

/** @param {() => unknown} fn @returns {{ ok: boolean, detail: string }} */
function attempt(fn) {
  try {
    const detail = fn();
    return { ok: detail !== false, detail: typeof detail === "string" ? detail : "" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function fts5Match() {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE notes USING fts5(body)");
    const insert = db.prepare("INSERT INTO notes (rowid, body) VALUES (?, ?)");
    insert.run(1, "Mira files the quarterly report");
    insert.run(2, "Water the plants");
    insert.run(3, "Review the report draft with Mira");
    const rows = db
      .prepare("SELECT rowid AS id FROM notes WHERE notes MATCH ? ORDER BY rowid")
      .all("report");
    const ids = rows.map((r) => Number(r.id)).join(",");
    if (ids !== "1,3") throw new Error(`MATCH returned rows ${ids}, expected 1,3`);
    return "MATCH returned rows 1,3";
  } finally {
    db.close();
  }
}

function strictTable() {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, rank INTEGER NOT NULL) STRICT");
    db.prepare("INSERT INTO tasks (rank) VALUES (?)").run(1);
    try {
      db.prepare("INSERT INTO tasks (rank) VALUES (?)").run("first");
    } catch (error) {
      const code = /** @type {{ errcode?: number }} */ (error).errcode;
      // 3091 is SQLITE_CONSTRAINT_DATATYPE.
      if (code === 3091) return "a TEXT value in an INTEGER column was refused";
      throw error;
    }
    throw new Error("a STRICT table accepted a TEXT value in an INTEGER column");
  } finally {
    db.close();
  }
}

function jsonFunctions() {
  const db = new DatabaseSync(":memory:");
  try {
    const row = db
      .prepare(
        `SELECT json_extract(?1, '$.tags[1]') AS second,
                ?1 ->> '$.space' AS space,
                (SELECT count(*) FROM json_each(?1, '$.tags')) AS count,
                json_valid('{"a":') AS invalid`,
      )
      .get('{"space":"Mira","tags":["home","work"]}');
    if (row?.second !== "work" || row.space !== "Mira" || row.count !== 2 || row.invalid !== 0) {
      throw new Error(`unexpected JSON results ${JSON.stringify(row)}`);
    }
    return "json_extract, ->>, json_each and json_valid";
  } finally {
    db.close();
  }
}

/** @param {string} dir */
async function backupApi(dir) {
  const source = join(dir, "gate-source.db");
  const copy = join(dir, "gate-backup.db");
  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, title TEXT NOT NULL) STRICT");
    const insert = db.prepare("INSERT INTO t (title) VALUES (?)");
    for (let i = 0; i < 100; i++) insert.run(`Fixture task ${String(i)}`);
    const pages = await backup(db, copy);
    const restored = new DatabaseSync(copy, { readOnly: true });
    try {
      const count = restored.prepare("SELECT count(*) AS n FROM t").get()?.n;
      const check = restored.prepare("PRAGMA integrity_check").get()?.integrity_check;
      if (count !== 100 || check !== "ok") {
        throw new Error(`backup has ${String(count)} rows, integrity_check ${String(check)}`);
      }
    } finally {
      restored.close();
    }
    return `backup() copied ${String(pages)} pages, integrity_check ok`;
  } finally {
    db.close();
  }
}

function reportExcludeEnv() {
  if (!process.execArgv.includes("--report-exclude-env")) {
    throw new Error("--report-exclude-env is not in process.execArgv");
  }
  if (process.report.excludeEnv !== true) throw new Error("process.report.excludeEnv is false");
  const report = /** @type {Record<string, unknown>} */ (process.report.getReport());
  if ("environmentVariables" in report) throw new Error("a report still includes the environment");
  return "reports leave out the environment";
}

/**
 * @param {{ scratch: string, expect: { node: string, sqlite: string } }} options
 * @returns {Promise<{ check: string, ok: boolean, detail: string }[]>}
 */
export async function runGate({ scratch, expect }) {
  const results = [];
  /** @param {string} check @param {{ ok: boolean, detail: string }} r */
  const add = (check, r) => results.push({ check, ...r });

  add(
    "node-version",
    attempt(() => {
      if (process.version !== `v${expect.node}`) {
        throw new Error(`running ${process.version}, pinned v${expect.node}`);
      }
      return process.version;
    }),
  );
  add(
    "sqlite-version",
    attempt(() => {
      const actual = process.versions.sqlite;
      if (actual !== expect.sqlite) throw new Error(`bundled ${actual}, pinned ${expect.sqlite}`);
      return actual;
    }),
  );
  add(
    "fts5-compiled",
    attempt(() => {
      const db = new DatabaseSync(":memory:");
      try {
        const v = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS v").get()?.v;
        if (v !== 1) throw new Error("SQLite was built without FTS5");
        return "ENABLE_FTS5";
      } finally {
        db.close();
      }
    }),
  );
  add("fts5-match", attempt(fts5Match));
  add("strict-table", attempt(strictTable));
  add("json-functions", attempt(jsonFunctions));

  const dir = join(scratch, `gate-${String(process.pid)}-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  try {
    try {
      add("backup-api", { ok: true, detail: await backupApi(dir) });
    } catch (error) {
      add("backup-api", {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  add("report-exclude-env", attempt(reportExcludeEnv));
  return results;
}

/** @param {string[]} args @returns {Promise<number>} */
export async function main(args) {
  /** @type {Record<string, string>} */
  const options = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--json") json = true;
    else if (["--scratch", "--expect-node", "--expect-sqlite"].includes(arg) && i + 1 < args.length)
      options[arg] = args[++i] ?? "";
    else {
      process.stderr.write(`gate: unknown argument ${JSON.stringify(arg)}\n`);
      return 64;
    }
  }
  const scratch = options["--scratch"];
  if (scratch === undefined) {
    process.stderr.write("gate: --scratch <folder> is required\n");
    return 64;
  }
  const manifestUrl = new URL("../manifest.json", import.meta.url);
  /** @type {{ node?: string, sqlite?: string }} */
  const manifest = existsSync(manifestUrl) ? JSON.parse(readFileSync(manifestUrl, "utf8")) : {};
  const expect = {
    node: options["--expect-node"] ?? manifest.node ?? "",
    sqlite: options["--expect-sqlite"] ?? manifest.sqlite ?? "",
  };
  if (expect.node === "" || expect.sqlite === "") {
    process.stderr.write(
      "gate: no manifest.json here, so pass --expect-node and --expect-sqlite\n",
    );
    return 64;
  }
  const results = await runGate({ scratch, expect });
  const ok = results.every((r) => r.ok);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok, results })}\n`);
  } else {
    for (const r of results) {
      process.stdout.write(`${r.ok ? "pass" : "FAIL"}  ${r.check.padEnd(20)} ${r.detail}\n`);
    }
    process.stdout.write(ok ? "gate passed\n" : "gate FAILED\n");
  }
  return ok ? 0 : 1;
}
