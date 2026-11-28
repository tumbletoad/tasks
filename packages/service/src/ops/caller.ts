// Who calls: the connection class decides the audience of the input, the actor in history and the
// writer scope. The client never names a principal. A session (binding.ts) writes as itself, under
// its own scope only: a request is found again only through the scope that wrote it.
import { PRODUCT_NAME } from "@ttasks/brand";
import type { AnyEntry } from "@ttasks/contracts";
import { AppError } from "@ttasks/contracts";
import type { ConnectionClass } from "../local/index.ts";
import type { Binding, Session } from "./binding.ts";

export interface Caller {
  readonly class: ConnectionClass;
  /** The bind context's environment: the agent markers and TTASKS_SPACE (A2 3.6.4). */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The UI's grant row (A2 3.2.5), for the `ui` class: its writer scope is the grant's (A3
   * 3.7.9 "`ui`: the user's UI scope, A2's UI grant"), so each browser session has its own.
   */
  readonly grant?: string;
  /**
   * The copy of its space the call was made for (ServedSpace `copy`): the one a page loaded, or
   * the one a click's note was checked against. A call is refused when the space is served from
   * another copy now (ops/copies.ts copyGone).
   */
  readonly copy?: string;
  /**
   * The principal the transport determined for this connection when it is no session and its
   * class has no fixed one: an MCP connection's (mcp/principal.ts), or the one a handler writes a
   * step under on the caller's behalf (`launch.open`'s note). Otherwise the class's.
   */
  readonly principal?: Principal;
  /**
   * What the connection says about the agent app it serves, for `status`'s session line: the
   * bridge's instance and app words from its entry. Shown, never trusted.
   */
  readonly client?: { readonly instance?: string; readonly app?: string };
  /**
   * The agent home an MCP connection that is no session belongs to, for the grant gate: the
   * instance its entry names, or `manual` for an entry without one.
   */
  readonly home?: string;
  /**
   * A bridge's binding, fixed at its bind. A shell's call is decided as it starts (`opCall`) and
   * carries none here.
   */
  readonly binding?: Binding;
  /**
   * The bridge's working folder as its bind frame said: a best-effort app's link launch is marked
   * Connected only from the folder its link named. It decides nothing else.
   */
  readonly folder?: string;
  /**
   * Whether the caller's face shows an entry's result whole: an agent's tool text has a budget.
   * A page of search then holds only the rows it shows, so its cursor goes on from the first row
   * left out. Absent: every row a page holds is shown.
   */
  readonly shows?: (entry: string, result: unknown) => boolean;
}

export interface Principal {
  /** Which input an entry parses (A3 3.2.1): agents and routines get the agent input. */
  readonly audience: "user" | "agent";
  /** A1's actor kind of the principal. */
  readonly actorKind: "human" | "agent";
  /** The actor's label: `user` for the space's human, else A3 3.7.4's name. */
  readonly label: string;
  /** The writer scope: receipts are keyed by it. Stable across processes. */
  readonly scope: string;
  readonly origin: "cli" | "ui" | "mcp";
  /** The session (`se_` ID): A1's credential carries it into every commit and log entry. */
  readonly session?: string;
  /**
   * The background run (`ru_` ID) the session acts for, when TTasks started its agent: the
   * credential carries it too, so what the agent changes is recorded as the run's.
   */
  readonly run?: string;
}

/**
 * The principal of an unbound connection of `cls` on machine `machine` (A3 3.7.4, 3.7.9). Each
 * scope names the machine: receipts live in the space, which can move between machines.
 */
export function principalOf(cls: ConnectionClass, machine: string, grant?: string): Principal {
  switch (cls) {
    case "cli-interactive":
      return {
        audience: "user",
        actorKind: "human",
        label: "user",
        scope: `user-cli:${machine}`,
        origin: "cli",
      };
    case "ui":
      // A UI session's grant ID is unique for its life (`gr_` and 128 random bits), so its scope
      // needs no machine; a caller without a grant (an in-process caller) keeps the machine's.
      return {
        audience: "user",
        actorKind: "human",
        label: "user",
        scope: grant === undefined ? `user-ui:${machine}` : `ui:${grant}`,
        origin: "ui",
      };
    case "cli-script":
      return {
        audience: "agent",
        actorKind: "agent",
        label: "script",
        scope: `script:${machine}`,
        origin: "cli",
      };
    case "cli-agent":
      return {
        audience: "agent",
        actorKind: "agent",
        label: "agent:unknown",
        scope: `agent:unknown:${machine}`,
        origin: "cli",
      };
    case "bridge":
    case "shim":
      // The bridge's tools pass their own (Caller.principal, mcp/principal.ts); A4's shim calls no
      // operation.
      throw new AppError({
        code: "forbidden",
        message: "This connection cannot call operations.",
        data: { rule: "connection_class", class: cls },
      });
  }
}

