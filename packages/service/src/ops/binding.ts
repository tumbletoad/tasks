// Who a connection is, as the request path reads it: a session of a launch or a run TTasks started,
// or none, the connection's own identity. A bridge is decided at its bind and keeps its value until
// it closes; a shell is decided at each call (binding/decide.ts). Nothing on the request path
// changes one, so one connection never writes under two names.

/** What lets a session use a space, checked on every call: its launch's home, or its run. */
export type SessionHome =
  | {
      readonly of: "launch";
      /** The agent app and home folder the click recorded. A click may record no folder. */
      readonly app: string;
      readonly home: string | undefined;
      /** A bridge's: the instance it bound with, its actor's for its life. A shell has none. */
      readonly instance?: string;
    }
  | { readonly of: "run"; readonly run: string; readonly instance: string };

/** A session: named after the launch or run whose value the connection presented. */
export interface Session {
  /** `se_` ID. */
  readonly session: string;
  /** The launch's or run's space (`sp_` ID): the session's calls go there and nowhere else. */
  readonly space: string;
  /** Its task (`t_` ID): the default of every call that names none. */
  readonly task: string;
  readonly home: SessionHome;
}

/** A bridge's binding, fixed at its bind. A shell that is no session has none. */
export type Binding =
  | { readonly kind: "session"; readonly session: Session }
  /** The bridge's own identity, in the one space its bind settled, or none for its life. */
  | { readonly kind: "none"; readonly space: string | undefined };

/** What a connection presented: a bridge its entry's words and its environment, a shell its environment. */
export type Presented =
  | {
      readonly via: "bridge";
      /** The entry's `--instance` as sent; null when it named none. */
      readonly instance: string | null;
      /** The entry's `--app` as sent; null when it named none. */
      readonly app: string | null;
      readonly env: Readonly<Record<string, string>>;
      /**
       * What an earlier bind of this bridge process answered: a space, which wins over a
       * launch's, or null for none, which it keeps for its life. Undefined: no bind answered yet.
       */
      readonly held: string | null | undefined;
    }
  | { readonly via: "shell"; readonly env: Readonly<Record<string, string>> };

/**
 * Why a connection that presented a value is none: the values name no one session, its home's
 * instance or its app is not the launch's, or its bridge holds another space than the launch's.
 */
export const UNBOUND_REASONS = ["values", "home", "app", "space"] as const;
export type UnboundReason = (typeof UNBOUND_REASONS)[number];

/** Which value named the session. */
export const BOUND_BY = ["ticket", "preset"] as const;
export type BoundBy = (typeof BOUND_BY)[number];

/**
 * Who a connection is. `failed`: a bridge's home rows could not be read, which is never an answer:
 * the bind fails so its bridge tries again. A shell reads no rows, so its decision never fails.
 */
export type Decision =
  | { readonly kind: "session"; readonly session: Session; readonly by: BoundBy }
  | { readonly kind: "none"; readonly reason?: UnboundReason }
  | { readonly kind: "failed" };

/**
 * What a session may do now: the instance its actor names, and whether a space is allowed. A
 * shell takes its home's live row's instance at each call. `failed`: the rows could not be read.
 */
export type Standing =
  | { readonly kind: "read"; readonly instance: string; may(space: string): boolean }
  | { readonly kind: "failed" };

/** The sessions as the request path asks for them (binding/port.ts answers). */
export interface SessionPort {
  /** Who a connection is, by the one rule, logged. A shell's call asks it at each call. */
  decide(presented: Presented): Decision;
  /** What a session may do now, read again at every check. */
  standing(home: SessionHome): Standing;
  /** How many live sessions each task of `space` has: running launches and running runs. */
  live(space: string): ReadonlyMap<string, number>;
}
