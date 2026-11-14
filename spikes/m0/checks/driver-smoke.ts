// Lab row R08 (A7 3.7, A1 3.19 and M0 item 5): the better-sqlite3 fallback driver, installed from
// the registry into a scratch folder without install scripts and without a compiler, loads in the
// pinned Node and passes the driver smoke test.
//
//   node spikes/m0/checks/driver-smoke.ts --package <scratch>/node_modules/better-sqlite3
//     --scratch <empty folder> --out <folder>
//
// The smoke test follows A1 3.19's start-up check plus what the store needs: open a file database
// in WAL mode, SQLite version and FTS5 compiled in, an FTS5 MATCH, a STRICT table that refuses a
// wrong type, JSON functions, a transaction that commits and one that rolls back, and an online
// backup that passes integrity_check. It also records how the native binding got there: the
// package's install scripts, any compiler output in build/, and the binding file it loaded.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { machineFacts, options, writeResult } from "./common.ts";

interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface Database {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(source: string): Statement;
  exec(source: string): void;
  transaction<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void;
  backup(destination: string): Promise<{ totalPages: number; remainingPages: number }>;
  close(): void;
}
type DatabaseConstructor = new (path: string, options?: { readonly?: boolean }) => Database;

interface Check {
  check: string;
  ok: boolean;
  detail: string;
}

async function attempt(name: string, fn: () => string | Promise<string>): Promise<Check> {
  try {
    return { check: name, ok: true, detail: await fn() };
  } catch (error) {
    return {
      check: name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Every .node file under the package, relative to it. */
function bindings(dir: string, base = dir): string[] {
  const found: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") found.push(...bindings(p, base));
    } else if (e.name.endsWith(".node")) found.push(relative(base, p).replaceAll("\\", "/"));
  }
  return found;
}

export async function smoke(pkgDir: string, scratch: string): Promise<Check[]> {
  const require = createRequire(join(pkgDir, "package.json"));
  const Database = require(pkgDir) as DatabaseConstructor;
  const checks: Check[] = [];
  const file = join(scratch, "smoke.db");
  const copy = join(scratch, "smoke-backup.db");
  const db = new Database(file);
  try {
    checks.push(
      await attempt("open-wal", () => {
        const mode = db.pragma("journal_mode = WAL", { simple: true });
        if (mode !== "wal") throw new Error(`journal_mode is ${String(mode)}`);
        return "file database, journal_mode wal";
      }),
    );
    checks.push(
      await attempt("sqlite-version", () => {
        const v = String(db.prepare("SELECT sqlite_version() AS v").get()?.v);
        const [maj, min] = v.split(".").map(Number);
        if ((maj ?? 0) < 3 || (maj === 3 && (min ?? 0) < 45))
          throw new Error(`${v} is below 3.45.0`);
        return v;
      }),
    );
    checks.push(
      await attempt("fts5-compiled", () => {
        const v = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS v").get()?.v;
        if (v !== 1) throw new Error("built without FTS5");
        return "ENABLE_FTS5";
      }),
    );
    checks.push(
      await attempt("fts5-match", () => {
        db.exec("CREATE VIRTUAL TABLE notes USING fts5(body)");
        const insert = db.prepare("INSERT INTO notes (rowid, body) VALUES (?, ?)");
        insert.run(1, "Mira files the quarterly report");
        insert.run(2, "Water the plants");
        insert.run(3, "Review the report draft with Mira");
        const ids = db
          .prepare("SELECT rowid AS id FROM notes WHERE notes MATCH ? ORDER BY rowid")
          .all("report")
          .map((r) => String(r.id))
          .join(",");
        if (ids !== "1,3") throw new Error(`MATCH returned ${ids}`);
        return "MATCH returned rows 1,3";
      }),
    );
    checks.push(
      await attempt("strict-table", () => {
        db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, rank INTEGER NOT NULL) STRICT");
        db.prepare("INSERT INTO tasks (rank) VALUES (?)").run(1);
        try {
          db.prepare("INSERT INTO tasks (rank) VALUES (?)").run("first");
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "SQLITE_CONSTRAINT_DATATYPE")
            return "a TEXT value in an INTEGER column was refused";
          throw error;
        }
        throw new Error("a STRICT table accepted TEXT in an INTEGER column");
      }),
    );
    checks.push(
      await attempt("json-functions", () => {
        const row = db
          .prepare(
            `SELECT json_extract(@j, '$.tags[1]') AS second, @j ->> '$.space' AS space,
                    json_valid('{}') AS valid`,
          )
          .get({ j: '{"space":"Mira","tags":["home","work"]}' });
        if (row?.second !== "work" || row.space !== "Mira" || row.valid !== 1)
          throw new Error(`unexpected ${JSON.stringify(row)}`);
        return "json_extract, ->>, json_valid";
      }),
    );
    checks.push(
      await attempt("transaction", () => {
        const insert = db.prepare("INSERT INTO tasks (rank) VALUES (?)");
        const batch = db.transaction((n: number) => {
          for (let i = 0; i < n; i++) insert.run(i + 10);
        });
        batch(100);
        const failing = db.transaction(() => {
          insert.run(999);
          throw new Error("rollback on purpose");
        });
        try {
          failing();
        } catch {
          // Expected: the transaction rolls back.
        }
        const n = db.prepare("SELECT count(*) AS n FROM tasks").get()?.n;
        if (n !== 101)
          throw new Error(`expected 101 rows after commit and rollback, found ${String(n)}`);
        return "100 rows committed, a throwing transaction rolled back";
      }),
    );
    checks.push(
      await attempt("backup", async () => {
        const r = await db.backup(copy);
        const back = new Database(copy, { readonly: true });
        try {
          const ok = back.pragma("integrity_check", { simple: true });
          const n = back.prepare("SELECT count(*) AS n FROM tasks").get()?.n;
          if (ok !== "ok" || n !== 101)
            throw new Error(`integrity ${String(ok)}, ${String(n)} rows`);
        } finally {
          back.close();
        }
        return `backup() copied ${String(r.totalPages)} pages, integrity_check ok`;
      }),
    );
  } finally {
    db.close();
  }
  return checks;
}

