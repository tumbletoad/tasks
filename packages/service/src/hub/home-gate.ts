// The grant gate's answer from the grants table (ops/grant.ts, A3 3.7.4, 3.7.8): an agent home may
// use a space when the live agent-home row of its instance names it, and that row is the
// registration the connection was made under. Setup keeps one live row per registration (one
// TTasks entry in one settings file, hub/agent-homes.ts) and one registration per instance: a row
// revoked by `ttasks setup agents --remove`, or replaced by another answer, names nothing from that
// moment, so the next call of every connection of the home sees it.
//
// An instance is a name the person may give to another home once the first is off: the
// registration is what tells the two apart. A row setup made has its registration's ID, which the
// entry carries in its environment, and admits only a connection that presents that ID; a row an
// earlier build made has none, and admits only a connection that presents none, so an old entry
// never reaches the access of the home that took its name. An instance two live rows hold
// (registered before setup refused that) is refused rather than given the union of both.
//
// A3 3.7.4's hand-made entry, one without `--instance` (`agent:manual`), has no row: it acts in the
// machine's default space only, the space the request path gives an unbound call of the person
// (`service.default_space`, else the one space served). The configured default counts whether or
// not it is served now, so a call on it hears `space_unavailable` (or `ambiguous`) from the request
// path rather than a grant refusal. An entry that names an instance with no live row of its
// registration is refused, and `ttasks setup agents` is what registers the home again.
import { isLive, type GrantStore } from "../local/index.ts";
import { MANUAL_INSTANCE, type HomeGate } from "../ops/index.ts";

export interface HomeGateHost {
  /** The grants table, as it is now. */
  grants(): Pick<GrantStore, "list">;
  /** The spaces this service serves. */
  spaces(): readonly {
    readonly id: string | undefined;
    readonly registered?: string | undefined;
    readonly state: string;
  }[];
  /** machine.toml's `[service] default_space` as it is now. */
  defaultSpace(): string | undefined;
}

/** The space the hand-made entry may use: the configured default, else the one space served. */
function machineDefault(host: HomeGateHost): string | undefined {
  const configured = host.defaultSpace();
  if (configured !== undefined) return configured;
  // Copies of one space share its ID (A2 3.10.5): they are one space here, a copy not served yet
  // (unavailable) by the ID its entry names.
  const live = new Set(
    host.spaces().flatMap((s) => (s.state === "closed" ? [] : [s.id ?? s.registered])),
  );
  return live.size === 1 ? [...live][0] : undefined;
}

/** A row's registration: its ID, or undefined for a row an earlier build made. */
export const rowRegistration = (attrs: Readonly<Record<string, unknown>>): string | undefined =>
  typeof attrs["registration"] === "string" ? attrs["registration"] : undefined;

/**
 * The one live row of `instance`, when it is the registration `registration` (undefined: the
 * connection presented none). None for two rows that a home registered before setup refused it.
 */
function liveRow(host: HomeGateHost, instance: string, registration: string | undefined) {
  const now = new Date();
  const rows = host
    .grants()
    .list("agent_home")
    .filter((row) => row.attrs["instance"] === instance && isLive(row, now));
  const row = rows.length === 1 ? rows[0] : undefined;
  return row !== undefined && rowRegistration(row.attrs) === registration ? row : undefined;
}

export function homeGate(host: HomeGateHost): HomeGate & { machineDefault(): string | undefined } {
  return {
    may(instance, registration, space) {
      // The hand-made entry has no row: a row naming `manual` (setup refuses to make one) gives
      // it nothing, and nothing else of it outlives a revoke.
      if (instance === MANUAL_INSTANCE) return machineDefault(host) === space;
      return liveRow(host, instance, registration)?.spaces.includes(space) === true;
    },
    spaceOf(instance, registration) {
      if (instance === MANUAL_INSTANCE) return machineDefault(host);
      const spaces = liveRow(host, instance, registration)?.spaces ?? [];
      return spaces.length === 1 ? spaces[0] : undefined;
    },
    machineDefault: () => machineDefault(host),
  };
}
