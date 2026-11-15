// An import's world in one thread (A7 3.15.5, 3.15.6): the Mira sample space opened as its writer
// and a reader, and the service's own dry run, apply and undo (packages/service ops) on top, with
// the storage worker's barrier (submitBehindBackup) in place of the worker. The space's writer and
// reader are the real ones; only the worker's message passing is left out, so the tests and the
// crash child run the service's code against a real space, fast. Fixture data only, in temporary
// folders the caller removes by their full names.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ImportPlanningApplyResult,
  ImportPlanningPreviewResult,
  ImportPlanningUndoResult,
} from "../../packages/contracts/src/index.ts";
import {
  planningApply,
  planningPreview,
  planningUndo,
} from "../../packages/service/src/ops/import-planning.ts";
import {
  formatAsOf,
  newId,
  openSpace,
  SpaceWriter,
  submitBehindBackup,
  type Connection,
  type Id,
  type Operation,
  type Row,
  type SpaceWriterHandle,
  type WorkerConnection,
  type WriteResult,
} from "../../packages/storage/src/index.ts";
import type { BackupSeams } from "../../packages/storage/src/backup/backup.ts";
import type { CheckedDriver } from "../../packages/storage/src/startup-check.ts";
import type { WriteSeams } from "../../packages/storage/src/write/writer.ts";
import { checkedDriver, MIRA, seedMira } from "../../packages/testkit/src/index.ts";

/** The import's time zone in every test: days are 09:00 there. */
export const ZONE = "Europe/Amsterdam";

/** The user's writer scope, as an interactive CLI's. */
const SCOPE = "cli:import-test";

export interface WorldOptions {
  /** The Mira sample's size. */
  readonly tasks?: number;
  readonly seed?: string;
  /** Seams of the import's barrier backup. */
  readonly barrier?: BackupSeams;
  /** Seams of the writer's transaction. */
  readonly write?: WriteSeams;
  /** This machine's roots. */
  readonly roots?: readonly { id: string; path: string }[];
}

export interface ImportWorld {
  readonly folder: string;
  readonly machine: Id<"m">;
  readonly user: Id<"ac">;
  readonly writer: SpaceWriter;
  /** The reader's own connection: what the tests read the space with. */
  readonly conn: Connection;
  preview(input: Record<string, unknown>): Promise<ImportPlanningPreviewResult>;
  apply(run: string, token: string): Promise<ImportPlanningApplyResult>;
  undo(run: string): Promise<ImportPlanningUndoResult>;
  /** The person's own change, through the writer, on the space as it is now. */
  edit(ops: Operation[]): WriteResult;
  rows(sql: string, params?: Record<string, string | number | null>): Row[];
  /** The space's last seq. */
  seq(): number;
  close(): void;
}

/** A reader over one connection, as the storage worker's (only `transaction` is used). */
function readerOf(conn: Connection): WorkerConnection {
  return {
    transaction: (mode: "deferred" | "immediate", queries: { sql: string; mode: string; params?: Record<string, unknown> }[]) =>
      Promise.resolve(
        conn.transaction(mode, () =>
          queries.map((q) => {
            const statement = conn.prepare(q.sql);
            const params = q.params as Record<string, string | number | null> | undefined;
            if (q.mode === "get") return statement.get(params) ?? null;
            if (q.mode === "all") return statement.all(params);
            return statement.run(params);
          }),
        ),
      ),
  } as unknown as WorkerConnection;
}

/** The space's writer, as the storage worker's handle (only what the import uses). */
function handleOf(
  checked: CheckedDriver,
  writer: SpaceWriter,
  barrier: BackupSeams,
): SpaceWriterHandle {
  return {
    spaceId: writer.spaceId,
    receipt: (lookup: Parameters<SpaceWriter["receipt"]>[0]) => Promise.resolve(writer.receipt(lookup)),
    actor: (kind: "human" | "agent" | "import", label: string) =>
      Promise.resolve(writer.actor(kind, label)),
    submit: (request: unknown) => Promise.resolve(writer.submit(request)),
    importSubmit: (request: unknown, options: { backupDir?: string }) =>
      submitBehindBackup(
        checked,
        writer,
        request,
        {
          folder: writer.folder,
          ...(options.backupDir === undefined ? {} : { backupDir: options.backupDir }),
        },
        barrier,
      ),
  } as unknown as SpaceWriterHandle;
}

