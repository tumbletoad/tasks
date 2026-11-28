// A bridge's bind: who its connection is (decide.ts), and the one space it works in for its life.
// The space is settled here and nowhere else, so no call ever picks or pins one for a bridge:
// - what its process holds from an earlier bind (the bind frame's `held_space`) wins: a space, or
//   none, which it keeps for its life;
// - else a session's space is its launch's or run's, whatever its entry names (the grant gate
//   refuses it there until its home is registered for that space);
// - else the entry's `--space`, else the machine's default, else the only space. The default and
//   the only space are read by registered ID, so a bind while spaces are still opening settles
//   them; an entry's space name that cannot be resolved yet fails the bind as retryable.
// A bridge that still has no space has none until its process ends: every call is refused, and
// says what settles it.
//
// The binding is fixed from here until the connection closes. A bind writes nothing.
import type { JsonObject } from "@ttasks/bridge/protocol";
import { isId } from "@ttasks/storage";
import type { Binding, SessionPort } from "../ops/index.ts";

export interface BridgesOptions {
  readonly sessions: SessionPort;
  /**
   * The registered spaces and their states: the space manager's, or before it exists the enabled
   * spaces of the configuration, as opening.
   */
  spaces(): readonly {
    readonly id: string | undefined;
    readonly registered?: string | undefined;
    readonly name: string | undefined;
    readonly state: string;
  }[];
  /** machine.toml's `[service] default_space` as it is now. */
  defaultSpace(): string | undefined;
}

/** The bind could not be decided now: the bind fails, and the bridge tries again. */
export class BindNotYet extends Error {
  constructor() {
    super("The binding cannot be decided yet");
    this.name = "BindNotYet";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const word = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** What the bridge process holds: a space ID, null for none, undefined when it holds nothing. */
function heldOf(context: JsonObject): string | null | undefined {
  const held = context["held_space"];
  if (held === null) return null;
  return typeof held === "string" && isId(held, "sp") ? held : undefined;
}

/** The bind context's environment: its text values only. */
function envOf(context: JsonObject): Record<string, string> {
  const env = context["env"];
  const out: Record<string, string> = {};
  if (!isObject(env)) return out;
  for (const [name, value] of Object.entries(env)) if (typeof value === "string") out[name] = value;
  return out;
}

export class Bridges {
  readonly #options: BridgesOptions;
  readonly #bound = new WeakMap<object, Binding>();
  readonly #open = new Set<object>();

  constructor(options: BridgesOptions) {
    this.#options = options;
  }

  /**
   * The bind frame of an mcp mode connection: its binding, kept for `attach`, and the bind
   * result's `{space, state}`. Throws `BindNotYet` when it cannot be decided now.
   */
  bind(connection: { readonly context: JsonObject }): JsonObject {
    const context = connection.context;
    const held = heldOf(context);
    const decision = this.#options.sessions.decide({
      via: "bridge",
      instance: word(context["instance"]),
      app: word(context["app"]),
      env: envOf(context),
      held,
    });
    if (decision.kind === "failed") throw new BindNotYet();
    const binding: Binding =
      decision.kind === "session"
        ? { kind: "session", session: decision.session }
        : {
            kind: "none",
            space: this.#spaceOf(context, held),
            named: word(context["space"]) !== null,
          };
    this.#bound.set(connection, binding);
    const space = binding.kind === "session" ? binding.session.space : binding.space;
    return { space: space ?? null, state: binding.kind === "session" ? "bound" : "unbound" };
  }

  /** The space of a connection that is none. */
  #spaceOf(context: JsonObject, held: string | null | undefined): string | undefined {
    if (held !== undefined) return held ?? undefined;
    return this.#settle(word(context["space"]));
  }

  /** The space of a connection that is none and holds none: its entry's, the default, the only. */
  #settle(named: string | null): string | undefined {
    const spaces = this.#options.spaces().filter((s) => s.state !== "closed");
    if (named !== null) {
      if (isId(named, "sp")) return named;
      const folded = named.toLowerCase();
      // Copies of one space share its ID and name: they count as one space here.
      const ids = new Set(
        spaces.flatMap((s) =>
          s.id !== undefined && s.name?.toLowerCase() === folded ? [s.id] : [],
        ),
      );
      if (ids.size === 1) return [...ids][0];
      if (ids.size === 0 && spaces.some((s) => s.state === "opening")) throw new BindNotYet();
      return undefined;
    }
    const configured = this.#options.defaultSpace();
    if (configured !== undefined) return configured;
    const ids = new Set<string>();
    for (const space of spaces) {
      const id = space.id ?? space.registered;
      if (id !== undefined) ids.add(id);
    }
    return ids.size === 1 ? [...ids][0] : undefined;
  }

  /** The mcp hook: the binding of a connection whose bind was answered, open from now. */
  attach(connection: object): Binding | undefined {
    const binding = this.#bound.get(connection);
    if (binding !== undefined) this.#open.add(connection);
    return binding;
  }

  /** The connection ended. */
  closed(connection: object): void {
    this.#open.delete(connection);
  }

  /** How many bridge connections are open now, and how many are a launch's or a run's session. */
  get open(): { readonly connections: number; readonly launch: number; readonly run: number } {
    const counts = { connections: 0, launch: 0, run: 0 };
    for (const connection of this.#open) {
      counts.connections += 1;
      const binding = this.#bound.get(connection);
      if (binding?.kind === "session") counts[binding.session.home.of] += 1;
    }
    return counts;
  }
}
