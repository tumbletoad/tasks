// The machine's default space (A2 3.1, 3.2.4, 3.10.5; A5 3.3): `[service] default_space` in
// machine.toml. It decides only what a new browser tab (`/`) and an unbound CLI call use. A tab
// that names its space, a bridge, a shim and a bound CLI call never look at it.
//
// Only an explicit act of the person changes it: "Make default" in the UI (`POST
// /api/v1/space/default`, the UI's grant is the person) or `tasks space use <space>` (`space/use`,
// the user's classes only). Both come here. The edit goes through `prepareEdit`/`commitEdit`
// (A2 3.2.4): one key set in `[service]`, every other byte of the file kept, written only if
// the file is still the one checked. The service holds the value it read at start and each value it
// wrote since (reloading the whole file on change is not built, A2 3.2.4).
import type { JsonObject } from "@tasks/bridge/protocol";
import { AppError } from "@tasks/contracts";
import { isId, type Id } from "@tasks/storage";
import { commitEdit, prepareEdit, type EditRefusal } from "../config/edit.ts";
import type { ConnectionClass } from "../local/index.ts";
import { isUserClass } from "../ops/index.ts";
import type { Logger } from "./log.ts";

/** A space the service knows, as the default's check reads it. */
export interface KnownSpace {
  readonly id?: string | undefined;
  readonly state: string;
}

export interface DefaultSpaceOptions {
  /** The folder of machine.toml. */
  readonly configDir: string;
  readonly log: Logger;
  /** machine.toml's value at start. */
  readonly initial: Id<"sp"> | undefined;
  /** The spaces the service has now: a default must name one of them. */
  readonly known: () => readonly KnownSpace[];
}

/** Who asked: the UI's Make default, or `tasks space use`. Logged as a word, nothing else. */
export type DefaultSource = "ui" | "cli";

function refused(reason: EditRefusal): AppError {
  switch (reason) {
    case "changed_meanwhile":
      return new AppError({
        code: "conflict",
        message: "machine.toml changed while the default space was being set.",
        hint: "Try again.",
      });
    case "invalid_file":
      return new AppError({
        code: "invalid_input",
        message: "machine.toml cannot be read as it is, so nothing was changed.",
        hint: "Run tasks doctor, then fix machine.toml.",
      });
    case "unsupported_layout":
      return new AppError({
        code: "invalid_input",
        message: "machine.toml writes [service] in a way this command cannot change.",
        hint: "Set default_space in machine.toml by hand.",
      });
    default:
      return new AppError({
        code: "invalid_input",
        message: "The default space cannot be written to machine.toml.",
      });
  }
}

type Verb = (params: JsonObject, cls: ConnectionClass) => Promise<unknown>;

/**
 * `space/use {space}` (`tasks space use <space>`): the user only. The method table already lets
 * only `cli-interactive` call it; the class is checked again, so another transport refuses agents
 * too. `space` is the space's ID (the CLI resolves a name or a folder through `space/list`).
 */
export function defaultSpaceVerbs(defaults: Pick<DefaultSpace, "make">): Record<string, Verb> {
  return {
    "space/use": (params, cls) => {
      if (!isUserClass(cls)) {
        return Promise.reject(
          new AppError({
            code: "forbidden",
            message: "Only the user can do this.",
            hint: "Ask the user to choose the default space.",
            data: { rule: "user_only" },
          }),
        );
      }
      return defaults.make(params["space"], "cli");
    },
  };
}

export class DefaultSpace {
  readonly #options: DefaultSpaceOptions;
  #current: Id<"sp"> | undefined;
  /** Sets run one at a time, each against the file the one before it wrote. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: DefaultSpaceOptions) {
    this.#options = options;
    this.#current = options.initial;
  }

  /** The default space's ID, or undefined when the machine has none. */
  get(): Id<"sp"> | undefined {
    return this.#current;
  }

  /**
   * Makes `wanted` (a space ID) the machine's default. It must be a space this service has, open or
   * not: a space that is unavailable for a moment stays the person's choice. Resolves with it.
   */
  make(wanted: unknown, source: DefaultSource): Promise<{ default: Id<"sp"> }> {
    if (typeof wanted !== "string" || !isId(wanted, "sp")) {
      return Promise.reject(
        new AppError({
          code: "invalid_input",
          message: "Expected a space ID.",
          data: { issues: [{ path: "space", message: "Expected a space ID" }] },
        }),
      );
    }
    const run = this.#queue.then(
      () => this.#set(wanted, source),
      () => this.#set(wanted, source),
    );
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #set(id: Id<"sp">, source: DefaultSource): { default: Id<"sp"> } {
    if (!this.#options.known().some((space) => space.id === id && space.state !== "closed")) {
      throw new AppError({
        code: "not_found",
        message: "This machine has no space with that ID.",
        hint: "Run tasks space list.",
      });
    }
    if (this.#current === id) return { default: id };
    const prepared = prepareEdit(this.#options.configDir, [
      { op: "set", table: ["service"], key: "default_space", value: id },
    ]);
    if (!prepared.ok) throw refused(prepared.reason);
    const edited = commitEdit(prepared.edit);
    if (!edited.ok) throw refused(edited.reason);
    this.#current = id;
    this.#options.log.log("config.default_space_set", { source });
    return { default: id };
  }
}