/** Opens the Mira sample in `root` (made by the caller) as an import's world. */
export async function openWorld(root: string, options: WorldOptions = {}): Promise<ImportWorld> {
  mkdirSync(join(root, "spaces"), { recursive: true });
  const seeded = await seedMira(join(root, "spaces"), {
    seed: options.seed ?? "import",
    tasks: options.tasks ?? 6,
  });
  return attachWorld(seeded.folder, seeded.machine, options);
}

/** An import's world on a space that exists: the crash child's after the parent made it. */
export async function attachWorld(
  folder: string,
  machine: Id<"m">,
  options: WorldOptions = {},
): Promise<ImportWorld> {
  const checked = await checkedDriver();
  const opened = openSpace(checked, folder, { role: "writer" });
  const writer = SpaceWriter.open(
    opened,
    { machine: { id: machine, name: MIRA.machine.name, os: MIRA.machine.os } },
    options.write ?? {},
  );
  const read = openSpace(checked, folder, { role: "reader" });
  const conn = read.conn;
  const reader = readerOf(conn);
  const handle = handleOf(checked, writer, options.barrier ?? {});
  const user = writer.actor("human", "");
  const roots = options.roots ?? [];
  const principal = { scope: SCOPE, machine };
  return {
    folder,
    machine,
    user,
    writer,
    conn,
    preview: (input) =>
      planningPreview({
        folder,
        reader,
        input,
        roots,
        platform: process.platform,
        timeZone: ZONE,
      }),
    apply: async (run, token) =>
      planningApply({
        folder,
        reader,
        writer: handle,
        input: { run, token },
        roots,
        platform: process.platform,
        principal: user,
        importer: () => Promise.resolve(writer.actor("import", "import")),
        scope: principal.scope,
        machine,
      }),
    undo: (run) =>
      planningUndo({
        reader,
        writer: handle,
        input: { run },
        principal: user,
        scope: principal.scope,
        machine,
        origin: "cli",
      }),
    edit: (ops) =>
      writer.submit({
        space_id: writer.spaceId,
        request_id: `edit-${newId("op").slice(3)}`,
        actor: {
          scope_id: SCOPE,
          principal_id: user,
          actor_kind: "human",
          machine_id: machine,
          origin: "cli",
        },
        base: formatAsOf(writer.asOf()),
        undoable: true,
        ops,
      }),
    rows: (sql, params = {}) => conn.prepare(sql).all(params),
    seq: () => writer.asOf().seq,
    close: () => {
      conn.close();
      writer.close();
    },
  };
}

/** One task line of a synthetic prototype. */
export interface ProtoTask {
  readonly id: string;
  readonly title: string;
  readonly body?: string;
  readonly done?: { readonly date: string; readonly evidence: string };
  readonly ticked?: boolean;
  readonly heading?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** One prototype folder: its ledgers, metadata and event files. */
export interface Prototype {
  readonly tasks: readonly ProtoTask[];
  readonly events?: readonly { id: string; task: string; action: string; at: string }[];
}

/** Writes `proto` into `folder` (made here), as the prototype writes its files. */
export function writePrototype(folder: string, proto: Prototype): void {
  mkdirSync(join(folder, "data"), { recursive: true });
  mkdirSync(join(folder, "events"), { recursive: true });
  const todo: string[] = [];
  const done: string[] = ["# Done", ""];
  let heading: string | undefined;
  for (const t of proto.tasks) {
    const body = t.body === undefined || t.body === "" ? "" : ` ${t.body}`;
    if (t.done !== undefined) {
      done.push(
        `- [x] **${t.title}**${body} (done ${t.done.date}; ${t.done.evidence}) <!-- task:${t.id} -->`,
      );
      continue;
    }
    if (t.heading !== undefined && t.heading !== heading) {
      todo.push(`## ${t.heading}`);
      heading = t.heading;
    }
    todo.push(`- [${t.ticked === true ? "x" : " "}] **${t.title}**${body} <!-- task:${t.id} -->`);
  }
  writeFileSync(join(folder, "TODO.md"), `${todo.join("\n")}\n`);
  writeFileSync(join(folder, "DONE.md"), `${done.join("\n")}\n`);
  const metadata: Record<string, unknown> = {};
  for (const t of proto.tasks) if (t.meta !== undefined) metadata[t.id] = t.meta;
  writeFileSync(join(folder, "data", "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  for (const e of proto.events ?? []) {
    writeFileSync(join(folder, "events", `${e.id}.json`), `${JSON.stringify(e, null, 2)}\n`);
  }
}
