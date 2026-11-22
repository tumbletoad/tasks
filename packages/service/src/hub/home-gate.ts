// The grant gate's answer from the grants table (ops/grant.ts, A3 3.7.4, 3.7.8): an agent home may
// use a space when the live agent-home row of its instance names it. Setup keeps one live row per
// home (hub/agent-homes.ts) and one home per instance: a row revoked by `ttasks setup agents
// --remove`, or replaced by another answer, names nothing from that moment, so the next call of
// every connection of the home sees it.
//
// The instance is all a connection shows of its home (the bind frame carries no home folder), so
// two homes registered as one instance could not be told apart: revoking one would leave its
// entry working through the other's row. `setup/home_grant` refuses an instance another home's
// live row holds; an instance two live rows hold all the same (registered before that rule) is
// refused here until setup is run again, rather than given the union of both.
//
// A3 3.7.4's hand-made entry, one without `--instance` (`agent:manual`), has no row: it acts in the
// machine's default space only, the space the request path gives an unbound call of the person
// (`service.default_space`, else the one space served). The configured default counts whether or
// not it is served now, so a call on it hears `space_unavailable` (or `ambiguous`) from the request
// path rather than a grant refusal. An entry that names an instance with no live row is refused:
// setup never wrote such an entry and kept no row, or the row was revoked or lost, and `ttasks setup
// agents` is what registers the home again.
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

export function homeGate(host: HomeGateHost): HomeGate {
  return {
    may(instance, space) {
      // The hand-made entry has no row: a row naming `manual` (setup refuses to make one) gives
      // it nothing, and nothing else of it outlives a revoke.
      if (instance === MANUAL_INSTANCE) return machineDefault(host) === space;
      const now = new Date();
      const rows = host
        .grants()
        .list("agent_home")
        .filter((row) => row.attrs["instance"] === instance && isLive(row, now));
      return rows.length === 1 && rows[0]?.spaces.includes(space) === true;
    },
  };
}
