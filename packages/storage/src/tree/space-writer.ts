// A tree space's writer as the storage worker hosts it, beside today's SpaceWriter: the calls the
// service makes of a space's writer, answered by the tree's commands. Only test and trial spaces
// are trees until the switch; what a later family of commands brings is refused until it comes.
import type { Connection } from "../driver.ts";
import { StorageError } from "../errors.ts";
import type { Id, RandomSource } from "../ids.ts";
import type { ReceiptLookup } from "../write/receipts.ts";
import type { MachineInfo } from "../write/writer.ts";
import { TreeWriter, type TreeResult } from "./core.ts";

const SQL = {
  receipt: "SELECT result FROM receipts WHERE scope_id = $scope AND request_id = $request",
} as const;

export class TreeSpaceWriter {
  readonly backend = "tree";
  readonly #conn: Connection;
  readonly #writer: TreeWriter;
  readonly #machine: MachineInfo;

  constructor(conn: Connection, machine: MachineInfo, random?: RandomSource) {
    this.#conn = conn;
    this.#machine = machine;
    this.#writer = new TreeWriter(conn, {
      machineId: machine.id,
      ...(random === undefined ? {} : { random }),
    });
  }

  /** Registers this machine once, by a system commit; only the authority writes. */
  registerMachine(): boolean {
    return this.#writer.registerMachine({ name: this.#machine.name, os: this.#machine.os });
  }

  storeDefaults(): boolean {
    return this.#writer.storeDefaults();
  }

  actor(kind: "human" | "agent", label: string): Id<"ac"> {
    return this.#writer.actor(kind, label);
  }

  submit(request: unknown): TreeResult {
    return this.#writer.submit(request);
  }

  /** The answer a request decided, as its receipt keeps it; undefined when none was decided. */
  receipt(lookup: ReceiptLookup): TreeResult | undefined {
    const row = this.#conn.transaction("deferred", () =>
      this.#conn.prepare(SQL.receipt).get({ scope: lookup.scope_id, request: lookup.request_id }),
    );
    return row === undefined ? undefined : (JSON.parse(String(row["result"])) as TreeResult);
  }

  /** What Open and Run, the projector and today's index ask of a space: not on a tree yet. */
  notYet(): never {
    throw new StorageError("STORAGE_UNSUPPORTED", "A tree space does not do this yet");
  }

  close(): void {
    this.#conn.close();
  }
}
