// The schema lint (A1 3.4, A1 5; A7 3.8 M1.03 Verify: "Schema lint (STRICT, forbidden column
// names)"). It reads the real schema from a freshly created space: SQLite's own table list, column
// lists, foreign keys and stored table definitions, never the SQL source text.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { step0001 } from "../migrations/0001-schema-0.1.ts";
import { step0002, TABLES_0_2_NEW } from "../migrations/0002-schema-0.2.ts";
import { step0003, TABLES_0_3_NEW } from "../migrations/0003-schema-0.3.ts";
import { step0004, TABLES_0_4_NEW } from "../migrations/0004-schema-0.4.ts";
import { step0005, TABLES_0_5_NEW } from "../migrations/0005-schema-0.5.ts";
import { step0006, TABLES_0_6_NEW } from "../migrations/0006-schema-0.6.ts";
import { SCHEMA_STEPS } from "../migrations/index.ts";
import type { Connection } from "../src/driver.ts";
import { StorageError } from "../src/errors.ts";
import {
  APP_ID,
  CLOSED_ENUMS,
  encodeRevision,
  FORBIDDEN_COLUMN_WORDS,
  JSON_COLUMNS,
  OPEN_SETS,
  VERSIONLESS_TABLES,
  WITHOUT_ROWID_TABLES,
} from "../src/schema.ts";
import { LATEST_REVISION, openSpace } from "../src/space.ts";
import { checkedDriver, createFixtureSpace, tempFolders } from "./space-helpers.ts";

