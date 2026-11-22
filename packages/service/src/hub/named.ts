// What a connection's environment names: the live terminal launch or background run its ticket
// (`TTASKS_TICKET`) or Claude Code's preset session ID (`CLAUDE_CODE_SESSION_ID`) was handed for.
// Machine state and the runs this start holds only, so no space has to be open. It finds; it does
// not decide who the connection is.
import type { LiveLaunch, ShimHost } from "@ttasks/launch";
import type { LiveRun, RunService } from "../runs/service.ts";

/** A live launch or run a value names. */
export type Live = ({ readonly of: "launch" } & LiveLaunch) | ({ readonly of: "run" } & LiveRun);

/**
 * What the two values name together. Values that name two different launches or runs name
 * neither alone: both are given, for the caller to decide.
 */
export type Named =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly by: "ticket" | "preset"; readonly live: Live }
  | { readonly kind: "two"; readonly ticket: Live; readonly preset: Live };

export interface NamedSources {
  /** The shim's host, once launching started. */
  launches(): Pick<ShimHost, "liveByTicket" | "liveByPreset"> | undefined;
  readonly runs: Pick<RunService, "liveByTicket">;
}

const sameLive = (a: Live, b: Live): boolean =>
  a.of === "launch" && b.of === "launch"
    ? a.launch === b.launch
    : a.of === "run" && b.of === "run" && a.run === b.run;

/** The live launch or run `ticket` and `preset` name: a ticket a launch's or a run's, a preset a launch's. */
export function namedBy(
  sources: NamedSources,
  values: { readonly ticket?: string; readonly preset?: string },
): Named {
  const host = sources.launches();
  let byTicket: Live | undefined;
  if (values.ticket !== undefined) {
    const launch = host?.liveByTicket(values.ticket);
    const run = launch === undefined ? sources.runs.liveByTicket(values.ticket) : undefined;
    byTicket =
      launch !== undefined
        ? { of: "launch", ...launch }
        : run === undefined
          ? undefined
          : { of: "run", ...run };
  }
  const preset = values.preset === undefined ? undefined : host?.liveByPreset(values.preset);
  const byPreset: Live | undefined = preset === undefined ? undefined : { of: "launch", ...preset };
  if (byTicket !== undefined && byPreset !== undefined && !sameLive(byTicket, byPreset)) {
    return { kind: "two", ticket: byTicket, preset: byPreset };
  }
  if (byTicket !== undefined) return { kind: "one", by: "ticket", live: byTicket };
  return byPreset === undefined ? { kind: "none" } : { kind: "one", by: "preset", live: byPreset };
}
