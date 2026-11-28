// A tree space's writer as the storage worker hosts it, beside today's SpaceWriter: the calls the
// service makes of a space's writer, answered by the tree's commands. Only test and trial spaces
// are trees until the switch; what a later family of commands brings is refused until it comes.
import type { Connection } from "../driver.ts";
import { StorageError } from "../errors.ts";
import type { Id } from "../ids.ts";
import { readReceipt, type Receipt, type ReceiptLookup } from "../write/receipts.ts";
import type { WriteResult } from "../write/request.ts";
import type { MachineInfo } from "../write/writer.ts";
import { TreeWriter } from "./core.ts";

export class TreeSpaceWriter {
  readonly backend = "tree";
  readonly #conn: Connection;
  readonly #writer: TreeWriter;
  readonly #machine: MachineInfo;

  constructor(conn: Connection, machine: MachineInfo, clock?: () => number) {
    this.#conn = conn;
    this.#machine = machine;
    this.#writer = new TreeWriter(conn, {
      machineId: machine.id,
      ...(clock === undefined ? {} : { clock }),
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

  /**
   * Today's request, its operations run as the tree's commands (plan.ts), or a request that names
   * one of the tree's own commands, for what has no form in today's operations (routines).
   */
  submit(request: unknown): WriteResult {
    const own = typeof request === "object" && request !== null && "command" in request;
    return own ? this.#writer.submitCommand(request) : this.#writer.submitPlan(request);
  }

  /** A request's receipt, as today's writer keeps one; undefined when none was decided. */
  receipt(lookup: ReceiptLookup): Receipt | undefined {
    return this.#conn.transaction("deferred", () => readReceipt(this.#conn, lookup));
  }

  /** What Open and Run, the projector and today's index ask of a space: not on a tree yet. */
  notYet(): never {
    throw new StorageError("STORAGE_UNSUPPORTED", "A tree space does not do this yet");
  }

  close(): void {
    this.#conn.close();
  }
}