interface TableInfo {
  name: string;
  wr: number;
  strict: number;
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKey {
  table: string;
  from: string;
  to: string | null;
}

const folders = tempFolders("schema-lint");
let conn: Connection;
let tables: TableInfo[];
const columns = new Map<string, ColumnInfo[]>();
const tableSql = new Map<string, string>();

beforeAll(async () => {
  const created = await createFixtureSpace(folders.make());
  conn = openSpace(await checkedDriver(), created.folder, { role: "writer" }).conn;
  tables = conn
    .prepare(
      "SELECT name, wr, strict FROM pragma_table_list " +
        "WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all<TableInfo>();
  for (const { name } of tables) {
    columns.set(
      name,
      conn
        .prepare(
          'SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info($t) ORDER BY cid',
        )
        .all<ColumnInfo>({ t: name }),
    );
    const sql = conn
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = $t")
      .get<{ sql: string }>({ t: name })?.sql;
    tableSql.set(name, sql ?? "");
  }
});

afterAll(() => {
  conn.close();
  folders.cleanup();
});

const columnsOf = (table: string): ColumnInfo[] => columns.get(table) ?? [];
const each = <T>(fn: (table: string, cols: ColumnInfo[]) => T[]): T[] =>
  tables.flatMap(({ name }) => fn(name, columnsOf(name)));

/** `column IN (a, b)` lists in a stored table definition, by column. */
function inLists(sql: string): Map<string, (string | number)[]> {
  const found = new Map<string, (string | number)[]>();
  for (const match of sql.matchAll(/\b([a-z_]+)\s+IN\s*\(([^)]*)\)/gi)) {
    const values = (match[2] ?? "").split(",").map((raw) => {
      const v = raw.trim();
      return /^'.*'$/.test(v) ? v.slice(1, -1) : Number(v);
    });
    found.set(match[1] ?? "", values);
  }
  return found;
}

/**
 * A1 3.4's REFERENCES for the tables of schema 0.1, as `table.column -> table`. Every one must
 * exist, so a dropped foreign key fails the lint, and no other may, so an added one is a decision.
 */
const REQUIRED_FOREIGN_KEYS = [
  "areas.created_by -> actors",
  "projects.area_id -> areas",
  "projects.created_by -> actors",
  "tasks.area_id -> areas",
  "tasks.project_id -> projects",
  "tasks.parent_id -> tasks",
  "tasks.completed_by -> actors",
  "tasks.wrapped_by -> actors",
  "tasks.created_by -> actors",
  "tasks.deleted_by -> actors",
  "notes.task_id -> tasks",
  "notes.author_id -> actors",
  "log_entries.task_id -> tasks",
  "log_entries.author_id -> actors",
  "sources.created_by -> actors",
  "task_sources.task_id -> tasks",
  "task_sources.source_id -> sources",
  "task_sources.added_by -> actors",
  "places.machine_id -> machines",
  "commits.principal_id -> actors",
  "commits.author_id -> actors",
  // M2.05: A1 3.4's two, and the place that replaces `folder` (A1 3.4).
  "launches.task_id -> tasks",
  "launches.machine_id -> machines",
  "launches.place_id -> places",
  // Schema 0.2 (M3.01): A1 3.4's and 3.14's. `exchange_items.task_id` has none in A1: an item
  // records what was exported, and stays when its task does not.
  "task_labels.task_id -> tasks",
  "task_labels.label_id -> labels",
  "task_labels.added_by -> actors",
  "learnings.task_id -> tasks",
  "learnings.created_by -> actors",
  "attachments.task_id -> tasks",
  "attachments.created_by -> actors",
  "proposals.task_id -> tasks",
  "proposals.author_id -> actors",
  "proposals.resolved_by -> actors",
  "exchanges.created_by -> actors",
  "exchange_items.exchange_id -> exchanges",
  // Schema 0.3 (M6.01): A1 3.4's, and the place a run names, as a launch does. `runs.routine_id`
  // and both `session_id` columns have none in A1: routines arrive later, and a session record
  // may still live in machine state (A4 3.10).
  "sessions.task_id -> tasks",
  "sessions.machine_id -> machines",
  "sessions.actor_id -> actors",
  "runs.task_id -> tasks",
  "runs.machine_id -> machines",
  "runs.place_id -> places",
  // Schema 0.5: a folder is on one machine. Its owner is a project or a task, so no key names it.
  "folders.machine_id -> machines",
  // Schema 0.6: who made a page and who moved it to the Trash. What holds it is one of four kinds,
  // and a node's texts are keyed by their node's ID, so no key names them.
  "pages.created_by -> actors",
  "pages.deleted_by -> actors",
];

/** The foreign keys the lint expects but did not find, and the ones it found but did not expect. */
function foreignKeyDifference(
  found: readonly string[],
  required: readonly string[],
): { missing: string[]; unexpected: string[] } {
  return {
    missing: required.filter((fk) => !found.includes(fk)).sort(),
    unexpected: found.filter((fk) => !required.includes(fk)).sort(),
  };
}

/** Columns with a json_valid CHECK in a stored table definition. */
const jsonChecked = (sql: string): string[] =>
  [...sql.matchAll(/json_valid\(([a-z_]+)\)/gi)].map((m) => m[1] ?? "").sort();

describe("[A1.5.schema.lint] the schema of a freshly created space follows A1 3.4's rules", () => {
  test("the tables are schema 0.6's: 0.1's (M1.03's list, M1.05's receipts, M2.05's launches), M3.01's, M6.01's, the search index's, the folders and the pages", () => {
    expect(SCHEMA_STEPS).toEqual([step0001, step0002, step0003, step0004, step0005, step0006]);
    // The FTS5 table is a virtual table: its rows and shadow tables are FTS5's.
    expect(tables.map((t) => t.name)).toEqual(
      [...step0006.tables].filter((t) => t !== "search_fts").sort(),
    );
    expect([...step0006.tables].sort()).toEqual([...step0005.tables, ...TABLES_0_6_NEW].sort());
    expect([...TABLES_0_6_NEW]).toEqual(["pages", "node_texts"]);
    expect([...step0005.tables].sort()).toEqual([...step0004.tables, ...TABLES_0_5_NEW].sort());
    expect([...TABLES_0_5_NEW]).toEqual(["folders"]);
    expect([...step0004.tables].sort()).toEqual([...step0003.tables, ...TABLES_0_4_NEW].sort());
    expect([...step0003.tables].sort()).toEqual([...step0002.tables, ...TABLES_0_3_NEW].sort());
    expect([...TABLES_0_3_NEW].sort()).toEqual(["runs", "sessions"]);
    expect([...step0002.tables].sort()).toEqual([...step0001.tables, ...TABLES_0_2_NEW].sort());
    expect([...TABLES_0_2_NEW].sort()).toEqual(
      [
        "learnings",
        "labels",
        "task_labels",
        "attachments",
        "proposals",
        "exchanges",
        "exchange_items",
      ].sort(),
    );
    // The space's hold arrives with 0.2 (A1 3.4).
    expect(columnsOf("space").map((c) => c.name)).toContain("hold");
    expect([...step0001.tables].sort()).toEqual(
      [
        "space",
        "actors",
        "machines",
        "areas",
        "projects",
        "tasks",
        "notes",
        "log_entries",
        "sources",
        "task_sources",
        "places",
        "aliases",
        "preferences",
        "commits",
        "receipts",
        "changes",
        "outbox",
        "launches",
      ].sort(),
    );
  });

  test("every table is STRICT", () => {
    expect(tables.filter((t) => t.strict !== 1).map((t) => t.name)).toEqual([]);
  });

  test("no column name holds a forbidden word (R10, A6 L4)", () => {
    const forbidden = new Set<string>(FORBIDDEN_COLUMN_WORDS);
    const offenders = each((table, cols) =>
      cols
        .filter((c) =>
          c.name
            .toLowerCase()
            .split("_")
            .some((word) => forbidden.has(word)),
        )
        .map((c) => `${table}.${c.name}`),
    );
    expect(offenders).toEqual([]);
  });

  test("the lint itself catches a forbidden word and a table that is not STRICT", () => {
    conn.transaction("immediate", () => {
      conn.exec("CREATE TABLE lint_probe (id TEXT PRIMARY KEY, api_token TEXT)");
      const probe = conn
        .prepare("SELECT strict FROM pragma_table_list WHERE name = 'lint_probe'")
        .get<{ strict: number }>();
      const names = conn
        .prepare("SELECT name FROM pragma_table_info('lint_probe')")
        .all<{ name: string }>()
        .map((c) => c.name);
      expect(probe?.strict).toBe(0);
      expect(names.some((n) => n.split("_").includes("token"))).toBe(true);
      conn.exec("DROP TABLE lint_probe");
    });
  });

  test("every table declares a primary key", () => {
    expect(each((table, cols) => (cols.some((c) => c.pk > 0) ? [] : [table]))).toEqual([]);
  });

  test("WITHOUT ROWID exactly for the small-row tables, never on an INTEGER key", () => {
    const withoutRowid = tables.filter((t) => t.wr === 1).map((t) => t.name);
    expect(withoutRowid).toEqual([...WITHOUT_ROWID_TABLES].sort());
    for (const table of withoutRowid) {
      const key = columnsOf(table).filter((c) => c.pk > 0);
      expect(key.length === 1 && key[0]?.type === "INTEGER", table).toBe(false);
      // Small rows: no free text and no JSON other than the one-key version maps.
      const big = columnsOf(table).filter((c) =>
        ["title", "body", "context", "value", "ops", "before", "after", "lineage"].includes(c.name),
      );
      expect(big, table).toEqual([]);
      expect(
        (JSON_COLUMNS[table] ?? []).filter((c) => c !== "fv" && c !== "fp"),
        table,
      ).toEqual([]);
    }
    // The history table keeps a rowid: its rows spill to overflow pages in an index b-tree.
    expect(tables.find((t) => t.name === "changes")?.wr).toBe(0);
  });

  test("IDs are TEXT, and instants and sequence numbers are INTEGER", () => {
    const wrong = each((table, cols) =>
      cols.flatMap((c) => {
        const isIdColumn = c.name === "id" || c.name.endsWith("_id");
        const isInstant = c.name === "at" || c.name.endsWith("_at") || c.name === "first_seen";
        const isSeq = /(^|_)seq$/.test(c.name) || c.name === "version" || c.name === "touched";
        if (isIdColumn && c.type !== "TEXT") return [`${table}.${c.name} is ${c.type}`];
        if ((isInstant || isSeq) && c.type !== "INTEGER")
          return [`${table}.${c.name} is ${c.type}`];
        return [];
      }),
    );
    expect(wrong).toEqual([]);
  });

  test("mutable rows carry created_seq, version, fv and fp; fv, fp and ext are {} maps", () => {
    const problems = each((table, cols) => {
      const col = (name: string) => cols.find((c) => c.name === name);
      const out: string[] = [];
      if (col("created_seq") !== undefined) {
        for (const name of ["created_seq", "version"]) {
          const c = col(name);
          if (c?.type !== "INTEGER" || c.notnull !== 1) out.push(`${table}.${name}`);
        }
        for (const name of ["fv", "fp"])
          if (col(name) === undefined) out.push(`${table} lacks ${name}`);
      }
      for (const name of ["fv", "fp", "ext"]) {
        const c = col(name);
        if (c === undefined) continue;
        if (c.type !== "TEXT" || c.notnull !== 1 || c.dflt_value !== "'{}'") {
          out.push(`${table}.${name} is not a TEXT NOT NULL DEFAULT '{}' map`);
        }
      }
      return out;
    });
    expect(problems).toEqual([]);
  });

  test("every foreign key names an existing table's primary key, and the check passes", () => {
    const keys = new Map(
      tables.map(({ name }) => [
        name,
        columnsOf(name)
          .filter((c) => c.pk > 0)
          .map((c) => c.name),
      ]),
    );
    const problems = each((table) =>
      conn
        .prepare('SELECT "table", "from", "to" FROM pragma_foreign_key_list($t)')
        .all<ForeignKey>({ t: table })
        .flatMap((fk) => {
          const target = keys.get(fk.table);
          if (target === undefined) return [`${table}.${fk.from} names a missing table`];
          if (target.length !== 1 || (fk.to ?? target[0]) !== target[0]) {
            return [`${table}.${fk.from} does not name ${fk.table}'s primary key`];
          }
          return [];
        }),
    );
    expect(problems).toEqual([]);
    // A parent key that is not unique fails here with "foreign key mismatch".
    expect(conn.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(conn.pragma("foreign_keys")).toBe(1);
  });

  test("the foreign keys are exactly A1 3.4's, so a dropped one fails the lint", () => {
    const found = each((table) =>
      conn
        .prepare('SELECT "table", "from" FROM pragma_foreign_key_list($t)')
        .all<ForeignKey>({ t: table })
        .map((fk) => `${table}.${fk.from} -> ${fk.table}`),
    );
    expect(foreignKeyDifference(found, REQUIRED_FOREIGN_KEYS)).toEqual({
      missing: [],
      unexpected: [],
    });
    // The lint itself: a schema without one of them is caught.
    const dropped = found.filter((fk) => fk !== "notes.task_id -> tasks");
    expect(foreignKeyDifference(dropped, REQUIRED_FOREIGN_KEYS).missing).toEqual([
      "notes.task_id -> tasks",
    ]);
  });

  test("closed enumerations have a CHECK with exactly their values, and every IN list is one", () => {
    for (const { name } of tables) {
      const found = Object.fromEntries(inLists(tableSql.get(name) ?? ""));
      expect(found, name).toEqual(CLOSED_ENUMS[name] ?? {});
    }
  });

  test("every integer flag is a closed enumeration of 0 and 1", () => {
    // A1 3.4's flags. A flag without its CHECK would accept 17 (the reviewer's case: compacted).
    for (const [table, column] of [
      ["tasks", "inbox"],
      ["preferences", "policy"],
      ["commits", "compacted"],
      ["sessions", "bound"],
    ] as const) {
      expect(CLOSED_ENUMS[table]?.[column], `${table}.${column}`).toEqual([0, 1]);
      expect(columnsOf(table).find((c) => c.name === column)?.type).toBe("INTEGER");
    }
  });

  test("open sets name TEXT columns without a CHECK; changes.entity lists the history tables", () => {
    for (const key of Object.keys(OPEN_SETS)) {
      const [table = "", column = ""] = key.split(".");
      expect(columnsOf(table).find((c) => c.name === column)?.type, key).toBe("TEXT");
      expect(inLists(tableSql.get(table) ?? "").has(column), key).toBe(false);
      expect(CLOSED_ENUMS[table]?.[column], key).toBeUndefined();
    }
    const withHistory = tables
      .filter(({ name }) => columnsOf(name).some((c) => c.name === "created_seq"))
      .map((t) => t.name);
    // And the tables whose rows have no versions but change through change rows too.
    for (const name of VERSIONLESS_TABLES) {
      expect(
        columnsOf(name).some((c) => c.name === "created_seq"),
        name,
      ).toBe(false);
    }
    expect([...OPEN_SETS["changes.entity"]].sort()).toEqual(
      [...withHistory, ...VERSIONLESS_TABLES].sort(),
    );
  });

  test("JSON columns are TEXT with a json_valid CHECK, and only they have one", () => {
    for (const { name } of tables) {
      expect(jsonChecked(tableSql.get(name) ?? ""), name).toEqual(
        [...(JSON_COLUMNS[name] ?? [])].sort(),
      );
      for (const column of JSON_COLUMNS[name] ?? []) {
        expect(columnsOf(name).find((c) => c.name === column)?.type, `${name}.${column}`).toBe(
          "TEXT",
        );
      }
    }
  });

  test("the CHECKs refuse: an actor kind outside its set, and invalid JSON", () => {
    const refused = (sql: string): void => {
      try {
        conn.transaction("immediate", () => {
          conn.exec(sql);
        });
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe("STORAGE_CONSTRAINT");
        return;
      }
      throw new Error("the statement was not refused");
    };
    refused("UPDATE actors SET kind = 'robot'");
    refused("UPDATE space SET lineage = '{'");
    refused("UPDATE space SET ref_prefix = 'M1'");
    refused("UPDATE space SET one = 2");
  });

  test("the database format: application_id, user_version 0.6, incremental auto_vacuum, WAL", () => {
    expect(conn.pragma("application_id")).toBe(APP_ID);
    expect(conn.pragma("user_version")).toBe(encodeRevision(LATEST_REVISION));
    expect(encodeRevision({ major: 0, minor: 1 })).toBe(1);
    expect(LATEST_REVISION).toEqual({ major: 0, minor: 6 });
    expect(conn.pragma("user_version")).toBe(6);
    expect(conn.pragma("auto_vacuum")).toBe(2);
    expect(conn.pragma("journal_mode")).toBe("wal");
  });
});
