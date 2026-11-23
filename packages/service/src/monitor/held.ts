// The agent sessions TTasks started on this machine, in every open space, as the links to tasks
// read them (links.ts): each terminal launch and background run whose agent app's session ID its
// record holds, with the agent home its instance starts the app on. A launch counts while its
// agent runs and for a day after its record last changed, so an agent the person resumes by hand
// in the same session still shows with its task.
import { copyOf, isAmbiguity } from "../ops/copies.ts";
import { readAgentSessions, type ServedSpace } from "../ops/index.ts";
import type { HeldSession } from "./links.ts";

/** How long an ended launch or run still links its session to its task. */
export const HELD_MS = 24 * 60 * 60_000;

export interface HeldSources {
  spaces(): readonly ServedSpace[];
  /** This machine's ID: only its own launches and runs count. */
  readonly machine: string;
  /** The agent app and home an instance starts, for one TTAM can list; else undefined. */
  agentOf(
    instance: string,
  ): { readonly provider: "claude" | "codex"; readonly home: string } | undefined;
  /** The terminal launches of a space whose agent runs now, as the shims say. */
  running(space: string): readonly string[];
  /** Wall clock milliseconds. */
  now(): number;
}

/**
 * Every session TTasks holds now. A space is read in the copy that opening its tasks reads
 * (copies.ts): a restored copy never links a task its original no longer has, and a space whose
 * copies could both answer links nothing. A space that cannot be read holds none this time.
 */
export async function heldSessions(sources: HeldSources): Promise<HeldSession[]> {
  const since = sources.now() - HELD_MS;
  const served = sources.spaces().filter((s) => s.id !== undefined && s.reader !== undefined);
  const chosen = [...new Set(served.map((s) => s.id))].flatMap((id) => {
    const copy = id === undefined ? undefined : copyOf(served, id);
    return copy === undefined || isAmbiguity(copy) ? [] : [copy];
  });
  const read = await Promise.all(
    chosen.map(async (served): Promise<HeldSession[]> => {
      const id = served.id;
      if (id === undefined || served.reader === undefined) return [];
      const running = sources.running(id);
      const found = await readAgentSessions(served.reader, {
        machine: sources.machine,
        since,
        running,
      }).catch(() => undefined);
      if (found === undefined) return [];
      return found.rows.flatMap((row): HeldSession[] => {
        const agent = sources.agentOf(row.instance);
        if (agent === undefined) return [];
        return [
          {
            task: {
              space: id,
              spaceName: found.space.name,
              id: row.task,
              ref: row.ref,
              started: row.started,
            },
            provider: agent.provider,
            home: agent.home,
            sessionId: row.sessionId,
            running: row.started === "terminal" && !row.ended && running.includes(row.id),
          },
        ];
      });
    }),
  );
  return read.flat();
}