async function main(argv: readonly string[]): Promise<number> {
  const o = options(argv, ["package", "scratch", "out"]);
  if (o.package === undefined || o.scratch === undefined || o.out === undefined)
    throw new Error("pass --package, --scratch and --out");
  const pkgDir = resolve(String(o.package));
  const scratch = resolve(String(o.scratch));
  const out = String(o.out);
  mkdirSync(scratch, { recursive: true });
  if (readdirSync(scratch).length > 0) throw new Error("--scratch must be empty");
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    version: string;
    scripts?: Record<string, string>;
    gypfile?: boolean;
    dependencies?: Record<string, string>;
  };
  const installScripts = Object.keys(pkg.scripts ?? {}).filter((s) =>
    ["preinstall", "install", "postinstall"].includes(s),
  );
  const buildDir = join(pkgDir, "build");
  const compiled = existsSync(buildDir) ? readdirSync(buildDir) : [];
  const found = bindings(pkgDir);

  let checks: Check[];
  try {
    checks = await smoke(pkgDir, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // The binding this process actually loaded, from the shared objects of a diagnostic report.
  const report = process.report.getReport() as { sharedObjects?: string[] };
  const loaded = (report.sharedObjects ?? [])
    .filter((s) => s.endsWith(".node"))
    .map((s) => relative(pkgDir, s.replace(/^\\\\\?\\/, "")).replaceAll("\\", "/"))
    .filter((s) => !s.startsWith(".."));
  const binding = loaded[0];
  const bindingSha256 =
    binding === undefined
      ? null
      : createHash("sha256")
          .update(readFileSync(join(pkgDir, binding)))
          .digest("hex");
  const ok = checks.every((c) => c.ok);
  for (const c of checks)
    console.log(`${c.ok ? "pass" : "FAIL"}  ${c.check.padEnd(16)} ${c.detail}`);
  console.log(
    `better-sqlite3 ${pkg.version}: install scripts ${installScripts.length === 0 ? "none" : installScripts.join(", ")}, ` +
      `build/ ${compiled.length === 0 ? "absent" : compiled.join(", ")}, binding ${String(binding)} (${String(found.length)} prebuilt files)`,
  );
  console.log(ok ? "driver smoke passed" : "driver smoke FAILED");
  const file = writeResult(out, "r08-driver-smoke.json", {
    row: "R08",
    at: new Date().toISOString(),
    machine: machineFacts(),
    package: {
      name: "better-sqlite3",
      version: pkg.version,
      installScripts,
      gypfile: pkg.gypfile ?? null,
      dependencies: pkg.dependencies ?? {},
      buildDir: compiled,
      prebuilt: found,
      binding,
      bindingSha256,
    },
    ok,
    checks,
  });
  console.log(`result: ${file}`);
  return ok ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main(process.argv.slice(2));
}