/**
 * The principal of a session's call: the actor `agent:<instance>:<session>` and the session as
 * writer scope, the same for its bridge and its shell, and the run a run's session acts for.
 */
export function sessionPrincipal(
  session: Session,
  instance: string,
  origin: "mcp" | "cli",
): Principal {
  return {
    audience: "agent",
    actorKind: "agent",
    label: `agent:${instance}:${session.session}`,
    scope: `session:${session.session}`,
    origin,
    session: session.session,
    ...(session.home.of === "run" ? { run: session.home.run } : {}),
  };
}

/** Whether the class may call user-only entries: `ui` and `cli-interactive` (A2 3.6.5, A3 3.2.3). */
export const isUserClass = (cls: ConnectionClass): boolean =>
  cls === "ui" || cls === "cli-interactive";

/** The refusal of what only the user may do, to any other caller. */
export const USER_ONLY = (): AppError =>
  new AppError({
    code: "forbidden",
    message: "Only the user can do this.",
    hint: `Ask the user to do this in ${PRODUCT_NAME}.`,
    data: { rule: "user_only" },
  });

/** Entries whose refusal to an agent says why it is the user's, by entry name. */
const USER_ONLY_WORDS: Readonly<Record<string, { message: string; hint: string }>> = {
  "note.remove": {
    message: "Only the user takes back a note or puts one back: agents cannot remove notes.",
    hint: "Tell the user which note you would remove and why.",
  },
  "entry.edit": {
    message: "Only the user corrects the words of a note or a log entry.",
    hint: "Log a new entry, or tell the user what you would correct and why.",
  },
  "node.instruct": {
    message: "Only the user writes the text for agents on the space, an area or a project.",
    hint: "Tell the user what standing instruction you would suggest, and why.",
  },
};

/**
 * Whether `cls` may call `entry` at all (A3 3.2.3): user-only entries refuse every class but `ui`
 * and `cli-interactive`, UI-only ones every class but `ui`. Each refusal comes before the call
 * reads its input or a space, so it writes nothing.
 */
export function checkExposure(entry: AnyEntry, cls: ConnectionClass): void {
  switch (entry.actors) {
    case "user": {
      if (isUserClass(cls)) return;
      const words = USER_ONLY_WORDS[entry.name];
      if (words === undefined) throw USER_ONLY();
      throw new AppError({ code: "forbidden", ...words, data: { rule: "user_only" } });
    }
    case "ui":
      if (cls !== "ui") {
        throw new AppError({
          code: "forbidden",
          message: `Only ${PRODUCT_NAME}'s UI can do this.`,
          data: { rule: "ui_only" },
        });
      }
      return;
    case "agent":
      return;
  }
}

/** The steps of a path such as `tasks[].log`: field names, and `[]` for every element. */
function present(value: unknown, steps: readonly string[]): boolean {
  if (steps.length === 0) return value !== undefined;
  const [step, ...rest] = steps;
  if (step === "[]") {
    return Array.isArray(value) && value.some((item: unknown) => present(item, rest));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return step !== undefined && Object.hasOwn(record, step) && present(record[step], rest);
}

/**
 * Refuses a user-only field that an agent sent (A3 3.2.1: `agentProjection()` drops it, and the
 * handler rejects it from agent actors with `forbidden`, rule `user_only`).
 */
export function checkHiddenFields(entry: AnyEntry, input: unknown, audience: "user" | "agent") {
  if (audience !== "agent") return;
  for (const path of entry.agent?.hidden ?? []) {
    const steps = path.match(/[a-z][a-z0-9_]*|\[\]/g) ?? [];
    if (present(input, steps)) throw USER_ONLY();
  }
}
