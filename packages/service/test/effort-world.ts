// A fixture space served in this thread for tests of the effort scale: the person's calls, an
// agent's tools as MCP renders them, a raw row for states no build of this version writes, and the
// readable file of a task as the projection renders it. Fixture text only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AppError, type ErrorBody } from "@ttasks/contracts";
import { readBatch, renderTask } from "@ttasks/projection";
import { openSpaceConnection, type ReceiptLookup, type SpaceWriterHandle } from "@ttasks/storage";
import type { WriteRequest } from "@ttasks/storage";
import { fixtureCopies, MACHINE, type Fixture } from "@ttasks/storage/write-helpers";
import { checkedDriver } from "@ttasks/testkit";
import { toolCaller } from "../src/mcp/index.ts";
import type { Caller } from "../src/ops/caller.ts";
import { opCall, type OpsHost } from "../src/ops/index.ts";
import { readerOf, tempRoot } from "./harness.ts";

export type Json = Record<string, unknown>;

/** Fresh copies of one fixture space, made once, and the folder they live in. */
export function effortSpaces(label: string): {
  next: () => Promise<EffortWorld>;
  cleanup: () => void;
} {
  const temp = tempRoot(label);
  let k = 0;
  const copies = fixtureCopies(() => {
    const folder = join(temp.root, String((k += 1)));
    mkdirSync(folder);
    return folder;
  });
  const open: Fixture[] = [];
  return {
    next: async () => {
      const fx = await copies();
      open.push(fx);
      return effortWorld(fx);
    },
    cleanup: () => {
      for (const fx of open.splice(0)) fx.close();
      temp.cleanup();
    },
  };
}

const person: Caller = { class: "cli-interactive", env: {} };

export interface EffortWorld {
  readonly fx: Fixture;
  /** An operation as the person calls it from a terminal. */
  call(op: string, input: Json): Promise<Json>;
  /** The refusal an operation of the person's ends in. */
  refusal(op: string, input: Json): Promise<ErrorBody>;
  /** An agent's tool, as the text MCP sends back. */
  tool(name: string, args: Json): Promise<string>;
  /** `ttasks prefs set tasks.effort_scale <names>` as the person. */
  setScale(names: readonly string[]): Promise<void>;
  /** The preference's row as some build wrote it, past every check of this one. */
  store(value: string, schemaVer: number): Promise<void>;
  base(): Promise<string>;
  rid(): string;
  /** The readable file of the task `ref`. */
  file(ref: string): string;
}

function effortWorld(fx: Fixture): EffortWorld {
  const host: OpsHost = {
    machine: { id: MACHINE.id },
    spaces: () => [
      {
        id: fx.spaceId,
        name: "Mira",
        state: "open",
        writer: {
          spaceId: fx.spaceId,
          submit: (request: WriteRequest) => Promise.resolve(fx.writer.submit(request)),
          receipt: (lookup: ReceiptLookup) => Promise.resolve(fx.writer.receipt(lookup)),
          actor: (kind: "human" | "agent", label: string) =>
            Promise.resolve(fx.writer.actor(kind, label)),
        } as unknown as SpaceWriterHandle,
        reader: readerOf(fx.reader),
      },
    ],
    now: () => Date.UTC(2026, 10, 23, 9, 0, 0),
    timeZone: () => "UTC",
    homes: { may: (_, space) => space === fx.spaceId, spaceOf: () => fx.spaceId },
  };
  const agent = toolCaller({
    ops: host,
    context: { space: null, instance: "effort-agent", app: "test", env: {} },
    conn: 1,
    binding: { kind: "none", space: fx.spaceId, named: false },
  });
  let n = 0;
  const call = async (op: string, input: Json): Promise<Json> =>
    (await opCall(host, person, { op, input })) as Json;
  const base = async (): Promise<string> => (await call("space.status", {}))["as_of"] as string;
  const rid = (): string => `fixture-effort-${String((n += 1)).padStart(8, "0")}`;
  return {
    fx,
    call,
    refusal: async (op, input) => {
      try {
        await call(op, input);
      } catch (error) {
        if (error instanceof AppError) return error.toBody();
        throw error;
      }
      throw new Error(`${op} was not refused`);
    },
    tool: async (name, args) => (await agent(name, args)).content[0].text,
    setScale: async (names) => {
      await call("prefs.manage", {
        action: "set",
        set: [{ key: "tasks.effort_scale", value: names.join(",") }],
        base: await base(),
        request_id: rid(),
      });
    },
    store: async (value, schemaVer) => {
      const conn = openSpaceConnection(
        await checkedDriver(),
        join(fx.folder, "space.db"),
        "writer",
      );
      try {
        conn
          .prepare(
            "INSERT INTO preferences (key, value, schema_ver, policy, created_seq, version) " +
              "VALUES ('tasks.effort_scale', $value, $ver, 0, 0, 0) " +
              "ON CONFLICT (key) DO UPDATE SET value = $value, schema_ver = $ver",
          )
          .run({ value, ver: schemaVer });
      } finally {
        conn.close();
      }
    },
    base,
    rid,
    file: (ref) => {
      const batch = readBatch(fx.reader, 10_000);
      const task = [...batch.tasks.values()].find(
        (t) => `${batch.space.refPrefix}-${String(t.ref)}` === ref,
      );
      if (task === undefined) throw new Error(`no readable file for ${ref}`);
      return renderTask(batch.space, task, "UTC").content;
    },
  };
}
